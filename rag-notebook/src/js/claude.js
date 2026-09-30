// Browser-side client for /api/claude.
// assembleRequest is pure and testable in Node.
// ask() requires fetch and is a skeleton until §8.4 is implemented.
// SPEC §8

// The stable system instruction. Placed first so it is always the cached
// prefix. Never include volatile content here — one varying byte invalidates
// everything downstream. SPEC §8.3
export const INSTRUCTIONS = `\
You are a research assistant answering questions about documents the user has loaded.

Rules:
1. Answer only from the retrieved context chunks provided below. Do not draw on knowledge outside them.
2. After every sentence that rests on retrieved material, place a citation immediately after it in this exact format: [[c:docId#NNNN]] where the ID matches a chunk listed in the context.
3. Only cite IDs that appear in the retrieved context below. Do not fabricate IDs.
4. If the context does not contain enough information to answer, say so clearly. Do not guess.
5. When multiple chunks support a claim, cite all of them.`;

/** Render the corpus manifest (document names and heading outlines). */
function manifestBlock(manifest) {
  if (!manifest || manifest.length === 0) return 'Corpus: (empty)';
  const lines = ['Corpus manifest (documents available):'];
  for (const doc of manifest) {
    lines.push(`  ${doc.name} (${doc.chunkCount} chunks)`);
    if (doc.headings && doc.headings.length > 0) {
      for (const h of doc.headings) lines.push(`    - ${h}`);
    }
  }
  return lines.join('\n');
}

/** Render the retrieved chunks as numbered context blocks. */
function contextBlock(chunks) {
  if (!chunks || chunks.length === 0) return 'Retrieved context: (none)';
  const parts = ['Retrieved context chunks (cite these IDs):'];
  for (const c of chunks) {
    parts.push(`\n[${c.id}]\n${c.text}`);
  }
  return parts.join('\n');
}

/** Render the user question. */
function questionBlock(question) {
  return `Question: ${question}`;
}

/**
 * Build the Claude API request body from the retrieved chunks, the corpus
 * manifest, and the user question. Pure: returns a plain object, no I/O.
 *
 * Prompt caching render order: stable prefix first, volatile last. SPEC §8.3
 *   system[0] INSTRUCTIONS  — never changes within a build
 *   system[1] manifest      — changes when documents are added/removed; cache_control here
 *   messages[0].content[0] context chunks — changes every question
 *   messages[0].content[1] question       — changes every question
 *
 * SPEC §8.1
 */
export function assembleRequest({ question, chunks, manifest }) {
  return {
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    stream: true,
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: 'medium' },
    system: [
      { type: 'text', text: INSTRUCTIONS },
      { type: 'text', text: manifestBlock(manifest), cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: contextBlock(chunks) },
          { type: 'text', text: questionBlock(question) },
        ],
      },
    ],
  };
}

/**
 * Typed error class for proxy responses.
 * `code` matches the JSON `error` field from the proxy (SPEC §8.6).
 */
export class ClaudeError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'ClaudeError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Parse accumulated SSE text into complete frames. An SSE frame is a sequence
 * of `field: value` lines followed by a blank line. We only read `event:` and
 * `data:` fields; everything else is ignored.
 *
 * Returns { frames: [{type, data}], remainder } where remainder is the
 * unconsumed tail (a partial frame). Pure; testable in Node. SPEC §8.4
 *
 * @param {string} buffer
 * @returns {{ frames: Array<{type:string, data:string}>, remainder: string }}
 */
export function parseSseBuffer(buffer) {
  const frames = [];
  // Split on blank lines (the frame delimiter). Keep the last part as remainder.
  const parts = buffer.split('\n\n');
  const remainder = parts.pop() ?? '';

  for (const part of parts) {
    const lines = part.split('\n');
    let type = 'message';
    let data = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        type = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        data = line.slice(6);
      }
    }
    if (data) frames.push({ type, data });
  }

  return { frames, remainder };
}

/**
 * Map a proxy error JSON body to a ClaudeError. Pure. SPEC §8.6
 *
 * @param {number} status  — HTTP status code
 * @param {object} body    — parsed JSON body from the proxy
 * @returns {ClaudeError}
 */
export function mapProxyError(status, body) {
  const code = body?.error ?? 'api_error';
  const message = body?.message ?? `HTTP ${status}`;
  switch (code) {
    case 'no_api_key': return new ClaudeError('no_api_key', message, body);
    case 'no_sdk':     return new ClaudeError('no_sdk', message, body);
    case 'bad_key':    return new ClaudeError('bad_key', message, body);
    case 'rate_limited': return new ClaudeError('rate_limited', message, body?.retryAfter);
    case 'bad_request':  return new ClaudeError('bad_request', message, body);
    default:             return new ClaudeError(code, message, body);
  }
}

/**
 * POST to /api/claude, stream the SSE response, dispatch callbacks.
 * Returns the final usage object when done.
 *
 * Handles:
 * - content_block_delta with text_delta   → onText(delta)
 * - content_block_delta with thinking_delta → onThinking(delta)
 * - message_stop event → carries stop_reason and usage
 * - AbortSignal wired to the stop button and page unload (SPEC §8.4)
 *
 * @param {{ question: string, chunks: object[], manifest: object[],
 *           signal?: AbortSignal, onText?: fn, onThinking?: fn,
 *           fetchFn?: fn }} opts
 * SPEC §8.4
 */
export async function ask({
  question, chunks, manifest, signal,
  onText, onThinking,
  fetchFn = globalThis.fetch,
} = {}) {
  const body = assembleRequest({ question, chunks, manifest });

  let res;
  try {
    res = await fetchFn('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ClaudeError('network_error', err?.message ?? 'Network request failed', err);
  }

  if (!res.ok) {
    let errBody;
    try { errBody = await res.json(); } catch { errBody = {}; }
    throw mapProxyError(res.status, errBody);
  }

  // Stream the SSE response. Buffer partial frames across chunks. SPEC §8.4
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = null;
  let stopReason = null;

  while (true) {
    let done, value;
    try {
      ({ done, value } = await reader.read());
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      // Network lost mid-stream — return what arrived. SPEC §13
      break;
    }
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const { frames, remainder } = parseSseBuffer(buffer);
    buffer = remainder;

    for (const { type, data } of frames) {
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }

      if (type === 'content_block_delta') {
        if (parsed.delta?.type === 'text_delta') {
          onText?.(parsed.delta.text ?? '');
        } else if (parsed.delta?.type === 'thinking_delta') {
          onThinking?.(parsed.delta.thinking ?? '');
        }
      } else if (type === 'message_delta') {
        if (parsed.usage) usage = { ...usage, ...parsed.usage };
        if (parsed.delta?.stop_reason) stopReason = parsed.delta.stop_reason;
      } else if (type === 'message_stop') {
        // Final event; usage was accumulated from message_delta
      }
    }
  }

  return { usage, stopReason };
}

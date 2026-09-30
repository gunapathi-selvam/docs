// Static server + /api/claude proxy.
//
// The API key lives here and nowhere else. The browser never contacts
// api.anthropic.com and never sees the key. SPEC §11.1
//
// Binds 127.0.0.1 by default, not 0.0.0.0. A dev server holding a paid API
// key must not be on the LAN by accident. SPEC §11.6
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// @anthropic-ai/sdk is a server-only import. It must never be imported anywhere
// in the browser module graph.
//
// Guarded because transcribe-only mode is a supported way to run this project:
// a static import here would make the whole server fail to boot before
// `npm install`, taking local transcription down with it even though
// transcription needs neither the SDK nor a key. /api/claude returns 503 when
// the SDK is absent, which is the same path as a missing key. SPEC §11.1
let Anthropic;
try {
  ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
} catch {
  Anthropic = null;
}

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 5176;
const HOST = process.env.HOST || '127.0.0.1';

const API_KEY_SET = !!process.env.ANTHROPIC_API_KEY && !!Anthropic;

// Two independent reasons summarisation can be unavailable, and they need
// different remedies: install the dependency, or set the key. Reporting one as
// the other sends the user to fix the wrong thing.
function unavailableReason() {
  if (!Anthropic) return '@anthropic-ai/sdk is not installed in the server environment — run npm install';
  if (!process.env.ANTHROPIC_API_KEY) return 'ANTHROPIC_API_KEY is not set in the server environment';
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

// ---------------------------------------------------------------- path guard
// Resolve and normalise, then refuse anything that escapes the project root.
// A proxy in the tree makes directory traversal more interesting, not less,
// because there is now a .env file to find. SPEC §11.6
function resolveSafe(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const target = normalize(join(ROOT, clean === '/' ? 'index.html' : clean));
  if (!target.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep) && target !== ROOT) return null;
  return target;
}

// ---------------------------------------------------------------- token bucket
// Per-IP rate limiter: 6 requests/minute, 20 requests/hour. In-process,
// in-memory, reset on restart. SPEC §11.5
const buckets = new Map();

function rateLimitCheck(ip) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) {
    b = { minTokens: 6, hourTokens: 20, minRefill: now, hourRefill: now };
    buckets.set(ip, b);
  }
  const minElapsed = (now - b.minRefill) / 60000;
  const hourElapsed = (now - b.hourRefill) / 3600000;
  b.minTokens = Math.min(6, b.minTokens + minElapsed * 6);
  b.hourTokens = Math.min(20, b.hourTokens + hourElapsed * 20);
  b.minRefill = now;
  b.hourRefill = now;
  if (b.minTokens < 1 || b.hourTokens < 1) {
    const retryAfter = b.minTokens < 1 ? Math.ceil((1 - b.minTokens) / 6 * 60) : Math.ceil((1 - b.hourTokens) / 20 * 3600);
    return retryAfter;
  }
  b.minTokens -= 1;
  b.hourTokens -= 1;
  return 0;
}

// ---------------------------------------------------------------- constants
// These match SPEC §10 exactly. The browser sends none of them.
const MODEL = 'claude-opus-5-5';
const MAX_TOKENS = 8000;
const MAP_CHUNK_TOKENS = 8000;
const REDUCE_THRESHOLD_TOKENS = 12000;
const MAX_CHUNKS = 24;
const BODY_LIMIT = 1024 * 1024; // 1 MiB

const ALLOWED_MODES = new Set(['single', 'map', 'reduce']);
const ALLOWED_LENGTHS = new Set(['brief', 'standard', 'detailed']);
const ALLOWED_KEYS = new Set(['mode', 'length', 'transcript', 'summaries']);

// SPEC §9 — the fixed summary shape.
const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'key_points', 'action_items', 'open_questions'],
  properties: {
    title: { type: 'string', maxLength: 80 },
    key_points: {
      type: 'array',
      minItems: 3,
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 't'],
        properties: {
          text: { type: 'string' },
          t: { type: 'number', minimum: 0 },
        },
      },
    },
    action_items: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 't'],
        properties: {
          text: { type: 'string' },
          t: { type: 'number', minimum: 0 },
          owner: { type: 'string' },
        },
      },
    },
    open_questions: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 't'],
        properties: {
          text: { type: 'string' },
          t: { type: 'number', minimum: 0 },
        },
      },
    },
  },
};

// ---------------------------------------------------------------- validation helpers

function validateTranscript(transcript, startIndex = 0) {
  if (!Array.isArray(transcript)) return 'transcript must be an array';
  if (transcript.length > 20000) return 'transcript exceeds 20000 entries';
  let totalChars = 0;
  for (let i = 0; i < transcript.length; i++) {
    const seg = transcript[i];
    if (typeof seg !== 'object' || seg === null) return `transcript[${startIndex + i}] is not an object`;
    if (typeof seg.t !== 'number' || !isFinite(seg.t) || seg.t < 0) return `transcript[${startIndex + i}].t must be a finite non-negative number`;
    if (typeof seg.text !== 'string') return `transcript[${startIndex + i}].text must be a string`;
    if (seg.text.length > 4000) return `transcript[${startIndex + i}].text exceeds 4000 chars`;
    // SPEC §11.4 guard 8: reject base64 audio data-URLs
    if (/^data:[^;]*;base64,/.test(seg.text)) return `transcript[${startIndex + i}].text looks like a binary data-URL`;
    totalChars += seg.text.length;
  }
  if (totalChars > 1000000) return 'total transcript text exceeds 1 000 000 chars';
  return null;
}

// Snap each t to the nearest transcript segment start within ±2 s.
// Returns the validated summary with anchored fields. SPEC §10.5
function validateAndAnchorSummary(summary, transcript) {
  if (!summary || typeof summary !== 'object') return summary;
  const segments = Array.isArray(transcript) ? transcript : [];

  function anchorT(t) {
    if (typeof t !== 'number' || !isFinite(t)) return { t, anchored: false };
    const duration = segments.length > 0 ? segments[segments.length - 1].t + 30 : Infinity;
    if (t < 0 || t > duration) return { t, anchored: false };
    let best = null, bestDist = Infinity;
    for (const seg of segments) {
      const dist = Math.abs(seg.t - t);
      if (dist < bestDist) { bestDist = dist; best = seg.t; }
    }
    if (best !== null && bestDist <= 2.0) return { t: best, anchored: true };
    return { t, anchored: false };
  }

  function anchorItems(items) {
    if (!Array.isArray(items)) return items;
    return items.map((item) => {
      const { t, anchored } = anchorT(item.t);
      return anchored ? { ...item, t } : { ...item, t, anchored: false };
    });
  }

  return {
    ...summary,
    key_points:     anchorItems(summary.key_points),
    action_items:   anchorItems(summary.action_items),
    open_questions: anchorItems(summary.open_questions),
  };
}

// ---------------------------------------------------------------- system prompt

function buildSystemPrompt(length) {
  const lengthNote = {
    brief:    'Respond concisely. key_points: 3–5 items, action_items and open_questions: only the most critical.',
    standard: 'Respond at a standard level of detail. key_points: 5–8 items.',
    detailed: 'Be thorough. key_points: up to 12 items, capture nuance and context.',
  }[length] || '';
  return `You are a note-taking assistant. You receive a timestamped transcript and produce a structured summary. Each item must carry a "t" value (seconds into the recording) identifying the supporting segment.

${lengthNote}

Return only the JSON object matching the schema. Do not include any prose outside the JSON.`;
}

function buildUserMessage(transcript, length) {
  const transcriptText = transcript.map((s) => `[${s.t.toFixed(1)}s] ${s.text}`).join('\n');
  // Prompt caching: transcript block first (stable), instruction last (varies). SPEC §10.6
  const blocks = [
    { type: 'text', text: transcriptText },
  ];
  // Only set cache_control when the transcript exceeds the minimum cacheable prefix. SPEC §10.6
  if (transcriptText.length / 3.5 >= 2048) {
    blocks[0].cache_control = { type: 'ephemeral' };
  }
  blocks.push({ type: 'text', text: `Summarise the above transcript at ${length} length.` });
  return blocks;
}

// ---------------------------------------------------------------- proxy handler

async function handleProxy(req, res, ip) {
  // Guard 1: method
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'method_not_allowed', message: 'Use POST.' }));
  }

  // Guard 2: Content-Type — structurally forbids multipart and audio/*. SPEC §3.4
  if ((req.headers['content-type'] || '').split(';')[0].trim() !== 'application/json') {
    res.writeHead(415, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'unsupported_media_type', message: 'Content-Type must be application/json.' }));
  }

  // Guard 9: Origin check
  const origin = req.headers['origin'];
  if (origin) {
    const allowed = ['http://localhost:5176', 'http://127.0.0.1:5176'];
    if (!allowed.includes(origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'forbidden_origin', message: 'Origin not permitted.' }));
    }
  }

  // Guard 10: rate limit
  const retryAfter = rateLimitCheck(ip);
  if (retryAfter > 0) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) });
    return res.end(JSON.stringify({ error: 'rate_limited', message: `Try again in ${retryAfter} seconds.` }));
  }

  // Guard 3: body size — counted as bytes arrive, socket destroyed past cap. SPEC §11.4
  let body = '';
  let bodyBytes = 0;
  let tooLarge = false;
  await new Promise((resolve, reject) => {
    req.on('data', (chunk) => {
      bodyBytes += chunk.length;
      if (bodyBytes > BODY_LIMIT) {
        tooLarge = true;
        req.socket.destroy();
        resolve();
        return;
      }
      body += chunk.toString('utf8');
    });
    req.on('end', resolve);
    req.on('error', reject);
  });

  if (tooLarge) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'payload_too_large', message: 'Request body exceeds 1 MiB.' }));
  }

  // Guard 4: JSON parse
  let parsed;
  try { parsed = JSON.parse(body); }
  catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'invalid_json', message: 'Body is not valid JSON.' }));
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'invalid_json', message: 'Body must be a JSON object.' }));
  }

  // Guard 5: allowlist — rejects rather than strips. SPEC §11.4
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_KEYS.has(key)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unknown_field', message: `Unknown field: ${key}` }));
    }
  }

  // Guard 6: enum validation
  const { mode, length, transcript, summaries } = parsed;
  if (!ALLOWED_MODES.has(mode)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'invalid_mode', message: `mode must be one of: ${[...ALLOWED_MODES].join(', ')}` }));
  }
  if (!ALLOWED_LENGTHS.has(length)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'invalid_length', message: `length must be one of: ${[...ALLOWED_LENGTHS].join(', ')}` }));
  }

  // Guard 7: transcript validation
  if (mode === 'single' || mode === 'map') {
    const err = validateTranscript(transcript);
    if (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'invalid_transcript', message: err }));
    }
  }

  // Guard 11: chunk-and-reduce threshold for single mode. SPEC §11.4, §12.1
  if (mode === 'single') {
    const totalChars = transcript.reduce((n, s) => n + s.text.length, 0);
    const estimatedTokens = totalChars / 3.5;
    if (estimatedTokens > REDUCE_THRESHOLD_TOKENS) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'transcript_too_long', suggest: 'map_reduce', estimatedTokens: Math.round(estimatedTokens) }));
    }
  }

  // Transcribe-only mode: key not set. SPEC §13.1
  if (!API_KEY_SET) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ available: false, reason: unavailableReason() }));
  }

  // Build the Anthropic request. The SDK client is constructed with no arguments
  // so the key is never in a variable that could be logged. SPEC §11.1
  const anthropic = new Anthropic();

  const systemPrompt = buildSystemPrompt(length);

  let messages;
  if (mode === 'reduce') {
    const summariesText = JSON.stringify(summaries, null, 2);
    messages = [{ role: 'user', content: [
      { type: 'text', text: summariesText },
      { type: 'text', text: `Merge the above chunk summaries into a single summary at ${length} length. When merging duplicates, keep the earliest t.` },
    ]}];
  } else {
    messages = [{ role: 'user', content: buildUserMessage(transcript, length) }];
  }

  // Map chunking: log how many map calls will be needed if this is 'map' mode.
  // Actual chunking is performed by the browser before calling. SPEC §12.2

  let responseBody;
  try {
    // SPEC §10.2: adaptive thinking, no budget_tokens, no disabled thinking.
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: SUMMARY_SCHEMA },
      },
      system: systemPrompt,
      messages,
    });

    // SPEC §10.7: check stop_reason before touching content.
    if (response.stop_reason === 'refusal') {
      // stop_details is only populated for 'refusal'. SPEC §10.7
      const category = response.stop_details?.category ?? 'unspecified';
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'refused', message: `Request refused by the model (category: ${category}).` }));
    }
    if (response.stop_reason === 'max_tokens') {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'truncated', message: 'The summary exceeded the output budget.' }));
    }

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'no_text', message: 'The model returned no text content.' }));
    }

    let summary;
    try { summary = JSON.parse(textBlock.text); }
    catch {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'invalid_json_response', message: 'Model output was not valid JSON.' }));
    }

    // Validate and anchor timestamps server-side. SPEC §10.5
    const anchored = validateAndAnchorSummary(summary, mode !== 'reduce' ? transcript : []);

    // Log cache usage so a zero is visible rather than assumed. SPEC §10.6
    const usage = response.usage || {};
    console.log(`[proxy] mode=${mode} length=${length} in=${usage.input_tokens} out=${usage.output_tokens} cache_read=${usage.cache_read_input_tokens ?? 0}`);

    responseBody = JSON.stringify({ summary: anchored });
  } catch (err) {
    // SPEC §10.8: typed errors, most specific first.
    if (err instanceof Anthropic.BadRequestError) {
      // 400 is our bug, not the user's. Log the shape, never the content.
      console.error(`[proxy] BadRequestError: ${err.message}`);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'bad_request', message: 'The request was rejected by the API. This is a server-side bug.' }));
    } else if (err instanceof Anthropic.AuthenticationError) {
      // 401: key is present and wrong, not missing. SPEC §10.8
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'auth_failed', message: 'The configured API key was rejected. Check the key value in .env.' }));
    } else if (err instanceof Anthropic.RateLimitError) {
      const retryAfterHeader = err.headers?.['retry-after'] ?? '60';
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': retryAfterHeader });
      return res.end(JSON.stringify({ error: 'upstream_rate_limited', message: `Upstream rate limit. Retry after ${retryAfterHeader} seconds.` }));
    } else if (err instanceof Anthropic.APIError) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'upstream_error', message: `Upstream API error (status ${err.status}).` }));
    } else {
      throw err;
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(responseBody);
}

// ---------------------------------------------------------------- HTTP server

const server = createServer(async (req, res) => {
  const url = req.url || '/';
  const ip = req.socket.remoteAddress || 'unknown';
  console.log(`${req.method} ${url}`);

  // GET /api/claude/status — SPEC §11.7
  if (url === '/api/claude/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(
      API_KEY_SET
        ? { available: true }
        : { available: false, reason: unavailableReason() }
    ));
  }

  // POST /api/claude
  if (url.startsWith('/api/claude') && req.method !== 'GET') {
    try {
      await handleProxy(req, res, ip);
    } catch (err) {
      console.error('[proxy] unhandled error:', err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal', message: 'Internal server error.' }));
      }
    }
    return;
  }

  // Static files
  const file = resolveSafe(url);
  if (!file) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden');
    return;
  }
  try {
    const info = await stat(file);
    const path = info.isDirectory() ? join(file, 'index.html') : file;
    const body = await readFile(path);
    res.writeHead(200, {
      'Content-Type': MIME[extname(path).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
  }
});

server.listen(PORT, HOST, () => {
  const modeNote = API_KEY_SET ? 'Claude summarisation enabled' : `transcribe-only mode — ${unavailableReason()}`;
  console.log(`\n  Voice Notes running at  http://${HOST}:${PORT}`);
  console.log(`  Bound to: ${HOST}  (${modeNote})\n`);
});

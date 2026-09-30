// Browser client for POST /api/claude.
//
// This module builds a request body from the transcript array and calls our
// own origin. It never contacts api.anthropic.com. It has no reference to the
// recorder module and no way to include audio data. SPEC §3.4, §11.2
//
// The @anthropic-ai/sdk is NOT imported here. It lives only in server.js.
//
// Structured outputs are requested via output_config on the server side; this
// module simply sends { mode, length, transcript } and receives { summary }.
// There is no assistant prefill — that returns 400 on claude-opus-5-5. SPEC §10.3

export const REDUCE_THRESHOLD_TOKENS = 12000; // SPEC §12.1
export const MAP_CHUNK_TOKENS        = 8000;  // SPEC §12.2

/**
 * The JSON schema for a valid summary object. Used for client-side validation
 * of the response and in the unit tests. SPEC §9
 */
export const SUMMARY_SCHEMA = {
  type: 'object',
  required: ['title', 'key_points', 'action_items', 'open_questions'],
  additionalProperties: false,
  properties: {
    title: { type: 'string', maxLength: 80 },
    key_points: {
      type: 'array',
      minItems: 3,
      maxItems: 12,
      items: {
        type: 'object',
        required: ['text', 't'],
        additionalProperties: false,
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
        required: ['text', 't'],
        additionalProperties: false,
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
        required: ['text', 't'],
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          t: { type: 'number', minimum: 0 },
        },
      },
    },
  },
};

/**
 * Validate a summary object against SUMMARY_SCHEMA.
 * Returns null if valid, or a string describing the first violation.
 */
export function validateSummary(obj) {
  if (!obj || typeof obj !== 'object') return 'summary must be an object';
  if (typeof obj.title !== 'string') return 'title must be a string';
  if (obj.title.length > 80) return 'title exceeds 80 characters';

  function checkItems(field, minItems, maxItems) {
    const arr = obj[field];
    if (!Array.isArray(arr)) return `${field} must be an array`;
    if (minItems !== undefined && arr.length < minItems) return `${field} must have at least ${minItems} items`;
    if (arr.length > maxItems) return `${field} must have at most ${maxItems} items`;
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      if (!item || typeof item !== 'object') return `${field}[${i}] must be an object`;
      if (typeof item.text !== 'string') return `${field}[${i}].text must be a string`;
      if (typeof item.t !== 'number' || item.t < 0) return `${field}[${i}].t must be a non-negative number`;
      const extraKeys = Object.keys(item).filter((k) => !['text', 't', 'owner', 'anchored'].includes(k));
      if (extraKeys.length > 0) return `${field}[${i}] has unexpected keys: ${extraKeys.join(', ')}`;
    }
    return null;
  }

  const extraKeys = Object.keys(obj).filter((k) => !['title', 'key_points', 'action_items', 'open_questions'].includes(k));
  if (extraKeys.length > 0) return `summary has unexpected keys: ${extraKeys.join(', ')}`;

  return checkItems('key_points', 3, 12)
      || checkItems('action_items', 0, 20)
      || checkItems('open_questions', 0, 10)
      || null;
}

/**
 * Estimate token count for a transcript array. SPEC §12.1
 */
export function estimateTokens(transcript) {
  const chars = transcript.reduce((n, s) => n + (s.text ? s.text.length : 0), 0);
  return Math.ceil(chars / 3.5);
}

/**
 * Determine whether chunk-and-reduce is needed and split accordingly. SPEC §12.2
 *
 * Returns { mode: 'single', chunks: [transcript] } or
 *         { mode: 'map_reduce', chunks: [ [segments...], ... ] }
 */
export function planRequest(transcript) {
  const tokens = estimateTokens(transcript);

  if (tokens <= REDUCE_THRESHOLD_TOKENS) {
    return { mode: 'single', chunks: [transcript] };
  }

  // Split at segment boundaries so no chunk exceeds MAP_CHUNK_TOKENS.
  const chunks = [];
  let current = [];
  let currentTokens = 0;

  for (const seg of transcript) {
    const segTokens = Math.ceil((seg.text ? seg.text.length : 0) / 3.5);
    if (current.length > 0 && currentTokens + segTokens > MAP_CHUNK_TOKENS) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(seg);
    currentTokens += segTokens;
  }
  if (current.length > 0) {
    chunks.push(current);
  }

  return { mode: 'map_reduce', chunks };
}

/**
 * Send a summarisation request to /api/claude.
 * Handles single-call and chunk-and-reduce paths.
 *
 * transcript: [ { t: number, text: string } ]
 * length: 'brief' | 'standard' | 'detailed'
 * fetchFn: injected in tests so no real network call is made
 *
 * Returns the validated summary object or throws.
 */
export async function summarise(transcript, length = 'standard', fetchFn = fetch) {
  const { mode, chunks } = planRequest(transcript);

  async function postRequest(body) {
    // Body is plain JSON — no audio, no binary. SPEC §3.4
    const resp = await fetchFn('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    let data;
    try {
      data = await resp.json();
    } catch {
      throw new Error(`Server returned non-JSON (status ${resp.status})`);
    }

    if (!resp.ok) {
      throw new Error(data?.message || `Server error (${resp.status})`);
    }

    const err = validateSummary(data.summary);
    if (err) {
      throw new Error(`Invalid summary from server: ${err}`);
    }

    return data.summary;
  }

  if (mode === 'single') {
    return postRequest({ mode: 'single', length, transcript });
  }

  // Map phase — one request per chunk
  const chunkSummaries = await Promise.all(
    chunks.map((chunk) => postRequest({ mode: 'map', length, transcript: chunk })),
  );

  // Reduce phase — merge chunk summaries
  return postRequest({ mode: 'reduce', length, summaries: chunkSummaries });
}

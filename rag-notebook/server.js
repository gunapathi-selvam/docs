// Static file server + POST /api/claude proxy.
//
// THE API KEY NEVER REACHES THE BROWSER.
// process.env.ANTHROPIC_API_KEY is read server-side only. The browser calls
// /api/claude on its own origin; this handler owns the key and the outbound
// request to api.anthropic.com. SPEC §3.1
//
// The proxy constructs the outbound request from a fixed allowlist of seven
// fields rather than forwarding the client body. SPEC §3.3
//
// The SDK is imported lazily so a missing node_modules does not prevent
// the static server from starting. SPEC §3.2

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 5173;

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

// ----------------------------------------------------------------- rate limit
// Token bucket per IP: 10 requests/minute, burst 3. In-process and in-memory;
// resets on restart. SPEC §3.4
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 10;
const RATE_BURST = 3;
const rateBuckets = new Map(); // ip -> { tokens, last }

function checkRateLimit(ip) {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket) {
    bucket = { tokens: RATE_BURST, last: now };
    rateBuckets.set(ip, bucket);
  }
  const elapsed = now - bucket.last;
  const refill = Math.floor((elapsed / RATE_WINDOW_MS) * RATE_LIMIT);
  bucket.tokens = Math.min(RATE_LIMIT, bucket.tokens + refill);
  bucket.last = now;

  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

// ------------------------------------------------------- path-traversal guard
// Borrowed from webgpu-particles/server.js. Refuse anything that escapes root.
function resolveSafe(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const target = normalize(join(ROOT, clean === '/' ? 'index.html' : clean));
  if (!target.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep) && target !== ROOT) return null;
  return target;
}

// --------------------------------------------------------- field allowlist
// The seven fields the proxy accepts. Any other key is a 400 that names the
// offending key. Silently dropping unknown fields is worse: a client that
// starts sending temperature would appear to work. SPEC §3.3

const ALLOWED_FIELDS = new Set([
  'model', 'max_tokens', 'system', 'messages', 'stream', 'thinking', 'output_config',
]);

// Fields that are often tried but explicitly rejected with a clear message.
const EXPLICITLY_REJECTED = new Set(['temperature', 'top_p', 'top_k', 'metadata']);

function validateAndBuild(raw) {
  // Unknown field check first: name the offender, do not silently drop.
  for (const key of Object.keys(raw)) {
    if (EXPLICITLY_REJECTED.has(key)) {
      return { error: 400, message: `${key} is not accepted by this model. Remove it.` };
    }
    if (!ALLOWED_FIELDS.has(key)) {
      return { error: 400, message: `Unknown field: ${key}` };
    }
  }

  // model: must be exactly 'claude-opus-5-5'
  if (raw.model !== 'claude-opus-5-5') {
    return { error: 400, message: 'model must be "claude-opus-5-5". The model is a server decision.' };
  }

  // max_tokens: integer, clamped to range per streaming mode
  const streaming = raw.stream === true;
  const maxCap = streaming ? 64000 : 16000;
  const maxTokens = typeof raw.max_tokens === 'number'
    ? Math.min(Math.max(1, Math.floor(raw.max_tokens)), maxCap)
    : 16000;

  // thinking: absent or { type: 'adaptive', display?: 'summarized'|'omitted' }
  if (raw.thinking !== undefined) {
    if (typeof raw.thinking !== 'object' || raw.thinking === null) {
      return { error: 400, message: 'thinking must be an object' };
    }
    if (raw.thinking.type !== 'adaptive') {
      return { error: 400, message: 'thinking.type must be "adaptive". {type:"disabled"} and budget_tokens are not accepted by this model.' };
    }
    if ('budget_tokens' in raw.thinking) {
      return { error: 400, message: 'thinking.budget_tokens is not accepted. Use {type:"adaptive"} only.' };
    }
    const validDisplay = new Set(['summarized', 'omitted', undefined]);
    if (!validDisplay.has(raw.thinking.display)) {
      return { error: 400, message: 'thinking.display must be "summarized" or "omitted"' };
    }
  }

  // output_config: { effort?, format? } only
  if (raw.output_config !== undefined) {
    if (typeof raw.output_config !== 'object' || raw.output_config === null) {
      return { error: 400, message: 'output_config must be an object' };
    }
    const validEffort = new Set(['low', 'medium', 'high', 'xhigh', 'max', undefined]);
    if (!validEffort.has(raw.output_config.effort)) {
      return { error: 400, message: 'output_config.effort must be one of: low, medium, high, xhigh, max' };
    }
    const oc_keys = Object.keys(raw.output_config);
    for (const k of oc_keys) {
      if (k !== 'effort' && k !== 'format') {
        return { error: 400, message: `output_config.${k} is not accepted` };
      }
    }
  }

  // messages: no trailing assistant turn
  if (Array.isArray(raw.messages) && raw.messages.length > 0) {
    const last = raw.messages[raw.messages.length - 1];
    if (last.role === 'assistant') {
      return { error: 400, message: 'A trailing assistant message is not accepted on this model. Use a system instruction or structured outputs (output_config.format) instead.' };
    }
  }

  // system: validate cache_control if present
  if (Array.isArray(raw.system)) {
    for (const block of raw.system) {
      if (block.cache_control !== undefined) {
        if (!block.cache_control || block.cache_control.type !== 'ephemeral') {
          return { error: 400, message: 'cache_control.type must be "ephemeral"' };
        }
      }
    }
  }

  // Build the outbound body from validated values only.
  const outbound = {
    model: 'claude-opus-5-5',
    max_tokens: maxTokens,
    messages: raw.messages,
  };
  if (raw.system !== undefined) outbound.system = raw.system;
  if (raw.stream !== undefined) outbound.stream = raw.stream;
  if (raw.thinking !== undefined) outbound.thinking = raw.thinking;
  if (raw.output_config !== undefined) outbound.output_config = raw.output_config;

  return { outbound };
}

// ------------------------------------------------------- /api/claude handler
async function handleProxy(req, res) {
  // Origin guard: block cross-origin requests
  const origin = req.headers['origin'];
  if (origin) {
    const host = req.headers['host'];
    try {
      if (new URL(origin).host !== host) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden', message: 'Cross-origin request rejected.' }));
        return;
      }
    } catch {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden', message: 'Invalid Origin header.' }));
      return;
    }
  }

  // Content-Length guard: 256 KB maximum before reading body. SPEC §3.4
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  if (contentLength > 256 * 1024) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'too_large', message: 'Request body must be under 256 KB.' }));
    return;
  }

  // Rate limit. SPEC §3.4
  const ip = req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
    res.end(JSON.stringify({ error: 'rate_limited', message: 'Too many requests. Try again in 60 seconds.' }));
    return;
  }

  // Key check: 503 before reading the body so a missing key is immediately visible.
  if (!process.env.ANTHROPIC_API_KEY) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'no_api_key',
      message: 'ANTHROPIC_API_KEY is not set on the server.',
      hint: 'cp .env.example .env, add your key, then: ANTHROPIC_API_KEY=... node server.js',
    }));
    return;
  }

  // Read body
  let rawBody = '';
  for await (const chunk of req) rawBody += chunk;

  // Total messages text guard. SPEC §3.4
  if (rawBody.length > 200_000) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'too_large', message: 'Messages text exceeds 200 000 characters.' }));
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad_request', message: 'Request body must be valid JSON.' }));
    return;
  }

  // Probe request (used by the app at boot to check for the key)
  if (typeof parsed === 'object' && parsed !== null && '_probe' in parsed && Object.keys(parsed).length === 1) {
    // Key is present (we checked above). Return 200 so the app knows.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  const validation = validateAndBuild(parsed);
  if (validation.error) {
    res.writeHead(validation.error, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad_request', message: validation.message }));
    return;
  }

  // Lazy SDK import: missing node_modules degrades to 503 with installation
  // instructions rather than preventing the static server from starting. SPEC §3.2
  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'no_sdk',
      message: 'The Anthropic SDK is not installed.',
      hint: 'Run: npm install',
    }));
    return;
  }

  const client = new Anthropic();
  const outbound = validation.outbound;

  try {
    if (outbound.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const stream = client.messages.stream(outbound);

      // Cancel the upstream request if the browser disconnects. SPEC §8.4
      res.on('close', () => stream.abort());

      for await (const event of stream) {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }

      const final = await stream.finalMessage();
      // Log cache stats without logging the prompt body. SPEC §3.6
      const cacheRead = final.usage?.cache_read_input_tokens ?? 0;
      console.log(`POST /api/claude  stop=${final.stop_reason}  cache_read=${cacheRead}`);

      res.end();
    } else {
      const msg = await client.messages.create(outbound);
      const cacheRead = msg.usage?.cache_read_input_tokens ?? 0;
      console.log(`POST /api/claude  stop=${msg.stop_reason}  cache_read=${cacheRead}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(msg));
    }
  } catch (err) {
    // Map SDK typed errors to stable JSON codes. Most-specific first. SPEC §8.6
    if (err?.constructor?.name === 'BadRequestError' || err?.status === 400) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad_request', message: err.message }));
    } else if (err?.constructor?.name === 'AuthenticationError' || err?.status === 401) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad_key', message: "The server's API key was rejected." }));
    } else if (err?.constructor?.name === 'RateLimitError' || err?.status === 429) {
      const retryAfter = err.headers?.['retry-after'] ?? '60';
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': retryAfter });
      res.end(JSON.stringify({ error: 'rate_limited', message: err.message, retryAfter }));
    } else {
      const status = err?.status ?? 502;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'api_error', message: err.message, status }));
    }
  }
}

// ------------------------------------------------------------------ main
const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/claude') {
    await handleProxy(req, res).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'server_error', message: 'Internal server error.' }));
      }
    });
    return;
  }

  // Static file serving
  const file = resolveSafe(req.url || '/');
  if (!file) {
    res.writeHead(403).end('Forbidden');
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

server.listen(PORT, () => {
  const keyStatus = process.env.ANTHROPIC_API_KEY ? 'key present' : 'NO KEY — retrieval-only mode';
  console.log(`\n  RAG Notebook running at  http://localhost:${PORT}  (${keyStatus})\n`);
});

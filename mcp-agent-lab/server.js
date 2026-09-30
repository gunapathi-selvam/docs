// Static server + /api/claude proxy + /api/mcp stdio bridge.
// ANTHROPIC_API_KEY is read here from process.env and never leaves this file.
// The @anthropic-ai/sdk import is the only one in the project. SPEC §2.2, §4.1
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// SDK import must stay in this file only. Tests never import server.js.
let Anthropic;
try {
  ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
} catch {
  // SDK not installed; /api/claude will return 503.
  Anthropic = null;
}

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';
const MODEL = process.env.MODEL || 'claude-opus-5-5';
const API_KEY = process.env.ANTHROPIC_API_KEY;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
};

const MAX_BODY = 1024 * 1024; // 1 MiB

// ---------------------------------------------------------------- path guard

function resolveSafe(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const target = normalize(join(ROOT, clean === '/' ? 'index.html' : clean));
  if (!target.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep) && target !== ROOT) return null;
  return target;
}

// ---------------------------------------------------------------- body reader

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- CORS / origin guard

function isAllowedOrigin(origin) {
  if (!origin) return true; // no Origin header (direct curl, same-origin HTML form)
  const allowed = `http://${HOST}:${PORT}`;
  return origin === allowed || origin === `http://localhost:${PORT}`;
}

// ---------------------------------------------------------------- /api/claude allowlist

const ALLOWED_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const KNOWN_TOOL_NAMES_CACHE = { list: null };

async function getKnownToolNames() {
  if (KNOWN_TOOL_NAMES_CACHE.list) return KNOWN_TOOL_NAMES_CACHE.list;
  const { TOOLS } = await import('./mcp/tools.mjs');
  KNOWN_TOOL_NAMES_CACHE.list = new Set(TOOLS.map((t) => t.name));
  return KNOWN_TOOL_NAMES_CACHE.list;
}

async function handleClaudeRequest(req, res) {
  if (!isAllowedOrigin(req.headers.origin)) {
    return res.writeHead(403, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ kind: 'forbidden', status: 403, message: 'Origin not allowed' }));
  }

  if (!API_KEY || !Anthropic) {
    return res.writeHead(503, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({
        kind: 'no_key',
        status: 503,
        message: 'ANTHROPIC_API_KEY is not set on the server. Live runs are unavailable.',
        replay: true,
        fixtures: ['single-tool', 'parallel-tools', 'tool-error', 'refusal', 'iteration-cap'],
      }));
  }

  let raw;
  try { raw = await readBody(req); } catch (err) {
    return res.writeHead(err.status || 400).end(err.message);
  }

  let body;
  try { body = JSON.parse(raw); } catch {
    return res.writeHead(400, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ kind: 'bad_request', status: 400, message: 'Request body is not valid JSON' }));
  }

  // Field allowlist. Unknown fields are a 400, not a silent drop.
  const ALLOWED_FIELDS = new Set(['messages', 'system', 'tools', 'tool_choice', 'max_tokens', 'output_config', 'thinking', 'stream']);
  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(key)) {
      return res.writeHead(400, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ kind: 'bad_request', status: 400, message: `Unknown field: "${key}". Allowed: ${[...ALLOWED_FIELDS].join(', ')}` }));
    }
  }

  // messages: non-empty array, last entry must not be role:assistant (no prefill)
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return res.writeHead(400, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ kind: 'bad_request', status: 400, message: '"messages" must be a non-empty array' }));
  }
  const lastMsg = body.messages[body.messages.length - 1];
  if (lastMsg?.role === 'assistant') {
    return res.writeHead(400, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ kind: 'bad_request', status: 400, message: 'Last message must not be role "assistant". Prefill is removed on this model.' }));
  }

  // tool_choice: only auto or none
  if (body.tool_choice !== undefined) {
    const tc = body.tool_choice;
    if (!tc || typeof tc !== 'object') {
      return res.writeHead(400, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ kind: 'bad_request', status: 400, message: '"tool_choice" must be an object' }));
    }
    if (tc.type === 'any' || tc.type === 'tool') {
      return res.writeHead(400, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({
          kind: 'bad_request', status: 400,
          message: `tool_choice.type "${tc.type}" is not supported. Forced tool use is removed on this model. Use "auto" instead with a system instruction naming the tool.`,
        }));
    }
    if (tc.type !== 'auto' && tc.type !== 'none') {
      return res.writeHead(400, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ kind: 'bad_request', status: 400, message: `Unknown tool_choice.type "${tc.type}". Allowed: auto, none` }));
    }
  }

  // thinking: only adaptive+summarized or omitted
  if (body.thinking !== undefined) {
    const th = body.thinking;
    if (!th || th.type !== 'adaptive' || th.display !== 'summarized') {
      return res.writeHead(400, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ kind: 'bad_request', status: 400, message: 'thinking must be { type: "adaptive", display: "summarized" } or omitted' }));
    }
  }

  // tools: every name must appear in the server's own tools/list
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) {
      return res.writeHead(400, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ kind: 'bad_request', status: 400, message: '"tools" must be an array' }));
    }
    const known = await getKnownToolNames();
    for (const tool of body.tools) {
      if (!known.has(tool.name)) {
        return res.writeHead(400, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ kind: 'bad_request', status: 400, message: `Tool "${tool.name}" is not in the server's tools/list. A client cannot invent a tool.` }));
      }
    }
  }

  // output_config.effort
  if (body.output_config !== undefined) {
    const effort = body.output_config?.effort;
    if (effort !== undefined && !ALLOWED_EFFORTS.has(effort)) {
      return res.writeHead(400, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ kind: 'bad_request', status: 400, message: `output_config.effort "${effort}" is not allowed. Allowed: ${[...ALLOWED_EFFORTS].join(', ')}` }));
    }
  }

  // max_tokens: clamp
  const streaming = body.stream !== false;
  const maxAllowed = streaming ? 64000 : 16000;
  const maxTokens = Math.max(1, Math.min(body.max_tokens ?? maxAllowed, maxAllowed));

  // Build the final request — model is always server-side.
  const apiRequest = {
    model: MODEL,
    messages: body.messages,
    max_tokens: maxTokens,
    stream: streaming,
  };
  if (body.system) apiRequest.system = body.system;
  if (body.tools) apiRequest.tools = body.tools;
  if (body.tool_choice) apiRequest.tool_choice = body.tool_choice;
  if (body.thinking) apiRequest.thinking = body.thinking;
  if (body.output_config) apiRequest.output_config = body.output_config;

  const client = new Anthropic(); // picks up ANTHROPIC_API_KEY from env

  try {
    if (streaming) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      const stream = client.messages.stream(apiRequest);
      for await (const event of stream) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      const response = await client.messages.create(apiRequest);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(response));
    }
  } catch (err) {
    let body;
    if (Anthropic.BadRequestError && err instanceof Anthropic.BadRequestError) {
      body = { kind: 'bad_request', status: 400, message: err.message };
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    } else if (Anthropic.AuthenticationError && err instanceof Anthropic.AuthenticationError) {
      body = { kind: 'authentication', status: 401, message: 'API key is invalid or missing' };
      res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    } else if (Anthropic.RateLimitError && err instanceof Anthropic.RateLimitError) {
      body = { kind: 'rate_limit', status: 429, message: err.message };
      res.writeHead(429, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    } else if (Anthropic.APIError && err instanceof Anthropic.APIError) {
      body = { kind: 'api_error', status: err.status ?? 500, message: err.message };
      res.writeHead(err.status ?? 500, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    } else {
      body = { kind: 'server_error', status: 500, message: 'Internal server error' };
      res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    }
  }
}

// ---------------------------------------------------------------- MCP subprocess

let mcpProcess = null;
let mcpBuffer = '';
let pendingMcpCalls = new Map();
let mcpId = 1;
let mcpSpawnError = null;
let mcpRespawnCount = 0;

function spawnMcp() {
  const child = spawn(process.execPath, [join(ROOT, 'mcp/server.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  child.stderr.on('data', (d) => process.stderr.write(`[mcp] ${d}`));

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    mcpBuffer += chunk;
    const lines = mcpBuffer.split('\n');
    mcpBuffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch {
        process.stderr.write(`[mcp] non-JSON line on stdout: ${line.slice(0, 200)}\n`);
        continue;
      }
      const pending = pendingMcpCalls.get(msg.id);
      if (pending) {
        pendingMcpCalls.delete(msg.id);
        pending(msg);
      }
    }
  });

  child.on('exit', (code) => {
    process.stderr.write(`[mcp] exited with code ${code}\n`);
    if (mcpRespawnCount < 1) {
      mcpRespawnCount++;
      mcpProcess = spawnMcp();
    } else {
      mcpProcess = null;
      mcpSpawnError = 'MCP subprocess exited and will not be respawned';
      for (const [id, resolve] of pendingMcpCalls) {
        resolve({ jsonrpc: '2.0', id, error: { code: -32000, message: mcpSpawnError } });
      }
      pendingMcpCalls.clear();
    }
  });

  child.on('error', (err) => {
    mcpSpawnError = err.message;
    process.stderr.write(`[mcp] spawn error: ${err.message}\n`);
  });

  // Send initialize handshake.
  const initId = mcpId++;
  const initMsg = JSON.stringify({
    jsonrpc: '2.0', id: initId, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-agent-lab', version: '1.0.0' } },
  });
  child.stdin.write(initMsg + '\n');
  // Wait for initialize response, then send notification.
  pendingMcpCalls.set(initId, () => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  });

  return child;
}

function ensureMcp() {
  if (!mcpProcess) mcpProcess = spawnMcp();
  return mcpProcess;
}

async function mcpRpc(method, params) {
  const child = ensureMcp();
  const id = mcpId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingMcpCalls.delete(id);
      reject(new Error('MCP RPC timeout'));
    }, 8000);
    pendingMcpCalls.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function handleMcpRequest(req, res) {
  if (!isAllowedOrigin(req.headers.origin)) {
    return res.writeHead(403).end('Forbidden');
  }

  if (mcpSpawnError && !mcpProcess) {
    return res.writeHead(503, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: mcpSpawnError }));
  }

  let raw;
  try { raw = await readBody(req); } catch (err) {
    return res.writeHead(err.status || 400).end(err.message);
  }

  let body;
  try { body = JSON.parse(raw); } catch {
    return res.writeHead(400).end('Invalid JSON');
  }

  try {
    const result = await mcpRpc(body.method, body.params);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(503, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: err.message }));
  }
}

// ---------------------------------------------------------------- HTTP server

const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/claude') {
    return handleClaudeRequest(req, res);
  }
  if (req.method === 'POST' && req.url === '/api/mcp') {
    return handleMcpRequest(req, res);
  }

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

server.listen(PORT, HOST, () => {
  const keyStatus = API_KEY ? 'key set' : 'no key — replay mode';
  console.log(`\n  MCP Agent Lab running at  http://${HOST}:${PORT}  (${keyStatus})\n`);
});

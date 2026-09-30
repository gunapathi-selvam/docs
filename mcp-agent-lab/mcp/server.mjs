// Hand-written MCP server over stdio. JSON-RPC 2.0, newline-delimited.
// No MCP SDK — the wire format is the thing being taught. SPEC §3.1–§3.4
//
// IMPORTANT: stdout is the protocol channel. Never write to it except via
// sendResponse(). All diagnostics go to stderr, which server.js prefixes
// with [mcp]. A stray console.log breaks the framing parser on the bridge
// side, and the failure looks like a parse error rather than a log line.

import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { TOOLS, dispatchTool } from './tools.mjs';

// ---------------------------------------------------------------- framing
// SPEC §3.1: one JSON-RPC message per line, no Content-Length header.
// A stream chunk may split a message; carry the remainder into the next chunk.

export function decodeFrames(buffer) {
  const lines = buffer.split('\n');
  const remainder = lines.pop(); // may be '' (clean split) or a partial line
  const frames = lines.filter((l) => l.trim().length > 0);
  return { frames, remainder };
}

// ---------------------------------------------------------------- state

export function createState() {
  return {
    initializing: false,  // initialize request was received
    initialized: false,   // notifications/initialized was received
  };
}

// ---------------------------------------------------------------- message dispatch
// Returns null for notifications (no id), a plain object for requests.
// Async because tools/call dispatches to async handlers.

export async function handleMessage(state, msg, realRoot) {
  // Notifications have no id — must not reply. §3.2
  if (msg.id === undefined || msg.id === null) {
    if (msg.method === 'notifications/initialized') {
      state.initialized = true;
    }
    return null;
  }

  const { id, method, params } = msg;

  if (method === 'initialize') {
    state.initializing = true;
    state.initialized = false;
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'mcp-agent-lab-fs', version: '1.0.0' },
      },
    };
  }

  // Refuse all other methods until the handshake is complete. §3.2
  if (!state.initializing) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32002, message: 'Server not initialized' },
    };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: [...TOOLS].sort((a, b) => a.name.localeCompare(b.name)),
      },
    };
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};

    if (typeof name !== 'string') {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'params.name is required' } };
    }

    const known = TOOLS.find((t) => t.name === name);
    if (!known) {
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } };
    }

    try {
      const toolResult = await dispatchTool(name, args, realRoot ?? '.');
      return {
        jsonrpc: '2.0',
        id,
        result: toolResult,
      };
    } catch (err) {
      // Tool ran and failed — result.isError, NOT a JSON-RPC error. §3.4
      // Using JSON-RPC error -32602 would tell the model its arguments were
      // malformed and encourage a retry loop.
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: err.message }], isError: true },
      };
    }
  }

  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

// ---------------------------------------------------------------- stdio loop

async function main() {
  // fileURLToPath, not .pathname: a file URL percent-encodes its path, so a
  // project directory containing a space arrives as 'New%20folder' and every
  // realpath fails with ENOENT. It also handles the drive-letter prefix and
  // separators, which the hand-rolled regex this replaced did not.
  const mcpRoot = process.env.MCP_ROOT
    ? await realpath(resolve(process.env.MCP_ROOT))
    : await realpath(fileURLToPath(new URL('..', import.meta.url)));

  const state = createState();
  let buffer = '';

  function sendResponse(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
  }

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    buffer += chunk;
    const { frames, remainder } = decodeFrames(buffer);
    buffer = remainder;

    for (const frame of frames) {
      let msg;
      try {
        msg = JSON.parse(frame);
      } catch {
        sendResponse({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error', data: frame.slice(0, 200) } });
        continue;
      }

      try {
        const response = await handleMessage(state, msg, mcpRoot);
        if (response !== null) sendResponse(response);
      } catch (err) {
        process.stderr.write(`[mcp] unhandled error: ${err.message}\n`);
        if (msg.id !== undefined && msg.id !== null) {
          sendResponse({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error' } });
        }
      }
    }
  });

  process.stdin.on('end', () => {
    process.exit(0);
  });
}

// Only start when run directly; exported functions are used by tests.
const isMain = process.argv[1] &&
  fileURLToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/');

if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[mcp] fatal: ${err.message}\n`);
    process.exit(1);
  });
}

// MCP tool implementations and their JSON schemas.
// Pure sandbox functions (normaliseRequestPath, isInsideRoot, resolveSafe) are
// exported for unit and pipeline tests. Tool handlers are skeletons. SPEC §3.5, §4.2

import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { resolve, join, sep, normalize } from 'node:path';

// ---------------------------------------------------------------- sandboxing

// SPEC §4.2 Stage 1 — pure string-level rejection before touching the filesystem.
export function normaliseRequestPath(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw Object.assign(new Error('Empty path'), { code: 'EINVAL' });
  }
  if (raw.includes('\0')) {
    throw Object.assign(new Error('Path contains NUL byte'), { code: 'EINVAL' });
  }
  // Absolute paths: POSIX (/), Windows (C:\), UNC (\\)
  if (/^[/\\]/.test(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith('\\\\')) {
    throw Object.assign(new Error('Absolute paths are not allowed'), { code: 'EINVAL' });
  }
  if (raw.includes('..')) {
    throw Object.assign(new Error('Path traversal (..) not allowed'), { code: 'EINVAL' });
  }
  return normalize(raw);
}

// SPEC §4.2 Stage 2 — pure prefix check with mandatory separator.
// A bare root prefix lets '/srv/sandbox-evil' pass a '/srv/sandbox' check.
export function isInsideRoot(root, candidate) {
  const r = root.endsWith(sep) ? root : root + sep;
  return candidate === root || candidate.startsWith(r);
}

// SPEC §4.2 Stage 3 — resolve symlinks and re-check.
// realRoot must be the result of realpath(MCP_ROOT), computed once at startup.
export async function resolveSafe(realRoot, raw) {
  const normalised = normaliseRequestPath(raw);
  const joined = resolve(realRoot, normalised);

  if (!isInsideRoot(realRoot, joined)) {
    throw Object.assign(new Error('Path escapes sandbox root'), { code: 'SANDBOX' });
  }

  let real;
  try {
    real = await realpath(joined);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Walk up to the deepest existing ancestor and re-check it.
      const parts = normalised.split(sep).filter(Boolean);
      let ancestor = realRoot;
      for (const part of parts) {
        const next = join(ancestor, part);
        try {
          ancestor = await realpath(next);
        } catch {
          break;
        }
      }
      if (!isInsideRoot(realRoot, ancestor)) {
        throw Object.assign(new Error('Path escapes sandbox root via ancestor'), { code: 'SANDBOX' });
      }
      throw err;
    }
    throw err;
  }

  if (!isInsideRoot(realRoot, real)) {
    throw Object.assign(new Error('Path escapes sandbox root via symlink'), { code: 'SANDBOX' });
  }
  return real;
}

// ---------------------------------------------------------------- tool schemas
// Sorted by name (ascending, byte order). §3.3 §5.4

export const TOOLS = [
  {
    name: 'current_time',
    description: 'Get the current date and time. Returns ISO 8601 and a human-readable form.',
    inputSchema: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          description: 'IANA timezone name, e.g. Europe/London. Defaults to UTC.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'list_directory',
    description: 'List the contents of a directory under the sandbox root. Symlinks are reported as "symlink" and not followed.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path relative to the sandbox root. Defaults to ".".',
        },
        include_hidden: {
          type: 'boolean',
          description: 'Include entries whose names start with ".". Defaults to false.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'read_text_file',
    description: 'Read a UTF-8 text file under the sandbox root. Truncates at max_bytes with an explicit [truncated] marker. Refuses non-UTF-8 content.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path relative to the sandbox root.',
        },
        max_bytes: {
          type: 'integer',
          minimum: 1,
          maximum: 262144,
          description: 'Maximum bytes to read. Defaults to 65536.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_files',
    description: 'Search file contents for a literal substring. Case-insensitive. Not a regex — literal substring only, to avoid backtracking denial-of-service.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Literal substring to search for.',
        },
        path: {
          type: 'string',
          description: 'Directory to search, relative to the sandbox root. Defaults to ".".',
        },
        max_results: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'Maximum number of results to return. Defaults to 40.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.cache']);

// ---------------------------------------------------------------- tool handlers

export async function handleCurrentTime(args) {
  const tz = (typeof args.timezone === 'string' && args.timezone) ? args.timezone : 'UTC';
  const now = new Date();
  const iso = now.toISOString();
  let human;
  try {
    human = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
    }).format(now);
  } catch {
    // Unknown timezone — fall back to UTC string.
    human = now.toUTCString();
  }
  return { content: [{ type: 'text', text: `${iso} (${human})` }], isError: false };
}

export async function handleReadTextFile(args, realRoot) {
  if (typeof args.path !== 'string' || !args.path) {
    return { content: [{ type: 'text', text: 'path is required' }], isError: true };
  }
  const maxBytes = (typeof args.max_bytes === 'number')
    ? Math.max(1, Math.min(args.max_bytes, 262144)) : 65536;

  let safePath;
  try { safePath = await resolveSafe(realRoot, args.path); }
  catch (err) { return { content: [{ type: 'text', text: err.message }], isError: true }; }

  let buffer;
  try { buffer = await readFile(safePath); }
  catch (err) {
    const msg = err.code === 'EISDIR'
      ? `EISDIR: ${args.path} is a directory`
      : err.message;
    return { content: [{ type: 'text', text: msg }], isError: true };
  }

  const truncated = buffer.length > maxBytes;
  const slice = buffer.subarray(0, truncated ? maxBytes : buffer.length);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(slice); }
  catch { return { content: [{ type: 'text', text: 'File contains invalid UTF-8 and cannot be read as text.' }], isError: true }; }

  if (truncated) text += '\n[truncated]';
  return { content: [{ type: 'text', text }], isError: false };
}

export async function handleListDirectory(args, realRoot) {
  const pathArg = (typeof args.path === 'string' && args.path) ? args.path : '.';
  const includeHidden = args.include_hidden === true;

  let safePath;
  try { safePath = await resolveSafe(realRoot, pathArg); }
  catch (err) { return { content: [{ type: 'text', text: err.message }], isError: true }; }

  let entries;
  try { entries = await readdir(safePath, { withFileTypes: true }); }
  catch (err) { return { content: [{ type: 'text', text: err.message }], isError: true }; }

  const lines = [];
  for (const entry of entries) {
    if (!includeHidden && entry.name.startsWith('.')) continue;
    let kind;
    if (entry.isSymbolicLink()) kind = 'symlink';
    else if (entry.isDirectory()) kind = 'dir';
    else kind = 'file';

    let size = '';
    if (kind === 'file') {
      try { size = ` ${(await stat(join(safePath, entry.name))).size}`; } catch { /* ignore */ }
    }
    lines.push(`${entry.name} ${kind}${size}`);
  }
  return { content: [{ type: 'text', text: lines.join('\n') || '(empty directory)' }], isError: false };
}

export async function handleSearchFiles(args, realRoot) {
  if (typeof args.query !== 'string' || !args.query) {
    return { content: [{ type: 'text', text: 'query is required' }], isError: true };
  }
  const pathArg = (typeof args.path === 'string' && args.path) ? args.path : '.';
  const maxResults = (typeof args.max_results === 'number')
    ? Math.max(1, Math.min(args.max_results, 200)) : 40;

  let safePath;
  try { safePath = await resolveSafe(realRoot, pathArg); }
  catch (err) { return { content: [{ type: 'text', text: err.message }], isError: true }; }

  const queryLower = args.query.toLowerCase();
  const results = [];

  async function walk(dir, relBase) {
    if (results.length >= maxResults) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (results.length >= maxResults) return;
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      const relPath = relBase ? join(relBase, entry.name) : entry.name;

      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(fullPath, relPath);
      } else if (entry.isFile()) {
        try {
          const st = await stat(fullPath);
          if (st.size > 1024 * 1024) continue;
          const buf = await readFile(fullPath);
          const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
          const lines = text.split('\n');
          for (let i = 0; i < lines.length && results.length < maxResults; i++) {
            if (lines[i].toLowerCase().includes(queryLower)) {
              results.push(`${relPath.replace(/\\/g, '/')}:${i + 1}: ${lines[i]}`);
            }
          }
        } catch { continue; }
      }
    }
  }

  await walk(safePath, '');
  const text = results.length > 0 ? results.join('\n') : `No matches for "${args.query}"`;
  return { content: [{ type: 'text', text }], isError: false };
}

export async function dispatchTool(name, args, realRoot) {
  switch (name) {
    case 'current_time': return handleCurrentTime(args ?? {});
    case 'list_directory': return handleListDirectory(args ?? {}, realRoot);
    case 'read_text_file': return handleReadTextFile(args ?? {}, realRoot);
    case 'search_files': return handleSearchFiles(args ?? {}, realRoot);
    default: throw Object.assign(new Error(`Unknown tool: ${name}`), { code: 'ENOENT' });
  }
}

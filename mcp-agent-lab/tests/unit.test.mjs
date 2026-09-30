// Pure-module assertions: schema mapping, timeline model, path sandbox, MCP
// framing. No DOM, no network, no filesystem writes. SPEC §13

import { section, ok, eq, finish } from './harness.mjs';
import { normaliseRequestPath, isInsideRoot } from '../mcp/tools.mjs';
import { decodeFrames, handleMessage, createState } from '../mcp/server.mjs';
import { canBeStrict, mcpToolToClaudeTool, toClaudeTools } from '../src/js/mcpClient.js';
import { EVENT_TYPES, createTimeline, appendEvent, pairToolResults } from '../src/js/timeline.js';

// One NotImplemented does not abort the suite.
const attempt = (fn, fallback = undefined) => { try { return fn(); } catch { return fallback; } };
const attemptAsync = async (fn, fallback = undefined) => { try { return await fn(); } catch { return fallback; } };

// ===========================================================================
// Path sandbox — pure string functions. SPEC §4.2, §13.1
// ===========================================================================

section('sandbox: normaliseRequestPath rejects dangerous inputs');

ok('empty string throws', (() => { try { normaliseRequestPath(''); return false; } catch { return true; } })());
ok('NUL byte throws', (() => { try { normaliseRequestPath('a\0b'); return false; } catch { return true; } })());
ok('absolute POSIX path throws', (() => { try { normaliseRequestPath('/etc/passwd'); return false; } catch { return true; } })());
ok('absolute Windows path throws', (() => { try { normaliseRequestPath('C:\\Windows'); return false; } catch { return true; } })());
ok('UNC path throws', (() => { try { normaliseRequestPath('\\\\server\\share'); return false; } catch { return true; } })());
ok('traversal (..) throws', (() => { try { normaliseRequestPath('../../etc/passwd'); return false; } catch { return true; } })());
ok('traversal inside path throws', (() => { try { normaliseRequestPath('a/../b'); return false; } catch { return true; } })());

{
  const r = attempt(() => normaliseRequestPath('spec/SPEC.md'));
  ok('valid relative path returns a string', typeof r === 'string');
  ok('valid relative path does not include ..', r !== undefined && !r.includes('..'));
}

{
  const r = attempt(() => normaliseRequestPath('.'));
  ok('"." is a valid path', typeof r === 'string');
}

section('sandbox: isInsideRoot requires separator-terminated comparison');

{
  const sep = process.platform === 'win32' ? '\\' : '/';
  const root = `/srv/sandbox`;
  ok('path inside root passes', isInsideRoot(root, `${root}${sep}file.txt`));
  ok('root itself passes', isInsideRoot(root, root));

  // The critical sibling case: /srv/sandbox-evil must NOT pass /srv/sandbox check.
  ok('sibling directory with same prefix fails', !isInsideRoot(root, `/srv/sandbox-evil`));
  ok('sibling directory with same prefix + sep fails', !isInsideRoot(root, `/srv/sandbox-evil${sep}file`));

  ok('parent directory fails', !isInsideRoot(root, '/srv'));
  ok('completely unrelated path fails', !isInsideRoot(root, '/etc/passwd'));
}

// ===========================================================================
// MCP framing — decodeFrames. SPEC §3.1, §13
// ===========================================================================

section('MCP: decodeFrames handles complete lines');

{
  const { frames, remainder } = decodeFrames('{"a":1}\n{"b":2}\n');
  eq('two complete frames found', frames.length, 2);
  eq('remainder is empty for clean split', remainder, '');
}

section('MCP: decodeFrames carries partial lines as remainder');

{
  // Feed a message one byte at a time to verify partial-line handling.
  const msg = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n';
  let buf = '';
  let frames = [];
  for (const ch of msg) {
    buf += ch;
    const { frames: f, remainder } = decodeFrames(buf);
    frames = frames.concat(f);
    buf = remainder;
  }
  eq('full message is reconstructed from single-byte reads', frames.length, 1);
  ok('reconstructed frame is valid JSON', (() => { try { JSON.parse(frames[0]); return true; } catch { return false; } })());
  eq('no leftover remainder after final newline', buf, '');
}

{
  const { frames, remainder } = decodeFrames('{"partial":');
  eq('no complete frames for partial input', frames.length, 0);
  eq('partial line is preserved as remainder', remainder, '{"partial":');
}

section('MCP: handleMessage returns null for notifications (no id)');

{
  const state = createState();
  // First initialize
  await handleMessage(state, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }, '.');
  const result = await handleMessage(state, { jsonrpc: '2.0', method: 'notifications/initialized' }, '.');
  eq('notification returns null (no id, no reply)', result, null);
}

section('MCP: handleMessage refuses requests before initialize');

{
  const state = createState();
  const result = await handleMessage(state, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, '.');
  ok('returns an error response', result !== null && result.error !== undefined);
  eq('error code is -32002', result?.error?.code, -32002);
}

section('MCP: handleMessage returns tools/list response after initialize');

{
  const state = createState();
  await handleMessage(state, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }, '.');
  await handleMessage(state, { jsonrpc: '2.0', method: 'notifications/initialized' }, '.');
  const result = await handleMessage(state, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, '.');
  ok('tools/list returns a result', result?.result !== undefined);
  ok('result has a tools array', Array.isArray(result?.result?.tools));
  ok('tools are sorted by name', (() => {
    const names = result.result.tools.map((t) => t.name);
    return names.every((n, i) => i === 0 || names[i - 1] <= n);
  })());
}

section('MCP: handleMessage returns -32601 for unknown method');

{
  const state = createState();
  await handleMessage(state, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }, '.');
  const result = await handleMessage(state, { jsonrpc: '2.0', id: 3, method: 'unknown/method' }, '.');
  eq('unknown method returns -32601', result?.error?.code, -32601);
}

// ===========================================================================
// Schema mapping — canBeStrict, mcpToolToClaudeTool, toClaudeTools. SPEC §5
// ===========================================================================

section('schema: canBeStrict passes a well-formed schema');

{
  const schema = {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: [],
    additionalProperties: false,
  };
  const result = attempt(() => canBeStrict(schema));
  ok('returns an object', result !== null && typeof result === 'object');
  ok('ok is true for valid schema', result?.ok === true);
}

section('schema: canBeStrict rejects forbidden constructs');

{
  const missing_type = attempt(() => canBeStrict({ properties: { a: {} }, required: [], additionalProperties: false }));
  ok('missing type: not ok', missing_type?.ok === false);

  const no_props = attempt(() => canBeStrict({ type: 'object', required: [], additionalProperties: false }));
  ok('no properties: not ok', no_props?.ok === false);

  const explicit_true = attempt(() => canBeStrict({ type: 'object', properties: { a: {} }, required: [], additionalProperties: true }));
  ok('additionalProperties: true: not ok', explicit_true?.ok === false);

  const has_oneOf = attempt(() => canBeStrict({ type: 'object', properties: { a: {} }, required: [], additionalProperties: false, oneOf: [] }));
  ok('oneOf combinator: not ok', has_oneOf?.ok === false);

  const has_ref = attempt(() => canBeStrict({ type: 'object', properties: { a: {} }, required: [], additionalProperties: false, '$ref': '#' }));
  ok('$ref: not ok', has_ref?.ok === false);
}

section('schema: missing additionalProperties and required are repaired');

{
  const tool = {
    name: 'test_tool',
    description: 'A test tool.',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'number' } },
      // additionalProperties and required are omitted — should be repaired
    },
  };
  const mapped = attempt(() => mcpToolToClaudeTool(tool));
  ok('strict is true after repair', mapped?.strict === true);
  ok('repairs are recorded', Array.isArray(mapped?.repairs) && mapped.repairs.length > 0);
  ok('additionalProperties is now false', mapped?.input_schema?.additionalProperties === false);
  ok('required is now []', Array.isArray(mapped?.input_schema?.required));
}

section('schema: additionalProperties: true is NOT repaired (explicit statement)');

{
  const tool = {
    name: 'open_tool',
    description: 'Open schema.',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'number' } },
      required: [],
      additionalProperties: true,
    },
  };
  const mapped = attempt(() => mcpToolToClaudeTool(tool));
  ok('degraded: true when additionalProperties is explicit true', mapped?.degraded === true);
  ok('strict is not set', mapped?.strict !== true);
}

section('schema: tool with invalid name is dropped');

{
  const tools = attempt(() => toClaudeTools([
    { name: 'ok_tool', description: '', inputSchema: { type: 'object', properties: { a: {} }, required: [], additionalProperties: false } },
    { name: 'bad name!', description: '', inputSchema: { type: 'object', properties: { a: {} }, required: [], additionalProperties: false } },
  ]));
  ok('only valid tool is returned', tools?.length === 1);
  ok('returned tool has the valid name', tools?.[0]?.name === 'ok_tool');
}

section('schema: toClaudeTools sorts by name');

{
  const tools = attempt(() => toClaudeTools([
    { name: 'z_tool', description: '', inputSchema: { type: 'object', properties: { a: {} }, required: [], additionalProperties: false } },
    { name: 'a_tool', description: '', inputSchema: { type: 'object', properties: { a: {} }, required: [], additionalProperties: false } },
    { name: 'm_tool', description: '', inputSchema: { type: 'object', properties: { a: {} }, required: [], additionalProperties: false } },
  ]));
  ok('three tools returned', tools?.length === 3);
  ok('sorted alphabetically', tools?.[0]?.name === 'a_tool' && tools?.[1]?.name === 'm_tool' && tools?.[2]?.name === 'z_tool');
}

// ===========================================================================
// Timeline model. SPEC §7
// ===========================================================================

section('timeline: EVENT_TYPES is the closed list of 11 types');

eq('eleven event types', EVENT_TYPES.length, 11);
ok('run_start is included', EVENT_TYPES.includes('run_start'));
ok('tool_use is included', EVENT_TYPES.includes('tool_use'));
ok('cap is included', EVENT_TYPES.includes('cap'));
ok('run_end is included', EVENT_TYPES.includes('run_end'));

section('timeline: appendEvent assigns monotonic seq');

{
  const tl = attempt(() => createTimeline());
  ok('createTimeline returns an object', !!tl);

  const e1 = attempt(() => appendEvent(tl, { type: 'run_start', turn: 0, data: {} }));
  const e2 = attempt(() => appendEvent(tl, { type: 'request', turn: 0, data: {} }));
  ok('events are appended', tl?.events?.length >= 2);
  ok('seq is monotonically increasing', e1?.seq < e2?.seq);
  ok('events array contains the appended events', tl?.events?.includes(e1) && tl?.events?.includes(e2));
}

section('timeline: appendEvent throws on unknown type');

{
  const tl = createTimeline();
  let threw = false;
  try { appendEvent(tl, { type: 'unknown_future_type', turn: 0, data: {} }); }
  catch { threw = true; }
  ok('throws on unknown event type', threw);
}

section('timeline: pairToolResults matches by tool_use_id');

{
  const tl = attempt(() => createTimeline());
  if (tl) {
    appendEvent(tl, { type: 'run_start', turn: 0, data: {} });
    appendEvent(tl, { type: 'tool_use', turn: 1, data: { id: 'tu_001', name: 'current_time', input: {} } });
    appendEvent(tl, { type: 'tool_use', turn: 1, data: { id: 'tu_002', name: 'list_directory', input: {} } });
    appendEvent(tl, { type: 'tool_result', turn: 1, data: { tool_use_id: 'tu_002', content: [], is_error: false } });
    appendEvent(tl, { type: 'tool_result', turn: 1, data: { tool_use_id: 'tu_001', content: [], is_error: false } });

    const { pairs, unmatchedUses, unmatchedResults } = attempt(() => pairToolResults(tl.events), {});
    eq('two pairs found', pairs?.length, 2);
    eq('no unmatched uses', unmatchedUses?.length, 0);
    eq('no unmatched results', unmatchedResults?.length, 0);
  } else {
    ok('SKIP: createTimeline not implemented', false);
  }
}

section('timeline: pairToolResults surfaces unmatched tool_use as defect');

{
  const tl = attempt(() => createTimeline());
  if (tl) {
    appendEvent(tl, { type: 'tool_use', turn: 1, data: { id: 'tu_orphan', name: 'current_time', input: {} } });
    // No matching tool_result

    const { pairs, unmatchedUses } = attempt(() => pairToolResults(tl.events), {});
    eq('no pairs for unmatched use', pairs?.length, 0);
    eq('one unmatched use', unmatchedUses?.length, 1);
    ok('unmatched use has the expected id', unmatchedUses?.[0]?.data?.id === 'tu_orphan');
  } else {
    ok('SKIP: createTimeline not implemented', false);
  }
}

finish();

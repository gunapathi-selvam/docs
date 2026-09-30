// Full loop against fixtures, plus three specific regression tests. SPEC §13.1
//
// 1. FAILS if parallel tool_results are split across user messages (§6.4)
// 2. FAILS if a path-traversal or symlink escape succeeds (§4.2)
// 3. FAILS if a forced tool_choice would be forwarded (§6.1)

import { section, ok, eq, finish, createReplayTransport } from './harness.mjs';
import { SINGLE_TOOL, PARALLEL_TOOLS, TOOL_ERROR, REFUSAL, ITERATION_CAP } from './fixtures.mjs';
import { runLoop, buildRequest, buildToolResultMessage, CAPS } from '../src/js/agent.js';
import { resolveSafe, normaliseRequestPath, isInsideRoot } from '../mcp/tools.mjs';
import { mkdtemp, symlink, writeFile, rm, mkdir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { realpath } from 'node:fs/promises';

const attempt = (fn, fallback = undefined) => { try { return fn(); } catch { return fallback; } };
const attemptAsync = async (fn, fallback = undefined) => { try { return await fn(); } catch { return fallback; } };

// ===========================================================================
// CAPS and pure helpers
// ===========================================================================

section('agent: CAPS has correct values per SPEC §6.3');

eq('maxIterations is 12', CAPS.maxIterations, 12);
eq('maxToolCalls is 40', CAPS.maxToolCalls, 40);
eq('tokenBudget is 200000', CAPS.tokenBudget, 200000);
eq('wallClockMs is 120000', CAPS.wallClockMs, 120000);
eq('callTimeoutMs is 5000', CAPS.callTimeoutMs, 5000);

// ===========================================================================
// REGRESSION: forced tool_choice must NOT be forwarded (SPEC §6.1)
// This test FAILS if buildRequest is changed to emit tool_choice: {type:'any'}
// or tool_choice: {type:'tool'}.
// ===========================================================================

section('agent: buildRequest never produces forced tool_choice (SPEC §6.1)');

{
  const req = attempt(() => buildRequest(
    [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    [],
    { effort: 'medium' }
  ));

  // If req is null, buildRequest is not yet implemented — test fails.
  ok('buildRequest returns a request object', req !== null && typeof req === 'object');
  ok('tool_choice.type is auto or none, not any or tool',
    req != null && (req.tool_choice?.type === 'auto' || req.tool_choice?.type === 'none'));
  ok('forced tool_choice (any) is not present', req?.tool_choice?.type !== 'any');
  ok('forced tool_choice (tool) is not present', req?.tool_choice?.type !== 'tool');
}

{
  // Also check that 'none' is accepted (for the no-tools comparison run)
  const req = attempt(() => buildRequest([], [], { toolChoiceType: 'none' }));
  ok('toolChoiceType: "none" produces tool_choice.type === "none"',
    req?.tool_choice?.type === 'none');
}

section('agent: buildRequest uses display:"summarized" for thinking (SPEC §6.1)');

{
  const req = attempt(() => buildRequest([], [], {}));
  ok('thinking is set', req?.thinking !== undefined);
  ok('thinking.type is adaptive', req?.thinking?.type === 'adaptive');
  ok('thinking.display is summarized (prevents blank thinking nodes)', req?.thinking?.display === 'summarized');
}

section('agent: buildRequest puts effort inside output_config (SPEC §6.1)');

{
  const req = attempt(() => buildRequest([], [], { effort: 'high' }));
  ok('output_config.effort is set', req?.output_config?.effort === 'high');
  ok('effort is not top-level', !('effort' in (req ?? {})));
}

// ===========================================================================
// REGRESSION: buildToolResultMessage must return ONE message (SPEC §6.4)
// ===========================================================================

section('agent: buildToolResultMessage returns exactly one user message (SPEC §6.4)');

{
  const results = [
    { tool_use_id: 'tu_001', content: [{ type: 'text', text: 'result A' }], is_error: false },
    { tool_use_id: 'tu_002', content: [{ type: 'text', text: 'result B' }], is_error: false },
  ];

  const msg = attempt(() => buildToolResultMessage(results));
  ok('returns one object (not an array)', msg !== null && !Array.isArray(msg));
  eq('role is user', msg?.role, 'user');
  ok('content is an array', Array.isArray(msg?.content));
  eq('both tool_results are in the single message', msg?.content?.length, 2);
  ok('all entries are tool_result type', msg?.content?.every((b) => b.type === 'tool_result'));
  ok('tool_use_ids are preserved', msg?.content?.some((b) => b.tool_use_id === 'tu_001') &&
    msg?.content?.some((b) => b.tool_use_id === 'tu_002'));
}

{
  // A failed tool must still produce a tool_result, not nothing.
  const errorResult = [
    { tool_use_id: 'tu_err', content: [{ type: 'text', text: 'Path escapes sandbox' }], is_error: true },
  ];
  const msg = attempt(() => buildToolResultMessage(errorResult));
  ok('failed tool produces a tool_result', msg?.content?.[0]?.type === 'tool_result');
  ok('is_error is preserved', msg?.content?.[0]?.is_error === true);
}

// ===========================================================================
// Full loop: single-tool fixture
// ===========================================================================

section('pipeline: single-tool fixture runs the loop (SPEC §8.2)');

{
  const transport = createReplayTransport(SINGLE_TOOL);
  const events = [];
  let loopError = null;

  try {
    await runLoop(transport, (ev) => events.push(ev), {
      prompt: 'What time is it?',
      tools: [{ name: 'current_time', description: '', input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false }, strict: true }],
    });
  } catch (e) {
    loopError = e;
  }

  if (loopError?.message?.includes('NotImplemented')) {
    ok('SKIP (loop not implemented): single-tool run', false);
  } else {
    ok('loop ran without error', loopError === null);
    ok('at least one request was sent', transport.sentRequests.length >= 1);
    ok('run_end event is emitted', events.some((e) => e.type === 'run_end'));
  }
}

// ===========================================================================
// REGRESSION: parallel tool_results must NOT be split (SPEC §6.4)
// This test FAILS if runLoop splits the two results into two user messages.
// ===========================================================================

section('pipeline: parallel tool_results go in ONE user message (SPEC §6.4)');

{
  const transport = createReplayTransport(PARALLEL_TOOLS);
  const events = [];
  let loopError = null;

  try {
    await runLoop(transport, (ev) => events.push(ev), {
      prompt: 'Call two tools in parallel.',
      tools: [
        { name: 'current_time', description: '', input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false }, strict: true },
        { name: 'list_directory', description: '', input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false }, strict: true },
      ],
    });
  } catch (e) {
    loopError = e;
  }

  if (loopError?.message?.includes('NotImplemented')) {
    ok('FAIL (loop not implemented): parallel tool_results not yet verifiable', false);
  } else {
    ok('loop ran without error', loopError === null);

    // The second request must have ONE user message containing TWO tool_results.
    // transport.sentRequests[1] is the request sent after the parallel turn.
    const secondReq = transport.sentRequests[1];
    const messages = secondReq?.messages ?? [];
    // Find the last user message added (after the first assistant turn)
    const userMsgsAfterTurn1 = messages.filter((m, i) => {
      const firstAssistantIdx = messages.findIndex((m2) => m2.role === 'assistant');
      return i > firstAssistantIdx && m.role === 'user';
    });

    ok('exactly one user message after the parallel turn',
      userMsgsAfterTurn1.length === 1);

    const toolResultCount = userMsgsAfterTurn1[0]?.content?.filter((b) => b.type === 'tool_result').length ?? 0;
    eq('that message contains exactly 2 tool_result blocks', toolResultCount, 2);
  }
}

// ===========================================================================
// Refusal fixture
// ===========================================================================

section('pipeline: refusal is handled without retry (SPEC §6.5)');

{
  const transport = createReplayTransport(REFUSAL);
  const events = [];
  let loopError = null;

  try {
    await runLoop(transport, (ev) => events.push(ev), {
      prompt: 'Harmful request.',
      tools: [],
    });
  } catch (e) {
    loopError = e;
  }

  if (loopError?.message?.includes('NotImplemented')) {
    ok('SKIP (loop not implemented): refusal handling', false);
  } else {
    ok('loop ran without error', loopError === null);
    // The loop should emit a stop event for the refusal, not retry.
    const stopEvents = events.filter((e) => e.type === 'stop');
    ok('stop event is emitted', stopEvents.length >= 1);
    ok('no second request was sent (no retry)', transport.sentRequests.length === 1);
  }
}

// ===========================================================================
// Iteration cap fixture
// ===========================================================================

section('pipeline: iteration cap trips and emits cap event (SPEC §6.3)');

{
  const transport = createReplayTransport(ITERATION_CAP);
  const events = [];
  let loopError = null;

  try {
    await runLoop(transport, (ev) => events.push(ev), {
      prompt: 'Call a tool repeatedly.',
      tools: [{ name: 'current_time', description: '', input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false }, strict: true }],
      caps: { maxIterations: 3, maxToolCalls: 40, tokenBudget: 200000, wallClockMs: 120000, callTimeoutMs: 5000 },
    });
  } catch (e) {
    loopError = e;
  }

  if (loopError?.message?.includes('NotImplemented')) {
    ok('SKIP (loop not implemented): cap handling', false);
  } else {
    ok('loop ran without error', loopError === null);
    const capEvents = events.filter((e) => e.type === 'cap');
    ok('cap event is emitted', capEvents.length >= 1);
    const runEndEvents = events.filter((e) => e.type === 'run_end');
    ok('run_end is emitted', runEndEvents.length >= 1);
    ok('run_end.completed is false', runEndEvents[0]?.data?.completed === false);
  }
}

// ===========================================================================
// REGRESSION: path traversal and symlink escape must fail (SPEC §4.2, §13.1)
// This test FAILS if the escape succeeds.
// ===========================================================================

section('sandbox: path traversal rejected (SPEC §4.2)');

{
  const tmp = await attemptAsync(() => mkdtemp(join(tmpdir(), 'mcp-test-')), null);
  if (!tmp) {
    ok('SKIP: could not create temp dir', false);
  } else {
    const realRoot = await realpath(tmp);

    ok('../ traversal is rejected', await attemptAsync(async () => {
      try { await resolveSafe(realRoot, '../../etc/passwd'); return false; }
      catch (e) { return e.code === 'SANDBOX' || e.code === 'EINVAL'; }
    }, false));

    ok('absolute path is rejected', await attemptAsync(async () => {
      try { await resolveSafe(realRoot, '/etc/passwd'); return false; }
      catch (e) { return e.code === 'SANDBOX' || e.code === 'EINVAL'; }
    }, false));

    ok('NUL byte is rejected', await attemptAsync(async () => {
      try { await resolveSafe(realRoot, 'a\0b'); return false; }
      catch (e) { return e.code === 'SANDBOX' || e.code === 'EINVAL'; }
    }, false));

    ok('sibling path is rejected', await attemptAsync(async () => {
      try { await resolveSafe(realRoot, '..' + sep + 'sibling'); return false; }
      catch (e) { return e.code === 'SANDBOX' || e.code === 'EINVAL'; }
    }, false));

    ok('valid path inside root resolves without error (or ENOENT)', await attemptAsync(async () => {
      try { await resolveSafe(realRoot, 'some-file.txt'); return true; /* ENOENT is fine */ }
      catch (e) { return e.code === 'ENOENT'; } // file doesn't exist but path is valid
    }, false));

    await attemptAsync(() => rm(tmp, { recursive: true, force: true }));
  }
}

section('sandbox: symlink pointing outside root is rejected (SPEC §4.2, §13.1)');
// This test FAILS if resolveSafe allows reading through a symlink outside root.
// On Windows, creating symlinks requires Developer Mode or elevation.
// Per SPEC §13.1: FAIL with reason rather than skip — a silently skipped
// security test is worse than a red one.

{
  let tmp = null;
  let outside = null;
  let symErr = null;

  try {
    tmp = await mkdtemp(join(tmpdir(), 'mcp-sandbox-'));
    outside = await mkdtemp(join(tmpdir(), 'mcp-outside-'));

    // Write a file outside the root
    await writeFile(join(outside, 'secret.txt'), 'SECRET CONTENT');

    // Create a symlink inside the root pointing outside
    await symlink(outside, join(tmp, 'escape'));
  } catch (e) {
    symErr = e;
  }

  if (symErr) {
    // Per SPEC §13.1: report FAIL with reason, do not silently skip.
    ok(`FAIL: symlink creation failed (${symErr.code ?? symErr.message}). On Windows, symlinks require Developer Mode or elevation.`, false);
  } else {
    const realRoot = await realpath(tmp);

    // Attempt to read through the symlink — must be rejected.
    const escaped = await attemptAsync(async () => {
      try {
        await resolveSafe(realRoot, 'escape/secret.txt');
        return true; // resolveSafe did NOT reject — the escape succeeded
      } catch (e) {
        return false; // resolveSafe rejected — correct behaviour
      }
    }, true);

    ok('symlink escape is rejected by resolveSafe', escaped === false);
    ok('escape via symlink does not resolve to outside path', !escaped);
  }

  if (tmp) await attemptAsync(() => rm(tmp, { recursive: true, force: true }));
  if (outside) await attemptAsync(() => rm(outside, { recursive: true, force: true }));
}

finish();

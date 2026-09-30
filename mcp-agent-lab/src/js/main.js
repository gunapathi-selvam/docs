// Orchestrator: wiring, run start, replay toggle, readouts. SPEC §9
//
// Does not execute at module load. Call init() to wire the DOM.
// Tests set globalThis.__MCP_TEST__ = true before importing so the bottom-of-
// file auto-init is skipped, then call init(doc) with a fake document.

import { createTimeline, appendEvent, renderTimeline } from './timeline.js';
import { toClaudeTools, McpClient } from './mcpClient.js';
import { runLoop } from './agent.js';
import { createClaudeClient, NoKeyError } from './claude.js';

// Cost rates §12 (claude-opus-5-5 rates, cache-write rate unverified — see SPEC §12)
const RATES = { inputPerMTok: 4.00, outputPerMTok: 20.00, cacheReadPerMTok: 0.20, cacheWritePerMTok: 5.00 };

export function init(doc) {
  const $ = (id) => doc.getElementById(id);

  const promptEl         = $('prompt');
  const runBtn           = $('run-btn');
  const stopBtn          = $('stop-btn');
  const timelineEl       = $('timeline');
  const detailPane       = $('detail-pane');
  const detailSection    = $('detail-section');
  const toolInventory    = $('tool-inventory');
  const replayBanner     = $('replay-banner');
  const replayReason     = $('replay-reason');
  const fixtureList      = $('fixture-list');
  const failureEl        = $('failure');
  const failureTitle     = $('failure-title');
  const failureBody      = $('failure-body');
  const effortSelect     = $('effort-select');
  const toolChoiceSelect = $('tool-choice-select');
  const rTurns           = $('r-turns');
  const rToolCalls       = $('r-tool-calls');
  const rInputTokens     = $('r-input-tokens');
  const rOutputTokens    = $('r-output-tokens');
  const rCacheRead       = $('r-cache-read');
  const rCacheWrite      = $('r-cache-write');
  const rCost            = $('r-cost');
  const rElapsed         = $('r-elapsed');
  const copyBtn          = $('copy-btn');

  const mcpClient    = new McpClient({ base: '' });
  const claudeClient = createClaudeClient({ base: '' });

  let timeline      = createTimeline();
  let claudeTools   = [];
  let runActive     = false;
  let stopFn        = null;   // set during a run to allow stopping via the transport

  // ---- failure display ----

  function showFailure(title, body) {
    if (failureEl)    { failureEl.hidden = false; }
    if (failureTitle) { failureTitle.textContent = title; }
    if (failureBody)  { failureBody.textContent = body; }
  }
  function hideFailure() {
    if (failureEl) failureEl.hidden = true;
  }

  // ---- readout ----

  function updateReadout(s) {
    const fmt = (n) => (n == null ? '—' : n.toLocaleString());
    if (rTurns)        rTurns.textContent        = fmt(s.turns);
    if (rToolCalls)    rToolCalls.textContent    = fmt(s.toolCalls);
    if (rInputTokens)  rInputTokens.textContent  = fmt(s.inputTokens);
    if (rOutputTokens) rOutputTokens.textContent = fmt(s.outputTokens);
    if (rCacheRead)    rCacheRead.textContent     = fmt(s.cacheRead);
    if (rCacheWrite)   rCacheWrite.textContent    = fmt(s.cacheWrite);
    if (rElapsed)      rElapsed.textContent       = s.elapsed != null ? `${(s.elapsed / 1000).toFixed(1)}s` : '—';
    if (rCost && s.inputTokens != null) {
      const c = (s.inputTokens  / 1e6) * RATES.inputPerMTok
              + (s.outputTokens / 1e6) * RATES.outputPerMTok
              + ((s.cacheRead  ?? 0) / 1e6) * RATES.cacheReadPerMTok
              + ((s.cacheWrite ?? 0) / 1e6) * RATES.cacheWritePerMTok;
      rCost.textContent = `~$${c.toFixed(4)}`;
    }
  }

  // ---- tool inventory ----

  async function loadTools() {
    try {
      await mcpClient.initialize();
      const raw = await mcpClient.listTools();
      claudeTools = toClaudeTools(raw);
      if (!toolInventory) return;
      if (claudeTools.length === 0) {
        toolInventory.innerHTML = '<li class="tool-empty">No tools available.</li>';
        return;
      }
      // Built as DOM rather than interpolated into innerHTML. Tool names and
      // descriptions arrive from whichever MCP server is bridged, which is
      // untrusted input by design — a description containing markup would
      // otherwise execute in this page.
      toolInventory.replaceChildren(...claudeTools.map((t) => {
        const li = document.createElement('li');
        li.className = 'tool-item';

        const name = document.createElement('span');
        name.className = 'tool-name';
        name.textContent = t.name;

        const badge = document.createElement('span');
        // The base `badge` class carries the padding and inline-block; the
        // variant only sets colour. Omitting it leaves the label butted up
        // against the description with no gap.
        badge.className = `badge ${t.strict ? 'badge-strict' : 'badge-degraded'}`;
        badge.textContent = t.strict ? 'strict' : 'degraded';
        badge.title = t.strict ? 'strict: true' : (t.degradedReason ?? '');

        const desc = document.createElement('span');
        desc.className = 'tool-desc';
        desc.textContent = t.description ?? '';

        li.append(name, badge, desc);
        return li;
      }));
    } catch (err) {
      // Same untrusted-input path as the success branch above: this message can
      // carry text from the bridged MCP server, so it is set as text, not markup.
      if (toolInventory) {
        const li = document.createElement('li');
        li.className = 'tool-empty';
        li.textContent = `Could not load tools: ${err?.message ?? err}`;
        toolInventory.replaceChildren(li);
      }
    }
  }

  // ---- replay mode ----

  function enterReplayMode(reason, fixtures) {
    if (replayBanner) replayBanner.hidden = false;
    if (replayReason) replayReason.textContent = reason ?? 'No API key set.';
    if (!fixtureList) return;
    fixtureList.innerHTML = '';
    for (const name of (fixtures ?? [])) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'fixture-btn';
      btn.textContent = name;
      btn.addEventListener('click', () => startReplay(name));
      fixtureList.appendChild(btn);
    }
  }

  // Fixture data is imported from the tests directory.
  // The path is relative to this module in the browser.
  async function startReplay(name) {
    let fixture;
    try {
      const mod = await import('../../tests/fixtures.mjs');
      const map = { 'single-tool': mod.SINGLE_TOOL, 'parallel-tools': mod.PARALLEL_TOOLS, 'tool-error': mod.TOOL_ERROR, 'refusal': mod.REFUSAL, 'iteration-cap': mod.ITERATION_CAP };
      fixture = map[name];
    } catch (err) {
      showFailure('Fixture load error', err.message);
      return;
    }
    if (!fixture) { showFailure('Unknown fixture', name); return; }

    let ri = 0, ti = 0;
    let stopped = false;
    const replayTransport = {
      async send(req) {
        if (stopped) throw new Error('Run stopped by user');
        const r = fixture.responses[ri++];
        if (!r) throw new Error('Replay fixture ran out of responses');
        return r;
      },
      async callTool(n) {
        const r = fixture.toolResults[ti++];
        return r ?? { content: [{ type: 'text', text: `(no fixture result for ${n})` }], isError: false };
      },
    };
    stopFn = () => { stopped = true; };
    await doRun(replayTransport, `[Replay: ${name}]`);
  }

  // ---- run lifecycle ----

  async function doRun(transport, promptOverride) {
    if (runActive) return;
    runActive = true;
    hideFailure();

    // Reset timeline
    if (timelineEl) timelineEl.innerHTML = '';
    timeline = createTimeline();
    timeline.runId  = `run_${Date.now()}`;
    timeline.startTime = Date.now();

    const stats = { turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, elapsed: null };
    updateReadout(stats);

    if (runBtn)  runBtn.setAttribute('disabled', 'true');
    if (stopBtn) stopBtn.removeAttribute('disabled');

    const prompt         = promptOverride ?? promptEl?.value ?? '';
    const effort         = effortSelect?.value ?? 'medium';
    const toolChoiceType = toolChoiceSelect?.value ?? 'auto';

    try {
      await runLoop(transport, (ev) => {
        const full = appendEvent(timeline, ev);
        renderTimeline(timeline, timelineEl, (selected) => {
          if (detailPane)    detailPane.textContent = JSON.stringify(selected.data, null, 2);
          if (detailSection) detailSection.hidden   = false;
        });
        // Update readout from events.
        if (ev.type === 'usage') {
          stats.inputTokens  = (stats.inputTokens  ?? 0) + (ev.data.input_tokens  ?? 0);
          stats.outputTokens = (stats.outputTokens ?? 0) + (ev.data.output_tokens ?? 0);
          stats.cacheRead    = (stats.cacheRead    ?? 0) + (ev.data.cache_read_input_tokens   ?? 0);
          stats.cacheWrite   = (stats.cacheWrite   ?? 0) + (ev.data.cache_creation_input_tokens ?? 0);
        }
        if (ev.type === 'stop')        stats.turns++;
        if (ev.type === 'tool_result') stats.toolCalls++;
        if (ev.type === 'run_end')     stats.elapsed = ev.data.wallMs;
        updateReadout(stats);
      }, { prompt, effort, toolChoiceType, tools: claudeTools });
    } catch (err) {
      // Every failure routes here — never a dead UI. SPEC §11
      showFailure('Run failed', err.message);
    } finally {
      runActive = false;
      stopFn = null;
      if (runBtn)  runBtn.removeAttribute('disabled');
      if (stopBtn) stopBtn.setAttribute('disabled', 'true');
    }
  }

  // Live transport: uses claude.js streaming (assembled) + mcpClient.
  function makeLiveTransport() {
    let stopped = false;
    stopFn = () => { stopped = true; };
    return {
      async send(req) {
        if (stopped) throw new Error('Run stopped by user');
        return claudeClient.send(req, null);
      },
      async callTool(name, input) {
        if (stopped) throw new Error('Run stopped by user');
        return mcpClient.callTool(name, input);
      },
    };
  }

  // ---- wire buttons ----

  if (runBtn) {
    runBtn.addEventListener('click', async () => {
      const transport = makeLiveTransport();
      await doRun(transport);
    });
  }

  if (stopBtn) {
    stopBtn.addEventListener('click', () => { if (stopFn) stopFn(); });
  }

  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const text = detailPane?.textContent ?? '';
      if (typeof navigator !== 'undefined') navigator.clipboard?.writeText(text).catch(() => {});
    });
  }

  // ---- initialise ----

  // Check key status; enter replay mode if no key.
  (async () => {
    try {
      const res = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }] }),
      });
      if (res.status === 503) {
        const data = await res.json().catch(() => ({}));
        if (data.kind === 'no_key') {
          enterReplayMode(data.message, data.fixtures ?? []);
        }
      }
    } catch { /* network error — proceed without replay banner */ }
  })();

  loadTools().catch((err) => showFailure('Tool load failed', err.message));
}

if (!globalThis.__MCP_TEST__) {
  init(globalThis.document);
}

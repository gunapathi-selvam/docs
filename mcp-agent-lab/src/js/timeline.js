// Append-only event model and DOM rendering. SPEC §7
//
// The event model is pure (no DOM). renderTimeline touches the DOM and is a
// skeleton. The pure functions are exported for unit tests.

// ---------------------------------------------------------------- event types
// Eleven types, closed. Throwing on unknown catches producer/renderer divergence.

export const EVENT_TYPES = [
  'run_start',
  'request',
  'thinking',
  'text',
  'tool_use',
  'tool_result',
  'usage',
  'stop',
  'cap',
  'error',
  'run_end',
];

let _seq = 0;

// ---------------------------------------------------------------- event model

export function createTimeline() {
  return {
    events: [],
    lastRendered: -1,
    runId: null,
    startTime: null,
  };
}

// Append a typed event. Throws on an unknown type so divergence is visible.
export function appendEvent(timeline, { type, turn, data }) {
  if (!EVENT_TYPES.includes(type)) {
    throw new Error(`Unknown event type: "${type}". EVENT_TYPES is closed — update the producer and renderer together.`);
  }
  const t = timeline.startTime !== null ? Date.now() - timeline.startTime : 0;
  const event = { seq: _seq++, t, type, runId: timeline.runId, turn: turn ?? 0, data: data ?? {} };
  timeline.events.push(event);
  return event;
}

// ---------------------------------------------------------------- pairing

// Pair tool_use events with their tool_result events by tool_use_id. §7.3
// Returns { pairs, unmatchedUses, unmatchedResults } so the renderer can show
// unmatched uses as defect cards — an absence made visible.
export function pairToolResults(events) {
  const uses = events.filter((e) => e.type === 'tool_use');
  const results = events.filter((e) => e.type === 'tool_result');

  const resultByUseId = new Map(
    results.map((r) => [r.data.tool_use_id, r])
  );
  const usedResultIds = new Set();

  const pairs = [];
  const unmatchedUses = [];

  for (const use of uses) {
    const result = resultByUseId.get(use.data.id);
    if (result) {
      pairs.push({ use, result });
      usedResultIds.add(use.data.id);
    } else {
      unmatchedUses.push(use);
    }
  }

  const unmatchedResults = results.filter(
    (r) => !usedResultIds.has(r.data.tool_use_id)
  );

  return { pairs, unmatchedUses, unmatchedResults };
}

// ---------------------------------------------------------------- DOM rendering

// Renders events from lastRendered + 1 and appends to container. §7.4
export function renderTimeline(timeline, container, onSelect) {
  const start = timeline.lastRendered + 1;
  for (let i = start; i < timeline.events.length; i++) {
    appendNode(container, timeline.events[i], onSelect);
  }
  timeline.lastRendered = timeline.events.length - 1;
}

// Create a <li><button aria-expanded> card for one event. §9, §9.1
export function appendNode(container, event, onSelect) {
  const li = document.createElement('li');
  li.className = `tl-item tl-item--${event.type}`;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tl-card';
  btn.setAttribute('aria-expanded', 'false');

  const titleEl = document.createElement('span');
  titleEl.className = 'tl-title';
  titleEl.textContent = _cardTitle(event);

  const metaEl = document.createElement('span');
  metaEl.className = 'tl-meta';
  if (event.t != null) metaEl.textContent = `t+${event.t}ms`;

  btn.appendChild(titleEl);
  btn.appendChild(metaEl);

  btn.addEventListener('click', () => {
    const was = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!was));
    if (onSelect) onSelect(event);
  });

  li.appendChild(btn);
  container.appendChild(li);
}

function _cardTitle(event) {
  switch (event.type) {
    case 'run_start':   return 'Run started';
    case 'request':     return `Request (turn ${event.turn})`;
    case 'thinking':    return 'Thinking';
    case 'text':        return event.data.final ? 'Final answer' : 'Text';
    case 'tool_use':    return `Tool: ${event.data.name ?? '?'}`;
    case 'tool_result': return `Result ${event.data.is_error ? '(error)' : '(ok)'}: ${event.data.tool_use_id ?? '?'}`;
    case 'usage':       return `Usage: in=${event.data.input_tokens ?? 0} out=${event.data.output_tokens ?? 0}`;
    case 'stop':        return `Stop: ${event.data.stop_reason ?? '?'}`;
    case 'cap':         return `Cap: ${event.data.cap ?? '?'}`;
    case 'error':       return `Error: ${event.data.kind ?? 'unknown'}`;
    case 'run_end':     return event.data.completed ? 'Run complete' : `Run stopped (${event.data.reason ?? '?'})`;
    default:            return event.type;
  }
}

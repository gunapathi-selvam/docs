# MCP Agent Lab — Feature Document

**Version** 1.0 · **Date** 2026-09-30 · **Status** Draft (unimplemented)

The feature-oriented view. For protocol details, field allowlists and rationale
see [spec/SPEC.md](spec/SPEC.md). For what to build next see [CLAUDE.md](CLAUDE.md).

---

## What it is

A zero-install web page that drives an agent loop against Claude using a
hand-written MCP server over stdio, and renders every step as an inspectable
timeline. Each event — the request, a thinking summary, a tool call with
parsed arguments, a tool result, and the final answer — is a card that expands
to the raw JSON that crossed the wire. The visualiser exists because an agent
loop is otherwise entirely opaque: a request goes in, some time passes, an
answer comes back, and nothing in between is visible.

Third in the series after galaxy-spiral and webgpu-particles. Those projects
made real-time pipelines observable by drawing things on screen; this one
applies the same instinct to an AI reasoning loop.

---

## Feature inventory

### The MCP server

| Detail | Value |
|---|---|
| Transport | stdio, newline-delimited JSON-RPC 2.0 |
| Tools | `read_text_file`, `list_directory`, `search_files`, `current_time` |
| Sandboxing | Three-stage: normalise, prefix-check, realpath re-check (SPEC §4.2) |
| SDK dependency | None — hand-written against the protocol |
| Standalone mode | `npm run mcp` — pipeable for manual testing (SPEC §3.6) |

### The four tools

| Tool | Key constraint |
|---|---|
| `read_text_file` | Capped at `max_bytes` with an explicit `[truncated]` marker; refuses non-UTF-8 |
| `list_directory` | Reports symlinks as `symlink`, does not follow them for listing |
| `search_files` | Literal substring, case-insensitive, not a regex (SPEC §3.5) |
| `current_time` | No filesystem surface; exists for parallel-call fixtures |

All paths are relative to `MCP_ROOT` and blocked from escaping it. Symlink
attacks require `realpath` re-check; a prefix-only check does not stop a
symlink that points outside the root. SPEC §4.2

### Path sandboxing (three stages)

| Stage | Operation | What it catches |
|---|---|---|
| 1 | Pure string normalisation | NUL bytes, absolute paths, traversal strings |
| 2 | Prefix check on joined path | Sibling directories (the `root` vs `root-evil` bug) |
| 3 | `realpath` + prefix re-check | Symlinks pointing outside the root |

### The Claude proxy (`/api/claude`)

| Field | Handling |
|---|---|
| `messages` | Forwarded; last entry must not be `role: "assistant"` |
| `system` | Forwarded if string or text-block array |
| `tools` | Forwarded; every `name` must appear in `tools/list` |
| `tool_choice` | Only `{ type: "auto" }` or `{ type: "none" }`. `any`/`tool` → 400 |
| `thinking` | Only `{ type: "adaptive", display: "summarized" }` or omitted |
| `output_config.effort` | `low`/`medium`/`high`/`xhigh`/`max` |
| `model` | Never from the client; set server-side from `MODEL` env |
| Unknown fields | 400, naming the offending key |

Binds to `127.0.0.1` by default. Rejects `Origin` headers outside the
configured host. Body capped at 1 MiB. SPEC §4.1

### The agent loop

| Detail | Value |
|---|---|
| Termination condition | `stop_reason !== 'tool_use'` |
| Max iterations | 12 assistant turns |
| Max tool calls | 40 total executions |
| Token budget | 200 000 cumulative input + output |
| Wall-clock cap | 120 000 ms (2 minutes) |
| Per-call timeout | 5 000 ms (returns `is_error: true`, loop continues) |
| Parallel results | All `tool_result` blocks for one turn in a single user message |
| Content echoed | Full assistant `content` array including thinking blocks |

### The timeline

| Event type | Emitted when |
|---|---|
| `run_start` | A run begins |
| `request` | Before each API call |
| `thinking` | A thinking block completes |
| `text` | A text block completes |
| `tool_use` | A tool_use block completes |
| `tool_result` | A tool returns |
| `usage` | A turn's usage is known |
| `stop` | A turn ends |
| `cap` | A cap trips |
| `error` | A transport or API error |
| `run_end` | The run finishes |

Append-only. Replay mode feeds the same event array into the same renderer —
no replay-specific code path. SPEC §7.3, §8.2

### The UI

| Region | Contents |
|---|---|
| Prompt area | Textarea, effort selector (`low`/`medium`/`high`), tool-choice selector (`auto`/`none`), Run, Stop |
| Replay banner | Persistent bar naming the mode and listing available fixtures |
| Timeline | One card per event, colour-coded by type, keyboard-navigable |
| Detail pane | Raw JSON of the selected event, copy button |
| Tool inventory | `tools/list` result with `strict`/`degraded` badge per tool |
| Readout | Turns, tool calls, tokens, cache read/write, estimated cost, elapsed |

### Accessibility

- Timeline is `<ol role="list">` with `<button aria-expanded>` cards
- `aria-live="polite"` on the readout; `assertive` reserved for failure and cap
  banner
- `prefers-reduced-motion` removes card-entry animation
- Visible focus rings on every interactive element (`:focus-visible`, 2 px)

### Replay mode

Entering replay mode: no key → 503 → banner. Or `?replay=<name>` explicitly.
Five fixtures: `single-tool`, `parallel-tools`, `tool-error`, `refusal`,
`iteration-cap`. Replay drives the real loop, so a split `tool_result` message
is caught by the same path as a live run. SPEC §8

### Testing

Four suites, no dependencies, no browser, no key, no network.

| Suite | Layer |
|---|---|
| `unit` | Schema mapping, timeline model, path sandbox, MCP framing |
| `boot` | DOM wiring against a fake DOM parsed from `index.html`; replay mode |
| `pipeline` | Real loop against fixtures; parallel result split; symlink escape; forced tool_choice |

---

## Deliberate non-goals

**No MCP SDK.** The point is the wire format. Importing an SDK would hide
exactly the thing being taught. The cost is a subset of the protocol; that
subset is documented in SPEC §14. SPEC §1.2

**Not a chat app.** One prompt box, one run. Conversation history across runs
and persistence are out of scope. The subject is a single loop rendered
completely. SPEC §1.2

**Not a general MCP client.** The server is spawned by `server.js` and
sandboxed. Connecting to third-party MCP servers is a backlog item with its
own trust problems. SPEC §1.2

**`search_files` is literal substring only.** A model-supplied regex is an
unbounded input to a backtracking engine. `(a+)+$` against a long line is a
denial of service. Regex mode is a backlog item requiring a linear-time engine.
SPEC §3.5

**No TOCTOU defence.** Between the `realpath` check and the `open`, another
process can swap a component for a symlink. Closing this needs `O_NOFOLLOW` per
path component, which Node does not expose. The exposure is documented, not
assumed away. SPEC §4.2

**Cost is an estimate.** Computed from `usage` fields, not from billing.
Cache-write pricing (1.25× input) is from documentation, not verified against
an invoice. The readout labels it as an estimate. SPEC §12

---

## Known gap

The suite proves nothing about live API shape. Every API fact in the spec is
asserted against a hand-written fixture, so a fixture that encodes a wrong
belief passes. **Green tests plus a 400 from the real API is an expected state,
not a contradiction.** Closing it needs a keyed smoke test, which is in the
backlog.

`search_files` stops at `max_results` to bound `tool_result` size, but a
result large enough to fill the context window from a single search is still
possible. The token budget cap is the backstop.

---

## Backlog

- Keyed smoke test (opt-in via env) asserting the SPEC §6.1 request shape is
  accepted — closes the most important gap in §13.2
- Export a run as a fixture with one click, replacing hand-written fixtures
- Connect an arbitrary MCP server by command line (with the trust conversation
  that requires)
- Side-by-side diff of two runs' event arrays — free given append-only
- Streaming `/api/mcp` over SSE for server-initiated notifications
- Write tools behind an explicit confirmation gate
- Regex mode for `search_files` on a linear-time engine
- Cross-run history (comparing runs needs two tabs today)

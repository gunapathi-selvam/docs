# MCP Agent Lab — Claude Session Context

Read this first. It tells you what the project is, what is decided, and what to
build next. The authoritative detail is in [spec/SPEC.md](spec/SPEC.md) — this
file is the map, not the territory.

## Goal

Run an agent loop against Claude using a hand-written MCP server over stdio,
and render every step as an inspectable timeline: the request, the thinking
summary, each tool_use block with its arguments, each tool_result, and the
final answer. Every node expands to the raw JSON that crossed the wire. The
visualiser is the lesson — an agent loop is otherwise entirely opaque.

## Stack

- Vanilla JS ES modules, no build step
- Node server (`server.js`) acts as static host, Claude API proxy, and MCP
  subprocess bridge
- `@anthropic-ai/sdk` on the Node side only — never in the browser
- Hand-written MCP server (`mcp/server.mjs`) against the protocol, no SDK —
  the wire format is the thing being taught
- Node built-in test runner via `node tests/run.mjs`

## Key design decisions

Each of these was decided deliberately; do not "fix" them without reading the
cited section first.

- **The browser never holds the API key.** `server.js` reads
  `ANTHROPIC_API_KEY` from `process.env` and proxies requests. No key, no
  browser-side `api.anthropic.com` call. Ever. SPEC §2.2, §4.1
- **Forced tool use is removed on this model.** `tool_choice: { type: "any" }`
  and `{ type: "tool", name: "..." }` return HTTP 400. Only `auto` and `none`
  are forwarded. The proxy rejects anything else with a named 400. SPEC §6.1
- **All `tool_result` blocks for one turn go in a single user message.**
  Splitting them does not error — it silently trains the model to stop issuing
  parallel calls. `buildToolResultMessage` has no code path that returns more
  than one message. SPEC §6.4
- **`thinking: { type: 'adaptive', display: 'summarized' }` must be set, or
  thinking blocks arrive with empty text.** The default is `omitted`, which
  still bills but returns blank strings. A blank thinking card looks like a
  rendering bug; it is correct rendering of an empty string. If you see empty
  thinking nodes, check this field before debugging `timeline.js`. SPEC §6.1
- **`strict: true` is a top-level field on the tool definition, not on
  `tool_choice`.** Placing it on `tool_choice` is a 400. SPEC §5.1
- **MCP path sandboxing resolves symlinks, not just prefix-checks.** A prefix
  check is a string operation; a symlink is a filesystem fact. Three stages:
  normalise and reject, prefix-check on the joined path, then `realpath` and
  re-check. SPEC §4.2
- **Tools are sorted by name on both sides** (MCP server and schema mapper) so
  the `tools` block is byte-stable across turns. A reordered tool array is a
  cache miss on every turn. SPEC §3.3, §5.4, §6.7
- **Append-only event model.** Replay and live become the same code path.
  `replayTransport` drives the real loop with fixture data; it does not feed a
  recording into the renderer. SPEC §7.3, §8.2
- **`model` is never taken from the client.** Set server-side from `MODEL`
  env. A client-supplied model is a cost oracle. SPEC §4.1
- **Sandbox refusal is `result.isError: true`, not a JSON-RPC `error`.**
  Code `-32602` tells the model its arguments were malformed, encouraging a
  retry loop that a sandbox refusal should not produce. SPEC §3.4

## The mistakes that are invisible when wrong

These produce no error, no warning, and no visible defect at run time. Tests
in `pipeline.test.mjs` and `unit.test.mjs` cover each one.

1. **Splitting `tool_result` blocks across user messages.** No API error. The
   model stops making parallel calls, the loop gets slower, and nothing in the
   response signals the change. SPEC §6.4
2. **A symlink pointing outside `MCP_ROOT` that passes the prefix check.**
   `normalised` and `joined` look clean; the OS follows the link. Only
   `realpath` + re-check catches it. SPEC §4.2
3. **A reordered `tools` array between turns.** Cache miss on every turn after
   turn 1. `response.usage.cache_read_input_tokens` is 0 on turn 2. SPEC §6.7
4. **Empty thinking nodes.** `display` omitted or set to `omitted`. Correct
   rendering of an empty string that looks like a rendering bug. SPEC §6.1
5. **`strict` on `tool_choice` instead of the tool definition.** 400 at
   request time. SPEC §5.1
6. **A stray `console.log` in `mcp/server.mjs`.** Writes a non-JSON line to
   stdout, which breaks the framing parser in the bridge. All server
   diagnostics must go to stderr. SPEC §3.1

## Commands

| Command | Purpose |
|---|---|
| `node server.js` | Serve at http://localhost:5173 |
| `npm start` | Same as above |
| `npm test` | Run all four suites |
| `npm test -- unit` | Run one suite by substring |
| `npm run mcp` | Run the MCP server alone on stdio (useful for pipe tests) |

## Status

- [x] `spec/SPEC.md` — written
- [x] `FEATURES.md` — written
- [x] `README.md` — written
- [x] Skeleton modules — interfaces throwing NotImplemented, pure functions implemented
- [x] `tests/` — harness, fixtures, and assertions.
- [x] **Implementation complete.** `node tests/run.mjs` → 168 passed, 1 failed.

The one remaining failure is the Windows symlink security test: creating a
symlink requires Developer Mode or elevation on Windows, so the test reports
FAIL with reason `EPERM` rather than silently skipping (SPEC §13.1 requires
this). All pipeline, unit, and boot tests pass.

`node server.js` serves at http://localhost:5173. With no API key it enters
replay mode; click any fixture in the banner to watch the loop run.

## Traps specific to this project

- **`console.log` in `mcp/server.mjs` breaks the framing.** stdout is the
  protocol channel. Use `process.stderr.write(...)` for any diagnostics. The
  failure looks like a parse error on the bridge side, not like a log line.
- **The MCP subprocess is spawned once, not per request.** The `initialize`
  handshake must survive across many `/api/mcp` calls. A per-request spawn
  costs ~40 ms of Node startup and discards the handshake state every time.
- **A trailing assistant turn in `messages` returns 400.** The proxy rejects
  it with a better message than the API's, but the real cause is that
  assistant message prefill is not available on this model. The last message
  must always be a user message. SPEC §6.5
- **`stop_details` is null except for `stop_reason: 'refusal'`.** Reading
  `response.stop_details.category` on a normal `end_turn` throws TypeError.
  Guard on `stop_reason`, not on `stop_details != null`. SPEC §6.5
- **`output_config.effort` is nested, not top-level.** `{ effort: 'medium' }`
  as a top-level field is silently ignored or returns 400. SPEC §6.1
- **The test suite proves nothing about live API shape.** Green tests plus a
  400 from the real API is an expected state. Closing the gap needs a keyed
  smoke test. SPEC §13.2

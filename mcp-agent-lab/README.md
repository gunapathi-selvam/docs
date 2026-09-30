# MCP Agent Lab

An agent loop visualiser. A hand-written MCP server over stdio exposes
sandboxed local tools; a browser UI drives an agent loop against Claude with
those tools bridged in and renders every step as an inspectable timeline: the
request, the thinking summary, each tool call with its arguments, each tool
result, and the final answer. Every card expands to the raw JSON that crossed
the wire.

> **Status: unimplemented.** The specification, feature document, and module
> skeletons are complete; the implementation is not. Tests fail red by design.
> See [CLAUDE.md](CLAUDE.md) for what to build next.

## Quick start

With a key:

```bash
cp .env.example .env
# edit .env and add your key
node server.js          # http://localhost:5173
```

Without a key — replay mode only:

```bash
node server.js          # starts in replay mode, no key needed
```

When `ANTHROPIC_API_KEY` is not set, every Claude request returns a 503 and
the UI switches to replay mode, offering five recorded fixtures. Replay drives
the real loop against pre-recorded responses, so the timeline works and the
code paths that matter are exercised.

```bash
npm test                # four suites, no browser or key required
npm test -- unit        # one suite by substring
npm run mcp             # run the MCP server alone on stdio
```

No dependencies beyond `@anthropic-ai/sdk` on the server side. `npm install`
is required before `node server.js` if the SDK is not present.

## Architecture

```
  browser (no secrets)            Node: server.js                 network
  ────────────────────            ───────────────                 ───────
  index.html                      static files
  src/js/agent.js ── POST /api/claude ──▶  field allowlist
                                            new Anthropic()  ──── HTTPS ──▶ Claude
                                            reads key from env
  src/js/mcpClient.js ── POST /api/mcp ──▶  stdio bridge
                                              │
                                              ▼
                                         mcp/server.mjs  (child process)
                                              │
                                              ▼
                                         mcp/tools.mjs  (sandboxed to MCP_ROOT)
```

The browser never holds `ANTHROPIC_API_KEY` and never calls
`api.anthropic.com`. The proxy field-allowlists every request and sets the
model server-side. An unknown field in the browser body is a named 400.

## Replay mode

`?replay=single-tool` enters replay mode regardless of whether a key is set.
Available fixtures: `single-tool`, `parallel-tools`, `tool-error`, `refusal`,
`iteration-cap`. Replay drives the real loop — the real stop_reason checks,
the real cap counters, the real `buildToolResultMessage` — so a split
`tool_result` message is caught even in replay.

## Layout

| Path | Role |
|---|---|
| [spec/SPEC.md](spec/SPEC.md) | Protocol details, field allowlists, rationale, failure modes |
| [FEATURES.md](FEATURES.md) | Feature inventory, non-goals, known gaps, backlog |
| [CLAUDE.md](CLAUDE.md) | Session context — read this first if picking the project up |
| `mcp/server.mjs` | MCP server: stdio JSON-RPC, initialize, tools/list, tools/call |
| `mcp/tools.mjs` | The four tool implementations and their schemas; path sandbox |
| `src/js/agent.js` | The loop. Pure with respect to I/O — transports injected |
| `src/js/mcpClient.js` | MCP-to-Claude schema mapping; browser client for /api/mcp |
| `src/js/timeline.js` | Append-only event model plus DOM rendering |
| `tests/harness.mjs` | Fake DOM parsed from index.html, fake transports, assertions |
| `tests/fixtures.mjs` | Five recorded transcripts for replay and pipeline tests |

## Configuration

| Parameter | Location | Default |
|---|---|---|
| API key | `ANTHROPIC_API_KEY` env | unset → replay mode |
| Model | `MODEL` env | `claude-opus-5-5` |
| MCP root | `MCP_ROOT` env | project directory |
| Port | `PORT` env | 5173 |
| Bind address | `HOST` env | `127.0.0.1` |

## A note on the tests

The suite runs without a key and without a network connection, which means it
cannot prove the request shape is accepted by the real API. Every API fact is
asserted against a hand-written fixture. **Green tests plus a 400 from the
real API is an expected state, not a contradiction** — closing that gap needs
a keyed smoke test and is in the backlog.

## Series

| Project | Subject |
|---|---|
| [galaxy-spiral](../galaxy-spiral/) | MediaPipe hand tracking, WebGL2, spec-first discipline |
| [webgpu-particles](../webgpu-particles/) | WGSL compute, storage buffers, ping-pong, indirect draw |
| [asl-trainer](../asl-trainer/) | 26-class gesture taxonomy, confusion matrix |
| [rag-notebook](../rag-notebook/) | In-browser embeddings, vector search, Claude synthesis |
| **mcp-agent-lab** | MCP server, agent loop, tool-use visualisation |
| [voice-notes](../voice-notes/) | Local Whisper transcription, Claude summarisation |

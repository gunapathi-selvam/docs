# RAG Notebook

A local-first RAG notebook. Drop markdown or text files onto the page; the app
chunks and embeds them in the browser with a sentence-transformer running on
WebGPU; questions retrieve the top-8 chunks by cosine similarity and go to
Claude for synthesis with citations that are validated, not trusted.

> **Status: unimplemented.** The specification, feature document and module
> skeletons are complete; the implementation is not. Tests fail red by design.
> See [CLAUDE.md](CLAUDE.md) for what to build next.

## Quick start

```bash
node server.js          # http://localhost:5173 — retrieval-only, no key needed
npm test                # three suites, no browser, no GPU, no API key required
npm test -- unit        # one suite by substring
```

No build step. `npm install` is only needed to enable Claude synthesis.

## Enabling Claude synthesis

The API key must be set on the server. It never reaches the browser.

```bash
cp .env.example .env
# Edit .env and add your key:
#   ANTHROPIC_API_KEY=sk-ant-...

# Then start the server with the key in environment:
ANTHROPIC_API_KEY=sk-ant-... node server.js
```

Without the key the app runs in retrieval-only mode: a banner explains the
situation, the Ask button is disabled, and chunking, embedding, and search all
keep working. No key means no API calls and no bill.

## Why the key cannot be in the browser

An API key in client JavaScript is published, not hidden. It is visible in the
Network tab, in the browser cache, and in any CDN in front of the app. Bundling
or encoding does not change this.

`server.js` owns the key. The browser calls `/api/claude` on its own origin.
`boot.test.mjs` asserts that every `fetch` the app makes is a same-origin path —
if that test fails, the architecture was broken.

## Architecture

```
  browser                          server.js (same origin)
  ───────────────────────────      ────────────────────────────
  drop file
      │
      ▼
  chunker.js  ──▶  embedder.js     POST /api/claude
      │            (WebGPU|wasm)       allowlist check
      ▼                 │              key from process.env
  vectorStore.js    IndexedDB          forward to Anthropic
  (cosine + topK)
      │
      ▼
  claude.js   ──▶  /api/claude  ──▶  api.anthropic.com
      │
      ▼
  citations.js  ──▶  answer pane + citation chips
```

Document text and vectors never leave the device. Only the eight retrieved
chunks and the question cross the network.

## Layout

| Path | Role |
|---|---|
| [spec/SPEC.md](spec/SPEC.md) | Chunking parameters, proxy allowlist, caching order, failure modes — authoritative |
| [FEATURES.md](FEATURES.md) | Feature inventory, non-goals, known gaps, backlog |
| [CLAUDE.md](CLAUDE.md) | Session context — read this first if you are picking the project up |
| `server.js` | Static files + `/api/claude` proxy (key lives here only) |
| `src/js/chunker.js` | Pure: heading-aware markdown chunker with offsets |
| `src/js/embedder.js` | Transformers.js lifecycle, WebGPU with wasm fallback |
| `src/js/vectorStore.js` | Pure cosine math + IndexedDB persistence |
| `src/js/claude.js` | Pure `assembleRequest` + SSE streaming client |
| `src/js/citations.js` | Pure citation parsing and validation |
| `tests/harness.mjs` | Fake DOM, fake fetch, assertion helpers |

## A note on the tests

The suite runs without a browser, GPU, network, or API key. Three layers are
covered by contract rather than by execution: the real embedding model, real
IndexedDB, and the proxy itself. Green tests do not prove a pixel is correct —
they prove that the pure functions have the right shape, that the markup has the
right IDs, and that the prompt has the right field order. Closing the remaining
gaps is in the backlog.

## Series

| Project | Subject |
|---|---|
| [galaxy-spiral](../galaxy-spiral/) | MediaPipe hand tracking, WebGL2, spec-first discipline |
| [webgpu-particles](../webgpu-particles/) | WGSL compute, storage buffers, ping-pong, indirect draw |
| [asl-trainer](../asl-trainer/) | 26-class gesture taxonomy, confusion matrix |
| **rag-notebook** | In-browser embeddings, vector search, Claude synthesis |
| [mcp-agent-lab](../mcp-agent-lab/) | MCP server, agent loop, tool-use visualisation |
| [voice-notes](../voice-notes/) | Local Whisper transcription, Claude summarisation |

# RAG Notebook — Claude Session Context

Read this first. It tells you what the project is, what is decided, and what to
build next. The authoritative detail is in [spec/SPEC.md](spec/SPEC.md) — this
file is the map, not the territory.

---

## Goal

A local-first RAG notebook. Markdown files are chunked and embedded entirely in
the browser via Transformers.js on WebGPU; vectors live in memory plus IndexedDB;
questions retrieve top-k chunks by cosine similarity and go to Claude for
synthesis with citations that are checked, not trusted.

---

## THE API KEY NEVER REACHES THE BROWSER

This is the load-bearing architectural decision of the project. SPEC §3.1.

`ANTHROPIC_API_KEY` is read by `server.js` from `process.env`. It is never
exported, never sent in a response, never logged. The browser calls `/api/claude`
on its own origin. `server.js` owns the key, constructs the outbound request,
and speaks to `api.anthropic.com`. There is no path — no bundling, no encoding,
no indirection — that puts the key in client JavaScript.

`boot.test.mjs` asserts that every `fetch` the app makes is a same-origin path.
That test failing means the architecture was broken.

---

## Stack

- Vanilla JS ES modules, no build step, no bundler
- Transformers.js (from jsDelivr CDN, cached by service worker) for embeddings
- WebGPU (wasm fallback) via Transformers.js ONNX Runtime
- `@anthropic-ai/sdk` on the server only — never imported by any browser module
- Node built-in test runner via `node tests/run.mjs`
- Static + proxy server on port 5173

---

## Key design decisions

Each of these was decided deliberately. Do not change them without reading the
cited spec section first.

- **The proxy constructs, not forwards.** Forwarding an arbitrary client body
  to a paid API is an open relay. The proxy builds the outbound request from a
  fixed allowlist of seven fields. SPEC §3.3
- **Unknown proxy fields are a 400, not a drop.** Silent dropping makes a client
  sending `temperature` appear to work while its parameter is discarded. Loud
  failure keeps client and proxy honest. SPEC §3.3
- **`cosine()` keeps the division even though vectors are normalised.** A future
  un-normalising model degrades quality instead of acquiring a length bias.
  Costs one divide per comparison. SPEC §6.1
- **Brute force, with the ceiling calculated.** 8 000 chunks exceeds what a
  personal notebook holds. HNSW would be machinery bought ahead of need. SPEC §6.2
- **Heading-aware chunking with a character ceiling.** Fixed windows destroy
  structure; pure heading splits produce unusable extremes; the character ceiling
  is computable before the tokeniser loads. SPEC §4.1
- **Citations validated against the retrieved set, not the store.** Validating
  against the store admits the most interesting fabrication: a plausible chunk ID
  recalled from the cached corpus manifest (§8.3). SPEC §9.2
- **Prompt caching: stable prefix first, volatile last.** Render order is
  `system` then `messages`. INSTRUCTIONS go in `system[0]`, manifest in `system[1]`
  with the `cache_control` breakpoint, chunks and question in messages. SPEC §8.3
- **`thinking: {type:"adaptive"}` only.** `{type:"disabled"}` returns 400 from
  the API. `budget_tokens` returns 400 on this model. The proxy rejects both
  locally with a clear message. SPEC §8.2
- **`model: "claude-opus-5-5"` is pinned server-side.** Any other string,
  including a date-suffixed variant, is a 400. The model is a server decision.
  SPEC §3.3
- **Float32 vectors in 1.0.** At 8 000 chunks the storage saving from int8 is
  9 MB — not worth a recall regression. int8 is slower in scalar JS too. SPEC §6.5

---

## The four guards that are invisible when wrong

These fail silently, with no error, no warning, and often no obviously wrong
output. `pipeline.test.mjs` asserts two of them structurally.

1. **Volatile content before stable prefix.** Placing chunks or the question in
   `system` instead of `messages` invalidates the cache on every query. The
   tokens are re-read and the bill arrives anyway. Detectable only from
   `usage.cache_read_input_tokens === 0` across repeated questions.
2. **Allowlist widening.** Adding a field to `assembleRequest` that the proxy
   rejects silently (instead of loudly) creates an open relay. `pipeline.test.mjs`
   asserts the body has exactly seven keys.
3. **Cosine without the division.** On a future un-normalised model, dot product
   over un-normalised vectors ranks by magnitude as well as direction. Long chunks
   are systematically preferred, silently, because the scores are still plausible.
4. **Validating citations against the store instead of the retrieved set.** Lets
   through the most dangerous fabrication: a model citing a chunk it has seen in
   the manifest but never retrieved. The result validates and looks correct.

---

## Commands

| Command | Purpose |
|---|---|
| `node server.js` | Serve at http://localhost:5173 |
| `ANTHROPIC_API_KEY=sk-ant-... node server.js` | Serve with Claude synthesis enabled |
| `npm test` | Run all three suites |
| `npm test -- unit` | Run one suite by substring |

---

## Status

- [x] `spec/SPEC.md` — written
- [x] `FEATURES.md` — written
- [x] `README.md` — written
- [x] `src/js/` — all modules fully implemented; no `NotImplemented` stubs remain
- [x] `tests/` — **160 pass, 0 fail** (43 assertions added covering the newly implemented code)
- [x] `server.js` — `/` and `/src/js/main.js` return 200; `POST /api/claude` returns 503 `no_api_key` when key absent
- [x] **Implementation complete.**

All eight previously unimplemented functions are now live:

| Module | Implemented |
|---|---|
| `embedder.js` | `createEmbedder` — loads Transformers.js from jsDelivr, tries WebGPU, falls back to wasm, batches embed in 32, verifies L2 norm |
| `vectorStore.js` | `openStore`, `putDocument`, `loadCorpus`, `removeDocument`, `invalidateVectors` |
| `claude.js` | `ask` — POSTs to `/api/claude`, parses SSE frames, dispatches `onText`/`onThinking`, maps proxy errors |
| `main.js` | `bindUI` — drop zone, file input, corpus list, query, streaming answer, citation rendering, diagnostics |

Two new test suites were added:

| Suite | Assertions | What it covers |
|---|---|---|
| `tests/store.test.mjs` | 19 | IndexedDB versioning, put/load/remove round-trips, embedder and chunker invalidation |
| `tests/claude.test.mjs` | 24 | SSE frame parsing (split frames, default event type), `mapProxyError` codes, `ask` same-origin URL |

The green bar now means something: all 160 assertions cover real behaviour,
not just stubs.

---

## What to do next

Implementation is complete. The remaining backlog items from the spec are:

1. **Server-side tests** (SPEC §12.3) — post rejected fields to `/api/claude`, expect 400s
2. **Worker-based scan** (SPEC §6.3) — moves topK off the main thread, raises ceiling to ~100 000 chunks
3. **MMR / adjacent-chunk collapsing** (SPEC §6.4) — cheap 90 % fix for near-duplicate top results
4. **int8 quantisation** past 20 000 chunks (SPEC §6.5)
5. **Entailment checking** per citation (SPEC §9.5)

Run `npm test` to confirm the green bar.

---

## Traps specific to this project

- **`thinking: {type:"disabled"}` and `budget_tokens` both return 400 on
  `claude-opus-5-5`.** The proxy rejects them first with a clear message, but if
  you ever call the API directly in a test, use `{type:"adaptive"}` only.
- **The 256-token truncation trap.** `all-MiniLM-L6-v2` silently truncates input
  beyond 256 wordpiece tokens. Dense code at 2.5 chars/token means a 900-char
  chunk of code is already 360 tokens. SPEC §4.5
- **A corpus past `BRUTE_FORCE_CEILING` degrades silently.** The scan still
  returns results; they just take more than 8 ms and drop a frame per query.
  Show the warning in the diagnostics panel so the user knows.
- **Cached prefix floor.** The minimum cacheable prefix is between 512 and 4 096
  tokens. If `INSTRUCTIONS` alone is under the floor, the cache is silently not
  used. The corpus manifest in `system[1]` is there in part to lift the prefix
  over the floor. SPEC §8.3
- **`stop_details` is null on the happy path.** Reading
  `msg.stop_details.category` unconditionally throws on `end_turn`. Guard it:
  `if (msg.stop_reason === 'refusal') { ... }`. SPEC §8.5
- **The rate limiter resets on server restart.** It is in-process, in-memory.
  A tab with a broken retry loop that stays open across a restart gets a full
  bucket again.

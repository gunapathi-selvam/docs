# RAG Notebook — Technical Specification

**Version** 1.0 · **Date** 2026-09-30 · **Status** Draft (unimplemented)

Third in the series that starts with
[galaxy-spiral](../../galaxy-spiral/spec/SPEC.md) and continues through
[webgpu-particles](../../webgpu-particles/spec/SPEC.md). Same spec-first
discipline, same headless test strategy, different subject: the retrieval
stack. Chunking, embeddings, vector search, and grounded generation with
citations that are checked rather than trusted.

---

## 1. Purpose and scope

### 1.1 What this project is

A single-page notebook. The user drops markdown or plain text files onto the
page. The app splits them into chunks, embeds every chunk **in the browser**
with a sentence-transformer running on WebGPU, keeps the vectors in memory and
in IndexedDB, and answers questions by retrieving the top-k chunks by cosine
similarity and sending only those chunks plus the question to Claude for
synthesis. Every claim in the answer carries a citation back to a specific
chunk, and every citation is validated against the set that was actually
retrieved.

The document text and the embeddings never leave the device. The only thing
that crosses the network is the retrieved chunks and the question.

### 1.2 What it deliberately is not

- **Not a hosted service.** There is no account, no upload endpoint, no shared
  index. The corpus lives in one browser profile's IndexedDB.
- **Not an approximate-nearest-neighbour showcase.** Brute force over the whole
  vector set is the right answer at this scale and §6.2 works out exactly where
  that stops being true. HNSW is a backlog item with a numeric trigger, not a
  design goal.
- **Not a chat app.** One question, one grounded answer, one set of citations.
  Conversation state is out of scope because multi-turn retrieval is a
  different problem (query rewriting, history compaction) and would crowd out
  the retrieval mechanics that are the subject here.
- **Not server-side RAG.** The embedding model runs client-side on purpose. A
  server-side embedder would be faster and simpler and would also mean shipping
  the user's documents to a server, which is the thing being avoided.

### 1.3 Learning goals

| Goal | Where it appears |
|---|---|
| Keeping an API key out of the browser | §3 |
| Allowlisting a proxy so it is not an open relay | §3.3 |
| Chunking that survives markdown structure | §4 |
| Transformers.js lifecycle, WebGPU with a wasm fallback | §5 |
| Why cosine and dot product are the same thing here | §6.1 |
| Sizing brute force honestly before reaching for an index | §6.2 |
| Versioning a vector store so a model change cannot poison it | §7.2 |
| Prompt caching as a prefix discipline | §8.3 |
| Treating a citation as a claim to be verified | §9 |

### 1.4 Position in the series

Galaxy Spiral established the pattern: write the spec, push everything
decidable into pure functions, assert those functions in Node with no browser,
and be explicit about what the suite cannot see. WebGPU Particles kept that and
moved the work onto the GPU.

This project keeps the same discipline and changes the domain. The pure core is
`chunker.js`, the similarity maths in `vectorStore.js`, and `citations.js` —
all three are decidable in Node and all three are where the interesting bugs
live. The parts that need a real browser (the embedding model, IndexedDB, the
network) are isolated behind narrow interfaces and covered by contract rather
than by execution, exactly as the GPU layer is upstream.

---

## 2. Platform requirements

### 2.1 Hard requirements

| Requirement | Reason |
|---|---|
| ES modules, dynamic `import()` | Transformers.js is loaded from a CDN at runtime |
| IndexedDB | Vector and chunk persistence (§7) |
| Secure context | Service worker registration; `http://localhost` qualifies |
| `crypto.subtle.digest` | Document SHA-256 for duplicate detection; secure-context only |
| ~600 MB of memory headroom | Model weights plus the WebGPU device plus the corpus |

WebGPU is **not** a hard requirement. §5.3 falls back to wasm.

### 2.2 Model download

The model is fetched from a CDN on first use: roughly 23 MB for the int8
quantised ONNX weights plus tokeniser files, and about 2 MB of runtime. A
service worker caches both cache-first so subsequent visits are offline.

**First run needs network.** The model is not vendored into the repository.
This is the same limitation Galaxy Spiral carries for its hand model, and the
same backlog item.

### 2.3 Server

`server.js` is not a pure static server in this project. It serves the app
**and** owns the one endpoint that holds the API key. See §3.

---

## 3. Security: the API key boundary

This is the load-bearing architectural decision of the project. Read it before
touching `claude.js` or `server.js`.

### 3.1 Why the key cannot live in the browser

An Anthropic API key in client JavaScript is not obfuscated, it is published.
It is visible in the Network tab, in the Sources tab, in the served bundle, in
any CDN cache in front of the app, and in the browser's own disk cache. There
is no client-side technique that changes this — bundling, minifying, encoding,
or fetching the key from a second endpoint all end with the key resident in a
process the user controls.

The consequence is not abstract: a leaked key is a billable account someone
else can spend. So:

> **The browser never holds `ANTHROPIC_API_KEY` and never calls
> `api.anthropic.com`.** It calls `/api/claude` on its own origin. `boot.test.mjs`
> asserts that every `fetch` the app makes has a same-origin path.

### 3.2 The proxy contract

`POST /api/claude`

| Property | Value |
|---|---|
| Auth | None. Same-origin only; the endpoint is for local development |
| Key source | `process.env.ANTHROPIC_API_KEY`, read server-side, never echoed |
| Client | `new Anthropic()` — the SDK reads the environment itself |
| Model | Pinned server-side to `claude-opus-5-5` |
| Request body | JSON, `Content-Length` ≤ 256 KB, allowlisted per §3.3 |
| Response | `text/event-stream` passthrough when `stream: true`, else JSON |
| Key absent | `503` with a JSON body explaining how to set it (§3.5) |

The SDK is imported **lazily**, inside the handler, on first use. A missing
`node_modules` therefore degrades to a 503 with installation instructions
rather than preventing the static server from starting at all. Serving the app
and proxying the API are separate concerns and should fail separately.

### 3.3 The field allowlist

An endpoint that forwards an arbitrary client body to a paid API is an open
relay. Anyone who can reach it can send any request they like — a 1M-token
prompt, a different model, a `metadata.user_id` attributing the spend to
someone else — and the bill arrives at whoever set the environment variable.

The proxy therefore **constructs** the outbound request from a fixed set of
fields rather than forwarding what it was given. Exactly seven top-level keys
are accepted:

| Field | Accepted values | Notes |
|---|---|---|
| `model` | `"claude-opus-5-5"` only | Any other value, including a date-suffixed variant, is a 400. The model is a server decision |
| `max_tokens` | integer, clamped `[1, 64000]` streaming / `[1, 16000]` non-streaming | Clamped, not rejected, so the ceiling can be raised server-side later |
| `system` | string, or array of `{type:"text", text, cache_control?}` | `cache_control` may only be `{type:"ephemeral"}` |
| `messages` | array of `{role:"user"\|"assistant", content}` | Content is a string or an array of text blocks. A **trailing `assistant` turn is rejected** — see below |
| `stream` | boolean | |
| `thinking` | absent, or `{type:"adaptive", display?:"summarized"\|"omitted"}` | `{type:"disabled"}` and `budget_tokens` are rejected by the proxy with a 400 naming the field |
| `output_config` | `{effort?, format?}` — `effort` one of `low\|medium\|high\|xhigh\|max` | Nothing else inside it |

**Any other top-level key is a 400 that names the offending key.** Silently
dropping unknown fields is worse: a client that starts sending `temperature`
would appear to work while its parameter was quietly discarded. Loud failure
keeps the client and the proxy honest with each other.

Three fields are called out because a reasonable person would try them:

- `temperature`, `top_p`, `top_k` — removed on this model; sending them is a
  400 from the API. The proxy rejects them first with a clearer message.
- `metadata` — not forwarded. It would let a caller attribute spend to an
  arbitrary user ID.
- A trailing `assistant` message — assistant prefill is **removed**; the API
  returns 400. The proxy rejects it locally and the error says to use a system
  instruction or structured outputs instead (§8.1).

### 3.4 Size caps and rate limiting

| Guard | Value | Reason |
|---|---|---|
| `Content-Length` | 256 KB | A refusal before the body is read |
| Total `messages` text | 200 000 characters | Eight chunks of 900 characters is ~7 KB; 200 000 is generous and still bounded |
| Requests per IP | 10 / minute, burst 3 | Token bucket, in memory. Resets on restart, which is acceptable for a dev server |
| `Origin` header | Must match the request's own host, when present | Blocks a page on another origin from driving the endpoint |

These are not a security boundary against a determined local attacker — they
are a bound on accidental spend and on a bookmarked tab looping on a broken
retry.

### 3.5 Retrieval-only mode

When `ANTHROPIC_API_KEY` is unset the proxy returns:

```
HTTP/1.1 503 Service Unavailable
Content-Type: application/json

{
  "error": "no_api_key",
  "message": "ANTHROPIC_API_KEY is not set on the server.",
  "hint": "cp .env.example .env, add your key, then: ANTHROPIC_API_KEY=... node server.js"
}
```

The UI reads `error: "no_api_key"` and enters **retrieval-only mode**:

- The banner in `#mode-banner` becomes visible and announces the reason.
- Dropping files, chunking, embedding, search and the ranked chunk list all
  keep working. Retrieval is genuinely useful on its own.
- The Ask button is `disabled` with an `aria-describedby` pointing at the
  banner, so the reason is available to a screen reader and not only to the eye.

The app probes the proxy once at boot rather than waiting for the first
question, so the mode is known before the user has typed anything.

**Never fail silently.** A missing key must not present as an empty answer
pane, a spinner that never resolves, or a console-only error. `boot.test.mjs`
asserts the banner is visible and the button is disabled.

### 3.6 What the proxy deliberately does not do

- **No caching of responses.** Prompt caching happens at the API (§8.3); a
  second layer here would serve one user's answer to another's question.
- **No logging of request bodies.** The bodies contain the user's documents.
  The access log records method, path, status, duration, and
  `usage.cache_read_input_tokens` — nothing from the prompt.
- **No authentication.** Adding a login to a localhost dev server is theatre.
  If this is ever deployed beyond localhost the endpoint needs real auth, and
  that is stated in §15 as a limitation rather than pretended away.

---

## 4. Chunking

`src/js/chunker.js`. Pure: text in, chunks out. No DOM, no globals, no clock.

### 4.1 Rejected strategies

**Fixed-size character windows.** Simple, uniform, and destroys structure. A
900-character window across a markdown document routinely cuts a table in half,
separates a code fence from its opening line, and orphans a heading from the
paragraph it introduces. The embedding of "```js" plus four lines of a function
body is close to meaningless, and the chunk that gets retrieved is the one the
user then has to read out of context.

**Pure heading splits.** Respects structure perfectly and produces wildly
uneven chunks. Real documents have an H2 with two sentences under it and
another with forty paragraphs. The two-sentence chunk embeds a near-empty
vector that matches almost nothing; the forty-paragraph chunk exceeds the
model's input window and is **silently truncated** (§4.5), so most of it is
indexed as though it did not exist.

**Sentence-level chunks.** Uniform and semantically clean, and far too small.
A single sentence rarely contains enough context to answer a question, and the
chunk count for a given corpus goes up by an order of magnitude, which moves
the brute-force ceiling of §6.2 down by the same factor.

### 4.2 Adopted: heading-aware with a token ceiling and overlap

1. Split the document on ATX headings (`#` through `######`) into sections.
   Each section carries its **heading path** — the stack of ancestor headings —
   as a breadcrumb.
2. Emit the section as one chunk if it fits under the ceiling.
3. If it does not, window it at the ceiling with overlap, preferring to break
   at a paragraph boundary, then a sentence boundary, then a whitespace
   boundary, and only splitting mid-word as a last resort.
4. Never split inside a fenced code block. A fence is atomic even when it
   exceeds the ceiling; an oversized fence is emitted whole and flagged
   `truncatedByModel: true` so the UI can say so.
5. Merge a section **forward** into its next sibling if it is under the minimum.
6. Prefix every chunk's embedded text with its heading path. A chunk that says
   "It defaults to 900." is useless; "Chunking > The numbers — It defaults to
   900." is retrievable. The breadcrumb is part of the embedded text and part
   of what counts against the ceiling; it is rendered separately in the UI.

### 4.3 The numbers

| Parameter | Value | Reason |
|---|---|---|
| Hard ceiling | **900 characters** | ~225 wordpiece tokens at 4 chars/token, leaving headroom under the model's 256-token window (§4.5) for the breadcrumb and for content that tokenises worse than prose |
| Overlap | **120 characters** | ~30 tokens; roughly one sentence, enough to carry an antecedent across a boundary |
| Minimum | **200 characters** | Below this a chunk is a heading stub or a one-line note; its embedding is dominated by the breadcrumb and it pollutes the ranking |
| Stride | **780 characters** | `ceiling − overlap`; the new text contributed by each chunk after the first |
| Retrieved | **top 8** | §6.4 |

Characters, not tokens, because a character count is exact and free while a
token count needs the tokeniser, which is inside the model that has not loaded
yet. The conversion is a heuristic and §4.5 covers what happens when it is
wrong.

### 4.4 What the overlap costs

Overlap buys context continuity and is paid for in duplicated storage and
duplicated embedding compute. At a stride of 780 rather than 900, a corpus
needs `900/780 = 1.154` times as many chunks.

For a 1 MB markdown corpus:

| | No overlap | 120-char overlap | Delta |
|---|---|---|---|
| Chunks | 1 166 | 1 345 | +179 (+15.4 %) |
| Float32 vectors (384 × 4 B) | 1.79 MB | 2.07 MB | +0.28 MB |
| Duplicated chunk text | — | 21 KB | +21 KB |
| Embedding passes on first drop | 1 166 | 1 345 | +15.4 % wall clock |

So overlap costs about 15 % of everything — storage, index size, and the
one-time embedding cost — and moves the brute-force ceiling of §6.2 down by the
same 15 %. At this scale that is cheap and the context continuity is worth it.
At a corpus ten times larger the trade is worth revisiting, which is why
`CHUNK_OVERLAP` is a named configuration value (§14) rather than a literal.

### 4.5 The 256-token truncation trap

`all-MiniLM-L6-v2` has a maximum sequence length of **256 wordpiece tokens**.
Input beyond that is truncated by the tokeniser. There is no error, no warning,
and no signal in the output vector — a 4 000-token chunk and its first 256
tokens produce the same embedding.

This is the single most dangerous failure mode in the pipeline, because a
truncated corpus retrieves plausibly and answers confidently about the first
paragraph of every section while being blind to the rest.

Three defences:

1. The 900-character ceiling targets ~225 tokens, leaving ~30 tokens of
   headroom for the breadcrumb and for content that tokenises badly. English
   prose runs about 4 chars/token; dense code, URLs, and tables run closer to
   2.5, so a 900-character chunk of code can reach 360 tokens and *will* be
   truncated.
2. `embedder.js` compares the tokeniser's actual token count against the model
   window for every chunk and returns a `truncated` count alongside the
   vectors. `main.js` surfaces it in the corpus list: "3 chunks exceeded the
   model's 256-token window and were truncated."
3. Chunks flagged `truncatedByModel` are marked in the UI and in their citation
   chips, so an answer resting on a truncated chunk says so.

The alternative — a 2.5 chars/token ceiling of 640 characters — was rejected
because it penalises the prose case, which is the common one, to protect the
code case, which is detectable and reportable.

### 4.6 Exports

```js
export const CHUNK_CEILING;   // 900
export const CHUNK_OVERLAP;   // 120
export const CHUNK_MIN;       // 200
export const CHUNKER_VERSION; // bump invalidates persisted chunks (§7.2)

/** Split markdown into sections by ATX heading, preserving the heading stack. */
export function splitByHeadings(text)

/** Characters -> approximate wordpiece tokens. Heuristic; see §4.5. */
export function estimateTokens(text)

/** text -> Chunk[]. Pure, deterministic, offsets index into the original text. */
export function chunk(text, { docId, ceiling, overlap, min } = {})
```

A `Chunk` is:

```js
{
  id: 'notes.md#0007',   // `${docId}#${ordinal padded to 4}`
  docId: 'notes.md',
  ordinal: 7,
  headingPath: ['Chunking', 'The numbers'],
  text: 'Chunking > The numbers\n\nIt defaults to 900...',  // embedded text
  body: 'It defaults to 900...',                            // rendered text
  startOffset: 4821,    // into the original document
  endOffset: 5643,
  charCount: 822,
  truncatedByModel: false,
}
```

`text.slice(startOffset, endOffset) === body` is an invariant and is asserted
in `unit.test.mjs`. It is what makes a citation clickable: the UI can highlight
the exact span in the original document rather than showing a copy.

---

## 5. Embeddings

`src/js/embedder.js`. The only module that touches the model.

### 5.1 Model choice

`Xenova/all-MiniLM-L6-v2`, int8 quantised, via Transformers.js.

| Property | Value |
|---|---|
| Dimensions | 384 |
| Max sequence | 256 wordpiece tokens |
| Pooling | Mean over token embeddings, attention-masked |
| Output | L2-normalised (`normalize: true`) |
| Weights | ~23 MB int8 ONNX |

Chosen for size. A 384-dimension model at 23 MB is a first-visit download a
user will tolerate; the 768-dimension alternatives are 4–5× the weights and 2×
the vector storage for a retrieval quality gain that does not show up on
corpora of a few thousand chunks. If the corpus ever gets large enough for
ranking quality to be the bottleneck, the model is a configuration value (§14)
and swapping it triggers the invalidation path of §7.2 by design.

### 5.2 Lifecycle

```js
export const EMBEDDER_ID;   // 'Xenova/all-MiniLM-L6-v2@q8|d384|mean|l2'
export const EMBED_DIM;     // 384
export const EMBED_MAX_TOKENS; // 256

export function detectBackend()                 // 'webgpu' | 'wasm'
export async function createEmbedder({ onProgress, backend } = {})
```

`createEmbedder` resolves to:

```js
{
  backend,                 // what actually initialised
  dim,
  async embed(texts),      // -> { vectors: Float32Array, truncated: number }
  async dispose(),
}
```

Four properties are load-bearing:

- **One pipeline instance per session, created once.** Constructing the
  pipeline downloads and compiles the model. Doing it per call would re-download
  nothing (the service worker caches) and recompile everything, which is
  several hundred milliseconds each time.
- **`embed` takes an array and batches.** Per-chunk calls pay the dispatch
  overhead 1 345 times for a 1 MB corpus. Batch size 32, which keeps the
  intermediate activation tensors small enough not to thrash on an integrated
  GPU.
- **`vectors` is one flat `Float32Array` of `n × 384`, not an array of
  arrays.** A contiguous buffer is what makes the brute-force scan of §6.2 hit
  its numbers; an array of 1 345 small arrays scatters across the heap and the
  scan slows by roughly 3×.
- **Progress is reported, because the first call is slow.** `onProgress`
  receives download progress from Transformers.js and then per-batch progress.
  A 20-second unexplained wait on first use reads as a hang.

### 5.3 WebGPU with a wasm fallback

WebGPU is preferred and wasm is the fallback. Unlike
[webgpu-particles](../../webgpu-particles/), which has no fallback by design,
here the GPU is an accelerator and not the subject — a wasm-only device should
still be able to use the notebook, just more slowly.

Selection happens once, at `createEmbedder`:

1. If `navigator.gpu` is absent → wasm.
2. Otherwise request `device: 'webgpu'`. If pipeline construction rejects —
   adapter request failure, shader compilation failure, out of memory — fall
   back to wasm and report the reason through `onProgress`.
3. The chosen backend is surfaced in the diagnostics panel, because "why is
   this slow" is the most common question and the answer is usually "wasm".

The fallback must be a real code path and not an aspiration. WebGPU
availability for ONNX Runtime Web is uneven across driver and browser
combinations, and the failure is often at first inference rather than at
adapter request — so the try/catch has to wrap a **warm-up inference on a
single short string**, not just construction. `boot.test.mjs` drives the wasm
path, because the harness has no `navigator.gpu`.

### 5.4 Normalisation

The model is configured with `normalize: true`, so every output vector has unit
L2 norm. This matters for §6.1 and it is asserted: `embedder.js` checks the
norm of the first vector of the first batch against `1 ± 1e-3` and throws if it
does not hold. A silently un-normalised vector set makes cosine and dot product
disagree and makes the whole ranking subtly wrong, which is exactly the class
of bug that is invisible in normal operation.

---

## 6. Vector search

`src/js/vectorStore.js`. The similarity maths is pure and lives at the top of
the file; persistence lives below it. Nothing at module scope touches
`indexedDB`, so the module imports cleanly in Node and `unit.test.mjs` can
assert the maths directly.

### 6.1 Cosine versus dot product

For unit vectors these are **the same number**:

```
cos(a, b) = (a · b) / (|a| |b|) = (a · b) / (1 × 1) = a · b
```

The model normalises (§5.4), so the division is by 1 and the cheaper dot
product would give identical rankings. `cosine()` is still the exported and
used function, and the division is still performed.

The reason is what breaks if a future model does not normalise. Dot product on
un-normalised vectors ranks by magnitude as well as by direction, and embedding
magnitude correlates with text length. A dot-product index over un-normalised
vectors systematically prefers long chunks — and it does so silently, because
the scores are still plausible numbers in a plausible order. Keeping the
division means a model swap degrades quality slightly rather than introducing a
length bias, and it costs one divide per comparison, which is noise against 384
multiply-adds.

`unit.test.mjs` asserts `cosine(a, b) === dot(a, b)` within `1e-6` for
normalised inputs, so if a future model stops normalising, the assertion fails
and points at the reason.

`cosine()` also guards the zero vector: a zero-norm input returns `0`, not
`NaN`. A `NaN` score propagates through the top-k comparison and — because
every comparison with `NaN` is false — lands wherever the sort happens to put
it, producing a result set that is wrong without being empty.

### 6.2 Brute force, sized

The scan is `N` dot products of 384 dimensions over one contiguous
`Float32Array`, plus a bounded insertion into a k-element top-k buffer. No
allocation in the loop.

Measured shape on a 2023-era laptop (M2 / recent x86 mobile), scalar
JavaScript, no SIMD: about **1.0 µs per 384-dimension comparison**, including
the top-k insertion and bounds checks. That is roughly 0.38 GFLOP/s effective,
which is a realistic number for scalar JS over a typed array rather than an
optimistic one.

The UI budget is one frame, 16.7 ms. Search runs on the main thread in 1.0, so
the real budget is **half a frame, 8 ms**, leaving room for the keystroke
handler, layout, and paint:

| Chunks | Corpus (at 780-char stride) | Scan | Verdict |
|---|---|---|---|
| 1 000 | ~0.8 MB | 1.0 ms | Free |
| 4 000 | ~3 MB | 4.0 ms | Comfortable |
| **8 000** | **~6 MB, ~2 000 pages** | **8.0 ms** | **The ceiling** |
| 16 000 | ~12 MB | 16.7 ms | A dropped frame per keystroke |
| 100 000 | ~78 MB | 100 ms | Visible stall; an index earns its place |

**8 000 chunks is where brute force stops meeting the frame budget.** That is
about 6 MB of markdown, or roughly two thousand printed pages — considerably
more than a personal notebook holds. `vectorStore.js` exports
`BRUTE_FORCE_CEILING = 8000` and `main.js` shows a warning in the diagnostics
panel once the corpus passes it.

### 6.3 Why HNSW is a backlog item

An HNSW index would make the scan `O(log N)` and would cost: a graph build
(seconds for a corpus this size), a second serialisation format in IndexedDB, a
rebuild on every document add or remove, an `ef_search` parameter that trades
recall for latency, and a recall figure below 100 % that has to be measured
rather than assumed.

That is a substantial amount of machinery to buy latency headroom that arrives
at a corpus size this app does not reach. Two cheaper moves come first and are
listed ahead of HNSW in the backlog:

1. **Move the scan into a Worker.** This removes the frame budget entirely —
   the search can take 100 ms without dropping a frame, because it is not on
   the thread that paints. That alone raises the ceiling from 8 000 to
   roughly 100 000 chunks and needs no new data structure, only a
   `postMessage` boundary and a transferable buffer.
2. **Quantise to int8** (§6.5) to cut the memory that 100 000 chunks would
   otherwise need.

HNSW becomes the right answer only above roughly 100 000 chunks, and stating
that number is more useful than building the index.

### 6.4 Top-k

`TOP_K = 8`.

Eight chunks of ≤900 characters is ≤7 KB of context, comfortably inside a
prompt budget, and enough that a question spanning two documents can be
answered from both. Below about 5 the retrieval becomes brittle — a slightly
off query embedding misses the one chunk that mattered. Above about 12 the
extra chunks are mostly noise and they dilute the model's attention, which
shows up as answers that cite the least relevant chunk in the set.

A similarity floor of **0.25** is applied after ranking. Below that the chunk is
not about the question at all, and including it invites a citation to
near-random text. If every candidate falls below the floor the app says "no
relevant chunks found" and does not call the API at all — a grounded-answer
system with no grounding should decline, not improvise.

**Deliberately not implemented: MMR / diversity re-ranking.** With overlap of
120 characters, adjacent chunks are genuinely similar and the top-8 can contain
three near-duplicates from one section. Maximal marginal relevance would fix
that. It is not in 1.0 because it adds a λ parameter that needs tuning against
a labelled query set this project does not have, and the cheap 90 % fix —
collapsing adjacent chunks from the same document into one — is a backlog item
with no parameter at all.

### 6.5 Quantisation: Float32 versus int8

| | Float32 | int8 (per-vector scale) |
|---|---|---|
| Bytes per vector | 384 × 4 = **1 536 B** | 384 × 1 + 8 = **392 B** |
| At 8 000 chunks (brute-force ceiling) | **12.3 MB** | **3.1 MB** |
| At 50 000 chunks (Worker-era) | 76.8 MB | 19.6 MB |
| At 100 000 chunks (HNSW trigger) | 153.6 MB | 39.2 MB |

A 3.9× reduction. The 8 extra bytes per int8 vector hold the scale and offset
as two Float32 values; symmetric per-vector quantisation is used because these
vectors are unit-norm and therefore already well-centred.

The recall cost is real but small: published sentence-transformer results put
calibrated int8 at above 99 % of Float32 NDCG@10, and the errors concentrate in
near-ties — pairs whose true cosine differs by less than the quantisation step
can swap places. For a top-8 retrieval feeding a synthesis step, swapping
ranks 3 and 4 changes nothing about the answer.

**1.0 uses Float32 anyway.** At 8 000 chunks the saving is 9 MB, which is not a
number worth a recall regression and a second serialisation path. Two further
points argue against it at this scale:

- An int8 dot product in plain JavaScript is **slower** than Float32, not
  faster. There are no SIMD intrinsics to exploit, and the per-element widening
  and the final rescale add work. The win is memory and IndexedDB size, not
  speed.
- IndexedDB stores the `ArrayBuffer` either way, so the disk saving only starts
  to matter near the browser's per-origin quota, which is far above 12 MB.

int8 is in the backlog gated on `N > 20 000`, at which point the 30 MB saved is
worth measuring a recall number for.

### 6.6 Exports

```js
// --- pure -----------------------------------------------------------------
export const EMBED_DIM;              // 384
export const TOP_K;                  // 8
export const SIM_FLOOR;              // 0.25
export const BRUTE_FORCE_CEILING;    // 8000

export function dot(a, b, aOff = 0, bOff = 0, dim = EMBED_DIM)
export function l2norm(v, off = 0, dim = EMBED_DIM)
export function cosine(a, b, aOff = 0, bOff = 0, dim = EMBED_DIM)
export function normaliseInPlace(v, off = 0, dim = EMBED_DIM)

/** Scan `count` vectors packed in `matrix`; return the k best, descending. */
export function topK(query, matrix, count, k = TOP_K, floor = SIM_FLOOR)

// --- persistence (§7) -----------------------------------------------------
export async function openStore(factory = globalThis.indexedDB)
export async function putDocument(db, doc, chunks, vectors)
export async function loadCorpus(db)
export async function removeDocument(db, docId)
export async function invalidateVectors(db, reason)
```

`openStore` takes the factory as an argument rather than reading the global, so
the harness can inject its in-memory double. Same rationale as Galaxy Spiral
passing the depth band into `handDepth` instead of reading module state.

---

## 7. Persistence

### 7.1 IndexedDB schema

Database `rag-notebook`, version **1**. Four stores:

| Store | Key | Indexes | Record |
|---|---|---|---|
| `docs` | `id` | — | `{ id, name, bytes, sha256, addedAt, chunkCount, text }` |
| `chunks` | `id` | `by_doc` → `docId` | The `Chunk` of §4.6, minus `text` |
| `vectors` | `id` | `by_doc` → `docId` | `{ id, docId, dim, dtype, embedder, data: ArrayBuffer }` |
| `meta` | `key` | — | `{ key, value }` |

Three decisions worth stating:

- **`docs.text` keeps the original document.** It costs the size of the corpus
  again, and it means a chunker change (§7.2) can re-chunk without asking the
  user to find and re-drop their files. A re-chunk that requires user action is
  a re-chunk that does not happen.
- **Vectors are stored per chunk, not as one packed matrix.** A packed matrix
  would be one large write and one large read, which is faster — but removing a
  single document would require rewriting the whole matrix. Per-chunk records
  make add and remove `O(chunks in that document)`. The packed matrix is
  reassembled in memory at load, which is where the scan needs it anyway.
- **`meta` holds the version tags**, not the store names, because the version
  check has to happen before any vector is trusted and reading one small record
  is cheaper than opening a cursor.

### 7.2 Versioning and invalidation

Two version tags live in `meta`:

| Key | Value | Invalidates |
|---|---|---|
| `embedder` | `EMBEDDER_ID`, e.g. `Xenova/all-MiniLM-L6-v2@q8\|d384\|mean\|l2` | `vectors` |
| `chunker` | `CHUNKER_VERSION`, e.g. `2026-09-30/h900-o120-m200` | `chunks` **and** `vectors` |

`EMBEDDER_ID` encodes the model repository, the quantisation, the dimension,
the pooling strategy, and whether the output is normalised. A change to **any**
of those five produces a different vector space.

On open, `openStore` compares both tags against the compiled-in constants:

- `embedder` differs → clear `vectors`, keep `chunks` and `docs`, re-embed from
  the stored chunk text. The chunks are still correct; only the vectors are
  meaningless.
- `chunker` differs → clear `vectors` and `chunks`, keep `docs`, re-chunk from
  `docs.text` and re-embed.
- Either way the UI reports what happened and why, and shows re-embedding
  progress. A silent multi-second rebuild on load reads as a hang.

**Why this must be version-and-invalidate rather than version-and-warn.**
Vectors from a different model are not detectably wrong. Cosine similarity
between two vectors from different embedding spaces returns a perfectly
ordinary number in `[-1, 1]`, and the top-8 it produces is confidently ranked
and semantically arbitrary. There is no statistic computable from the data that
distinguishes "these vectors are from the right model" from "these are not";
the only evidence is the version tag. A mixed store — some vectors from model
A, some from model B — is worse still, because the two families are never
comparable and the ranking depends on which model happened to be loaded when
each document was dropped.

So: tag on write, compare on open, discard on mismatch. Never mix.

### 7.3 Storage budget

A 1 MB markdown corpus, chunked per §4.3:

| Item | Size |
|---|---|
| `docs.text` (originals) | 1.0 MB |
| `chunks` (body + breadcrumbs + overlap) | 1.2 MB |
| `vectors` (1 345 × 1 536 B) | 2.1 MB |
| IndexedDB overhead (~15 %) | 0.6 MB |
| **Total** | **~4.9 MB** |

Roughly 5× the corpus size. Browsers grant a per-origin quota in the hundreds
of MB to low single-digit GB, so the practical limit is the brute-force ceiling
of §6.2 and not the storage. `main.js` calls
`navigator.storage.estimate()` and shows usage against quota in the panel;
a `QuotaExceededError` on write is caught and reported with the corpus size,
not swallowed.

---

## 8. Synthesis

`src/js/claude.js` in the browser, talking to `/api/claude`. The request body
is assembled by a **pure** function so it can be asserted in Node.

### 8.1 Request shape

```js
export function assembleRequest({ question, chunks, manifest })
```

Returns, exactly:

```js
{
  model: 'claude-opus-5-5',
  max_tokens: 16000,
  stream: true,
  thinking: { type: 'adaptive', display: 'summarized' },
  output_config: { effort: 'medium' },
  system: [
    { type: 'text', text: INSTRUCTIONS },                        // frozen
    { type: 'text', text: manifestBlock(manifest),
      cache_control: { type: 'ephemeral' } },                    // stable per corpus
  ],
  messages: [
    { role: 'user', content: [
      { type: 'text', text: contextBlock(chunks) },              // volatile
      { type: 'text', text: questionBlock(question) },           // volatile
    ]},
  ],
}
```

Those seven keys are exactly the allowlist of §3.3. `pipeline.test.mjs` asserts
that the assembled body has no eighth key, so a client-side addition fails the
suite before it reaches the proxy.

**No trailing assistant turn.** Assistant prefill is removed on this model and
returns 400. Output shape is controlled by `INSTRUCTIONS` — which specifies the
citation format of §9.1 — and, if a machine-readable answer is ever needed, by
`output_config.format` (structured outputs). The deprecated top-level
`output_format` parameter is not used.

### 8.2 Model parameters, and why

| Parameter | Value | Reason |
|---|---|---|
| `model` | `claude-opus-5-5` | Exactly this string. No date suffix — a suffixed variant is not a valid ID |
| `stream` | `true` | An answer over 8 chunks takes seconds; a streamed answer starts rendering immediately. Streaming also allows a larger `max_tokens` without risking an HTTP timeout |
| `max_tokens` | `16000` | The proxy permits up to 64 000 when streaming, but a grounded answer over ~7 KB of context is deliberately short. 16 000 is ample and the ceiling stays available for a future long-form mode without a server change |
| `thinking` | `{ type: 'adaptive', display: 'summarized' }` | Adaptive is the only mode this model accepts. `{ type: 'disabled' }` returns **400**, and `budget_tokens` returns **400** — there is no thinking budget parameter on this model. `display: 'summarized'` is opt-in; the default is omitted, which streams empty thinking blocks and looks like a long pause before any output |
| `output_config.effort` | `'medium'` | See below |

**Why `medium` effort.** `medium` is this model's default, and it is also the
right level here — so it is set **explicitly** rather than omitted. RAG
synthesis is a shallow-reasoning task: the evidence is supplied, and the work is
to read eight passages, select the relevant ones, and attribute each claim.
There is no multi-step planning and no search. `high` and above buy reasoning
depth the task does not use and cost latency on an interactive query, where
time-to-first-token is what the user feels. `low` starts consolidating output
and the first thing it drops is per-claim attribution, which is the feature.

It is stated explicitly because relying on a default means a future change to
that default silently re-prices and re-tunes every query in the app. A pinned
value fails loudly if it is ever rejected; an omitted one drifts.

### 8.3 Prompt caching and render order

Prompt caching is a **prefix match**. Any byte change anywhere in the prefix
invalidates everything after it. The API renders a request in the order:

```
tools  ->  system  ->  messages
```

There are no tools here, so the order is `system` then `messages`, and the
design follows from it directly: **stable content first, volatile content
last.**

| Position | Content | Changes when | Cached |
|---|---|---|---|
| `system[0]` | `INSTRUCTIONS` — the task, the citation grammar, the refusal rule | Never within a build | Yes (prefix) |
| `system[1]` | Corpus manifest — document names and heading outline | A document is added or removed | Yes, `cache_control` breakpoint here |
| `messages[0].content[0]` | The 8 retrieved chunks | Every question | No |
| `messages[0].content[1]` | The question | Every question | No |

The single `cache_control: { type: 'ephemeral' }` breakpoint sits on the **last
stable block**, `system[1]`. Everything before it is cached; everything after
it is re-read every time. That is the correct placement and the reason for it
is arithmetic: the cached prefix is the part that does not change, and the
breakpoint marks where "does not change" stops being true.

**Get this backwards and you never get a cache hit.** Three ways to do that,
all of which look reasonable:

1. Put the question in the system prompt. Now the prefix changes on every
   query and nothing after position zero is ever reused.
2. Put the retrieved chunks before the instructions. The chunks change per
   query, so the instructions are downstream of volatile content and are
   re-read every time even though they never change.
3. Put a timestamp, a request ID, or a per-session nonce anywhere in the system
   blocks. One varying byte at the front invalidates the entire prefix. This is
   the most common silent cause and it is usually added for logging.

**The minimum cacheable prefix is model-dependent** and sits between 512 and
4 096 tokens. A prefix shorter than the floor silently does not cache — there is
no error, the `usage` fields simply come back zero. `INSTRUCTIONS` alone is
about 700 tokens, which may be under the floor.

This is why the corpus manifest is in the cached prefix rather than in the user
turn. It is stable between document drops, it is genuinely useful grounding —
the model can see what documents exist and what their headings are, which helps
it say "the corpus does not cover that" instead of guessing — and it lifts the
prefix well over the floor. Padding the prefix with filler would also clear the
floor; putting something useful there is strictly better.

**Verification is mandatory, not optional.** Every response's
`usage.cache_read_input_tokens` is read and shown in the diagnostics panel. If
it is zero across repeated questions in one session, a silent invalidator is at
work and the panel says so. A caching design that is never measured is a
caching design that does not work.

`pipeline.test.mjs` asserts three things about this, so a regression fails the
suite rather than showing up on the bill:

1. The serialised `system` array is **byte-identical** across two assemblies
   with different questions and the same corpus.
2. In `JSON.stringify(body)`, the index of the instructions marker is less than
   the index of the first retrieved chunk ID, which is less than the index of
   the question text.
3. There is exactly one `cache_control` in the whole body and it is on the last
   `system` block.

### 8.4 Streaming

The proxy uses `client.messages.stream({...})` and forwards the SSE events to
the browser unchanged. Node side:

```js
const stream = client.messages.stream(validatedBody);
for await (const event of stream) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}
const final = await stream.finalMessage();   // for stop_reason and usage
```

`await stream.finalMessage()` is used rather than accumulating deltas by hand —
it handles completion, error, and abort states internally, and it is the only
reliable place to read `stop_reason` and `usage`.

Browser side, `claude.js` parses the SSE frames and calls `onText` for each
`content_block_delta` with a `text_delta`, and `onThinking` for each
`thinking_delta`. Three details:

- An SSE frame can split across TCP reads. The parser buffers until it sees a
  blank line; splitting on `\n\n` per chunk loses events at the boundary.
- `AbortController` is wired to the Stop button and to page unload. An
  abandoned stream is a request still being billed.
- Because a client disconnect does not automatically cancel the upstream
  request, the proxy listens for `res` close and calls `stream.abort()`.

### 8.5 Stop reasons and refusals

**Always check `response.stop_reason` before reading content.**

| `stop_reason` | Handling |
|---|---|
| `end_turn` | Normal. Validate citations (§9), render |
| `max_tokens` | The answer is truncated mid-sentence. Render what arrived, mark it truncated, offer a retry. Do not validate citations as complete — a cut-off answer legitimately has fewer than expected |
| `refusal` | A safety decline. `stop_details` is populated with a `category`. Render the category and the explanation; do not retry automatically |
| `pause_turn` | Not expected without server tools; if seen, surface it rather than treating it as success |

`stop_details` is **null for every stop reason except `refusal`**. Reading
`response.stop_details.category` unconditionally throws on the happy path. The
guard is:

```js
if (msg.stop_reason === 'refusal') {
  const category = msg.stop_details?.category ?? 'unspecified';
  // ...
}
```

### 8.6 Error taxonomy

The proxy catches the SDK's **typed** error classes, most specific first, and
maps each to a stable JSON shape the browser can branch on. Never string-match
an error message — messages are not an API.

| Caught | Proxy status | Browser `error` | UI |
|---|---|---|---|
| `Anthropic.BadRequestError` | 400 | `bad_request` | "The request was rejected." Show the message; this is a bug in the app, not the user |
| `Anthropic.AuthenticationError` | 502 | `bad_key` | "The server's API key was rejected." Enter retrieval-only mode |
| `Anthropic.RateLimitError` | 429 | `rate_limited` | Show `retry-after`, offer a retry button, keep the question |
| `Anthropic.APIError` | `err.status ?? 502` | `api_error` | Generic, with the typed status |
| Module not found | 503 | `no_sdk` | "Run `npm install`." |
| Key unset | 503 | `no_api_key` | Retrieval-only mode (§3.5) |

The ordering is not cosmetic. `Anthropic.APIError` is the base class with a
typed `status`, so catching it first would swallow every specific case above
it and collapse an authentication failure and a rate limit into one
indistinguishable branch.

---

## 9. Citation integrity

An answer that cites a chunk which was never retrieved is a fabrication that
looks exactly like a correct answer. Detecting it is cheap and not detecting it
makes the citations decorative.

`src/js/citations.js` is pure: strings in, verdicts out. No DOM.

### 9.1 Format

The system instructions require citations in the form:

```
[[c:notes.md#0007]]
```

placed immediately after the sentence they support. The ID grammar is
`docId#NNNN` where `docId` is the document name and `NNNN` is the zero-padded
ordinal — the same `Chunk.id` of §4.6.

Chosen over numeric markers like `[3]` because a number is a position in the
retrieved list and positions are ambiguous across turns, while a chunk ID is
globally stable and directly resolvable to a span in a document (§4.6). It is
also hard to produce by accident: a document containing the literal string
`[[c:` is vanishingly unlikely, whereas `[3]` appears in ordinary prose and in
every bibliography.

### 9.2 Validation against the retrieved set

```js
export const CITATION_RE;

/** Every citation token with its offsets in the answer. */
export function parseCitations(answer)

/** Judge each citation against the IDs that were actually sent. */
export function validateCitations(answer, retrievedIds)

/** Split the answer into text and citation segments for rendering. */
export function renderableSegments(answer, validated)
```

`validateCitations` returns:

```js
{
  citations: [{ raw, id, start, end, status }],
  verified: 4,
  unverified: 1,
  uncited: false,
}
```

`status` is one of:

| Status | Meaning |
|---|---|
| `ok` | The ID is in the retrieved set |
| `unknown` | Well-formed ID, **not** in the retrieved set |
| `malformed` | Matched the `[[c:` delimiter but not the ID grammar |

The critical detail: validation is against the **retrieved set** — the exact
IDs that were serialised into this request — and **not** against the whole
store. A citation to a chunk that exists in the corpus but was not retrieved is
still a fabrication, because the model could not have read it. Validating
against the store instead would let the most interesting failure through: a
model recalling a plausible chunk ID from the corpus manifest in the cached
system prefix (§8.3) and citing text it never saw.

`retrievedIds` is therefore passed as a `Set` built at request-assembly time
and carried alongside the answer, not re-derived afterwards.

### 9.3 Rendering an unverified citation

An `ok` citation renders as a chip: the document name and heading breadcrumb,
clickable, scrolling the source pane to `startOffset` and highlighting
`[startOffset, endOffset)` in the original text.

An `unknown` or `malformed` citation renders as a chip too — outlined in the
warning colour, labelled "unverified", carrying `aria-invalid="true"` and a
`title` explaining that the answer cited a chunk that was not retrieved. Above
the answer, `#citation-warning` appears:

> 1 of 5 citations could not be verified. The answer cites material that was
> not retrieved.

**The answer is still shown.** Suppressing it would hide the failure and leave
the user with an empty pane and no explanation; blocking on a single bad
citation would also discard four good ones. The defect is surfaced, not
hidden, and not fatal. That is the same principle as
[webgpu-particles](../../webgpu-particles/spec/SPEC.md) §9 — every failure path
renders text.

### 9.4 The uncited answer

The other failure shape: an answer with **zero** valid citations while chunks
were supplied. That is a model answering from parametric memory rather than
from the provided context, which is the exact failure a RAG system exists to
prevent, and it is invisible if you only count bad citations.

`validateCitations` sets `uncited: true` when `verified === 0` and the retrieved
set was non-empty. The UI shows a distinct banner:

> This answer cites no retrieved material. It may not be grounded in your
> documents.

### 9.5 Not a defence against a wrong answer

Citation validation proves that a cited chunk was retrieved. It does **not**
prove that the chunk says what the sentence claims. An answer can cite chunk 7
for a statement chunk 7 contradicts, and every citation will validate.

Closing that gap needs entailment checking between each sentence and its cited
chunk, which is a second model call per claim. It is a backlog item and it is
stated as a limitation in §15 rather than implied away by the presence of a
validator. What the validator buys is the elimination of the *cheap* failure —
invented references — so that the remaining failures are ones a reader can
catch by clicking the chip.

---

## 10. Architecture

```
  drop / paste
      │
      ▼
  main.js ──────── orchestrator: UI wiring, corpus lifecycle, mode
      │
      ├──▶ chunker.js       text -> Chunk[] with offsets        PURE
      │
      ├──▶ embedder.js      Transformers.js, WebGPU | wasm
      │         │            model cached by sw.js, cache-first
      │         ▼
      ├──▶ vectorStore.js   cosine + topK                       PURE
      │         │            IndexedDB: docs, chunks, vectors, meta
      │         ▼
      ├──▶ claude.js        assembleRequest()                   PURE
      │         │            SSE client, typed errors
      │         ▼
      │    ┌─────────────────────────────────────────────┐
      │    │  POST /api/claude   (same origin)           │
      │    │  ─────────────────────────────────────────  │
      │    │  server.js   allowlist -> @anthropic-ai/sdk │
      │    │              ANTHROPIC_API_KEY (env only)   │
      │    │              SSE passthrough                │
      │    └─────────────────────────────────────────────┘
      │                        │
      ▼                        ▼
  citations.js  ◀──────── answer text                          PURE
      │          validate every [[c:id]] against retrievedIds
      ▼
  answer pane + citation chips + unverified warning
```

| Module | Responsibility | Pure |
|---|---|---|
| `src/js/main.js` | UI wiring, corpus lifecycle, mode, diagnostics | No |
| `src/js/chunker.js` | Markdown → chunks with offsets | **Yes** |
| `src/js/embedder.js` | Transformers.js lifecycle, backend selection, batching | No |
| `src/js/vectorStore.js` | Similarity maths; IndexedDB persistence | Maths yes |
| `src/js/claude.js` | Request assembly; SSE parsing; error mapping | `assembleRequest` yes |
| `src/js/citations.js` | Citation parsing and validation | **Yes** |
| `server.js` | Static files + the `/api/claude` proxy | — |
| `sw.js` | Service worker: app shell network-first, model cache-first | — |

**The corpus never crosses the boundary.** Document text, chunks, and vectors
stay in the browser. What is sent is the eight retrieved chunks and the
question — a bounded, inspectable subset the user chose by asking.

---

## 11. Accessibility

| Surface | Treatment |
|---|---|
| Drop zone | `role="button"`, `tabindex="0"`, activates on Enter and Space, and has a real `<input type="file">` behind it. A drop-only target is unusable without a pointer |
| Drag state | Announced through `aria-live="polite"`, not only through a border colour |
| Corpus list | `<ul>` with per-document remove buttons carrying accessible names |
| Query | Labelled `<input>`; Enter submits; the Ask button's disabled reason is in `aria-describedby` |
| Streaming answer | `aria-live="polite"` on a container that is written to in sentence-sized flushes. Per-token live-region updates are unusable with a screen reader |
| Citation chips | `<button>`, focusable, named "Source: notes.md, Chunking > The numbers". Unverified chips add `aria-invalid="true"` |
| Mode banner | `role="status"`; the retrieval-only reason is readable, not implied by a greyed button |
| Focus | Visible rings via `:focus-visible`, never `outline: none` |
| Motion | `prefers-reduced-motion` removes the spinner animation and the streaming cursor blink |
| Colour | Verified and unverified citations differ by shape and label as well as by colour |

---

## 12. Testing strategy

Three suites, no dependencies, no browser, no GPU, no network, no API key.
`node tests/run.mjs`, or `npm test -- <suite>` for one. Each suite runs in its
own process so fake globals cannot leak between them, and the runner counts
lines with a `PASS` or `FAIL` prefix.

| Suite | Layer | Covers |
|---|---|---|
| `unit` | Pure functions | Chunker invariants, cosine and `topK`, citation validation |
| `boot` | App wiring against a fake DOM | Markup contract, retrieval-only mode, the same-origin rule |
| `pipeline` | Corpus → chunk → embed (stubbed) → retrieve → prompt | Ordering, the caching prefix, the request allowlist |

### 12.1 What is unit-tested

| Module | Property asserted |
|---|---|
| `chunker.js` | No chunk exceeds the ceiling; `text.slice(start, end) === body`; adjacent chunks overlap by `CHUNK_OVERLAP`; short sections merge forward; code fences are never split; heading paths are correct; IDs are unique and monotonic |
| `vectorStore.js` | `cosine` is 1 / 0 / −1 for identical, orthogonal, opposite; `cosine === dot` within `1e-6` for normalised input (§6.1); a zero vector scores 0, not `NaN`; `topK` is sorted descending, respects `SIM_FLOOR`, and breaks ties by index |
| `citations.js` | Offsets locate each token exactly; an ID outside the retrieved set is `unknown`; a broken ID is `malformed`; `uncited` fires on zero valid citations with a non-empty retrieved set; `renderableSegments` reassembles the original answer exactly |

### 12.2 What is contract-tested

`boot.test.mjs` runs the real `main.js` against a fake DOM parsed from
`index.html` and a fake `fetch`, and asserts:

- Every URL the app fetches is a same-origin path. **Nothing ever reaches
  `api.anthropic.com`.** This is the §3.1 invariant, expressed as a test
- With the proxy at 503 `no_api_key`: the banner is visible, the Ask button is
  disabled, and dropping a file still chunks and embeds
- With the proxy healthy: the banner stays hidden and the button is enabled
- The IDs `main.js` reads all exist in `index.html`

`pipeline.test.mjs` drives a stubbed embedder and asserts the **prompt caching
contract** of §8.3 and the **allowlist** of §3.3. Those two assertions exist
because both failures are invisible in normal operation: a caching regression
shows up only on the bill, and an allowlist widening shows up only when someone
abuses it.

### 12.3 Not covered

- **The real model.** `embedder.js` is never exercised against real weights.
  The stub returns deterministic vectors; nothing proves the WebGPU path
  initialises or that the wasm fallback triggers on the right failures.
- **Real IndexedDB.** The harness supplies an in-memory double covering the
  subset `vectorStore.js` uses. Transaction semantics, quota behaviour, and
  version-change events are untested.
- **The proxy itself.** `server.js` has no suite in 1.0. The allowlist is
  asserted from the client side — that the app sends only allowlisted fields —
  which is the weaker half. A server-side test that posts a rejected field and
  expects a 400 is the highest-value addition to the backlog.
- **Answer quality.** No labelled query set, so there is no recall or
  precision number anywhere in this document and none is implied.
- **Citation truthfulness.** §9.5.

Stating this is not a formality. The same gap upstream —
[galaxy-spiral](../../galaxy-spiral/spec/SPEC.md) §7.1 — is where a real defect
survived a green suite for a whole version, because the assertion measured a
statistic that could not distinguish right from wrong.

---

## 13. Failure modes

Every path renders text. There is no state in which the user sees an empty pane
with no explanation.

| Condition | Behaviour |
|---|---|
| `ANTHROPIC_API_KEY` unset | 503 `no_api_key` → retrieval-only mode, banner, disabled Ask button (§3.5) |
| `node_modules` missing | 503 `no_sdk` → "Run `npm install`", retrieval-only mode |
| Model download fails | Named error in the drop zone with the CDN URL and a retry button. The corpus is unaffected; chunks persist and can be embedded later |
| WebGPU unavailable or warm-up fails | Silent fall back to wasm; the backend and the reason appear in the panel (§5.3) |
| Chunk exceeds the model's 256-token window | Embedded truncated, counted, reported in the corpus list, flagged on its citation chips (§4.5) |
| Embedder version changed | `vectors` cleared, re-embed from stored chunks with visible progress (§7.2) |
| Chunker version changed | `chunks` and `vectors` cleared, re-chunk from `docs.text` (§7.2) |
| `QuotaExceededError` on write | Reported with current usage and quota; the document is not silently half-written |
| Every candidate below `SIM_FLOOR` | "No relevant chunks found." **No API call is made** (§6.4) |
| Corpus past `BRUTE_FORCE_CEILING` | Warning in the panel with the measured scan time (§6.2) |
| `stop_reason: 'refusal'` | Category and explanation from `stop_details`; no automatic retry (§8.5) |
| `stop_reason: 'max_tokens'` | Partial answer shown and marked truncated; retry offered |
| Rate limited | `retry-after` shown, retry button, question preserved (§8.6) |
| Unverified citation | Answer shown with warning-styled chips and a count banner (§9.3) |
| Zero valid citations | Distinct "not grounded" banner (§9.4) |
| Network lost mid-stream | Partial answer kept and marked incomplete; citations validated over what arrived |

---

## 14. Configuration

| Parameter | Location | Default |
|---|---|---|
| Chunk ceiling | `CHUNK_CEILING`, `chunker.js` | 900 chars |
| Chunk overlap | `CHUNK_OVERLAP`, `chunker.js` | 120 chars |
| Chunk minimum | `CHUNK_MIN`, `chunker.js` | 200 chars |
| Chunker version | `CHUNKER_VERSION`, `chunker.js` | `2026-09-30/h900-o120-m200` |
| Embedding model | `EMBEDDER_ID`, `embedder.js` | `Xenova/all-MiniLM-L6-v2@q8\|d384\|mean\|l2` |
| Transformers.js version | `TRANSFORMERS_VERSION`, `embedder.js` | `3.7.5`, from jsDelivr |
| Backend | `?backend=wasm` or `detectBackend()` | WebGPU, wasm fallback |
| Top-k | `TOP_K`, `vectorStore.js` | 8 |
| Similarity floor | `SIM_FLOOR`, `vectorStore.js` | 0.25 |
| Brute-force ceiling | `BRUTE_FORCE_CEILING`, `vectorStore.js` | 8 000 chunks |
| Vector dtype | `dtype` in the `vectors` store | `f32` |
| Model ID | `server.js`, pinned | `claude-opus-5-5` |
| `max_tokens` | `claude.js` request; proxy clamp | 16 000; clamp 64 000 streaming / 16 000 not |
| Effort | `output_config.effort`, `claude.js` | `medium` |
| Thinking display | `claude.js` | `summarized` |
| Rate limit | `server.js` | 10/min per IP, burst 3 |
| Body cap | `server.js` | 256 KB |
| Server port | `PORT` env, `server.js` | 5173 |
| API key | `ANTHROPIC_API_KEY` env **only** | unset |

The live app is exposed at `window.ragNotebook` for console inspection. It
exposes the corpus, the store, and the last assembled request — **never a key**,
because there is no key in the browser to expose.

---

## 15. Known limitations

1. **Citation validation proves retrieval, not truth.** A citation can be valid
   and still misattribute. Entailment checking is a backlog item (§9.5).
2. **No answer-quality measurement.** There is no labelled query set, so no
   recall or precision figure appears anywhere in this document. The chunking
   parameters of §4.3 are reasoned, not tuned.
3. **The brute-force ceiling is a calculation, not a benchmark.** §6.2 rests on
   a 1.0 µs per-comparison figure. It should be validated with a real
   measurement on a real corpus before anyone relies on the 8 000 number.
4. **First run needs network** for the ~25 MB model. It is not vendored into
   the repository — the same limitation Galaxy Spiral carries, and the same
   backlog item.
5. **`all-MiniLM-L6-v2` silently truncates at 256 tokens.** §4.5 mitigates and
   reports it; it does not eliminate it. Oversized code fences are embedded
   truncated by design.
6. **The proxy has no authentication.** It is a localhost dev server. Deployed
   beyond localhost, `/api/claude` is an open relay to a paid API and needs
   real auth before it is exposed. The allowlist and rate limit bound the
   damage; they do not prevent it.
7. **The rate limiter is in-process and in-memory.** It resets on restart and
   does not survive multiple workers.
8. **English-tuned chunking.** The sentence and paragraph boundary heuristics
   and the 4 chars/token estimate are tuned for English prose. CJK text
   tokenises at roughly 1 char/token, so the 900-character ceiling would exceed
   the model window by a factor of three.
9. **Single-turn only.** No conversation history, so a follow-up question is
   retrieved as though asked cold. Multi-turn retrieval needs query rewriting.
10. **No server-side test coverage.** §12.3.

---

## 16. Possible extensions

- Move the scan into a Worker, raising the brute-force ceiling from ~8 000 to
  ~100 000 chunks with no new data structure (§6.3)
- int8 quantisation past 20 000 chunks, with a measured recall number (§6.5)
- Collapse adjacent same-document chunks in the top-k as a parameter-free
  substitute for MMR (§6.4)
- A server-side suite that posts rejected fields at the allowlist and expects
  400s (§12.3)
- Entailment checking per claim against its cited chunk (§9.5)
- Vendor the model for a genuinely offline first run
- PDF and HTML ingestion, which is mostly a text-extraction problem and does
  not touch the retrieval stack
- Structured outputs (`output_config.format`) for a machine-readable
  claim-and-citation array instead of prose with inline markers
- HNSW, past ~100 000 chunks (§6.3)

---

## 17. Changelog

### 1.0 — Draft

Initial specification. **Unimplemented**: module skeletons throw
`NotImplemented`, and the test suites fail red by design. See
[CLAUDE.md](../CLAUDE.md) for the build order.

Derived from the series discipline with these decisions specific to this
project:

| Decision | Rationale |
|---|---|
| `server.js` gained a proxy endpoint | The API key cannot be in the browser, and a static-only server leaves nowhere else to put it (§3.1) |
| The proxy constructs rather than forwards | Forwarding a client body to a paid API is an open relay (§3.3) |
| Unknown request fields are a 400, not a drop | A silently discarded parameter is a bug that presents as working (§3.3) |
| Heading-aware chunking with a character ceiling | Fixed windows destroy structure, pure heading splits produce unusable extremes, and the character ceiling is computable before the tokeniser loads (§4.1) |
| `cosine` keeps the division despite normalised vectors | Costs nothing, and a future un-normalising model degrades quality instead of acquiring a length bias (§6.1) |
| Brute force, with the ceiling calculated | 8 000 chunks is far past what the app holds; HNOW would be machinery bought ahead of need (§6.2) |
| A Worker before an index | Removes the frame budget entirely for a `postMessage` boundary, which is the cheapest 12× available (§6.3) |
| Float32 in 1.0 | 9 MB saved is not worth a recall regression, and int8 is slower in scalar JS anyway (§6.5) |
| Citations validated against the retrieved set, not the store | Validating against the store admits the most interesting fabrication: a plausible ID recalled from the cached manifest (§9.2) |
| Unverified citations rendered, not suppressed | Hiding the defect leaves the user with no explanation and discards the good citations alongside the bad (§9.3) |
| Corpus manifest inside the cached prefix | Stable, useful, and lifts the prefix over the model-dependent cache floor — better than padding (§8.3) |
| `effort: 'medium'` set explicitly | It is also the default; pinning it means a future default change cannot silently re-tune every query (§8.2) |

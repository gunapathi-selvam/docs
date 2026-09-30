# RAG Notebook — Feature Document

**Version** 1.0 · **Date** 2026-09-30 · **Status** Draft (unimplemented)

The feature-oriented view. For formulas, chunking parameters, and security
rationale see [spec/SPEC.md](spec/SPEC.md). For what to build next see
[CLAUDE.md](CLAUDE.md).

---

## What it is

A single-page notebook. Drop markdown or plain text files onto the page. The app
splits them into heading-aware chunks, embeds every chunk in the browser with a
sentence-transformer running on WebGPU, keeps the vectors in memory and in
IndexedDB, and answers questions by retrieving the top-8 chunks by cosine
similarity and sending only those chunks plus the question to Claude for
synthesis. Every claim carries a citation back to a specific chunk, and every
citation is validated against the set that was actually retrieved.

The document text and the embeddings never leave the device. The only thing that
crosses the network is the eight retrieved chunks and the question.

---

## Feature inventory

### Document ingestion

| Detail | Value |
|---|---|
| Input formats | Markdown (.md), plain text (.txt, .markdown) |
| Ingestion method | Drag-and-drop onto the drop zone, or keyboard-activate the zone (Enter / Space) to open the file picker |
| Duplicate detection | SHA-256 of each file; re-dropping the same file is a no-op |
| Corpus list | One entry per document with chunk count, byte size, and a remove button |
| Persistence | Full document text stored in IndexedDB; re-chunking without re-dropping is possible |

### Chunking

| Detail | Value |
|---|---|
| Strategy | Heading-aware windows: split by ATX heading (# through ######), window long sections at the character ceiling, overlap to carry context across boundaries |
| Ceiling | 900 characters (~225 tokens, leaving headroom for the 256-token model window) |
| Overlap | 120 characters (~30 tokens, ~one sentence) |
| Minimum | 200 characters (shorter sections are merged forward) |
| Code fences | Emitted whole, never split mid-fence; flagged `truncatedByModel` if they exceed the ceiling |
| Breadcrumb prefix | Every chunk's embedded text is prefixed with its heading path ("Section > Subsection") for context |

### Embeddings

| Detail | Value |
|---|---|
| Model | `Xenova/all-MiniLM-L6-v2`, int8 quantised via Transformers.js |
| Dimensions | 384 |
| Max input | 256 wordpiece tokens (chunks approaching this limit are flagged) |
| Backend | WebGPU preferred; wasm fallback if WebGPU is unavailable or warm-up fails |
| Download | ~23 MB on first use; cached by service worker for subsequent visits |
| Batch size | 32 chunks per inference pass |

### Vector search

| Detail | Value |
|---|---|
| Algorithm | Brute-force cosine scan over a contiguous `Float32Array` |
| Top-k | 8 chunks per query |
| Similarity floor | 0.25 (below this, the chunk is not about the question) |
| Brute-force ceiling | 8 000 chunks (~6 MB of markdown, ~2 000 pages) |
| Corpus past ceiling | Warning shown in diagnostics panel; retrieval still works |
| Dtype | Float32 (1 536 bytes per vector) |

### Synthesis

| Detail | Value |
|---|---|
| Model | `claude-opus-5-5` (pinned server-side) |
| Mode | Streaming (`text/event-stream`) |
| max_tokens | 16 000 |
| Thinking | `{type:"adaptive", display:"summarized"}` |
| Effort | `medium` (set explicitly, not by default) |
| Prompt caching | Stable prefix (INSTRUCTIONS + corpus manifest) cached; chunks and question are volatile |
| Cache verification | `usage.cache_read_input_tokens` shown in diagnostics panel each response |

### Citation integrity

| Detail | Value |
|---|---|
| Format | `[[c:docId#NNNN]]` immediately after each supported sentence |
| Validation | Against the retrieved set only, not the full store |
| Verified chip | Blue, clickable, scrolls and highlights the source span |
| Unverified chip | Amber, outlined, `aria-invalid="true"`, explains the defect on hover |
| Uncited answer | Distinct banner: "This answer cites no retrieved material." |

### Retrieval-only mode

When `ANTHROPIC_API_KEY` is unset on the server, the proxy returns 503 and the
app enters retrieval-only mode. Chunking, embedding, and search all keep working.
Claude synthesis is disabled with a visible banner and a disabled Ask button.
The mode is determined at boot before the user types anything.

---

## Deliberate non-goals

These are choices, not gaps. Each is argued in the spec.

**No hosted service.** No account, no upload endpoint, no shared index. The
corpus lives in one browser profile's IndexedDB. SPEC §1.2

**No multi-turn conversation.** One question, one grounded answer, one set of
citations. Multi-turn retrieval is a different problem (query rewriting, history
compaction) and would crowd out the retrieval mechanics that are the subject.
SPEC §1.2

**No approximate nearest-neighbour index.** Brute force over the whole vector
set is the right answer at 8 000 chunks. HNSW would be machinery bought well
ahead of need. SPEC §6.3

**No query expansion or MMR.** Adding a lambda parameter without a labelled query
set to tune it against is worse than a simpler approach. Collapsing adjacent
same-document chunks (no parameter) is the backlog item. SPEC §6.4

**No server-side embeddings.** The embedding model runs client-side on purpose.
A server-side embedder would be faster and simpler and would also mean shipping
the user's documents to a server. SPEC §1.2

**int8 quantisation not in 1.0.** At 8 000 chunks the saving is 9 MB; not worth
a recall regression and a second serialisation path. int8 is slower in scalar JS
too. SPEC §6.5

---

## Known gaps

The suite runs without a browser, GPU, network, or API key. Three layers are
therefore untested by execution:

| Gap | Consequence | Gap described in |
|---|---|---|
| Real embedding model never runs | Truncation detection, WebGPU/wasm fallback path, normalisation check are untested | SPEC §12.3 |
| Real IndexedDB never runs | Transaction semantics, quota behaviour, version-change events are untested | SPEC §12.3 |
| `server.js` has no test suite | The allowlist is asserted client-side only; a server-side 400-for-rejected-field test is the highest-value addition | SPEC §12.3 |
| Citation truthfulness | Validation proves a chunk was retrieved, not that the answer correctly characterises it | SPEC §9.5 |

---

## Backlog

- Move the brute-force scan into a Worker, raising the ceiling from ~8 000 to
  ~100 000 chunks with no new data structure (SPEC §6.3)
- int8 quantisation past 20 000 chunks, with a measured recall number (SPEC §6.5)
- Collapse adjacent same-document chunks in the top-k as a parameter-free
  substitute for MMR (SPEC §6.4)
- Server-side test suite that posts rejected fields at the allowlist and expects
  400s (SPEC §12.3)
- Entailment checking per claim against its cited chunk (SPEC §9.5)
- Vendor the model weights for a genuinely offline first run (SPEC §2.2)
- PDF and HTML ingestion (text extraction, does not touch the retrieval stack)
- Structured outputs (`output_config.format`) for machine-readable claim-and-citation arrays
- HNSW index past ~100 000 chunks (SPEC §6.3)

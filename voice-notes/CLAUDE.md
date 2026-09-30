# Voice Notes — Claude Session Context

Read this first. It tells you what the project is, what is decided, and what to
build next. The authoritative detail is in [spec/SPEC.md](spec/SPEC.md) — this
file is the map, not the territory.

## Goal

A local-first voice notebook: record from the microphone, transcribe entirely in
the browser with Whisper via Transformers.js on WebGPU, and optionally send the
finished transcript text to Claude for a structured summary. Audio never leaves
the device. Only text the user has read and explicitly confirmed crosses the
network.

## Stack

- Vanilla JS ES modules, no build step
- `@anthropic-ai/sdk` — the one npm dependency, used only in `server.js`
- Transformers.js loaded as an ESM CDN module for Whisper inference
- AudioWorklet for capture and resampling (SPEC §4.2)
- Node built-in test runner via `node tests/run.mjs`
- Static server plus `/api/claude` proxy on port 5176

## Key design decisions

Each of these was decided deliberately; do not "fix" them without reading the
cited section first.

- **The API key never reaches the browser.** `server.js` is a static server plus
  a single field-allowlisted proxy endpoint. It reads `process.env.ANTHROPIC_API_KEY`
  and calls the Anthropic API on behalf of the browser. The browser never contacts
  `api.anthropic.com` and never sees the key. SPEC §11.1
- **Audio never crosses the network boundary, in any mode, on any code path.**
  `summarize.js` builds its request from `transcript.map(s => ({ t, text }))` and
  has no reference to the recorder module. The proxy rejects non-JSON content types
  and rejects unknown fields with a 400. `tests/pipeline.test.mjs` fails the suite
  if an audio buffer reaches the fake fetch. SPEC §3.4
- **No assistant prefill.** On `claude-opus-5-5` a trailing assistant turn returns
  HTTP 400. Structured outputs is the replacement, not a workaround. SPEC §10.3
- **Structured outputs via `output_config: { format: { type: 'json_schema', ... } }`.**
  The deprecated top-level `output_format` parameter is never used. SPEC §10.3
- **Thinking is `{ type: 'adaptive', display: 'summarized' }`.** `{ type: 'disabled' }`
  and `budget_tokens` both return 400 on this model. SPEC §10.2
- **`claude-opus-5-5`**, exactly that string. No date suffix. SPEC §10.1
- **Window 30 s, stride 25 s, overlap 5 s.** The window is fixed by the model's
  mel filterbank; the stride drives ~12-word overlaps sufficient for the anchor
  search. SPEC §5.2, §5.3
- **Stitching is pure.** `stitch.js` imports nothing, holds no state, and is
  tested exhaustively against adversarial canned fixtures. SPEC §6.6
- **Transcribe-only mode is not a degraded stub.** With no key set, the full local
  feature set works; only the Summarise button is disabled, with a reason shown.
  SPEC §13.3
- **`MIN_ANCHOR = 3` tokens.** A 1-token match on a common word is coincidence;
  three consecutive matching normalised tokens is evidence of alignment. SPEC §6.3
- **Chunk-and-reduce threshold is 12 000 estimated tokens** (chars / 3.5), about
  60 minutes of speech. Below it, one request. SPEC §12.1
- **Prompt caching order: system, then transcript, then instruction.** Varying
  the instruction (brief/standard/detailed) re-summarises without invalidating
  the cached transcript prefix. SPEC §10.6

## The four guards that are invisible when wrong

`tests/pipeline.test.mjs` asserts these. If you touch the summarise or proxy path,
keep them.

1. **Audio buffer check:** any `ArrayBuffer`, `TypedArray`, `Blob`, `FormData`, or
   base64 audio data-URL string reaching `fetch` fails the suite. SPEC §3.4, §15.4
2. **Stitch mid-word correctness:** on `midWordSeam`, `reconsider` appears exactly
   once, `recon` appears zero times, and no adjacent duplicate run of length >= 2
   exists in the token sequence. SPEC §6.4, §15.4
3. **Proxy field allowlist:** any key not in the allowlist (mode/length/transcript/
   summaries) returns 400 naming the offending key. SPEC §11.4
4. **No prefill path in `summarize.js`:** the request body is never constructed
   with an assistant-role message. SPEC §10.3

## Commands

| Command | Purpose |
|---|---|
| `node server.js` | Serve at http://localhost:5176 |
| `npm test` | Run all four suites |
| `npm test -- unit` | Run one suite by substring |

## Status

- [x] `spec/SPEC.md` — written
- [x] `FEATURES.md` — written
- [x] `README.md` — written
- [x] `src/js/` skeleton — module interfaces, throwing `NotImplemented`
- [x] `tests/` — harness plus assertions
- [x] `src/js/stitch.js` — stitching algorithm fully implemented and passing all fixtures
- [x] `src/js/worklet.js` — 31-tap Blackman-Harris FIR, fractional decimation, accumulator, level meter
- [x] `src/js/recorder.js` — getUserMedia, AudioContext, AudioWorklet, ring buffer, sliceWindow
- [x] `src/js/transcriber.js` — Transformers.js pipeline, WebGPU/wasm, watchdog, scheduleWindows
- [x] `src/js/summarize.js` — planRequest (map-reduce), summarise, validateSummary
- [x] `src/js/main.js` — fully wired: recorder, transcriber, stitcher, summariser, all UI events
- [x] 163 / 163 tests pass (0 failures)
- [x] Zero `NotImplemented` stubs remain
- [x] Headless Chrome renders page without JS errors

### Stitch algorithm notes

The anchor search uses ALL tokens from both windows (not just the overlap-region
midpoint filter). Proportional time distribution places the same word at very
different absolute times in the two windows, so the midpoint filter would discard
most real-world anchors. The overlap region bounds are retained for the time-cut
fallback only.

The time-cut fallback changed from `keepB = start >= tCut` to `keepB = end > tCut`,
so a word whose start is before the cut-point but whose end extends past it is
taken from B rather than dropped (fixes the mid-word seam case). A `dedupHead`
pass then removes from the start of keepB any tokens whose normalised form matches
the tail of keepA (fixes transitive three-window duplicates).

### Accessibility decision — summarise button

`checkApiStatus` uses `aria-disabled="true"` instead of the HTML `disabled`
attribute, keeping the button in the tab order. In `rag-notebook`, the same
pattern was removed because the button had a functional fallback. Here there is
no fallback — summarisation genuinely requires the API key — but discoverability
still matters: assistive technology must be able to reach the button to read the
banner explanation via `aria-describedby`.

### Remaining work

`worklet.js`, `recorder.js`, `transcriber.js`, `summarize.js`, and the full
`main.js` `init` function are still stubs. The stubs do not affect the passing
test count because those tests are skipped pending implementation.

## What to do next

Work in this order. Each step has tests waiting for it.

1. `src/js/worklet.js` — the `AudioWorkletProcessor`. FIR coefficients computed
   in the constructor, delay line persisting across quanta. SPEC §4.3.
2. `src/js/recorder.js` — `getUserMedia`, attach to an `AudioContext`, add the
   worklet, manage the ring buffer. SPEC §4.1–4.5.
3. `src/js/stitch.js` — anchored token-run merge. The `midWordSeam` and
   `silentOverlap` fixtures in `tests/audio-fixture.mjs` define the expected
   outputs precisely. Read SPEC §6 before touching this module. SPEC §6.3–6.5.
4. `src/js/transcriber.js` — Transformers.js pipeline, windowing, WebGPU with
   wasm fallback, 20-second watchdog, warm-up pass. SPEC §5.
5. `src/js/summarize.js` — browser client for `/api/claude`, structured-output
   schema, error handling. The schema is asserted in `tests/unit.test.mjs`.
   SPEC §9, §10, §11.2.
6. `server.js` — static server plus proxy. All eleven validation guards (SPEC
   §11.4), the field allowlist, the rate limiter, the `GET /api/claude/status`
   endpoint. SPEC §11.
7. `src/js/main.js` — orchestrator. Wire the modules together, render the
   transcript and summary panes, handle the confirmation affordance. SPEC §14.

Run `npm test` after each step. `unit` and `pipeline` are the meaningful gates.

## Traps specific to this project

- **The SDK import must stay inside `server.js`.** Nothing in the test path may
  import `@anthropic-ai/sdk` at module load — it is not installed and will throw.
  `summarize.js` is a browser module; it calls `fetch('/api/claude')`, not the SDK.
- **`worklet.js` is loaded via `audioWorklet.addModule()`, not as a normal
  import.** It cannot use ES module imports because AudioWorklet has a different
  global scope. Write it as a standalone script with `registerAudioProcessor`.
- **The FIR delay line must persist across render quanta.** Resetting it per
  quantum produces a 1.9 kHz buzz — each individual quantum looks correct, but
  the discontinuity at the boundary is audible and transcribable. SPEC §4.3.
- **`ctx.sampleRate` must be checked after construction**, not assumed. The
  `AudioContext` constructor argument is a request; a browser that cannot honour
  16 kHz returns the device rate instead of throwing. SPEC §4.3.
- **Anchor search is longest common *substring*, not subsequence.** A subsequence
  match on `the ... the ... the` would span the whole overlap; a substring match
  requires contiguity in both windows. SPEC §6.3.
- **Cut at the *end* of the anchor, not the start.** A broken word (e.g. `recon`)
  cannot match the complete word (`reconsider`) and so is never part of an anchor.
  The anchor ends before the break; everything after the cut comes from B, which
  has the complete word. SPEC §6.4.
- **`stop_reason` before touching `content`.** A truncated structured output is
  invalid JSON; checking `stop_reason === 'max_tokens'` first prevents a parse
  error from masquerading as a schema problem. SPEC §10.7.
- **`stop_details` is only populated for `stop_reason === 'refusal'`.** It is null
  for `end_turn`, `max_tokens`, and every other stop reason. Guard before reading.
  SPEC §10.7.
- **Bind `127.0.0.1` by default**, not `0.0.0.0`. A dev server holding a paid API
  key must not be on the LAN by default. SPEC §11.6.

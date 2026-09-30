# Voice Notes — Technical Specification

**Version** 1.0 · **Date** 2026-09-30 · **Status** Draft (unimplemented)

Fourth in the series after [galaxy-spiral](../../galaxy-spiral/spec/SPEC.md) and
[webgpu-particles](../../webgpu-particles/spec/SPEC.md). Galaxy Spiral proved
that a live camera stream can be run through an ML model in the browser and
never transmitted. This project applies the same posture to audio, and then
draws a deliberate line: the audio and the model stay local, and only text the
user has read and approved crosses the network.

---

## 1. Purpose and scope

### 1.1 What this project is

A single-page local-first voice notebook.

1. The user records from the microphone.
2. Whisper runs **entirely in the browser** — Transformers.js on WebGPU, model
   `Xenova/whisper-tiny.en` fetched once from a CDN — and produces a
   timestamped transcript.
3. The user may then send **the finished transcript text** to Claude for a
   structured summary: title, key points, action items, open questions. Each
   summary line carries the transcript timestamp it came from and clicking it
   seeks the audio.

Step 3 is optional. Steps 1 and 2 are the product.

### 1.2 What it deliberately is not

- **Not a cloud transcription client.** No audio, in any encoding, in any mode,
  reaches any server. This is an invariant with a test attached (§3.4, §15.4),
  not a preference.
- **Not a keyless-browser design.** The Anthropic API key lives in the Node
  process and nowhere else. `server.js` is therefore a static server *plus one
  proxy endpoint* (§11) rather than a pure static server, which is the single
  structural departure from the rest of the series.
- **Not summarise-or-nothing.** With no key configured the app runs in
  **transcribe-only mode** (§13) with every local feature intact. A degraded
  stub would undercut the thesis; transcribe-only is the thesis.
- **Not a diariser.** Speaker labels are out of scope — see §18 for why the
  cheap version is worse than none.
- **Not multilingual.** `whisper-tiny.en` is English-only, deliberately, for the
  size budget. §18 covers the swap.

### 1.3 Learning goals

| Goal | Where it appears |
|---|---|
| `getUserMedia` → AudioWorklet capture and resampling | §4 |
| Anti-aliased decimation to 16 kHz in a worklet | §4.3 |
| Sliding-window inference over a fixed-input model | §5.3 |
| Merging overlapping ASR windows without duplicating or losing words | §6 |
| Honest timestamp accuracy under a model that *generates* its timings | §7 |
| A 40 MB model load that does not ruin a first visit | §8 |
| WebGPU vs wasm for transformer inference | §5.4 |
| Keeping an API key server-side behind a non-relaying proxy | §11 |
| Structured outputs for a fixed-shape response | §10.3 |
| Prompt caching arithmetic that is actually worth doing | §10.6 |
| Chunk-and-reduce instead of silent truncation | §12 |
| Making a network boundary visible in a UI | §3, §14.4 |

---

## 2. Platform requirements

### 2.1 Hard requirements

| Requirement | Reason |
|---|---|
| Secure context (`https://` or `http://localhost`) | `getUserMedia` and `navigator.gpu` are both gated on it; a `file://` URL cannot record |
| `AudioWorklet` (`AudioContext.audioWorklet.addModule`) | §4.2. Chrome 66+, Safari 14.1+, Firefox 76+ |
| ES modules, dynamic `import()` | Transformers.js is loaded as an ESM CDN module |
| Cache Storage API | Model persistence across visits (§8.3) |
| ~60 MB free origin quota | 40 MB of model plus headroom |

### 2.2 Soft requirement

`navigator.gpu`. WebGPU is roughly an order of magnitude faster than wasm for
this model (§5.4) and is the default when present. Its absence is a performance
story, not a failure: the app falls back to wasm and says so in the panel.

### 2.3 Verified browsers

Chrome 121+, Edge 121+, Safari 18+ for the WebGPU path. Firefox 141+ and Safari
14.1–17 take the wasm path. No browser is unsupported outright; the slow path is
labelled, not hidden.

---

## 3. The privacy boundary

This section is the project's thesis. Everything else is in service of it.

### 3.1 Every datum, where it lives, and whether it leaves

| Datum | Where it lives | Crosses the network? |
|---|---|---|
| Microphone PCM at the device rate | One 128-frame render quantum inside the AudioWorklet, overwritten every 2.7 ms at 48 kHz | **Never.** Not reachable from the main thread at all |
| Resampled 16 kHz mono float32 | `recorder.js` ring buffer on the main-thread JS heap. Not IndexedDB, not `localStorage`, not a `Blob` URL | **Never** |
| 30-second analysis windows | Transferred `ArrayBuffer`s handed to `transcriber.js` | **Never** |
| `MediaStream` / `MediaStreamTrack` | Held for the duration of the recording, `stop()`ed on finish | **Never.** No `MediaRecorder`, no `RTCPeerConnection`, no upload form |
| Whisper weights, tokenizer, config | Cache Storage, origin-scoped, ~40 MB | **Inbound only.** One GET per file to the Hugging Face CDN, once ever |
| Transcript segments (`{ t, text }`) | Main-thread JS heap. `localStorage` only if the user presses Save | **Only** on the explicit Summarise confirmation (§3.3), as JSON, to our own origin |
| Summary object | Main-thread JS heap | Returned from our own origin |
| `ANTHROPIC_API_KEY` | `process.env` in the Node process | **Never.** Not in any response body, not in any log line, not in any error surface (§11.6) |

### 3.2 What is not present

No analytics. No telemetry. No error reporting. No fonts, scripts, or
stylesheets from a third party except the one Transformers.js module and the one
model download. No cookies. No `beforeunload` beacon. `server.js` writes one
line per request to stdout and that line contains a method, a path, and a status
code — never a body.

### 3.3 The two user actions that produce outbound traffic

1. **Pressing "Download model" (~40 MB)** — a GET to the CDN. Carries no user
   data. Deliberately a button rather than an automatic page-load fetch, because
   nobody should receive a 40 MB download for visiting a page (§8.2).
2. **Confirming "Send transcript to Claude"** — a POST to `/api/claude` on our
   own origin, body containing transcript text and a length preference and
   nothing else (§11.2).

There is no third. Recording, transcription, playback, seeking, search, export,
and local save all complete with the network disconnected, once the model is
cached.

### 3.4 The audio invariant

> **No audio buffer, in any representation, at any sample rate, in any encoding,
> can reach the network boundary — in either mode, on any code path.**

Enforced in four places, because one place is a preference and four is an
invariant:

1. `summarize.js` builds its request body from `transcript.map(s => ({ t, text }))`
   and has no reference to the recorder module. It cannot see a buffer.
2. The proxy rejects any `Content-Type` that is not exactly `application/json`
   (§11.3), which structurally forbids a multipart or `audio/*` upload.
3. The proxy's field allowlist *rejects* unknown keys with a 400 naming them
   rather than silently stripping them (§11.4), so a buffer smuggled under a new
   key fails loudly.
4. `tests/pipeline.test.mjs` installs a fake `fetch` that inspects every
   outbound body for `ArrayBuffer`, `TypedArray`, `Blob`, `FormData`, and for
   any string carrying a base64 audio data-URL prefix, and **fails the suite** if
   one appears. The test drives a real recording fixture through the full
   capture → window → stitch → summarise path first, so it is testing the live
   path and not an empty one (§15.4).

---

## 4. Audio capture

### 4.1 What Whisper needs

16 kHz, mono, `Float32Array`, samples in `[-1, 1]`. Not negotiable — the mel
filterbank is defined against a 16 kHz spectrum and feeding 48 kHz produces a
transcript that reads like a sped-up tape.

`getUserMedia` gives 48 kHz on almost every device and 44.1 kHz on the rest.
Something has to resample, and the choice of *where* is the interesting part.

### 4.2 Why an AudioWorklet and not a `ScriptProcessorNode`

| | `ScriptProcessorNode` | `AudioWorklet` |
|---|---|---|
| Thread | Main thread | Dedicated audio rendering thread |
| Status | Deprecated since 2014 | Current |
| Buffer | 256–16384 frames, author's choice | Fixed 128-frame render quantum |
| Failure under main-thread load | Dropped buffers — **silent gaps in the recording** | Unaffected |

The failure mode is what decides it. A `ScriptProcessorNode` competes with
layout, paint, and — in this app — with 30-second Whisper windows running on the
main thread. Under that load it drops buffers, and a dropped buffer in a
recording is not a glitch you hear and re-record; it is a hole in the transcript
that nothing downstream can detect. The worklet's render thread is not affected
by main-thread work, so capture is continuous even while a window is decoding.

Two consequences follow, and both are load-bearing:

- **The worklet is also the right place for the resample.** Doing it on the main
  thread would mean shipping 48 kHz across the `postMessage` boundary — three
  times the data — and then doing the filter work in the same queue that the
  inference is in.
- **Nothing on the main thread ever holds a device-rate buffer.** That is what
  makes row 1 of §3.1 a structural claim rather than a promise.

### 4.3 The resampling path

**Primary path — let the browser do it.** Construct the context at the target
rate:

```js
const ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
```

A `MediaStreamAudioSourceNode` attached to a 16 kHz context is resampled by the
browser's own resampler, which is SIMD, polyphase, and better than anything
worth hand-writing. `ctx.sampleRate` must be checked after construction: the
constructor argument is a request, and a browser that cannot honour it returns
the device rate instead of throwing.

**Fallback path — resample in the worklet.** When `ctx.sampleRate !== 16000`,
`worklet.js` decimates. Naively picking every third sample at 48 kHz folds all
content between 8 kHz and 24 kHz back into the 0–8 kHz band as aliasing, which
Whisper hears as a sibilant hiss and which measurably costs word accuracy. So:

1. **Low-pass first.** 31-tap windowed-sinc FIR, Blackman–Harris window, cutoff
   7 200 Hz (0.45 × 16 kHz). 31 taps gives about 60 dB of stopband rejection,
   which is below the quantisation floor of the input. Coefficients are computed
   once in the processor constructor, never per quantum.
2. **Then decimate.** For an integer ratio (48 000 / 16 000 = 3) take every third
   filtered sample. For a fractional ratio (44 100 / 16 000 = 2.756 25) advance a
   fractional read cursor and linearly interpolate between the two nearest
   filtered samples. Linear interpolation is acceptable *only because* the signal
   is already band-limited to 7.2 kHz by step 1 — on an unfiltered signal it is
   itself an aliasing source.
3. The FIR delay line (31 samples) persists across render quanta. Resetting it
   per quantum would put a 31-sample discontinuity every 2.7 ms — an audible
   1.9 kHz buzz and a genuinely surprising bug, because each individual quantum
   looks correct.

### 4.4 Buffer sizes

| Buffer | Size | Rationale |
|---|---|---|
| Render quantum | **128 frames** | Fixed by the Web Audio spec. Not a choice |
| FIR delay line | **31 samples** at the input rate | Filter length; persists across quanta |
| Worklet output block | **1 280 frames @ 16 kHz = 80 ms** | 1 280 / 128 = 10 input quanta exactly at 48 kHz, so no partial-quantum bookkeeping. 12.5 `postMessage` calls/second, each a transferred 5 120-byte buffer — negligible against a 60 Hz frame budget |
| Level-meter aggregate | **8 quanta ≈ 21 ms** | Peak and RMS computed per quantum in the worklet, posted every 8th. ~47 Hz, fast enough to look live, slow enough not to flood the port |
| Main-thread ring buffer | **grown in 16 s chunks (256 000 frames, 1 MB)** | 64 KB/s, 3.84 MB/minute. A 10-minute note is 38 MB of heap. Hard cap 60 minutes (230 MB); a warning appears at 30 minutes (§17.5) |
| Analysis window | **480 000 frames = 30.0 s** | The model's fixed input (§5.2) |

The worklet posts, the main thread appends, and the window scheduler reads —
three roles over one ring, with the write cursor owned solely by the append path.

### 4.5 Timebase

The worklet maintains a monotonic **frame counter** of 16 kHz output samples
produced since capture began, and stamps every posted block with the counter
value at its first sample. Every downstream offset — window starts, segment
times, seek targets — derives from that counter, never from `Date.now()` or
`ctx.currentTime`.

A frame counter cannot drift, because it *is* the definition of position in the
recording. Wall clock can and does: it moves under NTP correction, and
`ctx.currentTime` advances on the audio clock, which is a different crystal from
the system clock and diverges by tens of milliseconds a minute on cheap
hardware. Anchoring on the counter makes the *window* contribution to timestamp
error exactly zero (§7.2), which matters because the model's own contribution is
not small.

---

## 5. Transcription

### 5.1 Model

`Xenova/whisper-tiny.en`, ONNX, via Transformers.js `pipeline('automatic-speech-recognition', ...)`.

| Variant | Encoder | Decoder | Total incl. tokenizer + config | Used on |
|---|---|---|---|---|
| fp16 | ~16 MB | ~24 MB | **~41 MB** | WebGPU |
| q8 | ~9 MB | ~23 MB | **~33 MB** | wasm |

Quoted throughout as "~40 MB", which is the WebGPU default and the honest
number to put in front of a user before they press the button.

`tiny.en` is chosen over `base.en` (~145 MB) because the size dominates the
first-run experience and `tiny.en` is good enough for note-taking on clear
single-speaker audio. §18 covers making it a choice.

### 5.2 Why the window is exactly 30 seconds

Whisper's encoder input is fixed at 3 000 mel frames = 30 s. Shorter audio is
zero-padded to 30 s before the encoder runs, so **a 5-second window costs the
same encoder pass as a 30-second one**. Feeding short windows is strictly worse:
same compute, less context, more seams to stitch.

So every window is exactly 30.0 s (480 000 frames). The final window of a
recording is zero-padded, which is the one place padding is correct.

### 5.3 Window length and overlap

| Parameter | Value |
|---|---|
| Window length | **30.0 s** (480 000 frames) |
| Stride | **25.0 s** (400 000 frames) |
| Overlap | **5.0 s** (80 000 frames) |
| Redundant compute | 5 / 30 = **16.7 %** |

**Why 5 seconds.** The overlap has exactly one job: contain enough text for the
stitcher to find an anchor both windows agree on (§6.3). At a conversational
2.5 words/second, 5 s is about 12 words — comfortably more than the 3-token
minimum anchor, with room for the first and last second of the overlap to be
garbage (window edges are where Whisper is least reliable).

The bounds either side are real:

- **Below ~2 s** the overlap can be entirely silence, or one filler word, and
  the anchor search finds nothing. The time-based fallback (§6.5) then runs on
  most seams instead of a few, which is the mode this design exists to avoid.
- **Above ~8 s** redundant compute passes 27 % and the extra matching confidence
  is nil — the anchor was already found in the first 3 seconds.

5 s is also convenient: 25 s of stride means a partial transcript lands roughly
every 25 s of speech during a live recording, which reads as continuous progress
rather than a stall.

### 5.4 WebGPU versus wasm

Order-of-magnitude figures for one 30 s window of `tiny.en` on a 2023-class
laptop:

| Backend | Per 30 s window | Real-time factor | Notes |
|---|---|---|---|
| WebGPU, fp16 | **0.6 – 1.2 s** | ~25–50× | Default when `navigator.gpu` resolves an adapter |
| wasm, SIMD, 4 threads, q8 | **6 – 14 s** | ~2–5× | Fallback. Still faster than real time, but the tail is visible |

Call it **10×**. Both stay ahead of a live recording, so both are usable; the
difference is whether a 40-minute note finishes transcribing in about a minute
or in about ten.

**Default WebGPU, with two escapes.**

1. `navigator.gpu` absent, or `requestAdapter()` resolves null → wasm, panel says
   so.
2. WebGPU present but the first real window exceeds a **20-second watchdog** →
   abandon WebGPU, re-init on wasm, keep the queued windows. A broken or
   software-emulated adapter can be slower than wasm, and there is no capability
   bit that tells you in advance. Measure, then decide.

**The first WebGPU window is not representative.** It includes shader
compilation and pipeline creation, 2–4 s on top. So immediately after load the
transcriber runs a **warm-up pass over 30 s of silence**, reports "warming up"
in the status line, and discards the result. Without it the user's first window
looks like the slow path and the panel's timing readout lies for the rest of the
session.

### 5.5 Queueing

Windows are transcribed strictly in order, one at a time. Concurrency is not
attempted: two windows in flight on one GPU adapter contend for the same memory
and finish later than they would in sequence, and out-of-order completion would
have to be reordered before stitching anyway.

**Capture never waits for inference.** If the queue is behind — always true on
wasm, briefly true on WebGPU after a cold start — windows accumulate in the ring
and drain afterwards. The UI shows a queue depth. This is why the model download
does not block recording (§8.2): a user who presses Record on a cold first visit
must not lose their recording to a progress bar.

---

## 6. Window stitching

**This is the hardest part of the project.** Everything else is plumbing around
a model call; this is a real algorithm with real failure modes, and it lives
alone in a pure module (`src/js/stitch.js`) so it can be tested exhaustively.

### 6.1 The problem

Two consecutive windows overlap by 5 s, so the same speech is transcribed twice.
Naive concatenation duplicates it. Naive cutting at the nominal boundary is
worse: Whisper does not stop at the boundary the scheduler chose, so a word
straddling it comes out as

```
window A tail : ... "we should probably recon"
window B head : "reconsider the deadline before" ...
```

Concatenating gives `we should probably recon reconsider the deadline`. Cutting
A at its last token and taking all of B gives `we should probably recon
reconsider ...` as well. Cutting A at the boundary time and B at the boundary
time can drop the word entirely. All three are wrong, and all three are wrong
*quietly* — the transcript still reads like a transcript.

### 6.2 Shape of the data

`transcribe()` returns, per window, window-local times:

```js
{ windowStart: 25.0,            // absolute, from the frame counter (§4.5)
  segments: [ { start, end, text }, ... ] }
```

`stitch.js` works on **tokens**, not segments, because the seam falls inside a
segment far more often than between two. Tokenisation (`tokenizeSegments`) splits
on whitespace, distributes each segment's `[start, end]` across its words
proportionally to character length, and attaches a normalised form:
lowercase, Unicode NFKD, combining marks and all punctuation stripped, digits
kept. `"Don't,"` and `"dont"` both normalise to `dont`, so a punctuation
disagreement between windows cannot break an anchor.

### 6.3 The algorithm — anchored token-run merge

For each consecutive pair (A earlier, B later):

1. **Overlap region** is `[B.windowStart, A.windowStart + 30]` in absolute time —
   5.0 s by construction, but computed rather than assumed, so a future stride
   change needs no edit here.
2. **`tailA`** = A's tokens whose midpoint falls in the overlap region.
   **`headB`** = B's tokens whose midpoint falls in it. Midpoint, not start, so a
   token spanning the region edge is assigned once and to one side.
3. **Anchor search.** Find the longest run of tokens that is *contiguous in both*
   `tailA` and `headB` when compared on the normalised form — a longest common
   substring over the two token arrays, not a subsequence. Scored by run length;
   ties broken by the smaller `|tailA[i].start - headB[j].start|`, because when
   a phrase legitimately repeats in the overlap ("no, no, no") the right
   occurrence is the one at the right time.
4. **Minimum anchor length is 3 tokens** (`MIN_ANCHOR = 3`). A 1-token match on
   `the` is not evidence of alignment; it is a coincidence, and acting on it
   silently deletes or duplicates the words around it. Three is the smallest run
   that is unlikely to be accidental in a 12-word overlap.
5. **Cut at the *end* of the anchor.** With an anchor at `tailA[i .. i+L-1]` ≡
   `headB[j .. j+L-1]`, emit everything in A up to and including `tailA[i+L-1]`,
   then everything in B from `headB[j+L]` onward. A's tokens after the anchor are
   discarded; B's tokens before it are discarded.

### 6.4 Why cutting at the end of the anchor is the correct choice

This is the whole trick, and it is worth being explicit because cutting at the
*start* of the anchor looks equally reasonable and is not.

- **A broken word is always taken whole from B.** `recon` (A's truncated tail)
  does not normalise to `reconsider` (B's complete word), so it can never be part
  of an anchor. The anchor therefore ends at or before the last token both
  windows agree on, which is before the break. Everything after the cut comes
  from B, and B has the complete word. A is closer to *its* window edge than B
  is, so where they disagree B is the better source — by construction.
- **Nothing is emitted twice.** The anchor tokens are emitted exactly once, from
  A. B's copies are discarded along with B's head.
- **Nothing is dropped.** The only tokens discarded are ones the other window
  also contains — A's post-anchor tail and B's pre-anchor head both lie inside
  the overlap region, which both windows cover.

Cutting at the *start* of the anchor would instead emit the anchor from B, which
means discarding A's copy of tokens that precede the break and keeping B's — fine
for the anchor itself, but it moves the seam earlier into A's tail, which is A's
*least* reliable region. End-of-anchor puts the seam as late as the evidence
allows.

### 6.5 When there is no anchor

Possible and not rare: a 5-second overlap can land entirely in silence, in
non-speech, or in two genuinely different hallucinations. With no run of ≥ 3
matching tokens:

1. Cut at the **midpoint of the overlap region**, `tCut = (B.windowStart + A.windowStart + 30) / 2`.
   Keep A's tokens ending before `tCut` and B's tokens starting at or after it.
2. Record `{ method: 'time', confidence: 'low', at: tCut }` on the seam.
3. The UI marks the seam in the transcript with a hairline rule and a tooltip.

**Never silent.** A low-confidence seam is where a duplicated or missing phrase
will be if one exists, and the user is the only one positioned to notice. Hiding
it would make the transcript look more trustworthy than it is.

`stitchWindows` returns `{ tokens, segments, seams }`. `seams` is part of the
contract, not diagnostics: `main.js` renders it and `tests/unit.test.mjs`
asserts on it.

### 6.6 Purity

`stitch.js` imports nothing, touches no global, and holds no state. Given the
same array of window results it returns the same transcript. That is why the
fixtures in `tests/audio-fixture.mjs` can encode hand-checked correct outputs
for a set of adversarial seams — including a mid-word seam, a repeated-phrase
seam, a silent seam, and a seam where one window hallucinates a sentence the
other does not have — and simply compare.

---

## 7. Timestamp alignment

### 7.1 What Whisper actually gives you

Two options in Transformers.js:

- `return_timestamps: true` — segment-level. The model emits timestamp *tokens*
  from a 0.02 s vocabulary, quantised in practice to a much coarser grid.
- `return_timestamps: 'word'` — word-level, derived by DTW over the decoder's
  cross-attention weights.

We use `'word'` where the backend supports it and fall back to segment-level
otherwise, then redistribute segment times across words by character length
(§6.2) so the token array has the same shape either way.

**The load-bearing fact: these timings are generated, not measured.** Timestamp
tokens are decoder output. The decoder can be wrong about them in exactly the way
it can be wrong about a word, and it is more wrong near window edges, in silence,
and under crosstalk. The DTW path is better because it is derived from attention
rather than sampled, but it inherits the same uncertainty.

### 7.2 Error budget

| Source | Contribution | Notes |
|---|---|---|
| Window offset | **0 ms** | Derived from the frame counter (§4.5), which defines position |
| FIR group delay | **~0.65 ms** | 31 taps at 48 kHz, constant. Below noise; not corrected |
| Resampler phase | **< 1 ms** | Constant offset |
| Whisper segment timing | **±200–500 ms typical, worse at window edges** | Dominates everything else by two orders of magnitude |
| Whisper word timing (DTW) | **±100–200 ms on clean single-speaker speech; ±500 ms+ with noise, accents, or crosstalk** | Dominates |
| Stitch seam | **0 ms for anchored seams** — tokens keep their source window's times. Up to **±2.5 s for a time-cut seam** (§6.5) | Which is why low-confidence seams are marked |

### 7.3 What we claim

> **±0.5 s for segment-level timestamps on clear single-speaker audio, and no
> better.** Word-level DTW is often ±0.15 s but is not relied on anywhere in the
> UI, because "often" is not a specification.

Three design consequences follow directly, and each exists because the accuracy
is what it is:

1. **Display `mm:ss`, never finer.** Rendering `04:17.34` claims centisecond
   accuracy we do not have. `04:17` claims one second, which we do have.
2. **Seek 0.75 s early.** Clicking a summary line or transcript row seeks to
   `max(0, t − 0.75)`. Deliberately asymmetric: landing slightly early means the
   phrase you clicked for is ahead of the playhead and you hear it. Landing
   slightly late means you have already missed it and have to scrub backwards,
   which is a much worse interaction for the same magnitude of error.
3. **Highlight the transcript row, and trust the text over the audio.** The
   authoritative link between a summary line and the transcript is the *segment
   index*, resolved by §10.5. The audio seek is a convenience built on top of it.
   If the timing is off by a second the highlighted row is still correct.

---

## 8. Model loading

### 8.1 The problem

~40 MB (§5.1). An unannounced 40 MB download with no progress indication is a
bad first run at any connection speed and an unusable one on a slow link:

| Downlink | Cold load |
|---|---|
| 100 Mbps | ~4 s |
| 20 Mbps | ~17 s |
| 5 Mbps | ~65 s |
| 1 Mbps | **~5.5 minutes** |

### 8.2 Loading UX

- **Explicit opt-in.** A "Download speech model (~40 MB)" button. The size is on
  the button face, before the press. Nothing large is fetched on page load.
- **Real progress, weighted by bytes.** Transformers.js `progress_callback`
  reports `{ status, file, loaded, total, progress }` per file. The aggregate is
  `Σ loaded / Σ total`, **not** the mean of per-file percentages — the decoder is
  around 2.5× the encoder, so a per-file mean jumps from 50 % to 90 % when the
  small file finishes and then appears to hang. Files whose `total` is not yet
  known are excluded from the denominator rather than counted as zero.
- **Bytes and a rate.** `12.4 / 41.0 MB · 1.8 MB/s · about 16 s left`, from a
  rolling 3-second throughput average. A percentage alone does not tell a user on
  a slow link whether to wait.
- **Below 400 kB/s**, the message changes to name the real duration and point at
  the thing they can do meanwhile: *"About 4 minutes at this speed. You can start
  recording now — transcription begins when the model is ready."*
- **Recording is available immediately**, before and during the download.
  Captured audio buffers to the ring and windows queue (§5.5). This is the most
  important property of the loading UX and it is an architectural one, not a
  cosmetic one.
- **Warm-up after load** (§5.4), reported distinctly from downloading, so the
  first real window is fast and the panel's timings are honest.

### 8.3 Cache strategy

Specified here; **not implemented — see §17.1.**

Two cache names, never one:

| Cache | Strategy | Contents |
|---|---|---|
| `vn-shell-v1` | **Network-first**, fall back to cache | `index.html`, `src/**`, the Transformers.js module |
| `vn-model-v1` | **Cache-first**, never revalidated | Model weights, tokenizer, config |

- Model files are content-addressed by the Hugging Face revision pinned in
  `transcriber.js`, so a cache-first entry cannot go stale. Revalidating 40 MB on
  every visit to confirm it has not changed would defeat the point.
- Separate names mean **a shell deploy never evicts the model.** One cache with
  one version would re-download 40 MB on every code change, which during
  development is most page loads.
- Network-first on the shell means a deploy is picked up on the next load rather
  than pinned until a version bump.
- `QuotaExceededError` on a model `put` is caught and **falls through to
  network**. Failing the load because a cache write failed would turn a
  performance optimisation into an outage.
- Quota: 40 MB against a typical origin allowance (a large fraction of free
  disk). Safe on a laptop; checked with `navigator.storage.estimate()` before
  the download and warned about if the headroom is under 100 MB.

---

## 9. Summarisation — what it produces

One object, fixed shape:

| Field | Type | Notes |
|---|---|---|
| `title` | string | ≤ 80 chars |
| `key_points` | array of `{ text, t }` | 3–12 items |
| `action_items` | array of `{ text, t, owner? }` | 0–20. `owner` omitted when unattributed rather than guessed |
| `open_questions` | array of `{ text, t }` | 0–10 |

Every `t` is seconds into the recording, and is what the summary line links to.
That is the feature: a summary you can audit against the audio, line by line.

---

## 10. Summarisation — the Claude request

All of this happens **server-side** in `server.js`. The browser sends transcript
text and a length preference (§11.2) and receives a summary object. It never
sees a model ID, a token budget, or a key.

### 10.1 Model

```
claude-opus-5-5
```

Exactly that string. No date suffix.

### 10.2 Thinking, effort, and token budget

```js
{
  model: 'claude-opus-5-5',
  max_tokens: 8000,
  thinking: { type: 'adaptive', display: 'summarized' },
  output_config: { effort: 'medium', format: { type: 'json_schema', schema: SUMMARY_SCHEMA } },
}
```

**Thinking.** `{ type: 'adaptive', display: 'summarized' }`, or omit the
parameter entirely. On this model `{ type: 'disabled' }` returns HTTP 400 and so
does `budget_tokens` — there is no thinking budget to tune on `claude-opus-5-5`,
and effort is the only depth control. `display: 'summarized'` is set because the
proxy streams and the summary reasoning is a useful "still working" signal for a
request that can take 20 seconds on a long transcript; the default is `omitted`,
which streams empty thinking blocks and looks like a stall.

**Effort.** `medium`, which is this model's default, with `low` for the map stage
of §12 as a *pending* change. The argument and the measurement, in order:

Summarisation is not a hard reasoning task. It is extraction plus compression
over text that is already in the context — no multi-step deduction, no tool use,
no long horizon. The prior is that `low` is sufficient and `high` is waste, and
the series' discipline is to state what would establish that.

*The measurement this spec specifies:* a 12-transcript fixture set — 6 meetings,
3 lectures, 3 voice memos, each hand-labelled with the key points, action items,
and supporting segment a careful human would pick — scored on three axes:

| Axis | Metric |
|---|---|
| Recall | fraction of hand-labelled key points present in the summary |
| Precision | count of `action_items` that are not actually action items |
| Attribution | fraction of `t` values landing within ±2 s of the hand-labelled supporting segment |

*The expectation:* `low` matches `medium` on recall and precision for
single-speaker memos and lectures, and loses on **attribution** for multi-speaker
meetings — where the cheap failure is attributing a decision to the first mention
of the topic rather than to the segment where it was actually decided.

*The honest part:* **this measurement has not been run**, because nothing in this
project is implemented. Until it has, the shipped value is `medium` everywhere —
the model's default, and the choice that requires no justification. `low` on the
map stage is a documented, argued, *gated* change, not a shipped one. Treating an
unmeasured guess as a finding is the failure mode this note exists to prevent.

**`max_tokens: 8000`.** Not a cost control — billing is on tokens generated, so a
high cap costs nothing unused. It is a runaway guard. The summary object is
around 1 200 tokens of JSON at its largest; 8 000 leaves adaptive thinking ample
room while making an unbounded generation structurally impossible. The proxy
streams regardless of the value, because streaming is what keeps a 20-second
request off the SDK's HTTP timeout and what lets the UI show progress; the ceiling
for a streaming request is 64 000 and we are nowhere near needing it.

### 10.3 Structured outputs

```js
output_config: { format: { type: 'json_schema', schema: SUMMARY_SCHEMA } }
```

The deprecated top-level `output_format` parameter is **not** used.

This is the right tool for exactly the reason structured outputs exist: the
summary has a fixed shape (§9) and the UI renders *fields* — a title element, a
list of key points, a list of action items with optional owners, a list of open
questions, each row carrying a `t` that becomes a click target. It does not
render prose. Parsing four sections out of Markdown with a regex would be a
worse implementation of a schema the API can enforce.

**Assistant message prefill is removed on this model** — a trailing assistant
turn returns 400. The old trick of prefilling `{` to force JSON is not available
and is not needed. Structured outputs is the replacement, not a workaround.

`SUMMARY_SCHEMA` sets `additionalProperties: false` at every level and `required`
on every non-optional field, so a valid response cannot carry a field the
renderer does not know about.

### 10.4 Citations — why we do not use them, and what it costs us

The most accurate possible design for "each summary line links back to a
timestamp" is not to ask the model for a `t` at all. It is to send the transcript
as a `document` block with `citations: { enabled: true }` and read the returned
`char_location` citations, which are API-measured spans into the document rather
than model-asserted numbers.

**We cannot.** Structured outputs are incompatible with citations on document
blocks — the combination returns 400. And the UI needs fields, not prose, so
structured outputs wins.

The consequence, stated plainly: **every `t` in the summary is model-asserted and
can be wrong in a way a citation could not be.** Mitigation in §10.5.

The alternative of two calls — one with citations for attribution, one with
structured outputs for shape — is rejected. It doubles cost and latency for a
secondary feature, and the two responses can disagree with each other, which
leaves you arbitrating between two sources of truth with no way to tell which is
right.

### 10.5 Validating every `t` server-side

Because §10.4 leaves `t` unverified, the proxy validates each one against the
transcript it actually sent, before the browser sees it:

1. Snap `t` to the nearest transcript segment start within **±2.0 s**. The
   segment index, not the raw float, is what the UI links to (§7.3).
2. If nothing is within 2.0 s, keep the line, set `anchored: false`, and let the
   UI render it without a click target and with a quiet marker.
3. If `t` is outside `[0, duration]` entirely, same treatment. **Never drop the
   line** — a key point with a bad timestamp is still a key point, and silently
   deleting model output because a secondary field failed validation loses
   information the user wanted.

### 10.6 Prompt caching

`cache_control: { type: 'ephemeral' }`, prefix match, render order
`tools → system → messages`. No tools here, so: system, then messages.

**Block order, and why it is not the obvious one:**

```
system    [stable across every request ever]           <- breakpoint 1
messages  [ user:
            block 1: the transcript                    <- breakpoint 2
            block 2: the length / format instruction ]
```

Two different things vary on two different timescales and the order has to serve
both:

- Across *different recordings*, the transcript is what varies — so it sits after
  the system prompt, as the last large block. This is the ordinary "stable first,
  varying last" rule.
- Across *re-summarisations of one recording* (brief / standard / detailed), the
  transcript is stable and the **instruction** is what varies — so the
  instruction goes after the transcript's breakpoint, as a short tail.

Putting the instruction first, which reads more naturally, would move a varying
token into the prefix and invalidate the transcript on every re-summarisation.
The saving below depends entirely on this ordering.

**Worked numbers.** 60-minute note ≈ 12 000 transcript tokens, plus ~900 tokens
of system prompt and schema. Re-summarised at three lengths in one session.
`claude-opus-5-5` is $4.00/MTok input, $20.00/MTok output, cache reads $0.20/MTok,
cache writes 1.25× base:

| | Input tokens billed | Cost |
|---|---|---|
| No caching | 3 × 12 900 = 38 700 at $4.00 | **$0.155** |
| Cached | write 12 900 at $5.00 + 2 reads × 12 900 at $0.20 | **$0.070** |

**About a 55 % saving on input**, growing with each additional re-summarisation.

**Two limits that make this smaller than it looks, and both are worth knowing:**

1. **The minimum cacheable prefix is 1 024–4 096 tokens depending on the model.**
   A 900-token system prompt is *below* it — a breakpoint there caches nothing and
   reports nothing. `usage.cache_read_input_tokens` stays zero and you conclude
   caching is broken when it is simply not engaging. The transcript breakpoint is
   therefore set **only when the transcript exceeds 2 048 tokens**, and the
   response's `usage.cache_read_input_tokens` is logged so a zero is visible
   rather than assumed.
2. **The TTL is 5 minutes.** Three requests fired from one UI session land inside
   it. A user returning tomorrow pays the write again. So the UI does not promise
   cheap re-summarisation and does not build a feature on the assumption — the
   win is real and it is session-scoped.

### 10.7 Response handling

**Check `stop_reason` before touching `content`. Always.**

```js
if (response.stop_reason === 'refusal') {
  // stop_details is populated ONLY for 'refusal'. It is null for end_turn,
  // max_tokens, tool_use and every other stop reason — guard before reading.
  const category = response.stop_details?.category ?? 'unspecified';
  return fail(502, 'refused', category);
}
if (response.stop_reason === 'max_tokens') {
  return fail(502, 'truncated', 'The summary exceeded the output budget.');
}
```

A truncated structured output is invalid JSON, so `max_tokens` must be
distinguished from success before parsing — otherwise it surfaces as a parse
error and gets misdiagnosed as a schema problem.

### 10.8 Errors — typed, most specific first

```js
try { ... }
catch (err) {
  if (err instanceof Anthropic.BadRequestError)      { /* 400: our request is wrong */ }
  else if (err instanceof Anthropic.AuthenticationError) { /* 401: key present but invalid */ }
  else if (err instanceof Anthropic.RateLimitError)  { /* 429: honour retry-after */ }
  else if (err instanceof Anthropic.APIError)        { /* typed .status */ }
  else throw err;
}
```

Order matters: the specific classes are subclasses of `APIError`, so a broad
catch first swallows them all.

**Never string-match error messages.** Message text is not API surface and
changes without notice; `err.status` and the class are.

Two distinctions the messages must preserve:

- **`AuthenticationError` (401) means the key is present and wrong.** A *missing*
  key is handled before the SDK client is ever constructed (§13.1) and produces a
  503 with different wording. Conflating them tells a user to set a key they have
  already set, which is the most annoying possible error message.
- **`BadRequestError` (400) is our bug, not the user's.** The surfaced message
  says so, and the server logs the request shape — never the transcript
  contents, and never the key.

---

## 11. The proxy — `POST /api/claude`

### 11.1 Why the server is not a pure static server

The browser must never hold the Anthropic API key. Any browser that can read the
key can spend it, and a key in a front-end bundle is a key in everyone's cache.

So `server.js` is a static server **plus one endpoint**, which reads
`process.env.ANTHROPIC_API_KEY` server-side, calls the Anthropic API, and streams
the result back. The browser never contacts `api.anthropic.com`.

The SDK is a real dependency, `@anthropic-ai/sdk`, and the client is constructed
with no arguments:

```js
const anthropic = new Anthropic();   // picks up ANTHROPIC_API_KEY itself
```

Passing the key explicitly is the pattern that leads to it being read into a
variable, logged during debugging, and committed.

### 11.2 The allowlisted request body — the whole contract

```
POST /api/claude
Content-Type: application/json

{ "mode":       "single" | "map" | "reduce",
  "length":     "brief" | "standard" | "detailed",
  "transcript": [ { "t": <number>, "text": <string> }, ... ],   // single | map
  "summaries":  [ <summary object>, ... ] }                     // reduce
```

**That is every field the endpoint accepts.** `model`, `max_tokens`, `system`,
`messages`, `tools`, `betas`, `thinking`, `output_config`, `metadata`,
`temperature` — all constructed server-side from §10, none accepted from the
client, all rejected by name if sent.

### 11.3 Why an open relay is the bug to avoid

A proxy that forwards an arbitrary client body to a paid API is an **open
relay**: an unmetered, unlogged, unauthenticated Anthropic account attached to
someone else's card, for anyone who can reach the port.

Worked, because the number is the argument. `claude-opus-5-5` output is
$20.00/MTok. A relayed body can set `max_tokens: 64000` and
`output_config: { effort: 'max' }` on every request:

- 64 000 output tokens ≈ **$1.28 per request**
- a trivial script at 10 requests/second ≈ **$46 000/hour**

until a rate limit or a spend cap intervenes — and a dev server has neither.
Prompt-laundering through your organisation's key is the second problem and
arrives with your name on it.

The allowlist is what makes the worst case bounded: the maximum a caller can
provoke is one `claude-opus-5-5` call at `max_tokens: 8000` and `effort: medium`,
rate-limited per §11.5.

### 11.4 Validation, in order

| # | Guard | Failure |
|---|---|---|
| 1 | Method is `POST` | `405` + `Allow: POST` |
| 2 | `Content-Type` is exactly `application/json` | `415`. Structurally forbids `multipart/*` and `audio/*` (§3.4) |
| 3 | Body ≤ **1 MiB**, counted as bytes arrive, socket destroyed past the cap | `413`. Counted *streaming*, never by parsing a fully-buffered body — buffering first *is* the denial of service |
| 4 | Body parses as a JSON object | `400` |
| 5 | Every key is in the allowlist (§11.2) | `400` naming the offending key |
| 6 | `mode` and `length` are in their enums | `400` |
| 7 | `transcript` is an array, ≤ 20 000 entries; each `t` finite and ≥ 0; each `text` a string ≤ 4 000 chars; total ≤ 1 000 000 chars | `400` with the index |
| 8 | No `text` matches `/^data:[^;]*;base64,/` | `400 suspect_binary` (§3.4, belt and braces) |
| 9 | `Origin`, if present, is a configured local origin | `403`. Present-and-wrong is rejected; absent is allowed, so `curl` still works |
| 10 | Rate limit (§11.5) | `429` + `Retry-After` |
| 11 | Estimated transcript tokens (`chars / 3.5`) under the §12 threshold for `mode: "single"` | `413` with `{ "error": "transcript_too_long", "suggest": "map_reduce" }` — refuse *before* spending money, not after |

**Guard 5 rejects rather than strips.** Silent stripping hides a client bug for
as long as it takes someone to notice a parameter has no effect, and hides an
attack entirely. A 400 naming the key is information for both the developer and
the log.

### 11.5 Rate limit

In-process token bucket: **6 requests/minute and 20/hour per IP**, refilled
continuously, keyed on the socket address. `429` with a `Retry-After` in seconds.

Honestly labelled: single-process, in-memory, and reset by a restart. That is
sufficient for a local dev server holding one key and it is not a
production-grade limiter. It is here as a blast-radius cap on §11.3, not as
access control.

### 11.6 Response hygiene

- Errors to the browser use one fixed shape, `{ "error": <code>, "message": <curated> }`,
  built from the typed class (§10.8). **Upstream error text is never relayed** —
  it can carry organisation and workspace identifiers.
- No upstream response headers are forwarded. No `request-id` unless it is
  deliberately surfaced for support, which it is not here.
- The key is never in a response body, a header, a log line, or an error. There
  is no `/api/debug`, no `/api/env`, and no endpoint that reflects
  `process.env`.
- Bind **`127.0.0.1` by default**, not `0.0.0.0`. A dev server holding a paid API
  key should not be on the LAN because of a default. `HOST` overrides, and the
  startup banner states which interface it bound to in words, so a deliberate
  `0.0.0.0` is visible and an accidental one is caught.
- The **path-traversal guard from `webgpu-particles/server.js` is kept verbatim**
  for the static half: resolve, normalise, and refuse anything that does not
  start with the project root. Adding a proxy does not make directory traversal
  less interesting — it makes it more, because there is now a `.env` in the tree.

### 11.7 `GET /api/claude/status`

```json
{ "available": false, "reason": "ANTHROPIC_API_KEY is not set in the server environment" }
```

Called once at boot so the transcribe-only banner (§13) is correct *before* the
user records anything, rather than appearing as a surprise after they have
finished and pressed Summarise. Returns no secrets either way — `available: true`
carries no key material and no organisation identifier.

---

## 12. Long transcripts — chunk and reduce

### 12.1 The threshold

**Chunk-and-reduce engages above 12 000 estimated transcript tokens** — about
9 200 words, about **60 minutes** of continuous speech at 150 wpm. Below it, one
request.

The estimate is `characters / 3.5`, deliberately conservative against the usual
4.0 so the threshold trips slightly early rather than slightly late.

**The threshold is not a context limit.** `claude-opus-5-5` has a 1M-token
context and a three-hour transcript fits in it comfortably. The threshold is a
*quality and cost* decision: "the key points" of twenty hours of speech is not a
meaningful request, and a single 200 000-token call produces a summary that is
uniformly shallow rather than locally useful.

### 12.2 Map

- Split at **segment boundaries**, never mid-segment, into chunks of ≤ **8 000
  tokens**.
- **One segment of overlap** between consecutive chunks, so a point spanning a
  chunk edge is seen whole by at least one call.
- Each map call uses the same `SUMMARY_SCHEMA` and carries its chunk's absolute
  start offset, so returned `t` values are already in recording time and need no
  post-hoc arithmetic. Off-by-one-chunk timestamps are exactly the bug this
  avoids.
- Effort: `medium` today, `low` gated on §10.2's measurement.

### 12.3 Reduce

- Input is the **N chunk summaries**, not the transcript. A reduce that re-reads
  the transcript is not a reduce.
- Same schema, so the output is the same object the single-call path returns and
  the renderer cannot tell the difference.
- Instruction: merge duplicate points, and when merging keep the `t` of the
  **earliest** supporting segment — the first time a thing was said is the useful
  anchor for a reader scanning down.
- Effort `medium`. The reduce is the call that has to hold the whole recording in
  view; it is the one place higher effort is plausibly worth measuring.

### 12.4 Cost, worked

Three-hour transcript ≈ 36 000 tokens → 5 map chunks.

| Stage | Input tokens | Output tokens |
|---|---|---|
| Map, 5 calls | 5 × (900 + 8 000) = 44 500 | 5 × ~900 = 4 500 |
| Reduce, 1 call | 900 + 5 × 400 = 2 900 | ~900 |
| **Total** | **47 400** at $4.00/MTok = **$0.19** | **5 400** at $20.00/MTok = **$0.11** |

**About $0.30 for three hours of audio.** Worth stating in the UI before the
press, and the confirmation panel does (§14.4).

### 12.5 Never truncate

- A chunk that cannot be split under 8 000 tokens at a segment boundary is
  impossible given 30 s windows, and is asserted anyway.
- Above **24 map chunks** (≈ 192 000 transcript tokens, ≈ 16 hours) the proxy
  returns `413` with an explanation rather than quietly spending $1.50+ on a
  request nobody budgeted for. A tree reduce would lift the ceiling and is in the
  backlog; the ceiling being explicit is the point.
- There is no code path that shortens a transcript to make it fit. Silent
  truncation produces a summary that is confidently about the first half of a
  recording, with nothing to indicate the second half was never read — the worst
  failure in the project, because it looks exactly like success.

---

## 13. Transcribe-only mode

### 13.1 Trigger

`ANTHROPIC_API_KEY` unset in the server environment. Then:

- `GET /api/claude/status` → `{ available: false, reason: "..." }`
- `POST /api/claude` → **`503`** with the same JSON body

The SDK client is never constructed, so a missing key cannot masquerade as an
`AuthenticationError` (§10.8).

### 13.2 Never silent

- A persistent banner, `role="status"`, not a toast. It quotes the server's
  `reason` **verbatim** — a UI that paraphrases a server diagnosis is a UI that
  will eventually paraphrase it wrong — and states the fix: copy `.env.example`
  to `.env`, set the key, restart.
- The Summarise button is `disabled` **and** `aria-describedby` the banner, so a
  screen reader reaching it is told why. A bare `disabled` button is a dead end
  for a keyboard user: focusable-but-inert with no explanation in reach.
- The panel's Summarisation row reads `unavailable — no API key`, so the state is
  visible from the diagnostics as well as the banner.

### 13.3 What still works — all of it

| Feature | Transcribe-only |
|---|---|
| Record, level meter, pause, resume | Yes |
| Model download with progress | Yes |
| WebGPU / wasm transcription | Yes |
| Timestamped transcript, live during recording | Yes |
| Click a timestamp to seek and play | Yes |
| Find within transcript | Yes |
| Low-confidence seam markers (§6.5) | Yes |
| Copy as Markdown with timestamps | Yes |
| Export `.txt` and `.vtt` | Yes |
| Save to and restore from `localStorage` | Yes |
| Claude summary | No — disabled with a visible reason |

That table is the argument. **Everything the project's privacy thesis claims is
in transcribe-only mode**; summarisation is the optional extra that crosses the
boundary. A useful local transcription notebook with no key configured is the
product working as designed, not the product degraded.

---

## 14. UI

### 14.1 Layout

Two panes, transcript left and summary right, collapsing to stacked below
900 px. A record bar across the top with the level meter. Diagnostics in a
collapsible aside.

### 14.2 Transcript pane

Rows of `mm:ss` (§7.3) plus text. Clicking a row seeks to `t − 0.75` and plays.
The playing row is highlighted. Low-confidence seams (§6.5) render as a hairline
rule with a tooltip. `aria-current="true"` follows the playing row so a screen
reader tracks position.

### 14.3 Summary pane

Title, then three labelled groups. Each line is a `<button>` — not a `<div>` with
a click handler — carrying `data-t`, so it is keyboard-reachable, announced as a
control, and activates on Enter and Space for free. Clicking seeks the audio and
highlights the corresponding transcript row. Lines with `anchored: false` (§10.5)
render as plain text with a quiet marker and no click target: an inert control is
worse than no control.

### 14.4 The confirmation affordance — the boundary made visible

Pressing **Summarise with Claude** does not send anything. It opens an inline
panel that states:

- the exact **character count and estimated token count** that will be sent
- the estimated **cost** (§12.4)
- **what will not be sent**, named: *"No audio is sent. The recording stays on
  this device."*
- a scrollable **preview of the literal request body**
- whether **chunk-and-reduce** will run, and how many requests that is
- two buttons: **Send transcript** and **Cancel**

The counts are the point of the panel. This is the one moment in the app where
data crosses the boundary, and the user should be able to see exactly what
crosses. Making it a modal to be dismissed by reflex would defeat the purpose;
it is inline, it stays until acted on, and the numbers are the largest thing on
it.

### 14.5 Accessibility

Keyboard operation of every control. Visible focus rings on everything focusable,
never `outline: none`. `aria-pressed` on toggles. `aria-live="polite"` on the
status line, `role="status"` on the transcribe-only banner,
`role="progressbar"` with `aria-valuenow`/`min`/`max` on the model download.
`prefers-reduced-motion` removes the level-meter easing, the pane transitions,
and the recording pulse. The level meter carries a text percentage as well as a
bar, because a bar alone is not available to a screen reader.

---

## 15. Testing strategy

Three suites, no dependencies, no browser, no microphone, no GPU, no network,
no API key. `npm test`, or `npm test -- <suite>`. Each suite runs in its own
process so fake globals cannot leak between them.

`tests/run.mjs` is `galaxy-spiral/tests/run.mjs` verbatim: it greps child output
for lines beginning `PASS` and `FAIL`, so every assertion uses that prefix
convention.

### 15.1 `unit` — pure functions

| Module | Property asserted |
|---|---|
| `recorder.js` resampler | 48 k and 44.1 k → 16 k: length within one sample of `n × 16000 / rate`; a 1 kHz tone survives with < 1 % RMS error; a 10 kHz tone is attenuated > 40 dB (the anti-aliasing check, §4.3); no NaN; FIR state continuity across block boundaries |
| `stitch.js` | Every fixture in §15.3, plus idempotence, plus a single-window input returning unchanged, plus an empty input returning an empty transcript rather than throwing |
| `summarize.js` schema | A hand-built valid summary validates; each of ~12 targeted mutations (missing `title`, `t` as a string, extra property, empty `key_points`, `t` negative) is rejected, **each with its own assertion** so a failure names the rule that broke |

### 15.2 `boot` — DOM wiring

Fake DOM parsed from `index.html` (same technique as
`galaxy-spiral/tests/harness.mjs`), fake `AudioContext`, fake `fetch`.

- Every element `main.js` looks up by id exists in the markup
- Record button toggles `aria-pressed` and the recording class
- Model progress sets `aria-valuenow` and the byte readout
- **Transcribe-only:** with `fetch('/api/claude/status')` faked to
  `{ available: false, reason }`, the banner is visible, contains the reason
  verbatim, the Summarise button is `disabled`, and its `aria-describedby`
  resolves to the banner's id
- **Key present:** banner hidden, Summarise enabled
- Clicking a transcript row seeks the fake audio element
- Clicking a summary line highlights the matching transcript row

### 15.3 `pipeline` — audio → windows → stitch → prompt

Drives `tests/audio-fixture.mjs` through the whole chain.

`audio-fixture.mjs` provides a synthetic PCM generator (tones, silence, and a
noise floor at a known RMS, at 48 kHz and 44.1 kHz) and **canned overlapping
window outputs with hand-checked correct stitched results**:

| Fixture | What it exercises |
|---|---|
| `cleanSeam` | Anchor found immediately; the base case |
| `midWordSeam` | `"...probably recon"` / `"reconsider the deadline..."` — the §6.4 property |
| `repeatedPhrase` | `"no no no"` in the overlap; tests the time-proximity tie-break (§6.3 step 3) |
| `silentOverlap` | No tokens in the overlap at all; must take the time-cut fallback and mark the seam low-confidence |
| `hallucinatedTail` | A sentence present in A and absent in B; must not be duplicated and must not vanish |
| `threeWindows` | Two seams in sequence; asserts the stitch composes |

Asserted: window count and offsets for a known duration; windows are exactly
480 000 frames with the last zero-padded; every fixture's stitched output equals
its hand-checked expectation **token for token**; prompt assembly puts system
first, transcript second, instruction last, with the cache breakpoint on the
transcript (§10.6); the chunk-and-reduce threshold trips at 12 000 tokens and
not at 11 999.

### 15.4 The two tests that must fail if the design is violated

These are the reason the suite exists. Both are written to fail red today.

**1. No audio can reach the network boundary.** A fake `fetch` inspects every
outbound body and fails the suite on any `ArrayBuffer`, `TypedArray`, `Blob`,
`FormData`, or string matching `/^data:[^;]*;base64,/`. It runs **after** a real
fixture recording has been pushed through capture → window → stitch →
`summarize()`, so it is testing the live path. A version that asserted against an
idle app would pass trivially and prove nothing — the same class of mistake as
Galaxy Spiral's §7.1 grab-position defect, where the assertion was true of both
the correct and the incorrect implementation.

**2. Stitching neither duplicates nor drops text at a mid-word seam.** On
`midWordSeam`, assert the exact token sequence; assert `reconsider` appears
exactly once; assert `recon` appears zero times; assert the concatenation of all
tokens contains no adjacent duplicate run of length ≥ 2. Each as a separate
`PASS`/`FAIL` line, so the failure names which property broke rather than
reporting that stitching is wrong.

### 15.5 Not covered, and requiring a manual pass

Be clear about the size of this gap, because it is large:

- **A real microphone.** `getUserMedia` is faked. Permission denial, device
  change mid-recording, and Bluetooth headsets that renegotiate their sample rate
  are manual.
- **Real Whisper inference.** No model is downloaded and no ONNX is run. The
  stitcher is tested against *canned* window outputs, which means it is tested
  against what we believe Whisch produces, not against what it does. If the
  real model's segment boundaries differ from the fixtures in shape, the stitcher
  can be green and wrong.
- **The WebGPU path.** No adapter in Node.
- **A real Claude call.** `summarize.js` is tested against a fake `fetch`;
  `server.js`'s proxy is tested for validation and rejection only. No test in
  this suite has ever seen a real API response, which means the schema is
  asserted against our reading of the docs, not against the API.
- **The service worker.** Not written at all (§17.1).

**Green tests plus a wrong transcript is an expected state, not a
contradiction.**

---

## 16. Configuration

| Parameter | Location | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | `.env` / process environment | unset → transcribe-only (§13) |
| Server port | `PORT` | `5176` (5173–5175 are the sibling projects; all four can run at once) |
| Bind host | `HOST` | `127.0.0.1` (§11.6) |
| Model id | `MODEL_ID`, `transcriber.js` | `Xenova/whisper-tiny.en` |
| Backend | `?backend=webgpu\|wasm` | auto (§5.4) |
| Window length | `WINDOW_S`, `transcriber.js` | `30.0` — fixed by the model, do not change |
| Stride | `STRIDE_S`, `transcriber.js` | `25.0` |
| Minimum anchor | `MIN_ANCHOR`, `stitch.js` | `3` tokens |
| Anchor time tolerance | `ANCHOR_DT`, `stitch.js` | `2.0` s |
| Seek lead | `SEEK_LEAD_S`, `main.js` | `0.75` s |
| Claude model | `server.js` | `claude-opus-5-5` |
| `max_tokens` | `server.js` | `8000` |
| Effort | `server.js` | `medium` (§10.2) |
| Map chunk size | `MAP_CHUNK_TOKENS`, `server.js` | `8000` |
| Chunk-and-reduce threshold | `REDUCE_THRESHOLD_TOKENS`, `server.js` | `12000` (§12.1) |
| Max map chunks | `MAX_CHUNKS`, `server.js` | `24` |
| Body cap | `server.js` | 1 MiB |
| Rate limit | `server.js` | 6/min, 20/hour per IP |
| Recording cap | `MAX_RECORDING_S`, `recorder.js` | `3600` s, warn at `1800` |

---

## 17. Failure modes

Every row renders text. There is no state in which the user sees a stalled
spinner with no explanation.

| Condition | Behaviour |
|---|---|
| `getUserMedia` denied (`NotAllowedError`) | Named explanation plus per-browser instructions for re-granting. The app stays usable for replaying a saved transcript |
| No input device (`NotFoundError`) | Explanation; offers to load a saved transcript |
| Device removed mid-recording | Capture stops, audio so far is kept and transcribed, banner says the recording was cut short and when |
| `AudioContext` will not honour 16 kHz | Worklet resampler path (§4.3), panel reports the actual device rate |
| `AudioWorklet` unavailable | Hard failure with an explanation and a browser list. **No `ScriptProcessorNode` fallback** — silent dropped buffers (§4.2) are worse than a clear refusal |
| Model download fails mid-stream | Retry button, bytes already fetched reported, partial cache entry discarded rather than left to poison a later load |
| Model download over quota | `navigator.storage.estimate()` warning before starting; a `QuotaExceededError` during falls through to network (§8.3) |
| WebGPU adapter lost | Re-init on wasm, keep the queue, panel reports the switch |
| First WebGPU window exceeds 20 s | Watchdog switches to wasm (§5.4) |
| Inference throws on one window | That window is marked failed, the transcript shows a gap marker at its time range, **the queue continues**. One bad window must not end the recording |
| Queue falls behind | Depth shown; capture continues (§5.5) |
| Recording exceeds 30 min | Warning with current heap estimate |
| Recording exceeds 60 min | Capture stops, everything captured is kept |
| `ANTHROPIC_API_KEY` unset | Transcribe-only (§13). `503` + JSON reason |
| Key present but invalid (401) | `AuthenticationError` → "the configured key was rejected", explicitly *not* "set a key" (§10.8) |
| Rate limited (429) | `Retry-After` surfaced as a countdown; the Summarise button re-enables when it expires |
| `stop_reason: "refusal"` | Category from `stop_details` surfaced; transcript untouched; retry offered at a shorter length |
| `stop_reason: "max_tokens"` | "The summary was cut off" — distinguished from a parse failure (§10.7) |
| Transcript over the single-call threshold | Chunk-and-reduce, announced in the confirmation panel before sending (§14.4) |
| Transcript over 24 chunks | `413` with the ceiling stated. Never truncated (§12.5) |
| Proxy body over 1 MiB | `413`, socket destroyed before buffering |
| Unknown field in the proxy body | `400` naming the field (§11.4) |
| Origin present and wrong | `403` |

---

## 18. Known limitations

1. **The service worker is specified but not written.** §8.3 defines the cache
   strategy; `sw.js` does not exist. Today the 40 MB model is re-fetched on any
   cold load the HTTP cache does not happen to cover, and the app does not work
   offline. This is the largest gap between this document and the file tree, and
   it is item 1 in the backlog.
2. **Timestamps are ±0.5 s, and they come from the model.** §7 states the budget
   and the three UI decisions built on it. Citations would be measured rather than
   asserted and are incompatible with structured outputs (§10.4).
3. **`whisper-tiny.en` is the smallest useful model.** It degrades on accents,
   crosstalk, and poor microphones, and it is English-only. The size budget drives
   this; making it selectable is in the backlog.
4. **No diarisation.** "Who said that" is the single most requested feature this
   design does not have. The cheap version — energy-based turn detection — is
   worse than nothing: it labels confidently and wrongly, and a wrong speaker
   label is more damaging than an absent one, because a reader cannot tell it is
   wrong. Real diarisation is a second model and a second 40 MB download.
5. **A long recording is a large heap.** 3.84 MB/minute of float32 on the main
   thread. Warned at 30 minutes, capped at 60 (§4.4). Spilling to IndexedDB would
   lift the cap and would also put the audio on disk, which is a privacy decision
   (§3.1 row 2), not just an engineering one.
6. **The rate limiter is per-process and in-memory** (§11.5). A blast-radius cap,
   not access control.
7. **Effort is unmeasured.** §10.2 specifies the eval and states that it has not
   been run. `medium` ships because it is the model default, not because it won a
   comparison.
8. **The stitcher is tested against canned windows, not real ones** (§15.5). If
   real Whisper output differs in shape from the fixtures, the suite can be green
   and the transcript wrong.
9. **Prompt caching saves money only within a session** — 5-minute TTL, and a
   900-token system prompt is below the minimum cacheable prefix (§10.6).

---

## 19. Possible extensions

- `sw.js`, per §8.3 — closes limitation 1 and makes the app genuinely offline
- Model picker: `tiny.en` / `base.en` / `small.en`, with the size on the control
- Multilingual `whisper-tiny` plus language detection
- Tree reduce, lifting the 24-chunk ceiling (§12.5)
- Spill the ring buffer to IndexedDB for recordings over an hour, behind an
  explicit choice that names the disk-persistence tradeoff
- Voice-activity detection to skip silent windows — direct compute win on the
  wasm path, where each window is 6–14 s
- Real diarisation as an opt-in second download (limitation 4)
- Run the §10.2 effort eval and replace the guess with a number
- Re-summarise at a different length reusing the cached prefix, with the 5-minute
  TTL surfaced honestly in the UI

---

## 20. Changelog

### 1.0 — Draft

**Initial specification. Unimplemented.** Module skeletons throw
`NotImplemented` with a section reference; the test suites are written and fail
red by design.

Departures from the rest of the series, each deliberate:

| Change | Rationale |
|---|---|
| `server.js` is no longer a pure static server | The browser must never hold the API key. One proxy endpoint is the minimum that achieves it (§11.1) |
| A real npm dependency (`@anthropic-ai/sdk`) | First in the series. The alternative is hand-rolling SSE parsing and typed errors against a paid API, which is worse code and worse security |
| A named privacy-boundary section (§3) | Galaxy Spiral's privacy note is one paragraph in §6.2 because nothing there crosses the network. Here something does, on purpose, and the boundary is the subject |
| The hardest logic isolated in a pure module | `stitch.js` follows `gestures.js` and `shapes.js`: pure, therefore exhaustively testable. Window merging is the part most likely to be quietly wrong |
| An invariant with a test attached | §3.4 is not a policy statement. `tests/pipeline.test.mjs` fails if an audio buffer can reach the network boundary |
| A measurement specified and marked unrun | §10.2 argues for `low` effort and ships `medium`, because the argument has not been tested. Recording the gap is the point |

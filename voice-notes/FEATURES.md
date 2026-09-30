# Voice Notes — Feature Document

**Version** 1.0 · **Date** 2026-09-30 · **Status** Draft (unimplemented)

The feature-oriented view. For the algorithm, buffer layouts, and rationale see
[spec/SPEC.md](spec/SPEC.md). For what to build next see [CLAUDE.md](CLAUDE.md).

---

## What it is

A zero-install local-first voice notebook. The user records from the microphone;
Whisper runs entirely in the browser via Transformers.js on WebGPU and produces a
timestamped transcript; the recording and the model never leave the device. The
user may then send the finished transcript text to Claude for a structured summary
linked back to timestamps — on explicit confirmation, through a server-side proxy
that holds the API key.

---

## Feature inventory

### Recording

| Detail | Value |
|---|---|
| Input | `getUserMedia` microphone |
| Capture | `AudioWorklet`, 128-frame render quantum |
| Sample rate | 16 kHz (requested), with FIR-filtered worklet decimation as fallback |
| Format | `Float32Array`, mono |
| Ring buffer | Grown in 16 s chunks (256 000 frames, 1 MB), cap 60 min |
| Level meter | Peak and RMS per quantum, posted every 8 quanta (~47 Hz) |
| Warning | At 30 minutes with current heap estimate |
| Hard cap | At 60 minutes; audio captured so far is preserved |

### Transcription

| Detail | Value |
|---|---|
| Model | `Xenova/whisper-tiny.en`, ONNX, via Transformers.js |
| Size | ~41 MB fp16 (WebGPU), ~33 MB q8 (wasm) |
| Window | 30.0 s (480 000 frames) — fixed by the model's mel filterbank |
| Stride | 25.0 s (400 000 frames) |
| Overlap | 5.0 s (80 000 frames) |
| Backends | WebGPU (default) with wasm fallback; ~10x speed difference |
| Watchdog | First WebGPU window exceeding 20 s triggers automatic wasm fallback |
| Warm-up | One silent pass after load to pre-compile shaders; timing is excluded |
| Queue | Windows transcribe in order, one at a time; capture never waits |
| Loading UX | Explicit opt-in button naming the ~40 MB size; bytes + rate + ETA shown |

### Window stitching

| Detail | Value |
|---|---|
| Method | Anchored token-run merge (SPEC §6.3) |
| Minimum anchor | 3 contiguous matching normalised tokens |
| Tie-break | Smaller absolute time difference between anchor start positions |
| Normalisation | Lowercase, NFKD, combining marks and punctuation stripped |
| Cut point | End of anchor — B supplies the complete word at any broken seam |
| Fallback | Time cut at overlap midpoint when no anchor found; seam marked low-confidence |
| Output | `{ tokens, segments, seams }` — `seams` is part of the contract |

### Transcript pane

| Detail | Value |
|---|---|
| Format | Rows of `mm:ss` plus text, live during recording |
| Click | Seeks to `max(0, t - 0.75)` and plays |
| Low-confidence seams | Hairline rule with tooltip |
| Playing row | Highlighted; `aria-current="true"` follows it |
| Find | In-pane text search |
| Export | Copy as Markdown with timestamps, `.txt`, `.vtt` |
| Save | `localStorage` on user action |

### Claude summarisation

| Detail | Value |
|---|---|
| Model | `claude-opus-5-5` |
| Output | `{ title, key_points, action_items, open_questions }` — each item carries `t` |
| Structured outputs | `output_config: { format: { type: 'json_schema', schema: SUMMARY_SCHEMA } }` |
| Thinking | `{ type: 'adaptive', display: 'summarized' }` |
| Effort | `medium` (SPEC §10.2) |
| Chunk-and-reduce | Engages above 12 000 estimated tokens (~60 min of speech) |
| Prompt caching | Transcript breakpoint; ~55 % saving on re-summarisation within one session |
| Timestamp validation | Each `t` snapped to nearest segment within ±2 s server-side |
| Confirmation panel | Shows exact char/token count, estimated cost, literal request preview |

### The privacy boundary

Every datum, where it lives, and whether it leaves:

| Datum | Where it lives | Crosses the network? |
|---|---|---|
| Microphone PCM | AudioWorklet render thread, overwritten every quantum | Never |
| Resampled 16 kHz float32 | Main-thread ring buffer | Never |
| Analysis windows | Transferred ArrayBuffers in transcriber.js | Never |
| Transcript segments | Main-thread JS heap; localStorage on user action | Only on explicit Summarise confirmation, as JSON, to our own origin |
| ANTHROPIC_API_KEY | `process.env` in the Node process | Never |

### Transcribe-only mode

When `ANTHROPIC_API_KEY` is not set in the server environment, the full local
feature set works; only Claude summarisation is unavailable.

| Feature | Transcribe-only |
|---|---|
| Record, level meter, pause, resume | Yes |
| Model download with progress | Yes |
| WebGPU / wasm transcription | Yes |
| Timestamped transcript, live | Yes |
| Click a timestamp to seek and play | Yes |
| Find within transcript | Yes |
| Low-confidence seam markers | Yes |
| Copy as Markdown with timestamps | Yes |
| Export `.txt` and `.vtt` | Yes |
| Save to / restore from `localStorage` | Yes |
| Claude summary | No — disabled with a visible reason |

---

## Deliberate non-goals

These are choices, not gaps. Each is argued in the spec.

**Audio never reaches any server.** Not in any encoding, at any sample rate, on
any code path. An invariant with a test attached (SPEC §3.4, §15.4). The proxy's
`Content-Type` guard and field allowlist enforce it structurally.

**No keyless browser design.** Anthropic API keys cannot safely live in a browser
bundle. One proxy endpoint is the minimum structure that keeps the key
server-side. SPEC §11.1

**No diarisation.** Speaker labels from energy-based turn detection are
confidently wrong — a wrong label is more damaging than an absent one, because
a reader cannot tell. Real diarisation is a second 40 MB model download. SPEC §18

**English-only.** `whisper-tiny.en` is chosen for the size budget. Making the
model selectable is in the backlog. SPEC §18

**No `ScriptProcessorNode` fallback.** A `ScriptProcessorNode` competing with
Whisper inference on the main thread drops buffers silently, producing holes in
the transcript that nothing downstream can detect. A clear refusal with a browser
list is better. SPEC §4.2

**No tree reduce.** The 24-chunk ceiling on chunk-and-reduce is explicit: above
it the proxy returns 413 rather than spending money nobody budgeted for. Tree
reduce is in the backlog. SPEC §12.5

---

## Known gaps

**No service worker.** The cache strategy is specified in SPEC §8.3 and `sw.js`
does not exist. The model is re-fetched on any cold load the HTTP cache does not
cover and the app does not work offline. This is the largest gap between this
document and the file tree and is item 1 in the backlog.

**Tests against canned windows, not real ones.** The stitcher is tested against
fixtures that encode what we believe Whisper produces. If real model output differs
in shape, the suite can be green and the transcript wrong. SPEC §15.5

**Timestamps are model-asserted.** Every `t` in the summary comes from the model
and can be wrong. Citations would be measured rather than asserted and are
incompatible with structured outputs (SPEC §10.4). Server-side snapping to the
nearest segment within ±2 s mitigates but does not eliminate the error.

**Effort is unmeasured.** SPEC §10.2 specifies the 12-transcript eval and states
it has not been run. `medium` ships because it is the model default. The gap is
documented as a gap, not papered over.

---

## Backlog

- `sw.js`, per SPEC §8.3 — closes the largest gap and makes the app offline-capable
- Model picker: `tiny.en` / `base.en` / `small.en`, with size on the control
- Multilingual `whisper-tiny` plus language detection
- Tree reduce, lifting the 24-chunk ceiling (SPEC §12.5)
- Ring-buffer spill to IndexedDB for recordings over an hour, behind an explicit
  privacy-tradeoff choice
- Voice-activity detection to skip silent windows
- Real diarisation as an opt-in second download
- Run the SPEC §10.2 effort eval and replace the guess with a number
- Re-summarise at a different length reusing the cached prefix, with the 5-minute
  TTL surfaced honestly

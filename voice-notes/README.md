# Voice Notes

A local-first voice notebook: record from the microphone, transcribe entirely in
the browser with Whisper, and optionally send the finished transcript to Claude
for a structured summary.

> **Status: unimplemented.** The specification, feature document and module
> skeletons are complete; the implementation is not. Tests fail red by design.
> See [CLAUDE.md](CLAUDE.md) for what to build next.

## Quick start

```bash
cp .env.example .env
# edit .env and set ANTHROPIC_API_KEY=sk-ant-...
node server.js          # http://localhost:5176
npm test                # four suites, no browser or microphone required
npm test -- unit        # one suite by substring
```

Transcription works without an API key. With no key set, the server starts in
**transcribe-only mode** — all local features work and only the Summarise button
is disabled, with a reason shown. Recording, transcription, playback, export, and
local save all complete with the network disconnected once the model is cached.

To install the one server-side dependency:

```bash
npm install
```

## Architecture

```
  Browser                                    Server (Node)
  ─────────────────────────────────────────  ─────────────────────────────
                                             .env: ANTHROPIC_API_KEY
                                                     |
  Microphone                                         |
      |                                              |
  AudioWorklet  ──(16 kHz float32)──>  ring buffer  |
                                             |       |
                          <───────────  window (30 s)|
                          Transformers.js             |
                          Whisper inference            |
                          (WebGPU / wasm)             |
                               |                      |
                          stitch.js                   |
                          (pure, no I/O)              |
                               |                      |
                          transcript                  |
                         (text only)                  |
                               |                      |
   [user confirms]  ─────────>|                      |
                               |                      |
          ─── POST /api/claude (transcript JSON) ──>  |
                              NETWORK BOUNDARY        |
                                              proxy validates,
                                              adds key, calls
                                              api.anthropic.com
                                                      |
          <── structured summary (JSON) ─────────────|
                               |
                          summary pane
                          (click -> seek)
```

The network boundary is crossed exactly once, on explicit user confirmation, and
carries only transcript text. Audio never reaches the boundary in any form.

## Privacy

| Datum | Stays local? |
|---|---|
| Microphone audio (PCM) | Always — never leaves the AudioWorklet render thread |
| Resampled 16 kHz float32 | Always — main-thread ring buffer only |
| Whisper model weights | Inbound only — fetched from Hugging Face CDN once |
| Transcript text | Crosses the network only on explicit Summarise confirmation |
| ANTHROPIC_API_KEY | Always server-side — never in any response or log |

## Layout

| Path | Role |
|---|---|
| [spec/SPEC.md](spec/SPEC.md) | Algorithm, buffer sizes, API parameters, failure modes |
| [FEATURES.md](FEATURES.md) | Feature inventory, non-goals, known gaps, backlog |
| [CLAUDE.md](CLAUDE.md) | Session context — read this first if picking the project up |
| `src/js/recorder.js` | getUserMedia, AudioWorklet capture, ring buffer |
| `src/js/worklet.js` | The AudioWorkletProcessor — FIR resampler, level meter |
| `src/js/transcriber.js` | Transformers.js Whisper lifecycle, windowing, WebGPU/wasm |
| `src/js/stitch.js` | Pure window-merge algorithm |
| `src/js/summarize.js` | Browser client for /api/claude |
| `server.js` | Static server plus /api/claude proxy |
| `tests/audio-fixture.mjs` | Synthetic PCM and canned window outputs for stitching tests |

## A note on the tests

The suite runs without a microphone, a GPU, or an API key, which means it cannot
prove Whisper inference is correct or that a real Claude call works. The stitcher
is tested against canned outputs, not real Whisper output. **Green tests plus a
wrong transcript is an expected state, not a contradiction** — closing that gap
needs a real microphone and a real API call.

Two tests are written to fail if the design is violated (SPEC §15.4):

1. Any audio buffer reaching the fake `fetch` fails the suite.
2. The `midWordSeam` fixture failing to produce exactly one `reconsider` and zero
   `recon` occurrences fails the suite.

## Series

| Project | Subject |
|---|---|
| [galaxy-spiral](../galaxy-spiral/) | MediaPipe hand tracking, WebGL2, spec-first discipline |
| [webgpu-particles](../webgpu-particles/) | WGSL compute, storage buffers, ping-pong, indirect draw |
| [asl-trainer](../asl-trainer/) | 26-class gesture taxonomy, confusion matrix |
| [rag-notebook](../rag-notebook/) | In-browser embeddings, vector search, Claude synthesis |
| [mcp-agent-lab](../mcp-agent-lab/) | MCP server, agent loop, tool-use visualisation |
| **voice-notes** | Local Whisper transcription, Claude summarisation |

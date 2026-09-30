# ASL Trainer

A real-time ASL fingerspelling trainer. MediaPipe HandLandmarker reads 21 hand
landmarks per frame; a geometric cascade classifies each frame into one of 24
static letters; the learner spells target words; a persistent 26x26 confusion
matrix heatmap shows which letters they conflate.

> **Status: unimplemented.** The specification, feature document and module
> skeletons are complete; the implementation is not. Tests fail red by design.
> See [CLAUDE.md](CLAUDE.md) for what to build next.

## Quick start

```bash
node server.js          # http://localhost:5173
npm test                # three suites, no browser or camera required
npm test -- unit        # one suite by substring
```

No dependencies, no build step. `npm install` is not necessary.

Requires `getUserMedia` and a secure context (`http://localhost` qualifies).
Chrome, Edge, Safari 16.4+. A `file://` URL cannot open the camera.

## Architecture

```
camera frame
   |
   v
handTracker.js     MediaPipe HandLandmarker, 1 hand
   |               x flipped to 1-x for the selfie preview
   |               handedness label swapped to match
   v
letters.js         21 landmarks --> { letter, confidence, bucket, reason }
   |               PURE. mirror-normalise (§5) --> palm frame (§4.3)
   |               --> extension mask (§6.1) --> bucket --> ladder (§6.3-6.6)
   v
quiz.js            letter + confidence + now --> latch phase, progress,
   |               PURE.                          commit events, score
   v
main.js            orchestration: render loop, skeleton overlay, status,
   |               target word, progress bar, localStorage, URL state
   |--> confusion.js     matrix accumulation (pure) + canvas heatmap
   '--> canvas 2D        skeleton overlay on the camera preview
```

| Module | Responsibility | Pure? |
|---|---|---|
| `src/js/letters.js` | Landmarks to letter. Frame, mask, buckets, ladders, margins | Yes |
| `src/js/quiz.js` | Word selection, latch state machine, scoring | Yes |
| `src/js/confusion.js` | Matrix accumulation, cell state, ramp, heatmap draw | Pure except a ctx parameter |
| `src/js/handTracker.js` | Camera lifecycle, MediaPipe, mirroring, skeleton bone list | No |
| `src/js/main.js` | Wiring, render loop, DOM, storage, URL | No |
| `server.js` | Static file server, no dependencies | — |

## Layout

| Path | Role |
|---|---|
| [spec/SPEC.md](spec/SPEC.md) | Thresholds, formulas, cascade design, failure modes |
| [FEATURES.md](FEATURES.md) | Feature inventory, non-goals, known gaps, backlog |
| [CLAUDE.md](CLAUDE.md) | Session context — read this first if picking the project up |
| `src/js/letters.js` | The classifier — pure, no DOM |
| `src/js/quiz.js` | Latch state machine and word quiz — pure |
| `src/js/confusion.js` | 26x26 matrix accumulation and heatmap |
| `tests/hand-fixture.mjs` | Synthetic landmark generator for all 24 letters |
| `tests/harness.mjs` | Assertion helpers and fake DOM |

## A note on the tests

The suite runs without a camera or browser. Fixture geometry assertions (finger
straightness bands, thumb position separations) run on pure JS and pass
immediately. Classifier and quiz assertions fail until the implementation is
built — that is the intended starting state, not a sign something is broken.

## Series

| Project | Subject |
|---|---|
| [galaxy-spiral](../galaxy-spiral/) | MediaPipe hand tracking, WebGL2, spec-first discipline |
| [webgpu-particles](../webgpu-particles/) | WGSL compute, storage buffers, ping-pong, indirect draw |
| **asl-trainer** | 26-class gesture taxonomy, confusion matrix |
| [rag-notebook](../rag-notebook/) | In-browser embeddings, vector search, Claude synthesis |
| [mcp-agent-lab](../mcp-agent-lab/) | MCP server, agent loop, tool-use visualisation |
| [voice-notes](../voice-notes/) | Local Whisper transcription, Claude summarisation |

# WebGPU Particles

A million particles in a damped-spring field, integrated by a WGSL compute
shader. Sequel to [galaxy-spiral](../galaxy-spiral/) — same physics, same eight
shapes, three orders of magnitude more particles, because the position buffer
never leaves the GPU.

> **Status: unimplemented.** The specification, feature document and module
> skeletons are complete; the implementation is not. Tests fail red by design.
> See [CLAUDE.md](CLAUDE.md) for what to build next.

## Quick start

```bash
node server.js          # http://localhost:5173
npm test                # three suites, no browser or GPU required
npm test -- unit        # one suite by substring
```

No dependencies, no build step. `npm install` is not necessary.

Requires WebGPU: Chrome 121+, Edge 121+, Safari 18+, or Firefox 141+. Chrome on
Linux may need `--enable-unsafe-webgpu`. There is no WebGL2 fallback — that is
[galaxy-spiral](../galaxy-spiral/).

## Architecture

```
  CPU, once per shape change          CPU, once per frame
  ────────────────────────            ───────────────────
  shapes.js  ──▶  targets buffer      camera.js ──▶ uniforms (128 B)
                        │                                │
                        ▼                                ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  GPU                                                         │
  │                                                              │
  │   particleA ──▶ compute pass ──▶ particleB                    │
  │        ▲        (integrate)          │                        │
  │        └──────── ping-pong ──────────┘                        │
  │                                      │                        │
  │                                      ▼                        │
  │                               render pass ──▶ canvas          │
  │                            (point-list, additive)             │
  └──────────────────────────────────────────────────────────────┘
```

The particle buffer is written by the compute pass and read by the render pass
within one command submission. Positions are never copied back to JavaScript —
per-frame CPU work is a fixed 128-byte uniform upload and one submission,
independent of particle count. That invariance is the result the project exists
to demonstrate.

## Layout

| Path | Role |
|---|---|
| [spec/SPEC.md](spec/SPEC.md) | Buffer layouts, formulas, rationale, failure modes |
| [FEATURES.md](FEATURES.md) | Feature inventory, non-goals, known gaps, backlog |
| [CLAUDE.md](CLAUDE.md) | Session context — read this first if you are picking the project up |
| `src/js/shaders.js` | WGSL as template strings, so Node can assert on the source |
| `src/js/gpu.js` | Device init, buffers, bind groups, frame loop |
| `src/js/integrator.js` | JS reference integrator — a deliberate second implementation, see SPEC §7.1 |
| `src/js/shapes.js` | The eight target generators, pure |
| `tests/harness.mjs` | Fake `GPUDevice` that records every call |

## Controls

`1`–`8` shape · drag orbit · scroll dolly · hold left button to grab ·
`Space` burst · `G` palette · `R` reset camera · `?dots=` 2^10 … 2^22

## A note on the tests

The suite runs without a GPU, which means it cannot prove the WGSL compiles or
that a single pixel is correct. Shader coverage is regex assertions on source
text (SPEC §7.3) guarding four mistakes that produce no error and no obvious
artifact. **Green tests plus a black canvas is an expected state, not a
contradiction** — closing that gap needs a real device and is in the backlog.

## Series

| Project | Subject |
|---|---|
| [galaxy-spiral](../galaxy-spiral/) | MediaPipe hand tracking, WebGL2, spec-first discipline |
| **webgpu-particles** | WGSL compute, storage buffers, ping-pong, indirect draw |
| [asl-trainer](../asl-trainer/) | 26-class gesture taxonomy, confusion matrix |
| [rag-notebook](../rag-notebook/) | In-browser embeddings, vector search, Claude synthesis |
| [mcp-agent-lab](../mcp-agent-lab/) | MCP server, agent loop, tool-use visualisation |
| [voice-notes](../voice-notes/) | Local Whisper transcription, Claude summarisation |

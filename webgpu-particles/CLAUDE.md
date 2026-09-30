# WebGPU Particles — Claude Session Context

Read this first. It tells you what the project is, what is decided, and what to
build next. The authoritative detail is in [spec/SPEC.md](spec/SPEC.md) — this
file is the map, not the territory.

## Goal

Simulate and render 1 048 576 particles at 60 fps by moving the physics
integrator into a WGSL compute shader. It is the direct sequel to
[galaxy-spiral](../galaxy-spiral/) — same damped-spring model, same eight-shape
catalogue, same spec-first discipline — but the particle buffer never leaves the
GPU. Per-frame CPU work is a fixed 128-byte uniform upload regardless of
particle count, and demonstrating that invariance is the point of the project.

## Stack

- Vanilla JS ES modules, no build step, no dependencies
- WebGPU only — no WebGL2 fallback, by design (SPEC §1.2)
- WGSL shaders as template strings in `src/js/shaders.js` so Node can assert on them
- Node built-in test runner via `node tests/run.mjs`
- Zero-dependency static server on port 5173

## Key design decisions

Each of these was decided deliberately; do not "fix" them without reading the
cited section first.

- **32-byte particle struct** with scalars packed into `vec3` alignment slack.
  A naive `{pos: vec3, vel: vec3}` wastes 8 bytes to WGSL alignment rules. SPEC §3.1
- **Ping-pong buffers, two bind groups built once at init.** Creating bind
  groups inside the frame loop is the most common WebGPU performance mistake;
  this design makes it impossible. SPEC §4.4
- **Damping uses `pow(damping, dt * 60)`**, carried over unchanged from
  galaxy-spiral, which already does this correctly. Do not "simplify" it to a
  bare multiply — that couples settle time to frame rate. SPEC §4.3
- **`targets` buffer is written on shape change only**, never per frame.
  Writing it per frame would reintroduce the 32 MiB/frame upload the project
  exists to eliminate. SPEC §3.2
- **Indirect draw is wired up before any culling pass needs it.** Cheap now,
  avoids a CPU round-trip later. SPEC §5.3
- **1 px points, no quad expansion.** At 2^20 particles the image is a density
  field; quad expansion would quadruple vertex work for no perceptual gain.
  This is a non-goal, not a limitation. SPEC §5.1
- **Air pointer added (SPEC §1.3).** The "no gesture input" non-goal is
  reversed. The compute work is done; gestures at a million particles are
  additive. The Galaxy Spiral hand-tracker is re-used unchanged. A pure
  `airPointer.js` state machine (no DOM, no MediaPipe import) handles the
  reach-threshold tap detection and is fully unit-tested in
  `tests/pointer.test.mjs`. Mouse and keyboard remain unaffected.

## The four guards that are invisible when wrong

These each correspond to a bug that produces no error, no warning, and no
obvious visual artifact. `tests/pipeline.test.mjs` asserts each one by regex on
the shader source (SPEC §7.3). If you touch `shaders.js`, keep them.

1. `if (i >= u.count) { return; }` — tail invocations otherwise write past the
   live region into our own allocation. No crash, just wasted frame time.
2. `select(vec3(0.0), normalize(d), r2 > 1e-8)` — `normalize` of a zero vector
   is undefined. Note `select(false_val, true_val, cond)` argument order is the
   reverse of a C ternary.
3. `pow(` in the damping term — a bare multiply silently makes physics
   frame-rate dependent.
4. `if (i == 0u)` around the `drawArgs` write — otherwise 2^20 invocations race
   to write the same address.

## Commands

| Command | Purpose |
|---|---|
| `node server.js` | Serve at http://localhost:5173 |
| `npm test` | Run all three suites |
| `npm test -- unit` | Run one suite by substring |
| `npm run bench` | Per-frame CPU cost profile (CPU side only; GPU needs a device) |

## Status

- [x] `spec/SPEC.md` — written, §1.3 air pointer added
- [x] `FEATURES.md` — written, air pointer section added
- [x] `README.md` — written
- [x] `src/js/` — fully implemented (layout, shapes, integrator, camera, gpu, main)
- [x] `src/js/handTracker.js` — copied from galaxy-spiral, unchanged
- [x] `src/js/gestures.js` — copied from galaxy-spiral, unchanged
- [x] `src/js/airPointer.js` — pure state machine, no DOM, fully unit-tested
- [x] `tests/pointer.test.mjs` — air pointer unit tests (mirror, viewport, hysteresis, click)
- [x] `tests/` — 266 + new pointer assertions, all passing

## What to do next

Work in this order. Each step has tests waiting for it.

1. `src/js/layout.js` — struct offsets. `unit.test.mjs` already asserts every
   offset in SPEC §3.1 and §3.3. Pure arithmetic, no GPU, quickest win.
2. `src/js/shapes.js` — the eight generators. Port from
   `../galaxy-spiral/src/js/shapes.js`, which is already pure and tested;
   the only change is writing into a caller-supplied `Float32Array` with a
   stride of 8 floats rather than 3, to match the particle struct.
3. `src/js/integrator.js` — the JS reference integrator. Must match the WGSL in
   `shaders.js` numerically. This is a deliberate second implementation so the
   physics can be asserted in Node; see SPEC §7.1 for the drift risk.
4. `src/js/camera.js` — orbit camera and `viewProj`. Tests assert a known point
   round-trips.
5. `src/js/gpu.js` — device init, buffers, bind groups, frame loop. Driven by
   the fake device in `tests/harness.mjs`; the contract assertions in
   `pipeline.test.mjs` define the expected call sequence.
6. `src/js/main.js` — wire input, URL state, and the failure paths of SPEC §9.

Run `npm test` after each step. The suites are ordered so that a green `unit`
is a precondition for a meaningful `pipeline`.

## Traps specific to this project

- **A black canvas is the default failure.** Almost every WebGPU mistake
  renders nothing and logs nothing. SPEC §9 requires every failure path to
  render text, including shader compile errors surfaced from
  `compilationInfo()`. Build that before building the renderer, or you will
  debug blind.
- **`device.lost` is a promise, not an event.** It resolves once. Re-awaiting a
  resolved promise returns immediately — do not put the await in a retry loop
  without re-requesting the device first. SPEC §2.3
- **WebGPU errors are asynchronous.** A validation failure surfaces through
  `device.pushErrorScope` / `popErrorScope` or the uncaptured-error handler, not
  as a thrown exception at the call site. Install the handler in `init()`.
- **The test suite cannot prove the WGSL compiles.** It asserts on shader source
  as text (SPEC §7.3). Green tests plus a black canvas is an expected state, not
  a contradiction. Closing this gap is in the backlog.

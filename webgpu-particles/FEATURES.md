# WebGPU Particles — Feature Document

**Version** 1.0 · **Date** 2026-09-30 · **Status** Draft (unimplemented)

The feature-oriented view. For formulas, buffer layouts and rationale see
[spec/SPEC.md](spec/SPEC.md). For what to build next see [CLAUDE.md](CLAUDE.md).

---

## What it is

A zero-install web page that holds a million particles in a damped-spring
field and lets you push them around. Same physics and same eight shapes as
[galaxy-spiral](../galaxy-spiral/), three orders of magnitude more particles,
because the integrator runs as a WGSL compute shader and the position buffer
never comes back to JavaScript.

---

## Feature inventory

### Particle field

| Detail | Value |
|---|---|
| Count | 2^20 (1 048 576) default, `?dots=` 2^10 … 2^22 |
| Record size | 32 bytes — `pos`, `seed`, `vel`, `life` |
| Physics | Damped spring, frame-rate independent via `pow(damping, dt * 60)` |
| Integration | Semi-implicit Euler, one compute invocation per particle |
| Dispatch | `@workgroup_size(256)`, `ceil(count / 256)` workgroups |
| Buffering | Ping-pong, two bind groups built once at init |
| Frame guard | `dt` clamped to [0, 0.05 s] on the CPU before upload |
| Per-frame CPU work | One 128-byte `writeBuffer`, one submission — constant in particle count |

### Eight shapes

Same catalogue and same keys as Galaxy Spiral, so the two are directly
comparable.

| Key | Name | Geometry |
|---|---|---|
| `1` | Core | Jittered ball, radius 0.26 |
| `2` | Sphere | Fibonacci sphere |
| `3` | Torus | R 0.82, r 0.32 |
| `4` | Cube | Uniform over six faces |
| `5` | Helix | Double helix, rungs every 9th point |
| `6` | Galaxy | 4 arms, √ radial density |
| `7` | Ringed | Planet plus debris halo |
| `8` | Wave | Grid with sine displacement |

Shape targets are generated lazily on first selection and cached, four
resident, LRU eviction. Generating 2^20 points costs ~18 ms, so a switch to a
cached shape is free and a switch to a cold one hitches once.

Morphing needs no interpolation code: changing the target buffer changes where
the springs pull, and the existing physics produces the flow.

### Interaction

| Input | Action |
|---|---|
| `1`–`8` | Shape |
| Drag | Orbit camera |
| Scroll | Dolly zoom — moves the camera, does not change FOV |
| Hold left button | Grab at the cursor's world ray, inverse-square falloff |
| `Space` | Radial velocity injection |
| `G` | Cycle palette |
| `R` | Reset camera |
| Index finger forward | Air-pointer grab (hold) |
| Index finger back | Air-pointer release |

### Air pointer (hand tracking)

| Detail | Value |
|---|---|
| Input | MediaPipe HandLandmarker via CDN |
| Cursor | Index fingertip, exponentially smoothed (factor 0.4) |
| Press gesture | Forward reach of index tip, normalised by hand span |
| Press threshold | PRESS_REACH = 1.5 (reach units) |
| Release threshold | RELEASE_REACH = 0.9 (hysteresis gap prevents chattering) |
| Dwell | 70 ms minimum hold before press commits |
| Auto-calibration | Tracks observed reach min/max; adapts after 30 warm-up frames |
| Camera request | On explicit Enable click only — never auto-requested |
| Failure messages | Three distinct: NotAllowedError, NotFoundError, NotReadableError |
| Mouse/keyboard | Fully preserved — air pointer is additive, not a replacement |

### Rendering

One `drawIndirect` call per frame over a `point-list`. No vertex buffer — the
vertex shader indexes the storage buffer by `@builtin(vertex_index)`. Additive
blending, depth test off, which makes the result order-independent and is why a
million unsorted points read correctly rather than z-fighting.

Indirect draw is wired up before anything needs it, so a future culling pass
can compact the visible set without a CPU round-trip.

### Diagnostics

Shader compile errors are surfaced into the page verbatim from
`compilationInfo()`, not just logged. Adapter limits, chosen particle count and
per-frame timings are shown in a panel. Every failure path in SPEC §9 renders
text — there is no state that shows a black rectangle with no explanation.

### Testing

Three suites, no dependencies, no browser, no GPU (`npm test`). Pure modules
are asserted numerically; the GPU layer is asserted by contract against a fake
device that records every call; the WGSL is asserted as text.

---

## Deliberate non-goals

These are choices, not gaps. Each is argued in the spec.

**No WebGL2 fallback.** A second renderer means a second integrator, and the
subject of this project is compute shaders. Galaxy Spiral is the WebGL2
answer and the failure page links to it. SPEC §1.2

**1 px points, no quad expansion.** WebGPU has no `gl_PointSize`, so
depth-scaled sprites would require emitting quads. At this particle count the
image is a density field, not a field of discrete sprites — quad expansion
would quadruple vertex work for no perceptual gain. SPEC §5.1

**No trails.** Compositing a translucent quad saturates to white within a
second at 2^20 particles. SPEC §5.2

**No position readback.** Any design that reads positions to JavaScript
reintroduces the stall this project exists to remove. SPEC §1.2

**No position readback.** Any design that reads positions to JavaScript
reintroduces the stall this project exists to remove. SPEC §1.2

---

## Inherited invariant

Damping uses `pow(damping, dt * 60)`, carried over unchanged from
`galaxy-spiral/src/js/particles.js`, which already gets this right. The
tempting simplification — multiplying velocity by a bare `damping` once per
frame — couples the decay rate to the frame rate, so a 30 fps machine would
settle at half the speed of a 60 fps one.

The point of testing it is not that anything is currently wrong, it is that the
wrong version is shorter and reads as a cleanup, so the property needs a test
standing on it.

What `pow` actually buys is narrower than it first appears, and the spec now
says so with numbers. The per-second **decay** is exact across frame rates —
identical to nine decimal places from 30 to 240 fps. Total **settle time** is
not, and cannot be: the spring force is sampled once per step, so semi-implicit
Euler overshoots more at larger `dt`. Measured spread is 16 % from 30 to
240 fps, converging on about 3.43 s.

An earlier draft of the spec claimed settle time was equal within 2 %. That was
false, and the test written against it failed against the first correct
implementation. It now asserts what is true — exact decay equality, one-sided
error, convergence, and a 3.4–4.1 s band — because a test asserting a property
the code does not have either fails or gets loosened until it proves nothing.
That is the same trap as the Galaxy Spiral 1.1 pinch assertions.

---

## Known gap

The suite cannot prove the WGSL compiles, let alone that it produces correct
pixels. Shader coverage is regex assertions on source text (SPEC §7.3), which
catch deletion but not misuse. **Green tests plus a black canvas is an expected
state, not a contradiction.**

Four guards are invisible when wrong — no error, no warning, no obvious
artifact. They are the reason the text assertions exist at all:

| Guard | Symptom when missing |
|---|---|
| `if (i >= u.count) return` | Tail invocations write into our own allocation; frame cost does not match dot count |
| `select(vec3(0.0), normalize(d), r2 > 1e-8)` | `normalize` of zero is undefined; particles at the grab point become NaN |
| `pow(` in the damping term | Physics silently becomes frame-rate dependent |
| `if (i == 0u)` around the `drawArgs` write | 2^20 invocations race on one address; serialises on some drivers |

---

## Backlog

- Playwright against headless Chrome with `--enable-unsafe-webgpu` to close the
  shader-compilation coverage gap
- GPU timestamp queries for real per-pass timings rather than wall clock
- Culling pass writing a compacted count into `drawArgs` — the indirect draw is
  already wired for it
- Collapse `integrator.js` and the WGSL into one generated source so the two
  copies cannot drift
- Spatial hashing for particle-particle forces, which would make the dispatch
  non-independent and require a genuine barrier strategy
- Shape target atlas in a single buffer once `maxStorageBufferBindingSize`
  headroom is common enough to hold all eight

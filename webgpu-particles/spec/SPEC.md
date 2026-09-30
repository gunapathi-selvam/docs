# WebGPU Particles — Technical Specification

**Version** 1.0 · **Date** 2026-09-30 · **Status** Draft (unimplemented)

Sequel to [galaxy-spiral](../../galaxy-spiral/spec/SPEC.md). Same damped-spring
physics, same shape catalogue, three orders of magnitude more particles —
because the integrator moves from JavaScript to a WGSL compute shader and the
position buffer never leaves the GPU.

---

## 1. Purpose and scope

### 1.1 What this project is

A single-page static site that simulates and renders **1 048 576 particles**
(2^20, configurable) at 60 fps. Particle state lives in GPU storage buffers.
A compute pass integrates the physics; a render pass draws the result. The CPU
uploads a 128-byte uniform block per frame and nothing else.

### 1.2 What it deliberately is not

- **Not a port.** Galaxy Spiral's renderer is a *drawing* backend fed by a
  CPU-side array. Here the CPU never sees particle positions. Any design that
  reads positions back to JavaScript is out of scope, because the readback
  stall is the exact cost this project exists to eliminate.
- **Not WebGL2-compatible.** There is no fallback renderer. WebGPU or a text
  explanation — see §9.

### 1.3 Air pointer — reversal of the "not hand-tracked" decision

An earlier draft of this section listed "not hand-tracked" as a deliberate
non-goal. That decision is reversed.

**Rationale.** The compute work is done: a million particles integrate in a
WGSL compute shader at 60 fps. Gestures at that scale are a meaningful step up
from Galaxy Spiral's thousand particles, and the gesture library is already
proven and tested in that project. Re-using it here is additive, not a
distraction from the compute work.

**Reach formula.** The tap gesture uses normalised forward reach of the index
fingertip relative to the wrist:

```
reach = (landmarks[0].z - landmarks[8].z) / handSpan(landmarks)
```

`landmarks[0]` is the wrist; `landmarks[8]` is the index fingertip.
`handSpan` is the 2-D wrist-to-middle-knuckle distance. Dividing by handSpan
makes the metric invariant to hand size and camera distance — raw `z` is
neither.

**Thresholds and hysteresis.**

| Constant | Value | Meaning |
|---|---|---|
| `PRESS_REACH` | 1.5 | Cross upward to enter PRESSED |
| `RELEASE_REACH` | 0.9 | Must fall below to return to IDLE |
| `DWELL_MS` | 70 ms | Minimum hold time before a press commits |

The gap between 0.9 and 1.5 is mandatory hysteresis. A single threshold
chatters at the boundary and produces dozens of phantom clicks per second.
With two thresholds, reach that oscillates between them after a press is
committed causes no state change.

**Dwell.** A single frame of high reach that lasts less than `DWELL_MS` is
rejected. This eliminates spurious presses from momentary noise.

**Auto-calibration.** The observed min/max of `reach` is tracked after the
first 30 warm-up frames. The `normalisedReach` output (0–1) is relative to
this observed range, making the display meaningful independent of the user's
hand size and camera setup.

**Smoothing.** Cursor x and y are exponentially smoothed at factor 0.4
(40 % of the new value per frame). This keeps the cursor responsive without
jitter. Exponential smoothing is monotone, so it cannot overshoot a held
target — an important property when the cursor position affects the grab point
for a million particles.

**Mouse and keyboard are unaffected.** The air pointer updates the same
`pointer` variable the mouse uses; the two coexist and the camera is never
auto-requested. An Enable button in the panel activates hand tracking.

### 1.3 Learning goals

| Goal | Where it appears |
|---|---|
| WGSL compute shaders | §4 |
| Storage buffers and bind groups | §3.2, §3.3 |
| Ping-pong buffer strategy | §4.4 |
| Workgroup sizing and occupancy | §4.2 |
| Indirect draw | §5.3 |
| GPU-side pseudo-random generation | §4.6 |
| Testing GPU code without a GPU | §7 |

---

## 2. Platform requirements

### 2.1 Hard requirements

| Requirement | Reason |
|---|---|
| `navigator.gpu` present | Entire app |
| Adapter reports `maxStorageBufferBindingSize` ≥ 64 MiB | 2^20 particles × 32 B × 2 buffers |
| Adapter reports `maxComputeWorkgroupSizeX` ≥ 256 | §4.2 workgroup width |
| Secure context | `navigator.gpu` is gated on it; `http://localhost` qualifies |

### 2.2 Verified browsers

Chrome 121+, Edge 121+, Safari 18+, Firefox 141+. Chrome on Linux may need
`--enable-unsafe-webgpu`. This is stated in the failure message, not detected.

### 2.3 Device loss

`device.lost` is a promise, not an event that fires once. On resolution the app
tears down all buffers, re-runs `init()`, and restores the shape and camera
from the URL hash. A lost device during the first `init()` is a hard failure —
retrying a device that never worked produces an infinite loop.

---

## 3. Data layout

### 3.1 Particle record

32 bytes, chosen so that a particle is exactly two 16-byte rows and no field
straddles a row boundary. `vec3<f32>` in a storage buffer has 16-byte
alignment under WGSL's default layout rules, so a naive
`{pos: vec3, vel: vec3}` struct would occupy 32 bytes with 8 wasted. Packing
the spare lanes with scalars costs nothing.

```wgsl
struct Particle {
  pos  : vec3<f32>,  // offset  0  world space
  seed : f32,        // offset 12  per-particle RNG seed, never mutated
  vel  : vec3<f32>,  // offset 16  world units / second
  life : f32,        // offset 28  0..1, drives colour ramp and radius
}
// size 32, align 16
```

At 2^20 particles one buffer is 32 MiB. Two buffers (§4.4) is 64 MiB.

### 3.2 Buffers

| Buffer | Size (2^20) | Usage flags | Written by |
|---|---|---|---|
| `particleA` | 32 MiB | `STORAGE \| COPY_DST` | compute (alternating) |
| `particleB` | 32 MiB | `STORAGE \| COPY_DST` | compute (alternating) |
| `targets` | 32 MiB | `STORAGE \| COPY_DST` | CPU on shape change only |
| `uniforms` | 128 B | `UNIFORM \| COPY_DST` | CPU every frame |
| `drawArgs` | 16 B | `INDIRECT \| STORAGE` | compute (§5.3) |

`targets` holds the destination position for each particle in the current
shape. It is written once per shape change, not per frame. Writing it per
frame would reintroduce the 32 MiB/frame upload this design removes.

### 3.3 Uniform block

128 bytes. `mat4x4<f32>` is 64 bytes and 16-byte aligned; the scalars fill the
tail of the second half without padding.

```wgsl
struct Uniforms {
  viewProj   : mat4x4<f32>,  // offset  0
  dt         : f32,          // offset 64  seconds, clamped (§4.3)
  stiffness  : f32,          // offset 68
  damping    : f32,          // offset 72
  time       : f32,          // offset 76  seconds since start, for drift
  grabPoint  : vec3<f32>,    // offset 80  world space
  grabRadius : f32,          // offset 92  0 disables
  grabForce  : f32,          // offset 96
  drift      : f32,          // offset 100
  count      : u32,          // offset 104 active particle count
  _pad       : f32,          // offset 108
  // offsets 112..127 reserved
}
```

`count` is a uniform rather than a compile-time constant so that `?dots=`
changes do not require a shader recompile. The compute shader bounds-checks
against it (§4.2).

---

## 4. Compute pass

### 4.1 Responsibility

One invocation per particle per frame. Reads the particle from the input
buffer, applies spring force toward its target, applies grab force, applies
drift, integrates, writes to the output buffer. No inter-particle
interaction — every invocation is independent, which is why this scales
linearly and needs no barriers.

### 4.2 Dispatch geometry

```
@workgroup_size(256, 1, 1)
dispatchWorkgroups(ceil(count / 256), 1, 1)
```

256 is chosen because it is the largest width guaranteed by
`maxComputeWorkgroupSizeX` on every target (§2.1) and a multiple of the 32/64
lane widths of all current hardware, so no lanes idle inside a workgroup.

`ceil` means the final workgroup is partially out of range. Every invocation
must therefore begin:

```wgsl
let i = gid.x;
if (i >= u.count) { return; }
```

**This guard is not optional.** Without it the tail invocations read and write
past `count`, corrupting whatever the allocator placed after the live region.
Because the buffer is allocated at maximum capacity the writes land inside our
own allocation, so there is no crash and no validation error — just particles
that are simulated but never drawn, visible only as a frame-time cost that
does not match the dot count. Assert it in `pipeline.test.mjs`.

### 4.3 Integrator

Semi-implicit Euler with velocity damping, identical in form to
`galaxy-spiral/src/js/particles.js` so results are comparable:

```
 toTarget = target - pos
 accel    = toTarget * stiffness  +  grab  +  drift
 vel      = (vel + accel * dt) * pow(damping, dt * 60)
 pos      = pos + vel * dt
```

`pow(damping, dt * 60)` makes **the damping term** frame-rate independent, and
is carried over unchanged from `galaxy-spiral/src/js/particles.js`, which
already does this correctly. The tempting simplification — multiplying velocity
by a bare `damping` once per frame — couples the decay rate to the frame rate,
so a 30 fps machine settles at half the speed of a 60 fps one.

**What this does and does not buy, measured.** The per-second decay is exact
across frame rates: identical to nine decimal places from 30 to 240 fps. Total
settle time is *not*, and cannot be, because the spring force is sampled once
per step — semi-implicit Euler overshoots more at larger `dt`. Measured time
for a particle released at distance 1 to come within 1e-3 of its target, at
stiffness 13 and damping 0.88:

| Frame rate | Settle time |
|---|---|
| 30 fps | 4.000 s |
| 60 fps | 3.683 s |
| 90 fps | 3.578 s |
| 120 fps | 3.525 s |
| 144 fps | 3.493 s |
| 240 fps | 3.446 s |

A 16 % spread across that range, converging on roughly 3.43 s as `dt` goes to
zero. The error is **one-sided** — a coarser step always settles slower, never
faster — and that, with convergence, is what is worth asserting.
`unit.test.mjs` checks exact decay equality at 1e-6, monotonicity in `dt`,
convergence, and a 3.4–4.1 s band.

It deliberately does **not** assert settle-time equality across frame rates.
An earlier draft of this section claimed equality within 2 %; that claim was
false, and the test written against it failed on the first correct
implementation. A test asserting a property the integrator does not have
either fails or gets loosened until it proves nothing — the same trap as the
Galaxy Spiral 1.1 pinch assertions, which measured a statistic that could not
distinguish right from wrong.

Closing the remaining gap needs a different integrator — velocity Verlet, or
the analytic damped-spring solution — which is in the FEATURES.md backlog
rather than here, because the visual difference at 60 fps does not currently
justify the change.

`dt` is clamped to `[0, 0.05]` on the CPU before upload. A backgrounded tab
resuming after 10 s would otherwise integrate a 10-second step and fling every
particle to infinity, where the perspective divide turns them into NaN and the
swarm never returns. Same guard as Galaxy Spiral, same reason.

### 4.4 Ping-pong

A compute invocation may not read and write the same storage buffer location
in one pass without a barrier, and WGSL offers no device-wide barrier inside a
dispatch. Two buffers, swapped each frame:

| Frame parity | Compute reads | Compute writes | Render reads |
|---|---|---|---|
| even | `particleA` | `particleB` | `particleB` |
| odd | `particleB` | `particleA` | `particleA` |

Two bind groups are created once at init — one per parity — and selected with
`frame & 1`. Creating bind groups per frame is a measurable allocation cost at
60 fps and is the single most common WebGPU beginner mistake this project
avoids by construction.

The render pass reads the buffer the compute pass just wrote, so the two passes
are ordered by a single `commandEncoder` submission. No explicit fence is
needed — WebGPU orders passes within a submission.

### 4.5 Grab force

Inverse-square falloff with a floor, matching Galaxy Spiral's localised grab:

```
 d      = grabPoint - pos
 r2     = dot(d, d)
 pull   = grabForce / max(r2, 0.02)
 grab   = normalize(d) * pull * step(r2, grabRadius * grabRadius)
```

`max(r2, 0.02)` prevents the singularity at r = 0. `normalize(d)` is
undefined when `d` is exactly zero; the `max` does not protect against that
because it clamps the *magnitude*, not the direction. Guard explicitly:

```wgsl
let dir = select(vec3(0.0), normalize(d), r2 > 1e-8);
```

`select(f, t, cond)` returns `t` when `cond` is true — note the argument order,
which is the reverse of a C ternary and a routine source of inverted logic.

### 4.6 Drift

Per-particle idle motion. There is no `rand()` in WGSL, so the shader needs a
hash. A cheap integer hash on the particle index plus time:

```wgsl
fn hash11(p: f32) -> f32 {
  var h = fract(p * 0.1031);
  h *= h + 33.33;
  h *= h + h;
  return fract(h);
}
```

Drift is then three decorrelated sine waves seeded from `seed`:

```
 drift = vec3(
   sin(time * 0.7 + seed * 6.28),
   sin(time * 0.9 + seed * 9.42),
   sin(time * 1.1 + seed * 3.14)
 ) * driftAmount
```

Sines rather than hash-per-frame because the motion must be *continuous* —
a fresh hash each frame is white noise and reads as jitter, not breathing.

---

## 5. Render pass

### 5.1 Topology

`point-list`. One vertex per particle, `@builtin(vertex_index)` used to index
the storage buffer directly — there is no vertex buffer and no attribute
layout. The particle buffer is bound as a read-only storage buffer in the
vertex stage.

Point size is fixed at 1 px in WebGPU; there is no `gl_PointSize`. To get
depth-scaled sprites the vertex shader would need to emit quads. This project
accepts 1 px points, because at 2^20 particles the visual result is a density
field rather than discrete sprites, and quad expansion would quadruple vertex
work for no perceptual gain. Documented as a non-goal in FEATURES.md, not a
limitation.

### 5.2 Blending

Additive, `src: one`, `dst: one`, depth test disabled. Additive blending is
order-independent, which is what makes depth sorting unnecessary — the same
reasoning as Galaxy Spiral §6.4, and the reason a million unsorted points look
correct rather than like z-fighting.

Clear colour is opaque black each frame. Trails are *not* implemented by
compositing a translucent quad: at this particle count the accumulation
saturates to white within a second. Trails are out of scope.

### 5.3 Indirect draw

`drawIndirect` reads its vertex count from `drawArgs`, which the compute pass
writes. This is deliberately more machinery than `draw(count)` needs today —
it exists so that a future culling pass can compact the visible set without a
CPU round-trip. The buffer layout is the WebGPU-mandated
`[vertexCount, instanceCount, firstVertex, firstInstance]` as four `u32`.

Until culling lands, the compute shader writes `vertexCount = u.count` from
invocation 0 only:

```wgsl
if (i == 0u) { drawArgs.vertexCount = u.count; }
```

Letting every invocation write it is a race. It is a *benign* race — all
invocations write the same value — but it is still 2^20 redundant writes to one
address, and on some drivers that serialises.

---

## 6. Shapes

Eight shapes, same catalogue and same keys as Galaxy Spiral so the two projects
are directly comparable. Generated on the CPU into a `Float32Array` and
uploaded to `targets` on change.

| Key | Name | Geometry |
|---|---|---|
| `1` | Core | Jittered ball, radius 0.26 |
| `2` | Sphere | Fibonacci sphere |
| `3` | Torus | R 0.82, r 0.32 |
| `4` | Cube | Uniform over six faces |
| `5` | Helix | Double helix, rungs every 9th |
| `6` | Galaxy | 4 arms, √ radial density |
| `7` | Ringed | Planet plus debris halo |
| `8` | Wave | Grid with sine displacement |

### 6.1 Generation cost

At 2^20 particles a shape generator runs 2^20 iterations. Measured in Node at
roughly 18 ms for the Fibonacci sphere — a visible hitch if run on the main
thread during interaction. Generators therefore run **once at init for all
eight shapes** into a single 256 MiB `targets` atlas, and a shape change
becomes a bind-group offset change rather than a regeneration.

256 MiB exceeds `maxStorageBufferBindingSize` on many adapters. The atlas is
therefore capped: shapes are generated lazily on first selection and cached,
with an LRU eviction at four resident shapes. The first switch to a given shape
costs one generation; subsequent switches are free. `boot.test.mjs` asserts the
cache holds at most four and evicts least-recently-used.

### 6.2 Morph

There is no separate morph state. Changing `targets` changes where the springs
pull, and the existing spring physics produces the flow. This is the same
property Galaxy Spiral relies on and the reason shape switching needs no
interpolation code.

---

## 7. Testing without a GPU

`navigator.gpu` does not exist in Node. The test strategy is the same one that
makes Galaxy Spiral testable: push everything decidable onto pure functions and
verify the GPU layer by contract rather than by execution.

### 7.1 What is unit-tested

| Module | Property asserted |
|---|---|
| `shapes.js` | Point counts, bounding radii, no NaN, deterministic for a fixed seed |
| `layout.js` | Struct offsets and sizes match §3.1 and §3.3 exactly |
| `camera.js` | `viewProj` round-trips a known point; orthonormal basis |
| `integrator.js` | JS reference integrator matches §4.3; frame-rate independence |

`integrator.js` is a JavaScript port of the WGSL integrator, maintained
deliberately as a **second implementation**. It exists so the physics can be
asserted numerically in Node. The risk is drift between the two copies; the
mitigation is §7.3.

### 7.2 What is contract-tested

`gpu.js` is driven by a fake device (`tests/harness.mjs`) that records every
call. The suite asserts:

- Bind groups are created exactly twice, at init, never inside the frame loop
- `writeBuffer` is called once per frame with 128 bytes, and never with 32 MiB
- The buffer read by the render pass is the one written by the compute pass
- `dispatchWorkgroups` receives `ceil(count / 256)`
- On `device.lost` resolution, every buffer is destroyed before re-init

The third assertion is the ping-pong correctness check and the one most likely
to catch a real regression: a swapped parity is invisible for a static swarm
and shows up only as one frame of lag under motion.

### 7.3 Shader source assertions

The WGSL lives in `shaders.js` as template strings, so Node can read it as
text. `pipeline.test.mjs` asserts by regex that the source contains:

- The bounds guard of §4.2
- The `select(...)` zero-direction guard of §4.5
- A `pow(` in the damping term, not a bare multiply (frame-rate independence)
- `if (i == 0u)` around the `drawArgs` write of §5.3

Text assertions on shader source are a weak form of verification and are
documented as such. They catch deletion, not misuse. They exist because the
alternative — no coverage at all for the shader — is worse, and because each
one corresponds to a bug that is invisible in normal operation.

### 7.4 Not covered

Nothing in this suite proves the WGSL *compiles*, let alone produces correct
pixels. That requires a real device. The gap is acknowledged in FEATURES.md
under Backlog: a Playwright run against headless Chrome with
`--enable-unsafe-webgpu` would close it.

---

## 8. Controls

| Input | Action |
|---|---|
| `1`–`8` | Shape |
| Drag | Orbit camera |
| Scroll | Zoom (dolly, not FOV) |
| Hold left button | Grab at the cursor's world-space ray at the swarm's depth |
| `Space` | Radial velocity injection |
| `G` | Cycle palette |
| `R` | Reset camera |
| `?dots=` | 2^10 … 2^22, clamped to adapter limits |

Zoom moves the camera rather than changing FOV because changing FOV at a fixed
camera distance distorts the perspective divide and makes the swarm appear to
inflate. Dolly preserves the projection and is what users expect from "zoom".

---

## 9. Failure modes

| Condition | Behaviour |
|---|---|
| `navigator.gpu` absent | Full-page explanation, browser list, link to Galaxy Spiral as the WebGL2 alternative |
| `requestAdapter()` returns null | Same, with a note about software rendering and the Chrome flag |
| Adapter limits below §2.1 | Reduce `count` to fit; if still impossible, explain |
| Shader compile error | Surface `compilationInfo()` messages verbatim in the page, not just the console — a silent black canvas is the worst possible failure |
| `device.lost` | Teardown and re-init per §2.3 |

Every failure path renders text. There is no state in which the user sees a
black rectangle with no explanation.

---

## 10. Performance targets

Measured on the frame's GPU timestamp query where available, wall clock
otherwise.

| Particles | Compute | Render | Target total |
|---|---|---|---|
| 2^20 (1 048 576) | ≤ 1.2 ms | ≤ 2.5 ms | ≤ 4 ms |
| 2^22 (4 194 304) | ≤ 4.5 ms | ≤ 9 ms | ≤ 14 ms |

Per-frame CPU work is a fixed 128-byte `writeBuffer` plus one submission,
independent of particle count. That invariance is the headline result of the
project and is asserted structurally in §7.2 rather than by timing, because
timing assertions are flaky in CI.

---

## 11. Changelog

### 1.0 — Draft

Initial specification. Unimplemented. Derived from galaxy-spiral 1.1 with these
deliberate departures:

| Change | Rationale |
|---|---|
| Frame-rate-independent damping carried over unchanged | Upstream already does this correctly; the assertion exists so a future simplification to a bare multiply cannot land unnoticed |
| No renderer fallback | A WebGL2 path would mean two integrators; the project's subject is compute shaders |
| Indirect draw before culling exists | Cheap now, avoids a CPU round-trip later |
| Shape target atlas with LRU | 2^20-point generation is too slow to run per switch, too large to keep all eight resident |
| Gesture input dropped | Already solved upstream; would crowd out the compute work |

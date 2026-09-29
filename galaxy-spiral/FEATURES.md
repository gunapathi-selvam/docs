# Galaxy Spiral — Feature Document

**Version** 1.1 · **Date** 2026-09-30 · **Status** Current

The feature-oriented view of the app. For requirements, formulas and the
changelog, see [spec/SPEC.md](spec/SPEC.md).

---

## What it is

A single-page, zero-install web app that turns a field of dots into a live
sculpture controlled entirely by hand gestures in front of a laptop camera.
When no camera is available, a full keyboard and mouse fallback keeps every
feature accessible.

---

## Feature inventory

### Particle field

| Detail | Value |
|---|---|
| Dot count | 1000 default, `?dots=` 100–40 000 |
| Physics | Damped spring: stiffness 13 × morph, damping 0.88 |
| Shape switch | Targets swap; the swarm flows into its new form rather than snapping |
| Burst | Radial velocity injection; the same springs pull everything back |
| Idle drift | Per-particle breathing, scaled by the Drift control and by audio energy |
| Baseline spin | Y-axis auto-rotation at 0.18 rad/s when idle |
| Frame guard | `dt` clamped to [0, 0.05 s] — a backgrounded-tab resume cannot explode the integrator |

### Eight shapes

| Key | Fingers | Name | Geometry |
|---|---|---|---|
| `1` | 0 (fist) | Core | Dense jittered ball, radius 0.26 |
| `2` | 1 | Sphere | Fibonacci sphere |
| `3` | 2 | Torus | R 0.82, r 0.32 |
| `4` | 3 | Cube | Uniform points across six faces |
| `5` | 4 | Helix | Double helix, rungs every 9th point |
| `6` | 5 (open palm) | Galaxy Spiral | 4 arms, √ radial density |
| `7` | — | Ringed World | Planet plus debris halo |
| `8` | — | Wave Field | Grid with runtime sine displacement |

### Gesture control

**One hand** — palm position translates, wrist roll rotates Z, palm pitch
rotates X, sideways sweep spins Y, distance to lens scales, finger count
selects a shape, pinch grabs.

**Two hands** — spread scales, relative tilt rotates like a steering wheel,
the midpoint translates, matching finger counts switch shape, either hand
pinching grabs at the midpoint, both fists fire a supernova.

The grab lands under the hand and falls off with distance, so it gathers the
nearest dots rather than imploding the whole field.

### Recognition

Finger extension is measured by **chain straightness** (end-to-end distance ÷
summed segment length), which is orientation-free — verified at seven hand
rotations. A **fist is told from a pinch** by where the tips meet: out in front
of the palm, or folded against it.

A pose must hold **320 ms** before it commits, shown as a filling bar. Shape
switching is suspended while pinching.

### Rendering

Two backends, chosen once at startup because a canvas can only vend one
context type:

- **WebGL2** — the whole field in one `drawArrays(POINTS)` call, with rotation,
  projection and a continuous colour ramp in the vertex shader
- **2D canvas** — counting sort into 28 colour buckets × 4 alpha tiers, at most
  112 `fill` calls per frame

Four palettes (Nebula, Ember, Flora, Aurora), cycled with `G`. Trails come from
compositing a translucent background. Off-screen dots are culled at a 40 px
margin. Memory is fully preallocated — 76 bytes per dot, flat across counts.

### Input and output

| Surface | Detail |
|---|---|
| Camera | MediaPipe HandLandmarker 0.10.14, ≤2 hands, GPU with CPU fallback |
| Microphone | Opt-in; low-mid weighted RMS drives drift and dot size |
| Keyboard | `1`–`8` shape · `Space` burst · `C` `T` `P` `H` · `G` palette · `A` audio · `K` calibrate |
| Mouse | Drag rotates, scroll zooms |
| URL | `?dots=` `?shape=` `?palette=` `?trails=0`, mirrored to the hash on change |
| Panel | Live readouts, shape chips, Morph speed and Drift sliders, gesture legend |
| Preview | Camera feed with a 21-landmark skeleton overlay for self-diagnosis |

### Calibration

Depth is inferred from apparent hand span, which varies with hand size and
camera FOV. `K` averages 45 frames and derives a personal band, saved to
`localStorage`. An average hand calibrates to within 0.02 of the shipped
default.

### Privacy and offline

Video and audio are processed in-browser and never transmitted; the microphone
is off by default. A service worker caches the app shell (network-first) and
the CDN runtime and hand model (cache-first), so visits after the first work
with no network.

### Accessibility

Keyboard operation of every control, `aria-pressed` on toggles, labelled
sliders, visible focus rings, `prefers-reduced-motion` support. The field
itself is inherently visual and has no non-visual equivalent.

### Testing

140 checks across three suites, no dependencies, no browser (`npm test`).
`npm run bench` reports per-frame JS cost from 1 000 to 20 000 dots.

---

## Delivered in 1.1

Everything below came out of an audit of the 1.0 implementation against the
spec. Defects are the ones where code and document disagreed.

### Defects fixed

| # | Finding | Resolution |
|---|---|---|
| 0 | Pinch attractor hardcoded to the world origin while the spec promised it followed the palm | `screenToWorld` inverts the projection each frame; the grab now tracks the hand |
| 14 | Two-hand pinch was smoothed then discarded — its only effect was swelling the overlay ring | Honoured as a grab at the hand midpoint |
| 11 | Alpha tier 0 painted ~40 % too dim | Tier bounds derived from the real alpha range [0.18, 0.98] |
| 12 | Perspective divide preceded its near-plane guard, admitting NaN coordinates | Guard moved onto `z2`; cull comparisons negated so NaN falls out |
| 13 | `turbulence` was read but never written | Exposed as the Drift slider |

**Why the suite missed #0.** Every 1.0 pinch assertion measured mean radius
from the world origin — a statistic that cannot distinguish "gathers at the
hand" from "gathers at the centre". A correct implementation would have
*failed* those checks. The replacement projects the swarm's centre of mass
onto the grab axis and compares a pinched hand against an open hand at the
same position.

### Enhancements shipped

| # | Improvement | Notes |
|---|---|---|
| 1 | Service worker | Shell network-first, CDN model cache-first |
| 2 | Configurable dot count | `?dots=` 100–40 000, plus the memory fix below |
| 3 | Depth calibration | `K`, persisted to `localStorage` |
| 4 | Attract loop | Cycles the catalogue on the intro screen; retires on any input or a tracked hand |
| 5 | WebGL2 renderer | One draw call, automatic 2D fallback |
| 6 | Palette cycling | Four palettes on `G` — bound to a free control, not to wrist roll |
| 7 | Audio reactivity | Opt-in microphone drives drift and dot size |
| 8 | Morph speed control | Panel slider, 0.25–3× |
| 9 | URL-shareable state | Shape, palette, trails, dot count in the hash |

### Performance

Batching moved from one full-size array per colour bucket to a counting sort
into 112 contiguous slots. The old layout allocated 28× more than the dots
could ever fill, and re-scanned each bucket four times to group by alpha.

| Dots | Update | Render | Total | Field state |
|---|---|---|---|---|
| 1 000 | 0.064 ms | 0.045 ms | 0.109 ms | 76 KB |
| 5 000 | 0.332 ms | 0.153 ms | 0.485 ms | 372 KB |
| 20 000 | 1.424 ms | 0.554 ms | 1.978 ms | 1 486 KB |

496 → **76 bytes per dot**. At 10 000 dots that is 4.73 MB down to 0.73 MB.

**These numbers exclude rasterisation and MediaPipe inference**, which dominate
real frame time. They bound the JS cost, not the frame budget — validate any
`DOT_COUNT` change against a real frame time, not against this table.

---

## Not done, and why

**#10, pinch-and-drag individual dots.** The palm-located attractor with
inverse-square falloff already delivers localised grabbing — the distinct part
of #10 is grabbing only the nearest *k* dots, which is a second grab semantic.
Without a UI affordance to switch between the two the pinch becomes ambiguous,
and adding a mode toggle for a marginal interaction is not worth the surface.
Revisit if a second grab gesture ever earns its own affordance.

## Backlog

- Vendor the model into the repository for a genuinely offline first run
- Automated coverage for the WebGL path (the harness returns `null` for
  `getContext('webgl2')`, so the suites drive the 2D fallback only)
- Calibration for the gesture thresholds, not just the depth band
- Depth-sorted rendering so overlapping dots read as a volume
- MIDI or OSC output so the field can drive other software

# Galaxy Spiral — Technical Specification

**Version** 1.1 · **Status** Implemented · **Last updated** 2026-09-30

---

## 1. Purpose

A website that lets a person control a field of 1000 dots using hand gestures
captured by a laptop camera. The dots respond to **movement**, change
**shape**, and **rotate** under gesture control.

### 1.1 Source requirement

> I want to generate a website where i can control a set of 1000 dots with my
> hand gesture via laptop camera. Like movement, shapes, rotation

### 1.2 Requirement traceability

| Requirement | Delivered as | Verified by |
| --- | --- | --- |
| 1000 dots | `DOT_COUNT = 1000`, one spring-driven particle each | `boot` — settled loop draws 1000/1000 dots per frame |
| Laptop camera | `getUserMedia` + MediaPipe HandLandmarker, in-browser | Manual; failure path covered in `boot` |
| Movement | Palm centroid drives a screen-space translation | `pipeline` — movement section |
| Shapes | Finger count selects 1 of 6 shapes; 8 total exist | `pipeline` — shape switching section |
| Rotation | Wrist roll → Z; palm pitch → X; sweep → Y spin | `pipeline` — rotation section |

---

## 2. Scope

### 2.1 In scope

- Single-page static website, no build step, no runtime dependencies to install
- Real-time hand tracking of up to two hands
- Gesture control of dot position, rotation, scale, and shape
- Full keyboard and mouse fallback when no camera is present
- Automated test suite runnable without a browser
- Offline operation after the first visit, via a service worker

### 2.2 Out of scope

- Multi-user or networked sessions
- Recording, exporting, or persisting the rendered output
- Mobile-first design (the layout adapts, but the interaction targets a laptop)
- Custom or user-authored shapes

### 2.3 Non-goals

Nothing leaves the device. There is no analytics, no telemetry, no upload path,
and no server-side component beyond a static file server.

---

## 3. Functional requirements

### 3.1 Gesture control surface

#### One hand

| Input | Signal | Effect | Mapping |
| --- | --- | --- | --- |
| Palm position | Centroid of landmarks 0, 5, 9, 13, 17 | Translate | `offset = (centre − 0.5) × viewport × 0.62` |
| Wrist roll | Angle of wrist → middle knuckle | Rotate Z | `rot.z = −roll × 1.15` |
| Palm pitch | Relative z of middle knuckle | Rotate X | `rot.x = −0.35 + pitch × 0.75` |
| Sideways sweep | Frame-to-frame palm velocity | Spin Y | `spin.y += clamp(vx, ±4) × 0.22` |
| Distance to lens | Apparent hand span | Scale | `scale = 0.55 + depth × 1.5` |
| Finger count | 0–5 extended digits | Shape | See 3.2 |
| Pinch | Thumb tip to index tip | Grab | Attractor **at the palm**, `strength = (pinch − 0.55) × 26` |

#### Two hands

| Input | Effect | Mapping |
| --- | --- | --- |
| Distance apart | Scale | `scale = clamp(0.35 + spread × 2.4, 0.3, 2.6)` |
| Relative tilt | Rotate Z, like a steering wheel | `rot.z = atan2(Δy, Δx)` |
| Midpoint | Translate | As one-hand, on the midpoint |
| Either hand pinching | Grab | Attractor at the midpoint, same strength curve |
| Matching finger counts (1–5) | Shape | Symmetric poses only |
| Both fists | Supernova burst | Edge-triggered, once per clench |

Two-hand shape switching **requires both hands to show the same count**.
Mismatched poses leave the shape alone, so stretching does not cause accidental
morphs. Double-fist is excluded from shape switching and fires the burst only.

#### 3.1.1 Grab positioning

The attractor is placed **under the hand**, not at the field centre. The palm's
screen position is inverse-projected to pre-rotation world space by
`ParticleField.screenToWorld`, which solves the render projection for the point
whose rotated depth is zero. Because the inverse is recomputed every frame
against the current rotation, the grab point stays locked under the hand while
the field keeps spinning.

Force falls off as inverse square (`strength / (d² + 0.35)`), so a grab pulls
nearby dots hard and distant ones barely at all — the swarm gathers into the
hand rather than collapsing uniformly.

> **Changed in 1.1.** Through 1.0 the attractor was hardcoded to the world
> origin while this section claimed it followed the palm. See §11.

### 3.2 Shape catalogue

| Fingers | Shape | Geometry |
| --- | --- | --- |
| 0 (fist) | Core | Dense jittered ball, radius 0.26 |
| 1 | Sphere | Fibonacci sphere |
| 2 | Torus | R 0.82, r 0.32 |
| 3 | Cube | Uniform points across six faces |
| 4 | Helix | Double helix with rungs every 9th point |
| 5 (open palm) | Galaxy Spiral | 4 arms, `sqrt` radial density, per-point scatter |
| — | Ringed World | Planet plus debris halo (panel/key only) |
| — | Wave Field | Grid with a runtime sine displacement (panel/key only) |

All shapes emit exactly `count × 3` floats bounded within roughly a unit
sphere, so switching never causes a scale jump.

### 3.3 Pose debounce

A finger-count pose must hold for **320 ms** before it commits. Prevents shape
flicker while a hand moves into position. Progress is shown as a filling bar
under the panel readouts. Shape switching is **suspended while pinching**,
with one or two hands, because a pinch distorts the finger count.

### 3.4 Idle behaviour

With no hand detected, translation, scale and roll ease back to neutral
(smoothing factor 0.05, pitch 0.03) and the field keeps rotating at a baseline
`spin.y` of 0.18 rad/s. The scene is never static.

### 3.5 Attract loop

While the intro card is visible and the user has not yet acted, the field
cycles the shape catalogue every **3000 ms**, so a cold visitor sees what the
app does before deciding to grant camera access.

It retires permanently on the first of: any keypress, any pointer press on the
canvas, any shape chip click, dismissing the intro, or **a hand entering
frame** — a tracked hand means the user has arrived and the demo should yield.

### 3.6 Fallback controls

Full functionality without a camera:

| Input | Effect |
| --- | --- |
| `1`–`8` | Select shape |
| `Space` | Burst |
| `C` / `T` / `P` / `H` | Camera · trails · preview · hide UI |
| `G` / `A` / `K` | Palette · audio reactivity · depth calibration |
| Drag | Rotate |
| Scroll | Zoom |

Key handling is suppressed when the event target is an `HTMLInputElement`, so
the panel sliders keep their arrow keys.

### 3.7 Status reporting

The panel exposes current shape, interpreted gesture, hand count, scale, render
FPS, and the active dot count and renderer backend. The status chip reports
camera state through `camera off → requesting camera → loading hand model →
tracking`, with distinct messages for permission denial, no camera found, model
load failure, microphone denial, and calibration progress.

### 3.8 Motion controls

Two panel sliders expose the feel of the field directly:

| Control | Range | Default | Effect |
| --- | --- | --- | --- |
| Morph speed | 0.25–3× | 1× | Multiplies spring stiffness; slow dreamy morphs through to snap |
| Drift | 0–3× | 1× | Scales the idle breathing amplitude; 0 settles dead still |

---

## 4. Gesture recognition design

Two decisions here are load-bearing, because the obvious implementations are
measurably wrong. Both were caught by tests before reaching the browser.

### 4.1 Finger extension by chain straightness

**Rejected:** comparing tip height against knuckle height. Only valid for an
upright hand; counting breaks as soon as the hand rotates.

**Rejected:** comparing tip-to-wrist against joint-to-wrist distance.
Orientation-free, but the thumb's short distal segment makes the ratio too
small to threshold reliably — a fully extended thumb scored 0.94 against a
1.12 threshold and read as folded.

**Adopted:** ratio of end-to-end distance over summed segment length along each
joint chain. A straight finger scores ~0.99, a curled one ~0.25. Thresholds:
**0.82** for fingers, **0.84** for the thumb. Orientation-free by construction.

Verified at 0°, 45°, 90°, 135°, 180°, 250°, 320° of hand roll.

### 4.2 Distinguishing a fist from a pinch

A closed fist presses the thumb and index tips together exactly as a pinch
does. Measured on synthetic hands, a fist scored **pinch = 1.00** on tip
distance alone. This both blocked the Core shape and spuriously triggered grab.

The discriminator is *where* the tips meet, measured as index-tip-to-palm-centroid
distance over hand span:

| Pose | Reach | Interpretation |
| --- | --- | --- |
| Open hand / real pinch | ~1.06 | Tips meet in front of the palm |
| Closed fist | ~0.11 | Tips fold down against the palm |

`pinchStrength` returns 0 below a reach of **0.55**.

The thumb carries a second guard for the same reason: a fist often holds the
thumb straight across the fingers, so straightness alone reads it as raised.
The thumb must also be **1.15 hand-spans** clear of the pinky knuckle.

### 4.3 Smoothing

All continuous channels are exponentially smoothed. Roll uses an angle-aware
variant that takes the shortest way around the circle, so it cannot spin the
wrong way through ±π.

| Channel | Factor | Rationale |
| --- | --- | --- |
| Translation | 0.16 | Responsive; tracking jitter is small relative to the motion |
| Scale | 0.12 | Depth from apparent size is the noisiest signal |
| Roll | 0.18 | Needs to feel direct |
| Pitch | 0.07 | Derived from MediaPipe relative z, the least reliable axis |
| Pinch | 0.25 | Fast, because grab should feel immediate |

### 4.4 Mirroring

The preview is a selfie view. Landmark x is flipped to `1 − x` so screen-space
mapping matches what the user sees, and the handedness label is swapped to
match.

### 4.5 Depth calibration

Depth is inferred from apparent hand span, which varies with hand size and
camera field of view. The shipped default band is **0.08–0.26**, tuned for an
average adult hand on a 640×480 feed.

Pressing `K` (or the Calibrate button) averages the span over 45 tracked frames
and derives a personal band of `[span × 0.6, span × 1.72]`, persisted to
`localStorage` under `gs.depthBand`. An average hand calibrates to within 0.02
of the shipped default, which is the check that keeps the two in step.

`handDepth` and `readHand` take the band as an argument rather than reading
module state, so `gestures.js` stays pure.

---

## 5. Architecture

```
camera frame                         microphone (optional)
   │                                    │
   ▼                                    ▼
HandTracker      MediaPipe          AudioReactor    AnalyserNode,
   │             ≤2 hands, x mirrored   │           low-mid weighted RMS
   ▼                                    │
gestures.js      landmarks → { fingers, centre, roll, pinch, depth, span }
   │             pure functions, no state
   ▼                                    │
main.js          gesture → transform mapping, smoothing, pose debounce
   │             ◄────────────────────────┘ energy
   ▼
ParticleField    spring integration → 3D rotation → perspective
   │
   ├─► GLRenderer      WebGL2 point sprites, one draw call      (preferred)
   └─► canvas 2D       counting-sort batching, ~112 fills max   (fallback)
```

| Module | Responsibility |
| --- | --- |
| `src/js/particles.js` | Particle state, physics, projection, 2D rendering |
| `src/js/glrenderer.js` | WebGL2 point-sprite renderer, same projection on the GPU |
| `src/js/shapes.js` | Point-cloud generators, pure |
| `src/js/gestures.js` | Landmark interpretation, pure; smoothing and debounce helpers |
| `src/js/handTracker.js` | Camera lifecycle and MediaPipe integration |
| `src/js/audio.js` | Optional microphone reactivity |
| `src/js/main.js` | Gesture→field mapping, render loop, UI wiring, config |
| `sw.js` | Service worker: app shell + vendored model caching |
| `server.js` | Static file server, no dependencies |

`gestures.js` and `shapes.js` are pure and therefore directly unit-testable.
`particles.js` touches a canvas context only through the parameter passed to
`render`, so it can be driven by a stub.

### 5.1 Particle model

Each dot is a damped spring pulled toward a target position:

```
a  = (target − pos) × stiffness × morph   stiffness 13, morph 0.25–3
v  = (v + a·dt) × damping^(dt·60)         damping 0.88
pos += v·dt
```

Changing shape swaps the targets, so the swarm **flows** into its new form
rather than snapping. A burst injects radial velocity and the same springs pull
it back. A slow per-particle drift, scaled by the `turbulence` control and by
audio energy, keeps the field alive at rest.

Frame time is clamped to `[0, 0.05]` — the upper bound stops a backgrounded tab
from exploding the integrator on resume, the lower bound guards a
non-monotonic clock.

### 5.2 Rendering

X→Y→Z rotation, perspective divide at focal length 3.1. Depth drives both alpha
and radius. Additive blending produces the glow and removes any need for depth
sorting. Off-screen dots are culled with a 40 px margin.

Both backends evaluate the same projection; `GLRenderer` mirrors the maths in
its vertex shader. A canvas can only vend one context type, so the choice is
made once at startup and `window.galaxySpiral.renderer` reports it.

#### WebGL2 path (preferred)

One `drawArrays(POINTS)` call for the entire field. Position is re-uploaded per
frame (physics stays on the CPU); tint and size are uploaded once. Colour is
interpolated continuously across the five palette stops rather than quantised,
because the GPU has no reason to bucket. Trails come from compositing a
translucent full-screen triangle, which requires `preserveDrawingBuffer`.

#### 2D canvas path (fallback)

Dots are grouped into **28 colour buckets × 4 alpha tiers** by a counting sort
into 112 contiguous slots, then drawn as one batched path per non-empty slot —
at most 112 `fill` calls per frame instead of 1000 style changes.

Two properties of this path are load-bearing:

- **Alpha tier bounds are derived from the real alpha range [0.18, 0.98]**, not
  from [0, 1). Splitting [0, 1) into quarters and painting the tier midpoint
  rendered the dimmest tier at 0.125 when no dot in it was below 0.18 — the
  faintest dots came out ~40 % too dark.
- **The near-plane guard precedes the divide.** Testing `persp <= 0.02` after
  computing `focal / (focal + z2)` lets `z2 === −focal` produce `Infinity`,
  and `0 × Infinity` produces a `NaN` coordinate that passes both cull
  comparisons. The guard is now on `z2`, and the cull comparisons are negated
  so NaN falls out rather than through.

Memory is fully preallocated; there is no per-frame allocation in the hot loop.
Batching uses a fixed handful of flat arrays rather than one full-size array
per bucket, which cost 28× more than the dots could ever fill.

---

## 6. Non-functional requirements

### 6.1 Performance

Target 60 fps at 1000 dots. Measured with `npm run bench` — physics,
projection and batching only, on the 2D path:

| Dots | Update | Render | Total | of 16.67 ms | Field state |
| --- | --- | --- | --- | --- | --- |
| 1 000 | 0.064 ms | 0.045 ms | **0.109 ms** | 0.7 % | 76 KB |
| 2 500 | 0.169 ms | 0.083 ms | 0.252 ms | 1.5 % | 187 KB |
| 5 000 | 0.332 ms | 0.153 ms | 0.485 ms | 2.9 % | 372 KB |
| 10 000 | 0.700 ms | 0.283 ms | 0.983 ms | 5.9 % | 744 KB |
| 20 000 | 1.424 ms | 0.554 ms | 1.978 ms | 11.9 % | 1 486 KB |

**These numbers exclude rasterisation and MediaPipe inference, which dominate
real frame time.** They bound the JS cost, not the frame budget. The practical
ceiling on the 2D path is fill rate, not JS; the WebGL path moves that ceiling
substantially by collapsing ~112 fills into one draw call. Raising `DOT_COUNT`
should always be validated against a real frame time, not against this table.

Field state is 76 bytes per dot, flat across all counts. Per-bucket batching
would have cost 496 bytes per dot — at 10 000 dots, 4.73 MB against 0.73 MB.

### 6.2 Privacy

Video and audio are processed entirely in-browser and never transmitted. No
frame or sample is retained beyond the one being analysed. Microphone access is
opt-in and off by default. Network access is limited to the one-time CDN fetch
of the WASM runtime and hand model, which the service worker then caches.

### 6.3 Compatibility

Chrome, Edge, Safari 16.4+. Requires `getUserMedia`, WebAssembly, ES modules.
GPU inference is requested with automatic CPU fallback, and WebGL2 rendering
falls back to 2D canvas.

**Secure context is mandatory** — `http://localhost` or HTTPS. A `file://` URL
cannot access the camera, and the service worker will not register.

### 6.4 Accessibility

Keyboard operation of every control, `aria-pressed` on toggles, labelled
sliders, visible focus rings, and `prefers-reduced-motion` support for UI
transitions. The particle field itself is inherently visual and has no
non-visual equivalent.

---

## 7. Testing strategy

140 automated checks across three suites, no dependencies and no browser
required. Run with `npm test`, or `npm test -- <suite>` for one. Each suite runs
in its own process so fake-DOM globals cannot leak between them.

| Suite | Layer | Checks |
| --- | --- | --- |
| `unit` | Pure functions | 65 |
| `boot` | App wiring against a fake DOM | 32 |
| `pipeline` | Gesture → field, end to end | 43 |

`npm run bench` reports the per-frame JS cost table in §6.1.

Test doubles live in `tests/harness.mjs` (fake DOM built by parsing
`index.html`, plus a mocked clock shared by `requestAnimationFrame` and
`performance.now`) and `tests/hand-fixture.mjs` (synthetic 21-landmark hands
with anatomically plausible joint chains, so extended fingers curve slightly
rather than being perfect rulers — otherwise the straightness thresholds are
never actually stressed).

### 7.1 Measuring the right thing

The grab-position defect in §11 survived the 1.0 suite because every pinch
assertion measured **mean radius from the world origin**, a statistic that
cannot distinguish "collapses toward the hand" from "collapses toward the
centre". A palm-located attractor would have *failed* those checks.

The replacement projects the swarm's centre of mass onto the grab axis and
compares a pinched hand against an open hand at the same position, which
isolates the attractor's contribution from the translation that runs alongside
it. When adding coverage here, prefer a statistic that would change sign or
magnitude if the behaviour were wrong.

**Not covered, and requiring a manual pass:** real camera input, real MediaPipe
inference, rendered pixels, and the entire WebGL path — the harness returns
`null` for `getContext('webgl2')`, so tests exercise the 2D fallback only.

---

## 8. Configuration

| Parameter | Location | Default |
| --- | --- | --- |
| Dot count | `?dots=` or `DOT_COUNT`, `main.js` | 1000 (100–40000) |
| Initial shape | `?shape=` | `galaxy` |
| Palette | `?palette=` or `G` | `nebula` |
| Trails | `?trails=0` or `T` | on |
| Springiness / drag | `stiffness`, `damping`, `ParticleField` | 13 / 0.88 |
| Morph speed | Panel slider, `field.morph` | 1× |
| Drift | Panel slider, `field.turbulence` | 1× |
| Pose hold time | `PoseLatch`, `main.js` | 320 ms |
| Attract dwell | `ATTRACT_DWELL`, `main.js` | 3000 ms |
| Gesture smoothing | `Smoothed` factors, `main.js` | See 4.3 |
| Depth band | `localStorage['gs.depthBand']`, or `K` | 0.08–0.26 |
| Server port | `PORT` env or `server.js` | 5173 |
| MediaPipe version | `VISION_VERSION`, `handTracker.js` | 0.10.14 |

Shape, palette, trails and dot count are mirrored into the URL hash on change,
so any configuration is linkable. The live field is exposed at
`window.galaxySpiral` for console inspection.

---

## 9. Known limitations

1. **Depth is inferred from apparent hand size**, so it varies with hand size
   and camera FOV. `K` calibrates it per user; the default band is tuned for a
   640×480 feed at typical laptop distance.
2. **Palm pitch uses MediaPipe relative z**, the least reliable landmark axis.
   Heavily smoothed, and contributes a deliberately modest rotation range.
3. **Gesture thresholds are tuned against synthetic hands.** They carry wide
   margins, but real-hand calibration may want adjusting — §4.2 reach and §4.1
   straightness are the values to touch.
4. **Tracking degrades in low light** or when the hand leaves frame. The
   skeleton preview exists so users can diagnose this themselves.
5. **Two-hand shape switching requires symmetric poses**, which is deliberate
   but not self-evident without the on-screen legend.
6. **The WebGL path has no automated coverage.** It is exercised only by the
   manual pass; the harness drives the 2D fallback.
7. **First run still needs network.** The service worker caches the model after
   it has been fetched once; it does not pre-vendor it into the repository.

---

## 10. Possible extensions

- Vendor the model into the repository for a genuinely offline first run
- A calibration step for the gesture thresholds, not just the depth band
- Pinch-and-drag a handful of individual dots as a distinct mode (see §11)
- Depth-sorted rendering so overlapping dots read as a volume
- MIDI or OSC output so the field can drive other software

---

## 11. Changelog

### 1.1 — 2026-09-30

Five defects found by reading the 1.0 implementation against this document.

| # | Defect | Resolution |
| --- | --- | --- |
| 1 | Pinch attractor hardcoded to the world origin while §3.1 claimed it followed the palm | Added `screenToWorld`; attractor now tracks the hand. Spec and tests both corrected — see §3.1.1 and §7.1 |
| 2 | Two-hand pinch was smoothed, then discarded; its only effect was swelling the overlay ring | Honoured as a grab at the hand midpoint (§3.1) |
| 3 | Alpha tier 0 painted ~40 % too dim | Tier bounds derived from the real alpha range (§5.2) |
| 4 | Perspective divide preceded its near-plane guard, admitting NaN coordinates | Guard moved onto `z2`; cull comparisons negated (§5.2) |
| 5 | `turbulence` was read but never written — an unreachable knob | Exposed as the Drift slider (§3.8) |

Added: WebGL2 renderer, service worker, audio reactivity, depth calibration,
palette cycling, morph/drift controls, attract loop, URL-shareable state,
configurable dot count, `npm run bench`.

Changed: batching moved from one array per colour bucket to a counting sort,
cutting field state from 496 to 76 bytes per dot.

**Deliberately not done:** pinch-and-drag of individual dots. The palm-located
attractor with inverse-square falloff (§3.1.1) already delivers localised
grabbing; a per-dot drag mode would need its own UI affordance to switch into,
and adding a second grab semantic without one would make the pinch ambiguous.

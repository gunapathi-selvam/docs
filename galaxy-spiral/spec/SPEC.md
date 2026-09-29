# Galaxy Spiral — Technical Specification

**Version** 1.0 · **Status** Implemented · **Last updated** 2026-09-30

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

### 2.2 Out of scope

- Multi-user or networked sessions
- Recording, exporting, or persisting anything
- Mobile-first design (the layout adapts, but the interaction targets a laptop)
- Custom or user-authored shapes
- Offline first-run (the hand model is fetched from a CDN once)

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
| Pinch | Thumb tip to index tip | Grab | Attractor at palm, `strength = (pinch − 0.55) × 26` |

#### Two hands

| Input | Effect | Mapping |
| --- | --- | --- |
| Distance apart | Scale | `scale = clamp(0.35 + spread × 2.4, 0.3, 2.6)` |
| Relative tilt | Rotate Z, like a steering wheel | `rot.z = atan2(Δy, Δx)` |
| Midpoint | Translate | As one-hand, on the midpoint |
| Matching finger counts (1–5) | Shape | Symmetric poses only |
| Both fists | Supernova burst | Edge-triggered, once per clench |

Two-hand shape switching **requires both hands to show the same count**.
Mismatched poses leave the shape alone, so stretching does not cause accidental
morphs. Double-fist is excluded from shape switching and fires the burst only.

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
because a pinch distorts the finger count.

### 3.4 Idle behaviour

With no hand detected, translation, scale and roll ease back to neutral
(smoothing factor 0.05, pitch 0.03) and the field keeps rotating at a baseline
`spin.y` of 0.18 rad/s. The scene is never static.

### 3.5 Fallback controls

Full functionality without a camera:

| Input | Effect |
| --- | --- |
| `1`–`8` | Select shape |
| `Space` | Burst |
| `C` / `T` / `P` / `H` | Camera · trails · preview · hide UI |
| Drag | Rotate |
| Scroll | Zoom |

Key handling is suppressed when the event target is an `HTMLInputElement`.

### 3.6 Status reporting

The panel exposes current shape, interpreted gesture, hand count, scale, and
render FPS. The status chip reports camera state through
`camera off → requesting camera → loading hand model → tracking`, with distinct
messages for permission denial, no camera found, and model load failure.

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

---

## 5. Architecture

```
camera frame
   │
   ▼
HandTracker      MediaPipe HandLandmarker, VIDEO mode, ≤2 hands
   │             emits 21 landmarks per hand, x mirrored
   ▼
gestures.js      landmarks → { fingers, centre, roll, pinch, depth, span }
   │             pure functions, no state
   ▼
main.js          gesture → transform mapping, smoothing, pose debounce
   │
   ▼
ParticleField    spring integration → 3D rotation → perspective → batched draw
   │
   ▼
canvas 2D
```

| Module | Responsibility |
| --- | --- |
| `src/js/particles.js` | Particle state, physics, projection, rendering |
| `src/js/shapes.js` | Point-cloud generators, pure |
| `src/js/gestures.js` | Landmark interpretation, pure; smoothing and debounce helpers |
| `src/js/handTracker.js` | Camera lifecycle and MediaPipe integration |
| `src/js/main.js` | Gesture→field mapping, render loop, UI wiring |
| `server.js` | Static file server, no dependencies |

`gestures.js` and `shapes.js` are pure and therefore directly unit-testable.
`particles.js` touches a canvas context only through the parameter passed to
`render`, so it can be driven by a stub.

### 5.1 Particle model

Each dot is a damped spring pulled toward a target position:

```
a  = (target − pos) × stiffness        stiffness 13
v  = (v + a·dt) × damping^(dt·60)      damping 0.88
pos += v·dt
```

Changing shape swaps the targets, so the swarm **flows** into its new form
rather than snapping. A burst injects radial velocity and the same springs pull
it back. A slow per-particle drift keeps the field alive at rest.

Frame time is clamped to `[0, 0.05]` — the upper bound stops a backgrounded tab
from exploding the integrator on resume, the lower bound guards a
non-monotonic clock.

### 5.2 Rendering

2D canvas, X→Y→Z rotation, perspective divide at focal length 3.1. Depth drives
both alpha and radius. Additive blending (`lighter`) produces the glow and
removes any need for depth sorting.

Dots are bucketed into **28 colours × 4 alpha tiers** and drawn as batched
paths — about 50 `fill` calls per frame instead of 1000 style changes. Trails
come from compositing a translucent background rather than clearing.

Off-screen dots are culled with a 40 px margin.

---

## 6. Non-functional requirements

### 6.1 Performance

Target 60 fps at 1000 dots. Measured JS cost per frame:

| Stage | Cost |
| --- | --- |
| Physics update | 0.069 ms |
| Projection + batching | 0.045 ms |
| **Total** | **0.114 ms — 0.7% of the 16.67 ms budget** |

Excludes GPU rasterisation and MediaPipe inference, which dominate real frame
time. The dot count can rise substantially before JS becomes the bottleneck.

Memory is fully preallocated: typed arrays for state and draw batches, no
per-frame allocation in the hot loop.

### 6.2 Privacy

Video is processed entirely in-browser and never transmitted. No frame is
retained beyond the one being analysed. The only network access is the
one-time CDN fetch of the WASM runtime and hand model.

### 6.3 Compatibility

Chrome, Edge, Safari 16.4+. Requires `getUserMedia`, WebAssembly, ES modules.
GPU inference is requested with automatic CPU fallback.

**Secure context is mandatory** — `http://localhost` or HTTPS. A `file://` URL
cannot access the camera.

### 6.4 Accessibility

Keyboard operation of every control, `aria-pressed` on toggles, visible focus
rings, and `prefers-reduced-motion` support for UI transitions. The particle
field itself is inherently visual and has no non-visual equivalent.

---

## 7. Testing strategy

111 automated checks across three suites, no dependencies and no browser
required. Run with `npm test`, or `npm test -- <suite>` for one. Each suite runs
in its own process so fake-DOM globals cannot leak between them.

| Suite | Layer | Checks |
| --- | --- | --- |
| `unit` | Pure functions | 44 |
| `boot` | App wiring against a fake DOM | 30 |
| `pipeline` | Gesture → field, end to end | 37 |

Test doubles live in `tests/harness.mjs` (fake DOM built by parsing
`index.html`, plus a mocked clock shared by `requestAnimationFrame` and
`performance.now`) and `tests/hand-fixture.mjs` (synthetic 21-landmark hands
with anatomically plausible joint chains, so extended fingers curve slightly
rather than being perfect rulers — otherwise the straightness thresholds are
never actually stressed).

**Not covered, and requiring a manual pass:** real camera input, real MediaPipe
inference, and rendered pixels. See the Testing section of the README for the
manual script.

---

## 8. Configuration

| Parameter | Location | Default |
| --- | --- | --- |
| Dot count | `DOT_COUNT`, `main.js` | 1000 |
| Springiness / drag | `stiffness`, `damping`, `ParticleField` | 13 / 0.88 |
| Pose hold time | `PoseLatch`, `main.js` | 320 ms |
| Gesture smoothing | `Smoothed` factors, `main.js` | See 4.3 |
| Server port | `PORT` env or `server.js` | 5173 |
| MediaPipe version | `VISION_VERSION`, `handTracker.js` | 0.10.14 |

The live field is exposed at `window.galaxySpiral` for console inspection.

---

## 9. Known limitations

1. **First run needs network.** The ~8 MB hand model is CDN-hosted. Vendoring
   it locally would make the app fully offline-capable.
2. **Depth is inferred from apparent hand size**, so it varies with hand size
   and camera FOV. The 0.08–0.26 span band is tuned for a 640×480 feed at
   typical laptop distance.
3. **Palm pitch uses MediaPipe relative z**, the least reliable landmark axis.
   Heavily smoothed, and contributes a deliberately modest rotation range.
4. **Gesture thresholds are tuned against synthetic hands.** They carry wide
   margins, but real-hand calibration may want adjusting — §4.2 reach and §4.1
   straightness are the values to touch.
5. **Tracking degrades in low light** or when the hand leaves frame. The
   skeleton preview exists so users can diagnose this themselves.
6. **Two-hand shape switching requires symmetric poses**, which is deliberate
   but not self-evident without the on-screen legend.

---

## 10. Possible extensions

- Vendor the model for offline use
- WebGL / instanced rendering to push well beyond 1000 dots
- A calibration step that learns the user's hand span
- Colour or palette bound to a gesture axis
- Audio reactivity
- Pinch-and-drag individual dots rather than the whole field

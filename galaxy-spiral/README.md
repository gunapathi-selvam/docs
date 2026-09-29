# Galaxy Spiral

A website that lets you steer a field of **1000 dots** with your hands, using
nothing but a laptop camera. Move them, rotate them, resize them, and morph
them between shapes — all through gestures.

Hand tracking runs entirely in the browser via MediaPipe. **No video ever
leaves the machine**, and nothing is recorded.

## Run it

```bash
npm start
```

Then open <http://localhost:5173> and click **Enable camera**.

There is no build step and no dependencies to install — `npm start` just runs a
small static file server (`server.js`). Any static server works; it has to be
`http://localhost` or HTTPS, because browsers only grant camera access in a
secure context (opening `index.html` as a `file://` URL will not work).

The first run downloads the MediaPipe hand model (~8 MB) from a CDN, so it
needs a network connection once. A service worker caches the model and the app
shell afterwards, so later visits work with no network at all.

Want more dots? Add `?dots=5000` to the URL — anything from 100 to 40 000. The
shape, palette and trail settings are mirrored into the URL hash as you change
them, so any configuration you land on is linkable.

## Gestures

Hold your hand up, palm toward the camera, roughly 40–70 cm away.

| Gesture | Effect |
| --- | --- |
| Move your palm | The swarm follows it around the screen |
| Tilt your wrist | Rolls the swarm |
| Sweep sideways | Flicks it into a spin |
| Push toward / pull from the lens | Zooms in and out |
| Hold up 0–5 fingers | Morphs into a different shape |
| Pinch thumb + index | Grabs and gathers the swarm into your hand |
| Two hands apart / together | Stretches and squeezes |
| Pinch with either of two hands | Grabs at the midpoint between them |
| Both hands as fists | Supernova burst |

The grab lands **where your hand is**, not at the centre of the screen, and the
pull falls off with distance — so it gathers the dots nearest you rather than
imploding the whole field.

Shapes by finger count:

| Fingers | Shape |
| --- | --- |
| Fist (0) | Core |
| 1 | Sphere |
| 2 | Torus |
| 3 | Cube |
| 4 | Helix |
| Open palm (5) | Galaxy Spiral |

Two more shapes (Ringed World, Wave Field) are available from the side panel or
the number keys.

A pose has to be held for ~320 ms before it commits, so the swarm does not
flicker between shapes while your hand is moving into position. The thin bar
under the readouts shows that timer filling.

### Without a camera

Everything still works. Click **Explore without camera**, then drag to rotate,
scroll to zoom, and use the keys:

`1`–`8` shape · `Space` burst · `C` camera · `T` trails · `P` preview · `H` hide UI
· `G` palette · `A` audio · `K` calibrate

Leave it alone on the intro screen and it cycles the shape catalogue on its own
until you touch something or a hand appears.

### Calibration

Depth is read from how large your hand looks, so it depends on your hand and
your camera. If pushing toward the lens barely zooms — or pins instantly to
maximum — press `K` with the camera on and hold your hand still at a
comfortable distance for a second. The measured band is saved for next time.

### Audio

Press `A` to let the microphone drive the field's energy: the drift grows and
the dots swell with the sound in the room. It is off by default, opt-in, and
the audio never leaves the machine.

## Testing

### Try it by hand

With `npm start` running, open <http://localhost:5173>. Work through this in
order — each step isolates one part of the pipeline:

1. **No camera needed first.** Click *Explore without camera*, press `1`–`8`.
   The swarm should flow into each shape, not snap. Drag to rotate, scroll to
   zoom, press `Space` for a burst. If this works, rendering and physics are
   fine and anything else is a tracking problem.
2. **Turn the camera on.** The status chip goes `requesting camera` →
   `loading hand model` → green `tracking`. The preview panel appears
   bottom-left.
3. **Check tracking before judging gestures.** Hold a hand up: a cyan skeleton
   should lock onto it in the preview, and `hands` in the panel should read 1.
   No skeleton means lighting or framing, not a bug — get more light on your
   hand and keep it fully in frame.
4. **Movement** — move your palm around; the swarm follows.
5. **Rotation** — tilt your wrist and it rolls; sweep sideways and it spins.
6. **Scale** — lean your hand toward the lens and it grows.
7. **Shapes** — hold up 0, 1, 2, 3, 4, then 5 fingers, pausing about half a
   second each. Watch the thin bar under the readouts fill before each switch;
   that is the debounce, and it is why flicking your hand about does not
   change anything.
8. **Pinch** — touch thumb to index. The swarm gathers into your hand and the
   gesture readout says `grab`. Move the pinch around: the clump should follow
   your hand, *not* sit in the middle of the screen. A **fist should not** do
   this; it should give you the Core shape instead.
9. **Two hands** — pull them apart to stretch, tilt one above the other to
   roll, pinch either one to grab at the midpoint, clench both into fists for
   a supernova.
10. **Renderer** — the `field` readout ends in `gl` or `2d`. On a machine with
    WebGL2 it should say `gl`; `2d` means the fallback is in use, which is
    correct behaviour but worth knowing when judging frame rate.
11. **Offline** — load the page once with the camera enabled, then go offline
    and reload. It should still come up and still track.

The panel readouts are the debugging tool: `gesture` shows what the app thinks
you are doing, `hands` how many it sees, and `render` the frame rate.

### Automated tests

```bash
npm test              # all suites
npm test -- pipeline  # just one
npm run bench         # per-frame JS cost at 1k–20k dots
```

140 checks, no dependencies, no browser needed. Three suites:

| Suite | Covers |
| --- | --- |
| `tests/unit.test.mjs` | Shape generators, spring physics, projection, and the gesture maths — finger counting at six hand rotations, pinch, roll, depth |
| `tests/boot.test.mjs` | Loads `main.js` against a fake DOM built from `index.html`, runs the real render loop, exercises every button, key, resize and the camera-failure path |
| `tests/pipeline.test.mjs` | End to end: feeds synthetic hands in and asserts the swarm actually moves, rotates, scales, morphs, grabs and bursts |

The fake DOM lives in `tests/harness.mjs` and the synthetic hand generator in
`tests/hand-fixture.mjs`; the latter builds anatomically-shaped 21-landmark
hands so extended fingers curve slightly rather than being perfect rulers.
Suites each run in their own process so their globals cannot leak.

What this does **not** cover: real camera input, real MediaPipe inference,
actual pixels on screen, and the WebGL renderer — the fake DOM returns `null`
for `getContext('webgl2')`, so the suites drive the 2D fallback. Those need the
manual pass above.

One lesson is baked into the pinch tests and worth repeating when you add
coverage here. Every 1.0 pinch assertion measured *mean radius from the world
origin*, which cannot tell "gathers at the hand" apart from "gathers at the
centre" — so a grab that ignored hand position passed for as long as it
existed. Prefer a statistic that would visibly change if the behaviour were
wrong; these now project the swarm's centre of mass onto the grab axis.

## How it works

| File | Role |
| --- | --- |
| [src/js/particles.js](src/js/particles.js) | The field: spring physics, 3D rotation, perspective projection, batched canvas drawing |
| [src/js/glrenderer.js](src/js/glrenderer.js) | WebGL2 point-sprite renderer — the same projection, on the GPU |
| [src/js/shapes.js](src/js/shapes.js) | Point-cloud generators for each shape |
| [src/js/handTracker.js](src/js/handTracker.js) | Camera capture and the MediaPipe hand landmarker |
| [src/js/gestures.js](src/js/gestures.js) | Turns 21 raw landmarks into finger counts, roll, pinch, depth |
| [src/js/audio.js](src/js/audio.js) | Optional microphone reactivity |
| [src/js/main.js](src/js/main.js) | Maps gestures onto the field, runs the render loop, drives the UI |
| [sw.js](sw.js) | Service worker: caches the app shell and the hand model |

Each dot is a spring pulled toward a target position. Switching shapes just
swaps the targets, so the swarm flows into its new form instead of snapping.

Rendering has two backends. Where WebGL2 is available the whole field is one
`drawArrays` call, with rotation, projection and the colour ramp evaluated in
the vertex shader. Otherwise it falls back to 2D canvas with additive blending,
where a counting sort groups dots into 28 colour buckets × 4 alpha tiers so a
frame costs at most 112 `fill` calls instead of 1000 style changes. A canvas
can only hand out one kind of context, so the choice is made at startup —
`galaxySpiral.renderer` and the panel's `field` readout tell you which won.

Per-frame JS cost on the 2D path is **0.11 ms at 1000 dots** and **0.98 ms at
10 000** (`npm run bench`). That measures physics, projection and batching
only — real frame time is dominated by rasterising the dots and by MediaPipe
inference, so treat it as a bound on the JS, not a frame budget.

Two details in the gesture layer are worth knowing about, because the obvious
implementations are wrong:

- **Finger extension** is measured by how *straight* each joint chain is, not
  by whether the tip is above the knuckle. The straightness test is
  orientation-free, so counting still works with your hand sideways or upside
  down.
- **A fist is not a pinch.** A closed fist presses the thumb and index tips
  together just like a pinch does, so tip distance alone misreads it. The two
  are told apart by *where* the tips meet: out in front of the palm (pinch) or
  folded down against it (fist).

## Browser support

Chrome, Edge, or Safari 16.4+. Needs `getUserMedia` and WebAssembly. The
tracker asks for GPU inference and falls back to CPU automatically.

## Tuning

Without touching code:

- **Morph speed** and **Drift** sliders in the panel — how fast shapes re-form,
  and how much the field breathes at rest (drift 0 settles dead still)
- **URL** — `?dots=`, `?shape=`, `?palette=`, `?trails=0`

In the source, feel is controlled by a few constants:

- Springiness and drag — `stiffness` and `damping` in `ParticleField`
- Default dot count — `DOT_COUNT` in `main.js`
- Gesture responsiveness — the `Smoothed` factors at the top of `main.js`
  (lower = smoother but laggier)
- Shape hold time — the `PoseLatch` interval in `main.js`
- Depth band — `DEFAULT_DEPTH_BAND` in `gestures.js`, or press `K` to
  calibrate it to your own hand

The live field is exposed on `window.galaxySpiral` for poking at from the
console, e.g. `galaxySpiral.field.setShape('torus')` or
`galaxySpiral.field.cyclePalette()`.

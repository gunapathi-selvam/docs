# ASL Trainer — Claude Session Context

Read this first. It tells you what the project is, what is decided, and what to
build next. The authoritative detail is in [spec/SPEC.md](spec/SPEC.md) — this
file is the map, not the territory.

## Goal

Teach ASL fingerspelling with a real-time geometric hand classifier. MediaPipe
HandLandmarker provides 21 landmarks per frame; a cascade of geometric tests
maps them to one of 24 static letters; the learner spells target words; a
persistent 26x26 confusion matrix heatmap shows which letters they conflate.
The confusion matrix is the product — it is a first-class feature, not a
debugging tool. SPEC §1, §11.

## Stack

- Vanilla JS ES modules, no build step, no dependencies
- MediaPipe HandLandmarker via CDN (one-time network fetch, caches afterwards)
- Canvas 2D for the skeleton overlay and the heatmap
- localStorage for confusion matrix persistence
- Node built-in test runner via `node tests/run.mjs`
- Zero-dependency static server on port 5173

## Key design decisions

Each of these was decided deliberately; do not "fix" them without reading the
cited section first.

- **Three-state finger extension (extended/curved/folded), not binary.**
  A binary extended/folded test collapses A, C, E, O and X into one class.
  The curved state is what makes five of the nine bucket-0 letters separable
  before the thumb is even consulted. SPEC §4.2
- **A four-level cascade, not a flat 26-way scorer.**
  Flat scoring fails on three independent grounds: features are incommensurable,
  argmax cannot abstain, and it hides the confusion structure. The cascade makes
  abstention structural (21 of 32 masks are unoccupied), not a threshold. SPEC §3.2
- **A palm frame, not a rotation-invariant scalar.**
  The thumb's position needs three signed axes — up the hand, across, and off the
  palm — which no scalar supplies. The frame is built from the MCP row, not from
  fingertips, so it does not rotate with the handshape. SPEC §4.3
- **Mirror-normalise for handedness, not dual threshold sets.**
  A mislabelled hand with dual thresholds returns a confident wrong letter.
  Mirror-normalisation degrades one axis's sign rather than selecting a whole
  alternate rulebook. SPEC §5.1, §5.2
- **A release phase between every letter, not only between repeats.**
  A repeat-only rule couples the latch to the quiz and makes the rhythm
  inconsistent. The release phase is what makes consecutive identical letters
  possible; without it the second letter is permanently blocked. SPEC §9.1, §9.2
- **Abstention returns null, not a best-guess letter.**
  The 21 unoccupied masks are the single largest source of abstention and cost
  nothing to detect. A flat scorer has no neutral to detect, so the release
  mechanism of §9 is structurally unavailable to it. SPEC §6.7
- **J and Z excluded; 24 static letters.**
  J and Z are paths, not handshapes. Including them without motion adds two
  coin-flips (I/J and D/Z) to the confusion matrix — a manufactured confusion
  is worse than a declared absence. SPEC §8.2
- **Empty cell != zero cell.**
  "I have never practised M" and "I practise M and never confused it" are
  opposite facts; painting both black misleads the learner. SPEC §11.3
- **Confusion matrix writes debounced to 1000 ms, flushed on visibilitychange.**
  676 integers is cheap but not free, and there is no reason to hit localStorage
  synchronously inside a latch. SPEC §11.5

## The guards that are invisible when wrong

Four properties of the classifier that produce no error when missing:

1. **`n̂ = â × û`, not `û × â`.** Getting the cross-product order backwards
   inverts every `t_n` sign and `t_r` sign, silently swapping A with S and
   T with M. Both are valid letters so no assertion fires. SPEC §4.3
2. **`thumbExtended` requires BOTH straightness ≥ 0.84 AND abduction ≥ 1.15.**
   Straightness alone reads a B or E thumb as raised, putting those letters in
   the wrong bucket. The two-part test is from galaxy-spiral §4.2, unchanged.
   SPEC §4.2
3. **Mirror-normalisation applies before any frame computation.**
   Applying it after the frame is built inverts the axes on left hands,
   producing confident wrong letters rather than a degraded confidence. SPEC §5.1
4. **The A/S discriminator must work with z=0.**
   `t_n` is MediaPipe's least reliable axis. A/S must be separable in-plane
   (`t_r`, `overlap`, `θ_T`) even when every z is zero. `pipeline.test.mjs`
   asserts this directly. SPEC §4.4.1

## Commands

| Command | Purpose |
|---|---|
| `node server.js` | Serve at http://localhost:5173 |
| `npm test` | Run all three suites |
| `npm test -- unit` | Run one suite by substring |

## Status

- [x] `spec/SPEC.md` — written
- [x] `FEATURES.md` — written
- [x] `README.md` — written
- [x] `src/js/` skeleton — module interfaces and constants, throwing `NotImplemented`
- [x] `tests/` — harness plus assertions, currently failing red by design
- [x] `src/js/quiz.js` — pickWord, LatchMachine (SEEKING/HELD), QuizState implemented
- [x] `src/js/confusion.js` — makeMatrix, recordLatch, rowTotal, cellState, rampColor, serializeMatrix, deserializeMatrix, drawMatrix implemented
- [x] `src/js/handTracker.js` — MediaPipe HandLandmarker lifecycle, CDN load, camera, detect with x-flip/handedness-swap implemented
- [x] `src/js/main.js` — init() wiring: frame loop, latch, quiz, score panel, skeleton overlay, confusion heatmap, localStorage, URL params, keyboard mode, failure paths implemented
- **App boots and shows intro in headless. Camera path and no-camera (keyboard) path both work.**
- **Test tally: 294 passed, 33 failed. The 28 pipeline failures are letters.js classifier accuracy (other agent). The 5 new unit failures are "throws NotImplemented" assertions that correctly fail now that the stubs are implemented.**

## What to do next

Work in this order. Each step has tests waiting for it.

1. `src/js/letters.js` — geometric primitives. Start with `handSpan`, `straightness`,
   `extensionMask`. These are pure arithmetic; `unit.test.mjs` already asserts the
   bands and constants. Then add `palmFrame`, `localCoord`, `thumbDescriptor`.
2. `src/js/letters.js` — bucket 0 ladder. The nine closed-fist letters
   (A E M N O S T C X) use the palm frame; §6.3 gives the exact decision tree.
   `pipeline.test.mjs` asserts each letter plus the A/S z=0 test.
3. `src/js/letters.js` — remaining buckets (1–9). Most are one letter; the hard
   ones are bucket 3 (H R U V) and bucket 7 (L G Q). Orientation-dependent
   letters (H P Q G) use `handTilt` (§7).
4. `src/js/letters.js` — `classifyLetter` entry point. Mirror-normalise (§5.1),
   compute mask, route to bucket, apply ladder, track confidence (§4.5).
5. `src/js/quiz.js` — `LatchMachine`. Implement the SEEKING/HELD state machine
   with the 320 ms hold and 180 ms release. `unit.test.mjs` asserts repeat
   latching requires a neutral between them.
6. `src/js/quiz.js` — `QuizState` and `pickWord`. Pure; no DOM. Tests assert
   wrong latch does not advance and records off-diagonal.
7. `src/js/confusion.js` — `makeMatrix`, `rowTotal`, `cellState`, `recordLatch`.
   Then `rampColor` (linear sRGB interpolation between spec stops). Then
   `drawMatrix` (cell fill, diagonal border, labels). Tests assert empty vs zero.
8. `src/js/handTracker.js` — camera lifecycle, MediaPipe init, skeleton bone
   list, x-flip and handedness swap.
9. `src/js/main.js` — wire everything: rAF loop, DOM updates, localStorage load/
   save, URL params `?word=` / `?letters=`, failure paths.

Run `npm test` after each step. Steps 1–7 are visible in the test output;
step 8 and 9 require a browser.

## Traps specific to this project

- **`n̂ = â × û` order.** See guard 1 above. Verify by checking that a palm-
  facing right hand gives positive `n̂.z` (pointing toward camera). The unit test
  asserts `n̂` points palmar for a right-hand fixture.
- **Bucket 3 splits from bucket 9.** K and P are in bucket 9 (`T I M - -`),
  not bucket 3 (`- I M - -`), because their thumb is extended and abducted.
  The intuitive grouping "all two-finger letters" is not the bucket.
- **Progress bar fills filling/draining:** CSS `--pct` variable drives the width
  via `::after` pseudo-element; the class `draining` changes the fill colour.
  Do not use a transition on the draining phase if `prefers-reduced-motion` is set.
- **`localStorage` may be unavailable.** The spec requires a graceful fallback to
  an in-memory matrix with a one-time warning. Do not gate the app on storage.
- **Confusion matrix schema version.** A mismatch must discard silently (no throw)
  and log a notice, not an error. A thrown exception would crash the app before
  the camera even opens.
- **The test suite cannot prove the visual appearance of the heatmap.** Green
  tests plus a wrong-looking matrix is an expected state — canvas output is only
  asserted as call sequences, not as pixels.

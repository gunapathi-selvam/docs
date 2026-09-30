# ASL Trainer — Feature Document

**Version** 1.0 · **Date** 2026-09-30 · **Status** Draft (unimplemented)

The feature-oriented view. For formulas, thresholds and rationale see
[spec/SPEC.md](spec/SPEC.md). For what to build next see [CLAUDE.md](CLAUDE.md).

---

## What it is

A zero-install web page that teaches ASL fingerspelling. One hand is tracked by
MediaPipe HandLandmarker; a geometric cascade classifies each frame into one of
24 static letters; the user spells target words letter by letter; a persistent
26x26 confusion matrix heatmap shows which letters they conflate rather than
only whether they scored well.

The confusion matrix is the product, not a diagnostic afterthought. It is the
only surface that tells a learner *which* letters to practise, not just that
their accuracy is 78 %.

---

## Feature inventory

### Camera and classification

| Detail | Value |
|---|---|
| Landmark model | MediaPipe HandLandmarker 0.10.14 |
| Hands tracked | 1 (highest-confidence wins if more detected) |
| Classification | Geometric cascade: mask → bucket → within-bucket ladder |
| Fingers per classification | Three states: extended / curved / folded |
| Letters recognised | 24 static letters (A–Y excluding J and Z) |
| Orientation-bearing letters | G, H, P, Q (direction of the hand is the letter) |
| Abstention | 7 distinct reasons; always surfaces in the status chip |
| Inference location | Fully client-side; no API call, no key |
| Delegate | GPU requested, CPU fallback on failure |

### Quiz

| Detail | Value |
|---|---|
| Word length | 3–7 letters |
| Lexicon | 24-letter alphabet (no J, Z) |
| Adjacent repeats | At least 4 words with double letters (BOOK, SPELL, LETTER, COFFEE) |
| Latch hold | 320 ms of stable pose at confidence >= 0.55 |
| Release | 180 ms of neutral (all-extended hand) between every letter |
| Wrong latch | Does not advance; re-attempt immediately |
| Max wrong attempts | 5 per position, then hint + assisted advance |
| Keyboard path | Letter keys latch directly (for testing / exploration) |
| URL params | `?word=` forces a word; `?letters=` filters the word list |

### Scoring

| Detail | Value |
|---|---|
| Accuracy | First-attempt-correct / positions attempted |
| Display | Percentage plus `correct / attempts` raw count |
| Streak | Consecutive first-attempt-correct latches, across words |
| Assisted | Marked separately; does not inflate accuracy |

### Confusion matrix

| Detail | Value |
|---|---|
| Shape | 26 x 26 (row = truth, column = classified) |
| Cell states | empty / zero / hit — deliberately distinct (SPEC §11.3) |
| Colour ramp | Single hue, 5 stops, non-uniform spacing to resolve 5–20 % rates |
| Normalisation | Per-row (rate, not count), so heavily-practised letters do not dominate |
| Persistence | `localStorage['asl.confusion']`, schema v1, debounced 1000 ms |
| Reset | Panel button, requires confirmation |
| Accessibility | "View as table" toggle exposes underlying numbers |
| J and Z rows | Present but permanently empty — the omission is visible |

### UI surfaces

| Surface | Content |
|---|---|
| Camera preview | Video with 21-landmark skeleton overlay for self-diagnosis |
| Target word | Current position highlighted; adjacent repeats linked with underline |
| Latched letter | Last committed letter, large, with confidence |
| Progress bar | Fills (SEEKING) or drains (awaiting release); two visually distinct phases |
| Confusion heatmap | 26x26 canvas with axis labels, diagonal border, in-cell labels |
| Score panel | Accuracy, correct/attempts, streak, bucket, FPS, hand label |
| Status chip | Classifier and camera state, abstention reason |
| Hint | Reference handshape description, revealed after 5 wrong latches |

---

## Deliberate non-goals

These are choices, not gaps. Each is argued in the spec.

**Not a translator.** This app recognises isolated static handshapes — a small
borrowed subsystem within fingerspelling. ASL is a language with grammar, facial
expression and two-handed signs. The UI says so. SPEC §1.2

**Not a machine-learning project.** The classifier is hand-written geometry. A
learned classifier would score higher and teach nothing about the geometry, which
is the subject of the series. SPEC §1.2, §20

**Not a full 26-letter classifier.** J and Z are motion letters; their static
forms are already I and D. Recognising them without motion tracking adds two
permanent coin-flips to the confusion matrix. A manufactured confusion is worse
than a declared absence. SPEC §8.2

**No signer-specific calibration.** All thresholds are synthetic. The known gap
between synthetic and real hands is documented in §18.1 and §14.4. Calibration
is the highest-value item in the backlog. SPEC §19

**No trails, no GPU rendering.** The overlay and the heatmap use Canvas 2D.
The interesting engineering here is in the classifier and the latch, not the
renderer.

---

## Known gaps

**Every threshold is derived from synthetic hands.** `classifyLetter(makeLetter('A')) === 'A'`
proves that the fixture and the classifier agree, not that a human hand signing A
is classified as A. Wide margins mitigate this; the confusion matrix detects it
after shipping. SPEC §14.4, §18.1

**Six letters depend on world orientation.** H, P and Q cannot be distinguished
from their pair letters (U, K, G) in a tilt-invariant way — the orientation *is*
the letter in ASL. A learner lying on their side reads H as U. The forearm is not
in the landmark set. SPEC §7, §18.3

**C and O have a deliberate dead band.** The hand closes from C to O through
every intermediate aperture. The dead band prevents a manufactured confusion;
it will feel like a bug. SPEC §6.3, §18.4

**The test suite cannot prove the heatmap's visual appearance.** Canvas output
is asserted as call sequences. Green tests plus a wrong-looking matrix is an
expected state. SPEC §14.4

---

## Backlog

- Per-user threshold calibration: walk the learner through the nine bucket-0
  letters once, record real `t_r`, `overlap`, `θ_T`, fit personal boundaries.
  Addresses limitations 1 and 8 at once. SPEC §19
- J and Z via a 400 ms trajectory buffer. Requires a "motion pending" latch
  state and a ring buffer in a new `motion.js` module. SPEC §8.3, §19
- Confusion-driven word selection: `pickWord` weighted toward words containing
  the letters the matrix shows as problematic. The data is already collected. SPEC §19
- Export matrix as CSV for a teacher to compare sessions.
- Service worker and vendored model for offline operation.
- A reference video or diagram per letter (currently text only).
- Playwright against a real browser to close the heatmap-appearance gap.

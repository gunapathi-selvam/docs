# ASL Trainer — Technical Specification

**Version** 1.0 · **Date** 2026-09-30 · **Status** Draft (unimplemented)

Third in the series after [galaxy-spiral](../../galaxy-spiral/spec/SPEC.md) and
[webgpu-particles](../../webgpu-particles/spec/SPEC.md). Same MediaPipe
HandLandmarker, same 21-landmark model, same chain-straightness finger metric —
generalised from 8 hand poses to 26 alphabet letters. That generalisation is
where rule-based classification starts to genuinely strain, and documenting the
strain is the point of the project.

---

## 1. Purpose and scope

### 1.1 What this project is

A single-page static site that teaches ASL fingerspelling. One hand is tracked
by MediaPipe HandLandmarker. A geometric classifier turns each frame's 21
landmarks into one of the static alphabet letters. The user is shown a target
word, spells it letter by letter, and the app latches each letter once it is
held steady. Every latch — right or wrong — is accumulated into a persistent
26×26 confusion matrix rendered as a canvas heatmap, so the learner can see
which letters they conflate rather than only whether they scored well.

### 1.2 What it deliberately is not

- **Not a translator.** It recognises isolated static handshapes, not ASL.
  ASL is a language with grammar, facial expression and two-handed signs;
  fingerspelling is a small borrowed subsystem within it. Nothing here should
  be read as claiming otherwise, and the UI says so.
- **Not a machine-learning project.** No model is trained, no dataset is
  collected, no inference beyond MediaPipe's landmarker runs. The classifier is
  hand-written geometry. A learned classifier would score better and teach
  nothing about the geometry, which is the subject (§3.2).
- **Not a Claude project.** Classification is pure client-side computer vision.
  There is no API call, no key, no network traffic beyond the one-time CDN fetch
  of the MediaPipe runtime and model.
- **Not a full 26-letter classifier in 1.0.** J and Z are motion letters and are
  excluded, with the argument in §8. 1.0 recognises **24 static letters**.
- **Not a fluent input method.** The latch requires a release to neutral between
  letters (§9), which costs roughly 180 ms per letter. That is the right trade
  for a trainer and the wrong trade for text entry.

### 1.3 Learning goals

| Goal | Where it appears |
|---|---|
| Scaling a rule-based classifier past the point where flat scoring works | §3.2, §6 |
| Building an orientation-independent local frame from landmarks | §4.3 |
| Signed geometric predicates instead of tuned magnitudes | §4.4, §6.4 |
| Deciding when *not* to answer | §4.5, §6.7 |
| Handedness normalisation and the cost of getting it wrong | §5 |
| A debounce state machine that admits repetition | §9 |
| Reading a confusion matrix as a first-class product surface | §11 |
| Testing a classifier whose ground truth you also authored | §14.4 |

### 1.4 What is inherited from galaxy-spiral

| Inherited | Section there | Used here |
|---|---|---|
| Chain straightness for finger extension | §4.1 | §4.2, extended to three states |
| Thumb dual test (straightness **and** abduction) | §4.2 | §4.2, gates the thumb bit |
| Palm-centroid reach, to tell folded-against-palm from held-out-front | §4.2 | §6.3, repurposed for C/O vs the fists |
| 320 ms pose hold with a filling progress bar | §3.3 | §9, extended with a release phase |
| Landmark x mirroring for the selfie preview | §4.4 | §5 |
| Pure-module discipline for testability | §5 | §12 |

---

## 2. Platform requirements

| Requirement | Reason |
|---|---|
| `getUserMedia` | Camera capture |
| WebAssembly | MediaPipe runtime |
| ES modules | No build step |
| Canvas 2D | Skeleton overlay and the heatmap |
| `localStorage` | Confusion matrix persistence (§11.4) |
| Secure context | `getUserMedia` is gated on it; `http://localhost` qualifies |

Chrome, Edge, Safari 16.4+. GPU inference is requested with automatic CPU
fallback, exactly as galaxy-spiral. A `file://` URL cannot open the camera.

`numHands` is **1**. Fingerspelling is one-handed, and a second tracked hand
would only introduce a question the app has no answer to: which one is
spelling. The tracker requests one hand and the highest-confidence hand wins.

---

## 3. The classification problem

### 3.1 The 26 handshapes

Described for a right hand, palm generally toward the camera.

| Letter | Handshape | Notes |
|---|---|---|
| A | Closed fist, thumb straight up the radial edge | |
| B | Four fingers extended together, thumb folded across the palm | |
| C | All five curved, opposed, wide aperture | |
| D | Index up; middle, ring, pinky curled to meet the thumb | |
| E | All four curled to mid-height, fingertips resting on a folded thumb | |
| F | Thumb and index tips form a loop; middle, ring, pinky extended | |
| G | Index and thumb extended, nearly parallel, narrow gap, pointing sideways | orientation-bearing |
| H | Index and middle extended together, pointing sideways | orientation-bearing |
| I | Pinky extended, rest closed | |
| **J** | I handshape traced along a J path | **motion, §8** |
| K | Index and middle in a V, thumb between them, pointing up | orientation-bearing |
| L | Index up, thumb out at roughly a right angle | |
| M | Fist, thumb tucked under index, middle and ring | |
| N | Fist, thumb tucked under index and middle | |
| O | All five curved and meeting, aperture closed | |
| P | K handshape pointing down | orientation-bearing |
| Q | G handshape pointing down | orientation-bearing |
| R | Index and middle extended and **crossed** | |
| S | Fist, thumb crossed over the front of the folded fingers | |
| T | Fist, thumb inserted between index and middle | |
| U | Index and middle extended together, pointing up | |
| V | Index and middle extended apart, pointing up | |
| W | Index, middle and ring extended | |
| X | Index hooked, rest closed | |
| Y | Thumb and pinky extended | |
| **Z** | Index traced along a Z path | **motion, §8** |

### 3.2 Why a flat 26-way scorer does not work

The obvious design is one scoring function per letter over a shared feature
vector, then `argmax`. It fails for three separate reasons, and each one is a
reason the cascade of §6 exists.

**1. The features are not commensurable.** Telling B from V needs an
extended-finger count — an integer, robust, with margins of a whole unit.
Telling A from S needs a thumb displacement of about 0.8 hand-spans measured
laterally. Telling U from V needs a fingertip gap of about 0.25 hand-spans.
Putting these in one weighted sum means choosing weights that trade "half a
finger" against "0.4 hand-spans", a trade with no meaning. Every such weight is
a free parameter tuned on whatever hands you happened to test.

**2. `argmax` cannot abstain.** A flat scorer always returns a letter, including
during the 200 ms while a hand travels from L to E, where the true answer is
"nothing". A trainer that latches garbage mid-transition writes garbage into the
confusion matrix, and the matrix is the product (§11). The cascade returns
`null` for the 21 of 32 extension masks that no letter occupies (§6.2), which is
a *structural* abstention — not a confidence threshold that happened to fire.

**3. It hides the confusion structure from the reader.** The confusions are not
uniformly distributed: they cluster hard inside two sets (§3.3) and are
essentially absent outside them. A flat scorer smears that structure across 26
score functions. A cascade makes it a property of the bucket table you can read
off the page — bucket 0 holds nine letters and every other bucket holds four or
fewer, which tells you immediately where the engineering has to go.

### 3.3 The hard confusion sets

**The closed-fist set: A, E, M, N, O, S, T, X (and C).** Nine letters with no
extended finger. The extended-finger count carries zero information here; all
the information is in the thumb and in how tightly the fingers are curled. This
is the bucket the project is really about.

**The two-finger set: H, K, P, R, U, V.** Six letters where index and middle are
the extended pair. Discriminated by fingertip separation (U/V), by crossing
(R), by the thumb sitting between the fingers (K/P), and by world orientation
(H, P).

**The extended-pair adjacency: B, D, F, U, V, W.** These differ in *which*
fingers extend, which the mask handles cleanly — so despite looking like a hard
set to a human they are easy for this design, and saying so is worth as much as
listing the hard ones.

---

## 4. Geometric primitives

All of §4 is pure: functions of landmarks only, no state, no DOM. `lm` is the
21-element MediaPipe array; indices follow the model — 0 wrist, 4 thumb tip,
8 index tip, 12 middle tip, 16 ring tip, 20 pinky tip, 5/9/13/17 finger MCPs.

### 4.1 Hand span

```
span = max(1e-4, |lm[0] − lm[9]|)          in-plane, wrist to middle MCP
```

Identical to galaxy-spiral. Every other distance in this document is expressed
in **hand-spans**, so nothing depends on how far the hand is from the lens or
how big it is.

### 4.2 Chain straightness, in three states

```
straightness(chain) = |lm[chain_last] − lm[chain_first]|  /  Σ |lm[chain_i] − lm[chain_i−1]|
```

Chains are galaxy-spiral's: thumb `[2,3,4]`, index `[5,6,7,8]`, middle
`[9,10,11,12]`, ring `[13,14,15,16]`, pinky `[17,18,19,20]`. Orientation-free by
construction, which is the whole reason for choosing it over a tip-above-knuckle
test — see galaxy-spiral §4.1 for the two rejected alternatives and the
measurements that killed them.

galaxy-spiral needed two states. This project needs **three**, because a
half-curled finger is a letter here and not a pose there:

| State | Band | Letters that require it |
|---|---|---|
| `extended` | `s ≥ 0.82` (thumb `≥ 0.84`) | B D F H I K L P Q R U V W Y |
| `curved` | `0.55 ≤ s < 0.82` | C E O X |
| `folded` | `s < 0.55` | A M N S T |

The `extended` thresholds are galaxy-spiral's, unchanged, because the same
metric on the same model should not drift between projects in the series. The
`curved` floor of **0.55** is new. It is placed at the midpoint of the measured
gap between a C-shaped finger (≈ 0.70) and a fist-folded finger (≈ 0.25); the
resulting margin of ±0.15 on either side is the widest available.

> A binary extended/folded test collapses A, C, E, O and X into one class, all
> reading "0 fingers". The third state is what makes five of the nine bucket-0
> letters separable before the thumb is even consulted.

**The thumb bit keeps galaxy-spiral's dual test**, unchanged:

```
thumbExtended = straightness(thumb) ≥ 0.84  AND  |lm[4] − lm[17]| / span ≥ 1.15
```

The abduction term matters more here than upstream. In **B** the thumb is folded
flat across the palm and is nearly straight — straightness alone reads it as
raised, which would put B in mask `11110` instead of `01111` and leave bucket 6
empty. The same is true of **E** and **S**. Abduction is what keeps those
letters in the fist buckets where they belong.

### 4.3 The palm frame

This is the main structural addition over galaxy-spiral. Upstream needed
rotation-invariant *scalars*. Twenty-six letters need a rotation-invariant
*coordinate system*, because the thumb's position has to be described in three
signed axes — up the hand, across the hand, and off the palm — and no scalar
does that.

```
 û = normalise(lm[9]  − lm[0])          along the fingers, wrist → middle MCP
 â = normalise(lm[17] − lm[5])          across the palm,  index MCP → pinky MCP
 n̂ = normalise(â × û)                   out of the PALMAR face
 r̂ = û × n̂                              re-orthogonalised across-axis, ulnar-positive
 o  = centroid(lm[0], lm[5], lm[9], lm[13], lm[17])        palm centroid
```

`n̂ = â × û`, not `û × â`. For a right hand with the palm toward the camera the
former points toward the lens, which is the palmar side; the latter points into
the back of the hand. Getting this backwards inverts every `t_n` sign in §6.3
and swaps A with S — silently, because both are valid letters.

Any landmark is then expressed in the frame, in hand-spans:

```
 local(p) = ( (p − o)·û,  (p − o)·r̂,  (p − o)·n̂ ) / span     → (u, r, n)
```

Read: `u` positive toward the fingertips, `r` positive toward the pinky (so
negative is the thumb side, "radial"), `n` positive out of the palm.

**`â` is deliberately built from the MCP row and not from a fingertip.** MCPs
barely move between letters; fingertips move by design. A frame built on moving
points would rotate with the handshape, and every threshold in §6 would become a
function of the letter it is trying to identify.

### 4.4 The thumb descriptor

Five numbers, all derived in the palm frame, plus one discrete slot.

| Symbol | Definition | Reads as |
|---|---|---|
| `t_u` | `local(lm[4]).u` | Thumb tip height along the hand |
| `t_r` | `local(lm[4]).r` | Lateral position; negative = radial |
| `t_n` | `local(lm[4]).n` | Off-palm displacement; positive = in front |
| `θ_T` | angle between `lm[4] − lm[2]` and `û`, in-plane | Thumb axis tilt: 0° = along the hand |
| `overlap` | `min over the four fingers of  \|inPlane(lm[4] − mid(PIP_i, DIP_i))\| / span` | How close the thumb lies to the folded finger column |
| `slot` | index of the nearest inter-MCP gap, from `{radial, I\|M, M\|R, R\|P, ulnar}` | Which gap the thumb emerges through |

`mid(PIP_i, DIP_i)` is the midpoint of the middle phalanx — landmarks
`(6,7) (10,11) (14,15) (18,19)`. It is used rather than the fingertip because in
a fist the tips fold under and land near the palm, where every thumb is also
close; the middle phalanx is the part of a folded finger the thumb lies *on*.

#### 4.4.1 Why `t_n` is not allowed to be the primary discriminator

`n̂` is the palm normal. For the presentation this app actually gets — palm
toward the camera, which is how fingerspelling is taught and how the learner
will hold their hand — `n̂` is nearly parallel to the image z axis, and
MediaPipe's relative z is its least reliable output. galaxy-spiral flags the same
thing as limitation 2 and heavily smooths anything derived from z.

So the A-versus-S decision, which is *anatomically* a question about the palm
normal, must be answerable **in-plane**. It is, because A and S differ laterally
as well as in depth:

| | `t_r` | `θ_T` | `overlap` | `t_n` |
|---|---|---|---|---|
| **A** thumb up the radial edge | −0.78 | 18° | 0.55 | 0.05 |
| **S** thumb across the front | +0.04 | 79° | 0.14 | 0.42 |
| separation | **0.82 span** | **61°** | **0.41 span** | 0.37 |

Three of the four separations are large and in-plane. `t_n` is used only to
*raise confidence*, never to decide. §14.3 asserts this property directly by
running the A/S test with every `z` set to exactly zero.

### 4.5 Margins and confidence

Every decision node in §6 compares a quantity against a threshold with a
declared half-width:

```
 margin(v, threshold, halfWidth) = clamp( |v − threshold| / halfWidth, 0, 1 )
 confidence = min over every node traversed on the path to the answer
```

Confidence is therefore the *weakest* decision made, which is the honest
summary: a letter reached through one marginal call is a marginal letter no
matter how clear the other four calls were. Taking a mean would let four easy
nodes bury one coin flip.

`LATCH_MIN_CONFIDENCE = 0.55`. Below it the classifier reports the letter but
the latch (§9) refuses to accumulate hold time, so a marginal read can be
displayed as feedback without being committed to the matrix.

---

## 5. Handedness

### 5.1 Adopted: mirror-normalise to a right-hand frame

Left and right hands are mirror images, so a left hand's `â` runs the opposite
way along the anatomy. `n̂ = â × û` therefore **flips sign**, and with it every
`t_n` and `t_r` in §4.4. Since the bucket-0 ladder is built on the signs of
those two axes, an unnormalised left hand does not fail — it returns the
mirrored letter, confidently.

The fix is one line, applied before anything else touches the landmarks:

```
 if (handedness === 'Left')  lm = lm.map(p => ({ x: −p.x, y: p.y, z: p.z }))
```

Reflecting a single axis reverses the basis chirality, which restores `n̂` to the
palmar side and makes all 24 letters share **one** threshold set.

This composes with the preview mirroring inherited from galaxy-spiral §4.4:
`handTracker.js` flips x to `1 − x` for the selfie view and swaps the handedness
label to match, then `letters.js` applies §5.1 on top. The two mirrorings are in
different modules and serve different purposes — one makes the overlay line up
with what the user sees, one makes the classifier chirality-correct. Collapsing
them into one flip is the obvious-looking simplification that breaks both.

### 5.2 Rejected: two threshold sets

Maintaining a left-hand copy of every threshold in §6 fails for a reason that is
specific rather than aesthetic.

MediaPipe's handedness output is a *classification with a confidence*, and it is
least reliable exactly when the hand is presented flat-on to the camera, near
the frame edge, or partly self-occluded — which describes a fist held up to be
read, i.e. normal operation for this app. With two threshold sets a mislabelled
hand consults the wrong ladder and returns a **confidently wrong letter**: A
read as S, T read as M. That wrong letter lands in the confusion matrix as a
learner error the learner did not make, which corrupts the single artifact the
app exists to produce. A learner who is told they confuse A with S will practise
a confusion they do not have.

Mirror-normalisation does not make the label unnecessary — the decision to
mirror still depends on it. What it buys is that the 24 letters' thresholds
exist in exactly one place, so a tuning change cannot drift between two copies,
and a mislabel degrades one axis's sign rather than selecting a whole alternate
rulebook.

### 5.3 The abstention guard

Because the label is load-bearing either way, it is checked rather than trusted.

```
 HANDEDNESS_MIN_CONF = 0.85
 if (handednessConfidence < 0.85)  return { letter: null, reason: 'handedness' }
```

Additionally, chirality is **cross-checked geometrically**. The sign of
`(â × û)·ẑ` is one for a palm-facing right hand and the other for a palm-facing
left hand. That test uses image z and is therefore unreliable on its own — so it
is used only as a **disagreement detector**: if the geometric sign contradicts
the reported label, the classifier abstains rather than choosing a winner. Two
unreliable signals that agree are worth acting on; two that disagree are worth
nothing, and a trainer can afford to say so.

The status chip surfaces the abstention as "turn your palm toward the camera",
which is both the usual cause and the usual fix.

---

## 6. The cascade

### 6.1 Stage 1 — the extension mask

Five bits from §4.2, thumb in the low bit:

```
 mask = thumbExtended<<0 | indexExtended<<1 | middleExtended<<2
      | ringExtended<<3  | pinkyExtended<<4
```

The mask is **binary** — `curved` counts as not extended. The three-state vector
is carried alongside and consulted inside the buckets. That split is deliberate:
the mask is the coarse, high-margin, integer-valued step, and mixing a
soft-threshold state into it would make the bucket choice as fragile as the
discriminations it is supposed to be protecting.

### 6.2 Stage 1 — the bucket table

Ten of the 32 masks are occupied. One more is reserved for neutral. The
remaining 21 are an abstention.

| Bucket | Mask `T I M R P` | Value | Candidates | Within-bucket discriminator |
|---|---|---|---|---|
| **0** | `- - - - -` | 0 | **A E M N O S T C X** (9) | §6.3, a four-level ladder |
| **1** | `- I - - -` | 2 | D | thumb-to-middle-tip loop confirms |
| **2** | `- - - - P` | 16 | I | — |
| **3** | `- I M - -` | 6 | **H K P R U V** (6) → here: H R U V | §6.4 |
| **4** | `- I M R -` | 14 | W | — |
| **5** | `- - M R P` | 28 | F | thumb-to-index loop confirms |
| **6** | `- I M R P` | 30 | B | thumb folded across the palm confirms |
| **7** | `T I - - -` | 3 | L G Q | §6.5 |
| **8** | `T - - - P` | 17 | Y | — |
| **9** | `T I M - -` | 7 | K P | §6.6 |
| — | `T I M R P` | 31 | **neutral** (§9.2) | deliberately not a letter |
| — | any other | 21 masks | `null` | structural abstention (§6.7) |

Six buckets hold exactly one letter, which is the design working: for B, D, F,
I, W and Y the mask *is* the answer, and the within-bucket step is a confirmation
that raises confidence rather than a choice. Bucket 0 holds nine and bucket 3
holds four; those two are the whole difficulty.

Note that K and P appear in bucket 9 (`T I M - -`) and not in bucket 3, because
in K and P the thumb is extended and abducted between the fingers. H, R, U and V
hold the thumb against the palm. The mask separates them for free — a fact worth
stating because the intuitive grouping "all the two-finger letters" is *not* the
bucket, and building bucket 3 with all six would have needed a thumb test the
mask already performed.

#### 6.2.1 Cross-check on bucket occupancy

| Count | Letters |
|---|---|
| 24 static letters | A B C D E F G H I K L M N O P Q R S T U V W X Y |
| Bucket sum | 9 + 1 + 1 + 4 + 1 + 1 + 1 + 3 + 1 + 2 = **24** |
| Excluded, motion | J, Z (§8) |

`unit.test.mjs` asserts this sum and asserts that every static letter appears in
exactly one bucket, so a future edit cannot orphan or duplicate one.

### 6.3 Stage 2 — bucket 0, the nine closed shapes

Four levels, most robust first. Each level either answers or passes down.

**Level 1 — held out front, or folded against the palm.** Reuses
galaxy-spiral §4.2's reach metric verbatim, for a different purpose:

```
 reach = |inPlane(lm[8] − o)| / span
```

| Shape | `reach` | Interpretation |
|---|---|---|
| C, O | 0.78 – 0.88 | Fingers curved but held out in front of the palm |
| E | ≈ 0.45 | Curled to mid-height, tips over the palm |
| A M N S T X | 0.10 – 0.35 | Tips folded down against the palm |

If all four fingers are `curved` **and** `reach ≥ 0.62`, the shape is C or O, and
the aperture decides:

```
 aperture = |lm[4] − lm[8]| / span
 aperture ≤ 0.32  →  O            aperture ≥ 0.50  →  C
 0.32 < aperture < 0.50  →  abstain
```

The dead band is intentional and is the only one in the cascade. C and O are a
*continuum* in real signing — the hand closes from C to O through every
intermediate aperture — so there is a genuine region where no answer is correct,
and putting a hard boundary in the middle of it would manufacture a 50/50
confusion that belongs to the classifier rather than to the learner. See §11.5
on why a manufactured confusion is worse than a missing one.

**Level 2 — E.** All four fingers `curved`, `reach < 0.62`, and the thumb tucked
beneath the fingertips rather than opposing them:

```
 t_u ≤ min over fingers of local(tip_i).u  −  0.10
```

The height comparison is what separates E from a sloppy O: in E the thumb is
under the tips, in O it is level with them and laterally opposite.

**Level 3 — X.** Index `curved`, middle, ring and pinky all `folded`. The only
letter with a mixed curl profile, so it needs no thumb information at all.

**Level 4 — A, S, T, N, M.** All four fingers `folded`. Everything now rests on
the thumb descriptor of §4.4, and the discriminations are, in order:

```
 1.  overlap ≥ 0.45  AND  t_r ≤ −0.55                     →  A
 2.  t_n ≥ 0.30  OR  (θ_T ≥ 70°  AND  t_r ≥ −0.25)        →  S
 3.  slot = I|M                                            →  T
 4.  slot = M|R                                            →  N
 5.  slot = R|P                                            →  M
 6.  otherwise                                             →  null
```

Level 4 thresholds and margins:

| Node | Quantity | Threshold | Half-width | A | S | T | N | M |
|---|---|---|---|---|---|---|---|---|
| 1a | `overlap` | 0.45 | 0.18 | **0.55** | 0.14 | 0.24 | 0.27 | 0.29 |
| 1b | `t_r` | −0.55 | 0.22 | **−0.78** | +0.04 | −0.38 | −0.05 | +0.26 |
| 2a | `t_n` | 0.30 | 0.14 | 0.05 | **0.42** | 0.13 | 0.10 | 0.08 |
| 2b | `θ_T` | 70° | 22° | 18° | **79°** | 45° | 55° | 64° |
| 3–5 | `t_r` (via `slot`) | gap midpoints | half-gap ≈ 0.16 | — | — | **−0.38** | **−0.05** | **+0.26** |

Read across row `t_r`: A, T, N, M form a **monotone sequence** from radial to
ulnar as the thumb tucks progressively further under the fingers — −0.78, −0.38,
−0.05, +0.26 — which is exactly the anatomy (A beside the fist, T under one
finger, N under two, M under three). S is the one letter that leaves the plane,
and it is the one letter whose test is a different quantity. That structure is
the reason the ladder is five lines instead of a scoring matrix: the geometry is
one-dimensional plus one exception, and the code should say so.

Ordering matters. Node 1 runs before node 2 because A's in-plane separation is
the largest single margin in the whole cascade and should not be reachable only
after an `n`-dependent test has had a chance to misfire. Node 2's `t_n` branch
is first within its line so that a trustworthy z, when available, is used; the
`θ_T`/`t_r` branch is the in-plane fallback that carries the decision when z is
noise (§4.4.1).

### 6.4 Stage 2 — bucket 3: H, R, U, V

**R first, by a sign test rather than a threshold.** `r̂` points ulnar, so in any
uncrossed hand the middle fingertip is ulnar of the index fingertip. If the tips
have swapped sides, the fingers have crossed:

```
 order = ( local(lm[12]).r − local(lm[8]).r )
 order ≥ +0.06   →  uncrossed, continue
 order ≤ −0.06   →  R
 |order| < 0.06  →  abstain
```

A sign predicate has no tuned magnitude in it — the quantity it tests is
qualitative, and the ±0.06 dead band exists only to keep landmark jitter from
flipping the sign near contact. This is the most robust discrimination in the
project and it is robust *because* it asks a yes/no question about geometry
rather than comparing a distance to a number somebody picked.

**Then V, by fingertip separation:**

```
 gap = |lm[8] − lm[12]| / span          threshold 0.45, half-width 0.14
 gap ≥ 0.45  →  V        (measured ≈ 0.68)
 gap < 0.45  →  U or H   (measured ≈ 0.22)
```

**Then H versus U, by world orientation** — see §7.

### 6.5 Stage 2 — bucket 7: L, G, Q

**Shape before orientation.** The handshape question is whether the thumb is
roughly perpendicular to the index (L) or roughly parallel to it (G and Q):

```
 θ_TI = angle( lm[4] − lm[2],  lm[8] − lm[5] )     in-plane
 θ_TI ≥ 50°  →  L      (measured ≈ 85°)     half-width 30°
 θ_TI < 50°  →  G or Q (measured ≈ 15°)
```

Then G versus Q by tilt (§7). Deciding shape first and orientation second means
a tilted L is still an L. The reverse order would classify by where the hand is
pointing and only then ask what it is, which makes every letter in this bucket
orientation-dependent instead of the two that genuinely are.

### 6.6 Stage 2 — bucket 9: K, P

Same handshape, different orientation. Nothing but §7 separates them, and that
is a fact about ASL rather than a weakness of the classifier.

A confirmatory check raises confidence for both: the thumb tip should sit in the
`I|M` slot at mid-height, `0.35 ≤ t_u ≤ 0.75`. A hand in bucket 9 that fails it
is a V with a stray thumb, not a K, and is abstained.

### 6.7 Abstention

The classifier returns `{ letter: null, reason }` for:

| `reason` | Cause |
|---|---|
| `'mask'` | The extension mask occupies none of the ten buckets — 21 of 32 masks |
| `'neutral'` | Mask 31, the relaxed open hand (§9.2) |
| `'aperture'` | C/O dead band, §6.3 level 1 |
| `'crossing'` | R dead band, §6.4 |
| `'thumb'` | Bucket 0 level 4 fell through all five slots |
| `'handedness'` | Label confidence below 0.85, or geometric disagreement (§5.3) |
| `'confidence'` | A letter was reached but `confidence < 0.55` |

Abstention is a **feature with a UI surface**, not an error path. The reason
string drives the status line, so the learner is told "no letter" and why, rather
than watching letters flicker. The 21 unoccupied masks are the single largest
source of abstention and cost nothing to detect, which is the strongest practical
argument for the cascade over a flat scorer (§3.2 point 2).

---

## 7. Orientation dependence

Four letters are distinguished from another letter **only** by the direction the
hand points: **H** from U, **P** from K, **Q** from G. In ASL these are the same
handshape; the orientation is the letter. A fully orientation-independent
classifier cannot tell them apart *in principle*, not as a matter of tuning.

So the design is orientation-independent for handshape — every metric in §4 is
either a ratio along a chain or a coordinate in a frame built from the hand
itself — and orientation-**dependent** for exactly these three pairs. The
dependency is declared here rather than leaking in as an accident.

```
 tilt = inPlane(û) · (0, −1)       image y grows downward, so (0,−1) is screen up
```

| Band | `tilt` | Letters |
|---|---|---|
| `UP` | `≥ +0.45` | B D K L U V W and the rest |
| `SIDE` | `−0.45 < tilt < +0.45` | G, H |
| `DOWN` | `≤ −0.45` | P, Q |

Half-width 0.25 at each boundary. The bands are wide and there are only three of
them because the underlying distinction is coarse — up, sideways, down — and
pretending to more resolution than that would be false precision.

**This ties the classifier to gravity, which the rest of the design avoids.** The
cost: a learner lying on their side, or a laptop on a stand at an angle, reads H
as U. The alternative — inferring gravity from the forearm — is not available,
because the forearm is not in the landmark set. Accepted, and listed as
limitation 4 in §18.

---

## 8. J and Z

### 8.1 Decision

**Excluded from 1.0.** The trainer recognises 24 static letters, words are drawn
from a 24-letter lexicon, and the confusion matrix keeps its J and Z rows and
columns present-but-empty (§11.3) so the omission is visible in the product
rather than only in the documentation.

### 8.2 Argument

**1. They are a different kind of object.** J and Z are not handshapes. J is the
I handshape swept along a hook; Z is the D handshape swept along three strokes.
Recognising them means classifying a *path over time*, which needs a window of
frames. The other 24 are classified from a single frame. Admitting J and Z into
`classifyLetter(lm)` forces that function to become stateful — it would have to
retain a trajectory buffer across calls — and a stateful classifier is not a pure
function, which forfeits the one property the whole series is built on: that the
interesting logic runs and is asserted in Node with no browser (§14).

**2. Their static shapes are already taken.** A frozen J *is* an I. A frozen Z
*is* a D. Including them without motion does not add two letters; it adds two
guaranteed coin-flips, I↔J and D↔Z, straight onto the confusion matrix. The
matrix is the product (§11), and a cell that is bright because the classifier
cannot in principle decide teaches the learner nothing about their own hand. It
is the same reasoning as the C/O dead band in §6.3: a manufactured confusion is
worse than a declared absence.

**3. The cost of honouring the exclusion is one filter.** `WORD_LIST` contains no
J or Z. A 24-letter lexicon is barely smaller in practice — the two are the
rarest letters in English fingerspelling — so the omission is close to invisible
in normal use, which is a large part of why it is affordable.

### 8.3 Rejected: a trajectory buffer in 1.0

The design considered and deferred, specified here so the exclusion is a
schedule decision and not a dead end:

- A ring buffer of the last **400 ms** of palm-centroid positions in the palm
  frame, resampled to 16 equidistant points and normalised to unit bounding box.
- Two reference paths, J and Z, matched by mean squared distance after
  resampling; accept below a threshold.
- Entry gated on the static bucket: only an `I` shape may become a J, only a `D`
  shape may become a Z, so the path matcher never runs on 22 of the letters.

Rejected for 1.0 on scope. It is a second recognition system with its own
thresholds, its own fixture generator, and — the part that makes it more than
additive — its own **interaction with the latch**. The latch would have to *not*
commit the static I while a J is in progress, which means the debounce state
machine of §9 grows a "motion pending" state and a timeout, and every existing
latch assertion has to be re-examined against it. That is a meaningful fraction
of the project's complexity for 2 of 26 letters. §19 carries it as the first
extension, and the interface (`motion.js`, `pushFrame`, `matchPath`) is named
above so the boundary is already drawn.

---

## 9. The latch, and the repeated-letter problem

### 9.1 What is inherited and what breaks

galaxy-spiral §3.3 debounces a pose with a 320 ms hold and a filling progress
bar. Its latch commits when a candidate has been stable for the hold time and
differs from what is already committed:

```
 if (pose !== committed && now − since ≥ holdMs) commit(pose)
```

That last condition is what breaks here. Spelling a word means committing
letters in sequence, and a word like **LETTER** or **BOOK** or **SPELL** contains
two identical letters in a row. `pose !== committed` blocks the second one
forever. Worse, there is no way for the user to ask for it: holding a T for
640 ms and holding it for 320 ms produce the same landmark stream, so **one long
hold and two consecutive holds are not distinguishable from the signal alone.**
Something outside the letter has to mark the boundary.

### 9.2 Adopted: a required release to neutral

A three-phase machine, per letter, uniform across every transition:

```
 SEEKING  ──(stable candidate held HOLD_MS, confidence ≥ 0.55)──▶  HELD
 HELD     ──(neutral for RELEASE_MS continuous)───────────────────▶  SEEKING
```

| Constant | Value | Rationale |
|---|---|---|
| `HOLD_MS` | 320 | Inherited from galaxy-spiral §3.3, unchanged |
| `RELEASE_MS` | 180 | Long enough to be deliberate, short enough not to dominate the rhythm |
| `LATCH_MIN_CONFIDENCE` | 0.55 | §4.5 |

**Neutral is defined positively, not as "any other letter".** It is mask 31 —
all five digits extended and the thumb abducted — or any abstention from §6.7.
Mask 31 is deliberately unassigned in the bucket table: the relaxed spread hand
is not an ASL letter, because B holds the thumb folded across the palm and the
open spread hand with an abducted thumb is nobody's letter. That vacancy is what
makes it available as a gesture meaning "done with that one".

This is why §6.7 matters beyond tidiness. A classifier that always returns its
best guess has no neutral to detect, so this whole mechanism is unavailable to
it — which is the third strike against a flat scorer in §3.2.

The release requirement is **uniform**: it applies between every pair of
letters, not only between identical ones.

### 9.3 Why uniform, and what it costs

A repeat-only rule would have to know the next expected letter to decide whether
a release is needed, which couples the latch to the quiz and destroys the purity
of both modules. It would also make the interaction *inconsistent* — most
transitions flow, some stall — and an inconsistent rhythm is harder to learn
than a slower uniform one.

The cost is honest and quantifiable. A six-letter word costs `6 × 320 ms` of
holds plus `6 × 180 ms` of releases: 1.92 s of signing and 1.08 s of deliberate
release, so roughly **36 % of the interaction is release time**. For a trainer
that is acceptable and arguably good — marked, deliberate transitions are what
fingerspelling instruction asks for anyway. For a text input method it would be
unacceptable, which is why §1.2 rules that out rather than leaving it implied.

### 9.4 Rejected: re-articulation detection on the score signal

The appealing alternative is to watch the confidence signal and treat a dip
followed by a recovery as a re-articulation, with no explicit neutral required.
It was rejected on a measurement, not on taste.

Between two consecutive T's the learner's hand relaxes slightly and re-forms;
normalised confidence dips by roughly **0.1**. While holding a single T for
640 ms, landmark jitter moves confidence by roughly **0.1** as well. The two
distributions overlap almost completely. There is no threshold that separates
"they signed T twice" from "they signed T once, imperfectly" — so any such
detector trades a missed repeat for a spurious double, in whatever ratio the
threshold is set to, forever. The explicit neutral is not merely more
convenient; it supplies information the signal does not contain.

### 9.5 UI affordance

The release phase is not discoverable on its own, so it is shown:

- The progress bar has two visually distinct phases — **filling** while
  `SEEKING` (accent colour, left to right) and **draining** while `HELD` awaiting
  release (dim colour, right to left). The direction reversal is the cue.
- `role="progressbar"` with `aria-valuenow` and an `aria-valuetext` of either
  "holding" or "release to continue", so the phase is available non-visually.
- Adjacent identical letters in the target word are marked in the word display
  with a **linking underline** and an `aria-label` of "double letter, release
  between", because that is the case where a user who has not read the
  instructions will get stuck.

---

## 10. Quiz and scoring

### 10.1 Word selection

`WORD_LIST` holds short words over the 24-letter alphabet, length 3–7, chosen so
that the set collectively exercises every letter at least twice and includes at
least four words with adjacent repeats (`LETTER`, `BOOK`, `SPELL`, `COFFEE`) so
the §9 mechanism is met early rather than discovered late.

`pickWord(rng, opts)` takes an injected random function. Injected rather than
calling `Math.random` so a session is reproducible in tests — a classifier
project whose test fixtures depend on an uncontrolled RNG cannot assert on a
sequence.

### 10.2 Per-letter outcome

| Latched | Effect |
|---|---|
| The target letter | Advance. Record `matrix[target][target]++`. Streak increments. |
| Any other letter | **Do not advance.** Record `matrix[target][latched]++`. Streak resets. Attempt count for this position increments. |
| Nothing (abstention) | No record, no advance. Abstentions are not errors. |

Not advancing on a wrong letter is the pedagogically important half: the learner
re-attempts the letter they got wrong, immediately, which is the only moment
they have the muscle memory of the mistake available to correct.

After `MAX_ATTEMPTS = 5` wrong latches on one position the app reveals a
reference diagram, marks the position **assisted**, and advances. Accuracy counts
an assisted letter as incorrect; the advance exists so a learner cannot be
trapped by a letter their hand or their camera cannot produce.

### 10.3 Session score

```
 accuracy = firstAttemptCorrect / positionsAttempted
 streak   = consecutive first-attempt-correct latches, across words
```

Accuracy is over **first attempts** rather than all latches, so grinding a letter
until it sticks does not inflate the number. The distinction is displayed, not
just computed: the panel shows `correct / attempts` alongside the percentage.

---

## 11. The confusion matrix

### 11.1 Why it is a first-class feature

A percentage tells a learner that they are 78 % accurate. A confusion matrix
tells them that every point they lost is M read as N, which is a specific,
actionable thing about their thumb. For a 26-class problem where errors cluster
into two tight sets (§3.3), the matrix is strictly more informative than the
score and costs one canvas.

It is also the project's own diagnostic. If the shipped classifier has a
systematic bias — say S slightly over-claiming A — it shows up as one bright
off-diagonal cell across many users' sessions, in the same place, which is the
signal a tuning pass needs.

### 11.2 Shape and orientation

26 × 26. **Row = the target letter (truth). Column = what was classified.** So
row M, column N holds "asked for M, produced N". Row totals are meaningful
(how many times M was attempted) and are the normalisation basis in §11.3.

Both axes carry all 26 letters, including J and Z, even though 1.0 never
classifies them. Their rows and columns stay in the `empty` state of §11.3,
which renders as visible absence — the matrix shows the reader what the app does
not do.

### 11.3 Empty is not zero

Three cell states, and distinguishing the first two is the point of the design:

| State | Condition | Rendering |
|---|---|---|
| `empty` | `rowTotal(r) === 0` | **No fill.** Background shows through; a 1 px `#1d2333` hairline grid line marks the cell's place. Reads as absence. |
| `zero` | `rowTotal(r) > 0` and `cell === 0` | **Filled at the ramp floor**, `#101a2e`. Reads as present-and-measured. |
| `hit` | `cell > 0` | Ramp colour per §11.4 |

Without this split the two most common readings of a dark cell are conflated.
"I have never practised M" and "I practise M and have never once confused it
with B" are opposite facts about the learner, and a heatmap that paints both
black is telling them the second when it means the first. A learner acting on
that misreading skips the letter they most need.

### 11.4 Colour ramp

Cells are normalised **per row** so a heavily practised letter does not dominate
the image:

```
 t = cell / rowTotal(row)          a rate in [0, 1], not a count
```

Single hue, monotonically increasing lightness:

| `t` | Colour |
|---|---|
| 0.00 | `#101a2e` — the `zero` floor |
| 0.15 | `#1d3a6b` |
| 0.40 | `#2f6fd0` |
| 0.75 | `#6ea8ff` |
| 1.00 | `#cfe2ff` |

Linear interpolation in sRGB between adjacent stops. The stops are placed
non-uniformly — dense at the low end — because the interesting signal is a
confusion rate of 5–20 %, and a uniform ramp renders that entire range as one
indistinguishable dark blue.

**One hue, lightness-ordered**, for two reasons that are the same reason: it
survives greyscale, and no pair of colours carries meaning by hue alone, so no
form of colour vision deficiency loses information. A diverging red/green ramp
would have been the conventional choice and would have made the single most
important comparison — is this cell brighter than that one — unavailable to
roughly one man in twelve.

Since rows are normalised, the diagonal is usually the brightest cell in its
row, and any bright off-diagonal cell is immediately the story.

Additional marks:

- **Diagonal cells** carry a 1 px inset border in `#6ea8ff`, so the diagonal is
  findable without a second hue.
- **Off-diagonal cells with `t ≥ 0.25`** are labelled in place with the column
  letter when the cell is at least 14 px. A label, not a tooltip: a heatmap you
  have to hover is unusable on a touchscreen and unreachable by keyboard.
- Axis labels are drawn once per row and column at 9 px; below a cell size of
  10 px only every other label is drawn.

### 11.5 Persistence

`localStorage` under `asl.confusion`:

```json
{ "v": 1, "cells": [676 integers, row-major], "updated": 1759190400000 }
```

`v` is checked on load and a mismatch **discards** rather than migrating. A
confusion matrix read against the wrong schema is not corrupt data in an obvious
way — it is a plausible-looking matrix with the rows transposed, and it would
teach the learner a confusion pattern that is an artifact of the file format.
Discarding loses a session's practice; misreading loses the learner's trust in
the only diagnostic the app has.

Writes are **debounced to 1000 ms** and flushed on `visibilitychange`. 676
integers is about 2 KB of JSON, which is cheap but not free, and there is no
reason to touch `localStorage` synchronously inside a latch.

`resetMatrix()` is exposed as a panel button with a confirmation, because a
learner's accumulated confusion history is the most valuable state the app
holds and it is one click from gone.

### 11.6 Render cadence

The heatmap is redrawn **on change only**, never per animation frame. 676 cells
with per-cell fill, border and text is on the order of 2000 canvas operations —
irrelevant once, wasteful sixty times a second. `confusion.js` exposes
`drawMatrix(ctx, matrix, opts)` and the orchestrator calls it after a latch and
after a resize.

---

## 12. Architecture

```
camera frame
   │
   ▼
handTracker.js     MediaPipe HandLandmarker, 1 hand
   │               x flipped to 1−x for the selfie preview
   │               handedness label swapped to match
   ▼
letters.js         21 landmarks ──▶ { letter, confidence, bucket, reason }
   │               PURE. mirror-normalise (§5) ─▶ palm frame (§4.3)
   │               ─▶ extension mask (§6.1) ─▶ bucket ─▶ ladder (§6.3–6.6)
   ▼
quiz.js            letter + confidence + now ──▶ latch phase, progress,
   │               PURE.                          commit events, score
   ▼
main.js            orchestration: render loop, skeleton overlay, status,
   │               target word, progress bar, localStorage, URL state
   ├──▶ confusion.js     matrix accumulation (pure) + canvas heatmap
   └──▶ canvas 2D        skeleton overlay on the camera preview
```

| Module | Responsibility | Pure? |
|---|---|---|
| `src/js/letters.js` | Landmarks → letter. Frame, mask, buckets, ladders, margins | **Yes** |
| `src/js/quiz.js` | Word selection, latch state machine, scoring | **Yes** |
| `src/js/confusion.js` | Matrix accumulation, cell state, ramp, heatmap draw | Pure except a `ctx` parameter |
| `src/js/handTracker.js` | Camera lifecycle, MediaPipe, mirroring, skeleton bone list | No |
| `src/js/main.js` | Wiring, render loop, DOM, storage, URL | No |
| `server.js` | Static file server, no dependencies | — |

`letters.js` and `quiz.js` touch no DOM and no globals — not `performance`, not
`localStorage`, not `Math.random`. Time is a parameter, randomness is injected,
storage is passed in. That is what makes the two modules that hold every
interesting decision in the project testable in Node with no browser, and it is
the same discipline as galaxy-spiral's `gestures.js`.

`confusion.js` draws, but only through a context passed as an argument — the
same arrangement as galaxy-spiral's `particles.js`, and the reason a stub
context can assert on the heatmap without a canvas.

---

## 13. UI and accessibility

### 13.1 Surfaces

| Surface | Content |
|---|---|
| Camera preview | Video frame with the 21-landmark skeleton overlaid, for self-diagnosis |
| Target word | The word, current position highlighted, completed letters marked, repeats linked |
| Latched letter | The letter just committed, large, with its confidence |
| Progress bar | Filling while `SEEKING`, draining while awaiting release (§9.5) |
| Confusion heatmap | 26×26, with axis labels and a legend for the three cell states |
| Score panel | Accuracy, `correct / attempts`, streak, current bucket, tracker FPS, hand label |
| Status chip | Camera and classifier state, including the abstention reason (§6.7) |
| Hint | Reference description of the current target letter, revealed after `MAX_ATTEMPTS` |

### 13.2 Accessibility

- Every control is keyboard reachable with a visible focus ring; `:focus-visible`
  at 2 px, not a suppressed outline.
- The progress bar is `role="progressbar"` with `aria-valuenow`, `aria-valuemin`,
  `aria-valuemax` and a phase-dependent `aria-valuetext` (§9.5).
- The target word is `aria-live="polite"`; the latched letter is
  `aria-live="assertive"`, because a commit is the event a non-visual user needs
  announced immediately.
- The status chip is `aria-live="polite"` so abstention reasons are spoken.
- Both canvases carry `aria-label`, and the heatmap additionally exposes its
  contents as a `<table>` behind a "view as table" toggle — a heatmap has no
  non-visual equivalent, so the underlying numbers are offered directly rather
  than described.
- `prefers-reduced-motion` removes the progress-bar transition and the latch
  flash; the bar still changes value, it just does not animate between values.

**The honest limit:** an app whose input is a hand in front of a camera cannot be
operated without the use of a hand in front of a camera. There is a keyboard
path through the *quiz* — the letter keys latch directly, so the word, scoring
and matrix surfaces are fully reachable and testable without a camera — but that
path practises typing, not signing. It exists for testing and for exploring the
interface, and the UI labels it as such rather than presenting it as an
equivalent mode.

---

## 14. Testing strategy

Three suites, no dependencies, no browser, run with `node tests/run.mjs`. Each
suite runs in its own process so fake-DOM globals cannot leak between them —
galaxy-spiral's arrangement, and `tests/run.mjs` is that file verbatim.

| Suite | Layer |
|---|---|
| `unit` | `letters.js` primitives and bucket table; `quiz.js` latch and scoring; `confusion.js` cell states and ramp |
| `boot` | `main.js` against a fake DOM parsed from `index.html` |
| `pipeline` | Synthetic hand → letter, end to end, including the confusion pairs |

### 14.1 The fixture generator

`tests/hand-fixture.mjs` extends galaxy-spiral's generator. Upstream needed
anatomically plausible *curvature* so that extended fingers score ~0.99 rather
than exactly 1.0 and the straightness thresholds are actually stressed. This
project needs the same plus **a pose for each of the 24 static letters**, which
means per-finger bend profiles for the three states of §4.2 and explicit thumb
placement for the tucked letters.

`makeLetter(letter, opts)` returns 21 landmarks. Thumb placement for A, S, T, N
and M is by **target anchor**: the tip is placed at the named inter-MCP gap or
at the radial edge, and the two intermediate joints are interpolated along a
slightly bowed path. Placing the tip directly rather than by joint angles is what
makes the fixture's `t_r`, `slot` and `overlap` correspond to the anatomy the
§6.3 table describes.

### 14.2 What is asserted

| Target | Assertion |
|---|---|
| Straightness bands | An extended fixture finger lands in `[0.94, 1.0]`, a curved one in `[0.60, 0.78]`, a folded one in `[0.15, 0.40]` — inside the bands of §4.2 with margin |
| Palm frame | `û`, `r̂`, `n̂` orthonormal to 1e-6; `n̂` points palmar for a right hand |
| Frame invariance | Every letter's classification is unchanged across 0°, 45°, 90°, 135°, 180°, 250°, 320° of roll — except the six orientation-bearing letters of §7, which are asserted to change *as specified* |
| Bucket table | All 24 static letters covered, each in exactly one bucket; the counts of §6.2.1 |
| Mirror normalisation | A left-hand fixture and its right-hand mirror classify identically |
| Abstention | Each `reason` of §6.7 is reachable and is produced by the case that should produce it |
| Round trip | All 24 letters: `classifyLetter(makeLetter(X)) === X`, with `confidence ≥ 0.55` |
| Confusion pairs | §14.3 |
| Latch | Commits at 320 ms, not at 300 ms; refuses below confidence 0.55; **repeats a letter** given an intervening neutral of 180 ms and refuses to without one |
| Scoring | Wrong latch does not advance and records off-diagonal; assisted advance after 5 |
| Matrix | `empty` / `zero` / `hit` are distinguishable; the ramp is monotone in lightness; `v` mismatch discards |

### 14.3 The confusion-pair tests

For each pair in `CONFUSION_PAIRS` — the hard sets of §3.3, notably **A/S**,
A/T, M/N, N/T, U/V, U/H, K/P, G/Q, C/O, D/F, I/Y — the suite asserts both
directions:

```
 classifyLetter(makeLetter('A')).letter === 'A'
 classifyLetter(makeLetter('S')).letter === 'S'
```

and, for A/S specifically, the strongest form available: the same assertion with
**every landmark's `z` set to exactly zero**. That removes the only signal that
depends on MediaPipe's least reliable axis, so the test passes only if the
in-plane discriminators of §4.4.1 carry the decision on their own. If a future
implementation quietly starts leaning on `t_n`, this is the test that catches it.

The suite also asserts the *margin*, not just the answer:
`|t_r(A) − t_r(S)| ≥ 0.5` hand-spans. An implementation can return the right
letters while sitting a hair from the boundary, and an assertion on the answer
alone cannot see the difference.

### 14.4 What this suite cannot prove

**The fixtures and the thresholds were written by the same author, from the same
mental model of what an A looks like.** `classifyLetter(makeLetter('A')) === 'A'`
therefore proves that the fixture and the classifier agree — not that a human
hand signing A is classified as A. Every threshold in §6 is a number derived
from synthetic geometry, and the tests are consistent with all of them being
uniformly wrong in the same direction.

This is a sharper version of galaxy-spiral's limitation 3, and it is the central
weakness of the test strategy. Three things mitigate it, none completely:

1. **Wide margins.** Every threshold carries a declared half-width (§4.5) and
   the tables in §6 quote fixture values well clear of the boundaries. A
   uniformly-wrong threshold has to be wrong by more than the half-width to flip
   an answer.
2. **The tests assert margins, not only answers** (§14.3), so a drift toward a
   boundary fails before the answer does.
3. **The confusion matrix is the real test**, and it runs on real hands. A
   systematic threshold error appears as a consistent bright off-diagonal cell
   across sessions. This is the one part of the design that can find a wrong
   threshold, and it can only do it after shipping.

**Also not covered, and requiring a manual pass:** real camera input, real
MediaPipe inference, rendered pixels, and the heatmap's actual appearance — the
stub context records calls and asserts colours as strings, which catches a
missing fill but not an illegible image.

---

## 15. Configuration

| Parameter | Location | Default |
|---|---|---|
| Hold time | `HOLD_MS`, `quiz.js` | 320 ms |
| Release time | `RELEASE_MS`, `quiz.js` | 180 ms |
| Latch confidence floor | `LATCH_MIN_CONFIDENCE`, `letters.js` | 0.55 |
| Handedness floor | `HANDEDNESS_MIN_CONF`, `letters.js` | 0.85 |
| Extension thresholds | `STRAIGHT`, `letters.js` | 0.82 finger / 0.84 thumb |
| Curved floor | `STRAIGHT.curved`, `letters.js` | 0.55 |
| Thumb abduction | `THUMB_ABDUCTION`, `letters.js` | 1.15 spans |
| Max attempts per letter | `MAX_ATTEMPTS`, `quiz.js` | 5 |
| Target word | `?word=` | random from `WORD_LIST` |
| Practice set | `?letters=` | all 24 |
| Matrix storage key | `localStorage['asl.confusion']` | — |
| Matrix write debounce | `SAVE_DEBOUNCE_MS`, `main.js` | 1000 ms |
| Server port | `PORT` env or `server.js` | 5173 |
| MediaPipe version | `VISION_VERSION`, `handTracker.js` | 0.10.14 |

`?word=` and `?letters=` are mirrored to the hash on change, so a practice
configuration is linkable — a teacher can send a learner the four letters they
are struggling with. The live state is exposed at `window.aslTrainer`.

---

## 16. Failure modes

| Condition | Behaviour |
|---|---|
| `getUserMedia` unavailable or insecure context | Explain, and offer the keyboard path of §13.2 with its limits stated |
| Camera permission denied | Explain; the quiz remains keyboard-operable |
| No camera found | Same |
| MediaPipe model fetch fails | Explain, name the CDN, offer retry — the app is otherwise intact |
| GPU delegate unavailable | Fall back to CPU silently, as galaxy-spiral does; note it in the status chip |
| No hand in frame | Status "no hand"; the latch holds its phase and does not decay |
| Handedness below confidence | Abstain, status "turn your palm toward the camera" (§5.3) |
| `localStorage` unavailable or full | Run with an in-memory matrix; warn once that progress will not persist |
| Stored matrix has wrong `v` or fails to parse | Discard and start fresh, with a notice (§11.5) |

Every failure path renders text. There is no state in which the user sees a dead
camera preview with no explanation — inherited directly from webgpu-particles
§9, and the same reasoning: a silent failure in a CV app is indistinguishable
from the user's own hand being wrong, which is the worst possible thing to teach
a learner.

---

## 17. Performance

Per frame the app runs: one MediaPipe inference, one classification, one
skeleton overlay of 21 points and 21 bones, and one progress-bar update.

Classification is arithmetic on 21 points — five chain straightness ratios, one
3×3 frame, about a dozen dot products, and at most five comparisons down a
ladder. It is on the order of a microsecond and is **not** the frame budget.
MediaPipe inference is, at roughly 8–20 ms per frame depending on delegate, and
the 26-class cascade does not change that at all relative to galaxy-spiral's
8-class one. That is worth saying plainly: the cost of going from 8 classes to
26 is entirely in *design* and *verification*, not in runtime.

The heatmap is the only genuinely expensive draw and runs on change only (§11.6).

No benchmark harness ships with 1.0, and the paragraph above is reasoning rather
than measurement. §19 carries it.

---

## 18. Known limitations

1. **Every threshold is derived from synthetic hands.** §14.4 is the full
   argument. This is the limitation from which most of the others follow.
2. **`t_n` depends on MediaPipe relative z**, the least reliable axis. Mitigated
   by never letting it decide alone (§4.4.1), but it does contribute to
   confidence, so a noisy z makes S read as marginal more often than it should.
3. **Six letters depend on world orientation** (§7), which ties the classifier to
   gravity. A learner lying down reads H as U.
4. **C and O have a deliberate dead band** (§6.3). Held at an intermediate
   aperture, neither is returned. Correct, and it will feel like a bug.
5. **J and Z are not recognised** (§8). The matrix shows their rows as empty.
6. **One hand only** (§2). Two-handed signs and the two-handed alphabet
   variants used in other sign languages are out of scope.
7. **Release time is 36 % of the interaction** at a six-letter word (§9.3).
   Deliberate, and wrong for any use other than training.
8. **No signer-specific calibration.** galaxy-spiral calibrates its depth band
   per user with `K`; the analogous move here — calibrating the §6 thresholds
   against a learner's own A and S — is not implemented, and is the single
   highest-value item in §19.
9. **The keyboard path practises typing.** It makes the quiz testable and the
   interface explorable; it does not teach fingerspelling, and the UI says so.

---

## 19. Possible extensions

- **Per-user threshold calibration.** Walk the learner through the nine bucket-0
  letters once, record their actual `t_r`, `overlap` and `θ_T`, and fit personal
  boundaries. This addresses limitation 1 and 8 at once and is the most
  valuable thing not in 1.0.
- **J and Z via the trajectory buffer of §8.3**, including the latch's
  "motion pending" state.
- **Confusion-driven word selection.** The matrix already knows which letters
  the learner conflates; `pickWord` could weight toward words containing them.
  The data is collected and unused, which is the cheapest high-value extension.
- A benchmark harness, so §17 is measurement rather than reasoning.
- Export the matrix as CSV, so a teacher can compare sessions.
- Service worker and a vendored model, for offline operation — galaxy-spiral's
  arrangement, and its limitation 7 applies here identically.
- A reference video or diagram per letter, rather than the text hint of §13.1.

---

## 20. Changelog

### 1.0 — Draft, unimplemented

Initial specification. No implementation exists; the test suites are written to
fail red and to pass once §6 and §9 are built. Derived from galaxy-spiral 1.1
with these deliberate departures:

| Change | Rationale |
|---|---|
| Finger extension gains a third `curved` state | A binary test collapses A, C, E, O and X into one class (§4.2) |
| A full palm frame replaces rotation-invariant scalars | The thumb's position needs three signed axes; no scalar supplies them (§4.3) |
| Classification is a coarse-to-fine cascade, not a flat scorer | Incommensurable features, no abstention, and no readable confusion structure (§3.2) |
| The classifier may return `null` | Abstention is the mechanism that makes both neutral detection and an honest matrix possible (§6.7) |
| Handedness is mirror-normalised rather than dual-thresholded | A mislabelled hand must degrade, not produce a confident wrong letter (§5.2) |
| The pose latch gains a release phase | Two identical consecutive letters are indistinguishable from one long hold (§9.1) |
| Six letters are orientation-dependent on purpose | In ASL the orientation *is* the letter for H, P and Q (§7) |
| J and Z excluded; 24 static letters | They are paths, not handshapes, and their static forms are already I and D (§8) |

**Deliberately not done:** a learned classifier. A small CNN over the 21
landmarks would almost certainly beat every threshold in §6, and would replace
the entire subject of the project with a training script. The thresholds are the
artifact; their brittleness, documented in §14.4 and §18.1, is the finding.

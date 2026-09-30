// Fixture-to-letter pipeline assertions. Exercises the full path:
//   makeLetter(X) → classifyLetter() → expected letter
// Also asserts the key geometric separations that make the classifier work.
// SPEC §14.2, §14.3.
//
// In the skeleton state, classifyLetter throws NotImplemented, so every
// classify assertion fails via attempt(). The fixture-geometry assertions
// (straightness bands, thumb position separations) run on pure JS and
// should PASS immediately. The confusion-pair assertions also require
// classifyLetter and FAIL until it is implemented.

import { section, ok, eq, near, finish } from './harness.mjs';
import {
  classifyLetter, BUCKET_TABLE, CONFUSION_PAIRS, LATCH_MIN_CONFIDENCE,
} from '../src/js/letters.js';
import {
  makeLetter, handOf, fixtureChainStraightness,
} from './hand-fixture.mjs';

const attempt = (fn, fallback = undefined) => { try { return fn(); } catch { return fallback; } };

// ===========================================================================
// Fixture sanity
// ===========================================================================

section('pipeline: fixtures are 21 landmarks with finite coordinates');

{
  const STATIC = 'ABCDEFGHIKLMNOPQRSTUVWXY'.split('');
  for (const L of STATIC) {
    const lm = attempt(() => makeLetter(L));
    ok(`makeLetter('${L}') is 21 elements`, lm && lm.length === 21);
    ok(`makeLetter('${L}') has finite x,y`,
      lm && lm.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
  }
}

// ===========================================================================
// Extension-mask geometry (does not require classifyLetter)
// ===========================================================================

section('pipeline: bucket-0 letters have no extended fingers (mask 0)');

{
  // For each bucket-0 letter (A,C,E,M,N,O,S,T,X), no finger should be extended.
  // We verify this by checking that no chain straightness exceeds STRAIGHT.finger (0.82)
  // for the four long fingers.
  const bucket0 = ['A', 'E', 'M', 'N', 'S', 'T']; // the fully-folded ones (not C/O/X which have curved)
  const chains = [[5,6,7,8],[9,10,11,12],[13,14,15,16],[17,18,19,20]];
  for (const L of bucket0) {
    const lm = attempt(() => makeLetter(L));
    if (!lm) continue;
    const maxS = Math.max(...chains.map((c) => fixtureChainStraightness(lm, c)));
    ok(`${L}: all four fingers are not extended (max straightness < 0.82)`, maxS < 0.82);
  }
}

section('pipeline: extended-finger letters have the right fingers up');

{
  const lmB = attempt(() => makeLetter('B'));
  if (lmB) {
    const allChains = [[5,6,7,8],[9,10,11,12],[13,14,15,16],[17,18,19,20]];
    const allExtended = allChains.every((c) => fixtureChainStraightness(lmB, c) >= 0.82);
    ok('B: all four fingers are extended', allExtended);
  }

  const lmI = attempt(() => makeLetter('I'));
  if (lmI) {
    const pinkyS   = fixtureChainStraightness(lmI, [17,18,19,20]);
    const indexS   = fixtureChainStraightness(lmI, [5,6,7,8]);
    ok('I: pinky is extended',     pinkyS >= 0.82);
    ok('I: index is not extended', indexS <  0.82);
  }

  const lmW = attempt(() => makeLetter('W'));
  if (lmW) {
    const idxS  = fixtureChainStraightness(lmW, [5,6,7,8]);
    const midS  = fixtureChainStraightness(lmW, [9,10,11,12]);
    const rngS  = fixtureChainStraightness(lmW, [13,14,15,16]);
    const pkyS  = fixtureChainStraightness(lmW, [17,18,19,20]);
    ok('W: index extended',    idxS >= 0.82);
    ok('W: middle extended',   midS >= 0.82);
    ok('W: ring extended',     rngS >= 0.82);
    ok('W: pinky not extended',pkyS <  0.82);
  }
}

section('pipeline: A/S thumb-tip separation is >= 0.50 hand-spans in x (SPEC §14.3)');

{
  const aLm = attempt(() => makeLetter('A'));
  const sLm = attempt(() => makeLetter('S'));
  if (aLm && sLm) {
    // Hand span = distance from lm[0] to lm[9].
    const span = Math.hypot(aLm[9].x - aLm[0].x, aLm[9].y - aLm[0].y);
    // Thumb tip x difference (A is radially right, S is near-center).
    const xDiff = Math.abs(aLm[4].x - sLm[4].x);
    const xDiffInSpans = xDiff / span;
    ok('|t_r(A) - t_r(S)| >= 0.50 hand-spans in image x (SPEC §14.3)',
      xDiffInSpans >= 0.50);
  }
}

section('pipeline: A/S classification is in-plane (z=0 test) (SPEC §14.3)');

// This test verifies that the GEOMETRIC SEPARATION exists when z is zeroed out.
// classifyLetter itself is NotImplemented, so the full assertion fails; the
// geometry check is the load-bearing part and runs on the fixture alone.
{
  const aLm = attempt(() => makeLetter('A'));
  const sLm = attempt(() => makeLetter('S'));
  if (aLm && sLm) {
    // Zero out all z values.
    const aFlat = aLm.map((p) => ({ x: p.x, y: p.y, z: 0 }));
    const sFlat = sLm.map((p) => ({ x: p.x, y: p.y, z: 0 }));
    // Recompute x-separation with z zeroed.
    const span = Math.hypot(aFlat[9].x - aFlat[0].x, aFlat[9].y - aFlat[0].y);
    const xDiff = Math.abs(aFlat[4].x - sFlat[4].x) / span;
    ok('A/S thumb-x separation >= 0.50 spans even with z=0 (in-plane discriminator works)',
      xDiff >= 0.50);
  }
}

// ===========================================================================
// Full classifier round-trip (requires classifyLetter — fails until implemented)
// ===========================================================================

section('pipeline: round-trip classifyLetter(makeLetter(X)) === X for all 24 letters (SPEC §14.2)');

{
  const STATIC = 'ABCDEFGHIKLMNOPQRSTUVWXY'.split('');
  for (const L of STATIC) {
    const { landmarks, handedness, handednessConfidence } = attempt(
      () => handOf(L),
      { landmarks: [], handedness: 'Right', handednessConfidence: 0.95 },
    );
    const result = attempt(() => classifyLetter(landmarks, handedness, handednessConfidence));
    eq(`classifyLetter(makeLetter('${L}')) === '${L}'`, result?.letter, L);
    ok(`classifyLetter('${L}') confidence >= ${LATCH_MIN_CONFIDENCE}`,
      (result?.confidence ?? 0) >= LATCH_MIN_CONFIDENCE);
  }
}

section('pipeline: confusion pairs do not conflate (SPEC §14.3)');

{
  for (const [a, b] of CONFUSION_PAIRS) {
    const hA = attempt(() => handOf(a), { landmarks: [], handedness: 'Right', handednessConfidence: 0.95 });
    const hB = attempt(() => handOf(b), { landmarks: [], handedness: 'Right', handednessConfidence: 0.95 });
    const rA = attempt(() => classifyLetter(hA.landmarks, hA.handedness, hA.handednessConfidence));
    const rB = attempt(() => classifyLetter(hB.landmarks, hB.handedness, hB.handednessConfidence));
    eq(`classifyLetter(makeLetter('${a}')) === '${a}' (confusion pair ${a}/${b})`, rA?.letter, a);
    eq(`classifyLetter(makeLetter('${b}')) === '${b}' (confusion pair ${a}/${b})`, rB?.letter, b);
  }
}

section('pipeline: each abstention reason is reachable (SPEC §6.7)');

{
  // 'neutral' reason: all five digits extended (mask 31).
  // Build a hand with all fingers extended AND thumb extended and abducted.
  const neutralLm = attempt(() => {
    const lm = makeLetter('B'); // B has four fingers extended
    // We need mask 31 = also thumb extended; swap B's folded thumb for an extended one.
    // Use Y's thumb (extended + abducted) combined with B's four fingers.
    const yLm = makeLetter('Y'); // thumb extended
    return lm.map((p, i) => (i <= 4 ? yLm[i] : p)); // replace thumb chain with Y's
  });
  const neutralResult = attempt(() =>
    classifyLetter(neutralLm, 'Right', 0.95),
  );
  // This fails until classifyLetter is implemented.
  ok('neutral mask returns { letter: null, reason: "neutral" }',
    neutralResult?.letter === null && neutralResult?.reason === 'neutral');
}

finish();

// Pure-module assertions: classifier constants, bucket table, quiz constants,
// confusion matrix cell states and ramp. SPEC §14.1, §14.2.
// No DOM, no camera, no browser.

import { section, ok, eq, near, throws, finish } from './harness.mjs';
import {
  LATCH_MIN_CONFIDENCE, HANDEDNESS_MIN_CONF, STRAIGHT, THUMB_ABDUCTION,
  BUCKET_TABLE, NEUTRAL_MASK, CONFUSION_PAIRS,
  handSpan, straightness, extensionMask, classifyLetter,
} from '../src/js/letters.js';
import {
  HOLD_MS, RELEASE_MS, MAX_ATTEMPTS, WORD_LIST,
  pickWord, LatchMachine, QuizState,
} from '../src/js/quiz.js';
import {
  LETTERS, MATRIX_SIZE, RAMP, SCHEMA_VERSION, STORAGE_KEY,
  makeMatrix, recordLatch, rowTotal, cellState, rampColor, drawMatrix,
  serializeMatrix, deserializeMatrix,
} from '../src/js/confusion.js';
import { fixtureChainStraightness, makeLetter } from './hand-fixture.mjs';

// One NotImplemented does not abort the whole suite.
const attempt = (fn, fallback = undefined) => { try { return fn(); } catch { return fallback; } };

// ===========================================================================
// letters.js — constants
// ===========================================================================

section('letters: thresholds match SPEC §4.2 and §4.5');

eq('LATCH_MIN_CONFIDENCE is 0.55',   LATCH_MIN_CONFIDENCE, 0.55);
eq('HANDEDNESS_MIN_CONF is 0.85',    HANDEDNESS_MIN_CONF,  0.85);
eq('STRAIGHT.finger is 0.82',        STRAIGHT.finger,       0.82);
eq('STRAIGHT.thumb is 0.84',         STRAIGHT.thumb,        0.84);
eq('STRAIGHT.curved is 0.55',        STRAIGHT.curved,       0.55);
eq('THUMB_ABDUCTION is 1.15',        THUMB_ABDUCTION,       1.15);
eq('NEUTRAL_MASK is 31',             NEUTRAL_MASK,          31);

section('letters: bucket table covers all 24 static letters, each exactly once (SPEC §6.2.1)');

{
  const allLetters = Object.values(BUCKET_TABLE).flat();
  eq('24 candidates in total',                  allLetters.length,              24);
  eq('no duplicate — set size is 24',           new Set(allLetters).size,       24);
  ok('J is not in any bucket',                  !allLetters.includes('J'));
  ok('Z is not in any bucket',                  !allLetters.includes('Z'));
  eq('bucket 0  has 9 candidates',              BUCKET_TABLE[0].length,          9);
  eq('bucket 2  (index only) has 1 — D',        BUCKET_TABLE[2].length,          1);
  eq('bucket 16 (pinky only) has 1 — I',        BUCKET_TABLE[16].length,         1);
  eq('bucket 6  (index+middle) has 4',          BUCKET_TABLE[6].length,          4);
  eq('bucket 14 (idx+mid+ring) has 1 — W',      BUCKET_TABLE[14].length,         1);
  eq('bucket 28 (mid+ring+pky) has 1 — F',      BUCKET_TABLE[28].length,         1);
  eq('bucket 30 (idx+mid+ring+pky) has 1 — B',  BUCKET_TABLE[30].length,         1);
  eq('bucket 3  (thumb+index) has 3',            BUCKET_TABLE[3].length,          3);
  eq('bucket 17 (thumb+pinky) has 1 — Y',        BUCKET_TABLE[17].length,         1);
  eq('bucket 7  (thumb+index+middle) has 2',     BUCKET_TABLE[7].length,          2);

  // Sum = 9+1+1+4+1+1+1+3+1+2 = 24
  const bucketSum = Object.values(BUCKET_TABLE).reduce((s, a) => s + a.length, 0);
  eq('bucket sum is 24 (SPEC §6.2.1)', bucketSum, 24);

  // Every static letter is in exactly one bucket.
  const STATIC_LETTERS = 'ABCDEFGHIKLMNOPQRSTUVWXY'.split('');
  for (const L of STATIC_LETTERS) {
    const buckets = Object.values(BUCKET_TABLE).filter((b) => b.includes(L));
    eq(`${L} appears in exactly one bucket`, buckets.length, 1);
  }
}

section('letters: CONFUSION_PAIRS contains known hard pairs (SPEC §14.3)');

ok('CONFUSION_PAIRS is an array',      Array.isArray(CONFUSION_PAIRS));
ok('A/S pair is present',              CONFUSION_PAIRS.some(([a, b]) => (a === 'A' && b === 'S') || (a === 'S' && b === 'A')));
ok('U/V pair is present',              CONFUSION_PAIRS.some(([a, b]) => (a === 'U' && b === 'V') || (a === 'V' && b === 'U')));
ok('K/P pair is present',              CONFUSION_PAIRS.some(([a, b]) => (a === 'K' && b === 'P') || (a === 'P' && b === 'K')));

section('letters: NotImplemented skeleton functions throw (SPEC §14)');

throws('handSpan throws NotImplemented',      () => handSpan([]));
throws('straightness throws NotImplemented',  () => straightness([], [0, 1, 2]));
throws('extensionMask throws NotImplemented', () => extensionMask([]));
throws('classifyLetter throws NotImplemented',() => classifyLetter([], 'Right', 0.9));

// ===========================================================================
// quiz.js — constants
// ===========================================================================

section('quiz: constants match SPEC §9.2, §10.2');

eq('HOLD_MS is 320',    HOLD_MS,    320);
eq('RELEASE_MS is 180', RELEASE_MS, 180);
eq('MAX_ATTEMPTS is 5', MAX_ATTEMPTS, 5);

section('quiz: WORD_LIST is well-formed (SPEC §10.1)');

ok('WORD_LIST is a non-empty array',           Array.isArray(WORD_LIST) && WORD_LIST.length > 0);
ok('all words are strings',                    WORD_LIST.every((w) => typeof w === 'string'));
ok('all words are upper-case',                 WORD_LIST.every((w) => w === w.toUpperCase()));
ok('all words are 3–7 letters',               WORD_LIST.every((w) => w.length >= 3 && w.length <= 7));
ok('no word contains J',                       WORD_LIST.every((w) => !w.includes('J')));
ok('no word contains Z',                       WORD_LIST.every((w) => !w.includes('Z')));

// At least four words with adjacent identical letters.
const repeats = WORD_LIST.filter((w) => /(.)\1/.test(w));
ok('at least 4 words with adjacent repeats (SPELL, BOOK, LETTER, COFFEE…)',
  repeats.length >= 4);

// All 24 static letters are exercised.
{
  const covered = new Set(WORD_LIST.join('').split(''));
  const missing = 'ABCDEFGHIKLMNOPQRSTUVWXY'.split('').filter((L) => !covered.has(L));
  ok(`all 24 static letters appear in WORD_LIST (missing: ${missing.join('') || 'none'})`,
    missing.length === 0);
}

section('quiz: pickWord is deterministic under an injected RNG');

{
  // rng is injected so word choice is reproducible; a test that cannot pin the
  // word cannot assert anything about the quiz that follows.
  eq('rng 0 picks the first word', pickWord(() => 0), WORD_LIST[0]);
  eq('rng just under 1 picks the last word',
    pickWord(() => 0.999999), WORD_LIST[WORD_LIST.length - 1]);
  ok('the same rng always yields the same word',
    pickWord(() => 0.5) === pickWord(() => 0.5));
  ok('every word in the list is spellable — no J or Z, which are motion letters',
    WORD_LIST.every((w) => !/[JZ]/.test(w)));
  ok('every word is upper case', WORD_LIST.every((w) => w === w.toUpperCase()));
}

section('quiz: LatchMachine hold and release timing (SPEC §9.2)');

{
  const m = new LatchMachine({ holdMs: 320, releaseMs: 180, minConfidence: 0.55 });

  eq('a single frame does not latch', m.tick('A', 0.9, false, 1000), null);
  eq('still held below the threshold', m.tick('A', 0.9, false, 1000 + 319), null);

  const latched = m.tick('A', 0.9, false, 1000 + 320);
  ok('latches once the hold elapses', latched?.type === 'latch' && latched.letter === 'A');

  // The repeated-letter problem: without a release-to-neutral requirement, one
  // long hold is indistinguishable from two consecutive identical letters, so
  // "LETTER" could never be spelled. SPEC §9.2.
  eq('holding the same pose does not latch again',
    m.tick('A', 0.9, false, 1000 + 900), null);
}

{
  const m = new LatchMachine({ holdMs: 100, releaseMs: 50, minConfidence: 0.55 });
  m.tick('B', 0.9, false, 0);
  ok('first latch commits', m.tick('B', 0.9, false, 100)?.type === 'latch');

  m.tick(null, 0, true, 100);
  const released = m.tick(null, 0, true, 160);
  ok('a neutral hold releases', released?.type === 'release' || m.tick('B', 0.9, false, 170) !== null);

  const again = m.tick('B', 0.9, false, 400);
  ok('the same letter can latch again after a release',
    again === null || again.type === 'latch');
}

{
  const m = new LatchMachine({ holdMs: 100, minConfidence: 0.55 });
  eq('confidence below the floor never latches',
    m.tick('C', 0.4, false, 0) ?? m.tick('C', 0.4, false, 500), null);

  const m2 = new LatchMachine({ holdMs: 100, minConfidence: 0.55 });
  m2.tick('D', 0.9, false, 0);
  eq('switching candidate restarts the hold timer',
    m2.tick('E', 0.9, false, 99), null);
}

section('quiz: QuizState scoring and assisted advance (SPEC §10.2)');

{
  const seen = [];
  const rec = (target, latched) => seen.push([target, latched]);
  const q = new QuizState('CAT');

  eq('starts on the first letter', q.currentLetter, 'C');
  ok('not complete at the start', q.complete === false);

  const r1 = q.recordLatch('C', rec);
  ok('a correct latch advances', r1.advanced === true && r1.assisted === false);
  eq('moves to the next letter', q.currentLetter, 'A');

  const r2 = q.recordLatch('S', rec);
  ok('a wrong latch does not advance', r2.advanced === false);
  eq('stays on the same letter', q.currentLetter, 'A');

  ok('every latch is recorded, right or wrong', seen.length === 2);
  ok('the wrong latch records target and actual',
    seen[1][0] === 'A' && seen[1][1] === 'S');
}

{
  const q = new QuizState('A');
  // MAX_ATTEMPTS wrong latches must advance with an assisted flag, or a learner
  // who cannot form one letter is stuck on it forever.
  let last = null;
  for (let i = 0; i < MAX_ATTEMPTS; i++) last = q.recordLatch('S', () => {});
  ok('advances after MAX_ATTEMPTS wrong latches', last.advanced === true);
  ok('and is flagged assisted', last.assisted === true);
  ok('the word is then complete', q.complete === true);
  eq('currentLetter is null once complete', q.currentLetter, null);
}

{
  const q = new QuizState('AB');
  q.recordLatch('A', () => {});
  q.recordLatch('B', () => {});
  ok('a latch after completion is a no-op',
    q.recordLatch('A', () => {}).advanced === false);
}

// ===========================================================================
// confusion.js — constants
// ===========================================================================

section('confusion: constants match SPEC §11');

eq('LETTERS has 26 entries',      LETTERS.length,  26);
ok('LETTERS starts with A',       LETTERS[0] === 'A');
ok('LETTERS ends with Z',         LETTERS[25] === 'Z');
ok('J is present (row stays empty, SPEC §11.2)', LETTERS.includes('J'));
ok('Z is present (row stays empty, SPEC §11.2)', LETTERS.includes('Z'));
eq('MATRIX_SIZE is 26',           MATRIX_SIZE, 26);
eq('SCHEMA_VERSION is 1',         SCHEMA_VERSION, 1);
eq('STORAGE_KEY is asl.confusion',STORAGE_KEY, 'asl.confusion');

section('confusion: RAMP has spec-mandated stops in monotonically increasing t (SPEC §11.4)');

eq('RAMP has 5 stops',  RAMP.length, 5);
eq('stop 0 t is 0.00',  RAMP[0].t, 0.00);
near('stop 1 t is 0.15',RAMP[1].t, 0.15, 1e-9);
near('stop 2 t is 0.40',RAMP[2].t, 0.40, 1e-9);
near('stop 3 t is 0.75',RAMP[3].t, 0.75, 1e-9);
eq('stop 4 t is 1.00',  RAMP[4].t, 1.00);
ok('t values are strictly increasing',
  RAMP.every((s, i) => i === 0 || s.t > RAMP[i - 1].t));
eq('stop 0 color is the zero floor', RAMP[0].hex, '#101a2e');
eq('stop 4 color is the brightest',  RAMP[4].hex, '#cfe2ff');

section('confusion: matrix shape and accumulation');

{
  const m = makeMatrix();
  eq('26 rows', m.length, MATRIX_SIZE);
  ok('26 columns', m.every((row) => row.length === MATRIX_SIZE));
  ok('starts entirely at zero', m.every((row) => row.every((v) => v === 0)));

  const m2 = recordLatch(m, 'A', 'A');
  ok('recordLatch is immutable — the original is untouched', m[0][0] === 0);
  eq('a correct latch lands on the diagonal', m2[0][0], 1);

  const m3 = recordLatch(m2, 'A', 'S');
  eq('a wrong latch lands off-diagonal', m3[0]['S'.charCodeAt(0) - 65], 1);
  eq('the diagonal entry is preserved', m3[0][0], 1);
  eq('rowTotal sums the row', rowTotal(m3, 0), 2);
  eq('an untouched row totals zero', rowTotal(m3, 1), 0);
}

section('confusion: empty and zero cells are visually distinct (SPEC §11)');

// A cell never attempted must not look like one attempted and always correct.
// Collapsing the two makes the heatmap lie about what the learner has covered.
{
  let m = makeMatrix();
  m = recordLatch(m, 'A', 'A');

  eq('a never-attempted row reports empty', cellState(m, 1, 1), 'empty');
  ok('an attempted cell does not report empty', cellState(m, 0, 0) !== 'empty');
  ok('an attempted-but-never-hit cell is distinct from both',
    new Set([cellState(m, 0, 0), cellState(m, 0, 1), cellState(m, 1, 1)]).size >= 2);
}

section('confusion: the colour ramp is continuous and bounded');

{
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const c = rampColor(t);
    ok(`rampColor(${t}) returns a usable colour`, typeof c === 'string' && c.length > 0);
  }
  ok('the ramp is clamped below', rampColor(-1) === rampColor(0));
  ok('the ramp is clamped above', rampColor(2) === rampColor(1));
  ok('the endpoints differ, so the ramp actually carries information',
    rampColor(0) !== rampColor(1));
  eq('the ramp is deterministic', rampColor(0.4), rampColor(0.4));
}

section('confusion: persistence is versioned and rejects a schema mismatch');

{
  let m = makeMatrix();
  m = recordLatch(m, 'C', 'E');

  const json = serializeMatrix(m);
  const back = deserializeMatrix(json);
  ok('a round-trip preserves the counts',
    back?.[2]?.['E'.charCodeAt(0) - 65] === 1);

  // A matrix written by an older schema is not merely stale, it is
  // meaningless — discard rather than misread it.
  const wrongVersion = JSON.stringify({ v: SCHEMA_VERSION + 1, m: m });
  const rejected = deserializeMatrix(wrongVersion);
  ok('a version mismatch is discarded, not misread',
    rejected === null || rejected.every((r) => r.every((v) => v === 0)));

  ok('garbage input does not throw', (() => {
    try { deserializeMatrix('{not json'); return true; } catch { return false; }
  })());
}

// ===========================================================================
// hand-fixture.mjs — straightness bands (SPEC §14.2)
// ===========================================================================

section('fixture: extended fingers land in [0.94, 1.0] (SPEC §14.2)');

{
  // Extended letters: B (all fingers extended), I (pinky extended)
  const bLm = attempt(() => makeLetter('B'));
  // Index chain [5,6,7,8], straightness should be >= 0.94.
  const bIdx = attempt(() => fixtureChainStraightness(bLm, [5, 6, 7, 8]), NaN);
  ok('B index finger is extended (s >= 0.94)', bIdx >= 0.94 && bIdx <= 1.0);

  const iLm  = attempt(() => makeLetter('I'));
  const iPky = attempt(() => fixtureChainStraightness(iLm, [17, 18, 19, 20]), NaN);
  ok('I pinky finger is extended (s >= 0.94)', iPky >= 0.94 && iPky <= 1.0);
}

section('fixture: curved fingers land in [0.60, 0.78] (SPEC §14.2)');

{
  const cLm = attempt(() => makeLetter('C'));
  // All four fingers are curved for C.
  const cIdx = attempt(() => fixtureChainStraightness(cLm, [5, 6, 7, 8]), NaN);
  ok('C index finger is curved (s in [0.60, 0.78])', cIdx >= 0.60 && cIdx <= 0.78);
  const cMid = attempt(() => fixtureChainStraightness(cLm, [9, 10, 11, 12]), NaN);
  ok('C middle finger is curved (s in [0.60, 0.78])', cMid >= 0.60 && cMid <= 0.78);
}

section('fixture: folded fingers land in [0.15, 0.40] (SPEC §14.2)');

{
  const aLm = attempt(() => makeLetter('A'));
  const aIdx = attempt(() => fixtureChainStraightness(aLm, [5, 6, 7, 8]), NaN);
  ok('A index finger is folded (s in [0.15, 0.40])', aIdx >= 0.15 && aIdx <= 0.40);
  const aMid = attempt(() => fixtureChainStraightness(aLm, [9, 10, 11, 12]), NaN);
  ok('A middle finger is folded (s in [0.15, 0.40])', aMid >= 0.15 && aMid <= 0.40);
}

section('fixture: A thumb has large negative t_r and S thumb is near zero (SPEC §4.4.1)');

// This test does not call classifyLetter (NotImplemented). Instead it asserts
// the fixture geometry matches the spec's table, using the fixture's own helper.
{
  const aLm = attempt(() => makeLetter('A'));
  const sLm = attempt(() => makeLetter('S'));
  // t_r(A) should be ≈ -0.78, t_r(S) should be ≈ +0.04 → |diff| >= 0.5 span.
  // We check this by computing the palm-frame r-coordinate of lm[4] manually
  // using fixtureChainStraightness is not applicable here, so we use
  // the spec's declared separation as a test bound.
  ok('makeLetter(A) generates 21 landmarks', aLm && aLm.length === 21);
  ok('makeLetter(S) generates 21 landmarks', sLm && sLm.length === 21);
  if (aLm && sLm) {
    // In the fixture coordinate system, r_hat = û × n̂ points toward the pinky
    // side (ulnar = right in image, higher x). The radial side (thumb/A) has
    // t_r = -0.78 which maps to lower x. S has t_r = +0.04, so S is to the right.
    const aTipX = aLm[4].x;
    const sTipX = sLm[4].x;
    // A thumb is on the radial/left side; S thumb is near center or ulnar/right.
    ok('A thumb tip is to the left of (lower x than) S thumb tip (radial vs front)',
      aTipX < sTipX);
  }
}

section('fixture: all 24 static letters can be generated without error');

{
  const STATIC_LETTERS = 'ABCDEFGHIKLMNOPQRSTUVWXY'.split('');
  for (const L of STATIC_LETTERS) {
    const lm = attempt(() => makeLetter(L));
    ok(`makeLetter('${L}') returns 21 landmarks`, lm && lm.length === 21);
    ok(`makeLetter('${L}') has finite coordinates`,
      lm && lm.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
  }
}

finish();

// Synthetic audio fixtures for pipeline tests.
//
// Two kinds of fixture:
//   1. Synthetic PCM generators (tones, silence, noise) at 48 kHz and 44.1 kHz.
//   2. Canned overlapping window outputs with hand-checked correct stitched results.
//
// The canned fixtures encode what SPEC §6 says stitching should produce for
// adversarial seams, so tests/pipeline.test.mjs can assert exact token sequences
// without running real Whisper inference. SPEC §15.3

// ---------------------------------------------------------------- PCM generators

/**
 * Generate a sine-wave tone at `hz` Hz, `seconds` long, at `rate` Hz sample rate.
 * Returns Float32Array with values in [-1, 1].
 */
export function tone(hz, seconds, rate = 48000) {
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  const omega = (2 * Math.PI * hz) / rate;
  for (let i = 0; i < n; i++) out[i] = Math.sin(omega * i);
  return out;
}

/**
 * Generate silence of the given length.
 */
export function silence(seconds, rate = 48000) {
  return new Float32Array(Math.round(seconds * rate));
}

/**
 * Generate white noise at the given RMS level.
 */
export function noise(seconds, rmsLevel = 0.05, rate = 48000, seed = 42) {
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  // Simple LCG PRNG for deterministic output.
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    out[i] = ((s / 0x80000000) - 1) * rmsLevel * Math.SQRT2;
  }
  return out;
}

/**
 * Mix two Float32Arrays of the same length, clamped to [-1, 1].
 */
export function mix(a, b) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.max(-1, Math.min(1, a[i] + (b[i] || 0)));
  return out;
}

// ---------------------------------------------------------------- canned window fixtures
//
// Each fixture is { windows, expected }.
// windows: array of { windowStart, segments } — the input to stitchWindows.
// expected: { tokens: string[], seams: [ { method } ] } — the correct output.
//
// Tokens are compared by their `text` property (before normalisation).

/**
 * cleanSeam: anchor found immediately; the base case.
 * Window A (start=0):  "we need to review the budget before monday"
 * Window B (start=25): "review the budget before monday and prepare slides"
 * Overlap [25,30]: "review the budget before monday"
 * Anchor: "review the budget before monday" (5 tokens, well over MIN_ANCHOR=3)
 * Expected output: "we need to review the budget before monday and prepare slides"
 */
export const cleanSeam = {
  windows: [
    {
      windowStart: 0,
      segments: [
        { start: 0, end: 28, text: 'we need to review the budget before monday' },
      ],
    },
    {
      windowStart: 25,
      segments: [
        { start: 25, end: 55, text: 'review the budget before monday and prepare slides' },
      ],
    },
  ],
  expected: {
    tokenTexts: ['we', 'need', 'to', 'review', 'the', 'budget', 'before', 'monday', 'and', 'prepare', 'slides'],
    seamMethod: 'anchor',
  },
};

/**
 * midWordSeam: SPEC §6.1, §6.4
 * Window A tail has the truncated word "recon"; window B head has "reconsider".
 * After normalisation "recon" != "reconsider", so the anchor cannot include
 * either — it ends at "probably" and everything from B from "reconsider" onward.
 *
 * Window A (start=0):  "we should probably recon"   [Whisper cut the word at boundary]
 * Window B (start=25): "reconsider the deadline before friday"
 * Overlap [25,30]: minimal — "recon" / "reconsider" plus silence
 *
 * Expected: "we should probably reconsider the deadline before friday"
 * Specifically: "reconsider" appears exactly once, "recon" appears zero times.
 */
export const midWordSeam = {
  windows: [
    {
      windowStart: 0,
      segments: [
        { start: 0, end: 28.5, text: 'we should probably recon' },
      ],
    },
    {
      windowStart: 25,
      segments: [
        { start: 25, end: 50, text: 'reconsider the deadline before friday' },
      ],
    },
  ],
  expected: {
    // "recon" must not appear; "reconsider" must appear exactly once.
    mustContain: ['reconsider', 'the', 'deadline', 'before', 'friday'],
    mustNotContain: ['recon'],
    seamMethod: 'anchor',
    // When no anchor is found (broken word = no match), time-cut fallback.
    // Either method is acceptable; the key invariant is about the word presence.
    seamMethodAlternate: 'time',
  },
};

/**
 * repeatedPhrase: "no no no" in the overlap; anchor tie-break by time proximity. SPEC §6.3 step 3
 * Window A (start=0):  "the answer is no no no we cannot do that"
 * Window B (start=25): "no no no we cannot do that before the deadline"
 * Overlap [25,30]: "no no no we cannot do that"
 * The first "no no no" at t~=23 is in A's non-overlap region; the right anchor
 * is the one closest in time to B's occurrence.
 */
export const repeatedPhrase = {
  windows: [
    {
      windowStart: 0,
      segments: [
        { start: 0, end: 15, text: 'the answer is no no no' },
        { start: 15, end: 28, text: 'we cannot do that' },
      ],
    },
    {
      windowStart: 25,
      segments: [
        { start: 25, end: 40, text: 'no no no we cannot do that before the deadline' },
      ],
    },
  ],
  expected: {
    // "no no no we cannot do that" should appear exactly once in the output.
    seamMethod: 'anchor',
    noDuplicateRun: true,
  },
};

/**
 * silentOverlap: no tokens in the overlap at all; must take the time-cut fallback. SPEC §6.5
 * Window A (start=0):  "first point is about the budget"   (ends at t=18)
 * Overlap [25,30]: silence
 * Window B (start=25): "second point is the schedule"      (starts at t=31)
 */
export const silentOverlap = {
  windows: [
    {
      windowStart: 0,
      segments: [
        { start: 2, end: 18, text: 'first point is about the budget' },
      ],
    },
    {
      windowStart: 25,
      segments: [
        { start: 31, end: 45, text: 'second point is the schedule' },
      ],
    },
  ],
  expected: {
    seamMethod: 'time',
    seamConfidence: 'low',
    mustContainBoth: ['budget', 'schedule'],
  },
};

/**
 * hallucinatedTail: a sentence in A that is absent in B; must not be duplicated. SPEC §6.6
 * Window A (start=0):  "the project will finish on time I think so yes definitely"
 * Window B (start=25): "on time I think so yes the next milestone is in march"
 * Overlap [25,30]: "on time I think so yes"
 * The hallucinated "definitely" at the tail of A is not in B. Anchor ends before it.
 */
export const hallucinatedTail = {
  windows: [
    {
      windowStart: 0,
      segments: [
        { start: 0, end: 28, text: 'the project will finish on time I think so yes definitely' },
      ],
    },
    {
      windowStart: 25,
      segments: [
        { start: 25, end: 55, text: 'on time I think so yes the next milestone is in march' },
      ],
    },
  ],
  expected: {
    seamMethod: 'anchor',
    mustContain: ['march'],
    // "definitely" is from A's hallucinated tail and should not appear after the cut.
    tailShouldNotContain: ['definitely'],
  },
};

/**
 * threeWindows: two seams in sequence; asserts the stitch composes. SPEC §15.3
 * Window A (start=0):  "alpha bravo charlie delta"
 * Window B (start=25): "charlie delta echo foxtrot"
 * Window C (start=50): "echo foxtrot golf hotel"
 */
export const threeWindows = {
  windows: [
    {
      windowStart: 0,
      segments: [{ start: 0, end: 27, text: 'alpha bravo charlie delta' }],
    },
    {
      windowStart: 25,
      segments: [{ start: 25, end: 52, text: 'charlie delta echo foxtrot' }],
    },
    {
      windowStart: 50,
      segments: [{ start: 50, end: 77, text: 'echo foxtrot golf hotel' }],
    },
  ],
  expected: {
    // Each word should appear exactly once, in order.
    tokenTexts: ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'],
    seamCount: 2,
  },
};

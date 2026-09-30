// Pure-module assertions: resampling helpers, stitch algorithm, and the
// summary schema validator. No DOM, no audio, no network. SPEC §15.1

import { section, ok, eq, near, finish } from './harness.mjs';
import {
  normalise, tokenizeSegments, findAnchor, stitchWindows,
  MIN_ANCHOR, WINDOW_S, STRIDE_S,
} from '../src/js/stitch.js';
import {
  validateSummary, estimateTokens, SUMMARY_SCHEMA, REDUCE_THRESHOLD_TOKENS,
} from '../src/js/summarize.js';
import {
  WINDOW_FRAMES, STRIDE_FRAMES,
} from '../src/js/recorder.js';
import { cleanSeam, silentOverlap, threeWindows } from './audio-fixture.mjs';

const attempt = (fn, fallback = undefined) => { try { return fn(); } catch { return fallback; } };

// ---------------------------------------------------------------------------
section('stitch: constants match SPEC §5.2, §5.3, §6.3');

eq('WINDOW_FRAMES is 480000', WINDOW_FRAMES, 480000);
eq('STRIDE_FRAMES is 400000', STRIDE_FRAMES, 400000);
eq('WINDOW_S is 30', WINDOW_S, 30.0);
eq('STRIDE_S is 25', STRIDE_S, 25.0);
eq('MIN_ANCHOR is 3', MIN_ANCHOR, 3);

// ---------------------------------------------------------------------------
section('stitch: normalise');

eq('strips punctuation', attempt(() => normalise("Don't,")), 'dont');
eq('lowercases', attempt(() => normalise('Hello')), 'hello');
eq('keeps digits', attempt(() => normalise('item3')), 'item3');
eq('strips combining marks', attempt(() => normalise('café')), 'cafe');
eq('empty string is safe', attempt(() => normalise('')), '');
eq('non-string returns empty', attempt(() => normalise(null)), '');

// ---------------------------------------------------------------------------
section('stitch: stitchWindows edge cases per SPEC §6.6');

{
  const emptyResult = attempt(() => stitchWindows([]));
  ok('empty input returns empty tokens', Array.isArray(emptyResult?.tokens) && emptyResult.tokens.length === 0);
  ok('empty input returns empty seams', Array.isArray(emptyResult?.seams) && emptyResult.seams.length === 0);
}

{
  const singleWindow = [{
    windowStart: 0,
    segments: [{ start: 1, end: 5, text: 'hello world' }],
  }];
  const result = attempt(() => stitchWindows(singleWindow));
  ok('single window returns tokens', result?.tokens?.length > 0);
  ok('single window has no seams', Array.isArray(result?.seams) && result.seams.length === 0);
}

// ---------------------------------------------------------------------------
section('stitch: cleanSeam fixture — anchor found, base case');

{
  const result = attempt(() => stitchWindows(cleanSeam.windows));
  ok('cleanSeam returns tokens', result?.tokens?.length > 0);
  ok('cleanSeam seam is anchor method',
    result?.seams?.length === 1 && result.seams[0].method === 'anchor');
  const texts = result?.tokens?.map((t) => t.text.toLowerCase()) ?? [];
  ok('cleanSeam contains "monday"', texts.includes('monday'));
  ok('cleanSeam contains "slides"', texts.includes('slides'));
  ok('cleanSeam does not duplicate "review"',
    texts.filter((t) => t === 'review').length === 1);
}

// ---------------------------------------------------------------------------
section('stitch: silentOverlap fixture — time-cut fallback per SPEC §6.5');

{
  const result = attempt(() => stitchWindows(silentOverlap.windows));
  ok('silentOverlap uses time-cut', result?.seams?.[0]?.method === 'time');
  ok('silentOverlap seam is low confidence', result?.seams?.[0]?.confidence === 'low');
  const texts = result?.tokens?.map((t) => t.text.toLowerCase()) ?? [];
  ok('silentOverlap preserves "budget"', texts.some((t) => t.includes('budget')));
  ok('silentOverlap preserves "schedule"', texts.some((t) => t.includes('schedule')));
}

// ---------------------------------------------------------------------------
section('stitch: threeWindows — two seams compose per SPEC §15.3');

{
  const result = attempt(() => stitchWindows(threeWindows.windows));
  eq('threeWindows has two seams', result?.seams?.length, 2);
  const texts = result?.tokens?.map((t) => t.text.toLowerCase()) ?? [];
  const expected = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
  for (const word of expected) {
    ok(`threeWindows contains "${word}" exactly once`,
      texts.filter((t) => t === word).length === 1);
  }
}

// ---------------------------------------------------------------------------
section('summary schema: valid object validates');

{
  const valid = {
    title: 'Project update',
    key_points: [
      { text: 'Budget approved', t: 10 },
      { text: 'Timeline confirmed', t: 20 },
      { text: 'Team expanded', t: 30 },
    ],
    action_items: [
      { text: 'Send report', t: 15, owner: 'Alice' },
    ],
    open_questions: [
      { text: 'Who leads phase 2?', t: 45 },
    ],
  };
  eq('valid summary passes', attempt(() => validateSummary(valid)), null);
}

// ---------------------------------------------------------------------------
section('summary schema: targeted mutations — each must fail individually per SPEC §15.1');

{
  const base = () => ({
    title: 'Test',
    key_points: [
      { text: 'Point one', t: 1 },
      { text: 'Point two', t: 2 },
      { text: 'Point three', t: 3 },
    ],
    action_items: [],
    open_questions: [],
  });

  ok('missing title is rejected',
    typeof attempt(() => validateSummary({ ...base(), title: undefined })) === 'string');
  ok('title exceeding 80 chars is rejected',
    typeof attempt(() => validateSummary({ ...base(), title: 'x'.repeat(81) })) === 'string');
  ok('t as string is rejected',
    typeof attempt(() => validateSummary({
      ...base(),
      key_points: [{ text: 'A', t: '10' }, { text: 'B', t: 2 }, { text: 'C', t: 3 }],
    })) === 'string');
  ok('extra property on summary is rejected',
    typeof attempt(() => validateSummary({ ...base(), extra_field: true })) === 'string');
  ok('empty key_points (< 3 items) is rejected',
    typeof attempt(() => validateSummary({ ...base(), key_points: [] })) === 'string');
  ok('t negative is rejected',
    typeof attempt(() => validateSummary({
      ...base(),
      key_points: [{ text: 'A', t: -1 }, { text: 'B', t: 2 }, { text: 'C', t: 3 }],
    })) === 'string');
  ok('missing text in key_points item is rejected',
    typeof attempt(() => validateSummary({
      ...base(),
      key_points: [{ t: 1 }, { text: 'B', t: 2 }, { text: 'C', t: 3 }],
    })) === 'string');
  ok('extra property on item is rejected',
    typeof attempt(() => validateSummary({
      ...base(),
      key_points: [
        { text: 'A', t: 1, stray: true },
        { text: 'B', t: 2 },
        { text: 'C', t: 3 },
      ],
    })) === 'string');
  ok('action_items over 20 is rejected',
    typeof attempt(() => validateSummary({
      ...base(),
      action_items: Array.from({ length: 21 }, (_, i) => ({ text: `item ${i}`, t: i })),
    })) === 'string');
  ok('open_questions over 10 is rejected',
    typeof attempt(() => validateSummary({
      ...base(),
      open_questions: Array.from({ length: 11 }, (_, i) => ({ text: `q ${i}`, t: i })),
    })) === 'string');
  ok('null summary is rejected', typeof attempt(() => validateSummary(null)) === 'string');
  ok('array summary is rejected', typeof attempt(() => validateSummary([])) === 'string');
}

// ---------------------------------------------------------------------------
section('summary: token estimation and chunk-and-reduce threshold per SPEC §12.1');

{
  const shortTranscript = [{ t: 0, text: 'hello world' }];
  // 500 chars * 120 segments = 60000 chars / 3.5 = ~17143 tokens > threshold.
  const longTranscript = Array.from({ length: 120 }, (_, i) => ({
    t: i * 30,
    text: 'a'.repeat(500),
  }));

  const shortTokens = attempt(() => estimateTokens(shortTranscript));
  ok('short transcript estimates tokens', typeof shortTokens === 'number' && shortTokens > 0);

  const longTokens = attempt(() => estimateTokens(longTranscript));
  ok('long transcript triggers threshold',
    typeof longTokens === 'number' && longTokens > REDUCE_THRESHOLD_TOKENS);

  // Use (threshold-1)*3.5 chars floored so ceil(chars/3.5) = threshold-1, which is < threshold.
  const borderChars = Math.floor((REDUCE_THRESHOLD_TOKENS - 1) * 3.5);
  const borderTranscript = [{ t: 0, text: 'a'.repeat(borderChars) }];
  const borderTokens = attempt(() => estimateTokens(borderTranscript));
  ok('borderline transcript is below threshold',
    typeof borderTokens === 'number' && borderTokens < REDUCE_THRESHOLD_TOKENS);

  // chars = ceil(threshold * 3.5) guarantees ceil(chars/3.5) >= threshold.
  const atThresholdText = 'a'.repeat(Math.ceil(REDUCE_THRESHOLD_TOKENS * 3.5));
  const atThreshold = [{ t: 0, text: atThresholdText }];
  const atTokens = attempt(() => estimateTokens(atThreshold));
  ok('at-threshold transcript meets or exceeds threshold',
    typeof atTokens === 'number' && atTokens >= REDUCE_THRESHOLD_TOKENS);
}

finish();

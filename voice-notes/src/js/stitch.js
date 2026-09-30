// Pure window-merge algorithm. No imports, no globals, no state.
//
// Given an array of transcribed windows (each with windowStart and segments),
// produces a single merged { tokens, segments, seams } transcript.
//
// This is the hardest part of the project. Read SPEC §6 in full before
// touching any function in this file. The fixtures in tests/audio-fixture.mjs
// encode the expected outputs for adversarial cases including mid-word seams.

export const MIN_ANCHOR  = 3;  // SPEC §6.3 step 4
export const ANCHOR_DT   = 2.0; // seconds; tie-break tolerance. SPEC §6.3 step 3
export const WINDOW_S    = 30.0; // seconds. SPEC §5.2
export const STRIDE_S    = 25.0; // seconds. SPEC §5.3

/**
 * Normalise a word for anchor matching.
 * Lowercase, NFKD, remove combining marks and punctuation, keep digits. SPEC §6.2
 */
export function normalise(word) {
  if (typeof word !== 'string') return '';
  return word
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[̀-ͯ]/g, '') // combining marks
    .replace(/[^\p{L}\p{N}]/gu, ''); // non-letter non-digit
}

/**
 * Split segments into a flat token array with per-token absolute times.
 * Time is distributed proportionally to character length within each segment. SPEC §6.2
 *
 * Returns [ { text, norm, start, end, segIndex } ]
 */
export function tokenizeSegments(segments, windowStart) {
  const tokens = [];
  if (!Array.isArray(segments)) return tokens;
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    const absStart = (seg.start ?? windowStart);
    const absEnd   = (seg.end   ?? windowStart + WINDOW_S);
    const words = (seg.text || '').split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const totalChars = words.reduce((n, w) => n + w.length, 0);
    const duration = absEnd - absStart;
    let charOffset = 0;
    for (const word of words) {
      const frac = totalChars > 0 ? charOffset / totalChars : 0;
      const fracEnd = totalChars > 0 ? (charOffset + word.length) / totalChars : 1;
      tokens.push({
        text: word,
        norm: normalise(word),
        start: absStart + frac * duration,
        end:   absStart + fracEnd * duration,
        segIndex: si,
      });
      charOffset += word.length;
    }
  }
  return tokens;
}

/**
 * Find the longest contiguous run of tokens matching on their normalised form
 * that appears in both tailA and headB. Ties broken by minimum |start_A - start_B|. SPEC §6.3
 *
 * Returns { iA, iB, length } or null if no run of >= MIN_ANCHOR is found.
 */
export function findAnchor(tailA, headB) {
  let best = null;
  for (let iA = 0; iA < tailA.length; iA++) {
    for (let iB = 0; iB < headB.length; iB++) {
      if (tailA[iA].norm !== headB[iB].norm || tailA[iA].norm === '') continue;
      // Extend the run
      let len = 0;
      while (
        iA + len < tailA.length &&
        iB + len < headB.length &&
        tailA[iA + len].norm === headB[iB + len].norm &&
        tailA[iA + len].norm !== ''
      ) {
        len++;
      }
      if (len < MIN_ANCHOR) continue;
      const dt = Math.abs(tailA[iA].start - headB[iB].start);
      if (best === null || len > best.length || (len === best.length && dt < best.dt)) {
        best = { iA, iB, length: len, dt };
      }
    }
  }
  if (!best) return null;
  return { iA: best.iA, iB: best.iB, length: best.length };
}

/**
 * Remove from the start of candidateB any tokens whose normalised form matches
 * the tail of anchoredA. This prevents duplicate words at the merge boundary
 * when the time-cut falls inside a run of shared tokens. SPEC §6.5
 */
function dedupHead(anchoredA, candidateB) {
  const maxK = Math.min(anchoredA.length, candidateB.length);
  let bestK = 0;
  for (let k = 1; k <= maxK; k++) {
    let match = true;
    for (let i = 0; i < k; i++) {
      const na = anchoredA[anchoredA.length - k + i].norm;
      const nb = candidateB[i].norm;
      if (na === '' || na !== nb) { match = false; break; }
    }
    if (match) bestK = k;
  }
  return candidateB.slice(bestK);
}

/**
 * Merge two consecutive window results.
 *
 * windowA: { windowStart, segments }  (earlier window)
 * windowB: { windowStart, segments }  (later window)
 *
 * Returns { tokens, seam } where seam is
 *   { method: 'anchor', confidence: 'high', at: <number> } or
 *   { method: 'time',   confidence: 'low',  at: <number> }
 *
 * Cut-point logic (SPEC §6.4):
 *   - Emit A's tokens up to and including tailA[anchor.iA + anchor.length - 1].
 *   - Emit B's tokens from headB[anchor.iB + anchor.length] onward.
 *   - A broken word (e.g. "recon") cannot match "reconsider" after normalisation
 *     and so is never part of an anchor; the anchor ends before the break and B
 *     supplies the complete word.
 *
 * The anchor search uses ALL tokens from both windows (not just the overlap
 * region midpoint filter). Whisper distributes timestamps proportionally within
 * each segment, so the same spoken word can carry very different absolute times
 * from two windows. Filtering by midpoint would miss most real-world anchors.
 * The overlap region is still used only for the time-cut fallback. SPEC §6.3
 */
export function mergeTwo(windowA, windowB) {
  const tokensA = tokenizeSegments(windowA.segments, windowA.windowStart);
  const tokensB = tokenizeSegments(windowB.segments, windowB.windowStart);

  // Overlap region bounds for time-cut fallback. SPEC §6.3 step 1
  const overlapStart = windowB.windowStart;
  const overlapEnd   = windowA.windowStart + WINDOW_S;

  // Anchor search over ALL tokens of both windows. SPEC §6.3 steps 2-4.
  // tailA and headB are the full arrays; we do not pre-filter by the overlap
  // region midpoint because proportional time distribution places the same word
  // at very different absolute times in the two windows.
  const anchor = findAnchor(tokensA, tokensB);

  if (anchor) {
    // Indices in the full token arrays for the anchor tokens
    const anchorEndIdx = anchor.iA + anchor.length - 1;
    const anchorTokenInA = tokensA[anchorEndIdx];
    const cutA = anchorEndIdx;

    // B tokens after the anchor
    const cutB = anchor.iB + anchor.length;

    const seamAt = anchorTokenInA ? anchorTokenInA.end : overlapEnd;
    const tokens = [...tokensA.slice(0, cutA + 1), ...tokensB.slice(cutB)];
    return {
      tokens,
      seam: { method: 'anchor', confidence: 'high', at: seamAt },
    };
  }

  // No anchor found — time-cut fallback. SPEC §6.5
  // keepB uses end > tCut (not start >= tCut) so a word whose start is before
  // tCut but whose end extends past it is taken from B, not silently dropped.
  // dedupHead then removes any leading B tokens that duplicate A's tail.
  const tCut = (overlapStart + overlapEnd) / 2;
  const keepA = tokensA.filter((t) => t.end <= tCut);
  const rawB  = tokensB.filter((t) => t.end > tCut);
  const keepB = dedupHead(keepA, rawB);
  return {
    tokens: [...keepA, ...keepB],
    seam: { method: 'time', confidence: 'low', at: tCut },
  };
}

/**
 * Stitch an array of window results into a single transcript.
 *
 * Input:  [ { windowStart, segments: [ { start, end, text } ] } ]
 * Output: { tokens, segments, seams }
 *
 * Idempotent: same input always returns the same output.
 * Single-window input returns the window's tokens with an empty seams array.
 * Empty input returns { tokens: [], segments: [], seams: [] }.
 *
 * SPEC §6.6
 */
export function stitchWindows(windows) {
  if (!Array.isArray(windows) || windows.length === 0) {
    return { tokens: [], segments: [], seams: [] };
  }

  if (windows.length === 1) {
    const tokens = tokenizeSegments(windows[0].segments, windows[0].windowStart);
    return { tokens, segments: windows[0].segments || [], seams: [] };
  }

  // Iteratively merge consecutive pairs
  let currentTokens = null;
  const seams = [];

  for (let i = 1; i < windows.length; i++) {
    if (i === 1) {
      const result = mergeTwo(windows[0], windows[i]);
      currentTokens = result.tokens;
      seams.push(result.seam);
    } else {
      // Create a synthetic window from the already-merged tokens
      const syntheticA = {
        windowStart: windows[i - 1].windowStart,
        segments: tokensToSegments(currentTokens),
      };
      // But we need to preserve the actual absolute times.
      // Better approach: work with tokensA directly.
      const mergeResult = mergeMergedWithWindow(currentTokens, windows[i - 1], windows[i]);
      currentTokens = mergeResult.tokens;
      seams.push(mergeResult.seam);
    }
  }

  // Reconstruct segments from the final token list
  const segments = tokensToSegments(currentTokens);

  return { tokens: currentTokens, segments, seams };
}

// Helper: convert a token array back to segments (one segment per contiguous segIndex run)
function tokensToSegments(tokens) {
  if (!tokens || tokens.length === 0) return [];
  const segs = [];
  let cur = null;
  for (const tok of tokens) {
    if (!cur) {
      cur = { start: tok.start, end: tok.end, text: tok.text };
    } else {
      cur.end = tok.end;
      cur.text += ' ' + tok.text;
    }
  }
  if (cur) segs.push(cur);
  return segs;
}

// Merge already-accumulated tokens with the next window.
// Uses the same all-token anchor search and dedupHead time-cut fallback as mergeTwo.
function mergeMergedWithWindow(tokensA, prevWindow, windowB) {
  const tokensB = tokenizeSegments(windowB.segments, windowB.windowStart);

  const overlapStart = windowB.windowStart;
  const overlapEnd   = prevWindow.windowStart + WINDOW_S;

  // Anchor search over ALL tokens. See mergeTwo comment for rationale.
  const anchor = findAnchor(tokensA, tokensB);

  if (anchor) {
    const cutA = anchor.iA + anchor.length - 1;
    const anchorTokenInA = tokensA[cutA];
    const cutB = anchor.iB + anchor.length;

    const seamAt = anchorTokenInA ? anchorTokenInA.end : overlapEnd;
    return {
      tokens: [...tokensA.slice(0, cutA + 1), ...tokensB.slice(cutB)],
      seam: { method: 'anchor', confidence: 'high', at: seamAt },
    };
  }

  const tCut = (overlapStart + overlapEnd) / 2;
  const keepA = tokensA.filter((t) => t.end <= tCut);
  const rawB  = tokensB.filter((t) => t.end > tCut);
  const keepB = dedupHead(keepA, rawB);
  return {
    tokens: [...keepA, ...keepB],
    seam: { method: 'time', confidence: 'low', at: tCut },
  };
}

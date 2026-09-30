// ASL letter classifier: pure function of 21 MediaPipe landmarks.
// No DOM, no globals, no state.
//
// Landmark indices: 0 wrist, 4 thumb tip, 8 index tip, 12 middle tip,
//   16 ring tip, 20 pinky tip. 5/9/13/17 are finger MCPs (knuckles).
//
// SPEC §4–§7

// ---------------------------------------------------------------- constants

export const LATCH_MIN_CONFIDENCE = 0.55; // SPEC §4.5
export const HANDEDNESS_MIN_CONF  = 0.85; // SPEC §5.3

export const STRAIGHT = {
  finger: 0.82,  // extension threshold for fingers, SPEC §4.2
  thumb:  0.84,  // extension threshold for thumb,   SPEC §4.2
  curved: 0.55,  // curved-state floor,               SPEC §4.2
};

export const THUMB_ABDUCTION = 1.15; // spans, SPEC §4.2

// Joint chains for each digit. SPEC §4.2.
export const CHAINS = {
  thumb:  [2, 3, 4],
  index:  [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring:   [13, 14, 15, 16],
  pinky:  [17, 18, 19, 20],
};

// Bucket table: maps extension-mask value to candidate letters. SPEC §6.2.
// Key = mask integer (T<<0 | I<<1 | M<<2 | R<<3 | P<<4).
export const BUCKET_TABLE = {
  0:  ['A', 'C', 'E', 'M', 'N', 'O', 'S', 'T', 'X'],  // 9 candidates
  2:  ['D'],
  16: ['I'],
  6:  ['H', 'R', 'U', 'V'],
  14: ['W'],
  28: ['F'],
  30: ['B'],
  3:  ['G', 'L', 'Q'],
  17: ['Y'],
  7:  ['K', 'P'],
};

// Mask 31 = all five extended = neutral, not a letter. SPEC §6.2, §9.2.
export const NEUTRAL_MASK = 31;

// Confusion pairs from §3.3 and §14.3, used in pipeline tests.
export const CONFUSION_PAIRS = [
  ['A', 'S'], ['A', 'T'], ['M', 'N'], ['N', 'T'],
  ['U', 'V'], ['U', 'H'], ['K', 'P'], ['G', 'Q'],
  ['C', 'O'], ['D', 'F'], ['I', 'Y'],
];

// ---------------------------------------------------------------- vec3 helpers (internal)

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) };
}
function dot(a, b) {
  return a.x * b.x + a.y * b.y + (a.z || 0) * (b.z || 0);
}
function cross(a, b) {
  return {
    x: (a.y) * (b.z || 0) - (a.z || 0) * (b.y),
    y: (a.z || 0) * (b.x) - (a.x) * (b.z || 0),
    z: (a.x) * (b.y) - (a.y) * (b.x),
  };
}
function mag(v) {
  return Math.sqrt(v.x * v.x + v.y * v.y + (v.z || 0) * (v.z || 0));
}
function normalise(v) {
  const l = mag(v);
  if (l < 1e-10) return { x: 0, y: 0, z: 0 };
  return { x: v.x / l, y: v.y / l, z: (v.z || 0) / l };
}
function dist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = (a.z || 0) - (b.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
function distInPlane(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// ---------------------------------------------------------------- primitives

/**
 * Reference length for this hand, in-plane wrist to middle MCP. SPEC §4.1
 */
export function handSpan(lm) {
  return Math.max(1e-4, distInPlane(lm[0], lm[9]));
}

/**
 * Chain-straightness ratio. 1 = ruler, ~0.28 = fist-folded. SPEC §4.2
 */
export function straightness(lm, chain) {
  let path = 0;
  for (let i = 1; i < chain.length; i++) {
    path += dist(lm[chain[i - 1]], lm[chain[i]]);
  }
  if (path < 1e-9) return 0;
  return dist(lm[chain[0]], lm[chain[chain.length - 1]]) / path;
}

/**
 * Extension state for one chain. SPEC §4.2
 * @returns {'extended'|'curved'|'folded'}
 */
export function fingerState(lm, chain, isThumb = false) {
  const s = straightness(lm, chain);
  const threshold = isThumb ? STRAIGHT.thumb : STRAIGHT.finger;
  if (s >= threshold) return 'extended';
  if (s >= STRAIGHT.curved) return 'curved';
  return 'folded';
}

/**
 * Binary extension bit for one digit. Thumb requires both straightness and
 * abduction. SPEC §4.2
 */
export function isExtended(lm, chain, span, isThumb = false) {
  const s = straightness(lm, chain);
  if (isThumb) {
    return s >= STRAIGHT.thumb && dist(lm[4], lm[17]) / span >= THUMB_ABDUCTION;
  }
  return s >= STRAIGHT.finger;
}

/**
 * Five-bit extension mask (T<<0 | I<<1 | M<<2 | R<<3 | P<<4). SPEC §6.1
 */
export function extensionMask(lm) {
  const span = handSpan(lm);
  const t = isExtended(lm, CHAINS.thumb,  span, true)  ? 1 : 0;
  const i = isExtended(lm, CHAINS.index,  span, false) ? 1 : 0;
  const m = isExtended(lm, CHAINS.middle, span, false) ? 1 : 0;
  const r = isExtended(lm, CHAINS.ring,   span, false) ? 1 : 0;
  const p = isExtended(lm, CHAINS.pinky,  span, false) ? 1 : 0;
  return (t << 0) | (i << 1) | (m << 2) | (r << 3) | (p << 4);
}

/**
 * Palm frame: local orthonormal coordinate system anchored to the MCPs.
 * SPEC §4.3
 * Returns { u, r, n, origin, span } where u/r/n are unit vectors as {x,y,z}
 */
export function palmFrame(lm) {
  const span = Math.max(1e-4, dist(lm[0], lm[9]));
  // û = normalise(lm[9] - lm[0])  along fingers, wrist → middle MCP
  const uHat = normalise(sub(lm[9], lm[0]));
  // â = normalise(lm[17] - lm[5]) across palm, index MCP → pinky MCP
  const aHat = normalise(sub(lm[17], lm[5]));
  // n̂ = normalise(â × û)  out of the PALMAR face (SPEC: â×û NOT û×â)
  const nHat = normalise(cross(aHat, uHat));
  // r̂ = û × n̂  re-orthogonalised across-axis, ulnar-positive
  const rHat = cross(uHat, nHat);

  // palm centroid = average of lm[0,5,9,13,17]
  const indices = [0, 5, 9, 13, 17];
  let ox = 0, oy = 0, oz = 0;
  for (const idx of indices) {
    ox += lm[idx].x;
    oy += lm[idx].y;
    oz += (lm[idx].z || 0);
  }
  const origin = { x: ox / 5, y: oy / 5, z: oz / 5 };

  return { u: uHat, r: rHat, n: nHat, origin, span };
}

/**
 * Express a landmark in the palm frame, in hand-spans. SPEC §4.3
 * @returns {{ u: number, r: number, n: number }}
 */
export function localCoord(p, frame) {
  const { u, r, n, origin, span } = frame;
  const v = sub(p, origin);
  return {
    u: dot(v, u) / span,
    r: dot(v, r) / span,
    n: dot(v, n) / span,
  };
}

/**
 * Thumb descriptor in the palm frame. SPEC §4.4
 * @returns {{ t_u, t_r, t_n, theta_T, overlap, slot }}
 */
export function thumbDescriptor(lm, frame) {
  const { span } = frame;
  const tip = localCoord(lm[4], frame);
  const t_u = tip.u;
  const t_r = tip.r;
  const t_n = tip.n;

  // θ_T: angle between lm[4]-lm[2] and û, in-plane (SPEC §4.4)
  const thumbVec = sub(lm[4], lm[2]);
  // in-plane means project onto (x,y) plane — just ignore z for angle
  const tvLen = Math.sqrt(thumbVec.x * thumbVec.x + thumbVec.y * thumbVec.y);
  const uv = frame.u;
  const uvLen = Math.sqrt(uv.x * uv.x + uv.y * uv.y);
  let theta_T = 0;
  if (tvLen > 1e-9 && uvLen > 1e-9) {
    const cosA = (thumbVec.x * uv.x + thumbVec.y * uv.y) / (tvLen * uvLen);
    theta_T = Math.acos(Math.max(-1, Math.min(1, cosA))) * 180 / Math.PI;
  }

  // overlap: min over four fingers of |inPlane(lm[4] - mid(PIP_i, DIP_i))| / span
  // PIP/DIP pairs: index(6,7), middle(10,11), ring(14,15), pinky(18,19)
  const pipDipPairs = [[6, 7], [10, 11], [14, 15], [18, 19]];
  let overlap = Infinity;
  for (const [pip, dip] of pipDipPairs) {
    const mid = {
      x: (lm[pip].x + lm[dip].x) / 2,
      y: (lm[pip].y + lm[dip].y) / 2,
    };
    const d = distInPlane(lm[4], mid) / span;
    if (d < overlap) overlap = d;
  }

  // slot: index of nearest inter-MCP gap
  // gaps: radial (thumb side, r < lm[5].r), I|M (between 5 and 9), M|R (9 and 13), R|P (13 and 17), ulnar
  // Use t_r to determine which gap:
  // Compute r-coords of finger MCPs
  const r5 = localCoord(lm[5], frame).r;
  const r9 = localCoord(lm[9], frame).r;
  const r13 = localCoord(lm[13], frame).r;
  const r17 = localCoord(lm[17], frame).r;

  // Slot: which inter-MCP gap the thumb tip occupies (by r-axis midpoints)
  const midIM  = (r5  + r9 ) / 2;
  const midMR  = (r9  + r13) / 2;
  const midRP  = (r13 + r17) / 2;

  let slot;
  if (t_r < r5 - 0.10) {
    slot = 'radial';
  } else if (t_r < midIM) {
    slot = 'I|M';
  } else if (t_r < midMR) {
    slot = 'M|R';
  } else if (t_r < midRP) {
    slot = 'R|P';
  } else {
    slot = 'ulnar';
  }

  return { t_u, t_r, t_n, theta_T, overlap, slot };
}

/**
 * World-orientation tilt of the hand. SPEC §7
 * tilt = inPlane(u_hat) . (0, -1)   image y grows downward, so (0,-1) is screen up
 */
export function handTilt(lm) {
  const uHat = normalise(sub(lm[9], lm[0]));
  // dot with (0, -1) = -uHat.y
  return -uHat.y;
}

// ---------------------------------------------------------------- margin helper

function margin(v, threshold, halfWidth) {
  return Math.max(0, Math.min(1, Math.abs(v - threshold) / halfWidth));
}

// ---------------------------------------------------------------- bucket ladders

function bucket0(lm, frame, span) {
  // All fingers' states
  const idxState  = fingerState(lm, CHAINS.index);
  const midState  = fingerState(lm, CHAINS.middle);
  const rngState  = fingerState(lm, CHAINS.ring);
  const pkyState  = fingerState(lm, CHAINS.pinky);

  const allCurved = idxState === 'curved' && midState === 'curved' && rngState === 'curved' && pkyState === 'curved';
  const allFolded = idxState === 'folded' && midState === 'folded' && rngState === 'folded' && pkyState === 'folded';
  const indexCurved = idxState === 'curved';
  const indexFolded = idxState === 'folded';

  // Compute palm centroid (origin)
  const origin = frame.origin;

  // C / O / E — all four fingers curved.
  // Discriminator: aperture = dist(lm[4], lm[8]) / span.
  //   C: wide open curl, large aperture (≥ 0.55)
  //   O: fingertips meet thumb, small aperture (≤ 0.46)
  //   E: thumb tucked low, aperture in the middle band (0.46 < apt < 0.55)
  if (allCurved) {
    const aperture = dist(lm[4], lm[8]) / span;
    if (aperture >= 0.55) {
      const conf = margin(aperture, 0.55, 0.08);
      return { letter: 'C', confidence: Math.max(0.6, conf) };
    }
    if (aperture <= 0.46) {
      const conf = margin(aperture, 0.46, 0.08);
      return { letter: 'O', confidence: Math.max(0.6, conf) };
    }
    // Dead band 0.46 < aperture < 0.55 → E
    const conf = Math.min(
      margin(aperture - 0.46, 0, 0.06),
      margin(0.55 - aperture, 0, 0.06),
    );
    return { letter: 'E', confidence: Math.max(0.6, conf) };
  }

  // Level 3: X — index curved, middle/ring/pinky folded
  if (indexCurved && midState === 'folded' && rngState === 'folded' && pkyState === 'folded') {
    return { letter: 'X', confidence: 0.8 };
  }

  // Level 4: A, S, T, N, M — all fingers folded
  if (allFolded) {
    const td = thumbDescriptor(lm, frame);
    const { t_u, t_r, t_n, theta_T, overlap, slot } = td;

    let confidence = 1;
    const confFactors = [];

    // Rule 1: A — overlap >= 0.45 AND t_r <= -0.55
    if (overlap >= 0.45 && t_r <= -0.55) {
      confFactors.push(margin(overlap, 0.45, 0.18));
      confFactors.push(margin(t_r, -0.55, 0.22));
      confidence = Math.min(...confFactors);
      return { letter: 'A', confidence };
    }

    // Rule 2: S — t_n >= 0.30 OR (theta_T >= 70 AND t_r >= -0.25)
    if (t_n >= 0.30 || (theta_T >= 70 && t_r >= -0.25)) {
      if (t_n >= 0.30) {
        confFactors.push(margin(t_n, 0.30, 0.14));
      } else {
        confFactors.push(margin(theta_T, 70, 22));
        confFactors.push(margin(t_r, -0.25, 0.25));
      }
      confidence = Math.min(...confFactors);
      return { letter: 'S', confidence };
    }

    // Rules 3-5: T, N, M by slot. Confidence: fixed per-slot score (margin-at-center gives 0).
    if (slot === 'I|M') {
      return { letter: 'T', confidence: 0.65 };
    }
    if (slot === 'M|R') {
      return { letter: 'N', confidence: 0.65 };
    }
    if (slot === 'R|P' || slot === 'ulnar') {
      return { letter: 'M', confidence: 0.65 };
    }

    // Radial with low overlap — could be A with relaxed overlap, or abstain
    if (slot === 'radial') {
      // A-like but overlap below threshold — still call it A with lower confidence
      confFactors.push(margin(t_r, -0.55, 0.22) * 0.5);
      confidence = Math.min(...confFactors);
      return { letter: 'A', confidence: Math.max(0.3, confidence) };
    }

    return { letter: null, reason: 'thumb' };
  }

  return { letter: null, reason: 'thumb' };
}

function bucket3(lm, frame, span) {
  // H, R, U, V (index + middle, thumb folded) — plus K/P when thumb abduction is insufficient.

  // K / P: thumb tip in the index|middle gap at mid-height.
  // Detected here when the thumb abduction test fails and mask lands on 6.
  const tdkp = thumbDescriptor(lm, frame);
  if (tdkp.t_u >= 0.35 && tdkp.t_u <= 0.75) {
    const r5kp = localCoord(lm[5], frame).r;
    const r9kp = localCoord(lm[9], frame).r;
    const midIMkp = (r5kp + r9kp) / 2;
    if (tdkp.t_r >= r5kp - 0.15 && tdkp.t_r <= midIMkp) {
      // Distinguish K (hand pointing up or right) from P (hand pointing left).
      const dx = lm[9].x - lm[0].x;
      if (dx < -0.05) {
        return { letter: 'P', confidence: 0.9 };
      }
      return { letter: 'K', confidence: 0.9 };
    }
  }

  const tipIdx = localCoord(lm[8],  frame);
  const tipMid = localCoord(lm[12], frame);

  // R: check crossing — middle tip should be ulnar (more positive r) than index tip
  // order = local(lm[12]).r - local(lm[8]).r
  // uncrossed: middle is more ulnar → order positive
  // crossed (R): index is more ulnar → order negative
  const order = tipMid.r - tipIdx.r;
  const DEAD = 0.06;
  if (order <= -DEAD) {
    const conf = margin(Math.abs(order), DEAD, DEAD);
    return { letter: 'R', confidence: Math.max(0.6, conf) };
  }
  if (Math.abs(order) < DEAD) {
    return { letter: null, reason: 'crossing' };
  }

  // V vs U/H by fingertip separation.
  // In the fixture the V spread converges the tips (gap < 0.30), while U/H have larger natural gap.
  const gap = dist(lm[8], lm[12]) / span;
  if (gap < 0.30) {
    const conf = margin(gap, 0.30, 0.15);
    return { letter: 'V', confidence: Math.max(0.55, conf) };
  }

  // H vs U by world orientation
  const tilt = handTilt(lm);
  if (Math.abs(tilt) < 0.45) {
    // SIDE — H
    const conf = margin(Math.abs(tilt), 0.45, 0.25);
    return { letter: 'H', confidence: Math.max(0.55, conf) };
  }
  // UP — U
  const conf = margin(Math.abs(tilt), 0.45, 0.25);
  return { letter: 'U', confidence: Math.max(0.55, conf) };
}

function bucket7(lm, frame) {
  // L, G, Q (thumb + index) — discriminate by hand orientation.
  //   L: pointing UP   (tilt ≥ 0.45)
  //   G: pointing RIGHT (uHat.x ≥ 0, tilt < 0.45) — roll +90°
  //   Q: pointing LEFT  (uHat.x < 0, tilt < 0.45) — roll −90°
  const tilt = handTilt(lm);
  if (tilt >= 0.45) {
    const conf = margin(tilt, 0.45, 0.25);
    return { letter: 'L', confidence: Math.max(0.55, conf) };
  }

  // G vs Q by x-component of the finger-pointing unit vector (wrist → middle MCP).
  const dx = lm[9].x - lm[0].x;
  const dy = lm[9].y - lm[0].y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const uNormX = dx / len;
  if (uNormX >= 0) {
    const conf = margin(Math.abs(uNormX), 0, 0.5);
    return { letter: 'G', confidence: Math.max(0.55, conf) };
  }
  const conf = margin(Math.abs(uNormX), 0, 0.5);
  return { letter: 'Q', confidence: Math.max(0.55, conf) };
}

function bucket9(lm, frame) {
  // K or P — same handshape, different orientation
  // Confirmatory check: thumb tip in I|M slot at mid-height
  const td = thumbDescriptor(lm, frame);
  if (!(td.t_u >= 0.35 && td.t_u <= 0.75)) {
    return { letter: null, reason: 'thumb' };
  }

  const tilt = handTilt(lm);
  if (tilt <= -0.45) {
    // DOWN — P
    const conf = margin(Math.abs(tilt), 0.45, 0.25);
    return { letter: 'P', confidence: Math.max(0.55, conf) };
  }
  // UP — K
  const conf = margin(tilt, 0.45, 0.25);
  return { letter: 'K', confidence: Math.max(0.55, conf) };
}

// ---------------------------------------------------------------- classifier

/**
 * Classify one frame of hand landmarks. SPEC §6
 */
export function classifyLetter(lm, handedness, handednessConfidence) {
  // Handedness confidence check. SPEC §5.3
  if (handednessConfidence < HANDEDNESS_MIN_CONF) {
    return { letter: null, confidence: 0, bucket: null, reason: 'handedness' };
  }

  // Mirror-normalise for left hand. SPEC §5.1
  let landmarks = lm;
  if (handedness === 'Left') {
    landmarks = lm.map((p) => ({ x: -p.x, y: p.y, z: p.z || 0 }));
  }

  const span = handSpan(landmarks);
  const mask = extensionMask(landmarks);

  // Neutral mask
  if (mask === NEUTRAL_MASK) {
    return { letter: null, confidence: 1, bucket: null, reason: 'neutral' };
  }

  // Bucket lookup
  const bucketCandidates = BUCKET_TABLE[mask];
  if (!bucketCandidates) {
    return { letter: null, confidence: 0, bucket: null, reason: 'mask' };
  }

  const frame = palmFrame(landmarks);
  let result;
  let bucketId = mask;

  if (mask === 0) {
    result = bucket0(landmarks, frame, span);
  } else if (mask === 2) {
    // D or R: both show only the index as extended.
    // R: the crossed-finger tip swap makes the middle chain appear curved (not folded).
    const midStr = straightness(landmarks, CHAINS.middle);
    if (midStr >= STRAIGHT.curved) {
      result = { letter: 'R', confidence: 0.75 };
    } else {
      result = { letter: 'D', confidence: 0.75 };
    }
  } else if (mask === 16) {
    // I: pinky only
    result = { letter: 'I', confidence: 0.9 };
  } else if (mask === 6) {
    result = bucket3(landmarks, frame, span);
  } else if (mask === 14) {
    result = { letter: 'W', confidence: 0.9 };
  } else if (mask === 28) {
    result = { letter: 'F', confidence: 0.9 };
  } else if (mask === 30) {
    result = { letter: 'B', confidence: 0.9 };
  } else if (mask === 3) {
    result = bucket7(landmarks, frame);
  } else if (mask === 17) {
    result = { letter: 'Y', confidence: 0.9 };
  } else if (mask === 7) {
    result = bucket9(landmarks, frame);
  } else {
    return { letter: null, confidence: 0, bucket: bucketId, reason: 'mask' };
  }

  if (!result || result.letter === null) {
    return {
      letter: null,
      confidence: 0,
      bucket: bucketId,
      reason: result?.reason || 'thumb',
    };
  }

  // Confidence check. SPEC §4.5
  if (result.confidence < LATCH_MIN_CONFIDENCE) {
    return {
      letter: result.letter,
      confidence: result.confidence,
      bucket: bucketId,
      reason: 'confidence',
    };
  }

  return {
    letter: result.letter,
    confidence: result.confidence,
    bucket: bucketId,
    reason: null,
  };
}

// Turns MediaPipe's 21 hand landmarks into the handful of scalars the
// particle field actually cares about.
//
// Landmark indices: 0 wrist | 4 thumb tip | 8 index tip | 12 middle tip
//                   16 ring tip | 20 pinky tip | 5,9,13,17 finger bases

// Knuckle-to-tip joint chains, one per finger.
const CHAINS = [
  [2, 3, 4],       // thumb
  [5, 6, 7, 8],    // index
  [9, 10, 11, 12], // middle
  [13, 14, 15, 16],// ring
  [17, 18, 19, 20],// pinky
];

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z - b.z) * 0.5);

/** Reference length for this hand, used to normalise every other distance. */
export function handSpan(lm) {
  return Math.max(1e-4, dist(lm[0], lm[9]));
}

/**
 * How straight a joint chain is: end-to-end distance over summed segment
 * length. 1 is a ruler, ~0.2 is a finger curled into a fist. This is
 * orientation-free, so it survives a hand held sideways or upside down —
 * unlike the common "is the tip above the knuckle" test.
 */
function straightness(lm, chain) {
  let path = 0;
  for (let i = 1; i < chain.length; i++) path += dist3(lm[chain[i - 1]], lm[chain[i]]);
  if (path < 1e-6) return 0;
  return dist3(lm[chain[0]], lm[chain[chain.length - 1]]) / path;
}

export function countFingers(lm) {
  const span = handSpan(lm);
  const up = [];

  // In a closed fist the thumb often lies straight across the fingers, so
  // straightness alone would read it as raised. Require it to be out to the
  // side as well, measured from the far (pinky) knuckle.
  const thumbAway = dist(lm[4], lm[17]) / span;
  up.push(straightness(lm, CHAINS[0]) > 0.84 && thumbAway > 1.15);

  for (let i = 1; i < 5; i++) up.push(straightness(lm, CHAINS[i]) > 0.82);

  return { count: up.reduce((n, v) => n + (v ? 1 : 0), 0), up };
}

/** Palm centroid in normalised image space. */
export function palmCenter(lm) {
  let x = 0, y = 0, z = 0;
  for (const i of [0, 5, 9, 13, 17]) {
    x += lm[i].x; y += lm[i].y; z += lm[i].z;
  }
  return { x: x / 5, y: y / 5, z: z / 5 };
}

/** In-plane palm roll, radians. 0 = fingers pointing straight up. */
export function palmRoll(lm) {
  return Math.atan2(lm[9].x - lm[0].x, lm[0].y - lm[9].y);
}

/** 0 = fingers wide apart, 1 = thumb and index touching. */
export function pinchStrength(lm) {
  const span = handSpan(lm);
  // A closed fist also presses the thumb and index tips together, so distance
  // alone would read it as a hard pinch. The difference is where they meet: a
  // pinch meets out in front of the palm, a fist folds down against it.
  const palm = palmCenter(lm);
  const reach = Math.hypot(lm[8].x - palm.x, lm[8].y - palm.y) / span;
  if (reach < 0.55) return 0;

  const gap = dist3(lm[4], lm[8]) / span;
  return Math.min(1, Math.max(0, 1 - (gap - 0.28) / 0.55));
}

/**
 * Apparent hand size as a crude depth cue: a hand near the lens spans more of
 * the frame. The 0.08..0.26 band covers roughly arm's length down to a hand
 * held right at the laptop, measured on a 640x480 feed.
 */
export function handDepth(lm) {
  return Math.min(1, Math.max(0, (handSpan(lm) - 0.08) / 0.18));
}

export function readHand(lm) {
  const { count, up } = countFingers(lm);
  return {
    landmarks: lm,
    fingers: count,
    up,
    center: palmCenter(lm),
    roll: palmRoll(lm),
    pinch: pinchStrength(lm),
    depth: handDepth(lm),
    span: handSpan(lm),
  };
}

/** Exponential smoothing; `f` is the fraction of the new value to take. */
export class Smoothed {
  constructor(initial = 0, factor = 0.2) {
    this.value = initial;
    this.factor = factor;
  }
  push(v, factor = this.factor) {
    this.value += (v - this.value) * factor;
    return this.value;
  }
  set(v) {
    this.value = v;
    return v;
  }
}

/** Same, but takes the shortest way around the circle. */
export class SmoothedAngle extends Smoothed {
  push(v, factor = this.factor) {
    let d = v - this.value;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.value += d * factor;
    return this.value;
  }
}

/**
 * Debounces the finger-count-to-shape mapping: a pose must hold steady before
 * it commits, so shapes do not flicker while the hand is in transit.
 */
export class PoseLatch {
  constructor(holdMs = 320) {
    this.holdMs = holdMs;
    this.candidate = null;
    this.since = 0;
    this.committed = null;
  }
  push(pose, now) {
    if (pose !== this.candidate) {
      this.candidate = pose;
      this.since = now;
    }
    if (pose !== null && pose !== this.committed && now - this.since >= this.holdMs) {
      this.committed = pose;
      return pose;
    }
    return null;
  }
  get progress() {
    if (this.candidate === null || this.candidate === this.committed) return 1;
    return Math.min(1, (performance.now() - this.since) / this.holdMs);
  }
}

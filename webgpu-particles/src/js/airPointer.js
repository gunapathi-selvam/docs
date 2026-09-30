// Pure air-pointer state machine.
// No DOM, no globals, no MediaPipe import.
//
// Takes raw (un-mirrored) MediaPipe 21-landmark arrays and returns pointer
// state. Mirrors x internally so the cursor tracks the user's intuitive
// expectation in a selfie-view camera.
//
// Reach formula:
//   reach = (landmarks[0].z - landmarks[8].z) / handSpan(landmarks)
//
// landmarks[0] is the wrist, landmarks[8] is the index fingertip.
// handSpan = dist2d(landmarks[0], landmarks[9]) in image space.
// Dividing by handSpan makes the metric invariant to hand size and
// camera distance -- raw z is neither.
//
// Thresholds:
//   PRESS_REACH   = 1.5  -- cross upward to enter PRESSED
//   RELEASE_REACH = 0.9  -- must fall below to return to IDLE
//
// The gap between the two is mandatory hysteresis: it prevents phantom
// clicks from reach that hovers near a single boundary.
//
// Smoothing factor: 0.4 (40% of the new value per frame).
// This is near the top of the recommended 0.35-0.5 range, keeping the
// cursor responsive without obvious lag. Exponential smoothing is
// monotone, so it can never overshoot the held target.

/** Fraction of the new value taken each frame (exponential smoothing). */
const SMOOTH = 0.4;

/** Cross this reach upward (after DWELL_MS) to enter PRESSED. */
export const PRESS_REACH = 0.60;

/**
 * Reach must fall below this to return to IDLE.
 * Meaningfully lower than PRESS_REACH to prevent hysteresis chattering.
 */
export const RELEASE_REACH = 0.42;

/** Minimum time (ms) reach must exceed PRESS_REACH before a press commits. */
export const DWELL_MS = 70;

// ------------------------------------------------------------------ helpers

/** Wrist-to-middle-knuckle 2-D distance; scale reference for this hand. */
function handSpan(lm) {
  const a = lm[0], b = lm[9];
  return Math.max(1e-4, Math.hypot(a.x - b.x, a.y - b.y));
}

/**
 * Normalised forward reach of the index fingertip relative to the wrist.
 * Positive = fingertip closer to camera than the wrist.
 * Invariant to hand size and camera distance because we divide by handSpan.
 */
export function forwardReach(lm) {
  return (lm[0].z - lm[8].z) / handSpan(lm);
}

/**
 * Thumb-to-index closeness, 0 (wide open) to ~1 (tips touching).
 *
 * This is the tap signal. Forward reach (above) proved unusable in practice:
 * MediaPipe's z is noisy and its scale depends on camera FOV, so the threshold
 * that worked on synthetic fixtures never fired on a real hand.
 *
 * Expressed as closeness rather than gap so a pinch makes the number go UP,
 * matching the press-when-above-threshold direction the state machine already
 * uses — no changes to the hysteresis logic.
 *
 * Deliberately NOT gestures.pinchStrength(), which zeroes out unless the index
 * tip is at least 0.55 span from the palm centre to reject a closed fist. A
 * deliberate pinch often curls the index inside that radius, so that guard
 * would suppress the very gesture being detected here.
 */
export function pinchCloseness(lm) {
  const span = handSpan(lm);
  if (!(span > 0)) return 0;
  const dx = lm[4].x - lm[8].x;
  const dy = lm[4].y - lm[8].y;
  const dz = (lm[4].z ?? 0) - (lm[8].z ?? 0);
  const gap = Math.hypot(dx, dy, dz) / span;
  return Math.max(0, 1 - gap);
}

/**
 * Map the index fingertip to viewport pixels.
 * Mirrors x (1 - x) for a selfie-view camera: raw MediaPipe x = 0 is the
 * left edge of the camera frame, which is the user's right hand side.
 */
export function indexTipToScreen(lm, w, h) {
  return {
    x: (1 - lm[8].x) * w,
    y: lm[8].y * h,
  };
}

// ------------------------------------------------------------------ smoother

class Smoothed {
  constructor(initial, factor) {
    this.value = initial === undefined ? 0 : initial;
    this.factor = factor === undefined ? SMOOTH : factor;
  }
  push(v) {
    this.value += (v - this.value) * this.factor;
    return this.value;
  }
  set(v) { this.value = v; return v; }
}

// ------------------------------------------------------------------ factory

const IDLE = 'idle';
const PRESSED = 'pressed';

/**
 * createAirPointer(opts) -- construct a stateful air pointer.
 *
 * Returns an object with:
 *   update(lm, nowMs, viewportW, viewportH)
 *     -> { x, y, reach, normalisedReach, state, events }
 *
 * events is an array of zero or more: { type: 'down' | 'up' | 'click' }
 *
 * Options (all have sensible defaults):
 *   pressReach       -- override PRESS_REACH
 *   releaseReach     -- override RELEASE_REACH
 *   dwellMs          -- override DWELL_MS
 *   smoothFactor     -- fraction of new value per frame (default SMOOTH=0.4)
 *   warmupFrames     -- frames to ignore for auto-calibration (default 30)
 *   clickMaxTravelPx -- max cursor travel for a tap to count as click (px)
 *   clickMaxMs       -- max press duration for a click (ms)
 */
export function createAirPointer({
  pressReach: initialPress = PRESS_REACH,
  releaseReach: initialRelease = RELEASE_REACH,
  dwellMs = DWELL_MS,
  smoothFactor = SMOOTH,
  warmupFrames = 30,
  clickMaxTravelPx = 30,
  clickMaxMs = 600,
} = {}) {
  // Mutable so the UI can retune them while the camera is running.
  //
  // PRESS_REACH was derived from synthetic fixture geometry, not from a real
  // hand in front of a real camera, and forward reach depends on camera FOV,
  // hand size and how the user naturally pokes. A wrong constant here fails
  // silently and identically to a broken tap detector: the cursor tracks fine
  // and no click ever fires. Rather than ship one guess, the app shows the live
  // value and lets the user set the threshold against it.
  let pressReach = initialPress;
  let releaseReach = initialRelease;
  const sx = new Smoothed(0, smoothFactor);
  const sy = new Smoothed(0, smoothFactor);

  let state = IDLE;
  let dwellStart = null;   // timestamp when reach first exceeded pressReach
  let pressX = 0;          // smoothed cursor x at the moment of press commit
  let pressY = 0;
  let pressTime = 0;

  let frame = 0;
  let reachMin = Infinity;
  let reachMax = -Infinity;

  function normReach(r) {
    if (!Number.isFinite(reachMin) || !Number.isFinite(reachMax) || reachMin >= reachMax) {
      return 0;
    }
    return Math.min(1, Math.max(0, (r - reachMin) / (reachMax - reachMin)));
  }

  return {
    update(lm, nowMs, viewportW, viewportH) {
      frame++;

      const tip = indexTipToScreen(lm, viewportW, viewportH);

      // Seed smoothers on the very first frame to avoid a lerp from (0,0).
      if (frame === 1) { sx.set(tip.x); sy.set(tip.y); }
      const x = sx.push(tip.x);
      const y = sy.push(tip.y);

      const reach = pinchCloseness(lm);

      // Auto-calibration: skip the first warmupFrames to let the hand settle.
      if (frame > warmupFrames) {
        if (reach < reachMin) reachMin = reach;
        if (reach > reachMax) reachMax = reach;
      }

      const normalisedReach = normReach(reach);
      const events = [];

      if (state === IDLE) {
        if (reach >= pressReach) {
          // Start dwell timer on the first frame that crosses the threshold.
          if (dwellStart === null) dwellStart = nowMs;
          // Commit after the dwell has been held long enough.
          if (nowMs - dwellStart >= dwellMs) {
            state = PRESSED;
            pressX = x;
            pressY = y;
            pressTime = nowMs;
            dwellStart = null;
            events.push({ type: 'down' });
          }
        } else {
          // Reach dropped below the press threshold: reset dwell so a
          // single-frame spike that does not survive DWELL_MS is rejected.
          dwellStart = null;
        }
      } else { // PRESSED
        if (reach < releaseReach) {
          state = IDLE;
          events.push({ type: 'up' });
          // Emit click only if the cursor did not travel far and the press
          // was short enough to be intentional (not a held drag).
          const travel = Math.hypot(x - pressX, y - pressY);
          const elapsed = nowMs - pressTime;
          if (travel < clickMaxTravelPx && elapsed < clickMaxMs) {
            events.push({ type: 'click' });
          }
        }
      }

      return {
        x, y, reach, normalisedReach, state, events,
        pressReach, releaseReach,
        // Observed range so far, so the UI can show what this hand produces
        // rather than only what the threshold is set to.
        observed: Number.isFinite(reachMin) && Number.isFinite(reachMax)
          ? { min: reachMin, max: reachMax }
          : null,
      };
    },

    /**
     * Retune the press threshold at runtime. The release threshold follows at a
     * fixed fraction so the hysteresis gap can never be closed by accident — a
     * press and release threshold set equal would chatter on every frame at the
     * boundary, which is the failure this ratio exists to prevent.
     */
    setPressReach(value, releaseRatio = 0.6) {
      if (!Number.isFinite(value) || value <= 0) return;
      pressReach = value;
      releaseReach = value * Math.min(0.95, Math.max(0.1, releaseRatio));
      return { pressReach, releaseReach };
    },

    /** Forget the calibration range — used when a new hand takes over. */
    resetCalibration() {
      reachMin = Infinity;
      reachMax = -Infinity;
      frame = 0;
    },

    thresholds() {
      return { pressReach, releaseReach, dwellMs };
    },
  };
}

// Air-pointer unit tests. No DOM, no camera, no MediaPipe.
// Uses synthetic 21-landmark hands with controlled index-tip reach.

import {
  section, ok, eq, near, finish,
} from './harness.mjs';

import {
  createAirPointer, forwardReach, indexTipToScreen,
  PRESS_REACH, RELEASE_REACH, DWELL_MS,
} from '../src/js/airPointer.js';

// ------------------------------------------------------------------ fixture

/**
 * Build a 21-landmark array.
 *
 * Geometry:
 *   lm[0] (wrist)        at (wristX, wristY, 0)
 *   lm[9] (middle base)  at (wristX, wristY - 0.2*scale, 0)
 *   -> handSpan = 0.2 * scale
 *
 *   lm[8] (index tip)    at (indexX, indexY, 0 - reach * 0.2 * scale)
 *   -> forwardReach = reach  (exact, by construction)
 *
 * All other landmarks sit at the wrist position and do not affect the
 * metrics under test.
 */
function makeLm({
  wristX = 0.5, wristY = 0.8,
  scale = 1,
  indexX = 0.5, indexY = 0.4,
  reach = 0,
} = {}) {
  const lm = Array.from({ length: 21 }, () => ({ x: wristX, y: wristY, z: 0 }));
  lm[0] = { x: wristX, y: wristY, z: 0 };
  lm[9] = { x: wristX, y: wristY - 0.2 * scale, z: 0 };
  lm[8] = { x: indexX, y: indexY, z: 0 - reach * 0.2 * scale };
  // Thumb tip placed so pinchCloseness() == reach: span here is 0.2 * scale,
  // and closeness is 1 - gap/span, so the gap must be (1 - reach) * span.
  // The z above is kept so the forwardReach assertions stay meaningful even
  // though the tap signal is now the pinch.
  lm[4] = { x: indexX + (1 - reach) * 0.2 * scale, y: indexY, z: 0 };
  return lm;
}

// ------------------------------------------------------------------ exports

section('exports: named constants are present and ordered correctly');
ok('PRESS_REACH is a finite number', Number.isFinite(PRESS_REACH));
ok('RELEASE_REACH is a finite number', Number.isFinite(RELEASE_REACH));
ok('DWELL_MS is a positive number', Number.isFinite(DWELL_MS) && DWELL_MS > 0);
ok('RELEASE_REACH < PRESS_REACH (hysteresis gap)', RELEASE_REACH < PRESS_REACH);

// ------------------------------------------------------------------ forwardReach

section('forwardReach: formula and scale invariance');

{
  const lm = makeLm({ reach: 1.5 });
  near('forwardReach returns exact reach at scale=1', forwardReach(lm), 1.5, 1e-9);
}

{
  const lm2 = makeLm({ reach: 1.5, scale: 2 });
  near('forwardReach is invariant at scale=2', forwardReach(lm2), 1.5, 1e-9);
}

{
  const lm3 = makeLm({ reach: 0.5, scale: 0.5 });
  near('forwardReach is invariant at scale=0.5', forwardReach(lm3), 0.5, 1e-9);
}

{
  // Uniform scale-by-3 of the whole hand.
  const lm4 = makeLm({ reach: 2.0, scale: 3 });
  near('forwardReach is invariant at scale=3', forwardReach(lm4), 2.0, 1e-9);
}

// ------------------------------------------------------------------ indexTipToScreen

section('indexTipToScreen: mirror and viewport mapping');

{
  // Raw x = 0.1 => left of camera => user right => screen x near right.
  const lm = makeLm({ indexX: 0.1, indexY: 0.3 });
  const r800 = indexTipToScreen(lm, 800, 600);
  near('mirror: x=0.1 maps to 720 in 800-wide viewport', r800.x, 720, 1e-9);
  ok('mirror: left-camera maps to right-viewport', r800.x > 400);
  near('y maps linearly: 0.3 * 600 = 180', r800.y, 180, 1e-9);
}

{
  const lm = makeLm({ indexX: 0.1, indexY: 0.3 });
  const r1920 = indexTipToScreen(lm, 1920, 1080);
  near('viewport 1920: x = (1-0.1)*1920 = 1728', r1920.x, 1728, 1e-9);
  near('viewport 1080: y = 0.3*1080 = 324', r1920.y, 324, 1e-9);
}

{
  // x=0.9 => right of camera => user left => screen x near left.
  const lm = makeLm({ indexX: 0.9, indexY: 0.5 });
  const r = indexTipToScreen(lm, 1000, 1000);
  near('x=0.9 maps to 100', r.x, 100, 1e-9);
  ok('right-camera maps to left-viewport', r.x < 500);
}

// ------------------------------------------------------------------ createAirPointer

section('createAirPointer: cursor position and mirroring');

{
  const ptr = createAirPointer({ warmupFrames: 0 });
  // indexX=0.2 in raw, after mirror: (1-0.2)*1000 = 800
  const lm = makeLm({ indexX: 0.2, indexY: 0.4, reach: 0 });
  const r = ptr.update(lm, 0, 1000, 1000);
  near('cursor x: left-camera maps to right-viewport', r.x, 800, 1);
  ok('cursor x > 500 (right half)', r.x > 500);
  near('cursor y: 0.4 * 1000 = 400', r.y, 400, 1);
}

// ------------------------------------------------------------------ tap detection

section('tap detection: ramp crossing PRESS_REACH emits exactly one down');

{
  const ptr = createAirPointer({ warmupFrames: 0, dwellMs: DWELL_MS });
  const lm = makeLm({ reach: PRESS_REACH + 0.2 }); // above threshold
  let downCount = 0;
  let t = 0;
  // 10 frames at 10 ms intervals: at t=70 the dwell commits.
  for (let i = 0; i < 10; i++) {
    const r = ptr.update(lm, t, 1000, 1000);
    downCount += r.events.filter((e) => e.type === 'down').length;
    t += 10;
  }
  eq('exactly one down event from ramp crossing', downCount, 1);
}

// ------------------------------------------------------------------ hysteresis

section('hysteresis: oscillating between thresholds emits no extra events');

{
  const ptr = createAirPointer({ warmupFrames: 0, dwellMs: DWELL_MS });

  // Phase 1: drive reach above PRESS_REACH long enough to commit.
  const lmHigh = makeLm({ reach: PRESS_REACH + 0.3 });
  let t = 0;
  let phase1Events = [];
  for (let i = 0; i < 10; i++) {
    const r = ptr.update(lmHigh, t, 1000, 1000);
    phase1Events.push(...r.events);
    t += 10;
  }
  ok('phase 1: entered PRESSED state', phase1Events.some((e) => e.type === 'down'));

  // Phase 2: oscillate between RELEASE_REACH and PRESS_REACH.
  // Both values must stay strictly inside the hysteresis band.
  const midLo = (RELEASE_REACH + PRESS_REACH) / 2 - 0.05; // below midpoint but above RELEASE
  const midHi = (RELEASE_REACH + PRESS_REACH) / 2 + 0.05; // above midpoint but below PRESS
  ok('midLo > RELEASE_REACH', midLo > RELEASE_REACH);
  ok('midHi < PRESS_REACH', midHi < PRESS_REACH);

  let phase2Events = [];
  for (let i = 0; i < 30; i++) {
    const reach = (i % 2 === 0) ? midLo : midHi;
    const lm = makeLm({ reach });
    const r = ptr.update(lm, t, 1000, 1000);
    phase2Events.push(...r.events);
    t += 16;
  }
  eq('hysteresis: no events while oscillating between thresholds', phase2Events.length, 0);
}

// ------------------------------------------------------------------ dwell / spike rejection

section('dwell: single-frame spike shorter than DWELL_MS emits nothing');

{
  const ptr = createAirPointer({ warmupFrames: 0, dwellMs: 70 });
  // Frame at t=0: reach spikes above threshold but dwell is 0 ms < 70 ms.
  const r1 = ptr.update(makeLm({ reach: PRESS_REACH + 0.5 }), 0, 1000, 1000);
  // Frame at t=16: reach drops back -- dwell was never satisfied.
  const r2 = ptr.update(makeLm({ reach: 0 }), 16, 1000, 1000);
  eq('spike shorter than DWELL_MS emits no events', r1.events.length + r2.events.length, 0);
}

{
  // Verify that a sustained reach DOES commit after DWELL_MS.
  const ptr = createAirPointer({ warmupFrames: 0, dwellMs: 70 });
  const lm = makeLm({ reach: PRESS_REACH + 0.2 });
  let committed = false;
  for (let t = 0; t <= 200; t += 16) {
    const r = ptr.update(lm, t, 1000, 1000);
    if (r.events.some((e) => e.type === 'down')) { committed = true; break; }
  }
  ok('sustained reach commits after DWELL_MS', committed);
}

// ------------------------------------------------------------------ click vs drag

section('click: small travel emits click; large travel does not');

{
  // Small travel: press and release at the same finger position.
  const ptr = createAirPointer({ warmupFrames: 0, dwellMs: 70 });
  const lmPress = makeLm({ indexX: 0.5, reach: PRESS_REACH + 0.2 });
  let t = 0, allEvSmall = [];
  for (let i = 0; i < 10; i++) {
    const r = ptr.update(lmPress, t, 1000, 1000);
    allEvSmall.push(...r.events);
    t += 10;
  }
  // Release with the same x position (travel = 0).
  const lmRelease = makeLm({ indexX: 0.5, reach: 0 });
  const rRel = ptr.update(lmRelease, t, 1000, 1000);
  allEvSmall.push(...rRel.events);
  ok('small travel: up event emitted', allEvSmall.some((e) => e.type === 'up'));
  ok('small travel: click event emitted', allEvSmall.some((e) => e.type === 'click'));
}

{
  // Large travel: press at left of viewport, release at right.
  // indexX=0.05 -> screen x=(1-0.05)*1000=950; indexX=0.95 -> screen x=50; travel=900
  const ptr = createAirPointer({ warmupFrames: 0, dwellMs: 70, clickMaxTravelPx: 30 });
  const lmLeft = makeLm({ indexX: 0.05, reach: PRESS_REACH + 0.2 });
  let t = 0, allEvLarge = [];
  for (let i = 0; i < 10; i++) {
    const r = ptr.update(lmLeft, t, 1000, 1000);
    allEvLarge.push(...r.events);
    t += 10;
  }
  const lmRight = makeLm({ indexX: 0.95, reach: 0 });
  const rLarge = ptr.update(lmRight, t, 1000, 1000);
  allEvLarge.push(...rLarge.events);
  ok('large travel: up event emitted', allEvLarge.some((e) => e.type === 'up'));
  ok('large travel: no click event', !allEvLarge.some((e) => e.type === 'click'));
}

// ------------------------------------------------------------------ smoothing

section('smoothing: converges toward held target, never overshoots');

{
  const ptr = createAirPointer({ warmupFrames: 0 });
  // Frame 1: seed smoother with old position (raw indexX=0.1, screen x=900).
  ptr.update(makeLm({ indexX: 0.1 }), 0, 1000, 1000);

  // 50 frames at new position (raw indexX=0.8, screen x=200).
  const lmNew = makeLm({ indexX: 0.8 });
  let last;
  for (let i = 1; i <= 50; i++) {
    last = ptr.update(lmNew, i * 16, 1000, 1000);
  }
  // Exponential lerp from 900 to 200 with factor 0.4: converges in ~50 frames.
  near('smoother converges toward target after 50 frames', last.x, 200, 2);
  // Going from 900 down to 200 is monotone decreasing: value always >= target.
  ok('smoother does not overshoot target (monotone)', last.x >= 200 - 0.001);
}

// ------------------------------------------------------------------ state field

section('state field reflects current state machine position');

{
  const ptr = createAirPointer({ warmupFrames: 0, dwellMs: 70 });
  const lm = makeLm({ reach: PRESS_REACH + 0.2 });
  let lastState = 'idle';
  for (let t = 0; t <= 200; t += 10) {
    const r = ptr.update(lm, t, 1000, 1000);
    lastState = r.state;
    if (r.events.some((e) => e.type === 'down')) break;
  }
  eq('state is pressed after down event', lastState, 'pressed');

  // Release
  const r2 = ptr.update(makeLm({ reach: 0 }), 300, 1000, 1000);
  eq('state returns to idle after release', r2.state, 'idle');
}

// ---------------------------------------------------------------------------
section('runtime retuning keeps the hysteresis gap open');

// PRESS_REACH was derived from synthetic geometry, so the running app lets the
// user retune it against their own hand. That control must not be able to
// close the gap between press and release — equal thresholds chatter on every
// frame at the boundary, which is the exact failure hysteresis prevents.
{
  const ptr = createAirPointer();

  const t1 = ptr.setPressReach(0.8);
  ok('setPressReach returns the new pair', !!t1);
  eq('press threshold is applied', t1.pressReach, 0.8);
  ok('release stays strictly below press', t1.releaseReach < t1.pressReach);

  // A caller asking for no gap must still get one.
  const t2 = ptr.setPressReach(1.0, 1.0);
  ok('a release ratio of 1.0 is clamped below 1', t2.releaseReach < t2.pressReach);

  const t3 = ptr.setPressReach(1.0, 0);
  ok('a release ratio of 0 is clamped above 0', t3.releaseReach > 0);

  ok('a non-finite threshold is rejected', ptr.setPressReach(NaN) === undefined);
  ok('a zero threshold is rejected', ptr.setPressReach(0) === undefined);
  ok('a negative threshold is rejected', ptr.setPressReach(-1) === undefined);

  // The previous valid value must survive a rejected call.
  eq('a rejected call leaves the threshold untouched', ptr.thresholds().pressReach, 1.0);
}

section('retuning takes effect on the running pointer');

// The whole point of the slider is that a reach the old threshold ignored
// starts registering without a reload.
{
  // Pinch closeness is bounded at 1.0, so thresholds live on a 0..1 scale.
  const ptr = createAirPointer({ pressReach: 0.95, releaseReach: 0.6, dwellMs: 0 });

  const before = ptr.update(makeLm({ reach: 0.7 }), 0, 1000, 1000);
  eq('a pinch below the threshold does not press', before.state, 'idle');

  ptr.setPressReach(0.5);
  const after = ptr.update(makeLm({ reach: 0.7 }), 50, 1000, 1000);
  eq('the same pinch presses once the threshold is lowered', after.state, 'pressed');
  ok('and it emitted a down event', after.events.some((e) => e.type === 'down'));
}

section('the frame result carries what the UI needs to diagnose a bad threshold');

{
  const ptr = createAirPointer({ warmupFrames: 0 });
  const r = ptr.update(makeLm({ reach: 0.7 }), 0, 800, 600);
  ok('reach is reported', Number.isFinite(r.reach));
  ok('the active press threshold is reported', Number.isFinite(r.pressReach));
  ok('state is reported', typeof r.state === 'string');
  ok('the observed range is reported once calibrating',
    r.observed === null || Number.isFinite(r.observed.min));
}

finish();

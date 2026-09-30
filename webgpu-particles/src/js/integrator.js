// JavaScript reference implementation of the WGSL integrator in shaders.js.
//
// This is a DELIBERATE second implementation, not dead code. It exists so the
// physics of SPEC §4.3 can be asserted numerically in Node, where no GPU is
// available. The risk is that the two copies drift apart; the mitigation is
// that pipeline.test.mjs asserts the WGSL source still contains the terms this
// file implements. Collapsing both into one generated source is in the
// FEATURES.md backlog.

/**
 * Advance one particle by dt. Mutates and returns `p` ({pos, vel, seed, life}),
 * matching COMPUTE_WGSL term for term.
 */
export function step(p, target, u, dt) {
  const grab = grabAccel(p.pos, u.grabPoint ?? [0, 0, 0], u.grabRadius ?? 0, u.grabForce ?? 0);
  const drift = driftAccel(p.seed, u.time ?? 0, u.drift ?? 0);
  const damp = dampingFactor(u.damping, dt);

  for (let i = 0; i < 3; i++) {
    const accel = (target[i] - p.pos[i]) * u.stiffness + grab[i] + drift[i];
    p.vel[i] = (p.vel[i] + accel * dt) * damp;
    p.pos[i] = p.pos[i] + p.vel[i] * dt;
  }

  p.life = Math.min(1, Math.hypot(p.vel[0], p.vel[1], p.vel[2]) * 0.35);
  return p;
}

/**
 * Grab acceleration: inverse-square with a floor, gated on radius.
 * Returns [0,0,0] when the particle sits exactly on the grab point, because
 * normalising a zero vector is undefined. SPEC §4.5.
 */
export function grabAccel(pos, grabPoint, grabRadius, grabForce) {
  if (!(grabRadius > 0) || !grabForce) return [0, 0, 0];

  const dx = grabPoint[0] - pos[0];
  const dy = grabPoint[1] - pos[1];
  const dz = grabPoint[2] - pos[2];
  const r2 = dx * dx + dy * dy + dz * dz;

  if (r2 > grabRadius * grabRadius) return [0, 0, 0];

  // Mirrors the select() guard in COMPUTE_WGSL. The max() below bounds the
  // magnitude, not the direction, so it does not cover r2 == 0.
  if (r2 <= 1e-8) return [0, 0, 0];

  const pull = grabForce / Math.max(r2, 0.02);
  const inv = 1 / Math.sqrt(r2);
  return [dx * inv * pull, dy * inv * pull, dz * inv * pull];
}

/**
 * Per-particle idle drift: three decorrelated sines seeded from `seed`.
 * Continuous by construction — a per-frame hash would be white noise. SPEC §4.6.
 */
export function driftAccel(seed, time, amount) {
  if (!amount) return [0, 0, 0];
  return [
    Math.sin(time * 0.7 + seed * 6.28318) * amount,
    Math.sin(time * 0.9 + seed * 9.42477) * amount,
    Math.sin(time * 1.1 + seed * 3.14159) * amount,
  ];
}

/**
 * Frame-rate-independent damping factor for a step of `dt` seconds.
 *
 * pow(damping, dt * 60) rather than a bare multiply, matching galaxy-spiral.
 * A bare multiply couples settle time to frame rate: 30 fps would settle at
 * half the speed of 60. SPEC §4.3.
 */
export function dampingFactor(damping, dt) {
  return Math.pow(damping, dt * 60);
}

/** Clamp dt to [0, 0.05]. A resumed background tab would otherwise integrate
 *  a multi-second step and fling every particle to NaN. SPEC §4.3. */
export function clampDt(dt) {
  if (!Number.isFinite(dt)) return 0;
  return Math.min(0.05, Math.max(0, dt));
}

/**
 * Settle time in seconds for a particle released at `startDistance` to come
 * within `epsilon` of its target. Used by unit.test.mjs to assert that the
 * result is equal within 2 % across dt = 1/30, 1/60 and 1/144.
 */
export function settleTime(startDistance, u, dt, epsilon = 1e-3, maxSeconds = 30) {
  const p = { pos: [startDistance, 0, 0], vel: [0, 0, 0], seed: 0, life: 0 };
  const target = [0, 0, 0];

  // Drift and grab are forced off: both are time- or position-dependent forcing
  // terms, and a settle measurement has to observe the spring alone.
  const quiet = {
    stiffness: u.stiffness,
    damping: u.damping,
    drift: 0,
    grabRadius: 0,
    grabForce: 0,
    grabPoint: [0, 0, 0],
    time: 0,
  };

  let t = 0;
  while (t < maxSeconds) {
    step(p, target, quiet, dt);
    t += dt;
    const dist = Math.hypot(p.pos[0], p.pos[1], p.pos[2]);
    const speed = Math.hypot(p.vel[0], p.vel[1], p.vel[2]);
    if (dist <= epsilon && speed <= epsilon) return t;
  }
  return t;
}

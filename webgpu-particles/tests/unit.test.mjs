// Pure-module assertions: byte layout, shape generators, the reference
// integrator, and the camera. No GPU, no DOM. SPEC §7.1.

import { section, ok, eq, near, finish } from './harness.mjs';
import {
  PARTICLE, PARTICLE_FLOATS, UNIFORMS, DRAW_ARGS, WORKGROUP_SIZE,
  COUNT_MIN, COUNT_MAX, workgroupCount, particleBufferSize, clampCount, packUniforms,
} from '../src/js/layout.js';
import {
  SHAPES, TARGET_STRIDE, MAX_RESIDENT, mulberry32, generate, createShapeCache,
} from '../src/js/shapes.js';
import {
  step, grabAccel, driftAccel, dampingFactor, clampDt, settleTime,
} from '../src/js/integrator.js';
import {
  DEFAULT_CAMERA, DISTANCE_MIN, DISTANCE_MAX,
  identity, perspective, lookAt, multiply, eyeFromOrbit, viewProj, orbit, dolly,
} from '../src/js/camera.js';

// Keeps one NotImplemented from aborting the whole suite, so every assertion
// still reports individually while the modules are skeletons.
const attempt = (fn, fallback = undefined) => { try { return fn(); } catch { return fallback; } };

// ---------------------------------------------------------------------------
section('layout: struct offsets match SPEC §3.1');

eq('particle size is 32 bytes', PARTICLE.SIZE, 32);
eq('particle alignment is 16', PARTICLE.ALIGN, 16);
eq('pos at offset 0', PARTICLE.POS, 0);
eq('seed at offset 12', PARTICLE.SEED, 12);
eq('vel at offset 16', PARTICLE.VEL, 16);
eq('life at offset 28', PARTICLE.LIFE, 28);
eq('particle spans 8 floats', PARTICLE_FLOATS, 8);
ok('no field straddles a 16-byte row',
  PARTICLE.POS % 4 === 0 && PARTICLE.VEL === PARTICLE.ALIGN &&
  PARTICLE.SEED + 4 === PARTICLE.VEL && PARTICLE.LIFE + 4 === PARTICLE.SIZE);

section('layout: uniform block matches SPEC §3.3');

eq('uniform block is 128 bytes', UNIFORMS.SIZE, 128);
eq('viewProj at 0', UNIFORMS.VIEW_PROJ, 0);
eq('dt at 64 (just past the mat4)', UNIFORMS.DT, 64);
eq('stiffness at 68', UNIFORMS.STIFFNESS, 68);
eq('damping at 72', UNIFORMS.DAMPING, 72);
eq('time at 76', UNIFORMS.TIME, 76);
eq('grabPoint at 80 (16-byte aligned)', UNIFORMS.GRAB_POINT, 80);
ok('grabPoint is 16-byte aligned', UNIFORMS.GRAB_POINT % 16 === 0);
eq('grabRadius at 92', UNIFORMS.GRAB_RADIUS, 92);
eq('grabForce at 96', UNIFORMS.GRAB_FORCE, 96);
eq('drift at 100', UNIFORMS.DRIFT, 100);
eq('count at 104', UNIFORMS.COUNT, 104);

section('layout: indirect draw args are the WebGPU-mandated order');

eq('drawArgs is 16 bytes', DRAW_ARGS.SIZE, 16);
eq('vertexCount first', DRAW_ARGS.VERTEX_COUNT, 0);
eq('instanceCount second', DRAW_ARGS.INSTANCE_COUNT, 4);
eq('firstVertex third', DRAW_ARGS.FIRST_VERTEX, 8);
eq('firstInstance fourth', DRAW_ARGS.FIRST_INSTANCE, 12);

section('layout: dispatch arithmetic');

eq('workgroup size is 256', WORKGROUP_SIZE, 256);
eq('exact multiple needs no extra group', attempt(() => workgroupCount(1024)), 4);
eq('2^20 needs 4096 groups', attempt(() => workgroupCount(1 << 20)), 4096);
eq('a remainder rounds up', attempt(() => workgroupCount(257)), 2);
eq('one particle still needs one group', attempt(() => workgroupCount(1)), 1);
eq('2^20 particles is 32 MiB', attempt(() => particleBufferSize(1 << 20)), 32 * 1024 * 1024);

section('layout: count clamping honours adapter limits (SPEC §2.1, §9)');

eq('below minimum clamps up', attempt(() => clampCount(1, 1 << 30)), COUNT_MIN);
eq('above maximum clamps down', attempt(() => clampCount(1 << 30, 1 << 30)), COUNT_MAX);
ok('a small storage limit reduces the count',
  attempt(() => clampCount(1 << 20, 4 * 1024 * 1024), Infinity) <= (1 << 17));

section('layout: uniform packing');

{
  const buf = attempt(() => packUniforms({
    viewProj: new Float32Array(16), dt: 1 / 60, stiffness: 13, damping: 0.88,
    time: 2, grabPoint: [0, 0, 0], grabRadius: 0, grabForce: 0, drift: 0.2,
    count: 1 << 20,
  }));
  ok('packUniforms returns a 128-byte buffer', buf?.byteLength === UNIFORMS.SIZE);
  const dv = buf ? new DataView(buf) : null;
  near('dt lands at its offset', dv ? dv.getFloat32(UNIFORMS.DT, true) : NaN, 1 / 60, 1e-7);
  eq('count is written as u32', dv ? dv.getUint32(UNIFORMS.COUNT, true) : NaN, 1 << 20);
}

// ---------------------------------------------------------------------------
section('shapes: catalogue matches galaxy-spiral so the two are comparable');

eq('eight shapes', SHAPES.length, 8);
eq('keys are 1..8', SHAPES.map((s) => s.key).join(''), '12345678');
eq('target stride is vec4', TARGET_STRIDE, 4);
ok('ids are unique', new Set(SHAPES.map((s) => s.id)).size === 8);

section('shapes: generators are deterministic and bounded');

for (const { id } of SHAPES) {
  const a = attempt(() => generate(id, 512, 7));
  const b = attempt(() => generate(id, 512, 7));
  ok(`${id}: fills count * 4 floats`, a?.length === 512 * TARGET_STRIDE);
  ok(`${id}: same seed gives identical output`,
    !!a && !!b && a.every((v, i) => v === b[i]));
  ok(`${id}: no NaN or Infinity`, !!a && a.every((v) => Number.isFinite(v)));
  ok(`${id}: within a unit-ish radius`, !!a && (() => {
    let max = 0;
    for (let i = 0; i < a.length; i += TARGET_STRIDE) {
      max = Math.max(max, Math.hypot(a[i], a[i + 1], a[i + 2]));
    }
    return max > 0 && max < 2.5;
  })());
}

{
  const rand = attempt(() => mulberry32(1));
  ok('mulberry32 returns a function', typeof rand === 'function');
  const v = attempt(() => rand());
  ok('PRNG output is in [0,1)', typeof v === 'number' && v >= 0 && v < 1);
}

section('shapes: LRU cache holds at most four (SPEC §6.1)');

{
  const cache = attempt(() => createShapeCache(256, MAX_RESIDENT));
  ok('cache is created', !!cache);
  if (cache) {
    for (const id of ['core', 'sphere', 'torus', 'cube', 'helix']) attempt(() => cache.get(id));
    eq('never exceeds the resident limit', attempt(() => cache.size()), MAX_RESIDENT);
    ok('least-recently-used was evicted', attempt(() => cache.has('core')) === false);
    ok('most-recent is still resident', attempt(() => cache.has('helix')) === true);
  }
}

// ---------------------------------------------------------------------------
section('integrator: damping is frame-rate independent (SPEC §4.3)');

near('damping at 1/60 is the base value', attempt(() => dampingFactor(0.88, 1 / 60)), 0.88, 1e-6);
ok('a longer step damps more',
  attempt(() => dampingFactor(0.88, 1 / 30), 0) < attempt(() => dampingFactor(0.88, 1 / 60), 1));
ok('a shorter step damps less',
  attempt(() => dampingFactor(0.88, 1 / 144), 0) > attempt(() => dampingFactor(0.88, 1 / 60), 1));

{
  // The real invariant, and the one pow() actually delivers: the per-second
  // decay is identical at every frame rate. Guards a property that is easy to
  // lose, because the wrong version is shorter and reads as a cleanup.
  const rates = [30, 60, 90, 120, 144, 240];
  const perSecond = rates.map((r) => Math.pow(attempt(() => dampingFactor(0.88, 1 / r), NaN), r));
  const spread = Math.max(...perSecond) / Math.min(...perSecond) - 1;
  ok('per-second decay is identical across 30..240 fps (to 1e-6)',
    Number.isFinite(spread) && spread <= 1e-6);

  // Settle time is NOT frame-rate independent and the suite must not pretend
  // otherwise. pow() fixes the damping term; the spring term is still sampled
  // once per step, so semi-implicit Euler overshoots more at larger dt. What
  // can be asserted is that the error is one-sided and converges: a coarser
  // step always settles slower, never faster, and the sequence approaches a
  // limit. A sign flip here means the integrator changed shape. SPEC §4.3.
  const u = { stiffness: 13, damping: 0.88, drift: 0, grabRadius: 0, grabForce: 0, time: 0 };
  const times = rates.map((r) => attempt(() => settleTime(1, u, 1 / r), NaN));
  ok('every settle time is finite', times.every(Number.isFinite));
  ok('a coarser step never settles faster than a finer one',
    times.every((t, i) => i === 0 || t <= times[i - 1] + 1e-9));
  // Semi-implicit Euler is first-order, so the settle-time error should scale
  // linearly with dt. Comparing raw gaps between consecutive frame rates would
  // be meaningless because the rates are not evenly spaced in dt — 30 to 60 is
  // a dt step of 16.7 ms, 144 to 240 only 2.7 ms. Dividing each gap by its own
  // dt difference gives a slope that is constant iff convergence is first
  // order, which is the property that actually pins the integrator's shape.
  const slopes = [];
  for (let i = 1; i < rates.length; i++) {
    const dDt = 1 / rates[i - 1] - 1 / rates[i];
    slopes.push(Math.abs(times[i - 1] - times[i]) / dDt);
  }
  ok('settle-time error is first order in dt (slope constant within 2x)',
    slopes.every(Number.isFinite) && Math.max(...slopes) / Math.min(...slopes) <= 2);
  ok('all settle times land in the documented 3.4 to 4.1 s band',
    times.every((t) => t >= 3.4 && t <= 4.1));
}

section('integrator: dt clamp (SPEC §4.3)');

eq('a normal step passes through', attempt(() => clampDt(1 / 60)), 1 / 60);
eq('a resumed tab is clamped to 50 ms', attempt(() => clampDt(10)), 0.05);
eq('negative dt clamps to zero', attempt(() => clampDt(-1)), 0);

section('integrator: grab guards (SPEC §4.5)');

{
  const atPoint = attempt(() => grabAccel([1, 1, 1], [1, 1, 1], 5, 1));
  ok('grab at zero distance returns no acceleration, not NaN',
    !!atPoint && atPoint.every((v) => Number.isFinite(v)) &&
    atPoint.every((v) => v === 0));

  const outside = attempt(() => grabAccel([10, 0, 0], [0, 0, 0], 1, 1));
  ok('outside the radius contributes nothing',
    !!outside && outside.every((v) => v === 0));

  const nearPoint = attempt(() => grabAccel([0.5, 0, 0], [0, 0, 0], 5, 1), []);
  const farPoint = attempt(() => grabAccel([2, 0, 0], [0, 0, 0], 5, 1), []);
  ok('pull falls off with distance',
    Math.hypot(...nearPoint) > Math.hypot(...farPoint));
  ok('pull points toward the grab point', nearPoint[0] < 0);
}

section('integrator: drift is continuous, not per-frame noise (SPEC §4.6)');

{
  const a = attempt(() => driftAccel(0.5, 1.000, 1), []);
  const b = attempt(() => driftAccel(0.5, 1.001, 1), []);
  ok('a tiny time step gives a tiny change',
    a.length === 3 && b.length === 3 &&
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 0.05);
  const other = attempt(() => driftAccel(0.9, 1.0, 1), []);
  ok('different seeds decorrelate',
    a.length === 3 && other.length === 3 &&
    Math.hypot(a[0] - other[0], a[1] - other[1], a[2] - other[2]) > 1e-3);
  eq('zero amount means zero drift',
    attempt(() => driftAccel(0.5, 1, 0), [NaN])[0], 0);
}

section('integrator: a particle converges on its target');

{
  const u = { stiffness: 13, damping: 0.88, drift: 0, grabRadius: 0, grabForce: 0, time: 0 };
  const p = { pos: [1, 0, 0], vel: [0, 0, 0], seed: 0.5, life: 0 };
  let finite = true;
  for (let i = 0; i < 600; i++) {
    const r = attempt(() => step(p, [0, 0, 0], u, 1 / 60));
    if (!r || !r.pos.every(Number.isFinite)) { finite = false; break; }
  }
  ok('600 steps stay finite', finite);
  ok('ends near the target', finite && Math.hypot(...p.pos) < 0.01);
}

// ---------------------------------------------------------------------------
section('camera: matrices');

{
  const i = attempt(() => identity());
  ok('identity has ones on the diagonal',
    !!i && i[0] === 1 && i[5] === 1 && i[10] === 1 && i[15] === 1);
  const m = attempt(() => multiply(identity(), identity()));
  ok('identity times identity is identity',
    !!m && !!i && m.every((v, k) => v === i[k]));

  const p = attempt(() => perspective(Math.PI / 4, 16 / 9, 0.05, 100));
  ok('perspective is 16 floats, all finite',
    p?.length === 16 && p.every(Number.isFinite));

  const v = attempt(() => lookAt([0, 0, 3], [0, 0, 0], [0, 1, 0]));
  ok('lookAt is 16 floats, all finite',
    v?.length === 16 && v.every(Number.isFinite));
}

section('camera: orbit and dolly (SPEC §8)');

{
  const cam = { ...DEFAULT_CAMERA };
  attempt(() => orbit(cam, 0, 100000, 800));
  ok('pitch is clamped short of the pole', Math.abs(cam.pitch) < Math.PI / 2);

  const vp = attempt(() => viewProj(cam, 16 / 9));
  ok('viewProj stays finite at the clamped pole',
    vp?.length === 16 && vp.every(Number.isFinite));

  const c2 = { ...DEFAULT_CAMERA };
  for (let i = 0; i < 200; i++) attempt(() => dolly(c2, -1000));
  ok('dolly cannot pass the near clamp', c2.distance >= DISTANCE_MIN);
  const c3 = { ...DEFAULT_CAMERA };
  for (let i = 0; i < 200; i++) attempt(() => dolly(c3, 1000));
  ok('dolly cannot pass the far clamp', c3.distance <= DISTANCE_MAX);

  eq('dolly does not change FOV', c2.fovY, DEFAULT_CAMERA.fovY);

  const eye = attempt(() => eyeFromOrbit(DEFAULT_CAMERA), []);
  near('eye sits at the orbit distance',
    Math.hypot(...eye), DEFAULT_CAMERA.distance, 1e-4);
}

section('camera: generated geometry actually lands inside the frustum');

// "Nothing is visible" has many causes and a wrong projection is one of them —
// a transposed multiply or GL-style depth range puts every particle off screen
// or behind the near plane, with no error anywhere. Asserting real generated
// points reach valid NDC rules that out in Node, without a GPU.
{
  const vp = attempt(() => viewProj({ ...DEFAULT_CAMERA }, 16 / 9), null);

  const project = (x, y, z) => {
    if (!vp) return null;
    const o = [0, 0, 0, 0];
    for (let r = 0; r < 4; r++) {
      o[r] = vp[r] * x + vp[4 + r] * y + vp[8 + r] * z + vp[12 + r];
    }
    return o;
  };

  const ndcOf = (x, y, z) => {
    const p = project(x, y, z);
    if (!p || Math.abs(p[3]) < 1e-9) return null;
    return [p[0] / p[3], p[1] / p[3], p[2] / p[3], p[3]];
  };

  const onScreen = (n) =>
    !!n && Math.abs(n[0]) <= 1 && Math.abs(n[1]) <= 1 && n[2] >= 0 && n[2] <= 1;

  const origin = ndcOf(0, 0, 0);
  ok('the origin is on screen', onScreen(origin));
  ok('w is positive, so the point is in front of the camera', (origin?.[3] ?? -1) > 0);

  // WebGPU clip space is z in [0,1]. A GL-style matrix yields negative z here
  // for points in front of the camera, which silently clips everything away.
  ok('depth is in the WebGPU [0,1] range, not GL [-1,1]',
    (origin?.[2] ?? -1) >= 0 && (origin?.[2] ?? 2) <= 1);

  for (const [id, radius] of [['sphere', 0.85], ['core', 0.26], ['galaxy', 1.1]]) {
    const pts = attempt(() => generate(id, 64, 1), null);
    let visible = 0;
    if (pts) {
      for (let i = 0; i < 64; i++) {
        if (onScreen(ndcOf(pts[i * 4], pts[i * 4 + 1], pts[i * 4 + 2]))) visible++;
      }
    }
    ok(`${id}: all 64 sampled points land on screen (${visible}/64)`, visible === 64);
  }

  // A degenerate matrix projects everything to one spot, which also renders as
  // nothing recognisable — so check the field actually has extent.
  const a = ndcOf(0.85, 0, 0);
  const b = ndcOf(-0.85, 0, 0);
  ok('opposite edges of the field project to different places',
    !!a && !!b && Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.1);
}

finish();

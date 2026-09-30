// Per-frame CPU cost profile.
//
// This measures the CPU side only — uniform packing, shape generation, and the
// reference integrator. It cannot measure the compute or render pass, which
// need a real device. The number that matters here is that per-frame CPU work
// stays flat as the particle count grows, which is the claim of SPEC §10.

import { performance } from 'node:perf_hooks';
import { UNIFORMS, packUniforms, workgroupCount } from '../src/js/layout.js';
import { generate, SHAPES, TARGET_STRIDE } from '../src/js/shapes.js';
import { step, clampDt } from '../src/js/integrator.js';
import { viewProj, DEFAULT_CAMERA } from '../src/js/camera.js';

const COUNTS = [1 << 10, 1 << 14, 1 << 18, 1 << 20, 1 << 22];
const FRAMES = 240;

function time(label, fn) {
  try {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  } catch (e) {
    return NaN;
  }
}

function ms(v) {
  return Number.isFinite(v) ? v.toFixed(3).padStart(9) : '        —';
}

console.log('\nPer-frame CPU cost. GPU passes are not included — they need a device.\n');
console.log('  count        uniforms/frame   viewProj/frame   groups     targets MiB');
console.log('  ' + '─'.repeat(72));

const state = {
  viewProj: new Float32Array(16), dt: 1 / 60, stiffness: 13, damping: 0.88,
  time: 0, grabPoint: [0, 0, 0], grabRadius: 0, grabForce: 0, drift: 0.2, count: 0,
};

for (const count of COUNTS) {
  state.count = count;
  const buf = new ArrayBuffer(UNIFORMS.SIZE);

  const uni = time('uniforms', () => {
    for (let f = 0; f < FRAMES; f++) packUniforms(state, buf);
  }) / FRAMES;

  const cam = time('viewProj', () => {
    for (let f = 0; f < FRAMES; f++) viewProj(DEFAULT_CAMERA, 16 / 9, state.viewProj);
  }) / FRAMES;

  const groups = (() => { try { return workgroupCount(count); } catch { return '—'; } })();
  const targetsMiB = (count * TARGET_STRIDE * 4 / 1024 / 1024).toFixed(1);

  console.log(
    `  ${String(count).padStart(9)}  ${ms(uni)} ms   ${ms(cam)} ms   ` +
    `${String(groups).padStart(7)}   ${targetsMiB.padStart(11)}`
  );
}

console.log('\n  The first two columns should be flat across every row. If they are not,');
console.log('  something in the per-frame path is scaling with particle count, which is');
console.log('  exactly the regression SPEC §10 exists to prevent.\n');

console.log('Shape generation, once per cold shape (SPEC §6.1):\n');
console.log('  shape      2^20 points');
console.log('  ' + '─'.repeat(30));
for (const { id } of SHAPES) {
  const t = time(id, () => generate(id, 1 << 20, 1));
  console.log(`  ${id.padEnd(10)} ${ms(t)} ms`);
}

console.log('\n  A cold shape costs one generation; a resident one is free. Four stay');
console.log('  resident under LRU, so the worst case is one hitch per new shape.\n');

console.log('Reference integrator, 1000 particles x 240 frames:\n');
{
  const N = 1000;
  const ps = Array.from({ length: N }, (_, i) => ({
    pos: [1, 0, 0], vel: [0, 0, 0], seed: i / N, life: 0,
  }));
  const target = [0, 0, 0];
  const u = { stiffness: 13, damping: 0.88, drift: 0.2, grabRadius: 0, grabForce: 0, time: 0 };
  const t = time('integrate', () => {
    for (let f = 0; f < FRAMES; f++) {
      const dt = clampDt(1 / 60);
      u.time += dt;
      for (const p of ps) step(p, target, u, dt);
    }
  });
  console.log(`  ${ms(t / FRAMES)} ms per frame`);
  console.log('\n  This is the JS reference of SPEC §7.1, used to assert the physics in');
  console.log('  Node. It is not on the render path — the GPU runs the WGSL copy.\n');
}

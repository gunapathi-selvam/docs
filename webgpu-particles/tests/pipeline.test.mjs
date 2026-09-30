// GPU contract assertions against a recording fake device, plus shader-source
// assertions for the four guards that are invisible when wrong. SPEC §7.2, §7.3.

globalThis.__WGP_TEST__ = true;

import {
  section, ok, eq, finish,
  createFakeDevice, createFakeNavigatorGpu, createFakeContext, createFakeResources,
} from './harness.mjs';
import { COMPUTE_WGSL, RENDER_WGSL, PARTICLE_STRUCT } from '../src/js/shaders.js';
import {
  initDevice, compile, createBuffers, createBindGroups, createPipelines,
  seedParticles, writeTargets, encodeFrame, destroyAll, onDeviceLost,
  REQUIRED_LIMITS,
} from '../src/js/gpu.js';
import { UNIFORMS, WORKGROUP_SIZE, PARTICLE, DRAW_ARGS } from '../src/js/layout.js';

const attempt = (fn, fallback = undefined) => { try { return fn(); } catch { return fallback; } };
const attemptAsync = async (fn, fallback = undefined) => { try { return await fn(); } catch { return fallback; } };

// ===========================================================================
// Shader source. These are text assertions and a weak form of verification —
// they catch deletion, not misuse. They exist because each guard corresponds
// to a bug that produces no error, no warning and no obvious artifact, and
// because the alternative is no shader coverage at all. SPEC §7.3.
// ===========================================================================

section('shader guard 1: the bounds check (SPEC §4.2)');

ok('compute shader returns early past the live count',
  /if\s*\(\s*i\s*>=\s*u\.count\s*\)\s*\{\s*return\s*;?\s*\}/.test(COMPUTE_WGSL));
ok('the guard precedes any buffer read',
  COMPUTE_WGSL.indexOf('u.count') < COMPUTE_WGSL.indexOf('inParticles[i]'));

section('shader guard 2: the zero-direction guard (SPEC §4.5)');

ok('normalize is wrapped in a select',
  /select\s*\(\s*vec3<f32>\(0\.0\)\s*,\s*normalize\s*\(\s*d\s*\)\s*,/.test(COMPUTE_WGSL));
ok('the select tests squared distance against an epsilon',
  /r2\s*>\s*1e-8/.test(COMPUTE_WGSL));
ok('a magnitude floor is also present, and is not mistaken for the guard',
  /max\s*\(\s*r2\s*,\s*0\.02\s*\)/.test(COMPUTE_WGSL));

section('shader guard 3: frame-rate-independent damping (SPEC §4.3)');

ok('damping uses pow, not a bare multiply',
  /pow\s*\(\s*u\.damping\s*,\s*u\.dt\s*\*\s*60\.0\s*\)/.test(COMPUTE_WGSL));
ok('velocity is not multiplied by a raw damping constant',
  !/\*\s*u\.damping\s*;/.test(COMPUTE_WGSL));

section('shader guard 4: single-writer indirect args (SPEC §5.3)');

ok('only invocation 0 writes drawArgs',
  /if\s*\(\s*i\s*==\s*0u\s*\)\s*\{[\s\S]{0,400}drawArgs\.vertexCount/.test(COMPUTE_WGSL));
eq('drawArgs.vertexCount is assigned exactly once',
  (COMPUTE_WGSL.match(/drawArgs\.vertexCount\s*=/g) || []).length, 1);

// instanceCount was the bug that produced a completely blank canvas with zero
// validation errors, healthy frame times and a fully green suite. WebGPU
// zero-fills a new buffer and drawIndirect with instanceCount == 0 legally
// draws nothing, so nothing anywhere complains. Every field of the indirect
// block must be written explicitly.
ok('drawArgs.instanceCount is written — zero draws nothing, legally and silently',
  /drawArgs\.instanceCount\s*=/.test(COMPUTE_WGSL));
ok('instanceCount is written as a non-zero literal',
  /drawArgs\.instanceCount\s*=\s*[1-9]\d*u?\s*;/.test(COMPUTE_WGSL));
ok('firstVertex is written explicitly rather than left to zero-fill',
  /drawArgs\.firstVertex\s*=/.test(COMPUTE_WGSL));
ok('firstInstance is written explicitly rather than left to zero-fill',
  /drawArgs\.firstInstance\s*=/.test(COMPUTE_WGSL));

// Ties the shader back to the byte layout: all four u32 slots accounted for.
{
  const written = ['vertexCount', 'instanceCount', 'firstVertex', 'firstInstance']
    .filter((f) => new RegExp(`drawArgs\\.${f}\\s*=`).test(COMPUTE_WGSL));
  eq('all four indirect-draw fields are written', written.length, 4);
  eq('and DRAW_ARGS declares exactly those four slots', DRAW_ARGS.SIZE / 4, 4);
}

section('shader: no WGSL reserved keyword is used as an identifier');

// This section exists because `let target = ...` shipped and the compute module
// never parsed. `target` is reserved in WGSL. The failure was total and silent:
// no compute pipeline, every frame submitting an invalid command buffer, while
// the render pass still drew the seeded positions — so the page looked like a
// working field that simply never moved.
//
// Text assertions cannot prove WGSL compiles (SPEC §7.3), but they can prove a
// known-illegal identifier is absent, which is the single cheapest guard
// against repeating this specific class of silent failure.
{
  // From the WGSL spec's reserved-word list; restricted to names a person would
  // plausibly reach for in this shader.
  const RESERVED = [
    'target', 'filter', 'sample', 'texture', 'buffer', 'binding', 'layout',
    'input', 'output', 'shared', 'uniform', 'varying', 'attribute', 'common',
    'active', 'auto', 'become', 'cast', 'class', 'compile', 'do', 'enum',
    'final', 'friend', 'get', 'goto', 'handle', 'inline', 'macro', 'match',
    'module', 'new', 'null', 'premerge', 'priv', 'pub', 'regardless', 'set',
    'static', 'super', 'template', 'this', 'typedef', 'union', 'unless',
    'using', 'virtual', 'where',
  ];

  const sources = [
    ['compute', COMPUTE_WGSL],
    ['render', RENDER_WGSL],
  ];

  for (const [label, src] of sources) {
    const offenders = RESERVED.filter((word) => {
      // Only a declaration binds the name; `targets[i]` and `u.target` are fine.
      const decl = new RegExp(`\\b(let|var|const|fn)\\s+${word}\\b`);
      const param = new RegExp(`[(,]\\s*${word}\\s*:`);
      return decl.test(src) || param.test(src);
    });
    ok(`${label}: declares no reserved keyword as a name${offenders.length ? ' — found ' + offenders.join(', ') : ''}`,
      offenders.length === 0);
  }

  // Guard the specific one that broke, by name, so a rename back is loud.
  ok('compute does not bind the name `target`',
    !/\b(let|var|const)\s+target\b/.test(COMPUTE_WGSL));
  ok('compute still reads the targets array', /targets\s*\[/.test(COMPUTE_WGSL));
}

section('shader: struct layout agrees with layout.js');

ok('Particle declares pos, seed, vel, life in order',
  /pos\s*:\s*vec3<f32>[\s\S]*seed\s*:\s*f32[\s\S]*vel\s*:\s*vec3<f32>[\s\S]*life\s*:\s*f32/
    .test(PARTICLE_STRUCT));
ok('Uniforms declares count as u32',
  /count\s*:\s*u32/.test(PARTICLE_STRUCT));
ok('DrawArgs uses the WebGPU-mandated field order',
  /vertexCount\s*:\s*u32[\s\S]*instanceCount\s*:\s*u32[\s\S]*firstVertex\s*:\s*u32[\s\S]*firstInstance\s*:\s*u32/
    .test(PARTICLE_STRUCT));

section('shader: dispatch geometry matches layout.js');

ok(`workgroup_size is ${WORKGROUP_SIZE}`,
  new RegExp(`@workgroup_size\\(\\s*${WORKGROUP_SIZE}\\s*,`).test(COMPUTE_WGSL));

section('shader: the render pass indexes the storage buffer directly (SPEC §5.1)');

ok('vertex stage reads builtin vertex_index',
  /@builtin\(vertex_index\)/.test(RENDER_WGSL));
ok('there is no vertex attribute location in the vertex input',
  !/@vertex[\s\S]{0,200}@location\(\d+\)\s+\w+\s*:\s*vec[34]/.test(RENDER_WGSL));
ok('particles are bound read-only in the render stage',
  /var<storage,\s*read>\s*particles/.test(RENDER_WGSL));
ok('the compute stage binds the output buffer read_write',
  /var<storage,\s*read_write>\s*outParticles/.test(COMPUTE_WGSL));
ok('the compute stage binds the input buffer read-only',
  /var<storage,\s*read>\s+inParticles/.test(COMPUTE_WGSL));

// ===========================================================================
// Device contract.
// ===========================================================================

section('init: the failure paths of SPEC §9 are distinguishable');

{
  const noGpu = await attemptAsync(() => initDevice(createFakeNavigatorGpu('no-gpu')), null);
  ok('a missing navigator.gpu is reported as no-gpu',
    noGpu === null || noGpu?.reason === 'no-gpu');

  let reason = null;
  try { await initDevice(createFakeNavigatorGpu('no-adapter')); }
  catch (e) { reason = e?.reason ?? null; }
  eq('a null adapter is tagged no-adapter', reason, 'no-adapter');

  let limitReason = null;
  try {
    await initDevice(createFakeNavigatorGpu('ok', { maxStorageBufferBindingSize: 1024 }));
  } catch (e) { limitReason = e?.reason ?? null; }
  eq('insufficient limits are tagged limits', limitReason, 'limits');
}

ok('the required storage limit covers two 32 MiB buffers',
  REQUIRED_LIMITS.maxStorageBufferBindingSize >= 64 * 1024 * 1024);
eq('the required workgroup width matches the shader',
  REQUIRED_LIMITS.maxComputeWorkgroupSizeX, WORKGROUP_SIZE);

section('buffers: the five buffers of SPEC §3.2 are allocated');

{
  const rec = createFakeDevice();
  const count = 4096;
  attempt(() => createBuffers(rec.device, count));
  const created = rec.of('createBuffer');
  eq('five buffers are created', created.length, 5);

  const sizes = created.map((c) => c.args.size);
  const particleBytes = count * PARTICLE.SIZE;
  eq('two buffers are particle-sized (ping-pong)',
    sizes.filter((s) => s === particleBytes).length, 2);
  ok('one buffer is the 128-byte uniform block',
    sizes.includes(UNIFORMS.SIZE));
  ok('one buffer is 16 bytes for the indirect args',
    sizes.includes(16));
  ok('the indirect buffer declares INDIRECT usage',
    created.some((c) => c.args.size === 16 && String(c.args.usage).length > 0));
}

section('bind groups: built once at init, never per frame (SPEC §4.4)');

{
  const rec = createFakeDevice();
  const res = await createFakeResources(rec, 4096);
  const ctx = createFakeContext(rec);

  const atInit = rec.countOf('createBindGroup');
  eq('four bind groups are created (two parities x two passes)', atInit, 4);

  rec.reset();
  for (let f = 0; f < 10; f++) attempt(() => encodeFrame(rec.device, ctx, res, f));
  eq('no bind group is created inside the frame loop',
    rec.countOf('createBindGroup'), 0);
  eq('no buffer is created inside the frame loop',
    rec.countOf('createBuffer'), 0);
  eq('no pipeline is created inside the frame loop',
    rec.countOf('createComputePipeline') + rec.countOf('createRenderPipeline'), 0);
}

section('frame: the upload invariant of SPEC §10');

{
  const rec = createFakeDevice();
  const res = await createFakeResources(rec, 4096);
  const ctx = createFakeContext(rec);
  rec.reset();

  for (let f = 0; f < 10; f++) attempt(() => encodeFrame(rec.device, ctx, res, f));
  const writes = rec.of('writeBuffer');
  eq('one uniform write per frame', writes.length, 10);
  ok('every per-frame write is exactly 128 bytes',
    writes.length > 0 && writes.every((w) => w.args.size === UNIFORMS.SIZE));
  ok('every per-frame write targets the uniform buffer',
    writes.every((w) => w.args.label === 'uniforms'));
  ok('no per-frame write is particle-sized',
    writes.every((w) => w.args.size < 1024));
  eq('one submission per frame', rec.countOf('submit'), 10);
}

section('frame: the upload invariant holds at 2^20 as well as 2^12');

// The claim of SPEC §10 is that per-frame CPU traffic is constant in particle
// count, so it has to be checked at more than one count or it is not tested.
{
  const rec = createFakeDevice();
  const res = await createFakeResources(rec, 1 << 20);
  const ctx = createFakeContext(rec);
  rec.reset();

  for (let f = 0; f < 5; f++) attempt(() => encodeFrame(rec.device, ctx, res, f));
  const writes = rec.of('writeBuffer');
  eq('still one write per frame at 2^20', writes.length, 5);
  ok('still exactly 128 bytes at 2^20',
    writes.every((w) => w.args.size === UNIFORMS.SIZE));
}

section('frame: compute and render are ordered in one submission');

{
  const rec = createFakeDevice();
  const res = await createFakeResources(rec, 4096);
  const ctx = createFakeContext(rec);
  rec.reset();

  attempt(() => encodeFrame(rec.device, ctx, res, 0));
  const names = rec.calls.map((c) => c.name);
  const c = names.indexOf('beginComputePass');
  const r = names.indexOf('beginRenderPass');
  const s = names.indexOf('submit');
  ok('the compute pass is encoded before the render pass', c >= 0 && r >= 0 && c < r);
  ok('both passes land in a single submission', s > r);
  eq('exactly one submission', rec.countOf('submit'), 1);
  eq('exactly one command encoder', rec.countOf('createCommandEncoder'), 1);
}

section('frame: dispatch geometry is derived from the count (SPEC §4.2)');

{
  const rec = createFakeDevice();
  const res = await createFakeResources(rec, 1 << 20);
  const ctx = createFakeContext(rec);
  rec.reset();

  attempt(() => encodeFrame(rec.device, ctx, res, 0));
  const d = rec.of('dispatchWorkgroups')[0];
  eq('2^20 particles dispatch 4096 workgroups', d?.args?.x, 4096);
  ok('y and z are 1', d?.args?.y === 1 && d?.args?.z === 1);
}

section('frame: ping-pong parity (SPEC §4.4)');

// A swapped parity is invisible on a static swarm and shows up only as one
// frame of lag under motion, which is why this is asserted structurally.
{
  const rec = createFakeDevice();
  const res = await createFakeResources(rec, 4096);
  const ctx = createFakeContext(rec);

  rec.reset();
  attempt(() => encodeFrame(rec.device, ctx, res, 0));
  const even = {
    compute: rec.of('compute.setBindGroup')[0]?.args?.label,
    render: rec.of('render.setBindGroup')[0]?.args?.label,
  };

  rec.reset();
  attempt(() => encodeFrame(rec.device, ctx, res, 1));
  const odd = {
    compute: rec.of('compute.setBindGroup')[0]?.args?.label,
    render: rec.of('render.setBindGroup')[0]?.args?.label,
  };

  ok('the compute bind group alternates with frame parity',
    !!even.compute && !!odd.compute && even.compute !== odd.compute);
  ok('the render bind group alternates with frame parity',
    !!even.render && !!odd.render && even.render !== odd.render);

  // The correctness condition, not just alternation: on an even frame the
  // compute pass writes particleB, so the render pass must read particleB.
  const bindingOf = (group, binding) =>
    group?.entries?.find((e) => e.binding === binding)?.resource?.buffer?.label;

  const cEven = res.bindGroups.compute[0];
  const rEven = res.bindGroups.render[0];
  const cOdd = res.bindGroups.compute[1];
  const rOdd = res.bindGroups.render[1];

  eq('even frame: compute reads particleA', bindingOf(cEven, 0), 'particleA');
  eq('even frame: compute writes particleB', bindingOf(cEven, 1), 'particleB');
  eq('even frame: render reads what compute just wrote',
    bindingOf(rEven, 0), bindingOf(cEven, 1));

  eq('odd frame: compute reads particleB', bindingOf(cOdd, 0), 'particleB');
  eq('odd frame: compute writes particleA', bindingOf(cOdd, 1), 'particleA');
  eq('odd frame: render reads what compute just wrote',
    bindingOf(rOdd, 0), bindingOf(cOdd, 1));

  ok('no bind group reads and writes the same buffer',
    bindingOf(cEven, 0) !== bindingOf(cEven, 1) &&
    bindingOf(cOdd, 0) !== bindingOf(cOdd, 1));
}

section('frame: the draw is indirect (SPEC §5.3)');

{
  const rec = createFakeDevice();
  const res = await createFakeResources(rec, 4096);
  const ctx = createFakeContext(rec);
  rec.reset();

  attempt(() => encodeFrame(rec.device, ctx, res, 0));
  eq('drawIndirect is used', rec.countOf('drawIndirect'), 1);
  eq('the direct draw path is not used', rec.countOf('draw'), 0);
  eq('the indirect args come from the drawArgs buffer',
    rec.of('drawIndirect')[0]?.args?.label, 'drawArgs');
}

section('targets: written on shape change only, never per frame (SPEC §3.2)');

{
  const rec = createFakeDevice();
  const targets = new Float32Array(4096 * 4);
  attempt(() => writeTargets(rec.device, { label: 'targets' }, targets));
  eq('one write per shape change', rec.countOf('writeBuffer'), 1);
  eq('the whole target array goes up at once',
    rec.of('writeBuffer')[0]?.args?.size, targets.byteLength);

  rec.reset();
  for (let f = 0; f < 5; f++) attempt(() => encodeFrame(rec.device, {}, {}, f));
  ok('the frame loop never writes a target-sized buffer',
    rec.of('writeBuffer').every((w) => w.args.size !== targets.byteLength));
}

section('seeding: particle memory is written once, not per frame (SPEC §1.1)');

{
  const rec = createFakeDevice();
  attempt(() => seedParticles(rec.device, { label: 'particleA' }, 4096, new Float32Array(4096 * 4)));
  ok('seeding writes particle memory once', rec.countOf('writeBuffer') <= 1);
}

section('shader compilation: messages are returned, not swallowed (SPEC §9)');

{
  const rec = createFakeDevice();
  const info = await attemptAsync(() => compile(rec.device, COMPUTE_WGSL, 'compute'), null);
  eq('a shader module is created', rec.countOf('createShaderModule'), 1);
  ok('compile resolves with something inspectable', info !== undefined);
}

section('device loss: teardown before re-init (SPEC §2.3)');

{
  const rec = createFakeDevice();
  const buffers = attempt(() => createBuffers(rec.device, 1024), null);
  rec.reset();
  attempt(() => destroyAll(buffers));
  ok('every buffer is destroyed', rec.countOf('buffer.destroy') >= 5);

  let handled = false;
  attempt(() => onDeviceLost(rec.device, () => { handled = true; }));
  ok('onDeviceLost accepts a handler without throwing synchronously',
    handled === false);
}

section('pipelines: point-list, additive, no depth (SPEC §5.1, §5.2)');

{
  const rec = createFakeDevice();
  await attemptAsync(() => createPipelines(rec.device, 'bgra8unorm'));
  const render = rec.of('createRenderPipeline')[0]?.args;
  eq('one compute pipeline', rec.countOf('createComputePipeline'), 1);
  eq('one render pipeline', rec.countOf('createRenderPipeline'), 1);
  ok('topology is point-list', render?.primitive?.topology === 'point-list');
  ok('no depth stencil state is attached', !render?.depthStencil);
  ok('blending is additive',
    render?.fragment?.targets?.[0]?.blend?.color?.srcFactor === 'one' &&
    render?.fragment?.targets?.[0]?.blend?.color?.dstFactor === 'one');
  ok('no vertex buffer layout is declared',
    !render?.vertex?.buffers || render.vertex.buffers.length === 0);
}

finish();

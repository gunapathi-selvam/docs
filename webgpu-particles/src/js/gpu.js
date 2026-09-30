// Device, buffers, pipelines, bind groups, frame loop.
//
// Every function here takes its device as a parameter rather than reaching for
// a module global, which is what lets tests/harness.mjs drive the whole module
// with a fake device that records calls. SPEC §7.2.

import {
  PARTICLE, PARTICLE_FLOATS, UNIFORMS, DRAW_ARGS, WORKGROUP_SIZE,
  COUNT_MIN, workgroupCount, particleBufferSize, packUniforms,
} from './layout.js';
import { COMPUTE_WGSL, RENDER_WGSL } from './shaders.js';
import { TARGET_STRIDE } from './shapes.js';

export const REQUIRED_LIMITS = {
  maxStorageBufferBindingSize: 64 * 1024 * 1024,
  maxComputeWorkgroupSizeX: WORKGROUP_SIZE,
};

function tagged(reason, message, detail) {
  const err = new Error(message);
  err.reason = reason;
  if (detail) err.detail = detail;
  return err;
}

/**
 * Request an adapter and device, verify limits, install the uncaptured-error
 * handler.
 *
 * WebGPU validation failures are asynchronous — they surface through the
 * uncaptured-error handler or an error scope, never as a throw at the call
 * site. The handler must be installed before the first buffer is created or
 * early failures are lost. SPEC §2.3, §9.
 *
 * Returns {adapter, device, limits} or throws a tagged error whose `.reason`
 * is one of 'no-gpu' | 'no-adapter' | 'limits' | 'device'.
 */
export async function initDevice(navigatorGpu, onError) {
  if (!navigatorGpu) throw tagged('no-gpu', 'navigator.gpu is not present');

  const adapter = await navigatorGpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw tagged('no-adapter', 'requestAdapter() returned null');

  const limits = adapter.limits;

  // Checked against the smallest field we would ever draw, not against
  // REQUIRED_LIMITS. An adapter with less headroom than 2^20 particles need is
  // still usable at a lower count — SPEC §9 reduces the count rather than
  // refusing outright. Only a device that cannot hold COUNT_MIN is fatal.
  const floorBytes = particleBufferSize(COUNT_MIN);
  if ((limits.maxStorageBufferBindingSize ?? 0) < floorBytes) {
    throw tagged('limits',
      `maxStorageBufferBindingSize is ${limits.maxStorageBufferBindingSize}, need at least ${floorBytes}`);
  }
  if ((limits.maxComputeWorkgroupSizeX ?? 0) < WORKGROUP_SIZE) {
    throw tagged('limits',
      `maxComputeWorkgroupSizeX is ${limits.maxComputeWorkgroupSizeX}, need ${WORKGROUP_SIZE}`);
  }

  // Ask for as much as the adapter will give, capped at what we can use. The
  // default maxStorageBufferBindingSize is 128 MiB, which is below what 2^22
  // particles need, so the larger counts require this explicitly.
  const want = Math.min(
    limits.maxStorageBufferBindingSize,
    REQUIRED_LIMITS.maxStorageBufferBindingSize * 4
  );

  let device;
  try {
    device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: want,
        maxBufferSize: Math.min(limits.maxBufferSize ?? want, want),
      },
    });
  } catch (err) {
    // Retry bare: a requiredLimits entry the adapter dislikes rejects the whole
    // request, and a smaller field is better than no field at all.
    try {
      device = await adapter.requestDevice();
    } catch (err2) {
      throw tagged('device', err2.message || 'requestDevice() failed');
    }
  }

  if (typeof onError === 'function') {
    device.onuncapturederror = (ev) => onError(ev.error ?? ev);
  }

  return { adapter, device, limits: device.limits ?? limits };
}

/**
 * Compile a shader module and surface compilationInfo() messages.
 *
 * A shader that fails to compile renders nothing and, by default, says
 * nothing. SPEC §9 requires the messages be shown in the page, so this
 * returns them rather than only logging.
 */
export async function compile(device, code, label) {
  // An error scope around creation is required, not belt-and-braces:
  // compilationInfo() is not guaranteed to carry a WGSL parse failure on every
  // implementation, and when it comes back empty the caller concludes the
  // shader is fine. That is exactly how a reserved-keyword parse error shipped
  // here undetected — the module was invalid, the page rendered, and the only
  // evidence was 900+ uncaptured validation errors in the console.
  const scoped = typeof device.pushErrorScope === 'function';
  if (scoped) device.pushErrorScope('validation');

  const module = device.createShaderModule({ code, label });

  let messages = [];
  if (typeof module.compilationInfo === 'function') {
    const info = await module.compilationInfo();
    messages = Array.from(info?.messages ?? []);
  }

  const errors = messages.filter((m) => m.type === 'error');

  if (scoped) {
    const scopeError = await device.popErrorScope();
    if (scopeError) {
      errors.push({
        type: 'error',
        message: scopeError.message ?? String(scopeError),
        lineNum: 0,
        linePos: 0,
      });
    }
  }
  return {
    module,
    messages,
    errors,
    // Formatted for the failure page, not the console: line and column are what
    // make a WGSL error actionable.
    text: messages
      .map((m) => `${m.type} ${label}:${m.lineNum}:${m.linePos}  ${m.message}`)
      .join('\n'),
  };
}

/**
 * Allocate every buffer for `count` particles. SPEC §3.2.
 * Returns {particleA, particleB, targets, uniforms, drawArgs}.
 */
export function createBuffers(device, count) {
  const U = globalThis.GPUBufferUsage ?? {
    STORAGE: 0x80, COPY_DST: 0x08, COPY_SRC: 0x04,
    UNIFORM: 0x40, INDIRECT: 0x100, VERTEX: 0x20,
  };

  const particleBytes = particleBufferSize(count);
  const targetBytes = count * TARGET_STRIDE * 4;

  return {
    count,
    particleA: device.createBuffer({
      label: 'particleA', size: particleBytes, usage: U.STORAGE | U.COPY_DST,
    }),
    particleB: device.createBuffer({
      label: 'particleB', size: particleBytes, usage: U.STORAGE | U.COPY_DST,
    }),
    targets: device.createBuffer({
      label: 'targets', size: targetBytes, usage: U.STORAGE | U.COPY_DST,
    }),
    uniforms: device.createBuffer({
      label: 'uniforms', size: UNIFORMS.SIZE, usage: U.UNIFORM | U.COPY_DST,
    }),
    drawArgs: device.createBuffer({
      label: 'drawArgs', size: DRAW_ARGS.SIZE, usage: U.INDIRECT | U.STORAGE | U.COPY_DST,
    }),
  };
}

export async function createPipelines(device, format) {
  const S = globalThis.GPUShaderStage ?? { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };

  const computeLayout = device.createBindGroupLayout({
    label: 'compute-layout',
    entries: [
      { binding: 0, visibility: S.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: S.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: S.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: S.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 4, visibility: S.COMPUTE, buffer: { type: 'storage' } },
    ],
  });

  const renderLayout = device.createBindGroupLayout({
    label: 'render-layout',
    entries: [
      { binding: 0, visibility: S.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: S.VERTEX, buffer: { type: 'uniform' } },
    ],
  });

  const computeShader = await compile(device, COMPUTE_WGSL, 'compute');
  if (computeShader.errors.length) {
    throw tagged('shader', 'Compute shader failed to compile', computeShader.text);
  }
  const renderShader = await compile(device, RENDER_WGSL, 'render');
  if (renderShader.errors.length) {
    throw tagged('shader', 'Render shader failed to compile', renderShader.text);
  }

  const compute = device.createComputePipeline({
    label: 'integrate',
    layout: device.createPipelineLayout({ bindGroupLayouts: [computeLayout] }),
    compute: { module: computeShader.module, entryPoint: 'main' },
  });

  const render = device.createRenderPipeline({
    label: 'points',
    layout: device.createPipelineLayout({ bindGroupLayouts: [renderLayout] }),
    // No buffers entry: the vertex stage indexes the storage buffer by
    // vertex_index, so there is no attribute layout to declare. SPEC §5.1.
    vertex: { module: renderShader.module, entryPoint: 'vs' },
    fragment: {
      module: renderShader.module,
      entryPoint: 'fs',
      targets: [{
        format,
        // Additive, which is order-independent and therefore needs no depth
        // sort. SPEC §5.2.
        blend: {
          color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        },
      }],
    },
    primitive: { topology: 'point-list' },
    // depthStencil deliberately absent — see SPEC §5.2.
  });

  return { compute, render, computeLayout, renderLayout };
}

/**
 * Build the two compute bind groups — one per frame parity — and the two
 * render bind groups.
 *
 * Called exactly once, at init. Creating bind groups inside the frame loop is
 * the most common WebGPU performance mistake; this signature exists so that
 * mistake is structurally impossible. pipeline.test.mjs asserts the call count.
 * SPEC §4.4.
 */
export function createBindGroups(device, layouts, buffers) {
  const { particleA, particleB, targets, uniforms, drawArgs } = buffers;

  const computeGroup = (label, inBuf, outBuf) => device.createBindGroup({
    label,
    layout: layouts.computeLayout,
    entries: [
      { binding: 0, resource: { buffer: inBuf } },
      { binding: 1, resource: { buffer: outBuf } },
      { binding: 2, resource: { buffer: targets } },
      { binding: 3, resource: { buffer: uniforms } },
      { binding: 4, resource: { buffer: drawArgs } },
    ],
  });

  const renderGroup = (label, buf) => device.createBindGroup({
    label,
    layout: layouts.renderLayout,
    entries: [
      { binding: 0, resource: { buffer: buf } },
      { binding: 1, resource: { buffer: uniforms } },
    ],
  });

  // Even frames read A and write B, so the render pass must read B. Getting
  // this pair backwards is invisible on a static swarm and shows up only as one
  // frame of lag under motion. SPEC §4.4.
  return {
    compute: [
      computeGroup('compute-even', particleA, particleB),
      computeGroup('compute-odd', particleB, particleA),
    ],
    render: [
      renderGroup('render-even', particleB),
      renderGroup('render-odd', particleA),
    ],
  };
}

/**
 * Seed the particle buffers with starting positions and per-particle RNG seeds.
 * Written once; after this the CPU never touches particle memory. SPEC §1.1.
 */
export function seedParticles(device, buffer, count, targets) {
  const data = new Float32Array(count * PARTICLE_FLOATS);

  for (let i = 0; i < count; i++) {
    const o = i * PARTICLE_FLOATS;
    // Start on the target so the first frame does not fling everything inward
    // from the origin, plus a little scatter so the swarm has somewhere to
    // settle from.
    const t = i * TARGET_STRIDE;
    const jitter = 0.35;
    data[o + 0] = (targets ? targets[t + 0] : 0) + (Math.random() * 2 - 1) * jitter;
    data[o + 1] = (targets ? targets[t + 1] : 0) + (Math.random() * 2 - 1) * jitter;
    data[o + 2] = (targets ? targets[t + 2] : 0) + (Math.random() * 2 - 1) * jitter;
    data[o + 3] = i / count;       // seed, never mutated
    data[o + 4] = 0;               // vel.x
    data[o + 5] = 0;               // vel.y
    data[o + 6] = 0;               // vel.z
    data[o + 7] = 0;               // life
  }

  device.queue.writeBuffer(buffer, 0, data);
  return data;
}

/**
 * Write the shape targets. Called on shape change only — never per frame.
 * Writing per frame would reintroduce the 32 MiB/frame upload this design
 * exists to remove. SPEC §3.2.
 */
export function writeTargets(device, buffer, targets) {
  device.queue.writeBuffer(buffer, 0, targets);
}

/**
 * Encode and submit one frame: compute pass, then render pass, in one
 * submission so WebGPU orders them without an explicit fence.
 *
 * `frame & 1` selects the bind group parity. A swapped parity is invisible on
 * a static swarm and shows up only as one frame of lag under motion, which is
 * why pipeline.test.mjs asserts the render pass reads the buffer the compute
 * pass just wrote. SPEC §4.4.
 */
export function encodeFrame(device, ctx, res, frame) {
  const parity = frame & 1;
  const count = res.count ?? 0;

  // The only CPU to GPU traffic on the per-frame path: 128 bytes, independent
  // of particle count. SPEC §10.
  packUniforms(res.state ?? {}, res.uniformData);
  device.queue.writeBuffer(res.buffers?.uniforms, 0, new Uint8Array(res.uniformData));

  const encoder = device.createCommandEncoder({ label: `frame-${frame}` });

  const cpass = encoder.beginComputePass({ label: 'integrate' });
  cpass.setPipeline(res.pipelines?.compute);
  cpass.setBindGroup(0, res.bindGroups?.compute?.[parity]);
  cpass.dispatchWorkgroups(workgroupCount(count), 1, 1);
  cpass.end();

  const view = ctx?.getCurrentTexture ? ctx.getCurrentTexture().createView() : undefined;
  const rpass = encoder.beginRenderPass({
    label: 'points',
    colorAttachments: [{
      view,
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
      loadOp: 'clear',
      storeOp: 'store',
    }],
  });
  rpass.setPipeline(res.pipelines?.render);
  rpass.setBindGroup(0, res.bindGroups?.render?.[parity]);
  // Indirect rather than draw(count): the count comes from the buffer the
  // compute shader wrote, so a future culling pass needs no CPU round-trip.
  // SPEC §5.3.
  rpass.drawIndirect(res.buffers?.drawArgs, 0);
  rpass.end();

  device.queue.submit([encoder.finish()]);
}

/**
 * Tear down every GPU resource. Called on device loss before re-init.
 * SPEC §2.3.
 */
export function destroyAll(buffers) {
  if (!buffers) return;
  for (const key of ['particleA', 'particleB', 'targets', 'uniforms', 'drawArgs']) {
    const b = buffers[key];
    if (b && typeof b.destroy === 'function') b.destroy();
  }
}

/**
 * Wire device-loss recovery.
 *
 * device.lost is a promise that resolves once, not a repeating event.
 * Re-awaiting a resolved promise returns immediately, so a retry loop must
 * request a fresh device rather than await the same promise again. A loss
 * during the first init is a hard failure — retrying a device that never
 * worked loops forever. SPEC §2.3.
 */
export function onDeviceLost(device, handler) {
  if (!device?.lost || typeof device.lost.then !== 'function') return;
  device.lost.then((info) => {
    // 'destroyed' means we called device.destroy() ourselves during teardown;
    // treating that as a crash would restart the app on every normal exit.
    if (info?.reason === 'destroyed') return;
    handler(info);
  });
}

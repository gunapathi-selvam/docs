// Test doubles and assertion helpers.
//
// Two distinct fakes live here:
//   - a recording GPUDevice, so gpu.js can be driven and its call sequence
//     asserted without a GPU (SPEC §7.2)
//   - a minimal DOM parsed from the real index.html, so boot wiring can be
//     asserted against the markup that actually ships (same approach as
//     galaxy-spiral/tests/harness.mjs)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- assertions
// run.mjs counts lines beginning PASS / FAIL, and echoes lines beginning
// '--- ' as section context. Keep those three prefixes exact.

let passed = 0, failed = 0;

export function section(name) {
  console.log(`--- ${name}`);
}

export function ok(label, cond) {
  if (cond) { passed++; console.log(`PASS ${label}`); }
  else { failed++; console.log(`FAIL ${label}`); }
  return cond;
}

export function eq(label, actual, expected) {
  const same = Object.is(actual, expected);
  if (same) { passed++; console.log(`PASS ${label}`); }
  else { failed++; console.log(`FAIL ${label}  expected ${expected}, got ${actual}`); }
  return same;
}

export function near(label, actual, expected, tol = 1e-6) {
  const within = Number.isFinite(actual) && Math.abs(actual - expected) <= tol;
  if (within) { passed++; console.log(`PASS ${label}`); }
  else { failed++; console.log(`FAIL ${label}  expected ${expected} +/- ${tol}, got ${actual}`); }
  return within;
}

/** Assert that `fn` throws. Used heavily while the modules are skeletons. */
export function throws(label, fn) {
  try { fn(); }
  catch { passed++; console.log(`PASS ${label}`); return true; }
  failed++; console.log(`FAIL ${label}  expected a throw`);
  return false;
}

export function finish() {
  console.log(`--- ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ------------------------------------------------------------ recording GPU
// Records every call so the suite can assert on the sequence rather than on
// pixels. Buffers carry their creation args; writeBuffer records sizes, which
// is how the "128 bytes per frame, never 32 MiB" invariant of SPEC §10 is
// checked structurally instead of by timing.

export function createFakeDevice(limits = {}) {
  const calls = [];
  const record = (name, args) => { calls.push({ name, args }); };

  const makeBuffer = (desc) => ({
    __kind: 'buffer',
    label: desc.label,
    size: desc.size,
    usage: desc.usage,
    destroyed: false,
    destroy() { this.destroyed = true; record('buffer.destroy', { label: this.label }); },
  });

  const encoder = () => ({
    __kind: 'encoder',
    beginComputePass(desc) {
      record('beginComputePass', desc);
      return {
        setPipeline: (p) => record('compute.setPipeline', { label: p?.label }),
        setBindGroup: (i, g) => record('compute.setBindGroup', { index: i, label: g?.label }),
        dispatchWorkgroups: (x, y, z) => record('dispatchWorkgroups', { x, y, z }),
        end: () => record('compute.end', {}),
      };
    },
    beginRenderPass(desc) {
      record('beginRenderPass', desc);
      return {
        setPipeline: (p) => record('render.setPipeline', { label: p?.label }),
        setBindGroup: (i, g) => record('render.setBindGroup', { index: i, label: g?.label }),
        draw: (n) => record('draw', { count: n }),
        drawIndirect: (b, off) => record('drawIndirect', { label: b?.label, offset: off }),
        end: () => record('render.end', {}),
      };
    },
    finish: () => ({ __kind: 'commandBuffer' }),
  });

  const device = {
    __kind: 'device',
    limits: {
      maxStorageBufferBindingSize: 128 * 1024 * 1024,
      maxComputeWorkgroupSizeX: 256,
      maxTextureDimension2D: 8192,
      ...limits,
    },
    lost: new Promise(() => {}),
    queue: {
      writeBuffer(buffer, offset, data) {
        const size = data?.byteLength ?? data?.length ?? 0;
        record('writeBuffer', { label: buffer?.label, offset, size });
      },
      submit(list) { record('submit', { count: list.length }); },
    },
    createBuffer(desc) { record('createBuffer', desc); return makeBuffer(desc); },
    createBindGroup(desc) {
      record('createBindGroup', desc);
      return { __kind: 'bindGroup', label: desc.label, entries: desc.entries };
    },
    createBindGroupLayout(desc) { record('createBindGroupLayout', desc); return { __kind: 'bindGroupLayout' }; },
    createPipelineLayout(desc) { record('createPipelineLayout', desc); return { __kind: 'pipelineLayout' }; },
    createShaderModule(desc) {
      record('createShaderModule', { label: desc.label, length: desc.code?.length ?? 0 });
      return {
        __kind: 'shaderModule',
        label: desc.label,
        code: desc.code,
        compilationInfo: async () => ({ messages: [] }),
      };
    },
    createComputePipeline(desc) { record('createComputePipeline', desc); return { __kind: 'computePipeline', label: desc.label }; },
    createRenderPipeline(desc) { record('createRenderPipeline', desc); return { __kind: 'renderPipeline', label: desc.label }; },
    createCommandEncoder(desc) { record('createCommandEncoder', desc ?? {}); return encoder(); },
    pushErrorScope(kind) { record('pushErrorScope', { kind }); },
    popErrorScope: async () => { record('popErrorScope', {}); return null; },
    destroy() { record('device.destroy', {}); },
  };

  return {
    device,
    calls,
    of: (name) => calls.filter((c) => c.name === name),
    countOf: (name) => calls.filter((c) => c.name === name).length,
    reset: () => { calls.length = 0; },
  };
}

/**
 * Fake GPUCanvasContext. encodeFrame needs a texture view for the colour
 * attachment; without this the render pass is encoded against `undefined` and
 * the parity assertions cannot distinguish a real attachment from a missing one.
 */
export function createFakeContext(rec) {
  return {
    __kind: 'canvasContext',
    configure(desc) { rec?.calls.push({ name: 'ctx.configure', args: { format: desc?.format } }); },
    unconfigure() {},
    getCurrentTexture() {
      return { createView: () => ({ __kind: 'textureView' }) };
    },
  };
}

/**
 * A complete resource bundle wired from the fake device, matching what boot()
 * hands encodeFrame. Built through the real createBuffers / createPipelines /
 * createBindGroups so the parity labels under test are the ones production
 * uses, not fixtures invented here.
 */
export async function createFakeResources(rec, count = 4096) {
  const gpu = await import('../src/js/gpu.js');
  const { UNIFORMS } = await import('../src/js/layout.js');

  const pipelines = await gpu.createPipelines(rec.device, 'bgra8unorm');
  const buffers = gpu.createBuffers(rec.device, count);
  const bindGroups = gpu.createBindGroups(rec.device, pipelines, buffers);

  return {
    count,
    buffers,
    pipelines,
    bindGroups,
    uniformData: new ArrayBuffer(UNIFORMS.SIZE),
    state: {
      viewProj: new Float32Array(16),
      dt: 1 / 60, stiffness: 13, damping: 0.88, time: 0,
      grabPoint: [0, 0, 0], grabRadius: 0, grabForce: 0, drift: 0.2,
      count,
    },
  };
}

/** Fake navigator.gpu. `mode` forces the failure paths of SPEC §9. */
export function createFakeNavigatorGpu(mode = 'ok', limits = {}) {
  if (mode === 'no-gpu') return undefined;
  const rec = createFakeDevice(limits);
  return {
    __rec: rec,
    getPreferredCanvasFormat: () => 'bgra8unorm',
    requestAdapter: async () => {
      if (mode === 'no-adapter') return null;
      return {
        limits: rec.device.limits,
        info: { vendor: 'fake', architecture: 'test' },
        requestDevice: async () => {
          if (mode === 'no-device') throw new Error('requestDevice failed');
          return rec.device;
        },
      };
    },
  };
}

// ------------------------------------------------------------------ fake DOM
// Parsed from the real index.html so the suite cannot drift from the shipped
// markup: renaming an id in the HTML must break the boot suite.

const HTML_PATH = fileURLToPath(new URL('../index.html', import.meta.url));

export function readIndexHtml() {
  return readFileSync(HTML_PATH, 'utf8');
}

/** Ids present in index.html, in document order. */
export function idsInHtml(html = readIndexHtml()) {
  return [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
}

/** data-shape values present in index.html. */
export function shapeButtonsInHtml(html = readIndexHtml()) {
  return [...html.matchAll(/data-shape="(\d+)"/g)].map((m) => Number(m[1]));
}

/**
 * Minimal document backed by the ids found in index.html. Elements record
 * listeners and attribute writes so boot wiring can be asserted without a
 * real DOM implementation.
 */
export function createFakeDom(html = readIndexHtml()) {
  const make = (id) => ({
    id,
    hidden: false,
    textContent: '',
    value: '',
    clientWidth: 1280,
    clientHeight: 720,
    width: 0,
    height: 0,
    dataset: {},
    attributes: {},
    listeners: {},
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k] ?? null; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    setPointerCapture() {},
    appendChild(c) { this.children.push(c); return c; },
    querySelectorAll: () => [],
    getContext: () => null,
  });

  const byId = new Map(idsInHtml(html).map((id) => [id, make(id)]));

  // The shape chips are queried by attribute rather than by id, so the group
  // needs real children or the click wiring cannot be asserted.
  const chips = byId.get('shapes');
  if (chips) {
    const buttons = shapeButtonsInHtml(html).map((n) => {
      const b = make(`shape-${n}`);
      b.dataset.shape = String(n);
      return b;
    });
    chips.children = buttons;
    chips.querySelectorAll = (sel) => (sel === '[data-shape]' ? buttons : []);
  }

  return {
    __byId: byId,
    documentElement: make('html'),
    body: make('body'),
    getElementById: (id) => byId.get(id) ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => make(`created:${tag}`),
    addEventListener() {},
  };
}

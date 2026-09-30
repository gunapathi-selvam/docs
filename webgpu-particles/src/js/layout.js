// Byte layout of the GPU structs. These constants are the single source of
// truth shared by the WGSL in shaders.js and the CPU-side buffer writers.
// SPEC §3.1, §3.3.

// Particle: 32 bytes. vec3<f32> has 16-byte alignment in a storage buffer, so
// a bare {pos: vec3, vel: vec3} would also cost 32 with 8 wasted. seed and
// life occupy the slack for free.
export const PARTICLE = {
  SIZE: 32,
  ALIGN: 16,
  POS: 0,
  SEED: 12,
  VEL: 16,
  LIFE: 28,
};

export const PARTICLE_FLOATS = PARTICLE.SIZE / 4;

export const UNIFORMS = {
  SIZE: 128,
  VIEW_PROJ: 0,
  DT: 64,
  STIFFNESS: 68,
  DAMPING: 72,
  TIME: 76,
  GRAB_POINT: 80,
  GRAB_RADIUS: 92,
  GRAB_FORCE: 96,
  DRIFT: 100,
  COUNT: 104,
};

// [vertexCount, instanceCount, firstVertex, firstInstance] as four u32.
// Layout is mandated by WebGPU, not chosen. SPEC §5.3.
export const DRAW_ARGS = {
  SIZE: 16,
  VERTEX_COUNT: 0,
  INSTANCE_COUNT: 4,
  FIRST_VERTEX: 8,
  FIRST_INSTANCE: 12,
};

export const WORKGROUP_SIZE = 256;

export const COUNT_MIN = 1 << 10;
export const COUNT_MAX = 1 << 22;
export const COUNT_DEFAULT = 1 << 20;

/**
 * Number of workgroups needed to cover `count` particles.
 * The last group is partially out of range, which is why the shader must
 * bounds-check. SPEC §4.2.
 */
export function workgroupCount(count) {
  return Math.ceil(count / WORKGROUP_SIZE);
}

/**
 * Byte size of one particle buffer for `count` particles.
 */
export function particleBufferSize(count) {
  return count * PARTICLE.SIZE;
}

/**
 * Clamp a requested particle count into [COUNT_MIN, COUNT_MAX] and against the
 * adapter's maxStorageBufferBindingSize. Returns the usable count.
 */
export function clampCount(requested, maxStorageBufferBindingSize = Infinity) {
  let n = Number.isFinite(requested) ? Math.floor(requested) : COUNT_DEFAULT;
  n = Math.max(COUNT_MIN, Math.min(COUNT_MAX, n));

  // The targets buffer has the same element count at 16 bytes per entry, so the
  // particle buffer at 32 bytes is always the binding that runs out first.
  const affordable = Math.floor(maxStorageBufferBindingSize / PARTICLE.SIZE);
  if (Number.isFinite(affordable) && n > affordable) n = affordable;

  return Math.max(0, n);
}

/**
 * Pack the uniform block into a 128-byte ArrayBuffer per SPEC §3.3.
 * `state` carries viewProj, dt, stiffness, damping, time, grab, drift, count.
 *
 * `out` is reused across frames by the caller — this is the only allocation on
 * the per-frame path, and it happens once.
 */
export function packUniforms(state, out = new ArrayBuffer(UNIFORMS.SIZE)) {
  const dv = new DataView(out);
  const vp = state.viewProj;

  for (let i = 0; i < 16; i++) {
    dv.setFloat32(UNIFORMS.VIEW_PROJ + i * 4, vp ? vp[i] : 0, true);
  }

  dv.setFloat32(UNIFORMS.DT, state.dt ?? 0, true);
  dv.setFloat32(UNIFORMS.STIFFNESS, state.stiffness ?? 13, true);
  dv.setFloat32(UNIFORMS.DAMPING, state.damping ?? 0.88, true);
  dv.setFloat32(UNIFORMS.TIME, state.time ?? 0, true);

  const g = state.grabPoint ?? [0, 0, 0];
  dv.setFloat32(UNIFORMS.GRAB_POINT + 0, g[0] ?? 0, true);
  dv.setFloat32(UNIFORMS.GRAB_POINT + 4, g[1] ?? 0, true);
  dv.setFloat32(UNIFORMS.GRAB_POINT + 8, g[2] ?? 0, true);

  dv.setFloat32(UNIFORMS.GRAB_RADIUS, state.grabRadius ?? 0, true);
  dv.setFloat32(UNIFORMS.GRAB_FORCE, state.grabForce ?? 0, true);
  dv.setFloat32(UNIFORMS.DRIFT, state.drift ?? 0, true);

  // u32, not f32 — the shader declares count as u32 and a float bit pattern
  // read as an integer is a plausible-looking but wrong particle count.
  dv.setUint32(UNIFORMS.COUNT, state.count ?? 0, true);

  return out;
}

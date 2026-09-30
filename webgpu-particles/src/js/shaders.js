// WGSL kept as template strings so Node can read and assert on the source
// without a GPU. tests/pipeline.test.mjs greps this text for the four guards
// of SPEC §7.3 — each one corresponds to a bug that produces no error, no
// warning, and no obvious visual artifact.

export const PARTICLE_STRUCT = /* wgsl */ `
struct Particle {
  pos  : vec3<f32>,
  seed : f32,
  vel  : vec3<f32>,
  life : f32,
}

struct Uniforms {
  viewProj   : mat4x4<f32>,
  dt         : f32,
  stiffness  : f32,
  damping    : f32,
  time       : f32,
  grabPoint  : vec3<f32>,
  grabRadius : f32,
  grabForce  : f32,
  drift      : f32,
  count      : u32,
  _pad       : f32,
}

struct DrawArgs {
  vertexCount   : u32,
  instanceCount : u32,
  firstVertex   : u32,
  firstInstance : u32,
}
`;

export const COMPUTE_WGSL = /* wgsl */ `
${PARTICLE_STRUCT}

@group(0) @binding(0) var<storage, read>       inParticles  : array<Particle>;
@group(0) @binding(1) var<storage, read_write> outParticles : array<Particle>;
@group(0) @binding(2) var<storage, read>       targets      : array<vec4<f32>>;
@group(0) @binding(3) var<uniform>             u            : Uniforms;
@group(0) @binding(4) var<storage, read_write> drawArgs     : DrawArgs;

fn hash11(p: f32) -> f32 {
  var h = fract(p * 0.1031);
  h *= h + 33.33;
  h *= h + h;
  return fract(h);
}

@compute @workgroup_size(256, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;

  // GUARD 1 (SPEC §4.2). dispatchWorkgroups uses ceil(count / 256), so the
  // final workgroup runs past the live region. Without this return those
  // invocations write inside our own allocation: no crash, no validation
  // error, just simulated particles that are never drawn.
  if (i >= u.count) { return; }

  // Invocation 0 owns the indirect draw args. GUARD 4 (SPEC §5.3): letting
  // every invocation write them is a benign race in value but 2^20 redundant
  // writes to one address, which serialises on some drivers.
  //
  // instanceCount MUST be written, not just vertexCount. WebGPU zero-fills a
  // new buffer, and drawIndirect with instanceCount == 0 draws nothing at all
  // — legally, so there is no validation error and no warning. The result is a
  // completely blank canvas while the compute pass runs, frame times look
  // healthy, and every test still passes. Nothing about the symptom points at
  // this line.
  if (i == 0u) {
    drawArgs.vertexCount   = u.count;
    drawArgs.instanceCount = 1u;
    drawArgs.firstVertex   = 0u;
    drawArgs.firstInstance = 0u;
  }

  var p = inParticles[i];
  // Named goal, not target: "target" is a WGSL reserved keyword and the module
  // fails to parse with it. The failure is total and silent from the page's
  // point of view — no compute pipeline, so every frame submits an invalid
  // command buffer while the render pass still draws the seeded positions,
  // which looks like a working but frozen field.
  //
  // No backticks in this comment: the whole shader lives in a JS template
  // literal, and a backtick here ends it silently mid-string.
  let goal = targets[i].xyz;

  // Spring toward the shape target.
  var accel = (goal - p.pos) * u.stiffness;

  // Grab: inverse-square with a floor, gated on the radius. SPEC §4.5.
  let d = u.grabPoint - p.pos;
  let r2 = dot(d, d);
  // GUARD 2 (SPEC §4.5). normalize() of a zero vector is undefined; the max()
  // below clamps magnitude, not direction, so it does not cover this.
  // select(false_value, true_value, cond) — argument order is the reverse of
  // a C ternary.
  let dir = select(vec3<f32>(0.0), normalize(d), r2 > 1e-8);
  let pull = u.grabForce / max(r2, 0.02);
  let inRange = step(r2, u.grabRadius * u.grabRadius);
  accel += dir * pull * inRange;

  // Drift: three decorrelated sines, not a per-frame hash. A fresh hash each
  // frame is white noise and reads as jitter rather than breathing. SPEC §4.6.
  let s = p.seed;
  accel += vec3<f32>(
    sin(u.time * 0.7 + s * 6.28318),
    sin(u.time * 0.9 + s * 9.42477),
    sin(u.time * 1.1 + s * 3.14159)
  ) * u.drift;

  // GUARD 3 (SPEC §4.3). pow(damping, dt * 60) keeps settle time independent
  // of frame rate. A bare multiply by damping couples the decay rate to the
  // frame rate; it is shorter and reads as a cleanup, which is why it is
  // guarded by a test rather than left to reviewer discipline.
  p.vel = (p.vel + accel * u.dt) * pow(u.damping, u.dt * 60.0);
  p.pos = p.pos + p.vel * u.dt;

  // life drives the colour ramp: normalised speed, eased.
  p.life = clamp(length(p.vel) * 0.35, 0.0, 1.0);

  outParticles[i] = p;
}
`;

export const RENDER_WGSL = /* wgsl */ `
${PARTICLE_STRUCT}

@group(0) @binding(0) var<storage, read> particles : array<Particle>;
@group(0) @binding(1) var<uniform>       u         : Uniforms;

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0)       tint : vec3<f32>,
}

// Palette ramp. Evaluated per vertex rather than uploaded as a texture: three
// mixes are cheaper than a sampler fetch and there is nothing to filter.
fn ramp(t: f32) -> vec3<f32> {
  let cool = vec3<f32>(0.14, 0.36, 0.82);
  let mid  = vec3<f32>(0.52, 0.34, 0.86);
  let hot  = vec3<f32>(0.98, 0.72, 0.42);
  return select(
    mix(cool, mid, t * 2.0),
    mix(mid, hot, (t - 0.5) * 2.0),
    t > 0.5
  );
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  // No vertex buffer and no attribute layout — the storage buffer is indexed
  // directly by vertex_index. SPEC §5.1.
  let p = particles[vi];
  var out: VsOut;
  out.clip = u.viewProj * vec4<f32>(p.pos, 1.0);
  out.tint = ramp(p.life);
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  // Additive blending is configured on the pipeline, so alpha here is the
  // contribution weight rather than an opacity. Order-independent, which is
  // what makes depth sorting unnecessary. SPEC §5.2.
  return vec4<f32>(in.tint, 1.0);
}
`;

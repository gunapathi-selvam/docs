// Target-position generators. Pure: every function fills a caller-supplied
// Float32Array and touches nothing else, which is what makes them testable in
// Node without a GPU. SPEC §6.
//
// Targets are written as vec4 (stride 4 floats) rather than vec3, because a
// vec3 array in a WGSL storage buffer is padded to 16 bytes per element
// anyway — writing vec4 makes the JS stride match the GPU stride exactly and
// removes a whole class of off-by-one indexing bug.

export const TARGET_STRIDE = 4;

export const SHAPES = [
  { key: '1', id: 'core', name: 'Core' },
  { key: '2', id: 'sphere', name: 'Sphere' },
  { key: '3', id: 'torus', name: 'Torus' },
  { key: '4', id: 'cube', name: 'Cube' },
  { key: '5', id: 'helix', name: 'Helix' },
  { key: '6', id: 'galaxy', name: 'Galaxy' },
  { key: '7', id: 'ringed', name: 'Ringed' },
  { key: '8', id: 'wave', name: 'Wave' },
];

export const MAX_RESIDENT = 4;

const TAU = Math.PI * 2;

/**
 * Deterministic PRNG. Generators must be reproducible for a fixed seed so the
 * suite can assert exact bounding radii rather than statistical ranges.
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function put(out, i, x, y, z) {
  const o = i * TARGET_STRIDE;
  out[o] = x;
  out[o + 1] = y;
  out[o + 2] = z;
  out[o + 3] = 1;
}

/** Dense jittered ball, radius 0.26. */
export function core(out, count, rand) {
  for (let i = 0; i < count; i++) {
    // Direction from a normalised Gaussian-ish triple, radius from cbrt so the
    // result is uniform by volume rather than piling up at the centre.
    const u = rand() * 2 - 1;
    const th = rand() * TAU;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    const r = 0.26 * Math.cbrt(rand());
    put(out, i, Math.cos(th) * s * r, u * r, Math.sin(th) * s * r);
  }
  return out;
}

/** Fibonacci sphere — even angular coverage without clustering at the poles. */
export function sphere(out, count, rand) {
  const R = 0.85;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const span = Math.max(1, count - 1);
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / span) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * i;
    put(out, i, Math.cos(th) * r * R, y * R, Math.sin(th) * r * R);
  }
  return out;
}

/** Torus, R 0.82, r 0.32. */
export function torus(out, count, rand) {
  const R = 0.82;
  const r = 0.32;
  for (let i = 0; i < count; i++) {
    const u = rand() * TAU;
    const v = rand() * TAU;
    const ring = R + r * Math.cos(v);
    put(out, i, Math.cos(u) * ring, r * Math.sin(v), Math.sin(u) * ring);
  }
  return out;
}

/** Uniform points across six faces. */
export function cube(out, count, rand) {
  const s = 0.62;
  for (let i = 0; i < count; i++) {
    const face = Math.min(5, Math.floor(rand() * 6));
    const a = (rand() * 2 - 1) * s;
    const b = (rand() * 2 - 1) * s;
    if (face === 0) put(out, i, s, a, b);
    else if (face === 1) put(out, i, -s, a, b);
    else if (face === 2) put(out, i, a, s, b);
    else if (face === 3) put(out, i, a, -s, b);
    else if (face === 4) put(out, i, a, b, s);
    else put(out, i, a, b, -s);
  }
  return out;
}

/** Double helix, rungs every 9th point. */
export function helix(out, count, rand) {
  const R = 0.5;
  const H = 0.72;
  const turns = 3;
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0;
    const y = (t * 2 - 1) * H;
    const ang = t * TAU * turns;
    if (i % 9 === 8) {
      // Rung: interpolate across the two strands rather than sitting on one.
      const k = rand() * 2 - 1;
      put(out, i, Math.cos(ang) * R * k, y, Math.sin(ang) * R * k);
    } else {
      const strand = i % 2 === 0 ? 0 : Math.PI;
      put(out, i, Math.cos(ang + strand) * R, y, Math.sin(ang + strand) * R);
    }
  }
  return out;
}

/** Four arms, sqrt radial density so the core stays dense. */
export function galaxy(out, count, rand) {
  const arms = 4;
  const maxR = 1.1;
  const twist = 2.4;
  for (let i = 0; i < count; i++) {
    // sqrt of a uniform gives areal density that falls off with radius, which
    // is what makes the core read as a bulge instead of a flat disc.
    const t = Math.sqrt(rand());
    const r = t * maxR;
    const arm = (i % arms) * (TAU / arms);
    // Two samples summed approximate a normal well enough for arm scatter.
    const scatter = (rand() + rand() - 1) * 0.28 * (1 - t * 0.55);
    const ang = arm + t * twist + scatter;
    const y = (rand() + rand() - 1) * 0.07 * (1 - t * 0.5);
    put(out, i, Math.cos(ang) * r, y, Math.sin(ang) * r);
  }
  return out;
}

/** Planet plus debris halo. */
export function ringed(out, count, rand) {
  const planetR = 0.38;
  const inner = 0.62;
  const outer = 1.05;
  for (let i = 0; i < count; i++) {
    if (i % 3 === 0) {
      const u = rand() * 2 - 1;
      const th = rand() * TAU;
      const s = Math.sqrt(Math.max(0, 1 - u * u));
      const r = planetR * Math.cbrt(rand());
      put(out, i, Math.cos(th) * s * r, u * r, Math.sin(th) * s * r);
    } else {
      const th = rand() * TAU;
      const r = inner + rand() * (outer - inner);
      const y = (rand() + rand() - 1) * 0.02;
      put(out, i, Math.cos(th) * r, y, Math.sin(th) * r);
    }
  }
  return out;
}

/** Grid with sine displacement. */
export function wave(out, count, rand) {
  const side = Math.max(1, Math.ceil(Math.sqrt(count)));
  const extent = 0.9;
  for (let i = 0; i < count; i++) {
    const gx = i % side;
    const gz = Math.floor(i / side);
    const x = (gx / side - 0.5) * 2 * extent;
    const z = (gz / side - 0.5) * 2 * extent;
    put(out, i, x, Math.sin(x * 3) * Math.cos(z * 3) * 0.18, z);
  }
  return out;
}

export const GENERATORS = { core, sphere, torus, cube, helix, galaxy, ringed, wave };

/**
 * Generate one shape into a new Float32Array of count * TARGET_STRIDE.
 * ~18 ms at 2^20 points, which is why callers cache rather than regenerate.
 */
export function generate(id, count, seed = 1) {
  const gen = GENERATORS[id];
  if (!gen) throw new Error(`Unknown shape id: ${id}`);
  const out = new Float32Array(count * TARGET_STRIDE);
  gen(out, count, mulberry32(seed));
  return out;
}

/**
 * LRU cache holding at most MAX_RESIDENT generated shapes. A cold shape costs
 * one generation; a resident one is free. Holding all eight at 2^20 would need
 * 256 MiB, which exceeds maxStorageBufferBindingSize on many adapters.
 * SPEC §6.1.
 */
export function createShapeCache(count, limit = MAX_RESIDENT) {
  // Map iterates in insertion order, so delete-then-set on a hit moves the
  // entry to the back and the front is always the least recently used.
  const entries = new Map();

  return {
    get(id, seed = 1) {
      if (entries.has(id)) {
        const hit = entries.get(id);
        entries.delete(id);
        entries.set(id, hit);
        return hit;
      }
      const made = generate(id, count, seed);
      entries.set(id, made);
      while (entries.size > limit) {
        entries.delete(entries.keys().next().value);
      }
      return made;
    },
    has: (id) => entries.has(id),
    size: () => entries.size,
    clear: () => entries.clear(),
  };
}

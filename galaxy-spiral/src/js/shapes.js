// Shape generators. Each fills a Float32Array of [x,y,z, x,y,z, ...] with
// points roughly inside a unit-ish sphere so shapes are visually comparable.

const TAU = Math.PI * 2;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

// Deterministic PRNG so a shape looks identical every time you return to it.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function sphere(out, n) {
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = GOLDEN * i;
    out[i * 3] = Math.cos(theta) * r;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = Math.sin(theta) * r;
  }
}

function galaxy(out, n) {
  const rand = rng(7);
  const arms = 4;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const arm = i % arms;
    // sqrt keeps the core dense and the rim sparse, like a real disc.
    const radius = Math.sqrt(t) * 1.25;
    const spin = radius * 3.1;
    const angle = (arm / arms) * TAU + spin;
    const scatter = (1 - t) * 0.12 + 0.05;
    const jx = (rand() - 0.5) * scatter * 2;
    const jy = (rand() - 0.5) * scatter * (0.5 + radius * 0.2);
    const jz = (rand() - 0.5) * scatter * 2;
    out[i * 3] = Math.cos(angle) * radius + jx;
    out[i * 3 + 1] = jy * 1.4 - 0.02;
    out[i * 3 + 2] = Math.sin(angle) * radius + jz;
  }
}

function torus(out, n) {
  const R = 0.82;
  const r = 0.32;
  for (let i = 0; i < n; i++) {
    const u = GOLDEN * i;
    const v = (i / n) * TAU * 11;
    out[i * 3] = (R + r * Math.cos(v)) * Math.cos(u);
    out[i * 3 + 1] = r * Math.sin(v);
    out[i * 3 + 2] = (R + r * Math.cos(v)) * Math.sin(u);
  }
}

function cube(out, n) {
  const rand = rng(21);
  const h = 0.78;
  for (let i = 0; i < n; i++) {
    const face = i % 6;
    const a = (rand() * 2 - 1) * h;
    const b = (rand() * 2 - 1) * h;
    let x, y, z;
    if (face === 0) { x = a; y = b; z = h; }
    else if (face === 1) { x = a; y = b; z = -h; }
    else if (face === 2) { x = a; y = h; z = b; }
    else if (face === 3) { x = a; y = -h; z = b; }
    else if (face === 4) { x = h; y = a; z = b; }
    else { x = -h; y = a; z = b; }
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
  }
}

function helix(out, n) {
  const turns = 3.2;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const strand = i % 2 === 0 ? 0 : Math.PI;
    const angle = t * TAU * turns + strand;
    // Every 9th point becomes a "rung" bridging the two strands.
    if (i % 9 === 0) {
      const k = ((i / 9) % 5) / 4 * 2 - 1;
      out[i * 3] = Math.cos(t * TAU * turns) * 0.55 * k;
      out[i * 3 + 1] = t * 2 - 1;
      out[i * 3 + 2] = Math.sin(t * TAU * turns) * 0.55 * k;
    } else {
      out[i * 3] = Math.cos(angle) * 0.55;
      out[i * 3 + 1] = t * 2 - 1;
      out[i * 3 + 2] = Math.sin(angle) * 0.55;
    }
  }
}

function core(out, n) {
  // Fist shape: a tight, dense ball of light.
  const rand = rng(99);
  for (let i = 0; i < n; i++) {
    const u = rand() * 2 - 1;
    const theta = rand() * TAU;
    const r = Math.cbrt(rand()) * 0.26;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    out[i * 3] = Math.cos(theta) * s * r;
    out[i * 3 + 1] = u * r;
    out[i * 3 + 2] = Math.sin(theta) * s * r;
  }
}

function ring(out, n) {
  const rand = rng(303);
  for (let i = 0; i < n; i++) {
    // ~22% form the planet, the rest the halo of debris.
    if (i % 9 < 2) {
      const u = rand() * 2 - 1;
      const theta = rand() * TAU;
      const rr = Math.cbrt(rand()) * 0.38;
      const s = Math.sqrt(Math.max(0, 1 - u * u));
      out[i * 3] = Math.cos(theta) * s * rr;
      out[i * 3 + 1] = u * rr;
      out[i * 3 + 2] = Math.sin(theta) * s * rr;
    } else {
      const angle = rand() * TAU;
      const rr = 0.72 + rand() * 0.55;
      out[i * 3] = Math.cos(angle) * rr;
      out[i * 3 + 1] = (rand() - 0.5) * 0.045;
      out[i * 3 + 2] = Math.sin(angle) * rr;
    }
  }
}

function grid(out, n) {
  const side = Math.ceil(Math.sqrt(n));
  for (let i = 0; i < n; i++) {
    const gx = (i % side) / (side - 1) * 2 - 1;
    const gz = Math.floor(i / side) / (side - 1) * 2 - 1;
    out[i * 3] = gx * 1.15;
    out[i * 3 + 1] = 0; // animated into a wave at runtime
    out[i * 3 + 2] = gz * 1.15;
  }
}

export const SHAPES = [
  { id: 'core', name: 'Core', hint: 'fist', fingers: 0, build: core },
  { id: 'sphere', name: 'Sphere', hint: '1 finger', fingers: 1, build: sphere },
  { id: 'torus', name: 'Torus', hint: '2 fingers', fingers: 2, build: torus },
  { id: 'cube', name: 'Cube', hint: '3 fingers', fingers: 3, build: cube },
  { id: 'helix', name: 'Helix', hint: '4 fingers', fingers: 4, build: helix },
  { id: 'galaxy', name: 'Galaxy Spiral', hint: 'open palm', fingers: 5, build: galaxy },
  { id: 'ring', name: 'Ringed World', hint: 'key 7', fingers: -1, build: ring },
  { id: 'grid', name: 'Wave Field', hint: 'key 8', fingers: -1, build: grid },
];

export const SHAPE_BY_FINGERS = new Map(
  SHAPES.filter((s) => s.fingers >= 0).map((s) => [s.fingers, s.id]),
);

export function buildShape(id, count) {
  const shape = SHAPES.find((s) => s.id === id) || SHAPES[0];
  const out = new Float32Array(count * 3);
  shape.build(out, count);
  return out;
}

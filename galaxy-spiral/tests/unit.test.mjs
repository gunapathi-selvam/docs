const base = new URL('../src/js/', import.meta.url).href;
const { ParticleField } = await import(base + 'particles.js');
const { SHAPES, buildShape } = await import(base + 'shapes.js');
const { readHand, pinchStrength, handSpan } = await import(base + 'gestures.js');

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + msg); if (!cond) fails++; };
const section = (s) => console.log('\n--- ' + s);

// ============================================================ shapes
section('shapes');
for (const s of SHAPES) {
  const pts = buildShape(s.id, 1000);
  let bad = 0, maxR = 0;
  for (let i = 0; i < 1000; i++) {
    const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) bad++;
    maxR = Math.max(maxR, Math.hypot(x, y, z));
  }
  ok(pts.length === 3000 && bad === 0 && maxR > 0.2 && maxR < 3,
    `${s.id.padEnd(7)} 1000 pts, finite, maxR=${maxR.toFixed(2)}`);
}

// ============================================================ physics
section('physics');
const f = new ParticleField(1000);
f.setShape('sphere');
for (let i = 0; i < 400; i++) f.update(1 / 60);
let err = 0, nan = 0;
for (let i = 0; i < 3000; i++) {
  if (!Number.isFinite(f.pos[i])) nan++;
  err += (f.pos[i] - f.target[i]) ** 2;
}
ok(nan === 0, 'no NaN after 400 steps');
ok(Math.sqrt(err / 3000) < 0.08, `settles onto target (rms ${Math.sqrt(err / 3000).toFixed(4)})`);

f.burst(8);
ok(f.vel.some((v) => Math.abs(v) > 1), 'burst injects outward velocity');
for (let i = 0; i < 600; i++) f.update(1 / 60);
const re = Math.sqrt(
  Array.from({ length: 3000 }, (_, i) => (f.pos[i] - f.target[i]) ** 2).reduce((a, b) => a + b) / 3000);
ok(re < 0.08, `swarm re-forms after burst (rms ${re.toFixed(4)})`);

const g = new ParticleField(1000);
g.setShape('sphere');
for (let i = 0; i < 200; i++) g.update(1 / 60);
g.attractor = { x: 0, y: 0, strength: 22 };
for (let i = 0; i < 200; i++) g.update(1 / 60);
let meanR = 0;
for (let i = 0; i < 1000; i++) meanR += Math.hypot(g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]);
meanR /= 1000;
ok(meanR < 0.85, `pinch attractor collapses cloud (mean radius ${meanR.toFixed(3)}, sphere is 1.0)`);

// ============================================================ render
section('render');
let arcs = 0, fills = 0, badCoord = 0;
const ctx = {
  globalCompositeOperation: '', fillStyle: '',
  fillRect() {}, clearRect() {}, beginPath() {}, moveTo() {},
  arc(x, y, r) { arcs++; if (![x, y, r].every(Number.isFinite) || r <= 0) badCoord++; },
  fill() { fills++; },
};
g.attractor = null;
for (let i = 0; i < 120; i++) g.update(1 / 60);
g.render(ctx, 1280, 720, { trails: true });
ok(arcs === 1000, `drew all 1000 dots (${arcs})`);
ok(badCoord === 0, 'every projected coord and radius is finite and positive');
ok(fills > 0 && fills < 120, `batched into ${fills} fill calls instead of 1000`);

// ============================================================ hand model
// Anatomically-shaped synthetic hand: joints walk outward from each knuckle,
// bending a few degrees per joint when extended and ~75 deg when curled.
const D = Math.PI / 180;
function walk(origin, angle, segs, bends) {
  const out = [];
  let [x, y] = origin, a = angle;
  for (let i = 0; i < segs.length; i++) {
    a += bends[i];
    x += Math.cos(a) * segs[i];
    y += Math.sin(a) * segs[i];
    out.push([x, y]);
  }
  return out;
}

const FINGERS = [
  { mcpAngle: -105 * D, mcpDist: 0.60, segs: [0.23, 0.15, 0.11] }, // index
  { mcpAngle: -90 * D, mcpDist: 0.62, segs: [0.25, 0.16, 0.11] },  // middle
  { mcpAngle: -76 * D, mcpDist: 0.59, segs: [0.23, 0.15, 0.11] },  // ring
  { mcpAngle: -63 * D, mcpDist: 0.54, segs: [0.19, 0.12, 0.10] },  // pinky
];

/** `raised` = [thumb, index, middle, ring, pinky]; `span` = wrist->middle-MCP. */
function makeHand({ raised = [1, 1, 1, 1, 1], cx = 0.5, cy = 0.5, span = 0.15, rot = 0 } = {}) {
  const L = [[0, 0]]; // wrist

  const thumbBase = walk([0, 0], -145 * D, [0.22], [0])[0];
  L.push(thumbBase);
  L.push(...walk(thumbBase, -145 * D, [0.20, 0.17, 0.13],
    raised[0] ? [0, 8 * D, 6 * D] : [30 * D, 72 * D, 66 * D]));

  for (let i = 0; i < 4; i++) {
    const { mcpAngle, mcpDist, segs } = FINGERS[i];
    const mcp = [Math.cos(mcpAngle) * mcpDist, Math.sin(mcpAngle) * mcpDist];
    L.push(mcp);
    L.push(...walk(mcp, mcpAngle, segs,
      raised[i + 1] ? [5 * D, 8 * D, 8 * D] : [72 * D, 80 * D, 62 * D]));
  }

  const k = span / 0.62; // local middle-MCP distance is 0.62
  const c = Math.cos(rot), s = Math.sin(rot);
  return L.map(([x, y]) => ({
    x: cx + (x * c - y * s) * k,
    y: cy + (x * s + y * c) * k,
    z: 0,
  }));
}

section('hand model sanity');
const ref = makeHand();
ok(ref.length === 21, `generator emits 21 landmarks (${ref.length})`);
ok(Math.abs(handSpan(ref) - 0.15) < 1e-6, `span parameter is honoured (${handSpan(ref).toFixed(4)})`);

// ============================================================ finger counting
section('finger counting');
for (let n = 0; n <= 5; n++) {
  // Raise index, middle, ring, pinky in order; the thumb joins last at 5.
  const raised = n === 5 ? [1, 1, 1, 1, 1] : [0, ...[0, 1, 2, 3].map((i) => (i < n ? 1 : 0))];
  const h = readHand(makeHand({ raised }));
  ok(h.fingers === n, `${n} raised -> counted ${h.fingers}   [${h.up.map(Number).join('')}]`);
}

const thumbsUp = readHand(makeHand({ raised: [1, 0, 0, 0, 0] }));
ok(thumbsUp.fingers === 1, `thumbs-up reads as 1 (${thumbsUp.fingers})`);

section('orientation independence');
for (const deg of [45, 90, 135, 180, 250, 320]) {
  const h = readHand(makeHand({ raised: [1, 1, 1, 1, 1], rot: deg * D }));
  ok(h.fingers === 5, `open palm rotated ${String(deg).padStart(3)}deg still reads 5 (${h.fingers})`);
}
for (const deg of [90, 180, 270]) {
  const h = readHand(makeHand({ raised: [0, 0, 0, 0, 0], rot: deg * D }));
  ok(h.fingers === 0, `fist rotated ${String(deg).padStart(3)}deg still reads 0 (${h.fingers})`);
}

// ============================================================ continuous axes
section('continuous controls');
const dRoll = Math.abs(readHand(makeHand({ rot: 0.6 })).roll - readHand(makeHand({ rot: 0 })).roll);
ok(Math.abs(dRoll - 0.6) < 0.08, `roll tracks wrist rotation (${dRoll.toFixed(3)} rad for 0.600)`);

const open = makeHand({ raised: [1, 1, 1, 1, 1] });
const pinched = open.map((p, i) => (i === 4 ? { ...open[8] } : p));
ok(pinchStrength(open) < 0.25, `open hand pinch ~0 (${pinchStrength(open).toFixed(2)})`);
ok(pinchStrength(pinched) > 0.9, `thumb on index pinch ~1 (${pinchStrength(pinched).toFixed(2)})`);
// A fist presses thumb and index together too; it must not read as a grab.
const fistLm = makeHand({ raised: [0, 0, 0, 0, 0] });
ok(pinchStrength(fistLm) === 0, `a closed fist is not a pinch (${pinchStrength(fistLm).toFixed(2)})`);
for (const deg of [0, 90, 200]) {
  const r = makeHand({ raised: [0, 0, 0, 0, 0], rot: deg * D });
  ok(pinchStrength(r) === 0, `fist rotated ${deg}deg is not a pinch (${pinchStrength(r).toFixed(2)})`);
}

const far = readHand(makeHand({ span: 0.09 }));
const mid = readHand(makeHand({ span: 0.15 }));
const near = readHand(makeHand({ span: 0.24 }));
ok(far.depth < mid.depth && mid.depth < near.depth && near.depth - far.depth > 0.5,
  `depth rises as hand nears lens (${far.depth.toFixed(2)} -> ${mid.depth.toFixed(2)} -> ${near.depth.toFixed(2)})`);
const scaleAt = (d) => 0.55 + d * 1.5; // mirrors main.js
ok(scaleAt(mid.depth) > 0.75 && scaleAt(mid.depth) < 1.35,
  `arm's-length hand maps to a natural scale (${scaleAt(mid.depth).toFixed(2)}x)`);

const L = readHand(makeHand({ cx: 0.2 })), R = readHand(makeHand({ cx: 0.8 }));
ok(R.center.x - L.center.x > 0.5, 'palm centre tracks horizontal position');

console.log(fails ? `\n${fails} FAILING\n` : '\nAll checks passed.\n');
process.exit(fails ? 1 : 0);

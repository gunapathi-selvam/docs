const base = new URL('../src/js/', import.meta.url).href;
const { ParticleField, PALETTES } = await import(base + 'particles.js');
const { SHAPES, buildShape } = await import(base + 'shapes.js');
const {
  readHand, pinchStrength, handSpan, handDepth, calibrateDepthBand, DEFAULT_DEPTH_BAND,
} = await import(base + 'gestures.js');

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

// ============================================================ projection
// screenToWorld is the inverse of the render projection at the z=0 plane. If
// the two ever drift apart, a pinch stops landing under the hand.
section('projection round-trip');
{
  const p = new ParticleField(8);
  p.rot = { x: -0.42, y: 1.31, z: 0.77 };
  p.scale = 1.4;
  p.offset = { x: 120, y: -75 };
  const W = 1440, H = 900;
  const { cx, cy, viewScale, focal } = p.viewParams(W, H);

  const project = ({ x, y, z }) => {
    const { x: rx, y: ry, z: rz } = { x, y, z };
    const sinX = Math.sin(p.rot.x), cosX = Math.cos(p.rot.x);
    const sinY = Math.sin(p.rot.y), cosY = Math.cos(p.rot.y);
    const sinZ = Math.sin(p.rot.z), cosZ = Math.cos(p.rot.z);
    const y1 = ry * cosX - rz * sinX;
    const z1 = ry * sinX + rz * cosX;
    const x2 = rx * cosY + z1 * sinY;
    const z2 = -rx * sinY + z1 * cosY;
    const x3 = x2 * cosZ - y1 * sinZ;
    const y3 = x2 * sinZ + y1 * cosZ;
    const persp = focal / (focal + z2);
    return { px: cx + x3 * persp * viewScale, py: cy + y3 * persp * viewScale, z2 };
  };

  let worst = 0;
  for (const [sx, sy] of [[720, 450], [200, 120], [1300, 800], [0, 900]]) {
    const w = p.screenToWorld(sx, sy, W, H);
    const back = project(w);
    worst = Math.max(worst, Math.hypot(back.px - sx, back.py - sy), Math.abs(back.z2));
  }
  ok(worst < 1e-3, `screenToWorld inverts the projection (worst error ${worst.toExponential(1)})`);

  const zero = new ParticleField(4);
  zero.scale = 0;
  const safe = zero.screenToWorld(10, 10, 100, 100);
  ok(Number.isFinite(safe.x) && Number.isFinite(safe.y), 'a zero-scale field does not divide by zero');
}

// A dot sitting exactly on the near plane must be culled, not turned into NaN.
section('near-plane guard');
{
  const p = new ParticleField(3);
  p.rot = { x: 0, y: 0, z: 0 };
  p.offset = { x: 0, y: 0 };
  p.scale = 1;
  // focal is 3.1; x=0 makes the projected x exactly 0 * Infinity = NaN if the
  // divide happens before the guard.
  p.pos.set([0, 0, -3.1, 0, 0, -3.1, 0.2, 0.1, 0]);
  let bad = 0, drawn = 0;
  p.render({
    globalCompositeOperation: '', fillStyle: '',
    fillRect() {}, beginPath() {},
    moveTo(x, y) { if (![x, y].every(Number.isFinite)) bad++; },
    arc(x, y, r) { drawn++; if (![x, y, r].every(Number.isFinite) || r <= 0) bad++; },
    fill() {},
  }, 800, 600, { trails: false });
  ok(bad === 0, `a dot on the near plane yields no NaN geometry (${bad} bad)`);
  ok(drawn === 1, `near-plane dots are culled, the valid one is kept (${drawn}/3)`);
}

// ============================================================ palettes
section('palettes');
{
  const p = new ParticleField(4);
  ok(PALETTES.length >= 2, `catalogue has ${PALETTES.length} palettes`);
  const first = p.palette[10].join(',');
  const next = p.cyclePalette(1);
  ok(p.paletteId === next.id && p.palette[10].join(',') !== first,
    `cycling repaints the ramp (${next.name})`);
  ok(p.setPalette(PALETTES[0].id) && p.paletteId === PALETTES[0].id, 'palette can be set by id');
  ok(p.setPalette('nope') === false, 'an unknown palette id is ignored');
  for (const pal of PALETTES) {
    const flat = pal.stops.flat();
    ok(pal.stops.length === 5 && flat.every((c) => c >= 0 && c <= 255),
      `${pal.id.padEnd(7)} has 5 in-gamut stops`);
  }
}

// ============================================================ motion knobs
section('motion knobs');
{
  const slow = new ParticleField(200);
  const fast = new ParticleField(200);
  for (const p of [slow, fast]) { p.setShape('sphere'); p.pos.fill(0); p.vel.fill(0); }
  slow.morph = 0.25;
  fast.morph = 3;
  for (let i = 0; i < 20; i++) { slow.update(1 / 60); fast.update(1 / 60); }
  const err = (p) => {
    let e = 0;
    for (let i = 0; i < 600; i++) e += (p.pos[i] - p.target[i]) ** 2;
    return Math.sqrt(e / 600);
  };
  ok(err(fast) < err(slow), `morph speed changes how fast the swarm arrives (${err(slow).toFixed(3)} vs ${err(fast).toFixed(3)})`);

  const still = new ParticleField(200);
  still.setShape('sphere');
  still.turbulence = 0;
  for (let i = 0; i < 400; i++) still.update(1 / 60);
  const restErr = (() => { let e = 0; for (let i = 0; i < 600; i++) e += (still.pos[i] - still.target[i]) ** 2; return Math.sqrt(e / 600); })();
  ok(restErr < 0.004, `drift 0 settles dead still (rms ${restErr.toFixed(5)})`);
  still.turbulence = 3;
  for (let i = 0; i < 120; i++) still.update(1 / 60);
  const movedErr = (() => { let e = 0; for (let i = 0; i < 600; i++) e += (still.pos[i] - still.target[i]) ** 2; return Math.sqrt(e / 600); })();
  ok(movedErr > restErr * 3, `drift 3 keeps the field breathing (rms ${movedErr.toFixed(5)})`);
}

// ============================================================ memory
// Batch storage must not scale with the bucket count: one full-size array per
// colour bucket cost 28x more than the dots could ever fill.
section('batch memory');
{
  const n = 4000;
  const p = new ParticleField(n);
  let bytes = 0;
  for (const v of Object.values(p)) if (ArrayBuffer.isView(v)) bytes += v.byteLength;
  const perDot = bytes / n;
  ok(perDot < 80, `${perDot.toFixed(0)} bytes of typed-array state per dot`);
}

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

// Depth is inferred from apparent hand size, so a small or large hand would
// otherwise sit permanently at one end of the range.
section('depth calibration');
{
  const big = makeHand({ span: 0.30 });
  ok(handDepth(big) === 1, 'an large hand pins the uncalibrated depth range');
  const band = calibrateDepthBand(handSpan(big));
  ok(handDepth(big, band) > 0.2 && handDepth(big, band) < 0.8,
    `calibrating recentres it (${handDepth(big, band).toFixed(2)})`);
  const near = handDepth(makeHand({ span: 0.44 }), band);
  const far = handDepth(makeHand({ span: 0.20 }), band);
  ok(far < handDepth(big, band) && handDepth(big, band) < near,
    `calibrated depth still rises toward the lens (${far.toFixed(2)} -> ${near.toFixed(2)})`);
  const avg = calibrateDepthBand(0.15);
  ok(Math.abs(avg.lo - DEFAULT_DEPTH_BAND.lo) < 0.02 && Math.abs(avg.hi - DEFAULT_DEPTH_BAND.hi) < 0.02,
    'an average hand calibrates to roughly the shipped default');
  ok(calibrateDepthBand(0).hi > calibrateDepthBand(0).lo, 'a degenerate span falls back to a sane band');
}

const L = readHand(makeHand({ cx: 0.2 })), R = readHand(makeHand({ cx: 0.8 }));
ok(R.center.x - L.center.x > 0.5, 'palm centre tracks horizontal position');

console.log(fails ? `\n${fails} FAILING\n` : '\nAll checks passed.\n');
process.exit(fails ? 1 : 0);

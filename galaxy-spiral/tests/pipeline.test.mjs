// End-to-end: feed synthetic hands into the running app and assert the swarm
// actually moves, rotates, resizes and re-forms. This is the requirement.
import { boot } from './harness.mjs';
import { hand } from './hand-fixture.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fails++; };
const section = (s) => console.log('\n--- ' + s);

const { byId, pump, api } = await boot();
ok(!!api?.field && !!api?.tracker, 'debug handle exposes field and tracker');

const { field, tracker } = api;

/** Feed a fixed set of hands for `frames` frames. */
function show(hands, frames = 40) {
  tracker.detect = () => hands;
  pump(frames);
}
const clear = (frames = 60) => show([], frames);
const shape = () => field.shapeId;

// ============================================================ movement
section('movement');
clear();
show([hand({ cx: 0.15, cy: 0.5 })], 60);
const left = field.offset.x;
show([hand({ cx: 0.85, cy: 0.5 })], 60);
const right = field.offset.x;
ok(right - left > 300, `palm left->right moves the swarm right (${left.toFixed(0)}px -> ${right.toFixed(0)}px)`);

show([hand({ cx: 0.5, cy: 0.12 })], 60);
const top = field.offset.y;
show([hand({ cx: 0.5, cy: 0.88 })], 60);
const bottom = field.offset.y;
ok(bottom - top > 200, `palm up->down moves the swarm down (${top.toFixed(0)}px -> ${bottom.toFixed(0)}px)`);

// The fixture places the wrist at cy, but the app aims with the palm
// centroid, which sits above it. Offset so the centroid lands dead centre.
const probe = hand({ cx: 0.5, cy: 0.5 }).landmarks;
const probeY = [0, 5, 9, 13, 17].reduce((a, i) => a + probe[i].y, 0) / 5;
show([hand({ cx: 0.5, cy: 0.5 + (0.5 - probeY) })], 60);
ok(Math.abs(field.offset.x) < 40 && Math.abs(field.offset.y) < 40,
  `centred palm re-centres the swarm (${field.offset.x.toFixed(0)}, ${field.offset.y.toFixed(0)})`);

clear(120);
ok(Math.abs(field.offset.x) < 30 && Math.abs(field.offset.y) < 30,
  'swarm drifts home when the hand leaves frame');

// ============================================================ rotation
section('rotation');
show([hand({ rot: 0 })], 60);
const rollA = field.rot.z;
show([hand({ rot: 0.9 })], 60);
const rollB = field.rot.z;
ok(Math.abs(rollB - rollA) > 0.6, `wrist roll drives Z rotation (${rollA.toFixed(2)} -> ${rollB.toFixed(2)} rad)`);
ok(Math.sign(rollB - rollA) === -1, 'roll direction is mirrored to match the selfie view');

// A sideways sweep should impart spin.
show([hand({ cx: 0.5, rot: 0 })], 30);
field.spin.y = 0;
tracker.detect = () => [hand({ cx: 0.5, rot: 0 })];
pump(1);
for (let i = 0; i < 12; i++) {
  const cx = 0.3 + i * 0.035;
  tracker.detect = () => [hand({ cx, rot: 0 })];
  pump(1);
}
ok(field.spin.y > 0.4, `sweeping the hand sideways spins the swarm (spin.y ${field.spin.y.toFixed(2)})`);

// Rotation keeps advancing on its own with no hand present.
clear(30);
const yA = field.rot.y;
pump(60);
ok(field.rot.y > yA, `swarm keeps idling in rotation with no hand (${yA.toFixed(2)} -> ${field.rot.y.toFixed(2)})`);

// ============================================================ scale
section('scale');
show([hand({ span: 0.09 })], 80);
const farScale = field.scale;
show([hand({ span: 0.25 })], 80);
const nearScale = field.scale;
ok(nearScale - farScale > 0.7, `pushing the hand toward the lens zooms in (${farScale.toFixed(2)}x -> ${nearScale.toFixed(2)}x)`);

// ============================================================ shapes
section('shape switching');
const expect = [
  [[0, 0, 0, 0, 0], 'core', 'fist'],
  [[0, 1, 0, 0, 0], 'sphere', '1 finger'],
  [[0, 1, 1, 0, 0], 'torus', '2 fingers'],
  [[0, 1, 1, 1, 0], 'cube', '3 fingers'],
  [[0, 1, 1, 1, 1], 'helix', '4 fingers'],
  [[1, 1, 1, 1, 1], 'galaxy', 'open palm'],
];
for (const [raised, want, label] of expect) {
  show([hand({ raised })], 45);
  ok(shape() === want, `${label.padEnd(10)} -> ${want.padEnd(7)} (got ${shape()})`);
}

// Debounce: a pose flashed for under the hold time must not commit.
show([hand({ raised: [1, 1, 1, 1, 1] })], 45);
ok(shape() === 'galaxy', 'settled on galaxy before debounce test');
show([hand({ raised: [0, 1, 1, 0, 0] })], 8);   // ~134ms, under the 320ms hold
ok(shape() === 'galaxy', `a pose flashed for ~134ms does not switch shape (still ${shape()})`);
show([hand({ raised: [0, 1, 1, 0, 0] })], 20);  // now past the hold
ok(shape() === 'torus', `holding the same pose past 320ms commits it (${shape()})`);

// ============================================================ pinch grab
section('pinch grab');
show([hand({ raised: [1, 1, 1, 1, 1] })], 60);
ok(field.attractor === null, 'open hand sets no attractor');
const radius = () => {
  let r = 0;
  for (let i = 0; i < field.count; i++) r += Math.hypot(field.pos[i * 3], field.pos[i * 3 + 1], field.pos[i * 3 + 2]);
  return r / field.count;
};
const loose = radius();
show([hand({ raised: [1, 1, 1, 1, 1], pinch: true })], 70);
ok(field.attractor !== null && field.attractor.strength > 0,
  `pinch engages the attractor (strength ${field.attractor?.strength.toFixed(1)})`);
const squeezed = radius();
ok(squeezed < loose * 0.7, `pinch crushes the swarm inward (mean radius ${loose.toFixed(2)} -> ${squeezed.toFixed(2)})`);
ok(byId.get('hud-gesture').textContent.includes('grab'), `HUD announces the grab ("${byId.get('hud-gesture').textContent}")`);

// Pinching must not let the mangled finger count change the shape.
const held = shape();
show([hand({ raised: [1, 1, 1, 1, 1], pinch: true })], 60);
ok(shape() === held, `shape is frozen while pinching (${shape()})`);

show([hand({ raised: [1, 1, 1, 1, 1] })], 60);
ok(field.attractor === null, 'releasing the pinch frees the swarm');
ok(radius() > squeezed * 1.4, `swarm expands again after release (${radius().toFixed(2)})`);

// The grab must land under the hand, not at the world origin. Mean radius
// measured from the origin cannot tell those two apart, which is exactly how
// the origin-pinned attractor survived the suite — so measure from both.
section('pinch follows the hand');
const centroid = () => {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < field.count; i++) {
    x += field.pos[i * 3]; y += field.pos[i * 3 + 1]; z += field.pos[i * 3 + 2];
  }
  return { x: x / field.count, y: y / field.count, z: z / field.count };
};

// Same hand position, open then pinched, so the only difference is the grab.
clear(90);
show([hand({ cx: 0.84, raised: [1, 1, 1, 1, 1] })], 90);
const restC = centroid();
show([hand({ cx: 0.84, raised: [1, 1, 1, 1, 1], pinch: true })], 140);

const att = field.attractor;
const away = att ? Math.hypot(att.x, att.y, att.z) : 0;
ok(away > 0.3, `an off-centre pinch puts the attractor away from the origin (|a| = ${away.toFixed(2)})`);

// Project the centre of mass onto the grab axis. Mean radius cannot see this,
// which is how an origin-pinned attractor passed the suite for so long.
const ax = att.x / away, ay = att.y / away, az = att.z / away;
const along = (c) => c.x * ax + c.y * ay + c.z * az;
ok(along(centroid()) - along(restC) > 0.25,
  `the grab drags the swarm's centre of mass toward the hand (${along(restC).toFixed(2)} -> ${along(centroid()).toFixed(2)} along the grab axis)`);

clear(90);

// ============================================================ two-hand grab
section('two-hand grab');
const twoOpen = [hand({ cx: 0.35, raised: [1, 1, 1, 1, 1] }), hand({ cx: 0.65, raised: [1, 1, 1, 1, 1] })];
show(twoOpen, 60);
ok(field.attractor === null, 'two open hands set no attractor');

const twoPinch = [
  hand({ cx: 0.35, raised: [1, 1, 1, 1, 1], pinch: true }),
  hand({ cx: 0.65, raised: [1, 1, 1, 1, 1], pinch: true }),
];
show(twoPinch, 90);
ok(field.attractor !== null && field.attractor.strength > 0,
  `a two-handed pinch grabs too (strength ${field.attractor?.strength.toFixed(1)})`);
ok(byId.get('hud-gesture').textContent.includes('grab'),
  `HUD announces the two-hand grab ("${byId.get('hud-gesture').textContent}")`);
show(twoOpen, 60);
ok(field.attractor === null, 'releasing a two-handed pinch frees the swarm');

// ============================================================ two hands
section('two hands');
const near2 = [hand({ cx: 0.45, raised: [1, 1, 1, 1, 1] }), hand({ cx: 0.55, raised: [1, 1, 1, 1, 1] })];
const far2 = [hand({ cx: 0.12, raised: [1, 1, 1, 1, 1] }), hand({ cx: 0.88, raised: [1, 1, 1, 1, 1] })];
show(near2, 80);
const together = field.scale;
show(far2, 80);
const apart = field.scale;
ok(apart - together > 0.9, `pulling both hands apart stretches the swarm (${together.toFixed(2)}x -> ${apart.toFixed(2)}x)`);
ok(byId.get('hud-hands').textContent === '2', 'HUD reports two hands');

// Steering-wheel roll.
show([hand({ cx: 0.3, cy: 0.5 }), hand({ cx: 0.7, cy: 0.5 })], 60);
const levelRoll = field.rot.z;
show([hand({ cx: 0.3, cy: 0.3 }), hand({ cx: 0.7, cy: 0.7 })], 60);
ok(field.rot.z - levelRoll > 0.4,
  `tilting two hands rolls the swarm like a wheel (${levelRoll.toFixed(2)} -> ${field.rot.z.toFixed(2)} rad)`);

// Asymmetric poses must not trigger a shape change while stretching.
show([hand({ raised: [1, 1, 1, 1, 1] })], 45);
const before2 = shape();
show([hand({ cx: 0.3, raised: [0, 1, 1, 0, 0] }), hand({ cx: 0.7, raised: [0, 1, 1, 1, 0] })], 60);
ok(shape() === before2, `mismatched two-hand poses leave the shape alone (${shape()})`);

// Matching poses do switch.
show([hand({ cx: 0.3, raised: [0, 1, 0, 0, 0] }), hand({ cx: 0.7, raised: [0, 1, 0, 0, 0] })], 60);
ok(shape() === 'sphere', `matching two-hand poses switch shape (${shape()})`);

// Double fist = supernova.
const fists = [hand({ cx: 0.35, raised: [0, 0, 0, 0, 0] }), hand({ cx: 0.65, raised: [0, 0, 0, 0, 0] })];
show([hand({ raised: [1, 1, 1, 1, 1] })], 45);
let peak = 0;
tracker.detect = () => fists;
pump(1);
for (let i = 0; i < field.count * 3; i++) peak = Math.max(peak, Math.abs(field.vel[i]));
ok(peak > 3, `two fists fire a supernova burst (peak speed ${peak.toFixed(1)})`);
ok(byId.get('hud-gesture').textContent.includes('supernova'), 'HUD announces the supernova');

// It must fire once per clench, not every frame.
pump(30);
let peak2 = 0;
for (let i = 0; i < field.count * 3; i++) peak2 = Math.max(peak2, Math.abs(field.vel[i]));
ok(peak2 < peak, `burst is edge-triggered, not repeating (${peak.toFixed(1)} -> ${peak2.toFixed(1)})`);

// ============================================================ stability
section('stability');
let bad = 0;
for (let i = 0; i < field.count * 3; i++) if (!Number.isFinite(field.pos[i])) bad++;
ok(bad === 0, 'all positions finite after the full gesture workout');
ok(Number.isFinite(field.scale) && Number.isFinite(field.rot.z) && Number.isFinite(field.offset.x),
  'all transform state finite');
clear(120);
ok(field.scale > 0.9 && field.scale < 1.1, `scale returns to 1 when hands leave (${field.scale.toFixed(2)})`);

console.log(fails ? `\n${fails} FAILING\n` : '\nAll checks passed.\n');
process.exit(fails ? 1 : 0);

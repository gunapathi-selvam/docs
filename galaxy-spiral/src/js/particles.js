// Particle field: spring physics toward a shape target, 3D rotation,
// perspective projection, and batched additive canvas rendering.

import { buildShape } from './shapes.js';

export const PALETTES = [
  { id: 'nebula', name: 'Nebula', stops: [[109, 40, 217], [79, 70, 229], [6, 182, 212], [103, 232, 249], [240, 171, 252]] },
  { id: 'ember', name: 'Ember', stops: [[120, 20, 40], [220, 60, 30], [245, 130, 32], [250, 204, 21], [255, 247, 200]] },
  { id: 'flora', name: 'Flora', stops: [[20, 83, 45], [16, 145, 105], [52, 211, 153], [163, 230, 53], [236, 252, 203]] },
  { id: 'aurora', name: 'Aurora', stops: [[49, 10, 101], [124, 58, 237], [34, 211, 238], [74, 222, 128], [190, 242, 100]] },
];

const BUCKETS = 28;
const ALPHA_TIERS = 4;
const SLOTS = BUCKETS * ALPHA_TIERS;

// Real alpha range. Tier bounds are derived from these rather than [0,1), so
// the dimmest tier is not painted darker than any dot it actually contains.
const A_LO = 0.18;
const A_HI = 0.98;

const FOCAL = 3.1;
const CULL_MARGIN = 40;
const TAU = Math.PI * 2;

function buildPalette(stops) {
  const colors = [];
  for (let i = 0; i < BUCKETS; i++) {
    const t = (i / (BUCKETS - 1)) * (stops.length - 1);
    const lo = Math.floor(t);
    const hi = Math.min(stops.length - 1, lo + 1);
    const f = t - lo;
    colors.push([0, 1, 2].map((k) => Math.round(stops[lo][k] + (stops[hi][k] - stops[lo][k]) * f)));
  }
  return colors;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class ParticleField {
  constructor(count = 1000) {
    this.count = count;

    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.target = new Float32Array(count * 3);
    this.tint = new Float32Array(count);
    this.sizeSeed = new Float32Array(count);
    this.phase = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      this.tint[i] = Math.random();
      this.sizeSeed[i] = 0.65 + Math.random() * 0.75;
      this.phase[i] = Math.random() * TAU;
      // Start scattered so the first morph reads as an inrush, not a pop.
      this.pos[i * 3] = (Math.random() - 0.5) * 6;
      this.pos[i * 3 + 1] = (Math.random() - 0.5) * 6;
      this.pos[i * 3 + 2] = (Math.random() - 0.5) * 6;
    }

    // Draw batching by counting sort into BUCKETS x ALPHA_TIERS slots. Two
    // flat arrays rather than one full-size array per bucket, which cost 28x
    // more memory than the dots could ever fill.
    this.projXYR = new Float32Array(count * 3);
    this.projSlot = new Int32Array(count);
    this.packed = new Float32Array(count * 3);
    this.slotCount = new Int32Array(SLOTS);
    this.slotStart = new Int32Array(SLOTS + 1);
    this.slotCursor = new Int32Array(SLOTS);

    // Transform state, driven by gestures.
    this.rot = { x: -0.35, y: 0, z: 0 };
    this.spin = { x: 0, y: 0.25, z: 0 };
    this.scale = 1;
    this.offset = { x: 0, y: 0 };
    this.attractor = null;   // { x, y, z, strength } in world units
    this.shapeId = null;
    this.time = 0;
    this.visible = 0;

    this.stiffness = 13;
    this.damping = 0.88;
    this.turbulence = 1;   // idle drift amount, 0..3
    this.morph = 1;        // stiffness multiplier, 0.25..3
    this.energy = 0;       // external excitation (audio), 0..1

    this.paletteId = PALETTES[0].id;
    this.palette = buildPalette(PALETTES[0].stops);
    this.stops = PALETTES[0].stops;

    this.setShape('galaxy');
  }

  setShape(id) {
    if (id === this.shapeId) return false;
    this.shapeId = id;
    this.target.set(buildShape(id, this.count));
    return true;
  }

  setPalette(id) {
    const p = PALETTES.find((x) => x.id === id);
    if (!p || p.id === this.paletteId) return false;
    this.paletteId = p.id;
    this.palette = buildPalette(p.stops);
    this.stops = p.stops;
    return true;
  }

  cyclePalette(step = 1) {
    const i = PALETTES.findIndex((p) => p.id === this.paletteId);
    const next = PALETTES[(i + step + PALETTES.length) % PALETTES.length];
    this.setPalette(next.id);
    return next;
  }

  burst(power = 7) {
    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;
      const x = this.pos[i3], y = this.pos[i3 + 1], z = this.pos[i3 + 2];
      const len = Math.hypot(x, y, z) || 1;
      const k = power * (0.55 + Math.random() * 0.75);
      this.vel[i3] += (x / len) * k;
      this.vel[i3 + 1] += (y / len) * k;
      this.vel[i3 + 2] += (z / len) * k;
    }
  }

  /** Shared projection parameters, so screenToWorld stays in step with render. */
  viewParams(width, height) {
    return {
      cx: width / 2 + this.offset.x,
      cy: height / 2 + this.offset.y,
      viewScale: Math.min(width, height) * 0.3 * this.scale,
      focal: FOCAL,
    };
  }

  /**
   * Inverse of the render projection at the z=0 plane: screen pixels back to
   * pre-rotation world space. Lets a gesture place an attractor under the hand
   * even while the field is rotating.
   */
  screenToWorld(sx, sy, width, height) {
    const { cx, cy, viewScale } = this.viewParams(width, height);
    if (!(viewScale > 1e-6)) return { x: 0, y: 0, z: 0 };

    const x3 = (sx - cx) / viewScale;
    const y3 = (sy - cy) / viewScale;

    const sinX = Math.sin(this.rot.x), cosX = Math.cos(this.rot.x);
    const sinY = Math.sin(this.rot.y), cosY = Math.cos(this.rot.y);
    const sinZ = Math.sin(this.rot.z), cosZ = Math.cos(this.rot.z);

    // Undo Z.
    const x2 = x3 * cosZ + y3 * sinZ;
    const y1 = -x3 * sinZ + y3 * cosZ;
    // Undo Y, solving for the point whose rotated depth is 0.
    const x = x2 * cosY;
    const z1 = x2 * sinY;
    // Undo X.
    const y = y1 * cosX + z1 * sinX;
    const z = -y1 * sinX + z1 * cosX;
    return { x, y, z };
  }

  update(dt) {
    this.time += dt;
    const t = this.time;
    const damp = Math.pow(this.damping, dt * 60);
    const k = this.stiffness * this.morph;
    const wave = this.shapeId === 'grid';
    const att = this.attractor;
    const turb = this.turbulence * 0.55 * (1 + this.energy * 2.2);

    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;
      let tx = this.target[i3];
      let ty = this.target[i3 + 1];
      let tz = this.target[i3 + 2];

      if (wave) {
        ty += Math.sin(tx * 2.6 + t * 1.9) * 0.24 + Math.cos(tz * 2.2 - t * 1.4) * 0.24;
      }
      // Never fully still: a slow breathing drift keeps the cloud alive.
      const ph = this.phase[i];
      tx += Math.sin(t * 0.7 + ph) * 0.018 * turb;
      ty += Math.cos(t * 0.6 + ph * 1.3) * 0.018 * turb;
      tz += Math.sin(t * 0.8 + ph * 0.7) * 0.018 * turb;

      let ax = (tx - this.pos[i3]) * k;
      let ay = (ty - this.pos[i3 + 1]) * k;
      let az = (tz - this.pos[i3 + 2]) * k;

      if (att) {
        const dx = att.x - this.pos[i3];
        const dy = att.y - this.pos[i3 + 1];
        const dz = (att.z || 0) - this.pos[i3 + 2];
        const d2 = dx * dx + dy * dy + dz * dz + 0.35;
        const pull = att.strength / d2;
        ax += dx * pull;
        ay += dy * pull;
        az += dz * pull;
      }

      const vx = (this.vel[i3] + ax * dt) * damp;
      const vy = (this.vel[i3 + 1] + ay * dt) * damp;
      const vz = (this.vel[i3 + 2] + az * dt) * damp;

      this.vel[i3] = vx;
      this.vel[i3 + 1] = vy;
      this.vel[i3 + 2] = vz;
      this.pos[i3] += vx * dt;
      this.pos[i3 + 1] += vy * dt;
      this.pos[i3 + 2] += vz * dt;
    }

    this.rot.x += this.spin.x * dt;
    this.rot.y += this.spin.y * dt;
    this.rot.z += this.spin.z * dt;
    // Spin decays so flicks read as impulses, not permanent settings.
    const spinDamp = Math.pow(0.97, dt * 60);
    this.spin.x *= spinDamp;
    this.spin.y = 0.18 + (this.spin.y - 0.18) * spinDamp;
    this.spin.z *= spinDamp;
  }

  render(ctx, width, height, opts = {}) {
    const { trails = true, dotScale = 1 } = opts;

    ctx.globalCompositeOperation = 'source-over';
    if (trails) {
      ctx.fillStyle = 'rgba(4, 6, 20, 0.28)';
      ctx.fillRect(0, 0, width, height);
    } else {
      ctx.fillStyle = '#040614';
      ctx.fillRect(0, 0, width, height);
    }

    const { cx, cy, viewScale, focal } = this.viewParams(width, height);
    const baseR = Math.max(1, Math.min(width, height) / 620) * 1.55 * dotScale * (1 + this.energy * 0.5);

    const sinX = Math.sin(this.rot.x), cosX = Math.cos(this.rot.x);
    const sinY = Math.sin(this.rot.y), cosY = Math.cos(this.rot.y);
    const sinZ = Math.sin(this.rot.z), cosZ = Math.cos(this.rot.z);

    this.slotCount.fill(0);
    let visible = 0;

    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;
      const x = this.pos[i3], y = this.pos[i3 + 1], z = this.pos[i3 + 2];

      // Rotate X, then Y, then Z.
      const y1 = y * cosX - z * sinX;
      const z1 = y * sinX + z * cosX;
      const x2 = x * cosY + z1 * sinY;
      const z2 = -x * sinY + z1 * cosY;
      const x3 = x2 * cosZ - y1 * sinZ;
      const y3 = x2 * sinZ + y1 * cosZ;

      // Guard the denominator before dividing, not the quotient after: at
      // z2 === -focal the divide yields Infinity and NaN escapes the cull.
      if (!(z2 > -focal + 1e-4)) continue;
      const persp = focal / (focal + z2);

      const px = cx + x3 * persp * viewScale;
      const py = cy + y3 * persp * viewScale;
      // Negated comparisons so a NaN coordinate is culled rather than drawn.
      if (!(px >= -CULL_MARGIN && px <= width + CULL_MARGIN)) continue;
      if (!(py >= -CULL_MARGIN && py <= height + CULL_MARGIN)) continue;

      const depth = clamp((persp - 0.55) / 1.25, 0, 1);
      const r = baseR * this.sizeSeed[i] * (0.45 + persp * 0.75);
      if (!(r > 0)) continue;

      let b = Math.floor((this.tint[i] * 0.62 + depth * 0.38) * (BUCKETS - 1));
      b = b < 0 ? 0 : b > BUCKETS - 1 ? BUCKETS - 1 : b;
      let tier = Math.floor(depth * ALPHA_TIERS);
      tier = tier < 0 ? 0 : tier > ALPHA_TIERS - 1 ? ALPHA_TIERS - 1 : tier;

      const o = visible * 3;
      this.projXYR[o] = px;
      this.projXYR[o + 1] = py;
      this.projXYR[o + 2] = r;
      this.projSlot[visible] = b * ALPHA_TIERS + tier;
      this.slotCount[b * ALPHA_TIERS + tier]++;
      visible++;
    }

    let acc = 0;
    for (let s = 0; s < SLOTS; s++) {
      this.slotStart[s] = acc;
      this.slotCursor[s] = acc;
      acc += this.slotCount[s];
    }
    this.slotStart[SLOTS] = acc;

    for (let i = 0; i < visible; i++) {
      const d = this.slotCursor[this.projSlot[i]]++ * 3;
      const o = i * 3;
      this.packed[d] = this.projXYR[o];
      this.packed[d + 1] = this.projXYR[o + 1];
      this.packed[d + 2] = this.projXYR[o + 2];
    }

    ctx.globalCompositeOperation = 'lighter';
    const span = A_HI - A_LO;
    for (let s = 0; s < SLOTS; s++) {
      const n = this.slotCount[s];
      if (!n) continue;
      const rgb = this.palette[(s / ALPHA_TIERS) | 0];
      const a = A_LO + span * (((s % ALPHA_TIERS) + 0.5) / ALPHA_TIERS);

      ctx.beginPath();
      const start = this.slotStart[s];
      for (let j = start; j < start + n; j++) {
        const j3 = j * 3;
        const px = this.packed[j3], py = this.packed[j3 + 1], r = this.packed[j3 + 2];
        ctx.moveTo(px + r, py);
        ctx.arc(px, py, r, 0, TAU);
      }
      ctx.fillStyle = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a.toFixed(3) + ')';
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';

    this.visible = visible;
    return visible;
  }
}

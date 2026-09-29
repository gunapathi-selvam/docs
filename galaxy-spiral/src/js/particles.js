// 1000-dot field: spring physics toward a shape target, 3D rotation,
// perspective projection, and batched additive canvas rendering.

import { buildShape } from './shapes.js';

const PALETTE_STOPS = [
  [109, 40, 217],   // violet
  [79, 70, 229],    // indigo
  [6, 182, 212],    // cyan
  [103, 232, 249],  // ice
  [240, 171, 252],  // orchid
];
const BUCKETS = 28;
const ALPHA_TIERS = 4;

function buildPalette() {
  const colors = [];
  for (let i = 0; i < BUCKETS; i++) {
    const t = (i / (BUCKETS - 1)) * (PALETTE_STOPS.length - 1);
    const lo = Math.floor(t);
    const hi = Math.min(PALETTE_STOPS.length - 1, lo + 1);
    const f = t - lo;
    const c = [0, 1, 2].map((k) =>
      Math.round(PALETTE_STOPS[lo][k] + (PALETTE_STOPS[hi][k] - PALETTE_STOPS[lo][k]) * f));
    colors.push(c);
  }
  return colors;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class ParticleField {
  constructor(count = 1000) {
    this.count = count;
    this.palette = buildPalette();

    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.target = new Float32Array(count * 3);
    this.tint = new Float32Array(count);
    this.sizeSeed = new Float32Array(count);
    this.phase = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      this.tint[i] = Math.random();
      this.sizeSeed[i] = 0.65 + Math.random() * 0.75;
      this.phase[i] = Math.random() * Math.PI * 2;
      // Start scattered so the first morph reads as an inrush, not a pop.
      this.pos[i * 3] = (Math.random() - 0.5) * 6;
      this.pos[i * 3 + 1] = (Math.random() - 0.5) * 6;
      this.pos[i * 3 + 2] = (Math.random() - 0.5) * 6;
    }

    // Draw batches: one path per colour bucket instead of 1000 style changes.
    this.batchXYR = Array.from({ length: BUCKETS }, () => new Float32Array(count * 3));
    this.batchAlpha = Array.from({ length: BUCKETS }, () => new Float32Array(count));
    this.batchLen = new Int32Array(BUCKETS);

    // Transform state, driven by gestures.
    this.rot = { x: -0.35, y: 0, z: 0 };
    this.spin = { x: 0, y: 0.25, z: 0 };
    this.scale = 1;
    this.offset = { x: 0, y: 0 };
    this.attractor = null;   // { x, y, strength } in world units
    this.shapeId = null;
    this.time = 0;

    this.stiffness = 13;
    this.damping = 0.88;
    this.turbulence = 1;

    this.setShape('galaxy');
  }

  setShape(id) {
    if (id === this.shapeId) return false;
    this.shapeId = id;
    this.target.set(buildShape(id, this.count));
    return true;
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

  update(dt) {
    this.time += dt;
    const t = this.time;
    const damp = Math.pow(this.damping, dt * 60);
    const k = this.stiffness;
    const wave = this.shapeId === 'grid';
    const att = this.attractor;
    const turb = this.turbulence * 0.55;

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
        const dz = -this.pos[i3 + 2];
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

    const cx = width / 2 + this.offset.x;
    const cy = height / 2 + this.offset.y;
    const viewScale = Math.min(width, height) * 0.3 * this.scale;
    const focal = 3.1;
    const baseR = Math.max(1, Math.min(width, height) / 620) * 1.55 * dotScale;

    const sinX = Math.sin(this.rot.x), cosX = Math.cos(this.rot.x);
    const sinY = Math.sin(this.rot.y), cosY = Math.cos(this.rot.y);
    const sinZ = Math.sin(this.rot.z), cosZ = Math.cos(this.rot.z);

    this.batchLen.fill(0);

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

      const persp = focal / (focal + z2);
      if (persp <= 0.02) continue;

      const px = cx + x3 * persp * viewScale;
      const py = cy + y3 * persp * viewScale;
      if (px < -40 || px > width + 40 || py < -40 || py > height + 40) continue;

      const depth = clamp((persp - 0.55) / 1.25, 0, 1);
      const alpha = 0.18 + depth * 0.8;
      const r = baseR * this.sizeSeed[i] * (0.45 + persp * 0.75);

      let b = Math.floor((this.tint[i] * 0.62 + depth * 0.38) * (BUCKETS - 1));
      b = b < 0 ? 0 : b > BUCKETS - 1 ? BUCKETS - 1 : b;

      const n = this.batchLen[b]++;
      const arr = this.batchXYR[b];
      arr[n * 3] = px;
      arr[n * 3 + 1] = py;
      arr[n * 3 + 2] = r;
      this.batchAlpha[b][n] = alpha;
    }

    ctx.globalCompositeOperation = 'lighter';
    for (let b = 0; b < BUCKETS; b++) {
      const n = this.batchLen[b];
      if (!n) continue;
      const rgb = this.palette[b];
      const head = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',';
      const arr = this.batchXYR[b];
      const alphas = this.batchAlpha[b];

      // Alpha varies per dot, so group into a few tiers within each bucket.
      for (let tier = 0; tier < ALPHA_TIERS; tier++) {
        const lo = tier / ALPHA_TIERS;
        const hi = (tier + 1) / ALPHA_TIERS;
        let opened = false;
        for (let j = 0; j < n; j++) {
          const a = alphas[j];
          if (a < lo || a >= hi) continue;
          if (!opened) { ctx.beginPath(); opened = true; }
          const px = arr[j * 3], py = arr[j * 3 + 1], r = arr[j * 3 + 2];
          ctx.moveTo(px + r, py);
          ctx.arc(px, py, r, 0, Math.PI * 2);
        }
        if (opened) {
          ctx.fillStyle = head + ((lo + hi) / 2).toFixed(3) + ')';
          ctx.fill();
        }
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}

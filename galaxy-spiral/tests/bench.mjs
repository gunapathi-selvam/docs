// Measures the JS cost of one frame at a range of dot counts.
//
// This deliberately stubs the canvas, so it reports the cost of physics,
// projection and batching only. Real frame time is dominated by rasterising
// the dots and by MediaPipe inference, neither of which appear here — do not
// read these numbers as a frame budget.

const base = new URL('../src/js/', import.meta.url).href;
const { ParticleField } = await import(base + 'particles.js');

const NULL_CTX = {
  globalCompositeOperation: '', fillStyle: '',
  fillRect() {}, beginPath() {}, moveTo() {}, arc() {}, fill() {},
};

const W = 1920, H = 1080;
const DT = 1 / 60;

function time(label, fn, iters) {
  fn(); // warm the JIT
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1e6 / iters;
}

function bytesOf(field) {
  let b = 0;
  for (const v of Object.values(field)) if (ArrayBuffer.isView(v)) b += v.byteLength;
  return b;
}

const counts = [1000, 2500, 5000, 10000, 20000];
const rows = [];

for (const n of counts) {
  const f = new ParticleField(n);
  f.setShape('galaxy');
  for (let i = 0; i < 200; i++) f.update(DT);   // settle

  const iters = Math.max(30, Math.round(3e6 / n));
  const upd = time('update', () => f.update(DT), iters);
  const ren = time('render', () => f.render(NULL_CTX, W, H, { trails: true }), iters);
  const drawn = f.render(NULL_CTX, W, H, { trails: true });

  rows.push({
    n,
    upd,
    ren,
    total: upd + ren,
    drawn,
    perDot: bytesOf(f) / n,
    kb: bytesOf(f) / 1024,
  });
}

const pad = (s, w) => String(s).padStart(w);
console.log('\nJS cost per frame — physics + projection + batching only');
console.log('(excludes canvas rasterisation and MediaPipe inference)\n');
console.log('   dots    update    render     total   of 16.7ms     drawn    memory   bytes/dot');
console.log('   ' + '-'.repeat(76));
for (const r of rows) {
  console.log([
    pad(r.n, 7),
    pad(r.upd.toFixed(3) + 'ms', 9),
    pad(r.ren.toFixed(3) + 'ms', 9),
    pad(r.total.toFixed(3) + 'ms', 9),
    pad((r.total / 16.67 * 100).toFixed(1) + '%', 11),
    pad(r.drawn, 9),
    pad(r.kb.toFixed(0) + 'KB', 9),
    pad(r.perDot.toFixed(0), 11),
  ].join(''));
}

// Batching used to allocate one full-size array per colour bucket: 28 x
// count x 3 floats for coordinates plus 28 x count for alpha. The counting
// sort needs a fixed handful of arrays instead. Compare total field state.
const BUCKETS = 28;
const n = 10000;
const physicsBytes = n * 3 * 4 * 3 + n * 4 * 3;          // pos, vel, target, tint, size, phase
const oldTotal = physicsBytes + BUCKETS * (n * 3 * 4 + n * 4);
const newTotal = bytesOf(new ParticleField(n));
console.log(`\n   total field state at ${n} dots: ` +
  `${(oldTotal / 1048576).toFixed(2)}MB per-bucket batching -> ` +
  `${(newTotal / 1048576).toFixed(2)}MB counting sort ` +
  `(${(oldTotal / newTotal).toFixed(1)}x smaller)\n`);

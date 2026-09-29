import { ParticleField, PALETTES } from './particles.js';
import { GLRenderer } from './glrenderer.js';
import { SHAPES, SHAPE_BY_FINGERS } from './shapes.js';
import { HandTracker, HAND_BONES } from './handTracker.js';
import {
  readHand, Smoothed, SmoothedAngle, PoseLatch,
  DEFAULT_DEPTH_BAND, calibrateDepthBand,
} from './gestures.js';
import { AudioReactor } from './audio.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- config
// Query string sets it, the hash records it, localStorage remembers the
// calibration. All three are optional; the app runs with none of them.
const search = new URLSearchParams(globalThis.location?.search ?? '');
const hash = new URLSearchParams((globalThis.location?.hash ?? '').replace(/^#/, ''));
const cfg = (k) => hash.get(k) ?? search.get(k);

const store = {
  get(k) { try { return globalThis.localStorage?.getItem(k) ?? null; } catch { return null; } },
  set(k, v) { try { globalThis.localStorage?.setItem(k, v); } catch { /* private mode */ } },
};

function intParam(name, lo, hi, fallback) {
  const raw = cfg(name);
  // Number(null) is 0, not NaN, so an absent param must be rejected first.
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(clamp(n, lo, hi)) : fallback;
}

const DOT_COUNT = intParam('dots', 100, 40000, 1000);

let depthBand = { ...DEFAULT_DEPTH_BAND };
try {
  const saved = JSON.parse(store.get('gs.depthBand') || 'null');
  if (saved && Number.isFinite(saved.lo) && Number.isFinite(saved.hi) && saved.hi > saved.lo) {
    depthBand = { lo: saved.lo, hi: saved.hi };
  }
} catch { /* ignore corrupt entry */ }

// ---------------------------------------------------------------- canvases
const scene = $('scene');
const overlay = $('overlay');
const overlayCtx = overlay.getContext('2d');
const previewWrap = $('preview');
const previewCanvas = $('preview-skeleton');
const previewCtx = previewCanvas.getContext('2d');

const field = new ParticleField(DOT_COUNT);
const tracker = new HandTracker({ onStatus: setStatus });
const audio = new AudioReactor();

// One canvas cannot hand out both a 2D and a WebGL context, so commit up front.
const glRenderer = GLRenderer.create(scene);
const sceneCtx = glRenderer ? null : scene.getContext('2d', { alpha: false });
if (glRenderer) glRenderer.attach(field);

const ui = {
  trails: cfg('trails') !== '0',
  showPreview: true,
  showOverlay: true,
  cameraOn: false,
  audioOn: false,
};

field.setShape(SHAPES.some((s) => s.id === cfg('shape')) ? cfg('shape') : 'galaxy');
if (cfg('palette')) field.setPalette(cfg('palette'));

// ---------------------------------------------------------------- smoothing
const sOffsetX = new Smoothed(0, 0.16);
const sOffsetY = new Smoothed(0, 0.16);
const sScale = new Smoothed(1, 0.12);
const sRoll = new SmoothedAngle(0, 0.18);
const sPitch = new Smoothed(-0.35, 0.07);
const sPinch = new Smoothed(0, 0.25);
const latch = new PoseLatch(320);

let prevPalmX = null;
let lastGestureLabel = 'none';
let bothFistsPrev = false;
let calibrating = 0;
let calibrationSum = 0;

// ---------------------------------------------------------------- sizing
let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  for (const c of [scene, overlay]) {
    c.width = Math.round(W * DPR);
    c.height = Math.round(H * DPR);
    c.style.width = W + 'px';
    c.style.height = H + 'px';
  }
  overlayCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
  if (sceneCtx) {
    sceneCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
    sceneCtx.fillStyle = '#040614';
    sceneCtx.fillRect(0, 0, W, H);
  }
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- gestures
function grabAt(screenX, screenY, strength) {
  const w = field.screenToWorld(screenX, screenY, W, H);
  field.attractor = { x: w.x, y: w.y, z: w.z, strength };
}

function applyHands(hands, dt) {
  if (hands.length === 0) {
    // Ease back to a calm default so the scene never feels abandoned.
    field.offset.x = sOffsetX.push(0, 0.05);
    field.offset.y = sOffsetY.push(0, 0.05);
    field.scale = sScale.push(1, 0.05);
    field.rot.z = sRoll.push(0, 0.05);
    field.rot.x = sPitch.push(-0.35, 0.03);
    field.attractor = null;
    sPinch.push(0, 0.1);
    prevPalmX = null;
    lastGestureLabel = 'waiting for a hand';
    return;
  }

  // A hand in frame is the user arriving; the demo loop has done its job.
  stopAttract();

  const read = hands.map((h) => readHand(h.landmarks, depthBand));
  if (calibrating > 0) sampleCalibration(read[0]);

  if (read.length >= 2) {
    twoHands(read[0], read[1], dt);
  } else {
    oneHand(read[0], dt);
  }
}

function oneHand(h, dt) {
  bothFistsPrev = false;

  field.offset.x = sOffsetX.push((h.center.x - 0.5) * W * 0.62);
  field.offset.y = sOffsetY.push((h.center.y - 0.5) * H * 0.62);
  field.scale = sScale.push(0.55 + h.depth * 1.5);
  field.rot.z = sRoll.push(-h.roll * 1.15);

  const pitch = clamp(-(h.landmarks[9].z - h.landmarks[0].z) / h.span, -1.2, 1.2);
  field.rot.x = sPitch.push(-0.35 + pitch * 0.75);

  // Sweeping the hand sideways flicks the cloud into a spin.
  if (prevPalmX !== null && dt > 0) {
    const vx = (h.center.x - prevPalmX) / dt;
    field.spin.y += clamp(vx, -4, 4) * 0.22;
  }
  prevPalmX = h.center.x;

  const pinch = sPinch.push(h.pinch);
  if (pinch > 0.55) {
    grabAt(h.center.x * W, h.center.y * H, (pinch - 0.55) * 26);
    lastGestureLabel = 'grab · squeezing the swarm';
    // Finger counts are meaningless mid-pinch, so hold the current shape.
    latch.push(null, performance.now());
    return;
  }

  field.attractor = null;
  const shapeId = SHAPE_BY_FINGERS.get(h.fingers);
  const committed = latch.push(shapeId ?? null, performance.now());
  if (committed) field.setShape(committed);
  lastGestureLabel = h.fingers + (h.fingers === 1 ? ' finger' : ' fingers');
}

function twoHands(a, b, dt) {
  const mx = (a.center.x + b.center.x) / 2;
  const my = (a.center.y + b.center.y) / 2;
  const spread = Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y);

  field.offset.x = sOffsetX.push((mx - 0.5) * W * 0.62);
  field.offset.y = sOffsetY.push((my - 0.5) * H * 0.62);
  field.scale = sScale.push(clamp(0.35 + spread * 2.4, 0.3, 2.6));

  // Hands act like a steering wheel for roll.
  const tilt = Math.atan2(b.center.y - a.center.y, b.center.x - a.center.x);
  field.rot.z = sRoll.push(tilt);

  const pitchA = -(a.landmarks[9].z - a.landmarks[0].z) / a.span;
  const pitchB = -(b.landmarks[9].z - b.landmarks[0].z) / b.span;
  field.rot.x = sPitch.push(-0.35 + clamp((pitchA + pitchB) / 2, -1.2, 1.2) * 0.75);

  prevPalmX = null;
  const pinch = sPinch.push(Math.max(a.pinch, b.pinch), 0.2);

  const bothFists = a.fingers === 0 && b.fingers === 0;
  if (bothFists && !bothFistsPrev) field.burst(8);
  bothFistsPrev = bothFists;

  if (bothFists) {
    field.attractor = null;
    lastGestureLabel = 'double fist · supernova';
    return;
  }

  // Two-handed pinch grabs at the midpoint, same as one hand at the palm.
  if (pinch > 0.55) {
    grabAt(mx * W, my * H, (pinch - 0.55) * 26);
    lastGestureLabel = 'two hands · grab';
    latch.push(null, performance.now());
    return;
  }

  field.attractor = null;
  // Only a deliberate symmetric pose changes shape while both hands are up.
  if (a.fingers === b.fingers && a.fingers > 0) {
    const shapeId = SHAPE_BY_FINGERS.get(a.fingers);
    const committed = latch.push(shapeId ?? null, performance.now());
    if (committed) field.setShape(committed);
  } else {
    latch.push(null, performance.now());
  }
  lastGestureLabel = 'two hands · stretch ' + field.scale.toFixed(2) + '×';
}

// ---------------------------------------------------------------- calibration
function beginCalibration() {
  if (!ui.cameraOn) {
    setStatus('turn the camera on first', 'error');
    return;
  }
  calibrating = 45;
  calibrationSum = 0;
  setStatus('hold your hand still…', 'busy');
}

function sampleCalibration(h) {
  calibrationSum += h.span;
  calibrating--;
  if (calibrating > 0) return;
  depthBand = calibrateDepthBand(calibrationSum / 45);
  store.set('gs.depthBand', JSON.stringify(depthBand));
  setStatus('calibrated · tracking', 'live');
}

// ---------------------------------------------------------------- overlays
function drawOverlay(hands) {
  overlayCtx.clearRect(0, 0, W, H);
  if (!ui.showOverlay || hands.length === 0) return;

  for (const hand of hands) {
    const lm = hand.landmarks;
    const cx = ((lm[0].x + lm[9].x) / 2) * W;
    const cy = ((lm[0].y + lm[9].y) / 2) * H;
    const pinch = sPinch.value;
    const r = 26 + pinch * 24;

    overlayCtx.beginPath();
    overlayCtx.arc(cx, cy, r, 0, Math.PI * 2);
    overlayCtx.strokeStyle = 'rgba(103, 232, 249, ' + (0.28 + pinch * 0.5) + ')';
    overlayCtx.lineWidth = 1.5;
    overlayCtx.stroke();

    overlayCtx.beginPath();
    overlayCtx.arc(cx, cy, 3.5, 0, Math.PI * 2);
    overlayCtx.fillStyle = 'rgba(240, 171, 252, 0.9)';
    overlayCtx.fill();
  }
}

function drawPreviewSkeleton(hands) {
  const w = previewCanvas.width;
  const h = previewCanvas.height;
  previewCtx.clearRect(0, 0, w, h);
  if (hands.length === 0) return;

  for (const hand of hands) {
    const lm = hand.landmarks;
    previewCtx.strokeStyle = 'rgba(103, 232, 249, 0.85)';
    previewCtx.lineWidth = 2;
    previewCtx.beginPath();
    for (const [i, j] of HAND_BONES) {
      previewCtx.moveTo(lm[i].x * w, lm[i].y * h);
      previewCtx.lineTo(lm[j].x * w, lm[j].y * h);
    }
    previewCtx.stroke();

    previewCtx.fillStyle = 'rgba(240, 171, 252, 0.95)';
    for (const p of lm) {
      previewCtx.beginPath();
      previewCtx.arc(p.x * w, p.y * h, 2.4, 0, Math.PI * 2);
      previewCtx.fill();
    }
  }
}

// ---------------------------------------------------------------- HUD
const elShape = $('hud-shape');
const elGesture = $('hud-gesture');
const elHands = $('hud-hands');
const elScale = $('hud-scale');
const elFps = $('hud-fps');
const elDots = $('hud-dots');
const elStatus = $('status-text');
const elStatusDot = $('status-dot');
const elLatch = $('latch-bar');

function setStatus(text, state = 'busy') {
  elStatus.textContent = text;
  elStatusDot.dataset.state = state;
}

let renderFps = 0, frameAcc = 0, frameClock = performance.now();
function updateHud(hands) {
  const shape = SHAPES.find((s) => s.id === field.shapeId);
  elShape.textContent = shape ? shape.name : '—';
  elGesture.textContent = lastGestureLabel;
  elHands.textContent = hands.length ? String(hands.length) : '0';
  elScale.textContent = field.scale.toFixed(2) + '×';
  elFps.textContent = renderFps + ' fps';
  if (elDots) elDots.textContent = DOT_COUNT + (glRenderer ? ' · gl' : ' · 2d');
  elLatch.style.transform = 'scaleX(' + latch.progress.toFixed(3) + ')';
}

// ---------------------------------------------------------------- attract loop
// Cycles the catalogue while the intro card is up, so the first thing a
// visitor sees is the thing the app does. Any input retires it for good.
let attract = true;
let attractClock = 0;
const ATTRACT_DWELL = 3000;

function stopAttract() {
  attract = false;
}

function runAttract(now) {
  if (!attract) return;
  if ($('intro').classList.contains('is-hidden')) { attract = false; return; }
  if (attractClock === 0) { attractClock = now; return; }
  if (now - attractClock < ATTRACT_DWELL) return;
  attractClock = now;
  const i = SHAPES.findIndex((s) => s.id === field.shapeId);
  field.setShape(SHAPES[(i + 1) % SHAPES.length].id);
}

// ---------------------------------------------------------------- loop
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  // Clamp both ends: a backgrounded tab returns a huge delta on resume, and a
  // non-monotonic clock would otherwise run the integrator backwards.
  const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
  last = now;

  const hands = tracker.detect(now);
  applyHands(hands, dt);
  runAttract(now);
  if (ui.audioOn) field.energy = audio.sample();

  field.update(dt);
  if (glRenderer) glRenderer.render(field, W, H, { trails: ui.trails, dpr: DPR });
  else field.render(sceneCtx, W, H, { trails: ui.trails });

  drawOverlay(hands);
  if (ui.showPreview && ui.cameraOn) drawPreviewSkeleton(hands);

  frameAcc++;
  if (now - frameClock > 500) {
    renderFps = Math.round((frameAcc * 1000) / (now - frameClock));
    frameAcc = 0;
    frameClock = now;
  }
  updateHud(hands);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------- url state
function syncUrl() {
  if (!globalThis.history?.replaceState || !globalThis.location) return;
  const p = new URLSearchParams();
  p.set('shape', field.shapeId);
  p.set('palette', field.paletteId);
  if (!ui.trails) p.set('trails', '0');
  if (DOT_COUNT !== 1000) p.set('dots', String(DOT_COUNT));
  try { globalThis.history.replaceState(null, '', '#' + p.toString()); } catch { /* opaque origin */ }
}

// ---------------------------------------------------------------- controls
async function enableCamera() {
  const btn = $('btn-camera');
  if (ui.cameraOn) {
    tracker.stop();
    ui.cameraOn = false;
    previewWrap.hidden = true;
    btn.textContent = 'Enable camera';
    btn.classList.remove('is-live');
    setStatus('camera off', 'off');
    return;
  }
  btn.disabled = true;
  try {
    await tracker.start();
    ui.cameraOn = true;
    previewWrap.hidden = !ui.showPreview;
    btn.textContent = 'Stop camera';
    btn.classList.add('is-live');
    setStatus('tracking', 'live');
    $('intro').classList.add('is-hidden');
  } catch (err) {
    const msg = err?.name === 'NotAllowedError'
      ? 'camera permission denied'
      : err?.name === 'NotFoundError'
        ? 'no camera found'
        : 'camera or model failed to load';
    setStatus(msg, 'error');
    console.error('[galaxy-spiral]', err);
  } finally {
    btn.disabled = false;
  }
}

async function toggleAudio() {
  const btn = $('btn-audio');
  if (ui.audioOn) {
    audio.stop();
    ui.audioOn = false;
    field.energy = 0;
    btn?.setAttribute('aria-pressed', 'false');
    return;
  }
  if (!AudioReactor.supported) {
    setStatus('audio unavailable', 'error');
    return;
  }
  try {
    await audio.start();
    ui.audioOn = true;
    btn?.setAttribute('aria-pressed', 'true');
  } catch {
    setStatus('microphone denied', 'error');
  }
}

function cyclePalette() {
  const next = field.cyclePalette(1);
  const btn = $('btn-palette');
  if (btn) btn.textContent = next.name;
  syncUrl();
}

$('btn-camera').addEventListener('click', enableCamera);
$('btn-start').addEventListener('click', enableCamera);
$('btn-skip').addEventListener('click', () => { stopAttract(); $('intro').classList.add('is-hidden'); });

$('btn-trails').addEventListener('click', (e) => {
  ui.trails = !ui.trails;
  e.currentTarget.setAttribute('aria-pressed', String(ui.trails));
  syncUrl();
});
$('btn-preview').addEventListener('click', (e) => {
  ui.showPreview = !ui.showPreview;
  previewWrap.hidden = !(ui.showPreview && ui.cameraOn);
  e.currentTarget.setAttribute('aria-pressed', String(ui.showPreview));
});
$('btn-burst').addEventListener('click', () => field.burst(8));
$('btn-panel').addEventListener('click', () => document.body.classList.toggle('panel-collapsed'));
$('btn-palette')?.addEventListener('click', cyclePalette);
$('btn-audio')?.addEventListener('click', toggleAudio);
$('btn-calibrate')?.addEventListener('click', beginCalibration);

// Sliders own their defaults in JS so the readout and the field cannot drift.
const ctlMorph = $('ctl-morph');
const ctlDrift = $('ctl-drift');
function bindSlider(el, label, apply, initial) {
  if (!el) return;
  el.value = String(initial);
  const run = () => {
    const v = Number(el.value);
    if (Number.isFinite(v)) apply(v);
    const out = $(label);
    if (out) out.textContent = Number(el.value).toFixed(2) + '×';
  };
  el.addEventListener('input', run);
  el.addEventListener('change', run);
  run();
}
bindSlider(ctlMorph, 'out-morph', (v) => { field.morph = v; }, 1);
bindSlider(ctlDrift, 'out-drift', (v) => { field.turbulence = v; }, 1);

// Shape chips double as the legend and as a click-to-switch control.
const chipHost = $('shape-list');
for (const [i, s] of SHAPES.entries()) {
  const chip = document.createElement('button');
  chip.className = 'chip';
  chip.type = 'button';
  chip.dataset.shape = s.id;
  chip.innerHTML = '<span class="chip-key">' + (i + 1) + '</span>' +
    '<span class="chip-name">' + s.name + '</span>' +
    '<span class="chip-hint">' + s.hint + '</span>';
  chip.addEventListener('click', () => { stopAttract(); field.setShape(s.id); syncUrl(); });
  chipHost.appendChild(chip);
}
function syncChips() {
  for (const chip of chipHost.children) {
    chip.classList.toggle('is-active', chip.dataset.shape === field.shapeId);
  }
  requestAnimationFrame(syncChips);
}
syncChips();

// --------------------------------------------------- keyboard / mouse fallback
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  stopAttract();
  const n = Number(e.key);
  if (n >= 1 && n <= SHAPES.length) {
    field.setShape(SHAPES[n - 1].id);
    syncUrl();
    return;
  }
  switch (e.key.toLowerCase()) {
    case ' ': e.preventDefault(); field.burst(8); break;
    case 't': $('btn-trails').click(); break;
    case 'c': enableCamera(); break;
    case 'p': $('btn-preview').click(); break;
    case 'h': document.body.classList.toggle('ui-hidden'); break;
    case 'g': cyclePalette(); break;
    case 'k': beginCalibration(); break;
    case 'a': toggleAudio(); break;
  }
});

let dragging = false, dragX = 0, dragY = 0;
scene.addEventListener('pointerdown', (e) => {
  stopAttract();
  if (ui.cameraOn) return;
  dragging = true;
  dragX = e.clientX;
  dragY = e.clientY;
  scene.setPointerCapture(e.pointerId);
});
scene.addEventListener('pointermove', (e) => {
  if (!dragging || ui.cameraOn) return;
  const dx = e.clientX - dragX;
  const dy = e.clientY - dragY;
  dragX = e.clientX;
  dragY = e.clientY;
  field.spin.y += dx * 0.004;
  field.rot.x = clamp(field.rot.x + dy * 0.005, -1.4, 1.0);
  sPitch.set(field.rot.x);
});
const endDrag = () => { dragging = false; };
scene.addEventListener('pointerup', endDrag);
scene.addEventListener('pointercancel', endDrag);
scene.addEventListener('wheel', (e) => {
  if (ui.cameraOn) return;
  e.preventDefault();
  field.scale = clamp(field.scale * (e.deltaY > 0 ? 0.93 : 1.075), 0.3, 3);
  sScale.set(field.scale);
}, { passive: false });

// Hand the tracker's video element to the preview slot.
previewWrap.prepend(tracker.video);
tracker.video.className = 'preview-video';
setStatus('camera off', 'off');
if ($('btn-palette')) $('btn-palette').textContent = PALETTES.find((p) => p.id === field.paletteId).name;
syncUrl();

// Caches the CDN runtime and the ~8MB hand model so later visits work offline.
if (globalThis.navigator?.serviceWorker && globalThis.location?.protocol?.startsWith('http')) {
  globalThis.navigator.serviceWorker.register('sw.js').catch(() => { /* not fatal */ });
}

// Console handle: `galaxySpiral.field.setShape('torus')`, etc.
window.galaxySpiral = { field, tracker, ui, SHAPES, PALETTES, audio, renderer: glRenderer ? 'webgl2' : '2d' };

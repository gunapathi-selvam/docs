// Orchestrator: DOM wiring, input, URL state, failure presentation, frame loop.
// The only module allowed to touch document or window.

import {
  COUNT_DEFAULT, COUNT_MIN, COUNT_MAX, UNIFORMS,
  clampCount, workgroupCount,
} from './layout.js';
import { SHAPES, createShapeCache } from './shapes.js';
import { DEFAULT_CAMERA, viewProj, orbit, dolly, pointerToWorld } from './camera.js';
import { clampDt } from './integrator.js';
import {
  initDevice, createBuffers, createPipelines, createBindGroups,
  seedParticles, writeTargets, encodeFrame, destroyAll, onDeviceLost,
} from './gpu.js';
import { HandTracker, HAND_BONES } from './handTracker.js';
import { createAirPointer } from './airPointer.js';

export const FAILURES = {
  'no-gpu': {
    title: 'WebGPU is not available in this browser',
    body: 'This page needs WebGPU. Chrome 121+, Edge 121+, Safari 18+ or Firefox 141+ will work. Galaxy Spiral is the WebGL2 version of this idea and runs anywhere.',
  },
  'no-adapter': {
    title: 'No GPU adapter was returned',
    body: 'The browser supports WebGPU but could not get an adapter. On Linux, Chrome may need --enable-unsafe-webgpu. A software renderer will also fail this check.',
  },
  limits: {
    title: 'This GPU cannot hold the particle field',
    body: 'The adapter reports a smaller maximum storage buffer than a million particles need. Try ?dots= with a smaller power of two.',
  },
  device: {
    title: 'The GPU device could not be created',
    body: 'The adapter was found but requestDevice() failed.',
  },
  shader: {
    title: 'A shader failed to compile',
    body: 'The messages below come straight from the GPU driver.',
  },
  frame: {
    title: 'The frame loop stopped',
    body: 'An error was thrown while encoding a frame. The stack is below.',
  },
  lost: {
    title: 'The GPU device was lost',
    body: 'This usually means a driver reset or the tab was backgrounded for a long time. Reload to start again.',
  },
};

/** Read ?dots= / ?shape= / ?palette= and clamp into range. SPEC §8. */
export function readUrlState(search) {
  const q = new URLSearchParams(String(search ?? '').replace(/^[#?]/, ''));

  const rawDots = Number.parseInt(q.get('dots') ?? '', 10);
  const count = Number.isFinite(rawDots) ? clampCount(rawDots) : COUNT_DEFAULT;

  const rawShape = Number.parseInt(q.get('shape') ?? '', 10);
  const shape = Number.isFinite(rawShape) && rawShape >= 0 && rawShape < SHAPES.length ? rawShape : 0;

  const rawPalette = Number.parseInt(q.get('palette') ?? '', 10);
  const palette = Number.isFinite(rawPalette) && rawPalette >= 0 ? rawPalette % 4 : 0;

  return { count, shape, palette };
}

/** Mirror current state to the hash so a view is shareable. */
export function writeUrlState(state) {
  const q = new URLSearchParams();
  q.set('dots', String(state.count));
  q.set('shape', String(state.shape));
  q.set('palette', String(state.palette ?? 0));
  const hash = `#${q.toString()}`;
  if (typeof location !== 'undefined' && typeof history !== 'undefined') {
    history.replaceState(null, '', hash);
  }
  return hash;
}

/**
 * Show a failure page. Every terminal path routes here — SPEC §9 requires that
 * no failure leaves the user looking at a black rectangle with no explanation.
 * `detail` carries shader compilationInfo() messages when present.
 */
export function showFailure(doc, reason, detail) {
  const copy = FAILURES[reason] ?? {
    title: 'Something went wrong',
    body: String(reason ?? 'An unknown error occurred.'),
  };

  const section = doc.getElementById('failure');
  const title = doc.getElementById('failure-title');
  const body = doc.getElementById('failure-body');
  const pre = doc.getElementById('failure-detail');

  if (title) title.textContent = copy.title;
  if (body) body.textContent = copy.body;

  if (pre) {
    // Explicitly re-hidden when there is nothing to show: the element starts
    // visible in a bare DOM, so leaving it alone would print an empty box.
    if (detail) {
      pre.textContent = String(detail);
      pre.hidden = false;
    } else {
      pre.textContent = '';
      pre.hidden = true;
    }
  }

  if (section) section.hidden = false;
  for (const id of ['intro', 'panel']) {
    const el = doc.getElementById(id);
    if (el) el.hidden = true;
  }
}

/** Bind keys, pointer drag, wheel and the panel controls. SPEC §8. */
export function bindInput(doc, state, handlers = {}) {
  const stage = doc.getElementById('stage');
  const h = handlers;

  if (stage) {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    stage.addEventListener('pointerdown', (ev) => {
      dragging = true;
      lastX = ev.clientX ?? 0;
      lastY = ev.clientY ?? 0;
      if (typeof stage.setPointerCapture === 'function' && ev.pointerId != null) {
        stage.setPointerCapture(ev.pointerId);
      }
      h.onGrabStart?.(ev);
    });

    stage.addEventListener('pointermove', (ev) => {
      const x = ev.clientX ?? 0;
      const y = ev.clientY ?? 0;
      if (dragging) h.onOrbit?.(x - lastX, y - lastY);
      lastX = x;
      lastY = y;
      h.onPointerMove?.(x, y);
    });

    const release = (ev) => { dragging = false; h.onGrabEnd?.(ev); };
    stage.addEventListener('pointerup', release);
    stage.addEventListener('pointercancel', release);

    stage.addEventListener('wheel', (ev) => {
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      h.onDolly?.(ev.deltaY ?? 0);
    }, { passive: false });
  }

  const chips = doc.getElementById('shapes');
  if (chips && typeof chips.querySelectorAll === 'function') {
    for (const btn of chips.querySelectorAll('[data-shape]')) {
      btn.addEventListener('click', () => h.onShape?.(Number(btn.dataset.shape)));
    }
  }

  for (const [id, key] of [['stiffness', 'stiffness'], ['damping', 'damping'], ['drift', 'drift']]) {
    const el = doc.getElementById(id);
    if (!el) continue;
    el.addEventListener('input', () => {
      const v = Number(el.value);
      const out = doc.getElementById(`${id}-out`);
      if (out) out.textContent = v.toFixed(2);
      h.onSlider?.(key, v);
    });
  }

  const begin = doc.getElementById('begin');
  if (begin) begin.addEventListener('click', () => h.onBegin?.());

  doc.addEventListener?.('keydown', (ev) => {
    const k = ev.key;
    if (k >= '1' && k <= '8') { h.onShape?.(Number(k) - 1); return; }
    if (k === ' ') { if (typeof ev.preventDefault === 'function') ev.preventDefault(); h.onBurst?.(); return; }
    if (k === 'g' || k === 'G') { h.onPalette?.(); return; }
    if (k === 'r' || k === 'R') { h.onResetCamera?.(); }
  });

  return state;
}

/** Push diagnostics into the panel. Text only — no layout thrash per frame. */
export function updateReadout(doc, stats) {
  const set = (id, text) => {
    const el = doc.getElementById(id);
    if (el) el.textContent = text;
  };
  const ms = (v) => (Number.isFinite(v) ? `${v.toFixed(2)} ms` : '—');

  set('r-count', Number(stats.count ?? 0).toLocaleString('en-US'));
  set('r-groups', String(stats.groups ?? '—'));
  set('r-frame', ms(stats.frame));
  set('r-compute', ms(stats.compute));
  set('r-render', ms(stats.render));
  // Stated in bytes, not rounded to KiB: the whole point is that it is 128 and
  // does not move with the particle count. SPEC §10.
  set('r-upload', `${stats.upload ?? UNIFORMS.SIZE} B`);
  set('r-adapter', String(stats.adapter ?? '—'));
  set('r-resident', String(stats.resident ?? '—'));
}

/**
 * Resize the canvas backing store to the device pixel ratio, clamped to the
 * adapter's maxTextureDimension2D. Returns true when the size changed.
 */
export function resize(canvas, dpr, maxDimension) {
  const cap = Number.isFinite(maxDimension) && maxDimension > 0 ? maxDimension : 8192;
  const w = Math.max(1, Math.min(cap, Math.floor((canvas.clientWidth || 1) * dpr)));
  const h = Math.max(1, Math.min(cap, Math.floor((canvas.clientHeight || 1) * dpr)));
  if (canvas.width === w && canvas.height === h) return false;
  canvas.width = w;
  canvas.height = h;
  return true;
}

/**
 * Draw the MediaPipe skeleton and index-tip dot onto the preview canvas.
 * lm: landmarks from HandTracker (already x-mirrored to match selfie view).
 */
function drawSkeleton(canvas2d, lm, video) {
  if (!canvas2d) return;
  const ctx2d = canvas2d.getContext && canvas2d.getContext('2d');
  if (!ctx2d) return;
  const w = canvas2d.width || 160;
  const h = canvas2d.height || 120;
  ctx2d.clearRect(0, 0, w, h);
  // Draw video mirrored so it matches the selfie-view landmark coordinates.
  if (video && video.readyState >= 2) {
    ctx2d.save();
    ctx2d.translate(w, 0);
    ctx2d.scale(-1, 1);
    ctx2d.drawImage(video, 0, 0, w, h);
    ctx2d.restore();
  }
  // Skeleton: landmarks are in mirrored space, so they overlay correctly.
  ctx2d.strokeStyle = '#6ea8ff';
  ctx2d.lineWidth = 1.5;
  for (const [a, b] of HAND_BONES) {
    ctx2d.beginPath();
    ctx2d.moveTo(lm[a].x * w, lm[a].y * h);
    ctx2d.lineTo(lm[b].x * w, lm[b].y * h);
    ctx2d.stroke();
  }
  // Highlight the index fingertip used for the air pointer.
  ctx2d.fillStyle = '#ffb4a2';
  ctx2d.beginPath();
  ctx2d.arc(lm[8].x * w, lm[8].y * h, 4, 0, 6.2832);
  ctx2d.fill();
}

export async function boot(doc = document, nav = navigator) {
  const canvas = doc.getElementById('stage');
  const intro = doc.getElementById('intro');
  const panel = doc.getElementById('panel');

  // Shown while shaders compile and the first shape is generated. Both are
  // fast, but a blank page during them looks like a failure.
  if (intro) intro.hidden = false;

  let ctx, device, adapter, limits, buffers, pipelines, bindGroups;

  try {
    ({ device, adapter, limits } = await initDevice(nav.gpu, (err) => {
      console.error('[webgpu] uncaptured', err);
    }));
  } catch (err) {
    showFailure(doc, err.reason ?? 'device', err.detail ?? err.message);
    return null;
  }

  const url = readUrlState(typeof location !== 'undefined' ? location.hash || location.search : '');
  const count = clampCount(url.count, limits.maxStorageBufferBindingSize);

  if (count < COUNT_MIN) {
    showFailure(doc, 'limits', `Only ${count} particles fit in this adapter's storage limit.`);
    return null;
  }

  const format = nav.gpu.getPreferredCanvasFormat();
  ctx = canvas.getContext('webgpu');
  if (!ctx) {
    showFailure(doc, 'no-gpu', "canvas.getContext('webgpu') returned null.");
    return null;
  }
  ctx.configure({ device, format, alphaMode: 'opaque' });

  try {
    pipelines = await createPipelines(device, format);
  } catch (err) {
    showFailure(doc, 'shader', err.detail ?? err.message);
    return null;
  }

  buffers = createBuffers(device, count);
  bindGroups = createBindGroups(device, pipelines, buffers);

  const cache = createShapeCache(count);
  const state = {
    ...DEFAULT_CAMERA,
    shape: url.shape,
    palette: url.palette,
    stiffness: 13,
    damping: 0.88,
    drift: 0.2,
    grabPoint: [0, 0, 0],
    grabRadius: 0,
    grabForce: 0,
    time: 0,
    dt: 1 / 60,
    count,
    viewProj: new Float32Array(16),
  };

  let targets = cache.get(SHAPES[state.shape].id);
  writeTargets(device, buffers.targets, targets);
  seedParticles(device, buffers.particleA, count, targets);
  seedParticles(device, buffers.particleB, count, targets);

  const res = {
    count,
    state,
    buffers,
    pipelines,
    bindGroups,
    uniformData: new ArrayBuffer(UNIFORMS.SIZE),
  };

  const setShape = (index) => {
    if (index < 0 || index >= SHAPES.length) return;
    state.shape = index;
    targets = cache.get(SHAPES[index].id);
    writeTargets(device, buffers.targets, targets);
    for (const btn of doc.getElementById('shapes')?.querySelectorAll?.('[data-shape]') ?? []) {
      btn.setAttribute('aria-pressed', String(Number(btn.dataset.shape) === index));
    }
    writeUrlState(state);
  };

  let pointer = { x: 0, y: 0 };
  let burstUntil = 0;

  // Hand tracking state. Not enabled on page load -- user must click Enable.
  let handEnabled = false;
  let handTracker = null;
  let airPtr = null;
  // Last cursor position while pinched, for the orbit delta. null when open.
  let handPrev = null;
  const handCursor = doc.getElementById('hand-cursor');
  const handPreview = doc.getElementById('hand-preview');
  const reachFill = doc.getElementById('reach-fill');
  const handEnableBtn = doc.getElementById('hand-enable');
  const handStatus = doc.getElementById('hand-status');
  const handError = doc.getElementById('hand-error');
  const handPreviewWrap = doc.getElementById('hand-preview-wrap');
  const reachMeterWrap = doc.getElementById('reach-meter-wrap');
  const handControls = doc.getElementById('hand-controls');
  if (handControls) handControls.hidden = false;

  // Live threshold tuning. Applies to the running pointer immediately so the
  // user can dial it in while watching their own reach number, instead of
  // needing a reload per attempt.
  const pressSlider = doc.getElementById('press-reach');
  const pressOut = doc.getElementById('press-reach-out');
  if (pressSlider) {
    pressSlider.addEventListener('input', () => {
      const v = Number(pressSlider.value);
      if (pressOut) pressOut.textContent = v.toFixed(2);
      if (airPtr) airPtr.setPressReach(v);
    });
  }

  bindInput(doc, state, {
    onOrbit: (dx, dy) => orbit(state, dx, dy, canvas.clientHeight || 800),
    onDolly: (dy) => dolly(state, dy),
    onShape: setShape,
    onPalette: () => { state.palette = (state.palette + 1) % 4; writeUrlState(state); },
    onResetCamera: () => Object.assign(state, {
      yaw: DEFAULT_CAMERA.yaw, pitch: DEFAULT_CAMERA.pitch, distance: DEFAULT_CAMERA.distance,
    }),
    onBurst: () => { state.grabForce = -28; state.grabRadius = 6; burstUntil = performance.now() + 140; },
    onPointerMove: (x, y) => { pointer = { x, y }; },
    onGrabStart: () => { state.grabForce = 9; state.grabRadius = 1.2; },
    onGrabEnd: () => { if (burstUntil < performance.now()) { state.grabForce = 0; state.grabRadius = 0; } },
    onSlider: (key, v) => { state[key] = v; },
    onBegin: () => { if (intro) intro.hidden = true; },
  });

  // Hand tracking enable / disable. Camera is not requested until the user
  // clicks Enable -- auto-requesting on load is hostile. SPEC §1.2.
  if (handEnableBtn) {
    handEnableBtn.addEventListener('click', async () => {
      if (handEnabled) {
        // Disable: stop tracker, hide UI.
        if (handTracker) { handTracker.stop(); handTracker = null; }
        airPtr = null;
        handEnabled = false;
        handEnableBtn.textContent = 'Enable';
        if (handCursor) handCursor.hidden = true;
        if (handPreviewWrap) handPreviewWrap.hidden = true;
        if (reachMeterWrap) reachMeterWrap.hidden = true;
        if (handStatus) handStatus.textContent = '';
        if (handError) handError.hidden = true;
        return;
      }

      // Enable: request camera, load model.
      if (handError) handError.hidden = true;
      try {
        handTracker = new HandTracker({
          onStatus: (msg) => { if (handStatus) handStatus.textContent = msg; },
        });
        await handTracker.start();
        airPtr = createAirPointer();
        handEnabled = true;
        handEnableBtn.textContent = 'Disable';
        if (handPreviewWrap) handPreviewWrap.hidden = false;
        if (reachMeterWrap) reachMeterWrap.hidden = false;
        for (const id of ['hand-readout', 'press-reach', 'press-reach-label', 'press-reach-hint']) {
          const el = doc.getElementById(id);
          if (el) el.hidden = false;
        }
      } catch (err) {
        handTracker = null;
        // Three distinct camera failure types, each needing a distinct message.
        let msg;
        if (err.name === 'NotAllowedError') {
          msg = 'Camera access was denied. Allow camera permission in the browser bar and try again.';
        } else if (err.name === 'NotFoundError') {
          msg = 'No camera found. Connect a camera and try again.';
        } else if (err.name === 'NotReadableError') {
          msg = 'Camera is in use by another application. Close it and try again.';
        } else {
          msg = 'Hand tracking failed: ' + (err.message || String(err));
        }
        if (handError) { handError.textContent = msg; handError.hidden = false; }
        if (handStatus) handStatus.textContent = 'error';
      }
    });
  }

  onDeviceLost(device, (info) => {
    destroyAll(buffers);
    showFailure(doc, 'lost', info?.message);
  });

  if (intro) intro.hidden = true;
  if (panel) panel.hidden = false;
  setShape(state.shape);

  let frame = 0;
  let last = performance.now();
  let acc = 0;
  let accFrames = 0;

  // A throw inside the frame loop otherwise kills the rAF chain and leaves a
  // black canvas with the error only in the console — the exact outcome SPEC §9
  // forbids. Reported once, then the loop stops rather than spamming.
  let fatal = false;
  function guarded(now) {
    if (fatal) return;
    try {
      tick(now);
    } catch (err) {
      fatal = true;
      console.error('[frame]', err);
      showFailure(doc, 'frame', `${err?.name ?? 'Error'}: ${err?.message ?? err}\n\n${err?.stack ?? ''}`);
    }
  }

  function tick(now) {
    const raw = (now - last) / 1000;
    last = now;
    state.dt = clampDt(raw);
    state.time += state.dt;

    if (burstUntil && now > burstUntil) {
      burstUntil = 0;
      state.grabForce = 0;
      state.grabRadius = 0;
    }

    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    if (resize(canvas, dpr, limits.maxTextureDimension2D)) {
      ctx.configure({ device, format, alphaMode: 'opaque' });
    }

    const aspect = canvas.width / Math.max(1, canvas.height);
    viewProj(state, aspect, state.viewProj);

    // Hand tracking: detect landmarks, update air pointer, drive grab.
    if (handEnabled && handTracker && airPtr) {
      const hands = handTracker.detect(now);
      if (hands.length > 0) {
        // HandTracker already mirrors x. Un-mirror before passing to airPointer,
        // which re-applies the mirror internally so the cursor follows correctly.
        const rawLm = hands[0].landmarks.map(function(p) {
          return { x: 1 - p.x, y: p.y, z: p.z };
        });
        const ap = airPtr.update(
          rawLm, now,
          canvas.clientWidth || 800,
          canvas.clientHeight || 600,
        );

        // Update the shared pointer so the existing grab-point code picks it up.
        pointer = { x: ap.x, y: ap.y };

        // Three gestures that compose rather than exclude each other:
        //   move an open hand      -> rotate
        //   pinch and hold still   -> grab
        //   pinch and move         -> both at once
        //
        // Rotation is unconditional on hand movement, which works here only
        // because there is nothing on screen to point at — the cursor exists to
        // place the grab, so there is no need to move it without rotating.
        for (const ev of ap.events) {
          if (ev.type === 'down') {
            state.grabForce = 9;
            state.grabRadius = 1.2;
          } else if (ev.type === 'up' && burstUntil < now) {
            state.grabForce = 0;
            state.grabRadius = 0;
          }
        }

        if (handPrev) {
          const dx = ap.x - handPrev.x;
          const dy = ap.y - handPrev.y;
          // Deadzone: landmark jitter is a pixel or two every frame even for a
          // perfectly still hand, and without this the camera drifts
          // continuously while the user is doing nothing.
          if (Math.hypot(dx, dy) > 1.5) {
            orbit(state, dx, dy, canvas.clientHeight || 800);
            handPrev = { x: ap.x, y: ap.y };
          }
        } else {
          handPrev = { x: ap.x, y: ap.y };
        }

        // Move on-screen cursor marker.
        if (handCursor) {
          handCursor.hidden = false;
          handCursor.style.left = ap.x + 'px';
          handCursor.style.top = ap.y + 'px';
          handCursor.classList.toggle('pressed', ap.state === 'pressed');
        }

        // Update reach meter.
        if (reachFill) reachFill.style.height = (ap.normalisedReach * 100) + '%';

        // Live numbers. Without these a threshold mismatch is indistinguishable
        // from a broken tap detector: the cursor tracks and nothing ever clicks.
        const setTxt = (id, txt) => {
          const el = doc.getElementById(id);
          if (el) el.textContent = txt;
        };
        setTxt('h-reach', ap.reach.toFixed(2) + (ap.reach >= ap.pressReach ? '  over' : ''));
        setTxt('h-range', ap.observed
          ? ap.observed.min.toFixed(2) + ' .. ' + ap.observed.max.toFixed(2)
          : 'calibrating');
        setTxt('h-state', ap.state);

        // Draw skeleton over the preview canvas.
        drawSkeleton(handPreview, hands[0].landmarks, handTracker.video);
      } else {
        if (handCursor) handCursor.hidden = true;
        // Hand left the frame. Drop the anchor so re-entering elsewhere does
        // not orbit by the whole gap between where it vanished and reappeared,
        // and release any grab that was held when tracking was lost.
        handPrev = null;
        if (burstUntil < now) {
          state.grabForce = 0;
          state.grabRadius = 0;
        }
      }
    }

    if (state.grabRadius > 0 && burstUntil === 0) {
      const ndcX = (pointer.x / Math.max(1, canvas.clientWidth)) * 2 - 1;
      const ndcY = 1 - (pointer.y / Math.max(1, canvas.clientHeight)) * 2;
      state.grabPoint = pointerToWorld(state, aspect, ndcX, ndcY, 0);
    }

    encodeFrame(device, ctx, res, frame);
    frame++;

    acc += (performance.now() - now);
    accFrames++;
    // Publish on the very first frame as well as every 30th. Waiting for the
    // first full window leaves every readout showing an em-dash for half a
    // second, which is indistinguishable from a dead loop.
    if (accFrames >= 30 || frame === 1) {
      updateReadout(doc, {
        count,
        groups: workgroupCount(count),
        frame: acc / accFrames,
        upload: UNIFORMS.SIZE,
        adapter: adapter?.info?.vendor || adapter?.info?.architecture || 'unknown',
        resident: cache.size(),
      });
      acc = 0;
      accFrames = 0;
    }

    requestAnimationFrame(guarded);
  }

  requestAnimationFrame(guarded);
  return { device, res, state };
}

// Guard so the module can be imported by the test harness without booting.
if (typeof document !== 'undefined' && !globalThis.__WGP_TEST__) {
  boot();
}

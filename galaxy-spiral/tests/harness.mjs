// Shared fake-DOM harness: builds elements from index.html, mocks the clock so
// frame time and performance.now() advance together, then boots main.js.
import { readFileSync } from 'node:fs';

export const ROOT = new URL('../', import.meta.url);
const file = (rel) => new URL(rel, ROOT);

class ClassList {
  constructor() { this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const want = force === undefined ? !this.set.has(c) : force;
    want ? this.set.add(c) : this.set.delete(c);
    return want;
  }
}

export const ctxCalls = { arc: 0, fill: 0, stroke: 0, bad: 0 };
const num = (...v) => v.every((x) => typeof x === 'number' && Number.isFinite(x));
const makeCtx = () => ({
  globalCompositeOperation: '', fillStyle: '', strokeStyle: '', lineWidth: 1,
  setTransform() {}, save() {}, restore() {}, translate() {}, scale() {},
  beginPath() {}, closePath() {},
  moveTo(x, y) { if (!num(x, y)) ctxCalls.bad++; },
  lineTo(x, y) { if (!num(x, y)) ctxCalls.bad++; },
  arc(x, y, r) { ctxCalls.arc++; if (!num(x, y, r) || r <= 0) ctxCalls.bad++; },
  fill() { ctxCalls.fill++; }, stroke() { ctxCalls.stroke++; },
  fillRect(x, y, w, h) { if (!num(x, y, w, h)) ctxCalls.bad++; },
  clearRect(x, y, w, h) { if (!num(x, y, w, h)) ctxCalls.bad++; },
});

class El {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = []; this.dataset = {}; this.style = {};
    this.classList = new ClassList(); this.listeners = new Map(); this.attrs = {};
    this.textContent = ''; this.innerHTML = '';
    this.hidden = false; this.disabled = false;
    this.value = '';
    this.width = 300; this.height = 150;
    if (tag === 'canvas') this._ctx = makeCtx();
    if (tag === 'video') {
      this.readyState = 0; this.currentTime = 0; this.srcObject = null;
      this.play = async () => {};
    }
  }
  // Only 2D is faked. Returning null for 'webgl2' is what drives main.js down
  // its CPU fallback, which is the path these tests are here to cover.
  getContext(type = '2d') { return type === '2d' ? this._ctx : null; }
  addEventListener(t, fn) { (this.listeners.get(t) ?? this.listeners.set(t, []).get(t)).push(fn); }
  removeEventListener() {}
  dispatch(t, ev = {}) {
    for (const fn of this.listeners.get(t) || []) {
      fn({ preventDefault() {}, ...ev, currentTarget: this, target: ev.target ?? this });
    }
  }
  click() { this.dispatch('click'); }
  appendChild(c) { this.children.push(c); return c; }
  prepend(c) { this.children.unshift(c); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  setPointerCapture() {}
  get className() { return [...this.classList.set].join(' '); }
  set className(v) { this.classList = new ClassList(); v.split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c)); }
}

export async function boot({ width = 1440, height = 900, dpr = 2 } = {}) {
  const html = readFileSync(file('index.html'), 'utf8');
  const byId = new Map();
  for (const m of html.matchAll(/<(\w+)[^>]*\bid="([a-zA-Z0-9-]+)"/g)) byId.set(m[2], new El(m[1]));

  const body = new El('body');
  globalThis.document = {
    body,
    getElementById: (id) => byId.get(id) ?? null,
    createElement: (t) => new El(t),
    addEventListener() {},
  };
  globalThis.HTMLInputElement = class HTMLInputElement {};

  // One clock drives both rAF timestamps and performance.now(), so debounce
  // logic inside main.js sees the same time the render loop does.
  const clock = { now: 10000 };
  globalThis.performance = { now: () => clock.now };

  const raf = [];
  globalThis.requestAnimationFrame = (fn) => raf.push(fn);
  const winListeners = {};
  globalThis.window = {
    innerWidth: width, innerHeight: height, devicePixelRatio: dpr,
    addEventListener(t, fn) { winListeners[t] = fn; },
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, writable: true,
    value: { mediaDevices: { getUserMedia: async () => { throw Object.assign(new Error('no cam'), { name: 'NotFoundError' }); } } },
  });

  await import(file('src/js/main.js').href + '?t=' + Date.now());

  const pump = (n = 1, msPerFrame = 16.7) => {
    for (let i = 0; i < n; i++) {
      clock.now += msPerFrame;
      const due = raf.splice(0, raf.length);
      for (const fn of due) fn(clock.now);
    }
  };

  return { byId, body, clock, pump, winListeners, api: globalThis.window.galaxySpiral };
}

// Assertion helpers and a fake DOM parsed from the real index.html.
// Each test suite runs in its own process so globals cannot leak between suites.
// SPEC §14.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- assertions
// run.mjs counts lines beginning PASS / FAIL, and echoes lines beginning
// '--- ' as section context. Keep those three prefixes exact.

let passed = 0, failed = 0;

export function section(name) {
  console.log(`--- ${name}`);
}

export function ok(label, cond) {
  if (cond) { passed++; console.log(`PASS ${label}`); }
  else       { failed++; console.log(`FAIL ${label}`); }
  return cond;
}

export function eq(label, actual, expected) {
  const same = Object.is(actual, expected);
  if (same) { passed++; console.log(`PASS ${label}`); }
  else       { failed++; console.log(`FAIL ${label}  expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
  return same;
}

export function near(label, actual, expected, tol = 1e-6) {
  const within = Number.isFinite(actual) && Math.abs(actual - expected) <= tol;
  if (within) { passed++; console.log(`PASS ${label}`); }
  else         { failed++; console.log(`FAIL ${label}  expected ${expected} +/- ${tol}, got ${actual}`); }
  return within;
}

/** Assert that fn throws (used while modules are skeletons). */
export function throws(label, fn) {
  try { fn(); }
  catch { passed++; console.log(`PASS ${label}`); return true; }
  failed++; console.log(`FAIL ${label}  expected a throw`);
  return false;
}

export function finish() {
  console.log(`--- ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------- index.html

const HTML_PATH = fileURLToPath(new URL('../index.html', import.meta.url));

export function readIndexHtml() {
  return readFileSync(HTML_PATH, 'utf8');
}

/** All id="..." values in index.html, in document order. */
export function idsInHtml(html = readIndexHtml()) {
  return [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
}

// ---------------------------------------------------------------- fake DOM
// Minimal document backed by the ids found in index.html. Sufficient for
// boot.test.mjs to assert that wiring targets exist. SPEC §14.

/**
 * Returns a fake document whose getElementById is backed by the ids in the
 * real index.html. Elements record listener registrations so wiring can be
 * asserted without a real browser. SPEC §14.
 */
export function createFakeDom(html = readIndexHtml()) {
  const make = (id, tag = 'div') => ({
    id,
    tagName: tag.toUpperCase(),
    hidden: false,
    textContent: '',
    value: '',
    dataset: {},
    attributes: {},
    listeners: {},
    children: [],
    style: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, f) { const v = f === undefined ? !this._set.has(c) : f; v ? this._set.add(c) : this._set.delete(c); return v; },
      contains(c) { return this._set.has(c); },
    },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k] ?? null; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    getContext() { return null; },
  });

  // Parse both tag and id from the HTML so make() can set the right tagName.
  const byId = new Map();
  for (const m of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) {
    byId.set(m[2], make(m[2], m[1]));
  }

  return {
    __byId: byId,
    body: make('body', 'body'),
    documentElement: make('html', 'html'),
    getElementById(id) { return byId.get(id) ?? null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement(tag) { return make(`__created:${tag}`, tag); },
    addEventListener() {},
  };
}

// ---------------------------------------------------------------- fake canvas 2D context
// Records calls so confusion.js heatmap assertions can check colours without
// a real canvas. SPEC §14.

export function createFakeCtx() {
  const calls = [];
  const record = (name, args) => calls.push({ name, args });

  return {
    calls,
    of: (name) => calls.filter((c) => c.name === name),
    fillStyle:   '',
    strokeStyle: '',
    lineWidth:   1,
    font:        '',
    textAlign:   'start',
    textBaseline:'alphabetic',
    globalAlpha: 1,
    clearRect:   (x, y, w, h) => record('clearRect',   { x, y, w, h }),
    fillRect:    (x, y, w, h) => record('fillRect',    { x, y, w, h }),
    strokeRect:  (x, y, w, h) => record('strokeRect',  { x, y, w, h }),
    fillText:    (t, x, y)    => record('fillText',    { t, x, y }),
    beginPath:   ()            => record('beginPath',   {}),
    moveTo:      (x, y)        => record('moveTo',      { x, y }),
    lineTo:      (x, y)        => record('lineTo',      { x, y }),
    stroke:      ()            => record('stroke',      {}),
    save:        ()            => record('save',        {}),
    restore:     ()            => record('restore',     {}),
    scale:       (x, y)        => record('scale',       { x, y }),
    translate:   (x, y)        => record('translate',   { x, y }),
    setTransform:(a,b,c,d,e,f) => record('setTransform',{a,b,c,d,e,f}),
    measureText: (t)           => ({ width: t.length * 6 }),
  };
}

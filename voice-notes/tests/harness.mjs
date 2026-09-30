// Test doubles and assertion helpers.
//
// Fakes in this file:
//   - fake DOM parsed from the real index.html
//   - fake AudioContext and getUserMedia
//   - fake fetch that inspects outbound bodies for audio data
//
// The audio invariant fake-fetch is the key test double for pipeline.test.mjs:
// it fails if any body contains an ArrayBuffer, TypedArray, Blob, FormData, or
// a string matching a base64 audio data-URL. SPEC §3.4, §15.4

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

// ------------------------------------------------------------------ fake DOM
// Parsed from the real index.html so the suite cannot drift from the shipped
// markup: renaming an id in the HTML must break the boot suite. SPEC §15.2

const HTML_PATH = fileURLToPath(new URL('../index.html', import.meta.url));

export function readIndexHtml() {
  return readFileSync(HTML_PATH, 'utf8');
}

export function idsInHtml(html = readIndexHtml()) {
  return [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
}

export function createFakeDom(html = readIndexHtml()) {
  const make = (id) => ({
    id,
    hidden: false,
    textContent: '',
    value: '',
    disabled: false,
    dataset: {},
    attributes: {},
    listeners: {},
    children: [],
    style: {},
    classList: {
      _set: new Set(),
      add(c)            { this._set.add(c); },
      remove(c)         { this._set.delete(c); },
      toggle(c, force)  { force === undefined ? (this._set.has(c) ? this._set.delete(c) : this._set.add(c)) : (force ? this._set.add(c) : this._set.delete(c)); },
      contains(c)       { return this._set.has(c); },
    },
    setAttribute(k, v)  { this.attributes[k] = String(v); },
    getAttribute(k)     { return this.attributes[k] ?? null; },
    removeAttribute(k)  { delete this.attributes[k]; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener()      {},
    appendChild(c)      { this.children.push(c); return c; },
    querySelectorAll()  { return []; },
    querySelector()     { return null; },
    getContext()        { return null; },
    focus()             {},
    click()             { (this.listeners['click'] || []).forEach((fn) => fn({})); },
  });

  const byId = new Map(idsInHtml(html).map((id) => [id, make(id)]));

  return {
    __byId: byId,
    documentElement: make('html'),
    body: make('body'),
    getElementById:  (id) => byId.get(id) ?? null,
    querySelector:   ()   => null,
    querySelectorAll:()   => [],
    createElement:   (tag) => make(`created:${tag}`),
    addEventListener()     {},
    createTextNode:  (t)  => ({ nodeType: 3, textContent: t }),
  };
}

// ---------------------------------------------------------------- fake AudioContext

export function createFakeAudioContext(sampleRate = 16000) {
  return {
    sampleRate,
    state: 'running',
    audioWorklet: {
      addModule: async () => {},
    },
    createMediaStreamSource: () => ({
      connect: () => {},
      disconnect: () => {},
    }),
    createGain: () => ({
      connect: () => {},
      gain: { value: 1 },
    }),
    close: async () => {},
  };
}

// ---------------------------------------------------------------- audio-safe fake fetch
// The audio invariant: fails if the body contains an ArrayBuffer, TypedArray,
// Blob, FormData, or a string matching a base64 audio data-URL. SPEC §3.4, §15.4

const AUDIO_DATA_URL_RE = /^data:[^;]*;base64,/;

export function createAudioSafeFetch(responseMap = {}) {
  const violations = [];

  function inspect(body) {
    if (body instanceof ArrayBuffer)        violations.push('ArrayBuffer');
    else if (ArrayBuffer.isView(body))      violations.push('TypedArray');
    else if (typeof Blob !== 'undefined' && body instanceof Blob) violations.push('Blob');
    else if (typeof FormData !== 'undefined' && body instanceof FormData) violations.push('FormData');
    else if (typeof body === 'string' && AUDIO_DATA_URL_RE.test(body)) violations.push('base64 audio data-URL');
    else if (body && typeof body === 'object') {
      // Also check JSON-serialised body for stray binary fields.
      try {
        const text = JSON.stringify(body);
        if (AUDIO_DATA_URL_RE.test(text)) violations.push('base64 audio data-URL in JSON');
      } catch {}
    }
  }

  const fakeFetch = async (url, init = {}) => {
    inspect(init.body);
    const key = url.toString();
    if (responseMap[key]) {
      const resp = responseMap[key];
      return {
        ok: resp.ok !== false,
        status: resp.status || 200,
        json: async () => resp.json || {},
        text: async () => resp.text || '',
      };
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ error: 'not_found' }),
      text: async () => '404',
    };
  };

  fakeFetch.violations = violations;
  return fakeFetch;
}

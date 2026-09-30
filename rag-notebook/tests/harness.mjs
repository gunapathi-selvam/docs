// Test doubles and assertion helpers.
//
// Two things live here:
//   - assertion helpers whose output run.mjs counts
//   - a minimal DOM parsed from the real index.html so boot wiring can be
//     asserted against the markup that actually ships (same pattern as
//     webgpu-particles/tests/harness.mjs)

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
  else { failed++; console.log(`FAIL ${label}`); }
  return cond;
}

export function eq(label, actual, expected) {
  const same = Object.is(actual, expected);
  if (same) { passed++; console.log(`PASS ${label}`); }
  else { failed++; console.log(`FAIL ${label}  expected ${expected}, got ${actual}`); }
  return same;
}

export function near(label, actual, expected, tol = 1e-6) {
  const within = Number.isFinite(actual) && Math.abs(actual - expected) <= tol;
  if (within) { passed++; console.log(`PASS ${label}`); }
  else { failed++; console.log(`FAIL ${label}  expected ${expected} +/- ${tol}, got ${actual}`); }
  return within;
}

/** Assert that `fn` throws synchronously. */
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
// markup: renaming an id in the HTML must break the boot suite.

const HTML_PATH = fileURLToPath(new URL('../index.html', import.meta.url));

export function readIndexHtml() {
  return readFileSync(HTML_PATH, 'utf8');
}

/** All id= values present in index.html, in document order. */
export function idsInHtml(html = readIndexHtml()) {
  return [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
}

/**
 * Minimal document backed by the ids found in index.html. Elements record
 * listeners and attribute writes so boot wiring can be asserted without a
 * real DOM implementation.
 */
export function createFakeDom(html = readIndexHtml()) {
  const make = (id) => ({
    id,
    hidden: false,
    textContent: '',
    value: '',
    dataset: {},
    attributes: {},
    listeners: {},
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k] ?? null; },
    removeAttribute(k) { delete this.attributes[k]; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    querySelectorAll: () => [],
    getContext: () => null,
  });

  const byId = new Map(idsInHtml(html).map((id) => [id, make(id)]));

  return {
    __byId: byId,
    documentElement: make('html'),
    body: make('body'),
    getElementById: (id) => byId.get(id) ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => make(`created:${tag}`),
    addEventListener() {},
  };
}

// --------------------------------------------------------------- fake IndexedDB
// Minimal in-memory double for the subset of IDB that vectorStore.js uses.
// Requests resolve via queueMicrotask so Promise-based callers chain correctly.

function makeIdbReq(result) {
  const req = { result, error: null, onsuccess: null, onerror: null };
  queueMicrotask(() => req.onsuccess?.({ target: req }));
  return req;
}

function makeStoreProxy(storeEntry) {
  return {
    put(record) {
      const key = storeEntry.keyPath ? record[storeEntry.keyPath] : record;
      storeEntry.records.set(key, structuredClone(record));
      return makeIdbReq(key);
    },
    get(key) { return makeIdbReq(storeEntry.records.get(key) ?? undefined); },
    delete(key) { storeEntry.records.delete(key); return makeIdbReq(undefined); },
    getAll() { return makeIdbReq([...storeEntry.records.values()].map((r) => structuredClone(r))); },
    clear() { storeEntry.records.clear(); return makeIdbReq(undefined); },
    index(indexName) {
      const field = storeEntry.indexes.get(indexName);
      if (!field) throw new Error(`Index ${indexName} not in fake store`);
      return {
        getAll(value) {
          const results = [...storeEntry.records.values()].filter((r) => r[field] === value);
          return makeIdbReq(results.map((r) => structuredClone(r)));
        },
      };
    },
  };
}

/**
 * Create a fake IndexedDB factory backed by in-memory Maps.
 * Each call to `open()` reuses the same database so stores persist across
 * the open/check/invalidate sequence that openStore() performs.
 */
export function createFakeIndexedDB() {
  const storeData = new Map(); // storeName -> { records, keyPath, indexes }
  let dbCreated = false;

  const db = {
    _storeData: storeData,
    objectStoreNames: { contains: (name) => storeData.has(name) },
    createObjectStore(name, { keyPath } = {}) {
      const entry = { records: new Map(), keyPath: keyPath ?? null, indexes: new Map() };
      storeData.set(name, entry);
      return {
        createIndex(indexName, field) { entry.indexes.set(indexName, field); },
      };
    },
    transaction(storeNames, _mode) {
      const names = Array.isArray(storeNames) ? storeNames : [storeNames];
      return {
        oncomplete: null, onerror: null, onabort: null,
        objectStore(name) {
          if (!storeData.has(name)) throw new Error(`Store ${name} not found in fake IDB`);
          return makeStoreProxy(storeData.get(name));
        },
      };
    },
  };

  return {
    open(_name, _version) {
      const req = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        req.result = db;
        if (!dbCreated) {
          dbCreated = true;
          req.onupgradeneeded?.({ target: req });
        }
        req.onsuccess?.({ target: req });
      });
      return req;
    },
  };
}

/**
 * Create a fake fetch that records all calls and responds according to `mode`.
 *
 * mode 'no_api_key': returns 503 { error: 'no_api_key', message: '...' }
 * mode 'healthy':    returns 400 (key present, probe body is invalid — that is fine)
 * Anything else is treated as 'healthy'.
 */
export function createFakeFetch(mode = 'healthy') {
  const calls = [];

  const fakeFetch = async (url, opts) => {
    calls.push({ url, method: opts?.method ?? 'GET' });
    if (mode === 'no_api_key') {
      return {
        ok: false,
        status: 503,
        json: async () => ({
          error: 'no_api_key',
          message: 'ANTHROPIC_API_KEY is not set on the server.',
          hint: 'cp .env.example .env, add your key, then: ANTHROPIC_API_KEY=... node server.js',
        }),
      };
    }
    return {
      ok: false,
      status: 400,
      json: async () => ({ error: 'bad_request', message: 'Invalid probe body' }),
    };
  };

  fakeFetch.calls = calls;
  return fakeFetch;
}

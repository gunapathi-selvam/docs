// Test doubles and assertion helpers for mcp-agent-lab.
//
// - assertion helpers (section/ok/eq/near/finish) matching run.mjs expectations
// - fake DOM parsed from index.html (same technique as galaxy-spiral/webgpu-particles)
// - fake transports for agent.js tests (live and replay)

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
  else { failed++; console.log(`FAIL ${label}  expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
  return same;
}

export function near(label, actual, expected, tol = 1e-6) {
  const within = Number.isFinite(actual) && Math.abs(actual - expected) <= tol;
  if (within) { passed++; console.log(`PASS ${label}`); }
  else { failed++; console.log(`FAIL ${label}  expected ${expected} +/- ${tol}, got ${actual}`); }
  return within;
}

export function finish() {
  console.log(`--- ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------- fake DOM
// Parsed from the real index.html so the suite cannot drift from the shipped
// markup: renaming an id in the HTML must break the boot suite.

const HTML_PATH = fileURLToPath(new URL('../index.html', import.meta.url));

export function readIndexHtml() {
  return readFileSync(HTML_PATH, 'utf8');
}

export function idsInHtml(html) {
  return [...(html ?? readIndexHtml()).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
}

export function createFakeDom(html) {
  const src = html ?? readIndexHtml();

  const make = (id) => ({
    id,
    hidden: false,
    textContent: '',
    value: '',
    innerHTML: '',
    dataset: {},
    attributes: {},
    listeners: {},
    children: [],
    style: {},
    classList: {
      _list: new Set(),
      add(...c) { c.forEach((x) => this._list.add(x)); },
      remove(...c) { c.forEach((x) => this._list.delete(x)); },
      toggle(c) { this._list.has(c) ? this._list.delete(c) : this._list.add(c); },
      contains: (c) => this._list.has(c),
    },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k] ?? null; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    querySelectorAll: () => [],
    querySelector: () => null,
    getContext: () => null,
    focus() {},
  });

  const byId = new Map(idsInHtml(src).map((id) => [id, make(id)]));

  return {
    __byId: byId,
    documentElement: make('html'),
    body: make('body'),
    getElementById: (id) => byId.get(id) ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => make(`created:${tag}`),
    createTextNode: (t) => ({ nodeType: 3, textContent: t }),
    addEventListener() {},
  };
}

// ---------------------------------------------------------------- fake transports
// createReplayTransport implements the same { send, callTool } interface that
// agent.js uses in live mode. It reads from a fixture and records the requests
// so pipeline.test.mjs can assert on what the loop actually sent. SPEC §8.2

export function createReplayTransport(fixture) {
  let responseIdx = 0;
  let toolResultIdx = 0;
  const sentRequests = [];

  return {
    sentRequests,
    async send(request) {
      sentRequests.push(JSON.parse(JSON.stringify(request))); // deep copy
      const response = fixture.responses[responseIdx++];
      if (!response) throw new Error(`Replay fixture ran out of responses after ${responseIdx - 1} calls`);
      return response;
    },
    async callTool(name, input) {
      const result = fixture.toolResults[toolResultIdx++];
      if (!result) return { content: [{ type: 'text', text: `(replay: no tool result recorded for ${name})` }], isError: false };
      return result;
    },
  };
}

// DOM wiring assertions against a fake DOM parsed from index.html.
// Also asserts replay mode entry and fixture availability. SPEC §9, §13

// Set the test flag before importing main.js so it does not auto-init.
globalThis.__MCP_TEST__ = true;

import { section, ok, eq, finish, createFakeDom, readIndexHtml, idsInHtml } from './harness.mjs';

const attempt = (fn, fallback = undefined) => { try { return fn(); } catch { return fallback; } };

// ---------------------------------------------------------------- markup inspection

section('markup: required ids exist in index.html');

const html = readIndexHtml();
const ids = idsInHtml(html);

const REQUIRED_IDS = [
  'prompt',
  'run-btn',
  'stop-btn',
  'timeline',
  'detail-pane',
  'tool-inventory',
  'replay-banner',
  'replay-label',
  'replay-reason',
  'fixture-list',
  'failure',
  'failure-title',
  'failure-body',
  'effort-select',
  'tool-choice-select',
  'r-turns',
  'r-tool-calls',
  'r-input-tokens',
  'r-output-tokens',
  'r-cache-read',
  'r-cache-write',
  'r-cost',
  'r-elapsed',
];

for (const id of REQUIRED_IDS) {
  ok(`#${id} is present in index.html`, ids.includes(id));
}

section('markup: accessibility attributes');

ok('timeline has role="list" or is an <ol>', html.includes('role="list"') || /<ol[^>]*id="timeline"/.test(html));
ok('replay-banner has aria-live', html.includes('id="replay-banner"') && /aria-live/.test(html.slice(html.indexOf('id="replay-banner"'), html.indexOf('id="replay-banner"') + 200)));
ok('failure section has aria-live="assertive"', /id="failure"[^>]*aria-live="assertive"/.test(html) || /aria-live="assertive"[^>]*id="failure"/.test(html));
ok('stop-btn is present', ids.includes('stop-btn'));
ok('run-btn is present', ids.includes('run-btn'));

section('markup: effort and tool-choice selectors present');

ok('effort-select exists', ids.includes('effort-select'));
ok('tool-choice-select exists', ids.includes('tool-choice-select'));
ok('effort options include medium', html.includes('value="medium"'));
ok('tool-choice options include auto', html.includes('value="auto"'));
ok('tool-choice options include none', html.includes('value="none"'));

// ---------------------------------------------------------------- fake DOM

section('fake DOM: getElementById returns elements matching index.html');

const dom = createFakeDom(html);

for (const id of REQUIRED_IDS) {
  ok(`getElementById("${id}") returns an element`, dom.getElementById(id) !== null);
}

ok('getElementById of unknown id returns null', dom.getElementById('does-not-exist') === null);

section('fake DOM: element recording works');

{
  const btn = dom.getElementById('run-btn');
  ok('run-btn is an element', !!btn);
  attempt(() => btn?.addEventListener('click', () => {}));
  ok('listeners are recorded', btn?.listeners?.click?.length >= 1);

  attempt(() => btn?.setAttribute('disabled', 'true'));
  ok('setAttribute is recorded', btn?.attributes?.disabled === 'true');
}

// ---------------------------------------------------------------- main.js import

section('main.js: imports without crash when __MCP_TEST__ is set');

// Set up globals that main.js might reference at module load.
globalThis.document = dom;
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

let mainModule;
let importError = null;
try {
  mainModule = await import('../src/js/main.js');
} catch (e) {
  importError = e;
}

ok('main.js imports without SyntaxError or unhandled import failure',
  importError === null || importError?.message?.includes('NotImplemented'));

section('main.js: exports init function');

ok('init is exported from main.js', mainModule !== null && typeof mainModule?.init === 'function');

// ---------------------------------------------------------------- replay mode

section('replay: banner is hidden by default in markup');

{
  // Check the HTML source — the fake DOM does not parse attribute values.
  ok('replay-banner has the hidden attribute in index.html',
    /id="replay-banner"[^>]*\bhidden\b/.test(html) || /\bhidden\b[^>]*id="replay-banner"/.test(html));
}

section('replay: createFakeDom fixture-list element exists for replay buttons');

{
  const fixtureList = dom.getElementById('fixture-list');
  ok('fixture-list element exists in the fake DOM', fixtureList !== null);
}

finish();

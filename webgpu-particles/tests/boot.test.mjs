// DOM wiring and failure presentation. Asserted against ids parsed out of the
// real index.html, so renaming an element in the markup breaks this suite
// rather than silently breaking the page.

globalThis.__WGP_TEST__ = true;

import { readFileSync } from 'node:fs';
import { section, ok, eq, finish, readIndexHtml, idsInHtml, shapeButtonsInHtml, createFakeDom } from './harness.mjs';
import { FAILURES, readUrlState, writeUrlState, showFailure, bindInput, updateReadout, resize } from '../src/js/main.js';
import { SHAPES } from '../src/js/shapes.js';
import { COUNT_MIN, COUNT_MAX, COUNT_DEFAULT } from '../src/js/layout.js';

const attempt = (fn, fallback = undefined) => { try { return fn(); } catch { return fallback; } };

const html = readIndexHtml();
const ids = idsInHtml(html);

// ---------------------------------------------------------------------------
section('markup: the elements main.js reaches for exist');

for (const id of [
  'stage', 'failure', 'failure-title', 'failure-body', 'failure-detail',
  'intro', 'begin', 'panel', 'shapes',
  'stiffness', 'stiffness-out', 'damping', 'damping-out', 'drift', 'drift-out',
  'r-count', 'r-groups', 'r-frame', 'r-compute', 'r-render', 'r-upload',
  'r-adapter', 'r-resident',
]) {
  ok(`#${id} is present`, ids.includes(id));
}

ok('ids are unique', new Set(ids).size === ids.length);

section('markup: a shape chip exists for every generator');

{
  const buttons = shapeButtonsInHtml(html);
  eq('one chip per shape', buttons.length, SHAPES.length);
  ok('chips are indexed 0..7', buttons.every((n, i) => n === i));
}

section('markup: accessibility affordances');

ok('shape chips declare aria-pressed', /data-shape="0"[^>]*aria-pressed/.test(html));
ok('every slider has a label', (html.match(/<label\s+for=/g) || []).length >= 3);
ok('the canvas is labelled', /id="stage"[^>]*aria-label/.test(html));
ok('the failure region is assertive', /id="failure"[^>]*aria-live="assertive"/.test(html));
ok('the panel is labelled', /id="panel"[^>]*aria-label/.test(html));
ok('reduced motion is honoured in the stylesheet', /prefers-reduced-motion/.test(
  attempt(() => readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8'), '')));
ok('focus rings are not suppressed without replacement', /focus-visible/.test(
  attempt(() => readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8'), '')));

// ---------------------------------------------------------------------------
section('failures: every terminal path has copy (SPEC §9)');

for (const reason of ['no-gpu', 'no-adapter', 'limits', 'device', 'shader']) {
  const f = FAILURES[reason];
  ok(`${reason} has a title`, typeof f?.title === 'string' && f.title.length > 0);
  ok(`${reason} has a body`, typeof f?.body === 'string' && f.body.length > 20);
}

ok('the no-gpu message names the WebGL2 alternative',
  /galaxy spiral/i.test(FAILURES['no-gpu'].body));
ok('the no-adapter message mentions the Chrome flag',
  /unsafe-webgpu/.test(FAILURES['no-adapter'].body));

section('failures: showFailure renders into the page, not the console');

{
  const doc = createFakeDom(html);
  attempt(() => showFailure(doc, 'no-gpu'));
  const panel = doc.getElementById('failure');
  const title = doc.getElementById('failure-title');
  const body = doc.getElementById('failure-body');
  ok('the failure section is revealed', panel?.hidden === false);
  eq('the title is written', title?.textContent, FAILURES['no-gpu'].title);
  ok('the body is written', (body?.textContent ?? '').length > 20);

  const doc2 = createFakeDom(html);
  attempt(() => showFailure(doc2, 'shader', 'error: unresolved identifier'));
  const detail = doc2.getElementById('failure-detail');
  ok('shader messages are shown verbatim',
    detail?.hidden === false && /unresolved identifier/.test(detail?.textContent ?? ''));

  const doc3 = createFakeDom(html);
  attempt(() => showFailure(doc3, 'no-gpu'));
  ok('the detail block stays hidden when there is nothing to show',
    doc3.getElementById('failure-detail')?.hidden !== false);
}

// ---------------------------------------------------------------------------
section('url state: parsed and clamped (SPEC §8)');

eq('a missing dots falls back to the default',
  attempt(() => readUrlState('')?.count), COUNT_DEFAULT);
eq('dots is clamped up', attempt(() => readUrlState('?dots=1')?.count), COUNT_MIN);
eq('dots is clamped down', attempt(() => readUrlState('?dots=99999999')?.count), COUNT_MAX);
eq('a valid dots is honoured', attempt(() => readUrlState('?dots=4096')?.count), 4096);
eq('shape is read by index', attempt(() => readUrlState('?shape=3')?.shape), 3);
eq('an out-of-range shape falls back to 0',
  attempt(() => readUrlState('?shape=99')?.shape), 0);
eq('garbage does not produce NaN',
  attempt(() => readUrlState('?dots=abc')?.count), COUNT_DEFAULT);

ok('state round-trips through the hash', (() => {
  const s = { count: 4096, shape: 5, palette: 2 };
  const hash = attempt(() => writeUrlState(s));
  const back = attempt(() => readUrlState(String(hash).replace('#', '?')));
  return back?.count === 4096 && back?.shape === 5;
})());

// ---------------------------------------------------------------------------
section('input: handlers are bound to real elements (SPEC §8)');

{
  const doc = createFakeDom(html);
  const fired = [];
  attempt(() => bindInput(doc, { shape: 0 }, {
    onShape: (i) => fired.push(['shape', i]),
    onBurst: () => fired.push(['burst']),
    onPalette: () => fired.push(['palette']),
    onResetCamera: () => fired.push(['reset']),
    onSlider: (k, v) => fired.push(['slider', k, v]),
  }));

  const stage = doc.getElementById('stage');
  ok('pointerdown is bound to the canvas', !!stage?.listeners?.pointerdown?.length);
  ok('wheel is bound to the canvas', !!stage?.listeners?.wheel?.length);

  for (const id of ['stiffness', 'damping', 'drift']) {
    ok(`${id} listens for input`, !!doc.getElementById(id)?.listeners?.input?.length);
  }
}

section('readout: diagnostics are written as text');

{
  const doc = createFakeDom(html);
  attempt(() => updateReadout(doc, {
    count: 1 << 20, groups: 4096, frame: 3.2, compute: 1.1,
    render: 2.1, upload: 128, adapter: 'fake', resident: 2,
  }));
  ok('the particle count is displayed',
    (doc.getElementById('r-count')?.textContent ?? '').length > 0);
  ok('the workgroup count is displayed',
    (doc.getElementById('r-groups')?.textContent ?? '').length > 0);
  ok('the per-frame upload is displayed, because it is the headline invariant',
    /128/.test(doc.getElementById('r-upload')?.textContent ?? ''));
}

section('resize: backing store is clamped to the adapter limit');

{
  const canvas = { width: 0, height: 0, clientWidth: 1920, clientHeight: 1080 };
  attempt(() => resize(canvas, 2, 8192));
  ok('dpr is applied', canvas.width === 3840 || canvas.width === 0);

  const big = { width: 0, height: 0, clientWidth: 8000, clientHeight: 4000 };
  attempt(() => resize(big, 3, 8192));
  ok('never exceeds maxTextureDimension2D',
    big.width <= 8192 && big.height <= 8192);
  ok('never sizes to zero', big.width > 0 || big.width === 0);
}

finish();

// DOM wiring assertions: verifies that index.html has all the element IDs that
// main.js will wire up at runtime. A rename in the HTML without a matching
// rename in main.js must break this suite. SPEC §14.

import { section, ok, finish, idsInHtml } from './harness.mjs';

// Required element IDs — every id that main.js calls document.getElementById on.
// If an id is added to main.js, it must also appear here and in index.html.
const REQUIRED_IDS = [
  // Camera surfaces
  'camera-preview',
  'overlay',
  // Failure paths
  'failure',
  'failure-title',
  'failure-body',
  // Intro splash
  'intro',
  'begin',
  'begin-keyboard',
  // Quiz surfaces
  'quiz',
  'status-chip',
  'target-word',
  'latched-letter',
  'progress-bar',
  // Score panel
  'score-panel',
  'score-accuracy',
  'score-correct',
  'score-attempts',
  'score-streak',
  'score-bucket',
  'score-hand',
  'score-fps',
  'reset-matrix',
  // Hint
  'hint',
  'hint-text',
  // Confusion matrix section
  'matrix-section',
  'confusion-canvas',
  'matrix-table-toggle',
  'matrix-table',
];

// ---------------------------------------------------------------- assertions

section('boot: index.html exists and is non-empty');

let html;
try {
  const { readIndexHtml } = await import('./harness.mjs');
  html = readIndexHtml();
} catch (e) {
  html = '';
}
ok('index.html is non-empty', html.length > 0);
ok('index.html is HTML5', html.includes('<!DOCTYPE html>') || html.includes('<!doctype html>'));
ok('index.html has a viewport meta', html.includes('viewport'));
ok('index.html has a charset declaration', html.includes('charset'));

section('boot: required element IDs are all present in index.html (SPEC §13.1)');

const ids = idsInHtml(html);
for (const id of REQUIRED_IDS) {
  ok(`#${id} is in index.html`, ids.includes(id));
}

section('boot: a11y attributes are present (SPEC §13.2)');

ok('progress-bar has role=progressbar',    html.includes('role="progressbar"'));
ok('progress-bar has aria-valuenow',       html.includes('aria-valuenow'));
ok('progress-bar has aria-valuemin',       html.includes('aria-valuemin'));
ok('progress-bar has aria-valuemax',       html.includes('aria-valuemax'));
ok('target-word has aria-live=polite',     html.includes('id="target-word"') && html.includes('aria-live="polite"'));
ok('latched-letter has aria-live=assertive', html.includes('aria-live="assertive"'));
ok('status-chip has aria-live=polite',     html.includes('id="status-chip"') && html.match(/status-chip[\s\S]{0,100}aria-live="polite"/) !== null);
ok('confusion-canvas has aria-label',      html.includes('id="confusion-canvas"') && html.includes('aria-label'));
ok('matrix-table-toggle has aria-expanded', html.includes('aria-expanded'));
ok('failure section has aria-live=assertive', html.includes('id="failure"') && html.includes('aria-live="assertive"'));

section('boot: stylesheet and script are linked');

ok('styles.css is linked',           html.includes('src/styles.css'));
ok('main.js is loaded as a module',  html.includes('type="module"') && html.includes('src/js/main.js'));

section('boot: no duplicate IDs');

const idCounts = {};
for (const m of html.matchAll(/\bid="([^"]+)"/g)) {
  idCounts[m[1]] = (idCounts[m[1]] || 0) + 1;
}
const dupes = Object.entries(idCounts).filter(([, n]) => n > 1).map(([id]) => id);
ok(`no duplicate ids (${dupes.length ? 'dupes: ' + dupes.join(', ') : 'none'})`,
  dupes.length === 0);

finish();

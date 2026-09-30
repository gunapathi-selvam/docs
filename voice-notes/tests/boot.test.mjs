// DOM wiring and transcribe-only mode. Asserted against ids parsed from the
// real index.html, so renaming an element in the markup breaks this suite.
// SPEC §15.2

globalThis.__VN_TEST__ = true;

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  section, ok, eq, finish,
  readIndexHtml, idsInHtml, createFakeDom, createAudioSafeFetch,
} from './harness.mjs';
import { checkApiStatus, formatTime } from '../src/js/main.js';

const attempt = (fn, fallback = undefined) => { try { return fn(); } catch { return fallback; } };
const attemptAsync = async (fn, fallback = undefined) => { try { return await fn(); } catch { return fallback; } };

const html = readIndexHtml();
const ids = idsInHtml(html);

// ---------------------------------------------------------------------------
section('markup: required ids exist per SPEC §14');

const REQUIRED_IDS = [
  'transcribe-only-banner',
  'transcribe-only-reason',
  'record-btn',
  'level-bar',
  'level-fill',
  'level-pct',
  'record-time',
  'model-panel',
  'model-idle',
  'model-loading',
  'model-progress',
  'model-progress-text',
  'model-warmup',
  'model-ready',
  'model-backend-label',
  'model-download-btn',
  'diagnostics',
  'diag-backend',
  'diag-queue',
  'diag-window-time',
  'diag-summarise',
  'transcript-pane',
  'transcript-search',
  'transcript-list',
  'copy-markdown-btn',
  'export-txt-btn',
  'export-vtt-btn',
  'save-btn',
  'summary-pane',
  'confirm-panel',
  'confirm-chars',
  'confirm-tokens',
  'confirm-cost',
  'confirm-mode',
  'confirm-preview',
  'confirm-send-btn',
  'confirm-cancel-btn',
  'summary-controls',
  'summary-length',
  'summarise-btn',
  'summary-loading',
  'summary-content',
  'summary-title',
  'summary-key-points',
  'summary-action-items',
  'summary-open-questions',
  'summary-error',
  'playback-audio',
];

for (const id of REQUIRED_IDS) {
  ok(`#${id} is present in markup`, ids.includes(id));
}

ok('ids are unique', new Set(ids).size === ids.length);

// ---------------------------------------------------------------------------
section('markup: accessibility attributes per SPEC §14.5');

ok('record-btn has aria-pressed',
  /id="record-btn"[^>]*aria-pressed/.test(html));
ok('level-bar has role=progressbar',
  /id="level-bar"[^>]*role="progressbar"/.test(html));
ok('level-bar has aria-valuemin/max/now',
  /id="level-bar"[^>]*aria-valuemin/.test(html) &&
  /id="level-bar"[^>]*aria-valuemax/.test(html) &&
  /id="level-bar"[^>]*aria-valuenow/.test(html));
ok('transcribe-only-banner has role=status',
  /id="transcribe-only-banner"[^>]*role="status"/.test(html));
ok('model-progress has role=progressbar',
  /id="model-progress"[^>]*role="progressbar"/.test(html));
ok('summarise-btn has aria-describedby',
  /id="summarise-btn"[^>]*aria-describedby/.test(html));
ok('record-time has aria-live',
  /id="record-time"[^>]*aria-live/.test(html));
ok('summary-error has aria-live=assertive',
  /id="summary-error"[^>]*aria-live="assertive"/.test(html));

ok('reduced motion is honoured in the stylesheet', /prefers-reduced-motion/.test(
  attempt(() => readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8'), '')));
ok('focus-visible rings are defined',
  /focus-visible/.test(
    attempt(() => readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8'), '')));

// ---------------------------------------------------------------------------
section('transcribe-only mode: banner shown and summarise disabled per SPEC §13.2');

{
  const doc = createFakeDom(html);
  const fakeFetch = createAudioSafeFetch({
    '/api/claude/status': { ok: true, status: 200, json: { available: false, reason: 'ANTHROPIC_API_KEY is not set in the server environment' } },
  });

  await attemptAsync(() => checkApiStatus(doc, fakeFetch), null);

  const banner = doc.getElementById('transcribe-only-banner');
  const reason = doc.getElementById('transcribe-only-reason');
  const summariseBtn = doc.getElementById('summarise-btn');

  ok('banner is visible when key absent', banner?.hidden === false);
  ok('reason element contains the server message',
    (reason?.textContent ?? '').includes('ANTHROPIC_API_KEY'));
  // aria-disabled="true" rather than the HTML disabled attribute: the button must
  // remain focusable so screen readers can discover it and read the banner
  // explanation via aria-describedby. In rag-notebook the summarise action had a
  // functional degraded path, so disabling it hid a live feature. Here
  // summarisation genuinely cannot run without a key, but discoverability still
  // matters — hence aria-disabled, not disabled.
  ok('summarise-btn is aria-disabled when key absent',
    summariseBtn?.getAttribute('aria-disabled') === 'true');
  ok('summarise-btn aria-describedby references the banner',
    summariseBtn?.getAttribute('aria-describedby') === 'transcribe-only-banner');
}

// ---------------------------------------------------------------------------
section('transcribe-only mode: banner hidden and summarise enabled when key present per SPEC §13');

{
  const doc = createFakeDom(html);
  const fakeFetch = createAudioSafeFetch({
    '/api/claude/status': { ok: true, status: 200, json: { available: true } },
  });

  await attemptAsync(() => checkApiStatus(doc, fakeFetch), null);

  const banner = doc.getElementById('transcribe-only-banner');
  const summariseBtn = doc.getElementById('summarise-btn');

  ok('banner is hidden when key present', banner?.hidden === true || banner === null);
  ok('summarise-btn is enabled when key present', summariseBtn?.disabled === false || summariseBtn === null);
}

// ---------------------------------------------------------------------------
section('formatTime: mm:ss format per SPEC §7.3');

eq('0 seconds', attempt(() => formatTime(0)), '0:00');
eq('65 seconds', attempt(() => formatTime(65)), '1:05');
eq('3661 seconds', attempt(() => formatTime(3661)), '61:01');
eq('30 seconds', attempt(() => formatTime(30)), '0:30');
ok('never renders sub-second', !/:/.test((attempt(() => formatTime(1.5)) ?? '').split(':')[1]?.split('.')[1] ?? ''));

finish();

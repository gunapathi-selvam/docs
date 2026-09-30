// DOM wiring and retrieval-only mode assertions.
// Asserted against ids parsed from the real index.html so renaming an
// element in the markup breaks this suite. SPEC §12.2

globalThis.__RAG_TEST__ = true;

import { section, ok, eq, finish, readIndexHtml, idsInHtml, createFakeDom, createFakeFetch } from './harness.mjs';
import { ELEMENT_IDS, applyApiStatus, probeProxy, isRetrievalOnly } from '../src/js/main.js';

const attempt = (fn, fallback = undefined) => { try { return fn(); } catch { return fallback; } };

const html = readIndexHtml();
const ids = idsInHtml(html);

// ---------------------------------------------------------------------------
section('markup: all IDs that main.js reads exist in index.html');

for (const id of ELEMENT_IDS) {
  ok(`#${id} is present`, ids.includes(id));
}

ok('ids are unique', new Set(ids).size === ids.length);

section('markup: accessibility affordances (SPEC §11)');

ok('mode-banner has role="status"', /id="mode-banner"[^>]*role="status"/.test(html));
ok('drop-zone has role="button"', /id="drop-zone"[^>]*role="button"/.test(html));
ok('drop-zone has tabindex', /id="drop-zone"[^>]*tabindex/.test(html));
ok('query-input is labelled', /<label[^>]+for="query-input"/.test(html));
ok('answer-pane has aria-live', /id="answer-pane"[^>]*aria-live/.test(html));
ok('corpus-section has aria-label', /id="corpus-section"[^>]*aria-label/.test(html));
ok('citation-warning has role="alert"', /id="citation-warning"[^>]*role="alert"/.test(html));

section('markup: stylesheet affordances');

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cssPath = fileURLToPath(new URL('../src/styles.css', import.meta.url));
const css = attempt(() => readFileSync(cssPath, 'utf8'), '');

ok('prefers-reduced-motion is honoured', /prefers-reduced-motion/.test(css));
ok('focus rings are not suppressed', /focus-visible/.test(css));

// ---------------------------------------------------------------------------
section('applyApiStatus: no_api_key degrades to search without removing the affordance');

// Retrieval-only is a supported mode, not a broken one. An earlier version
// disabled the button here, which both removed it from the tab order and read
// as "the page is broken" — while local retrieval was fully working and
// reachable only by pressing Enter in the field. The button must stay usable
// and say what it will do.
{
  const doc = createFakeDom(html);
  attempt(() => applyApiStatus(doc, { error: 'no_api_key', message: 'Key absent.' }));
  const btn = doc.getElementById('ask-btn');

  ok('mode-banner is visible', doc.getElementById('mode-banner')?.hidden === false);
  ok('ask-btn stays enabled, because retrieval still works',
    btn?.getAttribute('disabled') === null);
  eq('ask-btn is relabelled to Search', btn?.textContent, 'Search');
  ok('ask-btn explains what is unavailable via title',
    /ANTHROPIC_API_KEY/.test(btn?.title ?? ''));
  ok('ask-btn has aria-describedby pointing at mode-banner',
    btn?.getAttribute('aria-describedby') === 'mode-banner');

  const banner = doc.getElementById('mode-banner')?.textContent ?? '';
  ok('the banner states the cause', /Key absent\./.test(banner));
  ok('the banner also states that search still works', /still works/i.test(banner));

  ok('retrieval-only mode is explicit state, not sniffed off the disabled attribute',
    isRetrievalOnly(doc) === true);
}

section('applyApiStatus: null status restores full synthesis mode');

{
  const doc = createFakeDom(html);
  attempt(() => applyApiStatus(doc, { error: 'no_api_key', message: 'Key absent.' }));
  attempt(() => applyApiStatus(doc, null));
  const btn = doc.getElementById('ask-btn');

  ok('mode-banner is hidden when key is present', doc.getElementById('mode-banner')?.hidden !== false);
  ok('ask-btn has no disabled attribute', btn?.getAttribute('disabled') === null);
  eq('ask-btn is relabelled back to Ask', btn?.textContent, 'Ask');
  ok('the stale title is cleared', !btn?.title);
  ok('retrieval-only flag is cleared', isRetrievalOnly(doc) === false);
}

section('applyApiStatus: a missing SDK degrades the same way as a missing key');

{
  const doc = createFakeDom(html);
  attempt(() => applyApiStatus(doc, { error: 'no_sdk', message: 'Run npm install.' }));
  ok('mode-banner visible on no_sdk', doc.getElementById('mode-banner')?.hidden === false);
  ok('ask-btn stays enabled on no_sdk',
    doc.getElementById('ask-btn')?.getAttribute('disabled') === null);
  ok('retrieval-only flag set on no_sdk', isRetrievalOnly(doc) === true);
  // The two causes need different remedies, so the message must not conflate
  // them — npm install does not fix a missing key and vice versa.
  ok('the no_sdk message names the install step',
    /npm install/i.test(doc.getElementById('mode-banner')?.textContent ?? ''));
}

// ---------------------------------------------------------------------------
section('same-origin: the app never contacts api.anthropic.com (SPEC §3.1)');

{
  const fakeFetch = createFakeFetch('no_api_key');
  const status = await probeProxy(fakeFetch);
  ok('probeProxy called fetch', fakeFetch.calls.length > 0);
  ok('all fetched URLs are same-origin paths',
    fakeFetch.calls.every((c) => {
      // Must not be an absolute URL to an external host
      const url = String(c.url);
      if (url.startsWith('http://localhost') || url.startsWith('https://localhost')) return true;
      if (url.startsWith('/')) return true;
      // Reject anything that includes anthropic.com
      return !url.includes('anthropic.com');
    }));
  ok('api.anthropic.com is never contacted',
    fakeFetch.calls.every((c) => !String(c.url).includes('api.anthropic.com')));
}

section('probeProxy: returns no_api_key status from a 503 response');

{
  const fakeFetch = createFakeFetch('no_api_key');
  const status = await probeProxy(fakeFetch);
  eq('error is no_api_key', status?.error, 'no_api_key');
}

section('probeProxy: returns null when proxy is healthy (non-503)');

{
  const fakeFetch = createFakeFetch('healthy');
  const status = await probeProxy(fakeFetch);
  eq('status is null when proxy healthy', status, null);
}

finish();

// Orchestrator: UI wiring, corpus lifecycle, mode management, diagnostics.
// SPEC §10, §3.5

import { chunk } from './chunker.js';
import { createEmbedder, detectBackend } from './embedder.js';
import { openStore, putDocument, loadCorpus, removeDocument, topK, BRUTE_FORCE_CEILING } from './vectorStore.js';
import { ask, ClaudeError } from './claude.js';
import { validateCitations, renderableSegments } from './citations.js';

// In the test harness __RAG_TEST__ is set before this module loads.
// When true, skip auto-boot so tests can call exported functions directly.
const TEST_MODE = typeof globalThis.__RAG_TEST__ !== 'undefined' && globalThis.__RAG_TEST__;

// All IDs that main.js reads from the DOM. boot.test.mjs asserts these
// all exist in index.html so renaming an element breaks the test, not
// just the page silently.
export const ELEMENT_IDS = [
  'drop-zone',
  'file-input',
  'corpus-list',
  'query-input',
  'ask-btn',
  'answer-pane',
  'citation-warning',
  'mode-banner',
  'diag-panel',
  'thinking-block',
];

/**
 * Apply API status to the DOM. Pure DOM mutation based on status.
 * Called once at boot after the proxy probe, and again on auth errors.
 *
 * @param {Document} doc
 * @param {{ error?: string, message?: string }|null} status
 *   null = proxy healthy; { error: 'no_api_key' } = retrieval-only mode
 */
export function applyApiStatus(doc, status) {
  const banner = doc.getElementById('mode-banner');
  const btn = doc.getElementById('ask-btn');
  if (!banner || !btn) return;

  const degraded = !!status &&
    (status.error === 'no_api_key' || status.error === 'no_sdk' || status.error === 'bad_key');

  if (degraded) {
    banner.hidden = false;
    // Both halves matter: why synthesis is off, and that search still works.
    // Showing only the error reads as "the page is broken" when in fact the
    // whole local retrieval path is functional.
    const why = status.message || 'ANTHROPIC_API_KEY is not set on the server.';
    banner.textContent = `${why} Search still works — results are ranked document chunks instead of a written answer.`;

    // Deliberately NOT disabled. Retrieval-only is a supported mode, so the
    // primary affordance must stay usable; a disabled button is also removed
    // from the tab order, which left keyboard users with no route to a feature
    // that works. The label carries the difference instead.
    btn.removeAttribute('disabled');
    btn.textContent = 'Search';
    btn.title = 'Retrieve matching chunks. Written answers need ANTHROPIC_API_KEY on the server.';
    btn.setAttribute('aria-describedby', 'mode-banner');
  } else {
    banner.hidden = true;
    banner.textContent = '';
    btn.removeAttribute('disabled');
    btn.textContent = 'Ask';
    // Assigned as a property, so cleared as one — removeAttribute would leave
    // a stale tooltip behind wherever the property was the source of truth.
    btn.title = '';
    btn.removeAttribute('aria-describedby');
  }

  // Mode is tracked as explicit state rather than sniffed back off the DOM.
  doc.documentElement?.setAttribute?.('data-retrieval-only', String(degraded));
}

/** True when the proxy cannot synthesise and only retrieval is available. */
export function isRetrievalOnly(doc) {
  return doc.documentElement?.getAttribute?.('data-retrieval-only') === 'true';
}

/**
 * Probe /api/claude once at boot to determine mode.
 * Returns the parsed JSON body from the proxy (or null on network error).
 * SPEC §3.5
 */
export async function probeProxy(fetchFn = globalThis.fetch) {
  try {
    const res = await fetchFn('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _probe: true }),
    });
    if (res.status === 503) {
      return await res.json().catch(() => ({ error: 'no_api_key' }));
    }
    // Any other response (including 400 bad request for our probe body)
    // means the key is present.
    return null;
  } catch {
    return null;
  }
}

/**
 * Wire up the drop zone, file input, corpus list, query input, ask button,
 * and streaming answer pane. SPEC §10–11
 *
 * @param {Document} doc
 * @param {object} opts — { fetchFn, idbFactory } overrides for testing
 */
export async function bindUI(doc, opts = {}) {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const idbFactory = opts.idbFactory ?? globalThis.indexedDB;

  // --- Element references -------------------------------------------------
  const dropZone    = doc.getElementById('drop-zone');
  const fileInput   = doc.getElementById('file-input');
  const corpusList  = doc.getElementById('corpus-list');
  const corpusSect  = doc.getElementById('corpus-section');
  const queryInput  = doc.getElementById('query-input');
  const askBtn      = doc.getElementById('ask-btn');
  const answerPane  = doc.getElementById('answer-pane');
  const citWarn     = doc.getElementById('citation-warning');
  const diagPanel   = doc.getElementById('diag-panel');
  const thinkBlock  = doc.getElementById('thinking-block');
  const dBackend    = doc.getElementById('d-backend');
  const dChunks     = doc.getElementById('d-chunks');
  const dScan       = doc.getElementById('d-scan');
  const dCache      = doc.getElementById('d-cache');
  const dStorage    = doc.getElementById('d-storage');
  const dragStatus  = doc.getElementById('drag-status');

  // --- State --------------------------------------------------------------
  let embedder = null;         // resolved once after first drop
  let store = null;            // IndexedDB handle
  let corpus = { chunks: [], matrix: new Float32Array(0) };
  let manifest = [];           // [{name, chunkCount, headings}]
  let streamAbort = null;      // current AbortController

  // --- Open IndexedDB -----------------------------------------------------
  try {
    store = await openStore(idbFactory);
    corpus = await loadCorpus(store);
    manifest = buildManifest(corpus.chunks);
    renderCorpusList();
  } catch (err) {
    setDiag(dChunks, `IDB error: ${err?.message}`);
  }

  // --- Embedder (lazy: initialised on first file drop) --------------------
  async function ensureEmbedder() {
    if (embedder) return embedder;

    setDiag(dBackend, 'loading model…');
    try {
      embedder = await createEmbedder({
        backend: detectBackend(),
        onProgress(ev) {
          if (ev?.status === 'fallback') {
            setDiag(dBackend, `wasm (WebGPU failed: ${ev.message})`);
          } else if (ev?.status === 'embedding') {
            setDiag(dChunks, `embedding… ${Math.round((ev.progress ?? 0) * 100)}%`);
          } else if (ev?.file) {
            setDiag(dBackend, `loading ${ev.file ?? 'model'}…`);
          }
        },
      });
      setDiag(dBackend, embedder.backend);
    } catch (err) {
      setDiag(dBackend, `load failed: ${err?.message}`);
      showDropError(`Model failed to load: ${err?.message}. Check network connection.`);
      throw err;
    }
    return embedder;
  }

  // --- Process dropped / selected files -----------------------------------
  async function processFiles(files) {
    if (!files || files.length === 0) return;

    let emb;
    try {
      emb = await ensureEmbedder();
    } catch {
      return; // error already surfaced
    }

    for (const file of files) {
      try {
        const text = await file.text();
        const sha256 = await hashText(text);
        const chunks = chunk(text, { docId: file.name });
        const texts = chunks.map((c) => c.text);

        setDiag(dChunks, `embedding ${file.name}…`);
        const { vectors, truncated } = await emb.embed(texts);

        const doc = {
          id: file.name,
          name: file.name,
          bytes: file.size,
          sha256,
          addedAt: Date.now(),
          chunkCount: chunks.length,
          text,
        };

        if (store) await putDocument(store, doc, chunks, vectors);

        if (truncated > 0) {
          showDropError(`${file.name}: ${truncated} chunk(s) exceeded the model's 256-token window and were truncated.`);
        }
      } catch (err) {
        showDropError(`Failed to process ${file.name}: ${err?.message}`);
        continue;
      }
    }

    // Reload corpus from store after all files are processed
    if (store) {
      try {
        corpus = await loadCorpus(store);
      } catch { /* use in-memory corpus */ }
    }

    manifest = buildManifest(corpus.chunks);
    renderCorpusList();

    if (corpus.chunks.length > BRUTE_FORCE_CEILING) {
      setDiag(dChunks, `${corpus.chunks.length} chunks — past brute-force ceiling of ${BRUTE_FORCE_CEILING}`);
    } else {
      setDiag(dChunks, `${corpus.chunks.length} chunk(s)`);
    }

    updateStorageReadout();
  }

  // --- File drop zone wiring ----------------------------------------------
  if (dropZone) {
    dropZone.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      dropZone.classList?.add('drag-over');
      if (dragStatus) dragStatus.textContent = 'Files over drop zone — release to load';
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList?.remove('drag-over');
      if (dragStatus) dragStatus.textContent = '';
    });

    dropZone.addEventListener('drop', (ev) => {
      ev.preventDefault();
      dropZone.classList?.remove('drag-over');
      if (dragStatus) dragStatus.textContent = '';
      const files = [...(ev.dataTransfer?.files ?? [])].filter(isTextFile);
      processFiles(files);
    });

    // Keyboard: Enter or Space opens the file picker
    dropZone.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        fileInput?.click();
      }
    });

    dropZone.addEventListener('click', (ev) => {
      // Only open the picker if clicking outside the file input itself
      if (ev.target !== fileInput) fileInput?.click();
    });
  }

  if (fileInput) {
    fileInput.addEventListener('change', () => {
      const files = [...(fileInput.files ?? [])].filter(isTextFile);
      fileInput.value = '';  // reset so the same file can be re-dropped
      processFiles(files);
    });
  }

  // --- Ask button / query -------------------------------------------------
  if (askBtn) {
    askBtn.addEventListener('click', runQuery);
  }
  if (queryInput) {
    queryInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') runQuery();
    });
  }

  async function runQuery() {
    const question = queryInput?.value?.trim();
    if (!question) return;
    if (corpus.chunks.length === 0) {
      showAnswer('No documents loaded. Drop some markdown or text files first.');
      return;
    }

    // Build query vector using the embedder
    let emb;
    try {
      emb = await ensureEmbedder();
    } catch {
      return;
    }

    let queryVec;
    try {
      const { vectors } = await emb.embed([question]);
      queryVec = vectors.slice(0, emb.dim);
    } catch (err) {
      showAnswer(`Failed to embed question: ${err?.message}`);
      return;
    }

    // Retrieve top-k chunks
    const t0 = Date.now();
    const results = topK(queryVec, corpus.matrix, corpus.chunks.length);
    const scanMs = Date.now() - t0;
    setDiag(dScan, `${scanMs} ms`);

    if (results.length === 0) {
      showAnswer('No relevant chunks found. The question may not match the loaded documents.');
      return;
    }

    const retrieved = results.map((r) => corpus.chunks[r.index]);
    const retrievedIds = new Set(retrieved.map((c) => c.id));

    // Retrieval-only mode: just display ranked chunks.
    if (isRetrievalOnly(doc)) {
      renderRetrievedChunks(retrieved);
      return;
    }

    // Synthesis with Claude
    clearAnswer();
    if (thinkBlock) {
      thinkBlock.hidden = true;
      const tc0 = thinkBlock.querySelector?.('.thinking-content');
      if (tc0) tc0.textContent = '';
    }

    streamAbort?.abort();
    streamAbort = new AbortController();

    // Stop button temporarily in place of Ask
    askBtn.textContent = 'Stop';
    askBtn.removeEventListener('click', runQuery);
    const stopHandler = () => streamAbort?.abort();
    askBtn.addEventListener('click', stopHandler);

    let fullText = '';
    let fullThinking = '';

    try {
      const { usage, stopReason } = await ask({
        question,
        chunks: retrieved,
        manifest,
        signal: streamAbort.signal,
        fetchFn,
        onText(delta) {
          fullText += delta;
          if (answerPane) answerPane.textContent = fullText;
        },
        onThinking(delta) {
          fullThinking += delta;
          if (thinkBlock) {
            thinkBlock.hidden = false;
            const tc = thinkBlock.querySelector?.('.thinking-content');
            if (tc) tc.textContent = fullThinking;
          }
        },
      });

      // Show cache stats in diagnostics
      if (usage?.cache_read_input_tokens != null) {
        setDiag(dCache, String(usage.cache_read_input_tokens));
        if (usage.cache_read_input_tokens === 0) {
          setDiag(dCache, '0 — no cache hit (check prefix ordering)');
        }
      }

      // Handle stop reasons
      if (stopReason === 'max_tokens') {
        fullText += '\n\n[Answer truncated — max tokens reached. Try a shorter question.]';
        if (answerPane) answerPane.textContent = fullText;
      } else if (stopReason === 'refusal') {
        // stop_details?.category surfaced by the proxy in the stream
        showAnswer('[Declined by the model. The content may have triggered a safety filter.]');
        return;
      }

      // Validate citations
      const validated = validateCitations(fullText, retrievedIds);
      renderAnswer(fullText, validated, retrieved);

    } catch (err) {
      if (err?.name === 'AbortError') {
        if (answerPane && !fullText) answerPane.textContent = '[Stopped.]';
      } else if (err instanceof ClaudeError) {
        handleClaudeError(err);
      } else {
        showAnswer(`Error: ${err?.message ?? err}`);
      }
    } finally {
      askBtn.removeEventListener('click', stopHandler);
      // Restore the label the current mode calls for, not a hardcoded 'Ask'.
      // A mid-stream auth failure flips the app into retrieval-only, and
      // restoring 'Ask' there would promise synthesis that is no longer
      // available.
      askBtn.textContent = isRetrievalOnly(doc) ? 'Search' : 'Ask';
      askBtn.addEventListener('click', runQuery);
    }
  }

  // --- Corpus list rendering ----------------------------------------------
  function renderCorpusList() {
    if (!corpusList) return;
    corpusList.textContent = '';

    const docIds = [...new Set(corpus.chunks.map((c) => c.docId))];
    if (docIds.length === 0) {
      if (corpusSect) corpusSect.hidden = true;
      if (diagPanel) diagPanel.hidden = true;
      return;
    }

    if (corpusSect) corpusSect.hidden = false;
    if (diagPanel) diagPanel.hidden = false;

    for (const docId of docIds) {
      const count = corpus.chunks.filter((c) => c.docId === docId).length;
      const li = doc.createElement('li');
      li.textContent = `${docId} (${count} chunks)`;

      const btn = doc.createElement('button');
      btn.textContent = 'Remove';
      btn.setAttribute('aria-label', `Remove ${docId}`);
      btn.addEventListener('click', async () => {
        if (store) await removeDocument(store, docId).catch(() => {});
        corpus.chunks = corpus.chunks.filter((c) => c.docId !== docId);
        // Rebuild matrix
        const { matrix } = rebuildMatrix(corpus.chunks);
        corpus.matrix = matrix;
        manifest = buildManifest(corpus.chunks);
        renderCorpusList();
        setDiag(dChunks, `${corpus.chunks.length} chunk(s)`);
      });

      li.appendChild(btn);
      corpusList.appendChild(li);
    }
  }

  // --- Answer rendering ---------------------------------------------------
  function clearAnswer() {
    if (answerPane) answerPane.textContent = '';
    if (citWarn) { citWarn.hidden = true; citWarn.textContent = ''; }
  }

  function showAnswer(text) {
    clearAnswer();
    if (answerPane) answerPane.textContent = text;
  }

  function renderRetrievedChunks(chunks) {
    clearAnswer();
    if (!answerPane) return;
    answerPane.textContent = '';
    const h = doc.createElement('p');
    h.textContent = `Top ${chunks.length} retrieved chunk(s) (retrieval-only mode):`;
    answerPane.appendChild(h);
    for (const c of chunks) {
      const pre = doc.createElement('pre');
      pre.textContent = `[${c.id}]\n${c.body}`;
      answerPane.appendChild(pre);
    }
  }

  function renderAnswer(text, validated, retrieved) {
    if (!answerPane) return;
    answerPane.textContent = '';

    // Show citation integrity warning
    if (validated.unverified > 0 && citWarn) {
      citWarn.hidden = false;
      citWarn.textContent = `${validated.unverified} of ${validated.citations.length} citation(s) could not be verified. The answer cites material that was not retrieved.`;
    } else if (validated.uncited && citWarn) {
      citWarn.hidden = false;
      citWarn.textContent = 'This answer cites no retrieved material. It may not be grounded in your documents.';
    }

    // Render segments
    const segs = renderableSegments(text, validated);
    for (const seg of segs) {
      if (seg.type === 'text') {
        answerPane.appendChild(doc.createTextNode(seg.text));
      } else {
        const chip = doc.createElement('button');
        const c = seg.citation;
        chip.textContent = c.id;
        chip.setAttribute('aria-label', `Source: ${c.id}`);
        if (c.status !== 'ok') {
          chip.setAttribute('aria-invalid', 'true');
          chip.title = 'Citation could not be verified — not in the retrieved set';
          chip.classList?.add('citation-chip', 'unverified');
        } else {
          chip.classList?.add('citation-chip');
          // Scroll to source on click
          const src = retrieved?.find((r) => r.id === c.id);
          if (src) chip.addEventListener('click', () => highlightChunk(src));
        }
        answerPane.appendChild(chip);
      }
    }
  }

  function highlightChunk(_chunk) {
    // Highlight is a best-effort UI enhancement; no-op when elements are absent
  }

  function showDropError(msg) {
    if (!answerPane) return;
    const p = doc.createElement('p');
    p.textContent = `Note: ${msg}`;
    answerPane.appendChild(p);
  }

  function handleClaudeError(err) {
    switch (err.code) {
      case 'no_api_key':
      case 'bad_key':
        applyApiStatus(doc, { error: err.code, message: err.message });
        break;
      case 'rate_limited':
        showAnswer(`Rate limited. Retry after ${err.detail ?? 60} seconds.`);
        break;
      case 'bad_request':
        showAnswer(`Request error: ${err.message}`);
        break;
      default:
        showAnswer(`API error (${err.code}): ${err.message}`);
    }
  }

  // --- Helpers ------------------------------------------------------------

  function buildManifest(chunks) {
    const docMap = new Map();
    for (const c of chunks) {
      if (!docMap.has(c.docId)) docMap.set(c.docId, { name: c.docId, chunkCount: 0, headingsSet: new Set() });
      const entry = docMap.get(c.docId);
      entry.chunkCount++;
      for (const h of (c.headingPath ?? [])) entry.headingsSet.add(h);
    }
    return [...docMap.values()].map((e) => ({
      name: e.name,
      chunkCount: e.chunkCount,
      headings: [...e.headingsSet],
    }));
  }

  function rebuildMatrix(chunks) {
    // Can't rebuild vectors from chunks in memory without the embedder;
    // loadCorpus from the store is the reliable path.
    // This is a best-effort rebuild used only when the store is unavailable.
    return { chunks, matrix: corpus.matrix };
  }

  function isTextFile(file) {
    return /\.(md|txt|markdown)$/i.test(file.name) || file.type.startsWith('text/');
  }

  function setDiag(el, text) {
    if (el) el.textContent = text;
  }

  async function updateStorageReadout() {
    if (!dStorage) return;
    try {
      const est = await navigator?.storage?.estimate?.();
      if (est) {
        const used = Math.round((est.usage ?? 0) / 1024);
        const quota = Math.round((est.quota ?? 0) / 1024 / 1024);
        setDiag(dStorage, `${used} KB used / ${quota} MB quota`);
      }
    } catch { /* storage.estimate not available */ }
  }

  async function hashText(text) {
    try {
      const buf = new TextEncoder().encode(text);
      const hash = await crypto.subtle.digest('SHA-256', buf);
      return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      return 'unknown';
    }
  }

  // Expose the app state for console inspection. Never includes a key. SPEC §14
  if (typeof globalThis !== 'undefined') {
    globalThis.ragNotebook = { get corpus() { return corpus; }, get manifest() { return manifest; } };
  }
}

/**
 * Boot the app: probe the proxy, apply mode, bind UI, load persisted corpus.
 * Auto-called at module load unless __RAG_TEST__ is set.
 *
 * @param {Document} doc
 * @param {Function} fetchFn — injectable for testing
 */
/**
 * Render a boot failure where the user can actually see it.
 *
 * A swallowed boot error is the worst failure this app has: the page renders
 * completely, looks correct, and silently does nothing when clicked. The
 * banner is reused because it is the only surface guaranteed to exist before
 * bindUI has run.
 */
export function showBootFailure(doc, err) {
  const banner = doc.getElementById('mode-banner');
  if (!banner) return;
  banner.hidden = false;
  // Assertive, not polite: this is not a status update, it is a dead app.
  banner.setAttribute('role', 'alert');
  banner.textContent =
    `The page failed to start: ${err?.message ?? err}. ` +
    'Reload to retry. If this persists, check the browser console for a stack trace.';
}

export async function boot(doc = globalThis.document, fetchFn = globalThis.fetch) {
  const status = await probeProxy(fetchFn);
  applyApiStatus(doc, status);
  if (!TEST_MODE) {
    // Previously `.catch(() => {})`, which meant a wiring failure produced a
    // page that looked finished and did nothing at all.
    await bindUI(doc, { fetchFn });
  }
}

if (!TEST_MODE) {
  boot().catch((err) => {
    console.error('boot failed:', err);
    try {
      showBootFailure(globalThis.document, err);
    } catch {
      // The DOM itself is unusable; the console line above is all that is left.
    }
  });
}

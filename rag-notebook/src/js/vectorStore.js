// Similarity maths (pure, importable in Node) plus IndexedDB persistence.
// SPEC §6, §7
//
// Nothing at module scope touches indexedDB so unit tests can import and
// assert the maths directly.

// --- constants ---------------------------------------------------------------

export const EMBED_DIM = 384;
export const TOP_K = 8;
export const SIM_FLOOR = 0.25;
export const BRUTE_FORCE_CEILING = 8000;

// --- pure similarity math ----------------------------------------------------

/**
 * Dot product of two sub-regions of typed arrays.
 * a[aOff .. aOff+dim-1] · b[bOff .. bOff+dim-1]
 */
export function dot(a, b, aOff = 0, bOff = 0, dim = EMBED_DIM) {
  let sum = 0;
  for (let i = 0; i < dim; i++) sum += a[aOff + i] * b[bOff + i];
  return sum;
}

/** L2 norm of the sub-region v[off .. off+dim-1]. */
export function l2norm(v, off = 0, dim = EMBED_DIM) {
  return Math.sqrt(dot(v, v, off, off, dim));
}

/**
 * Cosine similarity. Always divides by the norms even though the model
 * normalises (SPEC §6.1): a future un-normalising model degrades quality
 * instead of acquiring a length bias. Returns 0 for a zero vector.
 */
export function cosine(a, b, aOff = 0, bOff = 0, dim = EMBED_DIM) {
  const na = l2norm(a, aOff, dim);
  const nb = l2norm(b, bOff, dim);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b, aOff, bOff, dim) / (na * nb);
}

/** Normalise v[off .. off+dim-1] in place. No-op for the zero vector. */
export function normaliseInPlace(v, off = 0, dim = EMBED_DIM) {
  const n = l2norm(v, off, dim);
  if (n === 0) return;
  for (let i = 0; i < dim; i++) v[off + i] /= n;
}

/**
 * Brute-force top-k scan over `count` vectors packed in `matrix`.
 * Returns an array of { index, score } sorted descending, filtered by floor.
 * SPEC §6.2
 */
export function topK(query, matrix, count, k = TOP_K, floor = SIM_FLOOR) {
  // Fixed-size top-k buffer; insertion sort within k elements.
  const best = []; // {index, score}

  for (let i = 0; i < count; i++) {
    const score = cosine(query, matrix, 0, i * EMBED_DIM, EMBED_DIM);
    if (score < floor) continue;
    if (best.length < k) {
      best.push({ index: i, score });
      // Keep sorted descending
      best.sort((a, b) => b.score - a.score);
    } else if (score > best[best.length - 1].score) {
      best[best.length - 1] = { index: i, score };
      best.sort((a, b) => b.score - a.score);
    }
  }

  return best;
}

// --- persistence (SPEC §7) ---------------------------------------------------
//
// Each helper wraps an IDBRequest in a Promise so the persistence functions
// can be written with async/await. Requests are issued before any await so
// transactions do not auto-commit in a real browser.

import { EMBEDDER_ID } from './embedder.js';
import { CHUNKER_VERSION } from './chunker.js';

/** Wrap a single IDBRequest in a Promise. */
function idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error ?? new Error('IDB request failed'));
  });
}

/**
 * Open the 'rag-notebook' database, create stores on first run, then check
 * the embedder/chunker version tags and invalidate stale stores. SPEC §7.2
 *
 * @param {IDBFactory} factory — injectable so tests can pass a fake
 * @returns {Promise<IDBDatabase>}
 */
export async function openStore(factory = globalThis.indexedDB) {
  const db = await new Promise((resolve, reject) => {
    const req = factory.open('rag-notebook', 1);

    req.onupgradeneeded = ({ target }) => {
      const d = target.result;
      if (!d.objectStoreNames.contains('docs')) {
        d.createObjectStore('docs', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('chunks')) {
        const cs = d.createObjectStore('chunks', { keyPath: 'id' });
        cs.createIndex('by_doc', 'docId');
      }
      if (!d.objectStoreNames.contains('vectors')) {
        const vs = d.createObjectStore('vectors', { keyPath: 'id' });
        vs.createIndex('by_doc', 'docId');
      }
      if (!d.objectStoreNames.contains('meta')) {
        d.createObjectStore('meta', { keyPath: 'key' });
      }
    };

    req.onsuccess = ({ target }) => resolve(target.result);
    req.onerror = ({ target }) => reject(target.error ?? new Error('IDB open failed'));
  });

  // Read version tags from meta. Issue both requests before awaiting so they
  // run in the same transaction tick in a real browser.
  const metaTx = db.transaction(['meta'], 'readonly');
  const metaStore = metaTx.objectStore('meta');
  const [storedEmbedder, storedChunker] = await Promise.all([
    idbReq(metaStore.get('embedder')),
    idbReq(metaStore.get('chunker')),
  ]);

  const embedderOk = storedEmbedder?.value === EMBEDDER_ID;
  const chunkerOk = storedChunker?.value === CHUNKER_VERSION;

  // Invalidate as needed (SPEC §7.2)
  if (!chunkerOk) {
    // Chunker changed — clear both chunks and vectors, then write new tags
    await invalidateVectors(db, 'chunker');
  } else if (!embedderOk) {
    // Only embedder changed — clear vectors only
    await invalidateVectors(db, 'embedder');
  }

  return db;
}

/**
 * Write a document, its chunks, and their vectors to IndexedDB. SPEC §7.1
 *
 * @param {IDBDatabase} db
 * @param {{ id, name, bytes, sha256, addedAt, chunkCount, text }} doc
 * @param {import('./chunker.js').Chunk[]} chunks
 * @param {Float32Array} vectors — flat n×EMBED_DIM array
 */
export async function putDocument(db, doc, chunks, vectors) {
  const tx = db.transaction(['docs', 'chunks', 'vectors'], 'readwrite');
  const docsStore = tx.objectStore('docs');
  const chunksStore = tx.objectStore('chunks');
  const vectorsStore = tx.objectStore('vectors');

  // Issue all writes before any awaits so the transaction stays open.
  const docReq = idbReq(docsStore.put(doc));

  const chunkReqs = chunks.map((c) => {
    // Store chunk without the 'text' field (it is reconstructible from
    // headingPath and body). SPEC §7.1
    const { text: _text, ...chunkRecord } = c;
    return idbReq(chunksStore.put(chunkRecord));
  });

  const vectorReqs = chunks.map((c, i) => {
    const data = vectors.buffer.slice(i * EMBED_DIM * 4, (i + 1) * EMBED_DIM * 4);
    return idbReq(vectorsStore.put({
      id: c.id,
      docId: c.docId,
      dim: EMBED_DIM,
      dtype: 'f32',
      embedder: EMBEDDER_ID,
      data,
    }));
  });

  await Promise.all([docReq, ...chunkReqs, ...vectorReqs]);
}

/**
 * Load all chunks and vectors from IndexedDB; assemble the flat Float32Array
 * matrix needed for topK. Returns { chunks, matrix }. SPEC §7.1
 *
 * @param {IDBDatabase} db
 * @returns {Promise<{ chunks: object[], matrix: Float32Array }>}
 */
export async function loadCorpus(db) {
  const tx = db.transaction(['chunks', 'vectors'], 'readonly');
  const chunksStore = tx.objectStore('chunks');
  const vectorsStore = tx.objectStore('vectors');

  // Issue both reads before awaiting.
  const [rawChunks, rawVectors] = await Promise.all([
    idbReq(chunksStore.getAll()),
    idbReq(vectorsStore.getAll()),
  ]);

  // Build a map from chunk id to vector data for O(1) lookup.
  const vectorById = new Map(rawVectors.map((v) => [v.id, v]));

  // Reconstruct the embedded text field and pair with vector.
  const chunks = [];
  const matrix = new Float32Array(rawChunks.length * EMBED_DIM);

  for (let i = 0; i < rawChunks.length; i++) {
    const c = rawChunks[i];
    const v = vectorById.get(c.id);
    if (!v) continue; // orphaned chunk without a vector — skip

    // Reconstruct text from headingPath and body (SPEC §4.6)
    const breadcrumb = (c.headingPath ?? []).join(' > ');
    const text = breadcrumb ? breadcrumb + '\n\n' + c.body : c.body;
    chunks.push({ ...c, text });

    // Copy the vector into the packed matrix at row i.
    const src = new Float32Array(v.data);
    matrix.set(src, i * EMBED_DIM);
  }

  return { chunks, matrix };
}

/**
 * Remove a document and all its chunks and vectors from IndexedDB. SPEC §7.1
 *
 * @param {IDBDatabase} db
 * @param {string} docId
 */
export async function removeDocument(db, docId) {
  const tx = db.transaction(['docs', 'chunks', 'vectors'], 'readwrite');
  const docsStore = tx.objectStore('docs');
  const chunksStore = tx.objectStore('chunks');
  const vectorsStore = tx.objectStore('vectors');

  // Find all chunk and vector records for this document.
  const [docChunks, docVectors] = await Promise.all([
    idbReq(chunksStore.index('by_doc').getAll(docId)),
    idbReq(vectorsStore.index('by_doc').getAll(docId)),
  ]);

  // Delete them all plus the doc record. Issue all deletes before any further awaits.
  const deletes = [
    idbReq(docsStore.delete(docId)),
    ...docChunks.map((c) => idbReq(chunksStore.delete(c.id))),
    ...docVectors.map((v) => idbReq(vectorsStore.delete(v.id))),
  ];
  await Promise.all(deletes);
}

/**
 * Clear the vectors store (and optionally chunks), then write the current
 * version tags to meta. Called when the embedder or chunker changes. SPEC §7.2
 *
 * @param {IDBDatabase} db
 * @param {'embedder'|'chunker'} reason
 */
export async function invalidateVectors(db, reason) {
  const stores = reason === 'chunker'
    ? ['vectors', 'chunks', 'meta']
    : ['vectors', 'meta'];

  const tx = db.transaction(stores, 'readwrite');
  const vectorsStore = tx.objectStore('vectors');
  const metaStore = tx.objectStore('meta');

  const ops = [idbReq(vectorsStore.clear())];

  if (reason === 'chunker') {
    const chunksStore = tx.objectStore('chunks');
    ops.push(idbReq(chunksStore.clear()));
    ops.push(idbReq(metaStore.put({ key: 'chunker', value: CHUNKER_VERSION })));
  }

  ops.push(idbReq(metaStore.put({ key: 'embedder', value: EMBEDDER_ID })));
  await Promise.all(ops);
}

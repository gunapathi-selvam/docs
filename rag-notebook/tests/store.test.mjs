// IndexedDB persistence assertions. Uses the fake factory from harness.mjs.
// Tests: versioning logic, put/load/remove round-trips, invalidation. SPEC §7

import { section, ok, eq, finish, createFakeIndexedDB } from './harness.mjs';
import {
  EMBED_DIM, openStore, putDocument, loadCorpus, removeDocument, invalidateVectors,
} from '../src/js/vectorStore.js';
import { EMBEDDER_ID } from '../src/js/embedder.js';
import { CHUNKER_VERSION } from '../src/js/chunker.js';

const attempt = async (fn, fallback = undefined) => { try { return await fn(); } catch { return fallback; } };

// ---------------------------------------------------------------------------
section('store: openStore creates the four object stores');

{
  const fakeIdb = createFakeIndexedDB();
  const db = await attempt(() => openStore(fakeIdb));
  ok('openStore resolves to a db object', db !== null && db !== undefined);
  ok('docs store exists', db?._storeData?.has('docs'));
  ok('chunks store exists', db?._storeData?.has('chunks'));
  ok('vectors store exists', db?._storeData?.has('vectors'));
  ok('meta store exists', db?._storeData?.has('meta'));
}

section('store: openStore writes current version tags to meta on first open');

{
  const fakeIdb = createFakeIndexedDB();
  const db = await attempt(() => openStore(fakeIdb));
  const meta = db?._storeData?.get('meta');
  const embedderTag = meta?.records?.get('embedder');
  const chunkerTag = meta?.records?.get('chunker');
  eq('embedder tag matches EMBEDDER_ID', embedderTag?.value, EMBEDDER_ID);
  eq('chunker tag matches CHUNKER_VERSION', chunkerTag?.value, CHUNKER_VERSION);
}

section('store: invalidateVectors(reason=embedder) clears vectors only');

{
  const fakeIdb = createFakeIndexedDB();
  const db = await attempt(() => openStore(fakeIdb));
  // Manually plant a vector and a chunk record
  const vectors = db._storeData.get('vectors');
  const chunks = db._storeData.get('chunks');
  vectors.records.set('doc.md#0000', { id: 'doc.md#0000', docId: 'doc.md', data: new ArrayBuffer(8) });
  chunks.records.set('doc.md#0000', { id: 'doc.md#0000', docId: 'doc.md', body: 'test' });

  await attempt(() => invalidateVectors(db, 'embedder'));

  ok('vectors store is cleared after embedder invalidation', vectors.records.size === 0);
  ok('chunks store is preserved after embedder invalidation', chunks.records.size === 1);
}

section('store: invalidateVectors(reason=chunker) clears both chunks and vectors');

{
  const fakeIdb = createFakeIndexedDB();
  const db = await attempt(() => openStore(fakeIdb));
  const vectors = db._storeData.get('vectors');
  const chunks = db._storeData.get('chunks');
  vectors.records.set('doc.md#0000', { id: 'doc.md#0000', docId: 'doc.md', data: new ArrayBuffer(8) });
  chunks.records.set('doc.md#0000', { id: 'doc.md#0000', docId: 'doc.md', body: 'test' });

  await attempt(() => invalidateVectors(db, 'chunker'));

  ok('vectors store is cleared after chunker invalidation', vectors.records.size === 0);
  ok('chunks store is also cleared after chunker invalidation', chunks.records.size === 0);
}

section('store: putDocument / loadCorpus round-trip');

{
  const fakeIdb = createFakeIndexedDB();
  const db = await attempt(() => openStore(fakeIdb));

  // Build a minimal doc + chunks + vectors
  const doc = { id: 'test.md', name: 'test.md', bytes: 100, sha256: 'abc', addedAt: Date.now(), chunkCount: 2, text: 'Hello world' };
  const chunks = [
    { id: 'test.md#0000', docId: 'test.md', ordinal: 0, headingPath: ['Intro'], text: 'Intro\n\nHello', body: 'Hello', startOffset: 0, endOffset: 5, charCount: 5, truncatedByModel: false },
    { id: 'test.md#0001', docId: 'test.md', ordinal: 1, headingPath: ['Intro'], text: 'Intro\n\nWorld', body: 'World', startOffset: 5, endOffset: 10, charCount: 5, truncatedByModel: false },
  ];
  // Two unit vectors in EMBED_DIM space
  const vectors = new Float32Array(2 * EMBED_DIM);
  vectors[0] = 1;               // chunk 0: dim 0 = 1
  vectors[EMBED_DIM + 1] = 1;  // chunk 1: dim 1 = 1

  await attempt(() => putDocument(db, doc, chunks, vectors));

  const { chunks: loaded, matrix } = await attempt(() => loadCorpus(db), { chunks: [], matrix: new Float32Array(0) });

  ok('loadCorpus returns both chunks', loaded.length === 2);
  ok('loaded chunk has text field reconstructed', loaded.every((c) => typeof c.text === 'string' && c.text.length > 0));
  ok('matrix has correct size', matrix.length === 2 * EMBED_DIM);
  ok('first vector is correct', matrix[0] === vectors[0]);
}

section('store: removeDocument deletes doc, chunks, and vectors');

{
  const fakeIdb = createFakeIndexedDB();
  const db = await attempt(() => openStore(fakeIdb));

  const doc = { id: 'rm.md', name: 'rm.md', bytes: 10, sha256: 'x', addedAt: Date.now(), chunkCount: 1, text: 'x' };
  const chunks = [
    { id: 'rm.md#0000', docId: 'rm.md', ordinal: 0, headingPath: [], text: 'x', body: 'x', startOffset: 0, endOffset: 1, charCount: 1, truncatedByModel: false },
  ];
  const vectors = new Float32Array(EMBED_DIM);
  vectors[0] = 1;

  await attempt(() => putDocument(db, doc, chunks, vectors));
  await attempt(() => removeDocument(db, 'rm.md'));

  const { chunks: remaining } = await attempt(() => loadCorpus(db), { chunks: [], matrix: new Float32Array(0) });
  ok('chunks for removed doc are gone', remaining.filter((c) => c.docId === 'rm.md').length === 0);
  ok('vectors store has no rm.md entry', !db._storeData.get('vectors').records.has('rm.md#0000'));
  ok('docs store has no rm.md entry', !db._storeData.get('docs').records.has('rm.md'));
}

section('store: versioning — embedder mismatch triggers vector invalidation');

{
  // Simulate a prior session with a different embedder tag
  const fakeIdb = createFakeIndexedDB();

  // First open (creates stores with current tags)
  const db1 = await attempt(() => openStore(fakeIdb));

  // Plant a vector record and a stale embedder tag in meta
  const vectors = db1._storeData.get('vectors');
  vectors.records.set('x.md#0000', { id: 'x.md#0000', docId: 'x.md', data: new ArrayBuffer(8) });
  db1._storeData.get('meta').records.set('embedder', { key: 'embedder', value: 'old-embedder-id' });

  // Re-open: openStore should detect the mismatch and clear vectors
  const db2 = await attempt(() => openStore(fakeIdb));
  ok('vectors cleared after embedder version mismatch', db2._storeData.get('vectors').records.size === 0);
}

finish();

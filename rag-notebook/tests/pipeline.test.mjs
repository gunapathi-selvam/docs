// Corpus -> chunk -> embed (stubbed) -> retrieve -> prompt assembly.
// Asserts prompt caching order and the client-side allowlist. SPEC §12.2
//
// These two tests exist because both failures are invisible in normal operation:
//   - A caching regression shows up only on the bill (SPEC §8.3)
//   - An allowlist widening shows up only when someone abuses it (SPEC §3.3)

import { section, ok, eq, finish } from './harness.mjs';
import { chunk, CHUNK_CEILING } from '../src/js/chunker.js';
import { topK, cosine } from '../src/js/vectorStore.js';
import { assembleRequest, INSTRUCTIONS } from '../src/js/claude.js';

const attempt = (fn, fallback = undefined) => { try { return fn(); } catch { return fallback; } };

// Stub embedder: returns deterministic unit vectors without Transformers.js.
// The first component is the ordinal normalised so each chunk's vector is
// unique and no SDK import is needed. SPEC §12.2
function stubVectors(chunks) {
  const DIM = 384;
  const matrix = new Float32Array(chunks.length * DIM);
  for (let i = 0; i < chunks.length; i++) {
    matrix[i * DIM] = 1;  // unit vector in dimension 0
    // Small variation so chunks are distinguishable
    if (DIM > 1) matrix[i * DIM + 1] = i / (chunks.length + 1);
    // Normalise
    let norm = 0;
    for (let d = 0; d < DIM; d++) norm += matrix[i * DIM + d] ** 2;
    norm = Math.sqrt(norm);
    for (let d = 0; d < DIM; d++) matrix[i * DIM + d] /= norm;
  }
  return matrix;
}

// ---------------------------------------------------------------------------
section('pipeline: corpus -> chunk -> stub-embed -> topK is consistent');

const CORPUS = `# Introduction\n\nThe RAG notebook embeds documents in the browser.\n\n# Architecture\n\nChunking splits text into overlapping windows. Vectors are stored in IndexedDB.\n\n# Security\n\nThe API key never reaches the browser. The proxy owns the key.\n`;

const allChunks = attempt(() => chunk(CORPUS, { docId: 'corpus.md' }), []);
ok('corpus produces chunks', allChunks && allChunks.length > 0);

const matrix = allChunks ? stubVectors(allChunks) : null;

{
  const DIM = 384;
  const query = new Float32Array(DIM);
  query[0] = 1; // same direction as all stub vectors

  const results = attempt(() => topK(query, matrix, allChunks.length), []);
  ok('topK returns results over stub vectors', results && results.length > 0);
  ok('topK results have valid chunk indices',
    results && results.every((r) => r.index >= 0 && r.index < allChunks.length));
}

// ---------------------------------------------------------------------------
section('pipeline: assembleRequest structure');

const testChunks = allChunks ? allChunks.slice(0, 3) : [];
const testManifest = [{ name: 'corpus.md', chunkCount: allChunks?.length ?? 0, headings: ['Introduction', 'Architecture', 'Security'] }];
const testQuestion = 'Where does the API key live?';
const testQuestion2 = 'What is the brute-force ceiling?';

const body1 = attempt(() => assembleRequest({ question: testQuestion, chunks: testChunks, manifest: testManifest }), null);
const body2 = attempt(() => assembleRequest({ question: testQuestion2, chunks: testChunks, manifest: testManifest }), null);

ok('assembleRequest returns an object', body1 !== null && typeof body1 === 'object');

section('pipeline: the seven-field allowlist (SPEC §3.3)');

const ALLOWED = new Set(['model', 'max_tokens', 'system', 'messages', 'stream', 'thinking', 'output_config']);

ok('FAILS if proxy would forward a field outside the allowlist: exactly 7 keys',
  body1 && Object.keys(body1).length === 7);
ok('all keys are in the allowlist',
  body1 && Object.keys(body1).every((k) => ALLOWED.has(k)));
ok('model is pinned to claude-opus-5-5', body1?.model === 'claude-opus-5-5');
ok('max_tokens is present', typeof body1?.max_tokens === 'number');
ok('stream is boolean', typeof body1?.stream === 'boolean');
ok('thinking.type is adaptive (not disabled, not budget_tokens)',
  body1?.thinking?.type === 'adaptive');
ok('thinking has no budget_tokens', !('budget_tokens' in (body1?.thinking ?? {})));
ok('output_config.effort is present', typeof body1?.output_config?.effort === 'string');
ok('messages has no trailing assistant turn',
  body1 && (() => {
    const msgs = body1.messages;
    if (!Array.isArray(msgs) || msgs.length === 0) return true;
    return msgs[msgs.length - 1].role !== 'assistant';
  })());

section('pipeline: prompt caching prefix order (SPEC §8.3)');

// Test 1: The system array must be byte-identical across calls with different
// questions but the same corpus. The volatile content is in messages, not system.
ok('system array is byte-identical across two calls with different questions',
  body1 && body2 &&
  JSON.stringify(body1.system) === JSON.stringify(body2.system));

// Test 2: FAILS if volatile content is placed before the stable prefix.
// In JSON.stringify(body), INSTRUCTIONS text must appear before any chunk ID,
// and chunk IDs must appear before the question text. SPEC §8.3
ok('FAILS if volatile content is placed before stable prefix: INSTRUCTIONS before chunks',
  (() => {
    if (!body1) return false;
    const json = JSON.stringify(body1);
    if (!testChunks.length) return true;
    const instructionsIdx = json.indexOf(INSTRUCTIONS.slice(0, 30));
    const firstChunkId = testChunks[0].id;
    const chunkIdx = json.indexOf(firstChunkId);
    return instructionsIdx !== -1 && chunkIdx !== -1 && instructionsIdx < chunkIdx;
  })());

ok('FAILS if volatile content is placed before stable prefix: chunks before question in body',
  (() => {
    if (!body1 || !testChunks.length) return false;
    const json = JSON.stringify(body1);
    const firstChunkId = testChunks[0].id;
    const chunkIdx = json.indexOf(firstChunkId);
    const questionIdx = json.indexOf(testQuestion);
    return chunkIdx !== -1 && questionIdx !== -1 && chunkIdx < questionIdx;
  })());

// Test 3: Exactly one cache_control in the body, on the last system block.
ok('exactly one cache_control in the whole body',
  (() => {
    if (!body1) return false;
    const json = JSON.stringify(body1);
    const count = (json.match(/cache_control/g) || []).length;
    return count === 1;
  })());

ok('cache_control is on the last system block',
  (() => {
    if (!body1 || !Array.isArray(body1.system)) return false;
    const last = body1.system[body1.system.length - 1];
    const others = body1.system.slice(0, -1);
    return last.cache_control !== undefined &&
      others.every((s) => s.cache_control === undefined);
  })());

// Test 4: The first system block contains INSTRUCTIONS and has no cache_control.
ok('system[0] is INSTRUCTIONS and has no cache_control',
  body1 && body1.system[0]?.text === INSTRUCTIONS && !body1.system[0]?.cache_control);

// Test 5: Messages contain two content blocks: context then question.
ok('user message has two content blocks',
  body1 && body1.messages[0]?.content?.length === 2);
ok('first content block contains chunk IDs (context)',
  body1 && testChunks.length > 0 &&
  body1.messages[0].content[0].text.includes(testChunks[0].id));
ok('second content block contains the question',
  body1 && body1.messages[0].content[1].text.includes(testQuestion));

finish();

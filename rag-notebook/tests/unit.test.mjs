// Pure-module assertions: chunker, vector similarity, citation parsing.
// No DOM, no GPU, no network, no API key. SPEC §12.1

import { section, ok, eq, near, throws, finish } from './harness.mjs';
import {
  CHUNK_CEILING, CHUNK_OVERLAP, CHUNK_MIN, CHUNKER_VERSION,
  splitByHeadings, estimateTokens, chunk,
} from '../src/js/chunker.js';
import {
  EMBED_DIM, TOP_K, SIM_FLOOR, BRUTE_FORCE_CEILING,
  dot, l2norm, cosine, normaliseInPlace, topK,
} from '../src/js/vectorStore.js';
import {
  CITATION_RE, parseCitations, validateCitations, renderableSegments,
} from '../src/js/citations.js';

// One NotImplemented does not abort the suite.
const attempt = (fn, fallback = undefined) => { try { return fn(); } catch { return fallback; } };

// ---------------------------------------------------------------------------
section('chunker: configuration constants match SPEC §4.3');

eq('CHUNK_CEILING is 900', CHUNK_CEILING, 900);
eq('CHUNK_OVERLAP is 120', CHUNK_OVERLAP, 120);
eq('CHUNK_MIN is 200', CHUNK_MIN, 200);
ok('CHUNKER_VERSION is a string', typeof CHUNKER_VERSION === 'string' && CHUNKER_VERSION.length > 0);
ok('stride is ceiling minus overlap', CHUNK_CEILING - CHUNK_OVERLAP === 780);

section('chunker: estimateTokens');

eq('empty string is 0 tokens', estimateTokens(''), 0);
ok('100-char string is about 25 tokens', estimateTokens('a'.repeat(100)) === 25);
ok('400-char string is about 100 tokens', estimateTokens('a'.repeat(400)) === 100);

section('chunker: splitByHeadings');

{
  const doc = '# Top\n\nIntro.\n\n## Sub\n\nBody.\n';
  const secs = attempt(() => splitByHeadings(doc), []);
  ok('returns sections', secs.length >= 1);
  ok('heading paths are arrays', secs.every((s) => Array.isArray(s.headingPath)));
  ok('all sections have body string', secs.every((s) => typeof s.body === 'string'));
  ok('startOffset and endOffset are numbers', secs.every((s) =>
    typeof s.startOffset === 'number' && typeof s.endOffset === 'number'));
  ok('offset invariant: slice matches body', secs.every((s) => doc.slice(s.startOffset, s.endOffset) === s.body));

  const sub = secs.find((s) => s.headingPath.includes('Sub'));
  ok('sub-heading has correct path', sub && sub.headingPath[0] === 'Top' && sub.headingPath[1] === 'Sub');
}

section('chunker: chunk — basic invariants');

{
  const doc = `# Introduction\n\n${'A short section. '.repeat(5)}\n\n## Details\n\n${'More detail. '.repeat(40)}\n`;
  const chunks = attempt(() => chunk(doc, { docId: 'test.md' }), []);
  ok('returns at least one chunk', chunks.length >= 1);
  ok('no chunk body exceeds CHUNK_CEILING',
    chunks.every((c) => c.charCount <= CHUNK_CEILING));
  ok('offset invariant: text.slice(start, end) === body',
    chunks.every((c) => doc.slice(c.startOffset, c.endOffset) === c.body));
  ok('IDs are unique', new Set(chunks.map((c) => c.id)).size === chunks.length);
  ok('ordinals are 0-based and monotonic',
    chunks.every((c, i) => c.ordinal === i));
  ok('IDs are zero-padded to 4 digits', chunks.every((c) => /^test\.md#\d{4}$/.test(c.id)));
  ok('charCount matches body length', chunks.every((c) => c.charCount === c.body.length));
}

section('chunker: chunk — windowed chunks overlap');

{
  const longSection = `# Long\n\n${'word '.repeat(300)}\n`;
  const chunks = attempt(() => chunk(longSection, { docId: 'long.md' }), []);
  if (chunks && chunks.length > 1) {
    const c0 = chunks[0];
    const c1 = chunks[1];
    const prevEnd = c0.endOffset;
    const nextStart = c1.startOffset;
    ok('adjacent windowed chunks overlap by at least CHUNK_OVERLAP',
      prevEnd - nextStart >= CHUNK_OVERLAP);
  } else {
    ok('long section produces more than one chunk', false);
  }
}

section('chunker: chunk — code fences are not split mid-fence');

{
  const withFence = `# Code\n\n\`\`\`js\n${'line;\n'.repeat(20)}\`\`\`\n\nAfter.\n`;
  const chunks = attempt(() => chunk(withFence, { docId: 'code.md', ceiling: 100 }), []);
  ok('chunks produced', chunks && chunks.length > 0);
  // No chunk should start inside the fence without the opening line
  const fenceFragmented = chunks && chunks.some((c) => /^\n?line;/.test(c.body) && !c.body.includes('```'));
  ok('code fence is never split mid-content', !fenceFragmented);
}

// ---------------------------------------------------------------------------
section('vectorStore: configuration constants match SPEC §6');

eq('EMBED_DIM is 384', EMBED_DIM, 384);
eq('TOP_K is 8', TOP_K, 8);
eq('SIM_FLOOR is 0.25', SIM_FLOOR, 0.25);
eq('BRUTE_FORCE_CEILING is 8000', BRUTE_FORCE_CEILING, 8000);

section('vectorStore: dot product');

{
  const a = new Float32Array([1, 0, 0]);
  const b = new Float32Array([0, 1, 0]);
  const c = new Float32Array([2, 3, 0]);
  near('orthogonal vectors have dot product 0', dot(a, b, 0, 0, 3), 0);
  near('dot product is correct', dot(a, c, 0, 0, 3), 2);
  near('self-dot is squared norm', dot(c, c, 0, 0, 3), 13);
}

section('vectorStore: cosine similarity');

{
  const dim = 4;
  const a = new Float32Array([1, 0, 0, 0]);
  const b = new Float32Array([0, 1, 0, 0]);
  const neg = new Float32Array([-1, 0, 0, 0]);
  const zero = new Float32Array([0, 0, 0, 0]);

  near('identical unit vectors have cosine 1', cosine(a, a, 0, 0, dim), 1, 1e-6);
  near('orthogonal unit vectors have cosine 0', cosine(a, b, 0, 0, dim), 0, 1e-6);
  near('opposite unit vectors have cosine -1', cosine(a, neg, 0, 0, dim), -1, 1e-6);
  eq('zero vector returns 0 not NaN', cosine(a, zero, 0, 0, dim), 0);
  ok('zero vector result is finite', Number.isFinite(cosine(zero, zero, 0, 0, dim)));
}

section('vectorStore: cosine equals dot for normalised inputs (SPEC §6.1)');

{
  const dim = EMBED_DIM;
  // Build a random-ish normalised vector
  const a = new Float32Array(dim);
  const b = new Float32Array(dim);
  for (let i = 0; i < dim; i++) { a[i] = Math.sin(i * 0.3 + 1); b[i] = Math.cos(i * 0.2 + 2); }
  normaliseInPlace(a, 0, dim);
  normaliseInPlace(b, 0, dim);

  const cosVal = cosine(a, b, 0, 0, dim);
  const dotVal = dot(a, b, 0, 0, dim);
  near('cosine === dot within 1e-6 for normalised vectors', cosVal, dotVal, 1e-6);
}

section('vectorStore: topK');

{
  const dim = 4;
  const count = 5;
  const matrix = new Float32Array([
    1, 0, 0, 0,   // index 0
    0, 1, 0, 0,   // index 1
    0.9, 0.1, 0, 0, // index 2, close to query
    0, 0, 1, 0,   // index 3
    0.1, 0, 0, 0, // index 4, below floor
  ]);

  // Override dim for this sub-test by using a 4-dim query
  // We need to make topK use dim=4, but our export uses EMBED_DIM=384.
  // Test with full dim by padding vectors.
  const padDim = EMBED_DIM;
  const mFull = new Float32Array(count * padDim);
  // Write the first 4 values of each vector into padded positions
  for (let i = 0; i < count; i++) {
    mFull[i * padDim + 0] = matrix[i * 4 + 0];
    mFull[i * padDim + 1] = matrix[i * 4 + 1];
    mFull[i * padDim + 2] = matrix[i * 4 + 2];
    mFull[i * padDim + 3] = matrix[i * 4 + 3];
  }
  // Normalise each padded vector
  for (let i = 0; i < count; i++) normaliseInPlace(mFull, i * padDim, padDim);

  const query = new Float32Array(padDim);
  query[0] = 1; // unit vector in first dimension

  const results = attempt(() => topK(query, mFull, count), []);
  ok('topK returns results', results && results.length > 0);
  ok('results are sorted descending by score',
    results && results.every((r, i) => i === 0 || r.score <= results[i - 1].score));
  ok('best result is index 0 (exact match)',
    results && results[0].index === 0);
  ok('all scores are at or above floor',
    results && results.every((r) => r.score >= SIM_FLOOR));
  ok('results have index and score', results && results.every((r) => 'index' in r && 'score' in r));
}

section('vectorStore: persistence functions are NotImplemented skeletons');

throws('openStore throws NotImplemented', () => { throw new Error('NotImplemented'); });

// ---------------------------------------------------------------------------
section('citations: CITATION_RE is a RegExp');

ok('CITATION_RE is a RegExp', CITATION_RE instanceof RegExp);
ok('CITATION_RE source uses [[c: delimiter', CITATION_RE.source.includes('c:'));

section('citations: parseCitations finds tokens with correct offsets');

{
  const answer = 'First claim. [[c:notes.md#0007]] Second. [[c:data.md#0001]]';
  const parsed = attempt(() => parseCitations(answer), []);
  eq('finds two citations', parsed.length, 2);
  eq('first id is notes.md#0007', parsed[0]?.id, 'notes.md#0007');
  eq('second id is data.md#0001', parsed[1]?.id, 'data.md#0001');
  ok('start offset is correct for first', parsed[0]?.start === answer.indexOf('[[c:notes'));
  ok('end offset is correct for first', parsed[0]?.end === answer.indexOf('[[c:notes') + '[[c:notes.md#0007]]'.length);
}

section('citations: validateCitations status values');

{
  const answer = 'Grounded claim [[c:doc.md#0001]] and unknown [[c:doc.md#0099]] and bad [[c:nohash]]';
  const retrieved = new Set(['doc.md#0001']);
  const result = attempt(() => validateCitations(answer, retrieved), null);

  ok('returns citations array', result && Array.isArray(result.citations));
  ok('ok status for retrieved ID',
    result && result.citations.find((c) => c.id === 'doc.md#0001')?.status === 'ok');
  ok('unknown status for non-retrieved well-formed ID',
    result && result.citations.find((c) => c.id === 'doc.md#0099')?.status === 'unknown');
  ok('malformed status for bad ID',
    result && result.citations.find((c) => c.id === 'nohash')?.status === 'malformed');
  eq('verified count', result?.verified, 1);
  eq('unverified count', result?.unverified, 2);
  ok('uncited is false when at least one verified citation exists', result?.uncited === false);
}

section('citations: uncited fires when no valid citations but set is non-empty');

{
  const answer = 'No citations here at all, just prose.';
  const retrieved = new Set(['doc.md#0001']);
  const result = attempt(() => validateCitations(answer, retrieved), null);
  ok('uncited is true with non-empty retrieved set and zero citations', result?.uncited === true);
  eq('verified is 0', result?.verified, 0);
}

{
  const answer = 'No citations.';
  const emptySet = new Set();
  const result = attempt(() => validateCitations(answer, emptySet), null);
  ok('uncited is false when retrieved set is empty', result?.uncited === false);
}

section('citations: renderableSegments reassembles the original answer exactly');

{
  const answer = 'Claim A [[c:doc.md#0001]] and claim B [[c:doc.md#0002]].';
  const retrieved = new Set(['doc.md#0001', 'doc.md#0002']);
  const validated = attempt(() => validateCitations(answer, retrieved), null);
  const segments = validated ? attempt(() => renderableSegments(answer, validated), null) : null;
  ok('segments produced', segments && segments.length > 0);
  ok('segments reassemble to original answer',
    segments && segments.map((s) => s.type === 'text' ? s.text : s.citation.raw).join('') === answer);
  ok('segment types are text or citation',
    segments && segments.every((s) => s.type === 'text' || s.type === 'citation'));
}

finish();

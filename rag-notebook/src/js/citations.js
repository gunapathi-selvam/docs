// Pure: parse citations from the answer, validate against the retrieved set.
// SPEC §9. No DOM.

/**
 * Matches [[c:docId#NNNN]] tokens in an answer.
 * Capturing group 1 is the raw ID (docId#NNNN or anything malformed after [[c:).
 */
export const CITATION_RE = /\[\[c:([^\]]*)\]\]/g;

/** Grammar for a well-formed chunk ID: docId#NNNN */
const VALID_ID_RE = /^[^#\s]+#\d{4}$/;

/**
 * Return every citation token in the answer with its offsets.
 * @returns {{ raw: string, id: string, start: number, end: number }[]}
 */
export function parseCitations(answer) {
  const results = [];
  const re = new RegExp(CITATION_RE.source, 'g');
  let m;
  while ((m = re.exec(answer)) !== null) {
    results.push({
      raw: m[0],
      id: m[1],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return results;
}

/**
 * Judge each citation in `answer` against the IDs that were actually sent.
 * `retrievedIds` must be a Set<string> built at request-assembly time.
 *
 * status values:
 *   'ok'        — ID is in the retrieved set
 *   'unknown'   — well-formed ID, not in the retrieved set
 *   'malformed' — matched [[c:...]] but the inner value is not a valid chunk ID
 *
 * SPEC §9.2
 */
export function validateCitations(answer, retrievedIds) {
  const raw = parseCitations(answer);

  const citations = raw.map(({ raw: rawToken, id, start, end }) => {
    let status;
    if (!VALID_ID_RE.test(id)) {
      status = 'malformed';
    } else if (retrievedIds.has(id)) {
      status = 'ok';
    } else {
      status = 'unknown';
    }
    return { raw: rawToken, id, start, end, status };
  });

  const verified = citations.filter((c) => c.status === 'ok').length;
  const unverified = citations.filter((c) => c.status !== 'ok').length;

  // uncited: no valid citation while chunks were supplied (SPEC §9.4)
  const uncited = verified === 0 && retrievedIds.size > 0;

  return { citations, verified, unverified, uncited };
}

/**
 * Split the answer into alternating text and citation segments for rendering.
 * Reassembling text + raw tokens in order reconstructs the original answer exactly.
 * SPEC §9.3
 *
 * @param {string} answer
 * @param {{ citations: {raw: string, start: number, end: number, status: string}[] }} validated
 * @returns {{ type: 'text'|'citation', text?: string, citation?: object }[]}
 */
export function renderableSegments(answer, validated) {
  const segments = [];
  let cursor = 0;

  for (const c of validated.citations) {
    if (c.start > cursor) {
      segments.push({ type: 'text', text: answer.slice(cursor, c.start) });
    }
    segments.push({ type: 'citation', citation: c });
    cursor = c.end;
  }

  if (cursor < answer.length) {
    segments.push({ type: 'text', text: answer.slice(cursor) });
  }

  return segments;
}

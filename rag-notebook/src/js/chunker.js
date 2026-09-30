// Pure: text -> Chunk[] with offsets. No DOM, no globals, no clock.
// SPEC §4

export const CHUNK_CEILING = 900;
export const CHUNK_OVERLAP = 120;
export const CHUNK_MIN = 200;
export const CHUNKER_VERSION = '2026-09-30/h900-o120-m200';

/** Characters -> approximate wordpiece tokens. Heuristic; see SPEC §4.5. */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Split the document on ATX headings (# through ######) into sections.
 * Each section carries its heading path (stack of ancestor headings).
 * body is the raw text after the heading line; offsets index into original text.
 * Invariant: originalText.slice(section.startOffset, section.endOffset) === section.body
 */
export function splitByHeadings(text) {
  const HEADING_RE = /^(#{1,6}) (.+)$/mg;
  const hits = [];
  let m;
  while ((m = HEADING_RE.exec(text)) !== null) {
    hits.push({ level: m[1].length, title: m[2].trim(), lineStart: m.index, lineEnd: m.index + m[0].length });
  }

  const sections = [];
  const stack = [];

  // Preamble before the first heading
  const firstHit = hits[0];
  if (!firstHit || firstHit.lineStart > 0) {
    const end = firstHit ? firstHit.lineStart : text.length;
    const body = text.slice(0, end);
    if (body.trim()) sections.push({ headingPath: [], startOffset: 0, endOffset: end, body });
  }

  for (let i = 0; i < hits.length; i++) {
    const { level, title, lineEnd } = hits[i];
    const nextLineStart = i + 1 < hits.length ? hits[i + 1].lineStart : text.length;

    // Keep only ancestors (levels strictly shallower than current)
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, title });

    // Body starts after the heading line. Skip a single trailing newline on the heading line.
    const bodyStart = lineEnd < text.length && text[lineEnd] === '\n' ? lineEnd + 1 : lineEnd;
    const bodyEnd = nextLineStart;
    const body = text.slice(bodyStart, bodyEnd);

    sections.push({
      headingPath: stack.map((h) => h.title),
      startOffset: bodyStart,
      endOffset: bodyEnd,
      body,
    });
  }

  return sections;
}

/**
 * Find a good break position at or before `pos` in `str`, preferring
 * paragraph > sentence > whitespace > any character.
 */
function findBreak(str, pos) {
  // Paragraph break (blank line)
  const para = str.lastIndexOf('\n\n', pos);
  if (para > pos / 2) return para + 2;
  // Sentence boundary
  const sent = str.lastIndexOf('. ', pos);
  if (sent > pos / 2) return sent + 2;
  // Whitespace
  const ws = str.lastIndexOf(' ', pos);
  if (ws > pos / 2) return ws + 1;
  return pos;
}

/**
 * Find the start of the next opening code fence at or after `fromPos`.
 * A fence can appear at position 0 (no preceding newline) or after a newline.
 * Returns -1 if none found.
 */
function nextFenceOpen(str, fromPos) {
  if (fromPos === 0 && str.startsWith('```')) return 0;
  const idx = str.indexOf('\n```', fromPos);
  return idx === -1 ? -1 : idx + 1;
}

/**
 * Find the position after the end of the closing ``` line for a fence that
 * opens at `openPos` (the position of the backtick characters).
 * Returns str.length if no closing fence is found (oversized fence).
 */
function fenceEnd(str, openPos) {
  const openLineEnd = str.indexOf('\n', openPos);
  if (openLineEnd === -1) return str.length;
  const closingNl = str.indexOf('\n```', openLineEnd);
  if (closingNl === -1) return str.length;
  const afterClosingLine = str.indexOf('\n', closingNl + 1);
  return afterClosingLine === -1 ? str.length : afterClosingLine + 1;
}

/**
 * text -> Chunk[]. Pure, deterministic, offsets index into the original text.
 * SPEC §4.2
 */
export function chunk(text, { docId = 'doc', ceiling = CHUNK_CEILING, overlap = CHUNK_OVERLAP, min = CHUNK_MIN } = {}) {
  const stride = ceiling - overlap;
  const rawSections = splitByHeadings(text);

  // Merge short sections forward (SPEC §4.2 step 5)
  const sections = [];
  for (let i = 0; i < rawSections.length; i++) {
    const sec = rawSections[i];
    if (sections.length > 0 && sections[sections.length - 1].body.trim().length < min) {
      const prev = sections[sections.length - 1];
      // Merge prev into sec: combine bodies preserving the gap (heading line) between them
      const gap = text.slice(prev.endOffset, sec.startOffset);
      sections[sections.length - 1] = {
        headingPath: sec.headingPath,
        startOffset: prev.startOffset,
        endOffset: sec.endOffset,
        body: prev.body + gap + sec.body,
      };
    } else {
      sections.push({ ...sec });
    }
  }

  const chunks = [];
  let ordinal = 0;

  const emit = (headingPath, bodySlice, absStart, absEnd) => {
    const breadcrumb = headingPath.join(' > ');
    const embeddedText = breadcrumb ? breadcrumb + '\n\n' + bodySlice : bodySlice;
    chunks.push({
      id: `${docId}#${String(ordinal).padStart(4, '0')}`,
      docId,
      ordinal: ordinal++,
      headingPath,
      text: embeddedText,
      body: bodySlice,
      startOffset: absStart,
      endOffset: absEnd,
      charCount: bodySlice.length,
      truncatedByModel: estimateTokens(embeddedText) > 256,
    });
  };

  for (const sec of sections) {
    const { headingPath, body, startOffset } = sec;

    if (body.length <= ceiling) {
      emit(headingPath, body, startOffset, startOffset + body.length);
      continue;
    }

    // Window with overlap, keeping code fences atomic (SPEC §4.2 step 4).
    let pos = 0;
    while (pos < body.length) {
      let end = Math.min(pos + ceiling, body.length);
      let fenceEnd_ = -1;

      // If a code fence opens at or before end and does not close within the
      // window, extend the window to include the whole fence. SPEC §4.2 step 4.
      const fo = nextFenceOpen(body, pos);
      if (fo !== -1 && fo <= end) {
        const fe = fenceEnd(body, fo);
        if (fe > end) {
          end = fe;       // atomic fence; may exceed ceiling
          fenceEnd_ = fe; // remember so next pos jumps past the fence
        }
      }

      if (end < body.length) end = findBreak(body, end);
      end = Math.min(end, body.length);

      emit(headingPath, body.slice(pos, end), startOffset + pos, startOffset + end);

      if (end >= body.length) break;

      if (fenceEnd_ > 0) {
        // Jump past the fence so overlapping windows do not re-enter it.
        pos = fenceEnd_;
      } else {
        // Normal stride: ceiling - overlap, at least 1 to always advance.
        const stride = Math.max(1, ceiling - overlap);
        pos = pos + stride;
      }
    }
  }

  return chunks;
}

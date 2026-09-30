// Confusion matrix: accumulation (pure) + canvas heatmap rendering. SPEC §11.

// Full 26-letter alphabet in order; J and Z are present but never populated
// by the 1.0 classifier. Their rows/columns appear as empty. SPEC §11.2, §8.1.
export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

export const MATRIX_SIZE = 26; // rows and columns

// Colour ramp: single hue, monotonically increasing lightness. SPEC §11.4.
// t = cell / rowTotal — a rate, not a raw count.
export const RAMP = [
  { t: 0.00, hex: '#101a2e' }, // zero floor
  { t: 0.15, hex: '#1d3a6b' },
  { t: 0.40, hex: '#2f6fd0' },
  { t: 0.75, hex: '#6ea8ff' },
  { t: 1.00, hex: '#cfe2ff' },
];

// localStorage schema version. A mismatch discards the stored matrix. SPEC §11.5.
export const SCHEMA_VERSION = 1;
export const STORAGE_KEY = 'asl.confusion';

// ---------------------------------------------------------------- accumulation

/**
 * Create a fresh 26x26 confusion matrix: an array of 26 rows, each an array
 * of 26 zeros. Row = truth (target), column = what was classified. SPEC §11.2
 * @returns {number[][]}
 */
export function makeMatrix() {
  return Array.from({ length: MATRIX_SIZE }, () => new Array(MATRIX_SIZE).fill(0));
}

/**
 * Accumulate one latch into the matrix.
 * Does not mutate; returns the updated matrix. SPEC §11.2
 * Abstentions (latchedLetter === null) are not recorded. SPEC §10.2
 *
 * @param {number[][]} matrix
 * @param {string}     targetLetter   the letter the quiz wanted
 * @param {string}     latchedLetter  the letter that was committed
 * @returns {number[][]}  updated matrix
 */
export function recordLatch(matrix, targetLetter, latchedLetter) {
  if (latchedLetter === null) return matrix;
  const r = LETTERS.indexOf(targetLetter);
  const c = LETTERS.indexOf(latchedLetter);
  if (r < 0 || c < 0) return matrix;
  const updated = matrix.map((row) => [...row]);
  updated[r][c]++;
  return updated;
}

/**
 * Sum of all cells in a row. Used to normalise cell colours. SPEC §11.3
 * @param {number[][]} matrix
 * @param {number}     rowIndex  0–25
 * @returns {number}
 */
export function rowTotal(matrix, rowIndex) {
  return matrix[rowIndex].reduce((a, b) => a + b, 0);
}

/**
 * Three-state cell classification. SPEC §11.3
 * @param {number[][]} matrix
 * @param {number}     rowIndex  0–25
 * @param {number}     colIndex  0–25
 * @returns {'empty'|'zero'|'hit'}
 */
export function cellState(matrix, rowIndex, colIndex) {
  const total = rowTotal(matrix, rowIndex);
  if (total === 0) return 'empty';
  if (matrix[rowIndex][colIndex] === 0) return 'zero';
  return 'hit';
}

/**
 * Map a rate t in [0,1] to a hex colour by linearly interpolating in sRGB
 * between adjacent ramp stops. SPEC §11.4
 * @param {number} t
 * @returns {string}  '#rrggbb'
 */
export function rampColor(t) {
  t = Math.max(0, Math.min(1, t));
  // Find the two bracketing stops.
  let lo = RAMP[0];
  let hi = RAMP[RAMP.length - 1];
  for (let i = 0; i < RAMP.length - 1; i++) {
    if (t >= RAMP[i].t && t <= RAMP[i + 1].t) {
      lo = RAMP[i];
      hi = RAMP[i + 1];
      break;
    }
  }
  const span = hi.t - lo.t;
  const f    = span < 1e-9 ? 0 : (t - lo.t) / span;
  const parseHex = (h) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
  const [r1, g1, b1] = parseHex(lo.hex);
  const [r2, g2, b2] = parseHex(hi.hex);
  const lerp = (a, b) => Math.round(a + f * (b - a));
  const toHex2 = (v) => v.toString(16).padStart(2, '0');
  return '#' + toHex2(lerp(r1, r2)) + toHex2(lerp(g1, g2)) + toHex2(lerp(b1, b2));
}

// ---------------------------------------------------------------- persistence

/**
 * Serialise the matrix for localStorage. SPEC §11.5
 * @param {number[][]} matrix
 * @returns {string}  JSON string
 */
export function serializeMatrix(matrix) {
  return JSON.stringify({
    v:       SCHEMA_VERSION,
    cells:   matrix.flat(),
    updated: Date.now(),
  });
}

/**
 * Deserialise from localStorage. Returns null if the schema version does not
 * match or the JSON is malformed — the caller discards and starts fresh. SPEC §11.5
 * @param {string} json
 * @returns {number[][]|null}
 */
export function deserializeMatrix(json) {
  try {
    const data = JSON.parse(json);
    if (!data || data.v !== SCHEMA_VERSION) return null;
    if (!Array.isArray(data.cells) || data.cells.length !== MATRIX_SIZE * MATRIX_SIZE) return null;
    const matrix = [];
    for (let r = 0; r < MATRIX_SIZE; r++) {
      matrix.push(
        data.cells.slice(r * MATRIX_SIZE, (r + 1) * MATRIX_SIZE).map(Number)
      );
    }
    return matrix;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- rendering

// Label for the LABEL_W reserved on the top and left for axis labels.
const LABEL_W = 18; // pixels

/**
 * Draw the 26x26 heatmap onto ctx. Called on change only, never per rAF frame.
 * SPEC §11.6
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number[][]}               matrix
 * @param {{ width?: number, height?: number, cellSize?: number }} opts
 */
export function drawMatrix(ctx, matrix, opts = {}) {
  const canvasW = opts.width  ?? (ctx.canvas ? ctx.canvas.width  : 520);
  const canvasH = opts.height ?? (ctx.canvas ? ctx.canvas.height : 520);
  const gridW = canvasW - LABEL_W;
  const gridH = canvasH - LABEL_W;
  const cs = opts.cellSize ?? Math.max(1,
    Math.min(Math.floor(gridW / MATRIX_SIZE), Math.floor(gridH / MATRIX_SIZE))
  );

  ctx.clearRect(0, 0, canvasW, canvasH);
  ctx.font         = '9px monospace';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';

  // Column labels (top strip).
  ctx.fillStyle = '#8b93a7';
  for (let c = 0; c < MATRIX_SIZE; c++) {
    if (cs < 10 && c % 2 !== 0) continue;
    ctx.fillText(LETTERS[c], LABEL_W + c * cs + cs / 2, LABEL_W / 2);
  }

  for (let r = 0; r < MATRIX_SIZE; r++) {
    const rTotal = rowTotal(matrix, r);

    // Row label (left strip).
    if (cs >= 10 || r % 2 === 0) {
      ctx.fillStyle = '#8b93a7';
      ctx.fillText(LETTERS[r], LABEL_W / 2, LABEL_W + r * cs + cs / 2);
    }

    for (let c = 0; c < MATRIX_SIZE; c++) {
      const x = LABEL_W + c * cs;
      const y = LABEL_W + r * cs;
      const state = cellState(matrix, r, c);

      if (state === 'empty') {
        // No fill — background shows through. 1 px hairline grid. SPEC §11.3
        ctx.strokeStyle = '#1d2333';
        ctx.lineWidth   = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, cs - 1, cs - 1);
      } else {
        const t     = rTotal > 0 ? matrix[r][c] / rTotal : 0;
        const color = state === 'zero' ? '#101a2e' : rampColor(t);
        ctx.fillStyle = color;
        ctx.fillRect(x, y, cs, cs);

        // Diagonal: 1 px inset border in accent colour. SPEC §11.4
        if (r === c) {
          ctx.strokeStyle = '#6ea8ff';
          ctx.lineWidth   = 1;
          ctx.strokeRect(x + 1.5, y + 1.5, cs - 3, cs - 3);
        }

        // Off-diagonal label for significant confusions. SPEC §11.4
        if (r !== c && t >= 0.25 && cs >= 14) {
          ctx.fillStyle = '#05060a';
          ctx.fillText(LETTERS[c], x + cs / 2, y + cs / 2);
        }
      }
    }
  }
}

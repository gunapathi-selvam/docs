// Synthetic 21-landmark generator for all 24 static ASL letters.
//
// Coordinates are normalised like MediaPipe output (x,y in ~[0,1], z relative).
// Fingers extend upward (negative y direction in image coords where y grows down).
// Palm faces toward the camera (+z = toward camera).
//
// The fixture produces a RIGHT-HAND frame after mirror-normalisation — it is
// what classifyLetter() expects after §5.1 has been applied.
//
// Straightness targets (SPEC §14.2):
//   extended → [0.94, 1.0]   (bends: [5°, 8°, 8°])
//   curved   → [0.60, 0.78]  (bends: [45°, 60°, 50°])
//   folded   → [0.15, 0.40]  (bends: [85°, 95°, 80°])

const D = Math.PI / 180;

// Finger definitions relative to a wrist at (0,0):
//   angle = direction of the MCP from wrist
//   dist  = MCP distance in "natural" units (will be scaled by SCALE)
//   segs  = segment lengths for the three phalanges [PIP, DIP, tip]
const FINGERS = [
  { angle: -105 * D, dist: 0.60, segs: [0.23, 0.15, 0.11] }, // index  (lm[5-8])
  { angle:  -90 * D, dist: 0.62, segs: [0.25, 0.16, 0.11] }, // middle (lm[9-12])
  { angle:  -76 * D, dist: 0.59, segs: [0.23, 0.15, 0.11] }, // ring   (lm[13-16])
  { angle:  -63 * D, dist: 0.54, segs: [0.19, 0.12, 0.10] }, // pinky  (lm[17-20])
];

const THUMB_BASE_ANGLE = -145 * D;
const THUMB_BASE_DIST  =  0.22;
const THUMB_SEGS       = [0.20, 0.17, 0.13];

// Scale factor: wrist-to-middle-MCP distance = SPAN in image units.
const SPAN  = 0.25;   // desired hand span
const SCALE = SPAN / 0.62; // 0.62 is middle finger's dist

// Centre of the hand in image coordinates.
const CX = 0.5;
const CY = 0.75;

// Bend angles per state (degrees, converted to radians inside walk()).
// Folded uses tighter bends than galaxy-spiral so all fingers (including
// middle, which starts at -90° with less lateral clearance) land in [0.15, 0.40].
const BENDS = {
  extended: [5 * D,  8 * D,   8 * D],
  curved:   [45 * D, 60 * D,  50 * D],
  folded:   [90 * D, 100 * D, 85 * D],
};

// Thumb bends for each thumb state.
const THUMB_BENDS = {
  extended: [0 * D,  8 * D,  6 * D],  // s ≈ 0.998, abduction OK when pointing radially
  folded:   [30 * D, 72 * D, 66 * D], // tuck across palm
};

// ---------------------------------------------------------------- geometry

function pt(x, y, z = 0) { return { x, y, z }; }

/** Walk a joint chain from a starting position along an initial angle. */
function walk(startX, startY, angle, segs, bends) {
  let x = startX, y = startY, a = angle;
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    a += bends[i];
    x += Math.cos(a) * segs[i];
    y += Math.sin(a) * segs[i];
    out.push(pt(x, y));
  }
  return out;
}

/** Build a finger chain (MCP + 3 joints) given a finger definition and a bend state. */
function buildFinger(fingerDef, bendState) {
  const s = SCALE;
  const mx = CX + Math.cos(fingerDef.angle) * fingerDef.dist * s;
  const my = CY + Math.sin(fingerDef.angle) * fingerDef.dist * s;
  const segs = fingerDef.segs.map((v) => v * s);
  const joints = walk(mx, my, fingerDef.angle, segs, BENDS[bendState]);
  return [pt(mx, my), ...joints]; // [MCP, PIP, DIP, TIP]
}

/** Build the thumb chain (lm[1]+) from a bend state, with the tip at an anchor if given. */
function buildThumb(bendState, tipAnchor = null) {
  const s = SCALE;
  const b1x = CX + Math.cos(THUMB_BASE_ANGLE) * THUMB_BASE_DIST * s;
  const b1y = CY + Math.sin(THUMB_BASE_ANGLE) * THUMB_BASE_DIST * s;
  const segs = THUMB_SEGS.map((v) => v * s);
  const bends = THUMB_BENDS[bendState];
  const joints = walk(b1x, b1y, THUMB_BASE_ANGLE, segs, bends);
  // joints[0]=lm[2], joints[1]=lm[3], joints[2]=lm[4]

  if (tipAnchor) {
    // Override the tip position and interpolate PIP/DIP along a slightly bowed path.
    const tx = tipAnchor.x, ty = tipAnchor.y, tz = tipAnchor.z || 0;
    // Intermediate joints at 1/3 and 2/3 of the path from lm[2] to tip, with slight z bow.
    const j2x = b1x + (tx - b1x) * 0.4;
    const j2y = b1y + (ty - b1y) * 0.4;
    const j2z = tz * 0.3;
    const j3x = b1x + (tx - b1x) * 0.72;
    const j3y = b1y + (ty - b1y) * 0.72;
    const j3z = tz * 0.7;
    return [
      pt(b1x, b1y),                // lm[1] thumb CMC
      pt(j2x, j2y, j2z),           // lm[2] thumb MCP
      pt(j3x, j3y, j3z),           // lm[3] thumb IP
      pt(tx,  ty,  tz),             // lm[4] thumb tip
    ];
  }

  return [pt(b1x, b1y), ...joints];
}

// ---------------------------------------------------------------- palm-frame helpers
// These are used only inside the fixture to compute target anchor positions.

function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) }; }
function norm(v) {
  const l = Math.hypot(v.x, v.y, v.z || 0);
  return l < 1e-10 ? { x: 0, y: 0, z: 0 } : { x: v.x / l, y: v.y / l, z: (v.z || 0) / l };
}
function cross(a, b) {
  return {
    x: a.y * (b.z || 0) - (a.z || 0) * b.y,
    y: (a.z || 0) * b.x - a.x * (b.z || 0),
    z: a.x * b.y - a.y * b.x,
  };
}

/**
 * Compute the palm frame for a partially built landmark set.
 * lm must have indices 0, 5, 9, 13, 17 defined.
 * Returns { u, r, n, o, span } matching SPEC §4.3.
 */
function computeFrame(lm) {
  const span = Math.max(1e-4, Math.hypot(
    lm[9].x - lm[0].x, lm[9].y - lm[0].y, (lm[9].z || 0) - (lm[0].z || 0),
  ));
  const u = norm(sub(lm[9], lm[0]));
  const a = norm(sub(lm[17], lm[5]));
  const n = norm(cross(a, u));
  const r = cross(u, n);
  const ox = (lm[0].x + lm[5].x + lm[9].x + lm[13].x + lm[17].x) / 5;
  const oy = (lm[0].y + lm[5].y + lm[9].y + lm[13].y + lm[17].y) / 5;
  const oz = ((lm[0].z || 0) + (lm[5].z || 0) + (lm[9].z || 0) + (lm[13].z || 0) + (lm[17].z || 0)) / 5;
  return { u, r, n, o: { x: ox, y: oy, z: oz }, span };
}

/**
 * Convert palm-frame coordinates (u, r, n in hand-spans) back to world coords.
 * SPEC §4.3.
 */
function fromLocal(uCoord, rCoord, nCoord, frame) {
  const { u, r, n, o, span } = frame;
  return {
    x: o.x + (u.x * uCoord + r.x * rCoord + n.x * nCoord) * span,
    y: o.y + (u.y * uCoord + r.y * rCoord + n.y * nCoord) * span,
    z: (o.z || 0) + ((u.z || 0) * uCoord + (r.z || 0) * rCoord + (n.z || 0) * nCoord) * span,
  };
}

// ---------------------------------------------------------------- landmark builder

/**
 * Assemble a full 21-landmark array from finger and thumb data.
 *
 * @param {{ index, middle, ring, pinky }} fingers  each a 'extended'|'curved'|'folded' state
 * @param {{ state, anchor }}             thumb     state plus optional tip anchor
 * @param {number}                        roll      in-plane rotation in radians (default 0)
 * @returns {Array}  21-element landmark array
 */
function assembleLandmarks({ fingers, thumb, roll = 0 }) {
  // Build with roll=0 first, then rotate.
  const idx  = buildFinger(FINGERS[0], fingers.index  || 'extended');
  const mid  = buildFinger(FINGERS[1], fingers.middle || 'extended');
  const ring = buildFinger(FINGERS[2], fingers.ring   || 'extended');
  const pky  = buildFinger(FINGERS[3], fingers.pinky  || 'extended');

  // Wrist
  const wrist = pt(CX, CY);

  // Thumb tip anchor in world coords: derive from a placeholder frame built on
  // the no-roll landmarks, then convert back.
  const placeholderLm = [
    wrist,
    null, null, null, null,      // thumb (1-4): filled below
    ...idx,                       // 5-8
    ...mid,                       // 9-12
    ...ring,                      // 13-16
    ...pky,                       // 17-20
  ];

  let thumbChain;
  if (thumb && thumb.anchor) {
    const frame = computeFrame(placeholderLm);
    const { t_u, t_r, t_n } = thumb.anchor;
    const worldAnchor = fromLocal(t_u, t_r, t_n, frame);
    thumbChain = buildThumb(thumb.state || 'folded', worldAnchor);
  } else {
    thumbChain = buildThumb(thumb ? (thumb.state || 'extended') : 'extended', null);
  }

  const lm = [
    wrist,        // 0
    thumbChain[0], // 1  thumb CMC
    thumbChain[1], // 2  thumb MCP
    thumbChain[2], // 3  thumb IP
    thumbChain[3], // 4  thumb tip
    ...idx,        // 5-8
    ...mid,        // 9-12
    ...ring,       // 13-16
    ...pky,        // 17-20
  ];

  if (!roll) return lm;

  // Apply in-plane rotation around the wrist.
  const cos = Math.cos(roll), sin = Math.sin(roll);
  return lm.map(({ x, y, z }) => {
    const dx = x - CX, dy = y - CY;
    return pt(CX + dx * cos - dy * sin, CY + dx * sin + dy * cos, z || 0);
  });
}

// ---------------------------------------------------------------- letter configs

// Palm-frame thumb-tip anchors for the fist-bucket letters.
// Values from SPEC §4.4.1 table and §6.3 Level 4 thresholds.
// (t_u, t_r, t_n) in hand-spans.
const THUMB_ANCHORS = {
  A: { t_u:  0.35, t_r: -0.78, t_n: 0.05 },  // radial edge, standing up
  S: { t_u:  0.15, t_r:  0.04, t_n: 0.42 },  // across the front
  T: { t_u:  0.10, t_r: -0.38, t_n: 0.15 },  // I|M slot
  N: { t_u:  0.05, t_r: -0.05, t_n: 0.12 },  // M|R slot
  M: { t_u:  0.00, t_r:  0.26, t_n: 0.10 },  // R|P slot
};

/**
 * Configuration for each of the 24 static letters.
 * Specifies finger states and thumb placement.
 */
const LETTER_CONFIGS = {
  // ---- Bucket 0 (mask 0): all fingers closed ----
  A: {
    fingers: { index: 'folded', middle: 'folded', ring: 'folded', pinky: 'folded' },
    thumb:   { state: 'extended', anchor: THUMB_ANCHORS.A },
  },
  C: {
    fingers: { index: 'curved', middle: 'curved', ring: 'curved', pinky: 'curved' },
    thumb:   { state: 'folded', anchor: null }, // held out front, wide aperture
  },
  E: {
    fingers: { index: 'curved', middle: 'curved', ring: 'curved', pinky: 'curved' },
    thumb:   { state: 'folded', anchor: { t_u: -0.05, t_r: 0.0, t_n: 0.0 } },
  },
  M: {
    fingers: { index: 'folded', middle: 'folded', ring: 'folded', pinky: 'folded' },
    thumb:   { state: 'folded', anchor: THUMB_ANCHORS.M },
  },
  N: {
    fingers: { index: 'folded', middle: 'folded', ring: 'folded', pinky: 'folded' },
    thumb:   { state: 'folded', anchor: THUMB_ANCHORS.N },
  },
  O: {
    fingers: { index: 'curved', middle: 'curved', ring: 'curved', pinky: 'curved' },
    thumb:   { state: 'folded', anchor: { t_u: 0.18, t_r: -0.15, t_n: 0.05 } }, // meets index tip
  },
  S: {
    fingers: { index: 'folded', middle: 'folded', ring: 'folded', pinky: 'folded' },
    thumb:   { state: 'folded', anchor: THUMB_ANCHORS.S },
  },
  T: {
    fingers: { index: 'folded', middle: 'folded', ring: 'folded', pinky: 'folded' },
    thumb:   { state: 'folded', anchor: THUMB_ANCHORS.T },
  },
  X: {
    // X: index curved, others folded. SPEC §6.3 Level 3.
    fingers: { index: 'curved', middle: 'folded', ring: 'folded', pinky: 'folded' },
    thumb:   { state: 'folded', anchor: null },
  },

  // ---- Bucket 1 (mask 2): index only ----
  D: {
    fingers: { index: 'extended', middle: 'folded', ring: 'folded', pinky: 'folded' },
    thumb:   { state: 'folded', anchor: null }, // loops to meet middle tip
  },

  // ---- Bucket 2 (mask 16): pinky only ----
  I: {
    fingers: { index: 'folded', middle: 'folded', ring: 'folded', pinky: 'extended' },
    thumb:   { state: 'folded', anchor: null },
  },

  // ---- Bucket 3 (mask 6): index + middle, thumb folded ----
  H: {
    // H points sideways (SIDE tilt). SPEC §7.
    fingers: { index: 'extended', middle: 'extended', ring: 'folded', pinky: 'folded' },
    thumb:   { state: 'folded', anchor: null },
    roll:    90 * D, // rotate hand to point sideways
  },
  R: {
    // R: index and middle crossed. SPEC §6.4.
    fingers: { index: 'extended', middle: 'extended', ring: 'folded', pinky: 'folded' },
    thumb:   { state: 'folded', anchor: null },
    crossed: true, // fixture swaps lm[8] and lm[12] to simulate crossing
  },
  U: {
    fingers: { index: 'extended', middle: 'extended', ring: 'folded', pinky: 'folded' },
    thumb:   { state: 'folded', anchor: null },
  },
  V: {
    // V: index and middle spread apart. SPEC §6.4.
    fingers: { index: 'extended', middle: 'extended', ring: 'folded', pinky: 'folded' },
    thumb:   { state: 'folded', anchor: null },
    spread:  true, // extra lateral separation between lm[8] and lm[12]
  },

  // ---- Bucket 4 (mask 14): index + middle + ring ----
  W: {
    fingers: { index: 'extended', middle: 'extended', ring: 'extended', pinky: 'folded' },
    thumb:   { state: 'folded', anchor: null },
  },

  // ---- Bucket 5 (mask 28): middle + ring + pinky ----
  F: {
    fingers: { index: 'folded', middle: 'extended', ring: 'extended', pinky: 'extended' },
    thumb:   { state: 'folded', anchor: null }, // loops to index tip
  },

  // ---- Bucket 6 (mask 30): index + middle + ring + pinky ----
  B: {
    fingers: { index: 'extended', middle: 'extended', ring: 'extended', pinky: 'extended' },
    thumb:   { state: 'folded', anchor: { t_u: -0.10, t_r: 0.05, t_n: 0.05 } }, // flat across palm
  },

  // ---- Bucket 7 (mask 3): thumb + index ----
  G: {
    // G: thumb and index parallel, pointing sideways. SPEC §6.5, §7.
    fingers: { index: 'extended', middle: 'folded', ring: 'folded', pinky: 'folded' },
    thumb:   { state: 'extended', anchor: null },
    roll:    90 * D,
  },
  L: {
    // L: thumb perpendicular to index (theta_TI ≈ 85°). SPEC §6.5.
    fingers: { index: 'extended', middle: 'folded', ring: 'folded', pinky: 'folded' },
    thumb:   { state: 'extended', anchor: null }, // thumb extends radially
  },
  Q: {
    // Q: G handshape pointing down. SPEC §6.5, §7.
    fingers: { index: 'extended', middle: 'folded', ring: 'folded', pinky: 'folded' },
    thumb:   { state: 'extended', anchor: null },
    roll:    -90 * D, // pointing down
  },

  // ---- Bucket 8 (mask 17): thumb + pinky ----
  Y: {
    fingers: { index: 'folded', middle: 'folded', ring: 'folded', pinky: 'extended' },
    thumb:   { state: 'extended', anchor: null },
  },

  // ---- Bucket 9 (mask 7): thumb + index + middle ----
  K: {
    fingers: { index: 'extended', middle: 'extended', ring: 'folded', pinky: 'folded' },
    thumb:   { state: 'extended', anchor: { t_u: 0.50, t_r: -0.30, t_n: 0.05 } }, // between index+middle
  },
  P: {
    // P: K handshape pointing down. SPEC §6.6, §7.
    fingers: { index: 'extended', middle: 'extended', ring: 'folded', pinky: 'folded' },
    thumb:   { state: 'extended', anchor: { t_u: 0.50, t_r: -0.30, t_n: 0.05 } },
    roll:    -90 * D, // pointing down
  },
};

// ---------------------------------------------------------------- public API

/**
 * Generate 21 MediaPipe-shaped landmarks for the given ASL letter.
 *
 * @param {string}   letter  one of the 24 static letters (not J or Z)
 * @param {{ roll?: number }} opts
 *   opts.roll  override the in-plane rotation (radians); default from config or 0.
 * @returns {Array}  21-element landmark array, each { x, y, z }
 */
export function makeLetter(letter, opts = {}) {
  const cfg = LETTER_CONFIGS[letter];
  if (!cfg) throw new Error(`Unknown or unsupported letter: ${letter}`);
  const roll = opts.roll !== undefined ? opts.roll : (cfg.roll || 0);
  const lm = assembleLandmarks({ fingers: cfg.fingers, thumb: cfg.thumb, roll });

  // Post-process for R (crossed fingers): swap the tips of index and middle.
  if (cfg.crossed) {
    const tmp = lm[8];
    lm[8] = lm[12];
    lm[12] = tmp;
  }

  // Post-process for V (spread fingers): push lm[8] further radially and lm[12] ulnarly.
  if (cfg.spread) {
    const spreadAmt = 0.12 * SCALE;
    lm[8]  = pt(lm[8].x  + spreadAmt, lm[8].y,  lm[8].z  || 0);
    lm[12] = pt(lm[12].x - spreadAmt, lm[12].y, lm[12].z || 0);
  }

  return lm;
}

/**
 * Convenience: wrap a landmark set as if returned by HandTracker (Right hand).
 */
export function handOf(letter, opts = {}) {
  return { landmarks: makeLetter(letter, opts), handedness: 'Right', handednessConfidence: 0.95 };
}

// ---------------------------------------------------------------- exports for assertions

/** Straightness of a chain in the 2D fixture. Used by unit tests to verify band membership. */
export function fixtureChainStraightness(lm, chain) {
  let path = 0;
  for (let i = 1; i < chain.length; i++) {
    const a = lm[chain[i - 1]], b = lm[chain[i]];
    path += Math.hypot(b.x - a.x, b.y - a.y, (b.z || 0) - (a.z || 0));
  }
  if (path < 1e-9) return 0;
  const first = lm[chain[0]], last = lm[chain[chain.length - 1]];
  const chord = Math.hypot(last.x - first.x, last.y - first.y, (last.z || 0) - (first.z || 0));
  return chord / path;
}

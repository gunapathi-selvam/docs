// Synthetic MediaPipe-shaped hand: 21 landmarks with anatomically plausible
// joint chains, so extended fingers curve slightly rather than being perfect
// rulers. Coordinates are normalised (0..1) like MediaPipe's output.
const D = Math.PI / 180;

function walk(origin, angle, segs, bends) {
  const out = [];
  let [x, y] = origin, a = angle;
  for (let i = 0; i < segs.length; i++) {
    a += bends[i];
    x += Math.cos(a) * segs[i];
    y += Math.sin(a) * segs[i];
    out.push([x, y]);
  }
  return out;
}

const FINGERS = [
  { angle: -105 * D, dist: 0.60, segs: [0.23, 0.15, 0.11] }, // index
  { angle: -90 * D, dist: 0.62, segs: [0.25, 0.16, 0.11] },  // middle
  { angle: -76 * D, dist: 0.59, segs: [0.23, 0.15, 0.11] },  // ring
  { angle: -63 * D, dist: 0.54, segs: [0.19, 0.12, 0.10] },  // pinky
];

/**
 * @param raised [thumb, index, middle, ring, pinky] as 0/1
 * @param span   wrist-to-middle-knuckle distance in frame units (depth cue)
 * @param rot    in-plane roll, radians
 * @param pinch  when true, the thumb tip is snapped onto the index tip
 */
export function makeHand({
  raised = [1, 1, 1, 1, 1], cx = 0.5, cy = 0.5, span = 0.15, rot = 0, pinch = false,
} = {}) {
  const L = [[0, 0]];
  const base = walk([0, 0], -145 * D, [0.22], [0])[0];
  L.push(base);
  L.push(...walk(base, -145 * D, [0.20, 0.17, 0.13],
    raised[0] ? [0, 8 * D, 6 * D] : [30 * D, 72 * D, 66 * D]));

  for (let i = 0; i < 4; i++) {
    const { angle, dist, segs } = FINGERS[i];
    const mcp = [Math.cos(angle) * dist, Math.sin(angle) * dist];
    L.push(mcp);
    L.push(...walk(mcp, angle, segs,
      raised[i + 1] ? [5 * D, 8 * D, 8 * D] : [72 * D, 80 * D, 62 * D]));
  }

  if (pinch) L[4] = [...L[8]];

  const k = span / 0.62;
  const c = Math.cos(rot), s = Math.sin(rot);
  return L.map(([x, y]) => ({ x: cx + (x * c - y * s) * k, y: cy + (x * s + y * c) * k, z: 0 }));
}

export const hand = (o) => ({ landmarks: makeHand(o), handedness: 'Right' });

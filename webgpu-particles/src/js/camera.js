// Orbit camera and projection. Pure math, no DOM, no GPU — the uniform block
// is the only thing that crosses to the device. SPEC §3.3, §8.

export const DEFAULT_CAMERA = {
  yaw: 0.6,
  pitch: 0.35,
  distance: 3.2,
  fovY: Math.PI / 4,
  near: 0.05,
  far: 100,
};

export const DISTANCE_MIN = 0.4;
export const DISTANCE_MAX = 40;

// Pitch is clamped just short of the poles. At exactly +/-pi/2 the up vector
// becomes parallel to the view direction, the cross product collapses, and
// lookAt produces NaN that propagates into every vertex.
const PITCH_LIMIT = Math.PI / 2 - 0.01;

/** Column-major 4x4 identity, matching WGSL mat4x4<f32> memory order. */
export function identity(out = new Float32Array(16)) {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

export function perspective(fovY, aspect, near, far, out = new Float32Array(16)) {
  const f = 1 / Math.tan(fovY / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  // WebGPU clip space is z in [0,1], unlike OpenGL's [-1,1]. Using the GL form
  // here halves the usable depth range and is invisible without a depth test.
  out[10] = far / (near - far);
  out[11] = -1;
  out[14] = (far * near) / (near - far);
  return out;
}

export function lookAt(eye, target, up, out = new Float32Array(16)) {
  let zx = eye[0] - target[0];
  let zy = eye[1] - target[1];
  let zz = eye[2] - target[2];
  const zl = Math.hypot(zx, zy, zz) || 1;
  zx /= zl; zy /= zl; zz /= zl;

  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  const xl = Math.hypot(xx, xy, xz) || 1;
  xx /= xl; xy /= xl; xz /= xl;

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
  return out;
}

export function multiply(a, b, out = new Float32Array(16)) {
  // Aliasing out with a or b would read values already overwritten.
  const dst = out === a || out === b ? new Float32Array(16) : out;
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    for (let r = 0; r < 4; r++) {
      dst[c * 4 + r] = a[r] * b0 + a[4 + r] * b1 + a[8 + r] * b2 + a[12 + r] * b3;
    }
  }
  if (dst !== out) out.set(dst);
  return out;
}

/** Eye position from yaw, pitch and distance. */
export function eyeFromOrbit(cam) {
  const cp = Math.cos(cam.pitch);
  const sp = Math.sin(cam.pitch);
  return [
    cam.distance * cp * Math.sin(cam.yaw),
    cam.distance * sp,
    cam.distance * cp * Math.cos(cam.yaw),
  ];
}

/** viewProj for the current camera and viewport aspect. */
export function viewProj(cam, aspect, out = new Float32Array(16)) {
  const p = perspective(cam.fovY, aspect, cam.near, cam.far);
  const v = lookAt(eyeFromOrbit(cam), [0, 0, 0], [0, 1, 0]);
  return multiply(p, v, out);
}

/**
 * Apply a drag in pixels to yaw and pitch. Pitch is clamped just short of the
 * poles: at exactly +/-pi/2 the view basis is degenerate because the up vector
 * becomes parallel to the view direction, and lookAt produces NaN.
 */
export function orbit(cam, dxPixels, dyPixels, viewportHeight) {
  // A full viewport height of drag sweeps half a turn, which keeps the gain
  // independent of window size.
  const scale = Math.PI / Math.max(1, viewportHeight);
  cam.yaw += dxPixels * scale;
  cam.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, cam.pitch + dyPixels * scale));
  return cam;
}

/**
 * Dolly the camera along the view direction. Zoom moves the camera rather than
 * changing FOV, because changing FOV at a fixed distance distorts the
 * perspective divide and makes the swarm appear to inflate. SPEC §8.
 */
export function dolly(cam, wheelDelta) {
  // Multiplicative so a notch feels the same at every distance. fovY is
  // deliberately untouched — see SPEC §8.
  cam.distance = Math.max(
    DISTANCE_MIN,
    Math.min(DISTANCE_MAX, cam.distance * Math.exp(wheelDelta * 0.001))
  );
  return cam;
}

/**
 * Unproject a pointer position to a world-space point at the swarm's depth,
 * for the grab attractor. Returns a vec3 as a 3-element array.
 */
export function pointerToWorld(cam, aspect, ndcX, ndcY, depth = 0) {
  // Intersects the pointer ray with the plane through the origin facing the
  // camera. Cheaper and better conditioned than inverting viewProj, and the
  // swarm is centred on the origin so that plane is the one we want.
  const eye = eyeFromOrbit(cam);
  const el = Math.hypot(eye[0], eye[1], eye[2]) || 1;
  const fx = -eye[0] / el, fy = -eye[1] / el, fz = -eye[2] / el;

  let rx = fy * 0 - fz * 1;
  let ry = fz * 0 - fx * 0;
  let rz = fx * 1 - fy * 0;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;

  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;

  const dist = Math.max(1e-3, cam.distance + depth);
  const th = Math.tan(cam.fovY / 2);
  const hx = ndcX * th * aspect * dist;
  const hy = ndcY * th * dist;

  return [
    eye[0] + fx * dist + rx * hx + ux * hy,
    eye[1] + fy * dist + ry * hx + uy * hy,
    eye[2] + fz * dist + rz * hx + uz * hy,
  ];
}

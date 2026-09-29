// WebGL2 point-sprite renderer. Draws the whole field in one call, with the
// rotation, projection and colour ramp evaluated on the GPU.
//
// Mirrors ParticleField.render's maths exactly so the two paths look the same.
// main.js falls back to the 2D canvas path when create() returns null.

const VERT = `#version 300 es
in vec3 a_pos;
in float a_tint;
in float a_size;

uniform vec3 u_rot;
uniform float u_focal;
uniform float u_viewScale;
uniform vec2 u_center;
uniform vec2 u_res;
uniform float u_baseR;
uniform float u_dpr;
uniform vec3 u_stops[5];

out vec4 v_color;

void main() {
  float sinX = sin(u_rot.x), cosX = cos(u_rot.x);
  float sinY = sin(u_rot.y), cosY = cos(u_rot.y);
  float sinZ = sin(u_rot.z), cosZ = cos(u_rot.z);

  float y1 = a_pos.y * cosX - a_pos.z * sinX;
  float z1 = a_pos.y * sinX + a_pos.z * cosX;
  float x2 = a_pos.x * cosY + z1 * sinY;
  float z2 = -a_pos.x * sinY + z1 * cosY;
  float x3 = x2 * cosZ - y1 * sinZ;
  float y3 = x2 * sinZ + y1 * cosZ;

  if (!(z2 > -u_focal + 1e-4)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    v_color = vec4(0.0);
    return;
  }

  float persp = u_focal / (u_focal + z2);
  vec2 px = u_center + vec2(x3, y3) * persp * u_viewScale;
  gl_Position = vec4(px.x / u_res.x * 2.0 - 1.0, 1.0 - px.y / u_res.y * 2.0, 0.0, 1.0);

  float depth = clamp((persp - 0.55) / 1.25, 0.0, 1.0);
  gl_PointSize = max(1.0, u_baseR * a_size * (0.45 + persp * 0.75) * 2.0 * u_dpr);

  // Same ramp as the 2D path, but continuous: the GPU has no reason to
  // quantise into buckets, which only ever existed to batch fill calls.
  float f = clamp(a_tint * 0.62 + depth * 0.38, 0.0, 1.0) * 4.0;
  int lo = min(int(floor(f)), 3);
  vec3 c = mix(u_stops[lo], u_stops[lo + 1], f - float(lo)) / 255.0;

  float alpha = 0.18 + depth * 0.80;
  v_color = vec4(c * alpha, alpha);   // premultiplied for additive blending
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 outColor;

void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float a = smoothstep(0.25, 0.02, r2);
  outColor = vec4(v_color.rgb * a, v_color.a * a);
}`;

const FADE_VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FADE_FRAG = `#version 300 es
precision mediump float;
uniform vec4 u_fade;
out vec4 outColor;
void main() { outColor = u_fade; }`;

const BG = [4 / 255, 6 / 255, 20 / 255];

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('shader: ' + log);
  }
  return sh;
}

function link(gl, vsSrc, fsSrc) {
  const p = gl.createProgram();
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error('link: ' + log);
  }
  return p;
}

export class GLRenderer {
  /** Returns null when WebGL2 is unavailable, so the caller can fall back. */
  static create(canvas) {
    let gl = null;
    try {
      gl = canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        // Trails accumulate in the drawing buffer across frames.
        preserveDrawingBuffer: true,
        powerPreference: 'high-performance',
      });
    } catch {
      return null;
    }
    // The test harness hands back a 2D stub for every getContext argument.
    if (!gl || typeof gl.createShader !== 'function') return null;
    try {
      return new GLRenderer(gl);
    } catch (err) {
      console.warn('[galaxy-spiral] WebGL init failed, using 2D canvas', err);
      return null;
    }
  }

  constructor(gl) {
    this.gl = gl;
    this.prog = link(gl, VERT, FRAG);
    this.fadeProg = link(gl, FADE_VERT, FADE_FRAG);

    this.u = {};
    for (const n of ['u_rot', 'u_focal', 'u_viewScale', 'u_center', 'u_res', 'u_baseR', 'u_dpr', 'u_stops']) {
      this.u[n] = gl.getUniformLocation(this.prog, n);
    }
    this.uFade = gl.getUniformLocation(this.fadeProg, 'u_fade');

    this.vao = gl.createVertexArray();
    this.fadeVao = gl.createVertexArray();
    this.posBuf = gl.createBuffer();
    this.tintBuf = gl.createBuffer();
    this.sizeBuf = gl.createBuffer();
    this.count = 0;
    this.stopBuf = new Float32Array(15);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
  }

  /** Uploads the per-particle constants. Call once per field. */
  attach(field) {
    const gl = this.gl;
    this.count = field.count;

    gl.bindVertexArray(this.vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, field.pos.byteLength, gl.DYNAMIC_DRAW);
    const aPos = gl.getAttribLocation(this.prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.tintBuf);
    gl.bufferData(gl.ARRAY_BUFFER, field.tint, gl.STATIC_DRAW);
    const aTint = gl.getAttribLocation(this.prog, 'a_tint');
    gl.enableVertexAttribArray(aTint);
    gl.vertexAttribPointer(aTint, 1, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.sizeBuf);
    gl.bufferData(gl.ARRAY_BUFFER, field.sizeSeed, gl.STATIC_DRAW);
    const aSize = gl.getAttribLocation(this.prog, 'a_size');
    gl.enableVertexAttribArray(aSize);
    gl.vertexAttribPointer(aSize, 1, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);
  }

  render(field, width, height, opts = {}) {
    const { trails = true, dotScale = 1, dpr = 1 } = opts;
    const gl = this.gl;

    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);

    if (trails) {
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.fadeProg);
      gl.uniform4f(this.uFade, BG[0], BG[1], BG[2], 0.28);
      gl.bindVertexArray(this.fadeVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else {
      gl.clearColor(BG[0], BG[1], BG[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    const { cx, cy, viewScale, focal } = field.viewParams(width, height);
    const baseR = Math.max(1, Math.min(width, height) / 620) * 1.55 * dotScale * (1 + field.energy * 0.5);

    const stops = field.stops;
    for (let i = 0; i < 5; i++) {
      this.stopBuf[i * 3] = stops[i][0];
      this.stopBuf[i * 3 + 1] = stops[i][1];
      this.stopBuf[i * 3 + 2] = stops[i][2];
    }

    gl.blendFunc(gl.ONE, gl.ONE);   // additive; colour is premultiplied
    gl.useProgram(this.prog);
    gl.uniform3f(this.u.u_rot, field.rot.x, field.rot.y, field.rot.z);
    gl.uniform1f(this.u.u_focal, focal);
    gl.uniform1f(this.u.u_viewScale, viewScale);
    gl.uniform2f(this.u.u_center, cx, cy);
    gl.uniform2f(this.u.u_res, width, height);
    gl.uniform1f(this.u.u_baseR, baseR);
    gl.uniform1f(this.u.u_dpr, dpr);
    gl.uniform3fv(this.u.u_stops, this.stopBuf);

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, field.pos);
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.bindVertexArray(null);

    field.visible = this.count;
    return this.count;
  }
}

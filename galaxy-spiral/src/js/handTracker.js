// Camera capture + MediaPipe HandLandmarker. Loaded from a CDN at runtime,
// so the first run needs a network connection (it caches afterwards).

const VISION_VERSION = '0.10.14';
const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + VISION_VERSION;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// Connections used to draw the skeleton overlay.
export const HAND_BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export class HandTracker {
  constructor({ onStatus = () => {} } = {}) {
    this.onStatus = onStatus;
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;
    this.landmarker = null;
    this.stream = null;
    this.running = false;
    this.lastVideoTime = -1;
    this.hands = [];     // [{ landmarks, handedness }]
    this.fps = 0;
    this._frames = 0;
    this._fpsClock = 0;
  }

  async start() {
    if (this.running) return;

    this.onStatus('requesting camera');
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();

    this.onStatus('loading hand model');
    const { FilesetResolver, HandLandmarker } = await import(
      /* @vite-ignore */ CDN + '/vision_bundle.mjs'
    );
    const fileset = await FilesetResolver.forVisionTasks(CDN + '/wasm');

    // GPU is much faster but is not available everywhere; fall back quietly.
    try {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    } catch {
      this.onStatus('GPU unavailable, using CPU');
      this.landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
        runningMode: 'VIDEO',
        numHands: 2,
      });
    }

    this.running = true;
    this.onStatus('tracking');
  }

  stop() {
    this.running = false;
    this.hands = [];
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.video.srcObject = null;
    this.onStatus('camera off');
  }

  /**
   * Runs detection if a fresh camera frame is available.
   * Landmark x is flipped so it lines up with the mirrored on-screen preview.
   */
  detect(nowMs) {
    if (!this.running || !this.landmarker) return this.hands;
    if (this.video.readyState < 2) return this.hands;
    if (this.video.currentTime === this.lastVideoTime) return this.hands;
    this.lastVideoTime = this.video.currentTime;

    let result;
    try {
      result = this.landmarker.detectForVideo(this.video, nowMs);
    } catch {
      return this.hands;
    }

    const out = [];
    const sets = result.landmarks || [];
    for (let i = 0; i < sets.length; i++) {
      const mirrored = sets[i].map((p) => ({ x: 1 - p.x, y: p.y, z: p.z }));
      const label = result.handedness?.[i]?.[0]?.categoryName || 'Hand';
      // Mirroring the image also swaps perceived left/right.
      out.push({
        landmarks: mirrored,
        handedness: label === 'Left' ? 'Right' : label === 'Right' ? 'Left' : label,
      });
    }
    this.hands = out;

    this._frames++;
    if (nowMs - this._fpsClock > 500) {
      this.fps = Math.round((this._frames * 1000) / (nowMs - this._fpsClock));
      this._frames = 0;
      this._fpsClock = nowMs;
    }
    return this.hands;
  }
}

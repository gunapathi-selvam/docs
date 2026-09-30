// Camera capture + MediaPipe HandLandmarker lifecycle.
// Provides x-flipped (selfie-view) landmarks and swapped handedness labels.
// SPEC §2, §5.1, §15.

const VISION_VERSION = '0.10.14'; // SPEC §15
const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + VISION_VERSION;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// 21 landmark connections for the skeleton overlay. Same list as galaxy-spiral.
export const HAND_BONES = [
  [0, 1],  [1, 2],  [2, 3],  [3, 4],
  [0, 5],  [5, 6],  [6, 7],  [7, 8],
  [5, 9],  [9, 10], [10, 11],[11, 12],
  [9, 13], [13, 14],[14, 15],[15, 16],
  [13, 17],[17, 18],[18, 19],[19, 20],
  [0, 17],
];

/**
 * Wraps MediaPipe HandLandmarker with camera lifecycle management.
 *
 * After `start(videoEl)`:
 *   - `hands` is an array of { landmarks, handedness, handednessConfidence }
 *   - landmarks have x flipped to (1 - x) for the selfie preview, and the
 *     handedness label is also swapped to match. SPEC §5.1.
 *   - `detect(nowMs)` must be called each animation frame.
 *
 * numHands = 1 per SPEC §2; the highest-confidence hand wins if MediaPipe
 * returns more than one.
 */
export class HandTracker {
  constructor({ onStatus = () => {} } = {}) {
    this.onStatus = onStatus;
    this.hands    = [];
    this._stream      = null;
    this._landmarker  = null;
    this._video       = null;
    this._lastVideoTime = -1;
  }

  /**
   * Start the camera and load the MediaPipe model.
   * @param {HTMLVideoElement} videoEl  Video element to stream camera into.
   */
  async start(videoEl) {
    this._video = videoEl;

    // ---- 1. Load MediaPipe module from CDN (~8 MB). Show loading state. ----
    this.onStatus('Loading MediaPipe model (~8 MB) — please wait...');
    let FilesetResolver, HandLandmarker;
    try {
      const vision = await import(/* @vite-ignore */ `${CDN}/vision_bundle.mjs`);
      FilesetResolver = vision.FilesetResolver;
      HandLandmarker  = vision.HandLandmarker;
    } catch (err) {
      const e = new Error(`MediaPipe CDN unreachable: ${err.message}`);
      e.name = 'MediaPipeError';
      throw e;
    }

    // ---- 2. Resolve WASM bundle. ----
    let fileset;
    try {
      fileset = await FilesetResolver.forVisionTasks(`${CDN}/wasm`);
    } catch (err) {
      throw new Error(`MediaPipe WASM init failed: ${err.message}`);
    }

    // ---- 3. Create HandLandmarker (GPU, fall back to CPU). ----
    this.onStatus('Initialising hand landmarker...');
    let usedDelegate = 'GPU';
    try {
      this._landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 1,
      });
    } catch {
      usedDelegate = 'CPU';
      try {
        this._landmarker = await HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
          runningMode: 'VIDEO',
          numHands: 1,
        });
      } catch (cpuErr) {
        throw new Error(`HandLandmarker init failed: ${cpuErr.message}`);
      }
    }
    if (usedDelegate === 'CPU') this.onStatus('GPU unavailable — using CPU inference');

    // ---- 4. Request camera. Distinct messages for each failure mode. ----
    this.onStatus('Opening camera...');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const e = new Error('getUserMedia not available — use http://localhost or https://');
      e.name = 'NotFoundError';
      throw e;
    }
    // Allow the original DOMException to propagate — it carries the correct .name
    // (NotAllowedError / NotFoundError / NotReadableError) which main.js inspects.
    this._stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });

    // ---- 5. Attach stream to video element. ----
    videoEl.srcObject = this._stream;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Video metadata timeout')), 10000);
      videoEl.onloadedmetadata = () => { clearTimeout(timeout); resolve(); };
      videoEl.onerror = (e) => { clearTimeout(timeout); reject(e); };
    });
    await videoEl.play();

    this.onStatus(`Ready (${usedDelegate})`);
  }

  /** Stop the camera and release the stream. */
  stop() {
    if (this._stream) {
      this._stream.getTracks().forEach((t) => t.stop());
      this._stream = null;
    }
    if (this._video) {
      this._video.srcObject = null;
      this._video = null;
    }
    if (this._landmarker) {
      try { this._landmarker.close(); } catch { /* ignore */ }
      this._landmarker = null;
    }
    this.hands = [];
  }

  /**
   * Run detection if a fresh video frame is available.
   * x is flipped to 1−x (selfie view); handedness label is swapped. SPEC §5.1.
   *
   * @param {number} nowMs  DOMHighResTimeStamp from requestAnimationFrame
   * @returns {Array}  current this.hands value
   */
  detect(nowMs) {
    if (!this._landmarker || !this._video) return this.hands;
    if (this._video.readyState < 2) return this.hands; // not enough data yet
    if (this._video.currentTime === this._lastVideoTime) return this.hands;
    this._lastVideoTime = this._video.currentTime;

    let result;
    try {
      result = this._landmarker.detectForVideo(this._video, nowMs);
    } catch {
      return this.hands;
    }

    if (!result.landmarks || result.landmarks.length === 0) {
      this.hands = [];
      return this.hands;
    }

    // With numHands = 1 there will usually be one result, but pick highest-confidence
    // if MediaPipe returns more. SPEC §2.
    let bestIdx = 0, bestConf = -Infinity;
    for (let i = 0; i < result.handedness.length; i++) {
      const conf = result.handedness[i]?.[0]?.score ?? 0;
      if (conf > bestConf) { bestConf = conf; bestIdx = i; }
    }

    const rawLandmarks    = result.landmarks[bestIdx];
    const handednessEntry = result.handedness[bestIdx]?.[0];
    const rawLabel        = handednessEntry?.categoryName ?? 'Right';
    const conf            = handednessEntry?.score ?? 0;

    // Flip x → 1−x for selfie view; swap label to match. SPEC §5.1.
    const landmarks = rawLandmarks.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z }));
    const handedness = rawLabel === 'Right' ? 'Left' : 'Right';

    this.hands = [{ landmarks, handedness, handednessConfidence: conf }];
    return this.hands;
  }
}

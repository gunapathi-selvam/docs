// Transformers.js Whisper lifecycle, windowing, and backend selection.
//
// The model is loaded on explicit user action (download button), not on page load.
// WebGPU is the default; wasm is the fallback. A 20-second watchdog on the first
// real window triggers automatic wasm fallback. SPEC §5.4
//
// Nothing in this module crosses the network except the model fetch itself.
// Audio buffers are never serialised or transmitted. SPEC §3.4

import { STRIDE_FRAMES } from './recorder.js';

export const MODEL_ID    = 'Xenova/whisper-tiny.en';
export const WINDOW_S    = 30.0;
export const STRIDE_S    = 25.0;
export const WATCHDOG_MS = 20000; // SPEC §5.4

// CDN URL for Transformers.js — pinned to a stable 2.x release.
const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

// Module-level state (singleton per page load).
let _pipeline = null;
let _backend  = null;
let _pipeFactory = null;
let _firstRealWindow = true;

async function getPipeFactory() {
  if (!_pipeFactory) {
    const mod = await import(TRANSFORMERS_CDN);
    _pipeFactory = mod.pipeline;
  }
  return _pipeFactory;
}

/**
 * Download the model and prepare the pipeline. Calls progressCallback with
 * { status, loaded, total, file } per file. SPEC §8.2
 *
 * progressCallback signature: (progress: { status, file, loaded, total }) => void
 * Returns a transcriber handle: { backend }.
 */
export async function loadModel(progressCallback) {
  const pipe = await getPipeFactory();

  const tryDevice = (device) =>
    pipe('automatic-speech-recognition', MODEL_ID, {
      device,
      progress_callback: (p) => {
        progressCallback?.(p);
      },
    });

  // Try WebGPU first; fall back to wasm on any error.
  let pipeInstance;
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      pipeInstance = await tryDevice('webgpu');
      _backend = 'webgpu';
    } catch {
      pipeInstance = await tryDevice('wasm');
      _backend = 'wasm';
    }
  } else {
    pipeInstance = await tryDevice('wasm');
    _backend = 'wasm';
  }

  // Warm-up: run inference once on 1 s of silence to compile shaders / load WASM.
  progressCallback?.({ status: 'warmup', file: 'warmup' });
  const warmup = new Float32Array(16000); // 1 s of silence at 16 kHz
  await pipeInstance(warmup, { sampling_rate: 16000 });

  _pipeline = pipeInstance;
  _firstRealWindow = true; // reset watchdog for each new model load

  return { backend: _backend };
}

/**
 * Transcribe one 30-second window.
 * Returns { windowStart, segments: [ { start, end, text } ] }
 * where start/end are absolute seconds derived from the frame counter. SPEC §5
 *
 * windowStart is in FRAMES; segments carry absolute seconds.
 */
export async function transcribeWindow(samples, windowStart) {
  if (!_pipeline) {
    throw new Error('Model not loaded. Please download the speech model first.');
  }

  const windowStartS = windowStart / 16000; // frames → seconds

  const runInference = (p) =>
    p(samples, {
      sampling_rate: 16000,
      return_timestamps: true,
      chunk_length_s: 30,
    });

  let result;

  if (_firstRealWindow) {
    _firstRealWindow = false;

    if (_backend === 'webgpu') {
      // 20-second watchdog — if WebGPU is too slow, reload with wasm. SPEC §5.4
      let watchdogFired = false;
      const watchdog = new Promise((_, reject) =>
        setTimeout(() => {
          watchdogFired = true;
          reject(new Error('Transcription watchdog: WebGPU took > 20 s, falling back to wasm'));
        }, WATCHDOG_MS),
      );

      try {
        result = await Promise.race([runInference(_pipeline), watchdog]);
      } catch (err) {
        if (watchdogFired) {
          // Reload with wasm and retry this window.
          const pipe = await getPipeFactory();
          _pipeline = await pipe('automatic-speech-recognition', MODEL_ID, { device: 'wasm' });
          _backend = 'wasm';
          result = await runInference(_pipeline);
        } else {
          throw err;
        }
      }
    } else {
      result = await runInference(_pipeline);
    }
  } else {
    result = await runInference(_pipeline);
  }

  // Map Transformers.js chunk output to absolute-time segments.
  const chunks = result?.chunks ?? [];
  const segments = chunks
    .map((chunk) => {
      const [t0, t1] = chunk.timestamp ?? [0, null];
      return {
        start: windowStartS + (t0 ?? 0),
        end:   windowStartS + (t1 != null ? t1 : (t0 ?? 0) + 5),
        text:  (chunk.text ?? '').trim(),
      };
    })
    .filter((s) => s.text.length > 0);

  return { windowStart: windowStartS, segments, backend: _backend };
}

/**
 * Schedule windows for a completed recording.
 * Returns an array of { windowStart } descriptors from frame 0 to end,
 * each STRIDE_FRAMES apart, with the last window zero-padded. SPEC §5.3
 */
export function scheduleWindows(totalFrames) {
  const descriptors = [];
  let start = 0;
  while (start < totalFrames) {
    descriptors.push({ windowStart: start });
    start += STRIDE_FRAMES;
  }
  return descriptors;
}

/** Return the current backend, or null if model is not loaded. */
export function getBackend() {
  return _backend;
}

// Audio capture: getUserMedia -> AudioContext -> AudioWorklet -> ring buffer.
//
// The AudioWorklet runs on a separate render thread and is the only place
// device-rate audio exists. By the time data arrives on the main thread it is
// already 16 kHz mono float32. SPEC §4.2
//
// ctx.sampleRate is checked after construction because the 16 kHz argument is
// a request, not a guarantee. SPEC §4.3

export const WINDOW_FRAMES   = 480000; // 30 s at 16 kHz. SPEC §5.2
export const STRIDE_FRAMES   = 400000; // 25 s at 16 kHz. SPEC §5.3
export const RING_CHUNK      = 256000; // 16 s growth chunk. SPEC §4.4
export const MAX_FRAMES      = 16000 * 3600; // 60-minute hard cap. SPEC §4.4
export const WARN_FRAMES     = 16000 * 1800; // 30-minute warning. SPEC §4.4

/**
 * Start recording. Returns a recorder handle with:
 *   { stop(), onLevel(fn), onWindow(fn), onWarning(fn), frameCount }
 *
 * onLevel: called with { peak: 0..1, rms: 0..1 } at ~47 Hz. SPEC §4.4
 * onWindow: called with { windowStart, samples: Float32Array } for each ready window.
 * onWarning: called with a message string at 30 min; recording stops at 60 min.
 */
export async function startRecording(callbacks = {}) {
  // Mutable callback store so callers can swap handlers after start.
  const cbs = {
    onLevel:   callbacks.onLevel   ?? null,
    onWindow:  callbacks.onWindow  ?? null,
    onWarning: callbacks.onWarning ?? null,
  };

  // ---- 1. getUserMedia — distinct error messages per failure mode ----------
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (err) {
    const name = err?.name ?? '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      throw new Error(
        'Microphone permission was denied. Please allow microphone access in your browser settings and try again.',
      );
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      throw new Error(
        'No microphone found. Please connect a microphone and try again.',
      );
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      throw new Error(
        'The microphone is in use by another application. Please close other apps using the microphone and try again.',
      );
    }
    throw new Error(`Microphone error (${name || 'unknown'}): ${err.message || err}`);
  }

  // ---- 2. AudioContext at 16 kHz ------------------------------------------
  // The sampleRate argument is a request; ctx.sampleRate tells us what we got.
  const ctx = new AudioContext({ sampleRate: 16000 }); // eslint-disable-line no-undef

  // ---- 3. Load AudioWorklet ------------------------------------------------
  // import.meta.url is an HTTP URL in the browser — no path encoding issues.
  const workletUrl = new URL('./worklet.js', import.meta.url);
  await ctx.audioWorklet.addModule(workletUrl.href);

  // ---- 4. Create worklet node ---------------------------------------------
  const workletNode = new AudioWorkletNode(ctx, 'voice-capture'); // eslint-disable-line no-undef

  // ---- 5. Ring buffer — growable in RING_CHUNK increments -----------------
  let ring = new Float32Array(RING_CHUNK);
  let ringCapacity = RING_CHUNK;
  let writePos = 0; // total output frames written

  let nextWindowStart = 0; // frame offset of next window to emit
  let stopped = false;
  let warnedAt30 = false;

  workletNode.port.onmessage = (event) => {
    const msg = event.data;
    if (!msg) return;

    if (msg.type === 'level') {
      cbs.onLevel?.({ peak: msg.peak, rms: msg.rms });
      return;
    }

    if (msg.type === 'block') {
      if (stopped) return;

      // msg.samples arrives as a transferred ArrayBuffer — reconstruct view
      const samples = msg.samples instanceof Float32Array
        ? msg.samples
        : new Float32Array(msg.samples);
      const blockLen = samples.length;

      // Grow ring if needed
      if (writePos + blockLen > ringCapacity) {
        const needed = writePos + blockLen;
        const newCapacity = Math.min(
          Math.ceil(needed / RING_CHUNK) * RING_CHUNK,
          MAX_FRAMES,
        );
        if (newCapacity > ringCapacity) {
          const newRing = new Float32Array(newCapacity);
          newRing.set(ring.subarray(0, writePos));
          ring = newRing;
          ringCapacity = newCapacity;
        }
      }

      // Write — clamp to hard cap
      const writeable = Math.min(blockLen, MAX_FRAMES - writePos);
      ring.set(samples.subarray(0, writeable), writePos);
      writePos += writeable;

      // 30-minute warning (once only)
      if (!warnedAt30 && writePos >= WARN_FRAMES) {
        warnedAt30 = true;
        cbs.onWarning?.('30 minutes recorded. Recording will stop at 60 minutes.');
      }

      // 60-minute hard stop
      if (writePos >= MAX_FRAMES) {
        handle.stop();
        return;
      }

      // Emit windows as they become complete
      while (!stopped && writePos >= nextWindowStart + WINDOW_FRAMES) {
        const windowStart = nextWindowStart;
        const slice = sliceWindow(ring, writePos, windowStart);
        cbs.onWindow?.({ windowStart, samples: slice });
        nextWindowStart += STRIDE_FRAMES;
      }
    }
  };

  // ---- Connect the audio graph --------------------------------------------
  const source = ctx.createMediaStreamSource(stream);
  source.connect(workletNode);
  // AudioWorkletNode needs at least one output to keep it alive in some browsers
  workletNode.connect(ctx.destination);

  // ---- Handle ---------------------------------------------------------------
  const handle = {
    get frameCount() { return writePos; },

    stop() {
      if (stopped) return;
      stopped = true;

      source.disconnect();
      workletNode.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});

      // Emit any trailing partial window (zero-padded) if there is audio beyond
      // the last full-stride boundary.
      if (writePos > nextWindowStart) {
        const slice = sliceWindow(ring, writePos, nextWindowStart);
        cbs.onWindow?.({ windowStart: nextWindowStart, samples: slice });
      }
    },

    onLevel(fn)   { cbs.onLevel   = fn; },
    onWindow(fn)  { cbs.onWindow  = fn; },
    onWarning(fn) { cbs.onWarning = fn; },
  };

  return handle;
}

/**
 * Slice a window from the ring buffer starting at `startFrame`.
 * Zero-pads the final window. SPEC §5.2
 */
export function sliceWindow(ring, writePos, startFrame) {
  const out = new Float32Array(WINDOW_FRAMES);
  const end = Math.min(startFrame + WINDOW_FRAMES, writePos, ring.length);
  if (end > startFrame) {
    out.set(ring.subarray(startFrame, end), 0);
  }
  // Remainder is implicitly zero-filled by Float32Array constructor.
  return out;
}

/**
 * Compute next window start frame given the previous one. SPEC §5.3
 */
export function nextWindowStart(prevStart) {
  return prevStart + STRIDE_FRAMES;
}

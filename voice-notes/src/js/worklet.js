// AudioWorkletProcessor — runs on the audio render thread.
//
// This file is loaded via audioWorklet.addModule(), not as a normal ES module.
// It cannot use import statements.
//
// Responsibilities:
//   1. Detect whether the context is already at 16 kHz (primary path).
//   2. If not, apply a 31-tap windowed-sinc FIR low-pass (Blackman-Harris,
//      cutoff 7200 Hz) then decimate — integer (48k/16k=3) or fractional
//      (44.1k/16k=2.75625) with linear interpolation. SPEC §4.3
//   3. Accumulate 1280 output frames (80 ms at 16 kHz) then postMessage
//      the block as a transferred Float32Array. SPEC §4.4
//   4. Post peak and RMS every 8 quanta (and on the first quantum) for the
//      level meter. SPEC §4.4
//   5. Stamp every output block with the frame counter at its first sample. SPEC §4.5
//   6. Persist the FIR delay line across quanta — resetting it per quantum
//      introduces a 1.9 kHz buzz. SPEC §4.3

class VoiceCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();

    // `sampleRate` is a global provided by the AudioWorklet scope.
    const inputRate = sampleRate; // eslint-disable-line no-undef
    this._passthrough = Math.abs(inputRate - 16000) < 1;
    this._ratio = inputRate / 16000; // e.g. 3 for 48 kHz, 2.75625 for 44.1 kHz

    if (!this._passthrough) {
      // ---- 31-tap Blackman-Harris windowed-sinc FIR, cutoff 7200 Hz ----
      const N = 31;
      const M = 15; // (N - 1) / 2
      const fc = 7200 / inputRate; // normalised cutoff (0 < fc < 0.5)

      const h = new Float64Array(N);
      let dcSum = 0;
      for (let n = 0; n < N; n++) {
        const k = n - M;
        // Four-term Blackman-Harris window
        const w =
          0.35875 -
          0.48829 * Math.cos((2 * Math.PI * n) / (N - 1)) +
          0.14128 * Math.cos((4 * Math.PI * n) / (N - 1)) -
          0.01168 * Math.cos((6 * Math.PI * n) / (N - 1));
        // Windowed sinc
        const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
        h[n] = sinc * w;
        dcSum += h[n];
      }
      // Normalise to unity DC gain
      for (let n = 0; n < N; n++) h[n] /= dcSum;
      this._fir = new Float32Array(h);

      // Circular delay line — length = N; persists across quanta (SPEC §4.3)
      this._dl = new Float32Array(N);
      this._dlHead = 0; // index where next sample will be written

      // Fractional decimation state
      // _phase: the (fractional) input-sample index at which the next output is desired.
      // _lastFirOut: FIR output at the previous input sample (for linear interpolation).
      this._phase = 0;
      this._inputIdx = 0;
      this._lastFirOut = 0;
    }

    // Output accumulation buffer — 1280 frames = 80 ms at 16 kHz
    this._accum = new Float32Array(1280);
    this._accumPos = 0;
    this._totalFrames = 0;  // total output frames emitted (used as block stamp)
    this._blockStart = 0;   // frame counter at first sample of current block

    // Level meter state — accumulated across quanta
    this._quantaCount = 0;
    this._levelPeak = 0;
    this._levelSumSq = 0;
    this._levelCount = 0;
  }

  // ---- FIR via circular delay line ----------------------------------------

  _applyFIR(x) {
    const dl = this._dl;
    const N = this._fir.length;
    // Insert new sample at head position
    dl[this._dlHead] = x;
    this._dlHead = (this._dlHead + 1) % N;

    // Dot-product: h[0] * x (newest) + h[1] * x-1 + ...
    let out = 0;
    for (let k = 0; k < N; k++) {
      const idx = (this._dlHead - 1 - k + N * 2) % N;
      out += this._fir[k] * dl[idx];
    }
    return out;
  }

  // ---- Write one output sample, flushing when full -------------------------

  _pushOutput(sample) {
    this._accum[this._accumPos++] = sample;
    if (this._accumPos === 1280) {
      const block = this._accum;
      this._accum = new Float32Array(1280);
      this.port.postMessage(
        { type: 'block', samples: block, frameStart: this._blockStart },
        [block.buffer],
      );
      this._totalFrames += 1280;
      this._blockStart = this._totalFrames;
      this._accumPos = 0;
    }
  }

  // ---- AudioWorkletProcessor entry point -----------------------------------

  process(inputs, _outputs, _parameters) {
    const ch = inputs[0]?.[0];
    if (!ch || ch.length === 0) return true;

    this._quantaCount++;

    // Accumulate level stats for this quantum
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i]);
      if (v > this._levelPeak) this._levelPeak = v;
      this._levelSumSq += ch[i] * ch[i];
    }
    this._levelCount += ch.length;

    // Publish on quantum 1 and every 8 quanta after — avoids dead-loop appearance (SPEC note)
    if (this._quantaCount === 1 || this._quantaCount % 8 === 0) {
      const rms = this._levelCount > 0 ? Math.sqrt(this._levelSumSq / this._levelCount) : 0;
      this.port.postMessage({ type: 'level', peak: this._levelPeak, rms });
      this._levelPeak = 0;
      this._levelSumSq = 0;
      this._levelCount = 0;
    }

    if (this._passthrough) {
      // Context is already at 16 kHz — copy directly
      for (let i = 0; i < ch.length; i++) {
        this._pushOutput(ch[i]);
      }
    } else {
      // FIR anti-alias + fractional decimation with linear interpolation
      for (let i = 0; i < ch.length; i++) {
        const firOut = this._applyFIR(ch[i]);

        // Emit output sample(s) whose target position has been reached
        while (this._phase <= this._inputIdx) {
          // Linear interpolation between lastFirOut (at inputIdx-1) and firOut (at inputIdx)
          // When inputIdx === 0 the formula gives frac = 1.0, correctly using firOut only.
          const frac = Math.max(0, Math.min(1, this._phase - (this._inputIdx - 1)));
          const out = this._lastFirOut * (1 - frac) + firOut * frac;
          this._pushOutput(out);
          this._phase += this._ratio;
        }

        this._lastFirOut = firOut;
        this._inputIdx++;
      }
    }

    return true; // keep processor alive
  }
}

registerProcessor('voice-capture', VoiceCapture);

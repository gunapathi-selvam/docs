// Optional microphone reactivity. Off by default; audio is analysed in-browser
// and never leaves the machine, exactly like the video path.

export class AudioReactor {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.bins = null;
    this.stream = null;
    this.running = false;
    this.level = 0;
  }

  static get supported() {
    return typeof (globalThis.AudioContext ?? globalThis.webkitAudioContext) === 'function';
  }

  async start() {
    if (this.running) return;
    const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!Ctor) throw new Error('Web Audio unavailable');

    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this.ctx = new Ctor();
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.72;
    this.ctx.createMediaStreamSource(this.stream).connect(this.analyser);
    this.bins = new Uint8Array(this.analyser.frequencyBinCount);
    this.running = true;
  }

  stop() {
    this.running = false;
    this.level = 0;
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.analyser = null;
  }

  /** 0..1, weighted toward the low-mid bands where rhythm actually lives. */
  sample() {
    if (!this.running || !this.analyser) return 0;
    this.analyser.getByteFrequencyData(this.bins);

    const n = Math.min(this.bins.length, 96);
    let sum = 0, weight = 0;
    for (let i = 0; i < n; i++) {
      const w = 1 - (i / n) * 0.7;
      sum += (this.bins[i] / 255) * w;
      weight += w;
    }
    const raw = weight > 0 ? sum / weight : 0;
    // Expand the useful part of the range; room tone rarely clears ~0.06.
    const shaped = Math.min(1, Math.max(0, (raw - 0.06) / 0.5));
    this.level += (shaped - this.level) * 0.3;
    return this.level;
  }
}

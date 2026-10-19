// Tiny WebAudio synthesiser: no audio files, nothing to license or download.
// The AudioContext is only created/resumed from a user gesture (browser autoplay rules).
export class AudioFX {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
    this.lastTick = 0;
  }

  unlock() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.45;
        this.master.connect(this.ctx.destination);
        const len = Math.floor(this.ctx.sampleRate * 0.8);
        this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = this.noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch (e) { /* audio is optional */ }
  }

  get ready() { return !!(this.ctx && this.settings.sound && this.ctx.state === 'running'); }

  tone(freq, endFreq, dur, type = 'square', vol = 0.2, delay = 0) {
    if (!this.ready) return;
    const t0 = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (endFreq) o.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(this.master);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }

  noise(dur, vol = 0.3, cutoff = 1200, delay = 0) {
    if (!this.ready) return;
    const t0 = this.ctx.currentTime + delay;
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(cutoff, t0);
    f.frequency.exponentialRampToValueAtTime(100, t0 + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(t0, 0, dur + 0.05);
  }

  place() { this.tone(260, 420, 0.12, 'triangle', 0.25); }
  tick() {
    const now = performance.now();
    if (now - this.lastTick < 110) return;
    this.lastTick = now;
    this.tone(1100, 900, 0.04, 'square', 0.07);
  }
  explosion() { this.noise(0.6, 0.55, 1600); this.tone(110, 38, 0.5, 'sawtooth', 0.28); }
  crate() { this.noise(0.18, 0.25, 4000); }
  pickup() { this.tone(520, 520, 0.08, 'triangle', 0.22); this.tone(780, 780, 0.08, 'triangle', 0.22, 0.08); this.tone(1040, 1040, 0.14, 'triangle', 0.22, 0.16); }
  shield() { this.tone(900, 300, 0.25, 'sine', 0.25); }
  slip() { this.tone(700, 160, 0.4, 'sine', 0.22); }
  kick() { this.tone(180, 90, 0.1, 'square', 0.2); }
  elim() { this.tone(440, 70, 0.7, 'sawtooth', 0.25); }
  beep(high) { this.tone(high ? 880 : 520, high ? 880 : 520, high ? 0.35 : 0.14, 'square', 0.2); }
  win() { [523, 659, 784, 1046].forEach((f, i) => this.tone(f, f, 0.22, 'triangle', 0.25, i * 0.14)); }
  lose() { this.tone(330, 220, 0.5, 'triangle', 0.22); }
  ui() { this.tone(640, 640, 0.05, 'triangle', 0.12); }
}

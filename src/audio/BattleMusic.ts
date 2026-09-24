// The Warden's fight music, made on the spot: a driving 132 bpm piece in A minor
// (Am - F - G - E) built in layers that come in as the fight heats up.
//
//   intensity 0.0+  a low pad and a pulsing sub bass (the machine asleep)
//             0.35+ kick on the beat
//             0.45+ closed hats in eighths
//             0.55+ snare on two and four, the bass line starts moving
//             0.75+ four on the floor, sixteenth hats, a synth arpeggio
//             0.85+ offbeat stabs (overdrive)
//
// Notes are scheduled a little ahead on the audio clock, so the beat never drifts
// with the frame rate; `update` only moves the intensity and keeps the queue full.

const BPM = 132;
const STEP = 60 / BPM / 4;
const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
/** Chords per bar: root (bass, MIDI) and the triad above. */
const BARS: { root: number; chord: number[] }[] = [
  { root: 33, chord: [57, 60, 64] }, // Am
  { root: 29, chord: [53, 57, 60] }, // F
  { root: 31, chord: [55, 59, 62] }, // G
  { root: 28, chord: [56, 59, 64] }, // E
];
/** The bass line over one bar (semitones above the root, -1 rest). */
const BASS = [0, -1, 0, 12, 0, -1, 7, 0, 0, -1, 0, 12, 3, -1, 7, 5];
/** The arpeggio over one bar (index into the chord, octave up at +3). */
const ARP = [0, 1, 2, 3, 2, 1, 0, 1, 0, 2, 3, 5, 3, 2, 1, 2];

export class BattleMusic {
  private readonly out: GainNode;
  private readonly padGain: GainNode;
  private readonly padFilter: BiquadFilterNode;
  private readonly padOsc: OscillatorNode[] = [];
  private nextT = 0;
  private step = 0;
  private level = 0;
  private intensity = 0;
  private running = false;

  constructor(private readonly ctx: AudioContext, private readonly noise: AudioBuffer, dest: AudioNode) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(dest);
    // the pad: detuned saws on the bar's chord, through a filter that opens with the intensity
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 500;
    this.padFilter.Q.value = 0.6;
    this.padGain = ctx.createGain();
    this.padGain.gain.value = 0.05;
    this.padFilter.connect(this.padGain).connect(this.out);
    for (let i = 0; i < 6; i++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = mtof(BARS[0].chord[i % 3]);
      o.detune.value = (i < 3 ? -1 : 1) * 9;
      const g = ctx.createGain(); g.gain.value = 0.12;
      o.connect(g).connect(this.padFilter);
      this.padOsc.push(o);
    }
  }

  update(dt: number, intensity: number, on: boolean) {
    const ctx = this.ctx;
    if (on && !this.running) {
      this.running = true;
      for (const o of this.padOsc) { try { o.start(); } catch { /* already started */ } }
      this.nextT = ctx.currentTime + 0.1;
    }
    if (!this.running) return;
    this.level += ((on ? 1 : 0) - this.level) * Math.min(1, dt * (on ? 0.8 : 1.5));
    this.intensity += (intensity - this.intensity) * Math.min(1, dt * 1.2);
    const t = ctx.currentTime;
    this.out.gain.setTargetAtTime(this.level * 0.55, t, 0.2);
    this.padFilter.frequency.setTargetAtTime(420 + this.intensity * 1800, t, 0.4);
    this.padGain.gain.setTargetAtTime(0.035 + this.intensity * 0.03, t, 0.4);
    if (this.level < 0.002) return;
    // keep the queue a little ahead of the clock (and never pile up after a stall)
    if (this.nextT < t - 0.2) this.nextT = t + 0.05;
    while (this.nextT < t + 0.16) { this.play(this.step, this.nextT); this.step++; this.nextT += STEP; }
  }

  private play(n: number, at: number) {
    const k = this.intensity;
    const s = n % 16, bar = BARS[Math.floor(n / 16) % BARS.length];
    // the pad moves to the new chord on the bar
    if (s === 0) this.padOsc.forEach((o, i) => o.frequency.setTargetAtTime(mtof(bar.chord[i % 3] - 12), at, 0.08));
    // sub bass: a pulse on the beat while quiet, the full line once it gets going
    const b = BASS[s];
    if (k < 0.55 ? s % 4 === 0 : b >= 0) this.bass(at, mtof(bar.root + (k < 0.55 ? 0 : b)), k < 0.55 ? 0.28 : 0.16);
    // drums
    if (k > 0.35 && (s === 0 || s === 8 || (k > 0.75 && s % 4 === 0))) this.kick(at);
    if (k > 0.55 && (s === 4 || s === 12)) this.snare(at);
    if (k > 0.45 && (s % 2 === 0 || k > 0.75)) this.hat(at, s % 4 === 2 ? 0.05 : 0.03);
    // the arpeggio and the stabs
    if (k > 0.75) {
      const i = ARP[s];
      this.pluck(at, mtof(bar.chord[i % 3] + (i >= 3 ? 12 : 0) + 12), 0.035);
    }
    if (k > 0.85 && (s === 3 || s === 6 || s === 11 || s === 14)) for (const c of bar.chord) this.stab(at, mtof(c), 0.02);
  }

  // ------------------------------------------------------------------ voices

  private env(at: number, gain: number, attack: number, decay: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    g.connect(this.out);
    return g;
  }

  private osc(type: OscillatorType, f0: number, f1: number, at: number, dur: number, dest: AudioNode) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, at);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, at + dur);
    o.connect(dest);
    o.start(at);
    o.stop(at + dur + 0.05);
  }

  private noiseBurst(at: number, type: BiquadFilterType, freq: number, dur: number, dest: AudioNode) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq;
    src.connect(f).connect(dest);
    src.start(at, Math.random() * 1.5);
    src.stop(at + dur + 0.05);
  }

  private kick(at: number) {
    this.osc('sine', 150, 42, at, 0.22, this.env(at, 0.55, 0.004, 0.24));
  }

  private snare(at: number) {
    this.noiseBurst(at, 'bandpass', 1900, 0.16, this.env(at, 0.22, 0.003, 0.16));
    this.osc('triangle', 210, 160, at, 0.1, this.env(at, 0.12, 0.003, 0.1));
  }

  private hat(at: number, gain: number) {
    this.noiseBurst(at, 'highpass', 7200, 0.04, this.env(at, gain, 0.002, 0.04));
  }

  private bass(at: number, f: number, gain: number) {
    const g = this.env(at, gain, 0.005, STEP * 1.6);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(260 + this.intensity * 500, at);
    lp.connect(g);
    this.osc('sawtooth', f, f, at, STEP * 1.7, lp);
    this.osc('sine', f / 2, f / 2, at, STEP * 1.7, g);
  }

  private pluck(at: number, f: number, gain: number) {
    const g = this.env(at, gain, 0.003, 0.14);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(3000, at);
    lp.frequency.exponentialRampToValueAtTime(700, at + 0.14);
    lp.connect(g);
    this.osc('square', f, f, at, 0.16, lp);
  }

  private stab(at: number, f: number, gain: number) {
    const g = this.env(at, gain, 0.004, 0.1);
    this.osc('sawtooth', f, f, at, 0.12, g);
  }
}

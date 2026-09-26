// Speedster Battle, heard: made on the spot like every other sound in the game.
//
// Under the race run three layers that follow your speed: a rush of air (band
// noise that climbs and opens as you go), an energy hum (two detuned oscillators
// whose pitch rises with your speed, like a turbine spooling up), and a cosmic
// pad (a slow suspended chord that opens its filter as you fly). Over them: a
// tick for every stride (the left button a little lower than the right, brighter
// the faster you go), a dull thud for a click on the same button again (it did
// not count), a whoosh and a shimmer each time you cross into a new speed tier,
// the throw of a kicker, a chime through each checkpoint ring, the rush of a
// rival going past, the rift tearing open in the arena, and the finish.

import type * as THREE from 'three';
import type { AudioEngine } from './Audio';

/** The pad's chord (Hz): a suspended, open voicing that never quite resolves. */
const PAD = [110, 164.81, 246.94, 329.63];

export class RaceSounds {
  private readonly rushGain: GainNode;
  private readonly rushFilter: BiquadFilterNode;
  private readonly hissGain: GainNode;
  private readonly humGain: GainNode;
  private readonly humFilter: BiquadFilterNode;
  private readonly hum: OscillatorNode[] = [];
  private readonly padGain: GainNode;
  private readonly padFilter: BiquadFilterNode;

  constructor(private readonly a: AudioEngine) {
    const ctx = a.ctx!;
    // the rush of air
    const rush = ctx.createBufferSource();
    rush.buffer = a.noise; rush.loop = true;
    this.rushFilter = ctx.createBiquadFilter(); this.rushFilter.type = 'bandpass'; this.rushFilter.Q.value = 0.7; this.rushFilter.frequency.value = 500;
    this.rushGain = ctx.createGain(); this.rushGain.gain.value = 0;
    rush.connect(this.rushFilter).connect(this.rushGain).connect(a.sfx);
    const hiss = ctx.createBufferSource();
    hiss.buffer = a.noise; hiss.loop = true; hiss.playbackRate.value = 1.3;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 5200;
    this.hissGain = ctx.createGain(); this.hissGain.gain.value = 0;
    hiss.connect(hp).connect(this.hissGain).connect(a.sfx);
    rush.start(); hiss.start();
    // the energy hum
    this.humFilter = ctx.createBiquadFilter(); this.humFilter.type = 'lowpass'; this.humFilter.frequency.value = 300; this.humFilter.Q.value = 2;
    this.humGain = ctx.createGain(); this.humGain.gain.value = 0;
    this.humFilter.connect(this.humGain).connect(a.sfx);
    for (const [type, det] of [['sawtooth', -7], ['triangle', 5]] as const) {
      const o = ctx.createOscillator();
      o.type = type; o.frequency.value = 55; o.detune.value = det;
      o.connect(this.humFilter);
      o.start();
      this.hum.push(o);
    }
    // the cosmic pad
    this.padFilter = ctx.createBiquadFilter(); this.padFilter.type = 'lowpass'; this.padFilter.frequency.value = 500;
    this.padGain = ctx.createGain(); this.padGain.gain.value = 0;
    this.padFilter.connect(this.padGain).connect(a.music);
    PAD.forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = i % 2 ? 'triangle' : 'sine';
      o.frequency.value = f;
      const lfo = ctx.createOscillator(), lg = ctx.createGain();
      lfo.frequency.value = 0.07 + i * 0.03; lg.gain.value = 3 + i;
      lfo.connect(lg).connect(o.detune);
      const g = ctx.createGain(); g.gain.value = 0.25 / (1 + i * 0.4);
      o.connect(g).connect(this.padFilter);
      o.start(); lfo.start();
    });
  }

  private get ctx() { return this.a.ctx!; }

  /** Every frame: `k` how fast you are going (0..1); `on`: racing (false fades it all out). */
  update(k: number, on: boolean) {
    const t = this.ctx.currentTime;
    const g = on ? 1 : 0;
    this.rushGain.gain.setTargetAtTime((0.03 + k * 0.26) * g, t, 0.12);
    this.rushFilter.frequency.setTargetAtTime(420 + k * 2600, t, 0.15);
    this.hissGain.gain.setTargetAtTime(Math.max(0, k - 0.55) * 0.12 * g, t, 0.2);
    this.humGain.gain.setTargetAtTime((0.015 + k * 0.05) * g, t, 0.15);
    for (const o of this.hum) o.frequency.setTargetAtTime(48 + k * 120, t, 0.12);
    this.humFilter.frequency.setTargetAtTime(220 + k * 1400, t, 0.15);
    this.padGain.gain.setTargetAtTime(0.07 * g, t, 1.2);
    this.padFilter.frequency.setTargetAtTime(380 + k * 2400, t, 0.8);
  }

  /** A counted stride: a tick, the left button a little lower than the right, brighter with speed. */
  stride(side: number, k: number) {
    const A = this.a, d = A.sfx;
    const f = side ? 720 : 560;
    A.tone(d, { type: 'triangle', f0: f * (1 + k * 0.35), f1: f * 0.8, gain: 0.05 + k * 0.03, decay: 0.05, vary: 0.04, lp: 1800 + k * 4000 });
    A.noiseHit(d, { type: 'bandpass', freq: 2400 + k * 2400, q: 2.2, gain: 0.04 + k * 0.03, decay: 0.03, vary: 0.1 });
  }

  /** The same button twice: a dull thud (it did not count). */
  miss() {
    this.a.tone(this.a.sfx, { type: 'sine', f0: 190, f1: 120, gain: 0.07, decay: 0.08 });
  }

  /** Crossing into a faster tier (1..3): a whoosh up and a shimmer. */
  tier(n: number) {
    const A = this.a, d = A.sfx;
    A.noiseHit(d, { type: 'bandpass', freq: 600, freqEnd: 4200 + n * 800, q: 1, gain: 0.16 + n * 0.04, attack: 0.05, decay: 0.45 });
    [1, 1.5, 2].forEach((m, i) => A.tone(d, { type: 'sine', f0: 440 * (1 + n * 0.25) * m, gain: 0.03, attack: 0.02, decay: 0.6, delay: i * 0.05 }));
  }

  /** Thrown off a kicker. */
  kick(k: number) {
    const A = this.a, d = A.sfx;
    A.noiseHit(d, { type: 'bandpass', freq: 500, freqEnd: 2600, q: 0.9, gain: 0.22 + k * 0.1, attack: 0.02, decay: 0.5 });
    A.tone(d, { type: 'sine', f0: 180, f1: 420, gain: 0.08, decay: 0.35 });
  }

  /** Through a checkpoint ring (`mine`: the local runner's own, `pos`: someone else's). */
  ring(i: number, pos: THREE.Vector3 | null) {
    const s = this.a.spatial(pos, 120);
    if (!s) return;
    const root = 523.25 * Math.pow(2, (i % 5) / 12 * 2);
    [1, 1.25, 1.5].forEach((m, j) => this.a.tone(s.dest, { type: 'triangle', f0: root * m, gain: 0.05 * s.gain, attack: 0.005, decay: 0.7, delay: j * 0.045 }));
  }

  /** A rival goes past (or you go past it) close by. */
  pass(pos: THREE.Vector3) {
    const s = this.a.spatial(pos, 40);
    if (!s) return;
    this.a.noiseHit(s.dest, { type: 'bandpass', freq: 2600, freqEnd: 700, q: 1.2, gain: 0.3 * s.gain, attack: 0.04, decay: 0.45 });
  }

  /** The Warden's rift tears open. */
  rift(pos: THREE.Vector3) {
    const s = this.a.spatial(pos, 200);
    const d = s ? s.dest : this.a.sfx, g = s ? s.gain : 1;
    this.a.tone(d, { type: 'sine', f0: 40, f1: 90, gain: 0.5 * g, attack: 0.6, decay: 2.4 });
    this.a.noiseHit(d, { type: 'bandpass', freq: 200, freqEnd: 3400, q: 0.8, gain: 0.3 * g, attack: 0.8, decay: 1.6 });
    PAD.forEach((f, i) => this.a.tone(d, { type: 'triangle', f0: f * 2, gain: 0.04 * g, attack: 0.4, decay: 2.2, delay: 0.3 + i * 0.12 }));
  }

  /** Over the line: a bright rising chord. */
  finish(place: number) {
    const A = this.a, d = A.music;
    const chord = place === 1 ? [523.25, 659.25, 783.99, 1046.5] : [440, 554.37, 659.25, 880];
    chord.forEach((f, i) => A.tone(d, { type: 'triangle', f0: f, gain: 0.07, attack: 0.02, decay: 1.6, delay: i * 0.07 }));
    A.noiseHit(A.sfx, { type: 'bandpass', freq: 3000, freqEnd: 500, q: 0.8, gain: 0.25, attack: 0.02, decay: 0.9 });
  }

  /** The speed tier a speed (m/s) is in, with a little hysteresis around `prev`. */
  static tierOf(speed: number, prev: number): number {
    const edges = [25, 45, 65];
    let n = 0;
    for (let i = 0; i < edges.length; i++) if (speed >= edges[i] - (prev > i ? 3 : 0)) n = i + 1;
    return n;
  }
}

// The Warden's fight, heard: made on the spot like every other sound in the game.
//
// Three families. The machine: footfalls you feel more than hear, hydraulics,
// the whine of the eye charging, cannons, sirens, the groan when it staggers and
// the long collapse when it falls. The powers: each has its own voice (a thump
// with a crack for kinetic, a glassy pull for telekinesis, dry zaps for
// lightning, a sub drop for gravity, a tearing rush for speed, a shimmering
// split for duplication, and a grinding crack as a kinetic runner tears a slab
// out of the floor). And the fight around them: metal ringing where hits land, a tick
// for your own hits, bots, orbs, explosions, the storm. Under it all runs the
// battle music (BattleMusic), driven by how hard the fight is going.

import * as THREE from 'three';
import type { AudioEngine } from './Audio';
import { BattleMusic } from './BattleMusic';

/** Pitch (Hz) of each power's little arpeggio when it is chosen. */
const PICK_ROOT = [196, 261.6, 329.6, 146.8, 392, 293.7];

export class ArenaSounds {
  private readonly battle: BattleMusic;
  // the beam's hum and the storm's bed
  private beamGain: GainNode | null = null;
  private beamPan: StereoPannerNode | null = null;
  private beamFilter: BiquadFilterNode | null = null;
  private stormGain: GainNode | null = null;
  private stormOn = 0;

  constructor(private readonly a: AudioEngine) {
    this.battle = new BattleMusic(a.ctx!, a.noise, a.music);
  }

  private get ctx() { return this.a.ctx!; }

  /** Where a sound at `pos` goes (null: too far to hear). */
  private at(pos: THREE.Vector3 | null, range = 70) { return this.a.spatial(pos, range); }

  // ------------------------------------------------------------------ the powers

  power(kind: string, pos: THREE.Vector3 | null, k = 1) {
    const s = this.at(pos, 60);
    if (!s) return;
    const d = s.dest, g = s.gain * k, A = this.a;
    switch (kind) {
      case 'punch':
        A.tone(d, { type: 'sine', f0: 170, f1: 48, gain: 0.42 * g, decay: 0.2, vary: 0.08 });
        A.noiseHit(d, { type: 'lowpass', freq: 1400, freqEnd: 300, gain: 0.34 * g, decay: 0.16, vary: 0.1 });
        A.noiseHit(d, { type: 'highpass', freq: 3200, gain: 0.1 * g, decay: 0.04 });
        break;
      case 'slamDive':
        A.noiseHit(d, { type: 'bandpass', freq: 500, freqEnd: 2600, q: 1.2, gain: 0.22 * g, attack: 0.12, decay: 0.3 });
        break;
      case 'slam':
        A.tone(d, { type: 'sine', f0: 110, f1: 28, gain: 0.7 * g, decay: 0.7 });
        A.noiseHit(d, { type: 'lowpass', freq: 700, freqEnd: 120, gain: 0.55 * g, decay: 0.8 });
        A.noiseHit(d, { type: 'highpass', freq: 2200, gain: 0.2 * g, decay: 0.09 });
        break;
      case 'grab':
        A.tone(d, { type: 'sine', f0: 320, f1: 760, gain: 0.12 * g, decay: 0.22 });
        A.tone(d, { type: 'triangle', f0: 1280, f1: 1900, gain: 0.04 * g, decay: 0.3, delay: 0.03 });
        break;
      case 'throw':
        A.noiseHit(d, { type: 'bandpass', freq: 1800, freqEnd: 420, q: 1.4, gain: 0.3 * g, attack: 0.02, decay: 0.3 });
        A.tone(d, { type: 'sine', f0: 700, f1: 180, gain: 0.08 * g, decay: 0.25 });
        break;
      case 'push':
        A.noiseHit(d, { type: 'bandpass', freq: 900, freqEnd: 200, q: 0.9, gain: 0.3 * g, attack: 0.02, decay: 0.4 });
        A.tone(d, { type: 'sine', f0: 140, f1: 60, gain: 0.2 * g, decay: 0.3 });
        A.tone(d, { type: 'triangle', f0: 880, f1: 1320, gain: 0.03 * g, decay: 0.3 });
        break;
      case 'bolt':
        A.noiseHit(d, { type: 'highpass', freq: 2600, gain: 0.16 * g, decay: 0.07, vary: 0.2 });
        A.tone(d, { type: 'square', f0: 2200, f1: 260, gain: 0.045 * g, decay: 0.07, lp: 5000, vary: 0.15 });
        break;
      case 'overheat':
        A.tone(d, { type: 'sawtooth', f0: 900, f1: 180, gain: 0.08 * g, decay: 0.6, lp: 2400 });
        A.noiseHit(d, { type: 'highpass', freq: 3000, gain: 0.08 * g, attack: 0.05, decay: 0.8 });
        break;
      case 'wellThrow':
        A.tone(d, { type: 'sine', f0: 260, f1: 70, gain: 0.2 * g, decay: 0.4 });
        A.noiseHit(d, { type: 'lowpass', freq: 600, gain: 0.12 * g, decay: 0.3 });
        break;
      case 'wellOpen':
        A.tone(d, { type: 'sine', f0: 60, f1: 32, gain: 0.5 * g, attack: 0.05, decay: 1.4 });
        A.noiseHit(d, { type: 'bandpass', freq: 200, freqEnd: 1400, q: 1.5, gain: 0.2 * g, attack: 0.4, decay: 0.5 });
        break;
      case 'flash':
        A.noiseHit(d, { type: 'bandpass', freq: 3400, freqEnd: 700, q: 0.9, gain: 0.34 * g, decay: 0.22 });
        A.tone(d, { type: 'sine', f0: 1400, f1: 260, gain: 0.1 * g, decay: 0.2 });
        A.tone(d, { type: 'sine', f0: 80, f1: 40, gain: 0.25 * g, decay: 0.25 });
        break;
      case 'rip':
        // concrete tearing: a low crack, grinding grit, a thump as it comes free
        A.noiseHit(d, { type: 'lowpass', freq: 900, freqEnd: 250, gain: 0.45 * g, attack: 0.01, decay: 0.35 });
        A.noiseHit(d, { type: 'bandpass', freq: 2600, q: 1.5, gain: 0.18 * g, decay: 0.25, rate: 0.6 });
        A.tone(d, { type: 'sine', f0: 80, f1: 40, gain: 0.35 * g, decay: 0.3, delay: 0.12 });
        break;
      case 'hurl':
        A.noiseHit(d, { type: 'bandpass', freq: 500, freqEnd: 1600, q: 1, gain: 0.3 * g, attack: 0.03, decay: 0.3 });
        A.tone(d, { type: 'sine', f0: 150, f1: 70, gain: 0.3 * g, decay: 0.25 });
        break;
      case 'split':
        // a shimmer that splits in two, like a chord coming apart
        A.tone(d, { type: 'sine', f0: 660, f1: 520, gain: 0.08 * g, decay: 0.35 });
        A.tone(d, { type: 'sine', f0: 660, f1: 840, gain: 0.08 * g, decay: 0.35 });
        A.noiseHit(d, { type: 'bandpass', freq: 3000, freqEnd: 900, q: 2, gain: 0.12 * g, attack: 0.02, decay: 0.25 });
        break;
      case 'cloneOut':
        A.noiseHit(d, { type: 'highpass', freq: 2200, gain: 0.2 * g, decay: 0.2 });
        [880, 740, 587].forEach((f, i) => A.tone(d, { type: 'triangle', f0: f, gain: 0.05 * g, decay: 0.2, delay: i * 0.05 }));
        break;
      case 'cloneHit':
        A.tone(d, { type: 'sine', f0: 240, f1: 90, gain: 0.18 * g, decay: 0.12, vary: 0.1 });
        A.noiseHit(d, { type: 'bandpass', freq: 1800, q: 1.5, gain: 0.1 * g, decay: 0.07, vary: 0.2 });
        break;
      case 'rally':
        [440, 554, 659, 880].forEach((f, i) => A.tone(d, { type: 'sawtooth', f0: f, gain: 0.04 * g, decay: 0.3, delay: i * 0.04, lp: 2500 }));
        A.noiseHit(d, { type: 'bandpass', freq: 800, freqEnd: 2400, q: 1, gain: 0.18 * g, attack: 0.05, decay: 0.3 });
        break;
    }
  }

  // ------------------------------------------------------------------ getting there, coming back

  /** The beacon tears open. */
  gate() {
    const A = this.a;
    A.noiseHit(A.sfx, { type: 'bandpass', freq: 200, freqEnd: 3000, q: 0.8, gain: 0.35, attack: 1.8, decay: 0.8 });
    A.tone(A.sfx, { type: 'sine', f0: 45, f1: 90, gain: 0.4, attack: 1.5, decay: 1.2 });
    A.tone(A.sfx, { type: 'sawtooth', f0: 110, f1: 220, gain: 0.05, attack: 2.0, decay: 0.6, lp: 1200 });
  }

  /** The light takes everyone. */
  swallow() {
    const A = this.a;
    A.noiseHit(A.sfx, { type: 'highpass', freq: 800, gain: 0.35, attack: 0.3, decay: 0.9 });
    A.tone(A.sfx, { type: 'sine', f0: 880, f1: 1760, gain: 0.08, attack: 0.3, decay: 0.8 });
  }

  /** Arriving in the arena: a boom, and the storm all round. */
  arrive() {
    const A = this.a;
    A.tone(A.sfx, { type: 'sine', f0: 70, f1: 28, gain: 0.6, decay: 1.6 });
    A.noiseHit(A.sfx, { type: 'lowpass', freq: 300, gain: 0.4, attack: 0.02, decay: 2.2, rate: 0.5 });
    [440, 554, 659].forEach((f, i) => A.tone(A.sfx, { type: 'sine', f0: f, gain: 0.04, attack: 0.05, decay: 1.4, delay: 0.2 + i * 0.08 }));
  }

  /** A power chosen: a little rising figure in its own key. */
  pick(k: number) {
    const A = this.a, r = PICK_ROOT[k % PICK_ROOT.length];
    [1, 1.26, 1.5, 2].forEach((m, i) => A.tone(A.sfx, { type: 'triangle', f0: r * m, gain: 0.08, attack: 0.01, decay: 0.35, delay: i * 0.06 }));
    A.noiseHit(A.sfx, { type: 'bandpass', freq: 1200, freqEnd: 4000, q: 1, gain: 0.1, attack: 0.05, decay: 0.3 });
  }

  respawn() {
    const A = this.a;
    [392, 523, 659, 784].forEach((f, i) => A.tone(A.sfx, { type: 'sine', f0: f, gain: 0.06, attack: 0.02, decay: 0.5, delay: i * 0.05 }));
    A.noiseHit(A.sfx, { type: 'bandpass', freq: 600, freqEnd: 3000, q: 1, gain: 0.15, attack: 0.1, decay: 0.3 });
  }

  // ------------------------------------------------------------------ the machine

  roar(pos: THREE.Vector3, k = 1) {
    const s = this.at(pos, 200);
    if (!s) return;
    const A = this.a, g = Math.max(0.5, s.gain) * k;
    A.tone(s.dest, { type: 'sawtooth', f0: 70, f1: 42, gain: 0.35 * g, attack: 0.2, decay: 1.6, lp: 500 });
    A.tone(s.dest, { type: 'sawtooth', f0: 104, f1: 60, gain: 0.2 * g, attack: 0.25, decay: 1.4, lp: 800 });
    A.noiseHit(s.dest, { type: 'bandpass', freq: 400, freqEnd: 180, q: 1.4, gain: 0.35 * g, attack: 0.3, decay: 1.5 });
  }

  /** An ability's tell: what you hear before it happens. */
  tell(kind: string, pos: THREE.Vector3) {
    const s = this.at(pos, 160);
    if (!s) return;
    const A = this.a, d = s.dest, g = Math.max(0.45, s.gain);
    switch (kind) {
      case 'stomp':
        A.noiseHit(d, { type: 'bandpass', freq: 2400, freqEnd: 900, q: 2, gain: 0.18 * g, attack: 0.3, decay: 0.5 });
        A.tone(d, { type: 'sawtooth', f0: 80, f1: 160, gain: 0.12 * g, attack: 0.5, decay: 0.3, lp: 600 });
        break;
      case 'beam':
        A.tone(d, { type: 'sine', f0: 260, f1: 1500, gain: 0.14 * g, attack: 1.0, decay: 0.12 });
        A.tone(d, { type: 'sawtooth', f0: 130, f1: 750, gain: 0.05 * g, attack: 1.0, decay: 0.1, lp: 2000 });
        break;
      case 'mortar':
        [0, 0.18].forEach((dl) => A.tone(d, { type: 'square', f0: 740, gain: 0.05 * g, decay: 0.1, delay: dl, lp: 2500 }));
        A.noiseHit(d, { type: 'lowpass', freq: 900, gain: 0.2 * g, decay: 0.2, delay: 0.3 });
        break;
      case 'deploy':
        [0, 0.22, 0.44].forEach((dl, i) => A.tone(d, { type: 'square', f0: i % 2 ? 520 : 690, gain: 0.05 * g, decay: 0.18, delay: dl, lp: 2200 }));
        A.noiseHit(d, { type: 'bandpass', freq: 1200, q: 3, gain: 0.12 * g, attack: 0.05, decay: 0.6 });
        break;
      case 'charge':
        A.tone(d, { type: 'sawtooth', f0: 48, f1: 130, gain: 0.3 * g, attack: 0.8, decay: 0.4, lp: 700 });
        this.roar(pos, 0.7);
        break;
      case 'swipe':
        A.tone(d, { type: 'sawtooth', f0: 500, f1: 1300, gain: 0.05 * g, attack: 0.4, decay: 0.2, lp: 3000 });
        A.noiseHit(d, { type: 'bandpass', freq: 600, freqEnd: 2200, q: 1.2, gain: 0.25 * g, attack: 0.5, decay: 0.25 });
        break;
      case 'shock':
        for (let i = 0; i < 6; i++) A.noiseHit(d, { type: 'highpass', freq: 3000 + Math.random() * 2000, gain: 0.08 * g, decay: 0.05, delay: i * 0.11 + Math.random() * 0.05 });
        A.tone(d, { type: 'sawtooth', f0: 60, f1: 180, gain: 0.08 * g, attack: 0.7, decay: 0.1, lp: 1500 });
        break;
    }
  }

  /** A footfall of the Warden. */
  step(p: THREE.Vector3, k: number) {
    const s = this.at(p, 110);
    if (!s) return;
    const A = this.a, g = s.gain * k;
    A.tone(s.dest, { type: 'sine', f0: 58, f1: 30, gain: 0.55 * g, decay: 0.4, vary: 0.06 });
    A.noiseHit(s.dest, { type: 'lowpass', freq: 260, gain: 0.3 * g, decay: 0.35 });
    A.noiseHit(s.dest, { type: 'bandpass', freq: 1800, q: 3, gain: 0.05 * g, decay: 0.1, delay: 0.02 });
  }

  stagger(pos: THREE.Vector3) {
    const s = this.at(pos, 200);
    if (!s) return;
    const A = this.a, g = Math.max(0.6, s.gain);
    A.tone(s.dest, { type: 'sawtooth', f0: 95, f1: 38, gain: 0.3 * g, attack: 0.05, decay: 1.3, lp: 700 });
    A.noiseHit(s.dest, { type: 'bandpass', freq: 1400, freqEnd: 400, q: 4, gain: 0.25 * g, decay: 0.9 });
    [0, 0.25, 0.45].forEach((dl) => A.tone(s.dest, { type: 'triangle', f0: 300 + Math.random() * 200, gain: 0.08 * g, decay: 0.3, delay: dl }));
  }

  overdrive(pos: THREE.Vector3) {
    const A = this.a;
    for (let i = 0; i < 4; i++) A.tone(A.sfx, { type: 'square', f0: i % 2 ? 620 : 830, gain: 0.07, decay: 0.28, delay: i * 0.3, lp: 2400 });
    this.roar(pos, 1.3);
  }

  /** It is down: a long collapse. */
  fall(pos: THREE.Vector3) {
    const A = this.a;
    this.roar(pos, 1.4);
    A.tone(A.sfx, { type: 'sine', f0: 50, f1: 22, gain: 0.7, attack: 0.1, decay: 3.2 });
    A.noiseHit(A.sfx, { type: 'lowpass', freq: 400, freqEnd: 80, gain: 0.5, attack: 0.2, decay: 3.5, rate: 0.5 });
    // and the win, a moment later
    [523.3, 659.3, 784, 1046.5, 1318.5].forEach((f, i) => {
      A.tone(A.sfx, { type: 'triangle', f0: f, gain: 0.1, attack: 0.02, decay: 1.8, delay: 2.2 + i * 0.12 });
      A.tone(A.sfx, { type: 'sine', f0: f * 2, gain: 0.03, attack: 0.02, decay: 1.2, delay: 2.22 + i * 0.12 });
    });
  }

  // ------------------------------------------------------------------ hits

  /** Your hit landed. */
  hitConfirm(crit: boolean) {
    const A = this.a;
    A.tone(A.sfx, { type: 'triangle', f0: crit ? 2400 : 1700, gain: crit ? 0.1 : 0.06, decay: 0.05 });
    if (crit) A.tone(A.sfx, { type: 'triangle', f0: 3200, gain: 0.06, decay: 0.08, delay: 0.04 });
  }

  /** A hit rings on the Warden's armour (the core hums). */
  metalHit(p: THREE.Vector3, n: number, core: boolean) {
    const s = this.at(p, 80);
    if (!s) return;
    const A = this.a, g = s.gain * Math.min(1.2, 0.35 + n / 40);
    A.tone(s.dest, { type: 'triangle', f0: 380 + Math.random() * 500, gain: 0.1 * g, decay: 0.22 });
    A.noiseHit(s.dest, { type: 'bandpass', freq: 2600, q: 2, gain: 0.12 * g, decay: 0.08, vary: 0.2 });
    if (core) A.tone(s.dest, { type: 'sine', f0: 140, f1: 90, gain: 0.2 * g, decay: 0.3 });
  }

  launch(p: THREE.Vector3) {
    const s = this.at(p, 90);
    if (!s) return;
    this.a.tone(s.dest, { type: 'sine', f0: 200, f1: 70, gain: 0.25 * s.gain, decay: 0.2 });
    this.a.noiseHit(s.dest, { type: 'lowpass', freq: 1200, gain: 0.2 * s.gain, decay: 0.2 });
  }

  botHit(p: THREE.Vector3) {
    const s = this.at(p, 50);
    if (!s) return;
    this.a.tone(s.dest, { type: 'square', f0: 900 + Math.random() * 400, gain: 0.03 * s.gain, decay: 0.06, lp: 3000 });
    this.a.noiseHit(s.dest, { type: 'bandpass', freq: 2000, q: 2, gain: 0.08 * s.gain, decay: 0.06 });
  }

  botDie(p: THREE.Vector3) {
    const s = this.at(p, 70);
    if (!s) return;
    this.a.noiseHit(s.dest, { type: 'lowpass', freq: 1600, freqEnd: 300, gain: 0.35 * s.gain, decay: 0.4 });
    this.a.tone(s.dest, { type: 'sine', f0: 150, f1: 45, gain: 0.3 * s.gain, decay: 0.3 });
    this.a.tone(s.dest, { type: 'square', f0: 1400, f1: 200, gain: 0.03 * s.gain, decay: 0.2, lp: 3000 });
  }

  orbFire(p: THREE.Vector3) {
    const s = this.at(p, 60);
    if (!s) return;
    this.a.tone(s.dest, { type: 'sine', f0: 950, f1: 380, gain: 0.1 * s.gain, decay: 0.2 });
    this.a.noiseHit(s.dest, { type: 'bandpass', freq: 1500, q: 3, gain: 0.06 * s.gain, decay: 0.1 });
  }

  /** An explosion of radius `r` (`c` as in the 'boom' event; 7: the stomp's wave). */
  boom(p: THREE.Vector3, r: number, c: number) {
    const s = this.at(p, 140);
    if (!s) return;
    const A = this.a, k = Math.min(1.4, r / 5), g = s.gain * k;
    if (c === 2) {
      // a well collapsing: inward, then out
      A.tone(s.dest, { type: 'sine', f0: 40, f1: 160, gain: 0.4 * g, attack: 0.08, decay: 0.2 });
      A.noiseHit(s.dest, { type: 'lowpass', freq: 500, gain: 0.4 * g, decay: 0.5, delay: 0.1 });
      return;
    }
    if (c === 6) {
      for (let i = 0; i < 4; i++) A.noiseHit(s.dest, { type: 'highpass', freq: 2500, gain: 0.2 * g, decay: 0.08, delay: i * 0.03 });
      A.tone(s.dest, { type: 'sawtooth', f0: 120, f1: 40, gain: 0.3 * g, decay: 0.5, lp: 900 });
      return;
    }
    if (c === 8) {
      // a slab of floor breaking apart: a crack, then rubble raining down
      A.noiseHit(s.dest, { type: 'highpass', freq: 1600, gain: 0.3 * g, decay: 0.08 });
      A.noiseHit(s.dest, { type: 'lowpass', freq: 700, freqEnd: 150, gain: 0.5 * g, decay: 0.5 });
      for (let i = 0; i < 5; i++) A.noiseHit(s.dest, { type: 'bandpass', freq: 1200 + Math.random() * 1500, q: 3, gain: 0.08 * g, decay: 0.06, delay: 0.1 + i * 0.07 + Math.random() * 0.05 });
      return;
    }
    A.noiseHit(s.dest, { type: 'lowpass', freq: 1100, freqEnd: 120, gain: 0.55 * g, decay: 0.5 + k * 0.5 });
    A.tone(s.dest, { type: 'sine', f0: 90, f1: 26, gain: 0.55 * g, decay: 0.5 + k * 0.4 });
    A.noiseHit(s.dest, { type: 'highpass', freq: 2400, gain: 0.15 * g, decay: 0.07 });
    if (c === 5 || c === 7) A.noiseHit(s.dest, { type: 'bandpass', freq: 700, q: 3, gain: 0.2 * g, decay: 1.0, delay: 0.05 });
  }

  thunderclap(p: THREE.Vector3) {
    const s = this.at(p, 400);
    const A = this.a, g = s ? Math.max(0.5, s.gain) : 0.5, d = s ? s.dest : A.sfx;
    A.noiseHit(d, { type: 'highpass', freq: 1800, gain: 0.45 * g, decay: 0.12 });
    A.noiseHit(d, { type: 'lowpass', freq: 400, gain: 0.5 * g, attack: 0.03, decay: 1.8, rate: 0.6, delay: 0.05 });
    A.tone(d, { type: 'sine', f0: 70, f1: 30, gain: 0.4 * g, decay: 1.0 });
  }

  mortar(p: THREE.Vector3) {
    const s = this.at(p, 150);
    if (!s) return;
    const A = this.a, g = Math.max(0.35, s.gain);
    A.tone(s.dest, { type: 'sine', f0: 95, f1: 38, gain: 0.45 * g, decay: 0.35 });
    A.noiseHit(s.dest, { type: 'lowpass', freq: 900, gain: 0.35 * g, decay: 0.3 });
    A.tone(s.dest, { type: 'sine', f0: 1600, f1: 500, gain: 0.03 * g, attack: 0.3, decay: 0.9, delay: 0.2 });
  }

  /** A conductor arcs to the crown. */
  arc(p: THREE.Vector3) {
    const s = this.at(p, 90);
    if (!s) return;
    for (let i = 0; i < 3; i++) this.a.noiseHit(s.dest, { type: 'highpass', freq: 2500 + Math.random() * 3000, gain: 0.1 * s.gain, decay: 0.05, delay: i * 0.04 });
  }

  /** You were hurt. */
  hurt(n: number, src: string) {
    const A = this.a, k = Math.min(1.3, 0.4 + n / 30);
    A.tone(A.sfx, { type: 'sine', f0: 130, f1: 50, gain: 0.4 * k, decay: 0.25 });
    A.noiseHit(A.sfx, { type: 'lowpass', freq: 900, gain: 0.3 * k, decay: 0.2 });
    if (src === 'beam' || src === 'shock') A.noiseHit(A.sfx, { type: 'highpass', freq: 3000, gain: 0.12 * k, decay: 0.25 });
    A.tone(A.sfx, { type: 'triangle', f0: 240, f1: 150, gain: 0.05 * k, decay: 0.18, delay: 0.03 });
  }

  // ------------------------------------------------------------------ continuous

  /** The beam's hum (k 0..1), heard from where it burns. */
  beam(k: number, end: THREE.Vector3) {
    const ctx = this.ctx, A = this.a;
    if (!this.beamGain) {
      if (k < 0.01) return;
      const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 110;
      const o2 = ctx.createOscillator(); o2.type = 'sawtooth'; o2.frequency.value = 164.8;
      const src = ctx.createBufferSource(); src.buffer = A.noise; src.loop = true;
      this.beamFilter = ctx.createBiquadFilter(); this.beamFilter.type = 'bandpass'; this.beamFilter.frequency.value = 1800; this.beamFilter.Q.value = 0.8;
      this.beamGain = ctx.createGain(); this.beamGain.gain.value = 0;
      this.beamPan = ctx.createStereoPanner();
      const og = ctx.createGain(); og.gain.value = 0.25;
      o1.connect(og); o2.connect(og); og.connect(this.beamFilter); src.connect(this.beamFilter);
      this.beamFilter.connect(this.beamGain).connect(this.beamPan).connect(A.sfx);
      o1.start(); o2.start(); src.start();
    }
    const t = ctx.currentTime;
    const dx = end.x - A.listenerPos.x, dy = end.y - A.listenerPos.y, dz = end.z - A.listenerPos.z;
    const d = Math.hypot(dx, dy, dz);
    const near = 1 / (1 + (d / 18) ** 1.4);
    this.beamGain.gain.setTargetAtTime(k * (0.05 + near * 0.25), t, 0.05);
    this.beamFilter!.frequency.setTargetAtTime(1200 + near * 2200, t, 0.1);
    const pan = d > 0.1 ? (dx * A.listenerRight.x + dy * A.listenerRight.y + dz * A.listenerRight.z) / d : 0;
    this.beamPan!.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)) * 0.8, t, 0.05);
  }

  /** The battle music and the storm's bed: `intensity` 0..1, `on` in the arena at all. */
  music(dt: number, intensity: number, on: boolean) {
    const ctx = this.ctx, A = this.a;
    this.battle.update(dt, on ? intensity : 0, on);
    if (!this.stormGain && on) {
      const src = ctx.createBufferSource(); src.buffer = A.noise; src.loop = true; src.playbackRate.value = 0.6;
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 380;
      this.stormGain = ctx.createGain(); this.stormGain.gain.value = 0;
      src.connect(f).connect(this.stormGain).connect(A.sfx);
      src.start();
    }
    this.stormOn += ((on ? 1 : 0) - this.stormOn) * Math.min(1, dt * 1.5);
    this.stormGain?.gain.setTargetAtTime(this.stormOn * 0.12, ctx.currentTime, 0.3);
    if (!on && this.beamGain) this.beamGain.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
  }
}

// The portal's music, made on the spot like every other sound in the game: an
// "aah" choir (detuned saws through vowel formants) moving through a slow
// I - vi - IV - V in D major, a warm string pad and a sub under it, harp and
// celesta arpeggios on top, a breath of air, all in a long cathedral reverb.
//
// It is one continuous piece whose loudness (`level`), brightness and density
// (`intensity`), stereo position (`pan`) and reverb (`room`) the game steers:
// faint and muffled from across the course, opening up as you get close,
// swelling when you step through, and filling the room with Viktor. Stingers
// mark the moments (the portal opening, stepping through, arriving, the
// blessing), and `syllable` gives Viktor a soft, wordless voice under his lines.

type Chord = { voices: number[]; strings: number[]; bass: number; bells: number[] };

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
/** Overtones above this are left out (they would only alias, or be clamped). */
const MAX_PARTIAL = 18000;

/** D - Bm - Gmaj7 - Asus4/A, voiced for a four-part choir. */
const CHORDS: Chord[] = [
  { voices: [54, 57, 62, 66], strings: [50, 57], bass: 38, bells: [74, 78, 81, 85, 86, 81, 78, 76] },
  { voices: [54, 59, 62, 66], strings: [47, 54], bass: 35, bells: [71, 74, 78, 81, 83, 81, 78, 74] },
  { voices: [55, 59, 62, 66], strings: [43, 50], bass: 43, bells: [74, 78, 79, 83, 86, 83, 79, 78] },
  { voices: [57, 62, 64, 69], strings: [45, 52], bass: 45, bells: [73, 76, 81, 85, 88, 85, 81, 76] },
];
/** Seconds per chord and per arpeggio step. */
const CHORD_LEN = 5.6;
const STEP = CHORD_LEN / 16;
/** Vowel formants (F1, F2, F3) for the choir and Viktor's voice. */
const VOWELS: [number, number, number][] = [[730, 1090, 2440], [570, 1700, 2500], [450, 900, 2400], [390, 1990, 2550], [440, 1020, 2240]];

export interface HeavenMix {
  /** Overall loudness 0..1 (distance falloff and fades). */
  level: number;
  /** 0 muffled and sparse .. 1 bright, full, every layer playing. */
  intensity: number;
  /** Stereo position -1..1. */
  pan: number;
  /** Reverb 0..1 (1 = inside the white room). */
  room: number;
}

export class HeavenMusic {
  private out: GainNode;
  private pan: StereoPannerNode;
  private dry: GainNode;
  private wet: GainNode;
  private verb: ConvolverNode;
  private tone: BiquadFilterNode;
  /** Stingers and Viktor's voice: their own reverb, heard whatever the piece is doing. */
  private fxVerb: ConvolverNode;
  private fxOut: GainNode;
  private layers: { choir: GainNode; strings: GainNode; bass: GainNode; bells: GainNode; air: GainNode } | null = null;
  private oscs: OscillatorNode[] = [];
  private sources: AudioBufferSourceNode[] = [];
  private choirOsc: OscillatorNode[][] = [];
  private stringOsc: OscillatorNode[] = [];
  private bassOsc: OscillatorNode | null = null;
  private airFilter: BiquadFilterNode | null = null;
  private running = false;
  private silentFor = 0;
  private nextStep = 0;
  private step = 0;
  private chord = -1;
  private mix: HeavenMix = { level: 0, intensity: 0, pan: 0, room: 0 };

  constructor(private readonly ctx: AudioContext, private readonly noise: AudioBuffer, dest: AudioNode) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.pan = ctx.createStereoPanner();
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 1200;
    this.tone.Q.value = 0.5;
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.verb = ctx.createConvolver();
    this.verb.buffer = impulse(ctx, 4.8, 2.6);
    this.fxVerb = ctx.createConvolver();
    this.fxVerb.buffer = this.verb.buffer;
    this.fxOut = ctx.createGain();
    this.fxOut.gain.value = 0.9;
    this.fxVerb.connect(this.fxOut);
    this.fxOut.connect(dest);
    // mix -> tone -> (dry + reverb) -> out -> pan -> destination
    this.tone.connect(this.dry).connect(this.out);
    this.tone.connect(this.verb).connect(this.wet).connect(this.out);
    this.out.connect(this.pan).connect(dest);
  }

  /** Steer the piece. Called every frame; quietly starts and stops the voices as needed. */
  update(dt: number, m: HeavenMix) {
    this.mix = m;
    const ctx = this.ctx, t = ctx.currentTime;
    if (m.level > 0.002) {
      this.silentFor = 0;
      if (!this.running) this.start();
    } else if (this.running && (this.silentFor += dt) > 4) this.stop();
    if (!this.running || !this.layers) return;
    const k = Math.max(0, Math.min(1, m.intensity));
    this.out.gain.setTargetAtTime(m.level * 0.9, t, 0.25);
    this.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, m.pan)) * 0.8, t, 0.2);
    // from across the course only the low, soft part carries; up close it all opens out
    this.tone.frequency.setTargetAtTime(700 + k * k * 7300, t, 0.3);
    this.dry.gain.setTargetAtTime(0.85 - m.room * 0.35, t, 0.4);
    this.wet.gain.setTargetAtTime(0.35 + m.room * 0.65, t, 0.4);
    const L = this.layers;
    L.choir.gain.setTargetAtTime(0.1 + k * 0.1, t, 0.4);
    L.strings.gain.setTargetAtTime(0.1 + k * 0.05, t, 0.4);
    L.bass.gain.setTargetAtTime(0.14 + k * 0.06, t, 0.4);
    L.bells.gain.setTargetAtTime(k * 0.34, t, 0.3);
    L.air.gain.setTargetAtTime(0.012 + k * 0.035, t, 0.5);
    this.schedule();
  }

  private start() {
    const ctx = this.ctx;
    this.running = true;
    const layer = () => { const g = ctx.createGain(); g.gain.value = 0; g.connect(this.tone); return g; };
    this.layers = { choir: layer(), strings: layer(), bass: layer(), bells: layer(), air: layer() };
    // choir: four voices of two detuned saws, with vibrato, through an "aah" vowel
    const formants = VOWELS[0].map((f, i) => {
      const b = ctx.createBiquadFilter();
      b.type = 'bandpass'; b.frequency.value = f; b.Q.value = [7, 9, 11][i];
      const g = ctx.createGain(); g.gain.value = [1, 0.55, 0.32][i];
      b.connect(g).connect(this.layers!.choir);
      return b;
    });
    const choirIn = ctx.createGain();
    choirIn.gain.value = 0.9;
    for (const f of formants) choirIn.connect(f);
    this.choirOsc = [];
    for (let v = 0; v < 4; v++) {
      const pair: OscillatorNode[] = [];
      for (const cents of [-7, 6]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.detune.value = cents + (v - 1.5) * 1.5;
        const vib = ctx.createOscillator();
        vib.frequency.value = 4.6 + v * 0.35 + (cents > 0 ? 0.2 : 0);
        const vg = ctx.createGain(); vg.gain.value = 6;
        vib.connect(vg).connect(o.detune);
        const g = ctx.createGain(); g.gain.value = 0.16;
        o.connect(g).connect(choirIn);
        o.start(); vib.start();
        this.oscs.push(o, vib);
        pair.push(o);
      }
      this.choirOsc.push(pair);
    }
    // strings: soft triangles an octave or two down, slowly breathing
    this.stringOsc = [];
    for (let i = 0; i < 2; i++) {
      const o = ctx.createOscillator(); o.type = 'triangle';
      const g = ctx.createGain(); g.gain.value = 0.35;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.11 + i * 0.07;
      const lg = ctx.createGain(); lg.gain.value = 0.12;
      lfo.connect(lg).connect(g.gain);
      o.connect(g).connect(this.layers.strings);
      o.start(); lfo.start();
      this.oscs.push(o, lfo);
      this.stringOsc.push(o);
    }
    this.bassOsc = ctx.createOscillator(); this.bassOsc.type = 'sine';
    this.bassOsc.connect(this.layers.bass);
    this.bassOsc.start();
    this.oscs.push(this.bassOsc);
    // air: a breath of high noise that swells and settles
    const src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true; src.playbackRate.value = 0.7;
    this.airFilter = ctx.createBiquadFilter(); this.airFilter.type = 'bandpass'; this.airFilter.frequency.value = 5200; this.airFilter.Q.value = 0.8;
    src.connect(this.airFilter).connect(this.layers.air);
    src.start();
    this.sources.push(src);
    this.chord = -1;
    this.step = 0;
    this.nextStep = ctx.currentTime + 0.05;
  }

  private stop() {
    this.running = false;
    for (const o of this.oscs) { try { o.stop(); } catch { /* already stopped */ } o.disconnect(); }
    for (const s of this.sources) { try { s.stop(); } catch { /* already stopped */ } s.disconnect(); }
    this.oscs = []; this.sources = []; this.choirOsc = []; this.stringOsc = []; this.bassOsc = null;
    if (this.layers) for (const g of Object.values(this.layers)) g.disconnect();
    this.layers = null;
  }

  /** Arpeggio steps and chord changes, scheduled a little ahead of the audio clock. */
  private schedule() {
    const ctx = this.ctx;
    while (this.nextStep < ctx.currentTime + 0.25) {
      const t = this.nextStep;
      const ci = Math.floor(this.step / 16) % CHORDS.length;
      if (ci !== this.chord) this.changeChord(ci, t);
      const c = CHORDS[ci];
      const k = this.mix.intensity;
      const s = this.step % 16;
      // the harp plays every eighth once you are close, the celesta joins on the offbeats up close
      if (k > 0.15 && s % 2 === 0) this.pluck(mtof(c.bells[(s / 2) % c.bells.length]), t, 0.13 + 0.05 * Math.random(), 1.8);
      if (k > 0.55 && s % 2 === 1 && Math.random() < 0.6) this.bell(mtof(c.bells[(s + 3) % c.bells.length] + 12), t, 0.05, 2.4);
      this.step++;
      this.nextStep += STEP;
    }
  }

  private changeChord(ci: number, t: number) {
    this.chord = ci;
    const c = CHORDS[ci];
    // voices glide to their new notes: smooth voice leading rather than a cut
    this.choirOsc.forEach((pair, v) => { for (const o of pair) o.frequency.setTargetAtTime(mtof(c.voices[v]), t, 0.35); });
    this.stringOsc.forEach((o, i) => o.frequency.setTargetAtTime(mtof(c.strings[i]), t, 0.6));
    this.bassOsc?.frequency.setTargetAtTime(mtof(c.bass), t, 0.5);
    this.airFilter?.frequency.setTargetAtTime(4200 + Math.random() * 2400, t, 1.5);
  }

  /** A harp-like pluck: a sine with an octave partial and a quick decay. */
  private pluck(f: number, t: number, gain: number, decay: number) {
    const L = this.layers;
    if (!L) return;
    const ctx = this.ctx;
    for (const [mul, g] of [[1, 1], [2, 0.28], [3, 0.08]] as const) {
      if (f * mul > MAX_PARTIAL) continue;
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * mul;
      const e = ctx.createGain();
      e.gain.setValueAtTime(0.0001, t);
      e.gain.exponentialRampToValueAtTime(gain * g, t + 0.006);
      e.gain.exponentialRampToValueAtTime(0.0001, t + decay / mul);
      o.connect(e).connect(L.bells);
      o.start(t); o.stop(t + decay / mul + 0.05);
    }
  }

  /** A celesta / glass bell: inharmonic partials that ring. */
  private bell(f: number, t: number, gain: number, decay: number) {
    const L = this.layers;
    if (!L) return;
    const ctx = this.ctx;
    for (const [mul, g] of [[1, 1], [2.76, 0.35], [5.4, 0.12]] as const) {
      if (f * mul > MAX_PARTIAL) continue;
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * mul;
      const e = ctx.createGain();
      e.gain.setValueAtTime(0.0001, t);
      e.gain.exponentialRampToValueAtTime(gain * g, t + 0.004);
      e.gain.exponentialRampToValueAtTime(0.0001, t + decay / Math.sqrt(mul));
      o.connect(e).connect(L.bells);
      o.start(t); o.stop(t + decay + 0.05);
    }
  }

  // ------------------------------------------------------------------ stingers

  /**
   * One-off moments, played straight into the reverb whether the piece is
   * running or not: 'open' (the portal appears: a distant shimmer), 'enter' (a
   * rising gliss and choir swell as you step through), 'arrive' (a bright
   * chord blooming in the white room), 'bless' (the gift: everything at once)
   * and 'return' (a soft chime on landing back on the pad).
   */
  stinger(kind: 'open' | 'enter' | 'arrive' | 'bless' | 'return', gain = 1) {
    const ctx = this.ctx, t = ctx.currentTime;
    const dest = ctx.createGain();
    dest.gain.value = gain;
    dest.connect(this.fxVerb);
    const direct = ctx.createGain();
    direct.gain.value = gain * 0.7;
    direct.connect(this.fxOut);
    const gliss = (from: number, n: number, gap: number, g: number, decay: number, at = 0) => {
      const scale = [0, 2, 4, 7, 9]; // pentatonic: every note agrees with every chord of the piece
      for (let i = 0; i < n; i++) {
        const m = from + Math.floor(i / 5) * 12 + scale[i % 5];
        this.oneShot(mtof(m), t + at + i * gap, g * (0.6 + 0.4 * (i / n)), decay, [dest, direct]);
      }
    };
    if (kind === 'open') {
      gliss(74, 10, 0.07, 0.05, 2.2);
      this.swell(t, 1.2, 3, 0.05, [dest]);
    } else if (kind === 'enter') {
      gliss(62, 20, 0.045, 0.08, 2.6);
      this.swell(t, 0.9, 2.4, 0.16, [dest, direct], true);
      this.choirSwell(t, [62, 66, 69, 74], 2.6, 0.08, [dest, direct]);
    } else if (kind === 'arrive') {
      this.choirSwell(t, [50, 57, 62, 66, 69, 74], 5, 0.07, [dest, direct]);
      gliss(74, 8, 0.11, 0.06, 3);
    } else if (kind === 'bless') {
      this.choirSwell(t, [50, 57, 62, 66, 69, 74, 78], 6, 0.1, [dest, direct]);
      gliss(62, 25, 0.05, 0.08, 3);
      this.swell(t, 1.8, 4, 0.14, [dest, direct], true);
    } else {
      [86, 90, 93, 98].forEach((m, i) => this.oneShot(mtof(m), t + i * 0.09, 0.06, 2.4, [dest, direct]));
    }
    window.setTimeout(() => { dest.disconnect(); direct.disconnect(); }, 9000);
  }

  private oneShot(f: number, t: number, gain: number, decay: number, outs: AudioNode[]) {
    const ctx = this.ctx;
    for (const [mul, g] of [[1, 1], [2, 0.3], [4.01, 0.06]] as const) {
      if (f * mul > MAX_PARTIAL) continue;
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * mul;
      const e = ctx.createGain();
      e.gain.setValueAtTime(0.0001, t);
      e.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * g), t + 0.005);
      e.gain.exponentialRampToValueAtTime(0.0001, t + decay / mul);
      o.connect(e);
      for (const d of outs) e.connect(d);
      o.start(t); o.stop(t + decay / mul + 0.05);
    }
  }

  /** A rising breath of bright noise: the "whoosh" of light. */
  private swell(t: number, rise: number, fall: number, gain: number, outs: AudioNode[], bright = false) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 0.9;
    f.frequency.setValueAtTime(bright ? 900 : 2500, t);
    f.frequency.exponentialRampToValueAtTime(bright ? 7000 : 6000, t + rise);
    const e = ctx.createGain();
    e.gain.setValueAtTime(0.0001, t);
    e.gain.exponentialRampToValueAtTime(gain, t + rise);
    e.gain.exponentialRampToValueAtTime(0.0001, t + rise + fall);
    src.connect(f).connect(e);
    for (const d of outs) e.connect(d);
    src.start(t, Math.random()); src.stop(t + rise + fall + 0.1);
  }

  /** A choir chord that swells in and dies away on its own. */
  private choirSwell(t: number, notes: number[], len: number, gain: number, outs: AudioNode[]) {
    const ctx = this.ctx;
    const bp = VOWELS[0].map((fr, i) => { const b = ctx.createBiquadFilter(); b.type = 'bandpass'; b.frequency.value = fr; b.Q.value = [6, 8, 10][i]; return b; });
    const e = ctx.createGain();
    e.gain.setValueAtTime(0.0001, t);
    e.gain.exponentialRampToValueAtTime(gain, t + len * 0.35);
    e.gain.exponentialRampToValueAtTime(0.0001, t + len);
    const mixIn = ctx.createGain(); mixIn.gain.value = 1;
    for (const b of bp) { mixIn.connect(b); b.connect(e); }
    for (const d of outs) e.connect(d);
    for (const m of notes) {
      for (const cents of [-8, 7]) {
        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = cents;
        const g = ctx.createGain(); g.gain.value = 0.22;
        o.connect(g).connect(mixIn);
        o.start(t); o.stop(t + len + 0.1);
      }
    }
  }

  /**
   * One syllable of Viktor's wordless voice: a low, breathy vowel with a little
   * pitch movement, mostly carried by the reverb so it reads as a presence
   * rather than as words.
   */
  syllable(pitch: number, dur: number, gain: number) {
    const ctx = this.ctx, t = ctx.currentTime;
    const v = VOWELS[Math.floor(Math.random() * VOWELS.length)];
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(pitch * (1 + (Math.random() - 0.5) * 0.06), t);
    o.frequency.linearRampToValueAtTime(pitch * (0.94 + Math.random() * 0.1), t + dur);
    const pre = ctx.createBiquadFilter(); pre.type = 'lowpass'; pre.frequency.value = 2600;
    const e = ctx.createGain();
    e.gain.setValueAtTime(0.0001, t);
    e.gain.exponentialRampToValueAtTime(gain, t + 0.035);
    e.gain.setTargetAtTime(gain * 0.7, t + 0.05, dur * 0.4);
    e.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.09);
    o.connect(pre);
    const bus = ctx.createGain(); bus.gain.value = 1;
    v.forEach((fr, i) => {
      const b = ctx.createBiquadFilter(); b.type = 'bandpass'; b.frequency.value = fr; b.Q.value = [5, 7, 9][i];
      const g = ctx.createGain(); g.gain.value = [1, 0.6, 0.25][i];
      pre.connect(b).connect(g).connect(bus);
    });
    // breath on top of the tone
    const n = ctx.createBufferSource(); n.buffer = this.noise;
    const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = v[1]; nf.Q.value = 1.5;
    const ng = ctx.createGain(); ng.gain.value = 0.35;
    n.connect(nf).connect(ng).connect(bus);
    bus.connect(e);
    e.connect(this.fxVerb);
    const dry = ctx.createGain(); dry.gain.value = 0.55;
    e.connect(dry).connect(this.fxOut);
    window.setTimeout(() => { e.disconnect(); dry.disconnect(); }, (dur + 1) * 1000);
    o.start(t); o.stop(t + dur + 0.15);
    n.start(t, Math.random()); n.stop(t + dur + 0.15);
  }
}

/** A long, bright cathedral tail: stereo noise with an exponential decay and a softened top. */
function impulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  const rate = ctx.sampleRate, len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const k = i / len;
      const w = Math.random() * 2 - 1;
      lp += (w - lp) * (0.55 - k * 0.35); // the tail darkens as it dies
      const pre = i < rate * 0.012 ? i / (rate * 0.012) : 1;
      d[i] = lp * Math.pow(1 - k, decay) * pre * 0.9;
    }
  }
  return buf;
}

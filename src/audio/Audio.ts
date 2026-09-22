// Procedural WebAudio sound: no asset files. Ambient high-altitude wind,
// footsteps, jumps/landings, enemy stingers, projectile charge/fire, chase
// pulse, drone buzz, thunder, death and finish cues. Simple stereo panning.

import * as THREE from 'three';

type Dest = AudioNode;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private music!: GainNode;
  private noise!: AudioBuffer;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private whistleGain!: GainNode;
  private chaseGain!: GainNode;
  private droneGain!: GainNode;
  private dronePan!: StereoPannerNode;
  private padGain!: GainNode;
  private zipGain!: GainNode;
  private zipFilter!: BiquadFilterNode;
  private beltGain!: GainNode;
  private listenerPos = new THREE.Vector3();
  private listenerRight = new THREE.Vector3(1, 0, 0);
  private beatT = 0;
  private chase = 0;
  private volume = 0.8;
  private musicVol = 0.6;

  get ready() { return this.ctx !== null && this.ctx.state === 'running'; }

  /** Must be called from a user gesture. */
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    let ctx: AudioContext;
    try { ctx = new AudioContext(); } catch { return; }
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain(); this.sfx.connect(this.master);
    this.music = ctx.createGain(); this.music.gain.value = this.musicVol; this.music.connect(this.master);

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = w * 0.6 + last * 3.5; }

    // ambient wind bed
    const wsrc = ctx.createBufferSource(); wsrc.buffer = this.noise; wsrc.loop = true;
    this.windFilter = ctx.createBiquadFilter(); this.windFilter.type = 'lowpass'; this.windFilter.frequency.value = 500; this.windFilter.Q.value = 0.7;
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0.08;
    wsrc.connect(this.windFilter).connect(this.windGain).connect(this.master);
    wsrc.start();
    const hsrc = ctx.createBufferSource(); hsrc.buffer = this.noise; hsrc.loop = true; hsrc.playbackRate.value = 0.8;
    const hf = ctx.createBiquadFilter(); hf.type = 'bandpass'; hf.frequency.value = 1700; hf.Q.value = 6;
    this.whistleGain = ctx.createGain(); this.whistleGain.gain.value = 0;
    hsrc.connect(hf).connect(this.whistleGain).connect(this.master);
    hsrc.start();

    // chase drone (music bus)
    this.chaseGain = ctx.createGain(); this.chaseGain.gain.value = 0;
    const cf = ctx.createBiquadFilter(); cf.type = 'lowpass'; cf.frequency.value = 260;
    for (const f of [55, 55.7, 82.4]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
      const g = ctx.createGain(); g.gain.value = 0.18;
      o.connect(g).connect(cf); o.start();
    }
    cf.connect(this.chaseGain).connect(this.music);

    // calm pad (music bus)
    this.padGain = ctx.createGain(); this.padGain.gain.value = 0.05;
    const pf = ctx.createBiquadFilter(); pf.type = 'lowpass'; pf.frequency.value = 900;
    for (const f of [220, 277.2, 329.6, 110]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.05 + Math.random() * 0.08;
      const lg = ctx.createGain(); lg.gain.value = 0.25;
      const g = ctx.createGain(); g.gain.value = 0.3;
      lfo.connect(lg).connect(g.gain);
      o.connect(g).connect(pf); o.start(); lfo.start();
    }
    pf.connect(this.padGain).connect(this.music);

    // drone buzz (nearest flyer)
    this.droneGain = ctx.createGain(); this.droneGain.gain.value = 0;
    this.dronePan = ctx.createStereoPanner();
    const df = ctx.createBiquadFilter(); df.type = 'lowpass'; df.frequency.value = 1100;
    for (const f of [96, 193, 289]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
      const g = ctx.createGain(); g.gain.value = 0.12;
      o.connect(g).connect(df); o.start();
    }
    df.connect(this.droneGain).connect(this.dronePan).connect(this.sfx);

    // zip-line trolley hiss (pitch follows speed)
    const zsrc = ctx.createBufferSource(); zsrc.buffer = this.noise; zsrc.loop = true; zsrc.playbackRate.value = 1.3;
    this.zipFilter = ctx.createBiquadFilter(); this.zipFilter.type = 'bandpass'; this.zipFilter.frequency.value = 1500; this.zipFilter.Q.value = 2.5;
    this.zipGain = ctx.createGain(); this.zipGain.gain.value = 0;
    zsrc.connect(this.zipFilter).connect(this.zipGain).connect(this.sfx);
    zsrc.start();
    // conveyor rumble while standing on a belt
    this.beltGain = ctx.createGain(); this.beltGain.gain.value = 0;
    const bf = ctx.createBiquadFilter(); bf.type = 'lowpass'; bf.frequency.value = 220;
    for (const f of [48, 72.5]) {
      const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = f;
      const g = ctx.createGain(); g.gain.value = 0.2;
      o.connect(g).connect(bf); o.start();
    }
    bf.connect(this.beltGain).connect(this.sfx);
  }

  setVolumes(master: number, music: number) {
    this.volume = master; this.musicVol = music;
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(master, this.ctx.currentTime, 0.05);
    this.music.gain.setTargetAtTime(music, this.ctx.currentTime, 0.05);
  }

  setListener(cam: THREE.Camera) {
    this.listenerPos.copy(cam.position);
    this.listenerRight.set(1, 0, 0).applyQuaternion(cam.quaternion);
  }

  // ------------------------------------------------------------------ primitives

  private spatial(pos: THREE.Vector3 | null, range = 60): { dest: Dest; gain: number } | null {
    const ctx = this.ctx!;
    if (!pos) return { dest: this.sfx, gain: 1 };
    const dx = pos.x - this.listenerPos.x, dy = pos.y - this.listenerPos.y, dz = pos.z - this.listenerPos.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > range * 1.6) return null;
    const gain = 1 / (1 + (d / (range * 0.25)) ** 1.5);
    const pan = ctx.createStereoPanner();
    pan.pan.value = d > 0.1 ? Math.max(-1, Math.min(1, (dx * this.listenerRight.x + dy * this.listenerRight.y + dz * this.listenerRight.z) / d)) * 0.85 : 0;
    pan.connect(this.sfx);
    return { dest: pan, gain };
  }

  private noiseHit(dest: Dest, o: { type: BiquadFilterType; freq: number; q?: number; gain: number; attack?: number; decay: number; delay?: number; freqEnd?: number; rate?: number }) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + (o.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = o.rate ?? 1;
    const f = ctx.createBiquadFilter();
    f.type = o.type; f.frequency.setValueAtTime(o.freq, t); f.Q.value = o.q ?? 1;
    if (o.freqEnd) f.frequency.exponentialRampToValueAtTime(o.freqEnd, t + (o.attack ?? 0.005) + o.decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain), t + (o.attack ?? 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t + (o.attack ?? 0.005) + o.decay);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 1.5);
    src.stop(t + (o.attack ?? 0.005) + o.decay + 0.05);
  }

  private tone(dest: Dest, o: { type: OscillatorType; f0: number; f1?: number; gain: number; attack?: number; decay: number; delay?: number; lp?: number }) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + (o.delay ?? 0);
    const osc = ctx.createOscillator();
    osc.type = o.type;
    osc.frequency.setValueAtTime(o.f0, t);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(o.f1, t + (o.attack ?? 0.005) + o.decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain), t + (o.attack ?? 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t + (o.attack ?? 0.005) + o.decay);
    let node: AudioNode = osc;
    if (o.lp) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.lp; node.connect(f); node = f; }
    node.connect(g).connect(dest);
    osc.start(t);
    osc.stop(t + (o.attack ?? 0.005) + o.decay + 0.05);
  }

  // ------------------------------------------------------------------ cues

  footstep(surface: string, speed: number) {
    if (!this.ready) return;
    const k = Math.min(1, speed / 9);
    const metal = surface === 'metal' || surface === 'grate' || surface === 'steel' || surface === 'hazard' || surface === 'rust';
    this.noiseHit(this.sfx, { type: 'bandpass', freq: metal ? 2400 + Math.random() * 600 : 900 + Math.random() * 300, q: 1.1, gain: 0.07 + k * 0.08, decay: 0.07 });
    this.tone(this.sfx, { type: 'sine', f0: 120, f1: 55, gain: 0.09 + k * 0.06, decay: 0.07 });
    if (metal) this.tone(this.sfx, { type: 'triangle', f0: 620 + Math.random() * 120, gain: 0.018, decay: 0.12 });
  }

  jump() {
    if (!this.ready) return;
    this.noiseHit(this.sfx, { type: 'highpass', freq: 700, gain: 0.08, attack: 0.03, decay: 0.16 });
    this.tone(this.sfx, { type: 'sine', f0: 180, f1: 260, gain: 0.04, decay: 0.1 });
  }

  land(impact: number) {
    if (!this.ready) return;
    const k = Math.min(1, impact / 20);
    this.tone(this.sfx, { type: 'sine', f0: 95, f1: 38, gain: 0.12 + k * 0.3, decay: 0.18 + k * 0.1 });
    this.noiseHit(this.sfx, { type: 'lowpass', freq: 600 + k * 600, gain: 0.08 + k * 0.2, decay: 0.12 + k * 0.1 });
  }

  mantle() {
    if (!this.ready) return;
    this.noiseHit(this.sfx, { type: 'bandpass', freq: 1300, q: 2, gain: 0.08, attack: 0.02, decay: 0.12 });
    this.tone(this.sfx, { type: 'sine', f0: 150, f1: 110, gain: 0.07, decay: 0.12 });
  }

  spotted(pos: THREE.Vector3, local: boolean) {
    if (!this.ready) return;
    const s = this.spatial(local ? null : pos, 70);
    if (!s) return;
    const g = local ? 0.22 : 0.12 * s.gain;
    this.tone(s.dest, { type: 'sawtooth', f0: 330, gain: g, decay: 0.12, lp: 1800 });
    this.tone(s.dest, { type: 'sawtooth', f0: 494, gain: g, decay: 0.3, delay: 0.1, lp: 2200 });
    this.noiseHit(s.dest, { type: 'bandpass', freq: 3000, freqEnd: 600, q: 1, gain: g * 0.8, attack: 0.05, decay: 0.35 });
  }

  lost(pos: THREE.Vector3) {
    if (!this.ready) return;
    const s = this.spatial(pos, 50);
    if (!s) return;
    this.tone(s.dest, { type: 'triangle', f0: 440, f1: 300, gain: 0.06 * s.gain, decay: 0.35 });
  }

  charge(pos: THREE.Vector3) {
    if (!this.ready) return;
    const s = this.spatial(pos, 70);
    if (!s) return;
    this.tone(s.dest, { type: 'sine', f0: 180, f1: 1400, gain: 0.12 * s.gain, attack: 0.7, decay: 0.12, lp: 3000 });
  }

  shot(pos: THREE.Vector3) {
    if (!this.ready) return;
    const s = this.spatial(pos, 80);
    if (!s) return;
    this.tone(s.dest, { type: 'square', f0: 1200, f1: 110, gain: 0.12 * s.gain, decay: 0.28, lp: 2600 });
    this.noiseHit(s.dest, { type: 'bandpass', freq: 1800, q: 0.8, gain: 0.14 * s.gain, decay: 0.22 });
  }

  whizz(pos: THREE.Vector3) {
    if (!this.ready) return;
    const s = this.spatial(pos, 12);
    if (!s) return;
    this.noiseHit(s.dest, { type: 'bandpass', freq: 2600, freqEnd: 900, q: 3, gain: 0.25 * s.gain, attack: 0.04, decay: 0.2 });
  }

  impact(pos: THREE.Vector3) {
    if (!this.ready) return;
    const s = this.spatial(pos, 60);
    if (!s) return;
    this.noiseHit(s.dest, { type: 'lowpass', freq: 1400, gain: 0.2 * s.gain, decay: 0.35 });
    this.tone(s.dest, { type: 'sine', f0: 140, f1: 50, gain: 0.12 * s.gain, decay: 0.25 });
  }

  crumble(pos: THREE.Vector3, big: boolean) {
    if (!this.ready) return;
    const s = this.spatial(pos, 50);
    if (!s) return;
    if (big) {
      this.noiseHit(s.dest, { type: 'lowpass', freq: 380, gain: 0.35 * s.gain, attack: 0.02, decay: 1.1 });
      this.noiseHit(s.dest, { type: 'highpass', freq: 2500, gain: 0.15 * s.gain, decay: 0.08 });
    } else {
      this.noiseHit(s.dest, { type: 'bandpass', freq: 700 + Math.random() * 500, q: 3, gain: 0.08 * s.gain, decay: 0.08 });
    }
  }

  gust(pos: THREE.Vector3) {
    if (!this.ready) return;
    const s = this.spatial(pos, 40);
    if (!s) return;
    this.noiseHit(s.dest, { type: 'bandpass', freq: 350, freqEnd: 1300, q: 1.2, gain: 0.28 * s.gain, attack: 0.4, decay: 1.2 });
  }

  thunder(delay: number, strength: number) {
    if (!this.ready) return;
    this.noiseHit(this.sfx, { type: 'lowpass', freq: 160, gain: 0.35 * strength, attack: 0.12, decay: 3.2, delay, rate: 0.5 });
    this.noiseHit(this.sfx, { type: 'lowpass', freq: 90, gain: 0.3 * strength, attack: 0.3, decay: 2.2, delay: delay + 0.4, rate: 0.4 });
  }

  slide() {
    if (!this.ready) return;
    this.noiseHit(this.sfx, { type: 'bandpass', freq: 900, freqEnd: 350, q: 0.9, gain: 0.2, attack: 0.02, decay: 0.7 });
    this.noiseHit(this.sfx, { type: 'highpass', freq: 2500, gain: 0.05, attack: 0.02, decay: 0.4 });
  }

  grappleFire() {
    if (!this.ready) return;
    this.noiseHit(this.sfx, { type: 'bandpass', freq: 1800, freqEnd: 4200, q: 3, gain: 0.14, attack: 0.01, decay: 0.12 });
  }

  grappleHook() {
    if (!this.ready) return;
    this.tone(this.sfx, { type: 'square', f0: 900, f1: 600, gain: 0.05, decay: 0.08, lp: 3000 });
    this.tone(this.sfx, { type: 'sine', f0: 140, f1: 90, gain: 0.12, decay: 0.14 });
    this.noiseHit(this.sfx, { type: 'lowpass', freq: 500, freqEnd: 1600, gain: 0.12, attack: 0.05, decay: 0.45, delay: 0.05 });
  }

  grappleRelease() {
    if (!this.ready) return;
    this.noiseHit(this.sfx, { type: 'bandpass', freq: 600, freqEnd: 1800, q: 1, gain: 0.12, attack: 0.03, decay: 0.3 });
  }

  /** Front flip: a quick whoosh with a rising tail. */
  flip() {
    if (!this.ready) return;
    this.noiseHit(this.sfx, { type: 'bandpass', freq: 500, freqEnd: 2200, q: 0.8, gain: 0.16, attack: 0.02, decay: 0.42 });
    this.tone(this.sfx, { type: 'sine', f0: 210, f1: 420, gain: 0.05, decay: 0.3, lp: 1800 });
  }

  /** Dash: a short scuffed push off the floor. */
  dash() {
    if (!this.ready) return;
    this.noiseHit(this.sfx, { type: 'bandpass', freq: 1500, freqEnd: 420, q: 1.2, gain: 0.2, attack: 0.008, decay: 0.26 });
    this.tone(this.sfx, { type: 'triangle', f0: 160, f1: 70, gain: 0.07, decay: 0.16, lp: 900 });
  }

  /** A boosted take-off: a rising whoosh under the normal jump. */
  boostJump() {
    if (!this.ready) return;
    this.noiseHit(this.sfx, { type: 'lowpass', freq: 400, freqEnd: 2400, gain: 0.25, attack: 0.02, decay: 0.3 });
    this.tone(this.sfx, { type: 'sawtooth', f0: 90, f1: 240, gain: 0.08, decay: 0.25, lp: 1200 });
  }

  pickup(kind: string) {
    if (!this.ready) return;
    const base = kind === 'shield' ? 523.3 : kind === 'cloak' ? 440 : 587.3;
    [1, 1.25, 1.5, 2].forEach((m, i) => this.tone(this.sfx, { type: kind === 'cloak' ? 'sine' : 'triangle', f0: base * m, gain: 0.1, attack: 0.01, decay: 0.5, delay: i * 0.06 }));
    if (kind === 'cloak') this.noiseHit(this.sfx, { type: 'highpass', freq: 3000, freqEnd: 800, gain: 0.08, attack: 0.2, decay: 0.8 });
  }

  shieldBreak(local: boolean) {
    if (!this.ready) return;
    const g = local ? 1 : 0.5;
    this.noiseHit(this.sfx, { type: 'highpass', freq: 3500, gain: 0.3 * g, decay: 0.5 });
    [1600, 2100, 2700].forEach((f, i) => this.tone(this.sfx, { type: 'triangle', f0: f, f1: f * 0.7, gain: 0.07 * g, decay: 0.45, delay: i * 0.03 }));
    this.tone(this.sfx, { type: 'sine', f0: 200, f1: 60, gain: 0.25 * g, decay: 0.4 });
  }

  launch() {
    if (!this.ready) return;
    this.noiseHit(this.sfx, { type: 'lowpass', freq: 300, freqEnd: 2600, gain: 0.35, attack: 0.03, decay: 0.55 });
    this.tone(this.sfx, { type: 'sine', f0: 70, f1: 220, gain: 0.3, decay: 0.35 });
    this.noiseHit(this.sfx, { type: 'highpass', freq: 3000, gain: 0.08, attack: 0.05, decay: 0.7, delay: 0.05 });
  }

  zipOn() {
    if (!this.ready) return;
    this.tone(this.sfx, { type: 'triangle', f0: 1900, f1: 1500, gain: 0.07, decay: 0.08 });
    this.noiseHit(this.sfx, { type: 'bandpass', freq: 2600, q: 4, gain: 0.12, decay: 0.12 });
    this.tone(this.sfx, { type: 'sine', f0: 160, f1: 90, gain: 0.1, decay: 0.15 });
  }

  zipOff() {
    if (!this.ready) return;
    this.tone(this.sfx, { type: 'triangle', f0: 1200, f1: 1700, gain: 0.05, decay: 0.08 });
  }

  laserOn(pos: THREE.Vector3) {
    if (!this.ready) return;
    const s = this.spatial(pos, 26);
    if (!s) return;
    this.tone(s.dest, { type: 'sawtooth', f0: 110, f1: 220, gain: 0.07 * s.gain, attack: 0.02, decay: 0.25, lp: 1600 });
    this.noiseHit(s.dest, { type: 'bandpass', freq: 3200, q: 6, gain: 0.08 * s.gain, decay: 0.2 });
  }

  death(cause: string) {
    if (!this.ready) return;
    if (cause === 'laser') {
      this.noiseHit(this.sfx, { type: 'highpass', freq: 2400, gain: 0.3, decay: 0.6 });
      this.tone(this.sfx, { type: 'sawtooth', f0: 1800, f1: 120, gain: 0.18, decay: 0.5, lp: 4000 });
    } else if (cause === 'fall') {
      this.tone(this.sfx, { type: 'sine', f0: 900, f1: 160, gain: 0.12, attack: 0.1, decay: 1.6, lp: 2000 });
    } else {
      this.noiseHit(this.sfx, { type: 'lowpass', freq: 2200, gain: 0.35, decay: 0.45 });
      this.tone(this.sfx, { type: 'sawtooth', f0: 240, f1: 45, gain: 0.25, decay: 0.8, lp: 1200 });
    }
    this.tone(this.sfx, { type: 'sine', f0: 110, f1: 55, gain: 0.2, attack: 0.3, decay: 1.8, delay: 0.3 });
  }

  otherDied() {
    if (!this.ready) return;
    this.tone(this.sfx, { type: 'triangle', f0: 392, f1: 196, gain: 0.08, decay: 0.6 });
  }

  finish() {
    if (!this.ready) return;
    [523.3, 659.3, 784, 1046.5].forEach((f, i) => {
      this.tone(this.sfx, { type: 'triangle', f0: f, gain: 0.14, attack: 0.02, decay: 1.4, delay: i * 0.11 });
      this.tone(this.sfx, { type: 'sine', f0: f * 2, gain: 0.04, attack: 0.02, decay: 1.0, delay: i * 0.11 + 0.02 });
    });
  }

  beep(go: boolean) {
    if (!this.ready) return;
    this.tone(this.sfx, { type: 'sine', f0: go ? 988 : 660, gain: 0.16, decay: go ? 0.5 : 0.14 });
  }

  click() {
    if (!this.ready) return;
    this.tone(this.sfx, { type: 'triangle', f0: 1400, f1: 900, gain: 0.04, decay: 0.05 });
  }

  // ------------------------------------------------------------------ continuous

  update(dt: number, p: { exposure: number; speed: number; falling: number; chase: number; drone: THREE.Vector3 | null; inGame: boolean; zip?: number; belt?: boolean }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const zip = p.inGame ? p.zip ?? 0 : 0;
    this.zipGain.gain.setTargetAtTime(zip > 0 ? 0.05 + zip * 0.012 : 0, t, 0.08);
    this.zipFilter.frequency.setTargetAtTime(900 + zip * 110, t, 0.1);
    this.beltGain.gain.setTargetAtTime(p.inGame && p.belt ? 0.06 : 0, t, 0.15);
    const wind = 0.05 + p.exposure * 0.1 + Math.min(0.25, p.speed * 0.012) + p.falling * 0.35;
    this.windGain.gain.setTargetAtTime(wind, t, 0.3);
    this.windFilter.frequency.setTargetAtTime(380 + p.speed * 40 + p.falling * 1400 + Math.sin(t * 0.3) * 120, t, 0.4);
    this.whistleGain.gain.setTargetAtTime(p.falling * 0.12 + Math.max(0, p.speed - 7) * 0.006, t, 0.2);

    this.chase += ((p.inGame ? p.chase : 0) - this.chase) * Math.min(1, dt * (p.chase > this.chase ? 3 : 0.6));
    this.chaseGain.gain.setTargetAtTime(this.chase * 0.5, t, 0.15);
    this.padGain.gain.setTargetAtTime((1 - this.chase) * 0.05, t, 1.0);
    if (this.chase > 0.05) {
      this.beatT -= dt;
      if (this.beatT <= 0) {
        this.beatT = 0.42 - this.chase * 0.08;
        this.tone(this.music, { type: 'sine', f0: 70, f1: 38, gain: 0.35 * this.chase, decay: 0.16 });
        this.tone(this.music, { type: 'sine', f0: 62, f1: 36, gain: 0.25 * this.chase, decay: 0.14, delay: 0.16 });
      }
    }
    if (p.drone) {
      const dx = p.drone.x - this.listenerPos.x, dy = p.drone.y - this.listenerPos.y, dz = p.drone.z - this.listenerPos.z;
      const d = Math.hypot(dx, dy, dz);
      const g = d < 45 ? 0.16 / (1 + (d / 8) ** 1.4) : 0;
      this.droneGain.gain.setTargetAtTime(g, t, 0.2);
      const pan = d > 0.1 ? (dx * this.listenerRight.x + dy * this.listenerRight.y + dz * this.listenerRight.z) / d : 0;
      this.dronePan.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)) * 0.85, t, 0.1);
    } else {
      this.droneGain.gain.setTargetAtTime(0, t, 0.3);
    }
  }
}

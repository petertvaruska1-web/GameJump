// Speedster Battle on the client: everything past the Warden's rift.
//
// The server runs the race (shared/sim/race.ts); this class draws it and lets
// the local runner take part. When the rift's warp lands ('race'), the team
// stands on the start grid of a road of light through a gap in spacetime; the
// camera takes in the course, a countdown runs, and from "Go!" the mouse
// buttons are the runner's legs: every click on the other button from the last
// is a stride, the pace of the strides (shared/sim/cadence.ts) is the speed the
// motor's race running drives toward. Everyone's place along the course is
// worked out here from where they are drawn; the finish, the places and the
// times are the server's.

import * as THREE from 'three';
import { NET, RACE } from '../../shared/constants';
import { getRace, trackIndex, trackPoint, trackS, type RaceData } from '../../shared/level/race';
import { clamp, smoothstep } from '../../shared/math';
import type { C2S, GameEvent, Stage } from '../../shared/protocol';
import { Cadence } from '../../shared/sim/cadence';
import type { AudioEngine } from '../audio/Audio';
import type { CameraController } from '../player/CameraController';
import type { LocalPlayer } from '../player/LocalPlayer';
import { PLAYER_COLORS } from '../render/CharacterModel';
import type { Particles } from '../render/Effects';
import type { Materials } from '../render/Materials';
import { RaceView } from '../render/RaceView';
import { fmtTime, type UI } from '../ui/UI';
import type { RemotePlayer } from './Actors';

export interface RaceHost {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly cam: CameraController;
  readonly ui: UI;
  readonly audio: AudioEngine;
  readonly particles: Particles;
  readonly mats: Materials;
  readonly glowTex: THREE.Texture;
  readonly shadows: boolean;
  send(m: C2S): void;
  meId(): number;
  local(): LocalPlayer | null;
  remote(id: number): RemotePlayer | undefined;
  remotes(): Iterable<RemotePlayer>;
  name(id: number): string;
  /** Show the race (true) or not: what is drawn, the air and the light, the runner's level. */
  swap(on: boolean): void;
  /** The arena is behind the team now: put it away. */
  leaveArena(): void;
}

/** Set once this browser has reached the race: the lobby offers it straight away after that. */
export const RACE_REACHED_KEY = 'skyfall.race.v1';
/** Best race time and top speed in this browser. */
const RACE_BEST_KEY = 'skyfall.race.best.v1';

/** How long the arrival shot over the course lasts. */
const REVEAL = 3.4;
const ORDINAL = ['', '1st', '2nd', '3rd'];
export const ordinal = (n: number) => ORDINAL[n] ?? `${n}th`;

const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
const ZERO = new THREE.Vector3();
const pt = { x: 0, y: 0, z: 0, h: 0, w: 0 };

export interface RaceBest { time: number | null; top: number | null }

export function loadRaceBest(): RaceBest {
  try { const v = JSON.parse(localStorage.getItem(RACE_BEST_KEY) ?? 'null'); if (v && typeof v === 'object') return { time: v.time ?? null, top: v.top ?? null }; } catch { /* private window */ }
  return { time: null, top: null };
}

export class Race {
  readonly data: RaceData = getRace();
  view: RaceView | null = null;
  /** The race is what is shown right now. */
  active = false;
  /** Match time of "Go!". */
  go = 0;
  readonly cadence = new Cadence();
  /** Every runner's sample hint and distance along the course. */
  private readonly hint = new Map<number, number>();
  readonly progress = new Map<number, number>();
  /** The last checkpoint ring each runner went through (index into the course's rings). */
  private readonly ringAt = new Map<number, number>();
  /** Who is home: time, place, top and average speed (from the server). */
  readonly home = new Map<number, { time: number; place: number; top?: number; avg?: number }>();
  /** Past the line: the strides no longer count, the runner coasts down the run-out. */
  coasting = false;
  /** The local runner's place right now, and the fastest it has gone. */
  place = 1;
  top = 0;
  private revealT = -1;
  private readonly revealLook = new THREE.Vector3();
  private lastCount = 99;
  private startS = 0;
  private section = -1;

  constructor(private readonly host: RaceHost) {}

  /** Builds the course (once; kept for every race after). */
  ensureViews() {
    if (this.view) return;
    const h = this.host;
    this.view = new RaceView(this.data, h.mats, h.glowTex, h.shadows);
    h.scene.add(this.view.group);
  }

  get level() { return this.data.level; }
  get world() { return this.view?.world ?? null; }
  get ownsCamera() { return this.active && this.revealT >= 0; }
  /** Before "Go!" the keys wait. */
  locksInput(mt: number) { return this.active && mt < this.go; }

  /** Back to nothing (a new run, the lobby, leaving). */
  reset() {
    this.active = false;
    this.go = 0;
    this.revealT = -1;
    this.coasting = false;
    this.cadence.reset();
    this.hint.clear(); this.progress.clear(); this.home.clear(); this.ringAt.clear();
    this.place = 1; this.top = 0; this.section = -1; this.lastCount = 99;
    const local = this.host.local();
    if (local) { local.motor.race = false; local.model.setPowerColor(null); }
    for (const rp of this.host.remotes()) { rp.lead = 0; rp.maxSpeed = 30; rp.model.setPowerColor(null); }
    if (this.view) this.view.group.visible = false;
  }

  /** A run starts (or is resumed): in the race, or not. */
  onStart(m: { stage?: Stage; rgo?: number; done?: [number, number, number][]; spawns: Record<number, [number, number, number]>; resume?: boolean }, mt: number) {
    this.reset();
    if (m.stage !== 'race') return;
    const go = m.rgo ?? 0;
    this.arrive(m.spawns, go, mt, !m.resume && go > 1);
    for (const [id, time, place] of m.done ?? []) this.home.set(id, { time, place });
    if (m.resume && this.home.has(this.host.meId())) this.coasting = true;
  }

  /** Returns true when the event belonged to the race. */
  onEvent(e: GameEvent, mt: number): boolean {
    if (e.k === 'race') {
      this.host.leaveArena();
      this.arrive(e.spawns, e.go, mt, true);
      return true;
    }
    if (e.k === 'finish' && this.active) { this.finished(e); return true; }
    return false;
  }

  /** The team is on the grid: the course, a look at it, and the countdown to `go`. */
  private arrive(spawns: Record<number, [number, number, number]>, go: number, mt: number, reveal: boolean) {
    this.ensureViews();
    const h = this.host;
    this.active = true;
    this.go = go;
    this.view!.group.visible = true;
    h.swap(true);
    const local = h.local();
    const me = spawns[h.meId()];
    if (local && me) {
      local.setLevel(this.data.level);
      local.spawn(me[0], me[1], me[2], this.data.yaw);
      local.motor.race = true;
      local.frozen = mt < go;
      local.model.setPowerColor(PLAYER_COLORS[(h.meId() - 1) % 3]);
      h.cam.reset(local.renderPos, this.data.yaw);
    }
    for (const rp of h.remotes()) {
      const s = spawns[rp.id];
      if (s) rp.place(s[0], s[1], s[2], this.data.yaw);
      rp.model.setPowerColor(PLAYER_COLORS[(rp.id - 1) % 3]);
    }
    const g = this.data.grid[1];
    this.startS = trackS(this.data.track, trackIndex(this.data.track, g[0], g[1], g[2], -1), g[0], g[2]);
    this.cadence.reset();
    this.coasting = false;
    this.lastCount = 99;
    h.ui.whiteout(0, 1.2);
    h.ui.objective('Speedster Battle · alternate left and right clicks to run faster', 7);
    this.revealT = reveal ? 0 : -1;
    try { localStorage.setItem(RACE_REACHED_KEY, '1'); } catch { /* private window */ }
  }

  /** The server says someone is home. */
  private finished(e: Extract<GameEvent, { k: 'finish' }>) {
    const h = this.host;
    this.home.set(e.id, { time: e.time, place: e.place, top: e.top, avg: e.avg });
    if (e.id === h.meId()) {
      this.coasting = true;
      h.ui.big(ordinal(e.place), 'cyan', `${fmtTime(e.time)} · top ${Math.round((e.top ?? this.top) * 3.6)} km/h`, 0);
      h.audio.finish();
      const best = loadRaceBest();
      const next = { time: best.time === null || e.time < best.time ? e.time : best.time, top: Math.max(best.top ?? 0, e.top ?? this.top) };
      try { localStorage.setItem(RACE_BEST_KEY, JSON.stringify(next)); } catch { /* private window */ }
    } else h.ui.toast(`${h.name(e.id)} is home · ${ordinal(e.place)} · ${fmtTime(e.time)}`);
  }

  /** A counted stride (0 left, 1 right). */
  private stride(_b: 0 | 1) {
    this.host.cam.kickFov(0.25);
  }

  /**
   * Every frame, before the runner's physics. `clicks`: this frame's button presses
   * (performance.now() times), `nowMs` the time now on that clock; `can`: the runner
   * may act (not paused, the mouse captured).
   */
  update(dt: number, time: number, mt: number, clicks: readonly { b: 0 | 1; t: number }[], nowMs: number, can: boolean) {
    if (!this.active || !this.view) return;
    const h = this.host, local = h.local();
    // the countdown after the warp (a rematch uses the run's own countdown)
    if (this.go > 1) {
      const left = this.go - mt;
      if (local) local.frozen = left > 0;
      const n = Math.ceil(left);
      if (left > 0 && n <= 3 && n !== this.lastCount) { this.lastCount = n; h.ui.big(String(n), '', 'Alternate left and right clicks', 0); h.audio.beep(false); }
      else if (left <= 0 && this.lastCount !== 0) { this.lastCount = 0; h.ui.big('Go!', 'cyan', '', 1.2); h.audio.beep(true); }
    }
    // strides: every click on the other button from the last, at the moment it was made
    if (local && !local.dead && can && !this.coasting && mt >= this.go) {
      for (const c of clicks) if (this.cadence.stride(c.b, mt - Math.max(0, nowMs - c.t) / 1000)) { local.motor.raceKick(); this.stride(c.b); }
    }
    if (local) local.motor.raceTarget = this.coasting ? RACE.BASE : this.cadence.target(mt);
    // everyone else is drawn where they really are (ahead of the interpolation), and keeps its speed
    for (const rp of h.remotes()) { rp.lead = NET.INTERP_DELAY; rp.maxSpeed = RACE.MAX_CLIENT_SPEED + 15; }
    this.updatePlaces(local);
    this.view.update(time, dt, h.camera.position, mt, local && !local.dead ? local.renderVel : ZERO);
    this.updateHud(local, mt);
    if (this.revealT >= 0) { this.revealT += dt; if (this.revealT > REVEAL) this.endReveal(); }
  }

  /** Everyone's distance along the course, and the local runner's place. */
  private updatePlaces(local: LocalPlayer | null) {
    const T = this.data.track, h = this.host, me = h.meId();
    const at = (id: number, p: THREE.Vector3) => {
      const i = trackIndex(T, p.x, p.y, p.z, this.hint.get(id) ?? -1);
      this.hint.set(id, i);
      const s = trackS(T, i, p.x, p.z);
      this.progress.set(id, s);
      // through a checkpoint ring: it flashes the runner's colour
      let r = this.ringAt.get(id) ?? -1;
      while (r + 1 < T.rings.length && s >= T.rings[r + 1]) {
        r++;
        if (s - T.rings[r] < 40) this.passedRing(id, r, p);
      }
      this.ringAt.set(id, r);
    };
    if (local) at(me, local.renderPos);
    for (const rp of h.remotes()) at(rp.id, rp.pos);
    const ids = [...this.progress.keys()];
    ids.sort((a, b) => {
      const ha = this.home.get(a), hb = this.home.get(b);
      if (ha && hb) return ha.place - hb.place;
      if (ha) return -1;
      if (hb) return 1;
      return (this.progress.get(b) ?? 0) - (this.progress.get(a) ?? 0);
    });
    this.place = Math.max(1, ids.indexOf(me) + 1);
    if (local) this.top = Math.max(this.top, Math.hypot(local.renderVel.x, local.renderVel.z));
  }

  /** Runner `id` went through ring `i` at `p`. */
  private passedRing(id: number, i: number, p: THREE.Vector3) {
    const c = PLAYER_COLORS[(id - 1) % 3];
    this.view?.passRing(i, c);
    const col = new THREE.Color(c);
    this.host.particles.burst(p.x, p.y + 1.2, p.z, 26, 7, 0.6, 0.25, [col.r, col.g, col.b], 1, -1, 2);
  }

  private updateHud(local: LocalPlayer | null, mt: number) {
    const h = this.host, T = this.data.track;
    const s = this.progress.get(h.meId()) ?? 0;
    const sec = T.samples[Math.min(T.samples.length - 1, Math.max(0, Math.round(s / T.step)))].sec;
    const frac = clamp((s - this.startS) / (T.finishS - this.startS), 0, 1);
    h.ui.area(T.sections[sec].name, frac);
    if (sec !== this.section) this.section = sec;
    if (!local) return;
    const kmh = Math.round(Math.hypot(local.renderVel.x, local.renderVel.z) * 3.6);
    const n = this.progress.size;
    h.ui.bottom(mt >= this.go ? `${kmh} km/h · ${this.cadence.rate(mt).toFixed(1)} strides/s · ${ordinal(this.place)}${n > 1 ? ` of ${n}` : ''}` : '');
  }

  private endReveal() {
    this.revealT = -1;
    const local = this.host.local();
    if (local) this.host.cam.reset(local.renderPos, this.data.yaw);
  }

  /** Skip the arrival shot. */
  skipReveal() { if (this.revealT > 0.4) this.endReveal(); }

  /** The arrival shot: from high over the grid, down the course, and in behind the runner. */
  updateCamera(_dt: number) {
    const h = this.host, cam = h.camera;
    const u = clamp(this.revealT / REVEAL, 0, 1);
    const g = this.data.grid[1];
    trackPoint(this.data.track, 320, pt);
    const far = tmp.set(pt.x, pt.y, pt.z);
    const fx = Math.sin(this.data.yaw), fz = Math.cos(this.data.yaw);
    const k0 = tmp2.set(g[0] - fx * 30 + 26, g[1] + 42, g[2] - fz * 30);
    const local = h.local();
    const s = local ? local.renderPos : new THREE.Vector3(g[0], g[1], g[2]);
    const a = smoothstep(0.35, 1, u);
    cam.position.set(k0.x + (s.x - fx * 5.2 - k0.x) * a, k0.y + (s.y + 2.4 - k0.y) * a, k0.z + (s.z - fz * 5.2 - k0.z) * a);
    this.revealLook.copy(far).lerp(tmp2.set(s.x + fx * 12, s.y + 1.6, s.z + fz * 12), smoothstep(0.5, 1, u));
    cam.lookAt(this.revealLook);
    if (cam.fov !== 64) { cam.fov = 64; cam.updateProjectionMatrix(); }
  }
}

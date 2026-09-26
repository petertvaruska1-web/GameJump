// The Warden's fight on the client: everything past the beacon.
//
// The server runs the fight (shared/sim/fight.ts); this class draws it and lets
// the local runner take part. It follows the room through three stages:
//
//   course --someone reaches the beacon ('gate')--> gate --2.6 s ('arena')--> boss
//   boss --the Warden down ('rift')--> a runner steps in ('warp') --2.6 s--> the race (Race.ts)
//
// On the course nothing here is visible. When the beacon opens, a storm portal
// tears open above it, the sky turns and lightning walks toward it; a moment
// later the light swallows everyone and the team stands at the arena's own
// beacon, looking at the machine. Each runner picks a power there (1-6), the
// Warden wakes, and from then on this class keeps the Warden, its bots, the
// loose things, the orbs, the hazards and the powers on screen from snapshots
// and events (the angels' wings and sword trails, the speedsters' burning
// trails, sonic waves striking home), and turns the local runner's clicks into
// powers (Powers). Going down there is final: you watch the rest of the team, and when
// everyone is down the fight is lost and starts over.
//
// The Warden is drawn INTERP_DELAY behind like any other remote thing; the
// hazards it makes are pure functions of the event numbers, drawn at the match
// clock the server tests them at. Its hull is a puppet collider in the client's
// copy of the arena world, placed from the same interpolated pose, so a runner
// can stand on its back and ride it.

import * as THREE from 'three';
import { ARENA, BOSS, NET, PHP, POW, powerHp, RIFT, SUPERS } from '../../shared/constants';
import { getArena, type ArenaData } from '../../shared/level/arena';
import type { LevelData } from '../../shared/level/types';
import { clamp, damp, lerp, smoothstep } from '../../shared/math';
import type { Collider } from '../../shared/physics/world';
import { HOLD_AHEAD, HOLD_UP, SHELL_G } from '../../shared/sim/bots';
import { wardenParts, wardenPoint, type PartSphere } from '../../shared/sim/warden';
import { Anim } from '../../shared/physics/character';
import { BAct, BPart, BState, BotKind, BotState, JunkKind, PowAct, type BossSnap, type BotSnap, type C2S, type GameEvent, type JunkSnap, type PlayerSnap, type Stage } from '../../shared/protocol';
import type { AudioEngine } from '../audio/Audio';
import { InterpBuffer } from '../net/Interp';
import type { CameraController } from '../player/CameraController';
import type { LocalPlayer } from '../player/LocalPlayer';
import { ArenaFx, type SwordTrail } from '../render/ArenaFx';
import { ArenaView } from '../render/ArenaView';
import { BotView, JunkView } from '../render/BotViews';
import { CharacterModel } from '../render/CharacterModel';
import type { Particles } from '../render/Effects';
import type { Materials } from '../render/Materials';
import { PortalView } from '../render/PortalView';
import { WardenModel } from '../render/WardenModel';
import { ArenaHud } from '../ui/ArenaHud';
import type { UI } from '../ui/UI';
import type { RemotePlayer } from './Actors';
import { localDir } from '../player/LocalPlayer';
import { POWER_INFO, Powers, SLASHES, type AimTarget } from './Powers';

export interface ArenaHost {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly cam: CameraController;
  readonly ui: UI;
  readonly audio: AudioEngine;
  readonly particles: Particles;
  readonly mats: Materials;
  readonly glowTex: THREE.Texture;
  readonly shadows: boolean;
  readonly course: LevelData;
  send(m: C2S): void;
  meId(): number;
  local(): LocalPlayer | null;
  remote(id: number): RemotePlayer | undefined;
  remotes(): Iterable<RemotePlayer>;
  name(id: number): string;
  /** Show the arena (true) or the course (false): what is drawn, the light, the runner's level. */
  swap(inArena: boolean): void;
  /** How dark and stormy the sky is (0 the course's, 1 the arena's). */
  storm(k: number): void;
  /** The arena runs its own sky flash (lightning over the Anvil). */
  flashSky(k: number): void;
  /** The Warden is down and its rift open: the fight took `fight` seconds (a record to keep). */
  riftOpened(fight: number): void;
}

/** Last power picked in this browser, offered first next time. */
const POWER_KEY = 'skyfall.power.v1';
/** Set once a run has made it through the beacon: the lobby offers a straight rematch. */
export const REACHED_KEY = 'skyfall.warden.v1';

/** How long the arrival camera takes to settle behind the runner. */
const REVEAL = 2.8;

interface BotProxy { id: number; kind: number; view: BotView; buf: InterpBuffer; pos: THREE.Vector3; yaw: number; state: number; hp: number; target: number; seen: number }
interface JunkProxy { id: number; kind: number; view: JunkView; buf: InterpBuffer; pos: THREE.Vector3; vel: THREE.Vector3; holder: number; spin: number; seen: number }
interface OrbVis { id: number; sprite: THREE.Sprite; p0: THREE.Vector3; v: THREE.Vector3; t0: number; pos: THREE.Vector3; turned: boolean }
/** A speedster's trail: where its chest has been lately (newest first), how long ago, where it broke off. */
interface Wake { pts: THREE.Vector3[]; ages: number[]; cut: boolean[]; ghostT: number; running: boolean }
/** An angel's sword trail (newest first), and what its runner's animation was last frame (to hear remote wingbeats). */
interface Blade extends SwordTrail { lastAnim: number }

/** The speedster's colours: its trail, and the afterimages it sheds. */
const SPEED_TRAIL: [number, number, number] = [2.4, 1.8, 0.45];
const SPEED_GHOST: [number, number, number] = [1.7, 1.3, 0.35];
/** How long a sword trail lingers, and how fast the blade must move to leave one. */
const BLADE_LIFE = 0.16, BLADE_SPEED = 7;

const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), tmp3 = new THREE.Vector3(), fwd = new THREE.Vector3();
const vp = { x: 0, y: 0, z: 0 };
const W4: number[] = [];
const S4: number[] = [];

function loadPower(): number {
  try { const k = localStorage.getItem(POWER_KEY); const i = SUPERS.indexOf(k as never); return i; } catch { return -1; }
}
function savePower(i: number) { try { localStorage.setItem(POWER_KEY, SUPERS[i]); } catch { /* private window */ } }

export class Arena {
  readonly data: ArenaData = getArena();
  readonly hud: ArenaHud;
  readonly powers: Powers;
  view: ArenaView | null = null;
  private warden: WardenModel | null = null;
  fx: ArenaFx | null = null;
  /** The storm portal that tears open over the course's beacon. */
  private gatePortal: PortalView | null = null;
  /** The rift the Warden leaves (drawn from the portal, in deep-space colours), and when it takes everyone. */
  private riftPortal: PortalView | null = null;
  private rift: { p: THREE.Vector3; at: number; auto: number } | null = null;
  private riftClaim = -9;
  private warpAt = 0;
  private riftTold = -1;

  stage: Stage = 'course';
  private gateAt = 0;
  private gateBy = 0;
  private gateStrike = 0;
  private whited = false;
  /** Match time the team arrived, and when the Warden will wake at the latest. */
  private arrivedMt = 0;
  private wakeBy = 0;
  awake = false;
  private revealT = -1;
  private readonly revealFrom = new THREE.Vector3();
  private readonly revealLook = new THREE.Vector3();
  /** The power this runner has (index into SUPERS, -1 none) and the card highlighted. */
  myPick = -1;
  private highlight = 0;
  private autoSent = false;
  /** Everyone's power and health (from snapshots and events). */
  readonly picks = new Map<number, number>();
  readonly hps = new Map<number, number>();
  private maxHp: number = BOSS.HP;
  // the Warden
  private readonly wBuf = new InterpBuffer();
  private wSeen = false;
  private wState: number = BState.Dormant;
  private wHp: number = BOSS.HP;
  private wPoise = 0;
  private wFlags = 0;
  private wTarget = 0;
  private readonly wPos = new THREE.Vector3(ARENA.x, ARENA.y, ARENA.z);
  private wYaw = Math.PI;
  private wLift: number = BOSS.LIFT_DEAD;
  private act = { a: 0, at: 0, d: [] as number[] };
  private dyingSince = -1;
  private readonly parts: PartSphere[] = [];
  private readonly booms: { at: number; p: THREE.Vector3; big: boolean }[] = [];
  // everything else that moves
  private readonly bots = new Map<number, BotProxy>();
  private readonly junk = new Map<number, JunkProxy>();
  private readonly orbs = new Map<number, OrbVis>();
  private readonly orbPool: THREE.Sprite[] = [];
  /** Who holds which bot with telekinesis (by 'fx' grab/throw/drop). */
  private readonly holders = new Map<number, number>();
  /** Speedsters' trails and angels' blades (by runner id). */
  private readonly wakes = new Map<number, Wake>();
  private readonly blades = new Map<number, Blade>();
  // the local runner
  down = false;
  private readonly targetsList: AimTarget[] = [];
  private targetsFrame = -1;
  private frame = 0;
  private mt = 0;
  private time = 0;
  private readonly hold = new THREE.Vector3();
  private readonly tethers: [THREE.Vector3, THREE.Vector3][] = [];
  private readonly tetherPool: THREE.Vector3[] = [];
  private tipShown = false;
  private beamHum = 0;
  private stepShake = 0;

  constructor(private readonly host: ArenaHost, hudRoot: HTMLElement) {
    this.hud = new ArenaHud(hudRoot);
    this.hud.onPick = (i) => this.choose(i);
    this.powers = new Powers({
      send: (m) => host.send(m),
      world: () => this.view!.world,
      targets: () => this.targets(),
      holdPoint: (out) => this.myHoldPoint(out),
      slash: (at, dir, combo, hit) => this.fx?.slash(at, dir, combo, hit),
      soar: (at) => this.fx?.soar(at),
      dive: (at, speed) => this.fx?.dive(at, speed),
      sonic: (from, dir, boom) => this.fx?.sonic(from, dir, boom),
      bolt: (pts) => this.fx?.bolt(pts),
      push: (at, dir) => this.fx?.push(at, dir),
      well: (from, dir) => this.fx?.wellThrown(-1, from, dir, this.mt, true),
      flash: (from, to) => this.fx?.flashStrike(from, to),
      thrown: (from, dir) => this.fx?.streak(from, tmp.copy(from).addScaledVector(dir, 7), 0.25, [2.2, 0.6, 1.9], 0.45),
      sound: (kind, k) => host.audio.arena?.power(kind, null, k ?? 1),
      shake: (k) => host.cam.addShake(k),
      fov: (deg) => host.cam.kickFov(deg),
      act: (kind) => host.local()?.model.act(kind, POWER_INFO[SUPERS[Math.max(0, this.myPick)]].hex),
    });
  }

  // ------------------------------------------------------------------ building and resetting

  /** Builds the arena, the Warden and the effects (once; they are kept for every fight after). */
  ensureViews() {
    if (this.view) return;
    const h = this.host;
    this.view = new ArenaView(this.data, h.mats, h.glowTex, h.shadows);
    h.scene.add(this.view.group);
    this.fx = new ArenaFx(h.glowTex, h.particles, this.view.world);
    h.scene.add(this.fx.group);
    this.fx.onStompStart = (x, z) => this.stompLanded(x, z);
    this.warden = new WardenModel(h.glowTex, h.shadows, (p, k) => this.wardenStep(p, k));
    this.warden.root.visible = false;
    h.scene.add(this.warden.root);
    // the hull and the head ride the Warden in the client's copy of the arena, where it is drawn
    this.view.world.puppeteer = (c, t) => this.placePuppet(c, t);
    this.gatePortal = new PortalView(h.glowTex, { beam: false, palette: 'storm' });
    this.gatePortal.group.visible = false;
    this.gatePortal.group.scale.setScalar(2.4);
    h.scene.add(this.gatePortal.group);
    this.riftPortal = new PortalView(h.glowTex, { beam: true, palette: 'rift' });
    this.riftPortal.group.visible = false;
    this.riftPortal.group.scale.setScalar(RIFT.SCALE);
    h.scene.add(this.riftPortal.group);
  }

  /** In the arena: fighting, or (after the Warden) on the way through its rift. */
  get inArena() { return this.stage === 'boss' || this.stage === 'warp'; }
  get level(): LevelData { return this.data.level; }
  get world() { return this.view?.world ?? null; }
  /** The arrival shot (going down is watched like on the course: your body, then your team). */
  get ownsCamera() { return this.inArena && this.revealT >= 0; }
  /** Arriving: the keys wait for the camera. */
  get locksInput() { return this.inArena && this.revealT >= 0 && this.revealT < REVEAL - 0.8; }

  /** Back to the course (a new run, the lobby, leaving). */
  reset() {
    this.stage = 'course';
    this.gateAt = this.gateBy = 0;
    this.whited = false;
    this.awake = false;
    this.revealT = -1;
    this.myPick = -1;
    this.autoSent = false;
    this.picks.clear();
    this.hps.clear();
    this.down = false;
    this.dyingSince = -1;
    this.booms.length = 0;
    this.act = { a: 0, at: 0, d: [] };
    this.wBuf.clear();
    this.wSeen = false;
    this.wState = BState.Dormant;
    this.holders.clear();
    for (const b of this.bots.values()) this.dropBot(b);
    for (const j of this.junk.values()) this.dropJunk(j);
    for (const o of this.orbs.values()) this.dropOrb(o);
    this.bots.clear(); this.junk.clear(); this.orbs.clear(); this.wakes.clear(); this.blades.clear();
    // everyone back to a plain runner
    this.host.local()?.model.setAngel(false);
    for (const rp of this.host.remotes()) rp.model.setAngel(false);
    this.fx?.clearAct();
    this.powers.clear(this.host.local());
    this.hud.show(false);
    this.host.ui.bottom('');
    if (this.view) this.view.group.visible = false;
    if (this.warden) this.warden.root.visible = false;
    if (this.gatePortal) { this.gatePortal.close(true); this.gatePortal.group.visible = false; }
    if (this.riftPortal) { this.riftPortal.close(true); this.riftPortal.group.visible = false; }
    this.rift = null;
    this.riftClaim = -9;
    this.warpAt = 0;
    this.riftTold = -1;
    this.host.storm(0);
  }

  // ------------------------------------------------------------------ the stages

  /** A run starts (or is resumed): where it is. */
  onStart(m: { stage?: Stage; gateAt?: number; picks?: [number, number][]; awake?: boolean; wake?: number; spawns: Record<number, [number, number, number]>; resume?: boolean; rift?: number[]; warpAt?: number }, mt: number) {
    this.reset();
    if (!m.stage || m.stage === 'course' || m.stage === 'race') return;
    this.ensureViews();
    if (m.stage === 'gate') {
      this.openGate(m.gateAt ?? mt + ARENA.GATE_TIME, 0, mt);
      return;
    }
    // a rematch (or a reconnect) straight into the arena
    this.arrive(m.spawns, m.wake ?? mt + ARENA.WAKE_AFTER, mt, !m.resume);
    for (const [id, k] of m.picks ?? []) this.picked(id, k);
    if (m.awake) this.woke(false);
    // back after the Warden fell: its rift is open (or already pulling everyone through)
    if (m.rift) this.openRift(m.rift, -1, false);
    if (m.stage === 'warp' && m.warpAt) this.startWarp(m.warpAt);
  }

  /** The Warden is down: its rift tears open (`fight`: the fight's time, -1 when resuming). */
  private openRift(r: readonly number[], fight: number, loud: boolean) {
    this.ensureViews();
    const h = this.host;
    this.rift = { p: new THREE.Vector3(r[0], r[1], r[2]), at: r[4], auto: r[5] };
    this.riftPortal!.place([r[0], r[1] - RIFT.HEIGHT, r[2]], r[3], r[4]);
    if (fight >= 0) h.riftOpened(fight);
    if (loud) {
      h.ui.big('A rift opens', 'rift mid', 'Where the machine fell, spacetime tears · step through', 3.2);
      h.audio.arena?.gate();
      h.cam.addShake(0.4);
      this.riftPortal!.pulse();
    }
    h.ui.objective('Step into the rift', 8);
  }

  /** Someone stepped into the rift (or it took everyone): the light swallows the team at `at`. */
  private startWarp(at: number) {
    this.stage = 'warp';
    this.warpAt = at;
    this.whited = false;
    this.riftPortal?.pulse();
    this.host.cam.addShake(0.3);
    this.host.ui.objective('Through the rift', 3);
  }

  /** The beacon opens (runner `by` reached it): the storm portal, and in `gateAt` the jump. */
  private openGate(gateAt: number, by: number, mt: number) {
    this.ensureViews();
    this.stage = 'gate';
    this.gateAt = gateAt;
    this.gateBy = by;
    this.gateStrike = 0;
    this.whited = false;
    const b = this.host.course.beacon;
    const gp = this.gatePortal!;
    gp.group.visible = true;
    // face whoever is looking
    const cam = this.host.camera.position;
    gp.place([b[0], b[1] + 3, b[2]], Math.atan2(cam.x - b[0], cam.z - b[2]), mt);
    this.host.audio.arena?.gate();
    this.host.cam.addShake(0.35);
  }

  /** Everyone is through: the arena, at its beacon. `reveal`: play the arrival shot. */
  private arrive(spawns: Record<number, [number, number, number]>, wake: number, mt: number, reveal: boolean) {
    this.ensureViews();
    const h = this.host;
    this.stage = 'boss';
    this.arrivedMt = mt;
    this.wakeBy = wake;
    this.awake = false;
    this.autoSent = false;
    const n = Math.max(1, Object.keys(spawns).length);
    this.maxHp = Math.round(BOSS.HP * (1 + BOSS.HP_PER_PLAYER * (n - 1)));
    this.wHp = this.maxHp;
    this.gatePortal!.close(true);
    this.gatePortal!.group.visible = false;
    this.view!.group.visible = true;
    this.warden!.root.visible = true;
    h.swap(true);
    h.storm(1);
    // the runners at their spots at the beacon
    const local = h.local();
    const me = spawns[h.meId()];
    if (local && me) {
      local.setLevel(this.data.level);
      local.spawn(me[0], me[1], me[2], this.data.level.spawnYaw);
      local.frozen = false;
      h.cam.reset(local.renderPos, this.data.level.spawnYaw);
    }
    for (const rp of h.remotes()) { const s = spawns[rp.id]; if (s) rp.place(s[0], s[1], s[2], this.data.level.spawnYaw); }
    for (const id of Object.keys(spawns)) this.hps.set(Number(id), PHP.MAX);
    this.down = false;
    this.myPick = -1;
    this.highlight = Math.max(0, loadPower());
    this.hud.show(true);
    this.powers.clear(local);
    h.ui.whiteout(0, 1.4);
    h.ui.objective('The Warden · choose your power', 6);
    if (reveal) {
      this.revealT = 0;
      this.revealFrom.copy(h.camera.position);
      h.audio.arena?.arrive();
    } else this.revealT = -1;
    try { localStorage.setItem(REACHED_KEY, '1'); } catch { /* private window */ }
  }

  /** A runner chose a power. */
  private picked(id: number, k: number) {
    this.picks.set(id, k);
    const h = this.host;
    if (id === h.meId()) {
      const first = this.myPick < 0;
      if (k !== this.myPick) { this.myPick = k; this.highlight = k; this.powers.set(k, h.local()); }
      if (first) h.audio.arena?.pick(k);
      const local = h.local();
      if (local) {
        const c = new THREE.Color(POWER_INFO[SUPERS[k]].hex);
        const p = local.renderPos;
        h.particles.burst(p.x, p.y + 1, p.z, 40, 4, 0.7, 0.3, [c.r, c.g, c.b], 1, -1, 2);
        local.model.setAngel(SUPERS[k] === 'angel', POWER_INFO.angel.hex);
        local.model.setPowerColor(POWER_INFO[SUPERS[k]].hex);
      }
      this.hps.set(id, powerHp(SUPERS[k]));
    } else {
      const rp = h.remote(id);
      rp?.model.setAngel(SUPERS[k] === 'angel', POWER_INFO.angel.hex);
      rp?.model.setPowerColor(POWER_INFO[SUPERS[k]].hex);
      if (rp) h.particles.burst(rp.pos.x, rp.pos.y + 1, rp.pos.z, 24, 3, 0.6, 0.25, [1, 1, 1], 0.8, -1, 2);
    }
  }

  /** The runner asked for power `i` (a key or a card). */
  private choose(i: number) {
    if (!this.inArena || i < 0 || i >= SUPERS.length) return;
    if (this.awake) {
      if (!this.tipShown) { this.tipShown = true; this.host.ui.toast('Your power is set once the Warden is awake'); }
      return;
    }
    this.highlight = i;
    savePower(i);
    this.host.send({ t: 'pick', k: i });
    // shown at once; the server's 'pick' confirms it a moment later
    this.picked(this.host.meId(), i);
  }

  private woke(loud: boolean) {
    this.awake = true;
    const h = this.host;
    if (loud) {
      h.ui.big('The Warden wakes', 'warden mid', 'Its core is on its back', 2.4);
      h.audio.arena?.roar(this.wPos, 1.2);
      h.cam.addShake(0.6);
      h.ui.objective('Destroy the Warden', 5);
      this.view!.heat = 0.6;
    }
  }

  // ------------------------------------------------------------------ server messages

  /** Everyone's health and power from a snapshot. */
  onPlayers(ps: PlayerSnap[]) {
    if (!this.inArena) return;
    for (const s of ps) {
      this.hps.set(s[0], s[7]);
      const k = s[8] - 1;
      if (k >= 0 && this.picks.get(s[0]) !== k) {
        // the server's word wins (a random power it chose for someone who never did)
        if (s[0] !== this.host.meId() || this.myPick !== k) this.picked(s[0], k);
      }
    }
  }

  onSnapshot(ts: number, b: BossSnap | undefined, m: BotSnap[] | undefined, j: JunkSnap[] | undefined) {
    if (!this.inArena || !this.view) return;
    if (b) {
      this.wBuf.push(ts, [b[0], b[1], b[2], b[3]]);
      if (!this.wSeen) { this.wSeen = true; this.wPos.set(b[0], ARENA.y, b[1]); this.wYaw = b[2]; this.wLift = b[3]; }
      if (b[4] === BState.Dying && this.wState !== BState.Dying && this.dyingSince < 0) this.dyingSince = this.mt;
      this.wState = b[4];
      this.wHp = b[5];
      this.wPoise = b[9];
      this.wFlags = b[10];
      this.wTarget = b[8];
      if (b[4] !== BState.Dormant && b[4] !== BState.Waking && !this.awake) this.woke(false);
      if (b[6] === BAct.None && this.act.a !== BAct.None && b[4] !== BState.Act) { this.act = { a: 0, at: 0, d: [] }; this.fx!.clearAct(); }
    }
    const h = this.host;
    if (m) {
      for (const s of m) {
        let p = this.bots.get(s[0]);
        if (!p) {
          const view = new BotView(s[1], h.glowTex, h.shadows);
          h.scene.add(view.root);
          p = { id: s[0], kind: s[1], view, buf: new InterpBuffer(), pos: new THREE.Vector3(s[2], s[3], s[4]), yaw: s[5], state: s[6], hp: s[7], target: s[8], seen: ts };
          this.bots.set(s[0], p);
        }
        p.buf.push(ts, [s[2], s[3], s[4], s[5]]);
        p.state = s[6]; p.hp = s[7]; p.target = s[8]; p.seen = ts;
        if (p.state !== BotState.Held) this.holders.delete(p.id);
      }
    }
    if (j) {
      for (const s of j) {
        let p = this.junk.get(s[0]);
        if (!p) {
          const view = new JunkView(s[1], h.glowTex, h.shadows);
          h.scene.add(view.root);
          p = { id: s[0], kind: s[1], view, buf: new InterpBuffer(), pos: new THREE.Vector3(s[2], s[3], s[4]), vel: new THREE.Vector3(), holder: 0, spin: 0, seen: ts };
          view.root.position.copy(p.pos);
          this.junk.set(s[0], p);
        }
        p.buf.push(ts, [s[2], s[3], s[4]]);
        p.holder = s[5]; p.spin = s[6]; p.seen = ts;
      }
    }
    // gone from the snapshot: destroyed (its explosion came as an event) or lost over the edge
    for (const p of this.bots.values()) if (ts - p.seen > 0.3) { this.dropBot(p); this.bots.delete(p.id); }
    for (const p of this.junk.values()) if (ts - p.seen > 0.3) { this.dropJunk(p); this.junk.delete(p.id); }
  }

  /** Returns true when the event belonged to the fight. */
  onEvent(e: GameEvent, mt: number): boolean {
    const h = this.host, me = h.meId();
    switch (e.k) {
      case 'gate':
        this.openGate(e.at, e.id, mt);
        return true;
      case 'arena':
        this.arrive(e.spawns, e.wake, mt, true);
        return true;
      case 'rift':
        this.openRift([e.p[0], e.p[1], e.p[2], e.yaw, e.at, e.auto], e.fight, true);
        return true;
      case 'warp':
        if (e.id && e.id !== h.meId()) h.ui.toast(`${h.name(e.id)} stepped into the rift`);
        this.startWarp(e.at);
        return true;
      case 'pick':
        if (e.id !== me || this.myPick !== e.power) this.picked(e.id, e.power);
        return true;
      case 'wake':
        this.woke(true);
        return true;
      case 'act':
        this.startAct(e.a, e.at, e.d);
        return true;
      case 'hit': {
        this.wHp = Math.min(this.wHp, e.hp);
        const crit = !!e.c;
        const mine = e.by === me;
        const p = tmp.set(e.p[0], e.p[1], e.p[2]);
        this.hud.number(p.x, p.y, p.z, e.n, mine ? (crit ? 'crit' : 'mine') : '');
        if (mine) { this.hud.hitMarker(crit || e.part === BPart.Core || e.part === BPart.Eye); h.audio.arena?.hitConfirm(crit); }
        this.warden?.hit(Math.min(1, e.n / 40));
        const col = this.colorOf(e.by);
        h.particles.burst(p.x, p.y, p.z, Math.min(40, 8 + e.n / 2), 9, 0.4, 0.14, [col.r, col.g, col.b], 1, 10, 1);
        h.particles.burst(p.x, p.y, p.z, 6, 5, 0.35, 0.12, [1, 0.9, 0.7], 1, 12, 2);
        h.audio.arena?.metalHit(p, e.n, e.part === BPart.Core);
        return true;
      }
      case 'stagger':
        if (e.on) {
          const why = e.why === 'crash' ? 'It ran into a conductor · the core is open' : e.why === 'eye' ? 'Right in the eye · the core is open' : 'The core is open · hit it';
          h.ui.big('Staggered', 'cyan mid', why, 2);
          h.audio.arena?.stagger(this.wPos);
          h.cam.addShake(0.3);
        }
        return true;
      case 'overdrive':
        h.ui.big('Overdrive', 'warden mid', 'Half broken, and faster for it', 2.6);
        h.audio.arena?.overdrive(this.wPos);
        h.cam.addShake(0.7);
        if (this.view) this.view.heat = 1;
        return true;
      case 'fall': {
        this.dyingSince = this.mt;
        const by = e.by === me ? 'You landed the last blow' : e.by ? `${h.name(e.by)} landed the last blow` : 'The storm took it down';
        h.ui.big('The Warden falls', 'gold mid', by, 5);
        h.audio.arena?.fall(this.wPos);
        h.cam.addShake(0.9);
        // it comes apart from the inside out
        this.booms.length = 0;
        for (let i = 0; i < 11; i++) {
          wardenParts(this.wPos.x, ARENA.y, this.wPos.z, this.wYaw, this.wLift, this.parts);
          const s = this.parts[Math.floor(Math.random() * this.parts.length)];
          this.booms.push({ at: this.mt + 0.25 + i * 0.3 + Math.random() * 0.15, p: new THREE.Vector3(s.x, s.y, s.z), big: i === 10 });
        }
        return true;
      }
      case 'bot': {
        const p = tmp.set(e.p[0], e.p[1], e.p[2]);
        this.fx?.flash(p, 3, 0xff7040, 0.2);
        h.particles.burst(p.x, p.y, p.z, 14, 6, 0.5, 0.2, [1, 0.6, 0.3], 1, 8, 4);
        h.audio.arena?.launch(p);
        return true;
      }
      case 'bhit': {
        const b = this.bots.get(e.id);
        if (b) {
          b.view.hit();
          if (e.by === me) { this.hud.number(b.pos.x, b.pos.y + 1.2, b.pos.z, e.n, 'bot'); this.hud.hitMarker(false); }
          h.particles.burst(b.pos.x, b.pos.y + 0.6, b.pos.z, 8, 6, 0.3, 0.12, [1, 0.8, 0.5], 1, 12, 1);
          h.audio.arena?.botHit(b.pos);
        }
        return true;
      }
      case 'bdie': {
        const p = tmp.set(e.p[0], e.p[1], e.p[2]);
        this.fx?.explosion(p, 1.5, 3);
        h.audio.arena?.botDie(p);
        if (e.by === me) h.cam.addShake(0.12);
        const b = this.bots.get(e.id);
        if (b) { this.dropBot(b); this.bots.delete(e.id); }
        this.holders.delete(e.id);
        return true;
      }
      case 'orb': {
        const turned = this.orbs.has(e.id);
        let o = this.orbs.get(e.id);
        if (!o) {
          const sprite = this.orbPool.pop() ?? new THREE.Sprite(new THREE.SpriteMaterial({ map: h.glowTex, color: 0xff4a8a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
          sprite.scale.setScalar(1.3);
          sprite.visible = true;
          h.scene.add(sprite);
          o = { id: e.id, sprite, p0: new THREE.Vector3(), v: new THREE.Vector3(), t0: 0, pos: new THREE.Vector3(), turned: false };
          this.orbs.set(e.id, o);
          h.audio.arena?.orbFire(tmp.set(e.p[0], e.p[1], e.p[2]));
        }
        o.p0.set(e.p[0], e.p[1], e.p[2]); o.v.set(e.v[0], e.v[1], e.v[2]); o.t0 = e.t; o.pos.copy(o.p0);
        if (turned) { o.turned = true; (o.sprite.material as THREE.SpriteMaterial).color.set(0xff8ae0); this.fx?.flash(o.pos, 2, 0xff90ff, 0.18); h.audio.arena?.power('push', o.pos, 0.6); }
        return true;
      }
      case 'oend': {
        const o = this.orbs.get(e.id);
        const p = tmp.set(e.p[0], e.p[1], e.p[2]);
        this.fx?.flash(p, 2.2, 0xff5aa0, 0.2);
        h.particles.burst(p.x, p.y, p.z, 12, 5, 0.35, 0.14, [1, 0.4, 0.7], 1, 4, 0);
        if (o) { this.dropOrb(o); this.orbs.delete(e.id); }
        return true;
      }
      case 'hurt':
        this.hurt(e);
        return true;
      case 'fx':
        this.remoteFx(e.id, e.f, e.d, mt);
        return true;
      case 'boom': {
        const p = tmp.set(e.p[0], e.p[1], e.p[2]);
        this.fx?.explosion(p, e.r, e.c);
        const d = p.distanceTo(h.camera.position);
        h.cam.addShake(clamp((e.r * 3) / Math.max(4, d), 0, e.c === 5 ? 0.8 : 0.5));
        h.audio.arena?.boom(p, e.r, e.c);
        return true;
      }
      case 'thunder': {
        const p = tmp.set(e.p[0], e.p[1], e.p[2]);
        this.fx?.thunder(p);
        this.host.flashSky(1);
        h.cam.addShake(e.id === me ? 0.6 : 0.35);
        h.audio.arena?.thunderclap(p);
        if (e.id === me) h.ui.objective('The storm answers', 2);
        return true;
      }
      case 'shell': {
        const q = tmp.set(e.q[0], e.q[1], e.q[2]);
        // when it comes down on the marker: y0 + vy T - G T^2 / 2 = q.y
        const vy = e.v[1], dy = e.p[1] - e.q[1];
        const T = (vy + Math.sqrt(Math.max(0, vy * vy + 2 * SHELL_G * dy))) / SHELL_G;
        this.fx?.shell(e.id, q, e.t + T, e.t);
        const p = tmp2.set(e.p[0], e.p[1], e.p[2]);
        this.fx?.flash(p, 3.5, 0xffa040, 0.18);
        h.particles.burst(p.x, p.y, p.z, 16, 6, 0.9, 0.35, [0.5, 0.48, 0.46], 0.7, -1, 3);
        // which cannon: the one on the side it left from
        if (this.warden) this.warden.recoil(((p.x - this.wPos.x) * Math.cos(this.wYaw) - (p.z - this.wPos.z) * Math.sin(this.wYaw)) < 0 ? -1 : 1);
        h.audio.arena?.mortar(p);
        return true;
      }
      case 'well':
        if (e.s === 'open') { this.fx?.wellOpened(e.id, tmp.set(e.p[0], e.p[1], e.p[2]).clone(), null); h.audio.arena?.power('wellOpen', tmp.set(e.p[0], e.p[1], e.p[2]), 1); }
        else { this.fx?.wellClosed(e.id); }
        return true;
      default:
        return false;
    }
  }

  /** The Warden starts an ability: its tell and its sound. */
  private startAct(a: number, at: number, d: number[]) {
    this.act = { a, at, d };
    this.fx?.setAct(a, at, d);
    const au = this.host.audio.arena;
    switch (a) {
      case BAct.Stomp: au?.tell('stomp', this.wPos); break;
      case BAct.Beam: au?.tell('beam', this.wPos); break;
      case BAct.Mortar: au?.tell('mortar', this.wPos); break;
      case BAct.Deploy: au?.tell('deploy', this.wPos); break;
      case BAct.Charge: au?.tell('charge', this.wPos); this.host.cam.addShake(0.15); break;
      case BAct.Swipe: au?.tell('swipe', this.wPos); break;
      case BAct.Shock: au?.tell('shock', this.wPos); break;
    }
  }

  /** The stomp's wave leaves the Warden's feet. */
  private stompLanded(x: number, z: number) {
    const h = this.host;
    tmp.set(x, ARENA.y, z);
    h.audio.arena?.boom(tmp, 8, 7);
    const local = h.local();
    const d = local ? Math.hypot(local.pos.x - x, local.pos.z - z) : 30;
    h.cam.addShake(clamp(0.8 - d / 45, 0.1, 0.7));
    h.particles.dust(x, ARENA.y, z, 1);
  }

  /** A footfall of the Warden: the floor shakes near it. */
  private wardenStep(p: THREE.Vector3, k: number) {
    const h = this.host;
    const d = p.distanceTo(h.camera.position);
    if (d < 40) this.stepShake = Math.max(this.stepShake, clamp((1 - d / 40) * 0.2 * k, 0, 0.2));
    h.particles.dust(p.x, p.y, p.z, 0.35 * k);
    h.audio.arena?.step(p, k);
  }

  /** Someone was hurt (or only shoved). */
  private hurt(e: Extract<GameEvent, { k: 'hurt' }>) {
    const h = this.host;
    this.hps.set(e.id, e.hp);
    if (e.id !== h.meId()) {
      const rp = h.remote(e.id);
      if (rp && e.n > 0) h.particles.burst(rp.pos.x, rp.pos.y + 1.1, rp.pos.z, 14, 5, 0.4, 0.15, [1, 0.35, 0.3], 1, 8, 1);
      return;
    }
    const local = h.local();
    if (!local || local.dead) return;
    if (e.v && (e.v[0] || e.v[1] || e.v[2])) local.shove(e.v);
    if (e.n <= 0) return;
    // which way it came from, on screen
    let ang: number | null = null;
    if (e.from) {
      h.camera.getWorldDirection(fwd);
      fwd.y = 0; fwd.normalize();
      const dx = e.from[0] - local.pos.x, dz = e.from[2] - local.pos.z;
      if (Math.hypot(dx, dz) > 1.2) ang = Math.atan2(dx * -fwd.z + dz * fwd.x, dx * fwd.x + dz * fwd.z) * -1;
    }
    this.hud.hurt(ang, e.n / 30);
    h.cam.addShake(clamp(e.n / 45, 0.15, 0.6));
    h.audio.arena?.hurt(e.n, e.src);
    const p = local.renderPos;
    h.particles.burst(p.x, p.y + 1.1, p.z, 18, 5, 0.4, 0.15, [1, 0.35, 0.3], 1, 8, 1);
  }

  /** The local runner is down (the 'death' event). In the arena that is final: the team fights on, or the fight is lost. */
  localDown(e: Extract<GameEvent, { k: 'death' }>, teammates: number) {
    const h = this.host;
    const local = h.local();
    if (!local || local.dead) return;
    local.die(e.v);
    local.doomed = false;
    this.down = true;
    this.hps.set(h.meId(), 0);
    h.cam.addShake(0.8);
    h.audio.death(e.cause);
    const txt = e.cause === 'fall' ? 'You fell' : e.cause === 'bot' ? 'Swarmed' : 'Crushed';
    h.ui.big(txt, 'danger mid', teammates > 0 ? 'You are out of the fight · watch your team' : 'The Warden stands · start over', 3);
    h.particles.burst(e.p[0], e.p[1] + 1, e.p[2], 50, 7, 0.9, 0.35, [1, 0.45, 0.25], 1, 5);
    this.powers.held = null;
  }

  /** Someone used a power: draw it (the user's own was drawn when it happened; only what the server adds is drawn here). */
  private remoteFx(id: number, f: number, d: number[], mt: number) {
    const h = this.host, fx = this.fx;
    if (!fx) return;
    const mine = id === h.meId();
    const rp = mine ? undefined : h.remote(id);
    const pos = (i: number) => new THREE.Vector3(d[i], d[i + 1], d[i + 2]);
    const hex = POWER_INFO[SUPERS[Math.max(0, this.picks.get(id) ?? 0)]].hex;
    switch (f) {
      case PowAct.Slash:
        if (!mine) {
          const combo = clamp(d[7] ?? 0, 0, 3) | 0;
          fx.slash(pos(0).setY(d[1]), tmp2.set(d[3], 0, d[5]).normalize().clone(), combo, !!d[6]);
          rp?.model.act(SLASHES[combo], hex);
          h.audio.arena?.power('slash', pos(0), combo >= 2 ? 0.9 : 0.7);
        }
        break;
      case PowAct.Soar:
        if (!mine) { fx.soar(pos(0)); rp?.model.act('soar', hex); h.audio.arena?.power('soar', pos(0), 0.8); }
        break;
      case PowAct.Dive:
        if (!mine) { fx.dive(pos(0), d[3]); h.audio.arena?.power('dive', pos(0), 1); h.cam.addShake(clamp(0.5 - pos(0).distanceTo(h.camera.position) / 60, 0, 0.4)); }
        break;
      case PowAct.Blast: case PowAct.Boom:
        if (!mine) {
          const boom = f === PowAct.Boom;
          fx.sonic(pos(0), pos(3), boom);
          rp?.model.act(boom ? 'boom' : 'blast', hex);
          h.audio.arena?.power(boom ? 'boom' : 'blast', pos(0), 0.8);
          if (boom) h.cam.addShake(clamp(0.45 - pos(0).distanceTo(h.camera.position) / 50, 0, 0.35));
        }
        break;
      case PowAct.Impact: {
        // a sonic wave struck something: its impact, and the Warden rocks with it
        const at = pos(0), k = d[6] ?? 1;
        fx.impact(at, d[4], d[5], d[3], k);
        if (d[3] === 0) { this.warden?.shoved(d[4], d[5], k); h.cam.addShake(id === h.meId() ? 0.12 : 0.05); }
        h.audio.arena?.power('impact', at, (d[3] === 0 ? 1 : 0.6) * (id === h.meId() ? 1 : 0.6));
        break;
      }
      case PowAct.Grab:
        if (d[0] === 1) this.holders.set(d[1], id);
        if (mine) this.powers.held = { kind: d[0] as 1 | 2, id: d[1], at: mt };
        else { rp?.model.act('hold', hex); h.audio.arena?.power('grab', rp?.pos ?? null, 0.6); }
        break;
      case PowAct.Throw:
        if (d[0] === 1) this.holders.delete(d[1]);
        if (!mine && rp) {
          const from = tmp2.set(rp.pos.x + Math.sin(rp.yaw) * HOLD_AHEAD, rp.pos.y + HOLD_UP, rp.pos.z + Math.cos(rp.yaw) * HOLD_AHEAD);
          fx.streak(from, tmp3.copy(from).add(tmp.set(d[2], d[3], d[4]).multiplyScalar(7)), 0.25, [2.2, 0.6, 1.9], 0.45);
          rp.model.act('throw', hex);
          h.audio.arena?.power('throw', rp.pos, 0.7);
        }
        break;
      case PowAct.Drop:
        if (d[0] === 1) this.holders.delete(d[1]);
        if (mine && this.powers.held && this.powers.held.id === d[1]) this.powers.held = null;
        break;
      case PowAct.Push:
        if (!mine) { fx.push(pos(0).setY(d[1] + 1.25), pos(3)); rp?.model.act('push', hex); h.audio.arena?.power('push', pos(0), 0.7); }
        break;
      case PowAct.Bolt: {
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i + 2 < d.length; i += 3) pts.push(pos(i));
        if (mine) { if (pts.length > 2) fx.bolt(pts.slice(1), 0.16, 0.12); }
        else if (pts.length >= 2) { pts[0].y += 1.25; fx.bolt(pts); rp?.model.act('cast', hex); h.audio.arena?.power('bolt', pts[0], 0.5); }
        break;
      }
      case PowAct.Well:
        fx.wellThrown(d[0], pos(1).setY(d[2] + 1.25 + (mine ? 0 : 0)), pos(4), mine ? this.mt - 0.03 : mt - 0.05, mine);
        if (!mine) { rp?.model.act('cast', hex); h.audio.arena?.power('wellThrow', pos(1), 0.6); }
        break;
      case PowAct.Flash:
        if (!mine) { fx.flashStrike(pos(0), pos(3)); h.audio.arena?.power('flash', pos(3), 0.7); }
        break;
    }
  }

  // ------------------------------------------------------------------ the local runner's hooks

  slammed(speed: number) { if (this.inArena && this.host.local()) this.powers.diveLanded(this.mt, this.host.local()!, speed); }
  /** The local angel's wings beat (1), or it soared (2: that one is drawn by the power itself). */
  beat(kind: number) {
    const local = this.host.local();
    if (!this.inArena || !local || kind !== 1) return;
    local.model.wingBeat(1);
    const p = local.renderPos, y = local.motor.yaw;
    this.fx?.feathers(tmp.set(p.x - Math.sin(y) * 0.4, p.y + 1.1, p.z - Math.cos(y) * 0.4), 4, 1.2, 0.5);
    this.host.audio.arena?.power('beat', null, 1);
  }
  flashed(from: { x: number; y: number; z: number }) { if (this.inArena && this.host.local()) this.powers.flashEnded(this.mt, this.host.local()!, from); }

  /** Keys the arena listens to (returns true when it used the key). */
  onKey(code: string): boolean {
    if (!this.inArena) return false;
    const m = /^Digit([1-6])$/.exec(code) ?? /^Numpad([1-6])$/.exec(code);
    if (m) { this.choose(Number(m[1]) - 1); return true; }
    return false;
  }

  /** The mouse wheel runs along the cards while choosing. */
  wheel(steps: number) {
    if (!steps || !this.choosing) return;
    this.highlight = (this.highlight + (steps > 0 ? 1 : -1) + SUPERS.length) % SUPERS.length;
    this.host.audio.click();
  }

  /** Choosing a power right now (on arrival, before picking). */
  get choosing() { return this.inArena && !this.awake && this.myPick < 0; }

  // ------------------------------------------------------------------ per frame

  /** Everything the powers can lock onto this frame. */
  private targets(): AimTarget[] {
    if (this.targetsFrame === this.frame) return this.targetsList;
    this.targetsFrame = this.frame;
    const L = this.targetsList;
    let n = 0;
    const put = (kind: 0 | 1 | 2, id: number, part: number, x: number, y: number, z: number, r: number, junk?: number) => {
      let t = L[n];
      if (!t) { t = { kind, id, part, pos: new THREE.Vector3(), r }; L[n] = t; }
      t.kind = kind; t.id = id; t.part = part; t.pos.set(x, y, z); t.r = r; t.junk = junk;
      n++;
    };
    if (this.wSeen && this.wState !== BState.Dying && this.wState !== BState.Dead) {
      wardenParts(this.wPos.x, ARENA.y, this.wPos.z, this.wYaw, this.wLift, this.parts);
      for (const s of this.parts) put(0, 0, s.part, s.x, s.y, s.z, s.r);
    }
    const me = this.host.meId();
    for (const b of this.bots.values()) put(1, b.id, 0, b.pos.x, b.pos.y + (b.kind === BotKind.Skitter ? 0.5 : 0), b.pos.z, 0.9);
    for (const j of this.junk.values()) {
      if (j.holder && j.holder !== me) continue;
      put(2, j.id, 0, j.pos.x, j.pos.y + (j.kind === JunkKind.Canister ? 0.55 : 0.3), j.pos.z, 0.75, j.kind);
    }
    L.length = n;
    return L;
  }

  private myHoldPoint(out: THREE.Vector3): THREE.Vector3 {
    const local = this.host.local();
    if (!local) return out.set(0, 0, 0);
    const y = local.motor.yaw, p = local.renderPos;
    return out.set(p.x + Math.sin(y) * HOLD_AHEAD, p.y + HOLD_UP, p.z + Math.cos(y) * HOLD_AHEAD);
  }

  private placePuppet(c: Collider, t: number) {
    // the hull where it is drawn: the interpolated pose at the same delay
    if (this.wBuf.sample(t - NET.INTERP_DELAY, W4, [2])) { vp.x = W4[0]; vp.z = W4[1]; } else { vp.x = this.wPos.x; vp.z = this.wPos.z; W4[2] = this.wYaw; W4[3] = this.wLift; }
    const yaw = W4[2], lift = W4[3];
    if (c.id === this.data.hull) wardenPoint(vp.x, ARENA.y, vp.z, yaw, 0, lift, 0, vp);
    else wardenPoint(vp.x, ARENA.y, vp.z, yaw, 0, lift + 0.5, 5.6, vp);
    c.setTransform(vp.x, vp.y, vp.z, yaw);
  }

  /**
   * Every frame. `press`/`hold`: the power button this frame; `can`: the runner
   * may act (not paused, not in a menu).
   */
  update(dt: number, time: number, mt: number, press: boolean, hold: boolean, can: boolean, alt = false) {
    this.frame++;
    this.time = time;
    this.mt = mt;
    const h = this.host;
    if (this.stage === 'gate') { this.updateGate(dt, time, mt); return; }
    if (!this.inArena || !this.view || !this.warden || !this.fx) return;
    const renderT = mt - NET.INTERP_DELAY;
    const local = h.local();

    // the Warden
    if (this.wBuf.sample(renderT, W4, [2])) { this.wPos.set(W4[0], ARENA.y, W4[1]); this.wYaw = W4[2]; this.wLift = W4[3]; }
    const act = this.wState === BState.Act ? this.act : null;
    const look = this.playerPos(this.wTarget);
    const dying = this.wState === BState.Dying || this.wState === BState.Dead;
    this.warden.update({
      x: this.wPos.x, z: this.wPos.z, yaw: this.wYaw, lift: this.wLift,
      state: this.wState, act: act ? act.a : BAct.None,
      actT: dying ? Math.max(0, mt - this.dyingSince) : act ? mt - act.at : 0,
      actD: act ? act.d : null,
      overdrive: (this.wFlags & 1) !== 0, hpK: clamp(this.wHp / this.maxHp, 0, 1), look, mt,
    }, ARENA.y, dt, time);
    this.fx.swipeCenter.set(this.wPos.x, ARENA.y, this.wPos.z);
    if (this.stepShake > 0.01) { h.cam.addShake(this.stepShake); this.stepShake = 0; }
    // the death throes
    for (let i = this.booms.length - 1; i >= 0; i--) {
      const b = this.booms[i];
      if (mt < b.at) continue;
      this.booms.splice(i, 1);
      this.fx.explosion(b.p, b.big ? 9 : 4, b.big ? 5 : 0);
      h.audio.arena?.boom(b.p, b.big ? 9 : 4, b.big ? 5 : 0);
      h.cam.addShake(b.big ? 0.8 : 0.25);
      if (b.big) this.host.flashSky(1);
    }

    // bots, loose things, orbs
    for (const b of this.bots.values()) {
      if (b.buf.sample(renderT, S4, [3])) { b.pos.set(S4[0], S4[1], S4[2]); b.yaw = S4[3]; }
      // a bot held by this runner hangs where the runner is drawn, not where the server last saw it
      if (b.state === BotState.Held && this.holders.get(b.id) === h.meId()) { this.myHoldPoint(tmp); b.pos.lerp(tmp.setY(tmp.y - 0.5), damp(14, dt)); }
      b.view.update(b.pos, b.yaw, b.state, dt, time);
    }
    const me = h.meId();
    for (const j of this.junk.values()) {
      tmp2.copy(j.pos);
      if (j.holder === me) { this.myHoldPoint(tmp); j.pos.lerp(tmp.setY(tmp.y - 0.5), damp(14, dt)); }
      else if (j.buf.sample(renderT, S4)) j.pos.set(S4[0], S4[1], S4[2]);
      if (dt > 0) j.vel.subVectors(j.pos, tmp2).divideScalar(dt);
      j.view.update(j.pos, j.spin, j.vel, j.holder !== 0, time);
    }
    for (const o of this.orbs.values()) {
      const k = Math.max(0, mt - o.t0);
      o.pos.copy(o.p0).addScaledVector(o.v, k);
      o.sprite.position.copy(o.pos);
      o.sprite.scale.setScalar(1.1 + Math.sin(time * 30 + o.id) * 0.15);
      if (Math.random() < dt * 40) h.particles.emit(o.pos.x, o.pos.y, o.pos.z, (Math.random() - 0.5) * 1.5, (Math.random() - 0.5) * 1.5, (Math.random() - 0.5) * 1.5, 0.3, 0.16, 1, o.turned ? 0.55 : 0.3, o.turned ? 0.95 : 0.6, 0.9, 0, -0.3);
      if (k > 5) { this.dropOrb(o); this.orbs.delete(o.id); }
    }

    // telekinesis: a line of force from each holder's hands to what it holds
    this.tethers.length = 0;
    let ti = 0;
    const tether = (hand: THREE.Vector3, item: THREE.Vector3) => {
      const a = this.tetherPool[ti] ?? (this.tetherPool[ti] = new THREE.Vector3());
      const b = this.tetherPool[ti + 1] ?? (this.tetherPool[ti + 1] = new THREE.Vector3());
      ti += 2;
      a.copy(hand); b.copy(item);
      this.tethers.push([a, b]);
    };
    for (const j of this.junk.values()) {
      if (!j.holder) continue;
      const hp = this.handOf(j.holder, tmp3);
      if (hp) tether(hp, tmp.copy(j.pos).setY(j.pos.y + 0.4));
    }
    for (const [bid, pid] of this.holders) {
      const b = this.bots.get(bid);
      const hp = this.handOf(pid, tmp3);
      if (b && hp) tether(hp, tmp.copy(b.pos).setY(b.pos.y + 0.5));
    }

    this.view.update(time, dt, h.camera.position, mt);
    if (this.view.arcStruck) h.audio.arena?.arc(this.view.arcStruck);
    this.fx.update(dt, time, mt, h.camera.position, this.warden.eyeWorld, this.tethers);
    // the beam hums while it is on
    const beam = this.fx.beamOn;
    this.beamHum += ((beam ? 1 : 0) - this.beamHum) * damp(10, dt);
    h.audio.arena?.beam(this.beamHum, this.fx.beamEnd);
    if (beam) h.cam.addShake(clamp(0.05 - this.fx.beamEnd.distanceTo(h.camera.position) / 600, 0, 0.05));

    // choosing, and the auto-pick just before it wakes
    if (!this.awake && this.myPick < 0 && !this.autoSent && mt > this.wakeBy - 1.2) { this.autoSent = true; this.choose(this.highlight); }

    // the local runner's power
    if (local && !local.dead) {
      if (this.choosing && press && !this.awake) { this.choose(this.highlight); press = false; }
      this.powers.update(mt, local, h.camera, press, hold, can && !this.locksInput && this.myPick >= 0, alt && can);
    }
    this.updateWakes(dt);
    this.updateBlades(dt);

    this.updateHud(dt, mt, local);
    this.updateAudio(dt, local);
    this.updateRift(dt, time, mt, local);
    if (this.revealT >= 0) this.revealT += dt;
    if (this.revealT > REVEAL) this.endReveal();
  }

  /** The rift: it breathes, a runner who walks into it takes the team through, and the warp swallows them. */
  private updateRift(dt: number, time: number, mt: number, local: LocalPlayer | null) {
    const r = this.rift;
    if (!r || !this.riftPortal) return;
    const h = this.host;
    this.riftPortal.update(time, dt, mt, h.camera.position);
    if (this.stage === 'boss' && local && !local.dead && mt >= r.at) {
      // through the ring: the chest within its opening (the server checks it again)
      const p = local.renderPos;
      const d = Math.hypot(p.x - r.p.x, p.y + 1.2 - r.p.y, p.z - r.p.z);
      if (d < RIFT.ENTER && time - this.riftClaim > 0.5) { this.riftClaim = time; h.send({ t: 'rift' }); }
      const left = Math.ceil(r.auto - mt);
      if (left !== this.riftTold && left <= 10 && left > 0) { this.riftTold = left; h.ui.objective(`Step into the rift · it takes everyone in ${left} s`, 1.2); }
    }
    if (this.stage === 'warp' && !this.whited && this.warpAt - mt < 0.7) { this.whited = true; h.ui.whiteout(1, 0.6, false, 'rift'); h.audio.arena?.swallow(); }
  }

  /** The beacon is open: the storm gathers over it, then the light takes everyone. */
  private updateGate(dt: number, time: number, mt: number) {
    const h = this.host;
    const gp = this.gatePortal!;
    gp.update(time, dt, mt, h.camera.position);
    const left = this.gateAt - mt;
    const k = clamp(1 - left / ARENA.GATE_TIME, 0, 1);
    h.storm(k * 0.8);
    h.cam.addShake(dt * (0.3 + k * 1.4));
    // lightning walks in toward the portal
    this.gateStrike -= dt;
    if (this.gateStrike <= 0 && this.fx) {
      this.gateStrike = lerp(0.55, 0.12, k);
      const b = h.course.beacon;
      const a = Math.random() * Math.PI * 2, r = lerp(40, 4, k) * (0.5 + Math.random() * 0.5);
      tmp.set(b[0] + Math.sin(a) * r, b[1] + 0.2, b[2] + Math.cos(a) * r);
      this.fx.thunder(tmp);
      h.flashSky(0.8);
      h.audio.arena?.thunderclap(tmp);
    }
    this.fx?.update(dt, time, mt, h.camera.position, tmp.set(0, -1e4, 0), []);
    if (!this.whited && left < 0.7) { this.whited = true; h.ui.whiteout(1, 0.6, false, 'storm'); h.audio.arena?.swallow(); }
  }

  private endReveal() {
    this.revealT = -1;
    const local = this.host.local();
    if (local) this.host.cam.reset(local.renderPos, this.host.cam.yaw);
  }

  /** The camera, when the arena has it (arriving, or down). */
  updateCamera(dt: number) {
    const h = this.host, cam = h.camera;
    const local = h.local();
    if (this.revealT >= 0) {
      // from above the Warden, round and down to over the runner's shoulder
      const u = clamp(this.revealT / REVEAL, 0, 1);
      const c = tmp.set(ARENA.x, ARENA.y, ARENA.z);
      const k0 = tmp2.set(c.x - 22, c.y + 24, c.z - 8);
      const k1 = tmp3.set(c.x + 16, c.y + 14, c.z - 42);
      const s = local ? local.renderPos : c;
      const k2 = fwd.set(s.x - 1.2, s.y + 2.6, s.z - 5.2);
      const a = smoothstep(0, 0.55, u), b = smoothstep(0.45, 1, u);
      const p = k0.lerp(k1, a).lerp(k2, b);
      cam.position.copy(p);
      this.revealLook.set(this.wPos.x, ARENA.y + 8, this.wPos.z).lerp(tmp.set(s.x, s.y + 1.8, s.z + 8), smoothstep(0.55, 1, u));
      cam.lookAt(this.revealLook);
      if (cam.fov !== 62) { cam.fov = 62; cam.updateProjectionMatrix(); }
      // a key or a click skips it
      return;
    }
  }

  /** Skip the arrival shot. */
  skipReveal() { if (this.revealT >= 0 && this.revealT > 0.4) this.endReveal(); }

  private updateHud(dt: number, mt: number, local: LocalPlayer | null) {
    const hud = this.hud, h = this.host;
    hud.bossView({
      name: BOSS.NAME, hpK: this.wHp / this.maxHp, poiseK: this.wPoise / BOSS.POISE,
      overdrive: (this.wFlags & 1) !== 0, staggered: this.wState === BState.Stagger, dormant: this.wState === BState.Dormant || this.wState === BState.Waking,
    });
    hud.tick(dt);
    const max = powerHp(this.myPick >= 0 ? SUPERS[this.myPick] : null);
    const hp = this.hps.get(h.meId()) ?? max;
    hud.meView(this.myPick, local && local.dead ? 0 : hp, max);
    const P = this.powers;
    if (this.myPick >= 0) {
      const heat = P.heatAt(mt);
      const grounded = !!local && (local.motor.body.grounded || local.motor.coyote > 0);
      hud.ring(P.readiness(mt), {
        hot: P.kind === 'lightning' && (mt < P.overheatUntil || heat > 72),
        // the angel and sonic force: one pip for R (the soar or the dive; the boom)
        pips: P.kind === 'angel' || P.kind === 'sonic' ? [P.altReadiness(mt, grounded) >= 1 ? 1 : 0, 1] : undefined,
        // the angel's wings: how much strength they have left
        wing: P.kind === 'angel' && local ? P.wingStrength(local) : undefined,
      });
    }
    // the bracket round the lock
    const lock = this.myPick >= 0 && local && !local.dead ? P.lock : null;
    if (lock) {
      tmp.copy(lock.pos).project(h.camera);
      if (tmp.z < 1) {
        const el = h.ui.hudRoot;
        const w = el.clientWidth, hh = el.clientHeight;
        const d = lock.pos.distanceTo(h.camera.position);
        const size = (lock.r / Math.max(1, d)) * hh * 1.6 + 18;
        hud.lock((tmp.x + 1) / 2 * w, (1 - tmp.y) / 2 * hh, size);
      } else hud.lock(null);
    } else hud.lock(null);
    hud.updateNumbers(dt, (x, y, z) => {
      tmp.set(x, y, z).project(h.camera);
      if (tmp.z >= 1) return null;
      const el = h.ui.hudRoot;
      return [(tmp.x + 1) / 2 * el.clientWidth, (1 - tmp.y) / 2 * el.clientHeight];
    });
    // the cards
    if (this.choosing) {
      const wake = Math.max(0, this.wakeBy - mt);
      hud.selectView({ current: this.highlight, chosen: false, compact: false, note: `Press 1-6, or scroll and click · it wakes in ${Math.ceil(wake)} s` });
    } else if (!this.awake && this.myPick >= 0) {
      const waiting = [...this.hps.keys()].some((id) => !this.picks.has(id));
      hud.selectView({ current: this.myPick, chosen: true, compact: true, note: waiting ? 'Waiting for the others · 1-6 to change' : '1-6 to change · it is waking' });
    } else hud.selectView(null);
  }

  /** How much danger the vignette shows (0..1). */
  get danger(): number {
    if (!this.inArena) return 0;
    const local = this.host.local();
    if (!local || local.dead) return 0;
    const hp = this.hps.get(this.host.meId()) ?? PHP.MAX;
    return clamp((45 - hp) / 45, 0, 1);
  }

  private updateAudio(dt: number, local: LocalPlayer | null) {
    const au = this.host.audio.arena;
    if (!au) return;
    let intensity = this.awake ? 0.55 : 0.2;
    if ((this.wFlags & 1) !== 0) intensity = 0.85;
    if (this.wState === BState.Stagger) intensity = 0.4;
    if (this.wState === BState.Dying || this.wState === BState.Dead) intensity = 0;
    if (local && !local.dead) {
      const d = Math.hypot(local.pos.x - this.wPos.x, local.pos.z - this.wPos.z);
      intensity += clamp((25 - d) / 25, 0, 1) * 0.15;
    }
    au.music(dt, clamp(intensity, 0, 1), this.inArena);
  }

  // ------------------------------------------------------------------ helpers

  private playerPos(id: number): THREE.Vector3 | null {
    if (!id) return null;
    const h = this.host;
    if (id === h.meId()) return h.local()?.renderPos ?? null;
    return h.remote(id)?.pos ?? null;
  }

  /** Where a runner's hands are (for tethers). */
  private handOf(id: number, out: THREE.Vector3): THREE.Vector3 | null {
    const h = this.host;
    if (id === h.meId()) {
      const l = h.local();
      if (!l || l.dead) return null;
      return out.set(l.renderPos.x + Math.sin(l.motor.yaw) * 0.45, l.renderPos.y + 1.45, l.renderPos.z + Math.cos(l.motor.yaw) * 0.45);
    }
    const rp = h.remote(id);
    if (!rp) return null;
    return out.set(rp.pos.x + Math.sin(rp.yaw) * 0.45, rp.pos.y + 1.45, rp.pos.z + Math.cos(rp.yaw) * 0.45);
  }

  private colorOf(id: number): THREE.Color {
    const k = this.picks.get(id);
    return tmpC.set(k === undefined ? 0xffc080 : POWER_INFO[SUPERS[k]].hex);
  }

  private dropBot(b: BotProxy) { this.host.scene.remove(b.view.root); b.view.dispose(); }
  private dropJunk(j: JunkProxy) { this.host.scene.remove(j.view.root); j.view.dispose(); }
  private dropOrb(o: OrbVis) { this.host.scene.remove(o.sprite); o.sprite.visible = false; this.orbPool.push(o.sprite); }

  /** One line for the debug overlay. */
  debugLine(): string {
    const st = ['dormant', 'waking', 'walk', 'act', 'recover', 'stagger', 'dying', 'dead'][this.wState] ?? '?';
    return `warden ${st} hp ${Math.round(this.wHp)}/${this.maxHp} poise ${Math.round(this.wPoise)} act ${this.act.a} · bots ${this.bots.size} junk ${this.junk.size} orbs ${this.orbs.size} · ${this.myPick >= 0 ? SUPERS[this.myPick] : 'no power'}`;
  }

  /** Health (as a share of the most it can be, 0..100) and power, for the roster. */
  info(id: number): { hp: number; power: number } | null {
    if (!this.inArena) return null;
    const power = this.picks.get(id) ?? -1;
    const max = powerHp(power >= 0 ? SUPERS[power] : null);
    return { hp: ((this.hps.get(id) ?? max) / max) * 100, power };
  }

  // ------------------------------------------------------------------ the angels

  /** Every angel's sword leaves a trail of light while it cuts; a remote angel's wingbeats are heard and shed feathers. */
  private updateBlades(dt: number) {
    const h = this.host, fx = this.fx;
    if (!fx) return;
    const list: SwordTrail[] = [];
    const angel = SUPERS.indexOf('angel');
    const models: [number, CharacterModel, number, THREE.Vector3, number][] = [];
    const local = h.local(), me = h.meId();
    if (local && this.picks.get(me) === angel) models.push([me, local.model, local.dead ? Anim.Dead : local.anim, local.renderPos, local.motor.yaw]);
    for (const rp of h.remotes()) if (this.picks.get(rp.id) === angel) models.push([rp.id, rp.model, rp.status === 1 ? Anim.Dead : rp.anim, rp.pos, rp.yaw]);
    for (const [id, model, anim, pos, yaw] of models) {
      const rig = model.angel;
      if (!rig) continue;
      let b = this.blades.get(id);
      if (!b) { b = { base: [], tip: [], ages: [], lastAnim: anim }; this.blades.set(id, b); }
      for (let i = 0; i < b.ages.length; i++) b.ages[i] += dt;
      while (b.ages.length && b.ages[b.ages.length - 1] > BLADE_LIFE) { b.ages.pop(); b.base.pop(); b.tip.pop(); }
      if (rig.bladeSpeed > BLADE_SPEED && anim !== Anim.Dead) {
        const nb = b.base.length >= 20 ? b.base.pop()! : new THREE.Vector3(), nt = b.tip.length >= 20 ? b.tip.pop()! : new THREE.Vector3();
        if (b.ages.length >= 20) b.ages.pop();
        b.base.unshift(nb.copy(rig.bladeBase)); b.tip.unshift(nt.copy(rig.bladeTip)); b.ages.unshift(0);
      }
      if (b.base.length > 1) list.push(b);
      // someone else's wings beat: a whoosh and a few feathers
      if (id !== me && anim === Anim.Beat && b.lastAnim !== Anim.Beat) {
        fx.feathers(tmp.set(pos.x - Math.sin(yaw) * 0.4, pos.y + 1.1, pos.z - Math.cos(yaw) * 0.4), 3, 1.2, 0.5);
        h.audio.arena?.power('beat', pos, 0.6);
      }
      b.lastAnim = anim;
    }
    fx.setSwordTrails(list);
  }

  // ------------------------------------------------------------------ the speedster's wake

  /**
   * Every speedster running fast lays a long ribbon of light behind it (the
   * trail the server burns things with: a point every TRAIL_STEP metres, each
   * lasting TRAIL_LIFE) and sheds afterimages; bots and the Warden's feet in it
   * spit sparks.
   */
  private updateWakes(dt: number) {
    const h = this.host, fx = this.fx;
    if (!fx) return;
    const S = POW.speed;
    const list: { pts: THREE.Vector3[]; ages: number[]; cut: boolean[]; color: [number, number, number] }[] = [];
    const runners: [number, THREE.Vector3, THREE.Vector3, number, boolean][] = [];
    const local = h.local();
    const me = h.meId();
    if (local && this.picks.get(me) === SUPERS.indexOf('speed')) runners.push([me, local.renderPos, local.renderVel, local.motor.yaw, !local.dead]);
    for (const rp of h.remotes()) if (this.picks.get(rp.id) === SUPERS.indexOf('speed')) runners.push([rp.id, rp.pos, rp.vel, rp.yaw, rp.status === 0]);
    for (const [id, pos, vel, yaw, alive] of runners) {
      let w = this.wakes.get(id);
      if (!w) { w = { pts: [], ages: [], cut: [], ghostT: 0, running: false }; this.wakes.set(id, w); }
      for (let i = 0; i < w.ages.length; i++) w.ages[i] += dt;
      const sp = Math.hypot(vel.x, vel.z);
      const fast = alive && sp > S.TRAIL_SPEED;
      if (fast) {
        const last = w.pts[0];
        const gap = last ? Math.hypot(pos.x - last.x, pos.y + 1.05 - last.y, pos.z - last.z) : Infinity;
        if (gap >= S.TRAIL_STEP * 0.75) {
          const p = w.pts.length > 200 ? w.pts.pop()! : new THREE.Vector3();
          if (w.ages.length > 200) { w.ages.pop(); w.cut.pop(); }
          p.set(pos.x, pos.y + 1.05, pos.z);
          // a new stretch if it stopped for a moment or jumped (a dash): nothing is drawn across the gap
          w.cut.unshift(!w.running || gap > 6);
          w.pts.unshift(p); w.ages.unshift(0);
        }
        // afterimages, closer together the faster it goes
        w.ghostT -= dt;
        if (w.ghostT <= 0) {
          w.ghostT = clamp(1.2 / sp, 0.035, 0.09);
          fx.afterimage(tmp.set(pos.x, pos.y, pos.z), Math.atan2(vel.x, vel.z), SPEED_GHOST, 0.3, 1);
          if (Math.random() < 0.5) h.particles.emit(pos.x, pos.y + 0.3 + Math.random() * 1.4, pos.z, -vel.x * 0.1 + (Math.random() - 0.5) * 2, Math.random() * 2, -vel.z * 0.1 + (Math.random() - 0.5) * 2, 0.3, 0.1, 1, 0.85, 0.35, 1, 0, -0.2);
        }
      }
      w.running = fast;
      // drop what has burned out
      while (w.ages.length && w.ages[w.ages.length - 1] > S.TRAIL_LIFE) { w.ages.pop(); w.pts.pop(); w.cut.pop(); }
      if (w.pts.length > 1) {
        list.push({ pts: w.pts, ages: w.ages, cut: w.cut, color: SPEED_TRAIL });
        // what is burning in it spits sparks (a look only: the server does the burning)
        if (Math.random() < dt * 20) {
          for (const b of this.bots.values()) if (this.inWake(w, b.pos.x, b.pos.y + 0.5, b.pos.z, 0.6)) h.particles.burst(b.pos.x, b.pos.y + 0.6, b.pos.z, 5, 5, 0.3, 0.1, [1, 0.8, 0.3], 1, 10, 2);
          if (this.wSeen) {
            wardenParts(this.wPos.x, ARENA.y, this.wPos.z, this.wYaw, this.wLift, this.parts);
            for (const sp2 of this.parts) if (sp2.part === BPart.Leg && this.inWake(w, sp2.x, sp2.y, sp2.z, sp2.r)) h.particles.burst(sp2.x, sp2.y, sp2.z, 6, 6, 0.3, 0.1, [1, 0.8, 0.3], 1, 10, 2);
          }
        }
      }
      void yaw;
    }
    fx.setTrails(list);
  }

  /** Is (x, y, z) within `r` of a speedster's trail (in its burning band)? */
  private inWake(w: Wake, x: number, y: number, z: number, r: number): boolean {
    const R = POW.speed.TRAIL_RADIUS + r;
    for (let i = 1; i < w.pts.length; i++) {
      if (w.cut[i - 1]) continue;
      const a = w.pts[i - 1], b = w.pts[i];
      const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
      const u = l2 > 1e-6 ? clamp(((x - a.x) * dx + (z - a.z) * dz) / l2, 0, 1) : 0;
      const fy = a.y - 1.05 + (b.y - a.y) * u;
      if (y < fy - 0.2 - r || y > fy + 2.4 + r) continue;
      if (Math.hypot(x - (a.x + dx * u), z - (a.z + dz * u)) < R) return true;
    }
    return false;
  }
}

const tmpC = new THREE.Color();

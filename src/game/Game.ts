// Game orchestrator: owns the scene, the local player, remote proxies, the
// connection and the UI flow (menu -> lobby -> match -> results).

import * as THREE from 'three';
import { FLY, GRAPPLE, NET, POWER } from '../../shared/constants';
import { getLevel } from '../../shared/level/map/index';
import type { LevelData, PowerKind } from '../../shared/level/types';
import { zoneAt } from '../../shared/hazards';
import { clamp, damp } from '../../shared/math';
import { Anim, type MoveInput } from '../../shared/physics/character';
import { CollisionWorld, type RayHit } from '../../shared/physics/world';
import { EState, PROTOCOL_VERSION, Status, type EnemySnap, type GameEvent, type LobbyPlayer, type Phase, type PlayerSnap, type S2C } from '../../shared/protocol';
import { AudioEngine } from '../audio/Audio';
import { Debug } from '../debug/Debug';
import { Input } from '../input/Input';
import { Connection } from '../net/Connection';
import { CameraController } from '../player/CameraController';
import { LocalPlayer } from '../player/LocalPlayer';
import { DropShadow } from '../render/DropShadow';
import { Effects } from '../render/Effects';
import { HazardView } from '../render/HazardView';
import { PickupView, POWER_COLOR, POWER_CSS, POWER_NAME } from '../render/PickupView';
import { LevelView } from '../render/LevelView';
import { Materials } from '../render/Materials';
import { PropsView } from '../render/Props';
import { FOG_DENSITY, Renderer } from '../render/Renderer';
import { cloudTexture, FOG_COLOR, Sky } from '../render/Sky';
import { loadBest, loadSession, recordRun, saveSession, saveSettings, type Settings } from '../settings';
import { causeText, fmtTime, UI, type FightSummary, type RunSummary } from '../ui/UI';
import { EnemyProxy, RemotePlayer } from './Actors';
import { Arena } from './Arena';
import { Heaven } from './Heaven';

type Mode = 'menu' | 'connecting' | 'lobby' | 'playing' | 'results';

const POWER_TIP: Record<PowerKind, string> = {
  shield: 'Soaks one hit from an enemy or a laser',
  cloak: `Enemies cannot see you for ${POWER.CLOAK_TIME} s`,
  boost: `Run faster and jump further for ${POWER.BOOST_TIME} s`,
};

/**
 * Is a timed power (cloak, boost) running at this match time? `until` is 0
 * until a crate is actually taken, and the match clock counts *up through zero*
 * during the countdown, so a bare `mt < until` reports both as active on the
 * start line of every run.
 */
function timedPower(until: number, mt: number) { return until > 0 && mt < until; }

/** How long a new area name has to hold before the HUD calls it out (anti-flicker on zone seams). */
const HUD_AREA_SETTLE = 0.35;

/** Keeps an off-screen grapple marker fully inside the view when it is pinned to the border. */
const RETICLE_MARGIN = 34;

/** Viktor's gift on the HUD. */
const FLIGHT_CSS = '#ffd27a';

/** The storm the arena stands in: the fog it fades into, and the sky light under it. */
const ARENA_FOG = new THREE.Color(0x303848);
const ARENA_FOG_DENSITY = 0.0046;
/** The course's fog as the beacon's storm gathers over it. */
const GATE_FOG = new THREE.Color(0x5d6678);
/** Best fight time in this browser (seconds). */
const FIGHT_BEST_KEY = 'skyfall.fight.best.v1';

const tmpV = new THREE.Vector3();
const tmpF = new THREE.Vector3();
const tmpR = new THREE.Vector3();

export class Game {
  private readonly level: LevelData;
  private readonly r: Renderer;
  private readonly mats = new Materials();
  private readonly world: CollisionWorld;
  private readonly sky: Sky;
  private readonly levelView: LevelView;
  private readonly props: PropsView;
  private readonly hazards: HazardView;
  private readonly pickups: PickupView;
  private readonly effects: Effects;
  private readonly input: Input;
  private readonly cam: CameraController;
  private readonly audio = new AudioEngine();
  private readonly ui: UI;
  private readonly debug: Debug;
  private readonly clock = new THREE.Timer();
  private readonly vignette = document.getElementById('vignette')!;
  /** Where the local runner will come down: a soft disc on the ground below it. */
  private readonly dropShadow = new DropShadow();

  private mode: Mode = 'menu';
  private conn: Connection | null = null;
  private offline = false;
  private meId = 0;
  private code = '';
  private token = '';
  private serverDebug = false;
  private phase: Phase = 'lobby';
  private hostId = 0;
  private lobbyPlayers: LobbyPlayer[] = [];
  private goAt = 0;
  private local: LocalPlayer | null = null;
  private remotes = new Map<number, RemotePlayer>();
  private enemies: EnemyProxy[] = [];
  /**
   * Enemy proxies are built once and reused by every run: the level never
   * changes, and rebuilding all 42 models each time leaked their GPU geometry
   * on every "Run it again".
   */
  private enemyPool: EnemyProxy[] = [];
  private paused = false;
  private sendAcc = 0;
  private seq = 0;
  private time = 0;
  private lastCount = 99;
  private spectate = 0;
  private endAt = 0;
  private deathCam = 0;
  private danger = 0;
  private reconnecting = false;
  private lastHud = '';
  private matchTime = 0;
  private gustCooldown = new Map<number, number>();
  /** Named area shown on the HUD, and the candidate waiting to settle into it. */
  private shownArea: string | null = null;
  private pendingArea: string | null = null;
  private pendingAreaFor = 0;
  private readonly deadSpot = new THREE.Vector3();
  /** Furthest along the course the local runner got this run (0..1), and how the run ended. */
  private runProgress = 0;
  private runSummary: RunSummary | null = null;
  /** The portal easter egg: the portal on the course, the white room, Viktor. */
  private readonly heaven: Heaven;
  /** The Warden's fight past the beacon. */
  private readonly arena: Arena;
  /** The arena is what is drawn right now (the course is hidden). */
  private arenaShown = false;
  private readonly listenerRight = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement, private settings: Settings) {
    this.level = getLevel();
    this.r = new Renderer(canvas, settings.quality);
    this.world = new CollisionWorld(this.level);
    this.sky = new Sky(FOG_DENSITY);
    this.r.scene.add(this.sky.group);
    this.levelView = new LevelView(this.level, this.mats, this.r.shadows);
    this.r.scene.add(this.levelView.group);
    this.props = new PropsView(this.level, this.mats, this.r.shadows);
    this.r.scene.add(this.props.group);
    this.hazards = new HazardView(this.level, this.mats);
    this.r.scene.add(this.hazards.group);
    this.pickups = new PickupView(this.level, this.mats.glowTex);
    this.r.scene.add(this.pickups.group);
    this.effects = new Effects(this.mats.glowTex, this.level);
    this.r.scene.add(this.effects.group);
    this.r.scene.add(this.dropShadow.mesh);
    this.input = new Input(canvas);
    this.cam = new CameraController(this.r.camera);
    this.debug = new Debug(this.r.scene, this.level);
    this.applySettings();

    this.levelView.onCrumbleDust = (x, y, z, big) => {
      if (big) { this.effects.particles.burst(x, y, z, 50, 5, 1.4, 0.9, [0.6, 0.45, 0.35], 0.7, 4); tmpV.set(x, y, z); this.audio.crumble(tmpV, true); }
      else { this.effects.particles.emit(x, y, z, 0, -1, 0, 1.0, 0.2, 0.55, 0.45, 0.38, 0.8, 9, 0); if (Math.random() < 0.3) { tmpV.set(x, y, z); this.audio.crumble(tmpV, false); } }
    };
    this.effects.onProjectileEnd = (x, y, z) => { tmpV.set(x, y, z); this.audio.impact(tmpV); };
    this.sky.onThunder = (d, s) => this.audio.thunder(d, s);

    this.ui = new UI(uiRoot, settings, {
      create: (name) => this.startOnline('create', name),
      join: (name, code) => this.startOnline('join', name, code),
      offline: (name) => this.startOffline(name),
      ready: (rdy) => this.conn?.send({ t: 'ready', r: rdy }),
      start: () => { this.input.requestLock(); this.conn?.send({ t: 'start' }); },
      startBoss: () => { this.input.requestLock(); this.conn?.send({ t: 'start', stage: 'boss' }); },
      // unpause without asking for the mouse here: the new run asks for it as it
      // starts, and a second request in the same click lost the lock and paused again
      restart: () => {
        this.paused = false;
        if (this.offline) this.conn?.setPaused(false);
        this.ui.closePause();
        this.conn?.send({ t: 'restart' });
      },
      leave: () => this.leave(),
      resume: () => this.resume(),
      toLobby: () => this.conn?.send({ t: 'lobby' }),
      settingsChanged: (s) => { this.settings = s; saveSettings(s); this.applySettings(); },
      click: () => { this.audio.init(); this.audio.click(); },
    });

    this.input.onLockChange = (locked) => {
      this.ui.captureHint(!locked && this.mode === 'playing' && !this.paused);
      if (!locked && this.mode === 'playing' && !this.paused && !this.ui.overlayOpen) this.openPause();
    };
    this.input.onKey = (code) => this.onKey(code);
    canvas.addEventListener('click', () => {
      this.audio.init();
      if (this.mode === 'playing' && !this.paused) this.input.requestLock();
    });
    window.addEventListener('pointerdown', () => this.audio.init(), { once: true });
    window.addEventListener('keydown', () => this.audio.init(), { once: true });

    this.heaven = new Heaven(this.mats.glowTex, cloudTexture(), this.r.scene.environment, this.r.shadows, this.r.camera, this.cam, this.ui, this.audio, {
      send: (kind) => this.conn?.send({ t: kind }),
      swapScene: (inRoom) => this.swapScene(inRoom),
      burst: (p, big) => {
        this.effects.particles.burst(p.x, p.y, p.z, big ? 90 : 50, big ? 7 : 5, 1.2, 0.45, [1, 0.88, 0.6], 1, -1, 1.5);
        this.effects.particles.burst(p.x, p.y, p.z, big ? 40 : 20, 3, 1.6, 0.8, [1, 0.97, 0.9], 0.7, -0.5, 0.5);
      },
    });
    this.r.scene.add(this.heaven.portal.group);
    this.arena = new Arena({
      scene: this.r.scene, camera: this.r.camera, cam: this.cam, ui: this.ui, audio: this.audio,
      particles: this.effects.particles, mats: this.mats, glowTex: this.mats.glowTex, shadows: this.r.shadows, course: this.level,
      send: (m) => this.conn?.send(m),
      meId: () => this.meId,
      local: () => this.local,
      remote: (id) => this.remotes.get(id),
      remotes: () => this.remotes.values(),
      name: (id) => this.playerName(id),
      swap: (on) => this.showArena(on),
      storm: (k) => this.setStorm(k),
      flashSky: (k) => this.sky.strike(k),
    }, this.ui.hudRoot);
    // Ctrl is a game key once you can fly, and Ctrl+W cannot be stopped by a page:
    // while the gift is yours, closing the tab asks first
    window.addEventListener('beforeunload', (e) => {
      const l = this.local;
      if (this.mode === 'playing' && l && l.motor.canFly && !l.dead && !l.finished) { e.preventDefault(); e.returnValue = ''; }
    });

    this.cam.reset(new THREE.Vector3(0, 40, -8), 0);
    this.ui.mainMenu();
    this.tryResumeSession();
    this.r.renderer.setAnimationLoop(() => this.frame());
  }

  private applySettings() {
    const s = this.settings;
    this.cam.sensitivity = s.sensitivity;
    this.cam.invertY = s.invertY;
    this.cam.baseFov = s.fov;
    this.cam.shakeEnabled = s.cameraShake;
    this.audio.setVolumes(s.volume, s.music);
  }

  /** The local runner (and its ground shadow) moves between the course and the white room. */
  private swapScene(inRoom: boolean) {
    const view = this.heaven.view;
    const target = inRoom && view ? view.scene : this.r.scene;
    if (this.local) target.add(this.local.model.root);
    target.add(this.dropShadow.mesh);
    // the white room is lit to read as light itself, a touch brighter than the sky outside
    this.r.renderer.toneMappingExposure = inRoom ? 0.98 : 1.05;
    this.ui.heavenHud(inRoom);
  }

  /** The collision world the local runner is in: the course's, or the Warden's arena's. */
  private get activeWorld(): CollisionWorld { return this.arenaShown && this.arena.world ? this.arena.world : this.world; }
  private get activeLevel(): LevelData { return this.arenaShown ? this.arena.level : this.level; }
  private get activeHazards(): HazardView { return this.arenaShown && this.arena.view ? this.arena.view.hazards : this.hazards; }

  /**
   * The course or the Warden's arena: what is drawn, the air and the light, and
   * which level the local runner answers to.
   */
  private showArena(on: boolean) {
    if (this.arenaShown === on) return;
    this.arenaShown = on;
    for (const g of [this.levelView.group, this.props.group, this.hazards.group, this.pickups.group, this.heaven.portal.group]) g.visible = !on;
    for (const e of this.enemies) e.view.root.visible = !on;
    this.effects.clearProjectiles();
    this.hazards.setTargeted(-1);
    for (let i = 0; i < 3; i++) this.hazards.setRope(i, null);
    const fog = this.r.scene.fog as THREE.FogExp2;
    fog.color.copy(on ? ARENA_FOG : FOG_COLOR);
    fog.density = on ? ARENA_FOG_DENSITY : FOG_DENSITY;
    (this.r.scene.background as THREE.Color).copy(fog.color);
    this.r.hemiBase = on ? 0.72 : 1.05;
    this.r.hemi.color.set(on ? 0x9fb2d6 : 0xc4d6ee);
    this.r.hemi.groundColor.set(on ? 0x4a3226 : 0x6a5e54);
    this.r.sun.color.set(on ? 0xcad6ff : 0xffe0b8);
    this.r.sun.intensity = on ? 1.25 : 2.6;
    this.r.renderer.toneMappingExposure = on ? 1.02 : 1.05;
    this.sky.setStorm(on ? 1 : 0, fog.color);
    this.ui.arenaHud(on);
    this.ui.area(null, 0);
    if (this.local) {
      this.local.setLevel(on ? this.arena.level : this.level);
      // Viktor's gift does not carry into the storm
      if (on) { this.local.motor.canFly = false; this.local.motor.flying = false; this.input.trapCtrl = false; }
      this.localDeathShown = false;
      this.local.finished = false;
    }
    if (on) { this.heaven.reset(); this.danger = 0; }
    this.lastHud = '';
  }

  /** The course's sky turning as the beacon's storm gathers (0..1). */
  private setStorm(k: number) {
    if (this.arenaShown) return;
    const fog = this.r.scene.fog as THREE.FogExp2;
    fog.color.lerpColors(FOG_COLOR, GATE_FOG, k);
    (this.r.scene.background as THREE.Color).copy(fog.color);
    this.sky.setStorm(k * 0.85, fog.color);
    this.r.hemiBase = 1.05 - k * 0.2;
  }

  // ------------------------------------------------------------------ connection flow

  private async startOnline(kind: 'create' | 'join', name: string, code = '') {
    this.audio.init();
    this.offline = false;
    this.mode = 'connecting';
    this.ui.loading(kind === 'create' ? 'Creating game…' : 'Joining game…');
    const conn = new Connection();
    try {
      await conn.connect(this.level);
    } catch (e) {
      this.mode = 'menu';
      this.ui.mainMenu();
      this.ui.modal('Server unavailable', `${(e as Error).message} You can still play the solo offline run.`, [
        { label: 'Back', fn: () => this.ui.mainMenu() },
        { label: 'Play solo offline', primary: true, fn: () => this.startOffline(name) },
      ]);
      return;
    }
    this.bindConnection(conn);
    if (kind === 'create') conn.send({ t: 'create', name, v: PROTOCOL_VERSION });
    else conn.send({ t: 'join', code, name, v: PROTOCOL_VERSION });
  }

  private async startOffline(name: string) {
    this.audio.init();
    this.offline = true;
    const conn = new Connection({ offline: true });
    await conn.connect(this.level);
    this.bindConnection(conn);
    conn.send({ t: 'create', name, v: PROTOCOL_VERSION });
  }

  private bindConnection(conn: Connection) {
    this.conn?.close();
    this.conn = conn;
    conn.onMessage = (m) => this.onMessage(m);
    conn.onDrop = (reason) => this.onDrop(reason);
  }

  private tryResumeSession() {
    const s = loadSession();
    if (!s) return;
    // A page refresh during a match: offer to jump back in.
    this.ui.modal('Rejoin your game?', `You were in game ${s.code}. Try to reconnect?`, [
      { label: 'No', fn: () => saveSession(null) },
      { label: 'Rejoin', primary: true, fn: () => void this.reconnect(s.code, s.token, 1) },
    ]);
  }

  private onDrop(reason: string) {
    if (this.mode === 'menu' || this.offline) return;
    if (!this.code || !this.token) { this.toMenu(reason); return; }
    void this.reconnect(this.code, this.token, 8, reason);
  }

  private async reconnect(code: string, token: string, attempts: number, reason = '') {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.input.exitLock();
    let cancelled = false;
    for (let i = 0; i < attempts && !cancelled; i++) {
      this.ui.modal('Connection lost', `${reason} Reconnecting (attempt ${i + 1}/${attempts})…`, [
        { label: 'Give up', fn: () => { cancelled = true; } },
      ]);
      const conn = new Connection();
      try {
        await conn.connect(this.level, 4000);
        this.bindConnection(conn);
        const ok = await new Promise<boolean>((res) => {
          const prev = conn.onMessage;
          const to = window.setTimeout(() => res(false), 4000);
          conn.onMessage = (m) => {
            if (m.t === 'joined') { window.clearTimeout(to); conn.onMessage = prev; prev?.(m); res(true); return; }
            if (m.t === 'err') { window.clearTimeout(to); conn.onMessage = prev; res(false); cancelled = true; return; }
            prev?.(m);
          };
          conn.send({ t: 'resume', code, token, v: PROTOCOL_VERSION });
        });
        if (ok) {
          this.reconnecting = false;
          this.ui.closeModal();
          this.ui.toast('Reconnected');
          return;
        }
        conn.close();
      } catch { /* retry */ }
      if (!cancelled) await new Promise((r) => setTimeout(r, 2000));
    }
    this.reconnecting = false;
    saveSession(null);
    this.toMenu('Could not reconnect to the game.');
  }

  private leave() {
    this.conn?.send({ t: 'leave' });
    saveSession(null);
    this.toMenu();
  }

  private toMenu(notice?: string) {
    this.conn?.setPaused(false);
    this.conn?.close();
    this.conn = null;
    this.mode = 'menu';
    this.paused = false;
    this.meId = 0; this.code = ''; this.token = '';
    this.clearMatch();
    this.input.exitLock();
    this.ui.closeModal();
    this.ui.mainMenu();
    if (notice) this.ui.modal('Disconnected', notice, [{ label: 'OK', primary: true, fn: () => {} }]);
  }

  // ------------------------------------------------------------------ messages

  private onMessage(m: S2C) {
    switch (m.t) {
      case 'joined':
        this.meId = m.id; this.code = m.code; this.token = m.token; this.serverDebug = m.debug;
        if (!this.offline) saveSession({ code: m.code, token: m.token });
        if (this.mode === 'connecting' || this.mode === 'menu') this.mode = 'lobby';
        break;
      case 'room': {
        const prevPhase = this.phase;
        this.phase = m.phase; this.hostId = m.hostId; this.lobbyPlayers = m.players;
        for (const p of m.players) {
          const rp = this.remotes.get(p.id);
          if (rp) rp.connected = p.connected;
        }
        if (m.phase === 'lobby' && (this.mode === 'lobby' || this.mode === 'playing' || this.mode === 'results' || prevPhase !== 'lobby')) {
          if (this.mode !== 'lobby') { this.clearMatch(); this.input.exitLock(); this.mode = 'lobby'; }
          this.ui.lobby({ code: m.code, phase: m.phase, hostId: m.hostId, players: m.players, meId: this.meId, offline: this.offline });
        }
        this.lastHud = '';
        break;
      }
      case 'start':
        this.conn?.seedClock(m.now);
        this.beginMatch(m.goAt, m.spawns, !!m.resume, m.crumbles ?? []);
        this.arena.onStart(m, (this.conn?.serverNow() ?? 0) - m.goAt);
        // build the arena while the run is young, so the beacon never hitches
        if (!m.stage || m.stage === 'course') window.setTimeout(() => { if (this.mode === 'playing') this.arena.ensureViews(); }, 2500);
        if (this.arena.inArena) { this.ui.objective('The Warden · choose your power', 6); this.runSummary = null; }
        for (const id of m.taken ?? []) { this.taken.add(id); this.pickups.take(id); }
        for (const [id, sh, cl, bt] of m.powers ?? []) { const ps = this.powerOf(id); ps.shield = !!sh; ps.cloakUntil = cl; ps.boostUntil = bt; }
        if (m.portal) this.heaven.placePortal([m.portal[0], m.portal[1], m.portal[2]], m.portal[3], m.portal[4]);
        // back from Viktor already (a reconnect): the gift carries on
        if (this.local && m.fly?.includes(this.meId)) this.grantFlight();
        break;
      case 'snap':
        this.onSnapshot(m.ts, m.p, m.e);
        this.arena.onPlayers(m.p);
        this.arena.onSnapshot(m.ts, m.b, m.m, m.j);
        break;
      case 'ev':
        for (const e of m.e) this.onEvent(e);
        break;
      case 'fix':
        this.local?.teleport(m.p[0], m.p[1], m.p[2]);
        break;
      case 'end':
        this.mode = 'results';
        this.endAt = this.time;
        this.input.exitLock();
        this.ui.captureHint(false);
        this.ui.closePause();
        this.paused = false;
        {
          // a fight won is measured against the best; a fight lost is shown for what it was
          const fight = m.fight === undefined ? undefined : m.boss ? this.recordFight(m.fight) : { won: false, time: m.fight, prevBest: this.fightBest(), best: false };
          window.setTimeout(() => {
            if (this.mode === 'results') this.ui.results(m.results, this.meId, this.hostId === this.meId, m.duration, this.runSummary ?? undefined, fight);
          }, m.boss ? 900 : 1800);
        }
        break;
      case 'err':
        if (m.code === 'ROOM_NOT_FOUND' || m.code === 'ROOM_FULL' || m.code === 'IN_PROGRESS') {
          this.conn?.close(); this.conn = null; this.mode = 'menu';
          this.ui.joinMenu(m.msg);
        } else if (m.code === 'NOT_HOST') {
          this.ui.toast(m.msg);
        } else if (m.code !== 'RESUME_FAILED') {
          this.toMenu(m.msg);
        }
        break;
      default:
        break;
    }
  }

  private beginMatch(goAt: number, spawns: Record<number, [number, number, number]>, resume: boolean, crumbles: [number, string, number][]) {
    this.clearMatch();
    this.goAt = goAt;
    this.mode = 'playing';
    this.paused = false;
    this.spectate = 0;
    this.deathCam = 0;
    this.lastCount = 99;
    for (const c of this.world.crumbles) { c.enabled = true; c.shakeStart = -1; }
    this.levelView.resetAll();
    this.powers.clear();
    this.taken.clear();
    this.predicted.clear();
    this.pickups.reset();
    this.localGrace = 0;
    if (!resume) { this.runProgress = 0; this.runSummary = null; }
    for (const [id, s, t] of crumbles) {
      const c = this.world.get(id);
      if (!c) continue;
      if (s === 'fall') c.enabled = false;
      this.levelView.crumbleEvent(id, s as 'shake' | 'fall', t);
    }
    // local player
    const mine = spawns[this.meId];
    this.local = new LocalPlayer((this.meId - 1) % 3, this.r.shadows, this.level, {
      jump: () => {
        this.audio.jump();
        if (!this.local!.motor.boost) return;
        this.audio.boostJump();
        const p = this.local!.pos;
        this.effects.particles.burst(p.x, p.y + 0.05, p.z, 18, 3, 0.4, 0.25, [1, 0.55, 0.15], 0.7, 6, -3);
      },
      land: (impact) => {
        this.audio.land(impact);
        this.cam.landing(impact);
        const p = this.local!.pos;
        if (impact > 6) this.effects.particles.dust(p.x, p.y, p.z, Math.min(1, impact / 20));
      },
      mantle: () => this.audio.mantle(),
      footstep: (surface, speed) => this.audio.footstep(surface, speed),
      groundChanged: (id) => {
        if (this.arenaShown) return;
        const c = this.world.get(id);
        if (c?.kind === 'crumble') this.levelView.predictShake(id, this.matchTime);
      },
      launched: () => {
        this.audio.launch();
        this.cam.addShake(0.18);
        const p = this.local!.pos;
        this.effects.particles.burst(p.x, p.y + 0.2, p.z, 40, 5, 0.9, 0.7, [0.95, 0.9, 0.85], 0.55, -2, 5);
        this.effects.particles.burst(p.x, p.y + 0.1, p.z, 18, 3, 0.5, 0.25, [1, 0.6, 0.2], 0.9, 4, 3);
      },
      zipOn: () => this.audio.zipOn(),
      zipOff: () => this.audio.zipOff(),
      laser: () => this.localLaserDeath(),
      bodyLanded: (impact) => {
        this.audio.land(Math.min(impact, 16));
        const p = this.local!.pos;
        this.effects.particles.dust(p.x, p.y, p.z, Math.min(1, impact / 14));
      },
      slid: () => {
        this.audio.slide();
        const p = this.local!.pos;
        this.effects.particles.burst(p.x, p.y + 0.1, p.z, 14, 2.5, 0.6, 0.35, [0.7, 0.66, 0.6], 0.45, 3, 1);
      },
      hooked: () => this.audio.grappleHook(),
      unhooked: () => this.audio.grappleRelease(),
      flipped: () => {
        this.audio.flip();
        const p = this.local!.pos;
        this.effects.particles.burst(p.x, p.y + 0.9, p.z, 12, 3, 0.45, 0.25, [0.8, 0.85, 0.95], 0.35, 2, -1);
      },
      flew: (dir) => {
        const p = this.local!.pos;
        if (dir > 0) {
          this.audio.flyOn();
          this.cam.addShake(0.12);
          this.effects.particles.burst(p.x, p.y + 0.2, p.z, 36, 4, 0.8, 0.4, [1, 0.9, 0.62], 0.9, -2, 2);
          this.effects.particles.dust(p.x, p.y, p.z, 0.5);
        } else {
          this.audio.flyOff();
          this.effects.particles.burst(p.x, p.y + 0.9, p.z, 18, 2.5, 0.6, 0.3, [1, 0.9, 0.62], 0.7, 2, 0);
        }
      },
      slammed: (speed) => this.arena.slammed(speed),
      flashed: (from) => this.arena.flashed(from),
      beat: (kind) => this.arena.beat(kind),
      dashed: (side) => {
        this.audio.dash();
        const p = this.local!.pos;
        this.dashKick = 1;
        this.effects.particles.burst(p.x - Math.cos(this.cam.yaw) * side * 0.3, p.y + 0.15, p.z + Math.sin(this.cam.yaw) * side * 0.3,
          18, 3.4, 0.55, 0.3, [0.72, 0.7, 0.66], 0.5, 3, 0.5);
      },
    });
    this.local.immune = this.godMode;
    this.local.spawn(mine[0], mine[1], mine[2], this.level.spawnYaw);
    this.r.scene.add(this.local.model.root);
    this.cam.reset(this.local.renderPos, this.level.spawnYaw);
    // remotes
    for (const p of this.lobbyPlayers) {
      if (p.id === this.meId || !spawns[p.id]) continue;
      const rp = new RemotePlayer(p.id, p.name, this.r.shadows);
      const s = spawns[p.id];
      rp.place(s[0], s[1], s[2], this.level.spawnYaw);
      rp.connected = p.connected;
      this.remotes.set(p.id, rp);
      this.r.scene.add(rp.model.root);
    }
    // enemies
    if (!this.enemyPool.length) this.enemyPool = this.level.enemies.map((d) => new EnemyProxy(d.id, d.kind, this.r.shadows, this.mats.glowTex, d.p, d.yaw));
    this.enemies = this.enemyPool;
    for (const e of this.enemies) {
      const d = this.level.enemies[e.id];
      e.reset(d.p, d.yaw);
      e.view.root.position.set(d.p[0], d.p[1], d.p[2]);
      this.r.scene.add(e.view.root);
    }
    this.ui.showHud();
    this.ui.objective(resume ? 'Rejoined — keep going' : 'Reach the beacon on the Spire', 7);
    this.ui.bottom('');
    this.lastHud = '';
    this.input.requestLock();
    this.ui.captureHint(!this.input.locked);
    if (resume) { this.local.frozen = false; this.lastCount = 0; }
  }

  private localDeathShown = false;
  private powers = new Map<number, { shield: boolean; cloakUntil: number; boostUntil: number }>();
  private taken = new Set<number>();
  /** Crates this client hid when its runner touched them, waiting for the server (id -> time). */
  private predicted = new Map<number, number>();
  private localGrace = 0;
  private shieldPredictedAt = -9;
  private grappleTarget = -1;
  /** Decays after a dash: a short camera kick. */
  private dashKick = 0;
  private readonly rayHit: RayHit = { dist: 0, c: null };

  private powerOf(id: number) {
    let ps = this.powers.get(id);
    if (!ps) { ps = { shield: false, cloakUntil: 0, boostUntil: 0 }; this.powers.set(id, ps); }
    return ps;
  }

  /** Best grapple anchor for the local runner: in range, in front of the camera, above the hands, in sight. */
  private pickAnchor(): number {
    const local = this.local;
    if (!local || local.dead || local.finished || local.frozen) return -1;
    const m = local.motor;
    if (m.grapple) return m.grapple.id;
    const hx = local.pos.x, hy = local.pos.y + GRAPPLE.HAND, hz = local.pos.z;
    // aim is horizontal ("the anchor ahead of me"): anchors sit high above, players rarely look up
    this.cam.forward(tmpF);
    let best = -1, bestScore = Infinity;
    const world = this.activeWorld;
    for (const g of this.activeLevel.grapples) {
      const dx = g.p[0] - hx, dy = g.p[1] - hy, dz = g.p[2] - hz;
      const d = Math.hypot(dx, dy, dz), hd = Math.hypot(dx, dz);
      if (d > GRAPPLE.RANGE || d < GRAPPLE.MIN_RANGE || dy < -0.5) continue;
      const ang = hd < 2 ? 0 : Math.acos(clamp((dx * tmpF.x + dz * tmpF.z) / hd, -1, 1));
      if (ang > (d < 8 ? 1.1 : 0.62)) continue;
      const score = ang + d * 0.015;
      if (score >= bestScore) continue;
      world.raycast(hx, hy, hz, dx / d, dy / d, dz / d, d - 0.5, false, this.rayHit);
      if (this.rayHit.c && this.rayHit.c.kind !== 'puppet') continue;
      best = g.id; bestScore = score;
    }
    return best;
  }

  /** Grapple, crates, powers and ropes for this frame. */
  private updateAbilities(mt: number) {
    const local = this.local;
    const room = this.heaven.inRoom;
    // grapple: reticle + key
    this.grappleTarget = room ? -1 : this.pickAnchor();
    const hz = this.activeHazards;
    hz.setTargeted(this.grappleTarget);
    const hooked = !!local?.motor.grapple;
    if (this.grappleTarget >= 0) {
      const g = this.activeLevel.grapples[this.grappleTarget];
      tmpV.set(g.p[0], g.p[1], g.p[2]).project(this.r.camera);
      const el = this.r.renderer.domElement;
      const w = el.clientWidth, h = el.clientHeight;
      // Anchors hang high overhead and can be hooked without looking up, so a
      // target that projects outside the view (or behind the camera, where the
      // projection mirrors) is pinned to the border instead of vanishing.
      const behind = tmpV.z >= 1;
      let sx = (tmpV.x + 1) / 2 * w, sy = (1 - tmpV.y) / 2 * h;
      if (behind) { sx = w - sx; sy = h - sy; }
      const m = RETICLE_MARGIN;
      const cx = clamp(sx, m, w - m), cy = clamp(sy, m, h - m);
      this.ui.reticle(cx, cy, hooked, behind || cx !== sx || cy !== sy);
    } else this.ui.reticle(null);
    const can = !this.paused && !this.debug.freeCam && !this.heaven.locksInput;
    // left click: take off / land, once Viktor has given you flight (in the arena it is the power's)
    if (local && can && !room && !this.arenaShown && this.input.mouseLeftPressed && local.motor.canFly && !local.dead && !local.finished && !local.frozen) local.requestFlyToggle();
    if (local && can && !room && !local.motor.flying && this.input.mouseRightPressed && !local.dead && !local.finished) {
      if (hooked) local.requestRelease();
      else if (this.grappleTarget >= 0) { local.requestGrapple(this.grappleTarget); this.audio.grappleFire(); }
    }
    // ropes: local runner first, then remotes swinging near an anchor
    let rope = 0;
    if (local && local.motor.grapple && !local.dead) {
      hz.setRope(rope++, tmpV.set(local.renderPos.x, local.renderPos.y + 1.95, local.renderPos.z), local.motor.grapple.id);
    }
    for (const rp of this.remotes.values()) {
      if (rope >= 3 || rp.anim !== Anim.Swing || rp.status !== Status.Alive) continue;
      let best = -1, bd = GRAPPLE.RANGE + 1;
      for (const g of this.activeLevel.grapples) {
        const d = Math.hypot(g.p[0] - rp.pos.x, g.p[1] - rp.pos.y - GRAPPLE.HAND, g.p[2] - rp.pos.z);
        if (d < bd && g.p[1] > rp.pos.y + 1) { bd = d; best = g.id; }
      }
      if (best >= 0) hz.setRope(rope++, tmpV.set(rp.pos.x, rp.pos.y + 1.95, rp.pos.z), best);
    }
    for (; rope < 3; rope++) hz.setRope(rope, null);

    // crates: hide the one we walk through right away (the server decides who gets it)
    if (local && !local.dead && !local.finished && !local.frozen && !room && !this.arenaShown) {
      for (const c of this.level.pickups) {
        if (this.taken.has(c.id) || this.predicted.has(c.id)) continue;
        const dy = local.pos.y - c.p[1];
        if (dy < -0.6 || dy > 2.2 || Math.hypot(local.pos.x - c.p[0], local.pos.z - c.p[2]) > POWER.PICKUP_RADIUS) continue;
        this.predicted.set(c.id, this.time);
        this.pickups.take(c.id);
      }
    }
    for (const [id, at] of this.predicted) {
      if (this.time - at > 1.5) { this.predicted.delete(id); if (!this.taken.has(id)) this.pickups.restore(id); }
    }

    // powers: motor, runner visuals and HUD
    const me = this.powerOf(this.meId);
    if (local) {
      local.motor.boost = timedPower(me.boostUntil, mt);
      local.model.setPowers(me.shield && !local.dead, timedPower(me.cloakUntil, mt) ? 0.65 : 0, local.motor.boost);
    }
    for (const rp of this.remotes.values()) {
      const ps = this.powerOf(rp.id);
      rp.model.setPowers(ps.shield && rp.status === Status.Alive, timedPower(ps.cloakUntil, mt) ? 0.85 : 0, timedPower(ps.boostUntil, mt));
    }
    const hud: { name: string; color: string; remaining?: number; total?: number }[] = [];
    if (local && !local.dead && !this.arenaShown) {
      if (me.shield) hud.push({ name: POWER_NAME.shield, color: POWER_CSS.shield });
      if (timedPower(me.cloakUntil, mt)) hud.push({ name: POWER_NAME.cloak, color: POWER_CSS.cloak, remaining: me.cloakUntil - mt, total: POWER.CLOAK_TIME });
      if (timedPower(me.boostUntil, mt)) hud.push({ name: POWER_NAME.boost, color: POWER_CSS.boost, remaining: me.boostUntil - mt, total: POWER.BOOST_TIME });
      if (local.motor.canFly) hud.push({ name: local.motor.flying ? 'Flying' : 'Flight · click', color: FLIGHT_CSS });
    }
    this.ui.powers(hud);
  }
  private hintsShown = new Set<string>();
  private hintAt = 0;

  private clearMatch() {
    this.heaven.reset();
    this.showArena(false);
    this.arena.reset();
    this.input.trapCtrl = false;
    this.localDeathShown = false;
    this.shownArea = this.pendingArea = null;
    this.pendingAreaFor = 0;
    this.ui.area(null, 0);
    if (this.local) { this.r.scene.remove(this.local.model.root); this.local.model.dispose(); this.local = null; }
    for (const rp of this.remotes.values()) { this.r.scene.remove(rp.model.root); rp.model.dispose(); }
    this.remotes.clear();
    for (const e of this.enemies) this.r.scene.remove(e.view.root);
    this.enemies = [];
    this.effects.clearProjectiles();
    this.vignette.style.opacity = '0';
    this.ui.clearBig();
    this.ui.clearTip();
    this.ui.closePause();
  }

  private onSnapshot(ts: number, ps: PlayerSnap[], es: EnemySnap[]) {
    for (const s of ps) {
      if (s[0] === this.meId) continue;
      let rp = this.remotes.get(s[0]);
      if (!rp) {
        const info = this.lobbyPlayers.find((p) => p.id === s[0]);
        rp = new RemotePlayer(s[0], info?.name ?? `Runner ${s[0]}`, this.r.shadows);
        this.remotes.set(s[0], rp);
        this.r.scene.add(rp.model.root);
      }
      rp.push(ts, s);
    }
    for (const s of es) this.enemies[s[0]]?.push(ts, s);
  }

  /** The local runner touched a laser: show it right away and tell the server. */
  private localLaserDeath() {
    const local = this.local;
    if (!local || local.dead || this.phase !== 'playing') return;
    const ps = this.powerOf(this.meId);
    if (this.matchTime < this.localGrace) return;
    if (ps.shield) {
      // the shield soaks the laser: show it now, the server confirms with a 'shield' event
      ps.shield = false;
      this.shieldPredictedAt = this.time;
      this.localGrace = this.matchTime + POWER.SHIELD_GRACE;
      local.laserGraceUntil = this.localGrace;
      this.audio.shieldBreak(true);
      this.cam.addShake(0.35);
      this.ui.big('Shield broke', 'cyan', 'Get clear!', 1.3);
      this.conn?.send({ t: 'die', cause: 'laser' });
      return;
    }
    const p = local.pos;
    this.onEvent({ k: 'death', id: this.meId, cause: 'laser', by: -1, p: [p.x, p.y, p.z] });
    this.conn?.send({ t: 'die', cause: 'laser' });
  }

  /** A laser death in mid-air (or on a zip line) lets the body fall. */
  private dropLocalBody() {
    const local = this.local!;
    const m = local.motor;
    if (m.zip || !m.body.grounded) {
      m.zip = null;
      local.doomed = true;
      local.doomedAt.copy(this.r.camera.position);
    } else local.doomed = false;
  }

  private enemyPos(id: number): THREE.Vector3 {
    return this.enemies[id]?.pos ?? tmpV.set(0, 0, 0);
  }

  private playerName(id: number) {
    return this.lobbyPlayers.find((p) => p.id === id)?.name ?? `Runner ${id}`;
  }

  private onEvent(e: GameEvent) {
    // the beacon: the course is over for everyone, in one way or another
    if (e.k === 'gate') {
      const mine = e.id === this.meId;
      if (this.local && !this.runSummary) {
        if (mine) this.runProgress = 1;
        this.endRun(mine, undefined, e.time);
      }
      this.ui.big('The beacon opens', 'storm mid', mine ? `You reached it · ${fmtTime(e.time)}` : `${this.playerName(e.id)} reached it · ${fmtTime(e.time)}`, 2.2);
      this.ui.objective('Hold on', 3);
      this.ui.clearTip();
      this.heaven.closePortal();
    }
    if (e.k === 'arena') { this.localDeathShown = false; this.deathCam = 0; this.spectate = 0; this.lastHud = ''; this.ui.bottom(''); this.ui.clearBig(); }
    // past the beacon, going down is as final as on the course: you watch your team, and if nobody is left the fight starts over
    if (e.k === 'death' && this.arena.inArena) {
      if (e.id === this.meId) {
        if (!this.localDeathShown) {
          this.localDeathShown = true;
          this.deathCam = this.time;
          this.arena.localDown(e, this.aliveRemotes());
        }
      } else {
        this.ui.toast(`${this.playerName(e.id)} is down`);
        this.audio.otherDied();
        if (e.cause !== 'fall') this.effects.particles.burst(e.p[0], e.p[1] + 1, e.p[2], 40, 6, 0.8, 0.35, [1, 0.45, 0.3], 1, 5);
      }
      this.lastHud = '';
      return;
    }
    if (this.arena.onEvent(e, this.matchTime)) { if (e.k === 'pick' || e.k === 'hurt') this.lastHud = ''; return; }
    switch (e.k) {
      case 'death': {
        if (e.id === this.meId && this.local) {
          if (this.localDeathShown) break;
          this.localDeathShown = true;
          this.local.die(e.v);
          if (e.cause === 'laser') this.dropLocalBody();
          else if (e.cause !== 'fall') this.local.doomed = false;
          else if (!this.local.doomed) { this.local.doomed = true; this.local.doomedAt.copy(this.r.camera.position); }
          this.deadSpot.set(e.p[0], e.p[1], e.p[2]);
          this.deathCam = this.time;
          this.audio.death(e.cause);
          this.cam.addShake(e.cause === 'fall' ? 0.2 : 0.8);
          const txt = e.cause === 'fall' ? 'You fell' : e.cause === 'melee' ? 'Caught' : e.cause === 'shot' ? 'Shot down' : e.cause === 'laser' ? 'Lasered' : 'Taken';
          const pct = Math.round(this.runProgress * 100);
          this.endRun(false, e.cause, Math.max(0, this.matchTime));
          this.ui.big(txt, 'danger', this.aliveRemotes() > 0 ? 'Your run is over — watch your team' : `${this.shownArea ? `${this.shownArea} · ` : ''}${pct}% of the way`, 4);
          if (e.cause !== 'fall') this.effects.particles.burst(e.p[0], e.p[1] + 1, e.p[2], 60, 7, 0.9, 0.35, e.cause === 'shot' ? [1, 0.35, 0.7] : e.cause === 'laser' ? [1, 0.2, 0.15] : [1, 0.5, 0.2], 1, 5);
        } else {
          this.ui.toast(`${this.playerName(e.id)} — ${causeText(e.cause).toLowerCase()}`);
          this.audio.otherDied();
          if (e.cause !== 'fall') this.effects.particles.burst(e.p[0], e.p[1] + 1, e.p[2], 40, 6, 0.8, 0.35, [1, 0.45, 0.3], 1, 5);
        }
        this.lastHud = '';
        break;
      }
      case 'finish':
        if (e.id === this.meId && this.local) {
          this.local.finished = true;
          this.deathCam = this.time;
          this.runProgress = 1;
          this.endRun(true, undefined, e.time);
          this.audio.finish();
          const place = ['', '1st', '2nd', '3rd'][e.place] ?? `#${e.place}`;
          this.ui.big('Escaped', 'cyan', this.lobbyPlayers.length > 1 ? `${fmtTime(e.time)} · ${place}` : fmtTime(e.time), 0);
          const p = this.local.pos;
          this.effects.particles.burst(p.x, p.y + 1.5, p.z, 90, 9, 1.6, 0.4, [0.5, 1, 1], 1, 3, 4);
        } else {
          this.ui.toast(`${this.playerName(e.id)} escaped! (${fmtTime(e.time)})`);
        }
        this.lastHud = '';
        break;
      case 'alert': {
        const pos = this.enemyPos(e.e);
        const mine = e.target === this.meId;
        this.audio.spotted(pos, mine);
        if (mine) this.cam.addShake(0.25);
        break;
      }
      case 'lost':
        this.audio.lost(this.enemyPos(e.e));
        break;
      case 'charge':
        this.audio.charge(this.enemyPos(e.e));
        break;
      case 'shot':
        this.effects.spawnProjectile(e.id, e.p, e.v, e.t);
        this.audio.shot(tmpV.set(e.p[0], e.p[1], e.p[2]));
        break;
      case 'pend':
        this.effects.endProjectile(e.id, e.p, e.hit);
        break;
      case 'crumble': {
        const c = this.world.get(e.id);
        if (c) {
          if (e.s === 'fall') c.enabled = false;
          else if (e.s === 'reset') c.enabled = true;
          else c.shakeStart = e.t;
        }
        this.levelView.crumbleEvent(e.id, e.s, e.t);
        break;
      }
      case 'pickup': {
        this.taken.add(e.id);
        this.predicted.delete(e.id);
        this.pickups.take(e.id);
        const ps = this.powerOf(e.p);
        if (e.kind === 'shield') ps.shield = true;
        else if (e.kind === 'cloak') ps.cloakUntil = e.until;
        else ps.boostUntil = e.until;
        this.pickups.centre(e.id, tmpV);
        const c = new THREE.Color(POWER_COLOR[e.kind]);
        this.effects.particles.burst(tmpV.x, tmpV.y, tmpV.z, 50, 5, 0.9, 0.35, [c.r, c.g, c.b], 0.9, 2, 2);
        if (e.p === this.meId) {
          this.audio.pickup(e.kind);
          this.ui.big(POWER_NAME[e.kind], 'cyan', POWER_TIP[e.kind], 2.2);
        } else {
          this.ui.toast(`${this.playerName(e.p)} took ${POWER_NAME[e.kind].toLowerCase()}`);
        }
        break;
      }
      case 'shield': {
        const ps = this.powerOf(e.id);
        ps.shield = false;
        const mine = e.id === this.meId;
        const pos = mine ? this.local?.pos : this.remotes.get(e.id)?.pos;
        if (pos) this.effects.particles.burst(pos.x, pos.y + 1, pos.z, 60, 6, 0.8, 0.3, [0.4, 0.95, 1], 1, 3, 2);
        if (e.by >= 0) { const ep = this.enemyPos(e.by); this.effects.particles.burst(ep.x, ep.y + 1.2, ep.z, 30, 4, 0.6, 0.25, [1, 1, 0.6], 1, 6, 2); }
        if (mine) {
          if (e.v && this.local) this.local.shove(e.v);
          if (this.time - this.shieldPredictedAt > 1) {
            this.audio.shieldBreak(true);
            this.cam.addShake(0.35);
            this.ui.big('Shield broke', 'cyan', 'Get clear!', 1.3);
          }
          this.localGrace = this.matchTime + POWER.SHIELD_GRACE;
          if (this.local) this.local.laserGraceUntil = this.localGrace;
        } else this.audio.shieldBreak(false);
        break;
      }
      case 'portal':
        this.heaven.placePortal(e.p, e.yaw, e.at);
        break;
      case 'heaven':
        if (e.id === this.meId && this.local) {
          if (e.s === 'in') this.heaven.confirmEntry();
          else if (e.p) { this.heaven.returned(this.local, e.p, this.level.spawnYaw); this.grantFlight(); }
        } else if (e.s === 'in') {
          this.heaven.swallowed();
          this.ui.toast(`${this.playerName(e.id)} stepped into the light`);
        } else {
          this.ui.toast(`${this.playerName(e.id)} came back from the light, and can fly`);
          if (e.p) this.effects.particles.burst(e.p[0], e.p[1] + 1, e.p[2], 60, 5, 1.2, 0.45, [1, 0.88, 0.6], 1, -1, 1.5);
        }
        break;
      case 'left':
        this.ui.toast(`${this.playerName(e.id)} left the game`);
        break;
      case 'lostconn':
        if (e.id !== this.meId) this.ui.toast(`${this.playerName(e.id)} lost connection`);
        break;
      case 'reconnected':
        if (e.id !== this.meId) this.ui.toast(`${this.playerName(e.id)} reconnected`);
        break;
    }
  }

  /** Records how the local run ended, against this browser's best, for the results screen. */
  private endRun(escaped: boolean, cause: string | undefined, time: number) {
    if (this.runSummary) return;
    const area = escaped ? 'The Spire' : this.shownArea;
    // a run flown with Viktor's gift is its own thing: it never touches your records
    const assisted = !!this.local?.motor.canFly;
    const rec = assisted ? { prev: loadBest(), further: false, faster: false } : recordRun(this.runProgress, area ?? '', escaped ? time : null);
    this.runSummary = { progress: this.runProgress, area, escaped, cause, time, prevBest: rec.prev, further: rec.further, faster: rec.faster, assisted };
  }

  private fightBest(): number | null {
    try { const v = Number(localStorage.getItem(FIGHT_BEST_KEY)); return v > 0 && isFinite(v) ? v : null; } catch { return null; }
  }

  /** The Warden fell: this fight's time against this browser's best. */
  private recordFight(time: number): FightSummary {
    let prev: number | null = null;
    try { const v = Number(localStorage.getItem(FIGHT_BEST_KEY)); if (v > 0 && isFinite(v)) prev = v; } catch { /* private window */ }
    const best = prev === null || time < prev;
    if (best) { try { localStorage.setItem(FIGHT_BEST_KEY, String(Math.round(time * 100) / 100)); } catch { /* private window */ } }
    return { won: true, time, prevBest: prev, best };
  }

  // ------------------------------------------------------------------ input

  private onKey(code: string) {
    if (this.debug.toggle(code)) return;
    if (this.mode === 'playing' && !this.paused) {
      if (this.arena.onKey(code)) return;
      this.arena.skipReveal();
    }
    // F10: open the beacon now (on the course); in the arena, the Warden to half health (Shift: nearly dead)
    if (code === 'F10' && this.debug.allowed && this.serverDebug && this.mode === 'playing') {
      if (!this.arena.inArena) { this.conn?.send({ t: 'dbg', cmd: 'gate' }); this.ui.toast('The beacon opens'); }
      else { const v = this.input.isDown('ShiftLeft') ? 0.03 : 0.51; this.conn?.send({ t: 'dbg', cmd: 'bosshp', v }); this.ui.toast(`The Warden at ${Math.round(v * 100)}%`); }
      return;
    }
    if (code === 'F4' && this.debug.allowed && this.mode === 'playing') {
      this.debug.freeCam = !this.debug.freeCam;
      this.debug.camPos.copy(this.r.camera.position);
      this.debug.camYaw = this.cam.yaw; this.debug.camPitch = this.cam.pitch;
      return;
    }
    if (code === 'F8' && this.debug.allowed && this.serverDebug) { this.conn?.send({ t: 'dbg', cmd: 'restart' }); return; }
    if (code === 'F9' && this.debug.allowed && this.serverDebug && this.mode === 'playing') { this.conn?.send({ t: 'dbg', cmd: 'portal' }); this.ui.toast('Portal opened in front of you'); return; }
    if (code === 'F7' && this.debug.allowed && this.serverDebug) {
      this.conn?.send({ t: 'dbg', cmd: 'god' });
      this.godMode = !this.godMode;
      if (this.local) this.local.immune = this.godMode;
      this.ui.toast(this.godMode ? 'God mode ON (enemies and lasers cannot kill you)' : 'God mode OFF');
      return;
    }
    if (this.debug.overlay && this.serverDebug && this.local && !this.local.dead && !this.arena.inArena && /^Digit\d$/.test(code)) {
      const n = code === 'Digit0' ? 9 : Number(code.slice(5)) - 1;
      const wp = this.level.waypoints[n + (this.input.isDown('ShiftLeft') ? 10 : 0)];
      if (wp) {
        this.conn?.send({ t: 'dbg', cmd: 'tp', p: wp.p });
        this.local.teleport(wp.p[0], wp.p[1], wp.p[2]);
        this.cam.reset(this.local.renderPos, this.cam.yaw);
        this.ui.toast(`Teleported: ${wp.name}`);
      }
      return;
    }
    if (code === 'Escape' && this.mode === 'playing') {
      if (this.paused) this.resume();
    }
    // R on the results screen: straight into another run (the host decides for everyone)
    if (code === 'KeyR' && this.mode === 'results' && this.ui.overlayOpen && this.hostId === this.meId) {
      this.audio.click();
      this.input.requestLock();
      // after a fight, R is a rematch with the Warden
      this.conn?.send(this.arenaShown ? { t: 'start', stage: 'boss' } : { t: 'start' });
      return;
    }
    if (this.mode === 'playing' && this.local && (this.local.dead || this.local.finished) && (code === 'Space' || code === 'KeyE')) this.nextSpectate();
  }

  private openPause() {
    this.paused = true;
    if (this.offline) this.conn?.setPaused(true);
    this.ui.pause(this.hostId === this.meId, this.offline, this.lobbyPlayers.length === 1, this.arena.inArena);
    this.ui.captureHint(false);
  }

  private resume() {
    this.paused = false;
    if (this.offline) this.conn?.setPaused(false);
    this.ui.closePause();
    this.input.requestLock();
    this.ui.captureHint(!this.input.locked);
  }

  private nextSpectate() {
    const alive = [...this.remotes.values()].filter((r) => r.status === Status.Alive && r.anim !== Anim.Away);
    if (!alive.length) { this.spectate = 0; return; }
    const i = alive.findIndex((r) => r.id === this.spectate);
    this.spectate = alive[(i + 1) % alive.length].id;
  }

  /** Q / E: a dash across the way the camera is facing. */
  private readDash(can: boolean): { dashX: number; dashZ: number } {
    if (this.heaven.inRoom || this.local?.motor.flying || this.arena.locksInput) return { dashX: 0, dashZ: 0 };
    const left = can && this.input.wasPressed('KeyQ');
    const right = can && this.input.wasPressed('KeyE');
    if (left === right) return { dashX: 0, dashZ: 0 };
    this.cam.right(tmpR);
    const s = right ? 1 : -1;
    return { dashX: tmpR.x * s, dashZ: tmpR.z * s };
  }

  private readMove(): MoveInput {
    const inp = this.input;
    // Viktor's speech walks the runner onto its mark (the keys do nothing meanwhile)
    const st = this.heaven.steer;
    if (st && !this.paused) return { x: st.x * 0.45, z: st.z * 0.45, sprint: false, jumpHeld: false, jumpPressed: false, aimYaw: st.yaw };
    const can = !this.paused && !this.debug.freeCam && !this.heaven.locksInput && !this.arena.locksInput;
    let ix = 0, iz = 0;
    if (can) {
      if (inp.anyDown('KeyW', 'ArrowUp')) iz += 1;
      if (inp.anyDown('KeyS', 'ArrowDown')) iz -= 1;
      if (inp.anyDown('KeyD', 'ArrowRight')) ix += 1;
      if (inp.anyDown('KeyA', 'ArrowLeft')) ix -= 1;
    }
    this.cam.forward(tmpF);
    this.cam.right(tmpR);
    let mx = tmpF.x * iz + tmpR.x * ix, mz = tmpF.z * iz + tmpR.z * ix;
    const l = Math.hypot(mx, mz);
    if (l > 1) { mx /= l; mz /= l; }
    if (this.local?.motor.flying) {
      // flying: forward is wherever the camera looks, up and down included; Space climbs, Ctrl or C sinks
      this.cam.forward3(tmpV);
      let fx = tmpV.x * iz + tmpR.x * ix, fy = tmpV.y * iz, fz = tmpV.z * iz + tmpR.z * ix;
      const fl = Math.hypot(fx, fy, fz);
      if (fl > 1) { fx /= fl; fy /= fl; fz /= fl; }
      return {
        x: mx, z: mz, flyX: fx, flyY: fy, flyZ: fz,
        sprint: can && inp.anyDown('ShiftLeft', 'ShiftRight'),
        jumpHeld: can && inp.isDown('Space'),
        jumpPressed: false,
        descend: can && inp.anyDown('ControlLeft', 'ControlRight', 'KeyC'),
        aimYaw: this.cam.yaw,
      };
    }
    return {
      x: mx, z: mz,
      sprint: can && inp.anyDown('ShiftLeft', 'ShiftRight'),
      jumpHeld: can && inp.isDown('Space'),
      jumpPressed: can && inp.wasPressed('Space'),
      slidePressed: can && inp.wasPressed('KeyC'),
      // the rope stays on only while the right mouse button is held
      grappleHeld: can && inp.mouseRightDown,
      // the runner squares up to the camera and strafes, rather than turning its
      // whole body every time you step sideways
      aimYaw: this.cam.yaw,
      ...this.readDash(can),
    };
  }

  // ------------------------------------------------------------------ frame

  private frame() {
    this.clock.update();
    const dt = Math.min(0.05, this.clock.getDelta());
    this.time += dt;
    this.debug.tick(dt);
    if ((this.mode === 'playing' || this.mode === 'results') && this.conn) this.updateMatch(dt);
    else this.updateMenuCamera(dt);

    const t = this.mode === 'playing' || this.mode === 'results' ? this.matchTime : this.time;
    if (this.mode !== 'playing' && this.mode !== 'results') this.world.update(this.time);
    // the course is not drawn in the arena: leave it be
    if (!this.arenaShown) {
      this.levelView.update(this.world, t, dt);
      this.hazards.update(t);
      this.pickups.update(this.time, dt);
      this.props.update(this.time, dt);
    }
    this.sky.update(this.time, dt, this.r.camera.position);
    this.r.setLightning(this.sky.flashLevel);
    const lv = this.local ? this.local.renderVel : tmpV.set(0, 0, 0);
    this.effects.update(dt, t, this.r.camera, this.activeWorld, lv);
    this.r.focusShadows(this.local ? this.local.renderPos : this.r.camera.position);
    const lr = this.local;
    const shadowWorld = this.heaven.inRoom && this.heaven.view ? this.heaven.view.world : this.activeWorld;
    this.dropShadow.update(shadowWorld, lr ? lr.renderPos : tmpV, !!lr && this.mode === 'playing' && !lr.dead && !lr.finished && lr.model.root.visible);
    this.audio.setListener(this.r.camera);
    this.listenerRight.set(1, 0, 0).applyQuaternion(this.r.camera.quaternion);
    this.updateAudio(dt);
    if (this.heaven.inRoom && this.heaven.view) this.r.renderer.render(this.heaven.view.scene, this.r.camera);
    else this.r.render();

    if (this.settings.showFps || this.debug.overlay) this.updateDebugText();
    else this.ui.debug(null);
    this.input.endFrame();
  }

  private updateMenuCamera(dt: number) {
    void dt;
    const a = this.time * 0.035;
    const cam = this.r.camera;
    cam.position.set(Math.sin(a) * 38, 54 + Math.sin(a * 0.7) * 5, -34 + Math.cos(a) * 10);
    cam.lookAt(Math.sin(a * 0.5) * 12, 40, 110);
    if (cam.fov !== 60) { cam.fov = 60; cam.updateProjectionMatrix(); }
  }

  private updateMatch(dt: number) {
    const conn = this.conn!;
    this.matchTime = conn.serverNow() - this.goAt;
    const mt = this.matchTime;
    const local = this.local;

    // countdown
    if (local && mt < 0) {
      local.frozen = true;
      const n = Math.ceil(-mt);
      if (n !== this.lastCount && n <= 3) { this.lastCount = n; this.ui.big(String(n), '', 'Get ready', 0); this.audio.beep(false); }
    } else if (local && local.frozen) {
      local.frozen = false;
      if (this.lastCount !== 0) { this.lastCount = 0; this.ui.big('Go!', 'cyan', '', 1.2); this.audio.beep(true); }
    }

    // mouse look
    if (this.input.locked && !this.paused) {
      if (this.debug.freeCam) {
        this.debug.camYaw -= this.input.mouseDX * 0.0022 * this.settings.sensitivity;
        this.debug.camPitch = clamp(this.debug.camPitch - this.input.mouseDY * 0.0022 * this.settings.sensitivity, -1.5, 1.5);
      } else this.cam.look(this.input.mouseDX, this.input.mouseDY);
    }

    const move = this.readMove();
    const room = this.heaven.inRoom && this.heaven.view ? this.heaven.view : null;
    // the arena first: a power that moves the runner moves it in this very frame
    const canAct = !this.paused && !this.debug.freeCam && this.input.locked;
    this.arena.wheel(this.input.wheel);
    // R: the angel's soar or dive, sonic force's boom (on the results screen R is a rematch, handled in onKey)
    this.arena.update(dt, this.time, mt, canAct && this.input.mouseLeftPressed, canAct && this.input.mouseLeftDown, canAct, canAct && this.input.wasPressed('KeyR'));
    if (local) local.update(dt, move, room ? room.world : this.activeWorld, mt);
    if (this.arenaShown) { /* no portal, no Viktor past the beacon */ }
    else if (room) {
      const canTalk = !this.paused && !this.debug.freeCam;
      this.heaven.update(dt, this.time, mt, local, {
        interact: canTalk && this.input.wasPressed('KeyE'),
        advance: canTalk && (this.input.wasPressed('Space') || this.input.mouseLeftPressed),
      }, this.paused);
    } else {
      const canEnter = !!local && !local.dead && !local.finished && !local.frozen && !local.motor.canFly && this.phase === 'playing' && !this.paused && this.arena.stage === 'course';
      this.heaven.updateCourse(dt, this.time, mt, local, canEnter, this.listenerRight);
    }

    const renderT = mt - NET.INTERP_DELAY;
    for (const rp of this.remotes.values()) rp.update(renderT, dt, mt);
    let chasers = 0;
    let nearestDrone: THREE.Vector3 | null = null;
    let droneD = Infinity;
    const lp = local ? local.renderPos : this.r.camera.position;
    for (const e of this.enemies) {
      if (this.arenaShown) break;
      e.update(renderT, dt, mt, this.r.camera.position);
      const hunting = e.state === EState.Chase || e.state === EState.Alert || e.state === EState.Attack;
      // nobody is hunting a runner who has already escaped (or died)
      if (hunting && e.target === this.meId && local && !local.dead && !local.finished) chasers++;
      if (e.kind === 'flyer') { const d = e.pos.distanceTo(lp); if (d < droneD) { droneD = d; nearestDrone = e.pos; } }
      if (this.debug.cones) this.debug.updateCone(e.id, e.kind, e.pos, e.yaw, hunting);
    }
    this.danger += ((chasers > 0 ? 1 : 0) - this.danger) * damp(chasers > 0 ? 6 : 1.2, dt);
    this.vignette.style.opacity = String(Math.max(this.danger, this.arena.danger) * 0.85);
    this.nearestDrone = nearestDrone;

    // wind gust sounds near the player
    if (local && !room && !this.arenaShown) {
      for (const w of this.level.winds) {
        const cx = (w.min[0] + w.max[0]) / 2, cz = (w.min[2] + w.max[2]) / 2;
        const u = ((mt / w.period + w.phase) % 1 + 1) % 1;
        const cd = this.gustCooldown.get(w.id) ?? 0;
        if (u < 0.05 && this.time - cd > 1 && Math.hypot(local.pos.x - cx, local.pos.z - cz) < 40) {
          this.gustCooldown.set(w.id, this.time);
          this.audio.gust(tmpV.set(cx, (w.min[1] + w.max[1]) / 2, cz));
        }
      }
    }

    if (local && !local.dead && !local.finished && !room) {
      const lp2 = local.pos;
      // first-time tips near each new kind of obstacle
      if (this.time - this.hintAt > 3 && !this.arenaShown) {
        for (const h of this.level.hints) {
          if (this.hintsShown.has(h.key)) continue;
          if (Math.hypot(lp2.x - h.p[0], lp2.z - h.p[2]) < h.r && Math.abs(lp2.y - h.p[1]) < 4) {
            this.hintsShown.add(h.key);
            this.hintAt = this.time;
            this.ui.tip(h.text, 9);
            break;
          }
        }
      }
      // sparks from the zip-line pulley
      const m = local.motor;
      if (m.zip && Math.random() < dt * 30) {
        const rp = local.renderPos;
        this.effects.particles.emit(rp.x, rp.y + 2.1, rp.z, (Math.random() - 0.5) * 2, 1 + Math.random() * 2, (Math.random() - 0.5) * 2, 0.35, 0.09, 1, 0.75, 0.3, 1, 9, 0);
      }
      // a trail of golden motes off a runner in flight
      if (m.flying) this.flightTrail(local.renderPos, local.renderVel, dt);
    }
    for (const rp of this.remotes.values()) if (rp.anim === Anim.Fly && rp.status === Status.Alive) this.flightTrail(rp.pos, rp.vel, dt);
    if (!this.arenaShown) for (const p of this.hazards.switchedOn) if (p.distanceTo(lp) < 24) this.audio.laserOn(p);
    this.updateAbilities(mt);

    this.updateCamera(dt, mt);
    this.sendState(dt);
    if (!room && !this.arenaShown && this.arena.stage === 'course') this.updateArea(dt);
    this.updateHud(mt);
  }

  /** Golden motes shed by a flying runner, more of them the faster it goes. */
  private flightTrail(p: THREE.Vector3, v: THREE.Vector3, dt: number) {
    const sp = v.length();
    const n = Math.floor(dt * (14 + sp * 3) + Math.random());
    for (let i = 0; i < n; i++) {
      this.effects.particles.emit(p.x + (Math.random() - 0.5) * 0.5, p.y + 0.2 + Math.random() * 1.4, p.z + (Math.random() - 0.5) * 0.5,
        -v.x * 0.15 + (Math.random() - 0.5) * 0.6, -v.y * 0.15 + (Math.random() - 0.5) * 0.6, -v.z * 0.15 + (Math.random() - 0.5) * 0.6,
        0.7 + Math.random() * 0.5, 0.07 + Math.random() * 0.07, 1, 0.86, 0.55, 0.85, -0.4, -0.05);
    }
  }

  /** Viktor's gift: from now until the run ends you can fly. */
  private grantFlight() {
    if (!this.local) return;
    const m = this.local.motor;
    m.canFly = true;
    const b = this.level.bounds;
    m.flyLimits.minX = b.min[0] - FLY.MARGIN; m.flyLimits.maxX = b.max[0] + FLY.MARGIN;
    m.flyLimits.minZ = b.min[1] - FLY.MARGIN; m.flyLimits.maxZ = b.max[1] + FLY.MARGIN;
    m.flyLimits.minY = this.level.killY + FLY.FLOOR_ABOVE_KILL; m.flyLimits.maxY = FLY.CEILING;
    this.input.trapCtrl = true;
    this.heaven.closePortal();
  }

  private nearestDrone: THREE.Vector3 | null = null;
  private godMode = false;

  private updateCamera(dt: number, mt: number) {
    const local = this.local;
    if (this.debug.freeCam) {
      const d = this.debug;
      const f = tmpF.set(Math.sin(d.camYaw) * Math.cos(d.camPitch), Math.sin(d.camPitch), Math.cos(d.camYaw) * Math.cos(d.camPitch));
      const r = tmpR.set(-Math.cos(d.camYaw), 0, Math.sin(d.camYaw));
      const sp = (this.input.anyDown('ShiftLeft') ? 60 : 15) * dt;
      if (this.input.isDown('KeyW')) d.camPos.addScaledVector(f, sp);
      if (this.input.isDown('KeyS')) d.camPos.addScaledVector(f, -sp);
      if (this.input.isDown('KeyD')) d.camPos.addScaledVector(r, sp);
      if (this.input.isDown('KeyA')) d.camPos.addScaledVector(r, -sp);
      if (this.input.isDown('KeyE')) d.camPos.y += sp;
      if (this.input.isDown('KeyQ')) d.camPos.y -= sp;
      this.r.camera.position.copy(d.camPos);
      this.r.camera.lookAt(tmpV.copy(d.camPos).add(f));
      return;
    }
    if (!local) return;
    // Viktor's speech has its own camera set-ups, and so has arriving at the Warden (and going down there)
    if (this.heaven.ownsCamera) return;
    if (this.arena.ownsCamera) { this.arena.updateCamera(dt); return; }
    const camWorld = this.heaven.inRoom && this.heaven.view ? this.heaven.view.world : this.activeWorld;
    const ended = local.dead || local.finished;
    if (local.dead && local.doomed) {
      // watch the fall from the edge, then move on to spectating
      if (this.time - this.deathCam < 2.6 || !this.spectateTarget()) {
        this.cam.watch(dt, local.doomedAt, local.renderPos);
        return;
      }
    } else if (local.dead && this.time - this.deathCam < 2.4) {
      // slow orbit that follows the body as it falls and slides
      const a = (this.time - this.deathCam) * 0.35 + this.cam.yaw;
      const b = local.renderPos;
      tmpV.set(b.x - Math.sin(a) * 5, b.y + 3, b.z - Math.cos(a) * 5);
      this.cam.watch(dt, tmpV, b);
      return;
    }
    if (ended && this.time - this.deathCam > (local.finished ? 3 : 2.4)) {
      const target = this.spectateTarget();
      if (target) {
        this.cam.update(dt, { pos: target.pos, vel: target.vel, grounded: true, sprinting: false, shoulder: this.arenaShown ? 0.55 : 0, far: this.arenaShown ? 1.3 : 0 }, camWorld, mt);
        this.ui.bottom(`Spectating ${target.name}${this.aliveRemotes() > 1 ? ' — Space: next' : ''}`);
        return;
      }
      this.ui.bottom(local.finished && this.aliveRemotes() > 0 ? 'Waiting for the others…' : '');
    }
    const b = local.motor.body;
    // in the arena the view sits a little further back and over the shoulder, so the crosshair clears the runner
    const fight = this.arenaShown ? 1 : 0;
    this.cam.update(dt, { pos: local.renderPos, vel: local.renderVel, grounded: b.grounded, sprinting: local.motor.anim === Anim.Sprint, riding: !!local.motor.zip || !!local.motor.grapple, low: local.motor.sliding, dashing: this.dashKick > 0.05, boosted: local.motor.boost || local.motor.flashing, flying: local.motor.flying, shoulder: this.heaven.inRoom ? this.heaven.shoulder : fight * 0.55, far: fight * 1.3 }, camWorld, mt);
    this.dashKick = Math.max(0, this.dashKick - dt * 3);
  }

  private aliveRemotes() { return [...this.remotes.values()].filter((r) => r.status === Status.Alive).length; }

  private spectateTarget(): RemotePlayer | null {
    let t = this.remotes.get(this.spectate);
    if (!t || t.status !== Status.Alive || t.anim === Anim.Away) {
      t = [...this.remotes.values()].find((r) => r.status === Status.Alive && r.anim !== Anim.Away);
      this.spectate = t?.id ?? 0;
    }
    return t ?? null;
  }

  private sendState(dt: number) {
    const local = this.local;
    if (!local || !this.conn || local.dead || local.finished || this.heaven.inRoom) return;
    this.sendAcc += dt;
    if (this.sendAcc < 1 / NET.CLIENT_SEND_HZ) return;
    this.sendAcc = 0;
    const b = local.motor.body;
    const r = (v: number) => Math.round(v * 1000) / 1000;
    this.conn.send({
      t: 'st', s: this.seq++,
      p: [r(b.pos.x), r(b.pos.y), r(b.pos.z)],
      v: [r(b.vel.x + b.ext.x), r(b.vel.y), r(b.vel.z + b.ext.z)],
      y: r(local.motor.yaw), a: local.anim, g: local.groundId, tm: r(this.matchTime),
      b: this.arenaShown ? 1 : undefined,
    });
  }

  /**
   * The named area under the runner, with a little hysteresis: zone rectangles
   * butt up against each other, so running along a seam would otherwise strobe
   * two names at each other. A name has to hold for HUD_AREA_SETTLE before it
   * counts as having arrived somewhere.
   */
  private updateArea(dt: number) {
    const local = this.local;
    if (!local || this.phase !== 'playing' || local.finished) return;
    const here = zoneAt(this.level, local.pos.x, local.pos.z);
    if (here !== this.pendingArea) { this.pendingArea = here; this.pendingAreaFor = 0; }
    else this.pendingAreaFor += dt;
    // out over open air between two areas: keep showing the last one you were in
    if (here !== null && here !== this.shownArea && this.pendingAreaFor >= HUD_AREA_SETTLE) this.shownArea = here;
    const span = this.level.finish.max[2] - this.level.spawns[0][2];
    const progress = span > 0 ? (local.pos.z - this.level.spawns[0][2]) / span : 0;
    if (!local.dead) this.runProgress = Math.max(this.runProgress, clamp(progress, 0, 1));
    this.ui.area(this.shownArea, progress);
  }

  private updateHud(mt: number) {
    if (this.mode !== 'playing' && this.mode !== 'results') return;
    if (this.mode === 'playing') this.ui.timer(mt > 0 ? mt : null);
    const list = this.lobbyPlayers.map((p) => {
      const rp = this.remotes.get(p.id);
      let status = p.status;
      if (p.id === this.meId && this.local) status = this.local.dead ? Status.Dead : this.local.finished ? Status.Finished : Status.Alive;
      else if (rp) status = rp.status;
      const fight = this.arena.info(p.id);
      return { id: p.id, name: p.name, status, me: p.id === this.meId, connected: p.connected, hp: fight ? Math.round(fight.hp / 5) * 5 : undefined, power: fight?.power };
    });
    const key = JSON.stringify(list);
    if (key !== this.lastHud) { this.lastHud = key; this.ui.hudPlayers(list); }
  }

  private updateAudio(dt: number) {
    const local = this.local;
    const inGame = this.mode === 'playing' && !!local;
    let falling = 0, speed = 0, exposure = 0.5, zip = 0, belt = false, fly = 0;
    const flying = !!local && inGame && local.motor.flying && !local.dead;
    if (local && inGame) {
      const b = local.motor.body;
      speed = Math.hypot(b.vel.x, b.vel.z);
      falling = flying ? 0 : clamp((-b.vel.y - 8) / 25, 0, 1);
      if (flying) fly = clamp(Math.hypot(b.vel.x, b.vel.y, b.vel.z) / FLY.FAST, 0, 1);
      exposure = clamp((b.pos.y - 20) / 40, 0, 1);
      if (local.motor.zip && !local.dead) { zip = local.motor.zipSpeed; speed = zip; }
      belt = !local.dead && b.grounded && !!b.ground?.def.belt;
    }
    this.audio.update(dt, { exposure, speed, falling, chase: this.arenaShown ? 0 : this.danger, drone: inGame && !this.arenaShown ? this.nearestDrone : null, inGame, zip, belt, heaven: this.heaven.inRoom ? 1 : 0, flying, fly, arena: this.arenaShown && (this.mode === 'playing' || this.mode === 'results') });
  }

  private updateDebugText() {
    const lines = [`FPS ${this.debug.fps.toFixed(0)}`];
    if (this.debug.overlay) {
      const l = this.local;
      if (l) {
        const b = l.motor.body;
        lines.push(`pos ${b.pos.x.toFixed(1)} ${b.pos.y.toFixed(1)} ${b.pos.z.toFixed(1)}  ${b.grounded ? 'ground#' + (b.ground?.id ?? '-') : 'air'}`);
        lines.push(`speed ${Math.hypot(b.vel.x, b.vel.z).toFixed(1)}  vy ${b.vel.y.toFixed(1)}  anim ${l.anim}`);
        lines.push(`section ${this.debug.zoneAt(b.pos.x, b.pos.z)}`);
      }
      lines.push(`ping ${(this.conn ? this.conn.rtt * 1000 : 0).toFixed(0)}ms  match ${this.matchTime.toFixed(1)}  ${this.offline ? 'offline' : 'room ' + this.code}`);
      lines.push(`players ${this.lobbyPlayers.map((p) => `${p.id}:${p.name}${p.connected ? '' : '(lost)'}`).join(' ')}`);
      const S = ['idle', 'alert', 'chase', 'attack', 'search', 'return'];
      const near = [...this.enemies].sort((a, b) => a.pos.distanceTo(this.r.camera.position) - b.pos.distanceTo(this.r.camera.position)).slice(0, 5);
      for (const e of near) lines.push(`enemy ${e.id} ${e.kind.padEnd(6)} ${S[e.state].padEnd(6)} tgt ${e.target} ${e.pos.distanceTo(this.r.camera.position).toFixed(0)}m`);
      if (this.arena.inArena) lines.push(this.arena.debugLine());
      lines.push('F4 free cam · F6 vision · F7 god · F8 restart · F10 beacon / Warden hp · 1-0 teleport (Shift +10)');
    }
    this.ui.debug(lines.join('\n'));
  }
}

// Authoritative room: lobby, match flow, player validation, deaths/finish,
// enemies, projectiles, crumbling floors, and past the beacon the Warden's fight
// and past its rift Speedster Battle. Transport-agnostic (runs in Node or in the
// browser for offline play).

import { ARENA, BOSS, CORPSE, CRUMBLE, DEATH, FLY, GRAPPLE, LASER, MAX_PLAYERS, NET, PHP, PLAYER, PORTAL, POWER, RACE, RANGED, RIFT, SLIDE } from '../constants';
import { laserHit, onAnyZipline, windAt } from '../hazards';
import { getArena, type ArenaData } from '../level/arena';
import { getRace, type RaceData } from '../level/race';
import { Anim, makeBody, stepCorpse, type CharBody, type StepInfo } from '../physics/character';
import type { LevelData, PortalSpot } from '../level/types';
import { round2, round3, v3, type Vec3 } from '../math';
import { CollisionWorld } from '../physics/world';
import {
  EState, Status, type C2S, type DeathCause, type EnemySnap, type ErrCode, type GameEvent,
  type LobbyPlayer, type MatchResult, type Phase, type PlayerSnap, type S2C, type Stage,
} from '../protocol';
import { Enemy, type EnemyHost, type Target } from './enemy';
import { Fight, type FightHost } from './fight';
import { RaceState, type Racer } from './race';

export interface Conn {
  send(msg: S2C): void;
  close(): void;
}

export class RoomPlayer implements Target {
  readonly pos = v3();
  readonly vel = v3();
  yaw = 0;
  anim = 0;
  ground = -1;
  status: Status = Status.Alive;
  ready = false;
  lastMsgT = 0;
  lastSupportY = 0;
  disconnectedAt = 0;
  finishTime = 0;
  place = 0;
  cause: DeathCause | undefined;
  /** Debug: enemies cannot kill this player. */
  god = false;
  /** Powers: one-hit shield, cloak and boost (match times), plus the grace after a shield breaks. */
  shield = false;
  cloakUntil = 0;
  boostUntil = 0;
  graceUntil = 0;
  cloaked = false;
  /** Through the portal and with Viktor: off the course, untouchable, unseen. */
  away = false;
  awayAt = 0;
  /** Viktor's gift: this runner can fly for the rest of the run. */
  canFly = false;
  constructor(public readonly id: number, public name: string, public readonly token: string, public conn: Conn | null) {}
  get connected() { return this.conn !== null; }
  get targetable() { return this.status === Status.Alive && this.conn !== null && !this.cloaked && !this.away; }
  /** Flying right now: it has the gift and says it is in the air under its own power. */
  get flying() { return this.canFly && this.anim === Anim.Fly; }
  /** Sliding: smaller silhouette and hitbox. */
  get low() { return this.anim === Anim.Slide; }
  /** Mid front flip: tucked, so shots are aimed below the chest. */
  get tucked() { return this.anim === Anim.Flip; }
  resetPowers() {
    this.shield = false; this.cloakUntil = 0; this.boostUntil = 0; this.graceUntil = 0; this.cloaked = false;
    this.away = false; this.awayAt = 0; this.canFly = false;
  }
}

interface Projectile { id: number; owner: number; pos: Vec3; vel: Vec3; born: number }
/** A dead runner's body, still falling / sliding / riding platforms (in the world it died in). */
interface Corpse { p: RoomPlayer; body: CharBody; t: number; world: CollisionWorld; level: LevelData }
interface CrumbleState { s: 'idle' | 'shake' | 'fall'; t: number }
/** This run's portal: where it stands and the match time it opens. */
interface OpenPortal { spot: PortalSpot; at: number }

const ALLOWED_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const corpseWind: [number, number] = [0, 0];

export function randomToken(): string {
  let s = '';
  for (let i = 0; i < 24; i++) s += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)];
  return s;
}

export function randomCode(len = NET.ROOM_CODE_LENGTH): string {
  let s = '';
  for (let i = 0; i < len; i++) s += ALLOWED_CHARS[Math.floor(Math.random() * ALLOWED_CHARS.length)];
  return s;
}

export class Room implements EnemyHost, FightHost {
  phase: Phase = 'lobby';
  /** The course, the beacon opening, or the Warden's arena. */
  stage: Stage = 'course';
  /** Match time the beacon pulls everyone through, and the time it was reached (the course time). */
  gateAt = 0;
  courseTime = 0;
  /** The Warden's arena: built once (it never changes), and the fight in it while there is one. */
  readonly arena: ArenaData;
  readonly arenaWorld: CollisionWorld;
  fight: Fight | null = null;
  /** The rift the Warden left (while it is open), when its warp lands, and how long the fight took. */
  rift: { p: [number, number, number]; yaw: number; at: number; auto: number } | null = null;
  warpAt = 0;
  fightTime = 0;
  /** Speedster Battle: its course (built once), its world, and the race on it while there is one. */
  readonly raceData: RaceData;
  readonly raceWorld: CollisionWorld;
  race: RaceState | null = null;
  readonly players: RoomPlayer[] = [];
  hostId = 0;
  readonly world: CollisionWorld;
  enemies: Enemy[] = [];
  targets: Target[] = [];
  time = 0;
  goAt = 0;
  private projectiles: Projectile[] = [];
  private nextProj = 1;
  private crumbles = new Map<number, CrumbleState>();
  /** Power-up crates already taken this match. */
  private taken = new Set<number>();
  private corpses: Corpse[] = [];
  private readonly corpseInfo: StepInfo = { landed: false, impact: 0, wall: null, dynamicHit: null };
  private events: GameEvent[] = [];
  /** The rare portal to Viktor, when this run has one. */
  portal: OpenPortal | null = null;
  private snapAcc = 0;
  private endedAt = 0;
  lastActivity = 0;

  constructor(
    public readonly code: string,
    public readonly level: LevelData,
    private readonly clock: () => number,
    public readonly debug: boolean,
    /** Dice for the portal roll and the Warden's choices (tests pass their own). */
    private readonly random: () => number = Math.random,
  ) {
    this.world = new CollisionWorld(level);
    this.arena = getArena();
    this.arenaWorld = new CollisionWorld(this.arena.level);
    this.raceData = getRace();
    this.raceWorld = new CollisionWorld(this.raceData.level);
    this.lastActivity = clock();
  }

  get now() { return this.clock(); }
  get matchTime() { return this.now - this.goAt; }
  /** In the arena (and while the rift pulls the team through) everything is measured against the arena. */
  get inArena() { return this.stage === 'boss' || this.stage === 'warp'; }
  /** In Speedster Battle everything is measured against the race course. */
  get inRace() { return this.stage === 'race'; }
  get activeLevel() { return this.inRace ? this.raceData.level : this.inArena ? this.arena.level : this.level; }
  get activeWorld() { return this.inRace ? this.raceWorld : this.inArena ? this.arenaWorld : this.world; }
  /** Which side of the doors a client's reports come from: 0 the course, 1 the arena, 2 the race. */
  get side() { return this.inRace ? 2 : this.inArena ? 1 : 0; }
  get isEmpty() { return this.players.every((p) => !p.connected); }

  // ------------------------------------------------------------------ membership

  join(conn: Conn, name: string): RoomPlayer | ErrCode {
    if (this.phase !== 'lobby') return 'IN_PROGRESS';
    if (this.players.length >= MAX_PLAYERS) return 'ROOM_FULL';
    let id = 1;
    while (this.players.some((p) => p.id === id)) id++;
    const p = new RoomPlayer(id, sanitizeName(name, id), randomToken(), conn);
    this.players.push(p);
    this.players.sort((a, b) => a.id - b.id);
    if (!this.hostId || !this.players.some((q) => q.id === this.hostId)) this.hostId = id;
    conn.send({ t: 'joined', code: this.code, id: p.id, token: p.token, debug: this.debug });
    this.broadcastRoom();
    this.lastActivity = this.now;
    return p;
  }

  resume(conn: Conn, token: string): RoomPlayer | ErrCode {
    const p = this.players.find((q) => q.token === token);
    if (!p || p.status === Status.Left) return 'RESUME_FAILED';
    if (p.conn && p.conn !== conn) p.conn.close();
    p.conn = conn;
    p.disconnectedAt = 0;
    p.lastMsgT = this.now;
    conn.send({ t: 'joined', code: this.code, id: p.id, token: p.token, debug: this.debug });
    this.broadcastRoom();
    if (this.phase === 'countdown' || this.phase === 'playing') {
      // dropped out mid-conversation: Viktor has said enough, back to the pad with the gift
      if (p.away) this.bless(p, true);
      this.sendStart(p, true);
      this.pushEvent({ k: 'reconnected', id: p.id });
    } else if (this.phase === 'ended') {
      conn.send({ t: 'end', results: this.results(), duration: this.endedAt - this.goAt });
    }
    return p;
  }

  disconnect(p: RoomPlayer) {
    p.conn = null;
    p.disconnectedAt = this.now;
    if (this.phase === 'lobby') this.remove(p);
    else {
      this.pushEvent({ k: 'lostconn', id: p.id });
      this.broadcastRoom();
    }
  }

  private remove(p: RoomPlayer) {
    const i = this.players.indexOf(p);
    if (i >= 0) this.players.splice(i, 1);
    if (this.phase !== 'lobby') {
      // keep a ghost record for results, marked as left
      p.status = Status.Left;
      p.conn = null;
      this.players.splice(i, 0, p);
      this.pushEvent({ k: 'left', id: p.id });
    }
    if (p.id === this.hostId) {
      const next = this.players.find((q) => q.connected && q.status !== Status.Left);
      this.hostId = next ? next.id : 0;
    }
    this.broadcastRoom();
    this.checkEnd();
  }

  // ------------------------------------------------------------------ messages

  handle(p: RoomPlayer, msg: C2S) {
    this.lastActivity = this.now;
    switch (msg.t) {
      case 'ping':
        p.conn?.send({ t: 'pong', c: msg.c, s: round3(this.now) });
        return;
      case 'st':
        this.onState(p, msg);
        return;
      case 'die':
        if (this.phase === 'playing' && p.status === Status.Alive && msg.cause === 'laser') this.kill(p, 'laser', null);
        return;
      case 'portal':
        this.enterPortal(p);
        return;
      case 'bless':
        this.bless(p, false);
        return;
      case 'pick':
        if (this.fight && this.stage === 'boss' && (this.phase === 'playing' || this.phase === 'countdown') && typeof msg.k === 'number') this.fight.pick(p, msg.k | 0);
        return;
      case 'pow':
        if (this.fight && this.stage === 'boss' && this.phase === 'playing') this.fight.pow(p, msg);
        return;
      case 'rift':
        this.enterRift(p);
        return;
      case 'ready':
        if (this.phase !== 'lobby') return;
        p.ready = !!msg.r;
        this.broadcastRoom();
        return;
      case 'start':
        if (p.id !== this.hostId) { p.conn?.send({ t: 'err', code: 'NOT_HOST', msg: 'Only the host can start.' }); return; }
        // Straight from the results screen as well as from the lobby: a run ends
        // on one mistake, so going back round through the lobby for every retry
        // is pure friction. Everyone still in the room already said they were
        // ready for this course, so that agreement carries over.
        if (this.phase !== 'lobby' && this.phase !== 'ended') return;
        if (this.players.some((q) => q.id !== this.hostId && q.connected && !q.ready)) return;
        if (this.phase === 'ended') this.dropDisconnected();
        // a rematch goes straight back into the Warden's arena, or onto the race grid
        this.startMatch(msg.stage === 'boss' ? 'boss' : msg.stage === 'race' ? 'race' : 'course');
        return;
      case 'restart':
        // A run with no checkpoints: on your own, the pause menu can throw it away
        // and start over. With anyone else in the room that would end their run
        // too, so it is only for a host who is alone.
        if (p.id !== this.hostId || this.players.length !== 1) return;
        if (this.phase !== 'countdown' && this.phase !== 'playing') return;
        // in the arena, starting over means starting the fight over; in the race, the race
        this.startMatch(this.restartStage);
        return;
      case 'lobby':
        if (p.id !== this.hostId) return;
        this.toLobby();
        return;
      case 'leave':
        this.remove(p);
        p.conn = null;
        return;
      case 'dbg':
        if (!this.debug) return;
        if (msg.cmd === 'tp' && p.status === Status.Alive) {
          p.pos.x = msg.p[0]; p.pos.y = msg.p[1]; p.pos.z = msg.p[2];
          p.lastSupportY = msg.p[1];
          p.lastMsgT = this.now;
        } else if (msg.cmd === 'restart' && p.id === this.hostId) {
          this.startMatch(this.restartStage);
        } else if (msg.cmd === 'gate' && this.stage === 'course' && this.phase === 'playing' && p.status === Status.Alive) {
          this.openGate(p);
        } else if (msg.cmd === 'rift' && this.fight && this.stage === 'boss' && this.phase === 'playing' && this.fight.warden.alive) {
          // the Warden goes down now, and its rift opens the way it would
          this.fight.hitWarden(null, this.fight.warden.hp + 1, 0, p.pos, 0);
        } else if (msg.cmd === 'bosshp' && this.fight && typeof msg.v === 'number' && isFinite(msg.v)) {
          const w = this.fight.warden;
          w.hp = Math.max(1, Math.min(w.maxHp, Math.round(w.maxHp * msg.v)));
        } else if (msg.cmd === 'god') {
          p.god = !p.god;
        } else if (msg.cmd === 'portal' && p.status === Status.Alive && !p.away && (this.phase === 'playing' || this.phase === 'countdown')) {
          // a portal right in front of the runner, open at once (for trying the easter egg out)
          const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
          const x = p.pos.x + fx * 5, z = p.pos.z + fz * 5;
          const below = this.world.groundBelow(x, p.pos.y + 1.5, z, 6);
          const y = isFinite(below) ? p.pos.y + 1.5 - below : p.pos.y;
          this.portal = { spot: { p: [round2(x), round2(y), round2(z)], yaw: round2(p.yaw + Math.PI) }, at: Math.max(0, this.matchTime) };
          const s = this.portal.spot;
          this.pushEvent({ k: 'portal', p: s.p, yaw: s.yaw, at: round2(this.portal.at) });
        }
        return;
      default:
        return;
    }
  }

  private onState(p: RoomPlayer, m: Extract<C2S, { t: 'st' }>) {
    // a racer who is home keeps reporting as it coasts on down the run-out
    if ((p.status !== Status.Alive && !(this.inRace && p.status === Status.Finished)) || p.away) return;
    if (this.phase !== 'playing' && this.phase !== 'countdown') return;
    // a report from the other side of a door (sent before the client knew) is stale
    if ((m.b ?? 0) !== this.side) return;
    const [x, y, z] = m.p;
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return;
    const now = this.now;
    const dt = Math.max(0.05, now - p.lastMsgT);
    p.lastMsgT = now;
    const moved = Math.hypot(x - p.pos.x, z - p.pos.z);
    const rise = y - p.pos.y;
    // nobody leaves the grid before the race's "Go!"
    const frozen = this.phase === 'countdown' || (this.inRace && !!this.race && this.matchTime < this.race.go);
    // a flash strike moves a runner further than running could, once; a speedster simply runs faster
    const f = this.inArena ? this.fight?.fighter(p) : null;
    const maxSpeed = this.inRace ? RACE.MAX_CLIENT_SPEED : this.inArena ? (f?.kind === 'speed' ? ARENA.MAX_SPEEDSTER_SPEED : ARENA.MAX_CLIENT_SPEED) : p.canFly ? FLY.MAX_CLIENT_SPEED : NET.MAX_CLIENT_SPEED;
    const extra = f && this.matchTime < f.allowUntil ? f.allow : 0;
    const limit = maxSpeed * dt + 2.5;
    if (moved > limit + extra || rise > 20 * dt + 3 + extra || (frozen && moved > 1.5)) {
      p.conn?.send({ t: 'fix', p: [p.pos.x, p.pos.y, p.pos.z] });
      return;
    }
    // the allowance is used up by the ground it covers
    if (f && extra > 0) f.allow = Math.max(0, f.allow - Math.max(moved, rise));
    p.pos.x = x; p.pos.y = y; p.pos.z = z;
    p.vel.x = m.v[0]; p.vel.y = m.v[1]; p.vel.z = m.v[2];
    p.yaw = m.y; p.anim = m.a | 0; p.ground = m.g | 0;
    // only the portal itself takes a runner off the course
    if (p.anim === Anim.Away) p.anim = Anim.Idle;
    if (this.inRace) {
      this.checkPlayer(p);
      const r = this.race?.report(p, m.v[0], m.v[2], m.tm, this.matchTime);
      if (r) this.raceHome(r);
      return;
    }
    if (p.ground >= 0 && !this.inArena) this.touchCrumble(p.ground);
    this.checkPlayer(p);
    // lasers: judged at the client's own clock (clamped), so latency never kills unfairly
    if (p.status === Status.Alive && this.phase === 'playing' && !this.inArena && this.level.lasers.length) {
      const mt = this.matchTime;
      const tc = typeof m.tm === 'number' && isFinite(m.tm) ? Math.min(mt + 0.05, Math.max(mt - 0.35, m.tm)) : mt;
      const h = (p.low ? SLIDE.HEIGHT : PLAYER.HEIGHT) - 0.1;
      if (laserHit(this.level, x, y, z, tc, PLAYER.RADIUS - LASER.SERVER_SHRINK, h)) this.kill(p, 'laser', null);
    }
  }

  // ------------------------------------------------------------------ match flow

  /** Where a restart goes: the stage the run is in (the course, the fight, or the race). */
  private get restartStage(): 'course' | 'boss' | 'race' { return this.inRace ? 'race' : this.inArena ? 'boss' : 'course'; }

  /** A new run: from the landing pad, or (a rematch) straight into the Warden's arena or onto the race grid. */
  private startMatch(stage: 'course' | 'boss' | 'race' = 'course') {
    const boss = stage === 'boss', race = stage === 'race';
    this.phase = 'countdown';
    this.goAt = this.now + NET.COUNTDOWN;
    this.projectiles = [];
    this.crumbles.clear();
    this.corpses = [];
    this.taken.clear();
    for (const c of this.world.crumbles) { c.enabled = true; c.shakeStart = -1; }
    this.enemies = this.level.enemies.map((d) => new Enemy(d));
    this.stage = stage;
    this.gateAt = 0;
    this.courseTime = 0;
    this.fight = null;
    this.rift = null;
    this.warpAt = 0;
    this.fightTime = 0;
    this.race = null;
    this.arenaWorld.puppeteer = null;
    this.portal = stage === 'course' ? this.rollPortal() : null;
    const L = race ? this.raceData.level : boss ? this.arena.level : this.level;
    const spawns = L.spawns;
    this.players.forEach((p, i) => {
      if (p.status === Status.Left && !p.connected) return;
      const s = spawns[i % spawns.length];
      p.pos.x = s[0]; p.pos.y = s[1]; p.pos.z = s[2];
      p.vel.x = p.vel.y = p.vel.z = 0;
      p.status = Status.Alive;
      p.lastSupportY = s[1];
      p.finishTime = 0; p.place = 0; p.cause = undefined;
      p.lastMsgT = this.now;
      p.anim = 0; p.yaw = L.spawnYaw; p.ground = -1;
      p.resetPowers();
    });
    // drop records of players that left in a previous match
    for (let i = this.players.length - 1; i >= 0; i--) if (this.players[i].status === Status.Left) this.players.splice(i, 1);
    this.targets = this.players;
    this.world.update(this.matchTime);
    this.world.syncPrevious();
    if (boss) this.fight = new Fight(this, this.arena, this.arenaWorld, this.players, this.matchTime);
    // straight onto the grid: the race starts with the countdown's "Go!"
    if (race) this.race = new RaceState(this.raceData.track, this.players, 0);
    this.events = [];
    for (const p of this.players) this.sendStart(p, false);
    this.broadcastRoom();
  }

  /**
   * Somebody reached the beacon: it opens, and a moment later it pulls the whole
   * team through into the Warden's arena (anyone who fell on the way comes too).
   */
  private openGate(p: RoomPlayer) {
    if (this.stage !== 'course') return;
    this.stage = 'gate';
    this.courseTime = this.matchTime;
    this.gateAt = this.courseTime + ARENA.GATE_TIME;
    p.finishTime = this.courseTime;
    this.pushEvent({ k: 'gate', id: p.id, at: round2(this.gateAt), time: round2(this.courseTime) });
  }

  private enterArena() {
    this.stage = 'boss';
    this.portal = null;
    this.projectiles = [];
    this.corpses = [];
    const L = this.arena.level;
    const team = this.players.filter((p) => p.status !== Status.Left);
    const spawns: Record<number, [number, number, number]> = {};
    team.forEach((p, i) => {
      const s = L.spawns[i % L.spawns.length];
      p.pos.x = s[0]; p.pos.y = s[1]; p.pos.z = s[2];
      p.vel.x = p.vel.y = p.vel.z = 0;
      p.status = Status.Alive;
      p.cause = undefined;
      p.lastSupportY = s[1];
      p.lastMsgT = this.now;
      p.anim = Anim.Idle; p.yaw = L.spawnYaw; p.ground = -1;
      p.resetPowers();
      spawns[p.id] = [s[0], s[1], s[2]];
    });
    this.fight = new Fight(this, this.arena, this.arenaWorld, team, this.matchTime);
    this.pushEvent({ k: 'arena', spawns, wake: round2(this.fight.wakeBy) });
    this.broadcastRoom();
  }

  // ------------------------------------------------------------------ the fight's hooks (FightHost)

  killRunner(p: RoomPlayer, cause: DeathCause, from: Vec3 | null) { this.kill(p, cause, null, from); }

  /**
   * The Warden is down and has come apart (FightHost): a rift tears open on the floor,
   * on the diagonal furthest from the wreck (clear of the pillars, the pads, the ramps
   * and the cover walls), and the way on is through it.
   */
  won() {
    if (this.phase !== 'playing' || !this.fight || this.rift || this.stage !== 'boss') return;
    const t = this.matchTime, w = this.fight.warden;
    // measured as it always was, to the end of the victory, so the records stay comparable
    this.fightTime = t - this.fight.arrivedAt + BOSS.DYING + BOSS.VICTORY - RIFT.OPEN_AFTER;
    const off = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    const centre = Math.hypot(w.x - ARENA.x, w.z - ARENA.z) < 4, wa = Math.atan2(w.x - ARENA.x, w.z - ARENA.z);
    let phi = (3 * Math.PI) / 4, best = -Infinity;
    for (const d of [Math.PI / 4, (3 * Math.PI) / 4, (-3 * Math.PI) / 4, -Math.PI / 4]) {
      // (with the wreck in the middle: the side toward the Threshold, where the team came in)
      const score = centre ? -off(d, Math.PI) : off(d, wa);
      if (score > best + 1e-9) { best = score; phi = d; }
    }
    const p: [number, number, number] = [round2(ARENA.x + Math.sin(phi) * RIFT.RADIUS), round2(ARENA.y + RIFT.HEIGHT), round2(ARENA.z + Math.cos(phi) * RIFT.RADIUS)];
    this.rift = { p, yaw: round2(phi + Math.PI), at: t, auto: t + RIFT.AUTO };
    this.pushEvent({ k: 'rift', p, yaw: this.rift.yaw, at: round2(t), auto: round2(this.rift.auto), fight: round2(this.fightTime) });
  }

  /** The runner says it stepped into the rift: believe it if the server's copy of it is at the ring. */
  private enterRift(p: RoomPlayer) {
    const r = this.rift;
    if (!r || this.stage !== 'boss' || this.phase !== 'playing' || p.status !== Status.Alive) return;
    const d = Math.hypot(p.pos.x - r.p[0], p.pos.y + 1.2 - r.p[1], p.pos.z - r.p[2]);
    if (d > RIFT.ENTER + RIFT.SERVER_SLACK) return;
    this.openWarp(p.id);
  }

  /** The rift pulls the whole team through (runner `id` stepped in; 0: it took them). */
  private openWarp(id: number) {
    if (this.stage !== 'boss') return;
    this.stage = 'warp';
    this.warpAt = this.matchTime + ARENA.GATE_TIME;
    this.pushEvent({ k: 'warp', id, at: round2(this.warpAt) });
  }

  /** Everyone is through: on the start grid, the fallen too, and a countdown to "Go!". */
  private enterRace() {
    this.stage = 'race';
    this.rift = null;
    this.projectiles = [];
    this.corpses = [];
    const L = this.raceData.level;
    const team = this.players.filter((p) => p.status !== Status.Left);
    const spawns: Record<number, [number, number, number]> = {};
    team.forEach((p, i) => {
      const s = L.spawns[i % L.spawns.length];
      p.pos.x = s[0]; p.pos.y = s[1]; p.pos.z = s[2];
      p.vel.x = p.vel.y = p.vel.z = 0;
      p.status = Status.Alive;
      p.cause = undefined;
      p.finishTime = 0; p.place = 0;
      p.lastSupportY = s[1];
      p.lastMsgT = this.now;
      p.anim = Anim.Idle; p.yaw = L.spawnYaw; p.ground = -1;
      p.resetPowers();
      spawns[p.id] = [s[0], s[1], s[2]];
    });
    const go = this.matchTime + RACE.ARRIVE;
    this.race = new RaceState(this.raceData.track, team, go);
    this.pushEvent({ k: 'race', spawns, go: round2(go) });
    this.broadcastRoom();
  }

  /** A racer crossed the line. */
  private raceHome(r: Racer) {
    const p = r.p;
    p.status = Status.Finished;
    p.finishTime = r.time;
    p.place = r.place;
    const row = this.race!.row(p)!;
    this.pushEvent({ k: 'finish', id: p.id, time: r.time, place: r.place, top: row.top, avg: row.avg });
    this.broadcastRoom();
    this.checkEnd();
  }

  /** The race is over: one results screen for the whole run (the course, the fight, the race). */
  private endRace() {
    if (this.phase === 'ended' || !this.race) return;
    this.race.close(this.matchTime);
    this.phase = 'ended';
    this.endedAt = this.now;
    this.flushEvents();
    const fight = this.fight && this.fightTime > 0 ? { boss: true, fight: round2(this.fightTime) } : {};
    this.broadcast({ t: 'end', results: this.results(), duration: round2(this.endedAt - this.goAt), race: true, ...fight });
    this.broadcastRoom();
  }

  rand() { return this.random(); }

  private sendStart(p: RoomPlayer, resume: boolean) {
    const spawns: Record<number, [number, number, number]> = {};
    for (const q of this.players) spawns[q.id] = [round3(q.pos.x), round3(q.pos.y), round3(q.pos.z)];
    const crumbles: [number, string, number][] = [];
    for (const [id, s] of this.crumbles) if (s.s !== 'idle') crumbles.push([id, s.s, s.t]);
    const powers: [number, number, number, number][] = this.players.map((q) => [q.id, q.shield ? 1 : 0, round2(q.cloakUntil), round2(q.boostUntil)]);
    const po = this.portal;
    const portal: [number, number, number, number, number] | undefined = po ? [po.spot.p[0], po.spot.p[1], po.spot.p[2], po.spot.yaw, round2(po.at)] : undefined;
    const fly = this.players.filter((q) => q.canFly).map((q) => q.id);
    const f = this.fight;
    p.conn?.send({
      t: 'start', goAt: round3(this.goAt), now: round3(this.now), spawns, resume, crumbles, taken: [...this.taken], powers, portal, fly,
      stage: this.stage, gateAt: this.stage === 'gate' ? round2(this.gateAt) : undefined, course: this.courseTime ? round2(this.courseTime) : undefined,
      picks: f ? f.fighters.filter((q) => q.power).map((q) => [q.id, q.power - 1] as [number, number]) : undefined,
      awake: f ? f.awake : undefined, wake: f ? round2(f.wakeBy) : undefined,
      rift: this.rift ? [this.rift.p[0], this.rift.p[1], this.rift.p[2], this.rift.yaw, round2(this.rift.at), round2(this.rift.auto)] : undefined,
      warpAt: this.stage === 'warp' ? round2(this.warpAt) : undefined,
      rgo: this.race ? round2(this.race.go) : undefined, done: this.race ? this.race.done() : undefined,
    });
  }

  /**
   * One run in ten gets a portal, at a random spot from the level's list, opening a
   * few seconds in. While someone in the room is called PORTAL.TEST_NAME every run
   * gets one, on the landing pad right in front of the spawns, opening just after "Go!".
   */
  private rollPortal(): OpenPortal | null {
    const spots = this.level.portals;
    const test = this.players.some((p) => p.name.trim().toLowerCase() === PORTAL.TEST_NAME);
    if (test && this.level.portalTest) return { spot: this.level.portalTest, at: PORTAL.TEST_OPEN };
    if (!spots?.length || (!test && this.random() >= PORTAL.CHANCE)) return null;
    const spot = spots[Math.min(spots.length - 1, Math.floor(this.random() * spots.length))];
    return { spot, at: PORTAL.OPEN_MIN + this.random() * (PORTAL.OPEN_MAX - PORTAL.OPEN_MIN) };
  }

  /** The runner says it walked into the portal: believe it if it was standing at the ring. */
  private enterPortal(p: RoomPlayer) {
    const po = this.portal;
    if (!po || this.phase !== 'playing' || p.status !== Status.Alive || p.away || p.canFly) return;
    if (this.matchTime < po.at) return;
    const c = po.spot.p;
    const d = Math.hypot(p.pos.x - c[0], p.pos.y + 1 - (c[1] + PORTAL.HEIGHT), p.pos.z - c[2]);
    if (d > PORTAL.ENTER_RADIUS + PORTAL.SERVER_SLACK) return;
    p.away = true;
    p.awayAt = this.matchTime;
    p.anim = Anim.Away;
    p.vel.x = p.vel.y = p.vel.z = 0;
    this.pushEvent({ k: 'heaven', id: p.id, s: 'in' });
  }

  /**
   * Viktor has had his say: back to the landing pad, able to fly. `force` skips the
   * minimum stay (a runner who reconnects mid-conversation is simply sent back).
   */
  private bless(p: RoomPlayer, force: boolean) {
    if (!p.away || p.status !== Status.Alive) return;
    if (!force && (this.phase !== 'playing' || this.matchTime - p.awayAt < PORTAL.MIN_STAY)) return;
    const i = Math.max(0, this.players.indexOf(p));
    const s = this.level.spawns[i % this.level.spawns.length];
    p.away = false;
    p.canFly = true;
    p.pos.x = s[0]; p.pos.y = s[1]; p.pos.z = s[2];
    p.vel.x = p.vel.y = p.vel.z = 0;
    p.lastSupportY = s[1];
    p.lastMsgT = this.now;
    p.anim = Anim.Idle;
    p.ground = -1;
    this.pushEvent({ k: 'heaven', id: p.id, s: 'out', p: [s[0], s[1], s[2]] });
  }

  /** Forgets players who are gone for good and hands the room on if the host is one of them. */
  private dropDisconnected() {
    for (let i = this.players.length - 1; i >= 0; i--) if (!this.players[i].connected) this.players.splice(i, 1);
    if (!this.players.some((q) => q.id === this.hostId)) this.hostId = this.players[0]?.id ?? 0;
  }

  private toLobby() {
    this.phase = 'lobby';
    for (const p of this.players) { p.ready = false; p.status = Status.Alive; }
    this.dropDisconnected();
    this.projectiles = [];
    this.enemies = [];
    this.portal = null;
    this.stage = 'course';
    this.fight = null;
    this.rift = null;
    this.race = null;
    this.broadcastRoom();
  }

  private checkEnd() {
    if (this.phase !== 'playing' && this.phase !== 'countdown') return;
    // the race ends by its own rules (everyone home, or the time after the winner out)
    if (this.inRace) { if (this.race?.over(this.matchTime)) this.endRace(); return; }
    // on the way through the beacon or the rift nobody is out yet (the light takes the fallen too);
    // in the arena, as on the course, it is over when nobody is left standing
    if (this.stage === 'gate' || this.stage === 'warp') { if (this.players.some((p) => p.status !== Status.Left)) return; }
    else if (this.players.some((p) => p.status === Status.Alive)) return;
    // ...unless the Warden is already down: its rift takes the fallen with it
    if (this.stage === 'boss' && this.rift && this.players.some((p) => p.status !== Status.Left && p.connected)) { this.openWarp(0); return; }
    this.phase = 'ended';
    this.endedAt = this.now;
    this.flushEvents();
    const fight = this.stage === 'boss' && this.fight ? { boss: false, fight: round2(this.matchTime - this.fight.arrivedAt) } : {};
    this.broadcast({ t: 'end', results: this.results(), duration: round2(this.endedAt - this.goAt), ...fight });
    this.broadcastRoom();
  }

  private results(): MatchResult[] {
    return this.players.map((p) => {
      const q = this.fight?.fighter(p);
      return {
        id: p.id, name: p.name, status: p.status,
        time: round2(p.status === Status.Finished ? p.finishTime : Math.max(0, (p.finishTime || this.endedAt - this.goAt))),
        cause: p.cause, place: p.place || undefined,
        course: this.courseTime ? round2(this.courseTime) : undefined,
        damage: q ? Math.round(q.damage) : undefined, deaths: q?.deaths, bots: q?.bots, power: q && q.power ? q.power - 1 : undefined,
        race: this.race?.row(p),
      };
    });
  }

  // ------------------------------------------------------------------ gameplay

  private checkPlayer(p: RoomPlayer) {
    if (p.status !== Status.Alive || this.phase !== 'playing' || p.away) return;
    const { x, y, z } = p.pos;
    const L = this.activeLevel;
    // the race has no way to fall: a runner found under the course is put back on it
    if (this.inRace) { if (y < L.killY && this.race) this.recover(p, this.race.recoverPoint(p)); return; }
    // the beacon on the Spire: it opens into the way through to the Warden
    const f = this.level.finish;
    if (this.stage === 'course' && x >= f.min[0] && x <= f.max[0] && y >= f.min[1] && y <= f.max[1] && z >= f.min[2] && z <= f.max[2]) {
      this.openGate(p);
      return;
    }
    if (y < L.killY) { this.kill(p, 'fall', null); return; }
    if (!this.inArena) this.checkPickups(p);
    // flying under your own power over the void is not falling either, and nor is
    // letting go of the sky on purpose: flight can catch you again all the way down,
    // so for a runner who can fly only the bottom of the world ends a fall
    if (p.canFly) { p.lastSupportY = y; return; }
    // the same for the angel's wings in the arena: they can beat it back up out of the moat
    if (this.inArena && this.fight?.fighter(p)?.kind === 'angel') { p.lastSupportY = y; return; }
    // hanging on a zip line or swinging on a grapple rope over the void is not falling
    if (L.ziplines.length && onAnyZipline(L, x, y, z)) { p.lastSupportY = y; return; }
    if (p.anim === Anim.Swing && this.nearAnchor(x, y, z)) { p.lastSupportY = y; return; }
    // a flash strike or a blink can carry you across open air: that is not a fall either
    if (p.anim === Anim.Flash) { p.lastSupportY = y; return; }
    const below = this.activeWorld.groundBelow(x, y + 0.3, z, 600);
    if (below < 2.6) p.lastSupportY = y + 0.3 - below;
    else if (!isFinite(below) && y < p.lastSupportY - DEATH.FALL_DROP) this.kill(p, 'fall', null);
  }

  /** Puts a runner back at `at` (and tells its client). */
  private recover(p: RoomPlayer, at: [number, number, number]) {
    p.pos.x = at[0]; p.pos.y = at[1]; p.pos.z = at[2];
    p.vel.x = p.vel.y = p.vel.z = 0;
    p.lastSupportY = at[1];
    p.conn?.send({ t: 'fix', p: at });
  }

  private nearAnchor(x: number, y: number, z: number): boolean {
    for (const g of this.activeLevel.grapples) {
      if (Math.hypot(g.p[0] - x, g.p[1] - (y + GRAPPLE.HAND), g.p[2] - z) < GRAPPLE.RANGE + 1) return true;
    }
    return false;
  }

  /** Walking through a crate takes it (first come, first served). */
  private checkPickups(p: RoomPlayer) {
    if (this.phase !== 'playing') return;
    for (const c of this.level.pickups) {
      if (this.taken.has(c.id)) continue;
      const dy = p.pos.y - c.p[1];
      if (dy < -0.6 || dy > 2.2 || Math.hypot(p.pos.x - c.p[0], p.pos.z - c.p[2]) > POWER.PICKUP_RADIUS) continue;
      this.taken.add(c.id);
      const t = this.matchTime;
      let until = 0;
      if (c.kind === 'shield') p.shield = true;
      else if (c.kind === 'cloak') { p.cloakUntil = until = t + POWER.CLOAK_TIME; p.cloaked = true; }
      else { p.boostUntil = until = t + POWER.BOOST_TIME; }
      this.pushEvent({ k: 'pickup', id: c.id, p: p.id, kind: c.kind, until: round2(until) });
    }
  }

  /** Throws a dead body: its own momentum plus a push away from whatever killed it. */
  private throwBody(p: RoomPlayer, cause: DeathCause, e: Enemy | null, from: Vec3 | null): [number, number, number] {
    const v = v3(p.vel.x * CORPSE.KEEP, Math.min(p.vel.y * CORPSE.KEEP, 2), p.vel.z * CORPSE.KEEP);
    let push = 0, lift = 0;
    if (cause === 'melee') { push = CORPSE.MELEE_PUSH; lift = CORPSE.MELEE_LIFT; }
    else if (cause === 'flyer') { push = CORPSE.FLYER_PUSH; lift = CORPSE.FLYER_LIFT; }
    else if (cause === 'shot') { push = CORPSE.SHOT_PUSH; lift = CORPSE.SHOT_LIFT; }
    else if (cause === 'laser') lift = CORPSE.LASER_LIFT;
    else if (cause === 'warden') { push = CORPSE.SHOT_PUSH; lift = CORPSE.MELEE_LIFT; }
    else if (cause === 'bot') { push = CORPSE.FLYER_PUSH; lift = CORPSE.FLYER_LIFT; }
    const src = from ?? (e ? e.pos : null);
    if (push > 0 && src) {
      const dx = p.pos.x - src.x, dz = p.pos.z - src.z;
      const d = Math.hypot(dx, dz) || 1;
      v.x += (dx / d) * push; v.z += (dz / d) * push;
    }
    v.y += lift;
    const body = makeBody(PLAYER.RADIUS, CORPSE.HEIGHT);
    body.pos.x = p.pos.x; body.pos.y = p.pos.y; body.pos.z = p.pos.z;
    body.vel.x = v.x; body.vel.y = v.y; body.vel.z = v.z;
    this.corpses.push({ p, body, t: 0, world: this.activeWorld, level: this.activeLevel });
    return [round2(v.x), round2(v.y), round2(v.z)];
  }

  private updateCorpses(dt: number) {
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      c.t += dt;
      windAt(c.level, c.body.pos.x, c.body.pos.y, c.body.pos.z, this.matchTime, corpseWind);
      stepCorpse(c.world, c.body, dt, this.corpseInfo, corpseWind[0], corpseWind[1]);
      c.p.pos.x = c.body.pos.x; c.p.pos.y = c.body.pos.y; c.p.pos.z = c.body.pos.z;
      c.p.vel.x = c.body.vel.x; c.p.vel.y = c.body.vel.y; c.p.vel.z = c.body.vel.z;
      // keep simulating even once it settles: the slab under it may still crumble
      // away, and a body on a moving platform has to go on riding it (or drop off it)
      const b = c.body;
      const atRest = b.grounded && !!b.ground && b.ground.kind === 'static' && Math.hypot(b.vel.x, b.vel.z) < 0.05;
      if ((c.t > CORPSE.LIFE && atRest) || c.t > CORPSE.MAX_LIFE || b.pos.y < c.level.killY - 20) this.corpses.splice(i, 1);
    }
  }

  kill(t: Target, cause: DeathCause, e: Enemy | null, from: Vec3 | null = null) {
    const p = t as RoomPlayer;
    if (p.status !== Status.Alive || p.away) return;
    if (p.god && cause !== 'fall') return;
    if (cause !== 'fall') {
      const mt = this.matchTime;
      if (mt < p.graceUntil) return;
      if (p.shield) {
        // the shield soaks the hit: the runner is shoved clear and the attacker reels
        p.shield = false;
        p.graceUntil = mt + POWER.SHIELD_GRACE;
        if (e) e.stun(mt + POWER.STUN);
        const src = from ?? (e ? e.pos : null);
        let kx = 0, kz = 0;
        if (src) {
          const dx = p.pos.x - src.x, dz = p.pos.z - src.z, d = Math.hypot(dx, dz) || 1;
          kx = (dx / d) * CORPSE.SHIELD_PUSH; kz = (dz / d) * CORPSE.SHIELD_PUSH;
        }
        this.pushEvent({ k: 'shield', id: p.id, by: e ? e.id : -1, v: [round2(kx), round2(CORPSE.SHIELD_LIFT), round2(kz)] });
        return;
      }
    }
    p.status = Status.Dead;
    p.cause = cause;
    p.finishTime = this.matchTime;
    const impulse = this.throwBody(p, cause, e, from);
    this.pushEvent({ k: 'death', id: p.id, cause, by: e ? e.id : -1, p: [round2(p.pos.x), round2(p.pos.y), round2(p.pos.z)], v: impulse });
    if (this.inArena) this.fight?.died(p);
    this.broadcastRoom();
    this.checkEnd();
  }

  fire(e: Enemy, origin: Vec3, vel: Vec3) {
    const pr: Projectile = { id: this.nextProj++, owner: e.id, pos: v3(origin.x, origin.y, origin.z), vel, born: this.matchTime };
    this.projectiles.push(pr);
    this.pushEvent({
      k: 'shot', id: pr.id, e: e.id,
      p: [round3(origin.x), round3(origin.y), round3(origin.z)],
      v: [round3(vel.x), round3(vel.y), round3(vel.z)], t: round3(pr.born),
    });
  }

  emit(ev: GameEvent) { this.pushEvent(ev); }

  private touchCrumble(id: number) {
    const c = this.world.get(id);
    if (!c || c.kind !== 'crumble') return;
    const s = this.crumbles.get(id);
    if (s && s.s !== 'idle') return;
    const t = this.matchTime;
    this.crumbles.set(id, { s: 'shake', t });
    c.shakeStart = t;
    this.pushEvent({ k: 'crumble', id, s: 'shake', t: round3(t) });
  }

  private updateCrumbles(t: number) {
    for (const [id, s] of this.crumbles) {
      const c = this.world.get(id)!;
      if (s.s === 'shake' && t >= s.t + CRUMBLE.SHAKE_TIME) {
        s.s = 'fall';
        c.enabled = false;
        this.pushEvent({ k: 'crumble', id, s: 'fall', t: round3(t) });
      } else if (s.s === 'fall' && t >= s.t + CRUMBLE.SHAKE_TIME + CRUMBLE.RESPAWN_TIME) {
        // do not respawn inside a player
        const blocked = this.players.some((p) => p.status === Status.Alive && Math.abs(p.pos.y - c.top) < 2 && c.circleOverlaps(p.pos.x, p.pos.z, PLAYER.RADIUS));
        if (blocked) continue;
        s.s = 'idle';
        c.enabled = true;
        c.shakeStart = -1;
        this.pushEvent({ k: 'crumble', id, s: 'reset', t: round3(t) });
        this.crumbles.delete(id);
      }
    }
  }

  private updateProjectiles(dt: number) {
    const sub = 3;
    const h = dt / sub;
    const r = RANGED.PROJECTILE_RADIUS + PLAYER.RADIUS + 0.05;
    const hit = { dist: 0, c: null } as { dist: number; c: import('../physics/world').Collider | null };
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      let done = false;
      for (let s = 0; s < sub && !done; s++) {
        const sp = Math.hypot(pr.vel.x, pr.vel.y, pr.vel.z);
        const stepLen = sp * h;
        this.world.raycast(pr.pos.x, pr.pos.y, pr.pos.z, pr.vel.x / sp, pr.vel.y / sp, pr.vel.z / sp, stepLen, false, hit);
        const travel = hit.c ? hit.dist : stepLen;
        pr.pos.x += (pr.vel.x / sp) * travel;
        pr.pos.y += (pr.vel.y / sp) * travel;
        pr.pos.z += (pr.vel.z / sp) * travel;
        for (const p of this.players) {
          if (p.status !== Status.Alive || !p.connected || p.away) continue;
          // sliding runners are a low target: shots aimed at the chest pass over them
          const lo = p.low ? 0.3 : 0.35, hi = p.low ? 0.45 : 1.45, rr = p.low ? RANGED.PROJECTILE_RADIUS + 0.3 : r;
          const cy = Math.min(Math.max(pr.pos.y, p.pos.y + lo), p.pos.y + hi);
          const d = Math.hypot(pr.pos.x - p.pos.x, pr.pos.y - cy, pr.pos.z - p.pos.z);
          if (d < rr) {
            // the shot's own direction throws the body
            this.kill(p, 'shot', this.enemies[pr.owner] ?? null, v3(pr.pos.x - pr.vel.x * 0.1, pr.pos.y, pr.pos.z - pr.vel.z * 0.1));
            this.pushEvent({ k: 'pend', id: pr.id, p: [round2(pr.pos.x), round2(pr.pos.y), round2(pr.pos.z)], hit: true });
            done = true;
            break;
          }
        }
        if (!done && hit.c) {
          this.pushEvent({ k: 'pend', id: pr.id, p: [round2(pr.pos.x), round2(pr.pos.y), round2(pr.pos.z)], hit: false });
          done = true;
        }
      }
      if (!done && this.matchTime - pr.born > RANGED.PROJECTILE_LIFE) done = true;
      if (done) this.projectiles.splice(i, 1);
    }
  }

  tick(dt: number) {
    const now = this.now;
    if (this.phase === 'countdown' && now >= this.goAt) {
      this.phase = 'playing';
      this.broadcastRoom();
    }
    // reconnect grace
    for (const p of this.players) {
      if (!p.connected && p.status !== Status.Left && p.disconnectedAt > 0 && now - p.disconnectedAt > NET.RECONNECT_GRACE) {
        this.remove(p);
        break;
      }
    }
    if (this.phase !== 'playing' && this.phase !== 'countdown') {
      // the match is over, but bodies still in the air keep falling for everyone watching
      if (this.phase === 'ended' && this.corpses.length) {
        this.time = this.matchTime;
        this.activeWorld.update(this.time);
        this.updateCorpses(dt);
        this.snapAcc += dt;
        if (this.snapAcc >= 1 / NET.SNAPSHOT_HZ) { this.snapAcc = 0; this.sendSnapshot(); }
        this.flushEvents();
      }
      return;
    }

    const t = this.matchTime;
    this.time = t;
    for (const p of this.players) p.cloaked = t < p.cloakUntil;
    if (this.phase === 'playing' && this.stage === 'gate' && t >= this.gateAt) this.enterArena();
    if (this.phase === 'playing' && this.stage === 'boss' && this.rift && t >= this.rift.auto) this.openWarp(0);
    if (this.phase === 'playing' && this.stage === 'warp' && t >= this.warpAt) this.enterRace();
    if (this.inRace) {
      this.raceWorld.update(t);
      if (this.phase === 'playing') {
        for (const p of this.players) if (p.connected) this.checkPlayer(p);
        this.checkEnd();
      }
    } else if (this.inArena) {
      this.arenaWorld.update(t);
      if (this.phase === 'playing') {
        this.fight?.tick(dt);
        this.updateCorpses(dt);
        for (const p of this.players) if (p.connected) this.checkPlayer(p);
      }
    } else {
      this.world.update(t);
      this.updateCrumbles(t);
      if (this.phase === 'playing') {
        for (const e of this.enemies) e.update(dt, this);
        this.updateProjectiles(dt);
        this.updateCorpses(dt);
        for (const p of this.players) if (p.connected) this.checkPlayer(p);
      }
    }
    this.snapAcc += dt;
    if (this.snapAcc >= 1 / NET.SNAPSHOT_HZ) {
      this.snapAcc = 0;
      this.sendSnapshot();
    }
    this.flushEvents();
  }

  private sendSnapshot() {
    const f = this.fight;
    const ps: PlayerSnap[] = this.players.map((p) => {
      const q = f?.fighter(p);
      return [p.id, round2(p.pos.x), round2(p.pos.y), round2(p.pos.z), round2(p.yaw), p.anim, p.status, q ? Math.round(q.hp) : PHP.MAX, q ? q.power : 0];
    });
    // past the beacon the course's enemies are nobody's business
    const es: EnemySnap[] = this.inArena ? [] : this.enemies.map((e) => [
      e.id, round2(e.pos.x), round2(e.pos.y), round2(e.pos.z), round2(e.yaw), e.state,
      e.target && (e.state === EState.Chase || e.state === EState.Alert || e.state === EState.Attack) ? e.target.id : 0,
      round2(e.charge),
    ]);
    const snap: Extract<S2C, { t: 'snap' }> = { t: 'snap', ts: round3(this.matchTime), p: ps, e: es };
    if (f && this.inArena) Object.assign(snap, f.snapshot());
    this.broadcast(snap);
  }

  // ------------------------------------------------------------------ messaging

  private pushEvent(ev: GameEvent) { this.events.push(ev); }

  private flushEvents() {
    if (!this.events.length) return;
    this.broadcast({ t: 'ev', e: this.events });
    this.events = [];
  }

  broadcast(msg: S2C) {
    for (const p of this.players) p.conn?.send(msg);
  }

  broadcastRoom() {
    const players: LobbyPlayer[] = this.players.map((p) => ({
      id: p.id, name: p.name, ready: p.ready, host: p.id === this.hostId, connected: p.connected, status: p.status,
    }));
    this.broadcast({ t: 'room', code: this.code, phase: this.phase, hostId: this.hostId, players });
  }

  /** Room can be discarded: nobody connected for a while. */
  isStale(now: number) {
    return this.isEmpty && now - this.lastActivity > 5 && this.players.every((p) => !p.connected && (p.disconnectedAt === 0 || now - p.disconnectedAt > NET.RECONNECT_GRACE));
  }
}

function sanitizeName(name: string, id: number): string {
  const n = String(name ?? '').replace(/[^\p{L}\p{N} _\-.]/gu, '').trim().slice(0, 16);
  return n || `Runner ${id}`;
}


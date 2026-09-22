// Authoritative room: lobby, match flow, player validation, deaths/finish,
// enemies, projectiles, crumbling floors. Transport-agnostic (runs in Node or
// in the browser for offline play).

import { CORPSE, CRUMBLE, DEATH, GRAPPLE, LASER, MAX_PLAYERS, NET, PLAYER, POWER, RANGED, SLIDE } from '../constants';
import { laserHit, onAnyZipline, windAt } from '../hazards';
import { Anim, makeBody, stepCorpse, type CharBody, type StepInfo } from '../physics/character';
import type { LevelData } from '../level/types';
import { round2, round3, v3, type Vec3 } from '../math';
import { CollisionWorld } from '../physics/world';
import {
  EState, Status, type C2S, type DeathCause, type EnemySnap, type ErrCode, type GameEvent,
  type LobbyPlayer, type MatchResult, type Phase, type PlayerSnap, type S2C,
} from '../protocol';
import { Enemy, type EnemyHost, type Target } from './enemy';

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
  constructor(public readonly id: number, public name: string, public readonly token: string, public conn: Conn | null) {}
  get connected() { return this.conn !== null; }
  get targetable() { return this.status === Status.Alive && this.conn !== null && !this.cloaked; }
  /** Sliding: smaller silhouette and hitbox. */
  get low() { return this.anim === Anim.Slide; }
  /** Mid front flip: tucked, so shots are aimed below the chest. */
  get tucked() { return this.anim === Anim.Flip; }
  resetPowers() { this.shield = false; this.cloakUntil = 0; this.boostUntil = 0; this.graceUntil = 0; this.cloaked = false; }
}

interface Projectile { id: number; owner: number; pos: Vec3; vel: Vec3; born: number }
/** A dead runner's body, still falling / sliding / riding platforms. */
interface Corpse { p: RoomPlayer; body: CharBody; t: number }
interface CrumbleState { s: 'idle' | 'shake' | 'fall'; t: number }

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

export class Room implements EnemyHost {
  phase: Phase = 'lobby';
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
  private snapAcc = 0;
  private endedAt = 0;
  lastActivity = 0;

  constructor(
    public readonly code: string,
    public readonly level: LevelData,
    private readonly clock: () => number,
    public readonly debug: boolean,
  ) {
    this.world = new CollisionWorld(level);
    this.lastActivity = clock();
  }

  get now() { return this.clock(); }
  get matchTime() { return this.now - this.goAt; }
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
        this.startMatch();
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
          this.startMatch();
        } else if (msg.cmd === 'god') {
          p.god = !p.god;
        }
        return;
      default:
        return;
    }
  }

  private onState(p: RoomPlayer, m: Extract<C2S, { t: 'st' }>) {
    if (p.status !== Status.Alive) return;
    if (this.phase !== 'playing' && this.phase !== 'countdown') return;
    const [x, y, z] = m.p;
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return;
    const now = this.now;
    const dt = Math.max(0.05, now - p.lastMsgT);
    p.lastMsgT = now;
    const moved = Math.hypot(x - p.pos.x, z - p.pos.z);
    const rise = y - p.pos.y;
    const frozen = this.phase === 'countdown';
    if (moved > NET.MAX_CLIENT_SPEED * dt + 2.5 || rise > 20 * dt + 3 || (frozen && moved > 1.5)) {
      p.conn?.send({ t: 'fix', p: [p.pos.x, p.pos.y, p.pos.z] });
      return;
    }
    p.pos.x = x; p.pos.y = y; p.pos.z = z;
    p.vel.x = m.v[0]; p.vel.y = m.v[1]; p.vel.z = m.v[2];
    p.yaw = m.y; p.anim = m.a | 0; p.ground = m.g | 0;
    if (p.ground >= 0) this.touchCrumble(p.ground);
    this.checkPlayer(p);
    // lasers: judged at the client's own clock (clamped), so latency never kills unfairly
    if (p.status === Status.Alive && this.phase === 'playing' && this.level.lasers.length) {
      const mt = this.matchTime;
      const tc = typeof m.tm === 'number' && isFinite(m.tm) ? Math.min(mt + 0.05, Math.max(mt - 0.35, m.tm)) : mt;
      const h = (p.low ? SLIDE.HEIGHT : PLAYER.HEIGHT) - 0.1;
      if (laserHit(this.level, x, y, z, tc, PLAYER.RADIUS - LASER.SERVER_SHRINK, h)) this.kill(p, 'laser', null);
    }
  }

  // ------------------------------------------------------------------ match flow

  private startMatch() {
    this.phase = 'countdown';
    this.goAt = this.now + NET.COUNTDOWN;
    this.projectiles = [];
    this.crumbles.clear();
    this.corpses = [];
    this.taken.clear();
    for (const c of this.world.crumbles) { c.enabled = true; c.shakeStart = -1; }
    this.enemies = this.level.enemies.map((d) => new Enemy(d));
    const spawns = this.level.spawns;
    this.players.forEach((p, i) => {
      if (p.status === Status.Left && !p.connected) return;
      const s = spawns[i % spawns.length];
      p.pos.x = s[0]; p.pos.y = s[1]; p.pos.z = s[2];
      p.vel.x = p.vel.y = p.vel.z = 0;
      p.status = Status.Alive;
      p.lastSupportY = s[1];
      p.finishTime = 0; p.place = 0; p.cause = undefined;
      p.lastMsgT = this.now;
      p.anim = 0; p.yaw = this.level.spawnYaw;
      p.resetPowers();
    });
    // drop records of players that left in a previous match
    for (let i = this.players.length - 1; i >= 0; i--) if (this.players[i].status === Status.Left) this.players.splice(i, 1);
    this.targets = this.players;
    this.world.update(this.matchTime);
    this.world.syncPrevious();
    this.events = [];
    for (const p of this.players) this.sendStart(p, false);
    this.broadcastRoom();
  }

  private sendStart(p: RoomPlayer, resume: boolean) {
    const spawns: Record<number, [number, number, number]> = {};
    for (const q of this.players) spawns[q.id] = [round3(q.pos.x), round3(q.pos.y), round3(q.pos.z)];
    const crumbles: [number, string, number][] = [];
    for (const [id, s] of this.crumbles) if (s.s !== 'idle') crumbles.push([id, s.s, s.t]);
    const powers: [number, number, number, number][] = this.players.map((q) => [q.id, q.shield ? 1 : 0, round2(q.cloakUntil), round2(q.boostUntil)]);
    p.conn?.send({ t: 'start', goAt: round3(this.goAt), now: round3(this.now), spawns, resume, crumbles, taken: [...this.taken], powers });
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
    this.broadcastRoom();
  }

  private checkEnd() {
    if (this.phase !== 'playing' && this.phase !== 'countdown') return;
    if (this.players.some((p) => p.status === Status.Alive)) return;
    this.phase = 'ended';
    this.endedAt = this.now;
    this.flushEvents();
    this.broadcast({ t: 'end', results: this.results(), duration: round2(this.endedAt - this.goAt) });
    this.broadcastRoom();
  }

  private results(): MatchResult[] {
    return this.players.map((p) => ({
      id: p.id, name: p.name, status: p.status,
      time: round2(p.status === Status.Finished ? p.finishTime : Math.max(0, (p.finishTime || this.endedAt - this.goAt))),
      cause: p.cause, place: p.place || undefined,
    }));
  }

  // ------------------------------------------------------------------ gameplay

  private checkPlayer(p: RoomPlayer) {
    if (p.status !== Status.Alive || this.phase !== 'playing') return;
    const { x, y, z } = p.pos;
    const f = this.level.finish;
    if (x >= f.min[0] && x <= f.max[0] && y >= f.min[1] && y <= f.max[1] && z >= f.min[2] && z <= f.max[2]) {
      p.status = Status.Finished;
      p.finishTime = this.matchTime;
      p.place = this.players.filter((q) => q.status === Status.Finished).length;
      this.pushEvent({ k: 'finish', id: p.id, time: round2(p.finishTime), place: p.place });
      this.broadcastRoom();
      this.checkEnd();
      return;
    }
    if (y < this.level.killY) { this.kill(p, 'fall', null); return; }
    this.checkPickups(p);
    // hanging on a zip line or swinging on a grapple rope over the void is not falling
    if (this.level.ziplines.length && onAnyZipline(this.level, x, y, z)) { p.lastSupportY = y; return; }
    if (p.anim === Anim.Swing && this.nearAnchor(x, y, z)) { p.lastSupportY = y; return; }
    const below = this.world.groundBelow(x, y + 0.3, z, 600);
    if (below < 2.6) p.lastSupportY = y + 0.3 - below;
    else if (!isFinite(below) && y < p.lastSupportY - DEATH.FALL_DROP) this.kill(p, 'fall', null);
  }

  private nearAnchor(x: number, y: number, z: number): boolean {
    for (const g of this.level.grapples) {
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
    this.corpses.push({ p, body, t: 0 });
    return [round2(v.x), round2(v.y), round2(v.z)];
  }

  private updateCorpses(dt: number) {
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      c.t += dt;
      windAt(this.level, c.body.pos.x, c.body.pos.y, c.body.pos.z, this.matchTime, corpseWind);
      stepCorpse(this.world, c.body, dt, this.corpseInfo, corpseWind[0], corpseWind[1]);
      c.p.pos.x = c.body.pos.x; c.p.pos.y = c.body.pos.y; c.p.pos.z = c.body.pos.z;
      c.p.vel.x = c.body.vel.x; c.p.vel.y = c.body.vel.y; c.p.vel.z = c.body.vel.z;
      // keep simulating even once it settles: the slab under it may still crumble away
      if (c.t > CORPSE.LIFE || c.body.pos.y < this.level.killY - 20) this.corpses.splice(i, 1);
    }
  }

  kill(t: Target, cause: DeathCause, e: Enemy | null, from: Vec3 | null = null) {
    const p = t as RoomPlayer;
    if (p.status !== Status.Alive) return;
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
          if (p.status !== Status.Alive || !p.connected) continue;
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
        this.world.update(this.time);
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
    this.world.update(t);
    this.updateCrumbles(t);
    if (this.phase === 'playing') {
      for (const e of this.enemies) e.update(dt, this);
      this.updateProjectiles(dt);
      this.updateCorpses(dt);
      for (const p of this.players) if (p.connected) this.checkPlayer(p);
    }
    this.snapAcc += dt;
    if (this.snapAcc >= 1 / NET.SNAPSHOT_HZ) {
      this.snapAcc = 0;
      this.sendSnapshot();
    }
    this.flushEvents();
  }

  private sendSnapshot() {
    const ps: PlayerSnap[] = this.players.map((p) => [
      p.id, round2(p.pos.x), round2(p.pos.y), round2(p.pos.z), round2(p.yaw), p.anim, p.status,
    ]);
    const es: EnemySnap[] = this.enemies.map((e) => [
      e.id, round2(e.pos.x), round2(e.pos.y), round2(e.pos.z), round2(e.yaw), e.state,
      e.target && (e.state === EState.Chase || e.state === EState.Alert || e.state === EState.Attack) ? e.target.id : 0,
      round2(e.charge),
    ]);
    this.broadcast({ t: 'snap', ts: round3(this.matchTime), p: ps, e: es });
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


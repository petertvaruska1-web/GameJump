// The fight in the Warden's arena, on the authoritative side: the runners' health
// and powers, the Warden, its bots, the loose things, orbs and wells, and every
// rule about who hurts whom. The room hands it the runners when the beacon pulls
// them through and asks it for its part of each snapshot. Solo offline runs the
// very same code inside the page.
//
// Powers are played on the runner's own screen the moment the button goes down
// (and a movement power moves the runner there and then); the client then says
// what it did ('pow'), and this decides what that hit. Aimed hits are judged
// against where the target was on that client's screen (clamped to the last
// 0.35 s), so a fast-moving Warden cannot dodge a bolt that visibly struck it.
//
// Going down in the arena is final: a runner who runs out of health (or falls)
// stays down and watches, and when the whole team is down the fight is lost.
//
// Two powers keep working after the button: sonic force sends out waves whose
// front strikes things as it reaches them, and a speedster's trail of light burns
// whatever touches it for as long as it lasts.

import { ARENA, BOSS, BOT, JUNK, NET, PHP, PLAYER, POW, powerHp, SLIDE, SUPERS, type SuperPower } from '../constants';
import type { ArenaData } from '../level/arena';
import { clamp, v3, type Vec3 } from '../math';
import { Anim } from '../physics/character';
import type { Collider, CollisionWorld, RayHit } from '../physics/world';
import {
  BotKind, BotState, BState, JunkKind, PowAct, Status,
  type BossSnap, type BotSnap, type C2S, type DeathCause, type GameEvent, type HurtSrc, type JunkSnap,
} from '../protocol';
import { Bot, holdPoint, Junk, Orb, SHELL_G, Well } from './bots';
import type { RoomPlayer } from './room';
import { botCap, HIVE, MUZZLE, Warden, wardenPoint, type PartSphere } from './warden';

export interface FightHost {
  /** Match clock. */
  readonly matchTime: number;
  emit(ev: GameEvent): void;
  /** A runner's health ran out (or it fell): the room kills it the usual way. */
  killRunner(p: RoomPlayer, cause: DeathCause, from: Vec3 | null): void;
  /** The Warden is destroyed and the dust has settled: the run is won. */
  won(): void;
  rand(): number;
}

/** A runner in the arena: its health, its power and that power's cool-downs. */
export class Fighter {
  hp: number = PHP.MAX;
  /** Index into SUPERS plus one (0: not chosen yet). */
  power = 0;
  hurtAt = -99;
  protectUntil = 0;
  /** Mid-blink: nothing touches you. */
  phaseUntil = 0;
  deaths = 0;
  damage = 0;
  bots = 0;
  /** Seconds standing on the Warden's back. */
  rideT = 0;
  // the power's bookkeeping
  ready = 0;
  /** The angel: the next dive and the next soar; sonic force: the next boom. */
  diveReady = 0;
  soarReady = 0;
  boomReady = 0;
  pushReady = 0;
  boltReady = 0;
  flashReady = 0;
  chain = 0;
  heat = 0;
  heatAt = 0;
  overheatUntil = 0;
  bolts = 0;
  held: { kind: 1 | 2; id: number; at: number } | null = null;
  /** A speedster's trail (oldest first), what it has burned but not yet dealt, and when it last burned. */
  readonly trail: TrailPoint[] = [];
  readonly burn = new Map<string, number>();
  burnAt = 0;
  private crushAcc = 0;
  /** A power just moved this runner further than running could: accepted up to `allow` metres until `allowUntil`. */
  allow = 0;
  allowUntil = 0;
  constructor(readonly p: RoomPlayer) {}
  get id() { return this.p.id; }
  get pos() { return this.p.pos; }
  get vel() { return this.p.vel; }
  /** Sliding (the beam's height test). */
  get low() { return this.p.anim === Anim.Slide; }
  get kind(): SuperPower | null { return this.power ? SUPERS[this.power - 1] : null; }
  /** Crush damage owed to a bot held with telekinesis, in whole points. */
  crush(dt: number): number { this.crushAcc += POW.telekinesis.CRUSH * dt; const n = Math.floor(this.crushAcc); this.crushAcc -= n; return n; }
}

/** Where a speedster ran: feet at (x, y, z) at time t; `cut` when the trail broke off before it. */
interface TrailPoint { x: number; y: number; z: number; t: number; cut: boolean }

/** A sonic wave on its way out: a blast's cone (or a boom's ring) whose front strikes things as it reaches them. */
interface Wave {
  by: Fighter;
  /** Where it left the hands, and which way (a boom goes every way). */
  o: Vec3;
  d: Vec3;
  t0: number;
  /** The shooter's view of the Warden when it was fired (see pow). */
  tr: number;
  boom: boolean;
  /** Things it has already struck ('w' the Warden, 'b' + id a bot, 'j' + id, 'o' + id). */
  struck: Set<string>;
}

const PART_TMP: PartSphere[] = [];
const ray: RayHit = { dist: 0, c: null };
const a = v3(), b = v3(), c = v3(), e = v3();

/** Distance from point p to segment [s0, s1]. */
function segDist(px: number, py: number, pz: number, s0: Vec3, s1: Vec3): number {
  const dx = s1.x - s0.x, dy = s1.y - s0.y, dz = s1.z - s0.z;
  const l2 = dx * dx + dy * dy + dz * dz;
  const u = l2 > 1e-9 ? clamp(((px - s0.x) * dx + (py - s0.y) * dy + (pz - s0.z) * dz) / l2, 0, 1) : 0;
  return Math.hypot(px - (s0.x + dx * u), py - (s0.y + dy * u), pz - (s0.z + dz * u));
}

/** Distance between a segment and a runner's upright capsule (feet at p, `h` tall). */
function segCapsule(s0: Vec3, s1: Vec3, p: Vec3, h: number): number {
  let best = Infinity;
  for (let k = 0; k <= 4; k++) best = Math.min(best, segDist(p.x, p.y + 0.3 + (h - 0.5) * (k / 4), p.z, s0, s1));
  return best;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const p3 = (v: Vec3): [number, number, number] => [r2(v.x), r2(v.y), r2(v.z)];

export class Fight {
  readonly warden: Warden;
  readonly fighters: Fighter[] = [];
  bots: Bot[] = [];
  junk: Junk[] = [];
  orbs: Orb[] = [];
  wells: Well[] = [];
  waves: Wave[] = [];
  time = 0;
  readonly arrivedAt: number;
  readonly wakeBy: number;
  private nextBot = 1;
  private nextJunk = 1;
  private nextOrb = 1;
  private nextWell = 1;
  /** Canisters waiting to come back to their stands (stand -> time). */
  private readonly restock = new Map<number, number>();
  /** Explosions waiting a beat (chain reactions ripple instead of going off all at once). */
  private readonly booms: { j: Junk; at: number; by: Fighter | null }[] = [];
  /** Things the current stomp's ring has already thrown (each once). */
  private readonly ringHit = new Set<string>();
  private ringAct = -1;
  /** Bots the beam has burned lately (bot id -> time). */
  private readonly scorched = new Map<number, number>();
  private wonAt = 0;
  readonly killY: number;

  constructor(private readonly host: FightHost, readonly arena: ArenaData, readonly world: CollisionWorld, players: RoomPlayer[], t: number) {
    this.time = t;
    this.arrivedAt = t;
    this.wakeBy = t + ARENA.WAKE_AFTER;
    this.killY = arena.level.killY;
    for (const p of players) this.fighters.push(new Fighter(p));
    this.warden = new Warden(players.length);
    this.arena.canisters.forEach((_, i) => this.stock(i));
    // the hull and head follow the Warden
    world.puppeteer = (col: Collider) => this.placePuppet(col);
    world.update(t);
    world.syncPrevious();
  }

  private placePuppet(col: Collider) {
    const w = this.warden;
    if (col.id === this.arena.hull) wardenPoint(w.x, ARENA.y, w.z, w.yaw, 0, w.lift, 0, a);
    else wardenPoint(w.x, ARENA.y, w.z, w.yaw, 0, w.lift + 0.5, 5.6, a);
    col.setTransform(a.x, a.y, a.z, w.yaw);
  }

  rand() { return this.host.rand(); }
  emit(ev: GameEvent) { this.host.emit(ev); }
  fighter(p: RoomPlayer) { return this.fighters.find((q) => q.p === p) ?? null; }
  get awake() { return this.warden.awake; }
  get botSpeedK() { return this.warden.overdrive ? 1.1 : 1; }
  get tellK() { return this.warden.overdrive ? 0.85 : 1; }
  botCap() { return botCap(this.fighters.filter((q) => q.p.connected && q.p.status !== Status.Left).length, this.warden.overdrive); }

  /** Can the Warden and its bots go after this runner right now? */
  targetable(q: Fighter) {
    const p = q.p;
    return p.status === Status.Alive && p.connected && this.time >= q.protectUntil && this.time >= q.phaseUntil;
  }

  /** Standing on the Warden's back (or its head). */
  onWarden(q: Fighter) { return q.p.ground === this.arena.hull || q.p.ground === this.arena.head; }

  /** The runners the Warden and its bots can hit right now. */
  victims(): Fighter[] { return this.fighters.filter((q) => this.targetable(q)); }

  // ------------------------------------------------------------------ the runners

  /** Runner `p` chose a power. Free to change it until the Warden wakes. */
  pick(p: RoomPlayer, k: number) {
    const q = this.fighter(p);
    if (!q || k < 0 || k >= SUPERS.length || p.status !== Status.Alive) return;
    if (this.awake && q.power) return;
    this.dropHeld(q);
    q.power = k + 1;
    q.heat = 0; q.overheatUntil = 0; q.chain = 0; q.ready = 0; q.diveReady = 0; q.soarReady = 0; q.boomReady = 0;
    q.trail.length = 0;
    // the angel is a little tougher: the health comes with the power
    q.hp = powerHp(q.kind);
    this.emit({ k: 'pick', id: p.id, power: k });
  }

  /** Hurt a runner (`n` = 0 only shoves). */
  hurt(q: Fighter, n: number, src: HurtSrc, from: Vec3, knock: Vec3) {
    const p = q.p;
    if (p.status !== Status.Alive || this.time < q.protectUntil || this.time < q.phaseUntil) return;
    if (p.god && n > 0) n = 0;
    if (n > 0) { q.hp = Math.max(0, q.hp - n); q.hurtAt = this.time; }
    this.emit({ k: 'hurt', id: p.id, n: Math.round(n), hp: Math.round(q.hp), src, v: [r2(knock.x), r2(knock.y), r2(knock.z)], from: p3(from) });
    if (q.hp <= 0) {
      p.vel.x += knock.x; p.vel.y = Math.max(p.vel.y, knock.y); p.vel.z += knock.z;
      this.host.killRunner(p, src === 'bite' || src === 'sting' ? 'bot' : 'warden', v3(from.x, from.y, from.z));
    }
  }

  /** The room says this runner died (hurt, or fell off). It stays down: in the arena that is final. */
  died(p: RoomPlayer) {
    const q = this.fighter(p);
    if (!q) return;
    q.deaths++;
    q.hp = 0;
    q.rideT = 0;
    this.dropHeld(q);
  }

  /** Everyone pushed away from `at` (no damage): runners, bots and loose things. */
  shove(at: Vec3, radius: number, knock: number, lift: number) {
    for (const q of this.victims()) {
      const dx = q.pos.x - at.x, dz = q.pos.z - at.z, d = Math.hypot(dx, dz);
      if (d > radius) continue;
      const k = 1 - (d / radius) * 0.5, n = d > 0.01 ? 1 / d : 0;
      this.hurt(q, 0, 'blast', at, { x: dx * n * knock * k, y: lift * k, z: dz * n * knock * k });
    }
    for (const bot of this.bots) {
      const dx = bot.pos.x - at.x, dz = bot.pos.z - at.z, d = Math.hypot(dx, dz);
      if (d > radius || d < 0.01) continue;
      bot.knock(this, (dx / d) * knock, lift, (dz / d) * knock, 0.6);
    }
    for (const j of this.junk) {
      if (j.heldBy) continue;
      const dx = j.pos.x - at.x, dz = j.pos.z - at.z, d = Math.hypot(dx, dz);
      if (d > radius || d < 0.01) continue;
      j.vel.x += (dx / d) * knock * 0.7; j.vel.y += lift * 0.7; j.vel.z += (dz / d) * knock * 0.7;
      j.body.grounded = false;
    }
  }

  // ------------------------------------------------------------------ update

  tick(dt: number) {
    const t = this.host.matchTime;
    this.time = t;
    const w = this.warden;
    // the Warden wakes once everyone has chosen (after a moment to take in the arena), or when it has waited long enough
    if (!w.awake) {
      const waiting = this.fighters.filter((q) => q.p.connected && q.p.status !== Status.Left);
      const all = waiting.length > 0 && waiting.every((q) => q.power > 0);
      if ((all && t >= this.arrivedAt + 2.5) || t >= this.wakeBy) {
        for (const q of waiting) if (!q.power) this.pick(q.p, Math.floor(this.rand() * SUPERS.length));
        w.wake(this);
      }
    }
    for (const q of this.fighters) this.tickFighter(q, dt);
    w.update(dt, this);
    this.waves = this.waves.filter((wv) => this.waveStep(wv));
    if (w.actAt !== this.ringAct) { this.ringAct = w.actAt; this.ringHit.clear(); }
    for (const bot of this.bots) bot.update(dt, this);
    for (const j of this.junk) j.update(dt, this);
    for (const o of this.orbs) o.update(dt, this);
    for (const wl of this.wells) wl.update(dt, this);
    for (let i = this.booms.length - 1; i >= 0; i--) {
      const bm = this.booms[i];
      if (t >= bm.at) { this.booms.splice(i, 1); if (!bm.j.dead) this.explode(bm.j, bm.by); }
    }
    this.bots = this.bots.filter((x) => !x.dead);
    for (const j of this.junk) if (j.dead && j.heldBy) { j.heldBy.held = null; j.heldBy = null; }
    this.junk = this.junk.filter((x) => !x.dead);
    this.orbs = this.orbs.filter((x) => !x.dead);
    this.wells = this.wells.filter((x) => !x.dead);
    for (const [stand, at] of this.restock) if (t >= at) { this.restock.delete(stand); this.stock(stand); }
    // the machine is down: once its last explosions are over, the run is won
    const dying = w.dyingFor(t);
    if (dying >= 0 && !this.wonAt && dying > BOSS.DYING + BOSS.VICTORY) { this.wonAt = t; this.host.won(); }
  }

  private tickFighter(q: Fighter, dt: number) {
    const t = this.time, p = q.p;
    if (q.kind === 'speed') this.trailStep(q);
    if (p.status !== Status.Alive) { q.rideT = 0; return; }
    const max = powerHp(q.kind);
    if (q.hp < max && t - q.hurtAt > PHP.REGEN_DELAY) q.hp = Math.min(max, q.hp + PHP.REGEN * dt);
    q.rideT = this.onWarden(q) ? q.rideT + dt : 0;
    // a held thing is crushed (a bot), and let go of after a while
    if (q.held) {
      if (q.held.kind === 1) {
        const bot = this.bots.find((x) => x.id === q.held!.id);
        if (bot) { const n = q.crush(dt); if (n > 0) this.hitBot(bot, n, q, 0, 0, 0, 0); }
      }
      if (q.held && t - q.held.at > POW.telekinesis.HOLD) this.dropHeld(q);
    }
  }

  // ------------------------------------------------------------------ the Warden

  /** Damage to the Warden by runner `by` (null: the world). */
  hitWarden(by: Fighter | null, n: number, part: number, at: Vec3, poise: number) {
    const w = this.warden;
    if (!w.alive) return;
    const hp0 = w.hp;
    const dealt = w.damage(this, by, n, part, poise);
    if (!dealt) return;
    if (by) by.damage += hp0 - w.hp;
    this.emit({ k: 'hit', by: by ? by.id : 0, n: dealt, part, p: p3(at), hp: Math.round(w.hp), c: dealt > n * 1.4 || undefined });
  }

  /** The nearest part of the Warden to a point, and how far from its surface. */
  nearestPart(at: Vec3, t = Infinity): { part: PartSphere; d: number } | null {
    if (!this.warden.alive) return null;
    const parts = this.warden.partsAt(this, t);
    let best: PartSphere | null = null, bd = Infinity;
    for (const s of parts) {
      const d = Math.hypot(at.x - s.x, at.y - s.y, at.z - s.z) - s.r;
      if (d < bd) { bd = d; best = s; }
    }
    return best ? { part: best, d: bd } : null;
  }

  shedPlate(w: Warden) {
    const side = this.rand() < 0.5 ? -1 : 1;
    w.point(side * 3.4, 1.2, (this.rand() - 0.5) * 6, a);
    const j = this.addJunk(JunkKind.Plate, a.x, a.y, a.z);
    const c = Math.cos(w.yaw), s = Math.sin(w.yaw);
    j.vel.x = side * c * (6 + this.rand() * 4) + (this.rand() - 0.5) * 3;
    j.vel.z = -side * s * (6 + this.rand() * 4) + (this.rand() - 0.5) * 3;
    j.vel.y = 7 + this.rand() * 4;
  }

  wardenDown() {
    for (const bot of this.bots) this.killBot(bot, null);
    for (const q of this.fighters) this.dropHeld(q);
  }

  /** The stomp's ring throws bots and loose things on the floor up and out as it passes. */
  ringPush(x: number, z: number, r: number, band: number) {
    const floor = ARENA.y;
    for (const bot of this.bots) {
      if (bot.kind !== BotKind.Skitter || bot.pos.y - floor > 1 || this.ringHit.has('b' + bot.id)) continue;
      const d = Math.hypot(bot.pos.x - x, bot.pos.z - z);
      if (Math.abs(d - r) > band / 2 + bot.radius || d < 0.01) continue;
      this.ringHit.add('b' + bot.id);
      bot.knock(this, ((bot.pos.x - x) / d) * 6, 7, ((bot.pos.z - z) / d) * 6, 0.7);
    }
    for (const j of this.junk) {
      if (j.heldBy || j.pos.y - floor > 1 || this.ringHit.has('j' + j.id)) continue;
      const d = Math.hypot(j.pos.x - x, j.pos.z - z);
      if (Math.abs(d - r) > band / 2 + 0.6 || d < 0.01) continue;
      this.ringHit.add('j' + j.id);
      j.vel.x += ((j.pos.x - x) / d) * 5; j.vel.y += 7; j.vel.z += ((j.pos.z - z) / d) * 5;
      j.body.grounded = false;
    }
  }

  /** One step of the beam: runners in it burn (then get a moment's grace), and so does anything else it touches. */
  beam(w: Warden, eye: Vec3, dir: Vec3, burned: Map<number, number>) {
    const B = BOSS.BEAM, t = this.time;
    a.x = eye.x + dir.x * 1.5; a.y = eye.y + dir.y * 1.5; a.z = eye.z + dir.z * 1.5;
    this.world.raycast(a.x, a.y, a.z, dir.x, dir.y, dir.z, 90, false, ray);
    const len = ray.c ? ray.dist : 90;
    b.x = a.x + dir.x * len; b.y = a.y + dir.y * len; b.z = a.z + dir.z * len;
    for (const q of this.victims()) {
      if (t - (burned.get(q.id) ?? -99) < B.GRACE) continue;
      const h = q.low ? SLIDE.HEIGHT : PLAYER.HEIGHT;
      if (segCapsule(a, b, q.pos, h) > PLAYER.RADIUS + 0.22) continue;
      burned.set(q.id, t);
      this.hurt(q, B.DAMAGE, 'beam', eye, { x: dir.x * B.KNOCK, y: 2, z: dir.z * B.KNOCK });
    }
    for (const bot of this.bots) {
      if (bot.state === BotState.Flying || t - (this.scorched.get(bot.id) ?? -99) < 0.3) continue;
      bot.centre(c);
      if (segDist(c.x, c.y, c.z, a, b) > bot.radius + 0.3) continue;
      this.scorched.set(bot.id, t);
      this.hitBot(bot, 12, null, dir.x * 3, 2, dir.z * 3, 0.3);
    }
    for (const j of this.junk) {
      if (j.kind !== JunkKind.Canister || j.heldBy || j.dead) continue;
      j.centre(c);
      if (segDist(c.x, c.y, c.z, a, b) < 0.9) this.explode(j, null);
    }
    void w;
  }

  /** A mortar shell from one of the cannons, aimed where a runner is going to be. */
  fireShell(w: Warden, i: number) {
    const M = BOSS.MORTAR;
    const targets = this.fighters.filter((q) => this.targetable(q));
    if (!targets.length) return;
    const T = targets[i % targets.length];
    const flight = M.FLIGHT[0] + this.rand() * (M.FLIGHT[1] - M.FLIGHT[0]);
    let x = T.p.pos.x + T.p.vel.x * flight * 0.55, z = T.p.pos.z + T.p.vel.z * flight * 0.55;
    // every third shell goes where they are headed; the rest land around it
    if (i % 3 !== 0) {
      const ang = this.rand() * Math.PI * 2, r = M.SCATTER * Math.sqrt(this.rand());
      x += Math.sin(ang) * r; z += Math.cos(ang) * r;
    }
    const gy = this.world.groundBelow(x, T.p.pos.y + 20, z, 80);
    const y = isFinite(gy) ? T.p.pos.y + 20 - gy : T.p.pos.y;
    w.point(MUZZLE[0] * (i % 2 ? 1 : -1), MUZZLE[1], MUZZLE[2], a);
    const j = this.addJunk(JunkKind.Shell, a.x, a.y, a.z);
    j.hostile = true;
    j.vel.x = (x - a.x) / flight; j.vel.z = (z - a.z) / flight;
    j.vel.y = (y - a.y) / flight + 0.5 * SHELL_G * flight;
    this.emit({ k: 'shell', id: j.id, p: p3(a), v: p3(j.vel), q: [r2(x), r2(y), r2(z)], t: r2(this.time) });
  }

  /** A bot out of the hive, arcing down near one of the runners (never right on top of them). */
  launchBot(w: Warden, i: number) {
    const targets = this.fighters.filter((q) => this.targetable(q));
    if (!targets.length || this.bots.length >= this.botCap()) return;
    const T = targets[i % targets.length];
    const floor = ARENA.y;
    const high = T.p.pos.y - floor > 3;
    const kind = (i % 2 === 1) !== high ? BotKind.Wasp : BotKind.Skitter;
    w.point(HIVE[0], HIVE[1], HIVE[2], a);
    let tx = 0, ty = 0, tz = 0, found = false;
    for (let k = 0; k < 12 && !found; k++) {
      const ang = this.rand() * Math.PI * 2, d = 6 + this.rand() * 5;
      tx = T.p.pos.x + Math.sin(ang) * d; tz = T.p.pos.z + Math.cos(ang) * d;
      if (kind === BotKind.Wasp) {
        ty = Math.max(T.p.pos.y, floor) + 6;
        found = Math.hypot(tx - ARENA.x, tz - ARENA.z) < 46;
        continue;
      }
      const gy = this.world.groundBelow(tx, floor + 7, tz, 12);
      if (!isFinite(gy)) continue;
      ty = floor + 7 - gy;
      const level = Math.abs(ty - floor) < 0.4 || Math.abs(ty - floor - 5) < 0.4;
      found = level && !this.fighters.some((q) => Math.hypot(q.p.pos.x - tx, q.p.pos.z - tz) < 3.5);
    }
    if (!found) {
      const ang = this.rand() * Math.PI * 2, d = 9 + this.rand() * 11;
      tx = ARENA.x + Math.sin(ang) * d; tz = ARENA.z + Math.cos(ang) * d; ty = kind === BotKind.Wasp ? floor + 7 : floor;
    }
    const flight = kind === BotKind.Wasp ? 0.9 : 1.15;
    const bot = new Bot(this.nextBot++, kind, a, v3(tx, ty, tz), flight, this.time, () => this.rand());
    this.bots.push(bot);
    this.emit({ k: 'bot', id: bot.id, kind, p: p3(a), q: [r2(tx), r2(ty), r2(tz)], at: r2(this.time) });
  }

  botLanded(bot: Bot) { void bot; }

  /** A charging Warden runs its own bots down and kicks loose things aside. */
  trample(x: number, z: number, fx: number, fz: number, width: number) {
    for (const bot of this.bots) {
      if (bot.state === BotState.Flying || bot.state === BotState.Held) continue;
      const rx = bot.pos.x - x, rz = bot.pos.z - z, along = rx * fx + rz * fz, lat = -rx * fz + rz * fx;
      if (along > -1 && along < 6 && Math.abs(lat) < width / 2 + 0.6 && bot.pos.y - ARENA.y < 4) this.killBot(bot, null);
    }
    for (const j of this.junk) {
      if (j.heldBy) continue;
      const rx = j.pos.x - x, rz = j.pos.z - z, along = rx * fx + rz * fz, lat = -rx * fz + rz * fx;
      if (along > -1 && along < 6 && Math.abs(lat) < width / 2 + 0.6 && j.pos.y - ARENA.y < 3) {
        const s = lat >= 0 ? 1 : -1;
        j.vel.x = fx * 12 - fz * s * 7; j.vel.y = 6; j.vel.z = fz * 12 + fx * s * 7;
        j.body.grounded = false;
      }
    }
  }

  // ------------------------------------------------------------------ bots

  hitBot(bot: Bot, n: number, by: Fighter | null, kx: number, ky: number, kz: number, stun: number) {
    if (bot.dead || n <= 0 && !kx && !ky && !kz) return;
    if (n > 0) {
      bot.hp -= n;
      if (by) bot.lastHitBy = by;
      this.emit({ k: 'bhit', id: bot.id, n: Math.round(n), by: by ? by.id : 0 });
    }
    if (kx || ky || kz || stun) bot.knock(this, kx, ky, kz, Math.max(stun, BOT.STUN));
    if (bot.hp <= 0) this.killBot(bot, by ?? bot.lastHitBy);
  }

  killBot(bot: Bot, by: Fighter | null) {
    if (bot.dead) return;
    bot.dead = true;
    if (bot.heldBy) { bot.heldBy.held = null; bot.heldBy = null; }
    if (by) by.bots++;
    this.emit({ k: 'bdie', id: bot.id, p: p3(bot.centre(a)), by: by ? by.id : 0 });
  }

  botSees(bot: Bot, q: Fighter) {
    bot.centre(a);
    c.x = q.pos.x; c.y = q.pos.y + 1.2; c.z = q.pos.z;
    return this.world.lineOfSight(a, c);
  }

  fireOrb(bot: Bot, T: Fighter) {
    const S = BOT.wasp;
    bot.centre(a);
    const d0 = Math.hypot(T.pos.x - a.x, T.pos.y + 1.1 - a.y, T.pos.z - a.z);
    const fl = d0 / S.SHOT_SPEED;
    const tx = T.pos.x + T.vel.x * fl * 0.45, ty = T.pos.y + 1.1, tz = T.pos.z + T.vel.z * fl * 0.45;
    const dx = tx - a.x, dy = ty - a.y, dz = tz - a.z, d = Math.hypot(dx, dy, dz) || 1;
    const o = new Orb(this.nextOrb++, bot.id, a.x, a.y, a.z, (dx / d) * S.SHOT_SPEED, (dy / d) * S.SHOT_SPEED, (dz / d) * S.SHOT_SPEED, this.time);
    this.orbs.push(o);
    this.emit({ k: 'orb', id: o.id, p: p3(o.pos), v: p3(o.vel), t: r2(this.time) });
  }

  endOrb(o: Orb) {
    if (o.dead) return;
    o.dead = true;
    this.emit({ k: 'oend', id: o.id, p: p3(o.pos) });
  }

  orbHitsWarden(o: Orb): boolean {
    const hit = this.nearestPart(o.pos);
    if (!hit || hit.d > 0.3) return false;
    this.hitWarden(o.turnedBy, BOT.wasp.DAMAGE * 2.5, hit.part.part, o.pos, 6);
    return true;
  }

  /** The first bot whose body is within `r` of a point. */
  botAt(at: Vec3, r: number, except: Bot | null): Bot | null {
    for (const bot of this.bots) {
      if (bot === except || bot.dead || bot.state === BotState.Held || bot.state === BotState.Flying) continue;
      bot.centre(c);
      if (Math.hypot(at.x - c.x, at.y - c.y, at.z - c.z) < r + bot.radius) return bot;
    }
    return null;
  }

  /** The runner whose body is within `r` of a point. */
  victimAt(at: Vec3, r: number): Fighter | null {
    for (const q of this.victims()) {
      const p = q.pos, h = q.low ? SLIDE.HEIGHT : PLAYER.HEIGHT;
      const cy = clamp(at.y, p.y + 0.2, p.y + h - 0.2);
      if (Math.hypot(at.x - p.x, at.y - cy, at.z - p.z) < r + PLAYER.RADIUS) return q;
    }
    return null;
  }

  /** A thrown bot slammed into the Warden. */
  thrownIntoWarden(by: Fighter | null, at: Vec3, n: number) {
    if (!by) return;
    const hit = this.nearestPart(at);
    if (hit) this.hitWarden(by, n, hit.part.part, at, POW.telekinesis.SCRAP_POISE);
  }

  // ------------------------------------------------------------------ loose things

  private addJunk(kind: JunkKind, x: number, y: number, z: number, stand = -1): Junk {
    const j = new Junk(this.nextJunk++, kind, x, y, z, this.time, stand);
    this.junk.push(j);
    // too much lying about: the oldest plate goes
    if (this.junk.length > JUNK.MAX) {
      const old = this.junk.find((o) => o.kind === JunkKind.Plate && !o.heldBy && o !== j);
      if (old) old.dead = true;
    }
    return j;
  }

  private stock(stand: number) {
    const s = this.arena.canisters[stand];
    this.addJunk(JunkKind.Canister, s[0], s[1] + 0.02, s[2], stand);
  }

  shellTouches(j: Junk): boolean {
    j.centre(a);
    return this.victimAt(a, 0.5) !== null || this.botAt(a, 0.4, null) !== null || (this.nearestPart(a)?.d ?? 9) < 0.2;
  }

  /** A thrown or batted thing hit something hard. */
  junkImpact(j: Junk, speed: number, puppet: boolean) {
    if (j.dead) return;
    if (j.kind === JunkKind.Canister) {
      if (j.thrownBy || speed > JUNK.HIT_SPEED) this.explode(j, j.thrownBy);
      return;
    }
    if (j.kind === JunkKind.Shell) { if (j.thrownBy) this.explode(j, j.thrownBy); return; }
    if (puppet && j.thrownBy) {
      j.centre(a);
      const hit = this.nearestPart(a);
      if (hit) this.hitWarden(j.thrownBy, POW.telekinesis.SCRAP_HIT * clamp(speed / POW.telekinesis.THROW_SPEED, 0.4, 1), hit.part.part, a, POW.telekinesis.SCRAP_POISE);
      j.vel.x *= 0.3; j.vel.z *= 0.3;
      j.thrownBy = null;
    }
  }

  /** A flying thing ran into a bot. */
  junkHits(j: Junk, bot: Bot, speed: number) {
    if (j.kind !== JunkKind.Plate) { this.explode(j, j.thrownBy); return; }
    const k = clamp(speed / POW.telekinesis.THROW_SPEED, 0.4, 1);
    this.hitBot(bot, POW.telekinesis.BOT_HIT * k, j.thrownBy, j.vel.x * 0.5, 5, j.vel.z * 0.5, 1);
    j.vel.x *= 0.35; j.vel.z *= 0.35;
  }

  /**
   * A canister or a shell goes off. The Warden's own shells hurt runners; anything
   * a runner set off only hurts the machines (and chains into other canisters).
   */
  explode(j: Junk, by: Fighter | null) {
    if (j.dead) return;
    j.dead = true;
    if (j.heldBy) { j.heldBy.held = null; j.heldBy = null; }
    const canister = j.kind === JunkKind.Canister;
    const hostile = j.hostile;
    const R = canister ? JUNK.CANISTER_RADIUS : BOSS.MORTAR.RADIUS;
    j.centre(e);
    this.emit({ k: 'boom', p: p3(e), r: R, c: canister ? 0 : 1 });
    if (canister && j.stand >= 0) this.restock.set(j.stand, this.time + JUNK.RESPAWN);
    if (hostile) {
      for (const q of this.victims()) {
        const d = Math.hypot(q.pos.x - e.x, q.pos.y + 0.9 - e.y, q.pos.z - e.z);
        if (d > R + PLAYER.RADIUS) continue;
        const k = 1 - 0.5 * clamp(d / R, 0, 1), n = d > 0.01 ? 1 / d : 0;
        this.hurt(q, BOSS.MORTAR.DAMAGE * k, 'mortar', e, { x: (q.pos.x - e.x) * n * BOSS.MORTAR.KNOCK * k, y: 5, z: (q.pos.z - e.z) * n * BOSS.MORTAR.KNOCK * k });
      }
    }
    const dmg = canister ? JUNK.CANISTER_DAMAGE : BOSS.MORTAR.DAMAGE;
    for (const bot of this.bots) {
      if (bot.state === BotState.Flying) continue;
      bot.centre(c);
      const d = Math.hypot(c.x - e.x, c.y - e.y, c.z - e.z);
      if (d > R + bot.radius) continue;
      const k = 1 - 0.5 * clamp(d / R, 0, 1), n = d > 0.01 ? 1 / d : 0;
      this.hitBot(bot, dmg * k, by, (c.x - e.x) * n * 12 * k, 6 * k, (c.z - e.z) * n * 12 * k, 0.8);
    }
    if (!hostile) {
      const hit = this.nearestPart(e);
      if (hit && hit.d < R) {
        const k = 1 - 0.5 * clamp(hit.d / R, 0, 1);
        this.hitWarden(by, (canister ? JUNK.CANISTER_BOSS : 60) * k, hit.part.part, e, JUNK.CANISTER_POISE * k);
      }
    }
    for (const o of this.junk) {
      if (o === j || o.dead || o.heldBy) continue;
      o.centre(c);
      const d = Math.hypot(c.x - e.x, c.y - e.y, c.z - e.z);
      if (d > R + 0.6) continue;
      if (o.kind === JunkKind.Canister && !this.booms.some((bm) => bm.j === o)) { this.booms.push({ j: o, at: this.time + 0.12 + this.rand() * 0.1, by }); continue; }
      const n = d > 0.01 ? 1 / d : 0;
      o.vel.x += (c.x - e.x) * n * 9; o.vel.y += 6; o.vel.z += (c.z - e.z) * n * 9;
      o.body.grounded = false;
    }
    for (const o of this.orbs) if (Math.hypot(o.pos.x - e.x, o.pos.y - e.y, o.pos.z - e.z) < R) this.endOrb(o);
  }

  // ------------------------------------------------------------------ gravity wells

  wellMeetsWarden(wl: Well): boolean {
    const hit = this.nearestPart(wl.pos);
    if (!hit || hit.d > 0.4) return false;
    const w = this.warden, dx = wl.pos.x - w.x, dz = wl.pos.z - w.z, cs = Math.cos(w.yaw), sn = Math.sin(w.yaw);
    wl.stuck = { x: dx * cs - dz * sn, y: wl.pos.y - ARENA.y - w.lift, z: dx * sn + dz * cs };
    return true;
  }

  followWarden(wl: Well) {
    const s = wl.stuck!;
    this.warden.point(s.x, s.y, s.z, wl.pos);
  }

  openWell(wl: Well) {
    if (wl.open) return;
    wl.open = true;
    wl.openedAt = this.time;
    this.emit({ k: 'well', id: wl.id, s: 'open', p: p3(wl.pos) });
  }

  /** An open well pulls bots, loose things and orbs in, crushes what reaches its heart, and holds the Warden down. */
  pullWell(wl: Well, dt: number) {
    const G = POW.gravity, R = G.RADIUS;
    for (const bot of this.bots) {
      if (bot.state === BotState.Flying || bot.state === BotState.Held) continue;
      bot.centre(c);
      const dx = wl.pos.x - c.x, dy = wl.pos.y - c.y, dz = wl.pos.z - c.z, d = Math.hypot(dx, dy, dz);
      if (d > R || d < 0.01) continue;
      const k = G.PULL * (1 - d / R * 0.6);
      const v = bot.v;
      // drawn in hard, and held in the heart with a swirl
      v.x += ((dx / d) * k * 4 - v.x * 1.5) * dt + (-dz / d) * k * 0.6 * dt;
      v.y += ((dy / d) * k * 4 + 22 - v.y * 1.5) * dt;
      v.z += ((dz / d) * k * 4 - v.z * 1.5) * dt + (dx / d) * k * 0.6 * dt;
      if (bot.kind === BotKind.Skitter) { bot.body.grounded = false; bot.body.ground = null; }
      bot.knock(this, 0, 0, 0, 0.3);
      if (d < 2.6) {
        bot.crushed += G.CRUSH * dt;
        if (bot.crushed >= 4) { this.hitBot(bot, bot.crushed, wl.owner, 0, 0, 0, 0.3); bot.crushed = 0; }
      }
    }
    for (const j of this.junk) {
      if (j.heldBy) continue;
      j.centre(c);
      const dx = wl.pos.x - c.x, dy = wl.pos.y - c.y, dz = wl.pos.z - c.z, d = Math.hypot(dx, dy, dz);
      if (d > R || d < 0.01) continue;
      const k = G.PULL * 3 * (1 - d / R * 0.6);
      j.vel.x += ((dx / d) * k - j.vel.x * 1.5) * dt; j.vel.y += ((dy / d) * k + 20 - j.vel.y * 1.5) * dt; j.vel.z += ((dz / d) * k - j.vel.z * 1.5) * dt;
      j.body.grounded = false; j.body.ground = null;
      if (j.hostile) { j.hostile = false; j.thrownBy = wl.owner; }
    }
    for (const o of this.orbs) {
      const dx = wl.pos.x - o.pos.x, dy = wl.pos.y - o.pos.y, dz = wl.pos.z - o.pos.z, d = Math.hypot(dx, dy, dz);
      if (d > R) continue;
      if (d < 1.2) { this.endOrb(o); continue; }
      o.vel.x += (dx / d) * 60 * dt; o.vel.y += (dy / d) * 60 * dt; o.vel.z += (dz / d) * 60 * dt;
    }
    // on the Warden (or close enough to its body): it grinds and slows
    const w = this.warden;
    const hit = this.nearestPart(wl.pos);
    if (w.alive && hit && (wl.stuck || hit.d < R * 0.35)) {
      w.slow(this);
      wl.grind += G.BOSS_DPS * dt;
      if (wl.grind >= 6) { this.hitWarden(wl.owner, wl.grind, hit.part.part, wl.pos, G.BOSS_POISE * (wl.grind / G.BOSS_DPS)); wl.grind = 0; }
    }
  }

  /** The well closes: everything it gathered is thrown out and up, hard. */
  closeWell(wl: Well) {
    const G = POW.gravity, R = G.BURST_RADIUS;
    wl.dead = true;
    this.emit({ k: 'well', id: wl.id, s: 'close', p: p3(wl.pos) });
    this.emit({ k: 'boom', p: p3(wl.pos), r: R, c: 2 });
    for (const bot of this.bots) {
      if (bot.state === BotState.Flying) continue;
      bot.centre(c);
      const d = Math.hypot(c.x - wl.pos.x, c.y - wl.pos.y, c.z - wl.pos.z);
      if (d > R + 1.5) continue;
      const n = d > 0.3 ? 1 / d : 0, ang = this.rand() * Math.PI * 2;
      const hx = d > 0.3 ? (c.x - wl.pos.x) * n : Math.sin(ang), hz = d > 0.3 ? (c.z - wl.pos.z) * n : Math.cos(ang);
      this.hitBot(bot, G.BURST, wl.owner, hx * G.BURST_KNOCK, 10, hz * G.BURST_KNOCK, 1.2);
    }
    for (const j of this.junk) {
      if (j.heldBy || j.dead) continue;
      j.centre(c);
      const d = Math.hypot(c.x - wl.pos.x, c.y - wl.pos.y, c.z - wl.pos.z);
      if (d > R + 1.5) continue;
      if (j.kind === JunkKind.Canister || j.kind === JunkKind.Shell) { this.booms.push({ j, at: this.time + 0.05, by: wl.owner }); continue; }
      const n = d > 0.3 ? 1 / d : 0;
      j.vel.x = (c.x - wl.pos.x) * n * 14; j.vel.y = 9; j.vel.z = (c.z - wl.pos.z) * n * 14;
      j.thrownBy = wl.owner;
    }
    const hit = this.nearestPart(wl.pos);
    if (hit && (wl.stuck || hit.d < R)) this.hitWarden(wl.owner, G.BURST_BOSS, hit.part.part, wl.pos, G.BOSS_POISE * 2);
  }

  // ------------------------------------------------------------------ powers

  /** Releases whatever this runner holds with telekinesis (it drops where it is). */
  dropHeld(q: Fighter) {
    const h = q.held;
    if (!h) return;
    q.held = null;
    if (h.kind === 1) this.bots.find((x) => x.id === h.id)?.release(0, 0, 0, null, this);
    else this.junk.find((x) => x.id === h.id)?.release(0, 0, 0, null);
    this.emit({ k: 'fx', id: q.id, f: PowAct.Drop, d: [h.kind, h.id] });
  }

  /** A runner used its power. See the file header for how hits are judged. */
  pow(p: RoomPlayer, m: Extract<C2S, { t: 'pow' }>) {
    const q = this.fighter(p);
    if (!q || p.status !== Status.Alive || !q.kind || !this.warden.alive) return;
    const t = this.time;
    const num = (v: unknown) => typeof v === 'number' && isFinite(v);
    if (!Array.isArray(m.o) || !Array.isArray(m.d) || !m.o.every(num) || !m.d.every(num)) return;
    // where from: the client's word, as long as it is close to where the server has it
    const o = v3(m.o[0], m.o[1], m.o[2]);
    if (Math.hypot(o.x - p.pos.x, o.y - p.pos.y, o.z - p.pos.z) > 6) { o.x = p.pos.x; o.y = p.pos.y; o.z = p.pos.z; }
    const dl = Math.hypot(m.d[0], m.d[1], m.d[2]) || 1;
    const d = v3(m.d[0] / dl, m.d[1] / dl, m.d[2] / dl);
    const tr = num(m.tm) ? clamp((m.tm as number) - NET.INTERP_DELAY, t - 0.35, t) : t;
    const dest = Array.isArray(m.p) && m.p.length === 3 && m.p.every(num) ? v3(m.p[0], m.p[1], m.p[2]) : null;
    switch (m.a) {
      case PowAct.Slash: if (q.kind === 'angel') this.slash(q, o, d, tr, num(m.v) ? (m.v as number) | 0 : 0); break;
      case PowAct.Soar: if (q.kind === 'angel') this.soar(q, o, tr); break;
      case PowAct.Dive: if (q.kind === 'angel') this.dive(q, dest ?? o, num(m.v) ? (m.v as number) : 0, tr); break;
      case PowAct.Grab: case PowAct.Throw: case PowAct.Push: if (q.kind === 'telekinesis') this.telekinesis(q, m.a, o, d, m.tg); break;
      case PowAct.Bolt: if (q.kind === 'lightning') this.bolt(q, o, d, m.tg, tr); break;
      case PowAct.Well: if (q.kind === 'gravity') this.well(q, o, d); break;
      case PowAct.Flash: if (q.kind === 'speed' && dest) this.flash(q, o, dest, num(m.v) ? (m.v as number) : 0, tr); break;
      case PowAct.Blast: if (q.kind === 'sonic') this.blast(q, o, d, tr, false); break;
      case PowAct.Boom: if (q.kind === 'sonic') this.blast(q, o, d, tr, true); break;
    }
  }

  /** The runner's chest, for powers thrown from the hands. */
  private chest(o: Vec3, out: Vec3): Vec3 { out.x = o.x; out.y = o.y + 1.25; out.z = o.z; return out; }

  /** Everything in a cone: bots, loose things and orbs, plus the Warden's nearest part in it. */
  private inCone(from: Vec3, d: Vec3, range: number, cone: number, tr: number, each: (kind: 'bot' | 'junk' | 'orb', o: Bot | Junk | Orb, dist: number) => void): PartSphere | null {
    const cosC = Math.cos(cone);
    const inside = (x: number, y: number, z: number, r: number) => {
      const dx = x - from.x, dy = y - from.y, dz = z - from.z, dist = Math.hypot(dx, dy, dz);
      if (dist - r > range) return -1;
      if (dist < r + 0.5) return dist;
      return (dx * d.x + dy * d.y + dz * d.z) / dist >= cosC ? dist : -1;
    };
    for (const bot of this.bots) {
      if (bot.state === BotState.Flying || bot.state === BotState.Held) continue;
      bot.centre(c);
      const dist = inside(c.x, c.y, c.z, bot.radius);
      if (dist >= 0) each('bot', bot, dist);
    }
    for (const j of this.junk) {
      if (j.heldBy) continue;
      j.centre(c);
      const dist = inside(c.x, c.y, c.z, 0.6);
      if (dist >= 0) each('junk', j, dist);
    }
    for (const o of this.orbs) {
      const dist = inside(o.pos.x, o.pos.y, o.pos.z, 0.4);
      if (dist >= 0) each('orb', o, dist);
    }
    if (!this.warden.alive) return null;
    let best: PartSphere | null = null, bd = Infinity;
    for (const s of this.warden.partsAt(this, tr)) {
      const dist = inside(s.x, s.y, s.z, s.r);
      if (dist < 0) continue;
      const surf = dist - s.r;
      if (surf < bd) { bd = surf; best = s; }
    }
    return best;
  }

  /** Turns an orb round to fly back at the Warden. */
  private turnOrb(o: Orb, q: Fighter, speed: number) {
    o.turnedBy = q;
    this.warden.point(0, 1.9, -0.6, c);
    const dx = c.x - o.pos.x, dy = c.y - o.pos.y, dz = c.z - o.pos.z, d = Math.hypot(dx, dy, dz) || 1;
    o.vel.x = (dx / d) * speed; o.vel.y = (dy / d) * speed; o.vel.z = (dz / d) * speed;
    // everyone redraws it on its new course
    this.emit({ k: 'orb', id: o.id, p: p3(o.pos), v: p3(o.vel), t: r2(this.time) });
  }

  /**
   * A sword slash. `combo` is where in the combo it came (0 a rising cut, 1 a
   * reverse cut, 2 a spinning sweep, 3 an overhead cleave): the cuts throw what they
   * hit across the swing, the sweep reaches wider, the cleave further and harder,
   * throwing what it hits up.
   */
  private slash(q: Fighter, o: Vec3, d: Vec3, tr: number, combo: number) {
    const A = POW.angel, t = this.time;
    if (t < q.ready - 0.06) return;
    q.ready = t + A.COOLDOWN;
    combo = clamp(combo, 0, 3);
    d.y = clamp(d.y, -0.7, 0.7);
    const l = Math.hypot(d.x, d.y, d.z) || 1;
    d.x /= l; d.y /= l; d.z /= l;
    this.chest(o, a);
    // the step in carries the blade half a metre before it cuts
    a.x += d.x * 0.6; a.z += d.z * 0.6;
    const sweep = combo === 2, cleave = combo === 3;
    const reach = cleave ? A.CLEAVE_REACH : A.REACH, cone = sweep ? A.SWEEP_CONE : A.CONE;
    const k = cleave ? A.CLEAVE_K : sweep ? A.SWEEP_K : 1;
    const hl = Math.hypot(d.x, d.z) || 1;
    // the rising cut goes right to left, the reverse cut back again
    const side = combo === 0 ? A.CUT_SIDE : combo === 1 ? -A.CUT_SIDE : 0, up = cleave ? A.CLEAVE_LIFT : A.LIFT;
    const kx = d.x * A.KNOCK + (d.z / hl) * side, kz = d.z * A.KNOCK - (d.x / hl) * side;
    let hit = 0;
    const part = this.inCone(a, d, reach + 1, cone, tr, (kind, x) => {
      if (kind === 'bot') { hit = 1; this.hitBot(x as Bot, A.BOT_DAMAGE * k, q, kx, up, kz, 0.7); }
      else if (kind === 'junk') {
        const j = x as Junk;
        j.vel.x = d.x * A.BAT_SPEED; j.vel.y = d.y * A.BAT_SPEED + 3; j.vel.z = d.z * A.BAT_SPEED;
        j.body.grounded = false; j.body.ground = null; j.thrownBy = q; j.hostile = false;
        hit = 1;
      } else { this.turnOrb(x as Orb, q, 34); hit = 1; }
    });
    if (part) { hit = 1; this.hitWarden(q, A.DAMAGE * k, part.part, v3(part.x, part.y, part.z), A.POISE * (cleave ? 2 : 1)); }
    this.emit({ k: 'fx', id: q.id, f: PowAct.Slash, d: [r2(a.x), r2(a.y), r2(a.z), r2(d.x), r2(d.y), r2(d.z), hit, combo] });
  }

  /** The angel's R on the ground: one great beat of the wings, a gust that blows everything round you away. */
  private soar(q: Fighter, o: Vec3, tr: number) {
    const A = POW.angel, t = this.time;
    if (t < q.soarReady - 0.06) return;
    q.soarReady = t + A.SOAR_COOLDOWN;
    const R = A.SOAR_RADIUS;
    a.x = o.x; a.y = o.y + 0.8; a.z = o.z;
    const away = (x: number, z: number, out: Vec3) => {
      const dx = x - a.x, dz = z - a.z, dist = Math.hypot(dx, dz);
      if (dist > 0.05) { out.x = dx / dist; out.z = dz / dist; } else { const ang = this.rand() * Math.PI * 2; out.x = Math.sin(ang); out.z = Math.cos(ang); }
      return dist;
    };
    for (const bot of this.bots) {
      if (bot.state === BotState.Flying || bot.state === BotState.Held) continue;
      bot.centre(c);
      const dist = away(c.x, c.z, b);
      if (dist > R + bot.radius || Math.abs(c.y - a.y) > 3.5) continue;
      const k = 1 - 0.5 * clamp(dist / R, 0, 1);
      this.hitBot(bot, A.SOAR_DAMAGE * k, q, b.x * A.SOAR_KNOCK * k, A.SOAR_LIFT * k, b.z * A.SOAR_KNOCK * k, 0.9);
    }
    for (const j of this.junk) {
      if (j.heldBy) continue;
      j.centre(c);
      const dist = away(c.x, c.z, b);
      if (dist > R + 0.6 || Math.abs(c.y - a.y) > 3.5) continue;
      const k = 1 - 0.5 * clamp(dist / R, 0, 1);
      j.vel.x += b.x * A.SOAR_KNOCK * k; j.vel.y += A.SOAR_LIFT * k; j.vel.z += b.z * A.SOAR_KNOCK * k;
      j.body.grounded = false; j.body.ground = null; j.thrownBy = q; j.hostile = false;
    }
    for (const orb of this.orbs) if (Math.hypot(orb.pos.x - a.x, orb.pos.y - a.y, orb.pos.z - a.z) < R) this.endOrb(orb);
    const hit = this.nearestPart(a, tr);
    if (hit && hit.d < R * 0.6) this.hitWarden(q, A.SOAR_BOSS, hit.part.part, v3(hit.part.x, hit.part.y, hit.part.z), A.SOAR_POISE);
    this.emit({ k: 'fx', id: q.id, f: PowAct.Soar, d: [r2(o.x), r2(o.y), r2(o.z)] });
  }

  /** The angel's dive lands: a burst of light that grows with the speed of the dive (on the Warden's back: into the core). */
  private dive(q: Fighter, at: Vec3, v: number, tr: number) {
    const A = POW.angel, t = this.time;
    if (t < q.diveReady) return;
    q.diveReady = t + A.DIVE_COOLDOWN;
    if (Math.hypot(at.x - q.p.pos.x, at.y - q.p.pos.y, at.z - q.p.pos.z) > 6) { at.x = q.p.pos.x; at.y = q.p.pos.y; at.z = q.p.pos.z; }
    const speed = clamp(v, 0, A.DIVE_SPEED + 12);
    const dmg = Math.min(A.DIVE_MAX, A.DIVE_BASE + A.DIVE_PER_SPEED * speed);
    const R = A.DIVE_RADIUS;
    a.x = at.x; a.y = at.y + 0.6; a.z = at.z;
    for (const bot of this.bots) {
      if (bot.state === BotState.Flying || bot.state === BotState.Held) continue;
      bot.centre(c);
      const dx = c.x - a.x, dz = c.z - a.z, dist = Math.hypot(dx, dz);
      if (dist > R + bot.radius || Math.abs(c.y - a.y) > 3) continue;
      const k = 1 - 0.5 * clamp(dist / R, 0, 1), n = dist > 0.01 ? 1 / dist : 0;
      this.hitBot(bot, dmg * k, q, dx * n * 13 * k, 10 * k, dz * n * 13 * k, 1);
    }
    for (const j of this.junk) {
      if (j.heldBy) continue;
      const dx = j.pos.x - a.x, dz = j.pos.z - a.z, dist = Math.hypot(dx, dz);
      if (dist > R + 0.6 || Math.abs(j.pos.y - at.y) > 3) continue;
      const n = dist > 0.01 ? 1 / dist : 0;
      j.vel.x += dx * n * 5; j.vel.y += 9; j.vel.z += dz * n * 5;
      j.body.grounded = false; j.body.ground = null; j.thrownBy = q; j.hostile = false;
    }
    // coming down on its back: straight through the plating into the core
    const riding = this.onWarden(q) || this.nearestPart(a, tr)?.part.part === 1;
    const hit = this.nearestPart(a, tr);
    if (hit && hit.d < R * 0.8) this.hitWarden(q, dmg, riding ? 1 : hit.part.part, a, A.DIVE_POISE);
    this.emit({ k: 'fx', id: q.id, f: PowAct.Dive, d: [r2(at.x), r2(at.y), r2(at.z), r2(speed)] });
  }

  private telekinesis(q: Fighter, act: number, o: Vec3, d: Vec3, tg: unknown) {
    const T = POW.telekinesis, t = this.time;
    if (t < q.ready - 0.05) return;
    // holding something: any press throws it
    if (q.held) {
      const h = q.held;
      q.held = null;
      q.ready = t + T.THROW_COOLDOWN;
      const vx = d.x * T.THROW_SPEED, vy = d.y * T.THROW_SPEED + 1.5, vz = d.z * T.THROW_SPEED;
      if (h.kind === 1) this.bots.find((x) => x.id === h.id)?.release(vx, vy, vz, q, this);
      else this.junk.find((x) => x.id === h.id)?.release(vx, vy, vz, q);
      this.emit({ k: 'fx', id: q.id, f: PowAct.Throw, d: [h.kind, h.id, r2(d.x), r2(d.y), r2(d.z)] });
      return;
    }
    // grab what it was aimed at, if it can be had
    if (act === PowAct.Grab && Array.isArray(tg) && tg.length === 3) {
      const [kind, id] = tg as number[];
      this.chest(o, a);
      if (kind === 1) {
        const bot = this.bots.find((x) => x.id === id);
        if (bot && bot.state !== BotState.Flying && bot.state !== BotState.Held && Math.hypot(bot.pos.x - a.x, bot.pos.y - a.y, bot.pos.z - a.z) < T.RANGE + 4) {
          bot.heldBy = q;
          bot.state = BotState.Held; bot.stateT = 0;
          q.held = { kind: 1, id, at: t };
        }
      } else if (kind === 2) {
        const j = this.junk.find((x) => x.id === id);
        if (j && !j.heldBy && Math.hypot(j.pos.x - a.x, j.pos.y - a.y, j.pos.z - a.z) < T.RANGE + 4) {
          j.heldBy = q;
          j.hostile = false;
          q.held = { kind: 2, id, at: t };
        }
      }
      if (q.held) {
        q.ready = t + T.COOLDOWN;
        this.emit({ k: 'fx', id: q.id, f: PowAct.Grab, d: [kind, id] });
        return;
      }
    }
    // nothing to hold: a push that shoves everything in front of you and turns shots round
    if (t < q.pushReady - 0.05) return;
    q.pushReady = t + T.PUSH_COOLDOWN;
    q.ready = t + T.COOLDOWN;
    this.chest(o, a);
    const part = this.inCone(a, d, T.PUSH_RANGE, T.PUSH_CONE, t, (kind, x, dist) => {
      const k = 1 - clamp(dist / T.PUSH_RANGE, 0, 1) * 0.4;
      if (kind === 'bot') this.hitBot(x as Bot, T.PUSH_DAMAGE, q, d.x * T.PUSH_KNOCK * k, 4, d.z * T.PUSH_KNOCK * k, 0.9);
      else if (kind === 'junk') {
        const j = x as Junk;
        j.vel.x += d.x * 14 * k; j.vel.y += 3 + d.y * 10; j.vel.z += d.z * 14 * k;
        j.body.grounded = false; j.body.ground = null; j.thrownBy = q; j.hostile = false;
      } else this.turnOrb(x as Orb, q, 30);
    });
    if (part) this.hitWarden(q, T.PUSH_BOSS, part.part, v3(part.x, part.y, part.z), T.PUSH_POISE);
    this.emit({ k: 'fx', id: q.id, f: PowAct.Push, d: [r2(a.x), r2(a.y), r2(a.z), r2(d.x), r2(d.y), r2(d.z)] });
  }

  private bolt(q: Fighter, o: Vec3, d: Vec3, tg: unknown, tr: number) {
    const L = POW.lightning, t = this.time;
    if (t < q.boltReady - 0.04 || t < q.overheatUntil) return;
    q.boltReady = t + L.INTERVAL;
    q.heat = Math.max(0, q.heat - L.COOL * (t - q.heatAt));
    q.heatAt = t;
    q.heat += L.HEAT_PER;
    if (q.heat >= 100) { q.heat = 0; q.overheatUntil = t + L.OVERHEAT; }
    this.chest(o, a);
    const path: number[] = [r2(a.x), r2(a.y), r2(a.z)];
    // what the bolt was aimed at, if it can really reach it
    let end: Vec3 | null = null;
    let first: Bot | Junk | null = null;
    let wardenPart = -1;
    if (Array.isArray(tg) && tg.length === 3) {
      const [kind, id, part] = tg as number[];
      if (kind === 0 && this.warden.alive) {
        const s = this.warden.partsAt(this, tr).find((x) => x.part === part) ?? null;
        if (s && this.reach(a, s.x, s.y, s.z, L.RANGE + 3, true)) { end = v3(s.x, s.y, s.z); wardenPart = part; }
      } else if (kind === 1) {
        const bot = this.bots.find((x) => x.id === id && x.state !== BotState.Flying);
        if (bot && this.reach(a, bot.pos.x, bot.centre(c).y, bot.pos.z, L.RANGE + 3, false)) { end = v3(c.x, c.y, c.z); first = bot; }
      } else if (kind === 2) {
        const j = this.junk.find((x) => x.id === id);
        if (j && this.reach(a, j.pos.x, j.centre(c).y, j.pos.z, L.RANGE + 3, false)) { end = v3(c.x, c.y, c.z); first = j; }
      }
    }
    if (!end) {
      // a miss: the bolt cracks into whatever is in front of you
      this.world.raycast(a.x, a.y, a.z, d.x, d.y, d.z, L.RANGE, false, ray);
      const len = ray.c ? ray.dist : L.RANGE;
      end = v3(a.x + d.x * len, a.y + d.y * len, a.z + d.z * len);
    }
    path.push(r2(end.x), r2(end.y), r2(end.z));
    if (wardenPart >= 0) {
      this.hitWarden(q, L.DAMAGE, wardenPart, end, L.POISE);
      q.bolts++;
      if (q.bolts % L.THUNDER === 0) this.thunder(q);
    } else if (first instanceof Bot) this.hitBot(first, L.BOT_DAMAGE, q, d.x * 2, 1, d.z * 2, L.STUN);
    else if (first instanceof Junk && first.kind !== JunkKind.Plate) this.explode(first, q);
    // chain on to the next bot or canister along, weaker each jump
    const done = new Set<Bot | Junk>();
    if (first) done.add(first);
    let from = end, k = 1;
    for (let jump = 0; jump < L.JUMPS && (first || wardenPart >= 0); jump++) {
      let next: Bot | Junk | null = null, nd = L.CHAIN;
      for (const bot of this.bots) {
        if (done.has(bot) || bot.state === BotState.Flying) continue;
        bot.centre(c);
        const dd = Math.hypot(c.x - from.x, c.y - from.y, c.z - from.z);
        if (dd < nd) { nd = dd; next = bot; }
      }
      for (const j of this.junk) {
        if (done.has(j) || j.kind !== JunkKind.Canister || j.heldBy) continue;
        j.centre(c);
        const dd = Math.hypot(c.x - from.x, c.y - from.y, c.z - from.z);
        if (dd < nd) { nd = dd; next = j; }
      }
      if (!next) break;
      done.add(next);
      k *= L.CHAIN_FALLOFF;
      const to = next.centre(v3());
      path.push(r2(to.x), r2(to.y), r2(to.z));
      if (next instanceof Bot) this.hitBot(next, L.BOT_DAMAGE * k, q, 0, 1, 0, L.STUN);
      else this.explode(next, q);
      from = to;
    }
    this.emit({ k: 'fx', id: q.id, f: PowAct.Bolt, d: path });
  }

  /** Can a bolt from `from` reach (x, y, z)? The Warden's own body does not block a bolt aimed at it. */
  private reach(from: Vec3, x: number, y: number, z: number, range: number, warden: boolean): boolean {
    const dx = x - from.x, dy = y - from.y, dz = z - from.z, d = Math.hypot(dx, dy, dz);
    if (d > range) return false;
    if (d < 0.5) return true;
    this.world.raycast(from.x, from.y, from.z, dx / d, dy / d, dz / d, d - 0.6, false, ray);
    return !ray.c || (warden && ray.c.kind === 'puppet');
  }

  /** The storm answers a runner who has been pouring lightning into the Warden. */
  private thunder(q: Fighter) {
    const L = POW.lightning;
    this.warden.point(0, 1.9, -0.6, e);
    this.emit({ k: 'thunder', id: q.id, p: p3(e) });
    this.hitWarden(q, L.THUNDER_DAMAGE, 1, e, L.THUNDER_POISE);
    for (const bot of this.bots) {
      bot.centre(c);
      const d = Math.hypot(c.x - e.x, c.z - e.z);
      if (d < 10) this.hitBot(bot, L.THUNDER_BOT, q, 0, 6, 0, 1);
    }
  }

  private well(q: Fighter, o: Vec3, d: Vec3) {
    const G = POW.gravity, t = this.time;
    if (t < q.ready - 0.06) return;
    q.ready = t + G.COOLDOWN;
    this.chest(o, a);
    a.x += d.x * 1.2; a.y += d.y * 1.2; a.z += d.z * 1.2;
    const wl = new Well(this.nextWell++, q, a.x, a.y, a.z, d.x, d.y, d.z);
    this.wells.push(wl);
    this.emit({ k: 'fx', id: q.id, f: PowAct.Well, d: [wl.id, r2(a.x), r2(a.y), r2(a.z), r2(d.x), r2(d.y), r2(d.z)] });
  }

  private flash(q: Fighter, o: Vec3, to: Vec3, v: number, tr: number) {
    const S = POW.speed, t = this.time;
    const dist = Math.hypot(to.x - o.x, to.y - o.y, to.z - o.z);
    if (dist > S.DIST + 2) return;
    // the streak itself always stands (it is the runner's own movement); whether it hurts depends on the cool-down
    q.allow = dist + 2.5; q.allowUntil = t + 0.7;
    let hit = 0;
    if (t >= q.flashReady - 0.08) {
      const dmg = S.BASE + S.PER_SPEED * clamp(v, 0, PLAYER.SPRINT_SPEED * S.SPRINT + 2);
      this.chest(o, a); this.chest(to, b);
      const dx = b.x - a.x, dz = b.z - a.z, dl = Math.hypot(dx, dz) || 1;
      for (const bot of this.bots) {
        if (bot.state === BotState.Flying || bot.state === BotState.Held) continue;
        bot.centre(c);
        if (segDist(c.x, c.y, c.z, a, b) > S.WIDTH / 2 + bot.radius) continue;
        const side = (-(c.x - a.x) * dz + (c.z - a.z) * dx) >= 0 ? 1 : -1;
        this.hitBot(bot, dmg, q, (-dz / dl) * side * S.KNOCK + (dx / dl) * 4, 4, (dx / dl) * side * S.KNOCK + (dz / dl) * 4, 0.7);
        hit = 1;
      }
      for (const j of this.junk) {
        if (j.heldBy) continue;
        j.centre(c);
        if (segDist(c.x, c.y, c.z, a, b) > S.WIDTH / 2 + 0.6) continue;
        if (j.kind === JunkKind.Canister || j.kind === JunkKind.Shell) this.explode(j, q);
        else { j.vel.x += (dx / dl) * 12; j.vel.y += 4; j.vel.z += (dz / dl) * 12; j.thrownBy = q; j.body.grounded = false; }
        hit = 1;
      }
      for (const orb of this.orbs) if (segDist(orb.pos.x, orb.pos.y, orb.pos.z, a, b) < S.WIDTH / 2 + 0.4) this.endOrb(orb);
      if (this.warden.alive) {
        let best: PartSphere | null = null, bm = 0;
        for (const s of this.warden.partsAt(this, tr)) {
          if (segDist(s.x, s.y, s.z, a, b) > S.WIDTH / 2 + s.r) continue;
          const mult = s.part === 1 ? 3 : s.part === 3 ? 2.5 : s.part === 2 ? 1.5 : 1;
          if (mult > bm) { bm = mult; best = s; }
        }
        if (best) { this.hitWarden(q, dmg * S.BOSS_SHARE, best.part, v3(best.x, best.y, best.z), S.POISE); hit = 1; }
      }
      q.flashReady = t + S.COOLDOWN;
    }
    this.emit({ k: 'fx', id: q.id, f: PowAct.Flash, d: [r2(o.x), r2(o.y), r2(o.z), r2(to.x), r2(to.y), r2(to.z), hit] });
  }

  // ------------------------------------------------------------------ sonic force

  /** A blast (a cone along `d`) or a boom (a ring all round): the wave goes out from the chest. */
  private blast(q: Fighter, o: Vec3, d: Vec3, tr: number, boom: boolean) {
    const S = POW.sonic, t = this.time;
    if (boom) {
      if (t < q.boomReady - 0.06) return;
      q.boomReady = t + S.BOOM_COOLDOWN;
    } else {
      if (t < q.ready - 0.06) return;
      q.ready = t + S.COOLDOWN;
    }
    const from = this.chest(o, v3());
    this.waves.push({ by: q, o: from, d: v3(d.x, d.y, d.z), t0: t, tr, boom, struck: new Set() });
    this.emit({ k: 'fx', id: q.id, f: boom ? PowAct.Boom : PowAct.Blast, d: [r2(from.x), r2(from.y), r2(from.z), r2(d.x), r2(d.y), r2(d.z)] });
  }

  /**
   * One step of a sonic wave: everything its front has reached (inside the cone, in
   * the open) is struck once, harder the nearer it is. Returns false once the front
   * is past its range.
   */
  private waveStep(wv: Wave): boolean {
    const S = POW.sonic, t = this.time, q = wv.by;
    const range = wv.boom ? S.BOOM_RADIUS : S.RANGE;
    const front = (t - wv.t0) * (wv.boom ? S.BOOM_SPEED : S.SPEED);
    const cosC = Math.cos(S.CONE);
    const o = wv.o, d = wv.d;
    // how far out (x, y, z) is if the front has reached it inside the cone (-1: not, or not yet)
    const reached = (x: number, y: number, z: number, r: number) => {
      const dx = x - o.x, dy = y - o.y, dz = z - o.z, dist = Math.hypot(dx, dy, dz);
      if (dist - r > front || dist - r > range) return -1;
      if (dist < r + 0.6) return dist;
      // a boom is a ring: it runs along the ground and a little above and below
      if (wv.boom) return Math.abs(dy) < 3.5 + r ? dist : -1;
      const along = (dx * d.x + dy * d.y + dz * d.z) / dist;
      return along >= cosC - Math.min(0.25, r / dist) ? dist : -1;
    };
    const falloff = (dist: number) => 1 - S.FALLOFF * clamp(dist / range, 0, 1);
    const impact = (x: number, y: number, z: number, kind: number, dist: number) => {
      const hx = x - o.x, hz = z - o.z, hl = Math.hypot(hx, hz) || 1;
      this.emit({ k: 'fx', id: q.id, f: PowAct.Impact, d: [r2(x), r2(y), r2(z), kind, r2(hx / hl), r2(hz / hl), r2(falloff(dist))] });
    };
    for (const bot of this.bots) {
      const key = 'b' + bot.id;
      if (wv.struck.has(key) || bot.dead || bot.state === BotState.Held) continue;
      bot.centre(c);
      const dist = reached(c.x, c.y, c.z, bot.radius);
      if (dist < 0) continue;
      wv.struck.add(key);
      if (!this.reach(o, c.x, c.y, c.z, range + 3, false)) continue;
      const k = falloff(dist), hx = c.x - o.x, hz = c.z - o.z, hl = Math.hypot(hx, hz) || 1;
      this.hitBot(bot, (wv.boom ? S.BOOM_BOT : S.BOT_DAMAGE) * k, q, (hx / hl) * (wv.boom ? S.BOOM_KNOCK : S.KNOCK) * k, (wv.boom ? S.BOOM_LIFT : S.LIFT) * k, (hz / hl) * (wv.boom ? S.BOOM_KNOCK : S.KNOCK) * k, 0.9);
      impact(c.x, c.y, c.z, 1, dist);
    }
    for (const j of this.junk) {
      const key = 'j' + j.id;
      if (wv.struck.has(key) || j.dead || j.heldBy) continue;
      j.centre(c);
      const dist = reached(c.x, c.y, c.z, 0.6);
      if (dist < 0) continue;
      wv.struck.add(key);
      if (!this.reach(o, c.x, c.y, c.z, range + 3, false)) continue;
      const k = falloff(dist), n = dist > 0.05 ? 1 / dist : 0;
      const dx = dist > 0.05 ? (c.x - o.x) * n : d.x, dy = dist > 0.05 ? (c.y - o.y) * n : d.y, dz = dist > 0.05 ? (c.z - o.z) * n : d.z;
      j.vel.x += dx * S.JUNK_SPEED * k; j.vel.y += Math.max(0, dy) * S.JUNK_SPEED * k + 5 * k; j.vel.z += dz * S.JUNK_SPEED * k;
      j.body.grounded = false; j.body.ground = null; j.thrownBy = q; j.hostile = false;
      impact(c.x, c.y, c.z, 2, dist);
    }
    for (const orb of this.orbs) {
      const key = 'o' + orb.id;
      if (wv.struck.has(key) || orb.dead || orb.turnedBy) continue;
      if (reached(orb.pos.x, orb.pos.y, orb.pos.z, 0.4) < 0) continue;
      wv.struck.add(key);
      this.turnOrb(orb, q, 34);
    }
    // the Warden, once: the nearest part the front has reached that it can get at
    // (a part behind a wall or a pillar is passed over, not the whole machine)
    if (!wv.struck.has('w') && this.warden.alive) {
      const parts = this.warden.partsAt(this, Math.min(t, wv.tr + (t - wv.t0)));
      const order: [number, number][] = [];
      parts.forEach((sp, i) => {
        if (wv.struck.has('w' + i)) return;
        const dist = reached(sp.x, sp.y, sp.z, sp.r);
        if (dist >= 0) order.push([i, dist]);
      });
      order.sort((x, y) => (x[1] - parts[x[0]].r) - (y[1] - parts[y[0]].r));
      for (const [i, dist] of order) {
        const sp = parts[i];
        if (!this.reach(o, sp.x, sp.y, sp.z, range + sp.r + 3, true)) { wv.struck.add('w' + i); continue; }
        wv.struck.add('w');
        const k = falloff(Math.max(0, dist - sp.r));
        this.hitWarden(q, (wv.boom ? S.BOOM_DAMAGE : S.DAMAGE) * k, sp.part, v3(sp.x, sp.y, sp.z), (wv.boom ? S.BOOM_POISE : S.POISE) * k);
        impact(sp.x, sp.y, sp.z, 0, Math.max(0, dist - sp.r));
        break;
      }
    }
    return front < range + 1;
  }

  // ------------------------------------------------------------------ the speedster's trail

  /** Lays the trail where a speedster runs fast, lets the old end of it go, and burns what touches it. */
  private trailStep(q: Fighter) {
    const S = POW.speed, t = this.time, p = q.p, tr = q.trail;
    while (tr.length && t - tr[0].t > S.TRAIL_LIFE) tr.shift();
    if (tr.length) tr[0].cut = true;
    if (p.status === Status.Alive && Math.hypot(p.vel.x, p.vel.z) > S.TRAIL_SPEED) {
      const last = tr[tr.length - 1];
      const gap = last ? Math.hypot(p.pos.x - last.x, p.pos.y - last.y, p.pos.z - last.z) : Infinity;
      // a stretch of trail breaks off if it stopped for a moment, or the runner jumped far (a flash strike)
      if (gap >= S.TRAIL_STEP) tr.push({ x: p.pos.x, y: p.pos.y, z: p.pos.z, t, cut: !last || gap > 6 || t - last.t > 0.3 });
    }
    if (tr.length < 2 || t - q.burnAt < S.TRAIL_TICK) return;
    const dt = Math.min(0.3, t - q.burnAt);
    q.burnAt = t;
    // the bots in it
    for (const bot of this.bots) {
      if (bot.dead || bot.state === BotState.Held || bot.state === BotState.Flying) continue;
      bot.centre(c);
      if (!this.inTrail(tr, c.x, c.y, c.z, bot.radius)) continue;
      const key = 'b' + bot.id;
      const n = (q.burn.get(key) ?? 0) + S.TRAIL_BOT * dt;
      if (n >= 6) { q.burn.set(key, 0); this.hitBot(bot, n, q, 0, 0, 0, 0.15); } else q.burn.set(key, n);
    }
    // the Warden: any part of it in the trail
    if (this.warden.alive && this.warden.awake) {
      let best: PartSphere | null = null;
      for (const sp of this.warden.partsAt(this)) {
        if (this.inTrail(tr, sp.x, sp.y, sp.z, sp.r) && (!best || sp.part === 1)) best = sp;
      }
      if (best) {
        const n = (q.burn.get('w') ?? 0) + S.TRAIL_BOSS * dt;
        if (n >= 10) { q.burn.set('w', 0); this.hitWarden(q, n, best.part, v3(best.x, best.y, best.z), S.TRAIL_POISE * (n / S.TRAIL_BOSS)); } else q.burn.set('w', n);
      }
    }
  }

  /** Does a sphere at (x, y, z) of radius r touch the trail (a band from the ankles to over the head)? */
  private inTrail(tr: TrailPoint[], x: number, y: number, z: number, r: number): boolean {
    const R = POW.speed.TRAIL_RADIUS + r;
    for (let i = 1; i < tr.length; i++) {
      const p1 = tr[i];
      if (p1.cut) continue;
      const p0 = tr[i - 1];
      // quick reject on the box round the stretch
      if (x < Math.min(p0.x, p1.x) - R || x > Math.max(p0.x, p1.x) + R || z < Math.min(p0.z, p1.z) - R || z > Math.max(p0.z, p1.z) + R) continue;
      const dx = p1.x - p0.x, dz = p1.z - p0.z, l2 = dx * dx + dz * dz;
      const u = l2 > 1e-6 ? clamp(((x - p0.x) * dx + (z - p0.z) * dz) / l2, 0, 1) : 0;
      const fy = p0.y + (p1.y - p0.y) * u;
      if (y < fy - 0.2 - r || y > fy + 2.4 + r) continue;
      if (Math.hypot(x - (p0.x + dx * u), z - (p0.z + dz * u)) < R) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ snapshots

  snapshot(): { b: BossSnap; m: BotSnap[]; j: JunkSnap[] } {
    const w = this.warden, t = this.time;
    const b: BossSnap = [r2(w.x), r2(w.z), r2(w.yaw), r2(w.lift), w.state, Math.round(w.hp), w.act, r2(w.actTime(t)), w.target ? w.target.id : 0, Math.round(w.poise), w.flags(this)];
    const m: BotSnap[] = this.bots.map((x) => [x.id, x.kind, r2(x.pos.x), r2(x.pos.y), r2(x.pos.z), r2(x.yaw), x.state, Math.round((x.hp / x.maxHp) * 100), x.target ? x.target.id : 0]);
    const j: JunkSnap[] = this.junk.map((x) => [x.id, x.kind, r2(x.pos.x), r2(x.pos.y), r2(x.pos.z), x.heldBy ? x.heldBy.id : 0, r2(x.spin)]);
    return { b, m, j };
  }
}

export { holdPoint };

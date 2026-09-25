// Duplication: copies of a runner that fight beside it on their own.
//
// A clone is a body in the arena like a bot is: it runs on the same physics, it
// can be hit by everything that hits runners (the Warden's attacks, bots, orbs,
// mortar shells) and it is destroyed when its health runs out. It never goes
// far from its owner: with nothing to fight it keeps to a slot at its owner's
// side, it chases only what is within reach of its owner, it runs back past a
// leash, and a clone left behind (up on a ledge it cannot climb, across a gap,
// thrown off the floor) steps out of thin air beside its owner again.
//
// What it fights, it picks for itself: the nearest bot it can reach, otherwise
// the lowest parts of the Warden it can get at (its feet and knees; the whole
// hull once it staggers and sinks). It jumps a stomp's shockwave when it sees
// one coming. A rally (its owner pointing at something with all four out)
// sends every clone at that one target, hitting harder for a few seconds.

import { ARENA, BOSS, PHYS, PLAYER, POW } from '../constants';
import { clamp, wrapAngle, type Vec3 } from '../math';
import { Anim, makeBody, stepBody, type CharBody, type StepInfo } from '../physics/character';
import type { GroundHit } from '../physics/world';
import { BAct, BState, BotKind, BotState, PowAct } from '../protocol';
import type { Bot } from './bots';
import type { Fight, Fighter } from './fight';
import { stompRing } from './warden';

const gh: GroundHit = { top: 0, c: null };
const tmp: Vec3 = { x: 0, y: 0, z: 0 };
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Where each clone keeps to at its owner's side (angle from the owner's facing). */
const SLOTS = [-2.1, 2.1, -2.75, 2.75];

export class Clone {
  readonly body: CharBody = makeBody(PLAYER.RADIUS, PLAYER.HEIGHT);
  readonly isClone = true;
  hp: number = POW.clone.HP;
  yaw = 0;
  anim: number = Anim.Idle;
  dead = false;
  /** Rallied at something by its owner until this time (a bot, or a part of the Warden). */
  rallyUntil = 0;
  rallyBot = 0;
  rallyPart = -1;
  private bot: Bot | null = null;
  private part = -1;
  private retargetAt = 0;
  private strikeReady: number;
  private strikeAt = -9;
  private stuckFor = 0;
  private stunUntil = 0;
  private lastDist = 0;
  private readonly info: StepInfo = { landed: false, impact: 0, wall: null, dynamicHit: null };

  constructor(readonly id: number, readonly owner: Fighter, readonly slot: number, x: number, y: number, z: number, t: number) {
    this.body.pos.x = x; this.body.pos.y = y; this.body.pos.z = z;
    this.yaw = owner.p.yaw;
    this.strikeReady = t + 0.4;
  }

  get pos() { return this.body.pos; }
  get vel() { return this.body.vel; }
  /** Clones never slide (the beam's height test). */
  get low() { return false; }

  /** Standing on the Warden's back (its hull shock throws it off). */
  riding(f: Fight) { const g = this.body.ground; return !!g && (g.id === f.arena.hull || g.id === f.arena.head); }

  /** Hit by something: `n` damage, shoved by `knock`. */
  hurt(f: Fight, n: number, knock: Vec3) {
    if (this.dead) return;
    this.hp -= n;
    const b = this.body;
    b.vel.x += knock.x; b.vel.z += knock.z;
    if (knock.y > 0) { b.vel.y = Math.max(b.vel.y, knock.y); b.grounded = false; b.ground = null; }
    this.stunUntil = f.time + 0.35;
    if (this.hp <= 0) f.killClone(this);
  }

  /** Where its slot at its owner's side is. */
  private slotPoint(out: Vec3): Vec3 {
    const o = this.owner.p;
    const a = o.yaw + SLOTS[this.slot % SLOTS.length];
    out.x = o.pos.x + Math.sin(a) * POW.clone.SLOT_R;
    out.y = o.pos.y;
    out.z = o.pos.z + Math.cos(a) * POW.clone.SLOT_R;
    return out;
  }

  /** Back at its owner's side at once (left behind, stuck, or off the floor). */
  regroup(f: Fight) {
    const from: [number, number, number] = [r2(this.pos.x), r2(this.pos.y), r2(this.pos.z)];
    const s = this.slotPoint(tmp);
    const o = this.owner.p.pos;
    // on floor next to the owner, or on the owner's own spot if its side is not free
    const gy = f.world.groundBelow(s.x, o.y + 1.5, s.z, 4);
    if (isFinite(gy) && f.world.isSpaceFree(s.x, o.y + 1.5 - gy + 0.05, s.z, PLAYER.RADIUS, PLAYER.HEIGHT)) { this.pos.x = s.x; this.pos.y = o.y + 1.5 - gy; this.pos.z = s.z; }
    else { this.pos.x = o.x; this.pos.y = o.y; this.pos.z = o.z; }
    const b = this.body;
    b.vel.x = b.vel.y = b.vel.z = 0; b.ext.x = b.ext.y = b.ext.z = 0;
    b.grounded = false; b.ground = null;
    this.stuckFor = 0;
    this.bot = null; this.part = -1;
    f.emit({ k: 'clone', id: this.id, owner: this.owner.id, s: 'back', p: [r2(this.pos.x), r2(this.pos.y), r2(this.pos.z)], q: from });
  }

  /** What to go for: the rally target, else the nearest bot it can reach, else the Warden's reachable parts. */
  private pickTarget(f: Fight) {
    const t = f.time, C = POW.clone, o = this.owner.p.pos, p = this.pos;
    if (t < this.retargetAt) return;
    this.retargetAt = t + 0.3;
    this.bot = null; this.part = -1;
    // rallied at a bot: that bot; rallied at the Warden: whatever of it they can reach, bots or not
    let wardenOnly = false;
    if (t < this.rallyUntil) {
      if (this.rallyBot) { this.bot = f.bots.find((x) => x.id === this.rallyBot && !x.dead) ?? null; if (this.bot) return; }
      wardenOnly = this.rallyPart >= 0;
    }
    let bd = Infinity;
    for (const bot of wardenOnly ? [] : f.bots) {
      if (bot.dead || bot.state === BotState.Flying || bot.state === BotState.Held) continue;
      const dy = bot.pos.y + (bot.kind === BotKind.Skitter ? 0.5 : 0) - (p.y + 1.25);
      if (dy > C.REACH + 0.6 || dy < -3) continue;
      if (Math.hypot(bot.pos.x - o.x, bot.pos.z - o.z) > C.TARGET_RANGE) continue;
      const d = Math.hypot(bot.pos.x - p.x, bot.pos.z - p.z);
      if (d < bd) { bd = d; this.bot = bot; }
    }
    if (this.bot) return;
    const w = f.warden;
    if (!w.alive || !w.awake) return;
    let pd = Infinity;
    for (const s of w.partsAt(f, t)) {
      // only what it can reach from the floor it stands on
      if (s.y - s.r - (p.y + 1.25) > C.REACH - 0.4) continue;
      if (Math.hypot(s.x - o.x, s.z - o.z) > (wardenOnly ? C.RALLY_RANGE : C.TARGET_RANGE + 4)) continue;
      const d = Math.hypot(s.x - p.x, s.z - p.z) - s.r;
      if (d < pd) { pd = d; this.part = s.part; }
    }
  }

  /** The target's centre (and its radius) right now, or false. */
  private targetPoint(f: Fight, out: Vec3): number {
    if (this.bot) {
      if (this.bot.dead) { this.bot = null; return -1; }
      this.bot.centre(out);
      return this.bot.radius;
    }
    if (this.part >= 0 && f.warden.alive) {
      // the nearest sphere of that part
      let best = -1, bd = Infinity;
      for (const s of f.warden.partsAt(f, f.time)) {
        if (s.part !== this.part) continue;
        const d = Math.hypot(s.x - this.pos.x, s.y - (this.pos.y + 1.25), s.z - this.pos.z) - s.r;
        if (d < bd) { bd = d; out.x = s.x; out.y = s.y; out.z = s.z; best = s.r; }
      }
      return best;
    }
    return -1;
  }

  update(dt: number, f: Fight) {
    if (this.dead) return;
    const C = POW.clone, t = f.time, b = this.body, p = this.pos, w = f.world;
    const owner = this.owner.p;
    const rallied = t < this.rallyUntil;
    const leash = rallied ? C.RALLY_RANGE : C.LEASH;
    const odx = owner.pos.x - p.x, odz = owner.pos.z - p.z, od = Math.hypot(odx, odz), ody = owner.pos.y - p.y;
    // left too far behind, stuck, or off the floor: it steps out beside its owner again
    if (od > C.REGROUP || p.y < f.killY + 20) { this.regroup(f); return; }
    this.pickTarget(f);
    const tp = { x: 0, y: 0, z: 0 };
    let tr = this.targetPoint(f, tp);
    // never chase past the leash
    if (tr >= 0 && Math.hypot(tp.x - owner.pos.x, tp.z - owner.pos.z) > leash + 3) { this.bot = null; this.part = -1; tr = -1; }
    let gx: number, gz: number, gy: number, speed = C.SPEED;
    if (tr >= 0 && od <= leash) {
      // to striking distance of the target
      const dx = tp.x - p.x, dz = tp.z - p.z, d = Math.hypot(dx, dz) || 1;
      const keep = Math.max(0.6, tr + C.REACH * 0.55);
      gx = tp.x - (dx / d) * keep; gz = tp.z - (dz / d) * keep; gy = tp.y;
      if (d > keep + 6) speed *= 1.15;
    } else {
      const s = this.slotPoint(tmp);
      gx = s.x; gz = s.z; gy = s.y;
      if (od > leash) speed *= 1.25;
    }
    // stuck: far from where it wants to be and not getting closer
    const gd = Math.hypot(gx - p.x, gz - p.z);
    const away = od > leash + 2 || Math.abs(ody) > 3.5;
    if (away && od >= this.lastDist - 0.02 * dt * 60) this.stuckFor += dt; else this.stuckFor = Math.max(0, this.stuckFor - dt);
    this.lastDist = od;
    if (this.stuckFor > C.STUCK) { this.regroup(f); return; }
    // steer, not off an edge into nothing
    let mx = 0, mz = 0;
    if (gd > 0.25) { mx = (gx - p.x) / gd; mz = (gz - p.z) / gd; }
    const want = speed * clamp(gd / 1.5, 0, 1);
    if (b.grounded && (mx || mz)) {
      w.groundProbe(p.x + mx * 1.1, p.z + mz * 1.1, 0.25, p.y + 0.6, gh);
      if (!gh.c || gh.top < p.y - 5.5) { mx = 0; mz = 0; }
    }
    const stunned = t < this.stunUntil;
    const tvx = mx * want, tvz = mz * want;
    const acc = (b.grounded ? C.ACCEL : C.ACCEL * 0.25) * dt;
    if (!stunned) {
      const ex = tvx - b.vel.x, ez = tvz - b.vel.z, el = Math.hypot(ex, ez);
      const k = el > acc ? acc / el : 1;
      b.vel.x += ex * k; b.vel.z += ez * k;
    } else if (b.grounded) { b.vel.x *= Math.max(0, 1 - 6 * dt); b.vel.z *= Math.max(0, 1 - 6 * dt); }
    // jumps: a stomp's wave about to reach it, a wall in the way, or a step up to where it is going
    let jump = false;
    if (b.grounded && !stunned) {
      const W = f.warden;
      if (W.state === BState.Act && W.act === BAct.Stomp && W.actD.length >= 3 && t >= W.actD[2]) {
        const r = stompRing(W.actD, t);
        const pd = Math.hypot(p.x - W.actD[0], p.z - W.actD[1]);
        if (r >= 0 && pd - r > 0 && pd - r < BOSS.STOMP.SPEED * 0.22 && p.y - ARENA.y < 1) jump = true;
      }
      if (this.info.wall && (mx || mz)) jump = true;
      if (gy - p.y > 0.9 && gd < 5) jump = true;
    }
    if (jump) { b.vel.y = PLAYER.JUMP_VELOCITY; b.grounded = false; b.ground = null; }
    b.vel.y = Math.max(b.vel.y - PHYS.GRAVITY * (b.vel.y < 0 ? PHYS.FALL_GRAVITY_MULT : 1) * dt, -PHYS.MAX_FALL_SPEED);
    stepBody(w, b, dt, jump, this.info);
    // strike what is in reach
    if (tr >= 0 && !stunned && t >= this.strikeReady) {
      const dist = Math.hypot(tp.x - p.x, tp.y - (p.y + 1.25), tp.z - p.z) - tr;
      if (dist <= C.REACH) this.strike(f, tp, rallied);
    }
    // facing and the pose the clients draw
    const hs = Math.hypot(b.vel.x, b.vel.z);
    if (t - this.strikeAt < 0.3 && tr >= 0) this.yaw = Math.atan2(tp.x - p.x, tp.z - p.z);
    else if (hs > 0.8) this.yaw += wrapAngle(Math.atan2(b.vel.x, b.vel.z) - this.yaw) * Math.min(1, dt * 10);
    else this.yaw += wrapAngle(owner.yaw - this.yaw) * Math.min(1, dt * 3);
    if (t - this.strikeAt < 0.2) this.anim = Anim.Lunge;
    else if (!b.grounded) this.anim = b.vel.y > 0 ? Anim.Jump : Anim.Fall;
    else this.anim = hs > 7.5 ? Anim.Sprint : hs > 0.6 ? Anim.Run : Anim.Idle;
  }

  private strike(f: Fight, at: Vec3, rallied: boolean) {
    const C = POW.clone, t = f.time, k = rallied ? C.RALLY_K : 1;
    this.strikeReady = t + C.STRIKE_COOLDOWN * (0.85 + f.rand() * 0.3);
    this.strikeAt = t;
    const p = this.pos;
    const dx = at.x - p.x, dz = at.z - p.z, d = Math.hypot(dx, dz) || 1;
    if (this.bot) f.hitBot(this.bot, C.BOT_DAMAGE * k, this.owner, (dx / d) * C.KNOCK, 3, (dz / d) * C.KNOCK, 0.5);
    else if (this.part >= 0) f.hitWarden(this.owner, C.DAMAGE * k, this.part, { x: at.x, y: at.y, z: at.z }, C.POISE * k);
    f.emit({ k: 'fx', id: this.owner.id, f: PowAct.CloneHit, d: [this.id, r2(at.x), r2(at.y), r2(at.z), rallied ? 1 : 0] });
  }
}

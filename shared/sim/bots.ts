// What moves in the Warden's arena besides the runners and the Warden itself:
// the bots it launches from its hive (skitters on the ground, wasps in the air),
// the loose things lying about (explosive canisters, the armour plates it sheds,
// the mortar shells it fires), the orbs wasps shoot, and the gravity wells one
// of the powers opens. All of it is physical: knocked about by hits, thrown by
// telekinesis, pulled into wells, carried on the Warden's back, lost over the
// edge. The fight (fight.ts) owns them and decides who hurts whom.

import { ARENA, BOT, JUNK, PHYS, POW } from '../constants';
import { clamp, damp, v3, type Vec3 } from '../math';
import { makeBody, stepBody, stepCorpse, type CharBody, type StepInfo } from '../physics/character';
import type { GroundHit, RayHit } from '../physics/world';
import { BotKind, BotState, JunkKind } from '../protocol';
import type { Fight, Fighter, Victim } from './fight';

const gh: GroundHit = { top: 0, c: null };
const ray: RayHit = { dist: 0, c: null };
const tmp = v3();

/** How high a thing hovers in front of the runner holding it with telekinesis. */
export const HOLD_AHEAD = 1.9;
export const HOLD_UP = 2.5;
/** Mortar shells fall more gently than runners do, so their arcs read from the ground. */
export const SHELL_G = 22;

/** Somewhere a thing held with telekinesis floats: ahead of the runner and above its head. */
export function holdPoint(q: Fighter, out: Vec3): Vec3 {
  const p = q.p;
  out.x = p.pos.x + Math.sin(p.yaw) * HOLD_AHEAD;
  out.y = p.pos.y + HOLD_UP;
  out.z = p.pos.z + Math.cos(p.yaw) * HOLD_AHEAD;
  return out;
}

// ------------------------------------------------------------------ bots

export class Bot {
  readonly body: CharBody;
  /** Wasps fly: they keep their own velocity (skitters use the body's). */
  readonly vel = v3();
  yaw = 0;
  hp: number;
  readonly maxHp: number;
  state: BotState = BotState.Flying;
  stateT = 0;
  /** Who it is after: a runner, or one of a runner's clones. */
  target: Victim | null = null;
  heldBy: Fighter | null = null;
  /** Thrown or batted by a runner: it hurts whatever it slams into, and whoever threw it gets the credit. */
  thrownBy: Fighter | null = null;
  lastHitBy: Fighter | null = null;
  /** Damage owed to it by the heart of a gravity well (dealt a few points at a time). */
  crushed = 0;
  private stunUntil = 0;
  private ready = 0;
  private pounceReady = 0;
  private readonly from = v3();
  private readonly to = v3();
  private flight = 1;
  private launchedAt = 0;
  private readonly lunge = v3();
  private orbit: number;
  private keep: number;
  private hover: number;
  private readonly info: StepInfo = { landed: false, impact: 0, wall: null, dynamicHit: null };
  dead = false;

  constructor(readonly id: number, readonly kind: BotKind, from: Vec3, to: Vec3, flight: number, t: number, rand: () => number) {
    const S = kind === BotKind.Skitter ? BOT.skitter : BOT.wasp;
    this.hp = this.maxHp = S.HP;
    this.body = kind === BotKind.Skitter ? makeBody(BOT.skitter.RADIUS, BOT.skitter.HEIGHT) : makeBody(BOT.wasp.RADIUS, 0.8);
    this.body.pos.x = from.x; this.body.pos.y = from.y; this.body.pos.z = from.z;
    this.from.x = from.x; this.from.y = from.y; this.from.z = from.z;
    this.to.x = to.x; this.to.y = to.y; this.to.z = to.z;
    this.flight = flight;
    this.launchedAt = t;
    this.orbit = rand() * Math.PI * 2;
    this.keep = BOT.wasp.KEEP[0] + rand() * (BOT.wasp.KEEP[1] - BOT.wasp.KEEP[0]);
    this.hover = BOT.wasp.HOVER[0] + rand() * (BOT.wasp.HOVER[1] - BOT.wasp.HOVER[0]);
    this.ready = t + 1 + rand();
  }

  get pos() { return this.body.pos; }
  get radius() { return this.body.radius; }
  /** Centre of its body (what powers aim at). */
  centre(out: Vec3): Vec3 { out.x = this.pos.x; out.y = this.pos.y + (this.kind === BotKind.Skitter ? 0.5 : 0); out.z = this.pos.z; return out; }
  /** Its velocity, whichever way it moves. */
  get v(): Vec3 { return this.kind === BotKind.Skitter ? this.body.vel : this.vel; }

  private set(s: BotState) { this.state = s; this.stateT = 0; }

  /** Shoved by a hit: knocked along (x, y, z), reeling for `stun` seconds. */
  knock(f: Fight, x: number, y: number, z: number, stun: number) {
    if (this.state === BotState.Flying || this.state === BotState.Held) return;
    const v = this.v;
    v.x += x; v.y += y; v.z += z;
    if (this.kind === BotKind.Skitter && y > 0) { this.body.grounded = false; this.body.ground = null; }
    this.stunUntil = Math.max(this.stunUntil, f.time + stun);
    this.set(BotState.Reel);
  }

  /** Let go of by telekinesis: thrown along (x, y, z), or just dropped. */
  release(vx: number, vy: number, vz: number, by: Fighter | null, f: Fight) {
    this.heldBy = null;
    const v = this.v;
    v.x = vx; v.y = vy; v.z = vz;
    this.body.grounded = false; this.body.ground = null;
    this.thrownBy = by;
    this.stunUntil = f.time + 1.2;
    this.set(BotState.Reel);
  }

  update(dt: number, f: Fight) {
    const t = f.time;
    this.stateT += dt;
    if (this.state === BotState.Flying) { this.fly(t, f); return; }
    if (this.state === BotState.Held) {
      if (!this.heldBy) { this.set(BotState.Reel); return; }
      holdPoint(this.heldBy, tmp);
      const p = this.pos;
      p.x += (tmp.x - p.x) * damp(14, dt); p.y += (tmp.y - p.y) * damp(14, dt); p.z += (tmp.z - p.z) * damp(14, dt);
      this.v.x = this.v.y = this.v.z = 0;
      this.yaw += dt * 6;
      return;
    }
    if (this.kind === BotKind.Skitter) this.skitter(dt, f); else this.wasp(dt, f);
    if (this.pos.y < f.killY) f.killBot(this, this.lastHitBy);
  }

  /** Out of the hive: a thrown arc to where it lands (wasps level off where they will hover). */
  private fly(t: number, f: Fight) {
    const u = clamp((t - this.launchedAt) / this.flight, 0, 1);
    const p = this.pos, a = this.from, b = this.to;
    const arc = this.kind === BotKind.Skitter ? 6 : 2.5;
    p.x = a.x + (b.x - a.x) * u;
    p.z = a.z + (b.z - a.z) * u;
    p.y = a.y + (b.y - a.y) * u + arc * 4 * u * (1 - u);
    this.yaw = Math.atan2(b.x - a.x, b.z - a.z);
    if (u >= 1) {
      this.v.x = this.v.y = this.v.z = 0;
      this.body.grounded = false;
      this.set(this.kind === BotKind.Skitter ? BotState.Boot : BotState.Hunt);
      f.botLanded(this);
    }
  }

  /** The nearest runner (or clone) it can get at (skitters cannot reach the pillar tops or the perches). */
  private pick(f: Fight) {
    if (this.target && f.canHit(this.target) && this.stateT < 2.5 && this.state !== BotState.Hunt) return;
    let best: Victim | null = null, bd = Infinity;
    for (const q of f.victims()) {
      const dy = q.pos.y - this.pos.y;
      let d = Math.hypot(q.pos.x - this.pos.x, q.pos.z - this.pos.z) + Math.abs(dy) * 1.5;
      if (this.kind === BotKind.Skitter && dy > BOT.skitter.POUNCE) d += 60;
      if (q === this.target) d -= 4;
      if (d < bd) { bd = d; best = q; }
    }
    this.target = best;
  }

  // ------------------------------------------------------------------ skitter

  private skitter(dt: number, f: Fight) {
    const S = BOT.skitter, t = f.time, b = this.body, w = f.world;
    const stunned = t < this.stunUntil;
    let dirX = 0, dirZ = 0, speed = 0, jumped = false;
    if (!stunned) {
      if (this.state === BotState.Reel) this.set(BotState.Hunt);
      this.pick(f);
      const T = this.target;
      switch (this.state) {
        case BotState.Boot:
          if (this.stateT > 0.5) this.set(BotState.Hunt);
          break;
        case BotState.Hunt: {
          if (!T) break;
          const dx = T.pos.x - this.pos.x, dz = T.pos.z - this.pos.z, d = Math.hypot(dx, dz) || 1;
          const dy = T.pos.y - this.pos.y;
          dirX = dx / d; dirZ = dz / d; speed = S.SPEED * f.botSpeedK;
          if (d < S.REACH && Math.abs(dy) < 1.6) { this.set(BotState.Tell); speed = 0; break; }
          // up (or down, across the moat) to a runner on another level: a pounce
          if (b.grounded && t >= this.pounceReady && Math.abs(dy) > 1.5 && dy < S.POUNCE && d < 16) {
            if (this.pounce(f, T)) { jumped = true; break; }
          }
          break;
        }
        case BotState.Tell:
          // rears up, clicks, eye flaring: then it lunges at where you are now
          if (T) this.yaw = Math.atan2(T.pos.x - this.pos.x, T.pos.z - this.pos.z);
          if (this.stateT >= S.TELL * f.tellK) {
            this.lunge.x = Math.sin(this.yaw); this.lunge.z = Math.cos(this.yaw);
            this.set(BotState.Strike);
          }
          break;
        case BotState.Strike:
          b.vel.x = this.lunge.x * S.LUNGE; b.vel.z = this.lunge.z * S.LUNGE;
          if (T && f.canHit(T)) {
            const dx = T.pos.x - this.pos.x, dz = T.pos.z - this.pos.z, dy = T.pos.y + 0.6 - this.pos.y;
            if (Math.hypot(dx, dz) < S.BITE && dy > -1 && dy < 2) {
              const d = Math.hypot(dx, dz) || 1;
              f.hurtVictim(T, S.DAMAGE, 'bite', this.pos, { x: (dx / d) * S.KNOCK, y: 3, z: (dz / d) * S.KNOCK });
              this.set(BotState.Rest);
              break;
            }
          }
          if (this.stateT > S.LUNGE_TIME) this.set(BotState.Rest);
          break;
        case BotState.Rest:
          if (this.stateT > S.REST) this.set(BotState.Hunt);
          break;
      }
    }
    // steering with an eye on the edge: it will not walk off into the moat
    if (b.grounded && !jumped && (dirX !== 0 || dirZ !== 0)) {
      w.groundProbe(this.pos.x + dirX * 1.0, this.pos.z + dirZ * 1.0, 0.25, this.pos.y + 0.5, gh);
      if (!gh.c || gh.top < this.pos.y - 1.6) { dirX = 0; dirZ = 0; }
    }
    if (b.grounded && !jumped && this.state !== BotState.Strike && !stunned) {
      const tx = dirX * speed, tz = dirZ * speed;
      const k = Math.min(1, S.ACCEL * dt / Math.max(0.001, Math.hypot(tx - b.vel.x, tz - b.vel.z)));
      b.vel.x += (tx - b.vel.x) * k; b.vel.z += (tz - b.vel.z) * k;
    } else if (b.grounded && stunned) {
      const k = Math.max(0, 1 - 7 * dt);
      b.vel.x *= k; b.vel.z *= k;
    }
    const vx0 = b.vel.x, vz0 = b.vel.z, fast = Math.hypot(vx0, b.vel.y, vz0);
    b.vel.y = Math.max(b.vel.y - PHYS.GRAVITY * dt, -PHYS.MAX_FALL_SPEED);
    const sub = Math.max(1, Math.ceil(fast * dt / 0.35));
    for (let i = 0; i < sub; i++) {
      stepBody(w, b, dt / sub, jumped && i === 0, this.info);
      this.slam(f, fast, this.info.wall !== null || (this.info.landed && this.info.impact > BOT.IMPACT_SPEED));
    }
    if (Math.hypot(b.vel.x, b.vel.z) > 0.5 && this.state !== BotState.Tell) this.yaw = Math.atan2(b.vel.x, b.vel.z);
    if (this.thrownBy && b.grounded && Math.hypot(b.vel.x, b.vel.z) < 4) this.thrownBy = null;
  }

  /** A leap onto the target's level: a ballistic arc that comes down a step short of them. */
  private pounce(f: Fight, T: Victim): boolean {
    const b = this.body, S = BOT.skitter;
    const dx = T.pos.x - this.pos.x, dz = T.pos.z - this.pos.z, d = Math.hypot(dx, dz) || 1;
    const lx = T.pos.x - (dx / d) * 1.4, lz = T.pos.z - (dz / d) * 1.4;
    f.world.groundProbe(lx, lz, 0.3, T.pos.y + 0.6, gh);
    if (!gh.c || Math.abs(gh.top - T.pos.y) > 1.2) return false;
    const y0 = this.pos.y, y1 = gh.top, apex = Math.max(y0, y1) + 1.6, g = PHYS.GRAVITY;
    const vy = Math.sqrt(2 * g * (apex - y0));
    const T1 = vy / g + Math.sqrt((2 * (apex - y1)) / (g * PHYS.FALL_GRAVITY_MULT));
    const hd = Math.hypot(lx - this.pos.x, lz - this.pos.z);
    if (hd / T1 > 16) return false;
    b.vel.x = (lx - this.pos.x) / T1; b.vel.z = (lz - this.pos.z) / T1; b.vel.y = vy;
    b.grounded = false; b.ground = null;
    this.pounceReady = f.time + S.POUNCE_COOLDOWN;
    this.yaw = Math.atan2(dx, dz);
    return true;
  }

  /** Slammed into something while flying about: it hurts, and it hurts more the faster it was going. */
  private slam(f: Fight, speed: number, hit: boolean) {
    if (!hit || speed < BOT.IMPACT_SPEED) return;
    const n = (speed - BOT.IMPACT_SPEED) * BOT.IMPACT_DAMAGE;
    if (this.info.dynamicHit?.kind === 'puppet' || this.info.wall?.kind === 'puppet') f.thrownIntoWarden(this.thrownBy, this.pos, POW.telekinesis.BOT_HIT * clamp(speed / POW.telekinesis.THROW_SPEED, 0.4, 1));
    f.hitBot(this, n, this.thrownBy ?? this.lastHitBy, 0, 0, 0, 0);
    // it loses most of its speed in the crash
    const v = this.v;
    v.x *= 0.3; v.z *= 0.3;
    if (this.thrownBy) this.thrownBy = null;
  }

  // ------------------------------------------------------------------ wasp

  private wasp(dt: number, f: Fight) {
    const S = BOT.wasp, t = f.time, v = this.vel, p = this.pos;
    const stunned = t < this.stunUntil;
    let gx = p.x, gy = p.y, gz = p.z, speed = S.SPEED * f.botSpeedK;
    if (!stunned) {
      if (this.state === BotState.Reel) this.set(BotState.Hunt);
      this.pick(f);
      const T = this.target;
      if (T) {
        // circle the target at a distance, above it, and shoot when it is in sight
        this.orbit += dt * 0.35;
        gx = T.pos.x + Math.sin(this.orbit) * this.keep;
        gz = T.pos.z + Math.cos(this.orbit) * this.keep;
        gy = Math.max(T.pos.y, ARENA.y) + this.hover;
        const dx = T.pos.x - p.x, dz = T.pos.z - p.z;
        this.yaw = Math.atan2(dx, dz);
        if (this.state === BotState.Hunt && t >= this.ready && Math.hypot(dx, dz) < 34 && f.botSees(this, T)) this.set(BotState.Tell);
        if (this.state === BotState.Tell) {
          speed *= 0.25;
          if (this.stateT >= S.TELL * f.tellK) {
            f.fireOrb(this, T);
            this.ready = t + S.COOLDOWN * (0.85 + f.rand() * 0.35);
            this.set(BotState.Rest);
          }
        } else if (this.state === BotState.Rest && this.stateT > 0.6) this.set(BotState.Hunt);
      }
    }
    // steer (a knocked wasp drifts until it rights itself; a thrown one flies where it was thrown)
    const dx = gx - p.x, dy = gy - p.y, dz = gz - p.z, d = Math.hypot(dx, dy, dz);
    if (stunned && this.thrownBy) {
      v.y -= PHYS.GRAVITY * 0.5 * dt;
    } else if (!stunned && d > 0.3) {
      const k = speed * clamp(d / 3, 0.2, 1) / d;
      const a = damp(S.ACCEL / Math.max(1, speed) * 1.2, dt);
      v.x += (dx * k - v.x) * a; v.y += (dy * k - v.y) * a; v.z += (dz * k - v.z) * a;
    } else {
      const a = damp(stunned ? 1.5 : 4, dt);
      v.x -= v.x * a; v.y -= v.y * a; v.z -= v.z * a;
    }
    const fast = Math.hypot(v.x, v.y, v.z);
    const sub = Math.max(1, Math.ceil(fast * dt / 0.4));
    for (let i = 0; i < sub; i++) {
      p.x += v.x * dt / sub; p.y += v.y * dt / sub; p.z += v.z * dt / sub;
      if (f.world.pushSphere(p, S.RADIUS) && fast > BOT.IMPACT_SPEED) {
        const n = (fast - BOT.IMPACT_SPEED) * BOT.IMPACT_DAMAGE;
        f.hitBot(this, n, this.thrownBy ?? this.lastHitBy, 0, 0, 0, 0);
        v.x *= 0.3; v.y *= 0.3; v.z *= 0.3;
        this.thrownBy = null;
        break;
      }
    }
    // it never sinks below the floor's height for long (it is not a skitter)
    if (!stunned && p.y < ARENA.y + 1.2) v.y += 12 * dt;
  }
}

// ------------------------------------------------------------------ loose things

export class Junk {
  readonly body: CharBody;
  heldBy: Fighter | null = null;
  /** Thrown or batted: it hurts what it hits, and it is the thrower's hit. */
  thrownBy: Fighter | null = null;
  /** A shell fired by the Warden (not yet caught): it explodes on anything. */
  hostile = false;
  spin = 0;
  dead = false;
  born: number;
  /** A slab of debris being heaved up by a kinetic runner: thrown at launchAt, along launchV. */
  launchAt = 0;
  readonly launchV = v3();
  /** Thrown debris: it breaks apart on the first thing it hits. */
  shatters = false;
  private flewAt = 0;
  private readonly info: StepInfo = { landed: false, impact: 0, wall: null, dynamicHit: null };

  constructor(readonly id: number, readonly kind: JunkKind, x: number, y: number, z: number, t: number, readonly stand = -1) {
    this.body = makeBody(kind === JunkKind.Shell ? 0.32 : JUNK.RADIUS, kind === JunkKind.Plate ? 0.5 : kind === JunkKind.Shell ? 0.6 : kind === JunkKind.Rock ? 0.8 : 1.1);
    this.body.pos.x = x; this.body.pos.y = y; this.body.pos.z = z;
    this.born = t;
  }

  get pos() { return this.body.pos; }
  get vel() { return this.body.vel; }
  centre(out: Vec3): Vec3 { out.x = this.pos.x; out.y = this.pos.y + this.body.height / 2; out.z = this.pos.z; return out; }

  /** Let go of by telekinesis (thrown along v, or dropped). */
  release(vx: number, vy: number, vz: number, by: Fighter | null) {
    this.heldBy = null;
    this.body.vel.x = vx; this.body.vel.y = vy; this.body.vel.z = vz;
    this.body.grounded = false; this.body.ground = null;
    this.thrownBy = by;
    this.hostile = false;
  }

  update(dt: number, f: Fight) {
    const b = this.body;
    // heaved up: now it is thrown
    if (this.heldBy && this.launchAt > 0 && f.time >= this.launchAt) {
      const by = this.heldBy;
      this.launchAt = 0;
      holdPoint(by, tmp);
      b.pos.x = tmp.x; b.pos.y = tmp.y - 0.4; b.pos.z = tmp.z;
      this.release(this.launchV.x, this.launchV.y, this.launchV.z, by);
      this.shatters = true;
      this.flewAt = f.time;
    }
    if (this.heldBy) {
      holdPoint(this.heldBy, tmp);
      b.pos.x += (tmp.x - b.pos.x) * damp(16, dt); b.pos.y += (tmp.y - 0.4 - b.pos.y) * damp(16, dt); b.pos.z += (tmp.z - b.pos.z) * damp(16, dt);
      b.vel.x = b.vel.y = b.vel.z = 0;
      this.spin += dt * 2.5;
      return;
    }
    if (this.hostile) { this.shell(dt, f); return; }
    const speed = Math.hypot(b.vel.x, b.vel.y, b.vel.z);
    const sub = Math.max(1, Math.ceil(speed * dt / 0.3));
    for (let i = 0; i < sub && !this.dead; i++) {
      const vx = b.vel.x, vy = b.vel.y, vz = b.vel.z;
      const pre = Math.hypot(vx, vy, vz);
      stepCorpse(f.world, b, dt / sub, this.info);
      const hitWall = this.info.wall !== null || this.info.dynamicHit !== null;
      const hitFloor = this.info.landed && this.info.impact > 3;
      if (pre > 1) this.spin += pre * dt / sub * 1.3;
      // something flying fast enough hurts what it hits: the Warden, a bot on its way
      if (pre > JUNK.HIT_SPEED * 0.5 && (this.thrownBy || this.kind === JunkKind.Shell)) {
        const bot = f.botAt(b.pos, b.radius + 0.25, null);
        if (bot) { f.junkHits(this, bot, pre); break; }
      }
      // thrown debris breaks on the Warden's legs and arms too (not all of it is solid)
      if (this.shatters && f.rockMeetsWarden(this)) { f.shatter(this); break; }
      if ((hitWall || hitFloor) && pre > 5) {
        const puppet = this.info.dynamicHit?.kind === 'puppet' || this.info.wall?.kind === 'puppet' || (this.info.landed && b.ground?.kind === 'puppet');
        f.junkImpact(this, pre, puppet);
      }
    }
    if (!this.dead && b.pos.y < f.killY) { this.dead = true; }
    // debris that found nothing to hit breaks where it stops (or after a few seconds in the air)
    if (!this.dead && this.shatters && ((b.grounded && Math.hypot(b.vel.x, b.vel.z) < 3) || f.time - this.flewAt > 3)) f.shatter(this);
    if (this.thrownBy && b.grounded && Math.hypot(b.vel.x, b.vel.z) < 3) this.thrownBy = null;
  }

  /** The Warden's shell in flight: a plain arc that goes off on the first thing it meets. */
  private shell(dt: number, f: Fight) {
    const b = this.body, v = b.vel;
    const sub = 3;
    for (let i = 0; i < sub; i++) {
      const h = dt / sub;
      v.y -= SHELL_G * h;
      const sp = Math.hypot(v.x, v.y, v.z) || 1;
      const len = sp * h;
      f.world.raycast(b.pos.x, b.pos.y + 0.3, b.pos.z, v.x / sp, v.y / sp, v.z / sp, len, false, ray);
      const go = ray.c ? ray.dist : len;
      b.pos.x += (v.x / sp) * go; b.pos.y += (v.y / sp) * go; b.pos.z += (v.z / sp) * go;
      this.spin += dt * 4;
      if (ray.c || f.shellTouches(this)) { f.explode(this, null); return; }
    }
    if (b.pos.y < f.killY) this.dead = true;
  }
}

// ------------------------------------------------------------------ wasp orbs

export class Orb {
  readonly pos = v3();
  readonly vel = v3();
  /** Turned round by telekinesis (or batted by a fist): now it hurts the enemy, not the runners. */
  turnedBy: Fighter | null = null;
  dead = false;
  constructor(readonly id: number, readonly owner: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, readonly born: number) {
    this.pos.x = x; this.pos.y = y; this.pos.z = z;
    this.vel.x = vx; this.vel.y = vy; this.vel.z = vz;
  }

  update(dt: number, f: Fight) {
    const sub = 3, h = dt / sub, R = BOT.wasp.SHOT_RADIUS;
    for (let i = 0; i < sub && !this.dead; i++) {
      const sp = Math.hypot(this.vel.x, this.vel.y, this.vel.z) || 1;
      const len = sp * h;
      f.world.raycast(this.pos.x, this.pos.y, this.pos.z, this.vel.x / sp, this.vel.y / sp, this.vel.z / sp, len, false, ray);
      const go = ray.c ? ray.dist : len;
      this.pos.x += (this.vel.x / sp) * go; this.pos.y += (this.vel.y / sp) * go; this.pos.z += (this.vel.z / sp) * go;
      if (this.turnedBy) {
        const bot = f.botAt(this.pos, R + 0.2, null);
        if (bot) { f.hitBot(bot, BOT.wasp.DAMAGE * 2, this.turnedBy, this.vel.x * 0.2, 2, this.vel.z * 0.2, 0.5); f.endOrb(this); return; }
        if (ray.c?.kind === 'puppet' || f.orbHitsWarden(this)) { f.endOrb(this); return; }
      } else {
        const q = f.victimAt(this.pos, R + 0.3);
        if (q) {
          f.hurtVictim(q, BOT.wasp.DAMAGE, 'sting', this.pos, { x: this.vel.x / sp * BOT.wasp.KNOCK, y: 1.5, z: this.vel.z / sp * BOT.wasp.KNOCK });
          f.endOrb(this);
          return;
        }
      }
      if (ray.c) { f.endOrb(this); return; }
    }
    if (f.time - this.born > 4) f.endOrb(this);
  }
}

// ------------------------------------------------------------------ gravity wells

export class Well {
  readonly pos = v3();
  readonly vel = v3();
  open = false;
  openedAt = 0;
  travelled = 0;
  /** Stuck to the Warden: where on it, in its own frame. */
  stuck: { x: number; y: number; z: number } | null = null;
  /** Damage owed to the Warden while it grinds on it (dealt a few points at a time). */
  grind = 0;
  dead = false;
  constructor(readonly id: number, readonly owner: Fighter, x: number, y: number, z: number, dx: number, dy: number, dz: number) {
    this.pos.x = x; this.pos.y = y; this.pos.z = z;
    this.vel.x = dx * POW.gravity.SPEED; this.vel.y = dy * POW.gravity.SPEED; this.vel.z = dz * POW.gravity.SPEED;
  }

  update(dt: number, f: Fight) {
    const G = POW.gravity;
    if (!this.open) {
      const sp = G.SPEED, len = sp * dt;
      f.world.raycast(this.pos.x, this.pos.y, this.pos.z, this.vel.x / sp, this.vel.y / sp, this.vel.z / sp, len, false, ray);
      const go = ray.c ? Math.max(0, ray.dist - 0.6) : len;
      this.pos.x += (this.vel.x / sp) * go; this.pos.y += (this.vel.y / sp) * go; this.pos.z += (this.vel.z / sp) * go;
      this.travelled += go;
      const onWarden = f.wellMeetsWarden(this);
      if (ray.c || onWarden || this.travelled >= G.RANGE || f.botAt(this.pos, 1.2, null)) f.openWell(this);
      return;
    }
    if (this.stuck) f.followWarden(this);
    f.pullWell(this, dt);
    if (f.time - this.openedAt >= G.LIFE) f.closeWell(this);
  }
}

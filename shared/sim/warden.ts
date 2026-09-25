// The Warden: the machine behind the beacon. A four-legged war machine as tall
// as a building that walks the Anvil, turns to face whoever worries it most, and
// picks its next attack from what the runners are actually doing -- who is close,
// who is high up, who is out of its sight, who is riding on its back, how many
// bots it has out -- weighed with a little chance so no two fights play alike.
// Nothing about it is scripted: it staggers when enough punishment breaks its
// balance or when a charge ends in a pillar, flinches when its eye is hit while
// it charges the beam, and goes into overdrive when its health runs low.
//
// Each ability is a tell (something to read) and then a hazard that is a pure
// function of the numbers in its 'act' event, so every client draws exactly the
// hazard the server is testing runners against.

import { ARENA, BOSS, BOT } from '../constants';
import { approachAngle, clamp, damp, lerp, wrapAngle, type Vec3 } from '../math';
import { BAct, BPart, BState } from '../protocol';
import type { Fight, Fighter } from './fight';

// ------------------------------------------------------------------ body plan

/**
 * The Warden's body in its own frame (x to its right, y up from the floor, z
 * forward), for a hull standing `lift` above the floor. Hit spheres are what
 * powers aim at and land on; the hull and head are also solid (puppet colliders).
 */
export interface PartSphere { part: number; x: number; y: number; z: number; r: number }

const LEGS: [number, number][] = [[1, 1], [-1, 1], [1, -1], [-1, -1]];

/** Local (x, y, z, r, part) of every hit sphere for a hull at `L`. */
function localParts(L: number): [number, number, number, number, number][] {
  const out: [number, number, number, number, number][] = [
    [0, L, -3, 2.3, BPart.Hull], [0, L, 0, 2.3, BPart.Hull], [0, L, 3, 2.3, BPart.Hull],
    [0, L + 1.9, -0.6, 1.5, BPart.Core],
    [0, L + 0.5, 5.4, 1.6, BPart.Head],
    [0, L + 0.5, 7.0, 0.8, BPart.Eye],
    [4.4, L + 0.2, 1.6, 1.1, BPart.Arm], [-4.4, L + 0.2, 1.6, 1.1, BPart.Arm],
  ];
  for (const [sx, sz] of LEGS) {
    out.push([6.3 * sx, L + 0.9, 5.0 * sz, 1.0, BPart.Leg]);
    out.push([7.0 * sx, L * 0.45, 5.8 * sz, 0.85, BPart.Leg]);
    out.push([7.4 * sx, 0.9, 6.3 * sz, 0.8, BPart.Leg]);
  }
  return out;
}
const PARTS_AT_LIFT = new Map<number, [number, number, number, number, number][]>();

/** Local point -> world, for the Warden at (x, z) turned to yaw. */
export function wardenPoint(x: number, floorY: number, z: number, yaw: number, lx: number, ly: number, lz: number, out: Vec3): Vec3 {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  out.x = x + lx * c + lz * s;
  out.y = floorY + ly;
  out.z = z - lx * s + lz * c;
  return out;
}

/** World-space hit spheres of the Warden standing at (x, z), turned to `yaw`, hull at `lift`. */
export function wardenParts(x: number, floorY: number, z: number, yaw: number, lift: number, out: PartSphere[]): PartSphere[] {
  const key = Math.round(lift * 20) / 20;
  let loc = PARTS_AT_LIFT.get(key);
  if (!loc) { loc = localParts(key); if (PARTS_AT_LIFT.size < 400) PARTS_AT_LIFT.set(key, loc); }
  const c = Math.cos(yaw), s = Math.sin(yaw);
  for (let i = 0; i < loc.length; i++) {
    const [lx, ly, lz, r, part] = loc[i];
    const o = out[i] ?? (out[i] = { part: 0, x: 0, y: 0, z: 0, r: 0 });
    o.part = part; o.r = r;
    o.x = x + lx * c + lz * s;
    o.y = floorY + ly;
    o.z = z - lx * s + lz * c;
  }
  out.length = loc.length;
  return out;
}

/** Where the eye is (the beam comes from it), the hive (bots come out of it) and the cannons' muzzles. */
export const EYE: [number, number, number] = [0, 0.5, 7.1];
export const HIVE: [number, number, number] = [0, 2.3, -3.2];
export const MUZZLE: [number, number, number] = [4.4, 0.35, 3.1];

/** How much of a hit on each part gets through (the core on its back is the weak point). */
export function partMult(part: number, staggered: boolean, eyeOpen: boolean): number {
  switch (part) {
    case BPart.Core: return staggered ? 2.5 : 2;
    case BPart.Eye: return (eyeOpen ? 2 : 1.5) * (staggered ? 1.5 : 1);
    case BPart.Head: return staggered ? 1.8 : 1.2;
    case BPart.Leg: return staggered ? 1.2 : 0.8;
    case BPart.Arm: return staggered ? 1.35 : 0.9;
    default: return staggered ? 1.5 : 1;
  }
}

// ------------------------------------------------------------------ the beam (shared with clients)

/**
 * The beam at match time `t` for an 'act' Beam event's numbers
 * d = [x, z, lift, yaw0, yaw1, pitch, t0, sweep, passes]: where it starts
 * (the eye) and which way it points. Returns false outside the sweep.
 */
export function beamAt(d: readonly number[], t: number, floorY: number, eye: Vec3, dir: Vec3): boolean {
  const [x, z, lift, yaw0, yaw1, pitch, t0, sweep, passes] = d;
  if (t < t0 || t > t0 + sweep * passes) return false;
  const u = (t - t0) / sweep;
  const k = Math.min(passes - 1, Math.floor(u));
  const f = clamp(u - k, 0, 1);
  const e = f * f * (3 - 2 * f);
  const yaw = k % 2 === 0 ? lerp(yaw0, yaw1, e) : lerp(yaw1, yaw0, e);
  wardenPoint(x, floorY, z, yaw, EYE[0], lift + EYE[1], EYE[2], eye);
  const cp = Math.cos(pitch);
  dir.x = Math.sin(yaw) * cp; dir.y = Math.sin(pitch); dir.z = Math.cos(yaw) * cp;
  return true;
}

/** The swipe's angle (world yaw of the arm) at time `t` for d = [yaw0, dir, t0, time], or NaN outside it. */
export function swipeAt(d: readonly number[], t: number): number {
  const [yaw0, dir, t0, time] = d;
  if (t < t0 || t > t0 + time) return NaN;
  const u = (t - t0) / time;
  return yaw0 - dir * 2.1 + dir * 4.2 * (u * u * (3 - 2 * u));
}

/** The stomp's ring radius at time `t` for d = [x, z, t0], or -1 when there is no ring. */
export function stompRing(d: readonly number[], t: number): number {
  const r = BOSS.STOMP.R0 + BOSS.STOMP.SPEED * (t - d[2]);
  return t < d[2] || r > BOSS.STOMP.R1 ? -1 : r;
}

// ------------------------------------------------------------------ the machine

const tmp: Vec3 = { x: 0, y: 0, z: 0 };
const eye: Vec3 = { x: 0, y: 0, z: 0 };
const dirV: Vec3 = { x: 0, y: 0, z: 0 };

interface PoseRec { t: number; x: number; z: number; yaw: number; lift: number }

export class Warden {
  x = ARENA.x;
  z = ARENA.z;
  /** Asleep facing the Threshold, where the team comes in. */
  yaw = Math.PI;
  lift = 3.4;
  state: BState = BState.Dormant;
  stateT = 0;
  hp: number;
  readonly maxHp: number;
  poise = 0;
  private poiseAt = -99;
  private immuneUntil = 0;
  overdrive = false;
  act: BAct = BAct.None;
  actAt = 0;
  /** The numbers the current ability was announced with (its hazard is a function of them). */
  actD: number[] = [];
  private readonly ready = new Map<BAct, number>();
  private lastAct: BAct = BAct.None;
  private recoverUntil = 0;
  private until = 0;
  target: Fighter | null = null;
  private retargetAt = 0;
  /** Damage each runner has done lately (it turns on whoever hurts it). */
  private readonly threat = new Map<number, number>();
  private eyeDamage = 0;
  /** Held down by a gravity well: moves this much slower until slowUntil. */
  private slowUntil = 0;
  /** Runners already hit by the current ability (each one only once). */
  private readonly struck = new Set<number>();
  /** Beam: when each runner was last burned (the beam hits again after a grace). */
  private readonly burned = new Map<number, number>();
  private shotsFired = 0;
  private launched = 0;
  private dyingAt = 0;
  /** Plates shed so far (one every 12% of health lost). */
  private shed = 0;
  /** Recent poses (hits from a client are judged where the Warden was on its screen). */
  private readonly hist: PoseRec[] = [];
  private readonly parts: PartSphere[] = [];
  private readonly prevSwipe = { a: NaN };

  constructor(players: number) {
    this.maxHp = Math.round(BOSS.HP * (1 + BOSS.HP_PER_PLAYER * Math.max(0, players - 1)));
    this.hp = this.maxHp;
  }

  get staggered() { return this.state === BState.Stagger; }
  get alive() { return this.state !== BState.Dying && this.state !== BState.Dead; }
  get awake() { return this.state !== BState.Dormant; }
  /** Its eye is open and charging the beam at time `t` (hits on it count double and can make it flinch). */
  eyeOpenAt(t: number) { return this.state === BState.Act && this.act === BAct.Beam && this.actD.length > 6 && t < this.actD[6]; }
  /** Cool-downs and tells shrink in overdrive. */
  private get odK() { return this.overdrive ? BOSS.OD_COOLDOWN : 1; }
  private get tellK() { return this.overdrive ? BOSS.OD_TELL : 1; }

  /** Hit spheres now (or as they were at time `t`, for hits judged on a client's screen). */
  partsAt(f: Fight, t = Infinity): PartSphere[] {
    let x = this.x, z = this.z, yaw = this.yaw, lift = this.lift;
    if (t < f.time && this.hist.length) {
      for (let i = this.hist.length - 1; i >= 0; i--) {
        const h = this.hist[i];
        if (h.t <= t) { x = h.x; z = h.z; yaw = h.yaw; lift = h.lift; break; }
        if (i === 0) { x = h.x; z = h.z; yaw = h.yaw; lift = h.lift; }
      }
    }
    return wardenParts(x, ARENA.y, z, yaw, lift, this.parts);
  }

  /** A world point on the Warden, in its own frame. */
  point(lx: number, ly: number, lz: number, out: Vec3): Vec3 {
    return wardenPoint(this.x, ARENA.y, this.z, this.yaw, lx, this.lift + ly, lz, out);
  }

  wake(f: Fight) {
    if (this.state !== BState.Dormant) return;
    this.setState(BState.Waking);
    // what it has ready first is down to chance (the first bots always come a little later)
    const t = f.time, r = () => f.rand();
    this.ready.set(BAct.Mortar, t + 2 + r() * 4);
    this.ready.set(BAct.Beam, t + 2 + r() * 4);
    this.ready.set(BAct.Stomp, t + 1 + r() * 3);
    this.ready.set(BAct.Deploy, t + BOSS.DEPLOY.FIRST + r() * 5);
    this.ready.set(BAct.Charge, t + 4 + r() * 5);
    f.emit({ k: 'wake' });
  }

  private setState(s: BState) {
    this.state = s;
    this.stateT = 0;
    if (s !== BState.Act) this.act = BAct.None;
  }

  // ------------------------------------------------------------------ damage

  /**
   * `n` damage (before the part's multiplier) and `poise` to part `part`. Returns
   * what got through. The runner that did it gets the Warden's attention.
   */
  damage(f: Fight, by: Fighter | null, n: number, part: number, poise: number): number {
    if (!this.alive || this.state === BState.Dormant && n <= 0) return 0;
    if (this.state === BState.Dormant) this.wake(f);
    const eyeOpen = this.eyeOpenAt(f.time);
    const dealt = Math.max(1, Math.round(n * partMult(part, this.staggered, eyeOpen)));
    this.hp = Math.max(0, this.hp - dealt);
    if (by) this.threat.set(by.id, (this.threat.get(by.id) ?? 0) + dealt);
    // its eye, hit hard while it charges the beam: it flinches and the beam never comes
    if (part === BPart.Eye && eyeOpen) {
      this.eyeDamage += dealt;
      if (this.eyeDamage >= BOSS.EYE_FLINCH) this.stagger(f, BOSS.FLINCH, 'eye');
    }
    if (poise > 0 && !this.staggered && f.time >= this.immuneUntil) {
      this.poise += poise * (part === BPart.Eye && eyeOpen ? 3 : 1);
      this.poiseAt = f.time;
      if (this.poise >= BOSS.POISE) this.stagger(f, BOSS.STAGGER, 'poise');
    }
    // armour plates come away as it takes punishment: something to throw back at it
    const lost = 1 - this.hp / this.maxHp;
    while (this.shed < Math.floor(lost / 0.12) && this.hp > 0) { this.shed++; f.shedPlate(this); }
    if (!this.overdrive && this.hp <= this.maxHp * BOSS.OVERDRIVE && this.hp > 0) {
      this.overdrive = true;
      f.emit({ k: 'overdrive' });
      // it throws off the runners on it and anyone at its feet, and sheds its outer plating
      f.shove(this.point(0, 0, 0, tmp), 12, 9, 7);
      for (let i = 0; i < 3; i++) f.shedPlate(this);
    }
    if (this.hp <= 0) this.die(f, by);
    return dealt;
  }

  /** Knocked off balance: down on its belly, the core exposed, every hit landing harder. */
  stagger(f: Fight, dur: number, why: 'poise' | 'crash' | 'eye') {
    if (!this.alive || this.state === BState.Dormant) return;
    this.setState(BState.Stagger);
    this.until = f.time + dur;
    this.poise = 0;
    this.eyeDamage = 0;
    this.immuneUntil = this.until + BOSS.STAGGER_IMMUNE;
    f.emit({ k: 'stagger', on: true, why });
  }

  /** A gravity well holding it down: it walks and turns this much slower for a moment. */
  slow(f: Fight) { this.slowUntil = f.time + 0.25; }

  private die(f: Fight, by: Fighter | null) {
    this.setState(BState.Dying);
    this.dyingAt = f.time;
    f.emit({ k: 'fall', by: by ? by.id : 0 });
    f.wardenDown();
  }

  /** How long ago it began dying (for the end of the fight). */
  dyingFor(t: number) { return this.state === BState.Dying || this.state === BState.Dead ? t - this.dyingAt : -1; }

  // ------------------------------------------------------------------ update

  update(dt: number, f: Fight) {
    const t = f.time;
    this.stateT += dt;
    // balance comes back if nothing has knocked it for a moment
    if (t - this.poiseAt > BOSS.POISE_DELAY) this.poise = Math.max(0, this.poise - BOSS.POISE_REGEN * dt);
    for (const [id, v] of this.threat) this.threat.set(id, v * Math.exp(-dt / 8));
    let wantLift = BOSS.LIFT, liftRate = 3;
    switch (this.state) {
      case BState.Dormant:
        wantLift = 3.4;
        break;
      case BState.Waking:
        // it rises onto its legs and looks round
        wantLift = BOSS.LIFT; liftRate = 1.6;
        if (this.stateT > 2.4) { this.setState(BState.Walk); this.recoverUntil = t + 0.4; }
        break;
      case BState.Walk:
        this.walk(dt, f, 1);
        if (t >= this.recoverUntil) this.decide(f);
        break;
      case BState.Recover:
        this.walk(dt, f, 0.55);
        if (t >= this.recoverUntil) this.setState(BState.Walk);
        break;
      case BState.Act:
        wantLift = this.runAct(dt, f);
        break;
      case BState.Stagger:
        wantLift = BOSS.LIFT_STAGGER; liftRate = 7;
        if (t >= this.until) {
          // back up with a heave that shoves everyone close away (no damage)
          this.setState(BState.Recover);
          this.recoverUntil = t + 1.1;
          f.emit({ k: 'stagger', on: false });
          f.shove(this.point(0, 0, 0, tmp), 9, 8, 5);
        }
        break;
      case BState.Dying:
        wantLift = BOSS.LIFT_DEAD; liftRate = 1.2;
        if (t - this.dyingAt > BOSS.DYING) this.setState(BState.Dead);
        break;
      case BState.Dead:
        wantLift = BOSS.LIFT_DEAD;
        break;
    }
    this.lift += (wantLift - this.lift) * damp(liftRate, dt);
    this.hist.push({ t, x: this.x, z: this.z, yaw: this.yaw, lift: this.lift });
    if (this.hist.length > 14) this.hist.shift();
  }

  // ------------------------------------------------------------------ moving

  private speedK(f: Fight) { return (this.overdrive ? BOSS.OD_SPEED : 1) * (f.time < this.slowUntil ? 0.5 : 1); }

  /** Who to face: whoever hurts it most, weighed against who is close, with a little chance. */
  private pickTarget(f: Fight) {
    if (f.time < this.retargetAt && this.target && f.targetable(this.target)) return;
    this.retargetAt = f.time + 1.6 + f.rand() * 0.8;
    let best: Fighter | null = null, bestS = -Infinity;
    for (const q of f.fighters) {
      if (!f.targetable(q)) continue;
      const d = Math.hypot(q.p.pos.x - this.x, q.p.pos.z - this.z);
      let s = 1 / (1 + d / 20) + (this.threat.get(q.id) ?? 0) * 0.012 + f.rand() * 0.3;
      if (q === this.target) s += 0.35;
      if (s > bestS) { bestS = s; best = q; }
    }
    this.target = best;
  }

  /** Walks to a good distance from its target (or to the edge of the floor nearest a target up on the rampart), keeping clear of the pillars. */
  private walk(dt: number, f: Fight, k: number) {
    this.pickTarget(f);
    const T = this.target;
    const cx = ARENA.x, cz = ARENA.z;
    let gx = this.x, gz = this.z;
    if (T) {
      const tx = T.p.pos.x, tz = T.p.pos.z;
      const dx = tx - this.x, dz = tz - this.z, d = Math.hypot(dx, dz) || 1;
      const fromC = Math.hypot(tx - cx, tz - cz);
      if (fromC > BOSS.ROAM + 4) {
        // they are up on the rampart or beyond: come to the edge of the floor below them
        gx = cx + ((tx - cx) / fromC) * BOSS.ROAM; gz = cz + ((tz - cz) / fromC) * BOSS.ROAM;
      } else {
        const keep = 12 + Math.sin(f.time * 0.3 + this.hp) * 3;
        gx = tx - (dx / d) * keep; gz = tz - (dz / d) * keep;
      }
      this.yaw = approachAngle(this.yaw, Math.atan2(dx, dz), BOSS.TURN * this.speedK(f) * dt);
    }
    // step toward the goal, slower while turning hard
    const dx = gx - this.x, dz = gz - this.z, d = Math.hypot(dx, dz);
    if (d > 0.6) {
      const facing = Math.cos(wrapAngle(Math.atan2(dx, dz) - this.yaw));
      const sp = BOSS.WALK * this.speedK(f) * k * (0.55 + 0.45 * Math.max(0, facing));
      const s = Math.min(d, sp * dt);
      this.x += (dx / d) * s; this.z += (dz / d) * s;
    }
    this.keepOnFloor(f);
  }

  /** Stays inside the floor and off the pillars. */
  private keepOnFloor(f: Fight) {
    for (const p of f.arena.pillars) {
      const dx = this.x - p[0], dz = this.z - p[2], d = Math.hypot(dx, dz);
      if (d < BOSS.PILLAR_CLEAR && d > 1e-3) { this.x = p[0] + (dx / d) * BOSS.PILLAR_CLEAR; this.z = p[2] + (dz / d) * BOSS.PILLAR_CLEAR; }
    }
    const dx = this.x - ARENA.x, dz = this.z - ARENA.z, d = Math.hypot(dx, dz);
    if (d > BOSS.ROAM) { this.x = ARENA.x + (dx / d) * BOSS.ROAM; this.z = ARENA.z + (dz / d) * BOSS.ROAM; }
  }

  // ------------------------------------------------------------------ choosing

  /**
   * Weighs every ability it could use right now against the situation, with a
   * little chance and a penalty for repeating itself, and starts the best one.
   */
  private decide(f: Fight) {
    const t = f.time;
    this.pickTarget(f);
    const T = this.target;
    if (!T) return;
    const floorY = ARENA.y;
    let near = 0, mid = 0, riders = 0, elevated = 0, hidden = 0, count = 0;
    for (const q of f.fighters) {
      if (!f.targetable(q)) continue;
      count++;
      const dx = q.p.pos.x - this.x, dz = q.p.pos.z - this.z, d = Math.hypot(dx, dz);
      const h = q.p.pos.y - floorY;
      if (q.rideT >= BOSS.SHOCK.RIDE) riders++;
      else if (d < BOSS.STOMP.RANGE && h < 1.5) near++;
      else if (d < BOSS.SWIPE.R1 - 1 && h > BOSS.SWIPE.Y0 && h < BOSS.SWIPE.Y1) mid++;
      if (h > 3) elevated++;
      if (!this.sees(f, q)) hidden++;
    }
    const tDist = Math.hypot(T.p.pos.x - this.x, T.p.pos.z - this.z);
    const tH = T.p.pos.y - floorY;
    const tSeen = this.sees(f, T);
    const bots = f.bots.length, cap = f.botCap();
    const score = new Map<BAct, number>();
    if (riders) score.set(BAct.Shock, 9);
    if (near) score.set(BAct.Stomp, 3 + near);
    if (mid) score.set(BAct.Swipe, 3.5 + mid);
    if (tSeen && tDist >= BOSS.BEAM.MIN && tDist <= BOSS.BEAM.MAX && T.rideT <= 0) score.set(BAct.Beam, 2.4 + (tH > 3 ? 0.8 : 0) + (tDist > 22 ? 0.6 : 0));
    score.set(BAct.Mortar, 1.8 + elevated * 0.6 + hidden * 0.9 + (tDist > 25 ? 0.8 : 0));
    if (bots < cap) score.set(BAct.Deploy, 1.4 + (cap - bots) * 0.7 + (count > 1 ? 0.4 : 0));
    if (tH < 1.5 && tDist > BOSS.CHARGE.MIN && T.rideT <= 0) score.set(BAct.Charge, 2.3 + (tDist > 26 ? 0.9 : 0));
    let best: BAct = BAct.None, bestS = 0;
    for (const [a, base] of score) {
      if ((this.ready.get(a) ?? 0) > t) continue;
      let s = base * (0.75 + f.rand() * 0.5);
      if (a === this.lastAct) s *= 0.35;
      if (s > bestS) { bestS = s; best = a; }
    }
    if (best !== BAct.None) this.begin(f, best, T);
  }

  /** Line of sight from its eye to a runner's chest. */
  private sees(f: Fight, q: Fighter): boolean {
    this.point(EYE[0], EYE[1], EYE[2] + 1, eye);
    tmp.x = q.p.pos.x; tmp.y = q.p.pos.y + 1.2; tmp.z = q.p.pos.z;
    return f.world.lineOfSight(eye, tmp);
  }

  private cool(a: BAct, base: number, f: Fight) {
    this.ready.set(a, f.time + base * this.odK * (0.85 + f.rand() * 0.3));
  }

  private begin(f: Fight, a: BAct, T: Fighter) {
    const t = f.time;
    this.setState(BState.Act);
    this.act = a;
    this.actAt = t;
    this.lastAct = a;
    this.struck.clear();
    this.burned.clear();
    this.eyeDamage = 0;
    this.shotsFired = 0;
    this.launched = 0;
    this.prevSwipe.a = NaN;
    const tell = (b: number) => t + b * this.tellK;
    let d: number[] = [];
    switch (a) {
      case BAct.Stomp:
        this.cool(a, BOSS.STOMP.COOLDOWN, f);
        d = [this.x, this.z, tell(BOSS.STOMP.TELL)];
        break;
      case BAct.Beam: {
        this.cool(a, BOSS.BEAM.COOLDOWN, f);
        // aim a little over the target's feet at its distance, then sweep across it
        const yc = Math.atan2(T.p.pos.x - this.x, T.p.pos.z - this.z);
        wardenPoint(this.x, ARENA.y, this.z, yc, EYE[0], BOSS.LIFT + EYE[1], EYE[2], eye);
        const D = Math.max(4, Math.hypot(T.p.pos.x - eye.x, T.p.pos.z - eye.z));
        const pitch = Math.atan2(T.p.pos.y + BOSS.BEAM.HEIGHT - eye.y, D);
        const dir = f.rand() < 0.5 ? -1 : 1;
        const half = BOSS.BEAM.ARC / 2;
        d = [this.x, this.z, BOSS.LIFT, yc - dir * half, yc + dir * half, pitch, tell(BOSS.BEAM.TELL), BOSS.BEAM.SWEEP, this.overdrive ? 2 : 1];
        break;
      }
      case BAct.Mortar: {
        this.cool(a, BOSS.MORTAR.COOLDOWN, f);
        const n = BOSS.MORTAR.SHELLS + BOSS.MORTAR.PER_PLAYER * (f.fighters.filter((q) => f.targetable(q)).length - 1) + (this.overdrive ? 2 : 0);
        d = [n, tell(BOSS.MORTAR.TELL), BOSS.MORTAR.SPREAD / Math.max(1, n - 1)];
        break;
      }
      case BAct.Deploy: {
        this.cool(a, BOSS.DEPLOY.COOLDOWN, f);
        const players = Math.max(1, Math.min(3, f.fighters.filter((q) => f.targetable(q)).length));
        const n = Math.max(1, Math.min(BOSS.DEPLOY.COUNT[players - 1] + (this.overdrive ? 1 : 0), f.botCap() - f.bots.length));
        d = [n, tell(BOSS.DEPLOY.TELL), 0.28];
        break;
      }
      case BAct.Charge: {
        this.cool(a, BOSS.CHARGE.COOLDOWN, f);
        const yc = Math.atan2(T.p.pos.x - this.x, T.p.pos.z - this.z);
        d = [this.x, this.z, yc, tell(BOSS.CHARGE.TELL), this.chargeRun(f, yc)];
        break;
      }
      case BAct.Swipe: {
        this.cool(a, BOSS.SWIPE.COOLDOWN, f);
        // the arm comes round from the side the target is on
        const rel = wrapAngle(Math.atan2(T.p.pos.x - this.x, T.p.pos.z - this.z) - this.yaw);
        const dir = rel > 0 ? -1 : 1;
        d = [this.yaw, dir, tell(BOSS.SWIPE.TELL), BOSS.SWIPE.TIME];
        break;
      }
      case BAct.Shock:
        this.cool(a, BOSS.SHOCK.COOLDOWN, f);
        d = [tell(BOSS.SHOCK.TELL)];
        break;
    }
    this.actD = d;
    f.emit({ k: 'act', a, at: t, d: d.map((v) => Math.round(v * 1000) / 1000) });
  }

  /** How far a charge along `yaw` would run before the edge of the floor (pillars aside). */
  private chargeRun(f: Fight, yaw: number): number {
    void f;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const px = this.x - ARENA.x, pz = this.z - ARENA.z;
    // |p + f s| = ROAM + 1  ->  s^2 + 2 (p.f) s + |p|^2 - R^2 = 0
    const R = BOSS.ROAM + 1, b = px * fx + pz * fz, c = px * px + pz * pz - R * R;
    return Math.max(0, -b + Math.sqrt(Math.max(0, b * b - c)));
  }

  private finish(f: Fight, extra = 0) {
    this.setState(BState.Recover);
    const [lo, hi] = BOSS.RECOVER;
    this.recoverUntil = f.time + (lo + f.rand() * (hi - lo)) * (this.overdrive ? 0.75 : 1) + extra;
  }

  // ------------------------------------------------------------------ the abilities

  /** One step of the current ability. Returns the hull height it wants. */
  private runAct(dt: number, f: Fight): number {
    const t = f.time, d = this.actD;
    const floorY = ARENA.y;
    switch (this.act) {
      case BAct.Stomp: {
        // rear up (the tell), slam down, and a ring of force runs out along the floor
        if (t < d[2]) return BOSS.LIFT_REAR;
        const r = stompRing(d, t);
        if (r < 0) { this.finish(f, 0.3); return BOSS.LIFT; }
        const S = BOSS.STOMP;
        for (const q of f.victims()) {
          if (this.struck.has(q.id)) continue;
          const h = q.pos.y - floorY;
          if (h > S.HEIGHT || h < -0.5) continue; // jumped it, or up on something
          const dx = q.pos.x - d[0], dz = q.pos.z - d[1], dist = Math.hypot(dx, dz) || 1;
          if (Math.abs(dist - r) > S.BAND / 2 + 0.34) continue;
          this.struck.add(q.id);
          f.hurtVictim(q, S.DAMAGE, 'stomp', { x: d[0], y: floorY, z: d[1] }, { x: (dx / dist) * S.KNOCK, y: S.LIFT, z: (dz / dist) * S.KNOCK });
        }
        f.ringPush(d[0], d[1], r, S.BAND);
        return BOSS.LIFT;
      }
      case BAct.Beam: {
        const [, , , yaw0, , , t0] = d;
        if (t < t0) {
          // turn onto the start of the sweep while the eye charges
          this.yaw = approachAngle(this.yaw, yaw0, 3 * dt);
          return BOSS.LIFT;
        }
        if (!beamAt(d, t, floorY, eye, dirV)) { this.finish(f); return BOSS.LIFT; }
        this.yaw = Math.atan2(dirV.x, dirV.z);
        f.beam(this, eye, dirV, this.burned);
        return BOSS.LIFT;
      }
      case BAct.Mortar: {
        const [n, t0, gap] = d;
        while (this.shotsFired < n && t >= t0 + this.shotsFired * gap) {
          f.fireShell(this, this.shotsFired);
          this.shotsFired++;
        }
        if (this.shotsFired >= n) this.finish(f);
        if (this.target) this.yaw = approachAngle(this.yaw, Math.atan2(this.target.p.pos.x - this.x, this.target.p.pos.z - this.z), BOSS.TURN * 0.6 * dt);
        return BOSS.LIFT;
      }
      case BAct.Deploy: {
        const [n, t0, gap] = d;
        while (this.launched < n && t >= t0 + this.launched * gap) {
          f.launchBot(this, this.launched);
          this.launched++;
        }
        if (this.launched >= n) this.finish(f);
        return BOSS.LIFT + 0.25;
      }
      case BAct.Charge: {
        const C = BOSS.CHARGE;
        const [, , yc, t0] = d;
        if (t < t0) { this.yaw = approachAngle(this.yaw, yc, 2.6 * dt); return BOSS.LIFT - 0.5; }
        this.yaw = yc;
        const fx = Math.sin(yc), fz = Math.cos(yc);
        const step = C.SPEED * dt;
        this.x += fx * step; this.z += fz * step;
        // a pillar in the way: it runs straight into it and goes down
        for (const p of f.arena.pillars) {
          const hx = this.x + fx * 4.2, hz = this.z + fz * 4.2;
          if (Math.hypot(hx - p[0], hz - p[2]) < 3.3 || Math.hypot(this.x - p[0], this.z - p[2]) < 4.6) {
            this.x -= fx * step; this.z -= fz * step;
            f.emit({ k: 'boom', p: [Math.round(hx * 100) / 100, Math.round((floorY + 5) * 100) / 100, Math.round(hz * 100) / 100], r: 7, c: 5 });
            f.shove({ x: hx, y: floorY, z: hz }, 8, 7, 4);
            this.stagger(f, C.CRASH, 'crash');
            return BOSS.LIFT_STAGGER;
          }
        }
        // anything in its path is trampled
        for (const q of f.victims()) {
          if (this.struck.has(q.id)) continue;
          const rx = q.pos.x - this.x, rz = q.pos.z - this.z;
          const along = rx * fx + rz * fz, lat = -rx * fz + rz * fx;
          if (along < -1 || along > 6.5 || Math.abs(lat) > C.WIDTH / 2 + 0.4 || q.pos.y - floorY > this.lift + 1) continue;
          this.struck.add(q.id);
          const side = lat >= 0 ? 1 : -1;
          f.hurtVictim(q, C.DAMAGE, 'charge', { x: this.x, y: floorY, z: this.z },
            { x: -fz * side * C.KNOCK + fx * 6, y: C.LIFT, z: fx * side * C.KNOCK + fz * 6 });
        }
        f.trample(this.x, this.z, fx, fz, C.WIDTH);
        const fromC = Math.hypot(this.x - ARENA.x, this.z - ARENA.z);
        if (fromC > BOSS.ROAM + 1 || t > t0 + C.TIME) {
          this.keepOnFloor(f);
          // skidding to a stop at the edge leaves it open for a moment
          this.finish(f, 0.6);
        }
        return BOSS.LIFT - 0.5;
      }
      case BAct.Swipe: {
        const S = BOSS.SWIPE;
        const a = swipeAt(d, t);
        if (t > d[2] + d[3]) { this.finish(f); return BOSS.LIFT; }
        if (isNaN(a)) return BOSS.LIFT;
        const prev = isNaN(this.prevSwipe.a) ? d[0] - d[1] * 2.1 : this.prevSwipe.a;
        this.prevSwipe.a = a;
        for (const q of f.victims()) {
          if (this.struck.has(q.id)) continue;
          const dx = q.pos.x - this.x, dz = q.pos.z - this.z, r = Math.hypot(dx, dz);
          const h = q.pos.y - floorY;
          if (r < S.R0 || r > S.R1 || h < S.Y0 - 1.75 || h > S.Y1) continue;
          const ang = Math.atan2(dx, dz);
          // did the arm pass over them in this step (or is it on them now)?
          const u0 = wrapAngle(ang - prev), u1 = wrapAngle(ang - a);
          if (Math.abs(u0) > 1.5) continue;
          if (u0 * u1 > 0 && Math.abs(u1) > 0.12) continue;
          this.struck.add(q.id);
          // flung round the way the arm was going, and out
          const tx = Math.cos(ang) * d[1], tz = -Math.sin(ang) * d[1];
          f.hurtVictim(q, S.DAMAGE, 'swipe', { x: this.x, y: floorY + h, z: this.z },
            { x: tx * S.KNOCK + (dx / r) * 6, y: 5, z: tz * S.KNOCK + (dz / r) * 6 });
        }
        return BOSS.LIFT;
      }
      case BAct.Shock: {
        if (t < d[0]) return BOSS.LIFT;
        const S = BOSS.SHOCK;
        for (const q of f.victims()) {
          if (!f.ridesWarden(q)) continue;
          const dx = q.pos.x - this.x, dz = q.pos.z - this.z, r = Math.hypot(dx, dz) || 1;
          f.hurtVictim(q, S.DAMAGE, 'shock', this.point(0, 1.7, 0, tmp), { x: (dx / r) * S.KNOCK, y: S.LIFT, z: (dz / r) * S.KNOCK });
        }
        f.emit({ k: 'boom', p: [Math.round(this.x * 100) / 100, Math.round((floorY + this.lift + 1.7) * 100) / 100, Math.round(this.z * 100) / 100], r: 5, c: 6 });
        this.finish(f, 0.2);
        return BOSS.LIFT;
      }
      default:
        this.finish(f);
        return BOSS.LIFT;
    }
  }

  /** A snapshot's flags: 1 overdrive, 2 somebody is riding it. */
  flags(f: Fight) {
    let fl = this.overdrive ? 1 : 0;
    if (f.fighters.some((q) => q.rideT > 0)) fl |= 2;
    return fl;
  }

  /** Seconds since the current ability began (0 when it is not using one). */
  actTime(t: number) { return this.state === BState.Act ? t - this.actAt : 0; }
}

/** A bot cap for this many runners. */
export function botCap(players: number, overdrive: boolean) {
  return BOT.CAP_BASE + BOT.CAP_PER_PLAYER * Math.max(1, players) + (overdrive ? 1 : 0);
}

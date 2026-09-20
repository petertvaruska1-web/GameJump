// Enemy AI: finite state machine driven by line of sight.
// IDLE/PATROL -> (sees player) ALERT -> CHASE -> ATTACK
// CHASE -> (loses sight) SEARCH -> RETURN -> IDLE

import { ENEMY, FLYER, MELEE, PHYS, RANGED, type EnemyKind, type EnemyTuning } from '../constants';
import type { EnemyDef } from '../level/types';
import { approachAngle, clamp, damp, dist3, distXZ, v3, wrapAngle, type Vec3 } from '../math';
import { makeBody, stepBody, type CharBody, type StepInfo } from '../physics/character';
import type { CollisionWorld, GroundHit } from '../physics/world';
import { EState, type DeathCause, type GameEvent } from '../protocol';

export interface Target {
  id: number;
  pos: Vec3;
  vel: Vec3;
  /** Alive, connected, in play and not cloaked. */
  targetable: boolean;
  /** Sliding: enemies look for a lower silhouette. */
  low?: boolean;
  /** Mid front flip: tucked, so shots are aimed lower than the chest. */
  tucked?: boolean;
}

export interface EnemyHost {
  world: CollisionWorld;
  time: number;
  targets: Target[];
  kill(t: Target, cause: DeathCause, e: Enemy): void;
  fire(e: Enemy, origin: Vec3, vel: Vec3): void;
  emit(ev: GameEvent): void;
}

const gh: GroundHit = { top: 0, c: null };
const eye = v3();
const tp = v3();

export class Enemy {
  readonly id: number;
  readonly def: EnemyDef;
  readonly kind: EnemyKind;
  readonly tune: EnemyTuning;
  readonly home: Vec3;
  readonly homeYaw: number;
  pos: Vec3;
  vel = v3();
  yaw: number;
  state: EState = EState.Idle;
  stateT = 0;
  target: Target | null = null;
  readonly lastSeen = v3();
  lastSeenT = -99;
  seenNow = false;
  charge = 0;
  cooldown = 0;
  private visionAcc: number;
  private patrolIdx = 0;
  private body: CharBody | null = null;
  private info: StepInfo = { landed: false, impact: 0, wall: null, dynamicHit: null };
  private stuckT = 0;
  private lastProgress = v3();
  private searchYaw = 0;
  private jumped = false;
  /** Knocked back by a shield: frozen until this time. */
  stunUntil = 0;

  constructor(def: EnemyDef) {
    this.id = def.id;
    this.def = def;
    this.kind = def.kind;
    this.tune = ENEMY[def.kind];
    this.home = v3(def.p[0], def.p[1], def.p[2]);
    this.homeYaw = def.yaw;
    this.yaw = def.yaw;
    this.visionAcc = (def.id * 0.137) % (1 / this.tune.visionHz);
    if (def.kind === 'melee') {
      this.body = makeBody(0.4, 2.0);
      this.body.pos.x = def.p[0]; this.body.pos.y = def.p[1]; this.body.pos.z = def.p[2];
      this.pos = this.body.pos;
    } else {
      this.pos = v3(def.p[0], def.p[1], def.p[2]);
    }
    this.lastProgress.x = this.pos.x; this.lastProgress.z = this.pos.z;
  }

  get leash() { return this.def.leash ?? this.tune.leash; }

  private setState(s: EState, h: EnemyHost) {
    if (s === this.state) return;
    const was = this.state;
    this.state = s;
    this.stateT = 0;
    this.stuckT = 0;
    if ((s === EState.Search || s === EState.Return) && (was === EState.Chase || was === EState.Alert)) {
      h.emit({ k: 'lost', e: this.id });
    }
    if (s === EState.Return || s === EState.Idle) { this.target = null; this.charge = 0; }
    if (s === EState.Search) this.searchYaw = this.yaw;
  }

  /** A shield soaked this enemy's hit: it reels, then gives up the chase. */
  stun(until: number) {
    this.stunUntil = until;
    this.charge = 0;
    this.vel.x = this.vel.y = this.vel.z = 0;
  }

  update(dt: number, h: EnemyHost) {
    if (h.time < this.stunUntil) {
      this.stateT = 0;
      if (this.body) { this.body.vel.x = this.body.vel.z = 0; this.body.vel.y -= PHYS.GRAVITY * dt; stepBody(h.world, this.body, dt, false, this.info); }
      return;
    }
    if (this.stunUntil > 0) { this.stunUntil = 0; this.setState(EState.Return, h); }
    this.stateT += dt;
    this.visionAcc += dt;
    const vi = 1 / this.tune.visionHz;
    if (this.visionAcc >= vi) { this.visionAcc -= vi; this.look(h); }
    if (this.kind === 'melee') this.updateMelee(dt, h);
    else if (this.kind === 'ranged') this.updateRanged(dt, h);
    else this.updateFlyer(dt, h);
  }

  // ------------------------------------------------------------------ perception

  private facing() { return this.yaw; }

  private eyePos(out: Vec3): Vec3 {
    out.x = this.pos.x; out.y = this.pos.y + this.tune.eyeHeight; out.z = this.pos.z;
    return out;
  }

  canSee(t: Target, h: EnemyHost, tracking: boolean): boolean {
    this.eyePos(eye);
    const dx = t.pos.x - eye.x, dy = t.pos.y + 1.2 - eye.y, dz = t.pos.z - eye.z;
    const d = Math.hypot(dx, dy, dz);
    const range = tracking ? this.tune.viewDist * 1.3 : this.tune.viewDist;
    if (d > range) return false;
    if (!tracking && d > this.tune.senseDist) {
      const ang = Math.abs(wrapAngle(Math.atan2(dx, dz) - this.facing()));
      if (ang > (this.tune.fovDeg * Math.PI) / 360) return false;
    }
    tp.x = t.pos.x; tp.z = t.pos.z;
    tp.y = t.pos.y + (t.low ? 0.55 : 1.15);
    if (h.world.lineOfSight(eye, tp)) return true;
    tp.y = t.pos.y + (t.low ? 0.8 : 1.65);
    return h.world.lineOfSight(eye, tp);
  }

  private look(h: EnemyHost) {
    const s = this.state;
    if ((s === EState.Chase || s === EState.Alert || s === EState.Attack) && this.target) {
      if (!this.target.targetable) { this.seenNow = false; this.setState(EState.Return, h); return; }
      this.seenNow = this.canSee(this.target, h, true);
      if (this.seenNow) { this.lastSeen.x = this.target.pos.x; this.lastSeen.y = this.target.pos.y; this.lastSeen.z = this.target.pos.z; this.lastSeenT = h.time; }
      return;
    }
    let best: Target | null = null, bestD = Infinity;
    for (const t of h.targets) {
      if (!t.targetable) continue;
      const d = dist3(t.pos, this.pos);
      if (d > this.tune.viewDist + 2 || d >= bestD) continue;
      if (!this.canSee(t, h, false)) continue;
      best = t; bestD = d;
    }
    if (best) {
      this.target = best;
      this.seenNow = true;
      this.lastSeen.x = best.pos.x; this.lastSeen.y = best.pos.y; this.lastSeen.z = best.pos.z;
      this.lastSeenT = h.time;
      this.setState(EState.Alert, h);
      h.emit({ k: 'alert', e: this.id, target: best.id });
    } else {
      this.seenNow = false;
    }
  }

  /** Common chase bookkeeping. Returns false if the chase was abandoned. */
  private chaseChecks(h: EnemyHost): boolean {
    const t = this.target;
    if (!t || !t.targetable) { this.setState(EState.Return, h); return false; }
    if (!this.seenNow && h.time - this.lastSeenT > this.tune.loseTime) { this.setState(EState.Search, h); return false; }
    if (this.leash > 0 && distXZ(this.pos, this.home) > this.leash) { this.setState(EState.Return, h); return false; }
    return true;
  }

  // ------------------------------------------------------------------ melee

  private updateMelee(dt: number, h: EnemyHost) {
    const b = this.body!;
    const tune = this.tune;
    let goal: Vec3 | null = null;
    let speed = 0;
    let faceTarget = false;

    switch (this.state) {
      case EState.Idle: {
        const pts = this.def.patrol;
        if (pts && pts.length > 1) {
          const p = pts[this.patrolIdx % pts.length];
          tp.x = p[0]; tp.y = p[1]; tp.z = p[2];
          if (distXZ(tp, this.pos) < 0.9) this.patrolIdx++;
          goal = tp; speed = tune.patrolSpeed;
        } else {
          this.yaw = approachAngle(this.yaw, this.homeYaw + Math.sin(h.time * 0.4 + this.id) * 0.9, 1.2 * dt);
        }
        break;
      }
      case EState.Alert:
        faceTarget = true;
        if (this.stateT > tune.alertTime) this.setState(EState.Chase, h);
        break;
      case EState.Chase: {
        if (!this.chaseChecks(h)) break;
        const t = this.target!;
        goal = this.seenNow ? t.pos : this.lastSeen;
        speed = tune.speed;
        const dh = distXZ(this.pos, t.pos), dv = t.pos.y - this.pos.y;
        if (dh < tune.catchRadius && dv > -1.2 && dv < 1.7 && h.time - this.lastSeenT < 0.6) {
          h.kill(t, 'melee', this);
          this.setState(EState.Attack, h);
          break;
        }
        // stuck against something we cannot climb -> give up
        if (b.grounded && Math.hypot(b.vel.x, b.vel.z) < 0.6 && dh > 1.5) {
          this.stuckT += dt;
          if (this.stuckT > 1.8) this.setState(EState.Return, h);
        } else this.stuckT = Math.max(0, this.stuckT - dt);
        break;
      }
      case EState.Attack:
        if (this.stateT > 1.3) this.setState(EState.Return, h);
        break;
      case EState.Search:
        goal = this.lastSeen; speed = tune.patrolSpeed * 1.6;
        if (distXZ(this.pos, this.lastSeen) < 1.2) { goal = null; this.yaw = this.searchYaw + Math.sin(this.stateT * 2.2) * 1.2; }
        if (this.stateT > tune.searchTime) this.setState(EState.Return, h);
        break;
      case EState.Return: {
        const pts = this.def.patrol;
        const p = pts && pts.length ? pts[this.patrolIdx % pts.length] : null;
        tp.x = p ? p[0] : this.home.x; tp.y = p ? p[1] : this.home.y; tp.z = p ? p[2] : this.home.z;
        goal = tp; speed = tune.patrolSpeed * 1.5;
        if (distXZ(tp, this.pos) < 1.0 || this.stateT > 25) {
          this.setState(EState.Idle, h);
          if (!p) this.yaw = this.homeYaw;
        }
        break;
      }
    }

    // Steering with ledge awareness
    let dirX = 0, dirZ = 0;
    if (goal) {
      const dx = goal.x - this.pos.x, dz = goal.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.35) { dirX = dx / d; dirZ = dz / d; }
    }
    this.jumped = false;
    if (b.grounded && (dirX !== 0 || dirZ !== 0)) {
      const w = h.world;
      w.groundProbe(this.pos.x + dirX * 0.9, this.pos.z + dirZ * 0.9, 0.25, this.pos.y + 0.5, gh);
      const safe = gh.c !== null && gh.top > this.pos.y - 1.6;
      if (!safe) {
        let leap = false;
        if (this.state === EState.Chase) {
          for (let d = 1.5; d <= MELEE.MAX_LEAP + 1.2; d += 0.5) {
            w.groundProbe(this.pos.x + dirX * d, this.pos.z + dirZ * d, 0.3, this.pos.y + 0.9, gh);
            if (gh.c && gh.top > this.pos.y - 4) {
              const need = (d + 1.0) / 0.7;
              const sp = Math.max(speed, need);
              b.vel.x = dirX * sp; b.vel.z = dirZ * sp; b.vel.y = MELEE.JUMP_VELOCITY;
              b.grounded = false; b.ground = null;
              this.jumped = true; leap = true;
              break;
            }
          }
        }
        if (!leap) { dirX = 0; dirZ = 0; b.vel.x *= 0.5; b.vel.z *= 0.5; faceTarget = faceTarget || this.state === EState.Chase; }
      }
    }
    if (b.grounded && !this.jumped) {
      const tx = dirX * speed, tz = dirZ * speed;
      const k = Math.min(1, 26 * dt / Math.max(0.001, Math.hypot(tx - b.vel.x, tz - b.vel.z)));
      b.vel.x += (tx - b.vel.x) * k; b.vel.z += (tz - b.vel.z) * k;
    }
    b.vel.y = Math.max(b.vel.y - PHYS.GRAVITY * dt, -PHYS.MAX_FALL_SPEED);
    stepBody(h.world, b, dt, this.jumped, this.info);

    const hs = Math.hypot(b.vel.x, b.vel.z);
    if (faceTarget && this.target) {
      const t = this.seenNow ? this.target.pos : this.lastSeen;
      this.yaw = approachAngle(this.yaw, Math.atan2(t.x - this.pos.x, t.z - this.pos.z), 8 * dt);
    } else if (hs > 0.5) {
      this.yaw = approachAngle(this.yaw, Math.atan2(b.vel.x, b.vel.z), 10 * dt);
    }
    this.vel.x = b.vel.x; this.vel.y = b.vel.y; this.vel.z = b.vel.z;

    // fell into the abyss: climbs back to its post
    if (this.pos.y < this.home.y - 20) this.respawn(h);
  }

  private respawn(h: EnemyHost) {
    this.pos.x = this.home.x; this.pos.y = this.home.y; this.pos.z = this.home.z;
    this.vel.x = this.vel.y = this.vel.z = 0;
    if (this.body) { this.body.vel.x = this.body.vel.y = this.body.vel.z = 0; this.body.grounded = false; }
    this.yaw = this.homeYaw;
    this.setState(EState.Idle, h);
  }

  // ------------------------------------------------------------------ ranged

  private updateRanged(dt: number, h: EnemyHost) {
    const tune = this.tune;
    switch (this.state) {
      case EState.Idle:
        this.yaw = approachAngle(this.yaw, this.homeYaw + Math.sin(h.time * RANGED.SCAN_SPEED + this.id * 1.7) * RANGED.SCAN_ARC, 1.5 * dt);
        this.charge = Math.max(0, this.charge - dt);
        break;
      case EState.Alert:
        this.turnTo(this.lastSeen, RANGED.TURN_SPEED * dt);
        if (this.stateT > tune.alertTime) this.setState(EState.Chase, h);
        break;
      case EState.Chase: {
        if (!this.chaseChecks(h)) break;
        const t = this.target!;
        const aimAt = this.seenNow ? t.pos : this.lastSeen;
        const desired = Math.atan2(aimAt.x - this.pos.x, aimAt.z - this.pos.z);
        this.yaw = approachAngle(this.yaw, desired, RANGED.TURN_SPEED * dt);
        this.cooldown -= dt;
        const aligned = Math.abs(wrapAngle(desired - this.yaw)) < 0.3;
        if (this.seenNow && aligned && this.cooldown <= 0) {
          if (this.charge === 0) h.emit({ k: 'charge', e: this.id });
          this.charge = Math.min(1, this.charge + dt / RANGED.CHARGE_TIME);
          if (this.charge >= 1) { this.shoot(t, h); this.charge = 0; this.cooldown = RANGED.COOLDOWN; }
        } else if (!this.seenNow) {
          this.charge = Math.max(0, this.charge - dt * 1.5);
        }
        break;
      }
      case EState.Search:
        this.charge = Math.max(0, this.charge - dt * 2);
        this.yaw = approachAngle(this.yaw, Math.atan2(this.lastSeen.x - this.pos.x, this.lastSeen.z - this.pos.z) + Math.sin(this.stateT * 1.6) * 0.5, RANGED.TURN_SPEED * dt);
        if (this.stateT > tune.searchTime) this.setState(EState.Return, h);
        break;
      case EState.Return:
      case EState.Attack:
        this.yaw = approachAngle(this.yaw, this.homeYaw, 1.2 * dt);
        if (Math.abs(wrapAngle(this.yaw - this.homeYaw)) < 0.05 || this.stateT > 3) this.setState(EState.Idle, h);
        break;
    }
  }

  private turnTo(p: Vec3, step: number) {
    this.yaw = approachAngle(this.yaw, Math.atan2(p.x - this.pos.x, p.z - this.pos.z), step);
  }

  private shoot(t: Target, h: EnemyHost) {
    const o = this.eyePos(v3());
    o.x += Math.sin(this.yaw) * 0.9; o.z += Math.cos(this.yaw) * 0.9;
    // a runner already sliding or flipping when the shot leaves gets aimed low;
    // slide or flip after the charge-up and the shot passes over you
    const tx = t.pos.x, ty = t.pos.y + (t.low ? 0.4 : t.tucked ? 0.62 : 1.1), tz = t.pos.z;
    const d = Math.hypot(tx - o.x, ty - o.y, tz - o.z);
    const flight = d / RANGED.PROJECTILE_SPEED;
    const ax = tx + t.vel.x * flight * RANGED.LEAD;
    const az = tz + t.vel.z * flight * RANGED.LEAD;
    const ay = ty;
    const dx = ax - o.x, dy = ay - o.y, dz = az - o.z;
    // imprecise aim: random yaw/pitch error, larger against fast-moving targets
    const spread = RANGED.SPREAD + Math.hypot(t.vel.x, t.vel.z) * RANGED.SPREAD_PER_SPEED;
    const yaw = Math.atan2(dx, dz) + (Math.random() * 2 - 1) * spread;
    const pitch = Math.atan2(dy, Math.hypot(dx, dz)) + (Math.random() * 2 - 1) * spread * 0.6;
    const s = RANGED.PROJECTILE_SPEED, cp = Math.cos(pitch);
    h.fire(this, o, v3(Math.sin(yaw) * cp * s, Math.sin(pitch) * s, Math.cos(yaw) * cp * s));
  }

  // ------------------------------------------------------------------ flyer

  private updateFlyer(dt: number, h: EnemyHost) {
    const tune = this.tune;
    let goal: Vec3 | null = null;
    let speed = tune.patrolSpeed;
    let faceGoal = true;
    switch (this.state) {
      case EState.Idle: {
        const pts = this.def.patrol;
        if (pts && pts.length) {
          const p = pts[this.patrolIdx % pts.length];
          tp.x = p[0]; tp.y = p[1]; tp.z = p[2];
          if (dist3(tp, this.pos) < 1.5) this.patrolIdx++;
        } else {
          const a = h.time * 0.3 + this.id;
          tp.x = this.home.x + Math.sin(a) * FLYER.PATROL_RADIUS;
          tp.y = this.home.y;
          tp.z = this.home.z + Math.cos(a) * FLYER.PATROL_RADIUS;
        }
        goal = tp;
        break;
      }
      case EState.Alert:
        tp.x = this.pos.x; tp.y = this.pos.y + 1; tp.z = this.pos.z;
        goal = tp; speed = 1.5; faceGoal = false;
        this.turnTo(this.lastSeen, 5 * dt);
        if (this.stateT > tune.alertTime) this.setState(EState.Chase, h);
        break;
      case EState.Chase: {
        if (!this.chaseChecks(h)) break;
        const t = this.target!;
        const src = this.seenNow ? t.pos : this.lastSeen;
        tp.x = src.x; tp.y = src.y + 1.1; tp.z = src.z;
        goal = tp; speed = tune.speed;
        const d = Math.hypot(t.pos.x - this.pos.x, t.pos.y + 1.1 - this.pos.y, t.pos.z - this.pos.z);
        if (d < FLYER.DIVE_DIST) speed *= FLYER.DIVE_MULT;
        if (d < tune.catchRadius && h.time - this.lastSeenT < 0.6) {
          h.kill(t, 'flyer', this);
          this.setState(EState.Attack, h);
        }
        break;
      }
      case EState.Attack:
        tp.x = this.pos.x; tp.y = this.pos.y + 2; tp.z = this.pos.z;
        goal = tp; speed = 2;
        if (this.stateT > 1.5) this.setState(EState.Return, h);
        break;
      case EState.Search:
        tp.x = this.lastSeen.x; tp.y = this.lastSeen.y + 3; tp.z = this.lastSeen.z;
        goal = tp; speed = tune.patrolSpeed * 1.3;
        if (dist3(tp, this.pos) < 2) { faceGoal = false; this.yaw += dt * 1.4; }
        if (this.stateT > tune.searchTime) this.setState(EState.Return, h);
        break;
      case EState.Return:
        tp.x = this.home.x; tp.y = this.home.y; tp.z = this.home.z;
        goal = tp; speed = tune.patrolSpeed * 1.6;
        if (dist3(tp, this.pos) < 2 || this.stateT > 30) this.setState(EState.Idle, h);
        break;
    }

    let dvx = 0, dvy = 0, dvz = 0;
    if (goal) {
      const dx = goal.x - this.pos.x, dy = goal.y - this.pos.y, dz = goal.z - this.pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > 0.2) {
        const k = speed * clamp(d / 2.5, 0.2, 1) / d;
        dvx = dx * k; dvy = dy * k; dvz = dz * k;
        // look ahead for obstacles and climb over them
        const l = Math.hypot(dvx, dvy, dvz);
        if (l > 0.1) {
          const probe = h.world.raycast(this.pos.x, this.pos.y, this.pos.z, dvx / l, dvy / l, dvz / l, 3.5, false, { dist: 0, c: null });
          if (probe.c) dvy += speed * 0.9;
        }
      }
    }
    const a = damp(FLYER.ACCEL / Math.max(1, speed) * 1.2, dt);
    this.vel.x += (dvx - this.vel.x) * a;
    this.vel.y += (dvy - this.vel.y) * a;
    this.vel.z += (dvz - this.vel.z) * a;
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.pos.z += this.vel.z * dt;
    h.world.pushSphere(this.pos, FLYER.RADIUS);
    if (faceGoal) {
      if (this.state === EState.Chase && this.target) this.turnTo(this.seenNow ? this.target.pos : this.lastSeen, 6 * dt);
      else if (Math.hypot(this.vel.x, this.vel.z) > 0.5) this.yaw = approachAngle(this.yaw, Math.atan2(this.vel.x, this.vel.z), 3 * dt);
    }
  }
}

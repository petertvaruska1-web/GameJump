// Third-person follow camera: mouse orbit, spring-smoothed follow, look-ahead,
// collision pull-in, jump-stable framing, sprint/fall FOV kick and landing dips.
// In flight it follows in all three dimensions and frames the runner a little
// below the middle of the screen, so the middle of the screen is exactly where
// forward flies you.
//
// Everything that moves the camera is continuous: positions follow critically
// damped springs (with velocity state), and every state-dependent offset is
// itself smoothed, so nothing can pop when the player jumps or lands.

import * as THREE from 'three';
import { clamp, damp, lerp, wrapAngle } from '../../shared/math';
import type { CollisionWorld, RayHit } from '../../shared/physics/world';

export interface CamTarget {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  grounded: boolean;
  sprinting: boolean;
  /** Riding a zip line (the camera swings in behind like on the ground). */
  riding?: boolean;
  /** Sliding: the camera drops with the runner. */
  low?: boolean;
  /** Mid dash: a brief widening of the view. */
  dashing?: boolean;
  /** Boost power running: the view widens further at speed. */
  boosted?: boolean;
  /** Flying: full vertical follow, a wider pitch range, the view aimed where you fly. */
  flying?: boolean;
  /** 0..1: frame over the runner's right shoulder (someone to talk to is in front of you, or a fight). */
  shoulder?: number;
  /** Metres further back than usual (the Warden's arena wants more of the fight in view). */
  far?: number;
}

const BASE_DIST = 5.0;
const PIVOT_H = 1.55;
/** How much of a jump's height the camera follows (the rest is absorbed so it does not bob). */
const JUMP_FOLLOW = 0.4;
/** Usual pitch limits, and the wider ones in flight (you can look almost straight up or down). */
const PITCH_MIN = -1.25, PITCH_MAX = 0.95;
const FLY_PITCH_MIN = -1.4, FLY_PITCH_MAX = 1.25;
/** In flight the camera and its aim point rise this much, putting the runner under the centre of the view. */
const FLY_LIFT = 0.95;

/** Critically damped spring toward a target (Unity-style SmoothDamp). */
class Spring {
  v = 0;
  step(cur: number, target: number, smoothTime: number, dt: number): number {
    const st = Math.max(1e-4, smoothTime);
    const omega = 2 / st;
    const x = omega * dt;
    const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const change = cur - target;
    const temp = (this.v + omega * change) * dt;
    this.v = (this.v - omega * temp) * exp;
    let out = target + (change + temp) * exp;
    // prevent overshoot
    if ((target - cur > 0) === (out > target)) { out = target; this.v = 0; }
    return out;
  }
}

export class CameraController {
  yaw = 0;
  pitch = -0.2;
  private pivot = new THREE.Vector3();
  private sx = new Spring();
  private sy = new Spring();
  private sz = new Spring();
  private lookAhead = new THREE.Vector3();
  /** Height of the ground the player last stood on (jump framing anchor). */
  private anchorY = 0;
  private dist = BASE_DIST;
  private wantDist = BASE_DIST;
  private tilt = 0;
  private autoW = 0;
  private fovKick = 0;
  private shake = 0;
  private dip = 0;
  private dipVel = 0;
  private readonly hit: RayHit = { dist: 0, c: null };
  private tmp = new THREE.Vector3();
  private initialized = false;
  sensitivity = 1;
  invertY = false;
  baseFov = 74;
  shakeEnabled = true;
  /** Seconds since the mouse last moved the camera (drives auto-follow). */
  private idle = 0;
  /** Pivot height above the feet (lower while sliding). */
  private pivotH = PIVOT_H;
  /** 0..1 while sliding: level the view so it stays under low ceilings. */
  private lowK = 0;
  /** 0..1 while flying (eased). */
  private flyK = 0;
  private flyingNow = false;
  /** 0..1 over-the-shoulder framing (eased). */
  private shoulderK = 0;

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  reset(pos: THREE.Vector3, yaw: number) {
    this.yaw = yaw;
    this.pitch = -0.18;
    this.pivot.copy(pos).y += PIVOT_H;
    this.sx.v = this.sy.v = this.sz.v = 0;
    this.lookAhead.set(0, 0, 0);
    this.anchorY = pos.y;
    this.dist = this.wantDist = BASE_DIST;
    this.tilt = 0;
    this.autoW = 0;
    this.dip = this.dipVel = 0;
    this.initialized = true;
  }

  look(dx: number, dy: number) {
    if (dx !== 0 || dy !== 0) this.idle = 0;
    const k = 0.0022 * this.sensitivity;
    this.yaw -= dx * k;
    const prev = this.pitch;
    this.pitch -= dy * k * (this.invertY ? -1 : 1);
    // just out of flight the pitch may still be past the usual limits (it eases back
    // in, in update): the mouse can bring it back but never push it further out
    this.pitch = this.flyingNow ? clamp(this.pitch, FLY_PITCH_MIN, FLY_PITCH_MAX)
      : clamp(this.pitch, Math.min(PITCH_MIN, prev), Math.max(PITCH_MAX, prev));
  }

  addShake(a: number) { if (this.shakeEnabled) this.shake = Math.min(1, this.shake + a); }

  /** A punch of wider view (a power going off) that eases back by itself. */
  kickFov(deg: number) { if (this.shakeEnabled) this.fovKick = Math.min(this.fovKick + deg, 18); }

  landing(impact: number) {
    // only real drops dip the camera, and gently
    if (impact > 8) this.dipVel -= Math.min(2.4, (impact - 8) * 0.14);
    if (impact > 16) this.addShake(Math.min(0.4, (impact - 16) * 0.035));
  }

  /** Camera-relative basis for movement input. */
  forward(out: THREE.Vector3) { return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }
  right(out: THREE.Vector3) { return out.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw)); }
  /** Where the camera looks, pitch included (flight flies along this). */
  forward3(out: THREE.Vector3) { const cp = Math.cos(this.pitch); return out.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp); }

  update(dt: number, t: CamTarget, world: CollisionWorld, time: number) {
    if (!this.initialized) this.reset(t.pos, this.yaw);
    if (dt <= 0) return;
    const hs = Math.hypot(t.vel.x, t.vel.z);
    this.flyingNow = !!t.flying;
    this.flyK += ((t.flying ? 1 : 0) - this.flyK) * damp(t.flying ? 3 : 2, dt);
    // out of flight, a pitch beyond the usual limits eases back inside them
    if (!t.flying) {
      if (this.pitch > PITCH_MAX) this.pitch += (PITCH_MAX - this.pitch) * damp(4, dt);
      if (this.pitch < PITCH_MIN) this.pitch += (PITCH_MIN - this.pitch) * damp(4, dt);
    }

    // gentle auto-follow: swing in behind a runner when the mouse is left alone
    this.idle += dt;
    // only swing in behind a runner that is actually heading away from the camera:
    // strafing must not drag the view round with it
    const headingOff = hs > 0.5 ? Math.abs(wrapAngle(Math.atan2(t.vel.x, t.vel.z) - this.yaw)) : 0;
    const autoOn = !t.flying && this.idle > 0.9 && hs > 3 && headingOff < 1.2 && (t.grounded || !!t.riding);
    this.autoW += ((autoOn ? 1 : 0) - this.autoW) * damp(3, dt);
    if (this.autoW > 0.01 && hs > 0.5) {
      let d = Math.atan2(t.vel.x, t.vel.z) - this.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      if (Math.abs(d) < 1.75) this.yaw += d * damp(0.9, dt) * this.autoW;
    }

    // Vertical framing: while airborne the camera only follows part of the
    // jump height, and follows fully once the player drops below take-off.
    // flying, the camera follows every metre of height (there is no jump to absorb)
    if (t.grounded || t.flying || t.pos.y < this.anchorY) this.anchorY = t.pos.y;
    const rise = Math.max(0, t.pos.y - this.anchorY);
    // beyond a normal jump's height (launch pads) the camera follows all of the rise
    this.pivotH += ((t.low ? 0.7 : PIVOT_H) - this.pivotH) * damp(t.low ? 12 : 5, dt);
    const targetY = this.anchorY + rise * JUMP_FOLLOW + Math.max(0, rise - 1.8) * (1 - JUMP_FOLLOW) + this.pivotH;
    // long falls and launches tighten the spring continuously so the player never leaves the frame
    const fallK = clamp((-t.vel.y - 10) / 15, 0, 1);
    const upK = clamp((t.vel.y - 9) / 8, 0, 1);
    const stY = lerp(lerp(0.13, 0.05, fallK), 0.045, upK);

    // horizontal: short spring + smoothed look-ahead (velocity jumps never reach the camera directly)
    this.lookAhead.x += (t.vel.x * 0.1 - this.lookAhead.x) * damp(3, dt);
    this.lookAhead.z += (t.vel.z * 0.1 - this.lookAhead.z) * damp(3, dt);
    this.lookAhead.y += ((t.flying ? t.vel.y * 0.06 : 0) - this.lookAhead.y) * damp(3, dt);
    this.pivot.x = this.sx.step(this.pivot.x, t.pos.x + this.lookAhead.x, 0.07, dt);
    this.pivot.z = this.sz.step(this.pivot.z, t.pos.z + this.lookAhead.z, 0.07, dt);
    this.pivot.y = this.sy.step(this.pivot.y, targetY + this.lookAhead.y, t.flying ? 0.06 : stY, dt);

    // landing dip spring
    this.dipVel += (-this.dip * 70 - this.dipVel * 13) * dt;
    this.dip += this.dipVel * dt;

    // falling: tilt down a little to show the landing spot (smoothed both ways)
    const tiltTarget = t.grounded || t.flying ? 0 : clamp((-t.vel.y - 4) / 35, 0, 0.3);
    this.tilt += (tiltTarget - this.tilt) * damp(t.grounded ? 2.5 : 3, dt);
    this.lowK += ((t.low ? 1 : 0) - this.lowK) * damp(t.low ? 10 : 4, dt);
    const pitch = lerp(clamp(this.pitch - this.tilt, Math.min(-1.3, this.pitch), Math.max(0.95, this.pitch)), Math.max(this.pitch, -0.04), this.lowK);

    // desired distance (smoothed) and collision (pull in fast, ease out slowly)
    const sp3 = Math.hypot(hs, t.vel.y);
    const want = t.flying
      ? BASE_DIST + 0.8 + clamp(sp3 / 20, 0, 1) * 1.2 + clamp(pitch * -0.8, 0, 0.8)
      : BASE_DIST + (t.far ?? 0) + (t.sprinting ? 0.5 : 0) + clamp((-t.vel.y - 6) / 25, 0, 1.0) + clamp(pitch * -1.2, 0, 1.2);
    this.wantDist += (want - this.wantDist) * damp(2.2, dt);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const dirX = -Math.sin(this.yaw) * cp, dirY = -sp, dirZ = -Math.cos(this.yaw) * cp;
    // flying, both the camera and its aim point rise: the runner sits under the centre of the view
    const lift = FLY_LIFT * this.flyK;
    // over the shoulder: camera and aim slide right together, so whoever is ahead of you shows past your shoulder
    this.shoulderK += ((t.shoulder ?? 0) - this.shoulderK) * damp(2.5, dt);
    const sh = this.shoulderK * 0.85, shx = -Math.cos(this.yaw) * sh, shz = Math.sin(this.yaw) * sh;
    world.raycast(this.pivot.x, this.pivot.y + lift, this.pivot.z, dirX, dirY, dirZ, this.wantDist + 0.3, 'camera', this.hit);
    const allowed = this.hit.c ? Math.max(0.6, this.hit.dist - 0.35) : this.wantDist;
    // no hard snaps: obstructions pull in within a few frames, open space eases back out
    if (allowed < this.dist) this.dist += (allowed - this.dist) * damp(28, dt);
    else this.dist += (allowed - this.dist) * damp(3, dt);

    const cam = this.camera;
    cam.position.set(this.pivot.x + shx + dirX * this.dist, this.pivot.y + lift + dirY * this.dist + this.dip * 0.3, this.pivot.z + shz + dirZ * this.dist);
    this.tmp.set(this.pivot.x + shx, this.pivot.y + lift + this.dip * 0.2 + 0.15 * (1 - this.flyK), this.pivot.z + shz);
    cam.lookAt(this.tmp);
    if (this.shake > 0) {
      const s = this.shake * this.shake * 0.06;
      cam.rotation.x += (Math.sin(time * 71) + Math.sin(time * 37)) * s;
      cam.rotation.y += (Math.sin(time * 53) + Math.sin(time * 29)) * s;
      this.shake = Math.max(0, this.shake - dt * 2.4);
    }
    // FOV kick
    const kick = t.flying ? clamp((sp3 - 8) * 0.8, 0, 10)
      : (t.sprinting && hs > 7 ? 6 : 0) + (t.boosted && hs > 7 ? 5 : 0) + (t.low ? 5 : 0) + (t.dashing ? 7 : 0) + clamp((-t.vel.y - 14) * 0.5, 0, 12);
    this.fovKick += (kick - this.fovKick) * damp(3, dt);
    const fov = this.baseFov + this.fovKick;
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }
  }

  /** Detached camera used for death-by-falling: stays put and watches. */
  watch(dt: number, from: THREE.Vector3, target: THREE.Vector3) {
    const cam = this.camera;
    cam.position.lerp(from, damp(2, dt));
    cam.lookAt(target);
  }
}

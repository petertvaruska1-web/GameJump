// The locally controlled runner: fixed-step client-side prediction with the
// shared controller, render interpolation, and gameplay event hooks.

import * as THREE from 'three';
import { CORPSE, DEATH, PHYS } from '../../shared/constants';
import { laserHit, windAt } from '../../shared/hazards';
import type { LevelData } from '../../shared/level/types';
import { Anim, PlayerMotor, stepCorpse, type MoveInput, type StepInfo } from '../../shared/physics/character';
import type { CollisionWorld } from '../../shared/physics/world';
import { CharacterModel } from '../render/CharacterModel';

export interface PlayerHooks {
  jump(): void;
  land(impact: number, surface: string): void;
  mantle(): void;
  footstep(surface: string, speed: number): void;
  groundChanged(id: number): void;
  launched(id: number): void;
  zipOn(): void;
  zipOff(): void;
  slid(): void;
  hooked(id: number): void;
  unhooked(): void;
  /** Started a front flip. */
  flipped(): void;
  /** Started a dash (-1 left, 1 right). */
  dashed(side: number): void;
  /** Touched an active laser (local detection; the game reports it to the server). */
  laser(): void;
  /** The dead body hit the ground. */
  bodyLanded(impact: number): void;
  /** Took off (1) or stopped flying (-1). */
  flew(dir: number): void;
  /** A meteor slam hit the ground at this speed. */
  slammed(speed: number): void;
  /** A flash strike ended (it began at `from`). */
  flashed(from: { x: number; y: number; z: number }): void;
}

const wind: [number, number] = [0, 0];

export class LocalPlayer {
  readonly motor = new PlayerMotor();
  readonly model: CharacterModel;
  readonly renderPos = new THREE.Vector3();
  readonly renderVel = new THREE.Vector3();
  private prev = new THREE.Vector3();
  private cur = new THREE.Vector3();
  private prevYaw = 0;
  private acc = 0;
  private stepSmooth = 0;
  private lastPhaseStep = 0;
  private lastGround = -1;
  private renderYaw = 0;
  private yawRate = 0;
  frozen = true;
  dead = false;
  finished = false;
  /** Falling with nothing below: the local presentation treats this as a fall. */
  doomed = false;
  doomedAt = new THREE.Vector3();
  anim: number = Anim.Idle;
  private jumpQueued = false;
  /** Debug god mode: lasers do not kill. */
  immune = false;
  /** No laser checks until this match time (right after a shield soaked one). */
  laserGraceUntil = 0;
  /**
   * With Viktor, in the white room: the course's lasers and gusts are measured
   * against the course, so they must not be tested here at all.
   */
  sanctuary = false;
  /** Shown instead of the motor's own animation (Viktor's blessing lifts you into a hover). */
  poseOverride: number | null = null;
  /** Drawn this far above the body (the blessing lifts you off the floor). */
  lift = 0;
  private flyReq = false;
  private grappleReq = -1;
  private releaseReq = false;
  private dashReqX = 0;
  private dashReqZ = 0;
  private readonly corpseInfo: StepInfo = { landed: false, impact: 0, wall: null, dynamicHit: null };

  constructor(colorIndex: number, shadows: boolean, private level: LevelData, private hooks: PlayerHooks) {
    this.model = new CharacterModel(colorIndex, shadows);
  }

  spawn(x: number, y: number, z: number, yaw: number) {
    this.motor.body.height = 1.75;
    this.motor.spawn(x, y, z, yaw);
    this.prev.set(x, y, z); this.cur.set(x, y, z); this.renderPos.set(x, y, z);
    this.prevYaw = yaw; this.renderYaw = yaw;
    this.dead = false; this.finished = false; this.doomed = false;
    this.acc = 0; this.stepSmooth = 0; this.lastGround = -1;
    this.anim = Anim.Idle;
    this.model.root.visible = true;
  }

  teleport(x: number, y: number, z: number) {
    const b = this.motor.body;
    b.pos.x = x; b.pos.y = y; b.pos.z = z;
    b.vel.x = b.vel.y = b.vel.z = 0;
    b.grounded = false;
    this.motor.zip = null;
    this.motor.grapple = null;
    this.motor.launched = false;
    this.prev.set(x, y, z); this.cur.set(x, y, z);
    this.motor.lastGroundY = y;
    this.doomed = false;
  }

  queueJump() { this.jumpQueued = true; }

  /** Which level's lasers, gusts and floor this runner answers to (the course, or the Warden's arena). */
  setLevel(level: LevelData) { this.level = level; }

  /** A blink: the body is somewhere else at once, keeping its speed; no smoothing across the gap. */
  blink(x: number, y: number, z: number) {
    this.motor.blink(x, y, z);
    this.prev.set(x, y, z); this.cur.set(x, y, z); this.renderPos.set(x, y, z);
    this.stepSmooth = 0;
    this.doomed = false;
  }

  /** Killed: the body is thrown and keeps obeying physics (falls, slides, rides platforms). */
  die(impulse?: [number, number, number]) {
    const b = this.motor.body;
    this.dead = true;
    this.motor.flying = false;
    this.motor.zip = null;
    this.motor.grapple = null;
    this.motor.launched = false;
    b.height = CORPSE.HEIGHT;
    if (impulse) { b.vel.x = impulse[0]; b.vel.y = impulse[1]; b.vel.z = impulse[2]; }
    else { b.vel.x *= CORPSE.KEEP; b.vel.z *= CORPSE.KEEP; }
    b.ext.x = b.ext.y = b.ext.z = 0;
  }

  /** Shoved by a hit (a shield soaking it, or a blow in the arena). */
  shove(v: [number, number, number]) {
    const b = this.motor.body;
    b.ext.x += v[0]; b.ext.z += v[2];
    if (v[1] > 0 && (b.grounded || b.vel.y < v[1])) { b.vel.y = Math.max(b.vel.y, v[1]); b.grounded = false; b.ground = null; }
  }
  /** Hook this anchor on the next physics step. */
  requestGrapple(id: number) { this.grappleReq = id; }
  /** Let go of the rope on the next physics step. */
  requestRelease() { this.releaseReq = true; }
  /** Take off or land on the next physics step (only a runner who can fly). */
  requestFlyToggle() { this.flyReq = true; }

  update(dt: number, input: MoveInput, world: CollisionWorld, matchTime: number) {
    const m = this.motor, b = m.body;
    const active = !this.frozen && !this.dead && !this.finished;
    const inp: MoveInput = active ? input : { x: 0, z: 0, sprint: false, jumpHeld: false, jumpPressed: false };
    // feed presses straight into the motor's jump buffer so none are lost on
    // render frames that do not run a physics step (high refresh rate displays)
    if (active && (input.jumpPressed || this.jumpQueued)) m.pressJump();
    if (active && input.slidePressed) m.pressSlide();
    // a dash asked for on a frame with no physics step waits for the next one
    if (active && (input.dashX || input.dashZ)) { this.dashReqX = input.dashX ?? 0; this.dashReqZ = input.dashZ ?? 0; }
    this.jumpQueued = false;
    inp.jumpPressed = false;
    inp.slidePressed = false;
    if (!active) { this.grappleReq = -1; this.releaseReq = false; this.dashReqX = this.dashReqZ = 0; this.flyReq = false; }


    this.acc = Math.min(this.acc + dt, 0.25);
    let stepT = matchTime - this.acc;
    while (this.acc >= PHYS.STEP) {
      stepT += PHYS.STEP;
      this.acc -= PHYS.STEP;
      world.update(stepT);
      this.prev.set(b.pos.x, b.pos.y, b.pos.z);
      this.prevYaw = m.yaw;
      if (this.finished || b.pos.y < this.level.killY - 60) continue;
      if (this.dead) {
        // ragdoll: gravity, friction, platform carry, gusts and collisions
        windAt(this.level, b.pos.x, b.pos.y, b.pos.z, stepT, wind);
        stepCorpse(world, b, PHYS.STEP, this.corpseInfo, wind[0], wind[1]);
        if (this.corpseInfo.landed && this.corpseInfo.impact > 4) this.hooks.bodyLanded(this.corpseInfo.impact);
        continue;
      }
      const stepInput = inp;
      // grapple requests go to the first physics step only
      inp.grapple = this.grappleReq; inp.grappleRelease = this.releaseReq;
      inp.dashX = this.dashReqX; inp.dashZ = this.dashReqZ;
      inp.flyToggle = this.flyReq;
      this.flyReq = false;
      this.grappleReq = -1; this.releaseReq = false;
      this.dashReqX = this.dashReqZ = 0;
      if (this.sanctuary) { wind[0] = 0; wind[1] = 0; } else windAt(this.level, b.pos.x, b.pos.y, b.pos.z, stepT, wind);
      const beforeY = b.pos.y;
      const wasGrounded = b.grounded;
      m.step(world, PHYS.STEP, stepInput, wind[0], wind[1]);
      const ev = m.events;
      if (ev.jumped) this.hooks.jump();
      if (ev.mantled) this.hooks.mantle();
      if (ev.launched >= 0) this.hooks.launched(ev.launched);
      if (ev.zipOn >= 0) this.hooks.zipOn();
      if (ev.zipOff >= 0) this.hooks.zipOff();
      if (ev.slid) this.hooks.slid();
      if (ev.hooked >= 0) this.hooks.hooked(ev.hooked);
      if (ev.unhooked) this.hooks.unhooked();
      if (ev.flipped) this.hooks.flipped();
      if (ev.dashed !== 0) this.hooks.dashed(ev.dashed);
      if (ev.flew !== 0) this.hooks.flew(ev.flew);
      if (ev.slammed > 0) this.hooks.slammed(ev.slammed);
      if (ev.flashed) this.hooks.flashed(m.flashFrom);
      if (!this.frozen && !this.dead && !this.immune && !this.sanctuary && stepT >= this.laserGraceUntil && this.level.lasers.length
        && laserHit(this.level, b.pos.x, b.pos.y, b.pos.z, stepT, b.radius, b.height - 0.1)) {
        this.hooks.laser();
      }
      if (ev.landed) {
        this.hooks.land(ev.impact, ev.surface);
        if (wasGrounded && b.grounded) this.stepSmooth += beforeY - b.pos.y;
      } else if (wasGrounded && b.grounded && Math.abs(b.pos.y - beforeY) > 0.12 && !(b.ground?.isDynamic)) {
        // stepped up/down a ledge: smooth the visual pop
        this.stepSmooth += beforeY - b.pos.y;
      }
      const gid = b.grounded && b.ground ? b.ground.id : -1;
      if (gid !== this.lastGround) { this.lastGround = gid; if (gid >= 0) this.hooks.groundChanged(gid); }
    }
    this.cur.set(b.pos.x, b.pos.y, b.pos.z);

    if (b.grounded && !this.dead) this.doomed = false;
    // doomed fall detection (presentation only; the server decides death)
    if (!this.doomed && !b.grounded && !m.mantleActive && b.pos.y < m.lastGroundY - DEATH.FALL_DROP * 0.75) {
      if (!isFinite(world.groundBelow(b.pos.x, b.pos.y, b.pos.z, 500))) {
        this.doomed = true;
        this.doomedAt.set(b.pos.x, m.lastGroundY + 3, b.pos.z);
      }
    }

    // render interpolation
    const alpha = this.acc / PHYS.STEP;
    this.renderPos.lerpVectors(this.prev, this.cur, alpha);
    this.stepSmooth *= Math.exp(-dt * 16);
    this.renderPos.y += this.stepSmooth;
    const belt = b.grounded && b.ground?.def.belt ? 1 : 0;
    this.renderVel.set(b.vel.x + b.ext.x + m.platVel.x * belt, b.vel.y, b.vel.z + b.ext.z + m.platVel.z * belt);
    if (m.zip) this.renderVel.set(m.zipDir.x * m.zipSpeed, m.zipDir.y * m.zipSpeed, m.zipDir.z * m.zipSpeed);
    const yaw = this.prevYaw + wrap(m.yaw - this.prevYaw) * alpha;
    this.yawRate = wrap(yaw - this.renderYaw) / Math.max(dt, 1e-3);
    this.renderYaw = yaw;

    // animation
    this.anim = this.dead ? Anim.Dead : this.finished ? Anim.Finished : this.poseOverride ?? m.anim;
    const hs = m.zip ? m.zipSpeed : Math.hypot(b.vel.x, b.vel.z);
    this.model.root.position.copy(this.renderPos);
    this.model.root.position.y += this.lift;
    this.model.root.rotation.y = this.renderYaw;
    const local = localDir(b.vel.x, b.vel.z, this.renderYaw);
    this.model.update({
      speed: this.frozen ? 0 : hs, vy: b.vel.y, anim: this.anim, dt, turn: this.yawRate,
      land: m.landAnim, t: matchTime, fwd: local[0], side: local[1],
      vel: b.vel, grounded: b.grounded,
    });

    // footsteps from the run cycle
    if (b.grounded && hs > 1.2 && !this.dead) {
      const stepIdx = Math.floor(this.model.phase / Math.PI);
      if (stepIdx !== this.lastPhaseStep) {
        this.lastPhaseStep = stepIdx;
        this.hooks.footstep(b.ground?.def.mat ?? 'concrete', hs);
      }
    }
  }

  get pos() { return this.motor.body.pos; }
  get grounded() { return this.motor.body.grounded; }
  get groundId() { return this.motor.body.grounded && this.motor.body.ground ? this.motor.body.ground.id : -1; }
}

/** Splits a world-space velocity into the runner's own forward / right axes. */
export function localDir(vx: number, vz: number, yaw: number): [number, number] {
  const hs = Math.hypot(vx, vz);
  if (hs < 0.2) return [1, 0];
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  return [(vx * sy + vz * cy) / hs, (vx * -cy + vz * sy) / hs];
}

function wrap(a: number) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

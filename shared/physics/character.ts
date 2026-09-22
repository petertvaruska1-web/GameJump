// Arcade character controller: cylinder vs world, step-up, ground snap,
// coyote time, jump buffering, jump cut, air control, auto-mantle/vault,
// ledge climbing, sliding, front flips, sideways dashes, grapple swinging,
// boosted running and jumping, moving-platform and conveyor carry, launch pads, zip
// lines and external pushes (wind, sweepers).

import { CLIMB, CORPSE, DASH, FLIP, GRAPPLE, LAUNCH, PHYS, PLAYER, POWER, SLIDE, ZIP } from '../constants';
import { zipGrab, zipLength } from '../hazards';
import type { GrappleDef, LaunchDef, ZiplineDef } from '../level/types';
import { approachAngle, clamp, damp, lerp, v3, wrapAngle, type Vec3 } from '../math';
import type { Collider, CollisionWorld, GroundHit, RayHit } from './world';

export interface CharBody {
  pos: Vec3;
  vel: Vec3;
  /** External velocity (wind, knockback) that decays on its own. */
  ext: Vec3;
  grounded: boolean;
  ground: Collider | null;
  radius: number;
  height: number;
}

export const makeBody = (radius = PLAYER.RADIUS, height = PLAYER.HEIGHT): CharBody => ({
  pos: v3(), vel: v3(), ext: v3(), grounded: false, ground: null, radius, height,
});

export interface StepInfo {
  landed: boolean;
  impact: number;
  wall: Collider | null;
  dynamicHit: Collider | null;
}

const gh: GroundHit = { top: 0, c: null };
const gh2: GroundHit = { top: 0, c: null };
const tmpV = v3();
const rayTmp: RayHit = { dist: 0, c: null };

/** Displacement of a point carried by a kinematic collider since its last update. */
export function carryDelta(c: Collider, x: number, z: number, out: Vec3): Vec3 {
  if (c.kind === 'sweeper') {
    const d = c.ry - c.pry;
    const px = c.def.p[0], pz = c.def.p[2];
    const rx = x - px, rz = z - pz;
    const cs = Math.cos(d), sn = Math.sin(d);
    out.x = rx * cs + rz * sn - rx;
    out.z = -rx * sn + rz * cs - rz;
    out.y = 0;
  } else {
    out.x = c.cx - c.pcx; out.y = c.cy - c.pcy; out.z = c.cz - c.pcz;
  }
  return out;
}

/**
 * Moves a body through the world for one fixed step. Velocity must already
 * include gravity. `jumped` disables ground snapping for this step.
 */
export function stepBody(world: CollisionWorld, b: CharBody, dt: number, jumped: boolean, info: StepInfo): StepInfo {
  info.landed = false; info.impact = 0; info.wall = null; info.dynamicHit = null;
  const wasGrounded = b.grounded && !jumped;
  const r = b.radius;

  // Horizontal
  b.pos.x += (b.vel.x + b.ext.x) * dt;
  b.pos.z += (b.vel.z + b.ext.z) * dt;
  const lift = wasGrounded ? PLAYER.STEP_HEIGHT : PLAYER.AIR_STEP;
  info.wall = world.pushCircle(b.pos, r, b.height, b.pos.y + lift, b.vel, (c) => { info.dynamicHit = c; });
  if (info.wall) { b.ext.x *= 0.6; b.ext.z *= 0.6; }

  // Vertical
  const oldY = b.pos.y;
  const vy = b.vel.y + b.ext.y;
  let newY = oldY + vy * dt;
  const gr = r * PLAYER.GROUND_RADIUS_FACTOR;
  if (vy > 0) {
    const ceil = world.ceilingProbe(b.pos.x, b.pos.z, r * 0.85, oldY + b.height);
    if (newY + b.height > ceil) {
      newY = Math.max(oldY, ceil - b.height);
      b.vel.y = Math.min(b.vel.y, 0);
      b.ext.y = 0;
    }
    b.pos.y = newY;
    b.grounded = false; b.ground = null;
    // Still rising, but over stairs or a ramp that climbs faster than you do (a
    // sprint jump, or a front flip, up a steep flight): the slope catches your
    // feet. Left alone they sank into it until it counted as a wall, which
    // shoved you off the side or through the gap beneath it.
    world.groundProbe(b.pos.x, b.pos.z, gr, oldY + PLAYER.AIR_STEP, gh);
    if (gh.c && gh.c.rise !== 0 && gh.top >= newY) {
      info.landed = true; info.impact = 0;
      b.pos.y = gh.top;
      b.vel.y = 0; b.ext.y = 0;
      b.grounded = true; b.ground = gh.c;
    }
  } else {
    const probeTop = oldY + (wasGrounded ? PLAYER.STEP_HEIGHT : PLAYER.AIR_STEP);
    world.groundProbe(b.pos.x, b.pos.z, gr, probeTop, gh);
    const snap = wasGrounded ? PLAYER.GROUND_SNAP : 0;
    if (gh.c && gh.top >= newY - snap) {
      if (!b.grounded || jumped) { info.landed = true; info.impact = -vy; }
      b.pos.y = gh.top;
      b.vel.y = 0; b.ext.y = 0;
      b.grounded = true; b.ground = gh.c;
    } else {
      b.pos.y = newY;
      b.grounded = false; b.ground = null;
    }
  }
  return info;
}

/**
 * One step of a dead body: gravity, ground friction, moving-platform carry, sweeper
 * knocks and world collisions. The client runs this for its own body and the server
 * for everyone's, so a runner shot on a mover drops when the mover leaves.
 */
export function stepCorpse(world: CollisionWorld, b: CharBody, dt: number, info: StepInfo, windX = 0, windZ = 0): StepInfo {
  if (b.grounded && b.ground && b.ground.isDynamic) {
    carryDelta(b.ground, b.pos.x, b.pos.z, tmpV);
    b.pos.x += tmpV.x; b.pos.y += tmpV.y; b.pos.z += tmpV.z;
  } else if (b.grounded && b.ground && b.ground.def.belt) {
    // conveyors carry bodies away too
    const bs = b.ground.def.belt;
    b.pos.x += b.ground.sin * bs * dt; b.pos.z += b.ground.cos * bs * dt;
  }
  // gusts tug at a falling body
  if (!b.grounded) { b.ext.x += windX * 0.6 * dt; b.ext.z += windZ * 0.6 * dt; }
  const ed = damp(b.grounded ? 3 : 0.9, dt);
  b.ext.x -= b.ext.x * ed; b.ext.z -= b.ext.z * ed; b.ext.y -= b.ext.y * damp(3, dt);
  const v = b.vel;
  const g = PHYS.GRAVITY * (v.y < 0 ? PHYS.FALL_GRAVITY_MULT : 1);
  v.y = Math.max(v.y - g * dt, -PHYS.MAX_FALL_SPEED);
  if (b.grounded) {
    const hs = Math.hypot(v.x, v.z);
    if (hs > 0.01) {
      const k = Math.max(0, hs - CORPSE.FRICTION * dt) / hs;
      v.x *= k; v.z *= k;
    }
  }
  stepBody(world, b, dt, false, info);
  // a sweeper arm sends the body flying
  if (info.dynamicHit && info.dynamicHit.kind === 'sweeper') {
    info.dynamicHit.pointVelocity(b.pos.x, b.pos.z, dt, tmpV);
    v.x += tmpV.x * 1.2; v.z += tmpV.z * 1.2;
    if (b.grounded) { v.y = 4; b.grounded = false; b.ground = null; }
  }
  return info;
}

export interface MoveInput {
  /** World-space desired move direction, magnitude 0..1. */
  x: number;
  z: number;
  sprint: boolean;
  jumpHeld: boolean;
  jumpPressed: boolean;
  /** Slide key pressed this step. */
  slidePressed?: boolean;
  /** Dash this step: world-space unit direction across your path (0,0 = none). */
  dashX?: number;
  dashZ?: number;
  /**
   * Where the player is looking (camera yaw). When given, the runner faces this
   * while moving and strafes sideways instead of turning its whole body into
   * every sideways step, the way third-person action games do it. Tools that
   * leave it out get the old "face the way you are travelling" behaviour.
   */
  aimYaw?: number;
  /** Grapple anchor to hook this step (-1 / undefined: none). */
  grapple?: number;
  /** Let go of the grapple rope this step. */
  grappleRelease?: boolean;
}

export const Anim = {
  Idle: 0,
  Run: 1,
  Sprint: 2,
  Jump: 3,
  Fall: 4,
  Mantle: 5,
  Land: 6,
  Dead: 7,
  Finished: 8,
  Zip: 9,
  Launch: 10,
  Slide: 11,
  Swing: 12,
  Flip: 13,
  DashL: 14,
  DashR: 15,
} as const;
export type Anim = (typeof Anim)[keyof typeof Anim];

export interface MotorEvents {
  jumped: boolean;
  landed: boolean;
  impact: number;
  mantled: boolean;
  surface: string;
  /** Thrown by a launch pad this step (collider id, else -1). */
  launched: number;
  /** Grabbed a zip line this step (id, else -1). */
  zipOn: number;
  /** Let go of / reached the end of a zip line this step (id, else -1). */
  zipOff: number;
  /** Started a slide this step. */
  slid: boolean;
  /** Hooked a grapple anchor this step (id, else -1). */
  hooked: number;
  /** Let go of a grapple rope this step. */
  unhooked: boolean;
  /** Started a front flip this step. */
  flipped: boolean;
  /** Started a dash this step (-1 left, 1 right, 0 none). */
  dashed: number;
}

export class PlayerMotor {
  readonly body = makeBody();
  yaw = 0;
  coyote = 0;
  jumpBuffer = 0;
  jumpCutReady = false;
  landSlow = 0;
  airTime = 0;
  /** Air ledge-grabs only rescue deliberate jumps, not running off an edge. */
  jumpedThisAir = false;
  /** Height of the last surface we stood on (fall-death detection). */
  lastGroundY = 0;
  anim: Anim = Anim.Idle;
  landAnim = 0;
  /** Current turning speed of the body (rad/s); the facing accelerates into turns. */
  yawVel = 0;
  readonly platVel = v3();
  readonly events: MotorEvents = {
    jumped: false, landed: false, impact: 0, mantled: false, surface: '', launched: -1, zipOn: -1, zipOff: -1,
    slid: false, hooked: -1, unhooked: false, flipped: false, dashed: 0,
  };

  /** Sliding: low body, locked direction, decaying speed. */
  sliding = false;
  slideSpeed = 0;
  private slideDirX = 0;
  private slideDirZ = 0;
  private slideT = 0;
  private slideCooldown = 0;
  private slideBuffer = 0;
  /** Current grapple anchor (null when not hooked) and rope length. */
  grapple: GrappleDef | null = null;
  ropeLen = 0;
  /** Last anchor let go of (tools use it to know a swing happened). */
  lastGrapple = -1;
  /** Rope length at the moment of hooking (the reel-in target is a share of it). */
  private hookLen = 0;
  /** Time since hooking (a jump inside RELEASE_LOCK must not drop the rope). */
  private hookT = 0;
  private grappleAir = false;
  private grappleCooldown = 0;
  /** Delay before the next deliberate ledge climb. */
  private climbCooldown = 0;
  /** How long forward has been held into a wall (the ground climb waits for it). */
  private wallPush = 0;
  /** Mid front flip (the rotation is cosmetic; the boost is applied on take-off). */
  flipping = false;
  flipT = 0;
  private flippedThisAir = false;
  /** Mid dash, and which side it went (-1 left, 1 right). */
  dashing = false;
  dashSide = 0;
  private dashT = 0;
  private dashDirX = 0;
  private dashDirZ = 0;
  private dashKeepX = 0;
  private dashKeepZ = 0;
  private dashAir = false;
  private airDashUsed = false;
  /** Boost power: faster running and longer jumps while true. */
  boost = false;

  /** In flight after a launch pad: no air drag, reduced air control. */
  launched = false;
  /** Current zip line (null when not riding). */
  zip: ZiplineDef | null = null;
  zipS = 0;
  zipSpeed = 0;
  /** Last cable ridden (tools use it to know a ride happened). */
  lastZip = -1;
  private zipLen = 0;
  /** Unit direction of the current cable (valid while riding). */
  readonly zipDir = v3();
  private zipCooldown = 0;
  private zipT = 0;

  mantleActive = false;
  private mantleT = 0;
  private mantleDur = 0;
  private readonly mFrom = v3();
  private readonly mTo = v3();
  private mSpeed = 0;
  private mDirX = 0;
  private mDirZ = 0;
  private mGround: Collider | null = null;
  private readonly info: StepInfo = { landed: false, impact: 0, wall: null, dynamicHit: null };
  private readonly carry = v3();

  /**
   * Registers a jump press immediately. Render frames can run faster than the
   * physics step, so a press must be buffered here rather than passed only to
   * the next step (otherwise presses on step-less frames are lost).
   */
  pressJump() { this.jumpBuffer = PLAYER.JUMP_BUFFER; }
  /** Free to hook an anchor (not hooked, not right after letting go). */
  get canHook() { return !this.grapple && this.grappleCooldown <= 0; }
  /** Same idea for the slide key. */
  pressSlide() { this.slideBuffer = SLIDE.BUFFER; }

  spawn(x: number, y: number, z: number, yaw: number) {
    const b = this.body;
    b.pos.x = x; b.pos.y = y; b.pos.z = z;
    b.vel.x = b.vel.y = b.vel.z = 0;
    b.ext.x = b.ext.y = b.ext.z = 0;
    b.grounded = false; b.ground = null;
    this.yaw = yaw;
    this.mantleActive = false;
    this.lastGroundY = y;
    this.airTime = 0;
    this.anim = Anim.Idle;
    this.launched = false;
    this.zip = null;
    this.lastZip = -1;
    this.zipCooldown = 0;
    this.sliding = false;
    b.height = PLAYER.HEIGHT;
    this.slideCooldown = 0; this.slideBuffer = 0;
    this.grapple = null;
    this.grappleCooldown = 0;
    this.climbCooldown = 0;
    this.wallPush = 0;
    this.yawVel = 0;
    this.flipping = false;
    this.flipT = 0;
    this.flippedThisAir = false;
    this.dashing = false;
    this.dashSide = 0;
    this.airDashUsed = false;
  }

  step(world: CollisionWorld, dt: number, inp: MoveInput, windX = 0, windZ = 0) {
    const b = this.body;
    const ev = this.events;
    ev.jumped = false; ev.landed = false; ev.impact = 0; ev.mantled = false;
    ev.launched = -1; ev.zipOn = -1; ev.zipOff = -1;
    ev.slid = false; ev.hooked = -1; ev.unhooked = false;
    ev.flipped = false; ev.dashed = 0;
    if (this.flipping) { this.flipT += dt; if (this.flipT >= FLIP.TIME) this.flipping = false; }
    if (this.zipCooldown > 0) this.zipCooldown -= dt;
    if (this.slideCooldown > 0) this.slideCooldown -= dt;
    if (this.grappleCooldown > 0) this.grappleCooldown -= dt;
    if (this.climbCooldown > 0) this.climbCooldown -= dt;
    if (this.grapple) this.hookT += dt;
    if (inp.slidePressed) this.slideBuffer = SLIDE.BUFFER; else this.slideBuffer -= dt;

    // Moving platform / conveyor carry
    if (b.grounded && b.ground && b.ground.isDynamic) {
      carryDelta(b.ground, b.pos.x, b.pos.z, this.carry);
      b.pos.x += this.carry.x; b.pos.y += this.carry.y; b.pos.z += this.carry.z;
      this.platVel.x = this.carry.x / dt; this.platVel.y = this.carry.y / dt; this.platVel.z = this.carry.z / dt;
      if (b.ground.kind === 'sweeper') this.yaw += b.ground.ry - b.ground.pry;
    } else if (b.grounded && b.ground && b.ground.def.belt) {
      const bs = b.ground.def.belt;
      this.platVel.x = b.ground.sin * bs; this.platVel.y = 0; this.platVel.z = b.ground.cos * bs;
      b.pos.x += this.platVel.x * dt; b.pos.z += this.platVel.z * dt;
    } else if (b.grounded) {
      this.platVel.x = this.platVel.y = this.platVel.z = 0;
    }

    if (this.mantleActive) { this.stepMantle(world, dt); return; }
    if (this.zip) { this.stepZip(dt, inp); return; }

    // Grapple: hook an anchor / let go
    if (this.grapple && inp.grappleRelease) this.unhook(true);
    else if (!this.grapple && inp.grapple !== undefined && inp.grapple >= 0 && this.grappleCooldown <= 0) this.hook(world, inp.grapple);

    // Input
    let ix = inp.x, iz = inp.z;
    let mag = Math.hypot(ix, iz);
    if (mag > 1) { ix /= mag; iz /= mag; mag = 1; }
    const dirX = mag > 1e-3 ? ix / mag : 0;
    const dirZ = mag > 1e-3 ? iz / mag : 0;

    if (b.grounded) this.coyote = PLAYER.COYOTE_TIME; else this.coyote -= dt;
    if (inp.jumpPressed) this.pressJump(); else this.jumpBuffer -= dt;
    if (this.landSlow > 0) this.landSlow -= dt;

    const boostK = this.boost ? POWER.BOOST_SPEED : 1;
    const baseSpeed = (inp.sprint ? PLAYER.SPRINT_SPEED : PLAYER.RUN_SPEED) * boostK;
    const v = b.vel;

    // Dash: a short sidestep that owns your horizontal velocity while it runs.
    // No cooldown on the ground; in the air you get one per jump.
    if (this.dashing) {
      this.dashT += dt;
      if (this.dashT >= DASH.TIME || b.grounded === this.dashAir) this.endDash();
      else { v.x = this.dashDirX * DASH.SPEED + this.dashKeepX; v.z = this.dashDirZ * DASH.SPEED + this.dashKeepZ; }
    } else if ((inp.dashX || inp.dashZ) && (b.grounded || !this.airDashUsed)
      && !this.sliding && !this.grapple && !this.zip && !this.flipping && !this.mantleActive) {
      this.startDash(inp.dashX ?? 0, inp.dashZ ?? 0);
    }

    // Slide: start from a run (or right on landing), stand up when slow or on a second press
    if (!this.sliding && this.slideBuffer > 0 && b.grounded && !this.grapple && this.slideCooldown <= 0
      && Math.hypot(v.x, v.z) >= SLIDE.MIN_START) this.startSlide();
    else if (this.sliding && this.slideBuffer > 0 && this.slideT > 0.25 && this.headroom(world)) { this.slideBuffer = 0; this.endSlide(); }

    if (this.sliding && b.grounded) {
      this.slideT += dt;
      if (mag > 0.1) {
        const want = Math.atan2(dirX, dirZ), cur = Math.atan2(this.slideDirX, this.slideDirZ);
        const d = Math.atan2(Math.sin(want - cur), Math.cos(want - cur));
        if (Math.abs(d) < 2.2) {
          const a = approachAngle(cur, want, SLIDE.TURN * dt);
          this.slideDirX = Math.sin(a); this.slideDirZ = Math.cos(a);
        } else this.slideSpeed -= 6 * dt; // holding back brakes
      }
      // slopes: downhill speeds you up, uphill slows you down
      let accel = -SLIDE.FRICTION;
      const gc = b.ground;
      if (gc && gc.rise !== 0) {
        const probe = 0.3;
        const dh = gc.topAt(b.pos.x + this.slideDirX * probe, b.pos.z + this.slideDirZ * probe) - gc.topAt(b.pos.x, b.pos.z);
        const slope = dh / probe;
        accel -= PHYS.GRAVITY * SLIDE.SLOPE_K * (slope / Math.sqrt(1 + slope * slope));
      }
      this.slideSpeed = clamp(this.slideSpeed + accel * dt, 0, SLIDE.MAX);
      const low = !this.headroom(world);
      if (low) this.slideSpeed = Math.max(this.slideSpeed, SLIDE.CRAWL);
      else if (this.slideSpeed < SLIDE.END_SPEED) this.endSlide();
      if (this.sliding) { v.x = this.slideDirX * this.slideSpeed; v.z = this.slideDirZ * this.slideSpeed; }
    } else if (this.sliding) {
      this.endSlide(); // ran off an edge
    }

    if (this.dashing || this.sliding) {
      // velocity already set by the dash / slide
    } else if (b.grounded) {
      let speed = baseSpeed * mag;
      if (this.landSlow > 0) speed *= 0.8;
      const tx = dirX * speed, tz = dirZ * speed;
      let accel = PLAYER.GROUND_ACCEL;
      if (mag < 1e-3) accel = PLAYER.GROUND_DECEL;
      else if (v.x * tx + v.z * tz < 0) accel = PLAYER.GROUND_TURN_ACCEL;
      approach2(v, tx, tz, accel * dt);
    } else if (this.grapple) {
      // swinging: the move keys push along the arc (the part of the input across
      // the rope), so pumping builds the swing instead of fighting the rope
      if (mag > 1e-3) {
        const gp = this.grapple.p;
        let nx = b.pos.x - gp[0], nz = b.pos.z - gp[2];
        const ny = b.pos.y + GRAPPLE.HAND - gp[1];
        const L = Math.hypot(nx, ny, nz) || 1;
        nx /= L; nz /= L;
        const radial = dirX * nx + dirZ * nz;
        let tx = dirX - nx * radial, tz = dirZ - nz * radial;
        const tl = Math.hypot(tx, tz);
        if (tl > 0.2) { tx /= tl; tz /= tl; } else { tx = dirX; tz = dirZ; }
        const push = GRAPPLE.AIR_ACCEL * mag * dt;
        v.x += tx * push; v.z += tz * push;
      }
    } else if (this.launched) {
      // thrown by a launch pad: keep the arc, allow a gentle nudge
      if (mag > 1e-3) {
        const cur = Math.hypot(v.x, v.z);
        approach2(v, dirX * cur, dirZ * cur, LAUNCH.AIR_ACCEL * mag * dt);
      }
    } else if (mag > 1e-3) {
      const cur = Math.hypot(v.x, v.z);
      const speed = Math.max(baseSpeed, cur) * mag;
      approach2(v, dirX * speed, dirZ * speed, PLAYER.AIR_ACCEL * dt);
    } else {
      const k = 1 - PLAYER.AIR_DRAG * dt;
      v.x *= k; v.z *= k;
    }

    // Jump (a jump while hooked lets go of the rope with a little kick)
    let jumped = false;
    if (this.grapple && this.jumpBuffer > 0 && this.hookT >= GRAPPLE.RELEASE_LOCK) { this.jumpBuffer = 0; this.unhook(true); }
    // Space again while in the air: front flip, whenever you press it between
    // take-off and landing. On the way down with the ground close the press is
    // left alone, so it still buffers into a jump the moment you land.
    if (this.jumpBuffer > 0 && !b.grounded && this.coyote <= 0 && !this.flipping && !this.flippedThisAir
      && !this.zip && !this.grapple && !this.sliding && !this.dashing
      && !(v.y < -2 && world.groundBelow(b.pos.x, b.pos.y, b.pos.z, FLIP.NEAR_GROUND) < FLIP.NEAR_GROUND)) {
      this.startFlip();
    }
    const slideJumpOk = !this.sliding || this.headroom(world, 0.35);
    if (this.jumpBuffer > 0 && !this.dashing && (b.grounded || this.coyote > 0) && slideJumpOk) {
      if (this.sliding) {
        // jumping out of a slide keeps its speed, up to a little more than a sprint
        const sp = Math.min(this.slideSpeed, SLIDE.JUMP_MAX * boostK);
        v.x = this.slideDirX * sp; v.z = this.slideDirZ * sp;
        this.endSlide();
      }
      v.y = PLAYER.JUMP_VELOCITY * (this.boost ? POWER.BOOST_JUMP : 1);
      // Inherit platform motion
      v.x += this.platVel.x; v.z += this.platVel.z;
      if (this.platVel.y > 0) v.y += this.platVel.y;
      b.grounded = false; b.ground = null;
      this.coyote = 0; this.jumpBuffer = 0; this.jumpCutReady = true;
      jumped = true; ev.jumped = true;
      this.jumpedThisAir = true;
    }
    if (this.jumpCutReady && !inp.jumpHeld && v.y > 0) { v.y *= PLAYER.JUMP_CUT; this.jumpCutReady = false; }
    if (v.y <= 0) this.jumpCutReady = false;

    // Gravity
    const g = PHYS.GRAVITY * (v.y < 0 ? PHYS.FALL_GRAVITY_MULT : 1);
    v.y = Math.max(v.y - g * dt, -PHYS.MAX_FALL_SPEED);

    // External (wind / knockback)
    const e = b.ext;
    e.x += windX * dt; e.z += windZ * dt;
    const ed = damp(b.grounded ? 2.6 : 1.1, dt);
    e.x -= e.x * ed; e.z -= e.z * ed; e.y -= e.y * damp(3, dt);

    // Rope: an inelastic constraint on the hands (velocity first, then position)
    if (this.grapple) {
      const gp = this.grapple.p;
      // the rope reels itself in to a taut swinging length: the arc tightens and speeds up
      const want = Math.max(GRAPPLE.REEL_MIN, Math.min(this.hookLen, GRAPPLE.MAX_ROPE) * GRAPPLE.TAUT);
      if (this.ropeLen > want) this.ropeLen = Math.max(want, this.ropeLen - GRAPPLE.REEL_SPEED * dt);
      const dx = b.pos.x - gp[0], dy = b.pos.y + GRAPPLE.HAND - gp[1], dz = b.pos.z - gp[2];
      const L = Math.hypot(dx, dy, dz);
      if (L >= this.ropeLen - 0.02 && L > 1e-4) {
        const nx = dx / L, ny = dy / L, nz = dz / L;
        const vr = v.x * nx + v.y * ny + v.z * nz;
        if (vr > 0) { v.x -= nx * vr; v.y -= ny * vr; v.z -= nz * vr; }
      }
      const sp = Math.hypot(v.x, v.y, v.z);
      if (sp > GRAPPLE.MAX_SPEED) { const k = GRAPPLE.MAX_SPEED / sp; v.x *= k; v.y *= k; v.z *= k; }
    }

    const wasGrounded = b.grounded;
    const groundBefore = b.ground;
    const info = stepBody(world, b, dt, jumped, this.info);

    if (this.grapple) {
      const gp = this.grapple.p;
      const dx = b.pos.x - gp[0], dy = b.pos.y + GRAPPLE.HAND - gp[1], dz = b.pos.z - gp[2];
      const L = Math.hypot(dx, dy, dz);
      if (L > this.ropeLen && L > 1e-4) {
        const k = (L - this.ropeLen) / L;
        b.pos.x -= dx * k; b.pos.y -= dy * k; b.pos.z -= dz * k;
      }
      if (!b.grounded) this.grappleAir = true;
      this.lastGroundY = b.pos.y;
      if (b.grounded && this.grappleAir) this.unhook(false);
    }

    // Sliding into a wall: keep the part of the motion along it
    if (this.sliding && info.wall) {
      const hs2 = Math.hypot(v.x, v.z);
      this.slideSpeed = hs2;
      if (hs2 > 0.5) { this.slideDirX = v.x / hs2; this.slideDirZ = v.z / hs2; }
    }

    // Walked off a moving platform or a conveyor: keep its momentum
    if (wasGrounded && !b.grounded && !jumped && (groundBefore?.isDynamic || groundBefore?.def.belt)) {
      v.x += this.platVel.x; v.z += this.platVel.z;
      this.platVel.x = this.platVel.y = this.platVel.z = 0;
    }

    // Pushed by a sweeper arm: knockback
    if (info.dynamicHit && info.dynamicHit.kind === 'sweeper') {
      info.dynamicHit.pointVelocity(b.pos.x, b.pos.z, dt, tmpV);
      e.x += tmpV.x * 1.25; e.z += tmpV.z * 1.25;
      if (b.grounded) { v.y = 4.6; b.grounded = false; b.ground = null; }
      if (this.sliding) this.endSlide();
    }

    if (info.landed) {
      ev.landed = true; ev.impact = info.impact;
      if (info.impact > PLAYER.HARD_LANDING_SPEED) this.landSlow = PLAYER.HARD_LANDING_SLOW;
      this.landAnim = Math.min(1, info.impact / 20);
    }
    if (b.grounded) {
      this.airTime = 0;
      this.jumpedThisAir = false;
      this.flippedThisAir = false;
      this.flipping = false;
      this.airDashUsed = false;
      this.launched = false;
      this.lastGroundY = b.pos.y;
      ev.surface = b.ground?.def.mat ?? '';
      const pad = b.ground?.def.launch;
      if (pad && !jumped) { this.launch(pad, b.ground!.id); return; }
    } else {
      this.airTime += dt;
      if (!this.grapple) this.tryZip(world);
      if (this.zip) return;
    }

    // Holding forward into a ledge pulls you over it: the quick vault / ledge grab
    // for anything up to waist height, and the slower climb above that (in the air
    // this is what catches you when a jump comes up short).
    let pushing = false;
    if (mag > 0.3 && !this.sliding && !this.grapple && !this.flipping && !this.dashing) {
      const toward = v.x * dirX + v.z * dirZ;
      if (!b.grounded && v.y < 2.5 && toward > -0.5) {
        // in the air there is no wait: a jump that comes up short grabs the lip
        if (!this.tryMantle(world, dirX, dirZ, false) && this.climbCooldown <= 0) this.tryClimb(world, dirX, dirZ);
      } else if (b.grounded && info.wall && toward > -0.5 && Math.hypot(v.x, v.z) < CLIMB.PUSH_SPEED
        && !this.tryMantle(world, dirX, dirZ, true)) {
        // on the ground it has to have stopped you, and you have to lean on it for
        // a moment: brushing along a wall or a railing at speed never climbs it
        pushing = true;
        this.wallPush += dt;
        if (this.wallPush >= CLIMB.PUSH_TIME && this.climbCooldown <= 0) this.tryClimb(world, dirX, dirZ);
      }
    }
    if (!pushing) this.wallPush = 0;

    // Facing. With a camera yaw the runner squares up to where you are looking and
    // strafes sideways, the way third-person action games do it -- stepping left or
    // right no longer swings the whole body around. Standing still it keeps its
    // heading until the camera has come most of the way round behind it.
    const hs = Math.hypot(v.x, v.z);
    let want2 = 0, maxRate = 0;
    if (this.dashing) { /* a sidestep does not turn the body */ }
    else if (inp.aimYaw !== undefined) {
      const err = Math.abs(wrapAngle(inp.aimYaw - this.yaw));
      if (mag > 0.1 || !b.grounded) { want2 = inp.aimYaw; maxRate = PLAYER.TURN_RATE; }
      else if (err > 1.9) { want2 = inp.aimYaw; maxRate = PLAYER.TURN_RATE * 0.4; }
    }
    else if (b.grounded && hs > 0.6) { want2 = Math.atan2(v.x, v.z); maxRate = PLAYER.TURN_RATE * clamp(hs / 3, 0.4, 1.2); }
    else if (!b.grounded && mag > 0.1) { want2 = Math.atan2(dirX, dirZ); maxRate = PLAYER.AIR_TURN_RATE; }
    if (maxRate > 0) {
      const target = clamp(wrapAngle(want2 - this.yaw) * 9, -maxRate, maxRate);
      this.yawVel += clamp(target - this.yawVel, -PLAYER.TURN_ACCEL * dt, PLAYER.TURN_ACCEL * dt);
    } else {
      this.yawVel -= this.yawVel * damp(7, dt);
    }
    this.yaw += this.yawVel * dt;

    this.landAnim = Math.max(0, this.landAnim - dt * 4);
    this.updateAnim(hs, inp.sprint);
  }

  /** Room to stand up (or to jump, with `extra`) above the sliding body. */
  private headroom(world: CollisionWorld, extra = 0): boolean {
    const b = this.body;
    return world.ceilingProbe(b.pos.x, b.pos.z, b.radius * 0.9, b.pos.y + b.height) >= b.pos.y + PLAYER.HEIGHT + extra + 0.02;
  }

  private startSlide() {
    const b = this.body, v = b.vel;
    const hs = Math.hypot(v.x, v.z);
    this.sliding = true;
    this.slideT = 0;
    this.slideBuffer = 0;
    this.slideDirX = v.x / hs; this.slideDirZ = v.z / hs;
    this.slideSpeed = Math.max(hs, Math.min(Math.max(hs, PLAYER.RUN_SPEED) + SLIDE.BOOST, SLIDE.MAX_START));
    b.height = SLIDE.HEIGHT;
    this.landSlow = 0;
    this.events.slid = true;
    this.anim = Anim.Slide;
  }

  private endSlide() {
    this.sliding = false;
    this.body.height = PLAYER.HEIGHT;
    this.slideCooldown = SLIDE.COOLDOWN;
  }

  /**
   * Front flip: a tuck that adds a little speed along the way you are already
   * going. The lift is clamped to a normal take-off, so it lengthens a jump
   * rather than raising it, and only one flip fits in an airtime.
   */
  private startFlip() {
    const b = this.body, v = b.vel;
    const hs = Math.hypot(v.x, v.z);
    const dx = hs > 0.5 ? v.x / hs : Math.sin(this.yaw);
    const dz = hs > 0.5 ? v.z / hs : Math.cos(this.yaw);
    v.x += dx * FLIP.PUSH; v.z += dz * FLIP.PUSH;
    v.y = Math.min(v.y + FLIP.LIFT, PLAYER.JUMP_VELOCITY * (this.boost ? POWER.BOOST_JUMP : 1));
    this.flipping = true;
    this.flipT = 0;
    this.flippedThisAir = true;
    this.jumpBuffer = 0;
    this.jumpCutReady = false;
    this.jumpedThisAir = true;
    this.yaw = Math.atan2(dx, dz);
    this.yawVel = 0;
    this.events.flipped = true;
    this.anim = Anim.Flip;
  }

  /**
   * Sideways dash. On the ground it is a burst across the way you are facing,
   * carrying half the speed you had. In the air it is thrown square across your
   * flight path -- never along it -- and the jump itself continues underneath, so
   * an air dash moves you aside without ever carrying a jump further.
   */
  private startDash(dx: number, dz: number) {
    const b = this.body, v = b.vel;
    let ux = dx, uz = dz;
    const d = Math.hypot(ux, uz) || 1;
    ux /= d; uz /= d;
    this.dashAir = !b.grounded;
    if (this.dashAir) {
      this.airDashUsed = true;
      const hs = Math.hypot(v.x, v.z);
      if (hs > 1.5) {
        // strip out anything along the flight path
        const fx = v.x / hs, fz = v.z / hs;
        const along = ux * fx + uz * fz;
        const px = ux - fx * along, pz = uz - fz * along;
        const pl = Math.hypot(px, pz);
        if (pl > 0.2) { ux = px / pl; uz = pz / pl; }
        this.dashKeepX = v.x; this.dashKeepZ = v.z;
      } else { this.dashKeepX = 0; this.dashKeepZ = 0; }
    } else {
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      const along = (v.x * fx + v.z * fz) * DASH.KEEP;
      this.dashKeepX = fx * along; this.dashKeepZ = fz * along;
    }
    this.dashDirX = ux; this.dashDirZ = uz;
    this.dashSide = ux * -Math.cos(this.yaw) + uz * Math.sin(this.yaw) > 0 ? 1 : -1;
    this.dashing = true;
    this.dashT = 0;
    this.jumpBuffer = 0;
    this.events.dashed = this.dashSide;
    this.anim = this.dashSide < 0 ? Anim.DashL : Anim.DashR;
  }

  /**
   * A ground dash ends at running speed and an air dash hands the jump back, so
   * neither can be turned into a longer jump.
   */
  private endDash() {
    this.dashing = false;
    const v = this.body.vel;
    if (this.dashAir) {
      v.x = this.dashKeepX + this.dashDirX * DASH.SPEED * DASH.AIR_RESIDUAL;
      v.z = this.dashKeepZ + this.dashDirZ * DASH.SPEED * DASH.AIR_RESIDUAL;
    } else {
      const hs = Math.hypot(v.x, v.z);
      if (hs > PLAYER.SPRINT_SPEED) { const k = PLAYER.SPRINT_SPEED / hs; v.x *= k; v.z *= k; }
    }
  }

  /**
   * Hooks an anchor if it is in range and nothing blocks the rope. The hook yanks
   * you toward the anchor and off your feet, so hooking from a standstill starts a
   * swing instead of leaving you dangling under a slack rope.
   */
  private hook(world: CollisionWorld, id: number) {
    const g = world.grapples[id];
    if (!g) return;
    const b = this.body;
    const hx = b.pos.x, hy = b.pos.y + GRAPPLE.HAND, hz = b.pos.z;
    const dx = g.p[0] - hx, dy = g.p[1] - hy, dz = g.p[2] - hz;
    const d = Math.hypot(dx, dy, dz);
    if (d > GRAPPLE.RANGE || d < GRAPPLE.MIN_RANGE) return;
    world.raycast(hx, hy, hz, dx / d, dy / d, dz / d, d - 0.5, false, rayTmp);
    if (rayTmp.c) return;
    if (this.sliding) this.endSlide();
    this.grapple = g;
    this.ropeLen = Math.max(GRAPPLE.MIN_ROPE, d);
    this.hookLen = this.ropeLen;
    this.hookT = 0;
    const v = b.vel;
    const nx = dx / d, ny = dy / d, nz = dz / d;
    const along = v.x * nx + v.y * ny + v.z * nz;
    if (along < GRAPPLE.PULL) {
      const add = GRAPPLE.PULL - along;
      v.x += nx * add; v.y += ny * add * 0.55; v.z += nz * add;
    }
    if (b.grounded) { v.y = Math.max(v.y, GRAPPLE.PULL_LIFT); b.grounded = false; b.ground = null; }
    const sp = Math.hypot(v.x, v.y, v.z);
    if (sp > GRAPPLE.MAX_SPEED) { const k = GRAPPLE.MAX_SPEED / sp; v.x *= k; v.y *= k; v.z *= k; }
    this.grappleAir = true;
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.launched = false;
    this.jumpedThisAir = true;
    this.events.hooked = g.id;
    this.anim = Anim.Swing;
  }

  private unhook(kick: boolean) {
    const v = this.body.vel;
    if (kick && v.y < 9) v.y += GRAPPLE.RELEASE_VY;
    this.lastGrapple = this.grapple ? this.grapple.id : -1;
    this.grapple = null;
    this.grappleCooldown = GRAPPLE.COOLDOWN;
    this.coyote = 0;
    this.jumpedThisAir = true;
    this.events.unhooked = true;
  }

  /** Throws the body in an arc from where it stands onto the pad's target. */
  private launch(pad: LaunchDef, id: number) {
    const b = this.body;
    if (this.sliding) this.endSlide();
    const g = PHYS.GRAVITY, gd = PHYS.GRAVITY * PHYS.FALL_GRAVITY_MULT;
    const peak = Math.max(b.pos.y, pad.to[1]) + pad.apex;
    const vy = Math.sqrt(2 * g * (peak - b.pos.y));
    const T = vy / g + Math.sqrt((2 * (peak - pad.to[1])) / gd);
    b.vel.x = (pad.to[0] - b.pos.x) / T;
    b.vel.z = (pad.to[2] - b.pos.z) / T;
    b.vel.y = vy;
    b.ext.x = b.ext.y = b.ext.z = 0;
    b.grounded = false; b.ground = null;
    this.platVel.x = this.platVel.y = this.platVel.z = 0;
    this.coyote = 0; this.jumpBuffer = 0;
    this.launched = true;
    this.jumpedThisAir = true;
    this.yaw = Math.atan2(b.vel.x, b.vel.z);
    this.yawVel = 0;
    this.events.launched = id;
    this.anim = Anim.Launch;
  }

  /** Grabs a cable when the hands are inside one's grab window. */
  private tryZip(world: CollisionWorld) {
    const b = this.body;
    for (const zl of world.ziplines) {
      if (zl.id === this.lastZip && this.zipCooldown > 0) continue;
      const s = zipGrab(zl, b.pos.x, b.pos.y, b.pos.z);
      if (s < 0) continue;
      const len = zipLength(zl);
      this.zip = zl;
      this.zipLen = len;
      this.zipDir.x = (zl.b[0] - zl.a[0]) / len;
      this.zipDir.y = (zl.b[1] - zl.a[1]) / len;
      this.zipDir.z = (zl.b[2] - zl.a[2]) / len;
      this.zipS = s;
      this.zipT = 0;
      const along = b.vel.x * this.zipDir.x + b.vel.y * this.zipDir.y + b.vel.z * this.zipDir.z;
      this.zipSpeed = clamp(Math.max(along, ZIP.ENTRY_SPEED), ZIP.MIN_SPEED, ZIP.MAX_SPEED);
      this.launched = false;
      this.jumpBuffer = 0;
      if (this.sliding) this.endSlide();
      b.vel.x = b.vel.y = b.vel.z = 0;
      b.ext.x = b.ext.y = b.ext.z = 0;
      this.placeOnZip();
      this.events.zipOn = zl.id;
      this.anim = Anim.Zip;
      return;
    }
  }

  private placeOnZip() {
    const b = this.body, zl = this.zip!;
    b.pos.x = zl.a[0] + this.zipDir.x * this.zipS;
    b.pos.y = zl.a[1] + this.zipDir.y * this.zipS - ZIP.HANG;
    b.pos.z = zl.a[2] + this.zipDir.z * this.zipS;
    this.yaw = Math.atan2(this.zipDir.x, this.zipDir.z);
    this.yawVel = 0;
    this.lastGroundY = b.pos.y;
  }

  private stepZip(dt: number, inp: MoveInput) {
    const b = this.body;
    const d = this.zipDir;
    if (inp.jumpPressed) this.jumpBuffer = PLAYER.JUMP_BUFFER; else this.jumpBuffer -= dt;
    this.zipT += dt;
    if (this.zipT < ZIP.RELEASE_LOCK) this.jumpBuffer = 0;
    // gravity along the slope minus air drag, then a brake block over the last metres
    const accel = ZIP.GRAVITY * -d.y - ZIP.DRAG * this.zipSpeed * this.zipSpeed;
    let v = clamp(this.zipSpeed + accel * dt, ZIP.MIN_SPEED, ZIP.MAX_SPEED);
    if (this.zipLen - this.zipS < 9 && v > 7.5) v = Math.max(7.5, v - 16 * dt);
    this.zipSpeed = v;
    this.zipS += v * dt;
    const end = this.zipS >= this.zipLen - 0.25;
    if (end) this.zipS = this.zipLen - 0.25;
    this.placeOnZip();
    b.grounded = false; b.ground = null;
    this.airTime = 0;
    this.anim = Anim.Zip;
    if (end || this.jumpBuffer > 0) {
      const id = this.zip!.id;
      b.vel.x = d.x * v; b.vel.z = d.z * v;
      b.vel.y = end ? ZIP.END_VY : Math.max(0, d.y * v) + ZIP.RELEASE_VY;
      this.zip = null;
      this.lastZip = id;
      this.zipCooldown = ZIP.REGRAB;
      this.jumpBuffer = 0;
      this.coyote = 0;
      this.jumpedThisAir = true;
      this.events.zipOff = id;
      if (!end) this.events.jumped = true;
      this.anim = Anim.Jump;
    }
  }

  private updateAnim(hs: number, sprint: boolean) {
    const b = this.body;
    if (this.mantleActive) this.anim = Anim.Mantle;
    else if (this.dashing) this.anim = this.dashSide < 0 ? Anim.DashL : Anim.DashR;
    else if (this.flipping) this.anim = Anim.Flip;
    else if (this.zip) this.anim = Anim.Zip;
    else if (this.grapple && !b.grounded) this.anim = Anim.Swing;
    else if (this.sliding) this.anim = Anim.Slide;
    else if (!b.grounded && this.launched && b.vel.y > 0) this.anim = Anim.Launch;
    else if (!b.grounded) this.anim = b.vel.y > 0.5 ? Anim.Jump : Anim.Fall;
    else if (this.landSlow > 0) this.anim = Anim.Land;
    else if (hs > 6.8 && sprint) this.anim = Anim.Sprint;
    else if (hs > 0.5) this.anim = Anim.Run;
    else this.anim = Anim.Idle;
  }

  /**
   * Deliberate ledge climb on Space: pull yourself onto something between waist
   * and head height that you are standing against (or, in the air, a lip you just
   * missed). Capped low, slow to perform and on a cooldown, so it opens routes
   * over waist-to-head-high clutter without turning every wall into an escape.
   */
  private tryClimb(world: CollisionWorld, dirX: number, dirZ: number): boolean {
    const b = this.body;
    const airborne = !b.grounded && this.coyote <= 0;
    if (airborne && b.vel.y > 1) return false; // still rising: let the jump play out
    let fx = dirX, fz = dirZ;
    if (Math.hypot(fx, fz) < 1e-3) { fx = Math.sin(this.yaw); fz = Math.cos(this.yaw); }
    const maxRise = airborne ? CLIMB.AIR_MAX : CLIMB.MAX;
    const reach = b.radius + CLIMB.REACH;
    const fxp = b.pos.x + fx * reach, fzp = b.pos.z + fz * reach;
    world.groundProbe(fxp, fzp, b.radius * 0.55, b.pos.y + maxRise, gh);
    if (!gh.c || gh.c.isDynamic) return false;
    const rise = gh.top - b.pos.y;
    if (rise < CLIMB.MIN || rise > maxRise) return false;
    const top = gh.top, onto = gh.c;
    // it has to be something you can stand on rather than perch on: a railing, a
    // handrail or a pipe has nothing behind its lip, so look a step further in
    // with a narrow probe that a thin rail cannot satisfy
    world.groundProbe(fxp + fx * CLIMB.DEPTH, fzp + fz * CLIMB.DEPTH, 0.08, top + 0.35, gh2);
    if (!gh2.c || Math.abs(gh2.top - top) > 0.35) return false;
    // somewhere to stand up there, and room to haul yourself through
    if (!world.isSpaceFree(fxp, top + 0.02, fzp, b.radius * 0.9, PLAYER.HEIGHT * 0.92)) return false;
    if (!world.isSpaceFree(b.pos.x, b.pos.y + 0.1, b.pos.z, b.radius * 0.75, rise + PLAYER.HEIGHT * 0.9)) return false;

    this.mantleActive = true;
    this.mantleT = 0;
    this.mantleDur = lerp(CLIMB.TIME_MIN, CLIMB.TIME_MAX, clamp((rise - CLIMB.MIN) / (CLIMB.MAX - CLIMB.MIN), 0, 1));
    this.mFrom.x = b.pos.x; this.mFrom.y = b.pos.y; this.mFrom.z = b.pos.z;
    this.mTo.x = fxp; this.mTo.y = top; this.mTo.z = fzp;
    this.mSpeed = CLIMB.EXIT_SPEED;
    this.mDirX = fx; this.mDirZ = fz;
    this.mGround = onto;
    this.yaw = Math.atan2(fx, fz);
    this.yawVel = 0;
    this.climbCooldown = CLIMB.COOLDOWN;
    b.vel.x = b.vel.y = b.vel.z = 0;
    b.ext.x = b.ext.y = b.ext.z = 0;
    this.events.mantled = true;
    this.anim = Anim.Mantle;
    return true;
  }

  private tryMantle(world: CollisionWorld, dx: number, dz: number, grounded: boolean): boolean {
    const b = this.body;
    const reach = b.radius + PLAYER.MANTLE_REACH;
    const fx = b.pos.x + dx * reach, fz = b.pos.z + dz * reach;
    const maxRise = !grounded && b.vel.y < -3 ? PLAYER.MANTLE_MAX_FALLING : PLAYER.MANTLE_MAX;
    world.groundProbe(fx, fz, b.radius * 0.55, b.pos.y + maxRise, gh);
    if (!gh.c || gh.c.isDynamic) return false;
    const rise = gh.top - b.pos.y;
    const minRise = grounded ? PLAYER.STEP_HEIGHT : PLAYER.AIR_STEP;
    if (rise < minRise || rise > maxRise) return false;
    if (!world.isSpaceFree(fx, gh.top + 0.02, fz, b.radius * 0.9, b.height * 0.92)) return false;
    if (!world.isSpaceFree(b.pos.x, b.pos.y + 0.1, b.pos.z, b.radius * 0.75, rise + b.height * 0.9)) return false;

    this.mantleActive = true;
    this.mantleT = 0;
    this.mantleDur = PLAYER.MANTLE_TIME * (0.55 + 0.45 * (rise / PLAYER.MANTLE_MAX));
    this.mFrom.x = b.pos.x; this.mFrom.y = b.pos.y; this.mFrom.z = b.pos.z;
    this.mTo.x = fx; this.mTo.y = gh.top; this.mTo.z = fz;
    this.mSpeed = Math.max(3, Math.hypot(b.vel.x, b.vel.z) * 0.75);
    this.mDirX = dx; this.mDirZ = dz;
    this.mGround = gh.c;
    this.yaw = Math.atan2(dx, dz);
    this.yawVel = 0;
    b.vel.x = b.vel.y = b.vel.z = 0;
    b.ext.x = b.ext.y = b.ext.z = 0;
    this.events.mantled = true;
    this.anim = Anim.Mantle;
    return true;
  }

  private stepMantle(_world: CollisionWorld, dt: number) {
    const b = this.body;
    this.mantleT += dt;
    const u = Math.min(1, this.mantleT / this.mantleDur);
    const uy = Math.min(1, u / 0.7);
    const ey = 1 - (1 - uy) * (1 - uy) * (1 - uy);
    const uxz = clamp((u - 0.25) / 0.75, 0, 1);
    const exz = uxz * uxz * (3 - 2 * uxz);
    b.pos.y = this.mFrom.y + (this.mTo.y - this.mFrom.y) * ey;
    b.pos.x = this.mFrom.x + (this.mTo.x - this.mFrom.x) * exz;
    b.pos.z = this.mFrom.z + (this.mTo.z - this.mFrom.z) * exz;
    this.anim = Anim.Mantle;
    if (u >= 1) {
      this.mantleActive = false;
      b.grounded = true;
      b.ground = this.mGround;
      b.vel.x = this.mDirX * this.mSpeed;
      b.vel.z = this.mDirZ * this.mSpeed;
      b.vel.y = 0;
      this.lastGroundY = b.pos.y;
      this.coyote = PLAYER.COYOTE_TIME;
      this.anim = Anim.Run;
    }
  }
}

function approach2(v: Vec3, tx: number, tz: number, maxDelta: number) {
  const dx = tx - v.x, dz = tz - v.z;
  const d = Math.hypot(dx, dz);
  if (d <= maxDelta || d < 1e-6) { v.x = tx; v.z = tz; return; }
  v.x += (dx / d) * maxDelta;
  v.z += (dz / d) * maxDelta;
}

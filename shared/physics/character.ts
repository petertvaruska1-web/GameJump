// Arcade character controller: cylinder vs world, step-up, ground snap,
// coyote time, jump buffering, jump cut, air control, auto-mantle/vault,
// ledge climbing, sliding, front flips, sideways dashes, grapple swinging,
// boosted running and jumping, moving-platform and conveyor carry, launch pads, zip
// lines and external pushes (wind, sweepers). And, for a runner Viktor has
// blessed, free flight. And, in Speedster Battle, race running: speed that comes
// from stride cadence, slopes that give and take it, barriers that cost it and
// kickers that keep the lift of their ramp.

import { CLIMB, CORPSE, DASH, FLIP, FLY, GRAPPLE, LAUNCH, PHYS, PLAYER, POW, POWER, RACE, SLIDE, ZIP } from '../constants';
import { zipGrab, zipLength } from '../hazards';
import type { GrappleDef, LaunchDef, ZiplineDef } from '../level/types';
import { approachAngle, clamp, damp, lerp, v3, wrapAngle, type Vec3 } from '../math';
import { puppetDelta, type Collider, type CollisionWorld, type GroundHit, type RayHit } from './world';

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
  if (c.kind === 'puppet') return puppetDelta(c, x, z, out);
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
  const vx0 = v.x, vz0 = v.z;
  stepBody(world, b, dt, false, info);
  // a body is not a sack of sand: it rebounds a little off walls and bounces on a
  // hard landing (the collision above only ever removes the velocity into a surface)
  if (info.wall) { v.x += (v.x - vx0) * CORPSE.WALL_BOUNCE; v.z += (v.z - vz0) * CORPSE.WALL_BOUNCE; }
  if (info.landed && info.impact > CORPSE.BOUNCE_MIN) {
    v.y = info.impact * CORPSE.BOUNCE;
    v.x *= 0.8; v.z *= 0.8;
    b.grounded = false; b.ground = null;
  }
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
  /**
   * The grapple button is held. When given, letting go of it lets go of the
   * rope (once the rope has been on for GRAPPLE.RELEASE_LOCK, so a quick tap
   * still gives a short swing). Tools that leave it out release on request only.
   */
  grappleHeld?: boolean;
  /** Take off, or land, this step (only does anything for a runner who can fly). */
  flyToggle?: boolean;
  /**
   * While flying: the world-space direction the move keys ask for, including the
   * camera's pitch, so forward flies wherever you are looking (magnitude 0..1).
   * Left out, flight uses the flat `x` / `z` move.
   */
  flyX?: number;
  flyY?: number;
  flyZ?: number;
  /** While flying: hold to sink (holding jump climbs). */
  descend?: boolean;
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
  /** Flying (Viktor's gift). */
  Fly: 16,
  /** Gone through the portal: not on the course at all until they come back. */
  Away: 17,
  /** A slash's step in (the angel's sword). */
  Lunge: 18,
  /** Diving with the wings folded (the angel's R in the air). */
  Dive: 19,
  /** A flash strike's streak (super speed). */
  Flash: 20,
  /** Gliding on spread wings (the angel, Space held on the way down). */
  Glide: 21,
  /** Just beat the wings (the angel): shown for a moment after each beat, so everyone sees it. */
  Beat: 22,
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
  /** Took off (1) or stopped flying (-1) this step. */
  flew: number;
  /** A dive hit the ground this step, this fast (m/s; 0 none). */
  slammed: number;
  /** A flash strike ended this step (from flashFrom to where the body is now). */
  flashed: boolean;
  /** Beat the wings this step (1), or took off with one great beat (2, the soar); 0 none. */
  beat: number;
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
    slid: false, hooked: -1, unhooked: false, flipped: false, dashed: 0, flew: 0, slammed: 0, flashed: false, beat: 0,
  };

  // ---------------------------------------------------------------- superpowers (the arena)
  /** Passives: run / sprint speed, acceleration and take-off multipliers (1 = a plain runner). */
  runScale = 1;
  sprintScale = 1;
  accelScale = 1;
  jumpScale = 1;
  /** Gravity power: holding jump on the way down floats you. */
  floaty = false;
  /**
   * The angel's wings: Space in the air beats them (while they have the strength),
   * holding it on the way down glides. See POW.angel.
   */
  wings = false;
  wingStamina: number = POW.angel.WING_MAX;
  /** Seconds since the last wingbeat, and gliding right now. */
  beatT = 9;
  gliding = false;
  /** A slash's step in: a short lunge along the aim that owns your horizontal velocity. */
  lunging = false;
  private lungeT = 0;
  private lungeTime = 0;
  private lungeX = 0;
  private lungeZ = 0;
  private lungeSpeed = 0;
  /** The angel's dive: along (slamX, slamY, slamZ) at slamSpeed until it lands. */
  slamming = false;
  private slamSpeed = 0;
  private slamX = 0;
  private slamY = -1;
  private slamZ = 0;
  /** Flash strike: a straight streak at a speed no runner can reach. */
  flashing = false;
  private flashT = 0;
  private flashDur = 0;
  private flashSpeed = 0;
  private readonly flashDir = v3();
  private flashKeep = 0;
  /** Where the last flash strike started. */
  readonly flashFrom = v3();

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
  /**
   * Speedster Battle: the running speed comes from stride cadence. `raceTarget` is
   * what the cadence asks for (set every frame by whoever reads the clicks),
   * `raceSpeed` what the legs have built toward it, `raceMomentum` what slopes add
   * or take. Off everywhere else.
   */
  race = false;
  raceTarget: number = RACE.BASE;
  raceSpeed = 0;
  raceMomentum = 0;
  /** Viktor's gift: this runner may fly, and whether it is flying right now. */
  canFly = false;
  flying = false;
  /** Where flight is allowed (the level's bounds plus a margin, a floor and a ceiling). */
  readonly flyLimits = { minX: -Infinity, maxX: Infinity, minZ: -Infinity, maxZ: Infinity, minY: -Infinity, maxY: Infinity };

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
    this.flying = false;
    this.lunging = false;
    this.slamming = false;
    this.flashing = false;
    this.wingStamina = POW.angel.WING_MAX;
    this.beatT = 9;
    this.gliding = false;
    this.raceSpeed = 0;
    this.raceMomentum = 0;
  }

  /** A counted stride: an instant push, never more than a kick past what the cadence asks for. */
  raceKick() {
    const cap = Math.min(RACE.TOP, Math.max(this.raceSpeed, this.raceTarget + RACE.KICK));
    this.raceSpeed = Math.min(cap, this.raceSpeed + RACE.KICK);
  }

  /** The speed race running goes at right now: the drive plus what the slope has given (never quite stalling). */
  get raceRun() { return clamp(this.raceSpeed + this.raceMomentum, Math.min(this.raceSpeed, 5), RACE.TOP); }

  /** The legs build toward the cadence's speed (only while running), and slopes feed a momentum that fades. */
  private raceDrive(dt: number, moving: boolean) {
    const b = this.body, v = b.vel;
    const hs = Math.hypot(v.x, v.z);
    if (moving) {
      const t = this.raceTarget;
      this.raceSpeed = this.raceSpeed < t ? Math.min(t, this.raceSpeed + RACE.ACCEL * dt) : Math.max(t, this.raceSpeed - RACE.DECEL * dt);
    } else this.raceSpeed = Math.min(this.raceSpeed, hs);
    let g = 0;
    const c = b.grounded ? b.ground : null;
    if (c && c.rise !== 0 && hs > 0.5) {
      const slope = (c.rise / (2 * c.hz)) * ((v.x * c.sin + v.z * c.cos) / hs);
      g = (-PHYS.GRAVITY * RACE.SLOPE_K * slope) / Math.sqrt(1 + slope * slope);
    }
    this.raceMomentum = clamp(this.raceMomentum + (g - this.raceMomentum / RACE.SLOPE_TAU) * dt, -RACE.SLOPE_MAX, RACE.SLOPE_MAX);
  }

  /** How steeply the ground `c` rises along the horizontal direction (dx, dz) (unit). */
  private riseAlong(c: Collider | null, dx: number, dz: number): number {
    return c && c.rise !== 0 ? (c.rise / (2 * c.hz)) * (dx * c.sin + dz * c.cos) : 0;
  }

  step(world: CollisionWorld, dt: number, inp: MoveInput, windX = 0, windZ = 0) {
    const b = this.body;
    const ev = this.events;
    ev.jumped = false; ev.landed = false; ev.impact = 0; ev.mantled = false;
    ev.launched = -1; ev.zipOn = -1; ev.zipOff = -1;
    ev.slid = false; ev.hooked = -1; ev.unhooked = false;
    ev.flipped = false; ev.dashed = 0; ev.flew = 0; ev.slammed = 0; ev.flashed = false; ev.beat = 0;
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
      if (b.ground.kind === 'sweeper' || b.ground.kind === 'puppet') this.yaw += b.ground.ry - b.ground.pry;
    } else if (b.grounded && b.ground && b.ground.def.belt) {
      const bs = b.ground.def.belt;
      this.platVel.x = b.ground.sin * bs; this.platVel.y = 0; this.platVel.z = b.ground.cos * bs;
      b.pos.x += this.platVel.x * dt; b.pos.z += this.platVel.z * dt;
    } else if (b.grounded) {
      this.platVel.x = this.platVel.y = this.platVel.z = 0;
    }

    if (inp.flyToggle && this.canFly) this.toggleFly();
    if (this.flying) { this.stepFly(world, dt, inp, windX, windZ); return; }
    if (this.flashing) { this.stepFlash(world, dt); return; }

    if (this.mantleActive) { this.stepMantle(world, dt); return; }
    if (this.zip) { this.stepZip(dt, inp); return; }

    // Grapple: hook an anchor / let go
    if (this.grapple && (inp.grappleRelease || (inp.grappleHeld === false && this.hookT >= GRAPPLE.RELEASE_LOCK))) this.unhook(true);
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
    if (this.race) this.raceDrive(dt, mag > 0.1);
    const baseSpeed = this.race ? this.raceRun : (inp.sprint ? PLAYER.SPRINT_SPEED * this.sprintScale : PLAYER.RUN_SPEED * this.runScale) * boostK;
    const v = b.vel;

    // wings: their strength comes back (fast on the ground), and Space held on the way down glides
    const A = POW.angel;
    if (this.wings) {
      this.beatT += dt;
      this.wingStamina = Math.min(A.WING_MAX, this.wingStamina + (b.grounded ? A.WING_REGEN : A.WING_REGEN_AIR) * dt);
    }
    this.gliding = this.wings && !b.grounded && v.y < 0.5 && !!inp.jumpHeld && this.beatT > 0.12
      && !this.grapple && !this.zip && !this.slamming && !this.dashing && !this.sliding;

    // A punch's lunge: like a dash, but forward, and over the moment it is thrown
    if (this.lunging) {
      this.lungeT += dt;
      if (this.lungeT >= this.lungeTime || !b.grounded) this.endLunge();
      else { v.x = this.lungeX * this.lungeSpeed; v.z = this.lungeZ * this.lungeSpeed; }
    }

    // Dash: a short sidestep that owns your horizontal velocity while it runs.
    // No cooldown on the ground; in the air you get one per jump.
    if (this.dashing) {
      this.dashT += dt;
      if (this.dashT >= DASH.TIME || b.grounded === this.dashAir) this.endDash();
      else { v.x = this.dashDirX * DASH.SPEED + this.dashKeepX; v.z = this.dashDirZ * DASH.SPEED + this.dashKeepZ; }
    } else if ((inp.dashX || inp.dashZ) && (b.grounded || !this.airDashUsed)
      && !this.sliding && !this.grapple && !this.zip && !this.flipping && !this.mantleActive && !this.slamming) {
      if (this.lunging) this.endLunge();
      this.startDash(inp.dashX ?? 0, inp.dashZ ?? 0);
    }

    // Slide: start from a run (or right on landing), stand up when slow or on a second press
    if (!this.race && !this.sliding && this.slideBuffer > 0 && b.grounded && !this.grapple && this.slideCooldown <= 0
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

    if (this.dashing || this.sliding || this.lunging) {
      // velocity already set by the dash / slide / lunge
    } else if (this.slamming) {
      // diving: along the dive, wings folded (no steering)
      v.x = this.slamX * this.slamSpeed; v.z = this.slamZ * this.slamSpeed;
    } else if (b.grounded && this.race) {
      // race running: the speed is the drive's, the grip only steers it
      if (mag > 1e-3) approach2(v, dirX * baseSpeed * mag, dirZ * baseSpeed * mag, RACE.GRIP * dt);
      else approach2(v, 0, 0, RACE.DECEL * 2.5 * dt);
    } else if (b.grounded) {
      let speed = baseSpeed * mag;
      if (this.landSlow > 0) speed *= 0.8;
      const tx = dirX * speed, tz = dirZ * speed;
      let accel = PLAYER.GROUND_ACCEL;
      if (mag < 1e-3) accel = PLAYER.GROUND_DECEL;
      else if (v.x * tx + v.z * tz < 0) accel = PLAYER.GROUND_TURN_ACCEL;
      approach2(v, tx, tz, accel * this.accelScale * dt);
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
    } else if (this.race) {
      // in the air a racer keeps its speed and steers a little
      if (mag > 1e-3) {
        const cur = Math.hypot(v.x, v.z);
        approach2(v, dirX * Math.max(baseSpeed, cur) * mag, dirZ * Math.max(baseSpeed, cur) * mag, RACE.AIR_GRIP * dt);
      }
    } else if (mag > 1e-3) {
      // gliding, the air carries you further and turns you quicker
      const cur = Math.hypot(v.x, v.z);
      const speed = Math.max(this.gliding ? A.GLIDE_SPEED : baseSpeed, cur) * mag;
      approach2(v, dirX * speed, dirZ * speed, PLAYER.AIR_ACCEL * this.accelScale * (this.gliding ? A.GLIDE_ACCEL : 1) * dt);
    } else if (!this.gliding && !this.race) {
      const k = 1 - PLAYER.AIR_DRAG * dt;
      v.x *= k; v.z *= k;
    }

    // Jump (a jump while hooked lets go of the rope with a little kick)
    let jumped = false;
    if (this.grapple && this.jumpBuffer > 0 && this.hookT >= GRAPPLE.RELEASE_LOCK) { this.jumpBuffer = 0; this.unhook(true); }
    // Space again while in the air: front flip, whenever you press it between
    // take-off and landing (with wings: a wingbeat, which also pulls out of a dive).
    // On the way down with the ground close the press is left alone, so it still
    // buffers into a jump the moment you land.
    const airPress = this.jumpBuffer > 0 && !b.grounded && this.coyote <= 0 && !this.zip && !this.grapple && !this.sliding && !this.dashing
      && !(v.y < -2 && world.groundBelow(b.pos.x, b.pos.y, b.pos.z, FLIP.NEAR_GROUND) < FLIP.NEAR_GROUND);
    if (this.wings) {
      if (airPress && this.beatT >= A.BEAT_GAP && this.wingStamina >= A.BEAT_COST) this.beat(dirX, dirZ, mag);
    } else if (airPress && !this.flipping && !this.flippedThisAir && !this.slamming) this.startFlip();
    const slideJumpOk = !this.sliding || this.headroom(world, 0.35);
    if (this.jumpBuffer > 0 && !this.dashing && !this.slamming && (b.grounded || this.coyote > 0) && slideJumpOk) {
      if (this.lunging) this.endLunge();
      if (this.sliding) {
        // jumping out of a slide keeps its speed, up to a little more than a sprint
        const sp = Math.min(this.slideSpeed, SLIDE.JUMP_MAX * boostK);
        v.x = this.slideDirX * sp; v.z = this.slideDirZ * sp;
        this.endSlide();
      }
      v.y = PLAYER.JUMP_VELOCITY * (this.boost ? POWER.BOOST_JUMP : 1) * this.jumpScale;
      // racing up a slope, the jump takes the slope's lift with it
      if (this.race && b.grounded) { const hs0 = Math.hypot(v.x, v.z); if (hs0 > 0.5) v.y += Math.max(0, this.riseAlong(b.ground, v.x / hs0, v.z / hs0)) * hs0; }
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

    // Gravity (a dive goes at a steady speed; the gravity power floats you down while
    // jump is held, and spread wings glide you down)
    if (this.slamming) v.y = this.slamY * this.slamSpeed;
    else {
      const float = this.floaty && v.y < 0 && inp.jumpHeld && !this.grapple;
      const g = PHYS.GRAVITY * (v.y < 0 ? PHYS.FALL_GRAVITY_MULT : 1) * (float ? POW.gravity.FLOAT : this.gliding ? 0.35 : 1);
      v.y = Math.max(v.y - g * dt, -PHYS.MAX_FALL_SPEED);
      if (float && v.y < -POW.gravity.FLOAT_MAX_FALL) v.y += (-POW.gravity.FLOAT_MAX_FALL - v.y) * damp(7, dt);
      // spread wings catch a fast fall over a moment, then hold it at the glide
      if (this.gliding) v.y = v.y < -A.GLIDE_FALL - 1 ? v.y + (-A.GLIDE_FALL - v.y) * damp(8, dt) : Math.max(v.y, -A.GLIDE_FALL);
    }

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
    const hsBefore = Math.hypot(v.x, v.z);
    const info = stepBody(world, b, dt, jumped, this.info);

    if (this.race) {
      // a barrier takes the speed that went into it (scraping along one bleeds it away)
      if (info.wall) this.raceSpeed = Math.max(0, this.raceSpeed - Math.max(0, hsBefore - Math.hypot(v.x, v.z)));
      // running off the top of a ramp keeps its lift: a kicker throws you as hard as you hit it
      if (wasGrounded && !b.grounded && !jumped && hsBefore > 0.5) {
        const lift = this.riseAlong(groundBefore, v.x / hsBefore, v.z / hsBefore) * hsBefore;
        if (lift > 0) v.y = Math.max(v.y, lift);
      }
    }

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

    // A dive into a wall goes on straight down it
    if (this.slamming && info.wall) {
      const k = Math.hypot(this.slamX, this.slamZ);
      if (k > 0.01) { this.slamX = 0; this.slamZ = 0; this.slamY = -1; }
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
      if (this.slamming) {
        // a dive lands on purpose: the burst is the point, not a stumble (and it is as hard as the dive was fast)
        this.slamming = false;
        ev.slammed = Math.max(info.impact, this.slamSpeed);
        v.x = v.z = 0;
      } else if (info.impact > PLAYER.HARD_LANDING_SPEED && !this.race) this.landSlow = PLAYER.HARD_LANDING_SLOW;
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
      if (!this.grapple && !this.slamming) this.tryZip(world);
      if (this.zip) return;
    }

    // Holding forward into a ledge pulls you over it: the quick vault / ledge grab
    // for anything up to waist height, and the slower climb above that (in the air
    // this is what catches you when a jump comes up short).
    let pushing = false;
    if (mag > 0.3 && !this.sliding && !this.grapple && !this.flipping && !this.dashing && !this.slamming && !this.lunging) {
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

  /**
   * Take off, or stop flying. Taking off drops whatever else you were doing (a
   * cable, a rope, a slide) and hops you off the ground; catching yourself in a
   * fall takes most of the speed out of it. Stopping hands you back to gravity
   * with the speed you had, like stepping off a ledge.
   */
  private toggleFly() {
    const b = this.body;
    if (this.flying) { this.stopFlying(); return; }
    if (this.mantleActive) return;
    if (this.zip) { this.lastZip = this.zip.id; this.zipCooldown = ZIP.REGRAB; this.zip = null; this.events.zipOff = this.lastZip; }
    if (this.grapple) this.unhook(false);
    if (this.sliding) this.endSlide();
    this.dashing = false;
    this.flipping = false;
    this.launched = false;
    this.flying = true;
    b.height = PLAYER.HEIGHT;
    if (b.grounded) { b.vel.y = Math.max(b.vel.y, FLY.TAKEOFF_VY); b.grounded = false; b.ground = null; }
    else b.vel.y = Math.max(b.vel.y, -6);
    this.jumpBuffer = 0;
    this.coyote = 0;
    this.events.flew = 1;
    this.anim = Anim.Fly;
  }

  private stopFlying() {
    this.flying = false;
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.jumpedThisAir = true;
    this.flippedThisAir = false;
    this.airDashUsed = false;
    this.lastGroundY = this.body.pos.y;
    this.events.flew = -1;
  }

  /**
   * Flight: no gravity. The move keys fly you along the camera's view (pitch
   * included), jump climbs and descend sinks, Shift goes faster. Velocity eases
   * toward what the keys ask for and glides to a stop when they let go. You float
   * a little above whatever is below you; holding descend all the way down lands
   * you, and flight ends there. Walls and ceilings still stop you.
   */
  private stepFly(world: CollisionWorld, dt: number, inp: MoveInput, windX: number, windZ: number) {
    const b = this.body, v = b.vel, ev = this.events;
    let fx = inp.flyX ?? inp.x, fy = inp.flyY ?? 0, fz = inp.flyZ ?? inp.z;
    let mag = Math.hypot(fx, fy, fz);
    if (mag > 1) { fx /= mag; fy /= mag; fz /= mag; mag = 1; }
    const speed = inp.sprint ? FLY.FAST : FLY.SPEED;
    const climb = (inp.jumpHeld ? 1 : 0) - (inp.descend ? 1 : 0);
    let tx = fx * speed, ty = fy * speed + climb * FLY.VERTICAL, tz = fz * speed;
    // float a little above the ground unless you are deliberately sinking onto it, and
    // pull out of a dive in time to skim the floor rather than slam into it
    let floorGap = Infinity;
    if (!inp.descend) {
      floorGap = world.groundBelow(b.pos.x, b.pos.y + 0.2, b.pos.z, 16) - 0.2;
      if (floorGap < FLY.HOVER) ty = Math.max(ty, (FLY.HOVER - floorGap) * 9);
    }
    // the air thickens at the edges of the world: a floor, a ceiling and walls you glide back from
    const L = this.flyLimits;
    if (b.pos.y < L.minY) ty = Math.max(ty, (L.minY - b.pos.y) * 2 + 2);
    else if (b.pos.y > L.maxY) ty = Math.min(ty, -(b.pos.y - L.maxY) * 2 - 2);
    if (b.pos.x < L.minX) tx = Math.max(tx, (L.minX - b.pos.x) * 0.5 + 2);
    else if (b.pos.x > L.maxX) tx = Math.min(tx, -(b.pos.x - L.maxX) * 0.5 - 2);
    if (b.pos.z < L.minZ) tz = Math.max(tz, (L.minZ - b.pos.z) * 0.5 + 2);
    else if (b.pos.z > L.maxZ) tz = Math.min(tz, -(b.pos.z - L.maxZ) * 0.5 - 2);
    const asking = mag > 0.05 || climb !== 0;
    approach3(v, tx, ty, tz, (asking ? FLY.ACCEL : FLY.DECEL) * dt);
    if (v.y < 0 && isFinite(floorGap)) {
      const safe = Math.sqrt(2 * FLY.ACCEL * Math.max(0, floorGap - FLY.HOVER));
      if (v.y < -safe) v.y = -safe;
    }

    // gusts and knockback push a flyer about too
    const e = b.ext;
    e.x += windX * dt; e.z += windZ * dt;
    const ed = damp(1.1, dt);
    e.x -= e.x * ed; e.z -= e.z * ed; e.y -= e.y * damp(3, dt);

    const info = stepBody(world, b, dt, false, this.info);
    if (info.landed) { ev.landed = true; ev.impact = info.impact; ev.surface = b.ground?.def.mat ?? ''; }
    this.airTime = 0;
    this.lastGroundY = b.pos.y;
    this.platVel.x = this.platVel.y = this.platVel.z = 0;
    if (b.grounded && inp.descend) {
      // sank all the way down: you have landed
      this.stopFlying();
      this.anim = Anim.Land;
      this.landAnim = Math.min(1, info.impact / 20);
      return;
    }

    // face the way the camera looks (or the way you are going, for tools that do not say)
    const hs = Math.hypot(v.x, v.z);
    const want = inp.aimYaw ?? (hs > 0.6 ? Math.atan2(v.x, v.z) : this.yaw);
    const target = clamp(wrapAngle(want - this.yaw) * 9, -PLAYER.TURN_RATE, PLAYER.TURN_RATE);
    this.yawVel += clamp(target - this.yawVel, -PLAYER.TURN_ACCEL * dt, PLAYER.TURN_ACCEL * dt);
    this.yaw += this.yawVel * dt;
    this.landAnim = Math.max(0, this.landAnim - dt * 4);
    this.anim = Anim.Fly;
  }

  // ---------------------------------------------------------------- superpower moves

  /** Can a power move start now (not mid-climb, not in flight, alive)? */
  get free() { return !this.mantleActive && !this.flying && !this.flashing; }

  /**
   * A punch's lunge: `speed` along (dx, dz) for `time`, owning your horizontal
   * speed like a dash does, then easing out at no more than a sprint.
   */
  startLunge(dx: number, dz: number, speed: number, time: number) {
    const l = Math.hypot(dx, dz);
    if (l < 1e-3 || !this.free) return;
    if (this.sliding) this.endSlide();
    this.dashing = false;
    this.lunging = true;
    this.lungeT = 0; this.lungeTime = time; this.lungeSpeed = speed;
    this.lungeX = dx / l; this.lungeZ = dz / l;
    this.yaw = Math.atan2(this.lungeX, this.lungeZ);
    this.yawVel = 0;
    this.anim = Anim.Lunge;
  }

  private endLunge() {
    this.lunging = false;
    const v = this.body.vel, hs = Math.hypot(v.x, v.z), cap = PLAYER.SPRINT_SPEED * this.sprintScale;
    if (hs > cap) { const k = cap / hs; v.x *= k; v.z *= k; }
  }

  /**
   * The angel's dive: from the air, wings folded, along (dx, dy, dz) at `speed`
   * until it lands (the caller keeps it pointing down). Returns whether it started.
   */
  startDive(dx: number, dy: number, dz: number, speed: number): boolean {
    const b = this.body;
    if (b.grounded || !this.free) return false;
    if (this.zip) { this.lastZip = this.zip.id; this.zipCooldown = ZIP.REGRAB; this.zip = null; this.events.zipOff = this.lastZip; }
    if (this.grapple) this.unhook(false);
    this.dashing = false; this.flipping = false; this.launched = false; this.lunging = false;
    // never shallower than DIVE_PITCH below level (aimed up or level, it goes that steeply along the aim)
    const hl = Math.hypot(dx, dz), pitch = Math.min(Math.atan2(dy, hl), -POW.angel.DIVE_PITCH);
    const hx = hl > 1e-3 ? dx / hl : 0, hz = hl > 1e-3 ? dz / hl : 0;
    this.slamX = hx * Math.cos(pitch); this.slamY = Math.sin(pitch); this.slamZ = hz * Math.cos(pitch);
    this.slamming = true;
    this.slamSpeed = speed;
    b.vel.x = this.slamX * speed; b.vel.y = this.slamY * speed; b.vel.z = this.slamZ * speed;
    if (Math.hypot(this.slamX, this.slamZ) > 0.05) { this.yaw = Math.atan2(this.slamX, this.slamZ); this.yawVel = 0; }
    this.jumpBuffer = 0;
    this.anim = Anim.Dive;
    return true;
  }

  /** A wingbeat: up (harder if already climbing), a push the way the keys ask, and it costs the wings. */
  private beat(dirX: number, dirZ: number, mag: number) {
    const A = POW.angel, v = this.body.vel;
    // a beat pulls out of a dive
    if (this.slamming) this.slamming = false;
    v.y = Math.min(A.BEAT_MAX, Math.max(v.y + A.BEAT_VY * 0.45, A.BEAT_VY));
    if (mag > 0.1) {
      const hs0 = Math.hypot(v.x, v.z);
      v.x += dirX * A.BEAT_PUSH; v.z += dirZ * A.BEAT_PUSH;
      // beating over and over never builds up more speed than a strong glide
      const hs = Math.hypot(v.x, v.z), cap = Math.max(hs0, A.BEAT_SPEED);
      if (hs > cap) { v.x *= cap / hs; v.z *= cap / hs; }
    }
    this.wingStamina -= A.BEAT_COST;
    this.beatT = 0;
    this.gliding = false;
    this.jumpBuffer = 0; this.jumpCutReady = false; this.jumpedThisAir = true;
    this.events.beat = 1;
  }

  /** The angel's R on the ground: one great beat that throws you straight up at `vy`. Returns whether it went. */
  soar(vy: number): boolean {
    const b = this.body;
    if (!this.free || this.zip) return false;
    if (this.grapple) this.unhook(false);
    if (this.sliding) this.endSlide();
    this.dashing = false; this.lunging = false; this.flipping = false;
    b.vel.y = Math.max(b.vel.y, vy);
    b.grounded = false; b.ground = null;
    this.coyote = 0; this.jumpBuffer = 0; this.jumpCutReady = false; this.jumpedThisAir = true;
    this.beatT = 0;
    this.events.beat = 2;
    return true;
  }

  /** A slash in the air: the wings hold you up for it (rising at least `vy`). */
  airLift(vy: number) {
    const b = this.body;
    if (b.grounded || this.slamming || this.flying) return;
    b.vel.y = Math.max(b.vel.y, vy);
  }

  /**
   * Flash strike: a straight streak along (dx, dy, dz) for `dist` metres at
   * `speed`, stopped by walls and floors. You come out of it running the way it
   * went, as fast as you were going before (a sprint at least).
   */
  startFlash(dx: number, dy: number, dz: number, dist: number, speed: number) {
    const b = this.body, v = b.vel;
    const l = Math.hypot(dx, dy, dz);
    if (l < 1e-3 || !this.free) return;
    if (this.zip) { this.lastZip = this.zip.id; this.zipCooldown = ZIP.REGRAB; this.zip = null; }
    if (this.grapple) this.unhook(false);
    if (this.sliding) this.endSlide();
    this.dashing = false; this.flipping = false; this.lunging = false; this.slamming = false; this.launched = false;
    this.flashing = true;
    this.flashT = 0;
    this.flashSpeed = speed;
    this.flashDur = dist / speed;
    this.flashDir.x = dx / l; this.flashDir.y = dy / l; this.flashDir.z = dz / l;
    this.flashKeep = Math.max(Math.hypot(v.x, v.z), PLAYER.SPRINT_SPEED);
    this.flashFrom.x = b.pos.x; this.flashFrom.y = b.pos.y; this.flashFrom.z = b.pos.z;
    b.ext.x = b.ext.y = b.ext.z = 0;
    this.yaw = Math.atan2(this.flashDir.x, this.flashDir.z);
    this.yawVel = 0;
    this.anim = Anim.Flash;
  }

  private stepFlash(world: CollisionWorld, dt: number) {
    const b = this.body, v = b.vel, d = this.flashDir;
    this.flashT += dt;
    // four sub-steps: at this speed a single step would carry the body clean through a railing
    const sub = 4, h = dt / sub;
    let blocked = false;
    for (let i = 0; i < sub; i++) {
      v.x = d.x * this.flashSpeed; v.y = d.y * this.flashSpeed; v.z = d.z * this.flashSpeed;
      const x0 = b.pos.x, z0 = b.pos.z;
      const info = stepBody(world, b, h, d.y > 0.05, this.info);
      const want = Math.hypot(d.x, d.z) * this.flashSpeed * h;
      if (want > 0.05 && info.wall && Math.hypot(b.pos.x - x0, b.pos.z - z0) < want * 0.4) { blocked = true; break; }
      if (d.y > 0.05 && b.vel.y <= 0) { blocked = true; break; } // a ceiling
    }
    this.airTime = 0;
    this.lastGroundY = b.grounded ? b.pos.y : Math.max(this.lastGroundY, b.pos.y);
    this.anim = Anim.Flash;
    if (blocked || this.flashT >= this.flashDur) this.endFlash();
  }

  private endFlash() {
    const b = this.body, v = b.vel, d = this.flashDir;
    this.flashing = false;
    const hl = Math.hypot(d.x, d.z) || 1;
    v.x = (d.x / hl) * this.flashKeep; v.z = (d.z / hl) * this.flashKeep;
    // an air streak leaves you hanging for a beat before gravity takes over again
    v.y = b.grounded ? 0 : Math.max(0, d.y * 4);
    this.coyote = 0;
    this.flippedThisAir = false;
    this.airDashUsed = false;
    this.events.flashed = true;
  }

  /**
   * Blink: straight to (x, y, z), keeping your speed along the way you were
   * going, as if space had folded under you. A fast fall is caught, so a blink
   * out of the void is a rescue.
   */
  blink(x: number, y: number, z: number) {
    const b = this.body;
    if (this.zip) { this.lastZip = this.zip.id; this.zipCooldown = ZIP.REGRAB; this.zip = null; }
    if (this.grapple) this.unhook(false);
    if (this.sliding) this.endSlide();
    this.mantleActive = false; this.dashing = false; this.lunging = false; this.slamming = false; this.flashing = false;
    this.launched = false;
    b.pos.x = x; b.pos.y = y; b.pos.z = z;
    b.vel.y = Math.max(b.vel.y, -4);
    b.grounded = false; b.ground = null;
    this.lastGroundY = y;
    this.coyote = 0;
    this.flippedThisAir = false;
    this.airDashUsed = false;
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
      const hs = Math.hypot(v.x, v.z), cap = PLAYER.SPRINT_SPEED * this.sprintScale;
      if (hs > cap) { const k = cap / hs; v.x *= k; v.z *= k; }
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
    this.slamming = false;
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
    else if (this.slamming) this.anim = Anim.Dive;
    else if (this.lunging) this.anim = Anim.Lunge;
    else if (this.dashing) this.anim = this.dashSide < 0 ? Anim.DashL : Anim.DashR;
    else if (this.flipping) this.anim = Anim.Flip;
    else if (this.zip) this.anim = Anim.Zip;
    else if (this.grapple && !b.grounded) this.anim = Anim.Swing;
    else if (this.sliding) this.anim = Anim.Slide;
    else if (!b.grounded && this.launched && b.vel.y > 0) this.anim = Anim.Launch;
    else if (!b.grounded && this.wings && this.beatT < 0.2) this.anim = Anim.Beat;
    else if (this.gliding) this.anim = Anim.Glide;
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

function approach3(v: Vec3, tx: number, ty: number, tz: number, maxDelta: number) {
  const dx = tx - v.x, dy = ty - v.y, dz = tz - v.z;
  const d = Math.hypot(dx, dy, dz);
  if (d <= maxDelta || d < 1e-6) { v.x = tx; v.y = ty; v.z = tz; return; }
  const k = maxDelta / d;
  v.x += dx * k; v.y += dy * k; v.z += dz * k;
}

function approach2(v: Vec3, tx: number, tz: number, maxDelta: number) {
  const dx = tx - v.x, dz = tz - v.z;
  const d = Math.hypot(dx, dz);
  if (d <= maxDelta || d < 1e-6) { v.x = tx; v.z = tz; return; }
  v.x += (dx / d) * maxDelta;
  v.z += (dz / d) * maxDelta;
}

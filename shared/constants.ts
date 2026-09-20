// Central tuning values shared by client, server and tools.
// Anything that affects gameplay/physics lives here so both sides agree.

export const MAX_PLAYERS = 3;

export const PHYS = {
  /** Fixed physics step used by the character controller. */
  STEP: 1 / 120,
  GRAVITY: 27,
  /** Extra gravity multiplier while descending — snappier arcs. */
  FALL_GRAVITY_MULT: 1.18,
  MAX_FALL_SPEED: 58,
};

export const PLAYER = {
  RADIUS: 0.34,
  HEIGHT: 1.75,
  /** Fraction of the radius used for "am I standing on this" checks (edge forgiveness). */
  GROUND_RADIUS_FACTOR: 0.72,
  EYE_HEIGHT: 1.55,

  RUN_SPEED: 5.8,
  SPRINT_SPEED: 8.9,

  GROUND_ACCEL: 42,
  GROUND_TURN_ACCEL: 70,
  GROUND_DECEL: 34,
  AIR_ACCEL: 16,
  AIR_DRAG: 0.35,

  JUMP_VELOCITY: 9.4,
  /**
   * Releasing jump early multiplies remaining upward velocity by this. 1 = off:
   * every jump is a full jump, so a quick tap travels as far as a held press
   * (tapped jumps were ~25% shorter and made long gaps feel impossible).
   */
  JUMP_CUT: 1,
  COYOTE_TIME: 0.12,
  JUMP_BUFFER: 0.2,

  STEP_HEIGHT: 0.46,
  /** While airborne, ledges this far above the feet are stepped onto (lip forgiveness). */
  AIR_STEP: 0.16,
  /** Keeps you glued to slopes/stairs when walking down. */
  GROUND_SNAP: 0.38,

  MANTLE_MAX: 1.0,
  /** Max ledge height above the feet when already falling fast (near-miss rescue only). */
  MANTLE_MAX_FALLING: 0.55,
  MANTLE_TIME: 0.21,
  MANTLE_REACH: 0.12,

  /** Top turning speed of the body (rad/s) and how fast that rate itself builds up. */
  TURN_RATE: 13,
  AIR_TURN_RATE: 6,
  /** Angular acceleration of the facing (rad/s^2): no instant snap onto a new heading. */
  TURN_ACCEL: 34,

  /** Landing faster than this costs you a beat (a heavy landing you have to run off). */
  HARD_LANDING_SPEED: 17,
  HARD_LANDING_SLOW: 0.13,
};

export const NET = {
  PORT: 8787,
  SERVER_TICK_HZ: 30,
  SNAPSHOT_HZ: 20,
  CLIENT_SEND_HZ: 30,
  /** Remote entities are rendered this far in the past for smooth interpolation. */
  INTERP_DELAY: 0.11,
  PING_INTERVAL: 2,
  RECONNECT_GRACE: 30,
  ROOM_CODE_LENGTH: 4,
  /** Max horizontal speed the server accepts from a client (m/s, with slack). */
  MAX_CLIENT_SPEED: 16,
  COUNTDOWN: 3.5,
};

export const DEATH = {
  /** Falling this far below the last supporting surface over empty air = dead. */
  FALL_DROP: 11,
};

export type EnemyKind = 'melee' | 'ranged' | 'flyer';

export interface EnemyTuning {
  viewDist: number;
  fovDeg: number;
  /** Players this close are sensed regardless of facing (still needs line of sight). */
  senseDist: number;
  alertTime: number;
  loseTime: number;
  searchTime: number;
  leash: number;
  speed: number;
  patrolSpeed: number;
  catchRadius: number;
  visionHz: number;
  eyeHeight: number;
}

export const ENEMY: Record<EnemyKind, EnemyTuning> = {
  melee: {
    viewDist: 34, fovDeg: 135, senseDist: 4,
    alertTime: 0.44, loseTime: 2, searchTime: 4, leash: 60,
    // a stalker's top speed is 2% under the player's sprint and it has no burst
    // above it: a sprint always pulls away, but only slowly
    speed: PLAYER.SPRINT_SPEED * 0.98, patrolSpeed: 2.5, catchRadius: 1.31, visionHz: 12, eyeHeight: 1.7,
  },
  ranged: {
    viewDist: 39.4, fovDeg: 90, senseDist: 2.7,
    alertTime: 0.35, loseTime: 1.4, searchTime: 2.5, leash: 0,
    speed: 0, patrolSpeed: 0, catchRadius: 0, visionHz: 10, eyeHeight: 2.3,
  },
  flyer: {
    // a drone gives up quickly: it sees 40 m, forgets you 2 s after losing sight,
    // and never follows more than 32 m from its patrol. At 7.31 m/s a sprint
    // pulls away from one comfortably
    viewDist: 40, fovDeg: 165, senseDist: 6.25,
    alertTime: 0.4, loseTime: 2, searchTime: 3, leash: 32,
    speed: 7.31, patrolSpeed: 2.98, catchRadius: 1.69, visionHz: 10, eyeHeight: 0,
  },
};

export const RANGED = {
  TURN_SPEED: 2.4,
  SCAN_ARC: 0.75,
  SCAN_SPEED: 0.45,
  CHARGE_TIME: 0.8,
  COOLDOWN: 1.25,
  PROJECTILE_SPEED: 25,
  PROJECTILE_RADIUS: 0.28,
  PROJECTILE_LIFE: 4,
  /** How much the sentinel leads a moving target (0 = aims at current position). */
  LEAD: 0.55,
  /** Random aim error (radians, max) on every shot... */
  SPREAD: 0.125,
  /** ...plus this much extra per m/s of the target's speed (moving targets are harder to hit). */
  SPREAD_PER_SPEED: 0.0125,
};

export const MELEE = {
  JUMP_VELOCITY: 10.2,
  MAX_LEAP: 6.25,
};

export const FLYER = {
  ACCEL: 11.25,
  HOVER_AMPLITUDE: 0.5,
  PATROL_RADIUS: 7,
  RADIUS: 0.7,
  /** Dive burst once it is within DIVE_DIST of you: 8.6 * 1.4 = 12 m/s. */
  DIVE_MULT: 1.4,
  DIVE_DIST: 4.5,
};

/** Zip lines: jump into a cable to grab it, slide down, jump to let go. */
export const ZIP = {
  /** Feet hang this far below the cable. */
  HANG: 2.05,
  /** Grab window: horizontal distance from the cable to the hands. */
  GRAB_RADIUS: 0.95,
  /** Grab window: cable height relative to the hands (below .. above). */
  GRAB_BELOW: 0.7,
  GRAB_ABOVE: 1.1,
  /** Slide acceleration = GRAVITY * slope, minus drag * speed^2. */
  GRAVITY: 20,
  DRAG: 0.02,
  MIN_SPEED: 5,
  MAX_SPEED: 15,
  /** Speed you have the moment you grab (at least MIN_SPEED). */
  ENTRY_SPEED: 7,
  /** Letting go early: upward kick. Reaching the end: a small hop off the handle. */
  RELEASE_VY: 5.5,
  END_VY: 3.2,
  /** You cannot re-grab the same cable this soon after letting go. */
  REGRAB: 0.6,
  /** Presses this soon after grabbing do not let go (a double-tapped jump keeps you on). */
  RELEASE_LOCK: 0.3,
};

/** Launch pads: step on and you are thrown in a fixed arc. */
export const LAUNCH = {
  /** Air control while flying (m/s^2): enough to nudge, not to fight the arc. */
  AIR_ACCEL: 3.5,
};

/** Slide (C): low, fast, keeps momentum; ducks under low gaps, chest-high beams and shots. */
export const SLIDE = {
  /** Body height while sliding (standing is PLAYER.HEIGHT). */
  HEIGHT: 0.9,
  /** Minimum ground speed to start a slide. */
  MIN_START: 4.0,
  /** Speed added when the slide starts, and the cap for that start speed. */
  BOOST: 2.2,
  MAX_START: 10.6,
  /** Absolute cap (long downhill slides). */
  MAX: 13,
  /** Deceleration on flat ground (m/s^2). */
  FRICTION: 5.5,
  /** Share of gravity along a slope that speeds up / slows down the slide. */
  SLOPE_K: 0.8,
  /** The slide ends below this speed (if there is headroom to stand). */
  END_SPEED: 3.8,
  /** Under a low ceiling you keep sliding at least this fast so you always come out. */
  CRAWL: 3.5,
  /** Steering while sliding (rad/s). */
  TURN: 1.6,
  /** Jumping out of a slide keeps at most this much horizontal speed (a little over a sprint). */
  JUMP_MAX: 9.8,
  COOLDOWN: 0.3,
  /** A slide pressed in the air starts on landing if it is this recent. */
  BUFFER: 0.25,
};

/**
 * Ledge climb: hold forward against a ledge and the runner pulls itself up, on
 * the ground or in the air after coming up short on a jump. Kept short, slow and
 * on a cooldown so it rescues a jump without becoming a way out of every
 * dangerous place.
 */
export const CLIMB = {
  /** Lowest ledge that needs a climb; anything under this is jumped or vaulted. */
  MIN: 1.0,
  /** Highest ledge you can pull yourself onto (a bit over head height). */
  MAX: 2.3,
  /** How far past the shoulders the ledge is searched for. */
  REACH: 0.55,
  /** Pull-up time for the lowest / highest climbable ledge (you are helpless throughout). */
  TIME_MIN: 0.36,
  TIME_MAX: 0.72,
  /** You step off the ledge at walking pace, never with your run intact. */
  EXIT_SPEED: 2.6,
  /** Delay before the next climb: no racing up a stack of ledges. */
  COOLDOWN: 0.9,
  /**
   * On the ground you have to hold forward into the ledge this long before the
   * climb starts, so brushing past waist-high clutter never hauls you onto it.
   * In the air there is no wait: coming up short grabs the lip at once.
   */
  PUSH_TIME: 0.15,
  /** There must be standable ground this far in past the lip (rules out railings). */
  DEPTH: 0.45,
  /** The obstacle has to have stopped you: no climbing while still moving this fast. */
  PUSH_SPEED: 2,
  /** Catching a lip you have just missed in mid-air reaches this far above the feet. */
  AIR_MAX: 1.5,
};

/**
 * Front flip (press Space again in the air): a tucked rotation that carries you a
 * little further. One per airtime, and the lift can never beat a normal jump, so
 * it lengthens a jump without turning into a second one. There is no time limit
 * on the second press -- any point between take-off and landing works.
 */
export const FLIP = {
  /** On the way down with the ground this close, Space stays a buffered landing jump. */
  NEAR_GROUND: 1.5,
  /** Length of the rotation. */
  TIME: 0.55,
  /** Forward speed added along your flight path (~0.8 m of extra reach). */
  PUSH: 1.2,
  /** A token of lift (the tuck floats you), never more than a normal jump's rise. */
  LIFT: 0.4,
};

/**
 * Sideways dash (Q / R): a short sidestep that takes you out of a charge. No
 * cooldown -- like a jump, it is ready whenever you are. On the ground it ends
 * at running speed and in the air it is thrown across your flight path and then
 * hands the jump back, so a dash can never stretch a jump.
 */
export const DASH = {
  /** Same push as before, held 35% less long: a 2.6 m step instead of 4 m. */
  SPEED: 16,
  TIME: 0.1625,
  /** Share of the speed you were already carrying that comes along (ground). */
  KEEP: 0.5,
  /** Sideways speed left over when an air dash ends, as a share of SPEED. */
  AIR_RESIDUAL: 0.2,
};

/** Grapple (E / right mouse): hook a marked anchor and swing on a rope. */
export const GRAPPLE = {
  /** Anchors farther than this (from the hands) cannot be hooked. */
  RANGE: 17,
  MIN_RANGE: 2.5,
  /** Rope lengths are clamped into this range when hooking. */
  MIN_ROPE: 3.5,
  MAX_ROPE: 14,
  /** Hands are this far above the feet. */
  HAND: 1.5,
  /** Pumping the swing accelerates you along the arc (m/s^2). */
  AIR_ACCEL: 19,
  MAX_SPEED: 18,
  /** Letting go adds this upward speed. */
  RELEASE_VY: 4.2,
  /** Delay before you can hook again after letting go. */
  COOLDOWN: 0.25,
  /** Rope reel-in speed (m/s). */
  REEL_SPEED: 5.5,
  /** Hooking yanks you toward the anchor at this speed, so a swing always starts. */
  PULL: 9,
  /** ...and off the ground, so hooking while standing lifts you into the swing. */
  PULL_LIFT: 5,
  /** While swinging the rope pulls in to this share of its hook length (tighter, faster arc)... */
  TAUT: 0.85,
  /** ...but never shorter than this. */
  REEL_MIN: 6,
  /** A jump press this soon after hooking does not let go (hook, then jump, keeps the rope). */
  RELEASE_LOCK: 0.3,
};

/** Power-up crates. */
export const POWER = {
  /** Walk through a crate within this distance to take it. */
  PICKUP_RADIUS: 1.3,
  /** After a shield soaks a hit: that long without further hits, and the attacker is stunned. */
  SHIELD_GRACE: 2.2,
  STUN: 3.5,
  CLOAK_TIME: 15,
  JET_TIME: 22,
  /** Jet boots: one extra jump in the air at this share of a normal jump. */
  AIR_JUMP: 0.95,
};

export const LASER = {
  /** Beam thickness used for hits (plus the player's radius). */
  RADIUS: 0.05,
  /** Beams flicker this long before switching on (visual warning, harmless). */
  WARN: 0.6,
  /** Server-side checks use a slightly smaller body so latency never kills unfairly. */
  SERVER_SHRINK: 0.08,
};

/** Bodies keep obeying physics after a kill: they are thrown, fall, slide and ride platforms. */
export const CORPSE = {
  /** A body lies this tall (it fits under things a standing runner does not). */
  HEIGHT: 0.7,
  /** Sliding friction on the ground (m/s^2). */
  FRICTION: 11,
  /** Share of the runner's own speed the body keeps. */
  KEEP: 0.55,
  /** Push away from a stalker / drone that got you, and from a shot's direction. */
  MELEE_PUSH: 5.0,
  MELEE_LIFT: 3.6,
  FLYER_PUSH: 3.6,
  FLYER_LIFT: 1.6,
  SHOT_PUSH: 5.5,
  SHOT_LIFT: 2.2,
  LASER_LIFT: 2.4,
  /** A body stops being simulated after this long (or once it is far below the course). */
  LIFE: 12,
  /** Shove when a shield soaks a hit (the runner keeps playing). */
  SHIELD_PUSH: 6.5,
  SHIELD_LIFT: 3.2,
};

export const CRUMBLE = {
  SHAKE_TIME: 0.85,
  RESPAWN_TIME: 7,
};

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
 * Sideways dash (Q / E): a short sidestep that takes you out of a charge. No
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

/** Grapple (right mouse): hook a marked anchor and swing on a rope. */
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
  /** A jump press, or letting go of the grapple button, this soon after hooking does not let go yet. */
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
  /** Boost: you run faster and jump further for this long. */
  BOOST_TIME: 22,
  /** ...run and sprint speed x this (a boosted sprint is 10.9 m/s, well clear of a stalker)... */
  BOOST_SPEED: 1.22,
  /** ...and take off at this share of a normal jump, so a sprint jump carries about a third further. */
  BOOST_JUMP: 1.08,
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
  /**
   * A body at rest on solid ground stops being simulated after this long; one
   * still moving, or riding a platform, keeps going (up to MAX_LIFE), so it
   * never freezes in mid-air when the platform under it moves on.
   */
  LIFE: 12,
  MAX_LIFE: 90,
  /** Landing faster than this (m/s) bounces the body back up at this share of the impact speed. */
  BOUNCE_MIN: 4,
  BOUNCE: 0.26,
  /** Share of the velocity into a wall that comes back out of it. */
  WALL_BOUNCE: 0.4,
  /** Shove when a shield soaks a hit (the runner keeps playing). */
  SHIELD_PUSH: 6.5,
  SHIELD_LIFT: 3.2,
};

export const CRUMBLE = {
  SHAKE_TIME: 0.85,
  RESPAWN_TIME: 7,
};

/**
 * The portal: on one run in ten a doorway of light opens at a random spot on the
 * course. Stepping through it takes you to Viktor, who sends you back to the
 * landing pad able to fly for the rest of that run.
 */
export const PORTAL = {
  /** Share of runs that get a portal. */
  CHANCE: 0.1,
  /**
   * For testing: with a runner of this name in the room (any case), every run gets
   * one, standing on the landing pad in front of the spawns (LevelData.portalTest)
   * and opening this many seconds after "Go!".
   */
  TEST_NAME: 'vk3',
  TEST_OPEN: 1,
  /** It opens a random moment this long after "Go!" (seconds). */
  OPEN_MIN: 3,
  OPEN_MAX: 9,
  /** Height of the ring's centre above the ground it stands on, and its inner radius. */
  HEIGHT: 1.75,
  RADIUS: 1.25,
  /** You are through once your chest is this close to the centre of the ring. */
  ENTER_RADIUS: 1.1,
  /** The server allows this much more (its copy of your position is a message old). */
  SERVER_SLACK: 2.5,
  /** The shortest visit the server believes: the conversation cannot be skipped outright. */
  MIN_STAY: 5,
};

// ======================================================================= stage 2
// Reaching the beacon opens it into a portal: the whole team goes through into
// the Warden's arena, each runner picks one superpower, and the fight is on.

/** The arena: its own little world, far beyond the Spire and high above the clouds. */
export const ARENA = {
  /** Centre of the arena floor (the floor's top is at y). */
  x: 0, y: 140, z: 1500,
  /** Someone touched the beacon: everyone is pulled through this many seconds later. */
  GATE_TIME: 2.6,
  /** The Warden wakes once everyone has a power, or this long after the team arrives. */
  WAKE_AFTER: 25,
  /** Falling this far below the arena floor is falling off the world. */
  KILL_DROP: 45,
  /** Server's horizontal speed limit in the arena (knockback, with slack); a speedster's is higher. */
  MAX_CLIENT_SPEED: 22,
  MAX_SPEEDSTER_SPEED: 36,
};

/**
 * A runner's health in the arena (the course itself stays one hit, one death).
 * Going down in the arena is final too: there is no coming back mid-fight, and
 * when the whole team is down the fight is lost and starts over.
 */
export const PHP = {
  MAX: 100,
  /** Health back per second, once you have not been hurt for REGEN_DELAY seconds. */
  REGEN: 2.25,
  REGEN_DELAY: 4,
};

export type SuperPower = 'kinetic' | 'telekinesis' | 'lightning' | 'gravity' | 'speed' | 'clone';
/** Snapshot order (index + 1 on the wire, 0 = none chosen yet). */
export const SUPERS: SuperPower[] = ['kinetic', 'telekinesis', 'lightning', 'gravity', 'speed', 'clone'];

/** Most health a runner with this power has (kinetic force makes you bigger and tougher). */
export function powerHp(k: SuperPower | null | undefined): number {
  return k === 'kinetic' ? POW.kinetic.HP : PHP.MAX;
}

/**
 * The six powers. Each is one ability on the left mouse button whose behaviour
 * follows what you are doing (on the ground or in the air, holding something or
 * not), never a kit of separate moves. Server and client read the same numbers:
 * the client to play it at once, the server to decide what it hit.
 */
export const POW = {
  kinetic: {
    /** The power makes you bigger (drawn this much larger) and tougher (this much health). */
    SCALE: 1.3, HP: 160,
    /**
     * Punch: a short lunge along the aim, then a cone that hits everything in front of you.
     * Punches run as a combo (jab, cross, hook, uppercut) while they come within COMBO
     * seconds of each other; the hook throws things sideways, the uppercut throws them up.
     */
    COOLDOWN: 0.5, LUNGE_SPEED: 17, LUNGE_TIME: 0.13, REACH: 5.0, CONE: 0.85, COMBO: 1.0,
    DAMAGE: 26, BOT_DAMAGE: 55, POISE: 13, KNOCK: 17, LIFT: 6, UPPERCUT_LIFT: 14, HOOK_SIDE: 12,
    /** Meteor slam (press in the air): a dive whose landing is a shockwave that grows with the drop. */
    SLAM_SPEED: 30, SLAM_RADIUS: 5.8, SLAM_BASE: 22, SLAM_PER_SPEED: 2.1, SLAM_MAX: 95, SLAM_POISE: 26, SLAM_COOLDOWN: 1.0,
    /** Objects (scrap, canisters) punched away fly off at this speed. */
    BAT_SPEED: 30,
    /**
     * Hurl (R): tear a slab of debris out of the floor, heave it up for LIFT seconds and
     * throw it along the aim; it shatters on whatever it hits, hurting all round it.
     */
    HURL_COOLDOWN: 3.5, HURL_LIFT: 0.32, HURL_SPEED: 38, HURL_RADIUS: 3,
    HURL_DAMAGE: 60, HURL_BOT: 70, HURL_POISE: 30, HURL_KNOCK: 13,
  },
  telekinesis: {
    /** Between grabs, and after a throw (a throw needs a moment to wind up the next). */
    COOLDOWN: 0.3, THROW_COOLDOWN: 0.6, RANGE: 28, LOCK: 0.2,
    /** A held bot is crushed this fast; a held thing drops by itself after HOLD seconds. */
    CRUSH: 12, HOLD: 5,
    THROW_SPEED: 54,
    /** Thrown things hitting the Warden or a bot: damage by what it is. */
    BOT_HIT: 55, SCRAP_HIT: 55, SCRAP_POISE: 24,
    /** Push (nothing to grab): a cone that shoves bots and turns shots around. */
    PUSH_COOLDOWN: 0.75, PUSH_RANGE: 12, PUSH_CONE: 0.62, PUSH_KNOCK: 17, PUSH_DAMAGE: 10, PUSH_BOSS: 7, PUSH_POISE: 8,
  },
  lightning: {
    /** Hold to fire: a bolt every INTERVAL, chaining on to JUMPS more targets within CHAIN metres. */
    INTERVAL: 0.14, RANGE: 32, LOCK: 0.22, DAMAGE: 5.4, BOT_DAMAGE: 11.7, CHAIN: 8, JUMPS: 3, CHAIN_FALLOFF: 0.72,
    STUN: 0.28, POISE: 1.6,
    /** Heat: each bolt adds HEAT_PER, it cools at COOL a second; full heat locks you out for OVERHEAT. */
    HEAT_PER: 9, COOL: 24, OVERHEAT: 1.3,
    /** Every THUNDER bolts on the Warden, the storm answers with a strike of its own. */
    THUNDER: 25, THUNDER_DAMAGE: 63, THUNDER_BOT: 27, THUNDER_POISE: 32,
  },
  gravity: {
    /** Gravity well: thrown along the aim, it opens where it hits (or at RANGE) and pulls things in. */
    COOLDOWN: 3.0, SPEED: 30, RANGE: 30, RADIUS: 9.5, LIFE: 2.6, PULL: 13,
    CRUSH: 12.8, BOSS_DPS: 19.2, BOSS_POISE: 9, SLOW: 0.45,
    /** When it closes it implodes: a burst that throws everything outward and up. */
    BURST: 36, BURST_RADIUS: 5, BURST_BOSS: 44, BURST_KNOCK: 15,
    /** Passive: jumps carry higher, and holding jump on the way down floats you. */
    JUMP: 1.3, FLOAT: 0.3, FLOAT_MAX_FALL: 5,
  },
  speed: {
    /** Passive: much faster running and sprinting, snappier acceleration (and a trail of light behind you). */
    RUN: 1.875, SPRINT: 2.25, ACCEL: 2.2,
    /** Above this speed the trail and the afterimages show. */
    TRAIL_SPEED: 10,
    /**
     * Flash strike: a straight streak along the aim that hits everything it passes.
     * Aimed at something, it stops OVERSHOOT metres past it (at most DIST away);
     * aimed at nothing, it runs the whole DIST.
     */
    COOLDOWN: 0.3, CHAIN_COOLDOWN: 0.1, CHAIN_MAX: 6, CHAIN_REST: 0.45,
    DIST: 14, OVERSHOOT: 2.5, FLASH_SPEED: 110, WIDTH: 1.7, PITCH: 0.7,
    /** Damage grows with how fast you were going when you struck. */
    BASE: 8, PER_SPEED: 0.9, BOSS_SHARE: 0.75, POISE: 6, KNOCK: 11,
  },
  clone: {
    /** Split: a copy of you steps out, up to MAX at once, one every SPLIT_COOLDOWN seconds. */
    MAX: 4, SPLIT_COOLDOWN: 1.3, HP: 55,
    /** They run with you: back to your side past LEASH metres, reappearing beside you past REGROUP (or when stuck). */
    SPEED: 8.6, ACCEL: 38, LEASH: 11, REGROUP: 19, STUCK: 1.4, SLOT_R: 2.8,
    /** What they go for: bots and the Warden within TARGET_RANGE of you. */
    TARGET_RANGE: 15,
    /** Their strike: an open-palm blow that reaches REACH metres from the chest. */
    REACH: 3.4, DAMAGE: 10.5, BOT_DAMAGE: 22, POISE: 3.5, KNOCK: 7, STRIKE_COOLDOWN: 0.8,
    /** Rally (click with all four out): they all go for what you point at, harder, for RALLY_TIME. */
    RALLY_TIME: 3.5, RALLY_K: 1.6, RALLY_COOLDOWN: 5, RALLY_RANGE: 22,
  },
};

/** The Warden: a four-legged war machine as tall as a building. */
export const BOSS = {
  NAME: 'The Warden',
  /** Health for one runner; each extra runner adds this share. */
  HP: 11000, HP_PER_PLAYER: 0.7,
  /** Poise: damage fills it, and when it is full the Warden staggers. */
  POISE: 135, POISE_REGEN: 11, POISE_DELAY: 2.0, STAGGER: 3.8, STAGGER_IMMUNE: 4,
  /** Taking this much damage to the eye while it charges the beam makes it flinch (a short stagger). */
  EYE_FLINCH: 60, FLINCH: 1.6,
  /** Overdrive below this share of health: faster, shorter cool-downs, more of everything. */
  OVERDRIVE: 0.5, OD_SPEED: 1.35, OD_COOLDOWN: 0.72, OD_TELL: 0.85,
  /** Body: hull height above the floor when standing, rearing, staggered and dead. */
  LIFT: 7.6, LIFT_REAR: 8.8, LIFT_STAGGER: 3.9, LIFT_DEAD: 2.2,
  HULL: [7, 3.4, 9] as [number, number, number],
  /** Walking. It stays on the inner floor, clear of the conductor pillars. */
  WALK: 3.8, TURN: 1.45, ROAM: 21, PILLAR_CLEAR: 6.2,
  /** Seconds it takes to get over one attack before starting the next. */
  RECOVER: [0.5, 1.1] as [number, number],
  // --- abilities
  STOMP: { COOLDOWN: 6, TELL: 0.8, RANGE: 12, SPEED: 17, R0: 3, R1: 28, BAND: 1.7, HEIGHT: 1.15, DAMAGE: 32, KNOCK: 13, LIFT: 8 },
  BEAM: { COOLDOWN: 8, TELL: 1.0, SWEEP: 2.0, ARC: 1.1, MIN: 8, MAX: 52, HEIGHT: 1.25, DAMAGE: 26, GRACE: 0.6, KNOCK: 5 },
  MORTAR: { COOLDOWN: 7, TELL: 0.55, SHELLS: 6, PER_PLAYER: 2, SPREAD: 1.15, FLIGHT: [1.3, 1.8] as [number, number], RADIUS: 3.9, DAMAGE: 34, KNOCK: 10, SCATTER: 5 },
  DEPLOY: { COOLDOWN: 11, TELL: 0.85, COUNT: [3, 3, 4] as [number, number, number], FIRST: 5 },
  CHARGE: { COOLDOWN: 10, TELL: 0.9, SPEED: 18, TIME: 2.2, MIN: 16, WIDTH: 3.8, DAMAGE: 46, KNOCK: 16, LIFT: 9, CRASH: 4.4 },
  SWIPE: { COOLDOWN: 4.5, TELL: 0.55, TIME: 0.42, R0: 3.5, R1: 11.5, Y0: 2.2, Y1: 10, DAMAGE: 29, KNOCK: 15 },
  SHOCK: { COOLDOWN: 4.5, TELL: 0.75, RIDE: 0.8, DAMAGE: 24, KNOCK: 10, LIFT: 14 },
  /** It is dying for this long after its health runs out, then it is over. */
  DYING: 3.6, VICTORY: 5.5,
};

/** The bots the Warden launches from the hive on its back. */
export const BOT = {
  /** Most alive at once: BASE plus PER_PLAYER per runner (one more in overdrive). */
  CAP_BASE: 3, CAP_PER_PLAYER: 2,
  skitter: {
    HP: 45, RADIUS: 0.55, HEIGHT: 0.95, SPEED: 6.8, ACCEL: 30, REACH: 2.2, TELL: 0.4, LUNGE: 11, LUNGE_TIME: 0.26,
    BITE: 1.5, DAMAGE: 18, KNOCK: 7, REST: 1.0, POUNCE: 6.5, POUNCE_COOLDOWN: 3,
  },
  wasp: {
    HP: 30, RADIUS: 0.6, SPEED: 6.2, ACCEL: 9, HOVER: [5, 9] as [number, number], KEEP: [11, 16] as [number, number],
    TELL: 0.65, COOLDOWN: 2.2, SHOT_SPEED: 23, SHOT_RADIUS: 0.3, DAMAGE: 14, KNOCK: 4,
  },
  /** Knocked about: slams into things above this speed hurt, per m/s over it. */
  IMPACT_SPEED: 13, IMPACT_DAMAGE: 3.5,
  /** A bot that was just hit reels for this long (or longer, for heavy hits). */
  STUN: 0.35,
};

/** Loose things in the arena: explosive canisters and the armour plates the Warden sheds. */
export const JUNK = {
  RADIUS: 0.6, MAX: 16,
  /** A canister goes off when it hits something hard, is shot or is crushed. */
  CANISTER_RADIUS: 5, CANISTER_DAMAGE: 60, CANISTER_BOSS: 70, CANISTER_POISE: 30, CANISTER_KNOCK: 14,
  RESPAWN: 22,
  /** Moving faster than this, a flying thing hurts what it hits. */
  HIT_SPEED: 12,
};

/** Flight, Viktor's gift: left click takes off and lands, the camera steers. */
export const FLY = {
  /** Cruising speed, and with Shift held. */
  SPEED: 11,
  FAST: 19,
  /** Climb (Space) and descent (Ctrl) speed on top of the way you are looking. */
  VERTICAL: 7.5,
  /** Speeding up toward what the keys ask for, and gliding to a stop when they let go. */
  ACCEL: 26,
  DECEL: 11,
  /** Upward kick when taking off from the ground. */
  TAKEOFF_VY: 6,
  /** While flying you float this far above whatever is below you, unless you hold descend. */
  HOVER: 0.45,
  /** Lowest altitude (above the level's kill height) and highest you can fly. */
  FLOOR_ABOVE_KILL: 16,
  CEILING: 190,
  /** How far past the level's bounds you can wander before the air pushes you back. */
  MARGIN: 150,
  /** Server's horizontal speed limit for a runner who can fly (m/s, with slack). */
  MAX_CLIENT_SPEED: 25,
};

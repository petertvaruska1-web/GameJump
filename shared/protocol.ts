// Wire protocol. Compact JSON: arrays for high-frequency data, objects for rare messages.

import type { EnemyKind, SuperPower } from './constants';
import type { PowerKind } from './level/types';

export const PROTOCOL_VERSION = 6;

export type Phase = 'lobby' | 'countdown' | 'playing' | 'ended';

/**
 * Which half of the run the room is in: the course, the moment the beacon has
 * opened and is about to pull everyone through, or the Warden's arena.
 */
export type Stage = 'course' | 'gate' | 'boss';

export const Status = { Alive: 0, Dead: 1, Finished: 2, Left: 3 } as const;
export type Status = (typeof Status)[keyof typeof Status];

/** 'warden' and 'bot': taken down in the arena (by the Warden itself, or by one of its bots). */
export type DeathCause = 'fall' | 'melee' | 'shot' | 'flyer' | 'laser' | 'warden' | 'bot';

export const EState = { Idle: 0, Alert: 1, Chase: 2, Attack: 3, Search: 4, Return: 5 } as const;
export type EState = (typeof EState)[keyof typeof EState];

/** What the Warden is doing. */
export const BState = { Dormant: 0, Waking: 1, Walk: 2, Act: 3, Recover: 4, Stagger: 5, Dying: 6, Dead: 7 } as const;
export type BState = (typeof BState)[keyof typeof BState];

/** The Warden's abilities (0 = none). */
export const BAct = { None: 0, Stomp: 1, Beam: 2, Mortar: 3, Deploy: 4, Charge: 5, Swipe: 6, Shock: 7 } as const;
export type BAct = (typeof BAct)[keyof typeof BAct];

/** Parts of the Warden a hit can land on (they take different damage). */
export const BPart = { Hull: 0, Core: 1, Head: 2, Eye: 3, Leg: 4, Arm: 5 } as const;
export type BPart = (typeof BPart)[keyof typeof BPart];

export const BotKind = { Skitter: 0, Wasp: 1 } as const;
export type BotKind = (typeof BotKind)[keyof typeof BotKind];
/** What a bot is up to (drives its look and its sounds). */
export const BotState = { Flying: 0, Boot: 1, Hunt: 2, Tell: 3, Strike: 4, Rest: 5, Reel: 6, Held: 7 } as const;
export type BotState = (typeof BotState)[keyof typeof BotState];

export const JunkKind = { Canister: 0, Plate: 1, Shell: 2 } as const;
export type JunkKind = (typeof JunkKind)[keyof typeof JunkKind];

/**
 * A power being used (C2S 'pow' action codes). Kinetic: punch / slam landing.
 * Telekinesis: grab / throw / push. Lightning: bolt. Gravity: well. Speed:
 * flash strike. Teleport: blink.
 */
export const PowAct = { Punch: 0, Slam: 1, Grab: 2, Throw: 3, Push: 4, Bolt: 5, Well: 6, Flash: 7, Blink: 8, Drop: 9 } as const;
export type PowAct = (typeof PowAct)[keyof typeof PowAct];

/**
 * Something a power can target: the Warden (with a part), a bot, or a loose thing.
 * On the wire: [kind, id, part] with kind 0 = Warden, 1 = bot, 2 = junk.
 */
export type TargetRef = [number, number, number];

export interface LobbyPlayer {
  id: number;
  name: string;
  ready: boolean;
  host: boolean;
  connected: boolean;
  status: Status;
}

// ------------------------------------------------------------------ client -> server
export type C2S =
  | { t: 'create'; name: string; v: number }
  | { t: 'join'; code: string; name: string; v: number }
  | { t: 'resume'; code: string; token: string; v: number }
  | { t: 'ready'; r: boolean }
  /** `stage: 'boss'`: a rematch, straight into the Warden's arena. */
  | { t: 'start'; stage?: 'boss' }
  /** Abandon the run in progress and count down a fresh one. Only for a host alone in the room. */
  | { t: 'restart' }
  | { t: 'lobby' }
  | { t: 'leave' }
  | { t: 'ping'; c: number }
  /**
   * Player state: seq, position, velocity, yaw, anim, standing-on collider id (-1 none), client match time,
   * and `b`: 1 when the client is in the Warden's arena (a report from the wrong side of the beacon is dropped).
   */
  | { t: 'st'; s: number; p: [number, number, number]; v: [number, number, number]; y: number; a: number; g: number; tm?: number; b?: number }
  /** The client saw its own runner touch a laser (a client can only report its own death). */
  | { t: 'die'; cause: 'laser' }
  /** The client's runner stepped through the open portal. */
  | { t: 'portal' }
  /** Viktor has finished speaking: send the runner back to the start, able to fly. */
  | { t: 'bless' }
  /** In the arena: this is the power I want (index into SUPERS). */
  | { t: 'pick'; k: number }
  /**
   * In the arena: I used my power. `a`: PowAct. `o`: where from, `d`: the aim
   * (unit vector), `tg`: what it was aimed at, `p`: where it ended (a blink's
   * destination, a flash strike's end, a slam's landing), `v`: a number the act
   * needs (a slam's landing speed), `tm`: my match clock.
   */
  | { t: 'pow'; a: number; o: [number, number, number]; d: [number, number, number]; tg?: TargetRef; p?: [number, number, number]; v?: number; tm: number }
  | { t: 'dbg'; cmd: 'tp'; p: [number, number, number] }
  /** Debug: open the beacon now, as if this runner had reached it. */
  | { t: 'dbg'; cmd: 'gate' }
  /** Debug: set the Warden's health to this share of its maximum. */
  | { t: 'dbg'; cmd: 'bosshp'; v: number }
  /** Debug: open the portal a few metres in front of the runner, right now. */
  | { t: 'dbg'; cmd: 'portal' }
  | { t: 'dbg'; cmd: 'restart' }
  | { t: 'dbg'; cmd: 'god' };

// ------------------------------------------------------------------ server -> client
/** [id, x, y, z, yaw, anim, status, hp, power] (hp and power only mean something in the arena) */
export type PlayerSnap = [number, number, number, number, number, number, number, number, number];
/** [id, x, y, z, yaw, state, targetId, aux] (aux = sentinel charge 0..1) */
export type EnemySnap = [number, number, number, number, number, number, number, number];
/**
 * The Warden: [x, z, yaw, lift, state, hp, act, act time, target, poise, flags].
 * x / z are on the arena floor, lift is the hull's height above it, act time the
 * seconds since the current ability began. flags: 1 overdrive, 2 a runner rides it.
 */
export type BossSnap = [number, number, number, number, number, number, number, number, number, number, number];
/** A bot: [id, kind, x, y, z, yaw, state, hp share 0..100, target]. */
export type BotSnap = [number, number, number, number, number, number, number, number, number];
/** A loose thing: [id, kind, x, y, z, holder (player id, 0 none), spin]. */
export type JunkSnap = [number, number, number, number, number, number, number];

/** What hurt a runner in the arena (for the hit direction and the sound). */
export type HurtSrc = 'stomp' | 'beam' | 'mortar' | 'charge' | 'swipe' | 'shock' | 'bite' | 'sting' | 'blast';

export type GameEvent =
  /** `v`: the impulse the body was thrown with, so every client sees the same tumble. */
  | { k: 'death'; id: number; cause: DeathCause; by: number; p: [number, number, number]; v?: [number, number, number] }
  | { k: 'finish'; id: number; time: number; place: number }
  | { k: 'alert'; e: number; target: number }
  | { k: 'lost'; e: number }
  | { k: 'charge'; e: number }
  | { k: 'shot'; id: number; e: number; p: [number, number, number]; v: [number, number, number]; t: number }
  | { k: 'pend'; id: number; p: [number, number, number]; hit: boolean }
  | { k: 'crumble'; id: number; s: 'shake' | 'fall' | 'reset'; t: number }
  /** Player `p` took crate `id`; timed powers last until match time `until`. */
  | { k: 'pickup'; id: number; p: number; kind: PowerKind; until: number }
  /** Player `id`'s shield soaked a hit (from enemy `by`, -1 for lasers). */
  | { k: 'shield'; id: number; by: number; v?: [number, number, number] }
  /** A portal stands at `p` turned to `yaw`, open from match time `at` (only sent when it is placed mid-run). */
  | { k: 'portal'; p: [number, number, number]; yaw: number; at: number }
  /** Player `id` stepped through the portal ('in'), or came back to `p` able to fly ('out'). */
  | { k: 'heaven'; id: number; s: 'in' | 'out'; p?: [number, number, number] }
  | { k: 'left'; id: number }
  | { k: 'reconnected'; id: number }
  | { k: 'lostconn'; id: number }
  // ------------------------------------------------------------------ stage 2
  /** Runner `id` reached the beacon: it opens, and everyone goes through at match time `at`. */
  | { k: 'gate'; id: number; at: number; time: number }
  /** Everyone is in the arena now, at these spots. The Warden wakes by match time `wake` at the latest. */
  | { k: 'arena'; spawns: Record<number, [number, number, number]>; wake: number }
  /** Runner `id` chose power `k` (index into SUPERS). */
  | { k: 'pick'; id: number; power: number }
  /** The Warden wakes up. */
  | { k: 'wake' }
  /**
   * The Warden starts an ability (its tell starts at match time `at`). `d` is what
   * every client needs to draw it exactly as the server plays it: see warden.ts.
   */
  | { k: 'act'; a: number; at: number; d: number[] }
  /** Damage to the Warden: by runner `by` on part `part`, at `p`, leaving it `hp`. `c`: a critical hit. */
  | { k: 'hit'; by: number; n: number; part: number; p: [number, number, number]; hp: number; c?: boolean }
  /** The Warden staggers (`on`), or gets back up. `why`: what broke it. */
  | { k: 'stagger'; on: boolean; why?: 'poise' | 'crash' | 'eye' }
  /** The Warden goes into overdrive. */
  | { k: 'overdrive' }
  /** The Warden's health ran out: `by` landed the last blow. */
  | { k: 'fall'; by: number }
  /** A bot is launched from the hive at `p`, landing at `q` around match time `at`. */
  | { k: 'bot'; id: number; kind: number; p: [number, number, number]; q: [number, number, number]; at: number }
  /** Bot `id` took `n` damage from runner `by` (0 for the world). */
  | { k: 'bhit'; id: number; n: number; by: number }
  /** Bot `id` is destroyed (by runner `by`, 0 for anything else). */
  | { k: 'bdie'; id: number; p: [number, number, number]; by: number }
  /** A wasp fires: an orb from `p` with velocity `v`, at match time `t`. */
  | { k: 'orb'; id: number; p: [number, number, number]; v: [number, number, number]; t: number }
  /** An orb ends at `p` (`r`: it was turned around and now flies at the enemy). */
  | { k: 'oend'; id: number; p: [number, number, number] }
  /** Runner `id` was hurt: `n` damage, `hp` left, shoved by `v`, from `from`. */
  | { k: 'hurt'; id: number; n: number; hp: number; src: HurtSrc; v?: [number, number, number]; from?: [number, number, number] }
  /** Runner `id` is back at the arena's beacon. */
  | { k: 'respawn'; id: number; p: [number, number, number] }
  /**
   * Runner `id` used a power (everyone draws it; the user already has). `f`: the
   * PowAct, `d`: numbers that shape it (points, a chain's path, a charge).
   */
  | { k: 'fx'; id: number; f: number; d: number[] }
  /** An explosion at `p` of radius `r` (`c`: 0 canister, 1 mortar shell, 2 gravity implosion, 3 bot, 4 thunder). */
  | { k: 'boom'; p: [number, number, number]; r: number; c: number }
  /** A lightning bolt from the storm onto the Warden, called down by runner `id`. */
  | { k: 'thunder'; id: number; p: [number, number, number] }
  /** A mortar shell (loose thing `id`) leaves a cannon at `p` with velocity `v` at time `t`, aimed at `q`. */
  | { k: 'shell'; id: number; p: [number, number, number]; v: [number, number, number]; q: [number, number, number]; t: number }
  /** Gravity well `id` opens at `p` (or closes there with an implosion). */
  | { k: 'well'; id: number; s: 'open' | 'close'; p: [number, number, number] };

export interface MatchResult {
  id: number;
  name: string;
  status: Status;
  time: number;
  cause?: DeathCause;
  place?: number;
  /** A run that went through the beacon: the course time, and the fight's numbers. */
  course?: number;
  damage?: number;
  deaths?: number;
  bots?: number;
  power?: number;
}

export type S2C =
  | { t: 'joined'; code: string; id: number; token: string; debug: boolean }
  | { t: 'room'; code: string; phase: Phase; hostId: number; players: LobbyPlayer[] }
  | { t: 'err'; code: ErrCode; msg: string }
  | {
    t: 'start'; goAt: number; now: number; spawns: Record<number, [number, number, number]>; resume?: boolean; crumbles?: [number, string, number][];
    /** Crates already taken, and per player [id, shield 0/1, cloakUntil, boostUntil] (for resumes). */
    taken?: number[]; powers?: [number, number, number, number][];
    /** This run's portal, [x, y, z, yaw, opens at match time], if it has one. */
    portal?: [number, number, number, number, number];
    /** Players who can fly (they have been to Viktor this run). */
    fly?: number[];
    /**
     * Where the run is. In the arena (or on the way there): the stage, when the
     * beacon opened, the course time, the powers already chosen [id, power],
     * whether the Warden is awake and when it will wake at the latest.
     */
    stage?: Stage; gateAt?: number; course?: number; picks?: [number, number][]; awake?: boolean; wake?: number;
  }
  | { t: 'snap'; ts: number; p: PlayerSnap[]; e: EnemySnap[]; b?: BossSnap; m?: BotSnap[]; j?: JunkSnap[] }
  | { t: 'ev'; e: GameEvent[] }
  | { t: 'pong'; c: number; s: number }
  | { t: 'fix'; p: [number, number, number] }
  /** `boss`: the run ended with the Warden destroyed. `fight`: how long the fight took. */
  | { t: 'end'; results: MatchResult[]; duration: number; boss?: boolean; fight?: number };

export type ErrCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'IN_PROGRESS'
  | 'BAD_VERSION'
  | 'BAD_REQUEST'
  | 'RESUME_FAILED'
  | 'ROOM_CLOSED'
  | 'NOT_HOST';

export const ENEMY_KIND_CODE: Record<EnemyKind, number> = { melee: 0, ranged: 1, flyer: 2 };

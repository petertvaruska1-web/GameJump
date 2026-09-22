// Wire protocol. Compact JSON: arrays for high-frequency data, objects for rare messages.

import type { EnemyKind } from './constants';
import type { PowerKind } from './level/types';

export const PROTOCOL_VERSION = 4;

export type Phase = 'lobby' | 'countdown' | 'playing' | 'ended';

export const Status = { Alive: 0, Dead: 1, Finished: 2, Left: 3 } as const;
export type Status = (typeof Status)[keyof typeof Status];

export type DeathCause = 'fall' | 'melee' | 'shot' | 'flyer' | 'laser';

export const EState = { Idle: 0, Alert: 1, Chase: 2, Attack: 3, Search: 4, Return: 5 } as const;
export type EState = (typeof EState)[keyof typeof EState];

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
  | { t: 'start' }
  | { t: 'lobby' }
  | { t: 'leave' }
  | { t: 'ping'; c: number }
  /** Player state: seq, position, velocity, yaw, anim, standing-on collider id (-1 none), client match time. */
  | { t: 'st'; s: number; p: [number, number, number]; v: [number, number, number]; y: number; a: number; g: number; tm?: number }
  /** The client saw its own runner touch a laser (a client can only report its own death). */
  | { t: 'die'; cause: 'laser' }
  | { t: 'dbg'; cmd: 'tp'; p: [number, number, number] }
  | { t: 'dbg'; cmd: 'restart' }
  | { t: 'dbg'; cmd: 'god' };

// ------------------------------------------------------------------ server -> client
/** [id, x, y, z, yaw, anim, status] */
export type PlayerSnap = [number, number, number, number, number, number, number];
/** [id, x, y, z, yaw, state, targetId, aux] (aux = sentinel charge 0..1) */
export type EnemySnap = [number, number, number, number, number, number, number, number];

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
  | { k: 'left'; id: number }
  | { k: 'reconnected'; id: number }
  | { k: 'lostconn'; id: number };

export interface MatchResult {
  id: number;
  name: string;
  status: Status;
  time: number;
  cause?: DeathCause;
  place?: number;
}

export type S2C =
  | { t: 'joined'; code: string; id: number; token: string; debug: boolean }
  | { t: 'room'; code: string; phase: Phase; hostId: number; players: LobbyPlayer[] }
  | { t: 'err'; code: ErrCode; msg: string }
  | {
    t: 'start'; goAt: number; now: number; spawns: Record<number, [number, number, number]>; resume?: boolean; crumbles?: [number, string, number][];
    /** Crates already taken, and per player [id, shield 0/1, cloakUntil, boostUntil] (for resumes). */
    taken?: number[]; powers?: [number, number, number, number][];
  }
  | { t: 'snap'; ts: number; p: PlayerSnap[]; e: EnemySnap[] }
  | { t: 'ev'; e: GameEvent[] }
  | { t: 'pong'; c: number; s: number }
  | { t: 'fix'; p: [number, number, number] }
  | { t: 'end'; results: MatchResult[]; duration: number };

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

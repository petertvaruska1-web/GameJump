// Data-driven level description. Everything the engine needs to build the
// collision world, the visuals, the enemies and the objectives lives here.

import type { EnemyKind } from '../constants';

export type V3 = [number, number, number];

export type MatKey =
  | 'concrete'
  | 'concreteDark'
  | 'metal'
  | 'steel'
  | 'rust'
  | 'hazard'
  | 'grate'
  | 'glass'
  | 'pipe'
  | 'trim'
  | 'white'
  | 'tank'
  | 'lightWarm'
  | 'lightRed'
  | 'lightCyan'
  | 'finish'
  | 'belt'
  | 'launch'
  | 'invisible';

export type BoxKind = 'static' | 'mover' | 'crumble' | 'sweeper';

export interface MoveDef {
  /** Mover: position = base + offset * wave(t). */
  offset?: V3;
  period: number;
  phase: number;
  /** Fraction of the period spent resting at each end (0 .. 0.45). */
  pause?: number;
  /** Sweeper: angular speed in rad/s (rotation about the pivot = box position). */
  spin?: number;
  /** Sweeper: arm centre offset along its local X axis from the pivot. */
  arm?: number;
}

export interface BoxDef {
  id: number;
  /** Centre of the box (for sweepers: the pivot). */
  p: V3;
  /** Full size (w, h, d) in the local frame. */
  s: V3;
  /** Yaw in radians. */
  ry: number;
  mat: MatKey;
  kind: BoxKind;
  solid: boolean;
  visible: boolean;
  blocksSight: boolean;
  /** Ramp: the top surface rises by this amount along local +Z. */
  rise?: number;
  move?: MoveDef;
  /** Multiplicative colour variation for visuals (0.85 .. 1.15). */
  tint?: number;
  /** Name of the route/section for debugging. */
  tag?: string;
  /** Conveyor belt: surface speed (m/s) along the box's local +Z (negative = toward -Z). */
  belt?: number;
  /** Launch pad: anyone standing on it is thrown in an arc onto this target. */
  launch?: LaunchDef;
}

export interface LaunchDef {
  /** Landing point (top surface of the target). */
  to: V3;
  /** Peak height of the arc above the higher of pad and target. */
  apex: number;
}

/** Zip line: a cable from `a` (high end) down to `b`. Riders hang below it. */
export interface ZiplineDef {
  id: number;
  a: V3;
  b: V3;
  tag?: string;
}

/**
 * Laser beam: a horizontal segment from `a` to `b` that kills on contact while
 * it is on. It can travel (ping-pong `move` offset), spin around its midpoint,
 * and blink on/off. All of it is a pure function of the match clock.
 */
export interface LaserDef {
  id: number;
  a: V3;
  b: V3;
  /** Travel: offset = move * wave(t) (same wave as moving platforms). */
  move?: V3;
  period?: number;
  phase?: number;
  pause?: number;
  /** Spin around the beam's midpoint (rad/s). */
  spin?: number;
  /** Blink cycle length in seconds (0/undefined = always on). */
  cycle?: number;
  /** Fraction of the cycle the beam is on. */
  duty?: number;
  /** Cycle offset 0..1. */
  cyclePhase?: number;
  /** Beams of one gate share a group id (visuals, sounds). */
  group: number;
  tag?: string;
}

/** Grapple anchor: hook it with the grapple key when it is in range and in view. */
export interface GrappleDef {
  id: number;
  p: V3;
  /** Optional anchors (rescues / shortcuts) are drawn a little smaller. */
  optional?: boolean;
  tag?: string;
}

export type PowerKind = 'shield' | 'cloak' | 'boost';

/** Power-up crate, taken by walking through it (once per match). */
export interface PickupDef {
  id: number;
  kind: PowerKind;
  p: V3;
  tag?: string;
}

/** Contextual tip shown the first time a player gets close. */
export interface HintDef {
  key: string;
  p: V3;
  r: number;
  text: string;
}

export type PropType =
  | 'pipe'
  | 'tank'
  | 'antenna'
  | 'beacon'
  | 'lamp'
  | 'redLight'
  | 'crate'
  | 'barrel'
  | 'cable'
  | 'girder'
  | 'chimney'
  | 'fan'
  | 'sign'
  | 'debris'
  | 'arrow'
  | 'windsock'
  | 'dish';

export interface PropDef {
  t: PropType;
  p: V3;
  /** Generic size parameter; meaning depends on prop type. */
  s?: V3;
  ry?: number;
  /** Second point for pipes/cables. */
  q?: V3;
  /** Variant / colour selector. */
  v?: number;
}

export interface EnemyDef {
  id: number;
  kind: EnemyKind;
  p: V3;
  yaw: number;
  /** Optional patrol loop (melee walks it, flyers hover between points). */
  patrol?: V3[];
  /** Override for the chase leash radius. */
  leash?: number;
  tag?: string;
}

export interface WindDef {
  id: number;
  min: V3;
  max: V3;
  /** Horizontal push direction (normalised in builder). */
  dir: [number, number];
  strength: number;
  period: number;
  /** Fraction of the period during which the gust blows. */
  duty: number;
  phase: number;
}

export interface ZoneDef {
  name: string;
  min: [number, number];
  max: [number, number];
}

export interface LevelData {
  name: string;
  boxes: BoxDef[];
  props: PropDef[];
  enemies: EnemyDef[];
  winds: WindDef[];
  zones: ZoneDef[];
  spawns: V3[];
  spawnYaw: number;
  finish: { min: V3; max: V3 };
  beacon: V3;
  killY: number;
  bounds: { min: [number, number]; max: [number, number] };
  /** Debug teleport points. */
  waypoints: { name: string; p: V3 }[];
  ziplines: ZiplineDef[];
  lasers: LaserDef[];
  hints: HintDef[];
  grapples: GrappleDef[];
  pickups: PickupDef[];
}

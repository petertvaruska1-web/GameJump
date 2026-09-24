// The Warden's arena, the Anvil: an island floor ringed by a moat of open air,
// a raised rampart around it broken by three gaps, four conductor pillars on the
// floor, floating perches with zip lines running back across the arena, and a
// crown of grapple anchors overhead. It is built with the course's own toolkit,
// so every ramp, pad, cable and anchor behaves exactly as it does on the course.
//
// Everything is placed in arena-local terms (angle phi from +Z toward +X,
// radius r from the centre, height above the floor) and moved to ARENA.
//
//                       N  (gap, anchor over it)
//              perch  .-----.  perch
//                   /  pillar \            rampart ring (+5), moat, floor (0)
//        W gap -- pillar  (W)  pillar -- E gap
//                   \  pillar /
//              perch  '--+--'  perch
//                        |  bridge
//                    THRESHOLD (the arena's beacon: spawn and respawn)

import { ARENA } from '../constants';
import { LevelBuilder } from './builder';
import type { LevelData, V3 } from './types';

const PI = Math.PI;

export const ANVIL = {
  /** Floor radius, the rampart's inner and outer radius, and its height. */
  FLOOR_R: 30, RAMPART_IN: 33, RAMPART_OUT: 44, RAMPART_Y: 5,
  /** Gaps in the rampart (angles), and how wide each is. */
  GAPS: [0, PI / 2, -PI / 2],
  GAP: 4.6,
  /** Conductor pillars: radius from the centre, footprint and height. */
  PILLAR_R: 17, PILLAR_W: 4, PILLAR_H: 13,
  PILLARS: [0, PI / 2, PI, -PI / 2],
  /** Perches: floating platforms above the rampart, each with a zip line back across. */
  PERCH_R: 41, PERCH_Y: 14, PERCH_W: 6,
  PERCHES: [PI / 4, (3 * PI) / 4, (-3 * PI) / 4, -PI / 4],
  /** Ramps from the floor up onto the rampart. */
  RAMPS: [PI / 4, (3 * PI) / 4, (-3 * PI) / 4, -PI / 4],
  /** The Threshold: where the team arrives and comes back after going down. */
  THRESHOLD_Z: -52,
};

/** Where the arena is in the world. */
export const at = (x: number, y: number, z: number): V3 => [ARENA.x + x, ARENA.y + y, ARENA.z + z];
/** A point at angle `phi` and radius `r` from the centre, `y` above the floor. */
export const polar = (phi: number, r: number, y = 0): V3 => at(Math.sin(phi) * r, y, Math.cos(phi) * r);

export interface ArenaData {
  level: LevelData;
  /** Collider ids of the Warden's hull and head (puppets the fight moves). */
  hull: number;
  head: number;
  /** Where explosive canisters stand (they come back there after going off). */
  canisters: V3[];
  /** Where the arena's beacon stands. */
  beacon: V3;
  /** Centres of the conductor pillars at floor level (the Warden crashes into them). */
  pillars: V3[];
}

export function buildArena(): ArenaData {
  const b = new LevelBuilder();
  const Y = ARENA.y;
  const A = ANVIL;

  // ------------------------------------------------------------ the Anvil (floor)
  b.section('Anvil');
  // a disc of four squares turned by an eighth of a turn each: a sixteen-point star
  // whose points reach 2% past the edge, drawn as a round floor by the arena view
  for (let k = 0; k < 4; k++) {
    b.box(at(0, -1, 0), [A.FLOOR_R * 2, 2, A.FLOOR_R * 2], 'invisible', { ry: (k * PI) / 8, visible: false, sight: false, tint: 1 });
  }
  // conductor pillars: tall cover, a crash for a charging Warden, a perch on top
  const pillars: V3[] = [];
  for (const phi of A.PILLARS) {
    const p = polar(phi, A.PILLAR_R);
    pillars.push(p);
    b.box([p[0], Y + A.PILLAR_H / 2, p[2]], [A.PILLAR_W, A.PILLAR_H, A.PILLAR_W], 'invisible', { ry: phi, visible: false, sight: true, tint: 1 });
  }
  // low cover walls between the pillars: out of the beam, over in a vault
  for (let k = 0; k < 4; k++) {
    const phi = PI / 4 + (k * PI) / 2;
    const p = polar(phi, 11);
    b.block(p[0], Y, p[2], 5, 1.6, 0.8, 'concreteDark', phi);
    b.deco([p[0], Y + 1.62, p[2]], [5.1, 0.08, 0.9], 'hazard', phi);
  }
  // launch pads up onto the north and south pillars
  for (const phi of [0, PI]) {
    const pad = polar(phi, 23);
    const top = polar(phi, A.PILLAR_R, A.PILLAR_H);
    b.launchPad(pad[0], Y + 0.12, pad[2], top, 2.4);
  }
  b.zone('The Anvil', ARENA.x - A.FLOOR_R, ARENA.z - A.FLOOR_R, ARENA.x + A.FLOOR_R, ARENA.z + A.FLOOR_R);
  b.waypoint('Anvil', ARENA.x, Y + 0.1, ARENA.z - 20);

  // ------------------------------------------------------------ the Rampart (terrace ring)
  b.section('Rampart');
  const RY = Y + A.RAMPART_Y;
  const rMid = (A.RAMPART_IN + A.RAMPART_OUT) / 2, depth = A.RAMPART_OUT - A.RAMPART_IN;
  // each gap is two abutments squared up to it, so it is GAP wide at every radius
  const abut = 4;
  for (const g of A.GAPS) {
    for (const s of [-1, 1]) {
      const t = s * (A.GAP / 2 + abut / 2);
      const x = Math.sin(g) * rMid + Math.cos(g) * t, z = Math.cos(g) * rMid - Math.sin(g) * t;
      // hazard stripes along the edge you jump from
      b.plat(ARENA.x + x, RY, ARENA.z + z, abut, depth, { ry: g, mat: 'metal', hazard: s < 0 ? 'e' : 'w', supports: false, th: 1.2 });
    }
    // a gantry over the gap: two posts on its outer corners and a beam the anchor hangs from
    for (const s of [-1, 1]) {
      const t = s * (A.GAP / 2 + 0.4), r = A.RAMPART_OUT - 0.4;
      b.block(ARENA.x + Math.sin(g) * r + Math.cos(g) * t, RY, ARENA.z + Math.cos(g) * r - Math.sin(g) * t, 0.5, 10.4, 0.5, 'steel', g);
    }
    const outer = A.RAMPART_OUT - 0.4;
    b.deco(polar(g, outer, A.RAMPART_Y + 10.2), [A.GAP + 1.4, 0.5, 0.5], 'hazard', g);
    b.deco(polar(g, (rMid + outer) / 2, A.RAMPART_Y + 10.2), [0.4, 0.4, outer - rMid + 0.2], 'steel', g);
    b.deco(polar(g, rMid, A.RAMPART_Y + 9.3), [0.08, 1.8, 0.08], 'steel', g);
    b.grapple(polar(g, rMid, A.RAMPART_Y + 8.5), { optional: true });
  }
  // the arcs between the gaps, in segments turned to follow the ring
  const gapHalf = 0.13;
  const sorted = [...A.GAPS].map((g) => (g + 2 * PI) % (2 * PI)).sort((p, q) => p - q);
  for (let i = 0; i < sorted.length; i++) {
    const a0 = sorted[i] + gapHalf, a1 = (i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + 2 * PI) - gapHalf;
    const n = Math.ceil((a1 - a0) / 0.2);
    const step = (a1 - a0) / n;
    for (let k = 0; k < n; k++) {
      const phi = a0 + step * (k + 0.5);
      const p = polar(phi, rMid);
      const chord = 2 * A.RAMPART_OUT * Math.tan(step / 2) + 0.35;
      // a railing on the outer edge, except where the bridge to the Threshold leaves
      const south = Math.abs(((phi % (2 * PI)) + 2 * PI) % (2 * PI) - PI) < 0.2;
      b.plat(p[0], RY, p[2], chord, depth, { ry: phi, mat: k % 3 === 1 ? 'steel' : 'metal', rim: false, supports: false, th: 1.2, rails: south || k % 2 ? '' : 'n' });
    }
  }
  // ramps down onto the floor, across the moat: the top runs half a metre in under
  // the rampart's edge, so stepping off it onto the rampart is a step, not a ledge
  for (const phi of A.RAMPS) {
    const p = polar(phi, 28.75);
    b.stairs(p[0], p[2], Y, RY, phi, 4.6, 9.5, 'metal');
  }
  // canisters on the rampart
  const canisters: V3[] = [];
  for (let k = 0; k < 4; k++) canisters.push(polar((3 * PI) / 8 + (k * PI) / 2, 24));
  for (const phi of [PI - 0.35, PI + 0.35]) canisters.push(polar(phi, 39, A.RAMPART_Y));
  b.zone('The Rampart', ARENA.x - A.RAMPART_OUT, ARENA.z - A.RAMPART_OUT, ARENA.x + A.RAMPART_OUT, ARENA.z + A.RAMPART_OUT);
  b.waypoint('Rampart', ARENA.x + rMid, RY + 0.1, ARENA.z);

  // ------------------------------------------------------------ perches and zip lines
  b.section('Perch');
  for (const phi of A.PERCHES) {
    const p = polar(phi, A.PERCH_R, A.PERCH_Y);
    b.plat(p[0], p[1], p[2], A.PERCH_W, A.PERCH_W, { ry: phi, mat: 'grate', hazard: 's', supports: false, th: 0.8, rails: 'n' });
    // a pad on the rampart just below throws you up onto it
    const pad = polar(phi - 0.17, rMid - 1.5);
    b.launchPad(pad[0], RY + 0.12, pad[2], [p[0], p[1], p[2]], 2.2);
    // the cable runs back across the arena, past the middle, down to the far side of the floor
    const from = polar(phi, A.PERCH_R - 2.4, A.PERCH_Y + 3.1);
    const to = polar(phi + PI + 0.9, 24, 2.65);
    b.zipline(from, to, { postA: p[1], postB: Y });
  }
  // the crown's anchors: swings over the middle of the floor
  for (let k = 0; k < 4; k++) b.grapple(polar(PI / 4 + (k * PI) / 2, 11, 15.5), { optional: true });
  b.waypoint('Perch', ...polar(PI / 4, A.PERCH_R, A.PERCH_Y + 0.1));
  b.waypoint('Pillar top', ...polar(0, A.PILLAR_R, A.PILLAR_H + 0.1));

  // ------------------------------------------------------------ the Threshold (spawn)
  b.section('Threshold');
  const tz = A.THRESHOLD_Z;
  b.plat(ARENA.x, RY, ARENA.z + tz, 12, 9, { mat: 'metal', hazard: 'n', supports: false, th: 1.2, rails: 'sew' });
  b.plat(ARENA.x, RY, ARENA.z + (-A.RAMPART_OUT + tz + 4.5) / 2, 5, -A.RAMPART_OUT - (tz + 4.5) + 1, { mat: 'metal', hazard: '', rails: 'ew', supports: false, th: 1 });
  // the arena's beacon is the door the team came through (drawn by the client), with its column of light
  const beacon = at(0, A.RAMPART_Y, tz - 2.6);
  for (const s of [-1, 1]) b.prop('redLight', at(s * 5.4, A.RAMPART_Y + 0.2, tz - 4));
  b.zone('The Threshold', ARENA.x - 6, ARENA.z + tz - 4.5, ARENA.x + 6, ARENA.z + tz + 4.5);
  b.waypoint('Threshold', ARENA.x, RY + 0.1, ARENA.z + tz);

  // ------------------------------------------------------------ the Warden's body (moved by the fight)
  b.section('Warden');
  const hull = b.box(at(0, 7.6, 0), [7, 3.4, 9], 'invisible', { kind: 'puppet', visible: false, sight: true, tint: 1 }).id;
  const head = b.box(at(0, 8.1, 5.6), [3.2, 2.6, 2.8], 'invisible', { kind: 'puppet', visible: false, sight: true, tint: 1 }).id;

  const sy = RY + 0.05;
  const level = b.build({
    name: 'The Anvil',
    spawns: [[ARENA.x - 2.6, sy, ARENA.z + tz + 3.4], [ARENA.x, sy, ARENA.z + tz + 3.9], [ARENA.x + 2.6, sy, ARENA.z + tz + 3.4]],
    spawnYaw: 0,
    // nothing to reach here: the way out is through the Warden
    finish: { min: [0, -1e4, 0], max: [0, -1e4, 0] },
    beacon,
    killY: Y - ARENA.KILL_DROP,
  });
  return { level, hull, head, canisters, beacon, pillars };
}

let cached: ArenaData | null = null;
export function getArena(): ArenaData {
  if (!cached) cached = buildArena();
  return cached;
}

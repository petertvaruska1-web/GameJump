// Headless traversal test: a simple bot drives the real character controller
// along every route (sprinting, jumping at edges/walls, waiting for movers,
// timing laser gates, jumping low beams and sweeper arms, sliding under low gaps and high beams,
// riding launch pads and zip lines, fighting conveyor belts, and grapple
// swinging, where it picks the release moment by simulating copies of the
// controller forward) to prove the level can be completed. Crumbling slabs fall
// under it as they do on the server; enemies are not simulated.
// Usage: npm run test:routes            (all routes)
//        npx tsx scripts/bot-routes.ts center   (one route)
//        SLOPPY=1.2 npx tsx scripts/bot-routes.ts   (takes off 1.2 m early at every edge)
// The pieces are exported for scripts/route-balance.ts, which drives the same bot
// at several skill levels and replays its runs through the real server.
import { pathToFileURL } from 'node:url';
import { CRUMBLE, GRAPPLE, PHYS, PLAYER, SLIDE, ZIP } from '../shared/constants';
import { laserBeam, laserHit, zipLength, type Beam } from '../shared/hazards';
import { levelChains, getLevel } from '../shared/level/map/index';
import { FOOT, GANTRY, HANGAR, L1, NJ, R1, RING, RING_SIDE, SPIRE, STATION } from '../shared/level/map/layout';
import type { V3, ZiplineDef } from '../shared/level/types';
import { clamp } from '../shared/math';
import { PlayerMotor, type MoveInput } from '../shared/physics/character';
import { CollisionWorld, moverWave, type Collider, type GroundHit } from '../shared/physics/world';

const level = getLevel();
/** Take-off distance before the edge. 0.14 = perfect; SLOPPY=0.8 models a typical human jumping early. */
const TAKEOFF = Number(process.env.SLOPPY ?? 0.14);
export type Kind = 'walk' | 'zip' | 'pad' | 'swing';
/** For swings: id = anchor, p = where to land (for chained swings: the final landing), next = following anchor or -1. */
export interface P { p: V3; id: number; mover: boolean; kind: Kind; next?: number }
export type Step = V3
  | { chain: string; from?: number; to?: number; offset?: V3 }
  | { ring: number[] }
  | { zip: string; n?: number }
  | { pad: V3 }
  /** Swing on the anchor nearest `at`, then land at `to` (or chain into the next swing). */
  | { swing: V3; to: V3 };

function anchorNear(at: V3): number {
  let best = -1, bd = 3;
  for (const g of level.grapples) { const d = Math.hypot(g.p[0] - at[0], g.p[1] - at[1], g.p[2] - at[2]); if (d < bd) { bd = d; best = g.id; } }
  if (best < 0) throw new Error(`no grapple anchor near ${at.join(',')}`);
  return best;
}

const pt = (p: V3): P => ({ p, id: -1, mover: false, kind: 'walk' });
function zipByTag(tag: string, n = 0): ZiplineDef {
  const z = level.ziplines.filter((q) => q.tag === tag)[n];
  if (!z) throw new Error(`no zip line ${tag}#${n}`);
  return z;
}
export function expand(steps: Step[]): P[] {
  const out: P[] = [];
  for (const s of steps) {
    if (Array.isArray(s)) out.push(pt(s));
    else if ('chain' in s) {
      const list = levelChains.get(s.chain);
      if (!list) throw new Error('unknown chain ' + s.chain);
      const o = s.offset ?? [0, 0, 0];
      out.push(...list.slice(s.from ?? 0, s.to ?? list.length).map((q) => ({ ...q, kind: 'walk' as Kind, p: [q.p[0] + o[0], q.p[1] + o[1], q.p[2] + o[2]] as V3 })));
    } else if ('zip' in s) {
      const z = zipByTag(s.zip, s.n);
      // take off from the floor under the cable, 1.2 m past its start
      const dx = z.b[0] - z.a[0], dz = z.b[2] - z.a[2], l = Math.hypot(dx, dz);
      out.push({ p: [z.a[0] + (dx / l) * 1.2, z.a[1] - 3.1, z.a[2] + (dz / l) * 1.2], id: z.id, mover: false, kind: 'zip' });
    } else if ('pad' in s) {
      out.push({ p: s.pad, id: -1, mover: false, kind: 'pad' });
    } else if ('swing' in s) {
      const prev = out[out.length - 1];
      const id = anchorNear(s.swing);
      if (prev && prev.kind === 'swing') prev.next = id;
      out.push({ p: s.to, id, mover: false, kind: 'swing', next: -1 });
    } else {
      const mid = (RING.R / Math.cos(Math.PI / RING.segments)) * 0.97;
      for (const k of s.ring) {
        const a = ((k + 0.5) * 2 * Math.PI) / RING.segments;
        out.push(pt([RING.x + Math.sin(a) * mid, RING.y, RING.z + Math.cos(a) * mid]));
      }
    }
  }
  return out;
}

const S: V3 = [0, 40.05, -5];
const pz = 61.9 + 15;
const SP: V3 = [SPIRE.x, SPIRE.y, SPIRE.z];
const FJ = FOOT.z1; // final junction south edge
const LEAPZ = RING.z - RING_SIDE / 2 + 4; // inside both the leap platform and the ring's west segment
const STAIR_TOP: V3 = [-8, SPIRE.y, SPIRE.z + 7.6];
const Y = 48; // launch yard
const UP_JUNCTION: Step[] = [[0, NJ.y, NJ.z - 3], [0, NJ.y, NJ.z]];
const GALLERIES: Step[] = [
  { chain: 'Laser Galleries', to: 3 },
  // sliding gates: pass both on the east side, waiting for each gap
  [-13.8, 44, 625], [-13.8, 44, 630], [-13.8, 44, 636],
  // windmill: go round the hub, jumping the beam
  [-12.4, 44, 642], [-12.4, 44, 648],
  { chain: 'Laser Galleries', from: 6 },
  [-12, Y, 690], [-3, Y, 691],
];
const ASSEMBLY: Step[] = [{ chain: 'Assembly Line' }, [12, Y, 690], [2, Y, 690]];
const ASCENT: Step[] = [
  { pad: [-3, Y, 700] }, [-6.5, 57, 709.5],
  { pad: [-9.8, 57, 711.5] }, [6.2, 66, 709.8],
  { pad: [9.8, 66, 711.5] }, [2.5, STATION.y, 726],
];
const ZIP_WEST: Step[] = [[-5, STATION.y, 731], { zip: 'Cable Station', n: 0 }, [-6, FOOT.y, 843]];
const ZIP_EAST: Step[] = [{ zip: 'Cable Station', n: 1 }, [10, 68, 786], { zip: 'Relay Mast' }, [6, FOOT.y, 843]];
const TO_FINAL: Step[] = [[0, FOOT.y, FJ - 1.5], [0, FOOT.y, FJ + 4.5]];

export const routes: Record<string, { start: V3; steps: Step[] }> = {
  center: {
    start: S,
    steps: [{ chain: 'Broken Bridge' }, [0, 36, 64], [-3.5, 36, 76], [-0.5, 36, 80.5], [0.5, 36, 88], [0, 36, 90], { chain: 'Gantry Approach', to: 2 }, { chain: 'Gantry Approach', from: 2, to: 3, offset: [2.6, 0, -4.4] }, [2.6, 36, 127.5], { chain: 'Gantry Approach', from: 3 }, [0, 38, 150], [3, 38, 170],
      [3, 38, 175], [3, 38, 185], [3, 38, 190], [3, 38, 203], [0, 38, 208], [0, 38, 226], [0, 38, 230.5], { swing: [0, 47, 239], to: [0, 39.5, 250] }, [0, 39.5, 250], [0, 39.5, 264],
      [0, 39.5, 270.5], [-0.5, 39.5, 276.5], [0.5, 39.5, 282.5], [0, 39.5, 290], [0, 39.5, 308],
      { chain: 'Cable Yards', to: 14 }, { zip: 'Cable Yards' }, { chain: 'Cable Yards', from: 14 },
      { ring: [4, 5, 6, 7] }, ...UP_JUNCTION, ...ASSEMBLY, ...ASCENT, ...ZIP_WEST, ...TO_FINAL, { chain: 'Broken Stairway' }, STAIR_TOP, SP],
  },
  left: {
    start: S,
    steps: [[8, 40, 2], [13, 40, 2], [38, 40, 2], [46, 40, 2], { chain: 'Scaffold Descent' }, [46, 34, 68], [54.5, 34, 79.5], [54.5, 35.2, 81.5],
      [52.4, 36.5, 83.8], [52, 39, 88], { chain: 'High Catwalk' }, [52, 40, 140], [52, 40, 158], [52, 40, 177], { chain: 'Pipe Yard' },
      [52, 36, 242], [48, 36, 252], [48, 36, 268], [52, 36, 279], { chain: 'Terrace Gardens', to: 2 }, { pad: [52, 39, 301.6] }, { chain: 'Terrace Gardens', from: 3 },
      { chain: 'Cooling Works' }, [RING.x + RING.R, RING.y, RING.z],
      { ring: [1, 0] }, ...UP_JUNCTION, ...ASSEMBLY, ...ASCENT, ...ZIP_EAST, ...TO_FINAL, { chain: 'Service Elevator' }, SP],
  },
  right: {
    start: S,
    steps: [[-8, 40, 4], [-14.5, 40, 4], [-27, 39, 4], [-28.5, 39.2, 8], [-28.5, 40.2, 14], [-31, 40.2, 19.5], [-33, 38, 27], [-35.5, 38, 32.5],
      [-36, 38, 44], [-37.5, 39.2, 51], [-39.5, 40.4, 55.5], [-40, 41, 60.5], [-40.5, 41.5, 66], [R1.x, R1.y, R1.z], [R1.x, R1.y, 79], { chain: 'Smokestacks', to: 6 },
      { swing: [R1.x, 52, 148.5], to: [R1.x, 45, 165.5] }, { swing: [R1.x, 53.5, 157], to: [R1.x, 45, 165.5] }, { chain: 'Smokestacks', from: 6 },
      { chain: 'Antenna Array', to: 4 }, { pad: [R1.x, 49, 222.7] }, { chain: 'Antenna Array', from: 4, to: 8 }, [-41.5, 52.6, 290.5], [-41.5, 52.6, 300.5], { chain: 'Antenna Array', from: 9 },
      { chain: 'Wrecked Skybridge', to: 2 }, { zip: 'Wrecked Skybridge' }, { chain: 'Wrecked Skybridge', from: 2 }, [-46, 53.6, LEAPZ], [-28, 44, LEAPZ],
      { ring: [6, 7] }, ...UP_JUNCTION, ...GALLERIES, ...ASCENT, ...ZIP_WEST, ...TO_FINAL, { chain: 'Broken Stairway' }, STAIR_TOP, SP],
  },
  crane: {
    start: [R1.x + 4, R1.y + 0.05, R1.z - 4],
    steps: [[-50, 41.5, 68], [-50, 47, 80.5], [-50, 47, 84], ...jib(), [-4, 38, 150], [0, 38, 160]],
  },
  longway: {
    start: [-46, 53.65, LEAPZ - 4],
    steps: [{ chain: 'Long Way Down' }, { ring: [6, 7] }],
  },
  galleries: { start: [0, NJ.y + 0.05, NJ.z], steps: [...GALLERIES, ...ASCENT, ...ZIP_EAST, ...TO_FINAL, { chain: 'Service Elevator' }, SP] },
  assembly: { start: [0, NJ.y + 0.05, NJ.z], steps: [...ASSEMBLY, ...ASCENT, ...ZIP_WEST, ...TO_FINAL, { chain: 'Broken Stairway' }, STAIR_TOP, SP] },
  plazaClimb: { start: [-10, 36.05, pz], steps: [{ chain: 'Plaza Climb' }, [R1.x + 4, R1.y, pz]] },
  railsDetour: { start: [3, 38.05, 196], steps: [[3, 38, 191], { swing: [6.5, 45, 190], to: [10, 38, 190] }, [10, 38, 190], [10, 38, 191.5], [4.5, 38, 205.5]] },
  yardDetour: { start: [-12, Y + 0.05, 694], steps: [[-21, Y, 694], { swing: [-28, 57, 694], to: [-35, 48.5, 694] }, [-35, 48.5, 694], { swing: [-28, 57, 694], to: [-20, Y, 694] }, [-20, Y, 694]] },
  pipeCrossing: { start: [10, 36.05, pz], steps: [[15, 36, pz], [L1.x - L1.w / 2, L1.y, pz], [L1.x - 6, L1.y, pz]] },
  foundryBridge: { start: [48, 40.05, GANTRY.z - 2], steps: [{ chain: 'Foundry Bridge' }, [GANTRY.x + 4, GANTRY.y, GANTRY.z - 2]] },
  hangarLink: { start: [HANGAR.x - 8, 36.05, 260.55], steps: [{ chain: 'Hangar Link' }, [1.5, 39.5, 256]] },
};

function jib(): V3[] {
  const x0 = -50, z0 = 85, x1 = GANTRY.x - 6, z1 = GANTRY.z - GANTRY.d / 2 - 2.6;
  const t0 = R1.y + 5.5, t1 = GANTRY.y + 3;
  return [0.15, 0.3, 0.45, 0.62, 0.8, 0.95].map((f) => [x0 + (x1 - x0) * f, t0 + (t1 - t0) * f, z0 + (z1 - z0) * f] as V3);
}

const gh: GroundHit = { top: 0, c: null };
const rayTmp = { dist: 0, c: null as Collider | null };

/** Independent copy of a controller (bodies and vectors copied, colliders and anchors shared). */
function cloneMotor(m: PlayerMotor): PlayerMotor {
  const c = new PlayerMotor();
  const src = m as unknown as Record<string, unknown>, dst = c as unknown as Record<string, unknown>;
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (k === 'body') {
      const b = m.body;
      dst.body = { pos: { ...b.pos }, vel: { ...b.vel }, ext: { ...b.ext }, grounded: b.grounded, ground: b.ground, radius: b.radius, height: b.height };
    } else if (k === 'grapple' || k === 'zip' || k === 'mGround') dst[k] = v;
    else if (v && typeof v === 'object') dst[k] = { ...(v as object) };
    else dst[k] = v;
  }
  return c;
}

/** How far a point is inside a collider's footprint (negative outside). */
function insideMargin(c: Collider, x: number, z: number): number {
  const dx = x - c.cx, dz = z - c.cz;
  const lx = dx * c.cos - dz * c.sin, lz = dx * c.sin + dz * c.cos;
  return Math.min(c.hx - Math.abs(lx), c.hz - Math.abs(lz));
}

function hookable(m: PlayerMotor, world: CollisionWorld, id: number): boolean {
  const g = level.grapples[id], b = m.body;
  const hx = b.pos.x, hy = b.pos.y + GRAPPLE.HAND, hz = b.pos.z;
  const dx = g.p[0] - hx, dy = g.p[1] - hy, dz = g.p[2] - hz, d = Math.hypot(dx, dy, dz);
  if (d > GRAPPLE.RANGE || d < GRAPPLE.MIN_RANGE || dy < -0.5) return false;
  world.raycast(hx, hy, hz, dx / d, dy / d, dz / d, d - 0.5, false, rayTmp);
  return !rayTmp.c;
}

function steer(m: PlayerMotor, to: V3): MoveInput {
  const dx = to[0] - m.body.pos.x, dz = to[2] - m.body.pos.z, d = Math.hypot(dx, dz) || 1;
  return { x: dx / d, z: dz / d, sprint: true, jumpHeld: false, jumpPressed: false };
}

/** Would letting go now (then hooking `next` as soon as possible, if any) end on the landing? */
function releaseWorks(m0: PlayerMotor, world: CollisionWorld, t0: number, to: V3, next: number, depth = 0): boolean {
  const m = cloneMotor(m0);
  let t = t0;
  const first = steer(m, to);
  first.grappleRelease = true;
  world.update(t); m.step(world, PHYS.STEP, first); t += PHYS.STEP;
  for (let i = 0; i < 120 * 2.5; i++) {
    const b = m.body;
    if (next >= 0 && m.canHook && !b.grounded && hookable(m, world, next)) {
      const inp = steer(m, to); inp.grapple = next;
      world.update(t); m.step(world, PHYS.STEP, inp); t += PHYS.STEP;
      if (!m.grapple) return false;
      // search this second swing's release moments
      for (let j = 0; j < 120 * 2.2; j++) {
        if (j % 3 === 0 && depth < 1 && releaseWorks(m, world, t, to, -1, depth + 1)) return true;
        world.update(t); m.step(world, PHYS.STEP, steer(m, to)); t += PHYS.STEP;
        if (!m.grapple) return false;
      }
      return false;
    }
    world.update(t); m.step(world, PHYS.STEP, steer(m, to)); t += PHYS.STEP;
    if (b.grounded) {
      // a robust landing: on the target level and well inside the platform, not on its lip
      const ok = next < 0 && Math.abs(b.pos.y - to[1]) < 0.7 && Math.hypot(b.pos.x - to[0], b.pos.z - to[2]) < 7
        && !!b.ground && insideMargin(b.ground, b.pos.x, b.pos.z) > 0.8;
      if (ok && process.env.DEBUGSWING && depth > 0) console.log(`      sim: release at t=${t0.toFixed(3)} lands ${fmt(b.pos)}`);
      return ok;
    }
    if (b.pos.y < to[1] - 14) return false;
  }
  return false;
}
const beamTmp: Beam = { ax: 0, az: 0, bx: 0, bz: 0, y: 0 };
/** Beams per gate: single beams (bars, windmills) can be jumped, stacked gates cannot. */
const groupSize = new Map<number, number>();
for (const l of level.lasers) groupSize.set(l.group, (groupSize.get(l.group) ?? 0) + 1);

/** Distance from (x, z) to a mover's footprint at match time `time`, from its own motion curve. */
function moverDistAt(c: Collider, x: number, z: number, time: number) {
  const m = c.def.move!, o = m.offset ?? [0, 0, 0];
  const w = moverWave(time, m.period, m.phase, m.pause ?? 0.15);
  const dx = x - (c.def.p[0] + o[0] * w), dz = z - (c.def.p[2] + o[2] * w);
  const lx = dx * c.cos - dz * c.sin, lz = dx * c.sin + dz * c.cos;
  return Math.hypot(Math.max(0, Math.abs(lx) - c.hx), Math.max(0, Math.abs(lz) - c.hz));
}

function rectDist(c: Collider, x: number, z: number) {
  const dx = x - c.cx, dz = z - c.cz;
  const lx = dx * c.cos - dz * c.sin, lz = dx * c.sin + dz * c.cos;
  const ex = Math.abs(lx) - c.hx, ez = Math.abs(lz) - c.hz;
  return Math.hypot(Math.max(0, ex), Math.max(0, ez));
}

/**
 * First predicted laser contact moving at (vx, vz) for `horizon` seconds: time, and whether the beam
 * is a single low one (jump it) or a single chest-high one (slide under it).
 */
function predictLaser(x: number, y: number, z: number, vx: number, vz: number, t: number, horizon: number, height = PLAYER.HEIGHT): { dt: number; low: boolean; high: boolean } | null {
  for (let d = 0; d <= horizon; d += 1 / 60) {
    const l = laserHit(level, x + vx * d, y, z + vz * d, t + d, PLAYER.RADIUS + 0.12, height - 0.05);
    if (l) {
      const single = groupSize.get(l.group) === 1, by = laserBeam(l, t + d, beamTmp).y - y;
      return { dt: d, low: single && by < 0.9, high: single && by >= 0.9 && by < PLAYER.HEIGHT };
    }
  }
  return null;
}

/** Sweeper arms, as world.ts spins them: a one-sided arm from the pivot, `len` long, turning at `spin` rad/s. */
const sweepers = level.boxes.filter((bx) => bx.kind === 'sweeper').map((bx) => ({
  px: bx.p[0], pz: bx.p[2], bottom: bx.p[1] - bx.s[1] / 2, top: bx.p[1] + bx.s[1] / 2,
  len: bx.s[0], half: bx.s[2] / 2, ry0: bx.ry ?? 0, spin: bx.move?.spin ?? 1,
}));

/**
 * First predicted contact (seconds ahead) with a sweeper arm for a runner
 * staying on the ground and moving at (vx, vz), or null. The arm is 0.9 m tall,
 * so the answer to one arriving is a jump timed to be airborne as it passes.
 */
function predictSweep(x: number, y: number, z: number, vx: number, vz: number, t: number, horizon: number): number | null {
  for (const sw of sweepers) {
    if (y > sw.top + 0.05 || y + PLAYER.HEIGHT < sw.bottom) continue;
    if (Math.hypot(x - sw.px, z - sw.pz) > sw.len + 8) continue;
    for (let d = 0; d <= horizon; d += 1 / 60) {
      const ang = sw.ry0 + sw.spin * (t + d);
      const ax = Math.cos(ang), az = -Math.sin(ang);
      const rx = x + vx * d - sw.px, rz = z + vz * d - sw.pz;
      const along = clamp(rx * ax + rz * az, 0, sw.len);
      if (Math.hypot(rx - ax * along, rz - az * along) < PLAYER.RADIUS + sw.half + 0.1) return d;
    }
  }
  return null;
}

/** Would a ride that grabs this cable in `delay` seconds pass every laser? (mirrors the motor's zip model) */
function zipSafe(zl: ZiplineDef, t: number, delay: number, px: number, pz: number): boolean {
  const len = zipLength(zl);
  const dx = (zl.b[0] - zl.a[0]) / len, dy = (zl.b[1] - zl.a[1]) / len, dz = (zl.b[2] - zl.a[2]) / len;
  const hl = Math.hypot(dx, dz);
  let s = ((px - zl.a[0]) * dx + (pz - zl.a[2]) * dz) / (hl * hl), v = ZIP.ENTRY_SPEED, tt = t + delay;
  const h = PHYS.STEP;
  while (s < len - 0.25) {
    v = clamp(v + (ZIP.GRAVITY * -dy - ZIP.DRAG * v * v) * h, ZIP.MIN_SPEED, ZIP.MAX_SPEED);
    if (len - s < 9 && v > 7.5) v = Math.max(7.5, v - 16 * h);
    s += v * h; tt += h;
    const x = zl.a[0] + dx * s, y = zl.a[1] + dy * s - ZIP.HANG, z = zl.a[2] + dz * s;
    // a quarter-second of slack either way: a human cannot time it to the frame either
    for (const e of [-0.25, 0, 0.25]) if (laserHit(level, x, y, z, tt + e, PLAYER.RADIUS + 0.15, PLAYER.HEIGHT)) return false;
  }
  return true;
}

export interface RunOpts {
  /** Take-off distance before each edge (defaults to SLOPPY / a near-perfect 0.14 m). */
  takeoff?: number;
  /**
   * Lateral wander (metres, peak): the line the runner means to follow drifts
   * either side of the true one, the way a player's line does on a narrow beam.
   * The bot still tracks its line perfectly, so this is the only lateral error.
   */
  wobble?: number;
  /**
   * Reaction lag (seconds): movers, lasers and zip-line timing are judged as
   * they were this long ago, while the body moves in real time -- a player who
   * reacts to what they saw rather than to what is happening now.
   */
  lag?: number;
  /**
   * Hesitation (seconds): before each jump the runner stops short of the edge
   * this long to line it up, then runs up and goes -- what a cautious player
   * does, and exactly what crumbling floors, belts and gusts punish.
   */
  hesitate?: number;
  /**
   * Match time the run starts at. Movers and lasers are functions of the match
   * clock, so shifting this is a player arriving at every obstacle a little
   * earlier or later -- which decides whether a mover is waiting for them.
   */
  t0?: number;
  /** Count a failure and carry on past that obstacle instead of stopping at the first one. */
  continueOnFail?: boolean;
  /** Record the run at the client's send rate, for replaying through the server. */
  record?: boolean;
  /** No console output. */
  quiet?: boolean;
}
export interface Failure { kind: string; i: number; t: number; x: number; y: number; z: number }
/** One state message's worth of a run, as the game client would send it. */
export interface Sample { t: number; p: V3; v: V3; yaw: number; anim: number; g: number }
export interface RunResult {
  ok: boolean; t: number; reached: number; total: number;
  fails: Failure[]; samples: Sample[]; waited: number;
  stats: { zips: number; pads: number; laserWaits: number; laserJumps: number; slides: number; swings: number; sweepJumps: number };
}

/** A swing held this long without a release that lands has no way out but a drop into the void. */
const SWING_GIVE_UP = 12;

export function run(name: string, start: V3, pts: P[], opts: RunOpts = {}): RunResult {
  const takeoff = opts.takeoff ?? TAKEOFF;
  const lag = opts.lag ?? 0;
  const world = new CollisionWorld(level);
  /** What the runner perceives: the moving parts of the level as they were `lag` seconds ago. */
  const seen = lag > 0 ? new CollisionWorld(level) : world;
  const m = new PlayerMotor();
  m.spawn(start[0], start[1], start[2], 0);
  const b = m.body;
  let i = 0, t = opts.t0 ?? Number(process.env.T0 ?? 0), best = Infinity, bestT = t, jumpHold = 0, waited = 0;
  const log: string[] = [];
  const stats = { zips: 0, pads: 0, laserWaits: 0, laserJumps: 0, slides: 0, swings: 0, sweepJumps: 0 };
  const fails: Failure[] = [];
  const samples: Sample[] = [];
  let swingT = 0, sampleAcc = 0;
  /** Crumbling slabs stood on, and when (mirrors Room: they fall SHAKE_TIME later, return RESPAWN_TIME after that). */
  const crumbleT = new Map<number, number>();
  /** Waypoint whose edge the runner has already stopped to line up, and how long it has stood. */
  let hesitatedAt = -1, hesT = 0;
  /**
   * Records a failure. Stops the run, or with continueOnFail puts the runner on
   * the next plain waypoint past the obstacle (as if the player got over it at
   * the next attempt) and returns false so the run carries on.
   */
  const fail = (kind: string): boolean => {
    fails.push({ kind, i, t, x: b.pos.x, y: b.pos.y, z: b.pos.z });
    log.push(`${kind} near ${fmt(b.pos)} heading to #${i} ${fmt3(pts[i].p)} (t=${t.toFixed(1)})`);
    if (!opts.continueOnFail || fails.length >= 40) return true;
    let j = i;
    while (j < pts.length && (pts[j].kind !== 'walk' || pts[j].mover)) j++;
    if (j >= pts.length) return true;
    const q = pts[j].p;
    b.pos.x = q[0]; b.pos.y = q[1] + 0.05; b.pos.z = q[2];
    b.vel.x = b.vel.y = b.vel.z = 0; b.ext.x = b.ext.z = 0;
    b.grounded = false;
    m.zip = null; m.grapple = null; m.launched = false;
    m.lastGroundY = q[1];
    i = j; best = Infinity; bestT = t; hookedThisStep = false; swingT = 0;
    return false;
  };
  let airT = 0;
  /** The current swing step's anchor has been hooked (so letting go completes the step). */
  let hookedThisStep = false;
  let waiting = false;
  while (t < 600 && i < pts.length) {
    const tgt = pts[i];
    const dx = tgt.p[0] - b.pos.x, dz = tgt.p[2] - b.pos.z;
    const dist = Math.hypot(dx, dz);
    const onId = b.grounded && b.ground ? b.ground.id : -1;
    let arrived: boolean;
    if (tgt.kind === 'zip') arrived = m.lastZip === tgt.id && !m.zip && b.grounded;
    else if (tgt.kind === 'pad') arrived = m.launched;
    else if (tgt.kind === 'swing') {
      // a swing that ended by touching down short of the landing (back where it started) is retried
      if (hookedThisStep && !m.grapple && b.grounded && Math.hypot(tgt.p[0] - b.pos.x, tgt.p[2] - b.pos.z) > 7) hookedThisStep = false;
      arrived = hookedThisStep && !m.grapple;
    }
    else arrived = tgt.mover ? onId === tgt.id : dist < 1.1 && Math.abs(tgt.p[1] - b.pos.y) < 2 && b.grounded;
    if (arrived) {
      if (tgt.kind === 'zip') stats.zips++;
      if (tgt.kind === 'pad') stats.pads++;
      if (tgt.kind === 'swing') stats.swings++;
      i++; best = Infinity; bestT = t; hookedThisStep = false; continue;
    }
    // grabbed a cable on the way (e.g. an early jump under it): skip ahead to that ride
    if (m.zip && tgt.kind !== 'zip') {
      const k = pts.findIndex((q, j) => j > i && q.kind === 'zip' && q.id === m.zip!.id);
      if (k > i) { i = k; continue; }
    }
    if (dist < best - 0.05) { best = dist; bestT = t; }
    if (m.grapple || tgt.kind === 'swing') bestT = Math.max(bestT, t - 15);
    if (t - bestT > 20 && !m.zip) { if (fail('STUCK')) break; continue; }
    let dirX = dist > 1e-3 ? dx / dist : 0, dirZ = dist > 1e-3 ? dz / dist : 0;
    // steer back onto the line between the previous waypoint and the target (counters wind and cross belts)
    const prev = i > 0 ? pts[i - 1].p : start;
    const lx = tgt.p[0] - prev[0], lz = tgt.p[2] - prev[2];
    const ll = Math.hypot(lx, lz);
    if (ll > 2 && dist > 1.5 && !m.launched) {
      const ux = lx / ll, uz = lz / ll;
      const ex = b.pos.x - prev[0], ez = b.pos.z - prev[2];
      const lat = ex * -uz + ez * ux - (opts.wobble ? opts.wobble * Math.sin((t * 2 * Math.PI) / 2.3) : 0);
      const cx = dirX + uz * lat * 1.2, cz = dirZ - ux * lat * 1.2;
      const cl = Math.hypot(cx, cz);
      dirX = cx / cl; dirZ = cz / cl;
    }
    const onMover = b.grounded && b.ground?.kind === 'mover';
    const carefully = tgt.mover || onMover || tgt.kind === 'zip' && dist < 3;
    const inp: MoveInput = { x: dirX, z: dirZ, sprint: !carefully, jumpHeld: jumpHold > 0, jumpPressed: false };
    airT = b.grounded ? 0 : airT + PHYS.STEP;
    if (m.zip) { inp.x = 0; inp.z = 0; inp.sprint = false; }
    else if (tgt.kind === 'swing' && !b.grounded) {
      // in the air on the way to / hanging from the anchor: hook it, then let go when a simulation says the release lands
      const to = tgt.p;
      Object.assign(inp, steer(m, to));
      if (m.canHook && !hookedThisStep && airT > 0.08 && hookable(m, world, tgt.id)) inp.grapple = tgt.id;
      else if (m.grapple && m.grapple.id === tgt.id && ((tgt.next ?? -1) < 0 || Math.round(t * 120) % 2 === 0) && releaseWorks(m, world, t, to, tgt.next ?? -1)) inp.grappleRelease = true;
      else if (m.grapple) {
        // no good release yet: pump the swing (push the way we are already moving)
        const hv = Math.hypot(b.vel.x, b.vel.z);
        if (hv > 0.4) { inp.x = b.vel.x / hv; inp.z = b.vel.z / hv; }
      }
    }
    else if (b.grounded && !m.mantleActive) {
      const beltX = b.ground?.def.belt ? m.platVel.x : 0, beltZ = b.ground?.def.belt ? m.platVel.z : 0;
      world.groundProbe(b.pos.x + dirX * takeoff, b.pos.z + dirZ * takeoff, 0.05, b.pos.y + 0.5, gh);
      const edge = !gh.c || gh.top < b.pos.y - 1.3;
      // before a timed jump (onto / off a mover) hold 1.5m back from the edge for a run-up
      world.groundProbe(b.pos.x + dirX * 1.5, b.pos.z + dirZ * 1.5, 0.05, b.pos.y + 0.5, gh);
      const nearEdge = !gh.c || gh.top < b.pos.y - 1.3;
      let wall = false;
      if (!edge) {
        world.groundProbe(b.pos.x + dirX * 0.55, b.pos.z + dirZ * 0.55, 0.1, b.pos.y + 2.7, gh);
        wall = !!gh.c && gh.top > b.pos.y + 0.5 && gh.c.bottom < b.pos.y + 0.6 && !gh.c.isDynamic;
      }
      let wait = false, jump = false;
      // a cautious runner stops short of a plain jump to line it up (movers keep their own timing).
      // It starts braking 3 m out -- from a sprint it takes over a metre to stop -- and holds
      // there until the pause is over, then runs up and jumps.
      if (opts.hesitate && hesitatedAt !== i && dist > 2 && tgt.kind === 'walk' && !tgt.mover && !onMover) {
        world.groundProbe(b.pos.x + dirX * 3, b.pos.z + dirZ * 3, 0.05, b.pos.y + 0.5, gh);
        if (hesT > 0 || !gh.c || gh.top < b.pos.y - 1.3) {
          hesT += PHYS.STEP; wait = true;
          if (hesT >= opts.hesitate) { hesitatedAt = i; hesT = 0; }
        }
      }
      if (nearEdge && dist > 0.8 && tgt.id >= 0 && (tgt.mover || onMover)) {
        const c = seen.get(tgt.id)!;
        const d = rectDist(c, b.pos.x, b.pos.z);
        const dy = c.top - b.pos.y;
        // board only a mover that is resting or coming this way: one leaving opens the gap mid-jump
        const coming = !tgt.mover || !c.def.move || moverDistAt(c, b.pos.x, b.pos.z, t - lag + 0.5) <= d + 0.3;
        const go = d < 4.8 && dy < 1.1 && dy > -3 && coming;
        if (!go) wait = true; else inp.sprint = true;
      }
      // lasers: wait for tall gates, jump low beams just before they arrive
      const sp = m.sliding ? m.slideSpeed : inp.sprint ? PLAYER.SPRINT_SPEED : PLAYER.RUN_SPEED;
      const ahead = predictLaser(b.pos.x, b.pos.y, b.pos.z, dirX * sp + beltX, dirZ * sp + beltZ, t - lag, 0.7, b.height);
      const here = predictLaser(b.pos.x, b.pos.y, b.pos.z, beltX, beltZ, t - lag, 0.5, b.height);
      // slide under chest-high beams and into low gaps (a stalker-proof tunnel, a jammed shutter)
      const hs = Math.hypot(b.vel.x, b.vel.z);
      const lowCeiling = world.ceilingProbe(b.pos.x + dirX * 1.3, b.pos.z + dirZ * 1.3, 0.3, b.pos.y + SLIDE.HEIGHT) < b.pos.y + PLAYER.HEIGHT;
      let retreat = false;
      if (!m.sliding && (lowCeiling || (ahead?.high && ahead.dt < 0.3))) {
        if (hs >= SLIDE.MIN_START) { inp.slidePressed = true; }
        else if (ahead?.high) retreat = true; // too slow to slide under it in time: back off and run up again
      }
      if (ahead && !ahead.low && !ahead.high) wait = true;
      if (ahead?.low && ahead.dt < 0.2) jump = true;
      // a sweeper arm coming round: be in the air as it passes (a jump clears it 0.2-0.5 s after take-off)
      const sweep = sweepers.length ? predictSweep(b.pos.x, b.pos.y, b.pos.z, dirX * sp + beltX, dirZ * sp + beltZ, t - lag, 0.5) : null;
      if (sweep !== null && sweep > 0.22 && sweep < 0.34) { jump = true; stats.sweepJumps++; }
      // about to leap a gap (off a mover, onto a sweeper deck): not into an arm that will meet the
      // landing -- a player waits for it to go by, riding the mover round for another pass if need be
      else if (edge && sweepers.length && !m.sliding) {
        const soon = predictSweep(b.pos.x, b.pos.y, b.pos.z, dirX * sp, dirZ * sp, t - lag, 1.0);
        if (soon !== null && soon >= 0.34) wait = true;
      }
      if (here?.high && !m.sliding && !inp.slidePressed && here.dt < 0.4) {
        // a chest-high beam is coming at us: slide if fast enough, else run whichever way stays clear
        if (hs >= SLIDE.MIN_START) { inp.slidePressed = true; }
        else {
          const fw = predictLaser(b.pos.x, b.pos.y, b.pos.z, dirX * PLAYER.SPRINT_SPEED, dirZ * PLAYER.SPRINT_SPEED, t - lag, 0.6, b.height);
          const bw = predictLaser(b.pos.x, b.pos.y, b.pos.z, -dirX * PLAYER.SPRINT_SPEED, -dirZ * PLAYER.SPRINT_SPEED, t - lag, 0.6, b.height);
          if (!fw || (bw && bw.dt < fw.dt)) { wait = false; inp.sprint = true; } else retreat = true;
        }
      }
      if (wait && here) {
        if (here.low) { if (here.dt < 0.2) jump = true; }
        else if (!here.high) retreat = true;
      }
      if (retreat) { inp.x = -dirX; inp.z = -dirZ; inp.sprint = true; wait = false; }
      if (wait !== waiting && wait && ahead) stats.laserWaits++;
      waiting = wait;
      // zip line: jump into the cable once standing under it (and only if the ride clears every laser)
      if (tgt.kind === 'zip' && dist < 0.7) {
        const zl = level.ziplines[tgt.id];
        if (zipSafe(zl, t - lag, 0.02, b.pos.x, b.pos.z)) jump = true; else wait = true;
      }
      if (wait && !jump && !retreat) {
        // stand still; on a belt walk against it just enough to stay put
        const bs = Math.hypot(beltX, beltZ);
        if (bs > 0.1) { const k = Math.min(1, bs / PLAYER.RUN_SPEED); inp.x = (-beltX / bs) * k; inp.z = (-beltZ / bs) * k; }
        else { inp.x = 0; inp.z = 0; }
        inp.sprint = false;
        waited += PHYS.STEP;
        bestT = t;
      }
      if (jump) { if (ahead?.low || here?.low) stats.laserJumps++; inp.jumpPressed = true; inp.jumpHeld = true; jumpHold = 0.5; }
      else if (!wait && !m.sliding && ((edge && dist > takeoff + 0.66) || wall)) { inp.jumpPressed = true; inp.jumpHeld = true; jumpHold = 0.5; }
      else if (m.sliding && edge && dist > takeoff + 0.66) { inp.jumpPressed = true; inp.jumpHeld = true; jumpHold = 0.5; }
    }
    jumpHold -= PHYS.STEP;
    if (seen !== world) seen.update(t - lag);
    world.update(t);
    m.step(world, PHYS.STEP, inp);
    t += PHYS.STEP;
    if (m.events.slid) stats.slides++;
    if (b.grounded && b.ground?.kind === 'crumble' && !crumbleT.has(b.ground.id)) crumbleT.set(b.ground.id, t);
    for (const [id, st] of crumbleT) {
      const c = world.get(id)!;
      if (c.enabled && t >= st + CRUMBLE.SHAKE_TIME) c.enabled = false;
      else if (!c.enabled && t >= st + CRUMBLE.SHAKE_TIME + CRUMBLE.RESPAWN_TIME) { c.enabled = true; crumbleT.delete(id); }
    }
    if (tgt.kind === 'swing' && m.events.hooked === tgt.id) hookedThisStep = true;
    if (process.env.DEBUGSWING && (m.events.hooked >= 0 || m.events.unhooked)) console.log(`   t=${t.toFixed(2)} ${m.events.hooked >= 0 ? 'hook ' + m.events.hooked : 'release ' + m.lastGrapple} at ${fmt(b.pos)} v=${fmt(b.vel)} rope=${m.ropeLen.toFixed(1)}`);
    if (process.env.TRACE && i >= Number(process.env.TRACE) && Math.round(t * 120) % 3 === 0) console.log('   ', t.toFixed(2), fmt(b.pos), b.grounded ? 'G' + (b.ground?.id ?? '') : m.zip ? 'zip' : 'air', 'in', inp.x.toFixed(2), inp.z.toFixed(2), inp.jumpPressed ? 'JUMP' : '', waiting ? 'WAIT' : '');
    if (opts.record && (sampleAcc += PHYS.STEP) >= 1 / 30 - 1e-6) {
      sampleAcc = 0;
      samples.push({ t, p: [b.pos.x, b.pos.y, b.pos.z], v: [b.vel.x + b.ext.x, b.vel.y, b.vel.z + b.ext.z], yaw: m.yaw, anim: m.anim, g: b.grounded && b.ground ? b.ground.id : -1 });
    }
    swingT = m.grapple ? swingT + PHYS.STEP : 0;
    if (laserHit(level, b.pos.x, b.pos.y, b.pos.z, t, PLAYER.RADIUS, b.height - 0.1)) { if (fail('LASER')) break; continue; }
    if (!m.zip && !m.grapple && (b.pos.y < m.lastGroundY - 10 || b.pos.y < level.killY)) { if (fail('FELL')) break; continue; }
    // no release lands: a player would have to let go over the void (before, this pumped for the whole 600 s budget)
    if (swingT > SWING_GIVE_UP) { if (fail('SWING')) break; continue; }
  }
  const ok = i >= pts.length && fails.length === 0;
  if (!opts.quiet) {
    const extra = `zips ${stats.zips} pads ${stats.pads} swings ${stats.swings} slides ${stats.slides} laser waits ${stats.laserWaits} jumps ${stats.laserJumps} (waited ${waited.toFixed(1)}s)`;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name.padEnd(14)} ${i}/${pts.length} waypoints  t=${t.toFixed(1)}s  ${extra}  end=${fmt(b.pos)}`);
    for (const l of log) console.log('     ' + l);
  }
  return { ok, t, reached: i, total: pts.length, fails, samples, waited, stats };
}

const fmt = (v: { x: number; y: number; z: number }) => `(${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})`;
const fmt3 = (p: V3) => `(${p[0].toFixed(1)}, ${p[1].toFixed(1)}, ${p[2].toFixed(1)})`;

// run as a script (npm run test:routes), not when imported by another tool
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const only = process.argv[2];
  let failed = 0;
  for (const [name, r] of Object.entries(routes)) {
    if (only && only !== name) continue;
    if (!run(name, r.start, expand(r.steps)).ok) failed++;
  }
  process.exit(failed ? 1 : 0);
}

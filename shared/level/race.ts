// Speedster Battle's course: a road of light through a gap in spacetime, about
// five kilometres of long curves, gentle climbs and descents and two kickers,
// walled on both sides so nobody can fall (only slow down).
//
// It is laid out as a centreline from pieces (straights and arcs, each with a
// change of height), sampled every STEP metres: position, heading, height (the
// piecewise-linear profile smoothed into gentle crests and dips), width and
// section. The collision world gets invisible ramp boxes along it (overlapping,
// so there is floor under every lane), invisible barrier walls on both sides,
// and a back wall at each end. A kicker is a short steep ramp whose lip drops
// away into a trough: at speed you fly over it (the motor keeps a ramp's lift
// in the race), slowly you roll down through it and back up.
//
// The client draws the course from the same samples (src/render/RaceView.ts);
// the server and the client find a runner's place along it with trackIndex.

import { LevelBuilder } from './builder';
import type { LevelData, V3 } from './types';

/** Where the course starts, far from the course and the arena and high above the height fog. */
export const RACE_ORIGIN = { x: 0, y: 600, z: 3000 };

export interface TrackSample {
  /** Distance along the course. */
  s: number;
  x: number; y: number; z: number;
  /** Heading (forward = (sin h, cos h)). */
  h: number;
  /** Width between the barriers. */
  w: number;
  /** Index into the sections. */
  sec: number;
  /** At a kicker's lip only: the floor height just past it (the trough starts there). */
  drop?: number;
}

export interface Kicker {
  /** Where the ramp starts, its lip, and where the trough is back up to the road. */
  s0: number; lip: number; s1: number;
  /** How high the lip stands over the road, and how deep the trough dips under it. */
  h: number; d: number;
}

export interface RaceTrack {
  step: number;
  samples: TrackSample[];
  length: number;
  sections: { name: string; s0: number; s1: number }[];
  /** Checkpoint rings (distance along the course). */
  rings: number[];
  kickers: Kicker[];
  /** The finish line; after it a run-out to stop in. */
  finishS: number;
}

export interface RaceData {
  level: LevelData;
  track: RaceTrack;
  /** The start grid: one slot per runner, side by side. */
  grid: V3[];
  yaw: number;
}

const STEP = 2;
/** Floor and barrier pieces span this many samples. */
const PIECE = 2;
const WALL_T = 3, WALL_UP = 22, WALL_DOWN = 8;
const KICK = { LEN: 12, H: 2.5, TROUGH: 52, D: 5 };
const RUN_OUT = 220;
const RING_GAP = 400;

interface Piece { len?: number; r?: number; ang?: number; dy: number; kicker?: number }
interface Section { name: string; w: number; pieces: Piece[] }

/** The course, start to end. Positive angles turn toward +X. */
const COURSE: Section[] = [
  { name: 'The Tear', w: 22, pieces: [{ len: 420, dy: 0 }, { len: 60, dy: -4 }] },
  { name: 'Aurora Bend', w: 18, pieces: [{ r: 230, ang: 1.9, dy: -32 }, { len: 120, dy: -8 }, { r: 210, ang: -0.62, dy: -4 }] },
  { name: 'Crystal Narrows', w: 16, pieces: [{ r: 150, ang: -0.95, dy: 8 }, { r: 150, ang: 1.25, dy: 12 }, { r: 165, ang: -1.05, dy: 8 }, { len: 90, dy: 4 }, { r: 180, ang: 0.6, dy: 0 }] },
  { name: 'First Leap', w: 18, pieces: [{ len: 320, dy: -14, kicker: 110 }] },
  { name: 'The Long Fall', w: 22, pieces: [{ len: 760, dy: -62 }] },
  { name: 'Nebula Spiral', w: 18, pieces: [{ r: 185, ang: 4.71, dy: -48 }, { len: 140, dy: 0 }] },
  { name: 'Second Leap', w: 18, pieces: [{ len: 330, dy: -12, kicker: 120 }] },
  { name: 'Event Horizon', w: 22, pieces: [{ r: 260, ang: -0.55, dy: 0 }, { len: 560, dy: 0 }] },
];

/** Moving average of `v` over `half` samples either side (ends held). */
function smooth(v: number[], half: number): number[] {
  const out = new Array<number>(v.length);
  const n = v.length;
  const pre = new Array<number>(n + 1);
  pre[0] = 0;
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + v[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half), b = Math.min(n - 1, i + half);
    out[i] = (pre[b + 1] - pre[a]) / (b - a + 1);
  }
  return out;
}

export function buildRace(): RaceData {
  // ------------------------------------------------------------ the centreline
  const sub = 0.25;
  let x = RACE_ORIGIN.x, z = RACE_ORIGIN.z, h = 0, s = 0, y = 0;
  const xs: number[] = [], zs: number[] = [], hs: number[] = [], ys: number[] = [], ws: number[] = [], secs: number[] = [];
  const sections: RaceTrack['sections'] = [];
  const kickStarts: number[] = [];
  let next = 0;
  const record = (sec: number, w: number) => {
    while (next <= s + 1e-9) { xs.push(x); zs.push(z); hs.push(h); ys.push(y); ws.push(w); secs.push(sec); next += STEP; }
  };
  COURSE.forEach((sec, si) => {
    const s0 = s;
    for (const p of sec.pieces) {
      const len = p.len ?? (p.r ?? 0) * Math.abs(p.ang ?? 0);
      const turn = p.ang ? p.ang / len : 0;
      if (p.kicker !== undefined) kickStarts.push(s + p.kicker);
      for (let d = 0; d < len - 1e-9; d += sub) {
        const k = Math.min(sub, len - d);
        record(si, sec.w);
        h += turn * k / 2;
        x += Math.sin(h) * k; z += Math.cos(h) * k;
        h += turn * k / 2;
        y += (p.dy / len) * k;
        s += k;
      }
    }
    sections.push({ name: sec.name, s0, s1: s });
  });
  record(COURSE.length - 1, COURSE[COURSE.length - 1].w);
  const length = (xs.length - 1) * STEP;
  sections[sections.length - 1].s1 = length;
  // gentle crests and dips: the height profile smoothed over ~60 m, widths blended over ~40 m
  const sy = smooth(ys, 15), sw = smooth(ws, 10);
  const samples: TrackSample[] = xs.map((_, i) => ({
    s: i * STEP, x: xs[i], y: RACE_ORIGIN.y + sy[i], z: zs[i], h: hs[i], w: sw[i], sec: secs[i],
  }));

  // ------------------------------------------------------------ kickers
  const kickers: Kicker[] = [];
  for (const k0 of kickStarts) {
    // the lip on a piece boundary, so no floor piece spans the step down
    const lipIdx = Math.round((k0 + KICK.LEN) / (STEP * PIECE)) * PIECE;
    const lip = lipIdx * STEP, s0 = lip - KICK.LEN, s1 = lip + KICK.TROUGH;
    for (const q of samples) {
      if (q.s >= s0 && q.s <= lip) q.y += (KICK.H * (q.s - s0)) / KICK.LEN;
      else if (q.s > lip && q.s < s1) q.y -= KICK.D * Math.sin((Math.PI * (q.s - lip)) / KICK.TROUGH);
    }
    samples[lipIdx].drop = samples[lipIdx].y - KICK.H;
    kickers.push({ s0, lip, s1, h: KICK.H, d: KICK.D });
  }

  const finishS = Math.round((length - RUN_OUT) / STEP) * STEP;
  const rings: number[] = [];
  for (let r = RING_GAP; r < finishS - 150; r += RING_GAP) {
    if (kickers.some((k) => r > k.s0 - 70 && r < k.s1 + 50)) { rings.push(r + 130); continue; }
    rings.push(r);
  }
  const track: RaceTrack = { step: STEP, samples, length, sections, rings, kickers, finishS };

  // ------------------------------------------------------------ collision
  const b = new LevelBuilder();
  b.section('Race');
  const hidden = { visible: false, sight: false, tint: 1 } as const;
  for (let i = 0; i + PIECE < samples.length; i += PIECE) {
    const a = samples[i], c = samples[i + PIECE];
    const ya = a.drop ?? a.y, yc = c.y;
    const dx = c.x - a.x, dz = c.z - a.z, chord = Math.hypot(dx, dz);
    const ry = Math.atan2(dx, dz), slope = (yc - ya) / chord;
    const mx = (a.x + c.x) / 2, mz = (a.z + c.z) / 2;
    const w = Math.max(a.w, c.w);
    // the floor, a little longer than the piece so neighbours overlap round a curve
    const ext = 0.45;
    b.rampBox(mx, mz, ya - slope * ext, yc + slope * ext, ry, w + 2, chord + ext * 2, 'invisible', 2.5, hidden);
    // the barriers, deep and tall: nothing gets over or under them
    const lo = Math.min(ya, yc, a.y) - WALL_DOWN, hi = Math.max(ya, yc, a.y) + WALL_UP;
    const rx = Math.cos(ry), rz = -Math.sin(ry);
    for (const side of [-1, 1]) {
      const off = w / 2 + WALL_T / 2;
      b.box([mx + rx * off * side, (lo + hi) / 2, mz + rz * off * side], [WALL_T, hi - lo, chord + 1.2], 'invisible', { ry, ...hidden });
    }
  }
  // a wall behind the grid and one at the end of the run-out
  for (const [q, back] of [[samples[0], -1], [samples[samples.length - 1], 1]] as const) {
    b.box([q.x + Math.sin(q.h) * back * WALL_T / 2, q.y + (WALL_UP - WALL_DOWN) / 2, q.z + Math.cos(q.h) * back * WALL_T / 2], [q.w + WALL_T * 2 + 2, WALL_UP + WALL_DOWN, WALL_T], 'invisible', { ry: q.h, ...hidden });
  }

  // the grid: three slots abreast, a little way down the straight
  const g = samples[18];
  const grx = Math.cos(g.h), grz = -Math.sin(g.h);
  const grid: V3[] = [-5, 0, 5].map((o) => [g.x + grx * o, g.y + 0.05, g.z + grz * o]);
  const minY = samples.reduce((m, q) => Math.min(m, q.y), Infinity);
  const fin = samples[finishS / STEP];
  const level = b.build({
    name: 'Speedster Battle',
    spawns: grid,
    spawnYaw: g.h,
    // the finish is judged along the course (shared/sim/race.ts), not by a box
    finish: { min: [0, -1e4, 0], max: [0, -1e4, 0] },
    beacon: [fin.x, fin.y, fin.z],
    killY: minY - 60,
  });
  return { level, track, grid, yaw: g.h };
}

let cached: RaceData | null = null;
export function getRace(): RaceData {
  if (!cached) cached = buildRace();
  return cached;
}

/**
 * The sample nearest (x, y, z): searched round `hint` (the last one found, -1 for
 * none) and over the whole course when that finds nothing close. Height counts, so
 * where the course passes over itself the right stretch is found.
 */
export function trackIndex(t: RaceTrack, x: number, y: number, z: number, hint: number): number {
  const S = t.samples;
  const near = (lo: number, hi: number): [number, number] => {
    let best = -1, bd = Infinity;
    for (let i = lo; i <= hi; i++) {
      const q = S[i];
      const dy = y - q.y;
      const d = (x - q.x) * (x - q.x) + (z - q.z) * (z - q.z) + (dy < -12 || dy > 40 ? 1e7 : 0);
      if (d < bd) { bd = d; best = i; }
    }
    return [best, bd];
  };
  if (hint >= 0) {
    const [i, d] = near(Math.max(0, hint - 40), Math.min(S.length - 1, hint + 80));
    if (d < 30 * 30) return i;
  }
  return near(0, S.length - 1)[0];
}

/** Distance along the course of (x, z), given its nearest sample. */
export function trackS(t: RaceTrack, i: number, x: number, z: number): number {
  const q = t.samples[i];
  const along = (x - q.x) * Math.sin(q.h) + (z - q.z) * Math.cos(q.h);
  return Math.min(t.length, Math.max(0, q.s + Math.max(-t.step, Math.min(t.step, along))));
}

/** The centreline at distance `s` (interpolated). */
export function trackPoint(t: RaceTrack, s: number, out: { x: number; y: number; z: number; h: number; w: number }) {
  const S = t.samples;
  const f = Math.min(S.length - 1.000001, Math.max(0, s / t.step));
  const i = Math.floor(f), u = f - i;
  const a = S[i], b = S[Math.min(S.length - 1, i + 1)];
  out.x = a.x + (b.x - a.x) * u; out.y = a.y + (b.y - a.y) * u; out.z = a.z + (b.z - a.z) * u;
  let dh = b.h - a.h; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
  out.h = a.h + dh * u; out.w = a.w + (b.w - a.w) * u;
  return out;
}

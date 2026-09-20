// Deterministic environmental hazards evaluated identically everywhere.

import { LASER, ZIP } from './constants';
import type { LaserDef, LevelData, WindDef, ZiplineDef } from './level/types';
import { moverWave } from './physics/world';

/**
 * Name of the smallest named area containing a point, or null out in the open.
 * Zones nest (a building sits inside the band around it), so the tightest match
 * is the one the player would call the place they are standing in.
 */
export function zoneAt(level: LevelData, x: number, z: number): string | null {
  let best: string | null = null;
  let bestArea = Infinity;
  for (const zn of level.zones) {
    if (x < zn.min[0] || x > zn.max[0] || z < zn.min[1] || z > zn.max[1]) continue;
    const area = (zn.max[0] - zn.min[0]) * (zn.max[1] - zn.min[1]);
    if (area < bestArea) { bestArea = area; best = zn.name; }
  }
  return best;
}

/** Gust strength factor 0..1 for a wind zone at time t (smooth ramp in/out). */
export function gustFactor(w: WindDef, t: number): number {
  let u = (t / w.period + w.phase) % 1;
  if (u < 0) u += 1;
  if (u > w.duty) return 0;
  const k = u / w.duty;
  // ease in over the first 20%, out over the last 20%
  const a = Math.min(1, k / 0.2), b = Math.min(1, (1 - k) / 0.2);
  return Math.min(a, b);
}

/** Seconds until the next gust starts (0 when blowing). */
export function gustLead(w: WindDef, t: number): number {
  let u = (t / w.period + w.phase) % 1;
  if (u < 0) u += 1;
  if (u <= w.duty) return 0;
  return (1 - u) * w.period;
}

export function inWind(w: WindDef, x: number, y: number, z: number): boolean {
  return x >= w.min[0] && x <= w.max[0] && y >= w.min[1] && y <= w.max[1] && z >= w.min[2] && z <= w.max[2];
}

/** Wind acceleration at a position. Writes into out[0], out[1] (x, z). */
export function windAt(level: LevelData, x: number, y: number, z: number, t: number, out: [number, number]) {
  out[0] = 0; out[1] = 0;
  for (const w of level.winds) {
    if (!inWind(w, x, y, z)) continue;
    const f = gustFactor(w, t) * w.strength;
    out[0] += w.dir[0] * f;
    out[1] += w.dir[1] * f;
  }
  return out;
}

// ------------------------------------------------------------------ lasers

export interface Beam { ax: number; az: number; bx: number; bz: number; y: number }

/** 1 while the beam is on, 0 while off. */
export function laserOn(l: LaserDef, t: number): boolean {
  if (!l.cycle) return true;
  let u = (t / l.cycle + (l.cyclePhase ?? 0)) % 1;
  if (u < 0) u += 1;
  return u < (l.duty ?? 0.5);
}

/** Seconds until the beam switches on (0 while on). */
export function laserLead(l: LaserDef, t: number): number {
  if (!l.cycle) return 0;
  let u = (t / l.cycle + (l.cyclePhase ?? 0)) % 1;
  if (u < 0) u += 1;
  const duty = l.duty ?? 0.5;
  return u < duty ? 0 : (1 - u) * l.cycle;
}

/** Beam endpoints at time t (after travel and spin). */
export function laserBeam(l: LaserDef, t: number, out: Beam): Beam {
  let ox = 0, oy = 0, oz = 0;
  if (l.move) {
    const w = moverWave(t, l.period ?? 4, l.phase ?? 0, l.pause ?? 0.1);
    ox = l.move[0] * w; oy = l.move[1] * w; oz = l.move[2] * w;
  }
  let ax = l.a[0], az = l.a[2], bx = l.b[0], bz = l.b[2];
  if (l.spin) {
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    const ang = l.spin * t, c = Math.cos(ang), s = Math.sin(ang);
    const hx = (bx - ax) / 2, hz = (bz - az) / 2;
    // yaw convention: rotating +X toward -Z
    const rx = hx * c + hz * s, rz = -hx * s + hz * c;
    ax = mx - rx; az = mz - rz; bx = mx + rx; bz = mz + rz;
  }
  out.ax = ax + ox; out.az = az + oz; out.bx = bx + ox; out.bz = bz + oz; out.y = l.a[1] + oy;
  return out;
}

const beamTmp: Beam = { ax: 0, az: 0, bx: 0, bz: 0, y: 0 };

/** Squared XZ distance from a point to a segment. */
function segDist2(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let u = l2 > 1e-9 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  const ex = px - (ax + dx * u), ez = pz - (az + dz * u);
  return ex * ex + ez * ez;
}

/** The first active laser touching a standing body (feet at y), or null. */
export function laserHit(level: LevelData, x: number, y: number, z: number, t: number, radius: number, height: number): LaserDef | null {
  const r = radius + LASER.RADIUS;
  for (const l of level.lasers) {
    // cheap reject: the beam's reach from its rest midpoint
    const mx = (l.a[0] + l.b[0]) / 2, mz = (l.a[2] + l.b[2]) / 2;
    const reach = Math.hypot(l.b[0] - l.a[0], l.b[2] - l.a[2]) / 2 + (l.move ? Math.hypot(l.move[0], l.move[2]) : 0) + r + 0.5;
    if (Math.abs(x - mx) > reach || Math.abs(z - mz) > reach) continue;
    if (!laserOn(l, t)) continue;
    const bm = laserBeam(l, t, beamTmp);
    if (bm.y < y + 0.03 || bm.y > y + height + 0.05) continue;
    if (segDist2(x, z, bm.ax, bm.az, bm.bx, bm.bz) < r * r) return l;
  }
  return null;
}

// ------------------------------------------------------------------ zip lines

export function zipLength(zl: ZiplineDef): number {
  return Math.hypot(zl.b[0] - zl.a[0], zl.b[1] - zl.a[1], zl.b[2] - zl.a[2]);
}

/**
 * Where a body (feet at x,y,z) would hang on this cable: returns the distance
 * along the cable, or -1 when the hands are outside the grab window.
 */
export function zipGrab(zl: ZiplineDef, x: number, y: number, z: number): number {
  const dx = zl.b[0] - zl.a[0], dy = zl.b[1] - zl.a[1], dz = zl.b[2] - zl.a[2];
  const lh2 = dx * dx + dz * dz;
  if (lh2 < 1e-6) return -1;
  const u = ((x - zl.a[0]) * dx + (z - zl.a[2]) * dz) / lh2;
  const len = Math.sqrt(lh2 + dy * dy);
  const s = u * len;
  if (s < 0.3 || s > len - 3) return -1;
  const cx = zl.a[0] + dx * u, cz = zl.a[2] + dz * u, cy = zl.a[1] + dy * u;
  if (Math.hypot(x - cx, z - cz) > ZIP.GRAB_RADIUS) return -1;
  const rel = cy - (y + ZIP.HANG);
  if (rel < -ZIP.GRAB_BELOW || rel > ZIP.GRAB_ABOVE) return -1;
  return s;
}

/** True when a body (feet at x,y,z) is hanging on any cable (server fall checks). */
export function onAnyZipline(level: LevelData, x: number, y: number, z: number): boolean {
  for (const zl of level.ziplines) {
    const dx = zl.b[0] - zl.a[0], dy = zl.b[1] - zl.a[1], dz = zl.b[2] - zl.a[2];
    const l2 = dx * dx + dy * dy + dz * dz;
    const hy = y + ZIP.HANG;
    let u = ((x - zl.a[0]) * dx + (hy - zl.a[1]) * dy + (z - zl.a[2]) * dz) / l2;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    if (Math.hypot(x - (zl.a[0] + dx * u), hy - (zl.a[1] + dy * u), z - (zl.a[2] + dz * u)) < 1.2) return true;
  }
  return false;
}

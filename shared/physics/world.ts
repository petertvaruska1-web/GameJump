// Lightweight collision world: yaw-rotated boxes (+ ramps), a uniform XZ grid
// for broad-phase, raycasts for line-of-sight/camera, and kinematic movers.
// Shared by the client (prediction, camera) and the server (AI, validation).

import type { BoxDef, BoxKind, GrappleDef, LevelData, ZiplineDef } from '../level/types';
import { clamp, type Vec3 } from '../math';

export interface PushResult { nx: number; nz: number; pen: number }
export interface GroundHit { top: number; c: Collider | null }
export interface RayHit { dist: number; c: Collider | null }

export class Collider {
  readonly id: number;
  readonly def: BoxDef;
  readonly kind: BoxKind;
  readonly hx: number;
  readonly hy: number;
  readonly hz: number;
  readonly rise: number;
  readonly solid: boolean;
  readonly blocksSight: boolean;
  enabled = true;
  /** Crumble: time (world clock) at which shaking started, or -1. */
  shakeStart = -1;

  cx = 0; cy = 0; cz = 0; ry = 0; cos = 1; sin = 0;
  pcx = 0; pcy = 0; pcz = 0; pry = 0;
  minX = 0; maxX = 0; minZ = 0; maxZ = 0; minY = 0; maxY = 0;
  stamp = 0;

  constructor(def: BoxDef) {
    this.id = def.id;
    this.def = def;
    this.kind = def.kind;
    this.hx = def.s[0] / 2;
    this.hy = def.s[1] / 2;
    this.hz = def.s[2] / 2;
    this.rise = def.rise ?? 0;
    this.solid = def.solid;
    this.blocksSight = def.blocksSight;
    this.setTransform(def.p[0], def.p[1], def.p[2], def.ry);
    this.pcx = this.cx; this.pcy = this.cy; this.pcz = this.cz; this.pry = this.ry;
  }

  get isDynamic() { return this.kind === 'mover' || this.kind === 'sweeper'; }
  get bottom() { return this.cy - this.hy; }
  /** Highest point of the collider (ramps rise along +Z). */
  get top() { return this.cy + this.hy + Math.max(0, this.rise); }

  setTransform(x: number, y: number, z: number, ry: number) {
    this.cx = x; this.cy = y; this.cz = z; this.ry = ry;
    this.cos = Math.cos(ry); this.sin = Math.sin(ry);
    const ex = Math.abs(this.hx * this.cos) + Math.abs(this.hz * this.sin);
    const ez = Math.abs(this.hx * this.sin) + Math.abs(this.hz * this.cos);
    this.minX = x - ex; this.maxX = x + ex;
    this.minZ = z - ez; this.maxZ = z + ez;
    this.minY = y - this.hy; this.maxY = this.top;
  }

  /** Surface height at a world XZ point (clamped into the footprint). */
  topAt(x: number, z: number): number {
    const base = this.cy + this.hy;
    if (this.rise === 0) return base;
    const dx = x - this.cx, dz = z - this.cz;
    const lz = clamp(dx * this.sin + dz * this.cos, -this.hz, this.hz);
    return base + (this.rise * (lz + this.hz)) / (2 * this.hz);
  }

  /** 2D circle vs rotated rectangle. Fills `out` with push-out normal/penetration. */
  circlePush(x: number, z: number, r: number, out: PushResult): boolean {
    const dx = x - this.cx, dz = z - this.cz;
    const lx = dx * this.cos - dz * this.sin;
    const lz = dx * this.sin + dz * this.cos;
    const qx = clamp(lx, -this.hx, this.hx);
    const qz = clamp(lz, -this.hz, this.hz);
    const ex = lx - qx, ez = lz - qz;
    const d2 = ex * ex + ez * ez;
    if (d2 >= r * r) return false;
    let nlx: number, nlz: number;
    if (d2 > 1e-10) {
      const d = Math.sqrt(d2);
      nlx = ex / d; nlz = ez / d; out.pen = r - d;
    } else {
      const px = this.hx - Math.abs(lx), pz = this.hz - Math.abs(lz);
      if (px < pz) { nlx = lx >= 0 ? 1 : -1; nlz = 0; out.pen = px + r; }
      else { nlx = 0; nlz = lz >= 0 ? 1 : -1; out.pen = pz + r; }
    }
    out.nx = nlx * this.cos + nlz * this.sin;
    out.nz = -nlx * this.sin + nlz * this.cos;
    return true;
  }

  circleOverlaps(x: number, z: number, r: number): boolean {
    const dx = x - this.cx, dz = z - this.cz;
    const lx = dx * this.cos - dz * this.sin;
    const lz = dx * this.sin + dz * this.cos;
    const ex = lx - clamp(lx, -this.hx, this.hx);
    const ez = lz - clamp(lz, -this.hz, this.hz);
    return ex * ex + ez * ez < r * r;
  }

  /** Ray vs oriented box. Returns entry distance or -1. Origins inside the box are ignored. */
  rayHit(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): number {
    const rx = ox - this.cx, rz = oz - this.cz;
    const lox = rx * this.cos - rz * this.sin;
    const loz = rx * this.sin + rz * this.cos;
    const loy = oy - this.cy;
    const ldx = dx * this.cos - dz * this.sin;
    const ldz = dx * this.sin + dz * this.cos;
    let tmin = 0, tmax = maxDist;
    // X slab
    if (Math.abs(ldx) < 1e-9) { if (lox < -this.hx || lox > this.hx) return -1; }
    else {
      let t1 = (-this.hx - lox) / ldx, t2 = (this.hx - lox) / ldx;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
    // Y slab (ramps use their full height, slightly conservative)
    const yLo = -this.hy, yHi = this.hy + Math.max(0, this.rise);
    if (Math.abs(dy) < 1e-9) { if (loy < yLo || loy > yHi) return -1; }
    else {
      let t1 = (yLo - loy) / dy, t2 = (yHi - loy) / dy;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
    // Z slab
    if (Math.abs(ldz) < 1e-9) { if (loz < -this.hz || loz > this.hz) return -1; }
    else {
      let t1 = (-this.hz - loz) / ldz, t2 = (this.hz - loz) / ldz;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
    if (tmin <= 1e-6) return -1; // started inside
    return tmin;
  }

  /** Sphere push-out (flyers). Returns true and moves `p` if overlapping. */
  pushSphere(p: Vec3, r: number): boolean {
    const dx = p.x - this.cx, dz = p.z - this.cz;
    const lx = dx * this.cos - dz * this.sin;
    const lz = dx * this.sin + dz * this.cos;
    const ly = p.y - this.cy;
    const qx = clamp(lx, -this.hx, this.hx);
    const qy = clamp(ly, -this.hy, this.hy + Math.max(0, this.rise));
    const qz = clamp(lz, -this.hz, this.hz);
    let ex = lx - qx, ey = ly - qy, ez = lz - qz;
    const d2 = ex * ex + ey * ey + ez * ez;
    if (d2 >= r * r) return false;
    let pen: number;
    if (d2 > 1e-10) {
      const d = Math.sqrt(d2);
      ex /= d; ey /= d; ez /= d; pen = r - d;
    } else {
      ex = 0; ey = 1; ez = 0; pen = this.hy - ly + r;
    }
    p.x += (ex * this.cos + ez * this.sin) * pen;
    p.z += (-ex * this.sin + ez * this.cos) * pen;
    p.y += ey * pen;
    return true;
  }

  /** Velocity of a point on this (kinematic) collider over the last update. */
  pointVelocity(x: number, z: number, dt: number, out: Vec3): Vec3 {
    if (dt <= 0 || !this.isDynamic) { out.x = out.y = out.z = 0; return out; }
    if (this.kind === 'sweeper') {
      const dAng = this.ry - this.pry;
      // Rotation about pivot (def.p). Tangential velocity = w x r, with yaw rotating +X toward -Z.
      const px = this.def.p[0], pz = this.def.p[2];
      const rx = x - px, rz = z - pz;
      const w = dAng / dt;
      out.x = w * rz; out.z = -w * rx; out.y = 0;
      return out;
    }
    out.x = (this.cx - this.pcx) / dt;
    out.y = (this.cy - this.pcy) / dt;
    out.z = (this.cz - this.pcz) / dt;
    return out;
  }
}

/** Smooth ping-pong wave with rests at both ends. Returns 0..1. */
export function moverWave(t: number, period: number, phase: number, pause = 0.15): number {
  let u = (t / period + phase) % 1;
  if (u < 0) u += 1;
  const p = clamp(pause, 0, 0.45);
  const run = 0.5 - p;
  let k: number;
  if (u < p) k = 0;
  else if (u < 0.5) k = (u - p) / run;
  else if (u < 0.5 + p) k = 1;
  else k = 1 - (u - 0.5 - p) / run;
  return k * k * (3 - 2 * k);
}

const CELL = 10;

export class CollisionWorld {
  readonly colliders: Collider[] = [];
  readonly dynamics: Collider[] = [];
  readonly crumbles: Collider[] = [];
  /** Cables the character controller can grab. */
  readonly ziplines: ZiplineDef[];
  /** Grapple anchors the character controller can hook. */
  readonly grapples: GrappleDef[];
  time = 0;
  private minX: number;
  private minZ: number;
  private nx: number;
  private nz: number;
  private cells: Collider[][];
  private stampId = 1;
  private readonly tmpPush: PushResult = { nx: 0, nz: 0, pen: 0 };

  constructor(level: LevelData) {
    this.ziplines = level.ziplines ?? [];
    this.grapples = level.grapples ?? [];
    const pad = 40;
    this.minX = level.bounds.min[0] - pad;
    this.minZ = level.bounds.min[1] - pad;
    this.nx = Math.ceil((level.bounds.max[0] + pad - this.minX) / CELL);
    this.nz = Math.ceil((level.bounds.max[1] + pad - this.minZ) / CELL);
    this.cells = new Array(this.nx * this.nz);
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = [];

    for (const def of level.boxes) {
      if (!def.solid && !def.blocksSight) continue;
      const c = new Collider(def);
      this.colliders[def.id] = c;
      if (c.isDynamic) { this.dynamics.push(c); continue; }
      if (c.kind === 'crumble') this.crumbles.push(c);
      this.insert(c);
    }
    this.update(0);
  }

  get(id: number): Collider | undefined { return this.colliders[id]; }

  private insert(c: Collider) {
    const x0 = clamp(Math.floor((c.minX - this.minX) / CELL), 0, this.nx - 1);
    const x1 = clamp(Math.floor((c.maxX - this.minX) / CELL), 0, this.nx - 1);
    const z0 = clamp(Math.floor((c.minZ - this.minZ) / CELL), 0, this.nz - 1);
    const z1 = clamp(Math.floor((c.maxZ - this.minZ) / CELL), 0, this.nz - 1);
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.cells[z * this.nx + x].push(c);
  }

  /** Advances kinematic colliders to world time `t`. */
  update(t: number) {
    this.time = t;
    for (const c of this.dynamics) {
      c.pcx = c.cx; c.pcy = c.cy; c.pcz = c.cz; c.pry = c.ry;
      const m = c.def.move!;
      if (c.kind === 'sweeper') {
        const ry = c.def.ry + (m.spin ?? 1) * t;
        const arm = m.arm ?? 0;
        c.setTransform(c.def.p[0] + arm * Math.cos(ry), c.def.p[1], c.def.p[2] - arm * Math.sin(ry), ry);
      } else {
        const w = moverWave(t, m.period, m.phase, m.pause ?? 0.15);
        const o = m.offset ?? [0, 0, 0];
        c.setTransform(c.def.p[0] + o[0] * w, c.def.p[1] + o[1] * w, c.def.p[2] + o[2] * w, c.def.ry);
      }
    }
  }

  /** Resets "previous" transforms so the next carry delta is zero (after teleports / time jumps). */
  syncPrevious() {
    for (const c of this.dynamics) { c.pcx = c.cx; c.pcy = c.cy; c.pcz = c.cz; c.pry = c.ry; }
  }

  /** Collects candidate colliders overlapping an XZ rectangle. */
  query(minX: number, minZ: number, maxX: number, maxZ: number, out: Collider[]): Collider[] {
    out.length = 0;
    const stamp = ++this.stampId;
    const x0 = clamp(Math.floor((minX - this.minX) / CELL), 0, this.nx - 1);
    const x1 = clamp(Math.floor((maxX - this.minX) / CELL), 0, this.nx - 1);
    const z0 = clamp(Math.floor((minZ - this.minZ) / CELL), 0, this.nz - 1);
    const z1 = clamp(Math.floor((maxZ - this.minZ) / CELL), 0, this.nz - 1);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const cell = this.cells[z * this.nx + x];
        for (let i = 0; i < cell.length; i++) {
          const c = cell[i];
          if (c.stamp === stamp) continue;
          c.stamp = stamp;
          if (c.maxX < minX || c.minX > maxX || c.maxZ < minZ || c.minZ > maxZ) continue;
          out.push(c);
        }
      }
    }
    for (const c of this.dynamics) {
      if (c.maxX < minX || c.minX > maxX || c.maxZ < minZ || c.minZ > maxZ) continue;
      out.push(c);
    }
    return out;
  }

  private readonly qbuf: Collider[] = [];

  /** Highest walkable surface under a circle whose top is <= maxTop. */
  groundProbe(x: number, z: number, r: number, maxTop: number, out: GroundHit): GroundHit {
    out.top = -Infinity; out.c = null;
    const list = this.query(x - r, z - r, x + r, z + r, this.qbuf);
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c.solid || !c.enabled) continue;
      if (c.minY > maxTop) continue;
      if (!c.circleOverlaps(x, z, r)) continue;
      const top = c.topAt(x, z);
      if (top <= maxTop && top > out.top) { out.top = top; out.c = c; }
    }
    return out;
  }

  /** Lowest ceiling above `headY` for a circle. */
  ceilingProbe(x: number, z: number, r: number, headY: number): number {
    let best = Infinity;
    const list = this.query(x - r, z - r, x + r, z + r, this.qbuf);
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c.solid || !c.enabled) continue;
      const b = c.bottom;
      if (b < headY - 0.12 || b >= best) continue;
      if (!c.circleOverlaps(x, z, r)) continue;
      best = b;
    }
    return best;
  }

  /** True if a vertical cylinder (feet at y) does not intersect any solid collider. */
  isSpaceFree(x: number, y: number, z: number, r: number, h: number): boolean {
    const list = this.query(x - r, z - r, x + r, z + r, this.qbuf);
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c.solid || !c.enabled) continue;
      if (c.bottom >= y + h) continue;
      if (!c.circleOverlaps(x, z, r)) continue;
      if (c.topAt(x, z) <= y + 0.03) continue;
      return false;
    }
    return true;
  }

  /**
   * Resolves a vertical cylinder against walls. Colliders whose top is at or
   * below `stepTop` are ignored (they are stepped onto instead).
   * Returns the collider that pushed the hardest (if any).
   */
  pushCircle(pos: Vec3, r: number, h: number, stepTop: number, vel: Vec3 | null, onDynamic?: (c: Collider) => void): Collider | null {
    let hitC: Collider | null = null;
    const res = this.tmpPush;
    for (let iter = 0; iter < 3; iter++) {
      let any = false;
      const list = this.query(pos.x - r, pos.z - r, pos.x + r, pos.z + r, this.qbuf);
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (!c.solid || !c.enabled) continue;
        if (c.bottom >= pos.y + h || c.maxY <= stepTop) continue;
        if (c.rise !== 0 && c.topAt(pos.x, pos.z) <= stepTop) continue;
        if (!c.circlePush(pos.x, pos.z, r, res)) continue;
        pos.x += res.nx * (res.pen + 1e-4);
        pos.z += res.nz * (res.pen + 1e-4);
        if (vel) {
          const vn = vel.x * res.nx + vel.z * res.nz;
          if (vn < 0) { vel.x -= vn * res.nx; vel.z -= vn * res.nz; }
        }
        if (c.isDynamic && onDynamic) onDynamic(c);
        hitC = c;
        any = true;
      }
      if (!any) break;
    }
    return hitC;
  }

/**
   * Grid-walking raycast. `sight` = only sight-blocking colliders; 'camera' =
   * solid colliders except thin (railings) or small (posts, pillars, crates)
   * ones, so the camera never pops in and out as they pass the line of sight.
   */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, sight: boolean | 'camera', out: RayHit): RayHit {
    out.dist = maxDist; out.c = null;
    const stamp = ++this.stampId;
    const test = (c: Collider) => {
      if (!c.enabled) return;
      if (sight === 'camera') { if (!c.solid || Math.min(c.hx, c.hz) < 0.15 || Math.max(c.hx, c.hz) < 1.0) return; }
      else if (sight ? !c.blocksSight : !c.solid) return;
      const t = c.rayHit(ox, oy, oz, dx, dy, dz, out.dist);
      if (t >= 0 && t < out.dist) { out.dist = t; out.c = c; }
    };
    for (const c of this.dynamics) test(c);

    let cx = Math.floor((ox - this.minX) / CELL);
    let cz = Math.floor((oz - this.minZ) / CELL);
    const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const tDX = Math.abs(dx) > 1e-9 ? CELL / Math.abs(dx) : Infinity;
    const tDZ = Math.abs(dz) > 1e-9 ? CELL / Math.abs(dz) : Infinity;
    let tMX = Math.abs(dx) > 1e-9 ? ((cx + (dx > 0 ? 1 : 0)) * CELL + this.minX - ox) / dx : Infinity;
    let tMZ = Math.abs(dz) > 1e-9 ? ((cz + (dz > 0 ? 1 : 0)) * CELL + this.minZ - oz) / dz : Infinity;
    let t = 0;
    let guard = 0;
    while (t <= out.dist && guard++ < 512) {
      if (cx >= 0 && cz >= 0 && cx < this.nx && cz < this.nz) {
        const cell = this.cells[cz * this.nx + cx];
        for (let i = 0; i < cell.length; i++) {
          const c = cell[i];
          if (c.stamp === stamp) continue;
          c.stamp = stamp;
          test(c);
        }
      }
      if (tMX < tMZ) { t = tMX; tMX += tDX; cx += stepX; }
      else { t = tMZ; tMZ += tDZ; cz += stepZ; }
      if (!isFinite(t)) break;
    }
    return out;
  }

  private readonly rayTmp: RayHit = { dist: 0, c: null };

  /** Line of sight between two points (sight-blocking geometry only). */
  lineOfSight(a: Vec3, b: Vec3): boolean {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-4) return true;
    this.raycast(a.x, a.y, a.z, dx / d, dy / d, dz / d, d, true, this.rayTmp);
    return this.rayTmp.c === null;
  }

  /** Distance to the nearest solid surface straight below (Infinity if none). */
  groundBelow(x: number, y: number, z: number, maxDist = 400): number {
    this.raycast(x, y, z, 0, -1, 0, maxDist, false, this.rayTmp);
    return this.rayTmp.c ? this.rayTmp.dist : Infinity;
  }

  /** Sphere push-out for flying enemies. */
  pushSphere(p: Vec3, r: number): boolean {
    let any = false;
    const list = this.query(p.x - r, p.z - r, p.x + r, p.z + r, this.qbuf);
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c.solid || !c.enabled) continue;
      if (c.minY > p.y + r || c.maxY < p.y - r) continue;
      if (c.pushSphere(p, r)) any = true;
    }
    return any;
  }
}

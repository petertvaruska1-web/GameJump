// Level construction toolkit. Map files describe sections with these helpers;
// the builder emits plain LevelData (colliders + visuals + actors).

import type { EnemyKind } from '../constants';
import { rng } from '../math';
import type {
  BoxDef, BoxKind, EnemyDef, GrappleDef, HintDef, LaserDef, LevelData, MatKey, MoveDef, PickupDef, PowerKind, PropDef, PropType, V3, WindDef, ZiplineDef, ZoneDef,
} from './types';

export interface Cursor { x: number; y: number; z: number; yaw: number }

/** Waypoint recorded along chains (used by the headless route bot). */
export interface RoutePoint { p: V3; id: number; mover: boolean }

export interface BoxOpts {
  ry?: number;
  kind?: BoxKind;
  solid?: boolean;
  visible?: boolean;
  sight?: boolean;
  rise?: number;
  move?: MoveDef;
  tint?: number;
}

export interface PlatOpts {
  th?: number;
  mat?: MatKey;
  ry?: number;
  /** Sides with railings, in local frame: n(+z) s(-z) e(+x) w(-x). */
  rails?: string;
  /** Sides with hazard-striped rims. */
  hazard?: string;
  rim?: boolean;
  supports?: boolean;
  kind?: BoxKind;
  move?: MoveDef;
}

type ItemBase = { gap?: number; dy?: number; off?: number; mat?: MatKey; rails?: string; hazard?: string; th?: number; supports?: boolean };
export type ChainItem =
  | ({ t: 'plat'; len: number; w: number } & ItemBase)
  | ({ t: 'beam'; len: number; w?: number } & ItemBase)
  | ({ t: 'stairs'; len: number; w: number } & ItemBase)
  | ({ t: 'ramp'; len: number; w: number } & ItemBase)
  | ({ t: 'crumble'; len: number; w: number } & ItemBase)
  | ({ t: 'mover'; len: number; w: number; move: V3; period: number; phase?: number; pause?: number } & ItemBase)
  | ({ t: 'corner'; size: number; turn: number } & ItemBase)
  /** Conveyor along the heading (speed > 0 carries you forward). With dy it is a sloped belt. */
  | ({ t: 'belt'; len: number; w: number; speed: number } & ItemBase)
  /** Conveyor across the heading (speed > 0 pushes toward the left, i.e. +X at yaw 0). */
  | ({ t: 'xbelt'; len: number; w: number; speed: number } & ItemBase)
  | { t: 'skip'; len: number; dy?: number };

/** Edge-to-edge gap limits measured with the real controller (scripts/sim-jumps.ts). */
const SPRINT_TABLE: [number, number][] = [[1.4, 4.4], [1.0, 5.1], [0.5, 5.7], [0, 6.2], [-1, 7.0], [-2, 7.6], [-4, 8.7], [-8, 10.3]];
export function maxSprintGap(dy: number): number {
  if (dy >= 1.4) return dy > 1.6 ? 0 : 4.4;
  for (let i = 0; i < SPRINT_TABLE.length - 1; i++) {
    const [d0, g0] = SPRINT_TABLE[i], [d1, g1] = SPRINT_TABLE[i + 1];
    if (dy <= d0 && dy >= d1) return g0 + ((d0 - dy) / (d0 - d1)) * (g1 - g0);
  }
  return 10.3;
}

const SUPPORT_BOTTOM = -110;

export class LevelBuilder {
  readonly boxes: BoxDef[] = [];
  readonly props: PropDef[] = [];
  readonly enemies: EnemyDef[] = [];
  readonly winds: WindDef[] = [];
  readonly zones: ZoneDef[] = [];
  readonly ziplines: ZiplineDef[] = [];
  readonly lasers: LaserDef[] = [];
  readonly hints: HintDef[] = [];
  readonly grapples: GrappleDef[] = [];
  readonly pickups: PickupDef[] = [];
  readonly waypoints: { name: string; p: V3 }[] = [];
  readonly warnings: string[] = [];
  /** Chain waypoints per section tag, in placement order. */
  readonly chainPoints = new Map<string, RoutePoint[]>();
  private supportIds = new Set<number>();
  private nextId = 0;
  private nextEnemy = 0;
  private nextLaserGroup = 0;
  tag = '';
  readonly rand = rng(1337);

  section(tag: string) { this.tag = tag; }

  // ---------------------------------------------------------------- primitives

  box(p: V3, s: V3, mat: MatKey, o: BoxOpts = {}): BoxDef {
    const solid = o.solid ?? true;
    const def: BoxDef = {
      id: this.nextId++,
      p: [p[0], p[1], p[2]],
      s: [s[0], s[1], s[2]],
      ry: o.ry ?? 0,
      mat,
      kind: o.kind ?? 'static',
      solid,
      visible: o.visible ?? mat !== 'invisible',
      blocksSight: o.sight ?? (solid && mat !== 'grate' && mat !== 'invisible'),
      tint: o.tint ?? 0.9 + this.rand() * 0.2,
      tag: this.tag,
    };
    if (o.rise) def.rise = o.rise;
    if (o.move) def.move = o.move;
    this.boxes.push(def);
    return def;
  }

  /** Visual-only box. */
  deco(p: V3, s: V3, mat: MatKey, ry = 0): BoxDef {
    return this.box(p, s, mat, { ry, solid: false, sight: false });
  }

  /** Box placed by its bottom (y0) instead of its centre. Solid + sight-blocking by default. */
  block(x: number, y0: number, z: number, w: number, h: number, d: number, mat: MatKey = 'concreteDark', ry = 0, o: BoxOpts = {}): BoxDef {
    return this.box([x, y0 + h / 2, z], [w, h, d], mat, { ry, ...o });
  }

  prop(t: PropType, p: V3, extra: Partial<PropDef> = {}) {
    this.props.push({ t, p, ...extra });
  }

  // ---------------------------------------------------------------- platforms

  /** Platform whose walkable top is at `top`, centred on x/z. */
  plat(x: number, top: number, z: number, w: number, d: number, o: PlatOpts = {}): BoxDef {
    const th = o.th ?? 1.2;
    const ry = o.ry ?? 0;
    const mat = o.mat ?? 'concrete';
    const def = this.box([x, top - th / 2, z], [w, th, d], mat, { ry, kind: o.kind, move: o.move });
    const dynamic = o.kind === 'mover' || o.kind === 'sweeper' || o.kind === 'crumble';
    if (!dynamic && o.rim !== false) this.rim(x, top, z, w, d, ry, o.hazard ?? '');
    if (o.rails) this.rails(x, top, z, w, d, ry, o.rails);
    if (!dynamic && o.supports !== false) this.supports(x, top - th, z, w, d, ry);
    return def;
  }

  private local(x: number, z: number, ry: number, lx: number, lz: number): [number, number] {
    const c = Math.cos(ry), s = Math.sin(ry);
    return [x + lx * c + lz * s, z - lx * s + lz * c];
  }

  /** Raised trim band around a platform's edges (visual). */
  rim(x: number, top: number, z: number, w: number, d: number, ry: number, hazard: string) {
    const t = 0.28, h = 0.4, lift = 0.03;
    const sides: [string, number, number, number, number][] = [
      ['n', 0, d / 2 - t / 2, w + 0.08, t],
      ['s', 0, -d / 2 + t / 2, w + 0.08, t],
      ['e', w / 2 - t / 2, 0, t, d - 2 * t],
      ['w', -w / 2 + t / 2, 0, t, d - 2 * t],
    ];
    for (const [side, lx, lz, sw, sd] of sides) {
      if (sd <= 0 || sw <= 0) continue;
      const [cx, cz] = this.local(x, z, ry, lx, lz);
      const mat: MatKey = hazard.includes(side) ? 'hazard' : 'trim';
      this.deco([cx, top + lift - h / 2, cz], [sw, h, sd], mat, ry);
    }
  }

  /** Railings along the given sides: visual posts/bars + invisible solid barrier (does not block sight). */
  rails(x: number, top: number, z: number, w: number, d: number, ry: number, sides: string) {
    const H = 1.1;
    const defs: [string, number, number, number, boolean][] = [
      ['n', 0, d / 2 - 0.1, w, true],
      ['s', 0, -d / 2 + 0.1, w, true],
      ['e', w / 2 - 0.1, 0, d, false],
      ['w', -w / 2 + 0.1, 0, d, false],
    ];
    for (const [side, lx, lz, len, alongX] of defs) {
      if (!sides.includes(side)) continue;
      const [cx, cz] = this.local(x, z, ry, lx, lz);
      const size: V3 = alongX ? [len, H, 0.12] : [0.12, H, len];
      this.box([cx, top + H / 2, cz], size, 'invisible', { ry, sight: false, visible: false });
      // top bar + mid bar
      const bar: V3 = alongX ? [len, 0.07, 0.07] : [0.07, 0.07, len];
      this.deco([cx, top + H, cz], bar, 'steel', ry);
      this.deco([cx, top + H * 0.55, cz], bar, 'steel', ry);
      const n = Math.max(2, Math.round(len / 2.2) + 1);
      for (let i = 0; i < n; i++) {
        const f = -len / 2 + 0.05 + (i / (n - 1)) * (len - 0.1);
        const [px, pz] = alongX ? this.local(x, z, ry, lx + f, lz) : this.local(x, z, ry, lx, lz + f);
        this.deco([px, top + H / 2, pz], [0.08, H, 0.08], 'steel', ry);
      }
    }
  }

  /** Columns under a platform reaching down into the clouds (clipped at structures below). */
  supports(x: number, bottom: number, z: number, w: number, d: number, ry: number) {
    const area = w * d;
    const pts: [number, number, number][] = [];
    if (area < 50 || Math.min(w, d) < 4) {
      const s = Math.max(0.7, Math.min(2.4, Math.min(w, d) * 0.4));
      pts.push([0, 0, s]);
    } else {
      const s = Math.max(1.0, Math.min(2.6, Math.min(w, d) * 0.18));
      const ix = w / 2 - s * 1.2, iz = d / 2 - s * 1.2;
      pts.push([-ix, -iz, s], [ix, -iz, s], [-ix, iz, s], [ix, iz, s]);
    }
    for (const [lx, lz, s] of pts) {
      const [cx, cz] = this.local(x, z, ry, lx, lz);
      const h = bottom - SUPPORT_BOTTOM;
      const col = this.deco([cx, bottom - h / 2, cz], [s, h, s], 'concreteDark', ry);
      this.supportIds.add(col.id);
      // capital block right under the platform
      this.deco([cx, bottom - 0.5, cz], [s * 1.5, 1.0, s * 1.5], 'steel', ry);
    }
  }

  /** Narrow walkable girder between two points (tops may differ -> sloped via ramp). */
  beam(x1: number, z1: number, x2: number, z2: number, top: number, w = 0.8, mat: MatKey = 'steel', top2 = top): BoxDef {
    const dx = x2 - x1, dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    const ry = Math.atan2(dx, dz);
    const th = 0.5;
    if (Math.abs(top2 - top) < 0.01) {
      return this.box([(x1 + x2) / 2, top - th / 2, (z1 + z2) / 2], [w, th, len], mat, { ry });
    }
    return this.rampBox((x1 + x2) / 2, (z1 + z2) / 2, top, top2, ry, w, len, mat, th);
  }

  /** Ramp from `lowTop` at the local -Z end to `highTop` at +Z (ry = heading of the uphill direction). */
  rampBox(x: number, z: number, topA: number, topB: number, ry: number, w: number, len: number, mat: MatKey, th = 0.8, o: BoxOpts = {}): BoxDef {
    if (topB < topA) return this.rampBox(x, z, topB, topA, ry + Math.PI, w, len, mat, th, o);
    return this.box([x, topA - th / 2, z], [w, th, len], mat, { ry, rise: topB - topA, ...o });
  }

  /** Visual staircase with a smooth ramp collider. Rises from topA (at -Z end) to topB. */
  stairs(x: number, z: number, topA: number, topB: number, ry: number, w: number, len: number, mat: MatKey = 'concrete'): void {
    if (topB < topA) return this.stairs(x, z, topB, topA, ry + Math.PI, w, len, mat);
    const rise = topB - topA;
    this.rampBox(x, z, topA, topB, ry, w, len, 'invisible', 0.6, { sight: false, visible: false });
    const n = Math.max(2, Math.ceil(rise / 0.3));
    const run = len / n;
    for (let i = 0; i < n; i++) {
      const stepTop = topA + (rise * (i + 1)) / n - rise / n / 2;
      const lz = -len / 2 + run * (i + 0.5);
      const [cx, cz] = this.local(x, z, ry, 0, lz);
      const h = stepTop - (topA - 0.8);
      this.deco([cx, stepTop - h / 2, cz], [w, h, run + 0.02], i % 2 ? mat : 'concreteDark', ry);
    }
    // side stringers
    for (const sx of [-1, 1]) {
      const [cx, cz] = this.local(x, z, ry, sx * (w / 2 + 0.06), 0);
      this.deco([cx, (topA + topB) / 2 + 0.5, cz], [0.06, 0.06, Math.hypot(len, rise)], 'steel', ry);
    }
  }

  // ---------------------------------------------------------------- chains

  cursor(x: number, y: number, z: number, yaw = 0): Cursor { return { x, y, z, yaw }; }

  /** Lays out a sequence of pieces along a heading, validating jump gaps. Returns the advanced cursor. */
  chain(c: Cursor, items: ChainItem[], label = this.tag): Cursor {
    let prevW = 4, prevOff = 0, prevKind = 'start', prevSpeed = 0;
    for (const it of items) {
      const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
      const lx = Math.cos(c.yaw), lz = -Math.sin(c.yaw); // left (+X when yaw=0)
      if (it.t === 'skip') { c.x += fx * it.len; c.z += fz * it.len; c.y += it.dy ?? 0; continue; }
      const gap = it.gap ?? 0;
      const dy = it.dy ?? 0;
      const off = it.off ?? 0;
      const top = c.y + dy;
      const len = it.t === 'corner' ? it.size : it.len;
      const w = it.t === 'corner' ? it.size : it.t === 'beam' ? (it.w ?? 0.8) : it.w;
      // validate
      if (gap > 0 && it.t !== 'stairs' && it.t !== 'ramp') {
        const lat = Math.max(0, Math.abs(off - prevOff) - (w + prevW) / 2);
        const real = Math.hypot(gap, lat);
        const limit = maxSprintGap(dy);
        const moverSlack = it.t === 'mover' || prevKind === 'mover' ? 2.5 : 0;
        const beltSlack = prevKind === 'belt' ? Math.max(0, prevSpeed) * 0.75 : 0;
        if (real > limit * 0.97 + moverSlack + beltSlack) {
          this.warnings.push(`[${label}] gap ${real.toFixed(2)}m with dy ${dy} exceeds sprint limit ${limit.toFixed(2)}m at (${c.x.toFixed(1)}, ${c.z.toFixed(1)})`);
        }
      }
      const sx = c.x + fx * gap, sz = c.z + fz * gap;
      const cx = sx + fx * (len / 2) + lx * off;
      const cz = sz + fz * (len / 2) + lz * off;
      const mat = it.mat;
      const firstId = this.nextId;
      switch (it.t) {
        case 'plat':
          this.plat(cx, top, cz, it.w, it.len, { ry: c.yaw, mat, rails: it.rails, hazard: it.hazard ?? 'ns', th: it.th, supports: it.supports });
          break;
        case 'beam': {
          const bw = it.w ?? 0.8;
          this.box([cx, top - 0.25, cz], [bw, 0.5, it.len], mat ?? 'steel', { ry: c.yaw });
          break;
        }
        case 'crumble':
          this.crumble(cx, top, cz, it.w, it.len, c.yaw);
          break;
        case 'mover': {
          const [ml, mu, mf] = it.move;
          const offset: V3 = [lx * ml + fx * mf, mu, lz * ml + fz * mf];
          this.plat(cx, top, cz, it.w, it.len, {
            ry: c.yaw, mat: mat ?? 'metal', kind: 'mover', th: it.th ?? 0.6,
            move: { offset, period: it.period, phase: it.phase ?? 0, pause: it.pause ?? 0.18 },
          });
          break;
        }
        case 'stairs':
          this.stairs(cx, cz, c.y, top, c.yaw, it.w, it.len, mat ?? 'concrete');
          break;
        case 'ramp':
          this.rampBox(cx, cz, c.y, top, c.yaw, it.w, it.len, mat ?? 'metal', 0.6);
          break;
        case 'belt':
          this.belt(cx, c.y, top, cz, it.w, it.len, it.speed, c.yaw, { supports: it.supports });
          break;
        case 'xbelt':
          this.belt(cx, top, top, cz, it.len, it.w, it.speed, c.yaw + Math.PI / 2, { supports: it.supports });
          break;
        case 'corner': {
          this.plat(cx, top, cz, it.size, it.size, { ry: c.yaw, mat, rails: it.rails, hazard: it.hazard ?? '', th: it.th, supports: it.supports });
          this.recordPoint(label, cx, top, cz, firstId, false);
          c.x = cx; c.z = cz; c.y = top;
          c.yaw += it.turn;
          c.x += Math.sin(c.yaw) * it.size / 2;
          c.z += Math.cos(c.yaw) * it.size / 2;
          prevW = it.size; prevOff = 0; prevKind = 'corner';
          continue;
        }
      }
      const sloped = it.t === 'stairs' || it.t === 'ramp' || (it.t === 'belt' && dy !== 0);
      const midY = sloped ? (c.y + top) / 2 : top;
      this.recordPoint(label, cx, midY, cz, firstId, it.t === 'mover');
      c.x = sx + fx * len;
      c.z = sz + fz * len;
      c.y = top;
      prevW = w; prevOff = off; prevKind = it.t;
      prevSpeed = it.t === 'belt' ? it.speed : 0;
    }
    return c;
  }

  private recordPoint(label: string, x: number, y: number, z: number, id: number, mover: boolean) {
    let list = this.chainPoints.get(label);
    if (!list) { list = []; this.chainPoints.set(label, list); }
    list.push({ p: [x, y, z], id, mover });
  }

  // ---------------------------------------------------------------- set pieces

  /** Walkable pipe (cylinder visual, box collider). Tops may differ. */
  pipeWalk(x1: number, z1: number, top1: number, x2: number, z2: number, top2: number, r = 0.7) {
    const dx = x2 - x1, dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    const ry = Math.atan2(dx, dz);
    const w = r * 1.5;
    const mx = (x1 + x2) / 2, mz = (z1 + z2) / 2;
    if (Math.abs(top2 - top1) < 0.01) this.box([mx, top1 - 0.3, mz], [w, 0.6, len], 'invisible', { ry, visible: false, sight: false });
    else this.rampBox(mx, mz, top1, top2, ry, w, len, 'invisible', 0.6, { visible: false, sight: false });
    this.prop('pipe', [x1, top1 - r, z1], { q: [x2, top2 - r, z2], s: [r, r, r] });
  }

  /** Rooftop of a tower block rising out of the clouds. */
  roof(x: number, top: number, z: number, w: number, d: number, o: { ry?: number; hazard?: string; mat?: MatKey } = {}) {
    const ry = o.ry ?? 0;
    this.plat(x, top, z, w, d, { ry, mat: o.mat ?? 'concrete', hazard: o.hazard ?? '', supports: false, th: 1 });
    const h = top - 1 - SUPPORT_BOTTOM;
    this.box([x, top - 1 - h / 2, z], [w - 0.6, h, d - 0.6], 'concreteDark', { ry });
    for (let i = 0; i < 9; i++) {
      this.deco([x, top - 3 - i * 3.6, z], [w - 0.45, 1.1, d - 0.45], 'glass', ry);
    }
  }

  crumble(x: number, top: number, z: number, w: number, d: number, ry = 0): BoxDef {
    return this.box([x, top - 0.3, z], [w, 0.6, d], 'rust', { ry, kind: 'crumble' });
  }

  mover(x: number, top: number, z: number, w: number, d: number, offset: V3, period: number, phase = 0, o: { ry?: number; pause?: number; mat?: MatKey; th?: number } = {}): BoxDef {
    return this.plat(x, top, z, w, d, {
      ry: o.ry ?? 0, mat: o.mat ?? 'metal', kind: 'mover', th: o.th ?? 0.6,
      move: { offset, period, phase, pause: o.pause ?? 0.18 },
    });
  }

  /** Rotating arm hazard. Pivot at x/z, arm centre `arm` metres out, bottom at y0. */
  sweeper(x: number, y0: number, z: number, length: number, spin: number, o: { h?: number; w?: number; ry?: number } = {}) {
    const h = o.h ?? 0.9, w = o.w ?? 0.6;
    this.box([x, y0 + h / 2, z], [length, h, w], 'hazard', {
      ry: o.ry ?? 0, kind: 'sweeper', move: { spin, arm: length / 2, period: 1, phase: 0 },
    });
    // hub
    this.block(x, y0 - 0.2, z, 1.2, h + 0.8, 1.2, 'steel', 0, { solid: true });
  }

  // ---------------------------------------------------------------- new obstacles

  /**
   * Conveyor belt. The walking surface runs from `topA` at the local -Z end to
   * `topB` at +Z (sloped belts are ramps); `speed` moves riders along local +Z
   * (negative = toward -Z). ry = heading of local +Z.
   */
  belt(x: number, topA: number, topB: number, z: number, w: number, len: number, speed: number, ry = 0, o: { th?: number; supports?: boolean } = {}): BoxDef {
    const th = o.th ?? 0.7;
    let def: BoxDef;
    if (Math.abs(topB - topA) < 0.01) def = this.box([x, topA - th / 2, z], [w, th, len], 'belt', { ry });
    else if (topB > topA) def = this.rampBox(x, z, topA, topB, ry, w, len, 'belt', th);
    else { def = this.rampBox(x, z, topB, topA, ry + Math.PI, w, len, 'belt', th); speed = -speed; }
    def.belt = speed;
    // side frames and end rollers (visual)
    const lo = Math.min(topA, topB);
    for (const side of [-1, 1]) {
      const [cx, cz] = this.local(x, z, def.ry, side * (w / 2 + 0.09), 0);
      this.deco([cx, lo - th / 2 + Math.abs(topB - topA) / 2, cz], [0.18, th + 0.1, Math.hypot(len, topB - topA)], 'hazard', def.ry);
    }
    if (o.supports !== false && Math.abs(topB - topA) < 0.01) this.supports(x, lo - th, z, w, len, def.ry);
    return def;
  }

  /**
   * Launch pad (top at `top`) that throws whoever steps on it onto `to` (a
   * point on the target surface), peaking `apex` metres above the higher end.
   */
  launchPad(x: number, top: number, z: number, to: V3, apex = 3, o: { size?: number } = {}): BoxDef {
    const s = o.size ?? 3;
    const ry = Math.atan2(to[0] - x, to[2] - z);
    const def = this.box([x, top - 0.25, z], [s, 0.5, s], 'launch', { ry });
    def.launch = { to: [to[0], to[1], to[2]], apex };
    // housing ring + side vents (visual)
    this.deco([x, top - 0.55, z], [s + 0.5, 0.5, s + 0.5], 'steel', ry);
    for (const side of [-1, 1]) {
      const [cx, cz] = this.local(x, z, ry, side * (s / 2 + 0.35), 0);
      this.deco([cx, top - 0.1, cz], [0.22, 0.5, s * 0.8], 'hazard', ry);
    }
    return def;
  }

  /**
   * Zip line from `a` (the high end, cable height) down to `b`. `a` should sit
   * about 3.1 m above the take-off floor (jump to grab) and `b` about 2.65 m
   * above the landing floor.
   */
  zipline(a: V3, b: V3, o: { postA?: number; postB?: number } = {}): ZiplineDef {
    const zl: ZiplineDef = { id: this.ziplines.length, a: [a[0], a[1], a[2]], b: [b[0], b[1], b[2]], tag: this.tag };
    this.ziplines.push(zl);
    // anchor frames: a post rising past the cable with a cross-arm holding it
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const ry = Math.atan2(dx, dz);
    const l = Math.hypot(dx, dz);
    const ux = dx / l, uz = dz / l;
    const frame = (p: V3, floor: number | undefined, dir: number) => {
      if (floor === undefined) return;
      const px = p[0] - ux * 0.9 * dir, pz = p[2] - uz * 0.9 * dir;
      const h = p[1] + 0.9 - floor;
      for (const side of [-1, 1]) {
        const [cx, cz] = this.local(px, pz, ry, side * 1.1, 0);
        this.block(cx, floor, cz, 0.3, h, 0.3, 'steel', ry);
      }
      this.deco([px, p[1] + 0.75, pz], [2.6, 0.3, 0.3], 'hazard', ry);
      this.prop('redLight', [px, p[1] + 1.05, pz]);
    };
    frame(a, o.postA, 1);
    frame(b, o.postB, -1);
    return zl;
  }

  private laser(a: V3, b: V3, group: number, o: Partial<LaserDef>) {
    this.lasers.push({ id: this.lasers.length, a, b, group, tag: this.tag, ...o });
  }

  /**
   * Laser gate across a walkway: `beams` horizontal beams stacked from just
   * above `y0` up to head height. Blinks with `cycle`/`duty`; with `move` the
   * whole gate slides (use a gate shorter than the walkway to leave a gap).
   */
  laserGate(x1: number, z1: number, x2: number, z2: number, y0: number, o: {
    beams?: number; h?: number; cycle?: number; duty?: number; phase?: number;
    move?: V3; period?: number; movePhase?: number; posts?: boolean;
  } = {}) {
    const g = this.nextLaserGroup++;
    const n = o.beams ?? 5, h = o.h ?? 2.1;
    for (let i = 0; i < n; i++) {
      const y = y0 + 0.2 + (i * (h - 0.2)) / (n - 1);
      this.laser([x1, y, z1], [x2, y, z2], g, {
        cycle: o.cycle, duty: o.duty, cyclePhase: o.phase,
        move: o.move, period: o.period, phase: o.movePhase, pause: o.move ? 0.12 : undefined,
      });
    }
    if (o.posts !== false && !o.move) {
      const ry = Math.atan2(x2 - x1, z2 - z1);
      for (const [px, pz] of [[x1, z1], [x2, z2]]) {
        this.block(px, y0, pz, 0.36, h + 0.35, 0.36, 'steel', ry);
        this.prop('redLight', [px, y0 + h + 0.5, pz]);
      }
    }
  }

  /** Single low beam (jump it) sweeping back and forth by `move`. */
  laserBar(x1: number, z1: number, x2: number, z2: number, y: number, move: V3, period: number, phase = 0) {
    this.laser([x1, y, z1], [x2, y, z2], this.nextLaserGroup++, { move, period, phase, pause: 0.08 });
  }

  /** Low beam spinning around (x, z) like a windmill arm (jump it). */
  laserSpin(x: number, z: number, y: number, len: number, spin: number, ry = 0) {
    const hx = Math.cos(ry) * len / 2, hz = -Math.sin(ry) * len / 2;
    this.laser([x - hx, y, z - hz], [x + hx, y, z + hz], this.nextLaserGroup++, { spin });
  }

  /** Grapple anchor at `p` (the hook ring). `mount` adds a support: an arm from a post at that point. */
  grapple(p: V3, o: { optional?: boolean; mount?: V3 } = {}): GrappleDef {
    const g: GrappleDef = { id: this.grapples.length, p: [p[0], p[1], p[2]], optional: o.optional, tag: this.tag };
    this.grapples.push(g);
    if (o.mount) {
      const [mx, my, mz] = o.mount;
      const dx = p[0] - mx, dz = p[2] - mz, l = Math.hypot(dx, dz);
      if (l > 0.3) this.deco([(mx + p[0]) / 2, p[1] + 0.35, (mz + p[2]) / 2], [0.25, 0.25, l], 'hazard', Math.atan2(dx, dz));
      this.deco([p[0], p[1] + 0.2, p[2]], [0.12, 0.35, 0.12], 'steel');
      if (my < p[1]) this.box([mx, (my + p[1] + 0.5) / 2, mz], [0.35, p[1] + 0.5 - my, 0.35], 'steel', { sight: false });
    }
    return g;
  }

  /** Power-up crate floating at head height above the floor at `p` (p = floor point). */
  pickup(kind: PowerKind, x: number, y: number, z: number) {
    this.pickups.push({ id: this.pickups.length, kind, p: [x, y, z], tag: this.tag });
  }

  hint(key: string, x: number, y: number, z: number, r: number, text: string) {
    this.hints.push({ key, p: [x, y, z], r, text });
  }

  /** Enclosed room with doorways. Walls block sight: ideal cover. */
  building(x: number, floorTop: number, z: number, w: number, d: number, h: number, o: {
    ry?: number; doors?: { side: 'n' | 's' | 'e' | 'w'; at?: number; width?: number; height?: number }[];
    mat?: MatKey; roof?: boolean; windows?: boolean; floorMat?: MatKey; hazard?: string; floor?: boolean;
  } = {}) {
    const ry = o.ry ?? 0;
    const mat = o.mat ?? 'concreteDark';
    if (o.floor !== false) this.plat(x, floorTop, z, w, d, { ry, mat: o.floorMat ?? 'concrete', hazard: o.hazard ?? '' });
    const t = 0.5;
    const sides: { side: 'n' | 's' | 'e' | 'w'; lx: number; lz: number; len: number; alongX: boolean }[] = [
      { side: 'n', lx: 0, lz: d / 2 - t / 2, len: w, alongX: true },
      { side: 's', lx: 0, lz: -d / 2 + t / 2, len: w, alongX: true },
      { side: 'e', lx: w / 2 - t / 2, lz: 0, len: d - 2 * t, alongX: false },
      { side: 'w', lx: -w / 2 + t / 2, lz: 0, len: d - 2 * t, alongX: false },
    ];
    for (const s of sides) {
      const doors = (o.doors ?? []).filter((dd) => dd.side === s.side).map((dd) => ({
        at: dd.at ?? 0, width: dd.width ?? 3, height: Math.min(dd.height ?? 3, h - 0.4),
      })).sort((a, b) => a.at - b.at);
      // Split wall into solid segments around doors
      let cur = -s.len / 2;
      const segs: [number, number][] = [];
      for (const dd of doors) {
        const a = dd.at - dd.width / 2, b = dd.at + dd.width / 2;
        if (a > cur) segs.push([cur, a]);
        // lintel above the door
        const mid = dd.at;
        const lintelH = h - dd.height;
        const [lx2, lz2] = s.alongX ? [s.lx + mid, s.lz] : [s.lx, s.lz + mid];
        const [cx, cz] = this.local(x, z, ry, lx2, lz2);
        const size: V3 = s.alongX ? [dd.width, lintelH, t] : [t, lintelH, dd.width];
        this.box([cx, floorTop + dd.height + lintelH / 2, cz], size, mat, { ry });
        // hazard frame posts
        cur = b;
      }
      if (cur < s.len / 2) segs.push([cur, s.len / 2]);
      for (const [a, b] of segs) {
        const len = b - a;
        if (len < 0.05) continue;
        const mid = (a + b) / 2;
        const [lx2, lz2] = s.alongX ? [s.lx + mid, s.lz] : [s.lx, s.lz + mid];
        const [cx, cz] = this.local(x, z, ry, lx2, lz2);
        const size: V3 = s.alongX ? [len, h, t] : [t, h, len];
        this.box([cx, floorTop + h / 2, cz], size, mat, { ry });
        if (o.windows !== false && len > 3.2 && h > 3.4) {
          // strip windows (glass inset, visual only)
          const wsize: V3 = s.alongX ? [len - 1.2, 0.9, t + 0.06] : [t + 0.06, 0.9, len - 1.2];
          this.deco([cx, floorTop + h - 1.3, cz], wsize, 'glass', ry);
        }
      }
    }
    if (o.roof !== false) {
      this.plat(x, floorTop + h + 0.5, z, w + 0.4, d + 0.4, { ry, mat: 'concreteDark', th: 0.5, supports: false, hazard: '' });
    }
  }

  /** Shipping container (solid, sight-blocking). 2.5m tall = jump + mantle climbable. */
  container(x: number, y0: number, z: number, ry = 0, h = 2.5, len = 6.1) {
    const d = this.block(x, y0, z, 2.45, h, len, 'rust', ry);
    // ribs
    const n = 5;
    for (let i = 0; i < n; i++) {
      const f = -len / 2 + 0.4 + (i / (n - 1)) * (len - 0.8);
      const [cx, cz] = this.local(x, z, ry, 0, f);
      this.deco([cx, y0 + h / 2, cz], [2.55, h - 0.1, 0.12], 'rust', ry);
    }
    return d;
  }

  crate(x: number, y0: number, z: number, s = 1.2, ry = 0) {
    this.block(x, y0, z, s, s, s, 'invisible', ry, { visible: false, sight: true });
    this.prop('crate', [x, y0, z], { s: [s, s, s], ry });
  }

  /** Tall lattice tower (visual + solid core) rising from the clouds. */
  tower(x: number, z: number, topY: number, w = 3, o: { solid?: boolean; light?: boolean; mat?: MatKey } = {}) {
    const h = topY - SUPPORT_BOTTOM;
    this.box([x, topY - h / 2, z], [w, h, w], o.mat ?? 'steel', { solid: o.solid ?? true });
    if (o.light !== false) this.prop('redLight', [x, topY + 0.4, z]);
  }

  enemy(kind: EnemyKind, x: number, y: number, z: number, yaw: number, o: { patrol?: V3[]; leash?: number } = {}) {
    this.enemies.push({ id: this.nextEnemy++, kind, p: [x, y, z], yaw, patrol: o.patrol, leash: o.leash, tag: this.tag });
  }

  wind(min: V3, max: V3, dir: [number, number], strength: number, period: number, duty: number, phase = 0) {
    const l = Math.hypot(dir[0], dir[1]) || 1;
    this.winds.push({ id: this.winds.length, min, max, dir: [dir[0] / l, dir[1] / l], strength, period, duty, phase });
  }

  zone(name: string, minX: number, minZ: number, maxX: number, maxZ: number) {
    this.zones.push({ name, min: [minX, minZ], max: [maxX, maxZ] });
  }

  waypoint(name: string, x: number, y: number, z: number) {
    this.waypoints.push({ name, p: [x, y, z] });
  }

  // ---------------------------------------------------------------- output

  build(meta: {
    name: string; spawns: V3[]; spawnYaw: number; finish: { min: V3; max: V3 }; beacon: V3; killY: number;
  }): LevelData {
    this.clipSupports();
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const b of this.boxes) {
      if (!b.solid) continue;
      const r = Math.hypot(b.s[0], b.s[2]) / 2 + (b.move?.arm ?? 0);
      const o = b.move?.offset ?? [0, 0, 0];
      minX = Math.min(minX, b.p[0] - r + Math.min(0, o[0]));
      maxX = Math.max(maxX, b.p[0] + r + Math.max(0, o[0]));
      minZ = Math.min(minZ, b.p[2] - r + Math.min(0, o[2]));
      maxZ = Math.max(maxZ, b.p[2] + r + Math.max(0, o[2]));
    }
    return {
      ...meta,
      boxes: this.boxes,
      props: this.props,
      enemies: this.enemies,
      winds: this.winds,
      zones: this.zones,
      waypoints: this.waypoints,
      ziplines: this.ziplines,
      lasers: this.lasers,
      hints: this.hints,
      grapples: this.grapples,
      pickups: this.pickups,
      bounds: { min: [Math.floor(minX), Math.floor(minZ)], max: [Math.ceil(maxX), Math.ceil(maxZ)] },
    };
  }

  /** Cuts support columns where they would pierce a lower structure. */
  private clipSupports() {
    const solids = this.boxes.filter((b) => b.solid && b.kind === 'static' && b.mat !== 'invisible');
    for (const b of this.boxes) {
      if (!this.supportIds.has(b.id)) continue;
      const topY = b.p[1] + b.s[1] / 2;
      const half = b.s[0] / 2;
      let best = -Infinity;
      for (const o of solids) {
        const oTop = o.p[1] + o.s[1] / 2 + Math.max(0, o.rise ?? 0);
        if (oTop >= topY - 0.5 || oTop <= best) continue;
        // conservative XZ overlap using the other box's bounding circle
        const r = Math.hypot(o.s[0], o.s[2]) / 2;
        if (Math.abs(o.p[0] - b.p[0]) > r + half || Math.abs(o.p[2] - b.p[2]) > r + half) continue;
        if (!pointInBox(o, b.p[0], b.p[2])) continue;
        best = oTop;
      }
      if (best > -Infinity) {
        const h = topY - best;
        b.p[1] = best + h / 2;
        b.s[1] = h;
      }
    }
  }
}

function pointInBox(o: BoxDef, x: number, z: number): boolean {
  const c = Math.cos(o.ry), s = Math.sin(o.ry);
  const dx = x - o.p[0], dz = z - o.p[2];
  const lx = dx * c - dz * s, lz = dx * s + dz * c;
  return Math.abs(lx) <= o.s[0] / 2 && Math.abs(lz) <= o.s[2] / 2;
}

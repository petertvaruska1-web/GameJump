// Box/ramp mesh generation with metre-scaled UVs and baked vertex shading, so
// thousands of level boxes can be merged into a handful of draw calls.

import * as THREE from 'three';

export interface BoxSpec {
  p: [number, number, number];
  s: [number, number, number];
  ry: number;
  rise?: number;
  tint?: number;
}

/** Darkens geometry the further it reaches down toward the clouds. */
export function heightShade(y: number): number {
  return Math.min(1, Math.max(0.72, 0.78 + (y + 10) / 80));
}

const FACES: { n: [number, number, number]; c: number[] }[] = [
  // corner indices into the 8-corner list (x,y,z bits: 0=-,1=+) ordered CCW seen from outside
  { n: [1, 0, 0], c: [5, 4, 6, 7] },   // +X  (x=1): (1,0,1)(1,0,0)(1,1,0)(1,1,1)
  { n: [-1, 0, 0], c: [0, 1, 3, 2] },  // -X
  { n: [0, 1, 0], c: [3, 7, 6, 2] },   // +Y
  { n: [0, -1, 0], c: [0, 4, 5, 1] },  // -Y
  { n: [0, 0, 1], c: [1, 5, 7, 3] },   // +Z
  { n: [0, 0, -1], c: [4, 0, 2, 6] },  // -Z
];

export class GeoBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private uv: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];

  get empty() { return this.idx.length === 0; }

  /**
   * Adds a box. With `local` = true the box is emitted around the origin
   * (for dynamic meshes that get their transform per frame).
   */
  addBox(b: BoxSpec, texScale: number, opts: { local?: boolean; ao?: boolean; shadeY?: boolean } = {}, top?: GeoBuilder) {
    const [w, h, d] = b.s;
    const hx = w / 2, hy = h / 2, hz = d / 2;
    const rise = b.rise ?? 0;
    const cx = opts.local ? 0 : b.p[0], cy = opts.local ? 0 : b.p[1], cz = opts.local ? 0 : b.p[2];
    const ry = opts.local ? 0 : b.ry;
    const cs = Math.cos(ry), sn = Math.sin(ry);
    const tint = b.tint ?? 1;
    const ao = opts.ao ?? h < 8;
    const shadeY = opts.shadeY ?? true;
    // corners (local)
    const L: [number, number, number][] = [];
    for (let i = 0; i < 8; i++) {
      const x = i & 4 ? hx : -hx;
      const y = i & 2 ? hy : -hy;
      const z = i & 1 ? hz : -hz;
      L.push([x, y + (y > 0 && z > 0 ? rise : 0), z]);
    }
    const uOff = (b.p[0] * 0.37 + b.p[2] * 0.23) % texScale;
    const vOff = (b.p[1] * 0.31) % texScale;
    for (const f of FACES) {
      // an upward face can go to a separate builder (a material without wall streaks)
      const out = top && f.n[1] === 1 ? top : this;
      const base = out.pos.length / 3;
      let nx = f.n[0], ny = f.n[1], nz = f.n[2];
      if (rise && f.n[1] === 1) {
        const l = Math.hypot(d, rise);
        ny = d / l; nz = -rise / l;
      }
      const wnx = nx * cs + nz * sn, wnz = -nx * sn + nz * cs;
      for (const ci of f.c) {
        const [lx, ly, lz] = L[ci];
        const wx = cx + lx * cs + lz * sn;
        const wy = cy + ly;
        const wz = cz - lx * sn + lz * cs;
        out.pos.push(wx, wy, wz);
        out.nor.push(wnx, ny, wnz);
        let u: number, v: number;
        if (f.n[1] !== 0) { u = lx; v = lz; }
        else if (f.n[0] !== 0) { u = lz; v = ly; }
        else { u = lx; v = ly; }
        out.uv.push((u + uOff) / texScale, (v + vOff) / texScale);
        let shade = tint * (shadeY ? heightShade(wy) : 1);
        if (ao && f.n[1] === 0 && ly < 0) shade *= 0.72;
        if (f.n[1] === -1) shade *= 0.8;
        out.col.push(shade, shade, shade);
      }
      out.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Adds constant vertex colours (needed for vertexColors materials) to a geometry. */
export function withColor(g: THREE.BufferGeometry, shade = 1): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const arr = new Float32Array(n * 3).fill(shade);
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

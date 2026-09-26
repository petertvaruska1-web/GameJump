// The speedster's trail in Speedster Battle: a long ribbon of light pouring off
// each runner, in that runner's own colour, as long and as bright as it is fast.
//
// Each runner leaves a history of where its hips have been. Every frame the part
// of that history younger than the trail's lifetime (0.12 s at the base speed,
// 1.1 s flat out: a metre-long wisp against eighty metres of light) is resampled
// along its length with a Catmull-Rom spline, so the ribbon is one continuous
// strip that curves with the runner, with no joins and no overlapping segments to
// flicker. The tail end is cut at exactly the lifetime (interpolated), so the trail
// shortens smoothly instead of dropping points.
//
// Seven strands per runner, all camera-facing strips in one additive mesh (one draw
// call for everyone): a wide soft halo, a hot core that whitens with speed, four
// thin filaments that wind round the core and spread apart toward the tail like a
// wake, and a faint glow painted on the road beneath it. The speed factor that sets length, width and brightness is eased
// (quick to rise, slower to fall) so a burst of clicking blooms and a pause fades.

import * as THREE from 'three';
import { RACE } from '../../shared/constants';
import { clamp, damp } from '../../shared/math';

/** A runner to draw a trail for this frame. `ground`: the road's height under it. */
export interface TrailRunner { id: number; pos: THREE.Vector3; vel: THREE.Vector3; color: number; ground: number; alive: boolean }

const CAP = 256;
const MAX_RUNNERS = 3;
/** Resampled points along a trail at most, and the spacing aimed for (m). */
const SAMPLES = 96, SPACING = 0.55;
const STRANDS = 7;
/** Hip height: where the trail pours from. */
const HIP = 1.0;

const vertex = /* glsl */ `
  attribute vec4 aCol;
  attribute vec2 aUv;
  varying vec4 vCol; varying vec2 vUv;
  void main() { vCol = aCol; vUv = aUv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const fragment = /* glsl */ `
  uniform float uTime;
  varying vec4 vCol; varying vec2 vUv;
  void main() {
    // across: -1..1 (soft edges); along: 0 at the runner .. 1 at the tail; the strand's sharpness rides in vUv.x's magnitude range
    float across = abs(vUv.x);
    float sharp = vCol.a < 0.0 ? 3.0 : 1.6;
    float edge = pow(max(0.0, 1.0 - across), sharp);
    float u = vUv.y;
    float flow = 0.86 + 0.14 * sin(u * 38.0 - uTime * 26.0);
    float a = abs(vCol.a) * edge * flow;
    gl_FragColor = vec4(vCol.rgb * a, a);
  }`;

interface History {
  /** x, y, z, time per point, a ring buffer. */
  readonly p: Float32Array;
  head: number;
  n: number;
  /** Eased speed factor 0..1 and the ground under the runner (eased). */
  k: number;
  ground: number;
  color: THREE.Color;
  seen: boolean;
}

const tA = new THREE.Vector3(), tB = new THREE.Vector3(), tC = new THREE.Vector3(), tD = new THREE.Vector3();

/** Catmull-Rom between b and c (a before, d after) at u. */
function cr(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, u: number, out: THREE.Vector3) {
  const u2 = u * u, u3 = u2 * u;
  out.x = 0.5 * (2 * b.x + (-a.x + c.x) * u + (2 * a.x - 5 * b.x + 4 * c.x - d.x) * u2 + (-a.x + 3 * b.x - 3 * c.x + d.x) * u3);
  out.y = 0.5 * (2 * b.y + (-a.y + c.y) * u + (2 * a.y - 5 * b.y + 4 * c.y - d.y) * u2 + (-a.y + 3 * b.y - 3 * c.y + d.y) * u3);
  out.z = 0.5 * (2 * b.z + (-a.z + c.z) * u + (2 * a.z - 5 * b.z + 4 * c.z - d.z) * u2 + (-a.z + 3 * b.z - 3 * c.z + d.z) * u3);
  return out;
}

export class SpeedTrail {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly uv: Float32Array;
  private readonly hist = new Map<number, History>();
  private v = 0;
  // scratch
  private readonly raw: THREE.Vector3[] = Array.from({ length: CAP + 2 }, () => new THREE.Vector3());
  private readonly rawLen = new Float32Array(CAP + 2);
  private readonly pts: THREE.Vector3[] = Array.from({ length: SAMPLES }, () => new THREE.Vector3());
  private readonly side: THREE.Vector3[] = Array.from({ length: SAMPLES }, () => new THREE.Vector3());
  private readonly up: THREE.Vector3[] = Array.from({ length: SAMPLES }, () => new THREE.Vector3());
  private readonly tan: THREE.Vector3[] = Array.from({ length: SAMPLES }, () => new THREE.Vector3());
  private readonly cColor = new THREE.Color();
  private readonly white = new THREE.Color(1, 1, 1);

  constructor() {
    const quads = MAX_RUNNERS * STRANDS * (SAMPLES - 1);
    this.pos = new Float32Array(quads * 6 * 3);
    this.col = new Float32Array(quads * 6 * 4);
    this.uv = new Float32Array(quads * 6 * 2);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aCol', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aUv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({ vertexShader: vertex, fragmentShader: fragment, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false, uniforms: { uTime: { value: 0 } } });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 14;
  }

  /** Forget everyone's trail (a new race). */
  clear() { this.hist.clear(); }

  /** How fast a runner is going, as the trail sees it (0 at a jog, 1 flat out). */
  static speedK(speed: number) { return clamp((speed - 9) / (RACE.TOP - 9), 0, 1); }

  /** A runner's current (eased) speed factor. */
  kOf(id: number) { return this.hist.get(id)?.k ?? 0; }

  update(dt: number, time: number, cam: THREE.Vector3, runners: readonly TrailRunner[]) {
    this.mat.uniforms.uTime.value = time;
    this.v = 0;
    for (const h of this.hist.values()) h.seen = false;
    for (const r of runners) {
      let h = this.hist.get(r.id);
      if (!h) {
        h = { p: new Float32Array(CAP * 4), head: 0, n: 0, k: 0, ground: r.ground, color: new THREE.Color(r.color), seen: true };
        this.hist.set(r.id, h);
      }
      h.seen = true;
      h.color.set(r.color);
      const sp = Math.hypot(r.vel.x, r.vel.z);
      const want = r.alive ? SpeedTrail.speedK(sp) : 0;
      h.k += (want - h.k) * damp(want > h.k ? 7 : 2.4, dt);
      h.ground += (r.ground - h.ground) * damp(12, dt);
      this.record(h, r.pos.x, r.pos.y + HIP, r.pos.z, time, sp);
      if (this.v < this.pos.length / 3) this.build(h, time, cam, r.pos);
    }
    for (const [id, h] of this.hist) if (!h.seen) this.hist.delete(id);
    const g = this.mesh.geometry;
    g.setDrawRange(0, this.v);
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aCol') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aUv') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Adds where the hips are now (a jump across the course starts the trail afresh). */
  private record(h: History, x: number, y: number, z: number, t: number, sp: number) {
    const P = h.p;
    if (h.n > 0) {
      const i = h.head * 4;
      const d = Math.hypot(x - P[i], y - P[i + 1], z - P[i + 2]);
      if (d > Math.max(12, sp * 0.35)) h.n = 0;
      else if (d < 0.04 && t - P[i + 3] < 0.05) { P[i + 3] = t; return; }
    }
    h.head = (h.head + 1) % CAP;
    const i = h.head * 4;
    P[i] = x; P[i + 1] = y; P[i + 2] = z; P[i + 3] = t;
    h.n = Math.min(CAP, h.n + 1);
  }

  /** Resamples the young part of a history into a smooth ribbon, and lays its strands. */
  private build(h: History, time: number, cam: THREE.Vector3, feet: THREE.Vector3) {
    const k = h.k;
    if (k < 0.004 || h.n < 2) return;
    const life = 0.12 + (1.1 - 0.12) * Math.pow(k, 0.85);
    // the raw points, newest first, cut at exactly `life` seconds old
    const P = h.p, raw = this.raw, len = this.rawLen;
    let m = 0;
    raw[0].set(feet.x, feet.y + HIP, feet.z);
    len[0] = 0;
    m = 1;
    for (let j = 0; j < h.n; j++) {
      const i = ((h.head - j + CAP) % CAP) * 4;
      const age = time - P[i + 3];
      if (age > life) {
        if (m > 0) {
          // the exact end of the trail, between this point and the last one kept
          const i0 = ((h.head - j + 1 + CAP) % CAP) * 4;
          const a0 = time - P[i0 + 3];
          const u = age > a0 ? clamp((life - a0) / (age - a0), 0, 1) : 0;
          raw[m].set(P[i0] + (P[i] - P[i0]) * u, P[i0 + 1] + (P[i + 1] - P[i0 + 1]) * u, P[i0 + 2] + (P[i + 2] - P[i0 + 2]) * u);
          len[m] = len[m - 1] + raw[m].distanceTo(raw[m - 1]);
          m++;
        }
        break;
      }
      raw[m].set(P[i], P[i + 1], P[i + 2]);
      const d = raw[m].distanceTo(raw[m - 1]);
      if (d < 1e-4) continue;
      len[m] = len[m - 1] + d;
      m++;
      if (m >= CAP + 1) break;
    }
    const total = len[m - 1];
    if (m < 2 || total < 0.15) return;
    // resample evenly along the length (Catmull-Rom through the raw points)
    const M = clamp(Math.ceil(total / SPACING) + 1, 3, SAMPLES);
    let seg = 0;
    for (let j = 0; j < M; j++) {
      const d = (j / (M - 1)) * total;
      while (seg < m - 2 && len[seg + 1] < d) seg++;
      const s0 = len[seg], s1 = len[seg + 1];
      const u = s1 > s0 ? (d - s0) / (s1 - s0) : 0;
      cr(raw[Math.max(0, seg - 1)], raw[seg], raw[seg + 1], raw[Math.min(m - 1, seg + 2)], u, this.pts[j]);
    }
    // frames: tangent, a side facing the camera, and the up that completes them
    for (let j = 0; j < M; j++) {
      const a = this.pts[Math.max(0, j - 1)], b = this.pts[Math.min(M - 1, j + 1)];
      const t = this.tan[j].subVectors(b, a);
      if (t.lengthSq() < 1e-8) t.set(0, 0, 1);
      t.normalize();
      tA.subVectors(cam, this.pts[j]);
      const s = this.side[j].crossVectors(t, tA);
      if (s.lengthSq() < 1e-8) s.set(1, 0, 0);
      s.normalize();
      this.up[j].crossVectors(s, t).normalize();
    }
    // the strands
    const c = h.color, bright = 0.35 + (3.2 - 0.35) * k;
    const W = 0.34 + 0.55 * k;
    const core = this.cColor.copy(c).lerp(this.white, 0.3 + 0.45 * k);
    // 0 halo, 1 core, 2 and 3 filaments (4 more past half speed, faster and wider), 4 on the road
    this.strand(M, W * 2.4, c, bright * 0.42, 0, 1, 0, total, time, h.ground, 0);
    this.strand(M, W * 0.55, core, bright * 1.0, 0, 1, 1, total, time, h.ground, 0);
    const fil = clamp((k - 0.12) * 3, 0, 1);
    if (fil > 0) {
      this.strand(M, 0.08, c, bright * 0.9 * fil, 0.32 + 0.3 * k, 0, 2, total, time, h.ground, 0.55);
      this.strand(M, 0.08, core, bright * 0.8 * fil, 0.32 + 0.3 * k, Math.PI, 3, total, time, h.ground, 0.55);
    }
    const fil2 = clamp((k - 0.5) * 2.5, 0, 1);
    if (fil2 > 0) {
      this.strand(M, 0.05, c, bright * 0.7 * fil2, 0.55 + 0.4 * k, 1.1, 2, total, time, h.ground, 1.05);
      this.strand(M, 0.05, core, bright * 0.55 * fil2, 0.5 + 0.35 * k, 4.2, 3, total, time, h.ground, 0.8);
    }
    this.strand(M, W * 1.5, c, bright * 0.2, 0, 0, 4, total, time, h.ground, 0);
  }

  /**
   * One strand: a strip along the resampled points. `radius`/`phase`: a filament's
   * wind round the core; kind 4 lies on the road (faded out where the trail is in the air).
   */
  private strand(M: number, width: number, color: THREE.Color, bright: number, radius: number, phase: number, kind: number, total: number, time: number, ground: number, freq: number) {
    const sharp = kind === 1 || (kind >= 2 && kind <= 3);
    const L = tB, R = tC, ctr = tD;
    for (let j = 0; j < M; j++) {
      const u = j / (M - 1);
      const taper = (0.5 + 0.5 * Math.min(1, u / 0.06)) * Math.pow(1 - u, 0.7);
      const fade = Math.min(1, u / 0.025) * Math.pow(1 - u, 1.4);
      const p = this.pts[j];
      ctr.copy(p);
      let a = bright * fade;
      const hw = width * 0.5 * (kind >= 2 && kind <= 3 ? 1 : taper);
      if (radius > 0) {
        // a filament winds round the core, tight at the runner and spreading like a wake toward the tail
        const ang = u * total * freq - time * 13 + phase;
        const rr = radius * (0.3 + 0.7 * Math.min(1, u * 4)) * (1 + u * 0.9);
        ctr.addScaledVector(this.side[j], Math.cos(ang) * rr).addScaledVector(this.up[j], Math.sin(ang) * rr);
      }
      if (kind === 4) {
        // on the road beneath: flat, and only where the trail runs close over it
        const over = p.y - HIP - ground;
        a *= clamp(1 - over / 1.2, 0, 1);
        ctr.y = ground + 0.05;
        const t = this.tan[j];
        const fl = Math.hypot(t.x, t.z) || 1;
        L.set(ctr.x + (-t.z / fl) * hw, ctr.y, ctr.z + (t.x / fl) * hw);
        R.set(ctr.x - (-t.z / fl) * hw, ctr.y, ctr.z - (t.x / fl) * hw);
      } else {
        L.copy(ctr).addScaledVector(this.side[j], hw);
        R.copy(ctr).addScaledVector(this.side[j], -hw);
      }
      if (j > 0) {
        // the quad from the previous pair of points to this one
        const o = this.v;
        if (o + 6 > this.pos.length / 3) return;
        const pl = this.lastL, pr = this.lastR, pa = this.lastA, pu = this.lastU;
        this.vert(o, pl, color, pa, -1, pu, sharp);
        this.vert(o + 1, pr, color, pa, 1, pu, sharp);
        this.vert(o + 2, L, color, a, -1, u, sharp);
        this.vert(o + 3, L, color, a, -1, u, sharp);
        this.vert(o + 4, pr, color, pa, 1, pu, sharp);
        this.vert(o + 5, R, color, a, 1, u, sharp);
        this.v += 6;
      }
      this.lastL.copy(L); this.lastR.copy(R); this.lastA = a; this.lastU = u;
    }
  }

  private readonly lastL = new THREE.Vector3();
  private readonly lastR = new THREE.Vector3();
  private lastA = 0;
  private lastU = 0;

  private vert(i: number, p: THREE.Vector3, c: THREE.Color, a: number, across: number, u: number, sharp: boolean) {
    this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
    this.col[i * 4] = c.r; this.col[i * 4 + 1] = c.g; this.col[i * 4 + 2] = c.b;
    // a negative alpha marks a sharp strand (the core and the filaments)
    this.col[i * 4 + 3] = sharp ? -a : a;
    this.uv[i * 2] = across; this.uv[i * 2 + 1] = u;
  }
}

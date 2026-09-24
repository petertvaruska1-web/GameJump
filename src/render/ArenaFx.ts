// Effects in the Warden's arena: the tells and hazards of its abilities, the six
// powers, explosions, bolts, wells and rifts. Everything is pooled and most of
// it is a handful of draw calls: every bolt, beam edge, tether, streak and arc
// is a camera-facing ribbon in one dynamic mesh; flashes are one billboard
// batch; rings, markers, fireballs, wells, rifts and afterimages are small pools.
//
// Hazards are drawn from the same numbers the server tests runners against
// (shared/sim/warden.ts), at the synced match clock, so what you see is what
// hits you: the stomp's ring and the height you must clear, the beam's sweep,
// where each mortar shell will land and when, the charge's lane, the reach of a
// swipe.

import * as THREE from 'three';
import { ARENA, BOSS, POW } from '../../shared/constants';
import { clamp } from '../../shared/math';
import { BAct } from '../../shared/protocol';
import { beamAt, stompRing, swipeAt } from '../../shared/sim/warden';
import { Billboards } from './Billboards';
import type { CollisionWorld, RayHit } from '../../shared/physics/world';
import type { Particles } from './Effects';

const TMP = new THREE.Vector3(), TMP2 = new THREE.Vector3(), TMP3 = new THREE.Vector3();
const V = { x: 0, y: 0, z: 0 }, W = { x: 0, y: 0, z: 0 };
const FLASH_COL = new THREE.Color();

// ------------------------------------------------------------------ ribbons

const ribbonVertex = /* glsl */ `
  attribute vec4 color;
  attribute float across;
  varying vec4 vC;
  varying float vA;
  void main() { vC = color; vA = across; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const ribbonFragment = /* glsl */ `
  varying vec4 vC;
  varying float vA;
  void main() { float e = 1.0 - pow(abs(vA * 2.0 - 1.0), 1.6); gl_FragColor = vec4(vC.rgb, vC.a * e); }`;

/** Camera-facing quads between points, rebuilt every frame: bolts, beams, tethers, streaks. One draw call. */
class Ribbons {
  readonly mesh: THREE.Mesh;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly acr: Float32Array;
  private n = 0;
  private cam = new THREE.Vector3();
  constructor(private readonly max: number) {
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 6 * 3);
    this.col = new Float32Array(max * 6 * 4);
    this.acr = new Float32Array(max * 6);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('across', new THREE.BufferAttribute(this.acr, 1).setUsage(THREE.DynamicDrawUsage));
    for (let i = 0; i < max; i++) this.acr.set([0, 1, 0, 0, 1, 1], i * 6);
    const m = new THREE.ShaderMaterial({ vertexShader: ribbonVertex, fragmentShader: ribbonFragment, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 11;
  }
  begin(cam: THREE.Vector3) { this.n = 0; this.cam.copy(cam); }
  seg(ax: number, ay: number, az: number, bx: number, by: number, bz: number, w: number, r: number, g: number, b: number, a: number) {
    if (this.n >= this.max) return;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const mx = (ax + bx) / 2 - this.cam.x, my = (ay + by) / 2 - this.cam.y, mz = (az + bz) / 2 - this.cam.z;
    // side = along x toward-camera, normalised to half the width
    let sx = dy * mz - dz * my, sy = dz * mx - dx * mz, sz = dx * my - dy * mx;
    const l = Math.hypot(sx, sy, sz);
    if (l < 1e-6) return;
    const k = w / 2 / l;
    sx *= k; sy *= k; sz *= k;
    const o = this.n * 18;
    const P = this.pos;
    P[o] = ax - sx; P[o + 1] = ay - sy; P[o + 2] = az - sz;
    P[o + 3] = ax + sx; P[o + 4] = ay + sy; P[o + 5] = az + sz;
    P[o + 6] = bx - sx; P[o + 7] = by - sy; P[o + 8] = bz - sz;
    P[o + 9] = bx - sx; P[o + 10] = by - sy; P[o + 11] = bz - sz;
    P[o + 12] = ax + sx; P[o + 13] = ay + sy; P[o + 14] = az + sz;
    P[o + 15] = bx + sx; P[o + 16] = by + sy; P[o + 17] = bz + sz;
    const c = this.col, q = this.n * 24;
    for (let i = 0; i < 6; i++) { c[q + i * 4] = r; c[q + i * 4 + 1] = g; c[q + i * 4 + 2] = b; c[q + i * 4 + 3] = a; }
    this.n++;
  }
  /** A jagged bolt from a to b (a fresh shape every call). */
  jag(a: THREE.Vector3, b: THREE.Vector3, n: number, amp: number, w: number, r: number, g: number, bl: number, al: number) {
    let px = a.x, py = a.y, pz = a.z;
    for (let i = 1; i <= n; i++) {
      const u = i / n, j = i === n ? 0 : amp * Math.sin(u * Math.PI);
      const x = a.x + (b.x - a.x) * u + (Math.random() - 0.5) * j, y = a.y + (b.y - a.y) * u + (Math.random() - 0.5) * j, z = a.z + (b.z - a.z) * u + (Math.random() - 0.5) * j;
      this.seg(px, py, pz, x, y, z, w, r, g, bl, al);
      px = x; py = y; pz = z;
    }
  }
  end() {
    const g = this.mesh.geometry;
    g.setDrawRange(0, this.n * 6);
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }
}

// ------------------------------------------------------------------ rings, fireballs, wells, rifts

const ringFragment = /* glsl */ `
  uniform vec3 uColor; uniform float uAlpha, uInner, uTime;
  varying vec2 vUv;
  void main() {
    float r = length(vUv * 2.0 - 1.0);
    float mid = (uInner + 1.0) * 0.5;
    float band = smoothstep(uInner, mid, r) * smoothstep(1.0, mid, r);
    float a = atan(vUv.y - 0.5, vUv.x - 0.5);
    float shimmer = 0.8 + 0.2 * sin(a * 18.0 + uTime * 9.0);
    gl_FragColor = vec4(uColor * shimmer, band * uAlpha);
  }`;
const flatVertex = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

interface Ring { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; life: number; age: number; r0: number; r1: number; thick: number; color: THREE.Color; alpha: number }

const markerFragment = /* glsl */ `
  uniform vec3 uColor; uniform float uFill, uTime, uAlpha;
  varying vec2 vUv;
  void main() {
    float r = length(vUv * 2.0 - 1.0);
    float rim = smoothstep(0.86, 0.93, r) * smoothstep(1.0, 0.95, r);
    float fill = step(r, uFill) * 0.28 + smoothstep(uFill - 0.08, uFill, r) * step(r, uFill) * 0.7;
    float tick = step(0.9, fract(atan(vUv.y - 0.5, vUv.x - 0.5) * 3.8197)) * smoothstep(0.7, 0.78, r) * step(r, 0.86) * 0.5;
    float pulse = 0.75 + 0.25 * sin(uTime * (8.0 + uFill * 22.0));
    gl_FragColor = vec4(uColor, (rim * pulse + fill + tick) * uAlpha);
  }`;

const laneFragment = /* glsl */ `
  uniform vec3 uColor; uniform float uTime, uAlpha, uLen;
  varying vec2 vUv;
  void main() {
    float y = vUv.y * uLen;
    float chevron = fract((y - abs(vUv.x - 0.5) * 2.6) * 0.35 - uTime * 1.6);
    float c = smoothstep(0.0, 0.08, chevron) * smoothstep(0.42, 0.3, chevron);
    float edge = smoothstep(0.0, 0.06, vUv.x) * smoothstep(1.0, 0.94, vUv.x);
    float fade = smoothstep(1.0, 0.75, vUv.y);
    gl_FragColor = vec4(uColor, (c * 0.75 + 0.12) * edge * fade * uAlpha);
  }`;

const fireVertex = /* glsl */ `varying vec3 vN; varying vec3 vP; void main(){ vN = normalize(normalMatrix * normal); vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const fireFragment = /* glsl */ `
  uniform vec3 uHot, uCool; uniform float uK, uTime;
  varying vec3 vN; varying vec3 vP;
  void main() {
    float rim = 1.0 - abs(vN.z);
    float n = 0.5 + 0.5 * sin(vP.x * 5.0 + uTime * 11.0) * sin(vP.y * 6.0 - uTime * 9.0) * sin(vP.z * 4.0 + uTime * 7.0);
    vec3 c = mix(uHot, uCool, clamp(uK * 1.3 + rim * 0.4 - n * 0.2, 0.0, 1.0));
    gl_FragColor = vec4(c, (1.0 - uK) * (1.0 - rim * 0.55) * (0.7 + n * 0.3));
  }`;

const wellFragment = /* glsl */ `
  uniform float uTime, uK;
  varying vec3 vN; varying vec3 vP;
  void main() {
    float rim = pow(1.0 - abs(vN.z), 2.2);
    vec3 c = mix(vec3(0.02, 0.0, 0.05), vec3(0.75, 0.3, 1.6), rim);
    gl_FragColor = vec4(c * (0.8 + 0.2 * sin(uTime * 13.0)), (0.92 * uK));
  }`;
const diskFragment = /* glsl */ `
  uniform float uTime, uK;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    float a = atan(p.y, p.x);
    float s = 0.5 + 0.5 * sin(a * 5.0 + log(r + 0.02) * 9.0 + uTime * 7.0);
    float band = smoothstep(0.32, 0.45, r) * smoothstep(1.0, 0.6, r);
    gl_FragColor = vec4(mix(vec3(0.5, 0.15, 1.1), vec3(1.2, 0.7, 1.6), s) * 1.2, band * s * 0.85 * uK);
  }`;
const riftFragment = /* glsl */ `
  uniform float uTime, uK;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    p.x *= 2.2;
    float r = length(p);
    float edge = smoothstep(1.0, 0.82, r) * smoothstep(0.55, 0.8, r);
    float core = smoothstep(0.8, 0.0, r);
    float flick = 0.7 + 0.3 * sin(atan(p.y, p.x) * 11.0 + uTime * 30.0);
    vec3 col = mix(vec3(0.25, 1.7, 0.85), vec3(0.95, 2.0, 1.5), 0.5 + 0.5 * sin(uTime * 7.0 + p.y * 3.0));
    gl_FragColor = vec4(col * (edge * flick * 1.6) + vec3(0.02, 0.0, 0.06) * core, (edge * flick + core * 0.85) * uK);
  }`;

interface Fireball { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; age: number; life: number; r: number }
interface WellVis { id: number; core: THREE.Mesh; disk: THREE.Mesh; field: Ring | null; pos: THREE.Vector3; vel: THREE.Vector3; t0: number; open: boolean; k: number; closing: number; follow: THREE.Vector3 | null; mine: boolean }
interface RiftVis { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; age: number }
interface Bolt { pts: THREE.Vector3[]; life: number; age: number; w: number; color: [number, number, number] }
interface Streak { a: THREE.Vector3; b: THREE.Vector3; age: number; life: number; color: [number, number, number]; w: number }
interface Marker { id: number; mesh: THREE.Mesh; mat: THREE.ShaderMaterial; land: number; t0: number }

export class ArenaFx {
  readonly group = new THREE.Group();
  private readonly ribbons = new Ribbons(2400);
  private readonly flashes: Billboards;
  private readonly flashSlots: { age: number; life: number; size: number; pos: THREE.Vector3; alpha: number }[] = [];
  private readonly rings: Ring[] = [];
  private readonly fireballs: Fireball[] = [];
  private readonly wells: WellVis[] = [];
  private readonly rifts: RiftVis[] = [];
  private readonly bolts: Bolt[] = [];
  private readonly streaks: Streak[] = [];
  private readonly markers: Marker[] = [];
  private readonly ghosts: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; age: number }[] = [];
  private readonly wall: THREE.Mesh;
  private readonly wallMat: THREE.ShaderMaterial;
  private readonly lane: THREE.Mesh;
  private readonly laneMat: THREE.ShaderMaterial;
  private readonly beamCore: THREE.Mesh;
  private readonly beamGlow: THREE.Mesh;
  private readonly beamHit: THREE.Sprite;
  private readonly ringGeo = new THREE.PlaneGeometry(2, 2);
  private readonly sphereGeo = new THREE.IcosahedronGeometry(1, 2);
  /** The Warden's ability being drawn: its code, when it began and its numbers. */
  private act = { a: 0, at: 0, d: [] as number[] };
  private beamLast = -1;
  /** Where the beam hits this frame (for sparks and scorch), and whether it is on. */
  readonly beamEnd = new THREE.Vector3();
  beamOn = false;
  private stompDone = -1;
  onStompStart?: (x: number, z: number) => void;
  private readonly floorY = ARENA.y;

  constructor(private readonly glowTex: THREE.Texture, private readonly particles: Particles, private readonly world: Pick<CollisionWorld, 'raycast'>) {
    this.group.add(this.ribbons.mesh);
    this.flashes = new Billboards(48, { map: glowTex, additive: true, fog: 'none', renderOrder: 12 });
    for (let i = 0; i < 48; i++) { this.flashes.add(0, -9999, 0, 0.01, 0.01, 0xffffff, 0); this.flashSlots.push({ age: 1, life: 0, size: 0, pos: new THREE.Vector3(), alpha: 0 }); }
    this.group.add(this.flashes.mesh);
    for (let i = 0; i < 20; i++) {
      const mat = new THREE.ShaderMaterial({ vertexShader: flatVertex, fragmentShader: ringFragment, uniforms: { uColor: { value: new THREE.Color() }, uAlpha: { value: 0 }, uInner: { value: 0.8 }, uTime: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false });
      const mesh = new THREE.Mesh(this.ringGeo, mat);
      mesh.visible = false;
      mesh.renderOrder = 8;
      this.group.add(mesh);
      this.rings.push({ mesh, mat, life: 0, age: 1, r0: 0, r1: 0, thick: 0, color: new THREE.Color(), alpha: 0 });
    }
    for (let i = 0; i < 8; i++) {
      const mat = new THREE.ShaderMaterial({ vertexShader: fireVertex, fragmentShader: fireFragment, uniforms: { uHot: { value: new THREE.Color() }, uCool: { value: new THREE.Color() }, uK: { value: 0 }, uTime: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
      const mesh = new THREE.Mesh(this.sphereGeo, mat);
      mesh.visible = false;
      mesh.renderOrder = 9;
      this.group.add(mesh);
      this.fireballs.push({ mesh, mat, age: 1, life: 0, r: 1 });
    }
    for (let i = 0; i < 6; i++) {
      const mat = new THREE.ShaderMaterial({ vertexShader: flatVertex, fragmentShader: riftFragment, uniforms: { uTime: { value: 0 }, uK: { value: 0 } }, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      mesh.visible = false;
      mesh.renderOrder = 10;
      this.group.add(mesh);
      this.rifts.push({ mesh, mat, age: 1 });
    }
    // afterimages
    const gg = ghostMerged();
    for (let i = 0; i < 10; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.3, 0.5), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      const mesh = new THREE.Mesh(gg, mat);
      mesh.visible = false;
      this.group.add(mesh);
      this.ghosts.push({ mesh, mat, age: 1 });
    }
    // the stomp's wave: a wall of force as high as you must jump to clear it
    this.wallMat = new THREE.ShaderMaterial({
      vertexShader: flatVertex,
      fragmentShader: `uniform float uAlpha, uTime; varying vec2 vUv; void main(){ float up = smoothstep(1.0, 0.2, vUv.y); float edge = smoothstep(0.85, 1.0, vUv.y) * 0.8; float s = 0.8 + 0.2 * sin(vUv.x * 120.0 + uTime * 20.0); gl_FragColor = vec4(vec3(1.6, 0.9, 0.35) * s, (up * 0.55 + edge) * uAlpha); }`,
      uniforms: { uAlpha: { value: 0 }, uTime: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    });
    const wg = new THREE.CylinderGeometry(1, 1, BOSS.STOMP.HEIGHT, 96, 1, true);
    wg.translate(0, BOSS.STOMP.HEIGHT / 2, 0);
    this.wall = new THREE.Mesh(wg, this.wallMat);
    this.wall.visible = false;
    this.wall.renderOrder = 8;
    this.group.add(this.wall);
    // the charge's lane: chevrons racing along where it is going to run
    this.laneMat = new THREE.ShaderMaterial({ vertexShader: flatVertex, fragmentShader: laneFragment, uniforms: { uColor: { value: new THREE.Color(2.4, 0.35, 0.2) }, uTime: { value: 0 }, uAlpha: { value: 0 }, uLen: { value: 20 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    const lg = new THREE.PlaneGeometry(1, 1);
    lg.rotateX(-Math.PI / 2);
    lg.translate(0, 0, 0.5);
    this.lane = new THREE.Mesh(lg, this.laneMat);
    this.lane.visible = false;
    this.lane.renderOrder = 7;
    this.group.add(this.lane);
    // the beam: a white-hot core in a red glow, and where it hits
    const bc = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
    bc.rotateX(Math.PI / 2); bc.translate(0, 0, 0.5);
    this.beamCore = new THREE.Mesh(bc, new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 2.6, 2.2), toneMapped: false }));
    this.beamGlow = new THREE.Mesh(bc, new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 0.25, 0.12), transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.beamHit = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xff5a30, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    for (const m of [this.beamCore, this.beamGlow, this.beamHit]) { m.visible = false; m.frustumCulled = false; this.group.add(m); }
    // mortar markers
    for (let i = 0; i < 16; i++) {
      const mat = new THREE.ShaderMaterial({ vertexShader: flatVertex, fragmentShader: markerFragment, uniforms: { uColor: { value: new THREE.Color(2.2, 0.35, 0.15) }, uFill: { value: 0 }, uTime: { value: 0 }, uAlpha: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
      const mesh = new THREE.Mesh(this.ringGeo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.scale.setScalar(BOSS.MORTAR.RADIUS);
      mesh.visible = false;
      mesh.renderOrder = 7;
      this.group.add(mesh);
      this.markers.push({ id: -1, mesh, mat, land: 0, t0: 0 });
    }
  }

  // ------------------------------------------------------------------ one-shot effects

  /** A flash of light (additive glow) at `p`. */
  flash(p: THREE.Vector3, size: number, color: number, life = 0.25, alpha = 1) {
    let best = 0, oldest = -1;
    for (let i = 0; i < this.flashSlots.length; i++) { const s = this.flashSlots[i]; if (s.age / Math.max(1e-3, s.life) > oldest) { oldest = s.age / Math.max(1e-3, s.life); best = i; } }
    const s = this.flashSlots[best];
    s.age = 0; s.life = life; s.size = size; s.pos.copy(p); s.alpha = alpha;
    this.flashes.setColor(best, FLASH_COL.set(color));
  }

  /** An expanding ring: flat on the ground (normal up) or facing along `normal`. */
  ring(p: THREE.Vector3, r0: number, r1: number, life: number, color: THREE.ColorRepresentation, thick = 0.5, alpha = 1, normal?: THREE.Vector3) {
    const r = this.rings.reduce((a, b) => (b.age / Math.max(1e-3, b.life) > a.age / Math.max(1e-3, a.life) ? b : a));
    r.age = 0; r.life = life; r.r0 = r0; r.r1 = r1; r.thick = thick; r.alpha = alpha;
    r.color.set(color);
    r.mesh.position.copy(p);
    if (normal) r.mesh.quaternion.setFromUnitVectors(TMP.set(0, 0, 1), TMP2.copy(normal).normalize());
    else r.mesh.rotation.set(-Math.PI / 2, 0, 0);
    r.mesh.visible = true;
    return r;
  }

  private fireball(p: THREE.Vector3, r: number, life: number, hot: THREE.ColorRepresentation, cool: THREE.ColorRepresentation) {
    const f = this.fireballs.reduce((a, b) => (b.age / Math.max(1e-3, b.life) > a.age / Math.max(1e-3, a.life) ? b : a));
    f.age = 0; f.life = life; f.r = r;
    f.mat.uniforms.uHot.value.set(hot);
    f.mat.uniforms.uCool.value.set(cool);
    f.mesh.position.copy(p);
    f.mesh.visible = true;
  }

  /** An explosion. kind: 0 canister, 1 mortar shell, 2 gravity implosion, 3 bot, 4 thunder, 5 crash, 6 hull shock. */
  explosion(p: THREE.Vector3, r: number, kind: number) {
    const P = this.particles;
    switch (kind) {
      case 2: // the well collapses: purple in, then out
        this.flash(p, r * 3, 0xc070ff, 0.35);
        this.ring(p, r * 1.6, 0.2, 0.25, new THREE.Color(1.2, 0.5, 2.2), 0.4);
        this.ring(TMP.copy(p), 0.3, r * 1.4, 0.45, new THREE.Color(1.4, 0.7, 2.4), 0.25);
        P.burst(p.x, p.y, p.z, 60, 11, 0.6, 0.3, [0.75, 0.45, 1], 1, 4, 1);
        break;
      case 3: // a bot comes apart
        this.flash(p, 4, 0xff7a3a, 0.22);
        this.fireball(p, 1.2, 0.35, new THREE.Color(3, 1.6, 0.6), new THREE.Color(0.3, 0.1, 0.05));
        P.burst(p.x, p.y, p.z, 30, 8, 0.7, 0.18, [1, 0.6, 0.2], 1, 14, 2);
        P.burst(p.x, p.y, p.z, 14, 5, 1.2, 0.35, [0.25, 0.24, 0.24], 0.9, 9, 2);
        break;
      case 4: // thunder
        this.flash(p, 18, 0xbfe8ff, 0.4);
        this.ring(TMP.set(p.x, this.floorY + 0.1, p.z), 1, 12, 0.5, new THREE.Color(1.2, 2, 3), 0.18);
        P.burst(p.x, p.y, p.z, 70, 14, 0.6, 0.18, [0.7, 0.9, 1], 1, 12, 2);
        break;
      case 5: // a charge into a pillar
        this.flash(p, 12, 0xffd080, 0.3);
        P.burst(p.x, p.y, p.z, 80, 12, 1.1, 0.2, [1, 0.8, 0.4], 1, 16, 3);
        P.burst(p.x, p.y - 3, p.z, 40, 6, 1.8, 0.8, [0.45, 0.42, 0.38], 0.7, 2, 1);
        this.ring(TMP.set(p.x, this.floorY + 0.1, p.z), 1, 9, 0.6, new THREE.Color(1.4, 1.1, 0.7), 0.2);
        break;
      case 6: // the hull discharges
        this.flash(p, 14, 0x80d0ff, 0.3);
        this.ring(p, 1, r * 1.8, 0.4, new THREE.Color(1, 2, 3.2), 0.2);
        P.burst(p.x, p.y, p.z, 60, 12, 0.5, 0.15, [0.6, 0.9, 1], 1, 6, 3);
        break;
      default: { // a canister or a shell: fire, a shock ring on the ground, sparks, debris and smoke
        const big = kind === 0;
        this.flash(p, r * (big ? 3.4 : 2.8), big ? 0xffa040 : 0xff6030, 0.3);
        this.fireball(p, r * (big ? 0.9 : 0.75), big ? 0.55 : 0.45, new THREE.Color(3.2, 2.0, 0.8), new THREE.Color(0.25, 0.06, 0.02));
        this.ring(TMP.set(p.x, Math.max(this.floorY, p.y - 1) + 0.12, p.z), 0.5, r * 1.3, 0.45, new THREE.Color(2.2, 1.2, 0.5), 0.22);
        P.burst(p.x, p.y, p.z, big ? 70 : 50, 14, 0.8, 0.2, [1, 0.7, 0.3], 1, 14, 3);
        P.burst(p.x, p.y, p.z, 26, 9, 1.4, 0.3, [0.3, 0.27, 0.25], 0.9, 16, 5);
        P.burst(p.x, p.y + 0.5, p.z, 22, 2.5, 2.2, 1.1, [0.22, 0.21, 0.22], 0.55, -1.5, 1.2);
      }
    }
  }

  /** A lightning bolt along `pts` (origin, target, then any chain), flickering for `life` seconds. */
  bolt(pts: THREE.Vector3[], life = 0.14, w = 0.16, color: [number, number, number] = [1.2, 2.2, 3.2]) {
    if (pts.length < 2) return;
    this.bolts.push({ pts: pts.map((q) => q.clone()), life, age: 0, w, color });
    for (let i = 1; i < pts.length; i++) {
      this.flash(pts[i], i === 1 ? 2.4 : 1.6, 0x9fe0ff, 0.12);
      this.particles.burst(pts[i].x, pts[i].y, pts[i].z, 8, 7, 0.25, 0.12, [0.7, 0.9, 1], 1, 10, 1);
    }
  }

  /** The storm strikes: a huge bolt out of the clouds onto `p`. */
  thunder(p: THREE.Vector3) {
    const top = p.clone().add(TMP.set((Math.random() - 0.5) * 20, 90, (Math.random() - 0.5) * 20));
    this.bolts.push({ pts: [top, p.clone()], life: 0.35, age: 0, w: 0.9, color: [1.8, 2.6, 3.4] });
    this.explosion(p, 6, 4);
  }

  /** A streak of light from a to b (a flash strike, a thrown thing). */
  streak(a: THREE.Vector3, b: THREE.Vector3, life: number, color: [number, number, number], w: number) {
    this.streaks.push({ a: a.clone(), b: b.clone(), age: 0, life, color, w });
  }

  /** Super speed: afterimages strung along the path, a sonic ring where it began, a streak of light. */
  flashStrike(a: THREE.Vector3, b: THREE.Vector3) {
    const d = TMP.subVectors(b, a), len = d.length();
    if (len < 0.5) return;
    const yaw = Math.atan2(d.x, d.z), pitch = -Math.asin(clamp(d.y / len, -1, 1));
    const n = Math.min(this.ghosts.length, Math.max(3, Math.round(len / 2.2)));
    for (let i = 0; i < n; i++) {
      const g = this.ghosts.reduce((x, y) => (y.age > x.age ? y : x));
      g.age = -i * 0.018;
      g.mesh.position.lerpVectors(a, b, (i + 0.5) / n);
      g.mesh.rotation.set(pitch * 0.5, yaw, 0, 'YXZ');
      g.mesh.visible = true;
    }
    this.streak(TMP2.copy(a).setY(a.y + 1.1), TMP3.copy(b).setY(b.y + 1.1), 0.3, [2.4, 2.0, 0.8], 0.9);
    this.streak(TMP2.copy(a).setY(a.y + 1.1), TMP3.copy(b).setY(b.y + 1.1), 0.18, [3, 3, 2.4], 0.25);
    this.ring(TMP2.copy(a).setY(a.y + 1), 0.4, 2.6, 0.3, new THREE.Color(2.2, 1.9, 1.0), 0.25, 1, d);
    this.particles.burst(b.x, b.y + 0.5, b.z, 16, 6, 0.4, 0.2, [1, 0.85, 0.4], 0.9, 6, 1);
  }

  /** Teleport: a tear in space where you were and where you are, and the line torn between them. */
  blink(a: THREE.Vector3, b: THREE.Vector3, cam: THREE.Vector3) {
    for (const [p, s] of [[a, 1.0], [b, 1.35]] as [THREE.Vector3, number][]) {
      const r = this.rifts.reduce((x, y) => (y.age > x.age ? y : x));
      r.age = 0;
      r.mesh.position.set(p.x, p.y + 1.1, p.z);
      r.mesh.lookAt(cam.x, p.y + 1.1, cam.z);
      r.mesh.userData.s = s;
      r.mesh.visible = true;
    }
    this.streak(TMP2.copy(a).setY(a.y + 1.1), TMP3.copy(b).setY(b.y + 1.1), 0.35, [0.45, 2.2, 1.25], 0.35);
    this.ring(TMP2.copy(b).setY(b.y + 0.1), 0.4, POW.teleport.BURST_RADIUS, 0.4, new THREE.Color(0.45, 2.1, 1.2), 0.2);
    this.particles.burst(b.x, b.y + 1, b.z, 40, 8, 0.5, 0.18, [0.45, 1, 0.7], 1, 2, 1);
    // what was left behind is sucked into the fold
    for (let i = 0; i < 26; i++) {
      const ang = Math.random() * Math.PI * 2, rr = 1.5 + Math.random() * 3;
      const x = a.x + Math.cos(ang) * rr, y = a.y + 0.3 + Math.random() * 2, z = a.z + Math.sin(ang) * rr;
      this.particles.emit(x, y, z, (a.x - x) * 4, (a.y + 1.1 - y) * 4, (a.z - z) * 4, 0.3, 0.14, 0.4, 1, 0.7, 1, 0, -0.3);
    }
  }

  /** A punch: a cone of force out of the fist. */
  punch(p: THREE.Vector3, d: THREE.Vector3, hit: boolean) {
    this.flash(p, hit ? 3.2 : 1.8, 0xffb060, 0.16);
    this.ring(TMP.copy(p).addScaledVector(d, 1.2), 0.3, hit ? 2.6 : 1.8, 0.22, new THREE.Color(2.2, 1.5, 0.8), 0.35, 1, d);
    this.ring(TMP.copy(p).addScaledVector(d, 2.6), 0.2, 1.4, 0.28, new THREE.Color(1.6, 1.0, 0.5), 0.3, 0.7, d);
    this.particles.burst(p.x + d.x, p.y + d.y, p.z + d.z, hit ? 26 : 10, 9, 0.35, 0.16, [1, 0.8, 0.5], 1, 6, 0);
  }

  /** A meteor slam lands. */
  slam(p: THREE.Vector3, speed: number) {
    const k = clamp(speed / POW.kinetic.SLAM_SPEED, 0.4, 1.2);
    this.flash(TMP.copy(p).setY(p.y + 0.6), 6 * k, 0xffc070, 0.25);
    this.ring(TMP.copy(p).setY(p.y + 0.08), 0.5, POW.kinetic.SLAM_RADIUS * 1.15, 0.45, new THREE.Color(2.4, 1.6, 0.8), 0.28);
    this.ring(TMP.copy(p).setY(p.y + 0.12), 0.3, POW.kinetic.SLAM_RADIUS * 0.7, 0.3, new THREE.Color(3, 2.4, 1.4), 0.4);
    this.particles.dust(p.x, p.y, p.z, 1);
    this.particles.burst(p.x, p.y + 0.3, p.z, Math.round(40 * k), 11, 0.9, 0.22, [0.62, 0.58, 0.52], 0.9, 18, 5);
    this.particles.burst(p.x, p.y + 0.3, p.z, 20, 8, 0.4, 0.14, [1, 0.8, 0.45], 1, 12, 4);
  }

  /** Telekinesis push: a shimmering wave rolling out of the hands. */
  push(p: THREE.Vector3, d: THREE.Vector3) {
    this.ring(TMP.copy(p).addScaledVector(d, 1.2), 0.5, 3.2, 0.35, new THREE.Color(2.2, 0.55, 1.8), 0.45, 1, d);
    this.ring(TMP.copy(p).addScaledVector(d, 4.5), 0.5, 4.8, 0.45, new THREE.Color(1.8, 0.45, 1.5), 0.4, 0.8, d);
    for (let i = 0; i < 24; i++) {
      const s = 14 + Math.random() * 8;
      this.particles.emit(p.x + (Math.random() - 0.5), p.y + (Math.random() - 0.5), p.z + (Math.random() - 0.5), d.x * s + (Math.random() - 0.5) * 5, d.y * s + (Math.random() - 0.5) * 5, d.z * s + (Math.random() - 0.5) * 5, 0.45, 0.16, 1, 0.45, 0.85, 0.9, 0, 0.5);
    }
  }

  // ------------------------------------------------------------------ gravity wells

  wellThrown(id: number, from: THREE.Vector3, dir: THREE.Vector3, t0: number, mine: boolean) {
    // a local throw is drawn at once; the server's copy then takes it over
    let w = this.wells.find((x) => x.id === id || (mine && x.mine && x.id < 0 && id >= 0));
    if (!w) {
      const core = new THREE.Mesh(this.sphereGeo, new THREE.ShaderMaterial({ vertexShader: fireVertex, fragmentShader: wellFragment, uniforms: { uTime: { value: 0 }, uK: { value: 1 } }, transparent: true, depthWrite: false, toneMapped: false }));
      const disk = new THREE.Mesh(this.ringGeo, new THREE.ShaderMaterial({ vertexShader: flatVertex, fragmentShader: diskFragment, uniforms: { uTime: { value: 0 }, uK: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }));
      disk.rotation.x = -Math.PI / 2;
      core.renderOrder = 9; disk.renderOrder = 10;
      this.group.add(core, disk);
      w = { id, core, disk, field: null, pos: from.clone(), vel: dir.clone().multiplyScalar(POW.gravity.SPEED), t0, open: false, k: 0, closing: 0, follow: null, mine };
      this.wells.push(w);
    }
    w.id = id;
    if (!w.open) { w.pos.copy(from); w.vel.copy(dir).multiplyScalar(POW.gravity.SPEED); w.t0 = t0; }
  }

  wellOpened(id: number, p: THREE.Vector3, follow: THREE.Vector3 | null) {
    const w = this.wells.find((x) => x.id === id);
    if (!w) return;
    w.open = true;
    w.pos.copy(p);
    w.follow = follow;
    w.field = this.ring(TMP.set(p.x, Math.max(this.floorY, p.y - 3) + 0.1, p.z), POW.gravity.RADIUS, POW.gravity.RADIUS, POW.gravity.LIFE, new THREE.Color(0.6, 0.25, 1.2), 0.06, 0.5);
    this.flash(p, 5, 0xa060ff, 0.3);
  }

  wellClosed(id: number) {
    const w = this.wells.find((x) => x.id === id);
    if (w) w.closing = 0.001;
  }

  /** Where the wells are (for sound). */
  wellPositions(): THREE.Vector3[] { return this.wells.filter((w) => w.open && !w.closing).map((w) => w.pos); }

  // ------------------------------------------------------------------ mortar markers

  shell(id: number, land: THREE.Vector3, landAt: number, t: number) {
    const m = this.markers.find((x) => x.id < 0) ?? this.markers.reduce((a, b) => (b.land < a.land ? b : a));
    m.id = id; m.land = landAt; m.t0 = t;
    m.mesh.position.set(land.x, land.y + 0.06, land.z);
    m.mesh.visible = true;
  }

  shellGone(id: number) {
    const m = this.markers.find((x) => x.id === id);
    if (m) { m.id = -1; m.mesh.visible = false; }
  }

  // ------------------------------------------------------------------ the Warden's abilities

  /** The Warden started an ability: its tell and hazard are drawn from these numbers. */
  setAct(a: number, at: number, d: number[]) {
    this.act = { a, at, d };
    if (a === BAct.Beam) this.beamLast = -1;
  }

  clearAct() { this.act = { a: 0, at: 0, d: [] }; }

  // ------------------------------------------------------------------ per frame

  /**
   * `mt`: match clock (hazards); `eye`: where the Warden's eye is drawn; `held`:
   * pairs of points for telekinesis tethers; `cam`: camera position.
   */
  update(dt: number, t: number, mt: number, cam: THREE.Vector3, eye: THREE.Vector3, tethers: [THREE.Vector3, THREE.Vector3][]) {
    const R = this.ribbons, P = this.particles;
    R.begin(cam);
    // flashes
    for (let i = 0; i < this.flashSlots.length; i++) {
      const s = this.flashSlots[i];
      if (s.age > s.life) { this.flashes.set(i, 0, -9999, 0, 0.01, 0.01, 0); continue; }
      s.age += dt;
      const k = clamp(1 - s.age / s.life, 0, 1);
      const sz = s.size * (0.7 + 0.3 * (1 - k));
      this.flashes.set(i, s.pos.x, s.pos.y, s.pos.z, sz, sz, k * k * s.alpha);
    }
    // rings
    for (const r of this.rings) {
      if (!r.mesh.visible) continue;
      r.age += dt;
      const k = clamp(r.age / r.life, 0, 1);
      if (k >= 1) { r.mesh.visible = false; continue; }
      const e = 1 - (1 - k) * (1 - k);
      const rad = Math.max(0.05, r.r0 + (r.r1 - r.r0) * e);
      r.mesh.scale.setScalar(rad + r.thick / 2);
      r.mat.uniforms.uInner.value = clamp((rad - r.thick / 2) / (rad + r.thick / 2), 0, 0.98);
      r.mat.uniforms.uColor.value.copy(r.color);
      r.mat.uniforms.uAlpha.value = r.alpha * (1 - k) * (1 - k * 0.3);
      r.mat.uniforms.uTime.value = t;
    }
    for (const f of this.fireballs) {
      if (!f.mesh.visible) continue;
      f.age += dt;
      const k = f.age / f.life;
      if (k >= 1) { f.mesh.visible = false; continue; }
      f.mesh.scale.setScalar(f.r * (0.35 + Math.sqrt(k) * 0.9));
      f.mat.uniforms.uK.value = k;
      f.mat.uniforms.uTime.value = t;
    }
    for (const r of this.rifts) {
      if (!r.mesh.visible) continue;
      r.age += dt;
      const k = r.age / 0.42;
      if (k >= 1) { r.mesh.visible = false; continue; }
      const pop = Math.sin(Math.min(1, k * 1.6) * Math.PI) * (r.mesh.userData.s as number);
      r.mesh.scale.set(pop * 1.5, pop * 2.8, 1);
      r.mat.uniforms.uK.value = 1 - k * k;
      r.mat.uniforms.uTime.value = t;
    }
    for (const g of this.ghosts) {
      if (!g.mesh.visible) continue;
      g.age += dt;
      if (g.age < 0) { g.mat.opacity = 0; continue; }
      const k = g.age / 0.38;
      if (k >= 1) { g.mesh.visible = false; continue; }
      g.mat.opacity = (1 - k) * 0.55;
    }
    // bolts, flickering into a new shape every frame
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.age += dt;
      if (b.age > b.life) { this.bolts.splice(i, 1); continue; }
      const a = 1 - b.age / b.life;
      for (let j = 1; j < b.pts.length; j++) {
        const len = b.pts[j].distanceTo(b.pts[j - 1]);
        const n = Math.max(4, Math.min(18, Math.round(len / 1.5)));
        R.jag(b.pts[j - 1], b.pts[j], n, Math.min(2.2, len * 0.12), b.w * 4, b.color[0] * 0.25, b.color[1] * 0.25, b.color[2] * 0.3, a * 0.5);
        R.jag(b.pts[j - 1], b.pts[j], n, Math.min(2.2, len * 0.12), b.w, b.color[0], b.color[1], b.color[2], a);
        // a stray branch now and then
        if (Math.random() < 0.3) {
          TMP.lerpVectors(b.pts[j - 1], b.pts[j], Math.random());
          TMP2.copy(TMP).add(TMP3.set((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3));
          R.jag(TMP, TMP2, 4, 0.8, b.w * 0.6, b.color[0], b.color[1], b.color[2], a * 0.7);
        }
      }
    }
    for (let i = this.streaks.length - 1; i >= 0; i--) {
      const s = this.streaks[i];
      s.age += dt;
      if (s.age > s.life) { this.streaks.splice(i, 1); continue; }
      const k = 1 - s.age / s.life;
      R.seg(s.a.x, s.a.y, s.a.z, s.b.x, s.b.y, s.b.z, s.w * (0.5 + k * 0.5), s.color[0] * k, s.color[1] * k, s.color[2] * k, k);
    }
    // telekinesis tethers: a wavering line of force from the hands to what they hold
    for (const [a, b] of tethers) {
      let px = a.x, py = a.y, pz = a.z;
      for (let i = 1; i <= 10; i++) {
        const u = i / 10, wob = Math.sin(u * Math.PI) * 0.35;
        const x = a.x + (b.x - a.x) * u + Math.sin(t * 13 + u * 9) * wob, y = a.y + (b.y - a.y) * u + Math.cos(t * 11 + u * 7) * wob, z = a.z + (b.z - a.z) * u + Math.sin(t * 9 + u * 5) * wob;
        R.seg(px, py, pz, x, y, z, 0.22, 2.2, 0.5, 1.8, 0.8);
        px = x; py = y; pz = z;
      }
      if (Math.random() < dt * 30) P.emit(b.x + (Math.random() - 0.5) * 1.4, b.y + (Math.random() - 0.5) * 1.4, b.z + (Math.random() - 0.5) * 1.4, 0, 0.6, 0, 0.5, 0.12, 1, 0.45, 0.85, 0.9, -0.3, 0);
    }
    // wells: a black heart ringed with violet, a swirling disc, things spiralling in
    for (let i = this.wells.length - 1; i >= 0; i--) {
      const w = this.wells[i];
      const core = w.core.material as THREE.ShaderMaterial, disk = w.disk.material as THREE.ShaderMaterial;
      core.uniforms.uTime.value = t; disk.uniforms.uTime.value = t;
      if (!w.open) {
        const age = Math.max(0, mt - w.t0);
        TMP.copy(w.pos).addScaledVector(w.vel, Math.min(age, POW.gravity.RANGE / POW.gravity.SPEED));
        w.core.position.copy(TMP);
        w.core.scale.setScalar(0.45);
        w.disk.visible = false;
        P.emit(TMP.x, TMP.y, TMP.z, 0, 0, 0, 0.35, 0.3, 0.55, 0.25, 1, 0.7, 0, -0.6);
        if (age > 2) { this.dropWell(i); }
        continue;
      }
      if (w.follow) w.pos.copy(w.follow);
      if (w.closing > 0) {
        w.closing += dt;
        const k = w.closing / 0.18;
        w.core.scale.setScalar(Math.max(0.01, 1.2 * (1 - k)));
        disk.uniforms.uK.value = Math.max(0, 1 - k);
        if (k >= 1) this.dropWell(i);
        continue;
      }
      w.k = Math.min(1, w.k + dt * 4);
      w.core.position.copy(w.pos);
      w.core.scale.setScalar(1.15 * w.k + Math.sin(t * 20) * 0.05);
      w.disk.visible = true;
      w.disk.position.copy(w.pos);
      w.disk.scale.setScalar(3.6 * w.k);
      w.disk.rotation.z = t * 2;
      disk.uniforms.uK.value = w.k;
      for (let j = 0; j < 3; j++) {
        const ang = Math.random() * Math.PI * 2, rr = 3 + Math.random() * 6, y = (Math.random() - 0.5) * 4;
        const x = w.pos.x + Math.cos(ang) * rr, z = w.pos.z + Math.sin(ang) * rr;
        P.emit(x, w.pos.y + y, z, (w.pos.x - x) * 1.6 - Math.sin(ang) * 6, -y * 1.6, (w.pos.z - z) * 1.6 + Math.cos(ang) * 6, 0.55, 0.13, 0.75, 0.4, 1, 0.85, 0, -0.2);
      }
    }
    // mortar markers fill as the shell comes down
    for (const m of this.markers) {
      if (m.id < 0) continue;
      const k = clamp((mt - m.t0) / Math.max(0.1, m.land - m.t0), 0, 1);
      m.mat.uniforms.uFill.value = k * 0.86;
      m.mat.uniforms.uTime.value = t;
      m.mat.uniforms.uAlpha.value = Math.min(1, (mt - m.t0) * 5);
      if (mt > m.land + 0.4) { m.id = -1; m.mesh.visible = false; }
    }
    this.drawAct(dt, t, mt, eye);
    R.end();
  }

  private dropWell(i: number) {
    const w = this.wells[i];
    this.group.remove(w.core, w.disk);
    (w.core.material as THREE.Material).dispose();
    (w.disk.material as THREE.Material).dispose();
    this.wells.splice(i, 1);
  }

  /** The Warden's current ability: its tell and its hazard. */
  private drawAct(dt: number, t: number, mt: number, eye: THREE.Vector3) {
    const { a, at, d } = this.act;
    const R = this.ribbons, P = this.particles;
    this.wall.visible = false;
    this.lane.visible = false;
    let beaming = false;
    switch (a) {
      case BAct.Stomp: {
        if (d.length < 3) break;
        const r = stompRing(d, mt);
        if (mt < d[2]) {
          // the tell: a ring of warning light on the floor at the reach of the wave
          const k = clamp((mt - at) / Math.max(0.1, d[2] - at), 0, 1);
          for (let i = 0; i < 48; i++) {
            const a0 = (i / 48) * Math.PI * 2, a1 = ((i + 0.6) / 48) * Math.PI * 2, rr = BOSS.STOMP.R0 + 1;
            R.seg(d[0] + Math.sin(a0) * rr, this.floorY + 0.08, d[1] + Math.cos(a0) * rr, d[0] + Math.sin(a1) * rr, this.floorY + 0.08, d[1] + Math.cos(a1) * rr, 0.25, 2.2, 0.8, 0.2, k);
          }
        } else if (r > 0) {
          if (this.stompDone !== at) { this.stompDone = at; this.onStompStart?.(d[0], d[1]); }
          this.wall.visible = true;
          this.wall.position.set(d[0], this.floorY, d[1]);
          this.wall.scale.set(r, 1, r);
          this.wallMat.uniforms.uAlpha.value = clamp(1 - (r - BOSS.STOMP.R1 * 0.7) / (BOSS.STOMP.R1 * 0.3), 0, 1);
          this.wallMat.uniforms.uTime.value = t;
          for (let i = 0; i < 6; i++) {
            const ang = Math.random() * Math.PI * 2;
            P.emit(d[0] + Math.sin(ang) * r, this.floorY + 0.1, d[1] + Math.cos(ang) * r, Math.sin(ang) * 4, 1.5 + Math.random() * 2, Math.cos(ang) * 4, 0.5, 0.35, 0.7, 0.62, 0.52, 0.55, 2, 1.5);
          }
        }
        break;
      }
      case BAct.Beam: {
        if (d.length < 9) break;
        const t0 = d[6];
        if (mt < t0) {
          // the tell: a thin aiming line where the sweep will start, brightening as the eye charges
          const k = clamp(1 - (t0 - mt) / 1.1, 0, 1);
          const yaw = d[3], pitch = d[5], cp = Math.cos(pitch);
          TMP.set(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp);
          const len = this.cast(eye, TMP, 90);
          R.seg(eye.x, eye.y, eye.z, eye.x + TMP.x * len, eye.y + TMP.y * len, eye.z + TMP.z * len, 0.07 + k * 0.06, 2.4, 0.3, 0.2, 0.25 + k * 0.6);
        } else if (beamAt(d, mt, this.floorY, V, W)) {
          beaming = true;
          TMP.set(W.x, W.y, W.z);
          const len = this.cast(eye, TMP, 90);
          this.beamEnd.copy(eye).addScaledVector(TMP, len);
          this.placeBeam(eye, this.beamEnd, len);
          // the beam burns a line across the floor
          P.emit(this.beamEnd.x, this.beamEnd.y + 0.1, this.beamEnd.z, (Math.random() - 0.5) * 6, 3 + Math.random() * 4, (Math.random() - 0.5) * 6, 0.45, 0.16, 1, 0.55, 0.25, 1, 12, 0);
          P.emit(this.beamEnd.x, this.beamEnd.y + 0.2, this.beamEnd.z, 0, 1.4, 0, 1.2, 0.5, 0.2, 0.19, 0.19, 0.5, -0.8, 1.2);
          if (this.beamLast >= 0) {
            // afterglow along the scorch
            TMP2.set(this.beamEnd.x, this.floorY + 0.06, this.beamEnd.z);
            this.streak(TMP2, TMP3.set(TMP2.x + (Math.random() - 0.5) * 0.2, TMP2.y, TMP2.z + (Math.random() - 0.5) * 0.2), 0.8, [1.6, 0.35, 0.1], 0.5);
          }
          this.beamLast = mt;
        }
        break;
      }
      case BAct.Charge: {
        if (d.length < 5) break;
        const [x, z, yaw, t0, run] = d;
        if (mt < t0 + BOSS.CHARGE.TIME) {
          this.lane.visible = true;
          this.lane.position.set(x, this.floorY + 0.05, z);
          this.lane.rotation.y = yaw;
          this.lane.scale.set(BOSS.CHARGE.WIDTH, 1, Math.max(4, run + 5));
          this.laneMat.uniforms.uLen.value = run + 5;
          this.laneMat.uniforms.uTime.value = t;
          this.laneMat.uniforms.uAlpha.value = mt < t0 ? clamp((mt - at) * 3, 0, 1) * (0.7 + Math.sin(t * 16) * 0.3) : Math.max(0, 1 - (mt - t0) * 1.2);
        }
        break;
      }
      case BAct.Swipe: {
        if (d.length < 4) break;
        const S = BOSS.SWIPE;
        const ang = swipeAt(d, mt);
        const center = this.swipeCenter;
        if (mt < d[2]) {
          // the tell: the arc it is about to sweep, faint and pulsing
          const k = clamp((mt - at) / Math.max(0.1, d[2] - at), 0, 1);
          for (let i = 0; i < 24; i++) {
            const a0 = d[0] - d[1] * 2.1 + d[1] * 4.2 * (i / 24), a1 = d[0] - d[1] * 2.1 + d[1] * 4.2 * ((i + 0.7) / 24);
            for (const rr of [S.R0 + 1, S.R1]) R.seg(center.x + Math.sin(a0) * rr, this.floorY + 5, center.z + Math.cos(a0) * rr, center.x + Math.sin(a1) * rr, this.floorY + 5, center.z + Math.cos(a1) * rr, 0.14, 2.2, 0.6, 0.2, k * (0.5 + 0.5 * Math.sin(t * 20)));
          }
        } else if (!isNaN(ang)) {
          // the blade: a sheet of light swept round by the arm, fading behind it
          for (let i = 0; i < 10; i++) {
            const a0 = ang - d[1] * i * 0.09, a1 = ang - d[1] * (i + 1) * 0.09, k = 1 - i / 10;
            for (let h = 0; h < 4; h++) {
              const y = this.floorY + S.Y0 + ((S.Y1 - S.Y0) * h) / 3;
              R.seg(center.x + Math.sin(a0) * S.R0, y, center.z + Math.cos(a0) * S.R0, center.x + Math.sin(a0) * S.R1, y, center.z + Math.cos(a0) * S.R1, 0.5, 2.4 * k, 1.2 * k, 0.4 * k, 0.5 * k);
              R.seg(center.x + Math.sin(a0) * S.R1, y, center.z + Math.cos(a0) * S.R1, center.x + Math.sin(a1) * S.R1, y, center.z + Math.cos(a1) * S.R1, 0.3, 2.4 * k, 1.2 * k, 0.4 * k, 0.6 * k);
            }
          }
        }
        break;
      }
    }
    this.beamOn = beaming;
    if (!beaming) { this.beamCore.visible = this.beamGlow.visible = this.beamHit.visible = false; }
    void dt;
  }

  /** The Warden's centre (the swipe turns about it). Set by the controller each frame. */
  readonly swipeCenter = new THREE.Vector3();

  private readonly hitTmp: RayHit = { dist: 0, c: null };
  private cast(from: THREE.Vector3, dir: THREE.Vector3, max: number): number {
    const o = from.clone().addScaledVector(dir, 1.5);
    const h = this.world.raycast(o.x, o.y, o.z, dir.x, dir.y, dir.z, max, false, this.hitTmp);
    return 1.5 + (h.c ? h.dist : max);
  }

  private placeBeam(a: THREE.Vector3, b: THREE.Vector3, len: number) {
    for (const [m, r] of [[this.beamCore, 0.16], [this.beamGlow, 0.55]] as [THREE.Mesh, number][]) {
      m.visible = true;
      m.position.copy(a);
      m.lookAt(b);
      m.scale.set(r * (0.9 + Math.random() * 0.2), r * (0.9 + Math.random() * 0.2), len);
    }
    this.beamHit.visible = true;
    this.beamHit.position.copy(b);
    this.beamHit.scale.setScalar(3 + Math.random());
  }
}

/** The afterimage silhouette, merged once. */
let ghostGeo: THREE.BufferGeometry | null = null;
function ghostMerged(): THREE.BufferGeometry {
  if (ghostGeo) return ghostGeo;
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, x: number, y: number, z: number, rx: number) => {
    g.rotateX(rx); g.translate(x, y, z);
    const q = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(q.attributes)) if (k !== 'position' && k !== 'normal') q.deleteAttribute(k);
    parts.push(q);
  };
  add(new THREE.CapsuleGeometry(0.2, 0.45, 2, 6), 0, 1.25, 0, 0.45);
  add(new THREE.SphereGeometry(0.15, 8, 6), 0, 1.72, 0.22, 0);
  add(new THREE.CapsuleGeometry(0.08, 0.6, 2, 5), 0.12, 0.62, 0.3, -0.7);
  add(new THREE.CapsuleGeometry(0.08, 0.6, 2, 5), -0.12, 0.62, -0.28, 0.7);
  add(new THREE.CapsuleGeometry(0.06, 0.5, 2, 5), 0.3, 1.25, -0.2, 1.0);
  add(new THREE.CapsuleGeometry(0.06, 0.5, 2, 5), -0.3, 1.25, 0.28, -1.0);
  ghostGeo = mergeParts(parts);
  return ghostGeo;
}

function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let n = 0;
  for (const p of parts) n += p.getAttribute('position').count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  let o = 0;
  for (const p of parts) {
    pos.set(p.getAttribute('position').array as Float32Array, o * 3);
    nor.set(p.getAttribute('normal').array as Float32Array, o * 3);
    o += p.getAttribute('position').count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return g;
}


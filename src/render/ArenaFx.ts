// Effects in the Warden's arena: the tells and hazards of its abilities, the six
// powers, explosions, bolts and wells. Everything is pooled and most of it is a
// handful of draw calls: every bolt, beam edge, tether, streak, arc and
// speedster's trail is a camera-facing ribbon in one dynamic mesh; flashes are
// one billboard batch; the angel's sword trails are one strip mesh; rings,
// markers, fireballs, wells, sonic waves and afterimages are small pools.
//
// Sonic force is drawn as the force itself travelling: rings that race out
// along the cone at the wave's own speed and widen with it, a shimmering shell
// of disturbed air behind the front, grit and dust thrown off the floor it
// passes over, and an impact ring wherever the front strikes something.
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
const UP = new THREE.Vector3(0, 1, 0), Z_AXIS = new THREE.Vector3(0, 0, 1);
const lerpN = (a: number, b: number, u: number) => a + (b - a) * u;
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

// ------------------------------------------------------------------ rings, fireballs, wells, sonic waves

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
// a sonic ring: a bright rippling band, its inside wavering like air bent by a blast
const sonicRingFragment = /* glsl */ `
  uniform float uTime, uK, uSeed;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    float a = atan(p.y, p.x);
    float wob = 0.03 * sin(a * 9.0 + uTime * 23.0 + uSeed) + 0.02 * sin(a * 17.0 - uTime * 31.0);
    float rr = r + wob;
    float band = smoothstep(0.8, 0.93, rr) * smoothstep(1.0, 0.95, rr);
    float inner = smoothstep(0.35, 0.9, rr) * step(rr, 0.94) * (0.5 + 0.5 * sin(rr * 40.0 - uTime * 50.0)) * 0.12;
    vec3 col = mix(vec3(0.45, 1.35, 1.15), vec3(1.2, 1.95, 1.7), band);
    gl_FragColor = vec4(col, (band * 0.85 + inner) * uK);
  }`;
// the disturbed air behind a blast's front: a shimmering cone shell, ripples running out along it
const coneVertex = /* glsl */ `varying vec2 vUv; varying float vRim; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vec3 n = normalize(normalMatrix * normal); vRim = 1.0 - abs(dot(n, normalize(-mv.xyz))); gl_Position = projectionMatrix * mv; }`;
const coneFragment = /* glsl */ `
  uniform float uTime, uK, uLen;
  varying vec2 vUv; varying float vRim;
  void main() {
    float along = vUv.y;
    float ripple = 0.5 + 0.5 * sin((along * uLen) * 1.6 - uTime * 60.0 + sin(vUv.x * 40.0 + uTime * 9.0) * 0.6);
    float front = smoothstep(0.7, 1.0, along);
    float fade = smoothstep(0.0, 0.25, along);
    float a = (ripple * 0.22 + front * 0.45) * fade * (0.3 + vRim * 0.9);
    gl_FragColor = vec4(mix(vec3(0.4, 1.2, 1.05), vec3(1.1, 1.8, 1.6), front), a * uK);
  }`;
// the boom's dome: a bubble of force, brightest at its rim
const domeFragment = /* glsl */ `
  uniform float uTime, uK;
  varying vec2 vUv; varying float vRim;
  void main() {
    float bands = 0.5 + 0.5 * sin(vUv.y * 60.0 - uTime * 40.0);
    gl_FragColor = vec4(vec3(0.8, 1.8, 1.55) * (0.6 + bands * 0.4), pow(vRim, 2.5) * uK);
  }`;
// the angel's sword trail: a strip of light, hottest along the blade's edge
const trailVertex = /* glsl */ `attribute vec4 color; varying vec4 vC; void main(){ vC = color; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const trailFragment = /* glsl */ `varying vec4 vC; void main(){ gl_FragColor = vC; }`;

interface Fireball { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; age: number; life: number; r: number }
interface WellVis { id: number; core: THREE.Mesh; disk: THREE.Mesh; field: Ring | null; pos: THREE.Vector3; vel: THREE.Vector3; t0: number; open: boolean; k: number; closing: number; follow: THREE.Vector3 | null; mine: boolean }
interface SonicRing { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; age: number; life: number; delay: number; from: THREE.Vector3; dir: THREE.Vector3; speed: number; range: number; slope: number; flat: boolean }
interface SonicCone { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; age: number; from: THREE.Vector3; dir: THREE.Vector3 }
interface Dome { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; age: number; r: number }
/** An angel's sword trail this frame: where the blade's base and tip were, newest first, and how long ago. */
export interface SwordTrail { base: THREE.Vector3[]; tip: THREE.Vector3[]; ages: number[] }
const SWORD_LIFE = 0.16;
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
  private readonly sonicRings: SonicRing[] = [];
  private readonly cones: SonicCone[] = [];
  private readonly domes: Dome[] = [];
  private swordTrails: SwordTrail[] = [];
  private readonly swordMesh: THREE.Mesh;
  private readonly swordPos: Float32Array;
  private readonly swordCol: Float32Array;
  private readonly bolts: Bolt[] = [];
  private readonly streaks: Streak[] = [];
  private readonly markers: Marker[] = [];
  private readonly ghosts: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; age: number; life: number }[] = [];
  /** Speedsters' trails this frame (set by the controller, drawn in update). */
  private trails: { pts: THREE.Vector3[]; ages: number[]; cut?: boolean[]; color: [number, number, number] }[] = [];
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
    // sonic force: racing rings, the cone of disturbed air behind a blast's front, the boom's dome
    for (let i = 0; i < 24; i++) {
      const mat = new THREE.ShaderMaterial({ vertexShader: flatVertex, fragmentShader: sonicRingFragment, uniforms: { uTime: { value: 0 }, uK: { value: 0 }, uSeed: { value: i * 1.7 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false });
      const mesh = new THREE.Mesh(this.ringGeo, mat);
      mesh.visible = false;
      mesh.renderOrder = 10;
      this.group.add(mesh);
      this.sonicRings.push({ mesh, mat, age: 1, life: 1, delay: 0, from: new THREE.Vector3(), dir: new THREE.Vector3(), speed: 0, range: 0, slope: 0, flat: false });
    }
    const cg = new THREE.CylinderGeometry(1, 0, 1, 28, 6, true);
    cg.rotateX(Math.PI / 2); cg.translate(0, 0, 0.5);
    for (let i = 0; i < 4; i++) {
      const mat = new THREE.ShaderMaterial({ vertexShader: coneVertex, fragmentShader: coneFragment, uniforms: { uTime: { value: 0 }, uK: { value: 0 }, uLen: { value: 1 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false });
      const mesh = new THREE.Mesh(cg, mat);
      mesh.visible = false;
      mesh.renderOrder = 9;
      this.group.add(mesh);
      this.cones.push({ mesh, mat, age: 1, from: new THREE.Vector3(), dir: new THREE.Vector3() });
    }
    for (let i = 0; i < 3; i++) {
      const mat = new THREE.ShaderMaterial({ vertexShader: coneVertex, fragmentShader: domeFragment, uniforms: { uTime: { value: 0 }, uK: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), mat);
      mesh.visible = false;
      mesh.renderOrder = 9;
      this.group.add(mesh);
      this.domes.push({ mesh, mat, age: 1, r: 1 });
    }
    // the angels' sword trails: one strip mesh for all of them
    const MAXQ = 4 * 20;
    this.swordPos = new Float32Array(MAXQ * 6 * 3);
    this.swordCol = new Float32Array(MAXQ * 6 * 4);
    const sg2 = new THREE.BufferGeometry();
    sg2.setAttribute('position', new THREE.BufferAttribute(this.swordPos, 3).setUsage(THREE.DynamicDrawUsage));
    sg2.setAttribute('color', new THREE.BufferAttribute(this.swordCol, 4).setUsage(THREE.DynamicDrawUsage));
    this.swordMesh = new THREE.Mesh(sg2, new THREE.ShaderMaterial({ vertexShader: trailVertex, fragmentShader: trailFragment, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }));
    this.swordMesh.frustumCulled = false;
    this.swordMesh.renderOrder = 12;
    this.group.add(this.swordMesh);
    // afterimages (the flash strike, and a speedster running flat out)
    const gg = ghostMerged();
    for (let i = 0; i < 28; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.3, 0.5), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      const mesh = new THREE.Mesh(gg, mat);
      mesh.visible = false;
      this.group.add(mesh);
      this.ghosts.push({ mesh, mat, age: 1, life: 0.38 });
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
      const g = this.ghosts.reduce((x, y) => (y.age / y.life > x.age / x.life ? y : x));
      g.age = -i * 0.018; g.life = 0.38;
      g.mat.color.setRGB(1.6, 1.3, 0.5);
      g.mesh.scale.setScalar(1);
      g.mesh.position.lerpVectors(a, b, (i + 0.5) / n);
      g.mesh.rotation.set(pitch * 0.5, yaw, 0, 'YXZ');
      g.mesh.visible = true;
    }
    this.streak(TMP2.copy(a).setY(a.y + 1.1), TMP3.copy(b).setY(b.y + 1.1), 0.3, [2.4, 2.0, 0.8], 0.9);
    this.streak(TMP2.copy(a).setY(a.y + 1.1), TMP3.copy(b).setY(b.y + 1.1), 0.18, [3, 3, 2.4], 0.25);
    this.ring(TMP2.copy(a).setY(a.y + 1), 0.4, 2.6, 0.3, new THREE.Color(2.2, 1.9, 1.0), 0.25, 1, d);
    this.particles.burst(b.x, b.y + 0.5, b.z, 16, 6, 0.4, 0.2, [1, 0.85, 0.4], 0.9, 6, 1);
  }

  /** An afterimage of a runner at `p` turned to `yaw` (a speedster's wake). */
  afterimage(p: THREE.Vector3, yaw: number, color: [number, number, number], life = 0.34, scale = 1) {
    const g = this.ghosts.reduce((x, y) => (y.age / y.life > x.age / x.life ? y : x));
    g.age = 0; g.life = life;
    g.mesh.position.copy(p);
    g.mesh.rotation.set(0.25, yaw, 0, 'YXZ');
    g.mesh.scale.setScalar(scale);
    g.mat.color.setRGB(color[0], color[1], color[2]);
    g.mesh.visible = true;
  }

  /** Speedsters' trails to draw this frame: points from newest to oldest, their ages (s), and where the trail broke off (a stretch not to draw). */
  setTrails(list: { pts: THREE.Vector3[]; ages: number[]; cut?: boolean[]; color: [number, number, number] }[]) { this.trails = list; }

  // ------------------------------------------------------------------ the angel

  /** Feathers shed into the air at `p`, drifting down (a wingbeat, a soar, a dive). */
  feathers(p: THREE.Vector3, n: number, spread: number, up = 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * spread;
      this.particles.emit(p.x + Math.cos(a) * r, p.y + (Math.random() - 0.3) * spread * 0.6, p.z + Math.sin(a) * r,
        Math.cos(a) * (1 + Math.random() * 3), (Math.random() * 2 - 0.5) * up, Math.sin(a) * (1 + Math.random() * 3),
        1.1 + Math.random() * 0.9, 0.09 + Math.random() * 0.05, 1, 0.97, 0.88, 0.85, 1.1, 0.02);
    }
  }

  /**
   * A sword cut in front of `p` (the chest) along `d` (flat): a crescent of light
   * drawn along the arc the cut sweeps (0 a rising cut, 1 a reverse cut, 2 the
   * whirl, 3 the cleave), and sparks where it lands.
   */
  slash(p: THREE.Vector3, d: THREE.Vector3, combo: number, hit: boolean) {
    const rx = d.z, rz = -d.x; // the runner's right
    const reach = combo === 3 ? POW.angel.CLEAVE_REACH : POW.angel.REACH;
    const n = 16;
    // the arc as angles across the front, and the height it climbs (or falls) through
    const [a0, a1, y0, y1, r0] = combo === 0 ? [0.95, -0.95, -0.7, 0.8, 0.8] : combo === 1 ? [-0.95, 0.95, 0.8, -0.6, 0.8] : combo === 2 ? [Math.PI, -Math.PI, 0, 0, 0.9] : [0, 0, 1.9, -0.9, 0.6];
    let px = 0, py = 0, pz = 0;
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      let x: number, y: number, z: number;
      if (combo === 3) {
        // the cleave: a vertical arc from over the head down in front
        const ang = lerpN(-0.4, 1.9, u), rr = reach * 0.85;
        x = p.x + d.x * Math.sin(ang) * rr; z = p.z + d.z * Math.sin(ang) * rr; y = p.y + Math.cos(ang) * rr * 0.9 - 0.2;
      } else {
        const ang = lerpN(a0, a1, u), rr = reach * r0;
        x = p.x + (d.x * Math.cos(ang) + rx * Math.sin(ang)) * rr;
        z = p.z + (d.z * Math.cos(ang) + rz * Math.sin(ang)) * rr;
        y = p.y + lerpN(y0, y1, u);
      }
      if (i > 0) {
        const k = Math.sin(u * Math.PI);
        this.streaks.push({ a: new THREE.Vector3(px, py, pz), b: new THREE.Vector3(x, y, z), age: -u * 0.06, life: 0.22, color: [2.6, 2.1, 1.1], w: 0.55 * k + 0.08 });
        this.streaks.push({ a: new THREE.Vector3(px, py, pz), b: new THREE.Vector3(x, y, z), age: -u * 0.06, life: 0.16, color: [3, 3, 2.6], w: 0.14 * k + 0.03 });
      }
      px = x; py = y; pz = z;
    }
    const at = TMP.copy(p).addScaledVector(d, reach * 0.7);
    this.flash(at, hit ? 3.2 : 1.6, 0xffe6a8, 0.14);
    if (hit) this.particles.burst(at.x, at.y, at.z, 22, 9, 0.3, 0.12, [1, 0.9, 0.6], 1, 10, 1);
    if (combo === 2) this.ring(TMP2.set(p.x, p.y - 1.1, p.z), 0.6, reach * 1.1, 0.35, new THREE.Color(2.2, 1.9, 1.1), 0.3, 0.7);
  }

  /** The soar: one great wingbeat blasting the floor, feathers everywhere, a column of light. */
  soar(p: THREE.Vector3) {
    const R = POW.angel.SOAR_RADIUS;
    this.ring(TMP.set(p.x, p.y + 0.08, p.z), 0.6, R * 1.2, 0.5, new THREE.Color(2.2, 1.95, 1.3), 0.4, 0.9);
    this.ring(TMP.set(p.x, p.y + 0.15, p.z), 0.3, R * 0.75, 0.35, new THREE.Color(2.8, 2.5, 1.8), 0.25, 1);
    this.flash(TMP.set(p.x, p.y + 1.2, p.z), 6, 0xfff0c8, 0.3);
    this.streak(TMP.set(p.x, p.y, p.z), TMP2.set(p.x, p.y + 9, p.z), 0.35, [2.4, 2.1, 1.3], 1.6);
    this.feathers(TMP.set(p.x, p.y + 1.4, p.z), 34, 1.6, 2);
    this.particles.dust(p.x, p.y, p.z, 0.8);
    // the floor's dust blown out flat
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2, s = 9 + Math.random() * 6;
      this.particles.emit(p.x + Math.cos(a) * 0.8, p.y + 0.2, p.z + Math.sin(a) * 0.8, Math.cos(a) * s, 0.8 + Math.random(), Math.sin(a) * s, 0.55, 0.3, 0.62, 0.58, 0.52, 0.5, 2, 1.4);
    }
  }

  /** A dive lands: a burst of light and feathers that grows with the speed of the dive. */
  dive(p: THREE.Vector3, speed: number) {
    const k = clamp(speed / POW.angel.DIVE_SPEED, 0.4, 1.2), R = POW.angel.DIVE_RADIUS;
    this.flash(TMP.copy(p).setY(p.y + 0.8), 7 * k, 0xfff0c8, 0.3);
    this.ring(TMP.copy(p).setY(p.y + 0.08), 0.5, R * 1.2, 0.5, new THREE.Color(2.6, 2.1, 1.2), 0.3);
    this.ring(TMP.copy(p).setY(p.y + 0.12), 0.3, R * 0.7, 0.32, new THREE.Color(3, 2.7, 1.9), 0.45);
    this.ring(TMP.copy(p).setY(p.y + 1), 0.4, R * 0.9, 0.3, new THREE.Color(2.2, 1.9, 1.2), 0.3, 0.8, TMP2.set(0, 1, 0));
    this.streak(TMP.copy(p), TMP2.copy(p).setY(p.y + 7 * k), 0.3, [2.6, 2.2, 1.3], 1.1);
    this.particles.dust(p.x, p.y, p.z, 1);
    this.particles.burst(p.x, p.y + 0.3, p.z, Math.round(36 * k), 11, 0.8, 0.2, [0.62, 0.58, 0.52], 0.9, 18, 5);
    this.particles.burst(p.x, p.y + 0.5, p.z, 26, 9, 0.45, 0.14, [1, 0.92, 0.65], 1, 8, 4);
    this.feathers(TMP.copy(p).setY(p.y + 1.2), 20, 1.2, 2.5);
  }

  /** The angels' sword trails to draw this frame. */
  setSwordTrails(list: SwordTrail[]) { this.swordTrails = list; }

  // ------------------------------------------------------------------ sonic force

  /**
   * A sonic blast from `p` along `d` (or, `boom`, a ring of force all round):
   * rings racing out at the wave's own speed, the cone of disturbed air behind
   * the front, dust and grit thrown off the floor it passes over.
   */
  sonic(p: THREE.Vector3, d: THREE.Vector3, boom: boolean) {
    const S = POW.sonic;
    if (boom) {
      const floor = this.floorBelow(p, 3);
      for (let i = 0; i < 3; i++) this.sonicRing(TMP.set(p.x, i === 0 ? floor + 0.12 : p.y - 0.4 + i * 0.5, p.z), UP, S.BOOM_SPEED * (1 - i * 0.12), S.BOOM_RADIUS * (1.05 - i * 0.1), 0, true, i * 0.03);
      const dm = this.domes.reduce((a, b) => (b.age > a.age ? b : a));
      dm.age = 0; dm.r = S.BOOM_RADIUS;
      dm.mesh.position.set(p.x, floor, p.z);
      dm.mesh.visible = true;
      this.flash(p, 9, 0xb0ffe8, 0.28);
      // everything on the floor round it blown out flat
      for (let i = 0; i < 60; i++) {
        const a = Math.random() * Math.PI * 2, s = 14 + Math.random() * 12, r = 0.5 + Math.random();
        this.particles.emit(p.x + Math.cos(a) * r, floor + 0.15 + Math.random() * 0.4, p.z + Math.sin(a) * r, Math.cos(a) * s, 1 + Math.random() * 2, Math.sin(a) * s, 0.45, 0.28, 0.6, 0.58, 0.54, 0.6, 3, 1.5);
      }
      this.particles.burst(p.x, p.y, p.z, 30, 10, 0.35, 0.12, [0.7, 1, 0.9], 1, 0, 0);
      return;
    }
    const slope = Math.tan(S.CONE);
    // the rings: one right at the hands, the rest racing out after it
    for (let i = 0; i < 5; i++) this.sonicRing(p, d, S.SPEED * (1 - i * 0.07), S.RANGE, slope, false, i * 0.035);
    const c = this.cones.reduce((a, b) => (b.age > a.age ? b : a));
    c.age = 0; c.from.copy(p); c.dir.copy(d);
    c.mesh.position.copy(p);
    c.mesh.quaternion.setFromUnitVectors(Z_AXIS, d);
    c.mesh.visible = true;
    this.flash(TMP.copy(p).addScaledVector(d, 0.8), 3.2, 0xc8fff0, 0.16);
    this.ring(TMP.copy(p).addScaledVector(d, 0.9), 0.2, 1.4, 0.2, new THREE.Color(1.6, 2.2, 2), 0.3, 1, d);
    // grit and dust off the floor along the cone, blown on ahead of it
    for (let i = 1; i <= 9; i++) {
      const along = i * 2.1;
      TMP.copy(p).addScaledVector(d, along);
      const floor = this.floorBelow(TMP, 5);
      if (!isFinite(floor) || TMP.y - floor > along * slope + 1.5) continue;
      const w = along * slope;
      for (let j = 0; j < 4; j++) {
        const s = (Math.random() - 0.5) * 2 * w, sp = 16 + Math.random() * 14;
        this.particles.emit(TMP.x + d.z * s, floor + 0.15, TMP.z - d.x * s, d.x * sp + (Math.random() - 0.5) * 3, 1 + Math.random() * 3, d.z * sp + (Math.random() - 0.5) * 3, 0.5, 0.26, 0.6, 0.57, 0.53, 0.55, 4, 1.2);
      }
    }
    // a few motes of air caught in it
    for (let i = 0; i < 18; i++) {
      const s = 30 + Math.random() * 30;
      const jx = (Math.random() - 0.5) * slope * 2, jy = (Math.random() - 0.5) * slope * 2, jz = (Math.random() - 0.5) * slope * 2;
      this.particles.emit(p.x, p.y, p.z, (d.x + jx) * s, (d.y + jy) * s, (d.z + jz) * s, 0.3, 0.1, 0.75, 1, 0.92, 0.8, 0, 0.3);
    }
  }

  private sonicRing(p: THREE.Vector3, d: THREE.Vector3, speed: number, range: number, slope: number, flat: boolean, delay: number) {
    const r = this.sonicRings.reduce((a, b) => (b.age / b.life > a.age / a.life ? b : a));
    r.age = -delay; r.life = range / speed + 0.08; r.delay = delay;
    r.from.copy(p); r.dir.copy(d); r.speed = speed; r.range = range; r.slope = slope; r.flat = flat;
    r.mesh.quaternion.setFromUnitVectors(Z_AXIS, d);
    r.mesh.visible = false;
  }

  /** Where a sonic wave's front struck something: an impact ring facing the blast, a flash, what it knocked off. kind: 0 the Warden, 1 a bot, 2 a loose thing. */
  impact(p: THREE.Vector3, dx: number, dz: number, kind: number, k: number) {
    const dir = TMP2.set(dx, 0, dz);
    if (dir.lengthSq() < 1e-4) dir.set(0, 0, 1);
    dir.normalize();
    const big = kind === 0;
    this.ring(p, 0.3, (big ? 4.2 : 2.2) * (0.6 + k * 0.4), big ? 0.35 : 0.25, new THREE.Color(1.3, 2.2, 1.9), big ? 0.5 : 0.3, 1, dir);
    this.ring(TMP.copy(p).addScaledVector(dir, 0.6), 0.2, (big ? 2.6 : 1.4), 0.2, new THREE.Color(2.2, 2.4, 2.3), 0.2, 0.8, dir);
    this.flash(p, big ? 5 : 2.6, 0xc8fff0, 0.14);
    const n = big ? 26 : 12;
    for (let i = 0; i < n; i++) {
      const s = (big ? 8 : 6) + Math.random() * 8;
      this.particles.emit(p.x, p.y, p.z, dir.x * s + (Math.random() - 0.5) * 6, (Math.random() - 0.2) * 5, dir.z * s + (Math.random() - 0.5) * 6, 0.35, 0.12, big ? 1 : 0.8, big ? 0.85 : 1, big ? 0.6 : 0.9, 1, 10, 0);
    }
  }

  private readonly downHit: RayHit = { dist: 0, c: null };
  /** The top of whatever is under `p` (within `max` metres), or -Infinity. */
  private floorBelow(p: THREE.Vector3, max: number): number {
    const h = this.world.raycast(p.x, p.y + 0.2, p.z, 0, -1, 0, max + 0.2, false, this.downHit);
    return h.c ? p.y + 0.2 - h.dist : -Infinity;
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
    // sonic rings race out along their cone (or flat, all round), widening as they go
    for (const r of this.sonicRings) {
      if (r.age >= r.life) continue;
      r.age += dt;
      if (r.age < 0) { r.mesh.visible = false; continue; }
      if (r.age >= r.life) { r.mesh.visible = false; continue; }
      const dist = Math.min(r.range, r.age * r.speed), k = dist / r.range;
      r.mesh.visible = true;
      if (r.flat) {
        r.mesh.position.copy(r.from);
        r.mesh.scale.setScalar(Math.max(0.2, dist));
      } else {
        r.mesh.position.copy(r.from).addScaledVector(r.dir, dist);
        r.mesh.scale.setScalar(0.35 + dist * r.slope);
      }
      r.mat.uniforms.uK.value = (1 - k * k) * Math.min(1, r.age * 30) * (r.flat ? 1.1 : 0.85);
      r.mat.uniforms.uTime.value = t;
    }
    for (const c of this.cones) {
      if (!c.mesh.visible) continue;
      c.age += dt;
      const S = POW.sonic, len = Math.min(S.RANGE, c.age * S.SPEED), k = c.age / (S.RANGE / S.SPEED + 0.15);
      if (k >= 1) { c.mesh.visible = false; continue; }
      const w = Math.max(0.2, len * Math.tan(S.CONE));
      c.mesh.scale.set(w, w, Math.max(0.5, len));
      c.mat.uniforms.uK.value = 1 - k * k;
      c.mat.uniforms.uLen.value = len;
      c.mat.uniforms.uTime.value = t;
    }
    for (const dm of this.domes) {
      if (!dm.mesh.visible) continue;
      dm.age += dt;
      const S = POW.sonic, k = dm.age / (S.BOOM_RADIUS / S.BOOM_SPEED + 0.25);
      if (k >= 1) { dm.mesh.visible = false; continue; }
      const r = Math.min(dm.r, dm.age * S.BOOM_SPEED + 0.5);
      dm.mesh.scale.set(r, r * 0.55, r);
      dm.mat.uniforms.uK.value = (1 - k) * 0.9;
      dm.mat.uniforms.uTime.value = t;
    }
    for (const g of this.ghosts) {
      if (!g.mesh.visible) continue;
      g.age += dt;
      if (g.age < 0) { g.mat.opacity = 0; continue; }
      const k = g.age / g.life;
      if (k >= 1) { g.mesh.visible = false; continue; }
      g.mat.opacity = (1 - k) * 0.55;
    }
    // speedsters' trails: a long burning ribbon of light at chest height over a glow along the
    // ground (the band that burns what touches it), thinning and fading as it ages, crackling
    const life = POW.speed.TRAIL_LIFE;
    for (const tr of this.trails) {
      const pts = tr.pts, ages = tr.ages, c = tr.color;
      for (let i = 1; i < pts.length; i++) {
        if (tr.cut?.[i - 1]) continue;
        const a0 = Math.max(0, 1 - ages[i - 1] / life), a1 = Math.max(0, 1 - ages[i] / life);
        if (a1 <= 0) break;
        const w = 0.5 * a0 + 0.12, p0 = pts[i - 1], p1 = pts[i];
        const fl = 0.85 + Math.sin(t * 23 + i * 0.7) * 0.15;
        R.seg(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, w * 3.2, c[0] * 0.3, c[1] * 0.25, c[2] * 0.15, a1 * 0.35 * fl);
        R.seg(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, w * 0.8, c[0], c[1], c[2], a1 * fl);
        R.seg(p0.x, p0.y - 0.95, p0.z, p1.x, p1.y - 0.95, p1.z, w * 1.6, c[0] * 0.5, c[1] * 0.35, c[2] * 0.15, a1 * 0.45);
      }
      for (let n = 0; n < 3 && pts.length > 3; n++) {
        if (Math.random() > 0.5) continue;
        const i = 1 + Math.floor(Math.random() * (pts.length - 2));
        if (ages[i] > life * 0.8) continue;
        R.jag(TMP.copy(pts[i - 1]).setY(pts[i - 1].y - 0.9), TMP2.copy(pts[Math.min(pts.length - 1, i + 1)]).setY(pts[i].y + 0.5), 5, 0.6, 0.07, c[0] * 1.2, c[1] * 1.2, c[2] * 1.4, 0.9);
        if (Math.random() < 0.3) P.emit(pts[i].x, pts[i].y - 0.8 + Math.random() * 1.6, pts[i].z, (Math.random() - 0.5) * 2, 1 + Math.random() * 2, (Math.random() - 0.5) * 2, 0.4, 0.1, 1, 0.85, 0.35, 1, -1, -0.1);
      }
    }
    this.trails = [];
    // the angels' sword trails: a strip between where the blade's base and tip have been
    let q = 0;
    const SP = this.swordPos, SC = this.swordCol, MAXQ = SP.length / 18;
    const put = (o: number, v: THREE.Vector3, r: number, g: number, b: number, al: number) => { SP[o * 3] = v.x; SP[o * 3 + 1] = v.y; SP[o * 3 + 2] = v.z; SC[o * 4] = r; SC[o * 4 + 1] = g; SC[o * 4 + 2] = b; SC[o * 4 + 3] = al; };
    for (const st of this.swordTrails) {
      for (let i = 1; i < st.base.length && q < MAXQ; i++) {
        const a0 = Math.max(0, 1 - st.ages[i - 1] / SWORD_LIFE), a1 = Math.max(0, 1 - st.ages[i] / SWORD_LIFE);
        if (a0 <= 0) break;
        const o = q * 6;
        // the edge (the tip) burns white-gold, fading toward the hilt and with age
        put(o, st.base[i - 1], 0.9, 0.7, 0.35, a0 * 0.15); put(o + 1, st.tip[i - 1], 2.6, 2.3, 1.5, a0 * 0.9); put(o + 2, st.base[i], 0.9, 0.7, 0.35, a1 * 0.15);
        put(o + 3, st.base[i], 0.9, 0.7, 0.35, a1 * 0.15); put(o + 4, st.tip[i - 1], 2.6, 2.3, 1.5, a0 * 0.9); put(o + 5, st.tip[i], 2.6, 2.3, 1.5, a1 * 0.9);
        q++;
      }
    }
    const sg = this.swordMesh.geometry;
    sg.setDrawRange(0, q * 6);
    (sg.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (sg.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    this.swordMesh.visible = q > 0;
    this.swordTrails = [];
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


// The white room behind the portal: an endless-looking hall of light where
// Viktor waits. A pale, softly glossy floor with gold inlay rings radiating from
// his dais, a double colonnade dissolving into white haze, shafts of warm light
// falling from nowhere, mist drifting across the floor and motes of gold rising
// through the air. There are no walls; the fog swallows the distance.
//
// It is its own scene (own lights, fog and sky) and its own little collision
// world, far away from the course, so nothing on the course can reach into it.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rng } from '../../shared/math';
import type { BoxDef, LevelData, V3 } from '../../shared/level/types';
import { CollisionWorld } from '../../shared/physics/world';
import { Billboards } from './Billboards';
import { PortalView } from './PortalView';
import { ViktorModel } from './ViktorModel';

/** Where the room is: far from the course, and high above its height fog. */
export const HEAVEN = { x: 0, y: 200, z: -3000 };
/** You arrive this far from Viktor, facing him. */
export const HEAVEN_ARRIVE = 17;
/** Past this distance from Viktor a gentle current carries you back toward him. */
export const HEAVEN_RADIUS = 62;
const FOG = new THREE.Color(0xf3ede2);
const DAIS_R = [3.4, 2.5];
const DAIS_STEP = 0.17;
/** The doorway stands this far behind where you arrive, facing Viktor. */
export const DOOR_BEHIND = 1.3;

/** The room's floor, dais, Viktor and columns as colliders (a tiny level of its own). */
function heavenLevel(columns: [number, number][]): LevelData {
  const boxes: BoxDef[] = [];
  const add = (p: V3, s: V3, ry = 0) => boxes.push({ id: boxes.length, p, s, ry, mat: 'invisible', kind: 'static', solid: true, visible: false, blocksSight: false });
  const { x, y, z } = HEAVEN;
  add([x, y - 0.5, z], [320, 1, 320]);
  // the round dais in two steps, each a star of rotated squares
  DAIS_R.forEach((r, i) => {
    const h = DAIS_STEP * (i + 1);
    for (let k = 0; k < 4; k++) add([x, y + h / 2, z], [r * 1.72, h, r * 1.72], (k * Math.PI) / 8);
  });
  // Viktor himself: you cannot walk through him
  add([x, y + DAIS_STEP * 2 + 0.95, z], [0.62, 1.9, 0.42]);
  for (const [cx, cz] of columns) add([x + cx, y + 13, z + cz], [2.6, 26, 2.6]);
  return {
    name: 'heaven', boxes, props: [], enemies: [], winds: [], zones: [], spawns: [[x, y, z + HEAVEN_ARRIVE]], spawnYaw: Math.PI,
    finish: { min: [0, -1e4, 0], max: [0, -1e4, 0] }, beacon: [x, y, z], killY: y - 100,
    bounds: { min: [x - 160, z - 160], max: [x + 160, z + 160] }, waypoints: [], ziplines: [], lasers: [], hints: [], grapples: [], pickups: [],
  };
}

const skyVertex = /* glsl */ `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix*vec4(position,1.0); gl_Position = projectionMatrix*p; gl_Position.z = gl_Position.w; }`;
const skyFragment = /* glsl */ `
  uniform vec3 uHorizon, uZenith, uGlow;
  varying vec3 vDir;
  void main(){
    vec3 d = normalize(vDir);
    float h = clamp(d.y, -1.0, 1.0);
    vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.8));
    // light pours from high above, a little behind Viktor
    float g = max(dot(d, normalize(vec3(0.0, 0.85, -0.5))), 0.0);
    col += uGlow * (pow(g, 12.0) * 0.8 + pow(g, 3.0) * 0.18);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

const shaftVertex = /* glsl */ `
  varying float vY;
  varying vec3 vN, vV;
  void main() {
    vY = uv.y;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;
const shaftFragment = /* glsl */ `
  uniform float uTime, uAlpha, uSeed;
  varying float vY;
  varying vec3 vN, vV;
  void main() {
    float face = pow(abs(dot(vN, vV)), 2.2);
    float fade = smoothstep(0.0, 0.25, vY) * smoothstep(1.0, 0.55, vY);
    float drift = 0.75 + 0.25 * sin(vY * 9.0 + uTime * 0.7 + uSeed * 6.0);
    gl_FragColor = vec4(vec3(1.0, 0.93, 0.78), face * fade * drift * uAlpha);
  }`;

/** Gold inlay rings and rays on the floor around the dais (a canvas decal). */
function inlayTexture(): THREE.Texture {
  const S = 1024, c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  const m = S / 2;
  ctx.strokeStyle = 'rgba(214,170,78,0.9)';
  const rings = [0.2, 0.235, 0.42, 0.62, 0.64, 0.86];
  rings.forEach((r, i) => { ctx.lineWidth = i % 3 === 1 ? 2 : 5; ctx.beginPath(); ctx.arc(m, m, r * m, 0, Math.PI * 2); ctx.stroke(); });
  // rays between the rings, like a compass rose of light
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2, r0 = (i % 2 ? 0.44 : 0.25) * m, r1 = (i % 2 ? 0.6 : 0.84) * m;
    ctx.lineWidth = i % 2 ? 2 : 4;
    ctx.beginPath(); ctx.moveTo(m + Math.cos(a) * r0, m + Math.sin(a) * r0); ctx.lineTo(m + Math.cos(a) * r1, m + Math.sin(a) * r1); ctx.stroke();
  }
  // small diamonds on the outer ring
  ctx.fillStyle = 'rgba(214,170,78,0.9)';
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + Math.PI / 12, r = 0.75 * m;
    ctx.save(); ctx.translate(m + Math.cos(a) * r, m + Math.sin(a) * r); ctx.rotate(a);
    ctx.beginPath(); ctx.moveTo(-14, 0); ctx.lineTo(0, -7); ctx.lineTo(14, 0); ctx.lineTo(0, 7); ctx.closePath(); ctx.fill(); ctx.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Soft, broken marble veining for the floor and the dais. */
function marbleTexture(): THREE.Texture {
  const S = 512, c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#f4f1ea'; ctx.fillRect(0, 0, S, S);
  const r = rng(77);
  for (let i = 0; i < 22; i++) {
    let x = r() * S, y = r() * S;
    ctx.strokeStyle = `rgba(190,180,165,${0.05 + r() * 0.08})`;
    ctx.lineWidth = 0.6 + r() * 1.6;
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let k = 0; k < 9; k++) { x += (r() - 0.5) * 70; y += (r() - 0.3) * 50; ctx.lineTo(x, y); }
    ctx.stroke();
  }
  // big faint slab joints
  ctx.strokeStyle = 'rgba(200,190,176,0.35)'; ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, S - 2, S - 2);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** A classical column: fluted shaft, round base and capital, merged into one geometry. */
function columnGeometry(): THREE.BufferGeometry {
  const shaft = new THREE.CylinderGeometry(1.0, 1.1, 22, 32, 8, true);
  const pos = shaft.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const a = Math.atan2(z, x);
    const k = 1 - 0.045 * Math.pow(Math.abs(Math.cos(a * 10)), 0.5); // twenty flutes
    pos.setX(i, x * k); pos.setZ(i, z * k);
  }
  shaft.computeVertexNormals();
  shaft.translate(0, 13, 0);
  const lathe = (pts: [number, number][]) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), 32);
  const base = lathe([[0, 0], [1.55, 0], [1.55, 0.45], [1.35, 0.6], [1.4, 0.9], [1.15, 1.1], [1.12, 2.0], [0, 2.0]]);
  const cap = lathe([[0, 24], [1.02, 24], [1.2, 24.35], [1.1, 24.6], [1.5, 25.1], [1.7, 25.4], [1.7, 26], [0, 26]]);
  const g = mergeGeometries([shaft.toNonIndexed(), base.toNonIndexed(), cap.toNonIndexed()].map((q) => { for (const k of Object.keys(q.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') q.deleteAttribute(k); return q; }), false)!;
  return g;
}

export class HeavenView {
  readonly scene = new THREE.Scene();
  readonly world: CollisionWorld;
  readonly viktor: ViktorModel;
  /** Where Viktor stands (feet) and where you arrive (feet), facing him. */
  readonly viktorPos = new THREE.Vector3(HEAVEN.x, HEAVEN.y + DAIS_STEP * 2, HEAVEN.z);
  readonly arrivePos = new THREE.Vector3(HEAVEN.x, HEAVEN.y, HEAVEN.z + HEAVEN_ARRIVE);
  readonly arriveYaw = Math.PI;
  /** The doorway you come through, behind where you arrive. */
  readonly door: PortalView;
  private readonly key: THREE.DirectionalLight;
  private readonly shafts: THREE.ShaderMaterial[] = [];
  private readonly mist: Billboards;
  private readonly mistPuffs: { i: number; x: number; z: number; y: number; w: number; h: number; a: number; s: number }[] = [];
  private readonly motes: THREE.Points;
  private readonly moteMat: THREE.ShaderMaterial;
  /** Sparks that spiral up around you as the gift is given. */
  private readonly giftMat: THREE.ShaderMaterial;
  private readonly inlay: THREE.Mesh;

  constructor(glowTex: THREE.Texture, cloudTex: THREE.Texture, env: THREE.Texture | null, shadows: boolean) {
    const s = this.scene;
    s.background = FOG.clone();
    s.fog = new THREE.Fog(FOG.getHex(), 22, 185);
    s.environment = env;
    s.environmentIntensity = 0.5;
    const { x, y, z } = HEAVEN;
    const r = rng(4242);

    // columns: an inner ring and an outer one, dissolving into the haze
    const cols: [number, number][] = [];
    for (let i = 0; i < 18; i++) { const a = (i / 18) * Math.PI * 2; cols.push([Math.sin(a) * 50, Math.cos(a) * 50]); }
    const far: [number, number][] = [];
    for (let i = 0; i < 26; i++) { const a = (i / 26) * Math.PI * 2 + 0.12; far.push([Math.sin(a) * 92, Math.cos(a) * 92]); }
    this.world = new CollisionWorld(heavenLevel(cols));

    // lights: a bright sky dome of a room, a warm key from high above (the only shadows) and a rim from behind Viktor
    s.add(new THREE.HemisphereLight(0xfffdf8, 0xe6d8bf, 0.95));
    this.key = new THREE.DirectionalLight(0xffeccc, 2.7);
    this.key.position.set(x + 6, y + 30, z + 18);
    this.key.target.position.set(x, y, z + 6);
    if (shadows) {
      this.key.castShadow = true;
      this.key.shadow.mapSize.set(2048, 2048);
      const c = this.key.shadow.camera;
      c.left = -16; c.right = 16; c.top = 16; c.bottom = -16; c.near = 1; c.far = 80;
      this.key.shadow.bias = -0.0005;
      this.key.shadow.normalBias = 0.03;
    }
    s.add(this.key, this.key.target);
    const rimLight = new THREE.DirectionalLight(0xffdca0, 1.9);
    rimLight.position.set(x - 4, y + 12, z - 20);
    rimLight.target.position.set(x, y + 1, z);
    s.add(rimLight, rimLight.target);

    // sky: warm white at the horizon, the faintest cool at the zenith, a glow pouring down
    const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 18), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { uHorizon: { value: FOG.clone() }, uZenith: { value: new THREE.Color(0xeef2fb) }, uGlow: { value: new THREE.Color(0xfff2d0) } },
      vertexShader: skyVertex, fragmentShader: skyFragment,
    }));
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    sky.position.set(x, y, z);
    s.add(sky);

    // floor: pale marble with a soft sheen, running out into the fog
    const marble = marbleTexture();
    marble.repeat.set(40, 40);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(420, 96), new THREE.MeshStandardMaterial({ color: 0xebe5da, map: marble, roughness: 0.34, metalness: 0.0, envMapIntensity: 0.6 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(x, y, z);
    floor.receiveShadow = shadows;
    s.add(floor);
    // gold inlay rings and rays around the dais
    this.inlay = new THREE.Mesh(new THREE.PlaneGeometry(36, 36), new THREE.MeshStandardMaterial({
      map: inlayTexture(), transparent: true, depthWrite: false, roughness: 0.3, metalness: 0.8, color: 0xffffff,
      emissive: new THREE.Color(0x6b4a12), emissiveIntensity: 0.35, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    this.inlay.rotation.x = -Math.PI / 2;
    this.inlay.position.set(x, y + 0.004, z);
    this.inlay.receiveShadow = shadows;
    s.add(this.inlay);

    // the dais: two round steps of white marble, each edged in gold
    const daisMat = new THREE.MeshStandardMaterial({ color: 0xfbf8f2, map: marble, roughness: 0.28, envMapIntensity: 0.7 });
    const goldMat = new THREE.MeshStandardMaterial({ color: 0xe2b85a, roughness: 0.3, metalness: 0.9, emissive: new THREE.Color(0x5a3c0c), emissiveIntensity: 0.3 });
    DAIS_R.forEach((rad, i) => {
      const h = DAIS_STEP;
      const step = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad + 0.04, h, 64), daisMat);
      step.position.set(x, y + h * i + h / 2, z);
      step.castShadow = shadows; step.receiveShadow = shadows;
      const trim = new THREE.Mesh(new THREE.TorusGeometry(rad + 0.01, 0.025, 8, 96), goldMat);
      trim.rotation.x = Math.PI / 2;
      trim.position.set(x, y + h * (i + 1) - 0.015, z);
      s.add(step, trim);
    });

    // colonnades
    const colGeo = columnGeometry();
    const colMat = new THREE.MeshStandardMaterial({ color: 0xf7f3ec, map: marble, roughness: 0.5 });
    for (const [ring, scale] of [[cols, 1], [far, 1.25]] as const) {
      const inst = new THREE.InstancedMesh(colGeo, colMat, ring.length);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(scale, scale, scale), p = new THREE.Vector3();
      ring.forEach(([cx, cz], i) => { q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * Math.PI); p.set(x + cx, y, z + cz); m.compose(p, q, sc); inst.setMatrixAt(i, m); });
      inst.instanceMatrix.needsUpdate = true;
      inst.computeBoundingSphere();
      s.add(inst);
    }

    // shafts of light: one great one on Viktor, a few more scattered through the hall
    const shaftGeo = new THREE.CylinderGeometry(2.2, 3.4, 60, 32, 1, true);
    shaftGeo.translate(0, 30, 0);
    const shaftAt: [number, number, number, number, number][] = [[0, 0, 1.25, 0.2, -0.12], [-16, -10, 1, 0.13, 0.1], [18, -6, 0.9, 0.12, -0.08], [-10, 24, 0.8, 0.1, 0.14], [22, 20, 1.1, 0.1, -0.1], [-30, 4, 1.3, 0.09, 0.06], [4, -32, 1.4, 0.1, 0.05]];
    shaftAt.forEach(([sx, sz, sc, alpha, tilt], i) => {
      const mat = new THREE.ShaderMaterial({
        vertexShader: shaftVertex, fragmentShader: shaftFragment,
        uniforms: { uTime: { value: 0 }, uAlpha: { value: alpha }, uSeed: { value: i * 0.37 } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      });
      const shaft = new THREE.Mesh(shaftGeo, mat);
      shaft.position.set(x + sx, y - 0.2, z + sz);
      shaft.scale.set(sc, 1, sc);
      shaft.rotation.set(tilt, 0, tilt * 0.6);
      shaft.renderOrder = 6;
      this.shafts.push(mat);
      s.add(shaft);
    });

    // mist drifting over the floor, thicker further out so the floor melts into the haze
    this.mist = new Billboards(44, { map: cloudTex, fog: 'mix', renderOrder: 3 });
    for (let i = 0; i < 44; i++) {
      const a = r() * Math.PI * 2, d = i < 14 ? 9 + r() * 18 : 28 + r() * 70;
      const w = (i < 14 ? 7 : 16) + r() * 14;
      const puff = { i: 0, x: Math.sin(a) * d, z: Math.cos(a) * d, y: 0.25 + r() * (i < 14 ? 0.6 : 2.5), w, h: w * 0.28, a: i < 14 ? 0.32 : 0.5, s: 0.2 + r() * 0.5 };
      puff.i = this.mist.add(x + puff.x, y + puff.y, z + puff.z, puff.w, puff.h, 0xffffff, puff.a);
      this.mistPuffs.push(puff);
    }
    s.add(this.mist.mesh);

    // motes of gold rising through the air (animated entirely in the shader)
    const N = 420;
    const seeds = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 34;
      seeds[i * 4] = Math.sin(a) * d; seeds[i * 4 + 1] = Math.cos(a) * d; seeds[i * 4 + 2] = r(); seeds[i * 4 + 3] = 0.4 + r() * 0.8;
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    mg.setAttribute('seed', new THREE.BufferAttribute(seeds, 4));
    this.moteMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uScale: { value: window.innerHeight / 2 }, uOrigin: { value: new THREE.Vector3(x, y, z) } },
      vertexShader: `attribute vec4 seed; uniform float uTime, uScale; uniform vec3 uOrigin; varying float vA;
        void main(){
          float u = fract(uTime * 0.035 * seed.w + seed.z);
          vec3 p = uOrigin + vec3(seed.x + sin(uTime * 0.3 + seed.z * 20.0) * 0.8, u * 16.0, seed.y + cos(uTime * 0.27 + seed.z * 13.0) * 0.8);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vA = smoothstep(0.0, 0.15, u) * smoothstep(1.0, 0.7, u) * (0.6 + 0.4 * sin(uTime * 2.0 + seed.z * 40.0));
          gl_PointSize = (0.05 + seed.w * 0.05) * uScale / max(0.1, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `varying float vA; void main(){ vec2 d = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.0, length(d)); gl_FragColor = vec4(vec3(1.0, 0.82, 0.45), a * vA * 0.9); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    window.addEventListener('resize', () => { this.moteMat.uniforms.uScale.value = window.innerHeight / 2; });
    this.motes = new THREE.Points(mg, this.moteMat);
    this.motes.frustumCulled = false;
    this.motes.renderOrder = 7;
    s.add(this.motes);

    // the gift: sparks spiralling up around the runner, gathering speed with the blessing
    const G = 220;
    const gs = new Float32Array(G * 3);
    for (let i = 0; i < G; i++) { gs[i * 3] = r() * Math.PI * 2; gs[i * 3 + 1] = r(); gs[i * 3 + 2] = 0.6 + r() * 0.8; }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(G * 3), 3));
    gg.setAttribute('seed', new THREE.BufferAttribute(gs, 3));
    this.giftMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uK: { value: 0 }, uCenter: { value: new THREE.Vector3() }, uScale: this.moteMat.uniforms.uScale },
      vertexShader: `attribute vec3 seed; uniform float uTime, uK, uScale; uniform vec3 uCenter; varying float vA;
        void main(){
          float u = fract(uTime * 0.45 * seed.z + seed.y);
          float ang = seed.x + u * 7.0 + uTime * (1.5 + uK * 2.0);
          float rad = mix(1.1, 0.35, u) * (0.8 + 0.2 * sin(seed.x * 5.0));
          vec3 p = uCenter + vec3(cos(ang) * rad, u * 2.8, sin(ang) * rad);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vA = uK * smoothstep(0.0, 0.1, u) * (1.0 - u);
          gl_PointSize = (0.06 + 0.05 * seed.z) * uScale / max(0.1, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `varying float vA; void main(){ vec2 d = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.0, length(d)); gl_FragColor = vec4(vec3(1.0, 0.86, 0.5), a * vA); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const gift = new THREE.Points(gg, this.giftMat);
    gift.frustumCulled = false;
    gift.renderOrder = 8;
    s.add(gift);

    // Viktor on his dais, and the doorway you come through behind the arrival point
    this.viktor = new ViktorModel(glowTex, shadows);
    this.viktor.root.position.copy(this.viktorPos);
    s.add(this.viktor.root);
    this.door = new PortalView(glowTex, { beam: false, oneSided: true });
    this.door.place([this.arrivePos.x, this.arrivePos.y, this.arrivePos.z + DOOR_BEHIND], Math.PI, -Infinity);
    s.add(this.door.group);
  }

  /** The blessing (0..1): the great shaft of light over Viktor gathers into a pillar. */
  bless(k: number, at?: THREE.Vector3) {
    const m = this.shafts[0];
    m.uniforms.uAlpha.value = 0.2 + k * 0.55;
    this.giftMat.uniforms.uK.value = k;
    if (at) this.giftMat.uniforms.uCenter.value.copy(at);
  }

  /** Keep the key light's shadow on whoever is near (you and Viktor). */
  focus(p: THREE.Vector3) {
    const mx = (p.x + this.viktorPos.x) / 2, mz = (p.z + this.viktorPos.z) / 2;
    this.key.target.position.set(mx, HEAVEN.y, mz);
    this.key.position.set(mx + 6, HEAVEN.y + 30, mz + 18);
  }

  update(t: number, dt: number, camPos: THREE.Vector3) {
    for (const m of this.shafts) m.uniforms.uTime.value = t;
    this.moteMat.uniforms.uTime.value = t;
    this.giftMat.uniforms.uTime.value = t;
    for (const p of this.mistPuffs) {
      const a = t * 0.02 * p.s;
      const cx = p.x * Math.cos(a) - p.z * Math.sin(a), cz = p.x * Math.sin(a) + p.z * Math.cos(a);
      this.mist.set(p.i, HEAVEN.x + cx, HEAVEN.y + p.y + Math.sin(t * 0.3 + p.s * 9) * 0.1, HEAVEN.z + cz, p.w, p.h, p.a);
    }
    this.door.update(t, dt, 1e9, camPos);
  }
}

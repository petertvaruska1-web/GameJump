// Speedster Battle's course on screen: the road of light through the gap in
// spacetime, drawn from the same samples the collision world is built from
// (shared/level/race.ts), so the floor you see is the floor you run on.
//
//   the road      glassy obsidian with chevrons of light flowing toward the finish,
//                 lane dashes, a lit edge and a glowing keel down its sides, each
//                 section in its own accent colour; kicker ramps blaze with arrows,
//                 their troughs are a crack of light; a checkered band at the finish
//   the barriers  force fields: a rail of light at hip height with pulses racing
//                 along it, a shimmer over it that fades out with distance
//   the rings     checkpoint rings every 400 m that flash the colour of whoever
//                 passes through them
//   the ends      the rift the team arrived through behind the grid (grid slots in
//                 the runners' colours), and the Event Horizon: a vast swirling ring
//                 over the finish line
//   the air       the sky (RaceSky), the scenery (RaceScenery), and dust that
//                 streaks past the camera at speed
//
// The road is one mesh for the whole course (a few thousand vertices: cheaper than
// culling it in pieces), the barriers another, the rings one instanced mesh.

import * as THREE from 'three';
import type { RaceData } from '../../shared/level/race';
import { CollisionWorld } from '../../shared/physics/world';
import { PLAYER_COLORS } from './CharacterModel';
import { HazardView } from './HazardView';
import type { Materials } from './Materials';
import { PortalView } from './PortalView';
import { RaceScenery } from './RaceScenery';
import { RaceSky } from './RaceSky';

/** The air of the gap in spacetime: what the fog fades into, and how thick it is. */
export const RACE_FOG = new THREE.Color(0x0a0720);
export const RACE_FOG_DENSITY = 0.00085;

/** Each section's accent (HDR: it glows). */
const ACCENTS: [number, number, number][] = [
  [0.55, 1.35, 1.9], [0.3, 1.7, 1.1], [1.1, 0.55, 1.95], [1.9, 0.45, 1.3],
  [0.4, 1.35, 2.0], [1.35, 0.55, 1.85], [1.9, 0.45, 1.3], [1.95, 1.5, 0.75],
];

const rightX = (h: number) => Math.cos(h);
const rightZ = (h: number) => -Math.sin(h);

const railVertex = /* glsl */ `
  attribute vec3 aAcc;
  varying vec2 vUv; varying float vDist; varying vec3 vAcc;
  void main() {
    vUv = uv; vAcc = aAcc;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDist = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;
const railFragment = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv; varying float vDist; varying vec3 vAcc;
  void main() {
    float s = vUv.x, h = vUv.y;
    float line = exp(-pow((h - 0.36) / 0.02, 2.0));
    float base = exp(-h / 0.035) * 0.7;
    float scan = 0.5 + 0.5 * sin(s * 2.2 - uTime * 3.0) * sin(h * 38.0 + s * 0.4);
    float field = (0.035 + 0.05 * scan) * (1.0 - h) * smoothstep(420.0, 60.0, vDist);
    float p = fract((s - uTime * 95.0) / 150.0);
    float pulse = smoothstep(0.955, 0.995, p) * (1.0 - smoothstep(0.995, 1.0, p));
    float near = smoothstep(2.0, 9.0, vDist);
    vec3 col = vAcc * (line * (0.9 + pulse * 3.5) + base + field) + vec3(1.0) * line * pulse * 1.5;
    float fade = smoothstep(1400.0, 300.0, vDist);
    gl_FragColor = vec4(col * fade * near, 1.0);
  }`;

const ringVertex = /* glsl */ `
  varying vec2 vUv; varying vec3 vCol;
  void main() {
    vUv = uv;
    #ifdef USE_INSTANCING_COLOR
      vCol = instanceColor;
    #else
      vCol = vec3(1.0);
    #endif
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }`;
const ringFragment = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv; varying vec3 vCol;
  void main() {
    float dash = step(0.35, fract(vUv.x * 36.0 - uTime * 0.6));
    float glow = 0.55 + 0.45 * dash;
    gl_FragColor = vec4(vCol * glow, 1.0);
  }`;

const dustVertex = /* glsl */ `
  uniform vec3 uCam, uVel; uniform float uBox, uStretch;
  attribute vec3 aPos; attribute float aEnd;
  varying float vA;
  void main() {
    vec3 p = mod(aPos - uCam + uBox * 0.5, uBox) - uBox * 0.5 + uCam;
    float d = length(p - uCam);
    p -= uVel * uStretch * aEnd;
    float sp = length(uVel);
    vA = smoothstep(2.5, 9.0, d) * smoothstep(uBox * 0.5, uBox * 0.25, d) * (0.18 + smoothstep(12.0, 60.0, sp) * 0.9) * (1.0 - aEnd * 0.85);
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }`;
const dustFragment = /* glsl */ `
  varying float vA;
  void main() { gl_FragColor = vec4(vec3(0.62, 0.72, 1.0) * vA, vA); }`;

export class RaceView {
  readonly group = new THREE.Group();
  readonly world: CollisionWorld;
  /** The course has no lasers or anchors; this keeps the grapple UI's calls harmless. */
  readonly hazards: HazardView;
  readonly sky = new RaceSky();
  readonly scenery: RaceScenery;
  private readonly roadMat: THREE.MeshStandardMaterial;
  private roadShader: THREE.WebGLProgramParametersWithUniforms | null = null;
  private readonly railMat: THREE.ShaderMaterial;
  private readonly rings: THREE.InstancedMesh;
  private readonly ringMat: THREE.ShaderMaterial;
  /** Each ring's resting colour, and how lit it is right now (fading back). */
  private readonly ringLit: { c: THREE.Color; k: number }[] = [];
  private readonly ringBase = new THREE.Color(0.55, 0.45, 1.25);
  private readonly finishPortal: PortalView;
  private readonly startPortal: PortalView;
  private readonly dustMat: THREE.ShaderMaterial;
  private readonly tmpC = new THREE.Color();

  constructor(readonly data: RaceData, mats: Materials, glowTex: THREE.Texture, shadows: boolean) {
    this.world = new CollisionWorld(data.level);
    this.hazards = new HazardView(data.level, mats);
    this.group.add(this.hazards.group);
    this.group.visible = false;
    this.group.add(this.sky.group);
    this.scenery = new RaceScenery(data);
    this.group.add(this.scenery.group);

    // --- the road
    this.roadMat = new THREE.MeshStandardMaterial({ color: 0x0b0d1b, roughness: 0.62, metalness: 0.3, envMapIntensity: 0.1 });
    const T = data.track;
    const kick = T.kickers.map((k) => new THREE.Vector3(k.s0, k.lip, k.s1));
    this.roadMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = { value: 0 };
      shader.uniforms.uFinish = { value: T.finishS };
      shader.uniforms.uStart = { value: data.track.samples[18].s + 6 };
      shader.uniforms.uK0 = { value: kick[0] ?? new THREE.Vector3(-1, -1, -1) };
      shader.uniforms.uK1 = { value: kick[1] ?? new THREE.Vector3(-1, -1, -1) };
      this.roadShader = shader;
      shader.vertexShader = 'attribute vec4 aRoad;\nattribute vec3 aAcc;\nvarying vec4 vRoad;\nvarying vec3 vAcc;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vRoad = aRoad; vAcc = aAcc;');
      shader.fragmentShader = 'uniform float uTime, uFinish, uStart;\nuniform vec3 uK0, uK1;\nvarying vec4 vRoad;\nvarying vec3 vAcc;\n' + shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           float u = vRoad.x, s = vRoad.y, w = vRoad.z, side = vRoad.w;
           float lat = (u - 0.5) * w;
           float dist = length(vViewPosition);
           float fine = smoothstep(260.0, 60.0, dist);
           vec3 glow = vec3(0.0);
           if (u < 0.0005 || u > 0.9995) {
             // the sides: a keel of light fading down from the edge
             glow = vAcc * (pow(1.0 - side, 4.0) * 0.9 + 0.05);
           } else {
             float edge = smoothstep(0.025, 0.0, u) + smoothstep(0.975, 1.0, u);
             float inner = exp(-min(u, 1.0 - u) * w / 0.9) * 0.35;
             float lane = smoothstep(0.08, 0.0, abs(abs(lat) - w / 6.0)) * step(0.5, fract(s / 9.0)) * 0.22 * fine;
             float c = fract((s - abs(lat) * 0.55 - uTime * 16.0) / 28.0);
             float chev = smoothstep(0.0, 0.006, c) * smoothstep(0.024, 0.012, c) * smoothstep(w * 0.38, w * 0.22, abs(lat)) * 0.65 * fine * smoothstep(3.0, 14.0, dist);
             vec2 cell = abs(fract(vec2(lat, s) / 4.0) - 0.5);
             float grid = smoothstep(0.485, 0.5, max(cell.x, cell.y)) * 0.022 * fine;
             glow = vAcc * (edge * 1.5 + inner + lane + chev + grid);
             // kicker ramps blaze with arrows; their troughs are a crack of light
             for (int k = 0; k < 2; k++) {
               vec3 K = k == 0 ? uK0 : uK1;
               if (s >= K.x && s <= K.y) {
                 float a = fract((s - abs(lat) * 0.8 - uTime * 8.0) / 3.0);
                 glow += vec3(1.9, 1.05, 0.45) * (smoothstep(0.0, 0.05, a) * smoothstep(0.35, 0.2, a) * 0.9 + 0.12);
               } else if (s > K.y && s < K.z) {
                 float crack = abs(lat - 1.4 * sin(s * 0.35) - 0.6 * sin(s * 1.3));
                 glow += vec3(1.6, 0.6, 1.9) * (exp(-crack * 2.2) * 1.4 + exp(-crack * 0.5) * 0.18);
               }
             }
             // the start and the finish
             float fin = step(abs(s - uFinish), 2.2);
             float checker = mod(floor(lat / 1.1) + floor((s - uFinish) / 1.1), 2.0);
             glow += fin * mix(vec3(0.15, 0.12, 0.2), vec3(2.2, 2.0, 1.6), checker);
             glow += vec3(1.4, 1.5, 1.8) * smoothstep(0.35, 0.0, abs(s - uStart)) * 0.9;
           }
           totalEmissiveRadiance += glow;
         }`,
      );
    };
    this.roadMat.customProgramCacheKey = () => 'race-road';
    const road = new THREE.Mesh(this.roadGeometry(), this.roadMat);
    road.receiveShadow = shadows;
    road.frustumCulled = false;
    this.group.add(road);

    // --- the barriers
    this.railMat = new THREE.ShaderMaterial({ vertexShader: railVertex, fragmentShader: railFragment, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false, uniforms: { uTime: { value: 0 } } });
    const rails = new THREE.Mesh(this.railGeometry(), this.railMat);
    rails.frustumCulled = false;
    rails.renderOrder = 5;
    this.group.add(rails);

    // --- the checkpoint rings
    this.ringMat = new THREE.ShaderMaterial({ vertexShader: ringVertex, fragmentShader: ringFragment, toneMapped: false, uniforms: { uTime: { value: 0 } } });
    this.rings = new THREE.InstancedMesh(new THREE.TorusGeometry(1, 0.03, 8, 128), this.ringMat, T.rings.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
    T.rings.forEach((s, i) => {
      const smp = T.samples[Math.round(s / T.step)];
      const R = smp.w / 2 + 4;
      q.setFromEuler(new THREE.Euler(0, smp.h, 0));
      m4.compose(p.set(smp.x, smp.y + R * 0.42, smp.z), q, sc.set(R, R, R));
      this.rings.setMatrixAt(i, m4);
      this.rings.setColorAt(i, this.ringBase);
      this.ringLit.push({ c: new THREE.Color(), k: 0 });
    });
    this.rings.frustumCulled = false;
    this.group.add(this.rings);

    // --- the Event Horizon over the finish, and the rift the team came through behind the grid
    const fin = T.samples[Math.round(T.finishS / T.step)];
    this.finishPortal = new PortalView(glowTex, { beam: true, palette: 'rift' });
    this.finishPortal.group.scale.setScalar(9.2);
    this.finishPortal.place([fin.x, fin.y + 8 - 1.75 * 9.2, fin.z], fin.h + Math.PI, -1e6);
    this.group.add(this.finishPortal.group);
    const st = T.samples[4];
    this.startPortal = new PortalView(glowTex, { beam: false, palette: 'rift' });
    this.startPortal.group.scale.setScalar(2.2);
    this.startPortal.place([st.x, st.y, st.z], st.h, -1e6);
    this.group.add(this.startPortal.group);
    this.group.add(this.gridSlots());

    // --- dust in the void, streaking past at speed
    const N = 900, box = 90;
    const aPos = new Float32Array(N * 6), aEnd = new Float32Array(N * 2);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < N; i++) {
      const x = rnd() * box, y = rnd() * box, z = rnd() * box;
      aPos.set([x, y, z, x, y, z], i * 6);
      aEnd.set([0, 1], i * 2);
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 6), 3));
    dg.setAttribute('aPos', new THREE.BufferAttribute(aPos, 3));
    dg.setAttribute('aEnd', new THREE.BufferAttribute(aEnd, 1));
    this.dustMat = new THREE.ShaderMaterial({ vertexShader: dustVertex, fragmentShader: dustFragment, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
      uniforms: { uCam: { value: new THREE.Vector3() }, uVel: { value: new THREE.Vector3() }, uBox: { value: box }, uStretch: { value: 0.045 } } });
    const dust = new THREE.LineSegments(dg, this.dustMat);
    dust.frustumCulled = false;
    dust.renderOrder = 6;
    this.group.add(dust);
  }

  /** The accent colour at distance s (blended across section seams). */
  private accentAt(s: number, out: THREE.Color): THREE.Color {
    const secs = this.data.track.sections;
    const i = Math.max(0, secs.findIndex((q) => s >= q.s0 && s <= q.s1));
    const a = ACCENTS[i % ACCENTS.length];
    out.setRGB(a[0], a[1], a[2]);
    const next = secs[i + 1];
    if (next) {
      const k = Math.max(0, Math.min(1, (s - (next.s0 - 60)) / 60));
      if (k > 0) { const b = ACCENTS[(i + 1) % ACCENTS.length]; out.lerp(this.tmpC.setRGB(b[0], b[1], b[2]), k); }
    }
    return out;
  }

  /**
   * The road: its top, a skirt down each side and an underside, with a kicker's lip
   * as a step down. aRoad = (across 0..1, distance along, width, 0 top / 1 bottom).
   */
  private roadGeometry(): THREE.BufferGeometry {
    const S = this.data.track.samples;
    const pos: number[] = [], road: number[] = [], acc: number[] = [], idx: number[] = [];
    const TH = 1.4, c = new THREE.Color();
    const ring = (x: number, y: number, z: number, h: number, w: number, s: number) => {
      const rx = rightX(h) * w / 2, rz = rightZ(h) * w / 2;
      const b = pos.length / 3;
      pos.push(x - rx, y, z - rz, x + rx, y, z + rz, x + rx, y - TH, z + rz, x - rx, y - TH, z - rz);
      road.push(0, s, w, 0, 1, s, w, 0, 1, s, w, 1, 0, s, w, 1);
      this.accentAt(s, c);
      for (let k = 0; k < 4; k++) acc.push(c.r, c.g, c.b);
      return b;
    };
    let prev = -1;
    for (const q of S) {
      const a = ring(q.x, q.y, q.z, q.h, q.w, q.s);
      if (prev >= 0) for (let k = 0; k < 4; k++) { const k2 = (k + 1) % 4; idx.push(prev + k, a + k, prev + k2, prev + k2, a + k, a + k2); }
      prev = a;
      if (q.drop !== undefined) prev = ring(q.x, q.drop, q.z, q.h, q.w, q.s);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aRoad', new THREE.Float32BufferAttribute(road, 4));
    g.setAttribute('aAcc', new THREE.Float32BufferAttribute(acc, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  /** The barriers' force fields: a panel up each edge (uv: distance along, height 0..1). */
  private railGeometry(): THREE.BufferGeometry {
    const S = this.data.track.samples;
    const pos: number[] = [], uv: number[] = [], acc: number[] = [], idx: number[] = [];
    const H = 2.6, c = new THREE.Color();
    for (const side of [-1, 1]) {
      let prev = -1;
      const put = (x: number, y: number, z: number, s: number) => {
        const b = pos.length / 3;
        pos.push(x, y, z, x, y + H, z);
        uv.push(s, 0, s, 1);
        this.accentAt(s, c);
        acc.push(c.r, c.g, c.b, c.r, c.g, c.b);
        return b;
      };
      for (const q of S) {
        const o = q.w / 2 - 0.02;
        const x = q.x + rightX(q.h) * o * side, z = q.z + rightZ(q.h) * o * side;
        const b = put(x, q.y, z, q.s);
        if (prev >= 0) idx.push(prev, b, prev + 1, prev + 1, b, b + 1);
        prev = b;
        if (q.drop !== undefined) prev = put(x, q.drop, z, q.s);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('aAcc', new THREE.Float32BufferAttribute(acc, 3));
    g.setIndex(idx);
    return g;
  }

  /** The start grid: a lit slot in each runner's colour. */
  private gridSlots(): THREE.Group {
    const g = new THREE.Group();
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 256;
    const ctx = cv.getContext('2d')!;
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 10;
    ctx.strokeRect(10, 10, 108, 236);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(10, 10, 108, 236);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.PlaneGeometry(3, 5.2);
    geo.rotateX(-Math.PI / 2);
    this.data.grid.forEach((p, i) => {
      const c = new THREE.Color(PLAYER_COLORS[i % 3]).multiplyScalar(1.6);
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, color: c, transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      m.position.set(p[0], p[1] - 0.03, p[2]);
      m.rotation.y = this.data.yaw;
      g.add(m);
    });
    return g;
  }

  /** Ring `i` flashes the colour of the runner going through it. */
  passRing(i: number, color: number) {
    const r = this.ringLit[i];
    if (!r) return;
    r.c.set(color).multiplyScalar(3.2);
    r.k = 1;
  }

  update(time: number, dt: number, camPos: THREE.Vector3, mt: number, vel: THREE.Vector3) {
    this.sky.update(time, camPos);
    this.scenery.update(time);
    if (this.roadShader) this.roadShader.uniforms.uTime.value = time;
    this.railMat.uniforms.uTime.value = time;
    this.ringMat.uniforms.uTime.value = time;
    this.dustMat.uniforms.uCam.value.copy(camPos);
    this.dustMat.uniforms.uVel.value.copy(vel);
    let dirty = false;
    for (let i = 0; i < this.ringLit.length; i++) {
      const r = this.ringLit[i];
      if (r.k <= 0) continue;
      r.k = Math.max(0, r.k - dt / 1.6);
      this.rings.setColorAt(i, this.tmpC.copy(this.ringBase).lerp(r.c, r.k * r.k));
      dirty = true;
    }
    if (dirty && this.rings.instanceColor) this.rings.instanceColor.needsUpdate = true;
    this.finishPortal.update(time, dt, mt, camPos);
    this.startPortal.update(time, dt, mt, camPos);
  }
}

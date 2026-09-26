// Everything round the road in Speedster Battle: the gap in spacetime itself.
//
//   near   crystal shards hovering along the barriers: at speed they whip past
//          and tell you how fast you are going better than any number
//   mid    crystal spires climbing out of the void beside the road (a forest of
//          them in the Crystal Narrows), floating rock islands crowned with
//          crystals, aurora curtains hanging over the sections
//   far    a giant crystal core at the heart of the Nebula Spiral, girdled by
//          slowly turning orbital rings; vast rings of disturbed spacetime far out
//
// Built once from the course's samples with a seeded random, so everyone sees
// the same place. Instanced: a few draw calls for thousands of crystals and rocks.

import * as THREE from 'three';
import type { RaceData } from '../../shared/level/race';
import { rng } from '../../shared/math';

// ------------------------------------------------------------------ crystals and rocks

/** A faceted crystal: a six-sided shaft with a pointed tip and a short point below, from y -0.5 to 1.7. */
function crystalGeometry(sides = 6): THREE.BufferGeometry {
  const pos: number[] = [];
  const ring = (y: number, r: number, twist: number) => Array.from({ length: sides }, (_, i) => {
    const a = (i / sides) * Math.PI * 2 + twist;
    return [Math.cos(a) * r, y, Math.sin(a) * r];
  });
  const lo = ring(-0.15, 0.82, 0), hi = ring(0.95, 1, 0.12), top = [0, 1.7, 0], bot = [0, -0.5, 0];
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    pos.push(...lo[i], ...hi[i], ...lo[j], ...lo[j], ...hi[i], ...hi[j]);
    pos.push(...hi[i], ...top, ...hi[j]);
    pos.push(...lo[j], ...bot, ...lo[i]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** A faceted rock, roughly flattened, knobbly (non-indexed: every face flat). */
function rockGeometry(seed: number): THREE.BufferGeometry {
  const r = rng(seed);
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const bumps = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let b = bumps.get(k);
    if (b === undefined) { b = 0.72 + r() * 0.5; bumps.set(k, b); }
    const y = p.getY(i);
    p.setXYZ(i, p.getX(i) * b, y * b * (y > 0 ? 0.55 : 0.9), p.getZ(i) * b);
  }
  const ng = g.toNonIndexed();
  ng.computeVertexNormals();
  return ng;
}

/** Crystal light: the colour glows from inside, hottest toward the tip and round the silhouette. */
function crystalMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0x2c2856, roughness: 0.14, metalness: 0.2, envMapIntensity: 0.7, flatShading: true });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = 'varying float vCrysH;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vCrysH = position.y;');
    shader.fragmentShader = 'varying float vCrysH;\n' + shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
       float crysFres = pow(1.0 - saturate(dot(normalize(normal), normalize(vViewPosition))), 2.5);
       float crysTip = smoothstep(0.2, 1.7, vCrysH);
       #if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
         vec3 crysC = vColor.rgb;
       #else
         vec3 crysC = vec3(0.6, 0.5, 1.0);
       #endif
       totalEmissiveRadiance += crysC * (0.12 + crysTip * crysTip * 0.95 + crysFres * 1.1);`,
    );
  };
  m.customProgramCacheKey = () => 'race-crystal';
  return m;
}

/** Dark basalt with a violet rim, so a floating rock reads against the void. */
function rockMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0x1c1830, roughness: 0.88, metalness: 0.05, flatShading: true, envMapIntensity: 0.25 });
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
       float rockFres = pow(1.0 - saturate(dot(normalize(normal), normalize(vViewPosition))), 3.0);
       totalEmissiveRadiance += vec3(0.32, 0.16, 0.75) * rockFres * 0.9;`,
    );
  };
  m.customProgramCacheKey = () => 'race-rock';
  return m;
}

/** The crystals' colours: violet, cyan, magenta, a pale white-blue. */
const CRYSTAL_COLORS = [new THREE.Color(0.5, 0.22, 1.0), new THREE.Color(0.12, 0.75, 1.0), new THREE.Color(0.95, 0.2, 0.75), new THREE.Color(0.35, 0.45, 1.0)];

// ------------------------------------------------------------------ auroras

const auroraVertex = /* glsl */ `
  uniform float uTime;
  attribute float aT;
  varying vec2 vUv; varying float vDist; varying float vT;
  void main() {
    vUv = uv; vT = aT;
    vec3 p = position;
    p.x += sin(uv.x * 0.011 + uTime * 0.25) * 9.0 * uv.y;
    p.z += cos(uv.x * 0.008 + uTime * 0.2) * 9.0 * uv.y;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vDist = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;
const auroraFragment = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv; varying float vDist; varying float vT;
  float h1(float x) { return fract(sin(x * 127.1) * 43758.5453); }
  float n1(float x) { float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(h1(i), h1(i + 1.0), f); }
  void main() {
    float x = vUv.x, y = vUv.y;
    // vertical rays drifting along the curtain
    float rays = n1(x * 0.09 + uTime * 0.35) * 0.6 + n1(x * 0.31 - uTime * 0.6) * 0.4;
    rays = pow(rays, 1.6);
    float fold = 0.55 + 0.45 * sin(x * 0.02 + uTime * 0.4 + n1(x * 0.01) * 6.0);
    float bottom = smoothstep(0.0, 0.05, y) * (1.0 - smoothstep(0.05, 0.9, y));
    float edge = exp(-y * 18.0) * 0.7;
    vec3 low = vec3(0.1, 1.0, 0.62), high = vec3(0.62, 0.22, 1.0);
    vec3 col = mix(low, high, smoothstep(0.12, 0.75, y));
    float ends = smoothstep(0.0, 0.14, vT) * smoothstep(1.0, 0.86, vT);
    float a = (rays * fold * bottom + edge * rays) * 0.55 * ends;
    a *= smoothstep(2400.0, 900.0, vDist) * smoothstep(20.0, 120.0, vDist);
    gl_FragColor = vec4(col * a, a);
  }`;

// ------------------------------------------------------------------ rings of spacetime and the core's orbits

const glowRingFragment = /* glsl */ `
  uniform vec3 uColor; uniform float uTime, uAlpha;
  varying vec2 vUv;
  void main() {
    float dash = 0.55 + 0.45 * sin(vUv.x * 160.0 - uTime * 1.2);
    float fade = 0.6 + 0.4 * sin(vUv.x * 6.2832 * 3.0 + uTime * 0.3);
    gl_FragColor = vec4(uColor * dash * fade * uAlpha, 1.0);
  }`;
const uvVertex = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

export class RaceScenery {
  readonly group = new THREE.Group();
  /** Where the Nebula Spiral's crystal core stands. */
  readonly coreAt = new THREE.Vector3();
  private readonly timed: THREE.ShaderMaterial[] = [];
  private readonly orbits: THREE.Mesh[] = [];
  private readonly core: THREE.Group;
  private readonly coreMat: THREE.MeshStandardMaterial;
  private readonly shards: THREE.InstancedMesh;

  constructor(private readonly data: RaceData) {
    const T = data.track, S = T.samples;
    const r = rng(20260926);
    const crystalGeo = crystalGeometry(6);
    const cMat = crystalMaterial();
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), sc = new THREE.Vector3();
    const pick = () => CRYSTAL_COLORS[Math.floor(r() * CRYSTAL_COLORS.length)];
    const secOf = (name: string) => T.sections.findIndex((s) => s.name === name);
    const narrows = secOf('Crystal Narrows');

    /** Distance (xz) from a point to the course, and the course's height there. */
    const nearTrack = (x: number, z: number): [number, number] => {
      let bd = Infinity, y = 0;
      for (let i = 0; i < S.length; i += 3) {
        const d = Math.hypot(S[i].x - x, S[i].z - z);
        if (d < bd) { bd = d; y = S[i].y; }
      }
      return [bd, y];
    };

    // --- near: shards hovering along both barriers, every ~20 m
    const shardList: { p: THREE.Vector3; s: number; c: THREE.Color; rx: number; ry: number; rz: number }[] = [];
    for (let i = 4; i < S.length; i += 10) {
      const smp = S[i];
      const rx = Math.cos(smp.h), rz = -Math.sin(smp.h);
      for (const side of [-1, 1]) {
        if (r() < 0.25) continue;
        const off = smp.w / 2 + 1.4 + r() * 2.2;
        shardList.push({
          p: new THREE.Vector3(smp.x + rx * off * side, smp.y + 0.3 + r() * 2.8, smp.z + rz * off * side),
          s: 0.35 + r() * 0.8, c: pick(), rx: (r() - 0.5) * 0.9, ry: r() * Math.PI * 2, rz: (r() - 0.5) * 0.9,
        });
      }
    }
    this.shards = new THREE.InstancedMesh(crystalGeo, cMat, shardList.length);
    shardList.forEach((it, i) => {
      q.setFromEuler(e.set(it.rx, it.ry, it.rz));
      m4.compose(it.p, q, sc.set(it.s * 0.55, it.s, it.s * 0.55));
      this.shards.setMatrixAt(i, m4);
      this.shards.setColorAt(i, it.c);
    });
    this.group.add(this.shards);

    // --- mid: spires out of the void beside the road (a forest in the Narrows), and floating islands
    const spires: { p: THREE.Vector3; w: number; h: number; c: THREE.Color; ry: number; tilt: number }[] = [];
    const rocks: { p: THREE.Vector3; s: number; ry: number; seed: number }[] = [];
    for (let i = 0; i < S.length; i += 6) {
      const smp = S[i];
      const dense = smp.sec === narrows;
      if (r() > (dense ? 0.9 : 0.28)) continue;
      const rx = Math.cos(smp.h), rz = -Math.sin(smp.h);
      const side = r() < 0.5 ? -1 : 1;
      const off = smp.w / 2 + (dense ? 8 : 22) + r() * (dense ? 40 : 160);
      const x = smp.x + rx * off * side, z = smp.z + rz * off * side;
      const [d] = nearTrack(x, z);
      const w = dense ? 2.5 + r() * 5 : 4 + r() * 10;
      if (d < smp.w / 2 + w * 1.4 + 4) continue;
      const h = (dense ? 25 : 40) + r() * (dense ? 70 : 130);
      spires.push({ p: new THREE.Vector3(x, smp.y - h * 0.55 - r() * 30, z), w, h, c: pick(), ry: r() * 6.3, tilt: (r() - 0.5) * 0.25 });
    }
    for (let k = 0; k < 150; k++) {
      const smp = S[Math.floor(r() * S.length)];
      const ang = r() * Math.PI * 2, dist = 60 + r() * 520;
      const x = smp.x + Math.sin(ang) * dist, z = smp.z + Math.cos(ang) * dist;
      const s = 6 + r() * r() * 55;
      const [d, ty] = nearTrack(x, z);
      if (d < s * 1.3 + 30) continue;
      const y = ty + (r() - 0.55) * 160;
      rocks.push({ p: new THREE.Vector3(x, y, z), s, ry: r() * 6.3, seed: k });
      // a crown of crystals on top
      const n = 2 + Math.floor(r() * 6);
      for (let c = 0; c < n; c++) {
        const a = r() * Math.PI * 2, rr = r() * s * 0.55;
        const hh = s * (0.25 + r() * 0.5);
        spires.push({ p: new THREE.Vector3(x + Math.sin(a) * rr, y + s * 0.35, z + Math.cos(a) * rr), w: hh * 0.28, h: hh, c: pick(), ry: r() * 6.3, tilt: (r() - 0.5) * 0.8 });
      }
    }
    // --- far: a few enormous crystals on the horizon
    for (let k = 0; k < 14; k++) {
      const smp = S[Math.floor((k / 14) * S.length)];
      const ang = r() * Math.PI * 2, dist = 800 + r() * 700;
      const h = 220 + r() * 380;
      spires.push({ p: new THREE.Vector3(smp.x + Math.sin(ang) * dist, smp.y - h * 0.6, smp.z + Math.cos(ang) * dist), w: h * 0.12, h, c: pick(), ry: r() * 6.3, tilt: (r() - 0.5) * 0.3 });
    }
    const spireMesh = new THREE.InstancedMesh(crystalGeo, cMat, spires.length);
    spires.forEach((it, i) => {
      q.setFromEuler(e.set(it.tilt, it.ry, it.tilt * 0.6));
      m4.compose(it.p, q, sc.set(it.w, it.h / 1.7, it.w));
      spireMesh.setMatrixAt(i, m4);
      spireMesh.setColorAt(i, it.c);
    });
    this.group.add(spireMesh);
    const rockMesh = new THREE.InstancedMesh(rockGeometry(7), rockMaterial(), rocks.length);
    rocks.forEach((it, i) => {
      q.setFromEuler(e.set(0, it.ry, 0));
      m4.compose(it.p, q, sc.set(it.s, it.s, it.s));
      rockMesh.setMatrixAt(i, m4);
    });
    this.group.add(rockMesh);

    // --- the Nebula Spiral's heart: a giant crystal core, and orbital rings round it
    const sp = T.sections[secOf('Nebula Spiral')];
    const a0 = S[Math.round(sp.s0 / T.step) + 2];
    const R = 230;
    this.coreAt.set(a0.x + Math.cos(a0.h) * R, a0.y - 30, a0.z - Math.sin(a0.h) * R);
    this.coreMat = crystalMaterial();
    this.coreMat.color.set(0x8b7cff);
    const coreGeo = crystalGeometry(8);
    const colors = new Float32Array(coreGeo.getAttribute('position').count * 3).fill(1);
    for (let i = 0; i < colors.length; i += 3) { colors[i] = 0.62; colors[i + 1] = 0.45; colors[i + 2] = 1.1; }
    coreGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.coreMat.vertexColors = true;
    // a towering cluster: one great crystal and four leaning round it, rising out of the void
    this.core = new THREE.Group();
    this.core.position.copy(this.coreAt);
    for (const [ang, lean, w, h] of [[0, 0, 95, 250], [0.4, 0.34, 48, 150], [2.0, 0.42, 42, 125], [3.5, 0.3, 55, 160], [5.0, 0.5, 38, 110]] as const) {
      const m = new THREE.Mesh(coreGeo, this.coreMat);
      const off = lean ? 52 : 0;
      m.position.set(Math.sin(ang) * off, -h * 0.55 - 40, Math.cos(ang) * off);
      m.rotation.set(Math.cos(ang) * lean, ang, -Math.sin(ang) * lean);
      m.scale.set(w, h, w);
      this.core.add(m);
    }
    this.group.add(this.core);
    for (const [k, tilt] of [[0, 0.4], [1, -0.7], [2, 1.2]] as const) {
      const mat = new THREE.ShaderMaterial({ vertexShader: uvVertex, fragmentShader: glowRingFragment, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
        uniforms: { uColor: { value: new THREE.Color(k === 1 ? 0.3 : 0.8, k === 1 ? 1.2 : 0.45, 1.6) }, uTime: { value: 0 }, uAlpha: { value: 0.9 } } });
      this.timed.push(mat);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(120 + k * 28, 0.9 + k * 0.4, 8, 220), mat);
      ring.position.copy(this.coreAt).setY(this.coreAt.y + 20 + k * 12);
      ring.rotation.set(Math.PI / 2 + tilt * 0.3, tilt, 0);
      this.orbits.push(ring);
      this.group.add(ring);
    }
    // --- vast rings of disturbed spacetime far out, and the auroras
    for (const [si, R2, col] of [[4, 560, [0.5, 0.3, 1.2]], [7, 700, [0.25, 0.8, 1.1]], [1, 480, [0.9, 0.3, 0.9]]] as const) {
      const s0 = T.sections[si];
      const mid = S[Math.round((s0.s0 + s0.s1) / 2 / T.step)];
      const mat = new THREE.ShaderMaterial({ vertexShader: uvVertex, fragmentShader: glowRingFragment, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, toneMapped: false,
        uniforms: { uColor: { value: new THREE.Color(col[0], col[1], col[2]) }, uTime: { value: 0 }, uAlpha: { value: 0.35 } } });
      this.timed.push(mat);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(R2, 3.5, 6, 260), mat);
      ring.position.set(mid.x + Math.cos(mid.h) * (R2 + 420), mid.y + 120, mid.z - Math.sin(mid.h) * (R2 + 420));
      ring.rotation.set(1.1, mid.h, 0.3);
      this.group.add(ring);
    }
    this.group.add(this.auroras(r));
  }

  /** Curtains of light over the course, well out to one side and high above it. */
  private auroras(r: () => number): THREE.Mesh {
    const T = this.data.track, S = T.samples;
    const pos: number[] = [], uv: number[] = [], at: number[] = [], idx: number[] = [];
    const spans: [number, number, number, number, number][] = [
      // [from s, to s, side, offset, height]
      [150, 1200, 1, 260, 170], [1300, 2300, -1, 300, 200], [2600, 3500, 1, 340, 230], [3200, 4400, -1, 420, 260], [4700, 5600, 1, 300, 190], [5500, 6300, -1, 260, 160],
    ];
    for (const [a, b, side, off, H] of spans) {
      const i0 = Math.max(0, Math.round(a / T.step)), i1 = Math.min(S.length - 1, Math.round(b / T.step));
      let along = 0, prev: THREE.Vector3 | null = null, base = -1;
      const lift = 70 + r() * 60;
      for (let i = i0; i <= i1; i += 8) {
        at.push((i - i0) / (i1 - i0), (i - i0) / (i1 - i0));
        const q = S[i];
        const x = q.x + Math.cos(q.h) * off * side, z = q.z - Math.sin(q.h) * off * side, y = q.y + lift;
        if (prev) along += Math.hypot(x - prev.x, z - prev.z);
        prev = new THREE.Vector3(x, y, z);
        const k = pos.length / 3;
        pos.push(x, y, z, x, y + H, z);
        uv.push(along, 0, along, 1);
        if (base >= 0) idx.push(base, k, base + 1, base + 1, k, k + 1);
        base = k;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('aT', new THREE.Float32BufferAttribute(at, 1));
    g.setIndex(idx);
    const mat = new THREE.ShaderMaterial({ vertexShader: auroraVertex, fragmentShader: auroraFragment, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false, toneMapped: false, uniforms: { uTime: { value: 0 } } });
    this.timed.push(mat);
    const m = new THREE.Mesh(g, mat);
    m.frustumCulled = false;
    m.renderOrder = -5;
    return m;
  }

  update(time: number) {
    for (const m of this.timed) m.uniforms.uTime.value = time;
    for (let i = 0; i < this.orbits.length; i++) this.orbits[i].rotation.z = time * (0.02 + i * 0.013) * (i % 2 ? -1 : 1);
    this.core.rotation.y = time * 0.05;
    // the core breathes
    this.coreMat.emissiveIntensity = 0.85 + 0.3 * Math.sin(time * 1.3);
  }
}

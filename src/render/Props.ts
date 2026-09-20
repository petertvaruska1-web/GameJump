// Decorative props (pipes, tanks, lamps, antennas, cables, chimneys...) baked
// into merged meshes per material, plus a few animated bits (blinking lights,
// chimney smoke, the finish beacon).

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { LevelData, PropDef } from '../../shared/level/types';
import { rng } from '../../shared/math';
import { withColor } from './geometry';
import { Materials } from './Materials';

type Bucket = { mat: THREE.Material; geos: THREE.BufferGeometry[]; shadow: boolean };

const UP = new THREE.Vector3(0, 1, 0);

export class PropsView {
  readonly group = new THREE.Group();
  private buckets = new Map<THREE.Material, Bucket>();
  private redSprites: THREE.Sprite[] = [];
  private smoke: { s: THREE.Sprite; base: THREE.Vector3; t: number; speed: number }[] = [];
  private beacon: { beam: THREE.Mesh; ring: THREE.Mesh; halo: THREE.Sprite; mat: THREE.ShaderMaterial } | null = null;
  private extraMats = new Map<string, THREE.Material>();
  private r = rng(4242);

  constructor(level: LevelData, private mats: Materials, shadows: boolean) {
    for (const p of level.props) this.addProp(p);
    for (const b of this.buckets.values()) {
      if (!b.geos.length) continue;
      const merged = mergeGeometries(b.geos, false);
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, b.mat);
      mesh.castShadow = shadows && b.shadow;
      mesh.receiveShadow = shadows && b.shadow;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      for (const g of b.geos) g.dispose();
    }
  }

  private mat(name: string, make: () => THREE.Material): THREE.Material {
    let m = this.extraMats.get(name);
    if (!m) { m = make(); this.extraMats.set(name, m); }
    return m;
  }

  private add(geo: THREE.BufferGeometry, mat: THREE.Material, m: THREE.Matrix4, shade = 1, shadow = true) {
    const g = geo.index ? geo.clone() : geo.clone();
    g.applyMatrix4(m);
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    withColor(g, shade);
    const ng = g.index ? g : g;
    let b = this.buckets.get(mat);
    if (!b) { b = { mat, geos: [], shadow }; this.buckets.set(mat, b); }
    b.geos.push(ng);
  }

  private m4(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
  }

  private between(a: THREE.Vector3, b: THREE.Vector3, radius: number): THREE.Matrix4 {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize());
    return new THREE.Matrix4().compose(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5), q, new THREE.Vector3(radius, len, radius));
  }

  private glowSprite(x: number, y: number, z: number, color: number, size: number, fog = true) {
    const m = new THREE.SpriteMaterial({ map: this.mats.glowTex, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog });
    const s = new THREE.Sprite(m);
    s.position.set(x, y, z);
    s.scale.setScalar(size);
    this.group.add(s);
    return s;
  }

  private addProp(p: PropDef) {
    const M = this.mats;
    const [x, y, z] = p.p;
    const ry = p.ry ?? 0;
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 12, 1);
    const cyl6 = new THREE.CylinderGeometry(1, 1, 1, 6, 1);
    const box = new THREE.BoxGeometry(1, 1, 1);
    switch (p.t) {
      case 'pipe': {
        const q = p.q!;
        const r = p.s?.[0] ?? 0.6;
        const a = new THREE.Vector3(x, y, z), b = new THREE.Vector3(q[0], q[1], q[2]);
        this.add(cyl, M.get('pipe'), this.between(a, b, r), 1);
        const len = a.distanceTo(b);
        for (let d = 3; d < len - 1; d += 6) {
          const f = d / len;
          const c = a.clone().lerp(b, f);
          const c2 = a.clone().lerp(b, f + 0.3 / len);
          this.add(cyl, M.get('steel'), this.between(c, c2, r * 1.12), 1);
        }
        break;
      }
      case 'tank': {
        const r = p.s?.[0] ?? 2, h = p.s?.[1] ?? 4;
        const core = p.v === 1;
        this.add(cyl, M.get(core ? 'concreteDark' : 'tank'), this.m4(x, y + h / 2, z, 0, 0, 0, r, h, r), 1);
        this.add(cyl, M.get('steel'), this.m4(x, y + h + 0.15, z, 0, 0, 0, r * 0.9, 0.3, r * 0.9), 1);
        if (core) {
          for (let yy = 4; yy < h - 1; yy += 5) this.add(cyl, M.cyanLight, this.m4(x, y + yy, z, 0, 0, 0, r * 1.03, 0.45, r * 1.03), 1, false);
          this.add(cyl, M.cyanLight, this.m4(x, y + h + 0.35, z, 0, 0, 0, r * 0.5, 0.25, r * 0.5), 1, false);
          this.glowSprite(x, y + h + 1.5, z, 0x5ef0ff, 16);
        } else {
          for (let yy = 1; yy < h; yy += 1.6) this.add(cyl, M.get('steel'), this.m4(x, y + yy, z, 0, 0, 0, r * 1.02, 0.12, r * 1.02), 1);
        }
        break;
      }
      case 'chimney': {
        const r = p.s?.[0] ?? 2, h = p.s?.[1] ?? 60;
        this.add(cyl, M.get('concreteDark'), this.m4(x, y + h / 2, z, 0, 0, 0, r, h, r), 1);
        for (let k = 0; k < 3; k++) this.add(cyl, M.get(k === 1 ? 'white' : 'hazard'), this.m4(x, y + h - 1 - k * 1.6, z, 0, 0, 0, r * 1.04, 1.4, r * 1.04), 1);
        for (let i = 0; i < 7; i++) {
          const sm = new THREE.SpriteMaterial({ map: smokeTexture(), color: 0xb9b3aa, transparent: true, depthWrite: false, opacity: 0.5 });
          const s = new THREE.Sprite(sm);
          this.group.add(s);
          this.smoke.push({ s, base: new THREE.Vector3(x, y + h + 0.5, z), t: i / 7, speed: 0.07 + this.r() * 0.03 });
        }
        break;
      }
      case 'antenna': {
        const h = p.s?.[1] ?? 6;
        this.add(cyl6, M.get('steel'), this.m4(x, y + h / 2, z, 0, 0, 0, 0.07, h, 0.07), 1);
        for (let k = 1; k <= 2; k++) this.add(box, M.get('steel'), this.m4(x, y + h * (0.55 + k * 0.15), z, 0, ry + k, 0, 1.2 - k * 0.3, 0.05, 0.05), 1);
        this.addRedLight(x, y + h + 0.1, z);
        break;
      }
      case 'redLight':
        this.addRedLight(x, y, z);
        break;
      case 'lamp': {
        this.add(cyl6, M.get('steel'), this.m4(x, y + 1.6, z, 0, 0, 0, 0.06, 3.2, 0.06), 1);
        this.add(box, M.get('steel'), this.m4(x, y + 3.2, z, 0, 0, 0, 0.5, 0.18, 0.3), 1);
        this.add(box, M.warmLight, this.m4(x, y + 3.1, z, 0, 0, 0, 0.42, 0.04, 0.24), 1, false);
        (this.glowSprite(x, y + 3.0, z, 0xffc47a, 1.3).material as THREE.SpriteMaterial).opacity = 0.7;
        break;
      }
      case 'crate': {
        const s = p.s ?? [1.2, 1.2, 1.2];
        this.add(box, M.get('crate'), this.m4(x, y + s[1] / 2, z, 0, ry, 0, s[0], s[1], s[2]), 0.9 + this.r() * 0.2);
        break;
      }
      case 'barrel': {
        const red = this.r() > 0.5;
        const mat = this.mat(red ? 'barrelR' : 'barrelB', () => new THREE.MeshStandardMaterial({ color: red ? 0x9c3b2a : 0x3b5d7a, roughness: 0.6, metalness: 0.4, vertexColors: true }));
        this.add(cyl, mat, this.m4(x, y + 0.47, z, 0, 0, 0, 0.33, 0.94, 0.33), 1);
        this.add(cyl, M.get('steel'), this.m4(x, y + 0.3, z, 0, 0, 0, 0.345, 0.05, 0.345), 1);
        this.add(cyl, M.get('steel'), this.m4(x, y + 0.66, z, 0, 0, 0, 0.345, 0.05, 0.345), 1);
        break;
      }
      case 'cable': {
        const q = p.q!;
        const a = new THREE.Vector3(x, y, z), b = new THREE.Vector3(q[0], q[1], q[2]);
        const len = a.distanceTo(b);
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i <= 8; i++) {
          const f = i / 8;
          const pt = a.clone().lerp(b, f);
          pt.y -= Math.sin(f * Math.PI) * len * 0.035;
          pts.push(pt);
        }
        const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.035, 4, false);
        this.add(tube, M.get('steel'), new THREE.Matrix4(), 0.6, false);
        break;
      }
      case 'dish': {
        const bowl = new THREE.SphereGeometry(1.6, 14, 6, 0, Math.PI * 2, 0, 0.9);
        const dm = this.mat('dish', () => new THREE.MeshStandardMaterial({ color: 0xd8dcd6, roughness: 0.5, metalness: 0.2, side: THREE.DoubleSide, vertexColors: true }));
        this.add(cyl6, M.get('steel'), this.m4(x, y + 1, z, 0, 0, 0, 0.12, 2, 0.12), 1);
        const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y + 2.4, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2 - 0.6, ry, 0, 'YXZ')), new THREE.Vector3(1, 1, 1));
        this.add(bowl, dm, m, 1);
        break;
      }
      case 'windsock': {
        const wm = this.mat('sock', () => new THREE.MeshStandardMaterial({ color: 0xff6a2a, roughness: 0.8, vertexColors: true, side: THREE.DoubleSide }));
        this.add(cyl6, M.get('steel'), this.m4(x, y + 2, z, 0, 0, 0, 0.05, 4, 0.05), 1);
        const cone = new THREE.CylinderGeometry(0.28, 0.12, 1.6, 8, 1, true);
        this.add(cone, wm, this.m4(x + 0.8, y + 3.8, z, 0, 0, Math.PI / 2 + 0.25, 1, 1, 1), 1);
        break;
      }
      case 'debris': {
        const n = p.v === 1 ? 0 : 3;
        for (let i = 0; i < n; i++) {
          const s = 0.4 + this.r() * 0.9;
          this.add(box, M.get('concrete'), this.m4(x + (this.r() - 0.5) * 1.6, y + 0.1 + this.r() * 0.3, z + (this.r() - 0.5) * 1.6, this.r() * 1.2, ry + this.r() * 3, this.r() * 1.2, s * 1.4, s * 0.35, s), 0.85);
          this.add(cyl6, M.get('rust'), this.m4(x + (this.r() - 0.5) * 2, y + 0.3, z + (this.r() - 0.5) * 2, this.r() * 2, 0, this.r() * 2, 0.04, 1.4 + this.r(), 0.04), 1);
        }
        if (p.v === 1) {
          // dead tree in a planter
          const tm = this.mat('tree', () => new THREE.MeshStandardMaterial({ color: 0x4a3b30, roughness: 1, vertexColors: true }));
          this.add(cyl6, tm, this.m4(x, y + 1.1, z, 0.05, 0, 0.08, 0.09, 2.2, 0.09), 1);
          for (let i = 0; i < 4; i++) {
            const a = this.r() * Math.PI * 2;
            this.add(cyl6, tm, this.m4(x + Math.sin(a) * 0.35, y + 1.8 + this.r() * 0.5, z + Math.cos(a) * 0.35, Math.cos(a) * 0.9, 0, -Math.sin(a) * 0.9, 0.04, 1.0, 0.04), 1);
          }
        }
        break;
      }
      case 'beacon':
        this.addBeacon(x, y, z);
        break;
      default:
        break;
    }
  }

  private addRedLight(x: number, y: number, z: number) {
    this.add(new THREE.SphereGeometry(0.14, 8, 6), this.mats.redLight, this.m4(x, y, z), 1, false);
    this.redSprites.push(this.glowSprite(x, y, z, 0xff3030, 2.2));
  }

  private addBeacon(x: number, y: number, z: number) {
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0.35, 0.95, 1.0) } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform float uTime; uniform vec3 uColor; varying vec2 vUv;
        void main(){
          float h = vUv.y;
          float fade = pow(1.0 - h, 1.6);
          float edge = sin(vUv.x * 3.14159 * 2.0 * 3.0 + uTime * 0.6) * 0.08 + 0.92;
          float pulse = 0.75 + 0.25 * sin(uTime * 2.2 - h * 30.0);
          gl_FragColor = vec4(uColor * fade * edge * pulse * 0.55, 1.0);
        }`,
    });
    const beamGeo = new THREE.CylinderGeometry(6, 2.2, 420, 24, 1, true);
    beamGeo.translate(0, 210, 0);
    const beam = new THREE.Mesh(beamGeo, mat);
    beam.position.set(x, y + 0.2, z);
    beam.frustumCulled = false;
    beam.renderOrder = 5;
    this.group.add(beam);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(4.3, 0.09, 6, 48), this.mats.cyanLight);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(x, y + 0.3, z);
    this.group.add(ring);
    const halo = this.glowSprite(x, y + 8, z, 0x7ff6ff, 34, false);
    halo.renderOrder = 6;
    this.beacon = { beam, ring, halo, mat };
  }

  update(t: number, dt: number) {
    const blink = (Math.sin(t * 3.2) > 0.2 ? 1 : 0.15);
    this.mats.redLight.color.setRGB(3 * blink + 0.3, 0.25 * blink, 0.2 * blink);
    for (const s of this.redSprites) (s.material as THREE.SpriteMaterial).opacity = 0.2 + blink * 0.8;
    for (const p of this.smoke) {
      p.t = (p.t + dt * p.speed) % 1;
      const k = p.t;
      p.s.position.set(p.base.x + k * 9 + Math.sin(k * 6 + p.base.z) * 1.2, p.base.y + k * 14, p.base.z + k * 3);
      p.s.scale.setScalar(3 + k * 13);
      (p.s.material as THREE.SpriteMaterial).opacity = Math.sin(k * Math.PI) * 0.35;
    }
    if (this.beacon) {
      this.beacon.mat.uniforms.uTime.value = t;
      this.beacon.ring.scale.setScalar(1 + Math.sin(t * 2.2) * 0.06);
      (this.beacon.halo.material as THREE.SpriteMaterial).opacity = 0.65 + Math.sin(t * 2.2) * 0.25;
    }
  }
}

let smokeTex: THREE.Texture | null = null;
function smokeTexture(): THREE.Texture {
  if (smokeTex) return smokeTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const r = rng(77);
  for (let i = 0; i < 26; i++) {
    const x = 16 + r() * 32, y = 16 + r() * 32, rad = 8 + r() * 14;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, 'rgba(255,255,255,0.28)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  }
  smokeTex = new THREE.CanvasTexture(c);
  smokeTex.colorSpace = THREE.SRGBColorSpace;
  return smokeTex;
}

// Particles (single draw call), projectile visuals, ambient air motes and wind
// gust streaks. Everything is pooled; nothing allocates per frame.

import * as THREE from 'three';
import { gustFactor, gustLead } from '../../shared/hazards';
import type { LevelData } from '../../shared/level/types';
import type { CollisionWorld, RayHit } from '../../shared/physics/world';

const MAX = 1400;

export class Particles {
  readonly points: THREE.Points;
  private pos = new Float32Array(MAX * 3);
  private col = new Float32Array(MAX * 4);
  private size = new Float32Array(MAX);
  private vel = new Float32Array(MAX * 3);
  private life = new Float32Array(MAX);
  private maxLife = new Float32Array(MAX);
  private base = new Float32Array(MAX * 4);
  private grav = new Float32Array(MAX);
  private grow = new Float32Array(MAX);
  private next = 0;
  private geo: THREE.BufferGeometry;

  constructor() {
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false,
      uniforms: { uScale: { value: window.innerHeight / 2 } },
      vertexShader: `attribute float size; attribute vec4 color; varying vec4 vC; uniform float uScale;
        void main(){ vC = color; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = size * uScale / max(0.1, -mv.z); gl_Position = projectionMatrix*mv; }`,
      fragmentShader: `varying vec4 vC; void main(){ vec2 d = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.0, length(d)); gl_FragColor = vec4(vC.rgb, vC.a * a); }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    window.addEventListener('resize', () => { mat.uniforms.uScale.value = window.innerHeight / 2; });
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, r: number, g: number, b: number, a: number, gravity = 0, grow = 0) {
    const i = this.next;
    this.next = (this.next + 1) % MAX;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = life; this.maxLife[i] = life;
    this.size[i] = size;
    this.base[i * 4] = r; this.base[i * 4 + 1] = g; this.base[i * 4 + 2] = b; this.base[i * 4 + 3] = a;
    this.grav[i] = gravity; this.grow[i] = grow;
  }

  burst(x: number, y: number, z: number, n: number, speed: number, life: number, size: number, rgb: [number, number, number], a = 0.8, gravity = 0, up = 0) {
    for (let k = 0; k < n; k++) {
      const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
      const s = speed * (0.4 + Math.random() * 0.6);
      this.emit(x, y, z, Math.sin(ph) * Math.cos(th) * s, Math.abs(Math.cos(ph)) * s * 0.6 + up, Math.sin(ph) * Math.sin(th) * s,
        life * (0.6 + Math.random() * 0.6), size * (0.7 + Math.random() * 0.6), rgb[0], rgb[1], rgb[2], a, gravity, size * 0.8);
    }
  }

  dust(x: number, y: number, z: number, strength: number) {
    const n = Math.round(6 + strength * 16);
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const s = 1.2 + Math.random() * 2.5 * (0.5 + strength);
      this.emit(x + Math.cos(a) * 0.2, y + 0.05, z + Math.sin(a) * 0.2, Math.cos(a) * s, 0.3 + Math.random() * 0.8, Math.sin(a) * s,
        0.5 + Math.random() * 0.5, 0.35 + Math.random() * 0.3, 0.78, 0.74, 0.68, 0.45, -1.5, 1.6);
    }
  }

  update(dt: number) {
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) { if (this.col[i * 4 + 3] !== 0) this.col[i * 4 + 3] = 0; continue; }
      this.life[i] -= dt;
      const k = Math.max(0, this.life[i] / this.maxLife[i]);
      this.vel[i * 3 + 1] -= this.grav[i] * dt;
      const drag = 1 - Math.min(1, dt * 1.8);
      this.vel[i * 3] *= drag; this.vel[i * 3 + 2] *= drag;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] += this.grow[i] * dt;
      this.col[i * 4] = this.base[i * 4];
      this.col[i * 4 + 1] = this.base[i * 4 + 1];
      this.col[i * 4 + 2] = this.base[i * 4 + 2];
      this.col[i * 4 + 3] = this.base[i * 4 + 3] * Math.min(1, k * 2.2);
    }
    (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('size') as THREE.BufferAttribute).needsUpdate = true;
  }
}

interface ProjVis { id: number; mesh: THREE.Mesh; p0: THREE.Vector3; v: THREE.Vector3; t0: number; alive: boolean; last: THREE.Vector3 }

export class Effects {
  readonly group = new THREE.Group();
  readonly particles = new Particles();
  private projectiles = new Map<number, ProjVis>();
  private projGeo = new THREE.SphereGeometry(0.28, 12, 8);
  private projMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 0.5, 1.1), toneMapped: false });
  private motes: THREE.Points;
  private motePos: Float32Array;
  private readonly hit: RayHit = { dist: 0, c: null };
  onProjectileEnd?: (x: number, y: number, z: number, hit: boolean) => void;

  constructor(private glowTex: THREE.Texture, private level: LevelData) {
    this.group.add(this.particles.points);
    // ambient air motes around the camera
    const n = 220;
    this.motePos = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) this.motePos[i] = (Math.random() - 0.5) * 40;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.motePos, 3).setUsage(THREE.DynamicDrawUsage));
    this.motes = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 0.06, transparent: true, opacity: 0.55, depthWrite: false }));
    this.motes.frustumCulled = false;
    this.group.add(this.motes);
  }

  spawnProjectile(id: number, p: [number, number, number], v: [number, number, number], t0: number) {
    const mesh = new THREE.Mesh(this.projGeo, this.projMat);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: 0xff3a8a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.scale.setScalar(2.2);
    mesh.add(glow);
    mesh.position.set(p[0], p[1], p[2]);
    this.group.add(mesh);
    this.projectiles.set(id, { id, mesh, p0: new THREE.Vector3(...p), v: new THREE.Vector3(...v), t0, alive: true, last: new THREE.Vector3(...p) });
    this.particles.burst(p[0], p[1], p[2], 10, 3, 0.35, 0.5, [1, 0.35, 0.7], 0.9);
  }

  endProjectile(id: number, p: [number, number, number], hit: boolean) {
    const pr = this.projectiles.get(id);
    if (pr) { this.group.remove(pr.mesh); this.projectiles.delete(id); }
    this.particles.burst(p[0], p[1], p[2], hit ? 40 : 22, hit ? 9 : 6, 0.6, 0.45, [1, 0.4, 0.75], 1, 6);
    this.onProjectileEnd?.(p[0], p[1], p[2], hit);
  }

  clearProjectiles() {
    for (const p of this.projectiles.values()) this.group.remove(p.mesh);
    this.projectiles.clear();
  }

  get projectileList() { return this.projectiles.values(); }

  update(dt: number, matchTime: number, cam: THREE.Camera, world: CollisionWorld, playerVel: THREE.Vector3) {
    // projectiles: deterministic flight from their spawn event
    for (const pr of this.projectiles.values()) {
      const age = matchTime - pr.t0;
      const x = pr.p0.x + pr.v.x * age, y = pr.p0.y + pr.v.y * age, z = pr.p0.z + pr.v.z * age;
      const dx = x - pr.last.x, dy = y - pr.last.y, dz = z - pr.last.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > 0.001 && age > 0) {
        world.raycast(pr.last.x, pr.last.y, pr.last.z, dx / d, dy / d, dz / d, d, false, this.hit);
        if (this.hit.c) {
          const hx = pr.last.x + (dx / d) * this.hit.dist, hy = pr.last.y + (dy / d) * this.hit.dist, hz = pr.last.z + (dz / d) * this.hit.dist;
          this.endProjectile(pr.id, [hx, hy, hz], false);
          continue;
        }
      }
      pr.last.set(x, y, z);
      pr.mesh.position.set(x, y, z);
      pr.mesh.visible = age >= 0;
      if (age > 0) this.particles.emit(x, y, z, 0, 0, 0, 0.35, 0.45, 1, 0.3, 0.65, 0.7, 0, -0.8);
      if (age > 4.5) { this.group.remove(pr.mesh); this.projectiles.delete(pr.id); }
    }
    // wind gusts: streaks inside active zones (+ a faint warning before)
    for (const w of this.level.winds) {
      const f = gustFactor(w, matchTime);
      const lead = gustLead(w, matchTime);
      const warn = lead > 0 && lead < 0.9 ? (0.9 - lead) * 0.35 : 0;
      const rate = f * 90 + warn * 40;
      const n = Math.floor(rate * dt + Math.random());
      for (let k = 0; k < n; k++) {
        const x = w.min[0] + Math.random() * (w.max[0] - w.min[0]) - w.dir[0] * 6;
        const y = w.min[1] + Math.random() * (w.max[1] - w.min[1] + 3);
        const z = w.min[2] + Math.random() * (w.max[2] - w.min[2]) - w.dir[1] * 6;
        const s = 14 + Math.random() * 8;
        this.particles.emit(x, y, z, w.dir[0] * s, (Math.random() - 0.5) * 0.6, w.dir[1] * s, 0.9, 0.12, 0.92, 0.95, 1, 0.55 * Math.max(f, warn), 0, 0);
      }
    }
    // motes wrap around the camera and stream past when moving fast
    const cp = cam.position;
    const arr = this.motePos;
    for (let i = 0; i < arr.length; i += 3) {
      arr[i] -= playerVel.x * dt * 0.15 - dt * 0.6;
      arr[i + 1] -= playerVel.y * dt * 0.15 + dt * 0.1;
      arr[i + 2] -= playerVel.z * dt * 0.15;
      for (let k = 0; k < 3; k++) {
        const c = k === 0 ? cp.x : k === 1 ? cp.y : cp.z;
        let rel = arr[i + k] - c;
        if (rel > 20) rel -= 40; else if (rel < -20) rel += 40;
        arr[i + k] = c + rel;
      }
    }
    (this.motes.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.particles.update(dt);
  }
}

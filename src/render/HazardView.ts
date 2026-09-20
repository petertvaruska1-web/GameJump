// Visuals for the interactive obstacles: laser beams (instanced, driven by the
// shared match clock), zip-line cables, scrolling conveyor belt surfaces,
// pulsing launch pads, grapple anchors and grapple ropes.

import * as THREE from 'three';
import { LASER } from '../../shared/constants';
import { laserBeam, laserLead, laserOn, type Beam } from '../../shared/hazards';
import type { LevelData } from '../../shared/level/types';
import type { Materials } from './Materials';

const UP = new THREE.Vector3(0, 1, 0);
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpD = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpM = new THREE.Matrix4();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

interface BeltVis { tex: THREE.Texture; speed: number; repeat: number }

export class HazardView {
  readonly group = new THREE.Group();
  private cores: THREE.InstancedMesh | null = null;
  private glows: THREE.InstancedMesh | null = null;
  private emitters: THREE.InstancedMesh | null = null;
  private belts: BeltVis[] = [];
  private padMat: THREE.MeshBasicMaterial | null = null;
  private readonly beam: Beam = { ax: 0, az: 0, bx: 0, bz: 0, y: 0 };
  /** Laser group -> was on last frame (for switch-on sounds). */
  private groupOn = new Map<number, boolean>();
  /** Index of the first beam of each gate (the one that reports switch-ons). */
  private groupLead = new Set<number>();
  /** Groups that switched on this frame, with a representative position. */
  readonly switchedOn: THREE.Vector3[] = [];
  private anchors: { ring: THREE.Mesh; core: THREE.Mesh; glow: THREE.Sprite; base: number }[] = [];
  private anchorMat!: THREE.MeshBasicMaterial;
  private anchorHot!: THREE.MeshBasicMaterial;
  private ropes: THREE.Mesh[] = [];
  private targeted = -1;
  private hookedIds = new Set<number>();

  constructor(private level: LevelData, mats: Materials) {
    this.buildLasers();
    this.buildCables();
    this.buildBelts(mats);
    this.buildPads(mats);
    this.buildAnchors(mats);
  }

  private buildAnchors(mats: Materials) {
    this.anchorMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.4, 2.2, 0.35), toneMapped: false });
    this.anchorHot = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 3, 1.2), toneMapped: false });
    const ringGeo = new THREE.TorusGeometry(0.38, 0.07, 8, 20);
    const coreGeo = new THREE.IcosahedronGeometry(0.13, 1);
    for (const g of this.level.grapples) {
      const base = g.optional ? 0.8 : 1;
      const ring = new THREE.Mesh(ringGeo, this.anchorMat);
      ring.position.set(g.p[0], g.p[1], g.p[2]);
      ring.scale.setScalar(base);
      const core = new THREE.Mesh(coreGeo, this.anchorMat);
      core.position.copy(ring.position);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: mats.glowTex, color: 0xc8ff5a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.55 }));
      glow.position.copy(ring.position);
      glow.scale.setScalar(2.2 * base);
      this.group.add(ring, core, glow);
      this.anchors.push({ ring, core, glow, base });
    }
    const ropeMat = new THREE.MeshStandardMaterial({ color: 0x1d2228, roughness: 0.6, metalness: 0.3, emissive: new THREE.Color(0x2a3a10), emissiveIntensity: 0.6 });
    for (let i = 0; i < 3; i++) {
      const r = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 1, 5, 1, true), ropeMat);
      r.visible = false;
      r.frustumCulled = false;
      this.group.add(r);
      this.ropes.push(r);
    }
  }

  /** Anchor under the grapple reticle (-1: none). */
  setTargeted(id: number) { this.targeted = id; }

  /** Rope `i` from a hand to an anchor (null hides it). */
  setRope(i: number, from: THREE.Vector3 | null, anchorId = -1) {
    const r = this.ropes[i];
    const g = anchorId >= 0 ? this.level.grapples[anchorId] : null;
    if (!r) return;
    if (!from || !g) { r.visible = false; return; }
    tmpA.copy(from);
    tmpB.set(g.p[0], g.p[1], g.p[2]);
    tmpD.subVectors(tmpB, tmpA);
    const len = tmpD.length();
    if (len < 0.05) { r.visible = false; return; }
    r.visible = true;
    r.position.addVectors(tmpA, tmpB).multiplyScalar(0.5);
    r.quaternion.setFromUnitVectors(UP, tmpD.normalize());
    r.scale.set(1, len, 1);
    this.hookedIds.add(anchorId);
  }

  private buildLasers() {
    const n = this.level.lasers.length;
    if (!n) return;
    const core = new THREE.CylinderGeometry(0.022, 0.022, 1, 6, 1, true);
    const glow = new THREE.CylinderGeometry(0.1, 0.1, 1, 8, 1, true);
    this.cores = new THREE.InstancedMesh(core, new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 0.35, 0.3), toneMapped: false }), n);
    this.glows = new THREE.InstancedMesh(glow, new THREE.MeshBasicMaterial({
      color: new THREE.Color(1, 0.12, 0.1), transparent: true, opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    }), n);
    this.emitters = new THREE.InstancedMesh(new THREE.BoxGeometry(0.16, 0.12, 0.16), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.9, 0.12, 0.1), toneMapped: false }), n * 2);
    for (const m of [this.cores, this.glows, this.emitters]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      this.group.add(m);
    }
    this.glows.renderOrder = 4;
    const seen = new Set<number>();
    this.level.lasers.forEach((l, i) => { if (!seen.has(l.group)) { seen.add(l.group); this.groupLead.add(i); } });
  }

  private buildCables() {
    const geos: THREE.BufferGeometry[] = [];
    for (const z of this.level.ziplines) {
      const a = new THREE.Vector3(...z.a), b = new THREE.Vector3(...z.b);
      const len = a.distanceTo(b);
      const g = new THREE.CylinderGeometry(0.045, 0.045, len, 6, 1, true);
      const q = new THREE.Quaternion().setFromUnitVectors(UP, tmpD.subVectors(b, a).normalize());
      g.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)));
      geos.push(g);
      // bright markers every 6 m so the cable reads against the sky
      for (let d = 3; d < len - 1; d += 6) {
        const m = new THREE.CylinderGeometry(0.075, 0.075, 0.22, 8);
        const p = a.clone().lerp(b, d / len);
        m.applyMatrix4(new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1)));
        geos.push(m);
      }
    }
    if (!geos.length) return;
    const merged = mergeAll(geos);
    const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.4, metalness: 0.8, emissive: new THREE.Color(0x3a2a10), emissiveIntensity: 0.6 }));
    mesh.castShadow = false;
    this.group.add(mesh);
  }

  private buildBelts(mats: Materials) {
    for (const box of this.level.boxes) {
      if (!box.belt) continue;
      const [w, h, d] = box.s;
      const rise = box.rise ?? 0;
      const surfLen = Math.hypot(d, rise);
      const tex = mats.tex('belt').clone();
      tex.needsUpdate = true;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      // negative speeds mirror the texture so the chevrons (and the scroll) point backward
      const repeat = surfLen / 1.6;
      tex.repeat.set(Math.max(1, Math.round(w / 1.6)), box.belt < 0 ? -repeat : repeat);
      const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0.1 });
      const g = new THREE.PlaneGeometry(w - 0.05, surfLen);
      // plane lies flat with +V toward local +Z (the belt's forward direction)
      g.rotateX(-Math.PI / 2);
      g.rotateY(Math.PI);
      if (rise) g.rotateX(-Math.atan2(rise, d));
      const mesh = new THREE.Mesh(g, mat);
      mesh.position.set(box.p[0], box.p[1] + h / 2 + rise / 2 + 0.015, box.p[2]);
      mesh.rotation.y = box.ry;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.belts.push({ tex, speed: Math.abs(box.belt), repeat: 1.6 });
    }
  }

  private buildPads(mats: Materials) {
    const pads = this.level.boxes.filter((b) => b.launch);
    if (!pads.length) return;
    const tex = mats.tex('launchPad');
    this.padMat = new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(1.4, 1.4, 1.4), toneMapped: false });
    for (const box of pads) {
      const g = new THREE.PlaneGeometry(box.s[0] - 0.1, box.s[2] - 0.1);
      g.rotateX(-Math.PI / 2);
      g.rotateY(Math.PI);
      const mesh = new THREE.Mesh(g, this.padMat);
      mesh.position.set(box.p[0], box.p[1] + box.s[1] / 2 + 0.012, box.p[2]);
      mesh.rotation.y = box.ry;
      this.group.add(mesh);
    }
  }

  update(t: number) {
    // anchors: gentle spin, the targeted one grows and brightens
    for (let i = 0; i < this.anchors.length; i++) {
      const a = this.anchors[i];
      const hot = i === this.targeted || this.hookedIds.has(i);
      const s = a.base * (hot ? 1.35 + Math.sin(t * 10) * 0.08 : 1);
      a.ring.scale.setScalar(s);
      a.ring.rotation.y = t * 1.3 + i;
      a.ring.material = hot ? this.anchorHot : this.anchorMat;
      a.core.material = a.ring.material;
      (a.glow.material as THREE.SpriteMaterial).opacity = hot ? 0.95 : 0.45 + Math.sin(t * 2.5 + i) * 0.1;
      a.glow.scale.setScalar(a.base * (hot ? 3.2 : 2.2));
    }
    this.hookedIds.clear();
    // belts scroll toward their forward direction
    for (const b of this.belts) b.tex.offset.y = -((t * b.speed) / b.repeat) % 1;
    if (this.padMat) {
      const k = 1.1 + Math.sin(t * 5) * 0.35;
      this.padMat.color.setRGB(k, k, k);
    }
    this.switchedOn.length = 0;
    if (!this.cores || !this.glows || !this.emitters) return;
    const lasers = this.level.lasers;
    const flick = Math.sin(t * 60) > 0;
    for (let i = 0; i < lasers.length; i++) {
      const l = lasers[i];
      const bm = laserBeam(l, t, this.beam);
      tmpA.set(bm.ax, bm.y, bm.az);
      tmpB.set(bm.bx, bm.y, bm.bz);
      const on = laserOn(l, t);
      const warn = !on && laserLead(l, t) < LASER.WARN;
      // emitters at both ends
      tmpM.makeTranslation(tmpA.x, tmpA.y, tmpA.z);
      this.emitters.setMatrixAt(i * 2, tmpM);
      tmpM.makeTranslation(tmpB.x, tmpB.y, tmpB.z);
      this.emitters.setMatrixAt(i * 2 + 1, tmpM);
      if (on || (warn && flick)) {
        tmpD.subVectors(tmpB, tmpA);
        const len = tmpD.length();
        tmpQ.setFromUnitVectors(UP, tmpD.normalize());
        const mid = tmpA.add(tmpB).multiplyScalar(0.5);
        tmpS.set(on ? 1 : 0.45, len, on ? 1 : 0.45);
        tmpM.compose(mid, tmpQ, tmpS);
        this.cores.setMatrixAt(i, tmpM);
        if (on) this.glows.setMatrixAt(i, tmpM); else this.glows.setMatrixAt(i, ZERO);
      } else {
        this.cores.setMatrixAt(i, ZERO);
        this.glows.setMatrixAt(i, ZERO);
      }
      if (this.groupLead.has(i)) {
        if (l.cycle && on && this.groupOn.get(l.group) === false) this.switchedOn.push(new THREE.Vector3((bm.ax + bm.bx) / 2, bm.y, (bm.az + bm.bz) / 2));
        this.groupOn.set(l.group, on);
      }
    }
    this.cores.instanceMatrix.needsUpdate = true;
    this.glows.instanceMatrix.needsUpdate = true;
    this.emitters.instanceMatrix.needsUpdate = true;
  }
}

function mergeAll(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // tiny merge (positions + normals) without pulling in BufferGeometryUtils here
  let count = 0;
  for (const g of geos) count += (g.index ? g.index.count : g.getAttribute('position').count);
  const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3);
  let o = 0;
  for (const g of geos) {
    const p = g.getAttribute('position'), n = g.getAttribute('normal');
    const idx = g.index;
    const m = idx ? idx.count : p.count;
    for (let k = 0; k < m; k++) {
      const i = idx ? idx.getX(k) : k;
      pos[o * 3] = p.getX(i); pos[o * 3 + 1] = p.getY(i); pos[o * 3 + 2] = p.getZ(i);
      nor[o * 3] = n.getX(i); nor[o * 3 + 1] = n.getY(i); nor[o * 3 + 2] = n.getZ(i);
      o++;
    }
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.computeBoundingSphere();
  return out;
}

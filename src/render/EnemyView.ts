// Visuals for the three enemy types. Silhouettes are deliberately distinct:
//  - Stalker (melee): tall, thin, hunched dark runner with burning orange eyes
//  - Sentinel (ranged): tripod turret with a big lens and a sweeping searchlight
//  - Drone (flyer): four-rotor hunter with a red eye and a downward spotlight
// State is readable at a glance: "!" when hunting, "?" when searching, and
// lights shift from calm amber to red.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { EnemyKind } from '../../shared/constants';
import { ENEMY } from '../../shared/constants';
import { clamp, damp } from '../../shared/math';
import { EState } from '../../shared/protocol';

const icons = new Map<string, THREE.Texture>();
function iconTex(ch: string, color: string): THREE.Texture {
  const key = ch + color;
  let t = icons.get(key);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(10,10,14,0.6)';
  ctx.beginPath(); ctx.arc(32, 32, 26, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = 'bold 40px Arial, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(ch, 32, 35);
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  icons.set(key, t);
  return t;
}

/** Additive light beam that fades from the lens outward. */
function beamMaterial(color: number, len: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: 0.1 }, uLen: { value: len } },
    vertexShader: 'varying float vD; void main(){ vD = length(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 uColor; uniform float uOpacity; uniform float uLen; varying float vD; void main(){ float k = 1.0 - clamp(vD / uLen, 0.0, 1.0); gl_FragColor = vec4(uColor * uOpacity * k * k, 1.0); }',
  });
}

/**
 * Level of detail. Past FAR_AT an enemy is a handful of pixels, so its dozen
 * jointed parts are swapped for one merged mesh of its rest pose (its glowing eye,
 * lens and searchlight stay live, so its state still reads). Past HIDE_AT it is a
 * fogged two-pixel speck and is not drawn at all. Each switch has a few metres of
 * hysteresis so nothing flickers at the boundary.
 */
const FAR_AT = 115, NEAR_AT = 105;
const HIDE_AT = 330, SHOW_AT = 310;
/** Searchlights ignore fog, so they fade out with distance before the enemy is hidden. */
const BEAM_FADE_FROM = 200, BEAM_FADE_TO = 300;

const farGeo = new Map<EnemyKind, THREE.BufferGeometry>();
const farMat = new Map<EnemyKind, THREE.MeshStandardMaterial>();

const CALM = new THREE.Color(1.6, 1.0, 0.35);
const ANGRY = new THREE.Color(3.0, 0.25, 0.15);
const SEARCH = new THREE.Color(2.2, 1.6, 0.2);

export class EnemyView {
  readonly root = new THREE.Group();
  private model = new THREE.Group();
  private icon: THREE.Sprite;
  private eyeMat: THREE.MeshBasicMaterial;
  private coneMat: THREE.ShaderMaterial | null = null;
  private cone: THREE.Mesh | null = null;
  private head: THREE.Object3D | null = null;
  private limbs: THREE.Object3D[] = [];
  private rotors: THREE.Object3D[] = [];
  private orb: THREE.Mesh | null = null;
  private phase = Math.random() * 10;
  private lastPos = new THREE.Vector3();
  private speed = 0;
  private color = CALM.clone();
  /** Jointed parts that the far mesh stands in for. */
  private detail: THREE.Mesh[] = [];
  private far: THREE.Mesh | null = null;
  private isFar = false;
  private culled = false;
  private beamFade = 1;
  state: number = EState.Idle;

  constructor(readonly kind: EnemyKind, shadows: boolean, glowTex: THREE.Texture) {
    this.eyeMat = new THREE.MeshBasicMaterial({ color: CALM.clone(), toneMapped: false });
    this.root.add(this.model);
    if (kind === 'melee') this.buildStalker(shadows);
    else if (kind === 'ranged') this.buildSentinel(shadows, glowTex);
    else this.buildDrone(shadows);
    this.buildFar();
    this.icon = new THREE.Sprite(new THREE.SpriteMaterial({ map: iconTex('!', '#ff4040'), transparent: true, depthWrite: false, depthTest: false }));
    this.icon.scale.setScalar(0.9);
    this.icon.position.y = kind === 'melee' ? 2.8 : kind === 'ranged' ? 3.6 : 1.4;
    this.icon.renderOrder = 21;
    this.icon.visible = false;
    this.root.add(this.icon);
  }

  /**
   * Merges the plain parts hanging directly off one joint into one mesh per
   * material, so authored detail (plates, fins, claws, bolts) costs no more
   * draw calls than the bare capsules it replaced.
   */
  private bake(parent: THREE.Object3D, shadows: boolean) {
    const by = new Map<THREE.Material, THREE.Mesh[]>();
    for (const c of parent.children) {
      const m = c as THREE.Mesh;
      if (!m.isMesh || m === this.cone || m === this.orb || this.rotors.includes(m)) continue;
      const mat = m.material as THREE.Material;
      if (mat.transparent || (mat as THREE.ShaderMaterial).isShaderMaterial) continue;
      const list = by.get(mat) ?? [];
      list.push(m);
      by.set(mat, list);
    }
    for (const [mat, list] of by) {
      if (list.length < 2) continue;
      const geos = list.map((m) => {
        m.updateMatrix();
        const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
        for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
        g.applyMatrix4(m.matrix);
        return g;
      });
      const merged = new THREE.Mesh(mergeGeometries(geos, false)!, mat);
      geos.forEach((g) => g.dispose());
      merged.castShadow = shadows;
      for (const m of list) parent.remove(m);
      parent.add(merged);
    }
  }

  /** A mesh placed at `p`, optionally rotated and scaled, added to `parent`. */
  private part(g: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D, p: [number, number, number], r?: [number, number, number], s?: [number, number, number]) {
    const o = new THREE.Mesh(g, mat);
    o.position.set(...p);
    if (r) o.rotation.set(...r);
    if (s) o.scale.set(...s);
    parent.add(o);
    return o;
  }

  private buildStalker(shadows: boolean) {
    // tall, thin, hunched: dark armour over a skeletal frame, a narrow angular
    // helmet with one burning slit, plates on the shoulders and a ridge of fins
    // down the spine that makes the hunch read even as a silhouette
    const body = new THREE.MeshStandardMaterial({ color: 0x22252c, roughness: 0.55, metalness: 0.5 });
    const plate = new THREE.MeshStandardMaterial({ color: 0x3a3f4a, roughness: 0.5, metalness: 0.6 });
    const P = this.part.bind(this);
    const hips = new THREE.Group(); hips.position.y = 1.1; this.model.add(hips);
    P(new THREE.BoxGeometry(0.34, 0.16, 0.22), plate, hips, [0, 0.02, 0]);
    const torso = new THREE.Group(); hips.add(torso); torso.rotation.x = 0.35;
    P(new THREE.CapsuleGeometry(0.2, 0.5, 3, 8), body, torso, [0, 0.45, 0], undefined, [1.2, 1, 0.7]);
    P(new THREE.CylinderGeometry(0.05, 0.07, 0.18, 6), body, torso, [0, 0.88, 0.04]);
    P(new THREE.BoxGeometry(0.46, 0.16, 0.3), plate, torso, [0, 0.7, 0]);
    P(new THREE.BoxGeometry(0.3, 0.3, 0.07), plate, torso, [0, 0.46, 0.13], [-0.12, 0, 0]);
    for (const s of [1, -1]) P(new THREE.BoxGeometry(0.2, 0.1, 0.28), plate, torso, [0.29 * s, 0.8, 0], [0, 0, -0.42 * s]);
    for (let i = 0; i < 3; i++) P(new THREE.BoxGeometry(0.035, 0.13 - i * 0.02, 0.15), plate, torso, [0, 0.36 + i * 0.17, -0.17], [0.55, 0, 0]);
    const head = new THREE.Group(); head.position.set(0, 0.95, 0.08); torso.add(head);
    // hexagonal helmet, flat face forward, pinched at the crown
    P(new THREE.CylinderGeometry(0.1, 0.13, 0.26, 6, 1, false, Math.PI / 6), body, head, [0, 0.1, 0], undefined, [1, 1, 1.18]);
    P(new THREE.BoxGeometry(0.2, 0.045, 0.08), plate, head, [0, 0.17, 0.1], [0.25, 0, 0]);
    P(new THREE.BoxGeometry(0.12, 0.06, 0.09), plate, head, [0, 0.0, 0.09], [0.35, 0, 0]);
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.04, 0.02), this.eyeMat); eye.position.set(0, 0.125, 0.122); head.add(eye);
    this.head = head;
    const limbs: THREE.Object3D[] = [];
    for (const s of [1, -1]) {
      const sh = new THREE.Group(); sh.position.set(0.28 * s, 0.75, 0); torso.add(sh);
      P(new THREE.CapsuleGeometry(0.06, 0.45, 2, 6), body, sh, [0, -0.3, 0]);
      P(new THREE.IcosahedronGeometry(0.068, 0), body, sh, [0, -0.58, 0]);
      const fore = new THREE.Group(); fore.position.y = -0.58; sh.add(fore);
      P(new THREE.CapsuleGeometry(0.05, 0.45, 2, 6), plate, fore, [0, -0.28, 0]);
      P(new THREE.BoxGeometry(0.1, 0.2, 0.1), plate, fore, [0, -0.2, 0.01]);
      // three hooked claws instead of one spike
      for (const cx of [-0.035, 0, 0.035]) P(new THREE.ConeGeometry(0.022, 0.2, 4), plate, fore, [cx, -0.6, 0.03], [Math.PI - 0.25, 0, cx * 4]);
      const hip = new THREE.Group(); hip.position.set(0.13 * s, 0, 0); hips.add(hip);
      P(new THREE.CapsuleGeometry(0.075, 0.42, 2, 6), body, hip, [0, -0.28, 0]);
      P(new THREE.BoxGeometry(0.1, 0.13, 0.07), body, hip, [0, -0.54, 0.07], [0.2, 0, 0]);
      const knee = new THREE.Group(); knee.position.y = -0.55; hip.add(knee);
      P(new THREE.CapsuleGeometry(0.06, 0.42, 2, 6), plate, knee, [0, -0.27, 0]);
      // clawed foot: a narrow wedge sole reaching forward
      P(new THREE.BoxGeometry(0.1, 0.06, 0.26), plate, knee, [0, -0.54, 0.06]);
      P(new THREE.ConeGeometry(0.04, 0.12, 4), plate, knee, [0, -0.55, 0.22], [Math.PI / 2, 0, 0]);
      limbs.push(sh, fore, hip, knee);
    }
    this.limbs = limbs;
    for (const g of [hips, torso, head, ...limbs]) this.bake(g, shadows);
  }

  private buildSentinel(shadows: boolean, glowTex: THREE.Texture) {
    // a surveillance turret on a splayed tripod: feet planted wide, a collar
    // where the legs meet, a turret ring, and a boxy camera head with a hooded
    // lens, twin barrels, cooling fins and an aerial whose tip glows with its mood
    const metal = new THREE.MeshStandardMaterial({ color: 0xcfd3d6, roughness: 0.45, metalness: 0.5 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x252a31, roughness: 0.5, metalness: 0.6 });
    const P = this.part.bind(this);
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + Math.PI / 3;
      const top = new THREE.Vector3(Math.sin(a) * 0.16, 1.45, Math.cos(a) * 0.16);
      const foot = new THREE.Vector3(Math.sin(a) * 0.72, 0.04, Math.cos(a) * 0.72);
      const dir = foot.clone().sub(top);
      const len = dir.length();
      const leg = P(new THREE.CylinderGeometry(0.05, 0.075, len, 6), dark, this.model, [(top.x + foot.x) / 2, (top.y + foot.y) / 2, (top.z + foot.z) / 2]);
      // the cylinder's +Y end is the thin one: point it up the leg, toward the collar
      leg.quaternion.setFromUnitVectors(up, dir.normalize().negate());
      P(new THREE.CylinderGeometry(0.11, 0.13, 0.06, 8), dark, this.model, [foot.x, 0.03, foot.z]);
    }
    P(new THREE.CylinderGeometry(0.2, 0.24, 0.22, 8), dark, this.model, [0, 1.45, 0]);
    P(new THREE.CylinderGeometry(0.15, 0.2, 0.42, 8), dark, this.model, [0, 1.74, 0]);
    P(new THREE.CylinderGeometry(0.3, 0.3, 0.07, 14), metal, this.model, [0, 1.96, 0]);
    const head = new THREE.Group(); head.position.y = 2.2; this.model.add(head);
    P(new THREE.BoxGeometry(0.75, 0.55, 0.9), metal, head, [0, 0.05, 0]);
    P(new THREE.BoxGeometry(0.8, 0.12, 0.95), dark, head, [0, 0.36, 0]);
    for (const s of [1, -1]) P(new THREE.BoxGeometry(0.06, 0.42, 0.62), dark, head, [0.4 * s, 0.02, -0.05]);
    for (let i = 0; i < 3; i++) P(new THREE.BoxGeometry(0.6, 0.05, 0.1), dark, head, [0, -0.12 + i * 0.13, -0.49]);
    P(new THREE.TorusGeometry(0.25, 0.045, 6, 18), dark, head, [0, 0.08, 0.47]);
    for (const s of [1, -1]) P(new THREE.CylinderGeometry(0.045, 0.045, 0.46, 6), dark, head, [0.2 * s, -0.19, 0.58], [Math.PI / 2, 0, 0]);
    P(new THREE.CylinderGeometry(0.012, 0.016, 0.55, 4), dark, head, [-0.27, 0.66, -0.3]);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.12, 14), this.eyeMat);
    lens.rotation.x = Math.PI / 2; lens.position.set(0, 0.08, 0.48); head.add(lens);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), this.eyeMat);
    tip.position.set(-0.27, 0.95, -0.3); head.add(tip);
    // searchlight cone showing where it is looking
    const len = ENEMY.ranged.viewDist * 0.5;
    const half = (ENEMY.ranged.fovDeg * Math.PI) / 360;
    const cg = new THREE.ConeGeometry(Math.tan(half * 0.55) * len, len, 20, 1, true);
    cg.translate(0, -len / 2, 0);
    cg.rotateX(-Math.PI / 2);
    this.coneMat = beamMaterial(0xffd88a, len);
    this.cone = new THREE.Mesh(cg, this.coneMat);
    this.cone.position.set(0, 0.08, 0.5);
    this.cone.rotation.x = 0.18;
    head.add(this.cone);
    const orbMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.4, 0.8), toneMapped: false, transparent: true });
    this.orb = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), orbMat);
    this.orb.position.set(0, 0.08, 0.7);
    head.add(this.orb);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xff4080, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.scale.setScalar(1.6);
    this.orb.add(glow);
    this.head = head;
    this.bake(this.model, shadows);
    this.bake(head, shadows);
  }

  private buildDrone(shadows: boolean) {
    // a four-rotor hunter: armoured hull with a sensor dome, a ringed eye up
    // front, motor pods under guarded rotors and a tail light
    const shell = new THREE.MeshStandardMaterial({ color: 0x2e343d, roughness: 0.4, metalness: 0.7 });
    const trim = new THREE.MeshStandardMaterial({ color: 0xb8bec6, roughness: 0.5, metalness: 0.5 });
    const P = this.part.bind(this);
    P(new THREE.OctahedronGeometry(0.55, 0), shell, this.model, [0, 0, 0], undefined, [1.2, 0.55, 1.2]);
    P(new THREE.SphereGeometry(0.3, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), trim, this.model, [0, 0.1, -0.05], undefined, [1, 0.7, 1.1]);
    P(new THREE.CylinderGeometry(0.17, 0.11, 0.16, 8), shell, this.model, [0, -0.27, 0]);
    P(new THREE.TorusGeometry(0.17, 0.035, 6, 14), trim, this.model, [0, -0.08, 0.53]);
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      P(new THREE.BoxGeometry(0.08, 0.06, 0.8), trim, this.model, [Math.sin(a) * 0.55, 0.05, Math.cos(a) * 0.55], [0, a, 0]);
      P(new THREE.CylinderGeometry(0.07, 0.09, 0.16, 8), shell, this.model, [Math.sin(a) * 0.95, 0.05, Math.cos(a) * 0.95]);
      P(new THREE.TorusGeometry(0.37, 0.022, 4, 20), trim, this.model, [Math.sin(a) * 0.95, 0.14, Math.cos(a) * 0.95], [Math.PI / 2, 0, 0]);
      const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.02, 10), new THREE.MeshBasicMaterial({ color: 0x9aa4b0, transparent: true, opacity: 0.45 }));
      rotor.position.set(Math.sin(a) * 0.95, 0.14, Math.cos(a) * 0.95);
      this.model.add(rotor);
      this.rotors.push(rotor);
    }
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), this.eyeMat);
    eye.position.set(0, -0.08, 0.55);
    this.model.add(eye);
    const tail = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 4), this.eyeMat);
    tail.position.set(0, 0.02, -0.66);
    this.model.add(tail);
    const len = 9;
    const cg = new THREE.ConeGeometry(2.6, len, 16, 1, true);
    cg.translate(0, -len / 2, 0);
    this.coneMat = beamMaterial(0xff6a4a, len);
    this.cone = new THREE.Mesh(cg, this.coneMat);
    this.cone.rotation.x = -0.75;
    this.cone.position.set(0, -0.1, 0.3);
    this.model.add(this.cone);
    this.bake(this.model, shadows);
  }

  /** Merges the opaque parts, as posed at rest, into one vertex-coloured mesh (shared per kind). */
  private buildFar() {
    const parts: THREE.Mesh[] = [];
    this.model.updateMatrixWorld(true);
    this.model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mat = m.material as THREE.Material;
      if (mat.transparent || mat === this.eyeMat || m === this.cone || m === this.orb || !(mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) return;
      parts.push(m);
    });
    this.detail = parts;
    let geo = farGeo.get(this.kind);
    if (!geo) {
      const geos = parts.map((m) => {
        const g = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone());
        for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
        g.applyMatrix4(m.matrixWorld);
        const c = (m.material as THREE.MeshStandardMaterial).color;
        const n = g.getAttribute('position').count;
        const col = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        return g;
      });
      geo = mergeGeometries(geos, false)!;
      geos.forEach((g) => g.dispose());
      geo.computeBoundingSphere();
      farGeo.set(this.kind, geo);
      farMat.set(this.kind, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.5 }));
    }
    this.far = new THREE.Mesh(geo, farMat.get(this.kind)!);
    this.far.visible = false;
    this.model.add(this.far);
  }

  /** Picks near / far / hidden from the distance to the camera. */
  private lod(camDist: number) {
    const cull = this.culled ? camDist > SHOW_AT : camDist > HIDE_AT;
    if (cull !== this.culled) { this.culled = cull; this.root.visible = !cull; }
    const far = this.isFar ? camDist > NEAR_AT : camDist > FAR_AT;
    if (far !== this.isFar) {
      this.isFar = far;
      for (const m of this.detail) m.visible = !far;
      for (const r of this.rotors) r.visible = !far;
      if (this.far) this.far.visible = far;
      if (far) {
        // hold the rest pose the far mesh was built from
        this.model.position.set(0, 0, 0);
        this.model.rotation.set(0, 0, 0);
      }
    }
    this.beamFade = 1 - Math.min(1, Math.max(0, (camDist - BEAM_FADE_FROM) / (BEAM_FADE_TO - BEAM_FADE_FROM)));
  }

  /** Called every render frame with interpolated server state. */
  update(pos: THREE.Vector3, yaw: number, state: number, aux: number, dt: number, t: number, camDist = 0) {
    this.lod(camDist);
    if (this.culled) { this.root.position.copy(pos); this.lastPos.copy(pos); this.state = state; return; }
    if (dt > 0) {
      const v = this.lastPos.distanceTo(pos) / dt;
      this.speed += (Math.min(v, 15) - this.speed) * damp(8, dt);
    }
    this.lastPos.copy(pos);
    this.root.position.copy(pos);
    this.state = state;
    const hunting = state === EState.Chase || state === EState.Alert || state === EState.Attack;
    const searching = state === EState.Search;
    const target = hunting ? ANGRY : searching ? SEARCH : CALM;
    this.color.lerp(target, damp(6, dt));
    this.eyeMat.color.copy(this.color);

    if (this.kind === 'ranged') {
      this.root.rotation.y = 0;
      if (this.head) this.head.rotation.y = yaw;
      if (this.coneMat) {
        this.coneMat.uniforms.uColor.value.setRGB(this.color.r / 3, this.color.g / 3, this.color.b / 3);
        this.coneMat.uniforms.uOpacity.value = (hunting ? 0.5 + aux * 0.5 : 0.32) * this.beamFade;
      }
      if (this.orb) {
        this.orb.visible = aux > 0.02;
        this.orb.scale.setScalar(0.3 + aux * 1.1 + Math.sin(t * 40) * 0.05 * aux);
      }
    } else if (this.kind === 'flyer') {
      this.root.rotation.y = yaw;
      if (!this.isFar) {
        this.model.position.y = Math.sin(t * 2.4 + this.phase) * 0.18;
        this.model.rotation.x = clamp(this.speed * 0.04, 0, 0.35);
        for (const r of this.rotors) r.rotation.y += dt * 40;
      }
      if (this.coneMat) this.coneMat.uniforms.uOpacity.value = (hunting ? 0.45 : 0.22) * this.beamFade;
    } else {
      this.root.rotation.y = yaw;
      if (!this.isFar) this.animateStalker(dt, t, hunting, state === EState.Attack);
    }

    this.icon.visible = hunting || searching;
    const mat = this.icon.material as THREE.SpriteMaterial;
    const want = searching ? iconTex('?', '#ffc233') : iconTex('!', '#ff4040');
    if (mat.map !== want) { mat.map = want; mat.needsUpdate = true; }
    const pulse = state === EState.Alert ? 1 + Math.sin(t * 20) * 0.15 : 1;
    this.icon.scale.setScalar(0.9 * pulse);
  }

  private animateStalker(dt: number, t: number, hunting: boolean, attacking: boolean) {
    const sp = this.speed;
    this.phase += dt * (sp * 1.4 + (sp > 0.3 ? 1.5 : 0));
    const s = Math.sin(this.phase);
    const runW = clamp(sp / 3, 0, 1);
    const [shL, foreL, hipL, kneeL, shR, foreR, hipR, kneeR] = this.limbs;
    const amp = 0.5 + runW * 0.5;
    hipL.rotation.x = -s * amp * runW; hipR.rotation.x = s * amp * runW;
    kneeL.rotation.x = 0.2 + Math.max(0, Math.sin(this.phase + 1.9)) * 1.2 * runW;
    kneeR.rotation.x = 0.2 + Math.max(0, Math.sin(this.phase + 1.9 + Math.PI)) * 1.2 * runW;
    if (attacking) {
      shL.rotation.x = shR.rotation.x = -1.9; foreL.rotation.x = foreR.rotation.x = -0.3;
    } else if (hunting && runW > 0.5) {
      shL.rotation.x = -1.2 + s * 0.3; shR.rotation.x = -1.2 - s * 0.3;
      foreL.rotation.x = foreR.rotation.x = -0.4;
    } else {
      shL.rotation.x = s * 0.5 * runW + Math.sin(t * 1.3) * 0.05; shR.rotation.x = -s * 0.5 * runW - Math.sin(t * 1.3) * 0.05;
      foreL.rotation.x = foreR.rotation.x = -0.3 - runW * 0.4;
    }
    this.model.position.y = Math.abs(Math.cos(this.phase)) * 0.08 * runW;
    if (this.head) this.head.rotation.y = hunting ? 0 : Math.sin(t * 0.7 + this.phase * 0.1) * 0.6;
  }
}

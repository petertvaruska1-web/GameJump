// The Warden's bots and the loose things in its arena, on screen.
//
// Skitters are low, fast crab machines in the Warden's own colours (dark plate,
// hazard-orange armour, one red eye): they scuttle on four legs, rear up with
// the eye flaring before they lunge, tumble when they are hit and struggle when
// they are held. Wasps hover on two rotor rings with a stinger cannon slung
// underneath that glows as it charges. Both read at a glance from each other,
// from the Warden and from the runners.
//
// Loose things: explosive canisters (red, striped, a warm light pulsing in the
// cap so they read as dangerous to be near), the Warden's own yellow armour
// plates, and its mortar shells, glowing at the tail.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, damp } from '../../shared/math';
import { BotKind, BotState, JunkKind } from '../../shared/protocol';

type Bag = Map<THREE.Material, THREE.BufferGeometry[]>;
function put(bag: Bag, g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const q = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(q.attributes)) if (k !== 'position' && k !== 'normal') q.deleteAttribute(k);
  q.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)).setPosition(x, y, z));
  const l = bag.get(m) ?? [];
  l.push(q);
  bag.set(m, l);
}
function flush(bag: Bag, parent: THREE.Object3D, shadows: boolean) {
  for (const [m, l] of bag) {
    const mesh = new THREE.Mesh(mergeGeometries(l, false)!, m);
    mesh.castShadow = shadows && !(m instanceof THREE.MeshBasicMaterial);
    parent.add(mesh);
  }
  bag.clear();
}

/** Shared materials (every bot flashes on its own, so the flashing parts are per bot). */
const MAT = {
  plate: new THREE.MeshStandardMaterial({ color: 0x2a2f37, roughness: 0.45, metalness: 0.7 }),
  armor: new THREE.MeshStandardMaterial({ color: 0xd8641f, roughness: 0.55, metalness: 0.35 }),
  yellow: new THREE.MeshStandardMaterial({ color: 0xd8a52a, roughness: 0.55, metalness: 0.35 }),
  joint: new THREE.MeshStandardMaterial({ color: 0x14171b, roughness: 0.6, metalness: 0.5 }),
  rotor: new THREE.MeshBasicMaterial({ color: 0x9aa4b0, transparent: true, opacity: 0.35, depthWrite: false }),
};

export class BotView {
  readonly root = new THREE.Group();
  private readonly model = new THREE.Group();
  private readonly legs: THREE.Group[] = [];
  private readonly rotors: THREE.Object3D[] = [];
  private readonly eyeMat: THREE.MeshBasicMaterial;
  private readonly glow: THREE.Sprite;
  private readonly flashMat: THREE.MeshStandardMaterial;
  private phase = Math.random() * 10;
  private flash = 0;
  private tumble = 0;
  private readonly last = new THREE.Vector3();
  private speed = 0;

  constructor(readonly kind: number, glowTex: THREE.Texture, shadows: boolean) {
    this.root.add(this.model);
    this.eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.35, 0.2), toneMapped: false });
    // the body flashes on a hit (its own material, so one bot's flash is not every bot's)
    this.flashMat = (kind === BotKind.Skitter ? MAT.armor : MAT.yellow).clone();
    this.flashMat.emissive = new THREE.Color(0);
    const bag: Bag = new Map();
    if (kind === BotKind.Skitter) {
      // a low hex shell, an orange carapace, mandibles and one red eye
      put(bag, new THREE.CylinderGeometry(0.55, 0.62, 0.34, 6), MAT.plate, 0, 0.55, 0);
      put(bag, new THREE.SphereGeometry(0.5, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), this.flashMat, 0, 0.7, -0.05);
      put(bag, new THREE.BoxGeometry(0.5, 0.12, 0.5), MAT.plate, 0, 1.0, -0.15);
      put(bag, new THREE.ConeGeometry(0.06, 0.55, 4), MAT.joint, 0, 1.2, -0.3, -0.3);
      for (const s of [-1, 1]) put(bag, new THREE.ConeGeometry(0.07, 0.42, 4), MAT.joint, s * 0.18, 0.46, 0.62, Math.PI / 2 + 0.35, 0, -s * 0.3);
      flush(bag, this.model, shadows);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), this.eyeMat);
      eye.position.set(0, 0.66, 0.52);
      this.model.add(eye);
      for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        const leg = new THREE.Group();
        leg.position.set(sx * 0.45, 0.58, sz * 0.3);
        leg.rotation.y = Math.atan2(sx, sz * 0.8);
        put(bag, new THREE.BoxGeometry(0.1, 0.1, 0.6), MAT.joint, 0, 0.12, 0.28, -0.45);
        put(bag, new THREE.BoxGeometry(0.08, 0.72, 0.08), MAT.plate, 0, -0.18, 0.58, 0.25);
        flush(bag, leg, shadows);
        this.legs.push(leg);
        this.model.add(leg);
      }
    } else {
      // a hovering body with yellow bands, two rotor rings and a stinger cannon underneath
      put(bag, new THREE.CapsuleGeometry(0.32, 0.7, 3, 8), MAT.plate, 0, 0, 0, Math.PI / 2);
      for (const z of [-0.2, 0.15]) put(bag, new THREE.CylinderGeometry(0.34, 0.34, 0.12, 10), this.flashMat, 0, 0, z, Math.PI / 2);
      for (const s of [-1, 1]) {
        put(bag, new THREE.BoxGeometry(0.7, 0.07, 0.12), MAT.joint, s * 0.45, 0.12, 0);
        put(bag, new THREE.TorusGeometry(0.42, 0.04, 5, 18), MAT.joint, s * 0.85, 0.14, 0, Math.PI / 2);
      }
      put(bag, new THREE.ConeGeometry(0.14, 0.7, 6), MAT.joint, 0, -0.35, 0.35, Math.PI / 2 + 0.5);
      flush(bag, this.model, shadows);
      for (const s of [-1, 1]) {
        const r = new THREE.Mesh(new THREE.CircleGeometry(0.38, 12), MAT.rotor);
        r.rotation.x = -Math.PI / 2;
        r.position.set(s * 0.85, 0.16, 0);
        this.model.add(r);
        this.rotors.push(r);
      }
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), this.eyeMat);
      eye.position.set(0, -0.52, 0.72);
      this.model.add(eye);
    }
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xff4020, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.6 }));
    this.glow.position.copy(kind === BotKind.Skitter ? new THREE.Vector3(0, 0.66, 0.55) : new THREE.Vector3(0, -0.52, 0.75));
    this.glow.scale.setScalar(0.8);
    this.model.add(this.glow);
  }

  hit() { this.flash = 1; this.tumble = Math.max(this.tumble, 0.6); }

  update(pos: THREE.Vector3, yaw: number, state: number, dt: number, t: number) {
    const r = this.root;
    if (dt > 0) this.speed += (Math.min(12, this.last.distanceTo(pos) / dt) - this.speed) * damp(8, dt);
    this.last.copy(pos);
    r.position.copy(pos);
    r.rotation.y = yaw;
    this.flash = Math.max(0, this.flash - dt * 5);
    this.flashMat.emissive.setRGB(this.flash * 2, this.flash * 1.6, this.flash * 1.2);
    const tell = state === BotState.Tell, reel = state === BotState.Reel, held = state === BotState.Held, flying = state === BotState.Flying;
    // eye: steady red, flaring before an attack
    const e = tell ? 3.5 + Math.sin(t * 40) * 1.5 : 1.6;
    this.eyeMat.color.setRGB(e, e * 0.12, e * 0.07);
    this.glow.scale.setScalar(tell ? 1.8 : 0.8);
    this.tumble = Math.max(0, this.tumble - dt * 1.5);
    if (this.kind === BotKind.Skitter) {
      this.phase += dt * (this.speed * 2.2 + 1);
      const run = clamp(this.speed / 4, 0, 1);
      this.legs.forEach((l, i) => {
        const s = Math.sin(this.phase * 2 + (i === 0 || i === 3 ? 0 : Math.PI));
        let lx = s * 0.5 * run, lz = 0;
        if (held || reel) { lx = Math.sin(t * 25 + i) * 0.6; lz = Math.cos(t * 21 + i) * 0.3; }
        if (flying) { lx = -0.9; }
        l.rotation.x = lx;
        l.rotation.z = lz;
      });
      // rearing up before a lunge; tumbling when knocked about
      const rear = tell ? -0.5 : state === BotState.Strike ? 0.25 : 0;
      this.model.rotation.x += (rear - this.model.rotation.x) * damp(12, dt);
      this.model.position.y = tell ? 0.12 : Math.abs(Math.sin(this.phase * 2)) * 0.05 * run;
      if (reel || held) { this.model.rotation.z = Math.sin(t * 9) * 0.6 * (held ? 1 : this.tumble + 0.3); } else this.model.rotation.z *= 1 - damp(8, dt);
    } else {
      for (const rot of this.rotors) rot.rotation.z += dt * 50;
      this.model.position.y = Math.sin(t * 3 + this.phase) * 0.12;
      this.model.rotation.x = clamp(this.speed * 0.04, 0, 0.3) - (tell ? 0.25 : 0);
      this.model.rotation.z = reel || held ? Math.sin(t * 11) * 0.7 : 0;
    }
  }

  dispose() {
    this.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
    this.flashMat.dispose();
    this.eyeMat.dispose();
    (this.glow.material as THREE.Material).dispose();
  }
}

// ------------------------------------------------------------------ loose things

let hazardTex: THREE.Texture | null = null;
function canisterTexture() {
  if (hazardTex) return hazardTex;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#b3261e'; g.fillRect(0, 0, 128, 128);
  // a hazard band round the middle and a warning glyph
  g.fillStyle = '#e9b52a'; g.fillRect(0, 48, 128, 32);
  g.fillStyle = '#16181c';
  for (let i = -2; i < 10; i++) { g.beginPath(); g.moveTo(i * 16, 48); g.lineTo(i * 16 + 8, 48); g.lineTo(i * 16 + 24, 80); g.lineTo(i * 16 + 16, 80); g.closePath(); g.fill(); }
  g.fillStyle = 'rgba(0,0,0,0.25)';
  for (let i = 0; i < 300; i++) g.fillRect(Math.random() * 128, Math.random() * 128, 2, 2);
  hazardTex = new THREE.CanvasTexture(c);
  hazardTex.colorSpace = THREE.SRGBColorSpace;
  return hazardTex;
}

const JUNK_MAT = {
  canister: new THREE.MeshStandardMaterial({ map: canisterTexture(), roughness: 0.5, metalness: 0.4 }),
  cap: new THREE.MeshStandardMaterial({ color: 0x2a2e35, roughness: 0.5, metalness: 0.7 }),
  plate: new THREE.MeshStandardMaterial({ color: 0xc89a2c, roughness: 0.6, metalness: 0.4 }),
  plateBack: new THREE.MeshStandardMaterial({ color: 0x33393f, roughness: 0.6, metalness: 0.6 }),
  shell: new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.45, metalness: 0.8 }),
  rock: new THREE.MeshStandardMaterial({ color: 0x5a5650, roughness: 0.95, metalness: 0.05, flatShading: true }),
  rockTop: new THREE.MeshStandardMaterial({ color: 0x3d4148, roughness: 0.7, metalness: 0.4, flatShading: true }),
};

/** A slab torn out of the forge floor: a jagged lump of concrete with a plate of the floor still on it. */
function rockGeometry(seed: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.62, 1);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  let r = seed * 9301 + 49297;
  const rnd = () => { r = (r * 9301 + 49297) % 233280; return r / 233280; };
  const seen = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    // shared corners move together, so the lump stays closed
    const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
    let k = seen.get(key);
    if (k === undefined) { k = 0.72 + rnd() * 0.5; seen.set(key, k); }
    pos.setXYZ(i, x * k * 1.25, y * k * 0.72, z * k);
  }
  g.computeVertexNormals();
  return g;
}

export class JunkView {
  readonly root = new THREE.Group();
  private readonly lamp: THREE.MeshBasicMaterial | null = null;
  private readonly glow: THREE.Sprite | null = null;

  constructor(readonly kind: number, glowTex: THREE.Texture, shadows: boolean) {
    const bag: Bag = new Map();
    if (kind === JunkKind.Canister) {
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 1.0, 14), JUNK_MAT.canister);
      body.position.y = 0.55; body.castShadow = shadows;
      this.root.add(body);
      put(bag, new THREE.CylinderGeometry(0.5, 0.5, 0.1, 14), JUNK_MAT.cap, 0, 0.06, 0);
      put(bag, new THREE.CylinderGeometry(0.5, 0.5, 0.1, 14), JUNK_MAT.cap, 0, 1.06, 0);
      put(bag, new THREE.CylinderGeometry(0.16, 0.2, 0.18, 8), JUNK_MAT.cap, 0, 1.18, 0);
      flush(bag, this.root, shadows);
      this.lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 1.2, 0.3), toneMapped: false });
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), this.lamp);
      lamp.position.y = 1.3;
      this.root.add(lamp);
      this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xff7a2a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.6 }));
      this.glow.position.y = 1.3;
      this.glow.scale.setScalar(1.2);
      this.root.add(this.glow);
    } else if (kind === JunkKind.Rock) {
      const body = new THREE.Mesh(rockGeometry(Math.floor(Math.random() * 1000)), JUNK_MAT.rock);
      body.castShadow = shadows;
      body.position.y = 0.42;
      this.root.add(body);
      const top = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.12, 0.85), JUNK_MAT.rockTop);
      top.position.y = 0.82; top.rotation.y = 0.3; top.castShadow = shadows;
      this.root.add(top);
      // the torn edge still glows with the forge's heat
      this.lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 0.9, 0.25), toneMapped: false });
      const seam = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.05, 4, 10), this.lamp);
      seam.rotation.x = Math.PI / 2; seam.position.y = 0.74;
      this.root.add(seam);
    } else if (kind === JunkKind.Plate) {
      put(bag, new THREE.BoxGeometry(1.9, 0.12, 1.3), JUNK_MAT.plate, 0, 0.18, 0);
      put(bag, new THREE.BoxGeometry(1.7, 0.12, 1.1), JUNK_MAT.plateBack, 0, 0.07, 0);
      put(bag, new THREE.BoxGeometry(0.25, 0.3, 0.25), JUNK_MAT.plateBack, 0.6, 0.2, 0.35);
      flush(bag, this.root, shadows);
    } else {
      put(bag, new THREE.CylinderGeometry(0.22, 0.26, 0.6, 10), JUNK_MAT.shell, 0, 0, 0, Math.PI / 2);
      put(bag, new THREE.ConeGeometry(0.22, 0.42, 10), JUNK_MAT.shell, 0, 0, 0.5, Math.PI / 2);
      flush(bag, this.root, shadows);
      this.lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.9, 0.25), toneMapped: false });
      const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.12, 10), this.lamp);
      tail.rotation.x = Math.PI / 2; tail.position.z = -0.34;
      this.root.add(tail);
      this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xff6a20, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.9 }));
      this.glow.position.z = -0.4;
      this.glow.scale.setScalar(1.6);
      this.root.add(this.glow);
    }
  }

  /** `held`: a runner holds it with telekinesis. `vel`: which way it is flying (shells point along it). */
  update(pos: THREE.Vector3, spin: number, vel: THREE.Vector3, held: boolean, t: number) {
    this.root.position.copy(pos);
    if (this.kind === JunkKind.Shell && vel.lengthSq() > 1 && !held) {
      this.root.lookAt(pos.x + vel.x, pos.y + vel.y, pos.z + vel.z);
    } else if (this.kind === JunkKind.Canister) {
      this.root.rotation.set(held ? Math.sin(spin) * 0.5 : Math.sin(spin * 0.7) * Math.min(1, spin * 0.2), spin * 0.6, held ? Math.cos(spin) * 0.4 : 0);
    } else {
      this.root.rotation.set(spin * 0.9, spin * 0.4, spin * 0.2);
    }
    if (this.lamp) {
      const k = this.kind === JunkKind.Canister ? 0.6 + 0.4 * Math.sin(t * (held ? 14 : 4)) : this.kind === JunkKind.Rock ? 0.6 + 0.2 * Math.sin(t * 9) : 1;
      this.lamp.color.setRGB(3 * k, 1.2 * k, 0.3 * k);
      if (this.glow) (this.glow.material as THREE.SpriteMaterial).opacity = 0.35 + 0.4 * k;
    }
  }

  dispose() {
    this.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
    this.lamp?.dispose();
    (this.glow?.material as THREE.Material | undefined)?.dispose();
  }
}

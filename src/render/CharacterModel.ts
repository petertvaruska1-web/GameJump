// Lightweight low-poly runner built from primitives, animated procedurally from
// speed / vertical velocity / movement state. Includes a trailing scarf so
// momentum reads clearly even at a distance.
//
// The gait is built to read as a person rather than a mechanism: ankles roll
// through each step, the hips sway and drop onto the loaded leg, the arms swing
// a beat behind the legs, the two sides are never exactly equal, and the head
// counter-rotates against the body so the eyeline stays level through leans,
// banks and turns.
//
// Locomotion is a directional blend, as in most third-person action games: the
// runner stays squared up to the camera and the gait shifts between running
// forward, side-stepping and backpedalling depending on which way it is actually
// travelling, instead of swinging the whole body round to face every input. A front flip turns the whole body about the hips (never the
// feet) and always completes its rotation, even when a landing cuts it short,
// so it can never snap back upright. Flying (Viktor's gift) tips the whole body
// about the same hip pivot: upright and floating when slow, stretched out flat
// with a fist forward at speed, banking into sideways flight.
//
// In the Warden's arena a runner's power shows on the body: the hands glow in
// its colour, a flash strike stretches the runner out flat, and the arms act out
// every use (a cast, a two-handed telekinetic hold, a throw, a push, a sonic
// blast thrust from both palms, a boom thrown out wide) laid over whatever the
// legs are doing, so it reads at a glance what everyone is up to. The angel wears
// wings, a sword and a halo (AngelRig): its sword combo is a rising cut, a
// reverse cut, a whirling spin with the wings flung wide and a two-handed
// overhead cleave; it glides tipped forward on spread wings, beats them with
// its legs dangling, and dives head-first with the sword out like a lance.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DASH, FLIP, FLY } from '../../shared/constants';
import { Anim } from '../../shared/physics/character';
import { clamp, damp, lerp } from '../../shared/math';
import { AngelRig } from './AngelRig';

export const PLAYER_COLORS = [0xff7a2f, 0x2fd4c4, 0xc65bff];
export const PLAYER_CSS = ['#ff7a2f', '#2fd4c4', '#c65bff'];
const ACCENTS = [0xffd08a, 0xb6fff6, 0xf0c6ff];

export interface AnimInput {
  speed: number;
  vy: number;
  anim: number;
  dt: number;
  /** Yaw change rate (rad/s) for banking. */
  turn: number;
  /** Direction of travel in the runner's own frame: +1 forward / -1 back, and +1 to its right. */
  fwd?: number;
  side?: number;
  /** 0..1 landing impact. */
  land: number;
  t: number;
  /** World-space velocity and whether the body is on the ground (drives the dead body's tumble). */
  vel?: { x: number; y: number; z: number };
  grounded?: boolean;
}

type Joint = THREE.Group;

/** A power's arm movement, laid over the rest of the pose (the left arm is index 0; the angel's sword is in the right). */
export type ActKind = 'rise' | 'reverse' | 'sweep' | 'cleave' | 'soar' | 'dive' | 'cast' | 'hold' | 'throw' | 'push' | 'blast' | 'boom';
/** How long each one plays (a hold lasts until it is thrown or let go). */
const ACT_TIME: Record<ActKind, number> = { rise: 0.34, reverse: 0.34, sweep: 0.46, cleave: 0.52, soar: 0.6, dive: 0.3, cast: 0.26, hold: 4.6, throw: 0.36, push: 0.38, blast: 0.34, boom: 0.5 };
const smooth = (a: number, b: number, x: number) => { const k = clamp((x - a) / (b - a), 0, 1); return k * k * (3 - 2 * k); };

let handTex: THREE.Texture | null = null;
/** A white glow the hands are tinted with. */
function handTexture(): THREE.Texture {
  if (handTex) return handTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  handTex = new THREE.CanvasTexture(c);
  handTex.colorSpace = THREE.SRGBColorSpace;
  return handTex;
}

const geoCache = new Map<string, THREE.BufferGeometry>();
function capsule(r: number, l: number) {
  const k = `c${r}_${l}`;
  let g = geoCache.get(k);
  if (!g) { g = new THREE.CapsuleGeometry(r, l, 3, 8); geoCache.set(k, g); }
  return g;
}
function box(w: number, h: number, d: number) {
  const k = `b${w}_${h}_${d}`;
  let g = geoCache.get(k);
  if (!g) { g = new THREE.BoxGeometry(w, h, d); geoCache.set(k, g); }
  return g;
}
let auraTex: THREE.Texture | null = null;
/** A soft warm glow for the flying aura (one texture for every runner). */
function auraTexture(): THREE.Texture {
  if (auraTex) return auraTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,240,200,0.9)');
  g.addColorStop(0.4, 'rgba(255,214,140,0.35)');
  g.addColorStop(1, 'rgba(255,200,120,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  auraTex = new THREE.CanvasTexture(c);
  auraTex.colorSpace = THREE.SRGBColorSpace;
  return auraTex;
}

function sphere(r: number) {
  const k = `s${r}`;
  let g = geoCache.get(k);
  if (!g) { g = new THREE.IcosahedronGeometry(r, 1); geoCache.set(k, g); }
  return g;
}

const TWO_PI = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);
const _up = new THREE.Vector3();
const _ax = new THREE.Vector3();
const _roll = new THREE.Vector3();
const _dq = new THREE.Quaternion();

/** Merges the meshes hanging directly off one joint into one mesh per material. */
function bakeJoint(parent: THREE.Object3D, shadows: boolean) {
  const by = new Map<THREE.Material, THREE.Mesh[]>();
  for (const c of parent.children) {
    const m = c as THREE.Mesh;
    if (!m.isMesh) continue;
    const list = by.get(m.material as THREE.Material) ?? [];
    list.push(m);
    by.set(m.material as THREE.Material, list);
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

export class CharacterModel {
  readonly root = new THREE.Group();
  /** Pivot at hip height: the flip turns about this, not about the feet. */
  private spin = new THREE.Group();
  private body = new THREE.Group();
  private hips = new THREE.Group();
  private torso = new THREE.Group();
  private head = new THREE.Group();
  private sh: [Joint, Joint] = [new THREE.Group(), new THREE.Group()];
  private el: [Joint, Joint] = [new THREE.Group(), new THREE.Group()];
  private hip: [Joint, Joint] = [new THREE.Group(), new THREE.Group()];
  private kn: [Joint, Joint] = [new THREE.Group(), new THREE.Group()];
  private ak: [Joint, Joint] = [new THREE.Group(), new THREE.Group()];
  private scarf: THREE.Group[] = [];
  private scarfAng = [0, 0, 0];
  phase = 0;
  private cur = new Map<string, number>();
  private deadT = 0;
  /**
   * Dead body: an orientation and a spin driven by what the body is actually
   * doing (the physics body underneath is already thrown, bounces, slides and
   * rides platforms), instead of a canned fall-over that ignored the ground.
   */
  private rag = { on: false, q: new THREE.Quaternion(), w: new THREE.Vector3(), lastVy: 0, jiggle: 0, flat: false };
  /** Climb/vault progress, so a pull-up plays out instead of holding one pose. */
  private mantleT = 0;
  /** Smoothed turn rate: the raw value is noisy, and jumpy for remote runners. */
  private turnSm = 0;
  /** Front flip: 0..1 through the rotation, and whether one is still finishing. */
  private flipK = 0;
  private flipRun = false;
  /** Dash: 0..1 through the sidestep, and which way it went. */
  private dashK = 0;
  private dashSide = 0;
  /** Per-runner gait quirk: nobody's two legs are quite the same. */
  private readonly gait: number;
  private readonly limp: number;
  private tag: THREE.Sprite | null = null;
  /** Zip-line trolley (bar + pulley) shown while riding a cable. */
  private handle = new THREE.Group();
  /** Every material of the runner (cloak fades them). */
  private allMats: THREE.MeshStandardMaterial[] = [];
  private bubble: THREE.Mesh;
  /** A faint golden glow around a runner who is flying. */
  private aura: THREE.Sprite;
  private auraK = 0;
  private boots: THREE.MeshStandardMaterial;
  private cloakK = 0;
  private cloakTarget = 0;
  readonly color: number;
  /** The arena: the arm movement playing, how far into it, and the glow on the hands. */
  private actKind: ActKind | null = null;
  private actT = 0;
  private readonly hands: THREE.Sprite[] = [];
  private handK = 0;
  private hasPower = false;
  /** The angel's wings, sword and halo (while its runner has that power). */
  angel: AngelRig | null = null;
  private readonly shadowsOn: boolean;

  constructor(colorIndex: number, shadows: boolean) {
    const color = PLAYER_COLORS[colorIndex % 3];
    this.color = color;
    this.shadowsOn = shadows;
    this.gait = (colorIndex % 3) * 2.1;
    this.limp = 0.04 + (colorIndex % 3) * 0.018;
    const jacket = new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05 });
    const pants = new THREE.MeshStandardMaterial({ color: 0x2c3442, roughness: 0.85 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xd9a47e, roughness: 0.7 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1b1f26, roughness: 0.6 });
    const accent = new THREE.MeshStandardMaterial({ color: ACCENTS[colorIndex % 3], roughness: 0.6, emissive: new THREE.Color(color), emissiveIntensity: 0.25 });
    const visor = new THREE.MeshStandardMaterial({ color: 0x0c1016, roughness: 0.2, metalness: 0.6, emissive: new THREE.Color(color), emissiveIntensity: 0.6 });
    this.boots = dark.clone();
    const sole = new THREE.MeshStandardMaterial({ color: 0x7c8591, roughness: 0.85 });
    this.allMats.push(jacket, pants, skin, dark, accent, visor, this.boots, sole);

    const mesh = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) => {
      const o = new THREE.Mesh(g, m);
      o.position.set(x, y, z);
      o.castShadow = shadows;
      return o;
    };

    this.root.add(this.spin);
    this.spin.position.y = 0.95;
    this.spin.add(this.body);
    this.body.position.y = -0.95;
    this.body.add(this.hips);
    this.hips.position.y = 0.95;
    this.hips.add(mesh(box(0.34, 0.2, 0.22), pants, 0, 0.02, 0));
    this.hips.add(mesh(box(0.35, 0.05, 0.23), dark, 0, 0.1, 0)); // belt
    this.hips.add(this.torso);
    // torso: jacket with a raised collar and a zip, a backpack on two straps
    const chest = mesh(capsule(0.19, 0.26), jacket, 0, 0.34, 0);
    chest.scale.set(1.12, 1, 0.74);
    this.torso.add(chest);
    const collar = mesh(new THREE.CylinderGeometry(0.1, 0.13, 0.09, 10, 1, true), jacket, 0, 0.56, 0);
    this.torso.add(collar);
    this.torso.add(mesh(box(0.2, 0.06, 0.2), jacket, 0, 0.12, 0.01)); // hem, a touch wider than the waist
    this.torso.add(mesh(box(0.02, 0.36, 0.02), accent, 0, 0.33, 0.145)); // zip
    this.torso.add(mesh(box(0.3, 0.34, 0.14), dark, 0, 0.36, -0.17));
    this.torso.add(mesh(box(0.26, 0.08, 0.1), dark, 0, 0.56, -0.16)); // pack lid
    for (const sx of [-0.1, 0.1]) {
      const strap = mesh(box(0.045, 0.34, 0.02), dark, sx, 0.4, 0.142);
      strap.rotation.x = -0.08;
      this.torso.add(strap);
      this.torso.add(mesh(box(0.045, 0.03, 0.2), dark, sx, 0.55, -0.02));
    }
    this.torso.add(mesh(box(0.31, 0.05, 0.15), accent, 0, 0.3, -0.175));
    // head
    this.head.position.set(0, 0.62, 0);
    this.torso.add(this.head);
    this.head.add(mesh(capsule(0.05, 0.06), skin, 0, 0.02, 0));
    this.head.add(mesh(sphere(0.125), skin, 0, 0.15, 0.01));
    const hood = mesh(sphere(0.142), jacket, 0, 0.17, -0.03);
    hood.scale.set(1, 1.02, 1.05);
    this.head.add(hood);
    this.head.add(mesh(box(0.2, 0.06, 0.08), visor, 0, 0.16, 0.1));
    // arms
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? 1 : -1;
      const shoulder = this.sh[i];
      shoulder.position.set(0.225 * s, 0.5, 0);
      this.torso.add(shoulder);
      shoulder.add(mesh(capsule(0.058, 0.18), jacket, 0, -0.13, 0));
      const elbow = this.el[i];
      elbow.position.y = -0.27;
      shoulder.add(elbow);
      elbow.add(mesh(capsule(0.05, 0.16), jacket, 0, -0.11, 0));
      // grip gloves with a cuff: the hands are what catch ledges and ropes
      elbow.add(mesh(new THREE.CylinderGeometry(0.058, 0.055, 0.06, 8), dark, 0, -0.21, 0));
      const glove = mesh(sphere(0.058), dark, 0, -0.27, 0.005);
      glove.scale.set(0.95, 1.12, 0.8);
      elbow.add(glove);
      // the power's glow on each hand (sprites are left out of the joint merge)
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: handTexture(), color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
      glow.position.set(0, -0.28, 0.02);
      glow.scale.setScalar(0.4);
      glow.visible = false;
      elbow.add(glow);
      this.hands.push(glow);
      // legs
      const hip = this.hip[i];
      hip.position.set(0.1 * s, 0, 0);
      this.hips.add(hip);
      hip.add(mesh(capsule(0.078, 0.28), pants, 0, -0.22, 0));
      const knee = this.kn[i];
      knee.position.y = -0.45;
      hip.add(knee);
      knee.add(mesh(capsule(0.066, 0.28), pants, 0, -0.21, 0));
      // knee pad over the joint (it also hides the seam between the two capsules)
      const pad = mesh(box(0.12, 0.13, 0.07), dark, 0, -0.02, 0.055);
      pad.rotation.x = 0.12;
      knee.add(pad);
      const ankle = this.ak[i];
      ankle.position.y = -0.44;
      knee.add(ankle);
      // trainers: an upper that glows when boosted, on a grey rubber sole
      ankle.add(mesh(box(0.12, 0.09, 0.26), this.boots, 0, 0.01, 0.05));
      ankle.add(mesh(box(0.125, 0.028, 0.275), sole, 0, -0.045, 0.055));
    }
    // scarf (3 trailing segments)
    let parent: THREE.Object3D = this.torso;
    let y = 0.58, z = -0.12;
    for (let i = 0; i < 3; i++) {
      const seg = new THREE.Group();
      seg.position.set(i === 0 ? 0.05 : 0, i === 0 ? y : -0.16, i === 0 ? z : 0);
      seg.add(mesh(box(0.09, 0.17, 0.025), accent, 0, -0.08, 0));
      parent.add(seg);
      this.scarf.push(seg);
      parent = seg;
    }
    // zip-line trolley: grip bar at hand height, pulley riding on top of the cable
    const steel = new THREE.MeshStandardMaterial({ color: 0x9aa4b0, roughness: 0.35, metalness: 0.8 });
    this.handle.position.y = 1.97;
    this.handle.add(mesh(box(0.56, 0.05, 0.05), dark, 0, 0, 0));
    for (const sx of [-0.2, 0.2]) this.handle.add(mesh(box(0.03, 0.2, 0.03), steel, sx, 0.1, 0));
    this.handle.add(mesh(box(0.44, 0.04, 0.04), steel, 0, 0.2, 0));
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.06, 12), accent);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(0, 0.155, 0.06);
    this.handle.add(wheel);
    this.handle.visible = false;
    this.root.add(this.handle);
    this.allMats.push(steel);
    // shield bubble (shown while a shield is up)
    this.bubble = new THREE.Mesh(new THREE.IcosahedronGeometry(1.05, 2), new THREE.MeshBasicMaterial({
      color: 0x5ef0ff, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    this.bubble.position.y = 0.95;
    this.bubble.scale.set(0.8, 1.05, 0.8);
    this.bubble.visible = false;
    this.root.add(this.bubble);
    this.aura = new THREE.Sprite(new THREE.SpriteMaterial({ map: auraTexture(), color: 0xffe0a0, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
    this.aura.position.y = 0.95;
    this.aura.scale.set(2.2, 2.6, 1);
    this.aura.visible = false;
    this.root.add(this.aura);
    // merge each joint's pieces per material: the detail above costs almost no extra draw calls
    for (const j of [this.hips, this.torso, this.head, ...this.sh, ...this.el, ...this.hip, ...this.kn, ...this.ak]) bakeJoint(j, shadows);
    this.root.traverse((o) => { o.frustumCulled = true; });
  }

  setNameTag(name: string, css: string) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const ctx = c.getContext('2d')!;
    ctx.font = 'bold 30px Segoe UI, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(8,14,24,0.55)';
    const w = Math.min(250, ctx.measureText(name).width + 34);
    ctx.beginPath();
    ctx.roundRect(128 - w / 2, 10, w, 44, 12);
    ctx.fill();
    ctx.fillStyle = css;
    ctx.fillText(name, 128, 33);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false });
    this.tag = new THREE.Sprite(mat);
    this.tag.scale.set(1.9, 0.48, 1);
    this.tag.position.y = 2.3;
    this.tag.renderOrder = 20;
    this.root.add(this.tag);
  }

  setTagVisible(v: boolean) { if (this.tag) this.tag.visible = v; }

  /** Powers shown on the runner: shield bubble, cloak (0 visible .. 1 cloaked), glowing boots while boosted. */
  setPowers(shield: boolean, cloak: number, boost: boolean) {
    this.bubble.visible = shield;
    this.cloakTarget = cloak;
    this.boots.emissive.setHex(boost ? 0xff7a1a : 0x000000);
    this.boots.emissiveIntensity = boost ? 1.6 : 0;
  }

  /** The arena: the runner's power colour on its hands (null: no power). */
  setPowerColor(hex: number | null) {
    this.hasPower = hex !== null;
    for (const h of this.hands) {
      h.visible = this.hasPower && !this.angel;
      if (hex !== null) (h.material as THREE.SpriteMaterial).color.setHex(hex);
    }
  }

  /** A power used: the arms act it out (and the hands flare). */
  act(kind: ActKind, hex?: number) {
    // a hold stays up until it is thrown or let go; anything else replaces it
    this.actKind = kind;
    this.actT = 0;
    this.handK = 1;
    if (hex !== undefined) this.setPowerColor(hex);
    // the angel's cleave comes down with a beat of the wings, the soar is one great beat
    if (this.angel && kind === 'cleave') this.angel.beat(0.8);
    if (this.angel && kind === 'soar') this.angel.beat(1.6);
  }

  /** The angel's wings and sword on (with the power's colour in the feathers) or off. */
  setAngel(on: boolean, hex = 0xffe3a3) {
    if (on === !!this.angel) return;
    if (on) {
      const rig = new AngelRig(hex, this.shadowsOn);
      this.torso.add(rig.wings);
      this.el[1].add(rig.sword);
      this.head.add(rig.halo);
      this.angel = rig;
    } else if (this.angel) {
      const rig = this.angel;
      this.torso.remove(rig.wings);
      this.el[1].remove(rig.sword);
      this.head.remove(rig.halo);
      rig.dispose();
      this.angel = null;
    }
    for (const h of this.hands) h.visible = this.hasPower && !this.angel;
  }

  /** The wings beat (the local runner's own beats come straight from its motor). */
  wingBeat(k = 1) { this.angel?.beat(k); }

  /** Smoothly drive a joint value toward a target. */
  private j(key: string, target: number, rate: number, dt: number) {
    const v = this.cur.get(key) ?? target;
    const n = v + (target - v) * damp(rate, dt);
    this.cur.set(key, n);
    return n;
  }

  update(a: AnimInput) {
    const dt = a.dt;
    const sp = a.speed;
    const flying = a.anim === Anim.Fly;
    const air = a.anim === Anim.Jump || a.anim === Anim.Fall || a.anim === Anim.Launch || a.anim === Anim.Zip
      || a.anim === Anim.Swing || a.anim === Anim.Flip || a.anim === Anim.Glide || a.anim === Anim.Beat || flying;
    // the flying aura swells in and out
    this.auraK += ((flying ? 1 : 0) - this.auraK) * damp(flying ? 4 : 2.5, dt);
    this.aura.visible = this.auraK > 0.01;
    if (this.aura.visible) {
      (this.aura.material as THREE.SpriteMaterial).opacity = this.auraK * (0.3 + Math.sin(a.t * 3.1) * 0.06) * (1 - this.cloakK * 0.8);
      this.aura.scale.set(2.2 + Math.sin(a.t * 2.3) * 0.12, 2.6 + Math.sin(a.t * 2.3) * 0.12, 1);
    }
    this.handle.visible = a.anim === Anim.Zip;
    // cloak: fade the whole runner in and out
    this.cloakK += (this.cloakTarget - this.cloakK) * damp(6, a.dt);
    const op = 1 - this.cloakK * (0.82 + Math.sin(a.t * 9) * 0.05);
    const fade = op < 0.99;
    for (const m of this.allMats) {
      if (m.transparent !== fade) { m.transparent = fade; m.depthWrite = !fade; m.needsUpdate = true; }
      m.opacity = op;
    }
    if (this.bubble.visible) {
      const bm = this.bubble.material as THREE.MeshBasicMaterial;
      bm.opacity = 0.13 + Math.sin(a.t * 4) * 0.04;
      this.bubble.rotation.y = a.t * 0.6;
    }
    this.turnSm += (clamp(a.turn, -7, 7) - this.turnSm) * damp(7, dt);
    this.mantleT = a.anim === Anim.Mantle ? this.mantleT + dt : 0;
    // A flip always finishes its turn: if a landing ends it early the rest of the
    // rotation plays out fast, so the body rolls out instead of snapping upright.
    if (a.anim === Anim.Flip) { this.flipRun = true; this.flipK = Math.min(1, this.flipK + dt / FLIP.TIME); }
    else if (this.flipRun) {
      this.flipK += dt / 0.22;
      if (this.flipK >= 1) { this.flipRun = false; this.flipK = 0; }
    }
    const dashing = a.anim === Anim.DashL || a.anim === Anim.DashR;
    if (dashing) { this.dashSide = a.anim === Anim.DashL ? -1 : 1; this.dashK = Math.min(1, this.dashK + dt / DASH.TIME); }
    else this.dashK = Math.max(0, this.dashK - dt / 0.28);

    const runW = air ? 0 : clamp(sp / 3.2, 0, 1);
    const sprintW = air ? 0 : clamp((sp - 6.2) / 2.4, 0, 1);
    if (!air) this.phase += dt * (sp * 1.32 + (sp > 0.4 ? 1.8 : 0));
    const ph = this.phase;
    const t = a.t;

    // targets
    let thigh = [0, 0], knee = [0.05, 0.05], ankle = [0, 0], hipZ = [0, 0];
    let shoulder = [0, 0], elbow = [-0.25, -0.25], shoulderZ = [0.08, 0.08];
    let lean = 0, bob = 0, twist = 0, headX = 0, headY = 0, bodyRoll = 0, bodyPitch = 0;
    let sway = 0, hipRoll = 0;
    let rate = 16;
    /** Flying: how far the whole body tips forward about the hips. */
    let flyPitch = 0;
    /** The angel's whirling sweep: how far round the whole body has turned. */
    let whirl = 0;

    if (a.anim === Anim.Dead) {
      this.deadT += dt;
      // limp limbs: flung about while the body is in the air, jolted by each impact
      const jig = this.ragdoll(a, dt);
      const v = a.vel;
      const fly = a.grounded === false || (a.grounded === undefined && Math.abs(a.vy) > 0.5)
        ? clamp((v ? Math.hypot(v.x, v.y, v.z) : Math.abs(a.vy)) / 12, 0.25, 1) : 0;
      const f = Math.sin(t * 11 + this.gait) * fly, s = Math.sin(t * 29) * jig;
      if (this.rag.flat) {
        // lying down: arms and legs fall in alongside the body, whichever side is down,
        // so nothing sticks up into the air or down through the floor
        thigh = [-0.08 + s * 0.15, 0.06 - s * 0.1]; knee = [0.25 + s * 0.2, 0.4]; ankle = [0.15, 0.1];
        shoulder = [-0.15 + s * 0.2, 0.1 - s * 0.15]; shoulderZ = [0.14 + s * 0.12, 0.1]; elbow = [-0.3, -0.45];
      } else {
        // thrown, tumbling or toppling: limp limbs flung about by the motion
        thigh = [-0.35 + f * 0.45 + s * 0.3, 0.12 - f * 0.45 - s * 0.2]; knee = [0.6 + s * 0.3, 0.3 + f * 0.3]; ankle = [0.2, 0.1];
        shoulder = [-0.55 + f * 0.8 + s * 0.4, 0.25 - f * 0.8 - s * 0.3]; shoulderZ = [1.0 + s * 0.3, 0.75 - s * 0.3]; elbow = [-0.35, -0.65];
      }
      headX = 0.15;
      rate = 9;
    } else {
      this.deadT = 0;
      if (a.anim === Anim.Finished) {
        shoulder = [-2.9, -2.9]; shoulderZ = [0.35, 0.35]; elbow = [-0.3, -0.3];
        bob = Math.abs(Math.sin(t * 5)) * 0.12; headX = -0.2;
        hipRoll = Math.sin(t * 5) * 0.06;
      } else if (a.anim === Anim.Mantle) {
        // pull-up: reach over the lip, haul the chest up, swing a knee onto it
        rate = 24;
        const u = clamp(this.mantleT / 0.5, 0, 1);
        const hang = Math.sin(Math.min(1, u * 1.35) * Math.PI);
        shoulder = [lerp(-2.65, -1.0, u), lerp(-2.5, -0.75, u)];
        elbow = [-0.35 - hang * 1.15, -0.4 - hang * 1.0];
        shoulderZ = [0.16, 0.16];
        thigh = [lerp(-0.25, -1.45, u * u), lerp(-0.1, -0.55, u)];
        knee = [lerp(0.35, 1.75, u * u), lerp(0.25, 0.95, u)];
        ankle = [lerp(-0.2, 0.3, u), -0.15];
        lean = lerp(0.2, 0.62, u); headX = -0.25 + u * 0.35;
        hipRoll = -0.1 * u;
      } else if (a.anim === Anim.Flip) {
        // front flip: reach up out of the take-off, tuck knees to chest through the
        // turn, then open out to spot the landing
        rate = 22;
        const u = this.flipK;
        const tuck = Math.sin(Math.PI * clamp(u * 1.12, 0, 1));
        const open = clamp((u - 0.72) / 0.28, 0, 1);
        thigh = [lerp(-0.25, -2.35, tuck), lerp(-0.1, -2.15, tuck)];
        knee = [lerp(0.35, 2.5, tuck), lerp(0.3, 2.35, tuck)];
        ankle = [lerp(-0.25, 0.55, tuck), lerp(-0.2, 0.45, tuck)];
        hipZ = [tuck * 0.12, -tuck * 0.1];
        shoulder = [lerp(-1.7, -0.45, tuck), lerp(-1.55, -0.3, tuck)];
        elbow = [lerp(-0.45, -2.35, tuck), lerp(-0.4, -2.2, tuck)];
        shoulderZ = [0.3 - tuck * 0.16, 0.28 - tuck * 0.14];
        lean = lerp(0.12, 0.9, tuck) - open * 0.5;
        headX = lerp(-0.25, 0.5, tuck) - open * 0.4;
        bob = -tuck * 0.1;
        twist = tuck * 0.06;
      } else if (dashing) {
        // sidestep: push off the trailing leg, lead with the near shoulder, the
        // whole body banking into the direction of travel
        rate = 20;
        const sgn = this.dashSide;
        const pop = Math.sin(Math.PI * clamp(this.dashK * 0.92 + 0.08, 0, 1));
        const lead = sgn > 0 ? 1 : 0;
        bodyRoll = sgn * 0.42 * pop;
        lean = 0.12 + 0.16 * pop;
        twist = -sgn * 0.26 * pop;
        hipRoll = -sgn * 0.12 * pop;
        hipZ = [-sgn * 0.5 * pop, -sgn * 0.5 * pop];
        hipZ[lead] = -sgn * 0.62 * pop;
        hipZ[1 - lead] = -sgn * 0.28 * pop;
        thigh = [-0.3 * pop, -0.1 * pop];
        knee = [0.2 + 0.55 * pop, 0.2 + 0.95 * pop];
        ankle = [-0.15 * pop, 0.2 * pop];
        shoulder = [-0.45 * pop, -0.2 * pop];
        elbow = [-0.55 - 0.5 * pop, -0.45 - 0.2 * pop];
        shoulderZ = [0.12, 0.12];
        shoulderZ[lead] = 0.16 + 0.62 * pop;
        shoulderZ[1 - lead] = 0.1 + 0.18 * pop;
        headY = sgn * 0.32 * pop;
        bob = -0.075 * pop;
      } else if (a.anim === Anim.Zip) {
        // hanging from the trolley, legs swinging
        const sw = Math.sin(t * 4.2) * 0.18;
        shoulder = [-3.02, -3.02]; shoulderZ = [0.13, 0.13]; elbow = [-0.12, -0.12];
        thigh = [-0.55 + sw, -0.35 - sw]; knee = [0.55, 0.75]; ankle = [-0.25, -0.2];
        lean = -0.12; headX = -0.25;
      } else if (a.anim === Anim.Slide) {
        // feet-first slide: leaning back, front leg out, back leg tucked, a hand trailing on the floor
        shoulder = [0.9, -0.5]; shoulderZ = [0.55, 0.3]; elbow = [-0.2, -1.0];
        thigh = [-1.35, -0.45]; knee = [0.15, 1.9]; ankle = [0.35, -0.1];
        lean = -0.95; bob = -0.52; headX = 0.55;
        hipRoll = 0.12;
      } else if (a.anim === Anim.Swing) {
        // hanging from the rope, the body trailing and pumping the arc
        const sw = Math.sin(a.t * 2.6) * 0.16;
        shoulder = [-2.85 + sw * 0.2, -2.95 + sw * 0.2]; shoulderZ = [0.05, 0.05]; elbow = [-0.2, -0.15];
        thigh = [-0.4 + sw, -0.12 - sw]; knee = [0.55 + sw * 0.4, 0.3]; ankle = [-0.25, -0.2];
        lean = 0.08 + sw * 0.12; headX = -0.35;
        twist = sw * 0.25;
      } else if (flying) {
        // flight: stretched out and diving at speed (a fist forward, legs trailing
        // together), upright and floating when slow (arms loose, one knee raised),
        // banking into sideways flight and leaning back when flying backwards
        rate = 10;
        const fw = clamp(a.fwd ?? 1, -1, 1), sd = clamp(a.side ?? 0, -1, 1);
        const along = a.speed * fw;
        const dive = clamp(along / FLY.FAST, 0, 1);
        const k = dive * dive * (3 - 2 * dive);
        const climb = clamp(a.vy / FLY.VERTICAL, -1, 1);
        const float = Math.sin(t * 2.1 + this.gait);
        flyPitch = k * 1.2 - clamp(-along / FLY.SPEED, 0, 1) * 0.25 - climb * 0.18 * (1 - k);
        shoulder = [lerp(-0.25 + float * 0.06, -2.85, k), lerp(-0.1 - float * 0.05, 0.25, k)];
        shoulderZ = [lerp(0.42, 0.12, k), lerp(0.48, 0.1, k)];
        elbow = [lerp(-0.5, -0.12, k), lerp(-0.4, -0.3, k)];
        thigh = [lerp(-0.4 + float * 0.05, 0.08, k), lerp(0.02 - float * 0.04, 0.12, k)];
        knee = [lerp(0.85, 0.18, k), lerp(0.28, 0.25, k)];
        ankle = [lerp(0.45, 0.65, k), lerp(0.5, 0.7, k)];
        if (climb > 0.3 && k < 0.5) { shoulder = [shoulder[0] - climb * 0.4, shoulder[1] - climb * 0.4]; shoulderZ = [shoulderZ[0] + climb * 0.2, shoulderZ[1] + climb * 0.2]; }
        bodyRoll = -sd * 0.38 * clamp(a.speed / FLY.SPEED, 0.3, 1);
        hipZ = [-sd * 0.12, -sd * 0.12];
        bob = (1 - k) * float * 0.05;
        headX = -k * 0.9 - 0.1;
        lean = 0.05;
      } else if (a.anim === Anim.Lunge) {
        // a slash's step in: a long stride, the body behind the blade
        rate = 28;
        thigh = [-0.95, 0.55]; knee = [0.55, 0.45]; ankle = [0.1, 0.35];
        shoulder = [-0.6, -1.2]; shoulderZ = [0.3, 0.3]; elbow = [-0.9, -0.3];
        lean = 0.34; twist = 0.2; headX = -0.25;
      } else if (a.anim === Anim.Dive) {
        // the angel's dive: head first, wings folded back, the sword out ahead like a lance
        rate = 16;
        thigh = [0.06, 0.12]; knee = [0.12, 0.2]; ankle = [0.6, 0.55];
        shoulder = [0.25, -3.0]; shoulderZ = [0.3, 0.12]; elbow = [-0.2, -0.05];
        lean = 0.1; headX = -1.05;
        flyPitch = 1.3;
      } else if (a.anim === Anim.Glide) {
        // gliding on spread wings: tipped forward, legs trailing together, arms loose and back
        rate = 8;
        const sd = clamp(a.side ?? 0, -1, 1);
        const sway = Math.sin(t * 1.3 + this.gait) * 0.05;
        thigh = [0.12 + sway, 0.2 - sway]; knee = [0.25, 0.35]; ankle = [0.5, 0.45];
        shoulder = [0.45, 0.35]; shoulderZ = [0.35, 0.3]; elbow = [-0.35, -0.5];
        headX = -0.75; lean = 0.05;
        bodyRoll = -sd * 0.3;
        flyPitch = 0.72;
      } else if (a.anim === Anim.Beat) {
        // beating the wings: hanging under them, legs dangling and kicking a little with each stroke
        rate = 12;
        const k = Math.sin(t * 9 + this.gait);
        thigh = [-0.35 + k * 0.1, -0.1 - k * 0.1]; knee = [0.6, 0.45]; ankle = [0.35, 0.3];
        shoulder = [-0.35, -0.5]; shoulderZ = [0.45, 0.4]; elbow = [-0.6, -0.5];
        lean = 0.12; headX = -0.15;
      } else if (a.anim === Anim.Flash) {
        // the flash strike: stretched out flat, arms swept back, one leg trailing
        rate = 30;
        thigh = [-1.25, 0.75]; knee = [0.35, 1.2]; ankle = [0.3, 0.5];
        shoulder = [1.05, 1.1]; shoulderZ = [0.35, 0.35]; elbow = [-0.2, -0.2];
        lean = 0.55; headX = -0.6;
        flyPitch = 0.5;
      } else if (a.anim === Anim.Launch) {
        // thrown by a pad: one arm reaching up, legs trailing
        shoulder = [-2.7, 0.5]; shoulderZ = [0.25, 0.7]; elbow = [-0.1, -0.5];
        thigh = [0.3, -0.25]; knee = [0.35, 1.1]; ankle = [-0.3, -0.25];
        lean = 0.3; headX = -0.3;
      } else if (air) {
        const sdAir = clamp(a.side ?? 0, -1, 1);
        hipZ = [-sdAir * 0.16, -sdAir * 0.16];
        bodyRoll = sdAir * 0.12;
        if (a.vy > 0) {
          thigh = [-1.05, 0.35]; knee = [1.35, 0.55]; ankle = [-0.1, -0.35];
          shoulder = [0.9, -1.3]; elbow = [-0.6, -0.9]; lean = 0.18;
        } else {
          const panic = clamp((-a.vy - 10) / 12, 0, 1);
          const f = Math.sin(t * 11) * panic;
          thigh = [-0.55 + f * 0.6, -0.2 - f * 0.6]; knee = [0.8, 0.6];
          ankle = [0.2 + f * 0.2, 0.15 - f * 0.2];
          shoulder = [-0.9 - panic * 1.2 + f * 0.7, -0.6 - panic * 1.3 - f * 0.7]; shoulderZ = [0.5 + panic * 0.7, 0.5 + panic * 0.7];
          elbow = [-0.5, -0.5]; lean = 0.1 - panic * 0.2; headX = 0.2 * panic;
        }
      } else {
        // locomotion blend: idle -> run -> sprint, crossed with the direction of
        // travel in the runner's own frame (forward / side-step / backpedal)
        const fw = clamp(a.fwd ?? 1, -1, 1), sd = clamp(a.side ?? 0, -1, 1);
        const strafeW = Math.min(1, Math.abs(sd)) * runW;
        const backW = Math.max(0, -fw) * runW;
        const s2 = Math.sin(ph), c2 = Math.cos(ph);
        // side-steps and backpedals are shorter and busier than a forward run
        const amp = (0.55 + 0.35 * sprintW) * (1 - 0.4 * strafeW - 0.2 * backW);
        // the two legs are never quite equal: a small, constant asymmetry per runner
        const gL = 1 + this.limp, gR = 1 - this.limp;
        // the fore-aft swing follows the way you are actually going, and fades out
        // entirely on a pure side-step, where the legs work sideways instead
        thigh = [-s2 * amp * runW * gL * fw, s2 * amp * runW * gR * fw];
        const kneeK = 1 - 0.25 * strafeW;
        knee = [
          0.08 + runW * (0.35 + Math.max(0, Math.sin(ph + 1.9)) * (1.05 + sprintW * 0.5)) * gL * kneeK,
          0.08 + runW * (0.35 + Math.max(0, Math.sin(ph + 1.9 + Math.PI)) * (1.05 + sprintW * 0.5)) * gR * kneeK,
        ];
        // side-step: the legs swing out and cross over, both biased the way you go
        hipZ = [-sd * (0.16 + 0.22 * s2) * strafeW, -sd * (0.16 - 0.22 * s2) * strafeW];
        // ankles roll through the step: toes point at push-off, lift before the heel lands
        const ankAmp = (0.3 + sprintW * 0.22) * runW * Math.abs(fw);
        ankle = [
          runW * 0.1 - Math.sin(ph + 2.2) * ankAmp,
          runW * 0.1 - Math.sin(ph + 2.2 + Math.PI) * ankAmp,
        ];
        // arms swing a beat behind the legs, and not quite symmetrically; a
        // side-step keeps them closer in and a little wider out at the elbow
        const ap = ph - 0.3, sa = Math.sin(ap);
        const armAmp = (0.55 + 0.45 * sprintW) * (1 - 0.5 * strafeW - 0.15 * backW);
        shoulder = [sa * armAmp * runW * gR * fw, -sa * armAmp * runW * gL * fw];
        elbow = [
          -(0.25 + runW * (0.85 + sprintW * 0.4) * (1 - 0.3 * strafeW) + Math.max(0, sa) * 0.22 * runW),
          -(0.25 + runW * (0.85 + sprintW * 0.4) * (1 - 0.3 * strafeW) + Math.max(0, -sa) * 0.22 * runW),
        ];
        const flare = 0.22 * strafeW;
        shoulderZ = [
          0.08 + (1 - runW) * 0.05 + Math.max(0, sa) * 0.06 * runW + flare * (sd < 0 ? 1.4 : 0.6),
          0.08 + (1 - runW) * 0.05 + Math.max(0, -sa) * 0.06 * runW + flare * (sd > 0 ? 1.4 : 0.6),
        ];
        // lean the way you are travelling: forward into a run, back on a backpedal,
        // and into the step when moving sideways
        lean = runW * (0.1 + sprintW * 0.22) * fw;
        bodyRoll = sd * 0.17 * runW;
        bob = runW * (Math.abs(c2) * 0.075 - 0.04);
        // hips turn toward the direction of travel while the shoulders stay square
        twist = s2 * 0.14 * runW * fw - sd * 0.2 * runW;
        // hips sway toward the loaded leg and drop on the swinging side
        sway = -s2 * 0.028 * runW;
        hipRoll = s2 * 0.075 * runW;
        headX = -lean * 0.5;
        // idle: breathing, a slow shift of weight from foot to foot, the odd glance
        if (runW < 0.25) {
          const idle = 1 - runW / 0.25;
          const br = Math.sin(t * 2.2 + this.gait);
          const shift = Math.sin(t * 0.62 + this.gait);
          bob += br * 0.012 * idle;
          lean += (0.03 + br * 0.02) * idle;
          shoulder = [shoulder[0] + (Math.sin(t * 1.1 + this.gait) * 0.05 - br * 0.02) * idle, shoulder[1] - (Math.sin(t * 1.05 + this.gait) * 0.05 + br * 0.02) * idle];
          shoulderZ = [shoulderZ[0] + (0.03 + br * 0.015) * idle, shoulderZ[1] + (0.03 + br * 0.015) * idle];
          sway += shift * 0.022 * idle;
          hipRoll += shift * 0.05 * idle;
          headX += Math.sin(t * 0.37 + this.gait) * 0.06 * idle;
          headY += Math.sin(t * 0.29 + this.gait * 2) * 0.4 * idle;
        }
      }
      // landing squash
      if (a.land > 0.01) {
        bob -= a.land * 0.22;
        knee = [knee[0] + a.land * 1.1, knee[1] + a.land * 1.1];
        thigh = [thigh[0] - a.land * 0.6, thigh[1] - a.land * 0.6];
        ankle = [ankle[0] + a.land * 0.5, ankle[1] + a.land * 0.5];
        lean += a.land * 0.35;
      }
      // banking: lean into a turn, gently, from the smoothed turn rate (added, so a
      // pose that sets its own bank -- the dash -- keeps it)
      bodyRoll += clamp(-this.turnSm * clamp(sp / 6, 0, 1) * 0.055, -0.22, 0.22);
      twist += clamp(this.turnSm * 0.028, -0.18, 0.18);
      // a power's arm movement, over whatever else the body is doing
      if (this.actKind) {
        this.actT += dt;
        const dur = ACT_TIME[this.actKind];
        if (this.actT >= dur) this.actKind = null;
        else {
          const u = this.actT / dur;
          const w = this.actKind === 'hold' ? Math.min(1, this.actT / 0.1) * Math.min(1, (1 - u) / 0.05) : Math.min(1, this.actT / 0.04) * Math.min(1, (1 - u) / 0.5);
          const mix = (arr: number[], i: number, v: number) => { arr[i] = lerp(arr[i], v, w); };
          // the other fist comes up to guard the chin
          const guard = (i: number) => { mix(shoulder, i, -1.05); mix(elbow, i, -2.05); mix(shoulderZ, i, 0.12); };
          switch (this.actKind) {
            case 'rise': {
              // a rising cut: from low behind on the right, up across the body to high on the left
              const k = smooth(0.06, 0.62, u);
              mix(shoulder, 1, lerp(0.65, -2.55, k)); mix(shoulderZ, 1, lerp(0.95, -0.45, k)); mix(elbow, 1, lerp(-0.5, -0.12, k));
              mix(shoulder, 0, -0.55); mix(shoulderZ, 0, 0.55); mix(elbow, 0, -0.9);
              twist += lerp(0.45, -0.55, k) * w; lean += 0.12 * w; bob -= 0.07 * (1 - k) * w;
              break;
            }
            case 'reverse': {
              // the reverse cut: from high on the left back down across to low on the right
              const k = smooth(0.06, 0.62, u);
              mix(shoulder, 1, lerp(-2.65, 0.35, k)); mix(shoulderZ, 1, lerp(-0.6, 1.05, k)); mix(elbow, 1, lerp(-0.3, -0.15, k));
              mix(shoulder, 0, -0.5); mix(shoulderZ, 0, 0.6); mix(elbow, 0, -0.85);
              twist += lerp(-0.55, 0.5, k) * w; lean += 0.14 * w; hipRoll += 0.05 * w;
              break;
            }
            case 'sweep': {
              // the whirl: both arms out, the sword arm level, the whole runner spinning a full turn
              mix(shoulder, 1, -1.5); mix(shoulderZ, 1, 1.4); mix(elbow, 1, -0.08);
              mix(shoulder, 0, -1.25); mix(shoulderZ, 0, 1.2); mix(elbow, 0, -0.3);
              lean += 0.08 * w; bob -= 0.1 * w;
              knee = [knee[0] + 0.35 * w, knee[1] + 0.35 * w];
              thigh = [thigh[0] - 0.2 * w, thigh[1] - 0.2 * w];
              whirl = Math.PI * 2 * smooth(0.04, 0.86, u);
              break;
            }
            case 'cleave': {
              // two hands up over the head, the blade back behind it, then all of it down through the target
              const up = smooth(0, 0.3, u), down = smooth(0.3, 0.55, u);
              const sx = lerp(lerp(-1.3, -3.05, up), -0.75, down);
              mix(shoulder, 1, sx); mix(shoulder, 0, sx + 0.08);
              mix(shoulderZ, 1, lerp(0.25, -0.22, up)); mix(shoulderZ, 0, lerp(0.25, -0.3, up));
              mix(elbow, 1, lerp(-0.7, -0.08, down)); mix(elbow, 0, lerp(-0.8, -0.2, down));
              lean += lerp(-0.18 * up, 0.5, down) * w; bob -= 0.2 * down * w; twist += 0.08 * w;
              knee = [knee[0] + down * 0.65 * w, knee[1] + down * 0.65 * w];
              thigh = [thigh[0] - down * 0.45 * w, thigh[1] - down * 0.45 * w];
              break;
            }
            case 'soar': {
              // the great beat: arms flung up, knees drawn in, then everything driven down with the wings
              const k = smooth(0.12, 0.45, u);
              mix(shoulder, 0, lerp(-2.8, 0.35, k)); mix(shoulder, 1, lerp(-2.8, 0.3, k));
              mix(shoulderZ, 0, lerp(0.45, 0.9, k)); mix(shoulderZ, 1, lerp(0.45, 0.9, k));
              mix(elbow, 0, -0.2); mix(elbow, 1, -0.2);
              knee = [knee[0] + (1 - k) * 0.9 * w, knee[1] + (1 - k) * 0.9 * w];
              thigh = [thigh[0] - (1 - k) * 0.6 * w, thigh[1] - (1 - k) * 0.6 * w];
              headX -= 0.3 * (1 - k) * w;
              break;
            }
            case 'dive':
              break;
            case 'blast': {
              // both palms thrust out, and the kick of it rocks the runner back
              const k = smooth(0.02, 0.2, u), rec = smooth(0.15, 0.45, u) * (1 - smooth(0.55, 1, u));
              mix(shoulder, 0, -1.55); mix(shoulder, 1, -1.55); mix(elbow, 0, lerp(-1.5, -0.03, k)); mix(elbow, 1, lerp(-1.5, -0.03, k));
              mix(shoulderZ, 0, 0.16); mix(shoulderZ, 1, 0.16);
              lean += (0.14 - rec * 0.4) * w; headX += rec * 0.25 * w; bob -= rec * 0.05 * w;
              break;
            }
            case 'boom': {
              // gathered in, then thrown wide: arms out to the sides, chest out, head back
              const k = smooth(0.1, 0.32, u);
              mix(shoulder, 0, lerp(-1.1, -1.6, k)); mix(shoulder, 1, lerp(-1.1, -1.6, k));
              mix(shoulderZ, 0, lerp(-0.2, 1.5, k)); mix(shoulderZ, 1, lerp(-0.2, 1.5, k));
              mix(elbow, 0, lerp(-1.7, -0.1, k)); mix(elbow, 1, lerp(-1.7, -0.1, k));
              lean += lerp(0.3, -0.22, k) * w; headX -= 0.3 * k * w;
              knee = [knee[0] + (1 - k) * 0.5 * w, knee[1] + (1 - k) * 0.5 * w];
              bob -= 0.12 * (1 - k) * w;
              break;
            }
            case 'cast':
              mix(shoulder, 0, -1.75); mix(elbow, 0, -0.12); mix(shoulderZ, 0, 0.02);
              twist += 0.18 * w;
              break;
            case 'hold':
              mix(shoulder, 0, -1.95); mix(shoulder, 1, -1.95); mix(elbow, 0, -0.45); mix(elbow, 1, -0.45);
              mix(shoulderZ, 0, 0.28); mix(shoulderZ, 1, 0.28);
              headX -= 0.15 * w;
              break;
            case 'throw': {
              const sw = lerp(-2.9, -0.9, clamp(u * 1.8, 0, 1));
              mix(shoulder, 0, sw); mix(elbow, 0, -0.1); mix(shoulder, 1, -1.2); mix(elbow, 1, -0.6);
              twist += 0.3 * w; lean += 0.15 * w;
              break;
            }
            case 'push':
              mix(shoulder, 0, -1.5); mix(shoulder, 1, -1.5); mix(elbow, 0, -0.08); mix(elbow, 1, -0.08);
              mix(shoulderZ, 0, 0.16); mix(shoulderZ, 1, 0.16);
              lean += 0.18 * w;
              break;
          }
          rate = Math.max(rate, 26);
        }
      }
    }
    // the power's glow on the hands, flaring with each use
    if (this.hasPower) {
      this.handK = Math.max(0, this.handK - dt * 3.2);
      const holding = this.actKind === 'hold' ? 0.6 : 0;
      // which hand did it: a cast is the left's, a hold, a push and sonic force are both hands'
      const both = this.actKind === 'hold' || this.actKind === 'push' || this.actKind === 'blast' || this.actKind === 'boom';
      const right = false;
      for (let i = 0; i < 2; i++) {
        const h = this.hands[i];
        const k = Math.max(this.handK * (both || (i === 1) === right ? 1 : 0.4), holding);
        (h.material as THREE.SpriteMaterial).opacity = (0.45 + k * 0.55) * (0.85 + Math.sin(t * 17 + i * 2) * 0.15) * (1 - this.cloakK);
        h.scale.setScalar(0.32 + k * 0.5);
      }
    }

    // apply
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      this.hip[i].rotation.x = this.j('th' + i, thigh[i], rate + 4, dt);
      this.hip[i].rotation.z = this.j('hz' + i, hipZ[i], rate + 2, dt);
      this.kn[i].rotation.x = this.j('kn' + i, knee[i], rate + 4, dt);
      this.ak[i].rotation.x = this.j('ak' + i, ankle[i], rate + 2, dt);
      // arms are heavier and lag a little behind the legs
      this.sh[i].rotation.x = this.j('sh' + i, shoulder[i], rate - 3, dt);
      this.sh[i].rotation.z = this.j('sz' + i, shoulderZ[i] * side, rate - 3, dt);
      this.el[i].rotation.x = this.j('el' + i, elbow[i], rate - 4, dt);
    }
    const leanA = this.j('lean', lean, 9, dt);
    const twistA = this.j('tw', -twist, 11, dt);
    const hipTwA = this.j('htw', twist * 0.8, 11, dt);
    const hipRollA = this.j('hroll', hipRoll, 13, dt);
    // the bank follows a turn lazily, but snaps into a dash and eases back out of it
    const rollA = this.j('roll', bodyRoll, dashing ? 14 : 5, dt);
    const pitchA = this.j('pitch', bodyPitch, 8, dt);
    this.torso.rotation.x = leanA;
    this.torso.rotation.y = twistA;
    this.hips.rotation.y = hipTwA;
    this.hips.rotation.z = hipRollA;
    this.body.position.y = -0.95 + this.j('bob', bob, 20, dt);
    this.body.position.x = this.j('sway', sway, 9, dt);
    this.body.rotation.z = rollA;
    this.body.rotation.x = pitchA;
    // the head stays level: it counter-rotates against the lean, the bank and the
    // shoulder twist, and turns slightly into the direction the body is turning
    this.head.rotation.x = this.j('hx', headX, 8, dt) - leanA * 0.55 - pitchA * 0.3;
    this.head.rotation.y = this.j('hy', headY, 5, dt) - twistA * 0.5 + clamp(this.turnSm * 0.05, -0.3, 0.3);
    this.head.rotation.z = -rollA * 0.6 - hipRollA * 0.25;
    // the flip turns the whole runner about the hips; smoothstep so it whips
    // through the middle of the rotation and eases at both ends
    if (a.anim === Anim.Dead) { /* the ragdoll owns the pivot */ }
    else if (this.rag.on) {
      this.rag.on = false;
      this.spin.quaternion.identity();
      this.spin.position.y = 0.95;
    } else if (this.flipRun) {
      const k = clamp(this.flipK, 0, 1);
      this.spin.rotation.x = TWO_PI * (k * k * (3 - 2 * k));
    } else {
      // flight (and gliding, and a dive) tips the body about the hips, and eases back upright when it ends
      const fp = this.j('flyPitch', flyPitch, flying ? 4 : a.anim === Anim.Dive ? 12 : 6, dt);
      this.spin.rotation.x = Math.abs(fp) < 1e-4 ? 0 : fp;
    }
    // the angel's whirl turns the whole runner round once
    this.spin.rotation.y = a.anim === Anim.Dead ? this.spin.rotation.y : whirl;

    // the angel's wings, sword and halo
    if (this.angel) {
      const act = this.actKind && this.actKind !== 'hold' ? this.actKind : null;
      this.angel.update({ dt, t, anim: a.anim, speed: sp, vy: a.vy, act, actU: act ? clamp(this.actT / ACT_TIME[act], 0, 1) : 0 });
    }

    // scarf trails behind with speed and flutters
    const trail = clamp(sp / 8, 0, 1) + (air ? 0.4 : 0) + clamp(-a.vy / 20, 0, 0.5);
    for (let i = 0; i < 3; i++) {
      const target = 0.2 + trail * (1.05 + i * 0.12) + Math.sin(t * (9 + i * 3) + i + this.gait) * 0.12 * (0.3 + trail);
      this.scarfAng[i] += (target - this.scarfAng[i]) * damp(10 - i * 2, dt);
      this.scarf[i].rotation.x = i === 0 ? this.scarfAng[0] - leanA : this.scarfAng[i] - this.scarfAng[i - 1];
      this.scarf[i].rotation.z = Math.sin(t * (6 + i * 2.5) + i * 1.3 + this.gait) * 0.1 * (0.25 + trail);
    }
  }

  /**
   * Turns the whole body about its hips from its real motion. At death it tips
   * the way the hit (or the run) was carrying it, keeps any flip it was in, and
   * tumbles freely through the air. On the ground gravity lays it down until it
   * lies flat, a slide rolls it along, and the pivot rises or sinks with how
   * upright it is, so a lying body rests on the floor instead of in it.
   * Returns how hard it was just jolted (0..1) for the limbs to shake with.
   */
  private ragdoll(a: AnimInput, dt: number): number {
    const r = this.rag;
    const v = a.vel ?? { x: 0, y: a.vy, z: 0 };
    // world velocity in the runner's own frame (the root carries its yaw)
    const yaw = this.root.rotation.y, cy = Math.cos(yaw), sy = Math.sin(yaw);
    const lx = v.x * cy - v.z * sy, lz = v.x * sy + v.z * cy;
    const hs = Math.hypot(lx, lz);
    if (!r.on) {
      r.on = true;
      r.q.copy(this.spin.quaternion);
      // tip over along the push; with nothing to go on, fall backwards
      const dx = hs > 0.5 ? lx / hs : 0, dz = hs > 0.5 ? lz / hs : -1;
      const s = clamp(1.6 + hs * 0.8, 1.6, 7);
      r.w.set(dz * s, 0, -dx * s);
      if (this.flipRun) { r.w.x += 7; this.flipRun = false; }
      r.lastVy = v.y; r.jiggle = 0; r.flat = false;
    }
    const grounded = a.grounded ?? Math.abs(v.y) < 0.4;
    _up.copy(UP).applyQuaternion(r.q);
    const upY = _up.y;
    if (grounded) {
      if (Math.abs(upY) > 0.1) {
        // still upright-ish: gravity keeps it falling the way it already leans
        _ax.copy(UP).cross(_up);
        let len = _ax.length();
        if (len < 1e-3) { _ax.set(r.w.x || 1, 0, r.w.z); len = _ax.length(); }
        _ax.multiplyScalar(Math.sign(upY) / len);
        r.w.addScaledVector(_ax, (16 * Math.sqrt(Math.max(0, 1 - upY * upY)) + 4) * dt);
        if (Math.abs(upY) > 0.3) r.flat = false;
      } else {
        if (!r.flat) {
          // hits the floor flat: most of the spin goes into the impact
          r.flat = true;
          r.jiggle = Math.max(r.jiggle, Math.min(1, r.w.length() / 7));
          r.w.multiplyScalar(0.2);
        }
        // lying down: a slide rolls it along, friction stops the rest
        _roll.set(lz, 0, -lx).multiplyScalar(1 / 0.3);
        r.w.lerp(_roll, 1 - Math.exp(-6 * dt));
      }
      r.w.multiplyScalar(Math.exp(-2.5 * dt));
    } else {
      r.w.multiplyScalar(Math.exp(-0.25 * dt));
    }
    // a bounce off a hard landing jolts it
    if (r.lastVy < -3 && v.y > 0.5) r.jiggle = Math.max(r.jiggle, Math.min(1, -r.lastVy / 12));
    r.lastVy = v.y;
    const ang = r.w.length() * dt;
    if (ang > 1e-6) { _dq.setFromAxisAngle(_ax.copy(r.w).normalize(), ang); r.q.premultiply(_dq); }
    this.spin.quaternion.copy(r.q);
    // hips height above the feet of the physics body: how far the body reaches down
    // from the hips in its current orientation, treated as an ellipsoid (0.95 along
    // the spine, 0.32 across the shoulders, 0.24 front to back), so it rests on the
    // floor whether it is standing, on its back or on its side
    const e = r.q, x = e.x, y = e.y, z = e.z, w = e.w;
    const rY = 2 * (x * y + w * z), uY = 1 - 2 * (x * x + z * z), fY = 2 * (y * z - w * x);
    const lift = Math.hypot(0.32 * rY, 0.95 * uY, 0.24 * fY);
    this.spin.position.y = this.j('ragLift', lift, 14, dt);
    const jig = r.jiggle;
    r.jiggle = Math.max(0, r.jiggle - dt * 2.2);
    return jig;
  }

  dispose() {
    // the rig first: its feather shape is shared by every angel
    this.setAngel(false);
    const shared = new Set(geoCache.values());
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
      // merged joints and one-off parts belong to this runner; the cached primitives are shared
      if (m.geometry && !shared.has(m.geometry)) m.geometry.dispose();
    });
    (this.tag?.material as THREE.SpriteMaterial | undefined)?.map?.dispose();
  }
}

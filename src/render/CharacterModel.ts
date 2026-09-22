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
// so it can never snap back upright.

import * as THREE from 'three';
import { DASH, FLIP } from '../../shared/constants';
import { Anim } from '../../shared/physics/character';
import { clamp, damp, lerp } from '../../shared/math';

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
}

type Joint = THREE.Group;

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
function sphere(r: number) {
  const k = `s${r}`;
  let g = geoCache.get(k);
  if (!g) { g = new THREE.IcosahedronGeometry(r, 1); geoCache.set(k, g); }
  return g;
}

const TWO_PI = Math.PI * 2;

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
  private boots: THREE.MeshStandardMaterial;
  private cloakK = 0;
  private cloakTarget = 0;
  readonly color: number;

  constructor(colorIndex: number, shadows: boolean) {
    const color = PLAYER_COLORS[colorIndex % 3];
    this.color = color;
    this.gait = (colorIndex % 3) * 2.1;
    this.limp = 0.04 + (colorIndex % 3) * 0.018;
    const jacket = new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05 });
    const pants = new THREE.MeshStandardMaterial({ color: 0x2c3442, roughness: 0.85 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xd9a47e, roughness: 0.7 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1b1f26, roughness: 0.6 });
    const accent = new THREE.MeshStandardMaterial({ color: ACCENTS[colorIndex % 3], roughness: 0.6, emissive: new THREE.Color(color), emissiveIntensity: 0.25 });
    const visor = new THREE.MeshStandardMaterial({ color: 0x0c1016, roughness: 0.2, metalness: 0.6, emissive: new THREE.Color(color), emissiveIntensity: 0.6 });
    this.boots = dark.clone();
    this.allMats.push(jacket, pants, skin, dark, accent, visor, this.boots);

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
    this.hips.add(this.torso);
    // torso
    const chest = mesh(capsule(0.19, 0.26), jacket, 0, 0.34, 0);
    chest.scale.set(1.12, 1, 0.74);
    this.torso.add(chest);
    this.torso.add(mesh(box(0.3, 0.34, 0.14), dark, 0, 0.36, -0.17));
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
      elbow.add(mesh(sphere(0.055), skin, 0, -0.26, 0));
      // legs
      const hip = this.hip[i];
      hip.position.set(0.1 * s, 0, 0);
      this.hips.add(hip);
      hip.add(mesh(capsule(0.078, 0.28), pants, 0, -0.22, 0));
      const knee = this.kn[i];
      knee.position.y = -0.45;
      hip.add(knee);
      knee.add(mesh(capsule(0.066, 0.28), pants, 0, -0.21, 0));
      const ankle = this.ak[i];
      ankle.position.y = -0.44;
      knee.add(ankle);
      ankle.add(mesh(box(0.11, 0.08, 0.25), this.boots, 0, 0, 0.05));
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
    const air = a.anim === Anim.Jump || a.anim === Anim.Fall || a.anim === Anim.Launch || a.anim === Anim.Zip
      || a.anim === Anim.Swing || a.anim === Anim.Flip;
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

    if (a.anim === Anim.Dead) {
      this.deadT += dt;
      const k = Math.min(1, this.deadT / 0.45);
      const falling = a.vy < -6;
      if (falling) {
        // thrown and tumbling
        const f = Math.sin(t * 14);
        thigh = [-0.6 + f * 0.5, -0.6 - f * 0.5]; knee = [1.0, 0.8]; ankle = [-0.3, -0.2];
        shoulder = [-2.4 + f * 0.6, -2.4 - f * 0.6]; shoulderZ = [1.0, 1.0]; elbow = [-0.3, -0.3];
        bodyPitch = -0.3 - this.deadT * 2.2;
      } else {
        bodyPitch = -k * 1.45;
        thigh = [-0.3, 0.2]; knee = [0.4, 0.2]; ankle = [0.25, 0.1];
        shoulder = [-1.2, 0.4]; shoulderZ = [0.9, 0.6]; elbow = [-0.2, -0.5];
        bob = -k * 0.75;
      }
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
    if (this.flipRun) {
      const k = clamp(this.flipK, 0, 1);
      this.spin.rotation.x = TWO_PI * (k * k * (3 - 2 * k));
    } else if (this.spin.rotation.x !== 0) this.spin.rotation.x = 0;

    // scarf trails behind with speed and flutters
    const trail = clamp(sp / 8, 0, 1) + (air ? 0.4 : 0) + clamp(-a.vy / 20, 0, 0.5);
    for (let i = 0; i < 3; i++) {
      const target = 0.2 + trail * (1.05 + i * 0.12) + Math.sin(t * (9 + i * 3) + i + this.gait) * 0.12 * (0.3 + trail);
      this.scarfAng[i] += (target - this.scarfAng[i]) * damp(10 - i * 2, dt);
      this.scarf[i].rotation.x = i === 0 ? this.scarfAng[0] - leanA : this.scarfAng[i] - this.scarfAng[i - 1];
      this.scarf[i].rotation.z = Math.sin(t * (6 + i * 2.5) + i * 1.3 + this.gait) * 0.1 * (0.25 + trail);
    }
  }

  dispose() {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
    });
  }
}

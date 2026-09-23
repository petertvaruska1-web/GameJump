// Viktor: the first runner ever to stand on the beacon, waiting in the white
// room behind the portal. Built from primitives like everyone else in the game,
// but finished to a higher standard than the runners: he has a face (eyes that
// blink and follow you, brows, a nose, ears, lips that move as he speaks),
// styled blonde hair, a green piqué polo with a proper collar, placket, buttons
// and ribbed sleeve hems, a watch, a belt, chinos and boat shoes, and hands
// with fingers that gesture as he talks.
//
// The rig mirrors the runner's (hips, torso, head, shoulders, elbows, hips,
// knees, ankles) plus a neck, jaw, eyelids, brows, wrists and fingers, all
// driven procedurally: breathing, weight shifts, blinking, looking at you, a
// wave hello, and a gesture for each line of his speech.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, damp } from '../../shared/math';

export type ViktorGesture = 'idle' | 'wave' | 'open' | 'chest' | 'point' | 'palms' | 'bless';

export interface ViktorState {
  /** World point he looks at (null: straight ahead). */
  lookAt: THREE.Vector3 | null;
  gesture: ViktorGesture;
  /** 0..1: how open the mouth is right now (driven by his voice). */
  mouth: number;
  /** 0..1: the blessing glow building around him. */
  glow: number;
}

type Joint = THREE.Group;

// ------------------------------------------------------------------ materials

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void, repeat = 1): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 4;
  return t;
}

/** Piqué knit: the little honeycomb of a polo shirt, as a bump map. */
function piqueTexture() {
  return canvasTexture(128, (ctx, s) => {
    ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, s, s);
    const n = 16, cell = s / n;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const ox = (y % 2) * cell * 0.5;
      const g = ctx.createRadialGradient(x * cell + ox + cell / 2, y * cell + cell / 2, 0, x * cell + ox + cell / 2, y * cell + cell / 2, cell * 0.55);
      g.addColorStop(0, '#d0d0d0'); g.addColorStop(0.7, '#707070'); g.addColorStop(1, '#404040');
      ctx.fillStyle = g;
      ctx.fillRect(x * cell + ox, y * cell, cell, cell);
    }
  }, 6);
}

/** Rib knit for the collar and sleeve bands. */
function ribTexture() {
  return canvasTexture(64, (ctx, s) => {
    for (let x = 0; x < s; x += 4) { ctx.fillStyle = x % 8 ? '#5a5a5a' : '#c8c8c8'; ctx.fillRect(x, 0, 4, s); }
  }, 4);
}

/** Cotton twill for the chinos. */
function twillTexture() {
  return canvasTexture(64, (ctx, s) => {
    ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = '#a8a8a8'; ctx.lineWidth = 2;
    for (let i = -s; i < s * 2; i += 6) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + s, s); ctx.stroke(); }
  }, 5);
}

/** Hair: fine streaks along the strands. */
function hairTexture() {
  return canvasTexture(128, (ctx, s) => {
    ctx.fillStyle = '#909090'; ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 260; i++) {
      const x = Math.random() * s, v = 90 + Math.random() * 150;
      ctx.strokeStyle = `rgb(${v},${v},${v})`;
      ctx.lineWidth = 0.6 + Math.random() * 1.4;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.bezierCurveTo(x + 6, s * 0.3, x - 6, s * 0.7, x + 3, s); ctx.stroke();
    }
  }, 2);
}

/**
 * A warm rim of light on every surface facing away from the camera: he stands in
 * the light of the room, and it separates him from the white behind him.
 */
function addRim(m: THREE.MeshStandardMaterial, strength: number, rim: { value: number }) {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uRimK = rim;
    shader.fragmentShader = 'uniform float uRimK;\n' + shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
       float vRim = pow(1.0 - saturate(dot(normalize(vNormal), normalize(vViewPosition))), 3.0);
       totalEmissiveRadiance += vec3(1.0, 0.86, 0.6) * vRim * ${strength.toFixed(2)} * uRimK;`,
    );
  };
  m.customProgramCacheKey = () => `viktor-rim-${strength.toFixed(2)}`;
}

// ------------------------------------------------------------------ geometry helpers

/**
 * Merges the parts hanging directly off one joint into one mesh per material, so
 * the detail costs draw calls per joint, not per part (the runner does the same).
 * Parts flagged `userData.own` (the brows, which move on their own) stay separate.
 */
function bakeJoint(parent: THREE.Object3D, shadows: boolean) {
  const by = new Map<THREE.Material, THREE.Mesh[]>();
  for (const c of parent.children) {
    const m = c as THREE.Mesh;
    if (!m.isMesh || m.userData.own) continue;
    const list = by.get(m.material as THREE.Material) ?? [];
    list.push(m);
    by.set(m.material as THREE.Material, list);
  }
  for (const [mat, list] of by) {
    if (list.length < 2) continue;
    const geos = list.map((m) => {
      m.updateMatrix();
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
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

const cache = new Map<string, THREE.BufferGeometry>();
const geo = <T extends THREE.BufferGeometry>(key: string, make: () => T): T => {
  let g = cache.get(key) as T | undefined;
  if (!g) { g = make(); cache.set(key, g); }
  return g;
};
const sphere = (r: number, w = 20, h = 14) => geo(`s${r}_${w}_${h}`, () => new THREE.SphereGeometry(r, w, h));
const capsule = (r: number, l: number) => geo(`c${r}_${l}`, () => new THREE.CapsuleGeometry(r, l, 6, 14));
const box = (w: number, h: number, d: number) => geo(`b${w}_${h}_${d}`, () => new THREE.BoxGeometry(w, h, d));
const cyl = (rt: number, rb: number, h: number, open = false, seg = 18) => geo(`y${rt}_${rb}_${h}_${open}_${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open));

/** A body of revolution from a (radius, y) profile, squashed to an ellipse (sx across, sz front to back). */
function lathe(key: string, profile: [number, number][], sx: number, sz: number) {
  return geo(key, () => {
    const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 28);
    g.scale(sx, 1, sz);
    g.computeVertexNormals();
    return g;
  });
}

/** Polo collar point: a flat, slightly thick shape with a pointed tip. */
function collarFlap() {
  return geo('collarFlap', () => {
    const s = new THREE.Shape();
    s.moveTo(0, 0); s.lineTo(0.052, 0.008); s.lineTo(0.062, -0.06); s.lineTo(0.03, -0.075); s.lineTo(0.004, -0.03); s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.007, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.002, bevelSegments: 1 });
    g.computeVertexNormals();
    return g;
  });
}

/**
 * Hair as one sculpted mesh: a cap over the skull whose edge follows a hairline
 * (high on the forehead, above the ears, down to the nape), thick on top, short
 * at the sides, with a quiff lifted at the front and swept to one side, and
 * ridges running back from the crown so it reads as combed strands.
 */
function hairGeometry() {
  return geo('hair', () => {
    const R = 0.108;
    const g = new THREE.SphereGeometry(R, 96, 48, 0, Math.PI * 2, 0, Math.PI * 0.82);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const ss = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const r = Math.hypot(x, y, z) || R;
      const theta = Math.acos(Math.max(-1, Math.min(1, y / r)));
      const phi = Math.atan2(z, -x); // three's sphere: x = -r cos(phi) sin(theta), z = r sin(phi) sin(theta)
      const front = Math.max(0, Math.sin(phi)), back = Math.max(0, -Math.sin(phi)), side = Math.abs(Math.cos(phi));
      const wf = front * front, wb = back * back, ws = side * side, wsum = wf + wb + ws;
      // the hairline: high on the forehead (with a little wave), above the ears, low at the nape
      const limit = ((0.3 + 0.025 * Math.sin(phi * 7)) * wf + 0.44 * ws + 0.73 * wb) / wsum * Math.PI;
      const t = Math.min(theta, limit);
      const tuck = theta > limit ? Math.min(1, (theta - limit) * 5) : 0;
      // volume: thick on top, a quiff at the front swept to his left, short at the sides
      const fq = Math.max(0, Math.sin(phi - 0.35));
      const quiff = 0.2 * Math.pow(fq, 3) * Math.exp(-Math.pow((t - 0.2 * Math.PI) / (0.13 * Math.PI), 2));
      const top = 0.07 * Math.pow(Math.cos(Math.min(t, Math.PI / 2)), 2);
      const sides = -0.035 * ws * ss(0.28 * Math.PI, 0.44 * Math.PI, t);
      // combed strands: ridges running back from the crown, curving with the sweep
      const ridge = 0.022 * Math.pow(0.5 + 0.5 * Math.sin(phi * 26 + t * 9 + fq * 3), 3) * ss(0.04 * Math.PI, 0.22 * Math.PI, t);
      const rr = R * (1 + top + quiff + sides + ridge) * (1 - tuck * 0.14);
      const st = Math.sin(t);
      pos.setXYZ(i, -rr * Math.cos(phi) * st, rr * Math.cos(t), rr * Math.sin(phi) * st);
    }
    g.computeVertexNormals();
    return g;
  });
}

/** The embroidered chest logo: the beacon he was the first to reach. */
function logoGeo() {
  return geo('logo', () => {
    const s = new THREE.Shape();
    s.moveTo(0, 0.02); s.lineTo(0.011, -0.014); s.lineTo(-0.011, -0.014); s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.002, bevelEnabled: false });
    return g;
  });
}

export class ViktorModel {
  readonly root = new THREE.Group();
  private readonly pelvis = new THREE.Group();
  private readonly torso = new THREE.Group();
  private readonly neck = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly jaw = new THREE.Group();
  private readonly eyes: Joint[] = [];
  private readonly lids: Joint[] = [];
  private readonly brows: THREE.Mesh[] = [];
  private readonly sh: Joint[] = [];
  private readonly el: Joint[] = [];
  private readonly wr: Joint[] = [];
  /** Per hand: index, middle, ring, little finger, thumb. */
  private readonly fingers: Joint[][] = [[], []];
  private readonly hip: Joint[] = [];
  private readonly kn: Joint[] = [];
  private readonly ak: Joint[] = [];
  private readonly aura: THREE.Sprite;
  private readonly rim = { value: 1 };
  private readonly mats: THREE.Material[] = [];
  private cur = new Map<string, number>();
  private blinkAt = 2;
  private blinkT = -1;
  private waveT = -1;
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpM = new THREE.Matrix4();
  /** Parts, triangles and material zones (for the evidence report). */
  readonly stats = { parts: 0, triangles: 0, materials: 0, meshes: 0 };

  constructor(glowTex: THREE.Texture, shadows: boolean) {
    const piq = piqueTexture(), rib = ribTexture(), twill = twillTexture(), hairT = hairTexture();
    const std = (o: THREE.MeshPhysicalMaterialParameters, rimK = 0.45) => {
      const m = new THREE.MeshPhysicalMaterial(o);
      addRim(m, rimK, this.rim);
      this.mats.push(m);
      return m;
    };
    const skin = std({ color: 0xe3ae8a, roughness: 0.55, sheen: 0.4, sheenRoughness: 0.6, sheenColor: new THREE.Color(0xffb89a) }, 0.35);
    const lip = std({ color: 0xc88a7c, roughness: 0.42 });
    const polo = std({ color: 0x1f8a52, roughness: 0.84, bumpMap: piq, bumpScale: 1.2, sheen: 0.35, sheenRoughness: 0.55, sheenColor: new THREE.Color(0x5fcf8f) }, 0.22);
    const ribbed = std({ color: 0x176d42, roughness: 0.86, bumpMap: rib, bumpScale: 1.5, sheen: 0.3, sheenColor: new THREE.Color(0x5fcf8f) }, 0.22);
    const button = std({ color: 0xf4efe4, roughness: 0.25, clearcoat: 0.6 }, 0.2);
    const gold = std({ color: 0xe0b54c, roughness: 0.35, metalness: 0.7, emissive: new THREE.Color(0x6a4a10), emissiveIntensity: 0.4 }, 0.3);
    const chino = std({ color: 0xc9b58c, roughness: 0.9, bumpMap: twill, bumpScale: 0.8 }, 0.25);
    const leather = std({ color: 0x5b3920, roughness: 0.45, clearcoat: 0.3 });
    const shoe = std({ color: 0x86532e, roughness: 0.42, clearcoat: 0.35 });
    const sole = std({ color: 0xf0e9dc, roughness: 0.8 });
    const steel = std({ color: 0xc9ced6, roughness: 0.28, metalness: 1 }, 0.2);
    const dial = std({ color: 0x1d2a3a, roughness: 0.2, metalness: 0.3 }, 0.1);
    const hair = std({ color: 0xdcb45c, roughness: 0.48, bumpMap: hairT, bumpScale: 1.2, sheen: 0.8, sheenRoughness: 0.35, sheenColor: new THREE.Color(0xfff0b8) }, 0.5);
    const hairLight = std({ color: 0xefd18a, roughness: 0.45, bumpMap: hairT, bumpScale: 1.2, sheen: 0.9, sheenRoughness: 0.3, sheenColor: new THREE.Color(0xfff6d6) }, 0.5);
    const brow = std({ color: 0xb58d3e, roughness: 0.7 });
    const sclera = std({ color: 0xf7f5f0, roughness: 0.15, clearcoat: 1 }, 0);
    const iris = std({ color: 0x3f86c6, roughness: 0.2, clearcoat: 1, emissive: new THREE.Color(0x0d2744), emissiveIntensity: 0.6 }, 0);
    const pupil = std({ color: 0x07090c, roughness: 0.1, clearcoat: 1 }, 0);
    const mouthIn = std({ color: 0x4a1f1c, roughness: 0.8 }, 0);
    const teeth = std({ color: 0xf2eee4, roughness: 0.3 }, 0);

    const mesh = (parent: THREE.Object3D, g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) => {
      const o = new THREE.Mesh(g, m);
      o.position.set(x, y, z);
      o.scale.set(sx, sy, sz);
      o.rotation.set(rx, ry, rz);
      o.castShadow = shadows;
      o.receiveShadow = false;
      parent.add(o);
      return o;
    };

    // ---------------------------------------------------------------- pelvis, belt, chinos
    this.root.add(this.pelvis);
    this.pelvis.position.y = 1.0;
    mesh(this.pelvis, lathe('pelvis', [[0.0, -0.13], [0.12, -0.12], [0.165, -0.06], [0.172, 0.02], [0.168, 0.07], [0.0, 0.08]], 1.02, 0.8), chino);
    // belt with loops and a brushed steel buckle
    mesh(this.pelvis, cyl(0.176, 0.176, 0.042, true, 28), leather, 0, 0.05, 0, 1.02, 1, 0.82);
    mesh(this.pelvis, box(0.05, 0.036, 0.012), steel, 0, 0.05, 0.149);
    mesh(this.pelvis, box(0.03, 0.018, 0.013), leather, 0, 0.05, 0.151);
    for (const a of [-1.25, -0.55, 0.55, 1.25, Math.PI]) {
      mesh(this.pelvis, box(0.012, 0.055, 0.008), chino, Math.sin(a) * 0.183, 0.05, Math.cos(a) * 0.147, 1, 1, 1, 0, a, 0);
    }
    // fly seam and pocket openings
    mesh(this.pelvis, box(0.006, 0.09, 0.004), leather, 0.012, -0.025, 0.139, 1, 1, 1, 0.12, 0, 0);
    for (const s of [-1, 1]) mesh(this.pelvis, box(0.005, 0.1, 0.004), chino, s * 0.135, -0.01, 0.07, 1, 1, 1, 0.1, s * 0.9, s * 0.35);

    // ---------------------------------------------------------------- torso: the polo
    this.pelvis.add(this.torso);
    this.torso.position.y = 0.06;
    mesh(this.torso, lathe('poloBody', [[0.0, -0.03], [0.168, -0.03], [0.172, 0.06], [0.176, 0.16], [0.196, 0.28], [0.205, 0.36], [0.198, 0.43], [0.178, 0.475], [0.14, 0.51], [0.1, 0.535], [0.066, 0.548], [0.0, 0.548]], 1.03, 0.76), polo);
    // a soft fold where the shirt tucks into the belt
    mesh(this.torso, cyl(0.178, 0.172, 0.03, true, 28), polo, 0, -0.005, 0, 1.03, 1, 0.77);
    // collar: a ribbed stand with two points laid over the chest, and the back folded down
    mesh(this.torso, cyl(0.066, 0.074, 0.04, true, 20), ribbed, 0, 0.555, -0.006, 1.05, 1, 1);
    for (const s of [-1, 1]) {
      const f = mesh(this.torso, collarFlap(), ribbed, s * 0.016, 0.566, 0.06, 1, 1, 1, -0.6, 0, 0);
      f.scale.x = s;
      f.rotation.y = s * 0.28;
    }
    mesh(this.torso, box(0.12, 0.03, 0.012), ribbed, 0, 0.556, -0.064, 1, 1, 1, 0.35, 0, 0);
    // placket: the top button undone, two done up, a little V of skin
    mesh(this.torso, box(0.034, 0.12, 0.008), polo, 0, 0.445, 0.149, 1, 1, 1, -0.3, 0, 0);
    mesh(this.torso, geo('neckV', () => { const g = new THREE.CircleGeometry(0.026, 3); g.rotateZ(-Math.PI / 2); return g; }), skin, 0, 0.522, 0.108, 0.8, 1.2, 1, -0.75, 0, 0);
    for (const y of [0.45, 0.4]) mesh(this.torso, cyl(0.0065, 0.0065, 0.004, false, 10), button, 0, y, y > 0.42 ? 0.151 : 0.157, 1, 1, 1, Math.PI / 2 - 0.3, 0, 0);
    // the beacon logo on the left chest, in gold thread
    mesh(this.torso, logoGeo(), gold, 0.085, 0.395, 0.152, 1, 1, 1, -0.12, 0.22, 0);
    // shoulders under the sleeves
    for (const sd of [-1, 1]) mesh(this.torso, sphere(0.058, 18, 12), polo, sd * 0.176, 0.455, -0.005, 1, 0.78, 0.92);

    // ---------------------------------------------------------------- neck and head
    this.torso.add(this.neck);
    this.neck.position.set(0, 0.535, -0.006);
    mesh(this.neck, cyl(0.057, 0.064, 0.1, false, 18), skin, 0, 0.035, 0);
    mesh(this.neck, sphere(0.011, 10, 8), skin, 0, 0.035, 0.05, 1, 1.3, 0.7); // Adam's apple
    this.neck.add(this.head);
    this.head.position.set(0, 0.052, 0.01);
    this.head.scale.setScalar(1.08);
    const H = this.head;
    // skull, a flatter face plane, brow ridge and cheekbones
    mesh(H, sphere(0.104, 32, 24), skin, 0, 0.112, -0.006, 0.93, 1.03, 0.97);
    mesh(H, sphere(0.07, 24, 16), skin, 0, 0.1, 0.03, 0.92, 1.08, 0.82);
    mesh(H, capsule(0.012, 0.064), skin, 0, 0.13, 0.086, 1, 1, 0.75, 0, 0, Math.PI / 2);
    // jaw: a hinge just in front of the ears, carrying the chin, lower lip and teeth
    H.add(this.jaw);
    this.jaw.position.set(0, 0.075, 0.0);
    mesh(this.jaw, sphere(0.068, 24, 16), skin, 0, -0.02, 0.022, 0.84, 0.74, 0.9);
    mesh(this.jaw, sphere(0.021, 14, 10), skin, 0, -0.045, 0.064, 1.15, 0.85, 0.8); // chin
    mesh(this.jaw, capsule(0.0052, 0.025), lip, 0, -0.019, 0.085, 1, 1, 0.7, 0, 0, Math.PI / 2);
    mesh(this.jaw, box(0.028, 0.005, 0.005), teeth, 0, -0.012, 0.08);
    // mouth: upper lip, and the dark inside that shows when he speaks
    mesh(H, sphere(0.016, 14, 10), mouthIn, 0, 0.061, 0.078, 1.15, 0.45, 0.5);
    mesh(H, capsule(0.0046, 0.027), lip, 0, 0.066, 0.087, 1, 1, 0.7, 0, 0, Math.PI / 2);
    mesh(H, box(0.03, 0.006, 0.005), teeth, 0, 0.062, 0.082);
    // nose: a straight bridge, a tip and two wings
    mesh(H, cyl(0.0065, 0.012, 0.042, false, 10), skin, 0, 0.103, 0.099, 1, 1, 0.85, -0.38, 0, 0);
    mesh(H, sphere(0.0115, 14, 10), skin, 0, 0.084, 0.105, 1, 0.85, 0.9);
    for (const sd of [-1, 1]) mesh(H, sphere(0.0075, 10, 8), skin, sd * 0.0105, 0.081, 0.097, 1, 0.8, 1);
    // ears, each with a rim
    for (const sd of [-1, 1]) {
      mesh(H, sphere(0.026, 14, 10), skin, sd * 0.093, 0.1, -0.012, 0.36, 1, 0.66, 0, sd * 0.25, 0);
      mesh(H, geo('earRim', () => new THREE.TorusGeometry(0.017, 0.0045, 6, 14, Math.PI * 1.3)), skin, sd * 0.098, 0.102, -0.012, 1, 1.25, 1, 0, sd * Math.PI / 2, 0.9);
    }
    // eyes: sclera, blue iris, pupil and a catch light, sitting in the face; lids that blink; brows
    for (const sd of [-1, 1]) {
      const eye = new THREE.Group();
      eye.position.set(sd * 0.033, 0.114, 0.086);
      H.add(eye);
      mesh(eye, sphere(0.0145, 16, 12), sclera, 0, 0, 0, 1, 0.82, 0.78);
      mesh(eye, sphere(0.0086, 14, 10), iris, 0, 0, 0.009, 1, 1, 0.35);
      mesh(eye, sphere(0.0038, 10, 8), pupil, 0, 0, 0.0114, 1, 1, 0.3);
      mesh(eye, sphere(0.0016, 6, 5), sclera, 0.0028, 0.0028, 0.0124, 1, 1, 0.3); // catch light
      this.eyes.push(eye);
      const lid = new THREE.Group();
      lid.position.copy(eye.position);
      H.add(lid);
      mesh(lid, geo('lid', () => new THREE.SphereGeometry(0.0158, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.5)), skin, 0, 0, 0, 1, 0.86, 0.86);
      mesh(H, geo('lowerLid', () => new THREE.SphereGeometry(0.0154, 16, 6, 0, Math.PI * 2, Math.PI * 0.74, Math.PI * 0.26)), skin, sd * 0.033, 0.114, 0.086, 1, 0.84, 0.82);
      this.lids.push(lid);
      const b = mesh(H, box(0.032, 0.0055, 0.01), brow, sd * 0.034, 0.134, 0.094, 1, 1, 1, 0.12, 0, sd * 0.05);
      b.userData.own = true;
      this.brows.push(b);
    }
    // hair: one sculpted mesh
    mesh(H, hairGeometry(), hair, 0, 0.114, -0.008, 0.95, 1.02, 1.0);

    // ---------------------------------------------------------------- arms and hands
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? 1 : -1;
      const shoulder = new THREE.Group();
      shoulder.position.set(s * 0.2, 0.445, -0.005);
      this.torso.add(shoulder);
      this.sh.push(shoulder);
      // short sleeve, flared, with a ribbed hem
      mesh(shoulder, cyl(0.062, 0.072, 0.17, true, 20), polo, 0, -0.075, 0);
      mesh(shoulder, sphere(0.062, 18, 10), polo, 0, 0.0, 0, 1, 0.55, 1);
      mesh(shoulder, cyl(0.073, 0.074, 0.024, true, 20), ribbed, 0, -0.165, 0);
      mesh(shoulder, capsule(0.05, 0.2), skin, 0, -0.15, 0);
      const elbow = new THREE.Group();
      elbow.position.y = -0.285;
      shoulder.add(elbow);
      this.el.push(elbow);
      mesh(elbow, sphere(0.047, 14, 10), skin, 0, 0, 0);
      mesh(elbow, lathe('forearm', [[0.0, -0.25], [0.034, -0.25], [0.037, -0.2], [0.048, -0.08], [0.046, 0.0], [0.0, 0.01]], 1, 0.9), skin);
      const wrist = new THREE.Group();
      wrist.position.y = -0.255;
      elbow.add(wrist);
      this.wr.push(wrist);
      // a steel watch on the left wrist
      if (s > 0) {
        mesh(elbow, cyl(0.041, 0.041, 0.018, true, 18), steel, 0, -0.225, 0, 1, 1, 0.9);
        mesh(elbow, cyl(0.017, 0.017, 0.008, false, 18), steel, 0.04, -0.225, 0, 1, 1, 1, 0, 0, Math.PI / 2);
        mesh(elbow, cyl(0.0135, 0.0135, 0.009, false, 18), dial, 0.041, -0.225, 0, 1, 1, 1, 0, 0, Math.PI / 2);
      }
      // hand: palm, four fingers and a thumb, each on its own knuckle
      mesh(wrist, sphere(0.04, 14, 10), skin, 0, -0.04, 0.004, 0.62, 1.05, 0.34);
      const fingers: Joint[] = [];
      const fx = [0.017, 0.006, -0.006, -0.016];
      const fl = [0.036, 0.04, 0.037, 0.03];
      for (let f = 0; f < 4; f++) {
        const k = new THREE.Group();
        k.position.set(fx[f] * s, -0.078, 0.004);
        wrist.add(k);
        mesh(k, capsule(0.0078, fl[f]), skin, 0, -fl[f] / 2 - 0.006, 0);
        fingers.push(k);
      }
      const th = new THREE.Group();
      th.position.set(0.02 * s, -0.035, 0.014);
      th.rotation.z = 0.5 * s;
      wrist.add(th);
      mesh(th, capsule(0.0095, 0.03), skin, 0, -0.022, 0.004);
      fingers.push(th);
      this.fingers[i] = fingers;

      // ---------------------------------------------------------------- legs
      const hip = new THREE.Group();
      hip.position.set(s * 0.095, -0.06, 0);
      this.pelvis.add(hip);
      this.hip.push(hip);
      mesh(hip, lathe('thigh', [[0.0, -0.46], [0.07, -0.46], [0.074, -0.36], [0.086, -0.16], [0.09, -0.02], [0.0, 0.04]], 1, 1), chino);
      const knee = new THREE.Group();
      knee.position.y = -0.45;
      hip.add(knee);
      this.kn.push(knee);
      mesh(knee, sphere(0.071, 16, 12), chino, 0, 0.0, 0.004);
      mesh(knee, lathe('shin', [[0.0, -0.43], [0.064, -0.43], [0.061, -0.36], [0.064, -0.2], [0.07, -0.05], [0.0, 0.02]], 1, 1), chino);
      mesh(knee, cyl(0.066, 0.067, 0.02, true, 20), chino, 0, -0.42, 0); // hem
      const ankle = new THREE.Group();
      ankle.position.y = -0.46;
      knee.add(ankle);
      this.ak.push(ankle);
      // boat shoes: a rounded toe, a lace round the collar, a white sole and heel
      mesh(ankle, sphere(0.05, 16, 10), shoe, 0, -0.002, 0.075, 0.95, 0.62, 1.35);
      mesh(ankle, box(0.092, 0.06, 0.13), shoe, 0, 0.008, 0.012);
      mesh(ankle, box(0.098, 0.02, 0.265), sole, 0, -0.035, 0.05);
      mesh(ankle, geo('lace', () => new THREE.TorusGeometry(0.048, 0.0035, 5, 18)), leather, 0, 0.036, 0.02, 1, 1.15, 1, Math.PI / 2, 0, 0);
      for (const z of [0.05, 0.075]) mesh(ankle, box(0.05, 0.004, 0.006), leather, 0, 0.034 - (z - 0.05) * 0.5, z, 1, 1, 1, 0.3, 0, 0);
    }

    // a soft golden aura that swells with the blessing
    this.aura = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffe2a0, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.18 }));
    this.aura.position.y = 1.25;
    this.aura.scale.set(1.6, 2.2, 1);
    this.root.add(this.aura);

    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      this.stats.parts++;
      const g = m.geometry;
      this.stats.triangles += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    });
    this.stats.materials = this.mats.length;
    this.stats.triangles = Math.round(this.stats.triangles);
    // one mesh per material per joint: the parts above cost a fraction of the draw calls
    const joints: THREE.Object3D[] = [];
    this.root.traverse((o) => { if ((o as THREE.Group).isGroup) joints.push(o); });
    for (const j of joints) bakeJoint(j, shadows);
    this.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) this.stats.meshes++; });
  }

  /** Smoothly drive a named value toward a target. */
  private j(key: string, target: number, rate: number, dt: number) {
    const v = this.cur.get(key) ?? target;
    const n = v + (target - v) * damp(rate, dt);
    this.cur.set(key, n);
    return n;
  }

  /** Wave hello (once, when you first come close). */
  wave() { this.waveT = 0; }

  update(dt: number, t: number, s: ViktorState) {
    // ---- where to look: the head turns part of the way, the eyes do the rest
    let yaw = 0, pitch = 0;
    if (s.lookAt) {
      this.root.updateMatrixWorld();
      this.tmpM.copy(this.root.matrixWorld).invert();
      const p = this.tmpV.copy(s.lookAt).applyMatrix4(this.tmpM);
      p.y -= 1.62;
      yaw = clamp(Math.atan2(p.x, p.z), -1.1, 1.1);
      pitch = clamp(Math.atan2(p.y, Math.hypot(p.x, p.z)), -0.5, 0.4);
    }
    // ---- blink every few seconds (and sometimes twice)
    this.blinkAt -= dt;
    if (this.blinkAt <= 0) { this.blinkT = 0; this.blinkAt = 2.2 + Math.random() * 3.2; if (Math.random() < 0.2) this.blinkAt = 0.25; }
    let lid = 0;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const u = this.blinkT / 0.16;
      lid = Math.sin(Math.min(1, u) * Math.PI) * 1.85;
      if (u >= 1) this.blinkT = -1;
    }

    // ---- pose targets: [shoulder x, shoulder z (+ out, - across), elbow x, wrist x, curl] per arm
    const L = 0, R = 1; // arm 0 hangs at +x (his left, as he faces +z), arm 1 at -x (his right)
    const br = Math.sin(t * 1.9);
    const shift = Math.sin(t * 0.5);
    const arm: number[][] = [[0.05, 0.12, -0.18, 0.05, 0.35], [0.05, 0.12, -0.22, 0.05, 0.4]];
    let lean = 0.02 + br * 0.012, headTilt = 0, browUp = 0, torsoTwist = 0;
    const g = s.gesture;
    const beat = Math.sin(t * 2.4) * 0.5 + 0.5;
    if (this.waveT >= 0) {
      this.waveT += dt;
      const w = Math.min(1, this.waveT / 0.35) * Math.min(1, Math.max(0, (2.4 - this.waveT) / 0.4));
      arm[R] = [-0.35 * w, 1.0 * w + 0.12, -1.35 * w - 0.2, -0.1, 0.05 + 0.3 * (1 - w)];
      arm[R][1] += Math.sin(this.waveT * 9) * 0.12 * w;
      browUp = 0.6 * w;
      if (this.waveT > 2.4) this.waveT = -1;
    } else if (g === 'open') {
      // one hand held out toward you, palm up
      arm[R] = [-0.75 - beat * 0.1, 0.35, -0.75, -0.25, 0.15];
      arm[L] = [-0.2, 0.2, -0.45, 0, 0.3];
      browUp = 0.35; lean = 0.06;
    } else if (g === 'chest') {
      // his left hand on his heart
      arm[R] = [-0.32, -0.82, -2.1, 0.2, 0.2];
      arm[L] = [-0.1 - beat * 0.05, 0.18, -0.35, 0, 0.35];
      headTilt = 0.08; lean = 0.04;
    } else if (g === 'point') {
      // raised toward the sky, toward the beacon
      arm[R] = [-2.55, 0.25, -0.25, 0.15, 1.1];
      arm[L] = [-0.15, 0.22, -0.35, 0, 0.35];
      browUp = 0.8; lean = -0.04; torsoTwist = -0.08;
    } else if (g === 'palms') {
      // both hands out, palms toward you: "not anymore"
      arm[0] = [-0.7, 0.42, -1.0 - beat * 0.12, -1.0, 0.05];
      arm[1] = [-0.7, 0.42, -1.0 - beat * 0.12, -1.0, 0.05];
      headTilt = -0.05; browUp = 0.2; lean = 0.03;
    } else if (g === 'bless') {
      // both arms rising, opening to the light
      const up = s.glow * s.glow * (3 - 2 * s.glow);
      arm[L] = [-0.9 - 1.45 * up, 0.42 + 0.2 * up, -0.6 + 0.4 * up, -0.4, 0.05];
      arm[R] = [-0.9 - 1.45 * up, 0.42 + 0.2 * up, -0.6 + 0.4 * up, -0.4, 0.05];
      browUp = 0.5; lean = -0.08 * s.glow; pitch -= 0.1 * s.glow;
    }
    // ---- apply: arms
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const a = arm[i];
      this.sh[i].rotation.x = this.j('sx' + i, a[0] + (g === 'idle' ? br * 0.02 : 0), 5, dt);
      this.sh[i].rotation.z = this.j('sz' + i, a[1], 5, dt) * side;
      this.el[i].rotation.x = this.j('ex' + i, a[2], 5.5, dt);
      this.wr[i].rotation.x = this.j('wx' + i, a[3], 6, dt);
      const curl = this.j('cu' + i, a[4], 7, dt);
      // pointing keeps the index finger straight while the rest curl in
      const f = this.fingers[i];
      for (let k = 0; k < 4; k++) f[k].rotation.x = (g === 'point' && i === R && k === 0 ? 0.05 : curl * (1 + k * 0.15)) * 1.1;
      f[4].rotation.x = curl * 0.6;
    }
    // ---- legs: weight shifting from foot to foot, knees soft
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const load = 0.5 + 0.5 * shift * side;
      this.hip[i].rotation.x = this.j('hx' + i, -0.03 - (1 - load) * 0.05, 4, dt);
      this.hip[i].rotation.z = this.j('hz' + i, side * 0.03, 4, dt);
      this.kn[i].rotation.x = this.j('kx' + i, 0.04 + (1 - load) * 0.12, 4, dt);
      this.ak[i].rotation.x = this.j('ax' + i, -0.01 - (1 - load) * 0.06, 4, dt);
    }
    this.pelvis.position.x = this.j('px', shift * 0.018, 3, dt);
    this.pelvis.position.y = 1.0 + br * 0.004 - Math.abs(shift) * 0.006;
    this.pelvis.rotation.z = this.j('pz', -shift * 0.03, 3, dt);
    this.torso.rotation.x = this.j('lean', lean, 4, dt);
    this.torso.rotation.z = shift * 0.02;
    this.torso.rotation.y = this.j('tw', yaw * 0.25 + torsoTwist, 3, dt);
    this.torso.scale.set(1 + br * 0.006, 1, 1 + br * 0.012);
    // ---- head and face
    this.neck.rotation.y = this.j('ny', yaw * 0.35, 5, dt);
    this.head.rotation.y = this.j('hy', yaw * 0.4, 6, dt);
    this.head.rotation.x = this.j('hp', -pitch * 0.6 - this.cur.get('lean')! * 0.8, 6, dt);
    this.head.rotation.z = this.j('ht', headTilt + Math.sin(t * 0.7) * 0.02, 4, dt);
    const ey = clamp(yaw - (this.cur.get('hy') ?? 0) - (this.cur.get('ny') ?? 0) - (this.cur.get('tw') ?? 0), -0.35, 0.35);
    for (const e of this.eyes) { e.rotation.y = this.j('ey', ey, 14, dt); e.rotation.x = this.j('ep', -pitch * 0.4, 14, dt); }
    for (const l of this.lids) l.rotation.x = -0.2 + lid - this.cur.get('ep')! * 0.5;
    const bu = this.j('bu', browUp + s.mouth * 0.25, 8, dt);
    this.brows.forEach((b, i) => { b.position.y = 0.134 + bu * 0.005; b.rotation.z = (i === 0 ? 1 : -1) * (0.05 + bu * 0.1); });
    this.jaw.rotation.x = this.j('jaw', s.mouth * 0.2, 22, dt);
    // ---- the light around him
    this.rim.value = 1 + s.glow * 2.5;
    const am = this.aura.material as THREE.SpriteMaterial;
    // kept above the floor at every size: a glow that sinks into the floor shows as a hard edge
    am.opacity = 0.1 + Math.sin(t * 1.3) * 0.02 + s.glow * 0.25;
    this.aura.scale.set(1.6 + s.glow * 0.6, 2.2 + s.glow * 0.3, 1);
  }

  dispose() {
    for (const m of this.mats) {
      const mm = m as THREE.MeshPhysicalMaterial;
      mm.bumpMap?.dispose();
      m.dispose();
    }
    (this.aura.material as THREE.SpriteMaterial).dispose();
  }
}

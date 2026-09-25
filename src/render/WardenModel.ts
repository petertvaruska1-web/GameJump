// The Warden on screen: a four-legged war machine as tall as a building, built
// from authored parts like everything else in the game -- no two boxes and a
// glow. A long armoured hull on four spider legs, a reactor core glowing in a
// cage on its back (its weak point), a wedge head with one great lens, twin
// mortar cannons on shoulder turrets, the hive on its tail that bots come out
// of, exhaust stacks, pistons, cables and plates of armour that come away as it
// is broken down.
//
// Its legs are not animated on a loop: each foot stays planted where it landed
// until the body has moved far enough from it, then steps (diagonal pairs in
// turn) to where the body needs it, with two-bone IK solving the knee. Whatever
// the server makes it do -- walk, turn on the spot, charge, slump in a stagger,
// collapse -- the feet follow. Every state it can be in has its own look: the
// eye charging white-hot before the beam, the legs glowing before a stomp, the
// cannons raised for a barrage, the hive hatch open, the hull crackling blue
// before a shock, the core laid bare in a stagger, the red of overdrive.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BOSS } from '../../shared/constants';
import { clamp, damp, lerp, wrapAngle } from '../../shared/math';
import { BAct, BState } from '../../shared/protocol';
import { swipeAt } from '../../shared/sim/warden';

/** Leg segment lengths (hip to knee, knee to foot). */
const THIGH = 4.4, SHIN = 8.6;
const LEGS: [number, number][] = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
/** Diagonal pairs step in turn: front-right with back-left, front-left with back-right. */
const PAIR = [0, 1, 1, 0];

export interface WardenPose {
  x: number; z: number; yaw: number; lift: number;
  state: number; act: number;
  /** Seconds since the current ability began, and the numbers it was announced with. */
  actT: number; actD: readonly number[] | null;
  overdrive: boolean;
  /** Health left, 0..1. */
  hpK: number;
  /** Who it is looking at (null: nobody). */
  look: THREE.Vector3 | null;
  /** Match clock (hazards are functions of it). */
  mt: number;
}

interface Leg {
  sx: number; sz: number;
  planted: THREE.Vector3;
  from: THREE.Vector3;
  to: THREE.Vector3;
  stepT: number;
  stepDur: number;
  stepping: boolean;
  thigh: THREE.Group; shin: THREE.Group; foot: THREE.Group; hip: THREE.Object3D;
  knee: THREE.Vector3;
}

const _h = new THREE.Vector3(), _f = new THREE.Vector3(), _u = new THREE.Vector3(), _w = new THREE.Vector3(), _k = new THREE.Vector3();
const _q = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0), _v = new THREE.Vector3();

/** A panel texture for the hull: plates, seams, rivets, scuffs and a stencilled number. */
function panelTexture(): THREE.CanvasTexture {
  const S = 512, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#8a929c'; g.fillRect(0, 0, S, S);
  let seed = 3;
  const r = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  // plates of slightly different tone
  for (let y = 0; y < S; y += 128) for (let x = 0; x < S; x += 128) {
    const v = 120 + Math.floor(r() * 30);
    g.fillStyle = `rgb(${v},${v + 4},${v + 10})`; g.fillRect(x + 3, y + 3, 122, 122);
    g.fillStyle = 'rgba(210,215,225,0.55)';
    for (const [px, py] of [[10, 10], [118, 10], [10, 118], [118, 118]]) { g.beginPath(); g.arc(x + px, y + py, 3, 0, Math.PI * 2); g.fill(); }
  }
  g.strokeStyle = 'rgba(20,22,28,0.9)'; g.lineWidth = 4;
  for (let i = 0; i <= S; i += 128) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, S); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(S, i); g.stroke(); }
  // scratches and grime
  for (let i = 0; i < 90; i++) {
    g.strokeStyle = `rgba(${r() < 0.5 ? '230,235,240' : '20,18,16'},${0.08 + r() * 0.15})`; g.lineWidth = 1 + r() * 2;
    const x = r() * S, y = r() * S; g.beginPath(); g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 60, y + (r() - 0.5) * 20); g.stroke();
  }
  for (let i = 0; i < 14; i++) {
    const x = r() * S, y = r() * S, rad = 20 + r() * 60, gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, 'rgba(40,28,18,0.35)'); gr.addColorStop(1, 'rgba(40,28,18,0)'); g.fillStyle = gr; g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  g.fillStyle = 'rgba(230,180,50,0.8)'; g.font = 'bold 44px Arial, sans-serif'; g.fillText('W-01', 150, 330);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

type Bag = Map<THREE.Material, THREE.BufferGeometry[]>;

export class WardenModel {
  readonly root = new THREE.Group();
  /** The hull and everything on it (rides at the hull's height). */
  private readonly body = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly arms: THREE.Group[] = [];
  private readonly barrels: THREE.Group[] = [];
  private readonly hatch: THREE.Group[] = [];
  private readonly coreShell = new THREE.Group();
  private readonly plates: THREE.Mesh[] = [];
  private readonly legs: Leg[] = [];
  // materials
  private readonly armor: THREE.MeshStandardMaterial;
  private readonly paint: THREE.MeshStandardMaterial;
  private readonly frame: THREE.MeshStandardMaterial;
  private readonly black: THREE.MeshStandardMaterial;
  private readonly eyeMat: THREE.MeshBasicMaterial;
  private readonly coreMat: THREE.MeshBasicMaterial;
  private readonly ventMat: THREE.MeshBasicMaterial;
  private readonly legGlow: THREE.MeshBasicMaterial;
  private readonly strobeMat: THREE.MeshBasicMaterial;
  private readonly flare: THREE.Sprite;
  private readonly coreGlow: THREE.Sprite;
  private readonly shock: THREE.LineSegments;
  private readonly shockPos: Float32Array;
  private hitFlash = 0;
  private bodyPitch = 0;
  private bodyRoll = 0;
  private recoilK = [0, 0];
  /** Being shoved by a blast of force: springs on its pitch, its roll and a sway of the whole body (local x / z). */
  private readonly shove = { p: 0, vp: 0, r: 0, vr: 0, x: 0, vx: 0, z: 0, vz: 0 };
  private stomp = 0;
  private lastX = NaN;
  private lastZ = NaN;
  private readonly vel = new THREE.Vector3();
  private readonly eyeColor = new THREE.Color();
  private seeded = false;
  /** Where the eye and the core are in the world this frame (effects hang off them). */
  readonly eyeWorld = new THREE.Vector3();
  readonly coreWorld = new THREE.Vector3();
  readonly hiveWorld = new THREE.Vector3();
  readonly muzzleWorld = [new THREE.Vector3(), new THREE.Vector3()];

  constructor(glowTex: THREE.Texture, private readonly shadows: boolean, private readonly onStep: (p: THREE.Vector3, strength: number) => void) {
    const panel = panelTexture();
    panel.repeat.set(0.35, 0.35);
    this.armor = new THREE.MeshStandardMaterial({ color: 0x5a616c, map: panel, roughness: 0.48, metalness: 0.72, emissive: new THREE.Color(0), envMapIntensity: 0.9 });
    this.paint = new THREE.MeshStandardMaterial({ color: 0xc89a2c, map: panel, roughness: 0.6, metalness: 0.35, emissive: new THREE.Color(0) });
    this.frame = new THREE.MeshStandardMaterial({ color: 0x3b424c, roughness: 0.4, metalness: 0.85, emissive: new THREE.Color(0) });
    this.black = new THREE.MeshStandardMaterial({ color: 0x141619, roughness: 0.7, metalness: 0.4 });
    this.eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 1.2, 0.3), toneMapped: false });
    this.coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 1.3, 0.35), toneMapped: false });
    this.ventMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 0.7, 0.15), toneMapped: false });
    this.legGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 0.18, 0.05), toneMapped: false });
    this.strobeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 0.05, 0.05), toneMapped: false });
    this.root.add(this.body);

    const bag: Bag = new Map();
    const put = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, b: Bag = bag) => {
      const q = g.index ? g.toNonIndexed() : g;
      for (const k of Object.keys(q.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') q.deleteAttribute(k);
      if (!q.getAttribute('uv')) q.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(q.getAttribute('position').count * 2), 2));
      q.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)).setPosition(x, y, z));
      const list = b.get(m) ?? [];
      list.push(q);
      b.set(m, list);
    };
    const flush = (b: Bag, parent: THREE.Object3D) => {
      for (const [m, list] of b) {
        const mesh = new THREE.Mesh(mergeGeometries(list, false)!, m);
        mesh.castShadow = shadows && !(m instanceof THREE.MeshBasicMaterial);
        mesh.receiveShadow = shadows && !(m instanceof THREE.MeshBasicMaterial);
        parent.add(mesh);
      }
      b.clear();
    };
    const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
    const cyl = (r0: number, r1: number, h: number, n = 12) => new THREE.CylinderGeometry(r0, r1, h, n);

    // ------------------------------------------------------------ hull
    put(box(6.2, 2.6, 8.4), this.armor);
    put(box(5.0, 0.6, 7.2), this.armor, 0, 1.55, -0.3);                 // top deck
    put(box(6.6, 0.5, 7.6), this.frame, 0, -1.5, 0);                     // belly
    for (const s of [-1, 1]) {
      put(box(0.9, 2.2, 7.8), this.frame, s * 3.25, 0, 0);               // side sponsons
      put(box(0.2, 0.25, 7.4), this.ventMat, s * 3.72, -0.55, 0);        // glowing vent slits
      put(box(0.2, 0.25, 7.4), this.ventMat, s * 3.72, 0.1, 0);
      for (let i = 0; i < 5; i++) put(box(0.5, 1.9, 0.18), this.black, s * 3.55, -0.2, -3.2 + i * 1.6); // side ribs
    }
    put(box(5.6, 1.4, 1.6), this.armor, 0, 0.9, 3.9, -0.55);             // sloped glacis to the head
    put(box(5.0, 2.0, 0.6), this.frame, 0, -0.1, -4.35);                 // tail plate
    // the reactor cage on its back
    const ring = new THREE.TorusGeometry(1.65, 0.22, 8, 20); ring.rotateX(Math.PI / 2);
    put(ring, this.frame, 0, 1.95, -0.6);
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; put(box(0.22, 1.1, 0.4), this.frame, Math.sin(a) * 1.72, 2.35, -0.6 + Math.cos(a) * 1.72, 0, a, 0); }
    // exhaust stacks
    for (const s of [-1, 1]) {
      put(cyl(0.34, 0.42, 2.0), this.frame, s * 1.9, 2.5, -3.5);
      put(cyl(0.44, 0.44, 0.25), this.black, s * 1.9, 3.5, -3.5);
    }
    // cables along the deck
    for (const s of [-1, 1]) {
      const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(s * 1.4, 1.9, 2.8), new THREE.Vector3(s * 2.2, 2.3, 0.8), new THREE.Vector3(s * 2.0, 2.0, -2.2), new THREE.Vector3(s * 1.6, 2.2, -3.4)]);
      put(new THREE.TubeGeometry(curve, 18, 0.12, 6), this.black);
    }
    flush(bag, this.body);

    // the core itself, and the shell that closes over it (it opens in a stagger)
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(1.05, 2), this.coreMat);
    core.position.set(0, 2.05, -0.6);
    this.body.add(core);
    this.coreGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xff8a3a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.8 }));
    this.coreGlow.position.copy(core.position);
    this.coreGlow.scale.setScalar(5);
    this.body.add(this.coreGlow);
    this.coreShell.position.set(0, 2.05, -0.6);
    for (let i = 0; i < 4; i++) {
      const petal = new THREE.Mesh(new THREE.SphereGeometry(1.45, 10, 6, (i * Math.PI) / 2 + 0.08, Math.PI / 2 - 0.16, 0, Math.PI / 2.4), this.armor);
      petal.castShadow = shadows;
      petal.userData.i = i;
      this.coreShell.add(petal);
    }
    this.body.add(this.coreShell);

    // ------------------------------------------------------------ armour plates (they come away as it breaks)
    const plateGeo = new THREE.BoxGeometry(1.9, 1.3, 0.22);
    const spots: [number, number, number, number, number][] = [];
    for (const s of [-1, 1]) for (let i = 0; i < 4; i++) spots.push([s * 3.82, 0.35, -2.7 + i * 1.8, 0, s * Math.PI / 2]);
    for (let i = 0; i < 2; i++) for (const s of [-1, 1]) spots.push([s * 1.35, 1.95, 1.5 + i * -4.1, -Math.PI / 2 + 0.25 * s, 0]);
    for (const [x, y, z, rx, ry] of spots) {
      const pl = new THREE.Mesh(plateGeo, this.paint);
      pl.position.set(x, y, z); pl.rotation.set(rx, ry, 0);
      pl.castShadow = shadows;
      this.plates.push(pl);
      this.body.add(pl);
    }

    // ------------------------------------------------------------ head
    this.head.position.set(0, 0.5, 4.6);
    this.body.add(this.head);
    put(box(3.2, 2.2, 2.6), this.armor, 0, 0, 0.6);
    put(box(3.5, 0.5, 2.9), this.frame, 0, 1.25, 0.5, -0.12);            // brow
    put(box(2.6, 0.6, 1.2), this.frame, 0, -1.15, 1.2, 0.3);             // jaw
    for (const s of [-1, 1]) {
      put(box(0.5, 1.8, 2.4), this.paint, s * 1.75, 0, 0.5, 0, s * 0.18);  // cheek guards
      put(new THREE.ConeGeometry(0.16, 1.6, 5), this.frame, s * 1.1, 1.9, -0.2, -0.5, 0, s * 0.4); // antenna fins
    }
    put(new THREE.TorusGeometry(0.95, 0.2, 10, 28), this.frame, 0, 0, 1.92);  // lens housing
    put(cyl(1.0, 1.1, 0.5, 20), this.black, 0, 0, 1.75, Math.PI / 2);
    flush(bag, this.head);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.78, 24), this.eyeMat);
    lens.position.set(0, 0, 2.03);
    this.head.add(lens);
    this.flare = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffb070, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.8 }));
    this.flare.position.set(0, 0, 2.4);
    this.flare.scale.setScalar(3);
    this.head.add(this.flare);

    // ------------------------------------------------------------ cannons on shoulder turrets
    for (const s of [-1, 1]) {
      const arm = new THREE.Group();
      arm.position.set(s * 4.4, 0.25, 1.4);
      this.body.add(arm);
      put(new THREE.SphereGeometry(1.05, 12, 8), this.frame);
      put(box(0.5, 1.7, 1.7), this.paint, s * 0.7, 0, 0);
      flush(bag, arm);
      const barrel = new THREE.Group();
      arm.add(barrel);
      for (const bx of [-0.34, 0.34]) {
        put(cyl(0.3, 0.34, 2.8, 10), this.armor, bx, 0.1, 1.45, Math.PI / 2);
        put(cyl(0.4, 0.4, 0.5, 10), this.frame, bx, 0.1, 2.75, Math.PI / 2);
      }
      put(box(1.2, 0.3, 1.6), this.frame, 0, -0.35, 0.9);
      flush(bag, barrel);
      this.arms.push(arm);
      this.barrels.push(barrel);
    }

    // ------------------------------------------------------------ the hive on its tail
    const hive = new THREE.Group();
    hive.position.set(0, 1.9, -3.2);
    this.body.add(hive);
    put(cyl(1.5, 1.7, 1.1, 6), this.armor, 0, 0, 0);
    put(cyl(1.2, 1.2, 0.2, 6), this.black, 0, 0.5, 0);
    flush(bag, hive);
    const strobe = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.12, 6), this.strobeMat);
    strobe.position.y = 0.52;
    hive.add(strobe);
    for (const s of [-1, 1]) {
      const door = new THREE.Group();
      door.position.set(s * 1.2, 0.6, 0);
      const d = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.18, 2.2), this.paint);
      d.position.x = -s * 0.6;
      d.castShadow = shadows;
      door.add(d);
      hive.add(door);
      this.hatch.push(door);
    }

    // ------------------------------------------------------------ legs
    for (const [sx, sz] of LEGS) {
      const hip = new THREE.Mesh(new THREE.SphereGeometry(0.95, 12, 8), this.frame);
      hip.position.set(sx * 3.3, -0.6, sz * 3.0);
      hip.castShadow = shadows;
      this.body.add(hip);
      const thigh = new THREE.Group(), shin = new THREE.Group(), foot = new THREE.Group();
      // thigh: a box beam along +Y with a piston beside it and a painted plate on top
      put(box(0.95, THIGH, 1.0), this.armor, 0, THIGH / 2, 0);
      put(cyl(0.18, 0.18, THIGH * 0.8), this.frame, 0.62, THIGH * 0.45, 0);
      put(box(0.2, THIGH * 0.7, 1.15), this.paint, -0.55, THIGH / 2, 0);
      put(new THREE.SphereGeometry(0.75, 10, 8), this.frame, 0, THIGH, 0);
      put(new THREE.ConeGeometry(0.28, 1.8, 6), this.frame, 0, THIGH + 0.9, 0);  // the knee spike
      flush(bag, thigh);
      // shin: tapering down to the foot, with a strip that glows before a stomp
      put(new THREE.CylinderGeometry(0.62, 0.38, SHIN, 8), this.armor, 0, SHIN / 2, 0);
      put(box(0.14, SHIN * 0.7, 0.3), this.legGlow, 0.52, SHIN * 0.5, 0);
      put(box(1.3, 1.6, 1.3), this.frame, 0, SHIN - 0.6, 0);
      flush(bag, shin);
      // a clawed foot
      put(cyl(0.95, 1.1, 0.5, 10), this.frame, 0, 0.25, 0);
      for (let i = 0; i < 3; i++) put(new THREE.ConeGeometry(0.26, 1.3, 5), this.black, (i - 1) * 0.55, 0.2, 0.95, Math.PI / 2 - 0.2, 0, 0);
      put(new THREE.ConeGeometry(0.26, 1.0, 5), this.black, 0, 0.2, -0.85, -Math.PI / 2 + 0.2, 0, 0);
      flush(bag, foot);
      this.root.add(thigh, shin, foot);
      this.legs.push({
        sx, sz, planted: new THREE.Vector3(), from: new THREE.Vector3(), to: new THREE.Vector3(), stepT: 0, stepDur: 0.4, stepping: false,
        thigh, shin, foot, hip, knee: new THREE.Vector3(),
      });
    }

    // arcs over the hull before a shock
    this.shockPos = new Float32Array(48 * 6);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(this.shockPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.shock = new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ color: new THREE.Color(1, 2.2, 3.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.shock.frustumCulled = false;
    this.shock.visible = false;
    this.body.add(this.shock);
  }

  /** A hit landed: the whole machine flashes. */
  hit(k: number) { this.hitFlash = Math.max(this.hitFlash, clamp(k, 0.3, 1)); }

  /** A mortar shell left a cannon (-1 left, 1 right). */
  recoil(side: number) { this.recoilK[side < 0 ? 0 : 1] = 1; }

  /**
   * A blast of force struck it, pushing along (dx, dz) in the world with strength
   * k (0..1+): the whole machine rocks away from it, sways and settles, and its
   * head snaps back.
   */
  shoved(dx: number, dz: number, k: number) {
    const yaw = this.root.rotation.y, c = Math.cos(yaw), s = Math.sin(yaw);
    const fwd = dx * s + dz * c, side = dx * c - dz * s;
    const S = this.shove;
    S.vp += fwd * 2.3 * k; S.vr -= side * 1.9 * k;
    S.vx += side * 3.2 * k; S.vz += fwd * 3.2 * k;
    this.head.rotation.x -= 0.34 * k;
    this.hitFlash = Math.max(this.hitFlash, 0.5 * k);
  }

  /** Local point on the Warden -> world (with its current pose). */
  private toWorld(x: number, z: number, yaw: number, lx: number, ly: number, lz: number, floorY: number, out: THREE.Vector3) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return out.set(x + lx * c + lz * s, floorY + ly, z - lx * s + lz * c);
  }

  update(p: WardenPose, floorY: number, dt: number, t: number) {
    const root = this.root;
    root.position.set(p.x, floorY, p.z);
    root.rotation.y = p.yaw;
    if (!isNaN(this.lastX) && dt > 0) {
      this.vel.x += ((p.x - this.lastX) / dt - this.vel.x) * damp(6, dt);
      this.vel.z += ((p.z - this.lastZ) / dt - this.vel.z) * damp(6, dt);
    }
    this.lastX = p.x; this.lastZ = p.z;
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const dying = p.state === BState.Dying || p.state === BState.Dead;
    const staggered = p.state === BState.Stagger;
    const dormant = p.state === BState.Dormant;
    const act = p.state === BState.Act ? p.act : BAct.None;
    const D = p.actD;

    // ------------------------------------------------------------ body pose
    let pitch = 0, roll = 0, bob = 0, headPitch = 0;
    if (act === BAct.Charge && D) {
      const telling = p.mt < D[3];
      pitch = telling ? 0.1 : 0.16; headPitch = telling ? 0.32 : 0.22;
    }
    if (staggered) { pitch = 0.14 + Math.sin(t * 17) * 0.015; roll = 0.07 + Math.sin(t * 13) * 0.02; headPitch = 0.4; }
    if (dormant) { pitch = 0.06; headPitch = 0.45; }
    if (dying) { const k = clamp(p.actT, 0, 1); pitch = 0.2 + Math.sin(t * 23) * 0.03 * (1 - k); roll = 0.18; headPitch = 0.6; }
    roll += clamp(-wrapAngle(Math.atan2(this.vel.x, this.vel.z) - p.yaw) * speed * 0.01, -0.06, 0.06);
    // a footfall settles the body a touch
    for (const l of this.legs) if (l.stepping) bob -= 0.05;
    // a shove rocks it on springs, over the pose it holds
    const S = this.shove, h = Math.min(dt, 0.05);
    S.vp += (-70 * S.p - 8 * S.vp) * h; S.p += S.vp * h;
    S.vr += (-70 * S.r - 8 * S.vr) * h; S.r += S.vr * h;
    S.vx += (-45 * S.x - 7 * S.vx) * h; S.x += S.vx * h;
    S.vz += (-45 * S.z - 7 * S.vz) * h; S.z += S.vz * h;
    this.body.position.set(S.x, p.lift + bob, S.z);
    this.bodyPitch += (pitch - this.bodyPitch) * damp(5, dt);
    this.bodyRoll += (roll - this.bodyRoll) * damp(4, dt);
    this.body.rotation.x = this.bodyPitch + S.p;
    this.body.rotation.z = this.bodyRoll + S.r;

    // the head turns toward whoever it is watching
    let headYaw = 0;
    if (p.look && !dying && !dormant) {
      const lx = p.look.x - p.x, lz = p.look.z - p.z;
      headYaw = clamp(wrapAngle(Math.atan2(lx, lz) - p.yaw), -0.55, 0.55);
    }
    this.head.rotation.y += (headYaw - this.head.rotation.y) * damp(4, dt);
    this.head.rotation.x += (headPitch - this.head.rotation.x) * damp(5, dt);

    // cannons: raised for a barrage, kicked back by each shot; one swings round in a swipe
    const mortar = act === BAct.Mortar;
    for (let i = 0; i < 2; i++) {
      this.recoilK[i] = Math.max(0, this.recoilK[i] - dt * 4);
      const b = this.barrels[i];
      b.rotation.x += ((mortar ? -0.95 : dormant ? 0.3 : 0.05) - b.rotation.x) * damp(6, dt);
      b.position.z = -this.recoilK[i] * 0.6;
      const arm = this.arms[i], side = i === 0 ? -1 : 1;
      let armYaw = 0, armRoll = 0;
      if (act === BAct.Swipe && D && D[1] === -side) {
        const a = swipeAt(D, p.mt);
        if (!isNaN(a)) { armYaw = clamp(wrapAngle(a - p.yaw) - side * 1.2, -2.2, 2.2); armRoll = side * 0.9; }
        else if (p.mt < D[2]) { armYaw = side * 0.9 * clamp(p.actT / 0.4, 0, 1); armRoll = side * 0.5; }
      }
      arm.rotation.y += (armYaw - arm.rotation.y) * damp(act === BAct.Swipe ? 18 : 6, dt);
      arm.rotation.z += (armRoll - arm.rotation.z) * damp(8, dt);
    }

    // the hive: hatch open while bots come out
    const open = act === BAct.Deploy ? 1 : 0;
    this.hatch.forEach((h, i) => { const s = i === 0 ? -1 : 1; h.rotation.z += ((open ? s * 1.9 : 0) - h.rotation.z) * damp(7, dt); });
    const strobe = act === BAct.Deploy && Math.sin(t * 18) > 0;
    this.strobeMat.color.setRGB(strobe ? 3.2 : 0.35, strobe ? 0.25 : 0.04, strobe ? 0.2 : 0.04);

    // the core: its shell opens when it staggers, and it burns brighter as the machine breaks
    const bare = staggered ? 1 : 0;
    for (const petal of this.coreShell.children) {
      const i = petal.userData.i as number, a = (i * Math.PI) / 2 + Math.PI / 4;
      const k = bare;
      petal.position.set(Math.cos(a) * k * 0.7, k * 0.35, -Math.sin(a) * k * 0.7);
      petal.rotation.set(-Math.sin(a) * k * 0.8, 0, -Math.cos(a) * k * 0.8);
    }
    const heat = (1 - p.hpK) * 0.8 + (p.overdrive ? 0.6 : 0) + bare * 0.8;
    const pulse = 0.85 + Math.sin(t * (p.overdrive ? 9 : 4)) * 0.15;
    const coreOn = dying ? Math.max(0, 1 - p.actT / 3) * (Math.random() < 0.3 ? 0.3 : 1) : 1;
    this.coreMat.color.setRGB((2.6 + heat * 1.6) * pulse * coreOn, (1.0 + heat * 0.9) * pulse * coreOn, (0.3 + heat * 0.5) * pulse * coreOn);
    (this.coreGlow.material as THREE.SpriteMaterial).opacity = (0.45 + heat * 0.35 + bare * 0.3) * coreOn;
    this.coreGlow.scale.setScalar(4 + heat * 2 + bare * 3);
    this.ventMat.color.setRGB((1.4 + heat * 1.4) * pulse * coreOn, (0.4 + heat * 0.3) * pulse * coreOn, 0.12 * coreOn);

    // the eye: amber watching, white-hot charging the beam, red in overdrive, guttering when staggered or dying
    let eye = p.overdrive ? [3.2, 0.45, 0.2] : [2.4, 1.2, 0.3];
    let flare = 2.6;
    if (act === BAct.Beam && D) {
      const charge = clamp(1 - (D[6] - p.mt) / 1.1, 0, 1);
      const firing = p.mt >= D[6];
      eye = firing ? [4, 3, 2.4] : [2.4 + charge * 1.6, 1.2 + charge * 1.8, 0.3 + charge * 2.0];
      flare = firing ? 7 : 2.6 + charge * 4.5 + Math.sin(t * 40) * charge;
    }
    if (dormant) { eye = [0.5, 0.25, 0.08]; flare = 1.2; }
    if (staggered) { const f = Math.random() < 0.25 ? 0.2 : 1; eye = [1.5 * f, 0.5 * f, 0.15 * f]; flare = 1.8 * f; }
    if (dying) { const k = Math.max(0, 1 - p.actT / 2.5); eye = [2.4 * k, 0.6 * k, 0.2 * k]; flare = 3 * k; }
    this.eyeColor.setRGB(eye[0], eye[1], eye[2]);
    this.eyeMat.color.lerp(this.eyeColor, damp(10, dt));
    this.flare.scale.setScalar(flare);
    (this.flare.material as THREE.SpriteMaterial).color.setRGB(Math.min(1, eye[0] / 3), Math.min(1, eye[1] / 3), Math.min(1, eye[2] / 3));

    // legs glow before a stomp; the front feet come up with the body and slam down
    let glow = 0.25 + heat * 0.2;
    this.stomp = 0;
    if (act === BAct.Stomp && D) {
      const k = clamp(p.actT / Math.max(0.1, D[2] - (p.mt - p.actT)), 0, 1);
      if (p.mt < D[2]) { glow = 0.4 + k * 2.6 * (0.8 + Math.sin(t * 30) * 0.2); this.stomp = k; }
    }
    this.legGlow.color.setRGB(glow * 2.2, glow * 0.6, glow * 0.12);

    // shock: the hull crackles blue before it discharges
    const shocking = act === BAct.Shock && D && p.mt < D[0] + 0.15;
    this.shock.visible = !!shocking;
    if (shocking) this.crackle();

    // a hit flashes the plating; overdrive leaves a red heat in it
    this.hitFlash = Math.max(0, this.hitFlash - dt * 6);
    const hf = this.hitFlash;
    const shockBlue = shocking ? 0.35 + Math.random() * 0.3 : 0;
    for (const m of [this.armor, this.paint, this.frame]) {
      m.emissive.setRGB(hf * 1.6 + (p.overdrive ? 0.08 : 0), hf * 0.6 + shockBlue * 0.6, hf * 0.4 + shockBlue * 1.4);
    }

    // armour plates come away as it is broken down (the server throws each one off as junk)
    const gone = Math.min(this.plates.length, Math.floor((1 - p.hpK) / 0.12) + (p.overdrive ? 3 : 0));
    this.plates.forEach((pl, i) => { pl.visible = i >= gone; });

    this.updateLegs(p, floorY, dt, speed, dying || dormant);

    // world positions effects hang off
    this.body.updateMatrixWorld(true);
    this.head.localToWorld(this.eyeWorld.set(0, 0, 2.3));
    this.body.localToWorld(this.coreWorld.set(0, 2.05, -0.6));
    this.body.localToWorld(this.hiveWorld.set(0, 2.4, -3.2));
    this.barrels[0].localToWorld(this.muzzleWorld[0].set(0, 0.1, 3.0));
    this.barrels[1].localToWorld(this.muzzleWorld[1].set(0, 0.1, 3.0));
  }

  /** New random arcs over the hull. */
  private crackle() {
    const P = this.shockPos;
    let o = 0;
    for (let a = 0; a < 8; a++) {
      let x = (Math.random() - 0.5) * 6, y = 1.8 + Math.random() * 0.4, z = (Math.random() - 0.5) * 8;
      for (let s = 0; s < 6; s++) {
        const nx = x + (Math.random() - 0.5) * 1.4, ny = clamp(y + (Math.random() - 0.5) * 0.9, -1.5, 2.6), nz = z + (Math.random() - 0.5) * 1.4;
        P[o++] = x; P[o++] = y; P[o++] = z; P[o++] = nx; P[o++] = ny; P[o++] = nz;
        x = nx; y = ny; z = nz;
      }
    }
    (this.shock.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  /**
   * Feet stay planted until the body has moved on from them, then step, a
   * diagonal pair at a time, to where the body wants them (a little ahead of
   * where it is going). Two-bone IK finds each knee, bent up and out like a spider's.
   */
  private updateLegs(p: WardenPose, floorY: number, dt: number, speed: number, still: boolean) {
    const lift = p.lift;
    const splay = 1 + Math.max(0, BOSS.LIFT - lift) * 0.075;
    const charge = speed > 9;
    const trigger = charge ? 2.4 : 1.5;
    const lead = charge ? 0.22 : 0.4;
    for (let i = 0; i < 4; i++) {
      const l = this.legs[i];
      // where this foot would like to be
      this.toWorld(p.x, p.z, p.yaw, l.sx * 7.2 * splay, 0, l.sz * 6.0 * splay, floorY, _f);
      _f.x += this.vel.x * lead; _f.z += this.vel.z * lead;
      if (!this.seeded) { l.planted.copy(_f); }
      if (l.stepping) {
        l.stepT += dt;
        const u = clamp(l.stepT / l.stepDur, 0, 1), e = u * u * (3 - 2 * u);
        l.to.lerp(_f, damp(4, dt));
        l.planted.lerpVectors(l.from, l.to, e);
        l.planted.y = floorY + Math.sin(u * Math.PI) * (charge ? 1.6 : 1.2);
        if (u >= 1) {
          l.stepping = false;
          l.planted.y = floorY;
          this.onStep(l.planted, charge ? 1 : 0.55);
        }
      } else if (!still) {
        const dist = Math.hypot(_f.x - l.planted.x, _f.z - l.planted.z);
        const partner = this.legs[3 - i];
        const otherPairStepping = this.legs.some((o, j) => PAIR[j] !== PAIR[i] && o.stepping);
        if ((dist > trigger || (partner.stepping && dist > trigger * 0.4)) && !otherPairStepping) {
          l.stepping = true;
          l.stepT = 0;
          l.stepDur = clamp(0.5 - speed * 0.02, 0.17, 0.5);
          l.from.copy(l.planted);
          l.to.copy(_f);
        }
      }
    }
    this.seeded = true;
    // solve and place each leg (in the root's own frame)
    const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
    for (const l of this.legs) {
      // hip, in root space (the body is not rotated about x / z much: ignore it for the solve)
      _h.set(l.sx * 3.3, this.body.position.y - 0.6, l.sz * 3.0);
      const dx = l.planted.x - p.x, dz = l.planted.z - p.z;
      _f.set(dx * c - dz * s, l.planted.y - floorY + (l.sz > 0 ? this.stomp * 2.4 : 0), dx * s + dz * c);
      _u.subVectors(_f, _h);
      let d = _u.length();
      d = clamp(d, Math.abs(THIGH - SHIN) + 0.05, THIGH + SHIN - 0.05);
      _u.normalize();
      _f.copy(_h).addScaledVector(_u, d);
      _w.set(l.sx, 1.3, l.sz * 0.35).normalize();
      _w.addScaledVector(_u, -_w.dot(_u)).normalize();
      const a = (THIGH * THIGH - SHIN * SHIN + d * d) / (2 * d);
      const h = Math.sqrt(Math.max(0, THIGH * THIGH - a * a));
      _k.copy(_h).addScaledVector(_u, a).addScaledVector(_w, h);
      l.knee.copy(_k);
      // thigh from hip to knee, shin from foot up to knee (both built along +Y)
      l.thigh.position.copy(_h);
      l.thigh.quaternion.setFromUnitVectors(_up, _v.subVectors(_k, _h).normalize());
      l.shin.position.copy(_f);
      l.shin.quaternion.setFromUnitVectors(_up, _v.subVectors(_k, _f).normalize());
      l.foot.position.copy(_f);
      l.foot.rotation.set(0, Math.atan2(l.sx * 0.6, l.sz), 0);
    }
  }
}

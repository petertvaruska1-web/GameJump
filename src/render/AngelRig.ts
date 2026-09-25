// The angel's wings, sword and halo, worn by a runner (CharacterModel builds one
// when its runner chooses the angel).
//
// Each wing is a three-bone arm (shoulder, elbow, wrist) carrying about forty
// feathers, drawn as one instanced mesh: primaries fanning from the hand,
// secondaries along the forearm, tertials by the body, and two rows of coverts
// over the top. The feathers are laid out twice in the wing's own plane, folded
// and spread, and every frame the wing blends between the two (how open it is)
// while the shoulder turns the whole plane through the poses of a wingbeat:
// raised high, driven down and forward, swept back up half-folded. Closed, the
// wings stand behind the shoulders like a statue's and hang to the knees;
// spread, they are nearly four metres across. The tips flutter with the air,
// harder the faster it rushes past.
//
// The sword hangs in the right hand at a wrist angle each move sets (along the
// arm for a wide cut, forward like a lance in a dive); its tip and base are
// tracked in the world for the trail of light a slash leaves.

import * as THREE from 'three';
import { Anim } from '../../shared/physics/character';
import { clamp, damp, lerp } from '../../shared/math';

/** One feather: which bone it grows from and where along it, its angle in the wing plane spread and folded, its size. */
interface Feather { bone: number; t: number; open: number; closed: number; len: number; width: number; layer: number; lead: number; tint: number; flutter: number }

// the bones in the wing's plane (u: out along the span, v: toward the leading edge), spread and folded
const SIZE = 1.2;
const OPEN: [number, number][] = ([[0, 0], [0.34, 0.04], [0.84, 0.07], [1.24, 0.02]] as [number, number][]).map(([u, v]) => [u * SIZE, v * SIZE]);
const FOLD: [number, number][] = ([[0, 0], [0.42, 0.06], [-0.12, 0.16], [-0.52, 0.22]] as [number, number][]).map(([u, v]) => [u * SIZE, v * SIZE]);
/** Folded, the feathers slide under one another: they reach this share of their length. */
const FOLD_LEN = 0.52;

function layout(): Feather[] {
  const out: Feather[] = [];
  // primaries: from the hand, fanning from straight back at the wrist to straight out at the tip
  const plen = [0.62, 0.68, 0.74, 0.8, 0.86, 0.92, 0.97, 0.96, 0.88];
  for (let i = 0; i < 9; i++) {
    const k = i / 8;
    out.push({ bone: 2, t: 0.04 + k * 0.94, open: lerp(-1.63, -0.3, Math.pow(k, 0.85)), closed: -Math.PI + 0.08 + k * 0.2, len: plen[i] * SIZE, width: 0.22, layer: -0.004 * i, lead: 0, tint: 0.8 + k * 0.2, flutter: 0.6 + k * 0.6 });
  }
  // secondaries: along the forearm, straight back
  for (let i = 0; i < 8; i++) {
    const k = i / 7;
    out.push({ bone: 1, t: 1 - k * 0.96, open: -1.62 - k * 0.06, closed: -Math.PI + 0.25 + k * 0.08, len: (0.58 + Math.sin(k * Math.PI) * 0.04) * SIZE, width: 0.25, layer: 0.002 * i, lead: 0, tint: 0.55, flutter: 0.35 });
  }
  // tertials: by the body, back and a little in
  for (let i = 0; i < 4; i++) {
    const k = i / 3;
    out.push({ bone: 0, t: 0.92 - k * 0.8, open: -1.72 - k * 0.2, closed: -Math.PI + 0.45 + k * 0.05, len: (0.5 - k * 0.06) * SIZE, width: 0.23, layer: 0.01, lead: 0, tint: 0.45, flutter: 0.2 });
  }
  // greater coverts: a row of shorter feathers over the bases of the long ones
  for (let i = 0; i < 12; i++) {
    const k = i / 11, bone = k < 0.25 ? 0 : k < 0.66 ? 1 : 2, t = bone === 0 ? k / 0.25 : bone === 1 ? (k - 0.25) / 0.41 : (k - 0.66) / 0.34;
    out.push({ bone, t: clamp(t, 0.02, 0.98), open: -1.55 - (1 - k) * 0.12 + (bone === 2 ? k * 0.5 - 0.3 : 0), closed: -Math.PI + 0.2, len: (0.3 + (bone === 2 ? 0.04 : 0)) * SIZE, width: 0.2, layer: 0.022, lead: 0.02, tint: 0.2, flutter: 0.15 });
  }
  // lesser coverts: small feathers along the leading edge
  for (let i = 0; i < 10; i++) {
    const k = i / 9, bone = k < 0.3 ? 0 : k < 0.72 ? 1 : 2, t = bone === 0 ? k / 0.3 : bone === 1 ? (k - 0.3) / 0.42 : (k - 0.72) / 0.28;
    out.push({ bone, t: clamp(t, 0.02, 0.98), open: -1.42 + (bone === 2 ? 0.25 : 0), closed: -Math.PI + 0.2, len: 0.17 * SIZE, width: 0.16, layer: 0.036, lead: 0.05, tint: 0, flutter: 0.1 });
  }
  return out;
}
const FEATHERS = layout();

/** A feather: a curved vane along +X (narrow leading side toward +Z), shaded from ivory at the quill to gold at the tip. */
function featherGeometry(): THREE.BufferGeometry {
  const xs = [0, 0.08, 0.3, 0.6, 0.85, 1];
  const lead = [0.02, 0.18, 0.28, 0.3, 0.22, 0];
  const trail = [0.05, 0.45, 0.7, 0.72, 0.5, 0];
  const lift = [0, 0.02, 0.035, 0.03, 0.015, 0];
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const base = new THREE.Color(1, 1, 0.98), tip = new THREE.Color(1, 0.84, 0.52), c = new THREE.Color();
  for (let i = 0; i < xs.length; i++) {
    const y = lift[i];
    // leading edge, the shaft (a little proud of the vane), trailing edge
    pos.push(xs[i], y - lead[i] * 0.05, lead[i], xs[i], y + 0.012, 0, xs[i], y - trail[i] * 0.06, -trail[i]);
    c.copy(base).lerp(tip, Math.pow(xs[i], 1.6));
    const edge = c.clone().multiplyScalar(0.8);
    col.push(edge.r, edge.g, edge.b, c.r, c.g, c.b, edge.r, edge.g, edge.b);
  }
  for (let i = 0; i < xs.length - 1; i++) {
    const a = i * 3, b = (i + 1) * 3;
    idx.push(a, a + 1, b, b, a + 1, b + 1, a + 1, a + 2, b + 1, b + 1, a + 2, b + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

let featherGeo: THREE.BufferGeometry | null = null;

// the shoulder's poses: where the span and the leading edge point (left wing, in the torso's frame: +X out, +Y up, +Z forward)
function pose(span: [number, number, number], lead: [number, number, number]): THREE.Quaternion {
  const x = new THREE.Vector3(...span).normalize();
  const z = new THREE.Vector3(...lead);
  z.addScaledVector(x, -z.dot(x)).normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
const P = {
  /** Folded behind the shoulders, the wrist arching over them, the rest hanging down the back and flaring out behind. */
  closed: pose([0.1, 1, 0.22], [1, 0, 0.1]),
  /** Spread to glide: a shallow V, the top of the wing turned up and back (toward a camera behind). */
  glide: pose([1, 0.22, -0.1], [0, 0.2, 1]),
  /** The top of the upstroke. */
  raised: pose([0.4, 0.92, -0.12], [0, 0.05, 1]),
  /** The bottom of the downstroke: driven down and forward. */
  down: pose([0.74, -0.6, 0.3], [-0.1, 0.35, 1]),
  /** Half open, held up (rising, falling, hovering). */
  hold: pose([0.78, 0.5, -0.36], [0, 0.1, 1]),
  /** Swept back hard (a dive). */
  tuck: pose([0.3, 0.45, -1], [-0.8, 0.5, 0.3]),
  /** The bottom of a great beat (the soar): driven further down. */
  downBig: pose([0.6, -0.72, 0.28], [-0.1, 0.3, 1]),
};

export interface AngelInput {
  dt: number;
  t: number;
  anim: number;
  speed: number;
  vy: number;
  /** The power move playing on the arms, and how far into it (0..1). */
  act: string | null;
  actU: number;
}

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler(), _qf = new THREE.Quaternion();
const smooth = (a: number, b: number, x: number) => { const k = clamp((x - a) / (b - a), 0, 1); return k * k * (3 - 2 * k); };

export class AngelRig {
  /** The two wings' roots (hung on the torso), the sword (in the right hand) and the halo (on the head). */
  readonly wings = new THREE.Group();
  readonly sword = new THREE.Group();
  readonly halo = new THREE.Group();
  private readonly bases: THREE.Group[] = [];
  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly mats: THREE.Material[] = [];
  private readonly bladeGlow: THREE.MeshBasicMaterial;
  private readonly haloMat: THREE.MeshBasicMaterial;
  private readonly grip = new THREE.Group();
  /** The shoulder's turn and how open the wing is, eased toward each frame's target. */
  private readonly q = P.closed.clone();
  private spread = 0;
  /** A wingbeat playing: how far in (s), how long, how big. */
  private beatT = 9;
  private beatDur = 0.42;
  private beatBig = 1;
  private readonly beatFrom = new THREE.Quaternion();
  private wrist = 1.2;
  private glow = 0;
  private lastAnim = -1;
  /** The blade in the world this frame (for its trail of light), and how fast it is moving. */
  readonly bladeBase = new THREE.Vector3();
  readonly bladeTip = new THREE.Vector3();
  bladeSpeed = 0;
  private readonly lastTip = new THREE.Vector3();
  private seeded = false;

  constructor(hex: number, shadows: boolean) {
    featherGeo ??= featherGeometry();
    const col = new THREE.Color(hex);
    // luminous white, warmed by the power's colour, so the wings glow a little in the storm
    const featherMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.04, side: THREE.DoubleSide, emissive: new THREE.Color(0xfff6e6).lerp(col, 0.35), emissiveIntensity: 0.34 });
    this.mats.push(featherMat);
    for (const s of [1, -1]) {
      // the right wing is the left one seen in a mirror
      const mirror = new THREE.Group();
      mirror.scale.x = s;
      const base = new THREE.Group();
      base.position.set(0.1, 0.46, -0.25);
      mirror.add(base);
      const mesh = new THREE.InstancedMesh(featherGeo, featherMat, FEATHERS.length);
      mesh.castShadow = shadows;
      mesh.frustumCulled = false;
      const c = new THREE.Color();
      FEATHERS.forEach((f, i) => mesh.setColorAt(i, c.setRGB(1, 1 - f.tint * 0.05, 1 - f.tint * 0.12)));
      base.add(mesh);
      this.wings.add(mirror);
      this.bases.push(base);
      this.meshes.push(mesh);
    }

    // the sword: a blade of light-edged steel with a winged guard, held at the grip
    const steel = new THREE.MeshStandardMaterial({ color: 0xe4ebf5, metalness: 0.95, roughness: 0.16, emissive: new THREE.Color(0xfff0c8), emissiveIntensity: 0.28 });
    const gold = new THREE.MeshStandardMaterial({ color: 0xd9a441, metalness: 0.9, roughness: 0.3, emissive: new THREE.Color(0x3a2400), emissiveIntensity: 1 });
    const leather = new THREE.MeshStandardMaterial({ color: 0x3b2616, roughness: 0.85 });
    this.mats.push(steel, gold, leather);
    const blade = new THREE.CylinderGeometry(1, 1, 0.84, 4, 1);
    blade.translate(0, 0.1 + 0.42, 0);
    const tipG = new THREE.ConeGeometry(1, 0.24, 4, 1);
    tipG.translate(0, 0.1 + 0.84 + 0.12, 0);
    for (const g of [blade, tipG]) { g.scale(0.045, 1, 0.011); }
    const bladeMesh = new THREE.Mesh(blade, steel), tipMesh = new THREE.Mesh(tipG, steel);
    this.grip.add(bladeMesh, tipMesh);
    // the glow round the blade (brighter in a cut)
    this.bladeGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.35, 0.8), transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    this.mats.push(this.bladeGlow);
    const glowG = new THREE.CylinderGeometry(1, 0.35, 1.1, 6, 1);
    glowG.translate(0, 0.1 + 0.55, 0);
    glowG.scale(0.09, 1, 0.04);
    this.grip.add(new THREE.Mesh(glowG, this.bladeGlow));
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.035, 0.05), gold);
    guard.position.y = 0.08;
    this.grip.add(guard);
    for (const s of [-1, 1]) {
      const q = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.03, 0.04), gold);
      q.position.set(s * 0.14, 0.11, 0);
      q.rotation.z = s * 0.55;
      this.grip.add(q);
    }
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.026), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.7, 0.8), toneMapped: false }));
    gem.position.set(0, 0.08, 0.03);
    this.grip.add(gem);
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.024, 0.18, 8), leather);
    handle.position.y = -0.02;
    this.grip.add(handle);
    const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.034, 10, 8), gold);
    pommel.position.y = -0.12;
    this.grip.add(pommel);
    this.grip.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = shadows; });
    this.sword.add(this.grip);
    this.sword.position.set(0, -0.27, 0.01);

    // the halo
    this.haloMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.85, 1.05), toneMapped: false, transparent: true, opacity: 0.95 });
    this.mats.push(this.haloMat);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.012, 8, 40), this.haloMat);
    ring.rotation.x = Math.PI / 2;
    this.halo.add(ring);
    this.halo.position.set(0, 0.38, -0.05);
    this.halo.rotation.x = -0.28;
  }

  /** A wingbeat (k: how big; the soar's is a great one). */
  beat(k = 1) {
    this.beatFrom.copy(this.q);
    this.beatT = 0;
    this.beatBig = k;
    this.beatDur = k > 1.2 ? 0.62 : 0.42;
  }

  update(a: AngelInput) {
    const dt = a.dt, t = a.t;
    // a remote runner's beat shows as its animation turning to Beat
    if (a.anim === Anim.Beat && this.lastAnim !== Anim.Beat && this.beatT > 0.2) this.beat(1);
    this.lastAnim = a.anim;

    // ---------------------------------------------------------- where the wings want to be
    let target = P.closed, spread = 0, flutter = 0, rate = 7;
    const air = a.anim === Anim.Jump || a.anim === Anim.Fall || a.anim === Anim.Launch || a.anim === Anim.Flip || a.anim === Anim.Swing || a.anim === Anim.Zip;
    const runK = clamp(a.speed / 9, 0, 1);
    if (a.anim === Anim.Dead) { target = _q.copy(P.closed).slerp(P.down, 0.3); spread = 0.2; rate = 3; }
    else if (a.anim === Anim.Dive) { target = P.tuck; spread = 0.05; rate = 14; flutter = 0.5; }
    else if (a.anim === Anim.Glide) {
      // spread wide, flexing gently with the air
      target = _q.copy(P.glide).slerp(P.raised, 0.08 + Math.sin(t * 2.6) * 0.05);
      spread = 1; flutter = 0.7; rate = 6;
    } else if (air || a.anim === Anim.Beat) {
      // rising: held up half open; falling: raised to catch the air
      const fall = clamp(-a.vy / 12, 0, 1);
      target = _q.copy(P.hold).slerp(P.raised, fall * 0.45);
      spread = 0.55 + fall * 0.35; flutter = 0.4 + fall * 0.6; rate = 6;
    } else {
      // on the ground: folded, breathing, lifting a little and trailing back at a run
      target = _q.copy(P.closed).slerp(P.hold, 0.08 * runK + 0.02 + Math.sin(t * 1.9) * 0.015);
      spread = 0.06 * runK; flutter = 0.2 * runK; rate = 6;
    }
    // the sword's moves open the wings: a flare in each cut, spread wide in the spin
    if (a.act) {
      const w = Math.sin(clamp(a.actU, 0, 1) * Math.PI);
      if (a.act === 'sweep') { target = _q2.copy(target).slerp(P.glide, 0.85 * w); spread = Math.max(spread, 0.95 * w); rate = 12; }
      else if (a.act === 'rise' || a.act === 'reverse' || a.act === 'cleave') { target = _q2.copy(target).slerp(P.hold, 0.35 * w); spread = Math.max(spread, 0.4 * w); rate = 12; }
      else if (a.act === 'blast' || a.act === 'boom') { /* not the angel's */ }
    }

    // ---------------------------------------------------------- a wingbeat: up, a hard drive down, and back
    if (this.beatT < this.beatDur) {
      this.beatT += dt;
      const u = clamp(this.beatT / this.beatDur, 0, 1), big = this.beatBig;
      if (u < 0.22) {
        this.q.copy(this.beatFrom).slerp(P.raised, smooth(0, 0.22, u));
        this.spread = lerp(this.spread, 0.8, smooth(0, 0.22, u));
      } else if (u < 0.55) {
        // the power stroke: fully spread, driven down and forward
        const k = smooth(0.22, 0.55, u);
        this.q.copy(P.raised).slerp(big > 1.2 ? P.downBig : P.down, k);
        this.spread = 1;
      } else {
        const k = smooth(0.55, 1, u);
        this.q.copy(big > 1.2 ? P.downBig : P.down).slerp(target, k);
        this.spread = lerp(0.7, spread, k);
      }
      flutter = Math.max(flutter, 0.6);
    } else {
      this.q.slerp(target, damp(rate, dt));
      this.spread += (spread - this.spread) * damp(rate, dt);
    }

    // ---------------------------------------------------------- the feathers, from the bones
    const sp = clamp(this.spread, 0, 1);
    const bones: [number, number][] = OPEN.map((o, i) => [lerp(FOLD[i][0], o[0], sp), lerp(FOLD[i][1], o[1], sp)]);
    const lenK = lerp(FOLD_LEN, 1, sp);
    const air2 = flutter * (0.5 + clamp((Math.abs(a.vy) + a.speed) / 20, 0, 1));
    for (let w = 0; w < 2; w++) {
      const base = this.bases[w], mesh = this.meshes[w];
      base.quaternion.copy(this.q);
      for (let i = 0; i < FEATHERS.length; i++) {
        const f = FEATHERS[i];
        const b0 = bones[f.bone], b1 = bones[f.bone + 1];
        const bu = b1[0] - b0[0], bv = b1[1] - b0[1], bl = Math.hypot(bu, bv) || 1;
        // on the bone, nudged toward the leading edge for the coverts
        const u = b0[0] + bu * f.t - (bv / bl) * f.lead, v = b0[1] + bv * f.t + (bu / bl) * f.lead;
        const ang = lerp(f.closed, f.open, sp);
        const flick = Math.sin(t * (17 + i * 0.7) + i * 1.9 + w * 2.3) * 0.12 * f.flutter * air2;
        _e.set(flick, -ang, (Math.sin(t * 11 + i) * 0.05 * f.flutter * air2), 'YXZ');
        _qf.setFromEuler(_e);
        _p.set(u, f.layer * (0.4 + sp * 0.6) + (i % 2) * 0.004, v);
        _s.set(f.len * lenK, 1, f.width);
        mesh.setMatrixAt(i, _m.compose(_p, _qf, _s));
      }
      mesh.instanceMatrix.needsUpdate = true;
    }

    // ---------------------------------------------------------- the sword and the halo
    let wrist = 1.15, glow = 0.25;
    if (a.act === 'rise' || a.act === 'reverse' || a.act === 'sweep') { wrist = 0.45; glow = 1; }
    else if (a.act === 'cleave') { wrist = lerp(1.0, 0.35, smooth(0.25, 0.55, a.actU)); glow = 1; }
    else if (a.anim === Anim.Dive) { wrist = 0.15; glow = 0.8; }
    else if (a.anim === Anim.Lunge) { wrist = 0.5; glow = 0.8; }
    this.wrist += (wrist - this.wrist) * damp(a.act ? 26 : 10, dt);
    this.grip.rotation.x = Math.PI - this.wrist;
    this.glow += (glow - this.glow) * damp(glow > this.glow ? 30 : 5, dt);
    this.bladeGlow.opacity = 0.18 + this.glow * 0.55 + Math.sin(t * 13) * 0.03;
    this.haloMat.opacity = 0.85 + Math.sin(t * 2.2) * 0.1;
    this.halo.position.y = 0.38 + Math.sin(t * 1.7) * 0.012;

    // the blade in the world, for the trail
    this.grip.updateWorldMatrix(true, false);
    this.bladeBase.set(0, 0.16, 0).applyMatrix4(this.grip.matrixWorld);
    this.bladeTip.set(0, 1.18, 0).applyMatrix4(this.grip.matrixWorld);
    this.bladeSpeed = this.seeded && dt > 0 ? this.bladeTip.distanceTo(this.lastTip) / dt : 0;
    this.lastTip.copy(this.bladeTip);
    this.seeded = true;
  }

  dispose() {
    for (const m of this.mats) m.dispose();
    this.grip.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
    this.halo.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
    for (const m of this.meshes) m.dispose();
  }
}

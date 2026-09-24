// The Warden's arena on screen: the Anvil, the storm around it, and the things
// the course's own views cannot draw. What the arena's level data describes
// (the rampart, ramps, perches, pads, rails, cables, anchors, the arena's
// beacon) is drawn by the same LevelView / PropsView / HazardView the course
// uses, so it reads as part of the same world. On top of that:
//
//  - the Anvil: a round floor of riveted hex plate with a forge sigil, seams
//    that glow with the Warden's heat, a hazard-striped lip, and the great
//    inverted cone of machinery it stands on, vents glowing down its sides;
//  - four conductor pillars wound with coils that crackle, arcing to the crown;
//  - the crown: a halo hung over the arena by cables from the rampart, with the
//    grapple anchors on chains below its inner ring;
//  - the storm: wrecks and towers drifting in the murk all round, supports
//    plunging into the clouds, embers and ash rising through the air.
//
// Everything is in the same scene as the course and simply hidden while the
// team is on the course (and the course is hidden while they are here).

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ARENA } from '../../shared/constants';
import { ANVIL, polar, type ArenaData } from '../../shared/level/arena';
import { rng } from '../../shared/math';
import { CollisionWorld } from '../../shared/physics/world';
import { HazardView } from './HazardView';
import { LevelView } from './LevelView';
import type { Materials } from './Materials';
import { PortalView } from './PortalView';
import { PropsView } from './Props';

const X = ARENA.x, Y = ARENA.y, Z = ARENA.z;
const PI = Math.PI;

/** The Anvil's floor: riveted hex plate, rings, a forge sigil and hazard stripes round the lip. */
function floorTextures(): { map: THREE.CanvasTexture; glow: THREE.CanvasTexture } {
  const S = 2048;
  const c = document.createElement('canvas'), g = document.createElement('canvas');
  c.width = c.height = g.width = g.height = S;
  const ctx = c.getContext('2d')!, gl = g.getContext('2d')!;
  const m = S / 2, R = S / 2;
  const r = rng(909);
  ctx.fillStyle = '#4b525c'; ctx.fillRect(0, 0, S, S);
  gl.fillStyle = '#000'; gl.fillRect(0, 0, S, S);
  // hex plates, each a slightly different shade, with dark seams and rivets at the corners
  const hr = 64, hw = Math.sqrt(3) * hr;
  for (let row = -1; row * hr * 1.5 < S + hr; row++) {
    for (let col = -1; col * hw < S + hw; col++) {
      const cx = col * hw + (row % 2 ? hw / 2 : 0), cy = row * hr * 1.5;
      const shade = 70 + Math.floor(r() * 26);
      ctx.fillStyle = `rgb(${shade},${shade + 4},${shade + 10})`;
      ctx.beginPath();
      for (let k = 0; k < 6; k++) { const a = PI / 6 + (k * PI) / 3; ctx.lineTo(cx + Math.cos(a) * (hr - 3), cy + Math.sin(a) * (hr - 3)); }
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(18,20,26,0.9)'; ctx.lineWidth = 5; ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = 'rgba(190,196,205,0.35)';
      for (let k = 0; k < 6; k++) { const a = PI / 6 + (k * PI) / 3; ctx.beginPath(); ctx.arc(cx + Math.cos(a) * (hr - 14), cy + Math.sin(a) * (hr - 14), 3.5, 0, PI * 2); ctx.fill(); }
      // wear: scuffs toward the middle where the Warden walks
      if (r() < 0.35) { ctx.fillStyle = `rgba(20,18,16,${0.08 + r() * 0.14})`; ctx.beginPath(); ctx.arc(cx + (r() - 0.5) * 40, cy + (r() - 0.5) * 40, 10 + r() * 30, 0, PI * 2); ctx.fill(); }
    }
  }
  // scorch where its feet and its beam have burned the plate
  for (let i = 0; i < 40; i++) {
    const a = r() * PI * 2, d = r() * R * 0.8, x = m + Math.cos(a) * d, y = m + Math.sin(a) * d, rad = 30 + r() * 120;
    const gr = ctx.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, 'rgba(10,8,6,0.35)'); gr.addColorStop(1, 'rgba(10,8,6,0)');
    ctx.fillStyle = gr; ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  // concentric rings: channels in the plate, the inner ones glowing with the forge's heat
  const ring = (f: number, w: number, col: string, glow = 0) => {
    ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath(); ctx.arc(m, m, f * R, 0, PI * 2); ctx.stroke();
    if (glow) { gl.strokeStyle = `rgba(255,${120 + glow * 60},40,${glow})`; gl.lineWidth = w * 0.6; gl.beginPath(); gl.arc(m, m, f * R, 0, PI * 2); gl.stroke(); }
  };
  ring(0.13, 18, '#23262d', 0.9); ring(0.16, 6, '#2a2e36', 0.5);
  ring(0.36, 14, '#23262d', 0.55); ring(0.62, 12, '#262a31', 0.35); ring(0.86, 10, '#262a31', 0.2);
  // radial channels between them, like the spokes of a forge sigil
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * PI * 2, r0 = (i % 2 ? 0.36 : 0.16) * R, r1 = (i % 2 ? 0.62 : 0.86) * R;
    ctx.strokeStyle = '#23262d'; ctx.lineWidth = i % 2 ? 8 : 12;
    ctx.beginPath(); ctx.moveTo(m + Math.cos(a) * r0, m + Math.sin(a) * r0); ctx.lineTo(m + Math.cos(a) * r1, m + Math.sin(a) * r1); ctx.stroke();
    gl.strokeStyle = `rgba(255,150,50,${i % 2 ? 0.25 : 0.5})`; gl.lineWidth = i % 2 ? 4 : 6;
    gl.beginPath(); gl.moveTo(m + Math.cos(a) * r0, m + Math.sin(a) * r0); gl.lineTo(m + Math.cos(a) * r1, m + Math.sin(a) * r1); gl.stroke();
  }
  // the hub: a heavy plate with a glyph of the beacon, where the Warden sleeps
  ctx.fillStyle = '#353a42'; ctx.beginPath(); ctx.arc(m, m, 0.12 * R, 0, PI * 2); ctx.fill();
  gl.fillStyle = 'rgba(255,110,30,0.55)';
  for (let k = 0; k < 3; k++) { gl.beginPath(); gl.arc(m, m, (0.03 + k * 0.03) * R, 0, PI * 2); gl.lineWidth = 5; gl.strokeStyle = 'rgba(255,120,40,0.7)'; gl.stroke(); }
  // hazard stripes round the lip, and the warning band inside them
  const lip = 0.955 * R, lw = 0.045 * R;
  for (let i = 0; i < 120; i++) {
    const a0 = (i / 120) * PI * 2, a1 = ((i + 0.5) / 120) * PI * 2;
    ctx.fillStyle = '#e0ad2c';
    ctx.beginPath(); ctx.arc(m, m, lip + lw / 2, a0, a1); ctx.arc(m, m, lip - lw / 2, a1, a0, true); ctx.closePath(); ctx.fill();
  }
  ctx.strokeStyle = '#17191e'; ctx.lineWidth = 6; ctx.beginPath(); ctx.arc(m, m, lip - lw / 2 - 4, 0, PI * 2); ctx.stroke();
  gl.strokeStyle = 'rgba(255,60,40,0.45)'; gl.lineWidth = 5; gl.beginPath(); gl.arc(m, m, lip - lw / 2 - 12, 0, PI * 2); gl.stroke();
  const map = new THREE.CanvasTexture(c), glow = new THREE.CanvasTexture(g);
  for (const t of [map, glow]) { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; }
  return { map, glow };
}

/** A coil conductor: a plinth, an octagonal shaft wound with glowing coils, an electrode crown. */
function pillarGeometry(): { body: THREE.BufferGeometry; trim: THREE.BufferGeometry; coils: THREE.BufferGeometry } {
  const H = ANVIL.PILLAR_H, n = (g: THREE.BufferGeometry) => (g.index ? g.toNonIndexed() : g);
  const body: THREE.BufferGeometry[] = [], trim: THREE.BufferGeometry[] = [], coils: THREE.BufferGeometry[] = [];
  const plinth = new THREE.CylinderGeometry(2.9, 3.2, 1.2, 8); plinth.rotateY(PI / 8); plinth.translate(0, 0.6, 0); trim.push(n(plinth));
  const shaft = new THREE.CylinderGeometry(2.05, 2.15, H - 2.2, 8, 1); shaft.rotateY(PI / 8); shaft.translate(0, 1.2 + (H - 2.2) / 2, 0); body.push(n(shaft));
  // vertical ribs between the coils
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * PI * 2;
    const rib = new THREE.BoxGeometry(0.28, H - 2.4, 0.3); rib.translate(Math.sin(a) * 2.12, 1.2 + (H - 2.4) / 2, Math.cos(a) * 2.12); rib.rotateY(0);
    trim.push(n(rib));
  }
  for (let i = 0; i < 6; i++) {
    const t = new THREE.TorusGeometry(2.32, 0.16, 6, 24); t.rotateX(PI / 2); t.translate(0, 2.4 + i * 1.65, 0); coils.push(n(t));
  }
  const cap = new THREE.CylinderGeometry(2.5, 2.2, 1.0, 8); cap.rotateY(PI / 8); cap.translate(0, H - 0.5, 0); trim.push(n(cap));
  // four electrode horns round the top, where the arcs leap from
  for (let k = 0; k < 4; k++) {
    const a = PI / 4 + (k * PI) / 2;
    const horn = new THREE.CylinderGeometry(0.08, 0.22, 2.2, 6); horn.rotateZ(-0.35); horn.rotateY(a + PI / 2); horn.translate(Math.sin(a) * 1.8, H + 1.0, Math.cos(a) * 1.8);
    trim.push(n(horn));
    const ball = new THREE.IcosahedronGeometry(0.28, 1); ball.translate(Math.sin(a) * 2.2, H + 2.05, Math.cos(a) * 2.2); coils.push(n(ball));
  }
  const strip = (arr: THREE.BufferGeometry[]) => arr.map((g) => { for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k); return g; });
  return { body: mergeGeometries(strip(body))!, trim: mergeGeometries(strip(trim))!, coils: mergeGeometries(strip(coils))! };
}

export class ArenaView {
  readonly group = new THREE.Group();
  /** A client copy of the arena's collision world (the Warden's hull rides in it as a puppet). */
  readonly world: CollisionWorld;
  readonly levelView: LevelView;
  readonly props: PropsView;
  readonly hazards: HazardView;
  /** The door the team arrives through and comes back through, at the arena's beacon. */
  readonly door: PortalView;
  private readonly seamMat: THREE.MeshStandardMaterial;
  private readonly coilMat: THREE.MeshBasicMaterial;
  private readonly ventMat: THREE.MeshBasicMaterial;
  private readonly emberMat: THREE.ShaderMaterial;
  private readonly arcs: THREE.LineSegments;
  private readonly arcPos: Float32Array;
  private readonly arcMat: THREE.LineBasicMaterial;
  private arcT = 0;
  private arcLife = 0;
  private readonly tops: THREE.Vector3[] = [];
  private readonly crownPts: THREE.Vector3[] = [];
  /** 0..1: how hot the forge runs (the Warden awake, in overdrive). */
  heat = 0.35;
  /** A flash from a conductor arc this frame (for sound). */
  arcStruck: THREE.Vector3 | null = null;
  private readonly r = rng(515);

  constructor(readonly arena: ArenaData, mats: Materials, glowTex: THREE.Texture, shadows: boolean) {
    this.group.visible = false;
    this.world = new CollisionWorld(arena.level);
    this.levelView = new LevelView(arena.level, mats, shadows);
    this.props = new PropsView(arena.level, mats, shadows);
    this.hazards = new HazardView(arena.level, mats);
    this.group.add(this.levelView.group, this.props.group, this.hazards.group);

    const steel = new THREE.MeshStandardMaterial({ color: 0x3a414b, roughness: 0.5, metalness: 0.7 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1e2229, roughness: 0.65, metalness: 0.55 });
    const hazard = mats.get('hazard');
    this.seamMat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.55 });
    this.coilMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.35, 1.6, 2.4), toneMapped: false });
    this.ventMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 0.8, 0.2), toneMapped: false });

    // ------------------------------------------------------------ the Anvil
    const tex = floorTextures();
    this.seamMat.map = tex.map;
    this.seamMat.emissiveMap = tex.glow;
    this.seamMat.emissive = new THREE.Color(1, 1, 1);
    this.seamMat.emissiveIntensity = 1.2;
    const floor = new THREE.Mesh(new THREE.CircleGeometry(ANVIL.FLOOR_R + 0.6, 96), this.seamMat);
    floor.rotation.x = -PI / 2;
    floor.position.set(X, Y + 0.004, Z);
    floor.receiveShadow = shadows;
    this.group.add(floor);
    // the lip, and the machinery the floor sits on: an inverted cone with glowing vents
    const lip = new THREE.Mesh(new THREE.CylinderGeometry(ANVIL.FLOOR_R + 0.62, ANVIL.FLOOR_R + 0.2, 2.4, 96, 1, true), hazard);
    lip.position.set(X, Y - 1.2, Z);
    this.group.add(lip);
    const under = new THREE.Mesh(new THREE.CylinderGeometry(ANVIL.FLOOR_R + 0.2, 5, 34, 32, 4, true), dark);
    under.position.set(X, Y - 2.4 - 17, Z);
    this.group.add(under);
    const ribs: THREE.BufferGeometry[] = [], vents: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * PI * 2;
      // a rib down the cone
      const rib = new THREE.BoxGeometry(0.9, 36, 1.3);
      rib.translate(0, -18, 0);
      rib.rotateX(0.62);
      rib.rotateY(a);
      rib.translate(X + Math.sin(a) * (ANVIL.FLOOR_R - 0.5), Y - 2, Z + Math.cos(a) * (ANVIL.FLOOR_R - 0.5));
      ribs.push(rib.toNonIndexed());
      if (k % 2 === 0) {
        for (const d of [8, 16]) {
          const v = new THREE.BoxGeometry(2.2, 0.5, 0.2);
          const rr = ANVIL.FLOOR_R - d * 0.72 - 0.2;
          v.rotateX(0.62); v.rotateY(a);
          v.translate(X + Math.sin(a + 0.1) * rr, Y - 2.4 - d, Z + Math.cos(a + 0.1) * rr);
          vents.push(v.toNonIndexed());
        }
      }
    }
    this.group.add(new THREE.Mesh(mergeGeometries(ribs)!, steel), new THREE.Mesh(mergeGeometries(vents)!, this.ventMat));

    // ------------------------------------------------------------ conductor pillars
    const pg = pillarGeometry();
    for (const [i, phi] of ANVIL.PILLARS.entries()) {
      const p = polar(phi, ANVIL.PILLAR_R);
      const body = new THREE.Mesh(pg.body, dark), trim = new THREE.Mesh(pg.trim, steel), coil = new THREE.Mesh(pg.coils, this.coilMat);
      for (const m of [body, trim, coil]) { m.position.set(p[0], Y, p[2]); m.rotation.y = phi + i * 0.3; m.castShadow = shadows && m !== coil; m.receiveShadow = shadows; this.group.add(m); }
      this.tops.push(new THREE.Vector3(p[0], Y + ANVIL.PILLAR_H + 2.1, p[2]));
    }

    // ------------------------------------------------------------ the crown
    const crownY = Y + 23.5;
    const halo = new THREE.Mesh(new THREE.TorusGeometry(24, 0.75, 10, 128), steel);
    halo.rotation.x = PI / 2; halo.position.set(X, crownY, Z);
    const haloLight = new THREE.Mesh(new THREE.TorusGeometry(24, 0.2, 6, 128), this.coilMat);
    haloLight.rotation.x = PI / 2; haloLight.position.set(X, crownY - 0.7, Z);
    const inner = new THREE.Mesh(new THREE.TorusGeometry(11, 0.45, 8, 72), steel);
    inner.rotation.x = PI / 2; inner.position.set(X, crownY - 1.5, Z);
    this.group.add(halo, haloLight, inner);
    const bits: THREE.BufferGeometry[] = [], chains: THREE.BufferGeometry[] = [];
    const beamBetween = (a: THREE.Vector3, b: THREE.Vector3, w: number, out: THREE.BufferGeometry[]) => {
      const d = b.clone().sub(a), l = d.length();
      const g = new THREE.BoxGeometry(w, w, l);
      g.lookAt(d);
      g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
      out.push(g.toNonIndexed());
    };
    for (let k = 0; k < 8; k++) {
      const a = PI / 8 + (k * PI) / 4;
      // spokes from the halo to the inner ring
      beamBetween(new THREE.Vector3(X + Math.sin(a) * 24, crownY, Z + Math.cos(a) * 24), new THREE.Vector3(X + Math.sin(a) * 11, crownY - 1.5, Z + Math.cos(a) * 11), 0.5, bits);
      // cables from the rampart's edge up to the halo: the whole arena hangs in the sky
      beamBetween(new THREE.Vector3(X + Math.sin(a) * (ANVIL.RAMPART_OUT - 0.5), Y + ANVIL.RAMPART_Y, Z + Math.cos(a) * (ANVIL.RAMPART_OUT - 0.5)), new THREE.Vector3(X + Math.sin(a) * 24.5, crownY + 0.3, Z + Math.cos(a) * 24.5), 0.14, chains);
      this.crownPts.push(new THREE.Vector3(X + Math.sin(a) * 24, crownY - 0.8, Z + Math.cos(a) * 24));
    }
    // chains down to the anchors under the inner ring
    for (const g of arena.level.grapples) {
      const d = Math.hypot(g.p[0] - X, g.p[2] - Z);
      if (d > 15) continue;
      const top = new THREE.Vector3(g.p[0], crownY - 1.5, g.p[2]);
      const links = 14;
      for (let i = 0; i < links; i++) {
        const y = g.p[1] + 0.45 + ((top.y - g.p[1] - 0.45) * i) / links;
        const link = new THREE.TorusGeometry(0.16, 0.045, 4, 8);
        if (i % 2) link.rotateY(PI / 2);
        link.scale(1, 1.6, 1);
        link.translate(g.p[0], y, g.p[2]);
        chains.push(link.toNonIndexed());
      }
    }
    const strip = (arr: THREE.BufferGeometry[]) => arr.map((g) => { for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k); return g; });
    this.group.add(new THREE.Mesh(mergeGeometries(strip(bits))!, steel), new THREE.Mesh(mergeGeometries(strip(chains))!, dark));

    // ------------------------------------------------------------ what holds the rampart up, and the perches
    const legs: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * PI * 2 + 0.1;
      const r0 = (ANVIL.RAMPART_IN + ANVIL.RAMPART_OUT) / 2;
      const col = new THREE.BoxGeometry(2.2, 140, 2.2);
      col.translate(X + Math.sin(a) * r0, Y + ANVIL.RAMPART_Y - 1.2 - 70, Z + Math.cos(a) * r0);
      legs.push(col.toNonIndexed());
      // a brace from each column in under the floor's cone
      beamBetween(new THREE.Vector3(X + Math.sin(a) * r0, Y - 14, Z + Math.cos(a) * r0), new THREE.Vector3(X + Math.sin(a) * 14, Y - 22, Z + Math.cos(a) * 14), 0.8, legs);
    }
    for (const phi of ANVIL.PERCHES) {
      // two struts from each perch down to the rampart's outer edge
      for (const s of [-1, 1]) {
        const top = polar(phi + s * 0.05, ANVIL.PERCH_R + 1.5, ANVIL.PERCH_Y - 0.9);
        const foot = polar(phi + s * 0.1, ANVIL.RAMPART_OUT - 0.6, ANVIL.RAMPART_Y);
        beamBetween(new THREE.Vector3(...top), new THREE.Vector3(...foot), 0.35, legs);
      }
    }
    const legMesh = new THREE.Mesh(mergeGeometries(strip(legs))!, dark);
    legMesh.castShadow = false;
    this.group.add(legMesh);

    // ------------------------------------------------------------ the storm: wrecks and towers in the murk
    const far: THREE.BufferGeometry[] = [];
    const lights: THREE.Vector3[] = [];
    for (let i = 0; i < 26; i++) {
      const a = this.r() * PI * 2, d = 170 + this.r() * 420;
      const x = X + Math.sin(a) * d, z = Z + Math.cos(a) * d;
      if (i < 14) {
        // a floating broken chunk of some other structure, drifting in the storm
        const g = new THREE.IcosahedronGeometry(8 + this.r() * 22, 0);
        const pos = g.getAttribute('position') as THREE.BufferAttribute;
        for (let v = 0; v < pos.count; v++) pos.setXYZ(v, pos.getX(v) * (0.8 + this.r() * 0.6), pos.getY(v) * (0.5 + this.r() * 0.9), pos.getZ(v) * (0.8 + this.r() * 0.6));
        g.translate(x, Y - 30 + this.r() * 90, z);
        far.push(g.toNonIndexed());
      } else {
        const h = 120 + this.r() * 180, w = 10 + this.r() * 24;
        const g = new THREE.BoxGeometry(w, h, w * (0.6 + this.r() * 0.7));
        g.translate(x, Y - 110 + h / 2, z);
        far.push(g.toNonIndexed());
        lights.push(new THREE.Vector3(x, Y - 110 + h + 2, z));
      }
    }
    const farMesh = new THREE.Mesh(mergeGeometries(strip(far))!, new THREE.MeshLambertMaterial({ color: 0x2a2f3c }));
    farMesh.geometry.computeVertexNormals();
    this.group.add(farMesh);
    for (const p of lights) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xff3a2a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
      s.position.copy(p); s.scale.setScalar(10);
      this.group.add(s);
    }

    // ------------------------------------------------------------ embers and ash rising through the air
    const N = 520;
    const seeds = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) {
      const a = this.r() * PI * 2, d = Math.sqrt(this.r()) * 60;
      seeds[i * 4] = Math.sin(a) * d; seeds[i * 4 + 1] = Math.cos(a) * d; seeds[i * 4 + 2] = this.r(); seeds[i * 4 + 3] = 0.3 + this.r();
    }
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    eg.setAttribute('seed', new THREE.BufferAttribute(seeds, 4));
    this.emberMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uScale: { value: window.innerHeight / 2 }, uHeat: { value: 0.3 }, uOrigin: { value: new THREE.Vector3(X, Y - 6, Z) } },
      vertexShader: `attribute vec4 seed; uniform float uTime, uScale, uHeat; uniform vec3 uOrigin; varying float vA; varying float vHot;
        void main(){
          float u = fract(uTime * 0.03 * seed.w + seed.z);
          vec3 p = uOrigin + vec3(seed.x + sin(uTime * 0.4 + seed.z * 30.0) * 2.0 + u * 8.0, u * 42.0, seed.y + cos(uTime * 0.33 + seed.z * 17.0) * 2.0);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vHot = step(0.55, fract(seed.z * 7.13));
          vA = smoothstep(0.0, 0.1, u) * smoothstep(1.0, 0.6, u) * (0.55 + 0.45 * sin(uTime * 3.0 + seed.z * 50.0)) * (vHot > 0.5 ? 0.4 + uHeat : 0.5);
          gl_PointSize = (vHot > 0.5 ? 0.09 : 0.14) * uScale / max(0.1, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `varying float vA; varying float vHot; void main(){ vec2 d = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.0, length(d)); vec3 c = vHot > 0.5 ? vec3(1.0, 0.5, 0.15) * 1.6 : vec3(0.55, 0.55, 0.6); gl_FragColor = vec4(c, a * vA); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    window.addEventListener('resize', () => { this.emberMat.uniforms.uScale.value = window.innerHeight / 2; });
    const embers = new THREE.Points(eg, this.emberMat);
    embers.frustumCulled = false;
    embers.renderOrder = 7;
    this.group.add(embers);

    // ------------------------------------------------------------ arcs of lightning between the conductors and the crown
    this.arcPos = new Float32Array(2 * 3 * 64 * 3);
    const ag = new THREE.BufferGeometry();
    ag.setAttribute('position', new THREE.BufferAttribute(this.arcPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.arcMat = new THREE.LineBasicMaterial({ color: new THREE.Color(1.2, 2.2, 3.0), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false });
    this.arcs = new THREE.LineSegments(ag, this.arcMat);
    this.arcs.frustumCulled = false;
    this.arcs.renderOrder = 9;
    this.group.add(this.arcs);

    // ------------------------------------------------------------ the door at the arena's beacon
    // the arena's beacon: the door, with a column of light over it that marks it from anywhere in the arena
    this.door = new PortalView(glowTex, { beam: true, palette: 'storm', oneSided: true });
    this.door.place([arena.beacon[0], arena.beacon[1], arena.beacon[2] - 1.4], 0, -Infinity);
    this.group.add(this.door.group);
  }

  /** Draws a jagged arc from a to b into the arc buffer, starting at segment `seg`. Returns the next free segment. */
  private jag(a: THREE.Vector3, b: THREE.Vector3, seg: number, n = 10): number {
    const P = this.arcPos;
    let px = a.x, py = a.y, pz = a.z;
    for (let i = 1; i <= n && seg < 128; i++) {
      const u = i / n, j = i === n ? 0 : Math.sin(u * PI) * 1.4;
      const x = a.x + (b.x - a.x) * u + (this.r() - 0.5) * j, y = a.y + (b.y - a.y) * u + (this.r() - 0.5) * j, z = a.z + (b.z - a.z) * u + (this.r() - 0.5) * j;
      P.set([px, py, pz, x, y, z], seg * 6);
      px = x; py = y; pz = z; seg++;
    }
    return seg;
  }

  update(t: number, dt: number, camPos: THREE.Vector3, mt: number) {
    this.levelView.update(this.world, mt, dt);
    this.hazards.update(mt);
    this.props.update(t, dt);
    this.door.update(t, dt, 1e9, camPos);
    // seen from behind (the camera backed up past it), the door is not drawn at all
    const dp = this.door.group.position;
    if (camPos.z < dp.z + 0.6 && Math.abs(camPos.x - dp.x) < 9) this.door.group.visible = false;
    this.emberMat.uniforms.uTime.value = t;
    this.emberMat.uniforms.uHeat.value = this.heat;
    // the forge breathes: seams and vents glow with the Warden's heat
    const breathe = 0.85 + Math.sin(t * 1.3) * 0.15;
    this.seamMat.emissiveIntensity = (0.55 + this.heat * 1.3) * breathe;
    this.ventMat.color.setRGB((1.4 + this.heat * 1.8) * breathe, (0.45 + this.heat * 0.5) * breathe, 0.15);
    const c = 0.8 + Math.sin(t * 7) * 0.12 + (Math.random() < 0.04 ? 0.8 : 0);
    this.coilMat.color.setRGB(0.3 * c, 1.4 * c, 2.2 * c);
    // now and then a conductor arcs to the crown (or to its neighbour)
    this.arcStruck = null;
    this.arcT -= dt;
    this.arcLife -= dt;
    if (this.arcT <= 0) {
      this.arcT = 0.6 + Math.random() * 2.2;
      this.arcLife = 0.16 + Math.random() * 0.12;
      this.arcPos.fill(0);
      const i = Math.floor(Math.random() * this.tops.length);
      const a = this.tops[i];
      let seg = 0;
      const b = Math.random() < 0.7 ? this.crownPts[(i * 2 + Math.floor(Math.random() * 3)) % this.crownPts.length] : this.tops[(i + 1) % this.tops.length];
      seg = this.jag(a, b, seg, 14);
      seg = this.jag(a, b, seg, 9);
      this.jag(a.clone().add(new THREE.Vector3(0, -2, 0)), a.clone().add(new THREE.Vector3((Math.random() - 0.5) * 4, -7, (Math.random() - 0.5) * 4)), seg, 6);
      (this.arcs.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      this.arcStruck = a;
    }
    this.arcs.visible = this.arcLife > 0;
    this.arcMat.opacity = Math.max(0, this.arcLife * 6) * (0.6 + Math.random() * 0.4);
  }
}

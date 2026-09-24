// The portal: an upright oval of gold and white light standing on the course,
// with a swirling opening, sparks spiralling into it, golden shards orbiting the
// rim, a glow on the ground and a column of light rising into the sky so it can
// be seen (and followed) from anywhere on the course. Everything that moves is
// animated in shaders from a time uniform: the whole portal is a handful of
// draw calls and costs nothing on the CPU.
//
// The same view stands in the white room as the doorway you arrive through,
// and (in storm colours) as the gate the beacon opens into the Warden's arena.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PORTAL } from '../../shared/constants';

/** How tall the oval is compared with its width. */
const OVAL = 1.28;
const SPARKS = 160;
const SHARDS = 14;

/**
 * Colours: the portal's gold and cream, or the storm's electric blue for the gate
 * the beacon opens (A: the vortex's deep bands, B: its light, C: the edge tint;
 * frame and rim follow).
 */
const PALETTES = {
  gold: { a: [0.93, 0.58, 0.2], b: [1.0, 0.93, 0.76], c: [0.62, 0.8, 1.0], frame: 0xe8b64c, frameGlow: 0x7a4c08, rim: [1.5, 1.08, 0.42], glow: 0xffc766, flare: 0xfff2d8 },
  storm: { a: [0.12, 0.42, 1.0], b: [0.7, 0.95, 1.0], c: [0.75, 0.55, 1.0], frame: 0x8fa8c8, frameGlow: 0x0d3a70, rim: [0.45, 1.3, 2.2], glow: 0x5fd0ff, flare: 0xe2f8ff },
};
export type PortalPalette = keyof typeof PALETTES;

const discVertex = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const discFragment = /* glsl */ `
  uniform float uTime, uOpen, uFlare;
  uniform vec3 uPalA, uPalB, uPalC;
  varying vec2 vUv;
  float hash(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
  float noise(vec2 p){ vec2 i=floor(p); vec2 f=fract(p); vec2 u=f*f*(3.0-2.0*f);
    return mix(mix(hash(i),hash(i+vec2(1,0)),u.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x), u.y); }
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;
    float a = atan(p.y, p.x);
    // a vortex: bands wound tighter toward the centre, turning slowly inward
    float swirl = a * 3.0 + log(r + 0.03) * 6.0 + uTime * 1.5;
    float bands = 0.5 + 0.5 * sin(swirl);
    float fine = 0.5 + 0.5 * sin(swirl * 3.0 - uTime * 0.7);
    float n = noise(vec2(swirl * 0.9, r * 7.0 - uTime * 1.3));
    // rings of light rushing inward, toward the heart of it
    float rush = pow(0.5 + 0.5 * sin(r * 22.0 + uTime * 6.0), 6.0) * smoothstep(0.1, 0.5, r);
    float heart = smoothstep(0.42, 0.0, r);
    vec3 amber = uPalA, cream = uPalB, sky = uPalC;
    vec3 col = mix(amber, cream, smoothstep(0.25, 0.85, bands * 0.75 + n * 0.35));
    col *= 0.62 + 0.38 * fine;
    col = mix(col, sky, smoothstep(0.62, 0.98, r) * 0.45 * (1.0 - bands));
    col += cream * rush * 0.35 + vec3(1.0, 0.97, 0.9) * heart * heart * 0.9;
    col = min(col * (1.0 + uFlare * 1.2), vec3(1.25));
    float edge = smoothstep(1.0, 0.9, r);
    float alpha = edge * mix(0.82, 1.0, heart) * uOpen;
    gl_FragColor = vec4(col, alpha);
  }
`;

const beamVertex = /* glsl */ `
  varying float vY;
  varying vec3 vN, vV;
  void main() {
    vY = uv.y;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;
const beamFragment = /* glsl */ `
  uniform float uTime, uOpen, uAlpha;
  uniform vec3 uPalB;
  varying float vY;
  varying vec3 vN, vV;
  void main() {
    // brightest through the middle of the shaft, soft at its edges, fading up into the sky
    float face = pow(abs(dot(vN, vV)), 1.6);
    float up = pow(1.0 - vY, 1.4) * smoothstep(0.0, 0.03, vY);
    float ripple = 0.8 + 0.2 * sin(vY * 60.0 - uTime * 3.0);
    gl_FragColor = vec4(uPalB * 1.4, face * up * ripple * uAlpha * uOpen);
  }
`;

const sparkVertex = /* glsl */ `
  attribute vec3 seed;
  uniform float uTime, uOpen, uScale, uFlare;
  varying float vA;
  void main() {
    // each spark spirals in from beyond the rim and vanishes into the centre
    float u = fract(uTime * seed.y + seed.z);
    float r = mix(2.3, 0.05, pow(u, 0.75)) * uOpen;
    float ang = seed.x + u * 5.5 + uTime * 0.6;
    vec3 p = vec3(cos(ang) * r, sin(ang) * r * ${OVAL.toFixed(2)} + ${PORTAL.HEIGHT.toFixed(2)}, sin(seed.x * 5.0) * (1.0 - u) * 0.45);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vA = (1.0 - u) * smoothstep(0.0, 0.08, u) * uOpen * (1.0 + uFlare);
    gl_PointSize = (0.07 + 0.09 * (1.0 - u)) * uScale / max(0.1, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const sparkFragment = /* glsl */ `
  uniform vec3 uPalB;
  varying float vA;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float a = smoothstep(0.5, 0.0, length(d));
    gl_FragColor = vec4(uPalB * 1.5, a * vA);
  }
`;

const shardVertex = /* glsl */ `
  uniform float uTime, uOpen;
  attribute float iPhase;
  varying vec3 vN;
  varying float vShine;
  void main() {
    // golden shards orbiting the rim, each tumbling
    float ang = iPhase + uTime * 0.35;
    float r = ${(PORTAL.RADIUS + 0.42).toFixed(2)} * uOpen;
    vec3 c = vec3(cos(ang) * r, sin(ang) * r * ${OVAL.toFixed(2)} + ${PORTAL.HEIGHT.toFixed(2)}, sin(uTime * 1.3 + iPhase * 3.0) * 0.12);
    float s = uTime * 1.7 + iPhase * 2.0;
    mat3 rot = mat3(cos(s), 0.0, -sin(s), 0.0, 1.0, 0.0, sin(s), 0.0, cos(s)) * mat3(1.0, 0.0, 0.0, 0.0, cos(s * 0.7), sin(s * 0.7), 0.0, -sin(s * 0.7), cos(s * 0.7));
    vec3 p = rot * (position * uOpen) + c;
    vN = normalize(normalMatrix * (rot * normal));
    vShine = 0.5 + 0.5 * sin(uTime * 3.0 + iPhase * 5.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;
const shardFragment = /* glsl */ `
  uniform vec3 uPalA;
  varying vec3 vN;
  varying float vShine;
  void main() {
    float l = 0.55 + 0.45 * max(0.0, dot(normalize(vN), normalize(vec3(0.3, 0.8, 0.5))));
    gl_FragColor = vec4(mix(uPalA, vec3(1.0), 0.35) * (1.1 * l + vShine * 0.6), 1.0);
  }
`;

let groundTex: THREE.Texture | null = null;
function groundGlowTexture(): THREE.Texture {
  if (groundTex) return groundTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,226,170,0.5)');
  g.addColorStop(0.4, 'rgba(255,200,120,0.2)');
  g.addColorStop(1, 'rgba(255,190,110,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  // a faint ring of light where the oval meets the ground
  ctx.strokeStyle = 'rgba(255,220,150,0.28)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(64, 64, 34, 0, Math.PI * 2); ctx.stroke();
  groundTex = new THREE.CanvasTexture(c);
  groundTex.colorSpace = THREE.SRGBColorSpace;
  return groundTex;
}

export class PortalView {
  readonly group = new THREE.Group();
  /** The ring and everything that turns with it (yawed to face the runners). */
  private readonly frame = new THREE.Group();
  private readonly ring: THREE.Mesh;
  /** Everything that scales with the frame as it opens. */
  private readonly frameParts: THREE.Object3D[];
  private readonly ringMat: THREE.MeshBasicMaterial;
  private readonly discMat: THREE.ShaderMaterial;
  private readonly sparkMat: THREE.ShaderMaterial;
  private readonly shardMat: THREE.ShaderMaterial;
  private readonly beamMat: THREE.ShaderMaterial | null = null;
  private readonly glow: THREE.Sprite;
  private readonly flareSprite: THREE.Sprite;
  private readonly ground: THREE.Mesh;
  private readonly shared: Record<'uTime' | 'uOpen' | 'uFlare', { value: number }> = { uTime: { value: 0 }, uOpen: { value: 0 }, uFlare: { value: 0 } };
  /** 0 shut .. 1 fully open (eased). */
  open = 0;
  private target = 0;
  /** Match time the portal opens (it stays shut until then). */
  private openAt = Infinity;
  private flare = 0;
  placed = false;

  /**
   * `beam`: a column of light into the sky (the portal on the course). `oneSided`: the
   * opening is only drawn from the front, so from behind it is an open golden frame
   * (the doorway you step out of in the white room, with the camera behind you).
   */
  private readonly rim: number[];

  /** Drawn from the front only: seen from behind, its glow fades away too. */
  private readonly oneSided: boolean;

  constructor(glowTex: THREE.Texture, opts: { beam: boolean; oneSided?: boolean; palette?: PortalPalette }) {
    this.oneSided = !!opts.oneSided;
    const P = PALETTES[opts.palette ?? 'gold'];
    this.rim = P.rim;
    const pal = { uPalA: { value: new THREE.Color(...P.a) }, uPalB: { value: new THREE.Color(...P.b) }, uPalC: { value: new THREE.Color(...P.c) } };
    this.group.visible = false;
    this.group.add(this.frame);
    // the rim: lines of light drawn brighter than the tone curve allows, round a burnished frame
    this.ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(P.rim[0], P.rim[1], P.rim[2]), toneMapped: false });
    const goldMat = new THREE.MeshStandardMaterial({ color: P.frame, metalness: 0.95, roughness: 0.28, emissive: new THREE.Color(P.frameGlow), emissiveIntensity: 0.9 });
    // the frame: a burnished gold band with lines of light along its edges
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(PORTAL.RADIUS + 0.14, 0.1, 16, 112), goldMat);
    this.ring.scale.y = OVAL;
    this.ring.position.y = PORTAL.HEIGHT;
    const inner = new THREE.Mesh(new THREE.TorusGeometry(PORTAL.RADIUS + 0.03, 0.026, 8, 112), this.ringMat);
    inner.scale.y = OVAL;
    inner.position.y = PORTAL.HEIGHT;
    const outer = new THREE.Mesh(new THREE.TorusGeometry(PORTAL.RADIUS + 0.31, 0.018, 8, 112), this.ringMat);
    outer.scale.y = OVAL;
    outer.position.y = PORTAL.HEIGHT;
    // a sunburst: gold rays standing out round the frame, long and short in turn
    const rayGeos: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2, long = i % 2 === 0;
      const g = new THREE.ConeGeometry(long ? 0.05 : 0.035, long ? 0.62 : 0.34, 4);
      const rr = PORTAL.RADIUS + 0.3 + (long ? 0.31 : 0.17);
      g.rotateZ(a - Math.PI / 2);
      g.translate(Math.cos(a) * rr, Math.sin(a) * rr * OVAL, 0);
      rayGeos.push(g.index ? g.toNonIndexed() : g);
    }
    const rays = new THREE.Mesh(mergeGeometries(rayGeos, false)!, goldMat);
    rays.position.y = PORTAL.HEIGHT;
    this.frame.add(this.ring, inner, outer, rays);
    this.frameParts = [this.ring, inner, outer, rays];
    // the opening
    this.discMat = new THREE.ShaderMaterial({
      vertexShader: discVertex, fragmentShader: discFragment, uniforms: { ...this.shared, ...pal },
      transparent: true, depthWrite: false, side: opts.oneSided ? THREE.FrontSide : THREE.DoubleSide, toneMapped: false,
    });
    const disc = new THREE.Mesh(new THREE.PlaneGeometry(PORTAL.RADIUS * 2.1, PORTAL.RADIUS * 2.1 * OVAL), this.discMat);
    disc.position.y = PORTAL.HEIGHT;
    disc.renderOrder = 4;
    this.frame.add(disc);
    // sparks spiralling in
    const seeds = new Float32Array(SPARKS * 3);
    for (let i = 0; i < SPARKS; i++) { seeds[i * 3] = Math.random() * Math.PI * 2; seeds[i * 3 + 1] = 0.25 + Math.random() * 0.35; seeds[i * 3 + 2] = Math.random(); }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPARKS * 3), 3));
    sg.setAttribute('seed', new THREE.BufferAttribute(seeds, 3));
    this.sparkMat = new THREE.ShaderMaterial({
      vertexShader: sparkVertex, fragmentShader: sparkFragment,
      uniforms: { ...this.shared, uScale: { value: window.innerHeight / 2 }, uPalB: pal.uPalB },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    window.addEventListener('resize', () => { this.sparkMat.uniforms.uScale.value = window.innerHeight / 2; });
    const sparks = new THREE.Points(sg, this.sparkMat);
    sparks.frustumCulled = false;
    sparks.renderOrder = 5;
    this.frame.add(sparks);
    // golden shards orbiting the rim
    const shardGeo = new THREE.InstancedBufferGeometry();
    const oct = new THREE.OctahedronGeometry(0.075, 0);
    oct.scale(0.7, 1.6, 0.7);
    shardGeo.index = oct.index;
    shardGeo.setAttribute('position', oct.getAttribute('position'));
    shardGeo.setAttribute('normal', oct.getAttribute('normal'));
    const phases = new Float32Array(SHARDS);
    for (let i = 0; i < SHARDS; i++) phases[i] = (i / SHARDS) * Math.PI * 2 + Math.random() * 0.2;
    shardGeo.setAttribute('iPhase', new THREE.InstancedBufferAttribute(phases, 1));
    shardGeo.instanceCount = SHARDS;
    this.shardMat = new THREE.ShaderMaterial({ vertexShader: shardVertex, fragmentShader: shardFragment, uniforms: { ...this.shared, uPalA: pal.uPalA }, toneMapped: false });
    const shards = new THREE.Mesh(shardGeo, this.shardMat);
    shards.frustumCulled = false;
    this.frame.add(shards);
    // glows: a big soft halo and a bright flare at the heart
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: P.glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.3, fog: false }));
    this.glow.position.y = PORTAL.HEIGHT;
    this.glow.scale.set(6, 7, 1);
    this.flareSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: P.flare, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.4, fog: false }));
    this.flareSprite.position.y = PORTAL.HEIGHT;
    this.flareSprite.scale.set(2.2, 2.6, 1);
    this.group.add(this.glow, this.flareSprite);
    // light on the ground
    const gm = new THREE.MeshBasicMaterial({ map: groundGlowTexture(), color: opts.palette === 'storm' ? new THREE.Color(0.45, 0.85, 1.4) : 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(6.5, 6.5), gm);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = 0.03;
    this.group.add(this.ground);
    // a column of light into the sky, to be seen from anywhere on the course
    if (opts.beam) {
      this.beamMat = new THREE.ShaderMaterial({
        vertexShader: beamVertex, fragmentShader: beamFragment,
        uniforms: { uTime: this.shared.uTime, uOpen: this.shared.uOpen, uAlpha: { value: 0.5 }, uPalB: pal.uPalB },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
      });
      const bg = new THREE.CylinderGeometry(3.4, 0.7, 190, 24, 1, true);
      bg.translate(0, 95 + PORTAL.HEIGHT * 0.3, 0);
      const beam = new THREE.Mesh(bg, this.beamMat);
      beam.renderOrder = 2;
      this.group.add(beam);
    }
  }

  /** Stand the portal at `p` (on the ground), turned to `yaw`, opening at match time `at`. */
  place(p: readonly number[], yaw: number, at: number) {
    this.group.position.set(p[0], p[1], p[2]);
    this.frame.rotation.y = yaw;
    this.openAt = at;
    this.placed = true;
    this.open = 0;
    this.target = 0;
    this.group.visible = false;
  }

  /** Shut it (it shrinks away), or put it away at once. */
  close(now = false) {
    this.target = 0;
    this.openAt = Infinity;
    if (now) { this.open = 0; this.group.visible = false; this.placed = false; }
  }

  /** A burst of light: someone just stepped through. */
  pulse() { this.flare = 1; }

  /** Centre of the opening in world space. */
  centre(out: THREE.Vector3) { return out.set(this.group.position.x, this.group.position.y + PORTAL.HEIGHT, this.group.position.z); }

  /** Has it opened (at this match time)? */
  isOpen(mt: number) { return this.placed && mt >= this.openAt && this.open > 0.6; }

  update(t: number, dt: number, mt: number, camPos: THREE.Vector3) {
    if (!this.placed) { this.group.visible = false; return; }
    if (mt >= this.openAt) this.target = 1;
    // opens with a little overshoot, closes smoothly
    const k = this.target > this.open ? 1.6 : 1.1;
    this.open = Math.max(0, Math.min(1, this.open + (this.target - this.open) * Math.min(1, dt * k * 2.2) + (this.target > this.open ? dt * 0.15 : -dt * 0.15)));
    if (this.target === 0 && this.open <= 0.001) { this.group.visible = false; if (this.openAt === Infinity) this.placed = false; return; }
    this.group.visible = this.open > 0.001;
    const e = this.open;
    const pop = e < 1 ? e + Math.sin(e * Math.PI) * 0.12 : 1;
    this.flare = Math.max(0, this.flare - dt * 0.9);
    this.shared.uTime.value = t;
    this.shared.uOpen.value = e;
    this.shared.uFlare.value = this.flare;
    // the rays were laid out on the oval already; the rings are circles stretched to it
    for (const f of this.frameParts) f.scale.set(pop, f === this.frameParts[3] ? pop : pop * OVAL, pop);
    this.ringMat.color.setRGB(this.rim[0] + this.flare * 2.5, this.rim[1] + this.flare * 2.2, this.rim[2] + this.flare * 1.8);
    this.frameParts[3].rotation.z = Math.sin(t * 0.4) * 0.03;
    const breathe = 1 + Math.sin(t * 1.7) * 0.05;
    // one-sided: from behind there is nothing to see but the frame
    let face = 1;
    if (this.oneSided) {
      const yaw = this.frame.rotation.y;
      const d = (camPos.x - this.group.position.x) * Math.sin(yaw) + (camPos.z - this.group.position.z) * Math.cos(yaw);
      face = Math.max(0, Math.min(1, d / 3 + 0.3));
    }
    this.glow.scale.set(6 * e * breathe * (1 + this.flare * 1.4), 7.4 * e * breathe * (1 + this.flare * 1.4), 1);
    (this.glow.material as THREE.SpriteMaterial).opacity = (0.28 + this.flare * 0.6) * face;
    this.flareSprite.scale.set(1.6 * e * (1 + this.flare * 3), 1.9 * e * (1 + this.flare * 3), 1);
    (this.flareSprite.material as THREE.SpriteMaterial).opacity = (0.35 + this.flare * 0.6) * face;
    (this.flareSprite.material as THREE.SpriteMaterial).rotation = t * 0.3;
    this.ground.scale.setScalar(e * breathe);
    if (this.beamMat) {
      // near the portal the beam is a gentle haze; from afar it is a clear column of light
      const d = camPos.distanceTo(this.group.position);
      this.beamMat.uniforms.uAlpha.value = 0.07 + 0.43 * Math.min(1, Math.max(0, (d - 15) / 90));
    }
  }
}

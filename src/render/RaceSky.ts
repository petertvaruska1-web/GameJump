// The sky of Speedster Battle: the gap in spacetime the Warden's rift opens
// onto. One dome that follows the camera, drawn in a single shader: two layers
// of stars (twinkling), a galaxy band with dark dust lanes, a slow nebula, the
// tear itself (a jagged crack of white light with chromatic fringes, the scar
// the rift came through), and a black hole with a hot accretion disc and its
// ring of bent light. Beyond it, a ringed gas giant hangs where it can never be
// reached (it moves with the camera, like the dome). Three draw calls in all,
// nothing on the CPU but a time uniform.

import * as THREE from 'three';

const skyVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const NOISE = /* glsl */ `
  float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
  float vnoise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash13(i), b = hash13(i + vec3(1, 0, 0)), c = hash13(i + vec3(0, 1, 0)), d = hash13(i + vec3(1, 1, 0));
    float e = hash13(i + vec3(0, 0, 1)), g = hash13(i + vec3(1, 0, 1)), h = hash13(i + vec3(0, 1, 1)), k = hash13(i + vec3(1, 1, 1));
    return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), mix(mix(e, g, f.x), mix(h, k, f.x), f.y), f.z);
  }
  float fbm(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.07 + 13.7; a *= 0.5; } return s; }
`;

const skyFragment = /* glsl */ `
  uniform float uTime;
  uniform vec3 uTear, uHole, uBand;
  varying vec3 vDir;
  ${NOISE}
  // stars in cells over the sphere: sparse points, each its own size, colour and twinkle
  vec3 stars(vec3 d, float scale, float keep, float size) {
    vec3 p = d * scale, i = floor(p), f = fract(p);
    float h = hash13(i);
    if (h > keep) return vec3(0.0);
    vec3 c = vec3(hash13(i + 1.7), hash13(i + 4.1), hash13(i + 7.3)) * 0.7 + 0.15;
    float r = length(f - c);
    float tw = 0.75 + 0.25 * sin(uTime * (1.5 + h * 9.0) + h * 40.0);
    float b = smoothstep(size, 0.0, r) * tw * (0.4 + 0.6 * fract(h * 97.0));
    vec3 tint = mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.86, 0.72), fract(h * 53.0));
    return tint * b;
  }
  void main() {
    vec3 d = normalize(vDir);
    // deep space: almost black, a breath of indigo toward the band
    float b = dot(d, uBand);
    float band = exp(-b * b / 0.03);
    vec3 col = mix(vec3(0.004, 0.003, 0.014), vec3(0.03, 0.018, 0.07), band);
    // the nebula: slow violet, magenta and teal clouds, thickest near the band
    float n = fbm(d * 2.3 + vec3(0.0, uTime * 0.003, 0.0));
    float n2 = fbm(d * 5.1 + 3.3);
    float neb = smoothstep(0.42, 0.86, n) * (0.35 + band * 0.9);
    vec3 nc = mix(vec3(0.34, 0.1, 0.62), vec3(0.62, 0.08, 0.38), smoothstep(0.35, 0.65, n2));
    nc = mix(nc, vec3(0.04, 0.42, 0.46), smoothstep(0.55, 0.8, n2) * 0.8);
    col += nc * neb * 0.55;
    // the galaxy band: a glow, dense faint stars, and dark lanes of dust across it
    float dust = smoothstep(0.45, 0.7, fbm(d * 9.0 + 7.0));
    col += vec3(0.28, 0.22, 0.46) * band * 0.35 * (1.0 - dust * 0.8);
    col += stars(d, 520.0, 0.35 * band, 0.18) * (1.0 - dust) * 0.9;
    col += stars(d, 260.0, 0.14, 0.2);
    col += stars(d, 90.0, 0.08, 0.14) * 1.6;
    // the tear: the scar in spacetime the rift came through, a jagged crack of white light
    vec3 t1 = normalize(cross(uTear, vec3(0.0, 1.0, 0.0))), t2 = cross(t1, uTear);
    float tz = dot(d, uTear);
    if (tz > 0.0) {
      float u = atan(dot(d, t1), tz), v = atan(dot(d, t2), tz);
      float v0 = 0.05 * sin(u * 5.0 + 1.3) + 0.06 * (fbm(vec3(u * 6.0, 0.5, 2.0)) - 0.5) + 0.012 * sin(u * 31.0 + uTime * 0.7);
      float dist = abs(v - v0);
      float len = smoothstep(0.95, 0.4, abs(u));
      float core = exp(-dist * 420.0) * 1.8, glow = exp(-dist * 60.0) * 0.55, halo = exp(-dist * 11.0) * 0.18;
      vec3 fringe = v > v0 ? vec3(0.95, 0.3, 1.0) : vec3(0.2, 0.95, 1.0);
      col += len * (vec3(1.0) * core + mix(vec3(1.0), fringe, 0.7) * glow + fringe * halo);
      // a few thin cracks branching off it
      float br = abs(v - v0 - 0.08 * (u - 0.2) * step(0.2, u) * step(u, 0.55));
      col += len * exp(-br * 700.0) * step(0.2, u) * step(u, 0.55) * vec3(0.8, 0.85, 1.0);
    }
    // the black hole: a disc of darkness, its ring of bent light, and a hot swirling disc round it
    vec3 h1 = normalize(cross(uHole, vec3(0.2, 1.0, 0.1))), h2 = cross(h1, uHole);
    float hz = dot(d, uHole);
    if (hz > 0.9) {
      vec2 q = vec2(dot(d, h1), dot(d, h2)) / hz;
      float r = length(q), r0 = 0.03;
      float disc = length(vec2(q.x, q.y / 0.26));
      float swirl = 0.6 + 0.4 * sin(atan(q.y / 0.26, q.x) * 7.0 - uTime * 1.4 + disc * 260.0);
      float ring = smoothstep(r0 * 1.5, r0 * 2.1, disc) * smoothstep(r0 * 5.2, r0 * 2.4, disc);
      vec3 hot = mix(vec3(1.6, 0.75, 0.35), vec3(1.3, 1.25, 1.6), smoothstep(r0 * 4.0, r0 * 2.0, disc));
      col += hot * ring * swirl * 0.9;
      col += vec3(1.2, 1.0, 1.4) * exp(-pow((r - r0 * 1.35) / 0.0035, 2.0)) * 1.3;
      col *= smoothstep(r0 * 0.95, r0 * 1.12, r);
    }
    gl_FragColor = vec4(col, 1.0);
  }`;

const planetVertex = /* glsl */ `
  varying vec3 vN; varying vec3 vP; varying vec3 vView;
  void main() {
    vN = normalize(normalMatrix * normal); vP = position;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;
const planetFragment = /* glsl */ `
  uniform float uTime; uniform vec3 uLight;
  varying vec3 vN; varying vec3 vP; varying vec3 vView;
  ${NOISE}
  void main() {
    vec3 p = normalize(vP);
    float lat = p.y + 0.06 * fbm(p * 6.0 + vec3(uTime * 0.01, 0.0, 0.0));
    float bands = 0.5 + 0.5 * sin(lat * 26.0) * 0.6 + 0.25 * sin(lat * 61.0);
    vec3 c = mix(vec3(0.16, 0.1, 0.3), vec3(0.42, 0.3, 0.62), bands);
    c = mix(c, vec3(0.1, 0.34, 0.4), smoothstep(0.6, 0.9, fbm(p * 3.0 + 2.0)) * 0.6);
    float lit = clamp(dot(normalize(vN), normalize(uLight)), 0.0, 1.0);
    float rim = pow(1.0 - clamp(dot(normalize(vN), normalize(vView)), 0.0, 1.0), 3.0);
    gl_FragColor = vec4(c * (0.06 + lit * 0.95) + vec3(0.35, 0.75, 1.0) * rim * (0.25 + lit * 0.9), 1.0);
  }`;
const ringFragment = /* glsl */ `
  varying vec2 vUv;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    if (r < 0.58 || r > 1.0) discard;
    float k = (r - 0.58) / 0.42;
    float bands = 0.5 + 0.5 * sin(k * 90.0) * 0.5 + 0.3 * sin(k * 23.0);
    float gap = smoothstep(0.0, 0.03, abs(k - 0.63));
    float a = bands * gap * smoothstep(0.0, 0.08, k) * smoothstep(1.0, 0.85, k) * 0.5;
    gl_FragColor = vec4(vec3(0.62, 0.55, 0.85) * (0.4 + bands * 0.6), a);
  }`;
const flatVertex = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

/** Where things stand in the sky (unit directions). */
export const TEAR_DIR = new THREE.Vector3(0.35, 0.42, 0.84).normalize();
const HOLE_DIR = new THREE.Vector3(-0.72, 0.3, 0.62).normalize();
const BAND_N = new THREE.Vector3(0.3, 0.85, -0.43).normalize();
const PLANET_DIR = new THREE.Vector3(0.78, 0.2, -0.6).normalize();

export class RaceSky {
  readonly group = new THREE.Group();
  private readonly dome: THREE.Mesh;
  private readonly planet: THREE.Group;
  private readonly mats: THREE.ShaderMaterial[] = [];

  constructor() {
    const sm = new THREE.ShaderMaterial({
      vertexShader: skyVertex, fragmentShader: skyFragment, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false, toneMapped: false,
      uniforms: { uTime: { value: 0 }, uTear: { value: TEAR_DIR }, uHole: { value: HOLE_DIR }, uBand: { value: BAND_N } },
    });
    this.mats.push(sm);
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1000, 48, 24), sm);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -10;
    this.group.add(this.dome);
    // the ringed giant, far beyond reach
    this.planet = new THREE.Group();
    const pm = new THREE.ShaderMaterial({ vertexShader: planetVertex, fragmentShader: planetFragment, fog: false, toneMapped: false, uniforms: { uTime: { value: 0 }, uLight: { value: new THREE.Vector3(-0.4, 0.6, 0.7).normalize() } } });
    this.mats.push(pm);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(230, 48, 32), pm);
    ball.renderOrder = -9;
    this.planet.add(ball);
    const rm = new THREE.ShaderMaterial({ vertexShader: flatVertex, fragmentShader: ringFragment, transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide, toneMapped: false });
    const ring = new THREE.Mesh(new THREE.PlaneGeometry(1100, 1100), rm);
    ring.rotation.x = -Math.PI / 2 + 0.32;
    ring.rotation.z = 0.25;
    ring.renderOrder = -8;
    this.planet.add(ring);
    this.planet.position.copy(PLANET_DIR).multiplyScalar(1750);
    this.group.add(this.planet);
    this.group.traverse((o) => { o.frustumCulled = false; });
  }

  update(time: number, camPos: THREE.Vector3) {
    this.group.position.copy(camPos);
    for (const m of this.mats) if (m.uniforms.uTime) m.uniforms.uTime.value = time;
    this.planet.rotation.y = time * 0.004;
  }
}

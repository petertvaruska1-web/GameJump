// Many camera-facing quads in one draw call: glows, smoke puffs, distant cloud
// banks. Every THREE.Sprite is its own draw call, and the level carries a couple
// of hundred of them (a glow on every warning light and lamp), so the static and
// simply-animated ones are batched here instead.
//
// Each quad has a centre, a world size (x, y), a colour, an opacity and a blink
// mode. Blinking is done on the GPU from a time uniform, so steady and blinking
// lights cost nothing per frame; only the few that move (smoke, clouds) update
// their attributes.

import * as THREE from 'three';

export const Blink = {
  /** Steady. */
  None: 0,
  /** The level's warning lights: all together, bright most of the time. */
  Warning: 1,
  /** Skyline aircraft lights: each on its own phase. */
  Beacon: 2,
} as const;

export interface BillboardOpts {
  map: THREE.Texture;
  additive?: boolean;
  /**
   * How fog treats the quads. 'fade' dims additive glows to nothing with
   * distance (adding fog colour to an additive glow would turn every far light
   * into a pale blob); 'mix' blends normal quads toward the fog colour like any
   * surface; 'none' ignores fog.
   */
  fog?: 'fade' | 'mix' | 'none';
  renderOrder?: number;
}

const vertex = /* glsl */ `
  attribute vec3 iPos;
  attribute vec2 iSize;
  attribute vec3 iColor;
  attribute float iAlpha;
  attribute vec2 iBlink;
  uniform float uTime;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  #include <fog_pars_vertex>
  void main() {
    vUv = uv;
    vColor = iColor;
    float k = 1.0;
    if (iBlink.x > 0.5 && iBlink.x < 1.5) k = sin(uTime * 3.2) > 0.2 ? 1.0 : 0.32;
    else if (iBlink.x > 1.5) k = sin(uTime * 2.4 + iBlink.y) > 0.3 ? 1.0 : 0.1;
    vAlpha = iAlpha * k;
    vec4 mvPosition = modelViewMatrix * vec4(iPos, 1.0);
    mvPosition.xy += position.xy * iSize;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const fragment = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uFogMode;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  #include <fog_pars_fragment>
  void main() {
    vec4 tex = texture2D(uMap, vUv);
    gl_FragColor = vec4(vColor * tex.rgb, tex.a * vAlpha);
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      #else
        float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
      #endif
      if (uFogMode > 1.5) gl_FragColor.a *= 1.0 - fogFactor;
      else if (uFogMode > 0.5) gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
    #endif
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class Billboards {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private readonly pos: Float32Array;
  private readonly size: Float32Array;
  private readonly color: Float32Array;
  private readonly alpha: Float32Array;
  private readonly blink: Float32Array;
  private readonly attrs: Record<'pos' | 'size' | 'color' | 'alpha' | 'blink', THREE.InstancedBufferAttribute>;
  count = 0;

  constructor(readonly capacity: number, o: BillboardOpts) {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    this.geo.setAttribute('uv', quad.getAttribute('uv'));
    this.pos = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity * 2);
    this.color = new Float32Array(capacity * 3);
    this.alpha = new Float32Array(capacity);
    this.blink = new Float32Array(capacity * 2);
    this.attrs = {
      pos: new THREE.InstancedBufferAttribute(this.pos, 3),
      size: new THREE.InstancedBufferAttribute(this.size, 2),
      color: new THREE.InstancedBufferAttribute(this.color, 3),
      alpha: new THREE.InstancedBufferAttribute(this.alpha, 1),
      blink: new THREE.InstancedBufferAttribute(this.blink, 2),
    };
    this.geo.setAttribute('iPos', this.attrs.pos);
    this.geo.setAttribute('iSize', this.attrs.size);
    this.geo.setAttribute('iColor', this.attrs.color);
    this.geo.setAttribute('iAlpha', this.attrs.alpha);
    this.geo.setAttribute('iBlink', this.attrs.blink);
    this.geo.instanceCount = 0;
    const fog = o.fog ?? 'none';
    this.mat = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uMap: { value: o.map }, uTime: { value: 0 }, uFogMode: { value: fog === 'fade' ? 2 : fog === 'mix' ? 1 : 0 } },
      ]),
      transparent: true,
      depthWrite: false,
      blending: o.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: fog !== 'none',
    });
    this.mat.uniforms.uMap.value = o.map;
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    // the quads are spread across the whole level: no single bound to cull by
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = o.renderOrder ?? 0;
  }

  /** Adds a quad and returns its index. */
  add(x: number, y: number, z: number, w: number, h: number, color: number | THREE.Color, alpha = 1, blink: number = Blink.None, phase = 0): number {
    const i = this.count++;
    if (i >= this.capacity) throw new Error('Billboards: over capacity');
    this.set(i, x, y, z, w, h, alpha);
    const c = color instanceof THREE.Color ? color : new THREE.Color(color);
    this.color[i * 3] = c.r; this.color[i * 3 + 1] = c.g; this.color[i * 3 + 2] = c.b;
    this.blink[i * 2] = blink; this.blink[i * 2 + 1] = phase;
    this.geo.instanceCount = this.count;
    this.attrs.color.needsUpdate = true;
    this.attrs.blink.needsUpdate = true;
    return i;
  }

  set(i: number, x: number, y: number, z: number, w: number, h: number, alpha: number) {
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.size[i * 2] = w; this.size[i * 2 + 1] = h;
    this.alpha[i] = alpha;
    this.attrs.pos.needsUpdate = true;
    this.attrs.size.needsUpdate = true;
    this.attrs.alpha.needsUpdate = true;
  }

  /** Recolours quad `i` (flashes reuse their slots in different colours). */
  setColor(i: number, c: THREE.Color) {
    this.color[i * 3] = c.r; this.color[i * 3 + 1] = c.g; this.color[i * 3 + 2] = c.b;
    this.attrs.color.needsUpdate = true;
  }

  setTime(t: number) { this.mat.uniforms.uTime.value = t; }
}

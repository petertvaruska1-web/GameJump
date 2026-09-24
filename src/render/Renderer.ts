// three.js renderer, scene, camera and lighting. The sun's shadow frustum
// follows the player so shadows stay crisp without a huge shadow map.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { FOG_COLOR, SUN_DIR } from './Sky';

export type Quality = 'low' | 'medium' | 'high';

export const FOG_DENSITY = 0.0021;

// Height fog: everything below the playable altitude dissolves into haze, so
// support columns read as plunging into the depths instead of ending abruptly.
// World Y is reconstructed from the (rigid) view matrix so this works for
// meshes, sprites, points and lines alike.
THREE.ShaderChunk.fog_pars_vertex = `#ifdef USE_FOG
  varying float vFogDepth;
  varying float vFogWorldY;
#endif`;
THREE.ShaderChunk.fog_vertex = `#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogWorldY = dot( viewMatrix[1].xyz, mvPosition.xyz - viewMatrix[3].xyz );
#endif`;
THREE.ShaderChunk.fog_pars_fragment = `#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying float vFogWorldY;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;
THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  float hf = clamp( ( 16.0 - vFogWorldY ) / 95.0, 0.0, 1.0 );
  hf = hf * hf * ( 3.0 - 2.0 * hf );
  fogFactor = max( fogFactor, hf * 0.97 * clamp( vFogDepth / 25.0, 0.0, 1.0 ) );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`;

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly shadows: boolean;
  private shadowFocus = new THREE.Vector3();
  /** The sky light's everyday strength (lightning adds to it); the arena's storm is darker. */
  hemiBase = 1.05;

  constructor(canvas: HTMLCanvasElement, readonly quality: Quality) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: quality !== 'low', powerPreference: 'high-performance', stencil: false });
    const dpr = window.devicePixelRatio || 1;
    this.renderer.setPixelRatio(Math.min(dpr, quality === 'high' ? 2 : quality === 'medium' ? 1.5 : 1));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.shadows = quality !== 'low';
    this.renderer.shadowMap.enabled = this.shadows;
    // PCF is what three uses now (the old soft variant was folded into it)
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    // soft image-based lighting so metals and shaded faces never go pitch black
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.35;
    pmrem.dispose();

    this.scene.fog = new THREE.FogExp2(FOG_COLOR.getHex(), FOG_DENSITY);
    this.scene.background = FOG_COLOR.clone();

    this.camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 2600);

    this.hemi = new THREE.HemisphereLight(0xc4d6ee, 0x6a5e54, 1.05);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffe0b8, 2.6);
    this.sun.position.copy(SUN_DIR).multiplyScalar(120);
    if (this.shadows) {
      this.sun.castShadow = true;
      const size = quality === 'high' ? 4096 : 2048;
      this.sun.shadow.mapSize.set(size, size);
      const c = this.sun.shadow.camera;
      const ext = quality === 'high' ? 55 : 45;
      c.left = -ext; c.right = ext; c.top = ext; c.bottom = -ext;
      c.near = 1; c.far = 320;
      this.sun.shadow.bias = -0.0004;
      this.sun.shadow.normalBias = 0.04;
    }
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Centre the sun's shadow frustum on a point (snapped to texels to avoid shimmering). */
  focusShadows(p: THREE.Vector3) {
    const snap = 0.5;
    this.shadowFocus.set(Math.round(p.x / snap) * snap, Math.round(p.y / snap) * snap, Math.round(p.z / snap) * snap);
    this.sun.target.position.copy(this.shadowFocus);
    this.sun.position.copy(this.shadowFocus).addScaledVector(SUN_DIR, 150);
  }

  setLightning(level: number) {
    this.hemi.intensity = this.hemiBase + level * 1.4;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}

export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}

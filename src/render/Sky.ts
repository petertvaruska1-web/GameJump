// High-altitude atmosphere: gradient sky with sun, an animated cloud sea far
// below, drifting cloud banks, distant tower silhouettes and occasional
// lightning inside the clouds. All cheap: a few shaders and merged meshes.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rng } from '../../shared/math';

export const SUN_DIR = new THREE.Vector3(-0.55, 0.42, 0.72).normalize();
export const FOG_COLOR = new THREE.Color(0xaebdcb);
export const CLOUD_Y = -85;

const NOISE = /* glsl */ `
  float hash(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
  float noise(vec2 p){ vec2 i=floor(p); vec2 f=fract(p); vec2 u=f*f*(3.0-2.0*f);
    return mix(mix(hash(i),hash(i+vec2(1,0)),u.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x), u.y); }
  float fbm(vec2 p){ float v=0.0; float a=0.5; for(int i=0;i<5;i++){ v+=a*noise(p); p*=2.03; a*=0.5; } return v; }
`;

export class Sky {
  readonly group = new THREE.Group();
  private dome: THREE.Mesh;
  private domeMat: THREE.ShaderMaterial;
  private sea: THREE.Mesh;
  private seaMat: THREE.ShaderMaterial;
  private puffs: { s: THREE.Sprite; speed: number; base: THREE.Vector3 }[] = [];
  private flash = 0;
  private nextFlash = 18;
  private flashDir = new THREE.Vector3();
  onThunder?: (delay: number, strength: number) => void;

  constructor(fogDensity: number) {
    this.domeMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        uSun: { value: SUN_DIR.clone() },
        uZenith: { value: new THREE.Color(0x24507f) },
        uHorizon: { value: FOG_COLOR.clone() },
        uWarm: { value: new THREE.Color(0xf6d8ae) },
        uAbyss: { value: new THREE.Color(0x46566b) },
        uFlash: { value: 0 },
        uFlashDir: { value: new THREE.Vector3(1, 0, 0) },
      },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix*vec4(position,1.0); gl_Position = projectionMatrix*p; gl_Position.z = gl_Position.w; }`,
      fragmentShader: `uniform vec3 uSun, uZenith, uHorizon, uWarm, uAbyss, uFlashDir; uniform float uFlash; varying vec3 vDir;
        void main(){
          vec3 d = normalize(vDir);
          float h = d.y;
          float sunAmt = max(dot(d, uSun), 0.0);
          vec3 hor = mix(uHorizon, uWarm, pow(sunAmt, 4.0) * 0.85);
          vec3 col = h > 0.0 ? mix(hor, uZenith, pow(clamp(h,0.0,1.0), 0.55)) : mix(hor, uAbyss, pow(clamp(-h*3.0,0.0,1.0),0.7));
          col += vec3(1.0,0.86,0.62) * pow(sunAmt, 900.0) * 6.0;
          col += vec3(1.0,0.8,0.55) * pow(sunAmt, 18.0) * 0.35;
          float fl = uFlash * pow(max(dot(d, uFlashDir), 0.0), 6.0) * smoothstep(0.25, -0.1, h);
          col += vec3(0.75,0.8,1.0) * fl * 1.6;
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1500, 32, 20), this.domeMat);
    this.dome.renderOrder = -10;
    this.dome.frustumCulled = false;
    this.group.add(this.dome);

    this.seaMat = new THREE.ShaderMaterial({
      transparent: false, fog: false,
      uniforms: {
        uTime: { value: 0 },
        uSun: { value: SUN_DIR.clone() },
        uFog: { value: FOG_COLOR.clone() },
        uDensity: { value: fogDensity * 0.75 },
        uCam: { value: new THREE.Vector3() },
        uFlash: { value: 0 },
        uFlashPos: { value: new THREE.Vector2() },
      },
      vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
      fragmentShader: `uniform float uTime, uDensity, uFlash; uniform vec3 uSun, uFog, uCam; uniform vec2 uFlashPos; varying vec3 vW;
        ${NOISE}
        void main(){
          vec2 p = vW.xz * 0.0065 + vec2(uTime*0.004, uTime*0.0016);
          float n = fbm(p);
          float n2 = fbm(p*2.7 - vec2(uTime*0.006, 0.0));
          float c = smoothstep(0.28, 0.72, n*0.75 + n2*0.4);
          // fake lighting from the noise slope
          float nx = fbm(p + vec2(0.02,0.0)) - n;
          float nz = fbm(p + vec2(0.0,0.02)) - n;
          vec3 nrm = normalize(vec3(-nx*14.0, 1.0, -nz*14.0));
          float lit = clamp(dot(nrm, uSun)*0.9 + 0.35, 0.0, 1.3);
          vec3 shadow = vec3(0.47,0.53,0.64), bright = vec3(1.0,0.96,0.9);
          vec3 col = mix(vec3(0.28,0.33,0.42), mix(shadow, bright, lit), c);
          float fl = uFlash * exp(-length(vW.xz - uFlashPos) * 0.004);
          col += vec3(0.8,0.85,1.0) * fl * (0.4 + c);
          float dist = length(vW - uCam);
          float f = 1.0 - exp(-pow(dist * uDensity, 2.0));
          gl_FragColor = vec4(mix(col, uFog, clamp(f, 0.0, 1.0)), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.sea = new THREE.Mesh(new THREE.PlaneGeometry(5000, 5000, 1, 1), this.seaMat);
    this.sea.rotation.x = -Math.PI / 2;
    this.sea.position.y = CLOUD_Y;
    this.sea.frustumCulled = false;
    this.group.add(this.sea);

    this.buildPuffs();
    this.buildSilhouettes();
    this.buildSkyWriting();
  }

  /** A faint word written in cloud far ahead of the course, for anyone who looks up. */
  private buildSkyWriting() {
    const mat = new THREE.MeshBasicMaterial({ map: cloudWriting('majo.majer'), transparent: true, opacity: 0.5, depthWrite: false, fog: false, color: 0xf4efe8 });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(460, 115), mat);
    sign.position.set(200, 330, 1300);
    // face back down the course, tipped toward runners below it
    sign.rotation.set(0.3, Math.atan2(0 - 200, 450 - 1300), 0, 'YXZ');
    sign.renderOrder = -5;
    this.group.add(sign);
  }

  private buildPuffs() {
    const tex = cloudTexture();
    const r = rng(99);
    for (let i = 0; i < 46; i++) {
      const a = r() * Math.PI * 2;
      const dist = 120 + r() * 700;
      const y = CLOUD_Y + 8 + r() * (i < 12 ? 70 : 30);
      const mat = new THREE.SpriteMaterial({ map: tex, color: 0xffffff, transparent: true, depthWrite: false, opacity: 0.55 + r() * 0.35, fog: true });
      const s = new THREE.Sprite(mat);
      const base = new THREE.Vector3(Math.sin(a) * dist, y, 240 + Math.cos(a) * dist);
      s.position.copy(base);
      const size = 60 + r() * 140;
      s.scale.set(size * 1.8, size * 0.8, 1);
      this.group.add(s);
      this.puffs.push({ s, speed: 0.6 + r() * 1.4, base });
    }
  }

  private buildSilhouettes() {
    const r = rng(2024);
    const geos: THREE.BufferGeometry[] = [];
    const lights: THREE.Vector3[] = [];
    for (let i = 0; i < 38; i++) {
      const a = r() * Math.PI * 2;
      const dist = 380 + r() * 750;
      const x = Math.sin(a) * dist, z = 240 + Math.cos(a) * dist;
      const top = 20 + r() * 190;
      const w = 12 + r() * 36;
      const h = top - (CLOUD_Y - 30);
      const kind = r();
      let g: THREE.BufferGeometry;
      if (kind < 0.4) g = new THREE.CylinderGeometry(w * 0.35, w * 0.5, h, 8);
      else g = new THREE.BoxGeometry(w, h, w * (0.6 + r() * 0.6));
      g.translate(x, CLOUD_Y - 30 + h / 2, z);
      g.rotateY(0);
      geos.push(g);
      if (r() > 0.5) {
        const m = new THREE.BoxGeometry(w * 0.6, 6 + r() * 20, w * 0.6);
        m.translate(x, top + 4, z);
        geos.push(m);
      }
      if (r() > 0.55) {
        const ant = new THREE.CylinderGeometry(0.6, 0.9, 30 + r() * 40, 5);
        ant.translate(x, top + 20, z);
        geos.push(ant);
        lights.push(new THREE.Vector3(x, top + 40, z));
      }
    }
    const merged = mergeGeometries(geos.map((g) => g.index ? g.toNonIndexed() : g), false)!;
    merged.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ color: 0x55627a, fog: true });
    const mesh = new THREE.Mesh(merged, mat);
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
    const glowTex = cloudGlow();
    for (const p of lights) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xff3a2a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
      s.position.copy(p);
      s.scale.setScalar(9);
      this.group.add(s);
      (s.userData as { blink: number }).blink = r() * 6;
    }
  }

  update(t: number, dt: number, camPos: THREE.Vector3) {
    this.dome.position.copy(camPos);
    this.seaMat.uniforms.uTime.value = t;
    this.seaMat.uniforms.uCam.value.copy(camPos);
    this.sea.position.x = camPos.x;
    this.sea.position.z = camPos.z;
    for (const p of this.puffs) {
      p.s.position.x = p.base.x + Math.sin(t * 0.01 * p.speed + p.base.z) * 30 + t * p.speed * 0.4;
      if (p.s.position.x - camPos.x > 900) p.base.x -= 1800;
    }
    for (const c of this.group.children) {
      const b = (c.userData as { blink?: number }).blink;
      if (b !== undefined) ((c as THREE.Sprite).material as THREE.SpriteMaterial).opacity = Math.sin(t * 2.4 + b) > 0.3 ? 1 : 0.1;
    }
    // lightning
    this.nextFlash -= dt;
    if (this.nextFlash <= 0) {
      this.nextFlash = 22 + Math.random() * 35;
      const a = Math.random() * Math.PI * 2;
      this.flashDir.set(Math.sin(a), -0.08, Math.cos(a)).normalize();
      this.flash = 1;
      const fp = this.seaMat.uniforms.uFlashPos.value as THREE.Vector2;
      fp.set(camPos.x + Math.sin(a) * 500, camPos.z + Math.cos(a) * 500);
      this.domeMat.uniforms.uFlashDir.value.copy(this.flashDir);
      this.onThunder?.(1.2 + Math.random() * 1.8, 0.4 + Math.random() * 0.6);
    }
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * 2.8);
      const f = this.flash * (0.6 + 0.4 * Math.sin(t * 60));
      this.domeMat.uniforms.uFlash.value = f;
      this.seaMat.uniforms.uFlash.value = f;
    }
  }

  get flashLevel() { return this.flash; }
}

function cloudTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const ctx = c.getContext('2d')!;
  const r = rng(5);
  for (let i = 0; i < 70; i++) {
    const x = 40 + r() * 176, y = 40 + r() * 60, rad = 14 + r() * 36;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    const shade = 225 + Math.floor(r() * 30);
    g.addColorStop(0, `rgba(${shade},${shade},${shade + 5},0.22)`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 128);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Text traced in soft cloud puffs, so it reads as skywriting rather than lettering. */
function cloudWriting(text: string): THREE.Texture {
  const W = 1024, H = 256;
  const mask = document.createElement('canvas');
  mask.width = W; mask.height = H;
  const m = mask.getContext('2d')!;
  m.fillStyle = '#fff';
  m.font = '900 150px "Arial Rounded MT Bold", "Trebuchet MS", Arial, sans-serif';
  m.textAlign = 'center'; m.textBaseline = 'middle';
  m.fillText(text, W / 2, H / 2 + 6);
  const px = m.getImageData(0, 0, W, H).data;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;
  const r = rng(314);
  const puff = (x: number, y: number, rad: number, a: number) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, `rgba(255,255,255,${a})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  };
  for (let y = 0; y < H; y += 5) {
    for (let x = 0; x < W; x += 5) {
      if (px[(y * W + x) * 4 + 3] < 128 || r() > 0.55) continue;
      puff(x + (r() - 0.5) * 6, y + (r() - 0.5) * 6, 9 + r() * 12, 0.16 + r() * 0.1);
    }
  }
  // a few loose wisps so the edges fray into the sky
  for (let i = 0; i < 40; i++) puff(80 + r() * (W - 160), 40 + r() * (H - 80), 20 + r() * 30, 0.04);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function cloudGlow(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

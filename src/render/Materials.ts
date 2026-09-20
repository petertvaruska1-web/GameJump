// Procedural canvas textures + a shared material per level material key.
// Keeps the palette limited and coherent: warm concrete, blue steel, rust, hazard yellow.

import * as THREE from 'three';
import type { MatKey } from '../../shared/level/types';
import { rng } from '../../shared/math';

type Draw = (ctx: CanvasRenderingContext2D, s: number, r: () => number) => void;

function canvasTex(size: number, draw: Draw, seed = 1): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  draw(ctx, size, rng(seed));
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  return t;
}

function speckle(ctx: CanvasRenderingContext2D, s: number, r: () => number, n: number, alpha: number, light = false) {
  for (let i = 0; i < n; i++) {
    const v = light ? 255 : 0;
    ctx.fillStyle = `rgba(${v},${v},${v},${alpha * r()})`;
    const w = 1 + r() * 2.5;
    ctx.fillRect(r() * s, r() * s, w, w);
  }
}

function stains(ctx: CanvasRenderingContext2D, s: number, r: () => number, n: number, color: string) {
  for (let i = 0; i < n; i++) {
    const x = r() * s, y = r() * s, rad = s * (0.05 + r() * 0.18);
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
}

const TEX: Record<string, Draw> = {
  concrete(ctx, s, r) {
    ctx.fillStyle = '#b9b2a6'; ctx.fillRect(0, 0, s, s);
    stains(ctx, s, r, 14, 'rgba(90,80,70,0.10)');
    stains(ctx, s, r, 8, 'rgba(255,250,235,0.10)');
    speckle(ctx, s, r, 2600, 0.16);
    speckle(ctx, s, r, 900, 0.12, true);
    ctx.strokeStyle = 'rgba(40,36,32,0.35)'; ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, s - 2, s - 2);
    ctx.beginPath(); ctx.moveTo(s / 2, 0); ctx.lineTo(s / 2, s); ctx.stroke();
    // a few hairline cracks
    ctx.strokeStyle = 'rgba(30,28,25,0.35)'; ctx.lineWidth = 1;
    for (let i = 0; i < 3; i++) {
      let x = r() * s, y = r() * s;
      ctx.beginPath(); ctx.moveTo(x, y);
      for (let k = 0; k < 7; k++) { x += (r() - 0.5) * 30; y += (r() - 0.3) * 24; ctx.lineTo(x, y); }
      ctx.stroke();
    }
  },
  concreteDark(ctx, s, r) {
    ctx.fillStyle = '#6f727a'; ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 60; i++) {
      ctx.fillStyle = `rgba(20,24,30,${0.05 + r() * 0.1})`;
      ctx.fillRect(r() * s, 0, 2 + r() * 8, s);
    }
    speckle(ctx, s, r, 2000, 0.18);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(0, s / 2 - 1, s, 2);
  },
  metal(ctx, s, r) {
    ctx.fillStyle = '#7f8c9b'; ctx.fillRect(0, 0, s, s);
    speckle(ctx, s, r, 1400, 0.12);
    stains(ctx, s, r, 6, 'rgba(60,70,80,0.18)');
    ctx.strokeStyle = 'rgba(25,30,38,0.6)'; ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, s - 3, s - 3);
    ctx.fillStyle = 'rgba(210,220,230,0.5)';
    for (const [x, y] of [[10, 10], [s - 10, 10], [10, s - 10], [s - 10, s - 10]]) { ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill(); }
    // diamond tread
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 2;
    for (let y = 16; y < s - 8; y += 16) for (let x = 16 + ((y / 16) % 2) * 8; x < s - 8; x += 16) {
      ctx.beginPath(); ctx.moveTo(x - 4, y + 3); ctx.lineTo(x + 4, y - 3); ctx.stroke();
    }
  },
  steel(ctx, s, r) {
    ctx.fillStyle = '#3e4957'; ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 180; i++) { ctx.fillStyle = `rgba(255,255,255,${r() * 0.05})`; ctx.fillRect(0, r() * s, s, 1); }
    speckle(ctx, s, r, 700, 0.2);
    stains(ctx, s, r, 5, 'rgba(120,70,40,0.18)');
  },
  rust(ctx, s, r) {
    ctx.fillStyle = '#8c4d2c'; ctx.fillRect(0, 0, s, s);
    const n = 16;
    for (let i = 0; i < n; i++) {
      const x = (i / n) * s;
      const g = ctx.createLinearGradient(x, 0, x + s / n, 0);
      g.addColorStop(0, 'rgba(0,0,0,0.22)'); g.addColorStop(0.5, 'rgba(255,220,190,0.10)'); g.addColorStop(1, 'rgba(0,0,0,0.22)');
      ctx.fillStyle = g; ctx.fillRect(x, 0, s / n, s);
    }
    stains(ctx, s, r, 18, 'rgba(60,25,10,0.28)');
    stains(ctx, s, r, 10, 'rgba(200,120,60,0.18)');
    speckle(ctx, s, r, 1500, 0.2);
  },
  hazard(ctx, s) {
    ctx.fillStyle = '#e9b52a'; ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = '#1c1c1e';
    const w = s / 4;
    for (let i = -4; i < 8; i++) {
      ctx.beginPath();
      ctx.moveTo(i * w * 2, 0); ctx.lineTo(i * w * 2 + w, 0); ctx.lineTo(i * w * 2 + w + s, s); ctx.lineTo(i * w * 2 + s, s);
      ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    for (let i = 0; i < 400; i++) ctx.fillRect(Math.random() * s, Math.random() * s, 2, 2);
  },
  grate(ctx, s) {
    ctx.fillStyle = '#39424d'; ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = '#141a21';
    const n = 8, cell = s / n;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) ctx.fillRect(x * cell + 3, y * cell + 3, cell - 6, cell - 6);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.strokeRect(1, 1, s - 2, s - 2);
  },
  crate(ctx, s, r) {
    ctx.fillStyle = '#6e6a3f'; ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 6; i++) { ctx.fillStyle = `rgba(0,0,0,${0.08 + r() * 0.08})`; ctx.fillRect(0, (i * s) / 6, s, 2); }
    ctx.strokeStyle = '#3d3a22'; ctx.lineWidth = s * 0.07; ctx.strokeRect(s * 0.035, s * 0.035, s * 0.93, s * 0.93);
    ctx.beginPath(); ctx.moveTo(s * 0.07, s * 0.07); ctx.lineTo(s * 0.93, s * 0.93); ctx.stroke();
    speckle(ctx, s, r, 700, 0.2);
  },
  white(ctx, s, r) {
    ctx.fillStyle = '#d8dbd6'; ctx.fillRect(0, 0, s, s);
    stains(ctx, s, r, 10, 'rgba(90,90,80,0.12)');
    speckle(ctx, s, r, 1200, 0.1);
    ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fillRect(0, s - 3, s, 3);
  },
  belt(ctx, s, r) {
    // rubber belt with cross slats and yellow chevrons pointing along +V (canvas up)
    ctx.fillStyle = '#25282d'; ctx.fillRect(0, 0, s, s);
    speckle(ctx, s, r, 900, 0.25);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    for (let y = 0; y < s; y += s / 8) ctx.fillRect(0, y, s, 3);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    for (let y = 4; y < s; y += s / 8) ctx.fillRect(0, y, s, 2);
    ctx.strokeStyle = '#f0b429'; ctx.lineWidth = s * 0.07; ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
    for (const cy of [s * 0.3, s * 0.8]) {
      ctx.beginPath(); ctx.moveTo(s * 0.22, cy + s * 0.12); ctx.lineTo(s * 0.5, cy - s * 0.1); ctx.lineTo(s * 0.78, cy + s * 0.12); ctx.stroke();
    }
    ctx.fillStyle = '#111316'; ctx.fillRect(0, 0, s * 0.04, s); ctx.fillRect(s * 0.96, 0, s * 0.04, s);
  },
  launchPad(ctx, s) {
    ctx.fillStyle = '#1b2026'; ctx.fillRect(0, 0, s, s);
    const c = s / 2;
    for (let i = 5; i >= 1; i--) {
      ctx.strokeStyle = i % 2 ? '#ff9a2e' : '#ffd36b'; ctx.lineWidth = s * 0.028;
      ctx.beginPath(); ctx.arc(c, c, (i * s) / 12, 0, Math.PI * 2); ctx.stroke();
    }
    // arrow toward +V (the launch direction)
    ctx.fillStyle = '#fff4d6';
    ctx.beginPath(); ctx.moveTo(c, s * 0.12); ctx.lineTo(c + s * 0.13, s * 0.3); ctx.lineTo(c + s * 0.05, s * 0.3); ctx.lineTo(c + s * 0.05, s * 0.44);
    ctx.lineTo(c - s * 0.05, s * 0.44); ctx.lineTo(c - s * 0.05, s * 0.3); ctx.lineTo(c - s * 0.13, s * 0.3); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#e9b52a'; ctx.lineWidth = s * 0.05; ctx.strokeRect(s * 0.025, s * 0.025, s * 0.95, s * 0.95);
  },
  finish(ctx, s) {
    ctx.fillStyle = '#0c3a44'; ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = '#7ff6ff'; ctx.lineWidth = 6;
    for (let i = 1; i < 5; i++) { ctx.beginPath(); ctx.arc(s / 2, s / 2, (i * s) / 10, 0, Math.PI * 2); ctx.stroke(); }
    ctx.fillStyle = '#bffbff'; ctx.beginPath(); ctx.arc(s / 2, s / 2, s * 0.06, 0, Math.PI * 2); ctx.fill();
  },
};

/** Texture repeat size in metres per material. */
export const TEX_SCALE: Partial<Record<MatKey | 'crate', number>> = {
  concrete: 4, concreteDark: 5, metal: 2, steel: 2.5, rust: 3, hazard: 1.2, grate: 1.5, white: 3, trim: 2.5, tank: 4, glass: 4, pipe: 3, finish: 8,
};

export class Materials {
  private cache = new Map<string, THREE.Material>();
  readonly redLight: THREE.MeshBasicMaterial;
  readonly cyanLight: THREE.MeshBasicMaterial;
  readonly warmLight: THREE.MeshBasicMaterial;
  readonly glow: THREE.SpriteMaterial;
  readonly glowTex: THREE.Texture;
  private textures = new Map<string, THREE.Texture>();

  constructor() {
    this.redLight = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.25, 0.2), toneMapped: false });
    this.cyanLight = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.45, 2.2, 2.6), toneMapped: false });
    this.warmLight = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 1.8, 1.0), toneMapped: false });
    this.glowTex = makeGlowTexture();
    this.glow = new THREE.SpriteMaterial({ map: this.glowTex, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  }

  tex(key: string): THREE.Texture {
    let t = this.textures.get(key);
    if (!t) {
      const draw = TEX[key];
      t = canvasTex(key === 'hazard' || key === 'grate' ? 128 : 256, draw, key.length * 97);
      this.textures.set(key, t);
    }
    return t;
  }

  get(key: MatKey | 'crate'): THREE.Material {
    let m = this.cache.get(key);
    if (m) return m;
    m = this.create(key);
    this.cache.set(key, m);
    return m;
  }

  private std(map: string | null, color: number, rough: number, metal: number, extra: THREE.MeshStandardMaterialParameters = {}) {
    return new THREE.MeshStandardMaterial({
      map: map ? this.tex(map) : null, color, roughness: rough, metalness: metal, vertexColors: true, ...extra,
    });
  }

  private create(key: MatKey | 'crate'): THREE.Material {
    switch (key) {
      case 'concrete': return this.std('concrete', 0xffffff, 0.92, 0.02);
      case 'concreteDark': return this.std('concreteDark', 0xffffff, 0.95, 0.02);
      case 'metal': return this.std('metal', 0xffffff, 0.62, 0.45);
      case 'steel': return this.std('steel', 0xffffff, 0.55, 0.55);
      case 'trim': return this.std('steel', 0x8a96a6, 0.6, 0.5);
      case 'rust': return this.std('rust', 0xffffff, 0.85, 0.25);
      case 'hazard': return this.std('hazard', 0xffffff, 0.7, 0.1);
      case 'grate': return this.std('grate', 0xffffff, 0.6, 0.5);
      case 'white': return this.std('white', 0xffffff, 0.7, 0.1);
      case 'tank': return this.std('white', 0xb8c8c0, 0.6, 0.2);
      case 'pipe': return this.std('steel', 0x9aa6b0, 0.45, 0.6);
      case 'crate': return this.std('crate', 0xffffff, 0.9, 0.0);
      case 'glass': return this.std(null, 0x1b2d3a, 0.25, 0.6, { emissive: new THREE.Color(0x173848), emissiveIntensity: 0.9 });
      case 'lightWarm': return this.warmLight;
      case 'lightRed': return this.redLight;
      case 'lightCyan': return this.cyanLight;
      case 'finish': return new THREE.MeshBasicMaterial({ map: this.tex('finish'), color: new THREE.Color(1.6, 1.6, 1.6), toneMapped: false });
      case 'belt': return this.std('steel', 0x6b7580, 0.6, 0.5);
      case 'launch': return this.std('steel', 0x8a96a6, 0.5, 0.55);
      case 'invisible': return new THREE.MeshBasicMaterial({ visible: false });
    }
  }
}

function makeGlowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Power-up crates: a glowing, slowly turning crate with the power's icon, a
// light pillar that shows from afar, and a pop when someone takes it.

import * as THREE from 'three';
import type { LevelData, PowerKind } from '../../shared/level/types';

export const POWER_COLOR: Record<PowerKind, number> = { shield: 0x5ef0ff, cloak: 0xc38bff, boost: 0xffa640 };
export const POWER_CSS: Record<PowerKind, string> = { shield: '#5ef0ff', cloak: '#c38bff', boost: '#ffa640' };
export const POWER_NAME: Record<PowerKind, string> = { shield: 'Shield', cloak: 'Cloak', boost: 'Boost' };

interface CrateVis { root: THREE.Group; box: THREE.Mesh; pillar: THREE.Mesh; glow: THREE.Sprite; base: THREE.Vector3; taken: boolean; popT: number }

function iconTexture(kind: PowerKind): THREE.CanvasTexture {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  const col = `#${POWER_COLOR[kind].toString(16).padStart(6, '0')}`;
  ctx.fillStyle = '#10161f'; ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = col; ctx.lineWidth = 7; ctx.strokeRect(5, 5, s - 10, s - 10);
  ctx.fillStyle = col; ctx.strokeStyle = col; ctx.lineWidth = 8; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.beginPath();
  if (kind === 'shield') {
    ctx.moveTo(64, 24); ctx.lineTo(96, 36); ctx.lineTo(92, 72); ctx.quadraticCurveTo(84, 94, 64, 106); ctx.quadraticCurveTo(44, 94, 36, 72); ctx.lineTo(32, 36); ctx.closePath();
    ctx.globalAlpha = 0.35; ctx.fill(); ctx.globalAlpha = 1; ctx.stroke();
  } else if (kind === 'cloak') {
    ctx.moveTo(28, 64); ctx.quadraticCurveTo(64, 28, 100, 64); ctx.quadraticCurveTo(64, 100, 28, 64); ctx.stroke();
    ctx.beginPath(); ctx.arc(64, 64, 11, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(34, 96); ctx.lineTo(94, 32); ctx.stroke();
  } else {
    // boost: a fast-forward double chevron trailing speed lines
    for (const x of [58, 84]) { ctx.beginPath(); ctx.moveTo(x - 18, 36); ctx.lineTo(x + 8, 64); ctx.lineTo(x - 18, 92); ctx.stroke(); }
    ctx.lineWidth = 6;
    for (const [y, x0] of [[50, 24], [64, 16], [78, 24]]) { ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + 12, y); ctx.stroke(); }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class PickupView {
  readonly group = new THREE.Group();
  private crates: CrateVis[] = [];

  constructor(private level: LevelData, glowTex: THREE.Texture) {
    const boxGeo = new THREE.BoxGeometry(0.75, 0.75, 0.75);
    const pillarGeo = new THREE.CylinderGeometry(0.28, 0.5, 7, 12, 1, true);
    pillarGeo.translate(0, 3.5, 0);
    const mats = new Map<PowerKind, { box: THREE.Material; pillar: THREE.Material }>();
    for (const kind of ['shield', 'cloak', 'boost'] as PowerKind[]) {
      const col = new THREE.Color(POWER_COLOR[kind]);
      mats.set(kind, {
        box: new THREE.MeshStandardMaterial({ map: iconTexture(kind), emissive: col, emissiveIntensity: 0.55, emissiveMap: iconTexture(kind), roughness: 0.4, metalness: 0.3 }),
        pillar: new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
      });
    }
    for (const p of level.pickups) {
      const m = mats.get(p.kind)!;
      const root = new THREE.Group();
      root.position.set(p.p[0], p.p[1], p.p[2]);
      const box = new THREE.Mesh(boxGeo, m.box);
      box.position.y = 1.05;
      box.castShadow = true;
      const pillar = new THREE.Mesh(pillarGeo, m.pillar);
      pillar.renderOrder = 3;
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: POWER_COLOR[p.kind], transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.7 }));
      glow.position.y = 1.05;
      glow.scale.setScalar(2.6);
      root.add(box, pillar, glow);
      this.group.add(root);
      this.crates.push({ root, box, pillar, glow, base: root.position.clone(), taken: false, popT: 0 });
    }
  }

  /** Crate id -> world position of its centre. */
  centre(id: number, out: THREE.Vector3) {
    const p = this.level.pickups[id].p;
    return out.set(p[0], p[1] + 1.05, p[2]);
  }

  isTaken(id: number) { return this.crates[id]?.taken ?? true; }

  take(id: number) {
    const c = this.crates[id];
    if (!c || c.taken) return;
    c.taken = true;
    c.popT = 0.001;
  }

  /** Undo a predicted take that the server never confirmed. */
  restore(id: number) {
    const c = this.crates[id];
    if (!c) return;
    c.taken = false; c.popT = 0;
    c.root.visible = true;
    c.root.scale.setScalar(1);
  }

  reset() { for (let i = 0; i < this.crates.length; i++) this.restore(i); }

  update(t: number, dt: number) {
    for (let i = 0; i < this.crates.length; i++) {
      const c = this.crates[i];
      if (c.taken) {
        if (c.popT > 0) {
          c.popT += dt;
          const k = c.popT / 0.35;
          c.root.scale.setScalar(1 + k * 0.8);
          (c.glow.material as THREE.SpriteMaterial).opacity = 0.7 * (1 - k);
          if (k >= 1) { c.popT = 0; c.root.visible = false; }
        }
        continue;
      }
      c.box.rotation.y = t * 1.2 + i;
      c.box.rotation.x = Math.sin(t * 0.9 + i) * 0.25;
      c.box.position.y = 1.05 + Math.sin(t * 2 + i) * 0.12;
      c.glow.position.y = c.box.position.y;
      (c.glow.material as THREE.SpriteMaterial).opacity = 0.55 + Math.sin(t * 3 + i) * 0.15;
    }
  }
}

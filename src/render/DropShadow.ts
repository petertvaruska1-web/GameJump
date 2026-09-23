// A soft dark disc on the ground straight below a runner. The sun's shadow
// falls well off to one side (and not at all on the low preset), so mid-jump
// nothing showed where you were going to come down; this does, the way 3D
// platformers have always done it. It fades and tightens as you rise.

import * as THREE from 'three';
import type { CollisionWorld } from '../../shared/physics/world';

let tex: THREE.Texture | null = null;
function blobTexture(): THREE.Texture {
  if (tex) return tex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(0.45, 'rgba(0,0,0,0.75)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  tex = new THREE.CanvasTexture(c);
  return tex;
}

/** Heights (metres above the ground) over which the shadow fades out completely. */
const FADE_HEIGHT = 16;

export class DropShadow {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.MeshBasicMaterial;

  constructor() {
    this.mat = new THREE.MeshBasicMaterial({
      map: blobTexture(), transparent: true, depthWrite: false, opacity: 0.4,
      // sits a hair above the floor without fighting it
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
  }

  /** Follow a runner at `pos` (feet); hidden when `show` is false or nothing is below. */
  update(world: CollisionWorld, pos: THREE.Vector3, show: boolean) {
    if (!show) { this.mesh.visible = false; return; }
    const d = world.groundBelow(pos.x, pos.y + 0.3, pos.z, FADE_HEIGHT + 0.3);
    if (!isFinite(d)) { this.mesh.visible = false; return; }
    const h = Math.max(0, d - 0.3);
    const k = 1 - Math.min(1, h / FADE_HEIGHT);
    this.mesh.visible = k > 0.02;
    this.mesh.position.set(pos.x, pos.y + 0.3 - d + 0.03, pos.z);
    this.mesh.scale.setScalar(0.95 - 0.35 * (1 - k));
    this.mat.opacity = 0.42 * k;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}

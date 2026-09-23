// Builds the visual level from LevelData: static boxes merged per material and
// spatial chunk (few draw calls, frustum-cullable), plus individual meshes for
// movers, sweepers and crumbling slabs that follow the collision world.

import * as THREE from 'three';
import { CRUMBLE } from '../../shared/constants';
import type { BoxDef, LevelData, MatKey } from '../../shared/level/types';
import type { CollisionWorld } from '../../shared/physics/world';
import { GeoBuilder } from './geometry';
import { Materials, TEX_SCALE } from './Materials';

const CHUNK = 150;

interface CrumbleVis { mesh: THREE.Mesh; state: 'idle' | 'shake' | 'fall' | 'reset'; t0: number; vy: number; spin: THREE.Vector3 }

export class LevelView {
  readonly group = new THREE.Group();
  private dynamic = new Map<number, THREE.Mesh>();
  private crumbles = new Map<number, CrumbleVis>();
  onCrumbleDust?: (x: number, y: number, z: number, big: boolean) => void;

  constructor(level: LevelData, private mats: Materials, shadows: boolean) {
    const buckets = new Map<string, { mat: MatKey; b: GeoBuilder }>();
    for (const box of level.boxes) {
      if (!box.visible || box.mat === 'invisible') continue;
      if (box.kind !== 'static') { this.addDynamic(box, shadows); continue; }
      const cx = Math.floor(box.p[0] / CHUNK), cz = Math.floor(box.p[2] / CHUNK);
      const tall = box.s[1] > 30 ? 't' : '';
      const key = `${box.mat}|${cx}|${cz}|${tall}`;
      let bucket = buckets.get(key);
      if (!bucket) { bucket = { mat: box.mat, b: new GeoBuilder() }; buckets.set(key, bucket); }
      bucket.b.addBox(box, TEX_SCALE[box.mat] ?? 3);
    }
    for (const [key, { mat, b }] of buckets) {
      const mesh = new THREE.Mesh(b.build(), mats.get(mat));
      const emissive = mat === 'lightCyan' || mat === 'lightRed' || mat === 'lightWarm' || mat === 'finish' || mat === 'glass';
      const tall = key.endsWith('t');
      mesh.castShadow = shadows && !emissive && !tall;
      mesh.receiveShadow = shadows && !emissive;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.group.add(mesh);
    }
  }

  private addDynamic(box: BoxDef, shadows: boolean) {
    const b = new GeoBuilder();
    b.addBox({ ...box, p: [0, 0, 0] }, TEX_SCALE[box.mat] ?? 3, { local: true, shadeY: false, ao: false });
    const mesh = new THREE.Mesh(b.build(), this.mats.get(box.mat));
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    mesh.position.set(box.p[0], box.p[1], box.p[2]);
    mesh.rotation.y = box.ry;
    // hazard-edge trim on moving platforms reads better from a distance
    if (box.kind === 'mover') {
      const edge = new GeoBuilder();
      edge.addBox({ p: [0, 0, 0], s: [box.s[0] + 0.12, 0.18, box.s[2] + 0.12], ry: 0, tint: 1 }, 1.2, { local: true, shadeY: false, ao: false });
      const em = new THREE.Mesh(edge.build(), this.mats.get('hazard'));
      em.position.y = box.s[1] / 2 - 0.12;
      mesh.add(em);
    }
    this.group.add(mesh);
    this.dynamic.set(box.id, mesh);
    if (box.kind === 'crumble') {
      this.crumbles.set(box.id, { mesh, state: 'idle', t0: 0, vy: 0, spin: new THREE.Vector3() });
    }
  }

  crumbleEvent(id: number, s: 'shake' | 'fall' | 'reset', t: number) {
    const c = this.crumbles.get(id);
    if (!c) return;
    if (s === 'shake' && c.state !== 'idle') return;
    c.state = s;
    c.t0 = t;
    if (s === 'fall') {
      c.vy = 0;
      c.spin.set((Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 1.2);
      const p = c.mesh.position;
      this.onCrumbleDust?.(p.x, p.y, p.z, true);
    }
  }

  /** Local prediction: start shaking as soon as the local player lands. */
  predictShake(id: number, t: number) {
    const c = this.crumbles.get(id);
    if (c && c.state === 'idle') { c.state = 'shake'; c.t0 = t; }
  }

  resetAll() {
    for (const [id, c] of this.crumbles) { c.state = 'idle'; c.mesh.visible = true; this.placeStatic(id, c.mesh); }
  }

  private placeStatic(id: number, mesh: THREE.Mesh) {
    void id;
    const d = mesh.userData as { base?: THREE.Vector3 };
    if (d.base) mesh.position.copy(d.base);
    mesh.rotation.set(0, mesh.rotation.y, 0);
    (mesh.material as THREE.Material).opacity = 1;
  }

  update(world: CollisionWorld, t: number, dt: number) {
    for (const c of world.dynamics) {
      const m = this.dynamic.get(c.id);
      if (!m) continue;
      m.position.set(c.cx, c.cy, c.cz);
      m.rotation.y = c.ry;
    }
    for (const [id, c] of this.crumbles) {
      const col = world.get(id);
      const m = c.mesh;
      if (!m.userData.base) m.userData.base = m.position.clone();
      const base = m.userData.base as THREE.Vector3;
      switch (c.state) {
        case 'idle':
          m.visible = true;
          m.position.copy(base);
          m.rotation.x = 0; m.rotation.z = 0;
          break;
        case 'shake': {
          const k = Math.min(1, (t - c.t0) / CRUMBLE.SHAKE_TIME);
          const a = 0.015 + k * 0.07;
          m.position.set(base.x + (Math.random() - 0.5) * a, base.y + (Math.random() - 0.5) * a - k * 0.06, base.z + (Math.random() - 0.5) * a);
          m.rotation.x = (Math.random() - 0.5) * a * 0.4;
          m.rotation.z = (Math.random() - 0.5) * a * 0.4;
          if (Math.random() < dt * 14) this.onCrumbleDust?.(base.x + (Math.random() - 0.5) * 3, base.y - 0.3, base.z + (Math.random() - 0.5) * 3, false);
          break;
        }
        case 'fall': {
          c.vy -= 22 * dt;
          m.position.y += c.vy * dt;
          m.rotation.x += c.spin.x * dt;
          m.rotation.z += c.spin.z * dt;
          m.visible = m.position.y > base.y - 70;
          break;
        }
        case 'reset': {
          const k = Math.min(1, (t - c.t0) / 0.6);
          m.visible = true;
          m.rotation.x = 0; m.rotation.z = 0;
          m.position.set(base.x, base.y - (1 - k) * (1 - k) * 3, base.z);
          if (k >= 1) c.state = 'idle';
          break;
        }
      }
      if (col && !col.enabled && c.state === 'idle') c.state = 'fall';
    }
  }
}

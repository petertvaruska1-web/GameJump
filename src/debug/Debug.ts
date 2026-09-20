// Developer tools (only when running the dev build or with ?debug=1):
//  F3  overlay (FPS, position, section, enemy states, ping, players)
//  F4  free camera (WASD + mouse, Shift = fast, E/Q = up/down)
//  F6  enemy vision cones
//  F7  god mode (enemies cannot kill you)
//  F8  restart the match (host)
//  1-9,0 (with overlay open) teleport to section waypoints

import * as THREE from 'three';
import { ENEMY, type EnemyKind } from '../../shared/constants';
import type { LevelData } from '../../shared/level/types';

export class Debug {
  readonly allowed: boolean;
  overlay = false;
  cones = false;
  freeCam = false;
  private coneGroup = new THREE.Group();
  private coneLines = new Map<number, THREE.LineSegments>();
  private fpsFrames = 0;
  private fpsTime = 0;
  fps = 0;
  readonly camPos = new THREE.Vector3();
  camYaw = 0;
  camPitch = 0;

  constructor(scene: THREE.Scene, private level: LevelData) {
    const q = new URLSearchParams(location.search);
    this.allowed = import.meta.env.DEV || q.get('debug') === '1';
    scene.add(this.coneGroup);
    this.coneGroup.visible = false;
  }

  tick(dt: number) {
    this.fpsFrames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 0.5) { this.fps = this.fpsFrames / this.fpsTime; this.fpsFrames = 0; this.fpsTime = 0; }
  }

  toggle(code: string): boolean {
    if (!this.allowed) return false;
    if (code === 'F3') { this.overlay = !this.overlay; return true; }
    if (code === 'F6') { this.cones = !this.cones; this.coneGroup.visible = this.cones; return true; }
    return false;
  }

  zoneAt(x: number, z: number): string {
    let best = '—';
    let bestArea = Infinity;
    for (const zn of this.level.zones) {
      if (x >= zn.min[0] && x <= zn.max[0] && z >= zn.min[1] && z <= zn.max[1]) {
        const area = (zn.max[0] - zn.min[0]) * (zn.max[1] - zn.min[1]);
        if (area < bestArea) { bestArea = area; best = zn.name; }
      }
    }
    return best;
  }

  updateCone(id: number, kind: EnemyKind, pos: THREE.Vector3, yaw: number, hunting: boolean) {
    if (!this.cones) return;
    let l = this.coneLines.get(id);
    if (!l) {
      const t = ENEMY[kind];
      const pts: number[] = [];
      const half = (t.fovDeg * Math.PI) / 360;
      const n = 14;
      const eye = t.eyeHeight;
      for (let i = 0; i < n; i++) {
        const a0 = -half + (2 * half * i) / n, a1 = -half + (2 * half * (i + 1)) / n;
        pts.push(Math.sin(a0) * t.viewDist, eye, Math.cos(a0) * t.viewDist, Math.sin(a1) * t.viewDist, eye, Math.cos(a1) * t.viewDist);
      }
      pts.push(0, eye, 0, Math.sin(-half) * t.viewDist, eye, Math.cos(-half) * t.viewDist);
      pts.push(0, eye, 0, Math.sin(half) * t.viewDist, eye, Math.cos(half) * t.viewDist);
      for (let i = 0; i < 16; i++) {
        const a0 = (i / 16) * Math.PI * 2, a1 = ((i + 1) / 16) * Math.PI * 2;
        pts.push(Math.sin(a0) * t.senseDist, eye, Math.cos(a0) * t.senseDist, Math.sin(a1) * t.senseDist, eye, Math.cos(a1) * t.senseDist);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffff00, depthTest: false, transparent: true, opacity: 0.8, fog: false }));
      l.renderOrder = 30;
      this.coneGroup.add(l);
      this.coneLines.set(id, l);
    }
    l.position.copy(pos);
    l.rotation.y = yaw;
    (l.material as THREE.LineBasicMaterial).color.set(hunting ? 0xff3030 : 0xffff00);
  }
}

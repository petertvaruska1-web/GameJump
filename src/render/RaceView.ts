// Speedster Battle's course on screen: the road of light itself, drawn from the
// same samples the collision world is built from (shared/level/race.ts), so the
// floor you see is the floor you run on. The road is one mesh for the whole six
// kilometres (a few thousand vertices: cheaper than culling it in pieces), its
// glowing edge rails another, the kickers' lips and troughs part of the road.
//
// The client's copy of the course's collision world lives here too.

import * as THREE from 'three';
import type { RaceData } from '../../shared/level/race';
import { CollisionWorld } from '../../shared/physics/world';
import { HazardView } from './HazardView';
import type { Materials } from './Materials';

/** The air of the gap in spacetime: what the fog fades into, and how thick it is. */
export const RACE_FOG = new THREE.Color(0x0a0720);
export const RACE_FOG_DENSITY = 0.00085;

/** Right of a heading h (forward = (sin h, cos h)). */
const rightX = (h: number) => Math.cos(h);
const rightZ = (h: number) => -Math.sin(h);

export class RaceView {
  readonly group = new THREE.Group();
  readonly world: CollisionWorld;
  /** The course has no lasers or anchors; this keeps the grapple UI's calls harmless. */
  readonly hazards: HazardView;
  private readonly road: THREE.Mesh;
  private readonly rails: THREE.Mesh;

  constructor(readonly data: RaceData, mats: Materials, _glowTex: THREE.Texture, shadows: boolean) {
    this.world = new CollisionWorld(data.level);
    this.hazards = new HazardView(data.level, mats);
    this.group.add(this.hazards.group);
    this.group.visible = false;
    this.road = new THREE.Mesh(this.roadGeometry(), new THREE.MeshStandardMaterial({ color: 0x141a2e, roughness: 0.35, metalness: 0.4, envMapIntensity: 0.4 }));
    this.road.receiveShadow = shadows;
    this.road.frustumCulled = false;
    this.group.add(this.road);
    this.rails = new THREE.Mesh(this.railGeometry(), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 1.4, 1.8), toneMapped: false, side: THREE.DoubleSide }));
    this.rails.frustumCulled = false;
    this.group.add(this.rails);
  }

  /**
   * The road: its top (uv.x across 0..1, uv.y the distance along it in metres),
   * a skirt down each side and an underside, with a kicker's lip as a step down.
   */
  private roadGeometry(): THREE.BufferGeometry {
    const S = this.data.track.samples;
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    const TH = 1.4;
    // four rails of vertices along the course: top-left, top-right, bottom-right, bottom-left
    const ring = (x: number, y: number, z: number, h: number, w: number, s: number) => {
      const rx = rightX(h) * w / 2, rz = rightZ(h) * w / 2;
      const b = pos.length / 3;
      pos.push(x - rx, y, z - rz, x + rx, y, z + rz, x + rx, y - TH, z + rz, x - rx, y - TH, z - rz);
      uv.push(0, s, 1, s, 1, s, 0, s);
      return b;
    };
    let prev = -1;
    for (const q of S) {
      const a = ring(q.x, q.y, q.z, q.h, q.w, q.s);
      if (prev >= 0) {
        for (let k = 0; k < 4; k++) {
          const k2 = (k + 1) % 4;
          idx.push(prev + k, a + k, prev + k2, prev + k2, a + k, a + k2);
        }
      }
      prev = a;
      // the lip of a kicker: the road steps down to the trough right here
      if (q.drop !== undefined) prev = ring(q.x, q.drop, q.z, q.h, q.w, q.s);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  /** A low band of light along each edge of the road, where the barrier stands. */
  private railGeometry(): THREE.BufferGeometry {
    const S = this.data.track.samples;
    const pos: number[] = [], idx: number[] = [];
    const H = 0.35;
    for (const side of [-1, 1]) {
      let prev = -1;
      for (const q of S) {
        const o = q.w / 2 - 0.05;
        const x = q.x + rightX(q.h) * o * side, z = q.z + rightZ(q.h) * o * side;
        const b = pos.length / 3;
        pos.push(x, q.y, z, x, q.y + H, z);
        if (prev >= 0) idx.push(prev, b, prev + 1, prev + 1, b, b + 1);
        prev = b;
        if (q.drop !== undefined) {
          const c = pos.length / 3;
          pos.push(x, q.drop, z, x, q.drop + H, z);
          prev = c;
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    return g;
  }

  update(_time: number, _dt: number, _camPos: THREE.Vector3, _mt: number) { /* the vista animates here (next pass) */ }
}

// Measures jump reach with the real controller so level gaps can be tuned.
// Usage: npm run sim:jumps
import { PHYS, PLAYER } from '../shared/constants';
import type { LevelData } from '../shared/level/types';
import { PlayerMotor, type MoveInput } from '../shared/physics/character';
import { CollisionWorld } from '../shared/physics/world';

const level: LevelData = {
  name: 'sim', props: [], enemies: [], winds: [], zones: [], spawns: [], spawnYaw: 0,
  finish: { min: [0, 0, 0], max: [0, 0, 0] }, beacon: [0, 0, 0], killY: -100,
  bounds: { min: [-20, -80], max: [20, 80] }, waypoints: [], ziplines: [], lasers: [], hints: [], grapples: [], pickups: [],
  boxes: [{ id: 0, p: [0, -0.5, -30], s: [10, 1, 60], ry: 0, mat: 'concrete', kind: 'static', solid: true, visible: true, blocksSight: true }],
};

function run(sprint: boolean, jumpAtZ: number) {
  const world = new CollisionWorld(level);
  const m = new PlayerMotor();
  m.spawn(0, 0, -40, 0);
  const inp: MoveInput = { x: 0, z: 1, sprint, jumpHeld: false, jumpPressed: false };
  let t = 0, jumped = false, maxY = 0, prevY = 0;
  const cross: Record<string, number> = {};
  const levels = [1.4, 1.0, 0.5, 0, -1, -2, -4, -8];
  while (t < 12) {
    const b = m.body;
    inp.jumpPressed = false;
    if (!jumped && b.pos.z >= jumpAtZ) { inp.jumpPressed = true; inp.jumpHeld = true; jumped = true; }
    m.step(world, PHYS.STEP, inp);
    t += PHYS.STEP;
    maxY = Math.max(maxY, b.pos.y);
    if (jumped && b.vel.y < 0) {
      for (const L of levels) {
        const key = String(L);
        if (cross[key] === undefined && prevY > L && b.pos.y <= L) cross[key] = b.pos.z;
      }
    }
    prevY = b.pos.y;
    if (b.pos.y < -9) break;
  }
  return { maxY, cross };
}

for (const sprint of [false, true]) {
  const speed = sprint ? PLAYER.SPRINT_SPEED : PLAYER.RUN_SPEED;
  for (const jz of [0, 0.24, 0.6]) {
    const r = run(sprint, jz);
    // Landing needs the ground circle (r*0.72) to overlap the far platform: centre within gr of the edge.
    const gr = PLAYER.RADIUS * PLAYER.GROUND_RADIUS_FACTOR;
    const s = Object.entries(r.cross).map(([k, z]) => `dy=${k}: gap<=${(z + gr).toFixed(2)}`).join('  ');
    console.log(`${sprint ? 'SPRINT' : 'RUN   '} ${speed} jumpAt=${jz} apex=${r.maxY.toFixed(2)} | ${s}`);
  }
}

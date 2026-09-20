// Balance check: can a player outrun a Stalker, and how often does a Sentinel hit?
// Usage: npx tsx scripts/sim-enemy-balance.ts
import { ENEMY, PLAYER, RANGED } from '../shared/constants';
import type { LevelData } from '../shared/level/types';
import { v3, type Vec3 } from '../shared/math';
import { CollisionWorld } from '../shared/physics/world';
import { EState } from '../shared/protocol';
import { Enemy, type EnemyHost, type Target } from '../shared/sim/enemy';

const level: LevelData = {
  name: 'flat', props: [], enemies: [], winds: [], zones: [], spawns: [], spawnYaw: 0,
  finish: { min: [0, 0, 0], max: [0, 0, 0] }, beacon: [0, 0, 0], killY: -100,
  bounds: { min: [-120, -120], max: [120, 400] }, waypoints: [], ziplines: [], lasers: [], hints: [], grapples: [], pickups: [],
  boxes: [{ id: 0, p: [0, -1, 140], s: [200, 2, 520], ry: 0, mat: 'concrete', kind: 'static', solid: true, visible: true, blocksSight: true }],
};
const world = new CollisionWorld(level);

function chase(playerSpeed: number): string {
  const target: Target = { id: 1, pos: v3(0, 0, 6), vel: v3(0, 0, playerSpeed), targetable: true };
  const e = new Enemy({ id: 0, kind: 'melee', p: [0, 0, 0], yaw: 0, leash: 400 });
  let killed = false;
  const host: EnemyHost = { world, time: 0, targets: [target], kill: () => { killed = true; }, fire: () => {}, emit: () => {} };
  let minGap = Infinity;
  const dt = 1 / 30;
  for (let t = 0; t < 12 && !killed; t += dt) {
    host.time = t;
    target.pos.z += playerSpeed * dt;
    e.update(dt, host);
    if (e.state === EState.Chase) minGap = Math.min(minGap, target.pos.z - e.pos.z);
  }
  const gap = target.pos.z - e.pos.z;
  return `player ${playerSpeed.toFixed(1)} m/s vs stalker ${ENEMY.melee.speed.toFixed(2)}: ${killed ? 'CAUGHT' : `escaped, gap after 12 s = ${gap.toFixed(1)} m`} (closest ${minGap === Infinity ? '-' : minGap.toFixed(1) + ' m'})`;
}

function hitRate(dist: number, lateralSpeed: number, shots = 4000): number {
  let hits = 0;
  for (let i = 0; i < shots; i++) {
    const tpos = v3(0, 0, dist);
    const target: Target = { id: 1, pos: tpos, vel: v3(lateralSpeed, 0, 0), targetable: true };
    const e = new Enemy({ id: 0, kind: 'ranged', p: [0, 0, 0], yaw: 0 });
    let origin: Vec3 = v3(), vel: Vec3 = v3();
    const host: EnemyHost = { world, time: 0, targets: [target], kill: () => {}, fire: (_e, o, v) => { origin = v3(o.x, o.y, o.z); vel = v; }, emit: () => {} };
    (e as unknown as { shoot(t: Target, h: EnemyHost): void }).shoot(target, host);
    // step projectile and moving target together
    const r = RANGED.PROJECTILE_RADIUS + PLAYER.RADIUS + 0.05;
    const p = v3(origin.x, origin.y, origin.z);
    for (let t = 0; t < 4; t += 1 / 240) {
      p.x += vel.x / 240; p.y += vel.y / 240; p.z += vel.z / 240;
      tpos.x += lateralSpeed / 240;
      const cy = Math.min(Math.max(p.y, tpos.y + 0.35), tpos.y + 1.45);
      if (Math.hypot(p.x - tpos.x, p.y - cy, p.z - tpos.z) < r) { hits++; break; }
      if (p.z > dist + 5) break;
    }
  }
  return hits / shots;
}

console.log('--- Stalker pursuit (straight line, 6 m head start) ---');
console.log(chase(PLAYER.SPRINT_SPEED));
console.log(chase(PLAYER.RUN_SPEED));
console.log(`--- Sentinel hit chance per shot (spread ${RANGED.SPREAD}, lead ${RANGED.LEAD}) ---`);
for (const d of [15, 30, 45]) {
  console.log(`  ${d} m: standing ${(hitRate(d, 0) * 100).toFixed(0)}%   running across ${(hitRate(d, PLAYER.RUN_SPEED) * 100).toFixed(0)}%   sprinting across ${(hitRate(d, PLAYER.SPRINT_SPEED) * 100).toFixed(0)}%`);
}

// --- aim tuning grid: hit chance by movement direction (angle of travel relative to the line of fire)
function hitRateDir(dist: number, speed: number, dirDeg: number, shots = 2500): number {
  let hits = 0;
  const a = (dirDeg * Math.PI) / 180;
  const vx = Math.sin(a) * speed, vz = -Math.cos(a) * speed; // 0deg = running straight at the sentinel
  for (let i = 0; i < shots; i++) {
    const tpos = v3(0, 0, dist);
    const target: Target = { id: 1, pos: tpos, vel: v3(vx, 0, vz), targetable: true };
    const e = new Enemy({ id: 0, kind: 'ranged', p: [0, 0, 0], yaw: 0 });
    let origin: Vec3 = v3(), vel: Vec3 = v3();
    const host: EnemyHost = { world, time: 0, targets: [target], kill: () => {}, fire: (_e, o, v) => { origin = v3(o.x, o.y, o.z); vel = v; }, emit: () => {} };
    (e as unknown as { shoot(t: Target, h: EnemyHost): void }).shoot(target, host);
    const r = RANGED.PROJECTILE_RADIUS + PLAYER.RADIUS + 0.05;
    const p = v3(origin.x, origin.y, origin.z);
    for (let t = 0; t < 4; t += 1 / 240) {
      p.x += vel.x / 240; p.y += vel.y / 240; p.z += vel.z / 240;
      tpos.x += vx / 240; tpos.z += vz / 240;
      const cy = Math.min(Math.max(p.y, tpos.y + 0.35), tpos.y + 1.45);
      if (Math.hypot(p.x - tpos.x, p.y - cy, p.z - tpos.z) < r) { hits++; break; }
      if (p.z > dist + 8) break;
    }
  }
  return hits / shots;
}
if (process.env.GRID) {
  const configs: [string, number, number, number][] = [['OLD  lead .45 spread 0', 0.45, 0, 0], ['lead .3  spread .075', 0.3, 0.075, 0.007], ['lead .7  spread .075', 0.7, 0.075, 0.007], ['lead 1.0 spread .075', 1.0, 0.075, 0.007]];
  for (const [name, lead, sp, sps] of configs) {
    (RANGED as { LEAD: number }).LEAD = lead; (RANGED as { SPREAD: number }).SPREAD = sp; (RANGED as { SPREAD_PER_SPEED: number }).SPREAD_PER_SPEED = sps;
    const row = [0, 45, 90].map((deg) => `${deg}deg ${(hitRateDir(30, PLAYER.SPRINT_SPEED, deg) * 100).toFixed(0).padStart(3)}%`).join('  ');
    console.log(`${name.padEnd(24)} 30m sprinting: ${row}   standing ${(hitRateDir(30, 0, 0) * 100).toFixed(0)}%`);
  }
}

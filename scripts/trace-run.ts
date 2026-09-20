// Traces a straight sprint (no jumping) from a start point to debug collisions.
import { PHYS } from '../shared/constants';
import { getLevel } from '../shared/level/map/index';
import { PlayerMotor } from '../shared/physics/character';
import { CollisionWorld } from '../shared/physics/world';
const [sx, sy, sz, secs] = (process.argv[2] ?? '0,40.05,-5.6,3').split(',').map(Number);
const level = getLevel();
const world = new CollisionWorld(level);
const m = new PlayerMotor();
m.spawn(sx, sy, sz, 0);
let t = 0, n = 0;
while (t < secs) {
  world.update(t);
  m.step(world, PHYS.STEP, { x: 0, z: 1, sprint: true, jumpHeld: false, jumpPressed: false });
  t += PHYS.STEP;
  if (n++ % 6 === 0 || m.events.mantled) {
    const b = m.body, g = b.ground;
    console.log(t.toFixed(2), b.pos.x.toFixed(2), b.pos.y.toFixed(2), b.pos.z.toFixed(2), b.grounded ? `G#${g?.id} ${g?.def.tag}/${g?.def.mat}/${g?.kind} top=${g?.top.toFixed(2)}` : 'air', m.events.mantled ? 'MANTLE' : '', m.mantleActive ? 'm' : '');
  }
}

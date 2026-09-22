// Headless AI check: drops a stationary "player" in front of each enemy type and
// verifies ALERT -> CHASE -> kill, and that hiding behind cover breaks pursuit.
import { getLevel } from '../shared/level/map/index';
import type { S2C } from '../shared/protocol';
import { Room } from '../shared/sim/room';

const level = getLevel();
let now = 0;
const clock = () => now;

function scenario(name: string, place: [number, number, number], seconds: number, move?: (t: number) => [number, number, number] | null) {
  const room = new Room('TEST', level, clock, true);
  const log: string[] = [];
  const conn = {
    send(m: S2C) {
      if (m.t === 'ev') for (const e of m.e) log.push(`${now.toFixed(2)} ${JSON.stringify(e)}`);
    },
    close() {},
  };
  const p = room.join(conn, 'bot');
  if (typeof p === 'string') throw new Error(p);
  room.handle(p, { t: 'start' });
  now += 3.6;
  room.tick(1 / 30);
  room.handle(p, { t: 'dbg', cmd: 'tp', p: place });
  const dt = 1 / 30;
  for (let t = 0; t < seconds; t += dt) {
    now += dt;
    const target = move ? move(t) : place;
    if (target) {
      p.pos.x = target[0]; p.pos.y = target[1]; p.pos.z = target[2];
      p.lastSupportY = target[1];
    }
    room.tick(dt);
    if (p.status !== 0) break;
  }
  console.log(`--- ${name}: status=${['alive', 'dead', 'finished', 'left'][p.status]} cause=${p.cause ?? '-'}`);
  for (const l of log.filter((l) => !l.includes('"crumble"')).slice(0, 8)) console.log('   ', l);
}

// Plaza stalker (paces x=-12.8..-5.6 at z~84); stand on the plaza facing it.
scenario('melee (plaza stalker)', [-4, 36.05, 80], 12);
// Viaduct sentinels look down the deck from z=318.
scenario('ranged (viaduct sentinels)', [0, 39.55, 290], 10);
// Gantry drone hovers above the deck at z~160.
scenario('flyer (gantry drone)', [2, 38.05, 158], 12);
// Hide: stand exposed on the plaza, then step behind the container and keep still.
scenario('ranged plaza sentinel vs cover', [-2, 36.05, 70], 14, (t) => (t < 0.8 ? [-2, 36.05, 70] : [-12.5, 36.05, 78.5]));

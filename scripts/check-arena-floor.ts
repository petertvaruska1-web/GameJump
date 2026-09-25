// The arena's floor ends where it is drawn: solid out to the disc's edge all the
// way round, open air over the moat and under the rampart (where an old build of
// the floor left an invisible one). Usage: npx tsx scripts/check-arena-floor.ts
import { ARENA } from '../shared/constants';
import { ANVIL, getArena } from '../shared/level/arena';
import { CollisionWorld } from '../shared/physics/world';

const w = new CollisionWorld(getArena().level);
let fails = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) fails++;
}

/** Is there floor at floor height under (r, phi)? */
function floorAt(phi: number, r: number): boolean {
  const x = ARENA.x + Math.sin(phi) * r, z = ARENA.z + Math.cos(phi) * r;
  const g = w.groundBelow(x, ARENA.y + 0.5, z, 1.5);
  return isFinite(g) && Math.abs(ARENA.y + 0.5 - g - ARENA.y) < 0.05;
}

// the ramps cross the moat on purpose
const nearRamp = (phi: number) => ANVIL.RAMPS.some((a) => Math.abs(Math.atan2(Math.sin(phi - a), Math.cos(phi - a))) < 0.25);
let inner = Infinity, outer = 0;
for (let i = 0; i < 1440; i++) {
  const phi = (i / 1440) * Math.PI * 2;
  if (nearRamp(phi)) continue;
  // from well inside the rim outwards: the last solid radius
  let last = 0;
  for (let r = 25; r < 34; r += 0.01) if (floorAt(phi, r)) last = r;
  inner = Math.min(inner, last); outer = Math.max(outer, last);
}
check('the floor reaches its drawn edge all the way round', inner >= ANVIL.FLOOR_R - 0.02, `solid to at least ${inner.toFixed(2)} m (edge ${ANVIL.FLOOR_R} m)`);
check('and nothing solid past the drawn disc', outer <= ANVIL.FLOOR_R + 0.6, `solid to at most ${outer.toFixed(2)} m (disc drawn to ${ANVIL.FLOOR_R + 0.6} m)`);

// over the moat and under the rampart: a runner there falls
let found = 0, probes = 0;
for (let i = 0; i < 720; i++) {
  const phi = (i / 720) * Math.PI * 2;
  if (nearRamp(phi)) continue;
  for (const r of [31, 32.5, 34, 37, 40, 43]) {
    probes++;
    const x = ARENA.x + Math.sin(phi) * r, z = ARENA.z + Math.cos(phi) * r;
    if (isFinite(w.groundBelow(x, ARENA.y + 2, z, 6))) found++;
  }
}
check('open air below the rampart and over the moat', found === 0, `${found} of ${probes} probes found something to stand on`);
console.log(fails ? `${fails} check(s) failed` : 'arena floor checks passed');
process.exit(fails ? 1 : 0);

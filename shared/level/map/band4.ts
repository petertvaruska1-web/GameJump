// Late band between the collapsed viaduct / hangar / antenna array and the
// reactor ring. One section per route, each ending exactly at the ring.
//   centre: Cable Yards      — suspended yards, lateral mover, sentinels covering open spans
//   left:   Cooling Works    — two big interiors (cooling hall, pump station), stalkers, cover
//   right:  Wrecked Skybridge — long broken bridge with sprint gaps, drones, a sentinel

import type { Cursor, LevelBuilder } from '../builder';
import { RING, RING_OUTER } from './layout';

const PI = Math.PI;

export function buildCableYards(b: LevelBuilder, start: Cursor): Cursor {
  b.section('Cable Yards');
  const z0 = start.z;
  let c = b.chain(start, [
    { t: 'plat', gap: 3, len: 8, w: 5, mat: 'metal', hazard: 'ns' },
    { t: 'plat', gap: 3.5, dy: 1, len: 6, w: 5, mat: 'metal', hazard: 's' },
    { t: 'stairs', len: 6, w: 4, dy: 2 },
    // 10 cm off the yard and onto the gap to the mover, which stays where it was: the one
    // mover late in the centre route now punishes a clearly early jump (it forgave one as
    // early as the left route's easy movers do) without asking what the right route asks
    { t: 'plat', len: 9.9, w: 10, mat: 'concrete', hazard: 'n' },
    { t: 'mover', gap: 2.3, len: 5.3, w: 5, move: [0, 0, 10], period: 7 },
    { t: 'skip', len: 10 },
    { t: 'plat', gap: 2.5, len: 8, w: 8, mat: 'concrete', hazard: 's' },
    { t: 'beam', len: 16, w: 0.9 },
    { t: 'plat', len: 6, w: 6, mat: 'metal' },
    { t: 'crumble', gap: 2, len: 4, w: 4 },
    { t: 'crumble', gap: 2, len: 4, w: 4 },
    { t: 'plat', gap: 2.5, dy: 1, len: 10, w: 10, mat: 'concrete', hazard: 's' },
    { t: 'plat', len: 22, w: 4, rails: 'ew', mat: 'metal', hazard: '' },
  ]);
  // security gate at the start of the railed walkway
  const walkZ0 = c.z - 22, walkY = c.y;
  b.laserGate(-2, walkZ0 + 0.4, 2, walkZ0 + 0.4, walkY, { cycle: 3, duty: 0.5, phase: 0.3 });
  b.hint('laser', 0, walkY, walkZ0 - 4, 5, 'Lasers kill on contact. Wait for a gate to switch off (it flickers first), jump the low beams.');
  // the deck beyond is gone: climb to the cable tower and ride the zip line across
  c = b.chain(c, [
    { t: 'stairs', len: 5, w: 3, dy: 3 },
    { t: 'plat', len: 4, w: 4.5, mat: 'metal', hazard: 'n' },
  ]);
  const towerEnd = c.z, towerY = c.y;
  c = b.chain(c, [
    { t: 'skip', len: 23, dy: -3 },
    { t: 'plat', len: 12, w: 10, mat: 'concrete', hazard: '' },
  ]);
  b.zipline([0, towerY + 3.1, towerEnd - 2.6], [0, walkY + 2.65, towerEnd + 25.5], { postA: towerY, postB: walkY });
  b.hint('zip', 0, towerY, towerEnd - 2, 4, 'Zip line: jump into the cable to grab it. Space lets go early.');
  b.tower(0, towerEnd - 2, towerY - 0.2, 3.2, { light: false, mat: 'concreteDark' });
  const yardD = c.z - 6, yardY = c.y;
  const edge = RING.z - RING_OUTER;
  c = b.chain(c, [
    { t: 'plat', gap: 3, len: 6, w: 5, mat: 'metal', hazard: 'ns' },
    { t: 'stairs', len: edge - (c.z + 9), w: 4, dy: RING.y - c.y },
  ]);
  // yard A (z0+22..32), yard B (z0+56.5..64.5), yard C (z0+101..111)
  const yA = z0 + 31.5, yB = z0 + 60.5, yC = z0 + 106;
  b.container(-2.8, 42.5, yA + 1, 0.05);
  b.crate(3, 42.5, yA - 2.5, 1.3);
  b.crate(3.8, 42.5, yA - 1.2, 1.0, 0.4);
  b.block(2.5, 42.5, yB + 1, 1.6, 3.2, 1.6, 'concreteDark');
  b.container(1.8, 43.5, yC + 1.5, PI / 2);
  b.block(-3, 43.5, yC - 3, 1.6, 3.4, 1.6, 'concreteDark');
  b.container(-2.6, yardY, yardD + 1, 0.08);
  b.block(3, yardY, yardD - 2, 1.6, 3, 1.6, 'concreteDark');
  b.crate(3.2, yardY, yardD + 3.5, 1.2);
  // suspension pylons + cables (the yards hang over the void)
  for (const [px, pz] of [[6.5, yA], [-6.5, yA], [5.5, yB], [-5.5, yB], [6.5, yC], [-6.5, yC], [6.5, yardD], [-6.5, yardD]]) {
    b.tower(px, pz, 62, 0.8, { light: pz === yA || pz === yardD });
    b.prop('cable', [px, 61, pz], { q: [px * 0.7, 44.5, pz - 4] });
    b.prop('cable', [px, 61, pz], { q: [px * 0.7, 44.5, pz + 4] });
  }
  for (const zz of [yA - 4, yB, yC + 4, yardD - 5]) b.prop('lamp', [3.4, zz > yC ? 43.5 : 42.5, zz]);
  // drone over the beam and the crumbling slabs
  b.enemy('flyer', 0, 50, z0 + 86, 0, { patrol: [[-4, 49, z0 + 70], [4, 50, z0 + 84], [-3, 51, z0 + 96], [3, 49, z0 + 80]], leash: 40 });
  // sentinel at the far end of the long span
  b.tower(-8.5, z0 + 145, 51, 2, { light: true });
  b.plat(-8.5, 52, z0 + 145, 3.6, 3.6, { mat: 'metal', hazard: 'nsew', supports: false });
  b.enemy('ranged', -8.5, 52, z0 + 145, PI - 0.3);
  b.zone('Cable Yards', -8, z0, 8, edge);
  b.waypoint('Cable Yards', 0, 42.6, yA - 3);
  return c;
}

export function buildCoolingWorks(b: LevelBuilder, start: Cursor, x: number): Cursor {
  b.section('Cooling Works');
  // chain() advances the cursor it is given, so the entry has to be read now:
  // by the end of this function `start` has walked all the way to the ring.
  const z0 = start.z;
  let c = b.chain(start, [{ t: 'plat', gap: 2.5, len: 20, w: 4, rails: 'e', mat: 'metal', hazard: '' }]);
  for (let zz = c.z - 16; zz < c.z - 2; zz += 9) {
    b.block(x - 1.2, c.y, zz, 1.2, 0.8, 2.6, 'concrete');
    b.prop('debris', [x - 1.2, c.y + 0.8, zz], { v: 1 });
  }
  // cooling hall (big interior)
  const y1 = c.y;
  const hz = c.z + 15;
  b.building(x, y1, hz, 20, 30, 12, {
    doors: [{ side: 's', width: 4, height: 5 }, { side: 'n', width: 4, height: 5 }],
    mat: 'concreteDark',
  });
  b.prop('chimney', [x, y1 + 12.5, hz], { s: [5, 16, 5] });
  b.prop('tank', [x - 5, y1, hz - 6], { s: [2.6, 7, 2.6] });
  b.block(x - 5, y1, hz - 6, 4.6, 7, 4.6, 'invisible', 0, { visible: false, sight: true });
  b.prop('tank', [x + 5, y1, hz + 5], { s: [2.6, 7, 2.6] });
  b.block(x + 5, y1, hz + 5, 4.6, 7, 4.6, 'invisible', 0, { visible: false, sight: true });
  b.block(x + 5.5, y1, hz - 8, 3, 2.2, 5, 'steel');
  b.block(x - 5.5, y1, hz + 8, 3, 1.0, 6, 'steel');
  b.crate(x + 2.5, y1, hz + 11, 1.2);
  b.prop('lamp', [x - 2.8, y1, hz - 2.2]);
  b.prop('lamp', [x + 2.8, y1, hz + 9]);
  // stalker walking the open west half of the hall, clear of the cooling tanks
  b.enemy('melee', x - 8.25, y1, hz, 0, {
    patrol: [[x - 8.25, y1, hz], [x, y1, hz], [x - 1, y1, hz + 12.5], [x - 8.25, y1, hz + 12.5]], leash: 28,
  });
  c = b.cursor(x, y1, hz + 15, 0);
  c = b.chain(c, [{ t: 'plat', len: 6, w: 6, mat: 'concrete', hazard: 'n' }]);
  b.pipeWalk(x, c.z, y1, x, c.z + 14, y1, 0.75);
  b.prop('pipe', [x + 3.5, y1 - 2.4, c.z - 3], { q: [x + 3.5, y1 - 2.4, c.z + 20], s: [1.0, 1.0, 1.0] });
  c.z += 14;
  c = b.chain(c, [
    { t: 'plat', len: 6, w: 6, mat: 'concrete' },
    { t: 'stairs', len: 6, w: 3, dy: RING.y - y1 },
    { t: 'plat', len: 24, w: 3, rails: 'ew', mat: 'grate', hazard: '', supports: false, th: 0.4 },
  ]);
  for (const zz of [c.z - 20, c.z - 6]) {
    b.tower(x + 5, zz, RING.y + 12, 0.7, { light: zz < c.z - 10 });
    b.prop('cable', [x + 5, RING.y + 12, zz], { q: [x + 1.6, RING.y + 0.6, zz - 2] });
    b.prop('cable', [x + 5, RING.y + 12, zz], { q: [x + 1.6, RING.y + 0.6, zz + 2] });
  }
  // pump station (second interior, with a stalker)
  const y2 = c.y;
  const pz = c.z + 14;
  b.building(x, y2, pz, 24, 28, 8, {
    doors: [{ side: 's', width: 3.2, height: 3.5 }, { side: 'n', width: 3.2, height: 3.5 }],
    mat: 'rust',
  });
  b.block(x - 6, y2, pz - 4, 5, 3, 5, 'steel');
  b.block(x + 6, y2, pz + 3, 5, 3, 7, 'steel');
  b.block(x - 1.5, y2, pz + 8, 6, 1.0, 1.6, 'metal');
  b.crate(x + 8.5, y2, pz - 10, 1.3);
  b.prop('lamp', [x + 2.5, y2, pz - 6]);
  b.prop('redLight', [x - 6, y2 + 3.2, pz - 4]);
  b.enemy('melee', x + 10, y2, pz - 4, PI, { patrol: [[x + 10, y2, pz - 4], [x + 10, y2, pz + 10]], leash: 26 });
  // the exit is laser-locked on a cycle: time it with the stalker behind you
  b.laserGate(x - 1.6, pz + 13.75, x + 1.6, pz + 13.75, y2, { cycle: 3.6, duty: 0.5, phase: 0.1, posts: false });
  b.prop('redLight', [x, y2 + 3.8, pz + 13.4]);
  // outer terraces to the ring
  c = b.cursor(x, y2, pz + 14, 0);
  const cornerZ0 = RING.z - 3;
  c = b.chain(c, [
    { t: 'plat', len: 10, w: 10, mat: 'concrete', hazard: '' },
    { t: 'plat', gap: 2.5, len: 12, w: 5, mat: 'concrete' },
    { t: 'plat', gap: 2.5, len: 12, w: 5, off: -1.5, mat: 'concrete' },
  ]);
  c = b.chain(c, [
    { t: 'plat', gap: 2.5, len: cornerZ0 - (c.z + 2.5), w: 4, rails: 'e', mat: 'metal', hazard: '' },
    { t: 'corner', size: 6, turn: -PI / 2, mat: 'concrete' },
  ]);
  const ringEdge = RING.x + RING_OUTER;
  c = b.chain(c, [
    { t: 'plat', len: c.x - ringEdge - 5, w: 4, rails: 'ew', mat: 'metal', hazard: '' },
    { t: 'plat', gap: 2.5, len: 2.5, w: 4, mat: 'metal', hazard: '' },
  ]);
  for (let zz = cornerZ0 - 32; zz < cornerZ0 - 6; zz += 11) b.block(x + 1.3, y2, zz, 0.4, 2.3, 3.2, 'concreteDark');
  // the mast east of the outer terraces stands empty since the works were abandoned
  b.tower(x + 12, cornerZ0 - 32, RING.y + 8, 2, { light: true });
  b.plat(x + 12, RING.y + 9, cornerZ0 - 32, 3.6, 3.6, { mat: 'metal', hazard: 'nsew', supports: false });
  b.zone('Cooling Works', x - 12, z0, x + 12, RING.z + 3);
  b.waypoint('Cooling Works', x, y1 + 0.1, hz - 18);
  return c;
}

export function buildSkybridge(b: LevelBuilder, start: Cursor): Cursor {
  b.section('Wrecked Skybridge');
  const z0 = start.z;
  const x = start.x;
  const sy0 = start.y;
  const c = b.chain(start, [
    { t: 'plat', gap: 2, len: 8, w: 6, mat: 'metal', hazard: 'n' },
    { t: 'plat', len: 12, w: 3, rails: 'w', mat: 'concrete', hazard: 'n' },
    { t: 'skip', len: 30.5, dy: -2.5 },
    { t: 'plat', len: 8, w: 3, mat: 'concrete', hazard: 'ns' },
    { t: 'plat', gap: 4.5, dy: 1, len: 6, w: 4, off: 2, mat: 'rust' },
    { t: 'plat', gap: 4, dy: 1, len: 6, w: 4, off: -1, mat: 'rust' },
    { t: 'plat', gap: 3, len: 12, w: 10, mat: 'metal', hazard: '' },
    { t: 'beam', len: 18, w: 0.8 },
    { t: 'plat', len: 6, w: 6, mat: 'metal' },
    { t: 'mover', gap: 2.4, len: 4.6, w: 4, move: [0, 0, 9], period: 6.5 },
    { t: 'skip', len: 9 },
    { t: 'plat', gap: 2.5, len: 8, w: 8, mat: 'metal', hazard: '' },
    { t: 'crumble', gap: 2, len: 4, w: 4 },
    { t: 'crumble', gap: 2, len: 4, w: 4 },
  ]);
  // the deck between the pylons fell away: one suspension cable survives as a zip line
  const zipZ0 = z0 + 2 + 8 + 12, zipY = sy0;
  b.zipline([x, zipY + 3.1, zipZ0 - 3], [x, zipY - 2.5 + 2.65, zipZ0 + 30.5 + 2.2], { postA: zipY, postB: zipY - 2.5 });
  // skybridge suspension pylons, and debris where the deck broke off (none on the landing: it is solid, and riders drop there)
  for (const zz of [z0 + 14, z0 + 40, z0 + 55]) {
    for (const sx of [-2.6, 2.6]) b.tower(x + sx, zz, 64, 0.6, { light: sx < 0 });
    b.prop('cable', [x - 2.6, 63.5, zz], { q: [x - 1.4, 54.2, zz + 9] });
    b.prop('cable', [x + 2.6, 63.5, zz], { q: [x + 1.4, 54.2, zz + 9] });
  }
  b.prop('debris', [x + 0.8, zipY, zipZ0 - 3], { ry: 0.6 });
  // rescue hook above the two offset hops after the zip line
  b.grapple([x + 0.5, zipY + 5.5, zipZ0 + 46], { optional: true, mount: [x + 5, -110, zipZ0 + 46] });
  const mast = z0 + 90;
  b.tower(x + 3.5, mast, 70, 1.0, { light: true });
  b.prop('dish', [x - 3, 53.1, mast + 2], { ry: 3.4 });
  // sentinel on the radio mast looking back down the bridge
  b.plat(x + 3.5, 57, mast + 1.5, 3.4, 3.4, { mat: 'metal', hazard: 'nsew', supports: false, th: 0.6 });
  b.enemy('ranged', x + 3.5, 57, mast + 1.5, PI);
  // drones working the bridge and the far crossing
  b.enemy('flyer', x, 60, z0 + 40, PI, { patrol: [[x - 4, 59, z0 + 20], [x + 4, 60, z0 + 45], [x - 3, 61, z0 + 68]], leash: 45 });
  b.enemy('flyer', x, 59, z0 + 125, PI, { patrol: [[x + 4, 58, z0 + 112], [x - 4, 59, z0 + 132], [x + 2, 60, z0 + 150]], leash: 40 });
  b.zone('Wrecked Skybridge', x - 8, z0, x + 8, c.z);
  b.waypoint('Wrecked Skybridge', x, 53.7, z0 + 5);
  return c;
}

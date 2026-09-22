// LEFT route (+X): covered walkway -> scaffold descent -> container yard ->
// suspended catwalk -> foundry interior -> pipe yard -> hangar -> terrace
// gardens -> ring (west side). Longest, most cover, easier jumps, melee only.

import type { LevelBuilder } from '../builder';
import { buildCoolingWorks } from './band4';
import { FOUNDRY, GANTRY, HANGAR, L1, PLAZA, START } from './layout';

const PI = Math.PI;

export function buildLeft(b: LevelBuilder) {
  const sy = START.y;

  // ------------------------------------------------------------ covered walkway
  b.section('Covered Walkway');
  const wx0 = START.x + START.w / 2;
  b.building(wx0 + 14, sy, 2, 28, 3.6, 3.6, {
    doors: [{ side: 'w', width: 2.6, height: 2.7 }, { side: 'e', width: 2.6, height: 2.7 }],
    floorMat: 'metal', mat: 'concreteDark',
  });
  b.prop('lamp', [wx0 + 7, sy, 1.2]);
  b.prop('lamp', [wx0 + 21, sy, 2.8]);
  b.zone('Covered Walkway', wx0, -2, wx0 + 28, 6);

  // ------------------------------------------------------------ scaffold descent
  b.section('Scaffold Descent');
  const jx = wx0 + 28 + 6;
  b.plat(jx, sy, 2, 12, 12, { mat: 'metal', hazard: '', rails: 'es' });
  b.crate(jx + 3.5, sy, -1.5, 1.2);
  b.crate(jx + 4.2, sy, -0.2, 0.9, 0.6);
  b.prop('lamp', [jx - 5, sy, -3.5]);
  let c = b.cursor(jx, sy, 8, 0);
  c = b.chain(c, [
    { t: 'stairs', len: 6, w: 3, dy: -2 },
    { t: 'plat', len: 8, w: 5, rails: 'ew', mat: 'metal', hazard: '' },
    { t: 'plat', gap: 2.5, len: 6, w: 4, rails: 'e', mat: 'metal' },
    { t: 'plat', gap: 3.0, dy: -1, len: 8, w: 4, rails: 'e', mat: 'metal' },
    { t: 'beam', len: 12, w: 1.0 },
    { t: 'plat', len: 6, w: 6, mat: 'metal', hazard: '' },
    { t: 'stairs', len: 5, w: 3, dy: -3 },
  ]);
  b.tower(jx + 4, 30, sy + 6, 0.5);
  b.prop('cable', [jx + 4, sy + 6, 30], { q: [jx + 0.5, sy - 3, 47] });
  b.zone('Scaffold Descent', jx - 6, 8, jx + 6, c.z);

  // ------------------------------------------------------------ container yard
  b.section('Scaffold Yard');
  const ly = L1.y;
  const lz = c.z + L1.d / 2;
  const lx = L1.x;
  b.plat(lx, ly, lz, L1.w, L1.d, { mat: 'concrete', hazard: '', th: 2.2 });
  b.container(lx - 6, ly, lz - 5.5, 0);
  b.container(lx - 2, ly, lz + 6.5, PI / 2);
  b.container(lx + 7, ly, lz - 7.5, 0.1);
  b.container(lx - 7, ly, lz + 8.5, 0);
  b.container(lx + 2.5, ly, lz - 1, PI / 2 + 0.05);
  b.block(lx + 8.5, ly, lz + 1.5, 1.6, 4, 1.6, 'rust');
  // the climb: crate -> container -> stacked container -> catwalk
  b.crate(lx + 6.5, ly, lz + 4, 1.2);
  b.container(lx + 4, ly, lz + 8.8, 0);
  b.container(lx + 4, ly + 2.5, lz + 10.5, 0);
  b.prop('lamp', [lx - 10, ly, lz - 12]);
  b.prop('lamp', [lx + 10, ly, lz + 12]);
  b.prop('redLight', [lx + 8.5, ly + 4.1, lz + 1.5]);
  b.pickup('shield', lx - 7, ly + 2.5, lz + 8.5); // on top of a side container: a short climb off the path
  b.enemy('melee', lx - 9, ly, lz - 10, 0, {
    patrol: [[lx - 9, ly, lz - 10], [lx + 3.5, ly, lz - 10], [lx + 3.5, ly, lz - 4], [lx - 2.8, ly, lz - 4], [lx - 2.8, ly, lz + 2.8], [lx - 9.5, ly, lz + 3]],
  });
  b.enemy('flyer', lx, ly + 9, lz, 0, { patrol: [[lx - 8, ly + 8, lz - 9.5], [lx + 8, ly + 9, lz - 7.5], [lx + 8, ly + 10, lz + 8.5], [lx - 6, ly + 9, lz + 8.5]], leash: 35 });
  b.zone('Scaffold Yard', lx - L1.w / 2, c.z, lx + L1.w / 2, c.z + L1.d);
  b.waypoint('Scaffold Yard', lx - 6, ly + 0.1, lz - 11);
  // pipe X-link to the plaza
  b.section('Pipe Crossing');
  const plazaZ = 61.9 + PLAZA.d / 2;
  b.pipeWalk(lx - L1.w / 2, plazaZ, ly, PLAZA.w / 2, plazaZ, PLAZA.y, 0.75);
  b.tower(26, plazaZ + 3, 44, 0.6);
  b.prop('cable', [26, 44, plazaZ + 3], { q: [26, 34.5, plazaZ] });

  // ------------------------------------------------------------ suspended catwalk
  b.section('High Catwalk');
  const catZ0 = lz + 10.5 + 3.05;
  c = b.cursor(lx + 4, ly + 5, catZ0, 0);
  c = b.chain(c, [
    { t: 'plat', len: 14, w: 2.5, mat: 'grate', rails: 'ew', hazard: 'n', supports: false, th: 0.4 },
    { t: 'plat', gap: 2.8, len: 12, w: 2.5, mat: 'grate', rails: 'ew', hazard: 'ns', supports: false, th: 0.4 },
    { t: 'plat', gap: 3.2, dy: -0.5, len: 10, w: 3, mat: 'grate', rails: 'e', hazard: 's', supports: false, th: 0.4 },
    { t: 'stairs', len: 5, w: 3, dy: 1.5 },
  ]);
  for (const zz of [catZ0 + 7, catZ0 + 23, catZ0 + 37]) {
    b.tower(lx + 8, zz, ly + 16, 0.7, { light: zz < catZ0 + 10 });
    b.prop('cable', [lx + 8, ly + 16, zz], { q: [lx + 5.3, ly + 5.8, zz - 2] });
    b.prop('cable', [lx + 8, ly + 16, zz], { q: [lx + 5.3, ly + 5.8, zz + 2] });
  }
  // sentinel on a mast east of the catwalk (grates and rails do not hide you)
  b.tower(lx + 14, catZ0 + 17, ly + 13, 2, { light: true });
  b.plat(lx + 14, ly + 14, catZ0 + 17, 3.6, 3.6, { mat: 'metal', hazard: 'nsew', supports: false });
  b.enemy('ranged', lx + 14, ly + 14, catZ0 + 17, -2.24);
  b.zone('High Catwalk', lx, catZ0, lx + 8, c.z);

  // ------------------------------------------------------------ foundry
  b.section('Foundry');
  const F = FOUNDRY;
  const fz = c.z + F.d / 2;
  const doorX = lx + 4;
  const westDoorZ = GANTRY.z - 2;
  b.building(F.x, F.y, fz, F.w, F.d, F.h, {
    doors: [
      { side: 's', at: doorX - F.x, width: 3.2, height: 3.5 },
      { side: 'n', at: doorX - F.x, width: 3.2, height: 3.5 },
      { side: 'w', at: westDoorZ - fz, width: 3, height: 3.2 },
    ],
    mat: 'concreteDark',
  });
  // interior: furnaces, conveyor, machinery (cover everywhere)
  b.block(F.x + 5, F.y, fz - 11, 5, 6, 5, 'rust');
  b.block(F.x + 5, F.y, fz + 11, 5, 6, 5, 'rust');
  b.block(F.x + 5.5, F.y, fz, 3, 3, 8, 'steel');
  // twin production belts down the middle: north-bound carries you, south-bound fights you
  b.belt(doorX - 3.2, F.y + 0.3, F.y + 0.3, fz, 2.2, 24, 3.4, 0, { supports: false, th: 0.6 });
  b.belt(doorX, F.y + 0.3, F.y + 0.3, fz, 2.4, 24, -3.4, 0, { supports: false, th: 0.6 });
  b.hint('belt', doorX, F.y, fz - F.d / 2 + 3, 6, 'Conveyor belts carry you. The north-bound belt is quicker; the other one lets the stalker catch up.');
  b.block(F.x - 1, F.y, fz - 13, 3, 2.4, 2, 'metal');
  b.block(F.x - 1, F.y, fz + 13, 2.2, 2.8, 3.2, 'metal');
  b.crate(F.x + 9.5, F.y, fz - 17, 1.3);
  b.pickup('cloak', F.x + 9.8, F.y, fz + 15.5); // tucked behind the north furnace
  b.crate(F.x - 10, F.y, fz + 17.5, 1.2, 0.3);
  b.prop('lamp', [F.x + 1, F.y, fz - 6]);
  b.prop('lamp', [F.x + 1, F.y, fz + 7]);
  b.prop('redLight', [F.x + 5, F.y + 6.2, fz - 11]);
  b.prop('chimney', [F.x + 5, F.y + F.h, fz - 11], { s: [1.3, 12, 1.3] });
  b.enemy('melee', F.x + 0.5, F.y, fz - 7.5, -PI / 2, {
    patrol: [[F.x + 0.5, F.y, fz - 7.5], [F.x + 0.5, F.y, fz + 4.5], [F.x + 8.8, F.y, fz + 6], [F.x + 8.8, F.y, fz - 6]],
  });
  b.zone('Foundry', F.x - F.w / 2, fz - F.d / 2, F.x + F.w / 2, fz + F.d / 2);
  b.waypoint('Foundry', doorX, F.y + 0.1, fz - F.d / 2 - 3);

  // X-link: foundry west door -> gantry deck
  b.section('Foundry Bridge');
  c = b.cursor(F.x - F.w / 2, F.y, westDoorZ, -PI / 2);
  const bridgeRemain = F.x - F.w / 2 - 10 - 3 - 8 - 3 - (GANTRY.x + GANTRY.w / 2);
  b.chain(c, [
    { t: 'plat', len: 10, w: 3, rails: 'ew', mat: 'metal', hazard: '' },
    { t: 'plat', gap: 3, dy: -1, len: 8, w: 3, mat: 'metal', hazard: 'ns' },
    { t: 'plat', gap: 3, dy: -1, len: bridgeRemain, w: 3, mat: 'metal', hazard: 's' },
  ]);

  // ------------------------------------------------------------ pipe yard
  b.section('Pipe Yard');
  c = b.cursor(doorX, F.y, fz + F.d / 2, 0);
  c = b.chain(c, [{ t: 'plat', len: 8, w: 6, rails: 'e', mat: 'concrete', hazard: 'n' }]);
  b.pipeWalk(doorX, c.z, F.y, doorX, c.z + 14, F.y, 0.75);
  b.prop('pipe', [doorX + 4.5, F.y - 2.5, c.z - 2], { q: [doorX + 4.5, F.y - 2.5, c.z + 24], s: [0.9, 0.9, 0.9] });
  b.prop('pipe', [doorX - 3, F.y - 3, c.z - 4], { q: [doorX - 3, F.y - 3, c.z + 30], s: [1.2, 1.2, 1.2] });
  c.z += 14;
  c = b.chain(c, [
    { t: 'plat', len: 6, w: 6, mat: 'metal' },
    { t: 'mover', gap: 2.2, len: 4.8, w: 4, move: [0, 0, 8], period: 7 },
    { t: 'skip', len: 8 },
    { t: 'plat', gap: 2.5, dy: -2, len: 8, w: 6, mat: 'concrete' },
    { t: 'plat', gap: 3, dy: -2, len: 6, w: 5, mat: 'concrete', hazard: 's' },
  ]);
  b.enemy('flyer', doorX, F.y + 6, c.z - 28, 0, { patrol: [[doorX - 3, F.y + 5, c.z - 42], [doorX + 3, F.y + 6, c.z - 26], [doorX - 2, F.y + 7, c.z - 12]], leash: 30 });
  b.zone('Pipe Yard', doorX - 5, fz + F.d / 2, doorX + 5, c.z);

  // ------------------------------------------------------------ hangar
  b.section('Hangar');
  const H = HANGAR;
  const hz = c.z + H.d / 2;
  const sideDoorZ = hz;
  b.building(H.x, H.y, hz, H.w, H.d, H.h, {
    doors: [
      { side: 's', at: doorX - H.x, width: 6, height: 5 },
      // the north shutter jammed 0.95 m above the floor: slide under it
      { side: 'n', at: doorX - H.x, width: 3, height: 0.95 },
      { side: 'w', at: 0, width: 3, height: 3 },
    ],
    mat: 'rust',
  });
  // ...into a low baggage tunnel (too low for a stalker, too long to crawl without momentum)
  const tz0 = hz + H.d / 2, tLen = 8;
  b.block(doorX, H.y + 0.95, tz0 + tLen / 2, 3.6, 1.7, tLen, 'rust');
  for (const sx of [-1, 1]) b.block(doorX + sx * 1.65, H.y, tz0 + tLen / 2, 0.3, 2.65, tLen, 'concreteDark');
  b.deco([doorX, H.y + 1.02, tz0 - 0.3], [3.2, 0.14, 0.12], 'hazard');
  b.deco([doorX, H.y + 1.02, tz0 + tLen + 0.05], [3.6, 0.14, 0.12], 'hazard');
  b.prop('redLight', [doorX - 1.9, H.y + 1.4, tz0 - 0.4]);
  b.prop('redLight', [doorX + 1.9, H.y + 1.4, tz0 - 0.4]);
  b.hint('slide', doorX, H.y, tz0 - 6, 7, 'Slide: sprint and press C to drop low under the jammed shutter. Stalkers are too tall to follow you through.');
  // old airship gondola + clutter
  b.block(H.x + 3, H.y, hz - 2, 6, 3.6, 15, 'white');
  b.block(H.x + 3, H.y + 3.6, hz - 2, 4, 1.2, 11, 'steel');
  b.container(H.x - 8, H.y, hz - 10, 0);
  b.container(H.x - 8, H.y, hz + 9, 0.1);
  b.block(H.x + 10, H.y, hz + 12, 3, 2.2, 3, 'metal');
  b.crate(H.x + 10.5, H.y, hz - 14, 1.3);
  b.crate(H.x - 3, H.y, hz + 15, 1.2, 0.5);
  b.prop('lamp', [H.x - 4, H.y, hz]);
  b.prop('lamp', [H.x + 9, H.y, hz + 3]);
  // stalker pacing the open floor past the gondola
  b.enemy('melee', H.x + 6.8, H.y, hz + 8, PI, { patrol: [[H.x + 6.8, H.y, hz + 8], [H.x + 11.5, H.y, hz + 8]] });
  // a second stalker guards the jammed shutter from inside
  b.enemy('melee', doorX - 5.5, H.y, hz + 12.75, 0, {
    patrol: [[doorX - 5.5, H.y, hz + 12.75], [doorX + 6, H.y, hz + 12.75], [doorX + 6, H.y, hz + 17.5], [doorX - 5.5, H.y, hz + 17.5]], leash: 18,
  });
  b.zone('Hangar', H.x - H.w / 2, hz - H.d / 2, H.x + H.w / 2, hz + H.d / 2);
  b.waypoint('Hangar', doorX, H.y + 0.1, hz - H.d / 2 - 3);

  // X-link: hangar west door -> viaduct (middle slab)
  b.enemy('flyer', 20, H.y + 8, sideDoorZ + 1.5, -PI / 2, { patrol: [[30, H.y + 7, sideDoorZ - 3.5], [12, H.y + 8, sideDoorZ + 3.5], [22, H.y + 9, sideDoorZ - 8.5]], leash: 30 });
  b.section('Hangar Link');
  c = b.cursor(H.x - H.w / 2, H.y, sideDoorZ, -PI / 2);
  const linkRemain = H.x - H.w / 2 - 8 - 3 - 6 - 3 - 6 - 5;
  b.chain(c, [
    { t: 'plat', len: 8, w: 3, mat: 'metal', rails: 'ew', hazard: 'n' },
    { t: 'plat', gap: 3, dy: 1, len: 6, w: 3, mat: 'metal', hazard: 'ns' },
    { t: 'plat', gap: 3, dy: 1, len: 6, w: 3, mat: 'metal', hazard: 'ns' },
    { t: 'stairs', len: linkRemain, w: 3, dy: 1.5 },
  ]);

  // ------------------------------------------------------------ terrace gardens
  b.section('Terrace Gardens');
  c = b.cursor(doorX, H.y, hz + H.d / 2, 0);
  c = b.chain(c, [
    { t: 'plat', len: 10, w: 10, mat: 'concrete', hazard: '' },
    { t: 'stairs', len: 8, w: 4, dy: 3 },
    { t: 'plat', len: 6, w: 5, mat: 'concrete' },
  ]);
  // launch pad over the collapsed middle terrace onto the upper garden
  const padZ = c.z - 3, padY = c.y;
  c = b.chain(c, [
    { t: 'skip', len: 10, dy: 2 },
    { t: 'plat', len: 8, w: 6, mat: 'concrete', hazard: '' },
  ]);
  b.launchPad(doorX, padY + 0.12, padZ, [doorX, c.y, c.z - 4], 7);
  b.hint('launch', doorX, padY, padZ - 4, 5, 'Launch pads throw you onto the next platform. Just step on, you can steer a little in the air.');
  b.prop('debris', [doorX + 1.5, c.y, c.z - 1.5], { v: 1 });
  b.prop('debris', [doorX - 2, c.y, c.z - 6], { v: 1 });
  b.zone('Terrace Gardens', doorX - 6, hz + H.d / 2, doorX + 6, c.z);
  buildCoolingWorks(b, c, doorX);
  b.waypoint('Terrace Gardens', doorX, H.y + 0.1, hz + H.d / 2 + 4);
}

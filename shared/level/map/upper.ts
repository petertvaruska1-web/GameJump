// Upper Works: the band between the reactor ring and the Spire.
//
//   North Junction -> Assembly Line (+X, conveyor belts)
//                  -> Laser Galleries (-X, laser gates / bars / windmill)
//   -> Launch Yard -> three launch pads up the Cable Station
//   -> zip lines across the chasm (west: one long fast cable through a laser
//      curtain; east: two cables via a relay mast with a drone) -> Foothills

import type { LevelBuilder } from '../builder';
import { FOOT, NJ, STATION, YARD } from './layout';

const PI = Math.PI;
const RELAY = { x: 10, y: 68, z0: 778, z1: 792 };

export function buildUpperWorks(b: LevelBuilder) {
  b.section('North Junction');
  b.plat(0, NJ.y, NJ.z, 10, 9, { mat: 'concrete', hazard: 'n' });
  b.prop('lamp', [4.2, NJ.y, NJ.z + 3.8]);
  b.prop('lamp', [-4.2, NJ.y, NJ.z + 3.8]);
  b.block(0, NJ.y, NJ.z + 3.6, 1.2, 2.6, 0.4, 'hazard');
  b.zone('North Junction', -5, NJ.z - 4.5, 5, NJ.z + 4.5);
  b.waypoint('North Junction', 0, NJ.y + 0.1, NJ.z);

  buildAssemblyLine(b);
  buildLaserGalleries(b);
  buildLaunchYard(b);
  buildCableStation(b);
  buildFoothills(b);
}

// ------------------------------------------------------------------ assembly line (+X)

function buildAssemblyLine(b: LevelBuilder) {
  b.section('Assembly Line');
  const y0 = NJ.y;
  let c = b.cursor(5, y0, NJ.z, PI / 2);
  c = b.chain(c, [
    { t: 'plat', len: 8, w: 3, rails: 'ew', mat: 'grate', hazard: '' },
    { t: 'corner', size: 5, turn: -PI / 2, mat: 'metal' },
  ]);
  const x = c.x, z0 = c.z;
  c = b.chain(c, [
    // the feed belt carries you into a blinking gate: hold back until it opens
    { t: 'belt', len: 16, w: 3.5, speed: 3.2 },
    { t: 'plat', len: 8, w: 6.5, mat: 'metal', hazard: '' },
    // sorting floor: belts pushing alternately toward either edge
    { t: 'xbelt', len: 5, w: 6.5, speed: 3.2 },
    { t: 'xbelt', len: 5, w: 6.5, speed: -3.2 },
    { t: 'xbelt', len: 5, w: 6.5, speed: 3.2 },
    { t: 'plat', len: 6, w: 6.5, mat: 'metal', hazard: '' },
    // uphill treadmill running against you
    { t: 'belt', len: 12, w: 3.2, speed: -3.4, dy: 2.5 },
    { t: 'plat', len: 12, w: 8, mat: 'metal', hazard: '' },
    // boost belt: ride it into a gap you could not clear on foot
    { t: 'belt', len: 10, w: 3, speed: 5 },
    { t: 'plat', gap: 7.5, dy: -1, len: 10, w: 6, mat: 'metal', hazard: 's' },
    { t: 'stairs', len: 7, w: 3.5, dy: 2.5 },
  ]);
  c = b.chain(c, [{ t: 'plat', len: YARD.z0 - c.z, w: 3.5, mat: 'metal', hazard: '' }]);

  const gateZ = z0 + 16 + 0.35;
  b.laserGate(x - 3.25, gateZ, x + 3.25, gateZ, y0, { cycle: 3.4, duty: 0.55 });
  const pressZ0 = z0 + 16 + 8 + 15 + 6 + 12, pressY = y0 + 2.5;
  b.laserBar(x - 4.3, pressZ0 + 1.5, x + 4.3, pressZ0 + 1.5, pressY + 0.42, [0, 0, 9], 4.6);
  const boostZ = pressZ0 + 12;
  b.hint('belt', x, y0, z0 + 2, 6, 'Conveyor belts carry you. Walk against them, steer across them, ride them into long jumps.');
  b.hint('laser', x, y0, gateZ - 6, 5, 'Lasers kill on contact. Wait for a gate to switch off (it flickers first), jump the low beams.');
  b.hint('boost', x, pressY, boostZ - 1, 4, 'Boost belt: sprint along it and jump at the end. The belt adds its speed to your jump.');

  // factory frames over the line, pipes, lamps
  for (const zz of [z0 + 6, z0 + 27, z0 + 50, z0 + 71]) {
    const top = zz > z0 + 45 ? pressY : y0;
    for (const sx of [-1, 1]) b.tower(x + sx * 4.6, zz, top + 6.5, 0.5, { light: sx > 0 });
    b.deco([x, top + 6.6, zz], [9.7, 0.6, 0.6], 'hazard');
    b.deco([x, top + 5.9, zz], [1.2, 0.8, 0.9], 'steel');
  }
  b.prop('lamp', [x + 2.9, y0, z0 + 16 + 6.5]);
  b.prop('lamp', [x - 3.6, pressY, pressZ0 + 10.5]);
  b.prop('pipe', [x + 5.6, y0 - 1.5, z0 - 2], { q: [x + 5.6, y0 - 1.5, boostZ + 10], s: [0.7, 0.7, 0.7] });
  b.prop('pipe', [x - 5.8, y0 - 3.2, z0 + 10], { q: [x - 5.8, y0 - 3.2, boostZ + 20], s: [1.0, 1.0, 1.0] });
  b.crate(x + 2, pressY - 1, boostZ + 21, 1.2);
  b.crate(x - 2, pressY - 1, boostZ + 23, 1.0, 0.4);
  // sentinel watching the sorting floor from the east
  const sz = z0 + 32;
  b.tower(x + 13, sz, y0 + 8, 2, { light: true });
  b.plat(x + 13, y0 + 9, sz, 3.6, 3.6, { mat: 'metal', hazard: 'nsew', supports: false });
  b.enemy('ranged', x + 13, y0 + 9, sz, -PI / 2);
  // drone working the treadmill and the press deck
  b.enemy('flyer', x, pressY + 6, pressZ0 + 4, PI, {
    patrol: [[x, pressY + 5.5, pressZ0 - 8], [x - 3, pressY + 6, pressZ0 + 6], [x + 3, pressY + 5.5, boostZ + 6], [x, pressY + 6.5, boostZ + 18]], leash: 40,
  });
  b.zone('Assembly Line', 5, NJ.z - 4.5, x + 6, YARD.z0);
  b.waypoint('Assembly Line', x, y0 + 0.1, z0 - 1);
}

// ------------------------------------------------------------------ laser galleries (-X)

function buildLaserGalleries(b: LevelBuilder) {
  b.section('Laser Galleries');
  const y0 = NJ.y;
  let c = b.cursor(-5, y0, NJ.z, -PI / 2);
  c = b.chain(c, [
    { t: 'plat', len: 8, w: 3, rails: 'ew', mat: 'grate', hazard: '' },
    { t: 'corner', size: 5, turn: PI / 2, mat: 'metal' },
    { t: 'plat', len: 4, w: 5, mat: 'concrete', hazard: '' },
  ]);
  const x = c.x;
  // security checkpoint: its two doorway gates blink out of phase, the room between is safe
  const k0 = c.z;
  b.building(x, y0, k0 + 6, 8, 12, 4, {
    doors: [{ side: 's', width: 3, height: 3 }, { side: 'n', width: 3, height: 3 }], mat: 'concreteDark', windows: false,
  });
  b.laserGate(x - 1.6, k0 + 0.25, x + 1.6, k0 + 0.25, y0, { cycle: 3.2, duty: 0.5, phase: 0, posts: false });
  b.laserGate(x - 1.6, k0 + 11.75, x + 1.6, k0 + 11.75, y0, { cycle: 3.2, duty: 0.5, phase: 0.5, posts: false });
  b.prop('lamp', [x + 2.8, y0, k0 + 6]);
  b.prop('redLight', [x, y0 + 3.4, k0 + 0.6]);
  b.prop('redLight', [x, y0 + 3.4, k0 + 11.4]);
  c = b.chain(c, [{ t: 'skip', len: 12 }]);

  // sweep corridor: a low beam runs up and down the railed corridor, jump it
  const s0 = c.z;
  c = b.chain(c, [{ t: 'plat', len: 26, w: 3.5, rails: 'ew', mat: 'metal', hazard: '' }]);
  // first half: a low beam (jump it); second half: a chest-high beam (slide under it). They never meet.
  b.laserBar(x - 1.75, s0 + 1.5, x + 1.75, s0 + 1.5, y0 + 0.42, [0, 0, 10.5], 5.5);
  b.laserBar(x - 1.75, s0 + 24.5, x + 1.75, s0 + 24.5, y0 + 1.3, [0, 0, -10.5], 5, 0.3);
  b.hint('slidebar', x, y0, s0 + 1, 4, 'Two beams here: jump the low one, slide under the chest-high one (C while running).');

  // sliding gates: each fence covers half the deck and slides across, pass through the gap
  c = b.chain(c, [{ t: 'plat', gap: 2.5, len: 14, w: 6.5, mat: 'metal', hazard: 'ns' }]);
  const g0 = c.z - 14;
  b.laserGate(x - 3.25, g0 + 4, x + 0.15, g0 + 4, y0, { move: [3.1, 0, 0], period: 3.6, movePhase: 0, posts: false });
  b.laserGate(x - 3.25, g0 + 10, x + 0.15, g0 + 10, y0, { move: [3.1, 0, 0], period: 3.6, movePhase: 0.5, posts: false });
  for (const zz of [g0 + 4, g0 + 10]) for (const sx of [-1, 1]) b.block(x + sx * 3.1, y0, zz, 0.3, 2.5, 0.3, 'steel');

  // laser windmill: a low beam spinning around a hub
  c = b.chain(c, [{ t: 'plat', gap: 2.5, len: 13, w: 13, mat: 'metal', hazard: '' }]);
  const wz = c.z - 6.5;
  b.block(x, y0, wz, 1.0, 1.5, 1.0, 'steel');
  b.prop('redLight', [x, y0 + 1.7, wz]);
  b.laserSpin(x, wz, y0 + 0.45, 15, 1.1);
  b.hint('windmill', x, y0, wz - 7.5, 4, 'Laser windmill: jump the beam as it sweeps past you.');

  // security deck: blinking exit gate, a stalker on guard (only a small step from the windmill,
  // so a beam jump near its edge still lands safely)
  c = b.chain(c, [{ t: 'plat', gap: 1, len: 10, w: 10, mat: 'concrete', hazard: '' }]);
  const dz = c.z - 5;
  b.laserGate(x - 5, c.z - 0.4, x + 5, c.z - 0.4, y0, { cycle: 2.8, duty: 0.45, phase: 0.2 });
  b.block(x + 1.5, y0, dz - 1, 2.4, 2.3, 0.6, 'concreteDark');
  b.block(x - 2.2, y0, dz + 1.5, 0.6, 2.3, 2.6, 'concreteDark');
  b.crate(x + 0.5, y0, dz + 1.2, 1.2);
  b.enemy('melee', x - 3.8, y0, dz + 3.8, 0, {
    patrol: [[x - 3.8, y0, dz + 3.8], [x + 3.7, y0, dz + 3.8], [x + 3.7, y0, dz - 3.5], [x - 3.8, y0, dz - 3.5]], leash: 14,
  });
  c = b.chain(c, [
    { t: 'stairs', len: 7, w: 3.5, dy: 2.5 },
    { t: 'plat', len: 8, w: 3.5, rails: 'ew', mat: 'grate', hazard: '' },
    { t: 'stairs', len: 3, w: 3.5, dy: 1.5 },
  ]);
  c = b.chain(c, [{ t: 'plat', len: YARD.z0 - c.z, w: 3.5, mat: 'metal', hazard: '' }]);

  // drone over the corridor and the sliding gates
  b.enemy('flyer', x, y0 + 7, s0 + 14, 0, {
    patrol: [[x, y0 + 6.5, s0 + 4], [x + 3, y0 + 7, s0 + 18], [x - 3, y0 + 6.5, g0 + 7], [x, y0 + 7.5, s0 + 12]], leash: 36,
  });
  for (const zz of [s0 + 8, s0 + 20, g0 + 7]) {
    b.tower(x - 4.2, zz, y0 + 6, 0.45, { light: zz === s0 + 8 });
    b.prop('cable', [x - 4.2, y0 + 6, zz], { q: [x - 1.7, y0 + 1.1, zz + 2] });
  }
  b.zone('Laser Galleries', x - 7, NJ.z - 4.5, -5, YARD.z0);
  b.waypoint('Laser Galleries', x, y0 + 0.1, k0 - 2);
}

// ------------------------------------------------------------------ launch yard + cable station

function buildLaunchYard(b: LevelBuilder) {
  b.section('Launch Yard');
  const { y, z0, z1, w } = YARD;
  const zc = (z0 + z1) / 2;
  b.plat(0, y, zc, w, z1 - z0, { mat: 'concrete', hazard: 'n', th: 2.2 });
  b.container(-8.5, y, zc + 1, PI / 2 + 0.1);
  b.container(8.5, y, zc + 1, PI / 2 - 0.08);
  b.block(4.5, y, zc - 1, 1.6, 3.2, 1.6, 'concreteDark');
  b.block(-16, y, zc + 5, 1.6, 3.2, 1.6, 'concreteDark');
  b.block(16.5, y, zc - 6.5, 3, 1.0, 1.2, 'hazard');
  b.crate(18, y, zc + 6, 1.3);
  b.crate(-19.5, y, zc - 6, 1.2, 0.3);
  for (const lx of [-20, 20]) { b.prop('lamp', [lx, y, zc - 8.5]); b.prop('lamp', [lx, y, zc + 8.5]); }
  // launch pads: yard -> pillar 1 -> pillar 2 -> station roof
  b.launchPad(-3, y + 0.12, 700, [-6.5, 57, 709.5], 2.5);
  b.plat(-8, 57, 710, 7, 7, { mat: 'metal', hazard: 'nsew' });
  b.launchPad(-9.8, 57.12, 711.5, [6.2, 66, 709.8], 3);
  b.plat(8, 66, 710, 7, 7, { mat: 'metal', hazard: 'nsew' });
  b.launchPad(9.8, 66.12, 711.5, [2.5, STATION.y, 726], 4);
  b.prop('redLight', [-11.2, 57.2, 706.8]);
  b.prop('redLight', [11.2, 66.2, 706.8]);
  b.hint('launch', -3, y, 700, 8, 'Launch pads throw you onto the next platform. Just step on, you can steer a little in the air.');
  // detour: a hook out over the gap west of the yard swings you to a ledge with a boost crate (and back)
  b.plat(-35, y + 0.5, 694, 4, 4, { mat: 'metal', hazard: 'nsew' });
  b.grapple([-28, y + 9, 694], { optional: true, mount: [-35.8, y + 0.5, 694] });
  b.pickup('boost', -35, y + 0.5, 694);
  // stalker patrolling between the containers; the pad is the way out
  b.enemy('melee', 0, y, zc - 5, 0, { patrol: [[-13, y, zc - 5], [13, y, zc - 5], [13, y, zc + 4], [-13, y, zc + 4]], leash: 22 });
  b.zone('Launch Yard', -w / 2, z0, w / 2, STATION.z0);
  b.waypoint('Launch Yard', 0, y + 0.1, z0 + 2);
}

function buildCableStation(b: LevelBuilder) {
  b.section('Cable Station');
  const { y, z0, z1, w } = STATION;
  const zc = (z0 + z1) / 2;
  b.roof(0, y, zc, w, z1 - z0, { hazard: 'n' });
  // machine house + clutter for cover from the sentinel
  b.building(-6, y, zc - 3, 6, 6, 3.2, { doors: [{ side: 'e', width: 2, height: 2.4 }, { side: 's', width: 2, height: 2.4 }], floor: false, windows: false });
  b.block(5, y, zc - 5, 3, 1.2, 1.2, 'metal');
  b.block(6.5, y, zc + 1.5, 1.4, 2.4, 1.4, 'concreteDark');
  b.block(-2, y, zc + 5, 2.6, 1.0, 1.0, 'hazard');
  b.prop('dish', [8, y, zc - 8], { ry: 2.6 });
  b.prop('antenna', [-9.5, y, zc + 7.5], { s: [1, 8, 1] });
  b.prop('lamp', [0, y, zc - 9]);
  // west cable: long and fast, crossing a blinking laser curtain near the start
  const wa: [number, number, number] = [-5, y + 3.1, z1 - 3];
  const wb: [number, number, number] = [-9, FOOT.y + 2.65, FOOT.z0 + 2];
  b.zipline(wa, wb, { postA: y, postB: FOOT.y });
  const gz = z1 + 14;
  const u = (gz - wa[2]) / (wb[2] - wa[2]);
  const gx = wa[0] + (wb[0] - wa[0]) * u, gy = wa[1] + (wb[1] - wa[1]) * u;
  for (const sx of [-1.9, 1.9]) b.tower(gx + sx, gz, gy + 0.6, 0.4, { light: true });
  b.laserGate(gx - 1.7, gz, gx + 1.7, gz, gy - 2.3, { h: 2.3, cycle: 4, duty: 0.35, phase: 0.1, posts: false });
  // east cable: to the relay mast, then on to the foothills
  b.zipline([5, y + 3.1, z1 - 3], [RELAY.x, RELAY.y + 2.65, RELAY.z0 + 2.5], { postA: y, postB: RELAY.y });
  b.hint('zip', 0, y, z1 - 4, 7, 'Zip lines: jump into the cable to grab it, Space lets go. The west cable is faster, but time the laser curtain.');
  // sentinel on a mast east of the roof
  b.tower(17, zc - 1, y + 7, 2, { light: true });
  b.plat(17, y + 8, zc - 1, 3.6, 3.6, { mat: 'metal', hazard: 'nsew', supports: false });
  b.enemy('ranged', 17, y + 8, zc - 1, -PI / 2 - 0.25);
  b.zone('Cable Station', -w / 2, z0, w / 2, z1);
  b.waypoint('Cable Station', 0, y + 0.1, zc + 4);

  b.section('Relay Mast');
  const rz = (RELAY.z0 + RELAY.z1) / 2;
  b.plat(RELAY.x, RELAY.y, rz, 6, RELAY.z1 - RELAY.z0, { mat: 'grate', hazard: 'ns', rails: 'ew', th: 0.8 });
  b.tower(RELAY.x + 3.6, rz, RELAY.y + 9, 0.8, { light: true });
  b.prop('dish', [RELAY.x + 3.2, RELAY.y + 5, rz - 3], { ry: -1.2 });
  b.zipline([RELAY.x, RELAY.y + 3.1, RELAY.z1 - 2.5], [8, FOOT.y + 2.65, FOOT.z0 + 2], { postA: RELAY.y, postB: FOOT.y });
  b.enemy('flyer', RELAY.x + 4, RELAY.y + 5, rz, -PI / 2, {
    patrol: [[RELAY.x + 5, RELAY.y + 4, RELAY.z0 - 6], [RELAY.x - 4, RELAY.y + 5, rz], [RELAY.x + 5, RELAY.y + 4.5, RELAY.z1 + 6]], leash: 30,
  });
  b.pickup('cloak', RELAY.x + 1.5, RELAY.y, RELAY.z0 + 7);
  b.zone('Relay Mast', RELAY.x - 3, RELAY.z0, RELAY.x + 3, RELAY.z1);
  b.waypoint('Relay Mast', RELAY.x, RELAY.y + 0.1, RELAY.z0 + 6);
}

function buildFoothills(b: LevelBuilder) {
  b.section('Foothills');
  const { y, z0, z1, w } = FOOT;
  const zc = (z0 + z1) / 2;
  b.plat(0, y, zc, w, z1 - z0, { mat: 'concrete', hazard: 's', th: 2.2 });
  b.block(-3.5, y, zc + 1, 1.6, 3, 1.6, 'concreteDark');
  b.block(14, y, zc - 3, 1.6, 3, 1.6, 'concreteDark');
  b.container(-12.5, y, zc + 4.5, PI / 2 + 0.06);
  b.crate(-6, y, zc + 5.5, 1.2);
  b.prop('debris', [-6, y, zc - 3], { v: 1 });
  b.prop('debris', [5.5, y, zc - 2.5], { v: 1 });
  b.prop('lamp', [-14.5, y, zc - 5]);
  b.prop('lamp', [14.5, y, zc - 5]);
  b.enemy('melee', 13, y, zc + 2, PI, { patrol: [[13, y, zc + 2], [2, y, zc + 2], [2, y, zc + 5], [13, y, zc + 5]], leash: 16 });
  b.zone('Foothills', -w / 2, z0, w / 2, z1);
  b.waypoint('Foothills', 0, y + 0.1, zc);
}

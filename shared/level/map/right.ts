// RIGHT route (-X): rooftop hops -> water-tower roof -> smokestacks (wind) ->
// antenna array -> Leap of Faith onto the ring. Shortest, hardest jumps,
// ranged + flying enemies. Also hosts the crane-jib tightrope shortcut.

import type { LevelBuilder } from '../builder';
import { buildSkybridge } from './band4';
import { GANTRY, R1, RING, RING_OUTER, RING_SIDE, START } from './layout';

const PI = Math.PI;

export function buildRight(b: LevelBuilder) {
  const sy = START.y;

  // ------------------------------------------------------------ rooftops
  b.section('Rooftops');
  const ex = START.x - START.w / 2;
  // diving board -> roof A: the signature sprint leap off the start pad (5 m, 1 m down)
  b.plat(ex - 2.5, sy, 4, 5, 4, { mat: 'metal', hazard: 'w', th: 0.5 });
  b.roof(-27, sy - 1, 4, 10, 10, { hazard: 'e' });
  // AC units to vault on the way across roof A
  b.block(-24.2, sy - 1, 6.5, 1.4, 0.85, 2.2, 'metal');
  b.block(-29.4, sy - 1, 0.8, 1.6, 0.85, 1.6, 'metal');
  b.prop('antenna', [-31, sy - 1, -0.2], { s: [1, 5, 1] });
  // A -> B: a fallen billboard lies across the gap as a sloped plank
  b.beam(-28.5, 9, -28.5, 13, sy - 1, 1.3, 'rust', sy + 0.2);
  b.deco([-28.5, sy - 0.2, 11], [1.5, 0.12, 0.12], 'hazard');
  b.deco([-29.25, sy - 1.6, 10.6], [0.1, 1.4, 0.1], 'steel');
  b.deco([-27.75, sy - 1.6, 10.6], [0.1, 1.4, 0.1], 'steel');
  b.roof(-30, sy + 0.2, 17, 8, 8, { hazard: 'n' });
  b.block(-32.6, sy + 0.2, 15, 1.2, 0.85, 1.2, 'metal');
  // B -> C: short drop onto the lower roof
  b.roof(-33, sy - 2, 29, 9, 9, { hazard: 'n' });
  b.prop('dish', [-35.8, sy - 2, 26.4], { ry: -2.4 });
  b.block(-30.4, sy - 2, 31.5, 1.4, 0.85, 1.4, 'metal');
  // rescue hook above the C -> D sprint jump
  b.grapple([-34.5, sy + 5.5, 35.8], { optional: true, mount: [-39.2, -110, 35.8] });
  // C -> D: the one real sprint jump of the rooftops (4.5 m, level)
  b.roof(-36, sy - 2, 43, 6, 10, { hazard: 'ns' });
  // D -> stacked crates up -> walk a pipe up onto the water-tower roof
  b.plat(-37.5, sy - 0.8, 51, 3, 3, { mat: 'rust', hazard: '' });
  b.plat(-39.5, sy + 0.4, 55.5, 3, 3, { mat: 'rust', hazard: '' });
  b.pipeWalk(-39.5, 56.8, sy + 0.4, -40.5, R1.z - R1.d / 2 + 0.4, R1.y, 0.6);
  // sentinel on a tall mast overlooking the lower roofs and the crate climb
  b.tower(-24, 56, sy + 9, 2, { light: true });
  b.plat(-24, sy + 10, 56, 3.6, 3.6, { mat: 'metal', hazard: 'nsew', supports: false });
  b.enemy('ranged', -24, sy + 10, 56, -2.0);
  b.zone('Rooftops', -45, -2, -12, R1.z - R1.d / 2);
  b.waypoint('Rooftops', -27, sy - 0.9, 2);

  // ------------------------------------------------------------ water tower roof (R1)
  b.section('Water Tower Roof');
  b.roof(R1.x, R1.y, R1.z, R1.w, R1.d, {});
  // water tower on legs (tank blocks sight; walk under it)
  const tx = R1.x - 2, tz = R1.z - 2;
  for (const [lx, lz] of [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]]) b.block(tx + lx, R1.y, tz + lz, 0.35, 3.2, 0.35, 'steel');
  b.block(tx, R1.y + 3.2, tz, 4.4, 4.8, 4.4, 'invisible', 0, { visible: false, sight: true });
  b.prop('tank', [tx, R1.y + 3.2, tz], { s: [2.4, 4.8, 2.4] });
  b.block(R1.x + 5, R1.y, R1.z + 4, 2.2, 1.1, 1.6, 'metal');
  b.block(R1.x + 4.5, R1.y, R1.z - 5.5, 1.5, 0.9, 1.5, 'metal');
  b.pickup('cloak', tx, R1.y, tz); // between the water tower's legs
  b.block(R1.x - 6, R1.y, R1.z + 5.5, 1.3, 2.4, 1.3, 'concreteDark');
  b.prop('lamp', [R1.x + 7, R1.y, R1.z - 7]);
  b.enemy('flyer', R1.x, R1.y + 8, R1.z + 6, PI, {
    leash: 42,
    patrol: [[R1.x - 6, R1.y + 7, R1.z - 5], [R1.x + 6, R1.y + 8, R1.z + 6], [R1.x, R1.y + 8.5, R1.z + 20], [R1.x - 2, R1.y + 9, R1.z + 34]],
  });
  // stalker pacing the middle of the roof, away from the top of the pipe climb
  b.enemy('melee', R1.x - 3.8, R1.y, R1.z + 2.6, 0, { patrol: [[R1.x - 3.8, R1.y, R1.z + 2.6], [R1.x + 2, R1.y, R1.z + 2.6]], leash: 20 });
  b.zone('Water Tower Roof', R1.x - R1.w / 2, R1.z - R1.d / 2, R1.x + R1.w / 2, R1.z + R1.d / 2);
  b.waypoint('Water Tower Roof', R1.x + 4, R1.y + 0.1, R1.z - 5);

  // ------------------------------------------------------------ crane jib shortcut
  b.section('Crane Jib');
  const cx = R1.x - 6, cz = R1.z + R1.d / 2 + 2.5;
  const cabY = R1.y + 5.5;
  b.stairs(cx, R1.z + 2.5, R1.y, cabY, 0, 2.4, 10, 'metal');
  b.tower(cx, cz + 1, cabY - 1.3, 2.6, { light: false });
  b.plat(cx, cabY, cz, 4, 5, { mat: 'metal', hazard: '', supports: false, rails: 'w' });
  // mast, cab and counter-jib (visual)
  b.block(cx + 1.3, cabY, cz - 0.5, 1.4, 9, 1.4, 'hazard');
  b.deco([cx + 1.3, cabY + 7.1, cz - 2.3], [1.8, 1.8, 1.8], 'white');
  b.deco([cx + 1.3, cabY + 8.8, cz + 3], [0.8, 0.8, 9], 'hazard');
  b.prop('redLight', [cx + 1.3, cabY + 9.2, cz - 0.5]);
  const jx0 = cx, jz0 = cz + 2.5;
  const jx1 = GANTRY.x - 6, jz1 = GANTRY.z - GANTRY.d / 2 - 2.6;
  const jTop0 = cabY, jTop1 = GANTRY.y + 3;
  const breaks: [number, number][] = [[0, 0.34], [0.375, 0.69], [0.725, 1]];
  const jl = Math.hypot(jx1 - jx0, jz1 - jz0);
  for (const [a, bb] of breaks) {
    const ax = jx0 + (jx1 - jx0) * a, az = jz0 + (jz1 - jz0) * a;
    const bx = jx0 + (jx1 - jx0) * bb, bz = jz0 + (jz1 - jz0) * bb;
    b.beam(ax, az, bx, bz, jTop0 + (jTop1 - jTop0) * a, 0.6, 'hazard', jTop0 + (jTop1 - jTop0) * bb);
  }
  // lattice chords under the jib
  const jry = Math.atan2(jx1 - jx0, jz1 - jz0);
  for (let i = 0; i <= 24; i++) {
    const f = i / 24;
    const px = jx0 + (jx1 - jx0) * f, pz = jz0 + (jz1 - jz0) * f;
    const top = jTop0 + (jTop1 - jTop0) * f;
    if (f > 0.02) b.deco([px, top - 1.0, pz], [0.12, 1.6, 0.12], 'steel', jry);
  }
  b.prop('cable', [jx0, jTop0 + 1, jz0], { q: [jx1, jTop1 - 1.4, jz1] });
  b.prop('cable', [cx + 1.3, cabY + 8.9, cz - 0.5], { q: [jx0 + (jx1 - jx0) * 0.5, jTop0 + (jTop1 - jTop0) * 0.5, jz0 + (jz1 - jz0) * 0.5] });
  b.zone('Crane Jib', Math.min(jx0, jx1) - 2, jz0, Math.max(jx0, jx1) + 2, jz1);
  void jl;

  // ------------------------------------------------------------ smokestacks (wind)
  b.section('Smokestacks');
  let c = b.cursor(R1.x, R1.y, R1.z + R1.d / 2, 0);
  const z0 = c.z;
  c = b.chain(c, [
    { t: 'plat', len: 4, w: 4, mat: 'metal', hazard: 'n' },
    { t: 'beam', gap: 3, dy: 0.5, len: 14, w: 0.8 },
    { t: 'plat', len: 6, w: 6, mat: 'metal', hazard: '' },
    { t: 'plat', gap: 4.5, dy: 1, len: 5, w: 5, mat: 'rust' },
    { t: 'beam', gap: 2, len: 16, w: 0.7 },
    { t: 'plat', len: 8, w: 8, mat: 'metal', hazard: '' },
  ]);
  // the flue gantry is gone: swing from hook to hook, land on the flue walkway, slide under its beam
  const swZ = c.z, swY = c.y;
  c = b.chain(c, [
    { t: 'skip', len: 20.5, dy: 2 },
    { t: 'plat', len: 10.5, w: 3.2, rails: 'ew', mat: 'grate', hazard: 's' },
    { t: 'plat', len: 8, w: 8, mat: 'metal', hazard: '' },
  ]);
  b.grapple([R1.x, swY + 9, swZ + 6], { mount: [R1.x + 4.5, -110, swZ + 6] });
  b.grapple([R1.x, swY + 10.5, swZ + 14.5], { mount: [R1.x - 4.5, -110, swZ + 14.5] });
  // 5 s a sweep (was 4.2): you arrive off the double swing and cannot choose the moment you land,
  // so at the old pace some landings put the beam on you before any slide could start. Every
  // landing now leaves time to slide; timing the slide is still the test.
  b.laserBar(R1.x - 1.7, swZ + 23.5, R1.x + 1.7, swZ + 23.5, swY + 2 + 1.3, [0, 0, 6.5], 5.0);
  b.hint('grapple', R1.x, swY, swZ - 3, 6, 'Grapple: jump off the edge, aim at the green anchor and press the right mouse button. Hold forward, then let go (right mouse or Space) as you swing up.');
  b.hint('slidebar', R1.x, swY + 2, swZ + 20.5, 3, 'Chest-high beam: slide under it (C while running).');
  // chimneys
  const stacks: [number, number][] = [[R1.x - 5.5, z0 + 24], [R1.x + 6.5, z0 + 58.5], [R1.x - 6, z0 + 97]];
  for (const [sx, sz] of stacks) {
    b.block(sx, -110, sz, 3.4, 172, 3.4, 'invisible', 0, { visible: false, sight: true });
    b.prop('chimney', [sx, -110, sz], { s: [2, 172, 2] });
    b.prop('redLight', [sx, 62.4, sz]);
  }
  // sentinel on a ring platform around the middle chimney
  const [mx, mz] = stacks[1];
  b.plat(mx, 52, mz, 6.5, 6.5, { mat: 'metal', hazard: 'nsew', supports: false, th: 0.6 });
  b.enemy('ranged', mx - 1.5, 52, mz - 2.6, PI + 0.35);
  // gusts across the beams
  b.wind([R1.x - 2.5, R1.y, z0 + 6], [R1.x + 2.5, R1.y + 2.6, z0 + 21], [1, 0], 8.5, 5, 0.38, 0);
  b.wind([R1.x - 2.5, R1.y, z0 + 38], [R1.x + 2.5, R1.y + 7, z0 + 55], [-1, 0.15], 9.5, 4.4, 0.42, 0.5);
  b.prop('windsock', [R1.x + 2.6, R1.y + 0.5, z0 + 3.5]);
  b.prop('windsock', [R1.x - 3.5, R1.y + 1.5, z0 + 34]);
  b.zone('Smokestacks', R1.x - 8, z0, R1.x + 8, c.z);
  b.waypoint('Smokestacks', R1.x, R1.y + 0.1, z0 + 2);

  // ------------------------------------------------------------ antenna array
  b.section('Antenna Array');
  c = b.chain(c, [
    { t: 'stairs', len: 8, w: 3, dy: 4 },
    { t: 'plat', len: 6, w: 5, mat: 'metal' },
    // rests 24% of its cycle at each end (default 18%): at some arrivals the old boarding
    // window could not be made even with a perfect run-up
    { t: 'mover', gap: 2.2, len: 4.3, w: 4, move: [0, 0, 10], period: 6, pause: 0.24 },
    { t: 'skip', len: 10 },
    { t: 'plat', gap: 2.5, len: 10, w: 10, mat: 'metal', hazard: '' },
  ]);
  const base1 = c.z - 5, base1Top = c.y, base1End = c.z;
  // launch pad up onto the relay dish deck, then a drop-jump onto base 2
  c = b.chain(c, [
    { t: 'skip', len: 11 },
    { t: 'plat', len: 10.5, w: 6, dy: 8, mat: 'white', hazard: 'n' },
    { t: 'plat', gap: 5.5, dy: -4.4, len: 10, w: 6, mat: 'metal', hazard: '' },
  ]);
  b.launchPad(R1.x, base1Top + 0.12, base1End - 1.8, [R1.x, base1Top + 8, base1End + 16.25], 3.5);
  b.hint('launch', R1.x, base1Top, base1End - 6, 5, 'Launch pads throw you onto the next platform. Just step on, you can steer a little in the air.');
  b.prop('dish', [R1.x - 1.5, base1Top + 8, base1End + 14], { ry: 2.8 });
  b.pickup('shield', R1.x + 2, base1Top + 8, base1End + 19);
  const base2 = c.z - 5, base2y = c.y;
  c = b.chain(c, [
    { t: 'beam', len: 20, w: 0.9 },
    { t: 'plat', len: 8, w: 8, mat: 'metal' },
    { t: 'plat', len: 12, w: 8, mat: 'metal', hazard: 'ew' },
  ]);
  const sweepZ = c.z - 6, sweepY = c.y;
  c = b.chain(c, [
    { t: 'plat', gap: 3, dy: 1, len: 6, w: 6, mat: 'metal' },
    { t: 'plat', len: 10, w: 10, mat: 'metal', hazard: '' },
    { t: 'beam', len: 12, w: 0.8 },
    { t: 'plat', len: 6, w: 6, mat: 'metal' },
    { t: 'crumble', gap: 2, len: 4, w: 4 },
    { t: 'crumble', gap: 2, len: 4, w: 4 },
  ]);
  b.sweeper(R1.x, sweepY + 0.25, sweepZ, 8, -1.4);
  // antennas + dishes
  b.tower(R1.x + 3.5, base1 + 3.5, 49 + 12, 0.8);
  b.prop('dish', [R1.x - 3, 49, base1 - 2.5], { ry: 0.7 });
  b.tower(R1.x - 2.2, base2 + 2.5, base2y + 14, 0.8);
  b.prop('dish', [R1.x + 1.8, base2y, base2 + 3], { ry: -0.6 });
  // sentinel on a mast platform covering the white steps and base 2
  b.tower(R1.x + 13, base2 - 8, base2y + 4.6, 1.6, { light: false });
  b.plat(R1.x + 13, base2y + 5.6, base2 - 8, 3.4, 3.4, { mat: 'metal', hazard: 'nsew', supports: false });
  b.enemy('ranged', R1.x + 13, base2y + 5.6, base2 - 8, -1.75);
  b.enemy('flyer', R1.x, base2y + 7, base2 + 18, PI, {
    patrol: [[R1.x - 5, base2y + 6, base2 + 8], [R1.x + 5, base2y + 7, base2 + 26], [R1.x - 4, base2y + 8, base2 + 44], [R1.x + 4, base2y + 7, base2 + 30]],
  });
  b.zone('Antenna Array', R1.x - 10, z0 + 101.5, R1.x + 12, c.z);
  b.waypoint('Antenna Array', R1.x, 49.1, base1 - 3);

  c = buildSkybridge(b, c);

  // ------------------------------------------------------------ leap of faith
  b.section('Leap of Faith');
  const ringInnerX = RING.x - RING_OUTER; // outer edge of the ring's west segment
  const leapTop = c.y;
  const leapZ0 = c.z + 2;
  const leapLen = RING.z - RING_SIDE / 2 + 7 - leapZ0;
  const leapCx = ringInnerX - 9.5 - 5;
  b.plat(leapCx, leapTop, leapZ0 + leapLen / 2, 10, leapLen, { mat: 'metal', hazard: 'e' });
  b.prop('windsock', [leapCx + 4.3, leapTop, leapZ0 + 1]);
  b.prop('redLight', [leapCx + 4.6, leapTop + 0.2, leapZ0 + leapLen - 0.5]);
  b.prop('redLight', [leapCx + 4.6, leapTop + 0.2, leapZ0 + 0.5]);
  // the long way down: drop hops north, then east into the ring
  b.section('Long Way Down');
  c = b.cursor(leapCx, leapTop, leapZ0 + leapLen, 0);
  c = b.chain(c, [
    { t: 'plat', gap: 2.5, dy: -3.2, len: 5, w: 5, mat: 'rust' },
    { t: 'corner', gap: 2.5, dy: RING.y - (leapTop - 3.2), size: 5, turn: PI / 2, mat: 'rust' },
  ]);
  c = b.chain(c, [
    { t: 'plat', len: ringInnerX - c.x - 5, w: 4, mat: 'metal', rails: 'ew', hazard: '' },
    { t: 'plat', gap: 2.5, len: 2.5, w: 4, mat: 'metal', hazard: '' },
  ]);
  // rescue hook for a Leap of Faith that falls short
  b.grapple([ringInnerX - 3.5, RING.y + 6.5, leapZ0 + leapLen - 7], { optional: true, mount: [ringInnerX - 3.5, -110, leapZ0 + leapLen + 1.5] });
  b.zone('Leap of Faith', leapCx - 5, leapZ0, ringInnerX, leapZ0 + leapLen + 22);
  b.waypoint('Leap of Faith', leapCx, leapTop + 0.1, leapZ0 + 3);
}

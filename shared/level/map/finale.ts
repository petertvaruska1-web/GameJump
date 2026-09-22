// Reactor ring (all routes merge) + final approach from the Foothills (slow
// covered elevator vs fast exposed broken stairway) + the Spire with the finish gate.

import type { LevelBuilder } from '../builder';
import { FOOT, RING, RING_OUTER, RING_SIDE, SPIRE } from './layout';

const PI = Math.PI;

export function buildRing(b: LevelBuilder) {
  b.section('Reactor Ring');
  const { x, y, z, R, width, segments } = RING;
  for (let k = 0; k < segments; k++) {
    const phi = (k * 2 * PI) / segments;
    const sx = x + R * Math.sin(phi), sz = z + R * Math.cos(phi);
    // local +z points outward; inner edge ('s') is the drop into the reactor pit
    const outerRails = k === 1 || k === 3 || k === 5 ? 'n' : '';
    b.plat(sx, y, sz, RING_SIDE, width, { ry: phi, mat: 'metal', hazard: 's', th: 1.4, rails: outerRails });
  }
  // reactor core: tall, blocks sight across the ring
  const coreBottom = y - 26, coreTop = y + 16;
  b.box([x, (coreBottom + coreTop) / 2, z], [13, coreTop - coreBottom, 13], 'invisible', { visible: false, sight: true });
  b.box([x, (coreBottom + coreTop) / 2, z], [13, coreTop - coreBottom, 13], 'invisible', { visible: false, sight: true, ry: PI / 4 });
  b.prop('tank', [x, coreBottom, z], { s: [7.2, coreTop - coreBottom, 7.2], v: 1 });
  // maintenance spokes from ring to core: solid, so a slip off the inner edge can land on one
  for (let k = 0; k < 4; k++) {
    const a = PI / 4 + (k * PI) / 2;
    const r0 = 7.4, r1 = RING.R - width / 2;
    b.box([x + Math.sin(a) * (r0 + r1) / 2, y - 3, z + Math.cos(a) * (r0 + r1) / 2], [0.8, 0.8, r1 - r0], 'steel', { ry: a, sight: false });
  }
  // cover blocks on the ring
  for (const k of [1, 3, 5, 7]) {
    const phi = (k * 2 * PI) / segments;
    b.block(x + (R + 1.2) * Math.sin(phi), y, z + (R + 1.2) * Math.cos(phi), 3.2, 2.6, 1.4, 'concreteDark', phi);
  }
  for (const k of [0, 2, 4, 6]) {
    const phi = (k * 2 * PI) / segments;
    b.prop('lamp', [x + (R + 3) * Math.sin(phi + 0.3), y, z + (R + 3) * Math.cos(phi + 0.3)]);
  }
  // enemies: a patrolling stalker, a sentinel on the north-left pylon, a drone circling the core
  const mid = R / Math.cos(PI / segments);
  const loop: [number, number, number][] = [];
  for (let k = 0; k < segments; k++) {
    const a = ((k + 0.5) * 2 * PI) / segments;
    loop.push([x + mid * Math.sin(a) * 0.97, y, z + mid * Math.cos(a) * 0.97]);
  }
  b.enemy('melee', loop[0][0], y, loop[0][2], PI / 2, { patrol: loop, leash: 70 });
  const px = x + 25, pz = z + 25;
  b.tower(px, pz, y + 8, 2.2, { light: true });
  b.plat(px, y + 9, pz, 3.8, 3.8, { mat: 'metal', hazard: 'nsew', supports: false });
  b.enemy('ranged', px, y + 9, pz, -2.5);
  b.enemy('flyer', x - 16, y + 9, z, 0, {
    patrol: [[x - 16, y + 9, z], [x, y + 10, z + 16], [x + 16, y + 9, z], [x, y + 10, z - 16]],
  });
  b.zone('Reactor Ring', x - RING_OUTER, z - RING_OUTER, x + RING_OUTER, z + RING_OUTER);
  b.waypoint('Reactor Ring', x, y + 0.1, z - R);
}

export function buildFinale(b: LevelBuilder) {
  const y0 = FOOT.y;
  const jz0 = FOOT.z1;
  const jz = jz0 + 4.5;

  b.section('Final Junction');
  b.plat(0, y0, jz, 10, 9, { mat: 'concrete', hazard: 'n' });
  b.prop('lamp', [4.2, y0, jz + 3.8]);
  b.prop('lamp', [-4.2, y0, jz + 3.8]);
  b.zone('Final Junction', -5, jz0, 5, jz0 + 9);
  b.waypoint('Final Junction', 0, y0 + 0.1, jz);

  const S = SPIRE;
  const sHalf = S.size / 2;

  // ------------------------------------------------------------ service elevator (+X)
  b.section('Service Elevator');
  let c = b.cursor(5, y0, jz, PI / 2);
  c = b.chain(c, [
    { t: 'plat', len: 8, w: 3, rails: 'ew', mat: 'grate', hazard: '' },
    { t: 'corner', size: 5, turn: -PI / 2, mat: 'metal' },
    { t: 'mover', gap: 0.4, len: 4, w: 4, move: [0, S.y - 2 - y0, 0], period: 15, pause: 0.3, mat: 'hazard' },
  ]);
  const ex = c.x, ez0 = c.z - 4;
  // shaft (cover on the spire side)
  const topY = S.y - 2;
  b.block(ex - 2.35, y0 - 1, ez0 + 2, 0.3, topY - y0 + 4, 4.4, 'steel');
  b.block(ex + 2.35, y0 + 3, ez0 + 2, 0.3, topY - y0, 4.4, 'grate', 0, { sight: false });
  for (const [dx, dz] of [[-2.3, -0.2], [2.3, -0.2], [-2.3, 4.2], [2.3, 4.2]]) b.deco([ex + dx, (y0 + topY) / 2 + 1, ez0 + dz], [0.35, topY - y0 + 5, 0.35], 'hazard');
  b.prop('redLight', [ex - 2.3, topY + 3.2, ez0 - 0.2]);
  c = b.chain(c, [{ t: 'skip', len: 0.4, dy: topY - y0 }]);
  const walkLen = S.z - 2 - c.z;
  c = b.chain(c, [
    { t: 'plat', len: walkLen, w: 3, rails: 'e', mat: 'grate', hazard: '', supports: false, th: 0.5 },
    { t: 'corner', size: 4, turn: -PI / 2, mat: 'metal', supports: false },
    { t: 'stairs', len: c.x - 2 - sHalf, w: 3, dy: 2 },
  ]);
  // cover wall along the walkway (hides you from the spire sentinel)
  b.block(ex - 1.7, topY, (c.z + ez0) / 2 + 2, 0.3, 2.3, walkLen - 4, 'concreteDark');
  for (let zz = ez0 + 8; zz < S.z - 6; zz += 11) {
    b.tower(ex + 2.8, zz, topY + 6, 0.5, { light: false });
    b.prop('cable', [ex + 2.8, topY + 6, zz], { q: [ex + 1.4, topY + 0.2, zz + 3] });
  }
  b.zone('Service Elevator', 5, jz0, ex + 4, S.z + 3);

  // ------------------------------------------------------------ broken stairway (-X)
  b.section('Broken Stairway');
  c = b.cursor(-5, y0, jz, -PI / 2);
  c = b.chain(c, [
    { t: 'plat', len: 8, w: 5, mat: 'concrete', hazard: '' },
    { t: 'corner', size: 5, turn: PI / 2, mat: 'concrete' },
    { t: 'plat', gap: 3, dy: 1.2, len: 3.5, w: 3.5, mat: 'rust' },
    { t: 'plat', gap: 3, dy: 1.2, len: 3.5, w: 3.5, off: 1.5, mat: 'rust' },
    { t: 'plat', gap: 3.2, dy: 1.2, len: 3.5, w: 3.5, off: -1, mat: 'rust' },
    { t: 'plat', gap: 2.5, dy: 1.0, len: 6, w: 5, mat: 'concrete' },
    { t: 'stairs', len: 8, w: 3, dy: 4 },
    { t: 'plat', gap: 3, dy: 1.2, len: 3.5, w: 3.5, mat: 'rust' },
    { t: 'plat', gap: 3.4, dy: 1.2, len: 3.5, w: 3.5, off: 1.5, mat: 'rust' },
    { t: 'plat', gap: 3, dy: 1.2, len: 3.5, w: 3.5, mat: 'rust' },
    { t: 'stairs', len: 9, w: 3, dy: 5.6 },
    { t: 'plat', len: 4, w: 4, mat: 'concrete', hazard: 'e' },
  ]);
  b.prop('debris', [-17.35, y0 + 3.6, jz + 19.5], { ry: 0.3 });
  b.grapple([-15.5, y0 + 9.5, jz + 13.8], { optional: true, mount: [-20.5, -110, jz + 13.8] });
  b.prop('debris', [-14.5, y0 + 9.8, jz + 44], { ry: 2.1 });
  b.enemy('flyer', -22, y0 + 12, jz + 32, 0, {
    patrol: [[-22, y0 + 10, jz + 14], [-24, y0 + 15, jz + 46], [-11, y0 + 14, jz + 34], [-20, y0 + 18, jz + 64]],
  });
  b.zone('Broken Stairway', -21, jz0, -5, S.z + 12);

  // ------------------------------------------------------------ the spire
  b.section('Spire');
  b.plat(S.x, S.y, S.z, S.size, S.size, { mat: 'white', hazard: 'ew', supports: false, th: 1.2, rails: 'ns' });
  b.box([S.x, (S.y - 1.2 - 110) / 2, S.z], [14, S.y - 1.2 + 110, 14], 'concreteDark');
  for (let i = 0; i < 12; i++) b.deco([S.x, S.y - 4 - i * 5, S.z], [14.3, 1.2, 14.3], i % 3 === 0 ? 'lightCyan' : 'glass');
  // balcony with the final sentinel
  b.plat(S.x, S.y - 7, S.z - 7 - 2, 6, 4, { mat: 'metal', hazard: 's', supports: false, th: 0.6 });
  b.enemy('ranged', S.x, S.y - 7, S.z - 9.6, PI);
  // finish gate + beacon
  b.block(S.x - 4, S.y, S.z + 1, 0.9, 6.5, 0.9, 'white');
  b.block(S.x + 4, S.y, S.z + 1, 0.9, 6.5, 0.9, 'white');
  b.deco([S.x, S.y + 6.8, S.z + 1], [9, 0.7, 1.1], 'lightCyan');
  b.deco([S.x, S.y + 0.02, S.z], [8, 0.04, 8], 'finish');
  b.prop('beacon', [S.x, S.y, S.z]);
  for (const [dx, dz] of [[-sHalf + 0.6, -sHalf + 0.6], [sHalf - 0.6, -sHalf + 0.6], [-sHalf + 0.6, sHalf - 0.6], [sHalf - 0.6, sHalf - 0.6]]) {
    b.prop('redLight', [S.x + dx, S.y + 0.2, S.z + dz]);
  }
  b.zone('Spire', S.x - sHalf, S.z - sHalf, S.x + sHalf, S.z + sHalf);
  b.waypoint('Spire', S.x + 6, S.y + 0.1, S.z - 6);
}

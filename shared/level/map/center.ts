// Start pad + CENTRE route: broken bridge -> plaza -> gantry -> twin rails ->
// collapsed viaduct -> ring approach. Medium length, open sightlines.

import type { LevelBuilder } from '../builder';
import { buildCableYards } from './band4';
import { GANTRY, PLAZA, START, VIADUCT_Z0 } from './layout';

const PI = Math.PI;

export function buildStart(b: LevelBuilder) {
  b.section('Start');
  const { x, y, z, w, d } = START;
  b.plat(x, y, z, w, d, { mat: 'concrete', hazard: '', th: 2.2 });
  b.rails(x, y, z - d / 4, w, d / 2, 0, 'ew');
  b.rails(x, y, z, w, d, 0, 's');
  // painted landing marks
  b.deco([-1.5, y + 0.015, -3.5], [0.45, 0.03, 4.2], 'white');
  b.deco([1.5, y + 0.015, -3.5], [0.45, 0.03, 4.2], 'white');
  b.deco([0, y + 0.015, -3.5], [2.6, 0.03, 0.45], 'white');
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * PI * 2;
    b.deco([Math.sin(a) * 4.6, y + 0.012, -3.5 + Math.cos(a) * 4.6], [3.2, 0.024, 0.35], 'hazard', a + PI / 2);
  }
  // clutter
  b.crate(-9.2, y, -7, 1.3);
  b.crate(-7.7, y, -7.6, 1.0, 0.3);
  b.crate(-9.1, y + 1.3, -7.1, 0.9, 0.5);
  b.crate(9, y, 7.5, 1.1, 0.2);
  b.prop('barrel', [10.2, y, 6.6]);
  b.prop('barrel', [10.6, y, 5.6]);
  b.prop('lamp', [10.8, y, -8.8]);
  b.prop('lamp', [-10.8, y, -8.8]);
  b.prop('windsock', [11.2, y, -2]);
  b.prop('antenna', [-10.6, y, -1], { s: [1, 9, 1] });
  // gate framing the bridge + beacon view
  b.block(-3.2, y, 9.3, 0.8, 5.2, 0.8, 'steel');
  b.block(3.2, y, 9.3, 0.8, 5.2, 0.8, 'steel');
  b.deco([0, y + 5.45, 9.3], [7.3, 0.6, 0.95], 'hazard');
  b.prop('redLight', [-3.2, y + 5.3, 9.3]);
  b.prop('redLight', [3.2, y + 5.3, 9.3]);
  b.zone('Start', -14, -12, 14, 12);
  b.waypoint('Start', 0, y + 0.1, 0);
}

export function buildCenter(b: LevelBuilder) {
  // ------------------------------------------------------------ broken bridge
  b.section('Broken Bridge');
  let c = b.cursor(0, START.y, START.z + START.d / 2, 0);
  c = b.chain(c, [
    { t: 'plat', len: 10, w: 4, mat: 'metal', rails: 'ew', hazard: 'n' },
    { t: 'plat', gap: 3.0, len: 7, w: 4, dy: -0.5, mat: 'metal', hazard: 'ns' },
    // the deck is gone here: only one bent girder still spans the hole, sloping down
    { t: 'ramp', len: 4.5, w: 0.8, dy: -1, mat: 'steel' },
    { t: 'plat', len: 9, w: 3.5, mat: 'metal', hazard: 'ns', rails: 'e' },
    { t: 'crumble', gap: 2.4, len: 4, w: 3.5 },
    { t: 'plat', gap: 2.0, len: 5, w: 4, dy: -0.5, mat: 'metal', hazard: 's' },
    { t: 'stairs', len: 5, w: 4, dy: -2 },
  ]);
  // collapsed railing lying across the deck: vault it
  b.block(0, 38.5, 39, 3.5, 0.8, 0.5, 'hazard', 0.06);
  b.prop('debris', [1.1, 39.3, 20.6], { ry: 0.4 });
  b.prop('debris', [-1.6, 37.6, 32.4], { ry: 2.2 });
  b.deco([1.3, 38.2, 32.2], [0.5, 0.4, 4.2], 'steel', 0.25);
  b.prop('cable', [-2, 44, 15], { q: [-2, 39.6, 30] });
  b.prop('cable', [2, 44, 15], { q: [2, 39.6, 30] });
  b.tower(-2.6, 15, 44, 0.6, { light: true });
  b.tower(2.6, 15, 44, 0.6, { light: false });
  b.zone('Broken Bridge', -6, 10, 6, c.z);

  // ------------------------------------------------------------ plaza
  b.section('Plaza');
  const py = PLAZA.y;
  const pz = c.z + PLAZA.d / 2;
  b.plat(0, py, pz, PLAZA.w, PLAZA.d, { mat: 'concrete', hazard: '', th: 2.2 });
  // cover: pillars, containers, monument
  b.block(-6, py, pz - 6, 1.7, 4.6, 1.7, 'concreteDark');
  b.block(7.5, py, pz - 3, 1.7, 4.6, 1.7, 'concreteDark');
  b.block(-2.5, py, pz + 7, 1.7, 4.6, 1.7, 'concreteDark');
  b.block(9, py, pz + 5.5, 1.7, 4.6, 1.7, 'concreteDark');
  b.container(11, py, pz + 10, 0.15);
  b.container(-10.5, py, pz + 1.5, -0.08);
  b.block(1, py, pz - 1, 4, 1.0, 4, 'concrete');
  b.block(1, py + 1, pz - 1, 1.4, 3.4, 1.4, 'white');
  b.prop('debris', [2.8, py + 1, pz - 2.2], { ry: 1.1 });
  // low barriers (vault over; they do not hide you)
  b.block(-7.5, py, pz + 10.5, 5, 0.9, 0.6, 'hazard');
  b.block(4.5, py, pz + 12.5, 4, 0.9, 0.6, 'hazard', 0.1);
  b.block(-12, py, pz - 9, 0.6, 0.9, 5, 'hazard');
  b.crate(12.5, py, pz - 11, 1.3, 0.2);
  b.crate(-12.8, py, pz + 12.4, 1.2);
  for (const [lx, lz] of [[-14, -14], [14, -14], [-14, 14], [14, 14]]) b.prop('lamp', [lx, py, pz + lz]);
  // sentinel tower overlooking the plaza (and the end of the bridge)
  b.tower(19.5, pz + 13, py + 8, 2.2, { light: false });
  b.plat(19.5, py + 9, pz + 13, 4.2, 4.2, { mat: 'metal', hazard: 'nsew', supports: false });
  b.prop('redLight', [21.3, py + 9.2, pz + 14.8]);
  b.enemy('ranged', 19.5, py + 9, pz + 13, Math.atan2(-19.5, -15));
  // stalker guarding the north-right corner: paces between the container and the far pillar, in the open
  b.enemy('melee', -12.8, py, pz + 7.4, PI / 2, { patrol: [[-12.8, py, pz + 7.4], [-5.6, py, pz + 7.4]] });
  b.zone('Plaza', -15, pz - 15, 15, pz + 15);
  b.waypoint('Plaza', 0, py + 0.1, pz - 12);

  // X-link to the right route: container stack up to the water-tower roof
  b.section('Plaza Climb');
  let x = b.cursor(-PLAZA.w / 2, py, pz, -PI / 2);
  b.chain(x, [
    { t: 'plat', gap: 2.5, len: 5, w: 5, dy: 1, mat: 'rust', hazard: '' },
    { t: 'plat', gap: 2.5, len: 4.5, w: 4, dy: 1.2, mat: 'rust', hazard: '' },
    { t: 'plat', gap: 2.2, len: 4, w: 4, dy: 1.2, mat: 'rust', hazard: '' },
  ]);

  // ------------------------------------------------------------ gantry approach
  b.section('Gantry Approach');
  c = b.cursor(0, py, pz + PLAZA.d / 2, 0);
  c = b.chain(c, [
    { t: 'plat', len: 6, w: 6, hazard: 'n', mat: 'concrete' },
    { t: 'mover', gap: 2.2, len: 5.8, w: 5, move: [0, 0, 9], period: 6.5 },
    { t: 'skip', len: 9 },
    { t: 'plat', gap: 2, len: 12, w: 9, mat: 'metal', hazard: 'ns' },
    { t: 'plat', gap: 3.5, dy: 1, len: 6, w: 4, mat: 'metal' },
    { t: 'plat', gap: 2.5, dy: 1, len: 6, w: 4, mat: 'metal' },
  ]);
  const sweepZ = pz + PLAZA.d / 2 + 6 + 3 + 5 + 9 + 2 + 6;
  b.sweeper(0, py + 0.25, sweepZ, 8.5, 1.25);
  // sentinel watching the sweeper deck and the climbing steps
  b.tower(12, 134, py + 9, 2, { light: true });
  b.plat(12, py + 10, 134, 3.6, 3.6, { mat: 'metal', hazard: 'nsew', supports: false });
  b.enemy('ranged', 12, py + 10, 134, -2.31);
  b.zone('Gantry Approach', -10, pz + 15, 10, GANTRY.z - GANTRY.d / 2);

  // ------------------------------------------------------------ gantry deck
  b.section('Gantry');
  const g = GANTRY;
  b.plat(g.x, g.y, g.z, g.w, g.d, { mat: 'metal', hazard: '', th: 1.6 });
  // crane frame
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) b.tower(sx * 11.6, g.z + sz * 10, g.y + 14, 1.2, { light: sz > 0 });
    b.deco([sx * 11.6, g.y + 14.3, g.z], [1.0, 1.0, 21.2], 'hazard');
  }
  b.deco([0, g.y + 14.3, g.z + 2], [23.2, 1.2, 1.4], 'steel');
  b.deco([0, g.y + 13.2, g.z + 2], [3.6, 1.8, 3.2], 'hazard');
  b.prop('cable', [0, g.y + 12.3, g.z + 2], { q: [0, g.y + 5, g.z + 2] });
  b.deco([0, g.y + 4.6, g.z + 2], [1.4, 0.8, 1.4], 'steel');
  // control booth (cover)
  b.building(-6, g.y, g.z + 6, 5, 5, 3.2, { doors: [{ side: 's', width: 1.6, height: 2.4 }], floor: false });
  b.crate(6, g.y, g.z - 6, 1.3);
  // crates stacked beside the control booth lead onto its roof, where a shield waits
  b.crate(-2.6, g.y, g.z + 10.2, 1.3);
  b.crate(-2.6, g.y + 1.3, g.z + 10.2, 1.0, 0.3);
  b.pickup('shield', -6, g.y + 3.7, g.z + 6);
  b.crate(7.3, g.y, g.z - 4.9, 1.0, 0.4);
  b.container(5.5, g.y, g.z + 7, PI / 2);
  b.prop('lamp', [-9.2, g.y, g.z - 11]);
  b.prop('lamp', [9.2, g.y, g.z - 11]);
  b.enemy('flyer', 0, g.y + 7, g.z, PI, {
    patrol: [[-6, g.y + 7, g.z - 8], [6, g.y + 7.5, g.z + 8], [0, g.y + 8, g.z + 26], [-8, g.y + 7, g.z + 4]],
  });
  // stalker patrolling the deck edge where the foundry bridge lands
  b.enemy('melee', 8.6, g.y, g.z - 10, -PI / 2, {
    patrol: [[8.6, g.y, g.z - 10], [-8, g.y, g.z - 10], [-8.5, g.y, g.z + 1], [9, g.y, g.z]], leash: 26,
  });
  b.zone('Gantry', -12, g.z - g.d / 2, 12, g.z + g.d / 2);
  b.waypoint('Gantry', 0, g.y + 0.1, g.z - 10);

  // ------------------------------------------------------------ twin rails
  b.section('Twin Rails');
  const r0 = g.z + g.d / 2;
  b.beam(3, r0, 3, r0 + 14, g.y, 1.0);
  b.beam(3, r0 + 17, 3, VIADUCT_Z0, g.y, 1.0);
  b.beam(-3, r0, -3, r0 + 20.5, g.y, 1.0);
  b.beam(-3, r0 + 23, -3, VIADUCT_Z0, g.y, 1.0);
  for (let zz = r0 + 1.5; zz < VIADUCT_Z0 - 1; zz += 3.2) {
    const brokenA = zz > r0 + 13.5 && zz < r0 + 17.5;
    const brokenB = zz > r0 + 20 && zz < r0 + 23.5;
    if (!brokenA && !brokenB) b.deco([0, g.y - 0.7, zz], [7.4, 0.3, 0.5], 'rust');
  }
  b.prop('debris', [3, g.y - 0.6, r0 + 14.4], { ry: 0.2 });
  b.prop('debris', [-3, g.y - 0.6, r0 + 22.8], { ry: 2.8 });
  b.enemy('flyer', 0, g.y + 6, r0 + 16, PI, { patrol: [[-4, g.y + 6, r0 + 4], [4, g.y + 7, r0 + 18], [-3, g.y + 6, r0 + 28]], leash: 30 });
  // detour: swing off the east rail to a hidden ledge with a boost crate, then walk a plank to the viaduct
  b.plat(10, g.y, r0 + 18, 4, 4, { mat: 'metal', hazard: 'nsew' });
  b.grapple([6.5, g.y + 7, r0 + 18], { optional: true, mount: [10.8, g.y, r0 + 18] });
  b.pickup('boost', 10, g.y, r0 + 18);
  b.beam(10, r0 + 20, 4.5, VIADUCT_Z0 + 1, g.y, 0.8, 'rust');
  b.zone('Twin Rails', -6, r0, 6, VIADUCT_Z0);

  // ------------------------------------------------------------ viaduct
  b.section('Viaduct');
  const vy = g.y;
  const v0 = VIADUCT_Z0;
  b.plat(0, vy, v0 + 12, 10, 24, { mat: 'concrete', hazard: 'n', th: 2.4 });
  b.block(2.3, vy, v0 + 12, 2.8, 3, 9, 'rust', 0.12);
  b.block(-3, vy, v0 + 18.5, 1.5, 2.8, 1.5, 'concreteDark');
  b.block(-3.2, vy, v0 + 5, 1.4, 2.4, 1.4, 'concreteDark');
  // stalker working the far end of the first slab, clear of the rust block, right where the swing starts
  b.enemy('melee', -1.5, vy, v0 + 21.5, 0, {
    patrol: [[-1.5, vy, v0 + 21.5], [3.5, vy, v0 + 21.5], [4, vy, v0 + 18], [-0.5, vy, v0 + 17.5]], leash: 24,
  });
  // the span beyond this stub collapsed: swing across on a hook hanging from the surviving arch
  b.plat(0, vy, v0 + 26, 6, 4, { mat: 'concrete', hazard: 'n', th: 2.4 });
  b.prop('debris', [1.8, vy, v0 + 25.5], { ry: 0.9 });
  const archZ = v0 + 35;
  for (const sx of [-5.5, 5.5]) b.tower(sx, archZ, vy + 10.6, 1.0, { light: true });
  b.deco([0, vy + 10.3, archZ], [12, 0.7, 0.8], 'concreteDark');
  b.deco([0, vy + 9.75, archZ], [0.12, 0.9, 0.12], 'steel');
  b.grapple([0, vy + 9, archZ]);
  b.hint('grapple', 0, vy, v0 + 22, 8, 'Grapple: jump off the edge, aim at the green anchor and press the right mouse button. Hold forward, then let go (right mouse or Space) as you swing up.');
  const v3y = vy + 1.5;
  b.plat(0, v3y, v0 + 52, 10, 20, { mat: 'concrete', hazard: 'ns', th: 2.4 });
  b.container(-2.5, v3y, v0 + 48, 0.05);
  b.block(3.2, v3y, v0 + 57, 1.6, 3.2, 1.6, 'concreteDark');
  // crumbling floor row vs narrow exposed beam
  b.crumble(0, v3y, v0 + 66.5, 4, 4);
  b.crumble(-0.5, v3y, v0 + 72.5, 4, 4);
  b.crumble(0.5, v3y, v0 + 78.5, 4, 4);
  b.beam(4.6, v0 + 62, 4.6, v0 + 82.5, v3y, 0.6);
  b.plat(0, v3y, v0 + 94.5, 10, 24, { mat: 'concrete', hazard: 's', th: 2.4 });
  b.container(2.6, v3y, v0 + 90, 0.1);
  b.block(-3.4, v3y, v0 + 99, 1.6, 3.4, 1.6, 'concreteDark');
  b.container(-2.4, v3y, v0 + 103.5, -0.12);
  b.crate(3.5, v3y, v0 + 101, 1.2);
  for (const zz of [v0 + 2, v0 + 44, v0 + 86, v0 + 104]) b.prop('lamp', [4.4, zz < v0 + 40 ? vy : v3y, zz]);
  // a sentinel on the west pylon looks down the length of the viaduct (the east post stands empty)
  for (const sx of [-7.5, 7.5]) {
    b.tower(sx, v0 + 114, v3y + 6, 2.2, { light: sx < 0 });
    b.plat(sx, v3y + 7, v0 + 114, 3.6, 3.6, { mat: 'metal', hazard: 'nsew', supports: false });
  }
  b.enemy('ranged', -7.5, v3y + 7, v0 + 114, PI - 0.12);
  b.zone('Viaduct', -8, v0, 8, v0 + 107);
  b.waypoint('Viaduct', 0, vy + 0.1, v0 + 4);

  // ------------------------------------------------------------ ring approach
  buildCableYards(b, b.cursor(0, v3y, v0 + 106.5, 0));
}

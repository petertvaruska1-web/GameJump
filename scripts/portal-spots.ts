// Finds the places where the rare portal may open, and writes them to
// shared/level/map/portals.ts. "A random spot on the map" has to be one a runner
// can actually reach and walk around, so the spots come from the route bot: it
// runs every route (main routes, shortcuts, cross-links, detours) with the real
// controller, and every metre it stood on is a candidate. A candidate is moved
// a couple of metres to one side of the path, so the ring stands beside the
// route rather than across it, and kept only if
//   - it is flat static floor (no belt, launch pad, crumbling slab, mover or ramp)
//     all the way round the ring's footprint,
//   - there is headroom for the ring and nothing solid inside it,
//   - no laser, zip-line cable, launch pad, crate, grapple anchor or enemy post
//     is close by, and it is well away from the start and the Spire,
//   - it lies in a named area.
// Spots are then thinned so no two are closer than SPACING metres.
// Usage: npx tsx scripts/portal-spots.ts          (writes the file)
//        DRY=1 npx tsx scripts/portal-spots.ts    (report only)
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PORTAL } from '../shared/constants';
import { zoneAt } from '../shared/hazards';
import { getLevel } from '../shared/level/map/index';
import type { PortalSpot, V3 } from '../shared/level/types';
import { CollisionWorld, type Collider, type GroundHit } from '../shared/physics/world';
import { expand, routes, run } from './bot-routes';

const level = getLevel();
const world = new CollisionWorld(level);
const gh: GroundHit = { top: 0, c: null };

/** Sideways distance of the ring's centre from the bot's path (tried in this order, both sides). */
const OFFSETS = [2.6, -2.6, 3.4, -3.4];
/** Floor needed all round the ring's centre, and clear space above it. */
const FOOT = 1.35;
const CLEAR_R = 1.5;
const CLEAR_H = PORTAL.HEIGHT + PORTAL.RADIUS + 0.9;
/** Nothing that kills, carries or rewards you this close to a portal (m). */
const LASER_GAP = 7;
const ZIP_GAP = 4;
const PAD_GAP = 6;
const CRATE_GAP = 5;
const ANCHOR_GAP = 3.5;
const ENEMY_GAP = 6;
/** Keep clear of the start and the finish. */
const START_GAP = 35;
const FINISH_GAP = 14;
/** Minimum distance between two spots. */
export const SPACING = 16;

const flatStatic = (c: Collider | null): c is Collider =>
  !!c && c.kind === 'static' && c.rise === 0 && !c.def.belt && !c.def.launch && c.def.mat !== 'invisible';

/** Distance from (x, z) to the segment a-b in the ground plane. */
function segDist(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
  return Math.hypot(x - (ax + dx * t), z - (az + dz * t));
}

/**
 * Why a point cannot hold a portal, or null when it can. Exported for the map check.
 * `onPad`: the test name's portal, which is meant to stand by the start.
 */
export function rejectSpot(x: number, y: number, z: number, onPad = false): string | null {
  world.groundProbe(x, z, 0.2, y + 0.3, gh);
  if (!flatStatic(gh.c) || gh.c.kind === 'crumble' || Math.abs(gh.top - y) > 0.08) return 'no flat floor';
  const top = gh.top;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    world.groundProbe(x + Math.cos(a) * FOOT, z + Math.sin(a) * FOOT, 0.12, top + 0.3, gh);
    if (!flatStatic(gh.c) || Math.abs(gh.top - top) > 0.08) return 'floor too small';
  }
  if (!world.isSpaceFree(x, top + 0.05, z, CLEAR_R, CLEAR_H)) return 'no room';
  for (const l of level.lasers) {
    const mx = l.move?.[0] ?? 0, mz = l.move?.[2] ?? 0, my = l.move?.[1] ?? 0;
    if (Math.max(l.a[1], l.b[1]) + Math.max(0, my) < top - 2 || Math.min(l.a[1], l.b[1]) + Math.min(0, my) > top + 8) continue;
    const mid = [(l.a[0] + l.b[0]) / 2, (l.a[2] + l.b[2]) / 2];
    const half = Math.hypot(l.b[0] - l.a[0], l.b[2] - l.a[2]) / 2;
    const d = l.spin ? Math.hypot(x - mid[0], z - mid[1]) - half
      : Math.min(segDist(x, z, l.a[0], l.a[2], l.b[0], l.b[2]), segDist(x, z, l.a[0] + mx, l.a[2] + mz, l.b[0] + mx, l.b[2] + mz));
    if (d < LASER_GAP) return 'laser';
  }
  for (const zl of level.ziplines) {
    if (Math.min(zl.a[1], zl.b[1]) > top + 8 || Math.max(zl.a[1], zl.b[1]) < top - 2) continue;
    if (segDist(x, z, zl.a[0], zl.a[2], zl.b[0], zl.b[2]) < ZIP_GAP) return 'zip line';
  }
  for (const b of level.boxes) if (b.launch && Math.hypot(x - b.p[0], z - b.p[2]) < PAD_GAP) return 'launch pad';
  for (const c of level.pickups) if (Math.hypot(x - c.p[0], z - c.p[2]) < CRATE_GAP) return 'crate';
  for (const g of level.grapples) if (Math.hypot(x - g.p[0], z - g.p[2]) < ANCHOR_GAP) return 'anchor';
  for (const e of level.enemies) if (e.kind !== 'flyer' && Math.hypot(x - e.p[0], z - e.p[2]) < ENEMY_GAP) return 'enemy post';
  const s = level.spawns[0];
  if (!onPad && Math.hypot(x - s[0], z - s[2]) < START_GAP) return 'start';
  if (Math.hypot(x - level.beacon[0], z - level.beacon[2]) < FINISH_GAP) return 'finish';
  if (zoneAt(level, x, z) === null) return 'unnamed';
  return null;
}

function find(): { spots: PortalSpot[]; stats: Record<string, number> } {
  const cands: (PortalSpot & { route: string })[] = [];
  const stats: Record<string, number> = {};
  for (const [name, r] of Object.entries(routes)) {
    const res = run(name, r.start, expand(r.steps), { record: true, quiet: true });
    if (!res.ok) console.log(`WARN route ${name} did not finish (${res.reached}/${res.total}); using what it walked`);
    const sm = res.samples;
    for (let i = 0; i < sm.length; i += 3) {
      const s = sm[i];
      if (s.g < 0 || !flatStatic(world.get(s.g) ?? null)) continue;
      const a = sm[Math.max(0, i - 8)], b = sm[Math.min(sm.length - 1, i + 8)];
      const dx = b.p[0] - a.p[0], dz = b.p[2] - a.p[2], l = Math.hypot(dx, dz);
      if (l < 2) continue; // waiting at a gate, not travelling
      const ux = dx / l, uz = dz / l;
      for (const off of OFFSETS) {
        const x = s.p[0] - uz * off, z = s.p[2] + ux * off;
        const why = rejectSpot(x, s.p[1], z);
        stats[why ?? 'ok'] = (stats[why ?? 'ok'] ?? 0) + 1;
        if (why) continue;
        world.groundProbe(x, z, 0.2, s.p[1] + 0.3, gh);
        const p: V3 = [Math.round(x * 100) / 100, Math.round(gh.top * 100) / 100, Math.round(z * 100) / 100];
        cands.push({ p, yaw: Math.round(Math.atan2(ux, uz) * 100) / 100, route: name });
        break;
      }
    }
  }
  const spots: PortalSpot[] = [];
  for (const c of cands) {
    if (spots.some((q) => Math.hypot(q.p[0] - c.p[0], q.p[1] - c.p[1], q.p[2] - c.p[2]) < SPACING)) continue;
    spots.push({ p: c.p, yaw: c.yaw });
  }
  spots.sort((a, b) => a.p[2] - b.p[2]);
  return { spots, stats };
}

// run as a script, not when the map check imports rejectSpot
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { spots, stats } = find();
  const zones = new Map<string, number>();
  for (const s of spots) { const n = zoneAt(level, s.p[0], s.p[2])!; zones.set(n, (zones.get(n) ?? 0) + 1); }
  console.log(`candidate checks: ${Object.entries(stats).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log(`${spots.length} portal spots in ${zones.size} areas:`);
  console.log('  ' + [...zones].map(([k, v]) => `${k} ${v}`).join(', '));
  if (!process.env.DRY) {
    const body = spots.map((s) => `  { p: [${s.p.join(', ')}], yaw: ${s.yaw} },`).join('\n');
    writeFileSync('shared/level/map/portals.ts', `// Where the rare portal can open: flat floor beside the routes, clear of lasers,
// cables, pads, crates, anchors and enemy posts. Generated by
// scripts/portal-spots.ts from the route bot's own runs -- regenerate it after
// moving the course (npx tsx scripts/portal-spots.ts); npm run check:map
// warns about any spot that no longer holds.

import type { PortalSpot } from '../types';

export const PORTAL_SPOTS: PortalSpot[] = [
${body}
];
`);
    console.log('wrote shared/level/map/portals.ts');
  }
}

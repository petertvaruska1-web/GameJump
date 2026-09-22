// Enemy placement audit for the stalkers (the walking enemies).
//
//   patrol   each stalker walks its patrol for a minute with nobody around:
//            how long it spends pushing against something it cannot pass
//            (a patrol point behind or inside a wall leaves it walking into
//            that wall forever) and how close its walk runs to walls
//   dodge    the three main routes replayed through the real server: at every
//            stalker that spots the runner, how much room there is to either
//            side of the runner -- a dash needs 2.6 m, so under that on both
//            sides a charge cannot be stepped out of
//
// Usage: npx tsx scripts/enemy-audit.ts
import { DASH, NET, PHYS } from '../shared/constants';
import { getLevel } from '../shared/level/map/index';
import { CollisionWorld, type GroundHit, type RayHit } from '../shared/physics/world';
import { EState, type GameEvent } from '../shared/protocol';
import { Enemy, type EnemyHost } from '../shared/sim/enemy';
import { Room, type RoomPlayer } from '../shared/sim/room';
import { expand, routes, run, type Sample } from './bot-routes';

const level = getLevel();
const world = new CollisionWorld(level);
const hit: RayHit = { dist: 0, c: null };
const gh: GroundHit = { top: 0, c: null };
/** A dash covers about this much; less room than this on both sides and a charge cannot be dodged. */
export const DODGE = DASH.SPEED * DASH.TIME + 0.1;

/** Distance to the nearest solid thing, a railing or a drop, going one way from a runner standing at (x, y, z). */
export function roomToward(w: CollisionWorld, x: number, y: number, z: number, dx: number, dz: number, max = 6): number {
  w.raycast(x, y + 1.0, z, dx, 0, dz, max, false, hit);
  let room = hit.c ? hit.dist : max;
  // the floor running out (or dropping more than a step) counts as a wall
  for (let d = 0.25; d < room; d += 0.25) {
    w.groundProbe(x + dx * d, z + dz * d, 0.1, y + 0.5, gh);
    if (!gh.c || gh.top < y - 0.6) { room = d; break; }
  }
  return room;
}

/** Room to each side of a runner heading (hx, hz): [left, right]. */
export function sideRoom(w: CollisionWorld, x: number, y: number, z: number, hx: number, hz: number): [number, number] {
  const l = Math.hypot(hx, hz) || 1;
  const ux = hx / l, uz = hz / l;
  return [roomToward(w, x, y, z, -uz, ux), roomToward(w, x, y, z, uz, -ux)];
}

/** Nearest solid within `max` of (x, y, z) in 16 directions at chest height. */
function nearestWall(x: number, y: number, z: number, max = 3): number {
  let best = max;
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    world.raycast(x, y + 1.0, z, Math.sin(a), 0, Math.cos(a), max, false, hit);
    if (hit.c) best = Math.min(best, hit.dist);
  }
  return best;
}

// ---------------------------------------------------------------- patrol geometry

/** A stalker's body radius (Enemy makes a 0.4 m body) and the gap we want between it and a wall. */
export const STALKER_RADIUS = 0.4;
export const WALL_GAP = 0.5;

/** Horizontal distance from (x, z) to a collider's footprint (0 inside). */
function footDist(c: { cx: number; cz: number; hx: number; hz: number; cos: number; sin: number }, x: number, z: number) {
  const dx = x - c.cx, dz = z - c.cz;
  const lx = dx * c.cos - dz * c.sin, lz = dx * c.sin + dz * c.cos;
  return Math.hypot(Math.max(0, Math.abs(lx) - c.hx), Math.max(0, Math.abs(lz) - c.hz));
}

/**
 * Tightest centre-to-wall distance along a stalker's patrol loop, counting only
 * solids it cannot step over at that height, plus where it happens. Anything
 * under STALKER_RADIUS + WALL_GAP means the walk scrapes a wall; under the radius
 * it runs into it and stops there.
 */
export function patrolClearance(w: CollisionWorld, def: { p: number[]; patrol?: number[][] }): { min: number; at: [number, number]; leg: number } {
  const pts = def.patrol && def.patrol.length > 1 ? def.patrol : [def.p];
  const y = def.p[1];
  let min = Infinity, at: [number, number] = [def.p[0], def.p[2]], leg = -1;
  const near: typeof w.colliders = [];
  const probe = (x: number, z: number, k: number) => {
    w.query(x - 3, z - 3, x + 3, z + 3, near as never);
    for (const c of near) {
      if (!c.solid || c.isDynamic || c.top < y + 0.46 || c.bottom > y + 2) continue;
      const d = footDist(c, x, z);
      if (d < min) { min = d; at = [x, z]; leg = k; }
    }
  };
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k], b = pts[(k + 1) % pts.length];
    const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
    const n = Math.max(1, Math.ceil(len / 0.25));
    for (let i = 0; i <= n; i++) probe(a[0] + (b[0] - a[0]) * i / n, a[2] + (b[2] - a[2]) * i / n, k);
    if (pts.length === 1) break;
  }
  return { min, at, leg };
}

// ---------------------------------------------------------------- patrol walk

export interface PatrolReport { id: number; tag: string; stuckT: number; hugT: number; minWall: number; reached: number; points: number }

export function patrols(seconds = 60): PatrolReport[] {
  const w = new CollisionWorld(level);
  const enemies = level.enemies.filter((d) => d.kind === 'melee').map((d) => new Enemy(d));
  const host: EnemyHost = { world: w, time: 0, targets: [], kill() {}, fire() {}, emit() {} };
  const out = enemies.map((e) => ({ id: e.id, tag: e.def.tag ?? '-', stuckT: 0, hugT: 0, minWall: 9, reached: 0, points: e.def.patrol?.length ?? 0, lastIdx: 0 }));
  const dt = 1 / 30;
  for (let t = 0; t < seconds; t += dt) {
    host.time = t;
    w.update(t);
    enemies.forEach((e, k) => {
      e.update(dt, host);
      const r = out[k];
      const idx = (e as unknown as { patrolIdx: number }).patrolIdx;
      if (idx !== r.lastIdx) { r.reached++; r.lastIdx = idx; }
      if (r.points < 2) return;
      const speed = Math.hypot(e.vel.x, e.vel.z);
      if (e.state === EState.Idle && speed < 0.4) r.stuckT += dt;
      const wall = nearestWall(e.pos.x, e.pos.y, e.pos.z);
      r.minWall = Math.min(r.minWall, wall);
      if (wall < 0.6) r.hugT += dt;
    });
  }
  return out.map(({ lastIdx: _, ...r }) => r);
}

// ---------------------------------------------------------------- dodge room at every spotting

export interface Spotting { route: string; run: number; t: number; id: number; tag: string; left: number; right: number; dist: number; headOn: boolean; kill: boolean }

function replaySpottings(route: string, runId: number, samples: Sample[], seed: number): Spotting[] {
  let s = seed;
  const realRandom = Math.random;
  Math.random = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  try {
    let now = 0;
    const room = new Room('AUD', level, () => now, true);
    const out: Spotting[] = [];
    const seen = new Set<number>();
    let cur: Sample = samples[0];
    const record = (id: number, kill: boolean) => {
      const e = room.enemies[id];
      if (!e || e.kind !== 'melee') return;
      const [left, right] = sideRoom(room.world, cur.p[0], cur.p[1], cur.p[2], cur.v[0], cur.v[2]);
      const tx = e.pos.x - cur.p[0], tz = e.pos.z - cur.p[2], d = Math.hypot(tx, tz) || 1;
      const hv = Math.hypot(cur.v[0], cur.v[2]) || 1;
      out.push({ route, run: runId, t: room.matchTime, id, tag: e.def.tag ?? '-', left, right, dist: d, headOn: (tx * cur.v[0] + tz * cur.v[2]) / (d * hv) > 0.5, kill });
    };
    const conn = {
      send(m: { t: string; e?: GameEvent[] }) {
        if (m.t !== 'ev') return;
        for (const ev of m.e ?? []) if (ev.k === 'alert' && ev.target === p.id && !seen.has(ev.e)) { seen.add(ev.e); record(ev.e, false); }
      },
      close() {},
    };
    const p = room.join(conn as never, 'bot') as RoomPlayer;
    room.handle(p, { t: 'start' });
    const goAt = now + NET.COUNTDOWN;
    now = goAt; room.tick(1 / 30); p.god = true;
    const realKill = room.kill.bind(room);
    let lastKill = -9;
    room.kill = ((t, cause, e, from) => {
      if (cause === 'melee' && e && room.matchTime - lastKill > 3) { lastKill = room.matchTime; record(e.id, true); }
      realKill(t, cause, e, from);
    }) as Room['kill'];
    let seq = 0;
    for (const smp of samples) {
      cur = smp;
      now = goAt + smp.t;
      room.handle(p, { t: 'st', s: seq++, p: smp.p, v: smp.v, y: smp.yaw, a: smp.anim, g: smp.g, tm: room.matchTime });
      room.tick(1 / 30);
    }
    return out;
  } finally {
    Math.random = realRandom;
  }
}

export function spottings(offsets = [0, 3.1, 6.2, 9.3, 12.4], seeds = 3): Spotting[] {
  const all: Spotting[] = [];
  for (const name of ['left', 'center', 'right']) {
    const r = routes[name], pts = expand(r.steps);
    for (const t0 of offsets) {
      const res = run(name, r.start, pts, { t0, record: true, quiet: true });
      if (!res.ok) continue;
      for (let k = 1; k <= seeds; k++) all.push(...replaySpottings(name, all.length * 1000 + k, res.samples, 1000 * k + Math.round(t0 * 10)));
    }
  }
  return all;
}

/**
 * Per stalker: catches, catches with no room to dash, and ambushes -- spotted
 * while the runner had no room to dash either way, then caught within 3 s.
 */
export function summarise(sp: Spotting[]) {
  const by = new Map<number, { tag: string; spotted: number; cramped: number; catches: number; crampedCatches: number; ambushes: number }>();
  const tight = (s: Spotting) => Math.max(s.left, s.right) < DODGE;
  for (const s of sp) {
    const r = by.get(s.id) ?? { tag: s.tag, spotted: 0, cramped: 0, catches: 0, crampedCatches: 0, ambushes: 0 };
    if (!s.kill) { r.spotted++; if (tight(s)) r.cramped++; }
    else {
      r.catches++;
      if (tight(s)) r.crampedCatches++;
      if (sp.some((o) => !o.kill && o.id === s.id && o.run === s.run && tight(o) && s.t - o.t >= 0 && s.t - o.t < 3)) r.ambushes++;
    }
    by.set(s.id, r);
  }
  return [...by].sort((a, b) => a[0] - b[0]);
}

// ---------------------------------------------------------------- report

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`== patrol walk, 60 s, no players (dash reach ${DODGE.toFixed(1)} m) ==`);
  const pr = patrols();
  const geo = new CollisionWorld(level);
  for (const r of pr) {
    const e = level.enemies[r.id];
    const flag = r.points < 2 ? 'stands at post' : r.stuckT > 5 ? 'STUCK' : r.hugT > 10 ? 'HUGS WALL' : '';
    const cl = patrolClearance(geo, e);
    console.log(`  #${String(r.id).padStart(2)} ${r.tag.padEnd(18)} at (${e.p.map((v) => v.toFixed(0)).join(',')})  patrol ${r.points} pts, reached ${String(r.reached).padStart(2)}  stuck ${r.stuckT.toFixed(1).padStart(4)} s  hugging ${r.hugT.toFixed(1).padStart(4)} s  path clearance ${cl.min.toFixed(2)} m (leg ${cl.leg} at ${cl.at.map((v) => v.toFixed(1)).join(',')})  ${flag}`);
  }
  console.log('\n== stalkers spotting the runner on the main routes ==');
  const sp = spottings();
  const by = new Map<number, Spotting[]>();
  for (const s of sp) { const l = by.get(s.id) ?? []; l.push(s); by.set(s.id, l); }
  for (const [id, list] of [...by].sort((a, b) => a[0] - b[0])) {
    const alerts = list.filter((s) => !s.kill), kills = list.filter((s) => s.kill);
    const cramped = alerts.filter((s) => Math.max(s.left, s.right) < DODGE).length;
    const med = (a: number[]) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
    console.log(`  #${String(id).padStart(2)} ${list[0].tag.padEnd(18)} route ${[...new Set(list.map((s) => s.route))].join('/').padEnd(12)} spotted ${String(alerts.length).padStart(2)}x, `
      + `room L/R at spotting (median) ${med(alerts.map((s) => s.left)).toFixed(1)}/${med(alerts.map((s) => s.right)).toFixed(1)} m, `
      + `no room to dash ${cramped}/${alerts.length}, head-on ${alerts.filter((s) => s.headOn).length}/${alerts.length}, catches ${kills.length}`
      + (kills.length ? ` (room at catch ${kills.map((k) => `${k.left.toFixed(1)}/${k.right.toFixed(1)}`).join(' ')})` : ''));
  }
  console.log('\n== catches / catches with no room to dash / ambushes (spotted cornered, caught within 3 s) ==');
  const tot = { catches: 0, crampedCatches: 0, ambushes: 0 };
  for (const [id, r] of summarise(sp)) {
    tot.catches += r.catches; tot.crampedCatches += r.crampedCatches; tot.ambushes += r.ambushes;
    if (r.catches) console.log(`  #${String(id).padStart(2)} ${r.tag.padEnd(18)} ${String(r.catches).padStart(3)} ${String(r.crampedCatches).padStart(3)} ${String(r.ambushes).padStart(3)}`);
  }
  console.log(`  total                 ${String(tot.catches).padStart(3)} ${String(tot.crampedCatches).padStart(3)} ${String(tot.ambushes).padStart(3)}`);
  void PHYS;
}

// Route balance report for the three main routes, START -> North Junction. All
// three merge on the Reactor Ring and leave it by the North Junction, so that is
// the fair finish line: the ring is a loop round the reactor core, and a route
// that arrives on its far side still has to walk round. The Upper Works beyond
// is shared, so it is left out of the comparison.
//
// Each route is measured on the axes a player actually feels:
//   time       how long a clean run takes (the reward for choosing it)
//   precision  deaths when the runner takes off early at every edge, swept from
//              near-perfect to clumsy, carrying on past each failure so every
//              obstacle that kills at that skill level is counted
//   enemies    the clean run replayed through the real server with enemies on,
//              counting how often a runner who ignores them would have died,
//              averaged over seeded runs (sentinel aim is random)
//   inventory  what the route asks for: enemies, lasers, crumbles, movers, wind,
//              mandatory moves, rescue hooks and crates
//
// Usage: npx tsx scripts/route-balance.ts            (report)
//        SEEDS=40 npx tsx scripts/route-balance.ts   (more enemy replays)
import { NET } from '../shared/constants';
import { getLevel } from '../shared/level/map/index';
import { RING, RING_SIDE } from '../shared/level/map/layout';
import { EState, Status, type GameEvent } from '../shared/protocol';
import { Room, type RoomPlayer } from '../shared/sim/room';
import { expand, routes, run, type Failure, type Sample, type Step } from './bot-routes';

const level = getLevel();

/** Section names of each main route, START to the ring. */
export const ROUTE_SECTIONS: Record<string, string[]> = {
  left: ['Covered Walkway', 'Scaffold Descent', 'Scaffold Yard', 'High Catwalk', 'Foundry', 'Pipe Yard', 'Hangar', 'Terrace Gardens', 'Cooling Works'],
  center: ['Broken Bridge', 'Plaza', 'Gantry Approach', 'Gantry', 'Twin Rails', 'Viaduct', 'Cable Yards'],
  right: ['Rooftops', 'Water Tower Roof', 'Smokestacks', 'Antenna Array', 'Wrecked Skybridge', 'Leap of Faith', 'Long Way Down'],
};

/** Where the bot stands on the Leap of Faith platform (mirrors bot-routes). */
const LEAPZ = RING.z - RING_SIDE / 2 + 4;
const isRing = (s: Step) => !Array.isArray(s) && 'ring' in s;
const isLeapStart = (s: Step) => Array.isArray(s) && s[0] === -46 && Math.abs(s[2] - LEAPZ) < 0.01;

/** A route's steps from the start, round the Reactor Ring, to the North Junction where the routes rejoin. */
export function ringLeg(name: string): Step[] {
  const steps = routes[name].steps;
  // the ring walk, then the two junction points (UP_JUNCTION in bot-routes)
  return steps.slice(0, steps.findIndex(isRing) + 3);
}

/** The right route without its shortcut: the long way down the hops instead of the Leap of Faith. */
export function rightLongWay(): Step[] {
  const steps = routes.right.steps;
  const k = steps.findIndex(isLeapStart), ring = steps.findIndex(isRing);
  return [...steps.slice(0, k + 1), { chain: 'Long Way Down' }, ...steps.slice(ring, ring + 3)];
}

export const LEGS: Record<string, { start: [number, number, number]; steps: Step[] }> = {
  left: { start: routes.left.start, steps: ringLeg('left') },
  center: { start: routes.center.start, steps: ringLeg('center') },
  right: { start: routes.right.start, steps: rightLongWay() },
  'right+leap': { start: routes.right.start, steps: ringLeg('right') },
};

// ---------------------------------------------------------------- seeded randomness

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const realRandom = Math.random;

// ---------------------------------------------------------------- enemy replay

export interface Death { t: number; cause: string; kind: string; tag: string }
export interface ReplayResult { deaths: Death[]; alerts: Set<number>; huntedT: number; fixes: number; fell: boolean }

/** Replays a recorded run through a real Room with enemies on; the runner cannot die, would-be deaths are counted. */
export function replay(samples: Sample[], seed: number): ReplayResult {
  Math.random = mulberry32(seed);
  try {
    let now = 0;
    const room = new Room('BAL', level, () => now, true);
    const alerts = new Set<number>();
    let fixes = 0;
    const conn = {
      send(m: { t: string; e?: GameEvent[] }) {
        if (m.t === 'fix') fixes++;
        if (m.t === 'ev') for (const e of m.e ?? []) if (e.k === 'alert' && e.target === p.id) alerts.add(e.e);
      },
      close() {},
    };
    const p = room.join(conn as never, 'bot') as RoomPlayer;
    room.handle(p, { t: 'start' });
    const goAt = now + NET.COUNTDOWN;
    now = goAt;
    room.tick(1 / 30);
    p.god = true;
    // a runner who is caught would restart there; one death per 3 s of contact
    const deaths: Death[] = [];
    let lastDeath = -99;
    const realKill = room.kill.bind(room);
    room.kill = ((t, cause, e, from) => {
      if (cause !== 'fall' && room.matchTime - lastDeath > 3) {
        lastDeath = room.matchTime;
        deaths.push({ t: room.matchTime, cause, kind: e?.kind ?? cause, tag: e?.def.tag ?? '-' });
      }
      realKill(t, cause, e, from);
    }) as Room['kill'];
    let huntedT = 0, seq = 0;
    for (const s of samples) {
      now = goAt + s.t;
      room.handle(p, { t: 'st', s: seq++, p: s.p, v: s.v, y: s.yaw, a: s.anim, g: s.g, tm: room.matchTime });
      room.tick(1 / 30);
      if (p.status !== Status.Alive) return { deaths, alerts, huntedT, fixes, fell: true };
      if (room.enemies.some((e) => e.target === p && (e.state === EState.Chase || e.state === EState.Alert || e.state === EState.Attack))) huntedT += 1 / 30;
    }
    return { deaths, alerts, huntedT, fixes, fell: false };
  } finally {
    Math.random = realRandom;
  }
}

// ---------------------------------------------------------------- static inventory

/** Nearest tagged geometry's section among `secs`. */
function nearestSection(x: number, z: number, secs: Set<string>): string {
  let best = '?', bd = Infinity;
  for (const b of level.boxes) {
    if (!b.tag || !secs.has(b.tag)) continue;
    const d = Math.hypot(b.p[0] - x, b.p[2] - z);
    if (d < bd) { bd = d; best = b.tag; }
  }
  return best;
}

/** Section of the nearest tagged piece of level geometry (for things that carry no tag, like wind zones). */
function sectionOfPoint(x: number, z: number): string | undefined {
  let best: string | undefined, bd = Infinity;
  for (const b of level.boxes) {
    if (!b.tag) continue;
    const d = Math.hypot(b.p[0] - x, b.p[2] - z);
    if (d < bd) { bd = d; best = b.tag; }
  }
  return best;
}

export function inventory(name: string) {
  const secs = new Set(ROUTE_SECTIONS[name.replace('+leap', '')]);
  const inRoute = (tag?: string) => !!tag && secs.has(tag);
  const enemies = level.enemies.filter((e) => inRoute(e.tag));
  const boxes = level.boxes.filter((b) => inRoute(b.tag));
  const laserGroups = new Set(level.lasers.filter((l) => inRoute(l.tag)).map((l) => l.group));
  return {
    stalkers: enemies.filter((e) => e.kind === 'melee').length,
    sentinels: enemies.filter((e) => e.kind === 'ranged').length,
    drones: enemies.filter((e) => e.kind === 'flyer').length,
    lasers: laserGroups.size,
    crumbles: boxes.filter((b) => b.kind === 'crumble').length,
    movers: boxes.filter((b) => b.kind === 'mover').length,
    sweepers: boxes.filter((b) => b.kind === 'sweeper').length,
    belts: boxes.filter((b) => b.belt).length,
    winds: level.winds.filter((w) => inRoute(sectionOfPoint((w.min[0] + w.max[0]) / 2, (w.min[2] + w.max[2]) / 2))).length,
    zips: level.ziplines.filter((z) => inRoute(z.tag)).length,
    pads: boxes.filter((b) => b.launch).length,
    hooks: level.grapples.filter((g) => inRoute(g.tag) && !g.optional).length,
    rescueHooks: level.grapples.filter((g) => inRoute(g.tag) && g.optional).length,
    crates: level.pickups.filter((c) => inRoute(c.tag)).map((c) => c.kind).join(',') || '-',
  };
}

// ---------------------------------------------------------------- report

const TAKEOFFS = [0.14, 0.4, 0.6, 0.8, 1.0, 1.2, 1.4];
const WOBBLES = [0.15, 0.3, 0.45, 0.6];
const LAGS = [0.1, 0.2, 0.3, 0.4];
const PAUSES = [0.5, 1.0, 1.5];
/**
 * Start offsets (s). Every run is repeated at each, so the runner meets movers
 * and laser gates at different points in their cycles, the way players who got
 * there a moment sooner or later would. Death counts are summed over them.
 *
 * They span two mover cycles at irregular steps on purpose. A mover hands every
 * runner who reaches it within one of its cycles the same departure, so offsets
 * inside a single cycle all meet whatever comes after it (a sweeper arm, say) at
 * the same moment and count as one sample, not eight.
 */
export const OFFSETS = [0, 1.7, 3.1, 4.9, 6.2, 7.8, 9.3, 11.1, 12.4, 13.9];
const sectionAt = (f: Failure, name: string) => {
  // nearest tagged box to where the runner failed, restricted to this route's sections
  const secs = new Set(ROUTE_SECTIONS[name.replace('+leap', '')]);
  let best = '?', bd = Infinity;
  for (const b of level.boxes) {
    if (!b.tag || !secs.has(b.tag)) continue;
    const d = Math.hypot(b.p[0] - f.x, b.p[2] - f.z);
    if (d < bd) { bd = d; best = b.tag; }
  }
  return best;
};

export interface LegReport {
  name: string; time: number; waited: number; stats: ReturnType<typeof run>['stats'];
  deaths: Record<number, Failure[]>; weave: Record<number, Failure[]>; late: Record<number, Failure[]>; pausy: Record<number, Failure[]>;
  /** Seconds of the clean run spent in each section, in the order they are entered. */
  sections: [string, number][];
  /** Would-be deaths per run by the section of the enemy responsible. */
  killers: Record<string, number>;
  enemy: { deaths: number; byKind: Record<string, number>; alerted: number; hunted: number; fixes: number; fell: number };
  inv: ReturnType<typeof inventory>;
}

export function measure(name: string, seeds: number): LegReport {
  const leg = LEGS[name];
  const pts = expand(leg.steps);
  const at = (o: object, t0: number) => ({ ...o, t0, continueOnFail: true, quiet: true });
  const sweep = <K extends number>(keys: K[], opt: (k: K) => object) => {
    const out = {} as Record<number, Failure[]>;
    for (const k of keys) out[k] = OFFSETS.flatMap((t0) => run(name, leg.start, pts, at(opt(k), t0)).fails);
    return out;
  };
  // clean runs at every offset: the time is their mean, the first one is replayed for enemies
  const cleans = OFFSETS.map((t0) => ({ t0, ...run(name, leg.start, pts, { t0, record: true, quiet: true }) }));
  const bad = cleans.filter((c) => !c.ok);
  if (bad.length) console.log(`  (${name}: ${bad.length}/${OFFSETS.length} clean runs failed: ${bad.flatMap((c) => c.fails.map((f) => f.kind)).join(', ')})`);
  const ok = cleans.filter((c) => c.ok);
  const mean = (f: (c: (typeof cleans)[number]) => number) => ok.reduce((a, c) => a + f(c), 0) / Math.max(1, ok.length);
  const deaths = sweep(TAKEOFFS, (takeoff) => ({ takeoff }));
  const weave = sweep(WOBBLES, (wobble) => ({ wobble }));
  const late = sweep(LAGS, (lag) => ({ lag }));
  const pausy = sweep(PAUSES, (hesitate) => ({ hesitate }));
  const secs = new Set(ROUTE_SECTIONS[name.replace('+leap', '')]);
  const secT = new Map<string, number>();
  for (const c of ok) for (const s of c.samples) {
    const sec = nearestSection(s.p[0], s.p[2], secs);
    secT.set(sec, (secT.get(sec) ?? 0) + 1 / 30 / ok.length);
  }
  const killers: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  let total = 0, alerted = 0, hunted = 0, fixes = 0, fell = 0, n = 0;
  for (const c of ok) for (let s = 1; s <= seeds; s++) {
    const r = replay(c.samples, s * 7919 + Math.round(c.samples[0].t * 1000));
    n++; total += r.deaths.length; alerted += r.alerts.size; hunted += r.huntedT; fixes += r.fixes; if (r.fell) fell++;
    for (const d of r.deaths) { byKind[d.kind] = (byKind[d.kind] ?? 0) + 1; killers[d.tag] = (killers[d.tag] ?? 0) + 1; }
  }
  for (const k in byKind) byKind[k] /= n;
  for (const k in killers) killers[k] /= n;
  return {
    name, time: mean((c) => c.t - c.t0), waited: mean((c) => c.waited), stats: ok[0].stats,
    deaths, weave, late, pausy, sections: [...secT], killers,
    enemy: { deaths: total / n, byKind, alerted: alerted / n, hunted: hunted / n, fixes, fell },
    inv: inventory(name),
  };
}

function print(reports: LegReport[]) {
  const col = (v: string | number, w = 11) => String(v).padStart(w);
  const row = (label: string, f: (r: LegReport) => string | number) => console.log(label.padEnd(26) + reports.map((r) => col(f(r))).join(''));
  console.log(''.padEnd(26) + reports.map((r) => col(r.name)).join(''));
  console.log('-- time (START -> North Junction) --');
  row(`clean run, mean of ${OFFSETS.length} (s)`, (r) => r.time.toFixed(1));
  row('  of which waiting (s)', (r) => r.waited.toFixed(1));
  console.log(`-- precision: deaths when taking off early (summed over ${OFFSETS.length} arrival times) --`);
  for (const tk of TAKEOFFS) row(`  take-off ${tk.toFixed(2)} m early`, (r) => r.deaths[tk].length);
  row('  total over the sweep', (r) => TAKEOFFS.reduce((a, tk) => a + r.deaths[tk].length, 0));
  console.log('-- lateral precision: deaths with a wandering line (summed) --');
  for (const w of WOBBLES) row(`  line wanders +-${w.toFixed(2)} m`, (r) => r.weave[w].length);
  row('  total over the sweep', (r) => WOBBLES.reduce((a, w) => a + r.weave[w].length, 0));
  console.log('-- timing: deaths when reacting late to moving hazards (summed) --');
  for (const l of LAGS) row(`  reacting ${(l * 1000).toFixed(0)} ms late`, (r) => r.late[l].length);
  row('  total over the sweep', (r) => LAGS.reduce((a, l) => a + r.late[l].length, 0));
  console.log('-- decisiveness: deaths when stopping to line up each jump (summed) --');
  for (const h of PAUSES) row(`  pausing ${h.toFixed(1)} s at edges`, (r) => r.pausy[h].length);
  row('  total over the sweep', (r) => PAUSES.reduce((a, h) => a + r.pausy[h].length, 0));
  console.log('-- enemies: a runner who ignores them --');
  row('would-be deaths / run', (r) => r.enemy.deaths.toFixed(2));
  row('  by stalker', (r) => (r.enemy.byKind.melee ?? 0).toFixed(2));
  row('  by sentinel shot', (r) => (r.enemy.byKind.ranged ?? 0).toFixed(2));
  row('  by drone', (r) => (r.enemy.byKind.flyer ?? 0).toFixed(2));
  row('enemies alerted / run', (r) => r.enemy.alerted.toFixed(1));
  row('seconds hunted / run', (r) => r.enemy.hunted.toFixed(1));
  console.log('-- inventory --');
  for (const k of Object.keys(reports[0].inv) as (keyof LegReport['inv'])[]) row(`  ${k}`, (r) => r.inv[k]);
  row('  slides (clean run)', (r) => r.stats.slides);
  row('  swings (clean run)', (r) => r.stats.swings);
  row('  server corrections', (r) => r.enemy.fixes);
  console.log('\n-- where each skill level dies --');
  const where = (f: Failure[], r: LegReport) => {
    const n = new Map<string, number>();
    for (const x of f) { const k = `${x.kind} ${sectionAt(x, r.name)} z${Math.round(x.z / 5) * 5}`; n.set(k, (n.get(k) ?? 0) + 1); }
    return [...n].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k} x${c}`).join(' | ');
  };
  for (const r of reports) {
    console.log(`${r.name}:`);
    for (const tk of TAKEOFFS) if (r.deaths[tk].length) console.log(`  early ${tk.toFixed(2)} m  ${where(r.deaths[tk], r)}`);
    for (const w of WOBBLES) if (r.weave[w].length) console.log(`  wander +-${w.toFixed(2)} m  ${where(r.weave[w], r)}`);
    for (const l of LAGS) if (r.late[l].length) console.log(`  late ${(l * 1000).toFixed(0)} ms  ${where(r.late[l], r)}`);
    for (const h of PAUSES) if (r.pausy[h].length) console.log(`  pause ${h.toFixed(1)} s  ${where(r.pausy[h], r)}`);
  }
  console.log('\n-- clean run: seconds per section --');
  for (const r of reports) console.log(`${r.name.padEnd(11)} ${r.sections.map(([n, t]) => `${n} ${t.toFixed(1)}`).join('  ')}`);
  console.log("\n-- would-be deaths per run by the killer's section --");
  for (const r of reports) console.log(`${r.name.padEnd(11)} ${Object.entries(r.killers).sort((a, b) => b[1] - a[1]).map(([n, v]) => `${n} ${v.toFixed(2)}`).join('  ')}`);
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const seeds = Number(process.env.SEEDS ?? 20);
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(LEGS);
  print(names.map((n) => measure(n, seeds)));
}

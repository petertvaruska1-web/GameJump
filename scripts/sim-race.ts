// Speedster Battle, checked headless: the stride cadence that sets a runner's
// speed (only alternating clicks count, faster clicking runs faster, stopping
// lets it fade), the course (floor and barriers everywhere, no way to fall),
// runners driven along it by the real character controller at different
// cadences, and the room's side of it: the rift the Warden leaves, the warp, the
// race, its finish, its results and a rematch.
// Usage: npx tsx scripts/sim-race.ts
import { ARENA, PHYS, RACE, RIFT } from '../shared/constants';
import { getLevel } from '../shared/level/map/index';
import { getRace, trackIndex, trackPoint, trackS } from '../shared/level/race';
import type { V3 } from '../shared/level/types';
import { rng } from '../shared/math';
import { PlayerMotor } from '../shared/physics/character';
import { CollisionWorld, type GroundHit, type RayHit } from '../shared/physics/world';
import { Status, type GameEvent, type S2C } from '../shared/protocol';
import { Cadence, raceTarget } from '../shared/sim/cadence';
import { inRift } from '../shared/sim/race';
import { Room, type RoomPlayer } from '../shared/sim/room';

let fails = 0;

/** A point on the course at distance `s`, on the floor. */
function trackAt(s: number): V3 {
  const q = trackPoint(getRace().track, s, { x: 0, y: 0, z: 0, h: 0, w: 0 });
  return [q.x, q.y + 0.05, q.z];
}

function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) fails++;
}

// ====================================================================== the cadence

/** Strides at `hz` strides a second (alternating buttons) for `secs`; returns the cadence and the time of the last stride. */
function strideAt(c: Cadence, hz: number, secs: number, t0 = 0): number {
  let t = t0, side: 0 | 1 = 0;
  for (; t < t0 + secs; t += 1 / hz) { c.stride(side, t); side = side ? 0 : 1; }
  return t - 1 / hz;
}

{
  const c = new Cadence();
  for (let i = 0; i < 20; i++) c.stride(0, i * 0.1);
  check('the same button again and again is one stride, not twenty', c.strides === 1 && c.rate(1.95) === 0, `strides ${c.strides} rate ${c.rate(1.95)}`);
  check('with no cadence a runner runs at the base speed', Math.abs(c.target(1.95) - RACE.BASE) < 1e-6, `${c.target(1.95)}`);
}

{
  const c = new Cadence();
  c.stride(0, 0); c.stride(1, 0.1);
  check('two strides are enough to know the pace', Math.abs(c.rate(0.1) - 10) < 0.01, `${c.rate(0.1).toFixed(2)} /s`);
}

{
  const slow = new Cadence(), fast = new Cadence();
  const ts = strideAt(slow, 3, 4), tf = strideAt(fast, 11, 4);
  const vs = slow.target(ts), vf = fast.target(tf);
  check('slow clicking (3 a second) runs well above the base speed', vs > 20 && vs < 32, `${vs.toFixed(1)} m/s`);
  check('fast clicking (11 a second) runs near the top', vf > 60 && vf < RACE.TOP, `${vf.toFixed(1)} m/s`);
  check('fast clicking is more than twice as fast as slow clicking', vf / vs > 2.2, `x${(vf / vs).toFixed(2)}`);
}

{
  const c = new Cadence();
  const t = strideAt(c, 20, 2);
  check('the top speed is the cap, however fast the clicks come', c.target(t) === RACE.TOP && raceTarget(13) === RACE.TOP, `${c.target(t)}`);
  check('the cadence curve rises all the way to the cap', raceTarget(4) < raceTarget(6) && raceTarget(6) < raceTarget(9) && raceTarget(9) < raceTarget(12.9));
}

{
  const c = new Cadence();
  const t = strideAt(c, 10, 2);
  const r05 = c.rate(t + 0.5), r3 = c.rate(t + 3);
  check('stopping lets the cadence fall away (half a second later)', r05 <= 2.0001, `${r05.toFixed(2)} /s`);
  check('stopping for good comes back down to the base speed', r3 === 0 && c.target(t + 3) === RACE.BASE, `${r3} /s`);
  c.reset();
  check('a reset forgets the strides', c.strides === 0 && c.rate(t) === 0);
}

{
  // speeding up is read quickly: from slow to fast, the new pace shows within half a second
  const c = new Cadence();
  const t = strideAt(c, 3, 3);
  const t2 = strideAt(c, 11, 0.5, t + 1 / 11);
  check('a runner who speeds up is read within half a second', c.rate(t2) > 9, `${c.rate(t2).toFixed(2)} /s`);
}

// ====================================================================== the course

const race = getRace();
const T = race.track;
const world = new CollisionWorld(race.level);
const S = T.samples;

{
  check('the course is about six kilometres long (ninety seconds striding hard at up to 75 m/s)', T.length > 5800 && T.length < 6800, `${T.length.toFixed(0)} m`);
  const names = T.sections.map((s) => s.name);
  const contiguous = T.sections.every((s, i) => i === 0 ? s.s0 === 0 : Math.abs(s.s0 - T.sections[i - 1].s1) < 1e-6) && Math.abs(T.sections[T.sections.length - 1].s1 - T.length) < 1e-6;
  check('eight named sections run end to end', T.sections.length === 8 && contiguous, names.join(' / '));
  check('the finish comes before a run-out to stop in', T.finishS > T.length - 320 && T.finishS < T.length - 150, `finish ${T.finishS.toFixed(0)} of ${T.length.toFixed(0)}`);
  check('two kickers, each with a lip and a trough that comes back up', T.kickers.length === 2 && T.kickers.every((k) => k.lip > k.s0 && k.s1 > k.lip + 30),
    JSON.stringify(T.kickers.map((k) => [Math.round(k.s0), Math.round(k.lip), Math.round(k.s1)])));
  check('checkpoint rings all the way along', T.rings.length >= 10 && T.rings.every((s, i) => i === 0 || s - T.rings[i - 1] > 250), `${T.rings.length} rings`);
}

{
  // floor under the whole width, the whole way, where the runner's feet find it (groundProbe:
  // what the controller stands on; a downward ray sees a ramp's whole bounding height)
  const gh = { top: 0, c: null } as GroundHit;
  let worst = 0, where = '';
  for (let i = 0; i < S.length; i++) {
    const q = S[i];
    const rx = Math.cos(q.h), rz = -Math.sin(q.h);
    for (const u of [-0.45, 0, 0.45]) {
      const x = q.x + rx * u * q.w, z = q.z + rz * u * q.w;
      world.groundProbe(x, z, 0.25, q.y + 0.5, gh);
      const err = gh.c ? Math.abs(gh.top - q.y) : 99;
      if (err > worst) { worst = err; where = `s ${q.s.toFixed(0)} u ${u}`; }
    }
  }
  check('there is floor under every lane of the course, at the height it is drawn', worst < 0.25, `worst ${worst.toFixed(2)} m at ${where}`);
}

{
  // barriers on both sides the whole way: nobody leaves the road of light
  const hit = { dist: 0, c: null } as RayHit;
  let bad = 0, first = '';
  for (let i = 0; i < S.length; i += 5) {
    const q = S[i];
    const rx = Math.cos(q.h), rz = -Math.sin(q.h);
    for (const side of [-1, 1]) {
      for (const up of [0.8, 6]) {
        world.raycast(q.x, q.y + up, q.z, rx * side, 0, rz * side, q.w, false, hit);
        if (!hit.c || hit.dist < q.w / 2 - 0.6 || hit.dist > q.w / 2 + 1.6) { bad++; if (!first) first = `s ${q.s.toFixed(0)} side ${side} up ${up}: ${hit.c ? hit.dist.toFixed(2) : 'none'}`; }
      }
    }
  }
  check('barriers line both edges, low and high', bad === 0, bad ? `${bad} gaps, first ${first}` : '');
}

{
  let minR = Infinity, at = 0;
  for (let i = 1; i < S.length; i++) {
    let dh = S[i].h - S[i - 1].h;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    const r = Math.abs(dh) > 1e-9 ? T.step / Math.abs(dh) : Infinity;
    if (r < minR) { minR = r; at = S[i].s; }
  }
  check('no curve is tighter than a 75 m/s runner can hold (radius >= 130 m)', minR >= 130, `tightest ${minR.toFixed(0)} m at s ${at.toFixed(0)}`);
  let maxSlope = 0;
  for (let i = 1; i < S.length; i++) {
    if (T.kickers.some((k) => S[i].s > k.s0 - 4 && S[i].s < k.s1 + 4)) continue;
    maxSlope = Math.max(maxSlope, Math.abs(S[i].y - S[i - 1].y) / T.step);
  }
  check('inclines are gentle outside the kickers (no more than 13%)', maxSlope <= 0.13, `steepest ${(maxSlope * 100).toFixed(1)}%`);
}

{
  // a stretch of course never runs into another stretch (a flyover is fine if it is high enough)
  let worst = Infinity, where = '';
  for (let i = 0; i < S.length; i += 3) {
    for (let j = i + 150; j < S.length; j += 3) {
      const a = S[i], b = S[j];
      const d = Math.hypot(a.x - b.x, a.z - b.z) - (a.w + b.w) / 2 - 8;
      if (d < 0 && Math.abs(a.y - b.y) < 32 && d < worst) { worst = d; where = `s ${a.s.toFixed(0)} vs ${b.s.toFixed(0)}`; }
    }
  }
  check('no two stretches of course overlap', worst === Infinity, where ? `${where} overlap ${(-worst).toFixed(1)} m` : '');
}

{
  // where a runner is along the course, from its position
  let wrong = 0;
  for (let i = 10; i < S.length - 10; i += 37) {
    const q = S[i];
    const rx = Math.cos(q.h), rz = -Math.sin(q.h);
    const x = q.x + rx * q.w * 0.3, z = q.z + rz * q.w * 0.3;
    if (Math.abs(trackIndex(T, x, q.y + 1, z, -1) - i) > 1) wrong++;
    if (Math.abs(trackIndex(T, x, q.y + 1, z, Math.max(0, i - 20)) - i) > 1) wrong++;
  }
  check('a runner\'s place along the course is found from where it stands', wrong === 0, `${wrong} wrong`);
  const g = race.grid;
  const stands = g.every((p) => { const d = world.groundBelow(p[0], p[1] + 1, p[2], 3); return Math.abs(p[1] + 1 - d - p[1]) < 0.15; });
  check('three grid slots, side by side, on the floor', g.length === 3 && stands && Math.hypot(g[0][0] - g[2][0], g[0][2] - g[2][2]) > 7);
}

// ====================================================================== running it

interface Drive { finished: number; s: number; outside: number; below: number; top: number; kickLand: number[]; maxLat: number }

/**
 * A runner driven along the course by the real character controller, striding at
 * `cps` strides a second (0: forward only), steering at a point on the centreline
 * ahead of it. From distance `from` (with the running speed it would have built), for up to `limit` seconds.
 */
function drive(cps: number, limit: number, from = 0, speed = 0): Drive {
  const m = new PlayerMotor();
  m.race = true;
  const i0 = Math.round(from / T.step);
  if (from > 0) { const q = S[i0]; m.spawn(q.x, q.y + 0.02, q.z, q.h); }
  else { const g = race.grid[1]; m.spawn(g[0], g[1], g[2], race.yaw); }
  m.raceSpeed = speed;
  const cad = new Cadence();
  const pt = { x: 0, y: 0, z: 0, h: 0, w: 0 };
  let t = 0, side: 0 | 1 = 0, next = 0, idx = i0;
  const out: Drive = { finished: 0, s: 0, outside: 0, below: 0, top: 0, kickLand: [], maxLat: 0 };
  let airFrom = -1;
  while (t < limit) {
    if (cps > 0 && t >= next) { if (cad.stride(side, t)) m.raceKick(); side = side ? 0 : 1; next += 1 / cps; }
    m.raceTarget = cad.target(t);
    const b = m.body;
    idx = trackIndex(T, b.pos.x, b.pos.y, b.pos.z, idx);
    const s = trackS(T, idx, b.pos.x, b.pos.z);
    const hs = Math.hypot(b.vel.x, b.vel.z);
    trackPoint(T, s + Math.max(12, hs * 0.5), pt);
    let dx = pt.x - b.pos.x, dz = pt.z - b.pos.z;
    const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
    m.step(world, PHYS.STEP, { x: dx, z: dz, sprint: false, jumpHeld: false, jumpPressed: false, aimYaw: Math.atan2(dx, dz) });
    t += PHYS.STEP;
    const q = S[idx];
    const lat = Math.abs((b.pos.x - q.x) * Math.cos(q.h) - (b.pos.z - q.z) * Math.sin(q.h));
    out.maxLat = Math.max(out.maxLat, lat - q.w / 2);
    if (lat > q.w / 2 + 0.2) out.outside++;
    if (b.pos.y < Math.min(q.y, q.drop ?? q.y) - 0.6) out.below++;
    out.top = Math.max(out.top, hs);
    // where each kicker's flight comes down
    if (!b.grounded && airFrom < 0) airFrom = s;
    if (b.grounded && airFrom >= 0) {
      const k = T.kickers.find((kk) => airFrom > kk.lip - 6 && airFrom < kk.lip + 6);
      if (k && !out.kickLand.some((v) => v > k.lip && v < k.lip + 400)) out.kickLand.push(s);
      airFrom = -1;
    }
    out.s = s;
    if (s >= T.finishS && !out.finished) { out.finished = t; break; }
  }
  return out;
}

{
  const runs = [3, 7, 11, 13].map((cps) => [cps, drive(cps, 400)] as const);
  for (const [cps, r] of runs) {
    console.log(`  ${String(cps).padStart(2)} strides/s: ${r.finished ? `home in ${r.finished.toFixed(1)} s` : `NOT HOME (${r.s.toFixed(0)} m)`}, top ${r.top.toFixed(1)} m/s, average ${r.finished ? (T.finishS / r.finished).toFixed(1) : '-'} m/s, kickers land at ${r.kickLand.map((v) => v.toFixed(0)).join(' / ')}`);
    check(`a runner striding ${cps} a second gets home`, r.finished > 0, `${r.s.toFixed(0)} m`);
    check(`a runner striding ${cps} a second never leaves the road or sinks through it`, r.outside === 0 && r.below === 0, `outside ${r.outside} below ${r.below} worst lateral ${r.maxLat.toFixed(2)}`);
  }
  const at = (cps: number) => runs.find((x) => x[0] === cps)![1];
  check('striding hard (11 a second) takes about ninety seconds', at(11).finished > 70 && at(11).finished < 105, `${at(11).finished.toFixed(1)} s`);
  check('every step up in cadence is a faster race', at(3).finished > at(7).finished && at(7).finished > at(11).finished && at(11).finished > at(13).finished);
  check('slow striding takes well over twice as long as striding hard', at(3).finished > at(11).finished * 2);
  check('nobody goes faster than the top speed', runs.every(([, r]) => r.top <= RACE.TOP + 0.01), runs.map(([, r]) => r.top.toFixed(1)).join(' / '));
  check('at the top a kicker throws you right over its trough', at(13).kickLand.length === 2 && at(13).kickLand.every((v, i) => v > T.kickers[i].s1 - 2), at(13).kickLand.map((v) => v.toFixed(0)).join(' / '));
  const walk = drive(0, 20);
  check('forward alone runs at the base speed', walk.s > 180 && walk.s < 260, `${walk.s.toFixed(0)} m in 20 s`);
  const k = T.kickers[0];
  const slow = drive(0, 16, k.s0 - 40, RACE.BASE);
  check('hit slowly, a kicker drops you into its trough and you run out of it', slow.s > k.s1 + 20 && slow.below === 0, `reached ${slow.s.toFixed(0)} (trough ends ${k.s1.toFixed(0)})`);
}

{
  // head-on into a barrier at the top speed: it holds, and the speed is gone
  const m = new PlayerMotor();
  m.race = true;
  const q = S[Math.round((T.sections[4].s0 + 300) / T.step)];
  m.spawn(q.x, q.y + 0.02, q.z, q.h);
  const rx = Math.cos(q.h), rz = -Math.sin(q.h);
  m.body.vel.x = rx * RACE.TOP; m.body.vel.z = rz * RACE.TOP;
  m.raceSpeed = RACE.TOP; m.raceTarget = RACE.TOP;
  for (let i = 0; i < 120; i++) m.step(world, PHYS.STEP, { x: rx, z: rz, sprint: false, jumpHeld: false, jumpPressed: false, aimYaw: Math.atan2(rx, rz) });
  const lat = (m.body.pos.x - q.x) * rx + (m.body.pos.z - q.z) * rz;
  check('running head-on into a barrier at 75 m/s does not go through it', lat < q.w / 2, `${lat.toFixed(2)} m from the middle (edge ${(q.w / 2).toFixed(1)})`);
  check('and it costs the speed that went into it', m.raceSpeed < 15, `${m.raceSpeed.toFixed(1)} m/s left`);
}

{
  // in the race the slide key does nothing, and landings never stumble
  const m = new PlayerMotor();
  m.race = true;
  const q = S[40];
  m.spawn(q.x, q.y + 0.02, q.z, q.h);
  m.raceSpeed = 30; m.raceTarget = 30;
  const fx = Math.sin(q.h), fz = Math.cos(q.h);
  for (let i = 0; i < 60; i++) m.step(world, PHYS.STEP, { x: fx, z: fz, sprint: false, jumpHeld: false, jumpPressed: false, slidePressed: i === 30, aimYaw: q.h });
  check('no sliding in the race (C does nothing)', !m.sliding);
  m.body.vel.y = -30; m.body.grounded = false; m.body.pos.y += 8;
  for (let i = 0; i < 90; i++) m.step(world, PHYS.STEP, { x: fx, z: fz, sprint: false, jumpHeld: false, jumpPressed: false, aimYaw: q.h });
  check('a hard landing in the race does not stumble', m.landSlow <= 0);
}

// ====================================================================== the room: rift, warp, race

let now = 0;
interface Client { p: RoomPlayer; events: GameEvent[]; fixes: [number, number, number][]; msgs: S2C[] }

/** A room with `n` runners, counted in: straight into the Warden's arena (`boss`) or onto the race grid (`race`). */
function makeRoom(n: number, stage: 'boss' | 'race', seed = 7) {
  now = 0;
  const room = new Room('RACE', getLevel(), () => now, true, rng(seed));
  const clients: Client[] = [];
  for (let i = 0; i < n; i++) {
    const c: Client = { p: null as unknown as RoomPlayer, events: [], fixes: [], msgs: [] };
    const conn = {
      send(m: S2C) {
        c.msgs.push(m);
        if (m.t === 'ev') c.events.push(...m.e);
        else if (m.t === 'fix') c.fixes.push(m.p);
      },
      close() {},
    };
    c.p = room.join(conn, `racer${i + 1}`) as RoomPlayer;
    clients.push(c);
  }
  for (const c of clients.slice(1)) room.handle(c.p, { t: 'ready', r: true });
  room.handle(clients[0].p, { t: 'start', stage });
  for (let i = 0; i < 110; i++) { now += 1 / 30; room.tick(1 / 30); }
  return { room, clients };
}

function tick(room: Room, seconds: number, each?: () => void) {
  const n = Math.round(seconds * 30);
  for (let i = 0; i < n; i++) { now += 1 / 30; each?.(); room.tick(1 / 30); }
}

let seq = 0;
function report(room: Room, p: RoomPlayer, x: number, y: number, z: number, v: [number, number, number] = [0, 0, 0], tm = room.matchTime) {
  room.handle(p, { t: 'st', s: seq++, p: [x, y, z], v, y: p.yaw, a: 1, g: -1, tm, b: room.stage === 'race' ? 2 : room.inArena ? 1 : undefined });
}

const has = (c: Client, k: GameEvent['k']) => c.events.some((e) => e.k === k);
const ev = <K extends GameEvent['k']>(c: Client, k: K) => c.events.find((e) => e.k === k) as Extract<GameEvent, { k: K }> | undefined;

/** Brings the Warden down (as if the team just landed the last blow) and waits for the rift. */
function killWarden(room: Room, clients: Client[]) {
  clients.forEach((c, i) => room.handle(c.p, { t: 'pick', k: i }));
  tick(room, 3);
  const f = room.fight!;
  f.hitWarden(f.fighter(clients[0].p), 999999, 0, clients[0].p.pos, 0);
  tick(room, RIFT.OPEN_AFTER + 0.2);
}

/** Runner `c` runs along the course from where it is to distance `to` at `speed`, reporting 30 times a second. */
function runTo(room: Room, c: Client, to: number, speed: number, others: () => void = () => {}) {
  const pt = { x: 0, y: 0, z: 0, h: 0, w: 0 };
  let s = trackS(T, trackIndex(T, c.p.pos.x, c.p.pos.y, c.p.pos.z, -1), c.p.pos.x, c.p.pos.z);
  while (s < to) {
    s = Math.min(to, s + speed / 30);
    trackPoint(T, s, pt);
    now += 1 / 30;
    report(room, c.p, pt.x, pt.y, pt.z, [Math.sin(pt.h) * speed, 0, Math.cos(pt.h) * speed]);
    others();
    room.tick(1 / 30);
  }
}

{
  // the Warden falls: a rift opens on the arena floor, and the fight time comes with it
  const { room, clients } = makeRoom(3, 'boss');
  const [a, b, c] = clients;
  killWarden(room, clients);
  const rift = ev(a, 'rift');
  const floorOk = !!rift && Math.abs(rift.p[1] - (ARENA.y + RIFT.HEIGHT)) < 0.01 && Math.hypot(rift.p[0] - ARENA.x, rift.p[2] - ARENA.z) > RIFT.RADIUS - 0.1;
  check('the Warden falling opens a rift in the arena, not the end of the run', !!rift && room.phase === 'playing' && room.stage === 'boss' && floorOk,
    rift ? `p ${rift.p.map((v) => v.toFixed(1)).join(',')} fight ${rift.fight}` : 'no rift');
  check('the rift carries the fight time', !!rift && rift.fight > 0 && rift.auto > rift.at);
  // one runner has fallen in the moat since
  room.handle(b.p, { t: 'dbg', cmd: 'tp', p: [ARENA.x, ARENA.y - 60, ARENA.z] });
  report(room, b.p, ARENA.x, ARENA.y - 60, ARENA.z);
  tick(room, 0.2);
  const bDown = b.p.status === Status.Dead;
  // stepping in from across the arena is not stepping in
  room.handle(a.p, { t: 'rift' });
  tick(room, 0.1);
  check('a runner far from the rift cannot claim to have stepped in', room.stage === 'boss' && !has(a, 'warp'));
  // walking up to it and in
  const rp = rift!.p;
  room.handle(a.p, { t: 'dbg', cmd: 'tp', p: [rp[0], rp[1] - RIFT.HEIGHT + 0.05, rp[2] - 3] });
  for (let i = 0; i <= 6; i++) { now += 1 / 30; report(room, a.p, rp[0], rp[1] - RIFT.HEIGHT + 0.05, rp[2] - 3 + i * 0.5); room.tick(1 / 30); }
  room.handle(a.p, { t: 'rift' });
  tick(room, 0.1);
  const warp = ev(c, 'warp');
  check('the first runner into the rift pulls the team after it', room.stage === 'warp' && !!warp && warp.id === a.p.id);
  tick(room, ARENA.GATE_TIME + 0.2);
  const rev = ev(c, 'race');
  const onGrid = clients.every((x) => x.p.status === Status.Alive && race.grid.some((g) => Math.hypot(g[0] - x.p.pos.x, g[2] - x.p.pos.z) < 0.5));
  check('the warp puts the whole team on the start grid', room.stage === 'race' && !!rev && Object.keys(rev.spawns).length === 3 && onGrid, `stage ${room.stage}`);
  check('a runner who fell in the arena races too', bDown && b.p.status === Status.Alive, `was down ${bDown}`);
  check('the race starts after a look at the course and a countdown', !!rev && Math.abs(rev.go - (room.matchTime - 0.2 + RACE.ARRIVE)) < 0.2, rev ? `go ${rev.go} now ${room.matchTime.toFixed(2)}` : '');
  // nobody moves before "Go!"
  const g0 = a.p.pos.x;
  const fixes0 = a.fixes.length;
  report(room, a.p, a.p.pos.x + Math.sin(race.yaw) * 5, a.p.pos.y, a.p.pos.z + Math.cos(race.yaw) * 5);
  check('before "Go!" a runner stays on the grid', a.fixes.length === fixes0 + 1 && a.p.pos.x === g0);
  // powers are for the arena
  room.handle(a.p, { t: 'pow', a: 0, o: [a.p.pos.x, a.p.pos.y, a.p.pos.z], d: [0, 0, 1], tm: room.matchTime });
  tick(room, RACE.ARRIVE);
  check('the race is on', room.matchTime > rev!.go);
  // too fast is too fast, even here
  const f0 = a.p.pos;
  report(room, a.p, f0.x, f0.y, f0.z);
  now += 1 / 30; room.tick(1 / 30);
  const fixes1 = a.fixes.length;
  report(room, a.p, f0.x + Math.sin(race.yaw) * 12, f0.y, f0.z + Math.cos(race.yaw) * 12);
  check('a jump of 12 m in one report is refused, even for a speedster', a.fixes.length === fixes1 + 1);
  // a runner who somehow ends up under the course is put back on it, not killed
  room.handle(c.p, { t: 'dbg', cmd: 'tp', p: [c.p.pos.x, race.level.killY - 5, c.p.pos.z] });
  report(room, c.p, c.p.pos.x, race.level.killY - 5, c.p.pos.z);
  tick(room, 0.1);
  const back = c.fixes[c.fixes.length - 1];
  check('a runner under the course is put back on it, not killed', c.p.status === Status.Alive && !!back && back[1] > race.level.killY + 30, back ? back.map((v) => v.toFixed(1)).join(',') : 'no fix');
  // a and b race for the line: a from just short of it, b a little further back
  room.handle(a.p, { t: 'dbg', cmd: 'tp', p: trackAt(T.finishS - 150) });
  room.handle(b.p, { t: 'dbg', cmd: 'tp', p: trackAt(T.finishS - 250) });
  runTo(room, a, T.finishS + 20, 70);
  const fa = c.events.find((e) => e.k === 'finish' && e.id === a.p.id) as Extract<GameEvent, { k: 'finish' }> | undefined;
  check('crossing the line finishes the race, first', !!fa && fa.place === 1 && a.p.status === Status.Finished, fa ? `time ${fa.time}` : 'no finish');
  check('the finish is timed on the runner\'s own clock', !!fa && Math.abs(fa.time - (a.p.finishTime)) < 1e-6 && fa.time > 0);
  runTo(room, b, T.finishS + 20, 60);
  const fb = c.events.find((e) => e.k === 'finish' && e.id === b.p.id) as Extract<GameEvent, { k: 'finish' }> | undefined;
  check('the next one home is second', !!fb && fb.place === 2);
  check('a finished runner can still coast on (its reports count)', (() => { const x = b.p.pos.z; runTo(room, b, T.finishS + 60, 30); return b.p.pos.z !== x; })());
  check('the race waits for the last runner a while', room.phase === 'playing');
  tick(room, RACE.GRACE + 0.5);
  const end = c.msgs.find((m) => m.t === 'end') as Extract<S2C, { t: 'end' }> | undefined;
  check('thirty seconds after the winner, the race is over', room.phase === 'ended' && !!end && !!end.race);
  const row = (id: number) => end?.results.find((r) => r.id === id);
  check('the results rank everyone: the two home, then the one still running', row(a.p.id)?.race?.place === 1 && row(b.p.id)?.race?.place === 2 && row(c.p.id)?.race?.place === 3 && row(c.p.id)?.race?.time === undefined,
    JSON.stringify(end?.results.map((r) => r.race)));
  check('the results carry top and average speed', (row(a.p.id)?.race?.top ?? 0) > 50 && (row(a.p.id)?.race?.avg ?? 0) > 0);
  check('the results still carry the fight', !!end?.boss && typeof end.fight === 'number' && (row(a.p.id)?.damage ?? 0) > 0);
  // a rematch goes straight back onto the grid
  room.handle(a.p, { t: 'start', stage: 'race' });
  check('a rematch starts on the race grid', room.stage === 'race' && room.phase === 'countdown' && clients.every((x) => race.grid.some((g) => Math.hypot(g[0] - x.p.pos.x, g[2] - x.p.pos.z) < 0.5)));
}

{
  // a close finish is timed on the runner's own clock: a client whose messages arrive late is not slower
  const { room, clients } = makeRoom(1, 'race', 17);
  const a = clients[0];
  room.handle(a.p, { t: 'dbg', cmd: 'tp', p: trackAt(T.finishS - 30) });
  const pt = { x: 0, y: 0, z: 0, h: 0, w: 0 };
  let s = T.finishS - 30, crossed = 0;
  const lag = 0.2;
  while (!crossed && s < T.finishS + 30) {
    s += 60 / 30;
    trackPoint(T, s, pt);
    now += 1 / 30;
    report(room, a.p, pt.x, pt.y, pt.z, [0, 0, 60], room.matchTime - lag);
    if (s >= T.finishS) crossed = room.matchTime - lag - (60 / 30 - (s - T.finishS)) / 60 * 0 - (s - T.finishS) / 60;
    room.tick(1 / 30);
  }
  const f = ev(a, 'finish');
  check('the finish time is the moment the runner crossed on its own clock, not when the message came', !!f && Math.abs(f.time - crossed) < 0.02,
    f ? `time ${f.time} expected ${crossed.toFixed(2)}` : 'no finish');
}

{
  // walking into the rift from the floor counts (its centre stands high over the floor, the runner's chest does not)
  const c = { x: 10, y: ARENA.y + RIFT.HEIGHT, z: 20 }, floor = ARENA.y + 0.05;
  check('a runner walking through the rift\'s ring on the floor is in it', inRift(c.x, floor, c.z, c.x, c.y, c.z) && inRift(c.x + 1.2, floor, c.z + 0.6, c.x, c.y, c.z));
  check('a runner a few metres from the rift, or up on top of it, is not', !inRift(c.x + 4, floor, c.z, c.x, c.y, c.z) && !inRift(c.x, c.y + 3.2, c.z, c.x, c.y, c.z));
}

{
  // in the race nobody dies: a death reported by a client (a stale laser, a tampered client) changes nothing
  const { room, clients } = makeRoom(1, 'race', 19);
  const a = clients[0];
  room.handle(a.p, { t: 'die', cause: 'laser' });
  tick(room, 0.2);
  check('a reported death in the race is ignored (the race can still be finished)', a.p.status === Status.Alive && !has(a, 'death'));
}

{
  // nobody steps in: the rift takes the team anyway
  const { room, clients } = makeRoom(1, 'boss', 9);
  killWarden(room, clients);
  tick(room, RIFT.AUTO + ARENA.GATE_TIME + 0.3);
  check('left alone, the rift takes everyone after a while', room.stage === 'race' && has(clients[0], 'race'));
}

{
  // everyone down while the rift is open is not a lost fight: the rift takes them
  const { room, clients } = makeRoom(1, 'boss', 11);
  killWarden(room, clients);
  const a = clients[0];
  room.handle(a.p, { t: 'dbg', cmd: 'tp', p: [ARENA.x, ARENA.y - 60, ARENA.z] });
  report(room, a.p, ARENA.x, ARENA.y - 60, ARENA.z);
  tick(room, ARENA.GATE_TIME + 0.5);
  check('falling after the Warden is down does not lose the fight', room.phase === 'playing' && room.stage === 'race' && a.p.status === Status.Alive, `phase ${room.phase} stage ${room.stage}`);
}

{
  // alone, restarting from the pause menu restarts the race; a reconnect comes back to it
  const { room, clients } = makeRoom(1, 'race', 13);
  const a = clients[0];
  check('straight onto the grid (a rematch) races at once after the countdown', room.stage === 'race' && room.phase === 'playing');
  room.handle(a.p, { t: 'restart' });
  check('restarting alone restarts the race', room.stage === 'race' && room.phase === 'countdown');
  tick(room, 4);
  a.msgs.length = 0;
  room.resume({ send: (m: S2C) => a.msgs.push(m), close() {} }, a.p.token);
  const st = a.msgs.find((m) => m.t === 'start') as Extract<S2C, { t: 'start' }> | undefined;
  check('a runner who reconnects mid-race is told it is a race, and when it started', st?.stage === 'race' && typeof st.rgo === 'number');
}

console.log(fails ? `${fails} check(s) failed` : 'all race checks passed');
process.exit(fails ? 1 : 0);

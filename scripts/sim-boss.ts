// The Warden's fight, checked against the real Room: the beacon opening and
// pulling the whole team through (the dead included), the arena's rules for
// health and going down (slow healing, no coming back, the fight lost when the
// team is down), each of the six powers doing what it says against the Warden,
// its bots and the loose things, the Warden's own abilities and staggers, the
// end of the fight, and whole fights played by headless fighters with each
// power, solo and in teams: how long each takes to bring it down, how long a
// fighter lasts against it, and that no two fights play out alike.
// Usage: npx tsx scripts/sim-boss.ts   (QUICK=1 skips the full fights)
import { ARENA, BOSS, PHP, PHYS, POW, powerHp, SUPERS, type SuperPower } from '../shared/constants';
import { getArena } from '../shared/level/arena';
import { getLevel } from '../shared/level/map/index';
import { rng } from '../shared/math';
import { Anim, PlayerMotor, type MoveInput } from '../shared/physics/character';
import { CollisionWorld } from '../shared/physics/world';
import { BAct, BState, JunkKind, PowAct, Status, type GameEvent, type S2C } from '../shared/protocol';
import type { Fighter } from '../shared/sim/fight';
import { Room, type RoomPlayer } from '../shared/sim/room';
import { wardenParts, wardenPoint, type PartSphere } from '../shared/sim/warden';

const level = getLevel();
const arena = getArena();
let now = 0;
let fails = 0;
const QUICK = !!process.env.QUICK;

function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) fails++;
}

interface Client { p: RoomPlayer; events: GameEvent[]; fixes: number; ends: S2C[] }

/** A room with `n` runners, counted in and running (on the course, or straight into the arena). */
function makeRoom(n: number, seed = 7, boss = false) {
  now = 0;
  const r = rng(seed);
  const room = new Room('TEST', level, () => now, true, r);
  const clients: Client[] = [];
  for (let i = 0; i < n; i++) {
    const c: Client = { p: null as unknown as RoomPlayer, events: [], fixes: 0, ends: [] };
    const conn = {
      send(m: S2C) {
        if (m.t === 'ev') c.events.push(...m.e);
        else if (m.t === 'fix') c.fixes++;
        else if (m.t === 'end') c.ends.push(m);
      },
      close() {},
    };
    c.p = room.join(conn, `bot${i + 1}`) as RoomPlayer;
    clients.push(c);
  }
  for (const c of clients.slice(1)) room.handle(c.p, { t: 'ready', r: true });
  room.handle(clients[0].p, { t: 'start', stage: boss ? 'boss' : undefined });
  // through the countdown
  for (let i = 0; i < 110; i++) { now += 1 / 30; room.tick(1 / 30); }
  return { room, clients };
}

function tick(room: Room, seconds: number, each?: () => void) {
  const n = Math.round(seconds * 30);
  for (let i = 0; i < n; i++) { now += 1 / 30; each?.(); room.tick(1 / 30); }
}

let seq = 0;
function report(room: Room, p: RoomPlayer, x: number, y: number, z: number, o: { a?: number; g?: number; v?: [number, number, number] } = {}) {
  room.handle(p, { t: 'st', s: seq++, p: [x, y, z], v: o.v ?? [0, 0, 0], y: p.yaw, a: o.a ?? 0, g: o.g ?? -1, tm: room.matchTime, b: room.inArena ? 1 : undefined });
}

const has = (c: Client, k: GameEvent['k']) => c.events.some((e) => e.k === k);
const fighter = (room: Room, p: RoomPlayer) => room.fight!.fighter(p)!;

// ====================================================================== the beacon

{
  // a runner on the Spire's finish pad opens the beacon; a moment later everyone is in the arena
  const { room, clients } = makeRoom(3);
  const [a, b, c] = clients;
  // one teammate falls to his death first
  room.handle(b.p, { t: 'dbg', cmd: 'tp', p: [0, 40, -14] });
  for (let i = 0; i < 40; i++) { now += 1 / 30; report(room, b.p, 0, 40 - i * 1.5, -14 - i * 0.2); room.tick(1 / 30); }
  const bDead = b.p.status === Status.Dead;
  const f = level.finish;
  const fx = (f.min[0] + f.max[0]) / 2, fy = f.min[1] + 0.6, fz = (f.min[2] + f.max[2]) / 2;
  room.handle(a.p, { t: 'dbg', cmd: 'tp', p: [fx, fy, fz - 6] });
  report(room, a.p, fx, fy, fz - 6);
  tick(room, 0.1);
  for (let i = 0; i < 12; i++) { now += 1 / 30; report(room, a.p, fx, fy, fz - 6 + i * 0.5); room.tick(1 / 30); }
  const gate = a.events.find((e) => e.k === 'gate') as Extract<GameEvent, { k: 'gate' }> | undefined;
  check('reaching the beacon opens it instead of ending the run', !!gate && room.stage === 'gate' && a.p.status === Status.Alive,
    `gate=${!!gate} stage=${room.stage} status=${a.p.status}`);
  check('everyone hears the beacon open', clients.every((x) => has(x, 'gate')));
  tick(room, ARENA.GATE_TIME + 0.2);
  const ev = c.events.find((e) => e.k === 'arena') as Extract<GameEvent, { k: 'arena' }> | undefined;
  const inArena = clients.every((x) => x.p.status === Status.Alive && Math.hypot(x.p.pos.x - ARENA.x, x.p.pos.z - ARENA.z) < 60 && Math.abs(x.p.pos.y - (ARENA.y + 5)) < 1);
  check('the beacon pulls the whole team into the arena', room.stage === 'boss' && !!ev && inArena && Object.keys(ev!.spawns).length === 3,
    `stage=${room.stage} arena=${!!ev} positions=${clients.map((x) => `${x.p.pos.x.toFixed(0)},${x.p.pos.y.toFixed(0)},${x.p.pos.z.toFixed(0)}`).join(' ')}`);
  check('a runner who fell on the course comes through too', bDead && b.p.status === Status.Alive, `was dead=${bDead}`);
  check('the Warden sleeps until the team has chosen', room.fight!.warden.state === BState.Dormant);
  // a stale report from the course is ignored, not a teleport
  const before = a.fixes;
  room.handle(a.p, { t: 'st', s: seq++, p: [fx, fy, fz], v: [0, 0, 0], y: 0, a: 0, g: -1, tm: room.matchTime });
  check('a report from the course after the switch is dropped quietly', a.fixes === before && Math.abs(a.p.pos.z - ARENA.z) < 60);
  // choosing powers wakes it
  clients.forEach((x, i) => room.handle(x.p, { t: 'pick', k: i }));
  tick(room, 3);
  check('everyone choosing wakes the Warden (after a moment to take in the arena)', room.fight!.warden.state !== BState.Dormant && has(a, 'wake'),
    `state=${room.fight!.warden.state}`);
  check('a chosen power shows in snapshots', fighter(room, c.p).power === 3);
  // once awake a power cannot be swapped while alive
  room.handle(a.p, { t: 'pick', k: 5 });
  check('no swapping powers mid-fight while alive', fighter(room, a.p).power === 1);
}

{
  // nobody chooses: the Warden wakes on its own, and everyone gets a power
  const { room, clients } = makeRoom(1, 3, true);
  tick(room, ARENA.WAKE_AFTER + 0.5);
  check('the Warden wakes on its own if nobody chooses', room.fight!.warden.awake && fighter(room, clients[0].p).power > 0);
}

{
  // a rematch starts straight in the arena
  const { room, clients } = makeRoom(2, 5, true);
  check('a rematch starts in the arena', room.stage === 'boss' && clients.every((c) => Math.abs(c.p.pos.z - getArena().level.spawns[0][2]) < 2), `stage=${room.stage}`);
}

// ====================================================================== health, and going down for good

{
  // only one of the two chooses, so the Warden sleeps on (until WAKE_AFTER) while this is measured
  const { room, clients } = makeRoom(2, 11, true);
  const [a, b] = clients;
  room.handle(a.p, { t: 'pick', k: 1 });
  tick(room, 1);
  const f = room.fight!;
  const q = fighter(room, a.p);
  f.hurt(q, 60, 'bite', a.p.pos, { x: 1, y: 2, z: 0 });
  const hp1 = q.hp;
  tick(room, 0.05);
  check('a hit takes health, and says so', hp1 === PHP.MAX - 60 && has(a, 'hurt'), `hp=${hp1}`);
  tick(room, PHP.REGEN_DELAY + 2);
  check('health comes back slowly (2.25 a second, a quarter of what it was)', q.hp > hp1 && q.hp <= hp1 + PHP.REGEN * 2.2 + 0.5 && PHP.REGEN === 2.25,
    `hp ${hp1} -> ${q.hp.toFixed(1)} in 2 s after the wait`);
  f.hurt(q, 200, 'bite', a.p.pos, { x: 1, y: 2, z: 0 });
  check('running out of health is death in the arena', a.p.status === Status.Dead && q.deaths === 1, `status=${a.p.status}`);
  check('one runner down does not end the fight for the team', room.phase === 'playing');
  tick(room, 6);
  check('there is no coming back mid-fight', a.p.status === Status.Dead && !a.events.some((e) => (e.k as string) === 'respawn'));
  room.handle(a.p, { t: 'pick', k: 4 });
  check('nor a new power while down', q.power === 2);
  // the last one standing falls into the moat: the fight is lost
  const [mx, my, mz] = [ARENA.x + 31.8, ARENA.y + 1, ARENA.z];
  room.handle(b.p, { t: 'dbg', cmd: 'tp', p: [mx, my, mz] });
  for (let i = 0; i < 60 && b.p.status === Status.Alive; i++) { now += 1 / 30; report(room, b.p, mx, my - i * 0.9, mz, { a: Anim.Fall }); room.tick(1 / 30); }
  check('falling into the moat is a death there', b.p.status === Status.Dead && b.p.cause === 'fall', `status=${b.p.status}`);
  const end = b.ends[0] as Extract<S2C, { t: 'end' }> | undefined;
  check('with the whole team down the fight is lost: the run ends, to start over', room.phase === 'ended' && !!end && !end.boss && typeof end.fight === 'number',
    JSON.stringify(end ? { boss: end.boss, fight: end.fight } : null));
}

{
  // solo: one death and it is over
  const { room, clients } = makeRoom(1, 12, true);
  const [a] = clients;
  room.handle(a.p, { t: 'pick', k: 3 });
  tick(room, 3);
  room.fight!.hurt(fighter(room, a.p), 500, 'beam', a.p.pos, { x: 0, y: 0, z: 0 });
  tick(room, 0.1);
  check('on your own, going down ends the fight', room.phase === 'ended' && a.ends.length === 1);
}

// ====================================================================== the powers

/** A fight with one runner holding power `k`, the Warden awake, runner placed at (x, z) on the floor facing it. */
function duel(k: SuperPower, lx: number, lz: number, seed = 21) {
  const { room, clients } = makeRoom(1, seed, true);
  const a = clients[0];
  room.handle(a.p, { t: 'pick', k: SUPERS.indexOf(k) });
  tick(room, 2.6);
  const f = room.fight!;
  const w = f.warden;
  const x = ARENA.x + lx, y = ARENA.y, z = ARENA.z + lz;
  room.handle(a.p, { t: 'dbg', cmd: 'tp', p: [x, y, z] });
  report(room, a.p, x, y, z);
  // the power is what is being checked here: the runner itself cannot be hurt (its clones can)
  room.handle(a.p, { t: 'dbg', cmd: 'god' });
  return { room, a, f, w, x, y, z };
}

function aimAt(fromX: number, fromY: number, fromZ: number, tx: number, ty: number, tz: number): [number, number, number] {
  const dx = tx - fromX, dy = ty - fromY, dz = tz - fromZ, d = Math.hypot(dx, dy, dz) || 1;
  return [dx / d, dy / d, dz / d];
}

function wardenPart(room: Room, part: number): PartSphere {
  const w = room.fight!.warden;
  return wardenParts(w.x, ARENA.y, w.z, w.yaw, w.lift, []).find((s) => s.part === part)!;
}

{
  // kinetic: a punch at its foot hurts it; punches have a cool-down; a slam on its back hits the core
  const { room, a, w } = duel('kinetic', 0, -9.5);
  const leg = wardenParts(w.x, ARENA.y, w.z, w.yaw, w.lift, []).filter((s) => s.part === 4 && s.y - ARENA.y < 2)
    .sort((p, q) => Math.hypot(p.x - a.p.pos.x, p.z - a.p.pos.z) - Math.hypot(q.x - a.p.pos.x, q.z - a.p.pos.z))[0];
  // step up to it
  const ld = Math.hypot(leg.x - a.p.pos.x, leg.z - a.p.pos.z);
  const sx = leg.x + (a.p.pos.x - leg.x) / ld * 2.8, sz = leg.z + (a.p.pos.z - leg.z) / ld * 2.8;
  room.handle(a.p, { t: 'dbg', cmd: 'tp', p: [sx, ARENA.y, sz] });
  report(room, a.p, sx, ARENA.y, sz);
  const hp0 = w.hp;
  room.handle(a.p, { t: 'pow', a: PowAct.Punch, o: [a.p.pos.x, a.p.pos.y, a.p.pos.z], d: aimAt(a.p.pos.x, a.p.pos.y + 1.2, a.p.pos.z, leg.x, leg.y, leg.z), tm: room.matchTime });
  const leg2 = Math.hypot(leg.x - a.p.pos.x, leg.z - a.p.pos.z);
  tick(room, 0.1);
  check('kinetic: a punch in reach of its leg hurts the Warden', w.hp < hp0, `hp ${hp0} -> ${w.hp}, leg ${leg2.toFixed(1)} m away`);
  // too soon again: nothing
  const hp1 = w.hp;
  room.handle(a.p, { t: 'pow', a: PowAct.Punch, o: [a.p.pos.x, a.p.pos.y, a.p.pos.z], d: aimAt(a.p.pos.x, a.p.pos.y + 1.2, a.p.pos.z, leg.x, leg.y, leg.z), tm: room.matchTime });
  check('kinetic: punches have a cool-down', w.hp === hp1);
  // a slam on its back hits the core
  tick(room, 1.2);
  const core = wardenPart(room, 1);
  const hp2 = w.hp;
  // the runner came down on its back
  room.handle(a.p, { t: 'dbg', cmd: 'tp', p: [core.x, core.y - 1.4, core.z] });
  report(room, a.p, core.x, core.y - 1.4, core.z, { g: arena.hull });
  room.handle(a.p, { t: 'pow', a: PowAct.Slam, o: [core.x, core.y - 1.4, core.z], d: [0, -1, 0], p: [core.x, core.y - 1.4, core.z], v: 30, tm: room.matchTime });
  const dmg = hp2 - w.hp;
  check('kinetic: a slam landing on its back hits the core hard', dmg >= 120, `damage ${dmg}`);
  check('kinetic: the power makes you tougher', fighter(room, a.p).hp === POW.kinetic.HP && powerHp('kinetic') === 160, `hp ${fighter(room, a.p).hp}`);
}

{
  // kinetic: the combo's fourth punch is an uppercut that throws a bot up; the hurl tears up debris and it shatters on the Warden
  const { room, a, f, w } = duel('kinetic', 0, -16);
  const q = fighter(room, a.p);
  f.launchBot(w, 0);
  const bot = f.bots[f.bots.length - 1];
  tick(room, 1.6, () => report(room, a.p, a.p.pos.x, a.p.pos.y, a.p.pos.z));
  const bx = a.p.pos.x, bz = a.p.pos.z + 2.4;
  bot.pos.x = bx; bot.pos.y = ARENA.y; bot.pos.z = bz; bot.v.x = bot.v.y = bot.v.z = 0;
  q.ready = 0;
  room.handle(a.p, { t: 'pow', a: PowAct.Punch, o: [a.p.pos.x, a.p.pos.y, a.p.pos.z], d: [0, 0, 1], v: 3, tm: room.matchTime });
  tick(room, 0.05);
  const fx = a.events.filter((e) => e.k === 'fx' && e.f === PowAct.Punch).pop() as Extract<GameEvent, { k: 'fx' }> | undefined;
  check('kinetic: an uppercut throws a bot up', bot.v.y >= POW.kinetic.UPPERCUT_LIFT - 0.5 || bot.dead, `vy=${bot.v.y.toFixed(1)} dead=${bot.dead}`);
  check('kinetic: everyone sees which punch of the combo it was', !!fx && fx.d[7] === 3, JSON.stringify(fx?.d ?? null));
  // the hurl: from the floor, at the hull
  tick(room, 0.6, () => report(room, a.p, a.p.pos.x, a.p.pos.y, a.p.pos.z));
  const hull = wardenPart(room, 0);
  const hp0 = w.hp;
  room.handle(a.p, { t: 'pow', a: PowAct.Hurl, o: [a.p.pos.x, a.p.pos.y, a.p.pos.z], d: aimAt(a.p.pos.x, a.p.pos.y + 2.2, a.p.pos.z, hull.x, hull.y, hull.z), tm: room.matchTime });
  const rock = f.junk.find((j) => j.kind === JunkKind.Rock);
  check('kinetic: R tears a slab of debris out of the floor', !!rock && rock.heldBy === q);
  let shattered = false;
  tick(room, 2.5, () => { shattered = shattered || a.events.some((e) => e.k === 'boom' && e.c === 8); report(room, a.p, a.p.pos.x, a.p.pos.y, a.p.pos.z); });
  check('kinetic: the thrown debris shatters on the Warden and hurts it', shattered && w.hp < hp0 && !f.junk.some((j) => j.kind === JunkKind.Rock), `boom=${shattered} hp ${hp0} -> ${w.hp}`);
  const n = f.junk.length;
  room.handle(a.p, { t: 'pow', a: PowAct.Hurl, o: [a.p.pos.x, a.p.pos.y, a.p.pos.z], d: [0, 0, 1], tm: room.matchTime });
  check('kinetic: the hurl has a cool-down', f.junk.length === n);
}

{
  // telekinesis: grab a canister, throw it at the Warden: an explosion that hurts it
  const { room, a, f, w } = duel('telekinesis', -12, -12);
  const can = f.junk.filter((j) => j.kind === JunkKind.Canister).sort((p, q) => Math.hypot(p.pos.x - a.p.pos.x, p.pos.z - a.p.pos.z) - Math.hypot(q.pos.x - a.p.pos.x, q.pos.z - a.p.pos.z))[0];
  const dist = Math.hypot(can.pos.x - a.p.pos.x, can.pos.z - a.p.pos.z);
  room.handle(a.p, { t: 'pow', a: PowAct.Grab, o: [a.p.pos.x, a.p.pos.y, a.p.pos.z], d: [0, 0, 1], tg: [2, can.id, 0], tm: room.matchTime });
  tick(room, 0.5, () => report(room, a.p, a.p.pos.x, a.p.pos.y, a.p.pos.z));
  check('telekinesis: grabbing a canister in range holds it', can.heldBy?.p === a.p, `dist ${dist.toFixed(1)} held=${!!can.heldBy}`);
  const hp0 = w.hp;
  const hull = wardenParts(w.x, ARENA.y, w.z, w.yaw, w.lift, [])[1];
  const from = can.pos;
  room.handle(a.p, { t: 'pow', a: PowAct.Throw, o: [a.p.pos.x, a.p.pos.y, a.p.pos.z], d: aimAt(from.x, from.y, from.z, hull.x, hull.y, hull.z), tm: room.matchTime });
  let boomed = false;
  tick(room, 2, () => { boomed = boomed || a.events.some((e) => e.k === 'boom' && e.c === 0); report(room, a.p, a.p.pos.x, a.p.pos.y, a.p.pos.z); });
  check('telekinesis: a thrown canister explodes on the Warden', boomed && w.hp < hp0, `boom=${boomed} hp ${hp0} -> ${w.hp}`);
  check('telekinesis: things leave the hands 35% faster than they used to', POW.telekinesis.THROW_SPEED === 54);
  // push with nothing held turns an orb back
  f.fireOrb(f.bots[0] ?? { centre: (o: { x: number; y: number; z: number }) => { o.x = a.p.pos.x + 6; o.y = a.p.pos.y + 1.2; o.z = a.p.pos.z; return o; } } as never, fighter(room, a.p));
  const orb = f.orbs[f.orbs.length - 1];
  tick(room, 0.4);
  room.handle(a.p, { t: 'pow', a: PowAct.Push, o: [a.p.pos.x, a.p.pos.y, a.p.pos.z], d: aimAt(a.p.pos.x, a.p.pos.y + 1.2, a.p.pos.z, orb.pos.x, orb.pos.y, orb.pos.z), tm: room.matchTime });
  check('telekinesis: a push turns a wasp\'s shot round', orb.turnedBy !== null || orb.dead, `turned=${!!orb.turnedBy} dead=${orb.dead}`);
}

{
  // lightning: rapid bolts at its eye; heat locks you out; the storm answers every so often
  const { room, a, w, f } = duel('lightning', 0, -18);
  const hp0 = w.hp;
  let fired = 0, thunder = false;
  for (let i = 0; i < 120; i++) {
    const eye = wardenPart(room, 3);
    now += 1 / 30;
    if (i % 4 === 0) {
      room.handle(a.p, { t: 'pow', a: PowAct.Bolt, o: [a.p.pos.x, a.p.pos.y, a.p.pos.z], d: aimAt(a.p.pos.x, a.p.pos.y + 1.25, a.p.pos.z, eye.x, eye.y, eye.z), tg: [0, 0, 3], tm: room.matchTime });
      fired++;
    }
    report(room, a.p, a.p.pos.x, a.p.pos.y, a.p.pos.z);
    room.tick(1 / 30);
    thunder = thunder || has(a, 'thunder');
  }
  const q = fighter(room, a.p);
  check('lightning: bolts at the eye wear the Warden down', w.hp < hp0, `hp ${hp0} -> ${w.hp} after ${fired} presses, ${q.bolts} bolts landed`);
  check('lightning: pouring it on calls down the storm', thunder || q.bolts < POW.lightning.THUNDER, `bolts=${q.bolts} thunder=${thunder}`);
  void f;
}

{
  // gravity: a well thrown at the Warden grinds on it, then implodes
  const { room, a, w } = duel('gravity', 0, -16);
  const hp0 = w.hp;
  const hull = wardenPart(room, 0);
  room.handle(a.p, { t: 'pow', a: PowAct.Well, o: [a.p.pos.x, a.p.pos.y, a.p.pos.z], d: aimAt(a.p.pos.x, a.p.pos.y + 1.25, a.p.pos.z, hull.x, hull.y, hull.z), tm: room.matchTime });
  tick(room, POW.gravity.LIFE + 1, () => report(room, a.p, a.p.pos.x, a.p.pos.y, a.p.pos.z));
  check('gravity: a well on the Warden grinds and implodes on it', w.hp < hp0 - POW.gravity.BURST_BOSS * 0.8 && has(a, 'well'), `hp ${hp0} -> ${w.hp}`);
}

{
  // speed: a flash strike through its legs hurts it, and the jump in position is accepted
  const { room, a, w } = duel('speed', 0, -10);
  const hp0 = w.hp;
  const legs = wardenParts(w.x, ARENA.y, w.z, w.yaw, w.lift, []).filter((s) => s.part === 4 && s.y - ARENA.y < 2);
  const leg = legs.sort((p, q) => Math.hypot(p.x - a.p.pos.x, p.z - a.p.pos.z) - Math.hypot(q.x - a.p.pos.x, q.z - a.p.pos.z))[0];
  const d = aimAt(a.p.pos.x, 0, a.p.pos.z, leg.x, 0, leg.z);
  const to: [number, number, number] = [a.p.pos.x + d[0] * 13, a.p.pos.y, a.p.pos.z + d[2] * 13];
  const fixes = a.fixes;
  room.handle(a.p, { t: 'pow', a: PowAct.Flash, o: [a.p.pos.x, a.p.pos.y, a.p.pos.z], d, p: to, v: 12, tm: room.matchTime });
  now += 0.13;
  report(room, a.p, to[0], to[1], to[2], { a: Anim.Flash });
  room.tick(1 / 30);
  check('speed: a flash strike through a leg hurts the Warden', w.hp < hp0, `hp ${hp0} -> ${w.hp}`);
  check('speed: the streak itself is not taken for a teleport', a.fixes === fixes && Math.hypot(a.p.pos.x - to[0], a.p.pos.z - to[2]) < 0.1);
  const q = fighter(room, a.p);
  check('speed: little wait between strikes', q.flashReady - room.matchTime <= POW.speed.COOLDOWN + 0.05, `ready in ${(q.flashReady - room.matchTime).toFixed(2)} s`);
  check('speed: each strike hurts less than it did', hp0 - w.hp <= (10 + 1.1 * 12) * 0.75 * 3 + 1, `dealt ${hp0 - w.hp}`);
  // running at a speedster's speed is not taken for cheating
  const fx0 = a.fixes;
  let x = a.p.pos.x;
  for (let i = 0; i < 30; i++) { now += 1 / 30; x += 20 / 30; report(room, a.p, x, a.p.pos.y, a.p.pos.z, { a: Anim.Sprint }); room.tick(1 / 30); }
  check('speed: a speedster running flat out is believed', a.fixes === fx0, `fixes ${a.fixes - fx0}`);
}

{
  // duplication: four clones step out, fight on their own near their owner, rally, and can be destroyed
  const { room, a, f, w } = duel('clone', 0, -12);
  const q = fighter(room, a.p);
  let made = 0;
  for (let i = 0; i < 6; i++) {
    room.handle(a.p, { t: 'pow', a: PowAct.Split, o: [a.p.pos.x, a.p.pos.y, a.p.pos.z], d: [0, 0, 1], tm: room.matchTime });
    made = f.clones.length;
    tick(room, POW.clone.SPLIT_COOLDOWN + 0.05, () => report(room, a.p, a.p.pos.x, a.p.pos.y, a.p.pos.z));
  }
  check('duplication: clones step out, four at most', made === 4 && f.clones.length === 4 && has(a, 'clone'), `clones ${f.clones.length}`);
  const hp0 = w.hp;
  let far = 0;
  tick(room, 8, () => { report(room, a.p, a.p.pos.x, a.p.pos.y, a.p.pos.z); for (const c of f.clones) far = Math.max(far, Math.hypot(c.pos.x - a.p.pos.x, c.pos.z - a.p.pos.z)); });
  const byClones = hp0 - w.hp;
  check('duplication: the clones go for the Warden on their own', byClones > 0 && a.events.some((e) => e.k === 'fx' && e.f === PowAct.CloneHit), `dealt ${byClones}`);
  check('duplication: they never stray far from their owner', far <= POW.clone.REGROUP, `farthest ${far.toFixed(1)} m`);
  // rally at the Warden (topped up to four first: any lost in the fight are replaced by a click)
  for (let i = 0; i < 4 && f.clones.filter((c) => !c.dead).length < 4; i++) {
    room.handle(a.p, { t: 'pow', a: PowAct.Split, o: [a.p.pos.x, a.p.pos.y, a.p.pos.z], d: [0, 0, 1], tm: room.matchTime });
    tick(room, POW.clone.SPLIT_COOLDOWN + 0.05, () => report(room, a.p, a.p.pos.x, a.p.pos.y, a.p.pos.z));
  }
  const leg = wardenPart(room, 4);
  room.handle(a.p, { t: 'pow', a: PowAct.Split, o: [a.p.pos.x, a.p.pos.y, a.p.pos.z], d: [0, 0, 1], tg: [0, 0, leg.part], tm: room.matchTime });
  tick(room, 0.05);
  check('duplication: with four out, a click rallies them at the target', f.clones.length === 4 && f.clones.every((c) => c.rallyUntil > room.matchTime) && a.events.some((e) => e.k === 'fx' && e.f === PowAct.Rally),
    `clones ${f.clones.length}, leg ${Math.hypot(leg.x - a.p.pos.x, leg.z - a.p.pos.z).toFixed(1)} m away, rally ${f.clones.map((c) => (c.rallyUntil - room.matchTime).toFixed(1)).join(",")} fx ${a.events.filter((e) => e.k === "fx").map((e) => (e as any).f).join("")}`);
  // they are hit by what hits runners
  const c0 = f.clones[0];
  f.hurtVictim(c0, POW.clone.HP + 1, 'stomp', c0.pos, { x: 0, y: 0, z: 0 });
  tick(room, 0.05);
  check('duplication: a clone can be destroyed', c0.dead && f.clones.length === 3 && a.events.some((e) => e.k === 'clone' && e.s === 'out'));
  // a clone left far behind steps out beside its owner again
  const c1 = f.clones[0];
  c1.pos.x = a.p.pos.x + 25; c1.pos.z = a.p.pos.z;
  tick(room, 0.1, () => report(room, a.p, a.p.pos.x, a.p.pos.y, a.p.pos.z));
  check('duplication: a clone left behind reappears at its owner\'s side', Math.hypot(c1.pos.x - a.p.pos.x, c1.pos.z - a.p.pos.z) < 5, `${Math.hypot(c1.pos.x - a.p.pos.x, c1.pos.z - a.p.pos.z).toFixed(1)} m`);
  // bots hunt clones too
  f.launchBot(w, 0);
  const bot = f.bots[f.bots.length - 1];
  tick(room, 3, () => report(room, a.p, a.p.pos.x, a.p.pos.y, a.p.pos.z));
  check('duplication: bots fight the clones as well as the runner', bot.dead || bot.target !== null, `target ${bot.target?.id}`);
  // the owner goes down: the clones go with it
  room.handle(a.p, { t: 'dbg', cmd: 'god' });
  f.hurt(q, 999, 'beam', a.p.pos, { x: 0, y: 0, z: 0 });
  tick(room, 0.05);
  check('duplication: when the owner goes down its clones vanish', f.clones.every((c) => c.dead));
}

// ====================================================================== the Warden's own rules

{
  // enough poise damage staggers it; a stagger exposes it
  const { room, a, w } = duel('kinetic', 0, -9.5);
  const f = room.fight!;
  const q = fighter(room, a.p);
  const core = wardenPart(room, 1);
  const before = w.hp;
  for (let i = 0; i < 12 && w.state !== BState.Stagger; i++) f.hitWarden(q, 5, 0, core, 12);
  tick(room, 0.05);
  check('broken balance staggers the Warden', w.state === BState.Stagger && has(a, 'stagger'), `state=${w.state} poise=${w.poise}`);
  const h0 = w.hp;
  f.hitWarden(q, 100, 1, core, 0);
  check('a staggered Warden takes a lot more on its core', h0 - w.hp === 250, `dealt ${h0 - w.hp}`);
  tick(room, BOSS.STAGGER + 1.2);
  check('it gets back up by itself', w.state !== BState.Stagger && w.state !== BState.Dormant);
  void before;
}

{
  // a charge that meets a pillar ends in a crash and a stagger
  const { room, a, w } = duel('kinetic', 0, -9.5);
  const f = room.fight!;
  const pillar = arena.pillars[2]; // south
  w.x = pillar[0]; w.z = pillar[2] + 12; w.yaw = Math.PI;
  a.p.pos.x = pillar[0]; a.p.pos.z = pillar[2] - 8;
  // force a charge toward the runner behind the pillar
  (w as unknown as { ready: Map<number, number> }).ready.clear();
  (w as unknown as { begin: (f: unknown, a: number, t: Fighter) => void }).begin(f, BAct.Charge, fighter(room, a.p));
  let crashed = false;
  tick(room, 4, () => { report(room, a.p, a.p.pos.x, a.p.pos.y, a.p.pos.z); crashed = crashed || a.events.some((e) => e.k === 'stagger' && e.on && e.why === 'crash'); });
  check('a charge into a pillar ends in a crash and a stagger', crashed, `state=${w.state}`);
}

{
  // overdrive at half health: plates fly off (something to throw)
  const { room, a, w, f } = duel('telekinesis', 0, -16);
  const plates0 = f.junk.filter((j) => j.kind === JunkKind.Plate).length;
  f.hitWarden(fighter(room, a.p), w.hp - w.maxHp * 0.49, 0, a.p.pos, 0);
  tick(room, 0.2);
  const plates = f.junk.filter((j) => j.kind === JunkKind.Plate).length;
  check('at half health the Warden goes into overdrive and sheds plates', w.overdrive && has(a, 'overdrive') && plates >= plates0 + 3, `plates ${plates0} -> ${plates}`);
}

{
  // the bot cap grows with the team
  const caps = [1, 2, 3].map((n) => { const { room } = makeRoom(n, 2, true); return room.fight!.botCap(); });
  check('more runners, more bots at once', caps[0] < caps[1] && caps[1] < caps[2], `caps ${caps.join(' / ')}`);
}

{
  // the end: its health runs out, it dies, and a moment later the run is won
  const { room, a, w, f } = duel('kinetic', 0, -9.5);
  f.hitWarden(fighter(room, a.p), 99999, 0, a.p.pos, 0);
  tick(room, 0.05);
  check('health out: the Warden falls', w.state === BState.Dying && has(a, 'fall'));
  tick(room, BOSS.DYING + BOSS.VICTORY + 0.5);
  const end = a.ends[0] as Extract<S2C, { t: 'end' }> | undefined;
  check('and the run ends in victory', room.phase === 'ended' && !!end?.boss && end.results[0].status === Status.Finished && (end.results[0].damage ?? 0) > 0,
    JSON.stringify(end?.results[0] ?? null));
}

// ====================================================================== whole fights

/**
 * A headless fighter: runs the real character controller in the arena, keeps
 * its distance, jumps stomps, gets out from under mortar shells, dashes aside
 * from a charge, slides under the beam, and uses its power the way a player
 * would. Not a good player, just a fair one.
 */
class Brain {
  readonly m = new PlayerMotor();
  readonly world = new CollisionWorld(arena.level);
  private acc = 0;
  private hold = 0;
  private strafe = 1;
  private strafeT = 0;
  kind: SuperPower;
  presses = 0;
  god = false;
  constructor(readonly room: Room, readonly c: Client, kind: SuperPower, readonly r: () => number) {
    this.kind = kind;
    const f = room.fight!;
    // the same Warden the server has, like a client drawing it
    this.world.puppeteer = (col) => {
      const w = f.warden, o = { x: 0, y: 0, z: 0 };
      if (col.id === arena.hull) wardenPoint(w.x, ARENA.y, w.z, w.yaw, 0, w.lift, 0, o);
      else wardenPoint(w.x, ARENA.y, w.z, w.yaw, 0, w.lift + 0.5, 5.6, o);
      col.setTransform(o.x, o.y, o.z, w.yaw);
    };
    const p = c.p.pos;
    this.m.spawn(p.x, p.y, p.z, 0);
    this.apply(kind);
  }

  apply(kind: SuperPower) {
    const m = this.m;
    m.runScale = kind === 'speed' ? POW.speed.RUN : 1;
    m.sprintScale = kind === 'speed' ? POW.speed.SPRINT : 1;
    m.accelScale = kind === 'speed' ? POW.speed.ACCEL : 1;
    m.jumpScale = kind === 'gravity' ? POW.gravity.JUMP : 1;
    m.floaty = kind === 'gravity';
  }

  get q() { return this.room.fight!.fighter(this.c.p)!; }

  /** One server tick: think, run the controller at 120 Hz, report like a client. */
  tick(dt: number) {
    const room = this.room, f = room.fight!, p = this.c.p, m = this.m, b = m.body;
    for (const e of this.c.events.splice(0)) {
      if (e.k === 'hurt' && e.id === p.id && e.v) { b.ext.x += e.v[0]; b.ext.z += e.v[2]; if (e.v[1] > 0) { b.vel.y = Math.max(b.vel.y, e.v[1]); b.grounded = false; } }
      if (e.k === 'death' && e.id === p.id) this.hold = 0;
    }
    if (p.status !== Status.Alive) return;
    // measuring damage (it cannot be hurt): thrown off the floor, it climbs back on instead of falling to its death
    if (this.god && b.pos.y < ARENA.y - 2) {
      const x = ARENA.x + (b.pos.x - ARENA.x) * 0.8, z = ARENA.z + (b.pos.z - ARENA.z) * 0.8;
      m.spawn(x, ARENA.y + 0.05, z, 0); this.apply(this.kind);
      room.handle(p, { t: 'dbg', cmd: 'tp', p: [x, ARENA.y + 0.05, z] });
    }
    const w = f.warden, t = room.matchTime;
    const inp: MoveInput = { x: 0, z: 0, sprint: true, jumpHeld: false, jumpPressed: false, aimYaw: 0 };
    // --- where to be: at the power's range from the Warden, circling it
    const want = this.kind === 'kinetic' ? 6 : this.kind === 'speed' ? 9 : this.kind === 'clone' ? 8 : 16;
    const dx = w.x - b.pos.x, dz = w.z - b.pos.z, d = Math.hypot(dx, dz) || 1;
    this.strafeT -= dt;
    if (this.strafeT <= 0) { this.strafe = this.r() < 0.5 ? -1 : 1; this.strafeT = 2 + this.r() * 3; }
    let mx = (dx / d) * (d - want) * 0.25 + (-dz / d) * this.strafe * 0.8;
    let mz = (dz / d) * (d - want) * 0.25 + (dx / d) * this.strafe * 0.8;
    // stay on the floor
    const fromC = Math.hypot(b.pos.x - ARENA.x, b.pos.z - ARENA.z);
    if (fromC > 26) { mx += (ARENA.x - b.pos.x) / fromC * 1.5; mz += (ARENA.z - b.pos.z) / fromC * 1.5; }
    // --- reading the Warden
    const act = w.state === BState.Act ? w.act : 0, D = w.actD;
    if (act === BAct.Stomp && t >= D[2] - 0.2) {
      const r = BOSS.STOMP.R0 + BOSS.STOMP.SPEED * (t - D[2]);
      const pd = Math.hypot(b.pos.x - D[0], b.pos.z - D[1]);
      if (pd - r > 0 && pd - r < 4.5 && b.grounded) inp.jumpPressed = true;
    }
    if (act === BAct.Beam && t >= D[6] - 0.1 && b.grounded && Math.hypot(b.vel.x, b.vel.z) > 4 && this.r() < 0.3) inp.slidePressed = true;
    if (act === BAct.Charge && t >= D[3] - 0.35) {
      const fx = Math.sin(D[2]), fz = Math.cos(D[2]);
      const rx = b.pos.x - w.x, rz = b.pos.z - w.z, lat = -rx * fz + rz * fx, along = rx * fx + rz * fz;
      if (along > 0 && Math.abs(lat) < 4 && along < 14) { const s = lat >= 0 ? 1 : -1; inp.dashX = -fz * s; inp.dashZ = fx * s; }
    }
    for (const j of f.junk) {
      if (!j.hostile) continue;
      const jd = Math.hypot(j.pos.x - b.pos.x, j.pos.z - b.pos.z);
      if (jd < 7 && j.vel.y < 0) { mx += (b.pos.x - j.pos.x) / (jd || 1) * 2; mz += (b.pos.z - j.pos.z) / (jd || 1) * 2; }
    }
    const ml = Math.hypot(mx, mz);
    if (ml > 1) { mx /= ml; mz /= ml; }
    inp.x = mx; inp.z = mz;
    inp.aimYaw = Math.atan2(dx, dz);
    // --- using the power
    this.usePower(t, inp);
    // --- run the controller
    this.acc += dt;
    while (this.acc >= PHYS.STEP) {
      this.acc -= PHYS.STEP;
      this.world.update(t);
      m.step(this.world, PHYS.STEP, inp, 0, 0);
      inp.jumpPressed = false; inp.slidePressed = false; inp.dashX = 0; inp.dashZ = 0;
      if (m.events.slammed > 0) this.send(PowAct.Slam, [0, -1, 0], undefined, [b.pos.x, b.pos.y, b.pos.z], m.events.slammed);
      if (m.events.flashed) this.send(PowAct.Flash, this.flashDir, undefined, [b.pos.x, b.pos.y, b.pos.z], this.flashV, [m.flashFrom.x, m.flashFrom.y, m.flashFrom.z]);
    }
    report(room, p, b.pos.x, b.pos.y, b.pos.z, { a: m.anim, g: b.grounded && b.ground ? b.ground.id : -1, v: [b.vel.x, b.vel.y, b.vel.z] });
  }

  private flashDir: [number, number, number] = [0, 0, 1];
  private flashV = 0;
  private combo = 0;
  private lastPunch = -9;

  private send(a: number, d: [number, number, number], tg?: [number, number, number], p?: [number, number, number], v?: number, o?: [number, number, number]) {
    const b = this.m.body;
    this.room.handle(this.c.p, { t: 'pow', a, o: o ?? [b.pos.x, b.pos.y, b.pos.z], d, tg, p, v, tm: this.room.matchTime });
    this.presses++;
  }

  /** The best part of the Warden to aim at from here (no steeper than `pitch` above or below). */
  private target(range: number, pitch = Math.PI / 2): PartSphere | null {
    const f = this.room.fight!, w = f.warden, b = this.m.body;
    const parts = wardenParts(w.x, ARENA.y, w.z, w.yaw, w.lift, []);
    let best: PartSphere | null = null, bs = -Infinity;
    for (const s of parts) {
      const d = Math.hypot(s.x - b.pos.x, s.y - (b.pos.y + 1.25), s.z - b.pos.z);
      if (d - s.r > range) continue;
      if (Math.abs(Math.atan2(s.y - (b.pos.y + 1.25), Math.hypot(s.x - b.pos.x, s.z - b.pos.z))) > pitch) continue;
      const score = (s.part === 1 ? 3 : s.part === 3 ? 2 : s.part === 2 ? 1.5 : 1) - d * 0.05;
      if (score > bs) { bs = score; best = s; }
    }
    return best;
  }

  private usePower(t: number, inp: MoveInput) {
    const f = this.room.fight!, b = this.m.body, q = this.q, w = f.warden;
    if (!w.alive || !w.awake) return;
    const chest = { x: b.pos.x, y: b.pos.y + 1.25, z: b.pos.z };
    const aim = (s: { x: number; y: number; z: number }) => aimAt(chest.x, chest.y, chest.z, s.x, s.y, s.z);
    switch (this.kind) {
      case 'kinetic': {
        const s = this.target(POW.kinetic.REACH + 1.5);
        if (s && t >= q.ready && b.grounded) {
          const d = aim(s);
          this.combo = t - this.lastPunch < POW.kinetic.COMBO ? (this.combo + 1) % 4 : 0;
          this.lastPunch = t;
          this.m.startLunge(d[0], d[2], POW.kinetic.LUNGE_SPEED, POW.kinetic.LUNGE_TIME);
          this.send(PowAct.Punch, d, undefined, undefined, this.combo);
          break;
        }
        // out of reach: heave a slab of floor at it
        const far = this.target(30);
        if (!s && far && t >= q.hurlReady && b.grounded) this.send(PowAct.Hurl, aimAt(chest.x, chest.y + 1.2, chest.z, far.x, far.y, far.z));
        break;
      }
      case 'telekinesis': {
        if (t < q.ready) break;
        if (q.held) {
          const s = this.target(40);
          if (s) this.send(PowAct.Throw, aimAt(chest.x, chest.y + 1.2, chest.z, s.x, s.y, s.z));
          break;
        }
        let best: [number, number] | null = null, bd = POW.telekinesis.RANGE;
        for (const bot of f.bots) { if (bot.state === 0 || bot.state === 7) continue; const d = Math.hypot(bot.pos.x - b.pos.x, bot.pos.y - b.pos.y, bot.pos.z - b.pos.z); if (d < bd) { bd = d; best = [1, bot.id]; } }
        for (const j of f.junk) { if (j.heldBy) continue; const d = Math.hypot(j.pos.x - b.pos.x, j.pos.y - b.pos.y, j.pos.z - b.pos.z); if (d < bd) { bd = d; best = [2, j.id]; } }
        if (best) this.send(PowAct.Grab, [0, 0, 1], [best[0], best[1], 0]);
        else { const s = this.target(POW.telekinesis.PUSH_RANGE); if (s && t >= q.pushReady) this.send(PowAct.Push, aim(s)); }
        break;
      }
      case 'lightning': {
        if (t < q.boltReady || t < q.overheatUntil) break;
        const bot = f.bots.find((x) => x.state !== 0 && Math.hypot(x.pos.x - b.pos.x, x.pos.z - b.pos.z) < 14);
        if (bot) { this.send(PowAct.Bolt, aim(bot.pos), [1, bot.id, 0]); break; }
        const s = this.target(POW.lightning.RANGE);
        if (s) this.send(PowAct.Bolt, aim(s), [0, 0, s.part]);
        break;
      }
      case 'gravity': {
        if (t < q.ready) break;
        const s = this.target(POW.gravity.RANGE);
        if (s) this.send(PowAct.Well, aim(s));
        break;
      }
      case 'speed': {
        if (t < q.flashReady || !this.m.free) break;
        const s = this.target(POW.speed.DIST - POW.speed.OVERSHOOT, POW.speed.PITCH);
        if (s) {
          const d = aimAt(chest.x, chest.y, chest.z, s.x, s.y, s.z);
          const reach = Math.min(POW.speed.DIST, Math.hypot(s.x - chest.x, s.y - chest.y, s.z - chest.z) + POW.speed.OVERSHOOT);
          // not if it would carry it off the floor
          if (Math.hypot(b.pos.x + d[0] * reach - ARENA.x, b.pos.z + d[2] * reach - ARENA.z) > 28) break;
          this.flashDir = d;
          this.flashV = Math.hypot(b.vel.x, b.vel.z);
          this.m.startFlash(d[0], d[1], d[2], reach, POW.speed.FLASH_SPEED);
        }
        break;
      }
      case 'clone': {
        const mine = f.clones.filter((c) => c.owner === q && !c.dead).length;
        if (mine < POW.clone.MAX) { if (t >= q.ready) this.send(PowAct.Split, [0, 0, 1]); break; }
        const s = this.target(POW.clone.RALLY_RANGE);
        if (s && t >= q.rallyReady) this.send(PowAct.Rally, aim(s), [0, 0, s.part]);
        break;
      }
    }
    void inp;
  }
}

/**
 * A whole fight. `god`: the fighters cannot be hurt, which measures how long each
 * power takes to bring the Warden down; without it, how long they last against it.
 */
function fightOut(powers: SuperPower[], seed: number, limit = 900, god = false) {
  const { room, clients } = makeRoom(powers.length, seed, true);
  clients.forEach((c, i) => room.handle(c.p, { t: 'pick', k: SUPERS.indexOf(powers[i]) }));
  if (god) for (const c of clients) room.handle(c.p, { t: 'dbg', cmd: 'god' });
  const r = rng(seed * 17 + 3);
  const brains = clients.map((c, i) => new Brain(room, c, powers[i], r));
  for (const b of brains) b.god = god;
  const acts: number[] = [];
  let lastAct = -1, lastState = -1;
  const sequence: string[] = [];
  let t = 0, staggers = 0, maxBots = 0;
  const w = () => room.fight!.warden;
  while (room.phase === 'playing' && t < limit) {
    now += 1 / 30; t += 1 / 30;
    for (const b of brains) b.tick(1 / 30);
    room.tick(1 / 30);
    const W = w();
    if (W.state === BState.Act && W.actAt !== lastAct) { lastAct = W.actAt; acts.push(W.act); if (sequence.length < 12) sequence.push('-SBMDCWH'[W.act]); }
    if (W.state === BState.Stagger && lastState !== BState.Stagger) staggers++;
    lastState = W.state;
    maxBots = Math.max(maxBots, room.fight!.bots.length);
  }
  const fs = room.fight!.fighters;
  return {
    won: room.phase === 'ended' && !w().alive, lost: room.phase === 'ended' && w().alive, t, hp: w().hp, max: w().maxHp,
    deaths: fs.reduce((s, q) => s + q.deaths, 0), bots: fs.reduce((s, q) => s + q.bots, 0), causes: fs.map((q) => q.p.cause ?? '-').join('/'),
    damage: fs.map((q) => Math.round(q.damage)), acts, sequence: sequence.join(''), staggers, maxBots,
    cap: room.fight!.botCap(),
  };
}

if (!QUICK) {
  console.log('\nwhole fights (headless fighters with perfect aim, fair not good):');
  console.log('time to bring it down (they cannot be hurt):');
  const ttk: number[] = [];
  for (const k of SUPERS) {
    for (const seed of [1, 2]) {
      const r = fightOut([k], seed, 900, true);
      ttk.push(r.t);
      console.log(`  ${k.padEnd(11)} seed ${seed}: ${r.won ? 'down' : 'NOT DOWN'} in ${r.t.toFixed(0)} s, bots destroyed ${r.bots}, staggers ${r.staggers}, most bots at once ${r.maxBots}/${r.cap}, hp left ${r.hp}/${r.max}, opening ${r.sequence}`);
      check(`solo ${k} can bring the Warden down (seed ${seed})`, r.won, `t=${r.t.toFixed(0)} hp=${r.hp}`);
      check(`solo ${k}: a long fight, not a two-minute one`, r.t >= 180, `t=${r.t.toFixed(0)}`);
      check(`solo ${k}: the bots never outnumber the cap`, r.maxBots <= r.cap, `most ${r.maxBots}, cap ${r.cap}`);
    }
  }
  const lo = Math.min(...ttk), hi = Math.max(...ttk);
  check('no power is far faster or slower than the rest', hi / lo < 1.8, `from ${lo.toFixed(0)} s to ${hi.toFixed(0)} s`);
  console.log('how long a fighter lasts when it can be hurt (going down is final):');
  let survived = 0;
  for (const k of SUPERS) {
    const r = fightOut([k], 3, 900, false);
    if (!r.lost) survived++;
    console.log(`  ${k.padEnd(11)}: ${r.won ? `won in ${r.t.toFixed(0)} s` : r.lost ? `went down (${r.causes}) after ${r.t.toFixed(0)} s, Warden at ${Math.round((r.hp / r.max) * 100)}%` : `still standing at ${r.t.toFixed(0)} s`}`);
  }
  check('the Warden is a real danger: fair fighters mostly go down', survived <= 3, `${survived} of 6 made it`);
  // no two fights play alike: the Warden's opening moves differ between seeds
  const openings = new Set<string>();
  for (let s = 10; s < 16; s++) openings.add(fightOut(['lightning'], s, 45, true).sequence);
  check('no two fights open the same way', openings.size >= 4, [...openings].join(' | '));
  for (const team of [['kinetic', 'lightning'], ['telekinesis', 'gravity', 'clone']] as SuperPower[][]) {
    const r = fightOut(team, 4, 900, true);
    console.log(`  team ${team.join('+')}: ${r.won ? 'down' : 'NOT DOWN'} in ${r.t.toFixed(0)} s, damage ${r.damage.join('/')}, most bots ${r.maxBots}/${r.cap}, opening ${r.sequence}`);
    check(`a team of ${team.length} (${team.join(', ')}) can bring the Warden down`, r.won, `t=${r.t.toFixed(0)}`);
    check(`every runner in the team of ${team.length} gets their hits in`, r.damage.every((d) => d > 0), r.damage.join('/'));
  }
}

console.log(fails ? `${fails} check(s) failed` : 'all boss checks passed');
process.exit(fails ? 1 : 0);

// Server-authority checks for the new obstacles, run against the real Room:
// laser gates kill (judged at the client's clock), a switched-off gate does not,
// self-reported laser deaths are accepted, riding a zip line over the void is
// not a fall, and a launch-pad arc is not rejected as a speed hack. And the
// portal: how often and where it opens, who it takes and when, what nothing can
// do to you while you are away, and the flight you come back with.
// Usage: npx tsx scripts/sim-hazards.ts
import { FLY, PHYS, PORTAL } from '../shared/constants';
import { laserOn } from '../shared/hazards';
import { getLevel } from '../shared/level/map/index';
import { Anim, PlayerMotor, type MoveInput } from '../shared/physics/character';
import { CollisionWorld } from '../shared/physics/world';
import { Status, type GameEvent, type S2C } from '../shared/protocol';
import { Room, type RoomPlayer } from '../shared/sim/room';

const level = getLevel();
let now = 0;
let fails = 0;

function setup() {
  now = 0;
  const room = new Room('TEST', level, () => now, true);
  const fixes: S2C[] = [];
  const conn = { send(m: S2C) { if (m.t === 'fix') fixes.push(m); }, close() {} };
  const p = room.join(conn, 'bot') as RoomPlayer;
  room.handle(p, { t: 'start' });
  now += 3.6;
  room.tick(1 / 30);
  return { room, p, fixes };
}

let seq = 0;
function send(room: Room, p: RoomPlayer, x: number, y: number, z: number, vx = 0, vy = 0, vz = 0) {
  now += 1 / 30;
  room.handle(p, { t: 'st', s: seq++, p: [x, y, z], v: [vx, vy, vz], y: 0, a: 0, g: -1, tm: room.matchTime });
  room.tick(1 / 30);
}

function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) fails++;
}

// the Assembly Line feed gate: find a moment it is on and one it is off
const gate = level.lasers.find((l) => l.tag === 'Assembly Line' && l.cycle)!;
const gz = gate.a[2], gx = (gate.a[0] + gate.b[0]) / 2, gy = gate.a[1] - 0.2;
function toGate(room: Room, p: RoomPlayer) {
  room.handle(p, { t: 'dbg', cmd: 'tp', p: [gx, gy, gz - 3] });
  send(room, p, gx, gy, gz - 3);
}
function waitFor(room: Room, p: RoomPlayer, on: boolean) {
  for (let i = 0; i < 400 && laserOn(gate, room.matchTime + 1 / 30) !== on; i++) send(room, p, gx, gy, gz - 3);
}

{
  const { room, p, fixes } = setup();
  toGate(room, p);
  waitFor(room, p, true);
  send(room, p, gx, gy, gz);
  check('walking into a lit gate kills', p.status === Status.Dead && p.cause === 'laser' && fixes.length === 0, `status=${p.status} cause=${p.cause} fixes=${fixes.length}`);
}
{
  const { room, p, fixes } = setup();
  toGate(room, p);
  waitFor(room, p, false);
  send(room, p, gx, gy, gz);
  send(room, p, gx, gy, gz + 1);
  check('passing a gate while it is off is safe', p.status === Status.Alive && fixes.length === 0 && Math.abs(p.pos.z - (gz + 1)) < 0.01);
}
{
  const { room, p } = setup();
  send(room, p, 0, 44, 576);
  room.handle(p, { t: 'die', cause: 'laser' });
  check('self-reported laser death is accepted', p.status === Status.Dead && p.cause === 'laser');
}
{
  // ride the relay mast's cable (12 m down over open air) with the real motor, reporting like a client
  const { room, p, fixes } = setup();
  const zl = level.ziplines.find((z) => z.tag === 'Relay Mast')!;
  const world = new CollisionWorld(level);
  const m = new PlayerMotor();
  const dx = zl.b[0] - zl.a[0], dz = zl.b[2] - zl.a[2], l = Math.hypot(dx, dz);
  const sx = zl.a[0] + (dx / l) * 1.2, sz = zl.a[2] + (dz / l) * 1.2;
  m.spawn(sx, zl.a[1] - 3.1, sz, 0);
  room.handle(p, { t: 'dbg', cmd: 'tp', p: [sx, zl.a[1] - 3.1, sz] });
  const inp: MoveInput = { x: 0, z: 0, sprint: false, jumpHeld: false, jumpPressed: false };
  let acc = 0, rode = false, landed = false;
  for (let i = 0; i < 120 * 14 && p.status === Status.Alive; i++) {
    if (i === 12) m.pressJump();
    world.update(room.matchTime);
    m.step(world, PHYS.STEP, inp);
    if (m.zip) rode = true;
    if (rode && !m.zip && m.body.grounded) landed = true;
    acc += PHYS.STEP;
    if (acc >= 1 / 30) {
      acc = 0;
      const b = m.body;
      send(room, p, b.pos.x, b.pos.y, b.pos.z, b.vel.x, b.vel.y, b.vel.z);
    }
    if (landed) break;
  }
  check('riding a zip line over the void is not a fall', rode && landed && p.status === Status.Alive && fixes.length === 0, `rode=${rode} landed=${landed} status=${p.status} cause=${p.cause ?? '-'} fixes=${fixes.length}`);
}
{
  // throw the motor off the yard's first launch pad and report the arc
  const { room, p, fixes } = setup();
  const pad = level.boxes.find((b) => b.launch && b.tag === 'Launch Yard')!;
  const world = new CollisionWorld(level);
  const m = new PlayerMotor();
  const top = pad.p[1] + pad.s[1] / 2;
  m.spawn(pad.p[0], top + 0.02, pad.p[2], 0);
  room.handle(p, { t: 'dbg', cmd: 'tp', p: [pad.p[0], top, pad.p[2]] });
  const inp: MoveInput = { x: 0, z: 0, sprint: false, jumpHeld: false, jumpPressed: false };
  let acc = 0, launched = false, landedY = 0;
  for (let i = 0; i < 120 * 4; i++) {
    world.update(room.matchTime);
    m.step(world, PHYS.STEP, inp);
    if (m.events.launched >= 0) launched = true;
    acc += PHYS.STEP;
    if (acc >= 1 / 30) { acc = 0; const b = m.body; send(room, p, b.pos.x, b.pos.y, b.pos.z, b.vel.x, b.vel.y, b.vel.z); }
    if (launched && m.body.grounded) { landedY = m.body.pos.y; break; }
  }
  check('a launch-pad arc is accepted by the server', launched && fixes.length === 0 && p.status === Status.Alive && Math.abs(landedY - pad.launch!.to[1]) < 0.05,
    `launched=${launched} fixes=${fixes.length} landedY=${landedY.toFixed(2)} target=${pad.launch!.to[1]}`);
}

// ------------------------------------------------------------------ power crates, slide hitbox, grapple
function events(room: Room, p: RoomPlayer) {
  const log: string[] = [];
  const prev = p.conn!.send.bind(p.conn);
  p.conn = { send(m: S2C) { if (m.t === 'ev') for (const e of m.e) log.push(e.k === 'pickup' ? `pickup:${e.kind}` : e.k); prev(m); }, close() {} };
  return log;
}
function crate(kind: string) { return level.pickups.find((c) => c.kind === kind)!; }
{
  // walking through a crate grants it once; a second pass (or player) gets nothing
  const { room, p } = setup();
  const log = events(room, p);
  const c = crate('shield');
  room.handle(p, { t: 'dbg', cmd: 'tp', p: [c.p[0], c.p[1], c.p[2] - 1] });
  send(room, p, c.p[0], c.p[1], c.p[2] - 1);
  send(room, p, c.p[0], c.p[1], c.p[2]);
  send(room, p, c.p[0], c.p[1], c.p[2] + 0.5);
  send(room, p, c.p[0], c.p[1], c.p[2]);
  check('walking through a crate takes it once', p.shield && log.filter((k) => k === 'pickup:shield').length === 1, log.join(','));
  // the shield soaks a laser hit, then the next hit after the grace period kills
  toGate(room, p);
  waitFor(room, p, true);
  send(room, p, gx, gy, gz);
  const soaked = p.status === Status.Alive && !p.shield && log.includes('shield');
  for (let i = 0; i < 60; i++) send(room, p, gx, gy, gz - 3); // walk out, wait past the 1.5 s grace
  waitFor(room, p, true);
  send(room, p, gx, gy, gz);
  check('a shield soaks one laser hit, the next one kills', soaked && p.status === Status.Dead, `soaked=${soaked} status=${p.status}`);
}
{
  // a shielded runner caught by a stalker survives and the stalker is stunned, then gives up
  const { room, p } = setup();
  events(room, p);
  p.shield = true;
  const e = room.enemies.find((q) => q.kind === 'melee')!;
  room.handle(p, { t: 'dbg', cmd: 'tp', p: [e.pos.x, e.pos.y, e.pos.z + 1.6] });
  let caughtAt = -1;
  for (let i = 0; i < 30 * 6 && p.status === Status.Alive; i++) {
    send(room, p, e.pos.x + 0.3, e.pos.y, e.pos.z + 0.6);
    if (!p.shield && caughtAt < 0) caughtAt = room.matchTime;
    if (caughtAt > 0 && room.matchTime > caughtAt + 1) break;
  }
  const stunned = caughtAt > 0 && e.stunUntil > room.matchTime - 1.1;
  check('a shield soaks a stalker catch and stuns it', p.status === Status.Alive && caughtAt > 0 && stunned, `status=${p.status} caught=${caughtAt.toFixed(2)} stunUntil=${e.stunUntil.toFixed(2)}`);
}
{
  // cloaked runners are invisible to enemies: stand in front of the plaza stalker
  const { room, p } = setup();
  p.cloakUntil = 1e9;
  const e = room.enemies.find((q) => q.kind === 'melee')!;
  room.handle(p, { t: 'dbg', cmd: 'tp', p: [e.pos.x, e.pos.y, e.pos.z + 5] });
  let alerted = false;
  for (let i = 0; i < 30 * 4; i++) { send(room, p, e.pos.x, e.pos.y, e.pos.z + 5); if (e.state !== 0) alerted = true; }
  check('a cloaked runner is not seen', !alerted && p.status === Status.Alive, `state=${e.state}`);
}
{
  // sliding makes shots aimed at the chest miss: fire straight at a sliding and a standing runner
  const shots = (low: boolean) => {
    let hits = 0;
    for (let k = 0; k < 20; k++) {
      const { room, p } = setup();
      room.handle(p, { t: 'dbg', cmd: 'tp', p: [0, 40.05, 0] });
      p.anim = low ? Anim.Slide : Anim.Run;
      room.fire(room.enemies[0], { x: (k - 10) * 0.02, y: 40.05 + 1.1, z: -12 }, { x: 0, y: 0, z: 25 });
      for (let i = 0; i < 30; i++) { now += 1 / 30; p.lastMsgT = now; room.tick(1 / 30); }
      if ((p.status as number) === Status.Dead) hits++;
    }
    return hits;
  };
  const stand = shots(false), slide = shots(true);
  check('shots aimed at the chest pass over a sliding runner', stand === 20 && slide === 0, `standing hit ${stand}/20, sliding hit ${slide}/20`);
}
{
  // a chest-high beam kills a standing runner but not a sliding one
  const bar = level.lasers.find((l) => l.tag === 'Smokestacks')!;
  const { room, p } = setup();
  const bx = (bar.a[0] + bar.b[0]) / 2, by = bar.a[1] - 1.3, bz = bar.a[2];
  room.handle(p, { t: 'dbg', cmd: 'tp', p: [bx, by, bz - 2] });
  p.anim = Anim.Slide;
  now += 1 / 30; room.handle(p, { t: 'st', s: seq++, p: [bx, by, bz], v: [0, 0, 8], y: 0, a: Anim.Slide, g: -1, tm: room.matchTime - (room.matchTime % 4.2) });
  const slid = p.status === Status.Alive;
  now += 1 / 30; room.handle(p, { t: 'st', s: seq++, p: [bx, by, bz], v: [0, 0, 8], y: 0, a: Anim.Run, g: -1, tm: room.matchTime - (room.matchTime % 4.2) });
  check('a chest-high beam misses a slide, hits a runner', slid && p.status === Status.Dead, `slid=${slid} then status=${p.status}`);
}

// ------------------------------------------------------------------ bodies keep obeying physics
{
  // shot while standing on a moving platform: the body must ride it or fall, never hang in the air
  const { room, p } = setup();
  const mover = room.world.dynamics.find((c) => c.kind === 'mover')!;
  for (let i = 0; i < 30; i++) { now += 1 / 30; room.tick(1 / 30); } // let the platform get going
  const top = mover.top, sx = mover.cx, sz = mover.cz;
  room.handle(p, { t: 'dbg', cmd: 'tp', p: [sx, top, sz] });
  send(room, p, sx, top, sz);
  room.kill(p, 'laser', null);
  let hovered = false, fell = false, rode = false, maxDrift = 0;
  for (let i = 0; i < 30 * 3; i++) {
    now += 1 / 30; room.tick(1 / 30);
    const drift = Math.hypot(p.pos.x - mover.cx, p.pos.z - mover.cz);
    maxDrift = Math.max(maxDrift, drift);
    if (p.pos.y > top - 1 && drift > 3.5) hovered = true;   // floating where the platform used to be
    if (p.pos.y < top - 3) fell = true;
    if (p.pos.y > top - 1 && drift < 2.5) rode = true;
  }
  check('a body shot on a moving platform rides it or falls, never hovers', !hovered && (fell || rode),
    `hovered=${hovered} fell=${fell} rode=${rode} drift=${maxDrift.toFixed(1)}`);
}
{
  // the floor falls away under a body (a crumbling slab): it must drop, not hang
  const { room, p } = setup();
  const slab = room.world.crumbles[0];
  room.handle(p, { t: 'dbg', cmd: 'tp', p: [slab.cx, slab.top, slab.cz] });
  send(room, p, slab.cx, slab.top, slab.cz);
  room.kill(p, 'laser', null);
  for (let i = 0; i < 30; i++) { now += 1 / 30; room.tick(1 / 30); }
  const restingY = p.pos.y;
  slab.enabled = false; // the slab crumbles away
  for (let i = 0; i < 30 * 2; i++) { now += 1 / 30; room.tick(1 / 30); }
  check('a body drops when the slab under it crumbles away', p.pos.y < restingY - 5, `resting ${restingY.toFixed(1)} -> ${p.pos.y.toFixed(1)}`);
}
{
  // a body thrown off a ledge keeps its momentum, falls and comes to rest
  const { room, p } = setup();
  const e = room.enemies.find((q) => q.kind === 'melee' && q.def.tag === 'Plaza')!;
  room.handle(p, { t: 'dbg', cmd: 'tp', p: [e.pos.x + 1.5, e.pos.y, e.pos.z] });
  send(room, p, e.pos.x + 1.5, e.pos.y, e.pos.z);
  const before = { x: p.pos.x, y: p.pos.y, z: p.pos.z };
  room.kill(p, 'melee', e);
  let moved = 0;
  for (let i = 0; i < 30 * 4; i++) { now += 1 / 30; room.tick(1 / 30); moved = Math.hypot(p.pos.x - before.x, p.pos.z - before.z); }
  const pushedAway = Math.hypot(p.pos.x - e.pos.x, p.pos.z - e.pos.z) > 1.5;
  check('a stalker kill throws the body clear and it settles', moved > 1 && pushedAway, `moved ${moved.toFixed(1)} m, y ${p.pos.y.toFixed(1)}`);
}
{
  // a body dropped hard on a floor bounces back up a little instead of stopping dead
  const { room, p } = setup();
  const [sx, sy, sz] = level.spawns[0];
  room.handle(p, { t: 'dbg', cmd: 'tp', p: [sx, sy + 5, sz] });
  send(room, p, sx, sy + 5, sz);
  room.kill(p, 'shot', null, { x: sx, y: sy + 5, z: sz - 1 } as never);
  const floor = sy + 0.5 - room.world.groundBelow(sx, sy + 0.5, sz, 5);
  let lowest = Infinity, bounced = false, peak = -Infinity, prevY = p.pos.y;
  for (let i = 0; i < 30 * 3; i++) {
    now += 1 / 30; room.tick(1 / 30);
    lowest = Math.min(lowest, p.pos.y);
    if (lowest < floor + 0.02 && p.pos.y > prevY + 0.01) bounced = true;
    if (bounced) peak = Math.max(peak, p.pos.y);
    prevY = p.pos.y;
  }
  check('a body dropped on a floor bounces, then lies on it', bounced && Math.abs(p.pos.y - floor) < 0.02 && lowest > floor - 0.02,
    `bounce peak +${(peak - floor).toFixed(2)} m, rests at ${p.pos.y.toFixed(2)} on a floor at ${floor.toFixed(2)}`);
}
{
  // a body on a moving platform rides it for as long as it lies there: it used to
  // stop being simulated after 12 s and hang in mid-air once the platform moved on
  const { room, p } = setup();
  const mover = room.world.dynamics.find((c) => c.kind === 'mover' && c.def.tag === 'Gantry Approach')!;
  const put = () => { room.handle(p, { t: 'dbg', cmd: 'tp', p: [mover.cx, mover.cy + mover.hy, mover.cz] }); send(room, p, mover.cx, mover.cy + mover.hy, mover.cz); };
  put();
  room.kill(p, 'fall', null);
  const zs: number[] = [];
  for (let i = 0; i < 30 * 20; i++) { now += 1 / 30; room.tick(1 / 30); if (i > 30 * 13) zs.push(p.pos.z); }
  const span = Math.max(...zs) - Math.min(...zs);
  check('a body on a moving platform keeps riding it past 12 s', span > 3 && Math.abs(p.pos.y - (mover.cy + mover.hy)) < 0.3,
    `moved ${span.toFixed(1)} m between 13 s and 20 s, y ${p.pos.y.toFixed(2)} vs deck ${(mover.cy + mover.hy).toFixed(2)}`);
}

// ---------------------------------------------------------------- match flow

/** A room mid-run with a host and one guest (both have to join before the start). */
function setupPair() {
  now = 0;
  const room = new Room('TEST', level, () => now, true);
  const quiet = { send() {}, close() {} };
  const host = room.join(quiet, 'host') as RoomPlayer;
  const guest = room.join(quiet, 'guest') as RoomPlayer;
  room.handle(guest, { t: 'ready', r: true });
  room.handle(host, { t: 'start' });
  now += 3.6;
  room.tick(1 / 30);
  return { room, host, guest };
}

{
  // One mistake ends a run, so the host can start another straight from the
  // results screen without the room going back round through the lobby.
  const { room, p } = setup();
  room.kill(p, 'fall', null);
  room.tick(1 / 30);
  const ended = room.phase === 'ended';
  room.handle(p, { t: 'start' });
  check('the host can start another run from the results screen',
    ended && room.phase === 'countdown' && p.status === Status.Alive,
    `ended=${ended} phase=${room.phase} status=${p.status}`);
}
{
  // ...and that restart is a clean slate, not a continuation of the dead run.
  const { room, p } = setup();
  p.shield = true;
  p.cloakUntil = room.matchTime + 99;
  room.kill(p, 'fall', null);
  room.tick(1 / 30);
  room.handle(p, { t: 'start' });
  check('a restart from the results screen clears powers and respawns you',
    !p.shield && p.cloakUntil === 0 && p.pos.z === level.spawns[0][2],
    `shield=${p.shield} cloakUntil=${p.cloakUntil} z=${p.pos.z}`);
}
{
  // A guest pressing it must not drag the room into a new run.
  const { room, host, guest } = setupPair();
  room.kill(host, 'fall', null);
  room.kill(guest, 'fall', null);
  room.tick(1 / 30);
  room.handle(guest, { t: 'start' });
  check('a guest cannot restart from the results screen', room.phase === 'ended', `phase=${room.phase}`);
}
{
  // Mid-run the button does not exist, and a stray message must not reset the match.
  const { room, p } = setup();
  const t0 = room.goAt;
  room.handle(p, { t: 'start' });
  check('a start sent mid-run is ignored', room.phase === 'playing' && room.goAt === t0, `phase=${room.phase}`);
}
{
  // On your own the pause menu can throw a run away and start again...
  const { room, p } = setup();
  const t0 = room.goAt;
  p.pos.z += 30;
  room.handle(p, { t: 'restart' });
  check('a solo host can restart mid-run from the pause menu',
    room.phase === 'countdown' && room.goAt > t0 && p.pos.z === level.spawns[0][2],
    `phase=${room.phase} z=${p.pos.z}`);
}
{
  // ...but with a team in the room it would end their runs too, so it is refused.
  const { room, host } = setupPair();
  const t0 = room.goAt;
  room.handle(host, { t: 'restart' });
  check('a restart mid-run is refused with a team in the room', room.phase === 'playing' && room.goAt === t0, `phase=${room.phase}`);
}
{
  // Players who dropped out during the run are forgotten by the next one.
  const { room, host, guest } = setupPair();
  room.disconnect(guest);
  room.kill(host, 'fall', null);
  room.kill(guest, 'fall', null);
  room.tick(1 / 30);
  room.handle(host, { t: 'start' });
  check('a restart forgets players who dropped out',
    room.phase === 'countdown' && !room.players.includes(guest),
    `phase=${room.phase} players=${room.players.length}`);
}

// ---------------------------------------------------------------- the portal and Viktor's gift

/** A solo room whose portal dice are loaded: `rolls` come out in order, then 0.99 (no portal). */
function setupPortal(rolls: number[]) {
  now = 0;
  let i = 0;
  const room = new Room('TEST', level, () => now, true, () => (i < rolls.length ? rolls[i++] : 0.99));
  const log: GameEvent[] = [];
  const fixes: S2C[] = [];
  const conn = { send(m: S2C) { if (m.t === 'ev') log.push(...m.e); if (m.t === 'fix') fixes.push(m); }, close() {} };
  const p = room.join(conn, 'bot') as RoomPlayer;
  room.handle(p, { t: 'start' });
  now += 3.6;
  room.tick(1 / 30);
  return { room, p, log, fixes };
}
function sendA(room: Room, p: RoomPlayer, x: number, y: number, z: number, anim: number, vx = 0, vy = 0, vz = 0) {
  now += 1 / 30;
  room.handle(p, { t: 'st', s: seq++, p: [x, y, z], v: [vx, vy, vz], y: 0, a: anim, g: -1, tm: room.matchTime });
  room.tick(1 / 30);
}
function waitUntil(room: Room, p: RoomPlayer, mt: number) {
  while (room.matchTime < mt) { now += 1 / 30; room.tick(1 / 30); if (!p.away) p.lastMsgT = now; }
}
/** Walks the runner up to the portal's ring (keeping the server's speed check happy) and says it went through. */
function stepThrough(room: Room, p: RoomPlayer) {
  const s = room.portal!.spot.p;
  room.handle(p, { t: 'dbg', cmd: 'tp', p: [s[0], s[1], s[2] - 3] });
  sendA(room, p, s[0], s[1], s[2] - 3, 1);
  sendA(room, p, s[0], s[1], s[2] - 0.3, 1);
  room.handle(p, { t: 'portal' });
  room.tick(1 / 30);
}
const spots = level.portals ?? [];
{
  // about one run in ten gets a portal, and over many runs it turns up all over the course
  now = 0;
  const room = new Room('ROLL', level, () => now, true);
  const p = room.join({ send() {}, close() {} }, 'x') as RoomPlayer;
  room.handle(p, { t: 'start' });
  const N = 4000, used = new Set<string>();
  let n = 0;
  for (let k = 0; k < N; k++) {
    room.handle(p, { t: 'restart' });
    if (room.portal) { n++; used.add(room.portal.spot.p.join(',')); }
  }
  check('about one run in ten has a portal', n / N > 0.085 && n / N < 0.115, `${n}/${N} = ${(100 * n / N).toFixed(1)}%`);
  check('the portal opens all over the course', spots.length >= 30 && used.size >= spots.length * 0.9, `${used.size} of ${spots.length} spots used`);
  const opens = [...Array(200)].map(() => { room.handle(p, { t: 'restart' }); return room.portal?.at; }).filter((a): a is number => a !== undefined);
  check('it opens a few seconds into the run', opens.every((a) => a >= 3 && a <= 9), `open times ${Math.min(...opens).toFixed(1)}..${Math.max(...opens).toFixed(1)} s`);
}
{
  // testing: a runner called vk3 (any case) gets the portal on every run, on the landing
  // pad in front of the spawns, opening a second after "Go!" -- and only that changes
  for (const name of ['vk3', 'VK3']) {
    now = 0;
    const room = new Room('VK3', level, () => now, true, () => 0.99);
    const p = room.join({ send() {}, close() {} }, name) as RoomPlayer;
    room.handle(p, { t: 'start' });
    let n = 0;
    for (let k = 0; k < 200; k++) {
      room.handle(p, { t: 'restart' });
      if (room.portal && room.portal.spot === level.portalTest && room.portal.at === PORTAL.TEST_OPEN) n++;
    }
    check(`a runner named ${name} gets the portal on the landing pad every run`, n === 200, `${n}/200`);
  }
  {
    // and can walk straight into it from the spawn once it opens
    const { room, p } = (() => {
      now = 0;
      const r = new Room('VK3', level, () => now, true, () => 0.99);
      const q = r.join({ send() {}, close() {} }, 'vk3') as RoomPlayer;
      r.handle(q, { t: 'start' });
      now += 3.6; r.tick(1 / 30);
      return { room: r, p: q };
    })();
    const s = level.portalTest!.p, sp = level.spawns[0];
    const d0 = Math.hypot(s[0] - sp[0], s[2] - sp[2]);
    waitUntil(room, p, PORTAL.TEST_OPEN + 0.05);
    for (let k = 1; k <= 30; k++) sendA(room, p, sp[0] + ((s[0] - sp[0]) * k) / 30, sp[1], sp[2] + ((s[2] - sp[2]) * k) / 30, 1);
    room.handle(p, { t: 'portal' });
    check('the landing-pad portal takes a runner who walks into it from the spawn', p.away && d0 < 12, `${d0.toFixed(1)} m from the spawn, away=${p.away}`);
  }
  now = 0;
  const other = new Room('XYZ', level, () => now, true, () => 0.99);
  const q = other.join({ send() {}, close() {} }, 'vk33') as RoomPlayer;
  other.handle(q, { t: 'start' });
  check('any other name still rolls the dice', other.portal === null);
}
{
  // no portal this run: nothing to step through
  const { room, p } = setupPortal([0.5]);
  const s = spots[0].p;
  room.handle(p, { t: 'dbg', cmd: 'tp', p: [s[0], s[1], s[2]] });
  sendA(room, p, s[0], s[1], s[2], 1);
  room.handle(p, { t: 'portal' });
  check('without a portal there is nothing to step through', room.portal === null && !p.away, `portal=${!!room.portal} away=${p.away}`);
}
{
  // it stays shut until it opens, and only takes a runner standing at the ring
  const { room, p, log } = setupPortal([0.01, 0, 0.99]);
  // nine seconds in a sentinel's sight while it opens: its aim is random, and this is not about enemies
  room.handle(p, { t: 'dbg', cmd: 'god' });
  stepThrough(room, p);
  const shutRefused = !p.away;
  waitUntil(room, p, room.portal!.at + 0.1);
  const s = room.portal!.spot.p;
  room.handle(p, { t: 'dbg', cmd: 'tp', p: [s[0] + 9, s[1], s[2]] });
  sendA(room, p, s[0] + 9, s[1], s[2], 1);
  room.handle(p, { t: 'portal' });
  const farRefused = !p.away;
  stepThrough(room, p);
  check('the portal is shut until it opens', shutRefused);
  check('a runner away from the ring cannot go through', farRefused);
  check('stepping through the open portal takes you away', p.away && p.status === Status.Alive && log.some((e) => e.k === 'heaven' && e.s === 'in' && e.id === p.id),
    `away=${p.away} events=${log.map((e) => e.k).join(',')}`);
}
{
  // while with Viktor nothing on the course can touch you, and your state messages are ignored
  const { room, p } = setupPortal([0.01, 0, 0]);
  waitUntil(room, p, room.portal!.at + 0.1);
  stepThrough(room, p);
  const at = { x: p.pos.x, y: p.pos.y, z: p.pos.z };
  sendA(room, p, at.x + 40, at.y, at.z, 1);
  const ignored = p.pos.x === at.x;
  room.handle(p, { t: 'die', cause: 'laser' });
  room.kill(p, 'shot', null);
  const untouchable = p.status === Status.Alive;
  check('while away your position reports are ignored', ignored, `x ${at.x} -> ${p.pos.x}`);
  check('while away nothing can kill you or see you', untouchable && !p.targetable, `status=${p.status} targetable=${p.targetable}`);
  // the conversation cannot be skipped outright
  room.handle(p, { t: 'bless' });
  const tooSoon = p.away && !p.canFly;
  waitUntil(room, p, p.awayAt + PORTAL.MIN_STAY + 0.1);
  const before = room.matchTime;
  room.handle(p, { t: 'bless' });
  const sp = level.spawns[0];
  check('Viktor will not send you back the instant you arrive', tooSoon);
  check('after Viktor speaks you are back on the landing pad, able to fly', !p.away && p.canFly && p.pos.x === sp[0] && p.pos.z === sp[2] && p.status === Status.Alive,
    `away=${p.away} canFly=${p.canFly} pos=${p.pos.x},${p.pos.y},${p.pos.z} t=${before.toFixed(1)}`);
  // a blessed runner does not go round again
  stepThrough(room, p);
  check('a runner who can fly cannot go through again', !p.away);
}
{
  // flying out over the void (and sinking 20 m) is not a fall; the same trip without flight is
  const fly = setupPortal([0.01, 0, 0]);
  waitUntil(fly.room, fly.p, fly.room.portal!.at + 0.1);
  stepThrough(fly.room, fly.p);
  waitUntil(fly.room, fly.p, fly.p.awayAt + PORTAL.MIN_STAY + 0.1);
  fly.room.handle(fly.p, { t: 'bless' });
  const path: [number, number, number][] = [];
  for (let k = 0; k <= 60; k++) path.push([0, 40.05 - Math.max(0, k - 20) * 0.5, -5.6 - k * 0.4]);
  for (const q of path) sendA(fly.room, fly.p, q[0], q[1], q[2], Anim.Fly, 0, -6, -12);
  check('flying over the void is not a fall', fly.p.status === Status.Alive && fly.fixes.length === 0 && fly.p.pos.y < 21,
    `status=${fly.p.status} cause=${fly.p.cause ?? '-'} fixes=${fly.fixes.length} y=${fly.p.pos.y.toFixed(1)}`);
  // stopping flying out there drops you like anyone else
  for (let k = 1; k <= 40; k++) sendA(fly.room, fly.p, 0, 20 - k * 0.5, path[60][2], Anim.Fall, 0, -15, 0);
  check('stopping flying over the void is a fall', fly.p.status === Status.Dead && fly.p.cause === 'fall', `status=${fly.p.status} cause=${fly.p.cause ?? '-'}`);
  const walk = setupPortal([0.5]);
  for (const q of path) sendA(walk.room, walk.p, q[0], q[1], q[2], Anim.Fly, 0, -6, -12);
  check('claiming to fly without the gift is still a fall', walk.p.status === Status.Dead && walk.p.cause === 'fall', `status=${walk.p.status} cause=${walk.p.cause ?? '-'}`);
}
{
  // a flyer's top speed is fine; the same speed from anyone else is a teleport. The
  // server allows a slack of a couple of metres per message, so this is a client that
  // only reports once a second (a laggy one), flying out over the void behind the pad
  const second = (room: Room, p: RoomPlayer, z: number, anim: number) => {
    for (let k = 0; k < 30; k++) { now += 1 / 30; room.tick(1 / 30); }
    room.handle(p, { t: 'st', s: seq++, p: [p.pos.x, 45, z], v: [0, 0, -FLY.FAST], y: 0, a: anim, g: -1, tm: room.matchTime });
  };
  const fly = setupPortal([0.01, 0, 0]);
  waitUntil(fly.room, fly.p, fly.room.portal!.at + 0.1);
  stepThrough(fly.room, fly.p);
  waitUntil(fly.room, fly.p, fly.p.awayAt + PORTAL.MIN_STAY + 0.1);
  fly.room.handle(fly.p, { t: 'bless' });
  const z0 = fly.p.pos.z;
  for (let k = 1; k <= 3; k++) second(fly.room, fly.p, z0 - k * FLY.FAST, Anim.Fly);
  const run = setupPortal([0.5]);
  const z1 = run.p.pos.z;
  for (let k = 1; k <= 3; k++) second(run.room, run.p, z1 - k * FLY.FAST, Anim.Jump);
  check('a flyer at full speed is accepted', fly.fixes.length === 0 && fly.p.status === Status.Alive && fly.p.pos.z < z0 - 50, `fixes=${fly.fixes.length} z=${fly.p.pos.z.toFixed(1)}`);
  check('the same speed without the gift is corrected', run.fixes.length > 0, `fixes=${run.fixes.length}`);
}
{
  // the gift lasts one run
  const { room, p } = setupPortal([0.01, 0, 0]);
  waitUntil(room, p, room.portal!.at + 0.1);
  stepThrough(room, p);
  waitUntil(room, p, p.awayAt + PORTAL.MIN_STAY + 0.1);
  room.handle(p, { t: 'bless' });
  const had = p.canFly;
  room.handle(p, { t: 'restart' });
  check('a new run takes the gift away', had && !p.canFly && !p.away, `had=${had} canFly=${p.canFly}`);
}
{
  // dropping out mid-conversation: coming back puts you on the pad with the gift
  const { room, p } = setupPortal([0.01, 0, 0]);
  waitUntil(room, p, room.portal!.at + 0.1);
  stepThrough(room, p);
  room.disconnect(p);
  const got: S2C[] = [];
  room.resume({ send(m: S2C) { got.push(m); }, close() {} }, p.token);
  const start = got.find((m) => m.t === 'start') as Extract<S2C, { t: 'start' }> | undefined;
  check('reconnecting mid-conversation brings you back blessed', !p.away && p.canFly && !!start?.fly?.includes(p.id) && !!start?.portal,
    `away=${p.away} canFly=${p.canFly} fly=${JSON.stringify(start?.fly)}`);
}
{
  // debug: a portal right in front of you, open at once
  const { room, p, log } = setupPortal([0.5]);
  p.yaw = 0;
  room.handle(p, { t: 'dbg', cmd: 'portal' });
  room.tick(1 / 30);
  const s = room.portal?.spot.p;
  check('the debug portal opens in front of you', !!s && Math.abs(s[2] - (p.pos.z + 5)) < 0.1 && log.some((e) => e.k === 'portal'), `spot=${s?.join(',')}`);
}

process.exit(fails ? 1 : 0);

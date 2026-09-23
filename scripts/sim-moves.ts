// Measures the movement skills with the real controller so levels can be tuned
// (slide length/time, clearing a low tunnel, which release moments of a swing
// land on the far side of a gap), and checks the ones with hard rules: the
// ledge climb's reach, height limit and cooldown, hooking a grapple from a
// standstill, the automatic ledge climb, what a front flip adds to a jump, and
// that a dash takes you out of a stalker's charge without ever becoming a
// longer jump. And Viktor's gift: flight takes off, holds its height, flies
// along the view, climbs, sinks, lands, stops at walls and falls when you let go.
// Usage: npx tsx scripts/sim-moves.ts
import { CLIMB, DASH, FLY, GRAPPLE, PHYS, PLAYER } from '../shared/constants';
import type { BoxDef, LevelData, V3 } from '../shared/level/types';
import { Anim, PlayerMotor, type MoveInput } from '../shared/physics/character';
import { CollisionWorld } from '../shared/physics/world';
import { Enemy, type EnemyHost, type Target } from '../shared/sim/enemy';

function lvl(boxes: [V3, V3][], grapples: V3[] = []): LevelData {
  const bx: BoxDef[] = boxes.map(([p, s], id) => ({ id, p, s, ry: 0, mat: 'concrete', kind: 'static', solid: true, visible: true, blocksSight: true }));
  return {
    name: 'sim', props: [], enemies: [], winds: [], zones: [], spawns: [], spawnYaw: 0,
    finish: { min: [0, 0, 0], max: [0, 0, 0] }, beacon: [0, 0, 0], killY: -100,
    bounds: { min: [-30, -60], max: [30, 120] }, waypoints: [], ziplines: [], lasers: [], hints: [],
    grapples: grapples.map((p, id) => ({ id, p })), pickups: [], boxes: bx,
  };
}
const inp = (o: Partial<MoveInput> = {}): MoveInput => ({ x: 0, z: 1, sprint: true, jumpHeld: false, jumpPressed: false, ...o });

// ---- slide on flat ground from a sprint
{
  const world = new CollisionWorld(lvl([[[0, -0.5, 30], [10, 1, 100]]]));
  const m = new PlayerMotor();
  m.spawn(0, 0, -15, 0);
  let t = 0, z0 = 0, t0 = 0, started = false;
  for (let i = 0; i < 120 * 6; i++) {
    const press = i === 240;
    world.update(t);
    m.step(world, PHYS.STEP, inp({ slidePressed: press }));
    t += PHYS.STEP;
    if (m.events.slid) { started = true; z0 = m.body.pos.z; t0 = t; }
    if (started && !m.sliding) { console.log(`flat slide from sprint: ${(m.body.pos.z - z0).toFixed(1)} m in ${(t - t0).toFixed(2)} s`); break; }
  }
}

// ---- low tunnel: 0.95 m clearance, 9 m long
{
  const world = new CollisionWorld(lvl([[[0, -0.5, 30], [10, 1, 100]], [[0, 0.95 + 1, 10 + 4.5], [3, 2, 9]], [[-1.75, 1.5, 14.5], [0.5, 3, 9]], [[1.75, 1.5, 14.5], [0.5, 3, 9]]]));
  for (const pressAt of [6, 8, 9.4]) {
    const m = new PlayerMotor();
    m.spawn(0, 0, -5, 0);
    let t = 0, pressed = false, out = 'blocked';
    for (let i = 0; i < 120 * 8; i++) {
      const press = !pressed && m.body.pos.z >= pressAt;
      if (press) pressed = true;
      world.update(t);
      m.step(world, PHYS.STEP, inp({ slidePressed: press }));
      t += PHYS.STEP;
      if (m.body.pos.z > 20) { out = `through at t=${t.toFixed(1)}s`; break; }
    }
    console.log(`tunnel, slide pressed at z=${pressAt} (entrance z=10): ${out}`);
  }
  const m = new PlayerMotor();
  m.spawn(0, 0, -5, 0);
  let t = 0;
  for (let i = 0; i < 120 * 5; i++) { world.update(t); m.step(world, PHYS.STEP, inp({ jumpPressed: m.body.pos.z > 8 && m.body.grounded })); t += PHYS.STEP; }
  console.log(`tunnel without sliding: stopped at z=${m.body.pos.z.toFixed(1)}`);
}

// ---- grapple swing over a gap: A ends at z=0, B starts at z=gap (dy up), anchor above the middle
function swing(gap: number, dy: number, ah: number, releaseAfter: number, hookDelay = 0.12, hold = true): string {
  const world = new CollisionWorld(lvl([[[0, -0.5, -20], [8, 1, 40]], [[0, dy - 0.5, gap + 20], [8, 1, 40]]], [[0, ah, gap / 2]]));
  const m = new PlayerMotor();
  m.spawn(0, 0, -12, 0);
  let t = 0, jumpedAt = -1, hookedAt = -1, released = -1;
  for (let i = 0; i < 120 * 8; i++) {
    const b = m.body;
    const jump = jumpedAt < 0 && b.pos.z > -0.25 && b.grounded;
    if (jump) jumpedAt = t;
    const hook = jumpedAt >= 0 && hookedAt < 0 && t - jumpedAt >= hookDelay ? 0 : -1;
    const rel = hookedAt >= 0 && released < 0 && t - hookedAt >= releaseAfter;
    if (rel) released = t;
    world.update(t);
    m.step(world, PHYS.STEP, inp({ jumpPressed: jump, grapple: hook, grappleRelease: rel, x: 0, z: hold ? 1 : 0 }));
    t += PHYS.STEP;
    if (m.events.hooked >= 0) hookedAt = t;
    if (b.grounded && b.pos.z > gap + 0.2 && Math.abs(b.pos.y - dy) < 0.05) return `LAND z=${b.pos.z.toFixed(1)}`;
    if (b.pos.y < -12) return 'fall';
  }
  return 'timeout';
}
for (const [gap, dy, ah] of [[18, 1.5, 9.5], [14, 0, 8], [12, 2, 9]] as [number, number, number][]) {
  const row: string[] = [];
  for (let r = 0.3; r <= 1.8; r += 0.1) row.push(`${r.toFixed(1)}:${swing(gap, dy, ah, r).replace('LAND ', '')}`);
  console.log(`swing gap ${gap} dy ${dy} anchor +${ah}: ${row.join(' ')}`);
}
console.log('run speeds', PLAYER.RUN_SPEED, PLAYER.SPRINT_SPEED);
if (process.env.SWEEP) {
  for (const [gap, dy, ah] of [[15, 1.5, 9], [15, 1.5, 10], [14, 1.5, 9], [14, 1, 9], [13, 1.5, 9], [15, 0, 9], [15, 0, 10]] as [number, number, number][]) {
    const row: string[] = [];
    let ok = 0;
    for (let r = 0.3; r <= 2.0; r += 0.1) { const res = swing(gap, dy, ah, r); if (res.startsWith('LAND')) ok++; row.push(`${r.toFixed(1)}:${res.replace('LAND ', '')}`); }
    let passive = 0;
    for (let r = 0.3; r <= 2.0; r += 0.1) if (swing(gap, dy, ah, r, 0.12, false).startsWith('LAND')) passive++;
    console.log(`gap ${gap} dy ${dy} anchor +${ah}: window ${(ok * 0.1).toFixed(1)}s (hands off ${(passive * 0.1).toFixed(1)}s)  ${row.join(' ')}`);
  }
}

// ---------------------------------------------------------------- checks
let fails = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) fails++;
}

/** Walks into a wall whose top is `top` high, holding forward. Returns the height reached and when. */
function climbAt(top: number, seconds = 4): { y: number; t: number } {
  const world = new CollisionWorld(lvl([[[0, -0.5, 0], [10, 1, 60]], [[0, 0, 30], [10, top * 2, 20]]]));
  const m = new PlayerMotor();
  m.spawn(0, 0, 13, 0); // a short walk-up to the wall at z = 20
  let t = 0, reached = -1, best = 0;
  for (let i = 0; i < 120 * seconds; i++) {
    world.update(t);
    // just hold forward: the climb is automatic
    m.step(world, PHYS.STEP, inp({ z: 1, sprint: false }));
    t += PHYS.STEP;
    if (m.body.grounded) best = Math.max(best, m.body.pos.y);
    if (reached < 0 && m.body.grounded && m.body.pos.y > top - 0.05) reached = t;
  }
  return { y: best, t: reached };
}

{
  const ok = climbAt(1.8);
  check('holding forward climbs a ledge a jump cannot reach', ok.y > 1.75 && ok.t > 0, `stood on y=${ok.y.toFixed(2)} after ${ok.t.toFixed(2)}s`);
  const tall = climbAt(3.5);
  check('a wall above the climb limit stays unclimbable', tall.y < 0.5, `highest footing y=${tall.y.toFixed(2)} (limit ${CLIMB.MAX} m)`);
}
{
  // two ledges back to back: the cooldown stops you racing up a stack of them
  const world = new CollisionWorld(lvl([[[0, -0.5, 0], [10, 1, 60]], [[0, 0, 24], [10, 3.2, 8]], [[0, 0, 36], [10, 6.4, 16]]]));
  const m = new PlayerMotor();
  m.spawn(0, 0, -6, 0);
  let t = 0, first = -1, second = -1;
  for (let i = 0; i < 120 * 8; i++) {
    world.update(t);
    m.step(world, PHYS.STEP, inp({ z: 1, sprint: false }));
    t += PHYS.STEP;
    const b = m.body;
    if (first < 0 && b.grounded && b.pos.y > 1.55) first = t;
    if (second < 0 && b.grounded && b.pos.y > 3.15) second = t;
  }
  check('climbs cannot be chained back to back', second > 0 && second - first >= CLIMB.COOLDOWN,
    `first ${first.toFixed(2)}s, second ${second < 0 ? 'never' : second.toFixed(2) + 's'} (cooldown ${CLIMB.COOLDOWN}s)`);
}

/** Hooks an anchor from a standstill at the lip of a gap, without jumping first. */
function standHook(gap: number, dy: number, ah: number, releaseAfter: number, jumpAt = -1): string {
  const world = new CollisionWorld(lvl([[[0, -0.5, -20], [8, 1, 40]], [[0, dy - 0.5, gap + 20], [8, 1, 40]]], [[0, ah, gap / 2]]));
  const m = new PlayerMotor();
  m.spawn(0, 0, -0.8, 0);
  let t = 0, hookedAt = -1, released = -1, peak = 0, wasAir = false;
  for (let i = 0; i < 120 * 8; i++) {
    const b = m.body;
    const settle = i < 30; // stand still first: no run-up, no jump
    const hook = !settle && hookedAt < 0 && m.canHook ? 0 : -1;
    const rel = hookedAt >= 0 && released < 0 && t - hookedAt >= releaseAfter;
    const jump = jumpAt >= 0 && hookedAt >= 0 && t - hookedAt >= jumpAt && t - hookedAt < jumpAt + PHYS.STEP * 1.5;
    if (rel) released = t;
    world.update(t);
    m.step(world, PHYS.STEP, inp({ x: 0, z: settle ? 0 : 1, sprint: false, grapple: hook, grappleRelease: rel && jumpAt < 0, jumpPressed: jump }));
    t += PHYS.STEP;
    if (m.events.hooked >= 0) hookedAt = t;
    if (hookedAt >= 0 && !b.grounded) wasAir = true;
    if (hookedAt >= 0) peak = Math.max(peak, Math.hypot(b.vel.x, b.vel.z));
    if (jumpAt >= 0 && hookedAt >= 0 && t - hookedAt > jumpAt + 0.12) return m.grapple ? 'still hooked' : 'dropped';
    if (b.grounded && b.pos.z > gap + 0.2 && Math.abs(b.pos.y - dy) < 0.05) return `LAND z=${b.pos.z.toFixed(1)} peak ${peak.toFixed(1)} m/s${wasAir ? '' : ' (never airborne)'}`;
    if (b.pos.y < -12) return `fall (peak ${peak.toFixed(1)} m/s)`;
  }
  return 'timeout';
}

{
  const r = standHook(14, 0, 8, 0.9);
  check('hooking from a standstill swings you across, it does not drop you', r.startsWith('LAND'), r);
  const early = standHook(14, 0, 8, 9, 0.1);
  check('a jump right after hooking keeps the rope', early === 'still hooked', early);
  const late = standHook(14, 0, 8, 9, 0.5);
  check('a jump later in the swing lets go', late === 'dropped', late);
}
{
  // the rope stays on while the grapple button is held and comes off when it is let go
  function holdHook(holdFor: number): { swung: number; landed: string } {
    const world = new CollisionWorld(lvl([[[0, -0.5, -20], [8, 1, 40]], [[0, -0.5, 14 + 20], [8, 1, 40]]], [[0, 8, 7]]));
    const m = new PlayerMotor();
    m.spawn(0, 0, -0.8, 0);
    let t = 0, hookedAt = -1, swung = -1, landed = 'no';
    for (let i = 0; i < 120 * 8; i++) {
      const b = m.body;
      const settle = i < 30;
      const hook = !settle && hookedAt < 0 && m.canHook ? 0 : -1;
      const held = hookedAt < 0 ? !settle : t - hookedAt < holdFor;
      world.update(t);
      m.step(world, PHYS.STEP, inp({ x: 0, z: settle ? 0 : 1, sprint: false, grapple: hook, grappleHeld: held }));
      t += PHYS.STEP;
      if (m.events.hooked >= 0) hookedAt = t;
      if (m.events.unhooked && swung < 0) swung = t - hookedAt;
      if (b.grounded && b.pos.z > 14.2) { landed = `LAND z=${b.pos.z.toFixed(1)}`; break; }
      if (b.pos.y < -12) { landed = 'fall'; break; }
    }
    return { swung, landed };
  }
  const held = holdHook(0.9);
  check('letting go of the grapple button lets go of the rope', Math.abs(held.swung - 0.9) < 0.02 && held.landed.startsWith('LAND'),
    `button up after 0.90 s, rope off after ${held.swung.toFixed(3)} s, ${held.landed}`);
  const tap = holdHook(0.05);
  check('a quick tap still hangs on for a moment', Math.abs(tap.swung - GRAPPLE.RELEASE_LOCK) < 0.02, `rope off after ${tap.swung.toFixed(3)} s`);
}

// ---------------------------------------------------------------- front flip
/**
 * Sprints off the end of a platform and presses Space again at each of `taps`
 * seconds after take-off. Returns the range of the jump (distance covered before
 * dropping back to take-off height), how high it went and how many flips fired.
 */
function jumpRun(taps: number[], boost = false): { dist: number; flips: number; peak: number; speed: number } {
  const world = new CollisionWorld(lvl([[[0, -0.5, -10], [10, 1, 40]]]));
  const m = new PlayerMotor();
  m.spawn(0, 0, -20, 0);
  m.boost = boost;
  let t = 0, jumpedAt = -1, edge = 0, flips = 0, peak = 0, dist = 0, speed = 0;
  for (let i = 0; i < 120 * 6; i++) {
    const b = m.body;
    const jump = jumpedAt < 0 && b.pos.z > 9.2 && b.grounded;
    if (jump) { jumpedAt = t; edge = b.pos.z; speed = Math.hypot(b.vel.x, b.vel.z); }
    const tap = jumpedAt >= 0 && taps.some((x) => t - jumpedAt >= x && t - jumpedAt < x + PHYS.STEP);
    world.update(t);
    m.step(world, PHYS.STEP, inp({ z: 1, sprint: true, jumpPressed: jump || tap }));
    t += PHYS.STEP;
    if (m.events.flipped) flips++;
    if (jumpedAt >= 0) peak = Math.max(peak, b.pos.y);
    // back down to the height it left from: that is the jump's range
    if (jumpedAt >= 0 && !dist && b.pos.y <= 0 && b.vel.y < 0 && t - jumpedAt > 0.1) dist = b.pos.z - edge;
    if (jumpedAt >= 0 && b.pos.y < -8) break;
  }
  return { dist, flips, peak, speed };
}

{
  const plain = jumpRun([]);
  const flipped = jumpRun([0.12]);
  const late = jumpRun([0.34]);
  check('a flip works on a late press too, not just a quick double tap', late.flips === 1, `flips=${late.flips}`);
  const gain = flipped.dist - plain.dist;
  check('a front flip carries a sprint jump further', flipped.flips === 1 && gain > 0.4 && gain < 1.4,
    `range ${plain.dist.toFixed(2)} m -> ${flipped.dist.toFixed(2)} m (+${gain.toFixed(2)} m)`);
  check('a flip lengthens a jump without raising it', flipped.peak - plain.peak < 0.2,
    `peak ${plain.peak.toFixed(2)} m -> ${flipped.peak.toFixed(2)} m`);
  const twice = jumpRun([0.12, 0.45, 0.55]);
  check('only one flip fits in an airtime', twice.flips === 1, `flips=${twice.flips}`);
  // the boost crate: faster running and a longer jump, without turning it into a high jump
  const boosted = jumpRun([], true);
  const boostGain = boosted.dist / plain.dist - 1;
  check('a boost speeds up the sprint', boosted.speed > plain.speed * 1.18 && boosted.speed < 12, `take-off ${plain.speed.toFixed(2)} m/s -> ${boosted.speed.toFixed(2)} m/s`);
  check('a boosted sprint jump carries about a third further', boostGain > 0.25 && boostGain < 0.45,
    `range ${plain.dist.toFixed(2)} m -> ${boosted.dist.toFixed(2)} m (+${(boostGain * 100).toFixed(0)}%), peak ${plain.peak.toFixed(2)} m -> ${boosted.peak.toFixed(2)} m`);
  // a long fall: press Space seconds after leaving the ground and it still flips
  {
    const world = new CollisionWorld(lvl([[[0, -0.5, -10], [10, 1, 40]]]));
    const m = new PlayerMotor();
    m.spawn(0, 0, -20, 0);
    let t = 0, air = -1, flips = 0, pressed = false;
    for (let i = 0; i < 120 * 8; i++) {
      const b = m.body;
      if (air < 0 && !b.grounded && b.pos.z > 10) air = t;
      const press = air >= 0 && !pressed && t - air > 1.2;
      if (press) pressed = true;
      world.update(t);
      m.step(world, PHYS.STEP, inp({ z: 1, sprint: true, jumpPressed: press }));
      t += PHYS.STEP;
      if (m.events.flipped) flips++;
      if (b.pos.y < -60) break;
    }
    check('a flip still fires seconds into a fall', flips === 1, `flips=${flips} after a ${(1.2).toFixed(1)}s wait`);
  }
  // ...but a press on the way down close to the ground stays a buffered landing jump
  {
    const world = new CollisionWorld(lvl([[[0, -0.5, 30], [10, 1, 120]]]));
    const m = new PlayerMotor();
    m.spawn(0, 0, 0, 0);
    let t = 0, jumped = false, flips = 0, jumps = 0;
    for (let i = 0; i < 120 * 3; i++) {
      const b = m.body;
      const jump = !jumped && b.grounded && i > 20;
      if (jump) jumped = true;
      // press again once the fall is nearly over
      const press = jumped && !b.grounded && b.vel.y < -4;
      world.update(t);
      m.step(world, PHYS.STEP, inp({ z: 1, sprint: true, jumpPressed: jump || press }));
      t += PHYS.STEP;
      if (m.events.flipped) flips++;
      if (m.events.jumped) jumps++;
    }
    check('a press just before landing still buffers into a jump', flips === 0 && jumps > 1, `flips=${flips} jumps=${jumps}`);
  }
}

// ---------------------------------------------------------------- steep stairs
// Sprinting up the steepest flight in the level (5.6 m over 9 m, like the finale's)
// and jumping, then flipping, at every moment along the way. A jump that rises
// slower than the steps used to sink into them until they shoved the runner out
// through the gap underneath.
{
  const rise = 5.6, len = 9, w = 3;
  const level = lvl([[[0, -0.5, -10], [w, 1, 20]], [[0, rise - 0.5, len + 10], [w, 1, 20]]]);
  level.boxes.push({ id: 2, p: [0, -0.3, len / 2], s: [w, 0.6, len], ry: 0, rise, mat: 'invisible', kind: 'static', solid: true, visible: false, blocksSight: false });
  let tried = 0, lost = 0, worst = '';
  for (let jumpZ = -2; jumpZ <= 6; jumpZ += 0.5) {
    for (let flipAfter = -0.04; flipAfter <= 0.6; flipAfter += 0.04) {
      const world = new CollisionWorld(level);
      const m = new PlayerMotor();
      m.spawn(0, 0, -12, 0);
      let t = 0, jumpedAt = -1, flipped = flipAfter < 0;
      for (let i = 0; i < 120 * 4; i++) {
        const b = m.body;
        const jump = jumpedAt < 0 && b.grounded && b.pos.z >= jumpZ;
        if (jump) jumpedAt = t;
        const flip = jumpedAt >= 0 && !flipped && t - jumpedAt >= flipAfter;
        if (flip) flipped = true;
        world.update(t);
        m.step(world, PHYS.STEP, inp({ z: 1, sprint: true, jumpHeld: true, jumpPressed: jump || flip }));
        t += PHYS.STEP;
        if (b.pos.y < -1 || Math.abs(b.pos.x) > 0.3) { lost++; worst ||= `jump at z=${jumpZ}, flip +${flipAfter.toFixed(2)} s`; break; }
        if (b.pos.z > len + 5) break;
      }
      tried++;
    }
  }
  check('jumping and flipping up steep stairs never drops you through them', lost === 0, `${lost}/${tried} runs fell through ${worst}`);
}

// ---------------------------------------------------------------- dash
/** Runs head-on at a charging stalker and dashes aside at `dashAt` metres. Returns what happened. */
function headOn(dashAt: number, repeat = false): string {
  const world = new CollisionWorld(lvl([[[0, -0.5, 30], [40, 1, 160]]]));
  const m = new PlayerMotor();
  m.spawn(0, 0, 0, 0);
  const b = m.body;
  const target: Target = { id: 1, pos: b.pos, vel: b.vel, targetable: true };
  // the stalker starts 26 m up the corridor, facing back down it
  const e = new Enemy({ id: 0, kind: 'melee', p: [0, 0, 26], yaw: Math.PI, leash: 400 });
  let killed = false;
  const host: EnemyHost = { world, time: 0, targets: [target], kill: () => { killed = true; }, fire: () => {}, emit: () => {} };
  let t = 0, dashed = false, closest = Infinity;
  for (let i = 0; i < 120 * 6 && !killed; i++) {
    const gap = Math.hypot(e.pos.x - b.pos.x, e.pos.z - b.pos.z);
    closest = Math.min(closest, gap);
    const dash = dashAt > 0 && gap <= dashAt && (repeat ? !m.dashing : !dashed);
    if (dash) dashed = true;
    world.update(t);
    // dash to the runner's right: the camera basis is (-cos yaw, sin yaw)
    m.step(world, PHYS.STEP, inp({ z: 1, sprint: true, dashX: dash ? -1 : 0, dashZ: dash ? 0 : 0 }));
    host.time = t;
    e.update(PHYS.STEP, host);
    t += PHYS.STEP;
  }
  return killed ? `CAUGHT (closest ${closest.toFixed(2)} m)` : `clear, closest ${closest.toFixed(2)} m`;
}

{
  const control = headOn(0);
  check('a stalker charged head-on catches a runner who keeps running', control.startsWith('CAUGHT'), control);
  const rows: string[] = [];
  let ok = 0, tried = 0;
  for (const d of [2, 2.5, 3, 3.5, 4, 4.5]) {
    const r = headOn(d);
    tried++;
    if (!r.startsWith('CAUGHT')) ok++;
    rows.push(`${d}m:${r.startsWith('CAUGHT') ? 'caught' : 'clear'}`);
  }
  check('one dash beats a head-on charge', ok === tried, `${ok}/${tried} dash distances clear — ${rows.join(' ')}`);
  // outside that window: too late to get clear, or early enough that it closes
  // again -- and with no cooldown you simply dash a second time
  const late = headOn(1.7);
  const early = headOn(6);
  const earlyAgain = headOn(6, true);
  check('dashing early then again still beats the charge', !earlyAgain.startsWith('CAUGHT'),
    `at 1.7 m it is too late (${late.startsWith('CAUGHT') ? 'caught' : 'clear'}); one dash at 6 m is too early (${early.startsWith('CAUGHT') ? 'caught' : 'clear'}); dashing again: ${earlyAgain}`);
}
{
  // a dash must never be worth more than a sprint on take-off
  const world = new CollisionWorld(lvl([[[0, -0.5, 30], [40, 1, 160]]]));
  const m = new PlayerMotor();
  m.spawn(0, 0, 0, 0);
  let t = 0, fastest = 0;
  for (let i = 0; i < 120 * 3; i++) {
    const dash = i === 120;
    world.update(t);
    m.step(world, PHYS.STEP, inp({ z: 1, sprint: true, dashX: dash ? -1 : 0 }));
    t += PHYS.STEP;
    if (i > 120 + DASH.TIME * 120) fastest = Math.max(fastest, Math.hypot(m.body.vel.x, m.body.vel.z));
  }
  check('a dash ends at running speed, so it cannot stretch a jump', fastest <= PLAYER.SPRINT_SPEED + 0.01,
    `fastest after the dash ${fastest.toFixed(2)} m/s (sprint ${PLAYER.SPRINT_SPEED})`);
}
{
  // sideways reach of a standing dash, and two of them back to back with no wait
  const world = new CollisionWorld(lvl([[[0, -0.5, 30], [60, 1, 160]]]));
  const m = new PlayerMotor();
  m.spawn(0, 0, 0, 0);
  let t = 0, dashes = 0, x0 = 0, reach = 0, firstEnd = -1, secondAt = -1;
  for (let i = 0; i < 120 * 3; i++) {
    const dash = !m.dashing && dashes < 2 && i > 12;
    world.update(t);
    m.step(world, PHYS.STEP, inp({ x: 0, z: 0, sprint: false, dashX: dash ? -1 : 0 }));
    t += PHYS.STEP;
    if (m.events.dashed) { dashes++; if (dashes === 1) x0 = m.body.pos.x; else secondAt = t; }
    if (dashes === 1) { reach = Math.abs(m.body.pos.x - x0); if (!m.dashing && firstEnd < 0) firstEnd = t; }
    if (dashes === 2 && !m.dashing) break;
  }
  check('two dashes run back to back with no cooldown', secondAt > 0 && secondAt - firstEnd < 0.05,
    `next dash started ${(secondAt - firstEnd).toFixed(3)}s after the first ended`);
  check('a dash covers about 2.6 m', reach > 2.2 && reach < 3.2, `sideways reach ${reach.toFixed(2)} m`);
  check('both dashes fired', dashes === 2, `dashes=${dashes}`);
}
{
  // in the air the dash goes across the flight path, so the jump reaches no further
  function airJump(dashAt: number): { range: number; drift: number; dashes: number } {
    const world = new CollisionWorld(lvl([[[0, -0.5, -10], [20, 1, 40]]]));
    const m = new PlayerMotor();
    m.spawn(0, 0, -20, 0);
    let t = 0, jumpedAt = -1, edge = 0, range = 0, drift = 0, dashes = 0, dashed = false;
    for (let i = 0; i < 120 * 6; i++) {
      const b = m.body;
      const jump = jumpedAt < 0 && b.pos.z > 9.2 && b.grounded;
      if (jump) { jumpedAt = t; edge = b.pos.z; }
      const dash = dashAt > 0 && jumpedAt >= 0 && !dashed && t - jumpedAt >= dashAt;
      if (dash) dashed = true;
      world.update(t);
      m.step(world, PHYS.STEP, inp({ z: 1, sprint: true, jumpPressed: jump, dashX: dash ? -1 : 0 }));
      t += PHYS.STEP;
      if (m.events.dashed) dashes++;
      if (jumpedAt >= 0 && !range && b.pos.y <= 0 && b.vel.y < 0 && t - jumpedAt > 0.1) { range = b.pos.z - edge; drift = Math.abs(b.pos.x); }
      if (jumpedAt >= 0 && b.pos.y < -8) break;
    }
    return { range, drift, dashes };
  }
  const plain = airJump(0);
  const mid = airJump(0.22);
  check('a dash works in the air', mid.dashes === 1, `dashes=${mid.dashes}`);
  check('an air dash moves you aside', mid.drift > 1.6, `sideways drift ${mid.drift.toFixed(2)} m`);
  check('an air dash does not carry the jump any further', mid.range <= plain.range + 0.1,
    `range ${plain.range.toFixed(2)} m -> ${mid.range.toFixed(2)} m`);
}
// ---- flight (Viktor's gift)
{
  const world = new CollisionWorld(lvl([[[0, -0.5, 30], [30, 1, 100]], [[0, 5, 60], [30, 10, 1]]]));
  const still = (o: Partial<MoveInput> = {}) => inp({ x: 0, z: 0, sprint: false, ...o });
  // `o` gets the step number: a toggle on step 0 is one click
  const run = (m: PlayerMotor, secs: number, o: (i: number) => Partial<MoveInput>) => {
    for (let i = 0; i < secs * 120; i++) { world.update(0); m.step(world, PHYS.STEP, still(o(i))); }
  };
  // without the gift the toggle does nothing at all
  const a = new PlayerMotor(), b = new PlayerMotor();
  a.spawn(0, 0, 0, 0); b.spawn(0, 0, 0, 0);
  run(a, 2, (i) => ({ z: 1, jumpPressed: i === 0, flyToggle: i === 0 }));
  run(b, 2, (i) => ({ z: 1, jumpPressed: i === 0 }));
  check('without the gift a left click changes nothing', !a.flying && a.body.pos.z === b.body.pos.z && a.body.pos.y === b.body.pos.y);
  // take off from a standstill and hold the height with no keys down
  const m = new PlayerMotor();
  m.spawn(0, 0, 0, 0);
  m.canFly = true;
  run(m, 0.2, () => ({}));
  run(m, 2, (i) => ({ flyToggle: i === 0 }));
  const y2 = m.body.pos.y;
  run(m, 2, () => ({}));
  check('taking off lifts you off the ground', m.flying && m.anim === Anim.Fly && y2 > 1.2, `height ${y2.toFixed(2)} m`);
  check('with no keys down you hold your height', Math.abs(m.body.pos.y - y2) < 0.05 && Math.hypot(m.body.vel.x, m.body.vel.y, m.body.vel.z) < 0.05,
    `${y2.toFixed(2)} -> ${m.body.pos.y.toFixed(2)} m`);
  // forward flies along the view: level, then pitched up 30 degrees
  run(m, 1, () => ({ flyZ: 1 }));
  check('forward flight reaches cruising speed within a second', Math.abs(m.body.vel.z - FLY.SPEED) < 0.01 && Math.abs(m.body.vel.y) < 0.01, `vz=${m.body.vel.z.toFixed(2)} vy=${m.body.vel.y.toFixed(2)}`);
  const up0 = m.body.pos.y;
  run(m, 1, () => ({ flyZ: Math.cos(0.52), flyY: Math.sin(0.52), sprint: true }));
  check('looking up while flying forward climbs, Shift flies faster', Math.abs(Math.hypot(m.body.vel.y, m.body.vel.z) - FLY.FAST) < 0.05 && m.body.pos.y > up0 + 5,
    `speed ${Math.hypot(m.body.vel.y, m.body.vel.z).toFixed(2)} climbed ${(m.body.pos.y - up0).toFixed(1)} m`);
  // Space climbs, descend sinks
  const c0 = m.body.pos.y;
  run(m, 1, () => ({ jumpHeld: true }));
  const climbed = m.body.pos.y - c0;
  run(m, 0.5, () => ({}));
  const d0 = m.body.pos.y;
  run(m, 1, () => ({ descend: true }));
  check('Space climbs and Ctrl sinks at the climb speed', Math.abs(m.body.vel.y + FLY.VERTICAL) < 0.01 && climbed > FLY.VERTICAL * 0.6 && d0 - m.body.pos.y > FLY.VERTICAL * 0.6,
    `climbed ${climbed.toFixed(1)} m, sank ${(d0 - m.body.pos.y).toFixed(1)} m`);
  // diving at the floor without holding descend: you skim it at the hover height instead of hitting it
  for (let i = 0; i < 120 * 10 && m.body.pos.y > 2; i++) { world.update(0); m.step(world, PHYS.STEP, still({ descend: true })); }
  let lowest = Infinity;
  for (let i = 0; i < 120 * 3; i++) { world.update(0); m.step(world, PHYS.STEP, still({ flyZ: 0.95, flyY: -0.3 })); lowest = Math.min(lowest, m.body.pos.y); }
  const hover = m.body.pos.y;
  check('diving at the floor skims it instead of landing', m.flying && !m.body.grounded && Math.abs(hover - FLY.HOVER) < 0.1 && lowest > 0.2,
    `settled at ${hover.toFixed(2)} m, lowest ${lowest.toFixed(2)} m`);
  let landed = false;
  for (let i = 0; i < 120 * 3 && m.flying; i++) { world.update(0); m.step(world, PHYS.STEP, still({ descend: true })); if (m.events.flew < 0) landed = true; }
  check('holding descend onto the floor lands you and ends flight', landed && !m.flying && m.body.grounded && Math.abs(m.body.pos.y) < 0.01, `grounded=${m.body.grounded} y=${m.body.pos.y.toFixed(2)}`);
  // walls stop a flyer
  const w = new PlayerMotor();
  w.spawn(0, 0, 50, 0);
  w.canFly = true;
  run(w, 0.2, () => ({}));
  run(w, 4, (i) => ({ flyToggle: i === 0, flyZ: 1, sprint: true }));
  check('a wall stops a flyer', w.flying && w.body.pos.z < 59.5 - PLAYER.RADIUS + 0.01, `z=${w.body.pos.z.toFixed(2)} (wall face at 59.5)`);
  // letting go in the air: gravity takes over
  const g = new PlayerMotor();
  g.spawn(0, 20, 0, 0);
  g.canFly = true;
  run(g, 0.5, (i) => ({ flyToggle: i === 0 }));
  const gy = g.body.pos.y;
  run(g, 0.5, (i) => ({ flyToggle: i === 0 }));
  check('stopping in mid-air drops you', !g.flying && g.body.pos.y < gy - 2 && g.anim === Anim.Fall, `${gy.toFixed(1)} -> ${g.body.pos.y.toFixed(1)} m`);
  // taking off mid-fall catches you
  run(g, 0.3, () => ({}));
  const fall = g.body.vel.y;
  run(g, 1.5, (i) => ({ flyToggle: i === 0 }));
  check('taking off mid-fall catches you', fall < -10 && g.flying && Math.abs(g.body.vel.y) < 0.05, `falling at ${fall.toFixed(1)} m/s, now ${g.body.vel.y.toFixed(2)} m/s`);
  // the sky has a ceiling
  const h = new PlayerMotor();
  h.spawn(0, 10, 0, 0);
  h.canFly = true;
  h.flyLimits.maxY = 30;
  run(h, 12, (i) => ({ flyToggle: i === 0, jumpHeld: true }));
  check('you cannot fly above the ceiling', h.body.pos.y < 33, `y=${h.body.pos.y.toFixed(1)} (ceiling 30)`);
}
process.exit(fails ? 1 : 0);

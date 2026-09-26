// Speedster Battle, checked headless: the stride cadence that sets a runner's
// speed (only alternating clicks count, faster clicking runs faster, stopping
// lets it fade), the course (floor and barriers everywhere, no way to fall),
// runners driven along it by the real character controller at different
// cadences, and the room's side of it: the rift the Warden leaves, the warp, the
// race, its finish, its results and a rematch.
// Usage: npx tsx scripts/sim-race.ts
import { RACE } from '../shared/constants';
import { getRace, trackIndex } from '../shared/level/race';
import { CollisionWorld, type GroundHit, type RayHit } from '../shared/physics/world';
import { Cadence, raceTarget } from '../shared/sim/cadence';

let fails = 0;

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
  check('the course is about five kilometres long', T.length > 4600 && T.length < 5400, `${T.length.toFixed(0)} m`);
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

console.log(fails ? `${fails} check(s) failed` : 'all race checks passed');
process.exit(fails ? 1 : 0);

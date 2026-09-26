// Speedster Battle, checked headless: the stride cadence that sets a runner's
// speed (only alternating clicks count, faster clicking runs faster, stopping
// lets it fade), the course (floor and barriers everywhere, no way to fall),
// runners driven along it by the real character controller at different
// cadences, and the room's side of it: the rift the Warden leaves, the warp, the
// race, its finish, its results and a rematch.
// Usage: npx tsx scripts/sim-race.ts
import { RACE } from '../shared/constants';
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

console.log(fails ? `${fails} check(s) failed` : 'all race checks passed');
process.exit(fails ? 1 : 0);

// A speedster's stride cadence: in Speedster Battle the mouse buttons are the
// legs. Left, right, left, right: each click on the other button from the last
// is a stride; the same button twice is still one. The pace is read from the
// last few intervals between strides (two strides are enough to know it), can
// never be more than one stride per the time since the last one (so it falls
// away smoothly when the clicking stops), and sets the speed the runner is
// driving toward. The client feeds it clicks; the test bots feed it made-up
// ones; the motor turns its target into running (shared/physics/character.ts).

import { RACE } from '../constants';

/** The speed a cadence (strides a second) drives toward: BASE with none, TOP at C_MAX and above. */
export function raceTarget(rate: number): number {
  const k = Math.min(Math.max(rate, 0) / RACE.C_MAX, 1);
  return RACE.BASE + (RACE.TOP - RACE.BASE) * Math.pow(k, RACE.CURVE);
}

export class Cadence {
  /** Strides counted since the last reset. */
  strides = 0;
  /** The button of the last counted stride (0 left, 1 right; -1 none yet). */
  last: 0 | 1 | -1 = -1;
  /** Times of the most recent strides, oldest first (at most WINDOW + 1). */
  private readonly times: number[] = [];

  reset() { this.strides = 0; this.last = -1; this.times.length = 0; }

  /** A click on `side` at time `t`: true when it counts as a stride (the other button from the last). */
  stride(side: 0 | 1, t: number): boolean {
    if (side === this.last) return false;
    this.last = side;
    this.strides++;
    this.times.push(t);
    if (this.times.length > RACE.WINDOW + 1) this.times.shift();
    return true;
  }

  /** Strides a second right now. */
  rate(t: number): number {
    const n = this.times.length;
    if (n < 2) return 0;
    const lastT = this.times[n - 1], since = t - lastT;
    if (since > RACE.STALE) return 0;
    const span = lastT - this.times[0];
    if (span <= 1e-6) return 0;
    const pace = (n - 1) / span;
    return since > 1e-6 ? Math.min(pace, 1 / since) : pace;
  }

  /** The speed this cadence drives toward right now. */
  target(t: number): number { return raceTarget(this.rate(t)); }
}

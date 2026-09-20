// Snapshot interpolation for remote entities (players, enemies).

export class InterpBuffer {
  private times: number[] = [];
  private vals: number[][] = [];
  last: number[] = [];

  push(t: number, v: number[]) {
    const n = this.times.length;
    if (n && t <= this.times[n - 1]) {
      if (t === this.times[n - 1]) this.vals[n - 1] = v;
      return;
    }
    this.times.push(t);
    this.vals.push(v);
    this.last = v;
    while (this.times.length > 2 && this.times[1] < t - 1.5) { this.times.shift(); this.vals.shift(); }
  }

  clear() { this.times = []; this.vals = []; this.last = []; }

  get empty() { return this.times.length === 0; }

  /**
   * Interpolates continuous fields. `angles` lists indices that wrap around
   * (yaw). Discrete fields are copied from the older sample. Returns false if empty.
   */
  sample(t: number, out: number[], angles: number[] = []): boolean {
    const n = this.times.length;
    if (!n) return false;
    if (n === 1 || t <= this.times[0]) { copyInto(out, this.vals[0]); return true; }
    let i = n - 2;
    if (t < this.times[n - 1]) { while (i > 0 && this.times[i] > t) i--; }
    const t0 = this.times[i], t1 = this.times[i + 1];
    const a = this.vals[i], b = this.vals[i + 1];
    // extrapolate at most 0.2s past the newest sample
    let k = (t - t0) / Math.max(1e-6, t1 - t0);
    k = Math.min(k, 1 + 0.2 / Math.max(0.01, t1 - t0));
    for (let j = 0; j < b.length; j++) {
      if (j >= a.length) { out[j] = b[j]; continue; }
      if (angles.includes(j)) {
        let d = b[j] - a[j];
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        out[j] = a[j] + d * Math.min(k, 1);
      } else out[j] = a[j] + (b[j] - a[j]) * k;
    }
    out.length = b.length;
    return true;
  }
}

function copyInto(out: number[], v: number[]) {
  for (let j = 0; j < v.length; j++) out[j] = v[j];
  out.length = v.length;
}

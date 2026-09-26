// Speedster Battle on the authoritative side: where each runner is along the
// course, how fast it has gone, and the finish. The room hands every accepted
// position report to `report`; crossing the line is timed on the runner's own
// clock (between its last two reports, clamped to the last 0.35 s), so a close
// finish is decided by the running, not by whose messages arrived first. Once
// the winner is home the rest have RACE.GRACE seconds; whoever is still running
// then is ranked by how far they got.

import { RACE } from '../constants';
import { trackIndex, trackPoint, trackS, type RaceTrack } from '../level/race';
import { Status, type MatchResult } from '../protocol';
import type { RoomPlayer } from './room';

const r2 = (v: number) => Math.round(v * 100) / 100;

export class Racer {
  /** Nearest sample and distance along the course. */
  idx = -1;
  s = 0;
  /** Where it started (the grid), the fastest it has gone, and its race time and place once home (0: not yet). */
  readonly s0: number;
  top = 0;
  time = 0;
  place = 0;
  /** The client's clock at its last report. */
  lastTm = 0;
  constructor(readonly p: RoomPlayer, track: RaceTrack, go: number) {
    this.idx = trackIndex(track, p.pos.x, p.pos.y, p.pos.z, -1);
    this.s = this.s0 = trackS(track, this.idx, p.pos.x, p.pos.z);
    this.lastTm = go;
  }
}

export class RaceState {
  readonly racers: Racer[];
  /** Match time the race ends whatever happens (set when the winner is home). */
  deadline = Infinity;
  /** Match time the race ended (for the average speed of those still running). */
  endedAt = 0;
  private home = 0;

  constructor(readonly track: RaceTrack, players: RoomPlayer[], readonly go: number) {
    this.racers = players.map((p) => new Racer(p, track, go));
  }

  racer(p: RoomPlayer) { return this.racers.find((r) => r.p === p) ?? null; }

  /**
   * A runner's accepted report (the room has already moved it): its place along the
   * course, its speed (`vx`, `vz`) and its clock `tm`. Returns the racer when this
   * report took it over the line.
   */
  report(p: RoomPlayer, vx: number, vz: number, tm: number | undefined, mt: number): Racer | null {
    const r = this.racer(p);
    if (!r) return null;
    r.idx = trackIndex(this.track, p.pos.x, p.pos.y, p.pos.z, r.idx);
    const s = trackS(this.track, r.idx, p.pos.x, p.pos.z);
    const tc = typeof tm === 'number' && isFinite(tm) ? Math.min(mt, Math.max(mt - 0.35, tm)) : mt;
    if (mt >= this.go) r.top = Math.max(r.top, Math.min(RACE.TOP, Math.hypot(vx, vz)));
    let crossed = false;
    const F = this.track.finishS;
    if (!r.time && s >= F && r.s < F && mt >= this.go) {
      const u = s > r.s ? (F - r.s) / (s - r.s) : 1;
      const at = Math.max(this.go, r.lastTm + (tc - r.lastTm) * u);
      r.time = Math.max(0.01, r2(at - this.go));
      r.place = ++this.home;
      if (r.place === 1) this.deadline = mt + RACE.GRACE;
      crossed = true;
    }
    r.s = s;
    r.lastTm = tc;
    return crossed ? r : null;
  }

  /** Where to put a runner that has somehow left the course: the centreline where it last was. */
  recoverPoint(p: RoomPlayer): [number, number, number] {
    const r = this.racer(p);
    const pt = trackPoint(this.track, r ? r.s : 0, { x: 0, y: 0, z: 0, h: 0, w: 0 });
    return [r2(pt.x), r2(pt.y + 0.1), r2(pt.z)];
  }

  /** Over: everyone still in the room is home, or the time after the winner has run out. */
  over(mt: number): boolean {
    const racing = this.racers.filter((r) => r.p.connected && r.p.status !== Status.Left);
    return !racing.length || racing.every((r) => r.time > 0) || mt >= this.deadline;
  }

  /** The race is over: those still running are placed after everyone home, by how far they got. */
  close(mt: number) {
    this.endedAt = mt;
    const out = this.racers.filter((r) => !r.time).sort((a, b) => b.s - a.s);
    out.forEach((r, i) => { r.place = this.home + i + 1; });
  }

  /** Who is home already, for a runner who reconnects: [id, time, place]. */
  done(): [number, number, number][] { return this.racers.filter((r) => r.time > 0).map((r) => [r.p.id, r.time, r.place]); }

  /** A runner's line in the results. */
  row(p: RoomPlayer): MatchResult['race'] {
    const r = this.racer(p);
    if (!r) return undefined;
    const dist = Math.max(0, Math.min(r.s, this.track.finishS) - r.s0);
    const t = r.time || Math.max(0.01, (this.endedAt || this.go) - this.go);
    return { place: r.place, time: r.time || undefined, top: r2(r.top), avg: r2(dist / t), dist: Math.round(dist) };
  }
}

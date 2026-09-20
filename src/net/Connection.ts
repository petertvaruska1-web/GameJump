// Client connection: WebSocket to the game server, or an in-browser server for
// offline solo play (same authoritative code). Includes ping + clock sync.

import { NET } from '../../shared/constants';
import type { LevelData } from '../../shared/level/types';
import type { C2S, S2C } from '../../shared/protocol';
import { RoomManager, Session } from '../../shared/sim/manager';

interface Transport {
  send(m: C2S): void;
  close(): void;
}

const now = () => performance.now() / 1000;

/**
 * Address of the game server, in order of precedence: a `?server=` query
 * override (handy for testing), the VITE_SERVER_URL baked in at build time (for
 * static hosting, where the page and the server live on different hosts), and
 * otherwise `/ws` on whatever host served the page (the Node server and the dev
 * server both answer there).
 */
export function serverUrl(): string {
  const override = new URLSearchParams(location.search).get('server');
  if (override) return override.trim();
  const configured = (import.meta.env.VITE_SERVER_URL ?? '').trim();
  if (configured) return configured;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

export class Connection {
  onMessage?: (m: S2C) => void;
  /** Unexpected disconnect after a successful open. */
  onDrop?: (reason: string) => void;
  rtt = 0;
  private offset = 0;
  private synced = false;
  private samples: { rtt: number; off: number }[] = [];
  private transport: Transport | null = null;
  private local: LocalTransport | null = null;
  private pingTimer = 0;
  private closedByUs = false;
  readonly offline: boolean;

  constructor(opts: { offline?: boolean } = {}) {
    this.offline = !!opts.offline;
  }

  get connected() { return this.transport !== null; }

  /** Estimated current server clock (seconds). Offline play reads the local server clock directly. */
  serverNow() { return this.local ? this.local.clock() : now() + this.offset; }

  /** Offline only: freezes the in-page server (a true pause). */
  setPaused(p: boolean) { this.local?.setPaused(p); }

  connect(level: LevelData, timeoutMs = 6000): Promise<void> {
    this.closedByUs = false;
    if (this.offline) {
      this.local = new LocalTransport(level, (m) => this.receive(m));
      this.transport = this.local;
      this.startPing();
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const url = serverUrl();
      // a page served over https is not allowed to open a plain socket
      if (location.protocol === 'https:' && url.startsWith('ws://')) {
        reject(new Error(`The game server address (${url}) has to start with wss:// on an https page.`));
        return;
      }
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch { reject(new Error(`Could not open a connection to the game server (${url}).`)); return; }
      let opened = false;
      const timer = window.setTimeout(() => { if (!opened) { try { ws.close(); } catch { /* ignore */ } reject(new Error(`The game server at ${url} did not respond.`)); } }, timeoutMs);
      ws.onopen = () => {
        opened = true;
        window.clearTimeout(timer);
        this.transport = {
          send: (m) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); },
          close: () => { try { ws.close(1000); } catch { /* ignore */ } },
        };
        this.startPing();
        resolve();
      };
      ws.onmessage = (e) => {
        let m: S2C;
        try { m = JSON.parse(String(e.data)); } catch { return; }
        this.receive(m);
      };
      ws.onerror = () => { /* close follows */ };
      ws.onclose = (e) => {
        window.clearTimeout(timer);
        const was = this.transport;
        this.transport = null;
        this.stopPing();
        if (!opened) { reject(new Error(`No game server at ${url}.`)); return; }
        if (!this.closedByUs && was) this.onDrop?.(e.code === 4000 ? 'Connected from another tab.' : 'Connection to the server was lost.');
      };
    });
  }

  send(m: C2S) { this.transport?.send(m); }

  close() {
    this.closedByUs = true;
    this.stopPing();
    this.transport?.close();
    this.transport = null;
  }

  /** Seed the clock from a server message that carries its current time. */
  seedClock(serverTime: number) {
    if (!this.synced) { this.offset = serverTime + this.rtt / 2 - now(); this.synced = true; }
  }

  private receive(m: S2C) {
    if (m.t === 'pong') {
      const t = now();
      const rtt = Math.max(0, t - m.c);
      this.rtt = this.rtt === 0 ? rtt : this.rtt * 0.8 + rtt * 0.2;
      this.samples.push({ rtt, off: m.s + rtt / 2 - t });
      if (this.samples.length > 8) this.samples.shift();
      const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
      if (!this.synced || Math.abs(best.off - this.offset) > 0.5) { this.offset = best.off; this.synced = true; }
      else this.offset += (best.off - this.offset) * 0.25;
      return;
    }
    this.onMessage?.(m);
  }

  private startPing() {
    this.stopPing();
    const ping = () => this.send({ t: 'ping', c: now() });
    ping();
    window.setTimeout(ping, 250);
    this.pingTimer = window.setInterval(ping, NET.PING_INTERVAL * 1000);
  }

  private stopPing() {
    if (this.pingTimer) window.clearInterval(this.pingTimer);
    this.pingTimer = 0;
  }
}

/** Runs the authoritative room simulation inside the page for offline solo play. */
class LocalTransport implements Transport {
  private mgr: RoomManager;
  private session: Session;
  private timer: number;
  private pausedAt = -1;
  private pausedTotal = 0;
  readonly clock = () => (this.pausedAt >= 0 ? this.pausedAt : performance.now() / 1000 - this.pausedTotal);

  setPaused(p: boolean) {
    if (p && this.pausedAt < 0) this.pausedAt = this.clock();
    else if (!p && this.pausedAt >= 0) { this.pausedTotal = performance.now() / 1000 - this.pausedAt; this.pausedAt = -1; }
  }

  constructor(level: LevelData, deliver: (m: S2C) => void) {
    const clock = this.clock;
    this.mgr = new RoomManager(level, clock, true);
    this.session = new Session(this.mgr, {
      send: (m) => { const copy = JSON.parse(JSON.stringify(m)) as S2C; queueMicrotask(() => deliver(copy)); },
      close: () => {},
    });
    const tick = 1 / NET.SERVER_TICK_HZ;
    let last = clock(), acc = 0;
    this.timer = window.setInterval(() => {
      const t = clock();
      acc += Math.min(0.25, t - last);
      last = t;
      while (acc >= tick) { acc -= tick; this.mgr.tick(tick); }
    }, 1000 / (NET.SERVER_TICK_HZ * 2));
  }

  send(m: C2S) {
    const copy = JSON.parse(JSON.stringify(m)) as C2S;
    queueMicrotask(() => this.session.onMessage(copy));
  }

  close() {
    this.session.onClose();
    window.clearInterval(this.timer);
  }
}

export type { LocalTransport };

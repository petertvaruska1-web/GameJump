// Room registry + per-connection session routing. Used by the Node server and
// by the in-browser offline transport.

import type { LevelData } from '../level/types';
import { PROTOCOL_VERSION, type C2S } from '../protocol';
import { randomCode, Room, type Conn, type RoomPlayer } from './room';

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  constructor(private readonly level: LevelData, private readonly clock: () => number, private readonly debug: boolean) {}

  create(): Room {
    let code = randomCode();
    let guard = 0;
    while (this.rooms.has(code) && guard++ < 1000) code = randomCode();
    const room = new Room(code, this.level, this.clock, this.debug);
    this.rooms.set(code, room);
    return room;
  }

  now() { return this.clock(); }

  find(code: string): Room | undefined {
    return this.rooms.get(String(code ?? '').trim().toUpperCase());
  }

  tick(dt: number) {
    const now = this.clock();
    for (const [code, room] of this.rooms) {
      room.tick(dt);
      if (room.isStale(now)) this.rooms.delete(code);
    }
  }
}

/** One per client connection. The first message must be create/join/resume. */
export class Session {
  room: Room | null = null;
  player: RoomPlayer | null = null;

  constructor(private readonly mgr: RoomManager, readonly conn: Conn) {}

  onMessage(msg: C2S) {
    if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') return;
    if (this.room && this.player) {
      if (msg.t === 'create' || msg.t === 'join' || msg.t === 'resume') return;
      this.room.handle(this.player, msg);
      if (msg.t === 'leave') { this.room = null; this.player = null; }
      return;
    }
    if (msg.t === 'create' || msg.t === 'join' || msg.t === 'resume') {
      if (msg.v !== PROTOCOL_VERSION) {
        this.conn.send({ t: 'err', code: 'BAD_VERSION', msg: 'Client and server versions differ. Refresh the page.' });
        return;
      }
    }
    if (msg.t === 'create') {
      const room = this.mgr.create();
      const res = room.join(this.conn, msg.name);
      if (typeof res === 'string') { this.conn.send({ t: 'err', code: res, msg: errorText(res) }); return; }
      this.room = room; this.player = res;
    } else if (msg.t === 'join') {
      const room = this.mgr.find(msg.code);
      if (!room) { this.conn.send({ t: 'err', code: 'ROOM_NOT_FOUND', msg: errorText('ROOM_NOT_FOUND') }); return; }
      const res = room.join(this.conn, msg.name);
      if (typeof res === 'string') { this.conn.send({ t: 'err', code: res, msg: errorText(res) }); return; }
      this.room = room; this.player = res;
    } else if (msg.t === 'resume') {
      const room = this.mgr.find(msg.code);
      const res = room ? room.resume(this.conn, msg.token) : 'RESUME_FAILED';
      if (typeof res === 'string' || !room) { this.conn.send({ t: 'err', code: 'RESUME_FAILED', msg: errorText('RESUME_FAILED') }); return; }
      this.room = room; this.player = res;
    } else if (msg.t === 'ping') {
      this.conn.send({ t: 'pong', c: msg.c, s: this.mgr.now() });
    }
  }

  onClose() {
    if (this.room && this.player) this.room.disconnect(this.player);
    this.room = null;
    this.player = null;
  }
}

export function errorText(code: string): string {
  switch (code) {
    case 'ROOM_NOT_FOUND': return 'No game with that code exists. Check the code and try again.';
    case 'ROOM_FULL': return 'That game is full (3 players max).';
    case 'IN_PROGRESS': return 'That game has already started. Wait for it to return to the lobby.';
    case 'RESUME_FAILED': return 'Could not rejoin your previous game.';
    case 'BAD_VERSION': return 'Version mismatch between game and server. Refresh the page.';
    default: return 'Request rejected by the server.';
  }
}

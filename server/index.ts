// Multiplayer server: WebSocket endpoint (/ws) + static hosting of the built
// client in production. Rooms and game logic live in shared/sim.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { NET } from '../shared/constants';
import { getLevel } from '../shared/level/map/index';
import type { C2S, S2C } from '../shared/protocol';
import { RoomManager, Session } from '../shared/sim/manager';

const FROM_SOURCE = import.meta.url.endsWith('.ts');
const PROD = process.env.NODE_ENV === 'production' || !FROM_SOURCE;
// PORT is only honoured for production hosting; in dev the Vite proxy expects GAME_SERVER_PORT/8787.
const PORT = Number((PROD ? process.env.PORT : undefined) ?? process.env.GAME_SERVER_PORT ?? NET.PORT);
const DEBUG = process.env.GAME_DEBUG ? process.env.GAME_DEBUG === '1' : !PROD;
const here = fileURLToPath(new URL('.', import.meta.url));
const STATIC_DIR = resolve(process.env.STATIC_DIR ?? join(here, '..', 'client'));

const t0 = performance.now();
const clock = () => (performance.now() - t0) / 1000;
const level = getLevel();
const manager = new RoomManager(level, clock, DEBUG);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain',
};

function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: manager.rooms.size }));
    return;
  }
  if (!existsSync(STATIC_DIR)) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Skyfall Escape game server is running. In development open the Vite client (http://localhost:5173).');
    return;
  }
  const path = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
  if (path.includes('..')) { res.writeHead(400); res.end(); return; }
  let file = join(STATIC_DIR, path);
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(STATIC_DIR, 'index.html');
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  createReadStream(file).pipe(res);
}

const http = createServer(serveStatic);
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

http.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws: WebSocket) => {
  const conn = {
    send(msg: S2C) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); },
    close() { try { ws.close(4000, 'replaced'); } catch { /* ignore */ } },
  };
  const session = new Session(manager, conn);
  let alive = true;
  ws.on('pong', () => { alive = true; });
  const hb = setInterval(() => {
    if (!alive) { ws.terminate(); return; }
    alive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }, 10000);
  ws.on('message', (data) => {
    let msg: C2S;
    try { msg = JSON.parse(String(data)); } catch { return; }
    try { session.onMessage(msg); } catch (err) { console.error('message error', err); }
  });
  ws.on('close', () => { clearInterval(hb); session.onClose(); });
  ws.on('error', () => { /* close follows */ });
});

// fixed-rate simulation
const TICK = 1 / NET.SERVER_TICK_HZ;
let last = clock();
let acc = 0;
setInterval(() => {
  const now = clock();
  acc += Math.min(0.25, now - last);
  last = now;
  while (acc >= TICK) {
    acc -= TICK;
    manager.tick(TICK);
  }
}, 1000 / (NET.SERVER_TICK_HZ * 2));

http.listen(PORT, () => {
  console.log(`[skyfall] server listening on http://localhost:${PORT}  (ws: /ws, debug=${DEBUG}, static=${existsSync(STATIC_DIR) ? STATIC_DIR : 'none'})`);
});

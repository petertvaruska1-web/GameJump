// Headless multiplayer smoke test against the real server entry point: two
// clients create/join a room, the ready gate holds the start, the match runs,
// a fall is judged by the server, a teleport is corrected, and the match ends.
//
// With no WS set it starts server/index.ts itself on a free port and shuts it
// down again, so it can run as part of `npm test`. Point WS at a running
// server (WS=ws://host/ws) to test that one instead.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import WebSocket from 'ws';
import { NET } from '../shared/constants';
import { getLevel } from '../shared/level/map/index';
import { PROTOCOL_VERSION, Status } from '../shared/protocol';

let fails = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) fails++;
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on('error', rej);
    s.listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
  });
}

async function startServer(): Promise<{ url: string; child: ChildProcess }> {
  const port = await freePort();
  // node directly, not through a shell: on Windows a shell child is cmd.exe and
  // killing it leaves the server running (and its stdout pipe open) afterwards.
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: { ...process.env, GAME_SERVER_PORT: String(port), GAME_DEBUG: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((res, rej) => {
    const to = setTimeout(() => rej(new Error('server did not start in 30s')), 30000);
    child.stdout?.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(to); res(); } });
    child.on('exit', (code) => { clearTimeout(to); rej(new Error(`server exited early (${code})`)); });
  });
  return { url: `ws://localhost:${port}/ws`, child };
}

function client(name: string, url: string) {
  const ws = new WebSocket(url);
  const msgs: any[] = [];
  const waiters: [(m: any) => boolean, (m: any) => void][] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    msgs.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i][0](m)) { waiters[i][1](m); waiters.splice(i, 1); }
  });
  const open = new Promise<void>((res, rej) => {
    const to = setTimeout(() => rej(new Error(`${name} could not connect to ${url}`)), 8000);
    ws.on('open', () => { clearTimeout(to); res(); });
    ws.on('error', (e) => { clearTimeout(to); rej(e); });
  });
  return {
    ws, msgs, open, name,
    send: (m: any) => ws.send(JSON.stringify(m)),
    wait: (pred: (m: any) => boolean, ms = 8000) => new Promise<any>((res, rej) => {
      const hit = msgs.find(pred); if (hit) return res(hit);
      const to = setTimeout(() => rej(new Error(`timeout waiting on ${name}`)), ms);
      waiters.push([pred, (m) => { clearTimeout(to); res(m); }]);
    }),
  };
}

const external = process.env.WS;
const server = external ? null : await startServer();
const URL = external ?? server!.url;
const enemyCount = getLevel().enemies.length;

try {
  const a = client('A', URL), b = client('B', URL);
  await Promise.all([a.open, b.open]);

  a.send({ t: 'create', name: 'Alpha', v: PROTOCOL_VERSION });
  const ja = await a.wait((m) => m.t === 'joined');
  check('creating a room returns a code and the host id', /^[A-Z]+$/.test(ja.code) && ja.code.length === NET.ROOM_CODE_LENGTH && ja.id === 1,
    `code=${ja.code} id=${ja.id}`);

  b.send({ t: 'join', code: 'ZZZZ', name: 'Bad', v: PROTOCOL_VERSION });
  const bad = await b.wait((m) => m.t === 'err');
  check('joining a room that does not exist is refused', bad.code === 'ROOM_NOT_FOUND', `code=${bad.code}`);

  b.send({ t: 'join', code: ja.code.toLowerCase(), name: 'Bravo', v: PROTOCOL_VERSION });
  const jb = await b.wait((m) => m.t === 'joined');
  check('a room code is accepted in lower case', jb.id === 2, `id=${jb.id}`);

  a.send({ t: 'start' });
  await new Promise((r) => setTimeout(r, 300));
  check('the host cannot start before everyone is ready', !a.msgs.some((m) => m.t === 'start'));

  b.send({ t: 'ready', r: true });
  await a.wait((m) => m.t === 'room' && m.players.every((p: any) => p.host || p.ready));
  a.send({ t: 'start' });
  const st = await a.wait((m) => m.t === 'start');
  const lead = st.goAt - st.now;
  check('starting counts everyone in from the same clock',
    Math.abs(lead - NET.COUNTDOWN) < 0.2 && !!st.spawns[ja.id] && !!st.spawns[jb.id],
    `goAt-now=${lead.toFixed(2)} spawns=${Object.keys(st.spawns).length}`);

  await a.wait((m) => m.t === 'room' && m.phase === 'playing', 6000);
  const snap = await a.wait((m) => m.t === 'snap');
  check('snapshots carry both runners and every enemy', snap.p.length === 2 && snap.e.length === enemyCount,
    `players=${snap.p.length} enemies=${snap.e.length} (expected ${enemyCount})`);

  // B walks off the back of the start pad into the void, in plausible steps
  let [x, y, z] = st.spawns[jb.id];
  for (let i = 0; i < 60; i++) {
    z -= 0.25; if (z < -10.5) y -= 0.6 + i * 0.05;
    b.send({ t: 'st', s: i, p: [x, y, z], v: [0, -5, -7], y: 0, a: 4, g: -1 });
    await new Promise((r) => setTimeout(r, 33));
  }
  const ev = await a.wait((m) => m.t === 'ev' && m.e.some((e: any) => e.k === 'death'));
  const death = ev.e.find((e: any) => e.k === 'death');
  check('the server judges a fall itself and tells the other player',
    death.id === jb.id && death.cause === 'fall', JSON.stringify(death));

  // a teleport attempt must be rejected with a position correction
  a.send({ t: 'st', s: 1, p: [0, 64.1, 470], v: [0, 0, 0], y: 0, a: 0, g: -1 });
  const fix = await a.wait((m) => m.t === 'fix');
  const spawnA = st.spawns[ja.id];
  check('a teleporting client is corrected back to where the server had it',
    Math.hypot(fix.p[0] - spawnA[0], fix.p[2] - spawnA[2]) < 2, `fix=${JSON.stringify(fix.p)}`);

  // A also walks off the pad: everyone is out, so the match ends
  let [ax, ay, az] = spawnA;
  for (let i = 0; i < 60; i++) {
    az -= 0.25; if (az < -10.5) ay -= 0.6 + i * 0.05;
    a.send({ t: 'st', s: 10 + i, p: [ax, ay, az], v: [0, -5, -7], y: 0, a: 4, g: -1 });
    await new Promise((r) => setTimeout(r, 33));
  }
  const end = await a.wait((m) => m.t === 'end');
  const both = end.results.length === 2 && end.results.every((r: any) => r.status === Status.Dead && r.cause === 'fall');
  check('the match ends once nobody is left alive', both, JSON.stringify(end.results));

  // the host can put the room straight into another run from the results screen
  a.send({ t: 'start' });
  const again = await a.wait((m) => m.t === 'start' && m !== st, 6000);
  check('the host can start another run from the results screen', again.goAt > st.goAt,
    `goAt ${st.goAt.toFixed(1)} -> ${again.goAt.toFixed(1)}`);

  a.ws.close(); b.ws.close();
} catch (err) {
  check('the run completed', false, (err as Error)?.message || String(err));
} finally {
  server?.child.kill();
}

console.log(fails ? `${fails} check(s) failed` : 'all server checks passed');
process.exit(fails ? 1 : 0);

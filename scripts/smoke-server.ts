// Headless multiplayer smoke test against the real server entry point: two
// clients create/join a room, the ready gate holds the start, the match runs,
// a fall is judged by the server, a teleport is corrected, and the match ends;
// then the beacon opens and both go through to the Warden: powers chosen and
// seen by each other, a power hurting it over the wire, a death that is final
// while a teammate fights on, and the fight lost when both are down; then the
// Warden brought down, its rift, both runners pulled through into Speedster
// Battle, running it, a runner going too fast refused, and the finish in order.
//
// With no WS set it starts server/index.ts itself on a free port and shuts it
// down again, so it can run as part of `npm test`. Point WS at a running
// server (WS=ws://host/ws) to test that one instead.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import WebSocket from 'ws';
import { ARENA, NET, RACE, RIFT } from '../shared/constants';
import { getLevel } from '../shared/level/map/index';
import { getRace, trackIndex, trackPoint, trackS } from '../shared/level/race';
import { BPart, PowAct, PROTOCOL_VERSION, Status } from '../shared/protocol';

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

  // ------------------------------------------------------------------ past the beacon, over the wire
  a.msgs.length = 0; b.msgs.length = 0;
  await a.wait((m) => m.t === 'room' && m.phase === 'playing', 6000);
  const events = (c: typeof a) => c.msgs.filter((m) => m.t === 'ev').flatMap((m) => m.e);
  const waitEv = (c: typeof a, k: string, pred: (e: any) => boolean = () => true, ms = 8000) =>
    c.wait((m) => m.t === 'ev' && m.e.some((e: any) => e.k === k && pred(e)), ms).then((m) => m.e.find((e: any) => e.k === k && pred(e)));
  a.send({ t: 'dbg', cmd: 'gate' });
  const gate = await waitEv(b, 'gate');
  const arena = await waitEv(b, 'arena', () => true, 6000);
  check('the beacon opens for both runners and pulls them into the arena', gate.id === ja.id && !!arena.spawns[ja.id] && !!arena.spawns[jb.id],
    JSON.stringify(arena.spawns));
  a.send({ t: 'pick', k: 2 });
  b.send({ t: 'pick', k: 4 });
  const picks = await Promise.all([waitEv(a, 'pick', (e) => e.id === jb.id), waitEv(b, 'pick', (e) => e.id === ja.id)]);
  check('each runner hears what the other chose', picks[0].power === 4 && picks[1].power === 2);
  await waitEv(a, 'wake', () => true, 6000);
  const bsnap = await a.wait((m) => m.t === 'snap' && !!m.b && m.p.every((p: any) => p[8] > 0));
  check('arena snapshots carry the Warden, its bots, loose things, and every runner\'s power',
    bsnap.b.length === 11 && Array.isArray(bsnap.m) && Array.isArray(bsnap.j) && bsnap.j.length > 0 && bsnap.p.every((p: any) => p[7] === 100),
    `b=${JSON.stringify(bsnap.b)} j=${bsnap.j.length}`);
  // A steps up to the Warden and fires lightning at its core
  const [wx, wz] = bsnap.b;
  const px = wx, pz = wz - 15, py = ARENA.y + 0.1;
  a.send({ t: 'dbg', cmd: 'tp', p: [px, py, pz] });
  await new Promise((r) => setTimeout(r, 150));
  let hit: any = null;
  for (let i = 0; i < 12 && !hit; i++) {
    const core = { x: wx, y: ARENA.y + 9.5, z: wz };
    const dx = core.x - px, dy = core.y - (py + 1.25), dz = core.z - pz, l = Math.hypot(dx, dy, dz);
    a.send({ t: 'st', s: 100 + i, p: [px, py, pz], v: [0, 0, 0], y: 0, a: 0, g: -1, b: 1 });
    a.send({ t: 'pow', a: PowAct.Bolt, o: [px, py, pz], d: [dx / l, dy / l, dz / l], tg: [0, 0, BPart.Core], tm: 0 });
    await new Promise((r) => setTimeout(r, 180));
    hit = events(b).find((e: any) => e.k === 'hit' && e.by === ja.id);
  }
  check('a power used over the wire hurts the Warden, and the other runner sees it', !!hit && hit.hp < bsnap.b[5], JSON.stringify(hit));
  check('the other runner sees the bolt drawn', events(b).some((e: any) => e.k === 'fx' && e.id === ja.id && e.f === PowAct.Bolt));
  // A walks off the Threshold into the storm: down for good, while B fights on
  const sA = arena.spawns[ja.id];
  let [fx2, fy2, fz2] = sA;
  a.send({ t: 'dbg', cmd: 'tp', p: sA });
  for (let i = 0; i < 70; i++) {
    fz2 -= 0.3; if (fz2 < ARENA.z - 57) fy2 -= 0.6 + i * 0.06;
    a.send({ t: 'st', s: 200 + i, p: [fx2, fy2, fz2], v: [0, -5, -7], y: 0, a: 4, g: -1, b: 1 });
    await new Promise((r) => setTimeout(r, 33));
  }
  const fell = await waitEv(b, 'death', (e) => e.id === ja.id);
  check('falling off in the arena is a death the other runner sees', fell.cause === 'fall');
  await new Promise((r) => setTimeout(r, 1500));
  check('going down in the arena is final, but the fight goes on while a teammate stands', !b.msgs.some((m) => m.t === 'end') && !events(b).some((e: any) => e.k === 'respawn'));
  // and when B goes down too, the fight is lost: the run ends, to start over
  const sB = arena.spawns[jb.id];
  let [bx2, by2, bz2] = sB;
  b.send({ t: 'dbg', cmd: 'tp', p: sB });
  for (let i = 0; i < 70; i++) {
    bz2 -= 0.3; if (bz2 < ARENA.z - 57) by2 -= 0.6 + i * 0.06;
    b.send({ t: 'st', s: 300 + i, p: [bx2, by2, bz2], v: [0, -5, -7], y: 0, a: 4, g: -1, b: 1 });
    await new Promise((r) => setTimeout(r, 33));
  }
  const lost = await b.wait((m) => m.t === 'end', 6000);
  check('with the whole team down the fight is lost and the run ends', !lost.boss && typeof lost.fight === 'number', JSON.stringify({ boss: lost.boss, fight: lost.fight }));

  // ------------------------------------------------------------------ past the Warden's rift, over the wire
  a.msgs.length = 0; b.msgs.length = 0;
  a.send({ t: 'start', stage: 'boss' });
  await a.wait((m) => m.t === 'room' && m.phase === 'playing', 8000);
  a.send({ t: 'pick', k: 0 });
  b.send({ t: 'pick', k: 1 });
  await waitEv(a, 'wake', () => true, 8000);
  a.send({ t: 'dbg', cmd: 'rift' });
  const rift = await waitEv(b, 'rift', () => true, (RIFT.OPEN_AFTER + 3) * 1000);
  check('the Warden brought down opens a rift both runners see, with the fight time', !!rift && rift.fight > 0 && !b.msgs.some((m) => m.t === 'end'), JSON.stringify(rift));
  // A walks up to it and in
  const [rx, ry, rz] = rift.p;
  const fy = ry - RIFT.HEIGHT + 0.05;
  a.send({ t: 'dbg', cmd: 'tp', p: [rx, fy, rz - 3] });
  for (let i = 0; i <= 6; i++) { a.send({ t: 'st', s: 400 + i, p: [rx, fy, rz - 3 + i * 0.5], v: [0, 0, 4], y: 0, a: 1, g: -1, b: 1 }); await new Promise((r) => setTimeout(r, 40)); }
  a.send({ t: 'rift' });
  const warp = await waitEv(b, 'warp', () => true, 4000);
  const raced = await Promise.all([waitEv(a, 'race', () => true, 6000), waitEv(b, 'race', () => true, 6000)]);
  check('stepping into the rift pulls both runners onto the race grid', warp.id === ja.id && !!raced[0].spawns[ja.id] && !!raced[1].spawns[jb.id], JSON.stringify(raced[0].spawns));
  // run from "Go!": the course at 60 m/s is fine, a 25 m jump in one report is not
  const RT = getRace().track;
  const pt = { x: 0, y: 0, z: 0, h: 0, w: 0 };
  const sOf = (p: number[]) => trackS(RT, trackIndex(RT, p[0], p[1], p[2], -1), p[0], p[2]);
  const snapNow = await a.wait((m) => m.t === 'snap' && m.ts > 0, 4000);
  await new Promise((r) => setTimeout(r, Math.max(0, (raced[0].go - snapNow.ts) * 1000 + 300)));
  let sa = sOf(raced[0].spawns[ja.id]), sb = sOf(raced[0].spawns[jb.id]);
  const fixes0 = a.msgs.filter((m) => m.t === 'fix').length;
  let seq = 500;
  const step = (c: typeof a, s: number, off: number, speed: number) => {
    trackPoint(RT, s, pt);
    const x = pt.x + Math.cos(pt.h) * off, z = pt.z - Math.sin(pt.h) * off;
    c.send({ t: 'st', s: seq++, p: [x, pt.y + 0.05, z], v: [Math.sin(pt.h) * speed, 0, Math.cos(pt.h) * speed], y: pt.h, a: 1, g: -1, b: 2 });
  };
  for (let i = 0; i < 30; i++) { sa += 2; sb += 1.8; step(a, sa, -2, 60); step(b, sb, 2, 54); await new Promise((r) => setTimeout(r, 33)); }
  check('racing down the course at 60 m/s is accepted', a.msgs.filter((m) => m.t === 'fix').length === fixes0);
  step(a, sa + 25, -2, 60);
  const fixed = await a.wait((m) => m.t === 'fix' && a.msgs.indexOf(m) >= 0, 3000).catch(() => null);
  check('a runner covering 25 m in one report is put back', !!fixed && a.msgs.filter((m) => m.t === 'fix').length > fixes0);
  // both close on the line: A first, B after
  sa = RT.finishS - 40; sb = RT.finishS - 70;
  trackPoint(RT, sa, pt); a.send({ t: 'dbg', cmd: 'tp', p: [pt.x, pt.y + 0.05, pt.z] });
  trackPoint(RT, sb, pt); b.send({ t: 'dbg', cmd: 'tp', p: [pt.x, pt.y + 0.05, pt.z] });
  await new Promise((r) => setTimeout(r, 150));
  for (let i = 0; i < 60; i++) { sa += 2; sb += 2; step(a, sa, 0, 60); step(b, sb, 0, 60); await new Promise((r) => setTimeout(r, 33)); }
  const ends = await Promise.all([a.wait((m) => m.t === 'end', 6000), b.wait((m) => m.t === 'end', 6000)]);
  const row = (id: number) => ends[1].results.find((r: any) => r.id === id)?.race;
  check('crossing the line finishes the race for both, in the order they crossed', !!ends[1].race && row(ja.id)?.place === 1 && row(jb.id)?.place === 2 && row(ja.id).time > 0,
    JSON.stringify(ends[1].results.map((r: any) => r.race)));
  check('the race\'s results carry each runner\'s top speed (never over the top speed)', row(ja.id)?.top > 50 && row(ja.id)?.top <= RACE.TOP);

  a.ws.close(); b.ws.close();
} catch (err) {
  check('the run completed', false, (err as Error)?.message || String(err));
} finally {
  server?.child.kill();
}

console.log(fails ? `${fails} check(s) failed` : 'all server checks passed');
process.exit(fails ? 1 : 0);

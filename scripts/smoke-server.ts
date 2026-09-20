// Headless multiplayer smoke test: two clients create/join, start, move, fall.
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '../shared/protocol';
const URL = process.env.WS ?? 'ws://localhost:8787/ws';
function client(name: string) {
  const ws = new WebSocket(URL);
  const msgs: any[] = [];
  const waiters: [(m: any) => boolean, (m: any) => void][] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    msgs.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i][0](m)) { waiters[i][1](m); waiters.splice(i, 1); }
  });
  const open = new Promise((r) => ws.on('open', r));
  return {
    ws, msgs, open, name,
    send: (m: any) => ws.send(JSON.stringify(m)),
    wait: (pred: (m: any) => boolean, ms = 8000) => new Promise<any>((res, rej) => {
      const hit = msgs.find(pred); if (hit) return res(hit);
      const to = setTimeout(() => rej(new Error('timeout ' + name)), ms);
      waiters.push([pred, (m) => { clearTimeout(to); res(m); }]);
    }),
  };
}
const a = client('A'), b = client('B');
await a.open; await b.open;
a.send({ t: 'create', name: 'Alpha', v: PROTOCOL_VERSION });
const ja = await a.wait((m) => m.t === 'joined');
console.log('A joined', ja.code, 'id', ja.id);
b.send({ t: 'join', code: 'ZZZZ', name: 'Bad', v: PROTOCOL_VERSION });
console.log('B bad code ->', (await b.wait((m) => m.t === 'err')).code);
b.send({ t: 'join', code: ja.code.toLowerCase(), name: 'Bravo', v: PROTOCOL_VERSION });
const jb = await b.wait((m) => m.t === 'joined');
console.log('B joined id', jb.id);
a.send({ t: 'start' });
await new Promise((r) => setTimeout(r, 300));
console.log('start while B not ready ignored:', !a.msgs.some((m) => m.t === 'start'));
b.send({ t: 'ready', r: true });
await a.wait((m) => m.t === 'room' && m.players.every((p: any) => p.host || p.ready));
a.send({ t: 'start' });
const st = await a.wait((m) => m.t === 'start');
console.log('start: goAt-now', (st.goAt - st.now).toFixed(2), 'spawns', JSON.stringify(st.spawns));
await a.wait((m) => m.t === 'room' && m.phase === 'playing', 6000);
const snap = await a.wait((m) => m.t === 'snap');
console.log('snap players', snap.p.length, 'enemies', snap.e.length);
// B walks off the start pad backwards into the void (in plausible steps)
let [x, y, z] = st.spawns[jb.id];
for (let i = 0; i < 60; i++) {
  z -= 0.25; if (z < -10.5) y -= 0.6 + i * 0.05;
  b.send({ t: 'st', s: i, p: [x, y, z], v: [0, -5, -7], y: 0, a: 4, g: -1 });
  await new Promise((r) => setTimeout(r, 33));
}
const ev = await a.wait((m) => m.t === 'ev' && m.e.some((e: any) => e.k === 'death'));
console.log('death event', JSON.stringify(ev.e.find((e: any) => e.k === 'death')));
// a teleport attempt must be rejected with a position correction
a.send({ t: 'st', s: 1, p: [0, 64.1, 470], v: [0, 0, 0], y: 0, a: 0, g: -1 });
const fix = await a.wait((m) => m.t === 'fix');
console.log('teleport rejected, fix ->', JSON.stringify(fix.p));
// A also walks off the pad: everyone is out, so the match ends
let [ax, ay, az] = st.spawns[ja.id];
for (let i = 0; i < 60; i++) {
  az -= 0.25; if (az < -10.5) ay -= 0.6 + i * 0.05;
  a.send({ t: 'st', s: 10 + i, p: [ax, ay, az], v: [0, -5, -7], y: 0, a: 4, g: -1 });
  await new Promise((r) => setTimeout(r, 33));
}
const end = await a.wait((m) => m.t === 'end');
console.log('end', JSON.stringify(end.results));
a.ws.close(); b.ws.close();
process.exit(0);

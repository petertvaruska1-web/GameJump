// Validates the map and renders a top-down SVG overview (dist/map.svg).
// Usage: npm run check:map
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildLevel, levelWarnings } from '../shared/level/map/index';
import { CollisionWorld } from '../shared/physics/world';

const level = buildLevel();
const solids = level.boxes.filter((b) => b.solid);
console.log(`boxes=${level.boxes.length} solid=${solids.length} props=${level.props.length} enemies=${level.enemies.length} winds=${level.winds.length}`);
console.log(`zip lines=${level.ziplines.length} lasers=${level.lasers.length} (gates/bars=${new Set(level.lasers.map((l) => l.group)).size}) belts=${level.boxes.filter((b) => b.belt).length} launch pads=${level.boxes.filter((b) => b.launch).length} hints=${level.hints.length}`);
console.log(`grapple anchors=${level.grapples.length} (optional ${level.grapples.filter((g) => g.optional).length}) crates=${level.pickups.length} (${['shield', 'cloak', 'jet'].map((k) => `${k} ${level.pickups.filter((p) => p.kind === k).length}`).join(', ')})`);
console.log('bounds', JSON.stringify(level.bounds));
for (const w of levelWarnings) console.log('WARN', w);

// Every enemy and waypoint should stand on something.
const world = new CollisionWorld(level);
for (const e of level.enemies) {
  if (e.kind === 'flyer') continue;
  const d = world.groundBelow(e.p[0], e.p[1] + 0.5, e.p[2], 3);
  if (!isFinite(d)) console.log(`WARN enemy ${e.id} (${e.kind}, ${e.tag}) has no ground at ${e.p.join(',')}`);
}
for (const w of [...level.waypoints, ...level.spawns.map((p, i) => ({ name: 'spawn' + i, p }))]) {
  const d = world.groundBelow(w.p[0], w.p[1] + 0.5, w.p[2], 3);
  if (!isFinite(d)) console.log(`WARN waypoint ${w.name} has no ground`);
}

// SVG overview
const [minX, minZ] = level.bounds.min, [maxX, maxZ] = level.bounds.max;
const S = Number(process.env.MAP_SCALE ?? 3);
const W = (maxX - minX) * S, H = (maxZ - minZ) * S;
const tx = (x: number) => (maxX - x) * S; // +X (left) drawn on the left
const tz = (z: number) => (maxZ - z) * S; // forward is up
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="background:#0d1722">`;
const sorted = [...solids].sort((a, b) => a.p[1] + a.s[1] / 2 - (b.p[1] + b.s[1] / 2));
for (const b of sorted) {
  if (b.mat === 'invisible' && !b.rise) continue;
  const top = b.p[1] + b.s[1] / 2;
  const t = Math.max(0, Math.min(1, (top - 30) / 36));
  const col = b.kind === 'crumble' ? '#e0703a' : b.kind === 'mover' ? '#3ad0e0' : b.kind === 'sweeper' ? '#ffd23a'
    : b.belt ? '#8a8f3a' : b.launch ? '#ff8a1a' : `hsl(${220 - t * 180},35%,${28 + t * 45}%)`;
  const deg = (-b.ry * 180) / Math.PI;
  svg += `<rect x="${-b.s[0] * S / 2}" y="${-b.s[2] * S / 2}" width="${b.s[0] * S}" height="${b.s[2] * S}" fill="${col}" stroke="#000" stroke-width="0.4" transform="translate(${tx(b.p[0])},${tz(b.p[2])}) rotate(${deg})"/>`;
}
for (const z of level.ziplines) {
  svg += `<line x1="${tx(z.a[0])}" y1="${tz(z.a[2])}" x2="${tx(z.b[0])}" y2="${tz(z.b[2])}" stroke="#f5f0c8" stroke-width="2" stroke-dasharray="6 3"/>`;
}
for (const l of level.lasers) {
  svg += `<line x1="${tx(l.a[0])}" y1="${tz(l.a[2])}" x2="${tx(l.b[0])}" y2="${tz(l.b[2])}" stroke="#ff2a2a" stroke-width="1.6"/>`;
}
for (const b of level.boxes) if (b.launch) {
  svg += `<line x1="${tx(b.p[0])}" y1="${tz(b.p[2])}" x2="${tx(b.launch.to[0])}" y2="${tz(b.launch.to[2])}" stroke="#ff8a1a" stroke-width="1.5" stroke-dasharray="3 3"/>`;
}
for (const g of level.grapples) {
  svg += `<circle cx="${tx(g.p[0])}" cy="${tz(g.p[2])}" r="4" fill="none" stroke="#c8ff5a" stroke-width="2"/>`;
}
for (const pk of level.pickups) {
  const col = pk.kind === 'shield' ? '#5ef0ff' : pk.kind === 'cloak' ? '#c38bff' : '#ffa640';
  svg += `<rect x="${tx(pk.p[0]) - 4}" y="${tz(pk.p[2]) - 4}" width="8" height="8" fill="${col}" stroke="#fff"/>`;
}
for (const e of level.enemies) {
  const c = e.kind === 'melee' ? '#ff3b3b' : e.kind === 'ranged' ? '#ff9f1a' : '#d04bff';
  svg += `<circle cx="${tx(e.p[0])}" cy="${tz(e.p[2])}" r="5" fill="${c}" stroke="#fff"/>`;
}
for (const w of level.waypoints) {
  svg += `<text x="${tx(w.p[0]) + 6}" y="${tz(w.p[2])}" fill="#fff" font-size="11" font-family="sans-serif">${w.name}</text>`;
}
svg += '</svg>';
mkdirSync('dist', { recursive: true });
writeFileSync('dist/map.svg', svg);
console.log('wrote dist/map.svg', Math.round(W), 'x', Math.round(H));

// Assembles the full map from its sections. The result is plain data and is
// built identically on the server and every client.

import { LevelBuilder } from '../builder';
import type { LevelData } from '../types';
import { buildCenter, buildStart } from './center';
import { buildFinale, buildRing } from './finale';
import { SPIRE, START } from './layout';
import { buildLeft } from './left';
import { buildRight } from './right';
import { buildUpperWorks } from './upper';

export function buildLevel(): LevelData {
  const b = new LevelBuilder();
  buildStart(b);
  buildCenter(b);
  buildLeft(b);
  buildRight(b);
  buildRing(b);
  buildUpperWorks(b);
  buildFinale(b);
  const sy = START.y + 0.05;
  const level = b.build({
    name: 'The Spire Run',
    spawns: [[-2.6, sy, -5], [0, sy, -5.6], [2.6, sy, -5]],
    spawnYaw: 0,
    finish: { min: [SPIRE.x - 4, SPIRE.y - 0.5, SPIRE.z - 4], max: [SPIRE.x + 4, SPIRE.y + 5, SPIRE.z + 4] },
    beacon: [SPIRE.x, SPIRE.y, SPIRE.z],
    killY: -40,
  });
  levelWarnings = b.warnings;
  levelChains = b.chainPoints;
  return level;
}

export let levelWarnings: string[] = [];
export let levelChains = new Map<string, import('../builder').RoutePoint[]>();

let cached: LevelData | null = null;
export function getLevel(): LevelData {
  if (!cached) cached = buildLevel();
  return cached;
}

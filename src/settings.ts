// Player preferences persisted in localStorage (best effort).

import type { Quality } from './render/Renderer';

export interface Settings {
  name: string;
  sensitivity: number;
  invertY: boolean;
  fov: number;
  volume: number;
  music: number;
  quality: Quality;
  showFps: boolean;
  cameraShake: boolean;
}

const KEY = 'skyfall.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  name: '',
  sensitivity: 1,
  invertY: false,
  fov: 74,
  volume: 0.8,
  music: 0.6,
  quality: 'medium',
  showFps: false,
  cameraShake: true,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { /* storage unavailable */ }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

/** The furthest this browser's runner has got, and its fastest escape. */
export interface PersonalBest {
  /** 0..1 along the course (start line to the Spire). */
  progress: number;
  /** Named area where that run ended. */
  area: string;
  /** Fastest escape in seconds, if there has been one. */
  time?: number;
}

const BEST_KEY = 'skyfall.best.v1';

export function loadBest(): PersonalBest | null {
  try {
    const raw = localStorage.getItem(BEST_KEY);
    if (!raw) return null;
    const b = JSON.parse(raw) as PersonalBest;
    return typeof b.progress === 'number' ? b : null;
  } catch { return null; }
}

/**
 * Folds one finished run into the stored best. Returns the previous best and
 * which records this run broke, so the results screen can say so.
 */
export function recordRun(progress: number, area: string, time: number | null): { prev: PersonalBest | null; further: boolean; faster: boolean } {
  const prev = loadBest();
  const further = !prev || progress > prev.progress + 0.005;
  const faster = time !== null && (prev?.time === undefined || time < prev.time);
  const next: PersonalBest = {
    progress: further ? progress : prev!.progress,
    area: further ? area : prev!.area,
    time: faster ? time! : prev?.time,
  };
  try { localStorage.setItem(BEST_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  return { prev, further, faster };
}

export function loadSession(): { code: string; token: string } | null {
  try {
    const raw = sessionStorage.getItem('skyfall.session');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function saveSession(s: { code: string; token: string } | null) {
  try {
    if (s) sessionStorage.setItem('skyfall.session', JSON.stringify(s));
    else sessionStorage.removeItem('skyfall.session');
  } catch { /* ignore */ }
}

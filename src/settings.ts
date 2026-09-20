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

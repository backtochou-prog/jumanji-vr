/**
 * Comfort settings: the knobs that matter for VR sickness. Persisted per
 * browser (localStorage) and overridable from the URL for quick experiments:
 *   ?turn=snap|smooth  ?snap=30|45|60  ?speed=2.5  ?vignette=0..1
 * Defaults are deliberately conservative for first-time Quest 2 users.
 */
export interface ComfortSettings {
  turnMode: 'snap' | 'smooth';
  /** Degrees per snap turn. */
  snapAngle: number;
  /** Smooth-turn speed, degrees per second. */
  smoothSpeed: number;
  /** Walking speed in m/s. */
  walkSpeed: number;
  /** Tunnel-vignette strength while moving, 0 (off) .. 1 (strong). */
  vignette: number;
}

export const DEFAULT_COMFORT: Readonly<ComfortSettings> = {
  turnMode: 'snap',
  snapAngle: 30,
  smoothSpeed: 90,
  walkSpeed: 2.5,
  vignette: 0.5,
};

export const SNAP_ANGLES = [30, 45, 60] as const;
export const WALK_SPEEDS = [1.8, 2.5, 3.5] as const;
export const VIGNETTE_LEVELS = [0, 0.5, 0.85] as const;

const KEY = 'jumanji-vr.comfort.v1';

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function sanitize(raw: Partial<ComfortSettings>): ComfortSettings {
  const d = DEFAULT_COMFORT;
  return {
    turnMode: raw.turnMode === 'smooth' ? 'smooth' : 'snap',
    snapAngle: clamp(Number(raw.snapAngle ?? d.snapAngle), 10, 90),
    smoothSpeed: clamp(Number(raw.smoothSpeed ?? d.smoothSpeed), 30, 240),
    walkSpeed: clamp(Number(raw.walkSpeed ?? d.walkSpeed), 0.8, 6),
    vignette: clamp(Number(raw.vignette ?? d.vignette), 0, 1),
  };
}

export function loadComfort(): ComfortSettings {
  let stored: Partial<ComfortSettings> = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<ComfortSettings>;
  } catch {
    /* storage unavailable or corrupt: fall back to defaults */
  }
  const q = new URLSearchParams(globalThis.location?.search ?? '');
  const o: Partial<ComfortSettings> = { ...stored };
  if (q.has('turn')) o.turnMode = q.get('turn') === 'smooth' ? 'smooth' : 'snap';
  if (q.has('snap')) o.snapAngle = Number(q.get('snap'));
  if (q.has('speed')) o.walkSpeed = Number(q.get('speed'));
  if (q.has('vignette')) o.vignette = Number(q.get('vignette'));
  return sanitize(o);
}

export function saveComfort(s: ComfortSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode etc.: settings just won't persist */
  }
}

/** Next value in a cyclic list (nearest current entry, then advance). */
export function cycle<T extends number>(list: readonly T[], current: number): T {
  let idx = 0;
  let best = Infinity;
  list.forEach((v, i) => {
    const d = Math.abs(v - current);
    if (d < best) {
      best = d;
      idx = i;
    }
  });
  return list[(idx + 1) % list.length];
}

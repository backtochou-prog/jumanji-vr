/**
 * Pure math shared by the whole world model: deterministic PRNG, value noise, splines, polyline queries.
 * No Three.js, DOM or SDK imports (runs in both SDK realms and in Node tools). layout.ts re-exports the
 * noise helpers so older imports keep working.
 */
export type Vec2 = readonly [number, number];

/** Small deterministic PRNG (mulberry32). */
export function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(ix: number, iz: number, seed: number): number {
  let h = (ix * 374761393 + iz * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in [0,1]. */
export function valueNoise(x: number, z: number, seed = 1): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm(x: number, z: number, seed = 1, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * freq, z * freq, seed + i * 17) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

export const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));


export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function catmull(p0: number, p1: number, p2: number, p3: number, t: number) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

export function sampleSpline(pts: Vec2[], steps: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      out.push([catmull(p0[0], p1[0], p2[0], p3[0], t), catmull(p0[1], p1[1], p2[1], p3[1], t)]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

export function nearestOnPolyline(pts: Vec2[], x: number, z: number): { dist: number; index: number } {
  let best = Infinity;
  let bi = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz || 1;
    let u = ((x - ax) * dx + (z - az) * dz) / l2;
    u = Math.min(1, Math.max(0, u));
    const d = Math.hypot(x - (ax + dx * u), z - (az + dz * u));
    if (d < best) {
      best = d;
      bi = i + u;
    }
  }
  return { dist: best, index: bi };
}


/**
 * Uniform-grid accelerated nearest-point query over a polyline (hot loops: terrain tiles, placements).
 * `reach` is the largest distance that matters; beyond it `query` returns dist = Infinity.
 */
export class PolyIndex {
  readonly pts: readonly Vec2[];
  private readonly cell: number;
  private readonly cells = new Map<number, number[]>();
  constructor(pts: readonly Vec2[], cell = 8, reach = 40) {
    this.pts = pts;
    this.cell = cell;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i];
      const [bx, bz] = pts[i + 1];
      const x0 = Math.floor((Math.min(ax, bx) - reach) / cell);
      const x1 = Math.floor((Math.max(ax, bx) + reach) / cell);
      const z0 = Math.floor((Math.min(az, bz) - reach) / cell);
      const z1 = Math.floor((Math.max(az, bz) + reach) / cell);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const k = cx * 65536 + cz;
          let l = this.cells.get(k);
          if (!l) this.cells.set(k, (l = []));
          l.push(i);
        }
      }
    }
  }

  /** Nearest point: distance, fractional segment index, signed side (+1 left of travel direction when seen from above, -1 right). */
  query(x: number, z: number): { dist: number; index: number; side: number } {
    const l = this.cells.get(Math.floor(x / this.cell) * 65536 + Math.floor(z / this.cell));
    let best = Infinity;
    let bi = 0;
    let side = 1;
    if (!l) return { dist: Infinity, index: 0, side };
    for (const i of l) {
      const [ax, az] = this.pts[i];
      const [bx, bz] = this.pts[i + 1];
      const dx = bx - ax;
      const dz = bz - az;
      const l2 = dx * dx + dz * dz || 1;
      const u = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l2));
      const d = Math.hypot(x - (ax + dx * u), z - (az + dz * u));
      if (d < best) {
        best = d;
        bi = i + u;
        side = dx * (z - az) - dz * (x - ax) > 0 ? 1 : -1;
      }
    }
    return { dist: best, index: bi, side };
  }
}

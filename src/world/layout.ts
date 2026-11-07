/**
 * Pure world-layout math for the Jungle (Prompt 02 layout).
 *
 * No Three.js, no DOM, no SDK imports: shared by
 *   - the procedural terrain / collider / water assets (runtime + editor realms),
 *   - runtime systems (relic settling uses terrainHeight),
 *   - tools/generate-scene.mjs and tools/validate-scene.mjs (Node).
 * Deterministic everywhere.
 *
 * Coordinates: metres, +Y up, the player starts at SPAWN looking down -Z.
 * The journey runs north (-Z):
 *   JUNGLE ENTRANCE  (z +14 .. -9)   dense, cool, mysterious; colossal gate trees
 *   FOREST TRAIL     (z  -9 .. -47)  winding, layered; pool, ford, root arch, fallen giant
 *   ANCIENT CLEARING (z -47 .. -75)  open, warm; overgrown temple, altar, the Heartstone
 */

export type Vec2 = readonly [number, number];

// ---------------------------------------------------------------------------
// Noise and helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Key places (authored; change here, then `npm run scene:generate`)
// ---------------------------------------------------------------------------

export const SPAWN: Vec2 = [0.6, 11.5];

/** Terrain tile area (metres). Tiles are generated inside this rectangle. */
export const TERRAIN = { x0: -70, x1: 70, z0: -112, z1: 35 } as const;

/** Winding dirt trail, from the spawn threshold north into the ancient clearing. */
export const PATH_POINTS: Vec2[] = [
  [0.6, 17],
  [0.6, 11.5],
  [0.3, 6],
  [-0.4, 0.5],
  [0.0, -4],
  [-0.9, -9],
  [-2.6, -14],
  [-3.0, -18.5],
  [-1.2, -23],
  [1.4, -27.5],
  [4.2, -31.5],
  [4.6, -36.5],
  [2.6, -41],
  [-0.4, -45],
  [-1.8, -49.5],
  [-1.0, -54.5],
  [0.0, -59],
];

/** Ruined altar that carries the Heartstone (the grabbable relic). */
export const ALTAR: Vec2 = [0.0, -61.5];
export const ALTAR_TOP_Y = 0.94;

/** Ancient clearing: open ground around the overgrown temple. */
export const CLEARING = { x: 0, z: -63, r: 12 } as const;

/** Overgrown temple structure, built in ruins/temple assets (origin on the ground). */
export const TEMPLE = { x: 0, z: -69.5, width: 15, depth: 9 } as const;

/** Tall ruined spire: destination landmark visible above the canopy. */
export const SPIRE = { x: -9.5, z: -67, h: 24 } as const;

/** Jungle entrance: two colossal trees either side of the trail. */
export const ENTRANCE_TREES: Vec2[] = [
  [-6.2, -2.4],
  [6.6, -4.0],
];

/** Pool (water feature) left of the trail, with a cascade at its north-west rim. */
/** `waterY` is derived from the stream's water profile below (the pool is the stream's upper reach). */
export const POOL = { x: -9.2, z: -21.6, r: 3.1, waterY: 0, depth: 0.5 };

/** The stream: cascade foot -> pool -> ford across the trail -> away east. */
export const STREAM_POINTS: Vec2[] = [
  [-12.8, -25.6],
  [-9.2, -21.6],
  [-5.6, -21.7],
  [-3.2, -22.5],
  [-1.2, -22.9], // ford: the trail crosses here
  [1.6, -22.3],
  [5.0, -23.8],
  [9.5, -23.4],
  [14, -25.6],
  [20, -24.6],
  [28, -27],
];
export const FORD = { x: -1.2, z: -22.9 } as const;

/** Landmark: giant root arch over the trail, and a fallen giant beside it. */
export const ROOT_ARCH = { x: 4.5, z: -34.0, yaw: 0.1 } as const;
export const FALLEN_GIANT = { x: -6.6, z: -31.5, yaw: 1.28, length: 11 } as const;

/** Occasional muddy hollows on the trail (x, z, radius). */
export const MUD_PATCHES: { x: number; z: number; r: number }[] = [
  { x: -3.0, z: -16, r: 1.9 },
  { x: 3.4, z: -29.5, r: 1.7 },
  { x: -0.7, z: -46, r: 1.8 },
];

/** Distant cliff with the waterfall: the backdrop of the ancient clearing. */
export const CLIFF = { x: 5, z: -96 } as const;

/** Walkable ellipse (centre + radii). An invisible wall closes it; dense jungle hides it. */
export const WALK_LIMIT = { cx: 0, cz: -33, rx: 27, rz: 52 };

/** Ruined pillars of the ancient clearing (height m, broken = snapped top). */
export const PILLARS: { x: number; z: number; h: number; broken: boolean; seed: number }[] = [
  { x: -5.2, z: -58.6, h: 3.8, broken: false, seed: 3 },
  { x: 5.4, z: -58.2, h: 2.2, broken: true, seed: 4 },
  { x: -7.4, z: -64.4, h: 2.6, broken: true, seed: 5 },
];

/** View corridors kept free of tall trees: [from, to, half-width]. */
export const CORRIDORS: { a: Vec2; b: Vec2; w: number }[] = [
  { a: [0, -50], b: [CLIFF.x, CLIFF.z + 6], w: 5.5 }, // clearing -> waterfall
  { a: [-1, -44], b: [SPIRE.x, SPIRE.z], w: 4.2 }, // trail end -> spire
];

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

export type AreaId = 'entrance' | 'trail' | 'clearing';

/** Which of the three areas a point belongs to (soft transitions are in `areaWeights`). */
export function areaAt(x: number, z: number): AreaId {
  if (Math.hypot(x - CLEARING.x, z - CLEARING.z) < CLEARING.r + 2) return 'clearing';
  if (z > -9) return 'entrance';
  return 'trail';
}

/** Blend weights (sum to ~1) used by density, colour grading and species choice. */
export function areaWeights(x: number, z: number): { entrance: number; trail: number; clearing: number } {
  const entrance = 1 - smoothstep(-13, -4, z);
  const clearing = 1 - smoothstep(CLEARING.r - 1, CLEARING.r + 9, Math.hypot(x - CLEARING.x, z - CLEARING.z));
  const trail = Math.max(0, 1 - entrance - clearing);
  return { entrance, trail, clearing };
}

// ---------------------------------------------------------------------------
// Path and stream geometry
// ---------------------------------------------------------------------------

function catmull(p0: number, p1: number, p2: number, p3: number, t: number) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function sampleSpline(pts: Vec2[], steps: number): Vec2[] {
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

/** Dense polyline sampled from PATH_POINTS (Catmull-Rom). */
export const PATH_SAMPLES: Vec2[] = sampleSpline(PATH_POINTS, 12);
export const STREAM_SAMPLES: Vec2[] = sampleSpline(STREAM_POINTS, 8);

/** Path half-width at a sample index (m): wider at the threshold and in the clearing, narrower in the jungle. */
export function pathHalfWidth(index: number): number {
  const t = index / (PATH_SAMPLES.length - 1);
  const wide = 0.32 * (1 - smoothstep(0.0, 0.12, t)) + 0.5 * smoothstep(0.86, 1.0, t);
  return 0.95 + 0.13 * Math.sin(index * 0.21 + 1.3) + wide;
}

function nearestOnPolyline(pts: Vec2[], x: number, z: number): { dist: number; index: number } {
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

/** Exact distance to the trail (slow: ~200 segments). Use `distanceToPath` in hot loops. */
export function distanceToPathExact(x: number, z: number): { dist: number; halfWidth: number; t: number } {
  const n = nearestOnPolyline(PATH_SAMPLES, x, z);
  return { dist: n.dist, halfWidth: pathHalfWidth(Math.round(n.index)), t: n.index / (PATH_SAMPLES.length - 1) };
}

/** Exact distance to the stream centre-line. */
export function distanceToStream(x: number, z: number): number {
  if (x < -18 || x > 33 || z > -17 || z < -33) return 99; // outside the stream's bounding box (+margin)
  return nearestOnPolyline(STREAM_SAMPLES, x, z).dist;
}

/** Nearest stream sample (fractional index) within the stream bounding box, else dist 99. */
export function nearestStream(x: number, z: number): { dist: number; index: number } {
  if (x < -18 || x > 33 || z > -17 || z < -33) return { dist: 99, index: 0 };
  return nearestOnPolyline(STREAM_SAMPLES, x, z);
}

// Precomputed 1 m field for fast lookups (built lazily, identical in every realm).
const FIELD_CELL = 2;
const FIELD = { x0: TERRAIN.x0, z0: TERRAIN.z0, cell: FIELD_CELL, nx: Math.ceil((TERRAIN.x1 - TERRAIN.x0) / FIELD_CELL) + 1, nz: Math.ceil((TERRAIN.z1 - TERRAIN.z0) / FIELD_CELL) + 1 };
let fieldDist: Float32Array | null = null;
let fieldT: Float32Array | null = null;
let fieldHW: Float32Array | null = null;

function buildField(): void {
  fieldDist = new Float32Array(FIELD.nx * FIELD.nz);
  fieldT = new Float32Array(FIELD.nx * FIELD.nz);
  fieldHW = new Float32Array(FIELD.nx * FIELD.nz);
  for (let j = 0; j < FIELD.nz; j++) {
    for (let i = 0; i < FIELD.nx; i++) {
      const r = distanceToPathExact(FIELD.x0 + i * FIELD.cell, FIELD.z0 + j * FIELD.cell);
      const k = j * FIELD.nx + i;
      fieldDist[k] = r.dist;
      fieldT[k] = r.t;
      fieldHW[k] = r.halfWidth;
    }
  }
}

/** Fast (bilinear on a 2 m grid, ~0.2 m accuracy near the trail edge) distance to the trail, with the local half-width and path parameter. */
export function distanceToPath(x: number, z: number): { dist: number; halfWidth: number; t: number } {
  const fx = (x - FIELD.x0) / FIELD.cell;
  const fz = (z - FIELD.z0) / FIELD.cell;
  if (fx < 0 || fz < 0 || fx >= FIELD.nx - 1 || fz >= FIELD.nz - 1) return distanceToPathExact(x, z);
  if (!fieldDist) buildField();
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const u = fx - i;
  const v = fz - j;
  const k = j * FIELD.nx + i;
  const d = fieldDist!;
  const dist = d[k] * (1 - u) * (1 - v) + d[k + 1] * u * (1 - v) + d[k + FIELD.nx] * (1 - u) * v + d[k + FIELD.nx + 1] * u * v;
  if (dist < 3.5) return distanceToPathExact(x, z); // exact near the trail, where it matters
  const near = (u > 0.5 ? 1 : 0) + (v > 0.5 ? FIELD.nx : 0);
  return { dist, halfWidth: fieldHW![k + near], t: fieldT![k + near] };
}

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

function macroRelief(x: number, z: number): number {
  return (fbm(x * 0.034, z * 0.034, 3, 3) - 0.5) * 2.6;
}

/** Ground height before the trail, stream and pool are graded in. */
function baseHeight(x: number, z: number): number {
  let h = macroRelief(x, z);
  h += (fbm(x * 0.16, z * 0.16, 9, 2) - 0.5) * 0.36;
  h += (fbm(x * 0.55, z * 0.55, 13, 2) - 0.5) * 0.1;
  // Gentle, readable ground at the arrival point and in the clearing.
  const dSpawn = Math.hypot(x - SPAWN[0], z - SPAWN[1]);
  h *= 0.3 + 0.7 * smoothstep(3, 14, dSpawn);
  const dClear = Math.hypot(x - CLEARING.x, z - CLEARING.z);
  h *= 0.25 + 0.75 * smoothstep(7, CLEARING.r + 4, dClear);
  return h;
}

/** Smoothed height profile along the trail (so the trail itself never lurches). */
const PATH_HEIGHT: Float32Array = (() => {
  const n = PATH_SAMPLES.length;
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) raw[i] = baseHeight(PATH_SAMPLES[i][0], PATH_SAMPLES[i][1]);
  const out = new Float32Array(n);
  const w = 14;
  for (let i = 0; i < n; i++) {
    let s = 0;
    let c = 0;
    for (let k = -w; k <= w; k++) {
      const j = Math.min(n - 1, Math.max(0, i + k));
      s += raw[j];
      c++;
    }
    out[i] = s / c;
  }
  return out;
})();

function pathHeightAt(t: number): number {
  const f = clamp01(t) * (PATH_HEIGHT.length - 1);
  const i = Math.min(PATH_HEIGHT.length - 2, Math.floor(f));
  const u = f - i;
  return PATH_HEIGHT[i] * (1 - u) + PATH_HEIGHT[i + 1] * u;
}

// ---------------------------------------------------------------------------
// Stream water profile: monotone downhill from the pool, level with the trail at the ford.
// ---------------------------------------------------------------------------

const STREAM_ARC: Float32Array = (() => {
  const a = new Float32Array(STREAM_SAMPLES.length);
  for (let i = 1; i < a.length; i++) a[i] = a[i - 1] + Math.hypot(STREAM_SAMPLES[i][0] - STREAM_SAMPLES[i - 1][0], STREAM_SAMPLES[i][1] - STREAM_SAMPLES[i - 1][1]);
  return a;
})();
const FORD_INDEX = (() => nearestOnPolyline(STREAM_SAMPLES, FORD.x, FORD.z).index)();
const FORD_H = pathHeightAt(distanceToPathExact(FORD.x, FORD.z).t);
const STREAM_FALL = 0.022; // m of drop per m of stream

function streamArcAt(index: number): number {
  const i = Math.min(STREAM_ARC.length - 2, Math.max(0, Math.floor(index)));
  return STREAM_ARC[i] + (STREAM_ARC[i + 1] - STREAM_ARC[i]) * (index - i);
}

/** Water surface height at a (fractional) stream sample index: shallow ford, falls gently downstream. */
export function streamWaterY(index: number): number {
  return FORD_H - 0.1 - STREAM_FALL * (streamArcAt(index) - streamArcAt(FORD_INDEX));
}

// The pool is the stream's upper reach: its level is the stream level at the outlet.
POOL.waterY = (() => {
  for (let i = 0; i < STREAM_SAMPLES.length; i++) {
    if (Math.hypot(STREAM_SAMPLES[i][0] - POOL.x, STREAM_SAMPLES[i][1] - POOL.z) > POOL.r * 1.15) return streamWaterY(i);
  }
  return streamWaterY(0);
})();

/**
 * Terrain height. Walkable relief stays gentle (slopes <~ 12 deg) so locomotion
 * is comfortable; relief grows into jungle-wall hills beyond the walkable
 * ellipse, where vegetation hides it. Order: macro relief -> trail grading ->
 * stream channel -> pool basin -> mud hollows -> outer hills.
 */
export function terrainHeight(x: number, z: number): number {
  let h = baseHeight(x, z);

  // Trail: blend toward a smoothed profile, slightly sunken like a worn path.
  const p = distanceToPath(x, z);
  const along = 1 - smoothstep(p.halfWidth * 0.9, p.halfWidth * 3.4, p.dist);
  const profile = pathHeightAt(p.t) - 0.045 * (1 - smoothstep(0, p.halfWidth, p.dist));
  h = h * (1 - along) + profile * along;

  // Stream: grade the ground to the stream's own downhill profile, with a shallow bed and mossy banks.
  const sn = nearestStream(x, z);
  if (sn.dist < 6) {
    const bed = streamWaterY(sn.index) - 0.11;
    const target = bed + 0.3 * smoothstep(0.05, 2.0, sn.dist) + 0.05 * Math.exp(-Math.pow((sn.dist - 2.6) / 0.7, 2));
    const w = 1 - smoothstep(1.6, 6.0, sn.dist);
    h = h * (1 - w) + target * w;
  }

  // Pool basin + raised lip.
  const dp = Math.hypot(x - POOL.x, z - POOL.z);
  if (dp < POOL.r * 2) {
    const basin = 1 - smoothstep(POOL.r * 0.55, POOL.r * 1.3, dp);
    h = h * (1 - basin) + (POOL.waterY - POOL.depth) * basin;
    h += Math.exp(-Math.pow((dp - POOL.r * 1.3) / 0.7, 2)) * 0.1;
  }

  // Muddy hollows.
  for (const m of MUD_PATCHES) {
    const dm = Math.hypot(x - m.x, z - m.z);
    if (dm < m.r * 1.4) h -= 0.05 * (1 - smoothstep(0, m.r * 1.4, dm));
  }

  // Jungle-wall hills beyond the walkable ellipse.
  const ring = Math.hypot((x - WALK_LIMIT.cx) / WALK_LIMIT.rx, (z - WALK_LIMIT.cz) / WALK_LIMIT.rz);
  h += smoothstep(0.98, 1.7, ring) * 6.5 * (0.55 + fbm(x * 0.06, z * 0.06, 5, 2));
  return h;
}

/** Terrain slope magnitude (rise/run) by central differences, for validation and splat rules. */
export function terrainSlope(x: number, z: number, e = 0.6): number {
  const dx = (terrainHeight(x + e, z) - terrainHeight(x - e, z)) / (2 * e);
  const dz = (terrainHeight(x, z + e) - terrainHeight(x, z - e)) / (2 * e);
  return Math.hypot(dx, dz);
}

// ---------------------------------------------------------------------------
// Fields used by colour, density and light
// ---------------------------------------------------------------------------

export function inClearing(x: number, z: number): boolean {
  return Math.hypot(x - CLEARING.x, z - CLEARING.z) < CLEARING.r;
}

/** Wetness 0..1: stream banks, pool rim and mud hollows (darker, mossier ground). */
export function wetness(x: number, z: number): number {
  let w = 1 - smoothstep(0.8, 4.2, distanceToStream(x, z));
  w = Math.max(w, 1 - smoothstep(POOL.r * 0.9, POOL.r * 2.1, Math.hypot(x - POOL.x, z - POOL.z)));
  for (const m of MUD_PATCHES) w = Math.max(w, 1 - smoothstep(m.r * 0.5, m.r * 1.5, Math.hypot(x - m.x, z - m.z)));
  return w;
}

/** How open the sky is at this spot (0 dense canopy .. 1 open): drives ground light/colour. */
export function canopyOpenness(x: number, z: number): number {
  const a = areaWeights(x, z);
  const p = distanceToPath(x, z);
  const nearTrail = 1 - smoothstep(0.5, 5, p.dist);
  return clamp01(a.clearing * 0.95 + a.trail * (0.2 + 0.2 * nearTrail) + a.entrance * 0.08);
}

/**
 * Vegetation density 0..~1.4: none on the trail and in the water, a clean
 * fringe at the trail edge, lush along water, thick wall at the entrance,
 * thinning to open meadow in the clearing.
 */
export function vegetationDensity(x: number, z: number): number {
  const p = distanceToPath(x, z);
  const onPath = 1 - smoothstep(p.halfWidth + 0.15, p.halfWidth + 2.2, p.dist);
  let d = 1 - onPath;
  const a = areaWeights(x, z);
  d *= a.entrance * 1.15 + a.trail * 1.0 + a.clearing * 0.3;
  const ds = distanceToStream(x, z);
  d *= 1 - (1 - smoothstep(0.2, 1.2, ds)) * 0.8; // thin right at the waterline
  d *= 1 + 0.25 * (1 - smoothstep(1.5, 5, ds));
  if (Math.hypot(x - POOL.x, z - POOL.z) < POOL.r * 1.02) d = 0;
  return d * (0.62 + 0.76 * fbm(x * 0.11, z * 0.11, 21, 3));
}

/** Soil/moss/stone mix used for the terrain splat and for placing ground cover. */
export function groundBlend(x: number, z: number, slopeIn?: number): { grass: number; moss: number; litter: number; soil: number; stone: number; mud: number } {
  const open = canopyOpenness(x, z);
  const n1 = fbm(x * 0.3, z * 0.3, 4, 3);
  const n2 = fbm(x * 1.2, z * 1.2, 8, 2);
  const wet = wetness(x, z);
  const slope = slopeIn ?? terrainSlope(x, z);
  const stone = smoothstep(0.22, 0.4, slope) * 0.8 + smoothstep(0.72, 0.9, n2) * 0.15 * (1 - open);
  const grass = open * smoothstep(0.3, 0.7, n1) * (1 - wet * 0.6);
  const moss = (1 - open * 0.6) * (0.45 + 0.5 * smoothstep(0.3, 0.7, n1)) * (0.55 + wet * 0.5);
  const litter = (1 - open) * smoothstep(0.3, 0.8, n2) * 0.9;
  const mud = wet * smoothstep(0.35, 0.8, fbm(x * 0.7, z * 0.7, 17, 2));
  return { grass, moss, litter, soil: 0.25 + 0.2 * n2, stone: clamp01(stone), mud: clamp01(mud) };
}

// ---------------------------------------------------------------------------
// Culling cells and distance LOD (vegetation is static-batched per cell and class)
// ---------------------------------------------------------------------------

/** Side of a square culling cell (m). One merged mesh per cell per class. */
export const CHUNK = 28;
export const chunkIndex = (x: number, z: number): [number, number] => [Math.floor((x - TERRAIN.x0) / CHUNK), Math.floor((z - TERRAIN.z0) / CHUNK)];

/**
 * Distance rules (metres from the player to the nearest point of a cell) for each chunk class.
 * `max`: hidden when farther; `min`: hidden when nearer (the cheap far version).
 * Shared by the runtime ChunkLodSystem and tools/asset-stats.mjs so the budget estimate matches.
 */
export const CHUNK_LOD = {
  'trees-hi': { min: 0, max: 42 },
  'trees-lo': { min: 28, max: 1e9 },
  'trees-far': { min: 0, max: 1e9 },
  plants: { min: 0, max: 50 },
  ground: { min: 0, max: 34 },
  rocks: { min: 0, max: 62 },
  deadwood: { min: 0, max: 48 },
} as const;
export type ChunkClass = keyof typeof CHUNK_LOD;

/** Distance from (x, z) to the nearest point of cell (ix, iz). */
export function cellDistance(x: number, z: number, ix: number, iz: number): number {
  const x0 = TERRAIN.x0 + ix * CHUNK;
  const z0 = TERRAIN.z0 + iz * CHUNK;
  const dx = Math.max(x0 - x, 0, x - (x0 + CHUNK));
  const dz = Math.max(z0 - z, 0, z - (z0 + CHUNK));
  return Math.hypot(dx, dz);
}

/**
 * Extra cut-offs of the 'low' tier. Measured (tools/perf-probe.mjs): scaling every distance by 0.72
 * removed triangles and the additive layers but only ~7 % of the foliage overdraw, because the far tree
 * wall (always drawn) and the near crowns dominate it. 'low' therefore also drops the far wall beyond
 * 60 m, the ground-cover patches beyond 20 m, and hands detailed trees over to the cheap version at 24 m.
 */
export const CHUNK_LOW_MAX: Partial<Record<ChunkClass, number>> = { 'trees-hi': 24, 'trees-far': 60, ground: 20, plants: 34 };
export const CHUNK_LOW_MIN: Partial<Record<ChunkClass, number>> = { 'trees-lo': 20 };

export function chunkVisible(cls: ChunkClass, dist: number, low = false): boolean {
  const r = CHUNK_LOD[cls];
  const max = low ? (CHUNK_LOW_MAX[cls] ?? r.max * 0.72) : r.max;
  const min = low ? (CHUNK_LOW_MIN[cls] ?? r.min) : r.min;
  return dist <= max && dist >= min;
}

// ---------------------------------------------------------------------------
// Repeatable test poses (headset performance tests, ?test= / ?area=)
// ---------------------------------------------------------------------------

export interface TestPose {
  id: string;
  label: string;
  x: number;
  z: number;
  /** Heading in degrees, 0 = facing -Z (north), positive = turned left (counter-clockwise from above). */
  yawDeg: number;
}

/**
 * The three worst viewpoints, used by the headset test mode and by tools/asset-stats.mjs:
 *   entrance  the arrival point, looking straight down the trail
 *   trail     the trail bend, looking across at the pool and its cascade
 *   clearing  the clearing, turned around to look back down the trail
 */
export const TEST_POSES: Record<'entrance' | 'trail' | 'clearing', TestPose> = {
  entrance: { id: 'entrance', label: 'Jungle Entrance (down the trail)', x: SPAWN[0], z: SPAWN[1], yawDeg: 0 },
  trail: { id: 'trail', label: 'Forest Trail (toward the pool)', x: -1.8, z: -15.6, yawDeg: 51 },
  clearing: { id: 'clearing', label: 'Ancient Clearing (looking back)', x: 0, z: -57.5, yawDeg: 180 },
};
export type TestId = keyof typeof TEST_POSES;

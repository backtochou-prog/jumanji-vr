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

import { PLATFORM, TERRACE, VALLEY, buildRoute, corridorWalls, gradeRoute, landform, mountainWeight, ringWalls, routeNear, viewpoints } from './mountain.ts';
import type { GuardWall } from './mountain.ts';
import { clamp01, fbm, makeRandom, nearestOnPolyline, sampleSpline, smoothstep, valueNoise } from './math.ts';
export { clamp01, fbm, makeRandom, smoothstep, valueNoise };

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

/**
 * SCALE CONVENTION. One world unit is one metre everywhere (no node or root carries a scale; every asset is baked in metres).
 * The structures below are DESIGNED at a small reference size and BAKED at these factors, so each keeps its authored proportions:
 *   temple 1.9   (design 15 x 9 m footprint, 8 m tall  ->  28.5 x 17.1 m, ~15 m tall, doorway ~10 m, columns 4-7 m)
 *   spire  2.08  (design 24 m  ->  50 m, ~11 m wide at the base: taller than every tree but the emergents)
 *   pillar 2.1   (design 2.2-3.8 m  ->  4.6-8 m, 2.5 m thick)
 *   root arch 1.7, fallen giant 1.4, backdrop cliff and its fall 1.8
 * Player: eye height 1.65 m, capsule radius 0.5 m. Trees follow TREE_SPECS (giants 60-75 m, canopy 36-42 m, sub-canopy 28-31 m).
 * The altar stays HUMAN-SIZED (top 0.94 m) because the Heartstone on it must be graspable.
 */
export const SCALE = { temple: 1.9, spire: 50 / 24, pillar: 2.1, rootArch: 1.7, fallenGiant: 1.4, cliff: 1.8 } as const;

/** Overgrown temple (origin on the ground, front faces +Z toward the altar). Front edge stays at z = -65.45, where it always was. */
export const TEMPLE = { x: 0, z: -74, width: 15 * SCALE.temple, depth: 9 * SCALE.temple } as const;

/** Tall ruined spire: destination landmark, now rising above the canopy. `r` = its base radius. */
export const SPIRE = { x: -19, z: -57, h: 50, r: 2.7 * SCALE.spire } as const;

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
export const ROOT_ARCH = { x: 4.5, z: -34.0, yaw: 0.1, scale: SCALE.rootArch, trunk: 4.8 * SCALE.rootArch, legX: -2.5 * SCALE.rootArch } as const;
export const FALLEN_GIANT = { x: -6.6, z: -31.5, yaw: 1.28, length: 11 * SCALE.fallenGiant, radius: 0.85 * SCALE.fallenGiant } as const;

/** Occasional muddy hollows on the trail (x, z, radius). */
export const MUD_PATCHES: { x: number; z: number; r: number }[] = [
  { x: -3.0, z: -16, r: 1.9 },
  { x: 3.4, z: -29.5, r: 1.7 },
  { x: -0.7, z: -46, r: 1.8 },
];

/**
 * Where the mountain route's two colossal gate giants stand (src/world/mountain-placements.ts, route s=30; the validator fails if they move).
 * The jungle's random trees keep out of these discs so the two independently generated tree sets never interpenetrate.
 */
export const MOUNTAIN_GATE_TREES: { x: number; z: number; r: number }[] = [
  { x: 38.7, z: -45.0, r: 6.9 },
  { x: 23.6, z: -56.3, r: 6.1 },
];

/** Distant cliff with the waterfall: the backdrop of the ancient clearing. */
export const CLIFF = { x: 5, z: -96 } as const;

/** Walkable ellipse (centre + radii). An invisible wall closes it; dense jungle hides it. */
export const WALK_LIMIT = { cx: 0, cz: -33, rx: 27, rz: 52 };

/** Ruined pillars of the ancient clearing (height m, broken = snapped top). */
export const PILLAR_R = 0.6 * SCALE.pillar;
export const PILLARS: { x: number; z: number; h: number; broken: boolean; seed: number }[] = [
  { x: -7.0, z: -59.0, h: 3.8 * SCALE.pillar, broken: false, seed: 3 },
  { x: 7.4, z: -58.6, h: 2.2 * SCALE.pillar, broken: true, seed: 4 },
  { x: -12.5, z: -62.4, h: 2.6 * SCALE.pillar, broken: true, seed: 5 },
];

/** View corridors kept free of tall trees: [from, to, half-width]. */
export const CORRIDORS: { a: Vec2; b: Vec2; w: number }[] = [
  { a: [0, -50], b: [CLIFF.x, CLIFF.z + 6], w: 5.5 }, // clearing -> waterfall
  { a: [-1, -44], b: [SPIRE.x, SPIRE.z], w: 6.5 }, // trail end -> spire
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

/** Dense polyline sampled from PATH_POINTS (Catmull-Rom). */
export const PATH_SAMPLES: Vec2[] = sampleSpline(PATH_POINTS, 12);
export const STREAM_SAMPLES: Vec2[] = sampleSpline(STREAM_POINTS, 8);

/** Path half-width at a sample index (m): wider at the threshold and in the clearing, narrower in the jungle. */
export function pathHalfWidth(index: number): number {
  const t = index / (PATH_SAMPLES.length - 1);
  const wide = 0.32 * (1 - smoothstep(0.0, 0.12, t)) + 0.5 * smoothstep(0.86, 1.0, t);
  return 0.95 + 0.13 * Math.sin(index * 0.21 + 1.3) + wide;
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
  // The trail lies within x in [-4, 5]: beyond 38 m east/west (and far north/south) nothing depends on the exact value.
  if (x > 38 || x < -42 || z > 52 || z < -100) return { dist: Math.max(34, Math.abs(x) - 5, z > 0 ? z - 20 : -z - 60), halfWidth: 1, t: z > 0 ? 0 : 1 };
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
function jungleHeight(x: number, z: number): number {
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

/** Ground height WITHOUT the mountain route grading (jungle hills blended into the mountain landform). */
function blendedBase(x: number, z: number): number {
  const w = mountainWeight(x, z);
  if (w >= 1) return landform(x, z);
  const j = jungleHeight(x, z);
  return w > 0 ? j + (landform(x, z) - j) * w : j;
}

/** The mountain expedition route (climb, summit, descent, bridge, terrace); see mountain.ts. */
export const MTN = buildRoute(blendedBase);

/**
 * Is this point part of the mountain expedition (the landform replaces the jungle hills) or on its route corridor
 * (plus `pad` metres)? Jungle placements use it to step aside, so the existing jungle is untouched where the
 * mountain does not reach and nothing grows on the route.
 */
export function inMountainZone(x: number, z: number, pad = 2): boolean {
  if (x < 20) return false;
  if (mountainWeight(x, z) > 0.02) return true;
  const h = routeNear(MTN, x, z);
  return h.dist < h.hw + pad;
}

/** First route arc length that lies outside the jungle's walkable ellipse (the corridor walls start here). */
const MTN_WALL_START = (() => {
  for (const q of MTN.samples) if (Math.hypot((q.x - WALK_LIMIT.cx) / (WALK_LIMIT.rx - 1), (q.z - WALK_LIMIT.cz) / (WALK_LIMIT.rz - 1)) > 1) return q.s;
  return 0;
})();

/** Does the jungle boundary ring leave a gap here for the mountain route? */
export function ringOpening(x: number, z: number): boolean {
  const h = routeNear(MTN, x, z);
  return h.dist < h.hw + 0.18 + 0.25 + 0.5; // exactly the corridor lane: the ring's pieces are 1 m long here, so the gap is sealed by the corridor walls
}

/** Every invisible guard wall of the mountain route: corridor sides + the two platform rings. Shared by the collider asset and the validator. */
export const MTN_GUARDS: GuardWall[] = (() => {
  const exits = (cx: number, cz: number, r: number): [number, number][] => {
    const out: [number, number][] = [];
    for (let i = 1; i < MTN.samples.length; i++) {
      const a = MTN.samples[i - 1];
      const b = MTN.samples[i];
      const da = Math.hypot(a.x - cx, a.z - cz) - r;
      const db = Math.hypot(b.x - cx, b.z - cz) - r;
      if (da * db <= 0) out.push([b.x, b.z]);
    }
    return out;
  };
  const rp = PLATFORM.r + 0.25;
  const rt = TERRACE.r - 0.2;
  return [
    ...corridorWalls(MTN, Math.max(0, MTN_WALL_START - 5)),
    ...ringWalls(PLATFORM.x, PLATFORM.z, rp, PLATFORM.y, exits(PLATFORM.x, PLATFORM.z, rp), 1.45 + 0.18 + 0.25 + 0.4),
    ...ringWalls(TERRACE.x, TERRACE.z, rt, TERRACE.y, exits(TERRACE.x, TERRACE.z, rt), 1.3 + 0.18 + 0.25 + 0.4),
  ];
})();

/** Terrain LOD: 96 m root cells from (35, -300); a detailed root shows its fine tiles within `fine` m of the player (`fineLow` in the low tier), a coarse stand-in beyond. */
export const TERRAIN_LOD = { x0: 35, z0: -300, size: 96, fine: 150, fineLow: 100, hysteresis: 20 } as const;

/**
 * Where the player is, for the diagnostics and the test results: the three jungle areas, or on the mountain the station of the route
 * (climb, summit overlook, steep descent, cliff ledge, collapse ledge, gorge approach, rope bridge, waterfall terrace) or the open ground
 * (ridge, valley, gorge) away from it.
 */
export function areaLabel(x: number, y: number, z: number): string {
  if (mountainWeight(x, z) > 0.3) {
    const h = routeNear(MTN, x, z);
    if (h.dist < 14 && Math.abs(y - h.y) < 6) {
      const names: Record<string, string> = { climb: 'mountain climb', summit: 'summit overlook', gully: 'steep descent', ledge: 'cliff ledge', cleft: 'collapse ledge', approach: 'gorge approach', bridge: 'rope bridge', terrace: 'waterfall terrace' };
      return names[h.zone] ?? 'mountain';
    }
    const dv = Math.hypot(x - VALLEY.x, z - VALLEY.z);
    return dv < 100 && y < 6 ? 'valley' : dv < 110 && y < 28 ? 'valley wall' : 'mountain ridge';
  }
  return areaAt(x, z);
}

/** Named viewpoints along the mountain expedition (stations for ?area=, headset tests and screenshots). */
export const MTN_VIEWS = viewpoints(MTN);

/**
 * Terrain height: the jungle (relief, trail, stream, pool, mud) blended into the mountain landform east of
 * x = 22, with the expedition route graded on top (bench, summit platform, collapse hollow, brink terrace).
 */
export function terrainHeight(x: number, z: number): number {
  return x < 6 ? jungleHeight(x, z) : gradeRoute(MTN, x, z, blendedBase(x, z));
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

/** Camera far plane in the jungle (m): the fog hides 91 % of the world by 240 m, so nothing visible is ever cut (the old 100 m cut the backdrop cliff/waterfall/ridges). The mountain opens it up to 1 km. */
export const JUNGLE_FAR = 260;

/** Jungle landmarks and terrain tiles (not cell-batched) are drawn only within this distance (m) of the player; at 120 m the fog hides 68 % of them anyway. */
export const JUNGLE_LANDMARK_CAP = 120;
/** Vegetation cells are drawn only within this distance (m) in the jungle (61 % fog at 100 m; the ridge silhouettes carry the horizon). */
export const JUNGLE_CELL_CAP = 100;

/** Side of a square culling cell (m). One merged mesh per cell per class. */
export const CHUNK = 28;
/** Cell grid origin: covers the jungle and the whole mountain domain with non-negative indices. */
export const CHUNK_ORIGIN = { x: -70, z: -300 } as const;
export const chunkIndex = (x: number, z: number, size: number = CHUNK): [number, number] => [Math.floor((x - CHUNK_ORIGIN.x) / size), Math.floor((z - CHUNK_ORIGIN.z) / size)];

/**
 * Distance rules (metres from the player to the nearest point of a cell) for each chunk class.
 * `max`: hidden when farther; `min`: hidden when nearer (the cheap far version).
 * Shared by the runtime ChunkLodSystem and tools/asset-stats.mjs so the budget estimate matches.
 * The mountain adds two cheap far-field classes: `canopy` (valley/ridge tree crowns, opaque lit domes) and
 * `crags` (rock pinnacles and towers). Their cells are 128 m so a whole valley is a handful of draws.
 * On top of these, ChunkLodSystem caps everything at `viewCap(open)`: 130 m in the jungle, up to 1 km on the mountain.
 */
export const CHUNK_LOD = {
  'trees-hi': { min: 0, max: 30 },
  'trees-lo': { min: 30, max: 480 },
  'trees-far': { min: 0, max: 480 },
  plants: { min: 0, max: 36 },
  ground: { min: 0, max: 34 },
  rocks: { min: 0, max: 46 },
  deadwood: { min: 0, max: 42 },
  canopy: { min: 0, max: 520 },
  crags: { min: 0, max: 760 },
} as const;
export type ChunkClass = keyof typeof CHUNK_LOD;
/** Culling cell size per class (m). */
export const CELL_SIZE: Record<ChunkClass, number> = { 'trees-hi': CHUNK, 'trees-lo': 56, 'trees-far': 56, plants: CHUNK, ground: CHUNK, rocks: CHUNK, deadwood: CHUNK, canopy: 128, crags: 128 };
/** Largest distance anything is drawn at, by how open the view is (0 jungle .. 1 mountain top). */
export const viewCap = (open: number): number => 130 + 900 * open;

/** Distance from (x, z) to the nearest point of cell (ix, iz) of the given size. */
export function cellDistance(x: number, z: number, ix: number, iz: number, size: number = CHUNK): number {
  const x0 = CHUNK_ORIGIN.x + ix * size;
  const z0 = CHUNK_ORIGIN.z + iz * size;
  const dx = Math.max(x0 - x, 0, x - (x0 + size));
  const dz = Math.max(z0 - z, 0, z - (z0 + size));
  return Math.hypot(dx, dz);
}

/**
 * Extra cut-offs of the 'low' tier. Measured (tools/perf-probe.mjs): scaling every distance by 0.72
 * removed triangles and the additive layers but only ~7 % of the foliage overdraw, because the far tree
 * wall (always drawn) and the near crowns dominate it. 'low' therefore also drops the far wall beyond
 * 60 m, the ground-cover patches beyond 20 m, and hands detailed trees over to the cheap version at 24 m.
 */
export const CHUNK_LOW_MAX: Partial<Record<ChunkClass, number>> = { 'trees-hi': 24, 'trees-far': 60, ground: 20, plants: 34, canopy: 300, crags: 420 };
export const CHUNK_LOW_MIN: Partial<Record<ChunkClass, number>> = { 'trees-lo': 24 };

/** Distance hysteresis (m): a cell that is already shown stays until `LOD_HYSTERESIS` past its limit, one that is hidden returns `LOD_HYSTERESIS` inside it. */
export const LOD_HYSTERESIS = 1.5;

/**
 * Is a cell of class `cls` at `dist` metres drawn? `was` = it is drawn now (for hysteresis): without it a cell whose edge sits on a threshold
 * toggles every 0.25 s while the player's head sways, a visible flicker. The detailed and the cheap tree versions meet at the SAME distance
 * (hi max = lo min), so exactly one of them is drawn: no double-drawn overlap band, no gap.
 */
export function chunkVisible(cls: ChunkClass, dist: number, low = false, cap = 130, was?: boolean): boolean {
  const r = CHUNK_LOD[cls];
  const max = Math.min(cap, low ? (CHUNK_LOW_MAX[cls] ?? r.max * 0.72) : r.max);
  const min = low ? (CHUNK_LOW_MIN[cls] ?? r.min) : r.min;
  if (was === undefined) return dist <= max && dist >= min;
  const h = LOD_HYSTERESIS;
  return was ? dist <= max + h && dist >= min - h : dist <= max - h && dist >= min + h;
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

/**
 * Height the temple's base sits at: the LOWEST ground under its footprint (so a platform 28 m wide never hangs over a dip; on the high side the
 * first tier is simply buried). The scene node, the collider and the validator all use this one value.
 */
export const TEMPLE_BASE: number = (() => {
  let lo = Infinity;
  for (let i = 0; i <= 6; i++) for (let j = 0; j <= 4; j++) lo = Math.min(lo, terrainHeight(TEMPLE.x - TEMPLE.width / 2 + (TEMPLE.width * i) / 6, TEMPLE.z - TEMPLE.depth / 2 + (TEMPLE.depth * j) / 4));
  return lo - 0.05;
})();

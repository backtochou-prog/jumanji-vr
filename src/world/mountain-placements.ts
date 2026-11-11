/**
 * Placement rules for the mountain expedition (Prompt 04). Pure + deterministic, Node-time only (the results are
 * baked into src/world/baked.ts by tools/generate-scene.mjs, like the jungle's).
 *
 * Rules, not clutter:
 *   TREES      colossal gate giants at the foot of the climb, then a forest that thins and gets slimmer with
 *              altitude; none on the summit platform, the terrace, the bridge, the gorge or the open vistas;
 *              none within a trunk radius + margin of the route.
 *   PLANTS     bands from the route edge like the jungle (ground cover -> ferns -> broad-leaf/shrubs -> palms),
 *              scaled by altitude; a cliff-base garden on the inner side of the ledge; vines hang from every
 *              cliff lip and gorge rim.
 *   ROCKS      colliding boulders beside the route (never narrowing the corridor), loose cobbles ON it (no collider),
 *              a ragged rim of boulders at the summit lip, rubble in the collapse hollow.
 *   CANOPY     the valley and the ridge country are carpeted with cheap tree crowns seen from above.
 *   CRAGS      rock towers rising out of the valley: the colossal vertical landmarks.
 * Everything keeps off the route corridor, the platforms, the bridge span and the plunge basin.
 */
import { MTN, fbm, makeRandom, smoothstep, terrainHeight, terrainSlope } from './layout.ts';
import {
  BRIDGE,
  D_BRINK,
  GEO,
  PLATFORM,
  TERRACE,
  VALLEY,
  fallWetness,
  gorgeDistance,
  mountainWeight,
  riverPoint,
  routeNear,
  valleyRiverDistance,
} from './mountain.ts';
import type { RouteZone } from './mountain.ts';
import { PLANT_VARIANTS, TREE_COLLIDER, TREE_VARIANTS, treePlacements } from './placements.ts';
import type { DeadwoodPlacement, Placement, RockKind, RockPlacement, RootPlacement, TreeKind, TreePlacement } from './placements.ts';

const TAU = Math.PI * 2;
const MAX_TILT = (6 * Math.PI) / 180;

function groundTilt(x: number, z: number): [number, number] {
  const e = 0.7;
  const dhx = (terrainHeight(x + e, z) - terrainHeight(x - e, z)) / (2 * e);
  const dhz = (terrainHeight(x, z + e) - terrainHeight(x, z - e)) / (2 * e);
  return [Math.max(-MAX_TILT, Math.min(MAX_TILT, -Math.atan(dhz))), Math.max(-MAX_TILT, Math.min(MAX_TILT, Math.atan(dhx)))];
}

function mk(x: number, z: number, rng: () => number, lo: number, hi: number, variants: number, tilt = true): Placement {
  const [tiltX, tiltZ] = tilt ? groundTilt(x, z) : [0, 0];
  return { x, y: terrainHeight(x, z), z, yaw: rng() * TAU, scale: lo + (hi - lo) * rng(), variant: Math.floor(rng() * variants), tiltX, tiltZ };
}

// ---------------------------------------------------------------------------
// Route frames
// ---------------------------------------------------------------------------

interface Frame {
  x: number;
  z: number;
  /** unit tangent and left normal */
  tx: number;
  tz: number;
  nx: number;
  nz: number;
  hw: number;
  y: number;
  s: number;
  zone: RouteZone;
  /** +1 if moving along +normal goes towards the valley centre, else -1 */
  valley: number;
}

const FRAMES: Frame[] = MTN.samples.map((q, i, arr) => {
  const a = arr[Math.max(0, i - 1)];
  const b = arr[Math.min(arr.length - 1, i + 1)];
  const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const tx = (b.x - a.x) / l;
  const tz = (b.z - a.z) / l;
  const nx = -tz;
  const nz = tx;
  const d0 = Math.hypot(q.x - VALLEY.x, q.z - VALLEY.z);
  const d1 = Math.hypot(q.x + nx * 2 - VALLEY.x, q.z + nz * 2 - VALLEY.z);
  return { x: q.x, z: q.z, tx, tz, nx, nz, hw: q.hw, y: q.y, s: q.s, zone: q.zone, valley: d1 < d0 ? 1 : -1 };
});

const frameAtS = (s: number): Frame => FRAMES.reduce((b, f) => (Math.abs(f.s - s) < Math.abs(b.s - s) ? f : b));

const segDist = (x: number, z: number, ax: number, az: number, bx: number, bz: number): number => {
  const dx = bx - ax;
  const dz = bz - az;
  const u = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(x - (ax + dx * u), z - (az + dz * u));
};

/** Places nothing may grow on or beside: route corridor, platforms, bridge, gorge slot, the collapse scar, the plunge basin. */
function reserved(x: number, z: number, pad: number): boolean {
  const h = routeNear(MTN, x, z);
  if (h.dist < h.hw + pad) return true;
  if (Math.hypot(x - PLATFORM.x, z - PLATFORM.z) < PLATFORM.r + pad + 3) return true;
  if (Math.hypot(x - TERRACE.x, z - TERRACE.z) < TERRACE.r + pad + 2) return true;
  if (segDist(x, z, BRIDGE.ax, BRIDGE.az, BRIDGE.bx, BRIDGE.bz) < 7 + pad) return true;
  if (gorgeDistance(x, z) < 11 + pad && Math.hypot(x - VALLEY.x, z - VALLEY.z) > D_BRINK - 6) return true;
  if (h.s > MTN.cleft.s0 - 5 && h.s < MTN.cleft.s1 + 5 && h.dist < 12) return true;
  return false;
}

const standable = (x: number, z: number, maxSlope: number): boolean => terrainSlope(x, z, 0.8) < maxSlope;

/** No big drop within r metres: keeps trees and rocks off the lip of a cliff. */
function edgeSafe(x: number, z: number, r = 5, drop = 5): boolean {
  const y = terrainHeight(x, z);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU;
    if (terrainHeight(x + Math.cos(a) * r, z + Math.sin(a) * r) < y - drop) return false;
  }
  return true;
}

/** Vegetation vigour 0..1 by height: lush up to the lower ridge, thinning towards the windy plateau. */
const vigor = (y: number, floor = 0.3): number => 1 - (1 - floor) * smoothstep(12, 34, y);

/** Is the point inside the cone in front of the summit lip (kept open so the view is not blocked)? */
function inSummitVista(x: number, z: number, wide = false): boolean {
  const dx = x - PLATFORM.x;
  const dz = z - PLATFORM.z;
  const dist = Math.hypot(dx, dz);
  if (dist > (wide ? 78 : 60)) return false;
  const vx = VALLEY.x - PLATFORM.x;
  const vz = VALLEY.z - PLATFORM.z;
  const vl = Math.hypot(vx, vz);
  const along = (dx * vx + dz * vz) / vl;
  // `wide` (trees only): the whole half-disc in front of the lookout stays free of trunks, so the panorama over the valley is open from wall to wall
  if (wide) return along > -6 && Math.abs((-dx * vz + dz * vx) / vl) < 30 + along * 1.5;
  return along > -2 && Math.abs((-dx * vz + dz * vx) / vl) < 14 + along * 0.9;
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

let treeCache: TreePlacement[] | null = null;

export const EMERGENTS: { x: number; z: number; sc: number }[] = [];
export function mountainTrees(): TreePlacement[] {
  if (treeCache) return treeCache;
  const rng = makeRandom(31001);
  const out: TreePlacement[] = [];
  const push = (x: number, z: number, kind: TreeKind, variant: number, yaw: number, scale: number, lod: 'hi' | 'lo') =>
    out.push({ x, y: terrainHeight(x, z), z, yaw, scale, variant, tiltX: 0, tiltZ: 0, kind, colliderRadius: TREE_COLLIDER[kind] * scale, lod });
  const free = (x: number, z: number, r: number) => out.every((o) => Math.hypot(o.x - x, o.z - z) > (o.colliderRadius + r) * 1.1 + 1.0);

  // The gate: two colossal giants at the foot of the climb, one each side of the route.
  {
    const f = frameAtS(30);
    for (const [side, variant, yaw, scale] of [[1, 0, 0.8, 1.5], [-1, 1, 2.9, 1.3]] as const) {
      const r = TREE_COLLIDER.giant * scale;
      const off = f.hw + r + 2.4;
      push(f.x + f.nx * side * off, f.z + f.nz * side * off, 'giant', variant, yaw, scale, 'hi');
    }
  }
  // A sentinel at the top of the climb, beside the way onto the ridge (clear of the vista).
  {
    const f = frameAtS(MTN.samples.find((q) => q.zone === 'summit')!.s - 18);
    for (const side of [1, -1]) {
      const x = f.x + f.nx * side * 9.5;
      const z = f.z + f.nz * side * 9.5;
      if (!reserved(x, z, 3) && !inSummitVista(x, z, true) && edgeSafe(x, z, 6, 6) && free(x, z, TREE_COLLIDER.giant * 1.2)) {
        push(x, z, 'giant', 2, rng() * TAU, 1.2, 'hi');
        break;
      }
    }
  }
  const emergents: { x: number; z: number; sc: number }[] = [];
  // Valley emergents: a few huge crowns rising out of the canopy far below (cheap, far version only; no collision).
  for (let n = 0, tries = 0; n < 8 && tries < 4000; tries++) {
    const a = rng() * TAU;
    const d = 14 + rng() * (GEO.rLedgeIn - 40);
    const x = VALLEY.x + Math.cos(a) * d;
    const z = VALLEY.z + Math.sin(a) * d;
    if (terrainSlope(x, z, 1.5) > 0.5 || valleyRiverDistance(x, z) < 12 || Math.hypot(x - riverPoint(54)[0], z - riverPoint(54)[1]) < 28) continue;
    if (!free(x, z, TREE_COLLIDER.giant * 1.6 + 6)) continue;
    const sc = 1.02 + rng() * 0.22; // crowns stand just proud of the canopy, well under the summit's eye line (taller ones read as bare poles across the panorama)
    push(x, z, 'giant', n % 3, rng() * TAU, sc, 'lo');
    emergents.push({ x, z, sc });
    n++;
  }

  // The climb forest: thins and slims with altitude.
  const kindAt = (y: number): TreeKind => {
    const u = rng();
    if (y < 10) return u < 0.28 ? 'giant' : u < 0.58 ? 'tall' : u < 0.88 ? 'broad' : 'slender';
    if (y < 24) return u < 0.14 ? 'giant' : u < 0.5 ? 'tall' : u < 0.78 ? 'broad' : 'slender';
    return u < 0.42 ? 'slender' : u < 0.78 ? 'tall' : 'broad';
  };
  for (let i = 4; i < FRAMES.length - 4 && out.length < 260; i += 2) {
    const f = FRAMES[i];
    if (f.zone === 'bridge' || f.zone === 'terrace') continue;
    for (let k = 0; k < 5; k++) {
      const side = rng() < 0.5 ? -1 : 1;
      const off = f.hw + 2.6 + Math.pow(rng(), 1.5) * 40;
      const x = f.x + f.nx * side * off;
      const z = f.z + f.nz * side * off;
      if (mountainWeight(x, z) < 0.35 || reserved(x, z, 2.2) || inSummitVista(x, z, true)) continue;
      const y = terrainHeight(x, z);
      if (!standable(x, z, 0.85) || !edgeSafe(x, z)) continue;
      const p = (0.85 - 0.5 * smoothstep(8, 30, y)) * (1 - 0.55 * smoothstep(16, 40, off));
      if (rng() > p) continue;
      const kind = kindAt(y);
      const scale = kind === 'giant' ? 0.9 + rng() * 0.3 : y > 24 ? 0.8 + rng() * 0.18 : 0.9 + rng() * 0.22;
      const r = TREE_COLLIDER[kind] * scale;
      // keep the corridor clear: trunk + margin
      if (routeNear(MTN, x, z).dist < routeNear(MTN, x, z).hw + r + 1.6) continue;
      if (!free(x, z, r)) continue;
      push(x, z, kind, Math.floor(rng() * TREE_VARIANTS[kind]), rng() * TAU, scale, routeNear(MTN, x, z).dist < 11 ? 'hi' : 'lo');
    }
  }
  EMERGENTS.push(...emergents);
  treeCache = out;
  return out;
}

// ---------------------------------------------------------------------------
// Plants (bands along the route) + the cliff-base garden
// ---------------------------------------------------------------------------

type MKind = 'fern' | 'treefern' | 'broadleaf' | 'shrub' | 'palm' | 'cover' | 'flowers' | 'moss' | 'litter';
interface Band {
  band: [number, number];
  per: [number, number];
  scale: [number, number];
  slope: number;
  seed: number;
  /** minimum spacing to the previous plant of this kind (m) */
  gap: number;
}
const BANDS: Record<MKind, Band> = {
  fern: { band: [0.8, 9], per: [0, 2.4], scale: [0.9, 1.12], slope: 0.9, seed: 3201, gap: 0.6 },
  treefern: { band: [3, 13], per: [0, 0.5], scale: [0.9, 1.15], slope: 0.6, seed: 3202, gap: 3 },
  broadleaf: { band: [2.2, 12], per: [0, 1.0], scale: [1.25, 1.5], slope: 0.7, seed: 3203, gap: 2.2 },
  shrub: { band: [1.8, 11], per: [0, 1.0], scale: [0.9, 1.15], slope: 0.85, seed: 3204, gap: 1.6 },
  palm: { band: [3.2, 16], per: [0, 0.45], scale: [0.9, 1.15], slope: 0.6, seed: 3205, gap: 3.5 },
  cover: { band: [0.35, 2.6], per: [0, 1.6], scale: [0.9, 1.15], slope: 0.8, seed: 3206, gap: 1.2 },
  flowers: { band: [0.5, 7], per: [0, 1], scale: [0.9, 1.1], slope: 0.5, seed: 3207, gap: 1.4 },
  moss: { band: [0.35, 3.4], per: [0, 1.0], scale: [0.9, 1.15], slope: 0.9, seed: 3208, gap: 1.6 },
  litter: { band: [0.3, 3.2], per: [0, 1.0], scale: [0.9, 1.15], slope: 0.6, seed: 3209, gap: 1.6 },
};

/** Probability weight by kind and height (0 = none, 1 = full). */
function vigourFor(kind: MKind, y: number, wet: number): number {
  switch (kind) {
    case 'fern':
      return 0.25 + 0.75 * vigor(y, 0.45) + wet * 0.3;
    case 'treefern':
      return (1 - smoothstep(10, 22, y)) * (0.4 + wet);
    case 'broadleaf':
      return vigor(y, 0.3);
    case 'palm':
      return (1 - smoothstep(8, 20, y)) * 0.9;
    case 'shrub':
      return 0.5 + 0.5 * smoothstep(10, 30, y);
    case 'cover':
      return 0.7 + 0.3 * smoothstep(14, 32, y);
    case 'flowers':
      return smoothstep(26, 34, y);
    case 'moss':
      return 0.6 + 0.4 * (1 - smoothstep(14, 34, y)) + wet * 0.4;
    case 'litter':
      return vigor(y, 0.1);
  }
}

const plantCache = new Map<string, Placement[]>();

export function mountainPlants(kind: MKind): Placement[] {
  const cached = plantCache.get(kind);
  if (cached) return cached;
  const b = BANDS[kind];
  const rng = makeRandom(b.seed);
  const out: Placement[] = [];
  const grid = new Map<string, Placement[]>();
  const near = (x: number, z: number, r: number) => {
    const gx = Math.floor(x / 4);
    const gz = Math.floor(z / 4);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const o of grid.get(`${gx + i},${gz + j}`) ?? []) if (Math.hypot(o.x - x, o.z - z) < r) return true;
    return false;
  };
  const stride = kind === 'treefern' || kind === 'palm' ? 3 : 2;
  for (let i = 2; i < FRAMES.length - 2; i += stride) {
    const f = FRAMES[i];
    if (f.zone === 'bridge' || f.zone === 'terrace') continue;
    const summitMeadow = f.zone === 'summit';
    if (kind === 'flowers' && !summitMeadow) continue;
    for (const side of [-1, 1]) {
      const want = b.per[0] + rng() * (b.per[1] - b.per[0]);
      const n = Math.floor(want) + (rng() < want % 1 ? 1 : 0);
      for (let q = 0; q < n; q++) {
        const edge = b.band[0] + Math.pow(rng(), 0.8) * (b.band[1] - b.band[0]);
        const along = (rng() - 0.5) * 2.4 * stride;
        const x = f.x + f.nx * side * (f.hw + edge) + f.tx * along;
        const z = f.z + f.nz * side * (f.hw + edge) + f.tz * along;
        if (mountainWeight(x, z) < 0.3 || reserved(x, z, 0.35)) continue;
        const y = terrainHeight(x, z);
        const wet = fallWetness(x, z);
        if (rng() > Math.min(1, vigourFor(kind, y, wet) * (summitMeadow && kind === 'cover' ? 1.4 : 1))) continue;
        if (!standable(x, z, b.slope)) continue;
        if (near(x, z, b.gap)) continue;
        // never beyond a lip: the next 1.6 m outward must still be ground within 1.6 m of this height
        const vsx = f.nx * f.valley * side;
        if (side * f.valley > 0 && Math.abs(terrainHeight(x + f.nx * f.valley * 1.6, z + f.nz * f.valley * 1.6) - y) > 1.8) continue;
        void vsx;
        const pl = mk(x, z, rng, b.scale[0], b.scale[1], PLANT_VARIANTS[kind]);
        if (kind === 'fern') pl.variant = edge < 2.2 ? 0 : edge < 5.5 ? 1 : 2;
        out.push(pl);
        const k = `${Math.floor(x / 4)},${Math.floor(z / 4)}`;
        (grid.get(k) ?? grid.set(k, []).get(k)!).push(pl);
      }
    }
  }
  // Cliff-base garden: dense ferns, shrubs and moss hugging the inner foot of the cliff along the ledge, where the water seeps.
  if (kind === 'fern' || kind === 'shrub' || kind === 'moss' || kind === 'broadleaf') {
    const gr = makeRandom(b.seed + 77);
    for (let i = 2; i < FRAMES.length - 2; i += 1) {
      const f = FRAMES[i];
      if (f.zone !== 'ledge' && f.zone !== 'gully' && f.zone !== 'approach' && f.zone !== 'cleft') continue;
      const inner = -f.valley;
      const n = kind === 'fern' ? 2 : 1;
      for (let q = 0; q < n; q++) {
        if (gr() > (kind === 'broadleaf' ? 0.25 : 0.6)) continue;
        const edge = 0.7 + gr() * (kind === 'broadleaf' ? 3.2 : 2.6);
        const x = f.x + f.nx * inner * (f.hw + edge) + f.tx * (gr() - 0.5) * 2;
        const z = f.z + f.nz * inner * (f.hw + edge) + f.tz * (gr() - 0.5) * 2;
        if (reserved(x, z, 0.35) || !standable(x, z, 1.0) || near(x, z, b.gap * 0.7)) continue;
        const pl = mk(x, z, gr, b.scale[0], b.scale[1] + 0.05, PLANT_VARIANTS[kind]);
        if (kind === 'fern') pl.variant = edge < 2.0 ? 0 : edge < 3.4 ? 1 : 2;
        out.push(pl);
        const k = `${Math.floor(x / 4)},${Math.floor(z / 4)}`;
        (grid.get(k) ?? grid.set(k, []).get(k)!).push(pl);
      }
    }
  }
  plantCache.set(kind, out);
  return out;
}

/** Hanging vine curtains: along every cliff lip above the ledge and along the gorge rims. yaw turns the curtain to hug the face. */
let vineCache: Placement[] | null = null;
export function mountainVines(): Placement[] {
  if (vineCache) return vineCache;
  const rng = makeRandom(3301);
  const out: Placement[] = [];
  const face = (px: number, pz: number, tx: number, tz: number) => Math.atan2(-(tx - px), -(tz - pz));
  // 1. The cliff lip above the descent ledge (angles from the ledge's start to the gorge).
  for (let deg = 184; deg <= 262; deg += 2.6) {
    const a = (deg * Math.PI) / 180;
    let lip: [number, number] | null = null;
    const top = terrainHeight(VALLEY.x + Math.cos(a) * 125, VALLEY.z + Math.sin(a) * 125);
    for (let d = 118; d > 88; d -= 0.5) {
      const x = VALLEY.x + Math.cos(a) * d;
      const z = VALLEY.z + Math.sin(a) * d;
      if (terrainHeight(x, z) < top - 3.5) {
        lip = [VALLEY.x + Math.cos(a) * (d + 0.9), VALLEY.z + Math.sin(a) * (d + 0.9)];
        break;
      }
    }
    if (!lip || reserved(lip[0], lip[1], 0.5) || gorgeDistance(lip[0], lip[1]) < 14) continue;
    if (rng() > 0.86) continue;
    out.push({ x: lip[0], y: terrainHeight(lip[0], lip[1]) - 0.15, z: lip[1], yaw: face(lip[0], lip[1], VALLEY.x, VALLEY.z), scale: 0.95 + rng() * 0.35, variant: Math.floor(rng() * 3), tiltX: 0, tiltZ: 0 });
  }
  // 2. Gorge rims, from the cascade to the brink (both banks; curtains face the slot).
  for (let d = 90; d <= 150; d += 5) {
    const c = riverPoint(d);
    for (const side of [-1, 1]) {
      const ox = side;
      const topH = terrainHeight(c[0] + ox * 22, c[1]);
      let rim: [number, number] | null = null;
      for (let o = 3; o < 22; o += 0.5) {
        const x = c[0] + ox * o;
        if (terrainHeight(x, c[1]) > topH - 1.2) {
          rim = [x - ox * 0.6, c[1]];
          break;
        }
      }
      if (!rim || reserved(rim[0], rim[1], 0.5) || rng() > 0.72) continue;
      out.push({ x: rim[0], y: terrainHeight(rim[0], rim[1]) - 0.15, z: rim[1], yaw: face(rim[0], rim[1], c[0], c[1]), scale: 0.9 + rng() * 0.4, variant: Math.floor(rng() * 3), tiltX: 0, tiltZ: 0 });
    }
  }
  vineCache = out;
  return out;
}

// ---------------------------------------------------------------------------
// Rocks, deadwood, roots
// ---------------------------------------------------------------------------

let rockCache: RockPlacement[] | null = null;

export function mountainRocks(): RockPlacement[] {
  if (rockCache) return rockCache;
  const rng = makeRandom(9101);
  const out: RockPlacement[] = [];
  const trees = mountainTrees();
  const free = (x: number, z: number, r: number) =>
    trees.every((t) => Math.hypot(t.x - x, t.z - z) > t.colliderRadius + r * 0.9 + 0.2) && out.every((o) => !o.collider || Math.hypot(o.x - x, o.z - z) > o.scale * 0.95 + r * 0.9);
  const add = (x: number, z: number, kind: RockKind, s: number, collider: boolean, yaw = rng() * TAU, sink = kind === 'standing' ? 0.4 : 0.3, tilt = true) => {
    const [tiltX, tiltZ] = tilt ? groundTilt(x, z) : [0, 0];
    out.push({ x, y: terrainHeight(x, z) - sink * s, z, yaw, scale: s, variant: Math.floor(rng() * 2), tiltX, tiltZ, kind, collider, wet: false });
  };
  // Boulders and slabs beside the route (colliders keep clear of the corridor and the guard walls).
  for (let i = 6; i < FRAMES.length - 6; i += 5) {
    const f = FRAMES[i];
    if (f.zone === 'bridge' || f.zone === 'terrace' || f.zone === 'cleft') continue;
    for (const side of [-1, 1]) {
      if (rng() > 0.55) continue;
      const kind: RockKind = rng() < 0.55 ? 'boulder' : rng() < 0.6 ? 'slab' : 'standing';
      const s = kind === 'standing' ? 1.3 + rng() * 0.9 : 0.9 + rng() * 0.9;
      const off = f.hw + s * 0.95 + 1.2 + rng() * 5;
      const x = f.x + f.nx * side * off;
      const z = f.z + f.nz * side * off;
      if (mountainWeight(x, z) < 0.3 || reserved(x, z, s * 0.9 + 0.6) || !standable(x, z, 0.95) || !free(x, z, s)) continue;
      if (side * f.valley > 0 && terrainHeight(x + f.nx * f.valley * 2, z + f.nz * f.valley * 2) < terrainHeight(x, z) - 2.5) continue; // not on the drop-off side lip
      add(x, z, kind, s, kind !== 'slab' || s > 1.1);
    }
  }
  // Loose cobbles ON the steeper parts of the route (no collider: scree under the boots, never an obstacle).
  for (let i = 4; i < FRAMES.length - 4; i += 2) {
    const f = FRAMES[i];
    if (f.zone === 'bridge' || f.zone === 'terrace' || f.zone === 'summit' || f.zone === 'climb' && f.y < 6) continue;
    const gully = f.zone === 'gully' || f.zone === 'cleft';
    if (rng() > (gully ? 0.8 : f.zone === 'ledge' ? 0.5 : 0.3)) continue;
    const off = (rng() - 0.5) * 2 * (f.hw + 0.5);
    const x = f.x + f.nx * off;
    const z = f.z + f.nz * off;
    add(x, z, 'cobble', 0.35 + rng() * 0.5, false, rng() * TAU, 0.45);
  }
  // A ragged rim of boulders at the summit lip (outside the guard ring: seen, not touched).
  for (let k = 0; k < 16; k++) {
    const a = Math.atan2(VALLEY.z - PLATFORM.z, VALLEY.x - PLATFORM.x) + (k / 16 - 0.5) * 3.1 + (rng() - 0.5) * 0.2;
    const r = PLATFORM.r + 0.7 + rng() * 1.3;
    const x = PLATFORM.x + Math.cos(a) * r;
    const z = PLATFORM.z + Math.sin(a) * r;
    if (reserved(x, z, -4)) {
      /* inside the platform reservation by design */
    }
    add(x, z, rng() < 0.6 ? 'boulder' : 'slab', 0.7 + rng() * 0.8, false, rng() * TAU, 0.55, false);
  }
  // Rubble in the collapse hollow (below the shelf; seen only after the collapse).
  for (let n = 0; n < 12; n++) {
    const s = MTN.cleft.s0 + 1.5 + rng() * (MTN.cleft.s1 - MTN.cleft.s0 - 3);
    const f = frameAtS(s);
    const off = (rng() - 0.5) * 2.3 + f.valley * rng() * 1.2;
    const x = f.x + f.nx * off;
    const z = f.z + f.nz * off;
    add(x, z, n % 4 === 0 ? 'boulder' : 'cobble', n % 4 === 0 ? 0.55 + rng() * 0.3 : 0.35 + rng() * 0.45, false, rng() * TAU, 0.3);
  }
  // Rocks along the terrace lip and around the cascade.
  for (let k = 0; k < 10; k++) {
    const a = rng() * TAU;
    const r = TERRACE.r + 0.8 + rng() * 1.2;
    add(TERRACE.x + Math.cos(a) * r, TERRACE.z + Math.sin(a) * r, rng() < 0.5 ? 'boulder' : 'slab', 0.7 + rng() * 0.9, false, rng() * TAU, 0.5, false);
  }
  rockCache = out;
  return out;
}

let deadCache: DeadwoodPlacement[] | null = null;
export function mountainDeadwood(): DeadwoodPlacement[] {
  if (deadCache) return deadCache;
  const rng = makeRandom(6701);
  const out: DeadwoodPlacement[] = [];
  const trees = mountainTrees();
  const rocks = mountainRocks();
  const ok = (x: number, z: number, r: number) =>
    trees.every((t) => Math.hypot(t.x - x, t.z - z) > t.colliderRadius + r + 0.3) && rocks.every((o) => Math.hypot(o.x - x, o.z - z) > o.scale + r * 0.6) && out.every((o) => Math.hypot(o.x - x, o.z - z) > 3);
  for (let i = 8; i < FRAMES.length - 8 && out.length < 26; i += 3) {
    const f = FRAMES[i];
    if (f.zone === 'bridge' || f.zone === 'terrace' || f.zone === 'summit' || f.zone === 'cleft' || f.y > 28) continue;
    if (rng() > 0.34) continue;
    const side = rng() < 0.5 ? -1 : 1;
    const off = f.hw + 2.2 + rng() * 7;
    const x = f.x + f.nx * side * off;
    const z = f.z + f.nz * side * off;
    if (mountainWeight(x, z) < 0.3 || reserved(x, z, 1.5) || !standable(x, z, 0.6) || !ok(x, z, 0.9) || (side * f.valley > 0 && !edgeSafe(x, z, 4, 3))) continue;
    const isLog = rng() < 0.4;
    out.push({ ...mk(x, z, rng, 0.9, 1.25, 2, false), kind: isLog ? 'log' : 'branch', length: isLog ? 4.2 : 0, collider: isLog });
  }
  deadCache = out;
  return out;
}

/** Exposed root runs: from the bigger trunks beside the route towards it, plus a few root "steps" on the climb. */
export function mountainRoots(): RootPlacement[] {
  const rng = makeRandom(5151);
  const out: RootPlacement[] = [];
  for (const t of mountainTrees()) {
    if (t.lod !== 'hi' || t.kind === 'slender') continue;
    const h = routeNear(MTN, t.x, t.z);
    if (h.dist > 12 || h.zone === 'bridge') continue;
    const f = FRAMES[Math.min(FRAMES.length - 1, h.i)];
    const yaw = Math.atan2(f.x - t.x, f.z - t.z) + (rng() - 0.5) * 0.9;
    const dist = t.colliderRadius * 0.9;
    const rx = t.x + Math.sin(yaw) * dist;
    const rz = t.z + Math.cos(yaw) * dist;
    if (routeNear(MTN, rx, rz).dist < h.hw + 0.9 || reserved(rx, rz, 0.9)) continue;
    out.push({ x: rx, y: terrainHeight(rx, rz), z: rz, yaw, scale: Math.max(0.8, Math.min(1.6, t.colliderRadius / 1.8)), variant: Math.floor(rng() * 3), tiltX: 0, tiltZ: 0, from: t.colliderRadius });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Canopy (valley + ridge carpet) and crags (rock towers)
// ---------------------------------------------------------------------------

let canopyCache: Placement[] | null = null;

/** Tree crowns seen from above. y is the crown's underside (ground + trunk height). */
export function canopyClumps(): Placement[] {
  if (canopyCache) return canopyCache;
  const rng = makeRandom(7301);
  const out: Placement[] = [];
  const trees = mountainTrees();
  const lattice = (x0: number, x1: number, z0: number, z1: number, step: number, accept: (x: number, z: number, y: number) => boolean) => {
    for (let z = z0; z < z1; z += step) {
      for (let x = x0; x < x1; x += step) {
        const px = x + (rng() - 0.5) * step * 0.8;
        const pz = z + (rng() - 0.5) * step * 0.8;
        const y = terrainHeight(px, pz);
        if (!accept(px, pz, y)) continue;
        const scale = 1.0 + rng() * 0.6;
        out.push({ x: px, y: y + 8 * scale, z: pz, yaw: rng() * TAU, scale, variant: Math.floor(rng() * 3), tiltX: 0, tiltZ: 0 });
      }
    }
  };
  const clearOfNear = (x: number, z: number) => trees.every((t) => t.lod === 'lo' || Math.hypot(t.x - x, t.z - z) > 9 + t.colliderRadius) && routeNear(MTN, x, z).dist > 30;
  // The valley: floor and the lower wall, below the ledge. Not on the sheer faces, the river or the plunge basin.
  const toeX = riverPoint(54)[0];
  const toeZ = riverPoint(54)[1];
  lattice(VALLEY.x - 112, VALLEY.x + 112, VALLEY.z - 112, VALLEY.z + 112, 8.4, (x, z, y) => {
    const d = Math.hypot(x - VALLEY.x, z - VALLEY.z);
    if (d > GEO.rLedgeIn - 4 || y > GEO.floor + 62) return false;
    const sl = terrainSlope(x, z, 1.5);
    if (sl > 1.6 || rng() < smoothstep(0.9, 1.6, sl)) return false;
    if (valleyRiverDistance(x, z) < 8 || Math.hypot(x - toeX, z - toeZ) < 22 || fallWetness(x, z) > 0.45) return false;
    return true;
  });
  // The ridge country: the plateau and the climb flank beyond the near forest.
  lattice(MTN_RIDGE.x0, MTN_RIDGE.x1, MTN_RIDGE.z0, MTN_RIDGE.z1, 11, (x, z, y) => {
    if (mountainWeight(x, z) < 0.7 || y < 6) return false;
    if (Math.hypot(x - VALLEY.x, z - VALLEY.z) < GEO.rCliffTop + 4) return false; // inside the pit rim: the ledge, wall, cliffs
    if (terrainSlope(x, z, 1.5) > 0.9) return false;
    if (gorgeDistance(x, z) < 14 || !clearOfNear(x, z) || inSummitVista(x, z)) return false;
    return rng() < 0.78;
  });
  // Emergent giants: a huge crown on top of each tall valley tree (the far tree version's cards are edge-on from above).
  mountainTrees();
  for (const e of EMERGENTS) {
    const y = terrainHeight(e.x, e.z);
    out.push({ x: e.x, y: y + 38 * e.sc * 0.8, z: e.z, yaw: rng() * TAU, scale: 1.9 * (e.sc / 1.5), variant: Math.floor(rng() * 3), tiltX: 0, tiltZ: 0 });
  }
  canopyCache = out;
  return out;
}
const MTN_RIDGE = { x0: 30, x1: 400, z0: -285, z1: -20 } as const;

export interface CragPlacement extends Placement {
  kind: 'pinnacle';
}

let cragCache: CragPlacement[] | null = null;

/** Rock towers: 25 - 70 m formations rising from the valley floor and lower walls, plus two flanking the descent. */
export function cragPlacements(): CragPlacement[] {
  if (cragCache) return cragCache;
  const rng = makeRandom(8201);
  const out: CragPlacement[] = [];
  const spaced = (x: number, z: number, r: number) => out.every((o) => Math.hypot(o.x - x, o.z - z) > (o.scale + r) * 2.6 + 12);
  const toe = riverPoint(54);
  for (let tries = 0; out.length < 12 && tries < 6000; tries++) {
    const a = rng() * TAU;
    const d = 22 + rng() * (GEO.rLedgeIn - 30);
    const x = VALLEY.x + Math.cos(a) * d;
    const z = VALLEY.z + Math.sin(a) * d;
    const scale = 2.3 + rng() * 3.4;
    if (terrainSlope(x, z, 1.5) > 1.3 || valleyRiverDistance(x, z) < 10 + scale * 2 || Math.hypot(x - toe[0], z - toe[1]) < 30 || fallWetness(x, z) > 0.3) continue;
    if (!spaced(x, z, scale)) continue;
    const sl = terrainSlope(x, z, 1.5);
    out.push({ x, y: terrainHeight(x, z) - 0.35 * scale - sl * 2.2 * scale, z, yaw: rng() * TAU, scale, variant: out.length % 3, tiltX: 0, tiltZ: 0, kind: 'pinnacle' });
  }
  cragCache = out;
  return out;
}

/** Circles that darken the terrain around mountain trunks, rocks and logs (baked ambient occlusion). */
export function mountainOccluders(): { x: number; z: number; r: number }[] {
  const out: { x: number; z: number; r: number }[] = [];
  for (const t of mountainTrees()) if (t.lod === 'hi' || routeNear(MTN, t.x, t.z).dist < 30) out.push({ x: t.x, z: t.z, r: t.colliderRadius * 0.85 });
  for (const r of mountainRocks()) if (r.collider) out.push({ x: r.x, z: r.z, r: r.scale * 0.8 });
  for (const d of mountainDeadwood()) if (d.kind === 'log') out.push({ x: d.x, z: d.z, r: d.length * 0.3 });
  void fbm;
  return out;
}

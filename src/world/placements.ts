/**
 * Art-directed placement rules for the Jungle (Prompt 02).
 *
 * Nothing here is "random clutter": every layer follows a rule tied to the
 * trail, the three areas, the stream/pool and protected view corridors.
 *
 *   TRANSITION BANDS (distance from the trail edge)
 *     0.0 - 0.3 m  bare trail
 *     0.3 - 2.5 m  ground cover, litter, small stones, flowers (clearing)
 *     1.0 - 9   m  ferns (S -> M -> L with distance)
 *     2.5 - 14  m  broad-leaf plants, shrubs
 *     3   - 18  m  palms (understory)
 *     5   +     m  trees (spacing grows with trunk radius: no intersecting giants)
 *   AREAS
 *     entrance  dense, dark, ferns + broad-leaf, colossal gate trees
 *     trail     layered mix, deadwood, roots, rock outcrops, pool + ford
 *     clearing  open meadow: grass, flowers, moss; ruins; trees only on the rim
 *
 * Biological proportions: scale ranges are narrow per species (+-8-14 %),
 * uniform in all axes (no squashing), tilt <= 6 degrees following the ground.
 * Output feeds tools/generate-scene.mjs, the collider asset, the terrain
 * ambient-occlusion bake and tools/validate-scene.mjs. Pure + deterministic.
 */
import {
  ALTAR,
  CLEARING,
  CORRIDORS,
  ENTRANCE_TREES,
  FALLEN_GIANT,
  FORD,
  HILL,
  MUD_PATCHES,
  PATH_SAMPLES,
  PILLARS,
  PILLAR_R,
  POOL,
  ROOT_ARCH,
  MOUNTAIN_GATE_TREES,
  SPAWN,
  SPIRE,
  STREAM_SAMPLES,
  TEMPLE,
  VISTA,
  WALK_LIMIT,
  areaWeights,
  distanceToPath,
  distanceToStream,
  fbm,
  hillWeight,
  inMountainZone,
  inVistaFan,
  makeRandom,
  smoothstep,
  terrainHeight,
  vegetationDensity,
  wetness,
} from './layout.ts';
import { SUN_DIR, SUN_TO } from './palette.ts';
import { KNOLL_FORWARD, KNOLL_RIGHT, MEADOW_WIND, MONOLITH_SCALE, meadowFields, meadowTuftDensity } from './layout.ts';

export interface Placement {
  x: number;
  y: number;
  z: number;
  yaw: number; // radians
  scale: number;
  /** Index into the asset family (generator applies modulo the family size). */
  variant: number;
  /** Small tilt to follow the ground (radians about world X / Z), <= ~6 degrees. */
  tiltX: number;
  tiltZ: number;
}

const TAU = Math.PI * 2;
const MAX_TILT = (6 * Math.PI) / 180;

function groundTilt(x: number, z: number): [number, number] {
  const e = 0.7;
  const dhx = (terrainHeight(x + e, z) - terrainHeight(x - e, z)) / (2 * e);
  const dhz = (terrainHeight(x, z + e) - terrainHeight(x, z - e)) / (2 * e);
  const tx = Math.max(-MAX_TILT, Math.min(MAX_TILT, -Math.atan(dhz)));
  const tz = Math.max(-MAX_TILT, Math.min(MAX_TILT, Math.atan(dhx)));
  return [tx, tz];
}

function at(x: number, z: number, rng: () => number, lo: number, hi: number, variants: number, tilt = true): Placement {
  const [tiltX, tiltZ] = tilt ? groundTilt(x, z) : [0, 0];
  return { x, y: terrainHeight(x, z), z, yaw: rng() * TAU, scale: lo + (hi - lo) * rng(), variant: Math.floor(rng() * variants), tiltX, tiltZ };
}

function ellipse(x: number, z: number): number {
  const dx = (x - WALK_LIMIT.cx) / WALK_LIMIT.rx;
  const dz = (z - WALK_LIMIT.cz) / WALK_LIMIT.rz;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Normalised distance in the walkable REGION (old ellipse or the knoll's disc): <= 1 inside. Plants use it; trees and rocks keep `ellipse` so the rest of the forest does not re-roll. */
function walkMetric(x: number, z: number): number {
  return Math.min(ellipse(x, z), Math.hypot(x - HILL.walk.cx, z - HILL.walk.cz) / HILL.walk.r);
}

function segDist(x: number, z: number, a: readonly [number, number], b: readonly [number, number]): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const u = Math.min(1, Math.max(0, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(x - (a[0] + dx * u), z - (a[1] + dz * u));
}

/** Distance to the nearest protected view corridor (negative inside). */
function corridorClearance(x: number, z: number): number {
  let best = Infinity;
  for (const c of CORRIDORS) best = Math.min(best, segDist(x, z, c.a, c.b) - c.w);
  return best;
}

/** Circle solids used to keep things from intersecting. */
export interface Solid {
  x: number;
  z: number;
  r: number;
  kind: 'tree' | 'rock' | 'log' | 'pillar' | 'altar' | 'arch' | 'temple';
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

export type TreeKind = 'giant' | 'tall' | 'broad' | 'slender';
export interface TreePlacement extends Placement {
  kind: TreeKind;
  /** Collision radius for the invisible trunk collider (m). */
  colliderRadius: number;
  /** 'hi' when the tree can be seen up close, otherwise 'lo'. */
  lod: 'hi' | 'lo';
  /** Variants per kind (assets are `tree-<kind>-<variant>[-lo]`). */
}

/** Collider radius at scale 1, per kind (the buttress footprint, not the bare trunk). */
/** Buttress footprint radius at scale 1 (m): grown with the species (see GROWTH in trees.scene-asset.ts). */
export const TREE_COLLIDER: Record<TreeKind, number> = { giant: 4.3, tall: 1.9, broad: 2.1, slender: 1.0 };
export const TREE_VARIANTS: Record<TreeKind, number> = { giant: 3, tall: 2, broad: 2, slender: 1 };

let treeCache: TreePlacement[] | null = null;

export function treePlacements(): TreePlacement[] {
  if (treeCache) return treeCache;
  const rng = makeRandom(4242);
  const out: TreePlacement[] = [];
  const push = (p: Placement, kind: TreeKind, forceLod?: 'hi' | 'lo') => {
    const pd = distanceToPath(p.x, p.z).dist;
    const near = pd < 14 || Math.hypot(p.x - SPAWN[0], p.z - SPAWN[1]) < 20 || Math.hypot(p.x - CLEARING.x, p.z - CLEARING.z) < CLEARING.r + 10;
    out.push({ ...p, tiltX: 0, tiltZ: 0, kind, colliderRadius: TREE_COLLIDER[kind] * p.scale, lod: forceLod ?? (near ? 'hi' : 'lo') });
  };
  // Fixed trees are the composition's FRAME (gate, second ring, south grove): exempt from the vista fan that clears the random ones.
  const fixedTrees = new Set<TreePlacement>();
  const fixed = (x: number, z: number, kind: TreeKind, variant: number, yaw: number, scale = 1, lod: 'hi' | 'lo' = 'hi') => {
    push({ x, y: terrainHeight(x, z), z, yaw, scale, variant, tiltX: 0, tiltZ: 0 }, kind, lod);
    fixedTrees.add(out[out.length - 1]);
  };

  // The gate: two colossal trees frame the trail; two more step back to deepen it.
  fixed(ENTRANCE_TREES[0][0], ENTRANCE_TREES[0][1], 'giant', 0, 0.6);
  fixed(ENTRANCE_TREES[1][0], ENTRANCE_TREES[1][1], 'giant', 1, 2.4);
  // (second ring moved outward with the widened gate: the portal seen from the knoll is ~26 degrees wide)
  fixed(-19.5, -9.5, 'giant', 2, 1.9, 0.95);
  fixed(18.5, -11.5, 'giant', 0, 4.1, 0.92);
  // Landmark: the giant that carries the root arch beside the trail.
  // (the root-arch asset grows from a trunk 4.8 m along its local +X)
  fixed(ROOT_ARCH.x + ROOT_ARCH.trunk * Math.cos(ROOT_ARCH.yaw), ROOT_ARCH.z - ROOT_ARCH.trunk * Math.sin(ROOT_ARCH.yaw), 'giant', 2, ROOT_ARCH.yaw + 1.2, 0.8);
  // Clearing rim: a few mature trees frame the open meadow (never in the view corridors).
  fixed(-31, -60, 'giant', 2, 0.3, 0.9); // (was (-14.5,-56): it overlapped the spire's base and would stand in the middle of the vista)
  fixed(12.5, -59.5, 'giant', 1, 2.1, 0.88);

  const kindOrder: TreeKind[] = ['tall', 'broad', 'slender', 'tall', 'broad', 'giant'];
  let tries = 0;
  while (out.length < 104 && tries++ < 30000) {
    const x = -52 + rng() * 104;
    const z = -108 + rng() * 140;
    const e = ellipse(x, z);
    if (e > 1.85) continue;
    const kind: TreeKind = e > 1.2 ? (rng() > 0.45 ? 'giant' : 'tall') : kindOrder[Math.floor(rng() * kindOrder.length)];
    if (kind === 'giant' && e < 1.0) continue; // giants only as background wall inside the walkable area
    const p = distanceToPath(x, z);
    const scale = kind === 'giant' ? 0.85 + rng() * 0.25 : 0.9 + rng() * 0.22;
    const r = TREE_COLLIDER[kind] * scale;
    if (p.dist < p.halfWidth + r + 1.6) continue;
    if (Math.hypot(x - SPAWN[0], z - SPAWN[1]) < 6 + r) continue;
    if (Math.hypot(x - CLEARING.x, z - CLEARING.z) < CLEARING.r - 1.5) continue; // open meadow
    if (Math.hypot(x - ALTAR[0], z - ALTAR[1]) < 9) continue;
    if (Math.abs(x - TEMPLE.x) < TEMPLE.width / 2 + 2 + r && Math.abs(z - TEMPLE.z) < TEMPLE.depth / 2 + 2 + r) continue;
    if (Math.hypot(x - POOL.x, z - POOL.z) < POOL.r * 1.7 + r) continue;
    if (distanceToStream(x, z) < r + 1.6) continue;
    if (Math.hypot(x - ROOT_ARCH.x, z - ROOT_ARCH.z) < 5 * ROOT_ARCH.scale + r) continue;
    if (MOUNTAIN_GATE_TREES.some((g) => Math.hypot(x - g.x, z - g.z) < g.r + r + 0.5)) continue;
    if (segDist(x, z, [FALLEN_GIANT.x - FALLEN_GIANT.length / 2, FALLEN_GIANT.z + 2], [FALLEN_GIANT.x + FALLEN_GIANT.length / 2, FALLEN_GIANT.z - 2]) < 3 + FALLEN_GIANT.radius + r) continue;
    const talls = kind === 'giant' || kind === 'tall';
    if (talls && corridorClearance(x, z) < r + 1) continue;
    // Density: thicker belts close to the trail, sparser in the open clearing, fewer in the far corners.
    const a = areaWeights(x, z);
    const belt = 0.3 + 0.7 * smoothstep(0.2, 0.9, e) * (1 - smoothstep(1.3, 1.85, e) * 0.5);
    const want = (a.entrance * 1.05 + a.trail * 0.95 + a.clearing * 0.35) * belt * (0.7 + 0.6 * fbm(x * 0.07, z * 0.07, 7, 2));
    if (rng() > want) continue;
    // No intersecting trunks: spacing grows with both radii.
    if (out.some((o) => Math.hypot(o.x - x, o.z - z) < (o.colliderRadius + r) * 1.15 + 1.0)) continue;
    push({ x, y: terrainHeight(x, z), z, yaw: rng() * TAU, scale, variant: Math.floor(rng() * TREE_VARIANTS[kind]), tiltX: 0, tiltZ: 0 }, kind);
  }
  // The south grove: a ring of giants and canopy trees behind and beside the knoll (appended AFTER the random loop so its RNG sequence is unchanged).
  // They close the view when you turn round, hide the walk boundary and the world's southern edge, and keep the knoll feeling enclosed and sheltered.
  for (const [x, z, kind, variant, scale] of [
    [-17, 45, 'giant', 1, 1.0],
    [12, 47, 'giant', 0, 0.95],
    [-3, 57, 'giant', 2, 1.05],
    [23, 27, 'giant', 1, 0.9],
    [-25, 25, 'giant', 0, 0.92],
    [-22, 36, 'tall', 0, 1.0],
    [18, 38, 'tall', 1, 1.0],
    [-9, 51, 'tall', 1, 1.0],
    [6, 53, 'tall', 0, 1.0],
  ] as [number, number, TreeKind, number, number][]) fixed(x, z, kind, variant, (x * 12.9898 + z * 78.233) % TAU, scale, Math.hypot(x - SPAWN[0], z - SPAWN[1]) < 22 ? 'hi' : 'lo');
  // The vista: no RANDOM tree inside the fan of sight from the knoll to the waterfall (all kinds), nor at the fall's foot, nor in the knoll's glade.
  const fanPad: Record<TreeKind, number> = { giant: 7, tall: 6, broad: 6, slender: 4 };
  treeCache = out.filter((t) => !inMountainZone(t.x, t.z, t.colliderRadius + 1.6)).filter((t) => fixedTrees.has(t) || !inVistaFan(t.x, t.z, fanPad[t.kind] * t.scale))
    // a random tree never overlaps a fixed one (the grove and the moved frame were added after the random loop had chosen its spots)
    .filter((t) => fixedTrees.has(t) || ![...fixedTrees].some((f) => Math.hypot(f.x - t.x, f.z - t.z) < (f.colliderRadius + t.colliderRadius) * 1.15 + 1.0));
  return treeCache;
}

// ---------------------------------------------------------------------------
// Rocks
// ---------------------------------------------------------------------------

export type RockKind = 'boulder' | 'slab' | 'standing' | 'cobble';
export interface RockPlacement extends Placement {
  kind: RockKind;
  collider: boolean;
  /** Placed in/at water (not ground-tilted, sunk deeper). */
  wet: boolean;
  /** The knoll's own prototype (`rock-<kind>-<n>`), named explicitly so the jungle's random variants keep their ids (tools/generate-scene.mjs). */
  fixedVariant?: number;
  /** No contact-AO disc in the terrain colours (flush stones, pebbles). */
  noAO?: boolean;
}

let rockCache: RockPlacement[] | null = null;

export function rockPlacements(): RockPlacement[] {
  if (rockCache) return rockCache;
  const rng = makeRandom(9001);
  const out: RockPlacement[] = [];
  const trees = treePlacements();
  const free = (x: number, z: number, r: number) =>
    trees.every((t) => Math.hypot(t.x - x, t.z - z) > t.colliderRadius + r * 0.9 + 0.2) &&
    out.every((o) => !o.collider || Math.hypot(o.x - x, o.z - z) > o.scale * 0.95 + r * 0.9);
  const add = (x: number, z: number, kind: RockKind, s: number, collider = false, wet = false, sink = kind === 'standing' ? 0.55 : 0.3) => {
    if (!free(x, z, s)) return;
    // A collidable rock never narrows the 1.8 m walking lane of the trail.
    if (collider && distanceToPath(x, z).dist < s * 0.95 + 1.3) return;
    const p = at(x, z, rng, s, s, 2, !wet);
    p.y -= sink * s * 0.5;
    out.push({ ...p, kind, collider, wet });
  };

  // Pool rim: a deliberate ring of stones, bigger on the cascade (north-west) side.
  for (let i = 0; i < 17; i++) {
    const a = (i / 17) * TAU + rng() * 0.25;
    const rr = POOL.r * (1.12 + rng() * 0.2);
    const cascadeSide = Math.cos(a - 2.4) > 0.3;
    const s = (cascadeSide ? 1.0 : 0.5) + rng() * 0.45;
    const x = POOL.x + Math.cos(a) * rr;
    const z = POOL.z + Math.sin(a) * rr;
    if (distanceToPath(x, z).dist < 1.6) continue;
    add(x, z, rng() > 0.35 ? 'boulder' : 'slab', s, s > 0.9, true);
  }
  // Cascade ledge behind the pool (north-west rim).
  add(POOL.x - 2.9, POOL.z - 2.7, 'slab', 2.2, true, true, 0.1);
  add(POOL.x - 4.1, POOL.z - 2.2, 'boulder', 1.7, true, true);
  add(POOL.x - 2.2, POOL.z - 4.0, 'boulder', 1.9, true, true);
  add(POOL.x - 3.4, POOL.z - 3.6, 'boulder', 2.3, true, true);

  // Stream banks: small stones half-buried along both sides.
  for (let i = 2; i < STREAM_SAMPLES.length - 1; i += 2) {
    const [sx, sz] = STREAM_SAMPLES[i];
    if (Math.hypot(sx - POOL.x, sz - POOL.z) < POOL.r * 1.3) continue;
    for (const side of [-1, 1]) {
      if (rng() > 0.65) continue;
      const off = 1.25 + rng() * 0.8;
      const x = sx + (rng() - 0.5) * 0.5;
      const z = sz + side * off;
      if (distanceToPath(x, z).dist < 1.5) continue;
      add(x, z, 'cobble', 0.35 + rng() * 0.45, false, true, 0.5);
    }
  }
  // Ford: flat stepping stones beside the trail across the stream.
  for (let k = 0; k < 5; k++) {
    const x = FORD.x + 1.35 + (k % 2 ? 0.25 : -0.1);
    const z = FORD.z + 1.4 - k * 0.7;
    add(x, z, k % 2 ? 'cobble' : 'slab', 0.62 + rng() * 0.14, false, true, 0.12);
  }

  // Entrance: mossy boulders at the feet of the gate trees.
  for (const [ex, ez] of ENTRANCE_TREES) {
    for (let i = 0; i < 5; i++) {
      const a = rng() * TAU;
      const r = 3.0 + rng() * 2.4;
      const x = ex + Math.cos(a) * r;
      const z = ez + Math.sin(a) * r;
      if (distanceToPath(x, z).dist < 2.0) continue;
      add(x, z, rng() > 0.3 ? 'boulder' : 'slab', 0.85 + rng() * 0.9, true);
    }
  }
  // Landmark: a rock outcrop on the trail's inner bend, with room for ferns on top.
  const OUT = { x: -7.4, z: -41.5 };
  add(OUT.x, OUT.z, 'slab', 2.5, true);
  add(OUT.x + 1.9, OUT.z + 0.8, 'boulder', 2.0, true);
  add(OUT.x - 1.7, OUT.z - 0.9, 'boulder', 2.2, true);
  add(OUT.x + 0.4, OUT.z - 2.3, 'standing', 1.8, true);
  add(OUT.x + 3.0, OUT.z - 0.6, 'boulder', 1.2, true);

  // Along the trail edge: half-buried stones, an occasional larger marker.
  for (let n = 0; n < 500 && out.length < 80; n++) {
    const x = -40 + rng() * 80;
    const z = -80 + rng() * 100;
    const p = distanceToPath(x, z);
    if (p.dist < p.halfWidth + 0.35 || p.dist > p.halfWidth + 3.2 || ellipse(x, z) > 1.05) continue;
    if (Math.hypot(x - SPAWN[0], z - SPAWN[1]) < 4.5) continue;
    if (Math.hypot(x - ALTAR[0], z - ALTAR[1]) < 3.5) continue;
    if (Math.abs(x - TEMPLE.x) < TEMPLE.width / 2 + 1.5 && Math.abs(z - TEMPLE.z) < TEMPLE.depth / 2 + 1.5) continue;
    if (distanceToStream(x, z) < 1.6 || Math.hypot(x - POOL.x, z - POOL.z) < POOL.r * 1.8) continue;
    if (out.some((o) => Math.hypot(o.x - x, o.z - z) < 2.4)) continue;
    const big = rng() > 0.82;
    add(x, z, big ? 'standing' : rng() > 0.5 ? 'cobble' : 'boulder', big ? 1.1 + rng() * 0.5 : 0.4 + rng() * 0.55, big);
  }
  // Wall rocks and clearing-rim stones: mass at the boundary, a ring of old stones around the meadow.
  for (let n = 0; n < 700 && out.length < 96; n++) {
    const x = -42 + rng() * 84;
    const z = -90 + rng() * 120;
    const e = ellipse(x, z);
    const dc = Math.hypot(x - CLEARING.x, z - CLEARING.z);
    const rim = dc > CLEARING.r - 2 && dc < CLEARING.r + 3;
    if (!rim && (e < 0.8 || e > 1.3)) continue;
    if (distanceToPath(x, z).dist < 3.2 || corridorClearance(x, z) < 0) continue;
    if (Math.abs(x - TEMPLE.x) < TEMPLE.width / 2 + 2 && Math.abs(z - TEMPLE.z) < TEMPLE.depth / 2 + 2) continue;
    if (out.some((o) => Math.hypot(o.x - x, o.z - z) < 3.2)) continue;
    add(x, z, rim ? (rng() > 0.5 ? 'cobble' : 'boulder') : rng() > 0.4 ? 'boulder' : 'slab', rim ? 0.7 + rng() * 0.8 : 1.0 + rng() * 1.5, !rim);
  }
  // The knoll's lookout: a ring of standing stones and boulders on the southern arc around the start (bearings 100-260 degrees from north; the north,
  // the view, stays open). Added last so the random sequence of everything above is untouched; `add` keeps the 1.8 m trail lane clear.
  {
    const arc = makeRandom(8817);
    for (let i = 0; i < 9; i++) {
      const az = ((100 + (160 * i) / 8 + (arc() - 0.5) * 8) * Math.PI) / 180;
      const rad = 5.5 + (arc() - 0.5) * 1.4;
      const x = SPAWN[0] + Math.sin(az) * rad;
      const z = SPAWN[1] - Math.cos(az) * rad;
      const n0 = out.length;
      if (i % 3 === 1) add(x, z, 'boulder', 0.95 + arc() * 0.5, true);
      else add(x, z, 'standing', 0.9 + arc() * 0.5, true);
      // in full sun on dry grass: the sunlit sandstone variants (boulder 2-3, standing 4), not the jungle's mossy ones
      if (out.length > n0) out[n0].fixedVariant = out[n0].kind === 'boulder' ? 2 + (i % 2) : 4;
    }
  }
  knollDressing(out, free);
  out.push(lecternStone()); // the welcome board's stone, beside the start
  rockCache = out.filter((r) => !inMountainZone(r.x, r.z, r.scale));
  return rockCache;
}

// ---------------------------------------------------------------------------
// Deadwood and roots
// ---------------------------------------------------------------------------

export interface DeadwoodPlacement extends Placement {
  kind: 'log' | 'branch';
  /** Collision length (m) for logs; 0 = none. */
  length: number;
  collider: boolean;
}

let deadCache: DeadwoodPlacement[] | null = null;

export function deadwoodPlacements(): DeadwoodPlacement[] {
  if (deadCache) return deadCache;
  const rng = makeRandom(6606);
  const out: DeadwoodPlacement[] = [];
  const trees = treePlacements();
  const rocks = rockPlacements();
  const ok = (x: number, z: number, r: number) =>
    trees.every((t) => Math.hypot(t.x - x, t.z - z) > t.colliderRadius + r + 0.3) &&
    rocks.every((o) => Math.hypot(o.x - x, o.z - z) > o.scale + r * 0.6) &&
    out.every((o) => Math.hypot(o.x - x, o.z - z) > 1.6);
  // Branches: scattered on the forest floor, thickest under big trees.
  for (let n = 0; n < 900 && out.length < 44; n++) {
    const x = -34 + rng() * 68;
    const z = -80 + rng() * 100;
    const p = distanceToPath(x, z);
    if (p.dist < p.halfWidth + 0.5 || ellipse(x, z) > 1.0 || distanceToStream(x, z) < 1.3) continue;
    const a = areaWeights(x, z);
    if (rng() > (a.entrance * 0.9 + a.trail * 0.75 + a.clearing * 0.1) * 0.7) continue;
    if (!ok(x, z, 0.8)) continue;
    const pl = at(x, z, rng, 0.9, 1.25, 3);
    out.push({ ...pl, kind: 'branch', length: 0, collider: false });
  }
  // Mid-size logs: aligned loosely with the trail, 3-5 m.
  for (let n = 0; n < 600 && out.filter((o) => o.kind === 'log').length < 9; n++) {
    const x = -30 + rng() * 60;
    const z = -56 + rng() * 64;
    const p = distanceToPath(x, z);
    if (p.dist < p.halfWidth + 2.4 || p.dist > 12 || ellipse(x, z) > 0.95 || distanceToStream(x, z) < 2.2) continue;
    if (Math.hypot(x - CLEARING.x, z - CLEARING.z) < CLEARING.r) continue;
    if (!ok(x, z, 2.2)) continue;
    const pl = at(x, z, rng, 0.9, 1.15, 3);
    out.push({ ...pl, kind: 'log', length: 4.4 * pl.scale, collider: true });
  }
  deadCache = out.filter((d) => !inMountainZone(d.x, d.z, 1.5));
  return deadCache;
}

export interface RootPlacement extends Placement {
  /** Radius of the owning trunk (m) so the root run starts at the buttress edge. */
  from: number;
}

/** Exposed root runs that creep from big trunks toward the trail and sink back into the soil. */
export function rootPlacements(): RootPlacement[] {
  const rng = makeRandom(515);
  const out: RootPlacement[] = [];
  for (const t of treePlacements()) {
    if (t.lod !== 'hi' || t.kind === 'slender') continue;
    const p = distanceToPath(t.x, t.z);
    if (p.dist > 11) continue;
    // Point the run roughly at the trail; vary a little.
    const np = nearestPathPoint(t.x, t.z);
    // yaw convention: the root run extends along local +Z, so world direction = (sin yaw, cos yaw).
    const yaw = Math.atan2(np[0] - t.x, np[1] - t.z) + (rng() - 0.5) * 0.9;
    const dist = t.colliderRadius * 0.9;
    const rx = t.x + Math.sin(yaw) * dist;
    const rz = t.z + Math.cos(yaw) * dist;
    if (distanceToPath(rx, rz).dist < p.halfWidth + 0.8) continue;
    out.push({ x: rx, y: terrainHeight(rx, rz), z: rz, yaw, scale: Math.max(0.8, Math.min(1.5, t.colliderRadius / 1.8)), variant: Math.floor(rng() * 3), tiltX: 0, tiltZ: 0, from: t.colliderRadius });
  }
  return out.filter((r) => !inMountainZone(r.x, r.z, 1));
}

function nearestPathPoint(x: number, z: number): readonly [number, number] {
  let best = Infinity;
  let bp: readonly [number, number] = PATH_SAMPLES[0];
  for (const s of PATH_SAMPLES) {
    const d = Math.hypot(s[0] - x, s[1] - z);
    if (d < best) {
      best = d;
      bp = s;
    }
  }
  return bp;
}

// ---------------------------------------------------------------------------
// Plants (clustered, band-driven)
// ---------------------------------------------------------------------------

export type PlantKind = 'fern' | 'treefern' | 'broadleaf' | 'shrub' | 'palm' | 'cover' | 'flowers' | 'moss' | 'litter' | 'reed' | 'pads' | 'meadow';

/** Variants per kind (assets: `fern-cluster-<0-2>`, `patch-<0-3>`, `<kind>-<variant>`; see tools/generate-scene.mjs). */
export const PLANT_VARIANTS: Record<PlantKind, number> = { fern: 3, treefern: 1, broadleaf: 3, shrub: 2, palm: 4, cover: 2, flowers: 1, moss: 1, litter: 1, reed: 2, pads: 1, meadow: 8 };

let solidCache: Solid[] | null = null;
/** Everything plants must keep out of: trunks, big rocks, logs, pillars, altar, temple, arch. */
export function solids(): Solid[] {
  if (solidCache) return solidCache;
  const out: Solid[] = [];
  for (const t of treePlacements()) out.push({ x: t.x, z: t.z, r: t.colliderRadius + 0.15, kind: 'tree' });
  for (const r of rockPlacements()) if (r.collider || r.scale > 0.9) out.push({ x: r.x, z: r.z, r: r.scale * 0.95, kind: 'rock' });
  for (const d of deadwoodPlacements()) if (d.kind === 'log') out.push({ x: d.x, z: d.z, r: d.length * 0.5, kind: 'log' });
  for (const p of PILLARS) out.push({ x: p.x, z: p.z, r: PILLAR_R + 0.5, kind: 'pillar' });
  out.push({ x: ALTAR[0], z: ALTAR[1], r: 1.5, kind: 'altar' });
  out.push({ x: TEMPLE.x, z: TEMPLE.z, r: TEMPLE.width * 0.52, kind: 'temple' });
  out.push({ x: ROOT_ARCH.x, z: ROOT_ARCH.z, r: 2.6 * ROOT_ARCH.scale, kind: 'arch' });
  out.push({ x: FALLEN_GIANT.x, z: FALLEN_GIANT.z, r: FALLEN_GIANT.length / 2, kind: 'log' });
  out.push({ x: SPIRE.x, z: SPIRE.z, r: SPIRE.r + 1.2, kind: 'temple' });
  solidCache = out;
  return out;
}

function blocked(x: number, z: number, pad: number): boolean {
  for (const s of solids()) if (Math.hypot(s.x - x, s.z - z) < s.r + pad) return true;
  return false;
}

interface Band {
  min: number;
  max: number;
}
const BANDS: Record<PlantKind, Band> = {
  cover: { min: 0.3, max: 2.6 },
  flowers: { min: 0.5, max: 12 },
  moss: { min: 0.6, max: 40 },
  litter: { min: 0.35, max: 40 },
  fern: { min: 0.9, max: 10 },
  treefern: { min: 2.5, max: 20 },
  broadleaf: { min: 2.4, max: 15 },
  shrub: { min: 3.2, max: 17 },
  palm: { min: 3.0, max: 18 },
  reed: { min: 0, max: 99 },
  pads: { min: 0, max: 99 },
  meadow: { min: 0, max: 99 },
};

/** Plant weights by area (entrance / trail / clearing) per kind. */
const AREA_MIX: Record<PlantKind, [number, number, number]> = {
  fern: [1.0, 0.9, 0.35],
  treefern: [0.5, 0.7, 0.1],
  broadleaf: [0.9, 0.9, 0.15],
  shrub: [0.8, 0.8, 0.1],
  palm: [0.8, 1.0, 0.45],
  cover: [0.7, 0.9, 1.2],
  flowers: [0.05, 0.25, 1.0],
  moss: [0.9, 0.9, 0.5],
  litter: [1.0, 0.9, 0.15],
  reed: [1, 1, 1],
  pads: [1, 1, 1],
  meadow: [1, 1, 1],
};

interface PlantRule {
  /** Target instance count (placement stops when reached or the search budget is spent). */
  target: number;
  per: [number, number];
  spread: number;
  scale: [number, number];
  seed: number;
  /** Extra clearance from solids (m). */
  pad: number;
}
const RULES: Record<Exclude<PlantKind, 'reed' | 'pads' | 'meadow'>, PlantRule> = {
  fern: { target: 80, per: [1, 3], spread: 2.6, scale: [0.9, 1.14], seed: 11, pad: 0.3 },
  treefern: { target: 14, per: [1, 2], spread: 2.0, scale: [0.9, 1.1], seed: 12, pad: 1.0 },
  // heliconia / banana / alocasia: real plants are 2-5 m; the prototypes are 1.6-2.4 m, so they are placed at 1.25-1.5x
  broadleaf: { target: 90, per: [2, 4], spread: 2.4, scale: [1.25, 1.5], seed: 22, pad: 0.8 },
  shrub: { target: 55, per: [1, 3], spread: 2.0, scale: [0.9, 1.15], seed: 33, pad: 0.6 },
  palm: { target: 40, per: [1, 3], spread: 2.8, scale: [0.9, 1.12], seed: 66, pad: 0.8 },
  cover: { target: 110, per: [1, 3], spread: 2.0, scale: [0.9, 1.15], seed: 44, pad: 0.1 },
  flowers: { target: 46, per: [1, 3], spread: 1.8, scale: [0.9, 1.1], seed: 77, pad: 0.1 },
  moss: { target: 46, per: [1, 2], spread: 1.6, scale: [0.9, 1.2], seed: 88, pad: 0.0 },
  litter: { target: 64, per: [1, 2], spread: 2.4, scale: [0.9, 1.2], seed: 99, pad: 0.0 },
};

const plantCache = new Map<PlantKind, Placement[]>();

export function plantPlacements(kind: PlantKind): Placement[] {
  const hit = plantCache.get(kind);
  if (hit) return hit;
  const res = computePlants(kind);
  plantCache.set(kind, res);
  return res;
}

function computePlants(kind: PlantKind): Placement[] {
  if (kind === 'reed') return reedPlacements();
  if (kind === 'pads') return padPlacements();
  if (kind === 'meadow') return meadowPlacements();
  const rule = RULES[kind];
  const rng = makeRandom(rule.seed);
  const band = BANDS[kind];
  const mix = AREA_MIX[kind];
  const out: Placement[] = [];
  let guard = 0;
  while (out.length < rule.target && guard++ < 90000) {
    const cx = -46 + rng() * 92;
    const cz = -92 + rng() * 128;
    if (walkMetric(cx, cz) > 1.12) continue;
    const a = areaWeights(cx, cz);
    const w = a.entrance * mix[0] + a.trail * mix[1] + a.clearing * mix[2];
    const wet = wetness(cx, cz);
    const dens = Math.min(1.3, vegetationDensity(cx, cz) + (kind === 'moss' || kind === 'fern' || kind === 'treefern' ? wet * 0.4 : 0));
    const sparse = kind === 'cover' || kind === 'flowers' || kind === 'moss' || kind === 'litter';
    if (rng() > Math.min(1, w * (sparse ? 0.45 + dens * 0.5 : 0.1 + dens * 0.9))) continue;
    const n = Math.round(rule.per[0] + rng() * (rule.per[1] - rule.per[0]));
    for (let i = 0; i < n; i++) {
      const ang = rng() * TAU;
      const r = Math.sqrt(rng()) * rule.spread;
      const x = cx + Math.cos(ang) * r;
      const z = cz + Math.sin(ang) * r;
      const p = distanceToPath(x, z);
      const edge = p.dist - p.halfWidth;
      if (edge < band.min || edge > band.max) continue;
      if (Math.hypot(x - SPAWN[0], z - SPAWN[1]) < (sparse ? 1.2 : 3.6)) continue;
      // moss mats and leaf litter are forest-floor details: on the sunlit knoll meadow they read as plaid patches and stray brown leaves
      if ((kind === 'moss' || kind === 'litter') && hillWeight(x, z) > 0.3) continue;
      // the vista window stays open: nothing taller than a fern in the fan of sight from the knoll to the waterfall (a tree fern or palm 5 m in front of the eye hides the view)
      if ((kind === 'treefern' || kind === 'palm' || kind === 'broadleaf' || kind === 'shrub') && inVistaFan(x, z, 1.5)) continue;
      if (distanceToStream(x, z) < (kind === 'moss' ? 0.2 : 1.0) && kind !== 'litter') continue; // keep the water itself clear
      if (Math.hypot(x - POOL.x, z - POOL.z) < POOL.r * 1.05) continue;
      if (MUD_PATCHES.some((m) => Math.hypot(m.x - x, m.z - z) < m.r * 0.9)) continue;
      if (blocked(x, z, rule.pad)) continue;
      // Fern size follows distance from the trail: small at the edge, large deep in.
      const pl = at(x, z, rng, rule.scale[0], rule.scale[1], PLANT_VARIANTS[kind]);
      if (kind === 'fern') {
        const size = edge < 2.2 ? 0 : edge < 5.5 ? 1 : 2; // S, M, L
        pl.variant = size;
      }
      out.push(pl);
    }
  }
  return out.filter((p) => !inMountainZone(p.x, p.z, 0.3));
}

function reedPlacements(): Placement[] {
  const rng = makeRandom(55);
  const out: Placement[] = [];
  // Pool: dense on the shallow south/east side, thin at the cascade.
  for (let i = 0; i < 50; i++) {
    const a = rng() * TAU;
    const r = POOL.r * (1.0 + 0.4 * rng());
    const x = POOL.x + Math.cos(a) * r;
    const z = POOL.z + Math.sin(a) * r;
    if (distanceToPath(x, z).dist < 1.5 || blocked(x, z, 0.1)) continue;
    out.push(at(x, z, rng, 0.75, 0.95, 2));
  }
  // Stream: clumps on the banks.
  for (let i = 3; i < STREAM_SAMPLES.length - 1; i += 2) {
    const [sx, sz] = STREAM_SAMPLES[i];
    for (const side of [-1, 1]) {
      if (rng() > 0.55) continue;
      const x = sx + (rng() - 0.5) * 0.8;
      const z = sz + side * (1.1 + rng() * 0.5);
      if (distanceToPath(x, z).dist < 1.6 || blocked(x, z, 0.1)) continue;
      out.push(at(x, z, rng, 0.7, 0.9, 2));
    }
  }
  return out;
}

function padPlacements(): Placement[] {
  const rng = makeRandom(56);
  const out: Placement[] = [];
  for (let i = 0; i < 9; i++) {
    const a = rng() * TAU;
    const r = Math.sqrt(rng()) * POOL.r * 0.8;
    const x = POOL.x + Math.cos(a) * r;
    const z = POOL.z + Math.sin(a) * r;
    out.push({ x, y: POOL.waterY + 0.015, z, yaw: rng() * TAU, scale: 0.9 + rng() * 0.3, variant: Math.floor(rng() * 2), tiltX: 0, tiltZ: 0 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Occluders (terrain AO bake) and light shafts
// ---------------------------------------------------------------------------

/** Circles that darken the ground around them (baked into terrain vertex colours). */
export function groundOccluders(): { x: number; z: number; r: number }[] {
  const out: { x: number; z: number; r: number }[] = [];
  for (const t of treePlacements()) out.push({ x: t.x, z: t.z, r: t.colliderRadius * 0.85 });
  for (const r of rockPlacements()) if (!r.noAO) out.push({ x: r.x, z: r.z, r: r.scale * 0.8 });
  for (const d of deadwoodPlacements()) if (d.kind === 'log') out.push({ x: d.x, z: d.z, r: d.length * 0.3 });
  for (const s of solids()) if (s.kind === 'temple' || s.kind === 'pillar' || s.kind === 'altar' || s.kind === 'arch') out.push({ x: s.x, z: s.z, r: s.r * 0.7 });
  return out;
}

export interface ShaftSpec {
  x: number;
  z: number;
  w: number;
  len: number;
  strength: number;
}

/**
 * Light shafts sit where the canopy is actually open: candidates beside the
 * trail, scored by distance to the nearest trunk, spaced apart, spread across
 * the three areas. They lean along -SUN_DIR (the sun's real direction).
 */
export function lightShafts(): ShaftSpec[] {
  const trees = treePlacements();
  const cands: (ShaftSpec & { score: number })[] = [];
  for (let i = 4; i < PATH_SAMPLES.length - 4; i += 5) {
    const [px, pz] = PATH_SAMPLES[i];
    const [qx, qz] = PATH_SAMPLES[i + 1];
    const tl = Math.hypot(qx - px, qz - pz) || 1;
    const sx = -(qz - pz) / tl;
    const sz = (qx - px) / tl;
    for (const off of [-5.5, -3.8, 3.8, 5.5]) {
      const x = px + sx * off;
      const z = pz + sz * off;
      if (distanceToStream(x, z) < 1.5 || blocked(x, z, 0.5)) continue;
      // never on the knoll meadow: a beam rising from the player's feet toward the player would stab through the view
      if (hillWeight(x, z) > 0.25) continue;
      let nearest = 99;
      for (const t of trees) nearest = Math.min(nearest, Math.hypot(t.x - x, t.z - z) - t.colliderRadius);
      const a = areaWeights(x, z);
      const clearing = a.clearing > 0.5;
      // Shafts rise toward the sun side: bias beams whose base is west of the trail so they cross it.
      const sunSide = off < 0 ? 1 : 0.8;
      // A lower sun lays the beam over: stretch it so it keeps (about) the same rise (reference sun: sin(elevation) = 0.755)
      const lenK = Math.min(1.3, 0.755 / SUN_TO[1]);
      cands.push({ x, z, w: 2.6 + (nearest > 3 ? 1.0 : 0), len: (clearing ? 20 : 15 + Math.min(6, nearest)) * lenK, strength: clearing ? 0.8 : 1, score: Math.min(nearest, 9) * sunSide });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  const picked: ShaftSpec[] = [];
  for (const c of cands) {
    if (picked.length >= 9) break;
    if (picked.some((p) => Math.hypot(p.x - c.x, p.z - c.z) < 9.5)) continue;
    picked.push({ x: c.x, z: c.z, w: c.w, len: c.len, strength: c.strength });
  }
  void SUN_DIR;
  return picked.filter((s) => !inMountainZone(s.x, s.z, 3));
}

/**
 * VISTA SHAFTS: five long, slim beams standing 25-60 m out in the +-50 degree cone around the line from the knoll to the waterfall, so the 8.7 m
 * eye looks over sunlit air between the far trunks. They are baked into the same merged mesh as the trail shafts (name 'Light shafts': hidden in the
 * LOW tier) and cost 5 x 96 triangles with the coarse unit shaft. `strength` scales the width (w x strength = 2.4-4 m), never the brightness, so
 * they are as faint as the trail shafts. The centre of the view (the fall itself, +-9 degrees) stays clear: five slots, none in front of the fall.
 * Rejected: bases on a solid, in a stream, within 1.2 m of a trunk (a beam is soft and depth-tested: the trunks in front of it simply hide it), on the knoll meadow, or whose upper end would hang within 14 m of the
 * spawn (the beams lean toward the viewer; they must pass well beside and above the player's head).
 */
export function vistaShafts(): ShaftSpec[] {
  const trees = treePlacements();
  const rnd = makeRandom(60417);
  const bearing0 = (Math.atan2(VISTA.fallFoot[0] - SPAWN[0], -(VISTA.fallFoot[1] - SPAWN[1])) * 180) / Math.PI;
  const slots = [-46, -32, -18, 17, 26]; // degrees from the line to the fall (+ = right); the east side is the world's edge (x > 18), so it gets fewer
  const out: ShaftSpec[] = [];
  for (const slot of slots) {
    let best: (ShaftSpec & { score: number }) | null = null;
    for (let attempt = 0; attempt < 80; attempt++) {
      const bearing = ((bearing0 + slot + (rnd() - 0.5) * 12) * Math.PI) / 180;
      const dist = 25 + rnd() * 35;
      const x = SPAWN[0] + Math.sin(bearing) * dist;
      const z = SPAWN[1] - Math.cos(bearing) * dist;
      if (x > 15 || x < -48 || !walkableForShaft(x, z) || hillWeight(x, z) > 0.25) continue; // stay inside the jungle's drawn ground
      let nearest = 99;
      for (const t of trees) nearest = Math.min(nearest, Math.hypot(t.x - x, t.z - z) - t.colliderRadius);
      if (nearest < 1.2) continue;
      const w = 5 + rnd() * 3; // 5-8
      const strength = 0.4 + rnd() * 0.1; // <= 0.5
      let len = 28 + rnd() * 12; // 28-40
      // keep the upper end of the beam clear of the player's head
      while (len >= 28 && Math.hypot(x + SUN_TO[0] * len - SPAWN[0], z + SUN_TO[2] * len - SPAWN[1]) < 14) len -= 2;
      if (len < 28) continue;
      const score = Math.min(nearest, 8) + rnd();
      if (!best || score > best.score) best = { x, z, w, len, strength, score };
    }
    if (best) out.push({ x: best.x, z: best.z, w: best.w, len: best.len, strength: best.strength });
  }
  return out;
}

/** A shaft base may stand on open ground only: not on a solid (trunk, ruin, rock), not in or beside a stream, not in the mountain zone. */
function walkableForShaft(x: number, z: number): boolean {
  return !blocked(x, z, 0.8) && distanceToStream(x, z) >= 2 && !inMountainZone(x, z, 3);
}


// ---------------------------------------------------------------------------
// The welcome lectern (composition-intro)
// ---------------------------------------------------------------------------
import { SPAWN_YAW_DEG } from './layout.ts';

/**
 * Where the welcome board stands on the knoll: 70 degrees to the right of the heading, 2.3 m out, so it never blocks the view of the fall and is found by turning
 * the head (not the body). `faceYaw` turns its front (local +Z) toward the start point.
 */
export function lecternSpot(): { x: number; z: number; faceYaw: number; stoneX: number; stoneZ: number } {
  const yaw = (SPAWN_YAW_DEG * Math.PI) / 180;
  // heading (forward) and right vectors for a rig yawed by `yaw` about +Y (forward = -Z at yaw 0)
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  const a = (70 * Math.PI) / 180;
  const d = 2.3;
  const dx = fx * Math.cos(a) + rx * Math.sin(a);
  const dz = fz * Math.cos(a) + rz * Math.sin(a);
  const x = SPAWN[0] + dx * d;
  const z = SPAWN[1] + dz * d;
  return { x, z, faceYaw: Math.atan2(-dx, -dz), stoneX: x + dx * 0.4, stoneZ: z + dz * 0.4 };
}

/**
 * The standing stone behind the welcome board (a rock placement like the others: same 'standing' mesh, so no new triangles beyond one more instance).
 * NOT included in rockPlacements() by itself: the integrator appends it there (`out.push(lecternStone())`, after the lookout ring) so that the baked
 * rock list and the validator all see it. It is deliberately NOT a collider: it stands 2.7 m from SPAWN, which tools/validate-scene.mjs rejects for colliders
 * (a collider within 3 m + radius of the spawn); the player can step through it, which is harmless for a 0.9 m stone behind the board.
 */
export function lecternStone(): RockPlacement {
  const s = 0.95;
  const { stoneX, stoneZ, faceYaw } = lecternSpot();
  return { x: stoneX, y: terrainHeight(stoneX, stoneZ) - 0.55 * s * 0.5, z: stoneZ, yaw: faceYaw, scale: s, variant: 0, tiltX: 0, tiltZ: 0, kind: 'standing', collider: false, wet: false };
}


// ---------------------------------------------------------------------------
// Overlook Knoll dressing: lookout stone, parapet boulders, sandstone monoliths, pebbles, and the wind-swept meadow
// ---------------------------------------------------------------------------

/** Point `a` metres ahead of the start (along the heading) and `b` metres to the right. */
function knollSpot(a: number, b: number): [number, number] {
  return [SPAWN[0] + KNOLL_FORWARD[0] * a + KNOLL_RIGHT[0] * b, SPAWN[1] + KNOLL_FORWARD[1] * a + KNOLL_RIGHT[1] * b];
}

/** Where the worn lookout stone lies: centred 0.35 m ahead of the standing place, so both feet are on it. */
export function lookoutStoneSpot(): [number, number] {
  return knollSpot(0.35, 0);
}

/**
 * The foreground of the view, appended to rockPlacements() (own seed 8818: nothing above re-rolls):
 *  - the lookout stone under the start (flush, pale, no collider),
 *  - three parapet boulders 6-9 m ahead on either side of the line of sight (low: they sit below the horizon of the 8.7 m eye, so they frame the descent
 *    and give the foreground scale without ever touching the fall),
 *  - two sandstone monoliths (7.0 and 5.6 m, true size, colliders) either side of the gate window at about +-30 degrees, 15-17 m out: they frame the
 *    portal to the fall like a doorway and give the whole vista a scale reference,
 *  - a little drift of sun-bleached pebbles beside the stone.
 * Everything keeps the 1.8 m trail lane and the 3 m clear circle around the standing place (checked by tools/validate-scene.mjs).
 */
function knollDressing(out: RockPlacement[], free: (x: number, z: number, r: number) => boolean): void {
  const rk = makeRandom(8818);
  const put = (x: number, z: number, kind: RockKind, s: number, variant: number, collider: boolean, sinkM: number, opts: { tilt?: boolean; noAO?: boolean } = {}): RockPlacement | null => {
    if (collider && (!free(x, z, s) || distanceToPath(x, z).dist < s * 0.95 + 1.3)) return null;
    const p = at(x, z, rk, s, s, 1, opts.tilt ?? true);
    p.y -= sinkM;
    const rp: RockPlacement = { ...p, kind, collider, wet: false, fixedVariant: variant, noAO: opts.noAO };
    out.push(rp);
    return rp;
  };
  // the stone under the start
  {
    const [x, z] = lookoutStoneSpot();
    const p = at(x, z, rk, 0.95, 0.95, 1, true);
    // the dome is ~0.16 m at scale 1; sink it until 4 cm show
    out.push({ ...p, y: p.y - 0.11, kind: 'slab', collider: false, wet: false, fixedVariant: 2, noAO: true });
  }
  // parapet boulders: beside the line of sight, below the eye's horizon
  const parapets: [number, number, number, number][] = [
    [6.6, -3.9, 1.1, 2],
    [8.0, 4.4, 0.95, 3],
    [10.8, -6.4, 1.25, 3],
  ];
  for (const [a, b, s, v] of parapets) {
    const [x, z] = knollSpot(a + (rk() - 0.5) * 0.6, b + (rk() - 0.5) * 0.6);
    put(x, z, 'boulder', s, v, true, 0.3 * s * 0.5);
  }
  // monoliths: upright (no ground tilt), buried 0.15 m on top of the 0.6 m the prototype already hides
  const monoliths: [number, number, number][] = [
    [15.5, -9.2, 2],
    [17.5, 10.2, 3],
  ];
  for (const [a, b, v] of monoliths) {
    const [x, z] = knollSpot(a, b);
    put(x, z, 'standing', MONOLITH_SCALE * (0.97 + 0.06 * rk()), v, true, 0.15, { tilt: false });
  }
  // pebbles around the stone, on the sides away from the welcome board (which stands to the right)
  for (let i = 0; i < 12; i++) {
    const ang = (110 + 250 * rk()) * (Math.PI / 180); // 0 = ahead, positive = to the right: so 110..360 skips the front-right quadrant of the board
    const rad = 0.95 + 0.9 * rk();
    const [x, z] = knollSpot(0.35 + Math.cos(ang) * rad, Math.sin(ang) * rad);
    const s = 0.1 + 0.12 * rk();
    put(x, z, 'cobble', s, 2 + (i % 2), false, 0.35 * s * 0.5, { noAO: true });
  }
}

/** Yaw (about +Y) that points a prototype's local +Z along the world direction (dx, dz). */
const yawToward = (dx: number, dz: number): number => Math.atan2(dx, dz);

/**
 * The knoll meadow (`PlantKind` 'meadow', prototypes `meadow-tuft-<0-3>` and `meadow-flowers-<0-3>`; variant 0-3 = tufts, 4-7 = flowers):
 *  - tufts: a jittered grid thinned by `meadowTuftDensity` (thin at the standing place, full from 9 m, gone by 24 m, fewer behind), yawed so that their
 *    lean follows the wind, gold ones where the ground is curing straw and far ones (single-triangle blades) beyond 12 m,
 *  - flowers: clumps on their own drifts (`meadowFields().drift`), one dominant colour per drift, the amber accent rare, yawed so the heads face the sun.
 * Seeds 7301 / 7302 are private, so no other placement list changes. Keeps off the dirt trail, the lookout stone, the welcome board and every solid.
 */
function meadowPlacements(): Placement[] {
  const out: Placement[] = [];
  const lect = lecternSpot();
  const [lx, lz] = lookoutStoneSpot();
  const keepOut = (x: number, z: number): boolean => Math.hypot(x - lx, z - lz) < 1.7 || Math.hypot(x - lect.x, z - lect.z) < 1.5 || Math.hypot(x - lect.stoneX, z - lect.stoneZ) < 1.4 || blocked(x, z, 0.15);
  const windYaw = yawToward(MEADOW_WIND[0], MEADOW_WIND[1]);
  const sunYaw = yawToward(-SUN_DIR[0], -SUN_DIR[2]);

  const rng = makeRandom(7301);
  const step = 0.95;
  for (let gx = SPAWN[0] - 25; gx <= SPAWN[0] + 25; gx += step) {
    for (let gz = SPAWN[1] - 25; gz <= SPAWN[1] + 25; gz += step) {
      const x = gx + (rng() - 0.5) * step;
      const z = gz + (rng() - 0.5) * step;
      const dens = meadowTuftDensity(x, z);
      const roll = rng();
      if (dens <= 0 || roll > dens * step * step) continue;
      if (keepOut(x, z)) continue;
      const f = meadowFields(x, z);
      const d = Math.hypot(x - SPAWN[0], z - SPAWN[1]);
      const gold = rng() < f.straw * 1.15 ? 1 : 0;
      const p = at(x, z, rng, 0.85, 1.25, 1);
      p.scale *= 0.92 + 0.16 * f.lush;
      p.yaw = windYaw + (rng() - 0.5) * 0.9;
      p.variant = gold + (d > 12 ? 2 : 0);
      out.push(p);
    }
  }

  const rf = makeRandom(7302);
  const stepF = 1.35;
  for (let gx = SPAWN[0] - 22; gx <= SPAWN[0] + 22; gx += stepF) {
    for (let gz = SPAWN[1] - 22; gz <= SPAWN[1] + 22; gz += stepF) {
      const x = gx + (rf() - 0.5) * stepF;
      const z = gz + (rf() - 0.5) * stepF;
      const dx = x - SPAWN[0];
      const dz = z - SPAWN[1];
      const d = Math.hypot(dx, dz);
      const roll = rf();
      const colour = rf();
      const accent = rf();
      if (d < 2.4 || d > 21) continue;
      const hw = meadowTuftDensity(x, z) > 0 ? 1 : 0; // inside the meadow (on the grass, off the trail)
      if (!hw) continue;
      const f = meadowFields(x, z);
      const front = 0.65 + 0.35 * smoothstep(-0.5, 0.4, (dx * KNOLL_FORWARD[0] + dz * KNOLL_FORWARD[1]) / d);
      if (roll > f.drift * 0.9 * front * (1 - 0.35 * smoothstep(12, 21, d))) continue;
      if (keepOut(x, z)) continue;
      // one dominant colour per drift (a slow noise), the warm accent in about one clump in twelve
      const hue = fbm(x * 0.07 + 5, z * 0.07, 48, 2);
      let v = hue < 0.44 ? 0 : hue < 0.56 ? 1 : 2;
      if (accent < 0.12) v = 3;
      const p = at(x, z, rf, 0.9, 1.2, 1);
      p.yaw = sunYaw + (rf() - 0.5) * 0.9;
      p.variant = 4 + v;
      out.push(p);
    }
  }
  return out;
}

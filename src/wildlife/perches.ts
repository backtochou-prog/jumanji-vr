/**
 * Where animals can sit, and the obstacles they must fly around. Pure data (no three.js objects, no DOM): derived from the SAME placement
 * lists, curves and constants the meshes are built from, so a perch is on a real branch, not near one.
 *
 *   - tree boughs        trees.scene-asset `treePerches(kind)` (tree-local) -> world through the placement (position, yaw, scale)
 *   - entrance limb      trees.scene-asset `entranceLimbCurve()`
 *   - fallen giant       layout.FALLEN_GIANT (axis along the log, top of the trunk)
 *   - ruined pillar      layout.PILLARS[0] (the one with an intact capital)
 * Every perch carries its ground height so "how high up" is known without another terrain lookup.
 */
import { CatmullRomCurve3, Vector3 } from '@iwsdk/core';
import { entranceLimbCurve, treePerches, trunkAxisAt } from '../scene-assets/trees.scene-asset.js';
import { FALLEN_GIANT, PILLARS, SCALE, SPIRE, TEMPLE, terrainHeight } from '../world/layout.js';
import { TREE_VARIANTS, treePlacements } from '../world/placements.js';

export type PerchKind = 'bough' | 'limb' | 'log' | 'pillar';

export interface Perch {
  id: number;
  x: number;
  y: number;
  z: number;
  /** Horizontal direction of the branch / log axis at the perch (unit). */
  dx: number;
  dz: number;
  /** Radius of the branch (m). */
  r: number;
  kind: PerchKind;
  /** Perches with the same group are on the same tree/structure (a climb, not a leap, joins them). */
  group: number;
  /** Height above the terrain (m). */
  above: number;
  /** For tree perches: the trunk axis at this height (monkeys climb along it). */
  ax: number;
  az: number;
  /** Axis radius of the supporting trunk at this height (m, approximate). */
  trunkR: number;
}

export interface Obstacle {
  x: number;
  z: number;
  r: number;
  /** Height of the obstacle top (m above terrain): flights above it are clear. */
  top: number;
}

let perchList: Perch[] | null = null;
const CELL = 12;
let obstacleGrid: Map<number, number[]> | null = null;
let seatGrid: Map<number, number[]> | null = null;
const gkey = (ix: number, iz: number) => ix * 4096 + iz;
let obstacleList: Obstacle[] | null = null;
let neighbourList: number[][] | null = null;

const v = new Vector3();

function addTreePerches(out: Perch[], obstacles: Obstacle[]): void {
  const trees = treePlacements();
  trees.forEach((t, ti) => {
    // above the buttresses a trunk is ~55 % of its footprint radius; the footprint is a ground-level quantity
    obstacles.push({ x: t.x, z: t.z, r: t.colliderRadius * 0.55 + 0.5, top: 60 * t.scale });
    const c = Math.cos(t.yaw);
    const s = Math.sin(t.yaw);
    for (const p of treePerches(t.kind)) {
      // yaw about +Y (three.js): x' = x cos + z sin, z' = -x sin + z cos
      const lx = p.x * t.scale;
      const lz = p.z * t.scale;
      const wx = t.x + lx * c + lz * s;
      const wz = t.z - lx * s + lz * c;
      const dx = p.dx * c + p.dz * s;
      const dz = -p.dx * s + p.dz * c;
      const y = t.y + p.y * t.scale;
      // the trunk axis and radius at the bough's height, for the variant that is drawn near the player
      const tr = trunkAxisAt(t.kind, t.variant % TREE_VARIANTS[t.kind], p.y - 0.4);
      out.push({
        id: out.length,
        x: wx,
        y,
        z: wz,
        dx,
        dz,
        r: p.r * t.scale,
        kind: 'bough',
        group: ti,
        above: y - terrainHeight(wx, wz),
        ax: t.x + (tr.x * c + tr.z * s) * t.scale,
        az: t.z + (-tr.x * s + tr.z * c) * t.scale,
        trunkR: tr.r * t.scale,
      });
    }
  });
}

function addStructurePerches(out: Perch[], obstacles: Obstacle[]): void {
  // entrance limb: the overhead bridge between the gate trees (17-19 m up)
  {
    const { pts, radius } = entranceLimbCurve();
    const curve = new CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
    const group = 1000;
    for (const t of [0.18, 0.3, 0.42, 0.54, 0.66, 0.78]) {
      curve.getPointAt(t, v);
      const tan = curve.getTangentAt(t);
      const h = Math.hypot(tan.x, tan.z) || 1;
      out.push({ id: out.length, x: v.x, y: v.y + radius(t), z: v.z, dx: tan.x / h, dz: tan.z / h, r: radius(t), kind: 'limb', group, above: v.y - terrainHeight(v.x, v.z), ax: v.x, az: v.z, trunkR: 0.6 });
    }
  }
  // the fallen giant: the log's axis runs along (cos yaw, -sin yaw); the node sits so the axis is 0.55 * (radius / 0.85) above the ground
  {
    const g = FALLEN_GIANT;
    const axisY = terrainHeight(g.x, g.z) + 0.55 * (g.radius / 0.85);
    const dx = Math.cos(g.yaw);
    const dz = -Math.sin(g.yaw);
    for (const k of [-0.3, -0.12, 0.06, 0.24, 0.38]) {
      const px = g.x + dx * g.length * k;
      const pz = g.z + dz * g.length * k;
      out.push({ id: out.length, x: px, y: axisY + g.radius * 0.97, z: pz, dx, dz, r: g.radius, kind: 'log', group: 1001, above: axisY + g.radius * 0.97 - terrainHeight(px, pz), ax: px, az: pz, trunkR: g.radius });
    }
  }
  // the intact pillar's capital
  {
    const p = PILLARS[0];
    const y = terrainHeight(p.x, p.z) - 0.05 * SCALE.pillar + p.h + 0.2 * SCALE.pillar;
    out.push({ id: out.length, x: p.x, y, z: p.z, dx: 1, dz: 0, r: 0.5 * SCALE.pillar, kind: 'pillar', group: 1002, above: y - terrainHeight(p.x, p.z), ax: p.x, az: p.z, trunkR: 0.5 });
  }
  // big solids
  obstacles.push({ x: SPIRE.x, z: SPIRE.z, r: SPIRE.r + 1.2, top: SPIRE.h });
  obstacles.push({ x: TEMPLE.x, z: TEMPLE.z, r: TEMPLE.width * 0.5 + 1, top: 16.5 });
  for (const p of PILLARS) obstacles.push({ x: p.x, z: p.z, r: 1.3 * SCALE.pillar * 0.6, top: p.h + 0.6 });
}

/** Every perch in the jungle (computed once). */
export function perches(): Perch[] {
  if (perchList) return perchList;
  const out: Perch[] = [];
  const obstacles: Obstacle[] = [];
  addTreePerches(out, obstacles);
  addStructurePerches(out, obstacles);
  perchList = out;
  obstacleList = obstacles;
  // drop the boughs that reach into a NEIGHBOURING trunk (an animal there would sit inside the other tree), then renumber
  const keep = out.filter((p) => !(p.kind === 'bough' && blockedAt(p.x, p.y, p.z, -0.4, p.group)));
  keep.forEach((p, i) => (p.id = i));
  perchList = keep;
  // spatial indices: obstacles (each registered in every cell its disc touches) and perches
  const push = (map: Map<number, number[]>, key: number, v: number): void => {
    const c = map.get(key);
    if (c) c.push(v);
    else map.set(key, [v]);
  };
  const og = new Map<number, number[]>();
  obstacles.forEach((o, i) => {
    const x0 = Math.floor((o.x - o.r - 1.5) / CELL);
    const x1 = Math.floor((o.x + o.r + 1.5) / CELL);
    const z0 = Math.floor((o.z - o.r - 1.5) / CELL);
    const z1 = Math.floor((o.z + o.r + 1.5) / CELL);
    for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) push(og, gkey(ix, iz), i);
  });
  const sg = new Map<number, number[]>();
  for (const p of keep) push(sg, gkey(Math.floor(p.x / CELL), Math.floor(p.z / CELL)), p.id);
  obstacleGrid = og;
  seatGrid = sg;
  return keep;
}

export function obstacles(): Obstacle[] {
  perches();
  return obstacleList!;
}

/** Is the point inside a trunk / spire / temple column at this height? `pad` widens every obstacle (negative shrinks). */
export function blockedAt(x: number, y: number, z: number, pad = 0.6, ignoreIndex = -1): boolean {
  const list = obstacles();
  // before the grid exists (during construction) fall back to the full list
  const cell = obstacleGrid?.get(gkey(Math.floor(x / CELL), Math.floor(z / CELL)));
  const n = cell ? cell.length : list.length;
  for (let k = 0; k < n; k++) {
    const i = cell ? cell[k] : k;
    if (i === ignoreIndex) continue;
    const o = list[i];
    const dx = x - o.x;
    const dz = z - o.z;
    const r = o.r + pad;
    if (r > 0 && dx * dx + dz * dz < r * r && y - terrainHeight(o.x, o.z) < o.top) return true;
  }
  return false;
}

/**
 * Is the straight flight a -> b free of trunks and ruins? Samples every ~2 m; the trees at either end (`ignoreA`, `ignoreB`: obstacle indices)
 * are ignored within a few metres of the endpoint, where the bird is by definition next to its own tree.
 */
export function flightClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number, pad = 0.9, ignoreA = -1, ignoreB = -1): boolean {
  const len = Math.hypot(bx - ax, by - ay, bz - az);
  const n = Math.max(2, Math.ceil(len / 2));
  const list = obstacles();
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const nearEnd = t * len < 6 || (1 - t) * len < 6;
    const x = ax + (bx - ax) * t;
    const y = ay + (by - ay) * t;
    const z = az + (bz - az) * t;
    const cell = obstacleGrid!.get(gkey(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!cell) continue;
    for (let k = 0; k < cell.length; k++) {
      const q = cell[k];
      if (nearEnd && (q === ignoreA || q === ignoreB)) continue;
      const o = list[q];
      const dx = x - o.x;
      const dz = z - o.z;
      const r = o.r + pad;
      if (dx * dx + dz * dz < r * r && y - terrainHeight(o.x, o.z) < o.top) return false;
    }
  }
  return true;
}

/** Ids of the perches within `r` metres (horizontally) of (x, z). Allocates: call it at decisions (a flush), not every frame. */
export function perchesNear(x: number, z: number, r: number): number[] {
  perches();
  const out: number[] = [];
  const x0 = Math.floor((x - r) / CELL);
  const x1 = Math.floor((x + r) / CELL);
  const z0 = Math.floor((z - r) / CELL);
  const z1 = Math.floor((z + r) / CELL);
  const list = perchList!;
  for (let ix = x0; ix <= x1; ix++)
    for (let iz = z0; iz <= z1; iz++) {
      const c = seatGrid!.get(gkey(ix, iz));
      if (!c) continue;
      for (const id of c) if (Math.hypot(list[id].x - x, list[id].z - z) <= r) out.push(id);
    }
  return out;
}

/** Index in `obstacles()` of the tree a tree perch belongs to (trees are the first obstacles, in placement order). */
export const obstacleOf = (p: Perch): number => (p.group < 1000 ? p.group : -1);

/**
 * Movement graph for climbing animals: for each perch, the perches an animal can reach in one move (a walk along the same branch, a climb
 * along the same trunk, a leap of up to LEAP_MAX across to a neighbouring tree). Sorted by distance, at most 8 each.
 */
export const LEAP_MAX = 6.5;
export function neighbours(): number[][] {
  if (neighbourList) return neighbourList;
  const list = perches();
  const grid = new Map<number, number[]>();
  const key = (x: number, z: number) => Math.floor(x / 8) * 4096 + Math.floor(z / 8);
  for (const p of list) {
    const k = key(p.x, p.z);
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(p.id);
  }
  const out: number[][] = [];
  for (const p of list) {
    const cand: { id: number; d: number }[] = [];
    for (let gx = -1; gx <= 1; gx++)
      for (let gz = -1; gz <= 1; gz++) {
        const cell = grid.get(Math.floor(p.x / 8 + gx) * 4096 + Math.floor(p.z / 8 + gz));
        if (!cell) continue;
        for (const id of cell) {
          if (id === p.id) continue;
          const q = list[id];
          const d = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
          const same = q.group === p.group;
          // same tree: a climb up to 12 m; different tree: a leap that is not much uphill
          if (same ? d < 12 : d <= LEAP_MAX && q.y - p.y < 2.2) cand.push({ id, d });
        }
      }
    cand.sort((a, b) => a.d - b.d);
    out.push(cand.slice(0, 8).map((c) => c.id));
  }
  neighbourList = out;
  return out;
}

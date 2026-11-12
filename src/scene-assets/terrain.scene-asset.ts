/**
 * Terrain and trail (Prompt 02).
 *
 * - The ground is split into 4x4 TILES. Each tile is its own mesh, so frustum
 *   culling skips whole tiles, and tiles near the trail are finer (1 m cells)
 *   than far ones (2-4 m). Skirts hide the cracks between different
 *   resolutions. Heights/normals come from one seamless height grid.
 * - Colour is a vertex-colour SPLAT of the palette: grass / moss / soil /
 *   leaf litter / stone / mud, driven by canopy openness, wetness, slope and
 *   noise, plus per-area grading (cool entrance, neutral trail, warm clearing)
 *   and baked ambient occlusion around trunks, rocks, roots and logs.
 * - The trail is a ribbon draped on the terrain whose edges dissolve into the
 *   surrounding splat (no hard outline), with mud patches and worn centre.
 * Both use ONE material (`groundMaterial`, anti-tiling albedo).
 */
import { BufferGeometry, Color, CylinderGeometry, DodecahedronGeometry, Float32BufferAttribute, Group, Mesh, PlaneGeometry, Uint32BufferAttribute } from '@iwsdk/core';
import {
  EV,
  EVEREST_LOD,
  MTN,
  MUD_PATCHES,
  TERRAIN_LOD,
  PATH_SAMPLES,
  TERRAIN,
  areaWeights,
  hillWeight,
  distanceToPath,
  fbm,
  groundBlend,
  pathHalfWidth,
  smoothstep,
  terrainHeight,
} from '../world/layout.js';
import { GEO, MTN_MUD, VALLEY, fallWetness, mountainTiles, mountainWeight, routeNear } from '../world/mountain.js';
import { EVEREST, EVEREST_CAIRN, everestSnowAt, everestTiles, everestWeight } from '../world/everest.js';
import { MEADOW, PAL, SUN_DIR } from '../world/palette.js';
import { BAKED } from '../world/baked.js';
import { groundMaterial, mountainGroundMaterial } from './lib/materials.js';
import { mat, mergeParts } from './lib/geo.js';
import type { Part } from './lib/geo.js';

const C = {
  soil: new Color(PAL.soil),
  soilDark: new Color(PAL.soilDark),
  grass: new Color(PAL.grass),
  grassDry: new Color(PAL.grassDry),
  moss: new Color(PAL.moss),
  mossDeep: new Color(PAL.mossDeep),
  litter: new Color(PAL.litter),
  stone: new Color(PAL.stone),
  stoneWet: new Color(PAL.stoneWet),
  mud: new Color(PAL.mud),
  wet: new Color(PAL.wetSoil),
};
const R = {
  cliff: new Color(PAL.cliff),
  cliffDark: new Color(PAL.cliffDark),
  cliffWarm: new Color(PAL.cliffWarm),
  cliffWet: new Color(PAL.cliffWet),
  scree: new Color(PAL.scree),
  forest: new Color(PAL.valleyForest),
};
/** Everest: alpine meadow above the tree line, pale scree, the tan "Yellow Band" under the summit, snow (the shader lays the real snow per pixel). */
const EVC = {
  meadow: new Color('#7c8a4e'),
  meadowDry: new Color('#9c9460'),
  scree: new Color('#a39c8e'),
  band: new Color('#c4a56c'),
  snow: new Color('#e6edf5'),
};
const TINT = {
  entrance: new Color(0.8, 0.92, 0.96),
  trail: new Color(0.95, 1.0, 0.92),
  clearing: new Color(1.1, 1.05, 0.9),
};
/** The knoll meadow's ground palette (world/palette.ts MEADOW): fresh green, curing gold, straw flecks, bleached stone and the pale flower-drift tints. */
const M = {
  base: new Color(MEADOW.base),
  lush: new Color(MEADOW.lush),
  gold: new Color(MEADOW.gold),
  straw: new Color(MEADOW.straw),
  bleach: new Color(MEADOW.bleach),
  bloomWhite: new Color(MEADOW.bloomWhite),
  bloomBlue: new Color(MEADOW.bloomBlue),
};

/** Occluder grid for cheap baked AO (cells of 8 m). */
interface OccGrid {
  cell: number;
  map: Map<number, { x: number; z: number; r: number }[]>;
}
let occ: OccGrid | null = null;
function occluderGrid(): OccGrid {
  if (occ) return occ;
  const cell = 8;
  const map = new Map<number, { x: number; z: number; r: number }[]>();
  for (const [ox, oz, orad] of BAKED.occluders) {
    const o = { x: ox, z: oz, r: orad };
    const cx0 = Math.floor((o.x - o.r * 2) / cell);
    const cx1 = Math.floor((o.x + o.r * 2) / cell);
    const cz0 = Math.floor((o.z - o.r * 2) / cell);
    const cz1 = Math.floor((o.z + o.r * 2) / cell);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const k = cx * 4096 + cz;
        if (!map.has(k)) map.set(k, []);
        map.get(k)!.push(o);
      }
    }
  }
  occ = { cell, map };
  return occ;
}

/** Baked AO 0.45..1: contact darkening around trunks/rocks/logs. */
function bakedAO(x: number, z: number): number {
  const g = occluderGrid();
  const list = g.map.get(Math.floor(x / g.cell) * 4096 + Math.floor(z / g.cell));
  if (!list) return 1;
  let ao = 1;
  for (const o of list) {
    const d = Math.hypot(x - o.x, z - o.z);
    ao *= 1 - 0.5 * (1 - smoothstep(o.r * 0.85, o.r * 2.1, d));
  }
  return Math.max(0.42, ao);
}

// ---------------------------------------------------------------------------
// Crown shadows (baked): the forest's big crowns throw long soft shadows along the sun's azimuth onto the floor. There is no real shadow map for trees, so
// this is vertex colour only. Dappled (holes where the sun gets through), never on the sunlit knoll, never on the mountain.
// ---------------------------------------------------------------------------

interface CrownShadow {
  x: number;
  z: number;
  /** unit direction the shadow runs (horizontal sun direction) */
  ux: number;
  uz: number;
  /** semi-axes along / across that direction (m) */
  a: number;
  b: number;
}
let crownGridCache: { cell: number; map: Map<number, CrownShadow[]> } | null = null;
function crownGrid(): { cell: number; map: Map<number, CrownShadow[]> } {
  if (crownGridCache) return crownGridCache;
  const cell = 12;
  const map = new Map<number, CrownShadow[]>();
  const hl = Math.hypot(SUN_DIR[0], SUN_DIR[2]) || 1;
  const ux = SUN_DIR[0] / hl;
  const uz = SUN_DIR[2] / hl;
  const sinEl = Math.max(0.3, -SUN_DIR[1]);
  const perMetre = hl / sinEl; // metres of shadow offset per metre of height = cot(elevation)
  for (const [tx, , tz, r] of BAKED.trees) {
    // crown height and radius from the trunk collider radius (giant 4.3, tall / broad ~2, slender 1 at scale 1)
    const k = r > 3 ? r / 4.3 : r > 1.5 ? r / 2.0 : r / 1.0;
    const H = r > 3 ? 66 * k : r > 1.5 ? 34 * k : 29 * k;
    const R = r > 3 ? 9.8 * k : r > 1.5 ? 7 * k : 4.2 * k;
    const cy = 0.74 * H;
    const s: CrownShadow = { x: tx + ux * cy * perMetre, z: tz + uz * cy * perMetre, ux, uz, a: R * (1 + 0.6 * perMetre), b: R };
    const ext = Math.max(s.a, s.b);
    for (let cx = Math.floor((s.x - ext) / cell); cx <= Math.floor((s.x + ext) / cell); cx++) {
      for (let cz = Math.floor((s.z - ext) / cell); cz <= Math.floor((s.z + ext) / cell); cz++) {
        const key = cx * 4096 + cz;
        (map.get(key) ?? map.set(key, []).get(key)!).push(s);
      }
    }
  }
  crownGridCache = { cell, map };
  return crownGridCache;
}

/** Crown cover 0..1 at a point (1 under the middle of a shadow blob). */
function crownCover(x: number, z: number): number {
  const g = crownGrid();
  const list = g.map.get(Math.floor(x / g.cell) * 4096 + Math.floor(z / g.cell));
  if (!list) return 0;
  let cover = 0;
  for (const c of list) {
    const dx = x - c.x;
    const dz = z - c.z;
    const u = (dx * c.ux + dz * c.uz) / c.a;
    const v = (-dx * c.uz + dz * c.ux) / c.b;
    const q = u * u + v * v;
    if (q < 1) cover = Math.max(cover, 1 - q);
  }
  return cover;
}

/** Brightness multiplier (0.6..1) of the baked crown shadows: dappled, fading out over the sunlit knoll (`hw` = hillWeight). */
function crownShade(x: number, z: number, hw: number): number {
  if (hw >= 0.95) return 1;
  const cover = crownCover(x, z);
  if (cover <= 0) return 1;
  const dapple = 0.35 + 0.65 * smoothstep(0.36, 0.62, fbm(x * 0.42, z * 0.42, 62, 2));
  return 1 - 0.4 * smoothstep(0, 0.45, cover) * dapple * (1 - hw);
}

const tmp = new Color();
const mt = new Color();
/**
 * Mountain rock and forest tints (vertex colour only): sedimentary strata bands, iron staining and vertical water
 * streaks on steep faces; scree on mid slopes; dark understorey on the valley slopes and floor; a wet, mossy fall.
 */
function mountainTint(x: number, z: number, y: number, slope: number, out: Color): void {
  const rockness = smoothstep(0.5, 1.05, slope);
  const band = 0.5 + 0.5 * Math.sin(y * 1.55 + fbm(x * 0.07, z * 0.07, 82, 2) * 5.0);
  const fine = 0.5 + 0.5 * Math.sin(y * 5.3 + fbm(x * 0.2, z * 0.2, 83, 2) * 3.0);
  const streak = fbm(x * 1.7 + z * 1.3, y * 0.07, 84, 2);
  mt.copy(R.cliff).lerp(R.cliffDark, band * 0.5 + smoothstep(0.55, 0.9, streak) * 0.3).lerp(R.cliffWarm, smoothstep(0.55, 0.85, fine) * 0.35 * (1 - band));
  // Scree and talus on the middle slopes, bare rock on the steep ones.
  const scree = smoothstep(0.32, 0.6, slope) * (1 - rockness);
  mt.lerp(R.scree, scree * 0.35);
  // Wet rock around the fall.
  const wet = fallWetness(x, z);
  mt.lerp(R.cliffWet, wet * 0.75);
  out.lerp(mt, rockness);
  out.lerp(R.scree, scree * 0.25);
  // Valley floor and slopes below the ledge are under canopy: dark forest tone; the fall's foot is wet.
  const dv = Math.hypot(x - VALLEY.x, z - VALLEY.z);
  const below = (1 - smoothstep(GEO.rLedgeIn - 6, GEO.rLedgeIn + 2, dv)) * (1 - rockness * 0.75);
  out.lerp(R.forest, below * 0.8);
  // Moss on the flatter ledges and a green wash along the spray zone.
  out.lerp(C.mossDeep, wet * (1 - rockness) * 0.5);
}

const ev = new Color();
/**
 * Everest's ground (vertex colour, blended over the jungle splat by `ew`): the dark forest floor of the foot gives way to alpine meadow (~35 - 80 m),
 * then scree and banded rock (the east mountain's strata, lighter and greyer with height, with a tan band at 150 - 168 m), then snow.
 */
function everestTint(x: number, z: number, y: number, slope: number, ew: number, out: Color): void {
  const n = fbm(x * 0.02, z * 0.02, 94, 2);
  const yy = y + (n - 0.5) * 30;
  const alp = smoothstep(30, 74, yy);
  ev.copy(R.forest).lerp(C.grass, 0.25 * (1 - alp)).lerp(EVC.meadow, alp).lerp(EVC.meadowDry, alp * smoothstep(0.42, 0.72, fbm(x * 0.09, z * 0.09, 95, 2)));
  const rockness = Math.max(smoothstep(0.5, 1.0, slope), smoothstep(66, 118, yy) * 0.9);
  if (rockness > 0) {
    const band = 0.5 + 0.5 * Math.sin(y * 0.9 + fbm(x * 0.05, z * 0.05, 82, 2) * 5.0);
    const fine = 0.5 + 0.5 * Math.sin(y * 3.1 + fbm(x * 0.2, z * 0.2, 83, 2) * 3.0);
    const streak = fbm(x * 1.7 + z * 1.3, y * 0.07, 84, 2);
    mt.copy(R.cliff).lerp(R.cliffDark, band * 0.5 + smoothstep(0.55, 0.9, streak) * 0.3).lerp(R.cliffWarm, smoothstep(0.55, 0.85, fine) * 0.3 * (1 - band));
    mt.lerp(EVC.scree, (1 - smoothstep(0.55, 1.0, slope)) * 0.6);
    const yb = y + (fbm(x * 0.03, z * 0.03, 96, 2) - 0.5) * 14;
    mt.lerp(EVC.band, smoothstep(148, 153, yb) * (1 - smoothstep(163, 169, yb)) * 0.7);
    ev.lerp(mt, rockness);
  }
  ev.lerp(EVC.snow, everestSnowAt(x, z, y, slope));
  out.lerp(ev, ew);
}

const mdw = new Color();
const mdwFlower = new Color();

/**
 * The knoll's meadow ground, blended over the generic splat by `hw`: fresh green patches (~20 m) and curing gold (~9 m) from the shared `meadowFields`
 * (the tufts and flowers read the same fields), dark tussock shade and pale straw flecks (~2 m), a hint of pale flower-drift colour (~8 %, the real
 * flowers are geometry), bleached stone on the steeper bits; slopes that face the sun run a touch warmer, slopes that face away a touch cooler (`lit`).
 */
function meadowGround(x: number, z: number, b: ReturnType<typeof groundBlend>, n: number, lit: number, out: Color): void {
  const hw = b.meadow;
  mdw.copy(C.grass).lerp(M.lush, 0.35 + 0.65 * b.lush);
  mdw.lerp(M.gold, b.straw * (0.55 + 0.4 * n));
  const fleck = fbm(x * 0.55, z * 0.55, 63, 2);
  mdw.lerp(M.straw, smoothstep(0.6, 0.8, fleck) * 0.4 * (0.35 + b.straw));
  mdw.lerp(M.base, smoothstep(0.58, 0.8, 1 - fleck) * 0.32 * (1 - 0.5 * b.straw));
  if (b.drift > 0) {
    mdwFlower.copy(M.bloomWhite).lerp(M.bloomBlue, smoothstep(0.4, 0.6, fbm(x * 0.5 + 3, z * 0.5, 65, 2)));
    mdw.lerp(mdwFlower, b.drift * 0.08);
  }
  mdw.lerp(M.bleach, b.stone * 0.7);
  out.lerp(mdw, 0.88 * hw);
  const macro = 0.9 + 0.2 * fbm(x * 0.02, z * 0.02, 64, 2);
  const warm = Math.max(-0.35, Math.min(0.35, lit)) * hw;
  out.r *= (1 + 0.25 * warm) * (1 + (macro - 1) * hw);
  out.g *= 1 + (macro - 1) * hw;
  out.b *= (1 - 0.3 * warm) * (1 + (macro - 1) * hw);
}

/**
 * Ground colour at a point. `slope` is rise/run; `y` (height) drives rock strata on the mountain.
 * `lit` = how much more (+) or less (-) the surface faces the sun than flat ground does; `curv` = curvature ambient occlusion multiplier (tiles pass them).
 */
export function groundColor(x: number, z: number, slope: number, out: Color = tmp, y = 0, lit = 0, curv = 1): Color {
  const b = groundBlend(x, z, slope);
  const a = areaWeights(x, z);
  // the knoll is a sunlit meadow: the cool dark entrance tint gives way to the warm clearing tint
  const hw = b.meadow;
  if (hw > 0) {
    const e = a.entrance * (1 - hw);
    a.clearing += a.entrance - e;
    a.entrance = e;
  }
  const n = fbm(x * 0.9, z * 0.9, 21, 2);
  out.copy(C.soil).lerp(C.soilDark, smoothstep(0.35, 0.8, n) * 0.6);
  out.lerp(C.litter, b.litter * 0.8);
  out.lerp(C.grassDry, b.grass * 0.5 * smoothstep(0.4, 0.8, n)).lerp(C.grass, b.grass * 0.85);
  out.lerp(C.moss, b.moss * 0.8).lerp(C.mossDeep, b.moss * 0.4 * (1 - n));
  out.lerp(C.stone, b.stone);
  out.lerp(C.wet, b.mud * 0.55).lerp(C.mud, b.mud * 0.45);
  // Area identity: cool/dark entrance, neutral trail, warm open clearing.
  tmp.r = a.entrance * TINT.entrance.r + a.trail * TINT.trail.r + a.clearing * TINT.clearing.r;
  tmp.g = a.entrance * TINT.entrance.g + a.trail * TINT.trail.g + a.clearing * TINT.clearing.g;
  tmp.b = a.entrance * TINT.entrance.b + a.trail * TINT.trail.b + a.clearing * TINT.clearing.b;
  const k = (a.entrance + a.trail + a.clearing) || 1;
  out.r *= tmp.r / k;
  out.g *= tmp.g / k;
  out.b *= tmp.b / k;
  if (hw > 0.001) meadowGround(x, z, b, n, lit, out);
  const mw = mountainWeight(x, z);
  if (mw > 0.02) mountainTint(x, z, y, slope, out);
  const ew = everestWeight(x, z);
  if (ew > 0.001) everestTint(x, z, y, slope, ew, out);
  // (no crown shade on the mountains: the east mountain has its own canopy bake, Everest is bare)
  out.multiplyScalar(bakedAO(x, z) * curv * (mw > 0.02 ? 1 : 1 - (1 - crownShade(x, z, hw)) * (1 - ew)));
  return out;
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

const TILES_X = 4;
const TILES_Z = 4;

function tileCell(x0: number, z0: number, x1: number, z1: number): number {
  let best = Infinity;
  for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1], [(x0 + x1) / 2, (z0 + z1) / 2], [(x0 + x1) / 2, z0], [(x0 + x1) / 2, z1], [x0, (z0 + z1) / 2], [x1, (z0 + z1) / 2]] as const) {
    best = Math.min(best, distanceToPath(x, z).dist);
  }
  return best < 12 ? 1.25 : best < 32 ? 2.5 : 5.0;
}

/**
 * Cliff relief: on faces steeper than ~48 degrees (never walkable) push the vertex horizontally along the face
 * normal by a strata-aligned noise, so silhouettes get ledges, ribs and overhang-like bulges instead of a smooth
 * sheet. The same displaced mesh is what locomotion collides with. Faded out near the route.
 */
function crag(pos: Float32Array, k: number, x: number, z: number, y: number, dhx: number, dhz: number, slope: number): void {
  const near = z > EVEREST.z0 ? routeNear(EV, x, z).dist : routeNear(MTN, x, z).dist;
  const fade = smoothstep(4.5, 9, near) * smoothstep(1.1, 1.8, slope);
  if (fade <= 0) return;
  const hl = Math.hypot(dhx, dhz) || 1;
  // outward (horizontal) normal of the face: downhill direction is -(dh); the surface faces towards +dh... use gradient sign
  const nx = -dhx / hl;
  const nz = -dhz / hl;
  const ledge = Math.pow(0.5 + 0.5 * Math.sin(y * 1.55 + fbm(x * 0.06, z * 0.06, 82, 2) * 5), 0.6); // matches the colour strata
  const n = fbm(x * 0.22 + y * 0.05, z * 0.22 - y * 0.04, 85, 3) - 0.5;
  const amp = (n * 3.2 + (ledge - 0.5) * 1.5) * fade;
  pos[k * 3] += nx * amp;
  pos[k * 3 + 2] += nz * amp;
}

/**
 * Curvature ambient occlusion from the height grid's 4-neighbour Laplacian (`lap`, m) over the cell area: hollows up to -28 %, crests up to +10 % on the
 * knoll (`hw` = 1); the jungle floor, whose relief is already dark and busy, gets 45 % of that. Off on coarse / mountain tiles.
 */
function curvatureAO(lap: number, area: number, on: boolean, hw: number): number {
  if (!on) return 1;
  return 1 - Math.max(-0.1, Math.min(0.28, (lap / area) * 7)) * (0.45 + 0.55 * hw);
}

function buildTile(x0: number, z0: number, x1: number, z1: number, name: string, cellOverride?: number, material: typeof groundMaterial = groundMaterial): Mesh {
  const cell = cellOverride ?? tileCell(x0, z0, x1, z1);
  const nx = Math.max(2, Math.round((x1 - x0) / cell));
  const nz = Math.max(2, Math.round((z1 - z0) / cell));
  const sx = (x1 - x0) / nx;
  const sz = (z1 - z0) / nz;
  // Height grid with a 1-cell margin for seamless normals.
  const gw = nx + 3;
  const gh = nz + 3;
  const H = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) H[j * gw + i] = terrainHeight(x0 + (i - 1) * sx, z0 + (j - 1) * sz);
  const hAt = (i: number, j: number) => H[(j + 1) * gw + (i + 1)];

  const vw = nx + 1;
  const vh = nz + 1;
  const skirt = Math.max(1.4, cell * 0.8);
  const count = vw * vh + 2 * (vw + vh);
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const c = new Color();
  const put = (k: number, x: number, y: number, z: number, nxv: number, nyv: number, nzv: number) => {
    pos[k * 3] = x;
    pos[k * 3 + 1] = y;
    pos[k * 3 + 2] = z;
    nor[k * 3] = nxv;
    nor[k * 3 + 1] = nyv;
    nor[k * 3 + 2] = nzv;
    uv[k * 2] = x / 2.5;
    uv[k * 2 + 1] = z / 2.5;
  };
  for (let j = 0; j < vh; j++) {
    for (let i = 0; i < vw; i++) {
      const k = j * vw + i;
      const x = x0 + i * sx;
      const z = z0 + j * sz;
      const dhx = (hAt(i + 1, j) - hAt(i - 1, j)) / (2 * sx);
      const dhz = (hAt(i, j + 1) - hAt(i, j - 1)) / (2 * sz);
      const il = 1 / Math.hypot(dhx, 1, dhz);
      put(k, x, hAt(i, j), z, -dhx * il, il, -dhz * il);
      const slope = Math.hypot(dhx, dhz);
      // how much this facet faces the sun relative to flat ground, and curvature AO from the height grid (hollows darker, crests a touch lighter)
      const lit = il * (dhx * SUN_DIR[0] - SUN_DIR[1] + dhz * SUN_DIR[2]) + SUN_DIR[1];
      const curv = curvatureAO(hAt(i - 1, j) + hAt(i + 1, j) + hAt(i, j - 1) + hAt(i, j + 1) - 4 * hAt(i, j), sx * sz, material === groundMaterial && cell <= 2.5, hillWeight(x, z));
      groundColor(x, z, slope, c, hAt(i, j), lit, curv);
      if (slope > 1.1) crag(pos, k, x, z, hAt(i, j), dhx, dhz, slope);
      col[k * 3] = c.r;
      col[k * 3 + 1] = c.g;
      col[k * 3 + 2] = c.b;
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * vw + i;
      idx.push(a, a + vw, a + 1, a + 1, a + vw, a + vw + 1);
    }
  }
  // Skirts along the four edges (hide cracks between tiles of different resolution).
  let k = vw * vh;
  const addSkirt = (edge: number[]) => {
    const base = k;
    for (const e of edge) {
      put(k, pos[e * 3], pos[e * 3 + 1] - skirt, pos[e * 3 + 2], nor[e * 3], nor[e * 3 + 1], nor[e * 3 + 2]);
      col[k * 3] = col[e * 3];
      col[k * 3 + 1] = col[e * 3 + 1];
      col[k * 3 + 2] = col[e * 3 + 2];
      k++;
    }
    for (let q = 0; q < edge.length - 1; q++) {
      idx.push(edge[q], edge[q + 1], base + q, edge[q + 1], base + q + 1, base + q);
      idx.push(edge[q], base + q, edge[q + 1], edge[q + 1], base + q, base + q + 1);
    }
  };
  addSkirt(Array.from({ length: vw }, (_, i) => i));
  addSkirt(Array.from({ length: vw }, (_, i) => (vh - 1) * vw + i));
  addSkirt(Array.from({ length: vh }, (_, j) => j * vw));
  addSkirt(Array.from({ length: vh }, (_, j) => j * vw + vw - 1));

  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.setIndex(new Uint32BufferAttribute(Uint32Array.from(idx), 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  const m = new Mesh(g, material);
  m.name = name;
  m.receiveShadow = true;
  return m;
}

// ---------------------------------------------------------------------------
// Trail ribbon
// ---------------------------------------------------------------------------

interface RibbonSample {
  x: number;
  z: number;
  hw: number;
  /** extra: mud factor 0..1 at this sample (mountain route) */
  mud?: number;
}

function createTrailGeometry(samples: RibbonSample[], mountain = false): BufferGeometry {
  const cols = 11;
  const rows = samples.length;
  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const dirt = new Color(PAL.soil).lerp(new Color(PAL.litter), 0.25);
  const dirtDark = new Color(PAL.soilDark);
  const packed = new Color(mountain ? '#7d6a4c' : '#6f5638');
  const mud = new Color(PAL.mud);
  const c = new Color();
  const g2 = new Color();
  for (let i = 0; i < rows; i++) {
    const { x: px, z: pz } = samples[i];
    const { x: nx, z: nz } = samples[Math.min(rows - 1, i + 1)];
    const { x: bx, z: bz } = samples[Math.max(0, i - 1)];
    const tx = nx - bx;
    const tz = nz - bz;
    const tl = Math.hypot(tx, tz) || 1;
    const sx = -tz / tl;
    const sz = tx / tl;
    const hw = samples[i].hw * (0.9 + 0.22 * fbm(px * 0.4, pz * 0.4, 31, 2));
    const mudK = samples[i].mud ?? 0;
    for (let j = 0; j < cols; j++) {
      const u = (j / (cols - 1)) * 2 - 1;
      const wobble = (fbm(px * 0.8 + j * 3.1, pz * 0.8, 33, 2) - 0.5) * 0.3;
      const x = px + sx * (u * hw + wobble);
      const z = pz + sz * (u * hw + wobble);
      // Lifted 7.5 cm: the terrain tiles interpolate linearly between their samples and would poke through a flush ribbon. (The two rim columns are
      // tucked under the ground after the normals are computed: see below.)
      const y = terrainHeight(x, z) + 0.075;
      positions.push(x, y, z);
      uvs.push(x / 2.5, z / 2.5);
      const edge = Math.abs(u);
      const blotch = fbm(x * 0.9, z * 0.9, 35, 3);
      // Worn centre is lighter packed earth; shoulders darker; edges blend into the ground splat.
      c.copy(dirt).lerp(dirtDark, smoothstep(0.4, 0.8, blotch) * 0.7);
      c.lerp(packed, (1 - edge) * smoothstep(0.55, 0.3, blotch) * 0.35);
      for (const m of MUD_PATCHES) {
        const dm = Math.hypot(x - m.x, z - m.z);
        c.lerp(mud, (1 - smoothstep(m.r * 0.4, m.r * 1.2, dm)) * 0.8);
      }
      c.lerp(mud, mudK * (0.55 + 0.4 * blotch));
      // the trail lies in the same crown shadows as the floor beside it: shade the dirt once, BEFORE blending in g2 (groundColor already applies the shade to g2)
      if (!mountain) c.multiplyScalar(crownShade(x, z, hillWeight(x, z)));
      groundColor(x, z, 0.1, g2, y);
      // (pure ground colour from the second column outwards: that is where the ribbon meets the terrain, see the rim below)
      c.lerp(g2, smoothstep(0.52, 0.8, edge));
      colors.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j;
      indices.push(a, a + 1, a + cols, a + 1, a + cols + 1, a + cols);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  // Draped ribbons must face up.
  if (g.getAttribute('normal').getY(0) < 0) {
    for (let i = 0; i < indices.length; i += 3) {
      const t = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = t;
    }
    g.setIndex(indices);
    g.computeVertexNormals();
  }
  // The two rim columns go 4 cm UNDER the ground, so the ribbon rises out of the terrain along a line where both surfaces are at the same height. A
  // lifted rim was a 7.5 cm step: the world-projected ground photo jumped by its parallax there (a straight seam cutting the leaves in half). The
  // normals stay those of the evenly lifted ribbon, so the tucked strip is lit like the ground it sinks into.
  const pos = g.getAttribute('position');
  for (let i = 0; i < rows; i++) {
    for (const j of [0, cols - 1]) pos.setY(i * cols + j, pos.getY(i * cols + j) - 0.115);
  }
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/** The mountain route as dirt-trail ribbons: one per stretch of ground (the bridge deck and the collapse shelf are separate structures). */
function mountainRibbons(): Mesh[] {
  const out: Mesh[] = [];
  const mudAt = (s: number) => {
    for (const m of MTN_MUD) if (s >= m.s0 - 3 && s <= m.s1 + 3) return smoothstep(m.s0 - 3, m.s0, s) * (1 - smoothstep(m.s1, m.s1 + 3, s));
    return 0;
  };
  let run: RibbonSample[] = [];
  let k = 0;
  const flush = () => {
    if (run.length > 3) {
      const m = new Mesh(createTrailGeometry(run, true), groundMaterial);
      m.name = `RouteTrail_${k++}`;
      m.receiveShadow = true;
      out.push(m);
    }
    run = [];
  };
  for (let i = 0; i < MTN.samples.length; i += 2) {
    const q = MTN.samples[i];
    const skip = q.zone === 'bridge' || (q.s >= MTN.cleft.s0 - 0.5 && q.s <= MTN.cleft.s1 + 0.5) || q.zone === 'terrace' || (q.zone === 'summit' && Math.hypot(q.x - 108, q.z + 80) < 7);
    if (skip || q.x < 14) {
      flush();
      continue;
    }
    run.push({ x: q.x, z: q.z, hw: q.hw * 1.05 + 0.15, mud: mudAt(q.s) });
    if (run.length >= 140) {
      const last = run[run.length - 1];
      flush();
      run.push(last);
    }
  }
  flush();
  return out;
}

/**
 * Height of Everest's DRAWN surface (which is also the walked one): the 2 m lattice of the fine tiles the trail runs on (`everestTiles`: every tile
 * within 7 m of the route), split along the same diagonal as `buildTile`. The terrain function itself has a flat bench there, which a 2 m lattice
 * cannot follow on a steep flank: a ribbon draped on the function is buried on the uphill side and floats on the other. North of the lattice (the
 * last metres down to the knoll, on the jungle's 1.25 m tiles and gentle ground) the function is close enough.
 */
const evLattice = new Map<number, number>();
function everestMeshHeight(x: number, z: number): number {
  const E = EVEREST_LOD;
  if (z < E.z0 + 0.01) return terrainHeight(x, z);
  const fx = (x - E.x0) / 2;
  const fz = (z - E.z0) / 2;
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const u = fx - i;
  const v = fz - j;
  const h = (ii: number, jj: number): number => {
    const k = jj * 8192 + ii;
    let y = evLattice.get(k);
    if (y === undefined) {
      y = terrainHeight(E.x0 + ii * 2, E.z0 + jj * 2);
      evLattice.set(k, y);
    }
    return y;
  };
  const h10 = h(i + 1, j);
  const h01 = h(i, j + 1);
  if (u + v <= 1) {
    const h00 = h(i, j);
    return h00 + u * (h10 - h00) + v * (h01 - h00);
  }
  const h11 = h(i + 1, j + 1);
  return h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
}

/**
 * One stretch of the Everest trail: a trodden line on the peak's own ground material (the snow, the scree and the fog exemption are the terrain's, per
 * pixel). Seven columns, a row per metre, draped on the drawn mesh and lifted 9 cm (the rim columns are tucked 4 cm under it). Below the snow the line is
 * worn, dusty ground (vertex colour); in the snow the shader packs it down wherever `aPacked` (1 on the centre line, 0 at the rim) says so.
 */
function createEverestTrailGeometry(samples: RibbonSample[]): BufferGeometry {
  const cols = 7;
  const rows = samples.length;
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const packed: number[] = [];
  const indices: number[] = [];
  const worn = new Color('#9a8a6e');
  const wornDark = new Color('#6f6250');
  const c = new Color();
  const g2 = new Color();
  for (let i = 0; i < rows; i++) {
    const { x: px, z: pz } = samples[i];
    const { x: nx, z: nz } = samples[Math.min(rows - 1, i + 1)];
    const { x: bx, z: bz } = samples[Math.max(0, i - 1)];
    const tx = nx - bx;
    const tz = nz - bz;
    const tl = Math.hypot(tx, tz) || 1;
    const sx = -tz / tl;
    const sz = tx / tl;
    const hw = samples[i].hw * (0.92 + 0.16 * fbm(px * 0.4, pz * 0.4, 31, 2));
    // the terrain's own (smooth) normal and slope at the centre line: the ribbon is lit and coloured like the bench it lies on
    const dhx = (terrainHeight(px + 2, pz) - terrainHeight(px - 2, pz)) / 4;
    const dhz = (terrainHeight(px, pz + 2) - terrainHeight(px, pz - 2)) / 4;
    const il = 1 / Math.hypot(dhx, 1, dhz);
    const slope = Math.hypot(dhx, dhz);
    for (let j = 0; j < cols; j++) {
      const u = (j / (cols - 1)) * 2 - 1;
      const edge = Math.abs(u);
      const wobble = (fbm(px * 0.8 + j * 3.1, pz * 0.8, 33, 2) - 0.5) * 0.24;
      const x = px + sx * (u * hw + wobble);
      const z = pz + sz * (u * hw + wobble);
      const rim = j === 0 || j === cols - 1;
      const y = everestMeshHeight(x, z) + (rim ? -0.04 : 0.09);
      positions.push(x, y, z);
      normals.push(-dhx * il, il, -dhz * il);
      uvs.push(x / 2.5, z / 2.5);
      const blotch = fbm(x * 0.9, z * 0.9, 35, 3);
      groundColor(x, z, slope, g2, y);
      c.copy(worn).lerp(wornDark, smoothstep(0.4, 0.8, blotch) * 0.6).lerp(g2, 0.35);
      c.lerp(g2, smoothstep(0.4, 0.92, edge));
      colors.push(c.r, c.g, c.b);
      packed.push((1 - smoothstep(0.3, 0.95, edge)) * (0.8 + 0.2 * blotch));
    }
  }
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j;
      indices.push(a, a + 1, a + cols, a + 1, a + cols + 1, a + cols);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  g.setAttribute('aPacked', new Float32BufferAttribute(packed, 1));
  // (the faces must look up, whichever hand the stretch turns to)
  const pa = positions;
  const [ia, ib, ic] = indices;
  const ny = (pa[ib * 3 + 2] - pa[ia * 3 + 2]) * (pa[ic * 3] - pa[ia * 3]) - (pa[ib * 3] - pa[ia * 3]) * (pa[ic * 3 + 2] - pa[ia * 3 + 2]);
  if (ny < 0) {
    for (let i = 0; i < indices.length; i += 3) {
      const t = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = t;
    }
  }
  g.setIndex(indices);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/** The Everest trail (a trodden line through the meadow, the scree and the snow), from just off the summit platform to the knoll's own trail. */
function everestRibbons(): Mesh[] {
  const out: Mesh[] = [];
  let run: RibbonSample[] = [];
  let k = 0;
  const flush = () => {
    if (run.length > 3) {
      const m = new Mesh(createEverestTrailGeometry(run), mountainGroundMaterial);
      m.name = `EverestTrail_${k++}`;
      m.receiveShadow = true;
      out.push(m);
    }
    run = [];
  };
  for (const q of EV.samples) {
    if (q.s < EVEREST.platform - 1) continue;
    run.push({ x: q.x, z: q.z, hw: q.hw * 0.82 });
    if (run.length >= 60) {
      const last = run[run.length - 1];
      flush();
      run.push(last);
    }
  }
  flush();
  evLattice.clear();
  return out;
}

/**
 * The summit cairn: a pile of frost-split stones, a pole and three strings of prayer flags (blue, white, red, green, yellow: sky, air, fire, water,
 * earth). One mesh on the peak's own ground material, so it costs one draw and no new material or program: the shader dusts the stones' tops with
 * snow and leaves the upright cloth bare (its rock tone on a steep face only weathers the colours, which are authored over-bright for that).
 */
function everestCairn(): Mesh {
  const K = EVEREST_CAIRN;
  const y0 = terrainHeight(K.x, K.z);
  const parts: Part[] = [];
  const rnd = (i: number, k: number): number => fbm(K.x + i * 7.31 + k * 3.7, K.z - i * 4.13 + k * 1.9, 71, 1);
  // (over-bright: the material multiplies vertex colours by its dark rock tone)
  const stone = [new Color(1.5, 1.45, 1.36), new Color(1.25, 1.2, 1.14), new Color(1.7, 1.62, 1.5), new Color(1.1, 1.08, 1.04)];
  const layers = [
    [6, 0.44, 0.3, 0.14],
    [5, 0.3, 0.26, 0.38],
    [3, 0.17, 0.22, 0.6],
    [1, 0, 0.21, 0.8],
  ];
  let n = 0;
  for (const [count, ring, size, y] of layers) {
    for (let i = 0; i < count; i++, n++) {
      const a = (i / count) * Math.PI * 2 + rnd(n, 1) * 2.4;
      const s = size * (0.85 + 0.4 * rnd(n, 2));
      parts.push({
        geo: new DodecahedronGeometry(1, 0),
        m: mat(K.x + Math.cos(a) * ring, y0 + y + (rnd(n, 3) - 0.5) * 0.06, K.z + Math.sin(a) * ring, rnd(n, 4) * 0.6 - 0.3, rnd(n, 5) * 6.28, rnd(n, 6) * 0.6 - 0.3, s * 1.25, s * 0.58, s),
        color: stone[n % stone.length],
      });
    }
  }
  const top = y0 + K.pole;
  parts.push({ geo: new CylinderGeometry(0.013, 0.02, K.pole - 0.7, 5, 1, true), m: mat(K.x, y0 + 0.7 + (K.pole - 0.7) / 2, K.z), color: new Color(1.1, 0.82, 0.55) });
  // (over-bright on purpose: the material multiplies them by its grey rock tone on upright faces)
  const cloth: [number, number, number][] = [
    [0.1, 0.38, 1.9],
    [1.9, 1.9, 1.9],
    [1.9, 0.12, 0.09],
    [0.1, 1.2, 0.26],
    [2.0, 1.35, 0.08],
  ];
  K.strings.forEach(([dx, dz, len], si) => {
    const flags = Math.floor((len - 0.5) / 0.21);
    const ex = K.x + dx * len;
    const ez = K.z + dz * len;
    const ey = terrainHeight(ex, ez) + 0.42;
    const yaw = Math.atan2(-dz, dx);
    // a stake where the string comes down
    parts.push({ geo: new CylinderGeometry(0.012, 0.016, 0.5, 4, 1, true), m: mat(ex, ey - 0.2, ez, 0, 0, 0), color: new Color(1.1, 0.82, 0.55) });
    for (let f = 0; f < flags; f++) {
      const t = (f + 0.9) / (flags + 0.8);
      const sag = 0.42 * 4 * t * (1 - t);
      const x = K.x + dx * len * t;
      const z = K.z + dz * len * t;
      const y = top + (ey - top) * t - sag * (len / 3.4);
      const flutter = (rnd(si * 31 + f, 7) - 0.5) * 0.5;
      const [r, g, b] = cloth[(f + si * 2) % cloth.length];
      for (const back of [0, Math.PI]) {
        parts.push({
          geo: new PlaneGeometry(0.17, 0.2),
          m: mat(x, y - 0.1, z, flutter * 0.5, yaw + back + flutter * 0.35, 0),
          color: new Color(r, g, b),
        });
      }
    }
  });
  const geo = mergeParts(parts);
  parts.forEach((p) => p.geo.dispose());
  const m = new Mesh(geo, mountainGroundMaterial);
  m.name = 'EverestCairn';
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Concatenate tile geometries (same attributes: position, normal, color, uv, index). */
function mergeTileGeometries(geos: BufferGeometry[]): BufferGeometry {
  let vc = 0;
  let ic = 0;
  for (const g of geos) {
    vc += g.getAttribute('position').count;
    ic += g.index!.count;
  }
  const pos = new Float32Array(vc * 3);
  const nor = new Float32Array(vc * 3);
  const col = new Float32Array(vc * 3);
  const uv = new Float32Array(vc * 2);
  const idx = new Uint32Array(ic);
  let vo = 0;
  let io = 0;
  for (const g of geos) {
    const n = g.getAttribute('position').count;
    pos.set(g.getAttribute('position').array as Float32Array, vo * 3);
    nor.set(g.getAttribute('normal').array as Float32Array, vo * 3);
    col.set(g.getAttribute('color').array as Float32Array, vo * 3);
    uv.set(g.getAttribute('uv').array as Float32Array, vo * 2);
    for (let i = 0; i < g.index!.count; i++) idx[io + i] = g.index!.getX(i) + vo;
    io += g.index!.count;
    vo += n;
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new Float32BufferAttribute(col, 3));
  out.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  out.setIndex(new Uint32BufferAttribute(idx, 1));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/** All ground meshes: jungle tiles (west of x = 35), mountain tiles (adaptive quadtree), the main trail and the mountain route ribbons. Walkable (LocomotionEnvironment set in the scene). */
export function createTerrain(): Group {
  const g = new Group();
  g.name = 'JungleTerrain';
  const dx = (TERRAIN.x1 - TERRAIN.x0) / TILES_X;
  // the jungle tile rows reach the knoll's south edge (zSouth); the mountain tiles below keep z1
  const dz = (TERRAIN.zSouth - TERRAIN.z0) / TILES_Z;
  for (let j = 0; j < TILES_Z; j++) {
    for (let i = 0; i < TILES_X - 1; i++) {
      const x0 = TERRAIN.x0 + i * dx;
      const z0 = TERRAIN.z0 + j * dz;
      g.add(buildTile(x0, z0, x0 + dx, z0 + dz, `Terrain_${i}_${j}`));
    }
  }
  const xe = TERRAIN.x0 + (TILES_X - 1) * dx; // = 35
  // Mountain tiles, grouped by 96 m root cell. A root with no detail (far plateau, valley floor) is merged with the others into ONE draw;
  // a root with detail (route, platforms) keeps its fine tiles here and gets a coarse stand-in in the 'terrain-far' asset (no collision),
  // which ChunkLodSystem shows instead of the fine tiles when the player is more than FINE_RADIUS away (terrain LOD).
  const bigTiles: Mesh[] = [];
  const roots = new Map<string, Mesh[]>();
  mountainTiles(MTN, xe, xe + 4 * 96, -300, TERRAIN.z1).forEach((t, n) => {
    const ri = Math.floor((t.x0 - xe) / 96);
    const rj = Math.floor((t.z0 + 300) / 96);
    const m = buildTile(t.x0, t.z0, t.x1, t.z1, `Mountain_${ri}_${rj}_${n}`, t.cell, mountainGroundMaterial);
    if (t.x1 - t.x0 >= 96) bigTiles.push(m);
    else {
      // merged per 48 m quadrant of the root: one draw each, without drawing a whole 96 m cell for a corner of it
      const qk = `${ri},${rj},${Math.floor((t.x0 - xe - ri * 96) / 48)},${Math.floor((t.z0 + 300 - rj * 96) / 48)}`;
      (roots.get(qk) ?? roots.set(qk, []).get(qk)!).push(m);
    }
  });
  // The fine tiles of one root are always shown together (terrain LOD): merged per 48 m quadrant (<= 4 draws per root).
  for (const [key, list] of roots) {
    const [ri, rj, qi, qj] = key.split(',').map(Number);
    const merged = new Mesh(mergeTileGeometries(list.map((m) => m.geometry)), mountainGroundMaterial);
    merged.name = `Mountain_${ri}_${rj}_${qi * 2 + qj}`;
    merged.receiveShadow = true;
    g.add(merged);
    list.forEach((m) => m.geometry.dispose());
  }
  if (bigTiles.length) {
    const merged = new Mesh(mergeTileGeometries(bigTiles.map((m) => m.geometry)), mountainGroundMaterial);
    merged.name = 'Mountain_far';
    merged.receiveShadow = true;
    g.add(merged);
    bigTiles.forEach((m) => m.geometry.dispose());
  }
  const trail = new Mesh(createTrailGeometry(PATH_SAMPLES.map((p, i) => ({ x: p[0], z: p[1], hw: pathHalfWidth(i) }))), groundMaterial);
  trail.name = 'DirtTrail';
  trail.receiveShadow = true;
  g.add(trail);
  for (const r of mountainRibbons()) g.add(r);
  // Everest (world/everest.ts): the same scheme as the east mountain. Roots the trail crosses keep their fine tiles (merged per 48 m quadrant,
  // `Everest_ri_rj_q`) and get a coarse stand-in in 'terrain-far'; every other root, and the apron that carries the peak's north-east foot down to the
  // east mountain's tiles (x 35..227, z 35..62), is merged into three meshes (`Everest_far_n|w|e`). Collision uses all of it.
  const E = EVEREST_LOD;
  const evBig: Mesh[] = [];
  const evRoots = new Map<string, Mesh[]>();
  everestTiles(EV, E.x0, E.x0 + E.nx * E.size, E.z0, E.z0 + E.nz * E.size).forEach((t, n) => {
    const m = buildTile(t.x0, t.z0, t.x1, t.z1, `EverestTile_${n}`, t.cell, mountainGroundMaterial);
    if (t.x1 - t.x0 >= E.size) evBig.push(m);
    else {
      const ri = Math.floor((t.x0 - E.x0) / E.size);
      const rj = Math.floor((t.z0 - E.z0) / E.size);
      const qk = `${ri},${rj},${Math.floor((t.x0 - E.x0 - ri * E.size) / 48)},${Math.floor((t.z0 - E.z0 - rj * E.size) / 48)}`;
      (evRoots.get(qk) ?? evRoots.set(qk, []).get(qk)!).push(m);
    }
  });
  for (let x0 = xe; x0 < xe + 2 * 96; x0 += 96) evBig.push(buildTile(x0, TERRAIN.z1, x0 + 96, TERRAIN.zSouth, 'EverestApron', 9, mountainGroundMaterial));
  for (const [key, list] of evRoots) {
    const [ri, rj, qi, qj] = key.split(',').map(Number);
    const merged = new Mesh(mergeTileGeometries(list.map((m) => m.geometry)), mountainGroundMaterial);
    merged.name = `Everest_${ri}_${rj}_${qi * 2 + qj}`;
    merged.receiveShadow = true;
    g.add(merged);
    list.forEach((m) => m.geometry.dispose());
  }
  // Three pieces, so that the bulk of the peak is frustum culled when the player in the jungle looks away from it (one mesh's bounding sphere would
  // hold the whole jungle and be submitted in every view): the north foot (z < 254, next to the jungle) and the west and east halves of the rest.
  const evParts: Record<string, Mesh[]> = { n: [], w: [], e: [] };
  for (const m of evBig) {
    m.geometry.computeBoundingBox();
    const bb = m.geometry.boundingBox!;
    evParts[(bb.min.z + bb.max.z) / 2 < E.z0 + 2 * E.size ? 'n' : (bb.min.x + bb.max.x) / 2 < EVEREST.x ? 'w' : 'e'].push(m);
  }
  for (const [k, list] of Object.entries(evParts)) {
    if (!list.length) continue;
    const evFar = new Mesh(mergeTileGeometries(list.map((m) => m.geometry)), mountainGroundMaterial);
    evFar.name = `Everest_far_${k}`;
    evFar.receiveShadow = true;
    g.add(evFar);
  }
  evBig.forEach((m) => m.geometry.dispose());
  for (const r of everestRibbons()) g.add(r);
  g.add(everestCairn());
  return g;
}

const ROOT = TERRAIN_LOD;

/**
 * Coarse stand-ins (6 m cells, one mesh per 96 m root cell that has fine tiles). NOT part of the locomotion environment:
 * collision always uses the fine tiles, whatever is drawn.
 */
export function createTerrainFar(): Group {
  const g = new Group();
  g.name = 'TerrainFar';
  const seen = new Set<string>();
  for (const t of mountainTiles(MTN, ROOT.x0, ROOT.x0 + 4 * 96, ROOT.z0, TERRAIN.z1)) {
    if (t.x1 - t.x0 >= 96) continue;
    const ri = Math.floor((t.x0 - ROOT.x0) / 96);
    const rj = Math.floor((t.z0 - ROOT.z0) / 96);
    const key = `${ri},${rj}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const x0 = ROOT.x0 + ri * 96;
    const z0 = ROOT.z0 + rj * 96;
    const m = buildTile(x0, z0, x0 + 96, Math.min(TERRAIN.z1, z0 + 96), `MtnCoarse_${ri}_${rj}`, 6, mountainGroundMaterial);
    m.visible = false; // shown by ChunkLodSystem
    g.add(m);
  }
  // Everest: one 16 m-cell mesh per root that has fine tiles
  const E = EVEREST_LOD;
  const evCoarse: Mesh[] = [];
  for (const t of everestTiles(EV, E.x0, E.x0 + E.nx * E.size, E.z0, E.z0 + E.nz * E.size)) {
    if (t.x1 - t.x0 >= E.size) continue;
    const ri = Math.floor((t.x0 - E.x0) / E.size);
    const rj = Math.floor((t.z0 - E.z0) / E.size);
    const key = `e${ri},${rj}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const x0 = E.x0 + ri * E.size;
    const z0 = E.z0 + rj * E.size;
    const m = buildTile(x0, z0, x0 + E.size, z0 + E.size, `EverestCoarse_${ri}_${rj}`, 16, mountainGroundMaterial);
    m.visible = false; // shown by ChunkLodSystem
    g.add(m);
    evCoarse.push(m);
  }
  // ... and all of them again as ONE mesh: what is drawn while the player is nowhere near the peak (one draw instead of one per root)
  if (evCoarse.length) {
    const all = new Mesh(mergeTileGeometries(evCoarse.map((m) => m.geometry)), mountainGroundMaterial);
    all.name = 'EverestCoarse_all';
    all.receiveShadow = true;
    all.visible = false; // shown by ChunkLodSystem
    g.add(all);
  }
  return g;
}

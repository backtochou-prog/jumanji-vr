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
import { BufferGeometry, Color, Float32BufferAttribute, Group, Mesh, Uint32BufferAttribute } from '@iwsdk/core';
import {
  MTN,
  MUD_PATCHES,
  TERRAIN_LOD,
  PATH_SAMPLES,
  TERRAIN,
  areaWeights,
  distanceToPath,
  fbm,
  groundBlend,
  pathHalfWidth,
  smoothstep,
  terrainHeight,
} from '../world/layout.js';
import { GEO, MTN_MUD, VALLEY, fallWetness, mountainTiles, mountainWeight, routeNear } from '../world/mountain.js';
import { PAL } from '../world/palette.js';
import { BAKED } from '../world/baked.js';
import { groundMaterial, mountainGroundMaterial } from './lib/materials.js';

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
const TINT = {
  entrance: new Color(0.8, 0.92, 0.96),
  trail: new Color(0.95, 1.0, 0.92),
  clearing: new Color(1.1, 1.05, 0.9),
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

/** Ground colour at a point. `slope` is rise/run; `y` (height) drives rock strata on the mountain. */
export function groundColor(x: number, z: number, slope: number, out: Color = tmp, y = 0): Color {
  const b = groundBlend(x, z, slope);
  const a = areaWeights(x, z);
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
  if (mountainWeight(x, z) > 0.02) mountainTint(x, z, y, slope, out);
  out.multiplyScalar(bakedAO(x, z));
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
  const near = routeNear(MTN, x, z).dist;
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
      groundColor(x, z, slope, c, hAt(i, j));
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
      // Lifted 7.5 cm: the terrain tiles interpolate linearly between their samples and would poke through a flush ribbon.
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
      groundColor(x, z, 0.1, g2, y);
      c.lerp(g2, smoothstep(0.55, 1.0, edge));
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
  const dz = (TERRAIN.z1 - TERRAIN.z0) / TILES_Z;
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
  return g;
}

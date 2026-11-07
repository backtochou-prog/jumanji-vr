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
  MUD_PATCHES,
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
import { PAL } from '../world/palette.js';
import { BAKED } from '../world/baked.js';
import { groundMaterial } from './lib/materials.js';

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
/** Ground colour at a point. `slope` is rise/run. */
export function groundColor(x: number, z: number, slope: number, out: Color = tmp): Color {
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

function buildTile(x0: number, z0: number, x1: number, z1: number, name: string): Mesh {
  const cell = tileCell(x0, z0, x1, z1);
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
  const skirt = 1.4;
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
      groundColor(x, z, Math.hypot(dhx, dhz), c);
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
  const m = new Mesh(g, groundMaterial);
  m.name = name;
  m.receiveShadow = true;
  return m;
}

// ---------------------------------------------------------------------------
// Trail ribbon
// ---------------------------------------------------------------------------

function createTrailGeometry(): BufferGeometry {
  const cols = 11;
  const rows = PATH_SAMPLES.length;
  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const dirt = new Color(PAL.soil).lerp(new Color(PAL.litter), 0.25);
  const dirtDark = new Color(PAL.soilDark);
  const packed = new Color('#6f5638');
  const mud = new Color(PAL.mud);
  const c = new Color();
  const g2 = new Color();
  let run = 0;
  for (let i = 0; i < rows; i++) {
    const [px, pz] = PATH_SAMPLES[i];
    const [nx, nz] = PATH_SAMPLES[Math.min(rows - 1, i + 1)];
    const [bx, bz] = PATH_SAMPLES[Math.max(0, i - 1)];
    const tx = nx - bx;
    const tz = nz - bz;
    const tl = Math.hypot(tx, tz) || 1;
    const sx = -tz / tl;
    const sz = tx / tl;
    const hw = pathHalfWidth(i) * (0.9 + 0.22 * fbm(px * 0.4, pz * 0.4, 31, 2));
    if (i > 0) run += Math.hypot(px - PATH_SAMPLES[i - 1][0], pz - PATH_SAMPLES[i - 1][1]);
    for (let j = 0; j < cols; j++) {
      const u = (j / (cols - 1)) * 2 - 1;
      const wobble = (fbm(px * 0.8 + j * 3.1, pz * 0.8, 33, 2) - 0.5) * 0.3;
      const x = px + sx * (u * hw + wobble);
      const z = pz + sz * (u * hw + wobble);
      // Lifted 7.5 cm: the terrain tiles interpolate linearly between 1.25 m samples and would poke through a flush ribbon.
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
      groundColor(x, z, 0.1, g2);
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

/** All ground meshes: terrain tiles + trail. Walkable (LocomotionEnvironment set in the scene). */
export function createTerrain(): Group {
  const g = new Group();
  g.name = 'JungleTerrain';
  const dx = (TERRAIN.x1 - TERRAIN.x0) / TILES_X;
  const dz = (TERRAIN.z1 - TERRAIN.z0) / TILES_Z;
  for (let j = 0; j < TILES_Z; j++) {
    for (let i = 0; i < TILES_X; i++) {
      const x0 = TERRAIN.x0 + i * dx;
      const z0 = TERRAIN.z0 + j * dz;
      g.add(buildTile(x0, z0, x0 + dx, z0 + dz, `Terrain_${i}_${j}`));
    }
  }
  const trail = new Mesh(createTrailGeometry(), groundMaterial);
  trail.name = 'DirtTrail';
  trail.receiveShadow = true;
  g.add(trail);
  return g;
}


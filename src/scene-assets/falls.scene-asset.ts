/**
 * The giant waterfall and the water around it (Prompt 04).
 *
 *   mountain-water   the river in the slot below the bridge, the plunge pool at the foot of the fall (a polygon
 *                    cut from the terrain where it lies below the pool level, so its shore is exact) and the valley river.
 *                    Same material as the jungle water (ripple bump scrolled by WaterSystem, vertex alpha, fresnel tint).
 *   giant-fall       the 52 m plunge: three sheets (a wide main fall and two narrow strands with different streak
 *                    density) that follow the near-vertical face with a slight outward bow, and the 38 m cascade
 *                    above the bridge. One material, scrolled by ScrollTexture on the node.
 *   fall-mist        additive mist: spray pool at the foot, rising cards, spray at the cascade foot and the brink.
 *                    Quality tier 'low' hides it (it is the only overdraw-heavy part).
 * All geometry is generated from the same terrain height the player walks on, so water meets rock exactly.
 */
import { BufferGeometry, Color, Float32BufferAttribute, Group, Mesh, Uint32BufferAttribute } from '@iwsdk/core';
import { terrainHeight } from '../world/layout.js';
import { BASIN_Y, D_BRINK, THETA_GORGE, VALLEY_RIVER, riverBedY, riverPoint, slotFloorHalf } from '../world/mountain.js';
import { PAL } from '../world/palette.js';
import { lightShaftMaterial, waterMaterial, waterfallMaterial } from './lib/materials.js';

const SHALLOW = new Color(PAL.waterShallow).lerp(new Color('#6f8f80'), 0.25);
const DEEP = new Color(PAL.waterDeep).lerp(new Color('#0f2d2a'), 0.3);

function waterMesh(positions: number[], colors: number[], uvs: number[], indices: number[], name: string): Mesh {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new Float32BufferAttribute(colors, 4));
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  if (g.getAttribute('normal').getY(0) < 0) {
    for (let i = 0; i < indices.length; i += 3) {
      const t = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = t;
    }
    g.setIndex(indices);
    g.computeVertexNormals();
  }
  g.computeBoundingBox();
  g.computeBoundingSphere();
  const m = new Mesh(g, waterMaterial);
  m.name = name;
  m.renderOrder = 2;
  return m;
}

/** A ribbon along a polyline: (x, z, y, half-width) rows, 7 columns, edges fading out. */
function ribbon(rows: { x: number; z: number; y: number; hw: number }[], out: { p: number[]; c: number[]; uv: number[]; i: number[] }, alpha = 0.8): void {
  const cols = 7;
  const base = out.p.length / 3;
  const col = new Color();
  let run = 0;
  rows.forEach((r, k) => {
    const a = rows[Math.max(0, k - 1)];
    const b = rows[Math.min(rows.length - 1, k + 1)];
    const tx = b.x - a.x;
    const tz = b.z - a.z;
    const tl = Math.hypot(tx, tz) || 1;
    const sx = -tz / tl;
    const sz = tx / tl;
    if (k > 0) run += Math.hypot(r.x - rows[k - 1].x, r.z - rows[k - 1].z);
    for (let j = 0; j < cols; j++) {
      const u = (j / (cols - 1)) * 2 - 1;
      out.p.push(r.x + sx * u * r.hw, r.y, r.z + sz * u * r.hw);
      out.uv.push(u * 0.5 + 0.5, run * 0.25);
      const e = Math.abs(u);
      col.copy(DEEP).lerp(SHALLOW, e * e);
      out.c.push(col.r, col.g, col.b, e > 0.6 ? Math.max(0, alpha * (1 - (e - 0.6) / 0.4)) : alpha);
    }
  });
  for (let i = 0; i < rows.length - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = base + i * cols + j;
      out.i.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1);
    }
  }
}

/** The river in the slot, the plunge pool and the valley river, as one mesh (one draw). */
export function createMountainWater(): Mesh {
  const out = { p: [] as number[], c: [] as number[], uv: [] as number[], i: [] as number[] };
  // 1. Slot river: from the foot of the cascade to the brink, following the bed.
  const slot: { x: number; z: number; y: number; hw: number }[] = [];
  for (let d = 108; d >= D_BRINK - 0.5; d -= 2) {
    const [x, z] = riverPoint(d);
    slot.push({ x, z, y: riverBedY(d) + 0.3, hw: slotFloorHalf(d) * 0.98 });
  }
  ribbon(slot, out);
  // 2. Plunge pool: every terrain cell below the pool level (so the shore is exact), alpha by depth.
  const [cx, cz] = riverPoint(54);
  const R = 26;
  const cell = 1.6;
  const n = Math.ceil((R * 2) / cell);
  const level = BASIN_Y;
  const h = new Float32Array((n + 1) * (n + 1));
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) h[j * (n + 1) + i] = terrainHeight(cx - R + i * cell, cz - R + j * cell);
  const vid = new Int32Array((n + 1) * (n + 1)).fill(-1);
  const col = new Color();
  const vert = (i: number, j: number): number => {
    const k = j * (n + 1) + i;
    if (vid[k] >= 0) return vid[k];
    vid[k] = out.p.length / 3;
    out.p.push(cx - R + i * cell, level, cz - R + j * cell);
    out.uv.push((cx - R + i * cell) * 0.12, (cz - R + j * cell) * 0.12);
    const depth = Math.max(0, level - h[k]);
    col.copy(SHALLOW).lerp(DEEP, Math.min(1, depth / 1.6));
    out.c.push(col.r, col.g, col.b, Math.min(0.86, 0.15 + depth * 0.7));
    return vid[k];
  };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const lo = Math.min(h[j * (n + 1) + i], h[j * (n + 1) + i + 1], h[(j + 1) * (n + 1) + i], h[(j + 1) * (n + 1) + i + 1]);
      const hi = Math.max(h[j * (n + 1) + i], h[j * (n + 1) + i + 1], h[(j + 1) * (n + 1) + i], h[(j + 1) * (n + 1) + i + 1]);
      if (lo > level - 0.05 || hi > level + 1.5) continue; // dry, or the cell straddles a bank (skip: the shoreline fades by alpha)
      const a = vert(i, j);
      const b = vert(i + 1, j);
      const c = vert(i, j + 1);
      const d = vert(i + 1, j + 1);
      out.i.push(a, c, b, b, c, d);
    }
  }
  // 3. Valley river: out of the pool, level with the carved channel (never rising downstream).
  const rows: { x: number; z: number; y: number; hw: number }[] = [];
  let y = Infinity;
  for (let k = 6; k < VALLEY_RIVER.length; k += 2) {
    const [x, z] = VALLEY_RIVER[k];
    y = Math.min(y, terrainHeight(x, z) + 0.72);
    rows.push({ x, z, y, hw: 3.4 + 0.5 * Math.sin(k * 0.4) });
  }
  ribbon(rows, out, 0.78);
  return waterMesh(out.p, out.c, out.uv, out.i, 'MountainWater');
}

// ---------------------------------------------------------------------------
// The fall
// ---------------------------------------------------------------------------

/** Sheet following a profile (distance-from-valley-centre d, height h) with an outward offset; lateral half-width by t. */
function sheet(profile: { d: number; h: number }[], rows: number, widthAt: (t: number) => number, offset: number, bow: number, lateral: number, vScale: number, uTiles: number, name: string): Mesh {
  // arc-length parametrisation of the (d, h) profile
  const len = [0];
  for (let i = 1; i < profile.length; i++) len.push(len[i - 1] + Math.hypot(profile[i].d - profile[i - 1].d, profile[i].h - profile[i - 1].h));
  const L = len[len.length - 1];
  const at = (s: number) => {
    let i = 1;
    while (i < len.length - 1 && len[i] < s) i++;
    const u = (s - len[i - 1]) / (len[i] - len[i - 1] || 1);
    const a = profile[i - 1];
    const b = profile[i];
    return { d: a.d + (b.d - a.d) * u, h: a.h + (b.h - a.h) * u, tx: b.d - a.d, th: b.h - a.h };
  };
  const ax = Math.cos(THETA_GORGE);
  const az = Math.sin(THETA_GORGE);
  const lx = -az;
  const lz = ax;
  const positions: number[] = [];
  const uvs: number[] = [];
  const fall: number[] = []; // aFall = (lateral -1 | +1, t, foam): read by the waterfall shader, which every sheet must feed
  const indices: number[] = [];
  for (let k = 0; k <= rows; k++) {
    const t = k / rows;
    const p = at(t * L);
    const tl = Math.hypot(p.tx, p.th) || 1;
    // profile runs towards decreasing d and falling; the air side is (-th, +td) rotated: (d: -|th|, h: +|td|)
    const nd = -Math.abs(p.th) / tl;
    const nh = Math.abs(p.tx) / tl;
    const off = offset + bow * Math.sin(Math.PI * t);
    const d = p.d + nd * off;
    const base = riverPoint(Math.max(20, d));
    const w = widthAt(t) + lateral;
    positions.push(base[0] - lx * w, p.h + nh * off, base[1] - lz * w, base[0] + lx * w, p.h + nh * off, base[1] + lz * w);
    uvs.push(0, t * (L / vScale), uTiles, t * (L / vScale));
    // white water where the fall leaves the lip and where it lands
    const foam = Math.max(0.4 * (1 - Math.min(1, t / 0.04)), 0.9 * Math.min(1, Math.max(0, (t - 0.9) / 0.1)));
    fall.push(-1, t, foam, 1, t, foam);
  }
  for (let i = 0; i < rows; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  g.setAttribute('aFall', new Float32BufferAttribute(fall, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  const m = new Mesh(g, waterfallMaterial);
  m.name = name;
  return m;
}

function axisProfile(dFrom: number, dTo: number, step: number, lift = 0): { d: number; h: number }[] {
  const out: { d: number; h: number }[] = [];
  for (let d = dFrom; d >= dTo; d -= step) {
    const [x, z] = riverPoint(d);
    out.push({ d, h: terrainHeight(x, z) + lift });
  }
  return out;
}

/** Merge sheet meshes that share the waterfall material into one geometry (one draw). */
function mergeSheets(meshes: Mesh[], name: string): Mesh {
  let vc = 0;
  let ic = 0;
  for (const m of meshes) {
    vc += m.geometry.getAttribute('position').count;
    ic += m.geometry.index!.count;
  }
  const pos = new Float32Array(vc * 3);
  const nor = new Float32Array(vc * 3);
  const uv = new Float32Array(vc * 2);
  const fall = new Float32Array(vc * 3);
  const idx = new Uint32Array(ic);
  let vo = 0;
  let io = 0;
  for (const m of meshes) {
    const g = m.geometry;
    pos.set(g.getAttribute('position').array as Float32Array, vo * 3);
    nor.set(g.getAttribute('normal').array as Float32Array, vo * 3);
    uv.set(g.getAttribute('uv').array as Float32Array, vo * 2);
    fall.set(g.getAttribute('aFall').array as Float32Array, vo * 3);
    for (let i = 0; i < g.index!.count; i++) idx[io + i] = g.index!.getX(i) + vo;
    io += g.index!.count;
    vo += g.getAttribute('position').count;
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  geo.setAttribute('aFall', new Float32BufferAttribute(fall, 3));
  geo.setIndex(new Uint32BufferAttribute(idx, 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const out = new Mesh(geo, waterfallMaterial);
  out.name = name;
  return out;
}

/**
 * The fall as TWO alternative meshes, one draw each: `FallNear` (plunge: main sheet + two strands; cascade: main + strand) within
 * FALL_NEAR_RADIUS of the player, `FallFar` (the two main sheets only) beyond it. ChunkLodSystem swaps them.
 */
export function createGiantFall(): Group {
  const g = new Group();
  g.name = 'GiantFall';
  const plunge = axisProfile(D_BRINK + 1.2, 52, 0.25, 0);
  const cascade = axisProfile(130, 104, 0.5, 0);
  const mainP = sheet(plunge, 22, (t) => 4.6 + 2.2 * t, 0.85, 0.9, 0, 6.5, 1, 'FallMain');
  const mainC = sheet(cascade, 14, (t) => 3.0 + 1.2 * t, 0.45, 0.4, 0, 5.5, 1, 'CascadeMain');
  const near = mergeSheets(
    [
      mainP,
      sheet(plunge, 18, (t) => 1.2 + 0.6 * t, 1.5, 1.4, 5.6, 5.0, 2, 'FallStrandL'),
      sheet(plunge, 18, (t) => 1.0 + 0.5 * t, 1.7, 1.3, -5.2, 4.3, 3, 'FallStrandR'),
      mainC,
      sheet(cascade, 12, (t) => 0.9, 0.7, 0.6, 2.6, 4.2, 2, 'CascadeStrand'),
    ],
    'FallNear',
  );
  const far = mergeSheets(
    [sheet(plunge, 8, (t) => 4.6 + 2.2 * t, 0.85, 0.9, 0, 6.5, 1, 'FallMain'), sheet(cascade, 5, (t) => 3.0 + 1.2 * t, 0.45, 0.4, 0, 5.5, 1, 'CascadeMain')],
    'FallFar',
  );
  far.visible = false;
  g.add(near, far);
  return g;
}

// ---------------------------------------------------------------------------
// Mist (additive, vertex-colour brightness only)
// ---------------------------------------------------------------------------

function mistDisc(cx: number, y: number, cz: number, r: number, k: number, tint: [number, number, number], parts: { p: number[]; c: number[]; i: number[] }): void {
  const base = parts.p.length / 3;
  const seg = 18;
  parts.p.push(cx, y, cz);
  parts.c.push(k * tint[0], k * tint[1], k * tint[2]);
  for (let j = 0; j < seg; j++) {
    const a = (j / seg) * Math.PI * 2;
    parts.p.push(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r);
    parts.c.push(0, 0, 0);
  }
  for (let j = 0; j < seg; j++) parts.i.push(base, base + 1 + j, base + 1 + ((j + 1) % seg));
}

function mistCard(cx: number, y0: number, cz: number, yaw: number, w: number, h: number, k: number, tint: [number, number, number], parts: { p: number[]; c: number[]; i: number[] }): void {
  const base = parts.p.length / 3;
  const sx = Math.cos(yaw) * w * 0.5;
  const sz = Math.sin(yaw) * w * 0.5;
  parts.p.push(cx - sx, y0, cz - sz, cx + sx, y0, cz + sz, cx - sx * 0.7, y0 + h, cz - sz * 0.7, cx + sx * 0.7, y0 + h, cz + sz * 0.7);
  parts.c.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  // Bright band low in the card, fading to nothing at the edges and the top (edges are black = invisible when additive).
  parts.p.push(cx, y0 + h * 0.18, cz);
  parts.c.push(k * tint[0], k * tint[1], k * tint[2]);
  parts.i.push(base, base + 1, base + 4, base + 1, base + 3, base + 4, base + 3, base + 2, base + 4, base + 2, base, base + 4);
}

export function createFallMist(): Mesh {
  const parts = { p: [] as number[], c: [] as number[], i: [] as number[] };
  const tint: [number, number, number] = [0.78, 0.92, 0.96];
  const [px, pz] = riverPoint(54);
  // Plunge pool: a wide spray bank on the water and cards rising from the impact.
  mistDisc(px, BASIN_Y + 0.6, pz, 10, 0.11, tint, parts);
  const [ix, iz] = riverPoint(61);
  for (let k = 0; k < 6; k++) mistCard(ix + Math.cos(k * 2.1) * 3, BASIN_Y + 0.5, iz + Math.sin(k * 2.1) * 3, k * 0.8, 13, 18, 0.1, tint, parts);
  // Cascade foot (just upstream of the bridge): a cloud around the impact.
  const [cxm, czm] = riverPoint(108);
  const cy = riverBedY(108) + 0.8;
  mistDisc(cxm, cy, czm, 6, 0.1, tint, parts);
  for (let k = 0; k < 3; k++) mistCard(cxm + Math.cos(k * 2.4) * 1.6, cy, czm + Math.sin(k * 2.4) * 1.6, k * 1.1, 10, 11, 0.15, tint, parts);
  // Brink: a little spray where the water leaves the lip.
  const [bx, bz] = riverPoint(D_BRINK - 1);
  mistDisc(bx, riverBedY(D_BRINK) + 0.6, bz, 4, 0.06, tint, parts);
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(parts.p, 3));
  geo.setAttribute('color', new Float32BufferAttribute(parts.c, 3));
  geo.setIndex(parts.i);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const m = new Mesh(geo, lightShaftMaterial);
  m.name = 'FallMist';
  m.renderOrder = 3;
  return m;
}

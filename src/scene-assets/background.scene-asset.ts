/**
 * Background depth: layered jungle ridge silhouettes ringing the world.
 *
 * Three rings (80 / 100 / 120 m from the middle of the walkable area), each a
 * 2-sided vertical strip with a jagged tree-line top. Vertex colour fades from
 * deep green (near) to the fog tint (far) so the layers separate through
 * atmospheric perspective: the classic painted-backdrop depth cue, for under
 * 1500 triangles and three draw calls. Unlit (basic material), fogged.
 */
import { BufferGeometry, Color, Float32BufferAttribute, Mesh, Uint32BufferAttribute } from '@iwsdk/core';
import { fbm, makeRandom, smoothstep } from '../world/layout.js';
import { FOG_COLOR, PAL } from '../world/palette.js';
import { silhouetteMaterial } from './lib/materials.js';

export const RIDGE_CENTER = { x: 0, z: -35 };
export const RIDGE_RINGS = [
  { r: 84, h: 46, mix: 0.42, seed: 1 },
  { r: 102, h: 62, mix: 0.62, seed: 2 },
  { r: 120, h: 80, mix: 0.8, seed: 3 },
];

export function createRidge(layer: number): Mesh {
  const L = RIDGE_RINGS[layer];
  const cols = 220;
  const rng = makeRandom(900 + layer);
  const deep = new Color(PAL.leafDeep).lerp(new Color(PAL.leafShade), 0.35);
  const fog = new Color(FOG_COLOR);
  const base = deep.clone().lerp(fog, L.mix);
  const top = new Color(PAL.leafMid).lerp(fog, L.mix + 0.04);
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const phases = [rng() * 6.28, rng() * 6.28, rng() * 6.28];
  for (let i = 0; i <= cols; i++) {
    const a = (i / cols) * Math.PI * 2;
    // Rolling hills + individual crowns (sharp tops) + broken tree-line.
    const hill = fbm(Math.cos(a) * 3 + L.seed * 7, Math.sin(a) * 3, 60 + L.seed, 3);
    const crowns = Math.pow(Math.abs(Math.sin(a * 53 + phases[0]) * Math.sin(a * 29 + phases[1])), 0.6) * 0.28 + 0.12 * Math.abs(Math.sin(a * 97 + phases[2]));
    const h = L.h * (0.55 + 0.75 * hill) * (1 + crowns * 0.5);
    const x = RIDGE_CENTER.x + Math.cos(a) * L.r;
    const z = RIDGE_CENTER.z + Math.sin(a) * L.r;
    positions.push(x, -14, z, x, h, z);
    colors.push(base.r, base.g, base.b, top.r, top.g, top.b);
  }
  for (let i = 0; i < cols; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  g.setIndex(indices);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  const m = new Mesh(g, silhouetteMaterial);
  m.name = `Ridge_${layer}`;
  m.frustumCulled = false; // ring: always partly in view; 3 draws total
  return m;
}

// ---------------------------------------------------------------------------
// Far mountain ranges (visible from the summit and the descent: the far plane opens up there)
// ---------------------------------------------------------------------------

/** Four layered ranges, 420 - 900 m from the valley centre. Ridged noise gives real peaks, not rolling hills. */
export const FAR_RANGES = [
  { r: 430, h: 120, mix: 0.46, seed: 11 },
  { r: 560, h: 170, mix: 0.62, seed: 12 },
  { r: 720, h: 230, mix: 0.76, seed: 13 },
  { r: 900, h: 300, mix: 0.88, seed: 14 },
];
const FAR_CENTER = { x: 190, z: -100 };

export function createFarRange(layer: number): Mesh {
  const L = FAR_RANGES[layer];
  const cols = 260;
  const fog = new Color(FOG_COLOR).lerp(new Color('#b4cbd0'), 0.6);
  const base = new Color(PAL.leafDeep).lerp(new Color('#3b5560'), 0.45).lerp(fog, L.mix);
  const top = new Color('#5d7c7a').lerp(fog, L.mix + 0.04);
  const snow = new Color('#d4dedb').lerp(fog, L.mix * 0.8);
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= cols; i++) {
    const a = (i / cols) * Math.PI * 2;
    const nx = Math.cos(a) * 2.2 + L.seed * 5;
    const nz = Math.sin(a) * 2.2;
    const ridged = 1 - Math.abs(fbm(nx, nz, 120 + L.seed, 4) * 2 - 1);
    const mass = fbm(nx * 0.5, nz * 0.5, 140 + L.seed, 2);
    const h = L.h * (0.25 + 0.95 * Math.pow(ridged, 1.7) * (0.55 + 0.7 * mass));
    const x = FAR_CENTER.x + Math.cos(a) * L.r;
    const z = FAR_CENTER.z + Math.sin(a) * L.r;
    positions.push(x, -60, z, x, h - 40, z);
    colors.push(base.r, base.g, base.b);
    const c = top.clone().lerp(snow, smoothstep(0.62, 0.95, h / L.h) * 0.35);
    colors.push(c.r, c.g, c.b);
  }
  for (let i = 0; i < cols; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  g.setIndex(indices);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  const m = new Mesh(g, silhouetteMaterial);
  m.name = `FarRange_${layer}`;
  m.frustumCulled = false;
  return m;
}

/** All four far ranges as ONE mesh (one draw): the layers differ only by vertex colour. */
export function createFarRanges(): Mesh {
  const parts = FAR_RANGES.map((_, i) => createFarRange(i).geometry);
  let vc = 0;
  let ic = 0;
  for (const g of parts) {
    vc += g.getAttribute('position').count;
    ic += g.index!.count;
  }
  const pos = new Float32Array(vc * 3);
  const col = new Float32Array(vc * 3);
  const idx = new Uint32Array(ic);
  let vo = 0;
  let io = 0;
  for (const g of parts) {
    pos.set(g.getAttribute('position').array as Float32Array, vo * 3);
    col.set(g.getAttribute('color').array as Float32Array, vo * 3);
    for (let i = 0; i < g.index!.count; i++) idx[io + i] = g.index!.getX(i) + vo;
    io += g.index!.count;
    vo += g.getAttribute('position').count;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.setIndex(new Uint32BufferAttribute(idx, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  const m = new Mesh(g, silhouetteMaterial);
  m.name = 'FarRanges';
  m.frustumCulled = false;
  return m;
}

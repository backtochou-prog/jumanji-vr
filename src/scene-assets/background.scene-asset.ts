/**
 * Background depth: layered jungle ridge silhouettes ringing the world.
 *
 * Three rings (125 / 147 / 172 m from (0,-25)), each a 2-sided vertical strip with a jagged tree-line top. They are centred so that the whole terrain
 * rectangle (x +-70, z -112..62; farthest corner 112 m away) lies INSIDE ring 0 (no strip pokes through the ground), the Overlook Knoll (z 31) is >= 69 m
 * from the nearest ridge and the backdrop cliff (z -51..-97) is well in front of the north side. Three vertex rows per ring: a fog-coloured foot (so
 * the layers rise out of the haze), a hazy leaf-green belt and the crown, which catches a warm rim on the sunward side. Heights taper toward the cliff
 * (so the fall keeps its sky) and, less, toward the sun. Vertex colour carries the atmospheric perspective: deep green (near) -> fog tint (far); the mix
 * values were tuned for the thinner knoll fog (the rings are farther away now, so the runtime fog already hazes them more).
 * 2640 triangles and three draw calls. Unlit (basic material), fogged.
 */
import { BufferGeometry, Color, Float32BufferAttribute, Mesh, Uint32BufferAttribute } from '@iwsdk/core';
import { fbm, makeRandom, smoothstep } from '../world/layout.js';
import { FOG_COLOR, PAL, SUN_DIR } from '../world/palette.js';
import { silhouetteMaterial } from './lib/materials.js';

export const RIDGE_CENTER = { x: 0, z: -25 };
export const RIDGE_RINGS = [
  { r: 125, h: 50, mix: 0.38, seed: 1 },
  { r: 147, h: 66, mix: 0.58, seed: 2 },
  { r: 172, h: 84, mix: 0.76, seed: 3 },
];
/** Ring angle (x = cos a, z = sin a) of the backdrop cliff seen from the ring centre, and of the sun. */
const CLIFF_ANGLE = Math.atan2(-96 - RIDGE_CENTER.z, 5 - RIDGE_CENTER.x);
const SUN_ANGLE = Math.atan2(-SUN_DIR[2], -SUN_DIR[0]);
const angleDiff = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
/** Foot of the strip (m): far below the terrain, in the fog colour. */
const RIDGE_FOOT = -24;

export function createRidge(layer: number): Mesh {
  const L = RIDGE_RINGS[layer];
  const cols = 220;
  const rng = makeRandom(900 + layer);
  const deep = new Color(PAL.leafDeep).lerp(new Color(PAL.leafShade), 0.35);
  const fog = new Color(FOG_COLOR);
  const top = new Color(PAL.leafMid).lerp(fog, L.mix + 0.04);
  const foot = deep.clone().lerp(fog, 0.9);
  const mid = deep.clone().lerp(new Color(PAL.leafShade), 0.3).lerp(fog, L.mix + 0.1);
  const warm = new Color('#ffd9a0');
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const phases = [rng() * 6.28, rng() * 6.28, rng() * 6.28];
  const crown = new Color();
  for (let i = 0; i <= cols; i++) {
    const a = (i / cols) * Math.PI * 2;
    // Rolling hills + individual crowns (sharp tops) + broken tree-line.
    const hill = fbm(Math.cos(a) * 3 + L.seed * 7, Math.sin(a) * 3, 60 + L.seed, 3);
    const crowns = Math.pow(Math.abs(Math.sin(a * 53 + phases[0]) * Math.sin(a * 29 + phases[1])), 0.6) * 0.28 + 0.12 * Math.abs(Math.sin(a * 97 + phases[2]));
    // lower toward the cliff (its fall keeps the sky around it) and a little toward the sun; tall flanks keep the enclosure
    const taper = (0.45 + 0.55 * smoothstep(0.4, 1.2, angleDiff(a, CLIFF_ANGLE))) * (0.75 + 0.25 * smoothstep(0.35, 1.0, angleDiff(a, SUN_ANGLE)));
    const h = L.h * (0.55 + 0.75 * hill) * (1 + crowns * 0.5) * taper;
    const x = RIDGE_CENTER.x + Math.cos(a) * L.r;
    const z = RIDGE_CENTER.z + Math.sin(a) * L.r;
    // warm rim on the crown, strongest on the sunward side
    const rim = Math.pow(Math.max(Math.cos(a - SUN_ANGLE), 0), 2) * 0.22;
    crown.copy(top).lerp(warm, rim);
    positions.push(x, RIDGE_FOOT, z, x, h * 0.42, z, x, h, z);
    colors.push(foot.r, foot.g, foot.b, mid.r, mid.g, mid.b, crown.r, crown.g, crown.b);
  }
  for (let i = 0; i < cols; i++) {
    const a = i * 3;
    const n = a + 3;
    // two strips per column: foot -> belt, belt -> crown
    indices.push(a, a + 1, n, a + 1, n + 1, n, a + 1, a + 2, n + 1, a + 2, n + 2, n + 1);
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

/**
 * Procedural leaf atlas: ONE 512x512 RGBA texture holding every foliage shape
 * (broad leaf, palm frond, fern frond, ground-cover leaves, vine leaves,
 * canopy clump, moss patch, leaf litter, flowers, grass). All foliage cards in
 * the jungle share it, so foliage is a single material and (mostly) one
 * texture fetch. ~1.4 MB with mipmaps.
 *
 * Shapes are analytic (no image files, no canvas/DOM), so the atlas is built
 * deterministically in both SDK realms. Alpha is a soft-edged coverage mask for
 * alpha-TEST (cutout), never blended. RGB is a mid-value green/brown shading
 * pattern (veins, leaflet edges); vertex colours tint it per species.
 */
import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, SRGBColorSpace, UnsignedByteType } from '@iwsdk/core';
import { makeRandom } from '../../world/layout.js';

export const ATLAS_SIZE = 512;
const GRID = 4; // 4 x 4 tiles of 128 px
const TILE = ATLAS_SIZE / GRID;
const PAD = 5; // transparent margin (px) so mip-mapping does not bleed neighbours

export type LeafTile =
  | 'broad'
  | 'palm'
  | 'fern'
  | 'clover'
  | 'vine'
  | 'clump'
  | 'moss'
  | 'litter'
  | 'flowers'
  | 'grass'
  | 'heart'
  | 'frond2'
  | 'bark';

const TILE_INDEX: Record<LeafTile, number> = {
  broad: 0,
  palm: 1,
  fern: 2,
  clover: 3,
  vine: 4,
  clump: 5,
  moss: 6,
  litter: 7,
  flowers: 8,
  grass: 9,
  heart: 10,
  frond2: 11,
  bark: 12,
};

/** UV rectangle (u0, v0, u1, v1) of a tile, inset by the padding. */
export function tileUV(tile: LeafTile): [number, number, number, number] {
  const i = TILE_INDEX[tile];
  const cx = i % GRID;
  const cy = Math.floor(i / GRID);
  const pad = PAD / ATLAS_SIZE;
  const u0 = cx / GRID + pad;
  const v0 = cy / GRID + pad;
  const u1 = (cx + 1) / GRID - pad;
  const v1 = (cy + 1) / GRID - pad;
  return [u0, v0, u1, v1];
}

type Pix = { r: number; g: number; b: number; a: number };
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const sstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const cover = (d: number, soft = 0.05) => 1 - sstep(0, soft, d); // d = signed distance (<0 inside)

/** Tile painters: (u, v) in 0..1 (v up the card) -> RGBA 0..1. */
const painters: Record<LeafTile, (u: number, v: number) => Pix> = {
  // Ovate leaf with midrib and lateral veins.
  broad: (u, v) => {
    const w = 0.43 * Math.pow(Math.sin(Math.PI * Math.pow(clamp(v), 0.72)), 0.85);
    const x = Math.abs(u - 0.5);
    const a = cover(x - w, 0.03) * (v > 0.02 && v < 0.99 ? 1 : 0);
    const rib = Math.exp(-Math.pow(x / 0.012, 2));
    const vein = Math.pow(Math.abs(Math.sin((v * 9 + x * 5.5) * Math.PI)), 12) * 0.35 * (x < w ? 1 : 0);
    const shade = 0.62 + 0.28 * (1 - x / Math.max(w, 0.01)) + rib * 0.25 + vein * 0.2;
    return { r: shade * 0.82, g: shade, b: shade * 0.58, a };
  },
  // Heart-shaped / arrow leaf (alocasia-like).
  heart: (u, v) => {
    const x = (u - 0.5) * 2;
    const y = (v - 0.46) * 2.1;
    const k = x * x + Math.pow(y - Math.sqrt(Math.abs(x)) * 0.62, 2);
    const d = Math.sqrt(k) - 0.82;
    const a = cover(d, 0.06) * (v > 0.04 ? 1 : 0);
    const rib = Math.exp(-Math.pow(x / 0.02, 2)) * 0.3;
    const vein = Math.pow(Math.abs(Math.sin((Math.atan2(x, y) * 7 + v * 4) * 1.0)), 10) * 0.2;
    const shade = 0.6 + 0.25 * (1 - Math.abs(x)) + rib + vein;
    return { r: shade * 0.8, g: shade, b: shade * 0.55, a };
  },
  // Pinnate palm frond: arching rachis, long narrow leaflets angled to the tip.
  palm: (u, v) => {
    const x = u - 0.5;
    const env = 0.46 * Math.pow(Math.sin(Math.PI * Math.pow(clamp(v), 0.6)), 0.7) * (1 - 0.35 * v);
    const ax = Math.abs(x);
    const lf = Math.sin((v * 26 - ax * 9) * Math.PI);
    const leaflet = sstep(-0.18, 0.32, lf);
    const a = Math.max(cover(ax - 0.012, 0.01) * 0.95, cover(ax - env, 0.02) * leaflet * sstep(0.02, 0.05, ax)) * (v > 0.01 && v < 0.99 ? 1 : 0);
    const shade = 0.55 + 0.35 * leaflet + (ax < 0.014 ? 0.25 : 0);
    return { r: shade * 0.85, g: shade, b: shade * 0.6, a };
  },
  // Bipinnate fern frond: finer leaflets, serrated.
  fern: (u, v) => {
    const x = u - 0.5;
    const ax = Math.abs(x);
    const env = 0.45 * Math.pow(Math.sin(Math.PI * Math.pow(clamp(v), 0.55)), 0.8) * (1 - 0.55 * v);
    const lf = Math.sin((v * 30 - ax * 7) * Math.PI);
    const sub = Math.sin((v * 30 - ax * 7) * Math.PI * 3.2 + ax * 40);
    const leaflet = sstep(-0.1, 0.35, lf) * (0.78 + 0.22 * sstep(-0.4, 0.4, sub));
    const a = Math.max(cover(ax - 0.01, 0.008) * 0.95, cover(ax - env, 0.02) * leaflet * sstep(0.015, 0.04, ax)) * (v > 0.01 && v < 0.99 ? 1 : 0);
    const shade = 0.5 + 0.38 * leaflet + (ax < 0.012 ? 0.2 : 0);
    return { r: shade * 0.8, g: shade, b: shade * 0.5, a };
  },
  // Wider frond (tree fern / sago): broader leaflets.
  frond2: (u, v) => {
    const x = u - 0.5;
    const ax = Math.abs(x);
    const env = 0.47 * Math.pow(Math.sin(Math.PI * Math.pow(clamp(v), 0.65)), 0.75) * (1 - 0.25 * v);
    const lf = Math.sin((v * 17 - ax * 6) * Math.PI);
    const leaflet = sstep(-0.35, 0.2, lf);
    const a = Math.max(cover(ax - 0.014, 0.01), cover(ax - env, 0.02) * leaflet * sstep(0.02, 0.05, ax)) * (v > 0.01 && v < 0.99 ? 1 : 0);
    const shade = 0.58 + 0.3 * leaflet;
    return { r: shade * 0.82, g: shade, b: shade * 0.55, a };
  },
  // Cluster of small round leaves (clover / oxalis).
  clover: (u, v) => {
    let a = 0;
    let shade = 0.7;
    const rng = makeRandom(31);
    for (let i = 0; i < 9; i++) {
      const cx = 0.2 + rng() * 0.6;
      const cy = 0.2 + rng() * 0.6;
      const r = 0.1 + rng() * 0.07;
      const d = Math.hypot(u - cx, v - cy) / r - 1;
      const c = cover(d, 0.18);
      if (c > a) {
        a = c;
        shade = 0.55 + 0.35 * (1 - Math.hypot(u - cx, v - cy) / r) + 0.08 * Math.sin((i + 1) * 3);
      }
    }
    return { r: shade * 0.82, g: shade, b: shade * 0.55, a };
  },
  // Vine: curved stem with heart-shaped leaves.
  vine: (u, v) => {
    const stem = Math.abs(u - (0.5 + 0.18 * Math.sin(v * 5))) - 0.012;
    let a = cover(stem, 0.01);
    let shade = 0.4;
    const rng = makeRandom(77);
    for (let i = 0; i < 6; i++) {
      const cy = 0.12 + i * 0.15;
      const cx = 0.5 + 0.18 * Math.sin(cy * 5) + (i % 2 ? 0.14 : -0.14);
      const dx = (u - cx) / 0.12;
      const dy = (v - cy) / 0.08;
      const d = Math.sqrt(dx * dx + Math.pow(dy - Math.sqrt(Math.abs(dx)) * 0.4, 2)) - 1;
      const c = cover(d, 0.15);
      if (c > a) {
        a = c;
        shade = 0.6 + 0.3 * rng();
      }
    }
    return { r: shade * 0.8, g: shade, b: shade * 0.55, a };
  },
  // Dense clump of many small leaves: crown foliage. Soft irregular silhouette.
  clump: (u, v) => {
    let a = 0;
    let shade = 0.5;
    const rng = makeRandom(5);
    for (let i = 0; i < 46; i++) {
      const ang = rng() * Math.PI * 2;
      const rad = Math.sqrt(rng()) * 0.38;
      const cx = 0.5 + Math.cos(ang) * rad;
      const cy = 0.5 + Math.sin(ang) * rad * 0.9;
      const rot = rng() * Math.PI;
      const dx = u - cx;
      const dy = v - cy;
      const lx = dx * Math.cos(rot) + dy * Math.sin(rot);
      const ly = -dx * Math.sin(rot) + dy * Math.cos(rot);
      const d = Math.sqrt(Math.pow(lx / 0.075, 2) + Math.pow(ly / 0.035, 2)) - 1;
      const c = cover(d, 0.2);
      if (c > a * 0.98) {
        a = Math.max(a, c);
        shade = 0.42 + 0.5 * rng() * (0.55 + 0.7 * (1 - Math.hypot(u - 0.5, v - 0.5) * 1.8));
      }
    }
    return { r: shade * 0.8, g: shade, b: shade * 0.5, a };
  },
  // Soft irregular moss / lichen blob.
  moss: (u, v) => {
    const d = Math.hypot(u - 0.5, v - 0.5) * 2;
    const n = 0.18 * Math.sin(u * 23 + v * 11) + 0.12 * Math.sin(u * 41 - v * 29) + 0.08 * Math.sin(u * 67 + v * 53);
    const a = cover(d - 0.7 - n * 1.1, 0.2) * (0.88 + 0.12 * Math.sin(u * 90) * Math.sin(v * 90));
    const shade = 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(u * 60 + v * 47) * Math.sin(u * 37 - v * 71));
    return { r: shade * 0.85, g: shade, b: shade * 0.55, a: a > 0.45 ? a : a * 0.4 };
  },
  // Scattered fallen leaves (brown / ochre).
  litter: (u, v) => {
    let a = 0;
    let shade = 0.6;
    let hue = 0;
    const rng = makeRandom(91);
    for (let i = 0; i < 16; i++) {
      const cx = 0.12 + rng() * 0.76;
      const cy = 0.12 + rng() * 0.76;
      const rot = rng() * Math.PI;
      const dx = u - cx;
      const dy = v - cy;
      const lx = dx * Math.cos(rot) + dy * Math.sin(rot);
      const ly = -dx * Math.sin(rot) + dy * Math.cos(rot);
      const half = 0.075 + rng() * 0.04;
      const t = (lx / half + 1) / 2;
      const w = 0.4 * half * Math.sin(Math.PI * clamp(t));
      const d = Math.abs(ly) - w;
      const c = t > 0 && t < 1 ? cover(d, 0.012) : 0;
      if (c > a) {
        a = c;
        shade = 0.5 + 0.4 * rng();
        hue = rng();
      }
    }
    return { r: shade * (0.95 + 0.15 * hue), g: shade * (0.7 + 0.2 * hue), b: shade * 0.45, a };
  },
  // Small flowers on stems: the one warm accent. Tinted by vertex colour; stored near-white.
  flowers: (u, v) => {
    let a = 0;
    let r = 0.3;
    let g = 0.55;
    let b = 0.25;
    const rng = makeRandom(13);
    for (let i = 0; i < 6; i++) {
      const cx = 0.14 + rng() * 0.72;
      const cy = 0.5 + rng() * 0.34;
      // stem
      const sx = Math.abs(u - cx - (v - cy) * 0.15) - 0.006;
      const stemOn = v < cy && v > 0.04 ? cover(sx, 0.006) : 0;
      if (stemOn > a) {
        a = stemOn;
        r = 0.22;
        g = 0.5;
        b = 0.2;
      }
      // five-petal bloom
      const dx = u - cx;
      const dy = v - cy;
      const ang = Math.atan2(dy, dx);
      const rad = Math.hypot(dx, dy);
      const petal = 0.045 + 0.02 * Math.cos(ang * 5);
      const c = cover(rad - petal, 0.012);
      if (c > a) {
        a = c;
        const core = rad < 0.014 ? 1 : 0;
        r = core ? 0.98 : 0.95;
        g = core ? 0.82 : 0.5;
        b = core ? 0.2 : 0.14;
      }
    }
    return { r, g, b, a };
  },
  // Neutral opaque tile: trunks, stems and branches map here so wood shares the foliage material/draw call.
  bark: (u, v) => {
    const n = 0.78 + 0.1 * Math.sin(u * 37 + v * 11) * Math.sin(v * 29 - u * 13) + 0.05 * Math.sin(u * 91 + v * 77);
    return { r: n, g: n * 0.97, b: n * 0.93, a: 1 };
  },
  // Grass blades: curved, tapering.
  grass: (u, v) => {
    let a = 0;
    let shade = 0.6;
    const rng = makeRandom(55);
    for (let i = 0; i < 13; i++) {
      const x0 = 0.12 + rng() * 0.76;
      const lean = (rng() - 0.5) * 0.45;
      const h = 0.55 + rng() * 0.43;
      if (v > h) continue;
      const cx = x0 + lean * v * v;
      const w = 0.026 * (1 - v / h) + 0.002;
      const c = cover(Math.abs(u - cx) - w, 0.01);
      if (c > a) {
        a = c;
        shade = 0.5 + 0.4 * (v / h) + 0.1 * rng();
      }
    }
    return { r: shade * 0.85, g: shade, b: shade * 0.5, a };
  },
};

function buildAtlas(): DataTexture {
  const data = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4);
  for (const [name, idx] of Object.entries(TILE_INDEX) as [LeafTile, number][]) {
    const paint = painters[name];
    const tx = (idx % GRID) * TILE;
    const ty = Math.floor(idx / GRID) * TILE;
    for (let y = PAD; y < TILE - PAD; y++) {
      for (let x = PAD; x < TILE - PAD; x++) {
        const u = (x - PAD + 0.5) / (TILE - 2 * PAD);
        const v = (y - PAD + 0.5) / (TILE - 2 * PAD);
        const p = paint(u, v);
        const o = ((ty + y) * ATLAS_SIZE + (tx + x)) * 4;
        data[o] = Math.round(clamp(p.r) * 255);
        data[o + 1] = Math.round(clamp(p.g) * 255);
        data[o + 2] = Math.round(clamp(p.b) * 255);
        data[o + 3] = Math.round(clamp(p.a) * 255);
      }
    }
  }
  const tex = new DataTexture(data, ATLAS_SIZE, ATLAS_SIZE, RGBAFormat, UnsignedByteType);
  tex.colorSpace = SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  tex.name = 'jungle-leaf-atlas';
  return tex;
}

let atlas: DataTexture | null = null;
/** The shared atlas texture (created once per realm). */
export function leafAtlas(): DataTexture {
  if (!atlas) atlas = buildAtlas();
  return atlas;
}

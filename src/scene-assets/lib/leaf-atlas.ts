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

/**
 * Alpha-to-coverage on the cutout foliage (read by materials.ts). Default OFF: it needs MSAA in the XR layer, which cannot be confirmed
 * without a headset. When on, the leaf-edge soft ramps below widen a little (0.02 -> 0.03) so the coverage mask has a gradient to work with.
 */
export const FOLIAGE_ALPHA_TO_COVERAGE = false;
const EDGE_SOFT = FOLIAGE_ALPHA_TO_COVERAGE ? 0.03 : 0.02;
/** The alpha-test threshold of the foliage materials (materials.ts: alphaTest). */
const ALPHA_CUT = 0.45;
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
    const a = Math.max(cover(ax - 0.012, 0.01) * 0.95, cover(ax - env, EDGE_SOFT) * leaflet * sstep(0.02, 0.05, ax)) * (v > 0.01 && v < 0.99 ? 1 : 0);
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
    const a = Math.max(cover(ax - 0.01, 0.008) * 0.95, cover(ax - env, EDGE_SOFT) * leaflet * sstep(0.015, 0.04, ax)) * (v > 0.01 && v < 0.99 ? 1 : 0);
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
    const a = Math.max(cover(ax - 0.014, 0.01), cover(ax - env, EDGE_SOFT) * leaflet * sstep(0.02, 0.05, ax)) * (v > 0.01 && v < 0.99 ? 1 : 0);
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

// ---------------------------------------------------------------------------
// Alpha-coverage-preserving mip pyramid
// ---------------------------------------------------------------------------

const SRGB_TO_LIN = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return t;
})();
/** linear 0..1 -> sRGB byte through a 16384-entry table (cheaper than pow per texel; ~0.2 of a byte step at worst). */
const LIN_TO_SRGB = (() => {
  const n = 16384;
  const t = new Uint8Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const c = i / n;
    t[i] = Math.round(clamp(c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255);
  }
  return t;
})();
const linToSrgb8 = (c: number): number => LIN_TO_SRGB[Math.round(clamp(c) * 16384)];

/**
 * The plain box-filtered mips of an alpha-TESTED texture lose coverage: thin leaflets average to alpha well under the 0.45 cut, so a distant
 * crown thins out and its edges crawl. Here every level is built from the one above with
 *   - colour averaged in linear space and weighted by alpha (the black texels of the transparent margin do not darken leaf edges), and
 *   - per TILE and level an alpha gain g chosen so that the fraction of texels passing the alpha test (alpha >= 0.45) equals level 0's:
 *     with the tile's raw alphas sorted, the k-th largest is lifted exactly to the cut (g = 0.45 / a_k, k = coverage0 x texels, clamped 1..8).
 * Tiles are 128 px with a 5 px margin, so tiles stay separate down to a 2 px tile (level 6); from level 7 (1 px per tile) the previous gain is
 * kept and the last two levels (2x2, 1x1 for the whole atlas, never sampled by a visible card) are plain averages.
 * Deterministic, ~2 M simple operations, no DOM. Returns levels 0..9 (512 .. 1 px) in the DataTexture `mipmaps` format.
 */
export function buildMips(base: Uint8Array): { data: Uint8Array; width: number; height: number }[] {
  const out = [{ data: base, width: ATLAS_SIZE, height: ATLAS_SIZE }];
  const tiles = GRID * GRID;
  // level-0 coverage per tile (fraction of texels that pass the alpha test)
  const cov0 = new Float32Array(tiles);
  for (let ty = 0; ty < GRID; ty++) {
    for (let tx = 0; tx < GRID; tx++) {
      let n = 0;
      for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) if (base[((ty * TILE + y) * ATLAS_SIZE + tx * TILE + x) * 4 + 3] / 255 >= ALPHA_CUT) n++;
      cov0[ty * GRID + tx] = n / (TILE * TILE);
    }
  }
  // working copies of the previous level: linear rgb and RAW (ungained) alpha, 0..1
  let size = ATLAS_SIZE;
  let rgb = new Float32Array(size * size * 3);
  let alpha = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    rgb[i * 3] = SRGB_TO_LIN[base[i * 4]];
    rgb[i * 3 + 1] = SRGB_TO_LIN[base[i * 4 + 1]];
    rgb[i * 3 + 2] = SRGB_TO_LIN[base[i * 4 + 2]];
    alpha[i] = base[i * 4 + 3] / 255;
  }
  const gain = new Float32Array(tiles).fill(1);
  for (let level = 1; size > 1; level++) {
    const ns = size >> 1;
    const nrgb = new Float32Array(ns * ns * 3);
    const nalpha = new Float32Array(ns * ns);
    for (let y = 0; y < ns; y++) {
      for (let x = 0; x < ns; x++) {
        const i0 = 2 * y * size + 2 * x;
        const i1 = i0 + 1;
        const i2 = i0 + size;
        const i3 = i2 + 1;
        const a0 = alpha[i0];
        const a1 = alpha[i1];
        const a2 = alpha[i2];
        const a3 = alpha[i3];
        const sa = a0 + a1 + a2 + a3;
        const o = y * ns + x;
        nalpha[o] = sa * 0.25;
        for (let c = 0; c < 3; c++) {
          const c0 = rgb[i0 * 3 + c];
          const c1 = rgb[i1 * 3 + c];
          const c2 = rgb[i2 * 3 + c];
          const c3 = rgb[i3 * 3 + c];
          // alpha-weighted; a fully transparent block just averages its (margin) colours
          nrgb[o * 3 + c] = sa > 1e-5 ? (c0 * a0 + c1 * a1 + c2 * a2 + c3 * a3) / sa : (c0 + c1 + c2 + c3) * 0.25;
        }
      }
    }
    // coverage-preserving alpha gain per tile (while a tile is still at least 2 px wide)
    const ts = TILE >> level;
    if (ts >= 2) {
      for (let ty = 0; ty < GRID; ty++) {
        for (let tx = 0; tx < GRID; tx++) {
          const vals = new Float32Array(ts * ts);
          for (let y = 0; y < ts; y++) for (let x = 0; x < ts; x++) vals[y * ts + x] = nalpha[(ty * ts + y) * ns + tx * ts + x];
          vals.sort(); // ascending
          const k = Math.round(cov0[ty * GRID + tx] * ts * ts);
          const ak = k > 0 ? vals[ts * ts - k] : 0; // the k-th largest raw alpha
          gain[ty * GRID + tx] = ak > 1e-4 ? clamp(ALPHA_CUT / ak, 1, 8) : 1;
        }
      }
    }
    const data = new Uint8Array(ns * ns * 4);
    for (let y = 0; y < ns; y++) {
      for (let x = 0; x < ns; x++) {
        const o = y * ns + x;
        const tile = level <= 7 ? Math.min(GRID - 1, Math.floor((y * GRID) / ns)) * GRID + Math.min(GRID - 1, Math.floor((x * GRID) / ns)) : -1;
        const gn = tile >= 0 ? gain[tile] : 1;
        data[o * 4] = linToSrgb8(nrgb[o * 3]);
        data[o * 4 + 1] = linToSrgb8(nrgb[o * 3 + 1]);
        data[o * 4 + 2] = linToSrgb8(nrgb[o * 3 + 2]);
        data[o * 4 + 3] = Math.round(clamp(nalpha[o] * gn) * 255);
      }
    }
    out.push({ data, width: ns, height: ns });
    rgb = nrgb;
    alpha = nalpha;
    size = ns;
  }
  return out;
}

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
  // Hand-built pyramid (level 0 included, down to 1x1): alpha-weighted colour and per-tile coverage-preserving alpha, see buildMips.
  tex.mipmaps = buildMips(data);
  tex.generateMipmaps = false;
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

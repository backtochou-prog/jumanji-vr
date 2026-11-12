/**
 * Sky pack: photographic cloud cards, a pale sunward horizon haze and a sun disc with halo.
 * Two RGBA vertex-coloured meshes built around the origin on a sphere of SKY_RADIUS (245 m) (the SkySystem moves the group with the player, so the
 * sky has no parallax and stays inside the far plane).
 *
 *   createSkyClouds()  21 cards of real clouds cut from the user's cloud template (cumulus banks low, altocumulus fields and cirrus high), 672
 *                      triangles, UVs into the 2 x 2 cloud atlas (lib/photo-textures.ts cloudTexture()). Ordinary alpha blending.
 *   createSkyGlow()    the horizon haze (three rows x 72 columns, strongest toward the sun) and the sun: an opaque disc + a three-ring halo. No UVs.
 *
 * Deterministic (makeRandom), DOM-free (it is imported by the runtime SkySystem and by the Node tools). The sun is derived from SUN_DIR, the single sun
 * direction of the project: when the sun moves, the sky follows. Clouds keep clear of the sun disc; ~62 % of them lie in the forward sector (the way
 * the player looks at the start) and the rest behind, where the sun disc rewards a turn-around.
 */
import { BufferGeometry, Color, Float32BufferAttribute } from '@iwsdk/core';
import { makeRandom, smoothstep } from '../world/layout.js';
import { SUN_DIR } from '../world/palette.js';

/** Authored distance (m) of the sky sphere from the player. SkySystem scales the sphere to sit just inside the far plane (700 m in the jungle, more on the mountains): never clipped, never fogged (fog:false), behind the ridges and behind Everest. */
export const SKY_RADIUS = 245;
const DEG = Math.PI / 180;

/** Unit vector pointing AT the sun. */
export const SUN_TOWARD: readonly [number, number, number] = [-SUN_DIR[0], -SUN_DIR[1], -SUN_DIR[2]];
/** Sun heading (radians, 0 = north / -Z, positive = counter-clockwise from above, like the player's yaw) and elevation (radians). */
export const SUN_AZ = Math.atan2(-SUN_TOWARD[0], -SUN_TOWARD[2]);
export const SUN_EL = Math.asin(SUN_TOWARD[1]);

type V3 = [number, number, number];
/** Direction for a heading (0 = -Z, + = counter-clockwise) and an elevation. */
const dirOf = (az: number, el: number): V3 => [-Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const angleBetween = (a: V3, b: V3): number => Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));

/** Growable position / colour / (optional) uv / index buffers. */
class Buf {
  pos: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  vertex(d: V3, c: Color, a: number, u?: number, v?: number): number {
    this.pos.push(d[0] * SKY_RADIUS, d[1] * SKY_RADIUS, d[2] * SKY_RADIUS);
    this.col.push(c.r, c.g, c.b, a);
    if (u !== undefined && v !== undefined) this.uv.push(u, v);
    return this.pos.length / 3 - 1;
  }
  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new Float32BufferAttribute(this.col, 4)); // RGBA: three.js enables USE_COLOR_ALPHA for itemSize 4
    if (this.uv.length) g.setAttribute('uv', new Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// ---------------------------------------------------------------------------
// Clouds
// ---------------------------------------------------------------------------

/** Cloud kinds and the atlas tiles they use (lib/photo-textures.ts cloudTexture(): 2 x 2 tiles; 0 cumulus heads, 1 cumulus mass, 2 altocumulus field, 3 cirrus). */
interface CloudKind {
  tiles: number[];
  count: number;
  /** elevation of the card centre (deg) */
  el: [number, number];
  /** angular half-width (deg) and height / width */
  half: [number, number];
  aspect: number;
  /** random roll of the card (rad, +-) */
  roll: number;
  alpha: number;
}
const CLOUD_KINDS: CloudKind[] = [
  { tiles: [3], count: 5, el: [34, 68], half: [17, 25], aspect: 0.8, roll: 1.2, alpha: 0.85 }, // cirrus: high wisps, any direction (drawn first: farthest)
  { tiles: [2], count: 4, el: [36, 60], half: [18, 24], aspect: 0.62, roll: 0.5, alpha: 0.9 }, // altocumulus: flattened fields of small puffs
  { tiles: [0, 1], count: 12, el: [10, 33], half: [12, 19], aspect: 0.78, roll: 0.06, alpha: 1 }, // cumulus: the low and middle banks
];
const CARD_SEGMENTS = 4;
const C_TOP = new Color('#ffffff');
const C_BELLY = new Color('#d3dce8'); // undersides: a little blue-grey
const C_HAZE = new Color('#dde8f0'); // horizon-ward clouds dissolve toward the haze colour

/**
 * Cloud cards: photographs of real clouds (the user's cloud template, sky keyed out) on quads bent onto the sky sphere. Each card is a 4 x 4 grid in
 * the tangent plane of its centre direction, normalised back to the sphere (so no corner leaves the far plane), with UVs into one atlas tile and a
 * vertex RGBA tint (white tops, blue-grey bellies, fainter and hazier toward the horizon). Cirrus first, cumulus last (painter order).
 */
export function createSkyClouds(): BufferGeometry {
  const rng = makeRandom(7301);
  const sun = norm([SUN_TOWARD[0], SUN_TOWARD[1], SUN_TOWARD[2]]);
  const b = new Buf();
  const placed: { c: V3; w: number }[] = [];
  const tint = new Color();
  for (const K of CLOUD_KINDS) {
    const cards: { az: number; el: number; w: number; c: V3; tile: number; roll: number; flip: boolean }[] = [];
    for (let k = 0; k < K.count; k++) {
      // --- where: forward sector 42 % (+ its share of the rest), all round otherwise (the summit panorama is turned through 360 deg); clear of the sun and of the earlier cards
      let az = 0;
      let el = 0;
      let w = 0;
      let c: V3 = [0, 1, 0];
      for (let tries = 0; tries < 14; tries++) {
        az = (rng() < 0.42 ? (rng() * 2 - 1) * 78 : (rng() * 2 - 1) * 180) * DEG;
        el = (K.el[0] + (K.el[1] - K.el[0]) * rng()) * DEG;
        w = (K.half[0] + (K.half[1] - K.half[0]) * rng()) * DEG;
        c = dirOf(az, el);
        const clearSun = angleBetween(c, sun) > 0.3 + w * 0.9;
        const clearCards = placed.every((o) => angleBetween(c, o.c) > 0.62 * (w + o.w));
        if (clearSun && clearCards) break;
      }
      placed.push({ c, w });
      cards.push({ az, el, w, c, tile: K.tiles[Math.floor(rng() * K.tiles.length) % K.tiles.length], roll: (rng() * 2 - 1) * K.roll, flip: rng() < 0.5 });
    }
    cards.sort((p, q) => q.el - p.el); // high ones first
    for (const card of cards) {
      // tangent frame at the card centre: e1 = toward increasing heading (left), e2 = up the sky; rolled
      const e1: V3 = norm([-Math.cos(card.az), 0, Math.sin(card.az)]);
      const e2: V3 = norm([Math.sin(card.az) * Math.sin(card.el), Math.cos(card.el), Math.cos(card.az) * Math.sin(card.el)]);
      const cr = Math.cos(card.roll);
      const sr = Math.sin(card.roll);
      const tw = Math.tan(card.w);
      const th = Math.tan(card.w * K.aspect);
      const tx = card.tile % 2;
      const ty = Math.floor(card.tile / 2);
      const first = b.pos.length / 3;
      for (let j = 0; j <= CARD_SEGMENTS; j++)
        for (let i = 0; i <= CARD_SEGMENTS; i++) {
          const fx = i / CARD_SEGMENTS;
          const fy = j / CARD_SEGMENTS; // 0 = bottom of the card, 1 = top
          const lx = (fx * 2 - 1) * tw;
          const ly = (fy * 2 - 1) * th;
          const ox = lx * cr - ly * sr;
          const oy = lx * sr + ly * cr;
          const d = norm([card.c[0] + e1[0] * ox + e2[0] * oy, card.c[1] + e1[1] * ox + e2[1] * oy, card.c[2] + e1[2] * ox + e2[2] * oy]);
          // aerial perspective: clouds near the horizon are fainter and take the haze colour
          const elev = Math.asin(d[1]) / DEG;
          const horizon = 1 - smoothstep(8, 32, elev);
          tint.copy(C_BELLY).lerp(C_TOP, smoothstep(0.15, 0.7, fy)).lerp(C_HAZE, horizon * 0.55);
          const alpha = K.alpha * (0.62 + 0.38 * smoothstep(6, 26, elev)) * smoothstep(1.5, 6, elev);
          // atlas: the texture's first row is the photo's top, so v runs downward inside a tile
          const u = (tx + (card.flip ? 1 - fx : fx)) * 0.5;
          const v = (ty + (1 - fy)) * 0.5;
          b.vertex(d, tint, alpha, u, v);
        }
      const row = CARD_SEGMENTS + 1;
      for (let j = 0; j < CARD_SEGMENTS; j++)
        for (let i = 0; i < CARD_SEGMENTS; i++) {
          const p0 = first + j * row + i;
          b.idx.push(p0, p0 + 1, p0 + row, p0 + 1, p0 + row + 1, p0 + row);
        }
    }
  }
  return b.geometry();
}

// ---------------------------------------------------------------------------
// Horizon haze + sun
// ---------------------------------------------------------------------------

const HAZE_COLS = 72;
const HAZE_ROWS_DEG = [2, 10, 36]; // faint at the bottom (the ridges hide it), brightest at 10 deg, gone at 36 deg
const SUN_RINGS: { r: number; a: number; c: Color }[] = [
  { r: 1.7, a: 1.0, c: new Color('#fff6dc') }, // the disc, opaque
  { r: 2.2, a: 0.62, c: new Color('#fff6e0') }, // bright rim of the halo
  { r: 6.0, a: 0.2, c: new Color('#fff3da') },
  { r: 15.0, a: 0.05, c: new Color('#f4f3ea') },
  { r: 26.0, a: 0, c: new Color('#f4f3ea') },
];
const SUN_SEGMENTS = 16;

export function createSkyGlow(): BufferGeometry {
  const b = new Buf();
  const warm = new Color('#eef4fa'); // pale horizon haze (was a yellow glow)
  // --- haze: a ring band; strongest in the sun's direction, a faint level all round
  const rowIdx: number[][] = [];
  HAZE_ROWS_DEG.forEach((deg, r) => {
    const row: number[] = [];
    for (let i = 0; i <= HAZE_COLS; i++) {
      const az = (i / HAZE_COLS) * Math.PI * 2;
      const lobe = Math.pow(Math.max(Math.cos(az - SUN_AZ), 0), 3);
      // peak row carries the alpha; edge rows are clear
      const peak = r === 1 ? 0.07 + 0.2 * lobe : r === 0 ? 0.015 + 0.04 * lobe : 0;
      row.push(b.vertex(dirOf(az, deg * DEG), warm, peak));
    }
    rowIdx.push(row);
  });
  for (let r = 0; r + 1 < rowIdx.length; r++)
    for (let i = 0; i < HAZE_COLS; i++) {
      const a = rowIdx[r][i];
      const c = rowIdx[r + 1][i];
      b.idx.push(a, rowIdx[r][i + 1], c, rowIdx[r][i + 1], rowIdx[r + 1][i + 1], c);
    }
  // --- sun: the disc is a fan, the halo three strips outward (all in the tangent plane of the sun direction)
  const sun = norm([SUN_TOWARD[0], SUN_TOWARD[1], SUN_TOWARD[2]]);
  const e1 = norm([-Math.cos(SUN_AZ), 0, Math.sin(SUN_AZ)]);
  const e2 = norm([Math.sin(SUN_AZ) * Math.sin(SUN_EL), Math.cos(SUN_EL), Math.cos(SUN_AZ) * Math.sin(SUN_EL)]);
  const at = (rDeg: number, th: number): V3 => {
    const r = Math.tan(rDeg * DEG);
    return norm([sun[0] + (e1[0] * Math.cos(th) + e2[0] * Math.sin(th)) * r, sun[1] + (e1[1] * Math.cos(th) + e2[1] * Math.sin(th)) * r, sun[2] + (e1[2] * Math.cos(th) + e2[2] * Math.sin(th)) * r]);
  };
  const centre = b.vertex(sun, SUN_RINGS[0].c, 1);
  const rings: number[][] = SUN_RINGS.map((R) => {
    const ids: number[] = [];
    for (let s = 0; s < SUN_SEGMENTS; s++) ids.push(b.vertex(at(R.r, (s / SUN_SEGMENTS) * Math.PI * 2), R.c, R.a));
    return ids;
  });
  for (let s = 0; s < SUN_SEGMENTS; s++) b.idx.push(centre, rings[0][s], rings[0][(s + 1) % SUN_SEGMENTS]);
  for (let r = 0; r + 1 < rings.length; r++)
    for (let s = 0; s < SUN_SEGMENTS; s++) {
      const s1 = (s + 1) % SUN_SEGMENTS;
      b.idx.push(rings[r][s], rings[r + 1][s], rings[r][s1], rings[r][s1], rings[r + 1][s], rings[r + 1][s1]);
    }
  return b.geometry();
}

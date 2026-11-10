/**
 * Sky pack for the Overlook Knoll: painterly cloud banks, a warm sunward horizon haze and a sun disc with halo.
 * Two vertex-coloured RGBA meshes, no textures, built around the origin on a sphere of SKY_RADIUS (245 m) (the SkySystem moves the group with the player, so the
 * sky has no parallax and stays inside the 260 m far plane).
 *
 *   createSkyClouds()  ~100 overlapping squashed puffs in ~20 banks: cone fans, centre = lit cream / rim = shaded blue-grey, alpha 0 on the rim,
 *                      ~1k triangles. Drawn with ordinary alpha blending (src alpha), so the RGBA falloff is linear in display space: no glowing edges.
 *   createSkyGlow()    the warm horizon haze (three rows x 72 columns, strongest toward the sun) and the sun: an opaque disc + a three-ring halo.
 *
 * Deterministic (makeRandom), DOM-free (it is imported by the runtime SkySystem and by the Node tools). The sun is derived from SUN_DIR, the single sun
 * direction of the project: when the sun moves, the sky follows. Clouds keep clear of the sun disc and thin out around it; ~62 % of the banks lie in the
 * forward sector (the way the player looks at the start) and the rest behind, where the sun disc rewards a turn-around.
 */
import { BufferGeometry, Color, Float32BufferAttribute } from '@iwsdk/core';
import { makeRandom, smoothstep } from '../world/layout.js';
import { SUN_DIR } from '../world/palette.js';

/** Distance (m) of the sky sphere from the player. Inside the jungle far plane (260 m, 15 m spare for the head offset): never clipped, never fogged (fog:false); beyond the farthest ridge point (~228 m from the knoll) so the ridges always occlude it. */
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

/** Growable position / colour / index buffers. */
class Buf {
  pos: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  vertex(d: V3, c: Color, a: number): number {
    this.pos.push(d[0] * SKY_RADIUS, d[1] * SKY_RADIUS, d[2] * SKY_RADIUS);
    this.col.push(c.r, c.g, c.b, a);
    return this.pos.length / 3 - 1;
  }
  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new Float32BufferAttribute(this.col, 4)); // RGBA: three.js enables USE_COLOR_ALPHA for itemSize 4
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// ---------------------------------------------------------------------------
// Clouds
// ---------------------------------------------------------------------------

const CLOUD_BANKS = 20;
const PUFF_SEGMENTS = 10;
const C_LIT = new Color('#fff0d4'); // sun-facing tops: warm cream
const C_MID = new Color('#e6e8e6');
const C_SHADE = new Color('#8da1b8'); // underside: blue-grey
const C_HAZE = new Color('#dfe4d8'); // horizon-ward clouds dissolve toward the haze colour

export function createSkyClouds(): BufferGeometry {
  const rng = makeRandom(7301);
  const sun = norm([SUN_TOWARD[0], SUN_TOWARD[1], SUN_TOWARD[2]]);
  const b = new Buf();
  interface Puff {
    c: V3;
    e1: V3;
    e2: V3;
    rx: number;
    ry: number;
    lit: number;
    a: number;
    yRel: number;
    rot: number;
  }
  const centres: V3[] = [];
  const puffs: Puff[] = [];
  for (let k = 0; k < CLOUD_BANKS; k++) {
    // --- where: forward sector 62 %, elsewhere 38 %; 14..64 deg up; clear of the sun and of the earlier banks
    let az = 0;
    let el = 0;
    let W = 0;
    let c: V3 = [0, 1, 0];
    for (let tries = 0; tries < 12; tries++) {
      az = (rng() < 0.62 ? (rng() * 2 - 1) * 78 : (rng() * 2 - 1) * 180) * DEG;
      el = (15 + 49 * Math.pow(rng(), 1.15)) * DEG;
      W = (0.36 + 0.34 * rng()) * (1.3 - 0.7 * smoothstep(14, 60, el / DEG)); // low banks are wide and flat, high ones small
      c = dirOf(az, el);
      const clearSun = angleBetween(c, sun) > 0.42 + W * 0.55;
      const clearBanks = centres.every((o) => angleBetween(c, o) > 0.5 * W + 0.17);
      if (clearSun && clearBanks) break;
    }
    centres.push(c);
    // tangent frame at the bank centre: e1 = toward increasing heading (left), e2 = up the sky
    const e1: V3 = norm([-Math.cos(az), 0, Math.sin(az)]);
    const e2: V3 = norm([Math.sin(az) * Math.sin(el), Math.cos(el), Math.cos(az) * Math.sin(el)]);
    // the sun's direction in this tangent plane: puffs on that side are lit
    const sx = sun[0] * e1[0] + sun[1] * e1[1] + sun[2] * e1[2];
    const sy = sun[0] * e2[0] + sun[1] * e2[1] + sun[2] * e2[2];
    const sl = Math.hypot(sx, sy) || 1;
    const nearSun = 1 - smoothstep(0.5, 1.6, angleBetween(c, sun)); // silver lining close to the sun
    const bankH = W * (0.2 + 0.1 * rng());
    const n = 4 + Math.floor(rng() * 3); // 4..6 puffs including the flat base
    for (let i = 0; i < n; i++) {
      const base = i === 0;
      const t = base ? 0.5 : (i - 0.5) / (n - 1);
      const dome = Math.pow(Math.max(0, 1 - Math.pow(2 * t - 1, 2)), 0.8);
      const x = base ? (rng() - 0.5) * 0.08 * W : (t - 0.5) * W * 0.95 + (rng() - 0.5) * 0.06 * W;
      const rx = base ? W * (0.4 + 0.08 * rng()) : W * (0.15 + 0.1 * rng()) * (0.75 + 0.45 * dome);
      const ry = base ? rx * (0.17 + 0.05 * rng()) : rx * (0.42 + 0.18 * rng());
      const y = base ? -0.1 * bankH : bankH * dome * (0.15 + 0.7 * rng());
      const yRel = base ? 0 : Math.min(1, Math.max(0, y / bankH));
      const dir = norm([c[0] + e1[0] * x + e2[0] * y, c[1] + e1[1] * x + e2[1] * y, c[2] + e1[2] * x + e2[2] * y]);
      // lit factor: higher puffs + the sun side of the bank + a silver lining near the sun; the base is always the shaded one
      const side = (x * sx + y * sy) / (sl * W * 0.5);
      const lit = base ? 0.05 : Math.min(1, Math.max(0, 0.32 + 0.5 * yRel + 0.3 * side + 0.25 * nearSun));
      // aerial perspective: clouds near the horizon are fainter
      const haze = smoothstep(14, 38, (Math.asin(dir[1]) / DEG));
      puffs.push({ c: dir, e1, e2, rx, ry, lit, a: (0.5 + 0.28 * rng()) * (0.6 + 0.4 * haze), yRel, rot: (rng() - 0.5) * 0.35 });
    }
  }
  // painter order: lowest (shaded) puffs first, tops last, so the lit tops overlap the shaded bellies
  puffs.sort((p, q) => p.c[1] - q.c[1]);
  const tmp = new Color();
  for (const p of puffs) {
    const centre = new Color();
    if (p.lit < 0.5) centre.copy(C_SHADE).lerp(C_MID, p.lit * 2);
    else centre.copy(C_MID).lerp(C_LIT, (p.lit - 0.5) * 2);
    const horizon = 1 - smoothstep(14, 38, Math.asin(p.c[1]) / DEG);
    centre.lerp(C_HAZE, horizon * 0.5);
    const rim = tmp.copy(centre).lerp(C_SHADE, 0.5 - 0.3 * p.lit);
    const i0 = b.vertex(p.c, centre, p.a);
    const first = b.pos.length / 3;
    const rng2 = makeRandom(Math.floor(p.c[0] * 9973 + p.c[2] * 7919 + 17) >>> 0);
    for (let s = 0; s < PUFF_SEGMENTS; s++) {
      const th = (s / PUFF_SEGMENTS) * Math.PI * 2 + p.rot;
      const f = 0.82 + 0.36 * rng2(); // ragged outline
      const ox = Math.cos(th) * p.rx * f;
      const oy = Math.sin(th) * p.ry * f * (Math.sin(th) > 0 ? 1.15 : 0.85); // flatter underside, rounder top
      const d = norm([p.c[0] + p.e1[0] * ox + p.e2[0] * oy, p.c[1] + p.e1[1] * ox + p.e2[1] * oy, p.c[2] + p.e1[2] * ox + p.e2[2] * oy]);
      b.vertex(d, rim, 0);
    }
    for (let s = 0; s < PUFF_SEGMENTS; s++) b.idx.push(i0, first + s, first + ((s + 1) % PUFF_SEGMENTS));
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
  { r: 2.2, a: 0.62, c: new Color('#ffe7b0') }, // bright rim of the halo
  { r: 6.0, a: 0.26, c: new Color('#ffd89a') },
  { r: 15.0, a: 0.07, c: new Color('#ffd08a') },
  { r: 26.0, a: 0, c: new Color('#ffd08a') },
];
const SUN_SEGMENTS = 16;

export function createSkyGlow(): BufferGeometry {
  const b = new Buf();
  const warm = new Color('#ffdca0');
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

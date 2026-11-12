/**
 * Background depth: layered jungle ridge silhouettes ringing the world.
 *
 * Three rings (125 / 147 / 172 m from (0,-25)), each a 2-sided vertical strip with a jagged tree-line top. They are centred so that the whole terrain
 * rectangle (x +-70, z -112..62; farthest corner 112 m away) lies INSIDE ring 0 (no strip pokes through the ground), the Overlook Knoll (z 31) is >= 69 m
 * from the nearest ridge and the backdrop cliff (z -51..-97) is well in front of the north side. Three vertex rows per ring: a fog-coloured foot (so
 * the layers rise out of the haze), a hazy leaf-green belt and the crown, which catches a warm rim on the sunward side. Heights taper toward the cliff
 * (so the fall keeps its sky) and, less, toward the sun. Vertex colour carries the atmospheric perspective: deep green (near) -> fog tint (far); the mix
 * values were tuned for the thinner knoll fog (the rings are farther away now, so the runtime fog already hazes them more).
 * 2640 triangles and three draw calls. Unlit (basic material), fogged. UVs (u along the ring, v = height, one tile per ~48 m) carry the forested-slope
 * texture of the silhouette material, so the belts read as wooded hillsides instead of flat colour.
 */
import { BufferGeometry, Color, Float32BufferAttribute, Mesh, Uint32BufferAttribute } from '@iwsdk/core';
import { fbm, makeRandom, smoothstep } from '../world/layout.js';
import { FOG_COLOR, SUN_DIR } from '../world/palette.js';
import { EVEREST, everestSmooth } from '../world/everest.js';
import { silhouetteMaterial } from './lib/materials.js';

export const RIDGE_CENTER = { x: 0, z: -25 };
export const RIDGE_RINGS = [
  // `tone`: the ring's own colour before the fog (the user's misty-mountains template: a dark blue-green forested ridge in front, bluer and paler behind)
  { r: 125, h: 50, mix: 0.1, seed: 1, tone: '#1f4038' },
  { r: 147, h: 66, mix: 0.16, seed: 2, tone: '#234a63' },
  { r: 172, h: 84, mix: 0.24, seed: 3, tone: '#2f5c8a' },
];
/** Ring angle (x = cos a, z = sin a) of the backdrop cliff seen from the ring centre, and of the sun. */
const CLIFF_ANGLE = Math.atan2(-96 - RIDGE_CENTER.z, 5 - RIDGE_CENTER.x);
const SUN_ANGLE = Math.atan2(-SUN_DIR[2], -SUN_DIR[0]);
const angleDiff = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
/** Foot of the strip (m): far below the terrain, in the fog colour. */
const RIDGE_FOOT = -24;
/** Size of one texture tile on the ridge belts (m). */
const RIDGE_TILE = 48;

export function createRidge(layer: number): Mesh {
  const L = RIDGE_RINGS[layer];
  const cols = 220;
  const rng = makeRandom(900 + layer);
  const tone = new Color(L.tone);
  const fog = new Color(FOG_COLOR);
  const top = tone.clone().lerp(fog, L.mix);
  const foot = tone.clone().lerp(fog, 0.9); // haze pools at the foot of every layer
  const mid = tone.clone().multiplyScalar(0.86).lerp(fog, L.mix + 0.12);
  const warm = new Color('#cfe0ee'); // a pale rim where the sun grazes the crown
  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const uTiles = Math.round((Math.PI * 2 * L.r) / RIDGE_TILE); // whole tiles around the ring: no seam where it closes
  const phases = [rng() * 6.28, rng() * 6.28, rng() * 6.28];
  const crown = new Color();
  for (let i = 0; i <= cols; i++) {
    const a = (i / cols) * Math.PI * 2;
    // Rolling hills + individual crowns (sharp tops) + broken tree-line.
    const hill = fbm(Math.cos(a) * 3 + L.seed * 7, Math.sin(a) * 3, 60 + L.seed, 3);
    const crowns = Math.pow(Math.abs(Math.sin(a * 53 + phases[0]) * Math.sin(a * 29 + phases[1])), 0.6) * 0.28 + 0.12 * Math.abs(Math.sin(a * 97 + phases[2]));
    // lower toward the cliff (its fall keeps the sky around it) and a little toward the sun; tall flanks keep the enclosure
    const taper = (0.45 + 0.55 * smoothstep(0.4, 1.2, angleDiff(a, CLIFF_ANGLE))) * (0.75 + 0.25 * smoothstep(0.35, 1.0, angleDiff(a, SUN_ANGLE)));
    const x = RIDGE_CENTER.x + Math.cos(a) * L.r;
    const z = RIDGE_CENTER.z + Math.sin(a) * L.r;
    // the rings open in the south, where Everest stands (world/everest.ts): a strip sinks into the ground wherever the peak has begun to rise
    const gap = 1 - smoothstep(0.2, 9, everestSmooth(x, z));
    const h = L.h * (0.55 + 0.75 * hill) * (1 + crowns * 0.5) * taper * gap;
    // warm rim on the crown, strongest on the sunward side
    const rim = Math.pow(Math.max(Math.cos(a - SUN_ANGLE), 0), 2) * 0.22;
    crown.copy(top).lerp(warm, rim);
    positions.push(x, RIDGE_FOOT, z, x, h * 0.42, z, x, h, z);
    colors.push(foot.r, foot.g, foot.b, mid.r, mid.g, mid.b, crown.r, crown.g, crown.b);
    const u = (i / cols) * uTiles + layer * 0.37;
    uvs.push(u, RIDGE_FOOT / RIDGE_TILE, u, (h * 0.42) / RIDGE_TILE, u, h / RIDGE_TILE);
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
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  const m = new Mesh(g, silhouetteMaterial);
  m.name = `Ridge_${layer}`;
  m.frustumCulled = false; // ring: always partly in view; 3 draws total
  return m;
}

// ---------------------------------------------------------------------------
// Far country (visible from the summit and the descent: the far plane opens up there)
// ---------------------------------------------------------------------------
//
// What the summit looks out on: five layered ranges of jagged peaks and a handful of TEPUIS (flat-topped table mountains with sheer sandstone walls, a
// jungle cap and a thread of falling water), all in ONE mesh and one draw. Nothing here is lit at run time (the material is the unlit, fogged silhouette
// material): the golden sun is BAKED into the vertex colours from SUN_DIR - faces turned to the sun are warm, the others fall into a cool violet shade -
// and every foot dissolves into the valley haze, so the layers read as depth, not as cut-outs. The runtime fog then adds the real aerial perspective.
// The palette follows the user's misty-mountains template: the nearest range is forested (olive in the sun, blue-green in shade), the ranges behind it
// are blue and, through the fog, paler and paler until the last one almost meets the sky; haze pools at every foot. The forested-slope texture of the
// silhouette material (UVs: u along the range, v = height) gives the flanks their relief.

/**
 * Five layered ranges, 380 - 800 m from the valley centre (outside the jungle's ridge rings; the walkable mountain stays within ~120 m of the centre, so
 * the last one is at most ~920 m away: inside the 1 km far plane and the ~960 m sky sphere). `lit` / `shade` are the colours BEFORE the runtime fog
 * (0.0016 exp2 leaves 69 % / 57 % / 42 % / 29 % / 19 % of them), chosen so the fogged result lands on the template's blues. `tile` = metres per texture tile.
 */
export const FAR_RANGES = [
  { r: 380, h: 150, mix: 0.0, seed: 11, lit: '#4a6238', shade: '#1c3340', tile: 150 },
  { r: 470, h: 215, mix: 0.12, seed: 12, lit: '#44607c', shade: '#27405f', tile: 190 },
  { r: 580, h: 290, mix: 0.26, seed: 13, lit: '#3f6190', shade: '#2e5080', tile: 240 },
  { r: 690, h: 350, mix: 0.3, seed: 14, lit: '#4a71a8', shade: '#3d629a', tile: 300 },
  { r: 800, h: 420, mix: 0.34, seed: 15, lit: '#5a82b8', shade: '#4d74ab', tile: 360 },
];
const FAR_CENTER = { x: 190, z: -100 };
const FAR_FOOT = -64;
/** Unit vector, in the ground plane, pointing at the sun (for the baked shading). */
const SUN_FLAT = (() => {
  const l = Math.hypot(SUN_DIR[0], SUN_DIR[2]) || 1;
  return [-SUN_DIR[0] / l, -SUN_DIR[2] / l] as const;
})();
const HAZE = new Color('#b2c4cf'); // the open valley haze (AtmosphereSystem FOG_COLOR_OPEN)
const LIT_GREEN = new Color('#4c6e2e'); // sunlit forest slope, golden hour
const SHADE_GREEN = new Color('#213c48'); // the same slope in shade: cool blue-green
const LIT_ROCK = new Color('#a98c62'); // sunlit sandstone (matches the textured cliffs)
const SHADE_ROCK = new Color('#565a6c'); // shaded sandstone: blue-grey
const CAP_GREEN = new Color('#3d702e');
/** Size of one texture tile on the table mountains (m). */
const TEPUI_TILE = 110;

interface Parts {
  p: number[];
  c: number[];
  u: number[];
  i: number[];
}

function farRangeParts(layer: number, out: Parts): void {
  const L = FAR_RANGES[layer];
  const cols = 132;
  const hs: number[] = [];
  for (let i = 0; i <= cols; i++) {
    const a = (i / cols) * Math.PI * 2;
    const nx = Math.cos(a) * 2.6 + L.seed * 5;
    const nz = Math.sin(a) * 2.6;
    const ridged = 1 - Math.abs(fbm(nx, nz, 120 + L.seed, 4) * 2 - 1);
    const mass = fbm(nx * 0.45, nz * 0.45, 140 + L.seed, 2);
    // sharp peaks on broad massifs, with deep saddles between them (the saddles show the next range)
    // (the ranges sink into the ground around Everest, which stands among them: world/everest.ts)
    const gap = smoothstep(EVEREST.reach * 0.9, EVEREST.reach * 1.25, Math.hypot(FAR_CENTER.x + Math.cos(a) * L.r - EVEREST.x, FAR_CENTER.z + Math.sin(a) * L.r - EVEREST.z));
    hs.push(L.h * (0.16 + 1.0 * Math.pow(ridged, 2.1) * (0.4 + 0.9 * mass)) * gap - (1 - gap) * 24);
  }
  hs[cols] = hs[0];
  const base = out.p.length / 3;
  const ds = (Math.PI * 2 * L.r) / cols;
  const lit = new Color();
  const c = new Color();
  const litC = new Color(L.lit);
  const shadeC = new Color(L.shade);
  const uTiles = Math.round((Math.PI * 2 * L.r) / L.tile);
  for (let i = 0; i <= cols; i++) {
    const a = (i / cols) * Math.PI * 2;
    const h = hs[i];
    const slope = (hs[(i + 1) % cols] - hs[(i - 1 + cols) % cols]) / (2 * ds);
    // pseudo normal of the face seen from inside: inward, turned away from the rising side
    const tx = -Math.sin(a);
    const tz = Math.cos(a);
    let nx = -Math.cos(a) * 0.75 - tx * slope * 1.6;
    let nz = -Math.sin(a) * 0.75 - tz * slope * 1.6;
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl;
    nz /= nl;
    const sun = Math.min(1, Math.max(0, 0.5 + 0.62 * (nx * SUN_FLAT[0] + nz * SUN_FLAT[1])));
    lit.copy(shadeC).lerp(litC, sun);
    // high bare crests turn to rock
    const rocky = smoothstep(0.55, 0.95, h / L.h);
    lit.lerp(c.copy(SHADE_ROCK).lerp(LIT_ROCK, sun), rocky * 0.18);
    const x = FAR_CENTER.x + Math.cos(a) * L.r;
    const z = FAR_CENTER.z + Math.sin(a) * L.r;
    const yTop = FAR_FOOT + 24 + h;
    out.p.push(x, FAR_FOOT, z, x, FAR_FOOT + 24 + h * 0.4, z, x, yTop, z);
    const u = (i / cols) * uTiles + layer * 0.29;
    out.u.push(u, 0, u, (24 + h * 0.4) / L.tile, u, (24 + h) / L.tile);
    c.copy(HAZE);
    out.c.push(c.r, c.g, c.b);
    c.copy(lit).multiplyScalar(0.86).lerp(HAZE, Math.min(1, L.mix + 0.2)); // the flanks sink into the valley haze
    out.c.push(c.r, c.g, c.b);
    c.copy(lit).lerp(HAZE, L.mix);
    out.c.push(c.r, c.g, c.b);
  }
  for (let i = 0; i < cols; i++) {
    const a = base + i * 3;
    const n = a + 3;
    out.i.push(a, a + 1, n, a + 1, n + 1, n, a + 1, a + 2, n + 1, a + 2, n + 2, n + 1);
  }
}

/** Table mountains: angle (deg; x = cos, z = sin) and distance from the valley centre, radius, top height. All on the far side from the jungle. */
export const TEPUIS = [
  { a: -8, d: 318, r: 62, top: 118, seed: 1 },
  { a: -52, d: 345, r: 44, top: 150, seed: 2 },
  { a: 38, d: 330, r: 52, top: 96, seed: 3 },
  { a: -96, d: 352, r: 70, top: 132, seed: 4 },
  { a: 84, d: 356, r: 48, top: 124, seed: 5 },
  { a: -140, d: 362, r: 40, top: 108, seed: 6 },
] as const;

function tepuiParts(T: (typeof TEPUIS)[number], out: Parts): void {
  const sides = 14;
  const rng = makeRandom(4400 + T.seed);
  const cx = FAR_CENTER.x + Math.cos((T.a * Math.PI) / 180) * T.d;
  const cz = FAR_CENTER.z + Math.sin((T.a * Math.PI) / 180) * T.d;
  // rows from the foot up: haze skirt, forested talus, wall foot, a strata break, the rim, the cap
  const wall0 = T.top * (0.3 + 0.08 * rng());
  const rows = [
    { y: FAR_FOOT, k: 1.75, kind: 'haze' },
    { y: wall0 * 0.55, k: 1.34, kind: 'talus' },
    { y: wall0, k: 1.04, kind: 'foot' },
    { y: wall0 + (T.top - wall0) * 0.55, k: 0.99, kind: 'wall' },
    { y: T.top, k: 0.97, kind: 'rim' },
    { y: T.top + 3.5, k: 0.86, kind: 'cap' },
  ] as const;
  const radii: number[] = [];
  for (let s = 0; s < sides; s++) radii.push(T.r * (0.78 + 0.44 * rng()));
  const base = out.p.length / 3;
  const uTiles = Math.max(2, Math.round((Math.PI * 2 * T.r) / TEPUI_TILE));
  const c = new Color();
  const rock = new Color();
  rows.forEach((R) => {
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const sun = Math.min(1, Math.max(0, 0.5 + 0.62 * (Math.cos(a) * SUN_FLAT[0] + Math.sin(a) * SUN_FLAT[1])));
      // the walls keep their own outline; the talus spreads out and rounds off
      const rad = R.kind === 'haze' || R.kind === 'talus' ? T.r * R.k * (0.9 + 0.2 * ((s * 7 + T.seed) % 3) * 0.3) : radii[s] * R.k;
      out.p.push(cx + Math.cos(a) * rad, R.y, cz + Math.sin(a) * rad);
      out.u.push((s / sides) * uTiles + T.seed * 0.23, (R.y - FAR_FOOT) / TEPUI_TILE);
      rock.copy(SHADE_ROCK).lerp(LIT_ROCK, sun);
      if (R.kind === 'haze') c.copy(HAZE);
      else if (R.kind === 'talus') c.copy(SHADE_GREEN).lerp(LIT_GREEN, sun).lerp(HAZE, 0.3);
      else if (R.kind === 'foot') c.copy(rock).multiplyScalar(0.8).lerp(SHADE_GREEN, 0.25);
      else if (R.kind === 'wall') c.copy(rock).multiplyScalar(s % 2 ? 0.9 : 1.02); // strata and buttresses
      else if (R.kind === 'rim') c.copy(rock).lerp(LIT_ROCK, 0.25);
      else c.copy(CAP_GREEN).lerp(LIT_GREEN, sun * 0.6);
      out.c.push(c.r, c.g, c.b);
    }
  });
  for (let r = 0; r + 1 < rows.length; r++)
    for (let s = 0; s < sides; s++) {
      const a = base + r * sides + s;
      const b = base + r * sides + ((s + 1) % sides);
      out.i.push(a, b, a + sides, b, b + sides, a + sides);
    }
  // the cap: a low green dome
  const top = out.p.length / 3;
  out.p.push(cx, T.top + 7, cz);
  out.u.push(T.seed * 0.23, (T.top + 7 - FAR_FOOT) / TEPUI_TILE);
  c.copy(CAP_GREEN).lerp(LIT_GREEN, 0.5);
  out.c.push(c.r, c.g, c.b);
  const capRow = base + (rows.length - 1) * sides;
  for (let s = 0; s < sides; s++) out.i.push(capRow + s, capRow + ((s + 1) % sides), top);
  // a thread of water off the rim, on the side that faces the valley
  const toC = Math.atan2(FAR_CENTER.z - cz, FAR_CENTER.x - cx) + (rng() - 0.5) * 0.9;
  const sFall = Math.round(((toC + Math.PI * 2) % (Math.PI * 2)) / ((Math.PI * 2) / sides)) % sides;
  const fa = (sFall / sides) * Math.PI * 2;
  const fr = radii[sFall] * 1.045;
  const w = 1.6 + T.r * 0.035;
  const fb = out.p.length / 3;
  const fx = cx + Math.cos(fa) * fr;
  const fz = cz + Math.sin(fa) * fr;
  const sx = -Math.sin(fa) * w;
  const sz = Math.cos(fa) * w;
  out.p.push(fx - sx, T.top - 1, fz - sz, fx + sx, T.top - 1, fz + sz, fx - sx * 1.6, wall0 * 0.8, fz - sz * 1.6, fx + sx * 1.6, wall0 * 0.8, fz + sz * 1.6);
  for (let k = 0; k < 4; k++) {
    out.c.push(0.95, 0.97, 0.96);
    out.u.push(0.5 + (k % 2) * 0.02, k < 2 ? 0.9 : 0.1);
  }
  out.i.push(fb, fb + 1, fb + 2, fb + 1, fb + 3, fb + 2);
}

/** The whole far country as ONE mesh (one draw). */
export function createFarRanges(): Mesh {
  const out: Parts = { p: [], c: [], u: [], i: [] };
  for (let k = FAR_RANGES.length - 1; k >= 0; k--) farRangeParts(k, out);
  for (const T of TEPUIS) {
    // (a table mountain that would stand on Everest's flank is left out)
    const cx = FAR_CENTER.x + Math.cos((T.a * Math.PI) / 180) * T.d;
    const cz = FAR_CENTER.z + Math.sin((T.a * Math.PI) / 180) * T.d;
    if (Math.hypot(cx - EVEREST.x, cz - EVEREST.z) > EVEREST.reach + T.r) tepuiParts(T, out);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(out.p, 3));
  g.setAttribute('color', new Float32BufferAttribute(out.c, 3));
  g.setAttribute('uv', new Float32BufferAttribute(out.u, 2));
  g.setIndex(new Uint32BufferAttribute(new Uint32Array(out.i), 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  const m = new Mesh(g, silhouetteMaterial);
  m.name = 'FarRanges';
  m.frustumCulled = false;
  return m;
}

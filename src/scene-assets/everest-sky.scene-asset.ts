/**
 * Everest's clouds (world/everest.ts), built in world space round the summit axis. Two geometries for the runtime EverestSystem, which owns the
 * meshes and their two unlit materials (outside the asset manifest):
 *
 *   createEverestCollar()  what is seen from BELOW the cloud deck: a ragged ring of cloud clinging to the mountain at deck height. It follows the
 *                          real rock line (found per heading) and fades out within ~40 m of it, so the snows above stay in clear view from the
 *                          jungle. RGBA vertex colours, drawn with alpha blending.
 *   createEverestSea()     what is seen from ABOVE it: a sea of clouds out to 1.45 km (flat and exactly the whiteout colour against the mountain,
 *                          so the walk through the deck has no seam; rolling further out) and, merged into the same mesh, the Himalaya: sixteen
 *                          snow peaks standing out of the sea, every one lower than the summit. Opaque, RGB vertex colours with the sun baked in.
 *
 * Deterministic (makeRandom, fbm), DOM-free.
 */
import { BufferGeometry, Color, Float32BufferAttribute } from '@iwsdk/core';
import { EVEREST } from '../world/everest.js';
import { fbm, makeRandom, smoothstep, terrainHeight } from '../world/layout.js';
import { SUN_TO } from '../world/palette.js';

/** The colour of the air inside the cloud deck (the whiteout fog of AtmosphereSystem): the sea is exactly this against the mountain. */
export const CLOUD_WHITE = '#e4e9ee';
/** Outer radius of the sea of clouds (m): inside the 1.5 km far plane used above the deck. */
export const SEA_RADIUS = 1450;
const SEA_INNER = 104;
const TAU = Math.PI * 2;

/** Distance from the summit axis at which the mountain's surface crosses the cloud deck, for a heading. */
function rockLine(a: number): number {
  let lo = 40;
  let hi = 330;
  for (let i = 0; i < 18; i++) {
    const r = (lo + hi) / 2;
    if (terrainHeight(EVEREST.x + Math.cos(a) * r, EVEREST.z + Math.sin(a) * r) > EVEREST.deck) lo = r;
    else hi = r;
  }
  return (lo + hi) / 2;
}

/** The cloud ring seen from below the deck. */
export function createEverestCollar(): BufferGeometry {
  const SEG = 72;
  // offsets from the rock line (m) and the opacity there: the first row is inside the rock (depth-tested away), the last is clear air
  const ROWS: [number, number][] = [
    [-22, 0.92],
    [0, 0.9],
    [11, 0.66],
    [23, 0.34],
    [34, 0.12],
    [46, 0],
  ];
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const lit = new Color('#f1f4f7');
  const grey = new Color('#c3ccd8');
  const c = new Color();
  for (let i = 0; i < SEG; i++) {
    const a = (i / SEG) * TAU;
    // (the rock line, eased over neighbouring headings so the ring does not copy every gully)
    const rs = (rockLine(a - 0.06) + 2 * rockLine(a) + rockLine(a + 0.06)) / 4;
    for (let j = 0; j < ROWS.length; j++) {
      // ragged outer edge: the ring swells and thins along the mountain
      const swell = 0.55 + 0.9 * fbm(Math.cos(a) * 2.2 + 7, Math.sin(a) * 2.2 + 3, 141, 3);
      const r = rs + ROWS[j][0] * (ROWS[j][0] > 0 ? swell : 1);
      const x = EVEREST.x + Math.cos(a) * r;
      const z = EVEREST.z + Math.sin(a) * r;
      const n = fbm(x * 0.03, z * 0.03, 142, 3);
      pos.push(x, EVEREST.deck + (n - 0.5) * 7 - j * 0.5, z);
      c.copy(grey).lerp(lit, smoothstep(0.3, 0.72, n));
      col.push(c.r, c.g, c.b, ROWS[j][1] * (0.62 + 0.38 * smoothstep(0.28, 0.6, fbm(x * 0.012 + 5, z * 0.012, 143, 2))));
    }
  }
  const R = ROWS.length;
  for (let i = 0; i < SEG; i++) {
    const i1 = (i + 1) % SEG;
    for (let j = 0; j < R - 1; j++) {
      const a = i * R + j;
      const b = i1 * R + j;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 4)); // RGBA
  g.setIndex(idx);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/** Height of the sea of clouds (m): level against the mountain, rolling further out. */
function seaHeight(x: number, z: number): number {
  const r = Math.hypot(x - EVEREST.x, z - EVEREST.z);
  const amp = smoothstep(170, 430, r) * (5 + 10 * smoothstep(400, 1200, r));
  const n = fbm(x * 0.0058, z * 0.0058, 131, 3) * 0.68 + fbm(x * 0.019, z * 0.019, 132, 2) * 0.32;
  return EVEREST.deck - 2 + (n - 0.5) * 2 * amp;
}

interface Peak {
  x: number;
  z: number;
  top: number;
  r: number;
  seed: number;
}

/** The Himalaya: every summit below Everest's (deck + 117 m), feet under the clouds, none closer than the peak's own flanks. */
export const HIMALAYA: readonly Peak[] = (() => {
  const rng = makeRandom(8848);
  const out: Peak[] = [];
  const N = 16;
  for (let i = 0; i < N; i++) {
    const a = ((i + 0.15 + rng() * 0.7) / N) * TAU;
    // two rings: near neighbours (the Lhotse / Nuptse of this peak) and the far ranks
    const near = i % 4 === 1;
    const d = near ? 520 + rng() * 90 : 700 + rng() * 520;
    out.push({
      x: EVEREST.x + Math.cos(a) * d,
      z: EVEREST.z + Math.sin(a) * d,
      top: EVEREST.deck + (near ? 78 + rng() * 22 : 46 + rng() * 48),
      r: near ? 200 + rng() * 50 : 190 + rng() * 170,
      seed: 200 + i,
    });
  }
  return out;
})();

const SEA_LIT = new Color('#f3f5f8');
const SEA_SHADE = new Color('#a3b6d2');
const SNOW_LIT = new Color('#f7f9fc');
const SNOW_SHADE = new Color('#8299c2');
const ROCK = new Color('#5c6474');

/** The sea of clouds and the Himalaya, one opaque mesh. */
export function createEverestSea(): BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const c = new Color();
  const white = new Color(CLOUD_WHITE);

  // --- the sea: 20 rings x 104 headings, radii in geometric progression (9 m cells against the mountain, ~130 m at the rim)
  const RINGS = 20;
  const SEG = 104;
  for (let j = 0; j <= RINGS; j++) {
    const r = SEA_INNER * Math.pow(SEA_RADIUS / SEA_INNER, j / RINGS);
    for (let i = 0; i < SEG; i++) {
      const a = ((i + (j % 2) * 0.5) / SEG) * TAU;
      const x = EVEREST.x + Math.cos(a) * r;
      const z = EVEREST.z + Math.sin(a) * r;
      const y = seaHeight(x, z);
      pos.push(x, y, z);
      // sun baked in from the slope of the swell (exaggerated: clouds are soft, the relief must still read from 117 m up)
      const e = 14;
      const nx = -(seaHeight(x + e, z) - seaHeight(x - e, z)) / (2 * e);
      const nz = -(seaHeight(x, z + e) - seaHeight(x, z - e)) / (2 * e);
      const k = 3.2;
      const l = Math.hypot(nx * k, 1, nz * k);
      const sun = (nx * k * SUN_TO[0] + SUN_TO[1] + nz * k * SUN_TO[2]) / l;
      const crest = smoothstep(-6, 7, y - (EVEREST.deck - 2));
      c.copy(SEA_SHADE).lerp(SEA_LIT, Math.min(1, smoothstep(0.25, 0.8, sun) * 0.75 + crest * 0.4));
      // against the mountain the sea is the whiteout itself
      c.lerp(white, 1 - smoothstep(150, 330, r));
      col.push(c.r, c.g, c.b);
    }
  }
  for (let j = 0; j < RINGS; j++) {
    for (let i = 0; i < SEG; i++) {
      const a = j * SEG + i;
      const b = j * SEG + ((i + 1) % SEG);
      const d = (j + 1) * SEG + i;
      const e = (j + 1) * SEG + ((i + 1) % SEG);
      // (rows are offset by half a cell: split each quad along its short diagonal; seen from above, +Y faces up)
      if (j % 2 === 0) idx.push(a, d, b, b, d, e);
      else idx.push(a, e, b, a, d, e);
    }
  }

  // --- the Himalaya: flat-shaded massifs (apex + 5 rings x 12 headings), ridges and gullies from a few lobes, snow lit by the one sun
  const PSEG = 12;
  const PRINGS = 5;
  const p: number[][] = [];
  const tri = (a: number[], b: number[], d: number[], seed: number): void => {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = d[0] - a[0];
    const vy = d[1] - a[1];
    const vz = d[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    // (a massif is a height field: its faces look up, whichever way the triangle winds; the material is double sided)
    const l = (Math.hypot(nx, ny, nz) || 1) * (ny < 0 ? -1 : 1);
    nx /= l;
    ny /= l;
    nz /= l;
    const sun = nx * SUN_TO[0] + ny * SUN_TO[1] + nz * SUN_TO[2];
    c.copy(SNOW_SHADE).lerp(SNOW_LIT, smoothstep(-0.05, 0.62, sun));
    // bare rock on the steepest faces, more of it lower down
    const my = (a[1] + b[1] + d[1]) / 3;
    const steep = 1 - smoothstep(0.42, 0.7, ny);
    const bare = steep * (0.25 + 0.75 * fbm(a[0] * 0.02 + seed, a[2] * 0.02, 151, 2)) * (1 - 0.5 * smoothstep(EVEREST.deck + 20, EVEREST.deck + 80, my));
    c.lerp(ROCK, Math.min(0.8, bare * 0.9));
    const o = pos.length / 3;
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2], d[0], d[1], d[2]);
    for (let k = 0; k < 3; k++) col.push(c.r, c.g, c.b);
    idx.push(o, o + 1, o + 2);
  };
  for (const P of HIMALAYA) {
    const rng = makeRandom(P.seed);
    const base = EVEREST.deck - 16;
    const lobes = [3 + Math.floor(rng() * 3), rng() * TAU, 0.16 + rng() * 0.16, 2, rng() * TAU, 0.1 + rng() * 0.14];
    const lean = [(rng() - 0.5) * 0.22 * P.r, (rng() - 0.5) * 0.22 * P.r];
    p.length = 0;
    for (let j = 1; j <= PRINGS; j++) {
      const t = j / PRINGS;
      for (let i = 0; i < PSEG; i++) {
        const a = ((i + (j % 2) * 0.5) / PSEG) * TAU;
        const ridge = 1 + lobes[2] * Math.cos(lobes[0] * a + lobes[1]) + lobes[5] * Math.cos(lobes[3] * a + lobes[4]);
        const r = P.r * Math.pow(t, 1.12) * (1 + (ridge - 1) * (0.35 + 0.65 * t)) * (0.9 + 0.2 * rng());
        const x = P.x + lean[0] * (1 - t) + Math.cos(a) * r;
        const z = P.z + lean[1] * (1 - t) + Math.sin(a) * r;
        // concave flanks (steep under the summit), ridges stand proud of the gullies
        const y = P.top - (P.top - base) * Math.pow(t, 0.72) * (1 - 0.8 * (ridge - 1) * 4 * t * (1 - t)) - (rng() - 0.5) * 9 * t;
        p.push([x, y, z]);
      }
    }
    const apex = [P.x + lean[0], P.top, P.z + lean[1]];
    for (let i = 0; i < PSEG; i++) tri(apex, p[(i + 1) % PSEG], p[i], P.seed);
    for (let j = 0; j < PRINGS - 1; j++) {
      for (let i = 0; i < PSEG; i++) {
        const a = p[j * PSEG + i];
        const b = p[j * PSEG + ((i + 1) % PSEG)];
        const d = p[(j + 1) * PSEG + i];
        const e = p[(j + 1) * PSEG + ((i + 1) % PSEG)];
        if (j % 2 === 1) {
          // the next ring sits half a cell ahead of this one
          tri(a, b, d, P.seed);
          tri(b, e, d, P.seed);
        } else {
          tri(a, e, d, P.seed);
          tri(a, b, e, P.seed);
        }
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

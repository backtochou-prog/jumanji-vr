/**
 * Mountain props, all prototypes for the static-batched chunk system (see chunks.scene-asset.ts):
 *
 *   canopy-N    a tree crown seen from above: lumpy opaque dome, vertex colour only. The valley and the ridge
 *               country are carpeted with these (hundreds of them, ~44 triangles each, no alpha test).
 *   pinnacle-N  a rock tower with strata ledges, 10 m at scale 1 (placed at scale 2.5 - 7: the colossal formations
 *               that give the valley its scale).
 *   vine-N      a curtain of hanging lianas with leaf cards, origin at the top, 4.5 - 9 m long (cliff lips, gorge rim).
 */
import { BufferGeometry, Color, Float32BufferAttribute, Mesh, Vector3 } from '@iwsdk/core';
import { fbm, makeRandom, smoothstep } from '../world/layout.js';
import { PAL } from '../world/palette.js';
import { cardGeometry, lerpColor, mat, mergeParts, softNormals, solidUV, tubeAlong } from './lib/geo.js';
import type { Part } from './lib/geo.js';
import { canopyMaterial, foliageCardMaterial, rockMaterial } from './lib/materials.js';

// ---------------------------------------------------------------------------
// Canopy crowns
// ---------------------------------------------------------------------------

/** A crown on an 8 m trunk: 8 sides, base ring + 2 rings + apex = 40 triangles + 24 for the trunk. Origin at the crown's underside; ~9 m wide, ~5 m tall; the trunk reaches 8 m down to the ground. */
export function createCanopyClump(variant: number): Mesh {
  const rng = makeRandom(7000 + variant * 13);
  const sides = 8;
  const rings = [
    { y: 0.0, r: 3.3 },
    { y: 1.5, r: 5.3 },
    { y: 3.4, r: 4.9 },
    { y: 4.9, r: 2.6 },
    { y: 6.0, r: 0 },
  ];
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const dark = new Color(PAL.leafDeep).lerp(new Color(PAL.leafShade), 0.25);
  const mid = new Color(PAL.leafShade).lerp(new Color(PAL.leafMid), 0.55);
  const light = new Color(PAL.leafMid).lerp(new Color(PAL.leafLight), 0.55);
  const c = new Color();
  const phase = rng() * 6.28;
  rings.forEach((ring, k) => {
    const n = k === rings.length - 1 ? 1 : sides;
    for (let j = 0; j < n; j++) {
      const a = (j / sides) * Math.PI * 2 + phase;
      const lump = ring.r === 0 ? 0 : ring.r * (0.78 + 0.5 * rng());
      const y = ring.y + (rng() - 0.5) * (k === 0 ? 0 : 0.7);
      pos.push(Math.cos(a) * lump, y, Math.sin(a) * lump);
      const t = ring.y / 6.0;
      c.copy(dark).lerp(mid, smoothstep(0.0, 0.55, t)).lerp(light, smoothstep(0.45, 1.0, t) * (0.55 + 0.45 * rng()));
      c.multiplyScalar(0.82 + 0.3 * rng()); // blotchy: sun and shade patches across the crown
      col.push(c.r, c.g, c.b);
    }
  });
  // Trunk: a tapered 6-sided prism from 12 m below the crown's underside up into the crown (so a crown never floats).
  const trunkBase = pos.length / 3;
  const bark = new Color(PAL.bark).lerp(new Color(PAL.barkDark), 0.35);
  for (const [y, r] of [[-8, 0.85], [-4, 0.62], [0.6, 0.44]] as const) {
    for (let j = 0; j < 6; j++) {
      const a = (j / 6) * Math.PI * 2;
      pos.push(Math.cos(a) * r, y, Math.sin(a) * r);
      col.push(bark.r, bark.g, bark.b);
    }
  }
  const ringStart = (k: number) => k * sides;
  for (let k = 0; k < 3; k++) {
    for (let j = 0; j < sides; j++) {
      const a = ringStart(k) + j;
      const b = ringStart(k) + ((j + 1) % sides);
      const a2 = ringStart(k + 1) + j;
      const b2 = ringStart(k + 1) + ((j + 1) % sides);
      idx.push(a, a2, b, b, a2, b2);
    }
  }
  for (let k = 0; k < 2; k++) {
    for (let j = 0; j < 6; j++) {
      const a = trunkBase + k * 6 + j;
      const b = trunkBase + k * 6 + ((j + 1) % 6);
      idx.push(a, a + 6, b, b, a + 6, b + 6);
    }
  }
  const apex = sides * 4;
  for (let j = 0; j < sides; j++) idx.push(ringStart(3) + j, apex, ringStart(3) + ((j + 1) % sides));
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Soft, upward-biased normals: the crown is lit as a rounded mass instead of eight flat facets.
  const nrm = g.getAttribute('normal');
  const v = new Vector3();
  for (let i = 0; i < nrm.count; i++) {
    v.set(g.getAttribute('position').getX(i), g.getAttribute('position').getY(i) - 1.2, g.getAttribute('position').getZ(i)).normalize().multiplyScalar(0.6).add(new Vector3(0, 0.55, 0)).normalize();
    nrm.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeBoundingBox();
  g.computeBoundingSphere();
  const m = new Mesh(g, canopyMaterial);
  m.name = `Canopy_${variant}`;
  return m;
}

// ---------------------------------------------------------------------------
// Rock pinnacles
// ---------------------------------------------------------------------------

const ROCK = { light: new Color(PAL.cliff), dark: new Color(PAL.cliffDark), warm: new Color(PAL.cliffWarm), moss: new Color(PAL.mossDeep), leaf: new Color(PAL.leafMid) };

/** A weathered tower of stacked strata: ledges, a lean, a rounded mossy top. 10 m tall at scale 1, base ~2.8 m radius. */
export function createPinnacle(variant: number): Mesh {
  const seed = 8100 + variant * 29;
  const rng = makeRandom(seed);
  const rows = 11;
  const sides = 10;
  const H = 10;
  const lean = [0.9, -1.3, 0.4][variant % 3];
  const taper = [0.5, 0.62, 0.4][variant % 3];
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const c = new Color();
  for (let k = 0; k <= rows; k++) {
    const t = k / rows;
    const y = t * H;
    // Ledges: the profile steps out and in with the strata; a waist, then a heavier cap.
    const ledge = 1 + 0.28 * Math.sin(t * 17 + seed) * (1 - t * 0.5) + 0.2 * Math.sin(t * 5.3 + variant) + (t > 0.82 ? 0.18 * smoothstep(0.82, 0.92, t) : 0);
    const R = 2.8 * (1 - taper * t) * ledge * (k === rows ? 0.55 : 1);
    const cx = lean * t * t * 2.2;
    for (let j = 0; j < sides; j++) {
      const a = (j / sides) * Math.PI * 2;
      const rough = 0.8 + 0.45 * fbm(Math.cos(a) * 1.7 + k * 0.9 + seed, Math.sin(a) * 1.7 + t * 3, seed, 3);
      const r = R * rough;
      const px = cx + Math.cos(a) * r;
      const pz = Math.sin(a) * r;
      pos.push(px, y, pz);
      const band = 0.5 + 0.5 * Math.sin(y * 3.2 + seed);
      c.copy(ROCK.dark).lerp(ROCK.light, 0.35 + 0.4 * band).lerp(ROCK.warm, smoothstep(0.55, 0.9, fbm(px * 0.8, y * 0.5 + pz * 0.3, seed + 3, 2)) * 0.45);
      c.lerp(ROCK.dark, (1 - smoothstep(0, 0.25, t)) * 0.35); // dark, wet foot
      c.lerp(ROCK.moss, smoothstep(0.78, 1.0, t) * 0.7).lerp(ROCK.leaf, smoothstep(0.93, 1.0, t) * 0.45); // mossy, shrubby cap
      col.push(c.r, c.g, c.b);
    }
  }
  for (let k = 0; k < rows; k++) {
    for (let j = 0; j < sides; j++) {
      const a = k * sides + j;
      const b = k * sides + ((j + 1) % sides);
      const a2 = (k + 1) * sides + j;
      const b2 = (k + 1) * sides + ((j + 1) % sides);
      idx.push(a, a2, b, b, a2, b2);
    }
  }
  // Top cap (fan) and a buried base (so the foot can sink into the ground).
  const top = pos.length / 3;
  const R = 2.8 * (1 - taper) * 0.55;
  pos.push(lean * 2.2, H + 0.4, 0);
  col.push(ROCK.moss.r, ROCK.moss.g, ROCK.moss.b);
  for (let j = 0; j < sides; j++) idx.push(rows * sides + j, top, rows * sides + ((j + 1) % sides));
  void R;
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // UVs: grain tiles by position (the rock material samples a small grain texture).
  const uv: number[] = [];
  for (let i = 0; i < pos.length / 3; i++) uv.push(pos[i * 3] * 0.35 + pos[i * 3 + 2] * 0.2, pos[i * 3 + 1] * 0.35);
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  const m = new Mesh(g, rockMaterial);
  m.name = `Pinnacle_${variant}`;
  return m;
}

// ---------------------------------------------------------------------------
// Vine curtains
// ---------------------------------------------------------------------------

/** Hanging lianas from a lip: 5 strands with leaf cards, 4.5 - 9 m. Origin at the top of the curtain, curtain spreads along local X, hangs toward -Y, hugs -Z. */
export function createVineCurtain(variant: number): Mesh {
  const rng = makeRandom(8800 + variant * 17);
  const parts: Part[] = [];
  const stem = new Color(PAL.barkDark).lerp(new Color(PAL.bark), 0.35);
  const lo = new Color(PAL.leafShade);
  const hi = new Color(PAL.leafLight);
  const strands = 5;
  for (let i = 0; i < strands; i++) {
    const x0 = (i - (strands - 1) / 2) * (0.7 + 0.3 * rng()) + (rng() - 0.5) * 0.3;
    const L = 4.5 + rng() * 4.5 * (0.6 + variant * 0.2);
    const sway = (rng() - 0.5) * 0.9;
    const pts: Vector3[] = [];
    for (let k = 0; k <= 5; k++) {
      const t = k / 5;
      pts.push(new Vector3(x0 + sway * t * t, -L * t, -0.25 * Math.sin(t * 3.1) - 0.2 * t));
    }
    parts.push({ geo: solidUV(tubeAlong(pts, (t) => 0.035 * (1 - 0.5 * t), 5, 10)), color: stem });
    // Leaf cards along the strand: alternating sides, bigger towards the middle.
    const n = Math.round(L / 0.55);
    for (let k = 1; k < n; k++) {
      const t = k / n;
      const size = 0.55 + 0.4 * Math.sin(t * Math.PI) * (0.6 + 0.4 * rng());
      const p = pts[Math.min(5, Math.floor(t * 5))].clone().lerp(pts[Math.min(5, Math.floor(t * 5) + 1)], (t * 5) % 1);
      const side = k % 2 ? 1 : -1;
      parts.push({
        geo: cardGeometry('vine', size, size * 0.85, 0.5, 2),
        m: mat(p.x + side * 0.05, p.y - size * 0.1, p.z, (rng() - 0.5) * 0.4, rng() * Math.PI * 2, (rng() - 0.5) * 0.5).multiply(mat(0, 0, 0, Math.PI, 0, 0)),
        normalFn: softNormals(new Vector3(x0, p.y - 1, -0.3), 0.4),
        color: () => lerpColor(lo, hi, 0.2 + 0.7 * rng()),
      });
    }
  }
  const m = new Mesh(mergeParts(parts), foliageCardMaterial);
  m.name = `Vine_${variant}`;
  return m;
}

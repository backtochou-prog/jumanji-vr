/**
 * Understory and ground-layer species, all alpha-cutout cards from the shared
 * leaf atlas (one material). Biology first: leaf sizes, stalk lengths and
 * frond counts follow each species' real proportions; instancing only applies
 * small uniform scale (+-10 %) and yaw, never squashing.
 *
 *   ferns        S (0.5 m) / M (0.9 m) / L (1.35 m), 2 variants each
 *   tree fern    trunk + crown of broad fronds
 *   palms        4 species: arching coconut-type, fan, clustered slender, sago
 *   broad-leaf   3 species: heliconia-type, banana-type, alocasia-type
 *   shrub        2 dense bushes
 *   ground cover clover mat, grass tuft, mixed; flowers (the warm accent); moss; litter
 *   water plants reeds, floating pads
 */
import { Color, Mesh, Vector3 } from '@iwsdk/core';
import { makeRandom } from '../world/layout.js';
import { PAL } from '../world/palette.js';
import { cardGeometry, lerpColor, mat, mergeBaked, mergeParts, softNormals, solidUV, tubeAlong } from './lib/geo.js';
import type { Part } from './lib/geo.js';
import { foliageCardMaterial } from './lib/materials.js';

const GOLDEN = 2.399963;
const leafTint = (rng: () => number, a: string = PAL.leafMid, b: string = PAL.leafLight): Color => lerpColor(a, b, 0.2 + 0.7 * rng());

function finish(parts: Part[], name: string): Mesh {
  const m = new Mesh(mergeParts(parts), foliageCardMaterial);
  m.name = name;
  return m;
}

/** Tint a card from dark (base) to light (tip) so fronds read as lit from the tip. */
const baseToTip = (len: number, lo: Color, hi: Color, y0 = 0) => (p: Vector3) => lo.clone().lerp(hi, Math.min(1, Math.max(0, (p.y - y0) / len)));

// ---------------------------------------------------------------------------
// Ferns
// ---------------------------------------------------------------------------

export type FernSize = 's' | 'm' | 'l';
const FERN = { s: { fronds: 9, len: 0.5 }, m: { fronds: 12, len: 0.9 }, l: { fronds: 14, len: 1.35 } } as const;

/** Rosette fern: fronds rise, then arch outward under their own weight. */
export function createFern(size: FernSize, variant: number): Mesh {
  const spec = FERN[size];
  const rng = makeRandom(300 + variant * 17 + spec.fronds);
  const parts: Part[] = [];
  const lo = new Color(PAL.leafShade).lerp(new Color(PAL.leafMid), 0.3 + 0.25 * rng());
  const hi = new Color(PAL.leafLight).lerp(new Color(PAL.leafSun), 0.2 + 0.3 * rng());
  const centre = new Vector3(0, 0.1, 0);
  for (let i = 0; i < spec.fronds; i++) {
    const yaw = i * GOLDEN + rng() * 0.3;
    const L = spec.len * (0.75 + 0.4 * rng());
    // Inner fronds stand tall, outer ones arch low (a true rosette profile).
    const ring = i / spec.fronds;
    const tilt = 0.35 + 0.85 * ring + (rng() - 0.5) * 0.18;
    const m = mat(0, 0, 0, tilt, yaw, 0);
    parts.push({ geo: cardGeometry('fern', L, L * 0.44, 0.9 + 0.7 * ring, 2), m, normalFn: softNormals(centre, 0.7), color: baseToTip(L, lo, hi) });
  }
  return finish(parts, `Fern_${size}${variant}`);
}

/** Tree fern: a fibrous trunk and a crown of broad fronds. */
export function createTreeFern(variant: number): Mesh {
  const rng = makeRandom(340 + variant);
  const parts: Part[] = [];
  const h = 2.0 + variant * 0.7;
  const trunk = tubeAlong([new Vector3(0, -0.1, 0), new Vector3(0.05, h * 0.5, 0.02), new Vector3(0.08, h, 0)], (t) => 0.13 - 0.04 * t, 5, 6);
  parts.push({ geo: solidUV(trunk), color: (p) => lerpColor('#4a3a28', '#6b5236', 0.5 + 0.5 * Math.sin(p.y * 22)) });
  const crown = new Vector3(0.08, h, 0);
  const lo = new Color(PAL.leafShade).lerp(new Color(PAL.leafMid), 0.4);
  const hi = new Color(PAL.leafLight);
  for (let i = 0; i < 13; i++) {
    const yaw = i * GOLDEN + rng() * 0.2;
    const L = 1.7 + rng() * 0.8;
    const tilt = 0.6 + 0.8 * (i / 13) + (rng() - 0.5) * 0.15;
    parts.push({ geo: cardGeometry('frond2', L, L * 0.4, 1.0 + 0.5 * (i / 13), 3), m: mat(crown.x, crown.y, crown.z, tilt, yaw, 0), normalFn: softNormals(crown.clone().add(new Vector3(0, -0.4, 0)), 0.6), color: baseToTip(L, lo, hi, crown.y - 0.2) });
  }
  return finish(parts, `TreeFern_${variant}`);
}

// ---------------------------------------------------------------------------
// Palms
// ---------------------------------------------------------------------------

function ringedTrunk(rng: () => number, height: number, lean: number, radius: number): { geo: ReturnType<typeof tubeAlong>; top: Vector3 } {
  const top = new Vector3(lean, height, (rng() - 0.5) * 0.5);
  const pts = [new Vector3(0, -0.2, 0), new Vector3(lean * 0.12, height * 0.35, 0), new Vector3(lean * 0.5, height * 0.7, top.z * 0.5), top];
  return { geo: solidUV(tubeAlong(pts, (t) => radius * (1.15 - 0.35 * t) + 0.01 * Math.sin(t * 60), 6, 9)), top };
}
const ringColor = (p: Vector3) => lerpColor('#4f4636', '#7d6f56', 0.5 + 0.5 * Math.sin(p.y * 16)).multiplyScalar(0.6 + 0.4 * Math.min(1, Math.max(0, (p.y + 0.2) / 1.2)));

/** Four distinct palm silhouettes (variant 0..3). */
export function createPalm(variant: number): Mesh {
  const rng = makeRandom(700 + variant * 31);
  const parts: Part[] = [];
  const lo = new Color(PAL.leafShade).lerp(new Color(PAL.leafMid), 0.35);
  const hi = new Color(PAL.leafLight).lerp(new Color(PAL.leafSun), 0.25);
  if (variant === 0) {
    // Arching coconut-type: tall leaning trunk, long drooping pinnate fronds.
    const t = ringedTrunk(rng, 8.5, 1.4, 0.15);
    parts.push({ geo: t.geo, color: ringColor });
    for (let i = 0; i < 15; i++) {
      const L = 3.4 + rng() * 0.9;
      const tilt = 0.5 + 0.9 * (i / 15) + (rng() - 0.5) * 0.15;
      parts.push({ geo: cardGeometry('palm', L, L * 0.34, 1.5 + 0.9 * (i / 15), 5), m: mat(t.top.x, t.top.y, t.top.z, tilt, i * GOLDEN + rng() * 0.2, 0), normalFn: softNormals(t.top.clone().add(new Vector3(0, -0.8, 0)), 0.6), color: baseToTip(L, lo, hi, t.top.y - 0.3) });
    }
  } else if (variant === 1) {
    // Fan palm: short stout trunk, big rounded crown of wide fronds.
    const t = ringedTrunk(rng, 3.6, 0.4, 0.2);
    parts.push({ geo: t.geo, color: ringColor });
    for (let i = 0; i < 18; i++) {
      const L = 1.9 + rng() * 0.5;
      const tilt = 0.25 + 1.2 * (i / 18);
      parts.push({ geo: cardGeometry('frond2', L, L * 0.62, 0.8 + 0.6 * (i / 18), 3), m: mat(t.top.x, t.top.y, t.top.z, tilt, i * GOLDEN, 0), normalFn: softNormals(t.top, 0.55), color: baseToTip(L, lo, hi, t.top.y - 0.3) });
    }
  } else if (variant === 2) {
    // Clustered slender palm (areca-type): three stems of different height.
    for (let s = 0; s < 3; s++) {
      const h = 4.2 + s * 1.3 + rng();
      const t = ringedTrunk(rng, h, (s - 1) * 0.55, 0.075);
      const base = new Vector3((s - 1) * 0.22, 0, (rng() - 0.5) * 0.25);
      parts.push({ geo: t.geo, m: mat(base.x, 0, base.z), color: ringColor });
      for (let i = 0; i < 8; i++) {
        const L = 1.9 + rng() * 0.5;
        parts.push({ geo: cardGeometry('palm', L, L * 0.3, 1.1 + 0.7 * (i / 8), 4), m: mat(base.x + t.top.x, t.top.y, base.z + t.top.z, 0.45 + 0.9 * (i / 8), i * GOLDEN + s, 0), normalFn: softNormals(new Vector3(base.x + t.top.x, t.top.y - 0.6, base.z + t.top.z), 0.6), color: baseToTip(L, lo, hi, t.top.y - 0.3) });
      }
    }
  } else {
    // Sago-type: no trunk to speak of, stiff upright fronds in a tight crown.
    const crown = new Vector3(0, 0.35, 0);
    parts.push({ geo: solidUV(tubeAlong([new Vector3(0, -0.1, 0), new Vector3(0, 0.35, 0)], () => 0.14, 6, 2)), color: () => new Color('#4b3b2a') });
    for (let i = 0; i < 22; i++) {
      const L = 1.4 + rng() * 0.5;
      const tilt = 0.2 + 1.0 * (i / 22) + (rng() - 0.5) * 0.12;
      parts.push({ geo: cardGeometry('frond2', L, L * 0.3, 0.9 + 0.4 * (i / 22), 3), m: mat(crown.x, crown.y, crown.z, tilt, i * GOLDEN, 0), normalFn: softNormals(crown, 0.7), color: baseToTip(L, lo, hi, crown.y - 0.1) });
    }
  }
  return finish(parts, `Palm_${variant}`);
}

// ---------------------------------------------------------------------------
// Broad-leaf plants
// ---------------------------------------------------------------------------

/** 0 heliconia-type (upright paddle leaves), 1 banana-type (tall arching), 2 alocasia-type (heart leaves). */
export function createBroadleaf(variant: number): Mesh {
  const rng = makeRandom(800 + variant * 13);
  const parts: Part[] = [];
  const centre = new Vector3(0, 0.6, 0);
  const lo = new Color(PAL.leafShade).lerp(new Color(PAL.leafMid), 0.45);
  const hi = new Color(PAL.leafLight);
  const species = [
    { n: 7, tile: 'broad' as const, L: 1.3, W: 0.55, stalk: 0.55, tilt: [0.15, 0.7], bend: 0.9 },
    { n: 6, tile: 'broad' as const, L: 2.1, W: 0.75, stalk: 1.3, tilt: [0.25, 0.85], bend: 1.3 },
    { n: 7, tile: 'heart' as const, L: 0.95, W: 0.85, stalk: 0.9, tilt: [0.3, 0.9], bend: 0.7 },
  ][variant % 3];
  for (let i = 0; i < species.n; i++) {
    const yaw = i * GOLDEN + rng() * 0.3;
    const tilt = species.tilt[0] + (species.tilt[1] - species.tilt[0]) * ((i * 0.37) % 1);
    const stalkLen = species.stalk * (0.7 + 0.5 * rng());
    const base = mat(0, 0, 0, tilt, yaw, 0);
    const tip = new Vector3(0, stalkLen, stalkLen * 0.08).applyMatrix4(base);
    parts.push({ geo: solidUV(tubeAlong([new Vector3(0, -0.05, 0), new Vector3(0, stalkLen * 0.5, stalkLen * 0.03), new Vector3(0, stalkLen, stalkLen * 0.08)], (t) => 0.02 * (1.3 - 0.5 * t), 4, 3)), m: base, color: () => lerpColor('#35502a', '#5a7640', rng()) });
    const L = species.L * (0.8 + 0.35 * rng());
    const bm = base.clone().multiply(mat(0, stalkLen, stalkLen * 0.08, 0.15, 0, 0));
    parts.push({ geo: cardGeometry(species.tile, L, species.W * (L / species.L), species.bend, 3), m: bm, normalFn: softNormals(centre, 0.6), color: baseToTip(L, lo, hi.clone().lerp(new Color(PAL.leafSun), rng() * 0.35)) });
    void tip;
  }
  return finish(parts, `Broadleaf_${variant}`);
}

/** Dense low bush: crossed clump cards plus a few broad leaves. */
export function createShrub(variant: number): Mesh {
  const rng = makeRandom(900 + variant * 9);
  const parts: Part[] = [];
  const centre = new Vector3(0, 0.45, 0);
  const lo = new Color(PAL.leafShade);
  const hi = new Color(PAL.leafLight);
  const size = 1.0 + variant * 0.25;
  for (let i = 0; i < 9; i++) {
    const s = size * (0.8 + 0.5 * rng());
    const flat = i % 3 === 0;
    const m = mat((rng() - 0.5) * size * 0.6, 0.15 + rng() * 0.35, (rng() - 0.5) * size * 0.6, flat ? -1.15 : (rng() - 0.5) * 0.5, rng() * 6.28, 0).multiply(mat(0, -s / 2, 0));
    const t = rng();
    parts.push({ geo: cardGeometry('clump', s, s, 0, 1), m, normalFn: softNormals(centre, 0.45), color: () => lerpColor(lo, hi, 0.2 + 0.55 * t) });
  }
  for (let i = 0; i < 4; i++) {
    parts.push({ geo: cardGeometry('broad', 0.8 * size, 0.38 * size, 1.0, 2), m: mat(0, 0.1, 0, 0.9 + rng() * 0.4, i * GOLDEN * 1.7, 0), normalFn: softNormals(centre, 0.6), color: baseToTip(0.8, lo, hi) });
  }
  return finish(parts, `Shrub_${variant}`);
}

// ---------------------------------------------------------------------------
// Ground cover, flowers, moss, litter
// ---------------------------------------------------------------------------

/** 0 clover mat, 1 grass tuft, 2 mixed. Lying cards are slightly raised so they never z-fight the ground. */
export function createCover(variant: number): Mesh {
  const rng = makeRandom(1000 + variant * 7);
  const parts: Part[] = [];
  const lo = new Color(PAL.leafMid);
  const hi = new Color(PAL.grassDry).lerp(new Color(PAL.leafLight), 0.4);
  const up = new Vector3(0, 0.8, 0);
  const centre = new Vector3(0, -0.2, 0);
  const grass = (n: number, L: number) => {
    for (let i = 0; i < n; i++) parts.push({ geo: cardGeometry('grass', L, L * 0.8, 0.5 + rng() * 0.5, 2), m: mat((rng() - 0.5) * 0.15, 0, (rng() - 0.5) * 0.15, (rng() - 0.5) * 0.2, (i * Math.PI) / n + rng() * 0.3, 0), normalFn: softNormals(centre, 0.8), color: baseToTip(L, lo, hi) });
  };
  const clover = (n: number, s: number) => {
    for (let i = 0; i < n; i++) {
      const a = i * GOLDEN;
      parts.push({ geo: cardGeometry('clover', s, s, 0, 1), m: mat(Math.cos(a) * 0.14 * i, 0.03 + 0.012 * i, Math.sin(a) * 0.14 * i, -Math.PI / 2 + 0.12, rng() * 6.28, 0).multiply(mat(0, -s / 2, 0)), normalFn: () => up.clone(), color: () => lerpColor(PAL.leafMid, PAL.leafLight, rng()) });
    }
  };
  if (variant === 0) clover(3, 0.55);
  else if (variant === 1) grass(3, 0.6);
  else {
    grass(2, 0.5);
    clover(2, 0.45);
  }
  return finish(parts, `Cover_${variant}`);
}

/** Wildflowers: the one warm accent. Two crossed cards. */
export function createFlowers(variant: number): Mesh {
  const rng = makeRandom(1100 + variant);
  const parts: Part[] = [];
  const up = new Vector3(0, 1, 0);
  for (let i = 0; i < 3; i++) {
    const L = 0.42 + rng() * 0.14 + variant * 0.06;
    parts.push({ geo: cardGeometry('flowers', L, L, 0.2, 1), m: mat((rng() - 0.5) * 0.12, 0, (rng() - 0.5) * 0.12, (rng() - 0.5) * 0.2, (i * Math.PI) / 3 + rng(), 0), normalFn: () => up.clone(), color: () => new Color(1, 1, 1) });
  }
  return finish(parts, `Flowers_${variant}`);
}

/** Moss mat: flat cards lying on the ground/rock, embedded slightly. */
export function createMoss(variant: number): Mesh {
  const rng = makeRandom(1200 + variant);
  const parts: Part[] = [];
  const up = new Vector3(0, 1, 0);
  for (let i = 0; i < 2; i++) {
    const s = 0.85 + rng() * 0.5;
    parts.push({ geo: cardGeometry('moss', s, s, 0, 1), m: mat((rng() - 0.5) * 0.3, 0.025 + 0.01 * i, (rng() - 0.5) * 0.3, -Math.PI / 2, rng() * 6.28, 0).multiply(mat(0, -s / 2, 0)), normalFn: () => up.clone(), color: () => lerpColor(PAL.mossDeep, PAL.moss, 0.4 + 0.5 * rng()) });
  }
  return finish(parts, `Moss_${variant}`);
}

/** Leaf-litter patch lying on the ground. */
export function createLitter(variant: number): Mesh {
  const rng = makeRandom(1300 + variant);
  const parts: Part[] = [];
  const up = new Vector3(0, 1, 0);
  const s = 1.1 + variant * 0.3;
  parts.push({ geo: cardGeometry('litter', s, s, 0, 1), m: mat(0, 0.02, 0, -Math.PI / 2, rng() * 6.28, 0).multiply(mat(0, -s / 2, 0)), normalFn: () => up.clone(), color: () => lerpColor(PAL.litter, PAL.leafDead, rng()) });
  return finish(parts, `Litter_${variant}`);
}

// ---------------------------------------------------------------------------
// Water plants
// ---------------------------------------------------------------------------

/** Reeds/sedge: tall narrow grass cards. */
export function createReed(variant: number): Mesh {
  const rng = makeRandom(1400 + variant * 5);
  const parts: Part[] = [];
  const lo = new Color(PAL.leafShade).lerp(new Color(PAL.leafMid), 0.5);
  const hi = new Color(PAL.grassDry).lerp(new Color(PAL.leafLight), 0.55);
  const centre = new Vector3(0, -0.3, 0);
  const n = 6 + variant;
  for (let i = 0; i < n; i++) {
    const L = (1.1 + rng() * 0.55) * (variant ? 0.8 : 1);
    parts.push({ geo: cardGeometry('grass', L, L * 0.55, 0.45 + rng() * 0.6, 3), m: mat((rng() - 0.5) * 0.2, 0, (rng() - 0.5) * 0.2, (rng() - 0.5) * 0.25, (i * Math.PI) / n + rng() * 0.4, 0), normalFn: softNormals(centre, 0.7), color: baseToTip(L, lo, hi) });
  }
  return finish(parts, `Reed_${variant}`);
}

/** Floating leaf pads: low, flat, slightly different greens. */
export function createPads(variant: number): Mesh {
  const rng = makeRandom(1500 + variant);
  const parts: Part[] = [];
  const up = new Vector3(0, 1, 0);
  for (let i = 0; i < 4; i++) {
    const s = 0.5 + rng() * 0.3;
    const a = i * GOLDEN;
    parts.push({ geo: cardGeometry('moss', s, s, 0, 1), m: mat(Math.cos(a) * 0.45, 0, Math.sin(a) * 0.45, -Math.PI / 2, rng() * 6.28, 0).multiply(mat(0, -s / 2, 0)), normalFn: () => up.clone(), color: () => lerpColor(PAL.leafMid, PAL.leafSun, 0.2 + 0.4 * rng()) });
  }
  return finish(parts, `Pads_${variant}`);
}


// ---------------------------------------------------------------------------
// Composites: fern clusters and ground-cover patches (fewer draw calls, more natural groups)
// ---------------------------------------------------------------------------

/**
 * A cluster of ferns of mixed size, like a real stand: 0 = small (edge of the trail),
 * 1 = medium, 2 = large. One asset, one instance = 3-5 plants.
 */
export function createFernCluster(variant: number): Mesh {
  const rng = makeRandom(2000 + variant * 11);
  const mix: { size: FernSize; n: number }[][] = [
    [{ size: 's', n: 4 }, { size: 'm', n: 1 }],
    [{ size: 'm', n: 3 }, { size: 's', n: 2 }],
    [{ size: 'l', n: 2 }, { size: 'm', n: 2 }, { size: 's', n: 1 }],
  ];
  const items: { geo: ReturnType<typeof createFern>['geometry']; m: ReturnType<typeof mat> }[] = [];
  let k = 0;
  for (const g of mix[variant % 3]) {
    for (let i = 0; i < g.n; i++) {
      const a = k * GOLDEN + rng();
      const rad = 0.2 + 0.28 * k + rng() * 0.12;
      items.push({ geo: createFern(g.size, (k + variant) % 2).geometry, m: mat(Math.cos(a) * rad, 0, Math.sin(a) * rad, 0, rng() * 6.28, 0, 0.9 + rng() * 0.2) });
      k++;
    }
  }
  const m = new Mesh(mergeBaked(items), foliageCardMaterial);
  m.name = `FernCluster_${variant}`;
  return m;
}

/**
 * Ground-cover patch (1.6 m): 0 meadow (grass + clover + wildflowers), 1 grass + clover,
 * 2 woodland floor (clover + litter), 3 mossy floor (moss + litter). Embedded cards, never floating.
 */
export function createPatch(variant: number): Mesh {
  const rng = makeRandom(2100 + variant * 7);
  const bits: { geo: ReturnType<typeof createFern>['geometry']; m: ReturnType<typeof mat> }[] = [];
  const put = (mesh: Mesh, n: number, spread: number, scaleLo = 0.9, scaleHi = 1.1) => {
    for (let i = 0; i < n; i++) {
      const a = rng() * 6.28;
      const r = Math.sqrt(rng()) * spread;
      bits.push({ geo: mesh.geometry, m: mat(Math.cos(a) * r, 0, Math.sin(a) * r, 0, rng() * 6.28, 0, scaleLo + (scaleHi - scaleLo) * rng()) });
    }
  };
  if (variant === 0) {
    put(createCover(1), 3, 0.6);
    put(createCover(0), 2, 0.6);
    put(createFlowers(0), 2, 0.55);
    put(createFlowers(1), 1, 0.55);
  } else if (variant === 1) {
    put(createCover(1), 3, 0.6);
    put(createCover(2), 2, 0.6);
  } else if (variant === 2) {
    put(createLitter(0), 1, 0.3);
    put(createCover(0), 2, 0.6);
    put(createLitter(1), 1, 0.4);
  } else {
    put(createMoss(0), 1, 0.3);
    put(createMoss(1), 1, 0.45);
    put(createLitter(1), 1, 0.45);
    put(createCover(2), 1, 0.5);
  }
  const m = new Mesh(mergeBaked(bits), foliageCardMaterial);
  m.name = `Patch_${variant}`;
  return m;
}

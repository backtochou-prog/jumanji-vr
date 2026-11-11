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
import { BufferGeometry, CircleGeometry, Color, CylinderGeometry, Float32BufferAttribute, Mesh, Uint8BufferAttribute, Vector3 } from '@iwsdk/core';
import { makeRandom } from '../world/layout.js';
import { MEADOW, PAL } from '../world/palette.js';
import { cardGeometry, lerpColor, mat, mergeBaked, mergeParts, softNormals, solidUV, tubeAlong } from './lib/geo.js';
import type { Part } from './lib/geo.js';
import { tileUV } from './lib/leaf-atlas.js';
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
    // Walking palm (paxiuba, Socratea exorrhiza): a slim tall stem standing on a cone of stilt roots, long drooping pinnate fronds.
    const t = ringedTrunk(rng, 8.5, 1.4, 0.13);
    parts.push({ geo: t.geo, color: ringColor });
    for (let i = 0; i < 9; i++) {
      const a = i * GOLDEN;
      const reach = 0.42 + 0.3 * rng();
      const top = new Vector3(0.03, 1.15 + 0.5 * rng(), 0);
      const foot = new Vector3(Math.cos(a) * reach, -0.12, Math.sin(a) * reach);
      const knee = top.clone().lerp(foot, 0.45).add(new Vector3(Math.cos(a) * 0.08, 0.1, Math.sin(a) * 0.08));
      parts.push({ geo: solidUV(tubeAlong([top, knee, foot], () => 0.028, 4, 2)), color: (p) => lerpColor('#3d3024', '#6a5a44', Math.min(1, Math.max(0, p.y / 1.4))) });
    }
    for (let i = 0; i < 15; i++) {
      const L = 3.4 + rng() * 0.9;
      const tilt = 0.5 + 0.9 * (i / 15) + (rng() - 0.5) * 0.15;
      parts.push({ geo: cardGeometry('palm', L, L * 0.34, 1.5 + 0.9 * (i / 15), 5), m: mat(t.top.x, t.top.y, t.top.z, tilt, i * GOLDEN + rng() * 0.2, 0), normalFn: softNormals(t.top.clone().add(new Vector3(0, -0.8, 0)), 0.6), color: baseToTip(L, lo, hi, t.top.y - 0.3) });
    }
  } else if (variant === 1) {
    // Buriti-type fan palm (Mauritia): short stout trunk, big rounded crown of wide fronds.
    const t = ringedTrunk(rng, 3.6, 0.4, 0.2);
    parts.push({ geo: t.geo, color: ringColor });
    for (let i = 0; i < 18; i++) {
      const L = 1.9 + rng() * 0.5;
      const tilt = 0.25 + 1.2 * (i / 18);
      parts.push({ geo: cardGeometry('frond2', L, L * 0.62, 0.8 + 0.6 * (i / 18), 3), m: mat(t.top.x, t.top.y, t.top.z, tilt, i * GOLDEN, 0), normalFn: softNormals(t.top, 0.55), color: baseToTip(L, lo, hi, t.top.y - 0.3) });
    }
  } else if (variant === 2) {
    // Acai (Euterpe oleracea): a clump of three slender stems of different height with feathery crowns.
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
    // Stemless understory palm (ubim / Geonoma-type): no trunk to speak of, stiff fronds in a tight crown.
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

/** 0 heliconia (paddle leaves + hanging red lobster-claw bracts), 1 sororoca / wild banana (Phenakospermum, tall arching), 2 philodendron / taioba (heart leaves). */
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
  if (variant % 3 === 0) {
    // Heliconia rostrata: pendant chains of red, yellow-tipped bracts ("lobster claws"), the understory's signal colour.
    const red = new Color(PAL.heliconia);
    const tipC = new Color(PAL.accent).lerp(new Color('#f2d04a'), 0.5);
    for (let k = 0; k < 2; k++) {
      const yaw = 0.9 + k * 2.7;
      const out = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const top = new Vector3(0, 1.25 + 0.2 * k, 0).addScaledVector(out, 0.32);
      parts.push({ geo: solidUV(tubeAlong([new Vector3(0, 0.1, 0), new Vector3(0, 1.0, 0).addScaledVector(out, 0.1), top, top.clone().add(new Vector3(0, -0.75, 0)).addScaledVector(out, 0.1)], () => 0.014, 3, 5)), color: () => lerpColor('#5a7640', PAL.heliconia, 0.5) });
      for (let j = 0; j < 6; j++) {
        const side = j % 2 ? 1 : -1;
        const L = 0.2 - j * 0.012;
        parts.push({ geo: cardGeometry('broad', L, L * 0.45, 0.25, 1), m: mat(top.x + out.x * 0.02 * j, top.y - 0.1 - j * 0.11, top.z + out.z * 0.02 * j, side * 2.0, yaw + Math.PI / 2, 0), color: baseToTip(L, red, tipC) });
      }
    }
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
/**
 * Victoria amazonica (vitoria-regia): giant round lily pads with an upturned rim, green and ribbed above, wine-red on the rim's outer wall.
 */
export function createPads(variant: number): Mesh {
  const rng = makeRandom(1500 + variant);
  const parts: Part[] = [];
  const up = new Vector3(0, 1, 0);
  const top = new Color(PAL.leafMid).lerp(new Color(PAL.leafLight), 0.55);
  const rib = new Color(PAL.leafSun);
  const wine = new Color('#6e2f33');
  const pad = (cx: number, cz: number, r: number, tilt: number) => {
    const phase = rng() * 6.28;
    const disc = new CircleGeometry(r, 18).rotateX(-Math.PI / 2).rotateZ(tilt).translate(cx, 0.004, cz);
    parts.push({
      geo: solidUV(disc),
      normalFn: () => up.clone(),
      color: (p) => {
        const d = Math.hypot(p.x - cx, p.z - cz) / r;
        const a = Math.atan2(p.z - cz, p.x - cx);
        return top.clone().lerp(rib, 0.35 * Math.pow(Math.abs(Math.cos(a * 4.5 + phase)), 6) * d).multiplyScalar(0.82 + 0.18 * d);
      },
    });
    const rimH = 0.05 + r * 0.05;
    const rim = new CylinderGeometry(r * 1.03, r, rimH, 18, 1, true).translate(0, rimH / 2, 0).rotateZ(tilt).translate(cx, 0.004, cz);
    parts.push({ geo: solidUV(rim), color: (p) => wine.clone().lerp(top, Math.min(1, Math.max(0, p.y / rimH)) * 0.45) });
  };
  // One pad per placement (the pool holds nine, some touching). A slight tilt, turned by each placement's yaw, keeps touching pads from being
  // coplanar (no depth fighting where two overlap).
  pad(0, 0, 0.46, 0.014);
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


// ---------------------------------------------------------------------------
// Overlook Knoll meadow: wind-swept OPAQUE grass tufts and wildflowers
// ---------------------------------------------------------------------------
//
// Hand-built triangles (no cards, no alpha shapes): every vertex maps to the atlas' solid bark tile, so the shared plant material never discards a fragment
// here (zero alpha-test layers) and the draw call is the ground cells' one. Origins sit on the ground, +Y up, local +Z is the lean direction: the placement
// code yaws a tuft so that +Z points down the wind (MEADOW_WIND) and a flower so that +Z points at the sun, which is where its head faces.
// chunks.scene-asset merges these with `aSway` (weight 0 at the root .. 1 at the tip), so the stems bend in plantFoliageMaterial's wind and are pushed
// aside by the player's feet and hands, exactly like the other plants.

/** The bark tile is ~0.78 grey: colours are lifted by this much so the tuft reads as the colour written in the palette. */
const SOLID_GAIN = 1.28;
const [SU0, SV0, SU1, SV1] = tileUV('bark');
const SOLID_U = (SU0 + SU1) / 2;
const SOLID_V = (SV0 + SV1) / 2;

class RawMesh {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  private c = new Color();
  vert(x: number, y: number, z: number, n: readonly [number, number, number], c: Color, k = 1): number {
    this.c.copy(c).multiplyScalar(SOLID_GAIN * k);
    this.pos.push(x, y, z);
    this.nor.push(n[0], n[1], n[2]);
    this.col.push(this.c.r, this.c.g, this.c.b);
    this.uv.push(SOLID_U, SOLID_V);
    return this.pos.length / 3 - 1;
  }
  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }
  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new Float32BufferAttribute(this.uv, 2));
    // rigid for foliageCardMaterial's tree wind (the prototype is never drawn itself; the ground chunks that merge it sway through aSway instead)
    g.setAttribute('aWind', new Uint8BufferAttribute(new Uint8Array((this.pos.length / 3) * 4), 4, true));
    g.setIndex(this.idx);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

const unit = (x: number, y: number, z: number): [number, number, number] => {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};

/**
 * One grass blade (or flower leaf): base `(bx, -0.03, bz)`, leaning outward by `tilt` radians along azimuth `az` and down-wind (+Z) by `lean * len`.
 * `rich` = 3 triangles (base quad + tip), otherwise 1 triangle. Normals point mostly up (lit like the ground carpet), tinted from `lo` (root, shaded) to `hi` (sunlit tip).
 */
function addBlade(r: RawMesh, rng: () => number, bx: number, bz: number, az: number, len: number, w: number, tilt: number, lean: number, lo: Color, hi: Color, rich: boolean): void {
  const ox = Math.cos(az);
  const oz = Math.sin(az);
  const tx = bx + ox * Math.sin(tilt) * len * 0.9;
  const tz = bz + oz * Math.sin(tilt) * len * 0.9 + lean * len;
  const ty = Math.cos(tilt) * len;
  const phi = az + Math.PI / 2 + (rng() - 0.5) * 1.1;
  const sx = Math.cos(phi) * 0.5;
  const sz = Math.sin(phi) * 0.5;
  const n = unit(ox * 0.3, 0.9, oz * 0.3);
  const k = 0.92 + 0.16 * rng();
  if (rich) {
    const mx = bx + (tx - bx) * 0.42;
    const mz = bz + (tz - bz) * 0.34;
    const my = ty * 0.5;
    const mid = new Color().copy(lo).lerp(hi, 0.5);
    const a = r.vert(bx - sx * w, -0.03, bz - sz * w, n, lo, k);
    const b = r.vert(bx + sx * w, -0.03, bz + sz * w, n, lo, k);
    const c = r.vert(mx - sx * w * 0.72, my, mz - sz * w * 0.72, n, mid, k);
    const d = r.vert(mx + sx * w * 0.72, my, mz + sz * w * 0.72, n, mid, k);
    const t = r.vert(tx, ty, tz, n, hi, k);
    r.tri(a, b, c);
    r.tri(b, d, c);
    r.tri(c, d, t);
  } else {
    const a = r.vert(bx - sx * w * 1.15, -0.03, bz - sz * w * 1.15, n, lo, k);
    const b = r.vert(bx + sx * w * 1.15, -0.03, bz + sz * w * 1.15, n, lo, k);
    const t = r.vert(tx, ty, tz, n, hi, k);
    r.tri(a, b, t);
  }
}

/**
 * Wind-swept grass tuft, ~0.55-0.8 m tall at scale 1 (placed at 0.85-1.25). Variants: 0 fresh-green and 1 curing-gold NEAR tufts (5 blades x 3 triangles = 15),
 * 2 fresh-green and 3 curing-gold FAR tufts (7 single-triangle blades = 7), used beyond ~12 m where the shape no longer shows. The blades splay outward and
 * all lean down-wind (+Z), so a field of tufts all yawed to the wind flows in one direction.
 */
export function createMeadowTuft(variant: number): Mesh {
  const v = ((variant % 4) + 4) % 4;
  const gold = v % 2 === 1;
  const far = v >= 2;
  const rng = makeRandom(5200 + v * 13);
  const r = new RawMesh();
  const lo = new Color(MEADOW.base).lerp(new Color(gold ? MEADOW.gold : MEADOW.lush), gold ? 0.45 : 0.15);
  const hi = new Color(gold ? MEADOW.goldTip : MEADOW.lushTip);
  const n = far ? 7 : 5;
  for (let i = 0; i < n; i++) {
    const az = (i / n) * Math.PI * 2 + rng() * 0.9;
    const rad = 0.03 + 0.07 * rng();
    const len = (0.5 + 0.3 * rng()) * (i === 0 ? 1.15 : 1);
    const w = far ? 0.034 : 0.026 + 0.012 * rng();
    addBlade(r, rng, Math.cos(az) * rad, Math.sin(az) * rad, az, len, w, 0.1 + 0.36 * rng(), 0.14 + 0.2 * rng(), lo, gold ? hi.clone().lerp(new Color(MEADOW.straw), 0.3 * rng()) : hi, !far);
  }
  const m = new Mesh(r.geometry(), foliageCardMaterial);
  m.name = `MeadowTuft_${v}`;
  return m;
}

/** Flower colours per variant: [petal, eye]. The warm accent (PAL.accent) appears only in variant 3, as one flower of four. */
const BLOOM: { petals: string[]; eye: string }[] = [
  { petals: [MEADOW.bloomWhite, MEADOW.bloomWhite, MEADOW.bloomPink, MEADOW.bloomWhite], eye: MEADOW.bloomEye },
  { petals: [MEADOW.bloomBlue, MEADOW.bloomViolet, MEADOW.bloomBlue, MEADOW.bloomViolet], eye: MEADOW.bloomWhite },
  { petals: [MEADOW.bloomYellow, MEADOW.bloomYellow, MEADOW.bloomWhite, MEADOW.bloomYellow], eye: MEADOW.bloomEye },
  { petals: [PAL.accent, MEADOW.bloomWhite, MEADOW.bloomViolet, MEADOW.bloomWhite], eye: MEADOW.bloomEye },
];

/**
 * A clump of four wildflowers on 0.35-0.8 m stems (+ two leaves), opaque: a stem triangle and a six-triangle fan head each (7), 30 triangles in all.
 * Heads tilt toward +Z; the placement code points +Z at the sun, so the blooms face the sun and the player behind it. Variants: 0 white daisies with a
 * golden eye, 1 blue and violet, 2 pale yellow, 3 mixed with one amber flower (the warm accent, only here).
 */
export function createMeadowFlowers(variant: number): Mesh {
  const v = ((variant % 4) + 4) % 4;
  const rng = makeRandom(5300 + v * 17);
  const r = new RawMesh();
  const stemLo = new Color(MEADOW.base);
  const stemHi = new Color(MEADOW.stem);
  const eye = new Color(BLOOM[v].eye);
  const hn = unit(0, 0.5, 0.87);
  // head plane basis: u along X, w = hn x u
  const ux = 1;
  const wv = unit(0, hn[2], -hn[1]);
  for (let i = 0; i < 4; i++) {
    const a = i * 2.4 + rng() * 0.6;
    const rad = 0.05 + 0.15 * rng();
    const bx = Math.cos(a) * rad;
    const bz = Math.sin(a) * rad;
    const h = 0.35 + 0.45 * rng();
    const lean = 0.05 + 0.12 * rng();
    const hx = bx + (rng() - 0.5) * 0.1;
    const hz = bz + lean * h;
    const petal = new Color(BLOOM[v].petals[i]);
    // stem: one tapered triangle from the root to the head
    const sn = unit(0, 1, 0.3);
    const s0 = r.vert(bx - 0.009, -0.03, bz, sn, stemLo);
    const s1 = r.vert(bx + 0.009, -0.03, bz, sn, stemLo);
    const s2 = r.vert(hx, h, hz, sn, stemHi);
    r.tri(s0, s1, s2);
    // head: hexagon fan around the eye, tilted toward +Z; the ring is slightly larger on the sunward side of a lifted rim
    const R = 0.042 + 0.018 * rng();
    const c0 = r.vert(hx, h + 0.004, hz, hn, eye, 1.0);
    const ring: number[] = [];
    for (let k = 0; k < 6; k++) {
      const t = (k / 6) * Math.PI * 2 + 0.3 * i;
      const px = Math.cos(t) * R;
      const pw = Math.sin(t) * R;
      ring.push(r.vert(hx + ux * px + wv[0] * pw, h + wv[1] * pw, hz + wv[2] * pw, hn, petal, 0.96 + 0.08 * (k % 2)));
    }
    for (let k = 0; k < 6; k++) r.tri(c0, ring[k], ring[(k + 1) % 6]);
  }
  // two leaves at the root
  for (let i = 0; i < 2; i++) {
    const az = i * 3.1 + rng();
    addBlade(r, rng, Math.cos(az) * 0.05, Math.sin(az) * 0.05, az, 0.22 + 0.1 * rng(), 0.03, 0.5 + 0.3 * rng(), 0.1, stemLo, stemHi, false);
  }
  const m = new Mesh(r.geometry(), foliageCardMaterial);
  m.name = `MeadowFlowers_${v}`;
  return m;
}

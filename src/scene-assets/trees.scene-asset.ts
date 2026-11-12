/**
 * Trees: buttress trunks, branching limbs, hanging lianas and card-cluster
 * crowns. Every tree is ONE merged mesh using the shared foliage-card material
 * (wood parts map to the atlas' solid 'bark' tile; colour is vertex colour), so
 * the whole forest instances with a handful of draw calls.
 *
 * Families (kind -> variants): giant 3, tall 3, broad 2, slender 2, each in
 * 'hi' (near the trail) and 'lo' (distant wall) detail. Variants differ in
 * buttress count, lean, branching height and crown shape, not just size.
 */
import { BufferGeometry, CatmullRomCurve3, Color, Float32BufferAttribute, Matrix4, Mesh, Vector3 } from '@iwsdk/core';
import { ENTRANCE_LIMB, ENTRANCE_TREES, ROOT_ARCH, fbm, makeRandom, smoothstep, terrainHeight } from '../world/layout.js';
import { PAL } from '../world/palette.js';
import type { TreeKind } from '../world/placements.js';
import { blobCardGeometry, cardGeometry, lerpColor, mat, mergeParts, softNormals, solidUV, tubeAlong } from './lib/geo.js';
import type { ColorFn, Part, WindFn } from './lib/geo.js';
import { foliageCardMaterial } from './lib/materials.js';

export interface TreeSpec {
  seed: number;
  height: number; // m
  radius: number; // trunk radius above the buttresses (m)
  lobes: number; // buttress roots
  flare: number; // how far buttresses stretch (x trunk radius)
  branchStart: number; // fraction of height where limbs begin
  limbs: number;
  crown: number; // crown radius (m)
  lean: number; // m of lean at the top
  vines: number; // climbing lianas on the trunk
  hanging: number; // hanging lianas from limbs
  tone: number; // 0 = deep green .. 1 = yellower
  // --- Amazon species traits (all optional) ---
  /** Plank buttresses (kapok/samauma): thin tall fins instead of rounded lobes. */
  plank?: boolean;
  /** Buttress height factor (1 = fades by ~5 m). */
  buttH?: number;
  /** 0..1 pale, smooth grey bark (kapok, rubber tree, cecropia). */
  pale?: number;
  /** Ringed trunk (cecropia leaf scars). */
  ringed?: boolean;
  /** 0..1 flattened umbrella crown (emergents spread a wide, shallow parasol above the canopy). */
  flat?: number;
  /** Crown card tile ('clump' by default; 'palmate' = cecropia whorls). */
  crownTile?: 'clump' | 'palmate';
  /** Bromeliads on the trunk (near detail only), besides the one on each perch bough. */
  epiphytes?: number;
  /** Thick aerial roots dropping from the limbs to the ground (strangler fig). */
  aerial?: number;
}

/**
 * Real-world references (tropical lowland rainforest): emergent giants 50-75 m with 2-4 m trunks above the buttresses, the canopy layer 30-45 m,
 * sub-canopy 20-30 m. The authored specs below were a size too small (giants 34-42 m, canopy 24-30 m), which made the forest read as a grove.
 * Heights, trunk radius, crown and liana length are baked up by these factors; proportions (taper, branch height fraction, buttress flare) are kept.
 */
const GROWTH: Record<TreeKind, { h: number; r: number; c: number }> = {
  giant: { h: 1.6, r: 1.3, c: 1.3 },
  tall: { h: 1.32, r: 1.15, c: 1.2 },
  broad: { h: 1.3, r: 1.15, c: 1.2 },
  slender: { h: 1.28, r: 1.1, c: 1.15 },
};
const grown = (kind: TreeKind, specs: TreeSpec[]): TreeSpec[] => specs.map((sp) => ({ ...sp, height: sp.height * GROWTH[kind].h, radius: sp.radius * GROWTH[kind].r, crown: sp.crown * GROWTH[kind].c, lean: sp.lean * GROWTH[kind].h, hanging: sp.hanging }));

/**
 * AMAZON CAST (terra firme lowland forest). Footprints (radius, lobes, flare) are unchanged from the earlier generic jungle so placements,
 * colliders and wildlife anchors stay where they are; what changes is each tree's character:
 *   giant 0  samauma / kapok (Ceiba pentandra): plank buttresses taller than a person, pale smooth bole, a wide flat parasol crown
 *   giant 1  Brazil nut (Bertholletia excelsa): dark fissured column, bare for two thirds of its height, domed crown
 *   giant 2  strangler fig (Ficus): low spreading limbs, curtains of aerial roots and lianas, loaded with epiphytes
 *   tall     canopy layer: a liana-hung hardwood, a pale rubber tree (Hevea), a mossy epiphyte-laden hardwood
 *   broad    sub-canopy spreaders heavy with bromeliads and lianas
 *   slender  embauba (Cecropia): pale ringed pole, sparse candelabra of big palmate leaves; the pioneer of every gap
 */
const AUTHORED: Record<TreeKind, TreeSpec[]> = {
  giant: [
    { seed: 101, height: 38, radius: 1.55, lobes: 5, flare: 0.72, branchStart: 0.7, limbs: 7, crown: 9, lean: 0.9, vines: 3, hanging: 9, tone: 0.25, plank: true, buttH: 1.9, pale: 0.75, flat: 0.75, epiphytes: 2 },
    { seed: 202, height: 42, radius: 1.8, lobes: 6, flare: 0.8, branchStart: 0.68, limbs: 8, crown: 8.5, lean: -1.2, vines: 2, hanging: 8, tone: 0.4, flat: 0.25, epiphytes: 1 },
    { seed: 303, height: 34, radius: 1.4, lobes: 4, flare: 0.62, branchStart: 0.42, limbs: 7, crown: 9, lean: 0.4, vines: 5, hanging: 13, tone: 0.1, epiphytes: 4, aerial: 5 },
  ],
  tall: [
    { seed: 411, height: 27, radius: 0.85, lobes: 4, flare: 0.48, branchStart: 0.55, limbs: 5, crown: 5, lean: 0.6, vines: 3, hanging: 6, tone: 0.3, epiphytes: 2 },
    { seed: 422, height: 30, radius: 0.8, lobes: 5, flare: 0.42, branchStart: 0.66, limbs: 5, crown: 4.8, lean: -0.7, vines: 1, hanging: 3, tone: 0.15, pale: 0.5, flat: 0.3 },
    { seed: 433, height: 24, radius: 0.95, lobes: 3, flare: 0.5, branchStart: 0.5, limbs: 6, crown: 5.4, lean: 0.3, vines: 2, hanging: 7, tone: 0.5, epiphytes: 3 },
  ],
  broad: [
    { seed: 511, height: 19, radius: 1.0, lobes: 5, flare: 0.45, branchStart: 0.38, limbs: 6, crown: 6.8, lean: 0.4, vines: 3, hanging: 7, tone: 0.1, epiphytes: 3 },
    { seed: 522, height: 17, radius: 0.9, lobes: 4, flare: 0.4, branchStart: 0.34, limbs: 6, crown: 6.2, lean: -0.5, vines: 2, hanging: 6, tone: 0.4, epiphytes: 2 },
  ],
  slender: [
    { seed: 611, height: 22, radius: 0.5, lobes: 3, flare: 0.3, branchStart: 0.68, limbs: 4, crown: 3.8, lean: -0.8, vines: 0, hanging: 1, tone: 0.6, pale: 0.85, ringed: true, crownTile: 'palmate' },
    { seed: 622, height: 19, radius: 0.55, lobes: 3, flare: 0.28, branchStart: 0.64, limbs: 4, crown: 3.6, lean: 0.7, vines: 0, hanging: 1, tone: 0.45, pale: 0.8, ringed: true, crownTile: 'palmate' },
  ],
};

/** The species table the runtime uses (grown to real-world proportions, see GROWTH). */
export const TREE_SPECS: Record<TreeKind, TreeSpec[]> = { giant: grown('giant', AUTHORED.giant), tall: grown('tall', AUTHORED.tall), broad: grown('broad', AUTHORED.broad), slender: grown('slender', AUTHORED.slender) };


// ---------------------------------------------------------------------------
// Perch boughs: the branches wildlife sits on
// ---------------------------------------------------------------------------

/**
 * Two bare, near-horizontal boughs per tree kind (slender: two as well) at 3-10 m (the lowest, at 3-4 m, is where an animal can be seen at close range without craning the neck). They are defined per KIND with absolute metres,
 * measured from the trunk's axis, and are part of BOTH the detailed and the cheap tree version: the distant forest uses one cheap model per kind
 * (`tree-<kind>-<variant>-lo`); the animals look the bough up by KIND, so a bough that depended on the variant would move at the LOD switch and an animal sitting on it would float.
 * `ang` is the bough's direction (rad, tree-local), `len` its length from the axis, `rise` the lift of its tip as a fraction of `len`.
 */
export interface PerchBough {
  h: number;
  ang: number;
  len: number;
  rise: number;
  r0: number;
}
export const PERCH_BOUGHS: Record<TreeKind, PerchBough[]> = {
  giant: [
    { h: 4.2, ang: 5.2, len: 8.0, rise: 0.08, r0: 0.3 },
    { h: 9.5, ang: 0.6, len: 9.0, rise: 0.1, r0: 0.34 },
  ],
  tall: [
    { h: 3.8, ang: 3.3, len: 6.0, rise: 0.08, r0: 0.25 },
    { h: 8.0, ang: 1.9, len: 6.8, rise: 0.1, r0: 0.3 },
  ],
  broad: [
    { h: 3.4, ang: 5.4, len: 5.6, rise: 0.08, r0: 0.24 },
    { h: 7.0, ang: 0.4, len: 6.4, rise: 0.09, r0: 0.3 },
  ],
  slender: [
    { h: 3.2, ang: 0.2, len: 4.2, rise: 0.08, r0: 0.18 },
    { h: 6.5, ang: 2.2, len: 4.6, rise: 0.1, r0: 0.2 },
  ],
};

/** The bough's centreline control points (tree-local, metres): trunk axis -> tip. */
function boughPoints(b: PerchBough): Vector3[] {
  const dir = new Vector3(Math.cos(b.ang), 0, Math.sin(b.ang));
  const start = new Vector3(0, b.h, 0);
  const mid = start.clone().addScaledVector(dir, b.len * 0.5).add(new Vector3(0, b.len * b.rise * 0.7, 0));
  const end = start.clone().addScaledVector(dir, b.len).add(new Vector3(0, b.len * b.rise, 0));
  const q = start.clone().lerp(mid, 0.5).add(new Vector3(0, b.len * 0.04, 0));
  return [start, q, mid, end];
}
const boughRadius = (b: PerchBough) => (t: number) => b.r0 * (1 - 0.7 * t);

/** A place an animal can sit, in the tree's local frame (before the placement's yaw/scale): the top of the bough at fraction `t` of its length. */
export interface PerchLocal {
  x: number;
  y: number;
  z: number;
  /** Bough direction (unit, horizontal) and the branch radius there (m). */
  dx: number;
  dz: number;
  r: number;
  /** 0..1 along the bough (1 = tip). */
  t: number;
  bough: number;
}
const perchCache = new Map<TreeKind, PerchLocal[]>();
export function treePerches(kind: TreeKind): PerchLocal[] {
  let out = perchCache.get(kind);
  if (out) return out;
  out = [];
  PERCH_BOUGHS[kind].forEach((b, bi) => {
    const curve = new CatmullRomCurve3(boughPoints(b), false, 'catmullrom', 0.5);
    const rad = boughRadius(b);
    const p = new Vector3();
    for (const t of [0.52, 0.68, 0.84, 0.97]) {
      curve.getPointAt(t, p);
      const tan = curve.getTangentAt(t);
      const h = Math.hypot(tan.x, tan.z) || 1;
      // the tube is a 4-5 sided prism: its top face sits a little below the ideal circle, so the perch is 14 % of the radius lower than the circle's top (the cheap versions use 4 sides, which sag the most)
      out!.push({ x: p.x, y: p.y + rad(t) * 0.86, z: p.z, dx: tan.x / h, dz: tan.z / h, r: rad(t), t, bough: bi });
    }
  });
  perchCache.set(kind, out);
  return out;
}

export type TreeLod = 'hi' | 'lo';

/** Crown cards are trimmed to the clump's alpha silhouette (see blobCardGeometry): fewer wasted fragments. */
const crownCard = (size: number, tile: 'clump' | 'palmate' = 'clump') => blobCardGeometry(tile, size);

// ---------------------------------------------------------------------------
// Wind weights (see WindWeights in lib/geo.ts and foliageCardMaterial)
// ---------------------------------------------------------------------------

/**
 * Whole-tree bend weight at tree-local height `y` (m above the foot) for a tree of height `h`: (y/h)^2 * (h/60), clamped to 0..1.
 * The shader leans the tree downwind by up to 0.36 m x weight: ~0.3 m at the top of a 50 m crown, a few mm at the perch boughs.
 * A pure function of the position inside the tree: the detailed and cheap versions of a species move their shared points identically.
 */
export function windBend(y: number, h: number): number {
  const t = Math.min(1, Math.max(0, y / h));
  return Math.min(1, t * t * (h / 60));
}
/** Wood: follows the bend, never flutters. */
const woodWind = (h: number, base = 0): WindFn => (p) => ({ bend: windBend(p.y - base, h) });
/** Leaf cards: bend plus full flutter (flutter > 0.5 also marks the vertex as LEAF for the chunk colour field). */
const leafWind = (h: number, base = 0, flutter = 1): WindFn => (p) => ({ bend: windBend(p.y - base, h), flutter });
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/**
 * A hanging liana: bends with the limb it hangs from (bend of the attachment height) and swings as a pendulum, weight 0 at the attachment .. 1
 * at the free end, scaled down for short ones so the swing angle stays similar. `leaf` = the trailing leaf card (flutters too).
 */
const lianaWind = (attachY: number, drop: number, h: number, base = 0, leaf = false): WindFn => {
  const bend = windBend(attachY - base, h);
  const fac = Math.min(1, Math.max(0.35, drop / 8));
  return (p) => ({ bend, flutter: leaf ? 0.8 : 0, vine: clamp01((attachY - p.y) / drop) * fac });
};

const BARK = {
  dark: new Color(PAL.barkDark),
  mid: new Color(PAL.bark),
  light: new Color(PAL.barkLight),
  moss: new Color(PAL.moss),
};

/**
 * Trunk radius at height y and angle theta: a tapering bole, rounded buttress
 * lobes that fade out by ~5 m, and bark ridges (deep vertical grooves with a
 * little drift). `barkGroove` is shared with the colour function so grooves are dark.
 */
export function barkGroove(spec: TreeSpec, theta: number, y: number): number {
  // 0 = bottom of a groove, 1 = top of a ridge
  const a = Math.sin(theta * 23 + y * 0.25 + spec.seed) * 0.5 + 0.5;
  const b = Math.sin(theta * 41 - y * 0.6 + spec.seed * 1.7) * 0.5 + 0.5;
  return a * 0.65 + b * 0.35;
}

/** Buttress strength at height y (1 at the ground): fades by ~5 m, later for species with tall buttresses (`buttH`). */
function flareFallAt(spec: TreeSpec, y: number): number {
  return Math.exp(-Math.max(0, y) / ((1.4 + spec.height * 0.045) * (spec.buttH ?? 1)));
}

function trunkRadiusAt(spec: TreeSpec, y: number, theta: number): number {
  const t = Math.min(1, Math.max(0, y / spec.height));
  let r = spec.radius * (1.12 - 0.45 * t);
  // Plank buttresses are thin fins (a sharp lobe profile); the crest reaches as far as a rounded lobe would, so the footprint is the same.
  const lobe = Math.pow(Math.max(0, Math.cos(spec.lobes * theta + spec.seed)), spec.plank ? 12 : 1.4);
  const flareFall = flareFallAt(spec, y);
  r *= 1 + (spec.flare * lobe + (spec.plank ? 0.1 : 0.25)) * flareFall;
  r *= 1 + 0.055 * (barkGroove(spec, theta, y) - 0.5) * 2;
  return r;
}

/** Trunk axis (tree-local x, z) and an angle-averaged radius at height `y` for a tree variant: where a climbing animal grips the trunk. */
export function trunkAxisAt(kind: TreeKind, variant: number, y: number): { x: number; z: number; r: number } {
  const spec = TREE_SPECS[kind][variant % TREE_SPECS[kind].length];
  const c = trunkCenter(spec, y, new Vector3());
  const t = Math.min(1, Math.max(0, y / spec.height));
  const r = spec.radius * (1.12 - 0.45 * t) * (1 + (spec.plank ? spec.flare * 0.08 + 0.1 : spec.flare * 0.3 + 0.25) * flareFallAt(spec, y));
  return { x: c.x, z: c.z, r };
}

/** Largest ground-level radius of a tree (m): the real footprint, used for colliders and spacing. */
export function treeFootprint(kind: TreeKind, variant: number): number {
  const spec = TREE_SPECS[kind][variant % TREE_SPECS[kind].length];
  let m = 0;
  for (let i = 0; i < 90; i++) m = Math.max(m, trunkRadiusAt(spec, 0, (i / 90) * Math.PI * 2));
  return m;
}

function trunkCenter(spec: TreeSpec, y: number, out: Vector3): Vector3 {
  const t = y / spec.height;
  return out.set(spec.lean * t * t + 0.3 * Math.sin(y * 0.21 + spec.seed), y, -spec.lean * 0.4 * t * t + 0.25 * Math.cos(y * 0.17));
}

function trunkGeometry(spec: TreeSpec, lod: TreeLod): BufferGeometry {
  const rings: number[] = [];
  if (lod === 'hi') {
    for (let y = -0.7; y < spec.height; y += y < 4.5 ? 0.6 : y < 14 ? 2.4 : 4.5) rings.push(y);
    rings.push(spec.height);
  } else rings.push(-0.7, 0.9, 2.8, 6.5, spec.height * 0.5, spec.height * 0.78, spec.height);
  // Ring angles. Rounded trunks: evenly spaced. Plank buttresses: vertices ON each fin (crest, two tight shoulders) and in the trough between
  // fins, so a fin is a real thin plane and not an aliased bump (cheap version: crest and trough only).
  const angles: number[] = [];
  if (spec.plank) {
    const period = (Math.PI * 2) / spec.lobes;
    for (let l = 0; l < spec.lobes; l++) {
      const crest = l * period - spec.seed / spec.lobes;
      if (lod === 'hi') angles.push(crest - period * 0.5, crest - period * 0.2, crest - period * 0.045, crest, crest + period * 0.045, crest + period * 0.2);
      else angles.push(crest - period * 0.5, crest - period * 0.07, crest, crest + period * 0.07);
    }
  } else {
    const n = lod === 'hi' ? 18 : 9;
    for (let j = 0; j < n; j++) angles.push((j / n) * Math.PI * 2);
  }
  const radial = angles.length;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const c = new Vector3();
  rings.forEach((y, i) => {
    trunkCenter(spec, y, c);
    for (let j = 0; j < radial; j++) {
      const th = angles[j];
      const r = trunkRadiusAt(spec, Math.max(0, y), th);
      positions.push(c.x + Math.cos(th) * r, y, c.z + Math.sin(th) * r);
      uvs.push(j / radial, i * 0.25);
    }
  });
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j;
      const b = i * radial + ((j + 1) % radial);
      const d = (i + 1) * radial + j;
      const e = (i + 1) * radial + ((j + 1) % radial);
      indices.push(a, b, d, b, e, d);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return solidUV(g);
}

/** Bark colour: ridged bark, moss climbing from the ground on shaded/upward faces, AO at the root flare. */
const PALE_BARK = new Color('#a39c8a');
const PALE_LICHEN = new Color('#8fa184');

function barkColor(spec: TreeSpec): ColorFn {
  const out = new Color();
  const pale = new Color();
  return (p, n) => {
    // Grooves (shared with the geometry) are dark, ridge crests catch light; noise breaks it up.
    const th = Math.atan2(p.z, p.x);
    const groove = barkGroove(spec, th, Math.max(0, p.y));
    const ridge = fbm(p.x * 1.6 + p.z * 0.5, p.y * 0.5, spec.seed, 3);
    out.copy(BARK.dark).lerp(BARK.mid, smoothstep(0.2, 0.75, groove * 0.7 + ridge * 0.4)).lerp(BARK.light, smoothstep(0.72, 1.0, groove) * smoothstep(0.35, 0.8, ridge) * 0.55);
    const mossAmt =
      smoothstep(0.42, 0.64, fbm(p.x * 0.8, p.y * 0.35 + p.z * 0.8, spec.seed + 5, 3)) * (1 - smoothstep(1.5, 10, p.y)) * 0.85 +
      smoothstep(0.35, 0.8, n.y) * 0.5;
    out.lerp(BARK.moss, Math.min(1, mossAmt));
    if (spec.pale) {
      // Smooth pale bole (kapok, rubber tree, embauba): grey-buff with faint lichen blotches; moss still creeps up the base.
      const blotch = fbm(p.x * 0.9 + 3, p.y * 0.6 + p.z * 0.9, spec.seed + 9, 2);
      pale.copy(PALE_BARK).lerp(PALE_LICHEN, smoothstep(0.5, 0.75, blotch) * 0.6).multiplyScalar(0.8 + 0.2 * groove);
      // Cecropia: dark leaf-scar rings every ~0.9 m.
      if (spec.ringed) pale.multiplyScalar(1 - 0.38 * smoothstep(0.86, 0.97, Math.abs(Math.sin(p.y * 3.5))));
      out.lerp(pale, spec.pale * (1 - Math.min(1, mossAmt) * 0.7));
    }
    out.multiplyScalar(0.5 + 0.5 * smoothstep(-0.4, 1.2, p.y));
    out.multiplyScalar(1 - 0.28 * smoothstep(12, 32, p.y));
    return out;
  };
}

/** Crown leaf colour: sunlit tops (yellow-green) over cool shaded undersides. */
function crownColor(tone: number, seed: number): (p: Vector3, up: number) => Color {
  const sun = new Color(PAL.leafSun);
  const light = new Color(PAL.leafLight);
  const mid = new Color(PAL.leafMid);
  const shade = new Color(PAL.leafShade);
  const dry = new Color(PAL.leafDry);
  const out = new Color();
  return (p, up) => {
    const k = fbm(p.x * 0.3 + seed, p.z * 0.3 + p.y * 0.15, seed, 2);
    out.copy(shade).lerp(mid, smoothstep(0.2, 0.7, k));
    out.lerp(light, smoothstep(0.1, 0.9, up) * 0.6).lerp(sun, smoothstep(0.55, 1, up) * (0.25 + 0.4 * k));
    out.lerp(dry, tone * 0.22 * smoothstep(0.55, 0.9, k));
    return out;
  };
}

/** A limb as a tapering tube; returns its end/mid for sub-branches and crowns. */
function limb(parts: Part[] | null, start: Vector3, dir: Vector3, len: number, r0: number, rise: number, color: ColorFn, radial: number, segs: number, wind?: WindFn): { end: Vector3; mid: Vector3; at: (t: number) => Vector3 } {
  const mid = start.clone().addScaledVector(dir, len * 0.5).add(new Vector3(0, len * rise * 0.7, 0));
  const end = start.clone().addScaledVector(dir, len).add(new Vector3(0, len * rise, 0));
  const q = start.clone().lerp(mid, 0.5).add(new Vector3(0, len * 0.04, 0));
  const pts = [start, q, mid, end];
  if (parts) parts.push({ geo: solidUV(tubeAlong(pts, (t) => r0 * (1 - 0.82 * t), radial, segs)), color, wind });
  return { end, mid, at: (t) => (t < 0.5 ? start.clone().lerp(mid, t * 2) : mid.clone().lerp(end, (t - 0.5) * 2)) };
}

/**
 * A tank bromeliad: a rosette of arching strap leaves around a red heart. Amazon limbs and trunks carry them by the dozen.
 * `m` places the rosette base (its +y is the growing axis). ~36 triangles.
 */
function bromeliad(parts: Part[], m: Matrix4, size: number, rng: () => number): void {
  const n = 7;
  const green = lerpColor(PAL.leafMid, PAL.leafLight, 0.3 + 0.5 * rng());
  const heart = new Color(PAL.heliconia);
  const y0 = rng() * 6.28;
  for (let i = 0; i < n; i++) {
    const tilt = 0.75 + 0.35 * rng();
    parts.push({ geo: cardGeometry('broad', size * (0.85 + 0.3 * rng()), size * 0.2, 0.55, 2), m: m.clone().multiply(mat(0, 0, 0, tilt, y0 + (i / n) * 6.28, 0)), color: green, wind: { flutter: 0.25 } });
  }
  for (let i = 0; i < 3; i++) {
    parts.push({ geo: cardGeometry('broad', size * 0.42, size * 0.14, 0.2, 1), m: m.clone().multiply(mat(0, 0, 0, 0.3, y0 + 1 + (i / 3) * 6.28, 0)), color: heart });
  }
}

/** Size factor of the cheap version's single leaf card per limb (it stands in for the detailed version's three cards plus the sub-limb masses). */
const LO_CARD = 1.45;

export function createTree(kind: TreeKind, variant: number, lod: TreeLod = 'hi'): Mesh {
  const spec = TREE_SPECS[kind][variant % TREE_SPECS[kind].length];
  // ONE random stream for both detail levels: the cheap version makes exactly the same draws and only skips building the detail, so the tree keeps
  // its limbs, lean and crown masses where they are when the level of detail switches at 30 m (a different seed here made every tree re-grow there).
  const rng = makeRandom(spec.seed);
  const hi = lod === 'hi';
  const wood = woodWind(spec.height);
  const leafy = leafWind(spec.height);
  const parts: Part[] = [{ geo: trunkGeometry(spec, lod), color: barkColor(spec), wind: wood }];
  const bark = barkColor(spec);

  const c = new Vector3();
  const surface = (y: number, th: number, push = 1): Vector3 => {
    trunkCenter(spec, y, c);
    const r = trunkRadiusAt(spec, y, th) * push;
    return new Vector3(c.x + Math.cos(th) * r, y, c.z + Math.sin(th) * r);
  };

  // Climbing lianas hugging the trunk (hi only).
  for (let i = 0; i < spec.vines; i++) {
    const th0 = rng() * Math.PI * 2;
    const turns = 0.5 + rng() * 0.9;
    const top = spec.height * (0.5 + rng() * 0.25);
    const rad = 0.045 + rng() * 0.035;
    const tone = rng();
    if (!hi) continue;
    const pts: Vector3[] = [];
    for (let k = 0; k <= 8; k++) {
      const t = k / 8;
      pts.push(surface(t * top, th0 + t * turns * Math.PI * 2, 1.04));
    }
    parts.push({ geo: solidUV(tubeAlong(pts, (t) => rad * (1.2 - 0.5 * t), 4, 10)), color: lerpColor('#2c4520', '#4a5a2a', tone), wind: wood });
  }

  // Bromeliads lodged on the trunk, above head height (near detail only).
  if (lod === 'hi') {
    const erng = makeRandom(spec.seed + 91);
    for (let i = 0; i < (spec.epiphytes ?? 0); i++) {
      const th = erng() * Math.PI * 2;
      const y = 2.6 + erng() * Math.min(9, spec.height * 0.3);
      const at = surface(y, th, 1.02);
      // lean out from the bark: growing axis tilted ~35 degrees away from the trunk
      bromeliad(parts, mat(at.x, at.y, at.z, 0, -th + Math.PI / 2, 0).multiply(mat(0, 0, 0, 0.6, 0, 0)), 0.75 + 0.35 * erng(), erng);
    }
  }

  // Limbs -> sub-limbs -> crown clusters.
  const flatK = spec.flat ?? 0;
  const tile = spec.crownTile ?? 'clump';
  const arng = makeRandom(spec.seed + 57);
  let aerialLeft = spec.aerial ?? 0;
  const crowns: { p: Vector3; r: number; emit: boolean }[] = [];
  // The cheap version draws a spread-out subset of the SAME limbs (about 55 %), never limbs of its own.
  const nLo = Math.min(spec.limbs, Math.max(3, Math.round(spec.limbs * 0.55)));
  for (let i = 0; i < spec.limbs; i++) {
    const aerial = aerialLeft > 0 && i % 2 === 0;
    // a limb that carries an aerial root is always drawn: the root must not hang from nothing
    const keep = hi || aerial || Math.floor(((i + 1) * nLo) / spec.limbs) > Math.floor((i * nLo) / spec.limbs);
    const th = (i / spec.limbs) * Math.PI * 2 + rng() * 0.6;
    const h = spec.height * (spec.branchStart + (0.93 - spec.branchStart) * rng() * (1 - 0.45 * flatK));
    const start = surface(h, th, 0.72);
    const len = spec.crown * (0.7 + 0.55 * rng()) * (0.65 + 0.5 * (h / spec.height)) * (1 + 0.25 * flatK);
    const dir = new Vector3(Math.cos(th), 0, Math.sin(th));
    const r0 = Math.max(0.1, trunkRadiusAt(spec, h, th) * 0.32);
    const L = limb(keep ? parts : null, start, dir, len, r0, 0.1 + 0.2 * rng(), bark, 4, hi ? 5 : 3, wood);
    crowns.push({ p: L.end, r: spec.crown * 0.55, emit: keep });
    // Sub-limbs fork off the outer half (near detail; the cheap version keeps their leaf masses, see the crown loop).
    for (let k = 0; k < 2; k++) {
      const t = 0.5 + 0.35 * rng();
      const st = L.at(t);
      const ang = th + (k ? 0.75 : -0.75) * (0.7 + 0.5 * rng());
      const sd = new Vector3(Math.cos(ang), 0, Math.sin(ang));
      const S = limb(hi ? parts : null, st, sd, len * (0.38 + 0.2 * rng()), r0 * 0.45, 0.12 + 0.2 * rng(), bark, 4, 4, wood);
      crowns.push({ p: S.end, r: spec.crown * 0.4, emit: hi });
    }
    // Hanging lianas from the limb underside (near detail).
    const nh = Math.round(spec.hanging / spec.limbs + rng());
    for (let k = 0; k < nh; k++) {
      const at = L.at(0.25 + 0.7 * rng());
      const drop = 3 + rng() * (spec.height * 0.2);
      const sway = (rng() - 0.5) * 0.9;
      const tone = rng();
      const leafLen = 1.1 + rng() * 0.7;
      const leafYaw = rng() * 6.28;
      const leafTone = rng();
      if (!hi) continue;
      const pts = [at.clone(), at.clone().add(new Vector3(sway * 0.3, -drop * 0.35, sway * 0.2)), at.clone().add(new Vector3(sway, -drop * 0.7, -sway * 0.4)), at.clone().add(new Vector3(sway * 0.6, -drop, sway * 0.2))];
      const swing = lianaWind(at.y, drop, spec.height);
      parts.push({ geo: solidUV(tubeAlong(pts, (t) => 0.035 * (1 - 0.5 * t), 3, 5)), color: lerpColor('#27401c', '#3e5524', tone), wind: swing });
      // A trailing leaf card or two near the bottom.
      const lc = pts[3];
      const vc = cardGeometry('vine', leafLen, 0.55, 0.2, 2);
      parts.push({ geo: vc, m: mat(lc.x, lc.y - 1.0, lc.z, 0, leafYaw, 0), color: lerpColor(PAL.leafMid, PAL.leafLight, leafTone), wind: lianaWind(at.y, drop, spec.height, 0, true) });
    }
    // Strangler fig: a thick aerial root drops from the limb to the ground and thickens into a prop (both detail levels: it is silhouette).
    if (aerial) {
      aerialLeft--;
      const top = L.at(0.35 + 0.3 * arng());
      const foot = new Vector3(top.x + (arng() - 0.5) * 1.2, -0.3, top.z + (arng() - 0.5) * 1.2);
      const belly = top.clone().lerp(foot, 0.5).add(new Vector3((arng() - 0.5) * 0.6, 0, (arng() - 0.5) * 0.6));
      const rr = 0.07 + 0.06 * arng();
      parts.push({ geo: solidUV(tubeAlong([top, belly, foot], (t) => rr * (0.8 + 0.9 * t * t), 4, hi ? 6 : 3)), color: bark });
    }
  }
  // Perch boughs (see PERCH_BOUGHS): identical in both detail levels.
  // A leafy tuft beyond each bough's tip so the boughs do not read as bare sticks.
  const boughLeaf = crownColor(spec.tone, spec.seed + 5);
  for (const bh of PERCH_BOUGHS[kind]) {
    const pts = boughPoints(bh);
    // rigid on purpose (no `wind`): animals sit on these
    parts.push({ geo: solidUV(tubeAlong(pts, boughRadius(bh), 4, lod === 'hi' ? 4 : 3)), color: bark });
    // Tufts never cover the perching spots (t 0.5-0.97 along the top of the bough): one starts just beyond the tip.
    const tuft = (at: Vector3, size: number, yaw: number, tilt: number) => {
      const m = mat(at.x, at.y, at.z, -Math.PI / 2 + tilt, yaw, 0).multiply(mat(0, -size / 2, 0));
      parts.push({ geo: crownCard(size), m, normalFn: softNormals(new Vector3(0, bh.h - 2.5, 0), 0.5), color: (p) => boughLeaf(p, 0.55).multiplyScalar(0.92), wind: { flutter: 0.8 } });
    };
    if (lod === 'hi' && (spec.epiphytes ?? 0) > 0) {
      // a bromeliad on the bough's inner third (t ~0.28-0.33): well short of the perching spots
      const brng = makeRandom(spec.seed + Math.round(bh.h * 10));
      const a = pts[1].clone().lerp(pts[2], 0.1 + 0.2 * brng());
      bromeliad(parts, mat(a.x, a.y + boughRadius(bh)(0.3) * 0.8, a.z, 0, brng() * 6.28, 0), 0.8 + 0.3 * brng(), brng);
    }
    const dirv = new Vector3(Math.cos(bh.ang), 0, Math.sin(bh.ang));
    const sz = 1.9 + bh.len * 0.08;
    tuft(pts[3].clone().addScaledVector(dirv, sz * 0.55).add(new Vector3(0, -0.1, 0)), sz, bh.ang * 3, 0.08);
  }
  // The leading shoot crowns the trunk.
  trunkCenter(spec, spec.height * 0.97, c);
  crowns.push({ p: c.clone(), r: spec.crown * 0.6, emit: true });

  // Crowns: clusters of cutout leaf-clump cards at varied angles (rounded-mass lighting from soft normals).
  const color = crownColor(spec.tone, spec.seed);
  const centre = crowns.reduce((a, k) => a.add(k.p), new Vector3()).multiplyScalar(1 / crowns.length);
  for (const cr of crowns) {
    for (let k = 0; k < 3; k++) {
      // same draws in both detail levels; the cheap version keeps the first (flat) card of each drawn limb, enlarged to stand in for the three
      const size = cr.r * (1.5 + 0.9 * rng()) * (hi ? 1 : LO_CARD);
      // Orientation mix: tilted flat-ish masses read as canopy layers; vertical ones fill the sides.
      const flat = k % 2 === 0 || (flatK > 0 && rng() < flatK);
      const rx = flat ? -Math.PI / 2 + (rng() - 0.5) * 0.5 : (rng() - 0.5) * 0.5;
      const ry = rng() * Math.PI * 2;
      const off = new Vector3((rng() - 0.5) * cr.r, (rng() - 0.35) * cr.r * 0.5 * (1 - 0.7 * flatK), (rng() - 0.5) * cr.r);
      const px = cr.p.x + off.x;
      const py = cr.p.y + off.y;
      const pz = cr.p.z + off.z;
      // card base sits at its bottom edge: shift by half the size so the card is centred on the cluster point
      const m = mat(px, py, pz, rx, ry, 0).multiply(mat(0, -size / 2, 0));
      const up = Math.max(0, Math.min(1, (py - (centre.y - spec.crown * 0.5)) / (spec.crown * 1.2)));
      const jitter = 0.85 + 0.3 * rng();
      if (!(hi || (cr.emit && k === 0))) continue;
      const card = crownCard(size, tile);
      parts.push({
        geo: card,
        m,
        normalFn: softNormals(centre.clone().add(new Vector3(0, -spec.crown * 0.6, 0)), 0.5),
        color: (p) => color(p, up).multiplyScalar(jitter),
        wind: leafy,
      });
    }
  }

  const mesh = new Mesh(mergeParts(parts), foliageCardMaterial);
  mesh.name = `Tree_${kind}${variant}_${lod}`;
  return mesh;
}

// ---------------------------------------------------------------------------
// Entrance limb: the overhead bridge that makes the gate
// ---------------------------------------------------------------------------

/**
 * Centreline of the overhead limb that bridges the two gate trees, and its radius by arc fraction (world coordinates).
 * The gate trees are 60+ m giants with 4 m trunks: the limb springs from them at 17-19 m (a cathedral roof over the trail, not a low beam).
 * Shared by the mesh and by the wildlife perches.
 */
export function entranceLimbCurve(): { pts: Vector3[]; radius: (t: number) => number } {
  const [a, b] = ENTRANCE_TREES;
  const ya = terrainHeight(a[0], a[1]);
  const yb = terrainHeight(b[0], b[1]);
  const pa = new Vector3(a[0] + 0.5, ya + ENTRANCE_LIMB.liftA, a[1]);
  const pb = new Vector3(b[0] - 0.6, yb + ENTRANCE_LIMB.liftB, b[1]);
  const mid = pa.clone().lerp(pb, 0.5).add(new Vector3(0.3, 1.9, 0.9));
  const q1 = pa.clone().lerp(mid, 0.5).add(new Vector3(0, 0.5, -0.3));
  const q3 = mid.clone().lerp(pb, 0.5).add(new Vector3(0, 0.4, 0.4));
  return { pts: [pa, q1, mid, q3, pb], radius: (t) => 0.62 - 0.2 * Math.sin(Math.PI * t) + 0.04 * Math.sin(t * 40) };
}

/**
 * One thick limb that bridges the two colossal gate trees overhead, loaded
 * with moss, crown clusters and a fringe of lianas. Built in WORLD coordinates
 * (the node sits at the origin) so it joins the trunks exactly.
 */
export function createEntranceCanopy(): Mesh {
  const rng = makeRandom(777);
  const [a, b] = ENTRANCE_TREES;
  const ya = terrainHeight(a[0], a[1]);
  const yb = terrainHeight(b[0], b[1]);
  const parts: Part[] = [];
  const { pts: limbPts, radius: limbRadius } = entranceLimbCurve();
  const [pa, q1, mid, q3, pb] = limbPts;
  const limbColor = barkColor({ ...TREE_SPECS.giant[0], seed: 31 });
  // Wind: the limb and its crowns follow the same bend as the two gate giants it springs from (weights relative to the ground between them,
  // for a ~62 m tree), so the joins stay closed; the lianas swing from their attachment points.
  const GATE_H = 62;
  const baseY = (ya + yb) / 2;
  const wood = woodWind(GATE_H, baseY);
  const leafy = leafWind(GATE_H, baseY);
  parts.push({ geo: solidUV(tubeAlong(limbPts, limbRadius, 8, 22)), color: limbColor, wind: wood });
  const l0 = new Vector3(a[0] + 1.3, ya + 13.2 + ENTRANCE_LIMB.lowerLift, a[1] + 0.9);
  const l1 = pa.clone().lerp(pb, 0.45).add(new Vector3(0, 4.2, 1.6));
  const l2 = new Vector3(b[0] - 1.4, yb + 13.8 + ENTRANCE_LIMB.lowerLift, b[1] + 0.9);
  parts.push({ geo: solidUV(tubeAlong([l0, l1, l2], (t) => 0.1 + 0.05 * Math.sin(Math.PI * t), 5, 14)), color: lerpColor('#2f4a22', '#475a2d', 0.4), wind: wood });

  const color = crownColor(0.2, 900);
  const centre = pa.clone().lerp(pb, 0.5).add(new Vector3(0, 2, 0));
  for (let i = 0; i < 12; i++) {
    const t = 0.06 + 0.88 * (i / 11);
    const p = pa.clone().lerp(pb, t);
    // the middle of the span is the window onto the waterfall from the knoll: leaf clusters only toward the two trunks (the portal's frame)
    if (Math.abs(p.x - 0.4) < 6.5) continue;
    p.y = pa.y + (pb.y - pa.y) * t + 2.2 * Math.sin(Math.PI * t) + 0.7;
    p.z += (rng() - 0.5) * 1.6;
    const size = 3.0 + rng() * 2.0;
    const flat = i % 2 === 0;
    const m = mat(p.x, p.y, p.z, flat ? -Math.PI / 2 + (rng() - 0.5) * 0.4 : (rng() - 0.5) * 0.4, rng() * 6.28, 0).multiply(mat(0, -size / 2, 0));
    const up = flat ? 0.8 : 0.45;
    const jitter = 0.85 + 0.3 * rng();
    parts.push({ geo: crownCard(size), m, normalFn: softNormals(centre, 0.5), color: (q) => color(q, up).multiplyScalar(jitter), wind: leafy });
  }
  for (let i = 0; i < 24; i++) {
    const t = 0.1 + 0.8 * rng();
    const at = pa.clone().lerp(pb, t);
    at.y = pa.y + (pb.y - pa.y) * t + 1.9 * Math.sin(Math.PI * t) - 0.1;
    at.z += (rng() - 0.5) * 0.7;
    let drop = 4 + rng() * 9;
    // the middle of the span is the window onto the waterfall from the knoll: short lianas there, full-length curtains at the portal's edges
    if (Math.abs(at.x - 0.4) < 7) drop = Math.min(drop, 3);
    const sway = (rng() - 0.5) * 0.8;
    const pts = [at.clone(), at.clone().add(new Vector3(sway * 0.3, -drop * 0.3, 0)), at.clone().add(new Vector3(sway, -drop * 0.7, (rng() - 0.5) * 0.3)), at.clone().add(new Vector3(sway * 0.8, -drop, 0))];
    const rad = 0.025 + rng() * 0.03;
    const swing = lianaWind(at.y, drop, GATE_H, baseY);
    parts.push({ geo: solidUV(tubeAlong(pts, (u) => rad * (1 - 0.4 * u), 3, 8)), color: lerpColor('#243a19', '#46622a', rng()), wind: swing });
    if (rng() > 0.35) {
      parts.push({ geo: cardGeometry('vine', 1.4 + rng() * 1.2, 0.7, 0.15, 2), m: mat(pts[3].x, pts[3].y - 1.3, pts[3].z, 0, rng() * 6.28, 0), color: lerpColor(PAL.leafMid, PAL.leafLight, rng()), wind: lianaWind(at.y, drop, GATE_H, baseY, true) });
    }
  }
  const mesh = new Mesh(mergeParts(parts), foliageCardMaterial);
  mesh.name = 'EntranceCanopy';
  return mesh;
}

// ---------------------------------------------------------------------------
// Landmark: root bridge over the trail
// ---------------------------------------------------------------------------

/**
 * A giant root that leaves its trunk, arches 2.7 m over the trail and plunges
 * back into the soil on the far side, with finer roots and moss. Origin on the
 * ground at the trail centre; the trunk it grows from stands at local +X 3.4 m.
 */
export function createRootArch(): Mesh {
  const rng = makeRandom(2024);
  const parts: Part[] = [];
  const col: ColorFn = barkColor({ ...TREE_SPECS.giant[1], seed: 88 });
  const trunk = new Vector3(4.8, 0, 0);
  const main = [new Vector3(trunk.x - 1.1, 0.35, 0.3), new Vector3(3.3, 1.2, 0.1), new Vector3(1.6, 2.4, 0), new Vector3(-0.2, 2.75, -0.1), new Vector3(-1.7, 2.0, 0), new Vector3(-2.4, 0.7, 0.1), new Vector3(-2.7, -0.35, 0.15)];
  parts.push({ geo: solidUV(tubeAlong(main, (t) => 0.62 - 0.3 * t + 0.06 * Math.sin(t * 20), 8, 28)), color: col });
  // Secondary roots wrapping the main one and creeping across the ground.
  for (let i = 0; i < 5; i++) {
    const side = i % 2 ? 1 : -1;
    const z0 = (rng() - 0.5) * 1.6;
    const pts = [new Vector3(trunk.x - 1.0, 0.3, z0 * 0.4), new Vector3(3.9 - i * 0.2, 0.55 + 0.5 * rng(), z0), new Vector3(2.6 - i * 0.55, 0.28 + 0.3 * rng(), z0 + side * 0.9), new Vector3(1.6 - i * 0.7, -0.2, z0 + side * 1.6)];
    parts.push({ geo: solidUV(tubeAlong(pts, (t) => 0.28 * (1 - 0.8 * t), 6, 10)), color: col });
  }
  // Moss caps and a pair of lianas.
  for (let i = 0; i < 3; i++) {
    const t = 0.35 + 0.1 * i;
    const p = main[2].clone().lerp(main[3], t * 0.8);
    parts.push({ geo: cardGeometry('moss', 0.9, 0.9, 0, 1), m: mat(p.x, p.y + 0.5, p.z, -Math.PI / 2, rng() * 6, 0), color: lerpColor(PAL.moss, PAL.mossDeep, rng() * 0.5) });
  }
  for (const x of [-0.6, 0.5]) {
    const pts = [new Vector3(x, 2.35, 0.1), new Vector3(x + 0.1, 1.6, 0.15), new Vector3(x - 0.05, 0.9, 0.1), new Vector3(x + 0.05, 0.35, 0.08)];
    parts.push({ geo: solidUV(tubeAlong(pts, (t) => 0.03 * (1 - 0.4 * t), 3, 8)), color: lerpColor('#27401c', '#3e5524', rng()) });
  }
  const geo = mergeParts(parts);
  geo.scale(ROOT_ARCH.scale, ROOT_ARCH.scale, ROOT_ARCH.scale); // authored 2.75 m high, baked to 4.7 m: a root you walk under, not a hoop
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const mesh = new Mesh(geo, foliageCardMaterial);
  mesh.name = 'RootArch';
  return mesh;
}

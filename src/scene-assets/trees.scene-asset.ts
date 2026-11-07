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
import { BufferGeometry, Color, Float32BufferAttribute, Mesh, Vector3 } from '@iwsdk/core';
import { ENTRANCE_TREES, ROOT_ARCH, fbm, makeRandom, smoothstep, terrainHeight } from '../world/layout.js';
import { PAL } from '../world/palette.js';
import type { TreeKind } from '../world/placements.js';
import { blobCardGeometry, cardGeometry, lerpColor, mat, mergeParts, softNormals, solidUV, tubeAlong } from './lib/geo.js';
import type { ColorFn, Part } from './lib/geo.js';
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
}

export const TREE_SPECS: Record<TreeKind, TreeSpec[]> = {
  giant: [
    { seed: 101, height: 38, radius: 1.55, lobes: 5, flare: 0.72, branchStart: 0.5, limbs: 7, crown: 7.5, lean: 0.9, vines: 3, hanging: 9, tone: 0.2 },
    { seed: 202, height: 42, radius: 1.8, lobes: 6, flare: 0.8, branchStart: 0.55, limbs: 8, crown: 8.5, lean: -1.2, vines: 3, hanging: 10, tone: 0.45 },
    { seed: 303, height: 34, radius: 1.4, lobes: 4, flare: 0.62, branchStart: 0.42, limbs: 7, crown: 9, lean: 0.4, vines: 2, hanging: 8, tone: 0.1 },
  ],
  tall: [
    { seed: 411, height: 27, radius: 0.85, lobes: 4, flare: 0.48, branchStart: 0.55, limbs: 5, crown: 5, lean: 0.6, vines: 2, hanging: 4, tone: 0.3 },
    { seed: 422, height: 30, radius: 0.8, lobes: 5, flare: 0.42, branchStart: 0.62, limbs: 5, crown: 4.6, lean: -0.7, vines: 1, hanging: 3, tone: 0.15 },
    { seed: 433, height: 24, radius: 0.95, lobes: 3, flare: 0.5, branchStart: 0.5, limbs: 6, crown: 5.4, lean: 0.3, vines: 2, hanging: 5, tone: 0.5 },
  ],
  broad: [
    { seed: 511, height: 19, radius: 1.0, lobes: 5, flare: 0.45, branchStart: 0.38, limbs: 6, crown: 6.8, lean: 0.4, vines: 2, hanging: 5, tone: 0.1 },
    { seed: 522, height: 17, radius: 0.9, lobes: 4, flare: 0.4, branchStart: 0.34, limbs: 6, crown: 6.2, lean: -0.5, vines: 1, hanging: 4, tone: 0.4 },
  ],
  slender: [
    { seed: 611, height: 22, radius: 0.5, lobes: 3, flare: 0.3, branchStart: 0.6, limbs: 4, crown: 3.6, lean: -0.8, vines: 1, hanging: 3, tone: 0.55 },
    { seed: 622, height: 19, radius: 0.55, lobes: 3, flare: 0.28, branchStart: 0.55, limbs: 4, crown: 3.4, lean: 0.7, vines: 1, hanging: 2, tone: 0.3 },
  ],
};

export type TreeLod = 'hi' | 'lo';

/** Crown cards are trimmed to the clump's alpha silhouette (see blobCardGeometry): fewer wasted fragments. */
const crownCard = (size: number) => blobCardGeometry('clump', size);

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

function trunkRadiusAt(spec: TreeSpec, y: number, theta: number): number {
  const t = Math.min(1, Math.max(0, y / spec.height));
  let r = spec.radius * (1.12 - 0.45 * t);
  const lobe = Math.pow(Math.max(0, Math.cos(spec.lobes * theta + spec.seed)), 1.4);
  const flareFall = Math.exp(-Math.max(0, y) / (1.4 + spec.height * 0.045));
  r *= 1 + (spec.flare * lobe + 0.25) * flareFall;
  r *= 1 + 0.055 * (barkGroove(spec, theta, y) - 0.5) * 2;
  return r;
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
  const radial = lod === 'hi' ? 18 : 9;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const c = new Vector3();
  rings.forEach((y, i) => {
    trunkCenter(spec, y, c);
    for (let j = 0; j < radial; j++) {
      const th = (j / radial) * Math.PI * 2;
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
function barkColor(spec: TreeSpec): ColorFn {
  const out = new Color();
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
function limb(parts: Part[], start: Vector3, dir: Vector3, len: number, r0: number, rise: number, color: ColorFn, radial: number, segs: number): { end: Vector3; mid: Vector3; at: (t: number) => Vector3 } {
  const mid = start.clone().addScaledVector(dir, len * 0.5).add(new Vector3(0, len * rise * 0.7, 0));
  const end = start.clone().addScaledVector(dir, len).add(new Vector3(0, len * rise, 0));
  const q = start.clone().lerp(mid, 0.5).add(new Vector3(0, len * 0.04, 0));
  const pts = [start, q, mid, end];
  parts.push({ geo: solidUV(tubeAlong(pts, (t) => r0 * (1 - 0.82 * t), radial, segs)), color });
  return { end, mid, at: (t) => (t < 0.5 ? start.clone().lerp(mid, t * 2) : mid.clone().lerp(end, (t - 0.5) * 2)) };
}

export function createTree(kind: TreeKind, variant: number, lod: TreeLod = 'hi'): Mesh {
  const spec = TREE_SPECS[kind][variant % TREE_SPECS[kind].length];
  const rng = makeRandom(spec.seed + (lod === 'lo' ? 7 : 0));
  const parts: Part[] = [{ geo: trunkGeometry(spec, lod), color: barkColor(spec) }];
  const bark = barkColor(spec);

  const c = new Vector3();
  const surface = (y: number, th: number, push = 1): Vector3 => {
    trunkCenter(spec, y, c);
    const r = trunkRadiusAt(spec, y, th) * push;
    return new Vector3(c.x + Math.cos(th) * r, y, c.z + Math.sin(th) * r);
  };

  // Climbing lianas hugging the trunk (hi only).
  for (let i = 0; i < (lod === 'hi' ? spec.vines : 0); i++) {
    const th0 = rng() * Math.PI * 2;
    const turns = 0.5 + rng() * 0.9;
    const top = spec.height * (0.5 + rng() * 0.25);
    const pts: Vector3[] = [];
    for (let k = 0; k <= 8; k++) {
      const t = k / 8;
      pts.push(surface(t * top, th0 + t * turns * Math.PI * 2, 1.04));
    }
    const rad = 0.045 + rng() * 0.035;
    parts.push({ geo: solidUV(tubeAlong(pts, (t) => rad * (1.2 - 0.5 * t), 4, 10)), color: lerpColor('#2c4520', '#4a5a2a', rng()) });
  }

  // Limbs -> sub-limbs -> crown clusters.
  const crowns: { p: Vector3; r: number }[] = [];
  const nLimbs = lod === 'hi' ? spec.limbs : Math.max(3, Math.round(spec.limbs * 0.55));
  for (let i = 0; i < nLimbs; i++) {
    const th = (i / nLimbs) * Math.PI * 2 + rng() * 0.6;
    const h = spec.height * (spec.branchStart + (0.93 - spec.branchStart) * rng());
    const start = surface(h, th, 0.72);
    const len = spec.crown * (0.7 + 0.55 * rng()) * (0.65 + 0.5 * (h / spec.height));
    const dir = new Vector3(Math.cos(th), 0, Math.sin(th));
    const r0 = Math.max(0.1, trunkRadiusAt(spec, h, th) * 0.32);
    const L = limb(parts, start, dir, len, r0, 0.1 + 0.2 * rng(), bark, lod === 'hi' ? 4 : 4, lod === 'hi' ? 5 : 3);
    crowns.push({ p: L.end, r: spec.crown * 0.55 });
    if (lod === 'hi') {
      // Sub-limbs fork off the outer half.
      for (let k = 0; k < 2; k++) {
        const t = 0.5 + 0.35 * rng();
        const st = L.at(t);
        const ang = th + (k ? 0.75 : -0.75) * (0.7 + 0.5 * rng());
        const sd = new Vector3(Math.cos(ang), 0, Math.sin(ang));
        const S = limb(parts, st, sd, len * (0.38 + 0.2 * rng()), r0 * 0.45, 0.12 + 0.2 * rng(), bark, 4, 4);
        crowns.push({ p: S.end, r: spec.crown * 0.4 });
      }
      // Hanging lianas from the limb underside.
      const nh = Math.round(spec.hanging / spec.limbs + rng());
      for (let k = 0; k < nh; k++) {
        const at = L.at(0.25 + 0.7 * rng());
        const drop = 3 + rng() * (spec.height * 0.2);
        const sway = (rng() - 0.5) * 0.9;
        const pts = [at.clone(), at.clone().add(new Vector3(sway * 0.3, -drop * 0.35, sway * 0.2)), at.clone().add(new Vector3(sway, -drop * 0.7, -sway * 0.4)), at.clone().add(new Vector3(sway * 0.6, -drop, sway * 0.2))];
        parts.push({ geo: solidUV(tubeAlong(pts, (t) => 0.035 * (1 - 0.5 * t), 3, 5)), color: lerpColor('#27401c', '#3e5524', rng()) });
        // A trailing leaf card or two near the bottom.
        const lc = pts[3];
        const vc = cardGeometry('vine', 1.1 + rng() * 0.7, 0.55, 0.2, 2);
        parts.push({ geo: vc, m: mat(lc.x, lc.y - 1.0, lc.z, 0, rng() * 6.28, 0), color: lerpColor(PAL.leafMid, PAL.leafLight, rng()) });
      }
    }
  }
  // The leading shoot crowns the trunk.
  trunkCenter(spec, spec.height * 0.97, c);
  crowns.push({ p: c.clone(), r: spec.crown * 0.6 });

  // Crowns: clusters of cutout leaf-clump cards at varied angles (rounded-mass lighting from soft normals).
  const color = crownColor(spec.tone, spec.seed);
  const centre = crowns.reduce((a, k) => a.add(k.p), new Vector3()).multiplyScalar(1 / crowns.length);
  for (const cr of crowns) {
    const n = lod === 'hi' ? 3 : 1;
    for (let k = 0; k < n; k++) {
      const size = cr.r * (1.5 + 0.9 * rng()) * (lod === 'lo' ? 1.45 : 1);
      const card = crownCard(size);
      // Orientation mix: tilted flat-ish masses read as canopy layers; vertical ones fill the sides.
      const flat = k % 2 === 0;
      const rx = flat ? -Math.PI / 2 + (rng() - 0.5) * 0.5 : (rng() - 0.5) * 0.5;
      const ry = rng() * Math.PI * 2;
      const off = new Vector3((rng() - 0.5) * cr.r, (rng() - 0.35) * cr.r * 0.5, (rng() - 0.5) * cr.r);
      const px = cr.p.x + off.x;
      const py = cr.p.y + off.y;
      const pz = cr.p.z + off.z;
      // card base sits at its bottom edge: shift by half the size so the card is centred on the cluster point
      const m = mat(px, py, pz, rx, ry, 0).multiply(mat(0, -size / 2, 0));
      const up = Math.max(0, Math.min(1, (py - (centre.y - spec.crown * 0.5)) / (spec.crown * 1.2)));
      const jitter = 0.85 + 0.3 * rng();
      parts.push({
        geo: card,
        m,
        normalFn: softNormals(centre.clone().add(new Vector3(0, -spec.crown * 0.6, 0)), 0.5),
        color: (p) => color(p, up).multiplyScalar(jitter),
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
  const pa = new Vector3(a[0] + 0.5, ya + 9.0, a[1]);
  const pb = new Vector3(b[0] - 0.6, yb + 10.4, b[1]);
  const mid = pa.clone().lerp(pb, 0.5).add(new Vector3(0.3, 1.9, 0.9));
  const q1 = pa.clone().lerp(mid, 0.5).add(new Vector3(0, 0.5, -0.3));
  const q3 = mid.clone().lerp(pb, 0.5).add(new Vector3(0, 0.4, 0.4));
  const limbColor = barkColor({ ...TREE_SPECS.giant[0], seed: 31 });
  parts.push({ geo: solidUV(tubeAlong([pa, q1, mid, q3, pb], (t) => 0.62 - 0.2 * Math.sin(Math.PI * t) + 0.04 * Math.sin(t * 40), 8, 22)), color: limbColor });
  const l0 = new Vector3(a[0] + 1.3, ya + 6.2, a[1] + 0.9);
  const l1 = pa.clone().lerp(pb, 0.45).add(new Vector3(0, 4.2, 1.6));
  const l2 = new Vector3(b[0] - 1.4, yb + 6.8, b[1] + 0.9);
  parts.push({ geo: solidUV(tubeAlong([l0, l1, l2], (t) => 0.1 + 0.05 * Math.sin(Math.PI * t), 5, 14)), color: lerpColor('#2f4a22', '#475a2d', 0.4) });

  const color = crownColor(0.2, 900);
  const centre = pa.clone().lerp(pb, 0.5).add(new Vector3(0, 2, 0));
  for (let i = 0; i < 12; i++) {
    const t = 0.06 + 0.88 * (i / 11);
    const p = pa.clone().lerp(pb, t);
    p.y = pa.y + (pb.y - pa.y) * t + 2.2 * Math.sin(Math.PI * t) + 0.7;
    p.z += (rng() - 0.5) * 1.6;
    const size = 3.0 + rng() * 2.0;
    const flat = i % 2 === 0;
    const m = mat(p.x, p.y, p.z, flat ? -Math.PI / 2 + (rng() - 0.5) * 0.4 : (rng() - 0.5) * 0.4, rng() * 6.28, 0).multiply(mat(0, -size / 2, 0));
    const up = flat ? 0.8 : 0.45;
    const jitter = 0.85 + 0.3 * rng();
    parts.push({ geo: crownCard(size), m, normalFn: softNormals(centre, 0.5), color: (q) => color(q, up).multiplyScalar(jitter) });
  }
  for (let i = 0; i < 24; i++) {
    const t = 0.1 + 0.8 * rng();
    const at = pa.clone().lerp(pb, t);
    at.y = pa.y + (pb.y - pa.y) * t + 1.9 * Math.sin(Math.PI * t) - 0.1;
    at.z += (rng() - 0.5) * 0.7;
    const drop = 3 + rng() * 5.4;
    const sway = (rng() - 0.5) * 0.8;
    const pts = [at.clone(), at.clone().add(new Vector3(sway * 0.3, -drop * 0.3, 0)), at.clone().add(new Vector3(sway, -drop * 0.7, (rng() - 0.5) * 0.3)), at.clone().add(new Vector3(sway * 0.8, -drop, 0))];
    const rad = 0.025 + rng() * 0.03;
    parts.push({ geo: solidUV(tubeAlong(pts, (u) => rad * (1 - 0.4 * u), 3, 8)), color: lerpColor('#243a19', '#46622a', rng()) });
    if (rng() > 0.35) {
      parts.push({ geo: cardGeometry('vine', 1.4 + rng() * 1.2, 0.7, 0.15, 2), m: mat(pts[3].x, pts[3].y - 1.3, pts[3].z, 0, rng() * 6.28, 0), color: lerpColor(PAL.leafMid, PAL.leafLight, rng()) });
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
  const mesh = new Mesh(mergeParts(parts), foliageCardMaterial);
  mesh.name = 'RootArch';
  void ROOT_ARCH;
  return mesh;
}

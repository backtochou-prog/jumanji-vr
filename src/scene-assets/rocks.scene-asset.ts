/**
 * Moss-covered rocks, the distant cliff and the waterfalls.
 *
 * Rocks are displaced icospheres with sedimentary strata (banded relief and
 * colour), soft-faceted normals, moss on upward faces and a wet, dark base
 * (baked AO). Origins sit at the base with the lowest ~30 % meant to be
 * buried, so rocks read as grown into the ground, never resting on it.
 */
import { BufferGeometry, CircleGeometry, Color, Float32BufferAttribute, Group, IcosahedronGeometry, Mesh, Vector3 } from '@iwsdk/core';
import { CLIFF, SCALE, fbm, makeRandom, smoothstep } from '../world/layout.js';
import { PAL } from '../world/palette.js';
import type { Part } from './lib/geo.js';
import { displace, mergeParts, tubeAlong } from './lib/geo.js';
import { lightShaftMaterial, rockMaterial, waterfallMaterial } from './lib/materials.js';
// the waterfall's own imports (the spray-bow is derived from the spawn and the sun)
import { ALTAR, SPAWN, terrainHeight } from '../world/layout.js';
import { SUN_DIR } from '../world/palette.js';

// Overlook Knoll stones (sunlit boulders, the sandstone monoliths): palette and the monolith's placement scale
import { MONOLITH_SCALE } from '../world/layout.js';
import { MEADOW } from '../world/palette.js';

const STONE_DARK = new Color(PAL.stoneDark);
const STONE_LIGHT = new Color(PAL.stone);
const STONE_WET = new Color(PAL.stoneWet);
const MOSS_A = new Color(PAL.moss);
const MOSS_B = new Color(PAL.leafLight);
const MOSS_D = new Color(PAL.mossDeep);

function rockColor(seed: number, mossiness: number) {
  const out = new Color();
  return (p: Vector3, n: Vector3): Color => {
    const grain = fbm(p.x * 2.1 + seed, p.z * 2.1 + p.y * 1.3, seed, 3);
    const strata = 0.5 + 0.5 * Math.sin(p.y * 11 + grain * 3);
    out.copy(STONE_DARK).lerp(STONE_LIGHT, smoothstep(0.25, 0.8, grain) * 0.8 + strata * 0.2);
    out.lerp(STONE_WET, 0.35 * (1 - smoothstep(0, 0.55, p.y)));
    const moss = Math.min(1, smoothstep(0.1, 0.65, n.y + (grain - 0.5) * 0.7) * mossiness + smoothstep(0.62, 0.8, fbm(p.x * 3 + 9, p.z * 3, seed + 2, 2)) * 0.35 * mossiness);
    out.lerp(MOSS_D, moss * 0.5).lerp(MOSS_A, moss * 0.8).lerp(MOSS_B, moss * smoothstep(0.6, 1, n.y) * 0.4);
    out.multiplyScalar(0.3 + 0.7 * smoothstep(0.0, 0.7, p.y)); // baked contact shadow: dark where stone meets soil
    return out;
  };
}

function rockGeometry(seed: number, sx: number, sy: number, sz: number, detail = 2): BufferGeometry {
  const g = new IcosahedronGeometry(1, detail);
  const rng = makeRandom(seed);
  const o = rng() * 50;
  displace(g, (v) => {
    const dir = v.clone().normalize();
    const rough = 0.84 + 0.34 * fbm(dir.x * 1.5 + o, dir.z * 1.5 + dir.y * 1.1, seed, 3) + 0.03 * Math.sin(dir.y * 14 + seed);
    v.copy(dir).multiplyScalar(rough);
    v.x *= sx;
    v.y = Math.max(v.y * sy, -0.35 * sy);
    v.z *= sz;
    v.y += 0.35 * sy;
  });
  return g;
}


// ---------------------------------------------------------------------------
// Overlook Knoll stones: sunlit boulders / standing stones and the sandstone monoliths (everything below is only used by the knoll's variants)
// ---------------------------------------------------------------------------

const SAND = {
  dark: new Color(MEADOW.sandstoneDark),
  mid: new Color(MEADOW.sandstone),
  pale: new Color(MEADOW.sandstonePale),
  iron: new Color(MEADOW.ironStain),
  bleach: new Color(MEADOW.bleach),
  lichen: new Color(MEADOW.lichen),
  lichenDark: new Color(MEADOW.lichenDark),
};

/**
 * Sunlit stone colour (warm sandstone bleached by the sun, pale lichen instead of moss, a little green at the foot): the same banding as the jungle's rocks but
 * a different palette, because the knoll's rocks stand in full sun on dry grass, not in a wet understorey. `p` is in prototype units (y = 0 at the base).
 */
function sunlitRockColor(seed: number) {
  const out = new Color();
  return (p: Vector3, n: Vector3): Color => {
    const grain = fbm(p.x * 2.1 + seed, p.z * 2.1 + p.y * 1.3, seed, 3);
    const strata = 0.5 + 0.5 * Math.sin(p.y * 9 + grain * 3);
    out.copy(SAND.dark).lerp(SAND.mid, smoothstep(0.25, 0.8, grain) * 0.75 + strata * 0.25);
    out.lerp(SAND.pale, smoothstep(0.7, 0.95, strata) * 0.25);
    out.lerp(SAND.bleach, smoothstep(0.35, 1, n.y) * 0.4);
    const lich = smoothstep(0.62, 0.8, fbm(p.x * 3 + 9, p.z * 3 + p.y * 2, seed + 2, 3)) * (0.35 + 0.65 * smoothstep(-0.1, 0.6, n.y));
    out.lerp(SAND.lichen, lich * 0.7);
    out.lerp(SAND.lichenDark, (1 - smoothstep(0, 0.45, p.y)) * 0.4 * (0.4 + 0.6 * grain)); // damp, green foot
    out.multiplyScalar(0.34 + 0.66 * smoothstep(0.0, 0.7, p.y)); // baked contact shadow
    return out;
  };
}

/**
 * Cleavage: flatten a rock with `planes` random planes cutting 18-35 % off its outline (real boulders split along joints, they are not lumpy spheres), then
 * map every triangle's UVs by its dominant axis in prototype units (box mapping: no pole pinch, no seam). The geometry is non-indexed, so each facet stands alone.
 */
function cleaveAndBoxMap(g: BufferGeometry, seed: number, planes: number, sx: number, sy: number, sz: number, upright = false, uvScale = 0.9): BufferGeometry {
  const rng = makeRandom(seed * 7 + 3);
  const pos = g.getAttribute('position');
  const cy = 0.35 * sy;
  const v = new Vector3();
  for (let k = 0; k < planes; k++) {
    const a = rng() * Math.PI * 2;
    const e = upright ? (rng() - 0.5) * 0.5 : (rng() - 0.25) * 1.5; // plane normals lean upward more often than downward (a standing stone is cut from the sides)
    const nrm = new Vector3(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e)).normalize();
    // distance from the centre to the outline of the (anisotropic) rock along the normal, then cut the outer 18-35 %
    const rad = 1 / Math.sqrt((nrm.x / sx) ** 2 + (nrm.y / sy) ** 2 + (nrm.z / sz) ** 2);
    const d = rad * (upright ? 0.8 + 0.1 * rng() : 0.65 + 0.17 * rng());
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      v.y -= cy;
      const over = v.dot(nrm) - d;
      if (over > 0) v.addScaledVector(nrm, -over);
      v.y += cy;
      if (v.y < 0) v.y = Math.max(v.y, -0.3 * sy); // keep the buried part from flaring out
      pos.setXYZ(i, v.x, v.y, v.z);
    }
  }
  g.computeVertexNormals();
  const uv = g.getAttribute('uv');
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const nn = new Vector3();
  for (let t = 0; t < pos.count; t += 3) {
    a.fromBufferAttribute(pos, t);
    b.fromBufferAttribute(pos, t + 1);
    c.fromBufferAttribute(pos, t + 2);
    nn.crossVectors(b.clone().sub(a), c.clone().sub(a));
    const ax = Math.abs(nn.x);
    const ay = Math.abs(nn.y);
    const az = Math.abs(nn.z);
    for (let q = 0; q < 3; q++) {
      v.fromBufferAttribute(pos, t + q);
      if (ay >= ax && ay >= az) uv.setXY(t + q, v.x * uvScale, v.z * uvScale);
      else if (ax >= az) uv.setXY(t + q, v.z * uvScale + 0.37, v.y * uvScale);
      else uv.setXY(t + q, v.x * uvScale + 0.71, v.y * uvScale);
    }
  }
  uv.needsUpdate = true;
  return g;
}

/** Knoll variants of the shared kinds (appended after the jungle's, which keep their ids): boulder 2-3 sunlit, standing 2-3 monoliths, standing 4 a sunlit stone. */
function knollRock(kind: RockKind, variant: number): Mesh | null {
  if (kind === 'standing' && (variant === 2 || variant === 3)) return createMonolith(variant - 2);
  const seed = 61 + variant * 11 + (kind === 'standing' ? 200 : 0);
  let geo: BufferGeometry;
  if (kind === 'boulder' && variant >= 2) {
    const dims = variant === 2 ? ([1.05, 0.64, 0.9] as const) : ([0.88, 0.8, 0.96] as const);
    geo = cleaveAndBoxMap(rockGeometry(seed, dims[0], dims[1], dims[2], 3), seed, 4, dims[0], dims[1], dims[2]);
  } else if (kind === 'standing' && variant >= 4) {
    geo = cleaveAndBoxMap(rockGeometry(seed, 0.5, 1.5, 0.42), seed, 5, 0.5, 1.5, 0.42, true);
  } else if (kind === 'slab' && variant >= 2) {
    // the lookout stone: a worn, nearly flat dome (placed sunk until ~4 cm shows), polished pale in the middle where people stand
    return lookoutStone(seed);
  } else if (kind === 'cobble' && variant >= 2) {
    geo = cleaveAndBoxMap(rockGeometry(seed, 0.55, 0.4, 0.5, 1), seed, 3, 0.55, 0.4, 0.5);
  } else return null;
  const mesh = new Mesh(
    mergeParts([{ geo, normalFn: (p, n) => n.clone().multiplyScalar(0.7).add(new Vector3(p.x, p.y - 0.25, p.z).normalize().multiplyScalar(0.3)).normalize(), color: sunlitRockColor(seed) }]),
    rockMaterial,
  );
  mesh.name = `Rock_${kind}_${variant}`;
  return mesh;
}

/** The lookout stone (slab variant 2): 2.2 x 1.9 m at scale 1, 0.16 m high; the placement sinks it so only the pale worn top shows. */
function lookoutStone(seed: number): Mesh {
  const sx = 1.1;
  const sz = 0.95;
  const geo = rockGeometry(seed, sx, 0.12, sz, 2);
  const out = new Color();
  const colour = (p: Vector3, n: Vector3): Color => {
    const r = Math.hypot(p.x / sx, p.z / sz);
    const grain = fbm(p.x * 3 + seed, p.z * 3, seed, 3);
    out.copy(SAND.mid).lerp(SAND.dark, smoothstep(0.35, 0.7, grain) * 0.45);
    out.lerp(SAND.pale, (1 - smoothstep(0.1, 0.75, r)) * 0.55); // worn pale where feet stand
    out.lerp(SAND.lichen, smoothstep(0.55, 0.9, r) * smoothstep(0.55, 0.75, fbm(p.x * 2.4 + 5, p.z * 2.4, seed + 3, 2)) * 0.6);
    out.lerp(SAND.lichenDark, smoothstep(0.8, 1.05, r) * 0.5);
    out.multiplyScalar(0.8 + 0.2 * n.y);
    return out;
  };
  const mesh = new Mesh(mergeParts([{ geo, normalFn: (p, n) => n.clone().multiplyScalar(0.4).add(new Vector3(0, 1, 0).multiplyScalar(0.6)).normalize(), color: colour }]), rockMaterial);
  mesh.name = 'Rock_slab_lookout';
  return mesh;
}

/** The two monoliths' authored size in METRES (half-extents of the footprint, height) and silhouette. They are placed at MONOLITH_SCALE, so the prototype is authored at 1 / MONOLITH_SCALE. */
const MONOLITHS = [
  { sides: 6, cols: 3, rings: 22, w: 1.25, d: 0.9, h: 7.0, lean: [0.035, -0.02], tilt: 0.55, seed: 901 },
  { sides: 5, cols: 3, rings: 26, w: 1.0, d: 0.85, h: 5.6, lean: [-0.05, 0.03], tilt: 2.3, seed: 917 },
] as const;

/**
 * A sandstone monolith (variant 0: 7.0 m, variant 1: 5.6 m; ~800 triangles each): a faceted tower with flat cleavage faces (per-side vertices, crisp edges),
 * layered beds that weather into ledges and undercuts, a slanted top plane where it sheared, a flared foot. Built at true size in metres and scaled by
 * 1 / MONOLITH_SCALE, to be placed (as rock `standing` variant 2 / 3) at MONOLITH_SCALE, so a 7 m stone IS 7 m tall and the collider / AO / placement
 * rules of a scaled `standing` stone (footprint ~ 1.1 x scale) still match. The lowest 0.6 m is meant to be buried.
 */
export function createMonolith(variant: number): Mesh {
  const spec = MONOLITHS[((variant % 2) + 2) % 2];
  const rng = makeRandom(spec.seed);
  const o = rng() * 40;
  const { sides: N, cols: C, rings: M, w: W, d: D, h: H } = spec;
  // footprint corners: an irregular polygon, longer along x than z
  const corners: [number, number][] = [];
  for (let k = 0; k < N; k++) {
    const a = ((k + 0.25 * (rng() - 0.5)) / N) * Math.PI * 2 + 0.3;
    const r = 0.82 + 0.3 * rng();
    corners.push([Math.cos(a) * W * r, Math.sin(a) * D * r]);
  }
  const topY = (x: number, z: number) => H + 0.34 * (x * Math.cos(spec.tilt) + z * Math.sin(spec.tilt));
  const y0 = -0.6;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const perCol = M + 1;
  let perimeter = 0;
  const rowOf: number[] = [];
  for (let k = 0; k < N; k++) {
    const A = corners[k];
    const B = corners[(k + 1) % N];
    const sideLen = Math.hypot(B[0] - A[0], B[1] - A[1]);
    for (let c = 0; c <= C; c++) {
      const s = c / C;
      const bx = A[0] + (B[0] - A[0]) * s;
      const bz = A[1] + (B[1] - A[1]) * s;
      const rl = Math.hypot(bx, bz) || 1;
      const yTop = topY(bx, bz);
      rowOf.push(positions.length / 3);
      for (let j = 0; j <= M; j++) {
        const t = j / M;
        const y = y0 + (yTop - y0) * t;
        const yy = Math.max(0, y);
        // taper, flared foot, bed-by-bed weathering (each bed is undercut at its bottom and sheds a ledge)
        const bed = (yy * 0.86 + 0.5 * fbm(bx * 0.4 + o, bz * 0.4, 5, 2)) % 1;
        const ledge = 0.07 * (smoothstep(0, 0.14, bed) - 0.65 * smoothstep(0.14, 1, bed));
        const f = (1 - 0.26 * Math.pow(Math.min(1, yy / H), 1.15)) * (1 + 0.14 * Math.exp(-yy / 0.8)) * (1 + ledge);
        const rough = (fbm(bx * 0.8 + o, y * 0.55 + bz * 0.8, 9, 3) - 0.5) * 0.34 + (fbm(bx * 3.1 + y * 2.3, bz * 3.1, 11, 2) - 0.5) * 0.07;
        const x = bx * f + spec.lean[0] * yy + (bx / rl) * rough;
        const z = bz * f + spec.lean[1] * yy + (bz / rl) * rough;
        positions.push(x / MONOLITH_SCALE, y / MONOLITH_SCALE, z / MONOLITH_SCALE);
        uvs.push(((perimeter + sideLen * s) * 0.5), y * 0.5);
      }
    }
    perimeter += sideLen;
  }
  for (let k = 0; k < N; k++) {
    for (let c = 0; c < C; c++) {
      const a = rowOf[k * (C + 1) + c];
      const b = rowOf[k * (C + 1) + c + 1];
      for (let j = 0; j < M; j++) indices.push(a + j, a + j + 1, b + j, b + j, a + j + 1, b + j + 1);
    }
  }
  // the sheared top: a fan from the middle over copies of the top ring (own vertices: a crisp edge between the cap and the sides)
  const cx = corners.reduce((q, p) => q + p[0], 0) / N;
  const cz = corners.reduce((q, p) => q + p[1], 0) / N;
  const capCentre = positions.length / 3;
  positions.push((cx + spec.lean[0] * H * 0.9) / MONOLITH_SCALE, (topY(cx, cz) - 0.08) / MONOLITH_SCALE, (cz + spec.lean[1] * H * 0.9) / MONOLITH_SCALE);
  uvs.push(cx * 0.5, cz * 0.5);
  for (let k = 0; k < N; k++) {
    for (let c = 0; c < C; c++) {
      const i0 = rowOf[k * (C + 1) + c] + M;
      const i1 = rowOf[k * (C + 1) + c + 1] + M;
      const q0 = positions.length / 3;
      positions.push(positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2], positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]);
      uvs.push(positions[i0 * 3] * MONOLITH_SCALE * 0.5, positions[i0 * 3 + 2] * MONOLITH_SCALE * 0.5, positions[i1 * 3] * MONOLITH_SCALE * 0.5, positions[i1 * 3 + 2] * MONOLITH_SCALE * 0.5);
      indices.push(capCentre, q0 + 1, q0);
    }
  }
  void perCol;
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const seed = spec.seed;
  const S = MONOLITH_SCALE;
  const out = new Color();
  const colour = (p: Vector3, n: Vector3): Color => {
    const x = p.x * S;
    const y = p.y * S;
    const z = p.z * S;
    const grain = fbm(x * 1.6 + seed, z * 1.6 + y * 0.9, seed, 3);
    const bed = 0.5 + 0.5 * Math.sin(y * 5.2 + grain * 2.4 + fbm(x * 0.5, z * 0.5, seed + 3, 2) * 2);
    const lam = 0.5 + 0.5 * Math.sin(y * 19 + grain * 5);
    out.copy(SAND.dark).lerp(SAND.mid, 0.35 + 0.45 * bed).lerp(SAND.pale, smoothstep(0.65, 0.95, lam) * 0.22);
    // iron staining and dark rain streaks run down the faces
    const streak = fbm(x * 2.3 + z * 2.3, y * 0.12, seed + 7, 3);
    out.lerp(SAND.iron, smoothstep(0.58, 0.82, streak) * 0.5);
    out.multiplyScalar(1 - 0.2 * smoothstep(0.62, 0.86, fbm(x * 3.4 - z * 3.4, y * 0.1, seed + 9, 2)));
    // sun-bleached tops and lit faces, then pale lichen crusts
    out.lerp(SAND.bleach, smoothstep(0.35, 1, n.y) * 0.4 + smoothstep(spec.h * 0.6, spec.h, y) * 0.12);
    const lich = smoothstep(0.64, 0.8, fbm(x * 2.6, y * 2.6 + z * 1.3, seed + 11, 3)) * (0.35 + 0.65 * smoothstep(-0.1, 0.6, n.y));
    out.lerp(SAND.lichen, lich * 0.65);
    out.lerp(SAND.lichenDark, (1 - smoothstep(0, 1.1, y + 0.2)) * 0.45 * (0.4 + 0.6 * grain)); // damp green foot
    out.multiplyScalar(0.36 + 0.64 * smoothstep(-0.1, 1.6, y)); // contact shadow
    return out;
  };
  const mesh = new Mesh(mergeParts([{ geo, normalFn: (p, n) => n.clone().multiplyScalar(0.85).add(new Vector3(p.x, 0, p.z).normalize().multiplyScalar(0.15)).normalize(), color: colour }]), rockMaterial);
  mesh.name = `Monolith_${variant}`;
  return mesh;
}

export type RockKind = 'boulder' | 'slab' | 'standing' | 'cobble';
export const ROCK_VARIANTS: Record<RockKind, number> = { boulder: 4, slab: 3, standing: 5, cobble: 4 };

export function createRock(kind: RockKind, variant: number): Mesh {
  // the knoll's own variants (boulder 2-3, slab 2, standing 2-4, cobble 2-3) come first; placements name them explicitly (RockPlacement.fixedVariant)
  const knoll = knollRock(kind, variant);
  if (knoll) return knoll;
  const seed = 61 + variant * 11 + (kind === 'slab' ? 100 : kind === 'standing' ? 200 : kind === 'cobble' ? 300 : 0);
  const geo =
    kind === 'boulder'
      ? [rockGeometry(seed, 0.95, 0.74, 0.85), rockGeometry(seed, 0.8, 0.9, 0.78), rockGeometry(seed, 1.05, 0.62, 0.9)][variant % 3]
      : kind === 'slab'
        ? [rockGeometry(seed, 1.25, 0.36, 0.95), rockGeometry(seed, 1.0, 0.42, 1.2)][variant % 2]
        : kind === 'standing'
          ? rockGeometry(seed, 0.5, 1.5, 0.42)
          : [rockGeometry(seed, 0.55, 0.4, 0.5, 1), rockGeometry(seed, 0.6, 0.34, 0.45, 1), rockGeometry(seed, 0.45, 0.45, 0.55, 1)][variant % 3];
  const parts: Part[] = [
    {
      geo,
      // Soft-faceted normals: half the face normal, half "away from the rock's centre" (reads as weathered stone, not flat polygons).
      normalFn: (p, n) => n.clone().multiplyScalar(0.5).add(new Vector3(p.x, p.y - 0.25, p.z).normalize().multiplyScalar(0.5)).normalize(),
      color: rockColor(seed, kind === 'cobble' ? 0.55 : 0.95),
    },
  ];
  const mesh = new Mesh(mergeParts(parts), rockMaterial);
  mesh.name = `Rock_${kind}_${variant}`;
  return mesh;
}

// ---------------------------------------------------------------------------
// Distant cliff + waterfall (the backdrop of the ancient clearing)
// ---------------------------------------------------------------------------

export const CLIFF_W = 64;
export const CLIFF_H = 40;

/** Cliff relief: stepped strata, a notch for the falls, concave bay. z = toward the viewer. */
function cliffZ(x: number, y: number): number {
  const bay = 0.012 * x * x;
  const strata = Math.floor(y / 4.5) * 0.9 + smoothstep(0, 1, (y % 4.5) / 4.5) * 0.9;
  const rough = (fbm(x * 0.26, y * 0.2, 71, 4) - 0.5) * 4.4;
  // the notch and the channel are wide enough to cradle the (widened) sheet: it lies in a groove, not on a bulge
  const notch = Math.exp(-(x * x) / 11.5) * smoothstep(CLIFF_H * 0.62, CLIFF_H * 0.78, y) * -3.6;
  const channel = Math.exp(-(x * x) / 5.0) * smoothstep(5, CLIFF_H * 0.76, y) * -1.1;
  return bay + strata + rough + notch + channel;
}

// ---------------------------------------------------------------------------
// The fall's footprint on the wall (authored units, before the SCALE.cliff bake). Shared by the sheet, the wet-stone colouring of the cliff
// and the spray, so the water, its wet halo and its mist always agree.
// ---------------------------------------------------------------------------
const FALL_TOP = CLIFF_H * 0.7; // 28: where the water leaves the lip
const FALL_BOT = -0.8;
const FALL_LEN = FALL_TOP - FALL_BOT;
const LEDGE = 4.5; // the strata period of cliffZ: the wall is vertical at multiples of it (the water slows and churns there)

const fallT = (y: number): number => (FALL_TOP - y) / FALL_LEN;
/** Distance (authored units) to the nearest strata ledge line. */
const ledgeDist = (y: number): number => {
  const f = ((y % LEDGE) + LEDGE) % LEDGE;
  return Math.min(f, LEDGE - f);
};
/** Half-width of the sheet at t (0 = lip .. 1 = foot): a tapered flare 2.5 -> 5.2 (4.5 -> 9.4 m), ragged edges, the water gathers at the brink. side = -1 | +1. */
function fallHalfWidth(t: number, side: number): number {
  const flare = 2.5 + 2.7 * t;
  const rag = (fbm(t * 6, side * 7.1 + 3.3, 77, 3) - 0.5) * 1.0;
  const brink = t < 0.08 ? 0.8 + 0.2 * Math.sqrt(t / 0.08) : 1;
  return (flare + rag) * brink;
}
/** Wall surface under a column of the sheet: the highest of a few nearby samples, so the water never sinks into the 48 x 28 grid's interpolation. */
function wallZ(x: number, y: number): number {
  let z = -1e9;
  for (const dy of [-0.7, 0, 0.7]) for (const dx of [-0.35, 0.35]) z = Math.max(z, cliffZ(x + dx, Math.max(0, y + dy)));
  return z;
}
/** Where the sheet's surface lies in front of the wall at (x, y). */
const sheetFront = (x: number, y: number, t: number): number => wallZ(x, y) + 0.4 + 0.7 * t * t;

export function createCliff(): Mesh {
  const nx = 48;
  const ny = 28;
  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const c = new Color();
  const moss = new Color(PAL.moss);
  const canopy = new Color(PAL.leafDeep ?? '#1a3a25');
  const wetRock = new Color(PAL.cliffWet);
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = (i / nx - 0.5) * CLIFF_W;
      const y = (j / ny) * CLIFF_H - 1.5;
      positions.push(x, y, cliffZ(x, Math.max(0, y)));
      uvs.push(x / 8, y / 8);
      const grain = fbm(x * 0.4, y * 0.3, 72, 3);
      c.copy(STONE_DARK).lerp(STONE_LIGHT, smoothstep(0.3, 0.75, grain) * 0.8);
      const streak = fbm(x * 0.7, y * 0.07, 73, 3);
      c.lerp(moss, smoothstep(0.5, 0.72, streak) * 0.75);
      c.lerp(canopy, smoothstep(CLIFF_H * 0.8, CLIFF_H * 0.97, y) * 0.9);
      c.multiplyScalar(0.55 + 0.4 * smoothstep(0, CLIFF_H * 0.5, y));
      // Wet stone: a dark halo that follows the sheet's edge (it widens down the fall), weep streaks that run out of it below the ledges,
      // and a dark, soaked foot. Nothing above the lip is wet.
      const t = Math.min(1, Math.max(0, fallT(y)));
      const beyond = Math.max(0, Math.abs(x) - fallHalfWidth(t, x < 0 ? -1 : 1));
      const aboveLip = 1 - smoothstep(FALL_TOP - 0.5, FALL_TOP + 3.5, y);
      const halo = Math.exp(-(beyond * beyond) / (3 + 5 * t)) * aboveLip;
      const weep = smoothstep(0.56, 0.76, fbm(x * 1.5, y * 0.06, 74, 3)) * Math.exp(-(beyond * beyond) / 22) * aboveLip * (0.3 + 0.7 * smoothstep(0, 0.5, ledgeDist(y) / LEDGE));
      const foot = Math.exp(-(x * x) / 70) * (1 - smoothstep(0, 1.7, y));
      c.lerp(wetRock, Math.min(0.85, halo * 0.8 + weep * 0.55 + foot * 0.6));
      c.multiplyScalar(1 - 0.28 * halo - 0.18 * foot);
      colors.push(c.r, c.g, c.b);
    }
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      indices.push(a, a + 1, a + nx + 1, a + 1, a + nx + 2, a + nx + 1);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  // authored 64 x 40 m, baked at SCALE.cliff: a 115 x 72 m rock wall behind the clearing, taller than the tallest tree
  g.scale(SCALE.cliff, SCALE.cliff, SCALE.cliff);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  const m = new Mesh(g, rockMaterial);
  m.name = 'Cliff';
  return m;
}

// ---------------------------------------------------------------------------
// The sheet: one geometry (main fall, two peeling strands, four hairlines), every vertex carrying aFall = (lateral -1..1, t 0..1, foam 0..1)
// ---------------------------------------------------------------------------

interface FallRow {
  xc: number;
  y: number;
  hwL: number;
  hwR: number;
  t: number;
  foam: number;
  lift: number;
}
interface FallBuf {
  p: number[];
  uv: number[];
  f: number[];
  i: number[];
}

/** A strip of rows (top to bottom) x `cols` columns that hugs the wall; `bulge` rounds the cross-section (the centre stands proud). */
function fallStrip(rows: FallRow[], cols: number, bulge: number, out: FallBuf): void {
  const base = out.p.length / 3;
  for (const r of rows) {
    for (let j = 0; j <= cols; j++) {
      const u = -1 + (2 * j) / cols;
      const x = r.xc + u * (u < 0 ? r.hwL : r.hwR);
      out.p.push(x, r.y, sheetFront(x, r.y, r.t) + r.lift + bulge * (1 - u * u));
      out.uv.push(x / 3.8, r.t * 6);
      out.f.push(u, r.t, r.foam);
    }
  }
  const w = cols + 1;
  for (let k = 0; k < rows.length - 1; k++) {
    for (let j = 0; j < cols; j++) {
      const a = base + k * w + j;
      out.i.push(a, a + w, a + 1, a + 1, a + w, a + w + 1);
    }
  }
}

function buildFallSheet(): BufferGeometry {
  const out: FallBuf = { p: [], uv: [], f: [], i: [] };
  // ---- the main fall: a row at every quarter of a strata period, so the ledges are rows (the jog and the foam bands sit exactly on them)
  const ys = [FALL_TOP];
  for (let y = 27; y > -0.5; y -= 1.125) ys.push(y);
  ys.push(FALL_BOT);
  const main: FallRow[] = ys.map((y) => {
    const t = fallT(y);
    const s = Math.min(1, t / 0.07);
    const d = ledgeDist(y);
    const onLedge = y > 3 && y < 27.5 ? Math.exp(-((d / 0.6) ** 2)) : 0;
    const jog = y > 3 && y < 27.5 ? Math.exp(-((d / 0.7) ** 2)) : 0;
    const spread = 1 + 0.25 * smoothstep(0.85, 1, t); // the foot fans out into the splash
    const lift = 0.3 * jog + 0.9 * (1 - s) * (1 - s); // ledge jog + the water arching out over the lip
    const foam = Math.max(0.85 * onLedge, 0.55 * (1 - smoothstep(0, 0.05, t)), smoothstep(0.88, 1, t));
    return { xc: 0, y, hwL: (fallHalfWidth(t, -1) + 0.45 * jog) * spread, hwR: (fallHalfWidth(t, 1) + 0.45 * jog) * spread, t, foam, lift };
  });
  fallStrip(main, 10, 0.5, out);

  // ---- two strands that peel off the edge and rejoin the cliff as spray (at 40 % and 65 % of the way down)
  const strand = (side: number, t0: number, t1: number): void => {
    const rows: FallRow[] = [];
    const n = 9;
    for (let k = 0; k < n; k++) {
      const s = k / (n - 1);
      const t = t0 + (t1 - t0) * s;
      const y = FALL_TOP - t * FALL_LEN;
      const hw = 0.1 + 0.65 * Math.sin(Math.PI * Math.pow(s, 0.7));
      const xc = side * (fallHalfWidth(t, side) * 0.9 + 0.3 + 1.5 * s);
      rows.push({ xc, y, hwL: hw, hwR: hw, t, foam: 0.25 + 0.65 * s * s * s, lift: 0.1 });
    }
    fallStrip(rows, 2, 0.25, out);
  };
  strand(-1, 0.4, 0.78);
  strand(1, 0.65, 0.95);

  // ---- hairlines: thin threads that spill off four ledges beside the sheet
  const hair = (yTop: number, side: number, off: number, len: number): void => {
    const rows: FallRow[] = [];
    const n = 5;
    for (let k = 0; k < n; k++) {
      const s = k / (n - 1);
      const y = yTop - len * s;
      const t = fallT(y);
      const hw = 0.06 + 0.14 * Math.sin(Math.PI * Math.pow(s, 0.8));
      rows.push({ xc: side * (fallHalfWidth(t, side) + off), y, hwL: hw, hwR: hw, t, foam: 0.2 + 0.3 * s, lift: 0.05 });
    }
    fallStrip(rows, 1, 0, out);
  };
  hair(22.5, 1, 1.6, 3.6);
  hair(18, -1, 1.2, 3.2);
  hair(13.5, 1, 2.3, 3.4);
  hair(9, -1, 2.0, 3.0);

  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(out.p, 3));
  g.setAttribute('uv', new Float32BufferAttribute(out.uv, 2));
  g.setAttribute('aFall', new Float32BufferAttribute(out.f, 3));
  g.setIndex(out.i);
  g.computeVertexNormals();
  g.scale(SCALE.cliff, SCALE.cliff, SCALE.cliff);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------------------
// The spray (all additive vertex colour, merged into ONE mesh with the base disc; peak colours stay <= 0.12)
// ---------------------------------------------------------------------------

interface MistBuf {
  p: number[];
  c: number[];
  /** aMist (lightShaftMaterial's optional plume attribute): x = height weight, y = rise in metres, z = phase. */
  m: number[];
  i: number[];
}

/** A soft 3 x 3 card: the bright core sits low in the card, the corners and the top edge are black (invisible when additive). Baked metres. */
function mistCard(cx: number, y0: number, cz: number, yaw: number, w: number, h: number, k: number, foot: number, tint: readonly [number, number, number], rise: number, phase: number, out: MistBuf): void {
  const base = out.p.length / 3;
  const dx = Math.cos(yaw);
  const dz = Math.sin(yaw);
  const rows = [
    { v: 0, hw: 0.5, k: [0, foot, 0] },
    { v: 0.38, hw: 0.5, k: [0.1, 1, 0.1] },
    { v: 1, hw: 0.36, k: [0, 0, 0] },
  ];
  for (const r of rows) {
    for (let j = 0; j < 3; j++) {
      const u = (j - 1) * r.hw * w;
      out.p.push(cx + dx * u, y0 + r.v * h, cz + dz * u);
      const kk = k * r.k[j];
      out.c.push(kk * tint[0], kk * tint[1], kk * tint[2]);
      out.m.push(r.v, rise, phase); // the card's top heaves, its foot stays
    }
  }
  for (let r = 0; r < 2; r++) {
    for (let j = 0; j < 2; j++) {
      const a = base + r * 3 + j;
      out.i.push(a, a + 3, a + 1, a + 1, a + 3, a + 4);
    }
  }
}

/** A fanned pair of cards (reads full width from anywhere in the front sector). */
function mistPair(cx: number, y0: number, cz: number, w: number, h: number, k: number, foot: number, tint: readonly [number, number, number], rise: number, out: MistBuf): void {
  const phase = (cx * 0.37 + cz * 0.21 + y0 * 0.13) % 6.2831853; // deterministic, differs between neighbours
  mistCard(cx, y0, cz, -0.42, w, h, k, foot, tint, rise, phase, out);
  mistCard(cx + 0.6, y0, cz - 0.4, 0.5, w * 0.9, h * 0.94, k, foot, tint, rise, phase + 2.1, out);
}

/** Spray-bow colours, outer (red) to inner (violet). */
const BOW = [
  [1.0, 0.22, 0.12],
  [1.0, 0.55, 0.14],
  [1.0, 0.88, 0.3],
  [0.3, 0.9, 0.4],
  [0.2, 0.75, 0.95],
  [0.25, 0.4, 1.0],
  [0.55, 0.22, 0.9],
] as const;
/** Across the bow: the outer and inner bands are dimmer, so its edges melt into the mist. */
const BOW_FADE = [0.4, 0.85, 1, 1, 1, 0.85, 0.4] as const;

/**
 * A stylised spray-bow: the real primary bow is a 42 degree circle around the anti-solar point (the direction the sunlight travels, SUN_DIR),
 * seen from the knoll. Here the part of that circle that crosses the fall's bearing (+-15 degrees) becomes a thin additive band hung just
 * in front of the sheet, so its height and tilt follow the sun: the apex sits at 42 degrees minus the sun's elevation above the horizon,
 * clamped to 5..18 degrees so it always lies over the fall rather than behind the temple or in the sky. If the sun is not roughly behind the
 * viewer (no bow could be seen) nothing is built. Everything is derived from SPAWN, SUN_DIR and the fall's pose; nothing is hard-coded.
 * `toLocal` maps world metres to the waterfall node's baked frame.
 */
function sprayBow(toLocal: (x: number, y: number, z: number) => [number, number, number], fallWorld: [number, number, number], out: MistBuf): void {
  const eye: [number, number, number] = [SPAWN[0], terrainHeight(SPAWN[0], SPAWN[1]) + 1.7, SPAWN[1]];
  const fx = fallWorld[0] - eye[0];
  const fz = fallWorld[2] - eye[2];
  const dist = Math.hypot(fx, fz);
  const f: [number, number, number] = [fx / dist, 0, fz / dist];
  const a = SUN_DIR; // anti-solar direction: the way the light travels
  const rad = Math.PI / 180;
  // orthonormal basis (u, v) around a
  let ux = a[2];
  let uz = -a[0];
  const ul = Math.hypot(ux, uz) || 1;
  ux /= ul;
  uz /= ul;
  const u: [number, number, number] = [ux, 0, uz];
  const v: [number, number, number] = [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]];
  const dirAt = (rho: number, phi: number): [number, number, number] => {
    const c = Math.cos(rho);
    const s = Math.sin(rho);
    const cp = Math.cos(phi);
    const sp = Math.sin(phi);
    return [a[0] * c + s * (u[0] * cp + v[0] * sp), a[1] * c + s * (u[1] * cp + v[1] * sp), a[2] * c + s * (u[2] * cp + v[2] * sp)];
  };
  const bearing = (d: [number, number, number]): number => Math.atan2(d[0] * f[2] - d[2] * f[0], d[0] * f[0] + d[2] * f[2]); // signed angle from f
  // 1. where does the nominal 42 degree circle cross the fall's bearing, and how high?
  const nominal = 42 * rad;
  let eAt = NaN;
  let best = 1e9;
  for (let k = 0; k < 720; k++) {
    const d = dirAt(nominal, (k / 720) * Math.PI * 2);
    if (d[1] <= 0) continue;
    const b = Math.abs(bearing(d));
    if (b < best) {
      best = b;
      eAt = Math.asin(d[1]);
    }
  }
  if (!(best < 1.5 * rad) || !(eAt > 0)) return; // the bow is not in the fall's direction: draw none
  const elev = Math.min(18 * rad, Math.max(5 * rad, eAt));
  // 2. the (stylised) angular radius that puts the circle exactly at that height over the fall's bearing
  const target: [number, number, number] = [Math.cos(elev) * f[0], Math.sin(elev), Math.cos(elev) * f[2]];
  const rho = Math.acos(Math.max(-1, Math.min(1, a[0] * target[0] + a[1] * target[1] + a[2] * target[2])));
  if (rho < 30 * rad || rho > 52 * rad) return;
  // 3. the arc: every direction of the circle within +-15 degrees of the fall's bearing
  const K = 20;
  let phiMid = 0;
  best = 1e9;
  for (let k = 0; k < 720; k++) {
    const phi = (k / 720) * Math.PI * 2;
    const d = dirAt(rho, phi);
    const b = Math.abs(bearing(d));
    if (d[1] > 0 && b < best) {
      best = b;
      phiMid = phi;
    }
  }
  // walk away from the middle in both directions to the +-15 degree limits
  const limit = (dir: number): number => {
    let phi = phiMid;
    for (let n = 0; n < 720; n++) {
      const next = phi + (dir * 0.25 * Math.PI) / 180;
      const d = dirAt(rho, next);
      if (Math.abs(bearing(d)) > 15 * rad || d[1] <= 0.02) break;
      phi = next;
    }
    return phi;
  };
  const p0 = limit(-1);
  const p1 = limit(1);
  if (p1 - p0 < 8 * rad) return;
  const D = Math.max(20, dist - 7); // the plane of the bow: just in front of the sheet
  const base = out.p.length / 3;
  for (let k = 0; k <= K; k++) {
    const t = k / K;
    const phi = p0 + (p1 - p0) * t;
    const amp = 0.06 * Math.pow(Math.sin(Math.PI * t), 0.8);
    for (let b = 0; b < 7; b++) {
      const d = dirAt(rho + (0.5 - b / 6) * 2.6 * rad, phi); // red outside (larger angle), violet inside
      const s = D / (d[0] * f[0] + d[2] * f[2]);
      const [lx, ly, lz] = toLocal(eye[0] + d[0] * s, eye[1] + d[1] * s, eye[2] + d[2] * s);
      out.p.push(lx, ly, lz);
      out.m.push(0, 0, 0);
      const kk = amp * BOW_FADE[b];
      out.c.push(BOW[b][0] * kk, BOW[b][1] * kk, BOW[b][2] * kk);
    }
  }
  for (let k = 0; k < K; k++) {
    for (let b = 0; b < 6; b++) {
      const i0 = base + k * 7 + b;
      out.i.push(i0, i0 + 7, i0 + 1, i0 + 1, i0 + 7, i0 + 8);
    }
  }
}

function buildFallMist(): BufferGeometry {
  const S = SCALE.cliff;
  const out: MistBuf = { p: [], c: [], m: [], i: [] };
  const tint = [0.8, 0.95, 1.0] as const;
  // The node's pose (generate-scene.mjs: position (CLIFF.x, -2, CLIFF.z), yaw toward the altar): the bow is computed in world space.
  const yaw = Math.atan2(ALTAR[0] - CLIFF.x, ALTAR[1] - CLIFF.z);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const toLocal = (x: number, y: number, z: number): [number, number, number] => {
    const dx = x - CLIFF.x;
    const dz = z - CLIFF.z;
    return [dx * cy - dz * sy, y + 2, dx * sy + dz * cy];
  };
  const toWorld = (lx: number, ly: number, lz: number): [number, number, number] => [CLIFF.x + lx * cy + lz * sy, ly - 2, CLIFF.z - lx * sy + lz * cy];

  // 1. the ground disc at the plunge (wider than before, brighter at the centre)
  const cz0 = (cliffZ(0, 0) + 4) * S;
  const disc = new CircleGeometry(14, 28);
  disc.rotateX(-Math.PI / 2);
  disc.scale(S, S, S);
  disc.translate(0, 0.4 * S, cz0);
  const dp = disc.getAttribute('position');
  const base0 = out.p.length / 3;
  for (let i = 0; i < dp.count; i++) {
    out.p.push(dp.getX(i), dp.getY(i), dp.getZ(i));
    const d = Math.hypot(dp.getX(i), dp.getZ(i) - cz0) / (14 * S);
    const k = Math.pow(Math.max(0, 1 - d), 1.5) * 0.24;
    out.c.push(k * 0.8, k * 0.95, k);
    out.m.push(0, 0, 0);
  }
  const di = disc.getIndex();
  if (di) for (let i = 0; i < di.count; i++) out.i.push(base0 + di.getX(i));
  disc.dispose();

  // 2. the spray column at the foot: four fanned pairs across the plunge, rising out of the churn (the temple hides the lowest part)
  const zFoot = sheetFront(0, 0, 0.97) * S;
  const footHw = fallHalfWidth(0.97, 1) * S;
  [-0.7, -0.25, 0.25, 0.7].forEach((fx, n) => mistPair(fx * footHw, -0.5, zFoot + 3 + 2.5 * (n % 2), 18 - 2 * (n % 2), 26 - 3 * (n % 2), 0.1, 0.45, tint, 2.6, out));

  // 3. ledge splashes (the upper ones show over the temple) and a veil at the brink
  [9, 13.5, 18, 22.5].forEach((ly, n) => {
    const t = fallT(ly);
    const side = n % 2 === 0 ? -1 : 1;
    mistPair(side * fallHalfWidth(t, side) * 0.55 * S, (ly - 0.5) * S, sheetFront(side * 2, ly, t) * S + 2.2, 11 + (n < 2 ? 3 : 0), n < 2 ? 10 : 8, 0.085, 0, tint, 1.2, out);
  });
  mistPair(0, (FALL_TOP - 1.2) * S, sheetFront(0, FALL_TOP, 0) * S + 2.4, 11, 7, 0.08, 0, tint, 0.8, out);

  // 4. the spray-bow, derived from SUN_DIR; aimed at the middle of the fall
  const midY = 14;
  const mid = toWorld(0, midY * S, sheetFront(0, midY, fallT(midY)) * S);
  sprayBow(toLocal, mid, out);

  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(out.p, 3));
  g.setAttribute('color', new Float32BufferAttribute(out.c, 3));
  g.setAttribute('aMist', new Float32BufferAttribute(out.m, 3));
  g.setIndex(out.i);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** The big backdrop waterfall: the sheet, and ONE additive spray mesh (disc, plume, ledge splashes, brink veil, spray-bow). Faces +Z like the cliff. */
export function createWaterfall(): Group {
  const fall = new Mesh(buildFallSheet(), waterfallMaterial);
  fall.name = 'WaterfallSheet';

  const mist = new Mesh(buildFallMist(), lightShaftMaterial);
  mist.name = 'Waterfall mist'; // the 'low' tier hides it (WaterSystem)
  mist.renderOrder = 3; // after the sheet and the water: the additive spray never sits under the translucent water

  const grp = new Group();
  grp.name = 'Waterfall';
  grp.add(fall, mist);
  return grp;
}

/** Small cascade that spills over the pool ledge. Origin = top of the spill, water falls toward +Z. */
export function createTrickle(): Mesh {
  const pts = [new Vector3(0, 0, 0), new Vector3(0, -0.5, 0.35), new Vector3(0, -1.5, 0.55), new Vector3(0, -2.0, 0.6)];
  const geo = mergeParts([
    { geo: tubeAlong(pts, (t) => 0.22 - 0.05 * t, 6, 8), color: '#cfe8e3' },
    { geo: tubeAlong([new Vector3(0.2, -0.2, 0.05), new Vector3(0.22, -1.2, 0.45), new Vector3(0.2, -1.9, 0.55)], () => 0.07, 4, 5), color: '#e6f4f1' },
  ]);
  const m = new Mesh(geo, waterfallMaterial);
  m.name = 'PoolTrickle';
  return m;
}

export { CLIFF };

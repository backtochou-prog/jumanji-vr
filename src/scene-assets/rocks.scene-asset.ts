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

export type RockKind = 'boulder' | 'slab' | 'standing' | 'cobble';
export const ROCK_VARIANTS: Record<RockKind, number> = { boulder: 2, slab: 1, standing: 1, cobble: 2 };

export function createRock(kind: RockKind, variant: number): Mesh {
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
  const notch = Math.exp(-(x * x) / 5.2) * smoothstep(CLIFF_H * 0.62, CLIFF_H * 0.78, y) * -3.6;
  const channel = Math.exp(-(x * x) / 2.2) * smoothstep(5, CLIFF_H * 0.76, y) * -1.1;
  return bay + strata + rough + notch + channel;
}

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

/** Big waterfall ribbon down the notch, with a mist disc at the base. Faces +Z like the cliff. */
export function createWaterfall(): Group {
  const segs = 14;
  const topY = CLIFF_H * 0.7;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const y = topY - t * (topY + 0.8);
    const w = 1.6 + 1.2 * t;
    const z = cliffZ(0, Math.max(0, y)) + 0.35 + 0.6 * t * t;
    positions.push(-w, y, z, w, y, z);
    uvs.push(0, t * 6, 1, t * 6);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  g.scale(SCALE.cliff, SCALE.cliff, SCALE.cliff);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  const fall = new Mesh(g, waterfallMaterial);
  fall.name = 'WaterfallSheet';

  const mistGeo = new CircleGeometry(9, 28);
  mistGeo.rotateX(-Math.PI / 2);
  const mp = mistGeo.getAttribute('position');
  const mc = new Float32Array(mp.count * 3);
  for (let i = 0; i < mp.count; i++) {
    const d = Math.hypot(mp.getX(i), mp.getZ(i)) / 9;
    const k = Math.pow(1 - d, 1.6) * 0.2;
    mc[i * 3] = k * 0.8;
    mc[i * 3 + 1] = k * 0.95;
    mc[i * 3 + 2] = k;
  }
  mistGeo.setAttribute('color', new Float32BufferAttribute(mc, 3));
  mistGeo.scale(SCALE.cliff, SCALE.cliff, SCALE.cliff);
  mistGeo.computeBoundingSphere();
  const mist = new Mesh(mistGeo, lightShaftMaterial);
  mist.position.set(0, 0.4 * SCALE.cliff, (cliffZ(0, 0) + 4) * SCALE.cliff);
  mist.name = 'WaterfallMist';

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

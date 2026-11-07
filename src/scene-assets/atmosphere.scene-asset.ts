/**
 * Cheap atmosphere: crossed additive light-shaft cards.
 * No volumetrics, no alpha textures: brightness is baked into vertex colours
 * and added to the scene. Unit shaft: base centred at the origin, 1 m wide,
 * rising 1 m along +Y; the scene scales and tilts it to match the sun.
 */
import { BufferGeometry, Float32BufferAttribute, Matrix4, Mesh, Quaternion, Vector3 } from '@iwsdk/core';
import { BAKED } from '../world/baked.js';
import { FORD, POOL, SPAWN, terrainHeight } from '../world/layout.js';
import { SUN_DIR } from '../world/palette.js';
import { mergeBaked } from './lib/geo.js';
import { lightShaftMaterial } from './lib/materials.js';

export function createLightShaft(): Mesh {
  // Trimmed to where the beam is actually visible: the soft cross-section fades to ~0 in the outer
  // 18 % of the width and the long fade is ~0 in the first and last 6 %. Alpha-free additive cards
  // still cost fill-rate for every fragment they cover, so the quad does not extend into the dark margins
  // (measured: shaft layers per pixel at the entrance 0.80 -> 0.55 with the same visible beam).
  const cols = 6;
  const rows = 7;
  const T0 = 0.06;
  const T1 = 0.94;
  const WIDTH = 0.82;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (let plane = 0; plane < 2; plane++) {
    const base = positions.length / 3;
    for (let j = 0; j <= rows; j++) {
      const t = T0 + (j / rows) * (T1 - T0);
      for (let i = 0; i <= cols; i++) {
        const u = (i / cols - 0.5) * WIDTH; // -0.41..0.41
        const across = Math.pow(Math.cos((u / WIDTH) * Math.PI), 1.45);
        const along = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.8)), 1.1);
        const k = across * along;
        const w = 1 + 0.35 * t;
        if (plane === 0) positions.push(u * w, t, 0);
        else positions.push(0, t, u * w);
        colors.push(0.1 * k, 0.088 * k, 0.052 * k);
      }
    }
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const a = base + j * (cols + 1) + i;
        indices.push(a, a + 1, a + cols + 1, a + 1, a + cols + 2, a + cols + 1);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  g.setIndex(indices);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  const m = new Mesh(g, lightShaftMaterial);
  m.name = 'LightShaft';
  m.renderOrder = 5;
  return m;
}

/**
 * Low ground mist: a flat soft disc (additive, vertex-colour falloff), unit radius.
 * Scaled and placed by the scene at the entrance, the stream and the clearing rim.
 */
export function createGroundMist(): Mesh {
  const seg = 24;
  const positions: number[] = [0, 0, 0];
  const colors: number[] = [0.12, 0.14, 0.13];
  const indices: number[] = [];
  for (let r = 1; r <= 3; r++) {
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      const rr = r / 3;
      positions.push(Math.cos(a) * rr, 0, Math.sin(a) * rr);
      const k = Math.pow(1 - rr, 1.4) * 0.12;
      colors.push(k, k * 1.1, k * 1.02);
    }
  }
  for (let s = 0; s < seg; s++) indices.push(0, 1 + s, 1 + ((s + 1) % seg));
  for (let r = 1; r < 3; r++) {
    for (let s = 0; s < seg; s++) {
      const a = 1 + (r - 1) * seg + s;
      const b = 1 + (r - 1) * seg + ((s + 1) % seg);
      const c = 1 + r * seg + s;
      const d = 1 + r * seg + ((s + 1) % seg);
      indices.push(a, c, b, b, c, d);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  g.setIndex(indices);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  const m = new Mesh(g, lightShaftMaterial);
  m.name = 'GroundMist';
  m.renderOrder = 4;
  return m;
}

/**
 * Every light shaft in ONE mesh. Each shaft sits in a measured canopy gap
 * (baked from the placement rules) and leans along -SUN_DIR, the sun's real
 * direction, so beams and shadows agree. Built in WORLD coordinates.
 */
export function createLightShafts(): Mesh {
  const unit = createLightShaft().geometry;
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(-SUN_DIR[0], -SUN_DIR[1], -SUN_DIR[2]));
  const items = BAKED.shafts.map(([x, z, w, len, strength]) => ({
    geo: unit,
    m: new Matrix4().compose(new Vector3(x, terrainHeight(x, z) + 0.1, z), q, new Vector3(w * strength, len, w * strength)),
  }));
  const m = new Mesh(mergeBaked(items), lightShaftMaterial);
  m.name = 'LightShafts';
  m.renderOrder = 5;
  return m;
}

/** Ground mist at the entrance, the ford, the pool and the clearing rim, in ONE mesh (world coordinates). */
export function createGroundMists(): Mesh {
  const unit = createGroundMist().geometry;
  const spots: [number, number, number][] = [
    [SPAWN[0] - 0.5, -6.5, 9],
    [FORD.x, FORD.z, 7],
    [POOL.x + 1.5, POOL.z, 7.5],
    [-1.5, -52, 10],
  ];
  const items = spots.map(([x, z, s]) => ({ geo: unit, m: new Matrix4().compose(new Vector3(x, terrainHeight(x, z) + 0.35, z), new Quaternion(), new Vector3(s, 1, s)) }));
  const m = new Mesh(mergeBaked(items), lightShaftMaterial);
  m.name = 'GroundMists';
  m.renderOrder = 4;
  return m;
}

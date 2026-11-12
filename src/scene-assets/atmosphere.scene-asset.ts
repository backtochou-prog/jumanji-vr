/**
 * Cheap atmosphere: crossed additive light-shaft cards.
 * No volumetrics, no alpha textures: brightness is baked into vertex colours
 * and added to the scene. Unit shaft: base centred at the origin, 1 m wide,
 * rising 1 m along +Y; the scene scales and tilts it to match the sun.
 * The material ('light-shaft-v2') makes them live in the vertex stage: world-phase breathing everywhere, tip drift from the `aSway` attribute
 * that mergeBaked(.., true) writes (0 at the base .. 1 at the top of each unit shaft).
 */
import { BufferGeometry, Float32BufferAttribute, Matrix4, Mesh, Quaternion, Vector3 } from '@iwsdk/core';
import { BAKED } from '../world/baked.js';
import { POOL, terrainHeight } from '../world/layout.js';
import { SUN_DIR } from '../world/palette.js';
import { mergeBaked } from './lib/geo.js';
import { lightShaftMaterial } from './lib/materials.js';

export function createLightShaft(cols = 6, rows = 7): Mesh {
  // Trimmed to where the beam is actually visible: the soft cross-section fades to ~0 in the outer
  // 18 % of the width and the long fade is ~0 in the first and last 6 %. Alpha-free additive cards
  // still cost fill-rate for every fragment they cover, so the quad does not extend into the dark margins
  // (measured: shaft layers per pixel at the entrance 0.80 -> 0.55 with the same visible beam).
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
        colors.push(0.108 * k, 0.085 * k, 0.045 * k); // golden-hour beam: a touch warmer than the old noon one, same total energy
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
export function createGroundMist(seg = 24, ringCount = 3): Mesh {
  const positions: number[] = [0, 0, 0];
  const colors: number[] = [0.12, 0.14, 0.13];
  const indices: number[] = [];
  for (let r = 1; r <= ringCount; r++) {
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      const rr = r / ringCount;
      positions.push(Math.cos(a) * rr, 0, Math.sin(a) * rr);
      const k = Math.pow(1 - rr, 1.4) * 0.12;
      colors.push(k, k * 1.1, k * 1.02);
    }
  }
  for (let s = 0; s < seg; s++) indices.push(0, 1 + s, 1 + ((s + 1) % seg));
  for (let r = 1; r < ringCount; r++) {
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
 * The baked list holds the trail shafts (strength 0.8-1: width factor) followed by the VISTA shafts (placements.vistaShafts: strength <= 0.5,
 * far, wide and long); the vista ones use a coarser unit shaft (4 x 6 cells, 96 triangles instead of 168) because they are seen from 25-60 m.
 */
export function createLightShafts(): Mesh {
  const near = createLightShaft().geometry;
  const far = createLightShaft(4, 6).geometry;
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(-SUN_DIR[0], -SUN_DIR[1], -SUN_DIR[2]));
  const items = BAKED.shafts.map(([x, z, w, len, strength]) => ({
    geo: strength <= 0.5 ? far : near,
    m: new Matrix4().compose(new Vector3(x, terrainHeight(x, z) + 0.1, z), q, new Vector3(w * strength, len, w * strength)),
  }));
  const m = new Mesh(mergeBaked(items, true), lightShaftMaterial);
  m.name = 'LightShafts';
  m.renderOrder = 5;
  return m;
}

/**
 * Mist banks: long, thin, flat ellipses lying across the valley floor below the knoll, so the hill looks down on a mist lake. [x, z, semi-axis along
 * the bank, semi-axis across, yaw (deg, 0 = along +X), lift above the highest ground under the bank (m)]. Peak colour <= 0.09.
 */
const MIST_BANKS: [number, number, number, number, number, number][] = [
  [-3, -8.5, 24, 4.5, 4, 0.7], // the gate throat
  [2, -19, 26, 4, -3, 0.8], // hill foot, pool and ford
  [-2, -30, 22, 4.2, 3, 1.2], // valley mist before the trail bends
  [3, -47, 24, 4.5, 0, 1.5], // between the root arch and the clearing
];

/** Distance (m) from the eye at which the ground mist reaches its full strength (see createGroundMists). */
const MIST_NEAR = 20;

/** Ground mist at the gate, the pool and the clearing rim (round discs) plus the valley mist banks, in ONE mesh (world coordinates). */
export function createGroundMists(): Mesh {
  const unit = createGroundMist().geometry;
  const spots: [number, number, number][] = [
    [-1.7, -6.5, 9],
    [POOL.x + 1.5, POOL.z, 7.5],
    [-1.5, -52, 10],
  ];
  // the round discs are DRAPED over the terrain (every vertex 0.35 m above the ground under it): a flat disc on sloping ground is cut by the terrain
  // in a hard straight line (the gate disc reaches up the knoll ramp)
  const items: { geo: BufferGeometry; m?: Matrix4; tint?: [number, number, number] }[] = spots.map(([x, z, s]) => {
    const geo = unit.clone();
    const pos = geo.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const wx = x + pos.getX(i) * s;
      const wz = z + pos.getZ(i) * s;
      pos.setXYZ(i, wx, terrainHeight(wx, wz) + 0.35, wz);
    }
    return { geo };
  });
  // the banks use a coarse unit disc (16 x 2 = 48 triangles) and a faint warm tint: the low sun gilds them
  const bankUnit = createGroundMist(16, 2).geometry;
  const up = new Vector3(0, 1, 0);
  for (const [x, z, a, b, yawDeg, lift] of MIST_BANKS) {
    const yaw = (yawDeg * Math.PI) / 180;
    // a flat disc must clear the highest ground under it (the ramp falls away to the north), otherwise terrain would slice a hard line through it
    let top = -Infinity;
    for (let i = -4; i <= 4; i++) {
      for (const j of [-1, 0, 1]) {
        const lx = (i / 4) * a;
        const lz = j * b;
        top = Math.max(top, terrainHeight(x + Math.cos(yaw) * lx + Math.sin(yaw) * lz, z - Math.sin(yaw) * lx + Math.cos(yaw) * lz));
      }
    }
    items.push({
      geo: bankUnit,
      m: new Matrix4().compose(new Vector3(x, top + lift, z), new Quaternion().setFromAxisAngle(up, yaw), new Vector3(a, 1, b)),
      tint: [0.7, 0.62, 0.5],
    });
  }
  const merged = mergeBaked(items);
  // near fade (lightShaftMaterial's optional aNear): full strength from MIST_NEAR metres, gone at 0.45 x that. Seen from the knoll the mist lies in
  // the valley; walked into, it thins out around the player instead of becoming a milky sheet at knee height that crosses the eye line on the ramp.
  merged.setAttribute('aNear', new Float32BufferAttribute(new Float32Array(merged.getAttribute('position').count).fill(MIST_NEAR), 1));
  const m = new Mesh(merged, lightShaftMaterial);
  m.name = 'GroundMists';
  m.renderOrder = 4;
  return m;
}

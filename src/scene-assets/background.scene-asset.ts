/**
 * Background depth: layered jungle ridge silhouettes ringing the world.
 *
 * Three rings (80 / 100 / 120 m from the middle of the walkable area), each a
 * 2-sided vertical strip with a jagged tree-line top. Vertex colour fades from
 * deep green (near) to the fog tint (far) so the layers separate through
 * atmospheric perspective: the classic painted-backdrop depth cue, for under
 * 1500 triangles and three draw calls. Unlit (basic material), fogged.
 */
import { BufferGeometry, Color, Float32BufferAttribute, Mesh } from '@iwsdk/core';
import { fbm, makeRandom } from '../world/layout.js';
import { FOG_COLOR, PAL } from '../world/palette.js';
import { silhouetteMaterial } from './lib/materials.js';

export const RIDGE_CENTER = { x: 0, z: -35 };
export const RIDGE_RINGS = [
  { r: 84, h: 26, mix: 0.46, seed: 1 },
  { r: 102, h: 34, mix: 0.68, seed: 2 },
  { r: 120, h: 44, mix: 0.86, seed: 3 },
];

export function createRidge(layer: number): Mesh {
  const L = RIDGE_RINGS[layer];
  const cols = 220;
  const rng = makeRandom(900 + layer);
  const deep = new Color(PAL.leafDeep).lerp(new Color(PAL.leafShade), 0.35);
  const fog = new Color(FOG_COLOR);
  const base = deep.clone().lerp(fog, L.mix);
  const top = new Color(PAL.leafMid).lerp(fog, L.mix + 0.04);
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const phases = [rng() * 6.28, rng() * 6.28, rng() * 6.28];
  for (let i = 0; i <= cols; i++) {
    const a = (i / cols) * Math.PI * 2;
    // Rolling hills + individual crowns (sharp tops) + broken tree-line.
    const hill = fbm(Math.cos(a) * 3 + L.seed * 7, Math.sin(a) * 3, 60 + L.seed, 3);
    const crowns = Math.pow(Math.abs(Math.sin(a * 53 + phases[0]) * Math.sin(a * 29 + phases[1])), 0.6) * 0.28 + 0.12 * Math.abs(Math.sin(a * 97 + phases[2]));
    const h = L.h * (0.55 + 0.75 * hill) * (1 + crowns * 0.5);
    const x = RIDGE_CENTER.x + Math.cos(a) * L.r;
    const z = RIDGE_CENTER.z + Math.sin(a) * L.r;
    positions.push(x, -14, z, x, h, z);
    colors.push(base.r, base.g, base.b, top.r, top.g, top.b);
  }
  for (let i = 0; i < cols; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  g.setIndex(indices);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  const m = new Mesh(g, silhouetteMaterial);
  m.name = `Ridge_${layer}`;
  m.frustumCulled = false; // ring: always partly in view; 3 draws total
  return m;
}

/**
 * Water: pool, shallow stream and muddy puddles.
 *
 * Cheap but readable on Quest 2:
 *   - vertex colour RGBA: clear shallows at the rim, deeper teal in the middle,
 *     alpha fading to zero at the waterline so there is no hard edge;
 *   - the ripple BUMP texture scrolls (WaterSystem) so the sun glint moves;
 *   - the stream ribbon follows the carved channel and the monotone water
 *     profile from layout.ts (water always flows downhill, level at the ford);
 *   - a fresnel sky tint in the material fakes reflection (no extra pass).
 */
import { BufferGeometry, Color, Float32BufferAttribute, Mesh } from '@iwsdk/core';
import { MUD_PATCHES, POOL, STREAM_SAMPLES, fbm, streamWaterY, terrainHeight } from '../world/layout.js';
import { PAL } from '../world/palette.js';
import { mat, mergeBaked } from './lib/geo.js';
import { waterMaterial } from './lib/materials.js';

const SHALLOW = new Color(PAL.waterShallow).lerp(new Color(PAL.mud), 0.25);
const DEEP = new Color(PAL.waterDeep).lerp(new Color('#0f2d2a'), 0.35);

function finish(positions: number[], colors: number[], uvs: number[], indices: number[], name: string): Mesh {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new Float32BufferAttribute(colors, 4));
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  // Ensure normals face up.
  if (g.getAttribute('normal').getY(0) < 0) {
    for (let i = 0; i < indices.length; i += 3) {
      const t = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = t;
    }
    g.setIndex(indices);
    g.computeVertexNormals();
  }
  g.computeBoundingBox();
  g.computeBoundingSphere();
  const m = new Mesh(g, waterMaterial);
  m.name = name;
  m.renderOrder = 2;
  return m;
}

/** Pool surface: irregular shoreline, shallow rim fading out, deeper centre. Origin at the pool centre, y = 0. */
export function createPoolWater(): Mesh {
  const rings = 6;
  const seg = 40;
  const R = POOL.r * 1.16;
  const positions: number[] = [0, 0, 0];
  const colors: number[] = [DEEP.r, DEEP.g, DEEP.b, 0.82];
  const uvs: number[] = [0, 0];
  const indices: number[] = [];
  const c = new Color();
  for (let r = 1; r <= rings; r++) {
    const d = r / rings;
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      const k = 1 + 0.06 * Math.sin(a * 3 + 1.3) + 0.045 * Math.sin(a * 5 + 0.4) + 0.03 * (fbm(Math.cos(a) * 2, Math.sin(a) * 2, 5, 2) - 0.5);
      const x = Math.cos(a) * R * d * k;
      const z = Math.sin(a) * R * d * k;
      positions.push(x, 0, z);
      uvs.push(x / 3, z / 3);
      c.copy(DEEP).lerp(SHALLOW, Math.pow(d, 1.6));
      colors.push(c.r, c.g, c.b, d > 0.82 ? 0.82 * (1 - (d - 0.82) / 0.18) : 0.82);
    }
  }
  for (let s = 0; s < seg; s++) indices.push(0, 1 + s, 1 + ((s + 1) % seg));
  for (let r = 1; r < rings; r++) {
    for (let s = 0; s < seg; s++) {
      const a = 1 + (r - 1) * seg + s;
      const b = 1 + (r - 1) * seg + ((s + 1) % seg);
      const c2 = 1 + r * seg + s;
      const d2 = 1 + r * seg + ((s + 1) % seg);
      indices.push(a, c2, b, b, c2, d2);
    }
  }
  return finish(positions, colors, uvs, indices, 'PoolWater');
}

/** Stream ribbon: from the pool outlet, across the ford and away. Built in WORLD coordinates (node at origin). */
export function createStream(): Mesh {
  const cols = 7;
  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const c = new Color();
  // Skip samples that lie inside the pool; start at the first one outside it.
  let start = 0;
  while (start < STREAM_SAMPLES.length && Math.hypot(STREAM_SAMPLES[start][0] - POOL.x, STREAM_SAMPLES[start][1] - POOL.z) <= POOL.r * 1.1) start++;
  start = Math.max(0, start - 1);
  let run = 0;
  let rows = 0;
  for (let i = start; i < STREAM_SAMPLES.length; i++) {
    const [px, pz] = STREAM_SAMPLES[i];
    const [nx, nz] = STREAM_SAMPLES[Math.min(STREAM_SAMPLES.length - 1, i + 1)];
    const [bx, bz] = STREAM_SAMPLES[Math.max(0, i - 1)];
    const tx = nx - bx;
    const tz = nz - bz;
    const tl = Math.hypot(tx, tz) || 1;
    const sx = -tz / tl;
    const sz = tx / tl;
    const y = streamWaterY(i);
    // The stream widens gently downstream and into the ford, narrows over the stepping stones.
    const hw = 1.0 + 0.35 * Math.sin(i * 0.31) + 0.25 * fbm(px * 0.3, pz * 0.3, 41, 2);
    if (i > start) run += Math.hypot(px - STREAM_SAMPLES[i - 1][0], pz - STREAM_SAMPLES[i - 1][1]);
    for (let j = 0; j < cols; j++) {
      const u = (j / (cols - 1)) * 2 - 1;
      positions.push(px + sx * u * hw * 1.45, y, pz + sz * u * hw * 1.45);
      uvs.push(u * 0.5 + 0.5, run * 0.28);
      const e = Math.abs(u);
      c.copy(DEEP).lerp(SHALLOW, e * e);
      // Clear shallows at the banks, solid in the middle; the last 25 % fades out into the bank.
      colors.push(c.r, c.g, c.b, e > 0.6 ? Math.max(0, 0.78 * (1 - (e - 0.6) / 0.4)) : 0.78);
    }
    rows++;
  }
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j;
      indices.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1);
    }
  }
  return finish(positions, colors, uvs, indices, 'StreamWater');
}

/** Muddy puddles on the trail: small flat discs just above the ground. WORLD coordinates. */
export function createPuddles(): Mesh {
  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const c = new Color(PAL.waterDeep).lerp(new Color(PAL.mud), 0.55);
  for (const m of MUD_PATCHES) {
    const r = m.r * 0.5;
    const cy = terrainHeight(m.x, m.z) + 0.092; // just above the trail ribbon (7.5 cm)
    const base = positions.length / 3;
    positions.push(m.x, cy, m.z);
    colors.push(c.r, c.g, c.b, 0.85);
    uvs.push(m.x, m.z);
    for (let s = 0; s < 14; s++) {
      const a = (s / 14) * Math.PI * 2;
      const rr = r * (0.8 + 0.4 * fbm(m.x + Math.cos(a) * 2, m.z + Math.sin(a) * 2, 9, 2));
      const x = m.x + Math.cos(a) * rr;
      const z = m.z + Math.sin(a) * rr * 0.7;
      positions.push(x, terrainHeight(x, z) + 0.092, z);
      colors.push(c.r, c.g, c.b, 0.0);
      uvs.push(x, z);
    }
    for (let s = 0; s < 14; s++) indices.push(base, base + 1 + s, base + 1 + ((s + 1) % 14));
  }
  return finish(positions, colors, uvs, indices, 'Puddles');
}


/**
 * All water in ONE mesh (one draw call): pool, stream, puddles. They share the
 * material, hence the scrolling ripple texture. Built in WORLD coordinates.
 */
export function createWater(): Mesh {
  const pool = createPoolWater();
  const geo = mergeBaked([
    { geo: pool.geometry, m: mat(POOL.x, POOL.waterY, POOL.z) },
    { geo: createStream().geometry },
    { geo: createPuddles().geometry },
  ]);
  const m = new Mesh(geo, waterMaterial);
  m.name = 'Water';
  m.renderOrder = 2;
  return m;
}

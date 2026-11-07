/**
 * The Ancient Clearing's overgrown temple and the destination spire.
 *
 * Original design: a three-tier stepped platform, a broken back wall with an
 * arched doorway under a large sun-disc relief (the same motif as the
 * Heartstone: a disc ringed by twelve ticks), standing columns, rubble.
 * The structure is stone (ruin material); the OVERGROWTH is a second mesh
 * on the shared foliage-card material: roots draping the wall, lianas, ferns
 * on the steps, moss mats on ledges, shrubs growing from the broken top.
 *
 * Local frame: origin on the ground at the structure centre, the front faces +Z
 * (toward the clearing and the approaching player). Not walkable: the platform
 * is solid (see colliders); the player stays on the ground around it.
 */
import { CylinderGeometry, Mesh, Vector3 } from '@iwsdk/core';
import { TEMPLE, makeRandom } from '../world/layout.js';
import { PAL } from '../world/palette.js';
import { cardGeometry, lerpColor, mat, mergeParts, softNormals, solidUV, tubeAlong } from './lib/geo.js';
import type { Part } from './lib/geo.js';
import { foliageCardMaterial, ruinStoneMaterial } from './lib/materials.js';
import { bevelBox, masonry, stoneColor } from './ruins.scene-asset.js';

/** Tier table: [width, depth, height, z-offset]. */
const TIERS: [number, number, number, number][] = [
  [TEMPLE.width, TEMPLE.depth, 0.5, 0],
  [TEMPLE.width - 2.6, TEMPLE.depth - 1.9, 0.5, -0.55],
  [TEMPLE.width - 5.2, TEMPLE.depth - 3.8, 0.45, -1.1],
];
export const TEMPLE_TOP_Y = 0.5 + 0.5 + 0.45;
const WALL_Z = -TEMPLE.depth / 2 + 0.9;
const LEFT_W = 3.4;
const RIGHT_W = 3.2;
const GAP = 2.4;
const WALL_X0 = -GAP / 2 - LEFT_W / 2;
const WALL_X1 = GAP / 2 + RIGHT_W / 2;
const COLS = [
  { x: -3.5, z: 1.2, h: 3.6, broken: false },
  { x: 3.5, z: 1.2, h: 2.6, broken: true },
  { x: -3.6, z: -1.6, h: 2.2, broken: true },
  { x: 3.6, z: -1.6, h: 3.4, broken: false },
];

/** Solid boxes (local frame, centre + size) for the collision proxy: platform, wall sections, columns. */
export function templeSolids(): { x: number; y: number; z: number; w: number; h: number; d: number }[] {
  const out: { x: number; y: number; z: number; w: number; h: number; d: number }[] = [{ x: 0, y: TEMPLE_TOP_Y / 2, z: 0, w: TEMPLE.width, h: TEMPLE_TOP_Y, d: TEMPLE.depth }];
  out.push({ x: WALL_X0, y: TEMPLE_TOP_Y + 2.8, z: WALL_Z, w: LEFT_W, h: 5.6, d: 1.0 });
  out.push({ x: WALL_X1, y: TEMPLE_TOP_Y + 1.7, z: WALL_Z, w: RIGHT_W, h: 3.4, d: 1.0 });
  for (const c of COLS) out.push({ x: c.x, y: TEMPLE_TOP_Y + c.h / 2, z: c.z, w: 0.9, h: c.h, d: 0.9 });
  return out;
}

function fluted(radius: number, height: number, seed: number, broken: boolean): Part[] {
  const g = new CylinderGeometry(radius * 0.86, radius, height, 12, 3, false);
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const a = Math.atan2(pos.getZ(i), pos.getX(i));
    const k = 1 - 0.04 * Math.pow(Math.abs(Math.sin(a * 6)), 0.5);
    pos.setX(i, pos.getX(i) * k);
    pos.setZ(i, pos.getZ(i) * k);
    if (broken && pos.getY(i) > height * 0.5 - 0.02) pos.setY(i, pos.getY(i) - 0.5 * (0.5 + 0.5 * Math.sin(a * 2 + seed)));
  }
  g.computeVertexNormals();
  const parts: Part[] = [{ geo: g, m: mat(0, height / 2, 0), color: stoneColor(seed) }];
  parts.push({ geo: bevelBox(radius * 2.5, 0.22, radius * 2.5, 0.04), m: mat(0, 0.11, 0), color: stoneColor(seed + 1) });
  if (!broken) parts.push({ geo: bevelBox(radius * 2.4, 0.2, radius * 2.4, 0.04), m: mat(0, height + 0.1, 0), color: stoneColor(seed + 2) });
  return parts;
}

/** The stone structure. */
export function createTemple(): Mesh {
  const rng = makeRandom(1234);
  const parts: Part[] = [];
  // Tiers.
  let y = 0;
  TIERS.forEach(([w, d, h, zo], i) => {
    parts.push({ geo: bevelBox(w, h, d, 0.06), m: mat(0, y + h / 2 - 0.02, zo, 0, (rng() - 0.5) * 0.03), color: masonry(10 + i, 0.55, 0.5, 14) });
    y += h;
  });
  const top = TEMPLE_TOP_Y;
  // Back wall: left tall broken section, right shorter, arched doorway between.
  const leftW = LEFT_W;
  const rightW = RIGHT_W;
  const gap = GAP;
  const wallX0 = WALL_X0;
  const wallX1 = WALL_X1;
  const courses = (x: number, w: number, h: number, seed: number) => {
    // Ashlar: each course is 2-4 blocks of different length with a small joint gap; the top course is ragged.
    const ch = 0.7;
    const n = Math.floor(h / ch);
    // Dark backing slab: the mortar gaps between blocks read as deep joints, not holes.
    parts.push({ geo: bevelBox(w - 0.1, Math.max(0.6, n * ch - 0.3), 0.7, 0.04, 1), m: mat(x, top + (n * ch - 0.3) / 2, WALL_Z), color: () => lerpColor(PAL.ruinDark, '#242723', 0.6) });
    for (let c = 0; c < n; c++) {
      const topCourse = c === n - 1;
      const count = 3 + Math.floor(rng() * 3);
      const cuts: number[] = [0];
      for (let i = 1; i < count; i++) cuts.push(i / count + (rng() - 0.5) * 0.18 + (c % 2 ? 0.12 : -0.08));
      cuts.push(1);
      cuts.sort((p, q) => p - q);
      for (let i = 0; i < cuts.length - 1; i++) {
        if (topCourse && rng() < 0.4) continue; // missing stones on the broken top
        const w0 = Math.max(0.35, (cuts[i + 1] - cuts[i]) * w - 0.05);
        const cx = x - w / 2 + (cuts[i] + cuts[i + 1]) * 0.5 * w;
        const hh = ch - 0.05 - (topCourse ? rng() * 0.28 : 0);
        parts.push({ geo: bevelBox(w0, hh, 0.9, 0.045, 1), m: mat(cx, top + c * ch + hh / 2, WALL_Z + (rng() - 0.5) * 0.05, 0, (rng() - 0.5) * 0.02, 0), color: stoneColor(seed + c * 7 + i, 0.3 + (topCourse ? 0.5 : 0)) });
      }
    }
  };
  courses(wallX0, leftW, 5.6, 40);
  courses(wallX1, rightW, 3.4, 60);
  // Arch over the doorway: wedge blocks around a semicircle.
  const archR = gap / 2 + 0.15;
  const archY = top + 2.5;
  for (let i = 0; i < 9; i++) {
    const a = Math.PI * (i / 8);
    const px = -Math.cos(a) * (archR + 0.28);
    const py = Math.sin(a) * (archR + 0.28);
    parts.push({ geo: bevelBox(0.72, 0.6, 0.9, 0.05, 1), m: mat(px, archY + py, WALL_Z, 0, 0, a - Math.PI / 2), color: stoneColor(80 + i, 0.9) });
  }
  // Door jambs.
  for (const sx of [-1, 1]) parts.push({ geo: bevelBox(0.5, 2.6, 0.9, 0.05, 1), m: mat(sx * (gap / 2 + 0.2), top + 1.3, WALL_Z), color: stoneColor(90 + sx, 0.8) });
  // The sun-disc relief above the doorway: a disc ringed by twelve ticks (echoes the Heartstone).
  const discY = archY + archR + 1.35;
  parts.push({ geo: new CylinderGeometry(0.85, 0.85, 0.18, 24), m: mat(0, discY, WALL_Z + 0.5, Math.PI / 2, 0, 0), color: stoneColor(120, 0.5) });
  parts.push({ geo: new CylinderGeometry(0.45, 0.45, 0.24, 20), m: mat(0, discY, WALL_Z + 0.52, Math.PI / 2, 0, 0), color: () => lerpColor(PAL.ruinDark, PAL.stoneDark, 0.5) });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    parts.push({ geo: bevelBox(0.14, 0.38, 0.14, 0.02, 1), m: mat(Math.cos(a) * 1.18, discY + Math.sin(a) * 1.18, WALL_Z + 0.5, 0, 0, a + Math.PI / 2), color: stoneColor(130 + i, 0.4) });
  }
  // Side walls: low, broken.
  for (const sx of [-1, 1]) {
    for (let c = 0; c < 3; c++) parts.push({ geo: bevelBox(0.9, 0.6, 3.2 * (c === 2 ? 0.55 : 1), 0.05, 1), m: mat(sx * (TIERS[2][0] / 2 - 0.45), top + c * 0.62 + 0.3, -0.6 - (c === 2 ? 0.7 : 0)), color: stoneColor(150 + sx + c, 0.95) });
  }
  // Four columns on the top tier, two broken.
  COLS.forEach((c, i) => {
    for (const p of fluted(0.42, c.h, 170 + i, c.broken)) parts.push({ ...p, m: mat(c.x, top, c.z).multiply(p.m ?? mat()) });
  });
  // Fallen drum and lintel on the steps/ground in front.
  parts.push({ geo: new CylinderGeometry(0.42, 0.42, 1.1, 12), m: mat(-2.0, 0.42, TEMPLE.depth / 2 + 0.9, 0, 0, Math.PI / 2).multiply(mat(0, 0, 0)), color: stoneColor(200, 0.9) });
  parts.push({ geo: bevelBox(2.4, 0.5, 0.7, 0.06, 1), m: mat(2.3, 0.18, TEMPLE.depth / 2 + 1.1, 0.05, 0.4, 0.08), color: stoneColor(201, 0.95) });
  const m = new Mesh(mergeParts(parts), ruinStoneMaterial);
  m.name = 'Temple';
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Plants, roots and lianas taking the structure back. Foliage-card material, same local frame. */
export function createTempleGrowth(): Mesh {
  const rng = makeRandom(4321);
  const parts: Part[] = [];
  const top = TEMPLE_TOP_Y;
  const lo = lerpColor(PAL.leafShade, PAL.leafMid, 0.4);
  const hi = lerpColor(PAL.leafLight, PAL.leafSun, 0.3);
  const up = new Vector3(0, 1, 0);
  const rootColor = () => lerpColor(PAL.barkDark, PAL.bark, 0.3 + 0.4 * rng());
  // Roots pouring over the wall top and down the front of the tiers.
  for (let i = 0; i < 6; i++) {
    const x = -4.6 + i * 1.8 + (rng() - 0.5) * 0.8;
    const h = 3 + rng() * 2.4;
    const pts = [new Vector3(x, top + h, WALL_Z - 0.25), new Vector3(x + 0.3, top + h * 0.6, WALL_Z + 0.5), new Vector3(x - 0.2, top + h * 0.25, WALL_Z + 0.65), new Vector3(x + 0.4, top - 0.1, WALL_Z + 0.9 + rng() * 0.6)];
    parts.push({ geo: solidUV(tubeAlong(pts, (t) => 0.2 * (1 - 0.7 * t), 6, 8)), color: rootColor });
  }
  // Lianas hanging from the doorway arch and the wall edge.
  for (let i = 0; i < 16; i++) {
    const x = -4.8 + rng() * 9.6;
    const y0 = top + 2.8 + rng() * 2.4;
    const drop = 1.5 + rng() * 3;
    const pts = [new Vector3(x, y0, WALL_Z + 0.55), new Vector3(x + 0.05, y0 - drop * 0.35, WALL_Z + 0.62), new Vector3(x - 0.1, y0 - drop * 0.7, WALL_Z + 0.6), new Vector3(x, y0 - drop, WALL_Z + 0.58)];
    parts.push({ geo: solidUV(tubeAlong(pts, (t) => 0.03 * (1 - 0.4 * t), 3, 6)), color: () => lerpColor('#27401c', '#46622a', rng()) });
    parts.push({ geo: cardGeometry('vine', 1.2 + rng() * 0.9, 0.6, 0.15, 2), m: mat(x, y0 - drop - 0.6, WALL_Z + 0.6, 0, (rng() - 0.5) * 0.5, 0), color: () => lerpColor(PAL.leafMid, PAL.leafLight, rng()) });
  }
  // Shrubs and ferns growing from the broken wall top and ledges.
  for (let i = 0; i < 9; i++) {
    const x = -4.8 + rng() * 9.6;
    const y = x < -1.2 ? top + 5.6 : x > 1.2 ? top + 3.4 : top + 5.0;
    const s = 1.0 + rng() * 0.8;
    parts.push({ geo: cardGeometry('clump', s, s, 0, 1), m: mat(x, y + 0.1, WALL_Z + (rng() - 0.5) * 0.3, -0.9 + rng() * 0.3, rng() * 6, 0).multiply(mat(0, -s / 2, 0)), normalFn: softNormals(new Vector3(x, y - 0.4, WALL_Z), 0.5), color: () => lerpColor(lo, hi, rng()) });
  }
  for (let t = 0; t < TIERS.length; t++) {
    const [w, d, , zo] = TIERS[t];
    const yTop = [0.5, 1.0, TEMPLE_TOP_Y][t];
    for (let i = 0; i < 7; i++) {
      const x = (rng() - 0.5) * w * 0.92;
      const z = zo + (rng() > 0.5 ? 1 : -1) * (d / 2 - 0.25 - rng() * 0.4) * (rng() > 0.3 ? 1 : 0.4);
      const L = 0.55 + rng() * 0.45;
      for (let k = 0; k < 6; k++) {
        parts.push({ geo: cardGeometry('fern', L, L * 0.44, 1.0 + rng() * 0.5, 2), m: mat(x, yTop - 0.03, z, 0.4 + 0.9 * (k / 6), k * 2.4 + i, 0), normalFn: softNormals(new Vector3(x, yTop - 0.4, z), 0.7), color: () => lerpColor(lo, hi, 0.2 + 0.6 * rng()) });
      }
    }
    for (let i = 0; i < 5; i++) {
      const x = (rng() - 0.5) * w * 0.9;
      const z = zo + (rng() - 0.5) * d * 0.8;
      const s = 0.8 + rng() * 0.6;
      parts.push({ geo: cardGeometry('moss', s, s, 0, 1), m: mat(x, yTop + 0.012 * i, z, -Math.PI / 2, rng() * 6, 0).multiply(mat(0, -s / 2, 0)), normalFn: () => up.clone(), color: () => lerpColor(PAL.mossDeep, PAL.moss, 0.4 + 0.5 * rng()) });
    }
  }
  const m = new Mesh(mergeParts(parts), foliageCardMaterial);
  m.name = 'TempleGrowth';
  return m;
}

// ---------------------------------------------------------------------------
// Spire
// ---------------------------------------------------------------------------

/** A ruined tower, 24 m: octagonal drums with window slits, snapped top, leaning a few degrees. */
export function createSpire(height = 24): Mesh {
  const rng = makeRandom(555);
  const parts: Part[] = [];
  const tiers = 5;
  let y = 0;
  for (let i = 0; i < tiers; i++) {
    const h = i === tiers - 1 ? height * 0.14 : height * 0.215;
    const r0 = 2.7 - i * 0.36;
    const r1 = r0 - 0.3;
    const g = new CylinderGeometry(r1, r0, h, 8, 2, false);
    const lean = i * 0.012;
    parts.push({ geo: g, m: mat(Math.sin(y * 0.02) * 0.3 + y * lean * 0.3, y + h / 2, 0, 0, i * 0.2, 0), color: masonry(300 + i, 0.4, 0.62, 12) });
    // Cornice ring between tiers.
    parts.push({ geo: new CylinderGeometry(r1 + 0.22, r1 + 0.22, 0.28, 8), m: mat(Math.sin(y * 0.02) * 0.3 + (y + h) * lean * 0.3, y + h, 0, 0, i * 0.2, 0), color: stoneColor(310 + i, 0.6) });
    // Window slits.
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + i * 0.4;
      const rr = (r0 + r1) / 2 + 0.02;
      parts.push({ geo: bevelBox(0.34, 1.4, 0.3, 0.04, 1), m: mat(Math.cos(a) * rr + Math.sin(y * 0.02) * 0.3 + (y + h / 2) * lean * 0.3, y + h * 0.5, Math.sin(a) * rr, 0, -a + Math.PI / 2, 0), color: () => lerpColor(PAL.ruinDark, '#1b1d1a', 0.6) });
    }
    y += h;
  }
  // Snapped crown: a few jagged blocks.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    parts.push({ geo: bevelBox(0.9, 0.7 + rng() * 0.9, 0.7, 0.05, 1), m: mat(Math.cos(a) * 0.95, y + 0.3, Math.sin(a) * 0.95, 0, -a, 0), color: stoneColor(330 + i, 0.9) });
  }
  const m = new Mesh(mergeParts(parts), ruinStoneMaterial);
  m.name = 'Spire';
  m.castShadow = true;
  return m;
}

/** Vines and moss-draped shrubs on the spire (foliage-card material). */
export function createSpireGrowth(height = 24): Mesh {
  const rng = makeRandom(556);
  const parts: Part[] = [];
  const lo = lerpColor(PAL.leafShade, PAL.leafMid, 0.4);
  const hi = lerpColor(PAL.leafLight, PAL.leafSun, 0.3);
  for (let i = 0; i < 6; i++) {
    const a = rng() * Math.PI * 2;
    const y0 = height * (0.35 + 0.6 * rng());
    const r = 2.5 - (y0 / height) * 1.4;
    const drop = 3 + rng() * 6;
    const pts = [new Vector3(Math.cos(a) * r, y0, Math.sin(a) * r), new Vector3(Math.cos(a) * (r + 0.1), y0 - drop * 0.4, Math.sin(a) * (r + 0.1)), new Vector3(Math.cos(a + 0.05) * (r + 0.12), y0 - drop * 0.75, Math.sin(a + 0.05) * (r + 0.12)), new Vector3(Math.cos(a) * (r + 0.4), y0 - drop, Math.sin(a) * (r + 0.4))];
    parts.push({ geo: solidUV(tubeAlong(pts, (t) => 0.05 * (1 - 0.4 * t), 4, 7)), color: () => lerpColor('#27401c', '#46622a', rng()) });
    parts.push({ geo: cardGeometry('vine', 1.6, 0.8, 0.1, 2), m: mat(pts[3].x, pts[3].y - 0.8, pts[3].z, 0, -a + Math.PI / 2, 0), color: () => lerpColor(PAL.leafMid, PAL.leafLight, rng()) });
  }
  // A shrub crowning the broken top.
  for (let i = 0; i < 4; i++) {
    const s = 1.6 + rng() * 0.8;
    parts.push({ geo: cardGeometry('clump', s, s, 0, 1), m: mat((rng() - 0.5) * 1.2, height + 0.1, (rng() - 0.5) * 1.2, -0.7, rng() * 6, 0).multiply(mat(0, -s / 2, 0)), normalFn: softNormals(new Vector3(0, height - 0.6, 0), 0.5), color: () => lerpColor(lo, hi, rng()) });
  }
  const m = new Mesh(mergeParts(parts), foliageCardMaterial);
  m.name = 'SpireGrowth';
  return m;
}

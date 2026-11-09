/**
 * Ancient stonework: the altar that carries the Heartstone, broken pillars,
 * and the Heartstone itself (the grabbable relic).
 *
 * All original design: a sun-disc talisman with twelve glyph grooves around a
 * glowing amber heart, resting in a worn recess on a moss-eaten altar.
 */
import { BoxGeometry, BufferGeometry, CylinderGeometry, Color, Group, IcosahedronGeometry, LatheGeometry, Mesh, Vector2, Vector3 } from '@iwsdk/core';
import { ALTAR_TOP_Y, PILLARS, SCALE, fbm, makeRandom, smoothstep, terrainHeight } from '../world/layout.js';
import { PAL } from '../world/palette.js';
import type { Part } from './lib/geo.js';
import { displace, lerpColor, mat, mergeBaked, mergeParts, tubeAlong } from './lib/geo.js';
import { relicGemMaterial, relicGlyphMaterial, relicStoneMaterial, ruinStoneMaterial } from './lib/materials.js';

const SAND = new Color(PAL.ruin);
const SAND_DARK = new Color(PAL.ruinDark);
const MOSS = new Color(PAL.moss);

/** Rounded box with analytic normals (no seams at the rounded edges). */
export function bevelBox(w: number, h: number, d: number, b = 0.02, seg = 2): BufferGeometry {
  const g = new BoxGeometry(w, h, d, seg * 2, seg * 2, seg * 2);
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const half = new Vector3(w / 2 - b, h / 2 - b, d / 2 - b);
  const p = new Vector3();
  const c = new Vector3();
  const dir = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    c.set(Math.max(-half.x, Math.min(half.x, p.x)), Math.max(-half.y, Math.min(half.y, p.y)), Math.max(-half.z, Math.min(half.z, p.z)));
    dir.copy(p).sub(c);
    if (dir.lengthSq() > 1e-10) {
      dir.normalize();
      p.copy(c).addScaledVector(dir, b);
      nor.setXYZ(i, dir.x, dir.y, dir.z);
    }
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  return g;
}

export function stoneColor(seed: number, moss = 0.7) {
  const out = new Color();
  return (p: Vector3, n: Vector3): Color => {
    const g = fbm(p.x * 5 + seed, p.z * 5 + p.y * 3, seed, 3);
    out.copy(SAND_DARK).lerp(SAND, smoothstep(0.25, 0.8, g));
    const m = Math.min(1, (smoothstep(0.2, 0.7, n.y) * 0.9 + smoothstep(0.6, 0.78, fbm(p.x * 4, p.y * 6 + p.z * 4, seed + 3, 2)) * 0.6) * moss * (0.7 + 0.5 * (1 - smoothstep(0.2, 1.4, p.y))));
    out.lerp(MOSS, m);
    out.multiplyScalar(0.55 + 0.45 * smoothstep(-0.05, 0.45, p.y));
    return out;
  };
}

/**
 * Cut-stone colour: horizontal course lines and staggered vertical joints (by angle around the Y axis,
 * for towers and drums), moss only on upward faces. Reads as masonry instead of banded cylinders.
 */
export function masonry(seed: number, moss = 0.3, courseH = 0.62, around = 10) {
  const base = stoneColor(seed, moss);
  const out = new Color();
  return (p: Vector3, n: Vector3): Color => {
    out.copy(base(p, n));
    const cy = p.y / courseH;
    const course = Math.floor(cy);
    const fy = cy - course;
    const a = (Math.atan2(p.z, p.x) / (Math.PI * 2)) * around + (course % 2) * 0.5;
    const fa = a - Math.floor(a);
    const joint = Math.max(1 - smoothstep(0, 0.045, Math.min(fy, 1 - fy)), 1 - smoothstep(0, 0.03, Math.min(fa, 1 - fa)));
    out.multiplyScalar(1 - 0.36 * joint);
    // Per-block tint so neighbouring stones differ.
    const blockId = course * 31 + Math.floor(a);
    out.multiplyScalar(0.9 + 0.2 * Math.abs((Math.sin(blockId * 12.9898 + seed) * 43758.5453) % 1));
    return out;
  };
}

/** Altar: stepped plinth ~0.94 m tall with a worn recess for the Heartstone; origin at floor. */
export function createAltar(): Group {
  const parts: Part[] = [];
  const col = stoneColor(5);
  parts.push({ geo: bevelBox(1.9, 0.18, 1.9, 0.04), m: mat(0, 0.07, 0, 0, 0.1), color: col });
  parts.push({ geo: bevelBox(1.5, 0.22, 1.5, 0.04), m: mat(0, 0.27, 0, 0, -0.05), color: col });
  parts.push({ geo: bevelBox(1.0, 0.46, 1.0, 0.05), m: mat(0, 0.6, 0), color: col });
  // Carved band: raised fillets around the shaft.
  parts.push({ geo: bevelBox(1.12, 0.07, 1.12, 0.02), m: mat(0, 0.44, 0), color: col });
  parts.push({ geo: bevelBox(1.12, 0.07, 1.12, 0.02), m: mat(0, 0.8, 0), color: col });
  // Top slab with a circular worn recess (a short, wide cylinder ring).
  parts.push({ geo: bevelBox(1.2, 0.1, 1.2, 0.04), m: mat(0, ALTAR_TOP_Y - 0.05, 0, 0, 0.08), color: col });
  const ring = new CylinderGeometry(0.235, 0.26, 0.035, 28, 1, true);
  parts.push({ geo: ring, m: mat(0, ALTAR_TOP_Y + 0.004, 0), color: stoneColor(9, 0.2) });
  // Cracked corner + fallen chunk on the ground (sells age).
  parts.push({ geo: bevelBox(0.5, 0.2, 0.34, 0.05), m: mat(1.12, 0.1, 0.55, 0.1, 0.5, 0.15), color: stoneColor(14) });
  parts.push({ geo: bevelBox(0.3, 0.14, 0.26, 0.04), m: mat(-1.05, 0.07, 0.8, 0.0, 1.1, 0.0), color: stoneColor(17) });
  // Roots/vines over one side.
  const rng = makeRandom(8);
  for (let i = 0; i < 3; i++) {
    const x = -0.45 + i * 0.4;
    const pts = [new Vector3(x, ALTAR_TOP_Y - 0.1, 0.5), new Vector3(x + 0.04, 0.7, 0.54), new Vector3(x - 0.05, 0.35, 0.8), new Vector3(x + 0.1, 0.02, 1.15)];
    parts.push({ geo: tubeAlong(pts, (t) => 0.025 * (1.2 - 0.6 * t), 4, 10), color: lerpColor('#2a4620', '#4f5c2c', rng()) });
  }
  const mesh = new Mesh(mergeParts(parts), ruinStoneMaterial);
  mesh.name = 'AltarStone';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const g = new Group();
  g.name = 'Altar';
  g.add(mesh);
  return g;
}

/** Fluted pillar. `broken` = snapped top, tilted slightly; origin at floor. */
export function createPillar(seed: number, height: number, broken: boolean): Mesh {
  const rng = makeRandom(seed);
  const cyl = new CylinderGeometry(0.42, 0.5, height, 14, 5, false);
  const top = broken ? 0.45 : 0.0;
  displace(cyl, (v) => {
    const a = Math.atan2(v.z, v.x);
    const flute = 1 - 0.04 * Math.pow(Math.abs(Math.sin(a * 7)), 0.5);
    v.x *= flute;
    v.z *= flute;
    const n = (fbm(v.x * 3, v.y * 2 + v.z * 3, seed, 3) - 0.5) * 0.07;
    v.x += n;
    v.z += n;
    if (broken && v.y > height * 0.5 - 0.02) v.y -= top * (0.5 + 0.5 * Math.sin(a * 2 + seed)) * (1 - Math.hypot(v.x, v.z) / 0.6);
  });
  const parts: Part[] = [
    { geo: cyl, m: mat(0, height / 2, 0), color: stoneColor(seed) },
    { geo: bevelBox(1.15, 0.22, 1.15, 0.05), m: mat(0, 0.11, 0, 0, rng()), color: stoneColor(seed + 1) },
  ];
  if (!broken) parts.push({ geo: bevelBox(1.0, 0.2, 1.0, 0.05), m: mat(0, height + 0.1, 0, 0, 0.2), color: stoneColor(seed + 2) });
  // Vine spiral
  const pts: Vector3[] = [];
  for (let k = 0; k <= 8; k++) {
    const t = k / 8;
    const a = t * 7 + seed;
    pts.push(new Vector3(Math.cos(a) * 0.52, 0.1 + t * (height - 0.5), Math.sin(a) * 0.52));
  }
  parts.push({ geo: tubeAlong(pts, () => 0.035, 4, 16), color: '#314c22' });
  const m = new Mesh(mergeParts(parts), ruinStoneMaterial);
  m.name = `Pillar_${seed}`;
  return m;
}

// ---------------------------------------------------------------------------
// Heartstone (the relic)
// ---------------------------------------------------------------------------

/**
 * Sun-disc talisman, ~0.32 m across, lying flat (gem up). The object origin is
 * its centre, so a grab pivots around the middle of the stone.
 */
export function createHeartstone(): Group {
  const R = 0.15;
  const stoneProfile = [
    new Vector2(0.0, -0.03),
    new Vector2(R * 0.88, -0.03),
    new Vector2(R * 0.97, -0.018),
    new Vector2(R, 0.0),
    new Vector2(R * 0.97, 0.022),
    new Vector2(R * 0.9, 0.03),
    new Vector2(R * 0.78, 0.026), // outer rim top
    new Vector2(R * 0.74, 0.012), // step down into the glyph track
    new Vector2(R * 0.5, 0.012),
    new Vector2(R * 0.46, 0.024), // inner raised collar
    new Vector2(R * 0.3, 0.034),
    new Vector2(R * 0.22, 0.026), // socket for the gem
    new Vector2(0.0, 0.02),
  ];
  const lathe = new LatheGeometry(stoneProfile, 40);
  const parts: Part[] = [{ geo: lathe, color: (p, n) => stoneRelicColor(p, n) }];
  // Twelve chunky teeth around the rim: reads as a sun disc from any angle.
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    parts.push({ geo: bevelBox(0.03, 0.042, 0.06, 0.01, 1), m: mat(Math.cos(a) * (R + 0.004), -0.002, Math.sin(a) * (R + 0.004), 0, -a, 0), color: (p, n) => stoneRelicColor(p, n) });
  }
  const stone = new Mesh(mergeParts(parts), relicStoneMaterial);
  stone.name = 'HeartstoneBody';
  stone.castShadow = true;

  // Glyph grooves: small emissive bars on the track between rim and collar.
  const glyphParts: Part[] = [];
  const rng = makeRandom(66);
  for (let i = 0; i < 12; i++) {
    const a = ((i + 0.5) / 12) * Math.PI * 2;
    const long = 0.028 + rng() * 0.018;
    glyphParts.push({ geo: bevelBox(0.012, 0.008, long, 0.003, 1), m: mat(Math.cos(a) * R * 0.62, 0.015, Math.sin(a) * R * 0.62, 0, -a, 0), color: '#ffffff' });
    if (i % 3 === 0) glyphParts.push({ geo: bevelBox(0.026, 0.008, 0.01, 0.003, 1), m: mat(Math.cos(a) * R * 0.62, 0.015, Math.sin(a) * R * 0.62, 0, -a, 0), color: '#ffffff' });
  }
  const glyphs = new Mesh(mergeParts(glyphParts), relicGlyphMaterial);
  glyphs.name = 'HeartstoneGlyphs';

  // Amber heart: a faceted, slightly elongated crystal set into the socket.
  const gemGeo = new IcosahedronGeometry(0.045, 1);
  displace(gemGeo, (v) => {
    v.y *= 0.8;
    v.y += 0.04;
  });
  const gem = new Mesh(gemGeo, relicGemMaterial);
  gem.name = 'HeartstoneGem';

  const g = new Group();
  g.name = 'Heartstone';
  g.add(stone, glyphs, gem);
  return g;
}

function stoneRelicColor(p: Vector3, n: Vector3): Color {
  const out = new Color();
  const g = fbm(p.x * 40, p.z * 40, 3, 3);
  out.set('#6e6a60').lerp(new Color('#a39d8e'), smoothstep(0.3, 0.8, g));
  // Worn bright on the high points (hands), dark in the grooves.
  out.multiplyScalar(0.72 + 0.4 * smoothstep(0.0, 0.034, p.y) + 0.1 * Math.max(0, n.y));
  out.lerp(new Color('#46613a'), 0.18 * (1 - smoothstep(-0.03, 0.01, p.y)));
  return out;
}


/** All ruined pillars of the clearing in ONE mesh (world coordinates, each sunk 5 cm into the ground). */
export function createRuinPillars(): Mesh {
  // authored at 2-4 m, baked at SCALE.pillar: PILLARS[].h is the WORLD height
  const items = PILLARS.map((p, i) => ({ geo: createPillar(p.seed, p.h / SCALE.pillar, p.broken).geometry, m: mat(p.x, terrainHeight(p.x, p.z) - 0.05 * SCALE.pillar, p.z, i === 1 ? 0.07 : 0, i * 0.64, 0, SCALE.pillar) }));
  const m = new Mesh(mergeBaked(items), ruinStoneMaterial);
  m.name = 'RuinPillars';
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

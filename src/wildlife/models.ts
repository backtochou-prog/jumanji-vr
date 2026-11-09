/**
 * Creature geometry and the (few) shared materials. Procedural, deterministic, no textures.
 *
 * Conventions for every body: +Z = forward, +Y = up, +X = the creature's left... (mirror-symmetric, so it does not matter); unit size where noted,
 * scaled per instance (a bird body is 1 m long and is instanced at 0.18 m or 0.8 m).
 * Wings, wing segments and limb bones are separate instanced parts that the simulation poses by hand each frame (no skinning).
 * Vertex colours are baked and multiplied by a per-instance tint: bodies that must stay multi-coloured (macaw, toucan) keep their own
 * colours and use a white tint; the "neutral" parts (small birds, wings, monkeys, butterflies, dragonflies) carry only light/dark
 * structure and take their hue from the tint.
 */
import { BoxGeometry, Color, DataTexture, DoubleSide, LinearFilter, MeshBasicMaterial, MeshStandardMaterial, RGBAFormat, SphereGeometry, UnsignedByteType, BufferGeometry, Float32BufferAttribute, Vector3, PointsMaterial, AdditiveBlending } from '@iwsdk/core';
import { lerpColor, mat, mergeParts } from '../scene-assets/lib/geo.js';
import type { Part } from '../scene-assets/lib/geo.js';
import { ROUGH } from '../world/palette.js';

// ---------------------------------------------------------------------------
// Materials (5 in total, shared by every creature)
// ---------------------------------------------------------------------------

export const creatureMaterial = new MeshStandardMaterial({ name: 'wildlife-body', vertexColors: true, roughness: ROUGH.foliage - 0.08, metalness: 0 });
export const creatureWingMaterial = new MeshStandardMaterial({ name: 'wildlife-wing', vertexColors: true, roughness: ROUGH.foliage - 0.05, metalness: 0, side: DoubleSide });
export const dragonWingMaterial = new MeshBasicMaterial({ name: 'wildlife-dragonfly-wing', vertexColors: true, transparent: true, opacity: 0.4, side: DoubleSide, depthWrite: false });

/** A soft round sprite for the point lights/motes (no DOM canvas: generated into a DataTexture). */
const dot = (() => {
  const N = 32;
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const d = Math.hypot((x + 0.5) / N - 0.5, (y + 0.5) / N - 0.5) * 2;
      const a = Math.max(0, 1 - d);
      const v = Math.round(255 * a * a * (3 - 2 * a));
      const o = (y * N + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = 255;
      data[o + 3] = v;
    }
  const t = new DataTexture(data, N, N, RGBAFormat, UnsignedByteType);
  t.magFilter = t.minFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
})();
/** Fireflies: additive, soft, warm; their brightness is the vertex colour (pulsed on the CPU). */
export const fireflyMaterial = new PointsMaterial({ name: 'wildlife-firefly', map: dot, size: 0.07, sizeAttenuation: true, vertexColors: true, transparent: true, blending: AdditiveBlending, depthWrite: false });
/** Gnats / pollen motes: tiny dark specks, alpha-blended. */
export const moteMaterial = new PointsMaterial({ name: 'wildlife-motes', map: dot, size: 0.03, sizeAttenuation: true, color: '#1d2318', transparent: true, opacity: 0.8, depthWrite: false });

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

type ColorArg = string | number | Color | ((p: Vector3) => Color);
const sphere = (w = 10, h = 7) => new SphereGeometry(1, w, h);

/** An ellipsoid (centre, radii) with an optional pitch about X. */
function ellipsoid(parts: Part[], cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, color: ColorArg, pitch = 0, seg?: [number, number]): void {
  // 8 x 5 (~70 triangles) for body masses, 5 x 3 (~20) for anything tiny (eyes, hands): these are seen at metres, not centimetres
  const tiny = Math.max(rx, ry, rz) < 0.04;
  const [w, h] = seg ?? (tiny ? [5, 3] : [8, 5]);
  parts.push({ geo: sphere(w, h), m: mat(cx, cy, cz, pitch, 0, 0, rx, ry, rz), color: color as Part['color'] });
}
function box(parts: Part[], cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, color: ColorArg, pitch = 0, yaw = 0, roll = 0): void {
  parts.push({ geo: new BoxGeometry(1, 1, 1), m: mat(cx, cy, cz, pitch, yaw, roll, sx, sy, sz), color: color as Part['color'] });
}
/** A cone pointing +Z (base at z0, tip at z1) — beaks and snouts. */
function cone(parts: Part[], cx: number, cy: number, z0: number, z1: number, r: number, color: ColorArg, ry = r): void {
  const g = new SphereGeometry(1, 6, 4);
  // a pointed ellipsoid: scale along Z, shift so the fat end is at z0
  const len = z1 - z0;
  parts.push({ geo: g, m: mat(cx, cy, z0 + len * 0.5, 0, 0, 0, r, ry, len * 0.5), color: color as Part['color'] });
}
const grey = (v: number) => new Color(v, v, v);
const shade = (hex: string, k: number) => new Color(hex).multiplyScalar(k);

// ---------------------------------------------------------------------------
// Birds (unit length ~1 m, beak to tail tip)
// ---------------------------------------------------------------------------

/** Small bird (parakeet / canary / tanager): neutral light/dark structure, hue from the instance tint. Body length 1 = 0.17-0.28 m when instanced. */
export function createSmallBirdBody(): BufferGeometry {
  const parts: Part[] = [];
  const back = (p: Vector3) => grey(0.82 + 0.1 * Math.min(1, Math.max(0, p.y / 0.15)) + 0.08 * (p.y < -0.05 ? 1 : 0));
  ellipsoid(parts, 0, 0, 0.02, 0.17, 0.165, 0.31, back, -0.12);
  ellipsoid(parts, 0, 0.1, 0.3, 0.115, 0.11, 0.125, grey(0.95)); // head
  ellipsoid(parts, 0, -0.1, 0.1, 0.12, 0.08, 0.2, grey(1.0)); // pale belly
  cone(parts, 0, 0.085, 0.38, 0.5, 0.045, grey(0.32), 0.05); // beak
  ellipsoid(parts, 0.085, 0.13, 0.36, 0.022, 0.022, 0.022, grey(0.04)); // eyes
  ellipsoid(parts, -0.085, 0.13, 0.36, 0.022, 0.022, 0.022, grey(0.04));
  box(parts, 0, 0.0, -0.46, 0.13, 0.014, 0.4, (p) => grey(0.62 + 0.3 * Math.min(1, Math.max(0, (p.z + 0.66) / 0.4))), -0.08); // tail
  return mergeParts(parts);
}

/** Scarlet macaw: own colours (red body, white face patch, ivory beak, long red-to-blue tail). Wings are the shared wing parts, tinted. */
export function createMacawBody(): BufferGeometry {
  const parts: Part[] = [];
  const red = '#b9221c';
  ellipsoid(parts, 0, 0, 0.16, 0.1, 0.105, 0.22, (p) => lerpColor(red, '#d23a22', Math.min(1, Math.max(0, p.y * 4 + 0.4))), -0.18);
  ellipsoid(parts, 0, 0.08, 0.36, 0.078, 0.076, 0.085, red); // head
  ellipsoid(parts, 0, 0.085, 0.4, 0.062, 0.05, 0.05, '#e9e2d4'); // bare white face patch
  cone(parts, 0, 0.055, 0.4, 0.5, 0.042, '#e8dcc0', 0.05); // upper beak
  ellipsoid(parts, 0, 0.03, 0.46, 0.036, 0.03, 0.045, '#2a2622'); // lower mandible / hook
  ellipsoid(parts, 0.062, 0.105, 0.38, 0.017, 0.017, 0.017, '#171310');
  ellipsoid(parts, -0.062, 0.105, 0.38, 0.017, 0.017, 0.017, '#171310');
  // long graduated tail: red at the base, yellow, blue at the tip
  const tail = (z: number) => lerpColor('#b9221c', '#2a58b8', Math.min(1, Math.max(0, (-z - 0.18) / 0.4)));
  box(parts, 0, -0.01, -0.34, 0.085, 0.014, 0.62, (p) => tail(p.z), -0.1);
  box(parts, 0.028, -0.01, -0.3, 0.05, 0.012, 0.5, (p) => tail(p.z), -0.1, 0.05);
  box(parts, -0.028, -0.01, -0.3, 0.05, 0.012, 0.5, (p) => tail(p.z), -0.1, -0.05);
  return mergeParts(parts);
}

/** Keel-billed toucan: black body, yellow bib, big layered bill (green/orange/red), blue eye ring, red vent. */
export function createToucanBody(): BufferGeometry {
  const parts: Part[] = [];
  const black = '#1a1816';
  ellipsoid(parts, 0, 0, 0, 0.13, 0.14, 0.24, (p) => (p.z > 0.1 && p.y < 0.02 ? new Color('#e8c23a') : new Color(black)), -0.1);
  ellipsoid(parts, 0, 0.09, 0.25, 0.1, 0.095, 0.105, black); // head
  ellipsoid(parts, 0, 0.0, 0.3, 0.085, 0.075, 0.06, '#efe0a0'); // pale throat/cheek
  ellipsoid(parts, 0.07, 0.115, 0.31, 0.03, 0.03, 0.03, '#3d6fd0'); // eye ring
  ellipsoid(parts, -0.07, 0.115, 0.31, 0.03, 0.03, 0.03, '#3d6fd0');
  ellipsoid(parts, 0.07, 0.115, 0.325, 0.014, 0.014, 0.014, '#0c0a08');
  ellipsoid(parts, -0.07, 0.115, 0.325, 0.014, 0.014, 0.014, '#0c0a08');
  // the bill: deep and long, orange-yellow, with a dark base ring and a red tip
  const bill = (p: Vector3) => (p.z > 0.62 ? new Color('#c4351d') : p.z < 0.37 ? new Color('#2a2420') : p.y > 0.09 ? new Color('#c8d23a') : new Color('#e8a020'));
  parts.push({ geo: sphere(8, 6), m: mat(0, 0.075, 0.5, 0.05, 0, 0, 0.058, 0.07, 0.23), color: bill });
  box(parts, 0, -0.005, -0.34, 0.12, 0.016, 0.3, black, -0.1); // tail
  box(parts, 0, -0.03, -0.2, 0.06, 0.014, 0.05, '#c4351d'); // red vent
  return mergeParts(parts);
}

/** One wing segment: root at the origin, span +X (length 1), chord along Z (leading edge +Z). Neutral colours; scalloped trailing edge (feather tips). */
export function createWingSegment(): BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const N = 6;
  const lead = (u: number) => 0.28 - 0.1 * u;
  const trail = (u: number, k: number) => -0.72 + 0.5 * Math.pow(u, 1.6) + (k % 2 === 0 ? 0 : -0.07) * (0.4 + u);
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    pos.push(u, 0.02 * (1 - u), lead(u)); // leading edge, slightly raised near the root (camber)
    const c = 0.62 + 0.08 * u;
    col.push(c, c, c);
    pos.push(u, 0, trail(u, i));
    const c2 = 0.96 - 0.28 * u;
    col.push(c2, c2, c2);
  }
  for (let i = 0; i < N; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// Monkeys
// ---------------------------------------------------------------------------

/** Torso: neutral fur, paler belly. Hips at -Z, shoulders at +Z, ~0.42 m long (spider-monkey reference size; scaled per instance). */
export function createMonkeyBody(): BufferGeometry {
  const parts: Part[] = [];
  ellipsoid(parts, 0, 0, 0, 0.098, 0.105, 0.215, (p) => grey(p.y < -0.03 ? 0.98 : 0.82), 0.0, [10, 7]);
  ellipsoid(parts, 0, 0.0, 0.14, 0.092, 0.1, 0.09, grey(0.86)); // chest/shoulders
  ellipsoid(parts, 0, -0.01, -0.14, 0.09, 0.09, 0.085, grey(0.8)); // hips
  return mergeParts(parts);
}

/** Head, pivot at the neck (origin), facing +Z: face mask lighter, ears, snout, eyes. */
export function createMonkeyHead(): BufferGeometry {
  const parts: Part[] = [];
  ellipsoid(parts, 0, 0.045, 0.05, 0.092, 0.088, 0.1, grey(0.78)); // skull
  ellipsoid(parts, 0, 0.02, 0.112, 0.066, 0.06, 0.05, grey(1.0)); // face mask
  ellipsoid(parts, 0, 0.088, 0.1, 0.07, 0.03, 0.04, grey(0.7)); // brow ridge
  cone(parts, 0, -0.004, 0.12, 0.17, 0.038, grey(0.92), 0.032); // muzzle
  ellipsoid(parts, 0.048, 0.062, 0.128, 0.015, 0.015, 0.015, grey(0.02));
  ellipsoid(parts, -0.048, 0.062, 0.128, 0.015, 0.015, 0.015, grey(0.02));
  ellipsoid(parts, 0.094, 0.06, 0.03, 0.02, 0.028, 0.014, grey(0.9));
  ellipsoid(parts, -0.094, 0.06, 0.03, 0.02, 0.028, 0.014, grey(0.9));
  return mergeParts(parts);
}

/** A limb/tail "bone": a unit ellipsoid centred at the origin; the simulation scales it (thickness, half-length, thickness) along +Y. */
export function createBone(): BufferGeometry {
  const g = new SphereGeometry(1, 5, 3);
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3).fill(0.88);
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  return g;
}

// ---------------------------------------------------------------------------
// Insects
// ---------------------------------------------------------------------------

/** One butterfly wing (fore + hind wing as one blade): root at the origin, span +X (length 1), chord along Z (front +Z). Neutral pattern: dark border, bright inside, pale spots. */
export function createButterflyWing(): BufferGeometry {
  const M = 16;
  const pos: number[] = [0, 0, 0];
  const col: number[] = [0.22, 0.22, 0.22]; // the body-side root is dark
  const outerAt = (i: number): [number, number] => {
    const a = (-62 + (i / (M - 1)) * 140) * (Math.PI / 180); // hind (back, -Z) -> fore (front, +Z)
    const k = Math.min(1, Math.max(0, (a * 57.3 + 62) / 70));
    const r = 0.62 + 0.38 * k * k * (3 - 2 * k);
    return [r * Math.cos(a), r * Math.sin(a) * 0.78];
  };
  for (let i = 0; i < M; i++) {
    const [x, z] = outerAt(i);
    pos.push(x, 0, z);
    const c = 0.2 + 0.08 * Math.sin(i * 2.1);
    col.push(c, c, c);
  }
  const inner0 = 1 + M;
  for (let i = 0; i < M; i++) {
    const [x, z] = outerAt(i);
    pos.push(x * 0.66 + 0.05, 0.003, z * 0.66);
    const c = i % 5 === 2 ? 1.0 : 0.92;
    col.push(c, c, c);
  }
  const idx: number[] = [];
  for (let i = 0; i < M - 1; i++) {
    idx.push(0, inner0 + i, inner0 + i + 1);
    idx.push(inner0 + i, 1 + i, 1 + i + 1, inner0 + i, 1 + i + 1, inner0 + i + 1);
  }
  idx.push(0, 1, inner0, 0, inner0 + M - 1, 1 + M - 1); // close the hind and fore edges back to the root
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Butterfly body: a dark slender capsule, length 1 along +Z (instanced at 2-3 cm). */
export function createInsectBody(): BufferGeometry {
  const parts: Part[] = [];
  ellipsoid(parts, 0, 0, 0.0, 0.1, 0.1, 0.5, grey(0.25), 0, [6, 4]);
  ellipsoid(parts, 0, 0.0, 0.42, 0.11, 0.11, 0.1, grey(0.18), 0, [6, 4]);
  return mergeParts(parts);
}

/** Dragonfly body: thorax + a long thin abdomen, length 1 along +Z (instanced at ~7 cm); neutral, banded, tinted per instance. */
export function createDragonflyBody(): BufferGeometry {
  const parts: Part[] = [];
  ellipsoid(parts, 0, 0, 0.3, 0.07, 0.075, 0.13, grey(0.55), 0, [7, 5]); // thorax
  ellipsoid(parts, 0, 0.0, 0.45, 0.075, 0.075, 0.06, grey(0.9), 0, [7, 5]); // head (big eyes)
  for (let i = 0; i < 7; i++) {
    const z = 0.1 - i * 0.12;
    ellipsoid(parts, 0, 0, z, 0.032 - i * 0.0015, 0.032 - i * 0.0015, 0.075, grey(i % 2 ? 0.55 : 0.85), 0, [5, 4]);
  }
  return mergeParts(parts);
}

/** One long, narrow dragonfly wing: root at the origin, span +X (1), chord along Z, near-transparent with a dark leading-edge stigma. */
export function createDragonflyWing(): BufferGeometry {
  const pos = [0, 0, 0.09, 1, 0, 0.06, 1, 0, -0.07, 0, 0, -0.1, 0.55, 0, 0.1, 0.55, 0, -0.09];
  const c = (v: number) => [v, v, v];
  const col = [...c(0.8), ...c(0.6), ...c(0.8), ...c(0.85), ...c(0.95), ...c(0.85)];
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.setIndex([0, 4, 5, 0, 5, 3, 4, 1, 2, 4, 2, 5]);
  g.computeVertexNormals();
  return g;
}

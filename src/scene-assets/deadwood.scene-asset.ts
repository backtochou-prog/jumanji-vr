/**
 * Decaying wood: fallen logs, branches, exposed root runs and the fallen giant
 * landmark. Bark material with a surface bump; moss grows on upward faces,
 * cut ends are pale and weathered, bracket fungi use the pale accent.
 * Every piece is partly buried: origins sit so the lowest side is below ground.
 */
import { BufferGeometry, CircleGeometry, Color, IcosahedronGeometry, Mesh, Vector3 } from '@iwsdk/core';
import { fbm, makeRandom, smoothstep } from '../world/layout.js';
import { PAL } from '../world/palette.js';
import { displace, lerpColor, mat, mergeParts, tubeAlong } from './lib/geo.js';
import type { ColorFn, Part } from './lib/geo.js';
import { barkMaterial } from './lib/materials.js';

const DEAD = new Color(PAL.deadwood);
const BARK = new Color(PAL.bark);
const BARK_D = new Color(PAL.barkDark);
const MOSS = new Color(PAL.moss);
const MOSS_D = new Color(PAL.mossDeep);

function woodColor(seed: number, mossiness: number): ColorFn {
  const out = new Color();
  return (p, n) => {
    const g = fbm(p.x * 2 + p.z * 0.8, p.y * 3, seed, 3);
    out.copy(BARK_D).lerp(BARK, smoothstep(0.3, 0.7, g)).lerp(DEAD, smoothstep(0.7, 0.95, g) * 0.6);
    const moss = Math.min(1, (smoothstep(0.15, 0.7, n.y) * 0.9 + smoothstep(0.65, 0.8, fbm(p.x * 3, p.z * 3 + p.y, seed + 4, 2)) * 0.4) * mossiness);
    out.lerp(MOSS_D, moss * 0.6).lerp(MOSS, moss * smoothstep(0.55, 1, n.y) * 0.7);
    return out;
  };
}

/** Weathered, pale cut end disc facing +/-X (log axis). */
function endCap(radius: number, x: number, dir: 1 | -1): Part {
  const g = new CircleGeometry(radius, 9);
  g.rotateY((dir * Math.PI) / 2);
  g.translate(x, 0, 0);
  displace(g, (v, i) => {
    if (i > 0) v.x += (fbm(v.y * 6, v.z * 6, 3, 2) - 0.5) * 0.14 * dir;
  });
  return { geo: g, color: () => lerpColor('#9a8a72', '#6f6150', 0.4) };
}

/** A lying log along local X, centre at origin; the lower ~25 % is meant to be buried. */
function logGeometry(length: number, radius: number, seed: number, stubs: boolean): Part[] {
  const rng = makeRandom(seed);
  const pts = [new Vector3(-length / 2, 0, 0), new Vector3(-length * 0.2, 0.03, 0.05), new Vector3(length * 0.2, 0.02, -0.04), new Vector3(length / 2, 0, 0.02)];
  const parts: Part[] = [{ geo: tubeAlong(pts, (t) => radius * (1.08 - 0.28 * t + 0.05 * Math.sin(t * 25 + seed)), 9, 10), color: woodColor(seed, 0.9) }];
  parts.push(endCap(radius * 1.08, -length / 2, -1));
  parts.push(endCap(radius * 0.8, length / 2, 1));
  if (stubs) {
    for (let i = 0; i < 2; i++) {
      const x = (rng() - 0.5) * length * 0.6;
      const dir = new Vector3(0.3, 0.9, (rng() - 0.5) * 1.2).normalize();
      const s = new Vector3(x, radius * 0.7, 0);
      parts.push({ geo: tubeAlong([s, s.clone().addScaledVector(dir, 0.35), s.clone().addScaledVector(dir, 0.7)], (t) => 0.07 * (1 - 0.6 * t), 5, 3), color: woodColor(seed + 9, 0.3) });
    }
  }
  // Bracket fungi shelves on the shaded side.
  for (let i = 0; i < 3; i++) {
    const g = new IcosahedronGeometry(1, 0);
    displace(g, (v) => v.set(v.x * 0.13, v.y * 0.04, v.z * 0.1));
    const x = (rng() - 0.5) * length * 0.7;
    const a = 0.4 + rng() * 0.6;
    parts.push({ geo: g, m: mat(x, radius * Math.cos(a) * 0.5 + radius * 0.2, radius * 0.9 * (rng() > 0.5 ? 1 : -1), 0, rng() * 3, 0), color: () => lerpColor(PAL.accentPale, '#b89a6a', rng() * 0.6) });
  }
  return parts;
}

/** Mid-size log: variants differ in girth and stubs. Origin at the log centre, axis along X. */
export function createLog(variant: number): Mesh {
  const radius = [0.28, 0.34, 0.4][variant % 3];
  const m = new Mesh(mergeParts(logGeometry(4.4, radius, 11 + variant * 7, variant !== 0)), barkMaterial);
  m.name = `Log_${variant}`;
  return m;
}

/**
 * The fallen giant: a huge trunk lying beside the trail with its upturned root
 * plate at one end, snapped crown stub at the other, ferny moss on top.
 * 11 m long, 0.85 m radius; lowest ~30 % sunk into the ground.
 */
export function createGiantLog(): Mesh {
  const rng = makeRandom(4242);
  const length = 11;
  const radius = 0.85;
  const parts = logGeometry(length, radius, 77, true);
  // Root plate at -X: a disc of roots radiating out and curling.
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + rng() * 0.3;
    const r0 = radius * 0.5;
    const s = new Vector3(-length / 2, Math.sin(a) * r0, Math.cos(a) * r0);
    const out = new Vector3(-0.9, Math.sin(a) * 1.5 + 0.5, Math.cos(a) * 1.5);
    const pts = [s, s.clone().add(out.clone().multiplyScalar(0.5)), s.clone().add(out.clone().multiplyScalar(1.0)).add(new Vector3(-0.3, 0.4, 0))];
    parts.push({ geo: tubeAlong(pts, (t) => 0.42 * (1 - 0.7 * t), 7, 6), color: woodColor(78 + i, 0.5) });
  }
  // A disc of earth and tangled fibre behind the roots.
  const plate = new CircleGeometry(1.7, 14);
  plate.rotateY(-Math.PI / 2);
  plate.translate(-length / 2 - 0.5, 0.35, 0);
  parts.push({ geo: plate, color: () => lerpColor(PAL.soilDark, PAL.soil, 0.4) });
  // Snapped branch stubs along the crown half.
  for (let i = 0; i < 5; i++) {
    const x = length * (0.05 + 0.4 * rng());
    const s = new Vector3(x, radius * 0.75, (rng() - 0.5) * 0.5);
    const d = new Vector3((rng() - 0.5) * 0.4, 0.8, (rng() - 0.5) * 1.2).normalize();
    parts.push({ geo: tubeAlong([s, s.clone().addScaledVector(d, 0.5), s.clone().addScaledVector(d, 1.1)], (t) => 0.12 * (1 - 0.7 * t), 5, 3), color: woodColor(90 + i, 0.2) });
  }
  const m = new Mesh(mergeParts(parts), barkMaterial);
  m.name = 'GiantLog';
  return m;
}

/** Fallen branch with a fork: 1.5-2.5 m, lies on the ground (origin = its lowest centre). */
export function createBranch(variant: number): Mesh {
  const rng = makeRandom(50 + variant * 13);
  const len = 1.7 + variant * 0.45;
  const r = 0.045 + variant * 0.012;
  const parts: Part[] = [];
  const main = [new Vector3(-len / 2, 0.02, 0), new Vector3(-len * 0.15, 0.06, 0.06 * (rng() - 0.5)), new Vector3(len * 0.2, 0.04, 0.1 * (rng() - 0.5)), new Vector3(len / 2, 0.03, 0)];
  parts.push({ geo: tubeAlong(main, (t) => r * (1.1 - 0.7 * t), 5, 6), color: woodColor(60 + variant, 0.5) });
  const fork = main[1].clone();
  const dir = new Vector3(0.5, 0.1, (variant % 2 ? 1 : -1) * 0.7).normalize();
  parts.push({ geo: tubeAlong([fork, fork.clone().addScaledVector(dir, len * 0.25), fork.clone().addScaledVector(dir, len * 0.5)], (t) => r * 0.6 * (1 - 0.6 * t), 5, 3), color: woodColor(70 + variant, 0.4) });
  parts.push(endCap(r * 1.1, -len / 2, -1));
  const m = new Mesh(mergeParts(parts), barkMaterial);
  m.name = `Branch_${variant}`;
  return m;
}

/**
 * Exposed root run: 2-3 roots leave the trunk's buttress edge (origin, running
 * along local +Z), hug the soil, split, taper and dive back under the ground.
 */
export function createRoots(variant: number): Mesh {
  const rng = makeRandom(1700 + variant * 23);
  const parts: Part[] = [];
  const n = 2 + (variant % 2);
  for (let i = 0; i < n; i++) {
    const x0 = (i - (n - 1) / 2) * 0.7 + (rng() - 0.5) * 0.2;
    const sway = (rng() - 0.5) * 1.2;
    const len = 2.6 + rng() * 1.4;
    const pts = [
      new Vector3(x0, 0.32, -0.2),
      new Vector3(x0 + sway * 0.15, 0.2 + 0.1 * rng(), len * 0.3),
      new Vector3(x0 + sway * 0.5, 0.1 + 0.06 * rng(), len * 0.62),
      new Vector3(x0 + sway, -0.14, len),
    ];
    parts.push({ geo: tubeAlong(pts, (t) => 0.27 * (1 - 0.82 * t) + 0.02 * Math.sin(t * 17), 7, 9), color: woodColor(1710 + i + variant * 3, 0.55) });
    // A finer rootlet branching off.
    const b = pts[1].clone();
    const bd = new Vector3(sway > 0 ? -0.6 : 0.6, 0, 0.8).normalize();
    parts.push({ geo: tubeAlong([b, b.clone().addScaledVector(bd, 0.9), b.clone().addScaledVector(bd, 1.7).add(new Vector3(0, -0.2, 0))], (t) => 0.09 * (1 - 0.7 * t), 5, 4), color: woodColor(1720 + i, 0.4) });
  }
  const m = new Mesh(mergeParts(parts), barkMaterial);
  m.name = `Roots_${variant}`;
  return m;
}

export type { BufferGeometry };

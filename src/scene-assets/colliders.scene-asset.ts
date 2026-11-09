/**
 * Invisible collision geometry for locomotion.
 *
 * IWSDK's locomotion engine builds a BVH from every mesh under a node that
 * carries `LocomotionEnvironment` - including meshes with `visible = false`.
 * One merged proxy provides: the boundary wall of the walkable area, tree
 * trunks, big rocks, fallen logs, the root-arch leg, the temple platform/walls/
 * columns, the spire, pillars and the altar. It never renders (zero draws).
 *
 * The TRAIL stays clear by construction: nothing is placed within trunk radius
 * + margin of the trail centre-line (tools/validate-scene.mjs proves it).
 */
import { BoxGeometry, CylinderGeometry, IcosahedronGeometry, Matrix4, Mesh, MeshBasicMaterial, Quaternion, Vector3 } from '@iwsdk/core';
import { ALTAR, ALTAR_TOP_Y, FALLEN_GIANT, MTN_GUARDS, PILLARS, PILLAR_R, TEMPLE_BASE, ROOT_ARCH, SPIRE, TEMPLE, WALK_LIMIT, ringOpening, terrainHeight } from '../world/layout.js';
import { BAKED } from '../world/baked.js';
import { mat, mergeParts } from './lib/geo.js';
import type { Part } from './lib/geo.js';
import { templeSolids } from './temple.scene-asset.js';

export function createColliders(): Mesh {
  const parts: Part[] = [];
  const white = '#ffffff';
  const yAxis = new Vector3(0, 1, 0);
  const box = (x: number, y: number, z: number, w: number, h: number, d: number, yaw = 0) =>
    parts.push({ geo: new BoxGeometry(w, h, d), m: new Matrix4().compose(new Vector3(x, y, z), new Quaternion().setFromAxisAngle(yAxis, yaw), new Vector3(1, 1, 1)), color: white });
  const cyl = (x: number, y: number, z: number, r: number, h: number, seg = 8) => parts.push({ geo: new CylinderGeometry(r, r * 1.06, h, seg), m: mat(x, y, z), color: white });
  /** Horizontal cylinder along local X, yawed. */
  const lying = (x: number, y: number, z: number, r: number, len: number, yaw: number) => parts.push({ geo: new CylinderGeometry(r, r, len, 8), m: mat(x, y, z, 0, yaw, Math.PI / 2), color: white });

  // Boundary wall: a closed ring of overlapping boxes around the walkable ellipse.
  const N = 330;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const x = WALK_LIMIT.cx + Math.cos(a) * WALK_LIMIT.rx;
    const z = WALK_LIMIT.cz + Math.sin(a) * WALK_LIMIT.rz;
    const tx = -Math.sin(a) * WALK_LIMIT.rx;
    const tz = Math.cos(a) * WALK_LIMIT.rz;
    const len = (Math.hypot(tx, tz) * (Math.PI * 2)) / N + 0.4;
    if (ringOpening(x, z)) continue; // the mountain route leaves the jungle here
    box(x, terrainHeight(x, z) + 4, z, len, 12, 1.4, Math.atan2(-tz, tx));
  }
  // Tree trunks.
  for (const [x, y, z, r] of BAKED.trees) {
    cyl(x, y + 5.5, z, r, 14);
  }
  // Big rocks.
  // kind: 0 boulder, 1 slab, 2 standing, 3 cobble
  for (const [x, y, z, s, yaw, kind] of BAKED.rocks) {
    parts.push({ geo: new IcosahedronGeometry(1, 0), m: mat(x, y + 0.35 * s, z, 0, yaw, 0, 0.9 * s * (kind === 2 ? 0.55 : 1), (kind === 1 ? 0.45 : kind === 2 ? 1.5 : 0.8) * s, 0.9 * s * (kind === 2 ? 0.5 : 1)), color: white });
  }
  // Fallen logs (mid-size) and the fallen giant.
  for (const [x, y, z, r, len, yaw] of BAKED.logs) lying(x, y + 0.2, z, r, len, yaw);
  {
    const gy = terrainHeight(FALLEN_GIANT.x, FALLEN_GIANT.z);
    lying(FALLEN_GIANT.x, gy + 0.55 * (FALLEN_GIANT.radius / 0.85), FALLEN_GIANT.z, FALLEN_GIANT.radius, FALLEN_GIANT.length, FALLEN_GIANT.yaw);
  }
  // Root arch: the far leg only (the trail passes under the bridge; the trunk is a tree collider).
  {
    const c = Math.cos(ROOT_ARCH.yaw);
    const s = Math.sin(ROOT_ARCH.yaw);
    const lx = ROOT_ARCH.legX;
    cyl(ROOT_ARCH.x + lx * c, terrainHeight(ROOT_ARCH.x + lx * c, ROOT_ARCH.z - lx * s) + 1.2 * ROOT_ARCH.scale, ROOT_ARCH.z - lx * s, 0.45 * ROOT_ARCH.scale, 2.6 * ROOT_ARCH.scale);
  }
  // Clearing: temple solids (platform, wall sections, columns), spire, pillars, altar.
  {
    const gy = TEMPLE_BASE;
    for (const b of templeSolids()) box(TEMPLE.x + b.x, gy + b.y, TEMPLE.z + b.z, b.w, b.h, b.d);
    cyl(SPIRE.x, terrainHeight(SPIRE.x, SPIRE.z) + 15, SPIRE.z, SPIRE.r * 0.93, 30, 10);
  }
  for (const p of PILLARS) cyl(p.x, terrainHeight(p.x, p.z) + p.h / 2, p.z, PILLAR_R, p.h);
  box(ALTAR[0], terrainHeight(ALTAR[0], ALTAR[1]) + (ALTAR_TOP_Y + 0.2) / 2 - 0.1, ALTAR[1], 1.9, ALTAR_TOP_Y + 0.2, 1.9);

  // Mountain route: guard walls along both sides of the corridor and round the summit platform and the brink terrace,
  // so the player can lean over any drop but never step off it (validated by tools/validate-scene.mjs).
  for (const w of MTN_GUARDS) parts.push({ geo: new BoxGeometry(w.length, w.y1 - w.y0, 0.5), m: new Matrix4().compose(new Vector3(w.x, (w.y0 + w.y1) / 2, w.z), new Quaternion().setFromAxisAngle(yAxis, w.yaw), new Vector3(1, 1, 1)), color: white });

  const mesh = new Mesh(mergeParts(parts), new MeshBasicMaterial({ visible: false }));
  mesh.visible = false;
  mesh.name = 'WorldColliders';
  return mesh;
}

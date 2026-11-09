/**
 * The suspended rope bridge (Prompt 04). Original design: a plank deck lashed to two stringer ropes, two
 * suspension cables hung from log posts at each end, vertical hanging ropes from the cables to the deck edge,
 * a handrail rope on each side, and guy ropes running back to ground stakes.
 *
 *   RopeBridge        visible geometry, ONE mesh (planks + ropes + posts), local frame: x along the span from the
 *                     west end (0) to the east end (L), z across, y relative to BRIDGE.y. Placed at the west abutment.
 *   BridgeColliders   invisible, kinematic walkable surface (the player walks on the SAME sagging deck line), plus
 *                     rail walls so you cannot step off the deck. The BridgeSystem moves both together (a few mm).
 * Planks: every plank is its own box with individual width, thickness, tilt, yaw, lateral shift and colour; a few are
 * cracked in two. Gaps between planks are real: you see the ravine through the deck (the collider is continuous).
 */
import { BoxGeometry, BufferGeometry, Color, CylinderGeometry, Matrix4, Mesh, MeshBasicMaterial, Quaternion, Vector3 } from '@iwsdk/core';
import { fbm, makeRandom } from '../world/layout.js';
import { BRIDGE, BRIDGE_LENGTH, bridgeDeckY } from '../world/mountain.js';
import { terrainHeight } from '../world/layout.js';
import { PAL } from '../world/palette.js';
import { lerpColor, mat, mergeParts, solidUV, tubeAlong } from './lib/geo.js';
import type { Part } from './lib/geo.js';
import { barkMaterial } from './lib/materials.js';

const HALF = BRIDGE.halfWidth;
const L = BRIDGE_LENGTH;
/** deck height relative to BRIDGE.y at fraction u */
const deck = (u: number): number => bridgeDeckY(u) - BRIDGE.y;
const uAt = (x: number): number => Math.min(1, Math.max(0, x / L));

const WOOD_LIGHT = new Color(PAL.barkLight).lerp(new Color('#9a8566'), 0.4);
const WOOD_DARK = new Color(PAL.barkDark).lerp(new Color(PAL.bark), 0.45);
const GREY = new Color('#8b857a');
const ROPE = new Color('#8c7b57');
const ROPE_DARK = new Color('#5d513a');
const MOSS = new Color(PAL.mossDeep);

export function createRopeBridge(): Mesh {
  const rng = makeRandom(4242);
  const parts: Part[] = [];
  const yAxis = new Vector3(0, 1, 0);
  void yAxis;

  // --- planks ---
  let x = 0.25;
  let n = 0;
  while (x < L - 0.2) {
    const w = 0.2 + rng() * 0.07;
    const gap = 0.03 + rng() * 0.03;
    const cx = x + w / 2;
    const u = uAt(cx);
    const thick = 0.045 + rng() * 0.02;
    const len = HALF * 2 + 0.16 + rng() * 0.1;
    const shift = (rng() - 0.5) * 0.06;
    const yaw = (rng() - 0.5) * 0.06;
    const roll = (rng() - 0.5) * 0.045 + (u < 0.5 ? 1 : -1) * 0.01; // the deck's slope makes planks lean slightly outwards
    const tone = fbm(cx * 0.9, 1.7, 52, 2);
    const col = lerpColor(WOOD_LIGHT, WOOD_DARK, tone * 0.85).lerp(GREY, rng() * 0.25).lerp(MOSS, rng() < 0.12 ? 0.35 : 0);
    const make = (px: number, pw: number, c: Color, tilt = 0) => {
      const geo = new BoxGeometry(pw, thick, len);
      parts.push({ geo, m: mat(px, deck(uAt(px)) - thick / 2, shift, tilt, yaw, roll), color: c.clone().multiplyScalar(0.9 + 0.2 * rng()) });
    };
    if (rng() < 0.07) {
      // a cracked plank: two halves, one dropped a little
      make(cx - w * 0.26, w * 0.46, col, 0);
      make(cx + w * 0.26, w * 0.46, col.clone().multiplyScalar(0.8), 0.05);
    } else make(cx, w, col, (rng() - 0.5) * 0.02);
    x += w + gap;
    n++;
  }
  void n;

  // --- ropes ---
  const rope = (pts: Vector3[], r: number, c: Color, radial = 5) => parts.push({ geo: solidUV(tubeAlong(pts, (t) => r * (1 + 0.12 * Math.sin(t * 90)), radial, Math.max(4, pts.length - 1))), color: c });
  const line = (f: (u: number) => Vector3, steps = 26): Vector3[] => Array.from({ length: steps + 1 }, (_, i) => f(i / steps));
  for (const side of [-1, 1]) {
    // stringers under the deck edge
    rope(line((u) => new Vector3(u * L, deck(u) - 0.1, side * (HALF - 0.12))), 0.04, ROPE_DARK, 6);
    // handrail rope at 1.02 m
    rope(line((u) => new Vector3(u * L, deck(u) + 1.02 + 0.05 * Math.sin(u * 40), side * (HALF + 0.12))), 0.03, ROPE, 5);
    // suspension cable: 3.2 m above the deck at the posts, sagging to 1.9 m at mid-span
    const cable = (u: number) => new Vector3(u * L, deck(u) + 3.2 - 1.3 * 4 * u * (1 - u), side * (HALF + 0.28));
    rope(line(cable), 0.05, ROPE_DARK, 6);
    // hanging ropes from the cable to the deck edge every ~1.6 m, with a knot where they meet the handrail
    for (let hx = 1.0; hx < L - 0.6; hx += 1.55 + (rng() - 0.5) * 0.25) {
      const u = hx / L;
      const top = cable(u);
      const bottom = new Vector3(hx, deck(u) - 0.05, side * (HALF + 0.12));
      const mid = top.clone().lerp(bottom, 0.5);
      mid.z += side * 0.05;
      rope([top, mid, bottom], 0.014, ROPE, 4);
    }
    // guy ropes: from each post top back to a ground stake
    for (const end of [0, 1]) {
      const px = end === 0 ? -0.35 : L + 0.35;
      const top = new Vector3(px, deck(end) + 3.3, side * (HALF + 0.28));
      const ax = px + (end === 0 ? -6.0 : 6.0);
      const az = side * 2.4;
      const ground = terrainHeight(BRIDGE.ax + ax, BRIDGE.az + az) - BRIDGE.y;
      rope([top, new Vector3((px + ax) / 2, (top.y + ground) / 2 - 0.12, (top.z + az) / 2), new Vector3(ax, ground + 0.12, az)], 0.035, ROPE_DARK, 5);
      // stake
      parts.push({ geo: new CylinderGeometry(0.07, 0.09, 0.9, 6), m: mat(ax, ground + 0.15, az, 0.25 * (end === 0 ? 1 : -1), 0, 0.2 * side), color: WOOD_DARK });
    }
  }
  // --- log posts + cross beams at each end ---
  for (const end of [0, 1]) {
    const px = end === 0 ? -0.35 : L + 0.35;
    const baseY = deck(end) - 1.6;
    for (const side of [-1, 1]) {
      parts.push({ geo: new CylinderGeometry(0.14, 0.19, 5.4, 8), m: mat(px, baseY + 2.7, side * (HALF + 0.28), 0, rng() * 6, (end === 0 ? -1 : 1) * 0.06), color: lerpColor(WOOD_DARK, WOOD_LIGHT, 0.3 + rng() * 0.2) });
    }
    parts.push({ geo: new CylinderGeometry(0.09, 0.09, HALF * 2 + 0.8, 6), m: mat(px, deck(end) + 3.05, 0, Math.PI / 2, 0, 0), color: WOOD_DARK });
    parts.push({ geo: new BoxGeometry(0.5, 0.18, HALF * 2 + 0.9), m: mat(end === 0 ? -0.5 : L + 0.5, deck(end) - 0.12, 0), color: WOOD_DARK });
  }
  const mesh = new Mesh(mergeParts(parts), barkMaterial);
  mesh.name = 'RopeBridge';
  return mesh;
}

/** Invisible walkable deck (a sagging strip following the same line as the planks) with rail walls. Local frame as above. */
export function createBridgeColliders(): Mesh {
  const parts: Part[] = [];
  const white = '#ffffff';
  const segs = 24;
  const q = new Quaternion();
  for (let i = 0; i < segs; i++) {
    const u0 = i / segs;
    const u1 = (i + 1) / segs;
    const x0 = u0 * L;
    const x1 = u1 * L;
    const y0 = deck(u0);
    const y1 = deck(u1);
    const len = Math.hypot(x1 - x0, y1 - y0) + 0.06;
    const ang = Math.atan2(y1 - y0, x1 - x0);
    // deck slab: 0.3 m thick, 3.4 m wide (wider than the planks so the capsule never slips off the edge)
    q.setFromAxisAngle(new Vector3(0, 0, 1), ang);
    parts.push({ geo: new BoxGeometry(len, 0.3, HALF * 2 + 0.3), m: new Matrix4().compose(new Vector3((x0 + x1) / 2, (y0 + y1) / 2 - 0.15, 0), q.clone(), new Vector3(1, 1, 1)), color: white });
    // rail walls at +-1.0 m from the axis (outside the handrails), 2.4 m tall above the deck
    for (const side of [-1, 1]) {
      parts.push({ geo: new BoxGeometry(len, 2.6, 0.12), m: new Matrix4().compose(new Vector3((x0 + x1) / 2, (y0 + y1) / 2 + 1.1, side * (HALF + 0.24)), q.clone(), new Vector3(1, 1, 1)), color: white });
    }
  }
  // approach ramps / end caps: a short strip beyond each end that overlaps the ground abutments
  for (const end of [0, 1]) {
    const x = end === 0 ? -0.8 : L + 0.8;
    parts.push({ geo: new BoxGeometry(2.0, 0.3, HALF * 2 + 0.3), m: mat(x, deck(end) - 0.15, 0), color: white });
    for (const side of [-1, 1]) parts.push({ geo: new BoxGeometry(2.0, 2.6, 0.12), m: mat(x, deck(end) + 1.1, side * (HALF + 0.24)), color: white });
  }
  const mesh = new Mesh(mergeParts(parts), new MeshBasicMaterial({ visible: false }));
  mesh.visible = false;
  mesh.name = 'BridgeColliders';
  return mesh;
}

export type { BufferGeometry };

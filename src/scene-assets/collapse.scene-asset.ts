/**
 * The collapsing ledge, as assets (Prompt 04). Logic lives in world/collapse.ts (pure) and systems/collapse-system.ts.
 *
 *   collapse-shelf    Group of slabs covering the hollow in the ledge: per row one RIDE piece (the walking surface and
 *                     its inner side; it sinks with the walking collider) and one LIP piece (the valley-side edge; it
 *                     breaks away and tumbles), plus the crack overlay. Meshes are centred on their own rest position
 *                     so the system only sets position/rotation. Separate from every static batch.
 *   shelf-collider    the kinematic walking surface (invisible). Same line as the slab tops, 0.4 m thick.
 * The slab tops use the terrain's own ground colour and material so the shelf is a continuation of the ledge.
 */
import { BufferGeometry, Color, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, Uint32BufferAttribute } from '@iwsdk/core';
import { MTN, fbm, makeRandom, smoothstep } from '../world/layout.js';
import { CLEFT } from '../world/mountain.js';
import { SHELF, rowBounds, shelfLip, shelfTopY, worldAt } from '../world/collapse.js';
import { PAL } from '../world/palette.js';
import { mountainGroundMaterial, crackMaterial } from './lib/materials.js';
import { groundColor } from './terrain.scene-asset.js';

const ROCK = new Color(PAL.cliff);
const ROCK_DARK = new Color(PAL.cliffDark);
const ROCK_WARM = new Color(PAL.cliffWarm);
const DIRT = new Color(PAL.soil).lerp(new Color(PAL.litter), 0.25);

interface Corner {
  s: number;
  l: number;
}

/** A slab between four corners (s, l), subdivided g x g on top, with a lumpy underside. Positions are returned relative to the centre. */
function slab(c00: Corner, c10: Corner, c11: Corner, c01: Corner, g: number, seed: number): { geo: BufferGeometry; center: [number, number, number] } {
  const rng = makeRandom(seed);
  const pt = (u: number, v: number): Corner => ({
    s: (c00.s * (1 - u) + c10.s * u) * (1 - v) + (c01.s * (1 - u) + c11.s * u) * v,
    l: (c00.l * (1 - u) + c10.l * u) * (1 - v) + (c01.l * (1 - u) + c11.l * u) * v,
  });
  const world = (q: Corner, drop = 0) => {
    const w = worldAt(q.s, q.l);
    return [w.x, shelfTopY(q.s, q.l) - drop, w.z] as const;
  };
  const top: number[] = [];
  const topCol: number[] = [];
  const tmp = new Color();
  const grid: number[][] = [];
  for (let j = 0; j <= g; j++) {
    for (let i = 0; i <= g; i++) {
      const q = pt(i / g, j / g);
      const [x, y, z] = world(q);
      const yy = y + (fbm(x * 1.7, z * 1.7, 93, 2) - 0.5) * 0.05;
      (grid[j] ??= [])[i] = top.length / 3;
      top.push(x, yy, z);
      groundColor(x, z, 0.12, tmp, yy);
      // The worn walking line: dirt in the middle of the corridor, ground colour towards the edges.
      const ly = Math.abs(q.l);
      tmp.lerp(DIRT, (1 - smoothstep(0.9, 1.9, ly)) * 0.65 * (0.75 + 0.25 * fbm(x * 1.2, z * 1.2, 94, 2)));
      topCol.push(tmp.r, tmp.g, tmp.b);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < g; j++) {
    for (let i = 0; i < g; i++) {
      const a = grid[j][i];
      const b = grid[j][i + 1];
      const c = grid[j + 1][i];
      const d = grid[j + 1][i + 1];
      idx.push(a, c, b, b, c, d);
    }
  }
  const pos = top.slice();
  const col = topCol.slice();
  // perimeter loop (counter-clockwise from above): bottom row, right column, top row reversed, left column reversed
  const loop: number[] = [];
  for (let i = 0; i < g; i++) loop.push(grid[0][i]);
  for (let j = 0; j < g; j++) loop.push(grid[j][g]);
  for (let i = g; i > 0; i--) loop.push(grid[g][i]);
  for (let j = g; j > 0; j--) loop.push(grid[j][0]);
  // centre of the slab (top)
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const k of loop) {
    cx += pos[k * 3];
    cy += pos[k * 3 + 1];
    cz += pos[k * 3 + 2];
  }
  cx /= loop.length;
  cy /= loop.length;
  cz /= loop.length;
  // sides: top-edge copies (hard edge) and bottom-edge vertices pulled inwards and down by a lumpy thickness
  const topCopy: number[] = [];
  const botIdx: number[] = [];
  loop.forEach((k, n) => {
    const x = pos[k * 3];
    const y = pos[k * 3 + 1];
    const z = pos[k * 3 + 2];
    topCopy.push(pos.length / 3);
    pos.push(x, y, z);
    const strata = 0.5 + 0.5 * Math.sin(n * 1.3 + seed);
    tmp.copy(ROCK).lerp(ROCK_DARK, 0.25 + 0.3 * strata).lerp(ROCK_WARM, rng() * 0.35);
    col.push(tmp.r, tmp.g, tmp.b);
  });
  loop.forEach((k) => {
    const x = pos[k * 3];
    const y = pos[k * 3 + 1];
    const z = pos[k * 3 + 2];
    botIdx.push(pos.length / 3);
    const inset = 0.1 + rng() * 0.22;
    const t = SHELF.thickness * (0.8 + rng() * 0.45);
    pos.push(x + (cx - x) * inset, y - t, z + (cz - z) * inset);
    tmp.copy(ROCK_DARK).lerp(ROCK, rng() * 0.3);
    col.push(tmp.r, tmp.g, tmp.b);
  });
  const n = loop.length;
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n;
    idx.push(topCopy[k], botIdx[k], topCopy[k2], topCopy[k2], botIdx[k], botIdx[k2]);
  }
  // underside: a fan to a lowered centre
  const cIdx = pos.length / 3;
  pos.push(cx, cy - SHELF.thickness * 1.1, cz);
  col.push(ROCK_DARK.r * 0.8, ROCK_DARK.g * 0.8, ROCK_DARK.b * 0.8);
  for (let k = 0; k < n; k++) idx.push(botIdx[(k + 1) % n], botIdx[k], cIdx);
  // re-centre
  for (let i = 0; i < pos.length; i += 3) {
    pos[i] -= cx;
    pos[i + 1] -= cy;
    pos[i + 2] -= cz;
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return { geo, center: [cx, cy, cz] };
}

export function createShelf(): Group {
  const grp = new Group();
  grp.name = 'CollapseShelf';
  const bounds = rowBounds();
  const lip = shelfLip();
  const rng = makeRandom(5740);
  const lj = (i: number, j: number) => (rng() - 0.5) * 0.3 + (i === 0 || i === SHELF.rows ? 0 : 0) + j * 0;
  // corner lattice: i = row boundary 0..rows, j = 0 (rideMin) / 1 (rideEdge) / 2 (lip)
  const L = [SHELF.rideMin, SHELF.rideEdge, lip];
  const corner: Corner[][] = [];
  for (let i = 0; i <= SHELF.rows; i++) {
    corner[i] = [];
    for (let j = 0; j < 3; j++) corner[i][j] = { s: bounds[i] + (i === 0 || i === SHELF.rows ? 0 : lj(i, j)), l: L[j] + (j === 0 ? 0 : lj(i, j) * 0.8) };
  }
  for (let r = 0; r < SHELF.rows; r++) {
    for (const [name, j0] of [['ShelfRide', 0], ['ShelfLip', 1]] as const) {
      const a = corner[r][j0];
      const b = corner[r + 1][j0];
      const c = corner[r + 1][j0 + 1];
      const d = corner[r][j0 + 1];
      const { geo, center } = slab(a, b, c, d, j0 === 0 ? 4 : 3, 700 + r * 7 + j0);
      const m = new Mesh(geo, mountainGroundMaterial);
      m.name = `${name}_${r}`;
      m.position.set(center[0], center[1], center[2]);
      m.receiveShadow = false;
      grp.add(m);
    }
  }
  // While the shelf is intact it is drawn as ONE merged mesh (one draw instead of eight); the separate pieces are only shown from the break on.
  grp.add(mergeSlabs(grp.children.filter((c) => /^Shelf(Ride|Lip)_/.test(c.name)) as Mesh[]));
  for (const c of grp.children) if (/^Shelf(Ride|Lip)_/.test(c.name)) c.visible = false;
  // Cracks: dark ribbons on the slab tops, mostly along the row seams and the ride/lip seam, with short branches.
  grp.add(createCracks(corner, lip));
  return grp;
}

/** The slabs as one world-space mesh (they start at their rest positions). */
function mergeSlabs(slabs: Mesh[]): Mesh {
  let vc = 0;
  let ic = 0;
  for (const m of slabs) {
    vc += m.geometry.getAttribute('position').count;
    ic += m.geometry.index!.count;
  }
  const pos = new Float32Array(vc * 3);
  const nor = new Float32Array(vc * 3);
  const col = new Float32Array(vc * 3);
  const idx = new Uint32Array(ic);
  let vo = 0;
  let io = 0;
  for (const m of slabs) {
    const g = m.geometry;
    const n = g.getAttribute('position').count;
    for (let i = 0; i < n; i++) {
      pos[(vo + i) * 3] = g.getAttribute('position').getX(i) + m.position.x;
      pos[(vo + i) * 3 + 1] = g.getAttribute('position').getY(i) + m.position.y;
      pos[(vo + i) * 3 + 2] = g.getAttribute('position').getZ(i) + m.position.z;
      nor[(vo + i) * 3] = g.getAttribute('normal').getX(i);
      nor[(vo + i) * 3 + 1] = g.getAttribute('normal').getY(i);
      nor[(vo + i) * 3 + 2] = g.getAttribute('normal').getZ(i);
      col[(vo + i) * 3] = g.getAttribute('color').getX(i);
      col[(vo + i) * 3 + 1] = g.getAttribute('color').getY(i);
      col[(vo + i) * 3 + 2] = g.getAttribute('color').getZ(i);
    }
    for (let i = 0; i < g.index!.count; i++) idx[io + i] = g.index!.getX(i) + vo;
    io += g.index!.count;
    vo += n;
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new Float32BufferAttribute(col, 3));
  geo.setIndex(new Uint32BufferAttribute(idx, 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const m = new Mesh(geo, mountainGroundMaterial);
  m.name = 'ShelfIntact';
  return m;
}

function createCracks(corner: Corner[][], lip: number): Mesh {
  const rng = makeRandom(5750);
  const pos: number[] = [];
  const idx: number[] = [];
  const ribbon = (pts: Corner[], w0: number) => {
    const base = pos.length / 3;
    pts.forEach((p, k) => {
      const q = pts[Math.min(pts.length - 1, k + 1)];
      const o = pts[Math.max(0, k - 1)];
      const a = worldAt(o.s, o.l);
      const b = worldAt(q.s, q.l);
      const tx = b.x - a.x;
      const tz = b.z - a.z;
      const tl = Math.hypot(tx, tz) || 1;
      const nx = -tz / tl;
      const nz = tx / tl;
      const w = worldAt(p.s, p.l);
      const y = shelfTopY(p.s, p.l) + 0.018;
      const half = w0 * (0.45 + 0.55 * Math.sin((Math.PI * (k + 0.5)) / pts.length)) * (0.7 + rng() * 0.6);
      pos.push(w.x - nx * half, y, w.z - nz * half, w.x + nx * half, y, w.z + nz * half);
    });
    for (let k = 0; k < pts.length - 1; k++) {
      const a = base + k * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  };
  const jag = (s0: number, l0: number, s1: number, l1: number, step = 0.22, amp = 0.09): Corner[] => {
    const len = Math.hypot(s1 - s0, l1 - l0);
    const n = Math.max(3, Math.round(len / step));
    const out: Corner[] = [];
    for (let k = 0; k <= n; k++) {
      const u = k / n;
      const nx = -(l1 - l0) / len;
      const ny = (s1 - s0) / len;
      const j = (fbm(u * 9 + s0, l0 * 3, 95, 2) - 0.5) * 2 * amp * (k === 0 || k === n ? 0 : 1);
      out.push({ s: s0 + (s1 - s0) * u + nx * j, l: l0 + (l1 - l0) * u + ny * j });
    }
    return out;
  };
  // Seams between rows across the whole slab, and along the ride/lip seam.
  for (let i = 1; i < SHELF.rows; i++) {
    const a = corner[i][0];
    const c = corner[i][2];
    ribbon(jag(a.s, a.l, c.s, c.l), 0.032);
  }
  ribbon(jag(corner[0][1].s + 0.1, corner[0][1].l, corner[SHELF.rows][1].s - 0.1, corner[SHELF.rows][1].l), 0.034);
  // extra irregular cracks across the walking line
  for (let k = 0; k < 7; k++) {
    const s = corner[0][0].s + 0.8 + rng() * (corner[SHELF.rows][0].s - corner[0][0].s - 1.6);
    const l0 = -1.9 + rng() * 1.4;
    const l1 = l0 + 1.2 + rng() * 2.4;
    ribbon(jag(s, l0, s + (rng() - 0.5) * 1.3, Math.min(lip - 0.2, l1), 0.2, 0.12), 0.022 + rng() * 0.016);
    // a short branch
    const bs = s + (rng() - 0.5) * 0.6;
    const bl = l0 + (l1 - l0) * (0.35 + rng() * 0.4);
    ribbon(jag(bs, bl, bs + (rng() - 0.5) * 1.1, bl + (rng() - 0.5) * 1.0, 0.2, 0.07), 0.014);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  const m = new Mesh(g, crackMaterial);
  m.name = 'ShelfCracks';
  m.renderOrder = 4;
  return m;
}

/** The kinematic walking surface of the shelf: a 0.4 m slab along the route line, l in [rideMin, rideEdge]. World coordinates. */
export function createShelfCollider(): Mesh {
  const { s0, s1 } = MTN.cleft;
  const N = 14;
  const pos: number[] = [];
  const idx: number[] = [];
  const ls = [SHELF.rideMin, SHELF.rideEdge];
  for (let i = 0; i <= N; i++) {
    const s = s0 - 0.5 + ((s1 - s0 + 1.0) * i) / N;
    for (const l of ls) {
      const w = worldAt(s, l);
      const y = shelfTopY(s, l) - 0.015;
      pos.push(w.x, y, w.z); // top
      pos.push(w.x, y - 0.4, w.z); // bottom
    }
  }
  const v = (i: number, side: number, bottom: number) => i * 4 + side * 2 + bottom;
  for (let i = 0; i < N; i++) {
    for (const bottom of [0, 1]) {
      const a = v(i, 0, bottom);
      const b = v(i, 1, bottom);
      const c = v(i + 1, 0, bottom);
      const d = v(i + 1, 1, bottom);
      if (bottom === 0) idx.push(a, c, b, b, c, d);
      else idx.push(a, b, c, b, d, c);
    }
    for (const side of [0, 1]) {
      const a = v(i, side, 0);
      const b = v(i, side, 1);
      const c = v(i + 1, side, 0);
      const d = v(i + 1, side, 1);
      idx.push(a, b, c, b, d, c);
    }
  }
  // end caps
  for (const i of [0, N]) {
    const a = v(i, 0, 0);
    const b = v(i, 0, 1);
    const c = v(i, 1, 0);
    const d = v(i, 1, 1);
    idx.push(a, b, c, b, d, c);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  const m = new Mesh(g, new MeshBasicMaterial({ visible: false }));
  m.visible = false;
  m.name = 'ShelfCollider';
  void CLEFT;
  return m;
}

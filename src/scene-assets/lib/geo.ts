/**
 * Geometry toolkit for the procedural jungle assets.
 *
 * Everything here is deterministic and free of DOM / World access so it can be
 * evaluated in both the runtime and editor realms (see AGENTS.md).
 * Output is always a single merged BufferGeometry with position, normal, uv and
 * a baked vertex-colour attribute, so every asset costs exactly one draw call
 * (and, when it is a single Mesh, can be GPU-instanced by scene patterns).
 */
import { tileUV } from './leaf-atlas.js';
import type { LeafTile } from './leaf-atlas.js';
import {
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  Euler,
  Float32BufferAttribute,
  Matrix3,
  Matrix4,
  Quaternion,
  Vector3,
} from '@iwsdk/core';

export type ColorFn = (p: Vector3, n: Vector3) => Color;

export interface Part {
  geo: BufferGeometry;
  /** Optional per-vertex normal override (after the transform): used for soft foliage lighting. */
  normalFn?: (p: Vector3, n: Vector3) => Vector3;
  /** Optional transform baked into the part. */
  m?: Matrix4;
  /** Constant colour or a per-vertex function (local position, world-ish normal). */
  color: string | number | Color | ColorFn;
}

const _p = new Vector3();
const _n = new Vector3();
const _c = new Color();
const _nm = new Matrix3();

/** Merge parts into one geometry with baked transforms and vertex colours. */
export function mergeParts(parts: Part[]): BufferGeometry {
  let vCount = 0;
  let iCount = 0;
  for (const part of parts) {
    vCount += part.geo.getAttribute('position').count;
    iCount += part.geo.index ? part.geo.index.count : part.geo.getAttribute('position').count;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const col = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const idx = new Uint32Array(iCount);
  let vo = 0;
  let io = 0;
  for (const part of parts) {
    const g = part.geo;
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const gp = g.getAttribute('position');
    const gn = g.getAttribute('normal');
    const gu = g.getAttribute('uv');
    const m = part.m;
    if (m) _nm.getNormalMatrix(m);
    const fixed = typeof part.color === 'function' ? null : new Color(part.color as string | number | Color);
    for (let i = 0; i < gp.count; i++) {
      _p.fromBufferAttribute(gp, i);
      _n.fromBufferAttribute(gn, i);
      const localP = _p.clone();
      const localN = _n.clone();
      if (m) {
        _p.applyMatrix4(m);
        _n.applyMatrix3(_nm).normalize();
      }
      if (part.normalFn) _n.copy(part.normalFn(_p, _n)).normalize();
      const o = (vo + i) * 3;
      pos[o] = _p.x;
      pos[o + 1] = _p.y;
      pos[o + 2] = _p.z;
      nor[o] = _n.x;
      nor[o + 1] = _n.y;
      nor[o + 2] = _n.z;
      const c = fixed ?? (part.color as ColorFn)(m ? _p : localP, m ? _n : localN);
      _c.copy(c);
      col[o] = _c.r;
      col[o + 1] = _c.g;
      col[o + 2] = _c.b;
      if (gu) {
        uv[(vo + i) * 2] = gu.getX(i);
        uv[(vo + i) * 2 + 1] = gu.getY(i);
      }
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.getX(i) + vo;
      io += g.index.count;
    } else {
      for (let i = 0; i < gp.count; i++) idx[io + i] = vo + i;
      io += gp.count;
    }
    vo += gp.count;
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(pos, 3));
  out.setAttribute('normal', new BufferAttribute(nor, 3));
  out.setAttribute('color', new BufferAttribute(col, 3));
  out.setAttribute('uv', new BufferAttribute(uv, 2));
  out.setIndex(new BufferAttribute(idx, 1));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

export function mat(
  px = 0,
  py = 0,
  pz = 0,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = sx,
  sz = sx,
): Matrix4 {
  const q = new Quaternion().setFromEuler(new Euler(rx, ry, rz, 'YXZ'));
  const m = new Matrix4().compose(new Vector3(px, py, pz), q, new Vector3(sx, sy, sz));
  return m;
}

/** Linear blend of two colours given as hex strings/numbers. */
export function lerpColor(a: string | number | Color, b: string | number | Color, t: number): Color {
  return new Color(a).lerp(new Color(b), Math.min(1, Math.max(0, t)));
}

/**
 * Tube along a Catmull-Rom curve with a per-t radius function.
 * Parallel-transport frames, so no twisting. Ends are closed with a point.
 */
export function tubeAlong(
  points: Vector3[],
  radius: (t: number) => number,
  radial = 6,
  segments = Math.max(4, points.length * 3),
): BufferGeometry {
  const curve = new CatmullRomCurve3(points, false, 'catmullrom', 0.5);
  const frames = curve.computeFrenetFrames(segments, false);
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const c = new Vector3();
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    curve.getPointAt(t, c);
    const N = frames.normals[i];
    const B = frames.binormals[i];
    const r = radius(t);
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const sin = Math.sin(a);
      const cos = Math.cos(a);
      positions.push(
        c.x + r * (cos * N.x + sin * B.x),
        c.y + r * (cos * N.y + sin * B.y),
        c.z + r * (cos * N.z + sin * B.z),
      );
      uvs.push(j / radial, t * curve.getLength() * 0.5);
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j;
      const b = i * radial + ((j + 1) % radial);
      const c2 = (i + 1) * radial + j;
      const d = (i + 1) * radial + ((j + 1) % radial);
      indices.push(a, c2, b, b, c2, d);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

/**
 * A curved leaf blade. Origin at the base, pointing +Y, width along X.
 * `bend` (radians) arcs the tip over toward +Z; edges lift slightly (V-shaped
 * midrib) so the blade catches light on both sides. Widest at ~35 % of length.
 */
export function leafBlade(length: number, width: number, bend: number, segs = 5): BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const w = 0.5 * width * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.65)), 0.9);
    const a = bend * t;
    const y = length * t * Math.cos(a * 0.5);
    const z = length * t * Math.sin(a * 0.5);
    // Normal of the spine in the YZ plane (towards the viewer side).
    const ny = -Math.sin(a);
    const nz = Math.cos(a);
    const lift = 0.3 * w;
    positions.push(-w, y + ny * lift, z + nz * lift, 0, y, z, w, y + ny * lift, z + nz * lift);
    uvs.push(0, t, 0.5, t, 1, t);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 3;
    const b = a + 3;
    indices.push(a, a + 1, b, a + 1, b + 1, b, a + 1, a + 2, b + 1, a + 2, b + 2, b + 1);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

/** Displace every vertex of a (non-indexed or indexed) geometry in place. */
export function displace(geo: BufferGeometry, fn: (p: Vector3, i: number) => void): BufferGeometry {
  const pos = geo.getAttribute('position');
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    fn(v, i);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** Counts triangles of a geometry. */
export function triCount(geo: BufferGeometry): number {
  return (geo.index ? geo.index.count : geo.getAttribute('position').count) / 3;
}


/**
 * A bent alpha-cutout card textured with one leaf-atlas tile.
 * Origin at the base centre, length along +Y, width along X; `bend` (radians) arcs the tip toward +Z.
 * Two triangles per segment: cheap geometry, the silhouette comes from the texture's alpha.
 */
export function cardGeometry(tile: LeafTile, length: number, width: number, bend = 0, segs = 2): BufferGeometry {
  const [u0, v0, u1, v1] = tileUV(tile);
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const a = bend * t;
    const y = length * t * Math.cos(a * 0.5);
    const z = length * t * Math.sin(a * 0.5);
    positions.push(-width / 2, y, z, width / 2, y, z);
    uvs.push(u0, v0 + t * (v1 - v0), u1, v0 + t * (v1 - v0));
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

/** Remap every UV of a (non-card) geometry into the atlas' neutral 'bark' tile centre (solid, opaque). */
export function solidUV(geo: BufferGeometry): BufferGeometry {
  const [u0, v0, u1, v1] = tileUV('bark');
  const uv = geo.getAttribute('uv');
  const cu = (u0 + u1) / 2;
  const cv = (v0 + v1) / 2;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, cu + (uv.getX(i) % 1) * 0.01, cv + (uv.getY(i) % 1) * 0.01);
  return geo;
}

/** Soft foliage normals: blend of "away from the plant centre" and straight up (lit like a rounded mass). */
export function softNormals(center: Vector3, upBias = 0.55): (p: Vector3, n: Vector3) => Vector3 {
  const out = new Vector3();
  return (p) => {
    out.copy(p).sub(center);
    if (out.lengthSq() < 1e-6) out.set(0, 1, 0);
    out.normalize().multiplyScalar(1 - upBias).add(new Vector3(0, upBias, 0));
    return out.normalize();
  };
}


/**
 * Merge already-baked geometries (position/normal/uv/colour, any colour item size) with a transform each.
 * Used to compose clusters/patches out of small assets and to fuse many world-space pieces into one draw call.
 */
export function mergeBaked(items: { geo: BufferGeometry; m?: Matrix4; /** per-instance colour multiplier [r,g,b] */ tint?: [number, number, number] }[], sway = false): BufferGeometry {
  let vCount = 0;
  let iCount = 0;
  let colorSize = 3;
  for (const it of items) {
    vCount += it.geo.getAttribute('position').count;
    iCount += it.geo.index ? it.geo.index.count : it.geo.getAttribute('position').count;
    const c = it.geo.getAttribute('color');
    if (c && c.itemSize === 4) colorSize = 4;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const col = new Float32Array(vCount * colorSize);
  const uv = new Float32Array(vCount * 2);
  const idx = new Uint32Array(iCount);
  /** Per-vertex wind/proximity weight (x) and the plant's height (y): 0 at the root, 1 at the tip of the prototype (only when `sway`). */
  const sw = sway ? new Float32Array(vCount * 2) : null;
  let vo = 0;
  let io = 0;
  const p = new Vector3();
  const n = new Vector3();
  const nm = new Matrix3();
  for (const it of items) {
    const g = it.geo;
    if (sw && !g.boundingBox) g.computeBoundingBox();
    const hgt = sw ? Math.max(0.0001, g.boundingBox!.max.y) : 1;
    const gp = g.getAttribute('position');
    const gn = g.getAttribute('normal');
    const gc = g.getAttribute('color');
    const gu = g.getAttribute('uv');
    if (it.m) nm.getNormalMatrix(it.m);
    for (let i = 0; i < gp.count; i++) {
      p.fromBufferAttribute(gp, i);
      if (sw) {
        const wgt = Math.min(1, Math.max(0, p.y / Math.max(hgt, 0.5)));
        sw[(vo + i) * 2] = Math.pow(wgt, 1.3);
        sw[(vo + i) * 2 + 1] = hgt;
      }
      if (it.m) p.applyMatrix4(it.m);
      pos.set([p.x, p.y, p.z], (vo + i) * 3);
      if (gn) {
        n.fromBufferAttribute(gn, i);
        if (it.m) n.applyMatrix3(nm).normalize();
        nor.set([n.x, n.y, n.z], (vo + i) * 3);
      }
      if (gc) {
        const o = (vo + i) * colorSize;
        const t = it.tint;
        col[o] = gc.getX(i) * (t ? t[0] : 1);
        col[o + 1] = gc.getY(i) * (t ? t[1] : 1);
        col[o + 2] = gc.getZ(i) * (t ? t[2] : 1);
        if (colorSize === 4) col[o + 3] = gc.itemSize === 4 ? gc.getW(i) : 1;
      }
      if (gu) uv.set([gu.getX(i), gu.getY(i)], (vo + i) * 2);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.getX(i) + vo;
    else for (let i = 0; i < gp.count; i++) idx[io++] = vo + i;
    vo += gp.count;
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(pos, 3));
  out.setAttribute('normal', new BufferAttribute(nor, 3));
  out.setAttribute('color', new BufferAttribute(col, colorSize));
  out.setAttribute('uv', new BufferAttribute(uv, 2));
  if (sw) out.setAttribute('aSway', new BufferAttribute(sw, 2));
  out.setIndex(new BufferAttribute(idx, 1));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}


/**
 * A card trimmed to the silhouette of its alpha shape: an N-gon fan instead of a square.
 * Alpha-tested fragments are shaded BEFORE the discard, so every square-corner fragment the texture
 * throws away is wasted fill-rate. The leaf-clump tile only fills a disc of radius ~0.455 of the tile;
 * an octagon of circumradius 0.49 covers it with ~68 % of the square's area (32 % fewer fragments)
 * for 6 extra triangles per card. Centred horizontally, base at y = 0 like `cardGeometry`, spans y 0..size.
 */
export function blobCardGeometry(tile: LeafTile, size: number, sides = 8, circumradius = 0.49): BufferGeometry {
  const [u0, v0, u1, v1] = tileUV(tile);
  const cu = (u0 + u1) / 2;
  const cv = (v0 + v1) / 2;
  const positions: number[] = [0, size / 2, 0];
  const uvs: number[] = [cu, cv];
  const indices: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2 + Math.PI / sides;
    const x = Math.cos(a) * circumradius;
    const y = Math.sin(a) * circumradius;
    positions.push(x * size, size / 2 + y * size, 0);
    uvs.push(cu + x * (u1 - u0), cv + y * (v1 - v0));
  }
  for (let i = 0; i < sides; i++) indices.push(0, 1 + i, 1 + ((i + 1) % sides));
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

#!/usr/bin/env node
/**
 * Shaded-relief PNG of the world height model (no GPU): plan view with contours, plus an optional
 * route overlay. Used to design/check the mountain landform.
 *   node tools/relief.mjs [--x0 20 --x1 420 --z0 -300 --z1 0 --step 2 --out perf-results/relief.png]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import * as L from '../src/world/layout.ts';
import * as M from '../src/world/mountain.ts';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const x0 = +arg('x0', 20), x1 = +arg('x1', 420), z0 = +arg('z0', -300), z1 = +arg('z1', 0), step = +arg('step', 2);
const out = arg('out', 'perf-results/relief.png');
const fn = arg('fn', 'terrainHeight');
const H = M[fn] ?? L[fn] ?? ((x, z) => L.terrainHeight(x, z));
const w = Math.round((x1 - x0) / step), h = Math.round((z1 - z0) / step);
const g = new Float32Array(w * h);
let mn = Infinity, mx = -Infinity;
for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const v = H(x0 + i * step, z0 + j * step); g[j * w + i] = v; mn = Math.min(mn, v); mx = Math.max(mx, v); }
const raw = Buffer.alloc((w * 3 + 1) * h);
const sun = [-0.5, 0.75, 0.43];
for (let j = 0; j < h; j++) {
  raw[j * (w * 3 + 1)] = 0;
  for (let i = 0; i < w; i++) {
    const a = g[j * w + Math.max(0, i - 1)], b = g[j * w + Math.min(w - 1, i + 1)];
    const c = g[Math.max(0, j - 1) * w + i], d = g[Math.min(h - 1, j + 1) * w + i];
    const nx = (a - b) / (2 * step), nz = (c - d) / (2 * step);
    const il = 1 / Math.hypot(nx, 1, nz);
    const shade = Math.max(0.15, (nx * sun[0] + sun[1] + nz * sun[2]) * il);
    const v = g[j * w + i];
    const t = (v - mn) / (mx - mn);
    const contour = Math.abs(((v + 1000) % 10) - 5) > 4.6 ? 0.55 : 1;
    const r = (60 + 190 * t) * shade * contour, gg = (110 + 110 * (1 - Math.abs(t - 0.4))) * shade * contour, bb = (70 + 70 * t) * shade * contour;
    const o = j * (w * 3 + 1) + 1 + i * 3;
    raw[o] = Math.min(255, r); raw[o + 1] = Math.min(255, gg); raw[o + 2] = Math.min(255, bb);
  }
}
if (arg('route', '1') === '1') {
  const put = (x, z, r, g, b) => { const i = Math.round((x - x0) / step), j = Math.round((z - z0) / step); if (i < 1 || j < 1 || i >= w - 1 || j >= h - 1) return; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const o = (j + dj) * (w * 3 + 1) + 1 + (i + di) * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; } };
  for (const q of L.MTN.samples) put(q.x, q.z, q.zone === 'bridge' ? 40 : 255, q.zone === 'bridge' ? 120 : 30, q.zone === 'bridge' ? 255 : 30);
  for (const q of L.MTN.samples) if (q.zone === 'cleft') put(q.x, q.z, 255, 255, 0);
}
const crc = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return (b) => { let c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }; })();
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cr]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
mkdirSync('perf-results', { recursive: true });
writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log(`${out}: ${w}x${h}, height ${mn.toFixed(1)} .. ${mx.toFixed(1)}`);

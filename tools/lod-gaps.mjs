#!/usr/bin/env node
/**
 * Pop-in / flash audit of the distance LOD (no browser, no GPU). Replays ChunkLodSystem's rules (4 Hz, per-cell hysteresis, the same
 * `chunkVisible`, cell grids and caps from world/layout.ts) for a player walking the trail, head swaying, and checks every tree:
 *   GAP    a tree inside the draw range that NEITHER its detailed cell nor its cheap cell draws (it vanishes: "respawns" when you move on)
 *   DOUBLE a tree drawn by BOTH versions at once (two trunks overlapping: shimmer / z-fight)
 *   FLASH  a cell that switches more than once within a 3 s window (visible flicker)
 *   POP    cells appearing/disappearing, per class, per 100 m walked (information)
 *   node tools/lod-gaps.mjs [--low] [--label name]
 */
import { createServer } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, configFile: false, logLevel: 'error', appType: 'custom', server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true } });
const L = await server.ssrLoadModule('/src/world/layout.ts');
const P = await server.ssrLoadModule('/src/world/placements.ts');
const low = process.argv.includes('--low');
const trees = P.treePlacements();
const cellKey = (cls, x, z) => { const [ix, iz] = L.chunkIndex(x, z, L.CELL_SIZE[cls]); return `${cls}:${ix}:${iz}`; };
// cells that exist: those containing at least one instance of that class
const cells = new Map();
const addCell = (cls, x, z) => { const [ix, iz] = L.chunkIndex(x, z, L.CELL_SIZE[cls]); const k = `${cls}:${ix}:${iz}`; if (!cells.has(k)) cells.set(k, { cls, ix, iz, vis: process.argv.includes('--hidden-start') ? false : true, toggles: [] }); };
for (const t of trees) {
  if (t.lod === 'hi') { addCell('trees-hi', t.x, t.z); addCell('trees-lo', t.x, t.z); } else addCell('trees-far', t.x, t.z);
}
for (const kind of ['plants', 'ground']) for (const k of ['fern', 'broadleaf', 'shrub', 'palm', 'cover', 'flowers', 'moss', 'litter']) for (const p of P.plantPlacements(k)) addCell(kind === 'plants' && ['moss', 'litter', 'cover', 'flowers'].includes(k) ? 'ground' : 'plants', p.x, p.z);
const open = 0;
// the jungle cell cap grows with the knoll's position-based vista (100 -> 130 m in the high tier), exactly as in ChunkLodSystem
const capAt = (px, pz) => Math.min(L.viewCap(open), L.jungleCellCap(low ? 0 : L.vistaAt(px, pz) * (1 - open)));
const cap0 = capAt(1e6, 1e6);
let cap = capAt(L.SPAWN[0], L.SPAWN[1]);
const step = (px, pz, t) => {
  cap = capAt(px, pz);
  // same two passes as ChunkLodSystem: the cheap tree cell is drawn exactly when its detailed twin is not (and within the cap)
  for (let pass = 0; pass < 2; pass++) for (const c of cells.values()) {
    if ((c.cls === 'trees-lo') !== (pass === 1)) continue;
    const d = L.cellDistance(px, pz, c.ix, c.iz, L.CELL_SIZE[c.cls]);
    const show = c.cls === 'trees-lo' ? !cells.get(`trees-hi:${c.ix}:${c.iz}`).vis && d <= cap : L.chunkVisible(c.cls, d, low, cap, c.vis);
    if (show !== c.vis) { c.toggles.push(t); c.vis = show; }
  }
};
let gaps = 0, doubles = 0, samples = 0, gapTrees = new Set(), worst = { d: 0 };
const path = L.PATH_SAMPLES;
let walked = 0, popEvents = 0;
const DT = 0.25;
let t = 0;
for (let i = 1; i < path.length; i++) {
  const a = path[i - 1], b = path[i];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(1, Math.round(len / (1.8 * DT)));
  for (let k = 0; k < n; k++) {
    const u = (k + 1) / n;
    // head sway +-0.15 m
    const px = a[0] + (b[0] - a[0]) * u + 0.15 * Math.sin(t * 2.1), pz = a[1] + (b[1] - a[1]) * u + 0.15 * Math.cos(t * 1.7);
    t += DT; walked += len / n;
    step(px, pz, t);
    for (const tr of trees) {
      const d = Math.hypot(tr.x - px, tr.z - pz);
      // the low tier deliberately drops the far tree wall beyond CHUNK_LOW_MAX['trees-far'] (60 m): not a gap
      if (d > (low && tr.lod === 'lo' ? (L.CHUNK_LOW_MAX['trees-far'] ?? cap) : cap) - 6) continue;
      samples++;
      const hv = [];
      if (tr.lod === 'hi') { hv.push(cells.get(cellKey('trees-hi', tr.x, tr.z)).vis, cells.get(cellKey('trees-lo', tr.x, tr.z)).vis); }
      else hv.push(cells.get(cellKey('trees-far', tr.x, tr.z)).vis);
      const drawn = hv.filter(Boolean).length;
      if (drawn === 0 && gaps === 0) { const kh = cellKey('trees-hi', tr.x, tr.z), kl = cellKey('trees-lo', tr.x, tr.z); console.log('first gap:', tr.lod, tr.x.toFixed(1), tr.z.toFixed(1), 'player', px.toFixed(1), pz.toFixed(1), 'tree dist', d.toFixed(1), 'cells', kh, cells.get(kh)?.vis, kl, cells.get(kl)?.vis, 'far', cells.get(cellKey('trees-far', tr.x, tr.z))?.vis); }
      if (drawn === 0) { gaps++; gapTrees.add(tr); if (d > worst.d) worst = { d, tr }; }
      if (drawn > 1) doubles++;
    }
  }
}
let flashes = 0, pops = {};
for (const c of cells.values()) {
  pops[c.cls] = (pops[c.cls] ?? 0) + c.toggles.length;
  for (let i = 2; i < c.toggles.length; i++) if (c.toggles[i] - c.toggles[i - 2] < 3) flashes++;
}
console.log(`walked ${walked.toFixed(0)} m (${t.toFixed(0)} s at 1.8 m/s), ${trees.length} trees, tier ${low ? 'low' : 'high'}, draw cap ${cap0}..${capAt(L.SPAWN[0], L.SPAWN[1])} m (vista-scaled)`);
console.log(`GAP    ${gaps} tree-samples (${(100 * gaps / samples).toFixed(2)} %) with no version drawn; ${gapTrees.size} different trees vanish at some point${worst.tr ? `; worst: tree at (${worst.tr.x.toFixed(0)}, ${worst.tr.z.toFixed(0)}) ${worst.d.toFixed(0)} m away` : ''}`);
console.log(`DOUBLE ${doubles} tree-samples (${(100 * doubles / samples).toFixed(2)} %) drawn by both detail levels`);
console.log(`FLASH  ${flashes} cell switches that reverse within 3 s`);
console.log(`POP    toggles per 100 m: ${Object.entries(pops).map(([k, v]) => `${k} ${(v / walked * 100).toFixed(1)}`).join(', ')}`);
await server.close();
process.exit(gaps || flashes ? 1 : 0);

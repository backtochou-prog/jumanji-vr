#!/usr/bin/env node
/**
 * Live pop-in check in the real page: at positions along the trail (walked, then teleported), asks the scene which trees are drawn by NEITHER their
 * detailed nor their cheap cell (a vanished tree). Uses the real ChunkLodSystem and the real chunk meshes (their `visible` flags).
 *   node tools/lod-live.mjs        (needs: npx vite --port 8081)
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(root + '/')('playwright-core');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome', headless: true, args: ['--no-sandbox', '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('https://localhost:8081/?desktop=1&perf=0&governor=0&pixelratio=0.25', { waitUntil: 'load' });
await page.waitForFunction(() => window.__jumanjiWildlife?.ready && window.__jumanjiPerf?.world?.scene?.getObjectByName('Rope bridge'), null, { timeout: 290000 });
await page.waitForTimeout(3000);
let res = await page.evaluate(async () => {
  const L = await import('/src/world/layout.ts');
  const P = await import('/src/world/placements.ts');
  const W = window.__jumanjiWildlife;
  const world = window.__jumanjiPerf.world;
  const trees = P.treePlacements();
  const cell = (cls, x, z) => { const [ix, iz] = L.chunkIndex(x, z, L.CELL_SIZE[cls]); return `veg ${cls} ${ix} ${iz}`; };
  const byName = new Map();
  world.scene.traverse((o) => { if (/^veg trees-/.test(o.name)) byName.set(o.name, o); });
  const vis = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
  const out = [];
  const stops = [];
  for (let i = 0; i < L.PATH_SAMPLES.length; i += 8) stops.push(L.PATH_SAMPLES[i]);
  stops.push([0.6, 11.5], [0, -57.5], [-20, -30], [15, -45]);
  for (const [x, z] of stops) {
    window.__jumanjiPerf.place(x, z, 0, W.terrainY(x, z), 0);
    await new Promise((r) => setTimeout(r, 900));
    let gaps = 0, doubles = 0, n = 0;
    for (const t of trees) {
      const d = Math.hypot(t.x - x, t.z - z);
      if (d > 94) continue;
      // mountain-side cells (origin x >= 30) are deliberately hidden from the jungle floor beyond 26 m (ChunkLodSystem mtnCap): not a gap
      const cls0 = t.lod === 'hi' ? 'trees-hi' : 'trees-far';
      const [cx] = L.chunkIndex(t.x, t.z, L.CELL_SIZE[cls0]);
      if (L.CHUNK_ORIGIN.x + cx * L.CELL_SIZE[cls0] >= 30 && d > 26) continue;
      n++;
      const names = t.lod === 'hi' ? [cell('trees-hi', t.x, t.z), cell('trees-lo', t.x, t.z)] : [cell('trees-far', t.x, t.z)];
      const drawn = names.filter((nm) => { const o = byName.get(nm); return o && vis(o); }).length;
      if (drawn === 0) { gaps++; if (!window.__gapInfo) window.__gapInfo = { x: t.x, y: t.y, z: t.z, kind: t.kind, lod: t.lod, scale: t.scale, names, exists: names.map((nm) => !!byName.get(nm)), vis: names.map((nm) => { const o = byName.get(nm); return o ? vis(o) : null; }) }; }
      if (drawn > 1) doubles++;
    }
    out.push({ x: +x.toFixed(1), z: +z.toFixed(1), trees: n, gaps, doubles });
  }
  return { out, info: window.__gapInfo };
});
const info = res.info;
res = res.out;
let g = 0, d = 0;
for (const r of res) { g += r.gaps; d += r.doubles; }
console.log('first gap tree:', JSON.stringify(info));
console.log(res.map((r) => `(${r.x},${r.z}) trees ${r.trees} gaps ${r.gaps} doubles ${r.doubles}`).join('\n'));
console.log(`\n${g === 0 && d === 0 && !errors.length ? 'PASS' : 'FAIL'}: ${res.length} positions (walk + teleports), ${g} vanished trees, ${d} double-drawn trees, ${errors.length} page errors ${errors.slice(0, 2).join(' | ')}`);
await browser.close();
process.exit(g || d || errors.length ? 1 : 0);

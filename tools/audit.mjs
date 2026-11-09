#!/usr/bin/env node
/**
 * Performance audit of the real runtime, station by station (headless Chromium, SOFTWARE GL).
 *
 *   npm run dev:runtime   (another terminal)      npm run audit [-- --label before --stations entrance,summit]
 *
 * EXACT and device independent (read from three.js / the scene / the app):
 *   draw calls, triangles       renderer.info after one full render (includes the sun shadow pass)
 *   programs, new programs      shader programs compiled so far / compiled while arriving at this station (a compile = a hitch)
 *   geometry / texture memory   summed over the unique geometries and textures in the scene (CPU-side bytes == GPU upload size)
 *   overdraw                    fragments per pixel per material class (src/diagnostics/overdraw.ts)
 *   CPU per system (ms/frame)   each ECS system's update(), measured in the page (real JS cost: valid on a desktop CPU only as a RELATIVE number)
 *   scene initialisation        navigation start -> scene built, plus the per-group procedural build times
 * NOT measured here (software rasteriser, no Quest): FPS, GPU time, fill-rate. Timings printed for renders are relative only.
 * Output: perf-results/audit-<label>-<time>.json
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(root + '/')('playwright-core');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const label = arg('label', 'run');
const exe = process.env.CHROMIUM ?? '/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome';
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
const t0 = Date.now();
await page.goto(`${arg('url', 'https://localhost:8081/')}?desktop=1&perf=0&governor=0&pixelratio=0.5${arg('query', '')}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__jumanjiPerf?.world?.scene?.children?.length >= 5 && window.__jumanjiPerf.world.scene.getObjectByName('Rope bridge'), null, { timeout: 290000 });
const initMs = Date.now() - t0;
const boot = await page.evaluate(async () => {
  const a = await import('/src/assets.ts');
  const nav = performance.getEntriesByType('navigation')[0];
  return { build: a.BUILD_TIMES, domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null };
});
await page.waitForTimeout(6000);
const poses = await page.evaluate(async () => {
  const L = await import('/src/world/layout.ts');
  const out = {};
  for (const [k, v] of Object.entries(L.TEST_POSES)) out[`jungle-${k}`] = { x: v.x, z: v.z, yawDeg: v.yawDeg };
  for (const [k, v] of Object.entries(L.MTN_VIEWS)) out[k] = { x: v.x, z: v.z, yawDeg: v.yawDeg, y: v.y, pitchDeg: v.pitchDeg };
  return out;
});
const wanted = arg('stations', Object.keys(poses).join(',')).split(',');
// per-system CPU wrapper
await page.evaluate(() => {
  const w = window.__jumanjiPerf.world;
  window.__sysTime = {};
  for (const s of w.systems) {
    const name = s.constructor?.name || 'system';
    if (typeof s.update !== 'function' || s.__wrapped) continue;
    const orig = s.update.bind(s);
    s.__wrapped = true;
    window.__sysTime[name] = { ms: 0, n: 0 };
    s.update = (d, t) => { const a = performance.now(); orig(d, t); const r = window.__sysTime[name]; r.ms += performance.now() - a; r.n++; };
  }
});
const memory = () => page.evaluate(() => {
  const w = window.__jumanjiPerf.world;
  const geos = new Set(), texs = new Set(), mats = new Set();
  let meshes = 0;
  w.scene.traverse((o) => { if (o.isMesh || o.isInstancedMesh) { meshes++; geos.add(o.geometry); (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { mats.add(m); for (const k of ['map', 'bumpMap', 'normalMap', 'emissiveMap', 'roughnessMap', 'alphaMap']) if (m[k]) texs.add(m[k]); }); } });
  let gb = 0;
  for (const g of geos) { for (const a of Object.values(g.attributes)) gb += a.array.byteLength; if (g.index) gb += g.index.array.byteLength; }
  let tb = 0;
  for (const t of texs) { const im = t.image; if (im?.width) tb += im.width * im.height * 4 * (t.generateMipmaps === false ? 1 : 1.33); }
  const i = w.renderer.info;
  return { meshes, geometries: geos.size, materials: mats.size, geometryMB: +(gb / 1048576).toFixed(2), textureMB: +(tb / 1048576).toFixed(2), rendererGeometries: i.memory.geometries, rendererTextures: i.memory.textures };
});
const rows = [];
let prevPrograms = await page.evaluate(() => window.__jumanjiPerf.world.renderer.info.programs.length);
const programsAtStart = prevPrograms;
console.log('station            draws   tris  newProg  cells  overdraw(cards raster/shaft/water+fall/opaque)  CPU update ms (all systems)');
for (const id of wanted) {
  const p = poses[id];
  if (!p) { console.log('unknown', id); continue; }
  await page.evaluate((p) => { window.__jumanjiPerf.place(p.x, p.z, p.yawDeg, p.y, p.pitchDeg); window.__jumanjiPerf.metrics.reset(); for (const k in window.__sysTime) { window.__sysTime[k].ms = 0; window.__sysTime[k].n = 0; } }, p);
  await page.waitForTimeout(+arg('settle', 7000));
  const r = await page.evaluate(() => {
    const w = window.__jumanjiPerf.world;
    const a = performance.now();
    w.renderer.render(w.scene, w.camera);
    const first = performance.now() - a;
    const b = performance.now();
    w.renderer.render(w.scene, w.camera);
    const second = performance.now() - b;
    const i = w.renderer.info;
    const m = window.__jumanjiPerf.metrics.summary(8000);
    const sys = Object.fromEntries(Object.entries(window.__sysTime).filter(([, v]) => v.n).map(([k, v]) => [k, +(v.ms / v.n).toFixed(3)]));
    return { calls: i.render.calls, tris: i.render.triangles, programs: i.programs.length, firstRenderMs: +first.toFixed(0), secondRenderMs: +second.toFixed(0), cells: window.__jumanjiPerf.metrics.cellsShown, updateMs: +m.updateMs.toFixed(3), frames: m.frames, sys, far: w.camera.far, fog: w.scene.fog?.density };
  });
  const od = await page.evaluate(() => window.__jumanjiPerf.overdraw(200));
  const newProg = r.programs - prevPrograms;
  prevPrograms = r.programs;
  rows.push({ station: id, ...r, newPrograms: newProg, overdraw: od });
  const topSys = Object.entries(r.sys).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(', ');
  console.log(`${id.padEnd(18)} ${String(r.calls).padStart(5)} ${String(Math.round(r.tris / 1000) + 'k').padStart(6)} ${String(newProg).padStart(7)} ${String(r.cells).padStart(6)}   ${od.cardsRasterLayersPerPixel.toFixed(1)}/${od.shaftLayersPerPixel.toFixed(1)}/${od.additiveLayersPerPixel.toFixed(1)}/${od.opaqueLayersPerPixel.toFixed(1)}   ${r.updateMs.toFixed(2)}  (${topSys})`);
}
const mem = await memory();
const out = { label, when: new Date().toISOString(), note: 'software-rasterised headless Chromium: draws/tris/programs/memory/overdraw are exact; render and frame timings are relative only', initMs, programsAtStart, programsEnd: prevPrograms, memory: mem, boot, rows };
mkdirSync(resolve(root, 'perf-results'), { recursive: true });
const file = resolve(root, 'perf-results', `audit-${label}-${out.when.replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`\ninit to scene ready ${(initMs / 1000).toFixed(1)} s (desktop, software GL); programs at start ${programsAtStart}, after visiting every station ${prevPrograms} (${prevPrograms - programsAtStart} compiled lazily = hitches)`);
console.log(`memory: ${mem.meshes} meshes, ${mem.geometries} geometries ${mem.geometryMB} MB, ${mem.materials} materials, textures ${mem.textureMB} MB`);
console.log('boot build ms:', JSON.stringify(Object.fromEntries(Object.entries(boot.build).map(([k, v]) => [k, Math.round(v)]))));
console.log('saved', file);
await browser.close();

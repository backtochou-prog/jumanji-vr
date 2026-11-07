#!/usr/bin/env node
/**
 * Repeatable desktop probe of the three test poses x both quality tiers.
 *
 *   npm run dev            (in another terminal; the probe needs the dev server)
 *   npm run perf:probe     [-- --poses entrance,trail,clearing --tiers high,low --pixelratio 0.5]
 *
 * For each pose and tier it loads ?test=<pose>&desktop=1 in headless Chromium, lets the built-in
 * test run (warm-up + sampling), then reports:
 *   - draw calls, triangles, visible vegetation cells (renderer.info: exact, device independent)
 *   - OVERDRAW per material class (src/diagnostics/overdraw.ts: exact, device independent)
 *   - frame / CPU / GPU timing: ONLY a relative indicator. Headless Chromium rasterises in software
 *     (SwiftShader); it says nothing about a Quest 2 and is labelled as such.
 * Also times the shader recompile caused by toggling renderer.shadowMap.enabled vs the caster switch
 * the quality governor actually uses. Results go to perf-results/probe-<time>.json.
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(root + '/');
const { chromium } = require('playwright-core');
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const poses = arg('poses', 'entrance,trail,clearing').split(',');
const tiers = arg('tiers', 'high,low').split(',');
const pixelratio = arg('pixelratio', '0.5');
const extraQuery = arg('query', '');
const url = arg('url', 'https://localhost:8081/');
const exe = process.env.CHROMIUM ?? '/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome';

const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl'] });
const out = { when: new Date().toISOString(), note: 'software-rasterised headless Chromium: timings are relative indicators only; draws/triangles/overdraw are exact', runs: [], shadowToggle: null };
const f = (v, d = 1) => (v === null || v === undefined ? 'n/a' : Number(v).toFixed(d));
console.log('pose      tier  draws  tris    cells  cardsOD(noOcc/visible)  shafts water opaque   frame(sw) cpu upd+render  gpu(sw)');
for (const pose of poses) {
  for (const tier of tiers) {
    const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
    await page.goto(`${url}?test=${pose}&desktop=1&warmup=3&sample=5&governor=0&perf=0&quality=${tier}&pixelratio=${pixelratio}${extraQuery}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__jumanjiPerf?.perfTest?.state === 'done', null, { timeout: 280000 });
    const r = await page.evaluate(() => window.__jumanjiPerf.perfTest.last);
    // Exact per-frame work read straight from renderer.info after one more frame (the timed sample can be empty when the
    // software rasteriser needs many seconds to compile the first frame).
    const live = await page.evaluate(() => {
      const w = window.__jumanjiPerf.world;
      w.renderer.render(w.scene, w.camera);
      return { draws: w.renderer.info.render.calls, tris: w.renderer.info.render.triangles, cells: window.__jumanjiPerf.metrics.cellsShown };
    });
    const od = await page.evaluate(() => window.__jumanjiPerf.overdraw(240));
    out.runs.push({ pose, tier, result: r, live, overdraw: od });
    console.log('          cards by class:', Object.entries(od.cardsByClass).map(([k, v]) => `${k} ${v}`).join('  '));
    console.log(`${pose.padEnd(9)} ${tier.padEnd(5)} ${String(live.draws).padStart(5)} ${String(Math.round(live.tris / 1000) + 'k').padStart(6)}  ${String(live.cells).padStart(5)}  ${f(od.cardsLayersPerPixel)} surv / ${f(od.cardsRasterLayersPerPixel)} raster (${f(od.cardsDiscardedPct, 0)}% discarded)     ${f(od.shaftLayersPerPixel)}   ${f(od.additiveLayersPerPixel)}   ${f(od.opaqueLayersPerPixel)}    ${f(r.frameMs.mean, 0)} ms   ${f(r.cpuMs.update)}+${f(r.cpuMs.render)}   ${f(r.gpuMs.mean, 0)}`);
    if (pose === poses[0] && tier === tiers[0]) {
      out.shadowToggle = await page.evaluate(() => {
        const w = window.__jumanjiPerf.world;
        const gl = w.renderer.getContext();
        const progs = () => w.renderer.info.programs.length;
        const frame = () => {
          const t = performance.now();
          w.renderer.render(w.scene, w.camera);
          gl.finish();
          return +(performance.now() - t).toFixed(0);
        };
        const step = (label, fn) => {
          const before = progs();
          fn();
          const first = frame();
          return { label, firstFrameMs: first, nextFrameMs: frame(), newPrograms: progs() - before, programs: progs() };
        };
        const casters = [];
        w.scene.traverse((o) => o.castShadow === true && casters.push(o));
        let light = null;
        w.scene.traverse((o) => o.isDirectionalLight && (light = o));
        const cam = light.shadow.camera;
        const orig = { l: cam.left, r: cam.right, t: cam.top, b: cam.bottom, f: cam.far };
        frame();
        frame();
        return [
          step('baseline (no change)', () => {}),
          step('renderer.shadowMap.enabled = false', () => (w.renderer.shadowMap.enabled = false)),
          step('renderer.shadowMap.enabled = true', () => (w.renderer.shadowMap.enabled = true)),
          step(`every mesh.castShadow = false (${casters.length} meshes; the OLD governor)`, () => casters.forEach((c) => (c.castShadow = false))),
          step('every mesh.castShadow = true', () => casters.forEach((c) => (c.castShadow = true))),
          step('shadow frustum shrunk to a point (the governor now)', () => { cam.left = -0.001; cam.right = 0.001; cam.top = 0.001; cam.bottom = -0.001; cam.far = cam.near + 0.01; cam.updateProjectionMatrix(); }),
          step('shadow frustum restored', () => { cam.left = orig.l; cam.right = orig.r; cam.top = orig.t; cam.bottom = orig.b; cam.far = orig.f; cam.updateProjectionMatrix(); }),
        ];
      });
    }
    await page.close();
  }
}
console.log('\nshader recompile test (software GL; newPrograms is exact, ms are relative):');
for (const r of out.shadowToggle ?? []) console.log(`  ${r.label.padEnd(58)} new programs ${r.newPrograms}  first frame ${r.firstFrameMs} ms  next ${r.nextFrameMs} ms`);
mkdirSync(resolve(root, 'perf-results'), { recursive: true });
const file = resolve(root, 'perf-results', `probe-${out.when.replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
console.log('saved', file);
await browser.close();

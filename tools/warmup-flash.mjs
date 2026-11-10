#!/usr/bin/env node
/**
 * Does the shader warm-up flash the whole world? Polls renderer.info (triangles / draws drawn in the last frame, the visible-object count) every
 * 150 ms from page start for ~14 s and reports the peak against the steady state. A warm-up that leaves hidden objects visible while it compiles
 * shows as a huge peak (everything drawn at once) that then collapses.
 *   node tools/warmup-flash.mjs      (needs: npx vite --port 8081)
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(root + '/')('playwright-core');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome', headless: true, args: ['--no-sandbox', '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
await page.addInitScript(() => {
  window.__samples = [];
  const t = setInterval(() => {
    const w = window.__jumanjiPerf?.world;
    if (!w) return;
    let vis = 0;
    w.scene.traverse((o) => { if (o.isMesh) { let v = true; for (let p = o; p; p = p.parent) if (!p.visible) { v = false; break; } if (v) vis++; } });
    window.__samples.push({ t: Math.round(performance.now()), vis, tris: w.renderer.info.render.triangles, calls: w.renderer.info.render.calls });
  }, 150);
});
await page.goto('https://localhost:8081/?desktop=1&perf=0&governor=0&pixelratio=0.25', { waitUntil: 'load' });
await page.waitForFunction(() => window.__jumanjiWildlife?.ready && window.__jumanjiPerf?.world?.scene?.getObjectByName('Rope bridge'), null, { timeout: 290000 });
await page.waitForTimeout(14000);
const s = await page.evaluate(() => window.__samples);
const log = await page.evaluate(() => null);
const steady = s.slice(-15);
const med = (a) => a.map((x) => x).sort((x, y) => x - y)[Math.floor(a.length / 2)];
const sv = med(steady.map((x) => x.vis)), st = med(steady.map((x) => x.tris));
const pv = Math.max(...s.map((x) => x.vis)), pt = Math.max(...s.map((x) => x.tris));
console.log(`visible meshes: steady ${sv}, peak ${pv}; triangles drawn: steady ${(st / 1000).toFixed(0)}k, peak ${(pt / 1000).toFixed(0)}k`);
const bad = pv > sv * 1.6;
console.log(bad ? 'FAIL: the world is drawn with far more objects than steady state during start-up (flash)' : 'PASS: no start-up flash (peak within 1.6x of steady state)');
await browser.close();
process.exit(bad ? 1 : 0);

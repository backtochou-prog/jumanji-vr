#!/usr/bin/env node
/**
 * Still captures of named viewpoints from the real runtime scene (headless Chromium, software GL).
 *   npm run dev:runtime   (another terminal)
 *   node tools/shot.mjs --views summit,summit-down,brink [--out artifacts/shots] [--w 960 --h 600] [--pixelratio 0.75]
 * Viewpoints are MTN_VIEWS in src/world/layout.ts plus the three TEST_POSES. Stills show composition and
 * detail only; they say nothing about frame rate.
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(root + '/')('playwright-core');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const views = arg('views', 'summit').split(',');
const out = resolve(root, arg('out', 'artifacts/shots'));
const W = +arg('w', 960), H = +arg('h', 600);
const url = arg('url', 'https://localhost:8081/');
const extra = arg('query', '');
mkdirSync(out, { recursive: true });
const exe = process.env.CHROMIUM ?? '/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome';
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`${url}?desktop=1&perf=0&governor=0&pixelratio=${arg('pixelratio', '1')}${extra}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__jumanjiPerf?.world?.scene?.children?.length >= 5, null, { timeout: 280000 });
const poses = await page.evaluate(async () => (await import('/src/world/layout.ts')).MTN_VIEWS);
for (const v of views) {
  const p = poses[v];
  if (!p) { console.log('unknown view', v); continue; }
  await page.evaluate((p) => { window.__jumanjiPerf.place(p.x, p.z, p.yawDeg, p.y, p.pitchDeg); }, p);
  // let locomotion settle, the atmosphere system ease, and the frame render
  await page.waitForTimeout(+arg('settle', 6000));
  const file = `${out}/${v}.jpg`;
  await page.screenshot({ path: file, type: 'jpeg', quality: 82 });
  const info = await page.evaluate(() => { const w = window.__jumanjiPerf.world; return { y: +w.player.position.y.toFixed(2), far: w.camera.far, calls: w.renderer.info.render.calls, tris: w.renderer.info.render.triangles }; });
  console.log(v, JSON.stringify(info), file);
}
await browser.close();

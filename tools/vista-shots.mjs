#!/usr/bin/env node
/**
 * Stills from the start (the knoll) and along the ramp: looks around from the spawn (0, +-45, +-90, 180 degrees from the waterfall heading), then at
 * a few ramp positions facing the gate. Eye height 1.65 m above the ground at each spot.
 *   node tools/vista-shots.mjs [--out artifacts/graphics/vista] [--only spawn,ramp]   (needs: npx vite --port 8081)
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(root + '/')('playwright-core');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const out = resolve(root, arg('out', 'artifacts/graphics/vista'));
mkdirSync(out, { recursive: true });
const only = arg('only', '').split(',').filter(Boolean);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome', headless: true, args: ['--no-sandbox', '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 650 } });
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await page.goto(`${arg('url', 'https://localhost:8081/')}?desktop=1&perf=0&governor=0&pixelratio=1`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__jumanjiWildlife?.ready && window.__jumanjiPerf?.world?.scene?.getObjectByName('Rope bridge'), null, { timeout: 600000 });
await page.waitForTimeout(8000);
const L = await page.evaluate(async () => { const l = await import('/src/world/layout.ts'); return { spawn: l.SPAWN, yaw: l.SPAWN_YAW_DEG }; });
const shots = [];
for (const d of [0, 45, -45, 90, -90, 180]) shots.push({ id: `spawn-yaw${d}`, group: 'spawn', x: L.spawn[0], z: L.spawn[1], yaw: L.yaw + d, pitch: d === 0 ? 4 : 0 });
shots.push({ id: 'spawn-up', group: 'spawn', x: L.spawn[0], z: L.spawn[1], yaw: L.yaw, pitch: 22 });
for (const [i, z] of [[0, 22], [1, 12], [2, 4], [3, -8]]) shots.push({ id: `ramp-${i}`, group: 'ramp', x: -0.4, z, yaw: 0, pitch: 0 });
for (const sh of shots) {
  if (only.length && !only.includes(sh.group)) continue;
  await page.evaluate(async ([s]) => { const l = await import('/src/world/layout.ts'); window.__jumanjiPerf.place(s.x, s.z, s.yaw, l.terrainHeight(s.x, s.z), s.pitch); }, [sh]);
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${out}/${sh.id}.png` });
  console.log('shot', sh.id);
}
await browser.close();

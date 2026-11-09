#!/usr/bin/env node
/**
 * Eye-height stills (1.65 m) of named jungle/ruin positions, optionally with a 1.8 m human reference figure standing 6 m ahead
 * (debug only: a plain capsule added for the picture, never part of the scene). Used to judge scale.
 *   node tools/eye-shots.mjs --out artifacts/scale/before [--figure 1] [--only temple,entrance]
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(root + '/')('playwright-core');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const out = resolve(root, arg('out', 'artifacts/scale/shots'));
mkdirSync(out, { recursive: true });
const figure = arg('figure', '0') === '1';
const only = arg('only', '').split(',').filter(Boolean);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome', headless: true, args: ['--no-sandbox', '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
await page.goto(`${arg('url', 'https://localhost:8081/')}?desktop=1&perf=0&governor=0&pixelratio=1`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__jumanjiPerf?.world?.scene?.getObjectByName('Rope bridge'), null, { timeout: 290000 });
await page.waitForTimeout(6000);
const L = await page.evaluate(async () => { const l = await import('/src/world/layout.ts'); return { TEMPLE: l.TEMPLE, SPIRE: l.SPIRE, PILLARS: l.PILLARS, ALTAR: l.ALTAR, CLIFF: l.CLIFF, ROOT_ARCH: l.ROOT_ARCH, views: l.MTN_VIEWS, SPAWN: l.SPAWN, ENTRANCE_TREES: l.ENTRANCE_TREES }; });
const T = L.TEMPLE;
const stations = [
  ['entrance', [L.SPAWN[0], L.SPAWN[1]], [L.SPAWN[0], 6, L.SPAWN[1] - 30]],
  ['gate-tree', [L.ENTRANCE_TREES[0][0] + 5, L.ENTRANCE_TREES[0][1] + 11], [L.ENTRANCE_TREES[0][0], 12, L.ENTRANCE_TREES[0][1]]],
  ['trail-mid', [-2, -30], [-1, 5, -45]],
  ['temple-approach', [0, T.z + T.depth / 2 + 22], [0, 4, T.z]],
  ['temple-close', [0, T.z + T.depth / 2 + 6], [0, 5, T.z]],
  ['pillar', [L.PILLARS[0].x + 1.5, L.PILLARS[0].z + 6], [L.PILLARS[0].x, 3, L.PILLARS[0].z]],
  ['altar', [L.ALTAR[0] + 1.5, L.ALTAR[1] + 4], [L.ALTAR[0], 1.4, L.ALTAR[1]]],
  ['spire', [L.SPIRE.x + 10, L.SPIRE.z + 38], [L.SPIRE.x, L.SPIRE.h * 0.55, L.SPIRE.z]],
  ['clearing-wide', [0, -50], [0, 8, -75]],
];
for (const [name, from, target] of stations) {
  if (only.length && !only.includes(name)) continue;
  await page.evaluate(async ([from, target, figure]) => {
    const l = await import('/src/world/layout.ts');
    const P = window.__jumanjiPerf, w = P.world;
    const gy = l.terrainHeight(from[0], from[1]);
    const dx = target[0] - from[0], dz = target[2] - from[1];
    const yaw = (Math.atan2(-dx, -dz) * 180) / Math.PI;
    const pitch = (Math.atan2(target[1] - (gy + 1.65), Math.hypot(dx, dz)) * 180) / Math.PI;
    P.place(from[0], from[1], yaw, gy, pitch);
    let fig = w.scene.getObjectByName('__scale_figure');
    if (fig) fig.removeFromParent();
    if (figure) {
      const T3 = P.three;
      const g = new T3.CylinderGeometry(0.22, 0.22, 1.8, 12);
      const m = new T3.Mesh(g, new T3.MeshBasicMaterial({ color: '#ff3b6b' }));
      m.name = '__scale_figure';
      const fx = from[0] + (dx / Math.hypot(dx, dz)) * 6, fz = from[1] + (dz / Math.hypot(dx, dz)) * 6;
      m.position.set(fx, l.terrainHeight(fx, fz) + 0.9, fz);
      w.scene.add(m);
    }
  }, [from, target, figure]);
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${out}/${name}.jpg`, type: 'jpeg', quality: 82 });
  console.log(name);
}
await browser.close();

#!/usr/bin/env node
/**
 * What is actually drawn from a viewpoint: every mesh that is visible (self + ancestors) AND inside the camera frustum, grouped by name.
 * Complements the CPU estimate in tools/asset-stats.mjs (which must agree with this within a few percent).
 *   node tools/visible-report.mjs [--x 0.6 --z 11.5 --yaw 0 --top 25]
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(root + '/')('playwright-core');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome', headless: true, args: ['--no-sandbox', '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
await page.goto('https://localhost:8081/?desktop=1&perf=0&governor=0&pixelratio=0.2', { waitUntil: 'load' });
await page.waitForFunction(() => window.__jumanjiPerf?.world?.scene?.getObjectByName('Rope bridge'), null, { timeout: 290000 });
await page.waitForTimeout(4000);
const res = await page.evaluate(async ([x, z, yaw]) => {
  const P = window.__jumanjiPerf; const w = P.world;
  const gy = window.__terrainY ? window.__terrainY(x, z) : 0;
  P.place(x, z, yaw, gy, 0);
  await new Promise((r) => setTimeout(r, 3500));
  const cam = w.camera; cam.updateMatrixWorld(true); cam.updateProjectionMatrix();
  const T = P.three;
  const out = {};
  const frustumTest = (() => {
    const m = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse);
    const e = m.elements; const planes = [];
    for (const [a, s] of [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]]) planes.push([e[3] + s * e[a], e[7] + s * e[a + 4], e[11] + s * e[a + 8], e[15] + s * e[a + 12]]);
    return (obj) => {
      const g = obj.geometry; if (!g.boundingSphere) g.computeBoundingSphere();
      const c = g.boundingSphere.center.clone().applyMatrix4(obj.matrixWorld); const sc = obj.matrixWorld.getMaxScaleOnAxis(); const r = g.boundingSphere.radius * sc;
      for (const p of planes) { const l = Math.hypot(p[0], p[1], p[2]); if ((p[0] * c.x + p[1] * c.y + p[2] * c.z + p[3]) / l < -r) return false; }
      return true;
    };
  })();
  w.scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    for (let a = o; a; a = a.parent) if (!a.visible) return;
    if (o.frustumCulled !== false && !frustumTest(o)) return;
    const g = o.geometry; const tris = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    let n = o.name || o.parent?.name || '?'; n = n.replace(/\d+/g, '#');
    const e = (out[n] ??= { draws: 0, tris: 0 }); e.draws++; e.tris += (o.isInstancedMesh ? o.count : 1) * tris;
  });
  return { out, far: cam.far, y: gy };
}, [arg('x', 0.6), arg('z', 11.5), arg('yaw', 0)]);
const rows = Object.entries(res.out).sort((a, b) => b[1].tris - a[1].tris);
let T = 0, D = 0; for (const [, v] of rows) { T += v.tris; D += v.draws; }
console.log(`far ${res.far} m   total ${D} draws  ${Math.round(T).toLocaleString()} tris`);
for (const [k, v] of rows.slice(0, arg('top', 25))) console.log(`  ${k.padEnd(40)} ${String(v.draws).padStart(3)} draws ${String(Math.round(v.tris)).padStart(8)} tris`);
await browser.close();

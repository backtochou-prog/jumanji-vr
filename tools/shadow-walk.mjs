#!/usr/bin/env node
/**
 * Shadow-window flicker test: walk towards the temple in 0.5 m steps (looking at it) and, at every step, read the brightness of fixed WORLD points
 * on its steps and columns. A smooth walk should change those brightnesses smoothly; a jump means the shadow window (follows the player) just
 * swallowed or released that surface: the "flash" a player sees. Reports the largest jumps with and without runtime shadows.
 *   node tools/shadow-walk.mjs [--from -30 --to -58 --step 0.5]
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(root + '/')('playwright-core');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome', headless: true, args: ['--no-sandbox', '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 480, height: 300 } });
await page.goto(`https://localhost:8081/?desktop=1&perf=0&governor=0&pixelratio=1`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__jumanjiPerf?.world?.scene?.getObjectByName('Rope bridge'), null, { timeout: 290000 });
await page.waitForTimeout(6000);
const T = await page.evaluate(async () => { const l = await import('/src/world/layout.ts'); window.__L = l; return { z: l.TEMPLE.z, d: l.TEMPLE.depth, w: l.TEMPLE.width, pillar: l.PILLARS[0], top: l.TEMPLE.z + l.TEMPLE.depth / 2 }; });
// fixed world points on the temple front (steps and column bases): derived from the front edge
const pts = [[-3.5, 0.5, T.top + 0.2], [3.5, 0.5, T.top + 0.2], [-2, 1.0, T.top - 0.9], [2, 1.0, T.top - 0.9], [-3.5, 1.45, T.top - 2.5], [3.5, 1.45, T.top - 2.5], [T.pillar.x, 1.6, T.pillar.z + 0.65]];
const from = arg('from', T.top + 30), to = arg('to', T.top + 4), step = arg('step', 0.5);
const run = async (shadows) => {
  await page.evaluate((on) => { const w = window.__jumanjiPerf.world; w.renderer.shadowMap.enabled = on; w.scene.traverse((o) => { if (o.isDirectionalLight) o.castShadow = on; }); w.scene.traverse((o) => { if (o.material) { const m = Array.isArray(o.material) ? o.material : [o.material]; m.forEach((x) => (x.needsUpdate = true)); } }); }, shadows);
  const rows = [];
  for (let z = from; z >= to; z -= step) {
    const r = await page.evaluate(([z, pts, tz]) => {
      const P = window.__jumanjiPerf, w = P.world, l = window.__L;
      const gy = l.terrainHeight(0, z);
      P.place(0, z, 0, gy, Math.atan2(1 - (gy + 1.65), z - tz) * 180 / Math.PI);
      return new Promise((res) => setTimeout(() => {
        const cam = w.camera; cam.updateMatrixWorld(true);
        const rd = w.renderer; rd.render(w.scene, cam);
        const gl = rd.getContext(); const W = rd.domElement.width, H = rd.domElement.height; const buf = new Uint8Array(4 * 25);
        const out = [];
        for (const p of pts) {
          const v = new cam.position.constructor(p[0], p[1], p[2]).project(cam);
          if (v.z > 1 || Math.abs(v.x) > 0.95 || Math.abs(v.y) > 0.95) { out.push(null); continue; }
          const px = Math.round((v.x * 0.5 + 0.5) * W), py = Math.round((v.y * 0.5 + 0.5) * H);
          gl.readPixels(px - 2, py - 2, 5, 5, gl.RGBA, gl.UNSIGNED_BYTE, buf);
          let s = 0; for (let i = 0; i < 25; i++) s += 0.2126 * buf[i * 4] + 0.7152 * buf[i * 4 + 1] + 0.0722 * buf[i * 4 + 2];
          out.push(+(s / 25).toFixed(1));
        }
        res({ lum: out, cam: [+cam.getWorldPosition(new cam.position.constructor()).x.toFixed(1), +cam.getWorldPosition(new cam.position.constructor()).z.toFixed(1)] });
      }, 2600));
    }, [z, pts, T.z]);
    rows.push({ z, ...r });
  }
  return rows;
};
const report = (label, rows) => {
  let worst = { j: 0 };
  const jumps = [];
  for (let k = 1; k < rows.length; k++) for (let p = 0; p < pts.length; p++) {
    const a = rows[k - 1].lum[p], b = rows[k].lum[p];
    if (a === null || b === null || a === undefined || b === undefined) continue;
    const j = Math.abs(b - a) / Math.max(12, Math.min(a, b));
    if (j > 0.25) jumps.push({ z: rows[k].z, point: p, from: a, to: b, rel: +j.toFixed(2) });
    if (j > worst.j) worst = { j, z: rows[k].z, point: p, a, b };
  }
  console.log(`${label}: ${jumps.length} brightness jumps > 25 % between consecutive 0.5 m steps; worst ${worst.j ? `${(worst.j * 100).toFixed(0)} % (${worst.a} -> ${worst.b}) at z=${worst.z} point ${worst.point}` : 'none'}`);
  for (const j of jumps.slice(0, 8)) console.log(`   z=${j.z}  point ${j.point}: ${j.from} -> ${j.to}  (${(j.rel * 100).toFixed(0)} %)`);
  return jumps;
};
const on = await run(true);
const a = report('runtime shadows ON ', on);
const off = await run(false);
const b = report('runtime shadows OFF', off);
console.log(a.length > b.length ? `=> the shadow window causes ${a.length - b.length} of the jumps` : '=> no jumps attributable to shadows');
await browser.close();

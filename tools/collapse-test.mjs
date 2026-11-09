#!/usr/bin/env node
/**
 * Browser test of the collapsing ledge (desktop runtime, software GL: timings are scripted, frame rate is irrelevant).
 *   npm run dev:runtime   (another terminal)   node tools/collapse-test.mjs [--scenario approach|onshelf|retreat|reset]
 * Scenarios: approach (stop 5 m before the shelf and watch it collapse), onshelf (stand in the middle: the walking surface carries you down),
 * retreat (approach to 12 m, retreat to 30 m: must cancel), reset (collapse, walk away 80 m out of sight: must re-arm).
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(root + '/')('playwright-core');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const scenario = arg('scenario', 'approach');
const exe = process.env.CHROMIUM ?? '/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome';
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 480, height: 300 } });
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await page.goto(`${arg('url', 'https://localhost:8081/')}?desktop=1&perf=0&governor=0&pixelratio=0.4`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__jumanjiCollapse && window.__jumanjiPerf?.world?.scene?.getObjectByName('Collapse shelf'), null, { timeout: 280000 });
const out = [];
const place = (s, l = 0) => page.evaluate(async ([s, l]) => {
  const C = await import('/src/world/collapse.ts');
  const L = await import('/src/world/layout.ts');
  const f = C.frameAt(L.MTN.cleft.s0 + s);
  const w = C.worldAt(L.MTN.cleft.s0 + s, l);
  window.__jumanjiPerf.place(w.x, w.z, 0, f.y);
  return { x: w.x, y: f.y, z: w.z };
}, [s, l]);
const probe = () => page.evaluate(() => {
  const w = window.__jumanjiPerf.world;
  const col = w.scene.getObjectByName('Shelf collider');
  const p = w.player.position;
  const c = window.__jumanjiCollapse.state;
  return { state: c.state, dist: +(c.distance ?? 0).toFixed(1), onShelf: c.playerOnShelf, colliderDy: +(col ? col.position.y : 0).toFixed(2), playerY: +p.y.toFixed(2), breaks: c.breaks, resets: c.resets };
});
const watch = async (label, seconds) => {
  const t0 = Date.now();
  let last = '';
  while ((Date.now() - t0) / 1000 < seconds) {
    const r = await probe();
    const k = JSON.stringify(r);
    if (k !== last) { console.log(`${label} +${((Date.now() - t0) / 1000).toFixed(1)}s`, k); last = k; }
    await page.waitForTimeout(400);
  }
};
const dbg = await page.evaluate(async () => { const L = await import('/src/world/layout.ts'); return L.MTN.cleft; });
console.log('shelf', dbg, 'scenario', scenario);
if (scenario === 'approach') {
  await place(-5.5);
  await watch('approach', 40);
} else if (scenario === 'onshelf') {
  await place(6);
  await watch('onshelf', 40);
} else if (scenario === 'retreat') {
  await place(-12);
  await watch('at12m', 6);
  await place(-30);
  await watch('retreated', 6);
} else if (scenario === 'dither') {
  // hover around the warning boundary: the event must neither thrash nor break
  for (let k = 0; k < 6; k++) { await place(-(k % 2 ? 15 : 21)); await watch(`dither${k}`, 2.5); }
  const r = await probe();
  console.log(r.breaks === 0 ? 'PASS no break while hovering at 15-21 m' : 'FAIL it broke', JSON.stringify(r));
} else if (scenario === 'double') {
  // trigger() many times in a row, then wait: exactly one break, one sink
  await place(-5.5);
  await page.evaluate(() => { for (let i = 0; i < 8; i++) window.__jumanjiCollapse.trigger(); });
  await watch('double', 14);
  const r = await probe();
  console.log(r.breaks === 1 ? 'PASS exactly one break after 8 trigger() calls' : 'FAIL breaks=' + r.breaks, JSON.stringify(r));
} else if (scenario === 'draws') {
  // the shelf must cost 1 draw while intact; pieces only from the break on; pebbles/cracks hidden when idle
  await place(-14);
  const count = () => page.evaluate(() => { const w = window.__jumanjiPerf.world; const root = w.scene.getObjectByName('Collapse shelf'); const vis = []; root.traverse((o) => { if (o.isMesh && o.visible) vis.push(o.name); }); return vis; });
  console.log('intact visible meshes:', JSON.stringify(await count()));
  await place(-5.5);
  await watch('break', 12);
  console.log('after break visible meshes:', JSON.stringify(await count()), JSON.stringify(await probe()));
  await page.waitForTimeout(6000);
  console.log('6 s later:', JSON.stringify(await count()), JSON.stringify(await probe()));
} else if (scenario === 'reset') {
  await place(-5.5);
  await watch('collapse', 30);
  await page.evaluate(() => window.__jumanjiPerf.place(30, -50, 180));
  await watch('far-away', 12);
}
await browser.close();

#!/usr/bin/env node
/**
 * Stills of the wildlife at eye height: for each kind of creature, stand a few metres from a real one (found in the live simulation), look at it, save a PNG.
 *   node tools/wildlife-shots.mjs [--out artifacts/wildlife] [--only monkey,macaw] [--dist 7]
 * Software GL: for looking at proportions, poses and placement, not for speed.
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(root + '/')('playwright-core');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const out = resolve(root, arg('out', 'artifacts/wildlife'));
mkdirSync(out, { recursive: true });
const only = arg('only', '').split(',').filter(Boolean);
const D = Number(arg('dist', '7'));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome', headless: true, args: ['--no-sandbox', '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await page.goto(`${arg('url', 'https://localhost:8081/')}?desktop=1&perf=0&governor=0&pixelratio=1`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__jumanjiWildlife?.ready && window.__jumanjiPerf?.world?.scene?.getObjectByName('Rope bridge'), null, { timeout: 290000 });
await page.waitForTimeout(5000);

const kinds = {
  monkey: () => window.__jumanjiWildlife.monkeys.monkeys.map((m) => ({ x: m.x, y: m.y, z: m.z, id: m.id })),
  macaw: () => window.__jumanjiWildlife.birds.birds.filter((b) => b.sp === 0 && !b.transient && !b.soarer).map((b) => ({ x: b.x, y: b.y, z: b.z, id: b.id })),
  toucan: () => window.__jumanjiWildlife.birds.birds.filter((b) => b.sp === 1 && !b.transient).map((b) => ({ x: b.x, y: b.y, z: b.z, id: b.id })),
  small: () => window.__jumanjiWildlife.birds.birds.filter((b) => b.sp === 2 && !b.transient && !b.soarer).map((b) => ({ x: b.x, y: b.y, z: b.z, id: b.id })),
};
// make everything "active" by visiting places along the trail, remember each creature's home position
const homes = await page.evaluate(async () => {
  const P = window.__jumanjiPerf;
  const L = await import('/src/world/layout.ts');
  const seen = { monkey: new Map(), macaw: new Map(), toucan: new Map(), small: new Map() };
  const W = window.__jumanjiWildlife;
  for (const [x, z] of [[0.6, 8], [-1, -6], [-2, -16], [-4, -26], [0, -38], [0, -50], [0, -58]]) {
    P.place(x, z, 0, window.__terrainY ? window.__terrainY(x, z) : 0, 0);
    await new Promise((r) => setTimeout(r, 2500));
    for (const m of W.monkeys.monkeys) if (m.active) seen.monkey.set(m.id, { x: m.x, y: m.y, z: m.z, id: m.id });
    for (const b of W.birds.birds) if (b.active && !b.transient && !b.soarer) seen[b.sp === 0 ? 'macaw' : b.sp === 1 ? 'toucan' : 'small'].set(b.id, { x: b.x, y: b.y, z: b.z, id: b.id });
  }
  return Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, [...v.values()]]));
});
console.log('creatures seen:', Object.fromEntries(Object.entries(homes).map(([k, v]) => [k, v.length])));
for (const [kind, list] of Object.entries(homes)) {
  if (only.length && !only.includes(kind)) continue;
  for (let n = 0; n < Math.min(2, list.length); n++) {
    const c = list[n];
    // stand on the trail, at the point nearest the creature (the way a player would see it), and look at it
    const shot = await page.evaluate(async ([c]) => {
      const P = window.__jumanjiPerf;
      const L = await import('/src/world/layout.ts');
      // the trail point from which the creature is seen at the gentlest upward angle (>= 8 m away), like a player strolling past
      let best = L.PATH_SAMPLES[0], bd = 1e9, bs = 1e9;
      for (const p of L.PATH_SAMPLES) {
        const d = Math.hypot(p[0] - c.x, p[1] - c.z);
        if (d < 8) continue;
        const pitch = (Math.atan2(c.y - (L.terrainHeight(p[0], p[1]) + 1.65), d) * 180) / Math.PI;
        const score = Math.abs(pitch - 22) + d * 0.1;
        if (score < bs) { bs = score; bd = d; best = p; }
      }
      // step back along the line to the creature so it is ~12 m away if the trail is closer
      let ox = best[0], oz = best[1];
      const gy = L.terrainHeight(ox, oz);
      const eye = gy + 1.65;
      const yaw = (Math.atan2(-(c.x - ox), -(c.z - oz)) * 180) / Math.PI;
      const pitch = (Math.atan2(c.y - eye, Math.hypot(c.x - ox, c.z - oz)) * 180) / Math.PI;
      P.place(ox, oz, yaw, gy, pitch);
      return { ox, oz, yaw, pitch, dist: bd, h: c.y - gy };
    }, [c]);
    await page.waitForTimeout(1800);
    await page.screenshot({ path: `${out}/${kind}-${n}.png` });
    console.log(`${kind}-${n}`, JSON.stringify(shot));
  }
}
await browser.close();

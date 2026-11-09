#!/usr/bin/env node
/**
 * Locomotion tests on the real colliders (desktop runtime; the same locomotion engine and collision as in a headset).
 *   npm run dev:runtime   (another terminal)    node tools/walk-test.mjs [--scenario bridge|lip|ledge|terrace|all]
 * Keys W/A/S/D drive the IWSDK locomotion action exactly like a thumbstick. Software GL runs at a few fps: movement per
 * frame is capped by the engine, so distances are small per second; each scenario holds the key long enough.
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(root + '/')('playwright-core');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const which = arg('scenario', 'all');
const exe = process.env.CHROMIUM ?? '/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome';
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await page.goto(`${arg('url', 'https://localhost:8081/')}?desktop=1&perf=0&governor=0&pixelratio=0.3&speed=3.5`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__jumanjiCollapse && window.__jumanjiPerf?.world?.scene?.getObjectByName('Rope bridge'), null, { timeout: 280000 });
await page.waitForTimeout(8000);
const M = await page.evaluate(async () => { const m = await import('/src/world/mountain.ts'); const l = await import('/src/world/layout.ts'); return { BRIDGE: m.BRIDGE, PLATFORM: m.PLATFORM, SUMMIT_DIR: m.SUMMIT_DIR, TERRACE: m.TERRACE, deck: [0, 0.25, 0.5, 0.75, 1].map((u) => m.bridgeDeckY(u)), views: l.MTN_VIEWS, ledge: (() => { const s = l.MTN.samples.find((q) => q.zone === 'ledge'); return s; })() }; });
const pos = () => page.evaluate(() => { const p = window.__jumanjiPerf.world.player.position; return { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) }; });
const hold = async (key, ms) => { await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key); await page.waitForTimeout(800); };
let fails = 0;
const check = (name, ok, detail) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); };
const place = (x, z, yaw, y) => page.evaluate(([x, z, yaw, y]) => window.__jumanjiPerf.place(x, z, yaw, y), [x, z, yaw, y]);

if (which === 'bridge' || which === 'all') {
  const B = M.BRIDGE;
  await place(B.ax - 2.4, B.az, -90, B.y);
  await page.waitForTimeout(3000);
  const a = await pos();
  await hold('KeyW', 30000);
  const b = await pos();
  check('bridge: walk across with the thumbstick/keys', b.x > B.bx - 4, `x ${a.x} -> ${b.x} (bridge ${B.ax}..${B.bx}), y ${b.y}`);
  check('bridge: arrives on the far side at deck level (the terrace)', b.y > B.y - 1.2 && b.y < B.y + 0.6, `(${b.x}, ${b.z}) y ${b.y} (deck ${B.y})`);
  await place((B.ax + B.bx) / 2, B.az, -90, M.deck[2]);
  await page.waitForTimeout(3000);
  await hold('KeyD', 8000);
  const c = await pos();
  check('bridge: rail walls stop a sideways walk', Math.abs(c.z - B.az) < 0.75 && c.y > M.deck[2] - 0.6, `z ${c.z} (axis ${B.az}), y ${c.y}`);
  await hold('KeyA', 16000);
  const d = await pos();
  check('bridge: and the other rail', Math.abs(d.z - B.az) < 0.75 && d.y > M.deck[2] - 0.6, `z ${d.z}, y ${d.y}`);
}
if (which === 'lip' || which === 'all') {
  const P = M.PLATFORM;
  const v = M.views.summit;
  await place(P.x, P.z, v.yawDeg, P.y);
  await page.waitForTimeout(3000);
  await hold('KeyW', 30000);
  const p = await pos();
  const r = Math.hypot(p.x - P.x, p.z - P.z);
  check('summit: walking at the edge stops before the drop', Math.abs(p.y - P.y) < 1.0 && r < P.r + 0.5, `${r.toFixed(2)} m from the platform centre (r=${P.r}), y ${p.y} (platform ${P.y})`);
}
if (which === 'terrace' || which === 'all') {
  const T = M.TERRACE;
  const v = M.views.brink;
  await place(T.x, T.z, v.yawDeg, T.y);
  await page.waitForTimeout(3000);
  await hold('KeyW', 30000);
  const p = await pos();
  check('brink terrace: walking at the lip stops', Math.abs(p.y - T.y) < 1.0, `(${p.x}, ${p.z}) y ${p.y} (terrace ${T.y})`);
}
if (which === 'ledge' || which === 'all') {
  const s = M.ledge;
  // face the valley (perpendicular to the route) from the middle of the ledge
  const v = M.views.ledge;
  await place(v.x, v.z, v.yawDeg + 90, v.y);
  await page.waitForTimeout(3000);
  await hold('KeyW', 30000);
  const p = await pos();
  await place(v.x, v.z, v.yawDeg - 90, v.y);
  await page.waitForTimeout(3000);
  await hold('KeyW', 30000);
  const q = await pos();
  check('ledge: pushing towards the drop is stopped', Math.abs(p.y - v.y) < 1.5, `(${p.x}, ${p.z}) y ${p.y} (ledge ${v.y.toFixed(1)}) from (${v.x.toFixed(1)}, ${v.z.toFixed(1)})`);
  check('ledge: pushing into the rock face is stopped too', Math.abs(q.y - v.y) < 2.5, `(${q.x}, ${q.z}) y ${q.y}`);
  void s;
}
if (which === 'hazard' || which === 'all') {
  const speed = () => page.evaluate(() => { const w = window.__jumanjiPerf.world; const slide = w.systems.find((s) => s.constructor?.name === 'SlideSystem'); return { scale: +window.__jumanjiComfort.speedScale.toFixed(2), maxSpeed: slide ? +slide.config.maxSpeed.value.toFixed(2) : null }; });
  const B = M.BRIDGE;
  await place(B.ax + 6, B.az, -90, M.deck[1]);
  await page.waitForTimeout(9000);
  const onBridge = await speed();
  await place(0.6, 11.5, 0);
  await page.waitForTimeout(9000);
  const jungle = await speed();
  const v = M.views.descent;
  await place(v.x, v.z, v.yawDeg, v.y);
  await page.waitForTimeout(9000);
  const gully = await speed();
  check('hazard assist: slower on the bridge, normal in the jungle, slower on the steep descent', onBridge.scale < 0.7 && jungle.scale === 1 && gully.scale < 0.8, `bridge ${JSON.stringify(onBridge)}, jungle ${JSON.stringify(jungle)}, descent ${JSON.stringify(gully)}`);
}
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
await browser.close();
process.exit(fails ? 1 : 0);

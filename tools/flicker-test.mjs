#!/usr/bin/env node
/**
 * Flicker reproduction (desktop runtime, software GL; deterministic, so differences are real, not noise).
 *
 *   npm run dev:runtime   (another terminal)        node tools/flicker-test.mjs [--stations temple-7m,spire-37m] [--variants current,fixed]
 *
 * Z-FIGHT / DEPTH PRECISION: render a station, nudge the camera 1 mm, render again. Surfaces that win the depth test by luck
 * (coplanar or nearly coplanar, or beyond the depth buffer's resolution) change colour between the two; everything else is identical.
 * Run into the default 24-bit depth buffer and into a 16-bit depth target (what a lower-precision XR framebuffer would give).
 * FAR PLANE: for the key structures, how many metres of them lie beyond the camera far plane (clipped away, popping with head rotation).
 * SHADOW WINDOW: render, shift the sun's follow position by 1 m (as if the player had walked 1 m), render, compare.
 * VISIBILITY TOGGLES: walk a line towards the temple in 2 m steps and list every named object whose `visible` flips (LOD/culling pops).
 * Output: table + perf-results/flicker-<label>.json + artifacts/flicker/*.png (red = unstable pixels).
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(root + '/')('playwright-core');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const label = arg('label', 'run');
const exe = process.env.CHROMIUM ?? '/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome';
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 480, height: 300 } });
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await page.goto(`${arg('url', 'https://localhost:8081/')}?desktop=1&perf=0&governor=0&pixelratio=1`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__jumanjiPerf?.world?.scene?.getObjectByName('Rope bridge'), null, { timeout: 290000 });
await page.waitForTimeout(6000);
const L = await page.evaluate(async () => { const l = await import('/src/world/layout.ts'); return { TEMPLE: l.TEMPLE, SPIRE: l.SPIRE, PILLARS: l.PILLARS, ALTAR: l.ALTAR, views: l.MTN_VIEWS, CLIFF: l.CLIFF, ROOT_ARCH: l.ROOT_ARCH }; });
const T = L.TEMPLE;
const at = (name, from, target) => ({ name, from, target });
const stations = [
  at('temple-3m', [0, T.z + T.depth / 2 + 3], [0, 2, T.z]),
  at('temple-wall-5m', [-4, T.z + T.depth / 2 + 5], [-1.7, 4, T.z - T.depth / 2 + 0.9]),
  at('pillar-2m', [L.PILLARS[0].x, L.PILLARS[0].z + 2.8], [L.PILLARS[0].x, 2, L.PILLARS[0].z]),
  at('temple-7m', [0, T.z + T.depth / 2 + 7 + 2], [0, 3, T.z]),
  at('temple-12m', [0, T.z + T.depth / 2 + 12], [0, 3, T.z]),
  at('temple-20m', [0, T.z + T.depth / 2 + 20], [0, 3, T.z]),
  at('temple-35m', [0, T.z + T.depth / 2 + 35], [0, 3, T.z]),
  at('temple-side', [T.width / 2 + 9, T.z + 4], [0, 3, T.z]),
  at('pillar-4m', [L.PILLARS[0].x, L.PILLARS[0].z + 4.6], [L.PILLARS[0].x, 2, L.PILLARS[0].z]),
  at('pillar-12m', [L.PILLARS[0].x + 3, L.PILLARS[0].z + 12], [L.PILLARS[0].x, 2, L.PILLARS[0].z]),
  at('altar-3m', [L.ALTAR[0], L.ALTAR[1] + 3], [L.ALTAR[0], 0.9, L.ALTAR[1]]),
  at('spire-17m', [L.SPIRE.x, L.SPIRE.z + 17], [L.SPIRE.x, L.SPIRE.h / 2, L.SPIRE.z]),
  at('spire-40m', [L.SPIRE.x + 6, L.SPIRE.z + 40], [L.SPIRE.x, L.SPIRE.h / 2, L.SPIRE.z]),
  at('spire-70m', [L.SPIRE.x + 8, L.SPIRE.z + 70], [L.SPIRE.x, L.SPIRE.h / 2, L.SPIRE.z]),
  at('cliff-fall-40m', [0, -56], [L.CLIFF.x, 14, L.CLIFF.z]),
  at('root-arch-7m', [L.ROOT_ARCH.x, L.ROOT_ARCH.z + 7], [L.ROOT_ARCH.x, 2, L.ROOT_ARCH.z]),
  at('trail-ribbon-30m', [-1, -4], [-1.5, 0, -34]),
  at('entrance-trees', [0.6, 11.5], [0.6, 8, -8]),
];
const variants = arg('variants', 'current,fixed').split(',');
const pick = arg('stations', '').split(',').filter(Boolean);
const list = pick.length ? stations.filter((s) => pick.includes(s.name)) : stations;
mkdirSync(resolve(root, 'artifacts/flicker'), { recursive: true });
mkdirSync(resolve(root, 'perf-results'), { recursive: true });

// ---- in-page measurement helpers ----
await page.evaluate(() => {
  const P = window.__jumanjiPerf;
  const w = P.world;
  const T3 = P.three;
  window.__fl = {
    setCam(from, target, near, far) {
      const gy = window.__terrainY ? window.__terrainY(from[0], from[1]) : 0;
      const dx = target[0] - from[0], dz = target[2] - from[1];
      const yaw = (Math.atan2(-dx, -dz) * 180) / Math.PI;
      const eye = gy + 1.65;
      const pitch = (Math.atan2(target[1] - eye, Math.hypot(dx, dz)) * 180) / Math.PI;
      P.place(from[0], from[1], yaw, gy, pitch);
      if (near) { w.camera.near = near; }
      if (far) { w.camera.far = far; }
      w.camera.updateProjectionMatrix();
    },
    shoot(mode, nudge) {
      const bits16 = mode === true || mode === 16;
      const rt24 = mode === 24;
      const r = w.renderer;
      const W = r.domElement.width, H = r.domElement.height;
      const buf = new Uint8Array(W * H * 4);
      const x0 = w.camera.position.x;
      w.camera.position.x = x0 + nudge;
      w.camera.updateMatrixWorld(true);
      if (bits16 || rt24) {
        const dt = new T3.DepthTexture(W, H);
        if (bits16) dt.type = T3.UnsignedShortType;
        dt.format = T3.DepthFormat;
        const rt = new T3.WebGLRenderTarget(W, H, { depthBuffer: true, depthTexture: dt, type: T3.UnsignedByteType });
        r.setRenderTarget(rt); r.render(w.scene, w.camera); r.readRenderTargetPixels(rt, 0, 0, W, H, buf); r.setRenderTarget(null); rt.dispose(); dt.dispose();
      } else {
        r.render(w.scene, w.camera);
        const gl = r.getContext();
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      }
      w.camera.position.x = x0;
      w.camera.updateMatrixWorld(true);
      return { W, H, buf };
    },
  };
  window.__terrainY = null;
});
const gy = await page.evaluate(async () => { const l = await import('/src/world/layout.ts'); window.__terrainY = l.terrainHeight; return 1; });
void gy;

const results = [];
console.log('station            variant   depth   unstable px   (near/far)');
for (const st of list) {
  for (const v of variants) {
    const near = v === 'shipped' ? 0.1 : v === 'fixed' ? 0.15 : 0.05;
    const far = v === 'shipped' || v === 'fixed' ? 260 : 100;
    await page.evaluate(([f, t, n, fa]) => window.__fl.setCam(f, t, n, fa), [st.from, st.target, near, far]);
    await page.waitForTimeout(3500);
    if (near) await page.evaluate(([n, fa]) => { const w = window.__jumanjiPerf.world; w.camera.near = n; w.camera.far = fa; w.camera.updateProjectionMatrix(); }, [near, far]);
    for (const bits of [24, 16]) {
      const r = await page.evaluate((bits) => {
        const a = window.__fl.shoot(bits === 16, 0);
        const b = window.__fl.shoot(bits === 16, 0.001);
        const { W, H } = a;
        let bad = 0;
        const mask = new Uint8ClampedArray(W * H * 4);
        for (let i = 0; i < W * H; i++) {
          const d = Math.max(Math.abs(a.buf[i * 4] - b.buf[i * 4]), Math.abs(a.buf[i * 4 + 1] - b.buf[i * 4 + 1]), Math.abs(a.buf[i * 4 + 2] - b.buf[i * 4 + 2]));
          const bad1 = d > 40;
          if (bad1) bad++;
          mask[i * 4] = bad1 ? 255 : a.buf[i * 4] * 0.5; mask[i * 4 + 1] = bad1 ? 0 : a.buf[i * 4 + 1] * 0.5; mask[i * 4 + 2] = bad1 ? 0 : a.buf[i * 4 + 2] * 0.5; mask[i * 4 + 3] = 255;
        }
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const ctx = c.getContext('2d'); const im = ctx.createImageData(W, H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const s = ((H - 1 - y) * W + x) * 4, d = (y * W + x) * 4; im.data[d] = mask[s]; im.data[d + 1] = mask[s + 1]; im.data[d + 2] = mask[s + 2]; im.data[d + 3] = 255; }
        ctx.putImageData(im, 0, 0);
        const w = window.__jumanjiPerf.world;
        return { bad, total: W * H, png: c.toDataURL('image/png'), near: w.camera.near, far: w.camera.far };
      }, bits);
      const pct = (r.bad / r.total) * 100;
      if (bits === 16) {
        // PRECISION: the same view in a 16-bit and a 24-bit depth buffer. Pixels that differ are surfaces the lower precision sorts wrongly.
        const pr = await page.evaluate(() => { const a = window.__fl.shoot(24, 0), b = window.__fl.shoot(16, 0); let bad = 0; for (let i = 0; i < a.W * a.H; i++) if (Math.max(Math.abs(a.buf[i * 4] - b.buf[i * 4]), Math.abs(a.buf[i * 4 + 1] - b.buf[i * 4 + 1]), Math.abs(a.buf[i * 4 + 2] - b.buf[i * 4 + 2])) > 40) bad++; return { bad, total: a.W * a.H }; });
        console.log(`${''.padEnd(18)} ${v.padEnd(9)} 16 vs 24-bit image differs in ${pr.bad} px (${(100 * pr.bad / pr.total).toFixed(2)} %)`);
        results.push({ station: st.name, variant: v, precisionDiffPx: pr.bad, precisionDiffPct: +(100 * pr.bad / pr.total).toFixed(3) });
      }
      results.push({ station: st.name, variant: v, depthBits: bits, unstablePx: r.bad, unstablePct: +pct.toFixed(3), near: r.near, far: r.far });
      console.log(`${st.name.padEnd(18)} ${v.padEnd(9)} ${String(bits).padStart(4)}-bit ${String(r.bad).padStart(8)} (${pct.toFixed(2)} %)   ${r.near}/${r.far}`);
      if (pct > 0.15) writeFileSync(resolve(root, `artifacts/flicker/${st.name}-${v}-${bits}.png`), Buffer.from(r.png.split(',')[1], 'base64'));
    }
  }
}

// ---- far plane: how much of each structure lies beyond the far plane ----
await page.evaluate((f) => { const w = window.__jumanjiPerf.world; w.camera.near = 0.05; w.camera.far = f; w.camera.updateProjectionMatrix(); }, Number(arg('far', 100)));
console.log(`\nfar plane clipping (view-space depth beyond camera.far = ${arg('far', 100)} m; --far 260 = what ships):`);
const clipRows = [];
const names = ['Overgrown temple', 'Temple overgrowth', 'Ruined spire (landmark)', 'Spire overgrowth', 'Ruined pillars', 'Distant cliff', 'Distant waterfall', 'Background ridge 0', 'Background ridge 1', 'Background ridge 2'];
for (const st of [at('entrance', [0.6, 11.5], [0.6, 8, -40]), at('trail', [-1.8, -15.6], [0, 8, -60]), at('trail-mid', [0, -40], [0, 8, -80]), at('clearing', [0, -57.5], [0, 8, -96])]) {
  await page.evaluate(([f, t, fa]) => window.__fl.setCam(f, t, 0.1, fa), [st.from, st.target, Number(arg('far', 100))]);
  await page.waitForTimeout(3500);
  const rows = await page.evaluate((names) => {
    const w = window.__jumanjiPerf.world; const cam = w.camera; cam.updateMatrixWorld(true);
    const inv = cam.matrixWorldInverse.clone ? cam.matrixWorldInverse : null;
    const out = [];
    for (const n of names) {
      const o = w.scene.getObjectByName(n); if (!o) continue;
      let min = Infinity, max = -Infinity;
      o.traverse((m) => { if (!m.isMesh) return; if (!m.geometry.boundingBox) m.geometry.computeBoundingBox(); const b = m.geometry.boundingBox; for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) { const v = new cam.position.constructor(x, y, z).applyMatrix4(m.matrixWorld).applyMatrix4(inv); const d = -v.z; if (d < min) min = d; if (d > max) max = d; } });
      out.push({ name: n, minDepth: +min.toFixed(0), maxDepth: +max.toFixed(0), far: cam.far, clipped: max > cam.far && min < cam.far, entirelyBeyond: min > cam.far });
    }
    return out;
  }, names);
  for (const r of rows) { clipRows.push({ at: st.name, ...r }); console.log(`  ${st.name.padEnd(10)} ${r.name.padEnd(26)} depth ${String(r.minDepth).padStart(4)}..${String(r.maxDepth).padEnd(4)} far ${r.far}  ${r.clipped ? 'CUT BY THE FAR PLANE' : r.entirelyBeyond ? 'entirely beyond far (never drawn)' : 'ok'}`); }
}

// ---- shadow window: shift the sun follow position by 1 m ----
console.log('\nshadow window (pixels that change when the sun follow position moves 1 m with the camera fixed):');
const shadowRows = [];
for (const st of list.filter((s) => /temple-(3|7)m|temple-wall|pillar-(2|4)m|altar/.test(s.name))) {
  await page.evaluate(([f, t]) => window.__fl.setCam(f, t, 0, 0), [st.from, st.target]);
  await page.waitForTimeout(3500);
  const r = await page.evaluate(() => {
    const w = window.__jumanjiPerf.world; let sun = null; w.scene.traverse((o) => { if (o.isDirectionalLight && o.castShadow) sun = o; });
    const a = window.__fl.shoot(false, 0); const x0 = sun.position.x; sun.position.x = x0 + 1; sun.updateMatrixWorld(true);
    const b = window.__fl.shoot(false, 0); sun.position.x = x0; sun.updateMatrixWorld(true);
    const c = window.__fl.shoot(false, 0); // back to the original: must equal a
    let d1 = 0, d2 = 0; const n = a.W * a.H;
    for (let i = 0; i < n; i++) { const m = Math.max(Math.abs(a.buf[i*4]-b.buf[i*4]), Math.abs(a.buf[i*4+1]-b.buf[i*4+1]), Math.abs(a.buf[i*4+2]-b.buf[i*4+2])); if (m > 24) d1++; const m2 = Math.max(Math.abs(a.buf[i*4]-c.buf[i*4]), Math.abs(a.buf[i*4+1]-c.buf[i*4+1]), Math.abs(a.buf[i*4+2]-c.buf[i*4+2])); if (m2 > 24) d2++; }
    const s = sun.shadow; return { changed: d1, control: d2, total: n, mapSize: s.mapSize.x, half: s.camera.right, bias: s.bias, normalBias: s.normalBias };
  });
  shadowRows.push({ station: st.name, ...r });
  console.log(`  ${st.name.padEnd(12)} changed ${(100 * r.changed / r.total).toFixed(2)} % (control ${(100 * r.control / r.total).toFixed(2)} %)   map ${r.mapSize}px, window +-${r.half} m (texel ${(2 * r.half / r.mapSize * 100).toFixed(1)} cm), bias ${r.bias}, normalBias ${r.normalBias}`);
}

// ---- visibility toggles while walking towards the temple ----
console.log('\nvisibility toggles while walking from 100 m to 6 m before the temple (named structures only):');
const toggles = await page.evaluate(async (T) => {
  const P = window.__jumanjiPerf; const w = P.world;
  const watch = ['Overgrown temple', 'Temple overgrowth', 'Ruined spire (landmark)', 'Spire overgrowth', 'Ruined pillars', 'Ancient altar', 'Distant cliff', 'Distant waterfall', 'Background ridge 0', 'Background ridge 1', 'Background ridge 2', 'Terrain + Trail'];
  const state = {}; const events = [];
  const z0 = T.z + T.depth / 2 + 6;
  for (let z = 40; z >= z0; z -= 4) {
    window.__fl.setCam([0, z], [0, 3, T.z], 0.05, 100);
    await new Promise((r) => setTimeout(r, 1200));
    for (const n of watch) { const o = w.scene.getObjectByName(n); if (!o) continue; const v = o.visible; if (state[n] !== undefined && state[n] !== v) events.push({ at: z, name: n, visible: v, distanceToTempleFront: +(z - (T.z + T.depth / 2)).toFixed(0) }); state[n] = v; }
  }
  return events;
}, T);
console.log(toggles.length ? toggles.map((e) => `  z=${e.at}: ${e.name} -> ${e.visible ? 'shown' : 'HIDDEN'}`).join('\n') : '  none');
const out = { label, when: new Date().toISOString(), note: 'software GL, deterministic; pixel counts are exact for this renderer', depth: results, farClipping: clipRows, shadowWindow: shadowRows, toggles };
const file = resolve(root, 'perf-results', `flicker-${label}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
console.log('\nsaved', file);
await browser.close();

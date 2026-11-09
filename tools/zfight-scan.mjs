#!/usr/bin/env node
/**
 * Geometric z-fight scan: finds pairs of triangles (from different meshes) that are coplanar within 1.5 cm and overlap, i.e. surfaces that
 * will fight for the depth buffer whatever the camera does. Scans the structures against each other and against the ground.
 *   node tools/zfight-scan.mjs [--names "Overgrown temple,Ruined spire (landmark)"] [--tol 0.015]
 * Runs in the real scene (world matrices applied), headless; no rendering needed.
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(root + '/')('playwright-core');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const tol = Number(arg('tol', '0.015'));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome', headless: true, args: ['--no-sandbox', '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
await page.goto(`${arg('url', 'https://localhost:8081/')}?desktop=1&perf=0&governor=0&pixelratio=0.2`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__jumanjiPerf?.world?.scene?.getObjectByName('Rope bridge'), null, { timeout: 290000 });
await page.waitForTimeout(4000);
const names = arg('names', 'Overgrown temple,Temple overgrowth,Ruined spire (landmark),Spire overgrowth,Ruined pillars,Ancient altar,Heartstone (grabbable relic),Entrance limb + lianas,Root arch (landmark),Fallen giant (landmark),Rope bridge,Collapse shelf,Pool\\, stream and puddles').split(/,(?![^()]*\))/).map((s) => s.replace(/\\,/g, ','));
const rows = await page.evaluate(([names, tol]) => {
  const w = window.__jumanjiPerf.world;
  const tris = (o) => {
    o.updateWorldMatrix(true, true);
    const out = [];
    o.traverse((m) => {
      if (!m.isMesh || !m.geometry) return;
      const g = m.geometry, p = g.getAttribute('position'), idx = g.index;
      const n = idx ? idx.count / 3 : p.count / 3;
      const e = m.matrixWorld.elements;
      const tx = (i) => { const x = p.getX(i), y = p.getY(i), z = p.getZ(i); return [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]]; };
      for (let t = 0; t < n; t++) {
        const a = tx(idx ? idx.getX(t * 3) : t * 3), b = tx(idx ? idx.getX(t * 3 + 1) : t * 3 + 1), c = tx(idx ? idx.getX(t * 3 + 2) : t * 3 + 2);
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const nn = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const l = Math.hypot(nn[0], nn[1], nn[2]);
        if (l < 1e-9) continue;
        const nu = [nn[0] / l, nn[1] / l, nn[2] / l];
        out.push({ a, b, c, n: nu, d: nu[0] * a[0] + nu[1] * a[1] + nu[2] * a[2], area: l / 2, mat: Array.isArray(m.material) ? m.material[0] : m.material, name: m.name });
      }
    });
    return out;
  };
  const inTri = (p, t) => {
    const v0 = [t.c[0] - t.a[0], t.c[1] - t.a[1], t.c[2] - t.a[2]], v1 = [t.b[0] - t.a[0], t.b[1] - t.a[1], t.b[2] - t.a[2]], v2 = [p[0] - t.a[0], p[1] - t.a[1], p[2] - t.a[2]];
    const d = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
    const d00 = d(v0, v0), d01 = d(v0, v1), d11 = d(v1, v1), d20 = d(v2, v0), d21 = d(v2, v1);
    const den = d00 * d11 - d01 * d01; if (Math.abs(den) < 1e-12) return false;
    const u = (d11 * d20 - d01 * d21) / den, v = (d00 * d21 - d01 * d20) / den;
    return u >= -0.02 && v >= -0.02 && u + v <= 1.02;
  };
  const sets = [];
  for (const n of names) { const o = w.scene.getObjectByName(n); if (o) sets.push({ n, t: tris(o), box: null }); }
  // terrain tiles near the ruins (they are huge: only triangles within the ruin region)
  const ground = [];
  w.scene.traverse((m) => { if (m.isMesh && /^(Terrain_\d+_\d+|DirtTrail)$/.test(m.name)) ground.push(...tris(m)); });
  const report = [];
  const grid = (list) => { const g = new Map(); list.forEach((t, i) => { const x0 = Math.floor(Math.min(t.a[0], t.b[0], t.c[0])), x1 = Math.floor(Math.max(t.a[0], t.b[0], t.c[0])), z0 = Math.floor(Math.min(t.a[2], t.b[2], t.c[2])), z1 = Math.floor(Math.max(t.a[2], t.b[2], t.c[2])); for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) { const k = x * 4096 + z; (g.get(k) ?? g.set(k, []).get(k)).push(i); } }); return g; };
  const scan = (A, B, label) => {
    const g = grid(B); let count = 0; let area = 0; const spots = [];
    for (const t of A) {
      const cx = (t.a[0] + t.b[0] + t.c[0]) / 3, cy = (t.a[1] + t.b[1] + t.c[1]) / 3, cz = (t.a[2] + t.b[2] + t.c[2]) / 3;
      const cand = g.get(Math.floor(cx) * 4096 + Math.floor(cz)); if (!cand) continue;
      const samples = [[cx, cy, cz], [(t.a[0] * 2 + t.b[0] + t.c[0]) / 4, (t.a[1] * 2 + t.b[1] + t.c[1]) / 4, (t.a[2] * 2 + t.b[2] + t.c[2]) / 4]];
      let hit = false;
      for (const i of cand) {
        const u = B[i];
        const dot = t.n[0] * u.n[0] + t.n[1] * u.n[1] + t.n[2] * u.n[2];
        if (dot < 0.995) continue; // same-facing only: an opposite-facing coplanar pair (a base cap against the ground) is back-face culled and cannot z-fight
        for (const s of samples) { const dist = Math.abs(u.n[0] * s[0] + u.n[1] * s[1] + u.n[2] * s[2] - u.d); if (dist < tol && inTri(s, u)) { hit = true; break; } }
        if (hit) break;
      }
      if (hit) { count++; area += t.area; if (spots.length < 4) spots.push([+cx.toFixed(1), +cy.toFixed(2), +cz.toFixed(1)]); }
    }
    if (count) report.push({ pair: label, triangles: count, area: +area.toFixed(2), spots });
  };
  for (let i = 0; i < sets.length; i++) {
    for (let j = 0; j < sets.length; j++) if (i !== j) scan(sets[i].t, sets[j].t, `${sets[i].n}  vs  ${sets[j].n}`);
    scan(sets[i].t, ground, `${sets[i].n}  vs  ground`);
  }
  return { sizes: sets.map((s) => `${s.n}: ${s.t.length} tris`), ground: ground.length, report };
}, [names, tol]);
console.log(rows.sizes.join('\n'), '\nground triangles', rows.ground);
console.log(`\ncoplanar overlaps (within ${tol * 100} cm, same-facing normals):`);
if (!rows.report.length) console.log('  none');
for (const r of rows.report) console.log(`  ${r.pair.padEnd(70)} ${String(r.triangles).padStart(5)} triangles  ${r.area} m2   e.g. ${JSON.stringify(r.spots)}`);
await browser.close();

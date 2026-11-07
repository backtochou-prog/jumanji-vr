#!/usr/bin/env node
/**
 * Asset + frame budget report. No browser, no GPU.
 *
 *   npm run stats            report
 *   npm run stats -- --check same, exit code 1 when a budget is exceeded
 *
 * Sections
 *   1. per-asset triangles / vertices / materials and the asset BUILD TIME
 *      (the procedural assets are generated at start-up in the headset; the
 *      desktop number x ~5 is a rough Quest 2 CPU estimate)
 *   2. scene totals if everything were drawn (submitted)
 *   3. unique textures and their memory (with mipmaps)
 *   4. VISIBLE estimate from standing eye-height viewpoints along the trail:
 *      a CPU frustum test (Quest 2-like 96 x 90 degree view, 100 m far plane)
 *      of every draw's bounding sphere. This is an estimate of what the GPU is
 *      asked to draw, not a measurement of how fast it draws it.
 * Loads src/assets.ts through Vite's SSR loader.
 */
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECK = process.argv.includes('--check');
const BUDGET = {
  submittedTris: 250_000,
  submittedDraws: 150,
  visibleTris: 170_000, // worst viewpoint
  visibleDraws: 100, // worst viewpoint, excludes SDK/UI draws (~10)
  materials: 16,
  textureMB: 8,
  buildMs: 1200, // desktop (module eval + procedural build); Quest 2 is several times slower
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, configFile: false, logLevel: 'error', appType: 'custom', server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true } });
let failed = 0;
const over = (what, v, max, unit = '') => {
  const bad = v > max;
  if (bad) failed++;
  console.log(`  ${bad ? 'OVER ' : 'ok   '} ${what}: ${typeof v === 'number' ? Math.round(v).toLocaleString() : v}${unit} (budget ${max.toLocaleString()}${unit})`);
};

try {
  const t0 = performance.now();
  const mod = await server.ssrLoadModule('/src/assets.ts');
  const buildMs = performance.now() - t0;
  const manifest = mod.default;
  const entries = manifest.assets ?? manifest;

  // ---- 1. per asset ------------------------------------------------------
  const stats = {};
  const rows = [];
  const materials = new Set();
  const textures = new Set();
  for (const [id, entry] of Object.entries(entries)) {
    const obj = entry?.object ?? entry?.prototype ?? (entry?.isObject3D ? entry : null);
    if (!obj?.isObject3D) continue;
    obj.updateWorldMatrix(true, true);
    let tris = 0;
    let verts = 0;
    const meshes = [];
    const mats = new Set();
    obj.traverse((o) => {
      if (!o.isMesh || o.visible === false) return;
      const g = o.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      verts += g.getAttribute('position').count;
      const t = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
      tris += t;
      meshes.push({ sphere: g.boundingSphere.clone().applyMatrix4(o.matrixWorld), tris: t });
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
        mats.add(m);
        materials.add(m);
        for (const k of ['map', 'bumpMap', 'emissiveMap', 'normalMap', 'roughnessMap', 'alphaMap']) if (m[k]) textures.add(m[k]);
      });
    });
    stats[id] = { tris, verts, meshes };
    rows.push([id, tris, verts, meshes.length, mats.size]);
  }
  rows.sort((a, b) => b[1] - a[1]);
  console.log('1. assets (top 25 by triangles)');
  console.log('   ' + 'asset'.padEnd(20), 'tris'.padStart(8), 'verts'.padStart(8), 'meshes'.padStart(7), 'mats'.padStart(5));
  for (const r of rows.slice(0, 25)) console.log('   ' + String(r[0]).padEnd(20), String(Math.round(r[1])).padStart(8), String(r[2]).padStart(8), String(r[3]).padStart(7), String(r[4]).padStart(5));
  console.log(`   ... ${rows.length} assets in total`);

  // ---- 2. scene totals + draw list ---------------------------------------------
  const scene = JSON.parse(readFileSync(resolve(root, 'public/scenes/main.iwsdk.scene.json'), 'utf8'));
  const prefabAsset = Object.fromEntries((scene.resources?.prefabs ?? []).map((p) => [p.id, p.root.content.asset]));
  /** One entry per draw call: bounding sphere (world) + triangles. */
  const draws = [];
  let total = 0;
  const perAsset = {};
  const rotY = (v, deg) => v;
  void rotY;
  for (const node of scene.nodes) {
    const c = node.content;
    if (c?.type === 'asset') {
      const s = stats[c.asset];
      if (!s) continue;
      const p = node.transform?.position ?? [0, 0, 0];
      const sc = typeof node.transform?.scale === 'number' ? node.transform.scale : 1;
      for (const m of s.meshes) {
        const cm = /^veg-(\S+)-(\d+)-(\d+)$/.exec(c.asset);
        draws.push({ x: m.sphere.center.x * sc + p[0], y: m.sphere.center.y * sc + p[1], z: m.sphere.center.z * sc + p[2], r: m.sphere.radius * sc, tris: m.tris, name: c.asset, chunk: cm ? { cls: cm[1], ix: Number(cm[2]), iz: Number(cm[3]) } : null });
        total += m.tris;
        perAsset[c.asset] = (perAsset[c.asset] ?? 0) + m.tris;
      }
    } else if (c?.type === 'pattern') {
      const a = prefabAsset[c.prefab];
      const s = stats[a];
      if (!s) continue;
      const ts = c.distribution.transforms;
      const proto = s.meshes[0].sphere;
      let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9, minz = 1e9, maxz = -1e9;
      for (const t of ts) {
        const [x, y, z] = t.position;
        const r = proto.radius * t.scale;
        minx = Math.min(minx, x - r); maxx = Math.max(maxx, x + r);
        miny = Math.min(miny, y - r * 0.2); maxy = Math.max(maxy, y + proto.radius * 2 * t.scale);
        minz = Math.min(minz, z - r); maxz = Math.max(maxz, z + r);
      }
      const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2, cz = (minz + maxz) / 2;
      draws.push({ x: cx, y: cy, z: cz, r: Math.hypot(maxx - minx, maxy - miny, maxz - minz) / 2, tris: s.tris * ts.length, name: `${a} x${ts.length}`, instances: ts });
      total += s.tris * ts.length;
      perAsset[a] = (perAsset[a] ?? 0) + s.tris * ts.length;
    }
  }
  console.log('\n2. scene totals (everything drawn, before culling)');
  over('triangles', total, BUDGET.submittedTris);
  over('draw calls', draws.length, BUDGET.submittedDraws);
  console.log('   biggest contributors:');
  Object.entries(perAsset).sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([a, t]) => console.log('     ', a.padEnd(18), Math.round(t).toLocaleString().padStart(9)));

  // ---- 3. textures + materials + build time ---------------------------------------------
  let texBytes = 0;
  for (const t of textures) {
    const img = t.image;
    if (img?.width && img?.height) texBytes += img.width * img.height * 4 * 1.33;
  }
  console.log('\n3. memory and start-up');
  over('materials', materials.size, BUDGET.materials);
  over('unique textures (est. with mips)', texBytes / 1048576, BUDGET.textureMB, ' MB');
  const bt = mod.BUILD_TIMES ?? {};
  const built = Object.values(bt).reduce((a, b) => a + b, 0);
  console.log('   build time by group (ms, desktop, warm JIT not assumed):');
  Object.entries(bt).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`     ${k.padEnd(48)} ${v.toFixed(0).padStart(6)}`));
  over('asset build time (desktop; Quest 2 est. x5)', built, BUDGET.buildMs, ' ms');
  console.log(`   (${textures.size} textures; first module load incl. transpile was ${buildMs.toFixed(0)} ms; Quest 2 build estimate ~${(built * 5 / 1000).toFixed(1)} s)`);

  // ---- 4. visible estimate ------------------------------------------------------------------
  const L = await server.ssrLoadModule('/src/world/layout.ts');
  const FAR = 100;
  const H = (96 * Math.PI) / 360; // half horizontal fov
  const V = (90 * Math.PI) / 360;
  const planes = (px, py, pz, yaw, pitch) => {
    // camera looks along (sin yaw, ..., -cos yaw)-ish: yaw 0 = -Z
    const fwd = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
    const right = [Math.cos(yaw), 0, Math.sin(yaw)];
    const up = [-Math.sin(yaw) * Math.sin(pitch), Math.cos(pitch), Math.cos(yaw) * Math.sin(pitch)];
    const n = (a, b) => [a[0] * Math.cos(b) , 0, 0];
    void n;
    const mk = (nx, ny, nz) => { const l = Math.hypot(nx, ny, nz); return [nx / l, ny / l, nz / l]; };
    const cosH = Math.cos(H), sinH = Math.sin(H), cosV = Math.cos(V), sinV = Math.sin(V);
    // inward normals of left/right/top/bottom planes
    const L_ = mk(right[0] * cosH + fwd[0] * sinH, right[1] * cosH + fwd[1] * sinH, right[2] * cosH + fwd[2] * sinH);
    const R_ = mk(-right[0] * cosH + fwd[0] * sinH, -right[1] * cosH + fwd[1] * sinH, -right[2] * cosH + fwd[2] * sinH);
    const T_ = mk(-up[0] * cosV + fwd[0] * sinV, -up[1] * cosV + fwd[1] * sinV, -up[2] * cosV + fwd[2] * sinV);
    const B_ = mk(up[0] * cosV + fwd[0] * sinV, up[1] * cosV + fwd[1] * sinV, up[2] * cosV + fwd[2] * sinV);
    return { p: [px, py, pz], fwd, ps: [L_, R_, T_, B_] };
  };
  let LOW = false; // evaluate the 'low' tier rules
  const visible = (cam, d) => {
    // Distance LOD rules (shared with the runtime ChunkLodSystem).
    if (d.chunk && !L.chunkVisible(d.chunk.cls, L.cellDistance(cam.p[0], cam.p[2], d.chunk.ix, d.chunk.iz), LOW)) return false;
    if (LOW && /^(light-shafts|ground-mists)/.test(d.name)) return false;
    const dx = d.x - cam.p[0], dy = d.y - cam.p[1], dz = d.z - cam.p[2];
    if (dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2] < -d.r) return false; // behind
    if (Math.hypot(dx, dy, dz) - d.r > FAR) return false;
    return cam.ps.every((n) => dx * n[0] + dy * n[1] + dz * n[2] >= -d.r);
  };
  const views = [];
  const N = L.PATH_SAMPLES.length;
  const addView = (name, x, z, yaw, pitch = 0) => views.push({ name, cam: planes(x, L.terrainHeight(x, z) + 1.65, z, yaw, pitch) });
  addView('spawn (north)', L.SPAWN[0], L.SPAWN[1], 0);
  for (const [label, t] of [['gate', 0.2], ['trail 35%', 0.35], ['pool/ford', 0.46], ['root arch', 0.62], ['trail 80%', 0.8], ['clearing', 0.95]]) {
    const i = Math.round(t * (N - 1));
    const a = L.PATH_SAMPLES[i];
    const b = L.PATH_SAMPLES[Math.min(N - 1, i + 6)];
    addView(label, a[0], a[1], Math.atan2(b[0] - a[0], -(b[1] - a[1])));
  }
  for (const t of Object.values(L.TEST_POSES)) addView(`TEST ${t.id} (headset test pose)`, t.x, t.z, (-t.yawDeg * Math.PI) / 180);
  addView('altar (facing temple)', L.ALTAR[0], L.ALTAR[1] + 2.5, 0);
  addView('altar (looking back)', L.ALTAR[0], L.ALTAR[1] + 2.5, Math.PI);
  console.log('\n4. visible estimate from standing viewpoints (CPU frustum test, 96x90 deg, 100 m)');
  let worstT = 0, worstD = 0;
  for (const v of views) {
    let tris = 0, n = 0;
    for (const d of draws) {
      if (visible(v.cam, d)) {
        // A cell is one mesh: the GPU draws the whole cell when any part is inside the frustum (matches three.js culling).
        tris += d.tris;
        n++;
      }
    }
    worstT = Math.max(worstT, tris);
    worstD = Math.max(worstD, n);
    if (process.argv.includes('--breakdown')) {
      const by = {};
      for (const d of draws) if (visible(v.cam, d)) by[d.chunk ? d.chunk.cls : d.name.split(' ')[0]] = (by[d.chunk ? d.chunk.cls : d.name.split(' ')[0]] ?? 0) + d.tris;
      console.log('      ' + Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 9).map(([k, t]) => `${k} ${(t / 1000).toFixed(0)}k`).join('  '));
    }
    console.log(`   ${v.name.padEnd(26)} ${String(n).padStart(4)} draws  ${Math.round(tris).toLocaleString().padStart(9)} tris`);
  }
  over('worst-view triangles', worstT, BUDGET.visibleTris);
  over('worst-view draw calls', worstD, BUDGET.visibleDraws);
  // 'low' tier: same viewpoints with the low-tier LOD rules and no shafts/mist
  LOW = true;
  let lowT = 0, lowD = 0;
  const lowRows = [];
  for (const v of views) {
    let tris = 0, n = 0;
    for (const d of draws) if (visible(v.cam, d)) { tris += d.tris; n++; }
    lowT = Math.max(lowT, tris); lowD = Math.max(lowD, n);
    if (v.name.startsWith('TEST')) lowRows.push(`${v.name.padEnd(36)} ${String(n).padStart(4)} draws ${Math.round(tris).toLocaleString().padStart(9)} tris`);
  }
  console.log("\n   'low' tier at the three headset test poses (worst low-tier view: " + lowD + ' draws, ' + Math.round(lowT).toLocaleString() + ' tris):');
  lowRows.forEach((r) => console.log('     ' + r));
  LOW = false;
  console.log('\n   NOTE: estimates of submitted work only. Frame time on a Quest 2 (fill-rate bound) must be measured on the device.');
  console.log(`\n${failed ? `BUDGET EXCEEDED (${failed})` : 'within budget'}`);
} finally {
  await server.close();
}
if (CHECK && failed) process.exit(1);

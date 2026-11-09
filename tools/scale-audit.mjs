#!/usr/bin/env node
/**
 * Scale audit: the real dimensions (metres) of everything the world is made of, against real-world references.
 *   node tools/scale-audit.mjs [--json]
 * Builds the procedural prototypes through Vite SSR (same code the runtime runs) and prints their bounding boxes,
 * plus the camera / player / locomotion configuration that sets how those sizes are experienced.
 */
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, configFile: false, logLevel: 'error', appType: 'custom', server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true } });
try {
  const T = await server.ssrLoadModule('/src/scene-assets/trees.scene-asset.ts');
  const P = await server.ssrLoadModule('/src/scene-assets/plants.scene-asset.ts');
  const R = await server.ssrLoadModule('/src/scene-assets/rocks.scene-asset.ts');
  const D = await server.ssrLoadModule('/src/scene-assets/deadwood.scene-asset.ts');
  const U = await server.ssrLoadModule('/src/scene-assets/ruins.scene-asset.ts');
  const TP = await server.ssrLoadModule('/src/scene-assets/temple.scene-asset.ts');
  const L = await server.ssrLoadModule('/src/world/layout.ts');
  const Mn = await server.ssrLoadModule('/src/world/mountain.ts');
  const box = (o) => {
    o.updateWorldMatrix(true, true);
    let acc = null;
    o.traverse((m) => {
      if (!m.isMesh) return;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const b = m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld);
      acc = acc ? acc.union(b) : b;
    });
    return { w: acc.max.x - acc.min.x, h: acc.max.y - acc.min.y, d: acc.max.z - acc.min.z, y0: acc.min.y, y1: acc.max.y };
  };
  const f = (v) => v.toFixed(2).padStart(6);
  const rows = [];
  const row = (group, name, o, ref) => { const b = box(o); rows.push({ group, name, ...b, ref }); };
  for (const k of ['giant', 'tall', 'broad', 'slender']) for (let v = 0; v < (k === 'giant' ? 3 : k === 'tall' ? 2 : k === 'broad' ? 2 : 1); v++) row('tree', `tree-${k}-${v}`, T.createTree(k, v, 'hi'), k === 'giant' ? 'emergent 50-70 m, trunk 2-4 m diameter above the buttresses' : k === 'tall' ? 'canopy tree 30-45 m' : k === 'broad' ? 'sub-canopy 20-30 m' : 'slender understorey/pioneer 20-30 m');
  for (let v = 0; v < 3; v++) row('plant', `fern-cluster-${v}`, P.createFernCluster(v), 'ferns 0.4-1.5 m (tree ferns 3-6 m)');
  row('plant', 'treefern', P.createTreeFern(0), 'tree fern 3-6 m');
  for (let v = 0; v < 4; v++) row('plant', `palm-${v}`, P.createPalm(v), 'understorey palms 3-12 m');
  for (let v = 0; v < 3; v++) row('plant', `broadleaf-${v}`, P.createBroadleaf(v), 'heliconia/banana/alocasia 2-5 m');
  for (let v = 0; v < 2; v++) row('plant', `shrub-${v}`, P.createShrub(v), 'shrub 1-2.5 m');
  for (const [k, n] of [['boulder', 3], ['slab', 2], ['standing', 1], ['cobble', 3]]) for (let v = 0; v < n; v++) row('rock', `rock-${k}-${v}`, R.createRock(k, v), 'unit prototype, placed at scale 0.4-2.2');
  row('deadwood', 'log-0', D.createLog(0), 'fallen log 6-12 m x 0.5-0.9 m'); row('deadwood', 'log-giant', D.createGiantLog(), 'fallen emergent 15-25 m x 1.5-2.5 m');
  row('ruin', 'altar', U.createAltar(), 'altar top ~0.95 m (the relic must be graspable)');
  row('ruin', 'ruin-pillars', U.createRuinPillars(), 'ruined columns');
  row('ruin', 'temple', TP.createTemple(), 'monumental: 25-60 m wide, wall 8-15 m, doorway 4-6 m');
  row('ruin', 'spire', TP.createSpire(L.SPIRE.h), 'landmark tower 30-60 m');
  row('landform', 'backdrop cliff', R.createCliff(), 'cliff behind the clearing: 60-120 m');
  row('landform', 'waterfall sheet', R.createWaterfall(), 'a tall fall: 40-100 m');
  const mn = Mn;
  const out = {
    camera: JSON.parse(readFileSync(resolve(root, 'iwsdk.config.json'), 'utf8')).world.render,
    trees: rows.filter((r) => r.group === 'tree'),
  };
  console.log('SCALE AUDIT (metres; 1 world unit = 1 m)\n');
  console.log('group    asset                 width  height   depth   | real-world reference');
  for (const r of rows) console.log(`${r.group.padEnd(8)} ${r.name.padEnd(20)} ${f(r.w)} ${f(r.h)} ${f(r.d)}   | ${r.ref}`);
  console.log('\nplaced sizes');
  console.log(`  player standing eye height (design/validator)  1.65 m; capsule radius 0.5 m (locomotor), float 0.01`);
  console.log(`  camera config (iwsdk.config.json world.render): fov ${out.camera.fov}, near ${out.camera.near}, far ${out.camera.far}`);
  console.log(`  TEMPLE width x depth ${L.TEMPLE.width} x ${L.TEMPLE.depth}; platform top ${TP.TEMPLE_TOP_Y} m; SPIRE h ${L.SPIRE.h}; PILLARS ${L.PILLARS.map((p) => p.h).join('/')} m; ALTAR top ${L.ALTAR_TOP_Y} m`);
  console.log(`  trail half width ~0.95-1.45 m; walk speeds 1.2/1.8/2.5 m/s, default 1.8 (comfort.ts)`);
  console.log(`  mountain: summit ${(Mn.PLATFORM.y).toFixed(0)} m, valley floor ${Mn.GEO.floor} m, giant fall ${(Mn.riverBedY(Mn.D_BRINK) - Mn.BASIN_Y).toFixed(0)} m, bridge ${Mn.BRIDGE_LENGTH.toFixed(1)} m at ${Mn.BRIDGE.y} m`);
  console.log(`  fog: exponential 0.0095 (jungle) -> 50% at ${(Math.log(2) / 0.0095).toFixed(0)} m, 90% at ${(Math.log(10) / 0.0095).toFixed(0)} m; far plane ${L.JUNGLE_FAR} m`);
  void mn;
} finally {
  await server.close();
}

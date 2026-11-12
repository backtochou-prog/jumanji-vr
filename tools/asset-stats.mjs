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
  submittedTris: 625_000, // everything the scene contains (the mountain adds a valley, 80+ terrain tiles, ~200 vegetation cells; Everest ~68k, of which at most ~33k in one view); only a fraction is ever drawn
  submittedDraws: 400, // (inventory: Everest adds 60 meshes, most of them the fine trail tiles that only exist within 150 m of the player)
  visibleTris: 195_000, // worst jungle viewpoint: the earlier 170k + 16k wildlife reserve (below) + ~6k for the perch boughs now on every tree + margin
  visibleDraws: 116, // worst jungle viewpoint, excludes SDK/UI draws (~10): scene (was 100) + the wildlife reserve below
  mtnTris: 170_000, // worst mountain viewpoint (the overlooks see a whole valley; the far field is merged and distance-capped)
  mtnDraws: 100,
  materials: 16,
  textureMB: 8,
  buildMs: 2600, // desktop (module eval + procedural build); Quest 2 is several times slower (the mountain terrain is ~0.6 s of it)
};

/**
 * Wildlife is created at run time (src/wildlife), not by the asset manifest, so it is not in the numbers below. It is added to each viewpoint as a
 * RESERVE taken from `node tools/wildlife-test.mjs --browser` (measured: +12..14 draws and up to +16k triangles at the three jungle stations with every
 * creature type in view; the mountain only has the 4 soaring birds). The audit (npm run audit) then measures the real total.
 * The living world (Prompt 09: falling leaves, lizards, water rings, pollen/embers) adds at most 3 instanced draws + 1 point cloud and 3,320 triangles
 * (computed by tools/living-test.mjs from the geometry; the instanced meshes are hidden when empty) - included in the reserve below.
 */
const WILDLIFE = { jungle: { tris: 19_500, draws: 20 }, mountain: { tris: 3_000, draws: 4 } };

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
      meshes.push({ sphere: g.boundingSphere.clone().applyMatrix4(o.matrixWorld), tris: t, mesh: o.name });
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
        draws.push({ x: m.sphere.center.x * sc + p[0], y: m.sphere.center.y * sc + p[1], z: m.sphere.center.z * sc + p[2], r: m.sphere.radius * sc, tris: m.tris, name: c.asset, mesh: m.mesh, chunk: cm ? { cls: cm[1], ix: Number(cm[2]), iz: Number(cm[3]) } : null });
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
  const FAR = L.JUNGLE_FAR;
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
  /** asset id -> scene node name, for the per-name landmark caps of the knoll vista (JUNGLE_LANDMARK_CAP_NAMED) */
  const LANDMARK_NODE = { cliff: 'Distant cliff', waterfall: 'Distant waterfall', water: 'Pool, stream and puddles', temple: 'Overgrown temple', 'temple-growth': 'Temple overgrowth' };
  /** the Everest roots that have a coarse stand-in ("ri_rj") */
  const EV_ROOTS = new Set(draws.map((d) => d.mesh && /^EverestCoarse_(\d+)_(\d+)$/.exec(d.mesh)).filter(Boolean).map((m) => `${m[1]}_${m[2]}`));
  const visible = (cam, d) => {
    // Distance LOD rules (shared with the runtime ChunkLodSystem).
    const open = cam.open ?? 0;
    const mtnCap = 26 + 974 * open;
    if (d.chunk) {
      const size = L.CELL_SIZE[d.chunk.cls];
      const mountainCell = L.CHUNK_ORIGIN.x + d.chunk.ix * size >= 30;
      // (the knoll's vista raises the jungle cell cap 100 -> 130 m in the high tier: same functions as ChunkLodSystem)
      if (!L.chunkVisible(d.chunk.cls, L.cellDistance(cam.p[0], cam.p[2], d.chunk.ix, d.chunk.iz, size), LOW, mountainCell ? Math.min(L.viewCap(open), mtnCap) : Math.min(L.viewCap(open), L.jungleCellCap(LOW ? 0 : (cam.vista ?? 0) * (1 - open))))) return false;
    }
    if (/^far-range/.test(d.name) && open <= 0.25) return false;
    {
      // Everest (ChunkLodSystem): fine tiles within 150 m of their root; the per-root stand-ins only while some root is near, else ONE merged mesh;
      // the trail ribbons and the summit cairn within 130 m. `Everest_far_n|w|e` are always drawn (frustum culled).
      const em = d.mesh && /^(?:Everest_(\d+)_(\d+)_\d+|EverestCoarse_(\d+)_(\d+))$/.exec(d.mesh);
      if (em || d.mesh === 'EverestCoarse_all') {
        if (!cam.evNear) {
          cam.evNear = new Set();
          for (const k of EV_ROOTS) {
            const [ri, rj] = k.split('_').map(Number);
            const x0 = L.EVEREST_LOD.x0 + ri * L.EVEREST_LOD.size, z0 = L.EVEREST_LOD.z0 + rj * L.EVEREST_LOD.size;
            if (Math.hypot(Math.max(x0 - cam.p[0], 0, cam.p[0] - (x0 + L.EVEREST_LOD.size)), Math.max(z0 - cam.p[2], 0, cam.p[2] - (z0 + L.EVEREST_LOD.size))) < L.EVEREST_LOD.fine) cam.evNear.add(k);
          }
        }
        if (d.mesh === 'EverestCoarse_all') { if (cam.evNear.size > 0) return false; }
        else {
          const near = cam.evNear.has(`${em[1] ?? em[3]}_${em[2] ?? em[4]}`);
          if (em[1] !== undefined ? !near : near || cam.evNear.size === 0) return false;
        }
      }
      if (d.mesh && /^Everest(?:Trail_\d+|Cairn)$/.test(d.mesh) && Math.hypot(d.x - cam.p[0], d.z - cam.p[2]) - d.r > 130) return false;
    }
    if (/^ridge-\d$/.test(d.name) && (cam.high ?? 0) >= 0.5) return false; // above Everest's clouds
    if (d.name === 'giant-fall' || d.name === 'fall-mist') {
      const fd = Math.hypot(d.x - 187, d.z + 168); // the fall's centre (riverPoint(70))
      if (d.name === 'fall-mist' && (LOW || fd > 480)) return false;
      if (d.mesh === 'FallNear' && fd >= 240) return false;
      if (d.mesh === 'FallFar' && fd < 240) return false;
    }
    if (/^ridge-\d$/.test(d.name) && open >= 0.5 && !((cam.vista ?? 0) > L.VISTA_LANDMARK_ON)) return false;
    // jungle landmarks and tiles are only drawn within 150 m of the player (ChunkLodSystem)
    if ((d.mesh && /^Terrain_\d+_\d+$/.test(d.mesh)) || /^(temple|temple-growth|spire|spire-growth|altar|ruin-pillars|entrance-canopy|water|cliff|waterfall|root-arch|log-giant)$/.test(d.name)) { const named = L.JUNGLE_LANDMARK_CAP_NAMED[LANDMARK_NODE[d.name]]; const lmCap = (cam.vista ?? 0) > L.VISTA_LANDMARK_ON && named !== undefined ? Math.max(named, L.JUNGLE_LANDMARK_CAP) : L.JUNGLE_LANDMARK_CAP; if (Math.hypot(d.x - cam.p[0], d.z - cam.p[2]) - d.r > lmCap) return false; }
    if (d.mesh === 'Mountain_far' && cam.p[0] < 35 - mtnCap) return false; // its box starts at x = 35 (the runtime tests the box, the estimate has only a sphere)
    {
      // terrain LOD: a detailed 96 m root shows fine tiles within 150 m (100 m low) and one coarse mesh beyond
      const rm = d.mesh && /^(?:Mountain_(\d+)_(\d+)_\d+|MtnCoarse_(\d+)_(\d+))$/.exec(d.mesh);
      if (rm) {
        const ri = Number(rm[1] ?? rm[3]), rj = Number(rm[2] ?? rm[4]);
        const x0 = L.TERRAIN_LOD.x0 + ri * 96, z0 = L.TERRAIN_LOD.z0 + rj * 96;
        const dist = Math.hypot(Math.max(x0 - cam.p[0], 0, cam.p[0] - (x0 + 96)), Math.max(z0 - cam.p[2], 0, cam.p[2] - (z0 + 96)));
        const near = dist < (LOW ? L.TERRAIN_LOD.fineLow : L.TERRAIN_LOD.fine);
        if (rm[1] !== undefined ? !near : near) return false;
        if (dist > mtnCap) return false;
      }
    }
    if (/^(rope-bridge|mountain-water|collapse-shelf)$/.test(d.name) && Math.hypot(d.x - cam.p[0], d.z - cam.p[2]) - d.r > mtnCap) return false;
    if (d.mesh && /^RouteTrail_/.test(d.mesh) && Math.hypot(d.x - cam.p[0], d.z - cam.p[2]) - d.r > mtnCap) return false;
    if (LOW && /^(light-shafts|ground-mists|fall-mist)/.test(d.name)) return false;
    const dx = d.x - cam.p[0], dy = d.y - cam.p[1], dz = d.z - cam.p[2];
    if (dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2] < -d.r) return false; // behind
    if (Math.hypot(dx, dy, dz) - d.r > (cam.far ?? FAR)) return false;
    return cam.ps.every((n) => dx * n[0] + dy * n[1] + dz * n[2] >= -d.r);
  };
  // The sky pack (SkySystem) is built at run time, outside the manifest: counted here as a reserve wherever it is shown (vista > ~0.09), 2 draws (1 in the low tier: no clouds).
  const SKYM = await server.ssrLoadModule('/src/scene-assets/sky.scene-asset.ts');
  const triCount = (g) => g.index.count / 3;
  const SKY = { clouds: triCount(SKYM.createSkyClouds()), glow: triCount(SKYM.createSkyGlow()) };
  // Everest's cloud meshes (EverestSystem, runtime, 2 materials outside the manifest): the collar is drawn from below the deck (the estimate counts it
  // whenever the peak is ahead: its sphere is the deck ring), the sea of clouds + the Himalaya from above it (never frustum culled). One or the other.
  const EVSKY = await server.ssrLoadModule('/src/scene-assets/everest-sky.scene-asset.ts');
  const EVC = { collar: triCount(EVSKY.createEverestCollar()), sea: triCount(EVSKY.createEverestSea()) };
  const everestReserve = (cam) => {
    if (cam.p[1] > L.EVEREST.deck - 2) return { tris: EVC.sea, draws: 1 };
    const d = { x: L.EVEREST.x, y: L.EVEREST.deck, z: L.EVEREST.z, r: 240, name: 'everest-collar' };
    return visible(cam, d) ? { tris: EVC.collar, draws: 1 } : { tris: 0, draws: 0 };
  };
  const skyReserve = (cam) => {
    if (!cam) return { tris: 0, draws: 0 };
    const e = everestReserve(cam);
    return { tris: (LOW ? SKY.glow : SKY.clouds + SKY.glow) + e.tris, draws: (LOW ? 1 : 2) + e.draws };
  };
  console.log(`   Everest clouds (runtime, 2 materials outside the manifest): collar ${EVC.collar} triangles (below the deck), sea + Himalaya ${EVC.sea} (above), 1 draw`);
  console.log(`   sky pack (runtime, 2 materials outside the manifest): clouds ${SKY.clouds} + haze/sun ${SKY.glow} triangles, 2 draws`);
  const views = [];
  const N = L.PATH_SAMPLES.length;
  const addView = (name, x, z, yaw, pitch = 0) => { const cam = planes(x, L.terrainHeight(x, z) + 1.65, z, yaw, pitch); cam.vista = L.vistaAt(x, z); views.push({ name, cam }); };
  // the start: the knoll, looking at the waterfall (the tool's yaw is clockwise-positive radians, the game's SPAWN_YAW_DEG counter-clockwise degrees)
  addView('spawn (knoll vista)', L.SPAWN[0], L.SPAWN[1], (-L.SPAWN_YAW_DEG * Math.PI) / 180);
  // the old dense worst case, kept: down the ramp with the gate ahead
  addView('hill ramp (gate ahead)', L.GATE_POSE.x, L.GATE_POSE.z, 0);
  const OLD_START = 5 * 12; // the knoll prefix of the trail (5 spline segments of 12 samples); the fractions below refer to the trail beyond it
  for (const [label, t] of [['gate', 0.2], ['trail 35%', 0.35], ['pool/ford', 0.46], ['root arch', 0.62], ['trail 80%', 0.8], ['clearing', 0.95]]) {
    const i = Math.round(OLD_START + t * (N - 1 - OLD_START));
    const a = L.PATH_SAMPLES[i];
    const b = L.PATH_SAMPLES[Math.min(N - 1, i + 6)];
    addView(label, a[0], a[1], Math.atan2(b[0] - a[0], -(b[1] - a[1])));
  }
  for (const t of Object.values(L.TEST_POSES)) addView(`TEST ${t.id} (headset test pose)`, t.x, t.z, (-t.yawDeg * Math.PI) / 180);
  addView('altar (facing temple)', L.ALTAR[0], L.ALTAR[1] + 2.5, 0);
  addView('altar (looking back)', L.ALTAR[0], L.ALTAR[1] + 2.5, Math.PI);
  // Mountain stations: eye height above the feet, far plane and fog open up with height (AtmosphereSystem).
  for (const [id, v] of Object.entries(L.MTN_VIEWS)) {
    const open = Math.min(1, Math.max(0, (v.y - 3) / 9));
    const cam = planes(v.x, v.y + 1.65, v.z, (-v.yawDeg * Math.PI) / 180, (v.pitchDeg * Math.PI) / 180);
    cam.far = L.JUNGLE_FAR + (1000 - L.JUNGLE_FAR) * open;
    cam.open = open;
    views.push({ name: `MTN ${id}`, cam });
  }
  // Everest stations: jungle air and far plane below the cloud deck, 1.5 km of clear air above it (AtmosphereSystem). Budgeted with the mountain views.
  for (const [id, v] of Object.entries(L.EVEREST_VIEWS)) {
    const eye = v.y + 1.65;
    const cam = planes(v.x, eye, v.z, (-v.yawDeg * Math.PI) / 180, ((v.pitchDeg ?? 0) * Math.PI) / 180);
    cam.high = L.smoothstep(L.EVEREST.deck - 2, L.EVEREST.deck + 16, eye);
    cam.far = L.JUNGLE_FAR + (1500 - L.JUNGLE_FAR) * cam.high;
    cam.vista = L.vistaAt(v.x, v.z);
    views.push({ name: `MTN ${id}`, cam });
  }
  console.log('\n4. visible estimate from standing viewpoints (CPU frustum test, 96x90 deg, far plane per AtmosphereSystem)');
  let worstT = 0, worstD = 0, worstMT = 0, worstMD = 0;
  for (const v of views) {
    const mtnView = v.name.startsWith('MTN ');
    let tris = mtnView ? WILDLIFE.mountain.tris : WILDLIFE.jungle.tris, n = mtnView ? WILDLIFE.mountain.draws : WILDLIFE.jungle.draws;
    { const sk = skyReserve(v.cam); tris += sk.tris; n += sk.draws; }
    for (const d of draws) {
      if (visible(v.cam, d)) {
        // A cell is one mesh: the GPU draws the whole cell when any part is inside the frustum (matches three.js culling).
        tris += d.tris;
        n++;
      }
    }
    if (v.name.startsWith('MTN ')) { worstMT = Math.max(worstMT, tris); worstMD = Math.max(worstMD, n); }
    else { worstT = Math.max(worstT, tris); worstD = Math.max(worstD, n); }
    if (process.argv.includes('--breakdown')) {
      const by = {};
      const byN = {};
      for (const d of draws) if (visible(v.cam, d)) { const k = d.chunk ? d.chunk.cls : d.name.split(' ')[0].replace(/[0-9_]+$/, ''); by[k] = (by[k] ?? 0) + d.tris; byN[k] = (byN[k] ?? 0) + 1; }
      console.log('      draws: ' + Object.entries(byN).sort((a, b) => b[1] - a[1]).slice(0, 9).map(([k, n]) => `${k} ${n}`).join('  '));
      console.log('      ' + Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, t]) => `${k} ${(t / 1000).toFixed(1)}k`).join('  '));
    }
    console.log(`   ${v.name.padEnd(26)} ${String(n).padStart(4)} draws  ${Math.round(tris).toLocaleString().padStart(9)} tris`);
  }
  over('worst jungle-view triangles', worstT, BUDGET.visibleTris);
  over('worst jungle-view draw calls', worstD, BUDGET.visibleDraws);
  over('worst mountain-view triangles', worstMT, BUDGET.mtnTris);
  over('worst mountain-view draw calls', worstMD, BUDGET.mtnDraws);
  // 'low' tier: same viewpoints with the low-tier LOD rules and no shafts/mist
  LOW = true;
  let lowT = 0, lowD = 0;
  const lowRows = [];
  for (const v of views) {
    const sk = skyReserve(v.cam);
    let tris = sk.tris, n = sk.draws;
    for (const d of draws) if (visible(v.cam, d)) { tris += d.tris; n++; }
    lowT = Math.max(lowT, tris); lowD = Math.max(lowD, n);
    if (v.name.startsWith('TEST') || ['MTN summit-down', 'MTN summit-fall', 'MTN descent', 'MTN bridge-mid', 'MTN brink'].includes(v.name)) lowRows.push(`${v.name.padEnd(36)} ${String(n).padStart(4)} draws ${Math.round(tris).toLocaleString().padStart(9)} tris`);
  }
  console.log("\n   'low' tier at the headset test poses (worst low-tier view: " + lowD + ' draws, ' + Math.round(lowT).toLocaleString() + ' tris):');
  lowRows.forEach((r) => console.log('     ' + r));
  LOW = false;
  console.log('\n   NOTE: estimates of submitted work only. Frame time on a Quest 2 (fill-rate bound) must be measured on the device.');
  console.log(`\n${failed ? `BUDGET EXCEEDED (${failed})` : 'within budget'}`);
} finally {
  await server.close();
}
if (CHECK && failed) process.exit(1);

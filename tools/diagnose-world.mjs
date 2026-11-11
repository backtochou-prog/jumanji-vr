#!/usr/bin/env node
/**
 * Diagnostic measurements of the REAL world data (no rendering): spawn, extents, heights, landmark distances,
 * fog and depth numbers, scene-file inventory. Writes reports/world-metrics.json and prints a table.
 *   node tools/diagnose-world.mjs
 * Pure measurement: changes nothing in the project.
 */
import { createServer } from 'vite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, configFile: false, logLevel: 'error', appType: 'custom', server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true } });
const L = await server.ssrLoadModule('/src/world/layout.ts');
const M = await server.ssrLoadModule('/src/world/mountain.ts');
const A = await server.ssrLoadModule('/src/systems/atmosphere-system.ts');

const out = {};
const r2 = (n) => Math.round(n * 100) / 100;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const h = (x, z) => L.terrainHeight(x, z);

// --- extents -----------------------------------------------------------------
const T = L.TERRAIN;
let hmin = Infinity, hmax = -Infinity, hmaxAt = [0, 0];
for (let x = T.x0; x <= T.x1; x += 2) for (let z = T.z0; z <= T.z1; z += 2) {
  const y = h(x, z);
  if (y < hmin) hmin = y;
  if (y > hmax) { hmax = y; hmaxAt = [x, z]; }
}
out.terrain = { x0: T.x0, x1: T.x1, z0: T.z0, z1: T.z1, zSouth: T.zSouth, widthM: T.x1 - T.x0, depthM: T.z1 - T.z0, areaM2: (T.x1 - T.x0) * (T.z1 - T.z0), heightMinM: r2(hmin), heightMaxM: r2(hmax), heightMaxAt: hmaxAt.map(Math.round) };
const W = L.WALK_LIMIT;
out.walkable = { centre: [W.cx, W.cz], radiusX: W.rx, radiusZ: W.rz, widthM: 2 * W.rx, lengthM: 2 * W.rz, areaM2: Math.round(Math.PI * W.rx * W.rz) };
out.mountainZone = { ...M.MZ, widthM: M.MZ.x1 - M.MZ.x0, depthM: M.MZ.z1 - M.MZ.z0 };
let mh = -Infinity; for (let x = M.MZ.x0; x <= M.MZ.x1; x += 4) for (let z = M.MZ.z0; z <= M.MZ.z1; z += 4) mh = Math.max(mh, h(x, z));
out.mountainZone.maxTerrainHeightM = r2(mh);
out.summit = { ...M.SUMMIT, groundAtSummitM: r2(h(M.SUMMIT.x, M.SUMMIT.z)) };

// --- spawn --------------------------------------------------------------------
const sp = [L.SPAWN[0], L.SPAWN[1]];
out.spawn = { x: sp[0], z: sp[1], groundY: r2(h(sp[0], sp[1])), sceneFeetY: 7.037, yawDeg: L.SPAWN_YAW_DEG, hillHeightM: L.HILL.h, hillFootZ: L.HILL.footZ, hillWidthM: [L.HILL.w0, L.HILL.w1] };
// ground rise around spawn: how far you can see before the ground is higher than the eye
const rise = (r) => { let m = -Infinity; for (let a = 0; a < 360; a += 3) m = Math.max(m, h(sp[0] + r * Math.cos((a * Math.PI) / 180), sp[1] + r * Math.sin((a * Math.PI) / 180)) - h(sp[0], sp[1])); return r2(m); };
out.spawn.groundRelativeHeightWithin = { '10m': rise(10), '20m': rise(20), '40m': rise(40), '80m': rise(80) };

// --- forward view ---------------------------------------------------------------
const yaw = (L.SPAWN_YAW_DEG * Math.PI) / 180;
const fwd = [-Math.sin(yaw), -Math.cos(yaw)];
const ground0 = h(sp[0], sp[1]);
const ray = [];
for (let d = 5; d <= 260; d += 5) {
  const x = sp[0] + fwd[0] * d, z = sp[1] + fwd[1] * d;
  ray.push([d, r2(h(x, z) - ground0)]);
}
out.spawnForwardRay = ray.filter((_, i) => i % 3 === 0).map(([d, y]) => ({ distM: d, groundRiseM: y }));
out.spawnForwardMaxRiseM = r2(Math.max(...ray.map((p) => p[1])));

// --- landmarks ------------------------------------------------------------------
const pts = { spawn: sp, ford: [L.FORD.x, L.FORD.z], pool: [L.POOL.x, L.POOL.z], rootArch: [L.ROOT_ARCH.x, L.ROOT_ARCH.z], fallenGiant: [L.FALLEN_GIANT.x, L.FALLEN_GIANT.z], clearingCentre: [L.CLEARING.x, L.CLEARING.z], altar: L.ALTAR, temple: [L.TEMPLE.x, L.TEMPLE.z], spire: [L.SPIRE.x, L.SPIRE.z], cliffFall: [L.CLIFF.x, L.CLIFF.z], vistaFallFoot: L.VISTA.fallFoot, mountainSummit: [M.SUMMIT.x, M.SUMMIT.z] };
out.landmarks = Object.fromEntries(Object.entries(pts).map(([k, p]) => [k, { x: r2(p[0]), z: r2(p[1]), groundY: r2(h(p[0], p[1])) }]));
const pairs = [['spawn', 'ford'], ['spawn', 'pool'], ['spawn', 'altar'], ['spawn', 'clearingCentre'], ['spawn', 'cliffFall'], ['spawn', 'mountainSummit'], ['altar', 'cliffFall'], ['spawn', 'spire'], ['ford', 'pool'], ['altar', 'temple']];
out.landmarkDistancesM = Object.fromEntries(pairs.map(([a, b]) => [`${a}->${b}`, r2(dist(pts[a], pts[b]))]));
let pathLen = 0; for (let i = 1; i < L.PATH_SAMPLES.length; i++) pathLen += dist(L.PATH_SAMPLES[i - 1], L.PATH_SAMPLES[i]);
out.trailLengthM = r2(pathLen);
out.trailSamples = L.PATH_SAMPLES.length;
out.streamLengthM = r2(L.STREAM_SAMPLES.reduce((s, p, i, a) => (i ? s + dist(a[i - 1], p) : s), 0));

// cliff profile along x=5 north->south (the backdrop of the clearing)
const cliff = [];
for (let z = -60; z >= -120; z -= 6) cliff.push({ z, groundY: r2(h(5, z)) });
out.cliffProfileX5 = cliff;

// --- fog and depth --------------------------------------------------------------
const fog = (d, dens) => Math.exp(-((dens * d) ** 2)); // three.js FogExp2 transmittance
const fogTable = [10, 20, 40, 60, 100, 150, 200, 260].map((d) => ({ distM: d, clearJungle: r2(1 - fog(d, 0.0095)), veilAtStart: r2(1 - fog(d, 0.0095 * 1.55)) }));
out.fogFractionAt = fogTable;
out.camera = { near: 0.1, farJungleM: A.atmosphere.far, farMountainM: 1000, nearFarRatioJungle: 260 / 0.1 };
// depth-buffer resolution at distance z for a standard perspective depth buffer: dz ~ z^2 / (near * 2^bits)
out.depthStepAt = {};
for (const bits of [16, 24]) out.depthStepAt[`${bits}bit`] = Object.fromEntries([10, 50, 100, 260].map((z) => [`${z}m`, r2((z * z) / (0.1 * 2 ** bits) * 1000) + ' mm']));

// --- scene file inventory --------------------------------------------------------
const scene = JSON.parse(readFileSync(resolve(root, 'public/scenes/main.iwsdk.scene.json'), 'utf8'));
const countNodes = (ns, acc = { nodes: 0, assets: {} }) => {
  for (const n of ns ?? []) {
    acc.nodes++;
    const c = n.content;
    if (c?.type === 'asset') acc.assets[c.asset] = (acc.assets[c.asset] ?? 0) + 1;
    if (n.children) countNodes(n.children, acc);
  }
  return acc;
};
const inv = countNodes(scene.nodes);
out.sceneFile = { path: 'public/scenes/main.iwsdk.scene.json', units: scene.units, topLevelNodes: scene.nodes.length, totalNodesIncludingChildren: inv.nodes, prefabs: scene.resources.prefabs.length, playerTransform: scene.player.transform, fog: scene.environment.fog, views: scene.authoring.views.map((v) => v.id) };
out.sceneFile.assetRefs = inv.assets;

mkdirSync(resolve(root, 'reports'), { recursive: true });
writeFileSync(resolve(root, 'reports/world-metrics.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ terrain: out.terrain, walkable: out.walkable, spawn: out.spawn, spawnForwardMaxRiseM: out.spawnForwardMaxRiseM, mountainZone: out.mountainZone, summit: out.summit, landmarkDistancesM: out.landmarkDistancesM, trailLengthM: out.trailLengthM, streamLengthM: out.streamLengthM, fogFractionAt: out.fogFractionAt, depthStepAt: out.depthStepAt, cliffProfileX5: out.cliffProfileX5, sceneFile: out.sceneFile }, null, 1));
await server.close();

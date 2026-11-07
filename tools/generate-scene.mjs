#!/usr/bin/env node
/**
 * Generates public/scenes/main.iwsdk.scene.json (and the lightweight XR test
 * fixture public/scenes/test-grab.iwsdk.scene.json) from the art-directed
 * layout rules in src/world (layout.ts + placements.ts + palette.ts).
 *
 *   npm run scene:generate
 *
 * Why a generator: placements follow rules (areas, transition bands, trail,
 * stream, view corridors) shared with the terrain asset, the collision proxy,
 * the ambient-occlusion bake and tools/validate-scene.mjs, so geometry,
 * collision and scene data cannot drift apart. Instanced plants are chunked
 * into square culling cells: an InstancedMesh is frustum-culled as a whole, so bands
 * let the engine skip the parts of the trail the player is not facing.
 *
 * The output is a normal flat iwsdk.scene.v1 document. Hand edits and the scene
 * editor are fine, but regenerating overwrites them (diff first).
 * Requires Node >= 22.18 (native TypeScript type stripping).
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from '../src/world/layout.ts';
import * as P from '../src/world/placements.ts';
import { FOG_COLOR, SUN_DIR } from '../src/world/palette.ts';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../public/scenes/main.iwsdk.scene.json');
const FIXTURE = resolve(here, '../public/scenes/test-grab.iwsdk.scene.json');
const r = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
const deg = (rad) => r((rad * 180) / Math.PI, 2);

const prefabs = [];
const nodes = [];
const prefabSeen = new Set();
const prefab = (assetId) => {
  const id = `p-${assetId}`;
  if (!prefabSeen.has(id)) {
    prefabSeen.add(id);
    prefabs.push({ id, root: { id: `${assetId}-root`, content: { type: 'asset', asset: assetId } } });
  }
  return id;
};

// ---- rotation helpers ------------------------------------------------------
const mul = (a, b) => a.map((row, i) => b[0].map((_, j) => row.reduce((s, _, k) => s + a[i][k] * b[k][j], 0)));
const Rx = (a) => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
const Ry = (a) => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
const Rz = (a) => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
/** three.js Euler 'XYZ' (radians) of a rotation matrix. */
function eulerXYZ(m) {
  const y = Math.asin(Math.max(-1, Math.min(1, m[0][2])));
  if (Math.abs(m[0][2]) < 0.9999) return [Math.atan2(-m[1][2], m[2][2]), y, Math.atan2(-m[0][1], m[0][0])];
  return [Math.atan2(m[2][1], m[1][1]), y, 0];
}
const euler = (m) => eulerXYZ(m).map(deg);
/** Rotation taking unit vector a onto unit vector b (Rodrigues). */
function fromTo(a, b) {
  const v = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const k = 1 / (1 + c);
  return [
    [v[0] * v[0] * k + c, v[0] * v[1] * k - v[2], v[0] * v[2] * k + v[1]],
    [v[1] * v[0] * k + v[2], v[1] * v[1] * k + c, v[1] * v[2] * k - v[0]],
    [v[2] * v[0] * k - v[1], v[2] * v[1] * k + v[0], v[2] * v[2] * k + c],
  ];
}
/** Ground-tilt (world X then Z) composed with a yaw about the instance's own Y. */
const placementEuler = (p) => euler(mul(mul(Rz(p.tiltZ ?? 0), Rx(p.tiltX ?? 0)), Ry(p.yaw)));

// ---- vegetation data -----------------------------------------------------------------------------
// Vegetation, rocks and deadwood are not scene patterns any more: they are static-batched per culling cell
// by src/scene-assets/chunks.scene-asset.ts from the instance lists written to src/world/baked.ts.
/** instances[class][assetId] = flat [x, y, z, yaw, tiltX, tiltZ, scale, ...] */
const instances = {};
function scatter(cls, assetFor, placements) {
  const byAsset = (instances[cls] ??= {});
  for (const p of placements) {
    const asset = assetFor(p);
    (byAsset[asset] ??= []).push(r(p.x, 2), r(p.y, 3), r(p.z, 2), r(p.yaw, 3), r(p.tiltX ?? 0, 3), r(p.tiltZ ?? 0, 3), r(p.scale, 3));
  }
}

const groundY = (x, z) => L.terrainHeight(x, z);

// ---- ground, water, backdrop ---------------------------------------------------
nodes.push({ id: 'terrain', name: 'Terrain + Trail', framingRole: 'support', content: { type: 'asset', asset: 'jungle-terrain', receiveShadow: true }, components: { LocomotionEnvironment: {} } });
nodes.push({ id: 'world-colliders', name: 'Invisible colliders', framingRole: 'support', content: { type: 'asset', asset: 'world-colliders' }, components: { LocomotionEnvironment: {} } });
nodes.push({ id: 'water', name: 'Pool, stream and puddles', framingRole: 'support', content: { type: 'asset', asset: 'water' }, components: { ScrollTexture: { speedU: 0.01, speedV: -0.05 } } });
nodes.push({
  id: 'pool-trickle',
  name: 'Pool cascade',
  content: { type: 'asset', asset: 'pool-trickle' },
  transform: { position: [r(L.POOL.x - 2.1), r(L.POOL.waterY + 1.75), r(L.POOL.z - 2.3)] },
  components: { ScrollTexture: { speedU: 0, speedV: -0.9 } },
});

// Cliff + waterfall: the backdrop of the ancient clearing, facing it.
const toAltar = [L.ALTAR[0] - L.CLIFF.x, L.ALTAR[1] - L.CLIFF.z];
const cliffYaw = r(deg(Math.atan2(toAltar[0], toAltar[1])), 2);
const cliffT = { position: [L.CLIFF.x, -2, L.CLIFF.z], rotationDeg: [0, cliffYaw, 0], scale: 1 };
nodes.push({ id: 'cliff', name: 'Distant cliff', framingRole: 'support', content: { type: 'asset', asset: 'cliff' }, transform: cliffT });
nodes.push({ id: 'waterfall', name: 'Distant waterfall', content: { type: 'asset', asset: 'waterfall' }, transform: cliffT, components: { ScrollTexture: { speedU: 0, speedV: -0.55 } } });
for (let i = 0; i < 3; i++) nodes.push({ id: `ridge-${i}`, name: `Background ridge ${i}`, framingRole: 'support', content: { type: 'asset', asset: `ridge-${i}` } });

// ---- landmarks ----------------------------------------------------------------
nodes.push({ id: 'entrance-canopy', name: 'Entrance limb + lianas', content: { type: 'asset', asset: 'entrance-canopy' } });
nodes.push({
  id: 'root-arch',
  name: 'Root arch (landmark)',
  content: { type: 'asset', asset: 'root-arch' },
  transform: { position: [L.ROOT_ARCH.x, r(groundY(L.ROOT_ARCH.x, L.ROOT_ARCH.z)), L.ROOT_ARCH.z], rotationDeg: [0, deg(L.ROOT_ARCH.yaw), 0] },
});
nodes.push({
  id: 'fallen-giant',
  name: 'Fallen giant (landmark)',
  content: { type: 'asset', asset: 'log-giant' },
  transform: { position: [L.FALLEN_GIANT.x, r(groundY(L.FALLEN_GIANT.x, L.FALLEN_GIANT.z) + 0.55), L.FALLEN_GIANT.z], rotationDeg: [0, deg(L.FALLEN_GIANT.yaw), 0] },
});

// ---- trees ---------------------------------------------------------------------
const trees = P.treePlacements();
// Near trees exist as a detailed class (shown within 46 m) AND a cheap class (shown beyond 30 m);
// the far wall exists only as the cheap, always-visible class.
scatter('trees-hi', (p) => `tree-${p.kind}-${p.variant % P.TREE_VARIANTS[p.kind]}`, trees.filter((t) => t.lod === 'hi'));
scatter('trees-lo', (p) => `tree-${p.kind}-lo`, trees.filter((t) => t.lod === 'hi'));
scatter('trees-far', (p) => `tree-${p.kind}-lo`, trees.filter((t) => t.lod === 'lo'));

// ---- understory, ground layer ----------------------------------------------------
scatter('plants', (p) => `fern-cluster-${p.variant % 3}`, P.plantPlacements('fern'));
// Ground cover is composed into 4 patch assets: meadow (clearing), grass+clover, woodland floor, mossy floor.
const patchId = { flowers: () => 'patch-0', cover: (p) => `patch-${1 + (p.variant % 2) * 1}`, litter: () => 'patch-2', moss: () => 'patch-3' };
for (const kind of ['flowers', 'cover', 'litter', 'moss']) scatter('ground', patchId[kind], P.plantPlacements(kind));
for (const kind of ['treefern', 'broadleaf', 'shrub', 'palm', 'reed', 'pads']) scatter('plants', (p) => `${kind}-${p.variant % P.PLANT_VARIANTS[kind]}`, P.plantPlacements(kind));

// ---- rocks, deadwood, roots ----------------------------------------------------------
const ROCKS = { boulder: 2, slab: 1, standing: 1, cobble: 2 };
scatter('rocks', (p) => `rock-${p.kind}-${p.variant % ROCKS[p.kind]}`, P.rockPlacements());
scatter('deadwood', (p) => `${p.kind}-${p.variant % 2}`, P.deadwoodPlacements());
scatter('deadwood', (p) => `roots-${p.variant % 2}`, P.rootPlacements());

// ---- chunk nodes: one node per (class, cell) that has instances -----------------------------------------------
const CHUNK = L.CHUNK;
const chunkList = [];
{
  const seen = new Set();
  for (const [cls, byAsset] of Object.entries(instances)) {
    for (const flat of Object.values(byAsset)) {
      for (let i = 0; i < flat.length; i += 7) {
        const [ix, iz] = L.chunkIndex(flat[i], flat[i + 2]);
        const id = `veg-${cls}-${ix}-${iz}`;
        if (seen.has(id)) continue;
        seen.add(id);
        chunkList.push({ id, cls, ix, iz });
      }
    }
  }
  chunkList.sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const c of chunkList) nodes.push({ id: c.id, name: `veg ${c.cls} ${c.ix} ${c.iz}`, content: { type: 'asset', asset: c.id }, framingRole: 'support' });
}
void CHUNK;

// ---- the ancient clearing ---------------------------------------------------------------
const tY = groundY(L.TEMPLE.x, L.TEMPLE.z);
nodes.push({ id: 'temple', name: 'Overgrown temple', content: { type: 'asset', asset: 'temple', castShadow: true, receiveShadow: true }, transform: { position: [L.TEMPLE.x, r(tY - 0.05), L.TEMPLE.z] } });
nodes.push({ id: 'temple-growth', name: 'Temple overgrowth', content: { type: 'asset', asset: 'temple-growth' }, transform: { position: [L.TEMPLE.x, r(tY - 0.05), L.TEMPLE.z] } });
const sY = groundY(L.SPIRE.x, L.SPIRE.z);
nodes.push({ id: 'spire', name: 'Ruined spire (landmark)', content: { type: 'asset', asset: 'spire', castShadow: true }, transform: { position: [L.SPIRE.x, r(sY - 0.1), L.SPIRE.z] } });
nodes.push({ id: 'spire-growth', name: 'Spire overgrowth', content: { type: 'asset', asset: 'spire-growth' }, transform: { position: [L.SPIRE.x, r(sY - 0.1), L.SPIRE.z] } });
const altarY = groundY(L.ALTAR[0], L.ALTAR[1]);
nodes.push({ id: 'altar', name: 'Ancient altar', content: { type: 'asset', asset: 'altar', castShadow: true, receiveShadow: true }, transform: { position: [L.ALTAR[0], r(altarY), L.ALTAR[1]], rotationDeg: [0, 0, 0] } });
nodes.push({ id: 'ruin-pillars', name: 'Ruined pillars', content: { type: 'asset', asset: 'ruin-pillars', castShadow: true, receiveShadow: true } });
nodes.push({
  id: 'heartstone',
  name: 'Heartstone (grabbable relic)',
  metadata: { 'jumanji.role': 'relic' },
  content: { type: 'asset', asset: 'heartstone', castShadow: true },
  transform: { position: [L.ALTAR[0], r(altarY + L.ALTAR_TOP_Y + 0.03), L.ALTAR[1]], rotationDeg: [0, 0, 0], scale: 1 },
  components: {
    Relic: { restOffset: 0.03 },
    // Squeeze (grip) with the hand near it, or pinch with tracked hands.
    // NOTE: OneHandGrabbable and DistanceGrabbable/RayInteractable cannot share one entity
    // (the ray never hovers it); see docs/PROJECT_ARCHITECTURE.md > Interaction.
    OneHandGrabbable: {},
  },
});

// ---- atmosphere ----------------------------------------------------------------------------------
// Light shafts (one merged mesh) lean along -SUN_DIR and sit in measured canopy gaps; ground mist likewise.
const shafts = P.lightShafts();
nodes.push({ id: 'light-shafts', name: 'Light shafts', content: { type: 'asset', asset: 'light-shafts' }, components: { Shimmer: { speed: 0.3, amount: 0.22 } } });
nodes.push({ id: 'ground-mists', name: 'Ground mist', content: { type: 'asset', asset: 'ground-mists' } });

// ---- spatial UI + lights -----------------------------------------------------------------------------
const panelT = { position: [r(L.SPAWN[0] + 1.9), 1.5, r(L.SPAWN[1] - 3.0)], rotationDeg: [0, -30, 0], scale: 0.24 };
nodes.push({ id: 'welcome-panel', name: 'Expedition board', content: { type: 'asset', asset: 'welcome-panel' }, transform: panelT, components: { RayInteractable: {} } });
const sunPos = [L.ALTAR[0] + 20, 30, L.ALTAR[1] + 10];
nodes.push({
  id: 'sun',
  name: 'Sun',
  // Light travels along local -Z; rotation derived from SUN_DIR (the single sun direction).
  transform: { position: sunPos, rotationDeg: euler(fromTo([0, 0, -1], SUN_DIR)) },
  components: {
    DirectionalLight: {
      color: [1, 0.9, 0.72, 1],
      intensity: 3.1,
      castShadow: true,
      shadowMapSize: '1024',
      shadowCameraSize: 9,
      shadowCameraNear: 2,
      shadowCameraFar: 60,
      shadowBias: -0.0006,
      shadowNormalBias: 0.03,
      shadowRadius: 3,
    },
  },
});
nodes.push({ id: 'canopy-fill', name: 'Canopy fill', components: { HemisphereLight: { skyColor: [0.5, 0.72, 0.62, 1], groundColor: [0.17, 0.2, 0.1, 1], intensity: 1.25 } } });

// ---- authoring views at standing eye height ------------------------------------------------------------
const eye = (x, z, tx, ty, tz, id, fov = 78) => ({ id, role: 'diagnostic', projection: 'perspective', position: [x, r(groundY(x, z) + 1.65), z], target: [tx, ty, tz], fov });
const views = [
  { id: 'hero', role: 'hero', projection: 'perspective', position: [L.SPAWN[0], r(groundY(...L.SPAWN) + 1.65), L.SPAWN[1]], target: [L.ENTRANCE_TREES[0][0] + 4, 3.0, -8], fov: 78 },
  eye(0.2, 5.5, 0.2, 3, -12, 'v-entrance'),
  eye(0.0, -6.0, -2.2, 2.5, -20, 'v-gate-inside'),
  eye(-3.0, -16.5, -1.2, 1.2, -26, 'v-trail-a'),
  eye(-3.8, -21.0, -1.0, 0.6, -24.5, 'v-pool', 74),
  eye(-1.0, -21.0, 3.5, 1.3, -30, 'v-ford', 74),
  eye(4.6, -31.2, 4.4, 2.0, -42, 'v-rootarch'),
  eye(-1.2, -44.0, -0.6, 2.0, -60, 'v-trail-end'),
  eye(0.0, -55.0, 0.0, 3.0, -70, 'v-clearing'),
  eye(-4.2, -57.5, 0.0, 1.0, -61.5, 'v-altar', 60),
  { id: 'v-top', role: 'diagnostic', projection: 'orthographic', position: [0, 90, -34], target: [0, 0, -34], height: 130 },
];

// ---- baked runtime data: collision + AO + shaft lists, so the runtime never re-runs the placement search ----
const f = (n) => r(n, 2);
const baked = {
  occluders: P.groundOccluders().map((o) => [f(o.x), f(o.z), f(o.r)]),
  trees: trees.map((t) => [f(t.x), f(t.y), f(t.z), f(t.colliderRadius)]),
  rocks: P.rockPlacements().filter((k) => k.collider).map((k) => [f(k.x), f(k.y), f(k.z), f(k.scale), r(k.yaw), { boulder: 0, slab: 1, standing: 2, cobble: 3 }[k.kind]]),
  logs: P.deadwoodPlacements().filter((d) => d.collider).map((d) => [f(d.x), f(d.y), f(d.z), f(0.34 * d.scale), f(d.length), r(d.yaw)]),
  shafts: shafts.map((s) => [f(s.x), f(s.z), f(s.w), f(s.len), f(s.strength)]),
};
writeFileSync(
  resolve(here, '../src/world/baked.ts'),
  `/**
 * GENERATED by tools/generate-scene.mjs - do not edit by hand.
 * Runtime copy of the placement results that the collision proxy, the terrain AO bake and the
 * light-shaft asset need, so the browser never repeats the (slow) placement search.
 */
export const BAKED = {
  /** [x, z, radius] circles that darken the ground around trunks, rocks, logs, ruins. */
  occluders: ${JSON.stringify(baked.occluders)} as [number, number, number][],
  /** [x, groundY, z, colliderRadius] */
  trees: ${JSON.stringify(baked.trees)} as [number, number, number, number][],
  /** [x, groundY, z, scale, yaw, kind(0 boulder,1 slab,2 standing,3 cobble)] */
  rocks: ${JSON.stringify(baked.rocks)} as [number, number, number, number, number, number][],
  /** [x, groundY, z, radius, length, yaw] */
  logs: ${JSON.stringify(baked.logs)} as [number, number, number, number, number, number][],
  /** [x, z, width, length, strength] */
  shafts: ${JSON.stringify(baked.shafts)} as [number, number, number, number, number][],
  /** instances[class][assetId] = flat [x, y, z, yaw, tiltX, tiltZ, scale, ...] (see scene-assets/chunks.scene-asset.ts) */
  instances: ${JSON.stringify(instances)} as Record<string, Record<string, number[]>>,
};
`,
);

const scene = {
  version: 'iwsdk.scene.v1',
  units: 'meters',
  components: {
    'com.iwsdk.components.DomeGradient': { sky: [0.3, 0.55, 0.58, 1], equator: [0.66, 0.77, 0.7, 1], ground: [0.12, 0.17, 0.1, 1], elevationDeg: 32, azimuthDeg: 110, dither: true },
    'com.iwsdk.components.IBLGradient': { sky: [0.36, 0.52, 0.5, 1], equator: [0.36, 0.46, 0.36, 1], ground: [0.1, 0.13, 0.07, 1], intensity: 0.72 },
  },
  environment: {
    toneMapping: 'aces',
    exposure: 1.05,
    shadows: true,
    shadowMapType: 'pcf',
    fog: { type: 'exponential', color: FOG_COLOR, density: 0.0125 },
  },
  player: { transform: { position: [L.SPAWN[0], r(groundY(...L.SPAWN)), L.SPAWN[1]], rotationDeg: [0, 0, 0] } },
  resources: { prefabs },
  authoring: { views },
  nodes,
};

writeFileSync(OUT, JSON.stringify(scene, null, 1) + '\n');

// Lightweight fixture for emulator tests (locomotion, collision, grabbing): terrain + the full
// collision proxy + altar/relic/temple + board; none of the vegetation. Player stands by the altar.
const keep = new Set(['terrain', 'world-colliders', 'altar', 'heartstone', 'temple', 'sun', 'canopy-fill', 'welcome-panel']);
const fx = [L.ALTAR[0] + 1.2, L.ALTAR[1] + 3.2];
const fixture = {
  ...scene,
  resources: { prefabs: [] },
  nodes: nodes.filter((n) => keep.has(n.id)).map((n) => (n.id === 'welcome-panel' ? { ...n, transform: { position: [fx[0] + 3.4, 1.5, fx[1] - 2.0], rotationDeg: [0, -15, 0], scale: 0.24 } } : n)),
  player: { transform: { position: [r(fx[0]), r(groundY(...fx)), r(fx[1])], rotationDeg: [0, 0, 0] } },
};
writeFileSync(FIXTURE, JSON.stringify(fixture, null, 1) + '\n');
// Collision-only route fixture: player at the real spawn; terrain + the full collision proxy, nothing else.
const routeKeep = new Set(['terrain', 'world-colliders', 'sun', 'canopy-fill']);
writeFileSync(resolve(here, '../public/scenes/test-route.iwsdk.scene.json'), JSON.stringify({ ...scene, resources: { prefabs: [] }, nodes: nodes.filter((n) => routeKeep.has(n.id)) }, null, 1) + '\n');
console.log(`wrote ${OUT}: ${nodes.length} nodes (${chunkList.length} vegetation chunks), ${trees.length} trees`);

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
import * as M from '../src/world/mountain.ts';
import * as MP from '../src/world/mountain-placements.ts';
import { FOG_COLOR, SUN_DIR, LIGHT } from '../src/world/palette.ts';

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
nodes.push({ id: 'terrain-far', name: 'Terrain LOD (coarse mountain)', framingRole: 'support', content: { type: 'asset', asset: 'terrain-far' } });
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
nodes.push({ id: 'waterfall', name: 'Distant waterfall', content: { type: 'asset', asset: 'waterfall' }, transform: cliffT, components: { ScrollTexture: { speedU: 0, speedV: -0.7 } } });
for (let i = 0; i < 3; i++) nodes.push({ id: `ridge-${i}`, name: `Background ridge ${i}`, framingRole: 'support', content: { type: 'asset', asset: `ridge-${i}` } });

// ---- mountain expedition ----------------------------------------------------------------------------------
nodes.push({ id: 'far-ranges', name: 'Far ranges', framingRole: 'support', content: { type: 'asset', asset: 'far-ranges' } });
nodes.push({ id: 'mountain-water', name: 'Gorge river, plunge pool, valley river', framingRole: 'support', content: { type: 'asset', asset: 'mountain-water' }, components: { ScrollTexture: { speedU: 0, speedV: -0.06 } } });
nodes.push({ id: 'giant-fall', name: 'Giant waterfall', content: { type: 'asset', asset: 'giant-fall' }, components: { ScrollTexture: { speedU: 0, speedV: -0.7 } } });
nodes.push({ id: 'fall-mist', name: 'Fall mist', content: { type: 'asset', asset: 'fall-mist' } });
nodes.push({ id: 'rope-bridge', name: 'Rope bridge', content: { type: 'asset', asset: 'rope-bridge' }, transform: { position: [M.BRIDGE.ax, M.BRIDGE.y, M.BRIDGE.az] } });
nodes.push({ id: 'bridge-colliders', name: 'Bridge colliders', framingRole: 'support', content: { type: 'asset', asset: 'bridge-colliders' }, transform: { position: [M.BRIDGE.ax, M.BRIDGE.y, M.BRIDGE.az] }, components: { LocomotionEnvironment: { type: 'kinematic' } } });
nodes.push({ id: 'collapse-shelf', name: 'Collapse shelf', content: { type: 'asset', asset: 'collapse-shelf' } });
nodes.push({ id: 'shelf-collider', name: 'Shelf collider', framingRole: 'support', content: { type: 'asset', asset: 'shelf-collider' }, components: { LocomotionEnvironment: { type: 'kinematic' } } });

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
  transform: { position: [L.FALLEN_GIANT.x, r(groundY(L.FALLEN_GIANT.x, L.FALLEN_GIANT.z) + 0.55 * (L.FALLEN_GIANT.radius / 0.85)), L.FALLEN_GIANT.z], rotationDeg: [0, deg(L.FALLEN_GIANT.yaw), 0] },
});

// ---- trees ---------------------------------------------------------------------
const trees = [...P.treePlacements(), ...MP.mountainTrees()];
// Near trees exist as a detailed class (shown within 46 m) AND a cheap class (shown beyond 30 m);
// the far wall exists only as the cheap, always-visible class.
scatter('trees-hi', (p) => `tree-${p.kind}-${p.variant % P.TREE_VARIANTS[p.kind]}`, trees.filter((t) => t.lod === 'hi'));
// The cheap version is the SAME variant as the detailed one (it used to be variant 0 of the kind for every tree: a dark 42 m tree turned into the
// pale 38 m kapok when it crossed the 30 m hand-off, the most visible pop in the forest).
const treeId = (p) => `tree-${p.kind}-${p.variant % P.TREE_VARIANTS[p.kind]}`;
scatter('trees-lo', (p) => `${treeId(p)}-lo`, trees.filter((t) => t.lod === 'hi'));
scatter('trees-far', (p) => `${treeId(p)}-lo`, trees.filter((t) => t.lod === 'lo'));

// ---- understory, ground layer ----------------------------------------------------
const MTN_KINDS = new Set(['fern', 'treefern', 'broadleaf', 'shrub', 'palm', 'cover', 'flowers', 'moss', 'litter']);
const plantsOf = (kind) => [...P.plantPlacements(kind), ...(MTN_KINDS.has(kind) ? MP.mountainPlants(kind) : [])];
scatter('plants', (p) => `fern-cluster-${p.variant % 3}`, plantsOf('fern'));
// Ground cover is composed into 4 patch assets: meadow (clearing), grass+clover, woodland floor, mossy floor.
const patchId = { flowers: () => 'patch-0', cover: (p) => `patch-${1 + (p.variant % 2) * 1}`, litter: () => 'patch-2', moss: () => 'patch-3' };
for (const kind of ['flowers', 'cover', 'litter', 'moss']) scatter('ground', patchId[kind], plantsOf(kind));
// The knoll meadow: wind-swept opaque tufts (variants 0-3) and wildflower clumps (4-7), their own prototypes in the ground cells.
scatter('ground', (p) => (p.variant < 4 ? `meadow-tuft-${p.variant}` : `meadow-flowers-${p.variant - 4}`), plantsOf('meadow'));
for (const kind of ['treefern', 'broadleaf', 'shrub', 'palm', 'reed', 'pads']) scatter('plants', (p) => `${kind}-${p.variant % P.PLANT_VARIANTS[kind]}`, plantsOf(kind));
scatter('plants', (p) => `vine-${p.variant % 3}`, MP.mountainVines());

// ---- rocks, deadwood, roots ----------------------------------------------------------
const ROCKS = { boulder: 2, slab: 1, standing: 1, cobble: 2 };
const allRocks = [...P.rockPlacements(), ...MP.mountainRocks()];
const allDead = [...P.deadwoodPlacements(), ...MP.mountainDeadwood()];
// (the knoll's own sunlit boulders / monoliths / lookout stone / pebbles name their prototype explicitly: p.fixedVariant, see placements.ts knollDressing)
scatter('rocks', (p) => `rock-${p.kind}-${p.fixedVariant ?? p.variant % ROCKS[p.kind]}`, allRocks);
scatter('deadwood', (p) => `${p.kind}-${p.variant % 2}`, allDead);
scatter('deadwood', (p) => `roots-${p.variant % 2}`, [...P.rootPlacements(), ...MP.mountainRoots()]);
// Mountain far field: tree crowns seen from above (valley + ridge) and the rock towers (64 m cells).
scatter('canopy', (p) => `canopy-${p.variant % 3}`, MP.canopyClumps());
scatter('crags', (p) => `pinnacle-${p.variant % 3}`, MP.cragPlacements());

// ---- chunk nodes: one node per (class, cell) that has instances -----------------------------------------------
const CHUNK = L.CHUNK;
const chunkList = [];
{
  const seen = new Set();
  for (const [cls, byAsset] of Object.entries(instances)) {
    for (const flat of Object.values(byAsset)) {
      for (let i = 0; i < flat.length; i += 7) {
        const [ix, iz] = L.chunkIndex(flat[i], flat[i + 2], L.CELL_SIZE[cls]);
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
const tY = L.TEMPLE_BASE;
nodes.push({ id: 'temple', name: 'Overgrown temple', content: { type: 'asset', asset: 'temple', castShadow: true, receiveShadow: true }, transform: { position: [L.TEMPLE.x, r(tY), L.TEMPLE.z] } });
nodes.push({ id: 'temple-growth', name: 'Temple overgrowth', content: { type: 'asset', asset: 'temple-growth' }, transform: { position: [L.TEMPLE.x, r(tY), L.TEMPLE.z] } });
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
const shafts = [...P.lightShafts(), ...P.vistaShafts()];
// (The additive light shafts were removed on user feedback: they read as flat yellow stripes. The 'light-shafts' asset stays registered.)
nodes.push({ id: 'ground-mists', name: 'Ground mist', content: { type: 'asset', asset: 'ground-mists' } });

// ---- spatial UI + lights -----------------------------------------------------------------------------
// The board stands on a lectern stone to the right of the view (70 degrees off the heading, 2.3 m out: found by turning the head, never in the way of the fall).
// It floats 1.2 m above the GROUND at its own spot (the start is on a hill: an absolute height would bury it or float it), faces the start point and leans
// back 22 degrees like a reading stand. Scale 0.30 (UIKit units are cm): body text 20 px = 6 cm = 1.5 degrees at 2.3 m, the heading 2.5 degrees.
const lectern = P.lecternSpot();
const panelXZ = [lectern.x, lectern.z];
const panelRot = euler(mul(Ry(lectern.faceYaw), Rx((-22 * Math.PI) / 180)));
const panelT = { position: [r(panelXZ[0]), r(groundY(...panelXZ) + 1.2), r(panelXZ[1])], rotationDeg: panelRot, scale: 0.3 };
nodes.push({ id: 'welcome-panel', name: 'Expedition board', content: { type: 'asset', asset: 'welcome-panel' }, transform: panelT, components: { RayInteractable: {} } });
// (ShadowFollowSystem re-places the sun every time the player moves; this is only where it starts: 40 m toward the sun from the altar.)
const sunPos = [r(L.ALTAR[0] - SUN_DIR[0] * 40), r(groundY(...L.ALTAR) - SUN_DIR[1] * 40), r(L.ALTAR[1] - SUN_DIR[2] * 40)];
nodes.push({
  id: 'sun',
  name: 'Sun',
  // Light travels along local -Z; rotation derived from SUN_DIR (the single sun direction).
  transform: { position: sunPos, rotationDeg: euler(fromTo([0, 0, -1], SUN_DIR)) },
  components: {
    DirectionalLight: {
      color: [...LIGHT.sunColor, 1],
      intensity: LIGHT.sunIntensity,
      castShadow: true,
      shadowMapSize: '1024',
      shadowCameraSize: 8, // 8 m window / 1024 px = 7.8 mm texels: a 1 m world step is a whole 128 texels (ShadowFollowSystem snaps to texels)
      shadowCameraNear: 2,
      shadowCameraFar: 60,
      shadowBias: -0.0006,
      shadowNormalBias: 0.03,
      shadowRadius: 3,
    },
  },
});
nodes.push({ id: 'canopy-fill', name: 'Canopy fill', components: { HemisphereLight: { skyColor: [...LIGHT.hemiSky, 1], groundColor: [...LIGHT.hemiGround, 1], intensity: LIGHT.hemiIntensity } } });

// ---- authoring views at standing eye height ------------------------------------------------------------
const eye = (x, z, tx, ty, tz, id, fov = 78) => ({ id, role: 'diagnostic', projection: 'perspective', position: [x, r(groundY(x, z) + 1.65), z], target: [tx, ty, tz], fov });
const views = [
  { id: 'hero', role: 'hero', projection: 'perspective', position: [L.SPAWN[0], r(groundY(...L.SPAWN) + 1.65), L.SPAWN[1]], target: [4.3, 30, -91], fov: 78 },
  { id: 'v-everest', role: 'diagnostic', projection: 'perspective', position: [L.START[0], r(L.START_Y + 1.65), L.START[1]], target: [L.SPAWN[0], 60, L.SPAWN[1]], fov: 78 },
  { id: 'v-vista', role: 'diagnostic', projection: 'perspective', position: [L.SPAWN[0], r(groundY(...L.SPAWN) + 1.65), L.SPAWN[1]], target: [2, 22, -91], fov: 70 },
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
// Mountain expedition views (standing eye height on the route; look targets follow the route or the valley).
{
  const R = L.MTN;
  const atS = (s) => R.samples.reduce((b, q) => (Math.abs(q.s - s) < Math.abs(b.s - s) ? q : b));
  const along = (s, ahead = 10, up = 0.4) => { const a = atS(s); const b = atS(s + ahead); return [a.x, r(a.y + 1.65), a.z, b.x, r(b.y + 1.65 + up), b.z]; };
  const view = (id, [x, y, z, tx, ty, tz], fov = 78) => views.push({ id, role: 'diagnostic', projection: 'perspective', position: [r(x), r(y), r(z)], target: [r(tx), r(ty), r(tz)], fov });
  view('m-climb', along(95, 12, 0.3));
  view('m-climb-high', along(165, 14, 0.2));
  const [dx, dz] = M.SUMMIT_DIR;
  const lip = [M.PLATFORM.x + dx * (M.PLATFORM.r - 1.4), M.PLATFORM.z + dz * (M.PLATFORM.r - 1.4)];
  const ly = M.PLATFORM.y + 1.65;
  view('m-summit', [lip[0], ly, lip[1], lip[0] + dx * 60, ly - 6, lip[1] + dz * 60 - 10], 84);
  view('m-summit-down', [lip[0], ly, lip[1], lip[0] + dx * 8, ly - 40, lip[1] + dz * 8], 84);
  view('m-summit-fall', [lip[0], ly, lip[1], 202, -22, -170], 70);
  view('m-descent', along(225, 14, -0.3));
  view('m-ledge', along(262, 16, -0.2));
  view('m-cleft', along(R.cleft.s0 - 8, 14, -0.1));
  view('m-bridge-w', [M.BRIDGE.ax - 2.5, M.BRIDGE.y + 1.65, M.BRIDGE.az, M.BRIDGE.bx, M.BRIDGE.y + 0.6, M.BRIDGE.bz], 80);
  view('m-bridge-mid', [(M.BRIDGE.ax + M.BRIDGE.bx) / 2, M.BRIDGE.y - M.BRIDGE.sag + 1.65, M.BRIDGE.az, (M.BRIDGE.ax + M.BRIDGE.bx) / 2 + 1, M.BRIDGE.y - 14, M.BRIDGE.az + 8], 84);
  view('m-bridge-cascade', [M.BRIDGE.ax + 9, M.BRIDGE.y - M.BRIDGE.sag + 1.65, M.BRIDGE.az, 187, 20, -215], 80);
  view('m-brink', [M.TERRACE.x - 1.6, M.TERRACE.y + 1.65, M.TERRACE.z + 1.6, 190, M.TERRACE.y - 18, -178], 84);
  views.push({ id: 'm-top', role: 'diagnostic', projection: 'orthographic', position: [200, 160, -150], target: [200, 0, -150], height: 340 });
}

// ---- baked runtime data: collision + AO + shaft lists, so the runtime never re-runs the placement search ----
const f = (n) => r(n, 2);
const baked = {
  occluders: [...P.groundOccluders(), ...MP.mountainOccluders()].map((o) => [f(o.x), f(o.z), f(o.r)]),
  // Trunk colliders: the jungle's, plus the mountain trees that stand beside the route (valley emergents never need one).
  trees: trees.filter((t) => t.x < 30 || M.routeNear(L.MTN, t.x, t.z).dist < 20).map((t) => [f(t.x), f(t.y), f(t.z), f(t.colliderRadius)]),
  rocks: allRocks.filter((k) => k.collider).map((k) => [f(k.x), f(k.y), f(k.z), f(k.scale), r(k.yaw), { boulder: 0, slab: 1, standing: 2, cobble: 3 }[k.kind]]),
  logs: allDead.filter((d) => d.collider).map((d) => [f(d.x), f(d.y), f(d.z), f(0.34 * d.scale), f(d.length), r(d.yaw)]),
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
    // Light rig = palette.ts LIGHT_PRESETS[ACTIVE_LIGHT] (golden hour; 'noon' recovers the old look). AtmosphereSystem overwrites the dome's sky/equator/elevation at runtime.
    'com.iwsdk.components.DomeGradient': { sky: [...LIGHT.domeSky, 1], equator: [...LIGHT.domeEquator, 1], ground: [...LIGHT.domeGround, 1], elevationDeg: 32, azimuthDeg: LIGHT.domeAzimuthDeg, dither: true },
    // IBL is baked ONCE (PMREM): never animate it at runtime.
    'com.iwsdk.components.IBLGradient': { sky: [...LIGHT.iblSky, 1], equator: [...LIGHT.iblEquator, 1], ground: [...LIGHT.iblGround, 1], intensity: LIGHT.iblIntensity },
  },
  environment: {
    toneMapping: 'aces',
    exposure: LIGHT.exposure,
    shadows: true,
    shadowMapType: 'pcf',
    fog: { type: 'exponential', color: FOG_COLOR, density: 0.0095 },
  },
  // the game starts on Everest's summit (world/everest.ts); Overlook Knoll (L.SPAWN) is where its trail arrives
  player: { transform: { position: [L.START[0], r(L.START_Y), L.START[1]], rotationDeg: [0, L.START_YAW_DEG, 0] } },
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
const routeKeep = new Set(['terrain', 'world-colliders', 'bridge-colliders', 'shelf-collider', 'sun', 'canopy-fill']);
writeFileSync(resolve(here, '../public/scenes/test-route.iwsdk.scene.json'), JSON.stringify({ ...scene, resources: { prefabs: [] }, nodes: nodes.filter((n) => routeKeep.has(n.id)) }, null, 1) + '\n');
console.log(`wrote ${OUT}: ${nodes.length} nodes (${chunkList.length} vegetation chunks), ${trees.length} trees`);

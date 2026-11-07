/**
 * Asset catalogue. Evaluated by BOTH the runtime and the editor, so it must
 * stay deterministic and side-effect free (no World, DOM, timers).
 * Static geometry lives in src/scene-assets/*; scene JSON only references the
 * ids registered here. See docs/PROJECT_ARCHITECTURE.md.
 *
 * Two kinds of entries:
 *   - singletons: terrain, water, landmarks, ruins, relic, atmosphere, colliders, UI
 *   - `veg-<class>-<ix>-<iz>`: static-batched culling cells (all vegetation, rocks and
 *     deadwood of one class inside one 28 m cell), built from src/world/baked.ts.
 *     The species factories are prototypes for those cells; they are not placed one by one.
 * Build time of each group is recorded in BUILD_TIMES (read by tools/asset-stats.mjs).
 */
import { AssetType, defineAssets } from '@iwsdk/core';
import { createGroundMists, createLightShafts } from './scene-assets/atmosphere.scene-asset.js';
import { createRidge } from './scene-assets/background.scene-asset.js';
import { CHUNK_ASSETS, createChunk } from './scene-assets/chunks.scene-asset.js';
import { createColliders } from './scene-assets/colliders.scene-asset.js';
import { createGiantLog } from './scene-assets/deadwood.scene-asset.js';
import { createCliff, createTrickle, createWaterfall } from './scene-assets/rocks.scene-asset.js';
import { createAltar, createHeartstone, createRuinPillars } from './scene-assets/ruins.scene-asset.js';
import { createSpire, createSpireGrowth, createTemple, createTempleGrowth } from './scene-assets/temple.scene-asset.js';
import { createTerrain } from './scene-assets/terrain.scene-asset.js';
import { createEntranceCanopy, createRootArch } from './scene-assets/trees.scene-asset.js';
import { createWater } from './scene-assets/water.scene-asset.js';
import { SPIRE } from './world/layout.js';

const publicAssetUrl = (filePath: string): string => `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;

const uikitml = (fileName: string, name: string) => ({
  url: publicAssetUrl(`ui/${fileName}`),
  type: AssetType.UIKitML,
  name,
});

/** Milliseconds spent building each group of assets (diagnostics only; not part of the manifest). */
export const BUILD_TIMES: Record<string, number> = {};
const timed = <T>(group: string, make: () => T): T => {
  const t = performance.now();
  const out = make();
  BUILD_TIMES[group] = (BUILD_TIMES[group] ?? 0) + (performance.now() - t);
  return out;
};

const chunks: Record<string, object> = {};
timed('vegetation chunks (incl. species prototypes)', () => {
  for (const c of CHUNK_ASSETS) chunks[c.id] = createChunk(c.cls, c.ix, c.iz);
});

export default defineAssets({
  // Ground, water, backdrop
  'jungle-terrain': timed('terrain', createTerrain),
  water: timed('water', createWater),
  'pool-trickle': createTrickle(),
  cliff: timed('cliff', createCliff),
  waterfall: createWaterfall(),
  'ridge-0': createRidge(0),
  'ridge-1': createRidge(1),
  'ridge-2': createRidge(2),

  // Landmarks + the three areas
  'entrance-canopy': timed('landmarks', createEntranceCanopy),
  'root-arch': timed('landmarks', createRootArch),
  'log-giant': timed('landmarks', createGiantLog),
  altar: createAltar(),
  'ruin-pillars': timed('ruins', createRuinPillars),
  heartstone: createHeartstone(),
  temple: timed('ruins', createTemple),
  'temple-growth': timed('ruins', createTempleGrowth),
  spire: timed('ruins', () => createSpire(SPIRE.h)),
  'spire-growth': timed('ruins', () => createSpireGrowth(SPIRE.h)),

  // Static-batched vegetation, rocks and deadwood
  ...chunks,

  // Atmosphere + collision
  'light-shafts': createLightShafts(),
  'ground-mists': createGroundMists(),
  'world-colliders': timed('colliders', createColliders),

  // Spatial UI
  'welcome-panel': uikitml('welcome.uikitml', 'Welcome Panel'),
});

/**
 * Jumanji VR - Prompt 01 foundation.
 * World.create() reads iwsdk.config.json (via the virtual project module):
 * scene, assets, components, XR + locomotion + grabbing features.
 * Gameplay systems are registered explicitly below; add new ones here.
 */
import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { PanelSystem } from './panel.js';
import { DesktopLookSystem } from './systems/desktop-look-system.js';
import { metrics } from './diagnostics/frame-metrics.js';
import { PerfOverlaySystem } from './diagnostics/perf-overlay.js';
import { PerfTestSystem } from './diagnostics/perf-test.js';
import { applyQuality, applyTier, loadTier, warmShaders } from './settings/quality.js';
import { AtmosphereSystem } from './systems/atmosphere-system.js';
import { SkySystem } from './systems/sky-system.js';
import { BridgeSystem } from './systems/bridge-system.js';
import { CollapseSystem } from './systems/collapse-system.js';
import { ComfortSystem } from './systems/comfort-system.js';
import { SafetySystem } from './systems/safety-system.js';
import { ChunkLodSystem } from './systems/chunk-lod-system.js';
import { QualityGovernor } from './systems/quality-governor.js';
import { ShadowFollowSystem } from './systems/shadow-follow-system.js';
import { StartPointSystem } from './systems/start-point-system.js';
import { IntroSystem } from './systems/intro-system.js';
import { DebugSystem } from './systems/debug-system.js';
import { WaterSystem, ShimmerSystem } from './systems/ambient-systems.js';
import { RelicSystem } from './systems/relic-system.js';
import { ReactiveFoliageSystem, WildlifeSystem } from './wildlife/wildlife-system.js';

World.create(document.getElementById('scene-container') as HTMLDivElement, projectOptions).then((world) => {
  console.info('[jumanji] quality', applyQuality(world));
  metrics.install(world);
  console.info(`[jumanji] GPU timer: ${metrics.gpuStatus}`);
  world.registerSystem(StartPointSystem);
  world.registerSystem(AtmosphereSystem);
  world.registerSystem(SkySystem);
  world.registerSystem(ChunkLodSystem);
  world.registerSystem(WildlifeSystem);
  world.registerSystem(IntroSystem);
  world.registerSystem(ReactiveFoliageSystem);
  world.registerSystem(CollapseSystem);
  world.registerSystem(BridgeSystem);
  world.registerSystem(SafetySystem);
  world.registerSystem(ComfortSystem);
  world.registerSystem(ShadowFollowSystem);
  world.registerSystem(QualityGovernor);
  world.registerSystem(RelicSystem);
  world.registerSystem(WaterSystem);
  world.registerSystem(ShimmerSystem);
  world.registerSystem(DesktopLookSystem);
  world.registerSystem(PanelSystem);
  world.registerSystem(PerfTestSystem);
  world.registerSystem(PerfOverlaySystem);
  world.registerSystem(DebugSystem);
  // Handy for console debugging / headless tests.
  // The scene (level) is built asynchronously: apply the saved tier once it exists.
  const tier = loadTier();
  const t = setInterval(() => {
    if (world.scene.children.length > 4) {
      clearInterval(t);
      if (tier === 'low') applyTier(world, 'low');
      warmShaders(world, true);
    }
  }, 250);
  (window as unknown as { __jumanji?: unknown }).__jumanji = { world };
});

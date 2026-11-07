# Project architecture

How the jungle is put together, why, and where to extend it (Prompt 03 state).

## 1. Foundation

| Choice | Detail |
| --- | --- |
| SDK | Meta **Immersive Web SDK** `@iwsdk/core` **1.1.0-rc.2** (a release candidate; stable 1.0.1 exists), Three.js r185 |
| Language / build | TypeScript, Vite 7, dev server `https://localhost:8081` (WebXR needs HTTPS) |
| Target | Meta Quest 2 (`immersive-vr`, `local-floor`); desktop dev with the IWER emulator set to a Quest 2 |
| Features | Locomotion, grabbing, hand tracking (requested). Physics, scene understanding: **off** |

IWSDK specifics worth remembering: `iwsdk.config.json` is the authority (not `vite.config.ts`);
`src/assets.ts` is evaluated in two realms (runtime and editor) and must be deterministic and
side-effect free; ECS components live in a system-free module; import Three from `@iwsdk/core`.

## 2. Data flow: rules → baked data → assets → scene

```
src/world/layout.ts      terrain height, trail, stream, areas, landmarks, culling cells, LOD rules   (pure)
src/world/placements.ts  where everything goes and why (bands, areas, spacing, corridors)            (pure, Node-time)
src/world/palette.ts     colours, roughness table, SUN_DIR, FOG_COLOR                               (pure)
        │
        ▼  tools/generate-scene.mjs   (npm run scene:generate, Node ≥ 22.18)
src/world/baked.ts       GENERATED: collider lists, AO occluders, shafts, vegetation instances
public/scenes/main.iwsdk.scene.json   landmarks, water, lights, 80 vegetation-cell nodes, views
        │
        ▼  runtime
src/scene-assets/*       procedural geometry; chunks.scene-asset.ts merges baked instances per cell
src/systems/*            behaviour (relic, LOD, shadow, governor, ...)
```

`placements.ts` runs **only in Node** (the search for tree/rock/plant positions takes ~0.5 s). The
browser reads `baked.ts`, so start-up never repeats it. Everything that must agree (terrain AO,
collision proxy, scene nodes, validator) derives from the same lists, so they cannot drift.

> Regenerating overwrites scene-editor hand edits (diff first). `npm run validate` after any change.

## 3. The world

Three areas along one ~75 m trail (`layout.ts`: `PATH_POINTS`, `areaAt`, `areaWeights`):

| Area | z range | Identity | Landmarks |
| --- | --- | --- | --- |
| Jungle Entrance | +14 … −9 | cool, dark, dense, ground mist | colossal gate trees + overhead limb with lianas |
| Forest Trail | −9 … −47 | layered, winding, shafts of light | muddy hollows, **ford** + stepping stones, **pool** + cascade, **root arch**, **fallen giant**, rock outcrop, **spire** glimpsed above |
| Ancient Clearing | −47 … −75 | open, warm, wildflowers (the warm accent) | overgrown **temple** (sun-disc relief), pillars, **altar + Heartstone**, waterfall cliff backdrop |

**Terrain:** macro relief + detail noise, the trail is graded to a smoothed profile (steepest trail
slope 0.21 ≈ 12°), the stream has its own monotone downhill water profile that meets the trail at the
ford, a pool basin, mud hollows, jungle-wall hills beyond the walkable ellipse. 4×4 tiles
(1.25 / 2.5 / 5 m cells by distance from the trail) with skirts; vertex-colour splat of the palette
(grass/moss/soil/litter/stone/mud) driven by canopy openness, wetness, slope and noise; per-area grading;
baked AO around trunks, rocks, logs and ruins. The trail ribbon dissolves into the splat at its edges.

**Background:** three fogged ridge silhouettes (84/102/120 m), unlit, 3 draws. **Lighting:** one sun
(`SUN_DIR`, high ESE) + hemisphere + gradient IBL; shafts lean along `-SUN_DIR` and sit in canopy gaps
measured from the placement data; fog colour = ridge fade colour.

**Art consistency:** one palette and one roughness table (`palette.ts`) feed every asset; one
sun; stone is cool grey (never tan); the single warm accent (amber/orange) is reserved for flowers,
the relic's heart and the sun. Contact with the ground is by construction (origins on the ground,
rocks/logs/roots sunk) and **verified** by `tools/validate-scene.mjs`.

## 4. Vegetation system

**Representation:** alpha-*test* cutout cards textured from ONE 512² procedural **leaf atlas**
(`lib/leaf-atlas.ts`: broad, heart, palm frond, fern frond, wide frond, clover, vine, leaf clump,
moss, litter, flowers, grass, neutral bark; ~1.4 MB with mips; analytic shapes, no image files).
Wood (trunks, stems) maps to the atlas' solid bark tile, so a whole tree or plant is **one mesh and
one material**. Cards carry authored *soft normals* (rounded-mass lighting; the material uses them on
both faces). Trunks are real geometry with buttress lobes and bark grooves shared by shape and colour.

**Species (biologically bounded, narrow uniform scale ±8–14 %, tilt ≤ 6°, per-instance tint ±9 %):**
trees (giant ×3, tall ×2, broad ×2, slender ×1, each hi + lo detail), palms ×4 silhouettes
(arching, fan, clustered slender, sago), broad-leaf ×3, ferns in S/M/L clusters, tree ferns, shrubs,
ground-cover patches ×4, reeds, pads, fallen logs, branches, exposed root runs, rocks (boulder/slab/standing/cobble).

**Placement (`placements.ts`)** follows *transition bands* from the trail edge: bare trail → ground
cover/litter/flowers (0.3–2.6 m) → ferns (1–10 m) → broad-leaf/shrubs (2.4–15 m) → palms (3–18 m) →
trees (spacing grows with trunk footprint, never on the trail, the water, or the two protected view
corridors to the waterfall and the spire). Mix by area (entrance dense/fern-heavy, clearing open meadow).

## 5. Rendering strategy for Quest 2 (static batching, not GPU instancing)

Measured with `npm run stats`: instancing one draw per species per cell either cannot cull (coarse
cells: ~209k triangles visible from the spawn) or explodes draws (28 m cells: 274). So vegetation,
rocks and deadwood are **static-batched**: all instances of one *class* inside one 28 m cell are merged
into **one mesh** (`chunks.scene-asset.ts`, from `baked.ts`). Result: a few draws per cell, exact
frustum/distance culling per cell, and per-instance scale/yaw/tilt/tint (no visibly repeated plant).
Cost: merged copies in memory (a few MB here).

| Class | Shown | Material |
| --- | --- | --- |
| `trees-hi` | within 42 m | foliage cards |
| `trees-lo` | beyond 28 m (cheap trunk + 2 crown cards) | foliage cards |
| `trees-far` | always (far wall, cheap version only) | foliage cards |
| `plants` | within 50 m | foliage cards |
| `ground` (patches) | within 34 m | foliage cards |
| `rocks` / `deadwood` | within 62 / 48 m | rock / bark |

`ChunkLodSystem` toggles `visible` per cell every 0.25 s with these rules (shared with the budget
tool; the `low` tier scales them by 0.72). Three.js then frustum-culls each visible cell.

**Materials (12):** foliage-card (atlas, alpha-test), ground (two-scale anti-tiling albedo + bump,
terrain *and* trail), rock/bark/ruin (grain + procedural bump), relic ×3, water, waterfall, light
shafts (additive), silhouette (unlit). Textures ≈ 5 MB total with mips. **No post-processing, no
reflection pass.**

**Water:** one merged mesh for pool + stream + puddles (1 draw): RGBA vertex colour (clear
shallows, alpha fades to the bank), scrolling ripple bump so the sun glint moves, and a fresnel sky tint
in the material as the fake reflection. **Shadows:** one 1024² directional shadow that *follows the
player* (`ShadowFollowSystem`, snapped to 1 m); casters are the ruins, altar, pillars and the Heartstone;
baked vertex AO does the rest of the forest.

**Tiers and governor:** `high` / `low` (board toggle, `?quality=`). `low` = no real-time shadows, no
shafts/mist, LOD distances x0.72, plus (`CHUNK_LOW_MAX/MIN` in `layout.ts`, `chunkVisible()`) a nearer cut-off for the far wall
(60 m), ground patches (20 m) and a hand-over to the cheap tree version at 24 m. Measured: -19..-21 % triangles, -16..-22 % draws, -11..-15 % foliage fill.
`QualityGovernor` (details in section 10) steps down once for shadows, once for the low tier; never back up. Foveation 1.0 by default.

**Shadows without recompiling shaders:** turning `renderer.shadowMap.enabled` off (4 new programs) or every
`castShadow` off (10 new programs) forces synchronous shader compiles, a hitch exactly when frames are late.
`setShadows()` in `settings/quality.ts` instead shrinks the sun's shadow-camera frustum to +-0.001 m (0 new programs, no shadow pass) and restores it on demand.
`warmShaders()` runs `renderer.compileAsync` on page ready and at every session start.

**Foliage cost control:** crown cards use an octagon (`blobCardGeometry`) that follows the alpha silhouette, hi crowns have 3 cards per
tip and lo/far crowns 1 larger card (entrance: shaded-then-discarded fragments -25 %). Shaft quads are trimmed to the visible beam.

## 6. Interaction model (unchanged from Prompt 01)

- **Locomotion:** left thumbstick, right-stick snap turn (30°), no jumping. Walkable: the terrain node
  (`LocomotionEnvironment`). One **invisible collider proxy** (`visible = false` meshes still count
  for IWSDK's BVH) holds the boundary wall, trunks, big rocks, logs, root-arch leg, temple platform/wall/
  columns, spire, pillars, altar. Colliders are generous (buttress footprints), the 1.8 m trail lane is validated clear.
- **Grabbing:** the Heartstone has `OneHandGrabbable` only. **Never combine with `DistanceGrabbable` /
  `RayInteractable` on one entity** (the ray never hovers it). `RelicSystem` settles it on the altar/ground (physics off).
- **Spatial UI:** panel node needs `RayInteractable`; UIKit units are cm (460 × scale 0.24 ≈ 1.1 m); ASCII text only;
  **a click is a short press (≈0.2 s)**: long presses do not count as clicks.

## 7. Tooling

| Tool | Purpose |
| --- | --- |
| `tools/generate-scene.mjs` | rules → `baked.ts` + scene + two fixtures (`test-grab`, `test-route`) |
| `tools/validate-scene.mjs` | contact, trunk overlap, trail lane, flood-fill reachability of every landmark, slope, area counts |
| `tools/asset-stats.mjs` | budgets, build time, texture memory, **visible estimate** per viewpoint (CPU frustum + the LOD rules) |
| `?debug` / `DebugSystem` | console telemetry from `diagnostics/frame-metrics` (frame, p95, CPU, draws, triangles, `cells=shown/total`) |
| `tools/perf-probe.mjs` (`npm run perf:probe`) | headless Chromium at the three test poses x tiers: exact draws/triangles/cells, overdraw per class, shader-program experiment |
| IWSDK CLI | `xr enter`, `xr set-gamepad-state`, `ecs find/query`, `ui inspect`, `scene screenshot --viewId …` |

Authored views (`authoring.views`) sit at standing eye height in every area (`v-entrance`, `v-gate-inside`,
`v-trail-a`, `v-pool`, `v-ford`, `v-rootarch`, `v-trail-end`, `v-clearing`, `v-altar`) for repeatable still reviews.

## 8. Extending

| Want | Do |
| --- | --- |
| a new plant/prop | add a factory under `scene-assets/`, add it to `prototype()` in `chunks.scene-asset.ts`, give it placements in `placements.ts` and a class in the generator, then `scene:generate`, `validate`, `stats:check` |
| a new interactable | component in `src/components/`, system in `src/systems/`, register in `src/index.ts`; near-grab (`OneHandGrabbable`) *or* far-grab (`RayInteractable`+`DistanceGrabbable`) |
| wildlife (later) | keep creatures out of the static batches (own meshes), budget them in `stats.mjs` first |
| sound (later) | SDK audio components; positional water/waterfall; ambient bed after the Enter-VR gesture |
| another area | new layout module + generator pass; keep the three-area vocabulary (palette, transition bands, a landmark) |

## 9. Diagnostics layer (`src/diagnostics/`)

| Module | Role |
| --- | --- |
| `frame-metrics.ts` | singleton `metrics`. Wraps `world.update` (CPU update) and `renderer.render` (CPU submission, optional GPU timer via `EXT_disjoint_timer_query_webgl2`, `renderer.info` calls/triangles). Ring buffer of 2048 frames; `summary(ms)` gives fps, mean/median/p95/p99/max, missed-vsync fraction, CPU/GPU ms. GPU unavailable => `null` plus a reason, never an estimate. Reads the display rate and supported rates from the XR session |
| `perf-overlay.ts` | wrist panel on the left grip space (canvas texture, 4 Hz, `depthTest` off) and a DOM `<pre>` for the flat page. `?perf=` or the board toggle (persisted) |
| `perf-test.ts` | `?test=` state machine: waiting for VR, 8 s warm-up (teleport to `TEST_POSES`, metrics reset, governor blocked), 10 s sampling, `PerfResult` JSON (logged, in `localStorage`, copied, POSTed to the dev server). `placePlayer()` is shared with `StartPointSystem`. Also `?hz=` |
| `overdraw.ts` | `measureOverdraw()`: additive 8/255 counter render per material class gives foliage layers per pixel (surviving vs rasterised), shafts, water, opaque. Device independent |
| `vite.config.ts: perfResultSink()` | dev-only `POST /__jumanji/perf` writing `perf-results/` (git-ignored) |

`window.__jumanjiPerf` exposes `metrics`, `perfTest`, `stored`, `copy`, `start`, `overdraw`, `world` for console work.
Test poses (`layout.ts: TEST_POSES`) are checked by `validate-scene.mjs` (standable, reachable, 3 m clear ahead).

## 10. Quality governor (rewritten in Prompt 03)

- Budget = the display period from the session (72 Hz default => 13.9 ms), not a constant.
- Acts when the 3 s mean exceeds 112 % of the period **or** more than 10 % of frames miss a vsync (> 1.5 periods), in **two consecutive windows**.
- 8 s warm-up after entering immersive mode, 3 s settle after each step, paused while the system menu is up (`visible-blurred`) and during `?test=` runs.
- Steps: 1 shadows off (frustum shrink, no recompile), 2 low tier. Never steps back up; the board's "high" toggle calls `reset()`.
- Judges any window with >= 3 frames (the old 20-frame minimum meant it never acted at very low frame rates).
- `governorInfo` is read by the overlay and the test result. Every step logs `[jumanji:governor]`.

## 11. Dependencies

IWSDK is exact-pinned at 1.1.0-rc.2. Stable 1.0.1 builds against this code but its runtime rejects the scene (`DomeGradient` fields undeclared), so the project stays on rc.2 until 1.1.0 is released.
`npm audit --omit=dev` reports 0; the 4 high findings are dev tooling only (see `DEVELOPMENT_PROGRESS.md`, section 7).

## 12. Known facts about this SDK/runtime

- IWSDK 1.1.0-rc.2 is a release candidate. Scene schema is strict (hex fog colour, view roles `hero|diagnostic`).
- The managed browser in a no-display sandbox is headless software GL: frame rates there say nothing about Quest. Draw/triangle/overdraw counts there are exact.
- The IWER emulator spoofs the Quest user agent (`window.IWER_DEVICE`); results carry `environment.emulated` so they cannot be mistaken for headset data.
- UIKit needs a short press (~0.2 s) and a healthy frame rate to register a click.
- `OneHandGrabbable` + ray components on one entity breaks ray hover/grab.
- Editor commands (`scene open`, `asset render-preview`) need the editor role and a non-XR render loop; `dev restart` returns to the runtime role.

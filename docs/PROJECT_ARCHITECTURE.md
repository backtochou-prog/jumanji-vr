# Project architecture

How the jungle is put together, why, and where to extend it (Prompt 04 state).

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

*(Prompt 07 adds, outside the batching: wildlife instanced meshes - section 15 - and wind/proximity sway for the plant chunks, which use `plantFoliageMaterial`.)*

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
| `tools/wildlife-test.mjs` (`npm run wildlife`, `wildlife:browser`) | headless: synthesis, perch fit (rays against the real baked meshes), 72 Hz simulation of every creature type with a scripted player; `--browser`: audio unlock and positional audio, draw calls on/off, plant reaction, console errors |
| `tools/wildlife-shots.mjs` | stills of real creatures in the scene at the gentlest viewing angle from the trail |
| `tools/scale-audit.mjs` | bounding boxes of every prototype against real-world references; placed sizes, camera, fog, speeds |
| `tools/flicker-test.mjs` | repeatable stations: 1 mm camera-nudge depth-stability test (24- and 16-bit depth), far-plane clipping, shadow-window shift, visibility-toggle walk (`--label`, `--variants`, `--far`) |
| `tools/zfight-scan.mjs` | geometric scan for same-facing coplanar triangles between structures and the ground |
| `tools/shadow-walk.mjs` | brightness along a walk with shadows on/off: separates shadow instability from foliage occlusion |
| `tools/eye-shots.mjs` | eye-height stills (`--figure 1` adds a 1.8 m reference figure) for before/after scale comparison |
| `tools/visible-report.mjs` | what is really drawn from a viewpoint (visible + in frustum), grouped by mesh name: cross-checks the CPU estimate |
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

## 12. The mountain expedition (Prompt 04)

A side route from the Forest Trail (beside the root arch) climbs a mountain, crosses a summit overlook, descends a cliff ledge (collapse event),
crosses a rope bridge and ends on a terrace beside a giant waterfall. Everything extends the existing pipeline.

### Data flow
```
world/math.ts            noise, splines, PolyIndex (grid-accelerated nearest-point)            (pure)
world/mountain.ts        landform, route, gorge + river, bridge/terrace/platform, guard walls,
                         viewpoints, terrain tiling                                            (pure)
world/layout.ts          terrainHeight() = jungle blended into landform (x > 22) + route grading; MTN route; MTN_GUARDS; MTN_VIEWS
world/mountain-placements.ts   trees, plants, vines, rocks, deadwood, roots, canopy, crags     (pure, Node-time)
world/collapse.ts        shelf layout, event constants, scripted ballistics (lip pieces, pebbles) (pure)
        ▼ tools/generate-scene.mjs  → src/world/baked.ts (+ instances for the new classes) + scene nodes + 12 mountain authoring views
src/scene-assets/        terrain (tiles, mountain material), falls, bridge, collapse, mountain-props, background (far ranges)
src/systems/             atmosphere, collapse, bridge, safety, comfort (+ chunk-lod: caps)
```
`terrainHeight` is the one ground truth: terrain tiles, collision proxies, placements, validators, bridge ends, water shorelines and debris ballistics all call it.

### Landform (see the header of `mountain.ts`)
Plateau +34 m; a deep valley (floor −62 m) centred on VALLEY with a concave wall (cubic profile: steepest at the top, ~60°), a natural ledge halfway
down (22 m → 10 m, the descent runs on it), a cliff band above the ledge, the summit **spur** (a mesa jutting over the wall), a **gorge** cut through plateau and ledge
(river bed by distance along the gorge: plateau stream → 38 m cascade → slot floor → brink), the plunge **face** (near vertical) and pool. Low-frequency warp makes the
valley irregular (damped near the gorge so the bridge site stays put), angle-based ribs make buttresses and gullies, a 1.7 m channel carries the valley river.
The route height is the smoothed landform along the route (grade-limited to 0.40), with fixed heights where a structure dictates (platform, bridge, terrace).

### Terrain and materials
Adaptive tiles (`mountainTiles`): 24 m tiles (1.5 m cells) within 7 m of the route, 1 m at the platforms, 48 m near it, 96 m elsewhere at 4-6 m (merged into `Mountain_far`, one draw).
`mountainGroundMaterial` = the ground grain projected from above on flat ground and from the sides on steep faces (blend by steepness; flat ground costs the same as before).
Vertex colour: strata bands, iron staining, scree, wet rock (`fallWetness`), dark forest under the ledge; **cliff relief** displaces vertices on faces steeper than ~48° (never walkable, faded near the route),
so the displaced mesh is also what you collide with. Dirt trail ribbons follow the route except on the bridge and the shelf.

### Collision
- Static: terrain tiles (walkable), `world-colliders` (trunks, rocks, **guard walls**): 0.5 m thick walls every 1.5 m along both sides of the route (y from −5.5 to +5 of the route), rings of 0.9 m pieces round the summit platform
  and the terrace with gaps exactly one lane wide, the jungle boundary ring has a lane-wide gap where the route leaves.
- Kinematic (moved by systems, updated by the locomotion engine each frame): `bridge-colliders` (deck on the same sag line as the planks, rail walls) and `shelf-collider` (walking surface of the collapse shelf).
- `tools/validate-scene.mjs` section 7 rebuilds exactly these walls/circles/decks and flood-fills them in both collapse states.

### Systems
| System | Job |
| --- | --- |
| `AtmosphereSystem` | player height → `open` (0 jungle .. 1 mountain): fog density 0.0095 → 0.0036, fog/dome colours, sky pole colour/elevation, camera far 260 (`JUNGLE_FAR`) → 1000 m |
| `ChunkLodSystem` | cell distance rules + `viewCap(open)`; mountain cells/tiles/ridges capped at 26 m while the view is still jungle; jungle landmarks hidden beyond 150 m; far ranges only when open |
| `CollapseSystem` | the state machine; cracks (overlay material opacity), 30 pebbles (one InstancedMesh), dust sprites, tremor, haptics, sink of the kinematic collider and the ride pieces, lip pieces on pre-simulated ballistics, reset |
| `BridgeSystem` | moves bridge visuals + collider together by mm: idle 1.5 mm, loaded up to 12 mm sideways (0.45 Hz) / 6 mm vertical (0.9 Hz), peaks at mid-span; none in reduced-motion; `bridge.creaks` audio hook |
| `SafetySystem` | remembers the last firm ground on the route; if > 6.5 m below it, restores it (rig only) |
| `ComfortSystem` | move-by-hand reference (patches the locomotion input provider), seated offset (XR reference space), reduced-motion vignette floor |

### Rendering budget decisions
Valley trees are cheap opaque crowns (`canopy`, ~60 triangles, vertex colour, no alpha test) on 64 m cells, not alpha-card trees; towers are one 10 m prototype scaled; the far ranges are four unlit fogged strips (frustumCulled false, hidden below `open` 0.25);
mist is additive and hidden in the 'low' tier; the waterfall is five sheets (one material). Distance caps keep the jungle's cost at its previous level (169k tris / 77 draws worst view); mountain views peak ~149k / 136 draws.

### Extending the mountain
| Want | Do |
| --- | --- |
| move/add a landmark on the route | edit `CTRL` in `mountain.ts` (and `BRIDGE`/`TERRACE`/`SUMMIT`), `npm run scene:generate`, `npm run validate` (it will tell you what broke: grades, reach, drop-offs) |
| a second collapse | add a cleft constant like `CLEFT` and a shelf asset instance; the system currently handles exactly one shelf (state in `collapse`) |
| audio | `bridge.creaks`, `collapse.state` transitions, haptics already in `systems/haptics.ts` |
| wildlife | keep out of the chunk classes; budget in `asset-stats.mjs` first |

## 13. Distance and cost strategy (one rule set for the jungle and the mountain)

**Principle:** nothing is drawn that the player cannot tell is missing, and everything that is drawn is as few draws as possible. Four tools, all driven by one number, `open` (0 = jungle, 1 = mountain top; `AtmosphereSystem`: player height, eased):

| Tool | Rule | Where |
| --- | --- | --- |
| Distance caps | `viewCap(open)` = 130 m .. 1030 m for everything; **mountain cells/tiles 26 m + 974 m x open** (hidden behind the jungle trees anyway while you are still in the jungle); **jungle cells and landmarks <= 150 m** while on the mountain | `layout.ts`, `ChunkLodSystem` |
| Per-class range | trees-hi 38 m, plants 44 m, ground 34 m, rocks 54 m, deadwood 42 m, trees-lo/far <= 480 m, canopy <= 520 m, crags <= 760 m; the low tier tightens all of them | `CHUNK_LOD`, `CHUNK_LOW_MAX` |
| Terrain LOD | the mountain is 96 m **root cells**; a root with detail draws its fine tiles (24 m at 1.5 m cells, merged into <= 4 draws per root) within **150 m** (100 m low tier, +-20 m hysteresis) and ONE coarse 6 m-cell mesh beyond it (`terrain-far`, no collision). Roots without detail (valley wall/floor at 4 m cells, far plateau) are merged into one draw, `Mountain_far`. Collision always uses the fine tiles | `terrain.scene-asset.ts`, `TERRAIN_LOD` |
| Silhouettes | four far ranges (420-900 m, up to 300 m high) as **one** unlit mesh, drawn only when `open` > 0.25; the jungle ridge rings only when `open` < 0.5; fog 0.0125 -> 0.0036 and the dome colours follow `open`, so distant ground fades into the same haze the silhouettes carry | `background.scene-asset.ts`, `AtmosphereSystem` |
| Waterfall | `FallNear` (5 sheets merged, 1 draw) within 240 m, `FallFar` (the two main sheets) beyond; mist within 480 m and never in the low tier | `falls.scene-asset.ts`, `ChunkLodSystem` |

Cell sizes: 28 m for what you walk through, 56 m for the cheap trees (`trees-lo/far`), **128 m for `canopy` and `crags`** (a valley is a handful of draws).
No GPU occlusion culling is used: Quest Browser does not expose reliable WebGL occlusion queries, and the frustum + distance + region rules above already remove the large occluded volumes (the whole mountain from the jungle, the whole jungle from the mountain).

### Dynamic objects are isolated and cost nothing while idle
- `CollapseSystem`: intact shelf = **one** merged mesh (`ShelfIntact`); the eight pieces, the crack overlay and the 30-pebble InstancedMesh are **hidden** (not drawn, not just invisible-by-scale) until the event needs them; after the event everything is hidden again (a lingering-piece bug found by `collapse-test --scenario draws` is fixed). 14 dust sprites exist only while shown.
- `BridgeSystem`: the rope bridge and its kinematic collider are moved only within 70 m of the bridge; elsewhere they rest and nothing is changed.
- `SafetySystem` (every 0.4 s), `ComfortSystem` (every 0.1 s, cached settings), `AtmosphereSystem` (scene touched at 4 Hz and only when `open` changed by > 0.004; far plane in 25 m steps; the dome write fires ECS handlers, so it is rate-limited), `ChunkLodSystem` (4 Hz).
- Falling debris is **pre-simulated** (fixed seeds, no per-frame terrain queries, no physics engine); the break is a state machine guarded against repeats (8 `trigger()` calls in a row = one break; hovering between 15 and 21 m = no break).
- Collision: the two kinematic environments cost one 16-float message each per frame (SDK behaviour); the shelf collider is parked 400 m down after the event.

### Shader warm-up
`warmShaders` shows every hidden mesh (LOD-hidden mountain, collapse pieces, pebbles, fall variants) for the compile, then restores; at page ready it also renders once into a 1x1 target with a world-sized shadow frustum so the **sun-shadow depth programs** are built at start, not on first approach to the ruins. Result (`npm run audit`): 54 programs at start, **0 compiled later** at any of 17 stations (it was 37 / +1 before).

### Comfort additions
`hazardAssist` (default on): walking speed eases to 0.6 on the bridge, 0.7 on the collapse ledge and near platform edges, 0.75 on the steep descent, 0.85 on ledges and the gorge approach, and eases back (only `maxSpeed` changes; never the camera or the body). Board toggle "Auto-slow", URL `?hazard=0`. The vignette, snap/smooth turn, speed, move-by-hand, seated and reduced-motion options are unchanged.
**No code path rotates or tilts the camera or the player's body during play**: `placePlayer` (start point, tests, safety) only sets position (and the yaw of a test teleport); the collapse moves the ground, not the head.

### Diagnostics
Wrist panel (and DOM overlay): FPS/rate, frame mean/p95/max, missed vsync, CPU update + render, GPU (or "unavailable"), draws / triangles / cells, tier + shadows, governor state, **area name** (`areaLabel`: jungle area, or climb / summit overlook / steep descent / cliff ledge / collapse ledge / gorge approach / rope bridge / waterfall terrace / valley / ridge), **view openness, far plane, terrain roots fine/coarse**, GPU object counts, heap, test status (with `3/11` in a suite). `?test=all` runs the 11-station suite. `npm run audit` is the desktop-side counterpart (exact draws, triangles, programs, geometry/texture memory, overdraw per class, per-system CPU, init time) at 17 stations.

## 14. Scale convention and depth range (Prompt 06)

**1 world unit = 1 metre; no scale on the scene root, the player rig or the camera** (verified at runtime: camera local y 1.7 on desktop, all scales 1). Rules that keep it true:
- A structure that must change size is authored at a design size and **baked** with a uniform geometry scale taken from `SCALE` in `world/layout.ts` (`temple` 1.9, `spire` 50/24, `pillar` 2.1, `rootArch` 1.7, `fallenGiant` 1.4, `cliff` 1.8). Never set a node scale: the mesh, the collider (`colliders.scene-asset.ts`), the placement exclusions (`placements.ts`) and the validator (`validate-scene.mjs`) all read the same constants, so they cannot disagree.
- Trees are authored in `TREE_SPECS` and grown to real proportions by `GROWTH` (giants 58-74 m). Their collider radii are `TREE_COLLIDER` (giant 4.3 m x scale).
- The altar stays human-sized (top 0.94 m): the Heartstone must stay graspable. Grab distances are unchanged.
- Walking speed is human (default 1.8 m/s; 1.2 / 1.8 / 2.5 selectable in the comfort panel).
- Procedural vegetation/rock prototypes are unit prototypes; placement scale ranges are in `placements.ts` / `mountain-placements.ts` and checked by `tools/scale-audit.mjs`.

**Depth range.** near 0.1 m, far `JUNGLE_FAR` = 260 m in the jungle (fog 0.0095 hides 91 % of the world by 240 m, so the far plane is never visible), growing to 1 km with `open` (`AtmosphereSystem`, 25 m steps, 4 Hz). A far plane inside the visible world was the cause of the cliff/waterfall/ridge popping. What the larger far plane lets in is controlled by distance caps, not by the plane: `JUNGLE_CELL_CAP` (vegetation cells, 100 m), `JUNGLE_LANDMARK_CAP` (landmarks/terrain tiles, 120 m), and the mountain cap (26 m in the jungle growing with `open`) for the rope bridge, mountain water and the collapse shelf.

**LOD without flicker.** `chunkVisible(cls, dist, low, cap, was)`: a cell that is drawn stays drawn `LOD_HYSTERESIS` (1.5 m) past its limit and returns the same distance inside it. The detailed and the cheap tree version meet at one distance (`trees-hi.max` = `trees-lo.min` = 30 m), so exactly one is drawn: no overlap band (the previous 32-38 m overlap drew both), no gap.

**Shadows.** One 1024 px directional map follows the player (`ShadowFollowSystem`), snapped in 0.5 m steps along the light's own right/up axes so the map content only moves by whole texels. Shadows were measured not to be a source of flicker; this only removes a minor shimmer on walking.

**Structure rules (checked by `npm run validate`).** Structures do not interpenetrate (spire base >= 1 m clear of the temple platform; pillars either on the temple or clear of its edge); same-facing surfaces of different meshes are kept > 1.5 cm apart (moss/growth cards lifted 5 cm design units); the mountain's gate giants and the jungle's random trees are kept apart (`MOUNTAIN_GATE_TREES`, verified against the real positions).

## 15. The living jungle: wildlife and ambient sound (Prompt 07)

**Principle.** Creatures are simulated state machines drawn through instanced meshes, completely separate from the static vegetation batches. No physics, no colliders, no pathfinding; all randomness is seeded (placement, schedules, species mix), so the world is the same every run (only the player decides where they are).

```
src/wildlife/
  context.ts       wctx: per-frame player/view state (position, view cone, speed, 'still', open 0..1, low tier, switches), the CallSink hook, wildlifeStats, threatDist
  perches.ts       world perches (tree boughs, entrance limb, fallen giant, pillar capital), obstacles (trunks/ruins), spatial grids, flightClear, monkey graph (neighbours())
  models.ts        creature geometry (birds, wing segment, monkey body/head/bone, butterfly/dragonfly) + 5 shared materials
  rig.ts           InstanceRig: one InstancedMesh per part, begin/push/end, hidden when empty, instanceColor allocated up front
  birds.ts         Birds: macaw / toucan / small, perched -> crouch -> flying (Bezier, flap/glide, landing) / soar; crossing flocks; flush; voluntary hops
  monkeys.ts       Monkeys: sit / watch / move (walk, climb) / leap / retreat; 2-bone IK on instanced bones; tail chain
  insects.ts       Insects: butterflies, dragonflies, gnat + firefly Points (makeClouds)
  wildlife-system.ts  WildlifeSystem (drives everything once per frame, owns the rigs) and ReactiveFoliageSystem (wind/proximity uniforms)
src/audio/
  synth.ts         pure maths -> Float32Array: beds (wind, white/brown noise, bubbles, cicadas, crickets) and calls (macaw, toucan, parakeet, songbird, monkey hoot/whoop)
  ambient-audio.ts AmbientAudio (implements CallSink): Web Audio graph, listener, positional loops, call voices, hush, masking
```

**Per frame** (`WildlifeSystem.update`): read the head pose (position, direction, up), smooth the horizontal speed, set `wctx`; step `Birds`, `Monkeys`, `Insects` (each activates creatures inside their spawn distance, steps their state, writes only creatures inside the view cone into the rigs); update the audio listener and environment. Everything allocation-free (module-level scratch objects).

**Perches (the key to "on real branches").** `trees.scene-asset.ts` defines two bare boughs per tree KIND with absolute metres, measured from the trunk axis (`PERCH_BOUGHS`), built into every tree LOD version (the distant forest uses one cheap model per kind, so a variant-dependent bough would move at the LOD switch). `treePerches(kind)` returns the perching points on top of each bough in tree-local space (0.86 of the radius: the prisms sag); `perches.ts` maps them through the placement (position, yaw, scale), adds the structure perches and drops those inside another trunk. `tools/wildlife-test.mjs` proves the fit by casting rays against the baked chunk geometry of all three LOD versions. The monkey graph joins perches on the same tree (walk along a bough / climb the trunk, using `trunkAxisAt`) and across trees (leap <= 6.5 m, not much uphill).

**Behaviour rules worth knowing.**
- Threat distance = horizontal distance and half the height difference, scaled by speed (a standing player is less alarming), a per-animal sensitivity and the species' flush/alert distance (macaw 12 m, toucan 10, small 6, spider monkey 14, capuchin 11).
- A flush moves the animal to a free, clear perch >= 22 m from the player (one target search per frame), flock-mates follow 0.1-0.8 s later, `audio.hush` quietens insects/wind for a few seconds. Perched animals are on a 25 s calm-down after landing.
- Crossing flocks: scheduled deterministically (25-70 s), lanes tested with `flightClear`, fallback along the trail corridor, up to 9 transient birds.
- Monkeys sit/watch >= 80 % of the time; they retreat only to a neighbouring perch that increases the threat distance.

**Plants.** `plantFoliageMaterial` (same atlas as the foliage card) is used by the `plants` and `ground` chunk classes; those chunks carry `aSway` (vec2: weight 0 at the root .. 1 at the tip, plant height), baked in `mergeBaked(..., sway = true)`. The vertex shader adds wind (two sines, gust envelope, amplitude by height) and pushes vertices away from three world points (`swayState.body`: feet and both grips) within 1.15 m / 0.55 m. Trees, rocks and bark are untouched. The meter in `diagnostics/overdraw.ts` classifies the material as a card and hides the Wildlife group while measuring.

**Sound.**
- Start: `AmbientAudio` listens for pointer/key/touch/click (and `WildlifeSystem` for XR `sessionstart`); only then is an `AudioContext` created, so browsers' autoplay rules are respected. `audioInfo` reports the state (`off`, `starting`, `running`, `suspended`, `disabled`, `unsupported`).
- Graph: loops/voices -> (filter) -> PannerNode (HRTF or equal-power, `inverse` distance, per-source `refDistance`) -> bus -> master -> compressor -> destination. The listener (position, forward, up) is written every frame from the head.
- Water: 9 emitters (jungle: backdrop waterfall 28 m, pool cascade 5 m, three stream points 4.5 m; mountain: giant fall 55 m, cascade 22 m, gorge under the bridge 14 m, valley river 28 m); the 4 most audible play. Wind: two offset loops through filters, level = altitude/openness base x a wandering gust factor. Insects: 4 equal-power voices orbiting the player at 7-14 m, level falls to zero as the view opens. Calls: from the creature's position (or the distant-call scheduler at 38-120 m), pitch +-7 %, 3 variants, 0.5 s per-kind rate limit, distance low-pass (15 kHz x e^(-d/85 m)).
- Reactions: `hush` (flush), masking (water within a few metres lowers insects/wind/distant calls), calls more frequent when the player stands still.
- Cost limits: 4 + 4 + 8 voices; 26 buffers (5.8 MB), generated in 8 ms slices after the gesture; 'low' tier uses equal-power panning for new call voices.

**Budgets and tools.** Wildlife: 11 InstancedMeshes + 2 Points, 5 materials, caps and spawn distances in `birds.ts` / `monkeys.ts` / `insects.ts`; the jungle visible-triangle budget in `tools/asset-stats.mjs` carries a wildlife reserve (16k / 16 draws jungle, 3k / 3 mountain) taken from `wildlife-test --browser`. `npm run audit` measures the real totals and counts lazily compiled programs (0).

**Extending.** A new species: geometry in `models.ts`, a rig in `WildlifeSystem.init`, a module with `update(dt, ..., rigs)` that uses `wctx` and `perches`, and (if it calls) a buffer maker in `synth.ts` + a `CallKind`. Keep the draw count per species at 1-2, keep matrices CPU-written and only for creatures in the view cone, and add the checks to `tools/wildlife-test.mjs`.


## 16. Known facts about this SDK/runtime

- IWSDK 1.1.0-rc.2 is a release candidate. Scene schema is strict (hex fog colour, view roles `hero|diagnostic`).
- The managed browser in a no-display sandbox is headless software GL: frame rates there say nothing about Quest. Draw/triangle/overdraw counts there are exact.
- The IWER emulator spoofs the Quest user agent (`window.IWER_DEVICE`); results carry `environment.emulated` so they cannot be mistaken for headset data.
- UIKit needs a short press (~0.2 s) and a healthy frame rate to register a click.
- `OneHandGrabbable` + ray components on one entity breaks ray hover/grab.
- Editor commands (`scene open`, `asset render-preview`) need the editor role and a non-XR render loop; `dev restart` returns to the runtime role.

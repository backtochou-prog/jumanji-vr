# Development progress

## Prompt 07 — The living jungle: wildlife, animation and environmental sound (requested as "PROMPT 06")
Date: 2026-11-09. Goal: nature that exists independently of the player. **Nothing here was run on a physical Quest 2**, and **nobody has listened to the synthesised sounds** (this environment has no audio output; levels were set by calculation and checked numerically). Both are the first things to check on the headset (list at the end).

### Step 0 — were the Prompt 05 corrections really in?
Re-checked before writing anything: `npm run verify` passed; camera near 0.1 / far 260 in `iwsdk.config.json`; default walk speed 1.8 m/s; `SCALE` constants (temple 1.9x, spire 50 m, pillars 2.1x ...); LOD hysteresis; and the flicker test was re-run at the end of this round (see Verification): structures still stable, far-plane-clipped structures still 0. Nothing needed fixing first.

### What was built
| Part | What | Where |
| --- | --- | --- |
| Birds | scarlet macaws (3 pairs), keel-billed toucans (5), small birds (parakeet / canary / tanager tints, ~20 in loose flocks, several on the low log / entrance limb / pillar), 4 soaring birds over the mountain valley and the bridge. States: perched (turns, bobs, calls) -> crouch -> flying (Bezier path, flap/glide cycle, landing flare) -> perched on a free, clear perch; flock-mates follow within 0.1-0.8 s; voluntary hops to distant branches; **crossing flocks** every ~25-70 s through the view (lanes tested against trunks) | `src/wildlife/birds.ts` |
| Monkeys | 6 (black-handed spider monkeys, white-faced capuchins) in 4 bands along the trail. Torso + head + 17 limb/tail bones, **two-bone IK** to grips on the branch/trunk. Sit (idle variants: rest hands, scratch, hold branch), watch the player from up to ~42 m, quadruped walk along a bough, climb the trunk, **leap** to a neighbouring tree (<= 6.5 m), retreat to the neighbouring perch farthest from the player | `src/wildlife/monkeys.ts` |
| Small life | butterflies (28-slot pool, wander between flowers/heliconia, land with slow wing beats, **break off and jink away** from a moving player under ~2.4 m), dragonflies (6, darting/hovering over the pool and stream), gnat clouds (4 x 12 specks), fireflies (36, faint, only in three shaded hollows, jungle only) | `src/wildlife/insects.ts` |
| Perches | every tree now has 2 bare **perch boughs** (one at 3-4 m, one at 6.5-9.5 m, identical in all three tree LOD versions so an animal never floats at a LOD switch) with a leafy tuft beyond the tip; plus the entrance limb, the fallen giant and the pillar capital. World perches, obstacles and the monkey movement graph are computed from the SAME placement lists and curves the meshes use | `src/wildlife/perches.ts`, `trees.scene-asset.ts` (`PERCH_BOUGHS`, `treePerches`, `trunkAxisAt`, `entranceLimbCurve`) |
| Environment reacts | plants and ground cover **sway in the wind** and **lean away from the player's body and both hands** (vertex shader on a dedicated `plantFoliageMaterial`; per-vertex weight baked into the plant chunks; wind 40 % in reduced-motion). Birds flush, butterflies flee, insects hush for ~7 s after a flush | `lib/materials.ts`, `lib/geo.ts` (`aSway`), `wildlife-system.ts` (`ReactiveFoliageSystem`) |
| Sound | fully procedural (no recordings, nothing copyrighted): wind, cicadas + crickets (4 positional voices around the player), streams / pool cascade / the backdrop waterfall / the mountain's giant fall, cascade, gorge and valley river (positional loops, the 4 most audible play), and macaw / toucan / parakeet / songbird / monkey calls (3 variants each, random pitch, from the real animal's position, plus a random distant-call process). Web Audio, HRTF panning for calls and waterfalls, inverse distance model with a per-source reference distance (waterfall 28-55 m, stream 4.5 m, calls 3 m), distance low-pass for calls | `src/audio/synth.ts`, `src/audio/ambient-audio.ts` |
| Switches | board buttons **Sound** and **Wildlife**; `?audio=0`, `?wildlife=0`; both persist | `panel.ts`, `welcome.uikitml` |

Scale of the animals (real, not enlarged): macaw 0.84 m beak-to-tail, toucan 0.5 m, small birds 0.17-0.2 m, soarers 0.6 m with a 1.7 m span, spider monkey torso 0.43 m + tail 0.85 m, capuchin 72 % of that, butterflies 8-15 cm wingspan, dragonflies 7-8 cm.

### How it stays cheap (Quest 2)
- Creatures are **not** in the static vegetation batches. They are simulated state machines (no physics, no colliders) drawn through **11 InstancedMeshes + 2 Points objects** (one draw each, hidden when empty), 5 shared materials, CPU-written matrices, no skinning.
- Spawn/despawn by distance with hysteresis (macaw 80 m, toucan 65, small 48, monkeys 60-70, butterflies 38, dragonflies 40); caps 22 resident + 9 transient + 4 soaring birds, 6 monkeys, 20 butterflies, 6 dragonflies; only creatures inside a 72-degree half-angle view cone are written to the GPU; wing detail drops to one segment beyond 30 m.
- One target search per frame at most (a whole flock taking off never costs more than one), spatial grids for obstacles and perches (a flush decision: median 0.16 ms, max 2 ms on the desktop).
- **'low' tier** (also what the adaptive governor steps to): birds 12, monkeys 4, butterflies 8, dragonflies 3, no gnats/fireflies, equal-power instead of HRTF panning for new voices.
- Creature tables are built in three slices ~1.2 s after the scene loads, not inside system init; point clouds and rigs exist from the start so the shader warm-up compiles everything (**0 programs compiled lazily** in the audit).
- Sound limits: 4 water loops + 4 insect loops + 8 call voices; buffers (26, 5.8 MB) generated in slices of a few ms after the first gesture.

### Measured cost (real runtime, `npm run audit`, software GL: draws/triangles are exact, timings are not Quest numbers)
| station | draws before -> after | triangles before -> after |
| --- | --- | --- |
| jungle-entrance | 95 -> 108 | 177k -> 191k |
| jungle-trail | 66 -> 81 | 123k -> 139k |
| jungle-clearing | 75 -> 89 | 147k -> 160k |
| climb | 49 -> 51 | 91k -> 95k |
| ridge | 78 -> 82 | 136k -> 143k |
| summit | 55 -> 57 | 73k -> 76k |
| summit-down / summit-fall | 49 -> 51 / 68 -> 70 | 67k -> 70k / 97k -> 100k |
| descent | 77 -> 80 | 109k -> 117k |
| ledge / cleft | 68 -> 71 / 70 -> 72 | 104k -> 106k / 106k -> 109k |
| bridge-west / -mid / -cascade | 48 -> 48 / 32 -> 32 / 37 -> 39 | 64k -> 65k / 59k -> 59k / 56k -> 57k |
| brink-down / valley / brink | 47 -> 49 / 65 -> 67 / 86 -> 88 | 78k -> 80k / 91k -> 95k / 118k -> 124k |
Jungle: wildlife itself adds 12-14 draws and 5-16k triangles depending on how much is in view (`wildlife-test --browser`: entrance +14 / +14k, trail +12 / +5k, clearing +14 / +16k); the rest of the jungle increase is the perch boughs on every tree (~+6k at the worst view). Mountain: the 4 soaring birds (+2 draws) and the boughs on the valley-edge trees. Shader programs 57 -> 66 (wildlife, plant sway, the two Points materials), all compiled at warm-up, none lazily. Geometry memory 28.0 -> 30.4 MB, materials in the scene graph 106 -> 117, textures unchanged. Simulation CPU for ALL creatures: mean 0.10 ms, p99 0.64 ms per frame on the desktop in node (headless run, 72 Hz, 8 368 frames); in the page 0.5-2 ms mean for the whole system under software GL. **Quest 2 cost is unmeasured.**
Budgets (`tools/asset-stats.mjs`): the jungle visible-triangle budget went 170k -> 195k and draws 100 -> 116, stated as "earlier budget + wildlife reserve (16k / 16 draws, from the measurements above) + ~6k boughs + margin"; the estimate now adds the reserve to every view (mountain: 3k / 3 draws). If the headset says no, the cheapest levers are the 'low' tier (already trims wildlife), `LOD` distances, and removing the second perch bough.

### Verification, by level
**Automated, headless (no browser, no GPU): `npm run wildlife` -> 41 checks, all pass** (also part of `npm run verify`). Real modules through Vite SSR:
- synthesis: 24 buffers finite / audible / not clipping, loop seams <= 1.4x a normal sample step, deterministic, call variants differ, 5.8 MB;
- **perch fit**: every perch lies on the mesh it claims, measured by vertical rays against the real triangles of the baked chunks: boughs in the near / cheap / far tree versions (worst 1.2 cm / 9.9 cm / 6 of 729 perches have another tree's branch 10-49 cm above them, 0.8 %), entrance limb (<= 5 cm), fallen giant, pillar capital; no perch inside another trunk; movement graph connected;
- simulation at 72 Hz with a scripted player (walks the whole trail, stands still 90 s, runs at a butterfly, stands under a monkey): spawn at the entrance, despawn at the summit, soaring birds only when the view is open, no butterflies on the mountain, no NaN, nothing below ground, no perch shared, caps respected, flushes and alarm calls requested, >= 3 call types from real creature positions, flight speed <= 14 m/s (max 12.5), monkeys <= 8 m/s (max 7.6 after fixing a leap that was too fast over a long drop), flight paths inside obstacles 0 of 3 420 samples, landing exactly on a perch (0.000 m), crossing flocks, 113 calls in 90 s of standing still, monkey retreats along legal graph edges only, monkeys sit/watch 94-95 % of the time when nobody is near, butterflies flee, dragonflies appear at the pool, low-tier trims, start-up 33 ms + 105 ms.
Bugs these checks found and I fixed: a flush of many birds cost ~19 ms (target search scanned every perch and obstacle) -> spatial grids + one search per frame; monkeys at 12 m height ignored a player standing right under them -> threat distance weights height by half; low tier kept too many butterflies; a short leap down a long drop was 10 m/s; boughs poking into neighbouring trunks (dropped); tufts covering the perching spots (moved).
**Desktop browser (headless Chromium, software GL): `npm run wildlife:browser` -> 15 checks, all pass:** no AudioContext before a gesture, the first click starts it, all 26 buffers generated after it; **positional audio**: the waterfall's audibility rises with approach (0.23 at 104 m -> 0.56 at 43 m -> 0.85 at 12 m), its voice plays near it, never more than 4 water voices, the Web Audio listener sits at the head (within 0.1 m), the mixed output (analyser RMS on the master bus, graph processed in headless Chromium) is 0.036 at the entrance and 0.123 beside the waterfall (3.4x); sound changes with place (wind 0.04 -> 0.33 and insects 0.08 -> 0.00 from the jungle floor to the summit, a waterfall voice still running there); the Sound switch mutes; draw calls with wildlife on/off at the three jungle stations (+12..14 draws, <= 16.4k triangles); no new shader programs after warm-up (73 -> 73 with the meter's own variants excluded; audit: 0 lazy); **plants react**: the same view differs by 947 pixels when the body push is switched off; no console or page errors. Also: `walk-test` and `collapse-test` pass unchanged; `tools/wildlife-shots.mjs` stills (`artifacts/wildlife/`) show a macaw in flight, a monkey pair on a bough, leap / walk / sit poses; flicker re-run (temple 7 m 16 px, temple 35 m 45 px, pillar 4 m 274 px (foliage edges), altar 15 px, spire 40 m 65 px, root arch 23 px; far-plane clipping still 0).
**XR emulator (IWER, Quest 2 profile):** entering the session calls the audio unlock (`[jumanji] audio unlock requested ... context running`); hand-pinch grab of the Heartstone, carry and release work with the wildlife and audio systems running (`Grabbed` set, relic follows the hand, falls to the ground when released). Honest note: the very first grab attempt right after switching the emulator to hand input did not register; three repeats all did. The emulator cannot say anything about sound quality, frame time or comfort.
**Physical Quest 2: NOT TESTED.**

### Known issues / limits (read before trusting it)
- **Sound is unheard.** All levels (wind 0.07-0.5, insects 0.2, waterfall 0.85 ...) are calculated; the synthesised calls may sound artificial. Plan for tuning them on the headset (mix numbers are named constants in `ambient-audio.ts`).
- Animals are procedural low-poly models posed by hand: believable at metres (see `artifacts/wildlife/`), not hero close-ups; faces are simple. No eye contact / gaze behaviour. Monkeys live on branches (and never on the ground); a monkey with no better neighbouring perch stays put and watches.
- Birds avoid trunks (checked) but not foliage cards: a bird can pass through a leaf clump; crossing flocks pick lanes from a handful of candidates and fall back to the trail corridor.
- The first animals the player meets are 5-15 m away (small). That is real scale; the lower boughs (3-4 m) exist to bring some closer.
- Every tree gained two bare boughs: they show as a few thin horizontal branches on trunks (with a leafy tuft at the tip). If it reads as too repetitive, vary heights per variant (the LOD constraint is only that all LOD versions agree).
- The mountain has soaring birds and sound only; no monkeys/butterflies there by design.
- `AudioContext` needs a gesture: on the Quest the Enter-VR press is one. A Sound button toggle also unlocks it.
- Wildlife frame cost on the device is unmeasured; the adaptive governor (existing) will step to 'low', which also trims the wildlife.

### Still requires the physical Quest 2
1. Sound: levels, whether calls/wind/insects/water sound natural or synthetic, HRTF CPU cost with 8-16 voices, any crackle at the loop points, that audio starts on Enter VR.
2. Frame time at the entrance / trail / clearing with wildlife on vs the board's Wildlife button off (`?test=all` then toggle); governor events.
3. Do animals read at their distances; does anything float, clip a trunk, or move unnaturally; are the boughs too regular.
4. Do plants leaning away from hands/body feel pleasant or twitchy; reduced-motion at 40 % wind.


## Prompt 06 — World scale correction, environmental proportions and structure flicker fix (requested as "PROMPT 05")
Date: 2026-11-08. Two reported problems: (1) the world felt miniature; (2) structures flickered / vanished / interfered when moving. No wildlife, gameplay, puzzles or new areas were added.
**Nothing here was run on a physical Quest 2.** Everything below was measured on desktop (software GL: exact for pixel/triangle counts and geometry, meaningless for speed) and in the IWSDK XR emulator.

### Problem 1 — "the world is miniature": diagnosis (what was inspected, not assumed)
Measured by `tools/scale-audit.mjs` (bounding boxes of the real prototypes) and by reading the live scene graph/camera: the **coordinate system was already metric and correct** — 1 unit = 1 m, scale 1 on scene root / player / camera
(no nested scaling anywhere), eye height 1.65-1.7 m, locomotor capsule 0.5 m. So the miniature feel was NOT a camera or root-scale bug. It was a combination of:
| Cause | Evidence | Effect |
| --- | --- | --- |
| Structures authored at house scale | temple 15 x 9 m, spire 24 m, pillars 2.2-3.8 m, root arch ~3.5 m, fallen "giant" 11 m x 0.85 m radius, backdrop cliff 40 m | ruins read like garden follies; "monumental" was 2x too small |
| Trees a size too small | giants ~36-46 m (real emergents 50-70 m), canopy trees ~29-32 m | no sense of towering; trunks ~2 m |
| Broadleaf plants 1.6-2.4 m | prototypes placed at scale 0.9-1.1 | real heliconia / banana / alocasia are 2-5 m: foreground looked like a model |
| Walking speed 2.5 m/s default | comfort.ts (a person walks 1.2-1.6 m/s) | everything passes too fast, which reads as small |
| Horizon cut at 100 m | camera far = 100 m + fog 0.0125 (71 % at 100 m) | the cliff, waterfall and ridges were sliced by the far plane: no distant landmarks, depth cues missing |
Not the cause (checked): camera height, FOV (75), scene root scale, player rig scale, terrain units, collider units.

### Scale convention (documented and enforced)
**1 world unit = 1 metre. No scale on the scene root, the player rig or the camera.** A structure that must be bigger is authored at its design size and **baked** with a uniform geometry scale (`SCALE` in `world/layout.ts`),
never a node scale, so the mesh, the collider and the validator read the same number. The altar deliberately stays human-sized (top 0.94 m): the Heartstone must be graspable.

### Scale reference (final, measured from the prototypes; `node tools/scale-audit.mjs`)
| Element | Before | After | Real-world reference |
| --- | --- | --- | --- |
| Eye height / capsule | 1.65-1.7 m / r 0.5 | unchanged | 1.65 m standing |
| Giant (emergent) tree | ~36-46 m | **58-74 m**, crown 34-47 m | 50-70 m |
| Canopy tree (tall) | ~29-32 m | **38-42 m** | 30-45 m |
| Broad / slender tree | ~21-23 m | **27-30 m** | 20-30 m |
| Broadleaf plants | 1.6-2.4 m | **2.0-3.6 m** placed (x1.25-1.5) | 2-5 m |
| Temple | 15 x 9 m, ~8 m tall | **28.5 x 17.1 m, 15.5 m tall** (platform top 2.8 m) | 25-60 m wide |
| Spire | 24 m | **50 m** (base radius 5.6 m) | landmark tower 30-60 m |
| Pillars | 2.2-3.8 m | **4.6-8.0 m**, radius 1.26 m | ruined columns |
| Root arch | x1.0 | **x1.7** (supporting trunk 8.2 m from the arch centre) | |
| Fallen giant | 11 m, r 0.85 | **15.4 m, r 1.19** | 15-25 m |
| Backdrop cliff / waterfall | 64 m wide x 40 m high; fall ~29 m | **115 m wide x 72 m high; fall ~52 m** | 60-120 m |
| Altar top | 0.94 m | 0.94 m (kept) | graspable relic |
| Walking speed (default) | 2.5 m/s | **1.8 m/s** (options 1.2 / 1.8 / 2.5) | 1.2-1.8 m/s |
| Camera near / far (jungle) | 0.05 / 100 m | **0.1 / 260 m** (to 1 km on the mountain) | |
| Jungle fog | 0.0125 (50 % at 55 m) | **0.0095** (50 % at 73 m, 90 % at 242 m) | |
Mountain (unchanged, already large): summit 34 m, valley floor -62 m (96 m below the summit), giant fall 51 m, bridge 23.6 m at 10.3 m, 20 m above the river.

### Problem 2 — flicker: how it was diagnosed (`tools/flicker-test.mjs`, `zfight-scan.mjs`, `shadow-walk.mjs`)
Repeatable stations (temple at 3/7/12/20/35 m, wall, pillars, altar, spire at 17/40/70 m, cliff/fall, root arch, trail, entrance trees). Each tested for: depth-buffer instability (render, nudge the camera 1 mm, re-render in 24-bit and 16-bit
depth; red = pixels that changed), far-plane clipping (view-space depth of the key structures vs `camera.far`), shadow-window shift, a visibility-toggle walk, and a geometric coplanar-triangle scan.
| Suspect | Result |
| --- | --- |
| Far-plane clipping | **CONFIRMED, 11 cases**: backdrop cliff, waterfall and the three ridge rings crossed the 100 m far plane (at ~70 % fog) and popped with head rotation |
| LOD swaps | **CONFIRMED**: whole 28-56 m cells flipped hi/lo at a bare threshold (no hysteresis) and both versions were drawn in an overlap band (32-38 m) |
| Coplanar overlays | **CONFIRMED**: moss cards ~2 m2 on the temple; spire base cap and altar coplanar with the ground (opposite-facing: not a fight) |
| Interpenetration | **CONFIRMED**: spire base inside the temple platform, pillars straddling the temple edge, gate giants overlapping jungle trees |
| Shadow-map instability | **Not primary**: 0 % pixels change with a 1 m window shift; shadow-walk finds no brightness jump attributable to shadows. A minor texel-alignment defect was fixed anyway |
| Depth precision | **Not primary**, but near 0.05 wasted precision: near 0.1 halves the error of a 16-bit XR depth buffer |
| Duplicate geometry / transparency | none found |

### Corrections made (system by system)
| Area | Change |
| --- | --- |
| `world/layout.ts` | `SCALE`, new `TEMPLE`/`SPIRE`/`ROOT_ARCH`/`FALLEN_GIANT`/`PILLAR_R`/`PILLARS`, `JUNGLE_FAR`, `JUNGLE_LANDMARK_CAP` 120 m, `JUNGLE_CELL_CAP` 100 m, `MOUNTAIN_GATE_TREES`; `LOD_HYSTERESIS` 1.5 m in `chunkVisible(…, was)`; trees-hi 0-30 m, trees-lo from 30 m (**one** version at any distance: no overlap band), plants 36 m, rocks 46 m |
| Scene assets | temple/growth/spire/pillars/root arch/fallen giant/cliff/waterfall/mist baked at the new `SCALE`; trees grown (`GROWTH` x1.28-1.6); moss lifted 5 cm; ridge rings 46/62/80 m; entrance limb raised to 17-18.6 m |
| Colliders / placement | collider asset, tree collider radii (giant 4.3), exclusions, root-arch trunk and the validator all use the same constants; jungle trees keep out of the mountain's gate giants |
| `iwsdk.config.json` / `AtmosphereSystem` | near 0.1, far 260 (jungle) to 1 km; fog 0.0095 |
| `comfort.ts` | default walk speed 1.8 m/s, options 1.2/1.8/2.5 (storage key bumped so old 2.5 settings do not persist) |
| `ChunkLodSystem` | hysteresis; rope bridge, mountain water and collapse shelf hidden beyond the mountain cap while in the jungle (they became visible once far = 260) |
| `ShadowFollowSystem` | follow position snapped on the **light's** right/up axes in 0.5 m steps (a world 1 m grid is not a whole number of texels along tilted light axes) |
| Plants | broadleaf scale 1.25-1.5 (jungle and mountain) |
Unchanged on purpose: Quest 2 WebXR session, locomotion/snap turn, hand and controller input, Heartstone grabbing, terrain generation, static batching, quality tiers, adaptive governor, mountain and waterfall content, no new shadow maps / post-processing / reflections.

### Verification, by level
**Automated (no renderer):** `npm run verify` passes: typecheck, `validate` (0 errors; new checks: structure footprints do not interpenetrate, gate-giant constants match the mountain, collider radii from `SCALE`), `stats:check` (jungle view 168k tris / 77 draws vs 170k / 100; mountain 155k / 82), build.
**Desktop browser (software GL, exact counts only):**
- Flicker: unstable pixels under a 1 mm nudge fell at 13 of 18 stations (temple-35m 296 -> 54, temple-12m 197 -> 12, pillar-2m 222 -> 35, pillar-4m 303 -> 254, altar 141 -> 14, root arch 99 -> 23); **far-plane clipped structures 11 -> 0**; the visibility-toggle walk toward the temple shows no pops. At temple-20m, trail ribbon, pillar-12m, spire-70m and spire-17m the count did not fall (307, 416, 178, 111, 70 px of 144 000 for 1 mm of camera movement, 0.05-0.3 %): the red pixels there sit on **foliage and flower-card edges** (thin alpha-tested cards), not on pillars, walls or ground; that is sub-pixel edge shimmer, not structure flicker.
- Z-fight scan (same-facing coplanar, 1.5 cm): 2 single-triangle overlaps remain (0.42 m2: a temple-growth card at the plinth base and one spire-growth card) vs 45 m2 + moss before.
- Eye-height stills with a 1.8 m reference figure: `artifacts/scale/before` vs `after` (temple approach/close, pillar, altar, spire, gate tree, trail, clearing). Trees and ruins now tower over the figure; the waterfall and cliff stand behind the temple.
- `walk-test` (bridge, summit edge, brink, ledge, hazard assist) and `collapse-test`: all pass.
- `npm run audit`: no shader compiled lazily (0 hitches); real jungle-entrance 95 draws / 171k tris excluding the invisible collider mesh (was 88 / 167k); every mountain station at or below its earlier triangle count.
**XR emulator (IWER, Quest 2 profile, `test-grab` fixture):** enter XR, hand pinch grab of the Heartstone (`Grabbed` set), carry to (0.3, 1.25, -1.8), release, relic settles on the ground, `Grabbed` cleared. (Squeeze grab through `run-sequence` is not supported by the CLI for controllers: not re-tested this round; the grab code path was not changed.)
**Physical Quest 2: NOT TESTED.**

### Known issues / still needs the headset
- Whether 1.8 m/s feels right and whether the new far plane/fog read well in the stereo display (try 1.2 / 2.5 in the comfort panel).
- Frame time: the entrance view is ~3 % heavier than before (bigger structures/trees visible, backdrop cliff and ridges now drawn). Measure with `?test=all` first; the governor and `quality=low` are unchanged.
- Foliage-card edge shimmer is expected to be softer with MSAA/foveation on the device; if it is visible, try `alphaToCoverage` on the leaf-atlas material (not enabled here to keep fill-rate).
- The `LOD_HYSTERESIS` band keeps a cell drawn 1.5 m past its limit (cost: ~+4k tris worst case, included above).
- Two residual 0.2-0.35 m2 coplanar cards (see above): invisible at distance, could shimmer if the player puts their head against the temple plinth at ground level.


## Prompt 05 — Quest 2 optimisation, immersion and performance validation (requested as "PROMPT 04")
Date: 2026-11-07. Goal: make everything built so far run efficiently and comfortably in standalone VR **without** thinning the world.
No gameplay was added. **Nothing here has been measured on a physical Quest 2**; the tools to do it in one 3-minute run are ready (`HEADSET_TESTING.md`: `?test=all`).

### Method (and what the numbers can and cannot say)
`npm run audit` (new, `tools/audit.mjs`) loads the real runtime in headless Chromium and visits 17 stations (3 jungle, 14 mountain). Exact and device-independent: draw calls and triangles (`renderer.info`,
includes the shadow pass), shader programs compiled and *when*, geometry/texture memory, overdraw per material class, per-system CPU in the page, scene build time. **Not** meaningful: FPS/GPU time (software rasteriser), so none is quoted.
The code was inspected, not trusted: the audit found real defects in what the previous documentation described (below).

### Defects found by inspecting the implementation, and fixed
| Claim in the docs | What the code actually did | Fix |
| --- | --- | --- |
| "Shader warm-up builds all programs at start" | three.js compiles only *visible* objects; hidden pieces/pebbles/variants and the sun-shadow depth program (ruins) were built lazily (+1 program on first approach to the clearing) | warm-up shows hidden meshes for the compile and renders once with a world-sized shadow frustum; **54 programs at start, 0 compiled later at all 17 stations** (before: 37, +1) |
| "Collapse pieces are separate from static batches" | true, but the 8 pieces + cracks + the pebble mesh were *drawn* all the time (9-10 draws); after a break the **lip pieces stayed frozen in mid-air** until reset | intact shelf = one merged mesh; pieces/cracks/pebbles hidden until needed and hidden again after; bug fixed (`collapse-test --scenario draws`) |
| "Atmosphere eases fog and sky" | rewrote the dome gradient (fires ECS handlers) and the camera far plane **every frame** | scene touched at 4 Hz and only on change; far plane in 25 m steps |
| "Bridge moves by mm" | moved every frame everywhere, forcing a kinematic update message even 200 m away | rests beyond 70 m |
| "Distance LOD" | mountain terrain was static tiles (one draw each, 70+ tiles); jungle trees/landmarks were drawn at up to 1000 m from the summit | terrain LOD, merged tiles, jungle cap 150 m on the mountain, far ranges merged to one draw |
| "areaAt" in the overlay | reported "trail" for the entire mountain | `areaLabel`: climb / summit overlook / steep descent / cliff ledge / collapse ledge / gorge approach / rope bridge / waterfall terrace / valley / ridge |

### Results (runtime, exact; `perf-results/audit-before-*.json` vs `audit-final-*.json`)
| Station | draws before -> after | triangles before -> after |
| --- | --- | --- |
| jungle entrance (worst jungle view) | 93 -> **88** | 171k -> 167k |
| jungle trail / clearing | 76 -> 73 / 78 -> 76 | 153k -> 152k / 170k -> 168k |
| mountain climb | 63 -> 55 | 128k -> 145k |
| ridge (top of the climb, forest both sides) | 145 -> **83** | 162k -> 153k |
| summit, level / looking down | 92 -> 56 / 75 -> 49 | 73k -> 78k / 60k -> 69k |
| summit, the waterfall across the valley | 125 -> **71** | 106k -> 103k |
| steep descent / cliff ledge / collapse ledge | 125 -> 78 / 103 -> 72 / 103 -> 71 | 115k -> 122k / 105k -> 115k / 101k -> 111k |
| rope bridge west / mid-span / cascade | 72 -> 49 / 36 -> 32 / 49 -> 37 | 69k -> 79k / 39k -> 58k / 54k -> 60k |
| brink terrace | 153 -> **87** | 160k -> 128k |
| (new) brink looking straight down the fall / valley seen from the summit | -> 46 / 63 | -> 78k / 92k |
Draw calls on the mountain fall by 25-45 %; triangles rise slightly in places because terrain tiles are merged (a merged 48 m block is drawn whole): a deliberate trade, as Quest 2 is far more sensitive to draws and fill than to 10-20k extra static triangles.
Estimator (`stats:check`): worst jungle view 169k tris / 73 draws (budget 170k / 100), worst mountain view 156k / 80 (budget 170k / 100; was 190k / 140 last round). Low tier: -15..-20 % on the mountain views (summit-down 70k -> 68k, descent 119k -> 105k, brink 125k -> 101k).
- **Memory (exact, in the scene):** geometry 29.0 MB (300 geometries, 368 meshes), textures 7.6 MB (13 textures, within the 8 MB budget), 106 material instances / 15 distinct materials, 54 shader programs.
- **Scene initialisation:** procedural build ~0.9-1.2 s on this desktop (terrain 0.5-0.7 s, vegetation 0.25-0.4 s, colliders 0.1-0.2 s); page to scene ready 6.9 s here in software GL. Quest 2 estimate (x5): ~5 s of build. It did not get worse than the pre-mountain estimate by much, but it is the largest unmeasured start-up risk.
- **Overdraw (fragments per pixel):** the alpha-tested foliage is the fill-rate risk: jungle entrance **4.2 raster layers**, clearing 4.7, climb 4.0; the mountain overlooks 0.3-0.5 (summit, bridge, brink), ridge 2.0. Water + waterfall blended layers are small at every station (<= 0.7, highest in the valley view); additive mist <= 0.8 (jungle shafts), 0.1 at the waterfall stations. **The most expensive viewpoints are therefore the jungle entrance/clearing (foliage fill) and the ridge (triangles + foliage), not the vertical views.**
- **CPU in the page (per frame, desktop JS):** all systems together 1.4-4.8 ms in software-GL runs (noise-dominated: the SDK's own UI/input/transform systems are the top entries at 0.2-1.2 ms each); our systems: ChunkLod 0.2-0.7, Collapse <= 0.7 near the ledge, Bridge <= 0.8 on the bridge, Atmosphere ~0.2-0.3. A Quest CPU is several times slower; the on-device `cpuMs.update` in the test JSON is the number to trust.

### What was built
- **Distance strategy** (`PROJECT_ARCHITECTURE.md` section 13): `open`-driven caps, per-class ranges, **terrain LOD** (fine tiles within 150 m, coarse 6 m stand-in beyond, hysteresis, no collision change), fine tiles merged per 48 m, valley wall/far plateau in one draw, canopy/crags in 128 m cells, far ranges in one draw, waterfall near/far meshes and mist range, jungle cap while on the mountain.
- **Dynamic events:** see the defect table; plus tests that triggers cannot repeat (8 `trigger()` calls -> 1 break; hovering at 15-21 m -> no break).
- **Comfort:** hazard auto-slow (bridge 0.6x, collapse ledge/platform edges 0.7x, steep descent 0.75x, ledges 0.85x; board toggle, `?hazard=0`); existing speed / snap turn / vignette / move-by-hand / seated / reduced-motion kept. Reviewed the whole route first-person-wise: steep slopes (<= 28 degrees, validated), narrow trail (lane 1.36 m between walls 2.36 m apart), cliff edges (walls verified 0.5-2.2 m from the drop), bridge (rails, 1.5 mm idle sway), collapse (haptics + 1.8 s eased carry, camera never touched), falling debris (pre-simulated, away from the route), fast downhill (auto-slow). **Nothing rotates or tilts the camera or body in play.**
- **Diagnostics:** area name, view openness/far plane/terrain LOD state on the wrist panel and in every result JSON; `?test=all` (11 stations, ~3 min); new stations `valley`, `brink-down`; guide for ADB/Chrome remote debugging and Meta's OVR Metrics Tool.
- Visual quality: no vegetation was removed from the walkable zones and no terrain flattened; tree/plant ranges tightened by 4-10 % (hi 42 -> 38 m, plants 50 -> 44 m, rocks 62 -> 54, deadwood 48 -> 42), which fog already hides at those distances (it is the one change to judge on the headset: any visible pop-in). Mountain silhouettes, the valley, the waterfall and mist, the jungle's colour identity per area are unchanged.

### Verification, by level
**Automated (Node)** - `npm run verify` passes: typecheck, validate (jungle sections 1-6 + the mountain section 7: reachability in both collapse states, no unguarded drop-off, bridge, debris, 14 viewpoints), stats:check (budgets above), production build.
**Desktop browser (software GL)** - `walk-test` (bridge crossing, both rails, summit lip, terrace lip, ledge edges, **hazard auto-slow: 0.6 on the bridge, 1.0 in the jungle, 0.75 on the descent**), `collapse-test` (approach, onshelf carry 15.5 -> 13.9 m, retreat, reset, double, dither, draws), `audit` (17 stations, 0 lazy shader compiles).
**XR emulator** - the Heartstone grab regression from last round was *not* repeated this round (grab/collision code unchanged; the colliders asset only gained the guard walls and the lane-wide boundary gap, covered by the walk tests). Nothing new was XR-emulated.
**Physical Quest 2** - **not tested**. Everything about frame rate, GPU time, thermals, comfort, start-up time, haptics, the carry at 72 Hz, pop-in at the LOD swaps (150 m terrain, 38-44 m trees, 240 m fall) is open.

### Known issues / remaining hardware tests
- Foliage fill (entrance/clearing, 4.2-4.7 layers) is still the likeliest GPU limit; the governor (shadows off, then low tier) is the safety net; `&quality=low` is the first experiment.
- The terrain LOD swap at 150 m is hidden only by fog (0.0036 on the mountain): look for a pop when walking along the descent.
- Start-up: ~5 s estimated procedural build; consider lazy building of the mountain if the headset shows a long black start.
- 'low' tier still draws the whole mountain's silhouette and valley canopy (that is the "enormous world"); it removes mist, shafts, detail ranges.
- The hand-relative thumbstick, seated offset and haptic strength remain unverified even in the emulator.

---

## Prompt 04 — The Vertigo Experience (mountain, summit overlook, steep descent, collapse, rope bridge, giant waterfall)
Date: 2026-11-07. The jungle, its three areas, locomotion and the Heartstone were kept. A side route now leaves the Forest Trail beside the
root arch and climbs a mountain: **summit overlook → cliff-ledge descent with a collapsing section → rope bridge over a gorge → terrace beside the
brink of a giant waterfall.** **None of it has been run on a physical Quest 2.** Every claim below says where it was verified.

### The experience, with measured numbers (`npm run validate` prints them)
| Moment | What it is | Numbers |
| --- | --- | --- |
| Discover the trail | a side route from the Forest Trail (near the root arch) through two colossal gate trees (scale 1.5: 57-63 m tall, 5 m trunk collider) | the route starts at (4.6, -38) |
| The climb | switchbacks up a forested flank, mud, roots, steps of rock, views opening as the trees thin | 378 m route in total; steepest grade 0.49 (26°); 34 m climb |
| **Summit overlook** | a promontory (a spur) over a crater-like valley, platform ends 1.3 m inside a sheer lip; far mountain ranges 430-900 m away | summit **96 m above the valley floor**; sheer drop at the tip, then a concave 60° wall |
| **Steep descent** | a gully down a cliff band, then a natural ledge: roots, loose cobbles, mud, a narrow path under a hanging cliff with vines | ledge 22 m → 10 m over ~170 m; steepest ground under the route 0.53 (28°) |
| **Collapse** | a rock shelf bridging a hollow in the ledge breaks; the route continues through the hollow | see "Collapse event" |
| **Rope bridge** | 23.6 m, individually varied planks (some cracked), two suspension cables from log posts, hanging ropes, handrails, guy ropes; river 20 m below | sag 0.8 m; sways mm-scale |
| **Giant waterfall** | the river drops 38 m in a cascade just upstream of the bridge, runs through the gorge and plunges over the valley wall into a pool; terrace 5 m from the brink | **51 m plunge**, 38 m cascade, mist at both feet |

Scale references: tree crowns carpet the valley, rock towers (25-70 m, scale 2.3-5.7) rise from it, emergent giants reach 57 m, and the far field is four
layered mountain ranges (up to 300 m high) fading into haze (fog 0.0125 → 0.0036 and the camera far plane 100 → 1000 m as you climb; both driven by height).

### Collapse event (the part with the most moving pieces)
`CollapseSystem` state machine: `intact → warning → tremor → breaking → collapsed`, re-armed by `reset`.
- **Cracks** fade in from 17 m (route distance to the shelf); **pebbles** fall from 10.5 m (30, pre-simulated, deterministic); **tremor** from 6.8 m: controller haptics and a
  ±3.5 mm vertical tremor of the walking surface (none in reduced-motion); **break** 2.6 s later (1.2 s after stepping onto it, so you always get a warning).
- **Break:** the valley-side lip pieces tumble away (scripted ballistics with bounces that slide down the slope; the validator proves none lands on the route and all end >= 8 m below the ledge);
  the walking surface (a *kinematic* locomotion environment, separate from every static batch) **sinks 2.35 m in 1.8 s** with a smoothstep curve (peak 1.96 m/s), carrying anyone on it; the hollow underneath is
  static terrain, so you end standing on rubble. The camera is never rotated or moved by script; only the ground moves.
- **The new route** is that hollow (a ≤ 0.53 slope scramble through cobbles) plus a chute to the lip; it exists in the heightfield from the start but is hidden under the shelf.
- **Cancel/reset:** retreating beyond 20 m before the break cancels it; after the collapse it re-arms when you are > 70 m away *and not looking at it* (or > 170 m); `window.__jumanjiCollapse.reset()/trigger()` for tests.
- **Failsafe:** `SafetySystem` returns you to the last firm ground (with a haptic tick) if you are ever found > 6.5 m below the route.
- Noted: the locomotion engine applies **3x gravity above y = 10 m**, i.e. on the whole mountain; this is why the route is fenced and why the collapse carries you instead of dropping you.

### How the world was extended (no rewrite)
- `world/math.ts` (shared noise/spline/polyline code, re-exported by `layout.ts`) and `world/mountain.ts` (landform, route, gorge, bridge/terrace/platform data, guard walls, viewpoints, terrain tiling).
  `layout.ts: terrainHeight()` now blends the jungle into the landform east of x = 22 and grades the route on top (bench, summit platform, collapse hollow, terrace). West of x = 6 it is the old function, unchanged.
- Placements: `world/mountain-placements.ts` (trees, plants, vines, rocks, deadwood, roots, canopy, crags). Jungle placements step aside from the mountain zone by a **post-filter**, so the existing jungle's random sequences and layout are untouched.
- Static batching kept: new classes `canopy` and `crags` (64 m cells), `trees-lo/far` cells 56 m; dynamic parts (shelf pieces, shelf collider, bridge, bridge collider) are separate nodes.
- Terrain: adaptive tiles (24 m at 1.5 m cells along the route, 1 m at the platforms; 48 m; 96 m at 4-6 m merged into one draw), a **side-projected rock/ground material** for cliffs, strata/iron/wet colours, vertex cliff relief. 73 tiles.
- Collision proxy: **guard walls** along both sides of the route, rings round the summit platform and the terrace, bridge rail walls (kinematic, with the deck). `world-colliders` boundary ring has a gap exactly one lane wide where the route leaves the jungle.
- Comfort (`settings/comfort.ts`, board toggles, URL): **move by head or by left hand** (yaw only), **reduced motion** (no sway/tremor, vignette >= 50 %), **seated** (view raised 0.4 m via an XR reference-space offset), existing speed, snap/smooth turn and vignette kept.
- Diagnostics: `?test=summit|summit-down|descent|cleft|bridge-mid|brink` run the same repeatable headset test at the new stations.

### Verification, by level
**Automated tests (Node, no GPU)** — `npm run verify` passes (typecheck, validate, stats:check, build):
- Jungle checks 1-6 unchanged and passing (contact, trunks, trail lane, reach, slope, areas).
- Section 7 (new): route grade <= 0.50; ground slope under the route <= 0.75; **all 10 stations reachable on foot both before and after the collapse** (flood fill with a 0.5 m capsule, 0.45 m step,
  guard walls, trunks, rock colliders, bridge rails); **no unguarded drop-off** (every free neighbour of every reachable cell is walkable or walled); summit and terrace let you get within 2.2 m / 0.5 m of the drop but not over it;
  bridge 20 m above the river and meeting both abutments; the sunk shelf is buried everywhere (margin >= 0.58 m); lip debris and pebbles end in the valley; trigger distances ordered; 12 viewpoints stand on ground or deck.
- Budgets (`stats:check`): worst jungle view 169k tris / 77 draws (budget 170k / 100: no regression); worst mountain view (brink) ~149k / 136 draws (budget 190k / 140); scene total 516k tris, 317 draws submitted;
  15 materials; 5 MB textures; asset build 1.5-2.1 s on this desktop (**Quest 2 estimate x5: 7-10 s: a start-up risk to measure**). 'low' tier: worst test view 145k.

**Desktop browser (headless Chromium, software GL: shows correctness, not speed)**
- `tools/walk-test.mjs` (real locomotion + collisions): **crossed the bridge** (x 172.6 → 208.8, deck height held), **rail walls stop sideways walking on both sides**, **summit: walking at the lip stops 0.5 m before the platform edge**,
  terrace lip stops, ledge: pushing towards the drop and into the rock both stop.
- `tools/collapse-test.mjs`: approach (cracks → tremor → break → sink 2.35 m → collapsed, collider parked), **standing on the shelf** (carried down onto the hollow floor: y 15.53 → 13.84, no fall), retreat (cancels), **reset** (re-arms when away and out of view);
  the failsafe fired once by accident (a test placed the player under the ground) and returned the player to firm ground.
- `tools/shot.mjs` stills of 12 stations (`docs/screenshots/mountain/`), `tools/relief.mjs` plan view of the heightfield.
- Observed limit: at ~1-3 fps (software GL) the kinematic carry **lagged** the moving platform; whether it tracks at 72 fps on a Quest is exactly what needs the headset.

**XR emulator (IWER, Quest 2 profile)**
- **Heartstone regression passed**: hand pinch grab of the relic, carry (moved 2.4 m), release, it settles on the ground (`Grabbed` seen while held).
- *Not* done in the emulator: thumbstick walking over the bridge/ledge (done with keyboard locomotion on the desktop instead), haptics, the hand-relative move option, the seated offset.

**Still requiring a physical Quest 2** (nothing below is verified): frame rate at the summit, brink and bridge (the fill-rate cost of the valley canopy, mist and fall is unmeasured); start-up time; comfort of the vertical exposure,
the bridge sway, the tremor and the 1.8 s carry; haptic strength; whether the kinematic carry tracks at 72 Hz; the hand-relative thumbstick and the seated offset; fog/far-plane look in the real optics; hand tracking on the new surfaces.
See `HEADSET_TESTING.md`: "Mountain checklist".

### Known limits / not done
- No audio (the bridge exposes `bridge.creaks` as a hook; the collapse has `collapse.state`).
- The new valley view has many cheap crowns on thin trunks: from far they read as a mushroom canopy; a denser, more varied far-tree billboard would look better, at a cost to measure first.
- Water sheets are plain scrolled textures (no foam particles); mist is a handful of additive cards (hidden in the 'low' tier).
- 3x gravity above 10 m is an SDK engine behaviour; not changed.
- `iwsdk` 1.1.0-rc.2 kept (see the Prompt 03 section for the stability review).

---

## Prompt 03 — Quest 2 performance audit and VR readiness
Date: 2026-11-06. Goal: a reliable performance baseline and a project ready for real headset testing.
The world, its three-area layout, locomotion and grabbing were **not** changed. **Nothing was run on a physical
Quest 2**; every number below says where it was measured.

### Where each claim was verified (read this first)

| Level | What was verified there | Status |
| --- | --- | --- |
| **Automated tests** (Node, no GPU, no browser) | `npm run verify`: typecheck, `validate-scene` (now also the three test poses), `stats:check` budgets, production build; generated scene data byte-identical after regeneration; project builds against SDK 1.0.1 | passed |
| **Desktop browser** (headless Chromium, *software* rasteriser: relative only) | exact draw calls / triangles / visible cells / shader-program counts; **overdraw per material class**; shader-recompile experiment; the full test-mode pipeline in the flat browser | measured (timings are NOT Quest numbers) |
| **XR emulator** (IWER, Quest 2 profile, software GL) | wrist overlay visible and updating; board buttons (diagnostics, test) clicked with a controller ray; in-VR test ran and wrote its JSON to the PC; display rate and supported rates read from the session; governor timeline (warm-up, two windows, settle) | passed |
| **Physical Quest 2** | frame rate, GPU timer availability, real session transitions, hand tracking, haptics, overlay legibility, memory, load time, 90 Hz request, comfort | **not tested** (see `HEADSET_TESTING.md`) |

### 1. Audit findings (before changes) and what was done

| Risk | Measured evidence | Action |
| --- | --- | --- |
| **Alpha-test foliage overdraw** | entrance: **3.0** surviving foliage layers/pixel, **6.0 rasterised** (50 % of fragments shaded then discarded); crowns are ~2.3 of the 3.0 (trees-hi 1.10, **trees-far 1.07**, plants 0.41) | crown cards trimmed to the alpha shape (octagon), fewer cards per tip; see §3 |
| Dense entrance | worst viewpoint (169k est. triangles, 98 draws measured) | no thinning; fill-rate cut at the source instead |
| **Additive shafts/mist** | 0.6–0.8 layers per pixel at every pose (blended) | quads trimmed to the visible beam (0.80 → 0.60); removed in `low` |
| **Shader compile hitches** | 29 programs. **The governor's own "shadows off" created shader programs**: `shadowMap.enabled=false` → 4 new programs, switching every `castShadow` off → **10** (each a synchronous compile, ~1.1-1.4 s in software GL), i.e. a hitch exactly when frames are late | shadows now off by shrinking the sun's shadow frustum: **0** new programs; shader warm-up (`compileAsync`) on page ready and again at session start |
| Procedural start-up | build 0.56–0.94 s on this desktop (varies with machine load), est. 3–5 s on a Quest 2 | not reduced (no measurable justification yet); now **measured on the device** (`boot.assetBuildMs`, groups, `pageLoadToTestMs`) |
| Memory / texture uploads | desktop run: 107 geometries, 20 textures, 29 programs, JS heap 111 MB; ~5 MB textures, no compression. The SDK carries a workaround for a super-three 0.185 bug that left textures un-uploaded in Quest multiview | reported in test results; compression left for a measured need |
| WebXR render config (read from the SDK) | `multiviewStereo: true` (both eyes in one pass), `antialias: true` (MSAA), fixed foveation 1.0, framebuffer scale 1.0; `hand-tracking` is an *optional* feature; reference space resolved with fallbacks | documented; nothing changed |

### 2. Runtime diagnostics (new)
- **Wrist panel** (world-space on the left controller; not head-locked): FPS and display rate, frame ms mean / p95 / max,
  missed-vsync %, budget, **CPU update + render ms**, **GPU ms** (or `GPU time: unavailable`), draws, triangles,
  visible cells, tier, shadows, **governor state**, position and area, GPU object counts, heap, and a red `EMULATOR (not a headset)` line.
  Flat browser: the same text as a DOM overlay. Toggle on the board or `?perf=1` / `?perf=0`.
- **Measured, never invented:** frame period between frame starts; CPU update (`world.update`) and CPU render submission
  (`renderer.render`) separately; GPU time only through `EXT_disjoint_timer_query_webgl2` (the property `gpuStatus` says why when absent; in the
  software-GL sandbox it *is* exposed, on a Quest it may not be: `null`, never a guess).
- Display rate and supported rates come from the XR session (`frameRate`, `supportedFrameRates`); `?hz=90` requests another rate.

### 3. Governor review
| Question | Finding |
| --- | --- |
| Is 72 Hz realistic? | It is the Quest Browser default and the right first target. The fixed 15.5 ms was 112 % of the 72 Hz period; the budget now follows the session's reported rate. 90 Hz is untested: only worth asking (`?hz=90`) if the 72 Hz p95 has about 20 % headroom. |
| Is 15.5 ms appropriate? | At vsync a missed frame jumps to 27.8 ms, so a *mean* near 15.5 ms means ~11 % missed frames. Kept as 112 % of the period but combined with **missed-vsync > 10 %**, and it must hold for **two 3 s windows** (6 s) |
| Smooth? | No action in the first **8 s** of a session (shader compile, uploads) or while the system menu is up; **3 s settle** after a step; never during a headset test; steps ≥ 9 s apart (verified in the emulator: step 1 at ~13 s, step 2 at 9 s later). Never steps back up |
| Shadows and vegetation LOD respond? | Shadows: 0 new shader programs (measured). LOD: cells shown change by tier (`cells=45/80` low vs `57/80` high at the entrance) |
| Does `low` help the GPU? | Measured at the three poses: **triangles −19 % to −21 %, draws −16 % to −22 %, shafts/mist removed, foliage fill −11 % to −15 %** (surviving layers 2.7→2.4, 2.7→2.3, rasterised 4.5→4.0, 4.8→4.1). Originally only −7 % foliage because the far wall and near crowns dominate; `low` now also drops the far wall beyond 60 m, ground patches beyond 20 m and hands detailed trees to the cheap version at 24 m |
| **Bug found by testing** | the governor ignored any 3 s window with fewer than 20 frames, so at very low frame rates (its whole purpose) it never acted. Fixed (judges any window with ≥ 3 frames) |
| Dynamic resolution? | Not added (as requested). Settings preserved: tiers, foveation 1.0, XR scale 1.0 |

### 4. Visual-performance work (worst three viewpoints), all measured
Overdraw is a device-independent count of fragments per screen pixel (`src/diagnostics/overdraw.ts`, run by `npm run perf:probe`).

| Pose (tier) | Draws | Triangles | Foliage layers surviving / rasterised | Shafts | Water | Opaque |
| --- | --- | --- | --- | --- | --- | --- |
| **before** entrance (high) | 98 | 167k | 3.0 / 6.0 | 0.8 | 0.0 | 1.4 |
| **after** entrance (high) | 98 | 172k | **2.7 / 4.5** | **0.6** | 0.0 | 1.4 |
| entrance (low) | 82 | 136k | 2.4 / 4.0 | 0 | 0.0 | 1.4 |
| **before** trail (high) | 78 | 126k | 1.9 / n/a | 1.5 (shafts+water) | | 1.6 |
| **after** trail (high) | 76 | 129k | **1.6 / 2.9** | 0.8 | 0.7 | 1.6 |
| trail (low) | 64 | 111k | 1.5 / 2.7 | 0 | 0.7 | 1.6 |
| **before** clearing (high) | 93 | 155k | 3.1 / n/a | 0.7 | 0.0 | 1.6 |
| **after** clearing (high) | 93 | 160k | **2.7 / 4.8** | 0.6 | 0.0 | 1.6 |
| clearing (low) | 72 | 130k | 2.3 / 4.1 | 0 | 0.0 | 1.6 |

What changed (and what deliberately did not):
- **Crown cards trimmed to the alpha silhouette** (octagon instead of a square): shaded-then-discarded fragments −25 % at the entrance.
- **Fewer, larger cards**: hi crowns 4 → 3 cards per branch tip, far-wall crowns 2 → 1 (bigger, so coverage is kept). Side-by-side stills at the entrance and the trail end look the same (density, silhouette, light), so the jungle is not emptier.
- Shaft quads trimmed to the visible beam; trunk radial segments 20 → 18 for the triangle budget; low tier strengthened (above).
- **Tried and found not worth it:** changing LOD distances (the 28 m cells quantise the result: 42/50/34 m vs 36/46/32 m changed worst-view triangles by < 1 %); disabling alpha-test mip shrinking and `alphaToCoverage` (edge quality, not cost; left for a headset A/B since MSAA is on); the shadow pass (6 draws, ~12 k triangles, only while a caster is within ±4.5 m of the player).
- **Candidate not done (needs the headset):** a cheaper lit material for foliage (the 2.7 surviving layers all pay full PBR lighting). Not changed without device evidence.

### 5. Headset test mode (new)
`?test=entrance|trail|clearing` or the three board buttons: teleport to a fixed pose and heading, **8 s warm-up**, **10 s sample**, then a JSON result (shown on the wrist panel,
logged as `[jumanji:perf-result]`, kept in `localStorage`, **POSTed to the dev server and saved in `perf-results/` on the PC**, and copyable from the board). The result records frames, fps, frame ms mean/median/p95/p99/max,
missed %, CPU update/render, GPU (or null + reason), draws, triangles, cells, tier, shadows, governor, display rate, player drift, boot timings, GPU object counts, heap, IWSDK version, XR features and **`emulated`**.
The poses are validated reachable, standable and with a clear view. Step-by-step instructions: **`docs/HEADSET_TESTING.md`**.

### 6. Quest 2 compatibility review
Read from the SDK and checked in the emulator; **physical compatibility is not verified**.

| Item | Evidence | Status |
| --- | --- | --- |
| Immersive VR entry | SDK `offer: always` button + board button `launchXR()` (user gesture); session `immersive-vr`; emulator session starts with `local-floor` | emulator only |
| Controllers, thumbsticks, snap turn | IWSDK input; walking and 30° snap verified in the emulator in earlier prompts (not re-run) | emulator (earlier) |
| Heartstone grab, haptic | squeeze grab verified in the emulator (earlier); haptic uses `gamepad.hapticActuators` | emulator (earlier); haptics unverified |
| Hand tracking | requested as an **optional** feature (VR must start without it); pinch grab passed in the emulator (earlier) | emulator (earlier) |
| Fullscreen / transitions | governor pauses on `visible-blurred`, restarts its warm-up on return; Exit/Enter from the board; shader warm-up on every session start | logic reviewed; **needs the headset** |
| Render configuration | multiview stereo, MSAA, foveation 1.0, XR scale 1.0 | read from SDK; **frame cost unmeasured** |

### 7. Stability and dependencies
**IWSDK 1.1.0-rc.2 vs 1.0.1 (trial in a sandbox copy; the project was not changed):**

| | 1.0.1 (stable) | 1.1.0-rc.2 (current, npm `latest`) |
| --- | --- | --- |
| three | super-three 0.181 | super-three 0.185 (the SDK ships a workaround for a Quest multiview texture-upload bug in this version) |
| Today's code | `tsc` passes, production build passes | all gates pass |
| Runtime with this project | **the scene is rejected**: `DomeGradient.elevationDeg / azimuthDeg / dither: component field is not declared` → the level fails to load | works |
| Release notes | GitHub releases empty, changelog 404: **no official notes to assess rc-specific issues** | |

**Recommendation: stay on 1.1.0-rc.2, exact-pinned (already), do not downgrade.** Going back needs scene/authoring changes (and probably more beyond the first error) for no demonstrated stability gain.
Mitigations: exact versions + lockfile, `npm run verify`, the headset test results; re-evaluate when 1.1.0 stable ships.

**npm audit:** `npm audit --omit=dev` (what ships) reports **0 vulnerabilities**. The full audit lists **4 high**, all dev tooling: `sharp` (advisory on its bundled librsvg, already overridden to 0.35.4)
reached through `@iwsdk/vite-plugin-dev` and `@huggingface/transformers` through `@iwsdk/reference` (both `devDependencies`). They affect the developer's machine while it processes images, not the
runtime bundle. No fix is available for three of them; no action taken.

### 8. Final validation
`npm run verify` passes (typecheck, validate, stats:check, build). Worst estimated view 169k triangles / 86 draws (budget 170k / 100); worst low-tier view 148k / 74. Generated scene data unchanged (byte-identical).
Locomotion, grabbing, the three-area layout and the budgets are preserved.

### Still requiring physical Quest 2 testing
Everything in `HEADSET_TESTING.md` §6, and above all: frame rate per pose (default, `quality=low`, `hz=90`, `xrscale=0.85`), whether Quest Browser exposes a GPU timer, real overlay legibility, session transitions,
hand tracking, haptics, load time (`boot.*`), memory, thermals, comfort, and whether the shader warm-up removes the first-frame hitch.

### Known limits of this round
- The DOM (flat-browser) overlay ran without errors but was not visually reviewed. The wrist panel was reviewed only in the emulator, and its two last layout tweaks (extra lines, narrower text) came after the screenshot.
- Overdraw/triangle/program counts are exact; every *time* measured here comes from a software rasteriser and says nothing about a Quest.
- The in-VR test needs ~3+ fps to collect enough frames; in the emulator it was marked `valid:false` with the reason (as designed).
- Start-up cost is not reduced, only made measurable.

---

## Prompt 02 — Transform the jungle into a living, visually rich environment
Date: 2026-11-06. Goal: a coherent, explorable tropical world with three recognisable areas,
without breaking VR functionality. No wildlife, combat, puzzles or extra levels (as requested).

### What changed

**World and layout**
- New layout along one ~75 m trail: **Jungle Entrance → Forest Trail → Ancient Clearing**. The altar
  and Heartstone moved to the clearing (end of the trail) as agreed; relic/grab logic is unchanged.
- Terrain v2: graded trail (steepest slope 0.21 ≈ 12°), muddy hollows with puddles, carved stream with
  a downhill water profile and a **ford**, pool basin, jungle-wall hills; 16 tiles with distance-based
  resolution; vertex-colour splat (grass/moss/soil/litter/stone/mud) with per-area grading and baked AO.
- Landmarks: gate trees + overhead limb, **root arch**, **fallen giant**, rock outcrop, pool + cascade,
  **spire**, overgrown **temple** with sun-disc relief, pillars, waterfall cliff backdrop, three fogged ridge layers.

**Vegetation and variety**
- Semi-realistic **alpha-cutout cards** from one procedural 512² leaf atlas (single foliage material);
  real trunks with buttresses and bark grooves, branching limbs, lianas.
- Species: 4 tree families (hi/lo LOD), 4 palm silhouettes, 3 broad-leaf, ferns S/M/L clusters, tree ferns,
  shrubs, 4 ground-cover patches, reeds, pads, flowers (the one warm accent), moss, litter, logs, branches, roots, 7 rock kinds.
- Placement by transition bands and area mix; biologically narrow scales; per-instance yaw, ground tilt and colour tint.
  Baked instance counts: 104 trees, 80 fern clusters, 91 broad-leaf, 55 shrubs, 40 palms, 268 ground patches,
  96 rocks, 63 deadwood pieces.

**Water and atmosphere**
- Pool + stream + puddles in one mesh: depth-faded vertex alpha, scrolling ripple bump (glint moves), fresnel sky
  tint as the cheap reflection. Reeds, pads, bank stones, stepping stones.
- One sun (`SUN_DIR`) drives the light, shaft orientation and AO bias; shafts placed in measured canopy gaps; ground mist;
  fog colour tied to the ridges. A small shadow follows the player. No post-processing.

**Quest 2 engineering**
- Vegetation, rocks and deadwood are **static-batched per 28 m cell and class** with **distance LOD** (replaces SDK
  instancing after measurement; see architecture doc §5). Draw calls and triangles per viewpoint are estimated by `npm run stats`.
- Quality tiers (board toggle, `?quality=`), **adaptive governor** in XR, foveation 1.0, `?area=` shortcuts,
  extended `?debug` telemetry.
- Tooling: `validate-scene` (contact / trunks / trail lane / reachability / slope), `asset-stats --check` (budgets), generator with baked data.

### Verification evidence (what was actually run)

| Check | Result |
| --- | --- |
| `npm run verify` (typecheck, validate, stats:check, build) | all pass; dist 3.7 MB (main JS chunk 2.5 MB, mostly SDK) |
| `validate-scene` | **0 errors**: 894 baked vegetation/rock/deadwood instances: highest 0.002 m above the ground, deepest sink 0.37 m (nothing floats); 104 trees, smallest trunk gap 1.8 m; closest obstacle to the trail centre-line 1.15 m (the altar at the trail's end); flood fill: **gate, ford, pool bank, root arch, fallen giant, clearing, altar and temple front all reachable** (100 % of walkable cells connected; 77 m of walking spawn→temple) |
| Budget (`stats:check`) | submitted 200k triangles / 119 draws; 12 materials; ~5 MB textures; **estimated visible per viewpoint: 46–86 draws, 87k–164k triangles** (worst: the entrance/gate looking down the trail) |
| In-browser counts while walking spawn→clearing (desktop, software GL) | draw calls 87 → 81 → 73 → 57, triangles 137k → 134k → 117k → 90k, cells shown 50-67 of 80: matches the estimate |
| Console | no errors or warnings on the full scene after fixes |
| Desktop | WASD walked 66 m from the spawn to the clearing without blocking; right-drag look unchanged |
| Emulated Quest 2 session | starts; right-stick snap turn and walking verified on the fixture earlier; collision stops the player at the world wall (z = 17.8) and at the altar collider (z = −60.0) |
| Grab at the new altar (controller squeeze) | grabbed (state `held`, glow 1), followed the controller, released in mid-air, fell and **rests on the ground** (y = 0.008); relic starts exactly on the altar (y = 0.947) |
| Board | quality toggle clicked with a controller ray: label → "Quality low (faster)", tier applied |
| Adaptive governor (emulated XR, slow software GL) | stepped down twice and logged `[jumanji:governor] … step 1 (shadows off)`, `… step 2 (low tier)` |

**Caveats on that evidence**
- Interaction tests ran on lightweight fixtures (`test-grab`, `test-route`): same terrain, **real colliders** and relic, no vegetation, because the managed browser renders the full scene at ~1-3 FPS in software GL.
- The walk along the *curving* trail with thumbsticks was only partly automated (spawn → gate → ford/arch region reached; my open-loop driver was too crude to finish). Reachability of the whole trail rests on the flood fill plus a straight-line walk spawn → altar.
- Visual reviews are still renders from the editor camera at standing eye height (the editor does not run the LOD system) plus runtime screenshots; **motion, comfort and frame rate are untested**.
- Hand-pinch grab and snap turn were not re-run in this prompt (code unchanged since Prompt 01, where they passed).
- The base of "standing" rocks was darkened and sunk deeper *after* the last screenshots; not re-viewed.

### Not verified: needs the physical Quest 2
1. **Frame rate in every area** (fill-rate is the risk: alpha-tested cards in ferns, plants and tree crowns overdraw).
2. Whether the **72 Hz governor thresholds** (15.5 ms for 3 s) are right, and whether stepping down is smooth.
3. **Load time**: procedural build ≈ 0.8 s on this desktop (est. 3-5 s on a Quest 2; groups: terrain 0.35 s, vegetation 0.3 s).
4. Memory/thermals over 10-15 minutes; texture upload time.
5. Visual density, legibility and colour in the headset (foveation 1.0 softens the periphery), light-shaft brightness.
6. Comfort (snap turn, vignette, walking speed, slope feel on the rolling terrain, ducking under the root arch).
7. Hand tracking, haptic tick on grab, board readability, Enter-VR flow over the LAN certificate.

### Known issues and limitations
- **Triangle budget at the entrance is tight** (164k of the 170k budget, estimated). Foliage overdraw is not captured by any estimate.
- The `hi` tree class only covers trees within 14 m of the trail or the clearing (23 trees); the rest of the wall uses the cheap version (two crown cards), which is silhouette-like up close if the player leaves the trail.
- Cutout leaves look better than the earlier faceted style but are still stylised, not photoreal; bark detail is geometry + vertex colour only (no texture on trunks).
- Water reads a little minty in stills; the stream is shallow and non-animated apart from the glint; no depth refraction.
- Only the ruins, altar, pillars and relic cast shadows (a deliberate cost decision).
- Light shafts are additive cards, not volumetrics; they do not follow the real shadows.
- Long presses are not UIKit clicks (use a short press). OneHand + ray components still cannot share an entity.
- Scene JSON is generated (editor hand edits are lost on regeneration). `npm audit` still lists 3 transitive dev-tool findings (unreviewed). IWSDK 1.1.0-rc.2 is a release candidate.
- No audio, wildlife or puzzles (out of scope by request).

### Performance concerns (in order)
1. Overdraw/fill-rate of alpha-tested cards and layered additive shafts/mist on a Quest 2 at 90 Hz; **72 Hz is the realistic first target**.
2. The worst viewpoints (spawn, gate, looking back from the altar) at 145-164k estimated triangles.
3. Start-up procedural build (CPU) on the headset.
4. 12 materials / ~25 shader programs: first-frame compile hitches.

### Exact next testing steps (on the Quest 2)
1. `npm run dev:status` → open the **network** URL in Meta Quest Browser, accept the certificate, Enter VR. Time the loading screen.
2. Re-open with `?debug`; read the console through `chrome://inspect` (ADB). For each of `?area=entrance`, `?area=trail`, `?area=clearing`
   stand still for 10 s facing the long view and note `fps`, `calls`, `tris`, `cells`.
3. If any area is below 72 FPS: reload with `?quality=low`, then try `?xrscale=0.85`; record which helps. Note any `[jumanji:governor]` lines.
4. Walk the whole trail once with default settings: note comfort, any hitch, anything floating or intersecting, anything too bright/dark.
5. Grab the Heartstone with the grip, then with a hand pinch; check haptics and that it rests when dropped.
6. Report FPS per area, comfort, and the three worst-looking spots; those drive the next optimisation pass (candidate levers: `CHUNK_LOD` distances,
   fern/palm density in `placements.ts`, tree `hi` radius, shafts, shadow).

### Decisions to carry forward
- Vegetation is **static-batched by cell + class** with distance LOD; new content goes through `placements.ts` → generator → `baked.ts`.
- One palette, one roughness table, one sun; the single warm accent stays reserved.
- Budgets are enforced by `npm run verify`; treat estimates as submitted work, never as frame time.
- Near-grab for hero objects; far-grab props must not carry `OneHandGrabbable`.
- Quality tiers and the governor are the safety net; keep new effects tier-aware.

---

## Prompt 01 — foundation (summary)
Scaffolded with the official generator (VR, TypeScript, locomotion, grabbing, no physics, git). Built the original procedural
blockout, locomotion + snap turn, grab with settle behaviour (`RelicSystem`), expedition board with comfort toggles,
runtime WebXR feature detection, desktop WASD + right-drag look, render-scale/foveation settings and telemetry.
Emulator results then: walking 2.5 m/s, wall/trunk/altar collision, 30° snap turn both ways, squeeze and pinch grab,
release settles on altar/ground, ray click on the board.

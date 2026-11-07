# Development progress

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

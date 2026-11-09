# Testing on a physical Meta Quest 2 (local network)

Nothing in this project has been run on a physical Quest 2 yet. This guide produces the first
real numbers. Every result is saved as JSON on your PC, so you can send it back for analysis.

## 1. One-time PC setup (Windows)

1. Put the PC and the Quest on the **same Wi-Fi** (not a guest network; "client isolation" blocks it).
2. Allow the dev server through the firewall (PowerShell **as Administrator**, once):
   ```powershell
   New-NetFirewallRule -DisplayName "Jumanji VR dev 8081" -Direction Inbound -Protocol TCP -LocalPort 8081 -Action Allow -Profile Private
   ```
3. In the project folder: `npm install` (first time only).

## 2. Start the server

```powershell
npm run dev:runtime
```

Vite prints a `Network:` line, e.g. `https://192.168.1.23:8081/`. That is the address for the headset.
(`npm run dev` also works but opens a browser window on the PC that wastes CPU; `dev:runtime` is just the server.)
The IWER emulator only activates on `localhost`, so over the LAN address you get the **real** WebXR.

Results from the headset are written to `perf-results/` in the project folder on the PC.

## 3. Open it on the Quest

1. Meta Quest Browser → type `https://<PC-IP>:8081/?perf=1`
2. A certificate warning appears (it is the local dev certificate): **Advanced → Proceed**.
3. The expedition board shows `VR ready. Headset detected`. If it says *WebXR unavailable* or *Desktop mode*, stop and report that text.
4. Press **Enter VR** (the pill at the top of the page, or the board button).
5. Raise your **left controller** like a watch: the diagnostics panel (FPS, ms, draws, triangles, tier, governor) is on top of it.

## 3b. The fastest complete run: every environment with one link

`https://<PC-IP>:8081/?perf=1&test=all` : press **Enter VR** and stand still. The test visits 11 stations in order (jungle entrance, trail, clearing, the valley seen from the summit,
looking down from the summit, the waterfall across the valley, the steep descent, the collapse ledge, mid-span on the rope bridge, the brink terrace, straight down the waterfall),
6 s warm-up + 10 s sample each (about 3 minutes in all; `&warmup=` and `&sample=` change the times), then writes one JSON per station to `perf-results/` on the PC. The wrist panel shows
`TEST <station> (3/11): SAMPLING 7 s`. You are teleported between stations (the rig is moved, which is deliberate for this test only). Repeat three times, and again with `&quality=low`.
`?test=<station>` runs one station: `entrance trail clearing valley summit summit-down summit-fall descent cleft bridge-mid brink brink-down`.

## 4. The measurement procedure (3 poses, 3 runs each)

Each test teleports you to a fixed pose and facing, waits **8 s (warm-up)**, then samples **10 s**.
**Stand still and look straight ahead** (do not walk or turn during the 18 s). Face the room's forward
direction when you enter VR (the test turns the world, not you).

| Test | Pose | What it stresses |
| --- | --- | --- |
| `entrance` | arrival point, looking down the trail | densest foliage + shafts; the heaviest view |
| `trail` | trail bend, looking at the pool and cascade | water, shafts, mixed layers |
| `clearing` | clearing, turned to look back down the trail | tree crowns, ruins, far wall |

Run each test one of two ways:

- **In VR:** the three **Test:** buttons on the board (short press, about 0.2 s). After the test you are returned to the board.
- **By URL:** `?test=entrance`, `?test=trail`, `?test=clearing` (add `&perf=1`). Press Enter VR and the test starts.

Do **3 runs per pose**, then repeat the set with each variant below (variants are URL options; keep the same pose):

| Variant | Add to the URL | Question it answers |
| --- | --- | --- |
| default | (nothing) | baseline at the platform default (72 Hz) |
| low tier | `&quality=low` | how much does low quality help? |
| 90 Hz | `&hz=90` | is 90 Hz achievable? (the browser may refuse; the log says) |
| lower resolution | `&xrscale=0.85` | is the render resolution the limit? |
| governor on | `&governor=1` | does it step down, and does that help? |

After each run the overlay shows `Done: <fps> fps, <p95> ms p95` and, if the page reached the server,
`Saved to perf-results/ on the PC`. Each file is named `<time>_immersive-vr_<pose>.json`.

## 5. How to read a result

Key fields (all measured on the headset; nothing is estimated):

- `session` must be `immersive-vr`; `environment.emulated` must be `false`; `valid` must be `true`
  (otherwise read `notes`: you moved, or too few frames were captured).
- `fps`, `frameMs.mean/p95/p99/max`, `missedFramesPct` (frames longer than 1.5 display periods).
  Target: `frameMs.p95` at or under the display period (`display.periodMs`, 13.9 ms at 72 Hz) and `missedFramesPct` under 2.
- `cpuMs.update` (all game systems) and `cpuMs.render` (three.js submission): CPU only.
- `gpuMs`: GPU time **if** the browser exposes `EXT_disjoint_timer_query_webgl2`; otherwise `null` and `status` says why.
  Quest Browser may not expose it. If `null`, the GPU/CPU split is not available: compare `frameMs` with `cpuMs`
  (frame much longer than the CPU total ⇒ GPU-bound).
- `draws`, `triangles`, `vegetationCellsShown`: exact renderer numbers for the sampled frames.
- `boot.assetBuildMs` and `boot.pageLoadToTestMs`: start-up cost on the device. `memory`: GPU objects and JS heap if exposed.
- `governor`: `state` and `step` (a step during the test only happens with `&governor=1`).

## 6. Compatibility checklist (physical headset)

Tick these on the headset; none is verified yet.

- [ ] Page loads over the LAN address; certificate accepted; board status says `VR ready`.
- [ ] **Enter VR** starts an immersive session (no error, view appears at the correct floor height).
- [ ] Both controllers are tracked and visible; the left-wrist overlay follows the left controller.
- [ ] Left thumbstick walks; right thumbstick **snap turns** (30°, one click per flick); walking is blocked by trunks, the world edge and the temple.
- [ ] Grip near the **Heartstone** (on the altar in the ancient clearing) grabs it; release drops it and it rests on the altar or ground; the controller gives a short haptic tick.
- [ ] Hand tracking (put controllers down): pinch near the Heartstone grabs it. (Hand tracking is requested as an *optional* feature, so VR must still start without it.)
- [ ] Press the **Meta button** (system menu) and return: view resumes, governor reads `paused (system menu)` while away.
- [ ] **Exit to browser** (board) returns to the flat page; **Enter VR** again works (second session).
- [ ] Board buttons respond to short presses (comfort, quality, diagnostics, tests).

## 6b. Mountain checklist (Prompt 04; none of it verified on a headset yet)

Direct links (add to the address; `?perf=1` shows the diagnostics): `?area=summit`, `?area=descent`, `?area=cleft`, `?area=bridge-west`, `?area=brink` start you there.
Repeatable measurements: `?test=summit`, `?test=summit-down`, `?test=descent`, `?test=cleft`, `?test=bridge-mid`, `?test=brink` (8 s warm-up, 10 s sample, JSON saved to `perf-results/` like the jungle poses; run each 3 times, also with `&quality=low`).

- [ ] Walk the whole route from the root arch (about 4 minutes): climb, summit, descent, collapse, bridge, terrace.
- [ ] Summit: you can walk to about half a metre from the edge, look down, turn your head and see the far ranges; you cannot step over. Any vertigo discomfort? Rate it.
- [ ] Ledge: the invisible walls hold on both sides; nothing feels like an invisible wall in the open.
- [ ] Collapse: you see cracks, hear nothing (no audio yet) but feel the controllers buzz, the shelf breaks ~2.6 s after the tremor starts. Test **three ways**: stop 5 m before it and watch; walk onto it (you are carried down about 2.35 m in 1.8 s: comfortable? any jolt?); retreat before it breaks (it must cancel). Walk away 80 m, look away and come back: it should be intact again (it re-arms by itself when you are far away and not looking at it).
- [ ] Bridge: cross at normal speed and slowly; the sway should be barely noticeable (try `?reduced=1`: none); the rail walls keep you on the deck; the gaps between planks show the gorge.
- [ ] Brink terrace: look over the waterfall, see the pool far below and the mist.
- [ ] Comfort options on the board: Move by head / hand (the left thumbstick should follow where the left controller points), Seated (view 0.4 m higher), Reduced motion, speed and vignette.
- [ ] Frame rate at `?test=valley`, `?test=summit-down`, `?test=brink-down`, `?test=bridge-mid` (or all of them with `?test=all`): record p95 and the governor's reaction (`&governor=1`). Open question: does the valley canopy + mist + far ranges fit in 13.9 ms?
- [ ] Start-up time on the headset (`boot.assetBuildMs` in the JSON): the mountain adds about 1 s of procedural build on the desktop (estimate 5 s more on a Quest 2).

## 6c. Reading the numbers with the browser's own tools (USB debugging)

The in-VR panel and the JSON give frame time, CPU and (if exposed) GPU time. For more, use the standard Quest tooling (these are Meta/Chrome tools; I have not run them against this build):

1. Developer mode on the headset (Meta Horizon app -> Devices -> Headset settings -> Developer mode), USB cable, accept "Allow USB debugging" in the headset.
2. On the PC with Android platform-tools: `adb devices` must list the Quest. `adb reverse tcp:8081 tcp:8081` lets the headset open `https://localhost:8081/` (a secure context without any certificate warning).
3. PC Chrome: `chrome://inspect/#devices` -> the Quest Browser page appears -> **inspect**. Console shows `[jumanji]` lines (GPU timer status, governor steps, shader warm-up) and
   `[jumanji:perf-result]`. **Performance** panel -> record 10 s while standing at a station: look for long tasks (the update/render split is also in the overlay), `Major GC`, and shader-compile stalls (none expected: all programs are built at start).
4. Frame pacing and GPU load: Meta's **OVR Metrics Tool** (overlay with FPS, stale frames, GPU/CPU utilisation, thermal state) and the Performance Analyzer in **Meta Quest Developer Hub** read the device counters this page cannot. Note GPU utilisation and stale frames at the summit, the brink and the entrance.
5. `adb logcat -s chromium` shows browser-level warnings (out of memory, context loss).

Not available from the page: exact GPU time on some browsers (`GPU time: unavailable` is reported honestly), thermal state, memory beyond the JS heap.

## 7. What to send back

The `perf-results/*.json` files (all of them), plus a note of: comfort (any nausea, snap-turn feel), the worst-looking
spots, anything floating or intersecting, and whether the headset got warm. See `DEVELOPMENT_PROGRESS.md` for what
the numbers will be compared against.


## 9. Recording sheet (copy per session)

| Station | fps / p95 ms | missed % | draws / tris | GPU util / stale frames (OVR Metrics) | Comfort 0-5 (0 = none, 5 = sick) | Visual notes (pop-in, shimmer, flicker, fog) |
| --- | --- | --- | --- | --- | --- | --- |
| jungle entrance | | | | | | |
| summit, level (`valley`) | | | | | | |
| summit, looking down | | | | | | |
| waterfall across the valley | | | | | | |
| steep descent | | | | | | |
| collapse ledge (before / during / after) | | | | | | |
| rope bridge | | | | | | |
| brink, looking over the fall | | | | | | |

Also note: time from pressing Enter VR to a usable view; whether you saw terrain/vegetation **pop** when walking (terrain LOD swaps at 150 m, trees at 38-44 m); whether the fall detail change at 240 m is visible;
whether auto-slow on the bridge / descent / ledges felt right (`?hazard=0` turns it off); headset temperature after 10 minutes; battery drop.

## 10. Wildlife and sound (Prompt 07): what only the headset can tell us

Nothing about the wildlife or the sound has been run on a Quest 2, and the synthesised sounds have never been listened to. Do these in order; each is a yes / no / notes.

**Sound** (volume at a comfortable level; use `?audio=0` or the board's Sound button to compare)
1. Press **Enter VR**: is there sound within a few seconds (wind, insects)? If not, press the board's Sound button twice (that is a gesture) and note it.
2. Entrance: insects around you (4 voices orbiting), light wind. Natural, or obviously synthetic / too loud / too repetitive? Any crackle or click every ~6-12 s (a loop point)?
3. Walk to the pool and the ford: the stream/trickle gets louder and stays where it is as you turn your head. Walk toward the clearing: the waterfall ahead is audible from far away and gets louder.
4. Birds and monkeys: calls come from where the animal is (look for it); a flush makes the insects hush for a few seconds and then return. Distant calls every ~5-15 s: believable or annoying?
5. Mountain: wind much louder, insects gone, waterfalls (giant fall, cascade, gorge under the bridge) audible; the bridge and the summit still feel right with the sound on.
6. Performance with sound: compare fps / missed frames with `?audio=0` (HRTF panning of ~8-12 voices is the likely cost; the 'low' tier already switches new call voices to cheaper panning).

**Wildlife** (compare with the board's Wildlife button off, or `?wildlife=0`)
1. Frame time at the entrance, trail and clearing stations (`?test=all`, then toggle): expect +12-14 draw calls, +5-16k triangles; note fps, missed %, governor steps.
2. Are the animals visible at the distances you meet them (5-15 m)? Anything floating above a branch, sunk into it, standing in the air, clipping a trunk, or moving like a machine?
3. Walk toward a perched bird or monkey: does it react at a believable distance (birds 6-12 m, monkeys 11-14 m) and not constantly? Do crossing flocks pass through the view every half minute or so while you stand still?
4. Butterflies in the clearing and along the flowers: do they fly away when you walk up to them? Dragonflies over the pool?
5. Plants: do low plants lean away from your feet and your hands (hold a controller or hand in a fern)? Pleasant, or twitchy? Check again with `?reduced=1` (wind at 40 %).
6. The new perch boughs on every tree (a thin horizontal branch at 3-4 m and another at 6-9 m, with a leaf tuft at the tip): do they look natural or too regular?

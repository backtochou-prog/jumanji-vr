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

## 7. What to send back

The `perf-results/*.json` files (all of them), plus a note of: comfort (any nausea, snap-turn feel), the worst-looking
spots, anything floating or intersecting, and whether the headset got warm. See `DEVELOPMENT_PROGRESS.md` for what
the numbers will be compared against.

# Jumanji VR: the environment

A walk through the jungle, from the first step to the altar. Stills are rendered from the editor camera at standing eye height (1.65 m) and do not show motion, comfort or frame rate. Nothing has been run on a physical Quest 2 yet.

![Overview of all eight views](screenshots/00-overview.jpg)

## 1. Jungle Entrance
Cool, dark and dense. Colossal gate trees, an overhead limb hung with lianas, thick ferns and broad-leaf plants, low ground mist.

![Arrival at the entrance](screenshots/01-arrival-entrance.jpg)
![Inside the entrance gate](screenshots/02-entrance-gate.jpg)

## 2. Forest Trail
A winding trail with muddy hollows, layered plants, light shafts, a shallow ford with stepping stones, a pool with a cascade, a root arch and a fallen giant tree.

![Forest trail](screenshots/03-forest-trail.jpg)
![Ford and stream](screenshots/04-ford-and-stream.jpg)
![Pool](screenshots/05-pool.jpg)

## 3. Ancient Clearing
Open and warm. Wildflowers in the meadow, an overgrown temple with a sun-disc relief, ruined pillars, and the altar holding the Heartstone. The spire rises above the trees as the destination landmark.

![End of the trail, spire ahead](screenshots/06-trail-end-spire.jpg)
![Ancient clearing](screenshots/07-ancient-clearing.jpg)
![Altar and temple](screenshots/08-altar-and-temple.jpg)

## 4. The mountain (Prompt 04)
A side trail from the root arch climbs a forested mountain to a summit overlook, descends a cliff ledge (the ground collapses), crosses a rope bridge and ends beside a giant waterfall.
Stills come from the real scene at standing eye height (desktop render; no motion, no comfort, no frame rate; nothing here has been run on a physical Quest 2).

![The climb](screenshots/mountain/climb.jpg)
![Summit overlook: the valley and the giant waterfall](screenshots/mountain/summit-fall.jpg)
![Summit overlook, looking down](screenshots/mountain/summit-down.jpg)
![Steep descent along the cliff ledge](screenshots/mountain/descent.jpg)
![Before the collapse](screenshots/mountain/cleft.jpg)
![Rope bridge, west end](screenshots/mountain/bridge-west.jpg)
![Mid-span, looking down at the gorge](screenshots/mountain/bridge-mid.jpg)
![The cascade upstream of the bridge](screenshots/mountain/bridge-cascade.jpg)
![Brink terrace](screenshots/mountain/brink.jpg)

| Number | Value |
| --- | --- |
| Route | 378 m, steepest grade 0.49 (26 deg) |
| Summit above the valley floor | 96 m |
| Giant waterfall / cascade | 51 m / 38 m |
| Bridge | 23.6 m long, 20 m above the river |
| Visible per mountain view (CPU estimate) | up to 136 draws, ~149k triangles |

## Numbers (estimates, not frame time)
| Item | Value |
| --- | --- |
| Submitted geometry | about 200k triangles, 119 draw calls |
| Visible per viewpoint (CPU estimate) | 46 to 86 draw calls, 87k to 164k triangles |
| Materials / textures | 12 materials, about 5 MB of textures |
| Procedural build time | about 0.8 s on desktop, est. 3 to 5 s on a Quest 2 |

See `PROJECT_ARCHITECTURE.md` for how it is built and `DEVELOPMENT_PROGRESS.md` for what was verified and what still needs the headset.

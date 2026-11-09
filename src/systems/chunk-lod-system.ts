import { Box3, createSystem, Mesh, Vector3 } from '@iwsdk/core';
import type { Object3D } from '@iwsdk/core';
import { CELL_SIZE, CHUNK_ORIGIN, JUNGLE_CELL_CAP, JUNGLE_LANDMARK_CAP, TERRAIN_LOD, cellDistance, chunkVisible, viewCap } from '../world/layout.js';
import { riverPoint } from '../world/mountain.js';
import { atmosphere } from './atmosphere-system.js';
import type { ChunkClass } from '../world/layout.js';
import { lodState } from '../settings/quality.js';
import { metrics } from '../diagnostics/frame-metrics.js';

interface Tile {
  obj: Object3D;
  box: Box3;
}
interface Root {
  fine: Object3D[];
  coarse: Object3D | null;
  x0: number;
  z0: number;
  near: boolean;
}
interface Chunk {
  obj: Object3D;
  cls: ChunkClass;
  ix: number;
  iz: number;
}

/**
 * Distance LOD + culling for the static-batched vegetation cells.
 * Each cell is one mesh per class (see scene-assets/chunks.scene-asset.ts); every
 * 0.25 s this toggles `visible` by the distance rules in world/layout.ts (CHUNK_LOD):
 * detailed trees within 30 m, the cheap tree version beyond (one version at any distance, with 1.5 m hysteresis so a cell on a threshold does not
 * toggle while the head sways), small plants within 36 m, ground-cover patches within 34 m. Frustum culling then happens per visible cell
 * inside three.js. The 'low' quality tier scales the distances down (lodState.scale).
 * Allocation-free in update().
 */
/** Last result, read by DebugSystem: cells shown / total. */
/** Jungle objects that are not cell-batched. Beyond JUNGLE_LANDMARK_CAP (m) from the player they are not drawn (keeps the mountain views from paying for the jungle). */
const JUNGLE_LANDMARKS = /^(Terrain_\d+_\d+|Overgrown temple|Temple overgrowth|Ruined spire \(landmark\)|Spire overgrowth|Ancient altar|Ruined pillars|Entrance limb \+ lianas|Pool, stream and puddles|Distant cliff|Distant waterfall|Root arch \(landmark\)|Fallen giant \(landmark\))$/;
/** Mountain objects that are not cell-batched: drawn only within the mountain cap (26 m in the jungle, growing to 1 km as the view opens), like the mountain terrain. */
const MOUNTAIN_LANDMARKS = /^(Rope bridge|Gorge river, plunge pool, valley river|Collapse shelf)$/;
const FALL_CENTER = riverPoint(70);
const FALL_NEAR = 240;
const MIST_RANGE = 480;
export const chunkStats = { shown: 0, total: 0 };
/** Terrain LOD state for the diagnostics: detailed roots drawn fine / coarse. */
export const lodInfo = { fineRoots: 0, coarseRoots: 0 };

export class ChunkLodSystem extends createSystem({}) {
  private chunks: Chunk[] = [];
  private tiles: Tile[] = [];
  private roots = new Map<string, Root>();
  private far: Object3D[] = [];
  private landmarks: Tile[] = [];
  private mtnLandmarks: Tile[] = [];
  private ridges: Object3D[] = [];
  private fallNear: Object3D | null = null;
  private fallFar: Object3D | null = null;
  private mist: Object3D | null = null;
  private acc = 1;
  private collected = false;
  private px = 0;
  private pz = 0;
  private readonly tmp = new Vector3();

  private collect(): void {
    const walk = (o: Object3D) => {
      const fm = /^Mountain_(\d+)_(\d+)_\d+$/.exec(o.name);
      const cm = /^MtnCoarse_(\d+)_(\d+)$/.exec(o.name);
      if ((fm || cm) && (o as Mesh).isMesh) {
        const key = `${(fm ?? cm)![1]},${(fm ?? cm)![2]}`;
        const r = this.roots.get(key) ?? { fine: [], coarse: null, x0: TERRAIN_LOD.x0 + Number((fm ?? cm)![1]) * TERRAIN_LOD.size, z0: TERRAIN_LOD.z0 + Number((fm ?? cm)![2]) * TERRAIN_LOD.size, near: true };
        if (fm) r.fine.push(o);
        else r.coarse = o;
        this.roots.set(key, r);
        return;
      }
      if (/^(Mountain_far|RouteTrail_\d+)$/.test(o.name) && (o as Mesh).isMesh) {
        const g = (o as Mesh).geometry;
        if (!g.boundingBox) g.computeBoundingBox();
        this.tiles.push({ obj: o, box: g.boundingBox!.clone() });
        return;
      }
      if (/^Far ranges?$/.test(o.name)) this.far.push(o);
      if (/^Background ridge \d$/.test(o.name)) this.ridges.push(o);
      if (o.name === 'FallNear') this.fallNear = o;
      if (o.name === 'FallFar') this.fallFar = o;
      if (o.name === 'Fall mist') this.mist = o;
      if (MOUNTAIN_LANDMARKS.test(o.name)) {
        const box = new Box3().setFromObject(o);
        if (!box.isEmpty()) this.mtnLandmarks.push({ obj: o, box });
        return;
      }
      // Jungle landmarks and tiles (not cell-batched): only drawn within JUNGLE_LANDMARK_CAP so the mountain views do not pay for them.
      if (JUNGLE_LANDMARKS.test(o.name)) {
        const box = new Box3().setFromObject(o);
        if (!box.isEmpty()) this.landmarks.push({ obj: o, box });
        return;
      }
      const m = /^veg (\S+) (\d+) (\d+)$/.exec(o.name);
      if (m) {
        this.chunks.push({ obj: o, cls: m[1] as ChunkClass, ix: Number(m[2]), iz: Number(m[3]) });
        return;
      }
      for (const c of o.children) walk(c);
    };
    walk(this.world.scene);
    this.collected = this.chunks.length > 0;
  }

  update(delta: number): void {
    this.acc += delta;
    if (this.acc < 0.25) return;
    this.acc = 0;
    if (!this.collected) {
      this.collect();
      if (!this.collected) return;
    }
    this.player.getWorldPosition(this.tmp);
    this.px = this.tmp.x;
    this.pz = this.tmp.z;
    const low = lodState.scale < 1;
    const open = atmosphere.open;
    const cap = viewCap(open);
    // Mountain-side content is only drawn near the player while the view is still the jungle's (dense, short): it is hidden behind the trees anyway.
    const mtnCap = 26 + 974 * open;
    // The giant fall: full detail within FALL_NEAR m, the two main sheets beyond; its mist only within MIST_RANGE m (and never in the low tier).
    if (this.fallNear && this.fallFar) {
      const [fx, fz] = FALL_CENTER;
      const d = Math.hypot(this.px - fx, this.pz - fz);
      const near = d < FALL_NEAR + (this.fallNear.visible ? 20 : -20);
      if (this.fallNear.visible !== near) this.fallNear.visible = near;
      if (this.fallFar.visible === near) this.fallFar.visible = !near;
    }
    if (this.mist) {
      const [fx, fz] = FALL_CENTER;
      const show = !low && Math.hypot(this.px - fx, this.pz - fz) < MIST_RANGE;
      if (this.mist.visible !== show) this.mist.visible = show;
    }
    for (const r of this.ridges) if (r.visible !== open < 0.5) r.visible = open < 0.5;
    for (const t of this.landmarks) {
      const dx = Math.max(t.box.min.x - this.px, 0, this.px - t.box.max.x);
      const dz = Math.max(t.box.min.z - this.pz, 0, this.pz - t.box.max.z);
      const show = Math.hypot(dx, dz) <= JUNGLE_LANDMARK_CAP;
      if (t.obj.visible !== show) t.obj.visible = show;
    }
    for (const t of this.mtnLandmarks) {
      const dx = Math.max(t.box.min.x - this.px, 0, this.px - t.box.max.x);
      const dz = Math.max(t.box.min.z - this.pz, 0, this.pz - t.box.max.z);
      const d = Math.hypot(dx, dz);
      const show = t.obj.visible ? d <= mtnCap + 10 : d <= mtnCap;
      if (t.obj.visible !== show) t.obj.visible = show;
    }
    for (const f of this.far) if (f.visible !== open > 0.25) f.visible = open > 0.25;
    // Terrain LOD: a detailed 96 m root cell draws its fine tiles near the player and one coarse mesh farther away (collision is unaffected).
    const fineR = low ? TERRAIN_LOD.fineLow : TERRAIN_LOD.fine;
    let nFine = 0;
    let nCoarse = 0;
    for (const r of this.roots.values()) {
      const dx = Math.max(r.x0 - this.px, 0, this.px - (r.x0 + TERRAIN_LOD.size));
      const dz = Math.max(r.z0 - this.pz, 0, this.pz - (r.z0 + TERRAIN_LOD.size));
      const d = Math.hypot(dx, dz);
      r.near = r.coarse ? (r.near ? d < fineR + TERRAIN_LOD.hysteresis : d < fineR - TERRAIN_LOD.hysteresis) : true;
      const inRange = d <= mtnCap;
      for (const f of r.fine) if (f.visible !== (r.near && inRange)) f.visible = r.near && inRange;
      if (r.coarse && r.coarse.visible !== (!r.near && inRange)) r.coarse.visible = !r.near && inRange;
      if (inRange) r.near ? nFine++ : nCoarse++;
    }
    lodInfo.fineRoots = nFine;
    lodInfo.coarseRoots = nCoarse;
    for (const t of this.tiles) {
      const dx = Math.max(t.box.min.x - this.px, 0, this.px - t.box.max.x);
      const dz = Math.max(t.box.min.z - this.pz, 0, this.pz - t.box.max.z);
      const show = Math.hypot(dx, dz) <= mtnCap;
      if (t.obj.visible !== show) t.obj.visible = show;
    }
    let shown = 0;
    for (const c of this.chunks) {
      const d = cellDistance(this.px, this.pz, c.ix, c.iz, CELL_SIZE[c.cls]);
      const mountainCell = CHUNK_ORIGIN.x + c.ix * CELL_SIZE[c.cls] >= 30;
      const show = chunkVisible(c.cls, d, low, mountainCell ? Math.min(cap, mtnCap) : Math.min(cap, JUNGLE_CELL_CAP), c.obj.visible);
      if (c.obj.visible !== show) c.obj.visible = show;
      if (show) shown++;
    }
    chunkStats.shown = shown;
    chunkStats.total = this.chunks.length;
    metrics.cellsShown = shown;
  }
}

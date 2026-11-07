import { createSystem, Vector3 } from '@iwsdk/core';
import type { Object3D } from '@iwsdk/core';
import { cellDistance, chunkVisible } from '../world/layout.js';
import type { ChunkClass } from '../world/layout.js';
import { lodState } from '../settings/quality.js';
import { metrics } from '../diagnostics/frame-metrics.js';

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
 * detailed trees within 46 m, the cheap tree version beyond 30 m, small plants within
 * 58 m, ground-cover patches within 36 m. Frustum culling then happens per visible cell
 * inside three.js. The 'low' quality tier scales the distances down (lodState.scale).
 * Allocation-free in update().
 */
/** Last result, read by DebugSystem: cells shown / total. */
export const chunkStats = { shown: 0, total: 0 };

export class ChunkLodSystem extends createSystem({}) {
  private chunks: Chunk[] = [];
  private acc = 1;
  private collected = false;
  private px = 0;
  private pz = 0;
  private readonly tmp = new Vector3();

  private collect(): void {
    const walk = (o: Object3D) => {
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
    let shown = 0;
    for (const c of this.chunks) {
      const d = cellDistance(this.px, this.pz, c.ix, c.iz);
      const show = chunkVisible(c.cls, d, low);
      if (c.obj.visible !== show) c.obj.visible = show;
      if (show) shown++;
    }
    chunkStats.shown = shown;
    chunkStats.total = this.chunks.length;
    metrics.cellsShown = shown;
  }
}

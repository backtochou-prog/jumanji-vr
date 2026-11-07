import { createSystem } from '@iwsdk/core';
import type { Material, Mesh, Texture } from '@iwsdk/core';
import { ScrollTexture, Shimmer } from '../components/jungle-components.js';
import { lightShaftMaterial } from '../scene-assets/lib/materials.js';

interface Scroll {
  u: number;
  v: number;
}

/**
 * Scrolls water textures. Materials/textures are shared between instances, so
 * speeds are tracked per texture (not per entity) to avoid double-speed scrolling.
 */
export class WaterSystem extends createSystem({
  scrollers: { required: [ScrollTexture] },
}) {
  private textures = new Map<Texture, Scroll>();

  init(): void {
    this.cleanupFuncs.push(
      this.queries.scrollers.subscribe('qualify', (entity) => {
        const u = entity.getValue(ScrollTexture, 'speedU') ?? 0;
        const v = entity.getValue(ScrollTexture, 'speedV') ?? 0;
        entity.object3D?.traverse((child) => {
          const mesh = child as Mesh;
          if (!mesh.isMesh) return;
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats as (Material & { map?: Texture | null; emissiveMap?: Texture | null; bumpMap?: Texture | null })[]) {
            for (const tex of [m.map, m.emissiveMap, m.bumpMap]) if (tex) this.textures.set(tex, { u, v });
          }
        });
      }),
    );
  }

  update(delta: number): void {
    for (const [tex, s] of this.textures) {
      tex.offset.x = (tex.offset.x + s.u * delta) % 1;
      tex.offset.y = (tex.offset.y + s.v * delta) % 1;
    }
  }
}

/** Slow breathing of the shared light-shaft material. */
export class ShimmerSystem extends createSystem({
  shimmers: { required: [Shimmer] },
}) {
  update(_delta: number, time: number): void {
    let speed = 0.35;
    let amount = 0.18;
    for (const e of this.queries.shimmers.entities) {
      speed = e.getValue(Shimmer, 'speed') ?? speed;
      amount = e.getValue(Shimmer, 'amount') ?? amount;
      break;
    }
    lightShaftMaterial.opacity = 1 - amount * 0.5 + amount * 0.5 * Math.sin(time * speed * Math.PI * 2);
  }
}

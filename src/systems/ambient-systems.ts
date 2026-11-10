import { createSystem } from '@iwsdk/core';
import type { Material, Mesh, Texture } from '@iwsdk/core';
import { ScrollTexture, Shimmer } from '../components/jungle-components.js';
import { lightShaftUniforms, waterClock, waterDetail } from '../scene-assets/lib/materials.js';
import { qualityState } from '../settings/quality.js';
import { loadComfort } from '../settings/comfort.js';

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
  /** The backdrop fall's spray (named 'Waterfall mist'): additive, so the 'low' tier drops it. */
  private sprays: Mesh[] = [];

  init(): void {
    this.cleanupFuncs.push(
      this.queries.scrollers.subscribe('qualify', (entity) => {
        const u = entity.getValue(ScrollTexture, 'speedU') ?? 0;
        const v = entity.getValue(ScrollTexture, 'speedV') ?? 0;
        entity.object3D?.traverse((child) => {
          const mesh = child as Mesh;
          if (!mesh.isMesh) return;
          if (mesh.name === 'Waterfall mist' && !this.sprays.includes(mesh)) this.sprays.push(mesh);
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
    // The clock of the falling-water shader (its streak layers and foam pulse). Wrapped at 1024 s; the shader's speeds make that seamless.
    waterClock.value = (waterClock.value + delta) % 1024;
    const low = qualityState.tier === 'low';
    waterDetail.value = low ? 0 : 1;
    for (const m of this.sprays) if (m.visible === low) m.visible = !low;
  }
}

/**
 * Drives the LIVING light shafts / mist banks: it only advances two uniforms of the shared light-shaft material (see 'light-shaft-v2' in
 * scene-assets/lib/materials.ts). The brightness breathing and the tip drift happen in the vertex shader with a phase that depends on the world
 * position, so beams and mist banks never pulse in lockstep; nothing here touches opacity or allocates. With reduced motion the time stops
 * (a still, slightly mottled light) instead of moving.
 */
export class ShimmerSystem extends createSystem({
  shimmers: { required: [Shimmer] },
}) {
  private reduced = false;

  init(): void {
    this.reduced = loadComfort().reducedMotion;
  }

  update(_delta: number, time: number): void {
    let speed = 0.3;
    let amount = 0.22;
    for (const e of this.queries.shimmers.entities) {
      speed = e.getValue(Shimmer, 'speed') ?? speed;
      amount = e.getValue(Shimmer, 'amount') ?? amount;
      break;
    }
    // the authored speed 0.3 is the reference rate of the shader's phases
    lightShaftUniforms.time.value = this.reduced ? 0 : time * (speed / 0.3);
    lightShaftUniforms.breath.value = amount;
  }
}

import { Color, createSystem, DomeGradient, FogExp2, Vector3 } from '@iwsdk/core';
import { MZ } from '../world/mountain.js';
import { JUNGLE_FAR, smoothstep } from '../world/layout.js';

/**
 * Height-dependent atmosphere. In the jungle the view is short and wet (dense fog, far plane JUNGLE_FAR = 260 m: by then the
 * fog hides 91 % of the world). Up on the mountain the view opens to hundreds of metres, so the fog thins
 * and the camera far plane grows enough to reach the distant mountain layers. Both follow the player's height
 * above the jungle floor, smoothed, so there is no pop. The far plane only grows where the view is really open,
 * so the jungle's draw cost depends on the LOD caps, not on the far plane.
 * Reduced-motion/quality settings do not change this (fog is static, no motion).
 */
/** Depth range: near 0.1 m (iwsdk.config.json), far JUNGLE_FAR in the jungle up to 1 km on the mountain. */
export const atmosphere = { open: 0, far: JUNGLE_FAR, density: 0.0095 };

const FOG_JUNGLE = 0.0095;
const FOG_SUMMIT = 0.0036;

const FOG_COLOR_JUNGLE = new Color('#a9c4b3');
const FOG_COLOR_OPEN = new Color('#b4cbd0'); // a touch bluer and brighter: valley haze
const SKY_JUNGLE = [0.3, 0.55, 0.58];
const SKY_OPEN = [0.3, 0.58, 0.86];

export class AtmosphereSystem extends createSystem({ dome: { required: [DomeGradient] } }) {
  private readonly p = new Vector3();
  private fogBase = FOG_JUNGLE;

  private acc = 0;
  private lastOpen = -1;

  update(delta: number): void {
    // `open` eases every frame (cheap, a few flops) but the scene is only touched at 4 Hz and only when it really changed:
    // writing the dome gradient fires ECS change handlers, and a camera far-plane change updates the XR render state.
    this.player.getWorldPosition(this.p);
    const target = this.p.x > MZ.x0 - 4 ? smoothstep(3, 12, this.p.y) : 0;
    atmosphere.open += (target - atmosphere.open) * (1 - Math.exp(-delta * 1.2));
    this.acc += delta;
    if (this.acc < 0.25) return;
    this.acc = 0;
    if (Math.abs(atmosphere.open - this.lastOpen) < 0.004) return;
    this.lastOpen = atmosphere.open;
    const scene = this.world.scene;
    const fog = scene.fog as FogExp2 | null;
    if (fog && !('density' in fog)) return;
    if (fog) {
      if (this.fogBase === FOG_JUNGLE && fog.density > 0 && Math.abs(fog.density - FOG_JUNGLE) > 1e-3 && atmosphere.open === 0) this.fogBase = fog.density;
      atmosphere.density = this.fogBase + (FOG_SUMMIT - this.fogBase) * atmosphere.open;
      fog.density = atmosphere.density;
      fog.color.copy(FOG_COLOR_JUNGLE).lerp(FOG_COLOR_OPEN, atmosphere.open);
    }
    for (const e of this.queries.dome.entities) {
      const sky = e.getVectorView(DomeGradient, 'sky') as Float32Array;
      const eq = e.getVectorView(DomeGradient, 'equator') as Float32Array;
      for (let i = 0; i < 3; i++) sky[i] = SKY_JUNGLE[i] + (SKY_OPEN[i] - SKY_JUNGLE[i]) * atmosphere.open;
      // The horizon band always matches the fog, so distant fogged ground fades into the sky without a seam.
      if (fog) {
        eq[0] = fog.color.r;
        eq[1] = fog.color.g;
        eq[2] = fog.color.b;
      }
      e.setValue(DomeGradient, 'elevationDeg', 32 + 40 * atmosphere.open);
    }
    // Far plane in 25 m steps (each change touches the projection / XR depth range).
    const far = Math.round((JUNGLE_FAR + (1000 - JUNGLE_FAR) * atmosphere.open) / 25) * 25;
    if (far !== this.world.camera.far) {
      atmosphere.far = far;
      this.world.camera.far = far;
      this.world.camera.updateProjectionMatrix();
    }
  }
}

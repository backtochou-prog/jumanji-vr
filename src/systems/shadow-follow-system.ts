import { createSystem, DirectionalLightComponent, Vector3 } from '@iwsdk/core';
import type { DirectionalLight, Object3D } from '@iwsdk/core';
import { SUN_DIR } from '../world/palette.js';

/** Snap step in LIGHT space (m). The shadow map is 1024 px over 8-16 m, so 0.5 m is a whole number (32-64) of texels. */
const SNAP = 0.5;

/**
 * Keeps the single real-time shadow where the player is.
 * The sun's shadow camera covers only a small window (see the `sun` node in the scene);
 * instead of one huge cascade, the sun node trails the player along the sun direction. Casters (temple, spire, altar,
 * pillars, the Heartstone in hand) get shadows wherever the player stands, for the cost
 * of one small map. Baked vertex AO handles the rest of the forest.
 *
 * Texel-stable: the follow position is snapped on the light's own right/up axes (not world x/z). A world-aligned 1 m grid is NOT a whole
 * number of texels along the tilted light axes, so every snap re-sampled the whole map at a different sub-texel phase and all shadow edges
 * shimmered at once; snapped in light space the map content only ever moves by whole texels.
 */
export class ShadowFollowSystem extends createSystem({
  suns: { required: [DirectionalLightComponent] },
}) {
  private p = new Vector3();
  private lastA = NaN;
  private lastB = NaN;
  private readonly dir = new Vector3(SUN_DIR[0], SUN_DIR[1], SUN_DIR[2]).normalize();
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly target = new Vector3();
  private readonly before = new Vector3();
  private readonly after = new Vector3();
  private readonly offset = new Vector3(-SUN_DIR[0], -SUN_DIR[1], -SUN_DIR[2]).multiplyScalar(40);

  init(): void {
    // light-space basis: right = dir x worldUp, up = right x dir
    this.right.set(0, 1, 0).cross(this.dir).normalize();
    this.up.copy(this.dir).cross(this.right).normalize();
  }

  update(): void {
    this.player.getWorldPosition(this.p);
    const a = Math.round(this.p.dot(this.right) / SNAP);
    const b = Math.round(this.p.dot(this.up) / SNAP);
    if (a === this.lastA && b === this.lastB) return;
    this.lastA = a;
    this.lastB = b;
    // anchor = the player's position with its light-plane coordinates snapped (the along-light coordinate does not affect texels)
    const c = this.p.dot(this.dir);
    this.target.set(0, 0, 0).addScaledVector(this.right, a * SNAP).addScaledVector(this.up, b * SNAP).addScaledVector(this.dir, c);
    for (const e of this.queries.suns.entities) {
      const o = e.object3D;
      if (!o) continue;
      o.getWorldPosition(this.before);
      o.position.set(this.target.x + this.offset.x, this.target.y + this.offset.y, this.target.z + this.offset.z);
      o.updateWorldMatrix(true, true);
      o.getWorldPosition(this.after);
      this.after.sub(this.before);
      // Move the light's aim point by the same step, NOW. The SDK's light system places the aim point 1 m in front of the light once per frame,
      // before this system runs; without this the light had already moved (up to several metres on a teleport, 0.5 m on every snap while walking)
      // while its aim point was still at the old place, so for one frame the sun shone from a direction up to 30 degrees (walking) or completely
      // (teleport) wrong: the whole world and the shadow flashed.
      for (const child of o.children as Object3D[]) {
        const light = child as DirectionalLight;
        if (!light.isDirectionalLight) continue;
        light.target.position.add(this.after);
        light.target.updateMatrixWorld(true);
      }
    }
  }
}

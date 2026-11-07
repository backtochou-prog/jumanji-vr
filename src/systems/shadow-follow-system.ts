import { createSystem, DirectionalLightComponent, Vector3 } from '@iwsdk/core';
import { SUN_DIR } from '../world/palette.js';

/**
 * Keeps the single real-time shadow where the player is.
 * The sun's shadow camera covers only a small window (see the `sun` node in the scene);
 * instead of one huge cascade, the sun node trails the player along the sun direction,
 * snapped to a 1 m grid so shadow edges do not swim. Casters (temple, spire, altar,
 * pillars, the Heartstone in hand) get shadows wherever the player stands, for the cost
 * of one small map. Baked vertex AO handles the rest of the forest.
 */
export class ShadowFollowSystem extends createSystem({
  suns: { required: [DirectionalLightComponent] },
}) {
  private p = new Vector3();
  private lastX = NaN;
  private lastZ = NaN;
  private readonly offset = new Vector3(-SUN_DIR[0], -SUN_DIR[1], -SUN_DIR[2]).multiplyScalar(40);

  update(): void {
    this.player.getWorldPosition(this.p);
    const x = Math.round(this.p.x);
    const z = Math.round(this.p.z);
    if (x === this.lastX && z === this.lastZ) return;
    this.lastX = x;
    this.lastZ = z;
    for (const e of this.queries.suns.entities) {
      const o = e.object3D;
      if (o) o.position.set(x + this.offset.x, this.p.y + this.offset.y, z + this.offset.z);
    }
  }
}

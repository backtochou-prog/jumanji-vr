import { createSystem, LocomotionSystem, Vector3 } from '@iwsdk/core';
import { MTN } from '../world/layout.js';
import { routeNear } from '../world/mountain.js';
import { pulse } from './haptics.js';

/**
 * Fall recovery. The route is fenced by invisible guard walls and the walking surfaces are validated, so the
 * player should never leave it; this is the net under that. While standing on the route the last firm position
 * is remembered (every 0.4 s). If the player is ever found far below the route (more than 6.5 m under its nearest
 * point) or below the world, they are put back at the last firm position, with a haptic tick, and it is logged.
 * It moves the rig only (never rotates the camera) and cannot fire while the collapse shelf carries the player
 * (the shelf sinks 2.35 m, inside the margin).
 */
export const safety = { recoveries: 0, lastSafe: new Vector3(), has: false };

export class SafetySystem extends createSystem({}) {
  private readonly p = new Vector3();
  private acc = 0;

  update(delta: number): void {
    this.acc += delta;
    if (this.acc < 0.4) return;
    this.acc = 0;
    this.player.getWorldPosition(this.p);
    if (!Number.isFinite(this.p.y)) return;
    const h = routeNear(MTN, this.p.x, this.p.z);
    const firm = h.dist < h.hw + 0.7 && Math.abs(this.p.y - h.y) < 0.9;
    if (firm) {
      safety.lastSafe.copy(this.p);
      safety.has = true;
      return;
    }
    const fell = (h.dist < 45 && this.p.y < h.y - 6.5) || this.p.y < -150;
    if (fell && safety.has) {
      safety.recoveries++;
      console.warn(`[jumanji:safety] below the route at (${this.p.x.toFixed(1)}, ${this.p.y.toFixed(1)}, ${this.p.z.toFixed(1)}): back to the last firm ground`);
      this.world.getSystem(LocomotionSystem)?.setPlayerPosition(safety.lastSafe);
      pulse(this.world, 'both', 0.4, 90);
    }
  }
}

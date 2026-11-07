import { createSystem, Euler, Grabbed, GrabSystem, Quaternion } from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import { Relic, RelicState } from '../components/jungle-components.js';
import { relicGemMaterial } from '../scene-assets/lib/materials.js';
import { ALTAR, ALTAR_TOP_Y, terrainHeight } from '../world/layout.js';

const GRAVITY = 9.8;
const GEM_BASE = 1.6;
/** Half-extent of the altar's top slab (m): the relic can rest on it. */
const ALTAR_HALF = 0.55;

/**
 * Heartstone behaviour (physics is disabled project-wide, so this is a tiny
 * dedicated "settle" rule instead of a rigid-body engine):
 *   - while held (GrabSystem adds `Grabbed`): glow up + a haptic tick on grab
 *   - on release: fall under gravity, level out, rest on the altar or the ground
 *   - at rest: gentle breathing glow
 * Never leaves the relic floating where it was let go.
 */
export class RelicSystem extends createSystem({
  relics: { required: [Relic] },
  held: { required: [Relic, Grabbed] },
}) {
  private yawOnly = new Quaternion();
  private euler = new Euler();
  private altarTop = 0;

  init(): void {
    this.altarTop = terrainHeight(ALTAR[0], ALTAR[1]) + ALTAR_TOP_Y;
    this.cleanupFuncs.push(
      this.queries.held.subscribe('qualify', (entity: Entity) => {
        entity.setValue(Relic, 'state', RelicState.Held);
        entity.setValue(Relic, 'velocityY', 0);
        this.pulse(entity);
      }),
      this.queries.held.subscribe('disqualify', (entity: Entity) => {
        entity.setValue(Relic, 'state', RelicState.Falling);
        entity.setValue(Relic, 'velocityY', 0);
      }),
    );
  }

  /** Short haptic tick on the holding controller, if the browser exposes an actuator. */
  private pulse(entity: Entity): void {
    const hand = this.world.getSystem(GrabSystem)?.getHolderHand(entity);
    if (!hand) return;
    const pad = this.input.xr.gamepads[hand]?.gamepad as unknown as { hapticActuators?: { pulse?: (v: number, ms: number) => void }[] } | undefined;
    pad?.hapticActuators?.[0]?.pulse?.(0.45, 60);
  }

  private surfaceAt(x: number, z: number): number {
    if (Math.abs(x - ALTAR[0]) < ALTAR_HALF && Math.abs(z - ALTAR[1]) < ALTAR_HALF) return this.altarTop;
    return terrainHeight(x, z);
  }

  update(delta: number, time: number): void {
    let glow = 0;
    for (const entity of this.queries.relics.entities) {
      const obj = entity.object3D;
      if (!obj) continue;
      const state = entity.getValue(Relic, 'state');
      glow = entity.getValue(Relic, 'glow') ?? 0;
      const target = state === RelicState.Held ? 1 : 0;
      glow += (target - glow) * Math.min(1, delta * 5);
      entity.setValue(Relic, 'glow', glow);

      if (state !== RelicState.Falling) continue;
      let vy = (entity.getValue(Relic, 'velocityY') ?? 0) - GRAVITY * delta;
      vy = Math.max(vy, -12);
      obj.position.y += vy * delta;
      // Level out (keep heading, remove tilt) while falling.
      this.euler.setFromQuaternion(obj.quaternion, 'YXZ');
      this.yawOnly.setFromEuler(this.euler.set(0, this.euler.y, 0, 'YXZ'));
      obj.quaternion.slerp(this.yawOnly, Math.min(1, delta * 7));
      const floor = this.surfaceAt(obj.position.x, obj.position.z) + (entity.getValue(Relic, 'restOffset') ?? 0.03);
      if (obj.position.y <= floor) {
        obj.position.y = floor;
        obj.quaternion.copy(this.yawOnly);
        entity.setValue(Relic, 'state', RelicState.Resting);
        vy = 0;
      }
      entity.setValue(Relic, 'velocityY', vy);
    }
    // One relic in the world: drive the shared gem material.
    relicGemMaterial.emissiveIntensity = GEM_BASE + glow * 1.4 + 0.18 * Math.sin(time * 1.8);
  }
}

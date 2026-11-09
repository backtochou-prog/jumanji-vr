import { createSystem, LocomotionSystem, Quaternion, Vector3, VisibilityState } from '@iwsdk/core';
import { MTN } from '../world/layout.js';
import { PLATFORM, TERRACE, routeNear } from '../world/mountain.js';
import { SEATED_OFFSET, loadComfort } from '../settings/comfort.js';

/**
 * Comfort options that need a hook into the locomotion engine or the XR session:
 *   moveReference 'hand'   the left thumbstick moves you where the LEFT CONTROLLER points (yaw only), not where you
 *                          look: head turns never steer the body. Falls back to the head when the controller is not tracked.
 *   seated                 raises the view by SEATED_OFFSET (0.4 m) through an XR reference-space offset, so a seated
 *                          player's eyes sit at standing height. The offset is visual only (collision is unchanged).
 *   reducedMotion          read by the bridge and the collapse event (no sway, no tremor), and the vignette is kept >= 50 %.
 * Settings are read live from storage each time the board changes them (the board calls refresh()).
 * Nothing here rotates the camera or the player. Quest Browser behaviour of the reference-space offset is unverified.
 */
export const comfortRuntime = { moveReference: 'head' as 'head' | 'hand', seatedApplied: false, patched: false, speedScale: 1 };

/** Walking-speed multiplier for where the player stands (1 = no hazard). */
const HAZARD_SCALE: Record<string, number> = { bridge: 0.6, cleft: 0.7, gully: 0.75, ledge: 0.85, approach: 0.85 };

export class ComfortSystem extends createSystem({}) {
  init(): void {
    (window as unknown as { __jumanjiComfort?: unknown }).__jumanjiComfort = comfortRuntime;
  }

  private readonly fwd = new Vector3();
  private readonly axis = new Vector3(0, 1, 0);
  private acc = 0;
  private seatedWas = false;
  private hz = 0;
  private cfg = loadComfort();

  update(delta: number): void {
    this.hz += delta;
    if (this.hz >= 0.1) this.hazard(this.hz);
    this.acc += delta;
    if (this.acc < 0.5) return;
    this.acc = 0;
    const c = (this.cfg = loadComfort());
    comfortRuntime.moveReference = c.moveReference;
    if (!comfortRuntime.patched) this.patchInput();
    const loco = this.world.getSystem(LocomotionSystem);
    const slide = (loco as unknown as { slideSystem?: { config: { comfortAssist: { value: number } } } } | undefined)?.slideSystem;
    if (c.reducedMotion && slide && slide.config.comfortAssist.value < 0.5) slide.config.comfortAssist.value = 0.5;
    this.applySeated(c.seated);
  }

  /**
   * Hazard assist: ease the walking speed down (never abruptly) while on the bridge, the steep descent, the collapse ledge, a cliff
   * ledge, and within 3 m of the summit or terrace edge; ease back up afterwards. Only the speed limit changes: no camera or body motion.
   */
  private hazard(dt: number): void {
    this.hz = 0;
    const c = this.cfg;
    const slide = (this.world.getSystem(LocomotionSystem) as unknown as { slideSystem?: { config: { maxSpeed: { value: number } } } } | undefined)?.slideSystem;
    if (!slide) return;
    this.player.getWorldPosition(this.p);
    let target = 1;
    if (c.hazardAssist) {
      const h = routeNear(MTN, this.p.x, this.p.z);
      if (h.dist < h.hw + 2.5 && Math.abs(this.p.y - h.y) < 5) target = HAZARD_SCALE[h.zone] ?? 1;
      for (const [cx, cz, r, y] of [[PLATFORM.x, PLATFORM.z, PLATFORM.r, PLATFORM.y], [TERRACE.x, TERRACE.z, TERRACE.r, TERRACE.y]] as const) {
        if (Math.abs(this.p.y - y) < 3 && Math.hypot(this.p.x - cx, this.p.z - cz) > r - 3.2 && Math.hypot(this.p.x - cx, this.p.z - cz) < r + 1) target = Math.min(target, 0.7);
      }
    }
    comfortRuntime.speedScale += (target - comfortRuntime.speedScale) * Math.min(1, dt * 2.5);
    if (Math.abs(comfortRuntime.speedScale - 1) < 0.004) comfortRuntime.speedScale = 1;
    slide.config.maxSpeed.value = c.walkSpeed * comfortRuntime.speedScale;
  }

  private readonly p = new Vector3();

  private patchInput(): void {
    const loco = this.world.getSystem(LocomotionSystem) as unknown as { inputProvider?: { getMovementReferenceQuaternion: (out: Quaternion) => Quaternion } } | undefined;
    const ip = loco?.inputProvider;
    if (!ip) return;
    const original = ip.getMovementReferenceQuaternion.bind(ip);
    const space = () => this.world.player.raySpaces.left;
    ip.getMovementReferenceQuaternion = (out: Quaternion): Quaternion => {
      if (comfortRuntime.moveReference === 'hand' && this.world.session) {
        const s = space();
        if (s) {
          s.getWorldDirection(this.fwd);
          this.fwd.y = 0;
          if (this.fwd.lengthSq() > 1e-4) {
            this.fwd.normalize();
            // yaw such that local -Z maps onto the controller's flattened forward
            return out.setFromAxisAngle(this.axis, Math.atan2(-this.fwd.x, -this.fwd.z));
          }
        }
      }
      return original(out);
    };
    comfortRuntime.patched = true;
  }

  private applySeated(on: boolean): void {
    if (on === this.seatedWas && comfortRuntime.seatedApplied === on) return;
    this.seatedWas = on;
    if (this.world.visibilityState.peek() !== VisibilityState.Visible) return;
    const xr = this.world.renderer.xr;
    const ref = xr.getReferenceSpace?.() as (XRReferenceSpace & { __seatedBase?: XRReferenceSpace }) | null;
    if (!ref) return;
    const base = ref.__seatedBase ?? ref;
    const next = (on ? base.getOffsetReferenceSpace(new XRRigidTransform({ x: 0, y: -SEATED_OFFSET, z: 0 })) : base) as XRReferenceSpace & { __seatedBase?: XRReferenceSpace };
    next.__seatedBase = base;
    xr.setReferenceSpace(next);
    comfortRuntime.seatedApplied = on;
  }
}

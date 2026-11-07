import { createSystem, Euler, Vector3 } from '@iwsdk/core';
import { chunkStats } from './chunk-lod-system.js';
import { metrics } from '../diagnostics/frame-metrics.js';

/**
 * Opt-in telemetry: add `?debug` to the URL. Every ~2 s it logs the player's
 * position, smoothed FPS, draw calls and triangle count to the console - which
 * you can read on a headset through `chrome://inspect` (adb) or the dev log.
 * It does nothing (and allocates nothing) when the flag is absent.
 */
export class DebugSystem extends createSystem({}) {
  private enabled = false;
  private acc = 0;
  private frames = 0;
  private pos = new Vector3();
  private look = new Euler();
  private fwd = new Vector3();

  init(): void {
    this.enabled = new URLSearchParams(globalThis.location?.search ?? '').has('debug') || import.meta.env.VITE_JUMANJI_DEBUG === '1';
  }

  update(delta: number): void {
    if (!this.enabled) return;
    this.acc += delta;
    this.frames++;
    if (this.acc < 2) return;
    this.player.getWorldPosition(this.pos);
    const info = this.world.renderer.info.render;
    // Heading from the forward vector (unambiguous beyond +-90 degrees, unlike Euler y).
    this.fwd.set(0, 0, -1).applyQuaternion(this.player.quaternion);
    const yaw = (Math.atan2(-this.fwd.x, -this.fwd.z) * 180) / Math.PI;
    this.look.setFromQuaternion(this.world.camera.quaternion, 'YXZ');
    console.info(
      `[jumanji:debug] player=(${this.pos.x.toFixed(2)}, ${this.pos.y.toFixed(2)}, ${this.pos.z.toFixed(2)}) yaw=${yaw.toFixed(0)} camYaw=${((this.look.y * 180) / Math.PI).toFixed(0)} camPitch=${((this.look.x * 180) / Math.PI).toFixed(0)} fps=${(this.frames / this.acc).toFixed(1)} frame=${metrics.summary(2000).meanMs.toFixed(1)}ms p95=${metrics.summary(2000).p95Ms.toFixed(1)} cpu=${metrics.summary(2000).updateMs.toFixed(1)}+${metrics.summary(2000).renderMs.toFixed(1)} calls=${info.calls} tris=${info.triangles} cells=${chunkStats.shown}/${chunkStats.total}`,
    );
    this.acc = 0;
    this.frames = 0;
  }
}

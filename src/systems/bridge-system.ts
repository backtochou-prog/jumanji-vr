import { createSystem, Object3D, Vector3 } from '@iwsdk/core';
import { BRIDGE, BRIDGE_LENGTH, bridgeDeckY } from '../world/mountain.js';
import { loadComfort } from '../settings/comfort.js';

/**
 * Subtle bridge movement. The bridge (visible ropes + planks) and its walkable collider (a KINEMATIC locomotion
 * environment) are moved together as one rigid body by a few millimetres: a slow lateral sway and a faint vertical
 * bob that grow a little while someone walks on it (largest at mid-span). Amplitudes: idle 1.5 mm; loaded up to
 * 12 mm sideways (0.45 Hz) and 6 mm vertically (0.9 Hz): peak acceleration ~0.1 m/s^2, below what a seated or
 * standing player perceives as motion sickness material, yet readable as a rope bridge. Reduced-motion: none at all.
 * The collider moves with the visuals, so what you see is what you stand on. `bridge.creaks` counts footfall-timed
 * creak events (a hook for audio later). No allocation in update().
 */
export const bridge = { onBridge: false, u: 0, load: 0, offsetX: 0, offsetY: 0, offsetZ: 0, creaks: 0 };

export class BridgeSystem extends createSystem({}) {
  private visual: Object3D | null = null;
  private collider: Object3D | null = null;
  private restV = new Vector3();
  private restC = new Vector3();
  private readonly p = new Vector3();
  private reduced = false;
  private lastCreak = 0;
  private phase = 0;

  init(): void {
    this.reduced = loadComfort().reducedMotion;
  }

  update(delta: number, time: number): void {
    if (!this.visual || !this.collider) {
      this.visual = this.world.scene.getObjectByName('Rope bridge') ?? this.world.scene.getObjectByName('RopeBridge') ?? null;
      this.collider = this.world.scene.getObjectByName('Bridge colliders') ?? this.world.scene.getObjectByName('BridgeColliders') ?? null;
      if (this.visual && this.collider) {
        this.restV.copy(this.visual.position);
        this.restC.copy(this.collider.position);
      }
      return;
    }
    this.player.getWorldPosition(this.p);
    // Far from the bridge nothing moves (and nothing is re-posted to the locomotion engine's kinematic state): rest pose.
    if (Math.abs(this.p.x - (BRIDGE.ax + BRIDGE_LENGTH / 2)) > 70 || Math.abs(this.p.z - BRIDGE.az) > 70) {
      if (bridge.offsetX !== 0 || bridge.offsetY !== 0 || bridge.offsetZ !== 0) {
        bridge.offsetX = bridge.offsetY = bridge.offsetZ = 0;
        bridge.load = 0;
        bridge.onBridge = false;
        this.visual.position.copy(this.restV);
        this.collider.position.copy(this.restC);
      }
      return;
    }
    const u = (this.p.x - BRIDGE.ax) / BRIDGE_LENGTH;
    const on = u > 0.01 && u < 0.99 && Math.abs(this.p.z - BRIDGE.az) < 1.6 && Math.abs(this.p.y - bridgeDeckY(Math.min(1, Math.max(0, u)))) < 1.5;
    bridge.onBridge = on;
    bridge.u = u;
    const target = on ? Math.sin(Math.PI * u) : 0;
    bridge.load += (target - bridge.load) * (1 - Math.exp(-delta * (target > bridge.load ? 1.5 : 0.6)));
    const k = this.reduced ? 0 : 0.12 + bridge.load;
    this.phase += delta;
    const ox = Math.sin(time * Math.PI * 2 * 0.45) * 0.012 * k;
    const oz = Math.sin(time * Math.PI * 2 * 0.37 + 1.3) * 0.006 * k;
    const oy = Math.sin(time * Math.PI * 2 * 0.9 + 0.4) * 0.006 * k;
    bridge.offsetX = ox;
    bridge.offsetY = oy;
    bridge.offsetZ = oz;
    // Footfall-timed creak events while walking on the bridge (audio hook).
    if (on && bridge.load > 0.25 && time - this.lastCreak > 0.62) {
      this.lastCreak = time;
      bridge.creaks++;
    }
    this.visual.position.set(this.restV.x + ox, this.restV.y + oy, this.restV.z + oz);
    this.collider.position.set(this.restC.x + ox, this.restC.y + oy, this.restC.z + oz);
  }
}

import { Color, InstancedMesh, Matrix4 } from '@iwsdk/core';
import type { BufferGeometry, Material } from '@iwsdk/core';

/**
 * One InstancedMesh holding every visible instance of one creature part (all birds' bodies of a species, all wing segments, ...).
 * The simulation writes only the instances that are active AND inside the view cone, in order, then `end()` sets the draw count:
 * zero instances = the mesh is hidden = no draw call. CPU-written matrices, no skinning, no per-creature draw call.
 *
 * `instanceColor` is allocated up front: three.js selects the shader program by whether it exists, and creating it later (the first
 * time a tinted instance appears) would compile a new program in the middle of the walk.
 */
export class InstanceRig {
  readonly mesh: InstancedMesh;
  n = 0;
  private readonly cap: number;
  private readonly colored: boolean;

  constructor(name: string, geometry: BufferGeometry, material: Material, capacity: number, colored = true) {
    this.cap = capacity;
    this.colored = colored;
    this.mesh = new InstancedMesh(geometry, material, capacity);
    this.mesh.name = name;
    this.mesh.frustumCulled = false; // the simulation culls by view cone itself; instance bounds would be stale
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
    if (colored) {
      const white = new Color(1, 1, 1);
      for (let i = 0; i < capacity; i++) this.mesh.setColorAt(i, white);
    }
  }

  begin(): void {
    this.n = 0;
  }

  /** Append one instance; returns false when the rig is full (the caller simply skips the rest). */
  push(m: Matrix4, color?: Color): boolean {
    if (this.n >= this.cap) return false;
    this.mesh.setMatrixAt(this.n, m);
    if (this.colored && color) this.mesh.setColorAt(this.n, color);
    this.n++;
    return true;
  }

  end(): void {
    const mesh = this.mesh;
    mesh.count = this.n;
    const show = this.n > 0;
    if (mesh.visible !== show) mesh.visible = show;
    if (!show) return;
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.addUpdateRange(0, this.n * 16);
    mesh.instanceMatrix.needsUpdate = true;
    if (this.colored && mesh.instanceColor) {
      mesh.instanceColor.clearUpdateRanges();
      mesh.instanceColor.addUpdateRange(0, this.n * 3);
      mesh.instanceColor.needsUpdate = true;
    }
  }
}

/** Reusable scratch objects for the simulation (no allocation inside update loops). */
export const scratchM = new Matrix4();

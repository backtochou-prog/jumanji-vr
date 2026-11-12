import { createSystem, LocomotionSystem, Vector3 } from '@iwsdk/core';
import { placePlayer } from '../diagnostics/perf-test.js';
import { ALTAR, EVEREST_VIEWS, FORD, MTN_VIEWS, SPAWN, SPAWN_YAW_DEG, terrainHeight } from '../world/layout.js';

/**
 * Jump-to-area shortcuts for testing (URL only; the normal start is the authored spawn: Everest's summit):
 *   ?area=entrance (= knoll: the old start, Overlook Knoll) | trail | clearing | altar     or   ?start=x,z   (+ &yaw=deg)
 *   ?area=everest | everest-north | everest-ridge | everest-snow | everest-clouds | everest-rock | everest-foot   (stations down Everest's trail)
 *   (the repeatable performance poses live in TEST_POSES and are used by ?test=, see diagnostics/perf-test.ts)
 * Handy on the headset: open the page with ?area=clearing to review the ancient
 * clearing without walking the whole trail. Applied once, as soon as locomotion is ready.
 */
export class StartPointSystem extends createSystem({}) {
  private done = false;
  private target: Vector3 | null = null;
  private yaw = 0;
  private y: number | undefined;
  private pitch: number | undefined;

  init(): void {
    const q = new URLSearchParams(globalThis.location?.search ?? '');
    let xz: [number, number] | null = null;
    const area = q.get('area');
    if (area === 'entrance' || area === 'knoll') {
      xz = [SPAWN[0], SPAWN[1]];
      if (!q.has('yaw')) this.yaw = SPAWN_YAW_DEG;
    }
    if (area === 'gate') xz = [0.3, 3];
    if (q.has('yaw')) this.yaw = Number(q.get('yaw')) || 0;
    if (area === 'trail') xz = [FORD.x + 1.2, FORD.z + 3.0];
    if (area === 'clearing') xz = [0, -52];
    if (area === 'altar') xz = [ALTAR[0], ALTAR[1] + 2.2];
    // Mountain stations: ?area=summit | summit-down | summit-fall | descent | ledge | cleft | bridge-west | bridge-mid | brink ...
    const mv = area ? (MTN_VIEWS[area] ?? EVEREST_VIEWS[area]) : undefined;
    if (mv) {
      xz = [mv.x, mv.z];
      this.yaw = mv.yawDeg;
      this.y = mv.y;
      this.pitch = mv.pitchDeg;
    }
    const s = q.get('start');
    if (s) {
      const [x, z] = s.split(',').map(Number);
      if (Number.isFinite(x) && Number.isFinite(z)) xz = [x, z];
    }
    if (xz) this.target = new Vector3(xz[0], this.y ?? terrainHeight(xz[0], xz[1]), xz[1]);
    else this.done = true;
  }

  update(): void {
    if (this.done || !this.target) return;
    const loco = this.world.getSystem(LocomotionSystem);
    if (!loco) return;
    placePlayer(this.world, this.target.x, this.target.z, this.yaw, this.y, this.pitch);
    this.done = true;
    console.info(`[jumanji] start point set to (${this.target.x.toFixed(1)}, ${this.target.y.toFixed(2)}, ${this.target.z.toFixed(1)})`);
  }
}

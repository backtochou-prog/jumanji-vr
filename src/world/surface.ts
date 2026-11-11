/**
 * What the player is standing on. Pure and deterministic (reads the same layout fields the terrain colours are baked from), so the sound of a
 * footstep always matches the ground that is drawn: wading at the ford and in the pool, mud in the hollows, stone on the temple floor and around
 * the altar, meadow grass on the knoll and in the clearing, leaf litter on the forest floor, planks on the rope bridge, bare rock on the mountain.
 * Called once per footstep (not per frame).
 */
import { ALTAR, MUD_PATCHES, POOL, TEMPLE, areaWeights, groundBlend, hillWeight, inMountainZone, nearestStream, streamWaterY } from './layout.js';
import { BRIDGE, bridgeDeckY } from './mountain.js';

export type Surface = 'water' | 'mud' | 'stone' | 'grass' | 'litter' | 'wood' | 'rock';
export const SURFACES: readonly Surface[] = ['water', 'mud', 'stone', 'grass', 'litter', 'wood', 'rock'];

/** Half-width (m) of the stream that counts as wading. */
const STREAM_HALF = 0.85;

/** Water surface height if (x, z) is in the pool or the stream, else null. */
export function waterLevelAt(x: number, z: number): number | null {
  if (x > 20) return null;
  if (Math.hypot(x - POOL.x, z - POOL.z) < POOL.r * 0.94) return POOL.waterY;
  const s = nearestStream(x, z);
  if (s.dist < STREAM_HALF) return streamWaterY(s.index);
  return null;
}

/**
 * Surface under a point. `feetY` (optional) is the height of the player's feet: with it, the bridge deck is only "wood" when the player is on it
 * (not far below it) and water only counts when the feet are at or under the surface.
 */
export function surfaceAt(x: number, z: number, feetY?: number): Surface {
  if (x >= BRIDGE.ax - 0.4 && x <= BRIDGE.bx + 0.4 && Math.abs(z - BRIDGE.az) < BRIDGE.halfWidth + 0.5) {
    const u = (x - BRIDGE.ax) / (BRIDGE.bx - BRIDGE.ax);
    if (feetY === undefined || Math.abs(feetY - bridgeDeckY(Math.min(1, Math.max(0, u)))) < 1.6) return 'wood';
  }
  if (inMountainZone(x, z, 1)) return 'rock';
  const wl = waterLevelAt(x, z);
  if (wl !== null && (feetY === undefined || feetY < wl + 0.06)) return 'water';
  if (Math.abs(x - TEMPLE.x) < TEMPLE.width * 0.5 && Math.abs(z - TEMPLE.z) < TEMPLE.depth * 0.5) return 'stone';
  if (Math.hypot(x - ALTAR[0], z - ALTAR[1]) < 2.4) return 'stone';
  for (const m of MUD_PATCHES) if (Math.hypot(x - m.x, z - m.z) < m.r * 0.9) return 'mud';
  if (hillWeight(x, z) > 0.45) return 'grass';
  const g = groundBlend(x, z);
  if (g.mud > 0.55) return 'mud';
  if (g.stone > 0.5) return 'stone';
  if (areaWeights(x, z).clearing > 0.6 || g.grass > g.litter + g.moss * 0.5) return 'grass';
  return 'litter';
}

/**
 * Shared per-frame state of the wildlife simulation (a singleton: one player, one world) and the hook the sound engine plugs into.
 * Written once per frame by WildlifeSystem, read by every species module, so none of them touches the scene graph or allocates.
 */
export type CallKind = 'macaw' | 'toucan' | 'parakeet' | 'songbird' | 'monkey-hoot' | 'monkey-whoop' | 'alarm';

/** What the wildlife asks of the sound engine. The default implementation does nothing (audio not started / disabled). */
export interface CallSink {
  /** An animal vocalises at a world position; `gain` 0..1 is its natural loudness. */
  call(kind: CallKind, x: number, y: number, z: number, gain: number): void;
  /** A sudden disturbance (birds flushing): the background chorus goes quiet for `seconds`, then recovers. */
  hush(seconds: number, strength: number): void;
  /** Foliage moving at a world position (optional: only the real sound engine has it). `snap` adds a twig crack. */
  rustle?(x: number, y: number, z: number, gain: number, snap?: boolean): void;
}

export const wctx = {
  time: 0,
  dt: 0.016,
  /** Head position (world). */
  px: 0,
  py: 1.65,
  pz: 0,
  /** Terrain height under the player. */
  gy: 0,
  /** Unit view direction (world). */
  fx: 0,
  fy: 0,
  fz: -1,
  /** cos(half the view cone): instances outside the cone are not drawn (the headset FOV is ~100 deg horizontal; 70 deg half-angle leaves margin for turning). */
  cosCone: Math.cos((72 * Math.PI) / 180),
  /** Smoothed horizontal walking speed (m/s). */
  speed: 0,
  /** Player is standing essentially still. */
  still: true,
  /** 0 = jungle floor .. 1 = open mountain: the east mountain's height or Everest's slopes (AtmosphereSystem's `open` / `peak`). */
  open: 0,
  /** 'low' quality tier. */
  low: false,
  /** Wildlife master switch (settings / URL). */
  enabled: true,
  audio: { call: () => {}, hush: () => {} } as CallSink,
  /**
   * The opening reveal (IntroSystem <-> Birds). 'off' = no reveal. 'hold' = the random crossing flocks wait. 'cross' = IntroSystem asks for the staged pair of
   * macaws to fly in front of the waterfall. 'done' = Birds flew it (or gave up) and the normal schedule resumes.
   */
  intro: 'off' as 'off' | 'hold' | 'cross' | 'done',
};

/** Is a sphere (centre x,y,z; radius r) inside the generous view cone? Cheap: one dot product. */
export function inCone(x: number, y: number, z: number, r = 1): boolean {
  const dx = x - wctx.px;
  const dy = y - wctx.py;
  const dz = z - wctx.pz;
  const d = Math.hypot(dx, dy, dz);
  if (d < r + 2) return true; // close to the head: always keep (a turn can bring it into view within a frame)
  return (dx * wctx.fx + dy * wctx.fy + dz * wctx.fz) / d > wctx.cosCone - r / d;
}

export const distToPlayer = (x: number, y: number, z: number): number => Math.hypot(x - wctx.px, y - wctx.py, z - wctx.pz);
/**
 * How threatening the player's closeness is to an animal in a tree: horizontal distance matters fully, height difference only half (a person standing
 * right under a branch 12 m up is a close threat, one 12 m away on the ground is a distant one).
 */
export const threatDist = (x: number, y: number, z: number): number => Math.hypot(x - wctx.px, z - wctx.pz, (y - wctx.py) * 0.5);
export const distToPlayerXZ = (x: number, z: number): number => Math.hypot(x - wctx.px, z - wctx.pz);

/** Stats for the diagnostics overlay and the tests. */
export const wildlifeStats = {
  active: { macaw: 0, toucan: 0, small: 0, monkeys: 0, butterflies: 0, dragonflies: 0, gnats: 0, fireflies: 0 },
  drawn: { birds: 0, monkeys: 0, butterflies: 0, dragonflies: 0 },
  flying: 0,
  perched: 0,
  crossingFlocks: 0,
  flushes: 0,
  leaps: 0,
  climbs: 0,
  retreats: 0,
  fleeEvents: 0,
  updateMs: 0,
};

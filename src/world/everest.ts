/**
 * "Everest": the great snow peak south of the Overlook Knoll, and THE START of the game (the player is born on its summit, above a sea of clouds,
 * and walks down a long spiral trail to the jungle).
 *
 * Pure and deterministic (no Three.js, DOM or SDK imports), like mountain.ts: used by layout.ts (terrain height, guards, zones), the terrain asset,
 * the collider asset, the atmosphere/everest systems and the tools.
 *
 * LANDFORM
 *   The peak is ADDED to the jungle hills: terrain = jungle height + everestRise(x, z). The rise is a smooth cone with a concave profile
 *   ((1 - u)^1.5: steep at the top, easing out at the foot), a rounded crown and three ridges (the radius is stretched by up to 25 % along
 *   three bearings). Rock relief (two noise octaves) is laid over it, calmed beside the trail so the bench stays readable.
 *
 * ROUTE
 *   A constant-grade trace (36 %, ~20 degrees) on the SMOOTH rise: at every step the trail leaves the fall line by the angle whose cosine is
 *   grade / slope, always to the same hand, so it winds once round the peak; where the ground is gentler than the grade (the crown, the foot)
 *   it runs straight down. The trace is made in a local frame; the whole massif is then turned so that the trail arrives at the knoll's back
 *   door heading north, and placed so that it lands on the knoll's own dirt trail.
 */
import { PolyIndex, fbm, lerp, smoothstep } from './math.ts';
import type { Vec2 } from './math.ts';
import { routeNear } from './mountain.ts';
import type { MtnRoute, RouteSample, TileSpec, Viewpoint } from './mountain.ts';

/** Rise of the summit above the jungle hills (m), foot radius of the cone between the ridges (m). */
const H = 212;
const R = 285;
/** Crown rounding (m): the top is a dome ~7 m across before the faces steepen. */
const CROWN = 22;
const RIDGES = 3;
const RIDGE_GAIN = 0.25;
/** Trail grade (rise / run) and the hand it always turns to. */
const GRADE = 0.36;
const HAND = 1;
/** Where the trail meets the knoll: it reaches the foot of the peak at FOOT, then runs straight north to the back of the knoll's walk disc. */
const FOOT: Vec2 = [-1.2, 60];
const JOIN_Z = 41;

/** Smooth rise in the local frame (summit at the origin, a ridge along +x). */
function riseLocal(lx: number, lz: number): number {
  const d = Math.hypot(lx, lz);
  if (d > (R + CROWN) * (1 + RIDGE_GAIN)) return 0;
  const c = 0.5 + 0.5 * Math.cos(RIDGES * Math.atan2(lz, lx));
  const k = RIDGE_GAIN * c * c * smoothstep(0, 60, d);
  const dd = d / (1 + k);
  const u = (Math.sqrt(dd * dd + CROWN * CROWN) - CROWN) / R;
  return u >= 1 ? 0 : H * Math.pow(1 - u, 1.5);
}

/** The constant-grade trace, in the local frame, one point per metre. */
function traceLocal(): Vec2[] {
  const pts: Vec2[] = [[0, 0]];
  let x = 0;
  let z = 0;
  let dx = 1;
  let dz = 0;
  const e = 0.75;
  for (let n = 0; n < 4000; n++) {
    if (n > 30 && riseLocal(x, z) < 1.0) break;
    const gx = (riseLocal(x + e, z) - riseLocal(x - e, z)) / (2 * e);
    const gz = (riseLocal(x, z + e) - riseLocal(x, z - e)) / (2 * e);
    const s = Math.hypot(gx, gz);
    if (s > 1e-3) {
      const ux = -gx / s;
      const uz = -gz / s;
      if (s > GRADE) {
        const c = GRADE / s;
        const sn = Math.sqrt(1 - c * c) * HAND;
        dx = ux * c - uz * sn;
        dz = ux * sn + uz * c;
      } else {
        dx = ux;
        dz = uz;
      }
    }
    x += dx;
    z += dz;
    pts.push([x, z]);
  }
  return pts;
}

const LOCAL = traceLocal();
const END = LOCAL[LOCAL.length - 1];
/** Rotation of the massif (local -> world): turns the trail's end bearing to north (-Z). */
const RHO = -Math.PI / 2 - Math.atan2(END[1], END[0]);
const COS = Math.cos(RHO);
const SIN = Math.sin(RHO);

/** The peak: summit position, heights, cloud deck. `y` values are filled in by layout.ts through `EV` once the jungle base is known. */
export const EVEREST = {
  x: FOOT[0],
  z: FOOT[1] + Math.hypot(END[0], END[1]),
  /** rise of the summit above the jungle hills (m) */
  h: H,
  /** outer reach of the landform from the summit axis (m): the rise is zero beyond it */
  reach: (R + CROWN) * (1 + RIDGE_GAIN),
  /** flat summit platform (m) */
  platform: 5,
  /** the cloud deck: absolute height (m) of the sea of clouds */
  deck: 104,
  /** snow line (absolute height, m): bare rock below, snow fields above */
  snow: 128,
  /** trail half width (m) */
  hw: 1.7,
  /** z north of which nothing of the peak exists (fast reject for terrainHeight) */
  z0: 34,
} as const;

/**
 * The summit cairn (a stone pile with a pole and three strings of prayer flags: what tells a snow dome from the top of the world). On the level
 * platform, 3.4 m from the start and 3.3 m off the trail's line; `r` is its collider radius, `strings` the flag lines (direction x/z, length in m).
 */
export const EVEREST_CAIRN = {
  x: EVEREST.x + 3.0,
  z: EVEREST.z + 1.6,
  r: 0.62,
  h: 1.0,
  pole: 2.35,
  strings: [
    [0.99, 0.14, 3.4],
    [-0.29, 0.96, 3.2],
    [-0.75, 0.66, 3.6],
  ],
} as const;

/** Smooth rise at a world position (no rock relief). */
export function everestSmooth(x: number, z: number): number {
  const dx = x - EVEREST.x;
  const dz = z - EVEREST.z;
  return riseLocal(dx * COS + dz * SIN, -dx * SIN + dz * COS);
}

/** The trail centre line in world space (summit first), with the straight connector to the knoll. */
const PTS: Vec2[] = (() => {
  const out: Vec2[] = LOCAL.map(([lx, lz]) => [EVEREST.x + lx * COS - lz * SIN, EVEREST.z + lx * SIN + lz * COS] as Vec2);
  const last = out[out.length - 1];
  const n = Math.ceil(last[1] - JOIN_Z);
  for (let i = 1; i <= n; i++) out.push([lerp(last[0], FOOT[0], Math.min(1, i / 6)), last[1] - ((last[1] - JOIN_Z) * i) / n]);
  return out;
})();
const INDEX = new PolyIndex(PTS, 8, 30);

/** Rise of the peak at a world position: the smooth cone + rock relief (calmed within 30 m of the trail, absent at the foot and on the crown). */
export function everestRise(x: number, z: number): number {
  const base = everestSmooth(x, z);
  if (base <= 0) return 0;
  const t = base / H;
  const mask = smoothstep(0, 0.14, t) * (1 - smoothstep(0.88, 1, t));
  if (mask <= 0) return base;
  const q = INDEX.query(x, z);
  const calm = isFinite(q.dist) ? smoothstep(5, 30, q.dist) : 1;
  if (calm <= 0) return base;
  const n = (fbm(x * 0.017, z * 0.017, 91, 3) - 0.5) * 36 + (fbm(x * 0.07, z * 0.07, 92, 3) - 0.5) * 9;
  return base + n * mask * calm;
}

/** 0 off the peak .. 1 on it (for the ground colours and the placements): eases in over the first metres of rise. */
export function everestWeight(x: number, z: number): number {
  if (z < EVEREST.z0) return 0;
  return smoothstep(0.5, 7, everestSmooth(x, z));
}

/**
 * The trail as a route (the MtnRoute shape of mountain.ts, so routeNear / corridorWalls / ringWalls work on it). `baseFn` is the ungraded ground
 * (jungle hills + everestRise). Heights: the ground along the centre line, box-smoothed (9 m each side) and grade-limited to 40 %; the summit
 * platform is level.
 */
export function buildEverestRoute(baseFn: (x: number, z: number) => number): MtnRoute {
  const n = PTS.length;
  const s: number[] = [0];
  for (let i = 1; i < n; i++) s.push(s[i - 1] + Math.hypot(PTS[i][0] - PTS[i - 1][0], PTS[i][1] - PTS[i - 1][1]));
  const raw = PTS.map(([x, z]) => baseFn(x, z));
  const top = raw[0];
  const W = 9;
  const y = raw.map((_, i) => {
    let sum = 0;
    let c = 0;
    for (let k = Math.max(0, i - W); k <= Math.min(n - 1, i + W); k++) {
      sum += raw[k];
      c++;
    }
    return sum / c;
  });
  for (let i = 0; i < n; i++) if (s[i] <= EVEREST.platform + 0.5) y[i] = top;
  const G = 0.4;
  for (let i = 1; i < n; i++) {
    const ds = s[i] - s[i - 1];
    y[i] = Math.min(y[i - 1] + G * ds, Math.max(y[i - 1] - G * ds, y[i]));
  }
  for (let i = n - 2; i >= 0; i--) {
    if (s[i] <= EVEREST.platform + 0.5) break;
    const ds = s[i + 1] - s[i];
    y[i] = Math.min(y[i + 1] + G * ds, Math.max(y[i + 1] - G * ds, y[i]));
  }
  const samples: RouteSample[] = PTS.map(([x, z], i) => ({ x, z, y: y[i], s: s[i], hw: EVEREST.hw, zone: 'climb' }));
  return { samples, length: s[n - 1], pts: PTS, index: INDEX, cleft: { s0: -10, s1: -9, sMid: -9.5 } };
}

/** Grade the trail into the ground: a bench (flat for the trail's width, a 3.6 m shoulder cut into the slope) and the level summit platform. */
export function gradeEverest(r: MtnRoute, x: number, z: number, h: number): number {
  const hit = routeNear(r, x, z);
  if (hit.dist < 12) {
    // the bench dissolves into the knoll's own trail over its last 8 m
    const along = (1 - smoothstep(hit.hw * 0.95, hit.hw * 0.95 + 3.6, hit.dist)) * smoothstep(0, 8, r.length - hit.s);
    if (along > 0) h = lerp(h, hit.y - 0.04 * (1 - smoothstep(0, hit.hw, hit.dist)), along);
  }
  const d = Math.hypot(x - EVEREST.x, z - EVEREST.z);
  const pr = EVEREST.platform;
  if (d < pr + 3) {
    const w = 1 - smoothstep(pr - 0.4, pr + 2.4, d);
    const top = r.samples[0].y;
    h = lerp(h, top - 0.05 * (d / pr) * (d / pr), w);
  }
  return h;
}

/**
 * Terrain tiles of the massif: a quadtree over 96 m roots. 24 m tiles with 2 m cells where the trail passes (the bench needs them), 48 m tiles with
 * 6 m cells within 45 m of it, 96 m tiles with 16 m cells elsewhere (the far faces are only ever seen from a distance).
 */
export function everestTiles(r: MtnRoute, xa: number, xb: number, za: number, zb: number): TileSpec[] {
  const out: TileSpec[] = [];
  const dist = (x0: number, z0: number, x1: number, z1: number): number => {
    let best = Infinity;
    for (const q of r.samples) best = Math.min(best, Math.hypot(Math.max(x0 - q.x, 0, q.x - x1), Math.max(z0 - q.z, 0, q.z - z1)));
    return best;
  };
  const split = (x0: number, z0: number, x1: number, z1: number): void => {
    const w = x1 - x0;
    const d = dist(x0, z0, x1, z1);
    if ((w > 24 && d < 7) || (w > 48 && d < 45)) {
      const mx = (x0 + x1) / 2;
      const mz = (z0 + z1) / 2;
      split(x0, z0, mx, mz);
      split(mx, z0, x1, mz);
      split(x0, mz, mx, z1);
      split(mx, mz, x1, z1);
      return;
    }
    out.push({ x0, z0, x1, z1, cell: w <= 24 ? 2 : w <= 48 ? 6 : 16 });
  };
  for (let z = za; z < zb - 1e-6; z += 96) for (let x = xa; x < xb - 1e-6; x += 96) split(x, z, x + 96, z + 96);
  return out;
}

const yawOf = (dx: number, dz: number): number => (Math.atan2(-dx, -dz) * 180) / Math.PI;

/**
 * Snow cover 0..1 at a point of the peak (`y` absolute height, `slope` rise/run): the vertex-colour twin of the per-pixel rule in the terrain shader
 * (lib/materials.ts, mountainGroundMaterial). Snow lies above the snow line, except on faces steeper than ~55 degrees.
 */
export function everestSnowAt(x: number, z: number, y: number, slope: number): number {
  if (y < EVEREST.snow - 40) return 0;
  const sh = y + 10 * Math.sin(x * 0.045) * Math.sin(z * 0.039);
  const flat = 1 - 1 / Math.hypot(1, slope);
  return smoothstep(EVEREST.snow - 6, EVEREST.snow + 16, sh) * (1 - 0.86 * smoothstep(0.3, 0.5, flat));
}

/** Stations on the peak (for ?area=, the stills and the budget tool). */
export function everestViewpoints(r: MtnRoute): Record<string, Viewpoint> {
  const atY = (yv: number): RouteSample => r.samples.reduce((b, q) => (Math.abs(q.y - yv) < Math.abs(b.y - yv) ? q : b));
  const atS = (sv: number): RouteSample => r.samples.reduce((b, q) => (Math.abs(q.s - sv) < Math.abs(b.s - sv) ? q : b));
  const onRoute = (id: string, label: string, a: RouteSample, ahead: number, pitch: number): Viewpoint => {
    const b = atS(a.s + ahead);
    return { id, label, x: a.x, z: a.z, y: a.y, yawDeg: yawOf(b.x - a.x, b.z - a.z), pitchDeg: pitch };
  };
  const top = r.samples[0];
  const out = atS(30);
  return {
    everest: { id: 'everest', label: 'Everest summit (the start)', x: top.x, z: top.z, y: top.y, yawDeg: yawOf(out.x - top.x, out.z - top.z), pitchDeg: -6 },
    'everest-north': { id: 'everest-north', label: 'Everest summit (north, towards the jungle)', x: top.x, z: top.z, y: top.y, yawDeg: 0, pitchDeg: -10 },
    'everest-ridge': onRoute('everest-ridge', 'Everest: the summit ridge', atS(60), 14, -10),
    'everest-snow': onRoute('everest-snow', 'Everest: snow fields above the clouds', atY(EVEREST.deck + 50), 16, -8),
    'everest-clouds': onRoute('everest-clouds', 'Everest: entering the clouds', atY(EVEREST.deck + 16), 16, -8),
    'everest-rock': onRoute('everest-rock', 'Everest: rock faces below the clouds', atY(EVEREST.deck - 40), 16, -6),
    'everest-foot': onRoute('everest-foot', 'Everest: the foot, the knoll ahead', atS(r.length - 70), 16, -2),
  };
}

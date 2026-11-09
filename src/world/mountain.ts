/**
 * The mountain expedition (Prompt 04): a side route that leaves the Forest Trail, climbs a jungle ridge to a
 * summit overlook above a deep valley, descends a cliff-side ledge (collapse event), crosses a rope bridge
 * over a gorge and ends on a terrace beside the brink of a giant waterfall.
 *
 * Pure and deterministic (no Three.js, DOM or SDK imports): used by the terrain asset, colliders, bridge,
 * waterfall, placements, systems, tools/generate-scene.mjs and tools/validate-scene.mjs.
 *
 * LANDFORM (all heights in metres, jungle floor = 0)
 *   plateau   +34  the high ridge/summit country; its west edge is the climb flank (x ~ 24 .. 88)
 *   valley    -62  a deep crater-like valley centred on VALLEY; its wall is concave and steep (up to ~65 deg)
 *   ledge     +22 -> +10  a natural terrace halfway down the wall (the descent trail runs on it)
 *   spur      the summit promontory sticking out over the wall: a sheer drop to the valley
 *   gorge     a slot cut through plateau + ledge; the river drops 40 m in a cascade, runs through the slot
 *             and plunges 52 m over the valley wall (the giant waterfall)
 * The route height is the smoothed landform height along the route (like the main trail), so the route
 * follows the ground; features (summit platform, collapse cleft, bridge abutments, brink terrace) are
 * graded on top.
 */
import { PolyIndex, catmull, clamp01, fbm, lerp, sampleSpline, smoothstep, valueNoise } from './math.ts';
import type { Vec2 } from './math.ts';

// ---------------------------------------------------------------------------
// Landform parameters
// ---------------------------------------------------------------------------

/** Rectangle (m) where the mountain landform replaces the jungle hills. Faded at its edges. */
export const MZ = { x0: 22, x1: 410, z0: -290, z1: -12 } as const;

export const VALLEY = { x: 190, z: -100 } as const;
export const GEO = {
  floor: -62,
  plateau: 34,
  rFloor: 30,
  rLedgeIn: 88,
  rLedgeOut: 98,
  rCliffTop: 103,
} as const;

/** Angles are atan2(z - VALLEY.z, x - VALLEY.x) in radians; north (-Z) is -PI/2. */
const DEG = Math.PI / 180;
export const THETA_GORGE = -92 * DEG;

/**
 * Ledge height by angle (degrees, wrapped to 160..520). The descent runs on the ledge from the summit side
 * (22 m) round to the gorge (10 m): a flat stretch, a steep gully step, a flat stretch (the collapse cleft),
 * a second steep step, then a long level approach to the bridge.
 */
const LEDGE_KEYS: [number, number][] = [
  [160, 22.0],
  [181, 21.2],
  [196, 20.6],
  [206, 15.6], // steep gully #1 (~5 m in 16 m)
  [224, 15.0], // the cleft stretch
  [234, 10.9], // steep gully #2
  [268, 10.0], // gorge
  [300, 9.0],
  [330, 9.5],
  [380, 10.0],
  [460, 14.0],
  [520, 22.0],
];
function ledgeY(theta: number): number {
  let a = theta / DEG;
  if (a < 160) a += 360;
  if (a > 520) a -= 360;
  for (let i = 0; i < LEDGE_KEYS.length - 1; i++) {
    const [a0, y0] = LEDGE_KEYS[i];
    const [a1, y1] = LEDGE_KEYS[i + 1];
    if (a <= a1) return lerp(y0, y1, smoothstep(a0, a1, a));
  }
  return LEDGE_KEYS[LEDGE_KEYS.length - 1][1];
}

/** Summit spur (promontory) over the valley wall. */
export const SUMMIT = { x: 108, z: -80, r: 9.5, y: 34.0 } as const;
/** Direction (unit) from the summit towards the valley centre, and the lip point (where the platform ends). */
export const SUMMIT_DIR: Vec2 = (() => {
  const dx = VALLEY.x - SUMMIT.x;
  const dz = VALLEY.z - SUMMIT.z;
  const l = Math.hypot(dx, dz);
  return [dx / l, dz / l] as const;
})();

// ---------------------------------------------------------------------------
// Gorge, river, waterfall
// ---------------------------------------------------------------------------

/** River/gorge centre-line from upstream (north, high) to the brink. Bed height by index in GORGE_BED. */
const GORGE_PTS: Vec2[] = (() => {
  const out: Vec2[] = [];
  for (const d of [175, 150, 128, 112, 98, 88, 80, 70, 58, 44, 30]) {
    const wob = d > 100 ? Math.sin(d * 0.07) * 2.5 : 0;
    out.push([VALLEY.x + Math.cos(THETA_GORGE) * d + wob, VALLEY.z + Math.sin(THETA_GORGE) * d]);
  }
  return out;
})();
export const GORGE_SAMPLES: Vec2[] = sampleSpline(GORGE_PTS, 6);
/** Water level of the plunge pool at the foot of the fall. */
export const BASIN_Y = -60.6;
/** Distance from the valley centre of the brink (where the river leaves the slot and falls). */
export const D_BRINK = 82;
/** River bed height along the gorge, by distance d from the valley centre (cascade between 128 and 104). */
export function riverBedY(d: number): number {
  if (d >= 150) return 31 - (175 - d) * 0.12; // stream on the plateau
  if (d >= 128) return lerp(28, 31 - 25 * 0.12, smoothstep(128, 150, d)); // upper channel
  if (d >= 104) return lerp(-9.5, 28, Math.pow(smoothstep(104, 128, d), 1.6)); // the cascade (40 m, in the cliff band)
  return -9.5 - (104 - d) * 0.02; // slot floor, gently down to the brink
}
const gorgeIndex = new PolyIndex(GORGE_SAMPLES, 8, 40);
function gorgeAt(x: number, z: number): { dist: number; d: number; side: number } {
  const q = gorgeIndex.query(x, z);
  if (!isFinite(q.dist)) return { dist: Infinity, d: 0, side: 1 };
  // river-axis position expressed as distance from the valley centre
  const i = Math.min(GORGE_SAMPLES.length - 2, Math.floor(q.index));
  const u = q.index - i;
  const px = lerp(GORGE_SAMPLES[i][0], GORGE_SAMPLES[i + 1][0], u);
  const pz = lerp(GORGE_SAMPLES[i][1], GORGE_SAMPLES[i + 1][1], u);
  return { dist: q.dist, d: Math.hypot(px - VALLEY.x, pz - VALLEY.z), side: q.side };
}
/** Slot half-width at the floor and at the rim, by d. The slot narrows towards the brink. */
export function slotFloorHalf(d: number): number {
  return d > 104 ? 3.6 + 1.6 * smoothstep(104, 120, d) : 3.2 + 1.2 * smoothstep(80, 100, d);
}
export function slotRimHalf(d: number): number {
  // Radius at which the slot wall reaches its full height (60 m above the bed): the lip at the ledge level is at ~0.48 of (rim - floor).
  if (d > 128) return 8;
  if (d > 104) return lerp(21, 10, smoothstep(112, 128, d));
  return lerp(14, 21, smoothstep(80, 104, d));
}

// ---------------------------------------------------------------------------
// Landform height (before the route is graded in)
// ---------------------------------------------------------------------------

function warpedDist(x: number, z: number): number {
  const d = Math.hypot(x - VALLEY.x, z - VALLEY.z);
  // Low-frequency warp makes the valley an irregular bowl (not a circle); the finer term crinkles the rim.
  const gd = Math.min(60, gorgeAt(x, z).dist);
  const calm = 0.15 + 0.85 * smoothstep(14, 60, gd); // the ledge keeps its radius near the gorge, where the bridge and terrace sit
  return d + (fbm(x * 0.009, z * 0.009, 79, 2) - 0.5) * 34 * calm + (fbm(x * 0.021, z * 0.021, 71, 2) - 0.5) * 11 * (0.4 + 0.6 * calm);
}

/** Concave wall: steepest at the top (just below the ledge), flattening to the floor. */
function wallY(d: number, yTop: number): number {
  const t = clamp01((d - GEO.rFloor) / (GEO.rLedgeIn - GEO.rFloor));
  return lerp(GEO.floor, yTop, Math.pow(t, 3.0));
}

/** Plateau-level ground (the ridge country) with gentle relief. */
function plateauY(x: number, z: number): number {
  return GEO.plateau + (fbm(x * 0.028, z * 0.028, 72, 2) - 0.5) * 7 + (valueNoise(x * 0.11, z * 0.11, 73) - 0.5) * 1.6;
}

/** Raw valley/plateau surface (a function of the warped radius and angle only). */
function pitSurface(x: number, z: number): number {
  const d = warpedDist(x, z);
  const theta = Math.atan2(z - VALLEY.z, x - VALLEY.x);
  const yL = ledgeY(theta);
  const plateau = plateauY(x, z);
  if (d >= GEO.rCliffTop) return plateau;
  // Blend the wall into the ledge with a rounded lip, then the cliff band up to the plateau.
  // Buttresses and gullies on the wall (angle-based so they run straight down the face), strongest mid-wall.
  const t = clamp01((d - GEO.rFloor) / (GEO.rLedgeIn - GEO.rFloor));
  const ribs = (fbm(Math.cos(theta) * 8 + 5, Math.sin(theta) * 8, 80, 3) - 0.5) * 2 + (fbm(x * 0.045, z * 0.045, 81, 2) - 0.5) * 0.8;
  const wall = wallY(d, yL + 0.4) + ribs * 11 * Math.sin(Math.PI * Math.pow(t, 0.8)) * (1 - smoothstep(0.82, 1, t));
  const ledge = yL + (d - GEO.rLedgeIn) * 0.06 + (fbm(x * 0.12, z * 0.12, 74, 2) - 0.5) * 0.7;
  let y = lerp(wall, ledge, smoothstep(GEO.rLedgeIn - 2.5, GEO.rLedgeIn + 1.5, d));
  y = lerp(y, plateau, smoothstep(GEO.rLedgeOut, GEO.rCliffTop, d)); // sheer cliff band, 5 m wide
  return y;
}

/** 1 inside the mountain domain, fading to 0 over 45 m at its south, north and east edges (it dissolves into the jungle hills). */
export function edgeMask(x: number, z: number): number {
  return smoothstep(MZ.z1, MZ.z1 - 45, z) * smoothstep(MZ.z0, MZ.z0 + 45, z) * smoothstep(MZ.x1, MZ.x1 - 45, x);
}

/** Blend weight of the landform over the jungle hills. */
export function mountainWeight(x: number, z: number): number {
  return x <= MZ.x0 ? 0 : smoothstep(MZ.x0, MZ.x0 + 14, x) * edgeMask(x, z);
}

/** Climb flank: the ridge country tapers to the jungle level towards the west, and fades out towards the domain edges. */
function flank(x: number, z: number): number {
  const foot = 24 + (fbm(z * 0.02, 0.5, 75, 2) - 0.5) * 8;
  const top = 100 + (fbm(z * 0.03, 1.5, 76, 2) - 0.5) * 12;
  const u = clamp01((x - foot) / (top - foot));
  // Mostly linear (a real mountain flank is steep all the way), eased at the foot and at the crest.
  const t = 0.55 * u + 0.45 * smoothstep(0, 1, u);
  const roll = 1 + (fbm(x * 0.05, z * 0.05, 77, 3) - 0.5) * 0.3 * Math.sin(Math.PI * clamp01(u));
  return t * roll * edgeMask(x, z);
}

/** Summit spur: a mesa that juts out over the wall. Returns its top height where it applies (else -Infinity). */
function spurY(x: number, z: number): number {
  const ax = SUMMIT_DIR[0];
  const az = SUMMIT_DIR[1];
  const rx = x - SUMMIT.x;
  const rz = z - SUMMIT.z;
  const along = rx * ax + rz * az; // + towards the valley
  const lat = Math.abs(-rx * az + rz * ax);
  // Mesa: wide at the root, narrowing to a rounded tip.
  const tip = 13;
  const half = 12 - 5 * smoothstep(-4, tip, along);
  const edge = Math.max(lat - half, along - tip, -along - 10, 0); // outside distance (approx); the mesa root ends 10 m behind the summit
  const inside = 1 - smoothstep(0, 5.5, edge);
  const noiseTop = SUMMIT.y - (fbm(x * 0.2, z * 0.2, 78, 2) - 0.5) * 0.8 - Math.max(0, along) * 0.04;
  return inside > 0.001 ? noiseTop : -Infinity;
}

/** Landform height at (x, z) in the mountain domain, WITHOUT route grading. */
export function landform(x: number, z: number): number {
  let h = pitSurface(x, z) * flank(x, z);
  // The spur sheer-edge: max with the mesa, shaped by its inside factor.
  const sp = spurY(x, z);
  if (sp > -1e8) {
    const ax = SUMMIT_DIR[0];
    const az = SUMMIT_DIR[1];
    const rx = x - SUMMIT.x;
    const rz = z - SUMMIT.z;
    const along = rx * ax + rz * az;
    const lat = Math.abs(-rx * az + rz * ax);
    const tip = 13;
    const half = 12 - 5 * smoothstep(-4, tip, along);
    const edge = Math.max(lat - half, along - tip, -along - 10, 0);
    const k = 1 - smoothstep(0, 5.5, edge);
    h = Math.max(h, lerp(h, sp, Math.pow(k, 0.55)));
  }
  // The valley floor is not a billiard table: gentle swells, and the river's channel cut 1.6 m into it.
  if (h < GEO.floor + 14) {
    const lowK = 1 - smoothstep(GEO.floor + 2, GEO.floor + 14, h);
    h += (fbm(x * 0.022, z * 0.022, 86, 3) - 0.5) * 5.5 * lowK;
    const rd = valleyRiverDistance(x, z);
    if (rd < 9) h -= 1.7 * (1 - smoothstep(2.4, 8.5, rd)) * lowK;
  }
  // Gorge slot (cut through plateau + ledge, ending at the brink).
  const g = gorgeAt(x, z);
  if (g.dist < 40 && g.d > D_BRINK - 2) h = Math.min(h, riverBedY(g.d) + wallProfile(g.dist, slotFloorHalf(g.d), slotRimHalf(g.d)));
  // The fall face: below the brink the wall is cut into a near-vertical alcove (a plunge-pool basin at its foot).
  if (g.dist < 22 && g.d < D_BRINK + 6 && g.d > 40) {
    const face = lerp(BASIN_Y - 1.2, riverBedY(D_BRINK + 4), smoothstep(66, D_BRINK + 4, g.d));
    const lat = 1 - smoothstep(7, 20, g.dist);
    h = Math.min(h, lerp(h, Math.min(h, face), lat));
  }
  return h;
}
function wallProfile(l: number, fh: number, rh: number): number {
  if (l <= fh) return 0.12 * (l / fh) ** 2; // floor, slightly dished
  const t = Math.max(0, (l - fh) / (rh - fh));
  return 0.12 + 60 * Math.pow(t, 1.5); // steep wall: ~80 degrees at the ledge lip, easing out above
}

/** Distance (m) from the river/gorge axis, Infinity when far away. */
export function gorgeDistance(x: number, z: number): number {
  return gorgeAt(x, z).dist;
}

/** Valley river: from the plunge pool out of the valley to the south-east (x, z). */
export const VALLEY_RIVER: Vec2[] = (() => {
  const a = THETA_GORGE;
  const toe = [VALLEY.x + Math.cos(a) * 54, VALLEY.z + Math.sin(a) * 54] as const;
  return sampleSpline(
    [
      [toe[0], toe[1]],
      [toe[0] + 4, toe[1] + 14],
      [toe[0] - 8, toe[1] + 34],
      [toe[0] + 6, toe[1] + 58],
      [toe[0] + 26, toe[1] + 84],
      [toe[0] + 58, toe[1] + 100],
      [toe[0] + 100, toe[1] + 92],
      [toe[0] + 150, toe[1] + 96],
    ],
    6,
  );
})();
const riverIndex = new PolyIndex(VALLEY_RIVER, 8, 30);
/** Distance to the valley river (Infinity when far). */
export function valleyRiverDistance(x: number, z: number): number {
  return riverIndex.query(x, z).dist;
}

/** 0..1: how wet the rock is around the giant fall and the slot above it (spray, seep), used for colour and mist placement. */
export function fallWetness(x: number, z: number): number {
  const g = gorgeAt(x, z);
  if (g.dist > 24 || g.d > 130 || g.d < 40) return 0;
  const along = smoothstep(40, 70, g.d) * (1 - smoothstep(104, 130, g.d));
  return (1 - smoothstep(2, 22, g.dist)) * (0.35 + 0.65 * along);
}

/** Position on the river axis at distance d from the valley centre. */
export function riverPoint(d: number): Vec2 {
  const a = THETA_GORGE;
  const wob = d > 100 ? Math.sin(d * 0.07) * 2.5 : 0;
  return [VALLEY.x + Math.cos(a) * d + wob, VALLEY.z + Math.sin(a) * d];
}

// ---------------------------------------------------------------------------
// Route (a single polyline: climb -> summit -> descent -> approach -> bridge -> terrace)
// ---------------------------------------------------------------------------

export type RouteZone = 'climb' | 'summit' | 'gully' | 'ledge' | 'cleft' | 'approach' | 'bridge' | 'terrace';

interface Ctrl {
  x: number;
  z: number;
  hw: number;
  zone: RouteZone;
}
const polar = (d: number, deg: number): Vec2 => [VALLEY.x + Math.cos(deg * DEG) * d, VALLEY.z + Math.sin(deg * DEG) * d];
const c = (x: number, z: number, hw: number, zone: RouteZone): Ctrl => ({ x, z, hw, zone });
const cp = (p: Vec2, hw: number, zone: RouteZone): Ctrl => ({ x: p[0], z: p[1], hw, zone });

/** The bridge across the gorge (straight, level at the ledge height). West end = start. */
export const BRIDGE = { ax: 175.0, az: -193.0, bx: 198.6, bz: -193.0, y: 10.3, halfWidth: 0.78, sag: 0.8 } as const;
export const BRIDGE_LENGTH = Math.hypot(BRIDGE.bx - BRIDGE.ax, BRIDGE.bz - BRIDGE.az);
/** Deck height at fraction u (0..1) along the bridge: a shallow catenary sag. */
export const bridgeDeckY = (u: number): number => BRIDGE.y - BRIDGE.sag * 4 * u * (1 - u);

/** Muddy stretches of the route (arc length ranges, m): slippery climb switchback and the steep gully. */
export const MTN_MUD: { s0: number; s1: number }[] = [
  { s0: 52, s1: 66 },
  { s0: 100, s1: 108 },
  { s0: 228, s1: 242 },
  { s0: 312, s1: 322 },
];

/** Brink terrace: a rock platform beside the lip of the giant waterfall (end of the expedition). */
export const TERRACE = { x: 204.5, z: -190.5, r: 5.2, y: 10.0 } as const;
/** Summit platform: the top of the spur, ending 1.3 m inside the lip. */
export const PLATFORM = { x: SUMMIT.x + SUMMIT_DIR[0] * 3.4, z: SUMMIT.z + SUMMIT_DIR[1] * 3.4, r: 9.2, y: SUMMIT.y } as const;

const CTRL: Ctrl[] = [
  c(4.6, -38.0, 1.0, 'climb'),
  c(12.0, -41.0, 1.0, 'climb'),
  c(20.0, -44.0, 1.0, 'climb'),
  c(30.0, -50.0, 1.0, 'climb'),
  c(36.0, -62.0, 1.0, 'climb'),
  c(40.0, -76.0, 1.0, 'climb'),
  c(44.0, -86.0, 1.0, 'climb'),
  c(54.0, -80.0, 1.0, 'climb'),
  c(58.0, -66.0, 1.0, 'climb'),
  c(58.0, -54.0, 1.0, 'climb'),
  c(68.0, -50.0, 1.0, 'climb'),
  c(76.0, -62.0, 1.0, 'climb'),
  c(78.0, -78.0, 1.0, 'climb'),
  c(87.0, -72.0, 1.1, 'climb'),
  c(97.0, -69.0, 1.3, 'summit'),
  c(105.0, -73.0, 1.6, 'summit'),
  c(SUMMIT.x, SUMMIT.z, 1.7, 'summit'),
  // leave the platform on its north-west side (well apart from the way in) and down the gully onto the ledge
  c(103.0, -90.0, 1.2, 'gully'),
  c(96.0, -96.0, 1.2, 'gully'),
  cp(polar(100.5, 184), 1.1, 'gully'),
  cp(polar(96, 190), 1.1, 'gully'),
  cp(polar(94, 196), 1.1, 'ledge'),
  cp(polar(93, 202), 1.1, 'ledge'),
  cp(polar(93, 208), 1.1, 'ledge'),
  cp(polar(93, 216), 1.4, 'cleft'),
  cp(polar(93, 224), 1.1, 'ledge'),
  cp(polar(93, 230), 1.1, 'gully'),
  cp(polar(93, 236), 1.1, 'gully'),
  cp(polar(93, 244), 1.2, 'approach'),
  cp(polar(93, 254), 1.2, 'approach'),
  c(BRIDGE.ax - 3.4, BRIDGE.az, 1.0, 'approach'),
  c(BRIDGE.ax, BRIDGE.az, BRIDGE.halfWidth, 'bridge'),
  c(BRIDGE.bx, BRIDGE.bz, BRIDGE.halfWidth, 'bridge'),
  c(BRIDGE.bx + 3.0, BRIDGE.bz + 1.0, 1.0, 'approach'),
  c(TERRACE.x - 1.2, TERRACE.z + 0.2, 1.3, 'terrace'),
];

export interface RouteSample {
  x: number;
  z: number;
  /** Route surface height (m). */
  y: number;
  /** Arc length from the junction (m). */
  s: number;
  hw: number;
  zone: RouteZone;
}
export interface MtnRoute {
  samples: RouteSample[];
  length: number;
  pts: Vec2[];
  index: PolyIndex;
  /** Arc length range of the collapse shelf. */
  cleft: { s0: number; s1: number; sMid: number };
}

/** Collapse shelf: length along the route (m), maximum hollow depth below the route (m), width beyond the corridor to the valley side (m). */
export const CLEFT = { length: 12, depth: 1.75, rampLen: 5, outer: 8.5 } as const;
export const CLEFT_CENTER: Vec2 = polar(93, 216);

/** Build the route. `baseFn` is the ground height WITHOUT any route grading (used to follow the terrain). */
export function buildRoute(baseFn: (x: number, z: number) => number): MtnRoute {
  const pts: Vec2[] = [];
  const hws: number[] = [];
  const zones: RouteZone[] = [];
  const STEPS = 10;
  for (let i = 0; i < CTRL.length - 1; i++) {
    const a = CTRL[i];
    const b = CTRL[i + 1];
    const straight = a.zone === 'bridge' && b.zone === 'bridge';
    const p0 = CTRL[Math.max(0, i - 1)];
    const p3 = CTRL[Math.min(CTRL.length - 1, i + 2)];
    for (let k = 0; k < STEPS; k++) {
      const t = k / STEPS;
      pts.push(straight ? [lerp(a.x, b.x, t), lerp(a.z, b.z, t)] : [catmull(p0.x, a.x, b.x, p3.x, t), catmull(p0.z, a.z, b.z, p3.z, t)]);
      hws.push(lerp(a.hw, b.hw, t));
      zones.push(t < 0.5 ? a.zone : b.zone === 'bridge' && a.zone !== 'bridge' ? a.zone : b.zone);
    }
  }
  const last = CTRL[CTRL.length - 1];
  pts.push([last.x, last.z]);
  hws.push(last.hw);
  zones.push(last.zone);

  const n = pts.length;
  const s = new Float32Array(n);
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);

  // Height: the smoothed ground along the route, with fixed heights where a structure dictates it.
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) raw[i] = baseFn(pts[i][0], pts[i][1]);
  {
    // The slot cuts the ground beside the bridge: samples around it follow the ledge level, not the river bed.
    const q = new PolyIndex(pts, 8, 30);
    const ia = Math.round(q.query(BRIDGE.ax, BRIDGE.az).index);
    for (let i = Math.max(0, ia - 40); i < n; i++) raw[i] = BRIDGE.y;
  }
  const y = new Float32Array(n);
  const W = 9;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = -W; k <= W; k++) sum += raw[Math.min(n - 1, Math.max(0, i + k))];
    y[i] = sum / (2 * W + 1);
  }
  // Grade limit (forward then backward pass): no stretch of route steeper than a climbable path.
  {
    const G = 0.4;
    for (let i = 1; i < n; i++) {
      const ds = s[i] - s[i - 1];
      y[i] = Math.min(y[i - 1] + G * ds, Math.max(y[i - 1] - G * ds, y[i]));
    }
    for (let i = n - 2; i >= 0; i--) {
      const ds = s[i + 1] - s[i];
      y[i] = Math.min(y[i + 1] + G * ds, Math.max(y[i + 1] - G * ds, y[i]));
    }
  }
  // Fixed: summit platform, bridge + its approaches, terrace.
  const sIndex = new PolyIndex(pts, 8, 30);
  const at = (x: number, z: number) => Math.round(sIndex.query(x, z).index);
  const iSummit = at(SUMMIT.x, SUMMIT.z);
  const iBA = at(BRIDGE.ax, BRIDGE.az);
  const iBB = at(BRIDGE.bx, BRIDGE.bz);
  const iT = n - 1;
  const blendTo = (i0: number, i1: number, y0: number, y1: number) => {
    for (let i = Math.min(i0, i1); i <= Math.max(i0, i1); i++) y[i] = lerp(y0, y1, (i - i0) / (i1 - i0 || 1));
  };
  // Summit approach: blend the last 25 samples to the platform height.
  for (let i = Math.max(0, iSummit - 30); i <= iSummit; i++) y[i] = lerp(y[i], SUMMIT.y, smoothstep(iSummit - 30, iSummit - 6, i));
  // Descent start: back to the ground profile right after the platform.
  for (let i = iSummit; i < Math.min(n, iSummit + 14); i++) y[i] = lerp(SUMMIT.y, y[i], smoothstep(iSummit, iSummit + 14, i));
  // Bridge: level deck; ground before and after eased onto it.
  for (let i = iBA - 24; i < iBA; i++) y[i] = lerp(y[i], BRIDGE.y, smoothstep(iBA - 24, iBA, i));
  for (let i = iBA; i <= iBB; i++) y[i] = BRIDGE.y;
  for (let i = iBB + 1; i <= Math.min(n - 1, iBB + 20); i++) y[i] = lerp(BRIDGE.y, y[i], smoothstep(iBB, iBB + 20, i));
  blendTo(iT - 6, iT, y[iT - 6], TERRACE.y);
  for (let i = iT - 6; i <= iT; i++) y[i] = lerp(y[i], TERRACE.y, 0.8);

  const samples: RouteSample[] = [];
  for (let i = 0; i < n; i++) samples.push({ x: pts[i][0], z: pts[i][1], y: y[i], s: s[i], hw: hws[i], zone: zones[i] });

  // Collapse shelf range around CLEFT_CENTER.
  const iC = at(CLEFT_CENTER[0], CLEFT_CENTER[1]);
  const sMid = s[iC];
  const s0 = sMid - CLEFT.length / 2;
  const s1 = sMid + CLEFT.length / 2;
  for (const q of samples) if (q.s >= s0 - 1 && q.s <= s1 + 1) q.zone = 'cleft';
  return { samples, length: s[n - 1], pts, index: sIndex, cleft: { s0, s1, sMid } };
}

/** Route position of a point: arc length `s`, signed lateral offset `l` (+ = left of travel), distance, route height, half-width, zone. */
export interface RouteHit {
  dist: number;
  s: number;
  l: number;
  y: number;
  hw: number;
  zone: RouteZone;
  i: number;
}
export function routeNear(r: MtnRoute, x: number, z: number): RouteHit {
  const q = r.index.query(x, z);
  if (!isFinite(q.dist)) return { dist: Infinity, s: 0, l: 0, y: 0, hw: 1, zone: 'climb', i: 0 };
  const i = Math.min(r.samples.length - 2, Math.floor(q.index));
  const u = q.index - i;
  const a = r.samples[i];
  const b = r.samples[i + 1];
  return { dist: q.dist, s: lerp(a.s, b.s, u), l: q.side * q.dist, y: lerp(a.y, b.y, u), hw: lerp(a.hw, b.hw, u), zone: u < 0.5 ? a.zone : b.zone, i };
}

/** Is (x, z) on the valley side of the route at this point (the drop-off side)? */
export function valleySide(r: MtnRoute, hit: RouteHit, x: number, z: number): boolean {
  const a = r.samples[hit.i];
  return Math.hypot(x - VALLEY.x, z - VALLEY.z) < Math.hypot(a.x - VALLEY.x, a.z - VALLEY.z);
}

/** Hollow depth below the route surface at arc length s (0 outside the shelf, deepest in the middle). */
export function cleftDepth(r: MtnRoute, s: number): number {
  const { s0, s1 } = r.cleft;
  const ramp = CLEFT.rampLen;
  return CLEFT.depth * smoothstep(s0, s0 + ramp, s) * (1 - smoothstep(s1 - ramp, s1, s));
}

/**
 * Route grading and structure footprints applied on top of the landform: bench (cut and fill) along the
 * route, summit platform, collapse hollow, bridge abutments, brink terrace.
 */
export function gradeRoute(r: MtnRoute, x: number, z: number, h: number): number {
  const hit = routeNear(r, x, z);
  if (hit.dist < 26) {
    const shoulder = hit.zone === 'climb' ? 3.6 : hit.zone === 'bridge' ? 1.4 : 2.0;
    // The bridge deck is a separate structure; the ground beside it is only touched at the abutments.
    const along = hit.zone === 'bridge' ? 0 : 1 - smoothstep(hit.hw * 0.95, hit.hw * 0.95 + shoulder, hit.dist);
    if (along > 0) h = lerp(h, hit.y - 0.04 * (1 - smoothstep(0, hit.hw, hit.dist)), along);
    if (hit.s >= r.cleft.s0 - 0.5 && hit.s <= r.cleft.s1 + 0.5) {
      // The hollow: the corridor floor sinks below the shelf, and a scar opens towards the valley.
      const depth = cleftDepth(r, hit.s);
      if (depth > 0.01) {
        const valley = valleySide(r, hit, x, z);
        const reach = valley ? hit.hw + CLEFT.outer : hit.hw + 1.1;
        const lat = valley ? 1 - smoothstep(reach - 2.5, reach, hit.dist) : 1 - smoothstep(hit.hw * 0.9, reach, hit.dist); // the valley-side chute stays cut all the way to the lip
        const floor = hit.y - depth - (valley ? 0.45 * Math.max(0, hit.dist - hit.hw) : 0); // the scar is a chute: it falls away towards the lip
        h = lerp(h, Math.min(h, floor), lat);
      }
    }
  }
  // Summit platform (the spur's flat top, domed by a few cm so water would run off).
  {
    const d = Math.hypot(x - PLATFORM.x, z - PLATFORM.z);
    if (d < PLATFORM.r + 3) {
      const w = 1 - smoothstep(PLATFORM.r - 0.4, PLATFORM.r + 2.4, d);
      h = lerp(h, PLATFORM.y - 0.05 * (d / PLATFORM.r) ** 2, w);
    }
  }
  // Brink terrace.
  {
    const d = Math.hypot(x - TERRACE.x, z - TERRACE.z);
    if (d < TERRACE.r + 3) h = lerp(h, TERRACE.y - 0.03 * (d / TERRACE.r) ** 2, 1 - smoothstep(TERRACE.r - 0.4, TERRACE.r + 2.4, d));
  }
  return h;
}

// ---------------------------------------------------------------------------
// Guard walls (invisible colliders that keep the player on the route and off the drops)
// ---------------------------------------------------------------------------

export interface GuardWall {
  x: number;
  z: number;
  /** Rotation about Y (radians) of the wall's long axis (local X). */
  yaw: number;
  length: number;
  /** Wall spans heights [y0, y1]. */
  y0: number;
  y1: number;
}

export const GUARD_THICK = 0.5;
export const GUARD_MARGIN = 0.18; // clear gap between the corridor edge and the wall face

/** Walls along both sides of the corridor, every ~1.6 m of route, skipping the bridge span (the bridge has its own rails) and the two platforms (rings). */
export function corridorWalls(r: MtnRoute, startS: number): GuardWall[] {
  const out: GuardWall[] = [];
  const n = r.samples.length;
  let acc = 0;
  for (let i = 1; i < n - 1; i++) {
    const a = r.samples[i];
    if (a.s < startS) continue;
    acc += Math.hypot(a.x - r.samples[i - 1].x, a.z - r.samples[i - 1].z);
    if (acc < 1.5) continue;
    acc = 0;
    // The bridge's own rail walls cover its span (and a little beyond onto each abutment); the static corridor walls take over from there.
    if (a.zone === 'bridge' && a.x > BRIDGE.ax + 0.9 && a.x < BRIDGE.bx - 0.9) continue;
    const p = r.samples[i - 1];
    const q = r.samples[Math.min(n - 1, i + 1)];
    const tx = q.x - p.x;
    const tz = q.z - p.z;
    const tl = Math.hypot(tx, tz) || 1;
    const nx = -tz / tl;
    const nz = tx / tl;
    const yaw = Math.atan2(-tz, tx);
    for (const side of [-1, 1]) {
      const off = a.hw + GUARD_MARGIN + GUARD_THICK / 2;
      const x = a.x + nx * off * side;
      const zz = a.z + nz * off * side;
      // Platform rings own their area.
      if (Math.hypot(x - PLATFORM.x, zz - PLATFORM.z) < PLATFORM.r + 0.25 - 0.3) continue; // inside the summit ring
      if (Math.hypot(x - TERRACE.x, zz - TERRACE.z) < TERRACE.r - 0.2 - 0.3) continue;
      out.push({ x, z: zz, yaw, length: 2.5, y0: a.y - 5.5, y1: a.y + 5 });
    }
  }
  return out;
}

/** A ring of walls around a circular platform, leaving gaps where the route enters/leaves it. */
export function ringWalls(cx: number, cz: number, radius: number, y: number, exits: Vec2[], gapHalf: number): GuardWall[] {
  const out: GuardWall[] = [];
  const N = Math.max(12, Math.round((2 * Math.PI * radius) / 0.9));
  for (let k = 0; k < N; k++) {
    const a = (k / N) * Math.PI * 2;
    const x = cx + Math.cos(a) * radius;
    const z = cz + Math.sin(a) * radius;
    if (exits.some((e) => Math.hypot(e[0] - x, e[1] - z) < gapHalf)) continue;
    out.push({ x, z, yaw: -(a + Math.PI / 2), length: (2 * Math.PI * radius) / N + 0.3, y0: y - 6, y1: y + 5 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Terrain tiling for the mountain domain (adaptive quadtree: fine near the route, coarse far away)
// ---------------------------------------------------------------------------

export interface TileSpec {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Grid cell size (m). Every tile is 16 x 16 cells, so cost per tile is constant. */
  cell: number;
}

/** Distance from the route to the rectangle (0 if the route passes through it). */
function routeDistToRect(r: MtnRoute, x0: number, z0: number, x1: number, z1: number): number {
  let best = Infinity;
  for (const q of r.samples) {
    const dx = Math.max(x0 - q.x, 0, q.x - x1);
    const dz = Math.max(z0 - q.z, 0, q.z - z1);
    best = Math.min(best, Math.hypot(dx, dz));
  }
  return best;
}

/**
 * Tiles covering x in [xa, xb], z in [za, zb]: 24 m tiles (1.5 m cells) within 14 m of the route, 48 m tiles (3 m)
 * within 60 m of it or on the valley wall, 96 m tiles (6 m) elsewhere.
 */
export function mountainTiles(r: MtnRoute, xa: number, xb: number, za: number, zb: number): TileSpec[] {
  const out: TileSpec[] = [];
  const split = (x0: number, z0: number, x1: number, z1: number, size: number) => {
    const w = x1 - x0;
    const d = routeDistToRect(r, x0, z0, x1, z1);
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const dv = Math.hypot(cx - VALLEY.x, cz - VALLEY.z);
    const wantFine = w > 24 && d < 7;
    const wantMid = w > 48 && d < 45;
    if (wantFine || wantMid) {
      const mx = (x0 + x1) / 2;
      const mz = (z0 + z1) / 2;
      split(x0, z0, mx, mz, size / 2);
      split(mx, z0, x1, mz, size / 2);
      split(x0, mz, mx, z1, size / 2);
      split(mx, mz, x1, z1, size / 2);
      return;
    }
    // Valley wall and floor (visible from every overlook): big 96 m tiles at 4 m cells (few draws, enough relief for the crags to read).
    const onWall = w >= 96 && dv < GEO.rCliffTop + 24 && dv > GEO.rFloor - 14;
    // Finer ground where the player stands to look over an edge (summit platform, brink terrace).
    const near = (px: number, pz: number, r: number) => Math.max(x0 - px, 0, px - x1) ** 2 + Math.max(z0 - pz, 0, pz - z1) ** 2 < (r + 5) ** 2;
    const fineHere = w <= 24 && (near(PLATFORM.x, PLATFORM.z, PLATFORM.r) || near(TERRACE.x, TERRACE.z, TERRACE.r));
    out.push({ x0, z0, x1, z1, cell: onWall ? 4 : fineHere ? w / 24 : w / 16 });
  };
  const nx = Math.ceil((xb - xa) / 96);
  const nz = Math.ceil((zb - za) / 96);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      split(xa + i * 96, za + j * 96, Math.min(xb, xa + (i + 1) * 96), Math.min(zb, za + (j + 1) * 96), 96);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Named viewpoints (stations on the route): used by ?area=, the headset test mode, screenshots and the budget tool
// ---------------------------------------------------------------------------

export interface Viewpoint {
  id: string;
  label: string;
  x: number;
  z: number;
  /** Feet height (the viewpoint may be on a structure, not the ground). */
  y: number;
  /** Heading in degrees: 0 = facing -Z (north), positive = turned left. */
  yawDeg: number;
  /** Head pitch in degrees (negative = looking down). */
  pitchDeg: number;
}

const yawOf = (dx: number, dz: number): number => (Math.atan2(-dx, -dz) * 180) / Math.PI;

export function viewpoints(r: MtnRoute): Record<string, Viewpoint> {
  const atS = (sv: number) => r.samples.reduce((b, q) => (Math.abs(q.s - sv) < Math.abs(b.s - sv) ? q : b));
  const onRoute = (id: string, label: string, sv: number, ahead: number, pitch: number): Viewpoint => {
    const a = atS(sv);
    const b = atS(sv + ahead);
    return { id, label, x: a.x, z: a.z, y: a.y, yawDeg: yawOf(b.x - a.x, b.z - a.z), pitchDeg: pitch };
  };
  const dx = SUMMIT_DIR[0];
  const dz = SUMMIT_DIR[1];
  const lipX = PLATFORM.x + dx * (PLATFORM.r - 1.5);
  const lipZ = PLATFORM.z + dz * (PLATFORM.r - 1.5);
  const brink = riverPoint(D_BRINK);
  const bm = { x: (BRIDGE.ax + BRIDGE.bx) / 2, z: (BRIDGE.az + BRIDGE.bz) / 2 };
  return {
    climb: onRoute('climb', 'Mountain climb (switchbacks)', 100, 12, 0),
    ridge: onRoute('ridge', 'Ridge top, summit ahead', 170, 14, 2),
    summit: { id: 'summit', label: 'Summit overlook (out over the valley)', x: lipX, z: lipZ, y: PLATFORM.y, yawDeg: yawOf(dx, dz), pitchDeg: -6 },
    'summit-down': { id: 'summit-down', label: 'Summit overlook (looking down)', x: lipX, z: lipZ, y: PLATFORM.y, yawDeg: yawOf(dx, dz), pitchDeg: -58 },
    'summit-fall': { id: 'summit-fall', label: 'Summit overlook (the giant waterfall)', x: lipX, z: lipZ, y: PLATFORM.y, yawDeg: yawOf(brink[0] - lipX, brink[1] - lipZ), pitchDeg: -4 },
    descent: onRoute('descent', 'Steep descent (gully)', 232, 12, -8),
    ledge: onRoute('ledge', 'Cliff ledge', 268, 14, -4),
    cleft: onRoute('cleft', 'Before the collapse', r.cleft.s0 - 9, 12, -6),
    'bridge-west': { id: 'bridge-west', label: 'Rope bridge (west end)', x: BRIDGE.ax - 2.4, z: BRIDGE.az, y: BRIDGE.y, yawDeg: yawOf(1, 0), pitchDeg: -4 },
    'bridge-mid': { id: 'bridge-mid', label: 'Rope bridge (mid-span, looking down)', x: bm.x, z: bm.z, y: bridgeDeckY(0.5), yawDeg: yawOf(0, -1), pitchDeg: -40 },
    'bridge-cascade': { id: 'bridge-cascade', label: 'Rope bridge (the cascade upstream)', x: bm.x, z: bm.z, y: bridgeDeckY(0.5), yawDeg: yawOf(0, -1), pitchDeg: 22 },
    'brink-down': { id: 'brink-down', label: 'Brink terrace (looking straight down the waterfall)', x: TERRACE.x - 1.5, z: TERRACE.z + 1.5, y: TERRACE.y, yawDeg: yawOf(brink[0] - TERRACE.x, brink[1] - TERRACE.z), pitchDeg: -62 },
    valley: { id: 'valley', label: 'Summit (across the valley, level)', x: lipX, z: lipZ, y: PLATFORM.y, yawDeg: yawOf(VALLEY.x - lipX + 20, VALLEY.z - lipZ - 40), pitchDeg: 0 },
    brink: { id: 'brink', label: 'Brink terrace (over the giant waterfall)', x: TERRACE.x - 1.5, z: TERRACE.z + 1.5, y: TERRACE.y, yawDeg: yawOf(brink[0] - TERRACE.x, brink[1] - TERRACE.z), pitchDeg: -28 },
  };
}

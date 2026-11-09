/**
 * The collapsing ledge (Prompt 04): pure layout + scripted ballistics, shared by the shelf asset, the
 * CollapseSystem and tools/validate-scene.mjs (which proves the debris never lands on the route).
 *
 * The event, in route terms (s = arc length along the route, l = lateral offset, + towards the valley):
 *   - a rock SHELF covers the hollow in the ledge over s0 .. s1 (12 m); it is split into ROWS (along s), each row
 *     into a RIDE part (l <= RIDE_EDGE: the walking surface and its inner side) and a FALL part (the valley-side lip).
 *   - SINK: the ride rows and the walking-surface collider lower together by SINK_DEPTH with an eased curve, so a
 *     player standing on them is carried down smoothly (no free fall, no camera motion) until the shelf passes under
 *     the hollow floor (which is part of the static terrain) and they stand on the rubble.
 *   - FALL: the lip pieces break away and tumble into the valley (ballistics below, ground = the landform).
 *   - PEBBLES: a shower of small stones before the break, from the cliff above onto the shelf and off its edge.
 * Everything is a deterministic function of fixed seeds: the same on every run, in the browser and in Node.
 */
import { MTN, fbm, makeRandom, smoothstep, terrainHeight } from './layout.ts';
import { CLEFT, VALLEY, routeNear } from './mountain.ts';

export const SHELF = {
  rows: 4,
  /** ride part covers l in [RIDE_MIN, RIDE_EDGE]; the fall part l in [RIDE_EDGE, lip]. */
  rideMin: -2.1,
  rideEdge: 2.2,
  /** thickness of the slabs (m) */
  thickness: 0.55,
  /** how far the ride parts and the walking collider sink (m): deeper than the hollow (1.75 m) so the shelf ends up buried */
  sinkDepth: 2.35,
  /** seconds */
  sinkTime: 1.8,
} as const;

export const EVENT = {
  /** distance along the route (m) from the nearest shelf end at which each stage starts */
  crackFrom: 17,
  crackFull: 8,
  pebblesFrom: 10.5,
  tremorFrom: 6.8,
  /** the player retreating beyond this before the break cancels the event */
  cancelBeyond: 20,
  /** seconds from the start of the tremor to the break (a player who steps on the shelf earlier still gets >= minTremor) */
  tremorToBreak: 2.6,
  minTremor: 1.2,
  /** the event resets when the player is farther than this from the shelf (m, along the route) and not looking at it */
  resetDistance: 70,
  resetHardDistance: 170,
  /** seconds after the break until the lip debris is gone from view */
  debrisLife: 7,
} as const;

export interface ShelfFrame {
  s: number;
  x: number;
  z: number;
  y: number;
  /** unit tangent (travel direction) and left normal */
  tx: number;
  tz: number;
  nx: number;
  nz: number;
  /** +1: moving along +normal goes towards the valley */
  valley: number;
}

/** Route frame at arc length s (interpolated). */
export function frameAt(s: number): ShelfFrame {
  const S = MTN.samples;
  let i = 1;
  while (i < S.length - 1 && S[i].s < s) i++;
  const a = S[i - 1];
  const b = S[i];
  const u = (s - a.s) / (b.s - a.s || 1);
  const x = a.x + (b.x - a.x) * u;
  const z = a.z + (b.z - a.z) * u;
  const y = a.y + (b.y - a.y) * u;
  const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const tx = (b.x - a.x) / l;
  const tz = (b.z - a.z) / l;
  const nx = -tz;
  const nz = tx;
  const valley = Math.hypot(x + nx * 2 - VALLEY.x, z + nz * 2 - VALLEY.z) < Math.hypot(x - VALLEY.x, z - VALLEY.z) ? 1 : -1;
  return { s, x, z, y, tx, tz, nx, nz, valley };
}

/** World position of route coordinates (s, l), l positive towards the valley. */
export function worldAt(s: number, l: number): { x: number; z: number; y: number } {
  const f = frameAt(s);
  return { x: f.x + f.nx * f.valley * l, z: f.z + f.nz * f.valley * l, y: f.y };
}

/** Valley-side extent of the shelf: where the ledge ends (the terrain drops more than 1.2 m below the route). */
export function shelfLip(): number {
  const mid = MTN.cleft.sMid;
  let best = 4;
  for (let l = 1.5; l < 9; l += 0.25) {
    const w = worldAt(mid, l);
    if (terrainHeight(w.x, w.z) < w.y - CLEFT.depth - 1.0) break;
    best = l;
  }
  return Math.max(3.6, best - 0.3);
}

/** Row boundaries along s (jittered, shared by neighbours). */
export function rowBounds(): number[] {
  const { s0, s1 } = MTN.cleft;
  const rng = makeRandom(5710);
  const out: number[] = [s0];
  for (let k = 1; k < SHELF.rows; k++) out.push(s0 + ((s1 - s0) * k) / SHELF.rows + (rng() - 0.5) * 0.7);
  out.push(s1);
  return out;
}

/** Shelf top height at (s, l): the route surface with a slight outward fall and a little relief. */
export function shelfTopY(s: number, l: number): number {
  const f = frameAt(s);
  const w = worldAt(s, l);
  return f.y - 0.04 * Math.max(0, l - 1.2) + (fbm(w.x * 0.9, w.z * 0.9, 91, 2) - 0.5) * 0.05;
}

// ---------------------------------------------------------------------------
// Ballistics
// ---------------------------------------------------------------------------

export interface Keyframe {
  t: number;
  x: number;
  y: number;
  z: number;
  /** rotation (Euler angles, radians) */
  rx: number;
  ry: number;
  rz: number;
}

const G = 9.81;

/**
 * Ballistic flight from (p, v) with spin, bouncing on the landform (restitution 0.38) and sliding down-slope when it
 * comes to rest on a steep face, so debris that lands on the ledge scar keeps tumbling into the valley.
 * Samples every `dt` for up to `maxT` seconds.
 */
export function flight(px: number, py: number, pz: number, vx: number, vy: number, vz: number, spin: [number, number, number], dt = 0.1, maxT = 9, clearance = 0.2): Keyframe[] {
  const out: Keyframe[] = [];
  let x = px;
  let y = py;
  let z = pz;
  let vxx = vx;
  let vyy = vy;
  let vzz = vz;
  for (let t = 0; t <= maxT; t += dt) {
    out.push({ t, x, y, z, rx: spin[0] * t, ry: spin[1] * t, rz: spin[2] * t });
    x += vxx * dt;
    z += vzz * dt;
    vyy -= G * dt;
    y += vyy * dt;
    const ground = terrainHeight(x, z) + clearance;
    if (y < ground) {
      y = ground;
      // down-slope direction (steepest descent) of the landform
      const gx = terrainHeight(x + 1, z) - terrainHeight(x - 1, z);
      const gz = terrainHeight(x, z + 1) - terrainHeight(x, z - 1);
      const gl = Math.hypot(gx, gz) || 1;
      const slope = gl / 2;
      vyy = Math.abs(vyy) > 1.2 ? -vyy * 0.38 : 0;
      const push = Math.min(4.5, 1.2 + slope * 3.2);
      const k = Math.max(0.45, Math.min(1, slope * 2));
      vxx = vxx * 0.78 - (gx / gl) * push * k;
      vzz = vzz * 0.78 - (gz / gl) * push * k;
    }
  }
  return out;
}

/** Sample a keyframe list at time t (linear), clamped at the ends. */
export function sample(k: Keyframe[], t: number): Keyframe {
  if (t <= k[0].t) return k[0];
  if (t >= k[k.length - 1].t) return k[k.length - 1];
  let i = 1;
  while (k[i].t < t) i++;
  const a = k[i - 1];
  const b = k[i];
  const u = (t - a.t) / (b.t - a.t);
  return { t, x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u, rx: a.rx + (b.rx - a.rx) * u, ry: a.ry + (b.ry - a.ry) * u, rz: a.rz + (b.rz - a.rz) * u };
}

export interface LipPiece {
  row: number;
  /** keyframes of the piece centre (relative to rest = absolute world positions), starting at the rest position */
  frames: Keyframe[];
  /** delay after the break before it lets go (s) */
  delay: number;
}

/** The tumbling lip pieces: one per row, thrown out towards the valley. */
export function lipFlights(): LipPiece[] {
  const rng = makeRandom(5720);
  const bounds = rowBounds();
  const lip = shelfLip();
  const out: LipPiece[] = [];
  for (let r = 0; r < SHELF.rows; r++) {
    const sMid = (bounds[r] + bounds[r + 1]) / 2;
    const l = (SHELF.rideEdge + lip) / 2;
    const p = worldAt(sMid, l);
    const f = frameAt(sMid);
    const dir = [f.nx * f.valley, f.nz * f.valley];
    const speed = 2.4 + rng() * 2.4;
    const frames = flight(p.x, shelfTopY(sMid, l) - SHELF.thickness / 2, p.z, dir[0] * speed + f.tx * (rng() - 0.5) * 1.2, -0.4, dir[1] * speed + f.tz * (rng() - 0.5) * 1.2, [(rng() - 0.5) * 3.2, (rng() - 0.5) * 2.0, (rng() - 0.5) * 3.2], 0.1, EVENT.debrisLife, 0.6);
    out.push({ row: r, frames, delay: r * 0.14 + rng() * 0.18 });
  }
  return out;
}

export const PEBBLES = 30;

export interface Pebble {
  /** time offset within the pebble shower (s), the shower repeats while the warning lasts */
  at: number;
  scale: number;
  frames: Keyframe[];
}

/**
 * Pebbles: fall ~8 m from the cliff above the shelf, hit the shelf (or the ledge beside it), bounce once and roll
 * off the lip into the valley. Phase 1 is a vertical drop, phase 2 a ballistic flight from the bounce.
 */
export function pebbleFlights(): Pebble[] {
  const rng = makeRandom(5730);
  const lip = shelfLip();
  const { s0, s1 } = MTN.cleft;
  const out: Pebble[] = [];
  for (let i = 0; i < PEBBLES; i++) {
    const s = s0 + 0.5 + rng() * (s1 - s0 - 1);
    const l = -3.2 + rng() * (lip + 2.6); // from the inner cliff foot out to the lip
    const p = worldAt(s, Math.max(-3.2, Math.min(lip - 0.3, l)));
    const top = shelfTopY(s, Math.max(-1.8, Math.min(lip - 0.5, l))) + 0.03;
    const h0 = top + 6.5 + rng() * 4;
    const f = frameAt(s);
    const frames: Keyframe[] = [];
    // phase 1: free fall to the shelf
    const tFall = Math.sqrt((2 * (h0 - top)) / G);
    for (let t = 0; t < tFall; t += 0.06) frames.push({ t, x: p.x, y: h0 - 0.5 * G * t * t, z: p.z, rx: t * 6, ry: 0, rz: t * 4 });
    frames.push({ t: tFall, x: p.x, y: top, z: p.z, rx: tFall * 6, ry: 0, rz: tFall * 4 });
    // phase 2: bounce, then off the lip (a gentle push towards the valley)
    const bv = Math.sqrt(2 * G * (h0 - top)) * 0.28;
    const kick = 1.0 + rng() * 2.4;
    const flightFrames = flight(p.x, top, p.z, f.nx * f.valley * kick + (rng() - 0.5) * 0.8, bv, f.nz * f.valley * kick + (rng() - 0.5) * 0.8, [rng() * 8, rng() * 8, rng() * 8], 0.06, 8, 0.15);
    for (const k of flightFrames.slice(1)) frames.push({ ...k, t: k.t + tFall });
    out.push({ at: (i / PEBBLES) * 5.2 + rng() * 0.3, scale: 0.07 + rng() * 0.09, frames });
  }
  return out;
}

/** Where does a lip piece (or pebble) end up? Used by the validator: never on the walkable route. */
export function endpoint(frames: Keyframe[]): { x: number; y: number; z: number } {
  const k = frames[frames.length - 1];
  return { x: k.x, y: k.y, z: k.z };
}

/** Is a world point on (or within `pad` of) the walkable route? */
export function onRoute(x: number, z: number, y: number, pad = 0.4): boolean {
  const h = routeNear(MTN, x, z);
  return h.dist < h.hw + pad && Math.abs(y - h.y) < 3;
}

void smoothstep;

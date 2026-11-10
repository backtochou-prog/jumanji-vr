/**
 * Birds: scarlet macaws, keel-billed toucans and small birds (parakeets, canaries, tanagers share one model, tinted), plus a few soaring birds over the mountain.
 *
 * Behaviour (a small state machine per bird, no physics, no pathfinding beyond one clear-line test):
 *   PERCHED  sits on a real bough/limb/log/pillar top: slow turns of the body, small bobs, now and then a call (and the sound engine plays it from the bird)
 *   CROUCH   the player came close (3D distance under the species' flush distance, scaled up when walking, down when standing still, with a per-bird
 *            sensitivity): a quarter-second crouch, flock-mates a fraction of a second later
 *   FLYING   follows a smooth Bezier from the perch to a far, free perch (landing flare, wings back out, settle); flap/glide cycle per species
 *   SOAR     mountain only: big slow circles over the valley with a few flaps
 * Also: spontaneous flights between distant perches ("landing on distant branches") and crossing flocks that pass through the player's view.
 * Resident birds live at fixed home perches (deterministic from seeds); crossing flocks use a small pool of transient birds.
 * Activation: only birds within their spawn distance are simulated; only those inside the view cone are written to the GPU rigs.
 */
import { Color, Euler, Matrix4, Quaternion, Vector3 } from '@iwsdk/core';
import { PATH_SAMPLES, makeRandom, smoothstep, terrainHeight, CLEARING } from '../world/layout.js';
import { SUMMIT, SUMMIT_DIR, BRIDGE } from '../world/mountain.js';
import { treePlacements } from '../world/placements.js';
import { distToPlayer, inCone, threatDist, wctx, wildlifeStats } from './context.js';
import { blockedAt, flightClear, obstacleOf, perches, perchesNear } from './perches.js';
import type { InstanceRig } from './rig.js';

/** Where the opening reveal's macaws look for the waterfall (its foot, world x/z): see IntroSystem. */
const STAGED_FALL: readonly [number, number] = [4.4, -92];

export const Sp = { Macaw: 0, Toucan: 1, Small: 2 } as const;
export type SpId = (typeof Sp)[keyof typeof Sp];
const St = { Perched: 0, Crouch: 1, Flying: 2, Soar: 3 } as const;

interface SpeciesDef {
  name: string;
  /** Body length beak to tail tip (m), base value; instances vary by +-8 %. */
  size: number;
  /** Wingspan as a multiple of the body length. */
  span: number;
  /** Chord of the inner wing segment as a multiple of the half-span. */
  chord: number;
  flapHz: number;
  /** Fraction of a flight spent gliding (flap/glide cycle). */
  glide: number;
  cruise: [number, number];
  /** Distance (m) at which a walking player makes it take off. */
  flush: number;
  /** Distance from which it is simulated / dropped. */
  spawn: number;
  /** Centre of the body above the perch surface, as a multiple of the body length. */
  lift: number;
  /** Perched body pitch (nose up, rad) - parrots and toucans sit upright, small birds more level. */
  perchPitch: number;
  shoulder: [number, number, number];
  callEvery: [number, number];
  call: 'macaw' | 'toucan' | 'parakeet' | 'songbird';
}

export const SPECIES: SpeciesDef[] = [
  { name: 'scarlet macaw', size: 0.84, span: 1.22, chord: 0.38, flapHz: 3.4, glide: 0.35, cruise: [9, 12], flush: 12, spawn: 80, lift: 0.17, perchPitch: 0.95, shoulder: [0.1, 0.07, 0.2], callEvery: [10, 34], call: 'macaw' },
  { name: 'keel-billed toucan', size: 0.5, span: 1.5, chord: 0.4, flapHz: 5.6, glide: 0.45, cruise: [7.5, 10], flush: 10, spawn: 65, lift: 0.2, perchPitch: 0.85, shoulder: [0.13, 0.08, 0.05], callEvery: [14, 45], call: 'toucan' },
  { name: 'small bird', size: 0.19, span: 1.62, chord: 0.36, flapHz: 9.5, glide: 0.18, cruise: [8, 11], flush: 6, spawn: 48, lift: 0.17, perchPitch: 0.5, shoulder: [0.15, 0.08, 0.12], callEvery: [6, 26], call: 'parakeet' },
];

/** Tints of the small birds (neutral body x tint): green parakeet, lemon canary, blue tanager. */
const SMALL_TINTS = ['#5fa83a', '#d8c23a', '#4a74c8', '#5fa83a'].map((h) => new Color(h));
const SMALL_WING = ['#3f7d2c', '#a89a2a', '#2d4f9c', '#3f7d2c'].map((h) => new Color(h));
const MACAW_WING_IN = new Color('#c8381e');
const MACAW_WING_OUT = new Color('#2d5fc0');
const TOUCAN_WING = new Color('#1e1c1a');
const WHITE = new Color(1, 1, 1);
const HAWK = new Color('#4a3a2c');
const HAWK_WING = new Color('#3a2e24');

export class Bird {
  id = 0;
  sp: SpId = Sp.Small;
  variant = 0;
  size = 0.19;
  span = 1.6;
  chord = 0.36;
  /** A transient bird of a crossing flock (assigned and released), vs a resident with a home perch. */
  transient = false;
  free = true;
  soarer = false;
  active = false;
  state: number = St.Perched;
  flock = 0;
  perch = -1;
  home = -1;
  x = 0;
  y = 0;
  z = 0;
  yaw = 0;
  pitch = 0;
  roll = 0;
  /** Seconds in the current state. */
  t = 0;
  phase = 0;
  /** Flap/glide: >0 gliding until this time. */
  glideUntil = 0;
  flapUntil = 0;
  nextCall = 0;
  nextIdle = 0;
  nextFly = 0;
  callAnim = 0;
  yawGoal = 0;
  sens = 1;
  flushAt = Infinity;
  cooldownUntil = 0;
  // flight path: cubic Bezier p0..p3 (x,y,z each) + progress
  b = new Float32Array(12);
  u = 0;
  len = 1;
  speed = 10;
  target = -1;
  landed = 0;
  // soar
  cx = 0;
  cz = 0;
  cy = 0;
  rad = 30;
  ang = 0;
  dir = 1;
  rng: () => number = Math.random;
}

// scratch
const _p = new Vector3();
const _q = new Quaternion();
const _e = new Euler();
const _bodyM = new Matrix4();
const _trM = new Matrix4();
const _wM = new Matrix4();
const _s = new Vector3();
const _c = new Vector3();
const _n = new Vector3();
const _sh = new Vector3();
const _one = new Vector3(1, 1, 1);
const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();

export interface BirdRigs {
  macaw: InstanceRig;
  toucan: InstanceRig;
  small: InstanceRig;
  wings: InstanceRig;
}

export class Birds {
  readonly birds: Bird[] = [];
  private readonly pool: Bird[] = [];
  private occupied: Int32Array;
  private readonly tmpPerch: number[] = [];
  /** Target searches done this frame: at most one, so a whole flock taking off never costs more than one search in a frame (the rest stay crouched a frame longer). */
  private picks = 0;
  private nextCross = 14;
  private crossIndex = 0;
  private flockSeq = 100;
  private readonly rngMain = makeRandom(60601);
  private readonly list = perches();
  /** Perches that are good for birds to sit on (not too low to be seen, not absurdly high). */
  private readonly seats: number[] = [];

  constructor() {
    this.occupied = new Int32Array(this.list.length).fill(-1);
    for (const p of this.list) if (p.above >= 2.2 && p.above <= 24) this.seats.push(p.id);
    this.populate();
  }

  // ------------------------------------------------------------------ population
  private populate(): void {
    const rng = makeRandom(31337);
    // candidate home perches, scored by "seen from the trail": near the trail polyline, mid height
    const near = (x: number, z: number) => {
      let d = 1e9;
      for (let i = 0; i < PATH_SAMPLES.length; i += 3) d = Math.min(d, Math.hypot(x - PATH_SAMPLES[i][0], z - PATH_SAMPLES[i][1]));
      return d;
    };
    const cands = this.seats.filter((id) => {
      const p = this.list[id];
      return near(p.x, p.z) < 30 || Math.hypot(p.x - CLEARING.x, p.z - CLEARING.z) < 24;
    });
    // shuffle deterministically, then order by "easy to see": low and close to the trail first (a bird 15 m up in a tree is a speck)
    for (let i = cands.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [cands[i], cands[j]] = [cands[j], cands[i]];
    }
    const key = new Map<number, number>();
    for (const id of cands) key.set(id, Math.abs(this.list[id].above - 6) * 0.5 + near(this.list[id].x, this.list[id].z) * 0.12 + rng() * 3);
    cands.sort((a, b) => key.get(a)! - key.get(b)!);
    const used: number[] = [];
    const take = (pred: (id: number) => boolean, minGap: number): number => {
      for (const id of cands) {
        if (used.includes(id)) continue;
        const p = this.list[id];
        if (!pred(id)) continue;
        if (used.some((u) => Math.hypot(this.list[u].x - p.x, this.list[u].y - p.y, this.list[u].z - p.z) < minGap)) continue;
        used.push(id);
        return id;
      }
      return -1;
    };
    const add = (sp: SpId, perch: number, variant: number, flock: number): void => {
      if (perch < 0) return;
      const b = new Bird();
      b.id = this.birds.length;
      b.sp = sp;
      b.variant = variant;
      b.flock = flock;
      b.rng = makeRandom(7000 + this.birds.length * 131);
      this.configure(b);
      b.home = perch;
      b.sens = 0.75 + 0.5 * b.rng();
      this.seat(b, perch);
      b.nextCall = 3 + b.rng() * 25;
      b.nextIdle = 2 + b.rng() * 6;
      b.nextFly = 35 + b.rng() * 90;
      this.birds.push(b);
    };
    const sameBoughNear = (id: number, minGap: number, maxGap: number): number => {
      const p = this.list[id];
      for (const q of this.list) {
        if (q.id === id || used.includes(q.id) || q.group !== p.group) continue;
        const d = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
        if (d >= minGap && d <= maxGap && q.above >= 2.2) {
          used.push(q.id);
          return q.id;
        }
      }
      return -1;
    };
    // macaw pairs (they sit close together) x3
    for (let k = 0; k < 3; k++) {
      const a = take((id) => this.list[id].above >= 3.5 && this.list[id].above <= 14 && this.list[id].kind !== 'log', 18);
      if (a < 0) continue;
      add(Sp.Macaw, a, 0, 10 + k);
      add(Sp.Macaw, sameBoughNear(a, 0.8, 4.5), 0, 10 + k);
    }
    // toucans: singles and a pair
    for (let k = 0; k < 4; k++) {
      const a = take((id) => this.list[id].above >= 3.5 && this.list[id].above <= 14, 14);
      add(Sp.Toucan, a, 0, 20 + k);
      if (k === 1) add(Sp.Toucan, sameBoughNear(a, 1, 4), 0, 20 + k);
    }
    // small birds in loose flocks of 3-4 (the tail of the list is the low, close perches along the trail)
    for (let k = 0; k < 5; k++) {
      const a = take((id) => this.list[id].above >= 2.5 && this.list[id].above <= 12, 10);
      if (a < 0) continue;
      const tint = k % 4;
      add(Sp.Small, a, tint, 30 + k);
      for (let m = 0; m < 2 + (k % 2); m++) add(Sp.Small, sameBoughNear(a, 0.5, 4.8), tint, 30 + k);
    }
    // a few small birds on the low log / pillar / entrance limb (close enough to approach)
    for (const id of this.list.filter((p) => p.kind !== 'bough').map((p) => p.id)) {
      if (used.includes(id) || rng() > 0.55) continue;
      used.push(id);
      add(Sp.Small, id, 1 + (id % 3), 40 + id);
    }
    // mountain soarers
    const soar = (cx: number, cz: number, cy: number, rad: number, dir: number, seed: number): void => {
      const b = new Bird();
      b.id = this.birds.length;
      b.soarer = true;
      b.sp = Sp.Small;
      b.size = 0.62;
      b.span = 2.7;
      b.chord = 0.3;
      b.variant = 9;
      b.cx = cx;
      b.cz = cz;
      b.cy = cy;
      b.rad = rad;
      b.dir = dir;
      b.rng = makeRandom(seed);
      b.ang = b.rng() * 6.28;
      b.state = St.Soar;
      b.speed = 8 + b.rng() * 2;
      this.birds.push(b);
    };
    const sx = SUMMIT.x + SUMMIT_DIR[0] * 48;
    const sz = SUMMIT.z + SUMMIT_DIR[1] * 48;
    soar(sx, sz, 19, 40, 1, 901);
    soar(sx + 15, sz - 10, 26, 52, -1, 902);
    soar((BRIDGE.ax + BRIDGE.bx) / 2, BRIDGE.az, BRIDGE.y + 15, 30, 1, 903);
    soar(190, -100, -4, 62, -1, 904);
    // transient pool for crossing flocks
    for (let i = 0; i < 9; i++) {
      const b = new Bird();
      b.id = this.birds.length;
      b.transient = true;
      b.free = true;
      b.rng = makeRandom(8000 + i * 17);
      this.pool.push(b);
      this.birds.push(b);
    }
  }

  private configure(b: Bird): void {
    const def = SPECIES[b.sp];
    b.size = def.size * (0.94 + 0.12 * b.rng());
    b.span = def.span;
    b.chord = def.chord;
  }

  /** Put a bird on a perch (no animation). */
  private seat(b: Bird, perch: number): void {
    const p = this.list[perch];
    const def = SPECIES[b.sp];
    if (b.perch >= 0 && this.occupied[b.perch] === b.id) this.occupied[b.perch] = -1;
    b.perch = perch;
    this.occupied[perch] = b.id;
    b.state = St.Perched;
    b.t = 0;
    // face along the branch (either way) or across it, so a pair on one bough looks natural
    const along = Math.atan2(p.dx, p.dz);
    b.yaw = along + (b.rng() < 0.5 ? 0 : Math.PI) + (b.rng() - 0.5) * 0.5;
    b.yawGoal = b.yaw;
    b.pitch = -def.perchPitch;
    b.roll = 0;
    b.x = p.x;
    b.z = p.z;
    b.y = p.y + def.lift * b.size + 0.0;
    b.u = 0;
  }

  // ------------------------------------------------------------------ flights
  /** Choose a free perch for a bird that is leaving. `away`: prefer far from the player. */
  private pickTarget(b: Bird, minFromPlayer: number, maxFromBird: number): number {
    const list = this.list;
    const def = SPECIES[b.sp];
    const me = b.id;
    const near = perchesNear(b.x, b.z, maxFromBird);
    const n = near.length;
    if (!n) return -1;
    const ig = b.perch >= 0 ? obstacleOf(list[b.perch]) : -1;
    const minAbove = b.sp === Sp.Small ? 2.4 : 5;
    const start = Math.floor(b.rng() * n);
    let best = -1;
    let bestScore = -1e9;
    let tries = 0;
    for (let k = 0; k < n && tries < 8; k++) {
      const id = near[(start + k * 7) % n];
      if (id === b.perch) continue;
      const q = list[id];
      if (q.above < minAbove || q.above > 24) continue;
      if (this.occupied[id] >= 0 && this.occupied[id] !== me) continue;
      const dFromBird = Math.hypot(q.x - b.x, q.y - b.y, q.z - b.z);
      if (dFromBird < 14 || dFromBird > maxFromBird) continue;
      const dp = distToPlayer(q.x, q.y, q.z);
      if (dp < minFromPlayer) continue;
      tries++;
      if (!flightClear(b.x, b.y + 0.5, b.z, q.x, q.y + 0.6, q.z, 0.8, ig, obstacleOf(q))) continue;
      // prefer perches the player can see (in front) and that are not right next to the player
      const score = -Math.abs(dp - 38) * 0.1 + (inCone(q.x, q.y, q.z, 2) ? 3 : 0) + b.rng() * 2 - def.size;
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    }
    return best;
  }

  private startFlight(b: Bird, target: number, speed?: number): void {
    const q = this.list[target];
    const def = SPECIES[b.sp];
    if (b.perch >= 0 && this.occupied[b.perch] === b.id) this.occupied[b.perch] = -1;
    b.perch = -1;
    b.target = target;
    this.occupied[target] = b.id;
    const tx = q.x;
    const ty = q.y + def.lift * b.size;
    const tz = q.z;
    const dx = tx - b.x;
    const dz = tz - b.z;
    const L = Math.hypot(dx, dz) || 1;
    const hx = dx / L;
    const hz = dz / L;
    const rise = Math.min(6, 1.5 + L * 0.06);
    const B = b.b;
    B[0] = b.x;
    B[1] = b.y;
    B[2] = b.z;
    // leave climbing, level out over the middle, drop onto the perch from slightly above
    B[3] = b.x + hx * L * 0.3 + (b.rng() - 0.5) * L * 0.12;
    B[4] = b.y + rise + (ty - b.y) * 0.1;
    B[5] = b.z + hz * L * 0.3 + (b.rng() - 0.5) * L * 0.12;
    B[6] = tx - hx * L * 0.3;
    B[7] = ty + Math.min(4, L * 0.07);
    B[8] = tz - hz * L * 0.3;
    B[9] = tx;
    B[10] = ty;
    B[11] = tz;
    b.len = Math.hypot(tx - b.x, ty - b.y, tz - b.z) * 1.08;
    b.u = 0;
    b.t = 0;
    b.state = St.Flying;
    b.speed = speed ?? def.cruise[0] + (def.cruise[1] - def.cruise[0]) * b.rng();
    b.landed = 0;
    b.glideUntil = 0;
    b.flapUntil = wctx.time + 1.2;
  }

  /** Free-flying path (crossing flocks): from a start point to an end point at height, no perch. */
  private startCross(b: Bird, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, speed: number, wob: number): void {
    const B = b.b;
    const dx = x1 - x0;
    const dz = z1 - z0;
    B[0] = x0;
    B[1] = y0;
    B[2] = z0;
    B[3] = x0 + dx * 0.33 - dz * wob;
    B[4] = y0 + (y1 - y0) * 0.33 + 1.5;
    B[5] = z0 + dz * 0.33 + dx * wob;
    B[6] = x0 + dx * 0.66 + dz * wob;
    B[7] = y0 + (y1 - y0) * 0.66 - 1;
    B[8] = z0 + dz * 0.66 - dx * wob;
    B[9] = x1;
    B[10] = y1;
    B[11] = z1;
    b.len = Math.hypot(dx, y1 - y0, dz) * 1.04;
    b.u = 0;
    b.t = 0;
    b.state = St.Flying;
    b.target = -1;
    b.speed = speed;
    b.landed = 0;
    b.x = x0;
    b.y = y0;
    b.z = z0;
    b.free = false;
    b.active = true;
  }

  private bezier(b: Bird, u: number, out: Vector3): Vector3 {
    const B = b.b;
    const w = 1 - u;
    const a = w * w * w;
    const c = 3 * w * w * u;
    const d = 3 * w * u * u;
    const e = u * u * u;
    return out.set(a * B[0] + c * B[3] + d * B[6] + e * B[9], a * B[1] + c * B[4] + d * B[7] + e * B[10], a * B[2] + c * B[5] + d * B[8] + e * B[11]);
  }

  private bezierD(b: Bird, u: number, out: Vector3): Vector3 {
    const B = b.b;
    const w = 1 - u;
    const a = 3 * w * w;
    const c = 6 * w * u;
    const d = 3 * u * u;
    return out.set(a * (B[3] - B[0]) + c * (B[6] - B[3]) + d * (B[9] - B[6]), a * (B[4] - B[1]) + c * (B[7] - B[4]) + d * (B[10] - B[7]), a * (B[5] - B[2]) + c * (B[8] - B[5]) + d * (B[11] - B[8]));
  }

  // ------------------------------------------------------------------ per frame
  update(dt: number, maxActive: number, rigs: BirdRigs): void {
    const now = wctx.time;
    const low = wctx.low;
    const cap = Math.min(maxActive, low ? 12 : 22);
    const open = wctx.open;
    this.picks = 0;
    let activeCount = 0;
    wildlifeStats.active.macaw = wildlifeStats.active.toucan = wildlifeStats.active.small = 0;
    wildlifeStats.flying = 0;
    wildlifeStats.perched = 0;

    // crossing flocks: scheduled, deterministic order, only in the jungle
    if (wctx.intro === 'cross' && open < 0.3 && this.spawnStagedCrossing()) wctx.intro = 'done';
    if (now >= this.nextCross && open < 0.3 && wctx.intro !== 'hold' && wctx.intro !== 'cross') {
      this.spawnCrossingFlock();
      this.crossIndex++;
      // 25-70 s, a little more often while the player stands still (the jungle "goes on" around them)
      const r = makeRandom(5000 + this.crossIndex)();
      this.nextCross = now + (wctx.still ? 20 : 28) + r * 42;
    }

    for (const b of this.birds) {
      if (b.soarer) {
        this.updateSoarer(b, dt);
        continue;
      }
      if (b.transient) {
        if (b.free) continue;
        // transient birds are always simulated while they exist
      } else {
        // resident: activate / deactivate by distance
        const def = SPECIES[b.sp];
        const ref = b.perch >= 0 ? this.list[b.perch] : null;
        const d = ref ? distToPlayer(ref.x, ref.y, ref.z) : distToPlayer(b.x, b.y, b.z);
        const was = b.active;
        const on = open < 0.45 && wctx.enabled && (was ? d < def.spawn + 14 : d < def.spawn) && activeCount < cap;
        if (on !== was) {
          b.active = on;
          if (!on) {
            // freeze at a perch: a bird that was in the air when it despawned simply sits where it was heading
            if (b.state === St.Flying && b.target >= 0) this.seat(b, b.target);
            else if (b.state !== St.Perched) this.seat(b, b.perch >= 0 ? b.perch : b.home);
          } else {
            b.nextCall = now + 1 + b.rng() * 10;
            b.nextFly = now + 30 + b.rng() * 70;
          }
        }
        if (!b.active) continue;
      }
      activeCount++;
      this.step(b, dt, now);
      if (b.state === St.Flying) wildlifeStats.flying++;
      else wildlifeStats.perched++;
      if (b.sp === Sp.Macaw) wildlifeStats.active.macaw++;
      else if (b.sp === Sp.Toucan) wildlifeStats.active.toucan++;
      else wildlifeStats.active.small++;
    }

    // draw
    rigs.macaw.begin();
    rigs.toucan.begin();
    rigs.small.begin();
    rigs.wings.begin();
    let drawn = 0;
    for (const b of this.birds) {
      if (!(b.active || (b.soarer && this.soarerOn(b)))) continue;
      if (!inCone(b.x, b.y, b.z, b.size * 1.5)) continue;
      this.draw(b, rigs);
      drawn++;
    }
    rigs.macaw.end();
    rigs.toucan.end();
    rigs.small.end();
    rigs.wings.end();
    wildlifeStats.drawn.birds = drawn;
  }

  private step(b: Bird, dt: number, now: number): void {
    const def = SPECIES[b.sp];
    b.t += dt;
    switch (b.state) {
      case St.Perched: {
        // idle: occasionally turn, small bobs
        if (now >= b.nextIdle) {
          b.nextIdle = now + 2 + b.rng() * 7;
          b.yawGoal = b.yaw + (b.rng() - 0.5) * (b.rng() < 0.3 ? 2.4 : 0.9);
        }
        b.yaw += (b.yawGoal - b.yaw) * Math.min(1, dt * 2.2);
        if (b.callAnim > 0) b.callAnim = Math.max(0, b.callAnim - dt);
        // calls
        if (now >= b.nextCall) {
          b.nextCall = now + def.callEvery[0] + (def.callEvery[1] - def.callEvery[0]) * b.rng();
          // quieter while the player is very close or birds were just disturbed
          b.callAnim = 0.55;
          wctx.audio.call(def.call, b.x, b.y, b.z, b.sp === Sp.Macaw ? 1 : b.sp === Sp.Toucan ? 0.85 : 0.55);
        }
        // reaction to the player
        const d = threatDist(b.x, b.y, b.z);
        const pace = 0.55 + 0.45 * Math.min(1, wctx.speed / 1.6);
        const reach = def.flush * b.sens * pace;
        if (now >= b.flushAt || (d < reach && now >= b.cooldownUntil)) {
          if (b.flushAt === Infinity) this.flushFlock(b, now);
          b.state = St.Crouch;
          b.t = 0;
          b.flushAt = Infinity;
        } else if (b.perch >= 0 && now >= b.nextFly && !b.transient) {
          // a voluntary hop to a distant branch (every ~1-2 minutes), only if nobody is next to it
          b.nextFly = now + 45 + b.rng() * 120;
          const tgt = this.pickTarget(b, 18, 70);
          if (tgt >= 0) {
            b.state = St.Crouch;
            b.t = 0;
            b.target = tgt;
            b.flushAt = Infinity;
          }
        }
        break;
      }
      case St.Crouch: {
        // crouch and look: pitch forward, then spring
        const k = Math.min(1, b.t / 0.28);
        b.pitch = -def.perchPitch * (1 - k) + 0.1 * k;
        if (b.t >= 0.28 && this.picks < 1) {
          this.picks++;
          let tgt = b.target;
          if (tgt < 0 || this.occupied[tgt] >= 0) tgt = this.pickTarget(b, 22, 75);
          if (tgt < 0) tgt = this.pickTarget(b, 8, 90);
          if (tgt >= 0) {
            b.target = -1;
            this.startFlight(b, tgt, def.cruise[0] + (def.cruise[1] - def.cruise[0]) * b.rng() + 1.5);
            b.flapUntil = now + 2;
          } else {
            // nowhere clear to go: settle back down and calm down for a while
            b.state = St.Perched;
            b.cooldownUntil = now + 20;
            b.pitch = -def.perchPitch;
          }
        }
        break;
      }
      case St.Flying: {
        this.fly(b, dt, now, def);
        break;
      }
      default:
        break;
    }
  }

  private fly(b: Bird, dt: number, now: number, def: SpeciesDef): void {
    // speed profile: quick take-off acceleration, cruise, slow landing
    const landing = b.target >= 0;
    const ramp = smoothstep(0, 0.14, b.u) * 0.55 + 0.45;
    const brake = landing ? 0.38 + 0.62 * (1 - smoothstep(0.78, 1, b.u)) : 1;
    const v = b.speed * ramp * brake;
    this.bezierD(b, b.u, _v1);
    const dl = Math.max(0.5, _v1.length());
    b.u += (v * dt) / dl;
    if (b.u >= 1) {
      b.u = 1;
      if (landing) {
        this.seat(b, b.target);
        b.target = -1;
        b.cooldownUntil = now + 25;
        b.landed = 0;
        b.nextFly = now + 40 + b.rng() * 80;
        return;
      }
      // crossing flock reached its end: release
      b.active = false;
      b.free = true;
      return;
    }
    this.bezier(b, b.u, _p);
    this.bezierD(b, b.u, _v1);
    b.x = _p.x;
    b.y = _p.y;
    b.z = _p.z;
    const hs = Math.hypot(_v1.x, _v1.z);
    const yawT = Math.atan2(_v1.x, _v1.z);
    let dy = yawT - b.yaw;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    b.yaw += dy * Math.min(1, dt * 6);
    const climb = Math.atan2(_v1.y, Math.max(0.01, hs));
    const flare = landing ? smoothstep(0.84, 1, b.u) * 0.9 : 0;
    b.pitch = -climb * 0.9 + 0.0 - flare;
    b.roll += (-dy * 1.1 - b.roll) * Math.min(1, dt * 4);
    // flap / glide cycle
    if (now >= b.flapUntil && now >= b.glideUntil && !(landing && b.u > 0.8) && b.u > 0.12) {
      if (b.rng() < def.glide) b.glideUntil = now + 0.5 + b.rng() * 0.9;
      b.flapUntil = now + 1.1 + b.rng() * 1.2;
    }
    const gliding = now < b.glideUntil && b.u < 0.82;
    const hz = def.flapHz * (landing && b.u > 0.82 ? 1.25 : b.u < 0.12 ? 1.3 : 1);
    if (!gliding) b.phase += dt * hz * Math.PI * 2;
  }

  private updateSoarer(b: Bird, dt: number): void {
    const d = Math.hypot(b.cx - wctx.px, b.cz - wctx.pz);
    const on = wctx.enabled && wctx.open > 0.2 && d < 230;
    b.active = on;
    if (!on) return;
    b.ang += (dt * b.speed * b.dir) / b.rad;
    const a = b.ang;
    b.x = b.cx + Math.cos(a) * b.rad;
    b.z = b.cz + Math.sin(a) * b.rad;
    const ground = terrainHeight(b.x, b.z);
    b.y = Math.max(ground + 9, b.cy + Math.sin(wctx.time * 0.11 + b.rad) * 4);
    // tangent heading
    const tx = -Math.sin(a) * b.dir;
    const tz = Math.cos(a) * b.dir;
    b.yaw = Math.atan2(tx, tz);
    b.pitch = 0.06 * Math.sin(wctx.time * 0.3 + b.rad);
    b.roll = -0.32 * b.dir;
    // a few flaps now and then, otherwise held wings
    const cyc = (wctx.time * 0.12 + b.rad) % 1;
    if (cyc < 0.16) b.phase += dt * 5 * Math.PI * 2;
  }

  private soarerOn(b: Bird): boolean {
    return b.active;
  }

  // ------------------------------------------------------------------ reactions and scheduling
  private flushFlock(b: Bird, now: number): void {
    wildlifeStats.flushes++;
    wctx.audio.call('alarm', b.x, b.y, b.z, b.sp === Sp.Macaw ? 1 : 0.7);
    wctx.audio.hush(7, b.sp === Sp.Small ? 0.45 : 0.7);
    for (const o of this.birds) {
      if (o === b || !o.active || o.state !== St.Perched || o.transient || o.soarer) continue;
      const near = o.flock === b.flock || Math.hypot(o.x - b.x, o.y - b.y, o.z - b.z) < 12;
      if (near && o.flushAt === Infinity) o.flushAt = now + 0.1 + o.rng() * 0.7;
    }
  }

  /** Developer/test hook: make every active bird within `radius` of the player take off now. */
  flushNear(radius: number): number {
    let n = 0;
    for (const b of this.birds) {
      if (!b.active || b.soarer || b.state !== St.Perched) continue;
      if (distToPlayer(b.x, b.y, b.z) <= radius) {
        b.flushAt = wctx.time;
        b.cooldownUntil = 0;
        n++;
      }
    }
    return n;
  }

  /** A flock crosses the player's view: starts ahead-left or ahead-right at ~65 m, passes within 8-16 m of the player at 9-22 m height, ends behind. */
  private spawnCrossingFlock(): void {
    const free = this.pool.filter((b) => b.free);
    if (free.length < 2) return;
    const rng = makeRandom(9100 + this.crossIndex * 7);
    const roll = rng();
    const sp: SpId = roll < 0.4 ? Sp.Small : roll < 0.75 ? Sp.Macaw : Sp.Toucan;
    const n = Math.min(free.length, sp === Sp.Small ? 3 + Math.floor(rng() * 4) : sp === Sp.Macaw ? 2 : 1 + Math.floor(rng() * 2));
    // candidate lanes: perpendicular passes in front of the view, then along-the-trail passes
    const fx = wctx.fx;
    const fz = wctx.fz;
    const fl = Math.hypot(fx, fz) || 1;
    const hx = fx / fl;
    const hz = fz / fl;
    const sx = -hz; // left of the view
    const sz = hx;
    const side = rng() < 0.5 ? -1 : 1;
    const heightAbove = 9 + rng() * 12;
    const gx = wctx.gy;
    let found = false;
    let x0 = 0;
    let z0 = 0;
    let x1 = 0;
    let z1 = 0;
    for (let tries = 0; tries < 8 && !found; tries++) {
      const ahead = 14 + tries * 3 + rng() * 10; // where the lane crosses the view axis
      const half = 52 + rng() * 14;
      const cx = wctx.px + hx * ahead;
      const cz = wctx.pz + hz * ahead;
      x0 = cx + sx * half * side;
      z0 = cz + sz * half * side;
      x1 = cx - sx * half * side;
      z1 = cz - sz * half * side;
      const y = gx + heightAbove;
      if (flightClear(x0, y, z0, x1, y, z1, 1.2)) found = true;
    }
    if (!found) {
      // fall back to a lane along the trail corridor (kept free of trunks by construction), flying over the player
      let bi = 0;
      let bd = 1e9;
      for (let i = 0; i < PATH_SAMPLES.length; i++) {
        const d = Math.hypot(PATH_SAMPLES[i][0] - wctx.px, PATH_SAMPLES[i][1] - wctx.pz);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
      const dir = rng() < 0.5 ? 1 : -1;
      const a = PATH_SAMPLES[Math.max(0, Math.min(PATH_SAMPLES.length - 1, bi - dir * 40))];
      const c = PATH_SAMPLES[Math.max(0, Math.min(PATH_SAMPLES.length - 1, bi + dir * 40))];
      x0 = a[0];
      z0 = a[1];
      x1 = c[0];
      z1 = c[1];
      if (Math.hypot(x1 - x0, z1 - z0) < 20) return;
    }
    const y0 = gx + heightAbove;
    const y1 = gx + heightAbove + (rng() - 0.5) * 5;
    const speed = sp === Sp.Small ? 9 + rng() * 3 : sp === Sp.Macaw ? 8 + rng() * 2 : 7 + rng() * 2;
    const flock = this.flockSeq++;
    const dx = x1 - x0;
    const dz = z1 - z0;
    const L = Math.hypot(dx, dz) || 1;
    for (let i = 0; i < n; i++) {
      const b = free[i];
      b.sp = sp;
      b.variant = Math.floor(rng() * 4);
      b.flock = flock;
      this.configure(b);
      // a loose V: each bird trails and offsets sideways
      const lag = i * (1.5 + rng() * 1.5);
      const off = (i % 2 ? 1 : -1) * Math.ceil(i / 2) * (1.0 + rng() * 0.8);
      const ox = (-dz / L) * off - (dx / L) * lag;
      const oz = (dx / L) * off - (dz / L) * lag;
      this.startCross(b, x0 + ox, y0 + (rng() - 0.5) * 1.5, z0 + oz, x1 + ox, y1 + (rng() - 0.5) * 1.5, z1 + oz, speed * (0.95 + 0.1 * rng()), 0.04 * (rng() - 0.5));
      b.phase = rng() * 6.28;
      b.flapUntil = wctx.time + 1 + rng();
      b.glideUntil = 0;
      b.transient = true;
    }
    wildlifeStats.crossingFlocks++;
    // a short call as the flock appears
    wctx.audio.call(SPECIES[sp].call, x0 + dx * 0.15, y0, z0 + dz * 0.15, sp === Sp.Small ? 0.5 : 0.9);
  }

  /**
   * The opening reveal's staged crossing (IntroSystem sets wctx.intro = 'cross'): two scarlet macaws fly slowly across the sky in front of the waterfall, from the
   * right to the left, 30-55 m ahead and 6-14 m above the player's eyes (so they pass over the lower half of the fall), no matter where the player is looking
   * (their call as they appear turns the head). Returns true when it is over with (flown, or no clear lane exists: the reveal then simply has no birds);
   * false = try again next frame (not enough free transient birds yet).
   */
  private spawnStagedCrossing(): boolean {
    const free = this.pool.filter((b) => b.free);
    if (free.length < 2) return false;
    const ax = STAGED_FALL[0] - wctx.px;
    const az = STAGED_FALL[1] - wctx.pz;
    const al = Math.hypot(ax, az) || 1;
    const hx = ax / al;
    const hz = az / al;
    const rx = -hz; // right of the bearing to the fall
    const rz = hx;
    const rng = makeRandom(9777);
    const half = 36;
    let found = false;
    let x0 = 0;
    let z0 = 0;
    let x1 = 0;
    let z1 = 0;
    let y = 0;
    for (const ahead of [46, 38, 54, 32]) {
      for (const rise of [8.5, 11, 6]) {
        const cx = wctx.px + hx * ahead;
        const cz = wctx.pz + hz * ahead;
        x0 = cx + rx * half;
        z0 = cz + rz * half;
        x1 = cx - rx * half;
        z1 = cz - rz * half;
        y = wctx.py + rise;
        if (flightClear(x0, y, z0, x1, y, z1, 1.4)) {
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (!found) return true;
    const flock = this.flockSeq++;
    const dx = x1 - x0;
    const dz = z1 - z0;
    const L = Math.hypot(dx, dz) || 1;
    for (let i = 0; i < 2; i++) {
      const b = free[i];
      b.sp = Sp.Macaw;
      b.variant = i;
      b.flock = flock;
      this.configure(b);
      // a pair: the second a few metres behind and to the side
      const lag = i * 3.2;
      const off = i * 1.3;
      const ox = (-dz / L) * off - (dx / L) * lag;
      const oz = (dx / L) * off - (dz / L) * lag;
      this.startCross(b, x0 + ox, y + i * 0.6, z0 + oz, x1 + ox, y + 1.5 + i * 0.4, z1 + oz, 7.4 + 0.5 * i, 0.02 * (rng() - 0.5));
      b.phase = rng() * 6.28;
      b.flapUntil = wctx.time + 1 + rng();
      b.glideUntil = 0;
      b.transient = true;
    }
    wildlifeStats.crossingFlocks++;
    this.nextCross = Math.max(this.nextCross, wctx.time + 30);
    wctx.audio.call('macaw', x0 + dx * 0.12, y, z0 + dz * 0.12, 0.85);
    return true;
  }

  // ------------------------------------------------------------------ drawing
  private draw(b: Bird, rigs: BirdRigs): void {
    const def = SPECIES[b.sp];
    const d = distToPlayer(b.x, b.y, b.z);
    const detail = d < 30 ? 2 : 1;
    const s = b.size;
    let pitch = b.pitch;
    let y = b.y;
    if (b.state === St.Perched && b.callAnim > 0) {
      // a call: the head and chest lift and the body pulses once
      const k = Math.sin((1 - b.callAnim / 0.55) * Math.PI);
      pitch -= 0.28 * k;
      y += 0.02 * k * s;
    } else if (b.state === St.Perched) {
      pitch += 0.025 * Math.sin(wctx.time * 1.7 + b.x);
    }
    _e.set(pitch, b.yaw, b.roll, 'YXZ');
    _q.setFromEuler(_e);
    _trM.compose(_p.set(b.x, y, b.z), _q, _one);
    _s.set(s, s, s);
    _bodyM.compose(_p.set(b.x, y, b.z), _q, _s);
    const body = b.sp === Sp.Macaw ? rigs.macaw : b.sp === Sp.Toucan ? rigs.toucan : rigs.small;
    if (b.sp === Sp.Small) body.push(_bodyM, b.soarer ? HAWK : SMALL_TINTS[b.variant % SMALL_TINTS.length]);
    else body.push(_bodyM, WHITE);

    // wings
    const hs = (s * b.span) / 2;
    const inner = hs * 0.46;
    const outer = hs * 0.54;
    const chordIn = hs * b.chord * (b.soarer ? 1.1 : 1);
    const chordOut = chordIn * 0.78;
    const flying = b.state === St.Flying || b.state === St.Soar;
    const gliding = flying && wctx.time < b.glideUntil;
    const crouch = b.state === St.Crouch;
    let amp = 0;
    if (flying) {
      amp = gliding ? 0.18 : b.state === St.Soar ? 0.12 : b.u < 0.14 ? 1.05 : 0.75;
      if (b.sp === Sp.Small && !b.soarer) amp *= 0.85;
    }
    const fold = flying ? 0 : crouch ? Math.min(1, 1 - b.t / 0.28) * 0.55 : 1;
    const sh = def.shoulder;
    const cIn = b.sp === Sp.Macaw ? MACAW_WING_IN : b.sp === Sp.Toucan ? TOUCAN_WING : b.soarer ? HAWK_WING : SMALL_WING[b.variant % SMALL_WING.length];
    const cOut = b.sp === Sp.Macaw ? MACAW_WING_OUT : b.sp === Sp.Toucan ? TOUCAN_WING : b.soarer ? HAWK_WING : SMALL_WING[b.variant % SMALL_WING.length];
    for (let side = -1; side <= 1; side += 2) {
      _sh.set(sh[0] * side * s, sh[1] * s, sh[2] * s).applyMatrix4(_trM);
      if (!flying) {
        // folded (perched) or opening (the crouch before take-off)
        this.spanDir(_n, _c, side, 0, true, fold);
        this.place(rigs.wings, _sh, _n, _c, inner + outer, chordIn, cIn);
      } else if (detail === 1) {
        const a = amp * Math.sin(b.phase) + 0.05;
        this.spanDir(_n, _c, side, a, false, 0);
        this.place(rigs.wings, _sh, _n, _c, inner + outer, chordIn * 0.95, cIn);
      } else {
        const a1 = amp * Math.sin(b.phase) + 0.06;
        const flex = amp * 0.7 * Math.sin(b.phase - 0.95);
        this.spanDir(_n, _c, side, a1, false, 0);
        _v2.copy(_n); // world direction of the inner segment: the elbow is `inner` along it
        this.place(rigs.wings, _sh, _n, _c, inner, chordIn, cIn);
        _v1.copy(_sh).addScaledVector(_v2, inner);
        this.spanDir(_n, _c, side, a1 + flex, false, 0);
        this.place(rigs.wings, _v1, _n, _c, outer, chordOut, cOut);
      }
    }
  }

  /**
   * Span (S) and leading-edge (C) directions of one wing in the WORLD frame (the body's rotation is applied).
   * Flying: out and up by angle `a`, trailing slightly back. Folded: laid back along the flank (`fold` 1) .. fully spread (0).
   */
  private spanDir(S: Vector3, C: Vector3, side: number, a: number, folded: boolean, fold: number): void {
    if (folded) {
      const k = Math.min(1, fold);
      C.set(side, 0, 0);
      S.set(side * (0.9 * (1 - k) + 0.07 * k), 0.1 + 0.2 * (1 - k), -0.2 - 0.8 * k).normalize();
    } else {
      S.set(side * Math.cos(a), Math.sin(a), -0.2).normalize();
      C.set(0, 0, 1);
    }
    C.addScaledVector(S, -C.dot(S)).normalize();
    S.applyQuaternion(_q);
    C.applyQuaternion(_q);
  }

  /** Push one wing segment: root at `root`, span along S (length `len` m), leading edge along C (chord `chord` m); normal = C x S (the underside is the same surface: double-sided). */
  private place(rig: InstanceRig, root: Vector3, S: Vector3, C: Vector3, len: number, chord: number, color: Color): void {
    _v3.crossVectors(C, S);
    _wM.makeBasis(_s.copy(S).multiplyScalar(len), _v3, _p.copy(C).multiplyScalar(chord));
    _wM.setPosition(root);
    rig.push(_wM, color);
  }

  /** Free every transient bird and clear flushes (tests, quality changes). */
  reset(): void {
    for (const b of this.pool) {
      b.free = true;
      b.active = false;
    }
  }

  /** Count of birds in each state (tests). */
  snapshot(): { id: number; sp: number; state: number; x: number; y: number; z: number; active: boolean; transient: boolean; soarer: boolean; perch: number }[] {
    return this.birds.map((b, i) => ({ id: i, sp: b.sp, state: b.state, x: b.x, y: b.y, z: b.z, active: b.active, transient: b.transient && !b.free, soarer: b.soarer, perch: b.perch }));
  }

  /** Perch data for validation. */
  homePerches(): number[] {
    return this.birds.filter((b) => !b.transient && !b.soarer).map((b) => b.home);
  }
}

export { treePlacements, blockedAt };

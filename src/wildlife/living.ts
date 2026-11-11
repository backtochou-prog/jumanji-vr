/**
 * The living world: the small things that make the jungle react. Every class here is a tiny pooled simulation with a fixed capacity, created once and
 * recycled forever (nothing is allocated after construction, nothing is ever added to the scene later), and each is plain data + arithmetic so it can be
 * stepped in node by tools/living-test.mjs. LivingWorldSystem owns the instances, feeds them the weather and the player (through `wctx`), and hands them
 * the InstanceRigs / point cloud to write into.
 *
 *   Stride         turns the distance the player walks into footfalls (left, right, ...); a teleport or a snap is never a step.
 *   FallingLeaves  leaves shaken loose under the canopy: more in a gust, fluttering down-wind, lying on the ground (or floating) for a while, then gone.
 *   Motes          pollen/dust that lights up where the canopy is open, drifting with the wind in a volume that travels with the player, plus the
 *                  embers that spiral slowly in toward the Heartstone wherever it is (the clearing's quiet clue).
 *   Lizards        small anoles basking at the trail's edge: idle -> short darts -> bolt for cover when you come close -> hidden -> creep back.
 *   Ripples        rings on the water: where you wade, where a leaf lands, and now and then on the pool by themselves.
 *   UnseenMover    something you never see, off the trail at the edge of your view: plants part along its path (the plant shader's 4th push point) and
 *                  the sound of it goes with them.
 */
import { BufferAttribute, BufferGeometry, Color, Euler, Points, Quaternion, Vector3 } from '@iwsdk/core';
import { PATH_SAMPLES, POOL, canopyOpenness, distanceToPath, hillWeight, inMountainZone, makeRandom, pathHalfWidth, terrainHeight, vegetationDensity } from '../world/layout.js';
import { solids } from '../world/placements.js';
import { waterLevelAt } from '../world/surface.js';
import { distToPlayerXZ, inCone, wctx } from './context.js';
import { pollenMaterial } from './models.js';
import { scratchM } from './rig.js';
import type { InstanceRig } from './rig.js';

export const livingStats = {
  steps: 0,
  lastSurface: '',
  leafSpawns: 0,
  leavesFalling: 0,
  leavesResting: 0,
  lizards: 0,
  lizardsOut: 0,
  lizardFlees: 0,
  lizardReturns: 0,
  ripples: 0,
  rippleSpawns: 0,
  unseenEvents: 0,
  unseenActive: false,
  brushRustles: 0,
  thunders: 0,
  gust: 0,
  light: 1,
  motes: 0,
  updateMs: 0,
};

const e = new Euler();
const q = new Quaternion();
const v = new Vector3();
const s = new Vector3();
const c = new Color();
const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------------------------------------------------------- footsteps

export class Stride {
  /** Distance walked since the last footfall (m). */
  acc = 0;
  /** -1 = the left foot lands next, +1 = the right. */
  side = 1;
  count = 0;

  /** `moved` = horizontal distance this frame (m), `speed` = smoothed walking speed (m/s). Returns true on the frame a foot lands. */
  step(dt: number, moved: number, speed: number): boolean {
    if (moved > 6 * dt + 0.5) {
      this.acc = 0; // a teleport, a snap back from a ledge: not a step
      return false;
    }
    if (speed < 0.45) {
      if (this.acc > 0.4) this.acc = 0.4; // standing (or just leaning): the next walk starts with a step soon, not instantly
      return false;
    }
    this.acc += moved;
    const len = 0.62 + 0.09 * Math.min(speed, 3);
    if (this.acc < len) return false;
    this.acc = this.acc - len > len ? 0 : this.acc - len;
    this.side = -this.side;
    this.count++;
    return true;
  }
}

// ---------------------------------------------------------------------------------------------------------------- falling leaves

const LEAF_TINTS = [new Color('#86a03c'), new Color('#b8a23a'), new Color('#a9722c'), new Color('#70502c'), new Color('#5f8c36'), new Color('#c08a2e')];
const LEAF_RANGE = 34;

class Leaf {
  /** 0 = idle (in the pool), 1 = falling, 2 = lying. */
  state = 0;
  x = 0;
  y = -999;
  z = 0;
  gy = 0;
  vy = -1;
  t = 0;
  /** Age at which the ground under it is looked up again; whether that ground is water. */
  chk = 0;
  wet = false;
  life = 0;
  phase = 0;
  spin = 0;
  yaw = 0;
  size = 0.08;
  tint = 0;
}

export class FallingLeaves {
  readonly leaves: Leaf[] = [];
  private rng: () => number;
  private next = 2.5;
  /** Set for one update when a leaf lands on water (the system adds a ripple and clears it). */
  splash = false;
  splashX = 0;
  splashY = 0;
  splashZ = 0;

  constructor(n = 14, seed = 7711) {
    this.rng = makeRandom(seed);
    for (let i = 0; i < n; i++) this.leaves.push(new Leaf());
  }

  /** `gust` 0..1, `dirX/dirZ` = where the wind blows, `max` = how many leaves may be out (tier). */
  update(dt: number, gust: number, dirX: number, dirZ: number, max: number): void {
    const r = this.rng;
    this.next -= dt * (0.6 + 2.4 * Math.pow(gust, 1.5));
    if (this.next <= 0) {
      this.next = 2.2 + r() * 3.5;
      this.trySpawn(max);
    }
    let falling = 0;
    let resting = 0;
    for (let i = 0; i < this.leaves.length; i++) {
      const l = this.leaves[i];
      if (l.state === 0) continue;
      if (i >= max || distToPlayerXZ(l.x, l.z) > LEAF_RANGE) {
        l.state = 0;
        continue;
      }
      l.t += dt;
      if (l.state === 1) {
        falling++;
        const sway = Math.sin(l.t * 2.1 + l.phase);
        l.x += (dirX * (0.15 + 0.9 * gust) + Math.cos(l.yaw) * sway * 0.45) * dt;
        l.z += (dirZ * (0.15 + 0.9 * gust) + Math.sin(l.yaw) * sway * 0.45) * dt;
        l.y += l.vy * (0.75 + 0.25 * Math.cos(l.t * 4.2 + l.phase)) * dt;
        // the ground under where it has drifted to: looked up twice a second while high, every frame for the last metre (the wind can carry it up a bank)
        if (l.t >= l.chk) {
          const wl = waterLevelAt(l.x, l.z);
          const g = terrainHeight(l.x, l.z);
          l.wet = wl !== null && wl > g;
          l.gy = l.wet ? (wl as number) : g;
          l.chk = l.y - l.gy > 1 ? l.t + 0.4 : 0;
        }
        if (l.y <= l.gy + 0.015) {
          l.y = l.gy + 0.012;
          l.state = 2;
          l.t = 0;
          l.life = 7 + r() * 6;
          if (l.wet) {
            this.splash = true;
            this.splashX = l.x;
            this.splashY = l.gy;
            this.splashZ = l.z;
          }
        }
      } else {
        resting++;
        if (l.t > l.life) l.state = 0;
      }
    }
    livingStats.leavesFalling = falling;
    livingStats.leavesResting = resting;
  }

  private trySpawn(max: number): void {
    const r = this.rng;
    let l: Leaf | null = null;
    for (let i = 0; i < Math.min(max, this.leaves.length); i++)
      if (this.leaves[i].state === 0) {
        l = this.leaves[i];
        break;
      }
    if (!l) return;
    // in front of the player, where it will be seen
    const a = Math.atan2(wctx.fz, wctx.fx) + (r() - 0.5) * 2.0;
    const d = 4 + r() * 9;
    const x = wctx.px + Math.cos(a) * d;
    const z = wctx.pz + Math.sin(a) * d;
    if (inMountainZone(x, z, 0) || canopyOpenness(x, z) > 0.62) return; // no tree above: no leaf
    l.state = 1;
    l.x = x;
    l.z = z;
    l.gy = terrainHeight(x, z);
    l.y = l.gy + 5.5 + r() * 4.5;
    l.vy = -(0.75 + r() * 0.45);
    l.t = 0;
    l.chk = 0.4;
    l.phase = r() * 6.28;
    l.spin = (r() - 0.5) * 3;
    l.yaw = r() * 6.28;
    l.size = 0.06 + r() * 0.05;
    l.tint = Math.floor(r() * LEAF_TINTS.length);
    livingStats.leafSpawns++;
  }

  reset(): void {
    for (const l of this.leaves) l.state = 0;
  }

  write(rig: InstanceRig): void {
    rig.begin();
    for (const l of this.leaves) {
      if (l.state === 0 || !inCone(l.x, l.y, l.z, 0.3)) continue;
      let k = l.size;
      if (l.state === 1) e.set(0.9 * Math.sin(l.t * 2.1 + l.phase), l.yaw + l.t * l.spin, 0.7 * Math.cos(l.t * 1.7 + l.phase), 'YXZ');
      else {
        e.set(0.08 * Math.sin(l.phase), l.yaw, 0.08 * Math.cos(l.phase), 'YXZ');
        k *= Math.min(1, (l.life - l.t) / 1.2); // shrinks away rather than popping
      }
      v.set(l.x, l.y, l.z);
      scratchM.compose(v, q.setFromEuler(e), s.setScalar(Math.max(0.0001, k)));
      rig.push(scratchM, LEAF_TINTS[l.tint]);
    }
    rig.end();
  }
}

// ---------------------------------------------------------------------------------------------------------------- pollen, dust, Heartstone embers

export const HEART_MOTES = 14;
export const POLLEN = 40;
const BOX = 12;
const BOX_Y = 4.5;
const HEART_R = 7;

export interface MoteCloud {
  points: Points;
  pos: Float32Array;
  col: Float32Array;
}
export function makeMotes(): MoteCloud {
  const n = HEART_MOTES + POLLEN;
  const pos = new Float32Array(n * 3).fill(-999);
  const col = new Float32Array(n * 3);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('color', new BufferAttribute(col, 3));
  const points = new Points(g, pollenMaterial);
  points.name = 'Living motes';
  points.frustumCulled = false;
  return { points, pos, col };
}

export class Motes {
  private pos: Float32Array;
  private col: Float32Array;
  private points: Points;
  private phase = new Float32Array(HEART_MOTES + POLLEN);
  private lit = new Float32Array(POLLEN);
  /** Heart embers: angle, radius, start height, inward speed. */
  private ha = new Float32Array(HEART_MOTES);
  private hr = new Float32Array(HEART_MOTES);
  private hh = new Float32Array(HEART_MOTES);
  private hs = new Float32Array(HEART_MOTES);
  private rng: () => number;
  private cursor = 0;
  private t = 0;

  constructor(cloud: MoteCloud, seed = 9241) {
    this.pos = cloud.pos;
    this.col = cloud.col;
    this.points = cloud.points;
    const r = (this.rng = makeRandom(seed));
    for (let i = 0; i < this.phase.length; i++) this.phase[i] = r() * 6.28;
    for (let i = 0; i < HEART_MOTES; i++) {
      this.ha[i] = r() * 6.28;
      this.hr[i] = 0.4 + (i / HEART_MOTES) * (HEART_R - 0.4);
      this.hh[i] = 0.1 + r() * 1.3;
      this.hs[i] = 0.2 + r() * 0.2;
    }
    for (let i = 0; i < POLLEN; i++) {
      const o = (HEART_MOTES + i) * 3;
      this.pos[o] = r() * BOX;
      this.pos[o + 1] = r() * BOX_Y;
      this.pos[o + 2] = r() * BOX;
    }
  }

  /**
   * `heart*` = where the Heartstone is, `glow` 0..1 = how awake it is, `pulse` = the stone's own breathing (0..1), `pollen` = how many of the pollen
   * motes are drawn (tier). `still` freezes the drift (reduced motion: the specks hang in the light).
   */
  update(dt: number, gust: number, dirX: number, dirZ: number, heartX: number, heartY: number, heartZ: number, glow: number, pulse: number, pollen: number, still: boolean): void {
    const pos = this.pos;
    const col = this.col;
    const r = this.rng;
    if (!still) this.t += dt;
    const t = this.t;
    const k = still ? 0 : dt;

    // ---- embers toward the Heartstone (only computed when it is within sight)
    const near = Math.hypot(heartX - wctx.px, heartZ - wctx.pz) < 45;
    for (let i = 0; i < HEART_MOTES; i++) {
      const o = i * 3;
      if (!near) {
        col[o] = col[o + 1] = col[o + 2] = 0;
        continue;
      }
      this.hr[i] -= this.hs[i] * k;
      this.ha[i] += k * (0.22 + 0.5 / (this.hr[i] + 0.6));
      if (this.hr[i] < 0.25) {
        this.hr[i] = HEART_R - r() * 1.5;
        this.ha[i] = r() * 6.28;
        this.hh[i] = 0.1 + r() * 1.3;
      }
      const rad = this.hr[i];
      const u = rad / HEART_R;
      pos[o] = heartX + Math.cos(this.ha[i]) * rad;
      pos[o + 1] = heartY + 0.06 + this.hh[i] * u + 0.05 * Math.sin(t * 0.9 + this.phase[i]);
      pos[o + 2] = heartZ + Math.sin(this.ha[i]) * rad;
      const b = smooth(0, 1.4, HEART_R - rad) * smooth(0.25, 0.9, rad) * (0.3 + 0.7 * glow) * (0.75 + 0.25 * pulse) * smooth(0.4, 1.2, Math.hypot(pos[o] - wctx.px, pos[o + 1] - wctx.py, pos[o + 2] - wctx.pz));
      col[o] = b;
      col[o + 1] = b * 0.52;
      col[o + 2] = b * 0.1;
    }

    // ---- pollen: a box of specks that travels with the player (wrapped, so none is ever created or destroyed)
    const wx = dirX * (0.05 + 0.35 * gust);
    const wz = dirZ * (0.05 + 0.35 * gust);
    const fade = 1 - 0.85 * wctx.open;
    const y0 = wctx.gy + 0.3;
    // the light on four of them per frame (the canopy map is not free)
    for (let j = 0; j < 4; j++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % POLLEN;
      const o = (HEART_MOTES + i) * 3;
      this.lit[i] = pos[o] > -900 ? canopyOpenness(pos[o], pos[o + 2]) : 0;
    }
    for (let i = 0; i < POLLEN; i++) {
      const o = (HEART_MOTES + i) * 3;
      if (i >= pollen) {
        col[o] = col[o + 1] = col[o + 2] = 0;
        continue;
      }
      const ph = this.phase[HEART_MOTES + i];
      let x = pos[o] + (wx + 0.04 * Math.sin(t * 0.5 + ph)) * k;
      let y = pos[o + 1] + (0.03 * Math.sin(t * 0.37 + ph * 1.7) - 0.008) * k;
      let z = pos[o + 2] + (wz + 0.04 * Math.cos(t * 0.43 + ph * 1.3)) * k;
      x = wctx.px + ((((x - wctx.px + BOX / 2) % BOX) + BOX) % BOX) - BOX / 2;
      z = wctx.pz + ((((z - wctx.pz + BOX / 2) % BOX) + BOX) % BOX) - BOX / 2;
      y = y0 + ((((y - y0) % BOX_Y) + BOX_Y) % BOX_Y);
      pos[o] = x;
      pos[o + 1] = y;
      pos[o + 2] = z;
      const d = Math.hypot(x - wctx.px, y - wctx.py, z - wctx.pz);
      // never a speck in the face, never a hard edge where the box ends
      const b = (0.08 + 0.5 * this.lit[i]) * (0.6 + 0.4 * Math.sin(t * 1.3 + ph * 2.1)) * smooth(0.6, 1.5, d) * (1 - smooth(BOX / 2 - 1.5, BOX / 2, Math.max(Math.abs(x - wctx.px), Math.abs(z - wctx.pz)))) * fade;
      col[o] = b;
      col[o + 1] = b * 0.93;
      col[o + 2] = b * 0.66;
    }
    const g = this.points.geometry;
    (g.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (g.getAttribute('color') as BufferAttribute).needsUpdate = true;
    livingStats.motes = (near ? HEART_MOTES : 0) + pollen;
  }
}

// ---------------------------------------------------------------------------------------------------------------- lizards

const LIZARD_TINTS = [new Color('#5d8a3a'), new Color('#7a6a44'), new Color('#4f7d52'), new Color('#8a7a4a')];
export const LizardState = { Bask: 0, Dart: 1, Flee: 2, Hidden: 3, Return: 4 } as const;

class Lizard {
  state: number = LizardState.Bask;
  /** Home (the basking spot) and cover (where it bolts to). */
  hx = 0;
  hz = 0;
  kx = 0;
  kz = 0;
  x = 0;
  y = 0;
  z = 0;
  tx = 0;
  tz = 0;
  yaw = 0;
  t = 0;
  wait = 3;
  size = 0.18;
  tint = 0;
}

export class Lizards {
  readonly list: Lizard[] = [];
  private rng: () => number;

  constructor(n = 10, seed = 5531) {
    const r = (this.rng = makeRandom(seed));
    const blocks = solids();
    const N = PATH_SAMPLES.length;
    // candidates evenly along the trail, both sides; a spot is kept when it is dry, clear of trunks and rocks, and has real cover a few metres off
    const tries = n * 6;
    for (let k = 0; k < tries && this.list.length < n; k++) {
      const i = Math.min(N - 2, 2 + Math.floor(((k + 0.5) / tries) * (N - 4)));
      const [ax, az] = PATH_SAMPLES[i];
      const [bx, bz] = PATH_SAMPLES[i + 1];
      const len = Math.hypot(bx - ax, bz - az) || 1;
      const side = k % 2 ? 1 : -1;
      const nx = (-(bz - az) / len) * side;
      const nz = ((bx - ax) / len) * side;
      const off = pathHalfWidth(i) + 0.25 + r() * 0.7;
      const hx = ax + nx * off;
      const hz = az + nz * off;
      const cover = 2.6 + r() * 1.6;
      const kx = hx + nx * cover;
      const kz = hz + nz * cover;
      if (inMountainZone(hx, hz, 2) || waterLevelAt(hx, hz) !== null || waterLevelAt(kx, kz) !== null) continue;
      if (hillWeight(hx, hz) > 0.3 || vegetationDensity(kx, kz) < 0.3 || distanceToPath(kx, kz).dist < distanceToPath(kx, kz).halfWidth + 1.5) continue;
      let clear = true;
      for (const b of blocks)
        if (Math.hypot(hx - b.x, hz - b.z) < b.r + 0.3 || Math.hypot(kx - b.x, kz - b.z) < b.r + 0.15) {
          clear = false;
          break;
        }
      for (const o of this.list) if (Math.hypot(hx - o.hx, hz - o.hz) < 5) clear = false;
      if (!clear) continue;
      const l = new Lizard();
      l.hx = l.x = hx;
      l.hz = l.z = hz;
      l.kx = kx;
      l.kz = kz;
      l.y = terrainHeight(hx, hz);
      l.yaw = r() * 6.28;
      l.wait = 1 + r() * 5;
      l.size = 0.14 + r() * 0.08;
      l.tint = Math.floor(r() * LIZARD_TINTS.length);
      this.list.push(l);
    }
    livingStats.lizards = this.list.length;
  }

  /** Walk toward (tx, tz) at `speed`; returns true on arrival. */
  private go(l: Lizard, tx: number, tz: number, speed: number, dt: number): boolean {
    const dx = tx - l.x;
    const dz = tz - l.z;
    const d = Math.hypot(dx, dz);
    const stepLen = speed * dt;
    if (d <= stepLen || d < 0.02) {
      l.x = tx;
      l.z = tz;
      l.y = terrainHeight(tx, tz);
      return true;
    }
    l.x += (dx / d) * stepLen;
    l.z += (dz / d) * stepLen;
    l.y = terrainHeight(l.x, l.z);
    l.yaw = Math.atan2(dx, dz);
    return false;
  }

  update(dt: number, max: number): void {
    const r = this.rng;
    const threat = 2.6 + Math.min(1.6, wctx.speed * 0.8);
    let out = 0;
    for (let i = 0; i < this.list.length; i++) {
      const l = this.list[i];
      const dp = distToPlayerXZ(l.x, l.z);
      if (dp > 32 || i >= max) continue; // too far to matter: frozen where it is
      l.t += dt;
      const scared = dp < threat;
      switch (l.state) {
        case LizardState.Bask:
          if (scared) this.flee(l);
          else if ((l.wait -= dt) <= 0) {
            if (r() < 0.6) {
              const a = r() * 6.28;
              const d = 0.3 + r() * 0.6;
              l.tx = l.hx + Math.cos(a) * d;
              l.tz = l.hz + Math.sin(a) * d;
              l.state = LizardState.Dart;
            } else l.wait = 2 + r() * 4;
          }
          break;
        case LizardState.Dart:
          if (scared) this.flee(l);
          else if (this.go(l, l.tx, l.tz, 1.3, dt)) {
            l.state = LizardState.Bask;
            l.wait = 1.5 + r() * 3.5;
          }
          break;
        case LizardState.Flee:
          if (this.go(l, l.kx, l.kz, 3.2, dt)) {
            l.state = LizardState.Hidden;
            l.t = 0;
            l.wait = 8 + r() * 7;
            wctx.audio.rustle?.(l.x, l.y + 0.1, l.z, 0.3);
          }
          break;
        case LizardState.Hidden:
          if (dp < 7) l.t = 0; // stays put while you are around
          else if (l.t > l.wait) {
            l.state = LizardState.Return;
            l.t = 0;
            livingStats.lizardReturns++;
          }
          break;
        case LizardState.Return:
          if (scared) this.flee(l);
          else if (l.t % 1.4 < 0.8 && this.go(l, l.hx, l.hz, 0.55, dt)) {
            l.state = LizardState.Bask;
            l.wait = 2 + r() * 4;
          }
          break;
      }
      if (l.state !== LizardState.Hidden) out++;
    }
    livingStats.lizardsOut = out;
  }

  private flee(l: Lizard): void {
    l.state = LizardState.Flee;
    l.t = 0;
    livingStats.lizardFlees++;
  }

  write(rig: InstanceRig, max: number): void {
    rig.begin();
    for (let i = 0; i < Math.min(max, this.list.length); i++) {
      const l = this.list[i];
      if (l.state === LizardState.Hidden || distToPlayerXZ(l.x, l.z) > 16 || !inCone(l.x, l.y, l.z, 0.4)) continue;
      // slips under the leaves at its cover instead of popping out of existence
      const k = l.size * Math.min(1, 0.15 + Math.hypot(l.x - l.kx, l.z - l.kz) / 0.6);
      const run = l.state === LizardState.Flee ? 0.35 * Math.sin(l.t * 38) : l.state === LizardState.Dart || l.state === LizardState.Return ? 0.2 * Math.sin(l.t * 24) : 0;
      // basking: a slow push-up now and then
      const bob = l.state === LizardState.Bask && l.t % 6.5 < 0.9 ? -0.22 * Math.abs(Math.sin((l.t % 6.5) * 10.5)) : 0;
      e.set(bob, l.yaw + run, 0, 'YXZ');
      v.set(l.x, l.y + 0.004, l.z);
      scratchM.compose(v, q.setFromEuler(e), s.setScalar(k));
      rig.push(scratchM, LIZARD_TINTS[l.tint]);
    }
    rig.end();
  }
}

// ---------------------------------------------------------------------------------------------------------------- ripples

export class Ripples {
  readonly n: number;
  private x: Float32Array;
  private y: Float32Array;
  private z: Float32Array;
  /** Age (s); negative = waiting to start; >= life = free. */
  private t: Float32Array;
  private size: Float32Array;
  private life = 1.9;
  private rng: () => number;
  private nextAmbient = 3;
  private head = 0;

  constructor(n = 8, seed = 3307) {
    this.n = n;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.z = new Float32Array(n);
    this.t = new Float32Array(n).fill(99);
    this.size = new Float32Array(n);
    this.rng = makeRandom(seed);
  }

  /** A ring at the water surface; when the pool is full the oldest ring is reused. */
  spawn(x: number, y: number, z: number, size: number, delay = 0): void {
    let i = -1;
    for (let j = 0; j < this.n; j++)
      if (this.t[j] >= this.life) {
        i = j;
        break;
      }
    if (i < 0) {
      i = this.head;
      this.head = (this.head + 1) % this.n;
    }
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.size[i] = size;
    this.t[i] = -delay;
    livingStats.rippleSpawns++;
  }

  update(dt: number): void {
    // the pool is never quite still: something touches the surface now and then (only while the player is near enough to see it)
    if ((this.nextAmbient -= dt) <= 0) {
      this.nextAmbient = 3.5 + this.rng() * 6;
      if (Math.hypot(wctx.px - POOL.x, wctx.pz - POOL.z) < 22) {
        const a = this.rng() * 6.28;
        const d = Math.sqrt(this.rng()) * POOL.r * 0.8;
        this.spawn(POOL.x + Math.cos(a) * d, POOL.waterY, POOL.z + Math.sin(a) * d, 0.3 + this.rng() * 0.3);
      }
    }
    let live = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.t[i] >= this.life) continue;
      this.t[i] += dt;
      live++;
    }
    livingStats.ripples = live;
  }

  write(rig: InstanceRig): void {
    rig.begin();
    for (let i = 0; i < this.n; i++) {
      const t = this.t[i];
      if (t < 0 || t >= this.life || !inCone(this.x[i], this.y[i], this.z[i], 1)) continue;
      const u = t / this.life;
      const rad = this.size[i] * (0.15 + 0.85 * Math.sqrt(u));
      const b = 0.2 * Math.pow(1 - u, 1.5) * Math.min(1, t / 0.12);
      v.set(this.x[i], this.y[i] + 0.012, this.z[i]);
      scratchM.compose(v, q.identity(), s.set(rad, 1, rad));
      rig.push(scratchM, c.setRGB(0.75 * b, 0.92 * b, 0.86 * b));
    }
    rig.end();
  }
}

// ---------------------------------------------------------------------------------------------------------------- the unseen animal

export class UnseenMover {
  active = false;
  x = 0;
  y = -999;
  z = 0;
  private vx = 0;
  private vz = 0;
  private t = 0;
  private dur = 0;
  private wait: number;
  private nextRustle = 0;
  private misses = 0;
  private rng: () => number;

  constructor(seed = 6113) {
    this.rng = makeRandom(seed);
    this.wait = 14 + this.rng() * 14;
  }

  /** `entrance` 0..1 (it happens more often there); `body` = the plant shader's 4th push point. */
  update(dt: number, entrance: number, body: Vector3): void {
    const r = this.rng;
    if (!this.active) {
      this.wait -= dt * (1 + 0.8 * entrance);
      if (this.wait > 0) return;
      if (wctx.open > 0.5 || !this.tryStart()) {
        // one candidate per frame; after a dozen misses (the player is somewhere open) come back later
        if (++this.misses > 12 || wctx.open > 0.5) {
          this.misses = 0;
          this.wait = 8 + r() * 8;
        }
        return;
      }
      this.misses = 0;
      return;
    }
    this.t += dt;
    // it moves in short rushes, like an animal picking its way
    const k = 0.3 + 0.7 * Math.abs(Math.sin(this.t * 3.4));
    this.x += this.vx * k * dt;
    this.z += this.vz * k * dt;
    this.y = terrainHeight(this.x, this.z) + 0.4;
    body.set(this.x, this.y, this.z);
    if ((this.nextRustle -= dt) <= 0) {
      this.nextRustle = 0.5 + r() * 0.4;
      wctx.audio.rustle?.(this.x, this.y, this.z, 0.42);
    }
    if (this.t >= this.dur || distanceToPath(this.x, this.z).dist < 1.5) this.stop(body);
  }

  private tryStart(): boolean {
    const r = this.rng;
    const side = r() < 0.5 ? -1 : 1;
    const a = Math.atan2(wctx.fz, wctx.fx) + side * (0.6 + r() * 0.8);
    const d = 7 + r() * 6;
    const x = wctx.px + Math.cos(a) * d;
    const z = wctx.pz + Math.sin(a) * d;
    if (inMountainZone(x, z, 2) || hillWeight(x, z) > 0.4 || waterLevelAt(x, z) !== null) return false;
    const p = distanceToPath(x, z);
    if (p.dist < p.halfWidth + 2.2 || vegetationDensity(x, z) < 0.45) return false;
    // off and away, never toward the player
    const away = Math.atan2(z - wctx.pz, x - wctx.px) + side * (0.5 + r() * 0.7);
    const sp = 1.8 + r() * 0.8;
    this.vx = Math.cos(away) * sp;
    this.vz = Math.sin(away) * sp;
    this.x = x;
    this.z = z;
    this.y = terrainHeight(x, z) + 0.4;
    this.t = 0;
    this.dur = 1.8 + r() * 1.2;
    this.nextRustle = 0.55;
    this.active = true;
    livingStats.unseenEvents++;
    livingStats.unseenActive = true;
    wctx.audio.rustle?.(x, this.y, z, 0.55, r() < 0.35);
    wctx.audio.hush(3, 0.35);
    return true;
  }

  stop(body: Vector3): void {
    this.active = false;
    this.y = -999;
    body.set(0, -999, 0);
    this.wait = 25 + this.rng() * 45;
    livingStats.unseenActive = false;
  }
}

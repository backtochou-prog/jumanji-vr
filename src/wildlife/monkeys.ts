/**
 * Monkeys: a small troop (spider monkeys and capuchins) living in the boughs along the trail.
 *
 * Each monkey is a torso + head + 13 ellipsoid "bones" (4 limbs x 2 segments, a 5-segment tail), all instanced parts posed by hand every frame:
 * the body is placed from the current state, each hand/foot has a TARGET (a grip on the branch/trunk, or free in the air) and a two-bone IK solve
 * puts the elbow/knee in between. That is what makes sitting, quadruped walking along a bough, climbing a trunk and leaping look like one animal.
 *
 *   SIT     upright on a bough; idle variants (look around, scratch, rest hands); not constantly moving: most of its time is spent sitting
 *   WATCH   the player is within ~40 m and in front: it turns toward them and holds still
 *   MOVE    walks along a bough, climbs the trunk, or (different tree, <= LEAP_MAX away) leaps
 *   RETREAT the player came within the species' alert distance: it moves to the neighbouring perch that is farthest from the player (and higher),
 *           repeating until it is ~20 m away, then calms down
 * Perches and their movement graph come from perches.ts (the same branches the trees draw). No physics, no collisions.
 */
import { Color, Euler, Matrix4, Quaternion, Vector3 } from '@iwsdk/core';
import { PATH_SAMPLES, makeRandom } from '../world/layout.js';
import { distToPlayer, inCone, threatDist, wctx, wildlifeStats } from './context.js';
import { LEAP_MAX, neighbours, perches } from './perches.js';
import type { InstanceRig } from './rig.js';

const Mode = { Sit: 0, Watch: 1, Move: 2, Leap: 3, Crouch: 4 } as const;
const Seg = { Walk: 0, Climb: 1 } as const;

interface MonkeyDef {
  name: string;
  /** Overall size factor (spider monkey = 1: torso ~0.43 m, limbs ~0.4 m each, tail ~0.8 m). */
  scale: number;
  arm: [number, number];
  leg: [number, number];
  tail: number;
  tint: Color;
  alert: number;
  spawn: number;
  walk: number;
  call: 'monkey-hoot' | 'monkey-whoop';
}
export const MONKEYS: MonkeyDef[] = [
  { name: 'black-handed spider monkey', scale: 1, arm: [0.2, 0.22], leg: [0.17, 0.19], tail: 0.85, tint: new Color('#3a2a1f'), alert: 14, spawn: 70, walk: 0.9, call: 'monkey-whoop' },
  { name: 'white-faced capuchin', scale: 0.72, arm: [0.16, 0.17], leg: [0.15, 0.16], tail: 0.55, tint: new Color('#9b7a4c'), alert: 11, spawn: 60, walk: 0.8, call: 'monkey-hoot' },
];

class Monkey {
  id = 0;
  def = MONKEYS[0];
  mode: number = Mode.Sit;
  perch = 0;
  home = 0;
  active = false;
  // body
  x = 0;
  y = 0;
  z = 0;
  yaw = 0;
  pitch = 0;
  roll = 0;
  yawGoal = 0;
  t = 0;
  // idle
  idleKind = 0;
  nextIdle = 0;
  headYaw = 0;
  headPitch = 0;
  headGoalYaw = 0;
  headGoalPitch = 0;
  nextHead = 0;
  nextCall = 0;
  nextMove = 0;
  // movement route: up to 4 points (x,y,z,kind of the segment that LEADS to the next point)
  route = new Float32Array(16);
  routeN = 0;
  seg = 0;
  segT = 0;
  segLen = 1;
  gait = 0;
  retreating = false;
  calmUntil = 0;
  seenUntil = 0;
  leapFrom = new Vector3();
  leapTo = new Vector3();
  leapDur = 1;
  leapH = 1;
  target = -1;
  // smoothed limb targets
  limb: Vector3[] = [new Vector3(), new Vector3(), new Vector3(), new Vector3()]; // handL, handR, footL, footR
  limbInit = false;
  tailDir = new Vector3(0, -1, 0);
  rng: () => number = Math.random;
  sens = 1;
}

// scratch
const _q = new Quaternion();
const _qh = new Quaternion();
const _e = new Euler();
const _M = new Matrix4();
const _B = new Matrix4();
const _S = new Vector3();
const _sc = new Vector3();
const _p = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _d = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();
const _up = new Vector3(0, 1, 0);
const _pole = new Vector3();
const _hip = new Vector3();
const _shL = new Vector3();
const _shR = new Vector3();
const _hpL = new Vector3();
const _hpR = new Vector3();
const _sh2 = new Vector3();
const _T = new Vector3();
const _mid = new Vector3();
const _bone = new Vector3();
const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();

export interface MonkeyRigs {
  body: InstanceRig;
  head: InstanceRig;
  bones: InstanceRig;
}

export class Monkeys {
  readonly monkeys: Monkey[] = [];
  private readonly list = perches();
  private readonly graph = neighbours();
  private occupied: Int16Array;
  /** Gait phase accumulators are per monkey; this is global time for sways. */
  constructor() {
    this.occupied = new Int16Array(this.list.length).fill(-1);
    this.populate();
  }

  private populate(): void {
    const rng = makeRandom(4141);
    // troop sites: bands along the trail (z), so the player meets monkeys in each stretch: [z-from, z-to]
    const bands: { z0: number; z1: number; species: number[] }[] = [
      { z0: -2, z1: -18, species: [0, 0] },
      { z0: -18, z1: -34, species: [1, 1] },
      { z0: -34, z1: -50, species: [0] },
      { z0: -48, z1: -64, species: [1] },
    ];
    const nearTrail = (x: number, z: number) => {
      let d = 1e9;
      for (let i = 0; i < PATH_SAMPLES.length; i += 2) d = Math.min(d, Math.hypot(x - PATH_SAMPLES[i][0], z - PATH_SAMPLES[i][1]));
      return d;
    };
    const used: number[] = [];
    for (const band of bands) {
      // best perch of the band: 6-15 m up, 7-20 m from the trail, with room to move (>=3 neighbours), not a structure
      let best = -1;
      let bestScore = -1e9;
      for (const p of this.list) {
        if (p.kind !== 'bough' && p.kind !== 'limb') continue;
        if (p.z > band.z0 || p.z < band.z1) continue;
        if (p.above < 3.5 || p.above > 13) continue;
        const dt = nearTrail(p.x, p.z);
        if (dt < 7 || dt > 22) continue;
        const nb = this.graph[p.id].length;
        if (nb < 3) continue;
        if (used.some((u) => Math.hypot(this.list[u].x - p.x, this.list[u].z - p.z) < 16)) continue;
        const score = nb * 0.5 - Math.abs(dt - 11) * 0.3 - Math.abs(p.above - 7) * 0.35 + rng() * 2;
        if (score > bestScore) {
          bestScore = score;
          best = p.id;
        }
      }
      if (best < 0) continue;
      used.push(best);
      band.species.forEach((sp, k) => {
        // the second member of a pair sits on a neighbouring perch
        const id = k === 0 ? best : this.graph[best].find((n) => this.occupied[n] < 0) ?? -1;
        if (id < 0) return;
        const m = new Monkey();
        m.id = this.monkeys.length;
        m.def = MONKEYS[sp];
        m.rng = makeRandom(1200 + m.id * 97);
        m.home = id;
        m.sens = 0.8 + 0.4 * m.rng();
        this.sit(m, id);
        m.nextIdle = 2 + m.rng() * 5;
        m.nextMove = 25 + m.rng() * 60;
        m.nextCall = 15 + m.rng() * 40;
        this.monkeys.push(m);
      });
    }
  }

  private sit(m: Monkey, perch: number): void {
    if (m.perch >= 0 && this.occupied[m.perch] === m.id) this.occupied[m.perch] = -1;
    m.perch = perch;
    this.occupied[perch] = m.id;
    const p = this.list[perch];
    m.mode = Mode.Sit;
    m.t = 0;
    m.x = p.x;
    m.y = p.y;
    m.z = p.z;
    m.retreating = m.retreating && false;
    // face across the branch toward the open side (away from the trunk) so the face is visible from the trail
    m.yawGoal = Math.atan2(p.x - p.ax, p.z - p.az) + (m.rng() - 0.5) * 0.9;
    if (p.kind === 'log') m.yawGoal = Math.atan2(p.dx, p.dz) + (m.rng() < 0.5 ? 0 : Math.PI);
    m.yaw = m.yawGoal;
    m.pitch = -1.05;
    m.idleKind = 0;
    m.limbInit = false;
  }

  // ------------------------------------------------------------------ movement
  private tryMove(m: Monkey, retreat: boolean): boolean {
    const nb = this.graph[m.perch];
    const here = this.list[m.perch];
    let best = -1;
    let bestScore = -1e9;
    for (const id of nb) {
      if (this.occupied[id] >= 0) continue;
      const q = this.list[id];
      if (q.above < 3) continue;
      const dPlayer = threatDist(q.x, q.y, q.z);
      const dHere = threatDist(here.x, here.y, here.z);
      let score: number;
      if (retreat) {
        if (dPlayer < dHere + 0.5) continue; // must increase the distance
        score = dPlayer + (q.y - here.y) * 0.8 + m.rng();
      } else {
        // wander: stay in the neighbourhood, not toward the player, prefer a different tree now and then
        if (dPlayer < m.def.alert + 6) continue;
        score = -Math.abs(dPlayer - 26) * 0.1 + m.rng() * 3;
      }
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    }
    if (best < 0) return false;
    this.beginRoute(m, best);
    m.retreating = retreat;
    return true;
  }

  private beginRoute(m: Monkey, to: number): void {
    const a = this.list[m.perch];
    const b = this.list[to];
    if (this.occupied[m.perch] === m.id) this.occupied[m.perch] = -1;
    this.occupied[to] = m.id;
    m.target = to;
    m.t = 0;
    const R = m.route;
    const sameTree = a.group === b.group;
    if (sameTree) {
      const dy = Math.abs(b.y - a.y);
      if (a.kind !== 'bough' || dy < 0.7) {
        // along the same bough
        R[0] = a.x;
        R[1] = a.y;
        R[2] = a.z;
        R[3] = Seg.Walk;
        R[4] = b.x;
        R[5] = b.y;
        R[6] = b.z;
        R[7] = 0;
        m.routeN = 2;
      } else {
        // in to the trunk, up or down it, out along the other bough
        const outA = this.outward(a, _a);
        const outB = this.outward(b, _b);
        R[0] = a.x;
        R[1] = a.y;
        R[2] = a.z;
        R[3] = Seg.Walk;
        R[4] = a.ax + outA.x * (a.trunkR + 0.12);
        R[5] = a.y - 0.1;
        R[6] = a.az + outA.z * (a.trunkR + 0.12);
        R[7] = Seg.Climb;
        R[8] = b.ax + outB.x * (b.trunkR + 0.12);
        R[9] = b.y - 0.1;
        R[10] = b.az + outB.z * (b.trunkR + 0.12);
        R[11] = Seg.Walk;
        R[12] = b.x;
        R[13] = b.y;
        R[14] = b.z;
        R[15] = 0;
        m.routeN = 4;
        wildlifeStats.climbs++;
      }
      m.seg = 0;
      m.segT = 0;
      this.setSeg(m);
      m.mode = Mode.Move;
    } else {
      // a leap across: crouch first
      m.leapFrom.set(a.x, a.y, a.z);
      m.leapTo.set(b.x, b.y, b.z);
      const gap = Math.hypot(b.x - a.x, b.z - a.z);
      // the duration follows the full 3D distance, so a short leap down a long drop is not absurdly fast
      m.leapDur = Math.max(0.6, Math.hypot(gap, b.y - a.y) / 4.4);
      m.leapH = 0.5 + gap * 0.14 + Math.max(0, a.y - b.y) * 0.05;
      m.mode = Mode.Crouch;
      m.yawGoal = Math.atan2(b.x - a.x, b.z - a.z);
      wildlifeStats.leaps++;
    }
  }

  private outward(p: { x: number; z: number; ax: number; az: number }, out: Vector3): Vector3 {
    const dx = p.x - p.ax;
    const dz = p.z - p.az;
    const l = Math.hypot(dx, dz) || 1;
    return out.set(dx / l, 0, dz / l);
  }

  private setSeg(m: Monkey): void {
    const R = m.route;
    const i = m.seg * 4;
    const dx = R[i + 4] - R[i];
    const dy = R[i + 5] - R[i + 1];
    const dz = R[i + 6] - R[i + 2];
    m.segLen = Math.max(0.2, Math.hypot(dx, dy, dz));
    m.segT = 0;
  }

  // ------------------------------------------------------------------ per frame
  update(dt: number, maxActive: number, rigs: MonkeyRigs): void {
    const now = wctx.time;
    const cap = Math.min(maxActive, wctx.low ? 4 : 6);
    let n = 0;
    wildlifeStats.active.monkeys = 0;
    for (const m of this.monkeys) {
      const here = this.list[m.perch];
      const d = distToPlayer(m.x, m.y, m.z);
      const was = m.active;
      const on = wctx.enabled && wctx.open < 0.45 && (was ? d < m.def.spawn + 12 : d < m.def.spawn) && n < cap;
      if (on !== was) {
        m.active = on;
        if (!on) {
          // freeze at the destination
          if (m.mode === Mode.Move || m.mode === Mode.Leap || m.mode === Mode.Crouch) {
            if (m.target >= 0) this.sit(m, m.target);
          }
        } else {
          m.nextIdle = now + 1 + m.rng() * 4;
          m.nextMove = now + 20 + m.rng() * 50;
        }
      }
      if (!m.active) continue;
      n++;
      this.step(m, dt, now, here);
      wildlifeStats.active.monkeys++;
    }
    // draw
    rigs.body.begin();
    rigs.head.begin();
    rigs.bones.begin();
    let drawn = 0;
    for (const m of this.monkeys) {
      if (!m.active) continue;
      if (!inCone(m.x, m.y, m.z, 1.4)) continue;
      this.draw(m, dt, rigs);
      drawn++;
    }
    rigs.body.end();
    rigs.head.end();
    rigs.bones.end();
    wildlifeStats.drawn.monkeys = drawn;
  }

  private step(m: Monkey, dt: number, now: number, here: { x: number; y: number; z: number }): void {
    const def = m.def;
    const dP = threatDist(m.x, m.y, m.z);
    m.t += dt;
    // smooth yaw
    let dy = m.yawGoal - m.yaw;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    m.yaw += dy * Math.min(1, dt * (m.mode === Mode.Move ? 5 : 2.2));
    void here;

    switch (m.mode) {
      case Mode.Sit:
      case Mode.Watch: {
        // the player is near: alert -> retreat (with a reaction time)
        const alert = def.alert * m.sens * (0.7 + 0.3 * Math.min(1, wctx.speed / 1.5 + (wctx.still ? 0 : 0.3)));
        if (dP < alert && now >= m.calmUntil) {
          if (m.seenUntil === 0) m.seenUntil = now + 0.35 + m.rng() * 0.5; // reaction time
          if (now >= m.seenUntil) {
            m.seenUntil = 0;
            if (this.tryMove(m, true)) {
              wildlifeStats.retreats++;
              wctx.audio.call(def.call, m.x, m.y, m.z, 0.8);
              wctx.audio.hush(4, 0.3);
              return;
            }
            m.calmUntil = now + 8; // cornered: stays put, watching
          }
        } else m.seenUntil = 0;
        // watch the player from a distance
        const watch = dP < 42 && dP > alert * 0.8 && inCone(m.x, m.y, m.z, 1) === true;
        if (watch) {
          if (m.mode !== Mode.Watch) {
            m.mode = Mode.Watch;
            m.t = 0;
          }
          m.yawGoal = Math.atan2(wctx.px - m.x, wctx.pz - m.z);
        } else if (m.mode === Mode.Watch) {
          m.mode = Mode.Sit;
          m.t = 0;
        }
        // idle behaviour
        if (now >= m.nextIdle) {
          m.nextIdle = now + 4 + m.rng() * 12;
          m.idleKind = m.rng() < 0.55 ? 0 : m.rng() < 0.6 ? 1 : 2;
          if (m.mode === Mode.Sit && m.rng() < 0.4) m.yawGoal = m.yaw + (m.rng() - 0.5) * 1.4;
        }
        if (now >= m.nextHead) {
          m.nextHead = now + 1.5 + m.rng() * 4;
          m.headGoalYaw = (m.rng() - 0.5) * 1.3;
          m.headGoalPitch = (m.rng() - 0.45) * 0.5;
        }
        if (m.mode === Mode.Watch) {
          // head toward the player (relative to the body)
          let rel = Math.atan2(wctx.px - m.x, wctx.pz - m.z) - m.yaw;
          while (rel > Math.PI) rel -= 2 * Math.PI;
          while (rel < -Math.PI) rel += 2 * Math.PI;
          m.headGoalYaw = Math.max(-1.1, Math.min(1.1, rel));
          m.headGoalPitch = Math.max(-0.5, Math.min(0.5, Math.atan2(wctx.py - m.y, Math.max(1, Math.hypot(wctx.px - m.x, wctx.pz - m.z))) * 0.8));
        }
        // calls and the occasional move
        if (now >= m.nextCall) {
          m.nextCall = now + 25 + m.rng() * 70;
          wctx.audio.call(def.call, m.x, m.y, m.z, dP > 25 ? 0.7 : 0.45);
        }
        if (now >= m.nextMove) {
          m.nextMove = now + 40 + m.rng() * 90;
          if (!this.tryMove(m, false)) m.nextMove = now + 15;
        }
        break;
      }
      case Mode.Crouch: {
        m.pitch += (-0.25 - m.pitch) * Math.min(1, dt * 8);
        if (m.t >= 0.32) {
          m.mode = Mode.Leap;
          m.t = 0;
        }
        break;
      }
      case Mode.Leap: {
        const u = Math.min(1, m.t / m.leapDur);
        const k = u;
        m.x = m.leapFrom.x + (m.leapTo.x - m.leapFrom.x) * k;
        m.z = m.leapFrom.z + (m.leapTo.z - m.leapFrom.z) * k;
        m.y = m.leapFrom.y + (m.leapTo.y - m.leapFrom.y) * k + m.leapH * 4 * u * (1 - u);
        m.yawGoal = Math.atan2(m.leapTo.x - m.leapFrom.x, m.leapTo.z - m.leapFrom.z);
        // body follows the arc: pitch from the vertical velocity
        const vy = (m.leapTo.y - m.leapFrom.y) / m.leapDur + (m.leapH * 4 * (1 - 2 * u)) / m.leapDur;
        const vh = Math.hypot(m.leapTo.x - m.leapFrom.x, m.leapTo.z - m.leapFrom.z) / m.leapDur;
        m.pitch = -Math.atan2(vy, Math.max(0.5, vh)) * 0.9;
        if (u >= 1) {
          const to = m.target;
          this.sit(m, to);
          m.mode = Mode.Sit;
          m.t = 0;
          // a retreating monkey keeps going if the player is still close
          if (m.retreating) {
            if (distToPlayer(m.x, m.y, m.z) < 20 && this.tryMove(m, true)) return;
            m.retreating = false;
            m.calmUntil = now + 12;
          }
        }
        break;
      }
      case Mode.Move: {
        const R = m.route;
        const i = m.seg * 4;
        const kind = R[i + 3];
        const sp = (kind === Seg.Climb ? def.walk * 1.05 : def.walk) * (m.retreating ? 1.7 : 1);
        m.segT += (sp * dt) / m.segLen;
        m.gait += (sp * dt) / (0.34 * def.scale + 0.08);
        const t = Math.min(1, m.segT);
        m.x = R[i] + (R[i + 4] - R[i]) * t;
        m.y = R[i + 1] + (R[i + 5] - R[i + 1]) * t;
        m.z = R[i + 2] + (R[i + 6] - R[i + 2]) * t;
        const dx = R[i + 4] - R[i];
        const dz = R[i + 6] - R[i + 2];
        if (kind === Seg.Walk) {
          if (Math.hypot(dx, dz) > 0.05) m.yawGoal = Math.atan2(dx, dz);
          m.pitch += (0.0 - m.pitch) * Math.min(1, dt * 6);
        } else {
          // facing the trunk, head up or down
          const down = R[i + 5] < R[i + 1];
          const nx = R[i + 4] - (this.list[m.target].ax);
          const nz = R[i + 6] - (this.list[m.target].az);
          void nx;
          void nz;
          m.pitch += ((down ? 1.35 : -1.35) - m.pitch) * Math.min(1, dt * 6);
        }
        if (m.segT >= 1) {
          m.seg++;
          if (m.seg >= m.routeN - 1) {
            const to = m.target;
            const was = m.retreating;
            this.sit(m, to);
            m.retreating = was;
            if (m.retreating) {
              if (distToPlayer(m.x, m.y, m.z) < 20 && this.tryMove(m, true)) return;
              m.retreating = false;
              m.calmUntil = now + 12;
            }
          } else this.setSeg(m);
        }
        break;
      }
      default:
        break;
    }
    // head smoothing
    m.headYaw += (m.headGoalYaw - m.headYaw) * Math.min(1, dt * 3);
    m.headPitch += (m.headGoalPitch - m.headPitch) * Math.min(1, dt * 3);
    if (m.mode === Mode.Sit || m.mode === Mode.Watch) m.pitch += (-1.05 - m.pitch) * Math.min(1, dt * 4);
  }

  // ------------------------------------------------------------------ drawing / posing
  /** Two-bone IK: root -> target with segment lengths l1, l2; the middle joint bends toward `pole`. Writes the middle joint into `mid`, the end into `end`. */
  private ik(root: Vector3, target: Vector3, l1: number, l2: number, pole: Vector3, mid: Vector3, end: Vector3): void {
    _d.subVectors(target, root);
    let dist = _d.length();
    const reach = l1 + l2 - 0.002;
    if (dist < 0.02) {
      _d.set(0, -1, 0);
      dist = 0.02;
    }
    _d.multiplyScalar(1 / dist);
    const dd = Math.min(dist, reach);
    const a = (l1 * l1 - l2 * l2 + dd * dd) / (2 * dd);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    // pole component perpendicular to the limb axis
    _x.copy(pole).addScaledVector(_d, -pole.dot(_d));
    if (_x.lengthSq() < 1e-6) _x.set(0, 1, 0).addScaledVector(_d, -_d.y);
    _x.normalize();
    mid.copy(root).addScaledVector(_d, a).addScaledVector(_x, h);
    end.copy(root).addScaledVector(_d, dd);
  }

  /** Push one ellipsoid bone from A to B with the given thickness. */
  private bone(rig: InstanceRig, A: Vector3, B: Vector3, thick: number, color: Color): void {
    _bone.subVectors(B, A);
    const len = _bone.length();
    if (len < 1e-4) return;
    _y.copy(_bone).multiplyScalar(1 / len);
    // any perpendicular
    _z.set(Math.abs(_y.y) > 0.95 ? 1 : 0, Math.abs(_y.y) > 0.95 ? 0 : 1, 0).cross(_y).normalize();
    _x.crossVectors(_y, _z);
    _M.makeBasis(_x.multiplyScalar(thick), _y.multiplyScalar(len * 0.5 + thick * 0.9), _z.multiplyScalar(thick));
    _mid.addVectors(A, B).multiplyScalar(0.5);
    _M.setPosition(_mid);
    rig.push(_M, color);
  }

  private draw(m: Monkey, dt: number, rigs: MonkeyRigs): void {
    const def = m.def;
    const sc = def.scale;
    const now = wctx.time;
    const sit = m.mode === Mode.Sit || m.mode === Mode.Watch || m.mode === Mode.Crouch;
    const moving = m.mode === Mode.Move;
    const leaping = m.mode === Mode.Leap;
    const R = m.route;
    const segKind = moving ? R[m.seg * 4 + 3] : -1;
    const climbing = moving && segKind === Seg.Climb;

    // ---- body frame
    let bx = m.x;
    let by = m.y;
    let bz = m.z;
    _e.set(m.pitch, m.yaw, m.roll, 'YXZ');
    _q.setFromEuler(_e);
    _fwd.set(0, 0, 1).applyQuaternion(_q);
    _right.set(1, 0, 0).applyQuaternion(_q);
    const breathe = 0.008 * Math.sin(now * 2.2 + m.id) * sc;
    if (sit) {
      // hips rest on the branch; the torso leans back, so the body centre is up and in front of the hips
      _hip.set(m.x, m.y + 0.075 * sc + breathe, m.z);
      bx = _hip.x + _fwd.x * 0.15 * sc;
      by = _hip.y + _fwd.y * 0.15 * sc;
      bz = _hip.z + _fwd.z * 0.15 * sc;
    } else if (moving && !climbing) {
      const bounce = 0.012 * sc * Math.sin(m.gait * Math.PI * 4);
      bx = m.x;
      by = m.y + 0.27 * sc + bounce;
      bz = m.z;
    } else if (climbing) {
      // on the trunk: body against it, offset outward
      const p = this.list[m.target];
      const ox = m.x - p.ax;
      const oz = m.z - p.az;
      const l = Math.hypot(ox, oz) || 1;
      bx = m.x + (ox / l) * 0.13 * sc;
      bz = m.z + (oz / l) * 0.13 * sc;
      by = m.y;
      // face the trunk
      m.yaw = Math.atan2(-ox / l, -oz / l);
      _e.set(m.pitch, m.yaw, 0, 'YXZ');
      _q.setFromEuler(_e);
      _fwd.set(0, 0, 1).applyQuaternion(_q);
      _right.set(1, 0, 0).applyQuaternion(_q);
    } else if (leaping) {
      bx = m.x;
      by = m.y;
      bz = m.z;
    } else {
      bx = m.x;
      by = m.y + 0.25 * sc;
      bz = m.z;
    }
    _S.set(sc, sc, sc);
    _B.compose(_p.set(bx, by, bz), _q, _S);
    rigs.body.push(_B, def.tint);

    // ---- head
    _e.set(m.headPitch * -1, m.headYaw, 0, 'YXZ');
    _qh.setFromEuler(_e);
    _qh.premultiply(_q);
    // the neck pivot in body space; the body matrix already carries the scale
    _sh2.set(0, 0.045, 0.265).applyMatrix4(_B);
    _M.compose(_sh2, _qh, _S);
    rigs.head.push(_M, def.tint);

    // ---- limbs
    const lat = 0.085 * sc;
    const targets = m.limb;
    // shoulders and hips in world
    const shL = _shL.set(lat / sc, -0.02, 0.15).applyMatrix4(_B);
    const shR = _shR.set(-lat / sc, -0.02, 0.15).applyMatrix4(_B);
    const hpL = _hpL.set(lat / sc, -0.04, -0.15).applyMatrix4(_B);
    const hpR = _hpR.set(-lat / sc, -0.04, -0.15).applyMatrix4(_B);
    // ---- targets
    const a = this.list[m.perch];
    const goal = _T;
    for (let i = 0; i < 4; i++) {
      const isHand = i < 2;
      const side = i % 2 === 0 ? 1 : -1;
      const root = i === 0 ? shL : i === 1 ? shR : i === 2 ? hpL : hpR;
      if (sit) {
        // feet on the branch in front of the hips; hands rest on the knees, hold the branch, or (scratch) go to the head/chest
        const fx = m.x + _fwd.x * 0.0;
        void fx;
        if (!isHand) {
          goal.set(m.x + Math.sin(m.yaw) * 0.12 * sc + Math.cos(m.yaw) * side * 0.085 * sc, m.y + 0.02, m.z + Math.cos(m.yaw) * 0.12 * sc - Math.sin(m.yaw) * side * 0.085 * sc);
        } else if (m.idleKind === 1 && side === 1) {
          // right hand scratches: oscillates near the chest/head
          const sw = 0.03 * Math.sin(now * 7 + m.id);
          goal.copy(_sh2).addScaledVector(_fwd, -0.02).addScaledVector(_right, -0.05 * sc + sw);
          goal.y -= 0.12 * sc;
        } else if (m.idleKind === 2) {
          // holds the branch in front of it
          goal.set(m.x + Math.sin(m.yaw) * 0.3 * sc + Math.cos(m.yaw) * side * 0.06 * sc, m.y + 0.0, m.z + Math.cos(m.yaw) * 0.3 * sc - Math.sin(m.yaw) * side * 0.06 * sc);
        } else {
          // hands on the knees
          goal.set(m.x + Math.sin(m.yaw) * 0.16 * sc + Math.cos(m.yaw) * side * 0.1 * sc, m.y + 0.14 * sc, m.z + Math.cos(m.yaw) * 0.16 * sc - Math.sin(m.yaw) * side * 0.1 * sc);
        }
      } else if (moving) {
        // quadruped gait: diagonal pairs; the contact moves back relative to the body, the swing arcs forward
        const ph = (m.gait + (isHand ? (side === 1 ? 0.0 : 0.5) : side === 1 ? 0.5 : 0.0)) % 1;
        const stride = 0.34 * sc;
        const swing = ph > 0.62;
        const prog = swing ? (ph - 0.62) / 0.38 : ph / 0.62;
        const zOff = swing ? -0.5 * stride + prog * stride : 0.5 * stride - prog * stride;
        const lift = swing ? 0.05 * sc * Math.sin(prog * Math.PI) : 0;
        const zBase = isHand ? 0.17 * sc : -0.15 * sc;
        const lx = side * 0.075 * sc;
        if (climbing) {
          const p = this.list[m.target];
          const ox = m.x - p.ax;
          const oz = m.z - p.az;
          const l = Math.hypot(ox, oz) || 1;
          const up = m.pitch < 0 ? 1 : -1;
          // grip points on the trunk surface, ahead of / behind the body along the climb direction
          const along = (isHand ? 0.3 * sc : -0.05 * sc) + (zOff / stride) * 0.12 * sc * 1.0;
          const tx = -oz / l;
          const tz = ox / l;
          goal.set(m.x + tx * lx + 0 * ox, m.y + up * (along + (swing ? lift * 0.5 : 0)), m.z + tz * lx);
        } else {
          const sy = Math.sin(m.yaw);
          const cy = Math.cos(m.yaw);
          goal.set(m.x + sy * (zBase + zOff) + cy * lx, m.y + lift + 0.005, m.z + cy * (zBase + zOff) - sy * lx);
        }
      } else {
        // leaping / crouching: arms reach forward (toward the landing branch near the end), legs trail
        const L = isHand ? def.arm[0] + def.arm[1] : def.leg[0] + def.leg[1];
        const k = leaping ? Math.min(1, m.t / m.leapDur) : 0;
        if (isHand) {
          goal.copy(root).addScaledVector(_fwd, 0.85 * L * sc).addScaledVector(_up, 0.15 * L * sc).addScaledVector(_right, side * 0.05);
          if (leaping && k > 0.72) goal.lerp(_a.set(m.leapTo.x, m.leapTo.y, m.leapTo.z), (k - 0.72) / 0.28 * 0.85);
        } else {
          goal.copy(root).addScaledVector(_fwd, -0.8 * L * sc).addScaledVector(_up, -0.1 * L * sc).addScaledVector(_right, side * 0.04);
          if (!leaping) goal.set(m.x + Math.sin(m.yaw) * 0.12 * sc, m.y + 0.02, m.z + Math.cos(m.yaw) * 0.12 * sc);
        }
      }
      // smooth the target (so switching mode does not snap the limb)
      const tgt = targets[i];
      if (!m.limbInit) tgt.copy(goal);
      else tgt.lerp(goal, Math.min(1, dt * (moving ? 22 : 10)));
      // pole: elbows out and down/back, knees forward
      if (isHand) _pole.set(0, -0.3, -0.5).applyQuaternion(_q).addScaledVector(_right, side * 0.8);
      else _pole.set(0, 0.25, 0.9).applyQuaternion(_q).addScaledVector(_right, side * 0.22);
      const l1 = (isHand ? def.arm[0] : def.leg[0]) * sc;
      const l2 = (isHand ? def.arm[1] : def.leg[1]) * sc;
      this.ik(root, tgt, l1, l2, _pole, _c, _b);
      const th = 0.042 * sc;
      this.bone(rigs.bones, root, _c, th, def.tint);
      this.bone(rigs.bones, _c, _b, th * 0.78, def.tint);
      // hand / foot: a short, stout tip continuing the forearm / shin
      _d.subVectors(_b, _c).normalize();
      _a.copy(_b).addScaledVector(_d, isHand ? 0.075 * sc : 0.09 * sc);
      this.bone(rigs.bones, _b, _a, th * 0.9, def.tint);
    }
    m.limbInit = true;
    void a;

    // ---- tail: a chain that hangs (sitting), trails behind (moving) or streams out (leaping)
    {
      const nSeg = 5;
      const segLen = (def.tail * sc) / nSeg;
      _p.set(0, -0.01, -0.2).applyMatrix4(_B);
      // base direction: behind the body, blended with gravity
      const grav = sit ? 0.9 : climbing ? 0.7 : leaping ? 0.0 : 0.25;
      _a.set(0, -1, 0).multiplyScalar(grav).addScaledVector(_fwd, -(1 - grav)).normalize();
      m.tailDir.lerp(_a, Math.min(1, dt * 3));
      _d.copy(m.tailDir);
      // lateral axis for the curl: the body's right
      const curl = sit ? 0.32 : leaping ? 0.05 : 0.14;
      const sway = (sit ? 0.18 : 0.1) * Math.sin(now * 1.3 + m.id * 2);
      for (let k = 0; k < nSeg; k++) {
        _c.copy(_p);
        _d.applyAxisAngle(_right, curl * (k + 1) * 0.55 * (m.pitch < -0.6 ? 1 : -1));
        _d.applyAxisAngle(_up, sway * 0.4);
        _p.addScaledVector(_d, segLen);
        const t = 1 - k / (nSeg + 1);
        this.bone(rigs.bones, _c, _p, 0.034 * sc * (0.42 + 0.62 * t), def.tint);
      }
    }
  }

  /** Test hook: make every active monkey within `radius` start retreating now. */
  alarmNear(radius: number): number {
    let n = 0;
    for (const m of this.monkeys) {
      if (!m.active) continue;
      if (distToPlayer(m.x, m.y, m.z) <= radius && (m.mode === Mode.Sit || m.mode === Mode.Watch)) {
        m.calmUntil = 0;
        if (this.tryMove(m, true)) {
          n++;
          wildlifeStats.retreats++;
        }
      }
    }
    return n;
  }

  snapshot(): { id: number; sp: string; mode: number; x: number; y: number; z: number; active: boolean; perch: number }[] {
    return this.monkeys.map((m) => ({ id: m.id, sp: m.def.name, mode: m.mode, x: m.x, y: m.y, z: m.z, active: m.active, perch: m.perch }));
  }
}

export { LEAP_MAX };

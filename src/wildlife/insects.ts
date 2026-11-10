/**
 * Small life: butterflies (between flowers and heliconia), dragonflies (over the pool and the stream), gnat clouds (a few specks in the air near the
 * player) and fireflies (faint, only in the deepest shade). All procedural: seeded sinusoids and simple steering, no physics.
 *
 *   butterflies  a pool of 28 slots; a free slot is placed on a flower/leaf anchor 10-38 m from the player (more where there are more flowers);
 *                LAND (wings up, slow open/close, 2-7 s) -> FLY (flap/glide, wandering toward the next anchor) -> LAND ...; a player closer than ~2.5 m
 *                who is moving makes it break off and jink away. Despawns when it is far or out of sight for long.
 *   dragonflies  6 slots at the pool/stream: hover with a tiny jitter, then a quick dart to a new hover point; four fast wings.
 *   gnats        4 clouds x 12 points (Points, dark specks) orbiting anchors in the air 3-14 m from the player, re-anchored as the player walks.
 *   fireflies    36 warm points in 3 shaded hollows, pulsing; jungle only, not in the low tier.
 */
import { BufferAttribute, BufferGeometry, Color, Euler, Float32BufferAttribute, Matrix4, Points, Quaternion, Vector3 } from '@iwsdk/core';
import { CLEARING, POOL, SPAWN, STREAM_SAMPLES, makeRandom, terrainHeight } from '../world/layout.js';
import { plantPlacements } from '../world/placements.js';
import { distToPlayer, distToPlayerXZ, inCone, wctx, wildlifeStats } from './context.js';
import type { InstanceRig } from './rig.js';
import { fireflyMaterial, moteMaterial } from './models.js';

const BFLY_TINTS = ['#e0701a', '#3f7fe0', '#e8d83a', '#f2f2e8', '#d94a7a'].map((h) => new Color(h));
const BFLY_SIZE = [0.052, 0.075, 0.042, 0.04, 0.047]; // wing length (m)
const DRAGON_TINTS = ['#2f7fd0', '#3fb070', '#c83a2a'].map((h) => new Color(h));
const BFLY_BODY = new Color('#2a241c');

interface Anchor {
  x: number;
  y: number;
  z: number;
}

class Butterfly {
  active = false;
  species = 0;
  state = 0; // 0 land, 1 fly, 2 flee
  x = 0;
  y = 0;
  z = 0;
  yaw = 0;
  tx = 0;
  ty = 0;
  tz = 0;
  speed = 1.2;
  t = 0;
  phase = 0;
  until = 0;
  anchor = -1;
  glideUntil = 0;
  rng: () => number = Math.random;
  offscreen = 0;
}

class Dragonfly {
  active = false;
  tint = 0;
  x = 0;
  y = 0;
  z = 0;
  yaw = 0;
  tx = 0;
  ty = 0;
  tz = 0;
  hoverUntil = 0;
  phase = 0;
  home = 0;
  rng: () => number = Math.random;
}

const _q = new Quaternion();
const _e = new Euler();
const _M = new Matrix4();
const _S = new Vector3();
const _C = new Vector3();
const _p = new Vector3();
const _v = new Vector3();
const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();
const _one = new Vector3(1, 1, 1);

/** The two Points objects (gnats, fireflies) and their buffers. Created at system init (before the shader warm-up looks at the scene), filled by Insects later. */
export interface Clouds {
  gnats: Points;
  fireflies: Points;
  gnatPos: Float32Array;
  ffPos: Float32Array;
  ffCol: Float32Array;
}
export const GNATS = 48;
export const FIREFLIES = 36;
export function makeClouds(): Clouds {
  const gnatPos = new Float32Array(GNATS * 3).fill(-999);
  const gg = new BufferGeometry();
  gg.setAttribute('position', new BufferAttribute(gnatPos, 3));
  const gnats = new Points(gg, moteMaterial);
  gnats.name = 'Wildlife gnats';
  gnats.frustumCulled = false;
  gnats.visible = false;
  const ffPos = new Float32Array(FIREFLIES * 3);
  const ffCol = new Float32Array(FIREFLIES * 3);
  const fg = new BufferGeometry();
  fg.setAttribute('position', new BufferAttribute(ffPos, 3));
  fg.setAttribute('color', new BufferAttribute(ffCol, 3));
  const fireflies = new Points(fg, fireflyMaterial);
  fireflies.name = 'Wildlife fireflies';
  fireflies.frustumCulled = false;
  fireflies.visible = false;
  return { gnats, fireflies, gnatPos, ffPos, ffCol };
}

export interface InsectRigs {
  bflyWings: InstanceRig;
  bflyBody: InstanceRig;
  dragonWings: InstanceRig;
  dragonBody: InstanceRig;
}

export class Insects {
  readonly butterflies: Butterfly[] = [];
  readonly dragonflies: Dragonfly[] = [];
  private anchors: Anchor[] = [];
  private anchorBusy: Uint8Array;
  private water: Anchor[] = [];
  private nextSpawn = 0;
  readonly gnats: Points;
  readonly fireflies: Points;
  private gnatAnchors: { x: number; y: number; z: number }[] = [];
  private gnatPhase: Float32Array;
  private gnatPos: Float32Array;
  private ffBase: Float32Array;
  private ffPhase: Float32Array;
  private ffPos: Float32Array;
  private ffCol: Float32Array;
  private readonly gnatN = GNATS;
  private readonly ffN = FIREFLIES;
  private rng = makeRandom(2718);

  constructor(clouds: Clouds = makeClouds()) {
    this.gnats = clouds.gnats;
    this.fireflies = clouds.fireflies;
    this.gnatPos = clouds.gnatPos;
    this.ffPos = clouds.ffPos;
    this.ffCol = clouds.ffCol;
    // anchors: flower patches, large broadleaf plants (heliconia/banana), a ring of bright spots in the clearing
    for (const p of plantPlacements('flowers')) this.anchors.push({ x: p.x, y: p.y + 0.4, z: p.z });
    for (const p of plantPlacements('broadleaf')) this.anchors.push({ x: p.x, y: p.y + 1.0 * p.scale, z: p.z });
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const x = CLEARING.x + Math.cos(a) * (CLEARING.r * 0.6);
      const z = CLEARING.z + Math.sin(a) * (CLEARING.r * 0.6);
      this.anchors.push({ x, y: terrainHeight(x, z) + 0.5, z });
    }
    this.anchorBusy = new Uint8Array(this.anchors.length);
    // water: the pool ring and the stream polyline
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      this.water.push({ x: POOL.x + Math.cos(a) * POOL.r * 0.7, y: POOL.waterY + 0.7, z: POOL.z + Math.sin(a) * POOL.r * 0.7 });
    }
    for (let i = 0; i < STREAM_SAMPLES.length; i += 6) this.water.push({ x: STREAM_SAMPLES[i][0], y: terrainHeight(STREAM_SAMPLES[i][0], STREAM_SAMPLES[i][1]) + 0.8, z: STREAM_SAMPLES[i][1] });

    for (let i = 0; i < 28; i++) {
      const b = new Butterfly();
      b.rng = makeRandom(300 + i * 29);
      this.butterflies.push(b);
    }
    for (let i = 0; i < 6; i++) {
      const d = new Dragonfly();
      d.rng = makeRandom(900 + i * 41);
      d.tint = i % 3;
      d.home = Math.floor((i * this.water.length) / 6);
      this.dragonflies.push(d);
    }

    // gnats
    this.gnatPhase = new Float32Array(this.gnatN * 6);
    for (let i = 0; i < this.gnatPhase.length; i++) this.gnatPhase[i] = this.rng() * 6.28;
    for (let i = 0; i < 4; i++) this.gnatAnchors.push({ x: 0, y: -999, z: 0 });

    // fireflies: three shaded hollows (the gate, the root arch, the mid trail)
    const hollows: [number, number, number][] = [
      [3.1, -3.5, 14], // the shaded hollow at the gate (a literal: the start is no longer there)
      [-4.5, -33, 12],
      [3.5, -44, 12],
    ];
    this.ffBase = new Float32Array(this.ffN * 3);
    this.ffPhase = new Float32Array(this.ffN * 3);
    for (let i = 0; i < this.ffN; i++) {
      const h = hollows[i % 3];
      const a = this.rng() * 6.28;
      const r = this.rng() * 5.5;
      const x = h[0] + Math.cos(a) * r;
      const z = h[1] + Math.sin(a) * r;
      this.ffBase[i * 3] = x;
      this.ffBase[i * 3 + 1] = terrainHeight(x, z) + 0.5 + this.rng() * 2.4;
      this.ffBase[i * 3 + 2] = z;
      this.ffPhase[i * 3] = this.rng() * 6.28;
      this.ffPhase[i * 3 + 1] = 2.2 + this.rng() * 2.8; // blink period (s)
      this.ffPhase[i * 3 + 2] = this.rng() * 6.28;
    }
  }

  // ------------------------------------------------------------------ update
  update(dt: number, rigs: InsectRigs): void {
    const now = wctx.time;
    const jungle = wctx.open < 0.3 && wctx.enabled;
    const low = wctx.low;

    // ---- butterflies
    let target = 0;
    if (jungle) {
      let near = 0;
      for (const a of this.anchors) if (distToPlayerXZ(a.x, a.z) < 36) near++;
      target = Math.max(3, Math.min(low ? 8 : 20, Math.round(near / 4.5)));
    }
    let active = 0;
    for (const b of this.butterflies) if (b.active) active++;
    if (active < target && now >= this.nextSpawn) {
      this.nextSpawn = now + 0.6;
      this.spawnButterfly();
    }
    wildlifeStats.active.butterflies = 0;
    for (const b of this.butterflies) {
      if (!b.active) continue;
      const d = distToPlayer(b.x, b.y, b.z);
      if (!jungle || d > 58 || (active > target + 2 && !inCone(b.x, b.y, b.z, 1) && b.offscreen > 4) || active > target + 4 || (low && active > target)) {
        this.release(b);
        active--;
        continue;
      }
      b.offscreen = inCone(b.x, b.y, b.z, 1) ? 0 : b.offscreen + dt;
      this.stepButterfly(b, dt, now);
      wildlifeStats.active.butterflies++;
    }

    // ---- dragonflies
    wildlifeStats.active.dragonflies = 0;
    for (const d of this.dragonflies) {
      const home = this.water[d.home];
      const dist = distToPlayer(home.x, home.y, home.z);
      const want = jungle && dist < 40;
      if (want && !d.active) this.spawnDragonfly(d);
      else if (!want && d.active && dist > 52) d.active = false;
      if (!d.active) continue;
      this.stepDragonfly(d, dt, now);
      wildlifeStats.active.dragonflies++;
    }
    if (low) {
      // low tier: only the nearest three stay
      let k = 0;
      for (const d of this.dragonflies) if (d.active && ++k > 3) d.active = false;
    }

    // ---- gnats and fireflies
    this.updateGnats(now, jungle && !low);
    this.updateFireflies(now, jungle && !low);

    // ---- draw
    rigs.bflyWings.begin();
    rigs.bflyBody.begin();
    let drawn = 0;
    for (const b of this.butterflies) {
      if (!b.active) continue;
      if (!inCone(b.x, b.y, b.z, 0.5)) continue;
      this.drawButterfly(b, rigs);
      drawn++;
    }
    rigs.bflyWings.end();
    rigs.bflyBody.end();
    wildlifeStats.drawn.butterflies = drawn;
    rigs.dragonWings.begin();
    rigs.dragonBody.begin();
    let dd = 0;
    for (const d of this.dragonflies) {
      if (!d.active || !inCone(d.x, d.y, d.z, 0.5)) continue;
      this.drawDragonfly(d, rigs);
      dd++;
    }
    rigs.dragonWings.end();
    rigs.dragonBody.end();
    wildlifeStats.drawn.dragonflies = dd;
  }

  // ------------------------------------------------------------------ butterflies
  private spawnButterfly(): void {
    const slot = this.butterflies.find((b) => !b.active);
    if (!slot) return;
    // an anchor 10-38 m from the player, free, preferably in the view direction
    let best = -1;
    let bestScore = -1e9;
    for (let i = 0; i < this.anchors.length; i++) {
      if (this.anchorBusy[i]) continue;
      const a = this.anchors[i];
      const d = distToPlayerXZ(a.x, a.z);
      if (d < 9 || d > 38) continue;
      const score = (inCone(a.x, a.y, a.z, 1) ? 2 : 0) + this.rng() * 3 - Math.abs(d - 20) * 0.05;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) return;
    const b = slot;
    const a = this.anchors[best];
    b.active = true;
    b.species = Math.floor(b.rng() * BFLY_TINTS.length);
    b.anchor = best;
    this.anchorBusy[best] = 1;
    b.x = a.x;
    b.y = a.y;
    b.z = a.z;
    b.state = 0;
    b.until = wctx.time + 1 + b.rng() * 4;
    b.yaw = b.rng() * 6.28;
    b.phase = b.rng() * 6.28;
    b.t = 0;
    b.offscreen = 0;
  }

  private release(b: Butterfly): void {
    b.active = false;
    if (b.anchor >= 0) this.anchorBusy[b.anchor] = 0;
    b.anchor = -1;
  }

  private nextAnchor(b: Butterfly): void {
    // a free anchor 3-12 m away from here
    let best = -1;
    let bs = -1e9;
    for (let k = 0; k < 18; k++) {
      const i = Math.floor(b.rng() * this.anchors.length);
      if (this.anchorBusy[i]) continue;
      const a = this.anchors[i];
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d < 3 || d > 14) continue;
      // keep them in the player's neighbourhood
      const pd = distToPlayerXZ(a.x, a.z);
      const s = -Math.abs(pd - 18) * 0.1 + b.rng();
      if (s > bs) {
        bs = s;
        best = i;
      }
    }
    if (best < 0) {
      // wander without landing
      b.tx = b.x + (b.rng() - 0.5) * 8;
      b.tz = b.z + (b.rng() - 0.5) * 8;
      b.ty = terrainHeight(b.tx, b.tz) + 0.8 + b.rng() * 1.4;
      return;
    }
    if (b.anchor >= 0) this.anchorBusy[b.anchor] = 0;
    b.anchor = best;
    this.anchorBusy[best] = 1;
    const a = this.anchors[best];
    b.tx = a.x;
    b.ty = a.y;
    b.tz = a.z;
  }

  private stepButterfly(b: Butterfly, dt: number, now: number): void {
    b.t += dt;
    // frightened by a moving player close by
    const dP = distToPlayer(b.x, b.y, b.z);
    if (b.state !== 2 && dP < 2.4 && wctx.speed > 0.35 && b.rng() < dt * 3) {
      b.state = 2;
      b.until = now + 1.2 + b.rng();
      wildlifeStats.fleeEvents++;
      // dart away and up, then carry on to a new anchor
      const ax = b.x - wctx.px;
      const az = b.z - wctx.pz;
      const l = Math.hypot(ax, az) || 1;
      b.tx = b.x + (ax / l) * 5 + (b.rng() - 0.5) * 3;
      b.tz = b.z + (az / l) * 5 + (b.rng() - 0.5) * 3;
      b.ty = Math.max(b.y + 0.8, terrainHeight(b.tx, b.tz) + 1.6);
      b.speed = 2.6;
    }
    if (b.state === 0) {
      // resting on a flower: wings slowly open and close
      b.phase += dt * 3;
      if (now >= b.until) {
        b.state = 1;
        b.speed = 1.0 + b.rng() * 0.7;
        this.nextAnchor(b);
        b.until = now + 10;
      }
      return;
    }
    // flying: steer toward the target with a wobbling heading; bob up and down
    const dx = b.tx - b.x;
    const dz = b.tz - b.z;
    const dy = b.ty - b.y;
    const dist = Math.hypot(dx, dz);
    let want = Math.atan2(dx, dz);
    want += 0.9 * Math.sin(now * 2.1 + b.phase) + 0.5 * Math.sin(now * 4.3 + b.phase * 2);
    let dyaw = want - b.yaw;
    while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
    while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
    b.yaw += dyaw * Math.min(1, dt * 3.2);
    const v = b.speed * (0.55 + 0.45 * Math.sin(now * 6 + b.phase) * 0.5 + 0.45);
    b.x += Math.sin(b.yaw) * v * dt;
    b.z += Math.cos(b.yaw) * v * dt;
    b.y += (dy * 1.2 + 0.5 * Math.sin(now * 5 + b.phase)) * dt;
    b.phase += dt * (b.state === 2 ? 40 : 34) * (0.8 + 0.2 * Math.sin(now * 0.9 + b.anchor));
    if (dist < 0.45 && Math.abs(dy) < 0.5) {
      if (b.state === 2) {
        b.state = 1;
        b.speed = 1.2;
        this.nextAnchor(b);
      } else {
        b.state = 0;
        b.until = now + 2 + b.rng() * 6;
        b.x = b.tx;
        b.y = b.ty;
        b.z = b.tz;
      }
    } else if (now >= b.until && b.state === 1) {
      this.nextAnchor(b);
      b.until = now + 10;
    }
    if (b.state === 2 && now >= b.until) {
      b.state = 1;
      b.speed = 1.2;
      this.nextAnchor(b);
    }
  }

  private wing(rig: InstanceRig, root: Vector3, side: number, angle: number, len: number, color: Color): void {
    // span axis: out and up by `angle`; leading edge forward; rotated by the body orientation (_q)
    _x.set(side * Math.cos(angle), Math.sin(angle), 0).applyQuaternion(_q);
    _z.set(0, 0, 1).applyQuaternion(_q);
    _y.crossVectors(_z, _x);
    _M.makeBasis(_x.multiplyScalar(len), _y, _z.multiplyScalar(len * 0.95));
    _M.setPosition(root);
    rig.push(_M, color);
  }

  private drawButterfly(b: Butterfly, rigs: InsectRigs): void {
    const len = BFLY_SIZE[b.species];
    const tint = BFLY_TINTS[b.species];
    const landed = b.state === 0;
    // body orientation: yaw toward travel, slight nose-up pitch; a landed butterfly faces its flower
    _e.set(landed ? -0.5 : -0.12, b.yaw, 0, 'YXZ');
    _q.setFromEuler(_e);
    _p.set(b.x, b.y, b.z);
    _S.set(len * 0.62, len * 0.62, len * 0.62);
    _M.compose(_p, _q, _S);
    rigs.bflyBody.push(_M, BFLY_BODY);
    let a: number;
    if (landed) a = 1.05 + 0.35 * Math.sin(b.phase * 0.7) ** 2 * (Math.sin(b.phase * 0.35) > 0.4 ? 1 : 0.15);
    else {
      const glide = Math.sin(wctx.time * 0.8 + b.anchor * 1.7) > 0.72;
      a = glide ? 0.32 : 0.1 + 0.95 * Math.sin(b.phase);
    }
    _C.copy(_p);
    this.wing(rigs.bflyWings, _C, 1, a, len, tint);
    this.wing(rigs.bflyWings, _C, -1, a, len, tint);
  }

  // ------------------------------------------------------------------ dragonflies
  private spawnDragonfly(d: Dragonfly): void {
    const h = this.water[d.home];
    d.active = true;
    d.x = h.x + (d.rng() - 0.5) * 3;
    d.z = h.z + (d.rng() - 0.5) * 3;
    d.y = h.y + d.rng() * 0.6;
    d.tx = d.x;
    d.ty = d.y;
    d.tz = d.z;
    d.hoverUntil = wctx.time + d.rng() * 2;
    d.yaw = d.rng() * 6.28;
  }

  private stepDragonfly(d: Dragonfly, dt: number, now: number): void {
    d.phase += dt * 190;
    const dx = d.tx - d.x;
    const dy = d.ty - d.y;
    const dz = d.tz - d.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > 0.12) {
      // a dart: fast, straight
      const v = Math.min(dist / dt, 4.5 + 2 * Math.sin(d.phase * 0.001));
      d.x += (dx / dist) * v * dt;
      d.y += (dy / dist) * v * dt;
      d.z += (dz / dist) * v * dt;
      d.yaw = Math.atan2(dx, dz);
    } else if (now >= d.hoverUntil) {
      // new hover point near the home anchor, over the water
      const h = this.water[d.home];
      d.tx = h.x + (d.rng() - 0.5) * 6;
      d.tz = h.z + (d.rng() - 0.5) * 6;
      d.ty = h.y + (d.rng() - 0.3) * 0.9;
      d.hoverUntil = now + 0.8 + d.rng() * 3.2;
      // occasionally switch to another water spot
      if (d.rng() < 0.12) d.home = Math.floor(d.rng() * this.water.length);
    } else {
      // hover jitter
      d.x += (d.rng() - 0.5) * 0.02;
      d.z += (d.rng() - 0.5) * 0.02;
      d.y += Math.sin(now * 30 + d.home) * 0.002;
    }
  }

  private drawDragonfly(d: Dragonfly, rigs: InsectRigs): void {
    const len = 0.078;
    _e.set(-0.05, d.yaw, 0, 'YXZ');
    _q.setFromEuler(_e);
    _p.set(d.x, d.y, d.z);
    _S.set(len, len, len);
    _M.compose(_p, _q, _S);
    rigs.dragonBody.push(_M, DRAGON_TINTS[d.tint]);
    // four wings: forewings slightly ahead, hindwings behind; fast small flaps, the pairs out of phase
    const root = _C;
    for (let pair = 0; pair < 2; pair++) {
      const zOff = (pair === 0 ? 0.32 : 0.22) * len;
      for (let side = -1; side <= 1; side += 2) {
        _v.set(side * 0.03 * len, 0.06 * len, zOff).applyQuaternion(_q).add(_p);
        const a = 0.08 + 0.28 * Math.sin(d.phase + pair * 1.6);
        root.copy(_v);
        this.dwing(rigs.dragonWings, root, side, a, len * 0.95);
      }
    }
  }

  private dwing(rig: InstanceRig, root: Vector3, side: number, angle: number, len: number): void {
    _x.set(side * Math.cos(angle), Math.sin(angle), 0).applyQuaternion(_q);
    _z.set(0, 0, 1).applyQuaternion(_q);
    _y.crossVectors(_z, _x);
    _M.makeBasis(_x.multiplyScalar(len), _y, _z.multiplyScalar(len * 0.55));
    _M.setPosition(root);
    rig.push(_M, undefined);
  }

  // ------------------------------------------------------------------ points
  private updateGnats(now: number, on: boolean): void {
    const g = this.gnats;
    if (!on) {
      if (g.visible) g.visible = false;
      wildlifeStats.active.gnats = 0;
      return;
    }
    // re-anchor clouds that are too far / behind: choose a spot 4-14 m ahead-ish, 1-2.4 m above the ground, preferably near the water
    for (let c = 0; c < this.gnatAnchors.length; c++) {
      const a = this.gnatAnchors[c];
      const far = a.y < -900 || distToPlayerXZ(a.x, a.z) > 18 || (!inCone(a.x, a.y, a.z, 3) && distToPlayerXZ(a.x, a.z) > 9);
      if (far) {
        const ang = Math.atan2(wctx.fx, wctx.fz) + (this.rng() - 0.5) * 2.2;
        const r = 4 + this.rng() * 10;
        a.x = wctx.px + Math.sin(ang) * r;
        a.z = wctx.pz + Math.cos(ang) * r;
        a.y = terrainHeight(a.x, a.z) + 1.0 + this.rng() * 1.4;
      }
    }
    const per = this.gnatN / this.gnatAnchors.length;
    for (let i = 0; i < this.gnatN; i++) {
      const a = this.gnatAnchors[Math.floor(i / per)];
      const o = i * 6;
      const t = now * (0.8 + this.gnatPhase[o + 3] * 0.2);
      this.gnatPos[i * 3] = a.x + Math.sin(t * 1.3 + this.gnatPhase[o]) * 0.55 * Math.cos(t * 0.31 + this.gnatPhase[o + 4]);
      this.gnatPos[i * 3 + 1] = a.y + Math.sin(t * 1.7 + this.gnatPhase[o + 1]) * 0.35;
      this.gnatPos[i * 3 + 2] = a.z + Math.cos(t * 1.1 + this.gnatPhase[o + 2]) * 0.55;
    }
    (g.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    if (!g.visible) g.visible = true;
    wildlifeStats.active.gnats = this.gnatN;
  }

  private updateFireflies(now: number, on: boolean): void {
    const f = this.fireflies;
    // only when the player is within ~32 m of a hollow (cheap: test the three centres through the first point of each)
    let near = false;
    if (on) for (let h = 0; h < 3; h++) if (distToPlayerXZ(this.ffBase[h * 3], this.ffBase[h * 3 + 2]) < 32) near = true;
    if (!near) {
      if (f.visible) f.visible = false;
      wildlifeStats.active.fireflies = 0;
      return;
    }
    for (let i = 0; i < this.ffN; i++) {
      const bx = this.ffBase[i * 3];
      const by = this.ffBase[i * 3 + 1];
      const bz = this.ffBase[i * 3 + 2];
      const ph = this.ffPhase[i * 3];
      const per = this.ffPhase[i * 3 + 1];
      const ph2 = this.ffPhase[i * 3 + 2];
      this.ffPos[i * 3] = bx + Math.sin(now * 0.4 + ph) * 0.8;
      this.ffPos[i * 3 + 1] = by + Math.sin(now * 0.6 + ph2) * 0.35;
      this.ffPos[i * 3 + 2] = bz + Math.cos(now * 0.35 + ph) * 0.8;
      // a short glow once per period, otherwise dark
      const s = Math.max(0, Math.sin(((now + ph * 3) / per) * Math.PI * 2));
      const b = Math.pow(s, 10) * 0.55;
      this.ffCol[i * 3] = 0.78 * b;
      this.ffCol[i * 3 + 1] = 1.0 * b;
      this.ffCol[i * 3 + 2] = 0.35 * b;
    }
    (f.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (f.geometry.getAttribute('color') as BufferAttribute).needsUpdate = true;
    if (!f.visible) f.visible = true;
    wildlifeStats.active.fireflies = this.ffN;
  }

  /** Test hook: how many butterflies were told to flee. */
  fleeCount(): number {
    return wildlifeStats.fleeEvents;
  }

  snapshot(): { butterflies: { active: boolean; state: number; x: number; y: number; z: number }[]; dragonflies: { active: boolean; x: number; y: number; z: number }[] } {
    return {
      butterflies: this.butterflies.map((b) => ({ active: b.active, state: b.state, x: b.x, y: b.y, z: b.z })),
      dragonflies: this.dragonflies.map((d) => ({ active: d.active, x: d.x, y: d.y, z: d.z })),
    };
  }
}

void BufferGeometry;
void Float32BufferAttribute;
void _one;

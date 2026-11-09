import { CanvasTexture, createSystem, Euler, IcosahedronGeometry, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, Object3D, Quaternion, Sprite, SpriteMaterial, Vector3 } from '@iwsdk/core';
import { EVENT, PEBBLES, SHELF, lipFlights, pebbleFlights, sample } from '../world/collapse.js';
import type { LipPiece, Pebble } from '../world/collapse.js';
import { MTN, smoothstep } from '../world/layout.js';
import { routeNear } from '../world/mountain.js';
import { crackMaterial } from '../scene-assets/lib/materials.js';
import { loadComfort } from '../settings/comfort.js';
import { pulse } from './haptics.js';

/**
 * The collapsing ledge, as a state machine (see world/collapse.ts for the layout and the scripted ballistics).
 *
 *   intact ─(approach)→ warning ─→ tremor ─→ breaking ─→ collapsed ─(reset)→ intact
 *      ↑                   │ (player retreats > 20 m before the break: cancel)
 *      └───────────────────┘
 * Cracks fade in with proximity, then a shower of pebbles falls onto the shelf and off its lip, then the ground trembles
 * (controller haptics + a few mm of vertical tremor on the walking surface; both off in reduced-motion), then the
 * shelf breaks: the valley-side lip tumbles away, and the walking surface (a KINEMATIC locomotion environment) sinks 2.35 m
 * over 1.8 s with an eased curve, carrying anyone standing on it; the hollow underneath is static terrain, so the player
 * ends standing on the rubble. The camera is never rotated or driven: only the ground moves.
 * Reset: the event re-arms when the player is far from the shelf (and not looking at it), or via window.__jumanjiCollapse.reset().
 * Allocation-free in update() apart from the one-time setup.
 */
export type CollapseState = 'intact' | 'warning' | 'tremor' | 'breaking' | 'collapsed';
export const collapse = { state: 'intact' as CollapseState, distance: Infinity, breaks: 0, resets: 0, playerOnShelf: false, lastCarry: 0 };

const REST_FAR = -400;

export class CollapseSystem extends createSystem({}) {
  private found = false;
  private collider: Object3D | null = null;
  private colliderRestY = 0;
  private intact: Object3D | null = null;
  private cracksMesh: Object3D | null = null;
  private rides: { m: Object3D; rest: Vector3; row: number }[] = [];
  private lips: { m: Object3D; rest: Vector3; row: number; flight: LipPiece }[] = [];
  private pebbleData: Pebble[] = [];
  private pebbles!: InstancedMesh;
  private dust: { s: Sprite; life: number; vx: number; vy: number; vz: number }[] = [];
  private t0 = 0;
  private breakAt = 0;
  private tremorAt = 0;
  private shower = 0;
  private lastPulse = 0;
  private cracks = 0;
  private reduced = false;
  private landed = false;
  private readonly p = new Vector3();
  private readonly look = new Vector3();
  private readonly m4 = new Matrix4();
  private readonly q = new Quaternion();
  private readonly eul = new Euler();
  private readonly pos = new Vector3();
  private readonly rest = new Vector3();
  private shelfCenter = new Vector3();

  init(): void {
    this.reduced = loadComfort().reducedMotion;
    this.pebbleData = pebbleFlights();
    const flights = lipFlights();
    this.pebbles = new InstancedMesh(new IcosahedronGeometry(1, 0), new MeshStandardMaterial({ color: '#8d877a', roughness: 0.95, flatShading: true }), PEBBLES);
    this.pebbles.frustumCulled = false;
    this.pebbles.count = PEBBLES;
    for (let i = 0; i < PEBBLES; i++) {
      this.m4.makeScale(0, 0, 0);
      this.pebbles.setMatrixAt(i, this.m4);
    }
    this.world.scene.add(this.pebbles);
    // dust puffs (one canvas gradient, one SpriteMaterial each so they fade independently)
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 2, 32, 32, 31);
    grad.addColorStop(0, 'rgba(176,164,140,0.9)');
    grad.addColorStop(1, 'rgba(176,164,140,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    const tex = new CanvasTexture(c);
    for (let i = 0; i < 14; i++) {
      const s = new Sprite(new SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 }));
      s.visible = false;
      this.world.scene.add(s);
      this.dust.push({ s, life: 0, vx: 0, vy: 0, vz: 0 });
    }
    this.lipsPending = flights;
    (window as unknown as { __jumanjiCollapse?: unknown }).__jumanjiCollapse = {
      state: collapse,
      trigger: () => this.beginBreak(performance.now() / 1000),
      reset: () => this.reset(),
      /** place the head at route arc length s (for tests); returns the position */
    };
  }
  private lipsPending: LipPiece[] = [];

  private locate(): void {
    const root = this.world.scene.getObjectByName('Collapse shelf');
    const node = this.world.scene.getObjectByName('Shelf collider') ?? this.world.scene.getObjectByName('ShelfCollider');
    if (!root || !node) return;
    this.collider = node;
    this.intact = root.getObjectByName('ShelfIntact') ?? null;
    this.cracksMesh = root.getObjectByName('ShelfCracks') ?? null;
    if (this.cracksMesh) this.cracksMesh.visible = false;
    this.pebbles.visible = false;
    this.colliderRestY = node.position.y;
    for (const m of root.children) {
      const mm = /^Shelf(Ride|Lip)_(\d+)$/.exec(m.name);
      if (!mm) continue;
      const row = Number(mm[2]);
      if (mm[1] === 'Ride') this.rides.push({ m, rest: m.position.clone(), row });
      else this.lips.push({ m, rest: m.position.clone(), row, flight: this.lipsPending[row] });
    }
    const first = this.rides[0]?.rest;
    if (first) this.shelfCenter.set(first.x, first.y, first.z);
    this.found = this.rides.length > 0 && this.lips.length > 0;
  }

  private reset(): void {
    collapse.state = 'intact';
    collapse.resets++;
    // intact = the single merged mesh; the separate pieces exist only from the break on
    if (this.intact) {
      this.intact.visible = true;
      this.intact.position.set(0, 0, 0);
    }
    for (const r of this.rides) {
      r.m.position.copy(r.rest);
      r.m.rotation.set(0, 0, 0);
      r.m.visible = false;
    }
    for (const l of this.lips) {
      l.m.position.copy(l.rest);
      l.m.rotation.set(0, 0, 0);
      l.m.visible = false;
    }
    if (this.collider) this.collider.position.y = this.colliderRestY;
    crackMaterial.opacity = 0;
    this.cracks = 0;
    this.shower = 0;
    this.landed = false;
    this.hidePebbles();
    for (const d of this.dust) d.s.visible = false;
  }

  private hidePebbles(): void {
    this.m4.makeScale(0, 0, 0);
    for (let i = 0; i < PEBBLES; i++) this.pebbles.setMatrixAt(i, this.m4);
    this.pebbles.instanceMatrix.needsUpdate = true;
  }

  private beginBreak(now: number): void {
    if (!this.found || collapse.state === 'breaking' || collapse.state === 'collapsed') return;
    collapse.state = 'breaking';
    collapse.breaks++;
    if (this.intact) this.intact.visible = false;
    // the crack overlay lies on the rest position: it goes with the intact surface
    this.cracks = 0;
    crackMaterial.opacity = 0;
    if (this.cracksMesh) this.cracksMesh.visible = false;
    for (const r of this.rides) r.m.visible = true;
    for (const l of this.lips) l.m.visible = true;
    this.breakAt = now;
    this.landed = false;
    pulse(this.world, 'both', 0.95, 170);
    for (let i = 0; i < this.dust.length; i++) {
      const d = this.dust[i];
      const l = this.lips[i % this.lips.length];
      d.s.position.copy(l.rest).add(this.pos.set((Math.random() - 0.5) * 2, 0.2, (Math.random() - 0.5) * 2));
      d.s.scale.setScalar(1.2);
      d.life = 2.6;
      d.vx = (Math.random() - 0.5) * 0.6;
      d.vy = 0.5 + Math.random() * 0.5;
      d.vz = (Math.random() - 0.5) * 0.6;
      d.s.visible = true;
    }
  }

  update(delta: number, time: number): void {
    if (!this.found) {
      this.t0 += delta;
      if (this.t0 > 0.5) {
        this.t0 = 0;
        this.locate();
      }
      return;
    }
    this.player.getWorldPosition(this.p);
    const h = routeNear(MTN, this.p.x, this.p.z);
    const onRoute = h.dist < h.hw + 3 && Math.abs(this.p.y - h.y) < 4.8;
    const { s0, s1 } = MTN.cleft;
    const dist = onRoute ? Math.max(0, s0 - h.s, h.s - s1) : Infinity;
    collapse.distance = dist;
    collapse.playerOnShelf = onRoute && dist === 0 && Math.abs(h.l) < SHELF.rideEdge;
    const now = time;

    switch (collapse.state) {
      case 'intact':
        if (dist < EVENT.crackFrom) collapse.state = 'warning';
        break;
      case 'warning':
        if (dist > EVENT.cancelBeyond) collapse.state = 'intact';
        else if (dist < EVENT.tremorFrom) {
          collapse.state = 'tremor';
          this.tremorAt = now;
        }
        break;
      case 'tremor': {
        if (dist > EVENT.cancelBeyond) {
          collapse.state = 'intact';
          break;
        }
        const t = now - this.tremorAt;
        const due = t >= EVENT.tremorToBreak || (collapse.playerOnShelf && t >= EVENT.minTremor);
        if (due) this.beginBreak(now);
        break;
      }
      case 'collapsed': {
        // Re-arm when the player has moved well away and is not looking at the shelf (or very far away).
        const dE = Math.hypot(this.p.x - this.shelfCenter.x, this.p.z - this.shelfCenter.z);
        if (dE > EVENT.resetHardDistance || (dE > EVENT.resetDistance && !this.lookingAtShelf())) this.reset();
        break;
      }
    }

    // ---- cracks (fade with proximity; fixed full once the tremor has begun) ----
    const crackTarget = collapse.state === 'intact' ? 0 : collapse.state === 'warning' ? smoothstep(EVENT.crackFrom, EVENT.crackFull, dist) : collapse.state === 'tremor' ? 1 : 0;
    this.cracks += (crackTarget - this.cracks) * (1 - Math.exp(-delta * 3));
    crackMaterial.opacity = this.cracks * 0.9;
    if (this.cracksMesh) {
      const vis = this.cracks > 0.01;
      if (this.cracksMesh.visible !== vis) this.cracksMesh.visible = vis;
    }

    // ---- pebble shower: while approaching (inside pebblesFrom) and during the tremor ----
    const showering = (collapse.state === 'warning' && dist < EVENT.pebblesFrom) || collapse.state === 'tremor' || (collapse.state === 'breaking' && now - this.breakAt < 1.5);
    if (showering) this.shower += delta;
    if (showering || collapse.state === 'breaking') {
      if (!this.pebbles.visible) this.pebbles.visible = true;
      this.updatePebbles();
    } else if (this.shower > 0 || this.pebbles.visible) {
      this.shower = 0;
      this.hidePebbles();
      this.pebbles.visible = false;
    }

    // ---- tremor ----
    let tremorY = 0;
    if (collapse.state === 'tremor') {
      const t = now - this.tremorAt;
      const a = smoothstep(0, 1.2, t);
      if (!this.reduced) tremorY = a * 0.0035 * Math.sin(t * Math.PI * 2 * 9);
      if (now - this.lastPulse > 0.09) {
        this.lastPulse = now;
        pulse(this.world, 'both', 0.1 + 0.28 * a, 70);
      }
    }

    // ---- break animation ----
    if (collapse.state === 'breaking') {
      const t = now - this.breakAt;
      const p = Math.min(1, t / SHELF.sinkTime);
      const ease = p * p * (3 - 2 * p);
      const dy = -SHELF.sinkDepth * ease;
      if (this.collider && !this.landed) this.collider.position.y = this.colliderRestY + dy;
      collapse.lastCarry = dy;
      for (const r of this.rides) {
        r.m.position.set(r.rest.x, r.rest.y + dy, r.rest.z);
        // a little visual roll of each row as it lets go (a few cm at the edges; the walking collider stays level)
        r.m.rotation.x = Math.sin(Math.PI * Math.min(1, ease * 1.2)) * 0.028 * (r.row % 2 ? 1 : -1);
        r.m.visible = p < 1;
      }
      for (const l of this.lips) {
        const tt = t - l.flight.delay;
        if (tt < 0) continue;
        const k = sample(l.flight.frames, tt);
        const k0 = l.flight.frames[0];
        l.m.position.set(l.rest.x + (k.x - k0.x), l.rest.y + (k.y - k0.y), l.rest.z + (k.z - k0.z));
        l.m.rotation.set(k.rx, k.ry, k.rz);
        l.m.visible = tt < EVENT.debrisLife;
      }
      if (p >= 1 && !this.landed) {
        this.landed = true;
        if (collapse.playerOnShelf || (onRoute && h.s >= s0 - 1 && h.s <= s1 + 1)) pulse(this.world, 'both', 0.45, 100);
        // the collider has served its purpose: park it far below so nothing can snag on it
        if (this.collider) this.collider.position.y = REST_FAR;
      }
      if (t > 1.8) pulse(this.world, 'both', Math.max(0, 0.3 * (1 - (t - 1.8) / 1.6)), 60);
      if (t > EVENT.debrisLife + 1.4) {
        // everything of the event is out of sight by now: hide the leftovers so nothing hangs in the air
        for (const l of this.lips) l.m.visible = false;
        for (const r of this.rides) r.m.visible = false;
        collapse.state = 'collapsed';
      }
    } else if (this.collider && collapse.state !== 'collapsed') {
      this.collider.position.y = this.colliderRestY + tremorY;
      if (this.intact) this.intact.position.y = tremorY;
    }

    // ---- dust ----
    for (const d of this.dust) {
      if (!d.s.visible) continue;
      d.life -= delta;
      if (d.life <= 0) {
        d.s.visible = false;
        continue;
      }
      d.s.position.x += d.vx * delta;
      d.s.position.y += d.vy * delta;
      d.s.position.z += d.vz * delta;
      d.s.scale.addScalar(delta * 1.4);
      d.s.material.opacity = Math.min(0.55, d.life / 2.6);
    }
  }

  private lookingAtShelf(): boolean {
    this.world.camera.getWorldDirection(this.look);
    this.world.camera.getWorldPosition(this.pos);
    this.rest.copy(this.shelfCenter).sub(this.pos);
    const d = this.rest.length();
    return d < 320 && this.rest.dot(this.look) > 0.25 * d;
  }

  private updatePebbles(): void {
    const cycle = 7;
    for (let i = 0; i < PEBBLES; i++) {
      const pb = this.pebbleData[i];
      const total = pb.frames[pb.frames.length - 1].t;
      const local = (this.shower - pb.at) % cycle;
      if (this.shower < pb.at || local < 0 || local > total) {
        this.m4.makeScale(0, 0, 0);
      } else {
        const k = sample(pb.frames, local);
        this.eul.set(k.rx, k.ry, k.rz);
        this.q.setFromEuler(this.eul);
        this.m4.compose(this.pos.set(k.x, k.y, k.z), this.q, this.rest.set(pb.scale, pb.scale * 0.8, pb.scale));
      }
      this.pebbles.setMatrixAt(i, this.m4);
    }
    this.pebbles.instanceMatrix.needsUpdate = true;
  }
}

void Mesh;

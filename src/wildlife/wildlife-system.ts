import { createSystem, Group, Quaternion, Vector3 } from '@iwsdk/core';
import { AmbientAudio, audioInfo } from '../audio/ambient-audio.js';
import { qualityState } from '../settings/quality.js';
import { loadComfort } from '../settings/comfort.js';
import { terrainHeight } from '../world/layout.js';
import { swayState } from '../scene-assets/lib/materials.js';
import { weather } from '../world/weather.js';
import { atmosphere } from '../systems/atmosphere-system.js';
import { Birds } from './birds.js';
import { wctx, wildlifeStats } from './context.js';
import { Insects, makeClouds } from './insects.js';
import { createBone, createButterflyWing, createDragonflyBody, createDragonflyWing, createInsectBody, createMacawBody, createMonkeyBody, createMonkeyHead, createSmallBirdBody, createToucanBody, createWingSegment, creatureMaterial, creatureWingMaterial, dragonWingMaterial } from './models.js';
import { Monkeys } from './monkeys.js';
import { InstanceRig } from './rig.js';

const PREF = 'jumanji-vr.wildlife.v1';

/**
 * The living jungle: birds, monkeys, butterflies, dragonflies, gnats, fireflies, and the ambient sound.
 *
 * One system drives every creature module once per frame (they share `wctx`, the per-frame player/view state), then writes the visible
 * creatures into a dozen InstancedMeshes (a draw call each, only while something is visible). Creatures are NOT part of the static vegetation
 * batches and have no physics or colliders: they are simulated state machines, deterministic from seeds (placement, schedules, species mix).
 *   - Active set: a creature is simulated only within its spawn distance of the player (hysteresis on the way out) and under the per-tier caps.
 *   - View cone: only creatures inside a 72 degree half-angle cone are written to the GPU (the rest keep simulating for a moment, cheaply).
 *   - Tiers: 'low' trims the caps (birds 12, monkeys 4, butterflies 8, dragonflies 3), drops gnats and fireflies and uses cheaper audio panning.
 *   - Off switch: ?wildlife=0, localStorage, or the board's Wildlife button.
 * Allocation-free in update(); the scratch vectors live at module level or on the instance.
 */
export class WildlifeSystem extends createSystem({}) {
  birds!: Birds;
  monkeys!: Monkeys;
  insects!: Insects;
  audio!: AmbientAudio;
  private group = new Group();
  private rigs!: {
    macaw: InstanceRig;
    toucan: InstanceRig;
    small: InstanceRig;
    wings: InstanceRig;
    mBody: InstanceRig;
    mHead: InstanceRig;
    mBones: InstanceRig;
    bflyWings: InstanceRig;
    bflyBody: InstanceRig;
    dragonWings: InstanceRig;
    dragonBody: InstanceRig;
  };
  private pos = new Vector3();
  private dir = new Vector3();
  private upv = new Vector3();
  private quat = new Quaternion();
  private lastX = NaN;
  private lastZ = NaN;
  private stillFor = 0;
  private hand = new Vector3();
  private clock = 0;
  /** The creature tables (perches, graph, population) are built in slices shortly after the scene loads, not inside system init. */
  ready = false;

  init(): void {
    const q = new URLSearchParams(globalThis.location?.search ?? '').get('wildlife');
    let pref = true;
    try {
      pref = localStorage.getItem(PREF) !== 'off';
    } catch {
      /* private mode */
    }
    wctx.enabled = q === '0' ? false : q === '1' ? true : pref;

    this.audio = new AmbientAudio();
    wctx.audio = this.audio;

    const body = creatureMaterial;
    const wing = creatureWingMaterial;
    this.rigs = {
      macaw: new InstanceRig('Wildlife macaws', createMacawBody(), body, 12, false),
      toucan: new InstanceRig('Wildlife toucans', createToucanBody(), body, 12, false),
      small: new InstanceRig('Wildlife small birds', createSmallBirdBody(), body, 26),
      wings: new InstanceRig('Wildlife bird wings', createWingSegment(), wing, 240),
      mBody: new InstanceRig('Wildlife monkey bodies', createMonkeyBody(), body, 8),
      mHead: new InstanceRig('Wildlife monkey heads', createMonkeyHead(), body, 8),
      mBones: new InstanceRig('Wildlife monkey limbs', createBone(), body, 120),
      bflyWings: new InstanceRig('Wildlife butterfly wings', createButterflyWing(), wing, 60),
      bflyBody: new InstanceRig('Wildlife butterfly bodies', createInsectBody(), body, 30),
      dragonWings: new InstanceRig('Wildlife dragonfly wings', createDragonflyWing(), dragonWingMaterial, 28, false),
      dragonBody: new InstanceRig('Wildlife dragonflies', createDragonflyBody(), body, 8),
    };
    this.group.name = 'Wildlife';
    for (const r of Object.values(this.rigs)) this.group.add(r.mesh);
    // the point clouds exist from the start (so the shader warm-up compiles them); the Insects simulation fills them later
    const clouds = makeClouds();
    this.group.add(clouds.gnats, clouds.fireflies);
    this.world.scene.add(this.group);

    // population in three slices, ~100 ms apart (about 140 ms of work on a desktop, more on a Quest: done while the page is still loading)
    const slice = (n: number): void => {
      if (n === 0) this.birds = new Birds();
      else if (n === 1) this.monkeys = new Monkeys();
      else {
        this.insects = new Insects(clouds);
        this.ready = true;
        return;
      }
      setTimeout(() => slice(n + 1), 100);
    };
    setTimeout(() => slice(0), 1200);

    // the sound engine can only start inside a user gesture: a click/key/touch anywhere does it (AmbientAudio listens), and so does entering VR
    const xr = this.world.renderer.xr;
    const onSession = (): void => this.audio.unlock();
    xr.addEventListener('sessionstart', onSession);
    this.cleanupFuncs.push(() => xr.removeEventListener('sessionstart', onSession));

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    (window as unknown as { __jumanjiWildlife?: unknown }).__jumanjiWildlife = {
      get birds() { return self.birds; },
      get monkeys() { return self.monkeys; },
      get insects() { return self.insects; },
      get ready() { return self.ready; },
      audio: this.audio,
      stats: wildlifeStats,
      audioInfo,
      ctx: wctx,
      group: this.group,
      setEnabled: (on: boolean) => this.setEnabled(on),
      terrainY: terrainHeight,
    };
  }

  setEnabled(on: boolean): void {
    wctx.enabled = on;
    try {
      localStorage.setItem(PREF, on ? 'on' : 'off');
    } catch {
      /* ignore */
    }
    if (!on) this.birds?.reset();
  }

  update(delta: number, time: number): void {
    const t0 = performance.now();
    const dt = Math.min(0.1, Math.max(0.001, delta));
    this.clock += dt;
    const cam = this.world.camera;
    cam.getWorldPosition(this.pos);
    cam.getWorldDirection(this.dir);
    cam.getWorldQuaternion(this.quat);
    this.upv.set(0, 1, 0).applyQuaternion(this.quat);
    wctx.time = this.clock;
    wctx.dt = dt;
    wctx.px = this.pos.x;
    wctx.py = this.pos.y;
    wctx.pz = this.pos.z;
    wctx.fx = this.dir.x;
    wctx.fy = this.dir.y;
    wctx.fz = this.dir.z;
    this.player.getWorldPosition(this.hand);
    wctx.gy = this.hand.y;
    // smoothed walking speed (ignore teleports)
    if (Number.isFinite(this.lastX)) {
      const d = Math.hypot(this.pos.x - this.lastX, this.pos.z - this.lastZ);
      if (d < 6 * dt + 0.5) wctx.speed += (d / dt - wctx.speed) * Math.min(1, dt * 4);
    }
    this.lastX = this.pos.x;
    this.lastZ = this.pos.z;
    this.stillFor = wctx.speed < 0.25 ? this.stillFor + dt : 0;
    wctx.still = this.stillFor > 4;
    wctx.open = atmosphere.open;
    wctx.low = qualityState.tier === 'low';
    this.audio.setLow(wctx.low);

    const r = this.rigs;
    if (!this.ready) {
      // still building the creature tables: only the sound engine's listener runs
    } else if (wctx.enabled) {
      this.birds.update(dt, 22, { macaw: r.macaw, toucan: r.toucan, small: r.small, wings: r.wings });
      this.monkeys.update(dt, 6, { body: r.mBody, head: r.mHead, bones: r.mBones });
      this.insects.update(dt, { bflyWings: r.bflyWings, bflyBody: r.bflyBody, dragonWings: r.dragonWings, dragonBody: r.dragonBody });
    } else {
      for (const rig of Object.values(r)) {
        rig.begin();
        rig.end();
      }
      this.insects.gnats.visible = false;
      this.insects.fireflies.visible = false;
    }
    const activity = Math.min(1, (wildlifeStats.flying + wildlifeStats.active.monkeys) / 10);
    this.audio.update(dt, this.pos.x, this.pos.y, this.pos.z, this.dir.x, this.dir.y, this.dir.z, this.upv.x, this.upv.y, this.upv.z, wctx.open, wctx.still, activity);
    wildlifeStats.updateMs += (performance.now() - t0 - wildlifeStats.updateMs) * 0.05;
    void time;
  }
}

/**
 * Wind and proximity for the plant shader (see `plantFoliageMaterial`): updates the shared uniforms once per frame.
 * The player's feet and both hands push low plants aside; the wind runs at 40 % in reduced-motion mode.
 */
export class ReactiveFoliageSystem extends createSystem({}) {
  private v = new Vector3();
  private reduced = false;
  private nextCheck = 0;

  update(_delta: number, time: number): void {
    swayState.time.value = time;
    if (time >= this.nextCheck) {
      this.nextCheck = time + 1;
      this.reduced = loadComfort().reducedMotion;
    }
    // the gusts of the shared weather (world/weather.ts) move the plants, the leaf hiss and the falling leaves together
    swayState.wind.value += ((this.reduced ? 0.4 : weather.wind) - swayState.wind.value) * 0.1;
    const b = swayState.body.value;
    this.player.getWorldPosition(this.v);
    b[0].set(this.v.x, this.v.y + 0.55, this.v.z);
    if (this.world.renderer.xr.isPresenting) {
      this.player.gripSpaces.left.getWorldPosition(b[1]);
      this.player.gripSpaces.right.getWorldPosition(b[2]);
    } else {
      b[1].set(0, -999, 0);
      b[2].set(0, -999, 0);
    }
  }
}

import { createSystem, DirectionalLightComponent, Group, Vector3 } from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import { Relic } from '../components/jungle-components.js';
import { swayState } from '../scene-assets/lib/materials.js';
import { loadComfort } from '../settings/comfort.js';
import { wctx } from '../wildlife/context.js';
import { FallingLeaves, Lizards, Motes, POLLEN, Ripples, Stride, UnseenMover, livingStats, makeMotes } from '../wildlife/living.js';
import { createLeaf, createLizard, createRing, creatureMaterial, creatureWingMaterial, rippleMaterial } from '../wildlife/models.js';
import { InstanceRig } from '../wildlife/rig.js';
import { WildlifeSystem } from '../wildlife/wildlife-system.js';
import { ALTAR, ALTAR_TOP_Y, areaWeights, distanceToPath, terrainHeight, vegetationDensity } from '../world/layout.js';
import { surfaceAt, waterLevelAt } from '../world/surface.js';
import { weather } from '../world/weather.js';

/**
 * THE LIVING WORLD: everything that makes the place react to the weather and to you, on top of the wildlife (WildlifeSystem) and the authored scene.
 *
 *   weather      steps the one shared weather (world/weather.ts): its gusts drive the plant shaders (ReactiveFoliageSystem), the leaf hiss and the insect
 *                mix (AmbientAudio.setEnvironment), the falling leaves and the pollen; its rare thunder is a far-off roll with NO flash and no darkening;
 *                its slow cloud-light multiplies the sun by 0.93..1.04, changing by under 1 % per second.
 *   footsteps    one sound per stride, chosen from the surface underfoot (world/surface.ts); wading leaves rings on the water; pushing through thick
 *                plants off the trail rustles.
 *   small life   lizards at the trail's edge that bolt and creep back, an animal you never see moving through the undergrowth, leaves coming down.
 *   the clearing embers drifting in toward the Heartstone and the stone's hum (both follow the stone when it is carried).
 *
 * Cost: 3 instanced draws that are hidden while empty (leaves, lizards, ripples) + 1 point cloud; fixed pools, no allocation after init. 'low' tier:
 * 6 leaves, 6 lizards, 16 pollen specks. Reduced motion: no light breathing, pollen hangs still, plants keep their reduced sway.
 */
export class LivingWorldSystem extends createSystem({
  suns: { required: [DirectionalLightComponent] },
  relics: { required: [Relic] },
}) {
  private group = new Group();
  private rigs!: { leaves: InstanceRig; lizards: InstanceRig; ripples: InstanceRig };
  private stride = new Stride();
  private leaves = new FallingLeaves();
  private lizards!: Lizards;
  private motes!: Motes;
  private ripples = new Ripples();
  private unseen = new UnseenMover();
  private feet = new Vector3();
  private heart = new Vector3();
  private lastX = NaN;
  private lastZ = NaN;
  private slowAt = 0;
  private clock = 0;
  private reduced = false;
  private area = { entrance: 0, trail: 1, clearing: 0 };
  private sunBase = new Map<Entity, number>();
  private sunLast = 1;
  private brush = 0;
  private altarY = 0;

  init(): void {
    this.rigs = {
      leaves: new InstanceRig('Living leaves', createLeaf(), creatureWingMaterial, 14),
      lizards: new InstanceRig('Living lizards', createLizard(), creatureMaterial, 10),
      ripples: new InstanceRig('Living ripples', createRing(), rippleMaterial, 8),
    };
    const cloud = makeMotes();
    this.motes = new Motes(cloud);
    this.group.name = 'Living world';
    this.group.add(this.rigs.leaves.mesh, this.rigs.lizards.mesh, this.rigs.ripples.mesh, cloud.points);
    this.world.scene.add(this.group);
    this.altarY = terrainHeight(ALTAR[0], ALTAR[1]) + ALTAR_TOP_Y + 0.12;
    // the lizards' spots need the placement tables: built a little after load, like the wildlife population
    setTimeout(() => (this.lizards = new Lizards()), 1700);
    this.reduced = loadComfort().reducedMotion;

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    (window as unknown as { __jumanjiLiving?: unknown }).__jumanjiLiving = {
      stats: livingStats,
      weather,
      stride: this.stride,
      leaves: this.leaves,
      ripples: this.ripples,
      unseen: this.unseen,
      get lizards() { return self.lizards; },
      group: this.group,
      surfaceAt,
    };
  }

  update(delta: number, time: number): void {
    const t0 = performance.now();
    const dt = Math.min(0.1, Math.max(0.001, delta));
    this.clock += dt;
    const audio = this.world.getSystem(WildlifeSystem)?.audio;
    const low = wctx.low;
    this.player.getWorldPosition(this.feet);
    const fx = this.feet.x;
    const fy = this.feet.y;
    const fz = this.feet.z;

    // ---- weather
    weather.step(dt);
    livingStats.gust = weather.gust;
    livingStats.light = weather.light;
    if (weather.thunderPending) {
      weather.thunderPending = false;
      livingStats.thunders++;
      audio?.thunder(weather.thunderBearing, weather.thunderGain);
      audio?.hush(5, 0.45); // the forest listens
    }

    // ---- 4 Hz: where we are, comfort settings, the sun under thin cloud
    if (this.clock >= this.slowAt) {
      this.slowAt = this.clock + 0.25;
      // NOTE: layout.areaWeights().entrance is 1 on the FAR side of z = -13 (the deep forest) and 0 at the threshold - the opposite of areaAt().
      // The baked placements depend on it, so it is left alone; here the threshold band is derived the way areaAt() means it.
      const a = areaWeights(fx, fz);
      const jungle = 1 - wctx.open;
      const zt = Math.min(1, Math.max(0, (fz + 13) / 9));
      const threshold = zt * zt * (3 - 2 * zt) * (1 - a.clearing);
      this.area.entrance = threshold * jungle;
      this.area.trail = Math.max(0, 1 - threshold - a.clearing) * jungle + wctx.open;
      this.area.clearing = a.clearing * jungle;
      audio?.setEnvironment(weather.gust, this.area.entrance, this.area.trail, this.area.clearing);
      this.reduced = loadComfort().reducedMotion;
      const light = this.reduced ? 1 : weather.light;
      if (Math.abs(light - this.sunLast) > 0.004) {
        this.sunLast = light;
        for (const e of this.queries.suns.entities) {
          let base = this.sunBase.get(e);
          if (base === undefined) {
            base = Number(e.getValue(DirectionalLightComponent, 'intensity')) || 1;
            this.sunBase.set(e, base);
          }
          e.setValue(DirectionalLightComponent, 'intensity', base * light);
        }
      }
    }

    // ---- footsteps
    const moved = Number.isFinite(this.lastX) ? Math.hypot(fx - this.lastX, fz - this.lastZ) : 0;
    this.lastX = fx;
    this.lastZ = fz;
    if (this.stride.step(dt, moved, wctx.speed)) {
      const surface = surfaceAt(fx, fz, fy);
      livingStats.steps++;
      livingStats.lastSurface = surface;
      audio?.footstep(surface, this.stride.side, 0.45 + 0.3 * wctx.speed);
      if (surface === 'water') {
        const wl = waterLevelAt(fx, fz);
        if (wl !== null) {
          this.ripples.spawn(fx, wl, fz, 0.55);
          this.ripples.spawn(fx, wl, fz, 0.8, 0.22);
        }
      } else if (surface === 'litter' || surface === 'grass') {
        // shouldering through thick plants off the trail: every second or third step brushes something
        const p = distanceToPath(fx, fz);
        if (p.dist > p.halfWidth + 0.4 && vegetationDensity(fx, fz) > 0.5 && ++this.brush % 3 !== 0) {
          livingStats.brushRustles++;
          audio?.rustle(fx + wctx.fx * 0.4, fy + 0.6, fz + wctx.fz * 0.4, 0.3);
        }
      }
    }

    // ---- leaves, water, lizards, the unseen animal
    this.leaves.update(dt, weather.gust, weather.dirX, weather.dirZ, low ? 6 : 14);
    if (this.leaves.splash) {
      this.leaves.splash = false;
      this.ripples.spawn(this.leaves.splashX, this.leaves.splashY, this.leaves.splashZ, 0.28);
    }
    this.leaves.write(this.rigs.leaves);
    this.ripples.update(dt);
    this.ripples.write(this.rigs.ripples);
    const body = swayState.body.value[3];
    if (this.lizards && wctx.enabled) {
      const n = low ? 6 : 10;
      this.lizards.update(dt, n);
      this.lizards.write(this.rigs.lizards, n);
      this.unseen.update(dt, this.area.entrance, body);
    } else {
      this.rigs.lizards.begin();
      this.rigs.lizards.end();
      if (this.unseen.active) this.unseen.stop(body);
    }

    // ---- the Heartstone: its hum and the embers follow the stone itself
    let glow = 0;
    this.heart.set(ALTAR[0], this.altarY, ALTAR[1]);
    for (const e of this.queries.relics.entities) {
      if (!e.object3D) continue;
      e.object3D.getWorldPosition(this.heart);
      glow = e.getValue(Relic, 'glow') ?? 0;
      break;
    }
    audio?.setHeart(this.heart.x, this.heart.y, this.heart.z, 0.7 + 0.5 * glow);
    this.motes.update(dt, weather.gust, weather.dirX, weather.dirZ, this.heart.x, this.heart.y, this.heart.z, glow, 0.5 + 0.5 * Math.sin(time * 1.8), low ? 16 : POLLEN, this.reduced);

    livingStats.updateMs += (performance.now() - t0 - livingStats.updateMs) * 0.05;
  }
}

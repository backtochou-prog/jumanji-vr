import { createSystem, DoubleSide, Group, Mesh, MeshBasicMaterial, Vector3 } from '@iwsdk/core';
import { atmosphere } from './atmosphere-system.js';
import { qualityState } from '../settings/quality.js';
import { loadComfort } from '../settings/comfort.js';
import { smoothstep } from '../world/layout.js';
import { createSkyClouds, createSkyGlow } from '../scene-assets/sky.scene-asset.js';

/**
 * The sky pack of the Overlook Knoll (geometry: scene-assets/sky.scene-asset.ts): cloud banks, a warm sunward haze and a sun disc, two meshes sharing ONE
 * runtime material (outside the asset manifest, which stays at 16/16; asset-stats counts it as a reserve).
 *
 *  - Built once in init() and added to the scene, hidden: warmShaders() (which shows hidden meshes for the compile) builds its single program with the rest.
 *  - Follows the player rig every frame (a sphere of 245 m around the head: no parallax, always inside the 260 m far plane, never frustum culled).
 *  - Exists only while `atmosphere.vista` > 0: faded by the vista (and thinned by the intro `veil`), hidden outright below 3 % so the jungle interior pays nothing.
 *  - Material: unlit, vertex RGBA, ordinary alpha blending (linear in display space), depthTest ON / depthWrite OFF (trees, ridges and the cliff occlude it),
 *    fog off and not tone mapped (it is a painted backdrop like the dome), renderOrder 0/1: BEFORE the water (2), the falls and the mist (3..5).
 *  - Drift: only the cloud mesh turns, 0.0015 rad/s (a bank crosses its own width in ~5 minutes); haze and sun stay put. Static with reduced motion.
 *  - 'low' tier: clouds are not drawn (they are the fill-rate part: 1-2 layers over ~30 % of the upper sky); haze + sun (one draw, a thin band) remain.
 */
const DRIFT = 0.0015;
const ON = 0.03;
const OFF = 0.012;

export class SkySystem extends createSystem({}) {
  private readonly group = new Group();
  private clouds!: Mesh;
  private glow!: Mesh;
  private material!: MeshBasicMaterial;
  private readonly p = new Vector3();
  private shown = false;
  private reduced = false;
  private lastFade = -1;

  init(): void {
    this.reduced = loadComfort().reducedMotion;
    this.material = new MeshBasicMaterial({
      name: 'sky-pack',
      vertexColors: true, // RGBA: the geometry's colour attribute has itemSize 4 (USE_COLOR_ALPHA)
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: false,
      toneMapped: false,
      side: DoubleSide,
    });
    // depthWrite is off, so face order is irrelevant: one pass per mesh. Without this three.js splits a transparent DoubleSide material into a
    // BackSide + FrontSide pass (2 draws per mesh, 4 for the pack).
    this.material.forceSinglePass = true;
    this.glow = new Mesh(createSkyGlow(), this.material);
    this.clouds = new Mesh(createSkyClouds(), this.material);
    this.glow.name = 'Sky glow (haze + sun)';
    this.clouds.name = 'Sky clouds';
    this.glow.renderOrder = 0;
    this.clouds.renderOrder = 1;
    for (const m of [this.glow, this.clouds]) {
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = false;
      this.group.add(m);
    }
    this.group.name = 'Sky pack';
    // Hidden until the vista brings it in. The MESHES are hidden, not the group: warmShaders() makes hidden meshes visible for its compile (three's
    // compile() skips invisible parents), so the one program is built at start and not mid-game on the first walk up the knoll.
    this.glow.visible = false;
    this.clouds.visible = false;
    this.world.scene.add(this.group);
    this.cleanupFuncs.push(() => {
      this.world.scene.remove(this.group);
      this.glow.geometry.dispose();
      this.clouds.geometry.dispose();
      this.material.dispose();
    });
  }

  update(delta: number): void {
    // fade: the vista brings it in (smooth from 3 % to 55 %), the intro veil thins it while the air is still thick, the mountain never shows it
    const veil = Math.min(1, Math.max(0, atmosphere.veil));
    const fade = smoothstep(ON, 0.55, atmosphere.vista) * (1 - 0.85 * veil) * (1 - atmosphere.open);
    const want = this.shown ? atmosphere.vista > OFF && fade > 0.004 : atmosphere.vista > ON && fade > 0.01;
    if (want !== this.shown) {
      this.shown = want;
      this.glow.visible = want;
      this.clouds.visible = want && qualityState.tier !== 'low';
    }
    if (!want) return;
    if (Math.abs(fade - this.lastFade) > 0.002) {
      this.lastFade = fade;
      this.material.opacity = fade;
    }
    const low = qualityState.tier === 'low';
    if (this.clouds.visible === low) this.clouds.visible = !low; // (the low tier draws haze + sun only)
    // centre on the rig (+ eye height): the world position of the player rig, no allocation
    this.player.getWorldPosition(this.p);
    this.group.position.set(this.p.x, this.p.y + 1.6, this.p.z);
    if (!this.reduced && !low) this.clouds.rotation.y += DRIFT * delta;
  }
}

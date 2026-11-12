import { createSystem, DoubleSide, Group, Mesh, MeshBasicMaterial, Vector3 } from '@iwsdk/core';
import { atmosphere } from './atmosphere-system.js';
import { qualityState } from '../settings/quality.js';
import { loadComfort } from '../settings/comfort.js';
import { smoothstep } from '../world/layout.js';
import { SKY_RADIUS, createSkyClouds, createSkyGlow } from '../scene-assets/sky.scene-asset.js';
import { cloudTexture } from '../scene-assets/lib/photo-textures.js';

/**
 * The sky pack (geometry: scene-assets/sky.scene-asset.ts): photographic cloud cards, a pale sunward haze and a sun disc. Two meshes, two runtime
 * materials (outside the asset manifest, which stays at 16/16; asset-stats counts them as a reserve): `sky-pack` (vertex RGBA only: haze + sun) and
 * `sky-clouds` (the same, plus the cloud atlas cut from the user's cloud template).
 *
 *  - Built once in init() and added to the scene, hidden: warmShaders() (which shows hidden meshes for the compile) builds its two programs with the rest.
 *  - Follows the player rig every frame (a sphere around the head, just inside the far plane: no parallax, never frustum culled).
 *  - Exists while `atmosphere.vista` > 0 (the knoll: faded by the vista, thinned by the intro `veil`) or `atmosphere.open` > 0.3 (the mountain: the summit
 *    panorama); hidden outright in the jungle interior, which pays nothing. On the mountain the sphere grows with the far plane (scale = far x 0.96 / 245).
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
  private cloudMaterial!: MeshBasicMaterial;
  private readonly p = new Vector3();
  private shown = false;
  private reduced = false;
  private lastFade = -1;
  private lastScale = 1;

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
    // the clouds: the same flags plus the cloud atlas (straight alpha; texture alpha x vertex alpha x opacity)
    this.cloudMaterial = this.material.clone();
    this.cloudMaterial.name = 'sky-clouds';
    this.cloudMaterial.map = cloudTexture();
    this.cloudMaterial.forceSinglePass = true;
    this.glow = new Mesh(createSkyGlow(), this.material);
    this.clouds = new Mesh(createSkyClouds(), this.cloudMaterial);
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
      this.cloudMaterial.dispose();
    });
  }

  update(delta: number): void {
    // fade: on the knoll the vista brings it in (smooth from 3 % to 55 %) and the intro veil thins it while the air is still thick; on the mountain the
    // opening view brings it in (the summit panorama has the full sky: cloud banks, the low sun and its haze)
    const veil = Math.min(1, Math.max(0, atmosphere.veil));
    const knoll = atmosphere.vista > OFF ? smoothstep(ON, 0.55, atmosphere.vista) * (1 - 0.85 * veil) * (1 - atmosphere.open) : 0;
    // the sky pack is drawn everywhere (blue sky + clouds through every canopy gap); the intro veil still thins it
    // (and it is gone inside Everest's cloud deck: the world is white there)
    const fade = Math.max(knoll, smoothstep(0.3, 0.85, atmosphere.open), 1 - 0.6 * veil) * (1 - atmosphere.white);
    const want = this.shown ? fade > 0.004 : fade > 0.01;
    if (want !== this.shown) {
      this.shown = want;
      this.glow.visible = want;
      this.clouds.visible = want && qualityState.tier !== 'low';
    }
    if (!want) return;
    if (Math.abs(fade - this.lastFade) > 0.002) {
      this.lastFade = fade;
      this.material.opacity = fade;
      this.cloudMaterial.opacity = fade;
    }
    const low = qualityState.tier === 'low';
    if (this.clouds.visible === low) this.clouds.visible = !low; // (the low tier draws haze + sun only)
    // centre on the rig (+ eye height): the world position of the player rig, no allocation
    this.player.getWorldPosition(this.p);
    this.group.position.set(this.p.x, this.p.y + 1.6, this.p.z);
    // the sphere stays just inside the far plane (670 m in the jungle, ~960 m on the east mountain, 1.4 km above Everest's clouds), so Everest and the far ranges stand in front of it
    const scale = Math.max(1, (atmosphere.far * 0.96) / SKY_RADIUS);
    if (Math.abs(scale - this.lastScale) > 0.01) {
      this.lastScale = scale;
      this.group.scale.setScalar(scale);
    }
    if (!this.reduced && !low) this.clouds.rotation.y += DRIFT * delta;
  }
}

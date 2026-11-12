import { createSystem, DoubleSide, Group, Mesh, MeshBasicMaterial, Vector3 } from '@iwsdk/core';
import { atmosphere } from './atmosphere-system.js';
import { createEverestCollar, createEverestSea } from '../scene-assets/everest-sky.scene-asset.js';
import { EVEREST } from '../world/everest.js';

/**
 * Everest's cloud deck (geometry: scene-assets/everest-sky.scene-asset.ts). Two meshes, two unlit runtime materials outside the asset manifest:
 *
 *  - `Everest cloud collar`: the ring of cloud round the mountain as seen from below the deck (the jungle, the knoll, the lower trail). Alpha blended,
 *    not fogged (it is the weather itself), depth tested (the rock and the trees cut it), drawn after the sky clouds. Fades out as the player enters
 *    the deck (`atmosphere.white`) and is not drawn above it.
 *  - `Everest cloud sea`: the sea of clouds and the Himalaya as seen from above the deck. Opaque, fogged like everything else (the far rim melts into
 *    the haze). Not drawn below the deck.
 *
 * The hand-off happens inside the whiteout (AtmosphereSystem: 40 m visibility within 3 m of the deck), where neither can be told from the air.
 * Built once in init(), hidden: warmShaders() compiles both programs at start.
 */
export class EverestSystem extends createSystem({}) {
  private readonly group = new Group();
  private collar!: Mesh;
  private sea!: Mesh;
  private collarMaterial!: MeshBasicMaterial;
  private seaMaterial!: MeshBasicMaterial;
  private readonly p = new Vector3();
  private lastOpacity = -1;

  init(): void {
    this.collarMaterial = new MeshBasicMaterial({
      name: 'everest-collar',
      vertexColors: true, // RGBA
      transparent: true,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      side: DoubleSide,
    });
    this.collarMaterial.forceSinglePass = true; // (no depth write: one pass, not back + front)
    this.seaMaterial = new MeshBasicMaterial({ name: 'everest-sea', vertexColors: true, side: DoubleSide });
    this.collar = new Mesh(createEverestCollar(), this.collarMaterial);
    this.sea = new Mesh(createEverestSea(), this.seaMaterial);
    this.collar.name = 'Everest cloud collar';
    this.sea.name = 'Everest cloud sea';
    this.collar.renderOrder = 2;
    for (const m of [this.collar, this.sea]) {
      m.castShadow = false;
      m.receiveShadow = false;
      m.visible = false; // (the meshes, not the group: warmShaders() shows hidden meshes for its compile)
      this.group.add(m);
    }
    this.sea.frustumCulled = false; // it surrounds the player
    this.group.name = 'Everest clouds';
    this.world.scene.add(this.group);
    this.cleanupFuncs.push(() => {
      this.world.scene.remove(this.group);
      this.collar.geometry.dispose();
      this.sea.geometry.dispose();
      this.collarMaterial.dispose();
      this.seaMaterial.dispose();
    });
  }

  update(): void {
    this.player.getWorldPosition(this.p);
    const eye = this.p.y + 1.6;
    const above = eye > EVEREST.deck - 2;
    const below = eye < EVEREST.deck + 2 && atmosphere.white < 0.98;
    if (this.sea.visible !== above) this.sea.visible = above;
    if (this.collar.visible !== below) this.collar.visible = below;
    if (below) {
      const o = 1 - atmosphere.white;
      if (Math.abs(o - this.lastOpacity) > 0.004) {
        this.lastOpacity = o;
        this.collarMaterial.opacity = o;
      }
    }
  }
}

import { Color, createSystem, DomeGradient, FogExp2, HemisphereLightComponent, Vector3 } from '@iwsdk/core';
import { MZ } from '../world/mountain.js';
import { JUNGLE_FAR, smoothstep, vistaAt } from '../world/layout.js';
import { loadComfort } from '../settings/comfort.js';

/**
 * Atmosphere. Three independent channels, all eased, all written to the scene at 4 Hz and only when something really changed:
 *
 *  open   (0..1)  HEIGHT based, only on the mountain (x > MZ.x0 - 4): the jungle's short wet view opens to hundreds of metres, the fog thins to 0.0036 and the
 *                 camera far plane grows from JUNGLE_FAR (260 m) to 1 km. It never changes on the Overlook Knoll (x <= 18, so `open` is 0 there).
 *  vista  (0..1)  POSITION based (never height): 1 on the knoll crown, 0 from 32 m down the ramp (`vistaAt`, layout.ts). The sunlit lookout gets lighter, warmer
 *                 fog (density x 0.65: the backdrop fall at 122 m goes from 74 % to ~42 % fogged), a bluer sky, an open-sky hemisphere fill, and
 *                 ChunkLodSystem reaches farther (a vista-scaled cell cap and landmark caps). It is multiplied by (1 - open): the mountain route never sees it.
 *                 It returns smoothly to the humid jungle as the player walks down (the arrival beat).
 *  veil   (0..1)  a multiplier hook written by the intro system (the opening reveal): density x (1 + veil x 0.55). Default 0 = no effect.
 *
 * `vista` eases (rate 1/s) so a teleport or a respawn does not jump the fog; it SNAPS instead when reduced motion is on, with ?reveal=0 or any ?test= run
 * (measurements must not drift), and on any move of more than 3 m between two frames (placePlayer, ?area=, tests, safety respawns).
 * The far plane stays 260 m on the knoll: the farthest visible thing is a ridge ~200 m away and the fog hides the rest.
 */
/** Depth range: near 0.1 m (iwsdk.config.json), far JUNGLE_FAR in the jungle up to 1 km on the mountain. */
export const atmosphere = { open: 0, far: JUNGLE_FAR, density: 0.0095, vista: 0, veil: 0 };

const FOG_JUNGLE = 0.0095;
const FOG_SUMMIT = 0.0036;
/** Fog density at vista = 1 relative to the jungle's (0.0095 -> ~0.0062). Below ~0.0060 the 100 m cell cap would show sideways: see jungleCellCap. */
const FOG_VISTA_K = 0.65;
/** Fog density multiplier of the reveal veil at veil = 1. */
const VEIL_FOG = 0.55;

const FOG_COLOR_JUNGLE = new Color('#a9c4b3');
const FOG_COLOR_OPEN = new Color('#b4cbd0'); // a touch bluer and brighter: valley haze
const FOG_COLOR_VISTA = new Color('#c9cfc0'); // warm pale haze of the sunlit lookout
const SKY_JUNGLE = [0.3, 0.55, 0.58];
const SKY_OPEN = [0.3, 0.58, 0.86];
const SKY_VISTA = [0.27, 0.57, 0.82];
const SKY_VISTA_MIX = 0.7;
/** Canopy-fill hemisphere light at vista = 1: open-sky blue from above, warm meadow bounce from below, slightly less intensity (the sun does the work). */
const HEMI_SKY_VISTA = [0.52, 0.68, 0.92];
const HEMI_GROUND_VISTA = [0.34, 0.3, 0.14];
const HEMI_INTENSITY_VISTA = 0.88;

export class AtmosphereSystem extends createSystem({
  dome: { required: [DomeGradient] },
  hemi: { required: [HemisphereLightComponent] },
}) {
  private readonly p = new Vector3();
  private fogBase = FOG_JUNGLE;
  /** The scene's authored fog density is read ONCE, before this system has ever written the fog (later reads would see our own vista/veil value). */
  private fogCaptured = false;
  /** Authored hemisphere values per light entity (sky rgb, ground rgb, intensity), captured on first sight for the same reason. */
  private readonly hemiBase = new Map<unknown, number[]>();

  private acc = 0;
  private lastOpen = -1;
  private lastVista = -1;
  private lastVeil = -1;
  private lastX = Number.NaN;
  private lastZ = Number.NaN;
  private snap = false;

  init(): void {
    const q = new URLSearchParams(globalThis.location?.search ?? '');
    this.snap = loadComfort().reducedMotion || q.get('reveal') === '0' || q.has('test');
  }

  update(delta: number): void {
    // `open` and `vista` ease every frame (a few flops) but the scene is only touched at 4 Hz and only when something really changed:
    // writing the dome gradient fires ECS change handlers, and a camera far-plane change updates the XR render state.
    this.player.getWorldPosition(this.p);
    const target = this.p.x > MZ.x0 - 4 ? smoothstep(3, 12, this.p.y) : 0;
    atmosphere.open += (target - atmosphere.open) * (1 - Math.exp(-delta * 1.2));
    const vTarget = vistaAt(this.p.x, this.p.z);
    const jumped = !(Math.hypot(this.p.x - this.lastX, this.p.z - this.lastZ) <= 3); // also true for the first frame (NaN)
    this.lastX = this.p.x;
    this.lastZ = this.p.z;
    if (this.snap || jumped) atmosphere.vista = vTarget;
    else atmosphere.vista += (vTarget - atmosphere.vista) * (1 - Math.exp(-delta * 1.0));
    this.acc += delta;
    if (this.acc < 0.25) return;
    this.acc = 0;
    if (Math.abs(atmosphere.open - this.lastOpen) + Math.abs(atmosphere.vista - this.lastVista) + Math.abs(atmosphere.veil - this.lastVeil) < 0.004) return;
    const scene = this.world.scene;
    const fog = scene.fog as FogExp2 | null;
    if (fog && !('density' in fog)) return;
    // The level may still be loading (no fog, no dome yet): do not record the state as written, so the first tick after it exists writes it.
    if (!fog && this.queries.dome.entities.size === 0) return;
    this.lastOpen = atmosphere.open;
    this.lastVista = atmosphere.vista;
    this.lastVeil = atmosphere.veil;
    // the vista never applies on the mountain (open > 0): the mountain route keeps its own fog, colours and lights
    const vf = atmosphere.vista * (1 - atmosphere.open);
    if (fog) {
      if (!this.fogCaptured) {
        this.fogCaptured = true;
        if (fog.density > 0 && Math.abs(fog.density - FOG_JUNGLE) > 1e-3) this.fogBase = fog.density;
      }
      const base = this.fogBase + (FOG_SUMMIT - this.fogBase) * atmosphere.open;
      atmosphere.density = base * (1 - vf * (1 - FOG_VISTA_K)) * (1 + Math.max(0, atmosphere.veil) * VEIL_FOG);
      fog.density = atmosphere.density;
      fog.color.copy(FOG_COLOR_JUNGLE).lerp(FOG_COLOR_OPEN, atmosphere.open).lerp(FOG_COLOR_VISTA, vf);
    }
    const skyMix = SKY_VISTA_MIX * vf;
    for (const e of this.queries.dome.entities) {
      const sky = e.getVectorView(DomeGradient, 'sky') as Float32Array;
      const eq = e.getVectorView(DomeGradient, 'equator') as Float32Array;
      for (let i = 0; i < 3; i++) {
        const s = SKY_JUNGLE[i] + (SKY_OPEN[i] - SKY_JUNGLE[i]) * atmosphere.open;
        sky[i] = s + (SKY_VISTA[i] - s) * skyMix;
      }
      // The horizon band always matches the fog, so distant fogged ground fades into the sky without a seam.
      if (fog) {
        eq[0] = fog.color.r;
        eq[1] = fog.color.g;
        eq[2] = fog.color.b;
      }
      e.setValue(DomeGradient, 'elevationDeg', 32 + 40 * atmosphere.open + 10 * vf);
    }
    // The canopy-fill hemisphere light: authored (humid green) in the jungle, open-sky blue + warm bounce on the lookout.
    for (const e of this.queries.hemi.entities) {
      const sky = e.getVectorView(HemisphereLightComponent, 'skyColor') as Float32Array;
      const gr = e.getVectorView(HemisphereLightComponent, 'groundColor') as Float32Array;
      let b = this.hemiBase.get(e);
      if (!b) {
        b = [sky[0], sky[1], sky[2], gr[0], gr[1], gr[2], Number(e.getValue(HemisphereLightComponent, 'intensity'))];
        this.hemiBase.set(e, b);
      }
      for (let i = 0; i < 3; i++) {
        sky[i] = b[i] + (HEMI_SKY_VISTA[i] - b[i]) * vf;
        gr[i] = b[3 + i] + (HEMI_GROUND_VISTA[i] - b[3 + i]) * vf;
      }
      e.setValue(HemisphereLightComponent, 'intensity', b[6] * (1 + (HEMI_INTENSITY_VISTA - 1) * vf));
    }
    // Far plane in 25 m steps (each change touches the projection / XR depth range).
    const far = Math.round((JUNGLE_FAR + (1000 - JUNGLE_FAR) * atmosphere.open) / 25) * 25;
    if (far !== this.world.camera.far) {
      atmosphere.far = far;
      this.world.camera.far = far;
      this.world.camera.updateProjectionMatrix();
    }
  }
}

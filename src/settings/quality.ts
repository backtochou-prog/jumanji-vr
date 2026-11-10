import { WebGLRenderTarget } from '@iwsdk/core';
import type { World } from '@iwsdk/core';

/**
 * Render-quality knobs that matter on Quest 2 (fill-rate bound, 90 Hz target):
 *   - framebuffer scale: 1.0 = the headset's recommended resolution
 *   - fixed foveation: 0 (off) .. 1 (strongest). Periphery renders at lower
 *     resolution; in dense foggy foliage this is nearly invisible and buys
 *     back a lot of fill-rate. Needs a real XR session to take effect.
 * URL overrides for experiments:  ?xrscale=0.8  ?foveation=0.5  ?pixelratio=0.5
 * Dev-only override (no URL): VITE_JUMANJI_XR_SCALE in .env.local - used to
 * keep the software-rendered emulator in this repo's CI/agent sandbox alive.
 */
export interface QualitySettings {
  xrScale: number;
  foveation: number;
  /** Desktop/2D canvas pixel ratio (1 = CSS pixels). Irrelevant inside a headset session. */
  pixelRatio: number;
}

export const DEFAULT_QUALITY: Readonly<QualitySettings> = { xrScale: 1.0, foveation: 1.0, pixelRatio: 1 };

export function loadQuality(): QualitySettings {
  const q = new URLSearchParams(globalThis.location?.search ?? '');
  const envScale = Number(import.meta.env.VITE_JUMANJI_XR_SCALE);
  const scale = q.has('xrscale') ? Number(q.get('xrscale')) : Number.isFinite(envScale) && envScale > 0 ? envScale : DEFAULT_QUALITY.xrScale;
  const fov = q.has('foveation') ? Number(q.get('foveation')) : DEFAULT_QUALITY.foveation;
  const envRatio = Number(import.meta.env.VITE_JUMANJI_PIXEL_RATIO);
  const ratio = q.has('pixelratio') ? Number(q.get('pixelratio')) : Number.isFinite(envRatio) && envRatio > 0 ? envRatio : DEFAULT_QUALITY.pixelRatio;
  return {
    xrScale: Math.min(1.6, Math.max(0.2, scale)),
    foveation: Math.min(1, Math.max(0, fov)),
    pixelRatio: Math.min(2, Math.max(0.25, ratio)),
  };
}

export function applyQuality(world: World): QualitySettings {
  const quality = loadQuality();
  const xr = world.renderer.xr;
  xr.setFramebufferScaleFactor(quality.xrScale);
  xr.setFoveation(quality.foveation);
  world.renderer.setPixelRatio(quality.pixelRatio);
  return quality;
}

// ---------------------------------------------------------------------------
// Quality tiers
// ---------------------------------------------------------------------------

/**
 * 'high': everything on. 'low': no real-time shadows; hides the optional dressing
 * (light shafts, ground mist, moss/litter/flower/pad patches) to save fill-rate.
 * The terrain, trees, plants, ruins, water and relic are always rendered.
 * Selected by ?quality=low|high, the expedition board, or the adaptive governor.
 */
export type QualityTier = 'high' | 'low';
const TIER_KEY = 'jumanji-vr.quality.v1';

/** Distance-LOD scale used by ChunkLodSystem ('low' pulls the vegetation cut-offs in). */
export const lodState = { scale: 1 };

/** Node-name patterns (scene node names) dropped by the 'low' tier. */
const LOW_HIDES = /^(Light shafts|Ground mist|Fall mist)/;

export function loadTier(): QualityTier {
  const q = new URLSearchParams(globalThis.location?.search ?? '').get('quality');
  if (q === 'low' || q === 'high') return q;
  try {
    return localStorage.getItem(TIER_KEY) === 'low' ? 'low' : 'high';
  } catch {
    return 'high';
  }
}

export function saveTier(t: QualityTier): void {
  try {
    localStorage.setItem(TIER_KEY, t);
  } catch {
    /* private mode */
  }
}

let optional: { visible: boolean; set: (v: boolean) => void }[] | null = null;
/** Live state, read by the diagnostics overlay and the test results. */
export const qualityState = { tier: 'high' as QualityTier, shadows: true };

interface ShadowCam {
  left: number;
  right: number;
  top: number;
  bottom: number;
  near: number;
  far: number;
  updateProjectionMatrix(): void;
}
let shadowCam: { cam: ShadowCam; orig: Omit<ShadowCam, 'updateProjectionMatrix'> } | null = null;

/**
 * Real-time shadows on/off WITHOUT creating shader programs.
 *
 * Measured (tools/perf-probe.mjs, exact program counts): toggling renderer.shadowMap.enabled creates
 * 4 new programs and switching every mesh.castShadow off creates 10 - each one a synchronous compile
 * on the main thread, a visible hitch exactly when the governor fires because frames are already late.
 * Shrinking the sun's shadow-camera frustum to a point creates 0: nothing is inside it, so the shadow
 * pass draws nothing (at the clearing it removes 6 draws and ~12k triangles) and every material keeps
 * its program. 'On' restores the authored frustum.
 */
export function setShadows(world: World, on: boolean): void {
  if (!shadowCam) {
    let light: { shadow?: { camera: ShadowCam } } | null = null;
    const walk = (o: { isDirectionalLight?: boolean; castShadow?: boolean; shadow?: { camera: ShadowCam }; children: unknown[] }) => {
      if (o.isDirectionalLight && o.castShadow && !light) light = o;
      for (const c of o.children as (typeof o)[]) walk(c);
    };
    walk(world.scene as never);
    const cam = (light as { shadow?: { camera: ShadowCam } } | null)?.shadow?.camera;
    if (cam) shadowCam = { cam, orig: { left: cam.left, right: cam.right, top: cam.top, bottom: cam.bottom, near: cam.near, far: cam.far } };
  }
  if (shadowCam) {
    const { cam, orig } = shadowCam;
    if (on) Object.assign(cam, orig);
    else Object.assign(cam, { left: -0.001, right: 0.001, top: 0.001, bottom: -0.001, near: orig.near, far: orig.near + 0.01 });
    cam.updateProjectionMatrix();
  }
  qualityState.shadows = on;
}

/** Apply a tier now. Safe to call repeatedly; the optional-dressing list is collected once. */
export function applyTier(world: World, tier: QualityTier, shadows = tier === 'high'): void {
  if (!optional) {
    optional = [];
    const walk = (o: { name: string; visible: boolean; children: unknown[] }) => {
      if (LOW_HIDES.test(o.name)) {
        optional!.push({ visible: o.visible, set: (v: boolean) => (o.visible = v) });
        return; // children follow their parent
      }
      for (const c of o.children as (typeof o)[]) walk(c);
    };
    walk(world.scene as unknown as { name: string; visible: boolean; children: unknown[] });
  }
  for (const item of optional) item.set(tier === 'high');
  lodState.scale = tier === 'high' ? 1 : 0.72;
  setShadows(world, shadows);
  qualityState.tier = tier;
  console.info(`[jumanji] quality tier=${tier} shadows=${shadows} optional-hidden=${tier === 'low' ? optional.length : 0}`);
}

/**
 * Compile every shader program the visible scene needs before frames depend on them.
 * Called when the page is ready and again when an immersive session starts (the XR/multiview
 * variants of the programs differ from the desktop ones), so the first seconds in VR are not
 * spent compiling. Uses KHR_parallel_shader_compile when three.js finds it (compileAsync).
 */
export function warmShaders(world: World, shadowPass = false): void {
  const r = world.renderer as unknown as { compileAsync?: (s: unknown, c: unknown) => Promise<unknown>; compile?: (s: unknown, c: unknown) => void };
  const t0 = performance.now();
  // three.js compiles only VISIBLE objects, and the LOD systems hide most of the mountain while the player is in the jungle (and the
  // collapse pieces, pebbles and fall variants start hidden): show everything for the compile so no program is first built mid-walk.
  const hidden: { visible: boolean }[] = [];
  world.scene.traverse((o) => {
    if (!o.visible && ((o as { isMesh?: boolean }).isMesh || (o as { isSprite?: boolean }).isSprite || (o as { isPoints?: boolean }).isPoints)) hidden.push(o);
  });
  // IMPORTANT: visibility is only changed for the duration of the (synchronous) compile call and restored in the same tick. three.js collects the
  // materials inside compile()/compileAsync() right away; only the LINKING is asynchronous (seconds on a Quest). The earlier version restored when the
  // promise resolved, so for those seconds EVERY hidden object (all LOD versions of every tree, the whole mountain) was drawn, and at the end everything
  // was forced back to hidden, overriding the LOD system's choices: the world flashed with all of it at once, then trees "respawned". It also ran each
  // time the player entered VR (the governor calls this).
  for (const o of hidden) o.visible = true;
  const restore = () => {
    for (const o of hidden) o.visible = false;
  };
  const done = () => {
    if (shadowPass) warmShadowPrograms(world);
    console.info(`[jumanji] shader warm-up finished in ${(performance.now() - t0).toFixed(0)} ms (${world.renderer.info.programs?.length ?? '?'} programs)`);
  };
  try {
    if (r.compileAsync) {
      const p = r.compileAsync(world.scene, world.camera);
      restore(); // materials are already collected: put every object back exactly as it was, now
      void p.then(done, done);
    } else {
      r.compile?.(world.scene, world.camera);
      restore();
      done();
    }
  } catch (e) {
    restore();
    console.warn('[jumanji] shader warm-up failed', e);
  }
}

/**
 * The sun's shadow casters (ruins, altar, relic) get their own depth programs, which three.js builds the first time a caster is inside the
 * shadow frustum: mid-walk, near the clearing. Build them now instead: one tiny render with a world-sized shadow frustum into a 1x1 target.
 * Page-ready only (never inside an XR frame).
 */
function warmShadowPrograms(world: World): void {
  try {
    type ShadowCam = { left: number; right: number; top: number; bottom: number; near: number; far: number; updateProjectionMatrix(): void };
    const found: { cam: ShadowCam | null } = { cam: null };
    world.scene.traverse((o) => {
      const l = o as unknown as { isDirectionalLight?: boolean; castShadow: boolean; shadow: { camera: ShadowCam } };
      if (!found.cam && l.isDirectionalLight && l.castShadow) found.cam = l.shadow.camera;
    });
    const cam = found.cam;
    if (!cam) return;
    const saved = { l: cam.left, r: cam.right, t: cam.top, b: cam.bottom, n: cam.near, f: cam.far };
    cam.left = -140;
    cam.right = 140;
    cam.top = 140;
    cam.bottom = -140;
    cam.far = Math.max(cam.far, 400);
    cam.updateProjectionMatrix();
    const r = world.renderer;
    const rt = new WebGLRenderTarget(1, 1);
    const prev = r.getRenderTarget();
    r.setRenderTarget(rt);
    r.render(world.scene, world.camera);
    r.setRenderTarget(prev);
    rt.dispose();
    cam.left = saved.l;
    cam.right = saved.r;
    cam.top = saved.t;
    cam.bottom = saved.b;
    cam.near = saved.n;
    cam.far = saved.f;
    cam.updateProjectionMatrix();
  } catch (e) {
    console.warn('[jumanji] shadow program warm-up skipped', e);
  }
}

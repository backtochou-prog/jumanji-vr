import { AdditiveBlending, Color, Mesh, MeshBasicMaterial, NoBlending, UnsignedByteType, WebGLRenderTarget } from '@iwsdk/core';
import type { Material, Object3D, World } from '@iwsdk/core';
import { foliageCardMaterial, lightShaftMaterial, plantFoliageMaterial } from '../scene-assets/lib/materials.js';

/**
 * Overdraw meter: how many fragments the GPU is asked to shade per screen pixel, per material
 * class, from the CURRENT camera. Independent of GPU speed, so it works on the desktop and gives
 * a like-for-like number before and after a foliage change. Developer tool, called from
 * tools/perf-probe.mjs (window.__jumanjiPerf.overdraw()); nothing runs unless asked.
 *
 * Method: each class is re-rendered with an additive, unlit material that adds 8/255 per
 * fragment (so up to 31 layers are countable), keeping the original alpha-test map, then the
 * red channel is read back and averaged over ALL pixels.
 *   cards          alpha-tested foliage that survives the alpha test, ignoring occlusion
 *                  (alpha-tested shaders usually cannot use early-z to skip work, so this is the
 *                  conservative figure)
 *   cardsUnoccluded same, but tested against the depth of the opaque world first (what an early
 *                  depth test can reject before shading)
 *   additive       light shafts + ground mist + water (blended layers: bandwidth heavy on tilers)
 *   opaque         terrain, rocks, ruins, bark (depth-tested, front-to-back as three.js sorts)
 */
export interface OverdrawReport {
  width: number;
  height: number;
  cardsLayersPerPixel: number;
  /** Fragments RASTERISED for cards (before the alpha discard): what the GPU shades. */
  cardsRasterLayersPerPixel: number;
  /** Share of rasterised card fragments the alpha test throws away. */
  cardsDiscardedPct: number;
  cardsCoveragePct: number;
  cardsVisibleLayersPerPixel: number;
  /** Water and other blended meshes. */
  additiveLayersPerPixel: number;
  /** Light shafts + ground mist (additive cards). */
  shaftLayersPerPixel: number;
  opaqueLayersPerPixel: number;
  cardMeshesRendered: number;
  /** Card layers per pixel (no occlusion) attributed to each vegetation class / other card meshes. */
  cardsByClass: Record<string, number>;
  note: string;
}

const STEP = 8;

function classify(m: Material): 'card' | 'additive' | 'shaft' | 'opaque' {
  if (m === foliageCardMaterial || m === plantFoliageMaterial) return 'card';
  if (m === lightShaftMaterial) return 'shaft';
  if ((m as { transparent?: boolean }).transparent) return 'additive';
  return 'opaque';
}

export function measureOverdraw(world: World, height = 300): OverdrawReport {
  const renderer = world.renderer;
  const cam = world.camera as unknown as { aspect: number };
  const width = Math.round(height * (cam.aspect || 1.6));
  const rt = new WebGLRenderTarget(width, height, { type: UnsignedByteType, depthBuffer: true });
  const gl = renderer.getContext();
  const buf = new Uint8Array(width * height * 4);

  const overrides = new Map<Material, MeshBasicMaterial>();
  const rasterKey = new Map<Material, Material>();
  const counter = (src: Material, opts: { depthTest: boolean; depthWrite: boolean; additive: boolean; ignoreAlpha?: boolean }): MeshBasicMaterial => {
    const key = opts.ignoreAlpha ? (rasterKey.get(src) ?? rasterKey.set(src, { raster: true } as unknown as Material).get(src)!) : src;
    let m = overrides.get(key);
    if (m) return m;
    const s = src as Material & { map?: unknown; alphaTest?: number; side?: number };
    m = new MeshBasicMaterial({
      color: new Color(STEP / 255, 0, 0),
      map: (s.map as never) ?? null,
      alphaTest: opts.ignoreAlpha ? 0 : (s.alphaTest ?? 0),
      side: s.side,
      blending: opts.additive ? AdditiveBlending : NoBlending,
      depthTest: opts.depthTest,
      depthWrite: opts.depthWrite,
      fog: false,
      toneMapped: false,
      transparent: opts.additive,
    });
    // Foliage maps only contribute their alpha; keep RGB out of the count by forcing the colour in the shader.
    m.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', `gl_FragColor = vec4( ${(STEP / 255).toFixed(5)}, 0.0, 0.0, 1.0 );`);
    };
    overrides.set(key, m);
    return m;
  };

  const meshes: { mesh: Mesh; mat: Material; cls: 'card' | 'additive' | 'shaft' | 'opaque'; vis: boolean }[] = [];
  world.scene.traverse((o: Object3D) => {
    const m = o as Mesh;
    // The wildlife (instanced, a few hundred pixels) is left out: overriding its materials would only make the meter compile throw-away shader variants.
    if (!m.isMesh || m.name === 'PerfOverlay' || m.name.startsWith('Wildlife')) return;
    const mat = Array.isArray(m.material) ? m.material[0] : m.material;
    // Only what is actually drawn this frame (respects LOD visibility).
    let vis = true;
    for (let p: Object3D | null = m; p; p = p.parent) if (!p.visible) vis = false;
    meshes.push({ mesh: m, mat, cls: classify(mat), vis });
  });

  // hide the wildlife group while measuring: rendered into the meter's render target it would only create throw-away shader variants
  const wildlife = world.scene.getObjectByName('Wildlife');
  const wildlifeWas = wildlife?.visible ?? false;
  if (wildlife) wildlife.visible = false;
  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevAuto = renderer.autoClear;
  const prevShadow = renderer.shadowMap.enabled;
  renderer.shadowMap.enabled = false;
  renderer.setClearColor(0x000000, 1);

  const read = (): { mean: number; covered: number } => {
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let sum = 0;
    let covered = 0;
    for (let i = 0; i < buf.length; i += 4) {
      sum += buf[i];
      if (buf[i] > 0) covered++;
    }
    const n = width * height;
    return { mean: sum / STEP / n, covered: (covered / n) * 100 };
  };

  const pass = (cls: 'card' | 'additive' | 'shaft' | 'opaque' | 'opaqueDepth', depthTestCards: boolean, clearFirst: boolean): number => {
    renderer.autoClear = false;
    renderer.setRenderTarget(rt);
    if (clearFirst) renderer.clear(true, true, true);
    let rendered = 0;
    const saved: [Mesh, Material | Material[]][] = [];
    for (const e of meshes) {
      const show = e.vis && (cls === 'opaqueDepth' ? e.cls === 'opaque' : e.cls === cls);
      saved.push([e.mesh, e.mesh.material]);
      const was = e.mesh.visible;
      (e as unknown as { was: boolean }).was = was;
      if (!show) {
        e.mesh.visible = false;
        continue;
      }
      rendered++;
      e.mesh.material = counter(e.mat, { depthTest: cls === 'card' ? depthTestCards : true, depthWrite: cls === 'opaque' || cls === 'opaqueDepth', additive: true });
    }
    renderer.render(world.scene, world.camera);
    for (let i = 0; i < meshes.length; i++) {
      meshes[i].mesh.material = saved[i][1];
      meshes[i].mesh.visible = (meshes[i] as unknown as { was: boolean }).was;
    }
    return rendered;
  };

  // cards, no occlusion
  const cardCount = pass('card', false, true);
  const cards = read();
  // rasterised (pre-discard) card fragments
  {
    renderer.autoClear = false;
    renderer.setRenderTarget(rt);
    renderer.clear(true, true, true);
    const saved: [Mesh, Material | Material[], boolean][] = meshes.map((e) => [e.mesh, e.mesh.material, e.mesh.visible]);
    for (const e of meshes) {
      if (e.vis && e.cls === 'card') e.mesh.material = counter(e.mat, { depthTest: false, depthWrite: false, additive: true, ignoreAlpha: true });
      else e.mesh.visible = false;
    }
    renderer.render(world.scene, world.camera);
    for (const [m, mat, vis] of saved) {
      m.material = mat;
      m.visible = vis;
    }
  }
  const raster = read();
  // per class: render each class's cards alone
  const cardsByClass: Record<string, number> = {};
  {
    const classes = new Map<string, typeof meshes>();
    for (const e of meshes) {
      if (!(e.vis && e.cls === 'card')) continue;
      let k = 'other (landmarks, temple growth, ...)';
      for (let p: Object3D | null = e.mesh; p; p = p.parent) {
        const m = /^veg (\S+) \d+ \d+$/.exec(p.name) ?? /^Chunk_(.+)_\d+_\d+$/.exec(p.name);
        if (m) {
          k = m[1];
          break;
        }
      }
      if (!classes.has(k)) classes.set(k, []);
      classes.get(k)!.push(e);
    }
    for (const [k, list] of classes) {
      const only = new Set(list.map((e) => e.mesh));
      renderer.autoClear = false;
      renderer.setRenderTarget(rt);
      renderer.clear(true, true, true);
      const saved: [Mesh, Material | Material[], boolean][] = meshes.map((e) => [e.mesh, e.mesh.material, e.mesh.visible]);
      for (const e of meshes) {
        if (only.has(e.mesh)) e.mesh.material = counter(e.mat, { depthTest: false, depthWrite: false, additive: true });
        else e.mesh.visible = false;
      }
      renderer.render(world.scene, world.camera);
      for (const [m, mat, vis] of saved) {
        m.material = mat;
        m.visible = vis;
      }
      cardsByClass[k] = round(read().mean);
    }
  }
  // opaque world (depth only matters), then cards depth-tested against it without writing depth
  const opaqueDepthPass = () => {
    pass('opaqueDepth', true, true);
  };
  opaqueDepthPass();
  const opaque = read();
  // second pass for cards against the opaque depth: re-render cards additive on top without clearing
  {
    renderer.autoClear = false;
    renderer.setRenderTarget(rt);
    // clear colour only, keep depth from the opaque pass
    renderer.clear(true, false, false);
    const saved: [Mesh, Material | Material[]][] = [];
    for (const e of meshes) {
      saved.push([e.mesh, e.mesh.material]);
      (e as unknown as { was: boolean }).was = e.mesh.visible;
      if (!(e.vis && e.cls === 'card')) {
        e.mesh.visible = false;
        continue;
      }
      e.mesh.material = counter(e.mat, { depthTest: true, depthWrite: false, additive: true });
    }
    renderer.render(world.scene, world.camera);
    for (let i = 0; i < meshes.length; i++) {
      meshes[i].mesh.material = saved[i][1];
      meshes[i].mesh.visible = (meshes[i] as unknown as { was: boolean }).was;
    }
  }
  const cardsVisible = read();
  pass('additive', false, true);
  const additive = read();
  pass('shaft', false, true);
  const shaft = read();

  if (wildlife) wildlife.visible = wildlifeWas;
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);
  renderer.autoClear = prevAuto;
  renderer.shadowMap.enabled = prevShadow;
  rt.dispose();
  for (const m of overrides.values()) m.dispose();

  return {
    width,
    height,
    cardsLayersPerPixel: round(cards.mean),
    cardsRasterLayersPerPixel: round(raster.mean),
    cardsDiscardedPct: raster.mean > 0 ? round((1 - cards.mean / raster.mean) * 100, 0) : 0,
    cardsCoveragePct: round(cards.covered, 1),
    cardsVisibleLayersPerPixel: round(cardsVisible.mean),
    additiveLayersPerPixel: round(additive.mean),
    shaftLayersPerPixel: round(shaft.mean),
    opaqueLayersPerPixel: round(opaque.mean),
    cardMeshesRendered: cardCount,
    cardsByClass,
    note: 'fragments per screen pixel by class; cards = alpha-tested foliage (no occlusion) vs cardsVisible = after opaque depth test',
  };
}

const round = (v: number, d = 2): number => Math.round(v * 10 ** d) / 10 ** d;

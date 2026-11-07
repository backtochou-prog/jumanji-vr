/**
 * Shared materials for the jungle assets (Quest 2 budget: a dozen materials).
 *
 * All are MeshStandardMaterial with roughness taken from the shared ROUGH table
 * (world/palette.ts), colour from baked vertex colours (including baked ambient
 * occlusion), and at most one small texture each:
 *   foliageCard   the 512 px leaf atlas (alpha-TEST cutout; also carries wood via a solid tile)
 *   ground        256 px grain, sampled at two scales to hide tiling (terrain + trail share it)
 *   bark/rock/ruin  256 px grain + a small procedural bump for surface relief
 *   water         ripple bump (scrolled), vertex alpha by depth, fake sky fresnel
 * No post-processing, no extra render passes, no transmission.
 */
import {
  AdditiveBlending,
  Color,
  createSceneMaterial,
  DoubleSide,
  MeshBasicMaterial,
  MeshStandardMaterial,
} from '@iwsdk/core';
import type { Material } from '@iwsdk/core';
import { PAL, ROUGH } from '../../world/palette.js';
import { leafAtlas } from './leaf-atlas.js';

type Hex = `#${string}`;

function vertexColored(m: Material): MeshStandardMaterial {
  const std = m as MeshStandardMaterial;
  std.vertexColors = true;
  return std;
}

/** Grain texture multiplies vertex colour: keep ramps near-white, low contrast. */
const grain = (seed: number, lo: Hex, hi: Hex, freq = 40) => ({
  type: 'procedural' as const,
  algorithm: 'periodic-fbm-v1' as const,
  resolution: [256, 256] as [number, number],
  seed,
  bands: [
    { frequency: [freq, freq] as [number, number], amplitude: 0.65 },
    { frequency: [freq * 3.1, freq * 3.1] as [number, number], amplitude: 0.35 },
  ],
  ramp: [
    { at: 0, color: lo },
    { at: 1, color: hi },
  ],
  sampler: { wrapU: 'repeat' as const, wrapV: 'repeat' as const },
});

/** Small procedural bump (surface relief without a normal-map pipeline). */
const bump = (seed: number, freq: [number, number], scale: number) => ({
  type: 'procedural' as const,
  algorithm: 'periodic-fbm-v1' as const,
  resolution: [256, 256] as [number, number],
  seed,
  bands: [
    { frequency: freq, amplitude: 0.7 },
    { frequency: [freq[0] * 2.7, freq[1] * 2.7] as [number, number], amplitude: 0.3 },
  ],
  scale,
  sampler: { wrapU: 'repeat' as const, wrapV: 'repeat' as const },
});

// ---------------------------------------------------------------------------
// Ground: one material for terrain and trail, anti-tiling albedo
// ---------------------------------------------------------------------------

export const groundMaterial = vertexColored(
  createSceneMaterial({
    id: 'jungle-ground',
    model: 'standard',
    baseColor: '#ffffff',
    roughness: ROUGH.ground,
    textures: { albedo: grain(11, '#55523f', '#f2efe2', 80), bump: bump(31, [90, 90], 0.75) },
  }),
);
groundMaterial.onBeforeCompile = (shader) => {
  // Two samples at different scales/rotations, mixed by a slow mask: no visible tiling at standing height.
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <map_fragment>',
    `#ifdef USE_MAP
      vec2 gUv = vMapUv;
      vec4 gA = texture2D( map, gUv );
      vec4 gB = texture2D( map, mat2( 0.8, -0.6, 0.6, 0.8 ) * gUv * 0.37 + vec2( 0.21, 0.63 ) );
      float gM = smoothstep( 0.25, 0.75, 0.5 + 0.5 * sin( gUv.x * 0.71 + sin( gUv.y * 0.93 ) * 1.7 ) );
      diffuseColor *= mix( gA, gB, gM * 0.6 );
    #endif`,
  );
};
groundMaterial.customProgramCacheKey = () => 'jungle-ground-v2';

// ---------------------------------------------------------------------------
// Foliage cards (+ wood parts of plants/trees that must share the draw call)
// ---------------------------------------------------------------------------

export const foliageCardMaterial = new MeshStandardMaterial({
  name: 'jungle-foliage-card',
  map: leafAtlas(),
  vertexColors: true,
  roughness: ROUGH.foliage,
  metalness: 0,
  side: DoubleSide,
  alphaTest: 0.45,
});
foliageCardMaterial.onBeforeCompile = (shader) => {
  // Cards carry authored soft normals (rounded-mass lighting): use them on BOTH faces instead of flipping.
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <normal_fragment_begin>',
    '#include <normal_fragment_begin>\n  normal = normalize( vNormal );',
  );
};
foliageCardMaterial.customProgramCacheKey = () => 'jungle-card-v1';

// ---------------------------------------------------------------------------
// Stone, wood, ruins
// ---------------------------------------------------------------------------

export const rockMaterial = vertexColored(
  createSceneMaterial({
    id: 'jungle-rock',
    model: 'standard',
    baseColor: '#ffffff',
    roughness: ROUGH.stone,
    textures: { albedo: grain(15, '#aaa89f', '#ffffff', 20), bump: bump(25, [26, 26], 0.9) },
  }),
);

export const barkMaterial = vertexColored(
  createSceneMaterial({
    id: 'jungle-bark',
    model: 'standard',
    baseColor: '#ffffff',
    roughness: ROUGH.bark,
    textures: { albedo: grain(13, '#9d9689', '#ffffff', 16), bump: bump(23, [60, 8], 1.1) },
  }),
);

export const ruinStoneMaterial = vertexColored(
  createSceneMaterial({
    id: 'jungle-ruin-stone',
    model: 'standard',
    baseColor: '#ffffff',
    roughness: ROUGH.ruin,
    textures: { albedo: grain(16, '#a7a499', '#ffffff', 28), bump: bump(26, [34, 34], 0.8) },
  }),
);

/** Carved relic: darker, slightly polished by centuries of hands. */
export const relicStoneMaterial = vertexColored(
  createSceneMaterial({
    id: 'relic-stone',
    model: 'standard',
    baseColor: '#ffffff',
    roughness: ROUGH.relic,
    textures: { albedo: grain(17, '#b8b2a4', '#ffffff', 30) },
  }),
);

/** Amber heart + teal glyph grooves. Emissive, so they read in shadow. */
export const relicGemMaterial = createSceneMaterial({
  id: 'relic-gem',
  model: 'standard',
  baseColor: PAL.accent as Hex,
  emissive: '#ff8a1f',
  emissiveIntensity: 1.6,
  roughness: 0.25,
}) as MeshStandardMaterial;

export const relicGlyphMaterial = createSceneMaterial({
  id: 'relic-glyph',
  model: 'standard',
  baseColor: '#2fe0c0',
  emissive: '#19c9a8',
  emissiveIntensity: 1.1,
  roughness: 0.5,
});

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------

/**
 * Pool / stream water: vertex colour RGBA (alpha = depth-based clarity, clear
 * shallows), a scrolling ripple bump that makes the sun glint move, and a
 * cheap fake reflection: a fresnel mix of the sky colour. No reflection pass.
 */
export const waterMaterial = createSceneMaterial({
  id: 'jungle-water',
  model: 'standard',
  baseColor: '#ffffff',
  roughness: ROUGH.water,
  metalness: 0,
  opacity: 0.96,
  textures: { bump: bump(18, [14, 14], 0.35) },
}) as MeshStandardMaterial;
waterMaterial.vertexColors = true;
waterMaterial.color.setRGB(0.62, 0.7, 0.66); // tint: keeps sun/sky from washing the water to mint
waterMaterial.transparent = true;
waterMaterial.depthWrite = false;
waterMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uSky = { value: new Color(PAL.waterShallow).lerp(new Color('#cfe6e0'), 0.55) };
  shader.fragmentShader = 'uniform vec3 uSky;\n' + shader.fragmentShader.replace(
    '#include <opaque_fragment>',
    `float fres = pow( 1.0 - saturate( dot( normalize( vViewPosition ), normal ) ), 3.0 );
    outgoingLight = mix( outgoingLight, uSky, fres * 0.28 );
    diffuseColor.a = mix( diffuseColor.a, 1.0, fres * 0.45 );
    #include <opaque_fragment>`,
  );
};
waterMaterial.customProgramCacheKey = () => 'jungle-water-v2';

/** Falling water: pale, streaky, translucent; scrolled downward by WaterSystem. */
export const waterfallMaterial = createSceneMaterial({
  id: 'jungle-waterfall',
  model: 'standard',
  baseColor: '#ffffff',
  emissive: '#bfe6dc',
  emissiveIntensity: 0.35,
  opacity: 0.82,
  roughness: 0.35,
  side: 'double',
  textures: {
    albedo: {
      type: 'procedural',
      algorithm: 'periodic-fbm-v1',
      resolution: [128, 256],
      seed: 19,
      bands: [
        { frequency: [70, 5], amplitude: 0.6 },
        { frequency: [150, 9], amplitude: 0.4 },
      ],
      ramp: [
        { at: 0, color: '#8fb9b0' },
        { at: 1, color: '#ffffff' },
      ],
      sampler: { wrapU: 'repeat', wrapV: 'repeat' },
    },
  },
});

/** Additive light-shaft / mist cards (vertex-colour brightness only, no alpha texture). */
export const lightShaftMaterial = new MeshBasicMaterial({
  name: 'light-shaft',
  vertexColors: true,
  transparent: true,
  blending: AdditiveBlending,
  depthWrite: false,
  side: DoubleSide,
  fog: true,
});

/** Unlit, fogged silhouette material for the background ridges. */
export const silhouetteMaterial = new MeshBasicMaterial({
  name: 'ridge-silhouette',
  vertexColors: true,
  side: DoubleSide,
  fog: true,
});

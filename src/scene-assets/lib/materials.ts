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
  Vector3,
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

/**
 * Mountain ground: the same grain, but projected from above on flat ground and from the side on steep faces
 * (blend by surface steepness), so cliffs read as rock instead of a top-down texture smeared down the wall.
 * Side projections are only sampled where the ground is steep (a dynamic branch), so flat ground costs the same
 * as `groundMaterial`. No bump map (it would smear the same way); relief comes from the geometry and vertex colour.
 */
export const mountainGroundMaterial = vertexColored(
  createSceneMaterial({
    id: 'mountain-ground',
    model: 'standard',
    baseColor: '#ffffff',
    roughness: ROUGH.ground,
    textures: { albedo: grain(11, '#55523f', '#f2efe2', 80) },
  }),
);
mountainGroundMaterial.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNor;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\nvWNor = normalize( mat3( modelMatrix ) * objectNormal );');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNor;')
    .replace(
      '#include <map_fragment>',
      `#ifdef USE_MAP
      vec3 wn = abs( normalize( vWNor ) );
      float steep = smoothstep( 0.5, 0.82, 1.0 - wn.y );
      vec2 gUv = vWPos.xz / 2.5;
      vec4 gA = texture2D( map, gUv );
      vec4 gB = texture2D( map, mat2( 0.8, -0.6, 0.6, 0.8 ) * gUv * 0.37 + vec2( 0.21, 0.63 ) );
      float gM = smoothstep( 0.25, 0.75, 0.5 + 0.5 * sin( gUv.x * 0.71 + sin( gUv.y * 0.93 ) * 1.7 ) );
      vec4 gTop = mix( gA, gB, gM * 0.6 );
      if ( steep > 0.01 ) {
        vec4 sx = texture2D( map, vec2( vWPos.z, vWPos.y ) / 2.5 );
        vec4 sz = texture2D( map, vec2( vWPos.x, vWPos.y ) / 2.5 + vec2( 0.37, 0.11 ) );
        float wx = wn.x * wn.x;
        float wz = wn.z * wn.z;
        gTop = mix( gTop, ( sx * wx + sz * wz ) / max( wx + wz, 1e-4 ), steep );
      }
      diffuseColor *= gTop;
    #endif`,
    );
};
mountainGroundMaterial.customProgramCacheKey = () => 'mountain-ground-v1';

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


/**
 * Live wind / proximity state for the plant material. Written each frame by ReactiveFoliageSystem; the shader reads it.
 * `body` = 3 world points (feet and both hands) that push low plants aside.
 */
export const swayState = {
  time: { value: 0 },
  wind: { value: 1 },
  body: { value: [new Vector3(0, -999, 0), new Vector3(0, -999, 0), new Vector3(0, -999, 0)] },
};

/**
 * Plants and ground cover: the same atlas material, plus gentle wind sway and a soft push away from the player's body and hands.
 * Only the baked plant chunks carry the `aSway` attribute (weight 0 at the root .. 1 at the tip, and the plant's height), so trunks and
 * stems stay planted and flat litter does not move. Pure vertex-shader work: no extra draw call, no extra pass.
 */
export const plantFoliageMaterial = new MeshStandardMaterial({
  name: 'jungle-plant-card',
  map: leafAtlas(),
  vertexColors: true,
  roughness: ROUGH.foliage,
  metalness: 0,
  side: DoubleSide,
  alphaTest: 0.45,
});
plantFoliageMaterial.onBeforeCompile = (shader) => {
  shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n  normal = normalize( vNormal );');
  shader.uniforms.uTime = swayState.time;
  shader.uniforms.uWind = swayState.wind;
  shader.uniforms.uBody = swayState.body;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec2 aSway;\nuniform float uTime;\nuniform float uWind;\nuniform vec3 uBody[3];')
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
  {
    // chunk meshes are baked in world space (identity model matrix), so object space == world space
    float w = aSway.x;
    float sz = aSway.y;
    float ph = transformed.x * 0.31 + transformed.z * 0.23;
    float g = sin(uTime * 1.25 + ph) + 0.55 * sin(uTime * 2.7 + ph * 1.9 + 1.3);
    float gust = 0.65 + 0.35 * sin(uTime * 0.23 + transformed.x * 0.05 + transformed.z * 0.04);
    float amp = uWind * w * (0.012 + 0.028 * sqrt(sz));
    transformed.x += 0.82 * g * gust * amp + 0.15 * amp * sin(uTime * 7.3 + ph * 3.1);
    transformed.z += 0.57 * g * gust * amp;
    for (int i = 0; i < 3; i++) {
      vec3 pp = uBody[i];
      vec2 d = transformed.xz - pp.xz;
      float dist = length(d);
      float reach = i == 0 ? 1.15 : 0.55;
      float push = (1.0 - smoothstep(0.12, reach, dist)) * (1.0 - smoothstep(0.45, 1.15, abs(transformed.y - pp.y))) * w;
      transformed.xz += (d / max(dist, 0.05)) * push * (0.12 + 0.2 * min(sz, 1.6));
      transformed.y -= push * 0.06 * min(sz, 1.6);
    }
  }`,
    );
};
plantFoliageMaterial.customProgramCacheKey = () => 'jungle-plant-sway-v1';

/** Valley canopy: opaque lit crowns, vertex colour only (no texture, no alpha test: zero overdraw cost). */
export const canopyMaterial = new MeshStandardMaterial({ name: 'mountain-canopy', vertexColors: true, roughness: ROUGH.foliage + 0.1, metalness: 0 });

/** Cracks of the collapsing ledge: dark, unlit, fades in as the player approaches (opacity driven by CollapseSystem). */
export const crackMaterial = new MeshBasicMaterial({ name: 'ledge-cracks', color: '#16110c', transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });

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
  emissive: '#9fc9c0',
  emissiveIntensity: 0.1,
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
        { at: 0, color: '#6f9992' },
        { at: 1, color: '#e9f4f1' },
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

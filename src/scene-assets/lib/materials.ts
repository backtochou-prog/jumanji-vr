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
import { FOLIAGE_ALPHA_TO_COVERAGE, leafAtlas } from './leaf-atlas.js';
import { photoTexture } from './photo-textures.js';

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
// Photo detail from the reference video (mossy rock ground) replaces the procedural grain; the bump map stays.
groundMaterial.map = photoTexture('moss');
groundMaterial.onBeforeCompile = (shader) => {
  // World-space projection (the terrain tiles' own UVs do not line up across tile edges, which a photo texture shows as a seam).
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec2 vGroundW;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGroundW = ( modelMatrix * vec4( transformed, 1.0 ) ).xz;');
  // Two samples at different scales/rotations, mixed by a slow mask: no visible tiling at standing height.
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vGroundW;').replace(
    '#include <map_fragment>',
    `#ifdef USE_MAP
      vec2 gUv = vGroundW / 2.2;
      vec4 gA = texture2D( map, gUv );
      vec4 gB = texture2D( map, mat2( 0.8, -0.6, 0.6, 0.8 ) * gUv * 0.37 + vec2( 0.21, 0.63 ), 3.0 ); // blurred (mip bias): tone only, photo cracks are not magnified
      float gM = smoothstep( 0.25, 0.75, 0.5 + 0.5 * sin( gUv.x * 0.71 + sin( gUv.y * 0.93 ) * 1.7 ) );
      diffuseColor *= mix( gA, gB, gM * 0.6 );
    #endif`,
  );
};
groundMaterial.customProgramCacheKey = () => 'jungle-ground-v5';

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
mountainGroundMaterial.map = photoTexture('ledge');
const cliffTex = { value: photoTexture('cliff') };
mountainGroundMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uCliff = cliffTex;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNor;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\nvWNor = normalize( mat3( modelMatrix ) * objectNormal );');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNor;\nuniform sampler2D uCliff;')
    .replace(
      '#include <map_fragment>',
      `#ifdef USE_MAP
      vec3 wn = abs( normalize( vWNor ) );
      float steep = smoothstep( 0.5, 0.82, 1.0 - wn.y );
      vec2 gUv = vWPos.xz / 2.5;
      vec4 gA = texture2D( map, gUv );
      vec4 gB = texture2D( map, mat2( 0.8, -0.6, 0.6, 0.8 ) * gUv * 0.37 + vec2( 0.21, 0.63 ), 3.0 ); // blurred (mip bias): tone only, photo cracks are not magnified
      float gM = smoothstep( 0.25, 0.75, 0.5 + 0.5 * sin( gUv.x * 0.71 + sin( gUv.y * 0.93 ) * 1.7 ) );
      vec4 gTop = mix( gA, gB, gM * 0.6 );
      if ( steep > 0.01 ) {
        // cliff faces: the video's rock wall at two scales (8 m strata up close, 57 m banding that survives at 150 m)
        vec2 ux = vec2( vWPos.z, vWPos.y );
        vec2 uz = vec2( vWPos.x, vWPos.y );
        vec4 sx = texture2D( uCliff, ux / 8.0 ) * ( 0.72 + 0.72 * texture2D( uCliff, ux / 57.0 + vec2( 0.3, 0.6 ) ) );
        vec4 sz = texture2D( uCliff, uz / 8.0 + vec2( 0.37, 0.11 ) ) * ( 0.72 + 0.72 * texture2D( uCliff, uz / 57.0 ) );
        float wx = wn.x * wn.x;
        float wz = wn.z * wn.z;
        gTop = mix( gTop, ( sx * wx + sz * wz ) / max( wx + wz, 1e-4 ), steep );
      }
      diffuseColor *= gTop;
    #endif`,
    );
};
mountainGroundMaterial.customProgramCacheKey = () => 'mountain-ground-v5';

// ---------------------------------------------------------------------------
// Foliage cards (+ wood parts of plants/trees that must share the draw call)
// ---------------------------------------------------------------------------

/**
 * Alpha-to-coverage for the cutout foliage (cards + plants): defined in leaf-atlas.ts (it also softens the atlas' leaf edges), default OFF.
 * It needs MSAA in the XR layer, which cannot be confirmed from the build machine: check `gl.getParameter(gl.SAMPLES) > 1` on the headset first,
 * then flip the flag. The alpha-coverage-preserving mips are on either way.
 */
export { FOLIAGE_ALPHA_TO_COVERAGE };

/**
 * Live wind / proximity state for the plant material. Written each frame by ReactiveFoliageSystem; the shader reads it.
 * `body` = 4 world points that push low plants aside: the player's feet and both hands, and one animal you never see (LivingWorldSystem).
 * `time` and `wind` (1, or 0.4 in reduced-motion mode) also drive the tree-wind of `foliageCardMaterial` and the shimmer of `canopyMaterial`.
 */
export const swayState = {
  time: { value: 0 },
  wind: { value: 1 },
  body: { value: [new Vector3(0, -999, 0), new Vector3(0, -999, 0), new Vector3(0, -999, 0), new Vector3(0, -999, 0)] },
};

/**
 * Travelling gust front shared by the tree wind and the canopy shimmer: 0..1, a plane wave of ~140 m wavelength sweeping along
 * (0.83, 0.56) at ~15 m/s. Needs `uTime` declared before it.
 */
const GUST_GLSL = `float jgGust( vec2 xz ) {
  return 0.5 + 0.5 * sin( dot( xz, vec2( 0.83, 0.56 ) ) * 0.045 - uTime * 0.7 );
}`;

export const foliageCardMaterial = new MeshStandardMaterial({
  name: 'jungle-foliage-card',
  map: leafAtlas(),
  vertexColors: true,
  roughness: ROUGH.foliage,
  metalness: 0,
  side: DoubleSide,
  alphaTest: 0.45,
  alphaToCoverage: FOLIAGE_ALPHA_TO_COVERAGE,
});
/**
 * Tree wind (vertex work only). Every geometry drawn with this material carries `aWind` = (bend, flutter, phase, vine), all 0..1 (see
 * WindWeights in lib/geo.ts; mergeParts always writes it, all-zero for rigid parts, so a missing attribute can never read stale data):
 *   bend     the whole tree leans downwind by up to 0.36 m x weight (weight ~ (y/h)^2 * h/60: 0.3 m at a 50 m crown, mm at the foot), with a
 *            slow per-position cross-wind sway; wood and leaves share the same weight, so crowns stay attached to their limbs
 *   flutter  a rigid shiver of up to 0.1 m per card x weight (card phase in aWind.z), stronger in the gust; > 0.5 marks LEAF vertices
 *   vine     lianas swing like pendulums (free end 0.5 m x weight, phase from world xz) and rise a little as they swing (arc length)
 * The gust front also modulates leaf brightness by a few per cent (neutral on average). Everything is a pure function of world position and
 * time, scaled by swayState.wind (reduced motion = 40 %), so the detailed, cheap and far versions of a tree move identically.
 * The chunk meshes are baked in world space (identity model matrix); `modelMatrix` is only used to place the gust for the few world-placed
 * assets (entrance canopy, root arch, temple growth).
 */
foliageCardMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uTime = swayState.time;
  shader.uniforms.uWind = swayState.wind;
  // Cards carry authored soft normals (rounded-mass lighting): use them on BOTH faces instead of flipping.
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <normal_fragment_begin>',
    '#include <normal_fragment_begin>\n  normal = normalize( vNormal );',
  );
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\nattribute vec4 aWind;\nuniform float uTime;\nuniform float uWind;\n${GUST_GLSL}`)
    .replace(
      '#include <color_vertex>',
      `#include <color_vertex>
  vec3 jgWp = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
  float jgG = jgGust( jgWp.xz );
  #ifdef USE_COLOR
  {
    // brightness shimmer along the gust front (mean-neutral), plus a slow per-card dapple; leaves only
    float jgF = jgG * jgG - 0.375;
    vColor.rgb *= 1.0 + uWind * min( aWind.y * 2.0, 1.0 ) * ( 0.12 * jgF + 0.035 * sin( uTime * 1.9 + aWind.z * 6.2831853 ) );
  }
  #endif`,
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
  {
    float jgPh = aWind.z * 6.2831853;
    vec2 jgDir = vec2( 0.83, 0.56 );
    vec2 jgSide = vec2( -0.56, 0.83 );
    float jgSlow = sin( uTime * 0.62 + jgWp.x * 0.071 + jgWp.z * 0.053 );
    vec2 jgOff = ( jgDir * ( 0.38 + 0.62 * jgG ) + jgSide * 0.32 * jgSlow ) * ( aWind.x * 0.36 );
    float jgV = aWind.w * pow( max( aWind.w, 0.0001 ), 0.4 );
    float jgSw = sin( uTime * 1.15 + jgWp.x * 0.55 + jgWp.z * 0.41 + jgPh ) + 0.4 * sin( uTime * 2.3 + jgPh * 1.7 );
    vec2 jgPend = ( jgDir * ( 0.25 + 0.75 * jgG ) + jgSide * 0.45 * jgSw ) * ( jgV * 0.5 ) * uWind;
    vec3 jgFl = vec3( sin( uTime * 2.9 + jgPh ), 0.6 * sin( uTime * 3.7 + jgPh * 1.7 + 1.3 ), sin( uTime * 2.3 + jgPh * 2.3 + 4.0 ) )
      * ( aWind.y * 0.1 * ( 0.45 + 0.9 * jgG ) );
    transformed.xz += jgOff * uWind + jgPend;
    transformed.y += dot( jgPend, jgPend ) * 0.09;
    transformed += jgFl * uWind;
  }`,
    );
};
foliageCardMaterial.customProgramCacheKey = () => 'jungle-card-v2';


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
  alphaToCoverage: FOLIAGE_ALPHA_TO_COVERAGE,
});
plantFoliageMaterial.onBeforeCompile = (shader) => {
  shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n  normal = normalize( vNormal );');
  shader.uniforms.uTime = swayState.time;
  shader.uniforms.uWind = swayState.wind;
  shader.uniforms.uBody = swayState.body;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec2 aSway;\nuniform float uTime;\nuniform float uWind;\nuniform vec3 uBody[4];')
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
    for (int i = 0; i < 4; i++) {
      vec3 pp = uBody[i];
      vec2 d = transformed.xz - pp.xz;
      float dist = length(d);
      float reach = i == 0 ? 1.15 : (i == 3 ? 1.0 : 0.55);
      float push = (1.0 - smoothstep(0.12, reach, dist)) * (1.0 - smoothstep(0.45, 1.15, abs(transformed.y - pp.y))) * w;
      transformed.xz += (d / max(dist, 0.05)) * push * (0.12 + 0.2 * min(sz, 1.6));
      transformed.y -= push * 0.06 * min(sz, 1.6);
    }
  }`,
    );
};
plantFoliageMaterial.customProgramCacheKey = () => 'jungle-plant-sway-v2';

/**
 * Valley canopy: opaque lit crowns, vertex colour only (no texture, no alpha test: zero overdraw cost).
 * No per-vertex data: the only motion is the gust front's brightness shimmer, a pure function of world position (see `foliageCardMaterial`),
 * so the carpet of crowns seems to breathe as the wind crosses the valley. The geometry itself stays rigid.
 */
export const canopyMaterial = new MeshStandardMaterial({ name: 'mountain-canopy', vertexColors: true, roughness: ROUGH.foliage + 0.1, metalness: 0 });
const canopyTex = { value: photoTexture('canopy') };
canopyMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uTime = swayState.time;
  shader.uniforms.uWind = swayState.wind;
  shader.uniforms.uCanopy = canopyTex;
  // crown tops from the video, projected from above in world space (the clumps have no UVs); two scales so it holds from the summit
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vCanopyW;\nuniform sampler2D uCanopy;')
    .replace(
      '#include <map_fragment>',
      `{
        vec2 cUv = vCanopyW.xz + vCanopyW.y * vec2( 0.41, 0.29 );
        vec3 cT = texture2D( uCanopy, cUv / 13.0 ).rgb * ( 0.5 + 0.62 * texture2D( uCanopy, cUv / 47.0 + vec2( 0.17, 0.53 ) ).rgb );
        diffuseColor.rgb *= cT * 1.45;
      }`,
    );
  shader.vertexShader = shader.vertexShader
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCanopyW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;')
    .replace('#include <common>', `#include <common>\nvarying vec3 vCanopyW;\nuniform float uTime;\nuniform float uWind;\n${GUST_GLSL}`)
    .replace(
      '#include <color_vertex>',
      `#include <color_vertex>
  #ifdef USE_COLOR
  {
    vec3 jgWp = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
    float jgG = jgGust( jgWp.xz );
    vColor.rgb *= 1.0 + uWind * ( 0.14 * ( jgG * jgG - 0.375 ) + 0.03 * sin( uTime * 1.3 + jgWp.x * 0.9 + jgWp.z * 0.7 ) );
  }
  #endif`,
    );
};
canopyMaterial.customProgramCacheKey = () => 'mountain-canopy-v3';

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

rockMaterial.map = photoTexture('rock'); // lichen-spotted boulder from the reference video
rockMaterial.map.repeat.set(1.7, 1.7); // finer grain on the big boulders

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

/**
 * Shared clock of the falling water (seconds, wrapped at 1024 s), advanced by WaterSystem. A plain object so the DOM-free assets can hold it:
 * the waterfall shader reads it as `uWClock`. The streak speeds in the shader are multiples of 1/16 per second, so the pattern is seamless at the wrap.
 */
export const waterClock = { value: 0 };
/** 1 = full streak detail, 0 = the cheap path (the 'low' quality tier: one noise layer less). A uniform branch, so no new shader program. */
export const waterDetail = { value: 1 };

/**
 * Falling water: pale, streaky, translucent; the texture is scrolled downward by WaterSystem and the shader adds two procedural streak layers
 * on its own clock (so every fall moves at its own pace whatever the shared texture does), foam at the ledges and the lip, a bright core and
 * ragged edges. Every sheet carries `aFall` = (lateral -1..1, t 0 (lip) .. 1 (foot), foam 0..1); geometry without it (the pool trickle) gets
 * (0, -1, 0) from `defaultAttributeValues` and keeps the plain textured look (t < 0 switches the effects off).
 */
export const waterfallMaterial = createSceneMaterial({
  id: 'jungle-waterfall',
  model: 'standard',
  baseColor: '#ffffff',
  emissive: '#a9d3cb',
  emissiveIntensity: 0.2,
  opacity: 0.88,
  roughness: 0.32,
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
        { at: 0, color: '#9bbab3' },
        { at: 1, color: '#eef7f4' },
      ],
      sampler: { wrapU: 'repeat', wrapV: 'repeat' },
    },
  },
});
// One pass for the double-sided sheet: the default would draw every transparent double-sided mesh twice (back faces, then front faces).
// The falls are single sheets seen from one side, so the extra pass was pure waste (vertex work + a draw call each).
(waterfallMaterial as MeshStandardMaterial).forceSinglePass = true;
(waterfallMaterial as unknown as { defaultAttributeValues: Record<string, number[]> }).defaultAttributeValues = { aFall: [0, -1, 0] };
waterfallMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uWClock = waterClock;
  shader.uniforms.uWDetail = waterDetail;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec3 aFall;\nvarying vec3 vFall;\nvarying vec2 vFallUv;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFall = aFall;\nvFallUv = uv;');
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
uniform float uWClock;
uniform float uWDetail;
varying vec3 vFall;
varying vec2 vFallUv;
// Value noise on a 64-cell lattice (wrapped, so the pattern never loses precision however long the clock runs).
float wfHash( vec2 p ) {
  vec3 q = fract( vec3( p.xyx ) * 0.1031 );
  q += dot( q, q.yzx + 33.33 );
  return fract( ( q.x + q.y ) * q.z );
}
float wfNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  vec2 a = mod( i, 64.0 );
  vec2 b = mod( i + 1.0, 64.0 );
  return mix( mix( wfHash( a ), wfHash( vec2( b.x, a.y ) ), f.x ), mix( wfHash( vec2( a.x, b.y ) ), wfHash( b ), f.x ), f.y );
}`,
    )
    .replace(
      '#include <map_fragment>',
      `#include <map_fragment>
  float wfOn = step( 0.0, vFall.y );
  float wfLat = abs( vFall.x );
  float wfCore = 1.0 - wfLat * wfLat;
  // vertical phase: the streaks stretch towards the foot (the water speeds up), x is the lateral position in the texture's own units
  float wfPh = vFallUv.y * ( 1.0 - 0.35 * max( vFall.y, 0.0 ) );
  float wfA = wfNoise( vec2( vFallUv.x * 11.0, wfPh * 1.1 - uWClock * 1.5 ) );
  float wfB = 0.5;
  if ( uWDetail > 0.5 ) wfB = wfNoise( vec2( vFallUv.x * 27.0 + 7.3, wfPh * 2.6 - uWClock * 3.0 ) );
  float wfStreak = wfA * 0.6 + wfB * 0.4;
  float wfEdge = 1.0 - smoothstep( 0.5, 0.88, wfLat + ( wfB - 0.5 ) * 0.38 );
  float wfPulse = 0.78 + 0.22 * sin( 6.2831853 * fract( uWClock * 0.375 + wfPh * 0.37 ) );
  float wfFoam = clamp( vFall.z * ( 0.35 + 0.9 * wfA ) * wfPulse + smoothstep( 0.72, 1.0, wfLat ) * 0.5 * wfB, 0.0, 1.0 ) * wfOn;
  diffuseColor.rgb *= mix( 1.0, 0.8 + 0.4 * wfStreak, wfOn );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.97, 1.0, 1.0 ), wfFoam * 0.8 );
  diffuseColor.a = mix( diffuseColor.a, clamp( diffuseColor.a * ( 0.8 + 0.4 * wfStreak ) * wfEdge + wfFoam * 0.2, 0.0, 1.0 ), wfOn );`,
    )
    .replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
  totalEmissiveRadiance *= mix( 1.0, 0.8 + 0.9 * wfCore + 1.2 * wfFoam, wfOn );`,
    );
};
waterfallMaterial.customProgramCacheKey = () => 'jungle-fall-v2';

/**
 * Live state of the light shafts / mist cards, written by ShimmerSystem (a plain object: DOM-free, shared by every program that uses the material).
 * `time` is seconds (already scaled by the Shimmer component's speed), `breath` the depth of the brightness breathing (0 = static).
 */
export const lightShaftUniforms = { time: { value: 0 }, breath: { value: 0.22 } };

/**
 * Additive light-shaft / mist cards (vertex-colour brightness only, no alpha texture, opacity stays 1).
 * 'light-shaft-v2': a vertex-stage patch makes them LIVE without any fragment cost. Brightness breathes with a phase that depends on the WORLD
 * position (so neighbouring beams and mist banks never pulse in lockstep; the pulse travels along a beam), and meshes that carry the optional
 * `aSway` attribute (x = 0 at the base .. 1 at the tip: the merged shafts) lean and drift at their tips. Meshes without it (waterfall mist,
 * fall mist, ground mist) get aSway = 0 from `defaultAttributeValues`, so they only breathe. Colour is multiplied, alpha is untouched.
 * Optional `aMist` (vec3, default 0 = inactive; for spray plumes and mist cards): x = height weight (0 at the card's foot .. 1 at its top),
 * y = rise in OBJECT-space metres, z = phase offset. The card's top then rises and sinks by `x*y*(0.5+0.5*sin(t*0.5+z))`, so a plume heaves
 * instead of sitting still.
 * One program, created with the material at module time (the existing warm-up compiles it); the shader uses only modelMatrix, so the
 * XR multiview path is unaffected.
 */
export const lightShaftMaterial = new MeshBasicMaterial({
  name: 'light-shaft',
  vertexColors: true,
  transparent: true,
  blending: AdditiveBlending,
  depthWrite: false,
  side: DoubleSide,
  fog: true,
});
// three reads material.defaultAttributeValues generically when a geometry lacks an attribute the program declares
(lightShaftMaterial as unknown as { defaultAttributeValues: Record<string, number[]> }).defaultAttributeValues = { aSway: [0, 0], aMist: [0, 0, 0] };
lightShaftMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uShaftTime = lightShaftUniforms.time;
  shader.uniforms.uShaftBreath = lightShaftUniforms.breath;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec2 aSway;\nattribute vec3 aMist;\nuniform float uShaftTime;\nuniform float uShaftBreath;')
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
  {
    vec3 wp = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
    float ph = uShaftTime * 0.55 + wp.x * 0.11 + wp.z * 0.083;
    float br = 0.65 * sin( ph ) + 0.35 * sin( uShaftTime * 1.3 + wp.x * 0.37 - wp.z * 0.29 + 1.7 );
    vColor.rgb *= 1.0 - uShaftBreath * ( 0.5 + 0.5 * br );
    float tip = aSway.x;
    transformed.x += tip * 1.1 * sin( uShaftTime * 0.31 + wp.z * 0.07 + wp.y * 0.05 );
    transformed.z += tip * 0.8 * sin( uShaftTime * 0.27 + wp.x * 0.06 + 1.9 );
    transformed.y += aMist.x * aMist.y * ( 0.5 + 0.5 * sin( uShaftTime * 0.5 + aMist.z ) );
  }`,
    );
};
lightShaftMaterial.customProgramCacheKey = () => 'light-shaft-v2';

/**
 * Waterfall-group addition to the material above: fog ATTENUATES additive light instead of mixing toward the fog colour.
 * three's fog chunk does `rgb = mix(rgb, fogColor, fogFactor)`, which is right for opaque surfaces but wrong for something ADDED to the frame:
 * every black vertex of a mist card (its soft edges, the ground disc's rim, the spray-bow's ends) would add `fogColor * fogFactor` (about 0.18 at
 * the backdrop fall's 122 m with the vista fog) and the whole card would show as a pale rectangle. Here the colour is multiplied by `1 - fogFactor`
 * (additive light fades into the haze like everything else). Placed after (and wrapping) the vertex patch above; a no-op if the fog chunk was
 * already replaced. Same program key, no new material (the manifest is at its 16-material budget).
 */
{
  const patchVertex = lightShaftMaterial.onBeforeCompile;
  lightShaftMaterial.onBeforeCompile = (shader, renderer) => {
    patchVertex.call(lightShaftMaterial, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <fog_fragment>',
      `#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  gl_FragColor.rgb *= 1.0 - fogFactor;
#endif`,
    );
  };
}

/** Unlit, fogged silhouette material for the background ridges. */
export const silhouetteMaterial = new MeshBasicMaterial({
  name: 'ridge-silhouette',
  vertexColors: true,
  side: DoubleSide,
  fog: true,
});

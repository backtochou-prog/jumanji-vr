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
import { EVEREST } from '../../world/everest.js';
import { FOLIAGE_ALPHA_TO_COVERAGE, WOOD_UV, leafAtlas } from './leaf-atlas.js';
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

/**
 * Stochastic (hex-grid) tiling, after Mikkelsen's "Practical Real-Time Hex-Tiling": the plane is cut into hexagons one texture tile across, and
 * every hexagon shows the photo at its own random offset and rotation; neighbours cross-fade in a narrow band (weights^6). A small photo tile with a
 * few recognisable features (two dead leaves, one twig) therefore never lines up into rows, which a plain repeat does every 1.3 m.
 * Three lookups; explicit gradients, because the per-hexagon UV jumps would otherwise pick the smallest mip along the hexagon edges (a dotted grid).
 */
const HEX_GLSL = `
vec2 jgHexHash( vec2 p ) { return fract( sin( vec2( dot( p, vec2( 127.1, 311.7 ) ), dot( p, vec2( 269.5, 183.3 ) ) ) ) * 43758.5453 ); }
vec4 jgHexOne( sampler2D t, vec2 st, vec2 id, vec2 dx, vec2 dy ) {
  vec2 h = jgHexHash( id );
  float a = h.x * 6.2831853;
  float c = cos( a );
  float s = sin( a );
  mat2 r = mat2( c, s, -s, c );
  return textureGrad( t, r * st + h, r * dx, r * dy );
}
vec4 jgHexTex( sampler2D t, vec2 st ) {
  vec2 dx = dFdx( st );
  vec2 dy = dFdy( st );
  vec2 sk = vec2( st.x - 0.57735027 * st.y, 1.15470054 * st.y );
  vec2 base = floor( sk );
  vec3 f = vec3( fract( sk ), 0.0 );
  f.z = 1.0 - f.x - f.y;
  float s = step( 0.0, -f.z );
  float s2 = 2.0 * s - 1.0;
  vec3 w = vec3( -f.z * s2, s - f.y * s2, s - f.x * s2 );
  w *= w * w;
  w *= w;
  w /= w.x + w.y + w.z;
  return jgHexOne( t, st, base + vec2( s, s ), dx, dy ) * w.x
    + jgHexOne( t, st, base + vec2( s, 1.0 - s ), dx, dy ) * w.y
    + jgHexOne( t, st, base + vec2( 1.0 - s, s ), dx, dy ) * w.z;
}`;

/**
 * The same hex tiling for a photo with a DIRECTION (wind-swept snow: every drift leans the same way): each hexagon gets its own offset but no
 * rotation, so the wind keeps blowing one way. The gradients come from the caller (the lookup sits inside a branch).
 */
const HEX_DIR_GLSL = `
vec4 jgHexDir( sampler2D t, vec2 st, vec2 dx, vec2 dy ) {
  vec2 sk = vec2( st.x - 0.57735027 * st.y, 1.15470054 * st.y );
  vec2 base = floor( sk );
  vec3 f = vec3( fract( sk ), 0.0 );
  f.z = 1.0 - f.x - f.y;
  float s = step( 0.0, -f.z );
  float s2 = 2.0 * s - 1.0;
  vec3 w = vec3( -f.z * s2, s - f.y * s2, s - f.x * s2 );
  w *= w * w;
  w *= w;
  w /= w.x + w.y + w.z;
  return textureGrad( t, st + jgHexHash( base + vec2( s, s ) ), dx, dy ) * w.x
    + textureGrad( t, st + jgHexHash( base + vec2( s, 1.0 - s ) ), dx, dy ) * w.y
    + textureGrad( t, st + jgHexHash( base + vec2( 1.0 - s, s ) ), dx, dy ) * w.z;
}`;

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
// Photo detail from the user's terrain template (forest floor: moss, roots, dead leaves) replaces the procedural grain; the bump map stays.
groundMaterial.map = photoTexture('moss');
groundMaterial.onBeforeCompile = (shader) => {
  // World-space projection (the terrain tiles' own UVs do not line up across tile edges, which a photo texture shows as a seam).
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec2 vGroundW;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGroundW = ( modelMatrix * vec4( transformed, 1.0 ) ).xz;');
  // Detail: the photo, stochastically tiled (HEX_GLSL). Tone: one blurred sample at another scale and rotation, mixed in by a slow mask.
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec2 vGroundW;${HEX_GLSL}`).replace(
    '#include <map_fragment>',
    `#ifdef USE_MAP
      vec2 gUv = vGroundW / 2.6;
      vec4 gA = jgHexTex( map, gUv * 2.0 ); // one tile = 1.3 m: fallen leaves and twigs at their real size; hex-tiled, so the tile never repeats in rows
      vec4 gB = texture2D( map, mat2( 0.8, -0.6, 0.6, 0.8 ) * gUv * 0.37 + vec2( 0.21, 0.63 ), 3.0 ); // blurred (mip bias): tone only, photo cracks are not magnified
      float gM = smoothstep( 0.25, 0.75, 0.5 + 0.5 * sin( gUv.x * 0.71 + sin( gUv.y * 0.93 ) * 1.7 ) );
      diffuseColor *= mix( gA, gB, gM * 0.6 );
    #endif`,
  );
};
groundMaterial.customProgramCacheKey = () => 'jungle-ground-v8';

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
const snowWindTex = { value: photoTexture('snowWind') };
const snowGrainTex = { value: photoTexture('snowGrain') };
const snowPackTex = { value: photoTexture('snowPack') };
/**
 * Everest (world/everest.ts) shares this material. Two additions, both pure functions of world height (the east mountain tops out at 37 m, far below):
 *  - SNOW above the snow line (128 m, broken up by the photo's own tone and a slow wobble): the snow replaces texture AND vertex colour, and lies on
 *    everything but the steep faces (> ~55 degrees), which stay bare rock.
 *  - CLEAR AIR above the cloud deck (104 m): the jungle's fog is a low humid layer, so the part of the peak that stands above the clouds keeps
 *    `everestAir.clear` of its colour however far it is (seen from the knoll: pale fogged slopes, the cloud collar, then the snow summit against the sky).
 *    AtmosphereSystem lowers it to 0 inside the clouds.
 */
export const everestAir = { clear: { value: 0.62 } };
const F1 = (n: number): string => n.toFixed(1);
mountainGroundMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uCliff = cliffTex;
  shader.uniforms.uClear = everestAir.clear;
  shader.uniforms.uSnowWind = snowWindTex;
  shader.uniforms.uSnowGrain = snowGrainTex;
  shader.uniforms.uSnowPack = snowPackTex;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aPacked;\nvarying float vPacked;\nvarying vec3 vWPos;\nvarying vec3 vWNor;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPacked = aPacked;\nvWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\nvWNor = normalize( mat3( modelMatrix ) * objectNormal );');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\nvarying float vPacked;\nvarying vec3 vWPos;\nvarying vec3 vWNor;\nuniform sampler2D uCliff;\nuniform sampler2D uSnowWind;\nuniform sampler2D uSnowGrain;\nuniform sampler2D uSnowPack;\nuniform float uClear;${HEX_GLSL}${HEX_DIR_GLSL}`)
    .replace(
      '#include <map_fragment>',
      `float jgSnow = 0.0;
    #ifdef USE_MAP
      vec3 wn = abs( normalize( vWNor ) );
      float steep = smoothstep( 0.5, 0.82, 1.0 - wn.y );
      vec2 gUv = vWPos.xz / 2.5;
      vec4 gA = jgHexTex( map, gUv ); // hex-tiled: no rows of the same slab on the open slopes
      vec2 jgDx = dFdx( vWPos.xz ); // for the snow photos, which are read inside a branch
      vec2 jgDy = dFdy( vWPos.xz );
      vec4 gB = texture2D( map, mat2( 0.8, -0.6, 0.6, 0.8 ) * gUv * 0.37 + vec2( 0.21, 0.63 ), 3.0 ); // blurred (mip bias): tone only, photo cracks are not magnified
      float gM = smoothstep( 0.25, 0.75, 0.5 + 0.5 * sin( gUv.x * 0.71 + sin( gUv.y * 0.93 ) * 1.7 ) );
      vec4 gTop = mix( gA, gB, gM * 0.6 );
      if ( steep > 0.01 ) {
        // cliff faces: the template's grey rock wall at two scales (8 m slabs up close, 57 m banding that survives at 150 m)
        vec2 ux = vec2( vWPos.z, vWPos.y );
        vec2 uz = vec2( vWPos.x, vWPos.y );
        vec4 sx = texture2D( uCliff, ux / 8.0 ) * ( 0.72 + 0.72 * texture2D( uCliff, ux / 57.0 + vec2( 0.3, 0.6 ) ) );
        vec4 sz = texture2D( uCliff, uz / 8.0 + vec2( 0.37, 0.11 ) ) * ( 0.72 + 0.72 * texture2D( uCliff, uz / 57.0 ) );
        float wx = wn.x * wn.x;
        float wz = wn.z * wn.z;
        gTop = mix( gTop, ( sx * wx + sz * wz ) / max( wx + wz, 1e-4 ), steep );
      }
      if ( vWPos.y > ${F1(EVEREST.snow - 40)} ) {
        float sh = vWPos.y + ( gA.g - 0.45 ) * 26.0 + 10.0 * sin( vWPos.x * 0.045 ) * sin( vWPos.z * 0.039 );
        jgSnow = smoothstep( ${F1(EVEREST.snow - 6)}, ${F1(EVEREST.snow + 16)}, sh ) * ( 1.0 - 0.86 * smoothstep( 0.3, 0.5, 1.0 - wn.y + ( gA.r - 0.45 ) * 0.2 ) );
      }
      diffuseColor *= gTop;
    #endif`,
    )
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
    #ifdef USE_MAP
      // Snow: the user's snow sheet. Not paper white (under the warm sun a 0.9 albedo burns out to cream and loses every form): the photos give the
      // FORM (their light and shade pick between a cool off-white and the blue shade of a hollow), not the brightness.
      //  - wind-swept drifts, 7 m a tile, hex-tiled without rotation (the wind blows one way) + once more at 41 m for the slopes seen from afar
      //  - granular frost, 1.1 m a tile: the grain under the feet (fades out by 40 m, where it would only be noise)
      //  - packed snow on the trail (aPacked, only on the trail ribbons: 0 everywhere else): a trodden, lumpy, bluer line
      if ( jgSnow > 0.004 ) {
        float jgNear = 1.0;
        #ifdef USE_FOG
          jgNear = 1.0 - smoothstep( 12.0, 40.0, vFogDepth );
        #endif
        vec2 sUv = mat2( 0.8, -0.6, 0.6, 0.8 ) * vWPos.xz; // the drifts run across the prevailing wind
        vec2 sDx = mat2( 0.8, -0.6, 0.6, 0.8 ) * jgDx;
        vec2 sDy = mat2( 0.8, -0.6, 0.6, 0.8 ) * jgDy;
        float jgWind = jgHexDir( uSnowWind, sUv / 7.0, sDx / 7.0, sDy / 7.0 ).g;
        float jgFar = textureGrad( uSnowWind, sUv.yx / 41.0 + vec2( 0.4, 0.15 ), sDx.yx / 10.0, sDy.yx / 10.0 ).g; // (wide gradients: a blurred lookup, tone only)
        float jgGrain = textureGrad( uSnowGrain, vWPos.xz / 1.1, jgDx / 1.1, jgDy / 1.1 ).g;
        // the photos' light relative to their mean (0.6 linear); the deep shadows of the drift photo are compressed (at full depth they read as stains)
        float jgTone = ( jgWind - 0.6 ) * 1.25 + ( jgFar - 0.6 ) * 0.6 + ( jgGrain - 0.6 ) * 1.4 * jgNear;
        jgTone /= 1.0 + 1.3 * max( -jgTone, 0.0 );
        float jgHollow = clamp( 0.3 + smoothstep( 0.02, 0.3, 1.0 - wn.y ) * 0.3 - jgTone + ( 0.5 - gB.g ) * 0.25, 0.0, 1.0 );
        // (the lit end stays well under 1: the sun is warm and > 1, a brighter snow clips to a flat cream and the photo disappears)
        vec3 jgSnowC = mix( vec3( 0.58, 0.7, 0.85 ), vec3( 0.3, 0.43, 0.74 ), jgHollow );
        if ( vPacked > 0.01 ) {
          float jgPack = textureGrad( uSnowPack, vWPos.xz / 1.7, jgDx / 1.7, jgDy / 1.7 ).g;
          jgSnowC = mix( jgSnowC, vec3( 0.52, 0.6, 0.76 ) * ( 0.45 + 0.92 * jgPack ), vPacked * 0.85 );
        }
        diffuseColor.rgb = mix( diffuseColor.rgb, jgSnowC, jgSnow );
      }
    #endif`,
    )
    .replace(
      '#include <fog_fragment>',
      `#ifdef USE_FOG
      #ifdef FOG_EXP2
        float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
      #else
        float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
      #endif
      fogFactor *= 1.0 - uClear * smoothstep( ${F1(EVEREST.deck - 8)}, ${F1(EVEREST.deck + 26)}, vWPos.y );
      gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
    #endif`,
    );
};
mountainGroundMaterial.customProgramCacheKey = () => 'mountain-ground-v12';

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
/**
 * Trunk bark for every material that draws wood (tree cards, understory plants, valley canopy): the template's furrowed bark projected from the
 * two sides in WORLD space, so no trunk needs UVs and every version of a tree carries the same bark. `w` = |world normal|.xz, `m` = metres per
 * tile of the fine scale. The second lookup is the same photo 3.5x wider and stretched up the trunk (plates and ridges 30-40 cm across): the fine
 * scale averages out to a flat tone beyond ~15 m, which left every trunk but the nearest looking untextured; the wide one still reads at 60 m.
 */
const BARK_GLSL = `
vec3 jgBark( sampler2D t, vec3 p, vec2 w, float m ) {
  float bx = w.x * w.x;
  float bz = w.y * w.y;
  vec2 ux = p.zy;
  vec2 uz = p.xy;
  vec3 bA = texture2D( t, ux / m ).rgb * bx + texture2D( t, uz / m + vec2( 0.37, 0.0 ) ).rgb * bz;
  vec3 bM = texture2D( t, ( bx > bz ? ux : uz ) / vec2( 4.6, 9.5 ) + vec2( 0.2, 0.6 ) ).rgb;
  return bA / max( bx + bz, 1e-4 ) * ( 0.3 + 0.9 * bM ) * 1.7;
}`;
const barkTex = { value: photoTexture('bark') };
foliageCardMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uTime = swayState.time;
  shader.uniforms.uWind = swayState.wind;
  shader.uniforms.uBark = barkTex;
  // Cards carry authored soft normals (rounded-mass lighting): use them on BOTH faces instead of flipping.
  // Wood (trunks, limbs, lianas: aWind.y <= 0.5) gets the template's furrowed bark, projected from the two sides in WORLD space at rest
  // position, so the detailed, cheap and far versions of a tree carry the same bark and the wind does not slide it. Leaves skip the
  // lookups (a triangle is all wood or all leaf).
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\nvarying vec3 vBarkP;\nvarying vec3 vBarkW;\nuniform sampler2D uBark;${BARK_GLSL}`)
    .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n  normal = normalize( vNormal );')
    .replace(
      '#include <map_fragment>',
      `#include <map_fragment>
  if ( vBarkW.z > 0.5 ) diffuseColor.rgb *= jgBark( uBark, vBarkP, vBarkW.xy, 1.3 );`,
    );
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\nattribute vec4 aWind;\nuniform float uTime;\nuniform float uWind;\nvarying vec3 vBarkP;\nvarying vec3 vBarkW;\n${GUST_GLSL}`)
    .replace(
      '#include <color_vertex>',
      `#include <color_vertex>
  vec3 jgWp = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
  float jgG = jgGust( jgWp.xz );
  vBarkP = jgWp;
  vBarkW = vec3( abs( normalize( mat3( modelMatrix ) * normal ) ).xz, step( aWind.y, 0.5 ) );
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
foliageCardMaterial.customProgramCacheKey = () => 'jungle-card-v5';


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
  // Trunks (palms, tree ferns, stilt roots: geometry mapped with `woodUV`) get the same bark photo as the trees, finer because they are slim.
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\nvarying vec3 vBarkP;\nvarying vec3 vBarkW;\nuniform sampler2D uBark;${BARK_GLSL}`)
    .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n  normal = normalize( vNormal );')
    .replace('#include <map_fragment>', '#include <map_fragment>\n  if ( vBarkW.z > 0.5 ) diffuseColor.rgb *= jgBark( uBark, vBarkP, vBarkW.xy, 0.8 ) * 1.25;');
  shader.uniforms.uTime = swayState.time;
  shader.uniforms.uWind = swayState.wind;
  shader.uniforms.uBody = swayState.body;
  shader.uniforms.uBark = barkTex;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec2 aSway;\nuniform float uTime;\nuniform float uWind;\nuniform vec3 uBody[4];\nvarying vec3 vBarkP;\nvarying vec3 vBarkW;')
    .replace(
      '#include <color_vertex>',
      `#include <color_vertex>
  vBarkP = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
  {
    vec2 jgUvD = abs( uv - vec2( ${WOOD_UV[0].toFixed(5)}, ${WOOD_UV[1].toFixed(5)} ) );
    vBarkW = vec3( abs( normalize( mat3( modelMatrix ) * normal ) ).xz, step( max( jgUvD.x, jgUvD.y ), 0.012 ) );
  }`,
    )
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
plantFoliageMaterial.customProgramCacheKey = () => 'jungle-plant-sway-v3';

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
  shader.uniforms.uBark = barkTex;
  // crown tops from the template (palms and broadleaf crowns seen from above), projected in world space (the clumps have no UVs);
  // two scales so it holds from the summit
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\nvarying vec3 vCanopyW;\nvarying vec3 vCanopyB;\nuniform sampler2D uCanopy;\nuniform sampler2D uBark;${BARK_GLSL}`)
    .replace(
      '#include <map_fragment>',
      `if ( vCanopyB.z > 0.5 ) {
        diffuseColor.rgb *= jgBark( uBark, vCanopyW, vCanopyB.xy, 1.3 );
      } else {
        vec2 cUv = vCanopyW.xz + vCanopyW.y * vec2( 0.41, 0.29 );
        vec3 cT = texture2D( uCanopy, cUv / 44.0 ).rgb * ( 0.5 + 0.62 * texture2D( uCanopy, cUv / 163.0 + vec2( 0.17, 0.53 ), 1.5 ).rgb );
        diffuseColor.rgb *= cT * 1.45;
      }`,
    );
  shader.vertexShader = shader.vertexShader
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCanopyW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;')
    .replace('#include <common>', `#include <common>\nvarying vec3 vCanopyW;\nvarying vec3 vCanopyB;\nuniform float uTime;\nuniform float uWind;\n${GUST_GLSL}`)
    .replace(
      '#include <color_vertex>',
      `#include <color_vertex>
  vCanopyB = vec3( abs( normalize( mat3( modelMatrix ) * normal ) ).xz, 0.0 );
  #ifdef USE_COLOR
  {
    // the clump's trunk is the only brown in the mesh (crowns are green even at the warm end of the hue field): red over green marks the wood
    vCanopyB.z = step( color.g * 1.1, color.r );
    vec3 jgWp = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
    float jgG = jgGust( jgWp.xz );
    vColor.rgb *= 1.0 + uWind * ( 0.14 * ( jgG * jgG - 0.375 ) + 0.03 * sin( uTime * 1.3 + jgWp.x * 0.9 + jgWp.z * 0.7 ) );
  }
  #endif`,
    );
};
canopyMaterial.customProgramCacheKey = () => 'mountain-canopy-v5';

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

rockMaterial.map = photoTexture('rock'); // blocky grey rock from the terrain template
rockMaterial.map.repeat.set(1.7, 1.7); // finer grain on the big boulders
// Hex-tiled like the ground: a standing stone or a crag is several tiles tall, and the plain repeat stacked the same slab into a regular column.
rockMaterial.onBeforeCompile = (shader) => {
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>${HEX_GLSL}`)
    .replace('#include <map_fragment>', '#ifdef USE_MAP\n  diffuseColor *= jgHexTex( map, vMapUv );\n#endif');
};
rockMaterial.customProgramCacheKey = () => 'jungle-rock-v2';

export const barkMaterial = vertexColored(
  createSceneMaterial({
    id: 'jungle-bark',
    model: 'standard',
    baseColor: '#ffffff',
    roughness: ROUGH.bark,
    textures: { albedo: grain(13, '#9d9689', '#ffffff', 16), bump: bump(23, [60, 8], 1.1) },
  }),
);
barkMaterial.map = photoTexture('barkMoss'); // mossy, lichen-covered bark from the wood template (fallen logs, deadwood, the bridge)

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
const waterTex = { value: photoTexture('water') };
waterMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uSky = { value: new Color(PAL.waterShallow).lerp(new Color('#cfe6e0'), 0.55) };
  shader.uniforms.uWaterTex = waterTex;
  shader.uniforms.uWClock = waterClock;
  // the template's water surface (wavelets, pale crests), projected from above in world space; two copies drift across each other
  // (speeds are multiples of 1/1024 per second, so the pattern is seamless when the shared clock wraps)
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec2 vWaterW;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWaterW = ( modelMatrix * vec4( transformed, 1.0 ) ).xz;');
  shader.fragmentShader = 'uniform vec3 uSky;\nuniform sampler2D uWaterTex;\nuniform float uWClock;\nvarying vec2 vWaterW;\n' + shader.fragmentShader
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
    {
      vec3 wA = texture2D( uWaterTex, vWaterW / 3.1 + vec2( 0.03125, 0.015625 ) * uWClock ).rgb;
      vec3 wB = texture2D( uWaterTex, mat2( 0.6, -0.8, 0.8, 0.6 ) * vWaterW / 5.3 - vec2( 0.01171875, 0.0234375 ) * uWClock ).rgb;
      diffuseColor.rgb *= ( wA + wB ) * 0.64;
    }`,
    )
    .replace(
    '#include <opaque_fragment>',
    `float fres = pow( 1.0 - saturate( dot( normalize( vViewPosition ), normal ) ), 3.0 );
    outgoingLight = mix( outgoingLight, uSky, fres * 0.28 );
    diffuseColor.a = mix( diffuseColor.a, 1.0, fres * 0.45 );
    #include <opaque_fragment>`,
  );
};
waterMaterial.customProgramCacheKey = () => 'jungle-water-v3';

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
 * Optional `aNear` (float, default 0 = inactive; the ground mist): the vertex fades to nothing between aNear and 0.45 x aNear metres from the eye.
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
(lightShaftMaterial as unknown as { defaultAttributeValues: Record<string, number[]> }).defaultAttributeValues = { aSway: [0, 0], aMist: [0, 0, 0], aNear: [0] };
lightShaftMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uShaftTime = lightShaftUniforms.time;
  shader.uniforms.uShaftBreath = lightShaftUniforms.breath;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec2 aSway;\nattribute vec3 aMist;\nattribute float aNear;\nuniform float uShaftTime;\nuniform float uShaftBreath;')
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
  {
    vec3 wp = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
    float ph = uShaftTime * 0.55 + wp.x * 0.11 + wp.z * 0.083;
    float br = 0.65 * sin( ph ) + 0.35 * sin( uShaftTime * 1.3 + wp.x * 0.37 - wp.z * 0.29 + 1.7 );
    vColor.rgb *= 1.0 - uShaftBreath * ( 0.5 + 0.5 * br );
    // optional near fade (aNear = distance in m at which the vertex is at full strength; 0 = off): the flat ground mist dissolves as the eye comes
    // close, so nobody stands inside a milky additive sheet or watches it cross the eye line
    vColor.rgb *= mix( 1.0, smoothstep( aNear * 0.45, aNear, length( ( modelViewMatrix * vec4( transformed, 1.0 ) ).xyz ) ), step( 0.001, aNear ) );
    float tip = aSway.x;
    transformed.x += tip * 1.1 * sin( uShaftTime * 0.31 + wp.z * 0.07 + wp.y * 0.05 );
    transformed.z += tip * 0.8 * sin( uShaftTime * 0.27 + wp.x * 0.06 + 1.9 );
    transformed.y += aMist.x * aMist.y * ( 0.5 + 0.5 * sin( uShaftTime * 0.5 + aMist.z ) );
  }`,
    );
};
lightShaftMaterial.customProgramCacheKey = () => 'light-shaft-v3';

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

/**
 * Unlit, fogged silhouette material for the background ridges and the far ranges. The map (forested slopes cut from the misty-mountains
 * template) multiplies the vertex colours: relief on the flanks instead of flat colour bands. Every geometry drawn with it carries UVs.
 */
export const silhouetteMaterial = new MeshBasicMaterial({
  name: 'ridge-silhouette',
  vertexColors: true,
  side: DoubleSide,
  fog: true,
  map: photoTexture('range'),
});
silhouetteMaterial.color.setRGB(1.78, 1.69, 1.61); // undoes the texture's mean (linear 0.56 / 0.59 / 0.62): the baked colours keep their value and hue

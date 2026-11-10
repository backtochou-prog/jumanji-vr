/**
 * One palette, one roughness table, one sun.
 *
 * Every asset pulls its colours from here so the jungle reads as a single
 * painted world instead of a kit of parts. The scheme:
 *   - sunlit foliage leans yellow-green, shaded foliage leans blue-green;
 *   - soils are warm umber, stone is warm grey (never blue), moss bridges
 *     stone and foliage;
 *   - ONE warm accent (amber/orange) is reserved for flowers, the relic's
 *     heart and the sun, so it always signals "look here".
 * Pure data: safe in both SDK realms and in Node tools.
 */

export const PAL = {
  // Foliage (value ramp from sunlit to deep shade)
  leafSun: '#9bb43f',
  leafLight: '#6f9a34',
  leafMid: '#4a7a2c',
  leafShade: '#2d5428',
  leafDeep: '#1a3a25',
  leafDry: '#a19340',
  leafDead: '#7a5a30',

  // Ground
  grass: '#6c8f37',
  grassDry: '#8a9a45',
  moss: '#4c7731',
  mossDeep: '#2c4d24',
  soil: '#5a432d',
  soilDark: '#34271a',
  mud: '#35281c',
  litter: '#62482a',
  wetSoil: '#2b2a1e',

  // Wood and stone
  bark: '#5c4b3a',
  barkDark: '#2e251d',
  barkLight: '#7d6a55',
  deadwood: '#8a7a68',
  stone: '#8a8b82',
  stoneDark: '#52544e',
  stoneWet: '#3f4642',
  ruin: '#8e9288',
  ruinDark: '#565b54',

  // Mountain rock (cliffs, ledges): warm-grey sedimentary strata, iron staining, wet dark rock
  cliff: '#7f7b6a',
  cliffDark: '#46433a',
  cliffWarm: '#9a8460',
  cliffWet: '#34393a',
  scree: '#8b867a',
  valleyForest: '#1d4125',

  // The single warm accent
  accent: '#e48a2e',
  accentPale: '#f0c872',

  // Water
  waterDeep: '#183f3a',
  waterShallow: '#33604f',
  foam: '#e6f3ef',
} as const;

/**
 * Rare tree-crown tints for the world-space colour field (chunks.scene-asset.ts), as RGB MULTIPLIERS on a crown's baked leaf colours.
 * Muted on purpose: the single warm accent stays reserved for flowers and the sun, so a flushing tree reads as a copper-olive crown among
 * green ones, never as an orange beacon.
 *   FLUSH_TINT  new flush: ~1 in 14 giants and talls
 *   GOLD_TINT   a dry, sun-bleached gold crown: ~1 in 30 trees
 */
export const FLUSH_TINT: readonly [number, number, number] = [1.35, 0.95, 0.65];
export const GOLD_TINT: readonly [number, number, number] = [1.28, 1.1, 0.62];

/** Surface roughness by material family (consistent across all assets). */
export const ROUGH = {
  foliage: 0.78,
  bark: 0.93,
  stone: 0.9,
  ruin: 0.88,
  ground: 1.0,
  relic: 0.6,
  water: 0.05,
} as const;

/**
 * LIGHT PRESETS. The whole light rig in one table: sun direction and colour, canopy-fill hemisphere, the baked IBL gradient, the sky dome and
 * exposure. `ACTIVE_LIGHT` picks the row; tools/generate-scene.mjs writes it into the scene file and every runtime consumer (light shafts,
 * baked AO bias, ShadowFollowSystem, the water bow) reads SUN_DIR, so flipping one name recovers the old look:
 *   golden  low warm sun (azimuth 160 deg = behind the player's right shoulder when facing the waterfall, elevation 30 deg), cool sky fill,
 *           warm ground bounce. Front-lights the cliff and the fall, long raking shadows up the trail.
 *   noon    the original high east-south-east sun with a teal-green fill (kept so the old look is one edit away).
 * `toSun` = direction FROM the ground TO the sun (unit-length not required). Sun azimuth: 0 = north (-Z), 90 = east (+X), 180 = south (+Z).
 */
export type LightPreset = {
  toSun: readonly [number, number, number];
  sunColor: readonly [number, number, number];
  sunIntensity: number;
  hemiSky: readonly [number, number, number];
  hemiGround: readonly [number, number, number];
  hemiIntensity: number;
  iblSky: readonly [number, number, number];
  iblEquator: readonly [number, number, number];
  iblGround: readonly [number, number, number];
  iblIntensity: number;
  domeSky: readonly [number, number, number];
  domeEquator: readonly [number, number, number];
  domeGround: readonly [number, number, number];
  /** Azimuth of the dome's sky pole (node Y-rotation convention: 0 = -Z, 90 = -X, -90 = +X). The runtime AtmosphereSystem owns the dome's elevation. */
  domeAzimuthDeg: number;
  exposure: number;
};

/** Direction to the sun from azimuth/elevation (degrees): 160 puts the sun south-south-east, i.e. behind the right shoulder of a player who faces north. */
function sunFrom(azDeg: number, elDeg: number): [number, number, number] {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
}

export const LIGHT_PRESETS = {
  golden: {
    toSun: sunFrom(160, 30), // (0.296, 0.5, 0.814)
    sunColor: [1, 0.8, 0.55],
    sunIntensity: 3.5,
    hemiSky: [0.4, 0.62, 0.76],
    hemiGround: [0.3, 0.24, 0.12],
    hemiIntensity: 1.2,
    iblSky: [0.34, 0.5, 0.66],
    iblEquator: [0.46, 0.42, 0.32],
    iblGround: [0.1, 0.13, 0.07],
    iblIntensity: 0.76,
    domeSky: [0.22, 0.46, 0.84],
    domeEquator: [0.74, 0.79, 0.72],
    domeGround: [0.17, 0.23, 0.15],
    domeAzimuthDeg: -100,
    exposure: 1.05,
  },
  noon: {
    toSun: [0.55, 0.68, 0.28],
    sunColor: [1, 0.9, 0.72],
    sunIntensity: 3.1,
    hemiSky: [0.5, 0.72, 0.62],
    hemiGround: [0.17, 0.2, 0.1],
    hemiIntensity: 1.25,
    iblSky: [0.36, 0.52, 0.5],
    iblEquator: [0.36, 0.46, 0.36],
    iblGround: [0.1, 0.13, 0.07],
    iblIntensity: 0.72,
    domeSky: [0.3, 0.55, 0.58],
    domeEquator: [0.66, 0.77, 0.7],
    domeGround: [0.12, 0.17, 0.1],
    domeAzimuthDeg: 110,
    exposure: 1.05,
  },
} as const satisfies Record<string, LightPreset>;

/** The row of LIGHT_PRESETS in use. */
export const ACTIVE_LIGHT: keyof typeof LIGHT_PRESETS = 'golden';
/** The active light rig (sun colour/intensity, fill, IBL, dome, exposure): read by tools/generate-scene.mjs. */
export const LIGHT: LightPreset = LIGHT_PRESETS[ACTIVE_LIGHT];

/**
 * Direction the sunlight TRAVELS (unit vector) = -toSun of the active preset. Golden hour: the sun is low (30 deg) in the south-south-east,
 * behind the player's right shoulder when facing the waterfall, so everything the player looks at is front-lit and shadows run away up the trail.
 * The sun node, the light shafts, the baked AO bias, ShadowFollowSystem and the spray bow all derive from this single constant.
 */
export const SUN_DIR: readonly [number, number, number] = (() => {
  const v = LIGHT.toSun;
  const l = Math.hypot(v[0], v[1], v[2]);
  return [-v[0] / l, -v[1] / l, -v[2] / l] as const;
})();

/** Unit vector from the ground TO the sun (= -SUN_DIR). */
export const SUN_TO: readonly [number, number, number] = [-SUN_DIR[0], -SUN_DIR[1], -SUN_DIR[2]];
/** Sun elevation above the horizon (degrees). */
export const SUN_ELEVATION_DEG = (Math.asin(SUN_TO[1]) * 180) / Math.PI;
/** Sun colour (linear-ish rgb 0..1): the warm accent for glow, shafts and haze that want to match the sun. */
export const SUN_COLOR: readonly [number, number, number] = LIGHT.sunColor;

/** Scene fog / horizon tint (hex). The scene generator writes it into the environment; ridges fade to it. */
export const FOG_COLOR = '#a9c4b3';

/**
 * MEADOW: the sunlit upland meadow on Overlook Knoll (terrain splat, wind-swept tufts, wildflower drifts, sandstone monoliths).
 * Kept apart from PAL so the jungle's palette is untouched. Greens lean fresh (blue-ish) because the golden light adds the warmth;
 * flowers are cool and pale on purpose: the single warm accent (`PAL.accent`) shows up in only a few of them.
 */
export const MEADOW = {
  // grass: base shade -> sunlit tip, fresh and curing
  base: '#3d5f26',
  lush: '#6fa23a',
  lushTip: '#9cc454',
  gold: '#b4a04c',
  goldTip: '#d9c777',
  straw: '#cdbb78',
  // stone and sandstone (warm, bleached by sun; the jungle's stone stays cool grey)
  bleach: '#bdb7a3',
  sandstone: '#b79f74',
  sandstoneDark: '#7d6a4b',
  sandstonePale: '#d3c298',
  ironStain: '#9c6a46',
  lichen: '#b4b98e',
  lichenDark: '#7d8a58',
  // wildflowers
  stem: '#5b7e36',
  bloomWhite: '#f1ede0',
  bloomEye: '#e6bf45',
  bloomBlue: '#8ea4dc',
  bloomViolet: '#a58bd0',
  bloomYellow: '#ecdc7a',
  bloomPink: '#e3b9cf',
} as const;

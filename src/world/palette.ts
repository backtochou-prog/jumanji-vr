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
 * Direction the sunlight TRAVELS (unit vector). The sun sits high in the
 * east-south-east, so it grazes the trail from the right: faces the player
 * sees are lit, shadows fall left. The sun node, the light shafts, the baked
 * AO bias and the cliff shading all derive from this single constant.
 */
export const SUN_DIR: readonly [number, number, number] = (() => {
  const v = [-0.55, -0.68, -0.28];
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l] as const;
})();

/** Scene fog / horizon tint (hex). The scene generator writes it into the environment; ridges fade to it. */
export const FOG_COLOR = '#a9c4b3';

/**
 * The weather of a still, humid afternoon: one tiny deterministic simulation that everything "alive" reads, so the wind you hear is the wind that
 * moves the plants, shakes leaves loose and carries the dust.
 *
 *   gust     0..1   how hard it is blowing right now. Long calm stretches, a gust every 12-40 s that rises over a few seconds and dies away slowly.
 *   wind     0.55..1.5  multiplier for the plant-sway shaders (1 = the authored motion), derived from `gust`.
 *   light    0.93..1.04  multiplier for the sun: thin cloud drifting over. Changes by well under 1 % per second - never a flicker, never dark.
 *   thunder  a far-off roll every 2.5-6 minutes (never in the first minute). No flash and no darkening: it is beyond the mountains. A gust follows it.
 *
 * Pure and DOM-free (unit-tested in node); the consumer steps it once per frame and reads the fields. `thunderPending` is a one-shot the consumer clears.
 */
import { makeRandom } from './math.js';

export const WEATHER_LIMITS = { lightMin: 0.93, lightMax: 1.04, windMin: 0.55, windMax: 1.5, thunderMin: 150, thunderMax: 360, lightRatePerSec: 0.008 } as const;

export class Weather {
  time = 0;
  gust = 0.2;
  wind = 1;
  light = 1;
  /** Unit direction the wind blows TOWARD (the same axis the foliage shaders use). */
  readonly dirX = 0.83;
  readonly dirZ = 0.56;
  /** Set when a thunder roll starts; the consumer plays it and clears the flag. */
  thunderPending = false;
  /** Bearing (radians, world) the roll comes from, and its loudness 0..1. */
  thunderBearing = 0;
  thunderGain = 0;
  thunderCount = 0;
  private rng: () => number;
  private gustTarget = 0.2;
  private nextGust: number;
  private gustHold = 0;
  private nextThunder: number;
  private lightTarget = 1;
  private nextLight = 0;

  constructor(seed = 4099) {
    this.rng = makeRandom(seed);
    this.nextGust = 6 + this.rng() * 10;
    this.nextThunder = 95 + this.rng() * 120;
  }

  step(dt: number): void {
    const r = this.rng;
    this.time += dt;
    // gusts: target jumps up, is held briefly, then relaxes to a calm base; the value chases the target fast on the way up, slowly down
    if (this.time >= this.nextGust) {
      this.gustTarget = 0.5 + r() * 0.5;
      this.gustHold = this.time + 2.5 + r() * 4;
      this.nextGust = this.time + 12 + r() * 28;
    } else if (this.time >= this.gustHold) this.gustTarget = 0.1 + 0.12 * Math.sin(this.time * 0.07) + 0.06;
    const up = this.gustTarget > this.gust;
    this.gust += (this.gustTarget - this.gust) * Math.min(1, dt * (up ? 0.55 : 0.2));
    this.gust = Math.min(1, Math.max(0, this.gust));
    this.wind = WEATHER_LIMITS.windMin + (WEATHER_LIMITS.windMax - WEATHER_LIMITS.windMin) * this.gust;

    // thunder: rare, soft, followed a few seconds later by a strong gust (the edge of far-off rain)
    if (this.time >= this.nextThunder) {
      this.nextThunder = this.time + WEATHER_LIMITS.thunderMin + r() * (WEATHER_LIMITS.thunderMax - WEATHER_LIMITS.thunderMin);
      this.thunderPending = true;
      this.thunderBearing = r() * Math.PI * 2;
      this.thunderGain = 0.55 + r() * 0.45;
      this.thunderCount++;
      this.nextGust = Math.min(this.nextGust, this.time + 4 + r() * 3);
      this.lightTarget = WEATHER_LIMITS.lightMin + 0.01;
      this.nextLight = this.time + 25;
    }

    // light: a new target every 20-50 s, approached at a strictly limited rate
    if (this.time >= this.nextLight) {
      this.lightTarget = 0.95 + r() * 0.085;
      this.nextLight = this.time + 20 + r() * 30;
    }
    const maxStep = WEATHER_LIMITS.lightRatePerSec * dt;
    this.light += Math.min(maxStep, Math.max(-maxStep, this.lightTarget - this.light));
    this.light = Math.min(WEATHER_LIMITS.lightMax, Math.max(WEATHER_LIMITS.lightMin, this.light));
  }
}

/** The one weather of the one world. */
export const weather = new Weather();

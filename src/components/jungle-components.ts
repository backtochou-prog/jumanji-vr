/**
 * Component declarations for the jungle experience.
 * System-free on purpose: the scene editor imports this module too.
 */
import { createComponent, Types } from '@iwsdk/core';

export const RelicState = { Resting: 'resting', Held: 'held', Falling: 'falling' } as const;

/**
 * The Heartstone. `restOffset` is the distance from the object origin to its
 * underside, so it can settle onto the altar or the ground without floating.
 */
export const Relic = createComponent('Relic', {
  state: { type: Types.Enum, default: RelicState.Resting, enum: RelicState },
  restOffset: { type: Types.Float32, default: 0.03, min: 0, step: 0.005, help: 'Origin-to-underside distance in metres' },
  velocityY: { type: Types.Float32, default: 0 },
  glow: { type: Types.Float32, default: 0, help: 'Current glow boost 0..1 (animated)' },
});

/** Scrolls the diffuse/emissive texture of every mesh under the entity (water). */
export const ScrollTexture = createComponent('ScrollTexture', {
  speedU: { type: Types.Float32, default: 0, step: 0.01 },
  speedV: { type: Types.Float32, default: 0.1, step: 0.01 },
});

/** Slow brightness breathing for additive light shafts. */
export const Shimmer = createComponent('Shimmer', {
  speed: { type: Types.Float32, default: 0.35 },
  amount: { type: Types.Float32, default: 0.18 },
});

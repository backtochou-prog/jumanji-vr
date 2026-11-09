import type { World } from '@iwsdk/core';

type Actuator = { pulse?: (v: number, ms: number) => unknown };
type Pad = { hapticActuators?: Actuator[]; vibrationActuator?: { playEffect?: (t: string, o: object) => unknown } };

/** Controller haptics if the browser exposes an actuator (unsupported: silently nothing). `both` pulses both hands. */
export function pulse(world: World, hand: 'left' | 'right' | 'both', intensity: number, ms: number): void {
  const hands = hand === 'both' ? (['left', 'right'] as const) : ([hand] as const);
  for (const h of hands) {
    const pad = world.input?.xr?.gamepads?.[h]?.gamepad as unknown as Pad | undefined;
    if (!pad) continue;
    if (pad.hapticActuators?.[0]?.pulse) pad.hapticActuators[0].pulse(Math.min(1, intensity), ms);
    else pad.vibrationActuator?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: Math.min(1, intensity), weakMagnitude: Math.min(1, intensity) * 0.8 });
  }
}

import { createSystem, VisibilityState } from '@iwsdk/core';
import { metrics } from '../diagnostics/frame-metrics.js';
import { perfTest } from '../diagnostics/perf-test.js';
import { applyTier, loadTier, setShadows, warmShaders } from '../settings/quality.js';
import type { QualityTier } from '../settings/quality.js';

export type GovernorState = 'disabled' | 'idle' | 'warming' | 'watching' | 'step 1 (shadows off)' | 'step 2 (low tier)' | 'paused (test mode)' | 'paused (system menu)';

/** Read by the overlay and the test results. */
export const governorInfo = { state: 'idle' as GovernorState, step: 0, budgetMs: 1000 / 72, lastReason: '', lastWindow: { meanMs: 0, missed: 0 } };

const WARMUP_MS = 8000; // after entering VR: shader compiles, texture uploads, level streaming settle
const SETTLE_MS = 3000; // after a step: let the new tier produce clean frames before judging again
const WINDOW_MS = 3000;
const MEAN_FACTOR = 1.12; // mean frame time above 112 % of the display period ...
const MISSED_LIMIT = 0.1; // ... or more than 10 % of frames missing a vsync (> 1.5 periods)
const CONSECUTIVE = 2; // ... in two windows in a row (6 s) before acting

/**
 * Adaptive fallback for the Quest 2 (we have not measured the device yet).
 *
 * Inside an immersive session it judges the REAL frame period (diagnostics/frame-metrics)
 * against the display period reported by the XR session (72 Hz default, 1000/72 = 13.9 ms;
 * the old fixed 15.5 ms is 112 % of that). It acts only when frames are slow in two
 * consecutive 3 s windows, never during the 8 s warm-up, never while the system menu
 * blurs the view, and never during a headset test. It steps down once per decision and
 * never back up (no oscillation):
 *   step 1  real-time shadows off  (caster switch: no shader recompile)
 *   step 2  'low' tier             (optional dressing hidden, vegetation distances x0.72)
 * Disable with ?governor=0 or VITE_JUMANJI_GOVERNOR=0.
 */
export class QualityGovernor extends createSystem({}) {
  private enabled = true;
  private immersiveSince = 0;
  private warmUntil = 0;
  private windowStart = 0;
  private consecutive = 0;
  private step = 0;
  /** Tier chosen by the player; the governor never overrides a deliberate 'low'. */
  tier: QualityTier = 'high';

  init(): void {
    const q = new URLSearchParams(globalThis.location?.search ?? '').get('governor');
    this.enabled = q !== '0' && import.meta.env.VITE_JUMANJI_GOVERNOR !== '0';
    this.tier = loadTier();
    governorInfo.state = this.enabled ? 'idle' : 'disabled';
  }

  /** Board toggle back to 'high' forgives previous steps. */
  reset(): void {
    this.step = 0;
    this.consecutive = 0;
    governorInfo.step = 0;
    this.warmUntil = performance.now() + SETTLE_MS;
  }

  update(): void {
    if (!this.enabled) return;
    const vis = this.world.visibilityState.peek();
    const now = performance.now();
    governorInfo.budgetMs = metrics.periodMs;
    if (perfTest.blocksGovernor) {
      governorInfo.state = 'paused (test mode)';
      this.immersiveSince = 0;
      return;
    }
    if (vis !== VisibilityState.Visible) {
      governorInfo.state = vis === VisibilityState.VisibleBlurred ? 'paused (system menu)' : 'idle';
      this.immersiveSince = 0;
      this.windowStart = 0;
      this.consecutive = 0;
      return;
    }
    if (!this.immersiveSince) {
      this.immersiveSince = now;
      this.warmUntil = now + WARMUP_MS;
      this.windowStart = this.warmUntil;
      metrics.reset();
      warmShaders(this.world);
    }
    if (now < this.warmUntil) {
      governorInfo.state = 'warming';
      return;
    }
    if (this.step >= 2) return;
    governorInfo.state = this.step === 0 ? 'watching' : this.step === 1 ? 'step 1 (shadows off)' : 'step 2 (low tier)';
    if (now - this.windowStart < WINDOW_MS) return;
    this.windowStart = now;
    const s = metrics.summary(WINDOW_MS);
    // A window with very few frames IS the problem (e.g. 3 fps), so judge it; only skip an empty one.
    if (s.frames < 3) return;
    governorInfo.lastWindow = { meanMs: s.meanMs, missed: s.missed };
    const bad = s.meanMs > governorInfo.budgetMs * MEAN_FACTOR || s.missed > MISSED_LIMIT;
    this.consecutive = bad ? this.consecutive + 1 : 0;
    if (this.consecutive < CONSECUTIVE) return;
    this.consecutive = 0;
    this.step++;
    governorInfo.step = this.step;
    if (this.step === 1) setShadows(this.world, false);
    else applyTier(this.world, 'low', false);
    governorInfo.state = this.step === 1 ? 'step 1 (shadows off)' : 'step 2 (low tier)';
    governorInfo.lastReason = `mean ${s.meanMs.toFixed(1)} ms / ${(s.missed * 100).toFixed(0)} % missed vs ${governorInfo.budgetMs.toFixed(1)} ms budget`;
    this.warmUntil = now + SETTLE_MS;
    this.windowStart = this.warmUntil;
    metrics.reset();
    console.warn(`[jumanji:governor] ${governorInfo.lastReason}: step ${this.step} (${this.step === 1 ? 'shadows off' : 'low tier'})`);
  }
}

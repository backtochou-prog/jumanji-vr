import { createSystem, LocomotionSystem, Vector3, VisibilityState } from '@iwsdk/core';
import { perfTest } from '../diagnostics/perf-test.js';
import { audioInfo } from '../audio/ambient-audio.js';
import { loadComfort } from '../settings/comfort.js';
import { SPAWN, VISTA, smoothstep, terrainHeight } from '../world/layout.js';
import { wctx } from '../wildlife/context.js';
import { WildlifeSystem } from '../wildlife/wildlife-system.js';
import { atmosphere } from './atmosphere-system.js';

/**
 * The opening reveal on Overlook Knoll. The player arrives inside a pearly valley mist; the waterfall is only a sound. Within a few seconds the mist lifts
 * (about 20 s, slow and calm), the cliff and the fall emerge from it, a macaw calls from the fall's side, and a pair of macaws crosses the sky in front of the fall.
 *
 *   t = 0      fog "veil" 1 (the atmosphere thickens its density by 1 + 0.55 * veil), the fall is half as loud
 *   t = 2 s    the fall's level rises to normal (long time constant): you hear it before you see it
 *   t = 3.5 s  the earliest the mist may lift; it lifts once the player has looked toward the fall for 1 s, or at 9 s whatever they look at
 *   t = 6 s    one macaw call, 25 m ahead and 35 degrees to the right of the fall's bearing
 *   lift       the veil eases 1 -> 0 over 20 s (smoothstep) and the fall swells to 1.35x at the midpoint, back to normal at the end
 *   t >= 10 s  (after the lift began and the player looks that way, or at 14 s) the staged macaw crossing (Birds, via wctx.intro)
 *
 * Nothing moves the player or the camera. The veil is only a fog-density multiplier (a number the AtmosphereSystem already folds into its 4 Hz fog write): no
 * extra draw, no material, no per-frame scene write from here.
 *
 * Off (veil stays 0, nothing is touched) when: `?reveal=0`, reduced motion (setting or `?reduced=1`), any URL that places the player or runs a measurement
 * (`?area=`, `?start=`, `?yaw=`, `?test=`, `?desktop=1`, `?governor=`; force with `?reveal=1`, except for reduced motion), or wildlife is off for the macaw part.
 * Ends early (the veil fades in 1.5 s) when the player walks more than 10 m from the start or a perf test starts, or snaps if reduced motion is switched on.
 * The reveal replays once from the start when the VR session begins (the headset page is usually opened long before the player puts the headset on).
 * Sound off: the fall level and the cue are simply inaudible (the audio engine honours the setting); nothing else changes.
 *
 * The game now starts on Everest's summit (world/everest.ts), 600 m of trail above the knoll. Then the reveal is only ARMED: nothing is veiled up there;
 * the valley mist gathers over the last 50 m of the walk down, and the reveal plays, exactly as above, the first time the player steps onto the knoll.
 */

type Veiled = typeof atmosphere & { veil?: number };

/** Foot of the backdrop waterfall: the bearing the reveal is staged toward (CLIFF at x 5, z -96; the fall base is at about (4.4, -92)). */
const FALL = VISTA.fallFoot;

const MIST_MIN = 3.5; // s: the earliest lift
const MIST_MAX = 9; // s: the lift starts by now whatever the gaze
const GAZE_HOLD = 1.0; // s of looking toward the fall
const GAZE_YAW = (20 * Math.PI) / 180;
const GAZE_PITCH = (25 * Math.PI) / 180;
const LIFT_S = 20;
const CUE_AT = 6;
const CUE_GIVE_UP = 16;
const CROSS_AT = 10;
const CROSS_LATEST = 14;
const CROSS_GIVE_UP = 17;
const WALK_AWAY = 10; // m from the start point
const ARRIVE = 8; // m from the knoll's viewpoint: an armed reveal starts here
const MIST_FROM = 60; // m: where the valley mist begins to gather on the way down
const FADE_OUT_S = 1.5;

/** Read-only state for tests and the diagnostics. */
export const introState = {
  /** 'off' = disabled for this page, 'waiting' = scene not ready / not started, 'armed' = started on Everest: plays on arrival at the knoll, 'running', 'done'. */
  phase: 'off' as 'off' | 'waiting' | 'armed' | 'running' | 'done',
  t: 0,
  liftStart: -1,
  gaze: 0,
  cueDone: false,
  crossAsked: false,
};

export function introWanted(): boolean {
  const q = new URLSearchParams(globalThis.location?.search ?? '');
  if (q.get('reveal') === '0') return false;
  if (loadComfort().reducedMotion) return false;
  if (q.get('reveal') === '1') return true;
  for (const k of ['area', 'start', 'yaw', 'test', 'desktop', 'governor']) if (q.has(k)) return false;
  return true;
}

export class IntroSystem extends createSystem({}) {
  private readonly head = new Vector3();
  private readonly dir = new Vector3();
  private readonly player3 = new Vector3();
  private frames = 0;
  private veil = 0;
  private written = -1;
  private fading = 0; // >0: the early-end fade is running, value = veil when it began
  private fadeT = 0;
  private replayed = false;
  private wasImmersive = false;
  private nextReduced = 0;

  init(): void {
    if (!introWanted()) return;
    // the normal start is Everest's summit: the reveal waits for the player on the knoll (a URL that starts on the knoll, `?reveal=1&area=entrance`, plays it at once)
    const q = new URLSearchParams(globalThis.location?.search ?? '');
    if (!q.has('area') && !q.has('start')) {
      introState.phase = 'armed';
      return;
    }
    introState.phase = 'waiting';
    // The veil is set right now (before the first frame of any system) so the very first rendered frame is already inside the mist.
    this.writeVeil(1);
    wctx.intro = 'hold';
  }

  private writeVeil(v: number): void {
    this.veil = v;
    if (Math.abs(v - this.written) < 0.002 && v !== 0 && v !== 1) return;
    this.written = v;
    (atmosphere as Veiled).veil = v;
  }

  private audio() {
    return this.world.getSystem(WildlifeSystem)?.audio ?? null;
  }

  private restart(): void {
    introState.phase = 'running';
    introState.t = 0;
    introState.liftStart = -1;
    introState.gaze = 0;
    introState.cueDone = false;
    introState.crossAsked = false;
    this.fading = 0;
    this.writeVeil(1);
    wctx.intro = wctx.enabled ? 'hold' : 'done';
    this.audio()?.setFallLevel(0.5, 0.5);
  }

  /** Stop the reveal: the veil goes to 0 (fading, or at once), the fall returns to normal, the bird schedule resumes. */
  private finish(snap: boolean): void {
    this.audio()?.setFallLevel(1, 2);
    if (wctx.intro === 'hold' || wctx.intro === 'cross') wctx.intro = 'done';
    if (snap || this.veil <= 0.001) {
      this.writeVeil(0);
      introState.phase = 'done';
    } else {
      this.fading = this.veil;
      this.fadeT = 0;
    }
  }

  update(delta: number): void {
    const phase = introState.phase;
    if (phase === 'off') return;

    // the VR session begins: play the reveal from the start once (the player has only now put the headset on). Tracked in every phase but 'off' (the
    // reveal is usually over by then: the page sits open in the 2D window first); 'waiting' starts from now anyway.
    const immersive = this.world.visibilityState.peek() === VisibilityState.Visible;
    if (immersive && !this.wasImmersive && !this.replayed && phase !== 'waiting' && phase !== 'armed') {
      this.player.getWorldPosition(this.player3);
      const near = Math.hypot(this.player3.x - SPAWN[0], this.player3.z - SPAWN[1]) <= WALK_AWAY;
      if (near && introWanted() && (perfTest.state === 'idle' || perfTest.state === 'done')) {
        this.replayed = true;
        this.restart();
      }
    }
    this.wasImmersive = immersive;
    if (introState.phase === 'done') return;

    // armed: the mist gathers as the knoll comes near; the reveal starts on arrival
    if (phase === 'armed') {
      const nowS = performance.now() / 1000;
      let cancel = perfTest.state !== 'idle' && perfTest.state !== 'done';
      if (nowS >= this.nextReduced) {
        this.nextReduced = nowS + 1;
        cancel ||= loadComfort().reducedMotion;
      }
      if (cancel) {
        this.writeVeil(0);
        introState.phase = 'done';
        return;
      }
      this.player.getWorldPosition(this.player3);
      const d = Math.hypot(this.player3.x - SPAWN[0], this.player3.z - SPAWN[1]);
      if (d > ARRIVE) return this.writeVeil(1 - smoothstep(ARRIVE + 4, MIST_FROM, d));
      this.replayed = true; // (this IS the first look at the valley, headset on or not)
      this.restart();
    }

    // an early-end fade in progress
    if (this.fading > 0) {
      this.fadeT += Math.min(delta, 0.1);
      const k = Math.min(1, this.fadeT / FADE_OUT_S);
      this.writeVeil(this.fading * (1 - k * k * (3 - 2 * k)));
      if (k >= 1) {
        this.writeVeil(0);
        this.fading = 0;
        introState.phase = 'done';
      }
      return;
    }

    // wait for the level and locomotion; skip the first frames (shader warm-up hitches would eat the timeline)
    if (phase === 'waiting') {
      if (this.world.scene.children.length > 4 && this.world.getSystem(LocomotionSystem) && this.world.getSystem(WildlifeSystem)) this.frames++;
      if (this.frames < 20) return;
      this.restart();
    }

    // a measurement started, or reduced motion was switched on
    if (perfTest.state !== 'idle' && perfTest.state !== 'done') return this.finish(true);
    const nowS = performance.now() / 1000;
    if (nowS >= this.nextReduced) {
      this.nextReduced = nowS + 1;
      if (loadComfort().reducedMotion) return this.finish(true);
    }

    const dt = Math.min(delta, 0.05);
    const st = introState;
    st.t += dt;
    const t = st.t;

    // head pose
    this.world.camera.getWorldPosition(this.head);
    this.world.camera.getWorldDirection(this.dir);
    this.player.getWorldPosition(this.player3);
    if (Math.hypot(this.player3.x - SPAWN[0], this.player3.z - SPAWN[1]) > WALK_AWAY) return this.finish(false);

    const bx = FALL[0] - this.head.x;
    const bz = FALL[1] - this.head.z;
    const bearing = Math.atan2(bx, -bz); // 0 = toward -Z, + = right (matches yaw = atan2(-fx, -fz) negated)
    const look = Math.atan2(this.dir.x, -this.dir.z);
    let dy = look - bearing;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    const gazing = Math.abs(dy) < GAZE_YAW && Math.abs(Math.asin(Math.max(-1, Math.min(1, this.dir.y)))) < GAZE_PITCH;
    st.gaze = gazing ? st.gaze + dt : Math.max(0, st.gaze - dt);

    // ---- the lift
    if (st.liftStart < 0 && t >= MIST_MIN && (st.gaze >= GAZE_HOLD || t >= MIST_MAX)) st.liftStart = t;
    const p = st.liftStart < 0 ? 0 : Math.min(1, (t - st.liftStart) / LIFT_S);
    this.writeVeil(1 - smoothstep(0, 1, p));

    // ---- the fall's level: half-heard in the mist, up at 2 s, a crest while the mist lifts
    const bed = t < 2 ? 0.5 : 0.5 + 0.5 * (1 - Math.exp(-(t - 2) / 3));
    const swell = st.liftStart < 0 || p >= 1 ? 0 : 0.35 * Math.sin(Math.PI * p);
    this.audio()?.setFallLevel(bed + swell, 1.6);

    // ---- the macaw call from the fall's side (retried until the audio engine can play it)
    if (!st.cueDone && t >= CUE_AT) {
      if (!audioInfo.enabled || t > CUE_GIVE_UP) st.cueDone = true;
      else if (Math.floor(t * 2) !== Math.floor((t - dt) * 2)) {
        const a = Math.atan2(FALL[0] - this.head.x, -(FALL[1] - this.head.z)) + (35 * Math.PI) / 180;
        const cx = this.head.x + Math.sin(a) * 25;
        const cz = this.head.z - Math.cos(a) * 25;
        if (this.audio()?.introCue(cx, terrainHeight(cx, cz) + 11, cz)) st.cueDone = true;
      }
    }

    // ---- the staged crossing (Birds does the flying)
    if (!st.crossAsked && wctx.intro === 'hold' && st.liftStart >= 0 && t >= CROSS_AT && (gazing || t >= CROSS_LATEST)) {
      st.crossAsked = true;
      wctx.intro = 'cross';
    }
    if (wctx.intro === 'cross' && t >= CROSS_GIVE_UP) wctx.intro = 'done';
    if (!wctx.enabled && wctx.intro === 'hold') wctx.intro = 'done';

    // ---- finished
    if (p >= 1 && st.cueDone && wctx.intro !== 'cross' && wctx.intro !== 'hold') {
      this.audio()?.setFallLevel(1, 3);
      this.writeVeil(0);
      st.phase = 'done';
    }
  }
}

import { createSystem, LocomotionSystem, SlideSystem, TurnSystem, TurningMethod, UIKitMLAsset, VisibilityState } from '@iwsdk/core';
import type * as UIKit from '@pmndrs/uikit';
import { cycle, loadComfort, saveComfort, SNAP_ANGLES, VIGNETTE_LEVELS, WALK_SPEEDS } from './settings/comfort.js';
import type { ComfortSettings } from './settings/comfort.js';
import { copyLastResult, startPerfTest } from './diagnostics/perf-test.js';
import { perfOverlay } from './diagnostics/perf-overlay.js';
import { applyTier, loadTier, saveTier } from './settings/quality.js';
import type { QualityTier } from './settings/quality.js';
import { QualityGovernor } from './systems/quality-governor.js';
import { WildlifeSystem } from './wildlife/wildlife-system.js';
import { wctx } from './wildlife/context.js';
import { audioInfo } from './audio/ambient-audio.js';
import { detectXR, grantedFeatures } from './xr/capabilities.js';

/**
 * Expedition board: live XR status, Enter/Exit VR, and the comfort toggles.
 * Comfort values are pushed into IWSDK's LocomotionSystem config (turning
 * method/angle, sliding speed, vignette strength) and persisted.
 */
export class PanelSystem extends createSystem({}) {
  private comfort: ComfortSettings = loadComfort();
  /** IWSDK creates its Turn/Slide systems asynchronously; settings are re-applied once they exist. */
  private comfortLive = false;
  private tier: QualityTier = loadTier();

  init(): void {
    this.applyComfort();
    const panel = this.world.getSceneObject<UIKitMLAsset>('welcome-panel');
    if (!panel) return;
    const el = <T extends UIKit.Component = UIKit.Text>(id: string) => panel.getElementById<T>(id) as T | undefined;
    const xrButton = el('xr-button');
    const exitButton = el('exit-button');
    const status = el<UIKit.Text>('status');
    const turnLabel = el<UIKit.Text>('turn-label');
    const speedLabel = el<UIKit.Text>('speed-label');
    const vignetteLabel = el<UIKit.Text>('vignette-label');
    const qualityLabel = el<UIKit.Text>('quality-label');
    const perfLabel = el<UIKit.Text>('perf-label');
    const moveLabel = el<UIKit.Text>('move-label');
    const reducedLabel = el<UIKit.Text>('reduced-label');
    const seatedLabel = el<UIKit.Text>('seated-label');
    const hazardLabel = el<UIKit.Text>('hazard-label');
    const copyLabel = el<UIKit.Text>('copy-label');
    const soundLabel = el<UIKit.Text>('sound-label');
    const wildlifeLabel = el<UIKit.Text>('wildlife-label');
    const moreSection = el('more-section');
    const moreLabel = el<UIKit.Text>('more-label');
    let moreOpen = false; // the welcome board starts calm: only the greeting, Enter VR and a More toggle

    const refreshLabels = () => {
      const c = this.comfort;
      turnLabel?.setProperties({ text: c.turnMode === 'snap' ? `Snap turn ${c.snapAngle} deg` : 'Smooth turn' });
      speedLabel?.setProperties({ text: `Speed ${c.walkSpeed} m/s` });
      moveLabel?.setProperties({ text: c.moveReference === 'hand' ? 'Move by hand' : 'Move by head' });
      reducedLabel?.setProperties({ text: c.reducedMotion ? 'Reduced motion on' : 'Reduced motion off' });
      seatedLabel?.setProperties({ text: c.seated ? 'Seated' : 'Standing' });
      hazardLabel?.setProperties({ text: c.hazardAssist ? 'Auto-slow on' : 'Auto-slow off' });
      perfLabel?.setProperties({ text: perfOverlay.enabled ? 'Diagnostics on' : 'Diagnostics off' });
      qualityLabel?.setProperties({ text: this.tier === 'high' ? 'Quality high' : 'Quality low (faster)' });
      soundLabel?.setProperties({ text: audioInfo.enabled ? 'Sound on' : 'Sound off' });
      wildlifeLabel?.setProperties({ text: wctx.enabled ? 'Wildlife on' : 'Wildlife off' });
      vignetteLabel?.setProperties({ text: c.vignette === 0 ? 'Vignette off' : `Vignette ${Math.round(c.vignette * 100)}%` });
    };
    refreshLabels();

    // Turn: snap 30 -> 45 -> 60 -> smooth -> snap 30 ...
    const onTurn = () => {
      const c = this.comfort;
      if (c.turnMode === 'smooth') {
        c.turnMode = 'snap';
        c.snapAngle = SNAP_ANGLES[0];
      } else if (c.snapAngle >= SNAP_ANGLES[SNAP_ANGLES.length - 1]) {
        c.turnMode = 'smooth';
      } else {
        c.snapAngle = cycle(SNAP_ANGLES, c.snapAngle);
      }
      this.changed(refreshLabels);
    };
    const onSpeed = () => {
      this.comfort.walkSpeed = cycle(WALK_SPEEDS, this.comfort.walkSpeed);
      this.changed(refreshLabels);
    };
    const onVignette = () => {
      this.comfort.vignette = cycle(VIGNETTE_LEVELS, this.comfort.vignette);
      this.changed(refreshLabels);
    };
    const onMove = () => {
      this.comfort.moveReference = this.comfort.moveReference === 'head' ? 'hand' : 'head';
      this.changed(refreshLabels);
    };
    const onReduced = () => {
      this.comfort.reducedMotion = !this.comfort.reducedMotion;
      if (this.comfort.reducedMotion && this.comfort.vignette < 0.5) this.comfort.vignette = 0.5;
      this.changed(refreshLabels);
    };
    const onHazard = () => {
      this.comfort.hazardAssist = !this.comfort.hazardAssist;
      this.changed(refreshLabels);
    };
    const onSeated = () => {
      this.comfort.seated = !this.comfort.seated;
      this.changed(refreshLabels);
    };
    const onQuality = () => {
      this.tier = this.tier === 'high' ? 'low' : 'high';
      saveTier(this.tier);
      const gov = this.world.getSystem(QualityGovernor);
      if (gov) {
        gov.tier = this.tier;
        if (this.tier === 'high') gov.reset();
      }
      applyTier(this.world, this.tier);
      refreshLabels();
    };
    const onSound = () => {
      // the click itself is the user gesture that lets the browser start audio
      this.world.getSystem(WildlifeSystem)?.audio.setEnabled(!audioInfo.enabled);
      refreshLabels();
    };
    const onWildlife = () => {
      this.world.getSystem(WildlifeSystem)?.setEnabled(!wctx.enabled);
      refreshLabels();
    };
    const onMore = () => {
      moreOpen = !moreOpen;
      moreSection?.setProperties({ display: moreOpen ? 'flex' : 'none' });
      moreLabel?.setProperties({ text: moreOpen ? 'Fewer options' : 'More options' });
    };
    const onPerf = () => {
      perfOverlay.set(!perfOverlay.enabled);
      refreshLabels();
    };
    const onCopy = () => {
      void copyLastResult().then((m) => copyLabel?.setProperties({ text: m.length > 22 ? 'Copied' : m }));
    };
    const testBtn = (id: 'entrance' | 'trail' | 'clearing') => () => {
      perfOverlay.set(true);
      refreshLabels();
      startPerfTest(this.world, id, { returnToStart: true });
    };
    for (const [id, fn] of [['more-button', onMore], ['perf-button', onPerf], ['copy-button', onCopy], ['test-entrance-button', testBtn('entrance')], ['test-trail-button', testBtn('trail')], ['test-clearing-button', testBtn('clearing')], ['turn-button', onTurn], ['speed-button', onSpeed], ['vignette-button', onVignette], ['move-button', onMove], ['reduced-button', onReduced], ['seated-button', onSeated], ['hazard-button', onHazard], ['quality-button', onQuality], ['sound-button', onSound], ['wildlife-button', onWildlife]] as const) {
      const b = el(id);
      b?.addEventListener('click', fn);
      this.cleanupFuncs.push(() => b?.removeEventListener('click', fn));
    }

    // Live capability report (never assume a Quest means WebXR works).
    void detectXR().then((r) => {
      status?.setProperties({ text: `${r.headline}. ${r.detail}` });
      console.info('[jumanji] XR report', r);
    });

    if (xrButton == null || exitButton == null) return;
    if (!this.world.xrEnabled) {
      xrButton.setProperties({ display: 'none' });
      exitButton.setProperties({ display: 'none' });
      return;
    }
    const launchXR = () => this.world.launchXR();
    const exitXR = () => this.world.exitXR();
    xrButton.addEventListener('click', launchXR);
    exitButton.addEventListener('click', exitXR);
    this.cleanupFuncs.push(
      () => xrButton.removeEventListener('click', launchXR),
      () => exitButton.removeEventListener('click', exitXR),
      this.world.visibilityState.subscribe((visibilityState) => {
        const is2D = visibilityState === VisibilityState.NonImmersive;
        xrButton.setProperties({ display: is2D ? 'flex' : 'none' });
        exitButton.setProperties({ display: is2D ? 'none' : 'flex' });
        if (!is2D) console.info('[jumanji] XR session features granted:', grantedFeatures(this.world.renderer.xr.getSession()));
      }),
    );
  }

  update(): void {
    if (this.comfortLive) return;
    if (this.world.getSystem(TurnSystem) && this.world.getSystem(SlideSystem)) {
      this.comfortLive = true;
      this.applyComfort();
    }
  }

  private changed(refresh: () => void): void {
    saveComfort(this.comfort);
    this.applyComfort();
    refresh();
  }

  private applyComfort(): void {
    const loco = this.world.getSystem(LocomotionSystem);
    if (!loco) return;
    const c = this.comfort;
    loco.config.turningMethod.value = c.turnMode === 'snap' ? TurningMethod.SnapTurn : TurningMethod.SmoothTurn;
    loco.config.turningAngle.value = c.snapAngle;
    loco.config.turningSpeed.value = c.smoothSpeed;
    loco.config.slidingSpeed.value = c.walkSpeed;
    loco.config.comfortAssist.value = c.vignette;
    // Also write straight to the live sub-systems (the LocomotionSystem forwards changes
    // only after its async start-up has wired them).
    const turn = this.world.getSystem(TurnSystem);
    if (turn) {
      turn.config.turningMethod.value = loco.config.turningMethod.value;
      turn.config.turningAngle.value = c.snapAngle;
      turn.config.turningSpeed.value = c.smoothSpeed;
    }
    const slide = this.world.getSystem(SlideSystem);
    if (slide) {
      slide.config.maxSpeed.value = c.walkSpeed;
      slide.config.comfortAssist.value = c.vignette;
    }
  }
}

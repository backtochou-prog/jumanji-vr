import { createSystem, LocomotionSystem, VisibilityState, Vector3, VERSION } from '@iwsdk/core';
import type { World } from '@iwsdk/core';
import { BUILD_TIMES } from '../assets.js';
import { governorInfo } from '../systems/quality-governor.js';
import { loadQuality, qualityState } from '../settings/quality.js';
import { SPAWN, TEST_POSES, areaAt, terrainHeight } from '../world/layout.js';
import type { TestId } from '../world/layout.js';
import { chunkStats } from '../systems/chunk-lod-system.js';
import { metrics } from './frame-metrics.js';
import { measureOverdraw } from './overdraw.js';

/**
 * Headset performance test: teleport to a fixed pose, WARM UP, then SAMPLE for a fixed window.
 *
 *   URL: ?test=entrance|trail|clearing   (+ &warmup=8 &sample=10 &governor=1 &desktop=1)
 *   Board: the three "Test" buttons (no reload needed in VR)
 *
 * In VR the test starts when the immersive session is running; with &desktop=1 it runs in the
 * flat browser (used by tools/perf-probe.mjs; results are labelled session:"desktop").
 * The governor is paused during a test unless &governor=1, so tier changes cannot contaminate the
 * sample. The result is: logged ([jumanji:perf-result]), shown on the wrist overlay, kept in
 * localStorage, POSTed to the dev server (perf-results/*.json on the PC) and copyable from the board.
 */
export interface PerfResult {
  schema: 1;
  id: TestId;
  label: string;
  timestamp: string;
  session: 'immersive-vr' | 'desktop';
  valid: boolean;
  notes: string[];
  warmupSeconds: number;
  sampleSeconds: number;
  frames: number;
  fps: number;
  frameMs: { mean: number; median: number; p95: number; p99: number; max: number };
  missedFramesPct: number;
  cpuMs: { update: number; render: number };
  gpuMs: { mean: number | null; p95: number | null; status: string };
  draws: { mean: number; max: number };
  triangles: { mean: number; max: number };
  vegetationCellsShown: { mean: number; total: number };
  quality: { tier: string; shadows: boolean; xrScale: number; foveation: number };
  governor: { state: string; step: number; lastReason: string; enabledDuringTest: boolean };
  display: { rateHz: number | null; supportedRatesHz: number[]; periodMs: number };
  player: { start: [number, number]; end: [number, number]; driftMeters: number; area: string };
  boot: { assetBuildMs: number; assetBuildGroups: Record<string, number>; pageLoadToTestMs: number };
  memory: { geometries: number; textures: number; programs: number; jsHeapMB: number | null };
  environment: { iwsdk: string; userAgent: string; emulated: boolean; xrFeatures: string[]; devicePixelRatio: number };
}

export const perfTest = {
  state: 'idle' as 'idle' | 'waiting for VR' | 'warm-up' | 'sampling' | 'done',
  id: null as TestId | null,
  secondsLeft: 0,
  warmupMs: 8000,
  sampleMs: 10000,
  governorOn: false,
  returnToStart: false,
  desktop: false,
  last: null as PerfResult | null,
  /** The governor stays out of the way for the whole test. */
  get blocksGovernor(): boolean {
    return this.state !== 'idle' && this.state !== 'done' && !this.governorOn;
  },
  status: '',
};

const STORE = 'jumanji-vr.perf.results.v1';

/** Teleport the rig to a pose and face it. */
export function placePlayer(world: World, x: number, z: number, yawDeg: number): void {
  const p = new Vector3(x, terrainHeight(x, z), z);
  world.getSystem(LocomotionSystem)?.setPlayerPosition(p);
  world.player.rotation.set(0, (yawDeg * Math.PI) / 180, 0);
}

export function startPerfTest(world: World, id: TestId, opts: { warmupMs?: number; sampleMs?: number; governor?: boolean; returnToStart?: boolean; desktop?: boolean } = {}): void {
  perfTest.id = id;
  perfTest.warmupMs = opts.warmupMs ?? 8000;
  perfTest.sampleMs = opts.sampleMs ?? 10000;
  perfTest.governorOn = opts.governor ?? false;
  perfTest.returnToStart = opts.returnToStart ?? false;
  perfTest.desktop = opts.desktop ?? false;
  const immersive = world.visibilityState.peek() === VisibilityState.Visible;
  perfTest.state = immersive || perfTest.desktop ? 'warm-up' : 'waiting for VR';
  perfTest.status = perfTest.state === 'waiting for VR' ? 'Press Enter VR to start the test' : '';
  internal.begin = 0;
  console.info(`[jumanji:perf] test "${id}" requested (${perfTest.state})`);
}

/** Copy the last result (clipboard), else download it as a file. Needs a user gesture in most browsers. */
export async function copyLastResult(): Promise<string> {
  const r = perfTest.last ?? loadStored().slice(-1)[0];
  if (!r) return 'no result yet';
  const text = JSON.stringify(r, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    return 'copied to clipboard';
  } catch {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = `jumanji-perf-${r.id}-${r.timestamp.replace(/[:.]/g, '-')}.json`;
    a.click();
    return 'downloaded as a file';
  }
}

function loadStored(): PerfResult[] {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? '[]') as PerfResult[];
  } catch {
    return [];
  }
}

const internal = { begin: 0, sampleStart: 0, start: [0, 0] as [number, number], pageReady: 0 };
const pos = new Vector3();

export class PerfTestSystem extends createSystem({}) {
  private urlHandled = false;
  private hzApplied = false;

  init(): void {
    internal.pageReady = performance.now();
    (window as unknown as { __jumanjiPerf?: unknown }).__jumanjiPerf = {
      metrics,
      perfTest,
      stored: loadStored,
      copy: copyLastResult,
      start: (id: TestId, o?: object) => startPerfTest(this.world, id, o),
      overdraw: (h?: number) => measureOverdraw(this.world, h),
      world: this.world,
    };
  }

  update(): void {
    // Optional display-rate request: ?hz=90 (the Quest 2 browser exposes 72/80/90/120; default stays at the platform's 72).
    if (!this.hzApplied && this.world.visibilityState.peek() === VisibilityState.Visible) {
      this.hzApplied = true;
      const hz = Number(new URLSearchParams(globalThis.location?.search ?? '').get('hz'));
      const s = this.world.renderer.xr.getSession?.() as (XRSession & { updateTargetFrameRate?: (r: number) => Promise<void> }) | null;
      if (hz && s?.updateTargetFrameRate) {
        s.updateTargetFrameRate(hz).then(
          () => console.info(`[jumanji] display rate requested: ${hz} Hz (session reports ${s.frameRate ?? 'n/a'})`),
          (e: Error) => console.warn(`[jumanji] display rate ${hz} Hz refused: ${e.message}`),
        );
      }
    }
    if (this.world.visibilityState.peek() !== VisibilityState.Visible) this.hzApplied = false;
    // URL trigger, once the level (and so locomotion) exists.
    if (!this.urlHandled && this.world.getSystem(LocomotionSystem)) {
      this.urlHandled = true;
      const q = new URLSearchParams(globalThis.location?.search ?? '');
      const id = q.get('test') as TestId | null;
      if (id && TEST_POSES[id]) {
        startPerfTest(this.world, id, {
          warmupMs: Number(q.get('warmup') ?? 8) * 1000,
          sampleMs: Number(q.get('sample') ?? 10) * 1000,
          governor: q.get('governor') === '1',
          desktop: q.get('desktop') === '1',
        });
      }
    }
    if (perfTest.state === 'idle' || perfTest.state === 'done' || !perfTest.id) return;
    const now = performance.now();
    const immersive = this.world.visibilityState.peek() === VisibilityState.Visible;
    const pose = TEST_POSES[perfTest.id];

    if (perfTest.state === 'waiting for VR') {
      if (!immersive) return;
      perfTest.state = 'warm-up';
      internal.begin = 0;
    }
    if (perfTest.state === 'warm-up') {
      if (!internal.begin) {
        internal.begin = now;
        placePlayer(this.world, pose.x, pose.z, pose.yawDeg);
        metrics.reset();
        perfTest.status = 'Stand still and look ahead.';
      }
      perfTest.secondsLeft = Math.max(0, (perfTest.warmupMs - (now - internal.begin)) / 1000);
      if (now - internal.begin >= perfTest.warmupMs) {
        perfTest.state = 'sampling';
        internal.sampleStart = now;
        this.player.getWorldPosition(pos);
        internal.start = [pos.x, pos.z];
        metrics.reset();
      }
      return;
    }
    // sampling
    perfTest.secondsLeft = Math.max(0, (perfTest.sampleMs - (now - internal.sampleStart)) / 1000);
    if (now - internal.sampleStart >= perfTest.sampleMs) this.finish(immersive);
  }

  private finish(immersive: boolean): void {
    const w = this.world;
    const s = metrics.summary(perfTest.sampleMs + 250);
    this.player.getWorldPosition(pos);
    const drift = Math.hypot(pos.x - internal.start[0], pos.z - internal.start[1]);
    const notes: string[] = [];
    if (drift > 1.5) notes.push(`player moved ${drift.toFixed(1)} m during sampling`);
    const expected = (perfTest.sampleMs / 1000) * (metrics.displayRate ?? 72);
    if (s.frames < expected * 0.5) notes.push(`only ${s.frames} frames sampled (expected about ${Math.round(expected)} at the display rate)`);
    if (!immersive && !perfTest.desktop) notes.push('measured outside VR');
    if (!immersive) notes.push('desktop browser: numbers are NOT Quest numbers');
    const emulated = isEmulated();
    if (emulated) notes.push('IWER emulator is active (the user agent is spoofed as a Quest): this is NOT a physical headset');
    if (metrics.gpuStatus.startsWith('unavailable')) notes.push('GPU time unavailable on this browser (reported as null)');
    const q = loadQuality();
    const info = w.renderer.info;
    const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
    const session = w.renderer.xr.getSession?.();
    const bootGroups: Record<string, number> = {};
    for (const [k, v] of Object.entries(BUILD_TIMES)) bootGroups[k] = Math.round(v);
    const result: PerfResult = {
      schema: 1,
      id: perfTest.id!,
      label: TEST_POSES[perfTest.id!].label,
      timestamp: new Date().toISOString(),
      session: immersive ? 'immersive-vr' : 'desktop',
      valid: drift <= 1.5 && s.frames >= expected * 0.5,
      notes,
      warmupSeconds: perfTest.warmupMs / 1000,
      sampleSeconds: Math.round(s.seconds * 10) / 10,
      frames: s.frames,
      fps: round(s.fps, 1),
      frameMs: { mean: round(s.meanMs), median: round(s.medianMs), p95: round(s.p95Ms), p99: round(s.p99Ms), max: round(s.maxMs) },
      missedFramesPct: round(s.missed * 100, 1),
      cpuMs: { update: round(s.updateMs), render: round(s.renderMs) },
      gpuMs: { mean: s.gpuMs === null ? null : round(s.gpuMs), p95: s.gpuP95Ms === null ? null : round(s.gpuP95Ms), status: metrics.gpuStatus },
      draws: { mean: round(s.calls, 0), max: s.maxCalls },
      triangles: { mean: round(s.tris, 0), max: s.maxTris },
      vegetationCellsShown: { mean: round(s.cells, 1), total: chunkStats.total },
      quality: { tier: qualityState.tier, shadows: qualityState.shadows, xrScale: q.xrScale, foveation: q.foveation },
      governor: { state: governorInfo.state, step: governorInfo.step, lastReason: governorInfo.lastReason, enabledDuringTest: perfTest.governorOn },
      display: { rateHz: metrics.displayRate, supportedRatesHz: metrics.supportedRates, periodMs: round(metrics.periodMs) },
      player: { start: [round(internal.start[0], 1), round(internal.start[1], 1)], end: [round(pos.x, 1), round(pos.z, 1)], driftMeters: round(drift, 2), area: areaAt(pos.x, pos.z) },
      boot: { assetBuildMs: Math.round(Object.values(BUILD_TIMES).reduce((a, b) => a + b, 0)), assetBuildGroups: bootGroups, pageLoadToTestMs: Math.round(performance.now() - internal.pageReady) },
      memory: { geometries: info.memory.geometries, textures: info.memory.textures, programs: info.programs?.length ?? 0, jsHeapMB: heap === undefined ? null : round(heap / 1048576, 0) },
      environment: { iwsdk: VERSION, userAgent: navigator.userAgent, emulated, xrFeatures: session && 'enabledFeatures' in session ? Array.from((session as unknown as { enabledFeatures: string[] }).enabledFeatures) : [], devicePixelRatio: window.devicePixelRatio },
    };
    perfTest.last = result;
    perfTest.state = 'done';
    perfTest.status = `Done: ${result.fps} fps, ${result.frameMs.p95} ms p95.`;
    const json = JSON.stringify(result);
    console.info(`[jumanji:perf-result] ${json}`);
    try {
      const all = loadStored();
      all.push(result);
      localStorage.setItem(STORE, JSON.stringify(all.slice(-20)));
    } catch {
      /* storage unavailable */
    }
    void fetch('/__jumanji/perf', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json })
      .then((r) => {
        if (r.ok) perfTest.status += ' Saved to perf-results/ on the PC.';
      })
      .catch(() => undefined);
    if (perfTest.returnToStart) placePlayer(w, SPAWN[0], SPAWN[1], 0);
  }
}

/** The IWER emulator (dev server) spoofs the Quest user agent, so detect it by its globals instead. */
export function isEmulated(): boolean {
  const w = window as unknown as Record<string, unknown>;
  return !!(w.IWER_DEVICE || w.__IWSDK_EMULATION_PROFILE);
}

const round = (v: number, d = 2): number => Math.round(v * 10 ** d) / 10 ** d;

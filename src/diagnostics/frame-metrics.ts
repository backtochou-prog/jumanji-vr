import type { World } from '@iwsdk/core';

/**
 * Frame measurements shared by the performance overlay, the quality governor and the
 * headset test mode. Everything is MEASURED in the browser; nothing is estimated.
 *
 *   interval   time between the starts of consecutive frames (the real frame period; at
 *              vsync it snaps to multiples of the display period: 13.9 ms at 72 Hz)
 *   update     CPU time in world.update: all ECS systems, input, locomotion, XR callbacks
 *   render     CPU time inside renderer.render: three.js submission (draws, shadow pass,
 *              uniform uploads). This is CPU work, NOT GPU time
 *   gpu        GPU time of the render, only when the browser exposes
 *              EXT_disjoint_timer_query_webgl2; otherwise null and `gpuStatus` says why
 *   calls/tris renderer.info of the frame (per eye pair when multiview is on)
 */
const N = 2048;

export interface Summary {
  frames: number;
  seconds: number;
  fps: number;
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  /** Fraction of frames longer than 1.5 display periods (a missed vsync). */
  missed: number;
  updateMs: number;
  renderMs: number;
  gpuMs: number | null;
  gpuP95Ms: number | null;
  calls: number;
  maxCalls: number;
  tris: number;
  maxTris: number;
  cells: number;
}

class FrameMetrics {
  private t = new Float64Array(N);
  private interval = new Float32Array(N);
  private update = new Float32Array(N);
  private render = new Float32Array(N);
  private gpu = new Float32Array(N).fill(NaN);
  private calls = new Uint16Array(N);
  private tris = new Uint32Array(N);
  private cells = new Uint8Array(N);
  private head = 0;
  private count = 0;
  private frameStart = 0;
  private lastStart = 0;
  installed = false;
  /** Display refresh rate reported by the XR session (null in desktop mode or when not exposed). */
  displayRate: number | null = null;
  supportedRates: number[] = [];
  gpuStatus = 'not installed';
  /** Set by the ChunkLodSystem each pass. */
  cellsShown = 0;

  // GPU timer query state
  private gl: WebGL2RenderingContext | null = null;
  private ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
  private pending: { q: WebGLQuery; slot: number }[] = [];
  private pool: WebGLQuery[] = [];

  install(world: World): void {
    if (this.installed) return;
    this.installed = true;
    const renderer = world.renderer;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    this.gl = gl;
    try {
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
      if (ext) {
        this.ext = ext;
        this.gpuStatus = 'available (EXT_disjoint_timer_query_webgl2)';
      } else {
        this.gpuStatus = 'unavailable: browser does not expose EXT_disjoint_timer_query_webgl2';
      }
    } catch (e) {
      this.gpuStatus = `unavailable: ${(e as Error).message}`;
    }

    // Frame start = the beginning of world.update (the SDK render loop calls it first).
    const origUpdate = world.update.bind(world);
    world.update = ((delta: number, time: number) => {
      this.frameStart = performance.now();
      return origUpdate(delta, time);
    }) as typeof world.update;

    // Render hook: CPU submission time + optional GPU timer around the whole render.
    const origRender = renderer.render.bind(renderer);
    renderer.render = ((scene: Parameters<typeof origRender>[0], camera: Parameters<typeof origRender>[1]) => {
      const t0 = performance.now();
      let q: WebGLQuery | null = null;
      if (this.ext && this.gl) {
        q = this.pool.pop() ?? this.gl.createQuery();
        if (q && this.pending.length < 6) this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
        else q = null;
      }
      origRender(scene, camera);
      if (q && this.gl && this.ext) this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      const t1 = performance.now();
      const slot = this.head;
      this.record(t0, t1, renderer.info.render.calls, renderer.info.render.triangles);
      if (q) this.pending.push({ q, slot });
      this.pollGpu();
      const s = (renderer.xr as unknown as { getSession?: () => XRSession | null }).getSession?.();
      this.displayRate = s?.frameRate ?? null;
      this.supportedRates = s?.supportedFrameRates ? Array.from(s.supportedFrameRates) : [];
    }) as typeof renderer.render;
  }

  private record(t0: number, t1: number, calls: number, tris: number): void {
    const i = this.head;
    const start = this.frameStart || t0;
    this.t[i] = t1;
    this.interval[i] = this.lastStart ? start - this.lastStart : 0;
    this.update[i] = Math.max(0, t0 - start);
    this.render[i] = t1 - t0;
    this.gpu[i] = NaN;
    this.calls[i] = calls;
    this.tris[i] = tris;
    this.cells[i] = this.cellsShown;
    this.lastStart = start;
    this.head = (i + 1) % N;
    this.count = Math.min(N, this.count + 1);
  }

  private pollGpu(): void {
    if (!this.gl || !this.ext || this.pending.length === 0) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
    while (this.pending.length) {
      const p = this.pending[0];
      if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      if (!disjoint) this.gpu[p.slot] = (gl.getQueryParameter(p.q, gl.QUERY_RESULT) as number) / 1e6;
      this.pool.push(p.q);
    }
  }

  /** Statistics over the frames of the last `ms` milliseconds. The most recent frame is excluded (its GPU time may be pending). */
  summary(ms: number): Summary {
    const now = performance.now();
    const idx: number[] = [];
    for (let k = 2; k <= this.count; k++) {
      const i = (this.head - k + N) % N;
      if (now - this.t[i] > ms) break;
      if (this.interval[i] > 0) idx.push(i);
    }
    const n = idx.length;
    const empty: Summary = { frames: 0, seconds: 0, fps: 0, meanMs: 0, medianMs: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, missed: 0, updateMs: 0, renderMs: 0, gpuMs: null, gpuP95Ms: null, calls: 0, maxCalls: 0, tris: 0, maxTris: 0, cells: 0 };
    if (!n) return empty;
    const iv = idx.map((i) => this.interval[i]).sort((a, b) => a - b);
    const sum = (f: (i: number) => number) => idx.reduce((a, i) => a + f(i), 0);
    const mean = sum((i) => this.interval[i]) / n;
    const period = this.displayRate ? 1000 / this.displayRate : 1000 / 72;
    const gpus = idx.map((i) => this.gpu[i]).filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
    const pct = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
    return {
      frames: n,
      seconds: sum((i) => this.interval[i]) / 1000,
      fps: 1000 / mean,
      meanMs: mean,
      medianMs: pct(iv, 0.5),
      p95Ms: pct(iv, 0.95),
      p99Ms: pct(iv, 0.99),
      maxMs: iv[iv.length - 1],
      missed: iv.filter((v) => v > period * 1.5).length / n,
      updateMs: sum((i) => this.update[i]) / n,
      renderMs: sum((i) => this.render[i]) / n,
      gpuMs: gpus.length ? gpus.reduce((a, b) => a + b, 0) / gpus.length : null,
      gpuP95Ms: gpus.length ? pct(gpus, 0.95) : null,
      calls: sum((i) => this.calls[i]) / n,
      maxCalls: Math.max(...idx.map((i) => this.calls[i])),
      tris: sum((i) => this.tris[i]) / n,
      maxTris: Math.max(...idx.map((i) => this.tris[i])),
      cells: sum((i) => this.cells[i]) / n,
    };
  }

  /** Display period in ms (from the XR session when known, else 72 Hz, the Quest browser default). */
  get periodMs(): number {
    return this.displayRate ? 1000 / this.displayRate : 1000 / 72;
  }

  /** Forget all frames (after teleports/tier changes, so windows are clean). */
  reset(): void {
    this.count = 0;
    this.head = 0;
    this.lastStart = 0;
  }
}

export const metrics = new FrameMetrics();

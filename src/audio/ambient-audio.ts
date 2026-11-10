/**
 * Ambient sound: wind, insects, streams and waterfalls (positional loops), bird/monkey calls (positional one-shots from the real creatures plus a
 * scheduler of distant ones) - all synthesised procedurally (audio/synth.ts), mixed through the Web Audio API.
 *
 *  - Starts only after a user gesture (pointer/key/touch, or the XR session start): browsers refuse to run an AudioContext before one.
 *  - The listener follows the head every frame (position + forward/up), so sound comes from where its source is and turns with the head.
 *  - Positional sources use PannerNodes with the 'inverse' distance model; a source's `refDistance` is the distance at which it is at full level
 *    (a waterfall 28-50 m, a stream 4 m, a bird call 3 m), so a waterfall is audible long before you reach it and gets louder as you walk up.
 *    Calls also get a distance low-pass (air absorbs the highs). HRTF panning for calls and waterfalls, equal-power for the rest (cheaper).
 *  - Nothing is a short obvious loop: wind and water get random level wandering, calls pick from 3 variants with random pitch and timing, distant calls
 *    are a random (Poisson-like) process whose rate follows the player (faster when standing still), and a disturbance (birds taking off) hushes the
 *    insects and wind for a few seconds before they come back - the jungle reacts.
 *  - Limits (Quest 2): at most 4 positional water loops, 4 insect loops, 8 call voices at once; buffers are generated in small slices so no frame stalls.
 *  - Mute with the board's Sound button, `?audio=0` or localStorage; the context is never created if disabled.
 */
import { CLIFF, POOL, STREAM_SAMPLES, makeRandom, terrainHeight } from '../world/layout.js';
import { BRIDGE, VALLEY, riverPoint } from '../world/mountain.js';
import type { CallKind, CallSink } from '../wildlife/context.js';
import { CALL_MAKERS, SR, bubbles, brownNoise, cicadas, crickets, whiteNoise, windBed } from './synth.js';

const PREF_KEY = 'jumanji-vr.sound.v1';

/** Rolloff factor of the backdrop waterfall's panner: at 109-122 m its level is about 1.6x that of a stream-style rolloff (audibility 0.22 -> ~0.4 at ref 28..46). */
const BACKDROP_ROLLOFF = 0.75;

export const audioInfo = {
  supported: typeof globalThis.AudioContext !== 'undefined' || typeof (globalThis as unknown as { webkitAudioContext?: unknown }).webkitAudioContext !== 'undefined',
  enabled: true,
  /** 'off' = not unlocked yet, 'starting', 'running', 'suspended' (needs another gesture), 'disabled', 'unsupported'. */
  state: 'off' as string,
  buffersReady: 0,
  buffersTotal: 0,
  waterVoices: 0,
  insectVoices: 0,
  callsPlayed: 0,
  callsDropped: 0,
  lastCall: '',
  callsByKind: {} as Record<string, number>,
  hush: 1,
  wind: 0,
  insects: 0,
  masked: 0,
  listener: { x: 0, y: 0, z: 0 },
  gestures: 0,
};

interface Emitter {
  name: string;
  x: number;
  y: number;
  z: number;
  /** Distance (m) at which it is at full level. */
  ref: number;
  gain: number;
  kind: 'fall' | 'stream' | 'trickle';
  /** Loudness class for masking. */
  active: boolean;
  nodes: { src: AudioBufferSourceNode[]; gain: GainNode; panner: PannerNode } | null;
}

interface CallVoice {
  panner: PannerNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  busyUntil: number;
}

const jungleEmitters = (): Emitter[] => {
  const e: Emitter[] = [];
  e.push({ name: 'backdrop waterfall', x: CLIFF.x, y: terrainHeight(CLIFF.x, CLIFF.z) + 6, z: CLIFF.z + 4, ref: 46, gain: 0.85, kind: 'fall', active: false, nodes: null });
  e.push({ name: 'pool cascade', x: POOL.x, y: POOL.waterY + 0.6, z: POOL.z - 1, ref: 5, gain: 0.55, kind: 'trickle', active: false, nodes: null });
  const picks = [8, Math.floor(STREAM_SAMPLES.length * 0.4), Math.floor(STREAM_SAMPLES.length * 0.75)];
  picks.forEach((i, k) => {
    const p = STREAM_SAMPLES[Math.min(i, STREAM_SAMPLES.length - 1)];
    e.push({ name: `stream ${k}`, x: p[0], y: terrainHeight(p[0], p[1]) + 0.3, z: p[1], ref: 4.5, gain: 0.38, kind: 'stream', active: false, nodes: null });
  });
  return e;
};

const mountainEmitters = (): Emitter[] => {
  const e: Emitter[] = [];
  const fall = riverPoint(70);
  e.push({ name: 'giant waterfall', x: fall[0], y: -45, z: fall[1], ref: 55, gain: 1.0, kind: 'fall', active: false, nodes: null });
  const casc = riverPoint(40);
  e.push({ name: 'cascade above the bridge', x: casc[0], y: terrainHeight(casc[0], casc[1]) + 4, z: casc[1], ref: 22, gain: 0.7, kind: 'fall', active: false, nodes: null });
  e.push({ name: 'gorge river under the bridge', x: (BRIDGE.ax + BRIDGE.bx) / 2, y: BRIDGE.y - 18, z: BRIDGE.az, ref: 14, gain: 0.6, kind: 'stream', active: false, nodes: null });
  e.push({ name: 'valley river', x: VALLEY.x, y: -56, z: VALLEY.z, ref: 28, gain: 0.5, kind: 'stream', active: false, nodes: null });
  return e;
};

export class AmbientAudio implements CallSink {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private windGain: GainNode | null = null;
  private insectGain: GainNode | null = null;
  private waterBus: GainNode | null = null;
  private callBus: GainNode | null = null;
  private buffers: Record<string, AudioBuffer[]> = {};
  private emitters: Emitter[] = [...jungleEmitters(), ...mountainEmitters()];
  /** The jungle backdrop waterfall (found by name, so the emitter table can change): the opening reveal rides its level, and it rolls off gently with distance. */
  private backdrop: Emitter | null = this.emitters.find((e) => e.name === 'backdrop waterfall') ?? null;
  /** Level multiplier of the backdrop waterfall (IntroSystem: quiet in the mist, swelling as it lifts, 1 otherwise) and the time constant of its change. */
  private fallLevel = 1;
  private fallTau = 2.5;
  private fallApplied = 1;
  private insectVoices: { src: AudioBufferSourceNode; panner: PannerNode; gain: GainNode; ang: number; rad: number; kind: string }[] = [];
  private voices: CallVoice[] = [];
  private rng = makeRandom(8128);
  private t = 0;
  private acc = 0;
  private nextDistant = 4;
  private hushLevel = 1;
  private hushEnd = 0;
  private hushTau = 5;
  private gust = 1;
  private nextGust = 0;
  private lastCall: Record<string, number> = {};
  private queue: (() => void)[] = [];
  private started = false;
  private low = false;
  private unlockHandler = (): void => this.unlock();

  constructor() {
    const q = new URLSearchParams(globalThis.location?.search ?? '');
    let pref = true;
    try {
      pref = localStorage.getItem(PREF_KEY) !== 'off';
    } catch {
      /* private mode */
    }
    audioInfo.enabled = q.get('audio') === '0' || q.get('mute') === '1' ? false : pref;
    audioInfo.state = !audioInfo.supported ? 'unsupported' : audioInfo.enabled ? 'off' : 'disabled';
    if (audioInfo.supported && typeof window !== 'undefined') {
      for (const ev of ['pointerdown', 'keydown', 'touchstart', 'click']) window.addEventListener(ev, this.unlockHandler, { passive: true });
    }
  }

  /** Persisted on/off (the board's Sound button). */
  setEnabled(on: boolean): void {
    audioInfo.enabled = on;
    try {
      localStorage.setItem(PREF_KEY, on ? 'on' : 'off');
    } catch {
      /* ignore */
    }
    if (!audioInfo.supported) return;
    if (on) {
      audioInfo.state = this.ctx ? this.ctx.state : 'off';
      this.unlock();
    } else audioInfo.state = 'disabled';
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(on ? 0.85 : 0, this.ctx.currentTime, 0.15);
  }

  get enabled(): boolean {
    return audioInfo.enabled;
  }

  setLow(low: boolean): void {
    this.low = low;
  }

  /** Create / resume the context. Must run inside a user gesture (the listeners above, or XR session start). */
  unlock(): void {
    audioInfo.gestures++;
    if (!audioInfo.supported || !audioInfo.enabled) return;
    if (!this.ctx) {
      try {
        const Ctor = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.ctx = new Ctor({ latencyHint: 'interactive' });
      } catch (e) {
        console.warn('[jumanji] audio unavailable', e);
        audioInfo.state = 'unsupported';
        return;
      }
      audioInfo.state = 'starting';
      this.build();
    }
    const ctx = this.ctx;
    console.info(`[jumanji] audio unlock requested (gesture ${audioInfo.gestures}): context ${ctx.state}`);
    if (ctx.state === 'suspended') {
      void ctx.resume().then(() => {
        audioInfo.state = ctx.state;
        console.info(`[jumanji] audio context ${ctx.state} (sample rate ${ctx.sampleRate})`);
      });
    }
    audioInfo.state = ctx.state === 'running' ? 'running' : audioInfo.state;
    if (ctx.state === 'running' && typeof window !== 'undefined') {
      for (const ev of ['pointerdown', 'keydown', 'touchstart', 'click']) window.removeEventListener(ev, this.unlockHandler);
    }
  }

  // ------------------------------------------------------------------ graph
  private build(): void {
    const ctx = this.ctx!;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(comp);
    comp.connect(ctx.destination);
    this.master.gain.setTargetAtTime(0.85, ctx.currentTime + 0.05, 0.4);
    this.windGain = this.bus(0);
    this.insectGain = this.bus(0);
    this.waterBus = this.bus(1);
    this.callBus = this.bus(1);
    // call voices
    for (let i = 0; i < 8; i++) {
      const panner = this.makePanner('HRTF', 3, 1.15);
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 12000;
      const gain = ctx.createGain();
      gain.gain.value = 1;
      filter.connect(gain);
      gain.connect(panner);
      panner.connect(this.callBus);
      this.voices.push({ panner, filter, gain, busyUntil: 0 });
    }
    // stage buffer generation (each task a few ms) so no frame stalls
    const need: [string, () => Float32Array][] = [
      ['wind', () => windBed(12, 3)],
      ['white', () => whiteNoise(6, 11)],
      ['brown', () => brownNoise(6, 12)],
      ['bubbles', () => bubbles(7, 13)],
      ['cicada', () => cicadas(6, 14)],
      ['cricket', () => crickets(8, 15)],
      ['cicada', () => cicadas(6, 16)],
      ['cricket', () => crickets(8, 17)],
    ];
    for (const kind of Object.keys(CALL_MAKERS) as (keyof typeof CALL_MAKERS)[]) for (let v = 0; v < 3; v++) need.push([kind, () => CALL_MAKERS[kind](100 + v * 37 + kind.length * 11)]);
    audioInfo.buffersTotal = need.length;
    for (const [name, make] of need) {
      this.queue.push(() => {
        const data = make();
        const buf = ctx.createBuffer(1, data.length, SR);
        buf.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
        (this.buffers[name] ??= []).push(buf);
        audioInfo.buffersReady++;
      });
    }
    this.pump();
  }

  private pump(): void {
    const task = this.queue.shift();
    if (!task) return;
    task();
    setTimeout(() => this.pump(), 8);
  }

  private bus(g: number): GainNode {
    const n = this.ctx!.createGain();
    n.gain.value = g;
    n.connect(this.master!);
    return n;
  }

  private makePanner(model: 'HRTF' | 'equalpower', ref: number, rolloff: number): PannerNode {
    const p = this.ctx!.createPanner();
    p.panningModel = this.low && model === 'HRTF' ? 'equalpower' : model;
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.rolloffFactor = rolloff;
    p.maxDistance = 100000;
    return p;
  }

  private setPos(p: PannerNode, x: number, y: number, z: number, at: number): void {
    if (p.positionX) {
      p.positionX.setValueAtTime(x, at);
      p.positionY.setValueAtTime(y, at);
      p.positionZ.setValueAtTime(z, at);
    } else (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
  }

  private buf(kind: string): AudioBuffer | null {
    const list = this.buffers[kind];
    if (!list || !list.length) return null;
    return list[Math.floor(this.rng() * list.length)];
  }

  // ------------------------------------------------------------------ per frame
  /** Listener pose + environment. Called every frame by the system; the heavy parts are throttled to 10 Hz. */
  update(
    dt: number,
    px: number,
    py: number,
    pz: number,
    fx: number,
    fy: number,
    fz: number,
    ux: number,
    uy: number,
    uz: number,
    open: number,
    still: boolean,
    activity: number,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !audioInfo.enabled) return;
    if (ctx.state === 'suspended') {
      audioInfo.state = 'suspended';
      return;
    }
    if (ctx.state === 'running' && audioInfo.state !== 'running') console.info('[jumanji] audio running; listener follows the head');
    audioInfo.state = ctx.state === 'running' ? 'running' : audioInfo.state;
    this.t += dt;
    audioInfo.listener.x = px;
    audioInfo.listener.y = py;
    audioInfo.listener.z = pz;
    const L = ctx.listener;
    const at = ctx.currentTime;
    if (L.positionX) {
      L.positionX.setValueAtTime(px, at);
      L.positionY.setValueAtTime(py, at);
      L.positionZ.setValueAtTime(pz, at);
      L.forwardX.setValueAtTime(fx, at);
      L.forwardY.setValueAtTime(fy, at);
      L.forwardZ.setValueAtTime(fz, at);
      L.upX.setValueAtTime(ux, at);
      L.upY.setValueAtTime(uy, at);
      L.upZ.setValueAtTime(uz, at);
    } else {
      const l = L as unknown as { setPosition(x: number, y: number, z: number): void; setOrientation(a: number, b: number, c: number, d: number, e: number, f: number): void };
      l.setPosition(px, py, pz);
      l.setOrientation(fx, fy, fz, ux, uy, uz);
    }
    // hush recovers
    if (this.t > this.hushEnd) this.hushLevel += (1 - this.hushLevel) * Math.min(1, dt / this.hushTau);
    audioInfo.hush = this.hushLevel;

    this.acc += dt;
    if (this.acc < 0.1) return;
    const step = this.acc;
    this.acc = 0;
    this.slow(step, px, py, pz, open, still, activity);
  }

  private audibility(e: Emitter, px: number, py: number, pz: number): number {
    const d = Math.hypot(e.x - px, e.y - py, e.z - pz);
    return (e.gain * e.ref) / (e.ref + this.rolloffOf(e) * Math.max(0, d - e.ref));
  }

  /** Distance rolloff of an emitter's panner (Web Audio 'inverse' model). The far backdrop fall rolls off gently: it is heard long before it is reached. */
  private rolloffOf(e: Emitter): number {
    return e === this.backdrop ? BACKDROP_ROLLOFF : 1;
  }

  private emitterLevel(e: Emitter): number {
    return e === this.backdrop ? e.gain * this.fallLevel : e.gain;
  }

  private slow(dt: number, px: number, py: number, pz: number, open: number, still: boolean, activity: number): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;

    // ---- positional water loops: the 4 most audible emitters play, others are stopped
    const ranked = this.emitters.map((e) => ({ e, a: this.audibility(e, px, py, pz) })).sort((a, b) => b.a - a.a);
    let waterNear = 0;
    let playing = 0;
    for (let i = 0; i < ranked.length; i++) {
      const { e, a } = ranked[i];
      const want = i < 4 && a > 0.012 && this.buffers['white']?.length > 0;
      if (want && !e.active) this.startEmitter(e, now);
      else if (!want && e.active) this.stopEmitter(e, now);
      if (e.active) {
        playing++;
        waterNear = Math.max(waterNear, Math.min(1, a * 1.2));
      }
    }
    audioInfo.waterVoices = playing;
    const bd = this.backdrop;
    if (bd && bd.active && bd.nodes && Math.abs(this.fallLevel - this.fallApplied) > 0.004) {
      bd.nodes.gain.gain.setTargetAtTime(bd.gain * this.fallLevel, now, this.fallTau);
      this.fallApplied = this.fallLevel;
    }
    // masking: water drowns the quieter beds (insects, wind, distant birds)
    const mask = 1 - 0.6 * Math.min(1, waterNear * 1.6);
    audioInfo.masked = 1 - mask;

    // ---- wind: a level that wanders (gusts) on top of an altitude/openness base
    if (this.t >= this.nextGust) {
      this.nextGust = this.t + 3 + this.rng() * 6;
      this.gust = 0.55 + this.rng() * 0.7;
    }
    this.ensureWind(now);
    const windBase = 0.07 + 0.42 * Math.pow(open, 1.2);
    const wind = windBase * this.gust * (0.6 + 0.4 * this.hushLevel) * (0.5 + 0.5 * mask);
    this.windGain!.gain.setTargetAtTime(wind, now, 1.6);
    audioInfo.wind = wind;

    // ---- insects: the jungle hum (4 positional voices around the player), strongest on the floor, gone on the open mountain
    this.ensureInsects(now);
    const insect = 0.2 * Math.pow(1 - open, 1.5) * this.hushLevel * mask;
    this.insectGain!.gain.setTargetAtTime(insect, now, 1.2);
    audioInfo.insects = insect;
    audioInfo.insectVoices = this.insectVoices.length;
    for (const v of this.insectVoices) {
      v.ang += dt * (0.03 + 0.02 * Math.sin(v.rad));
      this.setPos(v.panner, px + Math.cos(v.ang) * v.rad, py - 0.5 + 1.2 * Math.sin(v.ang * 1.7), pz + Math.sin(v.ang) * v.rad, now);
    }

    // ---- distant calls: a random process (rate up when standing still and when many animals are about)
    this.nextDistant -= dt;
    if (this.nextDistant <= 0) {
      const base = 3.5 + this.rng() * 9;
      const rate = (still ? 0.62 : 1) * (1 - 0.35 * Math.min(1, activity)) * (0.6 + 0.4 * mask);
      this.nextDistant = base * rate * (1 + 3.5 * open);
      if (this.hushLevel > 0.6) this.distantCall(px, py, pz, open);
    }
  }

  private distantCall(px: number, py: number, pz: number, open: number): void {
    const r = this.rng();
    const kind: CallKind = open > 0.5 ? (r < 0.6 ? 'songbird' : r < 0.85 ? 'macaw' : 'toucan') : r < 0.34 ? 'songbird' : r < 0.58 ? 'parakeet' : r < 0.74 ? 'macaw' : r < 0.88 ? 'toucan' : r < 0.97 ? 'monkey-hoot' : 'monkey-whoop';
    const ang = this.rng() * Math.PI * 2;
    const rad = (open > 0.5 ? 70 : 38) + this.rng() * (open > 0.5 ? 130 : 80);
    const x = px + Math.cos(ang) * rad;
    const z = pz + Math.sin(ang) * rad;
    this.call(kind, x, terrainHeight(x, z) + 7 + this.rng() * 18, z, 0.55 + this.rng() * 0.4);
  }

  // ------------------------------------------------------------------ emitters
  private startEmitter(e: Emitter, now: number): void {
    const ctx = this.ctx!;
    const src: AudioBufferSourceNode[] = [];
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const panner = this.makePanner(e.kind === 'fall' ? 'HRTF' : 'equalpower', e.ref, this.rolloffOf(e));
    this.setPos(panner, e.x, e.y, e.z, now);
    gain.connect(panner);
    panner.connect(this.waterBus!);
    const layer = (kind: string, ftype: BiquadFilterType, freq: number, q: number, level: number, rate = 1): void => {
      const b = this.buf(kind);
      if (!b) return;
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.loop = true;
      s.playbackRate.value = rate * (0.97 + this.rng() * 0.06);
      const f = ctx.createBiquadFilter();
      f.type = ftype;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = level;
      s.connect(f);
      f.connect(g);
      g.connect(gain);
      s.start(0, this.rng() * b.duration);
      src.push(s);
    };
    if (e.kind === 'fall') {
      layer('white', 'lowpass', 2300, 0.6, 0.55);
      layer('white', 'highpass', 5200, 0.5, 0.08, 1.1); // the spray hiss
      layer('brown', 'lowpass', 260, 0.7, 1.0); // the thunder underneath
    } else if (e.kind === 'trickle') {
      layer('bubbles', 'bandpass', 1500, 0.5, 0.9);
      layer('white', 'bandpass', 2400, 0.7, 0.18);
    } else {
      layer('white', 'bandpass', 1300, 0.55, 0.32);
      layer('bubbles', 'highpass', 900, 0.5, 0.35, 0.8);
    }
    gain.gain.setTargetAtTime(this.emitterLevel(e), now, 1.2);
    if (e === this.backdrop) this.fallApplied = this.fallLevel;
    e.nodes = { src, gain, panner };
    e.active = true;
  }

  private stopEmitter(e: Emitter, now: number): void {
    const n = e.nodes;
    e.active = false;
    e.nodes = null;
    if (!n) return;
    n.gain.gain.setTargetAtTime(0, now, 0.5);
    for (const s of n.src) {
      try {
        s.stop(now + 2.5);
      } catch {
        /* already stopped */
      }
    }
    setTimeout(() => {
      try {
        n.gain.disconnect();
        n.panner.disconnect();
      } catch {
        /* ignore */
      }
    }, 3200);
  }

  private windStarted = false;
  private ensureWind(now: number): void {
    if (this.windStarted || !this.buffers['wind']?.length) return;
    this.windStarted = true;
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = this.buffers['wind'][0];
    s.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 700;
    s.connect(f);
    f.connect(this.windGain!);
    s.start(now);
    // a second, offset, slightly different-rate copy: the two beat against each other, so the loop point is never heard
    const s2 = ctx.createBufferSource();
    s2.buffer = this.buffers['wind'][0];
    s2.loop = true;
    s2.playbackRate.value = 0.93;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.value = 900;
    f2.Q.value = 0.4;
    const g2 = ctx.createGain();
    g2.gain.value = 0.45;
    s2.connect(f2);
    f2.connect(g2);
    g2.connect(this.windGain!);
    s2.start(now, 4.1);
  }

  private insectsStarted = false;
  private ensureInsects(now: number): void {
    if (this.insectsStarted) return;
    const ci = this.buffers['cicada']?.length ?? 0;
    const cr = this.buffers['cricket']?.length ?? 0;
    if (ci < 2 || cr < 2) return;
    this.insectsStarted = true;
    const ctx = this.ctx!;
    const defs: [string, number, number, number][] = [
      ['cicada', 0, 9, 0.7],
      ['cicada', 1, 14, 0.55],
      ['cricket', 0, 7, 0.6],
      ['cricket', 1, 12, 0.5],
    ];
    defs.forEach(([kind, idx, rad, level], i) => {
      const s = ctx.createBufferSource();
      s.buffer = this.buffers[kind][idx];
      s.loop = true;
      s.playbackRate.value = 0.96 + this.rng() * 0.08;
      const g = ctx.createGain();
      g.gain.value = level;
      const p = this.makePanner('equalpower', 6, 1);
      s.connect(g);
      g.connect(p);
      p.connect(this.insectGain!);
      s.start(now, this.rng() * 4);
      this.insectVoices.push({ src: s, panner: p, gain: g, ang: (i / defs.length) * Math.PI * 2 + this.rng(), rad, kind });
    });
  }

  // ------------------------------------------------------------------ opening reveal (IntroSystem)
  /**
   * Level of the backdrop waterfall relative to normal (1 = normal): the reveal starts it quiet inside the mist, brings it up with a long time constant and lets it
   * swell as the mist lifts. Applied at the next 10 Hz tick (and when the emitter starts); a no-op while sound is off or not started.
   */
  setFallLevel(level: number, tau = 2.5): void {
    this.fallLevel = Math.max(0, Math.min(2, level));
    this.fallTau = Math.max(0.2, tau);
  }

  /**
   * A one-shot macaw call at a world position - the "listen, over there" cue toward the waterfall. Returns true when it really sounded (sound on, context
   * running, buffers ready, a voice free), so the caller can retry a moment later when the audio engine was not ready yet.
   */
  introCue(x: number, y: number, z: number): boolean {
    if (!audioInfo.enabled || !this.ctx || this.ctx.state !== 'running') return false;
    const before = audioInfo.callsPlayed;
    this.call('macaw', x, y, z, 0.8);
    return audioInfo.callsPlayed > before;
  }

  // ------------------------------------------------------------------ CallSink
  hush(seconds: number, strength: number): void {
    const level = 1 - Math.min(0.95, Math.max(0, strength));
    this.hushLevel = Math.min(this.hushLevel, level);
    this.hushEnd = Math.max(this.hushEnd, this.t + seconds * 0.5);
    this.hushTau = Math.max(1, seconds * 0.5);
  }

  /** A creature calls at (x, y, z). `gain` 0..1 is its natural loudness. */
  call(kind: CallKind, x: number, y: number, z: number, gain: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !audioInfo.enabled || !this.callBus) return;
    let k: Exclude<CallKind, 'alarm'>;
    let rate = 0.93 + this.rng() * 0.14;
    let g = gain;
    if (kind === 'alarm') {
      const r = this.rng();
      k = r < 0.5 ? 'parakeet' : r < 0.8 ? 'macaw' : 'toucan';
      rate *= 1.12;
      g = Math.min(1, gain * 1.15);
    } else k = kind;
    const b = this.buf(k);
    if (!b) return;
    const nowT = this.t;
    if (nowT - (this.lastCall[k] ?? -9) < 0.5) {
      audioInfo.callsDropped++;
      return;
    }
    const cur = ctx.currentTime;
    const v = this.voices.find((vv) => vv.busyUntil <= cur);
    if (!v) {
      audioInfo.callsDropped++;
      return;
    }
    this.lastCall[k] = nowT;
    const d = Math.hypot(x - audioInfo.listener.x, y - audioInfo.listener.y, z - audioInfo.listener.z);
    // loudness by species and distance (refDistance 3 m, inverse falloff) plus air absorption of the highs
    const loud = k === 'macaw' ? 1.1 : k === 'toucan' ? 0.9 : k === 'parakeet' ? 0.65 : k === 'songbird' ? 0.6 : k === 'monkey-whoop' ? 0.95 : 0.8;
    v.gain.gain.setValueAtTime(g * loud, cur);
    v.filter.frequency.setValueAtTime(Math.max(1800, 15000 * Math.exp(-d / 85)), cur);
    this.setPos(v.panner, x, y, z, cur);
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.playbackRate.value = rate;
    s.connect(v.filter);
    v.busyUntil = cur + b.duration / rate + 0.05;
    s.onended = () => {
      try {
        s.disconnect();
      } catch {
        /* ignore */
      }
    };
    s.start(cur);
    audioInfo.callsPlayed++;
    audioInfo.lastCall = `${k} @ ${d.toFixed(0)} m`;
    audioInfo.callsByKind[k] = (audioInfo.callsByKind[k] ?? 0) + 1;
  }

  // ------------------------------------------------------------------ diagnostics
  /** RMS of the master output over the last block (creates the analyser on first use). */
  level(): number {
    if (!this.ctx || !this.master) return 0;
    if (!this.analyser) {
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.master.connect(this.analyser);
    }
    const data = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(data);
    let s = 0;
    for (const v of data) s += v * v;
    return Math.sqrt(s / data.length);
  }

  /** What is playing and where (tests). */
  describe(): { emitters: { name: string; active: boolean; dist: number; audibility: number }[]; contextState: string; sampleRate: number } {
    const L = audioInfo.listener;
    return {
      emitters: this.emitters.map((e) => ({ name: e.name, active: e.active, dist: Math.hypot(e.x - L.x, e.y - L.y, e.z - L.z), audibility: this.audibility(e, L.x, L.y, L.z) })),
      contextState: this.ctx?.state ?? 'none',
      sampleRate: this.ctx?.sampleRate ?? 0,
    };
  }

  /** Where the listener currently is, as the Web Audio graph sees it (tests: proves the listener follows the head). */
  listenerPosition(): { x: number; y: number; z: number } | null {
    const l = this.ctx?.listener;
    if (!l || !l.positionX) return null;
    return { x: l.positionX.value, y: l.positionY.value, z: l.positionZ.value };
  }
}

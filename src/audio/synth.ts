/**
 * Procedural sound synthesis: every sound in the game is generated here from maths (noise, oscillators, envelopes) into plain Float32Arrays.
 * No recordings, no samples, nothing copyrighted. Deterministic (seeded), DOM-free and Web-Audio-free, so it can be unit-tested in node.
 *
 *   beds      wind (low rumble with slow swells), white/brown noise (shaped live into streams and waterfalls), bubbles (a trickle), cicadas, crickets
 *   calls     scarlet macaw squawk, toucan croak, parakeet chatter, songbird whistle, monkey hoot, spider-monkey whoop (3 variants each)
 * Loops are made seamless by cross-fading their ends. Sample rate is low (24 kHz: the content is below 8 kHz) to keep memory and start-up cost small.
 */
import { makeRandom } from '../world/layout.js';

export const SR = 24000;
const TAU = Math.PI * 2;

type Rng = () => number;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Make a loop seamless: blend the last `fade` seconds into the first (equal-power) and drop them. */
function seamless(src: Float32Array, fade = 0.5): Float32Array {
  const f = Math.floor(fade * SR);
  const n = src.length - f;
  const out = new Float32Array(n);
  out.set(src.subarray(0, n));
  for (let i = 0; i < f; i++) {
    const t = i / f;
    const a = Math.cos(t * Math.PI * 0.5);
    const b = Math.sin(t * Math.PI * 0.5);
    out[i] = out[i] * b + src[n + i] * a;
  }
  return out;
}

/** White noise (loopable). */
export function whiteNoise(seconds: number, seed = 1): Float32Array {
  const r = makeRandom(seed);
  const raw = new Float32Array(Math.floor((seconds + 0.5) * SR));
  for (let i = 0; i < raw.length; i++) raw[i] = (r() * 2 - 1) * 0.6;
  return seamless(raw);
}

/** Brown-ish noise (low rumble): leaky integrated white noise, normalised. */
export function brownNoise(seconds: number, seed = 2): Float32Array {
  const r = makeRandom(seed);
  const raw = new Float32Array(Math.floor((seconds + 0.5) * SR));
  let y = 0;
  let peak = 1e-6;
  for (let i = 0; i < raw.length; i++) {
    y = y * 0.985 + (r() * 2 - 1) * 0.1;
    raw[i] = y;
    peak = Math.max(peak, Math.abs(y));
  }
  for (let i = 0; i < raw.length; i++) raw[i] = (raw[i] / peak) * 0.8;
  return seamless(raw);
}

/** Wind: brown noise with slow, irregular swells (the swell periods divide the loop length, so the loop is seamless in level too). */
export function windBed(seconds = 12, seed = 3): Float32Array {
  const base = brownNoise(seconds, seed);
  const r = makeRandom(seed + 10);
  const n = base.length;
  const len = n / SR;
  const f1 = Math.round(len / 7) / len; // ~7 s swell
  const f2 = Math.round(len / 3.1) / len;
  const f3 = Math.round(len / 1.3) / len;
  const p1 = r() * TAU;
  const p2 = r() * TAU;
  const p3 = r() * TAU;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const swell = 0.45 + 0.35 * Math.sin(TAU * f1 * t + p1) + 0.15 * Math.sin(TAU * f2 * t + p2) + 0.08 * Math.sin(TAU * f3 * t + p3);
    base[i] *= clamp(swell, 0.1, 1);
  }
  return base;
}

/** Bubbling / trickling water: many short rising sine chirps with fast decay. */
export function bubbles(seconds = 7, seed = 4): Float32Array {
  const r = makeRandom(seed);
  const raw = new Float32Array(Math.floor((seconds + 0.5) * SR));
  const count = Math.floor(seconds * 38);
  for (let k = 0; k < count; k++) {
    const t0 = Math.floor(r() * (raw.length - 3000));
    const f0 = 500 + r() * 1700;
    const dur = 0.012 + r() * 0.04;
    const amp = 0.08 + r() * 0.3;
    const n = Math.floor(dur * SR);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const f = f0 * (1 + 2.2 * (t / dur));
      raw[t0 + i] += Math.sin(TAU * f * t) * Math.exp((-t / dur) * 4) * amp;
    }
  }
  // a thin layer of high noise so it is not purely tonal
  for (let i = 0; i < raw.length; i++) raw[i] += (r() * 2 - 1) * 0.04;
  return seamless(raw);
}

/** Cicada chorus: a bright buzzing carrier with fast amplitude modulation and a slow on/off swell (all modulation periods divide the loop). */
export function cicadas(seconds = 6, seed = 5): Float32Array {
  const r = makeRandom(seed);
  const n = Math.floor(seconds * SR);
  const out = new Float32Array(n);
  const fc = 4300 + r() * 600;
  const swell = Math.round(seconds / 2.4) / seconds;
  const am = Math.round(seconds * 78) / seconds;
  const ph = r() * TAU;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = clamp(0.55 + 0.7 * Math.sin(TAU * swell * t + ph), 0, 1);
    const buzz = 0.5 + 0.5 * Math.sin(TAU * am * t);
    const mod = Math.sin(TAU * fc * t + 5 * Math.sin(TAU * (Math.round(seconds * 120) / seconds) * t));
    out[i] = mod * buzz * env * 0.35 + (r() * 2 - 1) * 0.02 * env;
  }
  return out;
}

/** Crickets: pulsed pure tones in short groups, a few individuals at different pitches and rhythms, in a seamless loop. */
export function crickets(seconds = 8, seed = 6): Float32Array {
  const r = makeRandom(seed);
  const n = Math.floor(seconds * SR);
  const out = new Float32Array(n);
  for (let voice = 0; voice < 3; voice++) {
    const fc = 3300 + voice * 520 + r() * 150;
    const period = seconds / Math.round(seconds / (0.26 + voice * 0.07));
    const pulses = 3 + voice;
    const off = r() * period;
    for (let g = 0; g * period < seconds; g++) {
      const t0 = off + g * period;
      for (let p = 0; p < pulses; p++) {
        const tp = t0 + p * 0.035;
        const i0 = Math.floor(tp * SR) % n;
        const len = Math.floor(0.022 * SR);
        for (let i = 0; i < len; i++) {
          const t = i / SR;
          const e = Math.sin((Math.PI * i) / len);
          out[(i0 + i) % n] += Math.sin(TAU * fc * t) * e * 0.12;
        }
      }
    }
  }
  return out;
}

// ----------------------------------------------------------------------------- calls

interface Voice {
  /** Fundamental frequency (Hz) over normalised time 0..1. */
  f: (t: number) => number;
  /** Amplitude envelope over normalised time. */
  a: (t: number) => number;
  /** Harmonic weights (1 = fundamental). */
  h: number[];
  /** Noise mix 0..1 (breath / rasp). */
  noise?: number;
  /** Amplitude tremolo (Hz, depth 0..1). */
  trem?: [number, number];
}

/** Render a harmonic voice of `dur` seconds. Phase is integrated, so frequency sweeps are click-free. */
function render(v: Voice, dur: number, r: Rng): Float32Array {
  const n = Math.floor(dur * SR);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    ph += (TAU * v.f(t)) / SR;
    let s = 0;
    for (let k = 0; k < v.h.length; k++) s += Math.sin(ph * (k + 1)) * v.h[k];
    let a = v.a(t);
    if (v.trem) a *= 1 - v.trem[1] + v.trem[1] * (0.5 + 0.5 * Math.sin(TAU * v.trem[0] * (i / SR)));
    out[i] = (s * (1 - (v.noise ?? 0)) + (r() * 2 - 1) * (v.noise ?? 0) * 2) * a;
  }
  return out;
}

const env = (t: number, attack = 0.08, release = 0.35) => clamp(Math.min(t / attack, (1 - t) / release, 1), 0, 1);

function mix(parts: { buf: Float32Array; at: number }[], total: number): Float32Array {
  const out = new Float32Array(Math.floor(total * SR));
  for (const p of parts) {
    const o = Math.floor(p.at * SR);
    for (let i = 0; i < p.buf.length && o + i < out.length; i++) out[o + i] += p.buf[i];
  }
  let peak = 1e-6;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const g = 0.8 / peak;
  for (let i = 0; i < out.length; i++) out[i] *= g;
  return out;
}

/** Scarlet macaw: a harsh two-syllable squawk, "rraa-aak": rich harmonics, a falling sweep, raspy noise. */
export function macawCall(seed: number): Float32Array {
  const r = makeRandom(seed);
  const f0 = 780 + r() * 260;
  const a = render({ f: (t) => f0 * (1.25 - 0.45 * t) * (1 + 0.02 * Math.sin(t * 60)), a: (t) => env(t, 0.05, 0.5), h: [1, 0.8, 0.9, 0.7, 0.55, 0.45, 0.3, 0.2], noise: 0.22, trem: [34 + r() * 10, 0.35] }, 0.42, r);
  const b = render({ f: (t) => f0 * (1.4 - 0.7 * t), a: (t) => env(t, 0.04, 0.6) * 0.85, h: [1, 0.85, 0.8, 0.6, 0.5, 0.4, 0.3], noise: 0.25, trem: [38, 0.4] }, 0.5, r);
  return mix([{ buf: a, at: 0 }, { buf: b, at: 0.36 + r() * 0.06 }], 0.95);
}

/** Keel-billed toucan: a dry, frog-like croak "krrrk-krrrk" - fast pulses on a low carrier. */
export function toucanCall(seed: number): Float32Array {
  const r = makeRandom(seed);
  const f0 = 640 + r() * 160;
  const parts: { buf: Float32Array; at: number }[] = [];
  const bursts = 3 + Math.floor(r() * 3);
  for (let k = 0; k < bursts; k++) {
    const d = 0.16 + r() * 0.05;
    parts.push({ buf: render({ f: (t) => f0 * (1 + 0.25 * Math.sin(t * 3)), a: (t) => env(t, 0.1, 0.4), h: [1, 0.9, 0.7, 0.5, 0.35, 0.2], noise: 0.12, trem: [58, 0.7] }, d, r), at: k * (d + 0.07) });
  }
  return mix(parts, bursts * 0.26 + 0.1);
}

/** Small parakeet-like chatter: a string of short, bright, upward chirps. */
export function parakeetCall(seed: number): Float32Array {
  const r = makeRandom(seed);
  const parts: { buf: Float32Array; at: number }[] = [];
  const n = 5 + Math.floor(r() * 5);
  let t = 0;
  for (let k = 0; k < n; k++) {
    const f0 = 2800 + r() * 900;
    const d = 0.045 + r() * 0.035;
    parts.push({ buf: render({ f: (u) => f0 * (1 + 0.55 * u), a: (u) => env(u, 0.1, 0.5) * (0.6 + 0.4 * r()), h: [1, 0.4, 0.15], noise: 0.05 }, d, r), at: t });
    t += d + 0.03 + r() * 0.05;
  }
  return mix(parts, t + 0.05);
}

/** Songbird: a short whistled phrase of 4-7 pure, gliding notes with vibrato. */
export function songbirdCall(seed: number): Float32Array {
  const r = makeRandom(seed);
  const parts: { buf: Float32Array; at: number }[] = [];
  const n = 4 + Math.floor(r() * 4);
  let t = 0;
  let f = 2200 + r() * 900;
  for (let k = 0; k < n; k++) {
    const f1 = clamp(f * (0.75 + r() * 0.6), 1700, 4200);
    const d = 0.09 + r() * 0.14;
    parts.push({ buf: render({ f: (u) => f + (f1 - f) * u + 70 * Math.sin(u * 40), a: (u) => env(u, 0.12, 0.35), h: [1, 0.08], noise: 0.01 }, d, r), at: t });
    t += d + 0.04 + r() * 0.08;
    f = f1;
  }
  return mix(parts, t + 0.05);
}

/** Monkey hoot: three soft, falling "hoo" calls (low harmonic tones with a slow vibrato). */
export function monkeyHoot(seed: number): Float32Array {
  const r = makeRandom(seed);
  const f0 = 420 + r() * 120;
  const parts: { buf: Float32Array; at: number }[] = [];
  for (let k = 0; k < 3; k++) {
    const d = 0.28 + r() * 0.1;
    parts.push({ buf: render({ f: (u) => f0 * (1.18 - 0.3 * u) * (1 + 0.015 * Math.sin(u * 38)), a: (u) => env(u, 0.18, 0.5), h: [1, 0.5, 0.3, 0.18, 0.1], noise: 0.05 }, d, r), at: k * (d + 0.08) });
  }
  return mix(parts, 1.1);
}

/** Spider-monkey whoop: a long descending trill (a sweep from high to low with fast amplitude modulation). */
export function monkeyWhoop(seed: number): Float32Array {
  const r = makeRandom(seed);
  const f0 = 1700 + r() * 400;
  const a = render({ f: (u) => f0 * (1 - 0.62 * u * u) + 40 * Math.sin(u * 55), a: (u) => env(u, 0.06, 0.45), h: [1, 0.55, 0.3, 0.12], noise: 0.06, trem: [16 + r() * 6, 0.6] }, 1.0, r);
  return mix([{ buf: a, at: 0 }], 1.05);
}

export const CALL_MAKERS = {
  macaw: macawCall,
  toucan: toucanCall,
  parakeet: parakeetCall,
  songbird: songbirdCall,
  'monkey-hoot': monkeyHoot,
  'monkey-whoop': monkeyWhoop,
} as const;

/** RMS and peak of a buffer (tests). */
export function stats(buf: Float32Array): { rms: number; peak: number; seconds: number } {
  let s = 0;
  let p = 0;
  for (const v of buf) {
    s += v * v;
    p = Math.max(p, Math.abs(v));
  }
  return { rms: Math.sqrt(s / buf.length), peak: p, seconds: buf.length / SR };
}

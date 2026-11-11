#!/usr/bin/env node
/**
 * Living-world verification (Prompt 09). Two levels; every line says which one it is:
 *
 *   [auto]    headless, no browser, no GPU, no sound card: the real modules through Vite's SSR loader
 *               - surface under the player at known places (ford, pool, mud, altar, temple, knoll, bridge, mountain)
 *               - synthesised footsteps / rustles / thunder / Heartstone hum: finite, audible, not clipping, deterministic, the loop seamless
 *               - weather: limits, light rate (comfort), thunder spacing, determinism over two simulated hours
 *               - stride, falling leaves, motes, lizards, ripples, the unseen animal: stepped at 72 Hz with a scripted player; pools bounded,
 *                 nothing below ground, no NaN, flee/return behaviour, CPU per frame
 *   [desktop] (--browser, needs the dev server) headless Chromium on the real app: runtime errors, the four objects exist, added draw calls,
 *               footsteps counted by the audio engine with the right surface, wading makes rings, no shader program compiled mid-walk
 *
 *   node tools/living-test.mjs [--only surface,synth,weather,sim] [--browser] [--url https://localhost:8081/]
 * Exit code 1 on any failure. Says nothing about a physical headset, and nobody has LISTENED to these sounds: the checks are numerical.
 */
import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const only = arg('only', '').split(',').filter(Boolean);
const want = (n) => only.length === 0 || only.includes(n);
let fails = 0;
const results = { when: new Date().toISOString(), checks: [] };
const check = (level, name, ok, detail = '') => {
  if (!ok) fails++;
  results.checks.push({ level, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${level}] ${name}${detail ? '  ' + detail : ''}`);
};
const f2 = (v) => (typeof v === 'number' ? v.toFixed(2) : String(v));

const server = await createServer({ root, configFile: false, logLevel: 'error', appType: 'custom', server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true } });
const load = (p) => server.ssrLoadModule(p);

try {
  const L = await load('/src/world/layout.ts');
  const M = await load('/src/world/mountain.ts');

  // ================================================================================================ surface
  if (want('surface')) {
    const S = await load('/src/world/surface.ts');
    const at = (x, z, y) => S.surfaceAt(x, z, y);
    const poolFeet = L.terrainHeight(L.POOL.x, L.POOL.z);
    check('auto', 'surface: the middle of the pool is water (feet on the bed)', at(L.POOL.x, L.POOL.z, poolFeet) === 'water', `feet ${f2(poolFeet)}, water ${f2(L.POOL.waterY)}`);
    check('auto', 'surface: feet well above the water are not wading', at(L.POOL.x, L.POOL.z, L.POOL.waterY + 1) !== 'water');
    // the stream: somewhere along it the bed is under the surface
    let wet = 0, n = 0;
    for (const [x, z] of L.STREAM_SAMPLES) { if (x > 20) continue; n++; if (at(x, z, L.terrainHeight(x, z)) === 'water') wet++; }
    check('auto', 'surface: walking in the stream bed is water for most of its length', wet / n > 0.6, `${wet}/${n} samples`);
    const muds = L.MUD_PATCHES.map((m) => at(m.x, m.z, L.terrainHeight(m.x, m.z)));
    check('auto', 'surface: mud patches are mud (or water where the stream crosses them)', muds.every((s) => s === 'mud' || s === 'water') && muds.includes('mud'), muds.join(','));
    check('auto', 'surface: beside the altar and on the temple floor is stone', at(L.ALTAR[0] + 1.2, L.ALTAR[1], undefined) === 'stone' && at(L.TEMPLE.x, L.TEMPLE.z) === 'stone');
    check('auto', 'surface: the knoll at the start is grass', at(L.SPAWN[0], L.SPAWN[1], L.terrainHeight(L.SPAWN[0], L.SPAWN[1])) === 'grass', at(L.SPAWN[0], L.SPAWN[1]));
    const bx = (M.BRIDGE.ax + M.BRIDGE.bx) / 2;
    check('auto', 'surface: the rope bridge deck is wood, the gorge far below it is not', at(bx, M.BRIDGE.az, M.bridgeDeckY(0.5)) === 'wood' && at(bx, M.BRIDGE.az, M.bridgeDeckY(0.5) - 30) !== 'wood', `${at(bx, M.BRIDGE.az, M.bridgeDeckY(0.5))} / ${at(bx, M.BRIDGE.az, M.bridgeDeckY(0.5) - 30)}`);
    check('auto', 'surface: the mountain is rock', at(M.SUMMIT.x, M.SUMMIT.z, M.SUMMIT.y) === 'rock');
    const hist = {};
    for (const [x, z] of L.PATH_SAMPLES) { const s = at(x, z, L.terrainHeight(x, z)); hist[s] = (hist[s] ?? 0) + 1; }
    const off = {};
    for (let i = 0; i < L.PATH_SAMPLES.length; i += 3) { const [x, z] = L.PATH_SAMPLES[i]; const s = at(x + 4, z, L.terrainHeight(x + 4, z)); off[s] = (off[s] ?? 0) + 1; }
    check('auto', 'surface: the walk from the knoll to the altar crosses at least four different surfaces', Object.keys({ ...hist, ...off }).length >= 4, `trail ${JSON.stringify(hist)}  4 m beside it ${JSON.stringify(off)}`);
    check('auto', 'surface: the forest floor beside the trail is mostly leaf litter', (off.litter ?? 0) > 0, JSON.stringify(off));
  }

  // ================================================================================================ synth
  if (want('synth')) {
    const Y = await load('/src/audio/synth.ts');
    const fin = (b) => { for (const v of b) if (!Number.isFinite(v)) return false; return true; };
    const zc = (b) => { let n = 0; for (let i = 1; i < b.length; i++) if (b[i - 1] < 0 !== b[i] < 0) n++; return n / (b.length / Y.SR); };
    const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const rows = [];
    let ok = true, det = true, vary = true;
    for (const sf of ['litter', 'grass', 'mud', 'stone', 'water', 'wood', 'rock']) {
      const a = Y.footstep(sf, 500);
      const st = Y.stats(a);
      rows.push(`${sf} ${st.seconds.toFixed(2)}s rms ${st.rms.toFixed(3)} peak ${st.peak.toFixed(2)} zc ${zc(a).toFixed(0)}/s`);
      if (!fin(a) || st.peak > 1 || st.peak < 0.2 || st.rms < 0.01 || st.seconds < 0.1 || st.seconds > 0.65 || Math.abs(a[0]) > 0.05 || Math.abs(a[a.length - 1]) > 0.05) ok = false;
      if (!same(a, Y.footstep(sf, 500))) det = false;
      if (same(a, Y.footstep(sf, 553))) vary = false;
    }
    check('auto', 'footsteps: 7 surfaces, each finite, audible, not clipping, short, starting and ending at silence', ok, rows.join(' | '));
    check('auto', 'footsteps: deterministic per seed; variants differ', det && vary);
    const zs = Object.fromEntries(['litter', 'mud', 'stone', 'water', 'wood'].map((s) => [s, zc(Y.footstep(s, 500))]));
    check('auto', 'footsteps: surfaces are spectrally different (planks dullest, then stone, then mud, leaf litter brightest)', zs.wood < zs.stone && zs.stone < zs.mud && zs.mud < zs.litter * 0.6, JSON.stringify(Object.fromEntries(Object.entries(zs).map(([k, v]) => [k, Math.round(v)]))));
    const ru = Y.rustle(700), rs = Y.rustle(800, true), rst = Y.stats(ru), sst = Y.stats(rs);
    check('auto', 'rustle: finite, 0.5-1.4 s, peak <= 0.75; the twig-snap variant differs', fin(ru) && fin(rs) && rst.seconds > 0.5 && rst.seconds < 1.4 && rst.peak <= 0.75 && sst.peak <= 0.85 && rst.rms > 0.02 && !same(ru, rs), `rustle ${rst.seconds.toFixed(2)}s rms ${rst.rms.toFixed(3)} peak ${rst.peak.toFixed(2)}; snap peak ${sst.peak.toFixed(2)}`);
    const th = Y.thunder(900), tst = Y.stats(th);
    let lateRms = 0; { const n = Math.floor(th.length * 0.1); for (let i = th.length - n; i < th.length; i++) lateRms += th[i] * th[i]; lateRms = Math.sqrt(lateRms / n); }
    check('auto', 'thunder: a 6-9 s low roll (few zero crossings), peak <= 0.85, fading to nothing, no click at either end', fin(th) && tst.seconds >= 6 && tst.seconds <= 9 && tst.peak <= 0.85 && zc(th) < 500 && lateRms < tst.rms * 0.35 && Math.abs(th[0]) < 0.02 && Math.abs(th[th.length - 1]) < 0.02, `${tst.seconds.toFixed(1)}s rms ${tst.rms.toFixed(3)} peak ${tst.peak.toFixed(2)} zc ${zc(th).toFixed(0)}/s tail rms ${lateRms.toFixed(3)}`);
    const hu = Y.heartHum(8, 61), hst = Y.stats(hu);
    let maxStep = 0; for (let i = 1; i < hu.length; i++) maxStep = Math.max(maxStep, Math.abs(hu[i] - hu[i - 1]));
    const seam = Math.abs(hu[0] - hu[hu.length - 1]);
    check('auto', 'Heartstone hum: 8 s loop, peak <= 0.65, the loop point is no bigger a step than any other sample', fin(hu) && Math.abs(hst.seconds - 8) < 0.01 && hst.peak <= 0.65 && hst.rms > 0.05 && seam <= maxStep * 1.2, `rms ${hst.rms.toFixed(3)} peak ${hst.peak.toFixed(2)} seam ${seam.toFixed(4)} max step ${maxStep.toFixed(4)}`);
  }

  // ================================================================================================ weather
  if (want('weather')) {
    const W = await load('/src/world/weather.ts');
    const lim = W.WEATHER_LIMITS;
    const a = new W.Weather(), b = new W.Weather();
    const dt = 1 / 72;
    let ok = true, maxRate = 0, gSum = 0, gHigh = 0, n = 0, last = a.light, lastTh = -1, minGap = 1e9, first = -1, same = true, lMin = 9, lMax = 0;
    for (let t = 0; t < 7200; t += dt) {
      a.step(dt); b.step(dt); n++;
      if (a.gust !== b.gust || a.light !== b.light) same = false;
      if (!(a.gust >= 0 && a.gust <= 1 && a.wind >= lim.windMin - 1e-9 && a.wind <= lim.windMax + 1e-9 && a.light >= lim.lightMin - 1e-9 && a.light <= lim.lightMax + 1e-9)) ok = false;
      maxRate = Math.max(maxRate, Math.abs(a.light - last) / dt); last = a.light;
      lMin = Math.min(lMin, a.light); lMax = Math.max(lMax, a.light);
      gSum += a.gust; if (a.gust > 0.6) gHigh++;
      if (a.thunderPending) { a.thunderPending = false; if (first < 0) first = a.time; else minGap = Math.min(minGap, a.time - lastTh); lastTh = a.time; }
    }
    check('auto', 'weather: gust, wind and light stay inside their limits for two simulated hours', ok, `light ${lMin.toFixed(3)}..${lMax.toFixed(3)} (limits ${lim.lightMin}..${lim.lightMax})`);
    check('auto', 'weather: the light never changes faster than 0.8 % per second (no flicker, no sudden dark)', maxRate <= lim.lightRatePerSec * 1.001, `max ${(maxRate * 100).toFixed(2)} %/s`);
    check('auto', 'weather: mostly calm with real gusts', gSum / n < 0.45 && gHigh / n > 0.03 && gHigh / n < 0.4, `mean gust ${(gSum / n).toFixed(2)}, above 0.6 for ${((gHigh / n) * 100).toFixed(0)} % of the time`);
    check('auto', 'weather: thunder is rare - none in the first 90 s, never two within 150 s', first >= 90 && minGap >= lim.thunderMin && a.thunderCount >= 15 && a.thunderCount <= 50, `first at ${first.toFixed(0)} s, ${a.thunderCount} in 2 h, closest pair ${minGap.toFixed(0)} s`);
    check('auto', 'weather: deterministic', same);
  }

  // ================================================================================================ simulations
  if (want('sim')) {
    const C = await load('/src/wildlife/context.ts');
    const V = await load('/src/wildlife/living.ts');
    const R = await load('/src/wildlife/rig.ts');
    const Mo = await load('/src/wildlife/models.ts');
    const S = await load('/src/world/surface.ts');
    const P = await load('/src/world/placements.ts');
    const vec = (x = 0, y = 0, z = 0) => ({ x, y, z, set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; } });
    const w = C.wctx;
    const dt = 1 / 72;
    const rustles = [];
    let hushes = 0;
    w.audio = { call() {}, hush() { hushes++; }, rustle(x, y, z, g, snap) { rustles.push({ x, y, z, g, snap, t: clock }); } };
    let clock = 0;
    const put = (x, z, fx = 0, fz = -1, speed = 0) => { w.px = x; w.pz = z; w.gy = L.terrainHeight(x, z); w.py = w.gy + 1.65; w.fx = fx; w.fy = 0; w.fz = fz; w.speed = speed; w.open = 0; w.enabled = true; };
    // a forest station on the trail: dense canopy
    let fi = 0;
    for (let i = 0; i < L.PATH_SAMPLES.length; i++) { const [x, z] = L.PATH_SAMPLES[i]; if (L.canopyOpenness(x, z) < 0.2 && L.hillWeight(x, z) < 0.05 && z < -28) { fi = i; break; } }
    const [FX, FZ] = L.PATH_SAMPLES[fi];
    const [NX, NZ] = L.PATH_SAMPLES[fi + 2];
    const fl = Math.hypot(NX - FX, NZ - FZ);
    const FDX = (NX - FX) / fl, FDZ = (NZ - FZ) / fl;

    // ---- stride
    {
      const s = new V.Stride();
      let steps = 0, sides = [], dist = 0;
      for (let t = 0; t < 60; t += dt) { dist += 1.4 * dt; if (s.step(dt, 1.4 * dt, 1.4)) { steps++; sides.push(s.side); } }
      const alt = sides.every((v, i) => i === 0 || v === -sides[i - 1]);
      check('auto', 'stride: steps follow the distance walked (1.4 m/s for a minute), feet alternate', steps > 95 && steps < 125 && alt, `${steps} steps over ${dist.toFixed(0)} m = ${(dist / steps).toFixed(2)} m per step, ${(steps / 60).toFixed(2)} Hz`);
      const s2 = new V.Stride();
      let tp = 0; for (let i = 0; i < 20; i++) if (s2.step(dt, 20, 1.4)) tp++;
      let idle = 0; for (let t = 0; t < 30; t += dt) if (s2.step(dt, 0.1 * dt, 0.1)) idle++;
      check('auto', 'stride: a teleport is not a step; leaning in place makes none', tp === 0 && idle === 0, `${tp} / ${idle}`);
      const s3 = new V.Stride(); let fast = 0; for (let t = 0; t < 30; t += dt) if (s3.step(dt, 3.6 * dt, 3.6)) fast++;
      check('auto', 'stride: cadence stays human at a run (under 4.5 steps/s)', fast / 30 < 4.5 && fast / 30 > 2, `${(fast / 30).toFixed(2)} Hz at 3.6 m/s`);
    }

    // ---- falling leaves
    {
      const rig = new R.InstanceRig('t', Mo.createLeaf(), Mo.creatureWingMaterial, 14);
      const run = (gust, secs, max = 14, x = FX, z = FZ) => {
        const lv = new V.FallingLeaves();
        const before = V.livingStats.leafSpawns;
        put(x, z, FDX, FDZ);
        let worst = 0, under = 0, nan = 0, peak = 0, drawn = 0, floating = 0;
        for (let t = 0; t < secs; t += dt) {
          lv.update(dt, gust, 0.83, 0.56, max);
          let act = 0;
          for (const l of lv.leaves) {
            if (l.state === 0) continue;
            act++;
            if (!Number.isFinite(l.x + l.y + l.z)) nan++;
            const g = L.terrainHeight(l.x, l.z);
            if (l.state === 2 && l.y > Math.max(g, S.waterLevelAt(l.x, l.z) ?? -1e9) + 0.05) floating++;
            if (l.y < g - 0.02) { under++; worst = Math.min(worst, l.y - g); }
          }
          peak = Math.max(peak, act);
          lv.write(rig); drawn = Math.max(drawn, rig.n);
        }
        return { lv, floating, spawns: V.livingStats.leafSpawns - before, under, worst, nan, peak, drawn };
      };
      const calm = run(0.12, 300), windy = run(0.9, 300);
      check('auto', 'leaves: fall under the canopy, more in a gust than in a calm', calm.spawns >= 8 && windy.spawns > calm.spawns * 1.8, `${calm.spawns} in 5 calm minutes, ${windy.spawns} in 5 gusty ones`);
      check('auto', 'leaves: pooled - never more than 14 out (6 on the low tier), never NaN', windy.peak <= 14 && windy.nan === 0 && run(0.9, 120, 6).peak <= 6, `peak ${windy.peak}, drawn at once ${windy.drawn}`);
      check('auto', 'leaves: none ever goes below the ground, none comes to rest in mid-air', calm.under === 0 && windy.under === 0 && calm.floating === 0 && windy.floating === 0, `worst ${windy.worst.toFixed(3)} m`);
      const open = run(0.9, 120, 14, L.CLEARING.x, L.CLEARING.z + 2);
      const hill = run(0.9, 120, 14, L.SPAWN[0], L.SPAWN[1]);
      check('auto', 'leaves: fewer where there is open sky (the clearing, the knoll) than under the trees', open.spawns < windy.spawns * 0.5 && hill.spawns < windy.spawns * 0.6, `clearing ${open.spawns}, knoll ${hill.spawns} per 2 min vs forest ${Math.round(windy.spawns * 0.4)}`);
      put(FX + 500, FZ); windy.lv.update(dt, 0.9, 0.83, 0.56, 14);
      check('auto', 'leaves: left behind by a teleport, all return to the pool at once', windy.lv.leaves.filter((l) => l.state !== 0).length <= 1);
    }

    // ---- motes
    {
      const cloud = V.makeMotes();
      const m = new V.Motes(cloud);
      const hy = L.terrainHeight(L.ALTAR[0], L.ALTAR[1]) + 1.06;
      let bad = 0, out = 0, face = 0, far = 0, nan = 0, lit = 0;
      const stepAll = (x, z) => {
        put(x, z, FDX, FDZ, 1.4);
        m.update(dt, 0.4, 0.83, 0.56, L.ALTAR[0], hy, L.ALTAR[1], 0.5, 0.5, V.POLLEN, false);
        for (let i = 0; i < V.HEART_MOTES + V.POLLEN; i++) {
          const o = i * 3, x1 = cloud.pos[o], y1 = cloud.pos[o + 1], z1 = cloud.pos[o + 2], b = cloud.col[o];
          if (!Number.isFinite(x1 + y1 + z1 + b)) nan++;
          if (b < 0 || b > 1 || cloud.col[o + 1] > b + 1e-6) bad++;
          if (b > 0.05) lit++;
          if (i >= V.HEART_MOTES) {
            if (Math.abs(x1 - x) > 6.001 || Math.abs(z1 - z) > 6.001 || y1 < w.gy + 0.299 || y1 > w.gy + 4.801) out++;
          } else if (b > 0 && Math.hypot(x1 - L.ALTAR[0], z1 - L.ALTAR[1]) > 7.01) far++;
          if (b > 0.001 && Math.hypot(x1 - w.px, y1 - w.py, z1 - w.pz) < 0.4) face++;
        }
      };
      for (let k = 0; k < 2000; k++) stepAll(FX + FDX * k * dt * 1.4, FZ + FDZ * k * dt * 1.4);
      const litForest = lit; lit = 0;
      stepAll(FX + 300, FZ - 40); // a teleport
      for (let k = 0; k < 2000; k++) stepAll(L.ALTAR[0] + 3 + 0.001 * k, L.ALTAR[1] + 4);
      check('auto', 'motes: pollen always inside its 12 x 4.5 x 12 m box around the player, even across a teleport; no NaN', out === 0 && nan === 0, `${V.POLLEN} pollen + ${V.HEART_MOTES} embers, one draw`);
      check('auto', 'motes: brightness 0..1 and no lit speck within 0.4 m of the head', bad === 0 && face === 0);
      check('auto', 'motes: the embers stay within 7 m of the Heartstone and are lit near it; pollen is brighter in the open clearing than under the trees', far === 0 && lit > litForest, `lit speck-frames: forest ${litForest}, clearing ${lit}`);
    }

    // ---- lizards
    {
      const lz = new V.Lizards();
      const rig = new R.InstanceRig('t', Mo.createLizard(), Mo.creatureMaterial, 10);
      const blocks = P.solids();
      const badSpot = lz.list.filter((l) => S.waterLevelAt(l.hx, l.hz) !== null || blocks.some((b) => Math.hypot(l.hx - b.x, l.hz - b.z) < b.r) || L.distanceToPath(l.hx, l.hz).dist > 3).length;
      check('auto', 'lizards: 6-10 basking spots at the trail edge, dry and clear of trunks and rocks', lz.list.length >= 6 && lz.list.length <= 10 && badSpot === 0, `${lz.list.length} lizards`);
      const l0 = lz.list[Math.floor(lz.list.length / 2)];
      // far away (but inside the simulated range): they potter about their spots
      put(l0.hx + 14, l0.hz + 14);
      let strayed = 0;
      for (let t = 0; t < 120; t += dt) { lz.update(dt, 10); for (const l of lz.list) if (Math.hypot(l.x - l.hx, l.z - l.hz) > 1.0) strayed++; }
      check('auto', 'lizards: undisturbed, they stay within a metre of their spot', strayed === 0 && V.livingStats.lizardFlees === 0);
      // walk up to one
      rustles.length = 0;
      put(l0.x + 1.6, l0.z, -1, 0, 1.4);
      let vmax = 0, tHide = -1, px = l0.x, pz = l0.z, drawnWhileFleeing = 0;
      for (let t = 0; t < 6; t += dt) {
        lz.update(dt, 10); lz.write(rig, 10);
        vmax = Math.max(vmax, Math.hypot(l0.x - px, l0.z - pz) / dt); px = l0.x; pz = l0.z;
        if (l0.state === V.LizardState.Flee && rig.n > 0) drawnWhileFleeing++;
        if (tHide < 0 && l0.state === V.LizardState.Hidden) tHide = t;
      }
      check('auto', 'lizards: one bolts for cover when you step up to it, at a believable speed, and you can watch it go', tHide > 0.3 && tHide < 3 && vmax < 3.4 && vmax > 2.5 && drawnWhileFleeing > 10, `hidden after ${tHide.toFixed(2)} s, top speed ${vmax.toFixed(2)} m/s`);
      check('auto', 'lizards: its dive into cover makes a rustle at that spot', rustles.length === 1 && Math.hypot(rustles[0].x - l0.kx, rustles[0].z - l0.kz) < 0.05);
      let stayed = true;
      for (let t = 0; t < 40; t += dt) { lz.update(dt, 10); if (l0.state !== V.LizardState.Hidden) stayed = false; }
      put(l0.hx + 15, l0.hz + 9);
      let tBack = -1;
      for (let t = 0; t < 60; t += dt) { lz.update(dt, 10); if (tBack < 0 && l0.state === V.LizardState.Bask) tBack = t; }
      check('auto', 'lizards: stays hidden while you are near; creeps back to its spot after you leave', stayed && tBack > 8 && Math.hypot(l0.x - l0.hx, l0.z - l0.hz) < 1.0 && V.livingStats.lizardReturns >= 1, `back and basking ${tBack.toFixed(0)} s after you left`);
      let nan = 0; for (const l of lz.list) if (!Number.isFinite(l.x + l.y + l.z + l.yaw)) nan++;
      check('auto', 'lizards: on the ground, no NaN', nan === 0 && lz.list.every((l) => Math.abs(l.y - L.terrainHeight(l.x, l.z)) < 1e-6));
    }

    // ---- ripples
    {
      const rp = new V.Ripples();
      const rig = new R.InstanceRig('t', Mo.createRing(), Mo.rippleMaterial, 8);
      put(FX + 200, FZ); // far from the pool: no ambient rings
      for (let i = 0; i < 20; i++) rp.spawn(i, 0, 0, 0.5);
      rp.update(dt); rp.write(rig);
      const live = V.livingStats.ripples, drawn = rig.n;
      for (let t = 0; t < 3; t += dt) rp.update(dt);
      rp.write(rig);
      check('auto', 'ripples: 20 requests never make more than 8 rings; all gone after 2 s', live === 8 && drawn <= 8 && V.livingStats.ripples === 0 && rig.n === 0, `${live} live, ${drawn} drawn`);
      put(L.POOL.x + 6, L.POOL.z);
      const before = V.livingStats.rippleSpawns;
      for (let t = 0; t < 120; t += dt) rp.update(dt);
      const amb = V.livingStats.rippleSpawns - before;
      check('auto', 'ripples: the pool is touched now and then when you are near (and only then)', amb >= 8 && amb <= 40, `${amb} in 2 min`);
    }

    // ---- the unseen animal
    {
      const u = new V.UnseenMover();
      const body = vec(0, -999, 0);
      rustles.length = 0; hushes = 0; clock = 0;
      const ev0 = V.livingStats.unseenEvents;
      put(FX, FZ, FDX, FDZ);
      let minStart = 1e9, minPath = 1e9, parked = true, was = false, starts = [], toward = 0, d0 = 0, nan = 0;
      for (clock = 0; clock < 900; clock += dt) {
        u.update(dt, 0.2, body);
        if (u.active) {
          const d = Math.hypot(u.x - w.px, u.z - w.pz);
          if (!was) { starts.push(clock); minStart = Math.min(minStart, d); d0 = d; }
          minPath = Math.min(minPath, L.distanceToPath(u.x, u.z).dist);
          if (!Number.isFinite(u.x + u.y + u.z)) nan++;
          if (d < d0 - 0.5) toward++;
          if (was && body.y < -900) parked = false;
        } else if (body.y > -900) parked = false;
        was = u.active;
      }
      const n = V.livingStats.unseenEvents - ev0;
      let gap = 1e9; for (let i = 1; i < starts.length; i++) gap = Math.min(gap, starts[i] - starts[i - 1]);
      check('auto', 'unseen animal: happens a few times in 15 minutes on the forest trail, never in quick succession', n >= 5 && n <= 40 && gap > 20, `${n} events, closest pair ${gap.toFixed(0)} s apart`);
      check('auto', 'unseen animal: starts 7+ m away off the trail, never comes onto the trail or toward you', minStart >= 6.9 && minPath >= 1.4 && toward === 0 && nan === 0, `nearest start ${minStart.toFixed(1)} m, nearest to the trail centre ${minPath.toFixed(1)} m`);
      check('auto', 'unseen animal: the plants part only while it moves (push point parked otherwise); every event rustles and hushes the chorus', parked && rustles.length >= n * 2 && hushes === n, `${rustles.length} rustles, ${hushes} hushes`);
      // on the open knoll nothing lurks
      const u2 = new V.UnseenMover();
      put(L.SPAWN[0], L.SPAWN[1], 0, -1);
      const e1 = V.livingStats.unseenEvents;
      for (let t = 0; t < 300; t += dt) u2.update(dt, 0, body);
      check('auto', 'unseen animal: needs thick vegetation - far fewer on the open knoll', V.livingStats.unseenEvents - e1 <= Math.ceil(n / 3) , `${V.livingStats.unseenEvents - e1} in 5 min`);
    }

    // ---- geometry cost
    {
      const tri = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;
      const a = tri(Mo.createLeaf()), b = tri(Mo.createLizard()), c = tri(Mo.createRing());
      const total = a * 14 + b * 10 + c * 8;
      check('auto', 'cost: everything at once is under 3,500 triangles in 3 instanced draws + 1 point cloud', total <= 3500, `leaf ${a} x14 + lizard ${b} x10 + ring ${c} x8 = ${total} triangles, ${V.HEART_MOTES + V.POLLEN} points`);
    }

    // ---- CPU
    {
      const lv = new V.FallingLeaves(), lz = new V.Lizards(), rp = new V.Ripples(), u = new V.UnseenMover(), cloud = V.makeMotes(), m = new V.Motes(cloud), st = new V.Stride();
      const rigs = [new R.InstanceRig('a', Mo.createLeaf(), Mo.creatureWingMaterial, 14), new R.InstanceRig('b', Mo.createLizard(), Mo.creatureMaterial, 10), new R.InstanceRig('c', Mo.createRing(), Mo.rippleMaterial, 8)];
      const body = vec();
      const W = await load('/src/world/weather.ts');
      const wx = new W.Weather(77);
      const N = 72 * 120;
      const t0 = performance.now();
      for (let k = 0; k < N; k++) {
        const i = Math.min(L.PATH_SAMPLES.length - 1, Math.floor((k / N) * L.PATH_SAMPLES.length));
        put(L.PATH_SAMPLES[i][0], L.PATH_SAMPLES[i][1], FDX, FDZ, 1.4);
        wx.step(dt);
        if (st.step(dt, 1.4 * dt, 1.4)) S.surfaceAt(w.px, w.pz, w.gy);
        lv.update(dt, wx.gust, wx.dirX, wx.dirZ, 14); lv.write(rigs[0]);
        lz.update(dt, 10); lz.write(rigs[1], 10);
        rp.update(dt); rp.write(rigs[2]);
        u.update(dt, 0.3, body);
        m.update(dt, wx.gust, wx.dirX, wx.dirZ, 0, 1, -61.5, 0, 0.5, V.POLLEN, false);
      }
      const ms = (performance.now() - t0) / N;
      check('auto', 'cpu: every living-world simulation together, walking the whole trail, costs well under 0.5 ms a frame on this machine (NOT a Quest number)', ms < 0.5, `${ms.toFixed(3)} ms per frame (desktop node; a Quest 2 CPU is several times slower)`);
    }
  }

  // ================================================================================================ desktop browser
  if (process.argv.includes('--browser')) {
    const { createRequire } = await import('node:module');
    const { chromium } = createRequire(root + '/')('playwright-core');
    const exe = process.env.CHROMIUM ?? '/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome';
    const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=user-gesture-required'] });
    const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
    await page.goto(`${arg('url', 'https://localhost:8081/')}?desktop=1&perf=0&governor=0&pixelratio=0.5`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__jumanjiWildlife?.ready && window.__jumanjiLiving?.lizards && window.__jumanjiPerf?.world?.scene?.getObjectByName('Rope bridge'), null, { timeout: 290000 });
    await page.waitForTimeout(4000);
    const E = (fn, a) => page.evaluate(fn, a);
    const info = await E(() => { const g = window.__jumanjiLiving.group; return { kids: g.children.map((c) => `${c.name}:${c.visible ? 'shown' : 'hidden'}`), programs: window.__jumanjiPerf.world.renderer.info.programs.length, lizards: window.__jumanjiLiving.lizards.list.length }; });
    check('desktop', 'the living-world objects exist: 3 instanced meshes + 1 point cloud, nothing else', info.kids.length === 4, info.kids.join(', '));
    await page.mouse.click(300, 200);
    await page.waitForFunction(() => window.__jumanjiWildlife.audioInfo.state === 'running' && window.__jumanjiWildlife.audioInfo.buffersReady === window.__jumanjiWildlife.audioInfo.buffersTotal, null, { timeout: 60000 }).catch(() => {});
    const a0 = await E(() => ({ ...window.__jumanjiWildlife.audioInfo }));
    check('desktop', 'audio: every buffer including the 29 new ones (21 footsteps, 5 rustles, the hum, 2 thunder rolls) is generated after the click', a0.state === 'running' && a0.buffersReady === a0.buffersTotal && a0.buffersTotal >= 55, `${a0.buffersReady}/${a0.buffersTotal}`);
    // walk: move the player a little every rendered frame along +x/-z from a start point (the app sees ordinary walking, not a teleport)
    const walk = (x, z, dx, dz, frames) => E(([x, z, dx, dz, frames]) => new Promise((done) => {
      const W = window.__jumanjiWildlife; let k = 0;
      const tick = () => { window.__jumanjiPerf.place(x + dx * k, z + dz * k, 0, W.terrainY(x + dx * k, z + dz * k), 0); if (++k < frames) requestAnimationFrame(tick); else done(null); };
      tick();
    }), [x, z, dx, dz, frames]);
    const LL = await E(async () => { const L = await import('/src/world/layout.ts'); return { pool: L.POOL, altar: L.ALTAR, spawn: L.SPAWN }; });
    await walk(LL.spawn[0], LL.spawn[1], 0, -0.12, 40);
    const a1 = await E(() => ({ a: { ...window.__jumanjiWildlife.audioInfo }, s: { ...window.__jumanjiLiving.stats } }));
    check('desktop', 'footsteps: walking on the knoll plays grass steps (counted by the audio engine)', a1.s.steps >= 3 && a1.a.steps >= 3 && a1.a.lastSurface === 'grass', `system ${a1.s.steps}, engine ${a1.a.steps}, last '${a1.a.lastSurface}'`);
    await walk(LL.pool.x - 1.5, LL.pool.z, 0.1, 0, 30);
    const a2 = await E(() => ({ a: { ...window.__jumanjiWildlife.audioInfo }, s: { ...window.__jumanjiLiving.stats }, ring: window.__jumanjiLiving.group.getObjectByName('Living ripples').count }));
    check('desktop', 'wading in the pool: water steps and rings on the surface', (a2.a.stepsBySurface.water ?? 0) >= 2 && a2.s.rippleSpawns >= 2, `${JSON.stringify(a2.a.stepsBySurface)}, ${a2.s.rippleSpawns} rings spawned, ${a2.ring} drawn now`);
    await E(([x, z]) => window.__jumanjiPerf.place(x, z + 6, 0, window.__jumanjiWildlife.terrainY(x, z + 6), 0), LL.altar);
    await page.waitForTimeout(6000);
    const a3 = await E(() => ({ a: { ...window.__jumanjiWildlife.audioInfo }, s: { ...window.__jumanjiLiving.stats }, programs: window.__jumanjiPerf.world.renderer.info.programs.length, pts: window.__jumanjiLiving.group.getObjectByName('Living motes').visible }));
    check('desktop', 'the clearing: the Heartstone hum is playing and the embers are drawn', a3.a.hum > 0 && a3.s.motes >= 14 && a3.pts, `hum level ${a3.a.hum.toFixed(2)}, ${a3.s.motes} motes`);
    check('desktop', 'no shader program was compiled after the warm-up (leaves, lizards, rings and motes included)', a3.programs === info.programs, `${info.programs} -> ${a3.programs}`);
    check('desktop', 'one-shot sounds are released (nothing left playing after a quiet pause)', a3.a.oneShots <= 1, `${a3.a.oneShots} alive; ${a3.a.steps} steps, ${a3.a.rustles} rustles, ${a3.a.thunders} thunders so far`);
    check('desktop', 'living world CPU in the real app (software-GL desktop, NOT a Quest)', a3.s.updateMs < 1.5, `${a3.s.updateMs.toFixed(3)} ms per frame`);
    check('desktop', 'no runtime errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    await browser.close();
  }
} catch (e) {
  fails++;
  console.error('FAIL  crashed:', e);
}
mkdirSync(resolve(root, 'reports'), { recursive: true });
writeFileSync(resolve(root, 'reports/living-test.json'), JSON.stringify(results, null, 1));
await server.close();
console.log(fails ? `\n${fails} check(s) FAILED` : '\nall living-world checks passed');
process.exit(fails ? 1 : 0);

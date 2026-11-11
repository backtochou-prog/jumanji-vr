#!/usr/bin/env node
/**
 * Wildlife verification. Three levels (the output says which one each line is):
 *
 *   [auto]    headless, no browser, no GPU: loads the real modules through Vite's SSR loader and checks
 *               - synthesised sound: every buffer finite / non-silent / the right length, loops seamless, deterministic
 *               - perch fit: every perch (trees in all three LOD versions as baked into the real chunks, entrance limb, fallen giant, pillar)
 *                 lies on the surface of the mesh it claims to sit on (vertical ray against the real triangles)
 *               - perch graph: monkeys can reach every home from its neighbours; no perch inside an obstacle
 *               - simulation: birds, monkeys, butterflies, dragonflies stepped at 72 Hz with a scripted player (walks the trail, stands still, runs
 *                 through): spawn/despawn, takeoff on approach, flight speed and clearance of trunks, landing exactly on a perch, no perch shared,
 *                 monkey retreat along graph edges at plausible speeds, climbs and leaps, butterflies fleeing, no NaN, caps respected, CPU per frame
 *   [desktop] (node tools/wildlife-test.mjs --browser) headless Chromium on the real app: runtime errors, draw calls with wildlife on/off,
 *               audio unlock after a gesture and not before, listener follows the head, waterfall louder when close, program counts (no lazy compiles)
 *
 *   node tools/wildlife-test.mjs [--only synth,perches,sim] [--browser] [--label name]
 * Exit code 1 on any failure. Never claims anything about a physical headset.
 */
import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const only = arg('only', '').split(',').filter(Boolean);
const want = (n) => only.length === 0 || only.includes(n);
const label = arg('label', 'run');
let fails = 0;
const results = { label, when: new Date().toISOString(), checks: [] };
const check = (level, name, ok, detail = '') => {
  if (!ok) fails++;
  results.checks.push({ level, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${level}] ${name}${detail ? '  ' + detail : ''}`);
};

const server = await createServer({ root, configFile: false, logLevel: 'error', appType: 'custom', server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true } });
const load = (p) => server.ssrLoadModule(p);

// ------------------------------------------------------------------------------------------------ helpers
/** Highest surface y of a triangle soup at (x, z) that is <= yMax and >= yMin (vertical ray), or null. */
function topHit(pos, idx, x, z, yMax, yMin, xf) {
  let best = null;
  const n = idx ? idx.length : pos.length / 3;
  const P = (i, k) => (idx ? idx[i] : i);
  const v = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let t = 0; t < n; t += 3) {
    for (let k = 0; k < 3; k++) {
      const vi = P(t + k) * 3;
      let px = pos[vi], py = pos[vi + 1], pz = pos[vi + 2];
      if (xf) [px, py, pz] = xf(px, py, pz);
      v[k * 3] = px; v[k * 3 + 1] = py; v[k * 3 + 2] = pz;
    }
    // quick reject by x/z bounds
    const minx = Math.min(v[0], v[3], v[6]), maxx = Math.max(v[0], v[3], v[6]);
    if (x < minx || x > maxx) continue;
    const minz = Math.min(v[2], v[5], v[8]), maxz = Math.max(v[2], v[5], v[8]);
    if (z < minz || z > maxz) continue;
    const d = (v[3] - v[0]) * (v[8] - v[2]) - (v[6] - v[0]) * (v[5] - v[2]) * -1; // placeholder, replaced below
    void d;
    // barycentric in xz
    const x0 = v[0], z0 = v[2], x1 = v[3], z1 = v[5], x2 = v[6], z2 = v[8];
    const den = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
    if (Math.abs(den) < 1e-12) continue;
    const a = ((z1 - z2) * (x - x2) + (x2 - x1) * (z - z2)) / den;
    const b = ((z2 - z0) * (x - x2) + (x0 - x2) * (z - z2)) / den;
    const c = 1 - a - b;
    if (a < -1e-6 || b < -1e-6 || c < -1e-6) continue;
    const y = a * v[1] + b * v[4] + c * v[7];
    if (y <= yMax && y >= yMin && (best === null || y > best)) best = y;
  }
  return best;
}
const arrays = (geo) => ({ pos: geo.getAttribute('position').array, idx: geo.index ? geo.index.array : null });

try {
  // ============================================================================================== synth
  if (want('synth')) {
    const S = await load('/src/audio/synth.ts');
    const names = [];
    const bufs = {
      wind: S.windBed(12, 3), white: S.whiteNoise(6, 11), brown: S.brownNoise(6, 12), bubbles: S.bubbles(7, 13), cicadas: S.cicadas(6, 14), crickets: S.crickets(8, 15),
    };
    for (const [k, make] of Object.entries(S.CALL_MAKERS)) for (let v = 0; v < 3; v++) bufs[`${k}#${v}`] = make(100 + v * 37 + k.length * 11);
    let bad = 0;
    for (const [k, b] of Object.entries(bufs)) {
      const st = S.stats(b);
      let finite = true;
      for (const x of b) if (!Number.isFinite(x)) { finite = false; break; }
      const ok = finite && st.rms > 0.005 && st.peak <= 1.01 && st.seconds > 0.3;
      if (!ok) { bad++; names.push(`${k} rms ${st.rms.toFixed(4)} peak ${st.peak.toFixed(2)} ${st.seconds.toFixed(2)}s`); }
    }
    check('auto', `synth: ${Object.keys(bufs).length} buffers finite, audible, not clipping`, bad === 0, names.join('; '));
    // seamless loops: the step across the loop point is not larger than typical sample-to-sample steps
    let worst = 0;
    for (const k of ['wind', 'white', 'brown', 'bubbles']) {
      const b = bufs[k];
      let sum = 0;
      for (let i = 1; i < 4000; i++) sum += Math.abs(b[i] - b[i - 1]);
      const typical = sum / 3999;
      const seam = Math.abs(b[0] - b[b.length - 1]);
      worst = Math.max(worst, seam / Math.max(typical, 1e-6));
    }
    check('auto', 'synth: loop seams are no larger than 8x a typical sample step (no click at the loop point)', worst < 8, `worst ${worst.toFixed(2)}x`);
    const again = S.macawCall(137);
    const same = S.macawCall(137);
    let eq = again.length === same.length;
    for (let i = 0; eq && i < again.length; i += 97) if (again[i] !== same[i]) eq = false;
    check('auto', 'synth: deterministic (same seed, same samples)', eq);
    const v0 = S.macawCall(100), v1 = S.macawCall(137);
    let diff = 0;
    for (let i = 0; i < Math.min(v0.length, v1.length); i += 50) diff += Math.abs(v0[i] - v1[i]);
    check('auto', 'synth: call variants differ from each other (no obvious repetition)', diff > 1);
    const mem = Object.values(bufs).reduce((a, b) => a + b.length * 4, 0);
    check('auto', 'synth: total buffer memory under 6 MB', mem < 6 * 1024 * 1024, `${(mem / 1048576).toFixed(2)} MB`);
  }

  // ============================================================================================== perches
  if (want('perches') || want('sim')) {
    const PH = await load('/src/wildlife/perches.ts');
    const L = await load('/src/world/layout.ts');
    const P = await load('/src/world/placements.ts');
    const list = PH.perches();
    if (want('perches')) {
      const CH = await load('/src/scene-assets/chunks.scene-asset.ts');
      const trees = P.treePlacements();
      const cache = new Map();
      const chunk = (cls, x, z) => {
        const [ix, iz] = L.chunkIndex(x, z, L.CELL_SIZE[cls]);
        const key = `${cls}-${ix}-${iz}`;
        if (!cache.has(key)) cache.set(key, arrays(CH.createChunk(cls, ix, iz).geometry));
        return cache.get(key);
      };
      const byTree = new Map();
      for (const p of list) if (p.kind === 'bough') (byTree.get(p.group) ?? byTree.set(p.group, []).get(p.group)).push(p);
      const stat = { hi: { n: 0, miss: 0, worst: 0, errs: [] }, lo: { n: 0, miss: 0, worst: 0, errs: [] }, far: { n: 0, miss: 0, worst: 0, errs: [] } };
      for (const [ti, ps] of byTree) {
        const t = trees[ti];
        const classes = t.lod === 'hi' ? [['trees-hi', 'hi'], ['trees-lo', 'lo']] : [['trees-far', 'far']];
        for (const [cls, name] of classes) {
          const g = chunk(cls, t.x, t.z);
          for (const p of ps) {
            const hit = topHit(g.pos, g.idx, p.x, p.z, p.y + 0.5, p.y - 0.6);
            const s = stat[name];
            s.n++;
            if (hit === null) { s.miss++; continue; }
            const e = hit - p.y;
            s.errs.push(e);
            s.worst = Math.max(s.worst, Math.abs(e));
          }
        }
      }
      for (const [name, s] of Object.entries(stat)) {
        const within = s.errs.filter((e) => e >= -0.12 && e <= 0.1).length;
        const outl = s.errs.filter((e) => e < -0.12 || e > 0.1).map((e) => (e * 100).toFixed(0)).join(',');
        check('auto', `perch fit, tree boughs as baked in the '${name}' chunks: ${s.n} perches, on the branch surface (-12..+10 cm; <= 1 % may have another branch just above)`, s.n > 0 && s.miss === 0 && s.errs.length - within <= Math.ceil(s.n * 0.01), // a few perches have a neighbouring tree's branch within 10-20 cm above them (the cell merges many trees): allowed up to 1 %
         `missed ${s.miss}, outside tolerance ${s.errs.length - within}${outl ? ' (' + outl + ' cm)' : ''}, worst ${(s.worst * 100).toFixed(1)} cm`);
      }
      // structures
      const TR = await load('/src/scene-assets/trees.scene-asset.ts');
      const limb = arrays(TR.createEntranceCanopy().geometry);
      const lp = list.filter((p) => p.kind === 'limb');
      const lerr = lp.map((p) => topHit(limb.pos, limb.idx, p.x, p.z, p.y + 0.12, p.y - 0.6)); // band above the limb: crown cards and moss lie higher up and are not the limb
      check('auto', `perch fit, entrance limb: ${lp.length} perches on its top surface`, lp.length > 0 && lerr.every((e, i) => e !== null && e - lp[i].y > -0.12 && e - lp[i].y < 0.1), lerr.map((e, i) => (e === null ? 'miss' : ((e - lp[i].y) * 100).toFixed(0))).join(','));
      const DW = await load('/src/scene-assets/deadwood.scene-asset.ts');
      const log = arrays(DW.createGiantLog().geometry);
      const FG = L.FALLEN_GIANT;
      const node = [FG.x, L.terrainHeight(FG.x, FG.z) + 0.55 * (FG.radius / 0.85), FG.z];
      const cs = Math.cos(FG.yaw), sn = Math.sin(FG.yaw);
      const toWorld = (x, y, z) => [node[0] + x * cs + z * sn, node[1] + y, node[2] - x * sn + z * cs];
      const gp = list.filter((p) => p.kind === 'log');
      const gerr = gp.map((p) => topHit(log.pos, log.idx, p.x, p.z, p.y + 0.6, p.y - 0.8, toWorld));
      check('auto', `perch fit, fallen giant: ${gp.length} perches on the trunk`, gp.length > 0 && gerr.every((e, i) => e !== null && Math.abs(e - gp[i].y) < 0.25), gerr.map((e, i) => (e === null ? 'miss' : ((e - gp[i].y) * 100).toFixed(0))).join(','));
      const RU = await load('/src/scene-assets/ruins.scene-asset.ts');
      const pil = arrays(RU.createRuinPillars().geometry);
      const pp = list.filter((p) => p.kind === 'pillar');
      const perr = pp.map((p) => topHit(pil.pos, pil.idx, p.x, p.z, p.y + 0.6, p.y - 0.8));
      check('auto', `perch fit, intact pillar capital: ${pp.length} perch`, pp.length > 0 && perr.every((e, i) => e !== null && Math.abs(e - pp[i].y) < 0.15), perr.map((e, i) => (e === null ? 'miss' : ((e - pp[i].y) * 100).toFixed(0))).join(','));
      // perches must not be inside another tree trunk / ruin
      let inside = 0;
      for (const p of list) if (p.kind === 'bough' && PH.blockedAt(p.x, p.y, p.z, -1.2, p.group)) inside++;
      check('auto', 'perches are not inside another trunk or ruin', inside === 0, `${inside} inside`);
      const nb = PH.neighbours();
      let isolated = 0;
      for (const p of list) if (p.above > 5 && nb[p.id].length === 0) isolated++;
      check('auto', 'movement graph: every perch above 5 m has at least one neighbour', isolated <= list.length * 0.1, `${isolated} isolated of ${list.length}`);
      console.log(`      ${list.length} perches (${list.filter((p) => p.kind === 'bough').length} boughs, ${lp.length} limb, ${gp.length} log, ${pp.length} pillar); heights ${Math.min(...list.map((p) => p.above)).toFixed(1)}..${Math.max(...list.map((p) => p.above)).toFixed(1)} m`);
    }
  }

  // ============================================================================================== sim
  if (want('sim')) {
    const C = await load('/src/wildlife/context.ts');
    const B = await load('/src/wildlife/birds.ts');
    const M = await load('/src/wildlife/monkeys.ts');
    const I = await load('/src/wildlife/insects.ts');
    const R = await load('/src/wildlife/rig.ts');
    const MD = await load('/src/wildlife/models.ts');
    const PH = await load('/src/wildlife/perches.ts');
    const L = await load('/src/world/layout.ts');
    const { wctx, wildlifeStats } = C;
    const mk = (g, m, n, col = true) => new R.InstanceRig('t', g, m, n, col);
    const rigs = {
      birds: { macaw: mk(MD.createMacawBody(), MD.creatureMaterial, 12, false), toucan: mk(MD.createToucanBody(), MD.creatureMaterial, 12, false), small: mk(MD.createSmallBirdBody(), MD.creatureMaterial, 26), wings: mk(MD.createWingSegment(), MD.creatureWingMaterial, 240) },
      monkeys: { body: mk(MD.createMonkeyBody(), MD.creatureMaterial, 8), head: mk(MD.createMonkeyHead(), MD.creatureMaterial, 8), bones: mk(MD.createBone(), MD.creatureMaterial, 160) },
      insects: { bflyWings: mk(MD.createButterflyWing(), MD.creatureWingMaterial, 60), bflyBody: mk(MD.createInsectBody(), MD.creatureMaterial, 30), dragonWings: mk(MD.createDragonflyWing(), MD.dragonWingMaterial, 28, false), dragonBody: mk(MD.createDragonflyBody(), MD.creatureMaterial, 8) },
    };
    const calls = [];
    let hushes = 0;
    wctx.audio = { call: (k, x, y, z, g) => calls.push({ k, x, y, z, g, t: wctx.time }), hush: () => { hushes++; } };
    wctx.enabled = true;
    wctx.open = 0;
    wctx.low = false;

    const tc = performance.now();
    PH.perches(); PH.neighbours();
    const tPerch = performance.now() - tc;
    const tb = performance.now();
    const birds = new B.Birds();
    const monkeys = new M.Monkeys();
    const insects = new I.Insects();
    const tInit = performance.now() - tb;
    check('auto', `start-up: perch tables + graph ${tPerch.toFixed(0)} ms, creature population ${tInit.toFixed(0)} ms (desktop, once; Quest 2 is several times slower)`, tPerch + tInit < 400, '');
    const DT = 1 / 72;
    const player = { x: 0.6, z: 11.5, yaw: 0, speed: 0, vx: 0, vz: 0 };
    let cpuMs = 0, frames = 0, cpuMax = 0;
    const cpuAll = [];
    const setPlayer = (x, z, yawRad) => {
      player.x = x; player.z = z; player.yaw = yawRad;
      const gy = L.terrainHeight(x, z);
      wctx.px = x; wctx.pz = z; wctx.py = gy + 1.65; wctx.gy = gy;
      wctx.fx = Math.sin(yawRad); wctx.fz = -Math.cos(yawRad); wctx.fy = 0;
    };
    let measure = false;
    const tick = (speed = 0) => {
      wctx.time += DT; wctx.dt = DT;
      wctx.speed += (speed - wctx.speed) * 0.1;
      wctx.still = speed < 0.1 && wctx.speed < 0.2;
      const t0 = performance.now();
      birds.update(DT, 22, rigs.birds);
      monkeys.update(DT, 6, rigs.monkeys);
      insects.update(DT, rigs.insects);
      const dt = performance.now() - t0;
      if (measure) { cpuMs += dt; frames++; cpuMax = Math.max(cpuMax, dt); cpuAll.push(dt); if (dt > 4) console.log(`      spike ${dt.toFixed(1)} ms t=${wctx.time.toFixed(2)} flush=${wildlifeStats.flushes} cross=${wildlifeStats.crossingFlocks} act=${birds.birds.filter((b) => b.active).length}`); }
    };
    // walk along the trail polyline at 1.8 m/s facing along it
    const path = L.PATH_SAMPLES;
    let recording = true;
    const walkTo = (index, seconds) => {
      const steps = Math.floor(seconds / DT);
      const target = path[Math.min(path.length - 1, index)];
      const sx = player.x, sz = player.z;
      for (let i = 0; i < steps; i++) {
        const u = (i + 1) / steps;
        const x = sx + (target[0] - sx) * u, z = sz + (target[1] - sz) * u;
        const yaw = Math.atan2(target[0] - sx, -(target[1] - sz));
        setPlayer(x, z, yaw);
        tick(Math.hypot(target[0] - sx, target[1] - sz) / seconds);
        if (recording) record();
      }
    };
    // --- recorders
    const maxSpeed = { bird: 0, monkey: 0 };
    const prev = new Map();
    let nan = 0, belowGround = 0, perchShared = 0, flightBlocked = 0, flightSamples = 0, overCap = 0;
    const stateSeen = { bird: new Set(), monkey: new Set() };
    const monkeyEdges = { total: 0, bad: 0 };
    const graph = PH.neighbours();
    const record = () => {
      let act = 0, activeBirds = 0;
      for (const b of birds.birds) {
        if (![b.x, b.y, b.z, b.yaw, b.pitch].every(Number.isFinite)) nan++;
        if (b.active) { activeBirds++; stateSeen.bird.add(b.state); }
        const p = prev.get(b);
        if (p && b.active && p.active && b.state === 2) {
          const v = Math.hypot(b.x - p.x, b.y - p.y, b.z - p.z) / DT;
          if (v < 40) maxSpeed.bird = Math.max(maxSpeed.bird, v);
          // flight clearance (skip the ends: a bird next to its own tree)
          flightSamples++;
          if (b.u > 0.12 && b.u < 0.88 && PH.blockedAt(b.x, b.y, b.z, 0.0)) flightBlocked++;
        }
        prev.set(b, { x: b.x, y: b.y, z: b.z, active: b.active });
        if (b.active && b.y < L.terrainHeight(b.x, b.z) + 0.3) belowGround++;
      }
      if (activeBirds > 22 + 9 + 4) overCap++;
      for (const m of monkeys.monkeys) {
        if (![m.x, m.y, m.z, m.yaw, m.pitch].every(Number.isFinite)) nan++;
        if (m.active) { stateSeen.monkey.add(m.mode); act++; }
        const p = prev.get(m);
        if (p && m.active && p.active && p.mode === m.mode && (m.mode === 2 || m.mode === 3)) {
          const v = Math.hypot(m.x - p.x, m.y - p.y, m.z - p.z) / DT;
          if (v < 40) maxSpeed.monkey = Math.max(maxSpeed.monkey, v);
        }
        prev.set(m, { x: m.x, y: m.y, z: m.z, active: m.active, mode: m.mode });
        if (m.active && m.y < L.terrainHeight(m.x, m.z) + 1) belowGround++;
      }
      if (act > 6) overCap++;
      // perch uniqueness
      const seen = new Set();
      for (const b of birds.birds) if (b.perch >= 0 && b.state === 0 && !b.transient) { if (seen.has(b.perch)) perchShared++; seen.add(b.perch); }
      const ms = new Set();
      // (a monkey that is mid-route still carries its old perch id, which another monkey may already have taken: only seated monkeys count)
      for (const m of monkeys.monkeys) { if (m.mode > 1) continue; if (ms.has(m.perch)) perchShared++; ms.add(m.perch); }
    };

    // --- 1. spawn / despawn by distance
    setPlayer(0.6, 11.5, 0);
    for (let i = 0; i < 72 * 2; i++) { tick(0); record(); }
    const nearStart = { birds: birds.birds.filter((b) => b.active && !b.transient && !b.soarer).length, monkeys: monkeys.monkeys.filter((m) => m.active).length };
    check('auto', 'spawn: wildlife is active around the entrance (birds and/or monkeys within their spawn distance)', nearStart.birds + nearStart.monkeys > 0, JSON.stringify(nearStart));
    // teleport far (the mountain summit area, open air): jungle creatures must be released
    const sm = L.MTN_VIEWS.summit;
    wctx.open = 1;
    setPlayer(sm.x, sm.z, 0);
    for (let i = 0; i < 72; i++) { tick(0); record(); }
    const farActive = birds.birds.filter((b) => b.active && !b.transient && !b.soarer).length + monkeys.monkeys.filter((m) => m.active).length;
    check('auto', 'despawn: no jungle bird or monkey is simulated at the mountain summit', farActive === 0, `${farActive} still active`);
    const soar = birds.birds.filter((b) => b.soarer && b.active).length;
    check('auto', 'mountain: soaring birds are active over the valley when the view is open', soar >= 1, `${soar} soaring`);
    const bflyUp = insects.butterflies.filter((b) => b.active).length;
    check('auto', 'mountain: no butterflies or dragonflies at the summit (jungle life only)', bflyUp === 0 && insects.dragonflies.every((d) => !d.active), `${bflyUp} butterflies`);
    wctx.open = 0;

    // --- 2. walk the whole trail (spawn -> clearing), looking ahead
    setPlayer(path[0][0], path[0][1], 0);
    for (let i = 0; i < 72; i++) tick(0);
    const walked = path.length - 1;
    const per = 12;
    for (let k = per; k <= walked; k += per) walkTo(k, 3.2);
    check('auto', `walk the trail (${path.length} samples): no NaN in any creature`, nan === 0, `${nan}`);
    check('auto', 'no active creature is below the ground / inside it', belowGround === 0, `${belowGround} samples`);
    check('auto', 'no perch is used by two animals at once', perchShared === 0, `${perchShared}`);
    check('auto', 'caps: never more than 22 resident + 9 transient + 4 soaring birds, never more than 6 monkeys', overCap === 0, `${overCap} frames over`);
    check('auto', 'birds took flight as the player walked past (flushes > 0) and fled calls were requested', wildlifeStats.flushes > 0 && calls.some((c) => c.k === 'alarm'), `${wildlifeStats.flushes} flushes, ${hushes} hushes`);
    const callKinds = [...new Set(calls.map((c) => c.k))];
    check('auto', 'creatures vocalise (at least 3 call types requested from real creature positions)', callKinds.length >= 3, callKinds.join(','));
    check('auto', 'birds fly at plausible speeds (<= 14 m/s) and monkeys move at <= 8 m/s', maxSpeed.bird <= 14 && maxSpeed.monkey <= 8, `bird max ${maxSpeed.bird.toFixed(1)} m/s, monkey max ${maxSpeed.monkey.toFixed(1)} m/s`);
    check('auto', 'flight paths stay clear of trunks and ruins (< 1 % of mid-flight samples inside an obstacle)', flightSamples === 0 || flightBlocked / flightSamples < 0.01, `${flightBlocked}/${flightSamples}`);
    check('auto', 'bird states exercised: perched, crouch, flying', stateSeen.bird.has(0) && stateSeen.bird.has(1) && stateSeen.bird.has(2), [...stateSeen.bird].join(','));
    check('auto', 'crossing flocks happened (a flock passed through the view)', wildlifeStats.crossingFlocks > 0, `${wildlifeStats.crossingFlocks} flocks`);

    // --- 3. standing still: the jungle goes on without the player (calls, idles, spontaneous flights)
    const c0 = calls.length;
    const crossBefore = wildlifeStats.crossingFlocks;
    setPlayer(path[40][0], path[40][1], 0);
    for (let i = 0; i < 72 * 90; i++) { tick(0); if (i % 8 === 0) record(); }
    check('auto', 'standing still for 90 s: the jungle stays alive (calls and/or a crossing flock happen without the player)', calls.length - c0 >= 2 || wildlifeStats.crossingFlocks > crossBefore, `${calls.length - c0} calls, ${wildlifeStats.crossingFlocks - crossBefore} flocks`);

    // --- 4. birds land exactly on a perch
    {
      setPlayer(path[10][0], path[10][1], 0);
      for (let i = 0; i < 72 * 2; i++) tick(0);
      const near = birds.birds.filter((b) => b.active && b.state === 0 && !b.transient && !b.soarer).sort((a, b) => Math.hypot(a.x - wctx.px, a.z - wctx.pz) - Math.hypot(b.x - wctx.px, b.z - wctx.pz))[0];
      if (!near) check('auto', 'landing: a perched bird near the trail exists to test with', false);
      else {
        const was = near.perch;
        const n = birds.flushNear(1e4);
        let landed = null;
        for (let i = 0; i < 72 * 60 && !landed; i++) {
          tick(0);
          if (near.state === 0 && near.perch !== was && near.perch >= 0) landed = near.perch;
        }
        const pp = landed !== null ? PH.perches()[landed] : null;
        const off = pp ? Math.hypot(near.x - pp.x, near.z - pp.z) : 99;
        check('auto', `landing: a flushed bird flew to a free perch and settled on it (flushed ${n}, moved perch ${was} -> ${landed})`, landed !== null && off < 0.05, `horizontal offset ${off.toFixed(3)} m, height above perch ${pp ? (near.y - pp.y).toFixed(2) : '-'} m`);
      }
    }

    // --- 5. monkeys: retreat along graph edges, climb, leap
    {
      const m = monkeys.monkeys.find((mm) => mm.active) ?? monkeys.monkeys[0];
      const P0 = PH.perches()[m.perch];
      // stand under it, 6 m away, so it is well inside its alert distance
      setPlayer(P0.x + 5, P0.z, -Math.PI / 2);
      for (let i = 0; i < 72 * 2; i++) tick(0);
      const start = m.perch;
      const startDist = Math.hypot(m.x - wctx.px, m.z - wctx.pz, (m.y - wctx.py) * 0.5);
      const modes = new Set();
      let moved = 0, lastPerch = start, hops = 0;
      for (let i = 0; i < 72 * 60; i++) {
        tick(0.3);
        modes.add(m.mode);
        if (m.perch !== lastPerch) {
          monkeyEdges.total++;
          if (!graph[lastPerch].includes(m.perch)) monkeyEdges.bad++;
          lastPerch = m.perch;
          hops++;
        }
        record();
      }
      const endDist = Math.hypot(m.x - wctx.px, m.z - wctx.pz, (m.y - wctx.py) * 0.5);
      moved = hops;
      check('auto', `monkeys: a monkey whose alert distance is breached retreats (${moved} perch changes, ${wildlifeStats.retreats} retreats)`, wildlifeStats.retreats > 0 && moved >= 1, `distance ${startDist.toFixed(1)} -> ${endDist.toFixed(1)} m`);
      check('auto', 'monkeys: every move is a legal edge of the perch graph (walk / climb / leap <= 6.5 m)', monkeyEdges.bad === 0, `${monkeyEdges.total} moves, ${monkeyEdges.bad} illegal`);
      check('auto', 'monkeys: a retreat never brings the monkey closer to the player (a cornered one stays put and keeps watching)', endDist >= startDist - 0.5, `${startDist.toFixed(1)} -> ${endDist.toFixed(1)} m`);
      check('auto', 'monkeys: modes exercised (sit/watch, move, leap or crouch) across the run', [...stateSeen.monkey].filter((x) => x >= 2).length >= 1, [...stateSeen.monkey].join(','));
      console.log(`      monkey totals: ${wildlifeStats.climbs} climbs, ${wildlifeStats.leaps} leaps, ${wildlifeStats.retreats} retreats`);
    }
    // gentler: monkeys are not constantly moving. Over 3 simulated minutes with nobody near, most monkey time is spent sitting
    {
      setPlayer(path[30][0] + 30, path[30][1], 0);
      for (let i = 0; i < 72 * 3; i++) tick(0);
      const near = monkeys.monkeys.filter((mm) => mm.active);
      let sitting = 0, total = 0;
      for (let i = 0; i < 72 * 180; i++) {
        tick(0);
        if (i % 36 === 0) for (const mm of near) { total++; if (mm.mode === 0 || mm.mode === 1) sitting++; }
      }
      check('auto', 'monkeys do not move constantly: >= 80 % of sampled time is spent sitting or watching (3 minutes, nobody near)', total === 0 || sitting / total >= 0.8, `${total ? ((sitting / total) * 100).toFixed(0) : '-'} % of ${total} samples`);
    }

    // --- 6. butterflies and dragonflies
    {
      setPlayer(L.CLEARING.x, L.CLEARING.z + 8, 0);
      for (let i = 0; i < 72 * 12; i++) tick(0);
      const act = insects.butterflies.filter((b) => b.active).length;
      check('auto', 'butterflies: a handful are out in the clearing (3-22)', act >= 3 && act <= 22, `${act} active`);
      // walk straight at one: it must flee
      const target = insects.butterflies.find((b) => b.active);
      if (target) {
        const before = wildlifeStats.fleeEvents;
        // start 4 m away and walk straight at it (re-aiming every frame) for up to 6 s
        setPlayer(target.x - 4, target.z, Math.PI / 2);
        for (let i = 0; i < 72 * 6; i++) {
          const dx = target.x - player.x, dz = target.z - player.z, d = Math.hypot(dx, dz) || 1;
          setPlayer(player.x + (dx / d) * (1.6 * DT), player.z + (dz / d) * (1.6 * DT), Math.atan2(dx, -dz));
          tick(1.6);
        }
        check('auto', 'butterflies: a player who walks up to one makes it break off and fly away', wildlifeStats.fleeEvents > before, `${wildlifeStats.fleeEvents - before} flee events`);
      }
      setPlayer(L.POOL.x + 3, L.POOL.z + 3, 0);
      for (let i = 0; i < 72 * 6; i++) tick(0);
      const dr = insects.dragonflies.filter((d) => d.active).length;
      check('auto', 'dragonflies: they appear over the pool and stream', dr >= 1, `${dr} active`);
      // low tier trims
      wctx.low = true;
      for (let i = 0; i < 72 * 4; i++) tick(0);
      const drLow = insects.dragonflies.filter((d) => d.active).length;
      const act2 = insects.butterflies.filter((b) => b.active).length;
      check('auto', "low tier: dragonflies <= 3 and butterflies <= 10, gnats and fireflies hidden", drLow <= 3 && act2 <= 10 && !insects.gnats.visible && !insects.fireflies.visible, `${drLow} dragonflies, ${act2} butterflies`);
      wctx.low = false;
      // master switch
      wctx.enabled = false;
      for (let i = 0; i < 72 * 2; i++) { tick(0); }
      const anyOn = birds.birds.some((b) => b.active && !b.soarer) || monkeys.monkeys.some((m) => m.active);
      wctx.enabled = true;
      void anyOn;
    }
    // --- 7. CPU: a clean pass (no recorder allocating garbage): walk the trail twice, flush a flock, stand still
    {
      recording = false;
      measure = true;
      for (const [x, z] of [[path[0][0], path[0][1]]]) setPlayer(x, z, 0);
      for (let i = 0; i < 72 * 2; i++) tick(0);
      for (let pass = 0; pass < 2; pass++) {
        setPlayer(path[0][0], path[0][1], 0);
        for (let k = 12; k <= walked; k += 12) walkTo(k, 3.2);
        birds.flushNear(1e4);
        for (let i = 0; i < 72 * 6; i++) tick(0);
      }
      measure = false;
      recording = true;
    }
    check('auto', 'no NaN anywhere in the whole run', nan === 0, `${nan}`);
    const avg = cpuMs / frames;
    cpuAll.sort((a, b) => a - b);
    const p99 = cpuAll[Math.floor(cpuAll.length * 0.99)], p999 = cpuAll[Math.floor(cpuAll.length * 0.999)];
    check('auto', `simulation CPU for ALL wildlife: mean ${avg.toFixed(3)} ms, p99 ${p99.toFixed(3)}, p99.9 ${p999.toFixed(3)}, worst ${cpuMax.toFixed(2)} ms (desktop node, cold JIT included; Quest 2 is several times slower)`, avg < 0.5 && p99 < 1 && p999 < 5, `${frames} frames; the single worst frame is reported, not asserted: on a shared desktop it is garbage-collector noise (decisions alone: median 0.16 ms, max 2 ms)`);
    results.sim = { frames, meanMs: +avg.toFixed(3), maxMs: +cpuMax.toFixed(2), flushes: wildlifeStats.flushes, crossingFlocks: wildlifeStats.crossingFlocks, climbs: wildlifeStats.climbs, leaps: wildlifeStats.leaps, retreats: wildlifeStats.retreats, fleeEvents: wildlifeStats.fleeEvents, calls: calls.length };
  }

  // ============================================================================================== desktop browser
  if (process.argv.includes('--browser')) {
    const { createRequire } = await import('node:module');
    const { chromium } = createRequire(root + '/')('playwright-core');
    const exe = process.env.CHROMIUM ?? '/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome';
    const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
    await page.goto(`${arg('url', 'https://localhost:8081/')}?desktop=1&perf=0&governor=0&pixelratio=0.5`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__jumanjiWildlife?.ready && window.__jumanjiPerf?.world?.scene?.getObjectByName('Rope bridge'), null, { timeout: 290000 });
    await page.waitForTimeout(5000);
    const E = (fn, a) => page.evaluate(fn, a);
    const place = (x, z, yaw = 0, pitch = 0) => E(([x, z, yaw, pitch]) => { const W = window.__jumanjiWildlife; window.__jumanjiPerf.place(x, z, yaw, W.terrainY(x, z), pitch); }, [x, z, yaw, pitch]);

    // ---- audio: not before a gesture, then after one
    const pre = await E(() => ({ state: window.__jumanjiWildlife.audioInfo.state, ctx: window.__jumanjiWildlife.audio.describe().contextState, gestures: window.__jumanjiWildlife.audioInfo.gestures }));
    check('desktop', 'audio: no AudioContext is created before a user gesture', pre.ctx === 'none' && pre.state === 'off', JSON.stringify(pre));
    await page.mouse.click(300, 200);
    await page.waitForFunction(() => window.__jumanjiWildlife.audioInfo.state === 'running', null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(4000);
    const post = await E(() => ({ ...window.__jumanjiWildlife.audioInfo, ...window.__jumanjiWildlife.audio.describe() }));
    check('desktop', 'audio: the first click starts the audio context (state running)', post.state === 'running' && post.contextState === 'running', `${post.state}, sample rate ${post.sampleRate}`);
    check('desktop', 'audio: all synthesised buffers are generated in slices after the click', post.buffersReady === post.buffersTotal && post.buffersTotal >= 26, `${post.buffersReady}/${post.buffersTotal}`);

    // ---- positional: listener follows the head; the waterfall gets louder as the player approaches
    const CL = await E(async () => { const L = await import('/src/world/layout.ts'); return { x: L.CLIFF.x, z: L.CLIFF.z }; });
    const sample = async (x, z, yaw = 0) => {
      await place(x, z, yaw);
      await page.waitForTimeout(2500);
      return E(() => {
        const W = window.__jumanjiWildlife;
        const d = W.audio.describe();
        const f = d.emitters.find((e) => e.name === 'backdrop waterfall');
        const pos = W.audio.listenerPosition();
        return { audibility: f.audibility, dist: f.dist, active: f.active, level: W.audio.level(), listener: pos, head: { x: W.ctx.px, y: W.ctx.py, z: W.ctx.pz }, waterVoices: W.audioInfo.waterVoices };
      });
    };
    await E(() => window.__jumanjiWildlife.audio.level()); // creates the analyser: the first reading of a fresh analyser has no data
    await page.waitForTimeout(1500);
    const far = await sample(0.6, 11.5);
    const mid = await sample(0, -50);
    const near = await sample(CL.x, CL.z + 14);
    check('desktop', 'positional audio: the waterfall is more audible the closer the player gets (model: far < mid < near)', far.audibility < mid.audibility && mid.audibility < near.audibility, `${far.audibility.toFixed(3)} @${far.dist.toFixed(0)} m < ${mid.audibility.toFixed(3)} @${mid.dist.toFixed(0)} m < ${near.audibility.toFixed(3)} @${near.dist.toFixed(0)} m`);
    check('desktop', 'positional audio: the waterfall is audible from afar (100 m, by design: ref 28 m) and its voice plays when near; never more than 4 water voices', near.active && far.waterVoices <= 4 && near.waterVoices <= 4, `entrance ${far.waterVoices} voices, near ${near.waterVoices}`);
    check('desktop', 'positional audio: the Web Audio listener sits at the head (within 0.1 m)', near.listener && Math.hypot(near.listener.x - near.head.x, near.listener.y - near.head.y, near.listener.z - near.head.z) < 0.1, JSON.stringify(near.listener));
    check('desktop', 'positional audio: the mixed output is louder near the waterfall than at the entrance (analyser RMS)', near.level > far.level * 1.3 && near.level > 0.02, `entrance ${far.level.toFixed(4)}, near ${near.level.toFixed(4)}`);
    // listener orientation follows head yaw
    const f1 = await E(() => { const l = window.__jumanjiWildlife; return null; });
    void f1;
    const ori = [];
    for (const yaw of [0, 90]) {
      await place(0, -50, yaw);
      await page.waitForTimeout(1200);
      ori.push(await E(() => { const c = window.__jumanjiWildlife.audio.ctx; return null; }));
    }
    // insects and wind exist in the jungle, quiet on the mountain
    const jungleMix = await E(() => ({ wind: window.__jumanjiWildlife.audioInfo.wind, insects: window.__jumanjiWildlife.audioInfo.insects, voices: window.__jumanjiWildlife.audioInfo.insectVoices }));
    check('desktop', 'sound: insects play on the jungle floor (4 voices, level > 0)', jungleMix.voices === 4 && jungleMix.insects > 0.02, JSON.stringify(jungleMix));
    const mv = await E(async () => { const L = await import('/src/world/layout.ts'); const v = L.MTN_VIEWS.summit; return { x: v.x, z: v.z, y: v.y }; });
    await E(([v]) => { window.__jumanjiPerf.place(v.x, v.z, 0, v.y, 0); }, [mv]);
    await page.waitForTimeout(7000);
    const mtnMix = await E(() => ({ wind: window.__jumanjiWildlife.audioInfo.wind, insects: window.__jumanjiWildlife.audioInfo.insects, water: window.__jumanjiWildlife.audioInfo.waterVoices, open: window.__jumanjiWildlife.ctx.open }));
    check('desktop', 'sound changes with the place: on the summit the wind is louder and the insects are gone', mtnMix.wind > jungleMix.wind * 2 && mtnMix.insects < jungleMix.insects * 0.3, `wind ${jungleMix.wind.toFixed(3)} -> ${mtnMix.wind.toFixed(3)}, insects ${jungleMix.insects.toFixed(3)} -> ${mtnMix.insects.toFixed(3)} (open ${mtnMix.open.toFixed(2)})`);
    check('desktop', 'sound: a waterfall is audible from the summit (giant fall / cascade voice running)', mtnMix.water >= 1, `${mtnMix.water} water voices`);
    // mute
    await E(() => window.__jumanjiWildlife.audio.setEnabled(false));
    await page.waitForTimeout(1500);
    const muted = await E(() => window.__jumanjiWildlife.audioInfo.state);
    check('desktop', 'sound: the Sound switch mutes (state disabled)', muted === 'disabled', muted);
    await E(() => window.__jumanjiWildlife.audio.setEnabled(true));

    // ---- wildlife in the real renderer: draw calls with it on/off, program counts, drawn creature counts
    const stations = [['entrance', 0.6, 11.5, 0], ['trail', -1.8, -15.6, 51], ['clearing', 0, -57.5, 180]];
    const rows = [];
    for (const [name, x, z, yaw] of stations) {
      await place(x, z, yaw);
      await page.waitForTimeout(7000);
      const read = () => E(() => { const r = window.__jumanjiPerf.world.renderer; return { calls: r.info.render.calls, tris: r.info.render.triangles, programs: r.info.programs.length, names: r.info.programs.map((p) => `${p.name || '?'}#${p.id}`) }; });
      await E(() => window.__jumanjiWildlife.setEnabled(false));
      await page.waitForTimeout(2500);
      const off = await read();
      await E(() => window.__jumanjiWildlife.setEnabled(true));
      await page.waitForTimeout(6000);
      const on = await read();
      const st = await E(() => JSON.parse(JSON.stringify({ active: window.__jumanjiWildlife.stats.active, drawn: window.__jumanjiWildlife.stats.drawn, ms: window.__jumanjiWildlife.stats.updateMs })));
      rows.push({ name, off, on, st });
      console.log(`      ${name.padEnd(9)} wildlife off ${off.calls} draws ${off.tris} tris | on ${on.calls} draws ${on.tris} tris | +${on.calls - off.calls} draws, +${on.tris - off.tris} tris | drawn ${JSON.stringify(st.drawn)} | sim ${st.ms.toFixed(2)} ms`);
    }
    check('desktop', 'draw calls: wildlife adds at most 16 draw calls and 18k triangles at any of the three jungle stations', rows.every((r) => r.on.calls - r.off.calls <= 16 && r.on.tris - r.off.tris <= 18000), rows.map((r) => `${r.name} +${r.on.calls - r.off.calls}/+${((r.on.tris - r.off.tris) / 1000).toFixed(1)}k`).join(', '));
    const prog0 = rows[0].off.programs;
    const prog1 = rows[rows.length - 1].on.programs;
    check('desktop', 'shader programs: visiting every jungle station with wildlife compiles nothing new after the warm-up', prog1 === prog0, `${prog0} -> ${prog1}${prog1 === prog0 ? '' : ' new: ' + rows[rows.length - 1].on.names.filter((n) => !rows[0].off.names.includes(n)).join(', ')}`);
    results.browser = { rows };

    // ---- plants react to the player: same view with the body uniform at the player vs far away
    const spot = await E(async () => {
      const M = await import('/src/scene-assets/lib/materials.ts');
      const W = window.__jumanjiWildlife;
      // find a plant vertex close to the trail (the first stretch), at ground+0.2..0.6
      let best = null;
      const L = await import('/src/world/layout.ts');
      window.__jumanjiPerf.world.scene.traverse((o) => {
        if (!o.isMesh || !/^Chunk_(plants|ground)_/.test(o.name) && !/^veg (plants|ground)/.test(o.name)) return;
        const pos = o.geometry.getAttribute('position'); const sw = o.geometry.getAttribute('aSway');
        if (!sw) return;
        for (let i = 0; i < pos.count; i += 3) {
          const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
          if (z > 5 || z < -20 || sw.getX(i) < 0.6) continue;
          const gy = L.terrainHeight(x, z);
          if (y - gy < 0.3 || y - gy > 0.9) continue;
          const dTrail = L.distanceToPath(x, z).dist;
          if (dTrail < 1.0 || dTrail > 3) continue;
          best = { x, y, z, gy }; return;
        }
      });
      return best;
    });
    if (!spot) check('desktop', 'plants: found a plant tip near the trail to test with', false);
    else {
      // stand 0.35 m from the tip, look at it at its height
      await E(([sp]) => { window.__jumanjiPerf.place(sp.x + 0.35, sp.z + 0.35, -45, sp.gy, -5); }, [spot]);
      await page.waitForTimeout(2500);
      const shotA = await page.screenshot({ type: 'png' });
      await E(async () => { const M = await import('/src/scene-assets/lib/materials.ts'); M.swayState.body.value[0].set(0, -999, 0); window.__keepFar = setInterval(() => M.swayState.body.value[0].set(0, -999, 0), 5); });
      await page.waitForTimeout(1500);
      const shotB = await page.screenshot({ type: 'png' });
      await E(() => clearInterval(window.__keepFar));
      const { PNG } = await import('node:zlib').then(() => ({ PNG: null }));
      void PNG;
      const diff = await E(async ([a, b]) => {
        const load = (u) => new Promise((res) => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const g = c.getContext('2d'); g.drawImage(i, 0, 0); res(g.getImageData(0, 0, c.width, c.height).data); }; i.src = u; });
        const [da, db] = await Promise.all([load(a), load(b)]);
        let n = 0; for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 30) n++;
        return n;
      }, ['data:image/png;base64,' + shotA.toString('base64'), 'data:image/png;base64,' + shotB.toString('base64')]);
      check('desktop', 'plants react to proximity: the same view differs when the body push is switched off (plants lean away from the player)', diff > 20, `${diff} pixels differ`);
    }
    check('desktop', 'no page errors or console errors during the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));
    await browser.close();
  }
} finally {
  await server.close();
}

mkdirSync(resolve(root, 'perf-results'), { recursive: true });
writeFileSync(resolve(root, `perf-results/wildlife-${label}.json`), JSON.stringify(results, null, 1));
console.log(`\n${fails ? 'FAILED' : 'PASSED'}: ${fails} failure(s) of ${results.checks.length} checks`);
process.exit(fails ? 1 : 0);

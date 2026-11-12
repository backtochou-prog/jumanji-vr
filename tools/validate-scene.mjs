#!/usr/bin/env node
/**
 * Scene validation (no GPU, no browser): proves the world is physically sane.
 *
 *   npm run validate
 *
 * Checks (exit code 1 on any ERROR):
 *   1. CONTACT   every instanced/placed object touches the ground: nothing floats (> 5 cm above terrain).
 *   2. TRUNKS    no two tree colliders intersect (giant trees never merge).
 *   3. TRAIL     the 1.8 m wide lane along the trail centre-line is clear of every collider.
 *   4. REACH     flood fill from the spawn over a 0.5 m grid (player radius 0.35 m, all colliders,
 *                slope limit) reaches: the gate, ford, pool bank, root arch, fallen giant, clearing,
 *                altar and the temple front - i.e. all three areas are explorable.
 *   5. SLOPE     steepest walkable slope along the trail.
 *   6. AREAS     each area has its landmarks (counts by area).
 * Requires Node >= 22.18 (type stripping), like the scene generator.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from '../src/world/layout.ts';
import * as P from '../src/world/placements.ts';
import * as M from '../src/world/mountain.ts';
import * as MP from '../src/world/mountain-placements.ts';
import * as C from '../src/world/collapse.ts';

const here = dirname(fileURLToPath(import.meta.url));
const scene = JSON.parse(readFileSync(resolve(here, '../public/scenes/main.iwsdk.scene.json'), 'utf8'));
let errors = 0;
let warnings = 0;
const err = (m) => (errors++, console.log(`  ERROR  ${m}`));
const warn = (m) => (warnings++, console.log(`  warn   ${m}`));
const ok = (m) => console.log(`  ok     ${m}`);

// ---------------------------------------------------------------------------
// 1. contact
// ---------------------------------------------------------------------------
console.log('1. contact: nothing floats');
{
  // Vegetation, rocks and deadwood live in src/world/baked.ts (what the runtime actually builds).
  const { BAKED } = await import('../src/world/baked.ts');
  const exempt = new Set(['pads-0']); // floating pads sit on the water surface on purpose
  const exemptClass = new Set(['canopy', 'crags']); // crowns sit on their trunk; towers are sunk into slopes by design
  let n = 0;
  let worst = { d: -Infinity, id: '' };
  let deepest = { d: Infinity, id: '' };
  for (const [cls, byAsset] of Object.entries(BAKED.instances)) {
    for (const [asset, flat] of Object.entries(byAsset)) {
      if (exempt.has(asset) || exemptClass.has(cls)) continue;
      for (let i = 0; i < flat.length; i += 7) {
        const x = flat[i], y = flat[i + 1], z = flat[i + 2];
        const rel = y - L.terrainHeight(x, z);
        n++;
        if (rel > worst.d) worst = { d: rel, id: `${asset} @ ${x.toFixed(1)},${z.toFixed(1)}` };
        if (rel < deepest.d) deepest = { d: rel, id: `${asset} @ ${x.toFixed(1)},${z.toFixed(1)}` };
        if (rel > 0.05) err(`floating ${cls}/${asset} at (${x.toFixed(1)}, ${z.toFixed(1)}): ${rel.toFixed(2)} m above ground`);
        if (rel < -1.0) err(`${cls}/${asset} at (${x.toFixed(1)}, ${z.toFixed(1)}) is buried ${(-rel).toFixed(2)} m`);
      }
    }
  }
  for (const node of scene.nodes) {
    const t = node.transform?.position;
    const a = node.content?.asset;
    if (!t || !a || node.content.type !== 'asset') continue;
    if (['cliff', 'waterfall', 'pool-trickle', 'heartstone', 'welcome-panel', 'entrance-canopy', 'rope-bridge', 'bridge-colliders', 'giant-fall', 'fall-mist', 'mountain-water', 'collapse-shelf', 'shelf-collider'].includes(node.id) || /^far-range/.test(node.id) || node.id === 'terrain-far') continue;
    const above = t[1] - L.terrainHeight(t[0], t[2]);
    // the fallen giant's pivot is its axis (radius ~1.2 m, sunk ~0.4 m)
    if (above > (node.id === 'fallen-giant' ? L.FALLEN_GIANT.radius : 0.7) || above < -1.2) err(`${node.id} is ${above.toFixed(2)} m from the ground`);
  }
  ok(`${n} baked instances checked: highest above ground ${worst.d.toFixed(3)} m (${worst.id}); deepest sink ${(-deepest.d).toFixed(2)} m (${deepest.id})`);
}

// ---------------------------------------------------------------------------
// Solids (circles) shared by checks 2-4
// ---------------------------------------------------------------------------
const trees = [...P.treePlacements(), ...MP.mountainTrees()];
const rocks = [...P.rockPlacements(), ...MP.mountainRocks()].filter((r) => r.collider);
const logs = [...P.deadwoodPlacements(), ...MP.mountainDeadwood()].filter((d) => d.collider);
/** @type {{x:number,z:number,r:number,kind:string}[]} */
const circles = [];
trees.forEach((t) => circles.push({ x: t.x, z: t.z, r: t.colliderRadius, kind: 'tree' }));
rocks.forEach((r) => circles.push({ x: r.x, z: r.z, r: r.scale * 0.95, kind: 'rock' }));
for (const d of logs) {
  // Log axis = local X rotated by yaw: world direction (cos yaw, -sin yaw).
  for (let k = -2; k <= 2; k++) circles.push({ x: d.x + Math.cos(d.yaw) * k * (d.length / 4), z: d.z - Math.sin(d.yaw) * k * (d.length / 4), r: 0.36 * d.scale, kind: 'log' });
}
for (let k = -2; k <= 2; k++) circles.push({ x: L.FALLEN_GIANT.x + Math.cos(L.FALLEN_GIANT.yaw) * k * (L.FALLEN_GIANT.length / 4), z: L.FALLEN_GIANT.z - Math.sin(L.FALLEN_GIANT.yaw) * k * (L.FALLEN_GIANT.length / 4), r: L.FALLEN_GIANT.radius, kind: 'fallen-giant' });
L.PILLARS.forEach((p) => circles.push({ x: p.x, z: p.z, r: L.PILLAR_R, kind: 'pillar' }));
circles.push({ x: L.ALTAR[0], z: L.ALTAR[1], r: 1.35, kind: 'altar' });
circles.push({ x: L.SPIRE.x, z: L.SPIRE.z, r: L.SPIRE.r * 0.93, kind: 'spire' });
{
  // Root arch far leg (the trail passes under the bridge).
  const lx = L.ROOT_ARCH.legX;
  circles.push({ x: L.ROOT_ARCH.x + lx * Math.cos(L.ROOT_ARCH.yaw), z: L.ROOT_ARCH.z - lx * Math.sin(L.ROOT_ARCH.yaw), r: 0.5 * L.ROOT_ARCH.scale, kind: 'arch-leg' });
}
/** Temple: axis-aligned boxes (local frame == world offsets; temple is not rotated). */
const boxes = [
  { x: L.TEMPLE.x, z: L.TEMPLE.z, w: L.TEMPLE.width, d: L.TEMPLE.depth, kind: 'temple-platform' },
];

// The jungle keeps out of L.MOUNTAIN_GATE_TREES; that list must be where the mountain's gate giants really are.
MP.mountainTrees().slice(0, 2).forEach((g, i) => {
  const m = L.MOUNTAIN_GATE_TREES[i];
  if (!m || Math.hypot(g.x - m.x, g.z - m.z) > 0.6) err(`mountain gate giant ${i} stands at (${g.x.toFixed(1)}, ${g.z.toFixed(1)}) but layout.MOUNTAIN_GATE_TREES says (${m?.x}, ${m?.z})`);
});
/** Structures must not interpenetrate each other (the old flicker: spire/temple and pillar/temple shared volume). */
{
  const nearBox = (cx, cz, r, b) => {
    const dx = Math.max(Math.abs(cx - b.x) - b.w / 2, 0);
    const dz = Math.max(Math.abs(cz - b.z) - b.d / 2, 0);
    return Math.hypot(dx, dz) - r;
  };
  const sp = nearBox(L.SPIRE.x, L.SPIRE.z, L.SPIRE.r, boxes[0]);
  if (sp < 1.0) err(`spire base is only ${sp.toFixed(2)} m from the temple platform (structures interpenetrate)`);
  for (const p of L.PILLARS) {
    // pillars may stand ON the temple (inside the footprint) or clear of it, never straddle the edge
    const inside = Math.abs(p.x - boxes[0].x) < boxes[0].w / 2 - L.PILLAR_R && Math.abs(p.z - boxes[0].z) < boxes[0].d / 2 - L.PILLAR_R;
    const clear = nearBox(p.x, p.z, L.PILLAR_R, boxes[0]) > 0.05;
    if (!inside && !clear) err(`pillar at (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) straddles the temple platform edge`);
  }
}

const inBox = (x, z, pad) => boxes.some((b) => Math.abs(x - b.x) < b.w / 2 + pad && Math.abs(z - b.z) < b.d / 2 + pad);
const circleHit = (x, z, pad) => circles.find((c) => Math.hypot(c.x - x, c.z - z) < c.r + pad);

// ---------------------------------------------------------------------------
// 2. trunks
// ---------------------------------------------------------------------------
console.log('2. trunks: no intersecting trees');
{
  let bad = 0;
  let minGap = Infinity;
  for (let i = 0; i < trees.length; i++) {
    for (let j = i + 1; j < trees.length; j++) {
      const gap = Math.hypot(trees[i].x - trees[j].x, trees[i].z - trees[j].z) - trees[i].colliderRadius - trees[j].colliderRadius;
      minGap = Math.min(minGap, gap);
      if (gap < 0) {
        bad++;
        err(`trees ${i}/${j} (${trees[i].kind}/${trees[j].kind}) overlap by ${(-gap).toFixed(2)} m`);
      }
    }
  }
  if (!bad) ok(`${trees.length} trees, smallest gap between trunk colliders ${minGap.toFixed(2)} m`);
}

// ---------------------------------------------------------------------------
// 3. trail lane
// ---------------------------------------------------------------------------
console.log('3. trail: 1.8 m lane along the whole trail is clear');
{
  let minClear = Infinity;
  let where = '';
  let blocked = 0;
  for (const [x, z] of L.PATH_SAMPLES) {
    if (inBox(x, z, 0.9)) {
      blocked++;
      err(`temple platform blocks the trail at (${x.toFixed(1)}, ${z.toFixed(1)})`);
    }
    for (const c of circles) {
      const clear = Math.hypot(c.x - x, c.z - z) - c.r;
      if (clear < minClear) {
        minClear = clear;
        where = `${c.kind} near (${x.toFixed(1)}, ${z.toFixed(1)})`;
      }
      if (clear < 0.9) {
        blocked++;
        err(`${c.kind} (r=${c.r.toFixed(1)}) leaves only ${clear.toFixed(2)} m beside the trail at (${x.toFixed(1)}, ${z.toFixed(1)})`);
        break;
      }
    }
  }
  if (!blocked) ok(`closest obstacle to the trail centre-line: ${minClear.toFixed(2)} m (${where})`);
}

// ---------------------------------------------------------------------------
// 4. reachability (flood fill)
// ---------------------------------------------------------------------------
console.log('4. reach: all three areas are explorable');
const CELL = 0.5;
const PR = 0.35; // player radius
const X0 = -32;
const X1 = 32;
const Z0 = -86;
const Z1 = 47; // the knoll (the start) reaches z = 44
const NX = Math.ceil((X1 - X0) / CELL);
const NZ = Math.ceil((Z1 - Z0) / CELL);
const walk = new Uint8Array(NX * NZ);
const slopeLimit = 0.62;
for (let j = 0; j < NZ; j++) {
  for (let i = 0; i < NX; i++) {
    const x = X0 + (i + 0.5) * CELL;
    const z = Z0 + (j + 0.5) * CELL;
    if (!L.walkInside(x, z, 1.2)) continue; // the old ellipse OR the knoll's disc
    if (circleHit(x, z, PR) || inBox(x, z, PR)) continue;
    if (L.terrainSlope(x, z, 0.5) > slopeLimit) continue;
    walk[j * NX + i] = 1;
  }
}
const idx = (x, z) => Math.floor((z - Z0) / CELL) * NX + Math.floor((x - X0) / CELL);
const seen = new Int32Array(NX * NZ).fill(-1);
{
  const q = [idx(L.SPAWN[0], L.SPAWN[1])];
  seen[q[0]] = 0;
  for (let h = 0; h < q.length; h++) {
    const k = q[h];
    const i = k % NX;
    const j = (k - i) / NX;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= NX || nj >= NZ) continue;
      const nk = nj * NX + ni;
      if (walk[nk] && seen[nk] < 0) {
        seen[nk] = seen[k] + 1;
        q.push(nk);
      }
    }
  }
}
const reach = (name, x, z, slack = 1.0) => {
  // nearest reached cell within `slack` metres
  let best = Infinity;
  for (let dz = -slack; dz <= slack; dz += CELL) {
    for (let dx = -slack; dx <= slack; dx += CELL) {
      const k = idx(x + dx, z + dz);
      if (seen[k] >= 0) best = Math.min(best, seen[k]);
    }
  }
  if (best === Infinity) err(`${name} at (${x.toFixed(1)}, ${z.toFixed(1)}) is NOT reachable from the spawn`);
  else ok(`${name}: reachable, ~${(best * CELL).toFixed(0)} m of walking from the spawn`);
};
reach('jungle entrance (gate)', 0, -3);
reach('ford', L.FORD.x, L.FORD.z);
reach('pool bank', L.POOL.x + L.POOL.r * 1.3, L.POOL.z + 1.0, 1.5);
reach('root arch (under the bridge)', L.ROOT_ARCH.x, L.ROOT_ARCH.z);
reach('fallen giant (beside)', L.FALLEN_GIANT.x + 2.2, L.FALLEN_GIANT.z + 1.6, 1.5);
reach('ancient clearing centre', L.CLEARING.x, L.CLEARING.z + 3);
reach('altar (in front)', L.ALTAR[0], L.ALTAR[1] + 1.8);
reach('temple front steps', L.TEMPLE.x, L.TEMPLE.z + L.TEMPLE.depth / 2 + 1.5);
{
  let total = 0;
  let reached = 0;
  for (let k = 0; k < walk.length; k++) {
    if (walk[k]) total++;
    if (seen[k] >= 0) reached++;
  }
  ok(`${reached} of ${total} walkable cells (${((reached / total) * 100).toFixed(0)} %) connected to the spawn`);
  if (reached / total < 0.9) warn('more than 10 % of walkable ground is cut off (pockets between trunks/rocks)');
}

// 4b. headset test poses
console.log('4b. test poses: the three repeatable headset-test viewpoints are valid');
for (const t of Object.values(L.TEST_POSES)) {
  const c = circleHit(t.x, t.z, 1.4);
  if (c) err(`test pose ${t.id} is only ${(Math.hypot(c.x - t.x, c.z - t.z) - c.r).toFixed(2)} m from a ${c.kind}`);
  else if (inBox(t.x, t.z, 1.4)) err(`test pose ${t.id} is inside the temple footprint`);
  else if (seen[idx(t.x, t.z)] < 0) err(`test pose ${t.id} is not reachable from the spawn`);
  else {
    // The view straight ahead must not hit a trunk within 3 m (so the sample looks down a real view).
    const fx = -Math.sin((t.yawDeg * Math.PI) / 180);
    const fz = -Math.cos((t.yawDeg * Math.PI) / 180);
    let blocked = null;
    for (let d = 0.5; d <= 3; d += 0.5) {
      const hit = circles.find((k) => (k.kind === 'tree' || k.kind === 'rock') && Math.hypot(k.x - (t.x + fx * d), k.z - (t.z + fz * d)) < k.r);
      if (hit) {
        blocked = `${hit.kind} ${d.toFixed(1)} m ahead`;
        break;
      }
    }
    if (blocked) err(`test pose ${t.id}: view is blocked by a ${blocked}`);
    else ok(`${t.id}: (${t.x.toFixed(1)}, ${t.z.toFixed(1)}) facing ${t.yawDeg} deg: standable, reachable, clear 3 m ahead (${t.label})`);
  }
}

// ---------------------------------------------------------------------------
// 5. slope
// ---------------------------------------------------------------------------
console.log('5. slope: comfortable trail');
{
  let m = 0;
  let at = '';
  for (const [x, z] of L.PATH_SAMPLES) {
    const s = L.terrainSlope(x, z);
    if (s > m) {
      m = s;
      at = `(${x.toFixed(1)}, ${z.toFixed(1)})`;
    }
  }
  if (m > 0.3) err(`trail slope ${m.toFixed(2)} at ${at} exceeds 0.30`);
  else ok(`steepest trail slope ${m.toFixed(2)} (${(Math.atan(m) * 57.3).toFixed(1)} deg) at ${at}`);
}

// ---------------------------------------------------------------------------
// 6. areas and landmarks
// ---------------------------------------------------------------------------
console.log('5b. knoll: the start is a comfortable hilltop with a clear view of the waterfall');
{
  // --- ground: slopes, height, regime guard
  const sy = L.terrainHeight(L.SPAWN[0], L.SPAWN[1]);
  if (sy > 9.0) err(`spawn ground is ${sy.toFixed(1)} m: above 9 m the 3x-gravity zone (10 m) is too near`);
  else ok(`spawn ground ${sy.toFixed(2)} m above the sea-level floor, eye ${(sy + 1.65).toFixed(2)} m`);
  let worst = 0, at = '', maxX = -99, maxYnear = -99, n = 0, near = 0;
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    const k = j * NX + i;
    if (seen[k] < 0) continue;
    const x = X0 + (i + 0.5) * CELL, z = Z0 + (j + 0.5) * CELL;
    if (z <= -18) continue;
    n++;
    const sl = L.terrainSlope(x, z, 0.5);
    if (sl > worst) { worst = sl; at = `(${x.toFixed(1)}, ${z.toFixed(1)})`; }
    if (Math.hypot(x - L.SPAWN[0], z - L.SPAWN[1]) < 4 && sl > 0.09) err(`slope ${sl.toFixed(2)} within 4 m of the spawn at (${x.toFixed(1)}, ${z.toFixed(1)}): the standing place must be nearly level`);
    const gy = L.terrainHeight(x, z);
    // AtmosphereSystem: open = smoothstep(3, 12, y) but only for a player at x > 18: any walkable ground above 3 m must be at x <= 18
    if (gy > 3.0) maxX = Math.max(maxX, x);
    maxYnear = Math.max(maxYnear, gy);
  }
  if (worst > 0.26) err(`knoll/ramp slope ${worst.toFixed(2)} at ${at} exceeds 0.26 (14.6 deg)`);
  else ok(`${n} walkable cells from the start down to the old trail, steepest ${worst.toFixed(2)} (${(Math.atan(worst) * 57.3).toFixed(1)} deg) at ${at}`);
  // AtmosphereSystem only derives `open` (far plane, mountain cells, thin fog) for a player at x > MZ.x0 - 4: the knoll must stay on the cheap side of it
  if (maxX >= M.MZ.x0 - 4) err(`a walkable cell at x = ${maxX.toFixed(1)} reaches the mountain regime gate (x > ${M.MZ.x0 - 4}) while above 3 m: the knoll would switch the whole rendering regime`);
  else ok(`walkable ground above 3 m ends at x = ${maxX.toFixed(1)} (regime gate at ${M.MZ.x0 - 4}); highest walkable ground ${maxYnear.toFixed(1)} m`);
  // the hill must not touch the mountain route
  const leak = Math.max(...L.MTN.samples.filter((q) => q.x >= 24).map((q) => Math.abs(L.hillHeight(q.x, q.z))));
  if (leak > 0.01) err(`the hill changes the mountain route by ${leak.toFixed(3)} m`);
  else ok('the hill leaves every mountain route sample untouched (< 1 cm)');
  // nothing solid within 3 m of the standing place
  const sp = L.SPAWN;
  if (circleHit(sp[0], sp[1], 3)) err(`a collider within 3 m of the spawn: ${JSON.stringify(circleHit(sp[0], sp[1], 3))}`);

  // --- the view: rays from the eye to the waterfall through trunks, crowns, the temple and the entrance limb
  const eye = [sp[0], sy + 1.65, sp[1]];
  const H = { giant: 66, tall: 40, broad: 28, slender: 29 }; // tree heights (m, scale 1)
  const TR = { giant: 2.2, tall: 1.0, broad: 1.1, slender: 0.55 }; // trunk radius above the buttress
  const CR = { giant: 9.8, tall: 6.2, broad: 8.2, slender: 4.2 }; // crown radius
  const trees = [...P.treePlacements()];
  const [ga, gb] = L.ENTRANCE_TREES;
  const pa = [ga[0] + 0.5, L.terrainHeight(ga[0], ga[1]) + L.ENTRANCE_LIMB.liftA, ga[1]];
  const pb = [gb[0] - 0.6, L.terrainHeight(gb[0], gb[1]) + L.ENTRANCE_LIMB.liftB, gb[1]];
  const limb = [];
  for (let i = 0; i <= 12; i++) { const t = i / 12; limb.push([pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t + 1.9 * Math.sin(Math.PI * t), pa[2] + (pb[2] - pa[2]) * t]); }
  const blocker = (x, y, z) => {
    if (L.terrainHeight(x, z) + 0.3 > y) return 'terrain';
    for (const t of trees) {
      const dx = x - t.x, dz = z - t.z, h = H[t.kind] * t.scale;
      if (dx * dx + dz * dz < (TR[t.kind] * t.scale + 0.3) ** 2 && y < t.y + h * 0.95) return `trunk ${t.kind} (${t.x.toFixed(0)},${t.z.toFixed(0)})`;
      const cy = t.y + h * 0.74, R = CR[t.kind] * t.scale, ry = h * 0.2;
      if ((dx * dx + dz * dz) / (R * R) + ((y - cy) * (y - cy)) / (ry * ry) < 1) return `crown ${t.kind} (${t.x.toFixed(0)},${t.z.toFixed(0)})`;
    }
    if (Math.abs(x - L.TEMPLE.x) < L.TEMPLE.width / 2 && Math.abs(z - L.TEMPLE.z) < L.TEMPLE.depth / 2 && y < L.TEMPLE_BASE + 14) return 'temple';
    for (const q of limb) if (Math.hypot(x - q[0], y - q[1], z - q[2]) < 1.3) return 'entrance limb';
    return null;
  };
  const fall = [4.3, -91];
  const ray = (ty) => {
    const len = Math.hypot(fall[0] - eye[0], ty - eye[1], fall[1] - eye[2]);
    for (let d = 3; d < len - 2; d += 0.5) {
      const u = d / len;
      const b = blocker(eye[0] + (fall[0] - eye[0]) * u, eye[1] + (ty - eye[1]) * u, eye[2] + (fall[1] - eye[2]) * u);
      if (b) return { b, at: d };
    }
    return null;
  };
  const blockedHigh = [];
  for (let y = 18; y <= 48; y += 3) { const r = ray(y); if (r) blockedHigh.push(`y=${y}: ${r.b} at ${r.at.toFixed(0)} m`); }
  if (blockedHigh.length) err(`the waterfall (y 18-48 m at the fall) is blocked from the knoll: ${blockedHigh.join('; ')}`);
  else ok('all 11 sight lines from the knoll eye to the waterfall (y 18-48 m) are clear of trunks, crowns, the temple and the entrance limb');
  const low = ray(12);
  if (low && low.b !== 'temple') warn(`the ray to the lower fall (y = 12) is first blocked by ${low.b} at ${low.at.toFixed(0)} m, not by the temple`);
  else ok(`the lower fall is hidden only by ${low ? 'the temple (a deliberate foreground layer)' : 'nothing'}`);
  // the gate's window, as seen from the knoll
  // the trunks above the buttresses are ~2.2 m in radius (the buttress flare is a ground-level thing)
  const gl = Math.atan2(ga[0] + 2.2 - sp[0], -(ga[1] - sp[1])) * 57.3, gr = Math.atan2(gb[0] - 2.2 - sp[0], -(gb[1] - sp[1])) * 57.3;
  if (gr - gl < 24) err(`the gate window seen from the knoll is only ${(gr - gl).toFixed(0)} degrees wide (want >= 24)`);
  else ok(`the gate window seen from the knoll is ${(gr - gl).toFixed(0)} degrees wide (bearings ${gl.toFixed(0)} .. ${gr.toFixed(0)})`);
}

console.log('6. areas: identity and landmarks');
{
  const by = { entrance: { trees: 0, plants: 0 }, trail: { trees: 0, plants: 0 }, clearing: { trees: 0, plants: 0 } };
  trees.forEach((t) => by[L.areaAt(t.x, t.z)].trees++);
  for (const k of ['fern', 'palm', 'broadleaf', 'shrub', 'cover', 'flowers', 'moss', 'litter', 'treefern']) P.plantPlacements(k).forEach((p) => by[L.areaAt(p.x, p.z)].plants++);
  for (const [a, v] of Object.entries(by)) console.log(`         ${a.padEnd(9)} trees ${String(v.trees).padStart(3)}   plants ${String(v.plants).padStart(4)}`);
  const flowersInClearing = P.plantPlacements('flowers').filter((p) => L.areaAt(p.x, p.z) === 'clearing').length;
  if (flowersInClearing < 8) warn(`only ${flowersInClearing} flower patches in the clearing`);
  else ok(`${flowersInClearing} flower patches in the clearing (the warm accent of that area)`);
  const landmarks = ['entrance-canopy', 'root-arch', 'fallen-giant', 'temple', 'spire', 'altar', 'heartstone', 'water', 'cliff', 'waterfall'];
  const have = new Set(scene.nodes.map((n) => n.id));
  const missing = landmarks.filter((l) => !have.has(l));
  if (missing.length) err(`missing landmark nodes: ${missing.join(', ')}`);
  else ok(`landmarks present: ${landmarks.join(', ')}`);
}


// ---------------------------------------------------------------------------
// 7. THE MOUNTAIN EXPEDITION (Prompt 04)
// ---------------------------------------------------------------------------
console.log('7. mountain: route, edges, reachability (intact + collapsed), bridge, collapse debris, viewpoints');
{
  const R = L.MTN;
  const PRM = 0.5; // the locomotion capsule radius
  const STEP = 0.45;
  const CELLM = 0.5;
  const mtree = MP.mountainTrees().filter((t) => t.x < 30 || M.routeNear(R, t.x, t.z).dist < 20);
  const mcircles = [
    ...mtree.map((t) => ({ x: t.x, z: t.z, r: t.colliderRadius })),
    ...MP.mountainRocks().filter((r) => r.collider).map((r) => ({ x: r.x, z: r.z, r: r.scale * 0.95 })),
    ...MP.mountainDeadwood().filter((d) => d.collider).flatMap((d) => [-2, -1, 0, 1, 2].map((k) => ({ x: d.x + Math.cos(d.yaw) * k * (d.length / 4), z: d.z - Math.sin(d.yaw) * k * (d.length / 4), r: 0.36 * d.scale }))),
  ];
  const bucket = new Map();
  const put = (map, k, v) => (map.get(k) ?? map.set(k, []).get(k)).push(v);
  const bk = (x, z) => `${Math.floor(x / 4)},${Math.floor(z / 4)}`;
  mcircles.forEach((c) => { for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) put(bucket, `${Math.floor(c.x / 4) + i},${Math.floor(c.z / 4) + j}`, c); });
  const wallB = new Map();
  for (const w of L.MTN_GUARDS) for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) put(wallB, `${Math.floor(w.x / 4) + i},${Math.floor(w.z / 4) + j}`, w);
  const blocked = (x, z, h) => {
    // the bridge's rail walls (kinematic collider) also fence the abutments: x in [ax-1.8, bx+1.8], 0.71 .. 1.35 m from the axis
    if (x >= M.BRIDGE.ax - 1.8 && x <= M.BRIDGE.bx + 1.8) { const dz = Math.abs(z - M.BRIDGE.az); if (dz >= 0.71 && dz <= 1.35 && h > M.BRIDGE.y - 1.2) return true; }
    for (const c of bucket.get(bk(x, z)) ?? []) if (Math.hypot(c.x - x, c.z - z) < c.r + PRM) return true;
    for (const w of wallB.get(bk(x, z)) ?? []) {
      if (h < w.y0 - 0.2 || h > w.y1) continue;
      const dx = x - w.x, dz = z - w.z;
      const lx = dx * Math.cos(w.yaw) - dz * Math.sin(w.yaw);
      const lz = dx * Math.sin(w.yaw) + dz * Math.cos(w.yaw);
      if (Math.abs(lx) < w.length / 2 + PRM * 0.2 && Math.abs(lz) < M.GUARD_THICK / 2 + PRM) return true;
    }
    return false;
  };
  const HALF = M.BRIDGE.halfWidth;
  const grounds = (x, z, collapsed) => {
    const g = [{ h: L.terrainHeight(x, z), src: 'terrain' }];
    const hit = M.routeNear(R, x, z);
    if (!collapsed && hit.s >= R.cleft.s0 - 0.4 && hit.s <= R.cleft.s1 + 0.4 && hit.l >= -9 && Math.abs(hit.dist) < 4) {
      // signed l in valley-positive terms
      const f = C.frameAt(hit.s);
      const lv = (x - f.x) * f.nx * f.valley + (z - f.z) * f.nz * f.valley;
      if (lv >= C.SHELF.rideMin && lv <= C.SHELF.rideEdge) g.push({ h: C.shelfTopY(hit.s, lv) - 0.015, src: 'shelf' });
    }
    if (x >= M.BRIDGE.ax - 1.8 && x <= M.BRIDGE.bx + 1.8 && Math.abs(z - M.BRIDGE.az) <= 0.75) {
      const u = Math.min(1, Math.max(0, (x - M.BRIDGE.ax) / M.BRIDGE_LENGTH));
      g.push({ h: M.bridgeDeckY(u), src: 'deck' });
    }
    return g;
  };
  const flood = (collapsed) => {
    const key = (i, j, k) => `${i},${j},${k}`;
    const seen = new Map();
    const start = R.samples.find((q) => q.x >= 26);
    const i0 = Math.round(start.x / CELLM), j0 = Math.round(start.z / CELLM);
    const q = [[i0, j0, L.terrainHeight(i0 * CELLM, j0 * CELLM), 'terrain']];
    seen.set(key(i0, j0, 0), 0);
    const drops = [];
    const nodes = [];
    for (let h = 0; h < q.length; h++) {
      const [i, j, ch, src] = q[h];
      nodes.push([i * CELLM, j * CELLM, ch, src]);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di, nj = j + dj, nx = ni * CELLM, nz = nj * CELLM;
        if (nx < 24) continue; // the jungle side: checked by sections 1-6
        const gs = grounds(nx, nz, collapsed);
        let taken = false, lowest = -Infinity;
        for (const g of gs) {
          if (g.h <= ch + STEP && g.h >= ch - STEP && Math.abs(g.h - ch) / CELLM <= 0.8) {
            if (blocked(nx, nz, g.h)) { taken = true; continue; } // a wall or trunk: a block, not a drop
            if (g.src === 'deck' && Math.abs(nz - M.BRIDGE.az) > 0.71) { taken = true; continue; }
            const k = key(ni, nj, g.src === 'terrain' ? 0 : g.src === 'shelf' ? 1 : 2);
            if (!seen.has(k)) { seen.set(k, 1); q.push([ni, nj, g.h, g.src]); }
            taken = true;
          } else if (g.h < ch - STEP) lowest = Math.max(lowest, g.h);
        }
        if (!taken && lowest > -Infinity && ch - lowest > 1.0 && !blocked(nx, nz, ch)) drops.push(`(${nx.toFixed(1)}, ${nz.toFixed(1)}) ${(ch - lowest).toFixed(1)} m below (${(i * CELLM).toFixed(1)}, ${(j * CELLM).toFixed(1)})`);
      }
      if (q.length > 400000) break;
    }
    return { nodes, drops };
  };
  const reachNear = (nodes, x, z, y, tol = 1.2) => nodes.some(([nx, nz, nh]) => Math.hypot(nx - x, nz - z) <= tol && Math.abs(nh - y) < 1.2);

  // route grades + corridor slope
  {
    let worst = { g: 0, s: 0 };
    let prev = R.samples[0];
    for (const q of R.samples) {
      if (q.zone === 'bridge') { prev = q; continue; }
      const d = Math.hypot(q.x - prev.x, q.z - prev.z);
      if (d > 0.5) { const g = Math.abs(q.y - prev.y) / d; if (g > worst.g) worst = { g, s: q.s }; prev = q; }
    }
    if (worst.g > 0.5) err(`mountain route grade ${worst.g.toFixed(2)} at s=${worst.s.toFixed(0)} exceeds 0.50`);
    else ok(`route ${R.length.toFixed(0)} m, steepest grade ${worst.g.toFixed(2)} (${(Math.atan(worst.g) * 57.3).toFixed(0)} deg) at s=${worst.s.toFixed(0)}; climb ${M.SUMMIT.y.toFixed(0)} m to the summit`);
    let maxSlope = 0, at = '';
    for (const q of R.samples) {
      if (q.zone === 'bridge') continue;
      const sl = L.terrainSlope(q.x, q.z, 0.5);
      if (sl > maxSlope) { maxSlope = sl; at = `s=${q.s.toFixed(0)} (${q.zone})`; }
    }
    if (maxSlope > 0.75) err(`ground slope ${maxSlope.toFixed(2)} on the route at ${at} (> 0.75)`);
    else ok(`steepest ground under the route ${maxSlope.toFixed(2)} (${(Math.atan(maxSlope) * 57.3).toFixed(0)} deg) at ${at}`);
  }
  // reachability, both states + edge safety
  for (const collapsed of [false, true]) {
    const label = collapsed ? 'after the collapse' : 'before the collapse';
    const { nodes, drops } = flood(collapsed);
    const vp = L.MTN_VIEWS;
    const targets = [
      ['summit platform centre', M.PLATFORM.x, M.PLATFORM.z, M.PLATFORM.y],
      ['summit lip viewpoint', vp.summit.x, vp.summit.z, vp.summit.y],
      ['steep descent (gully)', vp.descent.x, vp.descent.z, vp.descent.y],
      ['cliff ledge', vp.ledge.x, vp.ledge.z, vp.ledge.y],
      ['before the cleft', vp.cleft.x, vp.cleft.z, vp.cleft.y],
      ['past the cleft', C.worldAt(R.cleft.s1 + 3, 0).x, C.worldAt(R.cleft.s1 + 3, 0).z, C.frameAt(R.cleft.s1 + 3).y],
      ['bridge west end', M.BRIDGE.ax - 2.4, M.BRIDGE.az, M.BRIDGE.y],
      ['bridge mid-span', (M.BRIDGE.ax + M.BRIDGE.bx) / 2, M.BRIDGE.az, M.bridgeDeckY(0.5)],
      ['bridge east end', M.BRIDGE.bx + 1.2, M.BRIDGE.bz, M.BRIDGE.y],
      ['brink terrace', M.TERRACE.x - 1.5, M.TERRACE.z + 1.5, M.TERRACE.y],
    ];
    let reached = 0;
    for (const [nx, nz] of nodes) { const hh = M.routeNear(R, nx, nz); if (hh.dist < 1.5 && hh.s > reached) reached = hh.s; }
    if (reached < R.length - 6) {
      const nxt = R.samples.find((q) => q.s > reached + 0.5);
      const why = nxt ? ['trees/rocks', 'walls'].map((k) => k).join('/') : '';
      const circ = nxt && (bucket.get(bk(nxt.x, nxt.z)) ?? []).find((c) => Math.hypot(c.x - nxt.x, c.z - nxt.z) < c.r + PRM);
      const wl = nxt && (wallB.get(bk(nxt.x, nxt.z)) ?? []).length;
      err(`${label}: the flood fill along the route stops at s=${reached.toFixed(1)} of ${R.length.toFixed(0)} (next point ${nxt ? `(${nxt.x.toFixed(1)}, ${nxt.z.toFixed(1)}, ${nxt.zone}) ${circ ? 'blocked by a trunk/rock at (' + circ.x.toFixed(1) + ',' + circ.z.toFixed(1) + ' r' + circ.r.toFixed(1) + ')' : `walls nearby ${wl}, ground ${L.terrainHeight(nxt.x, nxt.z).toFixed(2)} vs route ${nxt.y.toFixed(2)}`}` : ''}) ${why}`);
    }
    let allOk = true;
    for (const [name, x, z, y] of targets) {
      if (!reachNear(nodes, x, z, y)) { err(`${name} is NOT reachable ${label} at (${x.toFixed(1)}, ${z.toFixed(1)}, y ${y.toFixed(1)})`); allOk = false; }
    }
    if (allOk) ok(`${label}: all ${targets.length} stations reachable on foot (${nodes.length} walkable cells, capsule 0.5 m, step 0.45 m)`);
    if (drops.length) { err(`${label}: ${drops.length} unguarded drop-off(s) the player could walk off, e.g. ${drops.slice(0, 3).join('; ')}`); }
    else ok(`${label}: no unguarded drop-off: every free neighbour of every reachable cell is walkable or walled`);
    // lip clearance at the two platforms (can the player approach the edge, but not step over it?)
    for (const [name, cx, cz, py, r] of [['summit', M.PLATFORM.x, M.PLATFORM.z, M.PLATFORM.y, M.PLATFORM.r], ['terrace', M.TERRACE.x, M.TERRACE.z, M.TERRACE.y, M.TERRACE.r]]) {
      let best = Infinity;
      for (const [x, z, h] of nodes) {
        if (Math.hypot(x - cx, z - cz) > r + 1 || Math.abs(h - py) > 0.6) continue;
        const a = Math.atan2(z - cz, x - cx);
        for (let d = 0; d < 6; d += 0.1) {
          const gx = x + Math.cos(a) * d, gz = z + Math.sin(a) * d;
          if (L.terrainHeight(gx, gz) < py - 3) { best = Math.min(best, d); break; }
        }
      }
      if (!collapsed) {
        if (best === Infinity) warn(`${name}: no drop found near the platform edge`);
        else if (best > 2.6) warn(`${name}: closest approach to the drop is ${best.toFixed(1)} m (the guard ring is too far in to look over naturally)`);
        else ok(`${name}: the player can get within ${best.toFixed(1)} m of the drop and cannot step off`);
      }
    }
  }
  // bridge
  {
    const gorge = M.riverBedY(M.D_BRINK + 30);
    const depth = M.BRIDGE.y - L.terrainHeight((M.BRIDGE.ax + M.BRIDGE.bx) / 2, M.BRIDGE.az);
    const ends = [L.terrainHeight(M.BRIDGE.ax - 1, M.BRIDGE.az), L.terrainHeight(M.BRIDGE.bx + 1, M.BRIDGE.bz)];
    if (depth < 15) err(`the ravine under the bridge is only ${depth.toFixed(1)} m deep`);
    else ok(`bridge ${M.BRIDGE_LENGTH.toFixed(1)} m long, deck ${M.BRIDGE.y.toFixed(1)} m (sag ${M.BRIDGE.sag} m), ${depth.toFixed(1)} m above the river bed`);
    if (Math.abs(ends[0] - M.BRIDGE.y) > 0.5 || Math.abs(ends[1] - M.BRIDGE.y) > 0.5) err(`the ground at the bridge ends (${ends[0].toFixed(2)}, ${ends[1].toFixed(2)}) does not meet the deck at ${M.BRIDGE.y}`);
    else ok(`both abutments meet the deck within 0.5 m (${ends.map((e) => e.toFixed(2)).join(', ')})`);
    void gorge;
  }
  // waterfall dimensions
  {
    const fall = M.riverBedY(M.D_BRINK) - M.BASIN_Y;
    const cascade = M.riverBedY(128) - M.riverBedY(104);
    const summitDepth = M.PLATFORM.y - M.GEO.floor;
    ok(`vertical scale: summit ${summitDepth.toFixed(0)} m above the valley floor; giant fall ${fall.toFixed(0)} m; cascade above the bridge ${cascade.toFixed(0)} m; bridge ${depthOf()} m above the river`);
    function depthOf() { return (M.BRIDGE.y - L.terrainHeight((M.BRIDGE.ax + M.BRIDGE.bx) / 2, M.BRIDGE.az)).toFixed(0); }
    if (fall < 45) err(`the waterfall is only ${fall.toFixed(0)} m high`);
  }
  // collapse: sink envelope, speeds, debris
  {
    const depth = M.CLEFT.depth;
    const peak = (1.5 * C.SHELF.sinkDepth) / C.SHELF.sinkTime;
    let buried = true, worst = Infinity;
    for (let s = R.cleft.s0; s <= R.cleft.s1; s += 0.25) {
      for (let l = C.SHELF.rideMin; l <= C.SHELF.rideEdge; l += 0.3) {
        const w = C.worldAt(s, l);
        const sunk = C.shelfTopY(s, l) - C.SHELF.sinkDepth;
        const margin = L.terrainHeight(w.x, w.z) - sunk;
        worst = Math.min(worst, margin);
        if (margin < 0) buried = false;
      }
    }
    if (!buried) err(`after sinking, part of the shelf is still above the ground (worst margin ${worst.toFixed(2)} m)`);
    else ok(`the sunk shelf ends below the hollow everywhere (margin >= ${worst.toFixed(2)} m); hollow ${depth} m deep; peak sink speed ${peak.toFixed(2)} m/s over ${C.SHELF.sinkTime} s`);
    if (peak > 2.4) err(`peak sink speed ${peak.toFixed(2)} m/s is too fast for a comfortable carry`);
    let bad = 0;
    const lips = C.lipFlights();
    for (const p of lips) {
      const e = C.endpoint(p.frames);
      const hit = M.routeNear(R, e.x, e.z);
      if (C.onRoute(e.x, e.z, e.y, 1.5)) { bad++; err(`lip piece ${p.row} lands on the route at (${e.x.toFixed(1)}, ${e.y.toFixed(1)}, ${e.z.toFixed(1)})`); }
      if (e.y > hit.y - 8 && hit.dist < 40) { bad++; err(`lip piece ${p.row} comes to rest only ${(hit.y - e.y).toFixed(1)} m below the ledge (should fall into the valley)`); }
    }
    let pebOnRoute = 0, pebTotal = 0, pebFall = 0;
    for (const pb of C.pebbleFlights()) {
      const e = C.endpoint(pb.frames);
      pebTotal++;
      const hit = M.routeNear(R, e.x, e.z);
      if (e.y < hit.y - 8) pebFall++;
      if (C.onRoute(e.x, e.z, e.y, 0.2) && hit.s > R.cleft.s1 + 1) pebOnRoute++;
    }
    if (pebOnRoute) err(`${pebOnRoute} pebble(s) come to rest on the route beyond the shelf`);
    if (!bad && !pebOnRoute) ok(`debris: ${lips.length} lip pieces and ${pebFall}/${pebTotal} pebbles end in the valley (>= 8 m below the ledge); none on the route`);
    const tr = C.worldAt(R.cleft.sMid, 0);
    void tr;
  }
  // trigger/reset logic as pure state tests
  {
    const E = C.EVENT;
    if (!(E.crackFrom > E.crackFull && E.crackFull > E.tremorFrom - 0.5 && E.pebblesFrom > E.tremorFrom && E.cancelBeyond > E.crackFrom && E.resetDistance > E.cancelBeyond && E.resetHardDistance > E.resetDistance)) err('collapse trigger distances are not ordered (crack > pebbles > tremor, cancel > crack, reset > cancel)');
    else ok(`collapse stages: cracks from ${E.crackFrom} m, pebbles from ${E.pebblesFrom} m, tremor from ${E.tremorFrom} m, break ${E.tremorToBreak} s later (or ${E.minTremor} s after stepping on); cancel beyond ${E.cancelBeyond} m; re-arm beyond ${E.resetDistance} m out of sight (${E.resetHardDistance} m always)`);
  }
  // viewpoints stand on valid ground
  {
    let bad = 0;
    for (const [id, v] of Object.entries(L.MTN_VIEWS)) {
      const g = id.startsWith('bridge') ? M.bridgeDeckY(Math.min(1, Math.max(0, (v.x - M.BRIDGE.ax) / M.BRIDGE_LENGTH))) : L.terrainHeight(v.x, v.z);
      if (Math.abs(g - v.y) > 0.7) { bad++; err(`viewpoint ${id}: feet at y ${v.y.toFixed(2)} but the ground is ${g.toFixed(2)}`); }
    }
    if (!bad) ok(`${Object.keys(L.MTN_VIEWS).length} viewpoints (summit, descent, cleft, bridge, brink ...) stand on the ground or deck`);
  }
}

// ---------------------------------------------------------------------------
// 8. EVEREST: the start on the summit, the trail down to Overlook Knoll
// ---------------------------------------------------------------------------
console.log('8. everest: start on the summit, trail to the knoll, guard walls, viewpoints');
{
  const R = L.EV;
  const E = L.EVEREST;
  const PRM = 0.5;
  const STEP = 0.45;
  const CELLM = 0.5;
  const put = (map, k, v) => (map.get(k) ?? map.set(k, []).get(k)).push(v);
  const bk = (x, z) => `${Math.floor(x / 4)},${Math.floor(z / 4)}`;
  const wallB = new Map();
  for (const w of L.EVEREST_GUARDS) for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) put(wallB, `${Math.floor(w.x / 4) + i},${Math.floor(w.z / 4) + j}`, w);
  const blocked = (x, z, h) => {
    for (const w of wallB.get(bk(x, z)) ?? []) {
      if (h < w.y0 - 0.2 || h > w.y1) continue;
      const dx = x - w.x, dz = z - w.z;
      const lx = dx * Math.cos(w.yaw) - dz * Math.sin(w.yaw);
      const lz = dx * Math.sin(w.yaw) + dz * Math.cos(w.yaw);
      if (Math.abs(lx) < w.length / 2 + PRM * 0.2 && Math.abs(lz) < M.GUARD_THICK / 2 + PRM) return true;
    }
    return false;
  };
  // the start
  {
    const g = L.terrainHeight(L.START[0], L.START[1]);
    const top = Math.max(...[...Array(64)].flatMap((_, i) => [...Array(40)].map((__, j) => L.terrainHeight(E.x + Math.cos((i / 64) * 6.2832) * j * 10, E.z + Math.sin((i / 64) * 6.2832) * j * 10))));
    if (Math.abs(g - L.START_Y) > 0.05) err(`the start stands at y ${L.START_Y.toFixed(2)} but the ground there is ${g.toFixed(2)}`);
    else if (top > g + 0.3) err(`the start (${g.toFixed(1)} m) is not the highest ground of the peak (${top.toFixed(1)} m)`);
    else ok(`start on the summit (${L.START[0].toFixed(1)}, ${L.START[1].toFixed(1)}), feet at ${L.START_Y.toFixed(1)} m: the highest ground of the world (east mountain summit ${M.SUMMIT.y.toFixed(0)} m), ${(L.START_Y - E.deck).toFixed(0)} m above the cloud deck`);
    for (const o of [...boxes.map((b) => ({ x: b.x, z: b.z, r: Math.hypot(b.w, b.d) / 2 })), ...circles]) if (Math.hypot(o.x - L.START[0], o.z - L.START[1]) < o.r + 1) err(`a collider stands on the start point (${o.x.toFixed(1)}, ${o.z.toFixed(1)})`);
  }
  // grades
  {
    let worst = { g: 0, s: 0 };
    let prev = R.samples[0];
    for (const q of R.samples) {
      const d = Math.hypot(q.x - prev.x, q.z - prev.z);
      if (d > 0.5) { const g = Math.abs(q.y - prev.y) / d; if (g > worst.g) worst = { g, s: q.s }; prev = q; }
    }
    let off = 0;
    // (the last metres blend onto the knoll's own ground: not compared)
    for (const q of R.samples) if (Math.hypot(q.x - L.HILL.walk.cx, q.z - L.HILL.walk.cz) > L.HILL.walk.r + 1) off = Math.max(off, Math.abs(L.terrainHeight(q.x, q.z) - q.y));
    if (worst.g > 0.45) err(`Everest trail grade ${worst.g.toFixed(2)} at s=${worst.s.toFixed(0)} exceeds 0.45`);
    else if (off > 0.25) err(`the ground under the Everest trail is ${off.toFixed(2)} m off the route profile`);
    else ok(`trail ${R.length.toFixed(0)} m (${(R.length / 1.8 / 60).toFixed(1)} min at walking speed), ${(L.START_Y - R.samples[R.samples.length - 1].y).toFixed(0)} m of descent, steepest grade ${worst.g.toFixed(2)} (${(Math.atan(worst.g) * 57.3).toFixed(0)} deg) at s=${worst.s.toFixed(0)}; ground within ${off.toFixed(2)} m of the profile`);
  }
  // flood fill from the start: down to the knoll, never out of the corridor, never off a drop
  {
    const seen = new Set();
    const i0 = Math.round(L.START[0] / CELLM), j0 = Math.round(L.START[1] / CELLM);
    const q = [[i0, j0, L.terrainHeight(i0 * CELLM, j0 * CELLM)]];
    seen.add(`${i0},${j0}`);
    const drops = [];
    const leaks = [];
    const nodes = [];
    let arrived = 0;
    let reached = 0;
    for (let h = 0; h < q.length && q.length < 400000; h++) {
      const [i, j, ch] = q[h];
      const x = i * CELLM, z = j * CELLM;
      nodes.push([x, z, ch]);
      // inside the knoll's walk disc: sections 4 - 5b take over
      if (Math.hypot(x - L.HILL.walk.cx, z - L.HILL.walk.cz) <= L.HILL.walk.r - 1.2) { arrived++; continue; }
      const hit = M.routeNear(R, x, z);
      if (hit.dist < 1.5 && hit.s > reached) reached = hit.s;
      if (hit.dist > E.hw + 1.6 && Math.hypot(x - E.x, z - E.z) > E.platform + 0.6) leaks.push(`(${x.toFixed(1)}, ${z.toFixed(1)}) ${hit.dist.toFixed(1)} m from the trail`);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di, nj = j + dj, nx = ni * CELLM, nz = nj * CELLM;
        const g = L.terrainHeight(nx, nz);
        if (Math.abs(g - ch) <= STEP && Math.abs(g - ch) / CELLM <= 0.8) {
          if (blocked(nx, nz, g)) continue;
          const k = `${ni},${nj}`;
          if (!seen.has(k)) { seen.add(k); q.push([ni, nj, g]); }
        } else if (g < ch - 1.0 && !blocked(nx, nz, ch)) drops.push(`(${nx.toFixed(1)}, ${nz.toFixed(1)}) ${(ch - g).toFixed(1)} m below (${x.toFixed(1)}, ${z.toFixed(1)})`);
      }
    }
    if (!arrived) {
      const nxt = R.samples.find((p) => p.s > reached + 0.5);
      err(`the walk down from the summit stops at s=${reached.toFixed(1)} of ${R.length.toFixed(0)}${nxt ? ` (next point (${nxt.x.toFixed(1)}, ${nxt.z.toFixed(1)}), ground ${L.terrainHeight(nxt.x, nxt.z).toFixed(2)} vs route ${nxt.y.toFixed(2)})` : ''}`);
    } else ok(`from the summit the whole trail is walkable down onto Overlook Knoll (${nodes.length} walkable cells, capsule 0.5 m, step 0.45 m)`);
    if (leaks.length) err(`${leaks.length} reachable cell(s) outside the guarded corridor, e.g. ${leaks.slice(0, 3).join('; ')}`);
    else ok('the guard walls keep the player on the trail: no reachable cell further than 3.3 m from its centre line');
    if (drops.length) err(`${drops.length} unguarded drop-off(s) on Everest, e.g. ${drops.slice(0, 3).join('; ')}`);
    else ok('no unguarded drop-off: every free neighbour of every reachable cell is walkable or walled');
    let bad = 0;
    for (const [id, v] of Object.entries(L.EVEREST_VIEWS)) {
      const g = L.terrainHeight(v.x, v.z);
      if (Math.abs(g - v.y) > 0.5) { bad++; err(`viewpoint ${id}: feet at y ${v.y.toFixed(2)} but the ground is ${g.toFixed(2)}`); }
      else if (!nodes.some(([nx, nz, nh]) => Math.hypot(nx - v.x, nz - v.z) <= 1.2 && Math.abs(nh - v.y) < 1.2)) { bad++; err(`viewpoint ${id} at (${v.x.toFixed(1)}, ${v.z.toFixed(1)}) is not reachable from the summit`); }
    }
    if (!bad) ok(`${Object.keys(L.EVEREST_VIEWS).length} viewpoints (${Object.keys(L.EVEREST_VIEWS).join(', ')}) stand on reachable ground`);
  }
  // nothing grows or stands in the trail
  {
    const hits = [...circles, ...boxes.map((b) => ({ x: b.x, z: b.z, r: Math.max(b.w, b.d) / 2 }))].filter((c) => c.z > 41 && M.routeNear(R, c.x, c.z).dist < c.r + E.hw);
    if (hits.length) err(`${hits.length} collider(s) stand in the Everest trail, e.g. (${hits[0].x.toFixed(1)}, ${hits[0].z.toFixed(1)})`);
    else ok('no trunk, rock or ruin stands in the trail');
  }
}

console.log(`\n${errors ? 'FAILED' : 'PASSED'}: ${errors} error(s), ${warnings} warning(s)`);
process.exit(errors ? 1 : 0);

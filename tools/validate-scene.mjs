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
  let n = 0;
  let worst = { d: -Infinity, id: '' };
  let deepest = { d: Infinity, id: '' };
  for (const [cls, byAsset] of Object.entries(BAKED.instances)) {
    for (const [asset, flat] of Object.entries(byAsset)) {
      if (exempt.has(asset)) continue;
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
    if (['cliff', 'waterfall', 'pool-trickle', 'heartstone', 'welcome-panel', 'entrance-canopy'].includes(node.id)) continue;
    const above = t[1] - L.terrainHeight(t[0], t[2]);
    if (above > 0.7 || above < -1.2) err(`${node.id} is ${above.toFixed(2)} m from the ground`);
  }
  ok(`${n} baked instances checked: highest above ground ${worst.d.toFixed(3)} m (${worst.id}); deepest sink ${(-deepest.d).toFixed(2)} m (${deepest.id})`);
}

// ---------------------------------------------------------------------------
// Solids (circles) shared by checks 2-4
// ---------------------------------------------------------------------------
const trees = P.treePlacements();
const rocks = P.rockPlacements().filter((r) => r.collider);
const logs = P.deadwoodPlacements().filter((d) => d.collider);
/** @type {{x:number,z:number,r:number,kind:string}[]} */
const circles = [];
trees.forEach((t) => circles.push({ x: t.x, z: t.z, r: t.colliderRadius, kind: 'tree' }));
rocks.forEach((r) => circles.push({ x: r.x, z: r.z, r: r.scale * 0.95, kind: 'rock' }));
for (const d of logs) {
  // Log axis = local X rotated by yaw: world direction (cos yaw, -sin yaw).
  for (let k = -2; k <= 2; k++) circles.push({ x: d.x + Math.cos(d.yaw) * k * (d.length / 4), z: d.z - Math.sin(d.yaw) * k * (d.length / 4), r: 0.36 * d.scale, kind: 'log' });
}
for (let k = -2; k <= 2; k++) circles.push({ x: L.FALLEN_GIANT.x + Math.cos(L.FALLEN_GIANT.yaw) * k * (L.FALLEN_GIANT.length / 4), z: L.FALLEN_GIANT.z - Math.sin(L.FALLEN_GIANT.yaw) * k * (L.FALLEN_GIANT.length / 4), r: 0.9, kind: 'fallen-giant' });
L.PILLARS.forEach((p) => circles.push({ x: p.x, z: p.z, r: 0.62, kind: 'pillar' }));
circles.push({ x: L.ALTAR[0], z: L.ALTAR[1], r: 1.35, kind: 'altar' });
circles.push({ x: L.SPIRE.x, z: L.SPIRE.z, r: 2.5, kind: 'spire' });
{
  // Root arch far leg (the trail passes under the bridge).
  const lx = -2.5;
  circles.push({ x: L.ROOT_ARCH.x + lx * Math.cos(L.ROOT_ARCH.yaw), z: L.ROOT_ARCH.z - lx * Math.sin(L.ROOT_ARCH.yaw), r: 0.5, kind: 'arch-leg' });
}
/** Temple: axis-aligned boxes (local frame == world offsets; temple is not rotated). */
const boxes = [
  { x: L.TEMPLE.x, z: L.TEMPLE.z, w: L.TEMPLE.width, d: L.TEMPLE.depth, kind: 'temple-platform' },
];

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
const Z1 = 22;
const NX = Math.ceil((X1 - X0) / CELL);
const NZ = Math.ceil((Z1 - Z0) / CELL);
const walk = new Uint8Array(NX * NZ);
const slopeLimit = 0.62;
for (let j = 0; j < NZ; j++) {
  for (let i = 0; i < NX; i++) {
    const x = X0 + (i + 0.5) * CELL;
    const z = Z0 + (j + 0.5) * CELL;
    const e = Math.hypot((x - L.WALK_LIMIT.cx) / (L.WALK_LIMIT.rx - 1.2), (z - L.WALK_LIMIT.cz) / (L.WALK_LIMIT.rz - 1.2));
    if (e > 1) continue;
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

console.log(`\n${errors ? 'FAILED' : 'PASSED'}: ${errors} error(s), ${warnings} warning(s)`);
process.exit(errors ? 1 : 0);

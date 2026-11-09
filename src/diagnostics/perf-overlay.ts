import { CanvasTexture, createSystem, DoubleSide, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, VisibilityState, Vector3 } from '@iwsdk/core';
import { governorInfo } from '../systems/quality-governor.js';
import { chunkStats } from '../systems/chunk-lod-system.js';
import { qualityState } from '../settings/quality.js';
import { areaLabel } from '../world/layout.js';
import { atmosphere } from '../systems/atmosphere-system.js';
import { lodInfo } from '../systems/chunk-lod-system.js';
import { metrics } from './frame-metrics.js';
import { isEmulated, perfTest } from './perf-test.js';

/**
 * In-VR performance diagnostics: a small world-space panel on the LEFT CONTROLLER (raise your
 * wrist to read it; it is not head-locked, which is uncomfortable). In the flat browser the same
 * text appears as a DOM overlay. Lightweight: one 512x288 canvas, redrawn 4x per second.
 *
 * Toggle: board button, or ?perf=1 / ?perf=0 (remembered).
 */
const KEY = 'jumanji-vr.perf.overlay.v1';
export const perfOverlay = {
  enabled: (() => {
    const q = new URLSearchParams(globalThis.location?.search ?? '').get('perf');
    if (q === '1' || q === '0') return q === '1';
    try {
      return localStorage.getItem(KEY) === '1';
    } catch {
      return false;
    }
  })(),
  set(on: boolean): void {
    this.enabled = on;
    try {
      localStorage.setItem(KEY, on ? '1' : '0');
    } catch {
      /* ignore */
    }
  },
};

type Line = [string, string];
const GREEN = '#7be08a';
const YELLOW = '#f0d060';
const RED = '#ff7a6a';
const WHITE = '#e8f0e8';
const GREY = '#9aa6a0';

function lines(world: { player: { getWorldPosition(v: Vector3): Vector3 }; renderer: { info: { memory: { geometries: number; textures: number }; programs?: unknown[] | null } } }, tmp: Vector3): Line[] {
  const info = world.renderer.info;
  const s = metrics.summary(1000);
  const period = metrics.periodMs;
  const col = s.meanMs <= period * 1.05 ? GREEN : s.meanMs <= period * 1.3 ? YELLOW : RED;
  const rate = metrics.displayRate ? `${metrics.displayRate} Hz` : 'rate n/a';
  const gpu = s.gpuMs === null ? `GPU time: unavailable` : `GPU ${s.gpuMs.toFixed(1)} ms (p95 ${(s.gpuP95Ms ?? 0).toFixed(1)})`;
  world.player.getWorldPosition(tmp);
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  const out: Line[] = [
    [`FPS ${s.fps.toFixed(1)}  (${rate})`, col],
    [`frame ${s.meanMs.toFixed(1)} ms  p95 ${s.p95Ms.toFixed(1)}  max ${s.maxMs.toFixed(0)}`, col],
    [`missed vsync ${(s.missed * 100).toFixed(0)} %   budget ${period.toFixed(1)} ms`, s.missed > 0.1 ? RED : s.missed > 0.02 ? YELLOW : GREEN],
    [`CPU  update ${s.updateMs.toFixed(1)} + render ${s.renderMs.toFixed(1)} ms`, WHITE],
    [gpu, s.gpuMs === null ? GREY : WHITE],
    [`draws ${s.calls.toFixed(0)}   tris ${(s.tris / 1000).toFixed(0)}k   cells ${chunkStats.shown}/${chunkStats.total}`, WHITE],
    [`tier ${qualityState.tier.toUpperCase()}  shadows ${qualityState.shadows ? 'on' : 'off'}`, WHITE],
    [`governor: ${governorInfo.state}`, governorInfo.step ? YELLOW : GREY],
    ...(isEmulated() ? ([['EMULATOR (not a headset)', RED]] as Line[]) : []),
    [`${areaLabel(tmp.x, tmp.y, tmp.z)}   pos ${tmp.x.toFixed(0)}, ${tmp.y.toFixed(0)}, ${tmp.z.toFixed(0)}`, WHITE],
    [`view ${(atmosphere.open * 100).toFixed(0)}%  far ${atmosphere.far.toFixed(0)} m  terrain ${lodInfo.fineRoots} fine / ${lodInfo.coarseRoots} coarse`, GREY],
    [`geo ${info.memory.geometries}  tex ${info.memory.textures}  prog ${info.programs?.length ?? 0}${mem ? `  heap ${(mem.usedJSHeapSize / 1048576).toFixed(0)}MB` : ''}`, GREY],
  ];
  if (perfTest.state !== 'idle') {
    const pos = perfTest.suiteTotal ? ` (${perfTest.suiteTotal - perfTest.queue.length}/${perfTest.suiteTotal})` : '';
    const label = perfTest.state === 'warm-up' ? `TEST ${perfTest.id}${pos}: warm-up ${perfTest.secondsLeft.toFixed(0)} s` : perfTest.state === 'sampling' ? `TEST ${perfTest.id}${pos}: SAMPLING ${perfTest.secondsLeft.toFixed(0)} s` : `TEST ${perfTest.id}: ${perfTest.state}`;
    out.push([label, YELLOW]);
    if (perfTest.status) out.push([perfTest.status, perfTest.state === 'done' ? GREEN : WHITE]);
  }
  return out;
}

export class PerfOverlaySystem extends createSystem({}) {
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private tex!: CanvasTexture;
  private mesh!: Mesh;
  private dom!: HTMLPreElement;
  private acc = 1;
  private tmp = new Vector3();

  init(): void {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 512;
    this.canvas.height = 416;
    this.ctx = this.canvas.getContext('2d')!;
    this.tex = new CanvasTexture(this.canvas);
    this.tex.colorSpace = SRGBColorSpace;
    const mat = new MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false, side: DoubleSide });
    this.mesh = new Mesh(new PlaneGeometry(0.2, 0.1625), mat);
    this.mesh.name = 'PerfOverlay';
    this.mesh.renderOrder = 1000;
    this.mesh.frustumCulled = false;
    // On the wrist: above the left controller, tilted toward the face.
    this.mesh.position.set(0, 0.075, 0.03);
    this.mesh.rotation.set(-Math.PI / 2.4, 0, 0);
    this.mesh.visible = false;
    this.player.gripSpaces.left.add(this.mesh);

    this.dom = document.createElement('pre');
    Object.assign(this.dom.style, { position: 'fixed', left: '8px', top: '8px', margin: '0', padding: '6px 8px', background: 'rgba(8,14,10,.72)', color: '#e8f0e8', font: '12px/1.35 ui-monospace,Consolas,monospace', zIndex: '9999', pointerEvents: 'none', display: 'none', borderRadius: '4px' });
    document.body.appendChild(this.dom);
    this.cleanupFuncs.push(() => {
      this.mesh.removeFromParent();
      this.dom.remove();
    });
  }

  update(delta: number): void {
    const on = perfOverlay.enabled;
    const immersive = this.world.visibilityState.peek() === VisibilityState.Visible;
    this.mesh.visible = on && immersive;
    this.dom.style.display = on && !immersive ? 'block' : 'none';
    if (!on) return;
    this.acc += delta;
    if (this.acc < 0.25) return;
    this.acc = 0;
    const ls = lines(this.world as never, this.tmp);
    if (immersive) {
      const c = this.ctx;
      c.fillStyle = 'rgba(8,16,12,0.86)';
      c.fillRect(0, 0, 512, 416);
      c.strokeStyle = '#3a5a46';
      c.lineWidth = 4;
      c.strokeRect(2, 2, 508, 412);
      c.font = 'bold 22px monospace';
      c.textBaseline = 'top';
      ls.forEach(([t, col], i) => {
        c.fillStyle = col;
        c.fillText(t, 12, 8 + i * 25);
      });
      this.tex.needsUpdate = true;
    } else {
      this.dom.innerHTML = ls.map(([t, col]) => `<span style="color:${col}">${t.replace(/</g, '&lt;')}</span>`).join('\n');
    }
  }
}

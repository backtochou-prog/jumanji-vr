import { createSystem, VisibilityState } from '@iwsdk/core';

const LOOK_SENSITIVITY = 0.0045; // radians per CSS pixel
const PITCH_LIMIT = (80 * Math.PI) / 180;
const STICK_RADIUS = 52; // px the thumb can travel
const STICK_DEADZONE = 0.32; // fraction of the radius before a direction counts
const MOVE_KEYS = { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD' } as const;
type Dir = keyof typeof MOVE_KEYS;

/** True on phones and tablets (a touch screen as the main pointer). `?touch=1` forces the controls on, `?touch=0` off. */
export function touchControlsWanted(): boolean {
  const q = new URLSearchParams(location.search).get('touch');
  if (q === '1') return true;
  if (q === '0') return false;
  return navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches;
}

/**
 * Phone / tablet controls for the flat (non-VR) page, so the world can be walked on an Android browser before putting the headset on.
 *   - left thumb: a virtual stick (bottom left) walks. It presses the same W/A/S/D keys IWSDK's browser locomotion already reads, so
 *     collision, slopes and speed are exactly the desktop ones (8 directions, no analog speed).
 *   - right thumb / anywhere else on the picture: drag to look around. A tap that does not move still reaches the 3D panels.
 *   - a "full screen" button (also asks for landscape, where the browser allows it).
 * Inside a headset session the overlay is hidden and nothing here runs: the tracked head and controllers own the view.
 */
export class TouchControlsSystem extends createSystem({}) {
  private root: HTMLDivElement | null = null;
  private thumb: HTMLDivElement | null = null;
  private stickPointer = -1;
  private stickX = 0;
  private stickY = 0;
  private lookPointer = -1;
  private lastX = 0;
  private lastY = 0;
  private yaw = 0;
  private pitch = 0;
  private dirty = false;
  private shown = true;
  private readonly held: Record<Dir, boolean> = { up: false, down: false, left: false, right: false };

  init(): void {
    if (!touchControlsWanted()) return;
    const canvas = this.world.renderer.domElement;
    const flat = () => this.world.visibilityState.peek() === VisibilityState.NonImmersive;

    // The page must not scroll, zoom or rubber-band under the thumbs.
    const style = document.createElement('style');
    style.textContent = `
      html, body { overflow: hidden; overscroll-behavior: none; touch-action: none; height: 100%; }
      canvas { touch-action: none; }
      .jt-root { position: fixed; inset: 0; pointer-events: none; z-index: 20; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; font: 600 13px system-ui, sans-serif; }
      .jt-stick { position: absolute; left: max(22px, env(safe-area-inset-left)); bottom: max(26px, env(safe-area-inset-bottom)); width: 136px; height: 136px; border-radius: 50%;
        background: rgba(18, 32, 24, 0.28); border: 2px solid rgba(235, 245, 225, 0.45); pointer-events: auto; touch-action: none; }
      .jt-thumb { position: absolute; left: 50%; top: 50%; width: 58px; height: 58px; margin: -29px 0 0 -29px; border-radius: 50%; background: rgba(235, 245, 225, 0.6); will-change: transform; }
      .jt-full { position: absolute; right: max(12px, env(safe-area-inset-right)); top: max(12px, env(safe-area-inset-top)); padding: 9px 12px; border-radius: 10px; color: #f0f5e6;
        background: rgba(18, 32, 24, 0.5); border: 1px solid rgba(235, 245, 225, 0.4); pointer-events: auto; touch-action: manipulation; }
      .jt-hint { position: absolute; right: max(22px, env(safe-area-inset-right)); bottom: max(34px, env(safe-area-inset-bottom)); color: rgba(240, 245, 230, 0.75); text-shadow: 0 1px 3px #000; transition: opacity 0.6s; }
    `;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.className = 'jt-root';
    const stick = document.createElement('div');
    stick.className = 'jt-stick';
    const thumb = document.createElement('div');
    thumb.className = 'jt-thumb';
    stick.appendChild(thumb);
    const full = document.createElement('button');
    full.className = 'jt-full';
    full.textContent = 'Full screen';
    const hint = document.createElement('div');
    hint.className = 'jt-hint';
    hint.textContent = 'Drag here to look';
    root.append(stick, full, hint);
    document.body.appendChild(root);
    this.root = root;
    this.thumb = thumb;

    // --- walking stick ---
    const stickMove = (e: PointerEvent) => {
      const r = stick.getBoundingClientRect();
      let dx = e.clientX - (r.left + r.width / 2);
      let dy = e.clientY - (r.top + r.height / 2);
      const d = Math.hypot(dx, dy);
      if (d > STICK_RADIUS) {
        dx *= STICK_RADIUS / d;
        dy *= STICK_RADIUS / d;
      }
      this.stickX = dx / STICK_RADIUS;
      this.stickY = dy / STICK_RADIUS;
      thumb.style.transform = `translate(${dx}px, ${dy}px)`;
      this.applyStick();
    };
    const stickEnd = (e: PointerEvent) => {
      if (e.pointerId !== this.stickPointer) return;
      this.stickPointer = -1;
      this.stickX = this.stickY = 0;
      thumb.style.transform = '';
      this.applyStick();
    };
    stick.addEventListener('pointerdown', (e) => {
      if (this.stickPointer !== -1 || !flat()) return;
      this.stickPointer = e.pointerId;
      stick.setPointerCapture(e.pointerId);
      e.preventDefault();
      stickMove(e);
    });
    stick.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stickPointer) stickMove(e);
    });
    stick.addEventListener('pointerup', stickEnd);
    stick.addEventListener('pointercancel', stickEnd);

    // --- look: drag on the picture ---
    const lookDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || this.lookPointer !== -1 || !flat()) return;
      this.lookPointer = e.pointerId;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      const cam = this.world.camera;
      cam.rotation.order = 'YXZ';
      this.yaw = cam.rotation.y;
      this.pitch = cam.rotation.x;
      hint.style.opacity = '0';
    };
    const lookMove = (e: PointerEvent) => {
      if (e.pointerId !== this.lookPointer) return;
      this.yaw -= (e.clientX - this.lastX) * LOOK_SENSITIVITY;
      this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - (e.clientY - this.lastY) * LOOK_SENSITIVITY));
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.dirty = true;
    };
    const lookEnd = (e: PointerEvent) => {
      if (e.pointerId === this.lookPointer) this.lookPointer = -1;
    };
    canvas.addEventListener('pointerdown', lookDown);
    window.addEventListener('pointermove', lookMove);
    window.addEventListener('pointerup', lookEnd);
    window.addEventListener('pointercancel', lookEnd);

    // --- full screen (+ landscape where allowed) ---
    const onFull = () => {
      const done = () => {
        const o = screen.orientation as (ScreenOrientation & { lock?: (o: string) => Promise<void> }) | undefined;
        o?.lock?.('landscape').catch(() => undefined);
      };
      if (document.fullscreenElement) void document.exitFullscreen();
      else document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).then(done, () => undefined);
    };
    full.addEventListener('click', onFull);
    const onFullChange = () => (full.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen');
    document.addEventListener('fullscreenchange', onFullChange);

    // Losing focus (app switch, notification shade) must never leave a walk key stuck down.
    const release = () => {
      this.stickPointer = -1;
      this.lookPointer = -1;
      this.stickX = this.stickY = 0;
      thumb.style.transform = '';
      this.applyStick();
    };
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', release);
    const noMenu = (e: Event) => e.preventDefault();
    root.addEventListener('contextmenu', noMenu);

    this.cleanupFuncs.push(() => {
      release();
      canvas.removeEventListener('pointerdown', lookDown);
      window.removeEventListener('pointermove', lookMove);
      window.removeEventListener('pointerup', lookEnd);
      window.removeEventListener('pointercancel', lookEnd);
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', release);
      document.removeEventListener('fullscreenchange', onFullChange);
      root.remove();
      style.remove();
    });
  }

  /** Turns the stick position into held W/A/S/D keys (the input IWSDK's browser locomotion reads). */
  private applyStick(): void {
    this.setKey('up', this.stickY < -STICK_DEADZONE);
    this.setKey('down', this.stickY > STICK_DEADZONE);
    this.setKey('left', this.stickX < -STICK_DEADZONE);
    this.setKey('right', this.stickX > STICK_DEADZONE);
  }

  private setKey(dir: Dir, down: boolean): void {
    if (this.held[dir] === down) return;
    this.held[dir] = down;
    window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code: MOVE_KEYS[dir], bubbles: true }));
  }

  update(): void {
    if (!this.root) return;
    const flat = this.world.visibilityState.peek() === VisibilityState.NonImmersive;
    if (flat !== this.shown) {
      this.shown = flat;
      this.root.style.display = flat ? '' : 'none';
      if (!flat) {
        this.stickPointer = -1;
        this.lookPointer = -1;
        this.stickX = this.stickY = 0;
        if (this.thumb) this.thumb.style.transform = '';
        this.applyStick();
      }
    }
    if (!this.dirty || !flat) return;
    this.dirty = false;
    const cam = this.world.camera;
    cam.rotation.order = 'YXZ';
    cam.rotation.set(this.pitch, this.yaw, 0);
  }
}

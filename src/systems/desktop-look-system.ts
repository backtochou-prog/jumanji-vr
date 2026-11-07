import { createSystem, VisibilityState } from '@iwsdk/core';

const SENSITIVITY = 0.0032; // radians per pixel
const PITCH_LIMIT = (80 * Math.PI) / 180;

/**
 * Desktop development look controls (outside an XR session only).
 * IWSDK's browser controls move the player (WASD / arrows / gamepad) but do not
 * aim the camera, so: hold the RIGHT mouse button and drag to look around.
 * Left click stays free for the spatial UI. Yaw + pitch are applied to the
 * camera itself, so locomotion (which follows head direction) steers with it.
 * Inside a headset session this system does nothing: the tracked head owns the view.
 */
export class DesktopLookSystem extends createSystem({}) {
  private dragging = false;
  private yaw = 0;
  private pitch = 0;
  private dirty = false;

  init(): void {
    const el = this.world.renderer.domElement;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 2 || this.world.visibilityState.peek() !== VisibilityState.NonImmersive) return;
      this.dragging = true;
      this.yaw = this.world.camera.rotation.y;
      this.pitch = this.world.camera.rotation.x;
      el.setPointerCapture?.(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.yaw -= e.movementX * SENSITIVITY;
      this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - e.movementY * SENSITIVITY));
      this.dirty = true;
    };
    const onUp = (e: PointerEvent) => {
      if (e.button !== 2) return;
      this.dragging = false;
      el.releasePointerCapture?.(e.pointerId);
    };
    const onMenu = (e: Event) => e.preventDefault();
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('contextmenu', onMenu);
    this.cleanupFuncs.push(() => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('contextmenu', onMenu);
    });
  }

  update(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const cam = this.world.camera;
    cam.rotation.order = 'YXZ';
    cam.rotation.set(this.pitch, this.yaw, 0);
  }
}

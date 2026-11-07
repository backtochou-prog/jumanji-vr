/// <reference types="vite/client" />
/// <reference types="@iwsdk/vite-plugin-dev/client" />

interface ImportMetaEnv {
  /** Set to "1" to log player position / FPS / draw calls (see DebugSystem). */
  readonly VITE_JUMANJI_DEBUG?: string;
  /** Dev-only XR framebuffer scale override (see settings/quality.ts). */
  readonly VITE_JUMANJI_XR_SCALE?: string;
  /** Dev-only desktop pixel-ratio override (see settings/quality.ts). */
  readonly VITE_JUMANJI_PIXEL_RATIO?: string;
  /** Set to "0" to disable the adaptive quality governor (tests). */
  readonly VITE_JUMANJI_GOVERNOR?: string;
}

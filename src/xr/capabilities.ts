/**
 * Runtime WebXR feature detection. A Quest browser is NOT assumed to support
 * anything: every capability is probed, and the result is shown on the
 * expedition board and logged, so a failed headset test explains itself.
 */
export interface XRReport {
  secureContext: boolean;
  webxr: boolean;
  immersiveVR: boolean;
  /** Optional features the UA actually granted for the live session (empty before entering). */
  grantedFeatures: string[];
  headline: string;
  detail: string;
}

export async function detectXR(): Promise<XRReport> {
  const secureContext = globalThis.isSecureContext === true;
  const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
  const report: XRReport = { secureContext, webxr: !!xr, immersiveVR: false, grantedFeatures: [], headline: '', detail: '' };
  if (!xr) {
    report.headline = 'WebXR unavailable';
    report.detail = secureContext ? 'This browser has no WebXR. On Quest, open the page in Meta Quest Browser.' : 'WebXR needs HTTPS. Use the https:// address of the dev server.';
    return report;
  }
  try {
    report.immersiveVR = await xr.isSessionSupported('immersive-vr');
  } catch (err) {
    report.detail = `isSessionSupported failed: ${(err as Error).message}`;
  }
  const touch = navigator.maxTouchPoints > 0 && globalThis.matchMedia?.('(pointer: coarse)').matches === true;
  report.headline = report.immersiveVR ? 'VR ready' : touch ? 'Phone mode' : 'Desktop mode';
  if (!report.detail) report.detail = report.immersiveVR ? 'Headset detected: press Enter VR.' : touch ? 'No headset here. Left thumb walks, drag to look; or open on a Quest.' : 'No immersive-vr device here. Use WASD + mouse, or open on a Quest.';
  return report;
}

/** Reads `XRSession.enabledFeatures` (when the UA provides it) after entering VR. */
export function grantedFeatures(session: XRSession | null | undefined): string[] {
  const f = (session as (XRSession & { enabledFeatures?: string[] }) | null | undefined)?.enabledFeatures;
  return f ? [...f] : [];
}

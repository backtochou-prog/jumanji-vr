/**
 * Photographic surface detail: tiling textures cut from the user's texture templates (see photo-textures-data.ts).
 * Each MULTIPLIES the baked vertex colour, like the procedural grain it replaces, so the world's palette and baked
 * shading stay in charge and the photo supplies the surface (rock slabs, strata, forest floor, crown tops, bark, water).
 * The three snow tiles (user's snow sheet: wind-swept drifts, granular frost, packed snow) are read by the Everest snow in `mountainGroundMaterial`.
 * `cloudTexture()` is the sky's cloud atlas (4 photos, sky keyed out to alpha).
 * Deterministic, DOM-free (the module is evaluated in two realms); one texture per name per realm.
 */
import { ClampToEdgeWrapping, DataTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, RGBAFormat, SRGBColorSpace, UnsignedByteType } from '@iwsdk/core';
import { CLOUD_TEX, CLOUD_TEX_SIZE, PHOTO_TEX, PHOTO_TEX_SIZE } from './photo-textures-data.js';

export type PhotoTexName = 'rock' | 'cliff' | 'ledge' | 'canopy' | 'moss' | 'bark' | 'barkMoss' | 'range' | 'water' | 'snowWind' | 'snowGrain' | 'snowPack';

function bytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const cache = new Map<string, DataTexture>();

export function photoTexture(name: PhotoTexName): DataTexture {
  const hit = cache.get(name);
  if (hit) return hit;
  const n = PHOTO_TEX_SIZE;
  const pal = bytes(PHOTO_TEX[name].pal);
  const idx = bytes(PHOTO_TEX[name].idx);
  const data = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    const p = idx[i] * 3;
    data[i * 4] = pal[p];
    data[i * 4 + 1] = pal[p + 1];
    data[i * 4 + 2] = pal[p + 2];
    data[i * 4 + 3] = 255;
  }
  const tex = new DataTexture(data, n, n, RGBAFormat, UnsignedByteType);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.anisotropy = 4;
  tex.name = `photo-${name}`;
  tex.needsUpdate = true;
  cache.set(name, tex);
  return tex;
}

/** Shade colour of the clouds (sRGB bytes): the atlas' light channel runs from this to white. */
const CLOUD_SHADE = [142, 160, 186];
let cloudTex: DataTexture | null = null;

/**
 * Cloud atlas: 2 x 2 tiles (row 0 at v = 0: cumulus heads, cumulus mass; row 1: altocumulus field, cirrus). Straight alpha, colour = shade..white
 * by the light channel (white where alpha is 0, so filtering does not darken the edges). Clamped, no mipmaps (the sky cards are magnified).
 */
export function cloudTexture(): DataTexture {
  if (cloudTex) return cloudTex;
  const n = CLOUD_TEX_SIZE;
  const src = bytes(CLOUD_TEX);
  const data = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    const l = (src[i] >> 4) / 15;
    data[i * 4] = Math.round(CLOUD_SHADE[0] + (255 - CLOUD_SHADE[0]) * l);
    data[i * 4 + 1] = Math.round(CLOUD_SHADE[1] + (255 - CLOUD_SHADE[1]) * l);
    data[i * 4 + 2] = Math.round(CLOUD_SHADE[2] + (255 - CLOUD_SHADE[2]) * l);
    data[i * 4 + 3] = (src[i] & 15) * 17;
  }
  const tex = new DataTexture(data, n, n, RGBAFormat, UnsignedByteType);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.name = 'photo-clouds';
  tex.needsUpdate = true;
  cloudTex = tex;
  return tex;
}

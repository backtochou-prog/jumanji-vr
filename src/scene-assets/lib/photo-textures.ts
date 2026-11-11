/**
 * Photographic surface detail: tiling textures cut from the user's reference video (see photo-textures-data.ts).
 * Each MULTIPLIES the baked vertex colour, like the procedural grain it replaces, so the world's palette and baked
 * shading stay in charge and the photo supplies the surface (lichen, cracks, strata, moss, crown tops).
 * Deterministic, DOM-free (the module is evaluated in two realms); one texture per name per realm.
 */
import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, RGBAFormat, SRGBColorSpace, UnsignedByteType } from '@iwsdk/core';
import { PHOTO_TEX, PHOTO_TEX_SIZE } from './photo-textures-data.js';

export type PhotoTexName = 'rock' | 'cliff' | 'ledge' | 'canopy' | 'moss';

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

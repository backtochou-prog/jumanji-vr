"""Texture generator for the user's template sheets.
usage: python3 -I tools/photo-textures.py <terrain.jpg> <wood.jpg> <mountains.jpg> <clouds.jpg> <out.ts> <preview_dir> <snow.jpg>
Tiles: crop -> 256 px -> flatten lighting -> seamless -> normalise (mean ~0.8 sRGB, part of the hue kept) -> 64 colours -> base64.
Cloud atlas: 4 tiles of 256 px, alpha matte from the blue sky, stored as 4-bit light + 4-bit alpha per pixel.
"""
import sys, base64
import numpy as np
from PIL import Image, ImageFilter

T, W, M, C, OUT, PREV, S = sys.argv[1:8]
N = 256

def load(src, box, n=N):
    return np.asarray(Image.open(src).convert('RGB').crop(box).resize((n, n), Image.LANCZOS), np.float64) / 255.0

def blur_wrap(a, radius):
    # gaussian blur with wrap-around borders (tile 3x3, blur, cut the centre)
    n = a.shape[0]
    big = np.tile(a, (3, 3) + ((1,) if a.ndim == 3 else ()))
    im = Image.fromarray(np.clip(big * 255, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius))
    return np.asarray(im, np.float64)[n:2 * n, n:2 * n] / 255.0

def flatten(a, radius, strength):
    lum = a.mean(2)
    low = blur_wrap(lum, radius)
    gain = (lum.mean() / np.maximum(low, 0.04)) ** strength
    return a * gain[..., None]

def seam1(a, axis):
    # blend with the half-shifted copy along ONE axis: the copy's seam (centre line) sits where the original has full weight
    n = a.shape[0]
    b = np.roll(a, n // 2, axis)
    t = np.abs(np.arange(n) - (n - 1) / 2) / (n / 2)  # 0 centre .. 1 edge
    w = 1.0 - np.clip((t - 0.5) / 0.45, 0, 1)
    w = w * w * (3 - 2 * w)
    w = w[None, :, None] if axis == 1 else w[:, None, None]
    m = a.mean((0, 1))
    return m + (w * (a - m) + (1 - w) * (b - m)) / np.sqrt(w * w + (1 - w) * (1 - w))

def seamless(a):
    return seam1(seam1(a, 1), 0)

def normalise(a, target=0.8, std=0.16, hue_keep=0.3, sat=0.75):
    m = a.mean((0, 1))
    ml = m.mean()
    rel_hue = a / m           # deviation from the tile's mean colour (mean hue removed)
    rel_lum = a / ml          # mean hue kept
    r = rel_hue * (1 - hue_keep) + rel_lum * hue_keep
    lum = r.mean(2, keepdims=True)
    r = lum + (r - lum) * sat
    lum = r.mean(2, keepdims=True)
    s = lum.std()
    r = 1 + (r - 1) * (std / target / max(s, 1e-6))
    return np.clip(r * target, 0, 1)

def quant(a, colors=64):
    im = Image.fromarray(np.clip(a * 255 + 0.5, 0, 255).astype(np.uint8))
    q = im.quantize(colors=colors, method=Image.MEDIANCUT, dither=Image.NONE)
    pal = np.array(q.getpalette()[: colors * 3], np.uint8)
    pal = np.concatenate([pal, np.zeros(colors * 3 - len(pal), np.uint8)])
    idx = np.asarray(q, np.uint8)
    return pal, idx, pal.reshape(-1, 3)[idx]

TILES = {
    # name: (src, box, flatten radius, flatten strength, std, hue_keep)
    'rock':     (T, (540, 500, 668, 628), 40, 0.7, 0.15, 0.3),
    'cliff':    (T, (405, 352, 655, 602), 56, 0.6, 0.17, 0.3),
    'ledge':    (T, (205, 562, 315, 672), 40, 0.8, 0.15, 0.3),
    'canopy':   (T, (14, 14, 336, 336), 56, 0.5, 0.16, 0.25),
    'moss':     (T, (437, 213, 552, 328), 40, 0.6, 0.17, 0.3),
    'bark':     (W, (0, 100, 250, 350), 48, 0.7, 0.16, 0.3),
    'barkMoss': (W, (518, 560, 768, 810), 48, 0.6, 0.17, 0.35),
    'range':    (M, (250, 900, 600, 1250), 64, 0.6, 0.09, 0.2),
    'water':    (T, (400, 740, 620, 960), 56, 0.5, 0.12, 0.3),
    # the snow sheet (3 x 3 photos): 02 wind-swept (the drift forms: little flattening, they ARE the texture), 07 granular frost (the grain),
    # 04 packed snow (the trodden trail). Snow is nearly grey: most of its blue shade is kept (hue_keep) and the shader tints the rest.
    'snowWind': (S, (259, 150, 509, 400), 96, 0.35, 0.11, 0.6),
    'snowGrain': (S, (2, 1070, 252, 1320), 40, 0.7, 0.10, 0.6),
    'snowPack': (S, (2, 500, 252, 750), 64, 0.5, 0.12, 0.6),
}
EXTRA = {
    'rangeA':   (M, (20, 510, 210, 700), 64, 0.6, 0.13, 0.2),
    'rangeC':   (M, (0, 1000, 300, 1300), 64, 0.6, 0.13, 0.2),
    'rapids':   (T, (30, 700, 250, 920), 56, 0.5, 0.14, 0.3),
    'pebble':   (T, (700, 700, 830, 830), 40, 0.7, 0.16, 0.3),
}

def make(spec):
    src, box, rad, strength, std, hue = spec
    a = load(src, box)
    a = flatten(a, rad, strength)
    a = seamless(a)
    a = normalise(a, std=std, hue_keep=hue)
    return quant(a)

def sheet(items, path):
    cols = 5
    rows = (len(items) + cols - 1) // cols
    sh = Image.new('RGB', (cols * (2 * N + 8), rows * (2 * N + 8)), (20, 20, 20))
    for i, (name, rgb) in enumerate(items):
        t = Image.fromarray(np.tile(rgb, (2, 2, 1)))
        sh.paste(t, ((i % cols) * (2 * N + 8), (i // cols) * (2 * N + 8)))
    sh.save(path, quality=90)

out = {}
prev = []
for name, spec in TILES.items():
    pal, idx, rgb = make(spec)
    out[name] = (pal, idx)
    f = rgb / 255.0
    print(name, 'srgb mean', np.round(f.mean((0, 1)), 3), 'std', round(float(f.mean(2).std()), 3))
    prev.append((name, rgb))
sheet(prev, PREV + '/gen_tiles.jpg')
sheet([(n, make(s)[2]) for n, s in EXTRA.items()], PREV + '/gen_extra.jpg')

# ---- cloud atlas -----------------------------------------------------------------------------------------------
def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)

CLOUDS = [
    # (box, vignette x radius, vignette y radius)  tiles: 0 cumulus heads, 1 cumulus mass, 2 altocumulus field, 3 cirrus
    ((258, 0, 510, 252), 'cum'),
    ((258, 200, 510, 452), 'cum'),
    ((0, 470, 253, 723), 'field'),
    ((0, 30, 253, 283), 'wisp'),
]
atlas_l = np.zeros((2 * N, 2 * N))
atlas_a = np.zeros((2 * N, 2 * N))
for i, (box, kind) in enumerate(CLOUDS):
    a = load(C, box)
    mx = a.max(2)
    mn = a.min(2)
    s = 1 - mn / np.maximum(mx, 1e-3)                 # saturation: blue sky high, cloud low
    s_sky = np.percentile(s, 92)
    sky = a[s > np.percentile(s, 85)].mean(0)
    alpha = 1 - smooth(0.30, 0.82, s / s_sky)
    # un-premultiply: pixel = alpha * cloud + (1 - alpha) * sky
    cloud = (a - (1 - alpha[..., None]) * sky) / np.maximum(alpha[..., None], 0.15)
    light = np.clip(cloud.mean(2), 0, 1)
    light = np.where(alpha < 0.2, 1.0, light)
    # light: stretch so the brightest cloud is 1 and shade keeps its depth
    hi = np.percentile(light[alpha > 0.5], 97) if (alpha > 0.5).any() else 1.0
    light = np.clip(light / hi, 0, 1)
    y, x = np.mgrid[0:N, 0:N]
    u = (x + 0.5) / N * 2 - 1
    v = (y + 0.5) / N * 2 - 1
    r = np.sqrt(u * u + v * v)
    if kind == 'cum':
        vig = 1 - smooth(0.62, 0.98, np.maximum(r * 0.92, np.maximum(np.abs(u), np.abs(v))))
    else:
        vig = 1 - smooth(0.45, 0.97, np.maximum(r * 0.95, np.maximum(np.abs(u), np.abs(v))))
    alpha = alpha * vig
    ox, oy = (i % 2) * N, (i // 2) * N
    atlas_l[oy:oy + N, ox:ox + N] = light
    atlas_a[oy:oy + N, ox:ox + N] = alpha
    print('cloud', i, 'sky', np.round(sky, 2), 'coverage', round(float(alpha.mean()), 3))

# 4 bit + 4 bit with a small ordered dither (hides banding in soft gradients)
yy, xx = np.mgrid[0:2 * N, 0:2 * N]
bayer = np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]) / 16.0 - 0.5 + 1 / 32
d = bayer[yy % 4, xx % 4]
ql = np.clip(np.floor(atlas_l * 15 + 0.5 + d * 0.9), 0, 15).astype(np.uint8)
qa = np.clip(np.floor(atlas_a * 15 + 0.5 + d * 0.9), 0, 15).astype(np.uint8)
qa = np.where(atlas_a < 0.012, 0, qa).astype(np.uint8)
packed = (ql << 4 | qa).astype(np.uint8)

# preview: composite over sky blue and over a dark ground
SHADE = np.array([0.55, 0.62, 0.72])
lv = (ql / 15.0)[..., None]
rgb = SHADE + (1 - SHADE) * lv
al = (qa / 15.0)[..., None]
for nm, bg in (('blue', np.array([0.33, 0.56, 0.86])), ('dark', np.array([0.1, 0.16, 0.1]))):
    comp = rgb * al + bg * (1 - al)
    Image.fromarray(np.clip(comp * 255, 0, 255).astype(np.uint8)).save(PREV + f'/gen_clouds_{nm}.jpg', quality=90)

b64 = lambda arr: base64.b64encode(arr.tobytes()).decode('ascii')
with open(OUT, 'w') as f:
    f.write('''/**
 * Surface detail textures cut from the user's texture templates (terrain sheet, wood sheet, misty-mountains photo, cloud sheet, snow sheet), made seamless
 * and normalised so they MULTIPLY the baked vertex colours (mean ~0.8, part of the hue variation kept). 256 px, 64-colour palette + indices,
 * base64. CLOUD_TEX is a 512 px atlas of 4 cloud photos (2 x 2 tiles), one byte per pixel: high nibble = light, low nibble = alpha (the sky was
 * keyed out). GENERATED by tools/photo-textures.py (needs numpy + Pillow; the template images are not in the repo); deterministic and DOM-free (atob only).
 */
export const PHOTO_TEX_SIZE = 256;
export const PHOTO_TEX: Record<string, { pal: string; idx: string }> = {
''')
    for name, (pal, idx) in out.items():
        f.write(f"  {name}: {{ pal: '{b64(pal)}', idx: '{b64(idx)}' }},\n")
    f.write('};\n')
    f.write('export const CLOUD_TEX_SIZE = 512;\n')
    f.write(f"export const CLOUD_TEX = '{b64(packed)}';\n")
print('wrote', OUT)

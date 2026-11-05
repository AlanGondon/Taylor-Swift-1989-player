# Generates the assets for the 1989 three.js cover:
# - a clean cover plate with the original hand-painted 1989 removed
# - an exact, transparent extraction of the painted 1989
# - a per-pixel "write order" map used by the WebGL shader
# Only Pillow + numpy are required.

from PIL import Image, ImageDraw, ImageFilter, ImageFont
import numpy as np
import base64
import json
import math
import os

ROOT = r"C:\Users\张志铭\Desktop\1989-album-site"
ASSETS = os.path.join(ROOT, "assets")
WORK = r"C:\Users\张志铭\Documents\deepseek-harness\default-workspace\_work"
os.makedirs(ASSETS, exist_ok=True)
os.makedirs(WORK, exist_ok=True)

src_path = os.path.join(ASSETS, "cover-source.jpg")
im = Image.open(src_path).convert("RGB")
W, H = im.size
arr = np.asarray(im).astype(np.float32)
gray = np.asarray(im.convert("L")).astype(np.float32)

# ---------------------------------------------------------------- ink masks
digit_regions = {
    "1": ((90, 730, 370, 1540), (220, 1000)),
    "9a": ((360, 520, 1045, 1450), (600, 700)),
    "8": ((1020, 540, 1545, 1440), (1430, 800)),
    "9b": ((1520, 500, 2020, 1480), (1900, 700)),
}

full_mask = np.zeros((H, W), dtype=bool)
digit_masks = {}

for name, ((x0, y0, x1, y1), seed) in digit_regions.items():
    crop_bool = (gray[y0:y1, x0:x1] < 155)
    sy, sx = seed[1] - y0, seed[0] - x0
    # find the closest dark seed pixel
    if not crop_bool[sy, sx]:
        yy, xx = np.nonzero(crop_bool)
        j = np.argmin((yy - sy) ** 2 + (xx - sx) ** 2)
        sy, sx = int(yy[j]), int(xx[j])
    region = np.zeros_like(crop_bool, dtype=bool)
    stack = [(sy, sx)]
    region[sy, sx] = True
    while stack:
        y, x = stack.pop()
        if y > 0 and crop_bool[y - 1, x] and not region[y - 1, x]:
            region[y - 1, x] = True; stack.append((y - 1, x))
        if y + 1 < region.shape[0] and crop_bool[y + 1, x] and not region[y + 1, x]:
            region[y + 1, x] = True; stack.append((y + 1, x))
        if x > 0 and crop_bool[y, x - 1] and not region[y, x - 1]:
            region[y, x - 1] = True; stack.append((y, x - 1))
        if x + 1 < region.shape[1] and crop_bool[y, x + 1] and not region[y, x + 1]:
            region[y, x + 1] = True; stack.append((y, x + 1))
    m = np.zeros((H, W), dtype=bool)
    m[y0:y1, x0:x1] = region
    digit_masks[name] = m
    full_mask |= m
    yy, xx = np.nonzero(m)
    print(name, "px", int(m.sum()), "bbox", (int(xx.min()), int(yy.min()), int(xx.max()), int(yy.max())))

# Isolate the navy marker from dark but colourful pieces of the photo (fabric,
# hair, bird print) that touch the strokes. The marker is almost neutral with a
# blue cast; B >= R - 2 removes those warm/mauve connected fragments.
R, G, B = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
marker = full_mask & (gray < 165) & (B - 2 >= R) & (B + 2 >= G)
mask_img = Image.fromarray((marker * 255).astype(np.uint8), "L")
# Close photographic pin-holes, then open away thin background appendages and
# finally restore a little softness around the perimeter.
mask_img = mask_img.filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.MinFilter(9))
mask_img = mask_img.filter(ImageFilter.MinFilter(7)).filter(ImageFilter.MaxFilter(7))
mask_img = mask_img.filter(ImageFilter.MaxFilter(5))
alpha = np.asarray(mask_img.filter(ImageFilter.GaussianBlur(1.0))).astype(np.float32) / 255.0
alpha[alpha < 0.03] = 0.0
marker_binary = alpha > 0.06

# Ink colour: keep the actual pigment texture and reflection, add a touch of depth.
ink_rgb = arr.copy()
ink_rgb = np.clip(ink_rgb * 0.90, 0, 255)
ink_rgba = np.dstack([ink_rgb, alpha * 255.0]).astype(np.uint8)
ink_rgba[alpha <= 0.004] = 0
ink_img = Image.fromarray(ink_rgba, "RGBA")
ink_img.save(os.path.join(ASSETS, "ink-1989.webp"), "WEBP", quality=88, method=6)

# ------------------------------------------------------------ clean cover
# Normalized convolution: estimate the photo underneath the huge letters from
# the surrounding picture, then feather it back in. The painted numbers are then
# re-introduced only by the writing shader.
fill_hard = mask_img.filter(ImageFilter.MaxFilter(31))
fill_img = fill_hard.filter(ImageFilter.GaussianBlur(7))
fill = np.asarray(fill_img).astype(np.float32) / 255.0
binary = (np.asarray(fill_hard, dtype=np.float32) / 255.0)
# no need to exclude pixels this far outside the original stroke
exclude = 1.0 - binary


def blur_plane(plane, sigma, normalized=False):
    if normalized:
        p = Image.fromarray(np.clip(plane * 255.0, 0, 255).astype(np.uint8), "L")
        out = np.asarray(p.filter(ImageFilter.GaussianBlur(sigma)), dtype=np.float32) / 255.0
    else:
        p = Image.fromarray(np.clip(plane, 0, 255).astype(np.uint8), "L")
        out = np.asarray(p.filter(ImageFilter.GaussianBlur(sigma)), dtype=np.float32)
    return out


bg = np.zeros_like(arr)
SIGMA = 160.0
# Clamping the denominator avoids the faint colour rings produced by dividing
# by an almost-empty support deep inside the thickest letter strokes.
den = blur_plane(exclude, SIGMA, normalized=True)
den = np.maximum(den, 0.15)
for c in range(3):
    num = blur_plane(arr[:, :, c] * exclude, SIGMA)
    bg[:, :, c] = num / den

# A soft local lift around the removed area keeps it from looking pasted in.
clean = arr * (1.0 - fill[:, :, None]) + bg * fill[:, :, None]
# Very light overall polish, leaving the photo's texture intact.
clean_img = Image.fromarray(np.clip(clean, 0, 255).astype(np.uint8), "RGB")
clean_img = clean_img.filter(ImageFilter.GaussianBlur(0.38))
clean_img.save(os.path.join(ASSETS, "cover-clean.jpg"), quality=93, subsampling=1)

# --------------------------------------------------------------- stroke paths
# Coordinates are in the source cover's 2048 x 2048 pixel space. The painted
# mark is a very wide brush, so these are centre lines, not contours.
strokes = [
    # t0, t1, points
    (0.020, 0.155, [
        (235, 820), (228, 910), (221, 1010), (215, 1110),
        (211, 1210), (207, 1300), (194, 1380), (167, 1450),
    ]),
    # first 9: upper-right start, counter-clockwise bowl, down the long stem
    (0.180, 0.455, [
        (795, 650), (715, 615), (610, 625), (515, 675),
        (472, 760), (490, 860), (565, 930), (680, 950),
        (785, 910), (830, 820), (845, 735),
        (875, 870), (900, 1010), (918, 1150), (920, 1300),
    ]),
    # 8, upper bowl
    (0.485, 0.630, [
        (1370, 685), (1300, 622), (1185, 620), (1100, 700),
        (1080, 800), (1120, 900), (1210, 952), (1320, 940),
        (1400, 855), (1415, 755), (1370, 685),
    ]),
    # 8, lower bowl
    (0.635, 0.785, [
        (1270, 1000), (1380, 1030), (1435, 1130), (1415, 1245),
        (1330, 1335), (1210, 1350), (1110, 1280), (1080, 1180),
        (1130, 1075), (1210, 1020), (1270, 1005),
    ]),
    # final 9
    (0.815, 0.995, [
        (1805, 650), (1740, 610), (1640, 615), (1585, 680),
        (1575, 760), (1620, 825), (1710, 840), (1795, 800),
        (1835, 720),
        (1860, 850), (1880, 1000), (1895, 1160), (1890, 1300),
        (1870, 1370),
    ]),
]

# ------------------------------------------------------------------ write map
MAP_SIZE = 1024
scale = MAP_SIZE / W
write_map = np.zeros((MAP_SIZE, MAP_SIZE), dtype=np.float32)
ink_alpha_small = np.asarray(
    Image.fromarray((alpha * 255).astype(np.uint8), "L").resize((MAP_SIZE, MAP_SIZE), Image.Resampling.LANCZOS),
    dtype=np.float32,
) / 255.0
ink_small = ink_alpha_small > 0.10

all_samples = []
for t0, t1, pts in strokes:
    pts = np.array(pts, dtype=np.float32) * scale
    # sample the polyline evenly so every section contributes equally
    samples = []
    for a, b in zip(pts[:-1], pts[1:]):
        seg = b - a
        length = float(np.linalg.norm(seg))
        n = max(2, int(math.ceil(length / 2.0)))
        for i in range(n):
            f = i / n
            samples.append((a + seg * f, length / n))
    samples.append((pts[-1], 0.0))
    lens = np.array([s[1] for s in samples], dtype=np.float32)
    cum = np.concatenate([[0.0], np.cumsum(lens[:-1])])
    total = max(float(cum[-1]), 1.0)
    xyz = np.array([s[0] for s in samples], dtype=np.float32)
    times = t0 + (t1 - t0) * (cum / total)
    all_samples.append((xyz, times))

# Assign to every ink pixel the moment when the brush centre passes nearest to it.
yy, xx = np.nonzero(ink_small)
points = np.column_stack([xx.astype(np.float32), yy.astype(np.float32)])
if len(points):
    best_d = np.full(len(points), np.inf, dtype=np.float32)
    best_t = np.zeros(len(points), dtype=np.float32)
    for xyz, times in all_samples:
        # chunk over path samples to keep memory low and reduce passes
        px = xyz[:, 0][None, :]
        py = xyz[:, 1][None, :]
        for j in range(0, len(points), 5000):
            q = points[j:j + 5000]
            d2 = (q[:, 0:1] - px) ** 2 + (q[:, 1:2] - py) ** 2
            idx = np.argmin(d2, axis=1)
            dd = d2[np.arange(len(q)), idx]
            take = dd < best_d[j:j + 5000]
            best_d[j:j + 5000][take] = dd[take]
            best_t[j:j + 5000][take] = times[idx[take]]
    # tiny bristle irregularity
    rng = np.random.default_rng(1989)
    best_t = np.clip(best_t + rng.normal(0, 0.0016, len(best_t)), 0.0, 1.0)
    write_map[yy, xx] = best_t

# The small map is upscale-friendly; soft edge at the end of each stroke.
wm = Image.fromarray(np.clip(write_map * 255, 0, 255).astype(np.uint8), "L")
wm = wm.filter(ImageFilter.GaussianBlur(0.5))
wm.save(os.path.join(ASSETS, "write-map.png"), optimize=True)
# Also remember where the visual write has tiny gaps, for the preview.
np.save(os.path.join(WORK, "write_map.npy"), write_map)
np.save(os.path.join(WORK, "ink_alpha.npy"), alpha)

# ----------------------------------------------------------- path preview
preview = im.copy().convert("RGB")
d = ImageDraw.Draw(preview)
colors = ["#ff4338", "#ffb000", "#1ee3a4", "#5e7bff", "#ef4cff"]
for i, (t0, t1, pts) in enumerate(strokes):
    path = [(float(x), float(y)) for x, y in pts]
    d.line(path, fill=colors[i], width=8, joint="curve")
    for x, y in path:
        d.ellipse((x - 13, y - 13, x + 13, y + 13), fill=colors[i], outline="white", width=3)
    d.text((path[0][0] + 22, path[0][1] - 34), f"{i+1}", fill=colors[i], font=ImageFont.truetype(r"C:\Windows\Fonts\arialbd.ttf", 44))
preview.save(os.path.join(WORK, "path-preview.jpg"), quality=92)

# ---------------------------------------------------------- reveal previews
font = ImageFont.truetype(r"C:\Windows\Fonts\arialbd.ttf", 30)
frames = []
for u in [0.03, 0.08, 0.14, 0.22, 0.30, 0.38, 0.46, 0.54, 0.62, 0.70, 0.78, 0.86, 0.94, 1.0]:
    reveal = (write_map <= u).astype(np.float32) * ink_alpha_small
    reveal_full = np.asarray(
        Image.fromarray((reveal * 255).astype(np.uint8), "L").resize((W, H), Image.Resampling.BILINEAR),
        dtype=np.float32,
    ) / 255.0
    frame = np.asarray(clean_img).astype(np.float32)
    ink = np.asarray(ink_img).astype(np.float32)
    src_a = ink[:, :, 3:4] / 255.0 * reveal_full[:, :, None]
    frame = np.asarray(im).astype(np.float32) * 0.35 + frame * 0.65
    frame = frame * (1 - src_a) + ink[:, :, :3] * src_a
    img = Image.fromarray(np.clip(frame, 0, 255).astype(np.uint8), "RGB")
    d = ImageDraw.Draw(img)
    d.rectangle((0, 0, 280, 64), fill=(20, 20, 20))
    d.text((18, 13), f"WRITE  {int(u*100):03d}", font=font, fill=(255, 255, 255))
    img.thumbnail((420, 420))
    frames.append(img)

sheet = Image.new("RGB", (5 * 430, 3 * 450), "#e9e2d4")
for i, frame in enumerate(frames):
    x = (i % 5) * 430 + 5
    y = (i // 5) * 450 + 5
    sheet.paste(frame, (x, y))
sheet.save(os.path.join(WORK, "write-preview.jpg"), quality=90)
print("wrote previews")

# ------------------------------------------------------------- base64 data
def b64(path, mime):
    with open(path, "rb") as f:
        return f"data:{mime};base64," + base64.b64encode(f.read()).decode("ascii")

cover_b64 = b64(os.path.join(ASSETS, "cover-source.jpg"), "image/jpeg")
clean_b64 = b64(os.path.join(ASSETS, "cover-clean.jpg"), "image/jpeg")
ink_b64 = b64(os.path.join(ASSETS, "ink-1989.webp"), "image/webp")
map_b64 = b64(os.path.join(ASSETS, "write-map.png"), "image/png")
payload = {
    "cover": cover_b64,
    "clean": clean_b64,
    "ink": ink_b64,
    "writeMap": map_b64,
}
with open(os.path.join(ASSETS, "textures.js"), "w", encoding="utf-8") as f:
    f.write("// Generated from the supplied cover. All artwork is embedded so the\n")
    f.write("// experience also works when index.html is opened directly from disk.\n")
    f.write("window.ALBUM_TEXTURES = ")
    json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    f.write(";\n")
print("textures.js bytes", os.path.getsize(os.path.join(ASSETS, "textures.js")))

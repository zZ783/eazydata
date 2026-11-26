"""Draw the eazydata plugin icon as a sharp 256x256 PNG.

Deterministic (no image model): a rounded-square navy->blue gradient with a
bold white "E" made of three bars and a cyan data-pulse dot, so it reads at
the 32px the provider card uses.
"""
from PIL import Image, ImageDraw
import math, os

S = 1024                     # supersample, then downscale for clean edges
OUT = os.path.join(os.path.dirname(__file__), "..", "assets", "icon.png")

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# --- rounded-square gradient background -----------------------------------
grad = Image.new("RGBA", (S, S))
px = grad.load()
top = (13, 22, 36)           # #0d1624 deep navy
bot = (21, 74, 158)          # #154a9e blue
for y in range(S):
    t = y / (S - 1)
    r = int(top[0] + (bot[0] - top[0]) * t)
    g = int(top[1] + (bot[1] - top[1]) * t)
    b = int(top[2] + (bot[2] - top[2]) * t)
    for x in range(S):
        px[x, y] = (r, g, b, 255)

mask = Image.new("L", (S, S), 0)
md = ImageDraw.Draw(mask)
rad = int(S * 0.22)
md.rounded_rectangle([0, 0, S - 1, S - 1], radius=rad, fill=255)
img.paste(grad, (0, 0), mask)

d = ImageDraw.Draw(img)

# --- bold white "E": three horizontal bars + a spine ----------------------
bar_w = int(S * 0.40)
bar_h = int(S * 0.115)
gap = int(S * 0.075)
left = int(S * 0.30)
right = left + bar_w
total_h = bar_h * 3 + gap * 2
top_y = (S - total_h) // 2
white = (245, 250, 255, 255)
radius_bar = bar_h // 2
for i in range(3):
    y = top_y + i * (bar_h + gap)
    d.rounded_rectangle([left, y, right, y + bar_h], radius=radius_bar, fill=white)
# spine connecting the bars on the left
spine_w = int(S * 0.105)
d.rounded_rectangle(
    [left, top_y, left + spine_w, top_y + total_h],
    radius=int(spine_w * 0.35),
    fill=white,
)

# --- cyan->teal data-pulse dot at lower right -----------------------------
dot_cx = int(S * 0.745)
dot_cy = int(S * 0.715)
dot_r = int(S * 0.115)
for i in range(dot_r, 0, -1):
    t = i / dot_r
    col = (
        int(77 + (52 - 77) * (1 - t)),
        int(201 + (216 - 201) * (1 - t)),
        int(255 + (153 - 255) * (1 - t)),
        255,
    )
    d.ellipse([dot_cx - i, dot_cy - i, dot_cx + i, dot_cy + i], fill=col)

# subtle three-dot "menu" hint at far left, like the card's drag handle rows
img = img.resize((256, 256), Image.LANCZOS)
out = os.path.abspath(OUT)
os.makedirs(os.path.dirname(out), exist_ok=True)
img.save(out)
print("wrote", out, os.path.getsize(out), "bytes")

"""Trace the official logo's white mark into a pure-shape SVG (no <image>).

magpie's provider-card icon seems to render only plain SVG shapes (rect / path /
circle), not an <image> element — that is why the embedded-PNG SVG did not show
while 100milionseek's plain-shape SVG does. This reads assets/icon.png, picks out
the white mark, and emits it as merged horizontal <rect> runs on a blue circle.
"""
from PIL import Image
import os

HERE = os.path.dirname(os.path.abspath(__file__))
PNG = os.path.join(HERE, "..", "assets", "icon.png")
OUT = os.path.join(HERE, "..", "assets", "icon-vector.svg")

N = 128  # trace resolution
im = Image.open(PNG).convert("RGBA").resize((N, N), Image.LANCZOS).convert("RGB")
px = im.load()


def is_white(x, y):
    r, g, b = px[x, y]
    return r > 195 and g > 195 and b > 195


pts = [(x, y) for y in range(N) for x in range(N) if is_white(x, y)]
xs = [p[0] for p in pts]
ys = [p[1] for p in pts]
minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)

scale = 256.0 / N
rects = []
for y in range(miny, maxy + 1):
    x = minx
    while x <= maxx:
        if is_white(x, y):
            x0 = x
            while x <= maxx and is_white(x, y):
                x += 1
            x1 = x - 1
            rx = x0 * scale
            ry = y * scale
            rw = (x1 - x0 + 1) * scale
            rh = scale + 0.6  # slight overlap so rows merge seamlessly
            rects.append('<rect x="%.2f" y="%.2f" width="%.2f" height="%.2f"/>' % (rx, ry, rw, rh))
        else:
            x += 1

svg = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">'
    '<circle cx="128" cy="128" r="128" fill="#1f7bf0"/>'
    '<g fill="#ffffff">' + "".join(rects) + "</g>"
    "</svg>"
)
with open(OUT, "w", encoding="utf-8") as f:
    f.write(svg)
print("rect runs:", len(rects), "| bbox", minx, maxx, miny, maxy)
print("wrote", os.path.abspath(OUT), len(svg), "bytes")

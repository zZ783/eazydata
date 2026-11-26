"""Preview the traced icon: render assets/icon-vector.svg's rects with Pillow
so we can eyeball that the pure-shape trace matches the official logo."""
from PIL import Image, ImageDraw
import re, os

HERE = os.path.dirname(os.path.abspath(__file__))
SVG = os.path.join(HERE, "..", "assets", "icon-vector.svg")
OUT = os.path.join(HERE, "..", "assets", "icon-vector-preview.png")

s = open(SVG, encoding="utf-8").read()
W = 256
im = Image.new("RGBA", (W, W), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
d.ellipse([0, 0, W - 1, W - 1], fill=(31, 123, 240, 255))
for m in re.finditer(r'<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"', s):
    x, y, w, h = map(float, m.groups())
    d.rectangle([x, y, x + w, y + h], fill=(255, 255, 255, 255))
im.save(OUT)
print("wrote", OUT)

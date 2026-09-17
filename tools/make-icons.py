"""Generate the app icons into ../icons.

Run from the repo root:  python tools/make-icons.py   (needs Pillow: pip install pillow)

Draws two overlapping speech bubbles — one with a Latin "A", one with a CJK "文" —
on a teal background, then writes the sizes the manifest and iPhone expect.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"
S = 1024  # working size; everything is downscaled from here

TEAL = (15, 118, 110, 255)
TEAL_DARK = (11, 84, 78, 255)
TEAL_LIGHT = (153, 246, 228, 255)
WHITE = (255, 255, 255, 255)

LATIN_FONTS = ["arialbd.ttf", "segoeuib.ttf", "DejaVuSans-Bold.ttf"]
CJK_FONTS = ["msyhbd.ttc", "msyh.ttc", "simhei.ttf", "malgunbd.ttf", "NotoSansCJK-Bold.ttc"]


def load_font(candidates, size):
    for name in candidates:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return None


def bubble(d, box, tail, fill, glyph, font, fg):
    x0, y0, x1, y1 = box
    d.rounded_rectangle(box, radius=(y1 - y0) * 0.36, fill=fill)
    d.polygon(tail, fill=fill)
    if font and glyph:
        d.text(((x0 + x1) / 2, (y0 + y1) / 2), glyph, font=font, fill=fg, anchor="mm")
    else:  # no suitable font installed — three dots instead
        cy = (y0 + y1) / 2
        r = (y1 - y0) * 0.06
        for i in (-1, 0, 1):
            cx = (x0 + x1) / 2 + i * r * 4
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fg)


def draw_bubbles(d, scale):
    c = S / 2
    u = S * scale
    glyph_size = int(u * 0.24)
    latin = load_font(LATIN_FONTS, glyph_size)
    cjk = load_font(CJK_FONTS, glyph_size)

    # Back bubble (light teal, bottom-right) with "文"
    bubble(
        d,
        [c - 0.12 * u, c - 0.02 * u, c + 0.42 * u, c + 0.38 * u],
        [(c + 0.28 * u, c + 0.36 * u), (c + 0.36 * u, c + 0.50 * u), (c + 0.14 * u, c + 0.38 * u)],
        TEAL_LIGHT, "文", cjk, TEAL_DARK,
    )
    # Front bubble (white, top-left) with "A"
    bubble(
        d,
        [c - 0.42 * u, c - 0.38 * u, c + 0.12 * u, c + 0.02 * u],
        [(c - 0.28 * u, c + 0.00 * u), (c - 0.36 * u, c + 0.14 * u), (c - 0.14 * u, c + 0.02 * u)],
        WHITE, "A", latin, TEAL,
    )


def render(size, rounded, scale, opaque=False):
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=TEAL)
    else:
        d.rectangle([0, 0, S - 1, S - 1], fill=TEAL)
    draw_bubbles(d, scale)
    out = img.resize((size, size), Image.LANCZOS)
    return out.convert("RGB") if opaque else out


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    render(512, True, 1.0).save(OUT / "icon-512.png")
    render(192, True, 1.0).save(OUT / "icon-192.png")
    render(512, False, 0.78).save(OUT / "icon-maskable-512.png")   # Android adaptive icon safe zone
    render(180, False, 0.90, opaque=True).save(OUT / "apple-touch-icon.png")  # iOS rounds it itself
    print("Icons written to", OUT)

#!/usr/bin/env python3
"""Generate the site-wide social share card (og:image / twitter:image).

Centres the TCB logo lockup on a 1200x630 canvas — the size Facebook, X,
LinkedIn and YouTube use for a large link preview. Output is PNG because
several link scrapers still refuse WebP and AVIF.

Requires: Pillow, fonttools, brotli.  Run from the repo root:
    python3 scripts/make-og-image.py
"""
import io
from pathlib import Path

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
LOGO = ROOT / "assets" / "images" / "tcb-icon-512.png"
FONTS = ROOT / "assets" / "fonts"
OUT = ROOT / "assets" / "images" / "tcb-pest-control-og-card.png"

W, H = 1200, 630
LOGO_W = 640          # keeps the upscale off the source art modest
INK_DIM = "#5a5a62"
ACCENT = "#e5251a"
BG = "#ffffff"
TAGLINE = "Licensed, family-run pest control across Canberra & the ACT"


def load_font(woff2_name, size, weight):
    """Pillow can't open woff2, so decompress to TTF in memory first."""
    f = TTFont(FONTS / woff2_name)
    f.flavor = None
    buf = io.BytesIO()
    f.save(buf)
    buf.seek(0)
    font = ImageFont.truetype(buf, size)
    font.set_variation_by_axes([weight])
    return font


def trim(im):
    """Drop the transparent / near-white padding baked into the logo file."""
    rgba = im.convert("RGBA")
    alpha = rgba.getchannel("A")
    box = alpha.getbbox() if alpha.getextrema()[0] < 255 else None
    if box is None:
        box = rgba.convert("L").point(lambda v: 0 if v > 245 else 255).getbbox()
    return rgba.crop(box) if box else rgba


def main():
    card = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(card)

    logo = trim(Image.open(LOGO))
    logo = logo.resize((LOGO_W, round(logo.height * LOGO_W / logo.width)), Image.LANCZOS)
    card.paste(logo, ((W - logo.width) // 2, (H - logo.height) // 2 - 70), logo)

    draw.text(
        (W / 2, H / 2 + 128),
        TAGLINE,
        font=load_font("inter-var.woff2", 30, 500),
        fill=INK_DIM,
        anchor="ms",
    )
    draw.text(
        (W / 2, H - 74),
        "tcbpestcontrolcanberra.com.au",
        font=load_font("inter-var.woff2", 28, 600),
        fill=ACCENT,
        anchor="ms",
    )
    draw.rectangle([0, H - 16, W, H], fill=ACCENT)

    card.save(OUT, "PNG", optimize=True)
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB, {W}x{H})")


if __name__ == "__main__":
    main()

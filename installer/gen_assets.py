"""
Generates the Inno Setup wizard art (installer/assets/*.png) in DELTA's own
brutalist inspection-manifest palette — cream paper, ink borders, hazard-
orange stripes — so the installer reads as part of the same product as the
app, not a generic default wizard. Re-run this after favicon.png changes.

Usage: python gen_assets.py   (run from StandaloneApp/installer/)
"""
import math
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT_DIR = os.path.join(HERE, "assets")
LOGO_PATH = os.path.join(REPO_ROOT, "favicon.png")

PAPER = (242, 238, 226, 255)
INK = (21, 18, 13, 255)
INK_SOFT = (91, 85, 74, 255)
ACCENT = (232, 66, 12, 255)
TARGET = (28, 63, 115, 255)

FONT_BOLD = r"C:\Windows\Fonts\segoeuib.ttf"
FONT_MONO = r"C:\Windows\Fonts\consolab.ttf"


def hazard_stripe(draw, x0, y0, x1, y1, stripe_w=9):
    """45deg repeating ink/accent stripes, clipped to [x0,y0,x1,y1] — the
    same motif as webapp/style.css's .hazard-strip."""
    band = Image.new("RGBA", (x1 - x0, y1 - y0), (0, 0, 0, 0))
    bd = ImageDraw.Draw(band)
    w, h = band.size
    diag = w + h
    i = -h
    toggle = False
    while i < diag:
        color = ACCENT if toggle else INK
        bd.polygon(
            [(i, 0), (i + stripe_w, 0), (i + stripe_w - h, h), (i - h, h)],
            fill=color,
        )
        i += stripe_w
        toggle = not toggle
    draw._image.paste(band, (x0, y0), band)


def circular_logo(size, border=4):
    """Mythics logo inset in a cream disc with an ink ring border, echoing
    .welcome-modal__mark in the app itself."""
    logo = Image.open(LOGO_PATH).convert("RGBA")
    disc = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(disc)
    d.ellipse([0, 0, size - 1, size - 1], fill=PAPER, outline=INK, width=border)
    inner = int(size * 0.62)
    logo = logo.resize((inner, inner), Image.LANCZOS)
    disc.paste(logo, ((size - inner) // 2, (size - inner) // 2), logo)
    return disc


def make_wizard_side(scale):
    w, h = 192 * scale, 386 * scale
    img = Image.new("RGBA", (w, h), PAPER)
    draw = ImageDraw.Draw(img)

    stripe_h = 10 * scale
    hazard_stripe(draw, 0, 0, w, stripe_h, stripe_w=9 * scale)
    hazard_stripe(draw, 0, h - stripe_h, w, h, stripe_w=9 * scale)

    # Right-edge ink rule — reads like the cut edge of a manifest page.
    draw.rectangle([w - 3 * scale, 0, w, h], fill=INK)

    logo_size = 88 * scale
    logo = circular_logo(logo_size, border=3 * scale)
    logo_y = 56 * scale
    img.paste(logo, ((w - logo_size) // 2, logo_y), logo)

    title_font = ImageFont.truetype(FONT_BOLD, 30 * scale)
    sub_font = ImageFont.truetype(FONT_MONO, 11 * scale)
    tag_font = ImageFont.truetype(FONT_MONO, 9 * scale)

    ty = logo_y + logo_size + 22 * scale
    _center_text(draw, w, ty, "DELTA", title_font, INK)
    ty += 34 * scale
    _center_text(draw, w, ty, "DATA VALIDATION", sub_font, INK_SOFT, letter_spacing=2 * scale)
    ty += 16 * scale
    _center_text(draw, w, ty, "CONSOLE", sub_font, INK_SOFT, letter_spacing=2 * scale)

    tag_y = h - stripe_h - 26 * scale
    _center_text(draw, w, tag_y, "RUNS 100% OFFLINE", tag_font, ACCENT, letter_spacing=1 * scale)

    return img


def make_wizard_small(scale):
    size = 58 * scale
    img = Image.new("RGBA", (size, size), PAPER)
    logo = circular_logo(int(size * 0.86), border=max(2, 3 * scale // 2))
    off = (size - logo.size[0]) // 2
    img.paste(logo, (off, off), logo)
    return img


def _center_text(draw, canvas_w, y, text, font, fill, letter_spacing=0):
    if letter_spacing:
        widths = [draw.textlength(ch, font=font) for ch in text]
        total = sum(widths) + letter_spacing * (len(text) - 1)
        x = (canvas_w - total) / 2
        for ch, cw in zip(text, widths):
            draw.text((x, y), ch, font=font, fill=fill)
            x += cw + letter_spacing
    else:
        bbox = draw.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        draw.text(((canvas_w - tw) / 2, y), text, font=font, fill=fill)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    side1 = make_wizard_side(1)
    side1.convert("RGB").save(os.path.join(OUT_DIR, "wizard_side.png"))
    side2 = make_wizard_side(2)
    side2.convert("RGB").save(os.path.join(OUT_DIR, "wizard_side@2x.png"))

    small1 = make_wizard_small(1)
    small1.convert("RGB").save(os.path.join(OUT_DIR, "wizard_small.png"))
    small2 = make_wizard_small(2)
    small2.convert("RGB").save(os.path.join(OUT_DIR, "wizard_small@2x.png"))

    print("Wrote wizard_side.png / @2x, wizard_small.png / @2x to", OUT_DIR)


if __name__ == "__main__":
    main()

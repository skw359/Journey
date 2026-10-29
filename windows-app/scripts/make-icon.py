"""Generate the Windows app icon (assets/icon.ico + icon.png) from the Journey map glyph.

Source: ../map-regular.png (640x640 green folded-map glyph on transparent).
Output: a multi-resolution ICO (16..256 px) with the glyph centered on a
transparent square, plus a 512 px PNG used by the setup page / about dialog.

Requires Pillow. Run from anywhere:  python scripts/make-icon.py
"""
import os
import sys

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    sys.exit("Pillow is required: pip install pillow")

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
SRC = os.path.join(APP, '..', 'map-regular.png')
OUT_DIR = os.path.join(APP, 'assets')
SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]


def make_square(img, pad_ratio=0.06):
    """Trim transparent margins, then center on a square canvas with padding."""
    img = img.convert('RGBA')
    bbox = img.getchannel('A').getbbox()
    if bbox:
        img = img.crop(bbox)
    w, h = img.size
    side = int(max(w, h) * (1 + pad_ratio * 2))
    canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    canvas.paste(img, ((side - w) // 2, (side - h) // 2), img)
    return canvas


def main():
    if not os.path.exists(SRC):
        sys.exit(f'source glyph not found: {SRC}')
    os.makedirs(OUT_DIR, exist_ok=True)
    base = make_square(Image.open(SRC))

    png512 = base.resize((512, 512), Image.LANCZOS)
    png512.save(os.path.join(OUT_DIR, 'icon.png'), optimize=True)

    frames = [base.resize((s, s), Image.LANCZOS) for s in SIZES]
    # Pillow writes every frame we pass via append_images; sizes= must match.
    frames[-1].save(
        os.path.join(OUT_DIR, 'icon.ico'),
        format='ICO',
        sizes=[(s, s) for s in SIZES],
        append_images=frames[:-1],
    )
    sizes = ', '.join(str(s) for s in SIZES)
    print(f"wrote {os.path.join(OUT_DIR, 'icon.ico')} ({sizes}) and icon.png")


if __name__ == '__main__':
    main()

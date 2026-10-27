#!/usr/bin/env python3
"""Cuts the cream background out of branding/source-lumo.png: only the pixels connected to the
image border that look like the cream paper (warm, bright) become transparent, so the sticker's
white outline and grey shadow stay. Writes branding/mark.png (transparent, tight crop, square)."""
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

im = Image.open("branding/source-lumo.png").convert("RGB")
a = np.asarray(im).astype(int)
r, g, b = a[..., 0], a[..., 1], a[..., 2]
# cream paper: bright and warm (blue clearly below red); the white outline has r ~ b
paper = (r + g + b > 700) & (r - b >= 11)
lab, n = ndimage.label(paper)
border = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
bg = np.isin(lab, list(border))
fg = ~bg
flab, fn = ndimage.label(fg)
if fn > 1:
    sizes = ndimage.sum(fg, flab, range(1, fn + 1))
    fg = flab == (1 + int(np.argmax(sizes)))  # the sticker; specks are dropped
alpha = np.where(fg, 255, 0).astype(np.uint8)
# soften the cut by a pixel so no cream halo is left on the outline
alpha_img = Image.fromarray(alpha).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.8))
out = im.convert("RGBA")
out.putalpha(alpha_img)
bbox = out.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
out = out.crop(bbox)
side = max(out.size)
sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
sq.paste(out, ((side - out.width) // 2, (side - out.height) // 2))
sq = sq.resize((1024, 1024), Image.LANCZOS)
sq.save("branding/mark.png")
print("bbox", bbox, "removed", int(bg.sum()), "px")

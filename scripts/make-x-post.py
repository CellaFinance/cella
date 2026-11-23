# Makes the first X post image (1600x900) from the brand font and mark.
#   PYTHONPATH=<folder with fontTools> python3 scripts/make-x-post.py
# Text is drawn as outlines from the font file, so no font needs to be installed.
# Writes brand/x/cella-x-post-1600x900.svg; node renders it (see make-x-post.mjs).
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
import os
root = os.path.join(os.path.dirname(__file__), "..")
f = TTFont(os.path.join(root, "brand/font/CormorantGaramond-Medium.ttf"))
gs, cmap, upm = f.getGlyphSet(), f.getBestCmap(), f["head"].unitsPerEm

def line(text, size, track, cx, y, opacity):
    sc, x, parts = size / upm, 0.0, []
    for ch in text:
        g = cmap[ord(ch)]
        if ch != " ":
            pen = SVGPathPen(gs)
            gs[g].draw(TransformPen(pen, (sc, 0, 0, -sc, x, 0)))
            parts.append(pen.getCommands())
        x += f["hmtx"][g][0] * sc + track
    w = x - track
    return f'<path transform="translate({cx - w / 2:.1f} {y})" fill="#f0ede6" fill-opacity="{opacity}" d="{" ".join(parts)}"/>'

def arches(cx, fade):
    out = []
    for i in range(3):
        r = 190 + i * 100
        top = 560 - r
        out.append(f'<path d="M{cx - r} 960V{top + r}A{r} {r} 0 0 1 {cx + r} {top + r}V960" fill="none" stroke="#f0ede6" stroke-opacity="{fade - i * 0.02:.3f}" stroke-width="1.5"/>')
    return "".join(out)

mark = ('<g transform="translate(720 120) scale(1.6)"><path d="M20 90V46A30 30 0 0 1 80 46V90" fill="none" stroke="#f0ede6" stroke-width="2.5"/>'
        '<path d="M32 90V47A18 18 0 0 1 68 47V90" fill="none" stroke="#f0ede6" stroke-width="1.2"/>'
        '<path d="M44 90V50A6 6 0 0 1 56 50V90Z" fill="#f0ede6"/></g>')
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
<rect width="1600" height="900" fill="#09090a"/>
{arches(1500, 0.08)}{arches(100, 0.05)}
{mark}
{line("Pay without", 92, 1, 800, 480, 1)}
{line("a public trail.", 92, 1, 800, 590, 1)}
{line("Deposit. Pay privately. Withdraw anywhere.", 34, 1, 800, 680, 0.72)}
{line("LIVE ON ROBINHOOD CHAIN   ·   BETA   ·   NOT YET AUDITED", 20, 5, 800, 810, 0.5)}
</svg>'''
open(os.path.join(root, "brand/x/cella-x-post-1600x900.svg"), "w").write(svg)

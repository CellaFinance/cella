# Makes X post images (1600x900) from the brand font and mark.
#   PYTHONPATH=<folder with fontTools> python3 scripts/make-x-post.py [launch|github]
# Text is drawn as outlines from the font file, so no font needs to be installed.
# Writes brand/x/cella-x-post-1600x900.svg; node renders it (see make-x-post.mjs).
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
import os, sys
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

GH = ('<g transform="translate(756 140) scale(5.5)"><path fill="#f0ede6" d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></g>')
MARK = ('<g transform="translate(720 120) scale(1.6)"><path d="M20 90V46A30 30 0 0 1 80 46V90" fill="none" stroke="#f0ede6" stroke-width="2.5"/>'
        '<path d="M32 90V47A18 18 0 0 1 68 47V90" fill="none" stroke="#f0ede6" stroke-width="1.2"/>'
        '<path d="M44 90V50A6 6 0 0 1 56 50V90Z" fill="#f0ede6"/></g>')
VARIANTS = {
    "launch": (MARK, [("Pay without", 92, 1, 480, 1), ("a public trail.", 92, 1, 590, 1)],
               ("Deposit. Pay privately. Withdraw anywhere.", 680), "LIVE ON ROBINHOOD CHAIN   ·   BETA   ·   NOT YET AUDITED"),
    "github": (GH, [("Don't trust.", 92, 1, 480, 1), ("Read the code.", 92, 1, 590, 1)],
               ("Circuits, contracts, relayer and docs. All open.", 680), "GITHUB.COM/CELLAFINANCE/CELLA"),
}
which = sys.argv[1] if len(sys.argv) > 1 else "launch"
mark, heads, (sub, suby), foot = VARIANTS[which]
body = "".join(line(t, sz, tr, 800, y, op) for t, sz, tr, y, op in heads)
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
<rect width="1600" height="900" fill="#09090a"/>
{arches(1500, 0.08)}{arches(100, 0.05)}
{mark}
{body}
{line(sub, 34, 1, 800, suby, 0.72)}
{line(foot, 22, 5, 800, 810, 0.55)}
</svg>'''
name = "cella-x-post-1600x900" if which == "launch" else f"cella-x-post-{which}-1600x900"
open(os.path.join(root, f"brand/x/{name}.svg"), "w").write(svg)
print(name)

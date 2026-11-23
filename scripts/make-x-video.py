# Step 1 of the X teaser video: turns the text lines into outlines from the brand font.
#   PYTHONPATH=<folder with fontTools> python3 scripts/make-x-video.py
# Writes build/video/text.json. Step 2 is scripts/make-x-video.mjs.
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
import json, os
root = os.path.join(os.path.dirname(__file__), "..")
f = TTFont(os.path.join(root, "brand/font/CormorantGaramond-Medium.ttf"))
gs, cmap, upm = f.getGlyphSet(), f.getBestCmap(), f["head"].unitsPerEm

def outline(text, size, track):
    sc, x, parts = size / upm, 0.0, []
    for ch in text:
        g = cmap[ord(ch)]
        if ch != " ":
            pen = SVGPathPen(gs)
            gs[g].draw(TransformPen(pen, (sc, 0, 0, -sc, x, 0)))
            parts.append(pen.getCommands())
        x += f["hmtx"][g][0] * sc + track
    return {"w": x - track, "d": " ".join(parts)}

LINES = {
    "wordmark": ("CELLA", 46, 22),
    "h1": ("We are launching", 118, 1),
    "h2": ("on Pons.", 118, 1),
    "sub": ("Private payments on Robinhood Chain.", 38, 1),
    "soon": ("COMING SOON   ·   CELLA.FINANCE   ·   @CELLAFINANCE", 25, 6),
    "fine": ("BETA   ·   NOT AUDITED   ·   NOT FINANCIAL ADVICE", 19, 5),
}
os.makedirs(os.path.join(root, "build/video"), exist_ok=True)
json.dump({k: outline(*v) for k, v in LINES.items()}, open(os.path.join(root, "build/video/text.json"), "w"))
print("ok")

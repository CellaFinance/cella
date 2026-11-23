// Step 2 of the X teaser video: draws every frame as SVG, rasterizes it, and encodes an MP4 with ffmpeg.
//   node scripts/make-x-video.mjs      -> brand/x/cella-x-pons-teaser-1920x1080.mp4 (10 s, 30 fps, silent)
import sharp from "sharp";
import { readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const T = JSON.parse(readFileSync(join(root, "build/video/text.json"), "utf8"));
const pons = "data:image/png;base64," + readFileSync(join(root, "brand/partners/pons.png")).toString("base64");
const W = 1920, H = 1080, FPS = 30, SECONDS = 10, N = FPS * SECONDS;
const clamp = (v) => Math.min(1, Math.max(0, v));
const ease = (t) => t * t * (3 - 2 * t);
const prog = (t, a, b) => ease(clamp((t - a) / (b - a)));
const n = (v) => v.toFixed(2);

const OUTER = "M20 90V46A30 30 0 0 1 80 46V90", INNER = "M32 90V47A18 18 0 0 1 68 47V90", DOOR = "M44 90V50A6 6 0 0 1 56 50V90Z";
const LEN_OUTER = 44 + Math.PI * 30 + 44, LEN_INNER = 43 + Math.PI * 18 + 43;

const text = (key, cx, y, p, opacity = 1, rise = 26) =>
  p <= 0 ? "" : `<path transform="translate(${n(cx - T[key].w / 2)} ${n(y + (1 - p) * rise)})" fill="#f0ede6" fill-opacity="${n(p * opacity)}" d="${T[key].d}"/>`;

function arches(cx, base, drift) {
  return [0, 1, 2].map((i) => {
    const r = 250 + i * 130, top = 700 - r + drift;
    return `<path d="M${cx - r} 1200V${top + r}A${r} ${r} 0 0 1 ${cx + r} ${top + r}V1200" fill="none" stroke="#f0ede6" stroke-opacity="${n(base - i * 0.02)}" stroke-width="1.6"/>`;
  }).join("");
}

function frame(i) {
  const t = i / FPS;
  const drift = Math.sin(t * 0.6) * 10;
  const bgIn = prog(t, 0, 1.2);
  const end = 1 - prog(t, 9.6, 10);

  // Scene A: the arch draws itself, then the name.
  const outer = prog(t, 0.3, 1.9), inner = prog(t, 0.6, 2.1), door = prog(t, 1.5, 2.5);
  const aOut = 1 - prog(t, 3.5, 4.1);
  const markLift = prog(t, 3.5, 4.1) * -30;
  const mark = aOut <= 0 ? "" : `<g opacity="${n(aOut)}" transform="translate(790 ${n(210 + markLift)}) scale(3.4)">
    <path d="${OUTER}" fill="none" stroke="#f0ede6" stroke-width="2.5" stroke-dasharray="${n(LEN_OUTER)}" stroke-dashoffset="${n(LEN_OUTER * (1 - outer))}"/>
    <path d="${INNER}" fill="none" stroke="#f0ede6" stroke-width="1.2" stroke-dasharray="${n(LEN_INNER)}" stroke-dashoffset="${n(LEN_INNER * (1 - inner))}"/>
    <path d="${DOOR}" fill="#f0ede6" fill-opacity="${n(door)}"/></g>`;
  const wordmark = text("wordmark", 960, 640 + markLift, prog(t, 2.1, 3.0), aOut);

  // Scene B: Pons, then the line.
  const ponsP = prog(t, 4.1, 5.1);
  const size = 230 * (0.92 + 0.08 * ponsP);
  const ponsImg = ponsP <= 0 ? "" : `<image href="${pons}" x="${n(960 - size / 2)}" y="${n(150 + (1 - ponsP) * 24)}" width="${n(size)}" height="${n(size)}" opacity="${n(ponsP)}"/>`;
  const h1 = text("h1", 960, 590, prog(t, 4.7, 5.7));
  const h2 = text("h2", 960, 725, prog(t, 5.1, 6.1));

  // Scene C: what it is, and where to follow.
  const sub = text("sub", 960, 830, prog(t, 7.0, 7.9), 0.74, 14);
  const soon = text("soon", 960, 925, prog(t, 7.9, 8.7), 0.9, 10);
  const fine = text("fine", 960, 1000, prog(t, 8.4, 9.1), 0.5, 8);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#09090a"/>
<g opacity="${n(bgIn)}">${arches(1790, 0.09, drift)}${arches(130, 0.06, -drift)}</g>
<g opacity="${n(end)}">${mark}${wordmark}${ponsImg}${h1}${h2}${sub}${soon}${fine}</g>
</svg>`;
}

const dir = join(root, "build/video/frames");
if (existsSync(dir)) rmSync(dir, { recursive: true });
mkdirSync(dir, { recursive: true });
for (let i = 0; i < N; i++) {
  await sharp(Buffer.from(frame(i)), { density: 72 }).resize(W, H).png({ compressionLevel: 1 }).toFile(join(dir, String(i).padStart(4, "0") + ".png"));
}
const out = join(root, "brand/x/cella-x-pons-teaser-1920x1080.mp4");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", join(dir, "%04d.png"),
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-preset", "slow", "-movflags", "+faststart", out], { stdio: "inherit" });
console.log("written", out);

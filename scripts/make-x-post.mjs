// Renders brand/x/cella-x-post-1600x900.svg to PNG. Run scripts/make-x-post.py first.
import sharp from "sharp";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const x = join(dirname(fileURLToPath(import.meta.url)), "../brand/x");
const name = process.argv[2] ?? "cella-x-post-1600x900";
await sharp(join(x, name + ".svg"), { density: 144 }).resize(1600, 900).png().toFile(join(x, name + ".png"));
console.log("done");

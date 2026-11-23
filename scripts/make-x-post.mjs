// Renders brand/x/cella-x-post-1600x900.svg to PNG. Run scripts/make-x-post.py first.
import sharp from "sharp";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const x = join(dirname(fileURLToPath(import.meta.url)), "../brand/x");
await sharp(join(x, "cella-x-post-1600x900.svg"), { density: 144 }).resize(1600, 900).png().toFile(join(x, "cella-x-post-1600x900.png"));
console.log("done");

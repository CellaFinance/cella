// Compiles circuits/transact.circom into build/ (r1cs, wasm, sym).
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const local = join(root, ".tools/bin/circom");
const circom = existsSync(local) ? local : "circom";
mkdirSync(join(root, "build"), { recursive: true });
execFileSync(circom, ["circuits/transact.circom", "--r1cs", "--wasm", "--sym", "-o", "build", "-l", "node_modules"],
  { cwd: root, stdio: "inherit" });

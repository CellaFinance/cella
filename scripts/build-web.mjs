// Builds the static site (landing page, app, auditor page) for hosting.
//   node scripts/build-web.mjs deployments/46630.json [--relayer https://relayer.example]
// Output: build/web/. Upload that folder as it is.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "./lib/local.mjs";

const file = process.argv[2];
if (!file) { console.error("usage: node scripts/build-web.mjs <deployment.json> [--relayer URL]"); process.exit(1); }
const relayerAt = process.argv.indexOf("--relayer");
const relayer = relayerAt > 0 ? process.argv[relayerAt + 1] : null;

const d = JSON.parse(readFileSync(file, "utf8"));
// Only what a browser needs. Never a test secret, never a local-only flag.
const site = { chainId: d.chainId, chainName: d.chainName, rpc: d.rpc, explorer: d.explorer ?? null,
  pool: d.pool, registry: d.registry, fromBlock: d.fromBlock, relayer: relayer ?? null, testKey: !!d.testKey };
for (const k of ["chainId", "rpc", "pool", "registry", "fromBlock"]) {
  if (site[k] === undefined || site[k] === null) { console.error(`the deployment file has no ${k}`); process.exit(1); }
}
if (/127\.0\.0\.1|localhost/.test(site.rpc)) { console.error("the deployment points at a local chain; refusing to build a public site from it"); process.exit(1); }

const pub = join(ROOT, "web/public");
for (const dir of ["prover", "brand"]) mkdirSync(join(pub, dir), { recursive: true });
copyFileSync(join(ROOT, "build/transact_js/transact.wasm"), join(pub, "prover/transact.wasm"));
copyFileSync(join(ROOT, "build/bench/g16.zkey"), join(pub, "prover/transact.zkey"));

execFileSync(join(ROOT, "node_modules/.bin/vite"), ["build", "--config", "vite.config.mjs"], { cwd: ROOT, stdio: "inherit" });
// The dev chain keeps its own deployment.json in web/public; the built site gets this one.
writeFileSync(join(ROOT, "build/web/deployment.json"), JSON.stringify(site, null, 2) + "\n");

const size = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((t, e) => t + (e.isDirectory() ? size(join(dir, e.name)) : statSync(join(dir, e.name)).size), 0);
console.log(`\nbuild/web ready: ${(size(join(ROOT, "build/web")) / 1e6).toFixed(1)} MB, for ${site.chainName} (${site.chainId})`);
console.log(site.relayer ? `relayer: ${site.relayer}` : "no relayer set: transfers and withdrawals will be sent from the user's own wallet");
if (site.testKey) console.log("note: this site uses the local test proving key.");

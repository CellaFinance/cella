// Local playground: a copy of Robinhood Chain with Cella deployed on it, plus
// the files the web app needs (web/public/deployment.json and the prover).
// Run `node scripts/dev-chain.mjs`, then `npx vite` in another terminal.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as C from "../src/cella.mjs";
import { ROOT, startChain, freshAccount, deployCella } from "./lib/local.mjs";
import { createRelayer } from "../relayer/relayer.mjs";

const PORT = Number(process.env.CELLA_CHAIN_PORT ?? 8579);
const net = await startChain(PORT);
const owner = await freshAccount(net);
const auditor = C.auditorKeyPair();
const deployment = await deployCella(net, owner, auditor.pubKey);

// A relayer with its own throwaway gas wallet.
const RELAYER_PORT = Number(process.env.CELLA_RELAYER_PORT ?? 8580);
const relayer = createRelayer({ publicClient: net.pub, walletClient: net.wallet, account: await freshAccount(net, "10"),
  pool: deployment.pool, chainId: deployment.chainId, log: (line) => console.log("relayer:", line) });
await new Promise((ok) => relayer.server.listen(RELAYER_PORT, "127.0.0.1", ok));

const pub = join(ROOT, "web/public");
for (const d of ["prover", "brand"]) mkdirSync(join(pub, d), { recursive: true });
copyFileSync(join(ROOT, "build/transact_js/transact.wasm"), join(pub, "prover/transact.wasm"));
copyFileSync(join(ROOT, "build/bench/g16.zkey"), join(pub, "prover/transact.zkey"));
copyFileSync(join(ROOT, "brand/svg/cella-mark-ivory-transparent.svg"), join(pub, "brand/mark.svg"));
copyFileSync(join(ROOT, "brand/png/cella-icon-onyx-64.png"), join(pub, "brand/icon-64.png"));
copyFileSync(join(ROOT, "brand/font/CormorantGaramond-Medium.ttf"), join(pub, "brand/CormorantGaramond-Medium.ttf"));
writeFileSync(join(pub, "deployment.json"), JSON.stringify({ ...deployment, rpc: net.url, relayer: `http://127.0.0.1:${RELAYER_PORT}`, devAuditorSecret: auditor.secret.toString(), chainName: "Robinhood Chain (local copy)", dev: true }, null, 2));

console.log(`chain ${net.forked ? "forked from mainnet" : "empty, same chain id"} at ${net.url}`);
console.log("pool", deployment.pool, "registry", deployment.registry);
console.log("relayer", relayer.address, "on port", RELAYER_PORT);
console.log("ready");
process.on("SIGINT", () => { net.proc.kill(); process.exit(0); });
process.on("SIGTERM", () => { net.proc.kill(); process.exit(0); });
setInterval(() => {}, 1 << 30);

// Runs a Cella relayer.
//   CELLA_RELAYER_KEY_FILE  file holding the relayer gas wallet's private key
//                           (default ~/.config/cella/relayer.key; make one with scripts/new-key.mjs relayer)
//   CELLA_RELAYER_KEY       or the key itself. Never commit either.
//   CELLA_RPC           RPC URL of the chain
//   CELLA_CHAIN_ID      chain id (4663 mainnet, 46630 testnet)
//   CELLA_POOL          CellaPool address
//   CELLA_RELAYER_PORT  port to listen on (default 8580)
//   CELLA_ALLOW_ORIGIN  site allowed to call it from a browser (default *)
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createRelayer } from "./relayer.mjs";

const env = (name, fallback) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) { console.error(`missing ${name}`); process.exit(1); }
  return v;
};
const chainId = Number(env("CELLA_CHAIN_ID"));
const rpc = env("CELLA_RPC");
const chain = { id: chainId, name: "chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
const keyFile = process.env.CELLA_RELAYER_KEY_FILE ?? join(homedir(), ".config/cella/relayer.key");
const key = process.env.CELLA_RELAYER_KEY ?? (existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : undefined);
if (!key) { console.error(`no relayer key: set CELLA_RELAYER_KEY or create ${keyFile}`); process.exit(1); }
const account = privateKeyToAccount(key);
const { server, address } = createRelayer({
  publicClient: createPublicClient({ chain, transport: http(rpc) }),
  walletClient: createWalletClient({ chain, transport: http(rpc) }),
  account, chainId, pool: env("CELLA_POOL"), allowOrigin: env("CELLA_ALLOW_ORIGIN", "*"),
  log: (line) => console.log(new Date().toISOString(), line),
});
const port = Number(env("CELLA_RELAYER_PORT", "8580"));
server.listen(port, () => console.log(`relayer ${address} listening on ${port}`));

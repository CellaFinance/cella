// Runs a Cella relayer.
//   CELLA_RELAYER_KEY   private key of the relayer's gas wallet (0x…). Never commit it.
//   CELLA_RPC           RPC URL of the chain
//   CELLA_CHAIN_ID      chain id (4663 mainnet, 46630 testnet)
//   CELLA_POOL          CellaPool address
//   CELLA_RELAYER_PORT  port to listen on (default 8580)
//   CELLA_ALLOW_ORIGIN  site allowed to call it from a browser (default *)
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
const account = privateKeyToAccount(env("CELLA_RELAYER_KEY"));
const { server, address } = createRelayer({
  publicClient: createPublicClient({ chain, transport: http(rpc) }),
  walletClient: createWalletClient({ chain, transport: http(rpc) }),
  account, chainId, pool: env("CELLA_POOL"), allowOrigin: env("CELLA_ALLOW_ORIGIN", "*"),
  log: (line) => console.log(new Date().toISOString(), line),
});
const port = Number(env("CELLA_RELAYER_PORT", "8580"));
server.listen(port, () => console.log(`relayer ${address} listening on ${port}`));

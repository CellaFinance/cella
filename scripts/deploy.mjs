// Deploys Cella: Poseidon hasher, proof verifier, pool, registry.
//
//   node scripts/deploy.mjs --network testnet --auditor-file FILE [--dry-run]
//
//   --network       testnet (46630) or mainnet (4663). Mainnet also needs --unaudited-mainnet,
//                   to say in words that real money goes into contracts no outside auditor has read.
//   --auditor-file  file made by `node auditor/auditor.mjs keygen`; only its public half is used
//   --key-file      deployer key file (default ~/.config/cella/deployer.key, or deployer-mainnet.key)
//   --owner         address that will own the pool (default: the deployer)
//   --max-deposit   ETH per deposit (default 0.1)     --pool-cap  ETH in total (default 5)
//   --dry-run       rehearse on a local copy of the network; nothing is sent to the real chain
//
// Writes deployments/<chainId>.json (or build/dry-run-<chainId>.json for a rehearsal).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, createTestClient, http, parseEther, formatEther, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { poseidonContract } from "circomlibjs";
import * as C from "../src/cella.mjs";
import { ROOT, artifact } from "./lib/local.mjs";

const NETWORKS = {
  testnet: { chainId: 46630, name: "Robinhood Chain Testnet", rpc: "https://rpc.testnet.chain.robinhood.com", explorer: "https://explorer.testnet.chain.robinhood.com",
    verifier: "Groth16Verifier", key: "deployer" },
  mainnet: { chainId: 4663, name: "Robinhood Chain", rpc: "https://rpc.mainnet.chain.robinhood.com", explorer: null,
    verifier: "Groth16VerifierMainnet", key: "deployer-mainnet" },
};
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? true : process.argv[++i];
}
const stop = (message) => { console.error("\nStopped: " + message); process.exit(1); };
const step = (message) => console.log("  " + message);

const network = NETWORKS[args.network];
if (!network) stop("use --network testnet or --network mainnet");
const mainnet = args.network === "mainnet";
if (mainnet && !args["dry-run"] && !args["unaudited-mainnet"]) stop("mainnet holds real money and these contracts have had no outside audit. Add --unaudited-mainnet to go ahead anyway.");
if (!args["auditor-file"]) stop("use --auditor-file FILE (make one with: node auditor/auditor.mjs keygen)");
const auditorKey = JSON.parse(readFileSync(args["auditor-file"], "utf8")).pubKey?.map(BigInt);
if (!auditorKey || !C.onCurve(auditorKey)) stop("the auditor file has no valid public key");

const keyFile = args["key-file"] ?? join(homedir(), `.config/cella/${network.key}.key`);
if (!existsSync(keyFile)) stop(`no deployer key at ${keyFile} (make one with: node scripts/new-key.mjs ${network.key})`);
const account = privateKeyToAccount(readFileSync(keyFile, "utf8").trim());
const owner = getAddress(args.owner ?? account.address);
const maxDeposit = parseEther(String(args["max-deposit"] ?? "0.1")), poolCap = parseEther(String(args["pool-cap"] ?? "5"));
const usesTestKey = readFileSync(join(ROOT, `contracts/${network.verifier}.sol`), "utf8").includes("LOCAL TEST KEY");
if (mainnet && usesTestKey) stop("the mainnet verifier was made from the local test key. Run scripts/ceremony.mjs first.");

let rpc = network.rpc, fork = null;
if (args["dry-run"]) {
  const port = 8590;
  fork = spawn("anvil", ["--port", String(port), "--fork-url", network.rpc, "--silent"], { stdio: "ignore" });
  rpc = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }); break; }
    catch { if (i > 120 || fork.exitCode !== null) stop("could not start a local copy of the network"); await new Promise((r) => setTimeout(r, 250)); }
  }
}
const chain = { id: network.chainId, name: network.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
const pub = createPublicClient({ chain, transport: http(rpc) });
const wallet = createWalletClient({ chain, account, transport: http(rpc) });

try {
  console.log(`${args["dry-run"] ? "REHEARSAL on a local copy of" : "Deploying to"} ${network.name} (${network.chainId})`);
  console.log(`  deployer ${account.address}\n  owner    ${owner}`);
  if (usesTestKey) console.log("  note: the verifier comes from the local test key. Acceptable on a testnet, never on mainnet.");

  if ((await pub.getChainId()) !== network.chainId) stop("the RPC answers for a different chain");
  // Addresses of published test keys carry sweeper code on this chain; anything sent to them is taken.
  if (await pub.getCode({ address: account.address })) stop("the deployer address has code on this chain. Use a freshly made key.");
  if (owner !== account.address && (await pub.getCode({ address: owner }))) console.log("  note: the owner address is a contract.");
  if (args["dry-run"]) await createTestClient({ chain, mode: "anvil", transport: http(rpc) }).setBalance({ address: account.address, value: parseEther("1") });

  const gasPrice = await pub.getGasPrice();
  const balance = await pub.getBalance({ address: account.address });
  if (balance === 0n) stop(`the deployer has no ETH on ${network.name}. Send ${mainnet ? "ETH" : "test ETH from the faucet"} to ${account.address} and run this again.`);

  let gasUsed = 0n, firstBlock = null;
  async function deploy(label, { abi, bytecode }, ctorArgs = []) {
    const hash = await wallet.deployContract({ abi, bytecode, args: ctorArgs });
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") stop(`${label} failed to deploy (${hash})`);
    gasUsed += rc.gasUsed * rc.effectiveGasPrice;
    firstBlock ??= rc.blockNumber;
    step(`${label.padEnd(9)} ${rc.contractAddress}  gas ${rc.gasUsed}`);
    return { address: rc.contractAddress, block: rc.blockNumber };
  }
  const hasherAbi = poseidonContract.generateABI(2);
  const hasher = await deploy("hasher", { abi: hasherAbi, bytecode: poseidonContract.createCode(2) });
  const verifier = await deploy("verifier", artifact(network.verifier, network.verifier));
  const pool = await deploy("pool", artifact("CellaPool", "CellaPool"), [verifier.address, hasher.address, 24, 100, auditorKey, maxDeposit, poolCap, owner]);
  const registry = await deploy("registry", artifact("CellaRegistry", "CellaRegistry"));

  // Read everything back; a deployment that does not match the client is useless.
  const poolAbi = artifact("CellaPool", "CellaPool").abi;
  const read = (functionName) => pub.readContract({ address: pool.address, abi: poolAbi, functionName });
  const check = (ok, what) => { if (!ok) stop("post-deploy check failed: " + what); step("checked: " + what); };
  check((await pub.readContract({ address: hasher.address, abi: hasherAbi, functionName: "poseidon", args: [[1n, 2n]] })) === C.H(1n, 2n), "the on-chain hash equals the client's");
  check((await read("lastRoot")) === new C.Tree().root, "the empty tree root equals the client's");
  const onChainKey = await read("auditorKey");
  check(onChainKey[0] === auditorKey[0] && onChainKey[1] === auditorKey[1], "the auditor key is the one supplied");
  check(getAddress(await read("owner")) === owner, "the owner is as requested");
  check((await read("maxDeposit")) === maxDeposit && (await read("poolCap")) === poolCap, "deposit limits are as requested");
  check(getAddress(await read("verifier")) === getAddress(verifier.address) && getAddress(await read("hasher")) === getAddress(hasher.address), "the pool points at the verifier and hasher just deployed");

  const out = { chainId: network.chainId, chainName: network.name, rpc: network.rpc, explorer: network.explorer,
    pool: pool.address, registry: registry.address, verifier: verifier.address, hasher: hasher.address,
    fromBlock: Number(pool.block), owner, testKey: usesTestKey, maxDeposit: String(args["max-deposit"] ?? "0.1"), poolCap: String(args["pool-cap"] ?? "5") };
  const file = args["dry-run"] ? join(ROOT, `build/dry-run-${network.chainId}.json`) : join(ROOT, `deployments/${network.chainId}.json`);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");

  console.log(`\nCost: ${formatEther(gasUsed)} ETH at ${Number(gasPrice) / 1e9} gwei (deployer had ${formatEther(balance)} ETH)`);
  console.log(`Saved ${file}`);
  console.log(args["dry-run"] ? "Rehearsal finished. Nothing was sent to the real chain." : "Deployed.");
} finally {
  fork?.kill();
}
process.exit(0);

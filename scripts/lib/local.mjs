// Shared by the tests and the dev chain: a local copy of Robinhood Chain and
// a full Cella deployment on it. Never talks to the real chain except to read
// the state the fork starts from.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, createTestClient, http, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { poseidonContract } from "circomlibjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const FORK_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const CHAIN_ID = 4663;

export const artifact = (file, name) => {
  const a = JSON.parse(readFileSync(join(ROOT, `build/forge/${file}.sol/${name}.json`), "utf8"));
  return { abi: a.abi, bytecode: a.bytecode.object };
};
export const chainFor = (url) => ({ id: CHAIN_ID, name: "Robinhood Chain (local copy)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } });

async function up(url, proc) {
  for (let i = 0; i < 160; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });
      if ((await r.json()).result) return true;
    } catch { /* not up yet */ }
    if (proc.exitCode !== null) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Starts anvil as a fork of mainnet; falls back to an empty chain with the same id. */
export async function startChain(port, extraArgs = []) {
  const url = `http://127.0.0.1:${port}`;
  let proc = spawn("anvil", ["--port", String(port), "--fork-url", FORK_RPC, "--silent", ...extraArgs], { stdio: "ignore" });
  let forked = await up(url, proc);
  if (!forked) {
    proc.kill();
    proc = spawn("anvil", ["--port", String(port), "--chain-id", String(CHAIN_ID), "--silent", ...extraArgs], { stdio: "ignore" });
    if (!(await up(url, proc))) throw new Error("anvil did not start");
  }
  const chain = chainFor(url);
  return { proc, url, forked, chain,
    pub: createPublicClient({ chain, transport: http(url) }),
    wallet: createWalletClient({ chain, transport: http(url) }),
    testc: createTestClient({ chain, mode: "anvil", transport: http(url) }) };
}

/** A new random key with ETH. Well-known test keys must not be used: on the real
 *  chain they carry sweeper code, and a fork copies it. */
export async function freshAccount(net, eth = "100") {
  const account = privateKeyToAccount(generatePrivateKey());
  await net.testc.setBalance({ address: account.address, value: parseEther(eth) });
  return account;
}

export async function deployContract(net, owner, { abi, bytecode }, args = []) {
  const hash = await net.wallet.deployContract({ abi, bytecode, args, account: owner, gas: 12_000_000n });
  const rc = await net.pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error("deployment failed");
  return { address: rc.contractAddress, block: rc.blockNumber };
}

export async function deployCella(net, owner, auditorPubKey, { maxDeposit = parseEther("0.1"), poolCap = parseEther("5") } = {}) {
  const hasher = await deployContract(net, owner, { abi: poseidonContract.generateABI(2), bytecode: poseidonContract.createCode(2) });
  const verifier = await deployContract(net, owner, artifact("Groth16Verifier", "Groth16Verifier"));
  const pool = await deployContract(net, owner, artifact("CellaPool", "CellaPool"),
    [verifier.address, hasher.address, 24, 100, auditorPubKey, maxDeposit, poolCap, owner.address]);
  const registry = await deployContract(net, owner, artifact("CellaRegistry", "CellaRegistry"));
  return { chainId: CHAIN_ID, pool: pool.address, registry: registry.address, fromBlock: Number(pool.block) };
}

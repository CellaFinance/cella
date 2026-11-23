// Runs Cella end to end on the real testnet with small amounts:
// deposit, private payment through the relayer, withdrawal through the relayer,
// then reads the pool as the auditor.
//
//   node scripts/testnet-smoke.mjs --relayer http://127.0.0.1:8585 [--deployment deployments/4663.json]
//
// Uses deployments/46630.json unless told otherwise, and the keys in ~/.config/cella/.
// Two extra test wallets (smoke-a, smoke-b) are made there on first run and funded by
// the deployer. On mainnet the keys carry the suffix -mainnet and the amounts are halved.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, parseEther, formatEther, getAddress, toHex, parseEventLogs } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as snarkjs from "snarkjs";
import * as C from "../src/cella.mjs";
import { deriveKeys } from "../src/keys.mjs";
import { CellaClient } from "../src/client.mjs";
import { poolAbi } from "../src/abi.mjs";
import { readLedger, describe, formatEth } from "../auditor/ledger.mjs";
import { ROOT } from "./lib/local.mjs";

const relayerAt = process.argv.indexOf("--relayer");
const relayerUrl = relayerAt > 0 ? process.argv[relayerAt + 1] : null;
const fileAt = process.argv.indexOf("--deployment");
const d = JSON.parse(readFileSync(join(ROOT, fileAt > 0 ? process.argv[fileAt + 1] : "deployments/46630.json"), "utf8"));
const main = !d.testKey;
const suffix = main ? "-mainnet" : "";
// Amounts in ETH: what each wallet is topped up to, then deposit, payment, withdrawal.
const A = main
  ? { relayer: "0.0005", a: "0.0007", b: "0.0001", deposit: "0.0005", pay: "0.0002", out: "0.00005" }
  : { relayer: "0.002", a: "0.002", b: "0.0005", deposit: "0.001", pay: "0.0004", out: "0.0001" };
const dir = join(homedir(), ".config/cella");
const chain = { id: d.chainId, name: d.chainName, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [d.rpc] } } };
const pub = createPublicClient({ chain, transport: http(d.rpc) });
const wallet = createWalletClient({ chain, transport: http(d.rpc) });
const prove = (signals) => snarkjs.groth16.fullProve(signals, join(ROOT, "build/transact_js/transact.wasm"), join(ROOT, main ? "build/mainnet/transact.zkey" : "build/bench/g16.zkey"));
const E = parseEther;
const ethOf = (address) => pub.getBalance({ address });
const cost = (rc) => rc.gasUsed * rc.effectiveGasPrice;
const say = (label, rc, extra = "") => console.log(`${label.padEnd(26)} gas ${String(rc.gasUsed).padStart(8)}  cost ${formatEther(cost(rc))} ETH  ${rc.transactionHash}${extra}`);

function keyOf(name) {
  const file = join(dir, `${name}.key`);
  if (!existsSync(file)) writeFileSync(file, generatePrivateKey() + "\n", { mode: 0o600 });
  return privateKeyToAccount(readFileSync(file, "utf8").trim());
}
async function topUp(from, to, target) {
  if ((await ethOf(to)) >= target / 2n) return;
  const rc = await pub.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ account: from, to, value: target }) });
  say(`fund ${to.slice(0, 8)}…`, rc);
}
async function clientFor(account) {
  const keys = await deriveKeys((message) => account.signMessage({ message }), d.chainId);
  return new CellaClient({ publicClient: pub, walletClient: wallet, account, deployment: d, keys, prove, relayerUrl });
}

const deployer = keyOf("deployer" + suffix), relayerKey = keyOf("relayer" + suffix), a = keyOf("smoke-a" + suffix), b = keyOf("smoke-b" + suffix);
for (const acct of [a, b]) if (await pub.getCode({ address: acct.address })) throw new Error("a test wallet has code on chain");
console.log(`pool ${d.pool} on ${d.chainName}\n`);
await topUp(deployer, relayerKey.address, E(A.relayer));
await topUp(deployer, a.address, E(A.a));
await topUp(deployer, b.address, E(A.b));

const alice = await clientFor(a), bob = await clientFor(b);
for (const [name, c] of [["register A", alice], ["register B", bob]]) { const rc = await c.register(); if (rc) say(name, rc); }

const quote = await alice.quote();
console.log(relayerUrl ? (quote ? `relayer ${quote.address} quotes ${formatEther(quote.fee)} ETH\n` : "relayer not reachable: sending directly\n") : "no relayer given: sending directly\n");

await alice.sync(); await bob.sync();
const start = { alice: alice.balance, bob: bob.balance };
const walletA = await ethOf(a.address);

say(`deposit ${A.deposit}`, await alice.deposit(E(A.deposit)));
const afterDeposit = await ethOf(a.address);
const pay = await alice.transfer(b.address, E(A.pay));
say(`private payment ${A.pay}`, pay, `  sent by ${getAddress(pay.from) === a.address ? "the user" : "the relayer"}`);
const afterPay = await ethOf(a.address);
await bob.sync();
const outside = getAddress(toHex(C.randomField() % (1n << 160n), { size: 20 }));
const out = await bob.withdraw(outside, E(A.out));
say(`withdraw ${A.out}`, out, `  sent by ${getAddress(out.from) === b.address ? "the user" : "the relayer"}`);

const fee = (rc) => parseEventLogs({ abi: poolAbi, logs: rc.logs, eventName: "RelayerPaid" })[0]?.args.fee ?? 0n;
const expect = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) process.exitCode = 1; };
console.log("");
expect(alice.balance === start.alice + E(A.deposit) - E(A.pay) - fee(pay), `A's private balance is ${formatEth(alice.balance)} ETH`);
expect(bob.balance === start.bob + E(A.pay) - E(A.out) - fee(out), `B's private balance is ${formatEth(bob.balance)} ETH`);
expect((await ethOf(outside)) === E(A.out), `the outside address received exactly ${A.out} ETH`);
if (quote) expect(afterPay === afterDeposit, "A's wallet paid no gas for the private payment");
expect(walletA - afterDeposit > E(A.deposit), `the deposit took ${A.deposit} ETH plus gas from A's wallet`);

const fresh = await clientFor(b);
expect((await fresh.sync()) === bob.balance, "a new client with only B's wallet recovers the same balance");

const secret = BigInt(JSON.parse(readFileSync(join(dir, main ? "auditor-mainnet.json" : "auditor-testnet.json"), "utf8")).secret);
const ledger = await readLedger({ publicClient: pub, pool: d.pool, registry: d.registry, fromBlock: d.fromBlock, secret });
console.log("\nAs the auditor:");
for (const r of ledger.records.slice(-3)) console.log("  " + describe(r));
expect(ledger.unreadable === 0 && ledger.reconciled === true, `auditor: balances add up to the ${formatEth(ledger.totalHeld)} ETH in the pool`);
process.exit(process.exitCode ?? 0);

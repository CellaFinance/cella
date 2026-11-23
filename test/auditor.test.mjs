// Auditor tests on a local copy of Robinhood Chain. The auditor sees only what
// the chain publishes plus its own key, exactly as it would in production.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { parseEther, getAddress, toHex } from "viem";
import * as snarkjs from "snarkjs";
import * as C from "../src/cella.mjs";
import { deriveKeys } from "../src/keys.mjs";
import { CellaClient } from "../src/client.mjs";
import { poolAbi } from "../src/abi.mjs";
import { readLedger, describe, toCsv } from "../auditor/ledger.mjs";
import { keygen, loadKey } from "../auditor/auditor.mjs";
import { ROOT, startChain, freshAccount, deployCella } from "../scripts/lib/local.mjs";

const WASM = join(ROOT, "build/transact_js/transact.wasm");
const ZKEY = join(ROOT, "build/bench/g16.zkey");
const prove = (signals) => snarkjs.groth16.fullProve(signals, WASM, ZKEY);
const E = parseEther;
const dir = mkdtempSync(join(tmpdir(), "cella-auditor-"));
const keyFile = join(dir, "auditor-key.json");
let net, owner, deployment, secret, aliceAcct, bobAcct, carolAcct, alice, bob, carol, outside;

async function clientFor(account) {
  const keys = await deriveKeys((message) => account.signMessage({ message }), deployment.chainId);
  return new CellaClient({ publicClient: net.pub, walletClient: net.wallet, account, deployment, keys, prove });
}
const ledgerFor = (s) => readLedger({ publicClient: net.pub, pool: deployment.pool, registry: deployment.registry, fromBlock: deployment.fromBlock, secret: s });
const holder = (ledger, address) => ledger.holders.find((h) => h.address === address)?.balance;

before(async () => {
  net = await startChain(8582);
  owner = await freshAccount(net);
  const pubKey = keygen(keyFile);
  secret = loadKey(keyFile);
  deployment = await deployCella(net, owner, pubKey);
  [aliceAcct, bobAcct, carolAcct] = [await freshAccount(net), await freshAccount(net), await freshAccount(net)];
  [alice, bob, carol] = [await clientFor(aliceAcct), await clientFor(bobAcct), await clientFor(carolAcct)];
  await alice.register();
  await bob.register();
  // Carol never publishes her key: the auditor must still see her, just without an address.
});
after(async () => {
  net?.proc.kill();
  await globalThis.curve_bn128?.terminate?.();
});

test("keygen: the secret file is private, is never overwritten, and its public half is accepted on chain", async () => {
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  assert.throws(() => keygen(keyFile), /already exists/);
  assert.deepEqual([...(await alice.readPool("auditorKey"))], C.pointMul(C.BASE8, secret));
  writeFileSync(join(dir, "junk.json"), "{}");
  assert.throws(() => loadKey(join(dir, "junk.json")), /not a Cella auditor key/);
});

test("the auditor reads a deposit, a private payment and a withdrawal in plain terms", async () => {
  outside = getAddress(toHex(C.randomField() % (1n << 160n), { size: 20 }));
  await alice.deposit(E("0.1"));
  await alice.transfer(bobAcct.address, E("0.03"));
  await bob.withdraw(outside, E("0.01"));

  const ledger = await ledgerFor(secret);
  assert.equal(ledger.unreadable, 0);
  assert.deepEqual(ledger.records.map((r) => r.kind), ["deposit", "transfer", "withdraw"]);
  const [dep, pay, out] = ledger.records;

  assert.equal(dep.senderAddress, aliceAcct.address);
  assert.equal(dep.deposit, E("0.1"));
  assert.equal(dep.depositFrom, aliceAcct.address);

  assert.equal(pay.senderAddress, aliceAcct.address);
  assert.deepEqual(pay.payments.map((p) => [p.address, p.amount]), [[bobAcct.address, E("0.03")]]);
  assert.equal(pay.spent, E("0.1"));

  assert.equal(out.senderAddress, bobAcct.address);
  assert.equal(out.withdrawal, E("0.01"));
  assert.equal(out.withdrawalTo, outside);

  assert.match(describe(pay), new RegExp(`${aliceAcct.address} paid 0\\.03 ETH to ${bobAcct.address}`));
  assert.match(describe(out), new RegExp(`withdrew 0\\.01 ETH to ${outside}`));
});

test("the auditor rebuilds every balance, and they add up to the ETH in the pool", async () => {
  const ledger = await ledgerFor(secret);
  assert.equal(holder(ledger, aliceAcct.address), E("0.07"));
  assert.equal(holder(ledger, bobAcct.address), E("0.02"));
  assert.equal(ledger.total, E("0.09"));
  assert.equal(ledger.totalHeld, E("0.09"));
  assert.equal(ledger.reconciled, true);
  assert.equal(holder(ledger, aliceAcct.address), alice.balance);
  await bob.sync();
  assert.equal(holder(ledger, bobAcct.address), bob.balance);
});

test("a participant who never published an address is still seen, by key", async () => {
  await carol.deposit(E("0.04"));
  const ledger = await ledgerFor(secret);
  const hers = ledger.holders.find((h) => h.pubKey === carol.keys.pubKey);
  assert.equal(hers.address, null);
  assert.equal(hers.balance, E("0.04"));
  assert.match(describe(ledger.records.at(-1)), /^key [0-9a-f]{10}… deposited 0\.04 ETH from wallet /);
  assert.equal(ledger.reconciled, true);
});

test("merging notes shows as a merge and moves no balance", async () => {
  await alice.deposit(E("0.02"));
  await alice.deposit(E("0.02"));
  await alice.transfer(bobAcct.address, E("0.1"));
  const ledger = await ledgerFor(secret);
  assert.ok(ledger.records.some((r) => r.kind === "merge"));
  assert.equal(holder(ledger, aliceAcct.address), E("0.01"));
  assert.equal(holder(ledger, bobAcct.address), E("0.12"));
  assert.equal(ledger.reconciled, true);
});

test("any other key opens nothing", async () => {
  const stranger = C.auditorKeyPair().secret;
  const ledger = await ledgerFor(stranger);
  assert.equal(ledger.unreadable, ledger.records.length);
  assert.ok(ledger.records.length >= 7);
  assert.equal(ledger.holders.length, 0);
  assert.equal(ledger.reconciled, null);
  assert.ok(ledger.records.every((r) => !r.readable && r.sender === undefined));
});

test("after the key changes, the old key reads only the past and the new key only what follows", async () => {
  const next = C.auditorKeyPair();
  const send = async (functionName, args = []) => {
    const hash = await net.wallet.writeContract({ address: deployment.pool, abi: poolAbi, functionName, args, account: owner, gas: 500_000n });
    await net.pub.waitForTransactionReceipt({ hash });
  };
  await send("proposeAuditor", next.pubKey);
  await net.testc.increaseTime({ seconds: 7 * 24 * 3600 + 60 });
  await net.testc.mine({ blocks: 1 });
  await send("activateAuditor");

  const before_ = (await ledgerFor(secret)).records.length;
  await bob.transfer(aliceAcct.address, E("0.05"));

  const old = await ledgerFor(secret);
  assert.equal(old.records.length, before_ + 1);
  assert.equal(old.unreadable, 1);
  assert.equal(old.records.at(-1).kind, "sealed to another key");
  assert.equal(old.reconciled, null);

  const fresh = await ledgerFor(next.secret);
  assert.equal(fresh.unreadable, before_);
  assert.deepEqual(fresh.records.at(-1).payments.map((p) => [p.address, p.amount]), [[aliceAcct.address, E("0.05")]]);
});

test("the command-line tool prints the ledger and a CSV", async () => {
  const run = (...args) => execFileSync("node", [join(ROOT, "auditor/auditor.mjs"), ...args], { encoding: "utf8" });
  const common = ["--key", keyFile, "--rpc", net.url, "--pool", deployment.pool, "--registry", deployment.registry, "--from", String(deployment.fromBlock)];
  const text = run("read", ...common);
  assert.match(text, new RegExp(`${aliceAcct.address} paid 0\\.03 ETH to ${bobAcct.address}`));
  assert.match(text, /1 sealed to another key/);
  assert.match(text, /Cannot reconcile/);

  const csv = run("read", ...common, "--format", "csv");
  assert.match(csv.split("\n")[0], /^block,tx,kind,sender,recipient,amount_eth/);
  assert.ok(csv.includes(`transfer,${aliceAcct.address},${bobAcct.address},0.03,`));
  assert.equal(csv, toCsv(await ledgerFor(secret)));

  assert.match(run("pubkey", "--key", keyFile), new RegExp(`x: ${C.pointMul(C.BASE8, secret)[0]}`));
});

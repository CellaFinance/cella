// Relayer tests on a local copy of Robinhood Chain: real proofs, a real HTTP
// server, and the same client the web app uses.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { parseEther, getAddress, toHex, parseEventLogs } from "viem";
import { poolAbi } from "../src/abi.mjs";
import * as snarkjs from "snarkjs";
import * as C from "../src/cella.mjs";
import { deriveKeys } from "../src/keys.mjs";
import { CellaClient } from "../src/client.mjs";
import { createRelayer } from "../relayer/relayer.mjs";
import { ROOT, startChain, freshAccount, deployCella } from "../scripts/lib/local.mjs";

const WASM = join(ROOT, "build/transact_js/transact.wasm");
const ZKEY = join(ROOT, "build/bench/g16.zkey");
const prove = (signals) => snarkjs.groth16.fullProve(signals, WASM, ZKEY);
const E = parseEther;
const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
const randomAddress = () => getAddress(toHex(C.randomField() % (1n << 160n), { size: 20 }));
const servers = [];
let net, deployment, relayer, relayerAcct, url, aliceAcct, bobAcct, alice, bob, fee;

async function listen(r) {
  await new Promise((ok) => r.server.listen(0, "127.0.0.1", ok));
  servers.push(r.server);
  return `http://127.0.0.1:${r.server.address().port}`;
}
async function clientFor(account, relayerUrl = url) {
  const keys = await deriveKeys((message) => account.signMessage({ message }), deployment.chainId);
  return new CellaClient({ publicClient: net.pub, walletClient: net.wallet, account, deployment, keys, prove, relayerUrl });
}
const post = (body, to = url) => fetch(to + "/relay", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : json(body) });
const ethOf = (address) => net.pub.getBalance({ address });
/** The fee a relayed transaction actually paid. The quote follows the gas price, so it moves between blocks. */
const feePaid = (receipt) => parseEventLogs({ abi: poolAbi, logs: receipt.logs, eventName: "RelayerPaid" })[0].args.fee;
/** All relayer fees paid from `fromBlock` on. */
async function feesSince(fromBlock) {
  const logs = await net.pub.getContractEvents({ address: deployment.pool, abi: poolAbi, eventName: "RelayerPaid", fromBlock });
  return { count: logs.length, total: logs.reduce((t, l) => t + l.args.fee, 0n) };
}

/** Builds a full relayer request without sending it. */
async function capture(client, action) {
  let caught;
  const real = client._relay;
  client._relay = async (proof, ext) => { caught = { proof, ext }; throw new Error("captured"); };
  await assert.rejects(action(), /captured/);
  client._relay = real;
  return JSON.parse(json(caught));
}

before(async () => {
  net = await startChain(8581);
  const owner = await freshAccount(net);
  deployment = await deployCella(net, owner, C.auditorKeyPair().pubKey);
  relayerAcct = await freshAccount(net, "5");
  relayer = createRelayer({ publicClient: net.pub, walletClient: net.wallet, account: relayerAcct, pool: deployment.pool, chainId: deployment.chainId, perMinute: 1000 });
  url = await listen(relayer);
  aliceAcct = await freshAccount(net);
  bobAcct = await freshAccount(net);
  alice = await clientFor(aliceAcct);
  bob = await clientFor(bobAcct);
  await alice.register();
  await bob.register();
});
after(async () => {
  for (const s of servers) s.close();
  net?.proc.kill();
  await globalThis.curve_bn128?.terminate?.();
});

test("the relayer says who it is and what it charges", async () => {
  const info = await (await fetch(url + "/info")).json();
  assert.equal(info.address, relayerAcct.address);
  assert.equal(info.chainId, deployment.chainId);
  assert.equal(info.pool, deployment.pool);
  fee = BigInt(info.fee);
  assert.ok(fee > 0n);
  assert.deepEqual(await alice.quote(), { address: relayerAcct.address, fee });
  assert.equal((await fetch(url + "/nothing")).status, 404);
});

test("a relayed transfer: the sender's wallet is not on it and pays no gas", async () => {
  await alice.deposit(E("0.1"));
  const walletBefore = await ethOf(aliceAcct.address);
  const relayerBefore = await ethOf(relayerAcct.address);

  const receipt = await alice.transfer(bobAcct.address, E("0.03"));
  assert.equal(getAddress(receipt.from), relayerAcct.address);
  assert.equal(await ethOf(aliceAcct.address), walletBefore);
  assert.equal(alice.balance, E("0.07") - feePaid(receipt));
  assert.ok(feePaid(receipt) * 100n >= fee * 50n && feePaid(receipt) <= fee * 2n, "the fee paid should be close to the quote");
  assert.equal(await bob.sync(), E("0.03"));
  assert.ok((await ethOf(relayerAcct.address)) > relayerBefore, "the fee should cover the relayer's gas");
});

test("a relayed withdrawal pays the recipient in full; the fee comes from the private balance", async () => {
  const to = randomAddress();
  const walletBefore = await ethOf(bobAcct.address);
  const receipt = await bob.withdraw(to, E("0.01"));
  assert.equal(getAddress(receipt.from), relayerAcct.address);
  assert.equal(await ethOf(to), E("0.01"));
  assert.equal(await ethOf(bobAcct.address), walletBefore);
  assert.equal(bob.balance, E("0.02") - feePaid(receipt));
});

test("merging notes through the relayer pays one fee per transaction", async () => {
  await alice.deposit(E("0.02"));
  await alice.deposit(E("0.02"));
  const before_ = alice.balance;
  const fromBlock = (await net.pub.getBlockNumber({ cacheTime: 0 })) + 1n;
  const walletBefore = await ethOf(aliceAcct.address);
  const steps = [];
  alice.onStatus = (s) => steps.push(s);

  const amount = before_ - E("0.012");
  await alice.transfer(bobAcct.address, amount);
  const fees = await feesSince(fromBlock);
  assert.equal(steps.filter((s) => s === "merging").length, 1);
  assert.equal(fees.count, 2, "one fee for the merge, one for the payment");
  assert.equal(alice.balance, before_ - amount - fees.total);
  assert.equal(await ethOf(aliceAcct.address), walletBefore);
  assert.ok(steps.includes("relaying") && !steps.includes("sending"));
});

test("refused before anything is sent: low fee, wrong payee, deposits, malformed requests", async () => {
  await alice.deposit(E("0.05"));
  const good = await capture(alice, () => alice.withdraw(randomAddress(), E("0.01")));
  const relayerBefore = await ethOf(relayerAcct.address);
  const refusal = async (body, status, pattern) => {
    const r = await post(body);
    assert.equal(r.status, status);
    if (pattern) assert.match((await r.json()).error, pattern);
  };
  const edit = (f) => { const c = structuredClone(good); f(c); return c; };

  await refusal(edit((c) => { c.ext.fee = "1"; }), 400, /fee too low/);
  await refusal(edit((c) => { c.ext.relayer = randomAddress(); }), 400, /different relayer/);
  await refusal(edit((c) => { c.ext.extAmount = "1000"; }), 400, /deposits cannot be relayed/);
  await refusal(edit((c) => { c.ext.recipient = randomAddress(); }), 400, /pool would refuse/);
  await refusal(edit((c) => { c.proof.a = ["1", "2"]; }), 400, /pool would refuse/);
  await refusal(edit((c) => { c.proof.a = ["0x01", "2"]; }), 400, /decimal number/);
  await refusal(edit((c) => { c.proof.auditCipher.pop(); }), 400, /5 values/);
  await refusal(edit((c) => { delete c.ext; }), 400, /proof, ext/);
  await refusal(edit((c) => { c.ext.note0 = "zz"; }), 400, /hex/);
  await refusal("not json", 400, /not JSON/);
  await refusal("x".repeat(30_000), 413);
  assert.equal(await ethOf(relayerAcct.address), relayerBefore, "a refused request must cost the relayer nothing");

  const ok = await post(good);
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).hash, /^0x[0-9a-f]{64}$/);
  await refusal(good, 400, /pool would refuse/);
});

test("too many requests from one address are turned away", async () => {
  const strict = createRelayer({ publicClient: net.pub, walletClient: net.wallet, account: relayerAcct, pool: deployment.pool, chainId: deployment.chainId, perMinute: 3 });
  const strictUrl = await listen(strict);
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await post("{}", strictUrl)).status);
  assert.deepEqual(codes, [400, 400, 400, 429, 429]);
});

test("no relayer, or one serving another pool: the client sends from the wallet itself", async () => {
  const elsewhere = createRelayer({ publicClient: net.pub, walletClient: net.wallet, account: relayerAcct, pool: randomAddress(), chainId: deployment.chainId });
  const wrong = await clientFor(aliceAcct, await listen(elsewhere));
  assert.equal(await wrong.quote(), null);

  const offline = await clientFor(bobAcct, "http://127.0.0.1:9");
  assert.equal(await offline.quote(), null);
  const receipt = await offline.withdraw(bobAcct.address, E("0.001"));
  assert.equal(getAddress(receipt.from), bobAcct.address);
});

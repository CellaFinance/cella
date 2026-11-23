// End-to-end tests of the client against a local copy of Robinhood Chain:
// the same code the web app runs, with real proofs and real encrypted notes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { parseEther, getAddress, toHex } from "viem";
import * as snarkjs from "snarkjs";
import * as C from "../src/cella.mjs";
import { deriveKeys } from "../src/keys.mjs";
import { encryptNote, decryptNote, NOTE_BYTES } from "../src/notes.mjs";
import { CellaClient } from "../src/client.mjs";
import { ROOT, startChain, freshAccount, deployCella, deployContract, artifact } from "../scripts/lib/local.mjs";

const WASM = join(ROOT, "build/transact_js/transact.wasm");
const ZKEY = join(ROOT, "build/bench/g16.zkey");
const prove = (signals) => snarkjs.groth16.fullProve(signals, WASM, ZKEY);
const E = parseEther;
let net, deployment, auditor, aliceAcct, bobAcct, alice, bob;

async function clientFor(account) {
  const keys = await deriveKeys((message) => account.signMessage({ message }), deployment.chainId, { verify: true });
  return new CellaClient({ publicClient: net.pub, walletClient: net.wallet, account, deployment, keys, prove });
}

before(async () => {
  net = await startChain(8578);
  const owner = await freshAccount(net);
  auditor = C.auditorKeyPair();
  deployment = await deployCella(net, owner, auditor.pubKey);
  aliceAcct = await freshAccount(net);
  bobAcct = await freshAccount(net);
  alice = await clientFor(aliceAcct);
  bob = await clientFor(bobAcct);
});
after(async () => {
  net?.proc.kill();
  await globalThis.curve_bn128?.terminate?.();
});

test("keys: the same wallet always gives the same keys, another wallet gives others", async () => {
  const again = await deriveKeys((message) => aliceAcct.signMessage({ message }), deployment.chainId);
  assert.equal(again.privKey, alice.keys.privKey);
  assert.equal(again.encKey, alice.keys.encKey);
  assert.notEqual(bob.keys.privKey, alice.keys.privKey);
  const otherChain = await deriveKeys((message) => aliceAcct.signMessage({ message }), 46630);
  assert.notEqual(otherChain.privKey, alice.keys.privKey);
  let n = 0;
  await assert.rejects(deriveKeys(async () => "0x" + String(n++).padStart(130, "0"), 4663, { verify: true }), /differently each time/);
});

test("notes: only the recipient can open one; a changed note opens for nobody", async () => {
  const note = C.newNote(E("0.5"), bob.keys.pubKey);
  const sealed = await encryptNote(note, bob.keys.encKey);
  assert.equal((sealed.length - 2) / 2, NOTE_BYTES);
  assert.deepEqual(await decryptNote(sealed, bob.keys.encPriv), { amount: note.amount, blinding: note.blinding });
  assert.equal(await decryptNote(sealed, alice.keys.encPriv), null);
  const flipped = sealed.slice(0, -2) + (sealed.endsWith("00") ? "01" : "00");
  assert.equal(await decryptNote(flipped, bob.keys.encPriv), null);
  assert.equal(await decryptNote("0x1234", bob.keys.encPriv), null);
});

test("register: both wallets publish their keys; an unknown address has none", async () => {
  assert.equal(await alice.lookup(aliceAcct.address), null);
  await alice.register();
  await bob.register();
  assert.deepEqual(await bob.lookup(aliceAcct.address), { pubKey: alice.keys.pubKey, encKey: alice.keys.encKey });
  assert.equal(await alice.register(), null);
});

test("deposit, then a private payment by address", async () => {
  await alice.deposit(E("0.1"));
  assert.equal(alice.balance, E("0.1"));
  await alice.transfer(bobAcct.address, E("0.03"));
  assert.equal(alice.balance, E("0.07"));
  assert.equal(await bob.sync(), E("0.03"));
});

test("recovery from nothing: a new client with only the wallet finds the balance", async () => {
  const reborn = await clientFor(bobAcct);
  assert.equal(reborn.notes.length, 0);
  assert.equal(await reborn.sync(), E("0.03"));
  bob = reborn;
});

test("withdraw to any address", async () => {
  const to = getAddress(toHex(C.randomField() % (1n << 160n), { size: 20 }));
  await bob.withdraw(to, E("0.01"));
  assert.equal(await net.pub.getBalance({ address: to }), E("0.01"));
  assert.equal(bob.balance, E("0.02"));
});

test("a payment larger than any two notes merges notes first", async () => {
  await alice.deposit(E("0.05"));
  await alice.deposit(E("0.02"));
  assert.equal(alice.unspent.length, 3);
  const steps = [];
  alice.onStatus = (s) => steps.push(s);
  await alice.transfer(bobAcct.address, E("0.135"));
  assert.ok(steps.includes("merging"));
  assert.equal(alice.balance, E("0.005"));
  assert.equal(await bob.sync(), E("0.155"));
});

test("refused before any transaction: overspending, unregistered recipient, zero amount", async () => {
  await assert.rejects(alice.transfer(bobAcct.address, E("1")), /too small/);
  await assert.rejects(alice.withdraw(aliceAcct.address, E("1")), /too small/);
  const nobody = getAddress(toHex(C.randomField() % (1n << 160n), { size: 20 }));
  await assert.rejects(alice.transfer(nobody, E("0.001")), /has not opened/);
  await assert.rejects(alice.transfer(bobAcct.address, 0n), /above zero/);
});

test("an outsider syncing the same pool sees no balance and opens no note", async () => {
  const eve = await clientFor(await freshAccount(net));
  assert.equal(await eve.sync(), 0n);
  assert.equal(eve.notes.length, 0);
  assert.equal(eve.tree.root, alice.tree.root);
  assert.ok(eve.tree.size >= 12);
});

test("the pool holds exactly what the two balances add up to", async () => {
  await alice.sync(); await bob.sync();
  assert.equal(await alice.readPool("totalHeld"), alice.balance + bob.balance);
});

test("a withdrawal its recipient refuses is held for it, and the client can tell", async () => {
  const REFUSER = artifact("Helpers", "Refuser");
  const { address: refuser } = await deployContract(net, aliceAcct, REFUSER);
  assert.equal(await alice.owed(refuser), 0n);
  await alice.deposit(E("0.01"));
  const before_ = alice.balance;

  const receipt = await alice.withdraw(refuser, E("0.004"));
  assert.deepEqual(CellaClient.heldIn(receipt).map((h) => [getAddress(h.to), h.amount]), [[getAddress(refuser), E("0.004")]]);
  assert.equal(await alice.owed(refuser), E("0.004"));
  assert.equal(alice.balance, before_ - E("0.004"));
  assert.equal(await net.pub.getBalance({ address: refuser }), 0n);

  // An ordinary withdrawal holds nothing, and a wallet that is owed nothing cannot claim.
  const plain = await alice.withdraw(aliceAcct.address, E("0.001"));
  assert.deepEqual(CellaClient.heldIn(plain), []);
  assert.equal(await alice.owed(), 0n);
  await assert.rejects(alice.claim(), /NothingOwed/);

  // Once it accepts ETH, the recipient collects exactly what was held.
  const call = async (fn, args) => {
    const hash = await net.wallet.writeContract({ address: refuser, abi: REFUSER.abi, functionName: fn, args, account: aliceAcct, gas: 500_000n });
    assert.equal((await net.pub.waitForTransactionReceipt({ hash })).status, "success");
  };
  await call("setAccepting", [true]);
  await call("collect", [deployment.pool]);
  assert.equal(await net.pub.getBalance({ address: refuser }), E("0.004"));
  assert.equal(await alice.owed(refuser), 0n);
});

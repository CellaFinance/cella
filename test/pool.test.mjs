// Contract tests with real Groth16 proofs against a local copy of Robinhood Chain
// (anvil fork of mainnet, chain id 4663). Nothing here touches the real chain.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient, createWalletClient, createTestClient, http, encodeAbiParameters, keccak256,
  encodeFunctionData, parseEther, parseEventLogs, zeroAddress, getAddress, toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { poseidonContract } from "circomlibjs";
import * as snarkjs from "snarkjs";
import * as C from "../src/cella.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const WASM = join(root, "build/transact_js/transact.wasm");
const ZKEY = join(root, "build/bench/g16.zkey");
const FORK_RPC = "https://rpc.mainnet.chain.robinhood.com";
const PORT = 8577;
const URL = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = 4663;
const chain = { id: CHAIN_ID, name: "robinhood-fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [URL] } } };

const artifact = (file, name) => {
  const a = JSON.parse(readFileSync(join(root, `build/forge/${file}.sol/${name}.json`), "utf8"));
  return { abi: a.abi, bytecode: a.bytecode.object };
};
const POOL = artifact("CellaPool", "CellaPool");
const VERIFIER = artifact("Groth16Verifier", "Groth16Verifier");
const ACCEPT_ALL = artifact("Helpers", "AcceptAllVerifier");
const REENTER = artifact("Helpers", "Reenter");
const FORCE = artifact("Helpers", "ForceSend");

const E = (s) => parseEther(s);
const MAX_DEPOSIT = E("0.1"), POOL_CAP = E("5");
const gas = {};
let anvil, forked, pub, wallet, testc;
const signers = {};
const signer = (address) => signers[address] ?? address;
let owner, aliceAddr, bobAddr, relayer, stranger;
let hasher, verifier, auditor, alice, bob, main;

async function rpcUp() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(URL, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });
      if ((await r.json()).result) return true;
    } catch { /* not up yet */ }
    if (anvil.exitCode !== null) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
async function startAnvil() {
  anvil = spawn("anvil", ["--port", String(PORT), "--fork-url", FORK_RPC, "--silent"], { stdio: "ignore" });
  forked = await rpcUp();
  if (!forked) {
    anvil.kill();
    anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", String(CHAIN_ID), "--silent"], { stdio: "ignore" });
    assert.ok(await rpcUp(), "anvil did not start");
  }
}

async function deploy({ abi, bytecode }, args = [], value) {
  const hash = await wallet.deployContract({ abi, bytecode, args, account: signer(owner), value, gas: 12_000_000n });
  const rc = await pub.waitForTransactionReceipt({ hash });
  assert.equal(rc.status, "success");
  return rc.contractAddress;
}
async function deployPool({ levels = 24, history = 100, verifierAddr = verifier, auditorKey = auditor.pubKey } = {}) {
  const address = await deploy(POOL, [verifierAddr, hasher, levels, history, auditorKey, MAX_DEPOSIT, POOL_CAP, owner]);
  return { address, tree: new C.Tree(levels), auditorKey };
}
const read = (ctx, functionName, args = []) => pub.readContract({ address: ctx.address, abi: POOL.abi, functionName, args });
// On a fork of this chain the block gas limit is enormous, so a failed gas estimate
// is reported as "insufficient funds". Every call is therefore simulated first with
// a fixed gas limit, which gives the contract's own error, and then sent.
const GAS = 6_000_000n;
async function call(address, abi, functionName, args, account, value = 0n) {
  await pub.simulateContract({ address, abi, functionName, args, account, value, gas: GAS });
  return wallet.writeContract({ address, abi, functionName, args, account: signer(account), value, gas: GAS });
}
async function ownerCall(ctx, functionName, args = [], account = owner) {
  const hash = await call(ctx.address, POOL.abi, functionName, args, account);
  const rc = await pub.waitForTransactionReceipt({ hash });
  assert.equal(rc.status, "success");
}

function hashExt(ext, poolAddress, chainId = CHAIN_ID) {
  const enc = encodeAbiParameters(
    [{ type: "address" }, { type: "int256" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
    [ext.recipient, ext.extAmount, ext.relayer, ext.fee, keccak256(ext.note0), keccak256(ext.note1), BigInt(chainId), poolAddress]);
  return BigInt(keccak256(enc)) % C.P;
}

/** Builds a transaction and its proof. Does not send it. */
async function makeTx(ctx, { privKey, inputs = [], outputs = [], ext = {}, auditorKey = ctx.auditorKey, chainId = CHAIN_ID, boundTo = ctx.address }) {
  const e = { recipient: zeroAddress, extAmount: 0n, relayer: zeroAddress, fee: 0n, note0: "0x", note1: "0x", ...ext };
  const built = C.buildTransaction({ tree: ctx.tree, privKey, inputs, outputs, publicAmount: e.extAmount - e.fee,
    extDataHash: hashExt(e, boundTo, chainId), auditorPubKey: auditorKey });
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(built.signals, WASM, ZKEY);
  const [a, b, c] = JSON.parse("[" + (await snarkjs.groth16.exportSolidityCallData(proof, publicSignals)) + "]");
  const big = (x) => (Array.isArray(x) ? x.map(big) : BigInt(x));
  const s = built.signals;
  return {
    ext: e, built,
    proof: { a: big(a), b: big(b), c: big(c), root: s.root, nullifiers: s.inputNullifier, commitments: s.outputCommitment,
      auditEphemeral: s.auditEphemeral, auditCipher: s.auditCipher },
  };
}
const write = (ctx, tx, from, value = 0n) => call(ctx.address, POOL.abi, "transact", [tx.proof, tx.ext], from, value);

/** Sends a transaction that must succeed; mirrors the new notes into the local tree. */
async function send(ctx, tx, from, value = 0n, label) {
  const rc = await pub.waitForTransactionReceipt({ hash: await write(ctx, tx, from, value) });
  assert.equal(rc.status, "success");
  if (label) gas[label] = rc.gasUsed;
  const index = tx.proof.commitments.map((c) => ctx.tree.insert(c));
  assert.equal(await read(ctx, "lastRoot"), ctx.tree.root, "contract tree and local tree disagree");
  return { rc, notes: tx.built.outputs.map((note, i) => ({ note, index: index[i] })) };
}
/** The call must revert, and with this error when one is named. */
async function refused(promise, errorName) {
  let err;
  try { await promise; } catch (e) { err = e; }
  assert.ok(err, `expected a revert${errorName ? " with " + errorName : ""}, but the call succeeded`);
  if (errorName) assert.match(String(err.message), new RegExp(errorName), `expected ${errorName}`);
}
async function deposit(ctx, who, amount, label) {
  const tx = await makeTx(ctx, { privKey: who.sk, outputs: [C.newNote(amount, who.pk)], ext: { extAmount: amount } });
  return (await send(ctx, tx, who.addr, amount, label)).notes[0];
}
const freshAddress = () => getAddress(toHex(C.randomField() % (1n << 160n), { size: 20 }));
const tamper = (tx, ext) => ({ ...tx, ext: { ...tx.ext, ...ext } });

before(async () => {
  for (const f of [WASM, ZKEY]) assert.ok(existsSync(f), `missing ${f}`);
  await C.init();
  await startAnvil();
  pub = createPublicClient({ chain, transport: http(URL) });
  wallet = createWalletClient({ chain, transport: http(URL) });
  testc = createTestClient({ chain, mode: "anvil", transport: http(URL) });
  // Fresh random keys. The well-known local test addresses carry sweeper code on the
  // real chain (EIP-7702 delegations), and a fork copies that: ETH sent to them leaves again.
  const fresh = [];
  for (let i = 0; i < 5; i++) {
    const a = privateKeyToAccount(generatePrivateKey());
    signers[a.address] = a;
    assert.equal(await pub.getCode({ address: a.address }), undefined);
    await testc.setBalance({ address: a.address, value: E("10000") });
    fresh.push(a.address);
  }
  [owner, aliceAddr, bobAddr, relayer, stranger] = fresh;

  hasher = await deploy({ abi: poseidonContract.generateABI(2), bytecode: poseidonContract.createCode(2) });
  verifier = await deploy(VERIFIER);
  auditor = C.auditorKeyPair();
  alice = { sk: C.randomField(), addr: aliceAddr }; alice.pk = C.pubKeyOf(alice.sk);
  bob = { sk: C.randomField(), addr: bobAddr }; bob.pk = C.pubKeyOf(bob.sk);
  main = await deployPool();
});
after(async () => {
  anvil?.kill();
  console.log("\nchain copy:", forked ? "fork of Robinhood Chain mainnet" : "plain local chain with id 4663 (fork unavailable)");
  console.log("gas used:", Object.fromEntries(Object.entries(gas).map(([k, v]) => [k, Number(v)])));
  await globalThis.curve_bn128?.terminate?.();
});

let aliceNote, bobNote, aliceChange, spare;

test("a fresh pool has the same empty-tree root as the client", async () => {
  assert.equal(await pub.getChainId(), CHAIN_ID);
  assert.equal(await read(main, "lastRoot"), main.tree.root);
  assert.deepEqual([...(await read(main, "auditorKey"))], auditor.pubKey);
});

test("deposit: 0.1 ETH enters and is counted", async () => {
  aliceNote = await deposit(main, alice, E("0.1"), "deposit");
  assert.equal(await pub.getBalance({ address: main.address }), E("0.1"));
  assert.equal(await read(main, "totalHeld"), E("0.1"));
});

test("transfer through a relayer: Alice pays Bob, the relayer gets its fee, the auditor reads it", async () => {
  const fee = E("0.001");
  const outs = [C.newNote(E("0.07"), bob.pk), C.newNote(E("0.029"), alice.pk)];
  const tx = await makeTx(main, { privKey: alice.sk, inputs: [aliceNote], outputs: outs, ext: { relayer, fee, note0: "0x1111", note1: "0x2222" } });
  const before_ = await pub.getBalance({ address: relayer });
  const { rc, notes } = await send(main, tx, relayer, 0n, "transfer");
  [bobNote, aliceChange] = notes;

  const spent = rc.gasUsed * rc.effectiveGasPrice;
  assert.equal(await pub.getBalance({ address: relayer }), before_ + fee - spent);
  assert.equal(await read(main, "totalHeld"), E("0.099"));

  const [rec] = parseEventLogs({ abi: POOL.abi, logs: rc.logs, eventName: "AuditRecord" });
  const seen = C.auditDecrypt([...rec.args.cipher], [...rec.args.ephemeral], auditor.secret, rec.args.nullifier0);
  assert.equal(seen.sender, alice.pk);
  assert.deepEqual(seen.outputs, [{ amount: E("0.07"), pubKey: bob.pk }, { amount: E("0.029"), pubKey: alice.pk }]);
  const blind = C.auditDecrypt([...rec.args.cipher], [...rec.args.ephemeral], C.auditorKeyPair().secret, rec.args.nullifier0);
  assert.notEqual(blind.sender, alice.pk);

  const notesOut = parseEventLogs({ abi: POOL.abi, logs: rc.logs, eventName: "NewCommitment" });
  assert.deepEqual(notesOut.map((l) => l.args.note), ["0x1111", "0x2222"]);
});

let bobWithdraw;
test("withdraw: Bob takes 0.05 ETH out to a new address", async () => {
  const to = freshAddress();
  bobWithdraw = await makeTx(main, { privKey: bob.sk, inputs: [bobNote], outputs: [C.newNote(E("0.02"), bob.pk)], ext: { recipient: to, extAmount: -E("0.05") } });
  const { notes } = await send(main, bobWithdraw, bobAddr, 0n, "withdraw");
  assert.equal(await pub.getBalance({ address: to }), E("0.05"));
  assert.equal(await read(main, "totalHeld"), E("0.049"));
  bobNote = notes[0];
});

test("refused: sending the same withdrawal again", async () => {
  await refused(write(main, bobWithdraw, bobAddr), "NullifierUsed");
});

test("refused: a new proof that spends an already spent note", async () => {
  const old = { note: bobWithdraw.built.signals && { amount: E("0.07"), pubKey: bob.pk, blinding: bobWithdraw.built.signals.inBlinding[0] }, index: Number(bobWithdraw.built.signals.inPathIndex[0]) };
  const tx = await makeTx(main, { privKey: bob.sk, inputs: [old], outputs: [], ext: { recipient: bobAddr, extAmount: -E("0.07") } });
  await refused(write(main, tx, bobAddr), "NullifierUsed");
});

test("refused: a made-up proof, an unknown root, a nullifier outside the field", async () => {
  const tx = await makeTx(main, { privKey: alice.sk, inputs: [aliceChange], outputs: [C.newNote(E("0.029"), alice.pk)] });
  await refused(write(main, { ...tx, proof: { ...tx.proof, a: [1n, 2n] } }, aliceAddr), "InvalidProof");
  await refused(write(main, { ...tx, proof: { ...tx.proof, root: C.randomField() } }, aliceAddr), "UnknownRoot");
  await refused(write(main, { ...tx, proof: { ...tx.proof, nullifiers: [tx.proof.nullifiers[0] + C.P, tx.proof.nullifiers[1]] } }, aliceAddr), "OutOfField");
  await refused(write(main, { ...tx, proof: { ...tx.proof, commitments: [tx.proof.commitments[1], tx.proof.commitments[0]] } }, aliceAddr), "InvalidProof");
  [aliceChange] = (await send(main, tx, aliceAddr)).notes;
});

test("refused: a relayer changing the recipient, amount, fee, payee or notes", async () => {
  const to = freshAddress();
  const tx = await makeTx(main, { privKey: alice.sk, inputs: [aliceChange], outputs: [C.newNote(E("0.018"), alice.pk)],
    ext: { recipient: to, extAmount: -E("0.01"), relayer, fee: E("0.001"), note0: "0xaa", note1: "0xbb" } });
  await refused(write(main, tamper(tx, { recipient: stranger }), relayer), "InvalidProof");
  await refused(write(main, tamper(tx, { extAmount: -E("0.02") }), relayer), "InvalidProof");
  await refused(write(main, tamper(tx, { fee: E("0.002") }), relayer), "InvalidProof");
  await refused(write(main, tamper(tx, { relayer: stranger }), stranger), "InvalidProof");
  await refused(write(main, tamper(tx, { note0: "0xab" }), relayer), "InvalidProof");
  await refused(write(main, tamper(tx, { note1: "0x" }), relayer), "InvalidProof");
  [aliceChange] = (await send(main, tx, relayer)).notes;
  assert.equal(await pub.getBalance({ address: to }), E("0.01"));
});

test("refused: wrong ETH value, a deposit above the limit, a deposit above the pool cap", async () => {
  const tx = await makeTx(main, { privKey: alice.sk, outputs: [C.newNote(E("0.05"), alice.pk)], ext: { extAmount: E("0.05") } });
  await refused(write(main, tx, aliceAddr, E("0.04")), "WrongValue");
  await refused(write(main, tx, aliceAddr, 0n), "WrongValue");

  const xfer = await makeTx(main, { privKey: alice.sk, inputs: [aliceChange], outputs: [C.newNote(E("0.018"), alice.pk)] });
  await refused(write(main, xfer, aliceAddr, 1n), "WrongValue");

  const big = await makeTx(main, { privKey: alice.sk, outputs: [C.newNote(E("0.2"), alice.pk)], ext: { extAmount: E("0.2") } });
  await refused(write(main, big, aliceAddr, E("0.2")), "DepositTooLarge");

  const held = await read(main, "totalHeld");
  await ownerCall(main, "setLimits", [MAX_DEPOSIT, held + E("0.04")]);
  await refused(write(main, tx, aliceAddr, E("0.05")), "PoolCapReached");
  await ownerCall(main, "setLimits", [MAX_DEPOSIT, POOL_CAP]);
  [spare] = (await send(main, tx, aliceAddr, E("0.05"))).notes;
});

test("paused deposits stop deposits only: transfers and withdrawals keep working", async () => {
  await ownerCall(main, "setDepositsPaused", [true]);
  const dep = await makeTx(main, { privKey: bob.sk, outputs: [C.newNote(E("0.01"), bob.pk)], ext: { extAmount: E("0.01") } });
  await refused(write(main, dep, bobAddr, E("0.01")), "DepositsArePaused");

  const xfer = await makeTx(main, { privKey: bob.sk, inputs: [bobNote], outputs: [C.newNote(E("0.02"), bob.pk)] });
  [bobNote] = (await send(main, xfer, bobAddr)).notes;
  const to = freshAddress();
  const out = await makeTx(main, { privKey: bob.sk, inputs: [bobNote], outputs: [C.newNote(E("0.015"), bob.pk)], ext: { recipient: to, extAmount: -E("0.005") } });
  [bobNote] = (await send(main, out, bobAddr)).notes;
  assert.equal(await pub.getBalance({ address: to }), E("0.005"));

  await ownerCall(main, "setDepositsPaused", [false]);
  await send(main, dep, bobAddr, E("0.01"));
});

test("refused: owner functions called by anyone else; ownership moves in two steps", async () => {
  const w = (fn, args) => call(main.address, POOL.abi, fn, args, stranger);
  await refused(w("setDepositsPaused", [true]), "NotOwner");
  await refused(w("setLimits", [E("100"), E("100")]), "NotOwner");
  await refused(w("proposeAuditor", auditor.pubKey), "NotOwner");
  await refused(w("transferOwnership", [stranger]), "NotOwner");
  await refused(w("acceptOwnership", []), "NotOwner");

  await ownerCall(main, "transferOwnership", [relayer]);
  assert.equal(await read(main, "owner"), owner);
  await ownerCall(main, "acceptOwnership", [], relayer);
  assert.equal(await read(main, "owner"), relayer);
  await ownerCall(main, "transferOwnership", [owner], relayer);
  await ownerCall(main, "acceptOwnership", [], owner);
});

test("plain ETH is refused, and forced ETH changes nothing", async () => {
  await refused(pub.call({ to: main.address, value: 1n, account: stranger, gas: GAS }));
  const held = await read(main, "totalHeld");
  const bal = await pub.getBalance({ address: main.address });
  assert.equal(bal, held);
  await deploy(FORCE, [main.address], E("1"));
  assert.equal(await pub.getBalance({ address: main.address }), bal + E("1"));
  assert.equal(await read(main, "totalHeld"), held);
});

test("refused: a proof made for another pool or another chain", async () => {
  const a = await deployPool(), b = await deployPool();
  const tx = await makeTx(a, { privKey: alice.sk, outputs: [C.newNote(E("0.01"), alice.pk)], ext: { extAmount: E("0.01") } });
  await refused(write(b, tx, aliceAddr, E("0.01")), "InvalidProof");
  const other = await makeTx(a, { privKey: alice.sk, outputs: [C.newNote(E("0.01"), alice.pk)], ext: { extAmount: E("0.01") }, chainId: 46630 });
  await refused(write(a, other, aliceAddr, E("0.01")), "InvalidProof");
  await send(a, tx, aliceAddr, E("0.01"));
});

test("re-entering during a withdrawal is refused, and pays once", async () => {
  const thief = await deploy(REENTER);
  const first = await makeTx(main, { privKey: alice.sk, inputs: [aliceChange], outputs: [], ext: { recipient: thief, extAmount: -E("0.018") } });
  const second = await makeTx(main, { privKey: alice.sk, inputs: [spare], outputs: [], ext: { recipient: thief, extAmount: -E("0.05") } });
  const data = encodeFunctionData({ abi: POOL.abi, functionName: "transact", args: [second.proof, second.ext] });
  await pub.waitForTransactionReceipt({ hash: await call(thief, REENTER.abi, "arm", [main.address, data], stranger) });

  await send(main, first, aliceAddr);
  const r = (fn) => pub.readContract({ address: thief, abi: REENTER.abi, functionName: fn });
  assert.equal(await r("tried"), true);
  assert.equal(await r("innerCallSucceeded"), false);
  assert.equal(await pub.getBalance({ address: thief }), E("0.018"));

  await send(main, second, aliceAddr);
  assert.equal(await pub.getBalance({ address: thief }), E("0.068"));
});

test("auditor key: bad points refused, 7-day delay enforced, old key stops working after the change", async () => {
  const next = C.auditorKeyPair();
  await refused(ownerCall(main, "proposeAuditor", [1n, 2n]), "BadAuditorKey");
  await refused(ownerCall(main, "proposeAuditor", [0n, 1n]), "BadAuditorKey");
  await refused(ownerCall(main, "activateAuditor", [], stranger), "NothingPending");

  const sealedToOther = await makeTx(main, { privKey: bob.sk, inputs: [bobNote], outputs: [C.newNote(E("0.015"), bob.pk)], auditorKey: next.pubKey });
  await refused(write(main, sealedToOther, bobAddr), "InvalidProof");

  await ownerCall(main, "proposeAuditor", next.pubKey);
  await refused(ownerCall(main, "activateAuditor", [], stranger), "TooEarly");
  await testc.increaseTime({ seconds: 7 * 24 * 3600 - 60 });
  await testc.mine({ blocks: 1 });
  await refused(ownerCall(main, "activateAuditor", [], stranger), "TooEarly");
  await testc.increaseTime({ seconds: 120 });
  await testc.mine({ blocks: 1 });

  const sealedToOld = await makeTx(main, { privKey: bob.sk, inputs: [bobNote], outputs: [C.newNote(E("0.015"), bob.pk)] });
  await ownerCall(main, "activateAuditor", [], stranger);
  assert.deepEqual([...(await read(main, "auditorKey"))], next.pubKey);
  await refused(write(main, sealedToOld, bobAddr), "InvalidProof");

  main.auditorKey = next.pubKey;
  const { rc, notes } = await send(main, sealedToOther, bobAddr);
  bobNote = notes[0];
  const [rec] = parseEventLogs({ abi: POOL.abi, logs: rc.logs, eventName: "AuditRecord" });
  const args = [[...rec.args.cipher], [...rec.args.ephemeral]];
  assert.equal(C.auditDecrypt(...args, next.secret, rec.args.nullifier0).sender, bob.pk);
  assert.notEqual(C.auditDecrypt(...args, auditor.secret, rec.args.nullifier0).sender, bob.pk);
});

test("every ETH in the pool is owed to a note: balance = deposits - withdrawals - fees", async () => {
  const held = await read(main, "totalHeld");
  // Unspent at this point: Bob 0.015 and 0.01 (the deposit made after the pause).
  assert.equal(held, E("0.025"));
  assert.equal(await pub.getBalance({ address: main.address }), held + E("1"));
});

test("root history: a proof on the previous root is accepted, one on a forgotten root is not", async () => {
  const p = await deployPool({ history: 2 });
  const n1 = await deposit(p, alice, E("0.01"));
  const stale = await makeTx(p, { privKey: alice.sk, inputs: [n1], outputs: [C.newNote(E("0.01"), bob.pk)] });
  const n2 = await deposit(p, alice, E("0.01"));
  const oneOld = await makeTx(p, { privKey: alice.sk, inputs: [n2], outputs: [C.newNote(E("0.01"), bob.pk)] });
  await deposit(p, alice, E("0.01"));
  await refused(write(p, stale, aliceAddr), "UnknownRoot");
  await send(p, oneOld, aliceAddr);
});

test("limits checked before any proof: full tree, repeated nullifier, amounts out of range, no recipient", async () => {
  const yes = await deploy(ACCEPT_ALL);
  const blank = () => ({
    proof: { a: [0n, 0n], b: [[0n, 0n], [0n, 0n]], c: [0n, 0n], root: 0n, nullifiers: [C.randomField(), C.randomField()],
      commitments: [C.randomField(), C.randomField()], auditEphemeral: [0n, 0n], auditCipher: [0n, 0n, 0n, 0n, 0n] },
    ext: { recipient: zeroAddress, extAmount: 0n, relayer: zeroAddress, fee: 0n, note0: "0x", note1: "0x" },
  });
  const withRoot = async (ctx, t = blank()) => { t.proof.root = await read(ctx, "lastRoot"); return t; };

  const tiny = await deployPool({ levels: 1, verifierAddr: yes });
  await pub.waitForTransactionReceipt({ hash: await write(tiny, await withRoot(tiny), stranger) });
  assert.equal(await read(tiny, "nextIndex"), 2);
  await refused(write(tiny, await withRoot(tiny), stranger), "TreeFull");

  const p = await deployPool({ levels: 4, verifierAddr: yes });
  const twice = await withRoot(p); twice.proof.nullifiers[1] = twice.proof.nullifiers[0];
  await refused(write(p, twice, stranger), "NullifierUsed");
  const fee = await withRoot(p); fee.ext.fee = 1n << 96n; fee.ext.relayer = relayer;
  await refused(write(p, fee, stranger), "AmountOutOfRange");
  const inn = await withRoot(p); inn.ext.extAmount = 1n << 96n;
  await testc.setBalance({ address: stranger, value: 1n << 100n });
  await refused(write(p, inn, stranger, 1n << 96n), "AmountOutOfRange");
  const out = await withRoot(p); out.ext.extAmount = -(1n << 96n); out.ext.recipient = stranger;
  await refused(write(p, out, stranger), "AmountOutOfRange");
  const nowhere = await withRoot(p); nowhere.ext.extAmount = -1n;
  await refused(write(p, nowhere, stranger), "NoRecipient");
  const zeroRoot = blank();
  await refused(write(p, zeroRoot, stranger), "UnknownRoot");
  // Even with a verifier that accepts anything, more than was deposited cannot leave.
  const drain = await withRoot(p); drain.ext.extAmount = -1n; drain.ext.recipient = stranger;
  await refused(write(p, drain, stranger));
});

// Circuit tests: every case builds real circuit inputs and asks whether a
// witness exists that satisfies all constraints. "Refused" means it does not.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";
import { WitnessCalculatorBuilder } from "circom_runtime";
import * as C from "../src/cella.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const WASM = join(root, "build/transact_js/transact.wasm");
const R1CS = join(root, "build/transact.r1cs");
const tmp = mkdtempSync(join(tmpdir(), "cella-"));
let n = 0;

/** true when the circuit accepts these signals. */
async function accepts(signals) {
  // In memory first: a refused witness must not leave a half-written file behind.
  try { await calculator.calculateWitness(signals, true); } catch { return false; }
  const wtns = join(tmp, `w${n++}.wtns`);
  await snarkjs.wtns.calculate(signals, WASM, wtns);
  return snarkjs.wtns.check(R1CS, wtns, { info() {}, warn() {}, error() {}, debug() {} });
}
const ETH = 10n ** 18n;
let auditor, alice, bob, tree, base, calculator;

before(async () => {
  assert.ok(existsSync(WASM), "run `npm run build:circuit` first");
  await C.init();
  calculator = await WitnessCalculatorBuilder(readFileSync(WASM), { logError() {} });
  auditor = C.auditorKeyPair();
  alice = { sk: C.randomField() }; alice.pk = C.pubKeyOf(alice.sk);
  bob = { sk: C.randomField() }; bob.pk = C.pubKeyOf(bob.sk);
  tree = new C.Tree();
  base = { tree, auditorPubKey: auditor.pubKey };
});
after(() => { globalThis.curve_bn128?.terminate?.(); });

/** Runs a transaction that must be accepted and adds its notes to the tree. */
async function commit(args) {
  const tx = C.buildTransaction({ ...base, ...args });
  assert.equal(await accepts(tx.signals), true);
  const index = tx.signals.outputCommitment.map((c) => tree.insert(c));
  return tx.outputs.map((note, i) => ({ note, index: index[i] }));
}
const clone = (s) => structuredClone(s);

let aliceNote, bobNote, aliceChange;

test("deposit: 1 ETH enters as a note", async () => {
  [aliceNote] = await commit({ privKey: alice.sk, outputs: [C.newNote(ETH, alice.pk)], publicAmount: ETH });
});

test("transfer: Alice pays Bob 0.7 ETH and keeps 0.3 ETH", async () => {
  const outs = [C.newNote(7n * ETH / 10n, bob.pk), C.newNote(3n * ETH / 10n, alice.pk)];
  const tx = C.buildTransaction({ ...base, privKey: alice.sk, inputs: [aliceNote], outputs: outs });
  assert.equal(await accepts(tx.signals), true);

  const s = tx.signals;
  const seen = C.auditDecrypt(s.auditCipher, s.auditEphemeral, auditor.secret, s.inputNullifier[0]);
  assert.equal(seen.sender, alice.pk);
  assert.deepEqual(seen.outputs, [{ amount: 7n * ETH / 10n, pubKey: bob.pk }, { amount: 3n * ETH / 10n, pubKey: alice.pk }]);

  const stranger = C.auditorKeyPair();
  const blind = C.auditDecrypt(s.auditCipher, s.auditEphemeral, stranger.secret, s.inputNullifier[0]);
  assert.notEqual(blind.sender, alice.pk);
  assert.notEqual(blind.outputs[0].amount, 7n * ETH / 10n);

  const idx = s.outputCommitment.map((c) => tree.insert(c));
  bobNote = { note: outs[0], index: idx[0] };
  aliceChange = { note: outs[1], index: idx[1] };
});

test("withdraw: Bob takes 0.5 ETH out, pays a 0.01 ETH relayer fee, keeps the rest", async () => {
  const fee = ETH / 100n, out = ETH / 2n;
  const rest = bobNote.note.amount - out - fee;
  const [left] = await commit({ privKey: bob.sk, inputs: [bobNote], outputs: [C.newNote(rest, bob.pk)], publicAmount: -(out + fee) });
  bobNote = left;
});

test("merge: two notes of one owner become one", async () => {
  const [second] = await commit({ privKey: alice.sk, outputs: [C.newNote(2n * ETH, alice.pk)], publicAmount: 2n * ETH });
  const total = aliceChange.note.amount + second.note.amount;
  [aliceChange] = await commit({ privKey: alice.sk, inputs: [aliceChange, second], outputs: [C.newNote(total, alice.pk)] });
});

// ---- attacks ----
const spend = (extra = {}) => C.buildTransaction({ ...base, privKey: alice.sk, inputs: [aliceChange],
  outputs: [C.newNote(aliceChange.note.amount, bob.pk)], ...extra });

test("the base spend used by the attack tests is itself valid", async () => {
  assert.equal(await accepts(spend().signals), true);
});

test("refused: creating money (outputs worth more than inputs)", async () => {
  const tx = spend({ outputs: [C.newNote(aliceChange.note.amount + 1n, bob.pk)] });
  assert.equal(await accepts(tx.signals), false);
});

test("refused: creating money through field wrap-around", async () => {
  const huge = 1000n * ETH;
  const tx = spend({ outputs: [C.newNote(aliceChange.note.amount + huge, bob.pk), C.newNote(C.P - huge, alice.pk)] });
  assert.equal(await accepts(tx.signals), false);
});

test("refused: an output amount at the 2^96 limit", async () => {
  const tx = C.buildTransaction({ ...base, privKey: alice.sk, outputs: [C.newNote(C.AMOUNT_LIMIT, alice.pk)], publicAmount: C.AMOUNT_LIMIT });
  assert.equal(await accepts(tx.signals), false);
  const ok = C.buildTransaction({ ...base, privKey: alice.sk, outputs: [C.newNote(C.AMOUNT_LIMIT - 1n, alice.pk)], publicAmount: C.AMOUNT_LIMIT - 1n });
  assert.equal(await accepts(ok.signals), true);
});

test("refused: spending someone else's note", async () => {
  const tx = C.buildTransaction({ ...base, privKey: bob.sk, inputs: [aliceChange], outputs: [C.newNote(aliceChange.note.amount, bob.pk)] });
  assert.equal(await accepts(tx.signals), false);
  const relabelled = { note: { ...aliceChange.note, pubKey: bob.pk }, index: aliceChange.index };
  const tx2 = C.buildTransaction({ ...base, privKey: bob.sk, inputs: [relabelled], outputs: [C.newNote(aliceChange.note.amount, bob.pk)] });
  assert.equal(await accepts(tx2.signals), false);
});

test("refused: mixing notes of two owners under one key", async () => {
  const tx = C.buildTransaction({ ...base, privKey: alice.sk, inputs: [aliceChange, bobNote],
    outputs: [C.newNote(aliceChange.note.amount + bobNote.note.amount, alice.pk)] });
  assert.equal(await accepts(tx.signals), false);
});

test("refused: a note that was never deposited", async () => {
  const fake = { note: C.newNote(5n * ETH, alice.pk), index: aliceChange.index };
  const tx = C.buildTransaction({ ...base, privKey: alice.sk, inputs: [fake], outputs: [C.newNote(5n * ETH, alice.pk)] });
  assert.equal(await accepts(tx.signals), false);
  const asDummy = C.buildTransaction({ ...base, privKey: alice.sk, inputs: [{ ...fake, dummy: true }], outputs: [C.newNote(5n * ETH, alice.pk)] });
  assert.equal(await accepts(asDummy.signals), false);
});

test("refused: a real note with a larger amount written on it", async () => {
  const inflated = { note: { ...aliceChange.note, amount: aliceChange.note.amount * 2n }, index: aliceChange.index };
  const tx = C.buildTransaction({ ...base, privKey: alice.sk, inputs: [inflated], outputs: [C.newNote(inflated.note.amount, alice.pk)] });
  assert.equal(await accepts(tx.signals), false);
});

test("refused: the same note twice in one transaction", async () => {
  const tx = C.buildTransaction({ ...base, privKey: alice.sk, inputs: [aliceChange, aliceChange],
    outputs: [C.newNote(aliceChange.note.amount * 2n, alice.pk)] });
  assert.equal(await accepts(tx.signals), false);
});

test("refused: a root the tree never had", async () => {
  const s = clone(spend().signals); s.root = C.randomField();
  assert.equal(await accepts(s), false);
});

test("refused: the right note at the wrong position", async () => {
  const moved = { note: aliceChange.note, index: aliceChange.index - 1 };
  const tx = C.buildTransaction({ ...base, privKey: alice.sk, inputs: [moved], outputs: [C.newNote(aliceChange.note.amount, bob.pk)] });
  assert.equal(await accepts(tx.signals), false);
});

test("refused: a nullifier other than the note's own", async () => {
  const s = clone(spend().signals); s.inputNullifier[0] = C.randomField();
  assert.equal(await accepts(s), false);
});

test("refused: an output commitment that does not match the note", async () => {
  const s = clone(spend().signals); s.outputCommitment[0] = C.randomField();
  assert.equal(await accepts(s), false);
});

test("refused: withdrawing more than the proof covers", async () => {
  const tx = C.buildTransaction({ ...base, privKey: alice.sk, inputs: [aliceChange], outputs: [], publicAmount: -aliceChange.note.amount });
  assert.equal(await accepts(tx.signals), true);
  const s = clone(tx.signals); s.publicAmount = (C.P - aliceChange.note.amount - ETH) % C.P;
  assert.equal(await accepts(s), false);
});

test("refused: any altered value in the auditor's copy", async () => {
  const good = spend().signals;
  for (let i = 0; i < good.auditCipher.length; i++) {
    const s = clone(good); s.auditCipher[i] = (s.auditCipher[i] + 1n) % C.P;
    assert.equal(await accepts(s), false, `cipher ${i}`);
  }
  const s = clone(good); s.auditEphemeral = C.auditorKeyPair().pubKey;
  assert.equal(await accepts(s), false, "ephemeral");
});

test("refused: telling the auditor a different story than the transaction", async () => {
  const tx = spend();
  const s = clone(tx.signals);
  const lie = C.auditEncrypt([alice.pk, 0n, alice.pk, 0n, alice.pk], auditor.pubKey, s.inputNullifier[0], s.auditNonce);
  s.auditCipher = lie.cipher; s.auditEphemeral = lie.ephemeral;
  assert.equal(await accepts(s), false);
});

test("refused: a copy sealed to one key but presented as sealed to another", async () => {
  const s = clone(spend().signals); s.auditorPubKey = C.auditorKeyPair().pubKey;
  assert.equal(await accepts(s), false);
});

test("refused: an auditor key that is not a point on the curve", async () => {
  const s = clone(spend().signals); s.auditorPubKey = [1n, 2n];
  assert.equal(await accepts(s), false);
});

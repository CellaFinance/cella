// The mainnet proving key and the verifier contract exported from it must agree,
// and must have nothing in common with the local test key.
// Skipped when build/mainnet/transact.zkey is absent (it is made by scripts/ceremony.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as snarkjs from "snarkjs";
import * as C from "../src/cella.mjs";
import { ROOT, startChain, freshAccount, deployContract, artifact } from "../scripts/lib/local.mjs";

const WASM = join(ROOT, "build/transact_js/transact.wasm");
const MAIN = join(ROOT, "build/mainnet/transact.zkey"), TEST = join(ROOT, "build/bench/g16.zkey");
const skip = !existsSync(MAIN) && "no mainnet key on this machine";
const record = JSON.parse(readFileSync(join(ROOT, "ceremony/mainnet.json"), "utf8"));
let net, verifier, signals;

const callData = async (zkey) => {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(signals, WASM, zkey);
  const [a, b, c, pub] = JSON.parse("[" + (await snarkjs.groth16.exportSolidityCallData(proof, publicSignals)) + "]");
  const big = (x) => (Array.isArray(x) ? x.map(big) : BigInt(x));
  return [big(a), big(b), big(c), big(pub)];
};
const accepts = (args) => net.pub.readContract({ address: verifier, abi: artifact("Groth16VerifierMainnet", "Groth16VerifierMainnet").abi, functionName: "verifyProof", args });

before(async () => {
  if (skip) return;
  await C.init();
  net = await startChain(8584);
  ({ address: verifier } = await deployContract(net, await freshAccount(net), artifact("Groth16VerifierMainnet", "Groth16VerifierMainnet")));
  const sk = C.randomField();
  signals = C.buildTransaction({ tree: new C.Tree(), privKey: sk, outputs: [C.newNote(10n ** 16n, C.pubKeyOf(sk))], publicAmount: 10n ** 16n, auditorPubKey: C.auditorKeyPair().pubKey }).signals;
});
after(async () => { net?.proc.kill(); await globalThis.curve_bn128?.terminate?.(); });

test("the key on disk is the one in the public record", { skip }, async () => {
  assert.equal(createHash("sha256").update(readFileSync(MAIN)).digest("hex"), record.finalKeySha256);
  assert.deepEqual(await snarkjs.zKey.exportVerificationKey(MAIN), record.verificationKey);
  assert.equal(createHash("sha256").update(readFileSync(join(ROOT, "build/transact.r1cs"))).digest("hex"), record.r1csSha256);
});

test("the mainnet verifier accepts a proof made with the mainnet key, and no altered one", { skip }, async () => {
  const args = await callData(MAIN);
  assert.equal(await accepts(args), true);
  const altered = structuredClone(args); altered[3][1] += 1n;
  assert.equal(await accepts(altered), false);
});

test("a proof made with the local test key is worthless on mainnet", { skip }, async () => {
  assert.equal(await accepts(await callData(TEST)), false);
  assert.notDeepEqual(await snarkjs.zKey.exportVerificationKey(TEST), record.verificationKey);
});

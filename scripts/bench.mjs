// Times proof generation for the transact circuit under Groth16 and PLONK,
// and checks that a real proof verifies while an altered public value does not.
// Needs build/bench/{g16.zkey,plonk.zkey} made from a local, test-only setup.
import * as snarkjs from "snarkjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { statSync } from "node:fs";
import * as C from "../src/cella.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const WASM = join(root, "build/transact_js/transact.wasm");
const RUNS = Number(process.argv[2] ?? 3);

await C.init();
const auditor = C.auditorKeyPair();
const sk = C.randomField(), pk = C.pubKeyOf(sk);
const tree = new C.Tree();
const dep = C.buildTransaction({ tree, privKey: sk, outputs: [C.newNote(10n ** 18n, pk)], publicAmount: 10n ** 18n, auditorPubKey: auditor.pubKey });
const index = tree.insert(dep.signals.outputCommitment[0]);
tree.insert(dep.signals.outputCommitment[1]);
const tx = C.buildTransaction({ tree, privKey: sk, inputs: [{ note: dep.outputs[0], index }],
  outputs: [C.newNote(7n * 10n ** 17n, C.pubKeyOf(C.randomField())), C.newNote(3n * 10n ** 17n, pk)], auditorPubKey: auditor.pubKey });

for (const [name, sys] of [["groth16", snarkjs.groth16], ["plonk", snarkjs.plonk]]) {
  const zkey = join(root, `build/bench/${name === "groth16" ? "g16" : "plonk"}.zkey`);
  const vkey = await snarkjs.zKey.exportVerificationKey(zkey);
  const times = [];
  let last;
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    last = await sys.fullProve(tx.signals, WASM, zkey);
    times.push((performance.now() - t) / 1000);
  }
  const ok = await sys.verify(vkey, last.publicSignals, last.proof);
  const tampered = [...last.publicSignals]; tampered[1] = "1";
  const bad = await sys.verify(vkey, tampered, last.proof);
  const sameOrder = JSON.stringify(last.publicSignals) === JSON.stringify(C.publicSignals(tx.signals));
  console.log(JSON.stringify({ system: name, seconds: times.map((x) => +x.toFixed(2)), zkeyMB: +(statSync(zkey).size / 1e6).toFixed(1),
    verifies: ok, alteredPublicAmountVerifies: bad, publicSignalOrderMatches: sameOrder }));
}
await globalThis.curve_bn128?.terminate?.();
process.exit(0);

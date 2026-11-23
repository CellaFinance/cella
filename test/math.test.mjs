// The browser-friendly maths in src/cella.mjs must agree with circomlibjs,
// the reference implementation the circuit library ships with.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPoseidon, buildBabyjub } from "circomlibjs";
import * as C from "../src/cella.mjs";

test("Poseidon and Baby Jubjub agree with circomlibjs", async () => {
  const poseidon = await buildPoseidon(), bj = await buildBabyjub();
  const ref = (...xs) => poseidon.F.toObject(poseidon(xs));
  for (let i = 0; i < 20; i++) {
    const v = [C.randomField(), C.randomField(), C.randomField(), C.randomField()];
    assert.equal(C.H(v[0]), ref(v[0]));
    assert.equal(C.H(v[0], v[1]), ref(v[0], v[1]));
    assert.equal(C.H(...v), ref(...v));
  }
  assert.deepEqual(C.BASE8, bj.Base8.map((c) => bj.F.toObject(c)));
  for (let i = 0; i < 10; i++) {
    const k = C.randomNonce(), j = C.randomNonce();
    const mine = C.pointMul(C.BASE8, k);
    const theirs = bj.mulPointEscalar(bj.Base8, k);
    assert.deepEqual(mine, theirs.map((c) => bj.F.toObject(c)));
    assert.equal(C.onCurve(mine), true);
    assert.deepEqual(C.pointMul(mine, j), bj.mulPointEscalar(theirs, j).map((c) => bj.F.toObject(c)));
  }
  assert.equal(C.onCurve([1n, 2n]), false);
});

// Client-side maths for Cella: keys, notes, the commitment tree, the auditor's
// copy, and the inputs the `transact` circuit expects. No network, no storage.
// Plain BigInt only, so the same file runs in Node and in a browser.
import { poseidon1 } from "poseidon-lite/poseidon1";
import { poseidon2 } from "poseidon-lite/poseidon2";
import { poseidon4 } from "poseidon-lite/poseidon4";

export const LEVELS = 24;
export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const AMOUNT_LIMIT = 1n << 96n;
const TAG_NOTE = 1n, TAG_NULLIFIER = 2n, TAG_AUDIT = 3n;
const NONCE_BITS = 251n;

/** Kept for callers that awaited the old wasm-backed setup. */
export async function init() {}

const POSEIDON = { 1: poseidon1, 2: poseidon2, 4: poseidon4 };
export const H = (...xs) => POSEIDON[xs.length](xs);

function randomBigInt(bytes) {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(bytes));
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}
export const randomField = () => randomBigInt(31);
export const randomNonce = () => randomBigInt(32) % (1n << NONCE_BITS);

// ---- Baby Jubjub (twisted Edwards, a*x^2 + y^2 = 1 + d*x^2*y^2 over P) ----
const BJ_A = 168700n, BJ_D = 168696n;
export const BASE8 = [
  5299619240641551281634865583518297030282874472190772894086521144482721001553n,
  16950150798460657717958625567821834550301663161624707787222815936182638968203n,
];
const mod = (v) => ((v % P) + P) % P;
function powMod(b, e) {
  let r = 1n; b = mod(b);
  while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; }
  return r;
}
const inv = (v) => powMod(v, P - 2n);
function pointAdd([x1, y1], [x2, y2]) {
  const k = mod(BJ_D * x1 * x2 % P * y1 % P * y2);
  return [mod((x1 * y2 + y1 * x2) * inv(1n + k)), mod((y1 * y2 - BJ_A * x1 * x2) * inv(1n - k))];
}
export function pointMul(point, scalar) {
  let acc = [0n, 1n], cur = point;
  for (let e = scalar; e > 0n; e >>= 1n) {
    if (e & 1n) acc = pointAdd(acc, cur);
    cur = pointAdd(cur, cur);
  }
  return acc;
}
export function onCurve([x, y]) {
  const x2 = x * x % P, y2 = y * y % P;
  return x !== 0n && mod(BJ_A * x2 + y2) === mod(1n + BJ_D * x2 % P * y2);
}

export const pubKeyOf = (privKey) => H(privKey);
export const commitmentOf = (note) => H(TAG_NOTE, note.amount, note.pubKey, note.blinding);
export const nullifierOf = (commitment, index, privKey) => H(TAG_NULLIFIER, commitment, BigInt(index), privKey);
export const newNote = (amount, pubKey) => ({ amount: BigInt(amount), pubKey, blinding: randomField() });

/** Incremental Merkle tree, empty leaf = 0, same hashing as the circuit. */
export class Tree {
  constructor(levels = LEVELS) {
    this.levels = levels;
    this.zeros = [0n];
    for (let i = 0; i < levels; i++) this.zeros.push(H(this.zeros[i], this.zeros[i]));
    this.layers = Array.from({ length: levels + 1 }, () => []);
  }
  get size() { return this.layers[0].length; }
  get root() { return this.layers[this.levels][0] ?? this.zeros[this.levels]; }
  insert(leaf) {
    let index = this.layers[0].length;
    const at = index;
    this.layers[0].push(leaf);
    for (let l = 0; l < this.levels; l++) {
      const left = index % 2 === 0 ? this.layers[l][index] : this.layers[l][index - 1];
      const right = index % 2 === 0 ? (this.layers[l][index + 1] ?? this.zeros[l]) : this.layers[l][index];
      index = Math.floor(index / 2);
      this.layers[l + 1][index] = H(left, right);
    }
    return at;
  }
  path(index) {
    const out = [];
    for (let l = 0; l < this.levels; l++) {
      const sib = index % 2 === 0 ? index + 1 : index - 1;
      out.push(this.layers[l][sib] ?? this.zeros[l]);
      index = Math.floor(index / 2);
    }
    return out;
  }
}

// ---- auditor ----
export function auditorKeyPair(secret = randomNonce()) {
  return { secret, pubKey: pointMul(BASE8, secret) };
}
function stream(sharedX, nullifier0, n) {
  return Array.from({ length: n }, (_, i) => H(TAG_AUDIT, sharedX, nullifier0, BigInt(i)));
}
export function auditEncrypt(plain, auditorPubKey, nullifier0, nonce = randomNonce()) {
  const ephemeral = pointMul(BASE8, nonce);
  const shared = pointMul(auditorPubKey, nonce);
  const ks = stream(shared[0], nullifier0, plain.length);
  return { nonce, ephemeral, cipher: plain.map((v, i) => (v + ks[i]) % P) };
}
/** What the auditor reads from one transaction's public values. */
export function auditDecrypt(cipher, ephemeral, auditorSecret, nullifier0) {
  const shared = pointMul(ephemeral, auditorSecret);
  const ks = stream(shared[0], nullifier0, cipher.length);
  const v = cipher.map((c, i) => (c - ks[i] + P) % P);
  return { sender: v[0], outputs: [{ amount: v[1], pubKey: v[2] }, { amount: v[3], pubKey: v[4] }] };
}

/**
 * Circuit inputs for one transaction.
 *   inputs:  up to 2 of { note, index } already in `tree`; missing ones are zero notes
 *   outputs: up to 2 notes; missing ones are zero notes to the sender
 *   publicAmount: deposit - withdrawal - fee, as a signed BigInt
 */
export function buildTransaction({ tree, privKey, inputs = [], outputs = [], publicAmount = 0n, extDataHash = 0n, auditorPubKey, auditNonce }) {
  const pubKey = pubKeyOf(privKey);
  const ins = [...inputs];
  while (ins.length < 2) ins.push({ note: newNote(0n, pubKey), index: 0, dummy: true });
  const outs = [...outputs];
  while (outs.length < 2) outs.push(newNote(0n, pubKey));

  const inCommit = ins.map((i) => commitmentOf(i.note));
  const inputNullifier = ins.map((i, k) => nullifierOf(inCommit[k], i.index, privKey));
  const outputCommitment = outs.map(commitmentOf);
  const audit = auditEncrypt(
    [pubKey, outs[0].amount, outs[0].pubKey, outs[1].amount, outs[1].pubKey],
    auditorPubKey, inputNullifier[0], auditNonce);

  const zeroPath = Array(tree.levels).fill(0n);
  return {
    outputs: outs,
    signals: {
      root: tree.root,
      publicAmount: ((BigInt(publicAmount) % P) + P) % P,
      extDataHash,
      inputNullifier,
      outputCommitment,
      auditorPubKey,
      auditEphemeral: audit.ephemeral,
      auditCipher: audit.cipher,
      privKey,
      inAmount: ins.map((i) => i.note.amount),
      inBlinding: ins.map((i) => i.note.blinding),
      inPathIndex: ins.map((i) => BigInt(i.index)),
      inPathElements: ins.map((i) => (i.dummy ? zeroPath : tree.path(i.index))),
      outAmount: outs.map((o) => o.amount),
      outPubKey: outs.map((o) => o.pubKey),
      outBlinding: outs.map((o) => o.blinding),
      auditNonce: audit.nonce,
    },
  };
}

/** Public signals in the order the verifier receives them. */
export function publicSignals(s) {
  return [s.root, s.publicAmount, s.extDataHash, ...s.inputNullifier, ...s.outputCommitment,
    ...s.auditorPubKey, ...s.auditEphemeral, ...s.auditCipher].map(String);
}

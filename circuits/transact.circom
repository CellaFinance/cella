pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/switcher.circom";
include "circomlib/circuits/babyjub.circom";
include "circomlib/circuits/escalarmulany.circom";
include "circomlib/circuits/escalarmulfix.circom";

// Root of the Merkle path that starts at `leaf`, position `index`.
template MerkleRoot(levels) {
    signal input leaf;
    signal input index;
    signal input siblings[levels];
    signal output root;

    component bits = Num2Bits(levels);
    bits.in <== index;

    component sw[levels];
    component h[levels];
    signal cur[levels + 1];
    cur[0] <== leaf;
    for (var i = 0; i < levels; i++) {
        sw[i] = Switcher();
        sw[i].sel <== bits.out[i];
        sw[i].L <== cur[i];
        sw[i].R <== siblings[i];
        h[i] = Poseidon(2);
        h[i].inputs[0] <== sw[i].outL;
        h[i].inputs[1] <== sw[i].outR;
        cur[i + 1] <== h[i].out;
    }
    root <== cur[levels];
}

// One circuit for deposit, transfer and withdraw: 2 notes in, 2 notes out.
//   note       = (amount, owner public key, blinding)
//   commitment = Poseidon(1, amount, pk, blinding)
//   nullifier  = Poseidon(2, commitment, leaf index, private key)
//   pk         = Poseidon(private key)
// publicAmount is (deposit - withdrawal - relayer fee) in the field; the pool
// contract computes it, so the prover cannot choose it freely.
template Transact(levels) {
    var AMOUNT_BITS = 96;
    var NONCE_BITS = 251;
    var N_AUDIT = 5;
    var TAG_NOTE = 1;
    var TAG_NULLIFIER = 2;
    var TAG_AUDIT = 3;

    // ---- public ----
    signal input root;
    signal input publicAmount;
    signal input extDataHash;
    signal input inputNullifier[2];
    signal input outputCommitment[2];
    signal input auditorPubKey[2];
    signal input auditEphemeral[2];
    signal input auditCipher[N_AUDIT];

    // ---- private ----
    signal input privKey;
    signal input inAmount[2];
    signal input inBlinding[2];
    signal input inPathIndex[2];
    signal input inPathElements[2][levels];
    signal input outAmount[2];
    signal input outPubKey[2];
    signal input outBlinding[2];
    signal input auditNonce;

    // The spender's public key. Both inputs must belong to it.
    component pk = Poseidon(1);
    pk.inputs[0] <== privKey;

    // ---- inputs ----
    component inCommit[2];
    component inNull[2];
    component inRoot[2];
    component inCheck[2];
    var sumIn = 0;
    for (var i = 0; i < 2; i++) {
        inCommit[i] = Poseidon(4);
        inCommit[i].inputs[0] <== TAG_NOTE;
        inCommit[i].inputs[1] <== inAmount[i];
        inCommit[i].inputs[2] <== pk.out;
        inCommit[i].inputs[3] <== inBlinding[i];

        inNull[i] = Poseidon(4);
        inNull[i].inputs[0] <== TAG_NULLIFIER;
        inNull[i].inputs[1] <== inCommit[i].out;
        inNull[i].inputs[2] <== inPathIndex[i];
        inNull[i].inputs[3] <== privKey;
        inNull[i].out === inputNullifier[i];

        inRoot[i] = MerkleRoot(levels);
        inRoot[i].leaf <== inCommit[i].out;
        inRoot[i].index <== inPathIndex[i];
        for (var j = 0; j < levels; j++) {
            inRoot[i].siblings[j] <== inPathElements[i][j];
        }

        // A note worth zero needs no place in the tree; any other note does.
        inCheck[i] = ForceEqualIfEnabled();
        inCheck[i].enabled <== inAmount[i];
        inCheck[i].in[0] <== root;
        inCheck[i].in[1] <== inRoot[i].root;

        sumIn += inAmount[i];
    }

    // The same note cannot be spent twice in one transaction.
    component sameNull = IsEqual();
    sameNull.in[0] <== inputNullifier[0];
    sameNull.in[1] <== inputNullifier[1];
    sameNull.out === 0;

    // ---- outputs ----
    component outCommit[2];
    component outRange[2];
    var sumOut = 0;
    for (var i = 0; i < 2; i++) {
        // Amounts stay below 2^96, so sums can never wrap around the field.
        outRange[i] = Num2Bits(AMOUNT_BITS);
        outRange[i].in <== outAmount[i];

        outCommit[i] = Poseidon(4);
        outCommit[i].inputs[0] <== TAG_NOTE;
        outCommit[i].inputs[1] <== outAmount[i];
        outCommit[i].inputs[2] <== outPubKey[i];
        outCommit[i].inputs[3] <== outBlinding[i];
        outCommit[i].out === outputCommitment[i];

        sumOut += outAmount[i];
    }

    // ---- value is conserved ----
    sumIn + publicAmount === sumOut;

    // ---- the auditor's copy ----
    // ElGamal-style: R = r*G is published, the shared point is r*A, and each
    // value is masked with a Poseidon stream keyed by that point. Because this
    // is part of the proof, a sender cannot hand the auditor garbage.
    component onCurve = BabyCheck();
    onCurve.x <== auditorPubKey[0];
    onCurve.y <== auditorPubKey[1];

    component nonceBits = Num2Bits(NONCE_BITS);
    nonceBits.in <== auditNonce;

    var BASE8[2] = [
        5299619240641551281634865583518297030282874472190772894086521144482721001553,
        16950150798460657717958625567821834550301663161624707787222815936182638968203
    ];
    component eph = EscalarMulFix(NONCE_BITS, BASE8);
    component shared = EscalarMulAny(NONCE_BITS);
    for (var i = 0; i < NONCE_BITS; i++) {
        eph.e[i] <== nonceBits.out[i];
        shared.e[i] <== nonceBits.out[i];
    }
    shared.p[0] <== auditorPubKey[0];
    shared.p[1] <== auditorPubKey[1];
    eph.out[0] === auditEphemeral[0];
    eph.out[1] === auditEphemeral[1];

    signal plain[N_AUDIT];
    plain[0] <== pk.out;
    plain[1] <== outAmount[0];
    plain[2] <== outPubKey[0];
    plain[3] <== outAmount[1];
    plain[4] <== outPubKey[1];

    component stream[N_AUDIT];
    for (var i = 0; i < N_AUDIT; i++) {
        stream[i] = Poseidon(4);
        stream[i].inputs[0] <== TAG_AUDIT;
        stream[i].inputs[1] <== shared.out[0];
        stream[i].inputs[2] <== inputNullifier[0];
        stream[i].inputs[3] <== i;
        auditCipher[i] === plain[i] + stream[i].out;
    }

    // Ties the proof to the recipient, relayer, fee and encrypted notes.
    signal extSquare;
    extSquare <== extDataHash * extDataHash;
}

component main {public [
    root, publicAmount, extDataHash, inputNullifier, outputCommitment,
    auditorPubKey, auditEphemeral, auditCipher
]} = Transact(24);

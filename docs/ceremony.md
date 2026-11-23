# Proving key ceremony (mainnet)

Groth16 needs a proving key made for the specific circuit. If everyone who took part in making it kept their secret randomness, someone could forge proofs and drain the pool. The key is sound as long as at least one participant discarded theirs.

## How the mainnet key was made

`scripts/ceremony.mjs` does the following, and writes the public record to `ceremony/mainnet.json`:

1. **Phase 1.** The public Hermez `powersOfTau28_hez_final_16.ptau`, from many independent participants. The file is checked against the published blake2b checksum recorded in the JSON.
2. **Phase 2, step 1.** One contribution with 64 random bytes from the operating system of the machine that ran it, used once and never stored.
3. **Phase 2, step 2.** A beacon: the hash of a Robinhood Chain mainnet block chosen after step 1 was written to disk (20 blocks ahead of the head at that moment), so no one could have picked it.
4. The finished key is verified by the `snarkjs` command line in a separate process, then the verifier contract is exported.

## Limits

Phase 2 had one contributor, the operator. The key is therefore sound unless the operator kept the random bytes. The script does not store them, but outsiders cannot confirm that. More contributors can be added by continuing from the key after step 1 and before the beacon. Changing the key means a new verifier and a new pool, because the verifier is fixed in the pool contract.

## Verify it yourself

You need the compiled circuit (`npm run build:circuit` gives `build/transact.r1cs`; its sha256 must equal `r1csSha256` in `ceremony/mainnet.json`) and the proving key served by the app at `/prover/transact.zkey` (its sha256 must equal `finalKeySha256`).

```bash
npx snarkjs zkey verify build/transact.r1cs powersOfTau28_hez_final_16.ptau transact.zkey
```

The command must print `ZKey Ok!`. To confirm the on-chain verifier matches, export it and compare with the deployed bytecode:

```bash
npx snarkjs zkey export solidityverifier transact.zkey Verifier.sol
```

`test/mainnet-key.test.mjs` checks that proofs made with this key pass the mainnet verifier contract, that tampered proofs fail, and that proofs from the testnet test key fail.

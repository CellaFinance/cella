# How it works

## Parts

| Part | Where it runs | Job |
| --- | --- | --- |
| `CellaPool` | On chain | Holds the ETH, the commitment tree and the list of spent nullifiers; checks proofs |
| Verifier | On chain | Checks one Groth16 proof (generated from the circuit and the proving key) |
| `CellaRegistry` | On chain | Maps a 0x address to a Cella address so a payer only needs the recipient's 0x address |
| `transact` circuit | In the user's browser | Produces the proof for deposit, pay and withdraw |
| App | Static site | Wallet, balance scanning, proving |
| Relayer | Small optional server | Sends transactions and pays gas so the payer's address stays out of it |
| Auditor tool | The auditor's computer | Decrypts the auditor ciphertext from chain events |

There is no database. Everything needed to recover a balance is in chain events and can be opened with the user's own keys.

## Keys and addresses

A user signs one fixed message in their wallet. Two keys are derived from the signature:

- a **spending key** `sk`, a secret number, with public key `pk = Poseidon(sk)`;
- an **encryption key**, an X25519 pair, used to receive notes.

A Cella address is `(pk, encryption public key)`. Wallets that sign the same message differently would make the keys impossible to re-derive, so the app checks consistency on first use and refuses such wallets.

## Notes, commitments, nullifiers

- A **note** is `(amount, owner pk, blinding)`.
- A **commitment** is `Poseidon(amount, pk, blinding)`. Commitments are the leaves of an incremental Merkle tree (depth 24, about 16 million notes, Poseidon hash). The contract keeps the last 100 roots.
- A **nullifier** is `Poseidon(commitment, leaf index, sk)`. It is published when a note is spent. The contract rejects a nullifier it has seen before.

## One circuit, three actions

`transact` takes 2 input notes and produces 2 output notes, with one public signed amount `extAmount`:

| Action | `extAmount` | Visible on chain |
| --- | --- | --- |
| Deposit | positive | Depositor address and amount |
| Pay | zero | Two nullifiers, two commitments, ciphertexts |
| Withdraw | negative | Recipient address and amount |

What the circuit proves:

1. Each input note is in the tree under a published root, or has amount zero.
2. The prover knows the owner's `sk` for each input note.
3. Nullifiers are computed correctly and the two are different.
4. `inputs + extAmount = outputs + relayer fee`.
5. Every amount is between 0 and 2^96, so nothing wraps around.
6. The auditor ciphertext really contains the sender `pk`, recipient `pk` and amount of each output note.
7. The proof is bound to `extDataHash`: recipient, relayer, fee, note ciphertexts, chain ID and pool address. Replaying it elsewhere or altering any of these invalidates it.

Using one circuit means one thing to audit instead of three.

## Auditor

The pool stores an auditor public key (BabyJubJub). Inside the circuit, a one-time key `r` gives a point `R = r·G` that is published, a shared secret `r·A`, and each value is encrypted with a Poseidon stream. Because this is part of the proof, a sender cannot fill the auditor field with garbage.

Changing the auditor key is possible only for the contract owner, with a 7-day delay that anyone can see. Old transactions stay readable only by the old key.

The auditor learns who (by `pk`) paid how much to whom. Linking a `pk` to a real person comes from deposits, withdrawals and the registry.

## Relayer

The user hands a proof to the relayer. The relayer sends the transaction and takes its fee from the note, in the amount written in the proof. It can refuse service but cannot change the recipient, amount or fee. Without a relayer the user sends the transaction themselves; the only loss is that their gas-paying address is visible for that transaction. The relayer does see the user's IP address.

If the relayer's RPC fails, it retries without ever sending the same signed transaction twice. If the RPC stays down it answers 503 and nothing is sent. See [Running a relayer](relayer.md).

## Payments that are refused

When the pool pays ETH to an address (a withdrawal, or a relayer fee), it sends with a 50,000 gas allowance. If the recipient refuses or runs out of gas, the transaction still succeeds and the amount is recorded in `owed[recipient]`. The recipient collects it with `claim()`. This stops a contract recipient from making relayed withdrawals fail at the relayer's expense. The app shows a "Collect it" button when a connected wallet is owed something.

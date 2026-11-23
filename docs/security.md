# Security

**Cella is beta software and has not been audited by an outside firm.** The deposit caps (0.1 ETH each, 5 ETH in total on mainnet) exist so that a mistake costs little. If you find a problem, please report it privately before disclosing it.

## What Cella promises

| Promise | Kept by |
| --- | --- |
| Funds can only be spent by the owner of a note's key | The zero-knowledge proof checked by the contract |
| No money is created or lost inside the pool | The amount rule in the circuit: in equals out |
| The operator cannot see transfers | Notes are only commitments and ciphertexts on chain |
| The operator cannot hold funds back | Anyone can send their own transaction without a relayer |
| The auditor can read every transfer | The circuit rejects transactions with a wrong auditor ciphertext |
| The auditor cannot move funds | The auditor key can only read |

## What it does not promise

- **Deposits and withdrawals are public.** Wallet address and amount are on chain.
- **Privacy depends on how many people use it.** With only a few users, an observer can guess who withdrew from amounts and timing.
- **The auditor sees everything.** That is the point of the auditor key.
- **The relayer sees your IP address.**
- **A flaw in the circuit or contracts could drain the pool.** Tests are not a substitute for an outside audit.

## Owner powers

The contracts are not upgradeable. The owner can only:

| Power | Limit |
| --- | --- |
| Replace the auditor key | 7-day public delay |
| Pause new deposits | Withdrawals and transfers can never be paused |
| Change the deposit limits | Does not touch funds already inside |

No function moves ETH without a valid proof.

## Proving key

The mainnet key comes from the public Hermez phase 1 ceremony plus one phase 2 contribution from the operator and a chain-block beacon. It is sound unless that single contributor kept their randomness. This cannot be proved to outsiders. See [Proving key ceremony](ceremony.md) for the record and how to verify it.

## Checks done so far

- Attack tests for the pool and circuit: double spending, forged or foreign proofs, unknown roots, relayer tampering, amount overflow, replay on another chain or contract, reentrancy, wrong auditor ciphertext, deposit limits, a full tree, early auditor key change.
- Static analysis with slither (contracts) and circomspect (circuit). One real issue found and fixed: a refusing recipient could make relayed withdrawals fail at the relayer's cost, now handled by the `owed` / `claim()` pattern. Details in `docs/RANCANGAN.md`, section 27 (Indonesian).
- End-to-end runs on testnet and, with small amounts, on mainnet, including a read-back as the auditor.

## Not done

- An outside audit.
- Additional phase 2 contributors for the proving key.
- Rate limiting in front of the relayer.
- Wide testing of wallets and phones.

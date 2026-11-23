# Cella

Private payments for ETH on Robinhood Chain.

Cella is a shielded pool. You deposit ETH into one shared pool, pay other Cella users inside it, and withdraw to any address. Deposits and withdrawals are public; what happens in between is not. An observer sees that someone paid, but not who paid whom or how much. There is no server holding a ledger, and nobody can move another person's funds.

> **Beta. Not audited by an outside firm.** Use small amounts. On mainnet deposits are capped at 0.1 ETH each and 5 ETH in total. See [Security](docs/security.md) for what Cella does and does not promise.

- App (mainnet): https://cella-mainnet.pages.dev
- App (testnet): https://cella-br5.pages.dev

## How it works, in short

1. **Deposit.** ETH goes into `CellaPool`. A commitment to your private balance is added to an on-chain Merkle tree.
2. **Pay.** You prove in your browser, with a zero-knowledge proof (Groth16), that you own unspent notes and that the amounts add up. The contract checks the proof and records only nullifiers and new commitments.
3. **Withdraw.** Same proof, with a public amount going out to an address you choose.
4. **Relayer (optional).** A small service sends the transaction and pays gas, so your wallet does not appear as the sender. It cannot change the recipient, amount or fee: all three are bound by the proof.
5. **Auditor.** Every transaction carries a ciphertext only the auditor key can read, and the circuit rejects transactions where it is wrong. Privacy holds against the public, not against the auditor. The auditor key is read-only and cannot move funds.

More in [How it works](docs/how-it-works.md).

## Repository map

| Path | What it is |
| --- | --- |
| `circuits/transact.circom` | The one circuit behind deposit, pay and withdraw |
| `contracts/` | `CellaPool`, `CellaRegistry`, the Groth16 verifiers, and Foundry tests |
| `src/` | Client library: keys, notes, proving, syncing a balance from chain events |
| `web/` | The app, the landing page and the auditor page |
| `relayer/` | The relayer, as a Node server and as a Cloudflare Pages function |
| `auditor/` | Command line tool for the auditor |
| `scripts/` | Build, deploy, key ceremony, publish and smoke-test scripts |
| `ceremony/` | Public record of the mainnet proving key ceremony |
| `deployments/` | Addresses of every deployment |
| `test/` | Tests: math, circuit, pool, client, relayer, auditor |
| `docs/` | Documentation |

## Deployments

| Network | Chain ID | CellaPool |
| --- | --- | --- |
| Robinhood Chain | 4663 | `0x6bfd78e6c3761b8a8e5ea216b39e64c82b9c76cd` |
| Robinhood Chain Testnet | 46630 | `0x48285350eb8890015b3fd28a30b99dc6c6584f2d` |

Full lists, including the verifier, hasher and registry, are in [Deployments](docs/deployments.md).

## Run it locally

Needs Node 20 or newer, [circom](https://github.com/iden3/circom) 2.2 and [Foundry](https://getfoundry.sh).

```bash
npm install
npm run build:circuit
node scripts/dev-chain.mjs   # local copy of the chain with Cella deployed, plus a relayer
npx vite                     # in a second terminal: the app
```

Tests:

```bash
node --test --test-concurrency=1 test/
```

The pool and relayer tests fork the public RPC. If it answers 429, wait a minute, or keep the concurrency at 1 as above.

## Documentation

- [How it works](docs/how-it-works.md): notes, nullifiers, the circuit, the auditor, the relayer
- [Security](docs/security.md): promises, limits, owner powers, known risks
- [Proving key ceremony](docs/ceremony.md): how the mainnet key was made and how to check it
- [Deployments](docs/deployments.md): addresses and how to deploy
- [Running a relayer](docs/relayer.md)
- [For auditors](docs/auditor.md)
- Design notes and deployment log, in Indonesian: [RANCANGAN](docs/RANCANGAN.md), [DEPLOY](docs/DEPLOY.md)

## License

MIT. See [LICENSE](LICENSE).

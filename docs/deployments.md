# Deployments

## Robinhood Chain, mainnet (4663)

Beta, unaudited. Deposit limits: 0.1 ETH each, 5 ETH in total. Owner: `0xb7f1C2882BE91587CdDE97474297a992cb298478`.

| Contract | Address |
| --- | --- |
| CellaPool | `0x6bfd78e6c3761b8a8e5ea216b39e64c82b9c76cd` |
| CellaRegistry | `0x8d6cde1ff699de46543adc404ccdeb8a3b5b243d` |
| Groth16VerifierMainnet | `0x6e654fb9f3af625c553ffcbd0f8f0963848c2090` |
| Hasher | `0x85b67b781dee8792694a5038668a35ebb12c61fb` |

Data file: `deployments/4663.json`. App: https://cella-mainnet.pages.dev

## Robinhood Chain Testnet (46630)

Uses a local test proving key, not the ceremony key. Do not treat testnet as a security reference.

| Contract | Address |
| --- | --- |
| CellaPool | `0x48285350eb8890015b3fd28a30b99dc6c6584f2d` |
| CellaRegistry | `0xc806318f49a41273f6f80e8451b4735080af4920` |
| Groth16Verifier | `0x90e9e448558eeda6263071317140222247af7979` |
| Hasher | `0xe431300949284e205fd3eb33d79ac685538e84ff` |

Data file: `deployments/46630.json`. App: https://cella-br5.pages.dev. An earlier testnet pool is kept in `deployments/46630-v1.json`.

## Deploying

```bash
node scripts/deploy.mjs --network testnet|mainnet --auditor-file <auditor key file> --owner <0x…> [--unaudited-mainnet]
```

- Keys are read from `~/.config/cella/` and are never printed. Mainnet uses the `-mainnet` files.
- Mainnet needs `--unaudited-mainnet` and refuses a verifier built from a test key.
- After deploying the script checks on chain that the hash function and empty-tree root match the client, that the auditor key and owner are as requested, that the limits are as requested, and that the pool points at the verifier and hasher just deployed.
- `--dry-run` rehearses on a local copy.

Publish the site and relayer to Cloudflare Pages:

```bash
sh scripts/publish.sh deployments/4663.json <pages-project> relayer-mainnet
```

Check a deployment end to end with small amounts:

```bash
node scripts/testnet-smoke.mjs --deployment deployments/4663.json --relayer https://<site>/api/relayer
```

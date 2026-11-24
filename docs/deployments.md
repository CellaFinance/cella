# Deployments

## Robinhood Chain, mainnet (4663)

Explorer: https://robinhoodchain.blockscout.com

Beta, unaudited. Deposit limits: 0.1 ETH each, 5 ETH in total. Owner: `0xb7f1C2882BE91587CdDE97474297a992cb298478`.

| Contract | Address |
| --- | --- |
| CellaPool | [`0x6bfd78e6c3761b8a8e5ea216b39e64c82b9c76cd`](https://robinhoodchain.blockscout.com/address/0x6bfd78e6c3761b8a8e5ea216b39e64c82b9c76cd) |
| CellaRegistry | [`0x8d6cde1ff699de46543adc404ccdeb8a3b5b243d`](https://robinhoodchain.blockscout.com/address/0x8d6cde1ff699de46543adc404ccdeb8a3b5b243d) |
| Groth16VerifierMainnet | [`0x6e654fb9f3af625c553ffcbd0f8f0963848c2090`](https://robinhoodchain.blockscout.com/address/0x6e654fb9f3af625c553ffcbd0f8f0963848c2090) |
| Hasher | [`0x85b67b781dee8792694a5038668a35ebb12c61fb`](https://robinhoodchain.blockscout.com/address/0x85b67b781dee8792694a5038668a35ebb12c61fb) |

Data file: `deployments/4663.json`. Website and app: https://cella.finance (also reachable at https://cella-mainnet.pages.dev)

## CELLA token

Launched on Pons, on Robinhood Chain mainnet. Name and symbol `CELLA`, 18 decimals, total supply 1,000,000,000.

| | Address |
| --- | --- |
| CELLA token | [`0x25be09017fd4bb5391bf265eadc8ae12d814ab28`](https://robinhoodchain.blockscout.com/token/0x25be09017fd4bb5391bf265eadc8ae12d814ab28) |

Using Cella does not require the token. Always compare the full address with the one on https://cella.finance and on https://x.com/cellafinance.

## Robinhood Chain Testnet (46630)

Uses a local test proving key, not the ceremony key. Do not treat testnet as a security reference.

| Contract | Address |
| --- | --- |
| CellaPool | [`0x48285350eb8890015b3fd28a30b99dc6c6584f2d`](https://explorer.testnet.chain.robinhood.com/address/0x48285350eb8890015b3fd28a30b99dc6c6584f2d) |
| CellaRegistry | [`0xc806318f49a41273f6f80e8451b4735080af4920`](https://explorer.testnet.chain.robinhood.com/address/0xc806318f49a41273f6f80e8451b4735080af4920) |
| Groth16Verifier | `0x90e9e448558eeda6263071317140222247af7979` |
| Hasher | [`0xe431300949284e205fd3eb33d79ac685538e84ff`](https://explorer.testnet.chain.robinhood.com/address/0xe431300949284e205fd3eb33d79ac685538e84ff) |

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

## Hosting layout

- **cella.finance** is a static site on Hostinger. Build it with the relayer and proving key pointing at the Cloudflare project, then upload the folder (or a zip of it) as the website's files:

  ```bash
  node scripts/build-web.mjs deployments/4663.json \
    --relayer https://cella-mainnet.pages.dev/api/relayer \
    --zkey-url https://cella-mainnet.pages.dev/prover/transact.zkey
  ```

  The build writes `.htaccess` (security headers, `application/wasm`, caching) next to `_headers`, which Cloudflare reads. Leave `prover/transact.zkey` (19 MB) out of the upload: the site loads it from the Cloudflare project.
- **cella-mainnet.pages.dev** (Cloudflare Pages) serves the relayer (`/api/relayer`) and the proving key, and answers browser calls from `https://cella.finance` and `https://www.cella.finance` (CORS; change the list with the `CELLA_ALLOW_ORIGINS` setting).
- The documentation pages are built from `docs/*.md` by `scripts/build-docs.mjs` as part of the site build.

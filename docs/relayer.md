# Running a relayer

The relayer sends users' proofs as transactions and pays the gas, so a user's wallet does not show up as the sender. It earns the fee written into each proof. It cannot change the recipient, amount or fee, and cannot spend anyone's funds.

## Settings

| Variable | Meaning |
| --- | --- |
| `CELLA_RELAYER_KEY_FILE` | File holding the gas wallet's private key (default `~/.config/cella/relayer.key`). Make one with `scripts/new-key.mjs relayer`. |
| `CELLA_RELAYER_KEY` | Or the key itself. Never commit either. |
| `CELLA_RPC` | RPC URL |
| `CELLA_CHAIN_ID` | 4663 mainnet, 46630 testnet |
| `CELLA_POOL` | CellaPool address |
| `CELLA_RELAYER_PORT` | Port (default 8580) |
| `CELLA_ALLOW_ORIGIN` | Site allowed to call it from a browser (default `*`) |

```bash
node relayer/main.mjs
```

On Cloudflare Pages the same logic runs as a function (`functions/api/`); its only setting is the secret `CELLA_RELAYER_KEY`.

## Behaviour

- The quoted fee is gas units × current gas price × a margin. A request is accepted if its fee is at least the configured percentage of the current quote.
- The pool simulates each transaction first. A rejection by the pool answers 400 and is never retried.
- If the RPC fails, the relayer retries up to 3 times with growing delays. The transaction is signed once, and that same signed transaction is what gets re-sent, so a retry can never pay twice.
- If the RPC stays down the relayer answers 503 and nothing was sent. The client retries twice on 503.

## Keep it funded

The gas wallet needs ETH. A relayed transaction costs about 0.00003 ETH in gas on mainnet and pays a fee of about 0.000045 ETH, so fees cover the cost, but the wallet must hold enough to front it. Use a wallet that holds only that.

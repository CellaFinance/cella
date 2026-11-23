# Getting started

Cella is live on Robinhood Chain as a limited beta. It has **not been audited by an outside firm**, so use only amounts you could afford to lose. Deposits are capped at 0.1 ETH each, and the pool at 5 ETH in total.

## What you need

- A browser wallet that works on Robinhood Chain (for example Trust Wallet or MetaMask).
- A little ETH on Robinhood Chain: the amount you want to move, plus gas for the deposit.
- Robinhood Chain in your wallet: chain ID **4663**, RPC `https://rpc.mainnet.chain.robinhood.com`, currency ETH.

## 1. Open the app and connect

Go to the app and connect your wallet. Cella asks you to sign one fixed message. Your private keys are derived from that signature, on your device, and never leave it. Signing the same message with the same wallet always gives the same keys, which is how your balance is rebuilt on any device. Nothing is stored on a server.

## 2. Deposit

Choose an amount and deposit. This is an ordinary public transaction from your wallet: the chain sees your address and the amount. Inside the pool the amount becomes a private note that only your keys can open.

## 3. Send privately

Enter the recipient's ordinary 0x address and an amount. Your device makes a zero-knowledge proof (about two seconds on a desktop browser), and a relayer sends the transaction so your wallet does not appear as the sender. The chain sees that a Cella transaction happened, not who paid whom or how much. The relayer's fee, shown before you confirm, is taken from your private balance.

The recipient needs to have opened Cella once so that their 0x address is registered. Their balance appears when they open the app.

## 4. Withdraw

Enter any address and an amount. The pool pays it out. The chain sees the receiving address and the amount, but not which deposit the money came from.

If a recipient is a contract that cannot receive ETH within a small gas allowance, the payment is held for it and shown as "Collect it". Press the button to collect.

## Good to know

- **Keep your wallet.** Your Cella balance is tied to your wallet's signature. Lose the wallet and you lose the balance. There is no recovery service.
- **Privacy grows with use.** With few users, an observer can guess from amounts and timing. Avoid depositing and withdrawing the same amount close together.
- **The auditor can read transfers.** One named key can read who paid whom, by design. It cannot move funds. See [Security](/docs/security/).
- **Check the address.** The pool contract is shown on the home page of this site. Cella has no token: anything else claiming to be Cella's contract is not.

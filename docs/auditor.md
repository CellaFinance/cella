# For auditors

The auditor key is a read-only key. Its public half is stored in the pool; the secret half stays offline with the auditor. It can decrypt, for every transaction, who (by `pk`) paid how much to whom. It cannot move funds.

```bash
node auditor/auditor.mjs keygen --out auditor-key.json      # make a key; give only the public half to the pool's owner
node auditor/auditor.mjs pubkey --key auditor-key.json      # print the public half again
node auditor/auditor.mjs read --key auditor-key.json --deployment deployments/4663.json
node auditor/auditor.mjs read --key auditor-key.json --rpc <URL> --pool 0x… [--registry 0x…] [--from <block>]
```

`read` scans the pool's events from the deployment block, decrypts each record, and checks that the balances add up to the ETH the pool holds. A mismatch or an unreadable record is reported.

Keep the secret file offline and never share it. Anyone holding it can read all past and future transactions of that pool until the key is replaced (the owner can replace it, with a 7-day public delay; old transactions remain readable only with the old key).

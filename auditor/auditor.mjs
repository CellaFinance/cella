#!/usr/bin/env node
// Cella auditor tool. Run it on the auditor's own machine.
//
//   node auditor/auditor.mjs keygen [--out auditor-key.json]
//       Makes a new auditor key. The file holds the secret; only its public
//       half is given to the pool's owner.
//
//   node auditor/auditor.mjs pubkey --key auditor-key.json
//       Prints the public half again.
//
//   node auditor/auditor.mjs read --key auditor-key.json --deployment web/public/deployment.json
//   node auditor/auditor.mjs read --key auditor-key.json --rpc URL --pool 0x… [--registry 0x…] [--from BLOCK]
//       [--format text|json|csv]
//       Reads the pool and prints every transfer this key can open, each
//       participant's balance, and whether they add up to the ETH in the pool.
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { createPublicClient, http } from "viem";
import * as C from "../src/cella.mjs";
import { readLedger, describe, toCsv, formatEth, who } from "./ledger.mjs";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i];
    else out._.push(argv[i]);
  }
  return out;
}
const fail = (message) => { console.error(message); process.exit(1); };

export function keygen(path) {
  if (existsSync(path)) throw new Error(`${path} already exists; refusing to overwrite a key`);
  const { secret, pubKey } = C.auditorKeyPair();
  writeFileSync(path, JSON.stringify({ secret: secret.toString(), pubKey: pubKey.map(String) }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return pubKey;
}
export function loadKey(path) {
  const { secret } = JSON.parse(readFileSync(path, "utf8"));
  if (!/^\d+$/.test(secret ?? "")) throw new Error(`${path} is not a Cella auditor key`);
  return BigInt(secret);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command] = args._;

  if (command === "keygen") {
    const path = args.out ?? "auditor-key.json";
    const pubKey = keygen(path);
    console.log(`Secret saved to ${path} (readable only by you). Keep it offline and never share it.`);
    console.log("Give the pool owner this public key:");
    console.log(`  x: ${pubKey[0]}\n  y: ${pubKey[1]}`);
    return;
  }
  if (!args.key) fail("Missing --key FILE. Run with no arguments to see usage in the file header.");
  const secret = loadKey(args.key);

  if (command === "pubkey") {
    const pubKey = C.pointMul(C.BASE8, secret);
    console.log(`x: ${pubKey[0]}\ny: ${pubKey[1]}`);
    return;
  }
  if (command === "read") {
    const d = args.deployment ? JSON.parse(readFileSync(args.deployment, "utf8")) : {};
    const rpc = args.rpc ?? d.rpc, pool = args.pool ?? d.pool, registry = args.registry ?? d.registry ?? null;
    if (!rpc || !pool) fail("Need --deployment FILE, or --rpc URL and --pool ADDRESS.");
    const publicClient = createPublicClient({ transport: http(rpc) });
    const ledger = await readLedger({ publicClient, pool, registry, fromBlock: args.from ?? d.fromBlock ?? 0, secret });

    const format = args.format ?? "text";
    if (format === "csv") return void process.stdout.write(toCsv(ledger));
    if (format === "json") return void console.log(JSON.stringify(ledger, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));

    console.log(`Pool ${pool}`);
    console.log(`${ledger.records.length} transactions, ${ledger.unreadable} sealed to another key\n`);
    for (const r of ledger.records) console.log(`block ${r.block}  ${describe(r)}`);
    console.log("\nBalances");
    for (const h of ledger.holders) console.log(`  ${formatEth(h.balance).padStart(12)} ETH  ${who(h.address, h.pubKey)}`);
    console.log(`\nSum of balances: ${formatEth(ledger.total)} ETH`);
    console.log(`Held by the pool: ${formatEth(ledger.totalHeld)} ETH`);
    console.log(ledger.reconciled === null ? "Cannot reconcile: some records are sealed to another key."
      : ledger.reconciled ? "Reconciled: the balances add up to what the pool holds." : "MISMATCH: the balances do not add up to what the pool holds.");
    return;
  }
  fail("Commands: keygen, pubkey, read. See the header of this file.");
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => fail(e.shortMessage ?? e.message));

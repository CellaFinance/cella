// The auditor's view of a Cella pool. Reads the pool's public events and opens
// the copies sealed to one auditor key. Runs in Node and in a browser; the
// auditor's secret never leaves the machine it runs on.
//
// What the auditor learns per transaction: who sent it (their Cella key), the
// two notes it created (amount and owner), and from the public events the
// deposit, withdrawal and relayer fee. From that it can rebuild every
// participant's balance and check the total against the ETH the pool holds.
import * as C from "../src/cella.mjs";
import { poolAbi, registryAbi } from "../src/abi.mjs";

const byPosition = (a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1);

export async function readLedger({ publicClient, pool, registry, fromBlock, secret }) {
  const pubKey = C.pointMul(C.BASE8, secret);
  const range = { fromBlock: BigInt(fromBlock), toBlock: "latest" };
  const poolEvents = (eventName) => publicClient.getContractEvents({ address: pool, abi: poolAbi, eventName, ...range });
  const [audits, deposits, withdrawals, fees, registrations, totalHeld] = await Promise.all([
    poolEvents("AuditRecord"), poolEvents("Deposit"), poolEvents("Withdrawal"), poolEvents("RelayerPaid"),
    registry ? publicClient.getContractEvents({ address: registry, abi: registryAbi, eventName: "Registered", ...range }) : [],
    publicClient.readContract({ address: pool, abi: poolAbi, functionName: "totalHeld" }),
  ]);

  // A Cella key is tied to a wallet address only when that wallet published it.
  const addressOf = new Map();
  for (const r of registrations.sort(byPosition)) addressOf.set(r.args.pubKey, r.args.account);
  const inTx = (logs) => new Map(logs.map((l) => [l.transactionHash, l.args]));
  const depositIn = inTx(deposits), withdrawalIn = inTx(withdrawals), feeIn = inTx(fees);

  const balances = new Map();
  const move = (key, delta) => balances.set(key, (balances.get(key) ?? 0n) + delta);
  const records = [];
  let unreadable = 0;

  for (const log of audits.sort(byPosition)) {
    const tx = log.transactionHash;
    const base = { block: log.blockNumber, tx,
      deposit: depositIn.get(tx)?.amount ?? 0n, depositFrom: depositIn.get(tx)?.from ?? null,
      withdrawal: withdrawalIn.get(tx)?.amount ?? 0n, withdrawalTo: withdrawalIn.get(tx)?.to ?? null,
      fee: feeIn.get(tx)?.fee ?? 0n, relayer: feeIn.get(tx)?.relayer ?? null };

    const sealedTo = [...log.args.auditorKey];
    if (sealedTo[0] !== pubKey[0] || sealedTo[1] !== pubKey[1]) {
      unreadable++;
      records.push({ ...base, readable: false, kind: "sealed to another key" });
      continue;
    }
    const seen = C.auditDecrypt([...log.args.cipher], [...log.args.ephemeral], secret, log.args.nullifier0);
    const created = seen.outputs[0].amount + seen.outputs[1].amount;
    // What the sender's spent notes were worth: value out, minus what came in from outside.
    const spent = created - (base.deposit - base.withdrawal - base.fee);
    const paid = seen.outputs.filter((o) => o.amount > 0n && o.pubKey !== seen.sender);
    const kind = base.deposit > 0n ? "deposit" : base.withdrawal > 0n ? "withdraw" : paid.length ? "transfer" : "merge";

    move(seen.sender, -spent);
    for (const o of seen.outputs) if (o.amount > 0n) move(o.pubKey, o.amount);
    records.push({ ...base, readable: true, kind, sender: seen.sender, senderAddress: addressOf.get(seen.sender) ?? null, spent,
      outputs: seen.outputs.map((o) => ({ ...o, address: addressOf.get(o.pubKey) ?? null })),
      payments: paid.map((o) => ({ amount: o.amount, pubKey: o.pubKey, address: addressOf.get(o.pubKey) ?? null })) });
  }

  const holders = [...balances].map(([key, balance]) => ({ pubKey: key, address: addressOf.get(key) ?? null, balance }))
    .sort((a, b) => (a.balance < b.balance ? 1 : -1));
  const total = holders.reduce((t, h) => t + h.balance, 0n);
  return { pubKey, records, holders, total, totalHeld, unreadable,
    // Only meaningful when every record was readable with this key.
    reconciled: unreadable === 0 ? total === totalHeld : null };
}

// ---------------- presentation ----------------

const eth = (wei) => {
  const neg = wei < 0n, v = neg ? -wei : wei;
  const s = (v / 10n ** 18n).toString() + "." + (v % 10n ** 18n).toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  return (neg ? "-" : "") + s.replace(/\.$/, "");
};
export const formatEth = eth;
export const who = (address, pubKey) => address ?? `key ${pubKey.toString(16).padStart(64, "0").slice(0, 10)}…`;

/** One plain sentence per record. */
export function describe(r) {
  if (!r.readable) return "sealed to another auditor key";
  const from = who(r.senderAddress, r.sender);
  const feeNote = r.fee > 0n ? `, relayer fee ${eth(r.fee)}` : "";
  if (r.kind === "deposit") return `${from} deposited ${eth(r.deposit)} ETH from wallet ${r.depositFrom}`;
  if (r.kind === "withdraw") return `${from} withdrew ${eth(r.withdrawal)} ETH to ${r.withdrawalTo}${feeNote}`;
  if (r.kind === "transfer") return r.payments.map((p) => `${from} paid ${eth(p.amount)} ETH to ${who(p.address, p.pubKey)}`).join("; ") + feeNote;
  return `${from} combined notes${feeNote}`;
}

export function toCsv(ledger) {
  const rows = [["block", "tx", "kind", "sender", "recipient", "amount_eth", "fee_eth", "deposit_from", "withdrawal_to"]];
  for (const r of ledger.records) {
    if (!r.readable) { rows.push([r.block, r.tx, "unreadable", "", "", "", "", "", ""]); continue; }
    const sender = who(r.senderAddress, r.sender);
    if (r.kind === "transfer") for (const p of r.payments) rows.push([r.block, r.tx, r.kind, sender, who(p.address, p.pubKey), eth(p.amount), eth(r.fee), "", ""]);
    else rows.push([r.block, r.tx, r.kind, sender, "", eth(r.kind === "deposit" ? r.deposit : r.withdrawal), eth(r.fee), r.depositFrom ?? "", r.withdrawalTo ?? ""]);
  }
  return rows.map((row) => row.join(",")).join("\n") + "\n";
}

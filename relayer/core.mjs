// The relayer's rules, free of any server framework so the same code runs as a
// Node process and as a Cloudflare Pages Function.
//
// What a relayer can and cannot do:
//   - It cannot change anything. Recipient, amounts, fee and payee are bound
//     into the proof; an edited transaction is refused by the contract.
//   - It can refuse to serve. Users can always send the transaction themselves.
//   - It sees the caller's IP address and the (already public) transaction.
import { poolAbi } from "../src/abi.mjs";

const UINT = /^\d{1,78}$/, INT = /^-?\d{1,78}$/, HEX = /^0x([0-9a-fA-F]{2}){0,400}$/, ADDR = /^0x[0-9a-fA-F]{40}$/;
export const MAX_BODY = 24_000;

/** A request the relayer declines; its message is safe to show the caller. */
export class Refused extends Error {}
const need = (ok, why) => { if (!ok) throw new Refused(why); };
const uint = (v, what) => { need(typeof v === "string" && UINT.test(v), `${what} must be a decimal number`); return BigInt(v); };
const list = (v, n, what) => { need(Array.isArray(v) && v.length === n, `${what} must have ${n} values`); return v.map((x, i) => uint(x, `${what}[${i}]`)); };

/** Turns the JSON body into the exact arguments of CellaPool.transact, or throws Refused. */
export function parseRequest(body) {
  need(body && typeof body === "object", "expected a JSON object");
  const { proof: p, ext: e } = body;
  need(p && typeof p === "object" && e && typeof e === "object", "expected { proof, ext }");
  need(Array.isArray(p.b) && p.b.length === 2, "proof.b must have 2 rows");
  const proof = {
    a: list(p.a, 2, "proof.a"), b: [list(p.b[0], 2, "proof.b[0]"), list(p.b[1], 2, "proof.b[1]")], c: list(p.c, 2, "proof.c"),
    root: uint(p.root, "proof.root"), nullifiers: list(p.nullifiers, 2, "proof.nullifiers"),
    commitments: list(p.commitments, 2, "proof.commitments"), auditEphemeral: list(p.auditEphemeral, 2, "proof.auditEphemeral"),
    auditCipher: list(p.auditCipher, 5, "proof.auditCipher"),
  };
  need(typeof e.recipient === "string" && ADDR.test(e.recipient), "ext.recipient must be an address");
  need(typeof e.relayer === "string" && ADDR.test(e.relayer), "ext.relayer must be an address");
  need(typeof e.extAmount === "string" && INT.test(e.extAmount), "ext.extAmount must be a decimal number");
  need(typeof e.note0 === "string" && HEX.test(e.note0) && typeof e.note1 === "string" && HEX.test(e.note1), "ext notes must be hex");
  const ext = { recipient: e.recipient, extAmount: BigInt(e.extAmount), relayer: e.relayer, fee: uint(e.fee, "ext.fee"), note0: e.note0, note1: e.note1 };
  return { proof, ext };
}

/**
 * gasUnits x gas price x margin is the quoted fee. A request is accepted when
 * its fee is at least `tolerance` percent of the current quote.
 * With `wait` off, submit() returns as soon as the transaction is sent.
 */
export function makeRelayer({ publicClient, walletClient, account, pool, chainId, gasUnits = 1_500_000n, marginPercent = 150n,
  tolerancePercent = 90n, wait = true, log = () => {} }) {
  const address = account.address;
  const quote = async () => (await publicClient.getGasPrice()) * gasUnits * marginPercent / 100n;
  const info = async () => ({ address, chainId, pool, fee: (await quote()).toString() });

  /** Everything that can be decided without touching the pool. */
  async function check(body) {
    const { proof, ext } = parseRequest(body);
    need(ext.relayer.toLowerCase() === address.toLowerCase(), "this transaction pays a different relayer");
    need(ext.extAmount <= 0n, "deposits cannot be relayed; they carry ETH from the depositor");
    const wanted = await quote();
    need(ext.fee * 100n >= wanted * tolerancePercent, `fee too low; the current fee is ${wanted} wei`);
    return { proof, ext };
  }

  /** Simulates against the pool, and sends only what the pool would accept. */
  async function submit({ proof, ext }, { nonce } = {}) {
    const call = { address: pool, abi: poolAbi, functionName: "transact", args: [proof, ext], account };
    try { await publicClient.simulateContract({ ...call, gas: 6_000_000n }); }
    catch (err) { throw new Refused("the pool would refuse this transaction: " + (err.shortMessage ?? "simulation failed")); }
    const hash = await walletClient.writeContract({ ...call, gas: 3_000_000n, ...(nonce === undefined ? {} : { nonce }) });
    if (!wait) { log(`sent ${hash} fee ${ext.fee}`); return { hash }; }
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("mined but failed");
    log(`relayed ${hash} fee ${ext.fee}`);
    return { hash, block: receipt.blockNumber.toString() };
  }

  return { address, quote, info, check, submit };
}

// Cella relayer: submits a user's finished transaction and pays its gas, so the
// user's own address never appears on a transfer or withdrawal.
//
// What a relayer can and cannot do:
//   - It cannot change anything. Recipient, amounts, fee and payee are bound
//     into the proof; an edited transaction is refused by the contract.
//   - It can refuse to serve. Users can always send the transaction themselves.
//   - It sees the caller's IP address and the (already public) transaction.
import { createServer } from "node:http";
import { poolAbi } from "../src/abi.mjs";

const UINT = /^\d{1,78}$/, INT = /^-?\d{1,78}$/, HEX = /^0x([0-9a-fA-F]{2}){0,400}$/, ADDR = /^0x[0-9a-fA-F]{40}$/;
const MAX_BODY = 24_000;

class Refused extends Error {}
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
 */
export function createRelayer({ publicClient, walletClient, account, pool, chainId, gasUnits = 1_500_000n, marginPercent = 150n,
  tolerancePercent = 90n, allowOrigin = "*", perMinute = 20, log = () => {} }) {
  const address = account.address;
  let queue = Promise.resolve();
  const hits = new Map();

  const quote = async () => (await publicClient.getGasPrice()) * gasUnits * marginPercent / 100n;

  async function relay(body) {
    const { proof, ext } = parseRequest(body);
    need(ext.relayer.toLowerCase() === address.toLowerCase(), "this transaction pays a different relayer");
    need(ext.extAmount <= 0n, "deposits cannot be relayed; they carry ETH from the depositor");
    const wanted = await quote();
    need(ext.fee * 100n >= wanted * tolerancePercent, `fee too low; the current fee is ${wanted} wei`);

    // One at a time, so nonces never collide and each call is checked against fresh state.
    const run = queue.then(async () => {
      const call = { address: pool, abi: poolAbi, functionName: "transact", args: [proof, ext], account };
      try { await publicClient.simulateContract({ ...call, gas: 6_000_000n }); }
      catch (err) { throw new Refused("the pool would refuse this transaction: " + (err.shortMessage ?? "simulation failed")); }
      const hash = await walletClient.writeContract({ ...call, gas: 3_000_000n });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("mined but failed");
      log(`relayed ${hash} fee ${ext.fee}`);
      return { hash, block: receipt.blockNumber.toString() };
    });
    queue = run.catch(() => {});
    return run;
  }

  function limited(ip) {
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 5000) hits.clear();
    return recent.length > perMinute;
  }

  const server = createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": allowOrigin,
        "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST, OPTIONS", "cache-control": "no-store" });
      res.end(JSON.stringify(obj));
    };
    try {
      if (req.method === "OPTIONS") return send(204, {});
      if (req.method === "GET" && req.url === "/info") {
        return send(200, { address, chainId, pool, fee: (await quote()).toString() });
      }
      if (req.method === "POST" && req.url === "/relay") {
        if (limited(req.socket.remoteAddress ?? "?")) return send(429, { error: "too many requests; try again in a minute" });
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > MAX_BODY) return send(413, { error: "request too large" });
        }
        let body;
        try { body = JSON.parse(raw); } catch { return send(400, { error: "body is not JSON" }); }
        return send(200, await relay(body));
      }
      send(404, { error: "not found" });
    } catch (err) {
      if (err instanceof Refused) return send(400, { error: err.message });
      log("error " + (err.shortMessage ?? err.message));
      send(500, { error: "the relayer could not send this transaction" });
    }
  });

  return { server, address, quote };
}

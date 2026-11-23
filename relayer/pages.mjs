// Cella relayer as Cloudflare Pages Functions, served from the same address as
// the site (/api/relayer/info and /api/relayer/relay).
//
// It reads the pool, chain and RPC from the site's own deployment.json, so the
// only setting is one secret: CELLA_RELAYER_KEY, the gas wallet's private key.
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { makeRelayer, Refused, Unavailable, MAX_BODY } from "./core.mjs";

const json = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: { "content-type": "application/json", "cache-control": "no-store" } });
let cached = null;
const hits = new Map();

async function relayerFor({ env, request }) {
  if (cached) return cached;
  if (!env.CELLA_RELAYER_KEY) throw new Error("CELLA_RELAYER_KEY is not set");
  const d = await (await env.ASSETS.fetch(new URL("/deployment.json", request.url))).json();
  const chain = { id: d.chainId, name: d.chainName, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [d.rpc] } } };
  const account = privateKeyToAccount(env.CELLA_RELAYER_KEY.trim());
  const publicClient = createPublicClient({ chain, transport: http(d.rpc) });
  const core = makeRelayer({ publicClient, walletClient: createWalletClient({ chain, account, transport: http(d.rpc) }),
    account, pool: d.pool, chainId: d.chainId, wait: false });
  cached = { core, publicClient };
  return cached;
}

// Best effort only: each running copy of the function counts on its own.
function limited(ip, perMinute = 20) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 2000) hits.clear();
  return recent.length > perMinute;
}

async function info(context) {
  try { return json(200, await (await relayerFor(context)).core.info()); }
  catch { return json(503, { error: "the relayer is not available" }); }
}

async function relay(context) {
  const { request } = context;
  try {
    if (limited(request.headers.get("cf-connecting-ip") ?? "?")) return json(429, { error: "too many requests; try again in a minute" });
    const raw = await request.text();
    if (raw.length > MAX_BODY) return json(413, { error: "request too large" });
    let body;
    try { body = JSON.parse(raw); } catch { return json(400, { error: "body is not JSON" }); }

    const { core, publicClient } = await relayerFor(context);
    const checked = await core.check(body);
    // No queue is shared between copies of this function, so two requests can pick
    // the same nonce. The loser asks for a fresh one and tries again.
    for (let attempt = 0; ; attempt++) {
      try {
        const nonce = await publicClient.getTransactionCount({ address: core.address, blockTag: "pending" });
        return json(200, await core.submit(checked, { nonce }));
      } catch (err) {
        if (err instanceof Refused || err instanceof Unavailable) throw err;
        if (attempt >= 2 || !/nonce|already known|replacement/i.test(String(err.details ?? err.message))) throw err;
      }
    }
  } catch (err) {
    if (err instanceof Refused) return json(400, { error: err.message });
    if (err instanceof Unavailable) return json(503, { error: err.message });
    return json(500, { error: "the relayer could not send this transaction" });
  }
}

// The site may be hosted on another address (cella.finance) while this function stays here.
// Only the listed origins may call it from a browser; the site's own address needs no entry.
const ALLOWED = ["https://cella.finance", "https://www.cella.finance"];
function withCors(context, response) {
  const origin = context.request.headers.get("origin");
  const allowed = (context.env.CELLA_ALLOW_ORIGINS ? context.env.CELLA_ALLOW_ORIGINS.split(",").map((x) => x.trim()) : ALLOWED);
  const headers = new Headers(response.headers);
  headers.append("vary", "origin");
  if (origin && allowed.includes(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
    headers.set("access-control-allow-headers", "content-type");
    headers.set("access-control-max-age", "86400");
  }
  return new Response(response.body, { status: response.status, headers });
}
export const onInfo = async (context) => withCors(context, await info(context));
export const onRelay = async (context) => withCors(context, await relay(context));
export const onOptions = async (context) => withCors(context, new Response(null, { status: 204 }));

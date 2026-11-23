// Cella relayer as a Node HTTP server. The rules live in core.mjs; this file
// adds the socket, a queue so nonces never collide, and a per-address limit.
import { createServer } from "node:http";
import { makeRelayer, parseRequest, Refused, MAX_BODY } from "./core.mjs";

export { parseRequest };

export function createRelayer({ allowOrigin = "*", perMinute = 20, log = () => {}, ...options }) {
  const core = makeRelayer({ ...options, log });
  let queue = Promise.resolve();
  const hits = new Map();

  async function relay(body) {
    const request = await core.check(body);
    // One at a time: each call is checked against fresh state and gets the next nonce.
    const run = queue.then(() => core.submit(request));
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
      if (req.method === "GET" && req.url === "/info") return send(200, await core.info());
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

  return { server, address: core.address, quote: core.quote };
}

// Security headers for the hosted site (Cloudflare Pages `_headers` format).
// The policy allows only this site's own scripts, the WebAssembly the prover
// needs, and network calls to the listed origins (the chain's RPC).
export function headersFile(connectOrigins = []) {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    `connect-src 'self' ${connectOrigins.join(" ")}`.trim(),
    "img-src 'self' data: https:",
    "style-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  return `/*
  Content-Security-Policy: ${csp}
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
`;
}

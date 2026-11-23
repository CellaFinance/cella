// Security headers for the hosted site (Cloudflare Pages `_headers` format).
// The policy allows only this site's own scripts, the WebAssembly the prover
// needs, and network calls to the listed origins (the chain's RPC).
export function cspFor(connectOrigins = []) {
  return [
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
}

export function headersFile(connectOrigins = []) {
  const csp = cspFor(connectOrigins);
  return `/*
  Content-Security-Policy: ${csp}
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()

# The proving key may be fetched by the site at cella.finance.
/prover/*
  Access-Control-Allow-Origin: https://cella.finance
  Cache-Control: public, max-age=604800
`;
}

// The same policy for a host that reads .htaccess (Apache or LiteSpeed, as on Hostinger).
export function htaccessFile(connectOrigins = []) {
  return `# Cella: security headers, file types and caching.
<IfModule mod_headers.c>
  Header always set Content-Security-Policy "${cspFor(connectOrigins)}"
  Header always set X-Content-Type-Options "nosniff"
  Header always set X-Frame-Options "DENY"
  Header always set Referrer-Policy "no-referrer"
  Header always set Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=()"
  <FilesMatch "\\.(wasm|zkey)$">
    Header set Cache-Control "public, max-age=604800"
  </FilesMatch>
  <FilesMatch "deployment\\.json$">
    Header set Cache-Control "no-store"
  </FilesMatch>
</IfModule>
<IfModule mod_mime.c>
  AddType application/wasm .wasm
  AddType application/octet-stream .zkey
</IfModule>
<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/css application/javascript application/json image/svg+xml
</IfModule>
DirectoryIndex index.html
Options -Indexes
`;
}

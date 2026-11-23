// Builds the documentation pages from docs/*.md into build/web/docs/.
//   node scripts/build-docs.mjs     (run after the site itself is built)
// Every page is static HTML that loads only /docs.css and the site's own font.
import { marked } from "marked";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/local.mjs";

const PAGES = [
  ["getting-started", "Getting started"],
  ["how-it-works", "How it works"],
  ["security", "Security"],
  ["ceremony", "Proving key ceremony"],
  ["deployments", "Deployments"],
  ["relayer", "Running a relayer"],
  ["auditor", "For auditors"],
];
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const slugs = new Set(PAGES.map(([s]) => s));
// Links between the markdown files become links between the pages.
const fix = (html) => html.replace(/href="(?:\.\/|\.\.\/docs\/)?([a-z-]+)\.md(#[^"]*)?"/g, (m, s, h) => slugs.has(s) ? `href="/docs/${s}/${h ?? ""}"` : m);

const shell = (title, body, current) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Cella docs</title>
<meta name="description" content="Documentation for Cella, private payments for ETH on Robinhood Chain.">
<link rel="icon" href="/brand/icon-64.png">
<link rel="stylesheet" href="/docs.css">
</head>
<body>
<header class="top"><div class="bar">
  <a class="brand" href="/"><img src="/brand/mark.svg" alt="" width="24" height="24"><span class="wordmark">CELLA</span></a>
  <nav><a href="/docs/">Docs</a><a href="https://x.com/cellafinance" rel="noopener">X</a><a class="launch" href="/app/">Enter Cella</a></nav>
</div></header>
<div class="layout">
<aside class="side"><p class="side-title">Documentation</p>
<ul>${PAGES.map(([s, t]) => `<li><a href="/docs/${s}/"${s === current ? ' aria-current="page"' : ""}>${esc(t)}</a></li>`).join("")}</ul></aside>
<main class="doc">${body}</main>
</div>
<footer class="foot"><span>Cella is a beta and has not been audited by an outside firm. Not affiliated with Robinhood.</span></footer>
</body>
</html>
`;

const out = join(ROOT, "build/web/docs");
mkdirSync(out, { recursive: true });
for (const [slug, title] of PAGES) {
  mkdirSync(join(out, slug), { recursive: true });
  const md = readFileSync(join(ROOT, "docs", slug + ".md"), "utf8");
  writeFileSync(join(out, slug, "index.html"), shell(title, fix(marked.parse(md)), slug));
}
const index = `<h1>Documentation</h1>
<p class="lead">Cella is a shielded pool for ETH on Robinhood Chain: deposit in public, send and hold in private, withdraw when you like. These pages explain how it works and what it does and does not promise.</p>
<ul class="cards">${PAGES.map(([s, t]) => `<li><a href="/docs/${s}/"><span>${esc(t)}</span></a></li>`).join("")}</ul>`;
writeFileSync(join(out, "index.html"), shell("Documentation", index, null));
console.log(`docs: ${PAGES.length + 1} pages in build/web/docs`);

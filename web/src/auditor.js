// Auditor page: opens the sealed copies with a key typed into this page.
import { createPublicClient, http } from "viem";
import { readLedger, describe, formatEth, who } from "../../auditor/ledger.mjs";

const $ = (id) => document.getElementById(id);
const isLocalHost = ["localhost", "127.0.0.1"].includes(location.hostname);
let deployment, publicClient;

function row(label, value, cls = "") {
  const d = document.createElement("div");
  d.append(Object.assign(document.createElement("span"), { textContent: label }),
    Object.assign(document.createElement("span"), { textContent: value, className: cls }));
  return d;
}
function status(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}

async function read() {
  const raw = $("secret").value.trim();
  if (!/^\d{1,78}$/.test(raw)) return status("Enter the secret number from your auditor key file.", true);
  $("read").disabled = true;
  status("Reading the pool…");
  try {
    const ledger = await readLedger({ publicClient, pool: deployment.pool, registry: deployment.registry, fromBlock: deployment.fromBlock, secret: BigInt(raw) });
    const readable = ledger.records.length - ledger.unreadable;

    $("verdict").textContent = readable === 0 ? "This key opens nothing." :
      ledger.reconciled === true ? "Every balance is accounted for." :
      ledger.reconciled === false ? "The balances do not add up." : "Part of the record is sealed to another key.";
    $("summary").textContent = `${ledger.records.length} transactions in this pool. This key opens ${readable} of them.`;
    $("totals").replaceChildren(
      row("Sum of the balances this key can see", `${formatEth(ledger.total)} ETH`),
      row("ETH held by the pool", `${formatEth(ledger.totalHeld)} ETH`),
    );
    $("holders").replaceChildren(...(ledger.holders.length ? ledger.holders.map((h) => row(who(h.address, h.pubKey), `${formatEth(h.balance)} ETH`))
      : [row("Nothing", "No balance can be read with this key.")]));
    $("holders").querySelectorAll(":scope > div > :first-child").forEach((el) => el.classList.add("mono"));
    $("records").replaceChildren(...[...ledger.records].reverse().map((r) => row(`Block ${r.block}`, describe(r), r.readable ? "" : "muted")));
    for (const id of ["resultBlock", "holdersBlock", "recordsBlock"]) $(id).hidden = false;
    status("");
  } catch (e) {
    console.error(e);
    status(e.shortMessage || e.message || String(e), true);
  } finally {
    $("read").disabled = false;
  }
}

async function start() {
  deployment = await (await fetch("/deployment.json", { cache: "no-store" })).json();
  publicClient = createPublicClient({ transport: http(deployment.rpc) });
  if (deployment.dev) {
    $("banner").hidden = false;
    $("banner").textContent = "Local test copy of Robinhood Chain. No real funds are involved.";
    if (deployment.devAuditorSecret && isLocalHost) {
      $("useTest").hidden = false;
      $("useTest").addEventListener("click", () => { $("secret").value = deployment.devAuditorSecret; read(); });
    }
  }
  $("form").addEventListener("submit", (e) => { e.preventDefault(); read(); });
  document.querySelector("main").classList.add("rise");
}
start().catch((e) => status("Cella could not reach its contracts. " + (e.message || e), true));

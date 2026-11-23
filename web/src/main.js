// Cella web app. Everything private happens in this page: keys are derived from
// a wallet signature, notes are read from the chain, proofs are made here.
import { createPublicClient, createWalletClient, http, custom, parseEther, formatEther, isAddress, getAddress, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as snarkjs from "snarkjs";
import { deriveKeys } from "../../src/keys.mjs";
import { CellaClient } from "../../src/client.mjs";
import { poolAbi } from "../../src/abi.mjs";

const $ = (id) => document.getElementById(id);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const eth = (wei, places = 6) => {
  const [whole, frac = ""] = formatEther(wei).split(".");
  const cut = frac.slice(0, places).replace(/0+$/, "");
  return cut ? `${whole}.${cut}` : whole;
};
const isLocalHost = ["localhost", "127.0.0.1"].includes(location.hostname);

const TABS = {
  deposit: {
    button: "Deposit",
    hint: (r) => `Up to ${eth(r.maxDeposit)} ETH per deposit while Cella is in beta.`,
    seesPublic: ["Your wallet address", "The amount", "That it went into Cella"],
    seesPrivate: ["Which note inside is yours", "Everything you do with it afterwards"],
  },
  send: {
    button: "Send privately",
    to: "To (an address that has opened a Cella balance)",
    hint: (r) => r.relayFee ? `A relayer sends it for you, so your wallet stays off the transaction. Its fee, about ${eth(r.relayFee)} ETH, comes from your private balance.`
      : "No relayer is reachable, so your own wallet will send this and its address will be visible.",
    seesPublic: (r) => ["That a Cella transaction happened", r.relayFee ? "A relayer's address, not yours" : "Your wallet, as the sender of the transaction"],
    seesPrivate: ["Who received it", "How much", "What you have left"],
  },
  withdraw: {
    button: "Withdraw",
    to: "To (any address)",
    hint: (r) => "Leave the address empty to withdraw to your own wallet." + (r.relayFee ? ` Relayer fee: about ${eth(r.relayFee)} ETH from your private balance.` : ""),
    seesPublic: ["The receiving address", "The amount"],
    seesPrivate: ["Which deposit the money came from", "What you have left"],
  },
};

const state = { tab: "deposit", busy: false, deployment: null, pub: null, wallet: null, account: null, address: null, client: null, rules: null };

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}
function fail(e) {
  console.error(e);
  setStatus(e.shortMessage || e.message || String(e), true);
}
function list(el, items) {
  el.replaceChildren(...items.map((t) => Object.assign(document.createElement("li"), { textContent: t })));
}
function row(label, value, cls = "") {
  const d = document.createElement("div");
  d.append(Object.assign(document.createElement("span"), { textContent: label }),
    Object.assign(document.createElement("span"), { textContent: value, className: cls }));
  return d;
}

function renderTab() {
  const t = TABS[state.tab];
  for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === state.tab));
  $("submit").textContent = t.button;
  $("toField").hidden = !t.to;
  if (t.to) $("toLabel").textContent = t.to;
  $("hint").textContent = state.rules ? t.hint(state.rules) : "";
  list($("seesPublic"), typeof t.seesPublic === "function" ? t.seesPublic(state.rules ?? {}) : t.seesPublic);
  list($("seesPrivate"), t.seesPrivate);
  setStatus("");
}

async function loadRules() {
  const c = { address: state.deployment.pool, abi: (await import("../../src/abi.mjs")).poolAbi };
  const read = (functionName) => state.pub.readContract({ ...c, functionName });
  const [auditorKey, maxDeposit, poolCap, totalHeld, depositsPaused, owner, delay] = await Promise.all(
    ["auditorKey", "maxDeposit", "poolCap", "totalHeld", "depositsPaused", "owner", "AUDITOR_DELAY"].map(read));
  let relayFee = null;
  if (state.deployment.relayer) {
    try { relayFee = BigInt((await (await fetch(state.deployment.relayer + "/info")).json()).fee); } catch { /* shown as unreachable */ }
  }
  state.rules = { auditorKey, maxDeposit, poolCap, totalHeld, depositsPaused, owner, delay, relayFee };
  $("rules").replaceChildren(
    row("Your money", "Only a proof made with your wallet's key can move it. No operator, owner or auditor can."),
    row("Auditor", `Can read every transfer; cannot move funds. Key ${short(toHex(auditorKey[0], { size: 32 }))}. Changing it takes ${Number(delay) / 86400} days and is announced on chain.`),
    row("Owner", `Can pause new deposits and change deposit limits. Cannot pause transfers or withdrawals, and cannot upgrade the contract. ${short(owner)}`),
    row("Relayer", relayFee ? "Sends transfers and withdrawals for you and pays their gas. It cannot change them; it can only decline, and then you send them yourself." : "None reachable right now. Transfers and withdrawals go out from your own wallet."),
    row("Deposits", depositsPaused ? "Paused. Transfers and withdrawals still work." : `Open. Up to ${eth(maxDeposit)} ETH each, ${eth(poolCap)} ETH in total.`),
    row("Held in the pool", `${eth(totalHeld)} ETH`),
    row("Pool contract", state.deployment.pool, "mono"),
  );
  $("hint").textContent = TABS[state.tab].hint(state.rules);
  const t = TABS[state.tab];
  list($("seesPublic"), typeof t.seesPublic === "function" ? t.seesPublic(state.rules) : t.seesPublic);
}

async function render() {
  const { client, address } = state;
  $("walletLabel").textContent = address ? short(address) : "";
  $("connect").hidden = !!address;
  $("devWallet").hidden = !!address || !(state.deployment?.dev && isLocalHost);
  if (!address) return;

  const walletBalance = await state.pub.getBalance({ address });
  $("walletBalanceLine").textContent = `In your wallet: ${eth(walletBalance)} ETH`;
  // A payment this wallet could not accept when it was sent waits in the pool for it.
  const owed = await state.pub.readContract({ address: state.deployment.pool, abi: poolAbi, functionName: "owed", args: [address] }).catch(() => 0n);
  state.owed = owed;
  $("heldLine").hidden = owed === 0n;
  $("heldText").textContent = `${eth(owed)} ETH from Cella is waiting for this wallet.`;
  $("unlock").hidden = !!client;
  $("unlockHint").hidden = !!client;
  $("actions").hidden = !client;
  $("notesBlock").hidden = !client;
  if (!client) { $("privateBalance").textContent = "—"; return; }

  $("privateBalance").textContent = eth(client.balance);
  const open = client.unspent.length;
  $("syncLine").textContent = `${open} unspent ${open === 1 ? "note" : "notes"} · read up to block ${client.cursor - 1n}`;
  const rows = [...client.notes].reverse().map((n) => {
    const spent = client.spent.has(n.nullifier);
    return row(`Block ${n.block}`, `${eth(n.note.amount)} ETH${spent ? " · spent" : ""}`, spent ? "spent" : "");
  });
  $("notes").replaceChildren(...(rows.length ? rows : [row("Nothing yet", "Deposit, or ask someone to send to your address.")]));
}

// ---------------- wallets ----------------

// Wallets announce themselves (EIP-6963). Older ones only set a global.
const TRUST = { rdns: "com.trustwallet.app", name: "Trust Wallet", install: "https://trustwallet.com/browser-extension" };
const announced = new Map();
addEventListener("eip6963:announceProvider", (e) => { if (e.detail?.info?.rdns) announced.set(e.detail.info.rdns, e.detail); });
dispatchEvent(new Event("eip6963:requestProvider"));

function walletChoices() {
  dispatchEvent(new Event("eip6963:requestProvider"));
  const list = [...announced.values()].map(({ info, provider }) => ({ name: info.name, icon: info.icon, rdns: info.rdns, provider }));
  const has = (rdns) => list.some((w) => w.rdns === rdns);
  const legacyTrust = window.trustwallet?.ethereum ?? window.trustwallet ?? (window.ethereum?.isTrust ? window.ethereum : null);
  if (!has(TRUST.rdns) && legacyTrust?.request) list.push({ name: TRUST.name, icon: null, rdns: TRUST.rdns, provider: legacyTrust });
  if (!list.length && window.ethereum?.request) list.push({ name: "Browser wallet", icon: null, rdns: "injected", provider: window.ethereum });
  // Trust Wallet first, the rest by name.
  return list.sort((x, y) => (x.rdns === TRUST.rdns ? -1 : y.rdns === TRUST.rdns ? 1 : x.name.localeCompare(y.name)));
}

function showWalletList() {
  const choices = walletChoices();
  const rows = choices.map((w) => {
    const b = Object.assign(document.createElement("button"), { type: "button", className: "wallet-option" });
    if (w.icon) b.append(Object.assign(document.createElement("img"), { src: w.icon, alt: "" }));
    b.append(Object.assign(document.createElement("span"), { textContent: w.name }));
    b.addEventListener("click", () => guarded(() => connectInjected(w.provider)));
    return b;
  });
  if (!choices.some((w) => w.rdns === TRUST.rdns)) {
    const a = Object.assign(document.createElement("a"), { className: "wallet-option", href: TRUST.install, target: "_blank", rel: "noopener" });
    a.append(Object.assign(document.createElement("span"), { textContent: TRUST.name }),
      Object.assign(document.createElement("span"), { textContent: "Not installed in this browser · Get the extension", className: "muted" }));
    rows.unshift(a);
  }
  $("walletOptions").replaceChildren(...rows);
  $("walletNote").textContent = choices.length ? "" : "No wallet extension was found in this browser. Install one, then reload this page.";
  $("walletList").hidden = false;
}

async function connectInjected(provider) {
  const d = state.deployment;
  const wallet = createWalletClient({ chain: d.chain, transport: custom(provider) });
  const [address] = await wallet.requestAddresses();
  try { await wallet.switchChain({ id: d.chainId }); }
  catch (e) { if (e.code === 4001) throw e; await wallet.addChain({ chain: d.chain }); }
  if ((await wallet.getChainId()) !== d.chainId) throw new Error(`Switch your wallet to ${d.chainName} and connect again.`);
  Object.assign(state, { wallet, account: getAddress(address), address: getAddress(address), client: null });
  $("walletList").hidden = true;
  // A different account or network means different keys: start clean.
  provider.on?.("accountsChanged", () => location.reload());
  provider.on?.("chainChanged", () => location.reload());
}

/** Local test copy only: a throwaway key made in this tab and funded by the dev chain. */
async function connectDev() {
  let key = sessionStorage.getItem("cella-dev-key");
  const isNew = !key;
  if (isNew) { key = generatePrivateKey(); sessionStorage.setItem("cella-dev-key", key); }
  const account = privateKeyToAccount(key);
  const d = state.deployment;
  // Fund without reading first: a long-running fork can no longer look up an address it has never seen.
  let low = isNew;
  if (!low) { try { low = (await state.pub.getBalance({ address: account.address })) < parseEther("0.5"); } catch { low = true; } }
  if (low) await state.pub.request({ method: "anvil_setBalance", params: [account.address, toHex(parseEther("2"))] });
  Object.assign(state, { wallet: createWalletClient({ chain: d.chain, transport: http(d.rpc) }), account, address: account.address, client: null });
}

async function unlock() {
  const d = state.deployment;
  const sign = (message) => state.wallet.signMessage({ account: state.account, message });
  const probe = new CellaClient({ publicClient: state.pub, walletClient: state.wallet, account: state.account, deployment: d, keys: null, prove: null });
  const known = await probe.lookup(state.address);

  setUnlockText("Waiting for your signature…");
  const keys = await deriveKeys(sign, d.chainId, { verify: !known });
  if (known && known.pubKey !== keys.pubKey) {
    throw new Error("This wallet gave a different signature than last time, so your earlier private balance cannot be opened with it.");
  }
  const client = new CellaClient({ publicClient: state.pub, walletClient: state.wallet, account: state.account, deployment: d, keys, relayerUrl: d.relayer ?? null,
    prove: (signals) => snarkjs.groth16.fullProve(signals, "/prover/transact.wasm", "/prover/transact.zkey") });
  client.onStatus = (s) => setStatus({ proving: "Making the proof on this device…", sending: "Sending to Robinhood Chain…", relaying: "Handing it to the relayer…", merging: "Combining your notes first…", done: "" }[s] ?? "");

  if (!known) { setUnlockText("Publishing your Cella address…"); await client.register(); }
  setUnlockText("Reading your notes from the chain…");
  await client.sync();
  state.client = client;
}
function setUnlockText(t) { $("syncLine").textContent = t; }

// ---------------- actions ----------------

async function submit() {
  const { client, tab } = state;
  let amount;
  try { amount = parseEther($("amount").value.trim().replace(",", ".")); } catch { amount = 0n; }
  if (amount <= 0n) return setStatus("Enter an amount.", true);

  let to = $("to").value.trim();
  if (tab === "withdraw" && !to) to = state.address;
  if (tab !== "deposit" && !isAddress(to)) return setStatus("Enter a valid address.", true);

  if (tab !== "deposit") {
    if (client.balance === 0n) return setStatus("Your private balance is empty. Open the Deposit tab first to move ETH from your wallet into Cella.", true);
    const fee = state.rules.relayFee ?? 0n;
    if (amount + fee > client.balance) {
      const most = client.balance > fee ? client.balance - fee : 0n;
      return setStatus(`You can ${tab === "send" ? "send" : "withdraw"} at most ${eth(most)} ETH: your private balance is ${eth(client.balance)} ETH${fee ? ` and the relayer fee is about ${eth(fee)} ETH` : ""}.`, true);
    }
  }
  if (tab === "deposit") {
    if (amount > state.rules.maxDeposit) return setStatus(`The limit is ${eth(state.rules.maxDeposit)} ETH per deposit.`, true);
    await client.deposit(amount);
    setStatus(`Deposited ${eth(amount)} ETH.`);
  } else if (tab === "send") {
    await client.transfer(getAddress(to), amount);
    setStatus(`Sent ${eth(amount)} ETH privately to ${short(to)}.`);
  } else {
    const receipt = await client.withdraw(getAddress(to), amount);
    const held = CellaClient.heldIn(receipt).some((h) => getAddress(h.to) === getAddress(to));
    setStatus(held ? `${short(to)} did not accept the ETH, so ${eth(amount)} ETH is waiting in Cella for that address to collect. It has left your private balance.`
      : `Withdrew ${eth(amount)} ETH to ${short(to)}.`);
  }
  $("amount").value = "";
}

/** Works before the private balance is opened: collecting needs the wallet only. */
async function collect() {
  const amount = state.owed ?? 0n;
  const call = { address: state.deployment.pool, abi: poolAbi, functionName: "claim", args: [], account: state.account };
  await state.pub.simulateContract({ ...call, gas: 1_000_000n });
  const hash = await state.wallet.writeContract({ ...call, gas: 300_000n });
  const receipt = await state.pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("The transaction was mined but failed.");
  $("syncLine").textContent = `Collected ${eth(amount)} ETH into your wallet.`;
}

async function guarded(fn, { button } = {}) {
  if (state.busy) return;
  state.busy = true;
  for (const b of document.querySelectorAll("button")) b.disabled = true;
  try { await fn(); }
  catch (e) { fail(e); if (!state.client) setUnlockText(e.shortMessage || e.message || String(e)); if (!state.address) $("walletNote").textContent = e.shortMessage || e.message || String(e); }
  finally {
    state.busy = false;
    for (const b of document.querySelectorAll("button")) b.disabled = false;
    await render().catch(console.error);
    await loadRules().then(() => {}, console.error);
  }
}

// ---------------- start ----------------

async function start() {
  const d = await (await fetch("/deployment.json", { cache: "no-store" })).json();
  d.chain = { id: d.chainId, name: d.chainName, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [d.rpc] } }, blockExplorers: d.explorer ? { default: { name: "Explorer", url: d.explorer } } : undefined };
  state.deployment = d;
  state.pub = createPublicClient({ chain: d.chain, transport: http(d.rpc) });
  $("banner").hidden = false;
  $("banner").textContent = d.dev ? "Local test copy of Robinhood Chain, with a test proving key. No real funds are involved."
    : d.testKey ? `${d.chainName}. Test network and test proving key: use test ETH only.`
    : `${d.chainName}. Beta, not yet audited by an outside firm. Deposit only what you could afford to lose.`;

  for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => { state.tab = b.dataset.tab; renderTab(); });
  $("connect").addEventListener("click", showWalletList);
  $("devWallet").addEventListener("click", () => guarded(connectDev));
  $("unlock").addEventListener("click", () => guarded(unlock));
  $("collect").addEventListener("click", () => guarded(collect));
  $("form").addEventListener("submit", (e) => { e.preventDefault(); guarded(submit); });

  document.querySelector("main").classList.add("rise");
  await loadRules();
  renderTab();
  await render();
}

start().catch((e) => {
  console.error(e);
  $("walletBalanceLine").textContent = "Cella could not reach its contracts. " + (e.message || e);
});

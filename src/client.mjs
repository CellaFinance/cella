// The Cella client: reads the pool's events, finds the notes that belong to one
// set of keys, and builds deposits, private transfers and withdrawals.
// It keeps nothing on a server; everything is rebuilt from the chain.
import { encodeAbiParameters, keccak256, zeroAddress } from "viem";
import * as C from "./cella.mjs";
import { encryptNote, decryptNote } from "./notes.mjs";
import { poolAbi, registryAbi } from "./abi.mjs";

const EXT_TYPES = [{ type: "address" }, { type: "int256" }, { type: "address" }, { type: "uint256" },
  { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }];

/** Must match CellaPool.extDataHash. */
export function hashExt(ext, pool, chainId) {
  const enc = encodeAbiParameters(EXT_TYPES, [ext.recipient, ext.extAmount, ext.relayer, ext.fee,
    keccak256(ext.note0), keccak256(ext.note1), BigInt(chainId), pool]);
  return BigInt(keccak256(enc)) % C.P;
}

/** snarkjs proof -> the layout the Solidity verifier expects. */
export function proofToSolidity(proof) {
  const b = (x) => BigInt(x);
  return {
    a: [b(proof.pi_a[0]), b(proof.pi_a[1])],
    b: [[b(proof.pi_b[0][1]), b(proof.pi_b[0][0])], [b(proof.pi_b[1][1]), b(proof.pi_b[1][0])]],
    c: [b(proof.pi_c[0]), b(proof.pi_c[1])],
  };
}

export class CellaClient {
  /**
   * deployment: { chainId, pool, registry, fromBlock }
   * keys:       from deriveKeys()
   * prove:      async (signals) => { proof, publicSignals }
   * relayerUrl: optional; transfers and withdrawals then go through it, so this
   *             wallet's address stays off them. Deposits are always sent directly.
   */
  constructor({ publicClient, walletClient, account, deployment, keys, prove, relayerUrl = null, logChunk = 20000n }) {
    Object.assign(this, { publicClient, walletClient, account, deployment, keys, prove, relayerUrl, logChunk });
    this.address = typeof account === "string" ? account : account.address;
    this.tree = new C.Tree();
    this.notes = [];
    this.spent = new Set();
    this.cursor = BigInt(deployment.fromBlock);
    this.onStatus = () => {};
  }

  // ---------------- reading ----------------

  /** Brings the local tree and note list up to the latest block. */
  async sync() {
    // No cache: a sync right after our own transaction must see its block.
    const latest = await this.publicClient.getBlockNumber({ cacheTime: 0 });
    for (let from = this.cursor; from <= latest; from += this.logChunk) {
      const to = from + this.logChunk - 1n < latest ? from + this.logChunk - 1n : latest;
      const range = { address: this.deployment.pool, abi: poolAbi, fromBlock: from, toBlock: to };
      const [added, nulled] = await Promise.all([
        this.publicClient.getContractEvents({ ...range, eventName: "NewCommitment" }),
        this.publicClient.getContractEvents({ ...range, eventName: "NewNullifier" }),
      ]);
      added.sort((x, y) => x.args.index - y.args.index);
      for (const log of added) {
        const { commitment, index, note } = log.args;
        if (index !== this.tree.size) throw new Error(`commitment ${index} arrived out of order`);
        this.tree.insert(commitment);
        const mine = await decryptNote(note, this.keys.encPriv);
        if (!mine || mine.amount === 0n) continue;
        const full = { amount: mine.amount, pubKey: this.keys.pubKey, blinding: mine.blinding };
        // A sender can seal anything; only a note that matches its commitment is money.
        if (C.commitmentOf(full) !== commitment) continue;
        this.notes.push({ note: full, index, nullifier: C.nullifierOf(commitment, index, this.keys.privKey), block: log.blockNumber });
      }
      for (const log of nulled) this.spent.add(log.args.nullifier);
    }
    this.cursor = latest + 1n;
    return this.balance;
  }

  get unspent() { return this.notes.filter((n) => !this.spent.has(n.nullifier)); }
  get balance() { return this.unspent.reduce((s, n) => s + n.note.amount, 0n); }

  readPool(functionName, args = []) {
    return this.publicClient.readContract({ address: this.deployment.pool, abi: poolAbi, functionName, args });
  }
  async lookup(address) {
    const [pubKey, encKey] = await this.publicClient.readContract({ address: this.deployment.registry, abi: registryAbi, functionName: "entries", args: [address] });
    return pubKey === 0n ? null : { pubKey, encKey };
  }

  // ---------------- writing ----------------

  async _send(address, abi, functionName, args, value = 0n) {
    const call = { address, abi, functionName, args, account: this.account, value };
    await this.publicClient.simulateContract({ ...call, gas: 6_000_000n });
    const hash = await this.walletClient.writeContract({ ...call, gas: 3_000_000n });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("The transaction was mined but failed.");
    return receipt;
  }

  /** Publishes this wallet's Cella keys so others can pay it by address. */
  async register() {
    const mine = await this.lookup(this.address);
    if (mine && mine.pubKey === this.keys.pubKey && mine.encKey === this.keys.encKey) return null;
    return this._send(this.deployment.registry, registryAbi, "register", [this.keys.pubKey, this.keys.encKey]);
  }

  // ---------------- relayer ----------------

  /** { address, fee } from the relayer, or null when none is set or it cannot be reached. */
  async quote() {
    if (!this.relayerUrl) return null;
    try {
      const r = await fetch(this.relayerUrl + "/info");
      const info = await r.json();
      if (!r.ok || info.chainId !== this.deployment.chainId || info.pool.toLowerCase() !== this.deployment.pool.toLowerCase()) return null;
      return { address: info.address, fee: BigInt(info.fee) };
    } catch {
      return null;
    }
  }
  async _relay(p, ext) {
    const r = await fetch(this.relayerUrl + "/relay", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ proof: p, ext }, (_, v) => (typeof v === "bigint" ? v.toString() : v)) });
    const out = await r.json();
    if (!r.ok) throw new Error("The relayer refused: " + (out.error ?? r.status));
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: out.hash });
    if (receipt.status !== "success") throw new Error("The transaction was mined but failed.");
    return receipt;
  }

  async _transact({ inputs, outputs, extAmount = 0n, recipient = zeroAddress, relay = null }) {
    const self = { pubKey: this.keys.pubKey, encKey: this.keys.encKey };
    const outs = [...outputs];
    while (outs.length < 2) outs.push({ amount: 0n, ...self });
    const notes = outs.map((o) => C.newNote(o.amount, o.pubKey));
    const [note0, note1] = await Promise.all(notes.map((n, i) => encryptNote(n, outs[i].encKey)));
    const ext = { recipient, extAmount, relayer: relay?.address ?? zeroAddress, fee: relay?.fee ?? 0n, note0, note1 };

    const auditorPubKey = [...(await this.readPool("auditorKey"))];
    const built = C.buildTransaction({ tree: this.tree, privKey: this.keys.privKey, inputs, outputs: notes,
      publicAmount: extAmount - ext.fee, extDataHash: hashExt(ext, this.deployment.pool, this.deployment.chainId), auditorPubKey });

    this.onStatus("proving");
    const { proof } = await this.prove(built.signals);
    const s = built.signals;
    const p = { ...proofToSolidity(proof), root: s.root, nullifiers: s.inputNullifier, commitments: s.outputCommitment,
      auditEphemeral: s.auditEphemeral, auditCipher: s.auditCipher };

    this.onStatus(relay ? "relaying" : "sending");
    const receipt = relay ? await this._relay(p, ext)
      : await this._send(this.deployment.pool, poolAbi, "transact", [p, ext], extAmount > 0n ? extAmount : 0n);
    await this.sync();
    this.onStatus("done");
    return receipt;
  }

  /** One or two notes covering `amount` plus the relayer fee; merges notes first when two are not enough. */
  async _inputsFor(amount, relay) {
    const fee = relay?.fee ?? 0n;
    await this.sync();
    for (;;) {
      const sorted = this.unspent.sort((a, b) => (a.note.amount < b.note.amount ? 1 : -1));
      if (this.balance < amount + fee) {
        throw new Error(fee ? "Your private balance is too small for this amount plus the relayer fee." : "Your private balance is too small for this.");
      }
      if (sorted[0].note.amount >= amount + fee) return [sorted[0]];
      if (sorted[0].note.amount + sorted[1].note.amount >= amount + fee) return [sorted[0], sorted[1]];
      // Each merge is a transaction of its own and pays its own fee.
      this.onStatus("merging");
      const merged = sorted[0].note.amount + sorted[1].note.amount - fee;
      await this._transact({ inputs: [sorted[0], sorted[1]], outputs: [{ amount: merged, pubKey: this.keys.pubKey, encKey: this.keys.encKey }], relay });
    }
  }
  _change(inputs, amount, relay) {
    const left = inputs.reduce((s, n) => s + n.note.amount, 0n) - amount - (relay?.fee ?? 0n);
    return { amount: left, pubKey: this.keys.pubKey, encKey: this.keys.encKey };
  }

  async deposit(amount) {
    await this.sync();
    return this._transact({ inputs: [], outputs: [{ amount, pubKey: this.keys.pubKey, encKey: this.keys.encKey }], extAmount: amount });
  }

  /** Private payment to a registered address. Nothing about it is readable on chain. */
  async transfer(to, amount) {
    if (amount <= 0n) throw new Error("Enter an amount above zero.");
    const them = await this.lookup(to);
    if (!them) throw new Error("That address has not opened a Cella balance yet, so it cannot be paid privately.");
    const relay = await this.quote();
    const inputs = await this._inputsFor(amount, relay);
    return this._transact({ inputs, outputs: [{ amount, ...them }, this._change(inputs, amount, relay)], relay });
  }

  async withdraw(recipient, amount) {
    if (amount <= 0n) throw new Error("Enter an amount above zero.");
    const relay = await this.quote();
    const inputs = await this._inputsFor(amount, relay);
    return this._transact({ inputs, outputs: [this._change(inputs, amount, relay)], extAmount: -amount, recipient, relay });
  }
}

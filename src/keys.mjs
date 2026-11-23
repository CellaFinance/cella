// A Cella identity is derived from one wallet signature, so there is nothing
// extra to back up: the same wallet always gives the same private balance.
import { keccak256, concat, stringToHex, hexToBytes, toHex } from "viem";
import { x25519 } from "@noble/curves/ed25519.js";
import { P, pubKeyOf } from "./cella.mjs";

export const keyMessage = (chainId) =>
  "Cella private balance key\n\n" +
  "Sign this only on a Cella site you trust. Whoever holds this signature can read and spend your private balance.\n\n" +
  `Chain: ${chainId}\nVersion: 1`;

/**
 * sign(message) must return the wallet's signature as 0x hex.
 * With `verify`, the wallet is asked twice and must answer the same both times;
 * a wallet that does not could never find its balance again.
 */
export async function deriveKeys(sign, chainId, { verify = false } = {}) {
  const message = keyMessage(chainId);
  const signature = await sign(message);
  if (verify && (await sign(message)) !== signature) {
    throw new Error("This wallet signs the same message differently each time, so it cannot be used with Cella.");
  }
  const seed = keccak256(signature);
  const privKey = BigInt(keccak256(concat([seed, stringToHex("cella/spend")]))) % P;
  const encPriv = hexToBytes(keccak256(concat([seed, stringToHex("cella/view")])));
  return { privKey, pubKey: pubKeyOf(privKey), encPriv, encKey: toHex(x25519.getPublicKey(encPriv)) };
}

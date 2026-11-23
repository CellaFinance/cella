// Makes a new wallet key for running Cella (deployer or relayer gas wallet).
//   node scripts/new-key.mjs deployer
//   node scripts/new-key.mjs relayer
// The key is saved outside the repository, readable only by you, and is never
// printed. Only the address is shown.
import { writeFileSync, existsSync, mkdirSync, chmodSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const name = process.argv[2];
if (!/^[a-z][a-z0-9-]{1,30}$/.test(name ?? "")) { console.error("usage: node scripts/new-key.mjs <name>"); process.exit(1); }
const dir = join(homedir(), ".config/cella");
const file = join(dir, `${name}.key`);
mkdirSync(dir, { recursive: true, mode: 0o700 });
if (existsSync(file)) {
  console.log(`${file} already exists; keeping it.`);
  console.log(`address: ${privateKeyToAccount(readFileSync(file, "utf8").trim()).address}`);
  process.exit(0);
}
const key = generatePrivateKey();
writeFileSync(file, key + "\n", { mode: 0o600 });
chmodSync(file, 0o600);
console.log(`Saved ${file}`);
console.log(`address: ${privateKeyToAccount(key).address}`);

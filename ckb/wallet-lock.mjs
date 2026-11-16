// Print WALLET_<n>'s lock as code_hash:hash_type:args plus its lock hash (no keys read).
import { readFileSync } from "node:fs";
import { ccc } from "@ckb-ccc/core";
const env = Object.fromEntries(readFileSync(process.argv[2], "utf8").split(/\r?\n/)
  .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean)
  .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));
const { script } = await ccc.Address.fromString(env[`WALLET_${process.argv[3]}_ADDRESS`], new ccc.ClientPublicTestnet());
console.log(`${script.codeHash}:${script.hashType}:${script.args.slice(2)} ${script.hash()}`);
process.exit(0);

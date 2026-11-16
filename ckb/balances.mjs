// Print CKB testnet balances of WALLET_1..5 (addresses only; keys untouched).
import { readFileSync } from "node:fs";
import { ccc } from "@ckb-ccc/core";
const env = Object.fromEntries(readFileSync(process.argv[2], "utf8").split(/\r?\n/)
  .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean)
  .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));
const client = env.CKB_RPC ? new ccc.ClientPublicTestnet({ url: env.CKB_RPC }) : new ccc.ClientPublicTestnet();
for (let i = 1; i <= 5; i++) {
  const a = env[`WALLET_${i}_ADDRESS`]; if (!a) continue;
  const { script } = await ccc.Address.fromString(a, client);
  const bal = await client.getBalanceSingle(script);
  console.log(`WALLET_${i}`, ccc.fixedPointToString(bal), "CKB");
}
process.exit(0);

// Make a CKB → Solana bridge deposit on CKB testnet.
//
//   node deposit.mjs --env <path/.env> --from 1 --custodian 2 --ckb 200 [--recipient <solana base58>]
//
// Creates one output: capacity = amount, lock = custodian wallet's lock (the deposit lock the
// Solana bridge config is bound to), data = the 32-byte Solana recipient pubkey. No type script.
// Keys are read from the .env by variable name and never printed.
import { readFileSync, writeFileSync } from "node:fs";
import { ccc } from "@ckb-ccc/core";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const env = Object.fromEntries(readFileSync(arg("env"), "utf8").split(/\r?\n/)
  .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean)
  .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s) {
  let n = 0n;
  for (const c of s) { const v = B58.indexOf(c); if (v < 0) throw new Error("bad base58"); n = n * 58n + BigInt(v); }
  const out = [];
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c !== "1") break; out.unshift(0); }
  return Uint8Array.from(out);
}

const from = arg("from", "1"), custodian = arg("custodian", "2"), amount = arg("ckb", "200");
const recipientB58 = arg("recipient", env.SOL_ADDRESS);
const recipient = b58decode(recipientB58);
if (recipient.length !== 32) throw new Error("recipient must be a 32-byte Solana pubkey");

const client = env.CKB_RPC ? new ccc.ClientPublicTestnet({ url: env.CKB_RPC }) : new ccc.ClientPublicTestnet();
const signer = new ccc.SignerCkbPrivateKey(client, env[`WALLET_${from}_PRIVKEY`]);
const { script: lock } = await ccc.Address.fromString(env[`WALLET_${custodian}_ADDRESS`], client);

const tx = ccc.Transaction.from({ outputs: [{ lock, capacity: ccc.fixedPointFrom(amount) }], outputsData: [ccc.hexFrom(recipient)] });
await tx.completeInputsByCapacity(signer);
await tx.completeFeeBy(signer, 1000);
const hash = await signer.sendTransaction(tx);
const out = {
  tx_hash: hash, out_index: 0, capacity_shannons: ccc.fixedPointFrom(amount).toString(),
  custodian_wallet: `WALLET_${custodian}`, deposit_lock_hash: lock.hash(),
  recipient: recipientB58, recipient_hex: ccc.hexFrom(recipient),
};
console.log(JSON.stringify(out, null, 1));
console.log(`https://testnet.explorer.nervos.org/transaction/${hash}`);
for (;;) {
  const r = await client.getTransaction(hash);
  if (r?.status === "committed") { console.log(`committed in block #${r.blockNumber}`); out.block_number = Number(r.blockNumber); break; }
  if (r?.status === "rejected") throw new Error("rejected");
  await new Promise((r) => setTimeout(r, 3000));
}
if (arg("out")) writeFileSync(arg("out"), JSON.stringify(out, null, 1));
process.exit(0);

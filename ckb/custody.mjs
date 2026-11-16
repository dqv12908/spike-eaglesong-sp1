// CKB side of the bridge custody (testnet). Keys come from the .env by variable name and are
// never printed. State is kept in ckb/custody-testnet.json (public data only).
//
//   node custody.mjs keys                                   create attesters.local.json (3 ed25519 seeds, m=2) if missing
//   node custody.mjs transfer   --env E --from 1 --to 3 --ckb 10000
//   node custody.mjs deploy     --env E --from 3            deploy ckb-custody/build/custody-lock (data2)
//   node custody.mjs vault      --env E --from 3 --config <solana bridge config pubkey> [--seed-ckb 300]
//   node custody.mjs deposit    --env E --from 1 --ckb 300 [--recipient <solana base58>] [--out f.json]
//   node custody.mjs unlock     --env E --from 1 --attestation att.json [--dry-run] [--tamper amount|seq] [--force]
//                               (--force skips the client-side seq check so the script itself must reject)
//   node custody.mjs status     --env E
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { ccc } from "@ckb-ccc/core";
import { cccA } from "@ckb-ccc/core/advanced";
import { ATTESTERS, VAULT_MAGIC, attesterKeys, b58decode, cat, u64le, vaultData } from "./custody-lib.mjs";

const here = (p) => new URL(p, import.meta.url);
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes(`--${k}`);
const cmd = process.argv[2];
const STATE = here("./custody-testnet.json");
const BIN = here("../ckb-custody/build/custody-lock");
const TYPE_ID_CODE_HASH = "0x00000000000000000000000000000000000000000000000000545950455f4944";

const loadJson = (u, d) => (existsSync(u) ? JSON.parse(readFileSync(u, "utf8")) : d);
const saveState = (s) => writeFileSync(STATE, JSON.stringify(s, null, 1));

function env() {
  return Object.fromEntries(readFileSync(arg("env"), "utf8").split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));
}

function vaultSeq(data) {
  const b = ccc.bytesFrom(data);
  if (b.length !== 16 || ccc.hexFrom(b.slice(0, 8)) !== ccc.hexFrom(VAULT_MAGIC)) throw new Error("not a vault cell");
  return new DataView(b.buffer, b.byteOffset).getBigUint64(8, true);
}

async function setup(fromIdx) {
  const e = env();
  const client = e.CKB_RPC ? new ccc.ClientPublicTestnet({ url: e.CKB_RPC }) : new ccc.ClientPublicTestnet();
  const signer = fromIdx ? new ccc.SignerCkbPrivateKey(client, e[`WALLET_${fromIdx}_PRIVKEY`]) : null;
  return { e, client, signer };
}
async function waitCommit(client, hash, label) {
  console.log(`${label}: ${hash}\n  https://testnet.explorer.nervos.org/transaction/${hash}`);
  for (;;) {
    const r = await client.getTransaction(hash);
    if (r?.status === "committed") { console.log(`  committed in block #${r.blockNumber}`); return Number(r.blockNumber); }
    if (r?.status === "rejected") throw new Error(`rejected: ${r.reason ?? ""}`);
    await new Promise((res) => setTimeout(res, 3000));
  }
}
const ckb = (x) => ccc.fixedPointToString(x);

if (cmd === "keys") {
  if (existsSync(ATTESTERS)) { console.log("attesters.local.json exists"); }
  else writeFileSync(ATTESTERS, JSON.stringify({ note: "TESTNET demo custody committee (2-of-3). Do not reuse.", m: 2, seeds: [0, 1, 2].map(() => ccc.hexFrom(randomBytes(32))) }, null, 1));
  const { m, pubkeys } = attesterKeys();
  console.log(`committee m=${m} n=${pubkeys.length}`); pubkeys.forEach((p, i) => console.log(`  attester ${i}: ${ccc.hexFrom(p)}`));
} else if (cmd === "transfer") {
  const { e, client, signer } = await setup(arg("from"));
  const { script: lock } = await ccc.Address.fromString(e[`WALLET_${arg("to")}_ADDRESS`], client);
  const tx = ccc.Transaction.from({ outputs: [{ lock, capacity: ccc.fixedPointFrom(arg("ckb")) }], outputsData: ["0x"] });
  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer, 1000);
  await waitCommit(client, await signer.sendTransaction(tx), `transfer ${arg("ckb")} CKB WALLET_${arg("from")} -> WALLET_${arg("to")}`);
} else if (cmd === "deploy") {
  const { client, signer } = await setup(arg("from"));
  const code = readFileSync(BIN);
  const { script: lock } = await signer.getRecommendedAddressObj();
  const tx = ccc.Transaction.from({ outputs: [{ lock }], outputsData: [ccc.hexFrom(code)] }); // capacity = occupied
  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer, 1000);
  const hash = await signer.sendTransaction(tx);
  const block = await waitCommit(client, hash, `deploy custody-lock (${code.length} bytes)`);
  const s = loadJson(STATE, {});
  s.code = { tx_hash: hash, index: 0, data_hash: ccc.hashCkb(code), size: code.length, block, capacity_ckb: ckb(tx.outputs[0].capacity), owner: `WALLET_${arg("from")}` };
  saveState(s);
  console.log(`code data hash ${s.code.data_hash} (hash_type data2)`);
} else if (cmd === "vault") {
  const { client, signer } = await setup(arg("from"));
  const s = loadJson(STATE, {});
  if (!s.code) throw new Error("deploy first");
  const { m, pubkeys } = attesterKeys();
  const bridgeId = b58decode(arg("config"));
  if (bridgeId.length !== 32) throw new Error("--config must be a Solana pubkey");
  const { script: myLock } = await signer.getRecommendedAddressObj();
  // placeholder output of the final size; the first input fixes the Type ID
  const placeholderLock = ccc.Script.from({ codeHash: s.code.data_hash, hashType: "data2", args: ccc.hexFrom(new Uint8Array(66 + 32 * pubkeys.length)) });
  const placeholderType = ccc.Script.from({ codeHash: TYPE_ID_CODE_HASH, hashType: "type", args: ccc.hexFrom(new Uint8Array(32)) });
  const tx = ccc.Transaction.from({
    outputs: [{ lock: placeholderLock, type: placeholderType, capacity: ccc.fixedPointFrom(arg("seed-ckb", "300")) }],
    outputsData: [vaultData(0)],
  });
  tx.addCellDeps({ outPoint: { txHash: s.code.tx_hash, index: s.code.index }, depType: "code" });
  await tx.completeInputsByCapacity(signer);
  const vaultType = ccc.Script.from({ codeHash: TYPE_ID_CODE_HASH, hashType: "type", args: ccc.hashTypeId(tx.inputs[0], 0) });
  const vaultTypeHash = vaultType.hash();
  const args = cat(vaultTypeHash, bridgeId, [m, pubkeys.length], ...pubkeys);
  const lock = ccc.Script.from({ codeHash: s.code.data_hash, hashType: "data2", args: ccc.hexFrom(args) });
  tx.outputs[0].lock = lock;
  tx.outputs[0].type = vaultType;
  await tx.completeFeeBy(signer, 1000);
  const hash = await signer.sendTransaction(tx);
  const block = await waitCommit(client, hash, "create vault");
  s.vault = { created_tx: hash, block, type_script: { code_hash: vaultType.codeHash, hash_type: vaultType.hashType, args: vaultType.args }, type_hash: vaultTypeHash, seed_ckb: arg("seed-ckb", "300") };
  s.custody_lock = { code_hash: lock.codeHash, hash_type: lock.hashType, args: lock.args, lock_hash: lock.hash(), m, n: pubkeys.length, attester_pubkeys: pubkeys.map((p) => ccc.hexFrom(p)) };
  s.bridge_id = { solana_config: arg("config"), hex: ccc.hexFrom(bridgeId) };
  s.custody_address = ccc.Address.fromScript(lock, client).toString();
  saveState(s);
  console.log(`custody lock hash ${s.custody_lock.lock_hash}\nvault type hash ${vaultTypeHash}\ncustody address ${s.custody_address}`);
} else if (cmd === "deposit") {
  const { e, client, signer } = await setup(arg("from"));
  const s = loadJson(STATE);
  const lock = ccc.Script.from({ codeHash: s.custody_lock.code_hash, hashType: s.custody_lock.hash_type, args: s.custody_lock.args });
  const recipientB58 = arg("recipient", e.SOL_ADDRESS);
  const recipient = b58decode(recipientB58);
  if (recipient.length !== 32) throw new Error("recipient must be a 32-byte Solana pubkey");
  const tx = ccc.Transaction.from({ outputs: [{ lock, capacity: ccc.fixedPointFrom(arg("ckb")) }], outputsData: [ccc.hexFrom(recipient)] });
  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer, 1000);
  const hash = await signer.sendTransaction(tx);
  const block = await waitCommit(client, hash, `deposit ${arg("ckb")} CKB into custody for ${recipientB58}`);
  const out = { tx_hash: hash, out_index: 0, block_number: block, capacity_shannons: ccc.fixedPointFrom(arg("ckb")).toString(), deposit_lock_hash: lock.hash(), recipient: recipientB58, recipient_hex: ccc.hexFrom(recipient), from: `WALLET_${arg("from")}` };
  if (arg("out")) writeFileSync(arg("out"), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
} else if (cmd === "unlock") {
  const { client, signer } = await setup(arg("from"));
  const s = loadJson(STATE);
  const att = JSON.parse(readFileSync(arg("attestation"), "utf8"));
  const lock = ccc.Script.from({ codeHash: s.custody_lock.code_hash, hashType: s.custody_lock.hash_type, args: s.custody_lock.args });
  const vaultType = ccc.Script.from({ codeHash: s.vault.type_script.code_hash, hashType: s.vault.type_script.hash_type, args: s.vault.type_script.args });
  const recipient = ccc.Script.from({ codeHash: att.recipient_lock.code_hash, hashType: att.recipient_lock.hash_type, args: att.recipient_lock.args });
  if (recipient.hash() !== att.recipient_lock_hash) throw new Error("recipient lock hash mismatch");

  // all live custody cells: exactly one vault (Type ID) + untyped deposits
  let vault = null; const deposits = [];
  for await (const c of client.findCellsByLock(lock, undefined, true)) {
    if (c.cellOutput.type && c.cellOutput.type.hash() === vaultType.hash()) vault = c;
    else if (!c.cellOutput.type) deposits.push(c);
  }
  if (!vault) throw new Error("vault not found");
  const seq = vaultSeq(vault.outputData);
  if (BigInt(att.seq) !== seq && !flag("force")) throw new Error(`vault expects burn #${seq}, attestation is for #${att.seq}`);
  const amount = BigInt(att.amount);
  const inTotal = deposits.reduce((a, c) => a + c.cellOutput.capacity, vault.cellOutput.capacity);
  const toRecipient = recipient.hash() !== lock.hash();
  const vaultOut = inTotal - (toRecipient ? amount : 0n);
  console.log(`burn #${seq}: ${ckb(amount)} CKB -> ${recipient.hash()}; custody in ${ckb(inTotal)} (vault + ${deposits.length} deposits), vault out ${ckb(vaultOut)}`);

  // witness: seq ‖ amount ‖ recipient_lock_hash ‖ k ‖ k × (index ‖ sig64)
  let wSeq = BigInt(att.seq), wAmount = amount;
  if (arg("tamper") === "amount") wAmount += 1n;
  if (arg("tamper") === "seq") wSeq += 1n;
  const sigs = [...att.signatures].sort((a, b) => a.index - b.index);
  const payload = cat(u64le(wSeq), u64le(wAmount), att.recipient_lock_hash, [sigs.length], ...sigs.map((x) => cat([x.index], x.signature)));

  const outputs = [{ lock, type: vaultType, capacity: vaultOut }];
  const outputsData = [vaultData(seq + 1n)];
  if (toRecipient) { outputs.push({ lock: recipient, capacity: amount }); outputsData.push("0x"); }
  const tx = ccc.Transaction.from({ inputs: [vault, ...deposits].map((c) => ({ previousOutput: c.outPoint })), outputs, outputsData });
  tx.addCellDeps({ outPoint: { txHash: s.code.tx_hash, index: s.code.index }, depType: "code" });
  tx.setWitnessArgsAt(0, ccc.WitnessArgs.from({ lock: ccc.hexFrom(payload) }));
  await tx.completeFeeBy(signer, 1000); // relayer pays the fee from its own inputs
  if (flag("dry-run")) {
    const signed = await signer.signTransaction(tx);
    try {
      const r = await client.requestor.request("test_tx_pool_accept", [cccA.JsonRpcTransformers.transactionFrom(signed), "passthrough"]);
      console.log("dry run accepted:", JSON.stringify(r));
    } catch (err) { console.log("dry run rejected:", String(err.message ?? err).slice(0, 400)); }
    process.exit(0);
  }
  const hash = await signer.sendTransaction(tx);
  const block = await waitCommit(client, hash, `unlock burn #${seq}`);
  const r = { burn_seq: Number(seq), unlock_tx: hash, block, amount_shannons: amount.toString(), recipient_lock_hash: recipient.hash(), custody_inputs: 1 + deposits.length, vault_out_shannons: vaultOut.toString(), relayer: `WALLET_${arg("from")}` };
  if (arg("out")) writeFileSync(arg("out"), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1));
} else if (cmd === "status") {
  const { client } = await setup();
  const s = loadJson(STATE);
  const lock = ccc.Script.from({ codeHash: s.custody_lock.code_hash, hashType: s.custody_lock.hash_type, args: s.custody_lock.args });
  let total = 0n, n = 0, seq = null;
  for await (const c of client.findCellsByLock(lock, undefined, true)) {
    total += c.cellOutput.capacity; n++;
    if (c.cellOutput.type && c.cellOutput.type.hash() === s.vault.type_hash) seq = vaultSeq(c.outputData);
  }
  console.log(JSON.stringify({ custody_cells: n, custody_ckb: ckb(total), vault_next_seq: seq?.toString() }, null, 1));
} else {
  console.log("usage: see header comment");
}
process.exit(0);

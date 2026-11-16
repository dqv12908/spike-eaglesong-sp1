// Attester: watch a Solana burn record and sign the CKB unlock message for it.
//
//   node attest.mjs --env E --program <ID> --seq 0 --signers 0,2 --out att.json [--commitment finalized]
//
// Each signer index stands for an independent attester; in this demo all three seeds live in
// attesters.local.json (testnet only). Before signing, an attester checks, from Solana state at
// `finalized` commitment:
//   - the bridge config account is owned by the program, is a v2 config, and is bound to *this*
//     custody lock (lock hash) — i.e. bridge_id in the custody args is the right config;
//   - the burn record is the PDA ["burn", config, seq], owned by the program, magic + seq match.
// It then signs ckbhash("CKB-SOL-UNLOCK-V1" ‖ bridge_id ‖ vault_type_hash ‖ seq ‖ amount ‖ lock_hash).
import { readFileSync, writeFileSync } from "node:fs";
import { ccc } from "@ckb-ccc/core";
import { ed25519 } from "@noble/curves/ed25519.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { attesterKeys, unlockMessage } from "./custody-lib.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const env = Object.fromEntries(readFileSync(arg("env"), "utf8").split(/\r?\n/)
  .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean)
  .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));
const S = JSON.parse(readFileSync(new URL("./custody-testnet.json", import.meta.url), "utf8"));
const HASH_TYPE = { 0: "data", 1: "type", 2: "data1", 4: "data2" };

const program = new PublicKey(arg("program"));
const config = new PublicKey(S.bridge_id.solana_config);
const seq = BigInt(arg("seq"));
const commitment = arg("commitment", "finalized");
const conn = new Connection(arg("sol-rpc", env.SOL_DEVNET_RPC || "https://api.devnet.solana.com"), commitment);

const fail = (m) => { console.error(`REFUSE: ${m}`); process.exit(2); };

// config binding
const ci = await conn.getAccountInfo(config, commitment);
if (!ci || !ci.owner.equals(program)) fail("config not owned by the bridge program");
const cd = ci.data;
if (cd.subarray(0, 8).toString() !== "CKBBR002") fail("not a v2 bridge config");
if ("0x" + cd.subarray(104, 136).toString("hex") !== S.custody_lock.lock_hash) fail("config is bound to a different custody lock");
const nextSeq = cd.readBigUInt64LE(176);
if (seq >= nextSeq) fail(`burn #${seq} does not exist yet (next seq ${nextSeq})`);

// burn record
const seqLe = Buffer.alloc(8); seqLe.writeBigUInt64LE(seq);
const [pda] = PublicKey.findProgramAddressSync([Buffer.from("burn"), config.toBuffer(), seqLe], program);
const bi = await conn.getAccountInfo(pda, commitment);
if (!bi || !bi.owner.equals(program)) fail(`burn record ${pda.toBase58()} missing or not program-owned at ${commitment}`);
const b = bi.data;
if (b.subarray(0, 8).toString() !== "CKBBURN1" || b.readBigUInt64LE(8) !== seq) fail("bad burn record");
const amount = b.readBigUInt64LE(16);
const ht = HASH_TYPE[b[96]];
if (!ht) fail("bad hash_type");
const lock = ccc.Script.from({ codeHash: "0x" + b.subarray(64, 96).toString("hex"), hashType: ht, args: "0x" + b.subarray(98, 98 + b[97]).toString("hex") });
const lockHash = lock.hash();

const msg = unlockMessage(S.bridge_id.hex, S.vault.type_hash, seq, amount, lockHash);
const { seeds, pubkeys } = attesterKeys();
const signers = arg("signers", "0,1").split(",").map(Number);
const signatures = signers.map((i) => {
  const sig = ed25519.sign(msg, seeds[i]);
  if (!ed25519.verify(sig, msg, pubkeys[i])) throw new Error("self-check failed");
  return { index: i, pubkey: ccc.hexFrom(pubkeys[i]), signature: ccc.hexFrom(sig) };
});
const att = {
  seq: seq.toString(), amount: amount.toString(),
  recipient_lock: { code_hash: lock.codeHash, hash_type: lock.hashType, args: lock.args }, recipient_lock_hash: lockHash,
  message: ccc.hexFrom(msg), signatures,
  solana: { program: program.toBase58(), config: config.toBase58(), burn_record: pda.toBase58(), slot: b.readBigUInt64LE(24).toString(), burner: new PublicKey(b.subarray(32, 64)).toBase58(), commitment },
};
writeFileSync(arg("out"), JSON.stringify(att, null, 1));
console.log(`attested burn #${seq}: ${ccc.fixedPointToString(amount)} CKB -> lock ${lockHash} (signers ${signers.join(",")}) -> ${arg("out")}`);
process.exit(0);

// End-to-end v3 driver on Solana: CKB testnet deposit (into the custody lock) → mint → burn.
//
//   node bridge-v3.mjs --rpc <url> --program <ID> --payer <keypair.json | env:PATH_TO_.env>
//        --config-keypair ../deploy/bridge-v3-config-keypair.json
//        --ckb-lock <code_hash>:<type|data|data1|data2>:<args hex>   (CKB recipient of the burn)
//        [--burn-ckb 120] [--confirmations 12] [--max-age 100000] [--out report.json]
//
// Inputs: fixtures/deposit-testnet-v3.json, proofs/bridge-v3-{segment,deposit}.json.
// Steps: (1) light-client state at the checkpoint; (2) ckbCKB mint + bridge config (custody lock
// hash, two-sided depth bound); (3) recipient ATA; (4) negative simulations; (5) submit segment;
// (6) re-submitting the same segment as a fork is rejected (not heavier); (7) mint; (8) replay
// fails; (9) burn N ckbCKB naming a CKB lock -> burn record #0; (10) burn negatives; (11) read back.
import { readFileSync, writeFileSync } from "node:fs";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  MINT_SIZE, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction, getAssociatedTokenAddressSync, getAccount, getMint,
} from "@solana/spl-token";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const RPC = arg("rpc", "http://127.0.0.1:8899");
const PROGRAM_ID = new PublicKey(arg("program"));
const FX = (p) => JSON.parse(readFileSync(new URL(`../../fixtures/${p}`, import.meta.url), "utf8"));
const CONFIRMATIONS = BigInt(arg("confirmations", "12"));
const MAX_AGE = BigInt(arg("max-age", "100000"));
const BURN = BigInt(Math.round(Number(arg("burn-ckb", "120")) * 1e8));
const STATE_LEN = 1280, CONFIG_LEN = 192, BURN_LEN = 168;
const HASH_TYPES = { data: 0, type: 1, data1: 2, data2: 4 };

function loadKeypair(spec) {
  if (spec.startsWith("env:")) {
    for (const line of readFileSync(spec.slice(4), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*SOL_PRIVKEY\s*=\s*(.*)\s*$/);
      if (m) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(m[1].replace(/^["']|["']$/g, ""))));
    }
    throw new Error("SOL_PRIVKEY not found");
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(spec, "utf8"))));
}

const hexb = (h) => Buffer.from(h.replace(/^0x/, ""), "hex");
const depFx = FX("deposit-testnet-v3.json");
const seg = FX("proofs/bridge-v3-segment.json"), dep = FX("proofs/bridge-v3-deposit.json");
const segPv = hexb(seg.public_values), segProof = hexb(seg.proof);
const depPv = hexb(dep.public_values), depProof = hexb(dep.proof);
const ev = {
  anchor_number: depPv.readBigUInt64LE(1), anchor_hash: depPv.subarray(9, 41),
  block_number: depPv.readBigUInt64LE(41), tx_hash: depPv.subarray(81, 113), out_index: depPv.readUInt32LE(113),
  capacity: depPv.readBigUInt64LE(117), lock_hash: depPv.subarray(125, 157), recipient: new PublicKey(depPv.subarray(162, 194)),
};
const [lockCode, lockType, lockArgs] = arg("ckb-lock").split(":");
const ckbLock = { code_hash: hexb(lockCode), hash_type: HASH_TYPES[lockType], args: hexb(lockArgs) };
if (ckbLock.code_hash.length !== 32 || ckbLock.hash_type === undefined) throw new Error("bad --ckb-lock");

const ixData = (tag, pv, proof) => {
  const len = Buffer.alloc(2); len.writeUInt16LE(pv.length);
  return Buffer.concat([Buffer.from([tag]), len, pv, proof]);
};
const burnData = (amount, lock = ckbLock, hashType = lock.hash_type) => {
  const b = Buffer.alloc(1 + 42 + lock.args.length);
  b[0] = 5; b.writeBigUInt64LE(amount, 1); lock.code_hash.copy(b, 9); b[41] = hashType; b[42] = lock.args.length; lock.args.copy(b, 43);
  return b;
};
const cu = (n) => ComputeBudgetProgram.setComputeUnitLimit({ units: n });
const w = (pubkey) => ({ pubkey, isSigner: false, isWritable: true });
const r = (pubkey) => ({ pubkey, isSigner: false, isWritable: false });
const big = (_, x) => (typeof x === "bigint" ? x.toString() : x);

const conn = new Connection(RPC, "confirmed");
const payer = loadKeypair(arg("payer"));
const config = loadKeypair(arg("config-keypair"));
const report = { rpc: RPC, program: PROGRAM_ID.toBase58(), payer: payer.publicKey.toBase58(), ckb_deposit_tx: depFx.tx_hash, steps: {} };
const log = (k, v) => { report.steps[k] = v; console.log(`${k}:`, typeof v === "string" ? v : JSON.stringify(v, big)); };

async function simulate(ixs) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(payer);
  const res = await conn.simulateTransaction(tx);
  return { err: res.value.err, cu: res.value.unitsConsumed, logs: (res.value.logs || []).filter((l) => l.includes("Program log")) };
}
async function send(label, ixs, signers = []) {
  const tx = new Transaction().add(...ixs);
  const sig = await sendAndConfirmTransaction(conn, tx, [payer, ...signers], { commitment: "confirmed" });
  const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const res = { sig, cu: t?.meta?.computeUnitsConsumed, fee_lamports: t?.meta?.fee, size: tx.serialize().length,
    logs: (t?.meta?.logMessages || []).filter((l) => l.includes("Program log")) };
  log(label, res);
  return res;
}
const customErr = (res, code, ix = 1) => JSON.stringify(res.err) === JSON.stringify({ InstructionError: [ix, { Custom: code }] });

console.log(`rpc=${RPC} program=${PROGRAM_ID.toBase58()} payer=${payer.publicKey.toBase58()} config=${config.publicKey.toBase58()}`);
console.log(`CKB deposit ${depFx.tx_hash} in #${ev.block_number}, ${Number(ev.capacity) / 1e8} CKB -> ${ev.recipient.toBase58()}`);
console.log(`balance=${(await conn.getBalance(payer.publicKey)) / 1e9} SOL`);

// (1) light-client state (testnet, pow_id 1) at the checkpoint
const state = Keypair.generate();
const init = Buffer.alloc(42);
init[0] = 0; init.writeBigUInt64LE(BigInt(depFx.checkpoint.number), 1); hexb(depFx.checkpoint.hash).copy(init, 9); init[41] = 1;
await send("tx_create_init_state", [
  SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: state.publicKey, lamports: await conn.getMinimumBalanceForRentExemption(STATE_LEN), space: STATE_LEN, programId: PROGRAM_ID }),
  new TransactionInstruction({ programId: PROGRAM_ID, keys: [w(state.publicKey), { pubkey: payer.publicKey, isSigner: true, isWritable: false }], data: init }),
], [state]);
report.state_account = state.publicKey.toBase58();

// (2) mint + bridge config (custody lock hash, confirmations, max age)
const mint = Keypair.generate();
const [mintAuth] = PublicKey.findProgramAddressSync([Buffer.from("mint_auth"), config.publicKey.toBuffer()], PROGRAM_ID);
const ib = Buffer.alloc(49); ib[0] = 3; ev.lock_hash.copy(ib, 1); ib.writeBigUInt64LE(CONFIRMATIONS, 33); ib.writeBigUInt64LE(MAX_AGE, 41);
await send("tx_create_mint_and_bridge", [
  SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, lamports: await conn.getMinimumBalanceForRentExemption(MINT_SIZE), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
  createInitializeMint2Instruction(mint.publicKey, 8, mintAuth, null),
  SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: config.publicKey, lamports: await conn.getMinimumBalanceForRentExemption(CONFIG_LEN), space: CONFIG_LEN, programId: PROGRAM_ID }),
  new TransactionInstruction({ programId: PROGRAM_ID, keys: [w(config.publicKey), r(state.publicKey), r(mint.publicKey), { pubkey: payer.publicKey, isSigner: true, isWritable: false }], data: ib }),
], [mint, config]);
Object.assign(report, { config_account: config.publicKey.toBase58(), mint: mint.publicKey.toBase58(), mint_authority_pda: mintAuth.toBase58() });

// (3) recipient's associated token account
const ata = getAssociatedTokenAddressSync(mint.publicKey, ev.recipient);
await send("tx_create_recipient_ata", [createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, ev.recipient, mint.publicKey)]);
report.recipient_token_account = ata.toBase58();

const idx = Buffer.alloc(4); idx.writeUInt32LE(ev.out_index);
const [nullifier] = PublicKey.findProgramAddressSync([Buffer.from("deposit"), config.publicKey.toBuffer(), ev.tx_hash, idx], PROGRAM_ID);
report.nullifier_pda = nullifier.toBase58();
const mintIx = (pv, dest = ata) => new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [w(config.publicKey), r(state.publicKey), w(mint.publicKey), r(mintAuth), w(dest), w(nullifier),
    { pubkey: payer.publicKey, isSigner: true, isWritable: true }, r(SystemProgram.programId), r(TOKEN_PROGRAM_ID)],
  data: ixData(4, pv, depProof),
});
const submitIx = () => new TransactionInstruction({ programId: PROGRAM_ID, keys: [w(state.publicKey)], data: ixData(1, segPv, segProof) });

// (4) negative controls before the segment (simulation only)
const notAnchored = await simulate([cu(400_000), mintIx(depPv)]);
log("sim_mint_before_segment", notAnchored);
const badPv = Buffer.from(depPv); badPv[162] ^= 1;
const tampered = await simulate([cu(400_001), mintIx(badPv)]);
log("sim_mint_tampered_recipient", tampered);

// (5) segment proof: checkpoint -> anchor (epoch/difficulty rules checked in the proof)
await send("tx_submit_segment", [cu(400_000), submitIx()]);

// (6) the same segment again now forks from the checkpoint with equal work: rejected
const fork = await simulate([cu(400_003), submitIx()]);
log("sim_resubmit_segment_as_fork", fork);

const wrongDest = await simulate([cu(400_002), mintIx(depPv, mint.publicKey)]);
log("sim_mint_wrong_token_account", wrongDest);

// (7) mint
await send("tx_mint_deposit", [cu(400_000), mintIx(depPv)]);
// (8) replay
const replay = await simulate([cu(399_999), mintIx(depPv)]);
log("sim_mint_replay", replay);

// (9) burn: the recipient (here the payer's own wallet holds the tokens) burns BURN shannons
const owner = ev.recipient.equals(payer.publicKey) ? payer : null;
if (!owner) throw new Error("demo burn expects the deposit recipient to be the payer wallet");
const seqLe = Buffer.alloc(8); // seq 0 on a fresh config
const [burnRec] = PublicKey.findProgramAddressSync([Buffer.from("burn"), config.publicKey.toBuffer(), seqLe], PROGRAM_ID);
const burnIx = (data, rec = burnRec) => new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [w(config.publicKey), w(mint.publicKey), w(ata), { pubkey: owner.publicKey, isSigner: true, isWritable: false }, w(rec),
    { pubkey: payer.publicKey, isSigner: true, isWritable: true }, r(SystemProgram.programId), r(TOKEN_PROGRAM_ID)],
  data,
});
const tooSmall = await simulate([burnIx(burnData(BigInt(41 + ckbLock.args.length) * 100_000_000n - 1n))]);
log("sim_burn_below_min_cell", tooSmall);
const badType = await simulate([burnIx(burnData(BURN, ckbLock, 3))]);
log("sim_burn_bad_hash_type", badType);
const wrongSeq = await simulate([burnIx(burnData(BURN), PublicKey.findProgramAddressSync([Buffer.from("burn"), config.publicKey.toBuffer(), Buffer.from([1, 0, 0, 0, 0, 0, 0, 0])], PROGRAM_ID)[0])]);
log("sim_burn_wrong_seq_pda", wrongSeq);
await send("tx_burn", [burnIx(burnData(BURN))]);
report.burn_record = burnRec.toBase58();

// (11) read back
const acct = await getAccount(conn, ata);
const m = await getMint(conn, mint.publicKey);
const sd = (await conn.getAccountInfo(state.publicKey)).data;
const cd = (await conn.getAccountInfo(config.publicKey)).data;
const bd = (await conn.getAccountInfo(burnRec)).data;
const st = {
  tip_number: sd.readBigUInt64LE(40).toString(), tip_hash: "0x" + sd.subarray(48, 80).toString("hex"),
  pow_id: sd[120], ring_len: sd[121],
  recipient_balance: acct.amount.toString(), mint_supply: m.supply.toString(), decimals: m.decimals,
  bridge_total_minted: cd.readBigUInt64LE(144).toString(), bridge_total_burned: cd.readBigUInt64LE(168).toString(),
  next_burn_seq: cd.readBigUInt64LE(176).toString(),
  burn: { seq: bd.readBigUInt64LE(8).toString(), amount: bd.readBigUInt64LE(16).toString(), slot: bd.readBigUInt64LE(24).toString(),
    burner: new PublicKey(bd.subarray(32, 64)).toBase58(), code_hash: "0x" + bd.subarray(64, 96).toString("hex"), hash_type: bd[96],
    args: "0x" + bd.subarray(98, 98 + bd[97]).toString("hex") },
};
log("final", st);

const ok = customErr(notAnchored, 9) && customErr(tampered, 4) && customErr(fork, 20) && customErr(wrongDest, 14) && customErr(replay, 15)
  && customErr(tooSmall, 23, 0) && customErr(badType, 22, 0) && customErr(wrongSeq, 19, 0)
  && st.tip_number === ev.anchor_number.toString() && st.tip_hash === "0x" + ev.anchor_hash.toString("hex")
  && acct.amount === ev.capacity - BURN && m.supply === ev.capacity - BURN && st.bridge_total_burned === BURN.toString()
  && st.next_burn_seq === "1" && st.burn.amount === BURN.toString() && bd.length === BURN_LEN;
console.log(ok ? "\nALL CHECKS PASSED" : "\nCHECKS FAILED");
if (arg("out")) writeFileSync(arg("out"), JSON.stringify(report, big, 2));
process.exit(ok ? 0 : 1);

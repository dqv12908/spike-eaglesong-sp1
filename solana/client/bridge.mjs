// End-to-end CKB testnet → Solana deposit/mint driver.
//
//   node bridge.mjs --rpc <url> --program <PROGRAM_ID> --payer <keypair.json | env:PATH_TO_.env> [--out report.json]
//
// Inputs (fixtures/): deposit-testnet.json (checkpoint, from scripts/fetch_deposit.py),
// proofs/bridge-segment.json (kind 1, PoW segment checkpoint+1..anchor),
// proofs/bridge-deposit.json (kind 2, deposit cell in block B, B..anchor hash-linked).
//
// Steps: (1) create + init a testnet light-client state at the checkpoint; (2) create the ckbCKB
// mint (authority = program PDA) + bridge config bound to the deposit lock; (3) recipient ATA;
// (4) negative simulations (not yet anchored, tampered deposit, wrong token account);
// (5) submit the segment (tip -> anchor); (6) mint; (7) replay must fail; (8) read back.
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
const STATE_LEN = 768, CONFIG_LEN = 160, RING_OFF = 128;

function loadPayer(spec) {
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
const depFx = FX("deposit-testnet.json");
const seg = FX("proofs/bridge-segment.json"), dep = FX("proofs/bridge-deposit.json");
const segPv = hexb(seg.public_values), segProof = hexb(seg.proof);
const depPv = hexb(dep.public_values), depProof = hexb(dep.proof);
// deposit event fields (layout: ckb_pow::deposit::DepositEvent::to_bytes)
const ev = {
  anchor_number: depPv.readBigUInt64LE(1), anchor_hash: depPv.subarray(9, 41),
  block_number: depPv.readBigUInt64LE(41), tx_hash: depPv.subarray(81, 113), out_index: depPv.readUInt32LE(113),
  capacity: depPv.readBigUInt64LE(117), lock_hash: depPv.subarray(125, 157), recipient: new PublicKey(depPv.subarray(162, 194)),
};

const ixData = (tag, pv, proof) => {
  const len = Buffer.alloc(2); len.writeUInt16LE(pv.length);
  return Buffer.concat([Buffer.from([tag]), len, pv, proof]);
};
const cu = (n) => ComputeBudgetProgram.setComputeUnitLimit({ units: n });
const w = (pubkey) => ({ pubkey, isSigner: false, isWritable: true });
const r = (pubkey) => ({ pubkey, isSigner: false, isWritable: false });

const conn = new Connection(RPC, "confirmed");
const payer = loadPayer(arg("payer"));
const report = { rpc: RPC, program: PROGRAM_ID.toBase58(), payer: payer.publicKey.toBase58(), ckb_deposit_tx: depFx.tx_hash, steps: {} };
const log = (k, v) => { report.steps[k] = v; console.log(`${k}:`, typeof v === "string" ? v : JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x))); };

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
const customErr = (res, code) => JSON.stringify(res.err) === JSON.stringify({ InstructionError: [1, { Custom: code }] });

console.log(`rpc=${RPC} program=${PROGRAM_ID.toBase58()} payer=${payer.publicKey.toBase58()}`);
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

// (2) mint + bridge config
const config = Keypair.generate(), mint = Keypair.generate();
const [mintAuth] = PublicKey.findProgramAddressSync([Buffer.from("mint_auth"), config.publicKey.toBuffer()], PROGRAM_ID);
const ib = Buffer.alloc(41); ib[0] = 3; ev.lock_hash.copy(ib, 1); ib.writeBigUInt64LE(CONFIRMATIONS, 33);
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

// (4) negative controls (simulation only)
const notAnchored = await simulate([cu(400_000), mintIx(depPv)]);
log("sim_mint_before_segment", notAnchored);
const badPv = Buffer.from(depPv); badPv[162] ^= 1; // flip a recipient bit
const tampered = await simulate([cu(400_001), mintIx(badPv)]);
log("sim_mint_tampered_recipient", tampered);

// (5) segment proof: tip checkpoint -> anchor
await send("tx_submit_segment", [cu(400_000), new TransactionInstruction({ programId: PROGRAM_ID, keys: [w(state.publicKey)], data: ixData(1, segPv, segProof) })]);

const wrongDest = await simulate([cu(400_002), mintIx(depPv, mint.publicKey)]);
log("sim_mint_wrong_token_account", wrongDest);

// (6) mint
await send("tx_mint_deposit", [cu(400_000), mintIx(depPv)]);

// (7) replay
const replay = await simulate([cu(399_999), mintIx(depPv)]);
log("sim_mint_replay", replay);

// (8) read back
const acct = await getAccount(conn, ata);
const m = await getMint(conn, mint.publicKey);
const sd = (await conn.getAccountInfo(state.publicKey)).data;
const cd = (await conn.getAccountInfo(config.publicKey)).data;
const st = {
  tip_number: sd.readBigUInt64LE(40).toString(), tip_hash: "0x" + sd.subarray(48, 80).toString("hex"),
  pow_id: sd[120], updates: sd.readBigUInt64LE(112).toString(),
  recipient_balance: acct.amount.toString(), mint_supply: m.supply.toString(), decimals: m.decimals,
  bridge_total_minted: cd.readBigUInt64LE(144).toString(),
};
log("final", st);

const ok = customErr(notAnchored, 9) && customErr(tampered, 4) && customErr(wrongDest, 14) && customErr(replay, 15)
  && st.tip_number === ev.anchor_number.toString() && st.tip_hash === "0x" + ev.anchor_hash.toString("hex")
  && acct.amount === ev.capacity && m.supply === ev.capacity && acct.owner.equals(ev.recipient);
console.log(ok ? "\nALL CHECKS PASSED" : "\nCHECKS FAILED");
if (arg("out")) writeFileSync(arg("out"), JSON.stringify(report, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2));
process.exit(ok ? 0 : 1);

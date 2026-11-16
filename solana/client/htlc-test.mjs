// On-chain checks of the HTLC escrow (local validator or devnet).
//
//   node htlc-test.mjs --rpc <url> --program <ID> --payer <keypair.json | env:PATH_TO_.env> [--out report.json]
//
// payer = offerer (LP) and fee payer. The claimer is a fresh key with 0 SOL: claims are
// permissionless, so a relayer (here the payer) can submit them and the SOL still lands with the
// claimer. Steps: lock; negative simulations; claim; preimage recovered from chain; short lock
// expires -> claim refused, refund succeeds; claimer cancels early -> offerer refunded at once.
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { ERR, cancelIx, claimIx, decodeEscrow, escrowPda, findClaimPreimage, loadKeypair, lockIx, refundIx, sha256 } from "./htlc-lib.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const RPC = arg("rpc", "http://127.0.0.1:8899");
const PROGRAM_ID = new PublicKey(arg("program"));
const conn = new Connection(RPC, "confirmed");
const payer = loadKeypair(arg("payer"));
const report = { rpc: RPC, program: PROGRAM_ID.toBase58(), offerer: payer.publicKey.toBase58(), steps: {} };
const log = (k, v) => { report.steps[k] = v; console.log(`${k}:`, typeof v === "string" ? v : JSON.stringify(v)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function simulate(ixs) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(payer);
  const res = await conn.simulateTransaction(tx);
  return { err: res.value.err, cu: res.value.unitsConsumed };
}
async function send(label, ixs, signers = []) {
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [payer, ...signers], { commitment: "confirmed" });
  const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const res = { sig, cu: t?.meta?.computeUnitsConsumed, fee_lamports: t?.meta?.fee,
    logs: (t?.meta?.logMessages || []).filter((l) => l.includes("Program log")) };
  log(label, res);
  return res;
}
const expectErr = async (label, ixs, code) => {
  const r = await simulate(ixs);
  const ok = JSON.stringify(r.err) === JSON.stringify({ InstructionError: [0, { Custom: code }] });
  log(label, { expected: code, got: r.err, ok });
  if (!ok) throw new Error(`${label}: expected Custom ${code}, got ${JSON.stringify(r.err)}`);
};
const chainNow = async () => (await conn.getBlockTime(await conn.getSlot("confirmed"))) ?? Math.floor(Date.now() / 1000);

console.log(`rpc=${RPC} program=${PROGRAM_ID.toBase58()} offerer=${payer.publicKey.toBase58()} balance=${(await conn.getBalance(payer.publicKey)) / 1e9} SOL`);
const claimerKp = Keypair.generate();
const claimer = claimerKp.publicKey;
const offerer = payer.publicKey;
const AMOUNT = BigInt(arg("lamports", String(0.05 * LAMPORTS_PER_SOL)));

// (1) lock
const pre = randomBytes(32), hash = sha256(pre);
const escrow = escrowPda(PROGRAM_ID, offerer, hash);
let now = await chainNow();
await send("lock", [lockIx(PROGRAM_ID, { offerer, hash, claimer, amount: AMOUNT, expiry: now + 600 })]);
const e = decodeEscrow((await conn.getAccountInfo(escrow)).data);
log("escrow", { address: escrow.toBase58(), amount: e.amount.toString(), expiry: e.expiry, claimer: e.claimer.toBase58(), offerer: e.offerer.toBase58() });
if (e.amount !== AMOUNT || !e.claimer.equals(claimer) || !e.hash.equals(hash)) throw new Error("escrow mismatch");

// (2) negatives
// (different expiry so the simulated tx is not byte-identical to the one just sent)
await expectErr("neg_lock_again_same_hash", [lockIx(PROGRAM_ID, { offerer, hash, claimer, amount: AMOUNT, expiry: now + 601 })], ERR.BadEscrow);
const h2 = sha256(randomBytes(32));
await expectErr("neg_lock_zero", [lockIx(PROGRAM_ID, { offerer, hash: h2, claimer, amount: 0, expiry: now + 600 })], ERR.ZeroAmount);
await expectErr("neg_lock_expiry_past", [lockIx(PROGRAM_ID, { offerer, hash: h2, claimer, amount: 1, expiry: now - 1 })], ERR.BadExpiry);
const badPda = lockIx(PROGRAM_ID, { offerer, hash: h2, claimer, amount: 1, expiry: now + 600 });
badPda.keys[1].pubkey = escrow;
await expectErr("neg_lock_wrong_pda", [badPda], ERR.WrongPda);
await expectErr("neg_claim_wrong_preimage", [claimIx(PROGRAM_ID, { escrow, claimer, offerer, preimage: randomBytes(32) })], ERR.WrongPreimage);
await expectErr("neg_claim_hash_as_preimage", [claimIx(PROGRAM_ID, { escrow, claimer, offerer, preimage: hash })], ERR.WrongPreimage);
await expectErr("neg_claim_to_other_account", [claimIx(PROGRAM_ID, { escrow, claimer: offerer, offerer, preimage: pre })], ERR.WrongClaimer);
await expectErr("neg_claim_rent_to_other", [claimIx(PROGRAM_ID, { escrow, claimer, offerer: claimer, preimage: pre })], ERR.WrongOfferer);
await expectErr("neg_refund_before_expiry", [refundIx(PROGRAM_ID, { escrow, offerer })], ERR.NotExpired);

// (3) claim, submitted and paid for by a relayer (the payer); SOL goes to the 0-SOL claimer
const before = await conn.getBalance(claimer);
await send("claim", [claimIx(PROGRAM_ID, { escrow, claimer, offerer, preimage: pre })]);
const after = await conn.getBalance(claimer);
log("claimer_balance", { before, after, received: after - before });
if (BigInt(after - before) !== AMOUNT) throw new Error("claimer not paid");
if (decodeEscrow((await conn.getAccountInfo(escrow))?.data)) throw new Error("escrow not closed");
const found = await findClaimPreimage(conn, PROGRAM_ID, escrow, hash);
log("preimage_recovered_from_chain", { ok: !!found && found.preimage.equals(pre), signature: found?.signature });
if (!found || !found.preimage.equals(pre)) throw new Error("preimage not recovered");

// (4) expiry: short lock, claim refused after expiry, refund to the offerer
const pre2 = randomBytes(32), hash2 = sha256(pre2);
const escrow2 = escrowPda(PROGRAM_ID, offerer, hash2);
now = await chainNow();
const TTL = Number(arg("short-ttl", "8"));
await send("lock_short", [lockIx(PROGRAM_ID, { offerer, hash: hash2, claimer, amount: AMOUNT, expiry: now + TTL })]);
const exp2 = decodeEscrow((await conn.getAccountInfo(escrow2)).data).expiry;
while ((await chainNow()) < exp2 + 1) await sleep(1500);
await expectErr("neg_claim_after_expiry", [claimIx(PROGRAM_ID, { escrow: escrow2, claimer, offerer, preimage: pre2 })], ERR.Expired);
const ob = await conn.getBalance(offerer);
const rf = await send("refund", [refundIx(PROGRAM_ID, { escrow: escrow2, offerer })]);
const oa = await conn.getBalance(offerer);
log("offerer_refund", { delta_plus_fee: oa - ob + rf.fee_lamports, amount: Number(AMOUNT) });
if (decodeEscrow((await conn.getAccountInfo(escrow2))?.data)) throw new Error("escrow2 not closed");

// (5) cancel: the claimer waives before expiry; only the recorded claimer can
const pre3 = randomBytes(32), hash3 = sha256(pre3);
const escrow3 = escrowPda(PROGRAM_ID, offerer, hash3);
now = await chainNow();
await send("lock_for_cancel", [lockIx(PROGRAM_ID, { offerer, hash: hash3, claimer, amount: AMOUNT, expiry: now + 600 })]);
await expectErr("neg_cancel_by_non_claimer", [cancelIx(PROGRAM_ID, { escrow: escrow3, offerer, claimer: offerer })], ERR.WrongClaimer);
const cb = await conn.getBalance(offerer);
const cn = await send("cancel", [cancelIx(PROGRAM_ID, { escrow: escrow3, offerer, claimer })], [claimerKp]);
const ca = await conn.getBalance(offerer);
log("offerer_after_cancel", { delta_plus_fee: ca - cb + cn.fee_lamports, amount: Number(AMOUNT) });
if (decodeEscrow((await conn.getAccountInfo(escrow3))?.data)) throw new Error("escrow3 not closed");
if (ca - cb + cn.fee_lamports < Number(AMOUNT)) throw new Error("offerer not refunded by cancel");

console.log("ALL CHECKS PASSED");
report.ok = true;
if (arg("out")) writeFileSync(arg("out"), JSON.stringify(report, null, 1));

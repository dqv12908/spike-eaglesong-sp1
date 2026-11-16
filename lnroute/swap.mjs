// User side of CKB/Fiber -> Lightning -> SOL, atomic on one SHA-256 payment hash.
//
//   node swap.mjs --sats 20000 --lp http://127.0.0.1:7070 --hub-rpc <fiber node with CCH> --fiber-rpc <user's fiber node>
//                 --sol-rpc <url> --user-key <keypair.json | env:FILE> [--no-claim] [--currency Fibd] [--out report.json]
//
// 1. Pick a secret preimage; H = sha256(preimage). Only the user knows it.
// 2. Ask the LP for a quote: it returns a Lightning hold invoice on H and the lamports it will lock.
// 3. Ask the Cross-Chain Hub (send_btc) to pay that invoice; it returns a Fiber invoice that the
//    user pays in wrapped BTC. Check: the Fiber invoice uses the same H (else the legs are unlinked).
// 4. Pay it from the user's Fiber node. The payment stays in flight: the hub pays the Lightning
//    invoice, which the LP holds.
// 5. Wait for the LP's Solana escrow on H: check claimer, amount >= quote, enough time left.
// 6. Claim the SOL with the preimage. The LP reads it and settles Lightning; the hub settles Fiber.
// With --no-claim the user walks away: the escrow expires, the LP refunds and cancels, and the
// Fiber payment fails back to the user.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Connection, PublicKey, Transaction, sendAndConfirmTransaction, claimIx, decodeEscrow, escrowPda, loadKeypair, sha256 } from "../solana/client/htlc-lib.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes(`--${k}`);
const LP = arg("lp", "http://127.0.0.1:7070");
const HUB = arg("hub-rpc"), FIBER = arg("fiber-rpc");
const conn = new Connection(arg("sol-rpc", "http://127.0.0.1:8899"), "confirmed");
const user = loadKeypair(arg("user-key"));
const SATS = Number(arg("sats", "20000"));
const MIN_SECS_LEFT = Number(arg("min-secs-left", "60"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { sats: SATS, user_sol: user.publicKey.toBase58(), steps: {} };
const t0 = Date.now();
const log = (k, v) => { report.steps[k] = { t: ((Date.now() - t0) / 1000).toFixed(1), ...v }; console.log(`[${report.steps[k].t}s] ${k}:`, JSON.stringify(v)); };

let rpcId = 0;
async function rpc(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params: [params] }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
const http = async (path, body) => {
  const r = await fetch(LP + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (!r.ok) throw new Error(`LP ${path}: ${j.error}`);
  return j;
};
async function channelBalance() {
  const { channels } = await rpc(FIBER, "list_channels", {});
  return channels.filter((c) => c.funding_udt_type_script).map((c) => ({ channel_id: c.channel_id, local: BigInt(c.local_balance).toString(), offered_tlc: BigInt(c.offered_tlc_balance || "0x0").toString() }));
}

// 1
const preimage = randomBytes(32), H = sha256(preimage), Hx = H.toString("hex");
log("secret", { payment_hash: Hx });
const solBefore = await conn.getBalance(user.publicKey);
const fiberBefore = await channelBalance();
log("balances_before", { sol_lamports: solBefore, fiber_wrapped_btc: fiberBefore });

// 2
const q = await http("/swap", { payment_hash: Hx, sats: SATS, recipient: user.publicKey.toBase58() });
log("lp_quote", { lamports: q.lamports, rate_sol_per_btc: q.rate_sol_per_btc, lp: q.lp, escrow: q.escrow, bolt11: q.bolt11.slice(0, 40) + "…" });
const lpKey = new PublicKey(q.lp), program = new PublicKey(q.program);
const escrow = escrowPda(program, lpKey, H);
if (escrow.toBase58() !== q.escrow) throw new Error("LP escrow address does not match (lp, H)");

// 3
const order = await rpc(HUB, "send_btc", { btc_pay_req: q.bolt11, currency: arg("currency", "Fibd") });
const fiberInvoice = order.incoming_invoice.Fiber;
log("hub_order", { payment_hash: order.payment_hash, amount_sats: order.amount_sats, fee_sats: order.fee_sats, status: order.status });
if (order.payment_hash.replace(/^0x/, "") !== Hx) throw new Error("hub's Fiber invoice uses a different payment hash: legs would not be atomic");
const parsed = await rpc(FIBER, "parse_invoice", { invoice: fiberInvoice });
const invHash = parsed.invoice.data.payment_hash.replace(/^0x/, "");
log("fiber_invoice", { payment_hash: invHash, amount: BigInt(parsed.invoice.amount).toString() });
if (invHash !== Hx) throw new Error("Fiber invoice hash != H");

// 4
const pay = await rpc(FIBER, "send_payment", { invoice: fiberInvoice });
log("fiber_send_payment", { status: pay.status, fee: pay.fee });

// 5
let e = null;
for (let i = 0; i < 120 && !e; i++) {
  e = decodeEscrow((await conn.getAccountInfo(escrow))?.data);
  if (!e) await sleep(1000);
}
if (!e) throw new Error("LP never locked SOL; the hold invoice will be canceled or time out and the Fiber payment fail back");
const solNow = (await conn.getBlockTime(await conn.getSlot("confirmed"))) ?? Math.floor(Date.now() / 1000);
log("sol_escrow_seen", { amount: e.amount.toString(), claimer: e.claimer.toBase58(), expiry: e.expiry, secs_left: e.expiry - solNow });
if (!e.claimer.equals(user.publicKey)) throw new Error("escrow pays someone else");
if (e.amount < BigInt(q.lamports)) throw new Error(`escrow holds ${e.amount} < quoted ${q.lamports}`);
if (e.expiry - solNow < MIN_SECS_LEFT) throw new Error("too little time left to claim safely");
log("fiber_while_held", { payment: (await rpc(FIBER, "get_payment", { payment_hash: "0x" + Hx })).status, channels: await channelBalance() });

if (has("no-claim")) {
  log("walk_away", { note: "not claiming; waiting for LP refund + cancel and Fiber fail-back" });
} else {
  // 6
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(claimIx(program, { escrow, claimer: user.publicKey, offerer: lpKey, preimage })), [user], { commitment: "confirmed" });
  log("sol_claim", { sig });
}

// 7: wait for Fiber to finish either way
let p;
for (let i = 0; i < 900; i++) {
  p = await rpc(FIBER, "get_payment", { payment_hash: "0x" + Hx });
  if (p.status === "Success" || p.status === "Failed") break;
  await sleep(1000);
}
log("fiber_payment_final", { status: p.status, failed_error: p.failed_error });
log("hub_order_final", { status: (await rpc(HUB, "get_cch_order", { payment_hash: "0x" + Hx })).status });
log("lp_swap_final", await http(`/swap/${Hx}`));
const solAfter = await conn.getBalance(user.publicKey);
const fiberAfter = await channelBalance();
log("balances_after", { sol_lamports: solAfter, sol_delta: solAfter - solBefore, fiber_wrapped_btc: fiberAfter });
report.result = { claimed: !has("no-claim"), fiber_status: p.status, sol_delta_lamports: solAfter - solBefore, elapsed_s: (Date.now() - t0) / 1000 };
if (arg("out")) writeFileSync(arg("out"), JSON.stringify(report, (_, x) => (typeof x === "bigint" ? x.toString() : x), 1));
const ok = has("no-claim") ? p.status === "Failed" : p.status === "Success" && solAfter > solBefore;
console.log(ok ? "SWAP OK" : "SWAP NOT AS EXPECTED");
process.exit(ok ? 0 : 1);

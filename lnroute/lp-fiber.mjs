// Direct liquidity provider: CKB over Fiber <-> native SOL, atomic on one SHA-256 payment hash.
// One market maker, one spread; no bridge, no wrapped token, no BTC hop.
//
//   node lp-fiber.mjs --fiber http://127.0.0.1:8237 --sol-rpc <url> --program <HTLC ID> --lp-key <keypair.json>
//                     [--port 7071] [--spread-bps 40] [--sol-ttl 600] [--state lp-fiber-state.local.json]
//
// CKB -> SOL (the user holds the secret):
//   1. User sends H = sha256(preimage) + a quote id + a Solana recipient. LP returns a Fiber HOLD invoice on H.
//   2. User pays it. The LP's node holds the TLC: the LP can't take the CKB without the preimage,
//      the user can't take it back before the TLC expires (the wallet caps that at 6 h 40 min).
//   3. LP checks the held TLC (amount, time left) and locks the quoted SOL in the Solana escrow on H
//      for the recipient, expiring in --sol-ttl seconds (far sooner than the TLC).
//   4. User claims the SOL by revealing the preimage on Solana. LP reads it from the claim
//      transaction and settles the hold invoice: the CKB is now the LP's.
//   5. No claim before the escrow expires -> LP refunds its SOL and cancels the invoice: the TLC
//      fails back and the user's CKB returns.
//
// SOL -> CKB (the user's Fiber node holds the secret):
//   1. User's node issues a normal Fiber invoice (sha256) for the quoted CKB; H is its payment hash.
//   2. User locks SOL in the escrow on H for the LP, expiring AFTER the LP's Fiber TLC can
//      (capped at 6 h 40 min) plus a margin, so the user can never take the CKB and then refund the SOL.
//   3. LP checks the escrow on chain (claimer, amount, time left) and pays the invoice.
//   4. The user's node settles, which hands the LP the preimage; LP claims the SOL with it.
//   5. If the payment fails, LP cancels the escrow (waives its claim) so the user's SOL returns at once.
//
// Pricing: mid-market CKB/USD and SOL/USD from CoinGecko (cached 60 s), minus --spread-bps.
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  Connection, PublicKey, Transaction, sendAndConfirmTransaction, cancelIx, claimIx, decodeEscrow, escrowPda,
  findClaimPreimage, loadKeypair, lockIx, refundIx, sha256,
} from "../solana/client/htlc-lib.mjs";
import { ckbChannels, ckbStr, findTlc, hexOf, rpc } from "./fiber-lib.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const FIBER = arg("fiber", "http://127.0.0.1:8237");
const PROGRAM_ID = new PublicKey(arg("program"));
const conn = new Connection(arg("sol-rpc", "https://api.devnet.solana.com"), "confirmed");
const lp = loadKeypair(arg("lp-key"));
const SPREAD_BPS = Number(arg("spread-bps", "40"));
const SOL_TTL = Number(arg("sol-ttl", "600"));            // forward: LP's escrow lifetime
const QUOTE_TTL = 120;                                     // seconds a quote can be turned into a swap
const PAY_WINDOW = 600;                                    // seconds to pay the invoice / fund the escrow
const FWD_MIN_TLC_MARGIN = 3600;                           // forward: held TLC must outlive the escrow by this
const REV_MARGIN = 20 * 60;                                // reverse: escrow must outlive the Fiber TLC by this
// Fiber adds a random reserve to TLC expiries (they can run to days). Capping the payment at
// final delta (160 min) + the 4 h reserve makes the TLC expire at exactly now + 6 h 40 min.
const FINAL_DELTA_MS = 9_600_000, TLC_LIMIT_MS = FINAL_DELTA_MS + 14_400_000;
const MIN_CKB = 100n * 10n ** 8n, MAX_CKB = 100_000n * 10n ** 8n;
const CURRENCY = arg("currency", "Fibt");
const STATE_FILE = arg("state", new URL("./lp-fiber-state.local.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const swaps = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
const quotes = new Map();
const save = () => writeFileSync(STATE_FILE, JSON.stringify(swaps, null, 1));
const now = () => Math.floor(Date.now() / 1000);
const log = (h, m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${h.slice(0, 8)} ${m}`);
const chainNow = async () => (await conn.getBlockTime(await conn.getSlot("confirmed"))) ?? now();
const hx = (h) => "0x" + h;
const sendSol = (ixs) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [lp], { commitment: "confirmed" });
const me = await rpc(FIBER, "node_info");

// --- pricing -------------------------------------------------------------------------------
let px = { ckb_usd: 0.00095, sol_usd: 85, at: 0, source: "fallback" };
async function prices() {
  if (Date.now() - px.at < 60_000) return px;
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=nervos-network,solana&vs_currencies=usd", { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    if (j["nervos-network"]?.usd && j.solana?.usd) px = { ckb_usd: j["nervos-network"].usd, sol_usd: j.solana.usd, at: Date.now(), source: "coingecko" };
  } catch { px = { ...px, at: Date.now() - 45_000 }; /* keep last, retry in 15 s */ }
  return px;
}
async function makeQuote(direction, amountIn) {
  const p = await prices();
  const solPerCkb = p.ckb_usd / p.sol_usd, keep = 1 - SPREAD_BPS / 10_000;
  let q;
  if (direction === "ckb2sol") {
    const shannons = BigInt(amountIn);
    if (shannons < MIN_CKB || shannons > MAX_CKB) throw new Error(`amount must be ${ckbStr(MIN_CKB)}..${ckbStr(MAX_CKB)} CKB`);
    const mid = (Number(shannons) / 1e8) * solPerCkb * 1e9;
    q = { shannons: shannons.toString(), lamports: Math.floor(mid * keep), mid_lamports: Math.floor(mid) };
  } else if (direction === "sol2ckb") {
    const lamports = Number(amountIn);
    const mid = (lamports / 1e9 / solPerCkb) * 1e8;
    const shannons = BigInt(Math.floor(mid * keep));
    if (shannons < MIN_CKB || shannons > MAX_CKB) throw new Error(`amount must buy ${ckbStr(MIN_CKB)}..${ckbStr(MAX_CKB)} CKB`);
    q = { lamports, shannons: shannons.toString(), mid_shannons: BigInt(Math.floor(mid)).toString() };
  } else throw new Error("direction must be ckb2sol or sol2ckb");
  const id = randomBytes(8).toString("hex");
  q = { quote_id: id, direction, ...q, spread_bps: SPREAD_BPS, ckb_usd: p.ckb_usd, sol_usd: p.sol_usd, price_source: p.source, expires: now() + QUOTE_TTL };
  quotes.set(id, q);
  for (const [k, v] of quotes) if (v.expires < now() - 60) quotes.delete(k);
  return q;
}
function takeQuote(id, direction) {
  const q = quotes.get(id);
  if (!q || q.direction !== direction) throw new Error("unknown quote");
  if (q.expires < now()) throw new Error("quote expired");
  quotes.delete(id);
  return q;
}

// --- swap creation -------------------------------------------------------------------------
async function createSwap(b) {
  const H = b.payment_hash;
  if (!/^[0-9a-f]{64}$/.test(H || "")) throw new Error("payment_hash must be 32 bytes hex");
  if (swaps[H]) throw new Error("swap for this hash exists");
  const q = takeQuote(b.quote_id, b.direction);
  const base = { payment_hash: H, direction: b.direction, shannons: q.shannons, lamports: q.lamports, quote: q, created: now(), deadline: now() + PAY_WINDOW };

  if (b.direction === "ckb2sol") {
    const claimer = new PublicKey(b.recipient);
    if ((await conn.getBalance(lp.publicKey)) < q.lamports + 5_000_000) throw new Error("LP has not enough SOL");
    const inv = await rpc(FIBER, "new_invoice", {
      amount: hexOf(q.shannons), currency: CURRENCY, description: `swap to ${q.lamports} lamports`, expiry: hexOf(PAY_WINDOW),
      payment_hash: hx(H), hash_algorithm: "sha256",
    });
    swaps[H] = { ...base, claimer: claimer.toBase58(), invoice: inv.invoice_address, escrow: escrowPda(PROGRAM_ID, lp.publicKey, Buffer.from(H, "hex")).toBase58(), status: "invoice_open" };
    log(H, `ckb2sol quote ${ckbStr(q.shannons)} CKB -> ${q.lamports} lamports for ${claimer.toBase58()}`);
  } else {
    const offerer = new PublicKey(b.offerer);
    const { invoice } = await rpc(FIBER, "parse_invoice", { invoice: b.invoice });
    const attr = (k) => invoice.data.attrs.find((a) => k in a)?.[k];
    if (invoice.data.payment_hash !== hx(H)) throw new Error("invoice hash != payment_hash");
    if (attr("hash_algorithm") !== "sha256") throw new Error("invoice must use sha256");
    if (invoice.currency !== CURRENCY) throw new Error(`invoice currency must be ${CURRENCY}`);
    if (BigInt(invoice.amount) > BigInt(q.shannons)) throw new Error(`invoice asks ${ckbStr(invoice.amount)} CKB > quoted ${ckbStr(q.shannons)}`);
    const out = (await ckbChannels(FIBER)).filter((c) => c.state === "ChannelReady").reduce((m, c) => (c.local > m ? c.local : m), 0n);
    if (out < BigInt(invoice.amount)) throw new Error(`LP has only ${ckbStr(out)} CKB outbound on Fiber`);
    if (BigInt(attr("final_htlc_minimum_expiry_delta") ?? hexOf(FINAL_DELTA_MS)) > BigInt(FINAL_DELTA_MS)) throw new Error("invoice final expiry delta too long");
    swaps[H] = { ...base, shannons: BigInt(invoice.amount).toString(), offerer: offerer.toBase58(), invoice: b.invoice, fiber_tlc_limit_s: TLC_LIMIT_MS / 1000,
      min_escrow_secs: TLC_LIMIT_MS / 1000 + REV_MARGIN, escrow: escrowPda(PROGRAM_ID, offerer, Buffer.from(H, "hex")).toBase58(), status: "awaiting_escrow" };
    log(H, `sol2ckb quote ${q.lamports} lamports -> ${ckbStr(invoice.amount)} CKB, escrow must live >= ${swaps[H].min_escrow_secs}s`);
  }
  save();
  return { ...swaps[H], lp: lp.publicKey.toBase58(), lp_fiber: me.pubkey, program: PROGRAM_ID.toBase58(), sol_ttl: SOL_TTL };
}

// --- state machines ------------------------------------------------------------------------
async function stepForward(s) {
  const H = Buffer.from(s.payment_hash, "hex");
  if (s.status === "invoice_open") {
    const inv = await rpc(FIBER, "get_invoice", { payment_hash: hx(s.payment_hash) });
    if (inv.status === "Received") {
      const tlc = await findTlc(FIBER, hx(s.payment_hash));
      const left = tlc ? Math.floor(tlc.expiry_ms / 1000) - now() : 0;
      s.fiber = { tlc_amount: tlc?.amount.toString(), tlc_secs_left: left, channel_id: tlc?.channel_id };
      if (!tlc || tlc.amount < BigInt(s.shannons) || left < SOL_TTL + FWD_MIN_TLC_MARGIN) {
        log(s.payment_hash, `held TLC not acceptable (${tlc ? `${ckbStr(tlc.amount)} CKB, ${left}s left` : "not found"}) -> cancel`);
        await rpc(FIBER, "cancel_invoice", { payment_hash: hx(s.payment_hash) });
        s.status = "canceled_unacceptable";
        return save();
      }
      const expiry = (await chainNow()) + SOL_TTL;
      const sig = await sendSol([lockIx(PROGRAM_ID, { offerer: lp.publicKey, hash: H, claimer: new PublicKey(s.claimer), amount: s.lamports, expiry })]);
      Object.assign(s, { status: "sol_locked", sol_lock_tx: sig, sol_expiry: expiry });
      log(s.payment_hash, `CKB TLC held (${ckbStr(tlc.amount)} CKB, ${left}s left) -> locked ${s.lamports} lamports until ${expiry}: ${sig}`);
      return save();
    }
    if (inv.status !== "Open" || now() > s.deadline) {
      if (inv.status === "Open") await rpc(FIBER, "cancel_invoice", { payment_hash: hx(s.payment_hash) });
      s.status = "expired_unpaid";
      log(s.payment_hash, `invoice ${inv.status}, never paid -> closed`);
      return save();
    }
    return;
  }
  if (s.status === "sol_locked") {
    const found = await findClaimPreimage(conn, PROGRAM_ID, new PublicKey(s.escrow), H);
    if (found) {
      await rpc(FIBER, "settle_invoice", { payment_hash: hx(s.payment_hash), payment_preimage: hx(found.preimage.toString("hex")) });
      Object.assign(s, { status: "settled", sol_claim_tx: found.signature, preimage: found.preimage.toString("hex") });
      log(s.payment_hash, `SOL claimed (${found.signature}) -> preimage learned -> Fiber invoice settled`);
      return save();
    }
    const e = decodeEscrow((await conn.getAccountInfo(new PublicKey(s.escrow)))?.data);
    if (e && (await chainNow()) >= e.expiry) {
      const sig = await sendSol([refundIx(PROGRAM_ID, { escrow: new PublicKey(s.escrow), offerer: lp.publicKey })]);
      await rpc(FIBER, "cancel_invoice", { payment_hash: hx(s.payment_hash) });
      Object.assign(s, { status: "refunded", sol_refund_tx: sig });
      log(s.payment_hash, `SOL unclaimed at expiry -> refunded (${sig}), Fiber invoice canceled`);
      return save();
    }
  }
}

async function stepReverse(s) {
  const H = Buffer.from(s.payment_hash, "hex"), escrow = new PublicKey(s.escrow), offerer = new PublicKey(s.offerer);
  if (s.status === "awaiting_escrow") {
    const e = decodeEscrow((await conn.getAccountInfo(escrow))?.data);
    if (!e) {
      if (now() > s.deadline) { s.status = "expired_unfunded"; log(s.payment_hash, "escrow never funded -> closed"); save(); }
      return;
    }
    const left = e.expiry - (await chainNow());
    s.sol = { amount: e.amount.toString(), secs_left: left };
    if (!e.claimer.equals(lp.publicKey) || !e.hash.equals(H) || e.amount < BigInt(s.lamports) || left < s.min_escrow_secs) {
      s.status = "rejected_escrow";
      log(s.payment_hash, `escrow not acceptable (amount ${e.amount}, ${left}s left, need >= ${s.min_escrow_secs}s) -> not paying`);
      if (e.claimer.equals(lp.publicKey)) s.sol_cancel_tx = await sendSol([cancelIx(PROGRAM_ID, { escrow, offerer, claimer: lp.publicKey })]);
      return save();
    }
    await rpc(FIBER, "send_payment", { invoice: s.invoice, tlc_expiry_limit: hexOf(TLC_LIMIT_MS) });
    s.status = "fiber_paying";
    log(s.payment_hash, `escrow ok (${e.amount} lamports, ${left}s left) -> paying ${ckbStr(s.shannons)} CKB over Fiber`);
    return save();
  }
  if (s.status === "fiber_paying") {
    const p = await rpc(FIBER, "get_payment", { payment_hash: hx(s.payment_hash) });
    if (p.status === "Success") {
      const pre = Buffer.from((p.payment_preimage || "").replace(/^0x/, ""), "hex");
      if (pre.length !== 32 || !sha256(pre).equals(H)) throw new Error("payment succeeded but no valid preimage returned");
      const sig = await sendSol([claimIx(PROGRAM_ID, { escrow, claimer: lp.publicKey, offerer, preimage: pre })]);
      Object.assign(s, { status: "settled", sol_claim_tx: sig, preimage: pre.toString("hex"), fiber_fee: p.fee });
      log(s.payment_hash, `Fiber payment settled -> preimage learned -> claimed ${s.lamports} lamports: ${sig}`);
      return save();
    }
    if (p.status === "Failed") {
      const sig = await sendSol([cancelIx(PROGRAM_ID, { escrow, offerer, claimer: lp.publicKey })]);
      Object.assign(s, { status: "canceled", fiber_error: p.failed_error, sol_cancel_tx: sig });
      log(s.payment_hash, `Fiber payment failed (${p.failed_error}) -> escrow canceled, SOL back to the user: ${sig}`);
      return save();
    }
  }
}

const LIVE = ["invoice_open", "sol_locked", "awaiting_escrow", "fiber_paying"];
let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  for (const s of Object.values(swaps)) {
    if (!LIVE.includes(s.status)) continue;
    try { await (s.direction === "ckb2sol" ? stepForward(s) : stepReverse(s)); } catch (e) { log(s.payment_hash, `error: ${e.message}`); }
  }
  busy = false;
}, 1500);

// --- HTTP ----------------------------------------------------------------------------------
async function info() {
  const ch = (await ckbChannels(FIBER)).filter((c) => c.state === "ChannelReady");
  const p = await prices();
  return {
    lp: lp.publicKey.toBase58(), lp_fiber: me.pubkey, program: PROGRAM_ID.toBase58(), spread_bps: SPREAD_BPS, sol_ttl: SOL_TTL,
    prices: { ckb_usd: p.ckb_usd, sol_usd: p.sol_usd, source: p.source }, min_ckb: ckbStr(MIN_CKB), max_ckb: ckbStr(MAX_CKB),
    liquidity: { sol_lamports: await conn.getBalance(lp.publicKey), ckb_outbound: ch.reduce((a, c) => a + c.local, 0n).toString(), ckb_inbound: ch.reduce((a, c) => a + c.remote, 0n).toString() },
  };
}
createServer(async (req, res) => {
  const reply = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  try {
    const u = new URL(req.url, "http://x");
    if (req.method === "GET" && u.pathname === "/info") return reply(200, await info());
    if (req.method === "GET" && u.pathname === "/quote") return reply(200, await makeQuote(u.searchParams.get("direction"), u.searchParams.get("amount")));
    if (req.method === "POST" && u.pathname === "/swap") {
      let body = ""; for await (const c of req) body += c;
      return reply(200, await createSwap(JSON.parse(body)));
    }
    const m = u.pathname.match(/^\/swap\/([0-9a-f]{64})$/);
    if (req.method === "GET" && m) return swaps[m[1]] ? reply(200, swaps[m[1]]) : reply(404, { error: "unknown swap" });
    reply(404, { error: "not found" });
  } catch (e) { reply(400, { error: e.message }); }
}).listen(Number(arg("port", "7071")), "127.0.0.1", () =>
  console.log(`LP sol=${lp.publicKey.toBase58()} fiber=${me.pubkey.slice(0, 16)}… on :${arg("port", "7071")}, spread ${SPREAD_BPS} bps, program ${PROGRAM_ID.toBase58()}`));

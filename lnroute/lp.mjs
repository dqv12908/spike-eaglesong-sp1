// Liquidity provider: sells SOL for Lightning BTC, atomically, with one SHA-256 payment hash.
//
//   node lp.mjs --lnd http://127.0.0.1:8180 --sol-rpc <url> --program <HTLC ID> --lp-key <keypair.json | env:FILE>
//               [--port 7070] [--rate-sol-per-btc 600] [--cltv 80] [--sol-ttl 600] [--quote-ttl 600]
//               [--min-blocks-left 12] [--state lp-state.json]
//
// Protocol (per swap):
//   1. The user sends payment_hash H (they keep the preimage), an amount in sats and a Solana
//      recipient. The LP quotes lamports and returns a Lightning HOLD invoice on H.
//   2. Someone pays the invoice (here: Fiber's Cross-Chain Hub, paid in turn by the user over
//      Fiber with the same H). LND holds the HTLC: the LP can't take the BTC yet, the payer can't
//      take it back before the HTLC's CLTV expiry.
//   3. Once the HTLC is held, with enough blocks left, the LP locks the quoted SOL in the Solana
//      HTLC escrow on H for the recipient, expiring well before the Lightning HTLC does.
//   4. The user claims the SOL by revealing the preimage on Solana. The LP reads it from the
//      claim transaction and settles the hold invoice; the BTC (and, upstream, the user's Fiber
//      payment to the hub) settles with the same preimage.
//   5. If the SOL isn't claimed before the escrow expires, the LP refunds itself and cancels the
//      hold invoice, so every upstream HTLC fails back and the user's Fiber payment returns.
// The LP never learns the preimage before SOL is claimed, and never locks SOL before BTC is held.
//
// Demo pricing: a fixed rate (--rate-sol-per-btc). A real LP would quote from a market.
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Connection, PublicKey, Transaction, sendAndConfirmTransaction, decodeEscrow, escrowPda, findClaimPreimage, loadKeypair, lockIx, refundIx } from "../solana/client/htlc-lib.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const LND = arg("lnd", "http://127.0.0.1:8180");
const PROGRAM_ID = new PublicKey(arg("program"));
const conn = new Connection(arg("sol-rpc", "http://127.0.0.1:8899"), "confirmed");
const lp = loadKeypair(arg("lp-key"));
const RATE = Number(arg("rate-sol-per-btc", "600"));
const CLTV = Number(arg("cltv", "80"));
const SOL_TTL = Number(arg("sol-ttl", "600"));
const QUOTE_TTL = Number(arg("quote-ttl", "600"));
const MIN_BLOCKS_LEFT = Number(arg("min-blocks-left", "12"));
const MIN_SATS = 1000, MAX_SATS = 1_000_000;
const STATE_FILE = arg("state", new URL("./lp-state.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const swaps = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
const save = () => writeFileSync(STATE_FILE, JSON.stringify(swaps, null, 1));
const now = () => Math.floor(Date.now() / 1000);
const b64 = (hex) => Buffer.from(hex, "hex").toString("base64");
const log = (h, m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${h.slice(0, 8)} ${m}`);

async function lnd(path, body) {
  const r = await fetch(LND + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (!r.ok) throw new Error(`lnd ${path}: ${JSON.stringify(j)}`);
  return j;
}
const chainNow = async () => (await conn.getBlockTime(await conn.getSlot("confirmed"))) ?? now();

async function createSwap({ payment_hash, sats, recipient }) {
  if (!/^[0-9a-f]{64}$/.test(payment_hash || "")) throw new Error("payment_hash must be 32 bytes hex");
  if (swaps[payment_hash]) throw new Error("swap for this hash exists");
  sats = Number(sats);
  if (!Number.isInteger(sats) || sats < MIN_SATS || sats > MAX_SATS) throw new Error(`sats must be ${MIN_SATS}..${MAX_SATS}`);
  const claimer = new PublicKey(recipient);
  const lamports = Math.floor((sats / 1e8) * RATE * 1e9);
  const bal = await conn.getBalance(lp.publicKey);
  if (bal < lamports + 10_000_000) throw new Error("LP has not enough SOL");
  // CCH requires >= 6 h of invoice validity; the LP enforces its own, shorter, quote TTL.
  const inv = await lnd("/v2/invoices/hodl", { hash: b64(payment_hash), value: String(sats), cltv_expiry: String(CLTV), expiry: String(7 * 3600), memo: `SOL swap ${lamports} lamports` });
  const s = swaps[payment_hash] = {
    payment_hash, sats, lamports, claimer: claimer.toBase58(), bolt11: inv.payment_request, created: now(),
    quote_expires: now() + QUOTE_TTL, escrow: escrowPda(PROGRAM_ID, lp.publicKey, Buffer.from(payment_hash, "hex")).toBase58(), status: "invoice_open",
  };
  save();
  log(payment_hash, `quote ${sats} sat -> ${lamports} lamports for ${s.claimer}`);
  return { ...s, lp: lp.publicKey.toBase58(), program: PROGRAM_ID.toBase58(), rate_sol_per_btc: RATE, sol_ttl: SOL_TTL };
}

async function step(s) {
  const H = Buffer.from(s.payment_hash, "hex");
  const inv = await lnd(`/v1/invoice/${s.payment_hash}`);
  if (s.status === "invoice_open") {
    if (inv.state === "ACCEPTED") {
      const held = (inv.htlcs || []).filter((h) => h.state === "ACCEPTED");
      const paid = held.reduce((a, h) => a + BigInt(h.amt_msat), 0n);
      const minExpiry = Math.min(...held.map((h) => Number(h.expiry_height)));
      const height = (await lnd("/v1/getinfo")).block_height;
      s.ln = { amt_paid_msat: paid.toString(), htlcs: held.length, expiry_height: minExpiry, height_at_accept: height };
      if (paid < BigInt(s.sats) * 1000n || minExpiry - height < MIN_BLOCKS_LEFT || now() > s.quote_expires) {
        log(s.payment_hash, `held HTLC not acceptable (paid ${paid} msat, ${minExpiry - height} blocks left, quote ${now() > s.quote_expires ? "expired" : "ok"}) -> cancel`);
        await lnd("/v2/invoices/cancel", { payment_hash: b64(s.payment_hash) });
        s.status = "canceled_unacceptable";
        return save();
      }
      const expiry = (await chainNow()) + SOL_TTL;
      const tx = new Transaction().add(lockIx(PROGRAM_ID, { offerer: lp.publicKey, hash: H, claimer: new PublicKey(s.claimer), amount: s.lamports, expiry }));
      const sig = await sendAndConfirmTransaction(conn, tx, [lp], { commitment: "confirmed" });
      Object.assign(s, { status: "sol_locked", sol_lock_tx: sig, sol_expiry: expiry });
      log(s.payment_hash, `BTC HTLC held (${paid} msat, ${minExpiry - height} blocks left) -> locked ${s.lamports} lamports, expiry ${expiry}: ${sig}`);
      return save();
    }
    if (now() > s.quote_expires && inv.state === "OPEN") {
      await lnd("/v2/invoices/cancel", { payment_hash: b64(s.payment_hash) });
      s.status = "quote_expired";
      log(s.payment_hash, "quote expired unpaid -> invoice canceled");
      return save();
    }
    return;
  }
  if (s.status === "sol_locked") {
    const found = await findClaimPreimage(conn, PROGRAM_ID, new PublicKey(s.escrow), H);
    if (found) {
      await lnd("/v2/invoices/settle", { preimage: found.preimage.toString("base64") });
      Object.assign(s, { status: "settled", sol_claim_tx: found.signature, preimage: found.preimage.toString("hex") });
      log(s.payment_hash, `SOL claimed (${found.signature}) -> preimage learned -> hold invoice settled`);
      return save();
    }
    const e = decodeEscrow((await conn.getAccountInfo(new PublicKey(s.escrow)))?.data);
    if (e && (await chainNow()) >= e.expiry) {
      const sig = await sendAndConfirmTransaction(conn, new Transaction().add(refundIx(PROGRAM_ID, { escrow: new PublicKey(s.escrow), offerer: lp.publicKey })), [lp], { commitment: "confirmed" });
      await lnd("/v2/invoices/cancel", { payment_hash: b64(s.payment_hash) });
      Object.assign(s, { status: "refunded", sol_refund_tx: sig });
      log(s.payment_hash, `SOL unclaimed at expiry -> refunded (${sig}) and hold invoice canceled`);
      return save();
    }
  }
}

setInterval(async () => {
  for (const s of Object.values(swaps)) {
    if (!["invoice_open", "sol_locked"].includes(s.status)) continue;
    try { await step(s); } catch (e) { log(s.payment_hash, `error: ${e.message}`); }
  }
}, 2000);

createServer(async (req, res) => {
  const reply = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  try {
    if (req.method === "POST" && req.url === "/swap") {
      let body = ""; for await (const c of req) body += c;
      return reply(200, await createSwap(JSON.parse(body)));
    }
    const m = req.url.match(/^\/swap\/([0-9a-f]{64})$/);
    if (req.method === "GET" && m) return swaps[m[1]] ? reply(200, swaps[m[1]]) : reply(404, { error: "unknown swap" });
    if (req.method === "GET" && req.url === "/info") return reply(200, { lp: lp.publicKey.toBase58(), program: PROGRAM_ID.toBase58(), rate_sol_per_btc: RATE, min_sats: MIN_SATS, max_sats: MAX_SATS, balance_lamports: await conn.getBalance(lp.publicKey) });
    reply(404, { error: "not found" });
  } catch (e) { reply(400, { error: e.message }); }
}).listen(Number(arg("port", "7070")), "127.0.0.1", () => console.log(`LP ${lp.publicKey.toBase58()} on :${arg("port", "7070")}, rate ${RATE} SOL/BTC, program ${PROGRAM_ID.toBase58()}`));

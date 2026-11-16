// User-side wallet backend + web UI server for the Fiber <-> Solana atomic swap demo.
//
//   node wallet.mjs --fiber http://127.0.0.1:8227 --lp http://127.0.0.1:7071 --sol-rpc <url> --sol-key <keypair.json | env:FILE>
//                   [--port 7080] [--cluster devnet] [--state wallet-state.local.json]
//
// It plays the user: it owns the user's Fiber node (CKB side) and a Solana key (pays claim fees,
// locks SOL for SOL -> CKB). The swap secret is generated here and never leaves this process until
// it is published on Solana by the claim. Serves ./ui and a small JSON API on 127.0.0.1 only.
//
//   GET  /api/status                         balances, channel, LP info
//   GET  /api/quote?direction=&amount=       amount in CKB (ckb2sol) or SOL (sol2ckb)
//   POST /api/swap {direction, amount, recipient?, walk_away?}
//   GET  /api/swaps | /api/swap/<id>
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection, PublicKey, Transaction, sendAndConfirmTransaction, claimIx, decodeEscrow, escrowPda, loadKeypair, lockIx, sha256,
} from "../solana/client/htlc-lib.mjs";
import { ckbChannels, ckbStr, hexOf, rpc, sleep } from "./fiber-lib.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIBER = arg("fiber", "http://127.0.0.1:8227"), LP = arg("lp", "http://127.0.0.1:7071");
const SOL_RPC = arg("sol-rpc", "https://api.devnet.solana.com");
const CLUSTER = arg("cluster", "devnet"), CKB_NET = arg("ckb-net", "testnet"), CURRENCY = arg("currency", "Fibt");
const conn = new Connection(SOL_RPC, "confirmed");
const wallet = loadKeypair(arg("sol-key"));
const STATE_FILE = arg("state", join(HERE, "wallet-state.local.json"));
const MIN_CLAIM_SECS = 60, REV_EXTRA_SECS = 300;
// Cap our outgoing TLC at 6 h 40 min (160 min final delta + Fiber's 4 h random reserve); uncapped it can run to days.
const TLC_LIMIT_MS = 24_000_000;

const swaps = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
for (const s of Object.values(swaps)) if (s.state === "running") { s.state = "interrupted"; s.error = "wallet restarted mid-swap"; }
const save = () => writeFileSync(STATE_FILE, JSON.stringify(swaps, null, 1));
const now = () => Math.floor(Date.now() / 1000);
const chainNow = async () => (await conn.getBlockTime(await conn.getSlot("confirmed"))) ?? now();
const solTx = (sig) => ({ label: `Solana tx ${sig.slice(0, 8)}…`, url: `https://explorer.solana.com/tx/${sig}?cluster=${CLUSTER}` });
const solAddr = (a, label) => ({ label: label ?? `${a.slice(0, 8)}…`, url: `https://explorer.solana.com/address/${a}?cluster=${CLUSTER}` });
const ckbTx = (h, label) => ({ label: label ?? `CKB tx ${h.slice(0, 10)}…`, url: `https://${CKB_NET === "mainnet" ? "" : "testnet."}explorer.nervos.org/transaction/${h}` });
const lpGet = async (path) => { const r = await fetch(LP + path); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; };
const lpPost = async (path, body) => {
  const r = await fetch(LP + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(`LP: ${j.error}`); return j;
};
const fiberMe = await rpc(FIBER, "node_info");

// --- status --------------------------------------------------------------------------------
async function status() {
  const out = { wallet_sol: wallet.publicKey.toBase58(), fiber_pubkey: fiberMe.pubkey, cluster: CLUSTER, ckb_net: CKB_NET, errors: [] };
  try {
    const lp = await lpGet("/info");
    out.lp = lp;
    const ch = (await ckbChannels(FIBER, lp.lp_fiber)).filter((c) => c.state === "ChannelReady");
    out.channel = {
      count: ch.length, can_send: ch.reduce((a, c) => a + c.local, 0n).toString(), can_receive: ch.reduce((a, c) => a + c.remote, 0n).toString(),
      in_flight: ch.reduce((a, c) => a + c.offered + c.received, 0n).toString(),
      funding: ch.map((c) => c.outpoint && ckbTx(c.outpoint.slice(0, 66), "channel funding tx")).filter(Boolean),
    };
  } catch (e) { out.errors.push(`LP or Fiber unreachable: ${e.message}`); }
  try { out.sol_lamports = await conn.getBalance(wallet.publicKey); } catch (e) { out.errors.push(`Solana RPC: ${e.message}`); }
  return out;
}
async function quote(direction, amount) {
  const amt = direction === "ckb2sol" ? BigInt(Math.round(Number(amount) * 1e8)).toString() : String(Math.round(Number(amount) * 1e9));
  return lpGet(`/quote?direction=${direction}&amount=${amt}`);
}

// --- swap engine ---------------------------------------------------------------------------
const STEPS = {
  ckb2sol: [
    ["quote", "Quote from the LP"],
    ["secret", "Secret generated in your wallet"],
    ["fiber_lock", "CKB locked on Fiber (hold invoice)"],
    ["sol_lock", "LP locks SOL in the Solana escrow"],
    ["sol_claim", "You claim the SOL, revealing the secret"],
    ["fiber_settle", "LP settles the Fiber payment with the secret"],
  ],
  sol2ckb: [
    ["quote", "Quote from the LP"],
    ["invoice", "Your Fiber node issues an invoice (it keeps the secret)"],
    ["sol_lock", "You lock SOL in the Solana escrow"],
    ["fiber_pay", "LP pays the invoice over Fiber; your node reveals the secret"],
    ["sol_claim", "LP claims the SOL with the secret"],
  ],
};
function newSwap(direction, amount, opts) {
  const id = randomBytes(6).toString("hex");
  const s = swaps[id] = { id, direction, amount, ...opts, state: "running", created: Date.now(),
    steps: STEPS[direction].map(([key, title]) => ({ key, title, status: "pending", detail: "", links: [] })) };
  return s;
}
function step(s, key, status, detail, links, title) {
  const st = s.steps.find((x) => x.key === key);
  st.status = status;
  if (title) st.title = title;
  if (detail !== undefined) st.detail = detail;
  if (links) st.links = links;
  st.at = Date.now() - s.created;
  save();
}
const active = (s, key, detail) => step(s, key, "active", detail);
const done = (s, key, detail, links) => step(s, key, "done", detail, links);

async function runCkb2Sol(s) {
  const recipient = new PublicKey(s.recipient);
  active(s, "quote", "asking the LP");
  const q = await quote("ckb2sol", s.amount);
  s.quote = q;
  done(s, "quote", `${ckbStr(q.shannons)} CKB → ${(q.lamports / 1e9).toFixed(9)} SOL (mid-market ${(q.mid_lamports / 1e9).toFixed(9)}, LP spread ${q.spread_bps / 100}%)`);

  const preimage = randomBytes(32), H = sha256(preimage), Hx = H.toString("hex");
  s.payment_hash = Hx;
  done(s, "secret", `H = sha256(secret) = ${Hx}. Only H is shared; the secret stays here.`);

  active(s, "fiber_lock", "requesting the hold invoice");
  const sw = await lpPost("/swap", { direction: "ckb2sol", quote_id: q.quote_id, payment_hash: Hx, recipient: recipient.toBase58() });
  const lpKey = new PublicKey(sw.lp), program = new PublicKey(sw.program), escrow = escrowPda(program, lpKey, H);
  if (escrow.toBase58() !== sw.escrow) throw new Error("LP's escrow address does not match (LP, H)");
  const { invoice } = await rpc(FIBER, "parse_invoice", { invoice: sw.invoice });
  if (invoice.data.payment_hash !== "0x" + Hx) throw new Error("the LP's invoice uses a different payment hash");
  if (BigInt(invoice.amount) !== BigInt(q.shannons)) throw new Error("the LP's invoice amount differs from the quote");
  await rpc(FIBER, "send_payment", { invoice: sw.invoice, tlc_expiry_limit: hexOf(TLC_LIMIT_MS) });
  done(s, "fiber_lock", `${ckbStr(q.shannons)} CKB is in flight to the LP's node, locked to H. The LP can't take it without the secret; if nothing happens it returns to you by itself.`);

  active(s, "sol_lock", "waiting for the LP's escrow on Solana");
  let e = null;
  for (let i = 0; i < 180 && !e; i++) {
    e = decodeEscrow((await conn.getAccountInfo(escrow))?.data);
    if (e) break;
    const p = await rpc(FIBER, "get_payment", { payment_hash: "0x" + Hx });
    if (p.status === "Failed") throw new Error(`Fiber payment failed before the LP locked SOL: ${p.failed_error}. Your CKB is back.`);
    await sleep(1000);
  }
  if (!e) throw new Error("the LP never locked SOL; the Fiber payment will fail back when the invoice is canceled");
  const left = e.expiry - (await chainNow());
  if (!e.claimer.equals(recipient)) throw new Error("the escrow pays someone else");
  if (e.amount < BigInt(q.lamports)) throw new Error(`the escrow holds ${e.amount} lamports, less than the quoted ${q.lamports}`);
  if (left < MIN_CLAIM_SECS) throw new Error("too little time left to claim safely");
  const lpState = await lpGet(`/swap/${Hx}`);
  done(s, "sol_lock", `${(Number(e.amount) / 1e9).toFixed(9)} SOL locked to H for ${recipient.toBase58().slice(0, 8)}…, ${left}s to claim.`,
    [lpState.sol_lock_tx && solTx(lpState.sol_lock_tx), solAddr(escrow.toBase58(), "escrow account")].filter(Boolean));

  if (s.walk_away) {
    step(s, "sol_claim", "skipped", "Walk-away test: not claiming. Waiting for the escrow to expire.", undefined, "You don't claim the SOL");
    active(s, "fiber_settle", `LP will refund its SOL in about ${left}s and cancel the invoice`);
    let p;
    for (let i = 0; i < left + 600; i++) {
      p = await rpc(FIBER, "get_payment", { payment_hash: "0x" + Hx });
      if (p.status === "Failed" || p.status === "Success") break;
      await sleep(1000);
    }
    const fin = await lpGet(`/swap/${Hx}`);
    if (p.status !== "Failed") throw new Error(`expected the Fiber payment to fail back, got ${p.status}`);
    step(s, "fiber_settle", "refunded", `LP refunded its SOL and canceled the invoice. Fiber payment failed back (${p.failed_error}); your CKB returned in full.`,
      [fin.sol_refund_tx && solTx(fin.sol_refund_tx)].filter(Boolean), "LP refunds its SOL; your CKB comes back");
    s.result = { outcome: "refunded" };
    return;
  }

  active(s, "sol_claim", "sending the claim");
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(claimIx(program, { escrow, claimer: recipient, offerer: lpKey, preimage })), [wallet], { commitment: "confirmed" });
  done(s, "sol_claim", `Claimed. The secret is now public in this transaction: ${preimage.toString("hex")}`, [solTx(sig)]);

  active(s, "fiber_settle", "waiting for the LP to settle");
  let p;
  for (let i = 0; i < 300; i++) {
    p = await rpc(FIBER, "get_payment", { payment_hash: "0x" + Hx });
    if (p.status === "Success" || p.status === "Failed") break;
    await sleep(500);
  }
  if (p.status !== "Success") throw new Error(`Fiber payment ended ${p.status}: ${p.failed_error}`);
  done(s, "fiber_settle", `Fiber payment settled. The LP now owns the ${ckbStr(q.shannons)} CKB.`);
  s.result = { outcome: "swapped", ckb: ckbStr(q.shannons), sol: Number(e.amount) / 1e9, recipient: recipient.toBase58() };
}

async function runSol2Ckb(s) {
  active(s, "quote", "asking the LP");
  const q = await quote("sol2ckb", s.amount);
  s.quote = q;
  const lpInfo = await lpGet("/info");
  const ch = (await ckbChannels(FIBER, lpInfo.lp_fiber)).filter((c) => c.state === "ChannelReady");
  const canReceive = ch.reduce((m, c) => (c.remote > m ? c.remote : m), 0n);
  if (canReceive < BigInt(q.shannons)) throw new Error(`your channel can receive only ${ckbStr(canReceive)} CKB; swap CKB → SOL first or ask for less`);
  if ((await conn.getBalance(wallet.publicKey)) < q.lamports + 5_000_000) throw new Error("not enough SOL in the wallet");
  done(s, "quote", `${(q.lamports / 1e9).toFixed(9)} SOL → ${ckbStr(q.shannons)} CKB (mid-market ${ckbStr(q.mid_shannons)}, LP spread ${q.spread_bps / 100}%)`);

  active(s, "invoice", "creating the invoice");
  const inv = await rpc(FIBER, "new_invoice", { amount: hexOf(q.shannons), currency: CURRENCY, description: "SOL to CKB swap", expiry: hexOf(600), hash_algorithm: "sha256" });
  const Hx = inv.invoice.data.payment_hash.replace(/^0x/, ""), H = Buffer.from(Hx, "hex");
  s.payment_hash = Hx;
  const sw = await lpPost("/swap", { direction: "sol2ckb", quote_id: q.quote_id, payment_hash: Hx, invoice: inv.invoice_address, offerer: wallet.publicKey.toBase58() });
  done(s, "invoice", `Invoice for ${ckbStr(q.shannons)} CKB, payment hash H = ${Hx}. Your node holds the secret and reveals it only when the CKB arrives.`);
  // Failure test: withdraw the invoice so the LP's payment fails after the SOL is already locked.
  if (s.walk_away) await rpc(FIBER, "cancel_invoice", { payment_hash: "0x" + Hx });

  active(s, "sol_lock", "locking SOL");
  const lpKey = new PublicKey(sw.lp), program = new PublicKey(sw.program), escrow = escrowPda(program, wallet.publicKey, H);
  const ttl = sw.min_escrow_secs + REV_EXTRA_SECS;
  const expiry = (await chainNow()) + ttl;
  const lockSig = await sendAndConfirmTransaction(conn, new Transaction().add(lockIx(program, { offerer: wallet.publicKey, hash: H, claimer: lpKey, amount: q.lamports, expiry })), [wallet], { commitment: "confirmed" });
  done(s, "sol_lock", `${(q.lamports / 1e9).toFixed(9)} SOL locked to H for the LP. It expires in ${Math.round(ttl / 60)} min, after the LP's Fiber payment can time out (${Math.round(sw.fiber_tlc_limit_s / 60)} min), so the CKB can't be taken and the SOL refunded too. If the payment fails, the LP cancels and the SOL returns at once.`,
    [solTx(lockSig), solAddr(escrow.toBase58(), "escrow account")]);

  active(s, "fiber_pay", "waiting for the LP's payment");
  let fin;
  for (let i = 0; i < 600; i++) {
    fin = await lpGet(`/swap/${Hx}`);
    if (!["awaiting_escrow", "fiber_paying"].includes(fin.status)) break;
    await sleep(700);
  }
  if (fin.status !== "settled") {
    const why = fin.status === "canceled" ? `the LP's Fiber payment failed (${fin.fiber_error}) and it canceled the escrow: your SOL is back` : `LP status ${fin.status}`;
    if (fin.status !== "canceled") throw new Error(why);
    step(s, "fiber_pay", "refunded", `${s.walk_away ? "Failure test: the invoice was withdrawn, so " : ""}${why}.`, [fin.sol_cancel_tx && solTx(fin.sol_cancel_tx)].filter(Boolean), "LP's Fiber payment fails; it cancels the escrow");
    step(s, "sol_claim", "skipped", "Nothing to claim: the LP waived the escrow.");
    s.result = { outcome: "refunded" };
    return;
  }
  const paid = await rpc(FIBER, "get_invoice", { payment_hash: "0x" + Hx });
  done(s, "fiber_pay", `Received ${ckbStr(q.shannons)} CKB on Fiber (invoice ${paid.status}).`);
  done(s, "sol_claim", `The LP claimed the SOL using the secret your node revealed: ${fin.preimage}`, [solTx(fin.sol_claim_tx)]);
  s.result = { outcome: "swapped", ckb: ckbStr(q.shannons), sol: q.lamports / 1e9 };
}

async function startSwap({ direction, amount, recipient, walk_away }) {
  if (!STEPS[direction]) throw new Error("direction must be ckb2sol or sol2ckb");
  if (!(Number(amount) > 0)) throw new Error("amount must be positive");
  if (Object.values(swaps).some((x) => x.state === "running")) throw new Error("a swap is already running");
  const rcpt = direction === "ckb2sol" ? new PublicKey(recipient || wallet.publicKey.toBase58()).toBase58() : undefined;
  const s = newSwap(direction, String(amount), { recipient: rcpt, walk_away: !!walk_away });
  save();
  (direction === "ckb2sol" ? runCkb2Sol(s) : runSol2Ckb(s))
    .then(() => { s.state = "done"; })
    .catch((e) => {
      s.state = "failed"; s.error = e.message;
      const a = s.steps.find((x) => x.status === "active");
      if (a) { a.status = "failed"; a.detail = e.message; }
    })
    .finally(() => { s.elapsed_ms = Date.now() - s.created; save(); console.log(`[${s.id}] ${direction} ${s.state}${s.error ? ": " + s.error : ""} in ${(s.elapsed_ms / 1000).toFixed(1)}s`); });
  return s;
}

// --- HTTP ----------------------------------------------------------------------------------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" };
const PORT = Number(arg("port", "7080"));
const localOrigin = (o) => !o || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
createServer(async (req, res) => {
  const json = (code, body) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
  try {
    const u = new URL(req.url, "http://x");
    if (u.pathname.startsWith("/api/")) {
      if (!localOrigin(req.headers.origin)) return json(403, { error: "local use only" });
      if (req.method === "GET" && u.pathname === "/api/status") return json(200, await status());
      if (req.method === "GET" && u.pathname === "/api/quote") return json(200, await quote(u.searchParams.get("direction"), u.searchParams.get("amount")));
      if (req.method === "GET" && u.pathname === "/api/swaps") return json(200, Object.values(swaps).sort((a, b) => b.created - a.created).slice(0, 30));
      const m = u.pathname.match(/^\/api\/swap\/([0-9a-f]{12})$/);
      if (req.method === "GET" && m) return swaps[m[1]] ? json(200, swaps[m[1]]) : json(404, { error: "unknown swap" });
      if (req.method === "POST" && u.pathname === "/api/swap") {
        if (!(req.headers["content-type"] || "").startsWith("application/json")) return json(415, { error: "json only" });
        let body = ""; for await (const c of req) body += c;
        return json(200, await startSwap(JSON.parse(body)));
      }
      return json(404, { error: "not found" });
    }
    const rel = normalize(u.pathname === "/" ? "index.html" : u.pathname.slice(1));
    if (rel.startsWith("..")) { res.writeHead(403); return res.end(); }
    const file = join(HERE, "ui", rel);
    if (!existsSync(file)) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(readFileSync(file));
  } catch (e) { json(400, { error: e.message }); }
}).listen(PORT, "127.0.0.1", () => console.log(`wallet UI on http://127.0.0.1:${PORT}  (fiber ${fiberMe.pubkey.slice(0, 16)}…, sol ${wallet.publicKey.toBase58()}, LP ${LP})`));

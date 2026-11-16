// Script a swap through the wallet backend and print the step log (same API the web UI uses).
//   node run-swap.mjs --direction ckb2sol --amount 500 [--recipient <sol address>] [--walk-away] [--out report.json] [--wallet http://127.0.0.1:7080]
import { writeFileSync } from "node:fs";
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const W = arg("wallet", "http://127.0.0.1:7080");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p) => (await fetch(W + p)).json();
const before = await get("/api/status");
const r = await fetch(W + "/api/swap", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ direction: arg("direction", "ckb2sol"), amount: arg("amount", "500"), recipient: arg("recipient"), walk_away: process.argv.includes("--walk-away") }) });
let s = await r.json();
if (!r.ok) { console.error("error:", s.error); process.exit(1); }
const seen = {};
for (;;) {
  s = await get(`/api/swap/${s.id}`);
  for (const st of s.steps) {
    const k = `${st.key}:${st.status}`;
    if (st.status !== "pending" && !seen[k]) { seen[k] = 1; console.log(`[${((st.at ?? 0) / 1000).toFixed(1)}s] ${st.status.toUpperCase().padEnd(8)} ${st.title}\n           ${st.detail}${st.links.map((l) => `\n           ${l.url}`).join("")}`); }
  }
  if (s.state !== "running") break;
  await sleep(500);
}
await sleep(1500);
const after = await get("/api/status");
const bal = (x) => ({ sol: x.sol_lamports / 1e9, ckb_can_send: Number(x.channel.can_send) / 1e8, ckb_can_receive: Number(x.channel.can_receive) / 1e8, lp_sol: x.lp.liquidity.sol_lamports / 1e9 });
console.log(`${s.state.toUpperCase()} in ${(s.elapsed_ms / 1000).toFixed(1)}s`, s.error ?? "", JSON.stringify(s.result ?? {}));
console.log("before", JSON.stringify(bal(before)), "\nafter ", JSON.stringify(bal(after)));
if (arg("out")) writeFileSync(arg("out"), JSON.stringify({ swap: s, before: bal(before), after: bal(after) }, null, 1));
process.exit(s.state === "done" ? 0 : 1);

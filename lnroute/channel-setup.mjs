// Open the user's wrapped-BTC Fiber channel to the hub (node 1 -> node 3), as in Fiber's CCH e2e test.
//   node channel-setup.mjs [--fiber-rpc http://127.0.0.1:21714] [--hub-rpc http://127.0.0.1:21716] [--amount 200000]
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const FIBER = arg("fiber-rpc", "http://127.0.0.1:21714"), HUB = arg("hub-rpc", "http://127.0.0.1:21716");
const NODE3_ADDR = "/ip4/127.0.0.1/tcp/8346/p2p/QmaFDJb9CkMrXy7nhTWBY5y9mvuykre3EzzRsCJUAVXprZ";
const NODE3_PUBKEY = "03032b99943822e721a651c5a5b9621043017daa9dc3ec81d83215fd2e25121187";
export const WBTC = { code_hash: "0xe1e354d6d643ad42724d40967e334984534e0367405c5ae42a9d7d63d77df419", hash_type: "data2", args: "0x32e555f3ff8e135cece1351a6a2971518392c1e30375c1e006ad0ce8eac07947" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let id = 0;
async function rpc(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params === undefined ? [] : [params] }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

const info1 = await rpc(FIBER, "node_info"), info3 = await rpc(HUB, "node_info");
console.log("user node", info1.pubkey ?? info1.node_id, "hub node", info3.pubkey ?? info3.node_id);
const ready = (await rpc(FIBER, "list_channels", { pubkey: NODE3_PUBKEY })).channels.filter((c) => c.funding_udt_type_script?.args === WBTC.args && c.state.state_name === "ChannelReady");
if (ready.length) {
  console.log("channel already ready:", ready[0].channel_id, "local", BigInt(ready[0].local_balance));
  process.exit(0);
}
await rpc(FIBER, "connect_peer", { address: NODE3_ADDR });
await sleep(1500);
const open = await rpc(FIBER, "open_channel", { pubkey: NODE3_PUBKEY, funding_amount: "0x" + BigInt(arg("amount", "200000")).toString(16), funding_udt_type_script: WBTC });
console.log("open_channel", open.temporary_channel_id);
for (let i = 0; i < 90; i++) {
  const ch = (await rpc(FIBER, "list_channels", { pubkey: NODE3_PUBKEY })).channels.find((c) => c.funding_udt_type_script?.args === WBTC.args);
  if (ch) console.log(`  ${ch.state.state_name} local=${BigInt(ch.local_balance)} remote=${BigInt(ch.remote_balance)}`);
  if (ch?.state.state_name === "ChannelReady") { console.log("READY", ch.channel_id); process.exit(0); }
  await sleep(2000);
}
throw new Error("channel did not become ready");

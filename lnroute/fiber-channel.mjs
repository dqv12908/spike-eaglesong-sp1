// Open the user's CKB channel to the LP on CKB testnet and wait until it is ready.
//   node fiber-channel.mjs [--user http://127.0.0.1:8227] [--lp http://127.0.0.1:8237] [--lp-addr /ip4/127.0.0.1/tcp/8238] [--ckb 1000]
import { ckbChannels, ckbStr, hexOf, rpc, sleep, SHANNONS } from "./fiber-lib.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const USER = arg("user", "http://127.0.0.1:8227"), LP = arg("lp", "http://127.0.0.1:8237");
const u = await rpc(USER, "node_info"), l = await rpc(LP, "node_info");
console.log(`user ${u.pubkey}\nlp   ${l.pubkey}`);

const show = (c) => `${c.state} local ${ckbStr(c.local)} remote ${ckbStr(c.remote)} CKB${c.outpoint ? " funding " + c.outpoint.slice(0, 66) : ""}`;
let chans = await ckbChannels(USER, l.pubkey);
if (!chans.some((c) => c.state === "ChannelReady")) {
  await rpc(USER, "connect_peer", { pubkey: l.pubkey, address: arg("lp-addr", "/ip4/127.0.0.1/tcp/8238"), save: true });
  await sleep(3000);
  if (!chans.length) {
    const r = await rpc(USER, "open_channel", { pubkey: l.pubkey, funding_amount: hexOf(BigInt(arg("ckb", "1000")) * SHANNONS), public: false });
    console.log("open_channel", r.temporary_channel_id);
  }
  let last = "";
  for (let i = 0; i < 240; i++) {
    chans = await ckbChannels(USER, l.pubkey);
    const s = chans.map(show).join(" | ");
    if (s !== last) console.log(new Date().toISOString().slice(11, 19), s || "(no channel yet)");
    last = s;
    if (chans.some((c) => c.state === "ChannelReady")) break;
    await sleep(5000);
  }
}
const ready = chans.find((c) => c.state === "ChannelReady");
if (!ready) throw new Error("channel did not become ready");
console.log("READY", ready.channel_id, show(ready));

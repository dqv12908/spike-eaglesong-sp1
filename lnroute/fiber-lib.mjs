// Minimal Fiber (fnn) JSON-RPC helpers shared by the LP, the wallet backend and the scripts.
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const hexOf = (n) => "0x" + BigInt(n).toString(16);
export const SHANNONS = 100_000_000n;
export const ckbStr = (shannons) => {
  const s = BigInt(shannons), neg = s < 0n, a = neg ? -s : s;
  const frac = (a % SHANNONS).toString().padStart(8, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${a / SHANNONS}${frac ? "." + frac : ""}`;
};

let id = 0;
export async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params === undefined ? [] : [params] }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
}

// CKB (non-UDT) channels with `peer`, ready ones first.
export async function ckbChannels(url, peerPubkey) {
  const { channels } = await rpc(url, "list_channels", peerPubkey ? { pubkey: peerPubkey } : {});
  return channels.filter((c) => !c.funding_udt_type_script).map((c) => ({
    channel_id: c.channel_id, state: c.state.state_name, outpoint: c.channel_outpoint,
    local: BigInt(c.local_balance), remote: BigInt(c.remote_balance),
    offered: BigInt(c.offered_tlc_balance ?? "0x0"), received: BigInt(c.received_tlc_balance ?? "0x0"),
    pending_tlcs: c.pending_tlcs ?? [],
  }));
}

// The pending TLC carrying `paymentHash` (0x-hex) on any channel of this node, if any.
export async function findTlc(url, paymentHash) {
  const { channels } = await rpc(url, "list_channels", {});
  for (const c of channels) {
    for (const t of c.pending_tlcs ?? []) {
      if (t.payment_hash === paymentHash) return { channel_id: c.channel_id, amount: BigInt(t.amount), expiry_ms: Number(BigInt(t.expiry)), status: t.status };
    }
  }
  return null;
}

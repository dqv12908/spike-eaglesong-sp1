"""Fetch everything needed to prove a CKB deposit cell, into a JSON fixture.

Usage: python -I fetch_deposit.py TX_HASH OUT_INDEX CONFIRMATIONS PRE OUT.json
  headers   : B..=B+CONFIRMATIONS (B = block containing TX_HASH)  -> deposit proof (hash linkage)
  segment   : B-PRE+1..=B+CONFIRMATIONS                           -> light-client segment proof (PoW)
  segment_parent : header B-PRE (checkpoint); the segment proof checks epoch/difficulty from it
  checkpoint: B-PRE                                               -> trusted light-client anchor
Also cross-checks tx hash, CBMT proof and the output's lock hash independently of the Rust code.
Env CKB_NET=testnet|mainnet (default testnet), CKB_RPC overrides the URL.
"""
import hashlib, json, os, sys, urllib.request

NET = os.environ.get("CKB_NET", "testnet")
URL = os.environ.get("CKB_RPC") or {"testnet": "https://testnet.ckb.dev/rpc", "mainnet": "https://mainnet.ckb.dev/rpc"}[NET]


def rpc(m, p):
    body = json.dumps({"id": 1, "jsonrpc": "2.0", "method": m, "params": p}).encode()
    req = urllib.request.Request(URL, data=body, headers={"content-type": "application/json", "User-Agent": "ckb-spike/0.1"})
    r = json.loads(urllib.request.urlopen(req, timeout=60).read())
    if "error" in r:
        raise RuntimeError(r["error"])
    return r["result"]


def ckbhash(b):
    return hashlib.blake2b(b, digest_size=32, person=b"ckb-default-hash").digest()


def h2b(h):
    return bytes.fromhex(h[2:])


def script_bytes(s):
    ht = {"data": 0, "type": 1, "data1": 2, "data2": 4}[s["hash_type"]]
    args = h2b(s["args"])
    fields = [h2b(s["code_hash"]), bytes([ht]), len(args).to_bytes(4, "little") + args]
    hdr = 4 + 4 * len(fields)
    offs, o = [], hdr
    for f in fields:
        offs.append(o); o += len(f)
    return o.to_bytes(4, "little") + b"".join(x.to_bytes(4, "little") for x in offs) + b"".join(fields)


def main():
    tx_hash, out_index, conf, pre, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
    t0 = rpc("get_transaction", [tx_hash, "0x0"])
    t2 = rpc("get_transaction", [tx_hash])
    st = t0["tx_status"]
    assert st["status"] == "committed", st
    blk_hash, B = st["block_hash"], int(st["block_number"], 16)
    full = h2b(t0["transaction"])
    o0, o1 = int.from_bytes(full[4:8], "little"), int.from_bytes(full[8:12], "little")
    raw = full[o0:o1]
    assert "0x" + ckbhash(raw).hex() == tx_hash, "tx hash mismatch"
    tip = int(rpc("get_tip_block_number", []), 16)
    assert tip >= B + conf, f"need {B + conf - tip} more blocks"
    hdrs = {n: rpc("get_header_by_number", [hex(n)]) for n in range(B - pre, B + conf + 1)}
    assert hdrs[B]["hash"] == blk_hash
    p = rpc("get_transaction_proof", [[tx_hash], blk_hash])
    # independent CBMT check
    i, node = int(p["proof"]["indices"][0], 16), ckbhash(raw)
    for lem in p["proof"]["lemmas"]:
        node = ckbhash(node + h2b(lem)) if i & 1 else ckbhash(h2b(lem) + node)
        i = (i - 1) >> 1
    assert i == 0 and "0x" + ckbhash(node + h2b(p["witnesses_root"])).hex() == hdrs[B]["transactions_root"]
    output = t2["transaction"]["outputs"][out_index]
    data = t2["transaction"]["outputs_data"][out_index]
    fx = {
        "network": f"ckb-{NET}", "tx_hash": tx_hash, "out_index": out_index,
        "block_number": B, "block_hash": blk_hash, "confirmations": conf,
        "raw_tx": "0x" + raw.hex(),
        "tree_index": int(p["proof"]["indices"][0], 16), "lemmas": p["proof"]["lemmas"], "witnesses_root": p["witnesses_root"],
        "checkpoint": {"number": B - pre, "hash": hdrs[B - pre]["hash"]},
        "headers": [hdrs[n] for n in range(B, B + conf + 1)],
        "segment_parent": hdrs[B - pre],  # checkpoint header: the segment continues it
        "segment": [hdrs[n] for n in range(B - pre + 1, B + conf + 1)],
        "expect": {
            "capacity": int(output["capacity"], 16),
            "lock_hash": "0x" + ckbhash(script_bytes(output["lock"])).hex(),
            "has_type": output["type"] is not None,
            "data": data,
            "anchor_number": B + conf, "anchor_hash": hdrs[B + conf]["hash"],
        },
    }
    with open(out, "w", encoding="utf-8") as f:
        json.dump(fx, f, indent=1)
    print(f"tx {tx_hash[:12]}… in #{B}, anchor #{B + conf}, checkpoint #{B - pre}, segment {pre + conf} headers -> {out}")


if __name__ == "__main__":
    main()

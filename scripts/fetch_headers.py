"""Fetch CKB mainnet headers into a JSON fixture.

Usage: python -I fetch_headers.py OUT.json [RUN_LEN] [DEPTH]
  - a run of RUN_LEN consecutive headers ending DEPTH blocks below tip
  - plus sparse samples from different eras (exercise difficulty / epoch encodings)
Cross-checks every header against a second public RPC.
"""
import json, os, sys, urllib.request

NET = os.environ.get("CKB_NET", "mainnet")
RPCS = {
    "mainnet": ["https://mainnet.ckb.dev/rpc", "https://mainnet.ckbapp.dev/rpc"],
    "testnet": ["https://testnet.ckb.dev/rpc", "https://testnet.ckb.dev/rpc"],
}[NET]


def rpc_batch(url, calls):
    body = json.dumps([{"id": i, "jsonrpc": "2.0", "method": m, "params": p} for i, (m, p) in enumerate(calls)]).encode()
    req = urllib.request.Request(url, data=body, headers={"content-type": "application/json", "User-Agent": "ckb-spike/0.1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        res = json.loads(r.read())
    res.sort(key=lambda x: x["id"])
    for x in res:
        if "error" in x:
            raise RuntimeError(x["error"])
    return [x["result"] for x in res]


def headers(url, numbers):
    out = []
    for i in range(0, len(numbers), 50):
        out += rpc_batch(url, [("get_header_by_number", [hex(n)]) for n in numbers[i:i + 50]])
    return out


def main():
    out = sys.argv[1]
    run_len = int(sys.argv[2]) if len(sys.argv) > 2 else 256
    depth = int(sys.argv[3]) if len(sys.argv) > 3 else 2000
    tip = int(rpc_batch(RPCS[0], [("get_tip_header", [])])[0]["number"], 16)
    end = tip - depth
    run = list(range(end - run_len + 1, end + 1))
    samples = [n for n in [1, 2, 1_000, 100_000, 1_000_000, 5_000_000, 10_000_000, 15_000_000, 20_000_000] if n < end]
    a = headers(RPCS[0], run)
    b = headers(RPCS[1], run)
    assert a == b, "RPC disagreement on run"
    sa = headers(RPCS[0], samples)
    sb = headers(RPCS[1], samples)
    assert sa == sb, "RPC disagreement on samples"
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"network": f"ckb-{NET}", "tip_at_fetch": tip, "run": a, "samples": sa}, f, indent=1)
    print(f"tip={tip} run={run[0]}..{run[-1]} ({len(a)}) samples={len(sa)} -> {out}")


if __name__ == "__main__":
    main()

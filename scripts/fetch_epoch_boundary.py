"""Fetch headers around an epoch boundary (for the epoch / difficulty transition tests).

Usage: CKB_NET=testnet|mainnet python -I fetch_epoch_boundary.py OUT.json [BACK=5]
Picks the start of the epoch BACK epochs before the current one and writes
parent (start-4), run (start-3 .. start+3).
"""
import json, os, sys, urllib.request

NET = os.environ.get("CKB_NET", "testnet")
URL = {"mainnet": "https://mainnet.ckb.dev/rpc", "testnet": "https://testnet.ckb.dev/rpc"}[NET]


def rpc(m, p):
    body = json.dumps({"id": 1, "jsonrpc": "2.0", "method": m, "params": p}).encode()
    req = urllib.request.Request(URL, data=body, headers={"content-type": "application/json", "User-Agent": "ckb-spike/0.1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())["result"]


back = int(sys.argv[2]) if len(sys.argv) > 2 else 5
cur = int(rpc("get_current_epoch", [])["number"], 16)
ep = rpc("get_epoch_by_number", [hex(cur - back)])
start = int(ep["start_number"], 16)
hs = [rpc("get_header_by_number", [hex(n)]) for n in range(start - 4, start + 4)]
json.dump({"network": f"ckb-{NET}", "epoch_start": start, "parent": hs[0], "run": hs[1:]}, open(sys.argv[1], "w"), indent=1)
print(f"{NET}: epoch {cur - back} starts at #{start}; parent #{start - 4}, run #{start - 3}..#{start + 3}")

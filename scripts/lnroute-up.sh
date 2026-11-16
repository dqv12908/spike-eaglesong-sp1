#!/usr/bin/env bash
# Bring up the local CKB/Fiber <-> Lightning stack from Fiber v0.9.1's own test harness:
#   bitcoind regtest + LND "ingrid" (the hub's LND) + LND "bob" (the SOL LP's LND), channel ingrid->bob;
#   CKB dev chain with the wrapped-BTC UDT; Fiber node 1 (the user) and node 3 (hub, CCH enabled).
# Stays in the foreground (run as a background job); a block producer mines a CKB block every 2 s.
# Ready when ~/lnroute/READY exists. Logs in ~/lnroute/logs.
set -euo pipefail
export PATH="$HOME/lnroute/bin:$HOME/.cargo/bin:$PATH"
source "$HOME/.cargo/env"
R=~/lnroute; S=$R/fiber-src; L=$R/logs
rm -f $R/READY; mkdir -p $L
cd $S
trap 'kill $(jobs -p) 2>/dev/null; pkill -f "lnd --lnddir" ; pkill -x bitcoind; true' EXIT

echo "== lnd"
./tests/deploy/lnd-init/setup-lnd.sh > $L/setup-lnd.log 2>&1
tail -3 $L/setup-lnd.log

echo "== ckb dev chain init"
./tests/deploy/init-dev-chain.sh ${RESET:+-f} > $L/init-dev-chain.log 2>&1 || { tail -40 $L/init-dev-chain.log; exit 1; }
tail -3 $L/init-dev-chain.log

ckb run -C "$S/tests/deploy/node-data" --indexer > $L/ckb.log 2>&1 &
for i in $(seq 60); do nc -z 127.0.0.1 8114 && break; sleep 1; done

cd tests/nodes
export RUST_LOG=info,fnn=debug,fnn::fiber::gossip=off,fnn::fiber::graph=off,fnn::utils::actor=off
FIBER_SECRET_KEY_PASSWORD=password1 fnn -d 1 > $L/fnn1.log 2>&1 &
FIBER_SECRET_KEY_PASSWORD=password3 fnn -d 3 > $L/fnn3.log 2>&1 &
cd $S

( set +e; while true; do curl -s -o /dev/null -H 'content-type: application/json' -d '{"id":1,"jsonrpc":"2.0","method":"generate_block","params":[]}' http://127.0.0.1:8114; sleep 2; done ) &

for p in 21714 21716; do for i in $(seq 90); do nc -z 127.0.0.1 $p && break; sleep 1; done; done
nc -z 127.0.0.1 21714 && nc -z 127.0.0.1 21716 && touch $R/READY && echo "== READY"
wait

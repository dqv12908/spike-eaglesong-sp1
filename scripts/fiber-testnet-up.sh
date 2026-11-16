#!/usr/bin/env bash
# Run two Fiber v0.9.1 nodes on CKB *testnet* (WSL): the user's wallet node and the LP's node.
#   user: RPC 127.0.0.1:8227, P2P 8228, CKB key = WALLET_4 from the .env
#   lp:   RPC 127.0.0.1:8237, P2P 8238, CKB key = WALLET_5
# Keys are copied from the .env into ~/lnroute/testnet/<node>/ckb/key (mode 600, outside the repo);
# fnn encrypts them in place with FIBER_SECRET_KEY_PASSWORD on first start. Foreground job.
set -euo pipefail
export PATH="$HOME/lnroute/bin:$PATH"
ENVF=${ENVF:-/mnt/e/ckbuilder/testnet/.env}
T=~/lnroute/testnet; SRC=~/lnroute/fiber-src/config/testnet/config.yml
val() { grep -E "^\s*$1\s*=" "$ENVF" | head -1 | sed -E 's/^[^=]*=\s*//; s/^["'"'"']//; s/["'"'"']\s*$//'; }
export FIBER_SECRET_KEY_PASSWORD="$(val FIBER_SECRET_KEY_PASSWORD)"
[ -n "$FIBER_SECRET_KEY_PASSWORD" ] || { echo "FIBER_SECRET_KEY_PASSWORD missing in $ENVF"; exit 1; }

setup() { # name wallet_index rpc_port p2p_port
  local d=$T/$1
  mkdir -p "$d/ckb"
  if [ ! -f "$d/ckb/key" ]; then
    ( umask 077; val "WALLET_$2_PRIVKEY" | sed 's/^0x//' | tr -d '\n' > "$d/ckb/key" )
  fi
  sed -e "s|/ip4/0.0.0.0/tcp/8228|/ip4/127.0.0.1/tcp/$4|" -e "s|127.0.0.1:8227|127.0.0.1:$3|" \
      -e "s|announce_listening_addr: true|announce_listening_addr: false|" "$SRC" > "$d/config.yml"
}
setup user 4 8227 8228
setup lp   5 8237 8238
trap 'kill $(jobs -p) 2>/dev/null; true' EXIT
export RUST_LOG=info
for n in user lp; do ( cd $T/$n && exec fnn -c config.yml -d . > $T/$n.log 2>&1 ) & done
for p in 8227 8237; do for i in $(seq 120); do nc -z 127.0.0.1 $p 2>/dev/null && break; sleep 1; done; done
nc -z 127.0.0.1 8227 && nc -z 127.0.0.1 8237 && echo "== READY user :8227  lp :8237" || { tail -20 $T/user.log $T/lp.log; exit 1; }
wait

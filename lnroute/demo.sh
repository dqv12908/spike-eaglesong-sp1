#!/usr/bin/env bash
# Start the LP daemon and the wallet + web UI (run from Git Bash on Windows, or any bash with node).
# The two Fiber testnet nodes must already be up: in WSL, scripts/fiber-testnet-up.sh.
#   ENVF=<path to .env with SOL_PRIVKEY / SOL_DEVNET_RPC>  bash demo.sh
set -euo pipefail
cd "$(dirname "$0")"
ENVF=${ENVF:-E:/ckbuilder/testnet/.env}
RPC=$(grep -E '^\s*SOL_DEVNET_RPC' "$ENVF" | sed -E 's/^[^=]*=\s*//; s/^["'"'"']//; s/["'"'"']\s*$//' || true)
RPC=${RPC:-https://api.devnet.solana.com}
PROGRAM=${PROGRAM:-3NYcyDELHRt1Jr7A8APqPjYqr9bUDTZdo7pq4dqsxX9m}
trap 'kill $(jobs -p) 2>/dev/null; true' EXIT
node lp-fiber.mjs --fiber http://127.0.0.1:8237 --sol-rpc "$RPC" --program "$PROGRAM" --lp-key ../solana/deploy/lp-devnet-keypair.json --sol-ttl "${SOL_TTL:-180}" &
sleep 2
node wallet.mjs --fiber http://127.0.0.1:8227 --lp http://127.0.0.1:7071 --sol-rpc "$RPC" --sol-key "env:$ENVF" --port "${PORT:-7080}" &
wait

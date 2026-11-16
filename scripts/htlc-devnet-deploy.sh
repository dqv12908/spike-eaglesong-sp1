#!/usr/bin/env bash
# Deploy solana/deploy/sol_htlc.so to devnet and fund a separate LP key. The payer key is read from
# the .env (SOL_PRIVKEY) into a temp file that is deleted on exit.
set -euo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
ENVF=/mnt/e/ckbuilder/testnet/.env
D=/mnt/e/CKB/spike-eaglesong-sp1/solana/deploy
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
grep -E '^\s*SOL_PRIVKEY\s*=' "$ENVF" | sed -E 's/^\s*SOL_PRIVKEY\s*=\s*//; s/^["'"'"']//; s/["'"'"']\s*$//' > "$TMP/payer.json"
RPC=$(grep -E '^\s*SOL_DEVNET_RPC\s*=' "$ENVF" | sed -E 's/^[^=]*=\s*//; s/^["'"'"']//; s/["'"'"']\s*$//')
RPC=${RPC:-https://api.devnet.solana.com}
[ -f "$D/lp-devnet-keypair.json" ] || solana-keygen new --no-bip39-passphrase -s -o "$D/lp-devnet-keypair.json" >/dev/null
echo "payer $(solana-keygen pubkey "$TMP/payer.json") balance $(solana balance -u "$RPC" "$TMP/payer.json")"
solana program deploy -u "$RPC" --keypair "$TMP/payer.json" --program-id "$D/sol_htlc-keypair.json" "$D/sol_htlc.so" --output json 2>/dev/null
LP=$(solana-keygen pubkey "$D/lp-devnet-keypair.json")
# fund the LP once (skip when it already holds SOL)
if [ "$(solana balance -u "$RPC" "$LP" --lamports | cut -d' ' -f1)" -lt 300000000 ]; then
  solana transfer -u "$RPC" --keypair "$TMP/payer.json" --allow-unfunded-recipient "$LP" 0.6 --output json 2>/dev/null | grep -i signature || true
fi
echo "LP $LP balance $(solana balance -u "$RPC" "$LP")"
echo "payer balance after $(solana balance -u "$RPC" "$TMP/payer.json")"

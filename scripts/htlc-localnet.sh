#!/usr/bin/env bash
# Start a local Solana validator with the HTLC program preloaded and a funded test payer.
# Runs in the foreground (use a background job); the client runs from Windows against :8899.
set -euo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
D=/mnt/e/CKB/spike-eaglesong-sp1/solana/deploy
mkdir -p ~/htlc-local
[ -f "$D/sol_htlc-keypair.json" ] || solana-keygen new --no-bip39-passphrase -s -o "$D/sol_htlc-keypair.json" >/dev/null
[ -f ~/htlc-local/payer.json ] || solana-keygen new --no-bip39-passphrase -s -o ~/htlc-local/payer.json >/dev/null
cp ~/htlc-local/payer.json /mnt/c/Users/Admin/AppData/Local/Temp/claude/5cc085fda05ba124/52ccfc85-a520-40c3-9362-83628327e6fe/scratchpad/local-payer.json
PROG=$(solana-keygen pubkey "$D/sol_htlc-keypair.json")
PAYER=$(solana-keygen pubkey ~/htlc-local/payer.json)
echo "program=$PROG payer=$PAYER"
exec solana-test-validator --reset --quiet --ledger ~/htlc-local/ledger \
  --bpf-program "$PROG" "$D/sol_htlc.so" \
  --mint "$PAYER"

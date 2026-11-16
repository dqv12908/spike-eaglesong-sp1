#!/usr/bin/env bash
# Local validator for testing. Usage: local-validator.sh <mint-pubkey>
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
ulimit -n 1000000 2>/dev/null || ulimit -n 65536
cd ~ && exec solana-test-validator --reset --ledger ~/ckb-lc-ledger --mint "$1" --rpc-port 8899 --log

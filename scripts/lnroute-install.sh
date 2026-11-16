#!/usr/bin/env bash
# Download the pinned toolchain for the CKB/Fiber -> Lightning route into ~/lnroute/bin (WSL).
# Versions match Fiber v0.9.1's CI. Bitcoin Core and LND are checked against their published sums.
set -euo pipefail
mkdir -p ~/lnroute/dl ~/lnroute/bin
[ -d ~/lnroute/fiber-src ] || git clone -q --depth 1 --branch v0.9.1 https://github.com/nervosnetwork/fiber.git ~/lnroute/fiber-src
cd ~/lnroute/dl
get() { [ -f "$2" ] || wget -q -O "$2" "$1"; }
get https://github.com/nervosnetwork/ckb/releases/download/v0.202.0/ckb_v0.202.0_x86_64-unknown-linux-gnu-portable.tar.gz ckb.tar.gz &
get https://bitcoincore.org/bin/bitcoin-core-27.0/bitcoin-27.0-x86_64-linux-gnu.tar.gz bitcoin-27.0-x86_64-linux-gnu.tar.gz &
get https://bitcoincore.org/bin/bitcoin-core-27.0/SHA256SUMS btc.SHA256SUMS &
get https://github.com/lightningnetwork/lnd/releases/download/v0.18.0-beta/lnd-linux-amd64-v0.18.0-beta.tar.gz lnd-linux-amd64-v0.18.0-beta.tar.gz &
get https://github.com/lightningnetwork/lnd/releases/download/v0.18.0-beta/manifest-v0.18.0-beta.txt lnd.manifest &
get https://github.com/nervosnetwork/fiber/releases/download/v0.9.1/fnn_v0.9.1-x86_64-linux-portable.tar.gz fnn.tar.gz &
wait
ls -la
grep " bitcoin-27.0-x86_64-linux-gnu.tar.gz$" btc.SHA256SUMS | sha256sum -c
grep " lnd-linux-amd64-v0.18.0-beta.tar.gz$" lnd.manifest | sha256sum -c
sha256sum ckb.tar.gz fnn.tar.gz
rm -rf x && mkdir x
for f in *.tar.gz; do mkdir -p "x/$f" && tar -xzf "$f" -C "x/$f"; done
find x -type f \( -name ckb -o -name ckb-cli -o -name bitcoind -o -name bitcoin-cli -o -name lnd -o -name lncli -o -name fnn -o -name fnn-cli \) -exec cp {} ~/lnroute/bin/ \;
cd ~/lnroute/bin
ls -la
./ckb --version; ./ckb-cli --version; ./bitcoind --version | head -1; ./lnd --version; ./fnn --version || ./fnn --help | head -3

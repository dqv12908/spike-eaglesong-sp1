#!/usr/bin/env bash
set -euo pipefail
D=/mnt/e/CKB/spike-eaglesong-sp1/.downloads/installers
echo "== apt"; sudo -n apt-get update -qq && sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq pkg-config libssl-dev jq clang protobuf-compiler >/dev/null
echo "== rustup"; sh "$D/rustup-init.sh" -y --profile minimal --default-toolchain stable >/dev/null
source "$HOME/.cargo/env"
echo "== sp1up"; SHELL=/bin/bash bash "$D/sp1up-install.sh"
export PATH="$PATH:$HOME/.sp1/bin"
sp1up
echo "== versions"; rustc --version; cargo prove --version; ls ~/.sp1/bin; rustup toolchain list

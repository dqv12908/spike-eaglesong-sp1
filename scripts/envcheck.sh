#!/usr/bin/env bash
for c in cargo rustc gcc cc clang make pkg-config go docker curl git protoc cargo-prove sp1up; do
  p=$(command -v "$c" 2>/dev/null || true); echo "$c: ${p:-MISSING}"
done
ls -d ~/.sp1 ~/.cargo 2>/dev/null
cat /etc/os-release | head -2
dpkg -l build-essential libssl-dev pkg-config 2>/dev/null | grep ^ii | awk '{print $2, $3}'

#!/usr/bin/env bash
# Build every variant of the share-lock, run the ckb-testtool suite (real CKB-VM) against each, and
# write the cycle table to ../results/keyshare-lock-cycles.json.
# Run inside WSL from this directory:  bash measure.sh
# Output: build/<variant> binaries, build/keyshare-lock (= both-z), ~/keyshare-measure.log, the JSON.
set -euo pipefail
cd "$(dirname "$0")"
export CARGO_TARGET_DIR="${KEYSHARE_TARGET:-$HOME/keyshare-target}"
TESTS_TARGET="${KEYSHARE_TESTS_TARGET:-$HOME/keyshare-tests-target}"
LOG="${KEYSHARE_LOG:-$HOME/keyshare-measure.log}"
OUT="$CARGO_TARGET_DIR/riscv64imac-unknown-none-elf"
mkdir -p build
: > "$LOG"

# name | cargo profile | cargo feature args | test filter ("" = whole suite)
VARIANTS=(
  "both-z|release||"
  "both-z-edtables|release|--features ed-tables|"
  "both-z-edvartime|release|--features ed-vartime|"
  "both-z-edtables-edvartime|release|--features ed-tables,ed-vartime|"
  "both-o3|speed||"
  "both-o3-edtables|speed|--features ed-tables|"
  "both-o3-edvartime|speed|--features ed-vartime|"
  "both-o3-edtables-edvartime|speed|--features ed-tables,ed-vartime|"
  "ed25519-only-z|release|--no-default-features --features ed25519|ed25519"
  "ed25519-only-z-edtables|release|--no-default-features --features ed-tables|ed25519"
  "secp256k1-only-z|release|--no-default-features --features secp256k1|secp256k1"
)

for v in "${VARIANTS[@]}"; do
  IFS='|' read -r name profile features filter <<<"$v"
  build_cmd="cargo build --profile $profile $features"
  test_cmd="cargo test --test keyshare $filter -- --nocapture --test-threads=1"
  echo "=== $name" | tee -a "$LOG"
  echo "BUILD variant=$name profile=$profile cmd=$build_cmd" >> "$LOG"
  echo "TEST variant=$name cmd=$test_cmd" >> "$LOG"
  $build_cmd 2>&1 | tail -n 2 | tee -a "$LOG"
  cp "$OUT/$profile/keyshare-lock" "build/$name"
  echo "SIZE variant=$name binary_bytes=$(stat -c %s "build/$name")" | tee -a "$LOG"
  (cd ../ckb-keyshare-tests && KEYSHARE_BIN="$PWD/../ckb-keyshare/build/$name" KEYSHARE_VARIANT="$name" \
     CARGO_TARGET_DIR="$TESTS_TARGET" $test_cmd 2>&1 || true) \
     | grep -E 'METRIC|^test result|FAILED|panicked' \
     | sed -E "s/^.*(METRIC .*)$/\1/; s/^test result/RESULT variant=$name test result/" | tee -a "$LOG"
done
cp build/both-z build/keyshare-lock

LOG="$LOG" python3 - <<'PY'
import json, os, re, subprocess, datetime

log = open(os.environ["LOG"]).read().splitlines()
kv = lambda line: dict(p.split("=", 1) for p in line.split()[1:] if "=" in p)
variants, order = {}, []
min_capacity = None
for line in log:
    if line.startswith("BUILD "):
        name = re.search(r"variant=(\S+)", line).group(1)
        order.append(name)
        variants[name] = {
            "variant": name,
            "profile": re.search(r"profile=(\S+)", line).group(1),
            "build_command": line.split("cmd=", 1)[1].strip(),
            "cycles": {}, "tx_bytes": {},
        }
    elif line.startswith("TEST "):
        variants[re.search(r"variant=(\S+)", line).group(1)]["test_command"] = line.split("cmd=", 1)[1].strip()
    elif line.startswith("SIZE "):
        d = kv(line)
        variants[d["variant"]]["binary_bytes"] = int(d["binary_bytes"])
    elif line.startswith("METRIC ") and "min_cell_capacity_shannons" in line:
        min_capacity = int(kv(line)["min_cell_capacity_shannons"])
    elif line.startswith("METRIC "):
        d = kv(line)
        v = variants[d["variant"]]
        v["cycles"].setdefault(d["curve"], {})[d["path"]] = int(d["cycles"])
        v["tx_bytes"].setdefault(d["curve"], {})[d["path"]] = int(d["tx_bytes"])
    elif line.startswith("RESULT "):
        name = re.search(r"variant=(\S+)", line).group(1)
        variants[name]["cargo_test_result"] = line.split(" ", 2)[2]

OPT = {"release": "z", "speed": "3"}
for v in variants.values():
    v["opt_level"] = OPT[v["profile"]]
    # code cell = 8 (capacity) + 53 (default secp256k1 lock script) + binary bytes, 1 CKB per byte
    v["deploy_capacity_ckb"] = v["binary_bytes"] + 61

def locked(path, names):
    text = open(path).read()
    out = {}
    for m in re.finditer(r'name = "([^"]+)"\nversion = "([^"]+)"', text):
        if m.group(1) in names:
            out.setdefault(m.group(1), [])
            out[m.group(1)].append(m.group(2))
    return {k: (v[0] if len(v) == 1 else v) for k, v in sorted(out.items())}

sh = lambda c: subprocess.run(c, shell=True, capture_output=True, text=True).stdout.strip()
result = {
    "what": "Cycle cost of the key-share swap lock (ckb-keyshare) measured in CKB-VM via ckb-testtool",
    "generated_utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "relay_cycle_limit_per_tx": 70000000,
    "headline_variant": "both-z",
    "fee_cap_shannons": 100000,
    "min_cell_capacity_ckb_with_20_byte_args": None if min_capacity is None else min_capacity / 1e8,
    "notes": [
        "every path requires at least one output, every output under the committed lock hash, and sum(outputs) + fee_cap_shannons >= sum(all inputs)",
        "cycles are the whole transaction: one share-lock input (script hash type data2), outputs under an always-success lock that is not executed",
        "tx_bytes is the molecule-serialized Transaction (add 4 bytes for the size used in fee calculation); the witness carries the params blob",
        "deploy_capacity_ckb = binary bytes + 61 (capacity field + default secp256k1 lock); add 65 for a Type ID type script",
        "ed-tables = curve25519-dalek precomputed-tables; ed-vartime = variable-time base mult (vartime_double_scalar_mul_basepoint with a zero first scalar)",
        "k256 precomputed-tables does not build for riscv64imac no_std: \"`precomputed-tables` feature requires either `critical-section` or `std`\" (k256-0.13.4 src/arithmetic/mul.rs:41); it builds its table lazily at run time, so it was not pursued",
        "ckb-testtool runs scripts only: the lock's own since comparison is exercised, consensus-level since maturity is not",
    ],
    "toolchain": {
        "rustc": sh("rustc --version"), "cargo": sh("cargo --version"),
        "target": "riscv64imac-unknown-none-elf",
        "rustflags": "-C target-feature=+zba,+zbb,+zbc,+zbs",
        "host": sh("uname -sr"),
    },
    "crate_versions": {
        "lock": locked("Cargo.lock", {"ckb-std", "blake2b-ref", "sha2", "curve25519-dalek", "k256", "elliptic-curve", "crypto-bigint", "subtle", "buddy-alloc"}),
        "tests": locked("../ckb-keyshare-tests/Cargo.lock", {"ckb-testtool", "ckb-script", "ckb-vm", "ckb-types", "curve25519-dalek", "ed25519-dalek", "secp256k1", "secp256k1-sys", "sha2", "blake2b-ref"}),
    },
    "commands": {
        "all_variants": "cd ckb-keyshare && bash measure.sh   (inside WSL Ubuntu-24.04)",
        "build_default": "cd ckb-keyshare && CARGO_TARGET_DIR=~/keyshare-target cargo build --release",
        "test_default": "cd ckb-keyshare-tests && CARGO_TARGET_DIR=~/keyshare-tests-target cargo test -- --nocapture --test-threads=1",
        "test_env": "KEYSHARE_BIN=<path to lock binary> KEYSHARE_VARIANT=<label>; build and test commands per variant are listed under variants[]",
    },
    "error_codes": {
        "1": "Syscall", "2": "BadArgs", "3": "BadWitness", "4": "BadTag", "5": "ParamsMismatch", "6": "BadCurve",
        "7": "BadParamsLength", "8": "WrongReleaseSecret", "9": "ScalarZero", "10": "ScalarNonCanonical",
        "11": "ScalarMismatch", "12": "WrongOutputLock", "13": "SinceTypeMismatch", "14": "RefundTooEarly", "15": "PunishTooEarly",
        "16": "NoOutputs", "17": "FeeTooHigh",
    },
    "variants": [variants[n] for n in order],
}
dst = "../results/keyshare-lock-cycles.json"
json.dump(result, open(dst, "w"), indent=1)
open(dst, "a").write("\n")
print("wrote", os.path.abspath(dst))
PY
echo "log: $LOG"

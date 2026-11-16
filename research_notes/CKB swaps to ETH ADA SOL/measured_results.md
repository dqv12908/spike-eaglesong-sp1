# Measured results (experiments and live readings made for this research)

These are first-hand measurements made on 12 Nov 2026 (UTC) in the project `E:\CKB\spike-eaglesong-sp1`. They take precedence over estimates of the same quantities in the other notes. Everything is testnet/devnet/emulator; nothing ran on a mainnet. Raw logs are in the project's `results/` folder.

## M1. Fiber ⇄ native ETH on Sepolia with Boltz EtherSwap v6, unmodified

- Setup: two Fiber v0.9.1 nodes on CKB testnet with one channel. EtherSwap v6 deployed to Sepolia from the published boltz-core 5.0.0 build artifact, no changes: `0xDcD88d2fE9d521F5bF6B7B44479F3866c6ceb431`. Script `lnroute/eth-swap.mjs` (about 150 lines).
- CKB → ETH: 300 CKB paid over Fiber, 0.0001368 ETH received, 23.5 s. Lock tx `0x3c3cb69a72c3a3a6c06afec9deb8e9a89611e32eeb39b09bde4feeb53a6fddce` (135,617 gas), claim tx `0xaa30616a03d2ed39e589014d83835389f348420e23add5c8f81f1267618044a1` (35,257 gas). The claim was submitted by the LP's key and paid the user's address (EtherSwap's five-argument claim). The user address already held test ETH, so the strict zero-balance case was not shown.
- ETH → CKB: 0.0002 ETH paid, 435.06 CKB received over Fiber, 25.7 s. Lock tx `0xeb944d9c936a31769ef9d90d569cb01f14aa7ca6166f3a4b66adaf7cff5a3055` (135,629 gas), claim tx `0xf0f2703e2d713f9be18da0aca47b840bc98dbdec9feca7280d20b7326132eb06` (32,580 gas).
- Flow CKB → ETH: user picks secret; LP issues a Fiber hold invoice on sha256(secret); user pays; LP locks ETH for 15 blocks; claim reveals the secret on Ethereum; LP settles the invoice.
- Flow ETH → CKB: user's Fiber node issues a normal SHA-256 invoice; user locks ETH on that hash for about 7 hours (it must outlive the Fiber TLC, which is 6 h 40 min with `tlc_expiry_limit: 24000000`); LP pays the invoice; Fiber returns the preimage; LP claims ETH.
- Sepolia gas differs from mainnet: the same `lock` simulates at 47,417 gas against Ethereum mainnet. Sepolia block headers carry `blockAccessListHash` and `slotNumber`, and a plain ETH transfer to a never-used address cost 204,600 gas there (21,000 to an existing address). This is consistent with a newer fork that prices state creation higher; which change is responsible was not confirmed.

## M2. Key-share ("summed key") address: foreign half of a swap whose only contract is on CKB

An address whose private key is the sum of two parties' scalars (a + b) was funded with a plain transfer and emptied with a plain transfer; neither share alone could sign.

- Solana devnet (`solana/client/keyshare-test.mjs`): joint address `GvtS5AQBVT6vjWLkpppt6wpw6zRyjt5HyrKxVxsVe9cZ`; fund tx `2naS99dziMbbUgqzqtEdp5NEYo9wzswYVeBbBJVuz5R62E8FP5sa6hMGokddZLUiws22MQvrWYeyDFcfftXfpvwe`; sweep tx `xZMMdXp3fsd6HD2WjwELVyyZGapM2vnqrYTDjd6mA6jSqWc1azNnhGruk6DS7oL1jph1cXv19VUekhDzd7X5MVR`; 5,000 lamports each; System program only.
- Sepolia (`lnroute/keyshare-eth.mjs`): joint address `0xC6561ce9f464C869b97181008ff91F774B06654c`; fund tx `0xa60c6e834d45e9709f31480bcb8577bf18bf825e57116096e952b09d6f475c24` (204,600 gas, new account); sweep tx `0x4591296f0b7a093e697e7da21fd53496d03ced153ae7064393d4527a1c0b38d7` (21,000 gas); no contract code at the address.
- Cardano (emulator with mainnet epoch-667 parameters, `cardano/plainkey.mjs`): fund 0.167085 ADA, sweep 0.165457 ADA; no script, no collateral; the emulator rejected a signature from one share alone, a corrupted signature, and a valid signature from the wrong key.
- Consequence on Ethereum: under mainnet rules two transfers are 42,000 gas against about 82,000–107,000 for EtherSwap lock + claim; on Sepolia's rules the two transfers cost 225,600 against 170,874. So the key-share design is not reliably cheaper on Ethereum.

## M3. Key-share lock on CKB, measured in CKB-VM

- `ckb-keyshare/` (Rust, ckb-std 1.1.0, curve25519-dalek 4.1.3, k256 0.13.4, about 320 lines). Lock args = 20-byte blake2b hash of a params blob carried in the witness. Params: curve, maker share public key B, taker share public key A, sha256 release hash, maker lock hash, taker lock hash, t1, t2.
- Paths: CLAIM (witness has scalar b and the release secret; checks sha256(release) and b·G == B; outputs to maker lock); REFUND (input since ≥ t1; witness has scalar a; a·G == A; outputs to taker lock); PUNISH (since ≥ t2; outputs to maker lock). All paths require outputs to hold all input capacity except at most 0.001 CKB, and at least one output.
- Cycles (ckb-testtool 1.1.1, real CKB-VM; default build, both curves, opt-level z): Ed25519 claim 2,232,165, refund 2,222,828, punish 54,196; secp256k1 claim 2,442,807, refund 2,434,364, punish 54,148. Transactions 482–548 bytes. Default relay limit is 70,000,000 cycles per transaction.
- Binary 106,392 bytes with both curves; 36,096 bytes Ed25519 only. With dalek precomputed tables the Ed25519 claim is about 0.8 million cycles for about 30 KB more. A cell under the lock needs 61 CKB.
- 10 tests pass, including rejections with distinct error codes and a cross-check that the scalar read from an accepted claim plus the other share signs for A + B under an independent library. Not deployed to testnet; consensus-level `since` maturity is not exercised by ckb-testtool.
- A first version did not cap the fee: once a claim is broadcast the scalar and release secret are public, so anyone could rebuild the transaction and leave the capacity as fee. Fixed with the 0.001 CKB cap.
- Not shown: an end-to-end key-share swap; the two halves were measured separately.

## M4. Cardano hash-lock cost

- Neither public validator is usable unmodified. `cardano-scaling/htlc` (commit 393893f): hashes with `blake2b_256`; receiver must sign; claim before the deadline, refund after; committed PlutusV3 blueprint. Cardano Foundation template `htlc/onchain/aiken` (commit cbc86fc): `sha2_256`, but no receiver binding and no claim deadline — a third party claiming after expiry with only the secret was accepted in a test; parameters are compiled in, so a reference script cannot be shared.
- Measured validator: cardano-scaling's with `blake2b_256` replaced by `sha2_256`, plus a 32-byte secret check (`cardano/onchain/validators/htlc_sha256.ak`, Aiken v1.1.19, PlutusV3). No audit stated for any of these.
- Fees with mainnet protocol parameters (Koios, epoch 667, fetched 2026-11-12T19:31Z): lock 0.172189 ADA (378 bytes; locked output needs ≥ 1.349030 ADA); claim 0.192067 ADA with a reference script (48,873 mem / 16,808,405 cpu; 507 bytes) or 0.210277 with the script attached; refund 0.190023 / 0.208233; publishing the reference script 0.198721 ADA once plus a recoverable 3.947960 ADA deposit. Lock + claim = 0.364256 ADA.
- Method and limits: built and run in the Lucid Evolution 0.8.9 emulator, which does not execute scripts at submit. All script transactions were also evaluated by a real cardano-node via Koios preprod's Ogmios endpoint: execution units matched and a tampered claim was rejected. Fees were recomputed from the protocol parameters. Nothing was submitted to a live Cardano network (the preprod faucet has a CAPTCHA; the test wallet is unfunded).
- Zero-ADA receiver: cannot claim alone (collateral of at least 150% of the fee, about 0.29 ADA, and the receiver's signature are required). A sponsor paying fee and collateral with the receiver co-signing worked (fee 0.200955 ADA); lending collateral only also worked. This is an interactive co-signing round, unlike EtherSwap's submit-by-anyone claim. The secret is in the redeemer, not the transaction body.

## M5. Live price readings

- SimpleSwap floating quotes read from simpleswap.io at 2026-11-12 19:42 UTC for 100,000 CKB, against CoinGecko at 19:42:24 UTC (CKB $0.00093946, ETH $2,006.78, SOL $81.36, ADA $0.171051; 100,000 CKB = $93.95):
  - ETH: 0.04601008 vs mid 0.046814 → 1.72% below mid.
  - ADA: 539.967446 vs mid 549.228 → 1.69% below mid.
  - SOL: 1.13587701 vs mid 1.154695 → 1.63% below mid.
- Binance spot CKB/USDT order book at 19:42:43 UTC: bid 0.00094, ask 0.000942 (0.21% spread, two price ticks); $4,756 of bids within 0.5% of mid and $44,955 within 2%; selling $1,000 / $10,000 / $50,000 of CKB into the book lands 0.145% / 0.473% / 0.954% below mid before fees; 24-hour volume $219,444. OKX and Bybit returned no CKB-USDT spot instrument. Binance's standard spot taker fee (0.1%) was not re-read that day.
- NEAR Intents 1Click dry-run quotes (no API key, so the 0.25% API fee is included) at 19:28 UTC against CoinGecko mid: ETH ⇄ SOL 0.21–0.23% below mid; ETH ⇄ ADA 0.30–0.48%; SOL ⇄ ADA 0.33–0.60% (two readings a minute apart); quoted completion 24–62 s. (`scripts/near-quotes.mjs`, `results/near-intents-dry-quotes.txt`.)
- Derived LP break-even for one-way flow hedged in $1,000 clips: about 0.25% to sell CKB (0.145% book impact + 0.1% fee) + about 0.1% to buy the other coin + about 0.08% option value for a 3-minute window ≈ 0.45%; about 0.75% in $10,000 clips; about 0.1% when flow in both directions nets out. This is an estimate built from the readings above, not a measurement.

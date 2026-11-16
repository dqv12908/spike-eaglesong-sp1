# Spike: CKB Eaglesong PoW inside SP1

**Question:** How expensive is it to prove CKB consensus (Eaglesong PoW + header linkage + cumulative difficulty) inside a zkVM? This is the "biggest open unknown" in the CKB→Solana zk-light-client plan (see `../ckb-solana-bridge-research.md` §2 Option C). It is also the first spike in Antismart's design (talk.nervos.org/t/10372).

**Answer: cheap.** About **48.7k RISC-V cycles per header**. A 256-header segment proves in about **3 minutes on one desktop CPU**. Details below.

**Status (v3):** a full round trip works on testnets. 300 CKB was deposited into a CKB custody lock, 300 ckbCKB was minted on Solana devnet against Groth16 proofs, 120 was burned, and 120 CKB was released back on CKB testnet by the custody lock against 2-of-3 attester signatures. See "Round trip (v3)".

**Swap (no bridge):** CKB over a Fiber channel on **CKB testnet** swaps atomically for native SOL on **Solana devnet**, in both directions, in 4–6 s, with a web UI. Both refund paths are tested on chain. See "Direct route" and [`docs/nervos-talk-post.md`](docs/nervos-talk-post.md).

**Swap research (ETH, ADA, SOL):** the same Fiber payment swaps for native ETH on Sepolia in both directions (~25 s) using Boltz’s EtherSwap contract unmodified, and a contract-free “key-share” design is measured in parts. See "Beyond Solana" and [`docs/nervos-talk-research.md`](docs/nervos-talk-research.md).

**Also:** a CKB/Fiber → Lightning → native SOL atomic swap works end to end. The CKB and Bitcoin legs ran on local dev chains and Solana on devnet; 0.175 SOL was delivered in 7 s, and the walk-away case refunds every leg. See "Lightning route".

*Date: 2026-11-11 · SP1 v6 (sp1-sdk 6.10.0, cargo-prove d83ed91) · Ryzen 7 7700X, 64 GB (WSL2 Ubuntu 24.04, 47 GB visible) · CPU prover, no GPU.*

---

## What is proven

`program/` (SP1 guest) takes `n` serialized 208-byte CKB headers and, for each one:
1. `pow_hash = ckbhash(RawHeader)`, which is BLAKE2b-256 with personalization `ckb-default-hash`, over 192 bytes.
2. `eaglesong(pow_hash ‖ nonce_le)`, compared big-endian against `compact_to_target(compact_target)`.
3. `block_hash = ckbhash(Header)`, then checks that `parent_hash` equals the previous block hash and that heights are consecutive.
4. Adds `target_to_difficulty` to a running U256 total.

Since v3 a segment also takes the **parent header** it continues (the light client's tip). The guest checks `ckbhash(parent) == first.parent_hash` and CKB's epoch rules for every header against its parent:
- Inside an epoch: same epoch number and length, index + 1, and an **identical `compact_target`**.
- At an epoch start: number + 1, index 0, length within `[max(300, L/2), min(1800, 2L)]` (CKB's own bounds), and a target within ×/÷8 of the previous epoch's.

Without this a prover could pick its own `compact_target` and mine fake headers with trivial PoW (the v1/v2 guests had that hole). CKB's exact difficulty formula needs uncle counts, which aren't in headers, so the ×/÷8 bound is derived from CKB's ×/÷2 clamps on hash rate and epoch length. The largest move seen over the last 60 epochs was 2.12× on testnet and 1.64× on mainnet (`ckb-pow/tests/epoch.rs`, `check_transition`).

It commits `kind=1 ‖ pow_id ‖` a 112-byte summary: `first_number, last_number, first_parent_hash, last_hash, total_difficulty` (114 bytes). The `pow_id` byte is 0 for mainnet Eaglesong and 1 for testnet Eaglesong+BLAKE2b, so a testnet proof can't advance a mainnet light client.

The same guest (one vkey) has a second proof kind, **deposit** (`ckb-pow/src/deposit.rs`). It proves output `i` of a transaction is in block B, and that B is hash-linked to an anchor header T. It commits a 194-byte event: anchor, block, tx hash, index, capacity, lock hash, type flag, data length and the 32-byte recipient. See "End to end" below.

Not yet included: FlyClient sampling and MMR / chain-root (RFC 44) membership. Every header from the checkpoint is proven instead. See "What's next".

## Correctness (ground truth = mainnet)

`cargo test -p ckb-pow --features rpc --release` passes 17 tests (10 header tests, 3 deposit tests, 4 epoch tests). The header tests run over 265 real mainnet headers (a contiguous run of 256 plus 9 samples from #1 to #20M) and 41 testnet headers:
- Our molecule serialization reproduces every RPC block hash.
- Every mainnet header passes PoW.
- Tampering is rejected: flipping a nonce bit or changing `transactions_root` fails PoW, and swapped, dropped or wrong-parent headers fail linkage.
- The guest's committed summary byte-matches the native result for every n tested.
- The Eaglesong reference test vectors pass. The specialized fast path equals the reference sponge on 2,267 inputs, both real PoW messages and pseudo-random ones.

### Findings worth posting to the forum
1. **Mainnet and testnet use different PoW functions.** Mainnet (Lina) is `eaglesong(msg)`: 265/265 pass and 0/265 pass with blake2b. Testnet (Pudge) is `ckbhash(eaglesong(msg))`: 41/41 pass and 0/41 pass without it. The Chiral light paper describes the testnet variant. A circuit built and tested only on Pudge would reject every mainnet block.
2. **The reference Eaglesong sponge runs a wasted permutation.** After squeezing the 32-byte output it permutes once more, which never affects the output. Dropping that step and absorbing whole words cuts Eaglesong from **49.7k to 32.7k cycles (−34%)** in the zkVM, and native time from 2.7 to 1.5 µs/header. See `eaglesong_pow48` in `ckb-pow/src/lib.rs`.
3. **The delimiter quirk.** For a 48-byte input, the 0x06 delimiter lands as the word `0x00000006` (not `0x06000000`), because the reference doesn't shift after the delimiter byte. Anyone writing a circuit must match this.

## Results

### Execution (cycle counts)
| Headers | Total cycles | Cycles/header |
|---:|---:|---:|
| 1 | 58,599 | 58,599 |
| 4 | 204,557 | 51,139 |
| 16 | 788,369 | 49,273 |
| 64 | 3,123,617 | 48,806 |
| 256 | 12,464,448 | **48,689** |
| testnet 16 (extra blake2b) | 859,601 | 53,725 |
| testnet 16 + parent + epoch/difficulty rules (v3) | 870,021 | 54,376 |

Per-header breakdown (differential, n=256):

| Component | Cycles | Share |
|---|---:|---:|
| `eaglesong_pow48` (fast path) | 32,737 | 67% |
| `pow_hash` blake2b(192 B) | 7,516 | 15% |
| `block_hash` blake2b(208 B) | 7,514 | 15% |
| target + difficulty (U256) | 621 | 1% |
| *(reference sponge, for comparison)* | *49,675* | |

SP1 has no BLAKE2b or Eaglesong precompile, so all of this runs in software.

### Proving (CPU only, Ryzen 7700X)
| Proof | Headers | Prove time | Peak RAM | Verify |
|---|---:|---:|---:|---:|
| core | 16 | 35.2 s | 11.8 GB | 75 ms |
| core | 256 | 181.7 s | 38.9 GB | 130 ms |
| compressed | 16 | 95.1 s | 17.7 GB | 33 ms |
| groth16 (BN254) | 16 | 839 s* | 28.0 GB | 213 ms |

\* This was the first Groth16 run, so it includes downloading the gnark circuit artifacts (~1+ GB) and is an upper bound. The wrap step's cost is roughly constant whatever the header count, so batching amortizes it. The proof is **356 bytes** (`fixtures/proofs/groth16-mainnet-n16.json`).

### On-chain verification (Sepolia)
`node scripts/verify-sepolia.mjs fixtures/proofs/groth16-mainnet-n16.json` makes a read-only `eth_call` to Succinct's deployed `SP1VerifierGateway` (Groth16, `0x397A5f7f3dBd538f23DE225B51f532c34448dA9B`). No gas or keys are needed.
- Genuine proof: **verified**. `eth_estimateGas` gives **259,079 gas** including the 21k base and calldata.
- One flipped byte in the public values (the committed last block hash): **reverts**.

So a proof that 16 consecutive CKB mainnet headers carry valid Eaglesong PoW and chain together is checked on an EVM chain for about 260k gas, with no committee.

### On-chain verification (Solana devnet): CKB light client (v1)
*This section is the first, header-only version of the program. Its source has since grown into the bridge program described in the next section. The v1 binary is kept as `solana/deploy/ckb_light_client.so`.*

`solana/program/` is a native Solana program (`solana-program` 5, 38 KB). It ports Succinct's v6.1.0 `SP1VerifierGroth16.sol` and gnark `Groth16Verifier.sol` onto the `alt_bn128` syscalls. Constants are generated from the circuit's `.sol` files by `scripts/gen_vk_rs.py`. It keeps a **CKB tip state account**:
- `Init` sets a trusted checkpoint `(number, hash)`, as any light client needs.
- `Submit` is permissionless. It verifies the Groth16 proof against the hard-coded guest vkey and requires `first_parent_hash == tip_hash` and `first_number == tip + 1`. On success it advances the tip and adds the segment's difficulty.
- `Verify` only verifies and logs.

**Deployed:** program [`8XjZL4HWtH7otxPjYFEi16MdAa2uWjpJmJuBbysFgPww`](https://explorer.solana.com/address/8XjZL4HWtH7otxPjYFEi16MdAa2uWjpJmJuBbysFgPww?cluster=devnet). The upgrade authority is the `SOL_ADDRESS` from `ckbuilder/testnet/.env`. Deploy rent was about 0.194 SOL.
**State account:** [`2hFzqFDjB69MDujY9XiqKLGVQefDqERUgnhe3fMoBytb`](https://explorer.solana.com/address/2hFzqFDjB69MDujY9XiqKLGVQefDqERUgnhe3fMoBytb?cluster=devnet)

| Step | Result | CU | Tx |
|---|---|---:|---|
| Verify-only (16 headers) | verified | **96,762** | [5nu35Rs…](https://explorer.solana.com/tx/5nu35RsEPSaAH1Tc45XEbqYwCuDx34aK6dvkGtdXEBrdMmQKednR6pxi1vfL35objMoNM5bDcUsAGcq9ZpBChpBt?cluster=devnet) |
| Create + init state at anchor #20,975,690 | ok | 1,627 | [tsegXEs…](https://explorer.solana.com/tx/tsegXEs2gRUyFR3MXuNds91jgAvbrfKstV8KjuwLZzoE4FNMHHKQJbrnizA3VpjKXFxmiKcn1zTiih9LDUYXWNs?cluster=devnet) |
| Submit segment #20,975,691–#20,975,706 | **tip → #20,975,706** `0xdde2897b…` | **98,130** | [3E8LzxT…](https://explorer.solana.com/tx/3E8LzxTDP1MkUScicZQSFdZsnVFukocYkVtPXEtXBDZSv5T2naih73kkT1DsAYCEhKzJ4b9xetmk7bSjcHbqLwjp?cluster=devnet) |
| Tampered public values (sim) | rejected, `PairingFailed` | 96,304 | — |
| Tampered proof (sim) | rejected, invalid curve point | 96,294 | — |
| Replay same segment (sim) | rejected, `DoesNotExtendTip` (Custom 6) | 97,528 | — |

The stored tip hash `0xdde2897b4cd2921054ce8da03979e45f9d4a236c0954d8cb4d34faecb1031e38` equals the CKB RPC's hash for mainnet block #20,975,706. Each transaction costs 5,000 lamports in fees, and verification uses less than half of Solana's 200k default compute budget.

Before devnet, the same flow ran on a local `solana-test-validator` (`results/solana-localnet.json`). Off-chain tests of the port are in `solana/program/tests/verify.rs`: the genuine proof passes, and tampered public values, a tampered proof and a wrong vkey are rejected.

Reproduce: `bash scripts/solana-test.sh all`, then `scripts/deploy.sh <rpc> <payer.json>`, then `node solana/client/run.mjs --rpc <rpc> --program <id> --payer env:E:/ckbuilder/testnet/.env`.

### End to end on devnet: CKB testnet deposit → ckbCKB minted on Solana
The same program now also holds a bridge. A **config account** binds four things: one light-client state, one SPL mint (8 decimals, mint authority = the program's PDA `["mint_auth", config]`, no freeze authority), the CKB deposit lock hash, and a confirmation depth. The light-client state now records its chain (`pow_id`) and keeps a ring of the last 16 accepted tips.

`Mint` (tag 4) is permissionless. It verifies a kind-2 Groth16 proof, then checks:
- The anchor is one of the recent tips, and `anchor − block ≥ confirmations` (12).
- The output's lock hash equals the configured deposit lock, it has no type script, and its data is exactly 32 bytes (the recipient).
- The destination is that recipient's token account for this mint.
- The out-point hasn't been minted before. A nullifier PDA `["deposit", config, tx_hash, index]` is created by the program, and a pre-funded PDA can't block it.

It then mints `capacity` shannons, so 1 CKB = 1 ckbCKB.

**The run (2026-11-11):**
1. **CKB testnet deposit** ([`0x500e7ec6…d324`](https://testnet.explorer.nervos.org/transaction/0x500e7ec655a95c18f1753ffc7a4f3ca441b1e3702a6e73b80411f303c273d324)), sent with `ckb/deposit.mjs` from WALLET_1. It is 200 CKB locked to WALLET_2's lock, which acts as the custodian; lock hash `0xa266ef5c…4b46`. The data is the Solana recipient `BfdybibaFNx1LsSag6T3DCqBYhNSMdVopQ7QKfau6Gm7`. It was committed in block **#23,025,700**.
2. **Fixture:** `scripts/fetch_deposit.py` fetched `fixtures/deposit-testnet.json` after 12 confirmations. It contains the raw tx (verbosity 0), the `get_transaction_proof` CBMT proof, headers #23,025,700..#23,025,712, and the PoW segment #23,025,697..#23,025,712 above checkpoint #23,025,696. The script cross-checks the tx hash, CBMT root and lock hash in Python, independently of the Rust code.
3. **Two Groth16 proofs** from the same guest (vkey `0x002a2abc…c2f2`), using `scripts/prove-bridge.sh`:

| Proof | Guest work | Cycles | Prove (CPU) | Peak RAM | Size |
|---|---|---:|---:|---:|---:|
| segment (kind 1) | 16 testnet headers, Eaglesong+BLAKE2b PoW | 859,775 | 482 s | 28.2 GB | 356 B |
| deposit (kind 2) | tx hash, CBMT, tx root, 13 hash-linked headers, molecule parse | ~162k* | 473 s | 28.3 GB | 356 B |

\* Measured on a sample testnet tx with the same shape. Both proving times are dominated by the constant Groth16 wrap.

4. **Solana devnet**, program [`5YCcYWzvnsSJtP2NVgFrdiSkHaxjGd7DvTVrGf4LFN1R`](https://explorer.solana.com/address/5YCcYWzvnsSJtP2NVgFrdiSkHaxjGd7DvTVrGf4LFN1R?cluster=devnet) (70 KB, rent ≈ 0.36 SOL; upgrade authority = `SOL_ADDRESS`). Driven by `solana/client/bridge.mjs`:

| Step | Result | CU | Tx |
|---|---|---:|---|
| Create + init testnet light client at checkpoint #23,025,696 | ok | 1,833 | [3VGbK6X…](https://explorer.solana.com/tx/3VGbK6XVbK5KwSy8chvVkCFLBMB1WLq9CEkojaqppBFEZAZi9bzYBg1mW8R1z4shC5iRP9J3HBJFmVoeANRAQaC2?cluster=devnet) |
| Create ckbCKB mint + bridge config (lock `0xa266ef5c…`, 12 confs) | ok | 5,432 | [49vgTte…](https://explorer.solana.com/tx/49vgTteV2HfxXwjtVxySV91JMDyGuNpqSFqPE4Zae6UPQ1kwbtziPc8dpGNMY2T42dbC2gYKrFqwifkmuJgoFgyi?cluster=devnet) |
| Create recipient token account | ok | 13,417 | [3Lveuv9…](https://explorer.solana.com/tx/3Lveuv9HFVEsaB6UjWQzsrrgbyCHCyuFryfZZoDjQgrV5uJ7iR7qZ9J63DvHX552M1ahP9Leo1HVTC5uKj2GkHXv?cluster=devnet) |
| Mint before the segment is submitted (sim) | rejected, `NotAnchored` (9) | 100,782 | — |
| Mint with one recipient bit flipped (sim) | rejected, `PairingFailed` (4) | 100,066 | — |
| Submit segment proof | **tip → #23,025,712** `0x9df466ba…` | 98,132 | [43HtsXu…](https://explorer.solana.com/tx/43HtsXuFuuxxyRyoJB24TbNs2Vy5Xdxy1Hs5J4MTn7GYtxwB88hSERyNQEUX5m6vE1vk7q4CMNGKwbZYLoTgiUPo?cluster=devnet) |
| Mint into the wrong token account (sim) | rejected, `WrongTokenAccount` (14) | 99,724 | — |
| **Mint deposit proof** | **200 ckbCKB minted** to `Bfdyb…6Gm7` | **108,793** | [49AWSn6…](https://explorer.solana.com/tx/49AWSn6gQ4x4vRXMdibtKLYP2NXB6BpZamJQWZ6Qp3QJ3ZkU2N8bUagffNaVux4zYkuhQz9hRgkvrTAsCboi9jjF?cluster=devnet) |
| Replay the same deposit (sim) | rejected, `AlreadyMinted` (15) | 101,438 | — |

Accounts:
- State: [`2pBqFLgV…Ugp5`](https://explorer.solana.com/address/2pBqFLgV3WdbAQ9VBbJKXapMsLfS3TPXaGM5gYC2Ugp5?cluster=devnet)
- Config: [`2MCSB46Z…K2CH`](https://explorer.solana.com/address/2MCSB46Z5VquKuJ97wi7S2JX8o1cT8w3Nu1j6wYMK2CH?cluster=devnet)
- Mint: [`E9R5HjSk…gJg`](https://explorer.solana.com/address/E9R5HjSkZab8TfTTAw8hMDCwucgMjP4WG94gSqDEpgJg?cluster=devnet)
- Recipient token account: [`4xNu8F66…MQD`](https://explorer.solana.com/address/4xNu8F66YnPZ8vD5Wqqas4dPAJ1LwXpPwfoLLukeMQD?cluster=devnet)

Final state:
- The light-client tip hash equals the CKB testnet hash for #23,025,712.
- Recipient balance, mint supply and `total_minted` are all 20,000,000,000 (200.00000000 ckbCKB).

The mint transaction is 1,028 bytes, under the 1,232-byte limit. The same flow passed first on a local validator (`results/bridge-localnet.json`). That run caught a typo in the SPL Token program ID, which the program's mint-owner check rejected.

**What this demo did not do (fixed in v3, next section):**
- **Custody:** the CKB is held by an ordinary secp256k1 lock (WALLET_2), so unlocking is trusted. A real deployment needs a CKB lock that releases only on a proven burn on Solana, which means a Solana light client on CKB, or a committee or ISM as in Option D.
- **Light client:** the checkpoint is trusted. Every header from the checkpoint is PoW-checked, but `compact_target` was not constrained (a prover could choose an easy target), and there was no fork choice by total difficulty beyond "extends the tip".
- **Confirmation depth:** 12 blocks is a demo number. Testnet reorgs are rare but real.

### Round trip (v3): hardened light client, CKB → Solana → CKB
*2026-11-11. CKB testnet + Solana devnet. Program [`2KDCstdNVf3kW6CfvWEmYAk5KLG58z9JeXDhTG3XnbnS`](https://explorer.solana.com/address/2KDCstdNVf3kW6CfvWEmYAk5KLG58z9JeXDhTG3XnbnS?cluster=devnet) (82 KB, rent ≈ 0.58 SOL). Guest vkey `0x0009463b…ded3c`. The v1 and v2 programs stay deployed and unchanged.*

**What changed from v2:**
- **Light client (guest):** segments carry the parent header and enforce CKB's epoch and difficulty rules (see "What is proven"). A v2 proof does not verify under the v3 vkey (`v2_guest_proofs_rejected`).
- **Light client (Solana):** each of the 16 ring entries stores its cumulative difficulty since the checkpoint.
  - A segment may continue *any* live ring entry. It replaces the tip only if its cumulative difficulty is **strictly greater**, and the abandoned branch's entries are dropped, so they can no longer anchor deposits.
  - The ring is the reorg horizon: a fork from before the oldest entry is refused.
- **Two-sided height bound:** a deposit must satisfy `confirmations ≤ tip − block ≤ max_age`, measured against the current tip, and its anchor must be a live ring entry.
- **Custody on CKB:** a real lock script ([`ckb-custody/`](ckb-custody/src/main.rs), 48.6 KB, Rust + `ckb-std`) replaces the WALLET_2 key.
- **`Burn` (tag 5) on Solana:**
  - Burns ckbCKB and names any CKB lock script (`code_hash`, `hash_type`, up to 64 bytes of args).
  - Records burn #seq in a PDA `["burn", config, seq]`.
  - Refuses amounts below the recipient cell's minimum capacity (41 + args CKB), so every burn can be paid out.

**The custody lock.** Deposits are cells under this lock with a 32-byte Solana recipient as data, which is what `Mint` checks. One special cell, the **vault**, has the same lock plus a Type ID (so it is unique) and a burn counter. CKB leaves custody only through the vault, one burn at a time, in order.

Lock args: `vault_type_hash ‖ bridge_id (= Solana config pubkey) ‖ m ‖ n ‖ n × ed25519 pubkey`. The unlock witness carries `seq ‖ amount ‖ recipient_lock_hash` and ≥ m attester signatures over:

`ckbhash("CKB-SOL-UNLOCK-V1" ‖ bridge_id ‖ vault_type_hash ‖ seq ‖ amount ‖ recipient_lock_hash)`

The script itself enforces:
- `seq` equals the vault counter, and the new vault has counter + 1.
- The only output under the custody lock is the new vault, so change can never be re-proven on Solana as a fresh deposit.
- CKB leaving custody equals `amount`, and outputs under the recipient lock receive at least `amount`.
- A burn back to the custody lock pays nothing out but still advances the counter, so a bad recipient can't stall the queue.

The attesters only vouch that "Solana burn #seq happened". They cannot redirect funds, change amounts or replay a burn.

Tests, in ckb-testtool's real CKB-VM (`ckb-custody-tests/`):
- A valid 2-of-3 unlock costs **4.43 M cycles**.
- Each of these is rejected with the intended error code: a replayed burn, too few signatures, a duplicate signer, a tampered amount, the vault keeping too little, an underpaid recipient, change sent to a second custody cell, the counter not bumped, no vault, a destroyed vault, and a key outside the committee.

**The run:**

| # | Chain | Step | Result |
|---|---|---|---|
| 1 | CKB | Deploy `custody-lock` code (data2) | [`0x8e967319…`](https://testnet.explorer.nervos.org/transaction/0x8e96731911d239824c3f2b53cef3bc791fcaf9c58c776aa8145b0808d827a458), 48,661 CKB of capacity |
| 2 | CKB | Create the vault: Type ID, counter 0, 300 CKB seed, 2-of-3 committee, bridge_id = config `EwDcSX8Q…eyeMp` | [`0xd3fb4d82…`](https://testnet.explorer.nervos.org/transaction/0xd3fb4d82091755753e709a993041cd46b7b5e172f2aee28b7ff2df5704fb570e). Custody lock hash `0x37202bcc…fc1c` |
| 3 | CKB | Deposit 300 CKB into custody, data = `Bfdyb…6Gm7` | [`0x73c08fe2…`](https://testnet.explorer.nervos.org/transaction/0x73c08fe23f21d9c170d83ec455ef78c34b4cf061980a2b3c99bcf2606e2d661b), block **#23,026,478** |
| 4 | — | Groth16: segment #23,026,475..#23,026,490 continuing checkpoint #23,026,474 (870k cycles) and deposit (162k cycles) | 356 B each, ~10 min each including build, 28.5 GB peak |
| 5 | Solana | Init light client at checkpoint, then mint + config (custody lock, 12 confs, max age 100,000) | [3cJ3w31…](https://explorer.solana.com/tx/3cJ3w31vgTE8whtFooQZZf6gmKeCDWkv4TQ4AA8qwmzZeYnF6giybARyic4LMMG3RYR5w77NCFv9vqVgKNShxAbR?cluster=devnet), [4pDf5MJ…](https://explorer.solana.com/tx/4pDf5MJYKZLeRB6TEX6RteWjeEEeH69PzZvvrobsLihT2F9hZ7cXUuh6Eq9rvxREDpXN28v3udYqrMP1jaX6gHFy?cluster=devnet) |
| 6 | Solana | Submit segment | **tip → #23,026,490** `0x0596c795…` (= RPC), 98,660 CU, [3Q4FH2G…](https://explorer.solana.com/tx/3Q4FH2GKtzhdhWajbrcqECeqFVTR4XepneGMxvudqqdhGCfStnHGJWSHEAvQUxXpJMZUcd5qEuNNzH8PDFWkCb22?cluster=devnet) |
| 7 | Solana | Same segment again, now a fork from the checkpoint with equal work (sim) | rejected, `ForkNotHeavier` (20) |
| 8 | Solana | **Mint the deposit** | **300 ckbCKB** to `Bfdyb…6Gm7`, 111,726 CU, [3ydxwH1…](https://explorer.solana.com/tx/3ydxwH1vfK9vdmdYnqAZfRJA6pPbzroLxEz1Dj2kirypiMFcTCVbv9XDMzELHhcV8K9iXuQfC47BQ9F7ohKeavDf?cluster=devnet) |
| 9 | Solana | **Burn 120 ckbCKB → WALLET_1's CKB lock** | burn record #0 [`7uQhFvuE…`](https://explorer.solana.com/address/7uQhFvuEZbbefE14zDzBwYePbHt6KHA3Qvvo13zxkbqr?cluster=devnet), 10,918 CU, [2V8Fxvc…](https://explorer.solana.com/tx/2V8FxvcB9H13UFSofRg5ckPSA81sirfHjNJvbkSrCnmPj1Bw3tWkDSvFYiQg3kyy7AdvCgUzhrGwn1NyYzLc5LgU?cluster=devnet) |
| 10 | — | Attesters 0 and 2 read burn #0 at `finalized` and check that the config is program-owned and bound to this custody lock. Then they sign (`ckb/attest.mjs`) | [`results/attestation-burn0.json`](results/attestation-burn0.json) |
| 11 | CKB | **Unlock** (relayed by WALLET_1, which pays the fee): vault + deposit in → vault 480 CKB (counter 1) + 120 CKB to WALLET_1 | [`0x44e5ba4a…`](https://testnet.explorer.nervos.org/transaction/0x44e5ba4a604a5f5c9d3fbcaec1803dd853b084a2b30013960b232e33f39c6bde), block #23,026,681, 6.05 M cycles in total |

Rejections, all checked by the real chains (simulations / `test_tx_pool_accept`, nothing sent):

| Chain | Attempt | Result |
|---|---|---|
| Solana | Mint before the segment / recipient bit flipped / wrong token account / replay | `NotAnchored` 9 / `PairingFailed` 4 / `WrongTokenAccount` 14 / `AlreadyMinted` 15 |
| Solana | Burn below the minimum cell / bad `hash_type` / wrong seq PDA | `BurnTooSmall` 23 / `BadBurn` 22 / `WrongPda` 19 |
| — | Attest burn #1, which doesn't exist | attester refuses |
| CKB | Unlock with one signature (m = 2) | custody lock error **10** |
| CKB | Unlock with the amount changed after signing | error **9** |
| CKB | Replay burn #0 after the unlock (client check bypassed) | error **8** (wrong seq) |

**Balances after the round trip:**
- WALLET_1: 9,643.99959 → 9,763.99958 CKB (+120, less a 0.00001 CKB fee).
- Solana: supply = recipient balance = 180 ckbCKB; `total_minted` 300, `total_burned` 120, next burn seq 1.
- Custody: one cell, the vault, with **480 CKB = 300 seed + 180 outstanding**.

Logs: `results/bridge-v3-devnet.json` (and `bridge-v3-localnet.json`, which passed first), `results/ckb-testnet-roundtrip-v3.json`, `ckb/custody-testnet.json`.

**Trust model now:**
- **CKB → Solana:** no committee.
  - Groth16 proofs of PoW, epoch and difficulty rules and inclusion.
  - Fork choice by cumulative work.
  - Two-sided depth bound.
  - What's still trusted: the checkpoint, and the honesty of the majority of CKB hash power over the confirmation window. 12 confirmations is a demo depth.
- **Solana → CKB:** an **m-of-n attester committee** (2-of-3, all keys held locally in this demo, `ckb/attesters.local.json`, gitignored).
  - The script bounds what the committee can do: no redirection, no amount change, no replay, in-order only.
  - A colluding m-of-n can still invent a burn. Solana has no succinct consensus proof that CKB-VM could check today, so this is the same trust class as Wormhole's guardians.
  - Narrowing it would mean independent operators, a challenge window, rate limits, or a ZK proof of Solana consensus later.
- **Liveness:** burns are processed strictly in order, so one burn that is never attested blocks the queue. Every burn is constructible on CKB by design (minimum amount, valid `hash_type`; a burn to custody is a no-op).
- **Not done:** committee rotation (the committee is fixed in the lock args), fees for relayers, and any rate limit.

### Direct route: CKB over Fiber ⇄ native SOL (atomic swap, CKB testnet + Solana devnet, web UI)
*2026-11-12. Fiber v0.9.1, two nodes on CKB testnet, channel [funding tx `0x3d695ebf…`](https://testnet.explorer.nervos.org/transaction/0x3d695ebf15d3908795618cf3a50a69bdb8be3e57f93fbb66c4bc5dd5ea37db5b) (1,000 CKB). HTLC program [`3NYcyDEL…xX9m`](https://explorer.solana.com/address/3NYcyDELHRt1Jr7A8APqPjYqr9bUDTZdo7pq4dqsxX9m?cluster=devnet) on devnet. Full write-up with diagrams: [`docs/nervos-talk-post.md`](docs/nervos-talk-post.md).*

One market maker sells SOL for CKB (and CKB for SOL) directly over Fiber. Both legs are locked to one SHA-256 hash: a Fiber TLC on CKB and the [`solana/htlc`](solana/htlc/src/lib.rs) escrow on Solana. No DEX hop, no hub, no BTC.

- **CKB → SOL:** the user holds the secret.
  - The LP issues a Fiber **hold invoice** on H, and the user pays it.
  - The LP locks SOL on H once the TLC is held, and the user claims it by revealing the secret.
  - The LP settles the invoice with the secret.
- **SOL → CKB:** the user's Fiber node holds the secret.
  - The node issues a normal invoice, and the user locks SOL on its payment hash for the LP.
  - The LP pays the invoice. `get_payment` hands it the preimage, and it claims the SOL.
- **Timelocks:**
  - Fiber randomizes TLC expiry: 50–146 h was observed for a single hop. Both sides therefore pass `tlc_expiry_limit = 24,000,000 ms`, which pins the TLC at exactly 6 h 40 min.
  - CKB → SOL: the LP's escrow lives 3 min in the demo, and the LP requires the TLC to outlive it by at least 1 h.
  - SOL → CKB: the user's escrow lives 7 h 05 min, and the LP requires it to outlive its TLC by at least 20 min.
- **`Cancel` (tag 3)** was added to the escrow: the claimer waives its claim, so a failed SOL → CKB swap returns the SOL at once instead of after 7 h.
- **Pricing:** live mid-market (CoinGecko) minus a 0.4% LP spread. The spread is a parameter.

| Run | Paid | Received | Time | Solana txs |
|---|---|---|---|---|
| CKB → SOL | 500 CKB | 0.005601632 SOL | 4.4 s | [lock](https://explorer.solana.com/tx/3HrniRujUZDdxc3JytURBFTPGkuJPL1WNTYofRtQisWThsnrUSBmG5jtwf3pkEjSd4aZAiQhEfZfABztxWB3VSTe?cluster=devnet), [claim](https://explorer.solana.com/tx/3s3NY6Mc6LgT1e1qTYgJSSQhUnYZ57Bf6BTh4JE3HeqYE7YFJhD1ZpNL8JcdhsXv1P4YjhAgTtxox4sAr4kC1H5M?cluster=devnet) |
| SOL → CKB | 0.003 SOL | 265.6411344 CKB | 5.0 s | [lock](https://explorer.solana.com/tx/GoS1VJqqSyUwzxcoSHebX7HojHtJb3c1dt2jt4CGJ2XzjPU47sdpjqyc16qekRoRyp6vnhZWrBRuEWm3CjXhJM3?cluster=devnet), [claim](https://explorer.solana.com/tx/2obBou1CdrtcPVDKyqfz5NC4kGcyymC5JW2AcrdKMc3K2XgSX8ApePJLHG6gYhaTaEAdxQedo5UEVtNt3N222Ce1?cluster=devnet) |
| CKB → SOL, from the web UI | 300 CKB | 0.003358285 SOL | 6.0 s | [lock](https://explorer.solana.com/tx/tVNAhxqxnqdvfRLLAkD3AALx9ciwp7AfqnY14n95KHDCgKHqgyf7A34TmDDQMQoWCmWZ4UDhhazCMwvVJQYF5D3?cluster=devnet), [claim](https://explorer.solana.com/tx/5tMokSs2sJjdLhFFd4RjjRpBLHbik1vUkSHPd8amXaNUQUCEbeegcYf2WYAvKnGXy8MVfhMuyLT1SyXwsc355jKj?cluster=devnet) |
| SOL → CKB, from the web UI | 0.005 SOL | 443.09043222 CKB | 4.4 s | [lock](https://explorer.solana.com/tx/5b3t125tSx27E1z8G7roni4gWgSeUs7ookwb14J5o4rHKRukVNJWS1YSPGDtSeXfQs7xaMGYmfy6yEh4YHBG4YxJ?cluster=devnet), [claim](https://explorer.solana.com/tx/5iFEYrLCtRprbCn3tpvtdDSveyVrhhqcUj9D7hRncP2XsXiodLRD7aSvhEfYwNWzPaSQo1eR2FEskwRp3DfH5RQK?cluster=devnet) |
| CKB → SOL, user walks away | 200 CKB | refunded (Fiber `InvoiceCancelled`) | 181.7 s | [lock](https://explorer.solana.com/tx/4jgLXKqYt9RDprZsXRP7hdmJoZF5Eu4nKGRjXb1UALVsCW6B53sc311SS52GH2KdL7hFmMUTHDN21kbxv4xem6iw?cluster=devnet), [LP refund](https://explorer.solana.com/tx/2S4k7mnYWuR6VuGa2ujVqfXn1vCvGoP3Jdx7LZGA4qSBpSDigAetJ8DzeWqyyCTJf3FZM3sMCU31jzWxm2qxZgNM?cluster=devnet) |
| SOL → CKB, invoice withdrawn | 0.002 SOL | refunded | 10.7 s | [lock](https://explorer.solana.com/tx/4R8sbeW7qmXGwmUGvexf9AojHRH6xgFywfxxqpF59p6Z4Qn5F6sGgpBCDjCPVcpJipVq4eKVtyxvFGacGfsb2GBd?cluster=devnet), [LP cancel](https://explorer.solana.com/tx/5vQRta3kgcUYUecwoaCnHbgcVaAW1fn3CWTPD4EouX7pyKaMQdWGUdvvSKN72krbJbSw8EnCPL3Yhzx56wAfh6qx?cluster=devnet) |

Web UI ([`lnroute/ui/index.html`](lnroute/ui/index.html), served by `lnroute/wallet.mjs` on `http://127.0.0.1:7080`): swap form with a live quote, channel and wallet balances, and a live two-lane trace (CKB · Fiber on the left, Solana on the right) with explorer links. Screenshots are in `docs/img/`.

Logs: `results/fiber-testnet-*.json`, `results/htlc-devnet.json` (escrow checks including `Cancel`, 11 rejections).

**Limits:**
- Testnet and devnet tokens only.
- One LP process with hot keys.
- The user's Fiber node and Solana key sit behind a local wallet backend, not a browser wallet.
- The user has a direct channel to the LP; a routed multi-hop payment is untested.
- A counterparty can make you wait for a timeout (up to ~7 h) but cannot take funds.
- A claim broadcast after the escrow expired would leak the secret; the wallet refuses to claim with less than 60 s left.

### Beyond Solana: Fiber ⇄ native ETH with Boltz’s contract, and key-share checks

Write-up: [`docs/nervos-talk-research.md`](docs/nervos-talk-research.md). Source notes for it are in `research_notes/`.

**Fiber ⇄ ETH (CKB testnet + Sepolia).** The Ethereum leg is Boltz’s EtherSwap v6, deployed unmodified from the `boltz-core` 5.0.0 build artifact to [`0xDcD8…b431`](https://sepolia.etherscan.io/address/0xDcD88d2fE9d521F5bF6B7B44479F3866c6ceb431). It locks on `sha256(secret)`, the same hash as the Fiber invoice.

| Run | Paid | Received | Time | Ethereum transactions | Gas (lock + claim) |
|---|---|---|---|---|---|
| CKB → ETH | 300 CKB | 0.0001368 ETH | 23.5 s | [lock](https://sepolia.etherscan.io/tx/0x3c3cb69a72c3a3a6c06afec9deb8e9a89611e32eeb39b09bde4feeb53a6fddce), [claim](https://sepolia.etherscan.io/tx/0xaa30616a03d2ed39e589014d83835389f348420e23add5c8f81f1267618044a1) (submitted by the LP key, paid to the user) | 135,617 + 35,257 |
| ETH → CKB | 0.0002 ETH | 435.06 CKB | 25.7 s | [lock](https://sepolia.etherscan.io/tx/0xeb944d9c936a31769ef9d90d569cb01f14aa7ca6166f3a4b66adaf7cff5a3055), [claim](https://sepolia.etherscan.io/tx/0xf0f2703e2d713f9be18da0aca47b840bc98dbdec9feca7280d20b7326132eb06) | 135,629 + 32,580 |

Run: `node lnroute/eth-swap.mjs --direction ckb2eth --amount 300` or `--direction eth2ckb --amount 0.0002` (needs the Fiber nodes from the direct route, plus `ETH_SEPOLIA_RPC` and `ETH_PRIVKEY` in the env file). Logs: `results/fiber-sepolia-*.json`.

Sepolia gas is not mainnet gas: the same `lock` simulates at 47,417 gas against mainnet. Sepolia headers already carry `blockAccessListHash`, and a plain transfer to a never-used address cost 204,600 gas there.

**Key-share checks (foreign half of a swap whose only contract is on CKB).** An address whose key is the sum of two parties’ secrets is funded and emptied with plain transfers; neither share alone can sign.

| Chain | Script | Fund | Sweep |
|---|---|---|---|
| Solana devnet | `solana/client/keyshare-test.mjs` | [tx](https://explorer.solana.com/tx/2naS99dziMbbUgqzqtEdp5NEYo9wzswYVeBbBJVuz5R62E8FP5sa6hMGokddZLUiws22MQvrWYeyDFcfftXfpvwe?cluster=devnet) | [tx](https://explorer.solana.com/tx/xZMMdXp3fsd6HD2WjwELVyyZGapM2vnqrYTDjd6mA6jSqWc1azNnhGruk6DS7oL1jph1cXv19VUekhDzd7X5MVR?cluster=devnet), System program only |
| Sepolia | `lnroute/keyshare-eth.mjs` | [tx](https://sepolia.etherscan.io/tx/0xa60c6e834d45e9709f31480bcb8577bf18bf825e57116096e952b09d6f475c24), 204,600 gas | [tx](https://sepolia.etherscan.io/tx/0x4591296f0b7a093e697e7da21fd53496d03ced153ae7064393d4527a1c0b38d7), 21,000 gas |

**Key-share lock on CKB** ([`ckb-keyshare/`](ckb-keyshare/src/main.rs), tests in `ckb-keyshare-tests/`). Three paths: claim (reveal the maker's scalar plus a release secret), refund after t1 (reveal the taker's scalar), punish after t2. Outputs must go to the named lock and hold all but 0.001 CKB. Measured in CKB-VM with ckb-testtool, not deployed:

| Curve | Claim | Refund | Punish |
|---|---|---|---|
| Ed25519 | 2,232,165 cycles | 2,222,828 | 54,196 |
| secp256k1 | 2,442,807 cycles | 2,434,364 | 54,148 |

Binary 106,392 bytes with both curves, 36,096 with Ed25519 only; a cell under the lock needs 61 CKB. Build and test in WSL: `cargo build --release` in `ckb-keyshare`, then `cargo test -- --nocapture --test-threads=1` in `ckb-keyshare-tests` (10 tests). `bash ckb-keyshare/measure.sh` builds every variant and rewrites `results/keyshare-lock-cycles.json`.

**Cardano hash-lock cost** (`cardano/`, Lucid Evolution emulator with mainnet epoch-667 parameters; ex-units confirmed by a preprod node; nothing submitted to a live network). The validator is `cardano-scaling/htlc` with `blake2b_256` swapped for `sha2_256` and a 32-byte secret check. Lock 0.172 ADA, claim 0.192 ADA with a reference script, refund 0.190 ADA; the locked output needs at least 1.35 ADA. A summed-key address costs 0.167 + 0.165 ADA to fund and sweep. Run `node cardano/measure.mjs --network emulator`; `--network preprod` works once the wallet in `cardano/wallet.local.json` holds test ADA. Numbers: `results/cardano-htlc-costs.json`.

**LP rebalancing quotes.** `node scripts/near-quotes.mjs` reads dry-run NEAR Intents quotes between native ETH, SOL and ADA against CoinGecko mid. On 2026-11-12 19:28 UTC: ETH ⇄ SOL 0.21–0.23% below mid, ADA pairs 0.30–0.60% (`results/near-intents-dry-quotes.txt`).

### Lightning route: Fiber → Cross-Chain Hub → Lightning → SOL (atomic swap, no bridge)
*2026-11-12. CKB dev chain + Bitcoin regtest (Fiber v0.9.1's own test harness) + Solana devnet. HTLC program [`3NYcyDELHRt1Jr7A8APqPjYqr9bUDTZdo7pq4dqsxX9m`](https://explorer.solana.com/address/3NYcyDELHRt1Jr7A8APqPjYqr9bUDTZdo7pq4dqsxX9m?cluster=devnet) (38.6 KB).*

This delivers native SOL rather than a wrapped token. One secret settles all three legs: the user picks a preimage and every leg is locked to its SHA-256 hash.

| Leg | Lock | Unlocks when |
|---|---|---|
| Fiber (CKB) | User → hub, wrapped-BTC UDT, TLC on H | the hub learns the preimage from Lightning |
| Lightning | Hub (LND "ingrid") → LP (LND "bob"), **hold invoice** on H | the LP learns the preimage from Solana |
| Solana | LP → user, [`solana/htlc`](solana/htlc/src/lib.rs) escrow on H | the user reveals the preimage |

- **Ordering keeps it safe:**
  - The LP locks SOL only once the Lightning HTLC is held with at least 12 blocks left. The Solana expiry is far shorter than the Lightning one.
  - The LP can't take the BTC before the user claims, and the user can't claim without publishing the preimage.
  - CCH enforces the Fiber > Lightning expiry ordering (`docs/specs/cch-expiry-dependency.md`).
- **If the user never claims:** the LP refunds itself at expiry and cancels the hold invoice. The hub's order fails, and the user's Fiber payment returns in full, with no hub fee.
- **Escrow program:**
  - The escrow PDA is `["htlc", offerer, H]`, so nobody can squat it.
  - Claims are permissionless but pay only the recorded claimer, and refunds pay only the offerer.
  - A claim is valid strictly before expiry and a refund from expiry on, so the two windows never overlap.
  - Costs: lock 8.7k–13k CU, claim 2.8k CU, refund 0.95k CU.
- **Tests:**
  - 2 host tests.
  - 13 on-chain checks (15 since `Cancel` was added for the direct route), run on localnet ([`results/htlc-localnet.json`](results/htlc-localnet.json)) and devnet ([`results/htlc-devnet.json`](results/htlc-devnet.json)). They cover lock/claim/refund, preimage recovery from the chain, and 9 rejections: duplicate lock, zero amount, past expiry, wrong PDA, wrong preimage, hash used as preimage, wrong claimer, wrong rent recipient, refund before expiry, claim after expiry.

**Runs** ([`lnroute/swap.mjs`](lnroute/swap.mjs) as the user, [`lnroute/lp.mjs`](lnroute/lp.mjs) as the LP):

| Run | What happened | Time |
|---|---|---|
| Swap, Solana devnet | 20,000 sat. User paid **20,160** wrapped-BTC units on Fiber (100 sat + 0.3% CCH fee). LP locked **0.175 SOL** ([4tEWEZ…](https://explorer.solana.com/tx/4tEWEZnCX9FTHXAk8KJbFefndhQoXT1EVGeuUFeDxMGWEamkGCn7MeC8eE4Cf8AiEd4XncpQ7tb1GXbLHYNs9KwB?cluster=devnet)). User claimed ([5SM2Ke…](https://explorer.solana.com/tx/5SM2KeCFEGCdvGVXhfbhUXAR7s64vBfcYNDy4thZ1GZs2DPxWA4oZAkfsr6aHSgLYXpQY9hs4o23NcUj4RgoNMrW?cluster=devnet)). LP settled Lightning, then the hub settled Fiber. Fiber payment `Success`, CCH order `Success`. | **7.0 s** |
| Walk-away, Solana devnet | 10,000 sat, user doesn't claim. LP refunded at expiry ([5R86it…](https://explorer.solana.com/tx/5R86itJeFf1vL1TkJFMUBEFP4f7ZcqkZALUDuoGrP7qKWcD96jMjbVpgNNYM7zcoiKF7HbZffzpd6PmnH76dQG7L?cluster=devnet)) and cancelled the hold invoice. Fiber payment `Failed: InvoiceCancelled`, user's channel balance unchanged. | 155 s (150 s TTL) |
| Same two runs, Solana localnet | 0.12 SOL received; the walk-away was refunded | 4.5 s / 122 s |

Logs: `results/lnroute-{devnet,local}-{swap,walkaway}.json`, `results/lnroute-lp-devnet.log`. The LP's price is a fixed demo rate (875 SOL/BTC = market on 2026-11-12).

**Not real-chain yet:**
- The CKB and Bitcoin legs ran on local dev chains.
- Fiber's mainnet config whitelists no wrapped-BTC UDT (only USDI), so no public mainnet hub accepts wrapped BTC today.
- The user starts from wrapped BTC, not CKB. The CKB → wrapped BTC step is a separate DEX trade.

**Estimated mainnet cost vs SimpleSwap** (2026-11-12, CoinGecko: CKB $0.000954, SOL $84.84, BTC $74,258; 100,000 CKB ≈ $95.4 ≈ 1.1244 SOL at mid-market):

| | Fees | SOL out for 100,000 CKB |
|---|---|---|
| SimpleSwap (floating quote read from the site) | ≈ 1.5% below mid | **1.1071** |
| This route as built: CKB → wBTC (CKB DEX) → Fiber → CCH → Lightning → LP | DEX 0.3% + slippage (thin) · CCH 100 sat + 0.3% (≈ 0.38% here) · Lightning ≈ 0 (direct channel) · LP spread ≈ 0.3–0.5% (assumed) · Solana claim 5,000 lamports | ≈ 1.106–1.113, i.e. 1.0–1.7% below mid (**roughly break-even**) |
| Same LP selling SOL directly against CKB over Fiber (no BTC hop, no DEX, no CCH) | LP spread ≈ 0.3–0.5% · fees ≈ 0 | ≈ **1.119–1.121** (≈ 1.1–1.3% more SOL than SimpleSwap) |

Three independent fee-takers (DEX, hub, LP) eat the margin. A route that beats SimpleSwap needs one market maker: an LP on Fiber that takes CKB (or a CKB stablecoin) on a hold invoice and locks SOL in the same escrow. The Solana program and LP logic carry over unchanged; only LND is swapped for Fiber.

## What this means for the bridge

- CKB produces about 9.4k blocks/day (~9.2 s blocks). Proving *every* header costs about 9.4k × 48.7k ≈ 0.46 B cycles/day. At the measured rate (~0.7 s/header for core proofs on one CPU) that's about 1.9 CPU-hours per day of chain. One commodity box, or a few dollars a day on Succinct's prover network, can follow mainnet with no FlyClient at all.
- With FlyClient, a tip update needs only a few hundred sampled headers plus an MMR branch each (~25 blake2b ≈ 190k cycles per sample). That's an *estimate* of about 60–250 M cycles per tip update, i.e. minutes on one CPU.
- So Eaglesong is not the bottleneck. The hard parts are soundness: difficulty rules (done in v3 as epoch-bounded checks), FlyClient parameters and the MMR extension off-by-one. Proof wrapping latency matters too.

## What's next
1. ~~Groth16 wrap + Sepolia verification~~ Done (above).
2. ~~Solana devnet verifier~~ Done (above): ~97k CU per proof, deployed, tip advanced on devnet.
3. ~~Deposit-cell proof → SPL mint on devnet~~ Done (above): CKB testnet deposit → 200 ckbCKB on devnet, ~109k CU.
4. ~~Burn → unlock path~~ Done (v3, above): custody lock + Solana `Burn` + 2-of-3 attesters, 120 CKB returned on testnet.
5. Light client: ~~epoch/difficulty rules, fork choice by cumulative work, two-sided height bound~~ done (v3). Still open: MMR membership (RFC 44 chain root) so deposits don't need a header chain to a recent tip, and FlyClient sampling so a new client doesn't need every header from a trusted checkpoint.
6. Trust-minimise Solana → CKB: independent attester operators, committee rotation, a challenge window or rate limit; longer term a ZK proof of Solana consensus checked in CKB-VM.
7. Compare notes with Antismart (t/10372) and T_Silva (Chiral, t/10360) on the mainnet/testnet PoW difference and a shared `no_std` crate.
8. Swaps: ~~Fiber → CCH → Lightning → SOL~~ done locally; ~~direct Fiber LP, CKB ⇄ SOL, on CKB testnet + Solana devnet with a web UI~~ done (above). Next: route through public Fiber testnet nodes instead of a direct channel, a browser wallet instead of the local backend, LP inventory rebalancing (the bridge above is one way), and a wider claim-safety margin with fee bumping.

## Layout & how to run
```
ckb-pow/            no_std verifier (vendored Eaglesong, MIT — see LICENSE-eaglesong): headers, epoch/difficulty rules, deposit.rs (CBMT + molecule) + tests
program/            SP1 guest (kind 1 segment with parent header, kind 2 deposit)
script/             SP1 host: --execute / --prove --system core|compressed|groth16|plonk, --segment / --deposit <fixture>
ckb-custody/        CKB custody lock (Rust, riscv64imac, ckb-std 1.1, ed25519-compact); build/custody-lock = deployed binary
ckb-custody-tests/  ckb-testtool tests for the custody lock
ckb-keyshare/       key-share swap lock (Rust, curve25519-dalek + k256); measure.sh builds every variant
ckb-keyshare-tests/ ckb-testtool tests and cycle measurements for the key-share lock
cardano/            Cardano hash-lock and summed-key cost measurements (Lucid Evolution emulator / preprod), Aiken validator in onchain/
ckb/                CCC scripts: custody.mjs (keys/deploy/vault/deposit/unlock/status), attest.mjs, deposit.mjs (v2), balances.mjs, wallet-lock.mjs
solana/             program/ (light client + bridge + burn + Groth16 verifier), client/ (run.mjs v1, bridge.mjs v2, bridge-v3.mjs), sp1-v6.1.0/ (.sol), deploy/ (.so)
fixtures/           headers (fetch_headers.py), epoch boundaries (fetch_epoch_boundary.py), deposits (fetch_deposit.py), proofs/
solana/htlc/        SHA-256 HTLC escrow (Lock / Claim / Refund) for the Lightning route; client in solana/client/htlc-lib.mjs + htlc-test.mjs
lnroute/            direct route: lp-fiber.mjs (LP), wallet.mjs (user backend + UI server), ui/ (web UI), fiber-channel.mjs, run-swap.mjs, demo.sh
                    Lightning route: lp.mjs (Lightning hold invoice <-> Solana escrow LP), swap.mjs (user side), channel-setup.mjs (Fiber wBTC channel)
docs/               nervos-talk-post.md (architecture + results write-up), img/ (UI screenshots)
results/            raw logs from the runs above
scripts/            WSL helpers: sp1.sh, bench-*.sh, exec-bridge.sh, prove-bridge.sh, solana-test.sh, deploy.sh, local-validator.sh
```
Native tests: `cargo test -p ckb-pow --features rpc --release` (17 tests). Solana: `bash scripts/solana-test.sh test` (12 tests). Custody lock (WSL): build `ckb-custody` with `cargo build --release`, then `cargo test --release` in `ckb-custody-tests` (4 tests, 11 rejection cases).

Round trip (v3), with `E=<path to .env>`:
1. `node ckb/custody.mjs keys`, then `deploy --env $E --from 3`, then `vault --env $E --from 3 --config <solana config pubkey>`
2. `node ckb/custody.mjs deposit --env $E --from 1 --ckb 300`, then `python -I scripts/fetch_deposit.py <tx> 0 12 4 fixtures/deposit-testnet-v3.json`
3. `scripts/prove-bridge.sh fixtures/deposit-testnet-v3.json bridge-v3`, then regenerate `vk.rs` with `scripts/gen_vk_rs.py`, then `scripts/solana-test.sh all`, then `scripts/deploy.sh <rpc> <payer.json> ckb_bridge_v3`
4. `node solana/client/bridge-v3.mjs --rpc <rpc> --program <id> --payer env:$E --config-keypair solana/deploy/bridge-v3-config-keypair.json --ckb-lock <code_hash>:<hash_type>:<args>` (`ckb/wallet-lock.mjs` prints a wallet's lock)
5. `node ckb/attest.mjs --env $E --program <id> --seq 0 --signers 0,2 --out att.json`, then `node ckb/custody.mjs unlock --env $E --from 1 --attestation att.json` (add `--dry-run` to test without sending)

Direct route on testnet (WSL for the Fiber nodes, node on Windows or WSL for the rest):
1. `scripts/lnroute-install.sh`, then `scripts/fiber-testnet-up.sh` as a long-running job (user node :8227 = WALLET_4, LP node :8237 = WALLET_5 from the `.env`)
2. `node lnroute/fiber-channel.mjs --ckb 1000` (opens the user → LP channel; skip if it exists)
3. `bash scripts/htlc-test.sh all`, then `bash scripts/htlc-devnet-deploy.sh` (deploys or upgrades the escrow, funds the LP key once)
4. `bash lnroute/demo.sh`, then open `http://127.0.0.1:7080`. Scripted: `node lnroute/run-swap.mjs --direction ckb2sol --amount 300` (`sol2ckb --amount 0.003`; add `--walk-away` for the refund path)

Lightning route (WSL + Windows node):
1. `scripts/lnroute-install.sh` (pinned CKB 0.202, Bitcoin Core 27, LND 0.18, fnn 0.9.1 into `~/lnroute/bin`; the Fiber source at tag v0.9.1 is cloned to `~/lnroute/fiber-src`), then `scripts/lnroute-up.sh` as a long-running job
2. `bash scripts/htlc-test.sh all`, then deploy `solana/deploy/sol_htlc.so` (`scripts/htlc-devnet-deploy.sh`, or `scripts/htlc-localnet.sh` for a local validator)
3. `node lnroute/channel-setup.mjs`, then `node lnroute/lp.mjs --lnd http://127.0.0.1:8180 --sol-rpc <rpc> --program <id> --lp-key <kp> --rate-sol-per-btc 875`
4. `node lnroute/swap.mjs --sats 20000 --hub-rpc http://127.0.0.1:21716 --fiber-rpc http://127.0.0.1:21714 --sol-rpc <rpc> --user-key env:$E` (add `--no-claim` for the refund path)

SP1 (WSL): `wsl -d Ubuntu-24.04 -- bash /mnt/e/CKB/spike-eaglesong-sp1/scripts/sp1.sh --execute --n 16`

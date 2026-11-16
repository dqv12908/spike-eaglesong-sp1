# Cardano rails for a CKB (Fiber, SHA-256 hash lock) -> native ADA non-custodial swap — state as of 12 Nov 2026

Research date: 2026-11-12. Conventions: "Verified" = read from a primary source in this session (repo file, official docs, forum thread). "Secondary" = press/aggregator only. "Unverified" = could not be confirmed; listed under Gaps. Figures from DefiLlama were pulled from its public API on 2026-11-12.

---

## 1. Cardano Lightning (CL) and Konduit

### Takeaway
Konduit ("A Cardano to Bitcoin Lightning Network pipe") and the bidirectional "Cardano Lightning" (CL) protocol are two Aiken payment-channel protocols from the same two-person team (paluh / waalge); both use **SHA2-256 hash locks with a 32-byte secret**, i.e. the same lock as a BOLT11 payment hash (and as Fiber's SHA-256 lock), with Ed25519-signed off-chain "cheques". Status is "incubating": the Catalyst project closed out on 31 Oct 2026 with a mainnet *demonstration* only, no commercial adaptor/gateway, no audit found, and only the ADA -> Lightning direction productised — the reverse (receive ADA for a Lightning-style payment) exists only as the un-deployed bidirectional CL spec/contracts.

### Cited Findings
**Who / what / funding (verified)**
- GitHub org `cardano-lightning` hosts `konduit` (Rust, "A Cardano to Bitcoin Lightning Network pipe", last push 11 Nov 2026), `konduit-js` (TypeScript), `cardano-lightning` ("Discussions, specs, smart contracts", Aiken, last push 30 Jun 2026), `cardano-lightning-hs`, `konduit-app`, `blog`, `pyken`. — [github.com/cardano-lightning](https://github.com/cardano-lightning)
- Konduit README: "This project is incubating. Expect sharp edges." License MPL-2.0; 9 stars, ~637 commits, **no releases/tags**; structure = connector (Cardano API layer), kernel (on-chain Aiken), Rust workspace, docs. — [konduit repo](https://github.com/cardano-lightning/konduit)
- Catalyst close-out report (dated 2026-10-31, authors paluh = Tomasz Rybarczyk and waalge = Dominic Wallis): project "Cardano Lightning Network (Phase 1) - Payment Gateways", Catalyst project no. 1200060, started Sept 2024, completed Oct 2026. Deliverables: bidirectional channels in Aiken (CL), unidirectional channels in Aiken (Konduit kernel), a Konduit/CLN node server handling "Cardano Lightning to Cardano Lightning node and Cardano Lightning to Bitcoin Lightning node" payments, PWAs app.konduit.channel and Ferret (by KtorZ), a TS SDK. — [close-out report source](https://github.com/cardano-lightning/blog/blob/main/pages/blog/closeout-report.md)
- Usage statement in the same report: "There are no comercial payment gateways yet on the chain so the usage is not real"; Konduit (Cardano -> BLN) was demoed "on a mainnet during the last BTC Prague but it was only the demonstration". Part of waalge's work was funded by the Cardano Foundation. The team is seeking further funding. — [close-out report source](https://github.com/cardano-lightning/blog/blob/main/pages/blog/closeout-report.md)
- Catalyst pages: F12 "Cardano Lightning Network (Phase 1) - Payment Gateways" — [projectcatalyst.io F12](https://projectcatalyst.io/funds/12/cardano-use-cases-concept/cardano-lightning-network-phase-1-payment-gateways); F13 follow-ups "Stratus: the merchant node and SDK" — [lidonation](https://lidonation.com/en/proposals/cardano-lightning-stratus-the-merchant-node-and-sdk-f13) and "Calvus: the gateway node" (page title shows "not approved") — [lidonation](https://lidonation.com/en/proposals/cardano-lightning-calvus-the-gateway-node-f13).
- Cardano Foundation CEO Frederik Gregaard posted that he "bought stickers using ADA through Konduit at a Bitcoin Lightning point of sale" (X post; date not captured, consistent with the BTC Prague demo). — [x.com/F_Gregaard](https://x.com/F_Gregaard/status/2067506902418723316)
- External contributors include KtorZ, AndrewWestberg, SupernaviX; a large open PR (#185) adds multi-currency (stablecoin-backed) channels and is "still awaiting review". — [close-out report source](https://github.com/cardano-lightning/blog/blob/main/pages/blog/closeout-report.md)

**Konduit on-chain design ("kernel") (verified from design doc)**
- Single validator; one UTxO per channel. "Konduit is unidirectional with HTLC support" (Subbit.xyz = unidirectional, CL = bidirectional with HTLC). — [31_kernel.md](https://github.com/cardano-lightning/konduit/blob/main/docs/design/31_kernel.md)
- Lifecycle steps: `open`, `add`, `sub`, `close`, `respond`, `unlock`, `expire`, `end`, `elapse`. Consumer locks ADA on L1; Adaptor can `sub` funds owed using a receipt (squash + unlocked cheques); after `close`, a `close_period` window lets Adaptor `respond`; pending (locked) cheques are resolved by Adaptor revealing the secret before the timeout or Consumer demonstrating expiry. — [31_kernel.md](https://github.com/cardano-lightning/konduit/blob/main/docs/design/31_kernel.md)
- Hash lock: "Only `Sha2_256` locks are available (cf Cardano Lightning with support for other lock types)". Cheque body = `(Index, Amount, Timeout, Lock)` with `Lock = Bytes32`; "A secret is a bytearray that hashes (sha2 256) to the lock"; secret must be exactly 32 bytes. ADA-only channels in the first iteration. — [31_kernel.md](https://github.com/cardano-lightning/konduit/blob/main/docs/design/31_kernel.md)
- Cheques are signed over `concat(tag, serialize(cheque_body))` and verified against the Consumer key; batching many channel steps in one tx and "mutual txs" (both sign, anything goes) are first-class. — [31_kernel.md](https://github.com/cardano-lightning/konduit/blob/main/docs/design/31_kernel.md)

**How an ADA holder pays a BOLT11 invoice (verified)**
- Flow: Consumer opens a channel with an Adaptor (a service provider that also has BLN channels) -> scans a BLN invoice -> requests a quote -> Adaptor answers with total cost in ADA -> Consumer sends a locked cheque -> Adaptor routes on BLN, obtains the preimage ("secret"), sends it to Consumer -> Consumer validates and returns a "squash". — [konduit.channel](https://konduit.channel/)
- L2 API: `QuoteRequest` includes `Bolt11(String, Option<Amount>)`; the quoted amount "is calculated from the BLN response, known exchange rates and Adaptor's own fee"; Adaptor then routes "with computed fee limit set and timeout set". — [31_5_l2_protocol.md](https://github.com/cardano-lightning/konduit/blob/main/docs/design/31_5_l2_protocol.md)
- Fees: no fixed protocol fee; fee = Adaptor's own margin + BLN routing fee + FX rate, shown as an "effective fee" on the consent screen. — [12_scenarios.md](https://github.com/cardano-lightning/konduit/blob/main/docs/design/12_scenarios.md); [31_5_l2_protocol.md](https://github.com/cardano-lightning/konduit/blob/main/docs/design/31_5_l2_protocol.md)
- Adaptor self-hosting assumptions: Ubuntu 24.04, `bitcoind`, `lnd` (REST), `cardano-node` and `dolos` on one host. — [13_assumptions.md](https://github.com/cardano-lightning/konduit/blob/main/docs/design/13_assumptions.md)

**Maturity (verified)**
- Roadmap (repo): Phase 1 items mostly ticked, but "Property-based testing for fund safety invariants" unticked; Phase 2 (alpha) "Successful end-to-end payment via CLI in real-ish conditions" unticked; Phase 3 (beta) items — bolt11 support in consumer app, recovery logic, full kernel test/benchmark suite, quantified Adaptor risk assessment, ">100 payments (testnet or mainnet)", ">2 externally maintained Adaptor deployments" — all unticked. Note the roadmap file may lag the code. — [roadmap.md](https://github.com/cardano-lightning/konduit/blob/main/docs/roadmap.md)
- Project log latest entry is 2026-04-19 (kernel tests, new roadmap). — [log.md](https://github.com/cardano-lightning/konduit/blob/main/docs/log.md)
- No audit is mentioned in the README, roadmap, close-out report or landing page. — [konduit repo](https://github.com/cardano-lightning/konduit); [close-out report source](https://github.com/cardano-lightning/blog/blob/main/pages/blog/closeout-report.md)

**CL (bidirectional) spec (verified)**
- README: "Bidirectional payment channels inspired and compatible with Bitcoin Lightning Network". — [cardano-lightning repo](https://github.com/cardano-lightning/cardano-lightning)
- L1 spec types: `type HashLock { Sha2256Lock(Hash32) }`, `Htlc = (Index, Amount, Timeout, HashLock)`; cheque signatures are `Bytes64` and "`verify` functions are `Ed25519` functions" (aligned with Cardano tx signing). — [l1-spec.md](https://github.com/cardano-lightning/cardano-lightning/blob/main/docs/design/l1-spec.md)
- Benchmarks v0.1.0: with max 1 pending cheque, one tx fits ~60 channel opens, 46 adds, 36 closes, 36 responds; worst case with 20 pending cheques is 8 resolve-end steps per tx. — [aik/bench/README.md](https://github.com/cardano-lightning/cardano-lightning/blob/main/aik/bench/README.md)

**Parallel, separate effort: PolyCrypt / Perun / Cardinal "Cardano Lightning" (secondary sources)**
- Developer session 24 Aug 2026 (PolyCrypt engineer Ilja von Hoessle): stack = fork of LDK Node, Rust relay, liquidity-manager smart contract; "currently in pre-production deployment"; no fee figures. The article describes Konduit as enabling "a customer to pay in ADA while the merchant receives native BTC over the Lightning Network". — [Crypto Briefing, 27 Aug 2026](https://cryptobriefing.com/cardano-bitcoin-lightning-payment-channels/)
- Dutch/German coverage: demo runs on Cardano Preprod, no mainnet and no real BTC yet; the prototype relay "holds keys, signs transactions, and can close Lightning channels". — [cryptobenelux](https://cryptobenelux.com/altcoin-nieuws/cardano-toont-lightning-prototype-maar-mainnet-en-echte-btc-ontbreken-nog); [kryptorevolution.de](https://kryptorevolution.de/bitcoin-lightning-kommt-zu-cardano-erster-test/) (both via search summaries; pages returned 403 on fetch)
- Related Catalyst projects: F13 "Secure cross-chain Bitcoin Lightning and Cardano channels with Perun" — [projectcatalyst.io](https://projectcatalyst.io/funds/13/cardano-open-developers/secure-cross-chain-bitcoin-lightning-and-cardano-channels-with-perun); F14 "Bitcoin Lightning payments on Cardano using Cardinal" — [projectcatalyst.io](https://projectcatalyst.io/funds/14/cardano-open-developers/bitcoin-lightning-payments-on-cardano-using-cardinal).

### Inferences
- Hash compatibility with Fiber is exact at the primitive level: a Fiber invoice locked with SHA-256 of a 32-byte preimage can share its payment hash with a Konduit/CL cheque lock (`Sha2_256`, 32-byte secret). No hash translation or ZK is needed for the Cardano leg.
- Direction mismatch: Konduit is Consumer(ADA) -> Adaptor -> Lightning *payee*. A CKB->ADA swap needs the opposite: the LP receives on Fiber and *pays ADA* on Cardano. With Konduit as-is, the LP would have to be the "Consumer" with a channel to an Adaptor and the end user would have to be reachable as a payee behind that Adaptor (a CL-to-CL payment per the close-out report), which requires the user to run CL/Konduit software — not "native ADA to any address".
- The simplest reuse is therefore not the channel network but its ideas/code: the Aiken HTLC cheque logic (sha2_256, 32-byte secret, POSIX timeout) and the Rust/WASM + TS SDKs. A one-shot L1 HTLC paying a plain address is far simpler than the channel kernel.
- The Crypto Briefing article appears to merge two different projects (Konduit by cardano-lightning, whose adaptor targets `lnd`/CLN, and PolyCrypt's LDK-fork "Cardano Lightning"/Cardinal stack). Treat its "Konduit is built on a forked LDK" framing as unreliable.

### Gaps
- No primary statement of Konduit kernel mainnet script address, deployed adaptor endpoints, or exact date of the BTC Prague mainnet demo.
- No audit report found for either Konduit kernel or CL contracts; absence of mention is not proof of absence.
- Concrete fee numbers (Adaptor margin) and min channel size are not published.
- Could not fetch cexplorer's "Progress on Cardano-Bitcoin interoperability in March 2026" (403) — likely a useful secondary summary: https://cexplorer.io/article/progress-on-cardano-bitcoin-interoperability-in-march-2026
- Status of PolyCrypt/Cardinal Lightning beyond Preprod after Aug 2026 unverified.

---

## 2. Hydra (heads, HTLCs, cross-head payments)

### Takeaway
Hydra is on mainnet in an "adoption phase" with very few production users (DeltaDeFi named), and it changed heavily in 2026 (v2 line, deposits instead of commits, partial fanout, a fund-theft security fix in Sept 2026). HTLCs inside heads exist only as demos (Hydra-to-Hydra routing via an Aiken HTLC; a community Lightning<->Hydra SHA-256 demo) — not production-ready, and a head only helps if the ADA recipient is a head participant.

### Cited Findings
- Hydra "adoption phase" announced 20 Feb 2026 (working group session 11 Feb 2026). DeltaDeFi (order-book DEX) presented its mainnet deployment strategy; Masumi (agent micropayments) is a prospective user. Reported issues: heads getting stuck with excessive UTxOs, memory pressure, out-of-sync nodes accepting L2 input (fixed), unbounded snapshots (fixed). — [IOG, 20 Feb 2026](https://www.iog.io/news/hydra-adoption-phase)
- Releases (2026): 1.3.0 (5 Mar; default contestation period changed from 10 minutes to **12 hours**); 2.0.0 alpha (2 Apr; heads open directly with no commit phase, funds added through deposits, removes the hard-coded 100 ADA mainnet commit limit); 2.2.0 (12 Jun; partial fanout verified with a BLS accumulator proof); 2.4.1 (2 Sep; **security release GHSA-cg83-6w6r-6hx3**: an invalid L2 transaction could be included in a confirmed snapshot letting a malicious head participant steal funds; 2.3.0/2.4.0 operators told to upgrade immediately); 2.4.2 (22 Oct; latest; cardano-node 11.1.3; delegated-head demo; new script hashes for preview, preprod, mainnet). — [hydra releases](https://github.com/cardano-scaling/hydra/releases)
- IOG scaling post caveats (via search summary): limited number of participants, static topology, fund lock-up risk if UTxOs too large. — [IOG "Scaling Cardano applications with Hydra"](https://www.iog.io/news/scaling-cardano-applications-with-hydra)
- Official HTLC demo: issue #2080 "HTLC across two Hydra Heads" (milestone "CNT payments across Heads"), closed as completed 7 Jan 2026. Scenario: Head 1 = Alice+Ida, Head 2 = Ida+Bob; Alice pays Bob through Ida using an Aiken HTLC script running on L2, modelled on Interledger Hashed Timelock Agreements; "no fees for now"; hydra-node unchanged. Sub-issues cover a standardized invoice datum format (#2401) and testing timelock expiry / head close during HTLC (#2402). — [hydra issue #2080](https://github.com/cardano-scaling/hydra/issues/2080); status line "Finished the HTLC demo (#2080)" — [Hydra update 6 Nov 2025](https://updates.cardano.intersectmbo.org/2025-11-06-hydra)
- `cardano-scaling/hydra-lightning-router`: "Demonstration of routing a payment between two hydra heads" using the htlc validator and an invoice representation (repos `cardano-scaling/htlc` — "Hashed TimeLock Contract in aiken", 11 commits, 1 star — and `hydra-invoices`). No releases; described as a demonstration. — [hydra-lightning-router](https://github.com/cardano-scaling/hydra-lightning-router); [cardano-scaling/htlc](https://github.com/cardano-scaling/htlc)
- EUTxO L2 Interoperability (Catalyst F13, project 1300098): HTLC validator with `Claim`/`Refund` redeemers; datum = `hash`, `timeout` (PosixTime), `sender`, `receiver` (VerificationKeyHash); Claim must be before timeout and signed by receiver, Refund after timeout signed by sender; intermediaries use a shorter timeout. Later contract versions are "proof of concept" and "should not be considered safe to use". Notes production Hydra contestation periods "can last several days". — [eutxo-l2-interop docs](https://cardano-scaling.github.io/eutxo-l2-interop/print.html)
- Community Lightning<->Hydra design (Vtechcom_labs, 13 Jan 2026): Alice pays BTC over Lightning, LP "Bob" locks ADA in an HTLC inside a Hydra head, both legs share `SHA256(x)` of a random 32-byte preimage; example timeouts 40 s (Hydra) vs 90 s (Lightning invoice); "currently building"; repo Vtechcom/hydra-htlc-demo. — [Cardano Forum](https://forum.cardano.org/t/beyond-bridges-unlocking-true-interoperability-between-bitcoin-lightning-and-cardano-hydra/152501)
- Catalyst F15 proposal "BTC Lightning–Hydra atomic bridge (HTLC, non-custodial MVP)" states Cardano currently has no decentralized non-custodial mechanism between Lightning and a Hydra head. — [projectcatalyst.io F15](https://projectcatalyst.io/funds/15/cardano-use-cases-prototype-and-launch/btc-lightning-hydra-atomic-bridge-htlc-non-custodial-mvp)
- cardano-lightning team's opinion (interested party): "Hydra is not sufficient to be usable in the broader payment context as it lacks composition". — [close-out report source](https://github.com/cardano-lightning/blog/blob/main/pages/blog/closeout-report.md)

### Inferences
- An LP *can* hold ADA in a head and settle HTLCs in sub-second time, but only toward counterparties who are members of that same head (fixed participant set, everyone online). For a swap whose output is "native ADA at the user's ordinary L1 address", Hydra adds an L1 decommit/fanout step and gives no advantage over a direct L1 HTLC or plain L1 payment.
- With 12-hour default contestation and a September 2026 critical L2-validation bug, Hydra should be treated as experimental infrastructure for third-party funds.
- The Hydra-side demos are still the best ready-made Aiken HTLC + invoice-datum references for a SHA-256/timeout validator.

### Gaps
- Hash function of `cardano-scaling/htlc` and of the F13 interop HTLC not stated on the pages read (the validator source was not opened due to GitHub API rate limits). Vtechcom's design explicitly says SHA256.
- No quantitative mainnet usage data (number of open heads, TVL in heads) found.
- Status/results of the F15 Lightning–Hydra MVP and of Vtechcom/hydra-htlc-demo unverified.

---

## 3. Existing HTLC / atomic-swap validators and prior cross-chain swap deployments

### Takeaway
There is no audited, widely-used generic HTLC validator on Cardano; what exists is (a) reference/demo Aiken HTLCs (Cardano Foundation templates, cardano-scaling/htlc, AngeYobo), (b) the Konduit/CL cheque logic, and (c) one publicised mainnet BTC<->ADA HTLC atomic swap by FluidTokens (25–26 Mar 2026, 0.0001 BTC for 50 ADA) whose code/hash details were not found. An HTLC on Cardano is cheap and simple: hash check via `sha2_256` builtin, timelock via tx validity interval, roughly 1–2 ADA of refundable min-UTxO and a few tenths of an ADA in fees.

### Cited Findings
- FluidTokens announced (26 Mar 2026) the first native Bitcoin–Cardano atomic swap on mainnet: 0.0001 BTC for 50 ADA, script-to-script, one party locking BTC in an HTLC and the counterparty locking ADA in a Plutus script "using the same hash", automatic refunds on timeout. — [Cardano community digest, 31 Mar 2026](https://cardano.org/news/2026-03-31-community-digest/) (confirms event only); details from secondary coverage: [KuCoin news](https://www.kucoin.com/news/flash/cardano-completes-first-btc-ada-atomic-swap-via-fluid-tokens), [AlphaWire](https://alphawire.xyz/news/bitcoin/bitcoin-unlocks-new-defi-route-as-cardano-executes-trustless-btc-ada-swap/), [The Crypto Basic](https://thecryptobasic.com/2026/03/27/fluidtokens-executes-first-bitcoin-cardano-atomic-swap-on-mainnet/)
- Cardano Foundation "cardano-templates" repo includes an HTLC use case (owner locks funds with an expiration and a secret; unlock before expiry with the secret; owner reclaims after expiry) with Aiken and Scalus implementations and a Cardano-Client-Lib (Java) off-chain; no audit statement. — [cardano-foundation templates /htlc](https://github.com/cardano-foundation/cardano-template-and-ecosystem-monitoring/tree/main/htlc)
- Hydra issue #2080 references `AngeYobo/htlc-contract-aiken` as an example Aiken HTLC. — [hydra issue #2080](https://github.com/cardano-scaling/hydra/issues/2080)
- Kaamos OTC: "Trustless ADA <-> USDC atomic swaps between Cardano and Midnight Network", Aiken/PlutusV3 + HTLC, bidirectional. — [willmtl/kaamos-otc](https://github.com/willmtl/kaamos-otc) (repo description only; not reviewed)
- `fallen-icarus/cardano-swaps` and `honungsburk/atomic-swap` are *same-chain* swap protocols (order-book / multisig), not cross-chain HTLCs. — [cardano-swaps](https://github.com/fallen-icarus/cardano-swaps); [atomic-swap](https://github.com/honungsburk/atomic-swap)
- HTLC semantics used in Cardano designs: datum `(hash, timeout: PosixTime, sender, receiver)`; `Claim` valid only if tx upper validity bound is before timeout and receiver signs; `Refund` valid only if lower bound is after timeout and sender signs. — [eutxo-l2-interop docs](https://cardano-scaling.github.io/eutxo-l2-interop/print.html)
- Min-UTxO: `(160 + output size in bytes) × coinsPerUTxOByte (4,310 lovelace)`; a 67-byte ADA-only output needs 978,370 lovelace. — [cardano.org fees page](https://cardano.org/fees-and-transactions/)
- Fee parameters: 44 lovelace/byte + 155,381 lovelace base; execution prices 0.0577 lovelace per memory unit and 0.0000721 lovelace per CPU step. — [cardano.org fees page](https://cardano.org/fees-and-transactions/); [Cardano Course handbook](https://cardano-course.gitbook.io/cardano-course/handbook/protocol-parameters-and-configuration-files/protocol-parameters)

### Inferences
- Estimated cost of an L1 HTLC (my arithmetic, not a measured figure): lock tx ~300–450 bytes -> ~0.17–0.18 ADA; HTLC output with inline datum (32-byte hash + timeout + two 28-byte key hashes, ~150–200 bytes) -> min-UTxO ~1.4–1.6 ADA (refundable, goes to the claimer). Claim tx ~500–700 bytes -> ~0.18–0.19 ADA base + execution (a hash + signature + interval check is on the order of 10^5 mem / 10^7–10^8 steps -> ~0.01–0.02 ADA) + reference-script fee (15 lovelace/byte × 1–3 kB = 0.015–0.045 ADA) => ~0.2–0.3 ADA. Total LP+user cost about 0.4–0.5 ADA per swap plus temporarily locked min-UTxO.
- Timelocks on Cardano are enforced through the transaction validity interval (slots, 1 s resolution) compared with a POSIX-time datum; the claim deadline must leave margin for Cardano settlement (see section 7) and must expire *before* the Fiber-side HTLC expiry in the direction where the LP reveals/learns the preimage.
- In the CKB->ADA direction the user holds the preimage: LP locks ADA in an HTLC keyed to the user's SHA-256 payment hash; the user claims on Cardano revealing the preimage in the redeemer (public on-chain), and the LP uses it to settle the Fiber HTLC. A plain SHA-256 HTLC validator is sufficient; no Konduit/Hydra dependency required.

### Gaps
- FluidTokens' swap: hash function, timelock lengths, contract source and audit status not found in any source read; product availability to the public unverified.
- No Ergo<->Cardano HTLC atomic-swap deployment was found in searches (Rosen Bridge is a guard/watcher bridge, not HTLC).
- No "Atomic Swap by SundaeLabs" cross-chain product was found; BitcoinOS/Cardinal/BitVMX current status not verified in this session (see section 6).
- No measured script size / ex-units for any HTLC validator were retrieved; the fee estimate above is derived, not sourced.

---

## 4. Plutus V3 builtins and cryptographic compatibility with CKB

### Takeaway
PlutusV3 on mainnet has `sha2_256`, `sha3_256`, `blake2b_256`, `blake2b_224`, `keccak_256`, `ripemd_160`, Ed25519, ECDSA-secp256k1, Schnorr-secp256k1 (BIP-340) and 17 BLS12-381 builtins. `blake2b_256` takes one argument and has **no personalization parameter**, so CKB's `ckb-default-hash` Blake2b cannot be computed with the builtin; a CKB-key secp256k1 ECDSA signature can be verified only over a caller-supplied 32-byte digest in compact 64-byte form with a compressed pubkey. Groth16 over BLS12-381 is verifiable in one transaction (CIP-381 estimates ~23% of the tx CPU budget).

### Cited Findings
- Builtin availability by ledger language / hard fork (Plutus source `PlutusLedgerApi.Common.Versions`): batch 1 (`sha2_256`, `sha3_256`, `blake2b_256`, `verifyEd25519Signature`) — V1 Alonzo, V2 Vasil, V3 Chang; batch 3 (`verifyEcdsaSecp256k1Signature`, `verifySchnorrSecp256k1Signature`) — V2 Valentine, V3 Chang; batch 4a (`bls12_381_*`, `keccak_256`, `blake2b_224`) — V3 Chang; batch 4b (`integerToByteString`, `byteStringToInteger`) — V3 Chang (PV9), V2 Plomin; batch 5 (`ripemd_160`, bitwise ops e.g. `andByteString`, `readBit`, `shiftByteString`) — V3 Plomin; batch 6 (`expModInteger`) — van Rossem hard fork (PV10 -> PV11), which also back-ports earlier batches to V1/V2. — [PlutusLedgerApi.Common.Versions](https://plutus.cardano.intersectmbo.org/haddock/latest/plutus-ledger-api/src/PlutusLedgerApi.Common.Versions.html)
- CIP-381 (BLS12-381) status Active, "Included within the Chang #1 hardfork"; 17 builtins: G1/G2 add, scalarMul, neg, equal, compress, uncompress, hashToGroup; `millerLoop`, `mulMlResult`, `finalVerify`. CPU costs listed: `millerLoop` 402,099,373; `finalVerify` 388,656,972; `G1_scalarMul` ~94,955,259; `G1_uncompress` 16,511,372; `G2_uncompress` 33,114,723; `G1_add` 1,046,420. Groth16 verification estimated at ~23% of the execution budget ("benchmarks confirmed"). Compressed sizes G1 48 bytes, G2 96 bytes. — [CIP-0381](https://github.com/cardano-foundation/CIPs/blob/master/CIP-0381/README.md)
- CIP-49 (Active; Valentine hard fork): ECDSA verify takes a **33-byte compressed** pubkey (0x02/0x03 prefix), "a 32-byte hash of the message" ("only the length is checked" — caller hashes), and a **64-byte r‖s compact** signature (not DER; no recovery byte). Schnorr verify takes a 32-byte x-only key, arbitrary-length message, 64-byte BIP-340 signature. Motivation cites bridge interoperability (Wanchain, Renbridge). — [CIP-0049](https://github.com/cardano-foundation/CIPs/blob/master/CIP-0049/README.md)
- CIP-127 (`ripemd_160`) states it is enabled by the Plomin hard fork. — [CIP-0127](https://cips.cardano.org/cip/CIP-0127)
- Aiken stdlib signatures: `blake2b_224(bytes)`, `blake2b_256(bytes)`, `keccak_256(bytes)`, `sha2_256(bytes)`, `sha3_256(bytes)`, `verify_ecdsa_signature(key, msg, sig)`, `verify_schnorr_signature(key, msg, sig)`, `verify_ed25519_signature(key, msg, sig)` — each hash takes a single ByteArray; no key/salt/personalization parameter is documented. — [Aiken stdlib `aiken/crypto`](https://aiken-lang.github.io/stdlib/aiken/crypto.html)
- Existing Groth16 verifier library: Modulo-P `plutus-groth` (Plutus Groth16 validator library on the BLS builtins). — [Modulo-P/plutus-groth](https://github.com/Modulo-P/plutus-groth)
- Aiken exposes the raw BLS builtins (`bls12_381_g1_scalar_mul`, `bls12_381_miller_loop`, `bls12_381_final_verify`, etc.). — [Cardano Foundation blog on Aiken BLS12-381 primitives](https://cardanofoundation.org/blog/aiken-primitives-explained)
- Hydra 2.2.0 partial fanout is verified on-chain "with a BLS accumulator proof" — a production use of the BLS builtins on mainnet scripts. — [hydra releases](https://github.com/cardano-scaling/hydra/releases)
- Tx execution budget: 10,000,000,000 CPU steps per transaction (memory limit reported as 10,000,000 in one guide; other figures circulate). — [Cardano Course handbook](https://cardano-course.gitbook.io/cardano-course/handbook/protocol-parameters-and-configuration-files/protocol-parameters)

### Inferences
- SHA-256 hash lock: trivially supported (`sha2_256` since Alonzo); cost negligible.
- CKB Blake2b: CKB's hash is Blake2b-256 with personalization `ckb-default-hash` (per the assignment brief). Because the Cardano builtin is unpersonalized, a Cardano validator cannot natively recompute a CKB tx hash, CKB lock-arg (blake160 of pubkey) or CKB sighash. Options: (i) avoid needing it (use SHA-256 preimage as the only cross-chain link — the HTLC design), (ii) implement Blake2b compression in-script with the Plomin bitwise builtins (expensive; no library found), or (iii) prove CKB facts in a SNARK and verify on BLS12-381.
- CKB secp256k1 signature: a CKB-style recoverable signature (65 bytes) can be adapted off-chain to the CIP-49 format (drop the recovery byte, supply the 33-byte compressed pubkey). The validator can then check "this secp256k1 key signed this 32-byte digest", but the digest must be something the validator can bind to (e.g. `sha2_256` or unpersonalized `blake2b_256` of a message), not CKB's personalized sighash. So "same CKB key authorises a Cardano action" is feasible; "verify a CKB transaction's signature as CKB would" is not, natively.
- Groth16/BLS12-381: a 3-pairing (4 Miller loops + 1 final verify ≈ 2.0×10^9 CPU) plus public-input MSM fits in one tx, consistent with the CIP's ~23% estimate. PLONK verifiers (more scalar muls) are heavier but plausible. SP1/RISC Zero Groth16 wrappers are over BN254, which Cardano has **no** builtins for — an SP1 proof would need a BLS12-381 Groth16 wrap (e.g. via gnark with a BLS12-381 backend) to be verified on Cardano.

### Gaps
- No primary statement found that explicitly says "blake2b_256 builtin has no personalization" — the conclusion rests on the single-argument signature in Plutus/Aiken docs.
- Whether the van Rossem hard fork (PV11, `expModInteger`, builtins back-ported to V1/V2) is live on mainnet as of Nov 2026 was not verified.
- Low-s requirement of `verifyEcdsaSecp256k1Signature` not stated in CIP-49 (libsecp256k1 normally rejects high-s; unverified here).
- Current measured ex-units for a deployed Groth16/PLONK verifier (zkFold, Modulo-P, ak-381) not retrieved; the `plutus-groth` printed benchmark figures in search results looked inconsistent and were not relied on.
- Exact current `maxTxExecutionUnits` memory value (10M vs 14M vs 16.5M) not confirmed from an on-chain source.

---

## 5. Mithril (certificates, Cardano-transactions proofs, light clients, zk)

### Takeaway
Mithril today can give a succinct, stake-backed proof that a transaction hash is in the certified Cardano transaction set, but only ~100 blocks behind the tip with a new signing round every 30 blocks (tens of minutes latency) — too slow for the swap hot path, useful only for after-the-fact proofs/disputes. Verification means: Merkle path (BLAKE2s-256) to a signed root + STM multi-signature + walking the certificate chain to a genesis key; nobody was found verifying Mithril certificates inside SP1/RISC Zero or another chain's VM, and the Cardano IBC incubator actually removed its Mithril light client in favour of an experimental probabilistic one.

### Cited Findings
- What is certified (Cardano transactions): the full transaction set since genesis, at a fixed offset from the tip — **100 blocks on mainnet**; a new signature round starts **every 30 blocks** on mainnet. Structure: blocks grouped in ranges of 15 blocks, each range a Merkle tree over its tx hashes; a top-level Merkle tree over the range roots; root is the signed message; inner nodes use **BLAKE2s-256**. Proof = Merkle path served by an aggregator prover route; client checks the path and that the root is covered by a valid certificate. Signers keep only range roots once blocks are older than k = 2160 blocks. This type "will be superseded by the newer 'Cardano blocks and transactions' certification". — [Mithril docs: Cardano transactions certification](https://mithril.network/doc/mithril/advanced/mithril-certification/cardano-transactions)
- Stated limits: blocks near the tip can roll back; the 100-block offset "is a trade-off between finality and certification latency"; proofs only exist for transactions already signed. — [Mithril docs: Cardano transactions certification](https://mithril.network/doc/mithril/advanced/mithril-certification/cardano-transactions)
- Certificate chain: each certificate contains hash, metadata (protocol version, parameters k, m, phi_f, initiation/sealing times, signer list), message map, multi-signature over `H(MSG || AVK(n-1))`, beacon, previous hash. Chain is valid when every epoch back to the **genesis certificate** (signed by a published genesis key) has a valid certificate; its purpose is to certify the stake distribution and prevent eclipse attacks. Docs describe "recursive SNARK" and "non-recursive SNARK" aggregation flavours in which one recursive aggregate signature covers the whole chain. — [Mithril docs: certificates](https://mithril.network/doc/mithril/advanced/mithril-protocol/certificates)
- Mithril = stake-based threshold multi-signatures (STM) from IOG research; certificates let light clients in bridges and wallets verify without a full node. — [IOG: Mithril powering lightweight access](https://www.iog.io/news/mithril-powering-lightweight-access-to-the-cardano-blockchain)
- Client libraries: Rust `mithril-client` (get proof -> `proof.verify()` -> verify certificate chain), a WASM/TypeScript client usable in browsers, and a CLI. — [Mithril client library docs](https://mithril.network/doc/manual/develop/nodes/mithril-client-library); [Mithril client docs](https://mithril.network/doc/mithril/advanced/mithril-network/client/)
- 2026 releases: distribution 2617 (28 Apr 2026) — signer 1.0.0 declared production-ready on release-mainnet; distribution 2630 (3 Aug 2026) — removes `CardanoImmutableFilesFull`, moves **Cardano Blocks and Transactions certification to a testing phase** on pre-release-preview and release-preprod (no mainnet availability announced); DMQ node beta on release networks (4 Aug 2026); distribution 2642 (20 Oct 2026) — protocol configuration read from chain, cardano-node 11.1.3; client certificate-chain cache (unstable). — [Mithril dev blog](https://mithril.network/doc/dev-blog/)
- SNARK work: Aug 2025 — BLS verification alone took ~50 s with 2^19 constraints; IVC tested. Mar 2026 — new mainnet protocol parameters applied at epoch 619, "optimized for the Halo2 proof system used in upcoming SNARK-based certificate verification" (previous k = 2422 needed twice the constraints); Halo2 circuit implemented in the STM library; recursive Halo2 circuit report completed. Jun 2026 — recursive SNARK aggregation primitives and certificate-chain adaptation done. 19 Aug 2026 — still optimizing SNARK test suite and adding IVC off-circuit checks (in progress). — [cardano-scaling monthly Aug 2025](https://cardano-scaling.org/monthly/2025-08/); [Mithril update 25 Mar 2026](https://updates.cardano.intersectmbo.org/2026-03-25-mithril/); [Mithril update 17 Jun 2026](https://updates.cardano.intersectmbo.org/2026-06-17-mithril/); [Mithril update 19 Aug 2026](https://updates.cardano.intersectmbo.org/2026-08-19-mithril/)
- Proposed "header certificate" type that would tie a transaction to a verified block header; depends on Cardano adding a transaction Merkle root to block headers. — [mithril issue #2242](https://github.com/input-output-hk/mithril/issues/2242)
- Cardano IBC incubator (Cardano Foundation): "pre-production software", "neither complete nor sufficiently tested"; "The older `08-cardano-mithril` light client has been removed"; current `08-cardano-probabilistic` client accepts a Cardano state root after **>= 24 descendant blocks, >= 5 qualifying pools, >= 5.11% of stake**; Mithril is now used only to certify the stake distributions the client bootstraps from; Gateway builds txs with Lucid Evolution, reads Yaci Store, Hermes fork submits through Ogmios; no audit mentioned. — [cardano-ibc-incubator](https://github.com/cardano-foundation/cardano-ibc-incubator); open PR on letting Mithril-certified stake outrank supplied stake tables — [PR #917](https://github.com/cardano-foundation/cardano-ibc-incubator/pull/917)
- A Medium design piece ("Building a ZK Bridge for Cardano with Mithril") argues a Mithril-based ZK bridge is the most practical design — a proposal, not a deployed system (page returned 403; summary from search only). — [Medium](https://medium.com/@agustinenada/building-a-zk-bridge-for-cardano-with-mithril-architecture-tradeoffs-and-the-road-ahead-6ed9c35eec84)

### Inferences
- Latency from tx inclusion to a Mithril-certified proof on mainnet: ≥100 blocks (~33 min at ~20 s/block) plus up to 30 blocks (~10 min) to the next signing round plus signature aggregation — roughly 35–50 minutes. Not usable to release funds on CKB within a Lightning-style HTLC timeout unless timeouts are hours long.
- Security assumption: an honest stake quorum of registered Mithril signers (parameters k, m, phi_f) plus trust in the genesis verification key and in at least one honest aggregator for liveness; it is weaker/different from full Ouroboros consensus because only opted-in SPO stake signs.
- Verifying a Mithril certificate inside CKB-VM or an SP1 guest would require BLS12-381 pairings/aggregate-signature checks + BLAKE2s Merkle paths + certificate-chain walking; Mithril's own Halo2 recursive certificate (when shipped) would reduce this to one SNARK verification, but Halo2/BLS12-381-family verification in CKB-VM is itself non-trivial. This is research-grade, not reusable infrastructure today.
- For the HTLC swap design none of this is needed: the preimage revealed on Cardano is the proof.

### Gaps
- No source found of anyone verifying Mithril certificates inside SP1, RISC Zero, or another chain's VM (search returned none; absence of evidence).
- Certificate and transaction-proof byte sizes not documented on the pages read.
- Current mainnet values of k, m, phi_f, number of signers and signing stake share not retrieved (the dev blog points to the network configuration page).
- Whether "Cardano blocks and transactions" certification reached release-mainnet after distribution 2642 unverified; SNARK certificates not announced as released.
- Midnight / zkFold Mithril-based light-client work: nothing verifiable found in this session.

---

## 6. Bridges, intent networks, stablecoins and DEX liquidity already handling native ADA

### Takeaway
Native ADA is already reachable through NEAR Intents (announced 30 Sep 2025; ADA listed as "partially supported", custody mechanics for ADA not documented — likely the PoA bridge given the `cardano.omft.near` contract), Rosen Bridge (Ergo-centred guard set; CKB integration proposed Dec 2024 but never shown as delivered) and Wanchain (exploited 20 Jul 2026, paused). LayerZero was announced Feb 2026 and Circle's USDCx went live 27 Feb 2026, but Cardano on-chain liquidity is small: ~$51M DeFi TVL, ~$56M stablecoins, Minswap ~$13M TVL — so "CKB -> stablecoin -> ADA via a Cardano DEX" routes have thin depth.

### Cited Findings
**NEAR Intents**
- NEAR announced ADA support on 30 Sep 2025: ADA swaps across 20+ chains / 100+ assets; Hoskinson: "intents are the future of crypto". — [U.Today](https://u.today/charles-hoskinson-reacts-to-cardano-and-near-partnership); [Phemex news](https://phemex.com/news/article/near-protocol-integrates-cardano-for-crosschain-swaps-22976)
- A NEAR contract `cardano.omft.near` conducting ADA transactions was observed on 30 Jul 2025. — [TradingView/Coinpedia](https://tw.tradingview.com/news/coinpedia:2cb0ac2c6094b:0-cardano-s-charles-hoskinson-hails-future-of-crypto-as-near-intents-go-live)
- Official chain-support page: Cardano listed under Layer 1 chains as "**Partially supported**"; address types Shelley Base and Enterprise; ADA is the only Cardano asset; **Nervos/CKB is not listed**. — [NEAR Intents chain support](https://docs.near-intents.org/resources/chain-support)
- NEAR Intents publishes Cardano treasury and refill addresses "for transparency and AML compliance". — [NEAR Intents treasury addresses](https://docs.near-intents.org/near-intents/treasury-addresses)
- An independent review of a different route (Zcash) describes PoA-bridge legs as custodial and notes the Verifier contract lets a multisig freeze accounts. — [ETHBEAT review](https://ethbeat.org/privacy/projects/zcash-near-intents)

**Rosen Bridge**
- Operates on Ergo, Cardano, Bitcoin, Ethereum, BSC "and 1 other"; TVL ~$1.09M. — [DefiLlama Rosen Bridge](https://defillama.com/protocol/rosen-bridge); BSC integration live 23 Nov 2025 — [Ergo blog](https://ergoplatform.org/en/blog/Rosen-Bridge-Binance-Smart-Chain-Integration-Goes-Live/); Firo partnership Dec 2025 — [firo.org](https://firo.org/2025/12/05/rosen-bridge-partnership.html)
- CKB: Rosen proposed (17 Dec 2024) to the CKB Community Fund DAO to integrate Nervos CKB for $80,000 (6,001,500 CKB), target Q2 2025, with Nervos Nation as a guard; "Rosen Bridge does not require validation logic on the Nervos side as the validation fully resides on Ergo"; base bridge fee 0.5%. The thread shows no approval/vote result; on 24 Aug 2025 a community member said the integration "would be revisited with a different team" using the Rosen Expansion Kit and existing L1 scripts (xUDT, ACP, multisig) with a longer-term Fiber goal. No evidence CKB is live on Rosen. — [Nervos Talk thread](https://talk.nervos.org/t/dis-rosen-bridge-connecting-ckb-to-cardano-ergo-and-beyond/8539); [page 2](https://talk.nervos.org/t/dis-rosen-bridge-connecting-ckb-to-cardano-ergo-and-beyond/8539?page=2)

**Wanchain, LayerZero, others**
- Wanchain's Cardano bridge (2023) moves ADA and native tokens out and BTC/ETH/stablecoins in; it was exploited on 20 Jul 2026 (~515M NIGHT, ~$9–13M) and paused; reopening not confirmed. — [BeInCrypto](https://beincrypto.com/midnight-night-wanchain-bridge-exploit/); [Wanchain Medium (launch)](https://medium.com/wanchain-foundation/cardano-added-to-wanchains-cross-chain-infrastucture-usdc-and-usdt-come-to-cardano-a31fc8c8b8f9)
- LayerZero–Cardano integration announced at Consensus Hong Kong, Feb 2026 ("no longer an island", 80+ chains); implementation timeline "not immediately disclosed". — [crypto.news](https://crypto.news/cardano-taps-layerzero-ending-island-era-with-80-chain-bridge/)
- Cardano IBC is pre-production (see section 5). — [cardano-ibc-incubator](https://github.com/cardano-foundation/cardano-ibc-incubator)
- BitVMX: IOG reported Bitcoin Ordinals bridged to Cardano with the BitVMX protocol (date/network not checked). — [IOHK newsroom](https://iohk.io/en/newsroom/bitcoin-ordinals-bridged-to-cardano-for-the-first-time-with-bitvmx-protocol)

**Stablecoins and DEX liquidity**
- USDCx (Circle xReserve-backed, native Cardano token 1:1 with USDC) went live 27 Feb 2026 on Minswap, SundaeSwap, Liqwid. — [Cardano Forum](https://forum.cardano.org/t/usdcx-on-cardano-is-live-a-new-chapter-for-stablecoin-utility/153375); first-week pools: $6.67M NIGHT/USDCx and $5.38M USDCx/USDM on Minswap — [IOG](https://www.iog.io/news/usdcx-on-cardano-here-s-what-happened-in-the-first-seven-days)
- Native stablecoins listed by cardano.org: USDCx, USDM, USDA, DJED, iUSD; USDT only as bridged. — [cardano.org/stablecoins](https://cardano.org/stablecoins/)
- DefiLlama API snapshot 12 Nov 2026: Cardano DeFi TVL **$50.8M**; Minswap DEX $12.9M; Liqwid $8.8M; Dano Finance $5.0M; Djed $4.3M. Stablecoins on Cardano: USDC(x) $36.9M, USDM $11.6M, USDrf $5.6M, USDA $3.9M, iUSD $1.3M, DJED $1.3M, USDT $0.1M (total ~$56M as of 5 Nov 2026 per the DefiLlama page). — [DefiLlama Cardano stablecoins](https://defillama.com/stablecoins/cardano); [DefiLlama chains API](https://api.llama.fi/v2/chains); [DefiLlama protocols API](https://api.llama.fi/protocols)

### Inferences
- NEAR Intents is the only live intent network with ADA, but CKB is not on it, so it cannot be the CKB leg; and for ADA its custody appears to be bridge-treasury based rather than an HTLC — not a non-custodial primitive to reuse, though it sets the UX/fee benchmark.
- Rosen is the only bridge with a documented (stalled) CKB plan; its model (guards on Ergo, 0.5% base fee, ~$1M TVL) is federated, not trust-minimised, and has no CKB support today.
- With Minswap TVL ~$13M and total stablecoins ~$56M, any route that sources ADA via a Cardano DEX swap of a bridged stablecoin will suffer slippage beyond small sizes; an LP holding ADA inventory directly (HTLC model) avoids this.

### Gaps
- Exact custody path for ADA in NEAR Intents (PoA bridge vs. Chain Signatures MPC), confirmation count, and what "partially supported" excludes are not documented in the pages read.
- LayerZero endpoint actually live on Cardano mainnet? Unverified. Wormhole on Cardano: no evidence found. ChainPort, Cardinal (BTC), BitcoinOS: current status not verified this session.
- ADA/stable pool depth per pair (e.g. ADA/USDCx, ADA/USDM on Minswap) not retrieved — only protocol-level TVL.
- Wanchain bridge reopening status after Aug 2026 unknown.

---

## 7. Cardano transaction economics, block time, finality, Peras

### Takeaway
A simple ADA payment costs ~0.16–0.17 ADA and needs ~1 ADA minimum per output; a small Plutus spend adds only cents. Blocks arrive on average roughly every 20 s but finality is probabilistic (full immutability at k = 2160 blocks, ~12 h); practical swap designs wait a handful to a few dozen blocks. Ouroboros Peras (fast finality) is not live — targeted for 2027.

### Cited Findings
- Minimum fee = 44 lovelace × tx size (bytes) + 155,381 lovelace; simple 200–300 byte ADA transfer ≈ 0.16–0.17 ADA. — [cardano.org fees page](https://cardano.org/fees-and-transactions/)
- Min-UTxO: (160 + output bytes) × 4,310 lovelace; 67-byte ADA-only output -> 978,370 lovelace (~0.98 ADA). — [cardano.org fees page](https://cardano.org/fees-and-transactions/)
- Script execution prices: priceMemory 0.0577, priceSteps 0.0000721 lovelace per unit; CPU budget 10,000,000,000 steps per tx; reference-script fee parameter `minFeeRefScriptCostPerByte` = 15. — [Cardano Course handbook](https://cardano-course.gitbook.io/cardano-course/handbook/protocol-parameters-and-configuration-files/protocol-parameters); [parameter guide](https://docs.cardano.org/about-cardano/explore-more/parameter-guide)
- Mainnet security parameter k = 2160 blocks (blocks older than that are final). — [Mithril docs](https://mithril.network/doc/mithril/advanced/mithril-certification/cardano-transactions)
- Light-client style thresholds in use: Cardano IBC probabilistic client requires 24 descendant blocks (+ pool/stake diversity); Mithril uses a 100-block offset. — [cardano-ibc-incubator](https://github.com/cardano-foundation/cardano-ibc-incubator); [Mithril docs](https://mithril.network/doc/mithril/advanced/mithril-certification/cardano-transactions)
- Peras: adds SPO-committee voting on recent chain tips to speed settlement; Leios FAQ describes ~2-minute high-confidence settlement with Peras. — [IOG Peras post](https://www.iog.io/news/ouroboros-peras-the-next-step-in-the-journey-of-cardano-s-protocol-1); [Leios FAQ](https://leios.cardano-scaling.org/docs/faq/)
- Dijkstra hard-fork roadmap: code completion targeted Q4 2026 (Leios), **Peras activation targeted Q2 2027**, subject to on-chain governance. — [FinanceFeeds](https://financefeeds.com/cardano-plans-two-phase-dijkstra-upgrade-with-leios-and-peras/); [unlock-bc](https://www.unlock-bc.com/en/cardano-dijkstra-hard-fork-sets-20262027-roadmap)
- Hydra's default contestation period is 12 h since v1.3.0 — an indicator of how conservative L2 designs are about L1 settlement. — [hydra releases](https://github.com/cardano-scaling/hydra/releases)

### Inferences
- Average block interval ≈ 20 s (1 s slots, ~5% active-slot coefficient — standard parameter, not re-sourced here), so 24 blocks ≈ 8 min, 100 blocks ≈ 33 min, 2160 blocks ≈ 12 h.
- For an HTLC swap the ADA leg's safety does not hinge on LP-side finality of the *claim* (once the preimage is public the LP can settle Fiber immediately); it hinges on the user being confident the LP's *lock* UTxO will not be rolled back before claiming — a few minutes of confirmations for small amounts. Total UX ≈ 1–10 minutes on the Cardano side today; Peras would cut the confident-settlement wait to ~2 minutes if/when deployed (2027 at the earliest).
- All-in Cardano cost for an HTLC swap ≈ 0.4–0.5 ADA in fees (see section 3), versus ~0.17 ADA for a custodial-style direct payment.

### Gaps
- No primary source retrieved for exchange/bridge confirmation policies for ADA deposits.
- `maxTxExecutionUnits` memory, `maxTxSize` (16,384 bytes commonly cited) and tiered reference-script pricing details not re-verified against current mainnet parameters.
- Whether Leios/Dijkstra changes affect HTLC timing assumptions is unassessed.

---

## 8. Developer practicalities (testnets, faucets, SDKs, reference scripts)

### Takeaway
Preview and Preprod testnets with a public faucet exist and are supported by Hydra and Mithril releases; Node.js-usable tooling is mature (Lucid Evolution, Mesh, Blockfrost/Koios/Ogmios/Kupo, Dolos/UTxO-RPC), and Konduit ships reusable Rust/WASM + TypeScript code for SHA-256 cheque/HTLC handling.

### Cited Findings
- Faucet for Cardano testnets (preview and pre-production named); funds arrive within minutes; API key grants extra allocation; users asked to return unused tADA. — [docs.cardano.org faucet](https://docs.cardano.org/cardano-testnets/tools/faucet)
- Hydra publishes script hashes for preview, preprod and mainnet on each release. — [hydra releases](https://github.com/cardano-scaling/hydra/releases)
- Mithril runs pre-release-preview, release-preprod and release-mainnet networks. — [Mithril dev blog](https://mithril.network/doc/dev-blog/)
- Real-world off-chain stacks: Cardano IBC gateway builds unsigned txs with **Lucid Evolution**, reads **Yaci Store**, submits via **Ogmios**, signs with **Pallas** (Rust). — [cardano-ibc-incubator](https://github.com/cardano-foundation/cardano-ibc-incubator)
- Konduit: Rust workspace with WASM bindings ("JS/Wasm Bindings: Export KCOR logic for use in web-based Consumer App"), Blockfrost connector implemented, Ogmios/Kupo support listed as a side-quest, Dolos/UTxO-RPC adaptor backend ADR; TS SDK in `konduit-js`; Rust & WASM API docs hosted. — [konduit roadmap](https://github.com/cardano-lightning/konduit/blob/main/docs/roadmap.md); [konduit repo](https://github.com/cardano-lightning/konduit); [konduit-js](https://github.com/cardano-lightning/konduit-js)
- Aiken is used only for on-chain validators; off-chain code is written in another language. — [docs.cardano.org Aiken](https://docs.cardano.org/developer-resources/smart-contracts/aiken)
- HTLC template with Aiken on-chain + Java (Cardano Client Lib) off-chain against a local Yaci DevKit node. — [cardano-foundation templates /htlc](https://github.com/cardano-foundation/cardano-template-and-ecosystem-monitoring/tree/main/htlc)
- Reference-script usage is priced per byte (`minFeeRefScriptCostPerByte` = 15). — [Cardano Course handbook](https://cardano-course.gitbook.io/cardano-course/handbook/protocol-parameters-and-configuration-files/protocol-parameters)

### Inferences
- A minimal Cardano leg for a spike: Aiken PlutusV3 HTLC validator (`sha2_256(preimage) == hash`, validity-interval timeout, receiver/sender signatures), deployed as a reference script on Preprod; off-chain in Node.js with Lucid Evolution or Mesh over Blockfrost (or Ogmios+Kupo); watch for the claim tx and extract the preimage from the redeemer to settle the Fiber HTLC.
- Yaci DevKit gives a local devnet for CI without faucet dependence.

### Gaps
- Faucet per-request amount and rate limit not stated on the page read.
- Mesh SDK, cardano-js-sdk, Koios and Blockfrost documentation were not fetched this session (well-known; URLs: https://meshjs.dev, https://github.com/Anastasia-Labs/lucid-evolution, https://blockfrost.io, https://koios.rest — unverified here).

---

## 9. History: Nervos <-> Cardano Force Bridge (2021), UTXO Alliance, and 2024–2026 collaboration

### Takeaway
The 2021 IOHK–Nervos Force Bridge to Cardano never shipped: it was paused in Sept 2021, restarted with Obsidian Systems, reported "about 80% complete" in June 2022 and "paused" in Sept 2022, with no later launch. The UTXO Alliance (Oct 2021) produced no CKB–Cardano infrastructure; the only 2024–2026 CKB–Cardano item found is Rosen Bridge's unfunded/unfinished CKB integration proposal.

### Cited Findings
- 2 Jun 2021: IOHK and Nervos announced a cross-chain bridge between Cardano and Nervos, to be built by Mousebelt with Nervos funding. — [IOG blog](https://www.iog.io/news/nervos-partnership-to-build-the-first-cross-chain-bridge-with-cardano); [CoinDesk](https://coindesk-coindesk-prod.cdn.arcpublishing.com/markets/2021/06/02/cardano-to-launch-its-first-cross-chain-bridge-with-link-to-nervos/)
- Nervos Talk "Update on Nervos<>Cardano bridge project" (matt_ckb, 27 Sep 2021): Cardano bridge work paused pending Force Bridge core changes; six-week estimate admitted as a mistake; Obsidian Systems brought in (Cardano multisig TS library, monitoring, operator signing). 3 Dec 2021: PR #235 under review. 9 Jun 2022: about 80% complete but "production has stopped temporarily". 13 Sep 2022: "this work is paused"; seeking bridge-operating partners. No later reply reports a launch. — [Nervos Talk](https://talk.nervos.org/t/update-on-nervos-cardano-bridge-project/6181)
- Force Bridge mainnet (Oct 2021) connected Ethereum only, with Cardano "in the future". — [Crowdfund Insider](https://www.crowdfundinsider.com/2021/10/181718-nervos-introduces-cross-chain-force-bridge-on-mainnet/)
- UTXO Alliance announced at Cardano Summit 2021 by IOHK with Ergo, Nervos and Topl. — [IOHK blog, 15 Oct 2021](https://iohk.io/en/blog/posts/2021/10/15/utxo-alliance-fostering-innovation-and-collaboration-across-the-blockchain-space/)
- RGB++ Layer (Q3 2024) is described as targeting "other UTXO-based blockchains like Cardano" for bridge-free "Leap" — positioning statement only. — [Blockworks, State of Nervos Q3 2024](https://app.blockworks.com/report/state-of-nervos-network-q3-2024)
- Rosen Bridge CKB proposal (Dec 2024) and Aug 2025 "revisit with a different team" note — see section 6. — [Nervos Talk](https://talk.nervos.org/t/dis-rosen-bridge-connecting-ckb-to-cardano-ergo-and-beyond/8539?page=2)

### Inferences
- There is no existing CKB<->Cardano bridge, light client, or liquidity route as of Nov 2026; a Fiber-HTLC <-> Cardano-HTLC swap would be first-of-its-kind and cannot lean on prior joint infrastructure.
- The Force Bridge history shows the Cardano side (multisig custody, native-token minting, monitoring) was the underestimated part in 2021–22; an HTLC design avoids all three.

### Gaps
- No 2025–2026 UTXO Alliance activity found (searches returned only 2021–2024 material).
- No evidence of any RGB++/UTXO Stack deployment on Cardano.
- The Aug 2025 thread reference to a "Force Bridge hack" as a reason for caution was not independently verified.

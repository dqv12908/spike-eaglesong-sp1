# Swap cryptography and mechanism design beyond HTLCs (CKB <-> Ethereum / Cardano / Solana), state as of November 2026

Conventions used below. "Cited Findings" are things read in a source this session. "Inferences" are my own reasoning or prior knowledge that I did not re-verify this session; they are marked as such and should not be presented as sourced fact. Baseline for all footprint comparisons: a classic two-contract HTLC swap is 4 on-chain transactions in the happy path (lock A, lock B, claim B, claim A), two of which are contract calls on the foreign chain, and both parties' capital is locked from their lock until claim (or until timeout on failure).

## 1. Proof-of-payment ("SPV swap" / light-client-verified) swaps

### Takeaway
Proof-of-payment swaps cut the happy path to 3 transactions (escrow on A, plain transfer on B, claim on A with a proof) and remove per-swap LP lock-up, but they need a light client of chain B verifiable on chain A. As of Nov 2026 this is deployed for Bitcoin (Atomiq; RGB++'s Bitcoin SPV cells on CKB) and Ethereum (SP1 Helios, used by Across), is at testnet/pre-production for Cardano (Mithril-based IBC client), and I found no deployed Solana light client; CKB can verify a Groth16 proof for about 100M cycles (about 2.9% of a block), so the verifier side on CKB is not the bottleneck.

### Cited Findings
Atomiq (Bitcoin light client on Solana / Starknet)
- A light client deployed on Solana and Starknet tracks Bitcoin block headers and validates proof-of-work; escrow vaults on the destination chain are released only on proof of a confirmed Bitcoin transaction (Atomiq calls the primitive a "proof-time-locked contract", PrTLC). Quotes come from a permissionless LP network by RFQ; relayers double as watchtowers that submit the claim for offline users. — [DappRadar listing](https://dappradar.com/dapp/atomiq-exchange), [Starknet blog: What is Atomiq](https://www.starknet.io/blog/atomiq-wbtc-on-starknet/)
- The older description of the Solana program: the claimer proves "with merkle proof and Bitcoin Relay program" that the Bitcoin transaction was sent and confirmed. — [SolLightning readme mirror](https://google.18789066745.workers.dev/adambor/SolLightning-readme)
- Newer "SPV vault" swaps: BTC -> smart-chain swaps that need no initiation transaction on the destination chain; vault address must be P2TR and LP address P2WPKH; a watchtower fee option exists (setting it to zero makes automatic settlement unlikely; default estimate uses a 1.25x safety multiplier on the network fee). — [@atomiqlabs/sdk SpvFromBTCWrapper.ts](https://app.unpkg.com/@atomiqlabs/sdk@8.9.5/files/src/swaps/spv_swaps/SpvFromBTCWrapper.ts)
- Starknet's description: Atomiq uses "UTXO-controlled vaults" plus the on-chain Bitcoin light client "without per-swap liquidity lock-ups"; BTC -> Starknet settles in about 20 minutes (two Bitcoin confirmations). — [Starknet blog: native BTC to strkBTC](https://www.starknet.io/blog/native-btc-to-strkbtc-powered-by-atomiq-and-garden/) (page was behind a bot check when fetched; facts are from the search snippet only)
- The SDK says Solana still uses an older swap protocol for on-chain BTC -> Solana than Starknet/EVM chains; one listing describes Bitcoin-to-Solana routes as supported "at its peak operation", so current Solana status is unclear. — [@atomiqlabs/sdk README](https://unpkg.com/@atomiqlabs/sdk@8.9.5/README.md), [Solana Compass](https://solanacompass.com/projects/atomiq-exchange)

Garden (comparison point: not a proof-of-payment design)
- Garden is HTLC-based: initiate / redeem / refund / instant refund, SHA-256 hashlock, relative timelocks; "Any chain that supports SHA256 hashing and Relative Timelocks can be added". No light-client or proof component is described. — [Garden contracts overview](https://docs.garden.finance/docs/contracts/overview.md)

Across + SP1 Helios (Ethereum light client as a zk proof)
- Across V4 replaces per-chain adapters with a universal system: `SP1Helios` is a ZK light-client contract that verifies SP1 proofs of the Helios light client and stores proven beacon headers, execution state roots and sync committees; `UniversalSpokePool` executes messages verified against it. — [Across docs](https://docs.across.to/concepts), [SP1 Helios book](https://succinctlabs.github.io/sp1-helios/print.html)
- Trust notes from the audit: liveness assumes at least one honest updater; there are privileged VKEY and state-updater roles in SP1Helios. — [OpenZeppelin SP1 Helios audit](https://www.openzeppelin.com/news/sp1-helios-audit), [OpenZeppelin EVM universal adapter audit](https://www.openzeppelin.com/news/evm-universal-adapter-audit)
- Proving cost: optimized BLS12-381 precompiles cut verification of the 512 sync-committee signatures inside SP1 from about 6 billion cycles to about 50 million. — [Succinct blog](https://blog.succinct.xyz/succinctshipsprecompiles/)
- On-chain verification cost for comparable systems (not SP1 Helios specifically): Polyhedra zkBridge full-consensus proof about 220k gas on EVM — [The Block](https://www.theblock.co/post/241003/proving-full-node-of-ethereum-in-zk); storage-proof verifiers about 200k gas, and verifying the sync-committee signature directly in Solidity about 2M gas — [Wonderland: state of storage proofs](https://mirror.xyz/mirror.wonderland.xyz/3lPgWRmr8_ui_JS_W88i6JzTFf0VGqv_YJl05b1sNxI) (attribution of the 2M figure to this page is from a search summary; verify). An older Halo2 design (Spectre) reported about 324k gas per step and about 350k per committee rotation — [Celestia forum](https://forum.celestia.org/t/celestia-zk-accounts-proving-ethereum-state/1944) (attribution from search summary; verify).

Solana as the proven chain
- SIMD-0052 proposes adding a receipt root / block Merkle to the bankhash and an RPC method for transaction inclusion proofs for light clients; the search found no 2026 acceptance or activation. — [Solana forum: SIMD-0052](https://forum.solana.com/t/simd-0052-add-transaction-proof-and-block-merkle-for-light-clients/297)
- A Solana forum thread states Tinydancer's development has stopped (undated in results). — [State of tinydancer](https://forum.solana.com/t/state-of-tinydancer-light-clients-on-solana/4762)
- Alpenglow replaces TowerBFT votes with BLS-aggregated certificates: one 192-byte aggregate signature plus a validator bitmap per certificate; blocks get a footer with consensus information. — [Helius: Alpenglow](https://www.helius.dev/blog/alpenglow)
- Prerequisites activated on mainnet: BLS pubkey management in the vote account (SIMD-0387) on 8 July 2026 and the Validator Admission Ticket (SIMD-0357) on 22 July 2026. — [solana.com upgrades](https://solana.com/upgrades/bls-pubkey-vat)
- Anza announced on 13 Oct 2026 that the consensus switch was scheduled for 21 Oct 2026 about 14:50 UTC (Agave 4.3); finality target about 150 ms versus about 12.8 s; Rotor is a later, unscheduled phase. I could not confirm from a primary source that activation happened as scheduled. — [Solana Compass news](https://solanacompass.com/news/anza-sets-alpenglow-mainnet-date-solanas-consensus-switch-is-scheduled-for-october-21-at-about-1450-utc), [Alchemy explainer](https://alchemy.com/blog/solana-alpenglow)

Cardano as the proven chain
- Mithril (stake-based threshold multisignature certificates) is on mainnet; in 2026 the team adapted the certificate chain for a SNARK aggregate verification key, updated mainnet protocol parameters to support SNARK verification (March 2026) and completed SNARK proof verification for recursive SNARK aggregation (June 2026). — [Mithril update 2026-03-18](https://updates.cardano.intersectmbo.org/2026-03-18-mithril), [Mithril update 2026-06-17](https://updates.cardano.intersectmbo.org/2026-06-17-mithril)
- IOG states certificate size is a limiting factor "for on-chain storage and/or verification of the Mithril certificates (on Cardano or any other blockchain)" and that recursive/folding SNARKs are being explored to compress the chain. — [IOG: Mithril](https://www.iog.io/news/mithril-powering-lightweight-access-to-the-cardano-blockchain)
- The Cardano IBC incubator consolidated Cosmos-side verification of Cardano onto Mithril (legacy light client removed, Q1 2026); "height" is the Mithril snapshot block number. — [Cardano quarterly dev report Jan 2026](https://developers.cardano.org/blog/2026-01-31-quarterly-development-report/), [cardano-ibc-incubator](https://github.com/cardano-foundation/cardano-ibc-incubator)
- Cardano <-> Injective IBC ran on testnet by mid-2026; the incubator classifies public-network integrations as pre-production. — [Cardano forum](https://forum.cardano.org/t/cardano-and-injective-are-becoming-interoperable-what-does-it-really-mean/156092)

CKB as the verifying chain
- Groth16/BN254 verification on CKB-VM costs about 102M cycles for one public input (about 2.9% of the 3.5 billion block cycle limit), about 121M at 64 inputs (about 270-300k cycles per extra input); proofs are 128 bytes; a "zk-lock" lock script build is about 96-101M cycles and about 94 KB. Measured in `ckb-testtool`, self-reported, unaudited. — [Nervos Talk: Research Notes: ZK on CKB (June-Oct 2026)](https://talk.nervos.org/t/research-notes-what-zero-knowledge-proofs-enable-on-ckb/10368), [Nervos Talk: groth16-ckb](https://talk.nervos.org/t/groth16-ckb-an-on-chain-groth16-verifier-for-ckb-vm/10288)
- An optimized SP1 PLONK verifier port for CKB-VM runs in about 63M cycles with a 246 KB binary (down from about 6000M unoptimized). — [Nervos Talk: Optimized SP1 Verifier for ckb-vm](https://talk.nervos.org/t/optimized-sp1-verifier-for-ckb-vm/10144)
- sec-bit's 2020 `ckb-zkp` toolkit already shipped a Groth16 verifier on CKB-VM with BN256 and BLS12-381 curve support. — [sec-bit/ckb-zkp](https://www.github.com/sec-bit/ckb-zkp)
- A Bitcoin SPV light client already runs on CKB for RGB++: an SPV info cell plus at least three SPV client cells store the Bitcoin tip and a header MMR root; other scripts read them to confirm Bitcoin transactions exist (`verify_transaction` takes an MMR proof, a tx output proof, tx index and height). — [RGB++ SPV service docs](https://rgbpp.netlify.app/docs/spv-service), [rgbpp-sdk](https://github.com/ckb-cell/rgbpp-sdk)

### Inferences
- Footprint of a proof-of-payment swap where the user sells CKB (my estimate): CKB = escrow-create tx + claim tx carrying one proof (about 100M cycles if Groth16, or only Merkle/MPT hashing if a light-client cell already holds a proven root); foreign chain = one plain transfer (Ethereum 21k gas ETH transfer; Solana one signature fee; Cardano one simple payment). Light-client updates are amortized over all swaps.
- CKB-specific structural advantage: a light-client cell can be read as a `cell_dep` by any number of claim transactions in the same block without contention or per-read fees. RGB++ already uses this pattern for Bitcoin; I found nobody applying it to proof-of-payment swaps, so an "Atomiq on CKB" for BTC could reuse the deployed SPV cells, and the same pattern would work for an Ethereum (Helios-style) light-client cell.
- Capital: the maker locks nothing in advance. Capital is outstanding from the plain payment until the proof is accepted, i.e. chain-B finality plus proving time (Ethereum: sync-committee finalized header, roughly 13+ minutes; Bitcoin: Atomiq's two confirmations, about 20 min; Solana after Alpenglow: sub-second finality if a certificate light client existed).
- Option structure: the user locks first and holds no option; the maker has an option only for the fill window (to pay or not). Payment must be bound to the order (memo/calldata/unique amount) to prevent one payment claiming two escrows.
- For the reverse direction (user sells ETH/ADA/SOL for CKB), the foreign chain must verify CKB (Eaglesong PoW headers plus a transaction inclusion proof). For a PoW chain the escrow size per swap must stay below the cost of mining a fake k-block fork, the same bound Atomiq inherits from Bitcoin; CKB's hashrate makes that bound much lower than Bitcoin's.
- Ranking of foreign chains by ease of verification inside CKB-VM today: Bitcoin (deployed) > Ethereum (sync-committee zk proof exists off the shelf; only a CKB verifier and cell layout needed; trust = 2/3 of a 512-member sync committee with no slashing for light-client attacks) > Cardano (Mithril STM or its coming SNARK form; trust = Mithril signer stake quorum, which is not the whole stake) > Solana (no deployed light client or inclusion-proof path found).

### Gaps
- No source found for a deployed Solana light client (zk or native) verifying Alpenglow certificates, nor for how a transaction/receipt is proven against an Alpenglow block (SIMD-0052/0064 status unknown). Solana remains the hard leg for proof-of-payment.
- No published gas figure for SP1 Helios verification itself, and no CKB-VM cycle figure for native BLS12-381 pairing/sync-committee verification.
- Not verified this session: tBTC/Threshold SPV details, Polymer, Union, "t1", Espresso, and whether Mithril's "Cardano transactions" certificate type gives per-transaction inclusion proofs and at what lag. I found no Cardano light client in a zkVM (SP1/RISC Zero).
- Atomiq's own docs (confirmation depth per route, LP bonding, exact claim cost in compute units) were not retrievable.

## 2. Adaptor-signature / scriptless-script swaps, PTLCs and cross-curve (secp256k1 <-> Ed25519)

### Takeaway
Adaptor-signature swaps need only signature verification plus (on at least one side) a timelock, and 2026 work removes the timelock requirement from one side entirely; they keep 4 transactions but make the foreign-chain legs ordinary transfers with no shared hash. PTLCs are not implemented in Lightning or in Fiber (Fiber lists them as planned; a PoC was under study in May 2025), and I found no Solana- or Cardano-specific Ed25519 adaptor-swap deployment; the closest production precedent is the Bitcoin-Monero swap and the closest Cardano work is IOG's CANS prototype (July 2026).

### Cited Findings
- Bitcoin-Monero swap (COMIT): adaptor signatures on Bitcoin only; Monero needs no script support. Conventional DLEQ proofs only work on one curve, so a cross-group proof is used to show the secp256k1 and ed25519 points share one secret; without it the adaptor signatures would not be guaranteed to commit to the expected secrets. — [Hoenisch, Soriano del Pino, "Atomic Swaps between Bitcoin and Monero", arXiv 2101.12332 (2021)](https://arxiv.org/abs/2101.12332), [COMIT blog](https://medium.com/comit-network/monero-bitcoin-atomic-swap-1cab015d7af9)
- A maintained Rust implementation of the cross-curve proof exists: `sigma_fun`'s ed25519 module exists "to demonstrate that you can prove a secp256k1 and ed25519 public key have the same secret key for use in cross-chain atomic swaps"; `ecdsa_fun` provides ECDSA adaptor signatures using a DLEQ on secp256k1. — [sigma_fun docs](https://docs.rs/sigma_fun/latest/sigma_fun/ed25519/index.html), [ecdsa_fun adaptor source](https://docs.rs/crate/ecdsa_fun/latest/source/src/adaptor/mod.rs)
- Universal Atomic Swaps (Thyagarajan, Malavolta, Moreno-Sanchez, IEEE S&P 2022): generic protocol needing no custom scripting, only signature verification; for Schnorr/ECDSA chains a practical instantiation uses adaptor signatures plus time-lock puzzles, with a prototype under one second per swap on commodity machines. — [aminer record](https://www.aminer.org/pub/627e29925aee126c0f8678b9/universal-atomic-swaps-secure-exchange-of-coins-across-all-blockchains)
- Practicality caveat from the authors' institution: the fully universal protocol "currently can't" run on a laptop or phone; the Bitcoin/Ethereum-specific version can run on low-end devices. — [EurekAlert release](https://www.eurekalert.org/news-releases/953638)
- Verifiable Timed Signatures (Thyagarajan, Bhat, Malavolta, Döttling, Kate, Schröder, CCS 2020) give constructions for BLS, Schnorr and ECDSA. — [ePrint 2020/1563](https://eprint.iacr.org/2020/1563)
- "Atomic Swaps with Relaxed Assumptions" (Rösler, Schambach, Thomas, IACR CiC 2026): generic n-to-m adaptor-signature swap needing only standard signatures and a joint public key; only one side needs timed transactions; both parties lock into two-party-signature addresses and hold pre-signed refunds; UC-secure. — [ePrint 2026/746](https://eprint.iacr.org/2026/746)
- "A General Approach to Adaptor Signatures" (Döttling, Thyagarajan, Soni, Taylor, Waldner, Zanotto, Sept 2026): adaptor signatures for arbitrary NP relations (not only discrete logs), compatible with Schnorr, ECDSA, CL, BBS, BLS, RSA; adapted signatures must look like ordinary signatures. — [ePrint 2026/1889](https://eprint.iacr.org/2026/1889)
- Multi-party variant: a protocol with a "universal adaptor secret" claims any number of participants and chains, no smart contracts, "Schnorr-like signature verification", nearly all off-chain. — [You, Joshi, Kuehlkamp, Nabrzyski, arXiv 2406.16822 (2024)](https://arxiv.org/abs/2406.16822)
- IOG's CANS (Cyclic Atomic N-party Swap, 7 July 2026): ring of participants, conditional signatures completed when a leader reveals the last secret piece, no shared hash across legs, spends look like ordinary transfers; every participant holds a signed, height-timelocked refund before any lock is broadcast; refund windows are staggered. The reference implementation deploys a Plutus validator that verifies Bitcoin secp256k1 Schnorr signatures, so a Bitcoin-side signature unlocks Cardano UTXOs. Rust prototype, tested with up to 20 parties on private Bitcoin and Cardano networks; no mainnet claim; no paper linked. — [IOG: Introducing the CANS protocol](https://www.iog.io/news/introducing-the-cans-protocol), [repo](https://github.com/input-output-hk/cyclic-atomic-swap)
- PTLCs in Lightning: LND shipped production simple taproot channels in v0.21 (June 2026), still exclusively HTLC; Optech describes PTLCs as a possible later upgrade. — [LND v0.21 announcement](https://lightning.engineering/posts/2026-06-11-lnd-0.21-launch/), [Optech: simple taproot channels](https://bitcoinops.org/en/topics/simple-taproot-channels/)
- PTLCs in Fiber: README says "hash-based HTLC payment contracts today, with PTLC planned as a future direction" and lists "Programmable conditional payment" as a roadmap item; a May 2025 dev log reported looking into PTLC with a PoC; the July 2026 dev log and January 2026 outlook do not mention PTLC. — [nervosnetwork/fiber README](https://github.com/nervosnetwork/fiber), [Fiber dev log 2025-05-29](https://fiber-docs-eight.vercel.app/blog/d/d1961665b8aa2906), [Fiber dev log 2026-07-23](https://github.com/nervosnetwork/fiber/discussions/1574)
- ckb-auth lists Bitcoin, Ethereum, EOS, Tron, Dogecoin, Litecoin, Cardano, Monero, Solana and Ripple signature verification for CKB scripts. — [nervosnetwork/ckb-auth](https://github.com/nervosnetwork/ckb-auth)

### Inferences
- (Prior knowledge, not re-fetched) The scriptless-chain construction originates in Joël Gugger, "Bitcoin-Monero Cross-chain Atomic Swap", ePrint 2020/1126 (https://eprint.iacr.org/2020/1126): the scripted chain locks first and needs a 2-of-2 plus two timelocks (refund, then punish); the unscripted chain's coins sit at a key whose secret is the sum of two shares; claiming on the scripted chain leaks one share via an adaptor signature, giving the counterparty the full key. Happy path is 4 transactions, two per chain, and the two on the unscripted chain are plain transfers. The refunding party must be online in the refund window or is punished.
- Ed25519 compatibility: a completed Schnorr-style adaptor signature on Ed25519 is an ordinary (R, s) pair satisfying the standard verification equation; only nonce generation differs from RFC 8032, which verifiers cannot see. So Solana's transaction signature check and Cardano's key witnesses should accept them. Required off-chain: a two-party Ed25519 key (key-share addition or a MuSig/FROST-style protocol), since Solana has no native 2-of-2 at the system-account level; Cardano does have native multisig-plus-timelock scripts. I found no audited implementation for Solana or Cardano; treat as unproven engineering.
- CKB can skip the cross-curve DLEQ. Because CKB-VM runs arbitrary code, a CKB lock can check a revealed scalar directly on the foreign curve ("reveal s such that s*B = S on Ed25519") instead of an HTLC preimage or a secp256k1 adaptor signature. Combined with the Gugger layout this gives: CKB = lock tx + claim tx (claim reveals the maker's key share, one Ed25519 scalar multiplication in-script); Solana or Cardano = two plain transfers (fund the joint-key address, sweep it), no program, no datum, no hash on the foreign chain. This is the same trick CANS uses in the other direction (Plutus verifying secp256k1 Schnorr) and (prior knowledge, not re-fetched) what the ETH-XMR swap by AthanorLabs does with an `ecrecover` workaround plus DLEQ because the EVM has no Ed25519. I found no CKB project doing this.
- Constraint of that layout: the scripted chain (CKB) must lock first. When the user sells CKB, the user locks first and the maker holds the option; when the user buys CKB, the maker's CKB is locked first and the user holds the option. Solana lacks an L1 timelock for plain accounts, so the Solana side cannot be the timed side without a program; Cardano could be, using native scripts.
- Ethereum is secp256k1 like CKB, so no cross-curve issue arises; but an EOA-only (scriptless) Ethereum leg needs two-party ECDSA, which is heavier than simply using a contract. For Ethereum, a contract HTLC/PTLC or the proof-of-payment route is more practical than scriptless.
- Universal swaps via verifiable timed signatures replace on-chain timelocks with sequential-squaring puzzles; they add CPU cost and a soft (hardware-dependent) time bound, so they are only worth it for a chain with no timelock at all. All four chains here have a timelock on at least one side, so the Rösler et al. one-sided-timelock design is the relevant 2026 result.

### Gaps
- No Solana- or Cardano-specific Ed25519 adaptor-signature swap implementation, audit or paper found. Farcaster/eigenwallet support for other Ed25519 chains not confirmed.
- CANS has no linked paper or formal-verification artefacts; Plutus execution cost of the Schnorr check not published.
- Could not open the Fiber issue tracker to confirm whether a PTLC issue/RFC exists beyond the README line (issue #1016 surfaced in search but was not read).
- Cycle cost of ckb-auth's Ed25519 (Solana/Cardano) verification and its audit status are not stated on the repo front page.

## 3. The free-option / griefing problem and mitigations

### Takeaway
An HTLC swap gives the secret holder a free American option for the counterparty's timelock; Han, Lin and Yu price it at about 2-3% of notional for crypto at their default timelocks, and it scales with volatility times the square root of time, so cutting the window from a day to minutes is by far the largest lever and costs nothing on-chain. Premium/collateral schemes fix fairness but add locked value and, in most constructions, transactions.

### Cited Findings
- Han, Lin, Yu (AFT 2019): an atomic swap "is equivalent to an American Call Option without the premium"; with the Cox-Ross-Rubinstein model the fair premium is about 2-3% of asset value for cryptocurrencies versus about 0.3% for stocks and fiat; they propose premium-carrying swap protocols, directly implementable on Ethereum (Solidity reference) and on Bitcoin with one added opcode. — [ePrint 2019/896](https://eprint.iacr.org/2019/896)
- Xu, Ackerer, Dubovitskaya (ICDCS 2021): game-theoretic model of success rate as a function of swap rate, price and volatility; both agents may abandon to exploit price moves; collateral raises the success rate, as does letting agents adjust the locked amounts. — [arXiv 2011.11325](https://arxiv.org/abs/2011.11325)
- Nadahalli, Khabbazian, Wattenhofer, "Grief-free Atomic Swaps" (ICBC 2022): folds the premium into the principal lock so the premium is not locked longer than the swap, works on Bitcoin without new opcodes, fewer transactions and lower worst-case timelock than earlier premium designs; it notes Arwen-style protocols leave griefing possible on one side. — [ePrint 2022/700](https://eprint.iacr.org/2022/700)
- "4-Swap" (Singh, Ribeiro, Mandal, AFT 2025) claims grief-free and bribery-safe swaps in four transactions and says the Nadahalli et al. protocol needs five. — [arXiv 2508.04641](https://arxiv.org/pdf/2508.04641)
- 2026 follow-ups: GumSwap (griefing-free multi-party universal swaps) and HedgeSwap (hedged universal swaps), both Hou et al. — [ePrint 2026/1253](https://eprint.iacr.org/2026/1253), [ePrint 2026/1252](https://eprint.iacr.org/2026/1252) (titles from search snippet; not read)
- Arwen (Heilman, Lipmann, Goldberg, FC 2020): layer-two RFQ trading against a centralized exchange where each trade is an atomic swap; the user pays an escrow fee for the exchange locking coins; the commercial fee schedule charged 1 basis point per day of escrow with a rebate for early close. — [ePrint 2020/024](https://eprint.iacr.org/2020/024), [Arwen fee schedule](https://arwen.freshdesk.com/solution/articles/44001186369-pricing-and-fees)
- Boltz (2019): the free option is "very much a real-world problem" wherever HTLCs are used and cannot be fully solved without a trusted third party. Its mitigation for reverse swaps is a small prepaid miner-fee invoice (`prepay.minerfee`) that must be paid before the hold invoice is revealed. — [Boltz blog: The problem with free options](https://blog.boltz.exchange/p/the-problem-with-free-options-69f9f59a2d48), [Boltz API v1 docs (deprecated)](https://docs.boltz.exchange/api/api-v1)
- Lightning: hold fees were proposed in 2020 (Jager); upfront fees plus local reputation (bolts #1052) and HTLC endorsement (a TLV on `update_add_htlc`) are proposals; no complete jamming mitigation is deployed network-wide. A 2026 ePrint questions the "2%" figure from the upfront-fee work as a simulation output. — [lightning-dev: Hold fees](https://lists.linuxfoundation.org/pipermail/lightning-dev/2020-October/002863.html), [bolts PR 1052](https://github.com/lightning/bolts/pull/1052), [Optech: channel jamming](https://bitcoinops.org/en/topics/channel-jamming-attacks/), [ePrint 2026/2001](https://eprint.iacr.org/2026/2001.pdf)
- 1inch Fusion+: user signs an off-chain order; resolvers compete in a Dutch auction; the winning resolver creates both escrows (source with the user's funds, destination with its own) linked by a secret hash and pays all gas on both chains; the secret is released via the relayer after both escrows pass a finality lock (Solana: 14 s low/medium volume, 24 s high volume); each escrow carries a small safety deposit paid to whoever completes or cancels during recovery; partial fills use a Merkle tree of secrets. Solana is supported. — [1inch cross-chain swap docs](https://business.1inch.com/portal/documentation/apis/swap/cross-chain-swap/introduction)

### Inferences
- Rough option value (my calculation, at-the-money approximation value ≈ 0.4 × σ × √T, not from a paper):

  | Window T | σ = 80%/yr | σ = 150%/yr |
  |---|---|---|
  | 1 minute | 0.04% | 0.08% |
  | 10 minutes | 0.14% | 0.26% |
  | 1 hour | 0.34% | 0.64% |
  | 6 hours | 0.84% | 1.6% |
  | 24 hours | 1.7% | 3.1% |

  The 24-hour row reproduces Han et al.'s 2-3% order of magnitude. An informal source gives the same S·σ·√T heuristic — [spark.money glossary](https://www.spark.money/glossary/free-option-problem).
- Mitigations that need no extra on-chain step: (a) short timelocks, bounded below by the slower chain's finality plus a claim margin; (b) pricing the option into the quoted spread; (c) arranging roles so the option holder is the reputable, rate-limited party (the LP generates the secret, or the user locks first as in proof-of-payment and Gugger-style layouts); (d) RFQ quotes with seconds-long validity; (e) reputation, per-address rate limits and blacklists; (f) an off-chain prepay over Lightning/Fiber (Boltz's pattern); (g) folding a premium into the principal lock when the script can express it (no extra transaction, but extra locked value).
- Mitigations that do add on-chain value or steps: separate premium/collateral escrows (Han et al.; Xu et al.), safety deposits (1inch: no extra transaction but extra value in each escrow), Arwen-style time-based escrow fees.
- Fusion+ shows the production pattern for removing user-side cost: the user never transacts on-chain; the resolver does all four escrow operations. The user still controls the secret, so the user's option lasts only for the short withdrawal window.

### Gaps
- Numerical success-rate results of Xu et al. and the exact timelock assumption behind Han et al.'s 2-3% were not extracted.
- Boltz's current v2 treatment of the option problem (beyond the deprecated v1 `prepay.minerfee`) not confirmed.
- No measured data on real-world abandonment rates of cross-chain HTLC swaps found.

## 4. Capital efficiency for the liquidity provider

### Takeaway
The designs differ mainly in how long LP capital is immobilised per swap: channel-based swaps lock for seconds and reuse capital, proof-of-payment swaps lock nothing in advance and leave capital outstanding only until the proof lands, and HTLC/adaptor swaps lock both sides for the full protocol run or, on failure, the full timelock. I found no published model for the minimum sustainable spread of an atomic-swap LP.

### Cited Findings
- Atomiq is described as settling "without per-swap liquidity lock-ups" using UTXO-controlled vaults and a light client. — [Starknet blog](https://www.starknet.io/blog/native-btc-to-strkbtc-powered-by-atomiq-and-garden/) (search snippet)
- Fiber's stated 2026 focus includes liquidity: reuse proven Lightning approaches (channel management, rebalancing, liquidity pools). A liquidity-management prototype inspired by LND Loop is in design (issue #1541); Loop In/Out and provider mode are "under active development". — [Nervos Talk: Fiber 2026 outlook](https://talk.nervos.org/t/fiber-protocol-complete-network-tested-development-status-challenges-and-2026-outlook/9827), [Fiber dev log 2026-07-23](https://github.com/nervosnetwork/fiber/discussions/1574), [Fiber README](https://github.com/nervosnetwork/fiber)
- Fiber supports stablecoin, RGB++ and UDT channels and "instant swaps between any asset pairs that have available channel paths". — [Fiber README](https://github.com/nervosnetwork/fiber)
- Fiber submarine swaps (on-chain CKB <-> Fiber channel) use HTLC lock scripts with a preimage success path and a timeout refund path. — [Cryptape design reference](https://cryptape.notion.site/Fiber-Submarine-Swap-Product-Design-Reference-2af8f0d3781e8087b7c3f0b4c4f8a275) (search snippet only; page did not load)
- A "Stable Channels" design (dollar-balance channels on Lightning) was raised in the Fiber thread; a community member objected that it relies on off-chain oracles. It is not a Fiber plan. — [Nervos Talk: Fiber 2026 outlook](https://talk.nervos.org/t/fiber-protocol-complete-network-tested-development-status-challenges-and-2026-outlook/9827)
- Xu et al. find swaps more likely to succeed when agents can adjust the rate to price moves, the nearest published link between volatility and LP pricing. — [arXiv 2011.11325](https://arxiv.org/abs/2011.11325)
- Arwen's 1 bp/day escrow fee is a deployed example of pricing LP lock time explicitly. — [Arwen fee schedule](https://arwen.freshdesk.com/solution/articles/44001186369-pricing-and-fees)

### Inferences
- Lock time per swap (my estimates): HTLC/adaptor swap = finality of both chains plus two claim transactions, minutes when CKB and Cardano confirmations dominate; proof-of-payment = zero pre-lock, repayment lag of chain-B finality plus proof generation; channel swap = seconds.
- A first-principles floor for the LP spread (my own model, not from literature): spread ≥ option value conceded (about 0.4·σ·√T_option × probability the counterparty exercises adversely) + cost of capital × lock time / utilisation + on-chain fees / trade size + hedge cost (perp funding and slippage) + inventory rebalancing cost. With T_option of a few minutes the option term is about 0.1-0.3% for a volatile small-cap pair, comparable with typical instant-exchange spreads; at hours it dominates everything else.
- Netting: opposite flows cancel inventory automatically in every design; only net flow needs rebalancing via a CEX, a bridge, or (for CKB/BTC) Fiber-Lightning circular routes. Denominating the LP's inventory in stablecoins on the foreign chain and hedging CKB with perpetuals reduces price risk to the option window; no source quantifies this for CKB.
- Just-in-time liquidity applies naturally to proof-of-payment and Fusion+-style designs because the filler only needs funds at the moment of the plain transfer and can be any party; HTLC designs require the specific counterparty to pre-lock.

### Gaps
- No published model found for minimum LP spread as a function of volatility, lock time and volume; the nearest are Han et al. and Xu et al.
- No data on Fiber channel capacity, CCH volumes, or CKB perpetual-futures depth for hedging.

## 5. Multi-hop hash-locked routes across heterogeneous networks

### Takeaway
One payment hash across Fiber and Lightning is already implemented (Fiber's Cross-Chain Hub with LND, SHA-256), so CKB <-> BTC-Lightning swaps need no new cryptography; extending the route to Solana, Cardano or Ethereum requires an on-chain HTLC leg there, and every added specialist hop adds a spread and a timelock delta that lengthens the first sender's lock and the option window.

### Cited Findings
- Fiber's CCH bridges CKB/Fiber and Bitcoin Lightning with HTLCs; one `payment_hash` locks both sides so the operator cannot take funds; the operator ("Ingrid") runs a Fiber node and an LND node and charges a fee; Fiber added SHA-256 HTLC hashing for this. Docs are marked work in progress. — [Fiber docs: cross-chain HTLC](https://fiber-docs-9gt8fjy92-ckba-team.vercel.app/docs/res/cross-chain-htlc), [Fiber CCH API reference](https://fiber-docs-4xxqnbxyg-ckba-team.vercel.app/docs/build/api-reference/cch)
- July 2026 CCH work: dry-run Fiber payment before creating an LND hold invoice (PR #1555), TLC expiry randomness kept within a hard budget (PR #1506), recovery of LND payments after restart under review; v0.9.0-rc7, milestone 90% complete; a guide shows paying a Lightning invoice with a CKB UDT over Fiber. — [Fiber dev log 2026-07-23](https://github.com/nervosnetwork/fiber/discussions/1574)
- Fiber status (Jan 2026): multi-hop supported at protocol level and network-tested; watchtowers deferred until the core is stable; tests exposed fund-safety edge cases and stability issues. — [Nervos Talk: Fiber 2026 outlook](https://talk.nervos.org/t/fiber-protocol-complete-network-tested-development-status-challenges-and-2026-outlook/9827)
- Interledger: connectors adjust the amount and shorten the expiry at each hop and must not change the condition; connectors should refuse packets whose expiry is too close. — [Deep dive into Interledger, arXiv 2206.10446](https://arxiv.org/pdf/2206.10446), [spark.money ILP overview](https://www.spark.money/research/open-payments-interledger-protocol) (secondary)
- Using the same preimage along a whole route is a known privacy weakness of HTLC routing (the motivation for PTLCs). — [RGB++ Fans: Understanding the Lightning Network (2)](https://rgbppfans.substack.com/p/understanding-the-lightning-network2)
- Nervos Talk has earlier threads on HTLC lock-script args (owner pubkey, HTLC expiry, grace period) and lock-time rules for multi-hop payments on CKB. — [Nervos Talk: lock time of multi-hop payment](https://talk.nervos.org/t/a-discussion-on-lock-time-of-multi-hop-payment-in-payment-channel-network/5124), [Nervos Talk: container (capacity) of multi-hop payment](https://talk.nervos.org/t/a-discussion-on-container-capacity-of-multi-hop-payment-in-payment-channel-network/5062)

### Inferences
- Timelock rule: each hop's incoming expiry must exceed its outgoing expiry by at least its worst-case time to learn the preimage and claim on the incoming network. Across heterogeneous chains the delta must cover the slower chain's finality, so the first sender's lock is the sum of the deltas; a route CKB -> hub -> Lightning -> BTC-to-SOL specialist inherits the Solana specialist's on-chain HTLC timelock at the far end.
- Cost of chaining specialists versus one market maker: n hops pay n spreads and n option premia, and the sender's capital-lock and option window grow linearly in n. Chaining only wins when a specialist's inventory cost on its pair is much lower than a generalist's (for example, a BTC <-> SOL desk with deep books) or when the middle legs are channel hops with near-zero marginal cost. For CKB -> SOL/ADA/ETH, a route "CKB --Fiber--> CCH --Lightning--> existing Lightning-to-X swap provider" is the only chained route that reuses deployed infrastructure, at the price of two service spreads.
- (Prior knowledge, not re-fetched) ILPv4 moved from on-ledger conditional escrows to small "packetized" payments settled over bilateral channels/trust, which bounds loss per packet instead of enforcing atomicity on-ledger; that trades atomicity for speed and is the opposite design choice to HTLC routes.

### Gaps
- Fiber CCH's actual expiry-delta parameters and fees were not retrieved.
- No source comparing realised cost of chained specialist routes versus a single market maker.
- ILP RFCs (0027, 0022) were not read directly.

## 6. One secret, many legs: multi-party and cyclic swaps

### Takeaway
Multi-leg atomic settlement with one secret is well-founded theoretically (Herlihy 2018: any strongly connected swap digraph, leaders forming a feedback vertex set, time proportional to the graph diameter) and now has an adaptor-signature prototype spanning Bitcoin and Cardano (CANS, 20 parties), so a triangular swap in which each LP handles only its familiar pair is feasible; the cost is staggered timelocks that grow with the ring size.

### Cited Findings
- Herlihy, "Atomic Cross-Chain Swaps" (PODC 2018): swap modelled as a digraph; a protocol exists for any strongly connected digraph with leaders forming a feedback vertex set, using hashed timelock contracts; time O(diam(D)), on-chain bits O(|A|·|L|); impossible if the digraph is not strongly connected or the leader set is not a feedback vertex set. — [arXiv 1801.09515](https://arxiv.org/pdf/1801.09515)
- Imoto, Sudo, Kakugawa, Masuzawa improve space to O(|A|·|V|) and local time to O(|V|). — [arXiv 1905.09985](https://arxiv.org/pdf/1905.09985)
- CANS: ring of N parties, each sends once and receives once, leader reveals the final secret piece once all locks are confirmed, staggered height-based refunds, no shared hash; tested to 20 parties; prototype only. — [IOG: CANS](https://www.iog.io/news/introducing-the-cans-protocol)
- Rösler et al. 2026 support n-to-m swaps with standard signatures and one timed side; You et al. 2024 claim arbitrary parties and chains with a universal adaptor secret; GumSwap (2026) targets griefing-free multi-party universal swaps. — [ePrint 2026/746](https://eprint.iacr.org/2026/746), [arXiv 2406.16822](https://arxiv.org/abs/2406.16822), [ePrint 2026/1253](https://eprint.iacr.org/2026/1253)
- Fiber's CCH already settles a Fiber leg and a Lightning leg with one payment hash. — [Fiber CCH API reference](https://fiber-docs-4xxqnbxyg-ckba-team.vercel.app/docs/build/api-reference/cch)

### Inferences
- A three-party cycle (user CKB -> LP1; LP1 BTC or stablecoin -> LP2; LP2 SOL -> user) has a feedback vertex set of size one, so a single leader secret suffices. The leader (ideally the user or a reputable LP) holds the option; timelocks must decrease around the ring, so the first locker waits roughly three deltas in the worst case.
- With channels, the middle leg can be off-chain (Fiber or Lightning) using the same hash, so only the outer legs touch chains; that is the cheapest realistic triangular layout for CKB today.
- A hash-based ring is linkable across chains and every leg needs hashlock support; an adaptor-based ring (CANS) hides the link and needs only signatures, but each adjacent pair must run a two-party signing session and handle cross-curve proofs unless one side can verify the other's curve in-script (CKB and Plutus can).

### Gaps
- No deployed multi-party cross-chain swap found on any of the four chains; CANS is a prototype without published costs.
- Bribery/collusion analyses for rings (beyond 4-Swap's two-party result) were not reviewed.

## 7. What CKB's cell model specifically enables, and prior Nervos work

### Takeaway
CKB's distinguishing capabilities are deployed building blocks rather than swap products: foreign-signature lock scripts (ckb-auth covers Solana, Cardano, Ethereum), in-VM zk verification at about 100M cycles, read-only light-client cells (Bitcoin SPV for RGB++), and intent/open-transaction patterns (UTXOSwap intent cells, CoBuild OTX). I found no CKB project that combines these into a proof-of-payment swap or a key-share-reveal swap with Solana, Cardano or Ethereum.

### Cited Findings
- ckb-auth integrates signature verification for Bitcoin, Ethereum, EOS, Tron, Dogecoin, Litecoin, Cardano, Monero, Solana and Ripple. — [nervosnetwork/ckb-auth](https://github.com/nervosnetwork/ckb-auth)
- ZK on CKB: Groth16 about 102M cycles (2.9% of a block), zk-lock scripts about 96-101M cycles and about 94 KB, replay binding about 5.3M cycles; SP1 PLONK verifier about 63M cycles; all community work, unaudited, not publicly deployed as of October 2026. LimeChain chose SP1 over RISC Zero for CKB work because of 64-bit support. A linked thread covers verifying CKB state inside other chains (EVM-first, built on RFC 44/45). — [Nervos Talk: ZK research notes](https://talk.nervos.org/t/research-notes-what-zero-knowledge-proofs-enable-on-ckb/10368), [Nervos Talk: SP1 verifier](https://talk.nervos.org/t/optimized-sp1-verifier-for-ckb-vm/10144), [LimeChain blog](https://limechain.tech/blog/how-we-are-bringing-zk-verification-to-the-nervos-network)
- Bitcoin SPV on CKB (info cell plus client cells with header MMR root) is used by RGB++ lock scripts to confirm Bitcoin transactions. — [RGB++ SPV service docs](https://rgbpp.netlify.app/docs/spv-service)
- Force Bridge: designed with on-chain light clients on both sides, but stage one ran the light client as a multisig notary committee (Nervos Foundation and community members); stage two (consensus-based light client, anyone submits headers) was a stated plan; locked assets are controlled by the committee. Mainnet launch reported October 2021. — [nervosnetwork/force-bridge](https://github.com/nervosnetwork/force-bridge), [Force Bridge FAQ](https://github.com/nervosnetwork/force-bridge/blob/main/docs/faq.md), [Crowdfund Insider](https://www.crowdfundinsider.com/2021/10/181718-nervos-introduces-cross-chain-force-bridge-on-mainnet/)
- UTXOSwap: the user signs swap parameters and records them in an intent cell; matching is off-chain and AMM cells verify each intent on-chain. — [UTXOSwap litepaper](https://utxoswap.gitbook.io)
- CoBuild OTX: an open transaction is the smallest unit of one user's operation, same structure as a CKB transaction with one witness; agents aggregate OTXs into a full transaction. — [Nervos Talk: CoBuild OTX overview](https://talk.nervos.org/t/ckb-open-transaction-otx-cobuild-protocol-overview/7739)
- Fiber: HTLC today, PTLC planned; CCH to Lightning implemented; WASM node (`@nervosnetwork/fiber-js`). — [Fiber README](https://github.com/nervosnetwork/fiber), [Nervos Talk: Fiber 2026 outlook](https://talk.nervos.org/t/fiber-protocol-complete-network-tested-development-status-challenges-and-2026-outlook/9827)

### Inferences
Ideas I could not find applied to CKB (all my own synthesis; none is sourced as existing):
1. Proof-of-payment escrow lock using light-client cells as `cell_deps`: Bitcoin immediately (SPV cells exist), Ethereum with a Helios-style zk-updated cell, Cardano once Mithril SNARK certificates are available. Claim cost is one Merkle/MPT check per swap, with the roughly 100M-cycle proof paid once per light-client update.
2. Key-share-reveal lock (in-script Ed25519 scalar check) for Solana and Cardano legs as plain transfers, avoiding both a foreign-chain program and the cross-curve DLEQ.
3. Foreign-key-owned settlement cells: with ckb-auth the CKB leg can pay into a cell locked to the user's Solana, Cardano or Ethereum key, so a user needs no CKB wallet or CKB for fees if the maker builds the transaction (OTX-style), mirroring Fusion+'s "user signs once, resolver pays all gas".
4. Intent cell as the escrow: the user's order is an intent cell (asset, minimum foreign amount, foreign address, deadline); any maker can fill by paying on the foreign chain and presenting a proof or a revealed key share, giving a permissionless RFQ/Dutch-auction without a relayer holding secrets.
5. Signature-as-proof (weaker): a lock that accepts the maker's valid foreign-chain signature over a specific payment transaction. This proves signing, not inclusion, so it is only safe when the signed transaction cannot be invalidated (hard to guarantee on Solana, where the maker can advance a durable nonce); listed for completeness, not recommended.
- Force Bridge never reached its trust-minimised light-client stage as far as the sources show; a 2026 light-client design on CKB would be the first.

### Gaps
- No Nervos Talk post or repository found describing an HTLC or PTLC lock script for CKB <-> Solana/Cardano/Ethereum swaps, or a non-Bitcoin light client on CKB.
- UTXOSwap's exact intent-cell script layout and whether CoBuild OTX is used in production were not confirmed.
- Whether ckb-auth has been audited or is used on mainnet was not stated on the page read.

## 8. Objective synthesis: lowest cost and least locked capital

### Takeaway
Across the surveyed designs, proof-of-payment against a light client minimises both on-chain footprint (3 transactions, one a plain transfer) and LP lock-up, but only Bitcoin and Ethereum are verifiable on CKB with existing components; for Solana and Cardano the lowest-footprint design that needs no light client is a key-share-reveal (Gugger-style) swap in which CKB verifies the Ed25519 scalar in-script and the foreign legs are plain transfers.

### Cited Findings
- Proof-of-payment is deployed for Bitcoin (Atomiq) with no per-swap LP lock-ups and about 20-minute settlement. — [Starknet blog](https://www.starknet.io/blog/native-btc-to-strkbtc-powered-by-atomiq-and-garden/) (search snippet)
- Ethereum light-client proofs are in production (Across SP1 Helios) and CKB can verify Groth16 for about 102M cycles. — [Across docs](https://docs.across.to/concepts), [Nervos Talk: ZK research notes](https://talk.nervos.org/t/research-notes-what-zero-knowledge-proofs-enable-on-ckb/10368)
- Scriptless-on-one-side swaps are in production for Bitcoin-Monero and generalised in 2026 to one-sided timelocks. — [arXiv 2101.12332](https://arxiv.org/abs/2101.12332), [ePrint 2026/746](https://eprint.iacr.org/2026/746)
- Fusion+ demonstrates HTLC swaps where the user does zero on-chain transactions and option windows are tens of seconds on Solana. — [1inch docs](https://business.1inch.com/portal/documentation/apis/swap/cross-chain-swap/introduction)

### Inferences
Comparison (my estimates; "foreign" = Ethereum, Cardano or Solana):

| Design | Happy-path txs (CKB / foreign) | Foreign-chain footprint | LP capital locked | Who holds the option | Needs on CKB | Needs on foreign chain | Trust beyond the two chains |
|---|---|---|---|---|---|---|---|
| Classic HTLC | 2 / 2 | contract or script lock + claim | whole run; full timelock on failure | secret holder | HTLC lock (exists in Fiber/submarine swaps) | HTLC program/contract/validator | none |
| Fusion+-style HTLC with resolver | 2 / 2, all by resolver | same | same, short windows | user (short) | escrow + safety deposit lock | escrow program | relayer for liveness only |
| Key-share reveal (Gugger-style, in-script Ed25519 check) | 2 / 2 | two plain transfers | whole run | whoever locks second | lock with Ed25519 scalar check + two timelocks | nothing (plain keys) | none; refunder must be online |
| Adaptor-signature ring (CANS-style) | 2 / 2 per party | plain-looking spends | whole run, staggered | leader | secp256k1/Ed25519 verification in lock | signatures (+ timelock on one side) | none |
| Proof-of-payment (light client) | 2 / 1 | one plain transfer | none pre-locked; outstanding until proof | maker, for fill window only | light-client cell + proof verifier lock | nothing | light-client assumptions (sync committee, Mithril quorum, PoW depth), updater liveness |
| Channel route (Fiber <-> Lightning via CCH) | 0 / 0 | n/a | seconds | sender | Fiber channel | a channel network (none on ETH/ADA/SOL today) | none |

- Per chain: Ethereum -> proof-of-payment is the best fit (existing Helios proofs; expensive L1 gas makes a 21k-gas plain transfer versus two contract calls a real saving). Cardano -> key-share reveal now (or HTLC in Plutus/Aiken); proof-of-payment when Mithril SNARK certificates and a verifier are available. Solana -> key-share reveal or a Fusion+-style HTLC program now; proof-of-payment is blocked on a light client.
- Regardless of design, the dominant economic cost for volatile pairs is the option window; a design should be judged first by who holds the option and for how long, second by transaction count.

### Gaps
- All footprint numbers in the table are estimates; none of the non-HTLC designs has been built or benchmarked for CKB against these three chains.
- Fee-level comparison in currency terms (CKB cycles and bytes, Solana compute units and rent, Cardano execution units and min-UTxO, Ethereum gas) was not sourced this session.

# Nervos CKB infrastructure for a non-custodial cross-chain swap out of CKB (state as of 12 Nov 2026)

Conventions used in these notes:
- **[P]** = verified against a primary source (repo file, release page, official doc, live API) fetched on 11-12 Nov 2026.
- **[F]** = forum / self-reported claim (Nervos Talk post by the project itself); not independently verified.
- **[STALE]** = source published more than 12 months ago (before Nov 2025); publication date given.
- Numbers from the Fiber dashboard API were read live on 12 Nov 2026 (snapshot timestamp 2026-11-11T17:00Z).

---

## 1. Fiber Network: mainnet status, releases after v0.9.1, size, assets, fees, routing, PTLC, anti-griefing, CCH, LSP

### Takeaway
Fiber has had mainnet contracts since 28 Feb 2025 but the public mainnet graph is tiny (40 nodes, 19 open channels, about 31.5k CKB total capacity, CKB-only), the only whitelisted mainnet UDT is USDI (which its issuer discontinued in mid-2026), and no CCH / wrapped-BTC asset is configured on mainnet. Everything a swap needs at the protocol level exists and is released (multi-hop, hold invoices, SHA-256 hash option, basic MPP, trampoline, watchtower); PTLC, upfront/hold fees, splicing, LSP and Loop In/Out are not released (PTLC and anti-jamming are roadmap/exploration, LSP and Loop are open PRs).

### Cited Findings

**Mainnet status and launch**
- [P] First mainnet deployment of the Fiber contracts came with fnn v0.4.0, published 2025-02-28; the release notes say two bootnodes were set up, that the contract and node were "currently undergoing a security audit", and advise small amounts. [STALE: Feb 2025] — [v0.4.0 release](https://github.com/nervosnetwork/fiber/releases/tag/v0.4.0); date from [releases list](https://github.com/nervosnetwork/fiber/releases)
- [P] The mainnet config still points at the fiber-scripts migration `deployment/mainnet/migrations/2025-02-28-114908.json` for FundingLock and CommitmentLock and lists two bootnodes. — [config/mainnet/config.yml](https://github.com/nervosnetwork/fiber/blob/develop/config/mainnet/config.yml)
- [P] README still warns: "The implementation is still a work-in-progress and will have iterations even after mainnet, please use it with caution"; and recommends closing channels before upgrading. — [Fiber README](https://github.com/nervosnetwork/fiber/blob/develop/README.md)
- [F] Fiber team in the 12 May 2026 Reddit AMA: core capabilities (channels, routing, multi-hop) are live, but "it is still in the process of maturing rather than being fully production-ready." — [Fiber Network AMA recap, 18 May 2026](https://talk.nervos.org/t/the-fiber-network-ama-recap/10294)
- [P] The mainnet commitment-lock contract was upgraded to "0.7.0" on 9 Nov 2026 (fiber-scripts PR #34 merged by quake after multisig signing by XuJiandong, tinnendo, Hanssen0, phroi). — [fiber-scripts PR #34](https://github.com/nervosnetwork/fiber-scripts/pull/34); corroborated in [Cellula thread](https://talk.nervos.org/t/dis-cellula-on-fiber-a-wallet-a-checkout-and-an-ai-agent-on-a-public-mainnet-lsp/11089)

**Release history (dates from the GitHub API)**
- [P] v0.6.0 2025-11-25; v0.6.1 2026-01-14; v0.7.0 2026-02-12; v0.7.1 2026-02-25; v0.8.0 2026-04-03; v0.8.1 2026-04-15; v0.9.0 2026-08-06; **v0.9.1 2026-09-11 (latest stable)**; v0.10.0-rc1 2026-09-25 (pre-release); **v0.10.0-rc2 2026-11-09 (pre-release, latest)**. — [Fiber releases](https://github.com/nervosnetwork/fiber/releases)
- [P] v0.9.0 highlights: unified DB migration and backup/restore, on-chain TLC settlement for force-closed channels, routing improvements "retries, MPP, trampoline routing, and TLC expiry handling", CCH improvements (payment recovery, invoice tracking, fee handling, restart safety), watchtower improvements, security hardening. — [Fiber releases](https://github.com/nervosnetwork/fiber/releases)
- [P] v0.9.1: on-chain TLC reconciliation fixes (#1618, #1630, #1649), configurable peer message rate limits (#1617), preimage settlement scoped to local TLCs (#1651), README roadmap reconciled (#1635). — [Fiber releases](https://github.com/nervosnetwork/fiber/releases)
- [P] **After v0.9.1 — v0.10.0-rc1:** multi-address QUIC listening (#1642), relaying uncommitted fulfills upstream after on-chain settlement (#1661), fix for "prefix-only on-chain preimage settlement" stranding funds (#1656), backup RPC auth (#1662). Explicit warning: this prerelease "does not yet support upgrades from older versions". — [Fiber releases](https://github.com/nervosnetwork/fiber/releases)
- [P] **v0.10.0-rc2 adds:** Channel V2 nonce sessions (#1677), complete dual-funded UDT transactions (#1671), fail a funding tx that conflicts with one in the pool (#1708), force-close when revocation nonce ledger stays unbalanced (#1701) or when a reconnected peer withholds ReestablishChannel (#1711), reject trampoline forwards with mismatched hash algorithm (#1673), forward custom records in send_payment_with_router (#1675), **hold-set settlement can replay a queued fulfill (#1709)**, invoices for a different CKB network are rejected (#1698), optional synced store writes (#1703), MIT LICENSE added (#1680). — [Fiber releases](https://github.com/nervosnetwork/fiber/releases)
- [P] Channel V2 "combines independent commitment-owner nonce sessions with **full 32-byte on-chain payment hashes**"; legacy channels keep V1 messages and the original contract layout; a node must only advertise CHANNEL_V2 once the deployed commitment lock accepts 58-byte V2 args. — [docs/notes/channel-v2.md](https://github.com/nervosnetwork/fiber/blob/develop/docs/notes/channel-v2.md)
- [P] Biweekly #26 summarises v0.10.0-rc1 as "full-payment-hash settlements, better force-close payment recovery and multiple listening addresses". — [CKB Ecosystem Biweekly Update thread](https://talk.nervos.org/t/ckb-ecosystem-biweekly-update/9821)
- [P] Fiber Dev Log 2026-10-29: updated commitment lock live on testnet since 21 Oct 2026; Channel V2 (PR 1677) ready for review; Hosted LSP (PR 1623) open, not merged; v0.10.0-rc1 does not support upgrading an existing DB. — [Fiber discussion #1712](https://github.com/nervosnetwork/fiber/discussions/1712)

**Network size (live dashboard API, 12 Nov 2026)**
- [P] **Mainnet: 40 nodes, 19 channels, all open, all CKB.** Total channel capacity 31,498 CKB (avg 1,658; median 749; max 5,250; min 500 CKB). No UDT channels on mainnet. Node regions: BR, CA, DE, FR, HK, JP, PT, SG, US. — [api-dashboard.fiber.channel/analysis_hourly?net=mainnet](https://api-dashboard.fiber.channel/analysis_hourly?net=mainnet); [channel_count_by_asset](https://api-dashboard.fiber.channel/channel_count_by_asset?net=mainnet); [channel_count_by_state](https://api-dashboard.fiber.channel/channel_count_by_state?net=mainnet); dashboard UI at [dashboard.fiber.channel](https://dashboard.fiber.channel)
- [P] **Testnet: 597 nodes, 5,449 channels** (5,223 CKB, 124 RUSD, 90 USDI, 12 cWBTC); about 6.35M testnet CKB capacity. — [api-dashboard.fiber.channel/analysis_hourly?net=testnet](https://api-dashboard.fiber.channel/analysis_hourly?net=testnet)
- [F] CKB price reference: about $0.001215 on 1 Nov 2026 (Cellula budget post), which puts total mainnet Fiber capacity at roughly $38. — [Cellula on Fiber DIS](https://talk.nervos.org/t/dis-cellula-on-fiber-a-wallet-a-checkout-and-an-ai-agent-on-a-public-mainnet-lsp/11089)

**Public nodes, whitelisted assets, fees**
- [P] Two official mainnet public nodes: `fiber-mainnet-public-ca` (03a8d7da…) and `fiber-mainnet-public-tokyo` (033a69e5…). Auto-accept channels ≥ 499 CKB (99 CKB reserved), 250 CKB inbound liquidity supplied by the node. — [docs/network-nodes.md](https://github.com/nervosnetwork/fiber/blob/develop/docs/network-nodes.md)
- [P] **Only UDT in the mainnet `udt_whitelist` is USDI** (code_hash 0xbfa35a9c…, args 0xd591ebdc…, auto_accept_amount 0.1 USDI). The doc states: "The public nodes' CKB addresses do not hold any USDI yet, so UDT channels cannot be created at this time." — [config/mainnet/config.yml](https://github.com/nervosnetwork/fiber/blob/develop/config/mainnet/config.yml); [docs/network-nodes.md](https://github.com/nervosnetwork/fiber/blob/develop/docs/network-nodes.md)
- [P] Testnet whitelist in the repo config is RUSD only (auto-accept ≥ 20 RUSD on public nodes); the dashboard additionally shows USDI and cWBTC channels on testnet. — [docs/public-nodes.md](https://github.com/nervosnetwork/fiber/blob/develop/docs/public-nodes.md); [dashboard API](https://api-dashboard.fiber.channel/channel_count_by_asset?net=testnet)
- [P] Routing fee on the public-node example channels: `tlc_fee_proportional_millionths = 0x3e8` = 1,000 ppm = 0.1% per hop. Sender-side default `max_fee_rate` is 5 per thousand (0.5%). — [docs/public-nodes.md](https://github.com/nervosnetwork/fiber/blob/develop/docs/public-nodes.md); [RPC README](https://github.com/nervosnetwork/fiber/blob/develop/crates/fiber-lib/src/rpc/README.md)

**Routing features**
- [P] README checklist: done = connections, open/close channels, payments, Basic MPP, cross-network asset transfer, WASM/fiber-js runtime ("productization in progress"). Not done = "Programmable conditional payment — official roadmap item covering PTLC, hold-invoice application protocols, on-chain contract conditions, and agent fair exchange"; "Advanced channel liquidity management — under active development (Loop In/Out and provider mode), not yet released"; "Atomic multi-path payment — long-term research direction". — [Fiber README](https://github.com/nervosnetwork/fiber/blob/develop/README.md)
- [P] Multi-hop is live (feature list; public-nodes doc shows 3-hop payments via node1/node2). — [docs/public-nodes.md](https://github.com/nervosnetwork/fiber/blob/develop/docs/public-nodes.md)
- [P] Trampoline routing is released (v0.9.0) and specified: `trampoline_hops` in SendPayment, max 5 trampoline hops, fee budget split evenly across hops. Open bug: trampoline holds a second payment of an already-paid invoice until expiry (#1724, opened 5 Nov 2026). — [docs/specs/trampoline-routing.md](https://github.com/nervosnetwork/fiber/blob/develop/docs/specs/trampoline-routing.md); [issue #1724](https://github.com/nervosnetwork/fiber/issues/1724)
- [P] Watchtower exists as an RPC module and has had repeated fixes (v0.8.0, v0.9.0, v0.10.0-rc2 #1707/#1719). — [Fiber releases](https://github.com/nervosnetwork/fiber/releases)
- [P] Hold invoices: `new_invoice` with `payment_hash` set and no preimage "indicates a 'hold invoice'"; `settle_invoice` RPC exists. Hash algorithms: `ckb_hash` (default) and `sha256`. — [RPC README](https://github.com/nervosnetwork/fiber/blob/develop/crates/fiber-lib/src/rpc/README.md)
- [P] Onion/SOCKS5 (Tor) transport since v0.8.1; external-wallet channel funding (`open_channel_with_external_funding`) since v0.8.0. — [Fiber releases](https://github.com/nervosnetwork/fiber/releases)

**PTLC**
- [P] Glossary: "PTLC support is a planned direction; today Fiber still runs on hash-based TLC/HTLC flows." README: "hash-based HTLC payment contracts today, with PTLC planned as a future direction". No PTLC implementation PR or issue was found in the repo search (only the README-reconcile PR #1635 and glossary issue #1037 match "PTLC"). — [docs/glossary.md](https://github.com/nervosnetwork/fiber/blob/develop/docs/glossary.md); [PR #1635](https://github.com/nervosnetwork/fiber/pull/1635)
- [F] Several community posts (AgentPay, Dular, the rejected "Fiber Submarine Swap Service" proposal) wrongly state that Fiber already uses PTLCs; the primary docs contradict them. — [AgentPay](https://talk.nervos.org/t/agent-pay-btc-first-agent-pay/10086); contradicted by [glossary](https://github.com/nervosnetwork/fiber/blob/develop/docs/glossary.md)

**Anti-griefing / upfront fee / hold-invoice fee**
- [F] Fiber team (12 May 2026): channel jamming "can't be fully eliminated"; mitigations under exploration are "HTLC resource limits, fee constraints, per-peer and global rate limits". No fee figures, no upfront or hold fee announced. — [AMA recap](https://talk.nervos.org/t/the-fiber-network-ama-recap/10294)
- [P] Shipped mitigations are rate limits only: gossip rate limiting (v0.9.0), "configurable peer message rate limits" (#1617, v0.9.1), inbound and reconnect protections (#1200, v0.8.0). Repo search for "jamming OR upfront OR griefing" returns only issue #138 (2024) and #1009 (MPP/hold-invoice workflow simplification, closed Dec 2025). — [Fiber releases](https://github.com/nervosnetwork/fiber/releases); [issue #1009](https://github.com/nervosnetwork/fiber/issues/1009)

**Cross-Chain Hub (CCH)**
- [P] Spec: CCH is an HTLC same-preimage bridge between Fiber and BOLT Lightning (via LND). The Fiber-side asset is a **wrapped-BTC UDT at a fixed 1:1 ratio** ("Ingrid configures a UDT asset in CKB as the wrapped BTC"); "the two networks must use the same hash algorithm"; hub keeps fee F. RPCs `send_btc` / `receive_btc` take a `wrapped_btc_type_script`. — [docs/specs/cross-chain-htlc.md](https://github.com/nervosnetwork/fiber/blob/develop/docs/specs/cross-chain-htlc.md); [RPC README](https://github.com/nervosnetwork/fiber/blob/develop/crates/fiber-lib/src/rpc/README.md)
- [P] CCH expiry rules: default final TLC expiry deltas give a 30-hour window (release note for v0.8.1 says CCH final TLC expiry deltas default to 60 hours, #1258); outgoing final expiry must be less than half the incoming one; dynamic `cltv_limit` / `tlc_expiry_limit` cap on the outgoing route. — [docs/specs/cch-expiry-dependency.md](https://github.com/nervosnetwork/fiber/blob/develop/docs/specs/cch-expiry-dependency.md); [v0.8.1 notes](https://github.com/nervosnetwork/fiber/releases)
- [P] CCH can run standalone over HTTP RPC with a WebSocket store subscription since v0.8.0 (#1165). — [Fiber releases](https://github.com/nervosnetwork/fiber/releases)
- [P] Mainnet config has no wrapped-BTC UDT in the whitelist and the dashboard shows zero UDT channels on mainnet; cWBTC exists only on testnet (12 channels). — [config/mainnet/config.yml](https://github.com/nervosnetwork/fiber/blob/develop/config/mainnet/config.yml); [dashboard API](https://api-dashboard.fiber.channel/channel_count_by_asset?net=mainnet)
- [F] Fiber team (May 2026): the only planned cross-network work is "swapping between BTC in lightning via lnd with any asset in CKB", presented as a demonstration; "There's no plans to support other channels." — [AMA recap](https://talk.nervos.org/t/the-fiber-network-ama-recap/10294)
- [F] Testnet CCH operators/demos: RetricSu's ckb-on-ramp (FNN v0.9.0 + CCH + LND, cWBTC, fee 0.3% + 100 sats, 10,130 sats delivered 10,000 cWBTC units in about 3 s); ebubedev's self-hosted "Fiber CCH Hub" kit (testnet only); TEX Labs' CKBolt (testnet; CKB, cWBTC, rUSD); "Paying a Bitcoin Lightning Invoice with CKB UDT on Fiber" demo. — [ckb-on-ramp, 26 Oct 2026](https://talk.nervos.org/t/ckb-on-ramp-ckb/11050); [CCH hub kit, 10 Aug 2026](https://talk.nervos.org/t/pay-lightning-with-fiber-a-self-hosted-cross-chain-hub-anyone-can-run/10599); [CKBolt, 7 Nov 2026](https://talk.nervos.org/t/ckbolt-connecting-bitcoin-lightning-and-fiber-network-on-nervos-ckb/11144); [CCH demo, 14 Jul 2026](https://talk.nervos.org/t/paying-a-bitcoin-lightning-invoice-with-ckb-udt-on-fiber/10486)
- [F] RetricSu notes CCH uses a fixed ~1:1 sats-to-UDT rate and proposes "custom swap pricing and liquidity-aware CCH" as a protocol change, i.e. CCH today cannot price CKB against BTC. — [ckb-on-ramp](https://talk.nervos.org/t/ckb-on-ramp-ckb/11050)

**LSP, liquidity marketplace, Loop In/Out, splicing**
- [P] "LSP support" PR #1623 (opened 10 Aug 2026) is open/unmerged; design issue #1625 "Multi-tenant Hosted LSP support" open; testnet findings #1679, #1695, #1706. — [PR #1623](https://github.com/nervosnetwork/fiber/pull/1623); [issue #1625](https://github.com/nervosnetwork/fiber/issues/1625)
- [P] Loop In / Loop Out: draft PR #1643 (opened 1 Sep 2026, 265 commits, no target release). Uses a new on-chain **`liquidity-lock`** script that is "not on fiber-scripts main" (pinned at fiber-scripts@4da5d299). The lock checks `blake2b_256(preimage)`, so Loop In invoices must use CkbHash; reviewers flagged a critical bug where a SHA-256 invoice lets the client take the Fiber payment and also refund the lock. — [PR #1643](https://github.com/nervosnetwork/fiber/pull/1643)
- [P] Liquidity milestones M0-M9 (issue #1541, opened 7 Jul 2026): M1 liquidity-lock contract pushed to fiber-scripts with tests; M3 manual Loop Out and M4 manual Loop In slices done; M5 provider mode first slice; provider discovery / quote gossip deferred to M9. — [issue #1541](https://github.com/nervosnetwork/fiber/issues/1541)
- [F] LusoCryptoLabs plans a "public mainnet LSP" on a Fiber fork built from the LSP branch (961,368 CKB own capital: 299,000 for channels at 299 CKB per wallet, 500,000 for routing); DAO vote runs 9-16 Nov 2026; local scale test held 11,496 channels on one LSP. Not yet live. — [Cellula on Fiber DIS, 2 Nov 2026](https://talk.nervos.org/t/dis-cellula-on-fiber-a-wallet-a-checkout-and-an-ai-agent-on-a-public-mainnet-lsp/11089)
- [F] Liquidity marketplace proposals: LiquidLane (LP-backed channel liquidity; first Spark proposal rejected, resubmitted 29 Sep 2026); Carl's gossip-based swap quote board (publish/list/best-rate work on two testnet nodes; swap execution not built). — [LiquidLane](https://talk.nervos.org/t/liquidlane-lp-backed-fiber-channel-liquidity/10686); [LiquidLane resubmission](https://talk.nervos.org/t/spark-program-liquidlane-fiber-receive-capacity-marketplace-resubmission/10796); [market board, 22 Sep 2026](https://talk.nervos.org/t/a-market-board-for-fiber-swaps-hubs-advertise-wallets-discover/10738)
- [F] JoyID discontinued its (Bitcoin) Lightning features and closed all channels on 18 Aug 2026. — [Biweekly Update #21](https://talk.nervos.org/t/ckb-ecosystem-biweekly-update/9821)

### Inferences
- A mainnet swap that relies on routing through the existing public Fiber graph is capped by about 31.5k CKB of total capacity (median channel 749 CKB); any real swap volume needs the maker to open its own channel directly to the taker or to an LSP, so "Fiber leg" liquidity is effectively self-provisioned today.
- There is no CCH on mainnet: no wrapped BTC is whitelisted, and CCH by design only does 1:1 wrapped-BTC against Lightning BTC. It is not a route to ETH or ADA and does not price CKB.
- SHA-256 hold invoices are the supported interop primitive (same hash on the foreign chain). Channel V2's "full 32-byte on-chain payment hash" (v0.10) changes on-chain TLC settlement; v0.9.1 channels use a truncated hash on-chain, which matters for any design that wants to read a Fiber preimage from a CKB L1 force-close.
- With no upfront/hold fee, a maker who locks first in a Fiber-based swap carries free-option and jamming risk; the only shipped protections are rate limits and expiry rules.
- The `liquidity-lock` (blake2b preimage, timeout refund) is the closest thing to an official on-chain CKB HTLC, but it is unmerged, CkbHash-only and has open critical review findings; it is not yet a reusable audited piece.

### Gaps
- No official statement of who operates most of the 40 mainnet nodes; only the two official public nodes are documented.
- No published audit report for fiber-scripts was located (v0.4.0 notes said an audit was in progress in Feb 2025).
- Splicing: no mention in README, releases, specs or issue search; status unknown (most likely not started).
- Whether the 9 Nov 2026 mainnet commitment-lock 0.7.0 upgrade is backward-compatible with channels opened under v0.9.1 is not stated in the PR.
- The Cryptape Notion page "Fiber Submarine Swap Product Design Reference" exists but its content could not be read (JS-only page). — [Notion page](https://cryptape.notion.site/Fiber-Submarine-Swap-Product-Design-Reference-2af8f0d3781e8087b7c3f0b4c4f8a275)

---

## 2. CKB L1 script capabilities for verifying other chains (limits, signature schemes, wallets, ZK verifiers, light clients, Meepo)

### Takeaway
CKB L1 can run arbitrary verifiers (RISC-V VM, spawn syscall live since Meepo on 1 Jul 2025) inside a 3.5 billion-cycle block, but default node policy caps a single transaction at 70M cycles, and the existing verifiers sit right around or above that line (SP1 PLONK about 63M; Groth16/BN254 about 96-121M; Mithril certificate 134-146M). Ethereum, Bitcoin and Solana wallets can already control CKB cells through Omnilock / CCC locks; Cardano has only a ckb-auth algorithm that verifies cardano-cli-style signed transactions, no wallet connector. The only production foreign-chain light client on CKB is the Bitcoin SPV client used by RGB++; Cardano (Mithril) and CKB-in-EVM light clients exist only as 2026 testnet research (Chiral) or design notes.

### Cited Findings

**Limits**
- [P] Consensus: `MAX_BLOCK_CYCLES = 3,500,000 x 1,000 = 3.5 billion`; `MAX_BLOCK_BYTES = 597 x 1,000 = 597,000 bytes`. — [ckb spec/src/consensus.rs](https://github.com/nervosnetwork/ckb/blob/develop/spec/src/consensus.rs); [docs: VM cycle limits](https://docs.nervos.org/docs/script/vm-cycle-limits)
- [P] Default tx-pool policy in `ckb.toml`: `max_tx_verify_cycles = 70_000_000`, `min_fee_rate = 1_000` shannons/KB, `max_ancestors_count = 25`. This is node policy, not consensus. — [ckb resource/ckb.toml](https://github.com/nervosnetwork/ckb/blob/develop/resource/ckb.toml)
- [F] Forum answer: max transaction size accepted is 512,000 bytes; consensus imposes no per-tx size/cycle rule beyond the block limits. [STALE: 2023] — [What's the max size and max cycles of a tx?](https://talk.nervos.org/t/what-s-the-max-size-and-max-cycles-of-a-tx/7167/2)

**Meepo / CKB-VM v2 / spawn**
- [P] Meepo (CKB2023) hard fork activated on mainnet at epoch 12,293, 1 Jul 2025; activates VM version 2 and the spawn family of syscalls (cross-script calls with pipes). [STALE: Jul 2025, still current] — [Meepo hard fork is now live](https://talk.nervos.org/t/meepo-hard-fork-is-now-live/8812); [CKB hard fork history](https://docs.nervos.org/docs/history-and-hard-forks/ckb-hard-fork-history); [VM version history](https://docs.nervos.org/docs/history-and-hard-forks/history-vm-version)
- [P] Current node releases: CKB v0.210.0 on 17 Sep 2026; v0.211 in preparation (Nov 2026). "Light-client verification proposals remain under review" (CKB Dev Log 2026-10-14). — [Biweekly Updates #26-#28](https://talk.nervos.org/t/ckb-ecosystem-biweekly-update/9821)

**Signature schemes: ckb-auth**
- [P] ckb-auth algorithm IDs: 0 CKB, 1 Ethereum, 2 EOS, 3 Tron, 4 Bitcoin, 5 Dogecoin, 6 CKB multisig, 7 Schnorr, 10 Litecoin, **11 Cardano**, 12 Monero, **13 Solana**, 14 Ripple. Callable via dynamic library, exec, or spawn. — [ckb-auth docs/auth.md](https://github.com/nervosnetwork/ckb-auth/blob/main/docs/auth.md)
- [P] Cardano lock in ckb-auth: the "signature" is Cardano signed data produced with `cardano-cli` (keys from `node key-gen`; the 32-byte CKB message is placed as the `--tx-in` hash of a raw Shelley-era transaction that is then signed). It is not described as CIP-8/CIP-30 wallet message signing. — [ckb-auth docs/cardano.md](https://github.com/nervosnetwork/ckb-auth/blob/main/docs/cardano.md)
- [P] Solana in ckb-auth: verifies a Phantom `signMessage` signature over the hex message; witness is a fixed 512-byte structure containing signature, pubkey and signed message. — [ckb-auth docs/solana.md](https://github.com/nervosnetwork/ckb-auth/blob/main/docs/solana.md); [docs/auth.md](https://github.com/nervosnetwork/ckb-auth/blob/main/docs/auth.md)
- [P] The Fiber mainnet FundingLock/CommitmentLock list a `ckb_auth` cell dep (tx 0x95006eee…), i.e. ckb-auth is deployed on mainnet as a dependency of Fiber. — [config/mainnet/config.yml](https://github.com/nervosnetwork/fiber/blob/develop/config/mainnet/config.yml)

**Signature schemes: Omnilock (RFC 42)**
- [P] Omnilock auth flags: 0x00 CKB secp256k1, 0x01 Ethereum, 0x03 Tron, 0x04 Bitcoin (P2WPKH, P2SH-P2WPKH, P2PKH; Taproot not supported; message "CKB (Bitcoin Layer) transaction: 0x…"), 0x05 Dogecoin, 0x06 CKB multisig, 0x12 Ethereum "displaying" ("CKB transaction: 0x…" for MetaMask), 0xFC owner-lock delegation, 0xFD delegate to another script via exec, 0xFE via dynamic linking. No Solana or Cardano flag appears in the RFC. [STALE: RFC text undated here, long-standing] — [RFC 0042 Omnilock](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0042-omnilock/0042-omnilock.md)

**Wallet connectors: CCC and JoyID**
- [P] CCC wallet support per docs: JoyID, OKX, UniSat, MetaMask (and EVM mobile wallets such as imToken, SafePal), UTXO Global, Rei; npm packages also exist for Xverse and Nostr NIP-07. — [docs.nervos.org CCC wallet](https://docs.nervos.org/docs/integrate-wallets/ccc-wallet); [@ckb-ccc packages](https://npmjs.com/package/@ckb-ccc/ccc)
- [P] CCC lock scripts documented: CCC ETH lock, CCC BTC lock, and **CCC SOL lock** (Ed25519; args = 20-byte hash of the 32-byte pubkey; witness lock = 64-byte signature + 32-byte pubkey; signed message starts "Signing a CKB transaction:" + hex sighash_all). The SOL lock page lists a **testnet** deployment (code hash 0x98870bb4…); no mainnet deployment is listed. Source docs in `ckb-devrel/ccc-locks`. — [CCC SOL lock](https://docs.nervos.org/docs/ecosystem-scripts/ccc-sol-lock); [CCC ETH lock](https://docs.nervos.org/docs/ecosystem-scripts/ccc-eth-lock); [CCC BTC lock](https://docs.nervos.org/docs/ecosystem-scripts/ccc-btc-lock)
- No CCC or JoyID support for Cardano wallets was found in any source checked. — [docs.nervos.org CCC wallet](https://docs.nervos.org/docs/integrate-wallets/ccc-wallet)
- [F] A CCC paper was accepted as a poster at IEEE ICDLT 2026 (3-4 Dec 2026); CCC remains actively maintained (commits Oct-Nov 2026). — [Biweekly Update #27](https://talk.nervos.org/t/ckb-ecosystem-biweekly-update/9821)

**On-chain ZK / pairing verifiers on CKB-VM**
- [F] SP1 verifier for CKB-VM (author xjd / XuJiandong, 1 Apr 2026): based on SP1 6.0.2, **PLONK only** ("Groth16 is not optimized"), about 6,000M cycles reduced to **about 63M cycles** per verification, binary 246 KB. Repo `XuJiandong/sp1` branch `no-std-v6`. No testnet/mainnet deployment mentioned. SP1 below v6 (rv32) is not supported by this path. — [Optimized SP1 Verifier for ckb-vm](https://talk.nervos.org/t/optimized-sp1-verifier-for-ckb-vm/10144)
- [F] Groth16/BN254 verifier `groth16-ckb` (Cecilia Mulandi, Jun-Oct 2026): about 102M cycles for 1 public input, about 121M at 64 inputs (+270-300k per input); a proof-gated "zk-Lock" at about 96M cycles (release build). — [Research Notes: What ZK proofs enable on CKB](https://talk.nervos.org/t/research-notes-what-zero-knowledge-proofs-enable-on-ckb/10368); [groth16-ckb thread](https://talk.nervos.org/t/groth16-ckb-an-on-chain-groth16-verifier-for-ckb-vm/10288)
- [F] SP1 is used in the CKB DAO treasury voting PoC (`XuJiandong/ckb-vote-poc`). — [Research Notes](https://talk.nervos.org/t/research-notes-what-zero-knowledge-proofs-enable-on-ckb/10368)
- [F] BLS12-381 on CKB-VM: Chiral verifies a full Mithril certificate (stake-based BLS12-381 multi-signature) in CKB-VM at **about 134-146M cycles**, run on Pudge testnet. — [Chiral open-source post, 25 Jun 2026](https://talk.nervos.org/t/chiral-is-now-open-source-a-trust-minimized-cardano-and-nervos-ckb-port-for-you-to-review-break-and-test/10421)
- [P] CKB core devs ported `c-kzg-4844` (KZG/BLS12-381 blob commitments) to CKB-VM (Biweekly #28, Nov 2026). — [Biweekly Update #28](https://talk.nervos.org/t/ckb-ecosystem-biweekly-update/9821); [XuJiandong/c-kzg-4844](https://github.com/XuJiandong/c-kzg-4844)
- [F] RISC Zero: LimeChain reported it lacked native 64-bit support, which blocked a CKB integration; they used SP1 instead. No native RISC Zero verifier on CKB was found. — [LimeChain: ZK verification on Nervos](https://limechain.tech/blog/how-we-are-bringing-zk-verification-to-the-nervos-network)
- Older toolkit: `sec-bit/ckb-zkp` (Groth16, Bulletproofs, etc. on CKB-VM). [STALE: 2020-21] — [sec-bit/ckb-zkp](https://www.github.com/sec-bit/ckb-zkp)
- [F] Post-quantum lock work also exists (SHRINCS lock script by xjd, testnet demo, Sep 2026), showing hash-based signature verification in CKB-VM. — [SHRINCS thread](https://talk.nervos.org/t/shrincs-324-byte-stateful-post-quantum-signatures/10740)

**Light clients for other chains on CKB**
- [P] Bitcoin: `ckb-bitcoin-spv-contracts` (type script for Bitcoin SPV client cells; MIT; audit report linked; README still says "proof-of-concept stage"). In RGB++ an SPV instance is one info cell plus at least three client cells holding Bitcoin header state; RgbppLock and BtcTimeLock consult it to confirm Bitcoin transactions. — [ckb-bitcoin-spv-contracts](https://github.com/ckb-cell/ckb-bitcoin-spv-contracts); [RGB++ SPV service docs](https://rgbpp.netlify.app/docs/spv-service); [rgbpp-sdk](https://github.com/ckb-cell/rgbpp-sdk)
- [P] Ethereum: `nervosnetwork/force-bridge-eth` contains an "Ethereum light client" CKB contract and describes a staged design (stage 1 multisig committee, stage 2 consensus-verifying light client). [STALE: 2020-21 design]. Production Force Bridge was committee-based and is now sunset (section 3). — [force-bridge-eth](https://github.com/nervosnetwork/force-bridge-eth)
- [P] Forcerelay (IBC relayer built on Hermes) supports Axon, CKB and Cosmos-SDK chains with light-client modules; no evidence of a maintained Ethereum sync-committee verifier on CKB mainnet. [STALE] — [godwokenrises/forcerelay](https://github.com/godwokenrises/forcerelay)
- [F] Cardano: Chiral's CKB-side Mithril verifier plus a light-client cell that "advances only on verified certificates" ran on Pudge testnet (June 2026); unaudited, testnet only. — [Chiral light paper, 9 Jun 2026](https://talk.nervos.org/t/chiral-symmetric-isomorphic-binding-a-committee-free-anchor-agnostic-protocol-where-each-chain-verifies-the-other-with-a-succinct-on-chain-light-client/10360)
- [F] Luxvoid claims a self-hosted Bitcoin SPV verifier on CKB testnet feeding EVM testnets (Sepolia, Monad, LitVM); no repo, unverified, mechanism challenged in-thread. — [Luxvoid DIS, 18 Jun 2026](https://talk.nervos.org/t/dis-luxvoid-protocol-the-first-working-btc-ckb-evm-pipeline-seeking-dao-support-collab-for-production-scaling/10400)

**CKB verified on other chains (relevant to proof-of-payment out of CKB)**
- [F] Chiral: Cardano verifies CKB with a Groth16 proof over BLS12-381 (checked with Plutus BLS builtins, Aiken verifier, about a quarter of a Cardano tx CPU budget) proving Eaglesong PoW, header-MMR membership and CBMT tx inclusion; development (non-MPC) trusted setup. — [Chiral open-source post](https://talk.nervos.org/t/chiral-is-now-open-source-a-trust-minimized-cardano-and-nervos-ckb-port-for-you-to-review-break-and-test/10421)
- [F] Antismart design notes (11 Jun 2026, design-stage, nothing built): EVM verifies CKB via SP1 zkVM proof of Eaglesong PoW + FlyClient sampling (RFC 44/45) for tip updates (about 320k gas per SNARK), with CBMT/MMR inclusion proofs checked natively (about 60-100k gas); Eaglesong has no EVM precompile. T_Silva flagged a stale-header replay gap; a two-sided height bound was added. — [Design notes: verifying CKB state inside other chains](https://talk.nervos.org/t/design-notes-verifying-ckb-state-inside-other-chains-evm-first-built-on-rfc-44-45/10372)

### Inferences
- With the default 70M-cycle pool limit, only the SP1 PLONK verifier (about 63M) clearly fits in a standard-relay transaction, with very little headroom for the rest of the script. Groth16/BN254 (about 96-121M) and Mithril (134-146M) verifications exceed the default policy value, so they would need miners/nodes with raised limits or a different relay path; whether such transactions propagate reliably on mainnet was not confirmed.
- For an ETH leg, no maintained Ethereum light client exists on CKB today; any "verify Ethereum on CKB" design would be new work (the KZG port and SP1 verifier are the available building blocks). For an ADA leg, Chiral's Mithril verifier is the only existing piece and it is testnet/unaudited.
- For hash-locked swaps none of this is needed: CKB scripts can check SHA-256/Blake2b preimages cheaply, and Ethereum/Solana/Bitcoin wallets can sign for CKB cells via Omnilock/CCC. Cardano wallet control of CKB cells is the missing connector (ckb-auth's Cardano mode expects a cardano-cli signed transaction, not a CIP-30 `signData` payload).

### Gaps
- Mainnet deployment status and code hashes of CCC SOL lock and of the Bitcoin SPV type script were not confirmed from primary sources in this pass (RGB++ has run on mainnet since 2024, which implies an SPV deployment, but the page fetched did not show mainnet hashes).
- Exact relay/mining behaviour for transactions above `max_tx_verify_cycles` on mainnet (how Chiral's 134-146M-cycle transactions were accepted on Pudge) is unverified.
- ckb-auth audit status is not stated in its README.
- No source found for a Halo2, STARK-native, or RISC Zero verifier deployed on CKB.

---

## 3. Bridges, wrapped assets and stablecoins on CKB today

### Takeaway
As of November 2026 there is no live trust-minimized or even custodial-committee bridge giving ETH or ADA exposure on CKB mainnet: Force Bridge is sunset (exit window ended 16 Jan 2026), USDI was discontinued by its issuer (retail exit via DestBridge until 15 Aug 2026), UTXO Stack wound down, and the Rosen Bridge integration (which would bring rsADA/rsERG-style assets and connect Cardano/Ethereum) is still pre-mainnet with open design issues. RUSD (Stable++) is the stablecoin still referenced by builders, but only as a testnet Fiber asset in the sources found.

### Cited Findings

**Force Bridge**
- [P] Magickbase announced the sunset of Force Bridge and Godwoken effective 1 Jun 2025; Force Bridge exit window ran 1 Jun 2025 to 30 Nov 2025, later extended to **16 Jan 2026**; after that, funds remain retrievable only by contacting Magickbase, possibly with a custodial fee. The page also carries a banner about "abnormal activity" and a precautionary pause. [STALE: Jun 2025 origin] — [Force Bridge sunset announcement](https://forcebridge-board.vercel.app/announcement)
- About $3M was drained from Force Bridge right after the sunset notice (reported 2 Jun 2025); funds were moved to Tornado Cash. [STALE: Jun 2025] — [The Block](https://www.theblock.co/news/defi/2025-06-02-hackers-drain-over-3-million-in-crypto-from-nervos-networks-force-cross-chain-bridge-say-security-analysts-356535)
- [F] phroi (27 Jun 2026): Force Bridge carried bridged USDT and USDC "for years, with less activity than USDI". — [USDI discontinuation thread](https://talk.nervos.org/t/usdi-on-ckb-will-be-discontinued-any-alternative-for-stablecoin/10417)

**USDI**
- [F] Issuer: IPN (Interpaystellar). Reserves "100% USDC at a 1:1 ratio" (initially STBT from Matrixport); mint/redeem only for KYC'd institutions via IPN against USDT/USDC, minimum $10,000; no direct fiat; retail route was DestBridge swapping USDI against Ethereum-side USDT. (IPN "ZOE" post 5 Mar 2026 and phroi quote 12 Mar 2026.) — [USDI on/off-ramp thread](https://talk.nervos.org/t/usdi-on-ramp-and-off-ramp-options-on-ckb/10021)
- [P] **"USDI on CKB will be discontinued; individual holders can swap via DestBridge until Aug 15, 2026"** (Biweekly Update #20, linking IPN's X post). — [Biweekly Update #20](https://talk.nervos.org/t/ckb-ecosystem-biweekly-update/9821); [IPN X post](https://x.com/IPN_Intelligent/status/2069601671731380351); community reaction in [discontinuation thread, 24-30 Jun 2026](https://talk.nervos.org/t/usdi-on-ckb-will-be-discontinued-any-alternative-for-stablecoin/10417)
- [P] Fiber's mainnet config and node docs still list USDI as the sole whitelisted UDT (not updated after the discontinuation). — [config/mainnet/config.yml](https://github.com/nervosnetwork/fiber/blob/develop/config/mainnet/config.yml)
- Launch context: IPN announced USDI in 2024 as an RGB++-based stablecoin tied to Fiber/UTXO Stack. [STALE: 2024] — [IPN press release](https://www.newsbtc.com/press-releases/ipn-leverages-rgb-to-launch-bitcoin-payment-network-and-stablecoin-usdi)

**RUSD / Stable++**
- Stable++ is an over-collateralized protocol on CKB (CKB and BTC collateral) issuing RUSD; docs list borrowing and 1 RUSD = $1 of collateral redemption. [STALE: 2024-25 docs, no 2026 status found] — [Stable++ GitBook](https://stablepp.gitbook.io/stable++); [Stable++ Medium](https://medium.com/@Stablepp/the-making-of-stable-e219b1806daf)
- [P] RUSD is the testnet UDT whitelisted on Fiber public nodes (124 testnet channels); it is not in the mainnet whitelist. — [docs/public-nodes.md](https://github.com/nervosnetwork/fiber/blob/develop/docs/public-nodes.md); [dashboard API](https://api-dashboard.fiber.channel/channel_count_by_asset?net=testnet)
- [F] 2026 builders still target RUSD: FiberNuts (RUSD-denominated Cashu ecash over Fiber, DAO vote to 11 Nov 2026), MoniMkt (RUSD-base lending market, testnet). — [FiberNuts DIS](https://talk.nervos.org/t/dis-fibernuts-reliable-cashu-over-fiber-payments-with-hosted-lsp-onboarding/11051); [MoniMkt](https://talk.nervos.org/t/spark-program-monimkt-hardening-and-beta-for-a-native-ckb-lending-market/11152)
- [F] Rosen integration lead excludes USDI, bridged USDC and RUSD from Rosen bridging because of issuer freeze/claw-back or upgradability risk (17 Apr 2026). — [Rosen DIS post 125](https://talk.nervos.org/t/dis-ckb-integration-for-rosen-bridge/9756/125)

**Other stablecoin directions**
- [F] matt_ckb (26-30 Jun 2026): effort is going toward bridged USDC/USDT and small issuers; native Circle/Tether issuance is "the real goal"; contact made with Open USD (Open Standard). LUSD v1 via Rosen suggested by phroi. — [discontinuation thread](https://talk.nervos.org/t/usdi-on-ckb-will-be-discontinued-any-alternative-for-stablecoin/10417)

**Wrapped BTC used with Fiber**
- [P] The only wrapped BTC seen on Fiber is **cWBTC, a testnet UDT** (12 testnet channels; used by ckb-on-ramp and CKBolt). No ccBTC/iBTC or any wrapped BTC is whitelisted on mainnet. — [dashboard API testnet](https://api-dashboard.fiber.channel/channel_count_by_asset?net=testnet); [ckb-on-ramp](https://talk.nervos.org/t/ckb-on-ramp-ckb/11050); [config/mainnet/config.yml](https://github.com/nervosnetwork/fiber/blob/develop/config/mainnet/config.yml)

**RGB++ and UTXO Stack**
- [P] RGB++ tooling is still maintained by CKB DevRel in 2026 (new SDK, asset manager, RGB++ Asset API rework, RGB++ Explorer revamp). — [Biweekly Updates #14-#24](https://talk.nervos.org/t/ckb-ecosystem-biweekly-update/9821)
- [P] In Nov 2026 the RGB++ Association published an "RGB++ Emergency Freeze & Security Incident Notice" (listed in Biweekly #28). Details not retrieved. — [Biweekly Update #28](https://talk.nervos.org/t/ckb-ecosystem-biweekly-update/9821); [X post](https://x.com/rgbppfans/status/2118807818572800283)
- [F] UTXO Stack "wound down" (matt_ckb, Aug 2026; a Sep 2026 thread asks how to restart "the previously closed UTXO Stack project"). — [Questions about CKBA](https://talk.nervos.org/t/questions-about-ckba/10471/11); [restart UTXO Stack thread](https://talk.nervos.org/t/utxo-stack/10724)
- [F] Spark-funded "Fiber RGB++ Swap" (convert a BTC-bound RGB++ asset to a CKB asset and swap via Fiber) had its funding terminated in Sep/Oct 2026 for scope deviations and insufficient testnet validation. — [Fiber RGB++ Swap](https://talk.nervos.org/t/spark-program-fiber-rgb-swap/10487); [Biweekly #26](https://talk.nervos.org/t/ckb-ecosystem-biweekly-update/9821)

**Rosen Bridge integration (the only planned path to Cardano/Ergo/Ethereum assets on CKB)**
- [F] DAO proposal by Sonami (phroi, Alive, Jordan Mack), posted 23 Dec 2025: $65,000; M1 plan Q1 2026, M2 testbed with zero-value tokens on CKB mainnet Q2 2026, M3 mainnet after review and external audit Q3-Q4 2026. Rosen is live for Cardano, Ergo, Ethereum, Binance, Dogecoin, Bitcoin (README adds Bitcoin Runes, Firo). — [Rosen DIS](https://talk.nervos.org/t/dis-ckb-integration-for-rosen-bridge/9756)
- [P] Integration repo states "Status: Work in progress" and that it "does not claim a completed integration"; custody is the default secp256k1-blake160 lock keyed to Rosen's threshold-ECDSA (TSS) guard key; bridged tokens are plain xUDT; rsADA/rsERG appear only as illustrations; only bearer assets without issuer freeze are eligible. — [sonami-tech/rosen-bridge-ckb-integration](https://github.com/sonami-tech/rosen-bridge-ckb-integration)
- [F] Latest status (7 Nov 2026): Rosen team reviewed and approved the plan except the node component (they require at least three public endpoints per chain rather than operator-run nodes); open guard-service issue about a single data provider letting a fake deposit reach quorum. — [Rosen DIS post 152](https://talk.nervos.org/t/dis-ckb-integration-for-rosen-bridge/9756/152)
- [F] Security model: Watchers (permissionless, stake RSN) and a federated Guard set signing with TSS; criticised in-thread as committee-based. — [Rosen DIS](https://talk.nervos.org/t/dis-ckb-integration-for-rosen-bridge/9756)

### Inferences
- There is currently no ETH or ADA representation on CKB mainnet that a swap could route through. Any ETH/ADA leg must settle natively on Ethereum/Cardano (HTLC, light-client proof, or solver model), not via a wrapped asset on CKB.
- With USDI gone and UTXOSwap closed, a "CKB to stablecoin on CKB, then bridge" route does not exist; the stablecoin side of any swap has to live on the foreign chain (for example USDC on an EVM chain).
- Rosen, if it ships, would give committee-secured (not trust-minimized) rsADA/rsETH-style assets and wrapped CKB on Cardano/Ethereum; it would be the first Cardano-CKB asset link in production, but timing has slipped past the original Q3-Q4 2026 target with design issues still open in Nov 2026.

### Gaps
- Stable++ mainnet status in 2026 (RUSD supply, whether minting is live) was not found; only testnet usage is evidenced.
- USDI circulating supply and exact wind-down terms (IPN's X post text) were not retrievable.
- Content of the Nov 2026 RGB++ emergency freeze notice was not retrievable; its impact on RGB++ assets is unknown.
- Rosen DAO vote result and milestone payment status were not captured (the thread shows work continuing through Nov 2026, which implies approval).
- No source found for iBTC/ccBTC being used on Fiber mainnet.

---

## 4. DEX liquidity on CKB L1

### Takeaway
There is no active DEX liquidity on CKB L1 in November 2026: UTXOSwap, the main intent-based AMM, shut down on 11 Oct 2026, and the remaining venue (Omiga) is described by community members as having no activity. A swap design cannot rely on on-chain CKB/stable price discovery or pools.

### Cited Findings
- [P] "UTXOSwap will shut down on Oct. 11, 2026, at 00:00 UTC+8. Pls remove all pool liquidity before the deadline." (Biweekly Update #25, 21 Sep 2026.) — [Biweekly Update #25](https://talk.nervos.org/t/ckb-ecosystem-biweekly-update/9821/29)
- [F] "UTXOSwap shut down last month … Force Bridge is gone … USDI has ended … as far as we could find, there is no live mainnet way to trade CKB against USDC, ETH, or Bitcoin without a custodian." (LusoCryptoLabs, 10 Nov 2026.) — [Swap book thread](https://talk.nervos.org/t/swap-book-trade-ckb-for-usdc-eth-or-bitcoin-with-no-custodian-testnet/11164)
- UTXOSwap design (historic): intent-based hybrid of off-chain order matching and on-chain AMM pool cells; pool creators could choose fee tiers; unfilled intents cost no gas. [STALE: 2024 litepaper] — [UTXOSwap litepaper](https://utxoswap.gitbook.io); [ChainCatcher](https://chaincatcher.com/en/article/2153765)
- A CKB/USDI pair was listed on UTXOSwap in July 2025 (CKB Weekly #188). [STALE: Jul 2025] — [CKB Weekly collection](https://talk.nervos.org/t/ckb-weekly/7306)
- [F] "There are some dexes, it's just that at the moment there's no activity" (omiga.io and utxoswap.xyz cited; 25 Apr 2026). Omiga launched an order-book marketplace in Apr 2024. — [CKB Kickstarter thread reply](https://talk.nervos.org/t/introducing-ckb-kickstarter-decentralized-all-or-nothing-crowdfunding-on-nervos-ckb-testnet-mvp-live/10130/8); [Omiga DIS](https://talk.nervos.org/t/dis-omiga-inscription-protocol-sponsorship-proposal-omiga-ckb/7615/103) [STALE: Jun 2024]
- [F] iCKB's CCC-based dApp, SDK and bot are live (Nov 2026); iCKB has its own limit-order mechanism for CKB/iCKB only. — [Biweekly Update #28](https://talk.nervos.org/t/ckb-ecosystem-biweekly-update/9821)
- Off-CKB: a CKB/USDC Meteora pool on Solana showed about $4.84 liquidity and no trading (search snapshot). — [DexPaprika](https://dexpaprika.com/solana/pool/CWxkA2wCUVxnomHKdrQZ1nsrxPNAu53jvmQjTZdfa3iW)
- [F] Proposed but not live: VibeSwap (commit-reveal batch auctions), Invisibook (privacy order-book appchain), MatchLock (Spark proposal, private-until-match bilateral settlement lock). — [VibeSwap](https://talk.nervos.org/t/vibe-swap-a-new-decentralized-exchange-giving-fair-price-discovery-as-a-human-right/9897); [MatchLock](https://talk.nervos.org/t/spark-program-matchlock-a-reusable-script-primitive-for-private-until-match-bilateral-settlement-on-ckb/11005)

### Inferences
- Pricing for any CKB swap must come from off-chain sources (CEX feeds or maker quotes); there is no on-chain CKB reference pool.
- The closure of UTXOSwap plus USDI plus Force Bridge within about 16 months leaves non-custodial CKB to ETH/USDC/BTC exchange as an open gap, which several teams started targeting in Sep-Nov 2026 (section 5).

### Gaps
- UTXOSwap's final volume, TVL and pool depth figures were not found; the reason for shutdown was not retrieved (the notice links only to the app).
- Omiga's current operational status and volume were not verified from a primary source.

---

## 5. Prior art: who has already proposed or built Fiber/CKB cross-chain swaps (what is NOT novel)

### Takeaway
Hash-locked atomic swaps between CKB and other chains, and Fiber-Lightning swaps, are already well-trodden in 2026: an L1 HTLC "swap book" for CKB against USDC/ETH on Base and BTC is live on testnet (10 Nov 2026), Perun has CKB-Ethereum cross-chain channel swaps on testnet, and at least four Fiber-Lightning CCH demos exist. What was not found anywhere: a Fiber-channel-based atomic swap to Ethereum, Cardano or Solana, any Fiber + Boltz or Fiber + Hydra work, or a proof-of-payment lock on CKB that verifies a foreign-chain payment for swap settlement. Light-client verification between CKB and Cardano (Chiral) and CKB-in-EVM (design notes) exist as 2026 research but target asset binding/bridging, not swaps.

### Cited Findings

**Direct overlaps (cross-chain swaps involving CKB, 2025-2026)**
- [F] **Swap book** (LusoCryptoLabs, 10 Nov 2026, testnet): P2P order book; each side locks in a hash-locked vault on its own chain with timeouts (initiator locks e.g. USDC on Base, counterparty locks CKB under the same hash with shorter timeout, secret reveal claims both). Pairs: USDC-CKB and ETH-CKB on Base Sepolia, BTC-CKB on Bitcoin testnet3. CKB side is the authors' own lock script (13 CKB-VM tests, 919 generated attack txs); Base side uses "Train's solver lock contract"; about 3 minutes per swap (5 Base confirmations, 10 CKB); takes capped at about $1; Cellula wallet only (one passkey signs CKB, Base, Bitcoin); a market-maker bot quotes about 2% off market. **Fiber is not used**; the post positions itself beside "the Cross-Chain Hub, CKBolt, Twine". No repo linked. — [Swap book](https://talk.nervos.org/t/swap-book-trade-ckb-for-usdc-eth-or-bitcoin-with-no-custodian-testnet/11164)
- [F] **Perun / PerunX**: CKB-Ethereum cross-chain asset swaps added in 2025 using one cross-chain state channel settled on both chains (no HTLCs or adaptor signatures; CKB contracts verify Ethereum ABI encoding, keccak256 and secp256k1). Assets ETH, CKB, xUSD, sUDT. PerunX on testnet; mainnet contract deployment said to be "a few weeks away" in the 31 Mar 2026 AMA. Repos perun-ckb-contract, perun-ckb-backend, go-perun. — [Perun AMA recap, 10 Apr 2026](https://talk.nervos.org/t/perun-channels-ama-questions-open/10128)
- [F] **Twine** (ebubedev, 23 Sep 2026, testnet PoC): P2P CKB-for-fiat desk using Fiber hold invoices as escrow, Nostr for orders, arbiter for disputes; buyer generates the preimage. Reviewer notes: SHA-256 vs Fiber default `ckb_hash` mismatch, outgoing expiry must be tied to the remaining hold. Repos chukwuma619/twine, twine_app, twine-fiber-poc. — [Twine](https://talk.nervos.org/t/twine-buy-and-sell-ckb-without-depositing-on-an-exchange-fiber-p2p-poc/10741)
- [F] **CKB as a Gateway of Cross-Chain DEX** (CDEX, 9 Mar 2025, concept only): HTLC "virtual vault", on-chain intention cells on CKB, solvers with slashable collateral, **SPV proofs from source/target chains verified on CKB**, insurance fund. No chains named, nothing built. [STALE: Mar 2025] — [CKB as a Gateway of Cross-Chain DEX](https://talk.nervos.org/t/ckb-as-a-gateway-of-cross-chain-dex/8673)

**Fiber to Bitcoin Lightning (same-preimage HTLC via CCH)**
- [P] Official CCH spec and RPCs (`send_btc`, `receive_btc`). — [cross-chain-htlc.md](https://github.com/nervosnetwork/fiber/blob/develop/docs/specs/cross-chain-htlc.md)
- [F] ckb-on-ramp (RetricSu, 26 Oct 2026, testnet): Lightning wallet to Fiber cWBTC via CCH hold invoice with the same payment hash; proposes JIT channels, refund-lock accounting, custom swap pricing. Repo RetricSu/ckb-on-ramp. — [ckb-on-ramp](https://talk.nervos.org/t/ckb-on-ramp-ckb/11050)
- [F] CKBolt (TEX Labs, 7 Nov 2026, testnet): browser Fiber node, swaps Lightning BTC into CKB or cWBTC on Fiber and back; plans Perun integration. — [CKBolt](https://talk.nervos.org/t/ckbolt-connecting-bitcoin-lightning-and-fiber-network-on-nervos-ckb/11144)
- [F] Self-hosted Fiber CCH Hub kit (ebubedev, 10 Aug 2026, testnet). Repo chukwuma619/fiber-cch-hub. — [CCH hub kit](https://talk.nervos.org/t/pay-lightning-with-fiber-a-self-hosted-cross-chain-hub-anyone-can-run/10599)
- [F] "Paying a Bitcoin Lightning Invoice with CKB UDT on Fiber" testnet demo (14 Jul 2026); Fiber Studio v1.1.0 advertises "cross-chain Lightning swaps". — [CCH demo](https://talk.nervos.org/t/paying-a-bitcoin-lightning-invoice-with-ckb-udt-on-fiber/10486); [Fiber Desktop DIS](https://talk.nervos.org/t/dis-fiber-desktop-v1-ground-up-rebuild-and-launch-fnn-desktop-app/10317)
- [F] LUME idea (Apr 2026) mentions Lightning-to-Fiber atomic swaps as a BTC entry path. — [LUME](https://talk.nervos.org/t/powerful-asset-complementing-ckb-and-btc-ai-generated-idea/10170)

**Submarine swaps / Loop (on-chain CKB to Fiber)**
- [P] Official Loop In/Out work: issue #1541 and draft PR #1643 with the `liquidity-lock` on-chain script (blake2b preimage + refund timeout). — [issue #1541](https://github.com/nervosnetwork/fiber/issues/1541); [PR #1643](https://github.com/nervosnetwork/fiber/pull/1643)
- Cryptape "Fiber Submarine Swap Product Design Reference" (Notion; content not readable). — [Notion](https://cryptape.notion.site/Fiber-Submarine-Swap-Product-Design-Reference-2af8f0d3781e8087b7c3f0b4c4f8a275)
- [F] Spark proposal "Fiber Submarine Swap Service" (TerroLabs, 21 Jul 2026): CKB on-chain to Fiber inbound liquidity, cites Boltz and Loop as models, no code; **rejected 1 Aug 2026** (identity verification and unclear technical plan). No cross-chain scope. — [Fiber Submarine Swap Service](https://talk.nervos.org/t/spark-program-fiber-submarine-swap-service/10516)
- [F] Liquid Cells: sub-61-CKB egress via Fiber atomic swaps is "roadmap, not shipped". — [Microtipping Part 2](https://talk.nervos.org/t/microtipping-on-ckb-part-2-keeping-the-magic-dropping-the-custody-meet-liquid-cells/10387)

**In-channel / RGB++ asset swaps and swap discovery**
- [F] Fiber swap quote board over gossip (Carl, 22 Sep 2026): discovery works on testnet; settlement "through CCH's lock-and-reveal, generalized to the new pair" is future work. Repos oxdev6/fiber-rgbpp-swap, oxdev6/fiber (branch feat/swap-advertisement). — [market board](https://talk.nervos.org/t/a-market-board-for-fiber-swaps-hubs-advertise-wallets-discover/10738)
- [F] Spark "Fiber RGB++ Swap" (Jul 2026): funding terminated. — [Fiber RGB++ Swap](https://talk.nervos.org/t/spark-program-fiber-rgb-swap/10487)

**Light-client / proof-based cross-chain verification (closest thing to "proof-of-payment")**
- [F] **Chiral** (T_Silva / LusoCryptoLabs; light paper 9 Jun 2026, open-sourced 25 Jun 2026, MIT, repo `LusoCryptoLabs/cardano-ckb-isomorphic`): committee-free Cardano-CKB binding. CKB verifies Cardano via Mithril certificate in CKB-VM (134-146M cycles) with a function `cardano_tx_is_certified`; Cardano verifies CKB via Groth16 over BLS12-381 of Eaglesong PoW + header MMR + CBMT inclusion (Aiken verifier). Full lock-verify-mint-burn-unlock round trip on Cardano preview and CKB Pudge; wrapped χADA on CKB and χCKB on Cardano described in replies. Unaudited, development trusted setup, coordinator-driven relayer, no liquidity. Not a swap protocol. — [Chiral light paper](https://talk.nervos.org/t/chiral-symmetric-isomorphic-binding-a-committee-free-anchor-agnostic-protocol-where-each-chain-verifies-the-other-with-a-succinct-on-chain-light-client/10360); [Chiral open source](https://talk.nervos.org/t/chiral-is-now-open-source-a-trust-minimized-cardano-and-nervos-ckb-port-for-you-to-review-break-and-test/10421)
- [F] Antismart's "verifying CKB state inside other chains (EVM-first, RFC 44/45)" design notes (11 Jun 2026): SP1 proof of Eaglesong + FlyClient for EVM; design-stage only; aimed at RGB++/xUDT liquidity on EVM, not swaps. — [design notes](https://talk.nervos.org/t/design-notes-verifying-ckb-state-inside-other-chains-evm-first-built-on-rfc-44-45/10372)
- [F] Luxvoid "BTC to CKB to EVM pipeline" (18 Jun 2026): Bitcoin SPV proofs verified on CKB testnet, effects on EVM testnets; $150k DAO ask, no repo, no vote recorded. — [Luxvoid](https://talk.nervos.org/t/dis-luxvoid-protocol-the-first-working-btc-ckb-evm-pipeline-seeking-dao-support-collab-for-production-scaling/10400)
- [F] TapFiber (Spark, 31 Oct 2026): "Fiber payment intent and verifiable receipt reference" binding merchant orders to invoices; receipts are application-level, not on-chain proofs. — [TapFiber](https://talk.nervos.org/t/spark-program-tapfiber-fiber-payment-intent-and-verifiable-receipt-reference/11079)

**Searches that returned nothing**
- Nervos Talk search for "Boltz OR submarine" combined, "cardano hydra fiber", "Hydra Cardano", "Solana atomic swap", "hold invoice cross-chain", and "adaptor signature swap" (beyond Perun's statement that it does not use them) returned no Fiber-to-Ethereum/Cardano/Solana channel-swap proposals, no Fiber + Boltz integration and no Fiber + Hydra proposal. — [Nervos Talk search](https://talk.nervos.org/search?q=fiber%20atomic%20swap)
- Fiber team statement: "There's no plans to support other channels" beyond Lightning via lnd. — [AMA recap](https://talk.nervos.org/t/the-fiber-network-ama-recap/10294)

### Inferences
- Not novel: (a) plain HTLC atomic swap of L1 CKB against EVM assets or BTC (Swap book, testnet, Nov 2026); (b) Fiber hold-invoice escrow patterns (Twine); (c) Fiber-Lightning same-preimage swaps (CCH and four demos); (d) on-chain-to-Fiber submarine swaps (official Loop work); (e) Cardano-CKB mutual light clients (Chiral); (f) SP1-proved CKB PoW for EVM (design notes).
- Apparently still novel on Nervos Talk / Fiber GitHub as of 12 Nov 2026: an atomic swap where the CKB leg is a **Fiber channel payment** (SHA-256 hold invoice) and the other leg is an HTLC/escrow on Solana, Ethereum or Cardano; any Fiber-to-Hydra or Fiber-to-Boltz-style EVM submarine swap; and a CKB lock that releases funds against a verified foreign-chain payment proof.
- The fastest reuse path to native ETH is the same pattern Swap book uses (an existing audited EVM HTLC/solver-lock contract such as Train's, SHA-256 hashlock shared with a Fiber hold invoice or a CKB L1 HTLC). For native ADA, no existing CKB-facing piece was found other than Chiral's research code; a Cardano HTLC (Plutus/Aiken, SHA-256) paired with the Fiber hold invoice would be the analogous minimal approach.
- Reviewer comments on Twine (hash algorithm mismatch, outgoing expiry tied to remaining hold) and the CCH expiry rules (outgoing expiry less than half of incoming) are directly reusable design constraints for any Fiber cross-chain swap.

### Gaps
- Swap book has no public repo, so its CKB lock script and hash function could not be inspected; "Train's solver lock contract" was not independently examined.
- PerunX mainnet status after April 2026 is unknown.
- X/Twitter, Discord and Telegram discussions were not searchable; proposals made only there would be missed.
- The doitian "Fiber Swaps" Raindrop collection returned 404.

---

## 6. UTXO Alliance and the 2021 Nervos-Cardano Force Bridge announcement: what was delivered

### Takeaway
The Nervos-Cardano Force Bridge announced in June 2021 was never delivered: development was handed from Mousebelt to Obsidian Systems, reached a pull request under review (force-bridge PR #235, Dec 2021), was described as "about 80% complete" but stopped in June 2022, and was confirmed paused in September 2022. The UTXO Alliance (announced Sept 2021) produced no identifiable shared bridge, standard or tooling; the only later Cardano-CKB links are the community Rosen integration (pre-mainnet) and the Chiral research prototype (testnet).

### Cited Findings
- [P] 27 Sep 2021 (matt_ckb): the six-week estimate from Mousebelt (June 2021) was a mistake; Obsidian Systems engaged; no dates. Oct-Dec 2021: Obsidian built a TypeScript library for Cardano multisig, monitoring of Force Bridge addresses, and submitted **force-bridge PR #235** (under review 3 Dec 2021; no merge reported). 9 Jun 2022 (ericatnervos): "about 80% complete" but production stopped temporarily; 13 Sep 2022 (matt_ckb): work paused, talking to potential bridge partners. No testnet or mainnet launch ever reported. [STALE: 2021-22] — [Update on Nervos<>Cardano bridge project](https://talk.nervos.org/t/update-on-nervos-cardano-bridge-project/6181); [force-bridge PR #235](https://github.com/nervosnetwork/force-bridge/pull/235)
- [P] Force Bridge itself (Ethereum/BSC to CKB, committee-based) launched on mainnet in Oct 2021 and was sunset in 2025-26 (section 3). [STALE] — [Force Bridge mainnet launch, Oct 2021](https://www.crowdfundinsider.com/2021/10/181718-nervos-introduces-cross-chain-force-bridge-on-mainnet/); [sunset page](https://forcebridge-board.vercel.app/announcement)
- UTXO Alliance: announced at the Cardano Summit (Sept 2021) by IOHK with Ergo, Nervos and Topl; Komodo, Alephium and DigiByte joined later. Stated aims were interoperability and UTXO research; founders listed existing tech (Plutus, ErgoScript, CKB-VM, Antara). [STALE: 2021] — [IOG announcement](https://www.iog.io/news/utxo-alliance-fostering-innovation-and-collaboration-across-the-blockchain-space); [Ergo blog, 26 Sep 2021](https://ergoplatform.org/blog/2021-09-26-the-utxo-alliance/)
- [P] Nervos knowledge-base page (9 Apr 2023) lists members Nervos, Horizen Labs, Wolfram Blockchain Labs, IOHK, DigiByte, Ergo, Topl and names **no concrete deliverables** (no bridge, standard or shared tooling). [STALE: Apr 2023] — [What is the UTXO Alliance](https://www.nervos.org/knowledge-base/what_is_the_utxo_alliance)
- The most concrete funded output found is a Project Catalyst Fund 11 grant ($25,000) for a "UTXO Alliance content manager" (education/content). [STALE] — [Project Catalyst](https://projectcatalyst.io/funds/11/cardano-open-ecosystem/utxo-alliance-content-manager)
- [F] Rosen Bridge (Ergo-origin, live for Cardano and Ergo) is the current community route to connect CKB with Cardano/Ergo; Yeti argues its main benefit is reaching Ergo and Cardano users. Still pre-mainnet in Nov 2026. — [Rosen DIS](https://talk.nervos.org/t/dis-ckb-integration-for-rosen-bridge/9756)
- [F] Chiral (2026) is the only working Cardano-CKB mutual-verification code found, on testnets. — [Chiral open source](https://talk.nervos.org/t/chiral-is-now-open-source-a-trust-minimized-cardano-and-nervos-ckb-port-for-you-to-review-break-and-test/10421)

### Inferences
- Nothing from the 2021 Cardano bridge effort or the UTXO Alliance is reusable infrastructure today; there is no Cardano custody script, relayer or token on CKB mainnet from that era.
- A native-ADA swap out of CKB therefore starts from zero on the Cardano side apart from Cardano's own primitives (Plutus/Aiken HTLCs, BLS builtins, Mithril) and the Chiral testnet code.

### Gaps
- Whether force-bridge PR #235 was ever merged, and the final state of the Obsidian Cardano code, was not checked on GitHub (API rate limit reached).
- No formal close-out report from the UTXO Alliance was found; current activity (an "UTXO Alliance 2026" space listing exists) was not investigated.

# Existing solver / liquidity networks a CKB swap could plug into (state as of 12 Nov 2026)

Conventions used below:
- **[V]** = verified this session against a primary source (protocol docs, protocol API, protocol repo, governance forum) fetched on 2026-11-12.
- **[S]** = secondary source only (news, vendor blog, search-engine summary of a page I did not open). Treat as unconfirmed.
- **[PK]** = from prior knowledge, not re-verified this session; only appears under Inferences/Gaps.
- Live API/doc fetches have no publication date; the retrieval date is 2026-11-12.

---

## 1. NEAR Intents (ex-Defuse): architecture, chains, chain-signature curves, onboarding, fees, volume, distribution

### Takeaway
NEAR Intents is the only large solver network that already has live native ETH, SOL and ADA (Cardano since 30 Sep 2025, via the custodial PoA bridge), and CKB is not listed anywhere in its docs or its live 1Click token list. The NEAR MPC signer signs an arbitrary caller-supplied 32-byte digest with secp256k1 ECDSA and returns a recoverable signature, so an MPC-controlled CKB address is cryptographically feasible with no NEAR-side change, but listing CKB in the product (bridge indexer, `*.omft.near` token, 1Click, solver quotes) is a curated decision by the Intents/bridge operators with no published permissionless procedure.

### Cited Findings

**Architecture and custody**
- [V] Settlement is one contract, `intents.near` ("Verifier") on NEAR mainnet; it holds user/solver balances as NEP-245 multi-token balances and settles matched intents atomically; no public testnet deployment (as summarised from the docs' bridging overview) — [NEAR Intents docs, bridging overview](https://docs.near-intents.org/integration/bridging/overview)
- [V] Three bridges feed the Verifier, each with "its own trust model"; on withdrawal the protocol "selects the appropriate bridge based on the destination chain" — [bridging overview](https://docs.near-intents.org/integration/bridging/overview)
  - **PoA Bridge** (`poa_bridge`): "Proof of Authority consensus model"; chains: Ethereum, Base, Arbitrum, Gnosis, Berachain, Bitcoin, BCH, Litecoin, Dogecoin, Solana, XRP, Zcash, Tron, Sui, Aptos, **Cardano**, Starknet.
  - **Omni Bridge** (`omni_bridge`): Ethereum, Base, Arbitrum, BNB, Solana, Bitcoin.
  - **HOT Bridge** (`hot_bridge`): BNB, Polygon, Optimism, Avalanche, Scroll, Monad, TON, Stellar, LayerX, Adi, Plasma.
- [S] The PoA bridge "depends on a third party to custody assets"; a Defuse technical overview says deposits/withdrawals will move from PoA to Omni Bridge over time for networks Omni supports (search-summary of the Notion page; not opened) — [Defuse technical overview (Notion)](https://defuse.notion.site/Technical-overview-of-NEAR-Intents-1bdf8a584c7c808b97c4e566ba1be28d)
- [S] Omni Bridge uses Chain Signatures (MPC); "Omnibridge v2 makes it ... simple to add new networks"; its roadmap lists chain integrations as an area for outside contribution — [NEAR docs, Omni Bridge how it works](https://docs.near.org/chain-abstraction/omnibridge/how-it-works), [Omni Bridge roadmap](https://docs.near.org/chain-abstraction/omnibridge/roadmap)
- [V] Cardano is served only by the PoA bridge (i.e. the federated/custodial one) — [bridging overview](https://docs.near-intents.org/integration/bridging/overview)

**Supported chains, November 2026**
- [V] Live 1Click token list (fetched 2026-11-12) has ~229 tokens across 39 `blockchain` values: near, eth, sol, base, bsc, aptos, pol, gnosis, arb, avax, hood, op, aleo, hypercore, miden, plasma, starknet, monad, xlayer, bera, movement, scroll, stellar, sui, ton, tron, btc, abs, adi, bch, **cardano**, dash, doge, fogo, ltc, prl, qtc, xrp, zec (counts hand-tallied by the fetch tool; could be off by one) — [1Click `/v0/tokens`](https://1click.chaindefuser.com/v0/tokens)
- [V] Native assets present: ETH = `nep141:eth.omft.near`, SOL = `nep141:sol.omft.near`, ADA = `nep141:cardano.omft.near` — [1Click `/v0/tokens`](https://1click.chaindefuser.com/v0/tokens)
- [V] **No token with symbol CKB and no blockchain value `ckb`/`nervos`** in the 1Click list — [1Click `/v0/tokens`](https://1click.chaindefuser.com/v0/tokens)
- [V] The docs' chain/address-support page lists Cardano as "Partially supported" (Shelley base and enterprise addresses only); Zcash transparent-only; Nervos/CKB not listed; page says the list is "continuously expanding" and points to Telegram for updates — [chain address support](https://docs.near-intents.org/near-intents/chain-address-support)
- [S] Cardano went live on NEAR Intents on 30 Sep 2025 (NEAR tweet reported 1 Oct 2025); the `cardano.omft.near` contract had been spotted on 30 Jul 2025 — [The Crypto Basic, 2025-10-01](https://thecryptobasic.com/2025/10/01/users-can-now-swap-cardano-across-20-chains-hoskinson-reacts/)
- [S] "more than $30 billion in all-time volume across 35 chains" (late Sep 2026) and Nansen "35+ blockchains" (Q2 2026) — [Nansen NEAR Q2 2026 report](https://nansen.ai/post/nansen-near-quarterly-report-q2-2026). The exact URL for the $30B/35-chain statement was not pinned (surfaced only in a search summary).

**Chain Signatures (MPC) — what it can sign**
- [V] `sign` on `v1.signer` takes `request = { payload_v2, path, domain_id }`. `payload_v2` is either `{"Ecdsa": <hex 32 bytes>}` or `{"Eddsa": <hex 32..1232 bytes>}`; "the signed message is the 32-byte ECDSA payload, used without further hashing"; the ECDSA payload read as a scalar must be < the secp256k1 field size p — [near/mpc contract README](https://raw.githubusercontent.com/near/mpc/main/crates/contract/README.md)
- [V] `domain_id` 0 = Secp256k1, 1 = Ed25519 — [NEAR docs, Chain Signatures](https://docs.near.org/chain-abstraction/chain-signatures)
- [V] ECDSA response = `big_r`, `s` (low-s normalised), `recovery_id`; validity is checked by recovering the key and comparing with `derived_public_key(path, predecessor, domain_id)` — [near/mpc contract README](https://raw.githubusercontent.com/near/mpc/main/crates/contract/README.md)
- [V] Cost: deposit of at least 1 yoctoNEAR (excess refunded); ~7 Tgas used, ≥10 Tgas must be attached — [near/mpc contract README](https://raw.githubusercontent.com/near/mpc/main/crates/contract/README.md)
- [V] Schemes in the MPC repo: OT-based ECDSA (secp256k1, Cait-Sith-derived), Robust ECDSA (secp256k1), EdDSA (Ed25519, FROST), plus BLS12-381 Confidential Key Derivation; nodes run in TEEs; a "foreign chain transaction verification"/Read-RPC feature has nodes verify transactions on chains "such as Ethereum, Solana, and Aptos" and threshold-sign the observation — [github.com/near/mpc](https://github.com/near/mpc)
- [V] New signing domains are added by `vote_add_domains`; all current participants must vote — [near/mpc contract README](https://raw.githubusercontent.com/near/mpc/main/crates/contract/README.md)
- [V] Signatures are not bound to a network unless the payload encodes it; use distinct derivation paths per chain — [NEAR docs, Chain Signatures](https://docs.near.org/chain-abstraction/chain-signatures)

**Fees**
- [V] Protocol fee: 0.0001% (1 pip ≈ 0.01 bps) per transaction, collected on-chain by `intents.near` to `fee_collector` — [NEAR Intents docs, fees](https://docs.near-intents.org/near-intents/fees)
- [V] 1Click Swap API fee, on top of the protocol fee: 25 bps with no API key; 20 bps with an API key and no `appFees` (1 bp for stablecoin pairs USDC/USDT/DAI and same-asset multichain routes); with `appFees` the integrator fee is split 50/50 with 1Click, 1Click keeping at least 20 bps (1 bp on stable/same-asset routes); custom agreements exist — [fees](https://docs.near-intents.org/near-intents/fees)
- [V] Quote-improvement fee: if a cross-asset swap fills better than quoted, the improvement is split 50/50 — [fees](https://docs.near-intents.org/near-intents/fees)
- [V] near-intents.org front end charges 0.2% on swaps (to `fefundsadmin.sputnik-dao.near`); 0.1% withdrawal fee for NEAR, ZEC and STRK sent to Solana — [fees](https://docs.near-intents.org/near-intents/fees)
- [V] Solver spread is not documented on the fees page — [fees](https://docs.near-intents.org/near-intents/fees)

**Volume and revenue**
- [S] All-time volume: $5B Nov 2025 → $10B Jan 2026 → $20B early Jun 2026 — [Crypto Briefing, "NEAR Intents surpasses $20B"](https://cryptobriefing.com/near-intents-20b-transaction-volume/)
- [S] ~$29.3B cumulative and ~$842M trailing 7-day (21 Sep 2026); >$30B (29 Sep 2026). URL not pinned (search summary only); nearest opened-title source is the $20B milestone above.
- [S] Cumulative fees ≈ $32–34.4M at ~$20B volume (≈16 bps blended take); SwapKit reported as generating $26.6M of the $34.4M (June 2026). URL not pinned (search summary only) — candidate: [Raptor Group, State of NEAR Q2 2026](https://www.raptorgroup.com/news/the-state-of-near-q2-2026/)
- [S] Fee switch activated 23 Feb 2026, intent fees funding NEAR buybacks (attributed to DefiLlama) — [DefiLlama NEAR revenue streams](https://defillama.com/pro/near-revenue-streams-jjx5g0)

**Distribution partners**
- [S] SwapKit (NEAR Intents provider; falls back to THORChain / Maya / Chainflip when NEAR Intents cannot fill) — [SwapKit NEAR Intents integration](https://swapkit.dev/blog/swapkit-near-intents-integration/)
- [S] SwapKit activated Cardano, Dash, Starknet and XLayer on its NEAR-Intents provider in Jan 2026 (Q1 2026 update) — [SwapKit update](https://swapkit.dev/?p=4239)
- [S] Ledger (via SwapKit) — [SwapKit: Ledger NEAR Intents](https://swapkit.dev/blog/ledger-near-intents-integration-swapkit/); THORWallet — [THORWallet blog](https://www.thorwallet.org/thorwallet-blog/thorwallet-integrates-near-intents-expanding-cross-chain-swaps-offering-to-additional-networks); Aurora Intents widget — [The Defiant press release](https://thedefiant.io/news/press-releases/aurora-labs-releases-intents-widget-making-near-intents-easy-to-embed-in-any-app); CoW Swap's Solana expansion with NEAR Intents backend — [pulse.bot summary](https://www.pulse.bot/crypto/news/cow-swap-expands-to-solana-with-near-intents-backend-support-cd15797e-54a3-4b27-bc7f-be6e3e6034e2/); Brave Wallet (search summary; URL not pinned).

**CKB status**
- [V] No CKB in the docs or the live token list (see above). [S] Searches for "Nervos/CKB + NEAR Intents / chain signatures / SwapKit" returned no proposal, request or announcement on either side.

### Inferences
- **MPC-controlled CKB address is feasible without NEAR-side changes (cryptography only).** CKB's default lock verifies a recoverable secp256k1 signature over a 32-byte blake2b sighash [PK]; the NEAR signer signs any caller-supplied 32-byte digest without re-hashing and returns `(r, s, recovery_id)` [V], which is exactly the 65-byte form CKB needs. The "payload < p" restriction rejects a blake2b digest with probability ~2^-224, i.e. never in practice. The CKB address is the blake160 of the derived compressed public key [PK], which is deterministic per `(predecessor, path)`.
- **What is NOT free:** (a) a NEAR contract that builds/validates CKB transactions and tracks live cells; (b) a way for NEAR to learn that a CKB deposit happened — either a CKB light client on NEAR (CKB PoW with Eaglesong; none exists [PK]) or the MPC network's "foreign chain transaction verification", which today names Ethereum/Solana/Aptos and would need MPC-node changes for CKB; (c) the product layer: a `ckb.omft.near`-style token, 1Click listing, and at least one solver willing to quote CKB.
- **Realistic onboarding path = PoA bridge listing by the Intents team**, as was done for Cardano, Zcash, Dogecoin, etc. This is a business-development decision, not a permissionless one; it is custodial (PoA) on the CKB leg.
- A self-built route that needs no approval: run your own NEAR bridge contract that controls a CKB address via `v1.signer`, mint an NEP-141 for CKB, and deposit it into `intents.near` (the Verifier accepts standard NEAR token deposits [PK]); you would still have to recruit a solver to quote the CKB pair, so it does not remove the liquidity-recruitment problem, only narrows it to "one market maker who already quotes ETH/SOL/ADA on NEAR Intents".
- All-in cost for majors (ETH/SOL/ADA) via an integrator with an API key is roughly: solver spread (unpublished) + 20 bps 1Click + ~0 protocol + destination network fee; ~25 bps + spread without a key; +20 bps on the near-intents.org UI. The blended ~16 bps historical take rate [S] is consistent with this.

### Gaps
- No published, primary "how to add a chain" procedure for NEAR Intents/PoA bridge; the PoA bridge API doc URL I tried returned 404 (https://docs.near-intents.org/near-intents/market-makers/poa-bridge-api). Who operates the PoA signers and the signer set size were not confirmed from a primary source.
- Solver spreads on ADA/SOL/ETH and a solver count are not published; I did not pull live 1Click quotes (would be the definitive all-in cost check).
- The exact date-stamped source for "$30B / 35 chains" and "SwapKit $26.6M of fees" was not opened.
- MPC node count / threshold not stated in docs (readable from `v1.signer` `state`).

---

## 2. THORChain, Maya Protocol, Chainflip: chains, adding a UTXO chain, fees, any CKB proposal

### Takeaway
All three are validator-vault (threshold-signature) AMMs where adding a chain is a governance plus core-engineering project (new chain client, node daemon on every validator, audits, liquidity bootstrapping in the native token pair); none supports CKB and no CKB proposal was found. THORChain has native SOL (since 26 Feb 2026) but not ADA; Maya's Cardano support is still reported as in development; Chainflip has SOL/ETH/BTC but no Cardano.

### Cited Findings

**THORChain**
- [V] New-chain process, Phase I: proposal in the `#propose-a-chain` Discord channel using a Chain Proposal Template (chain type, hardware requirements, year started, market cap, CMC rank, 24h volume, DEX integrations, prior hard forks); node operators vote via Mimir (`Halt<Chain>Chain = 1`); "50%+ consensus" lets development proceed. Chains must be "economically meaningful, decentralised, and technically sound" — [THORChain dev docs, New Chain Integration Process](https://dev.thorchain.org/new-chains/new-chain-process.html)
- [V] Phase II: write a Bifrost ChainClient under `/bifrost/pkg/chainclients/<chain>` modelled on the UTXO, EVM or BFT reference clients; PRs to `thornode` and `node-launcher`; ≥70% unit-test coverage; stagenet minimums of 100 inbound txs, 100 outbound txs, 100 RUNE of adds and 100 RUNE of withdrawals; an independent expert audit published in the PR; live walkthrough with the dev team — [New Chain Integration Process](https://dev.thorchain.org/new-chains/new-chain-process.html)
- [V] Phase III: admin Mimir halts chain, node operators install the new daemon, scanning enabled, then trading enabled at chain tip — [New Chain Integration Process](https://dev.thorchain.org/new-chains/new-chain-process.html)
- [S] A chain must not be controlled by a single entity that can pause the network or freeze accounts; the new chain connects when 67% of nodes run the new software — [THORChain dev docs, Adding New Chains](https://dev.thorchain.org/protocol-development/adding-new-chains.html) (search summary; older page)
- [S] Solana went live on THORChain on 26 Feb 2026 in a phased rollout, native SOL only at launch — [The Crypto Times, 2026-02-27](https://www.cryptotimes.io/2026/02/27/solana-goes-live-on-thorchain-enabling-native-cross-chain-swaps/), [Gem Wallet](https://gemwallet.com/learn/gem-wallet-launches-native-solana-swaps-via-thorchain)
- [S] Q1 2026 quarterly report lists Cardano, Polygon, Sui and Zcash as still in progress; EdDSA signing (needed for Solana/Cardano) shipped in v3.8 (Jul 2025) — [THORChain Q1 2026 report](https://blog.thorchain.org/thorchain-quarterly-report-q1-2026)
- [S] No CKB/Nervos proposal surfaced in any search of THORChain material.

**Maya Protocol (THORChain fork)**
- [S] SwapKit's Maya page: Cardano integration "actively in development"; ~8 chains; non-core additions include Arbitrum, Kujira, Radix, Dash, Zcash — [SwapKit Maya page](https://swapkit.dev/maya-protocol/)
- [S] Catalyst Fund 11 proposal for Maya–Cardano noted Maya had only integrated ECDSA chains and needed refactors for EdDSA; original delivery target May 2024 — [Project Catalyst F11 proposal](https://projectcatalyst.io/funds/11/cardano-open-developers/maya-protocol-supercharge-cardano-with-decentralized-native-cross-chain-swaps)
- Conflict: one search summary (of THORChain-related results) asserted Cardano is "natively supported on Maya"; the SwapKit page says in development. I found no primary confirmation that ADA is live on Maya. Treat as **not confirmed live**.

**Chainflip**
- [V] Supported chains (8): Ethereum, Bitcoin, Arbitrum, Polkadot, Solana, Assethub, Tron, BSC. Assets (21): ETH, USDC, USDT, WBTC, cbBTC, FLIP on Ethereum; ETH, USDC, USDT on Arbitrum; BTC; DOT; SOL, USDC, USDT on Solana; DOT, USDC, USDT on Assethub; TRX, USDT on Tron; BNB, USDT on BSC. BSC and cbBTC were added in v2.3 — [Chainflip docs, chains & assets](https://docs.chainflip.io/protocol/supported-chains-assets/chains-assets)
- [V] "distributed, permissionless, proof-of-stake system run by 150 Validators"; FROST threshold signatures; per-chain vault designs — [Chainflip docs](https://docs.chainflip.io/)
- [S] Tron added at protocol level in v2.2; new chains arrive through protocol (runtime) upgrades — [Chainflip v2.2 blog](https://chainflip.io/blog/chainflip-v2-2-release-tron-lending-2.0-and-oracle-based-stablecoin-strategies), [Chainflip roadmap](https://chainflip.io/roadmap-v2)
- [V] No Cardano and no CKB in the chain list — [chains & assets](https://docs.chainflip.io/protocol/supported-chains-assets/chains-assets)

### Inferences
- For CKB, THORChain/Maya are the most plausible of the three technically (GG20 ECDSA over secp256k1 is their native scheme and CKB only needs a 32-byte-digest signature [PK]), but CKB's cell model is not Bitcoin-UTXO-compatible, so the "UTXO reference client" cannot be reused as-is: a new Bifrost client, a CKB full node on every validator, an external audit, and a node vote are needed. THORChain's criteria (market cap, CMC rank, volume) make a CKB vote uncertain; Maya, with a lower bar, would be the likelier venue.
- THORChain/Maya/Chainflip liquidity is pooled against the protocol asset (RUNE/CACAO) or USDC; even after technical integration, someone must seed a CKB pool — the liquidity-recruitment problem is not avoided.
- Chainflip uses FROST (Schnorr) vaults; a chain whose default lock expects ECDSA would need a custom Schnorr-verifying lock script on CKB (CKB can do this in script [PK]) plus core runtime work by Chainflip Labs; not a community-addable integration.
- Timeline heuristics: THORChain took from 2025 scoping to Feb 2026 for Solana, and Cardano is still pending; Maya's Cardano has been "coming" since 2024. A CKB integration would realistically be a multi-quarter effort dependent on those core teams.

### Gaps
- Fee/slippage models were not re-fetched from primary docs this session. [PK]: THORChain/Maya charge a slip-based liquidity fee (depth-dependent, reducible with streaming swaps) plus an outbound fee and optional affiliate fee; Chainflip charges a network fee plus LP fee tier, broker fee and ingress/egress fees. Verify against docs.thorchain.org and docs.chainflip.io before quoting numbers.
- THORChain "Evaluating New Chains" numeric thresholds not retrieved.
- Maya's current chain list and Cardano status need a primary check (docs.mayaprotocol.com / mayanode).

---

## 3. Meson and the bridge/aggregator long tail: is CKB supported, and is the route custodial?

### Takeaway
Meson is the only non-custodial cross-chain swap network found that has a live CKB L1 deployment, but it only lists ccBTC on CKB (no native CKB, no stablecoin). LI.FI and Rango do not list CKB (or Cardano); the services that do quote native CKB today (StealthEX, ChangeNOW, Changelly, Xgram, SimpleSwap-style) are instant exchangers that take custody in transit.

### Cited Findings

**Meson**
- [V] Meson's relayer API lists network `ckb` ("CKB", chainId `ckb:mainnet`), contract/"network address" `0x5c010079ef2e7d1480d0d2b6e4652f7a215847b05b9bfff15cf5916e3cd6225e`, with a single token: **ccBTC** (8 decimals, `0x68e64ba4b0daeeec45c1f983d6d574fca370442cafb805bc4265ef74870a4ac8`) — [Meson relayer API `/api/v1/list`](https://relayer.meson.fi/api/v1/list)
- [V] Same API: Solana lists USDC, USDT, PYUSD, USD1, xBTC, SOL; Ethereum lists USDC, USDT, PYUSD, USD1, ETH, WBTC; Bitcoin lists BTC; **no Cardano network** — [Meson relayer API](https://relayer.meson.fi/api/v1/list)
- [S] July 2024 press release: Meson is the "designated cross-chain bridge for the CKB Eco Fund", supporting ccBTC on CKB mainnet; Meson described as an atomic-swap bridge for BTC, ETH and stablecoins — [AAP press release](https://aap.com.au/?p=184859)
- [V] Fees: service fee 0.05% of the swap amount, minimum $0.5, same for all networks and pairs (the page's intro says "0.5%" in one place, an internal inconsistency); currently waived per address per day for the first $3,000 or 3 swaps; LP fees are market-set, "most LPs charge 0 on most routes", up to ~1% on some; $0.1 surcharge under $5; all fees deducted on the target chain — [Meson docs, fee](https://docs.meson.fi/protocol/meson/fee)
- [S] Mechanism: HTLC-style atomic swap between user and LP (swap process doc not opened) — [Meson docs, swap process](https://docs.meson.fi/protocol/meson/process)

**Aggregators / routers**
- [V] LI.FI chains API (69 chains): EVM ×64, UTXO = Bitcoin and Zcash only, Solana, Sui, Tron. **No Nervos/CKB, no Cardano** — [LI.FI `/v1/chains`](https://li.quest/v1/chains?chainTypes=EVM,SVM,UTXO,MVM,TVM)
- [V] Rango integrations page: EVM, Cosmos, Bitcoin, BCH, Dash, Doge, Litecoin, Solana, Tron, Starknet, TON, Sui. **No Nervos/CKB, no Cardano** listed (page may lag the live API) — [Rango docs, integrations](https://docs.rango.exchange/integrations)
- [S] SwapKit: FAQ says 30+ chains incl. Cardano (via NEAR Intents); no mention of CKB in any SwapKit page surfaced — [SwapKit FAQ](https://swapkit.dev/faqs/)
- [S] Rubic's Best Rate Finder integrates Houdini Swap and other providers; CKB support not confirmed — [Rubic docs, ecosystem](https://docs.rubic.finance/rubic/overview/ecosystem)
- [S] StealthEX lists Nervos Network (CKB) pairs (BTC, LTC, USDC, USDT-TRC20, …); self-described "non-custodial", no registration; swap cost = network fee plus charges from its "liquidity partners"; no published percentage — [StealthEX CKB page](https://stealthex.io/coin/nervos-network)
- [S] ChangeNOW lists CKB — [ChangeNOW from-nervos-network](https://changenow.io/from-nervos-network); Changelly lists CKB pairs incl. ETH and USDC-Base — [Changelly CKB pairs](https://changelly.com/exchange-pairs/ckb); Xgram lists ETH→CKB — [Xgram](https://xgram.io/en/coins/eth/ckb)
- [S] Celer cBridge historically supported Nervos **Godwoken** (EVM L2), not CKB L1 — [cBridge Godwoken page](https://cbridge.celer.network/bridge/nervos%20godwoken-binance/)

**Nervos-side bridge work relevant to ADA/ETH**
- [V/S] "[DIS] CKB Integration for Rosen Bridge" (Community Fund DAO): requests $65,000 (27,356,903 CKB) to add CKB to Rosen Bridge, ETA Q3–Q4 2026; preliminary vote passed with 64.11% approval, 515,967,370 CKB voting weight, later confirmed by the committee (from search summary of thread posts 114/115; thread not opened in full) — [talk.nervos.org thread 9756](https://talk.nervos.org/t/dis-ckb-integration-for-rosen-bridge/9756)
- [S] An earlier version (2024–25) asked $80k with a Q2 2025 ETA: "Rosen Bridge - Connecting CKB to Cardano, Ergo, and Beyond" — [talk.nervos.org thread 8539](https://talk.nervos.org/t/dis-rosen-bridge-connecting-ckb-to-cardano-ergo-and-beyond/8539)

### Inferences
- Meson already runs an HTLC-swap contract (lock script) and LP infrastructure on CKB L1, so the engineering to settle against CKB cells exists inside Meson. Extending it from ccBTC to native CKB or a CKB-issued stablecoin is a Meson business decision plus LP inventory, not new protocol R&D. This makes Meson the lowest-friction "existing LP network" conversation for a CKB swap, with the caveat that Meson is a same-asset (stablecoin/BTC/ETH) transfer network, not a cross-asset one: a CKB→ETH/SOL swap would be "CKB → (DEX on CKB) → bridged asset → Meson → ETH/SOL-side asset → DEX". Meson has no Cardano leg.
- "Non-custodial" as used by instant exchangers (StealthEX, ChangeNOW, SimpleSwap, Changelly) means "no account balance"; the user still sends coins to a deposit address controlled by the service or its upstream liquidity partner, so it is custodial in transit and not trust-minimised. Houdini routes through such exchangers by design [PK].
- An aggregator listing (LI.FI, Rango, SwapKit, Rubic, Squid) follows an underlying bridge/DEX; none will list CKB until some provider they integrate (NEAR Intents, THORChain/Maya, Chainflip, Meson, or an instant exchanger) quotes it. Getting onto NEAR Intents would transitively reach SwapKit/Ledger/THORWallet-type distribution.
- Rosen Bridge would give CKB a wrapped-asset route to Cardano/Ergo/Bitcoin/Ethereum-family chains, but it is a mint/burn bridge with watcher/guard sets, not a liquidity network: it does not by itself provide ADA↔CKB price liquidity.

### Gaps
- Whether Meson's CKB/ccBTC route currently has LP liquidity (the list shows configuration, not depth), since when exactly it has been live, and whether Meson has stated plans for native CKB or a CKB stablecoin: not found.
- **Not checked against a primary source (no evidence either way):** Owlto, Orbiter, Symbiosis, Squid, Houdini, Rubic, Chainge, Bridgers, SwapKit's live token list. Searches surfaced nothing linking any of them to CKB L1. Owlto/Orbiter are EVM/rollup-focused [PK], so CKB support is unlikely.
- Rosen Bridge CKB delivery status (milestones paid, mainnet date) not confirmed; the vote date reported by a CMC AI digest (10 Jan 2026) is secondary.
- Force Bridge (Nervos↔Ethereum) current operational status not verified this session.
- Instant-exchanger all-in cost on CKB pairs is embedded in the rate and unpublished; one review cites ChangeNOW partner revenue share of 0.4% (secondary, URL not pinned). Needs live quote sampling.

---

## 4. 1inch Fusion+, UniswapX, CoW, Across, deBridge DLN, Relay: solver onboarding and whether an outside chain can be an origin

### Takeaway
Solver/resolver access ranges from gated (1inch: stake/whitelist moving to due-diligence + Resolver NFT; CoW: KYC plus bonding pool; Relay: a single trusted solver) to capital-only (Across relayers, deBridge takers, UniswapX fillers). In every case the origin chain needs the protocol's own escrow/settlement contract deployed and supported by the protocol's backend, so CKB cannot be an origin without protocol-side work.

### Cited Findings
- [S] **1inch Fusion / Fusion+**: resolvers must stake 1INCH for Unicorn Power, register in the whitelist, set a worker address and fund the FeeBank; only the top 10 resolvers by Unicorn Power can fill; minimum threshold cited as 5% (help centre) or 10% (blog) of total Unicorn Power — sources conflict — [1inch Fusion FAQ](https://help.1inch.com/en/articles/6800254-1inch-fusion-faq), [1inch blog](https://1inch.com/blog/post/fusion-mode-swap-resolving)
- [S] 1inch governance thread "[1RC] Update to Resolver Access Requirements for Fusion Order Flow" (1IP-89): would remove the 5% staking threshold and make access depend on "successful completion of the due diligence verification process and issuance of the corresponding Resolver NFT"; whether it passed/is live was not confirmed — [gov.1inch.network thread 836](https://gov.1inch.network/t/1rc-update-to-resolver-access-requirements-for-fusion-order-flow/836)
- [V per search summary of official docs] **CoW Protocol**: staged onboarding — shadow competition → "KYC checks and onboarding call" → staging competition → production; solvers entering via the CoW DAO bonding pool start on Arbitrum first, and a fee applies six months after joining the pool — [CoW docs, solver onboarding](https://docs.cow.fi/cow-protocol/tutorials/solvers/onboard)
- [V per search summary of official docs] **Relay**: "the Relay solver is a production-grade relayer currently supporting Relay"; the current state "requires trust in Relay's solver" — i.e. no open third-party solver set — [Relay docs, the Relay solver](https://docs.relay.link/how-it-works/the-relay-solver)
- [V] **Across**: relayer docs describe running the open-source relayer; it fills deposits "when your token balances permit"; repayment is via root bundles "published every 1.5 hours minimum" on a repayment chain of the relayer's choice; supported relayer tokens WETH, USDC, DAI, USDT, WBTC, UMA, ACX, BAL, SNX, POOL; a separate "Relayer Nomination" page covers exclusive-relayer nomination. The page does not state KYC/whitelist/bond requirements — [Across docs, running a relayer](https://docs.across.to/relayers/running-a-relayer)
- [S] Across: any address can fill; relayer fronts destination funds and is reimbursed after a UMA optimistic-oracle window — [eco.com, Across solver architecture](https://eco.com/support/en/articles/14799839-across-protocol-solver-architecture-deep-dive)
- [S] **UniswapX**: fillers can accept and submit orders without permission — [LD Capital on Medium](https://ld-capital.medium.com/uniswapx-pioneering-the-uniswap-v4-defi-experimental-hub-6491ac51a03d)
- [S] **deBridge DLN**: zero-TVL design; solvers ("takers") front their own capital per order; winning solver fills 15–90 s after order creation — [eco.com, deBridge DLN explained](https://eco.com/support/en/articles/14800733-debridge-cross-chain-liquidity-network-explained)

### Inferences
- "Outside chain as origin without protocol changes": not possible for any of the six. Across needs a SpokePool on the origin chain plus inclusion in UMA-verified bundles; deBridge needs DlnSource plus its validator set observing the chain; UniswapX/CoW need Reactor/Settlement contracts (EVM, plus CoW's Solana path through NEAR Intents); Relay needs its depository contract and its own solver indexing the chain; 1inch Fusion+ needs escrow (HTLC) contracts and relayer/API support per chain. All were designed EVM-first; non-EVM additions (Solana, Bitcoin, Tron) were made by the core teams [PK].
- 1inch Fusion+ is the structurally closest fit to CKB + Fiber because it is hashlock/timelock escrow-based [PK]; a CKB HTLC lock is straightforward, but resolvers are a gated set and 1inch would have to add CKB to its order API. No evidence 1inch has considered it.
- For a CKB project, the gated networks (1inch, CoW, Relay) are not places you can "plug in"; the capital-only ones (Across, deBridge) only help on the far side (e.g. moving USDC between Ethereum/Solana/Base after leaving CKB).

### Gaps
- Primary confirmation of UniswapX filler/RFQ-quoter requirements, deBridge taker requirements, CoW bond size, and the outcome of 1IP-89 was not obtained.
- No statement found from any of these six protocols about CKB, Nervos or Cardano as a supported origin.

---

## 5. Solver-side economics: hedging, rebalancing, spreads, fill times

### Takeaway
Primary, quantitative disclosure of solver economics is thin; what exists is mostly vendor commentary. The consistent picture is spread-per-fill of low single-digit bps on stablecoin routes, rebalancing and inventory cost priced into every quote, and fills in seconds to ~1.5 minutes; for majors on NEAR Intents the integrator-level take is ~16–25 bps before solver spread.

### Cited Findings
- [S] Solver P&L decomposes into spread captured per fill, cross-chain rebalancing cost, cost of capital tied up in inventory, and MEV/routing edge; stablecoin-route spreads put at roughly 1–8 bps per fill (the same article's break-even arithmetic is internally inconsistent) — [eco.com, solver netting](https://eco.com/support/en/articles/12160293-what-is-solver-netting-how-intents-skip-bridge-hops)
- [S] Fill times: Across median "under 15 seconds" on supported routes in 2025 / "often under 30 seconds" for correlated pairs; 5–30 s cited for Across+, Eco Routes and UniswapX on correlated stablecoin pairs — [eco.com, intent-based bridging vs traditional bridges 2026](https://eco.com/support/en/articles/15264362-intent-based-bridging-vs-traditional-bridges-2026-architecture-compared)
- [S] deBridge: fills 15–90 s after order creation depending on destination block time; a solver either waits for reverse-direction flow (cheap) or bridges back by another route (gas plus spread), and "expected rebalancing cost gets priced into every solver bid" — [eco.com, deBridge DLN explained](https://eco.com/support/en/articles/14800733-debridge-cross-chain-liquidity-network-explained)
- [V] Across relayers are repaid through root bundles published at least every 1.5 hours, on a chain of their choosing, which is the built-in rebalancing lever; the relayer software includes inventory management that rebalances tokens across chains — [Across docs, running a relayer](https://docs.across.to/relayers/running-a-relayer)
- [S] Solvers source from CEX order books, DEX pools, OTC desks and own inventory — [Xochi whitepaper](https://xochi.fi/whitepaper/); solvers hedge the taken position off-chain to stay delta-neutral (IntentX, perps context) — [Carbon Terminal on Medium](https://medium.com/@CarbonTerminal/a-deep-dive-into-trader-and-solver-orderflow-on-intentx-7d4faa4679cb)
- [V] NEAR Intents 1Click captures half of any price improvement over the quote within ~30 minutes, i.e. quotes carry a buffer that is partly clawed back by the API layer rather than the user — [NEAR Intents fees](https://docs.near-intents.org/near-intents/fees)
- [S] NEAR Intents blended fee take ≈ 0.16% of volume (≈$32M fees on ≈$20B) — search summary; see section 1.
- [V] Circle CCTP Standard transfer is free and Fast is 1–14 bps (see section 6), which bounds a solver's USDC rebalancing cost between CCTP chains — [Circle CCTP fees (cctp-go mirror)](https://www.mintlify.com/circlefin/cctp-go/concepts/fees)

### Inferences
- A solver can only quote an asset it can (a) hold inventory of on the chain, (b) hedge, and (c) rebalance. For CKB: (b) is available on CEXs that list CKB spot and perps [PK], but (c) has no cheap trust-minimised rail (no CCTP, no canonical USDC/USDT on CKB L1 [PK]); rebalancing means CEX deposit/withdrawal of CKB with on-chain confirmations. That pushes a rational solver's CKB spread well above the 1–8 bps seen on stablecoin routes; long-tail spreads of tens of bps to >1% should be expected, comparable to what instant exchangers embed today.
- Fiber does not change solver inventory economics by itself, but HTLC settlement over Fiber (as with the Lightning cross-chain hub) removes on-chain confirmation latency on the CKB leg, reducing the solver's price-risk window and thus the spread component attributable to volatility.
- Because spread on the CKB leg is the dominant cost, the cheapest design is to make the CKB leg as short as possible: CKB → stable/BTC-pegged asset on CKB via a local DEX/RFQ, then ride an existing low-bps rail.

### Gaps
- No primary dataset found (Dune/DefiLlama/academic) with per-asset solver spreads for majors vs long-tail on NEAR Intents, Across, deBridge or Relay; no primary disclosure of named market makers' (e.g. Wintermute) hedging practices or fill-time distributions. The eco.com articles are vendor content from a competing intent protocol.
- No data found on any market maker's willingness to quote CKB on a solver network.

---

## 6. The "stablecoin shuttle" pattern and its published costs

### Takeaway
Stablecoin-only cross-chain legs are now priced at roughly 0–15 bps (CCTP Standard 0, CCTP Fast 1–14 bps, NEAR Intents 1Click 1 bp + ~0 protocol, Meson 5 bps service fee often waived, Across ~5–8 bps effective, Stargate 1–6 bps disputed), so the cost of a shuttle design is dominated by the DEX legs at each end. None of these rails terminates on CKB L1 with a stablecoin today; Meson reaches CKB only with ccBTC.

### Cited Findings
- [S→primary mirror] Circle CCTP V2: Standard Transfer has no fee; Fast Transfer costs 1–14 bps depending on source chain, deducted from the amount received; other sources quote 1 bp from Ethereum and Solana, 1.3 bps from Base and OP Mainnet, 13 bps from Linea; Fast attestation in ~8–20 s — [Circle CCTP fees (cctp-go docs mirror)](https://www.mintlify.com/circlefin/cctp-go/concepts/fees), [eco.com, What is CCTP](https://eco.com/support/en/articles/15483238-what-is-cctp-circle-s-cross-chain-usdc-protocol)
- [S] Across: 0% protocol fee; cost is relayer + LP spread, estimated ~5–8 bps effective on a $500k transfer — [eco.com, cross-chain bridge fees 2026](https://eco.com/support/en/articles/15197981-cross-chain-bridge-fees-2026-every-major-bridge-compared)
- [S] Stargate: one source says 6 bps on every non-STG transfer (4 treasury / 1 veSTG / 1 LP) plus a rebalancing fee; another lists 1 bp — conflicting — [eco.com fee comparison](https://eco.com/support/en/articles/15197981-cross-chain-bridge-fees-2026-every-major-bridge-compared), [spark.money stablecoin bridge comparison](https://www.spark.money/tools/stablecoin-bridge-comparison)
- [V] Meson: 0.05% service fee (min $0.5), waived for the first $3,000 or 3 swaps per address per day; LP fee mostly 0, up to ~1% on some routes; fees taken on the target chain — [Meson docs, fee](https://docs.meson.fi/protocol/meson/fee)
- [V] NEAR Intents 1Click: 1 bp on stablecoin pairs (USDC, USDT, DAI) and same-asset multichain routes with an API key, plus 0.0001% protocol fee — [NEAR Intents fees](https://docs.near-intents.org/near-intents/fees)
- [V] Meson stablecoin coverage relevant here: Ethereum (USDC, USDT, PYUSD, USD1), Solana (USDC, USDT, PYUSD, USD1), Tron (USDT), many L2s; CKB has ccBTC only; no Cardano — [Meson relayer API](https://relayer.meson.fi/api/v1/list)
- [V] Chainflip also carries USDC/USDT on Ethereum, Arbitrum, Solana, Tron, BSC — [Chainflip chains & assets](https://docs.chainflip.io/protocol/supported-chains-assets/chains-assets)

### Inferences
- A shuttle for CKB→ETH/SOL would be: CKB → pegged asset on CKB (local DEX or RFQ; the expensive leg) → cross-chain leg → native ETH/SOL via 1inch/Jupiter-class DEX (≈ 5–30 bps for majors [PK]). The only existing non-custodial cross-chain leg out of CKB L1 is Meson's ccBTC (BTC-pegged, not a stablecoin), so "CKB → ccBTC on a CKB DEX → Meson → BTC/WBTC/xBTC on Ethereum/Solana → ETH/SOL" is the one route that could be assembled from live parts today, subject to ccBTC/CKB DEX depth and Meson LP depth, both unverified.
- For ADA the shuttle breaks at the far end: Meson, CCTP, Across, Stargate and Chainflip have no Cardano leg; NEAR Intents (PoA bridge) is the only large network settling native ADA, and Rosen Bridge is the planned direct CKB↔Cardano link.
- Getting a CKB-native stablecoin (or a bridged USDC/USDT) listed on Meson's CKB deployment would convert the BTC-pegged shuttle into a true stablecoin shuttle at ≈0–5 bps for the cross-chain leg.

### Gaps
- USDT0 fee schedule: no bps figure found. Primary Circle fee table (developers.circle.com) not opened directly; figures come from an SDK-docs mirror and secondary articles.
- Which stablecoins exist on CKB L1/Fiber in Nov 2026 (e.g. RUSD via Stable++, any Fiber-native USD asset) and their DEX depth: outside this research scope and not verified here.
- Liquidity depth of ccBTC on CKB DEXs (e.g. UTXOSwap) not checked.

---

## 7. Who quotes CKB today (decentralised or solver networks), and CKB-side proposals

### Takeaway
No decentralised solver/intents network or validator-vault DEX quotes native CKB as of 12 Nov 2026; the only live non-custodial cross-chain swap rail touching CKB L1 is Meson with ccBTC. Native CKB cross-chain quotes come only from custodial-in-transit instant exchangers, and CKB-side work is limited to a 2025 concept post, the Fiber↔Lightning HTLC hub, and the funded Rosen Bridge integration.

### Cited Findings

| Network | Quotes native CKB? | Evidence | Fee |
|---|---|---|---|
| NEAR Intents | No [V] | [1Click tokens](https://1click.chaindefuser.com/v0/tokens), [chain support](https://docs.near-intents.org/near-intents/chain-address-support) | n/a |
| THORChain | No (not among reported chains; no proposal found) [S] | [Q1 2026 report](https://blog.thorchain.org/thorchain-quarterly-report-q1-2026) | n/a |
| Maya | No evidence [S] | [SwapKit Maya page](https://swapkit.dev/maya-protocol/) | n/a |
| Chainflip | No [V] | [chains & assets](https://docs.chainflip.io/protocol/supported-chains-assets/chains-assets) | n/a |
| Meson | **ccBTC on CKB only**, not native CKB [V] | [relayer API](https://relayer.meson.fi/api/v1/list) | 0.05% service (waived ≤$3k/day) + LP fee (mostly 0) [V] [fee doc](https://docs.meson.fi/protocol/meson/fee) |
| LI.FI | No [V] | [chains API](https://li.quest/v1/chains?chainTypes=EVM,SVM,UTXO,MVM,TVM) | n/a |
| Rango | No [V, docs page] | [integrations](https://docs.rango.exchange/integrations) | n/a |
| SwapKit | No evidence [S] | [FAQ](https://swapkit.dev/faqs/) | n/a |
| StealthEX | Yes, custodial in transit [S] | [CKB page](https://stealthex.io/coin/nervos-network) | embedded in rate, unpublished |
| ChangeNOW | Yes, custodial in transit [S] | [CKB page](https://changenow.io/from-nervos-network) | embedded in rate |
| Changelly | Yes, custodial in transit [S] | [CKB pairs](https://changelly.com/exchange-pairs/ckb) | embedded in rate |
| Xgram | Yes, custodial in transit [S] | [ETH→CKB](https://xgram.io/en/coins/eth/ckb) | "small fee", unpublished |

- [V] Nervos Talk, "CKB as a Gateway of Cross-Chain DEX" (posted by CDEX, 9 Mar 2025): proposes HTLC "virtual vaults", ownerless intention cells on CKB, solvers with slashable pledges, SPV proofs of source/target-chain events, and an insurance fund as backstop LP; names no specific chains; in reply (10 Mar 2025) the author says it is exploratory ("explore the feasibility and potential value"). No build status or follow-up in the thread — [talk.nervos.org/t/8673](https://talk.nervos.org/t/ckb-as-a-gateway-of-cross-chain-dex/8673)
- [S] Fiber docs describe a Cross-Chain Hub bridging Fiber and Bitcoin Lightning with HTLCs (page marked work in progress) — [Fiber docs, cross-chain HTLC](https://fiber-docs-9gt8fjy92-ckba-team.vercel.app/docs/res/cross-chain-htlc); Cryptape design reference for Fiber submarine swaps (on-chain CKB ↔ Fiber channel) — [Cryptape Notion](https://cryptape.notion.site/Fiber-Submarine-Swap-Product-Design-Reference-2af8f0d3781e8087b7c3f0b4c4f8a275); Fiber Studio v1.1.0 reported to enable Lightning swaps — [getmidas.com](https://www.getmidas.com/midasin-kulaklari/nervos-network-fiber-studio-v1-1-0-ile-bitcoin-lightning-takaslarini-etkinlestirdi-p-698860)
- [V/S] Rosen Bridge CKB integration funded by the Community Fund DAO ($65k, ETA Q3–Q4 2026) — [talk.nervos.org/t/9756](https://talk.nervos.org/t/dis-ckb-integration-for-rosen-bridge/9756)
- [S] No search result links Nervos/CKB to NEAR Intents, chain signatures, THORChain, Maya, Chainflip, SwapKit, 1inch, Across, deBridge or Relay.

### Inferences
- Ranking of "plug-in" options for a CKB swap by how much third-party cooperation they need:
  1. **Meson (already on CKB)** — ask for native CKB or a CKB stablecoin to be listed; smallest technical delta; same-asset only; no Cardano.
  2. **NEAR Intents via PoA bridge** — the only network with live native ETH + SOL + ADA and proven appetite for UTXO/long-tail chains (Zcash, Doge, Dash, Litecoin, BCH, Cardano); needs the Intents team to add a CKB bridge leg and at least one solver to quote; custodial bridge leg; brings SwapKit/Ledger-class distribution.
  3. **NEAR chain-signatures self-build** — cryptographically ready today (32-byte digest ECDSA), no permission needed for the MPC part, but deposit verification and solver recruitment remain.
  4. **THORChain/Maya** — node vote + new Bifrost client + audit + pool bootstrapping; multi-quarter; ADA not yet live there anyway.
  5. **Chainflip, 1inch Fusion+, Across, deBridge, Relay, CoW/UniswapX** — require core-team protocol work and/or gated solver sets; not realistic as a first integration.
- Since every instant exchanger quoting CKB ultimately sources from CEX order books [PK], a non-custodial CKB route only "beats" them if the CKB leg spread plus a ≤25 bps intent/bridge fee is below their embedded margin (typically ~0.5–1%+ for long-tail pairs [PK]); the comparison needs live quote sampling on both sides.

### Gaps
- No live-quote sampling was done (NEAR Intents 1Click quote for ETH/SOL/ADA pairs; StealthEX/ChangeNOW/SimpleSwap CKB quotes), so "typical all-in cost" figures are fee-schedule-based, not measured.
- Unknown whether any private conversations exist between Nervos/Cryptape and NEAR Intents, Meson (beyond ccBTC) or market makers; nothing public was found.
- UTXO-stack ecosystem DEX depth (CKB/ccBTC, CKB/stablecoin) and Fiber liquidity-provider availability were out of scope and are needed to price the CKB leg.
- Owlto, Orbiter, Symbiosis, Squid, Houdini, Rubic, Chainge, Bridgers: no primary check performed; absence of search evidence is not proof of absence.

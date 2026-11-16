# Ethereum / EVM rails for a Fiber (SHA-256 hold invoice) <-> ETH hash-locked swap — state as of 2026-11-12

Research date: 2026-11-11/12. "Measured" = values I read live from public RPC/API endpoints on that date (method given). Anything not confirmed from a primary source is flagged. Fiber-side constraint used throughout: Fiber invoices/TLCs accept only `ckb_hash` (default) or `sha256` as `HashAlgorithm`, and a hold invoice is an invoice created with `payment_hash` and no preimage, settled later via `settle_invoice` — [Fiber RPC README, develop branch](https://raw.githubusercontent.com/nervosnetwork/fiber/develop/crates/fiber-lib/src/rpc/README.md).

## 1. Boltz Exchange: EtherSwap / ERC20Swap contracts (boltz-core)

### Takeaway
Boltz's `EtherSwap` (v6) is the closest thing to a ready-made, SHA-256, native-coin HTLC on EVM: `sha256(preimage)` hashlock, block-height timelock (a timestamp variant exists in the repo), stateless-per-swap storage, and a `claim` overload that any third party (relayer) can submit with funds going to the designated `claimAddress`. BUT Boltz the service is down: EVM swaps were disabled 2026-08-01 citing "a bug in its EVM integration", all swaps were suspended 2026-08-03 "until further notice", the web-app's mainnet config still has `swapsSuspended: true`, no audit of the EVM contracts was found, and the only deployment I could confirm on-chain is Arbitrum One (not Ethereum L1, Base or Optimism). Treat it as reusable MIT-licensed code to self-deploy, not as a live liquidity network.

### Cited Findings
Contract mechanics (source read 2026-11-12, `master` branch)
- `EtherSwap` declares `uint8 public constant VERSION = 6;` pragma `^0.8.33`, MIT — [EtherSwap.sol](https://github.com/BoltzExchange/boltz-core/blob/master/contracts/EtherSwap.sol)
- Hashlock is SHA-256 of a 32-byte preimage: `bytes32 preimageHash = sha256(abi.encodePacked(preimage));` — [EtherSwap.sol](https://github.com/BoltzExchange/boltz-core/blob/master/contracts/EtherSwap.sol)
- Timelock is absolute block height: `require(timelock <= currentTime(), SwapNotTimedOut());` with `currentTime()` returning `block.number` — [EtherSwap.sol](https://github.com/BoltzExchange/boltz-core/blob/master/contracts/EtherSwap.sol)
- A timestamp variant exists: `contract EtherSwapTimestamp is EtherSwap { function currentTime() internal view override returns (uint256) { return block.timestamp; } }` (and `ERC20SwapTimestamp.sol`) — [EtherSwapTimestamp.sol](https://github.com/BoltzExchange/boltz-core/blob/master/contracts/EtherSwapTimestamp.sol)
- Lock signatures: `lock(bytes32 preimageHash, address claimAddress, uint256 timelock) payable`; `lock(bytes32 preimageHash, address claimAddress, address refundAddress, uint256 timelock) payable`; `lockPrepayMinerfee(bytes32 preimageHash, address payable claimAddress, uint256 timelock, uint256 prepayAmount) payable` — [EtherSwap.sol](https://github.com/BoltzExchange/boltz-core/blob/master/contracts/EtherSwap.sol)
- Claim signatures: `claim(bytes32 preimage, uint256 amount, address refundAddress, uint256 timelock)` (claimAddress = `msg.sender`); `claim(bytes32 preimage, uint256 amount, address claimAddress, address refundAddress, uint256 timelock)` (public, no `msg.sender` check, pays `claimAddress`); `claim(..., uint8 v, bytes32 r, bytes32 s)` (EIP-712 `Claim(bytes32 preimage,uint256 amount,address refundAddress,uint256 timelock,address destination)` signed by claimAddress, pays `msg.sender` i.e. a router/relayer); `claimBatch(...)` — [EtherSwap.sol](https://github.com/BoltzExchange/boltz-core/blob/master/contracts/EtherSwap.sol)
- Refund signatures: `refund(bytes32 preimageHash, uint256 amount, address claimAddress, uint256 timelock)` (refundAddress = `msg.sender`, only after timelock); `refundCooperative(bytes32 preimageHash, uint256 amount, address claimAddress, uint256 timelock, uint8 v, bytes32 r, bytes32 s)` (before timelock, needs EIP-712 `Refund(...)` signature from `claimAddress`) — [EtherSwap.sol](https://github.com/BoltzExchange/boltz-core/blob/master/contracts/EtherSwap.sol)
- Events: `Lockup(bytes32 indexed preimageHash, uint256 amount, address indexed claimAddress, address indexed refundAddress, uint256 timelock)`, `Claim(bytes32 indexed preimageHash, bytes32 preimage)`, `Refund(bytes32 indexed preimageHash)`; swap state is one mapping keyed by `hashValues(preimageHash, amount, claimAddress, refundAddress, timelock)` — [EtherSwap.sol](https://github.com/BoltzExchange/boltz-core/blob/master/contracts/EtherSwap.sol)
- `Router` (`VERSION = 2`) atomically claims from EtherSwap/ERC20Swap then executes arbitrary calls (DEX swap), with OFT (LayerZero) and CCTP send variants and Permit2 — [Router.sol](https://github.com/BoltzExchange/boltz-core/blob/master/contracts/Router.sol)
- Deployment is a plain `new EtherSwap()` / `new ERC20Swap()` / `new Router(etherSwap, erc20Swap, permit2)` with no constructor owner/admin — [Deploy.sol](https://github.com/BoltzExchange/boltz-core/blob/master/contracts/script/Deploy.sol)
- boltz-core README mentions only "the Solidity `EtherSwap`/`ERC20Swap` ABIs"; no audits, no deployment addresses; license MIT; `package.json` version 5.0.0 — [boltz-core README](https://github.com/BoltzExchange/boltz-core)

Deployments confirmed on-chain (measured 2026-11-12)
- Arbitrum One Router `0x812A4ede94cA28390e05c807A26A9118B5C952A6` (address published in Bitcoin Magazine's 2026-03-18 launch article); `VERSION()` returns 2 — [Bitcoin Magazine](https://bitcoinmagazine.com/business/boltz-exchange-launches-atomic-usdt-swaps-for-lightning-network-users), [Arbiscan](https://arbiscan.io/address/0x812A4ede94cA28390e05c807A26A9118B5C952A6)
- Router `SWAP_CONTRACT()` = EtherSwap `0xc09247f837a205bdde43960ca01bdea426f1370e`, `version()` = 6, 6,233 bytes of runtime code; `ERC20_SWAP_CONTRACT()` = ERC20Swap `0x6398b76df91c5ebe9f488e3656658e79284ddc0f`, `version()` = 6 (read by `eth_call` against a public Arbitrum RPC) — [Arbiscan EtherSwap](https://arbiscan.io/address/0xc09247f837a205bdde43960ca01bdea426f1370e), [Arbiscan ERC20Swap](https://arbiscan.io/address/0x6398b76df91c5ebe9f488e3656658e79284ddc0f), RPC used: [publicnode Arbitrum](https://arbitrum-one-rpc.publicnode.com)
- The same EtherSwap address has no code on Ethereum L1, Base, Optimism or Rootstock (`eth_getCode` = empty on each) — RPCs: [Ethereum](https://ethereum-rpc.publicnode.com), [Base](https://base-rpc.publicnode.com), [Optimism](https://optimism-rpc.publicnode.com), [Rootstock](https://public-node.rsk.co)

Gas (measured 2026-11-12 by `eth_simulateV1` on Ethereum L1 at block 26,393,521, injecting the Arbitrum EtherSwap v6 runtime bytecode via state override; amount 0.01 ETH) — RPC: [publicnode Ethereum](https://ethereum-rpc.publicnode.com)
- `lock(bytes32,address,uint256)`: 47,417 gas used (eth_estimateGas limit 47,802)
- `claim(bytes32,uint256,address,uint256)` by the claimAddress itself: 32,244 gas used (estimate 39,485)
- `claim(bytes32,uint256,address,address,uint256)` submitted by an unrelated third-party address: succeeds, ETH is transferred to `claimAddress`; 34,975 gas when claimAddress already exists, 59,987 gas when claimAddress is a never-used empty account (new-account surcharge) (estimates 42,256 / 67,130)
- `refund(bytes32,uint256,address,uint256)` after timelock: 31,367 gas used (estimate 38,595)

Pairs, architecture, service status
- Boltz launched USDT swaps 2026-03-18: Lightning sats -> tBTC (atomic Boltz swap) -> USDT0 via DEX, combined by the Arbitrum Router in one transaction; "Gas abstraction removes the need for ETH on Arbitrum"; planned (not live at launch) expansion to on-chain BTC, Liquid, Rootstock, Arkade, and Tron/Solana via USDT0 Legacy Mesh — [Bitcoin Magazine, 2026-03-18](https://bitcoinmagazine.com/business/boltz-exchange-launches-atomic-usdt-swaps-for-lightning-network-users)
- EVM-side assets Boltz had live before shutdown: USDT, USDC, WBTC, TBTC, RBTC (these are the ones disabled on 2026-08-01) — [crypto.news, 2026-08-04](https://crypto.news/boltz-halts-swaps-as-ai-attacks-outpace-its-team/)
- 2026-08-01: Boltz disabled EVM swaps citing a bug in its EVM integration; 2026-08-03: all swaps suspended; quotes: "Update: Boltz will stay disabled until further notice. Our API remains available to process refunds cooperatively." and "unilateral refunds will work, as they do not depend on our infrastructure." No incident report or vulnerability list published — [crypto.news, 2026-08-04](https://crypto.news/boltz-halts-swaps-as-ai-attacks-outpace-its-team/), [TFTC, 2026-08-04](https://www.tftc.io/boltz-bitcoin-swaps-suspended-ai-attacks), [Boltz X post](https://x.com/Boltzhq/status/2084311537502630319)
- Boltz statement: "Over the past months we have seen a steady rise in automated, AI-assisted probing of our infrastructure"; "Do not expect swap services to resume shortly"; TVL about $180,860 (DeFiLlama) at announcement — [TFTC, 2026-08-04](https://www.tftc.io/boltz-bitcoin-swaps-suspended-ai-attacks)
- Web-app `main` branch mainnet config contains `swapsSuspended: true` ("Replaces the landing page and the swap box with the suspension notice; Refunds, rescues and pending swaps stay reachable") — [boltz-web-app mainnet.ts](https://github.com/BoltzExchange/boltz-web-app/blob/main/src/configs/mainnet.ts), [base.ts](https://github.com/BoltzExchange/boltz-web-app/blob/main/src/configs/base.ts)
- Web-app config type allows only `network: "mainnet" | "regtest"` and links a regtest repo; it also configures a `gasSponsor` endpoint (`https://sponsor.ccxp.space/`) — [boltz-web-app base.ts](https://github.com/BoltzExchange/boltz-web-app/blob/main/src/configs/base.ts)
- UNCONFIRMED (single aggregator, page returned HTTP 403 to me; seen only via search summary): kycnot.me reports that on 2026-08-08 Boltz announced transferring ownership/administration to an undisclosed group and that the website was down as of mid-October 2026 — [kycnot.me](https://kycnot.me/service/boltz)
- From my environment on 2026-11-12, `boltz.exchange`, `api.boltz.exchange`, `docs.boltz.exchange`, `blog.boltz.exchange` and `api.docs.boltz.exchange` all failed DNS resolution while other hosts resolved; I cannot tell whether this is the domain being down or a local resolver issue — attempted: [api.boltz.exchange/v2/chain/contracts](https://api.boltz.exchange/v2/chain/contracts)
- Rootstock integration historically used RIF Relay for gasless claims (title only, article not fetched) — [Rootstock blog](https://rootstock.io/blog/boltz-integrates-rif-relay-to-simplify-bitcoin-layer-swaps/)

### Inferences
- Hash compatibility with Fiber is exact: Fiber `sha256` hold invoice hash == EtherSwap `preimageHash` for a 32-byte preimage. No adapter needed.
- Permissionless reuse: the contract has no owner, whitelist or Boltz signature requirement on `lock`/`claim`/`refund` (only `refundCooperative` and the signature-claim need counterparty signatures). My simulation of the deployed v6 bytecode confirms an arbitrary address can lock and an arbitrary relayer can claim on behalf of `claimAddress`. So a third party can use the Arbitrum deployment for its own swaps, or redeploy the MIT code on L1/Base/OP.
- Zero-ETH recipient is solved at the contract level: the LP (or any relayer) who learns the preimage when the Fiber hold invoice settles can itself call the 5-argument `claim`; ETH lands at the user's address. No EIP-7702 or paymaster is required.
- Risk flag: Boltz attributed the 2026-08-01 shutdown to an unspecified "bug in its EVM integration". Until Boltz says whether that is in EtherSwap/ERC20Swap/Router v6/v2 or in the backend, reusing the v6 bytecode is reuse of unaudited code with a possibly-known defect. A minimal fork (lock/claim/refund only, no Router, no signature paths) reduces surface.
- Boltz never listed a native-ETH pair; EtherSwap carried RBTC on Rootstock and is deployed-but-apparently-unused for ETH on Arbitrum (inferred from the asset list above).
- On Arbitrum, `block.number` returns an approximation of the L1 block number, so block-height timelocks there tick at about 12 s, not 0.25 s (from prior knowledge of Arbitrum docs, not re-fetched) — [Arbitrum docs](https://docs.arbitrum.io/build-decentralized-apps/arbitrum-vs-ethereum/block-numbers-and-time)

### Gaps
- Audit: no audit of EtherSwap/ERC20Swap/Router found in the repo (no `audits/` directory in the tree, nothing in README) or via search. Cannot assert "unaudited" with certainty; flag as "no public audit located".
- Rootstock (and any other) contract addresses, Boltz fee schedule (percent + miner fee), and any Sepolia/testnet EVM deployment: not obtainable because the Boltz API/docs hosts were unreachable; web-app config suggests no public testnet mode (mainnet/regtest only).
- Whether the Arbitrum deployment is the block-number or the `Timestamp` variant was not checked (compare bytecode for `NUMBER` vs `TIMESTAMP` or test with a simulated refund).
- Whether Boltz has resumed or will resume; whether the reported ownership transfer is real.

## 2. 1inch Fusion+ (cross-chain atomic swaps)

### Takeaway
Fusion+ is live on 16 EVM chains plus Solana with deep resolver liquidity and native-ETH support, but it cannot be the ETH leg of a Fiber swap as deployed: the escrow hashlock is hard-coded `keccak256(secret)`, which Fiber cannot verify (Fiber supports only `ckb_hash`/`sha256`), resolvers must pass KYC/KYB and hold an Access NFT, and there is no CKB/Nervos extension among the 2025 Unite DeFi hackathon outputs.

### Cited Findings
- Design: `EscrowFactory` deploys an `EscrowSrc` clone on the source chain and an `EscrowDst` clone on the destination chain per swap; both release against a hashlock plus timelocks; the protocol "implies some off-chain mechanism to verify the created escrow and distribute user defined secret" — [cross-chain-swap README](https://github.com/1inch/cross-chain-swap/blob/master/README.md)
- Hashlock is Keccak-256: `if (_keccakBytes32(secret) != hashlock) revert InvalidSecret();` where `_keccakBytes32` does `mstore(0, secret); ret := keccak256(0, 0x20)` — [BaseEscrow.sol](https://github.com/1inch/cross-chain-swap/blob/master/contracts/BaseEscrow.sol)
- Timelocks are durations in seconds relative to escrow deployment timestamp (`Timelocks`/`TimelocksLib`); stages: resolver-only withdrawal, public withdrawal (`EscrowDst.publicWithdraw`), resolver cancellation, public cancellation (`EscrowSrc.publicCancel`) — [docs/protocol.md](https://github.com/1inch/cross-chain-swap/blob/master/docs/protocol.md)
- Safety deposit: "Resolver deposits in escrow clones safety deposit in native tokens on both chains"; it is paid to whoever executes the withdrawal or cancellation — [docs/protocol.md](https://github.com/1inch/cross-chain-swap/blob/master/docs/protocol.md)
- Partial fills: order split into N parts uses N+1 secrets in a Merkle tree whose leaf is `keccak256(index, hashedSecret)`; a hashlock cannot be reused — [docs/protocol.md](https://github.com/1inch/cross-chain-swap/blob/master/docs/protocol.md)
- "Public" phases are not public: `publicWithdraw`/`publicCancel` "are open to any holder of that token [access token] rather than to the general public" (`if (_ACCESS_TOKEN.balanceOf(msg.sender) == 0) revert InvalidCaller();`); `rescueFunds` is taker-only after 8 days (691,200 s); no upgradeability; "Nothing on-chain checks that the stages are ordered sensibly" — [SECURITY.md](https://github.com/1inch/cross-chain-swap/blob/master/SECURITY.md), [BaseEscrow.sol](https://github.com/1inch/cross-chain-swap/blob/master/contracts/BaseEscrow.sol)
- Resolver flow: `EscrowFactory.addressOfEscrowSrc` -> fill via Limit Order Protocol `fillOrderArgs` (deploys EscrowSrc) -> `EscrowFactory.createDstEscrow` on destination -> `withdraw`/`cancel` — [docs/protocol.md](https://github.com/1inch/cross-chain-swap/blob/master/docs/protocol.md)
- Deployments (EscrowFactory v1.0 `0xa7bcb4eac8964306f9e3764f67db6a7af6ddf99a`, v1.1 `0x03a25b3215a0e5c15cf23ac4d2e5cf86c0ff7efa` on most chains): Ethereum, Arbitrum, Avalanche, Base, BSC, Gnosis, Linea, Optimism, Polygon, Unichain, Sonic; different addresses on zkSync, Robinhood (4663), Monad (143), Cronos, HyperEVM — [deployments.md](https://github.com/1inch/cross-chain-swap/blob/master/deployments.md)
- Audits: v1.0 "Cross-chain Protocol" and v1.1 "Crosschain fees" reports in 1inch-audits; bug bounties on HackenProof and Immunefi — [SECURITY.md](https://github.com/1inch/cross-chain-swap/blob/master/SECURITY.md), [1inch-audits](https://github.com/1inch/1inch-audits)
- Live chains per API docs: 18 networks listed including Solana (chain ID 501), the only non-EVM; native coins (ETH, BNB, AVAX, SOL...) swappable "without manual wrapping and unwrapping"; resolvers "pay all gas on both the source and destination chains" — [1inch cross-chain swap API intro](https://business.1inch.com/portal/documentation/apis/swap/cross-chain-swap/introduction)
- Resolver onboarding: register in 1inch Business Portal, complete KYC/KYB and a mandatory compliance survey ("no whitelisting will be enabled until the verification and survey have been completed"), then "Your Access NFT(s) will be minted, granting access to Order fulfillment"; Unicorn-Power whitelisting currently disabled per 1IP-89 — [1inch resolver introduction](https://business.1inch.com/portal/assets/docs-v2/resolvers/introduction.md)
- Unite DeFi hackathon (1inch + ETHGlobal, $525K prizes, winners post dated 2025-08-11, updated 2025-08-13). Track 1 (Fusion+ extensions) winners by chain: Sui (Nether Swap), Bitcoin (GattaiSwap), Aptos (AptosIntegration), Tron (1inch Fusion+ Bridge), Monad (GattaiSwap), Starknet (StarknetFusion+), Tezos (XRoute), Cardano (CardanoSwap), TON (CellJMP), NEAR (X3 Fusion), ICP (AvgInch). No Nervos/CKB mention — [1inch hackathon winners](https://1inch.com/blog/post/1inch-reveals-hackathon-winners)
- Other showcase entries targeted Stellar, XRPL, Polkadot, Cosmos (e.g. Stellinch, Nuvex, Polkavex); none found for CKB — [ETHGlobal showcase search results, e.g. Fusion+ Extensions](https://ethglobal.com/showcase/fusion-extensions-pqm05)

### Inferences
- Fusion+ escrows cannot be hash-locked with SHA-256 without redeploying modified escrow implementations and a new factory (contracts are immutable: "There is no way to patch a deployed escrow"). A modified factory would not be served by 1inch's relayer/resolver network, so the liquidity advantage disappears.
- Hackathon extensions for Bitcoin/Cardano etc. had to bridge the keccak/sha256 mismatch on the non-EVM side (those chains can compute keccak or use custom scripts). CKB itself could verify keccak256 in a lock script, but a Fiber TLC cannot, so the Fiber route is blocked specifically by Fiber's two-algorithm limit.
- Hackathon projects are prototypes; none is evidenced as production-integrated into 1inch.

### Gaps
- Names/dates of the audit firms for v1.0/v1.1 (in the audits repo, not opened).
- Typical safety-deposit sizes and current Fusion+ fee levels.
- Whether any non-winning hackathon entry targeted CKB: I searched and found none, but did not enumerate the full showcase.

## 3. Other Lightning/HTLC-to-EVM atomic swap systems

### Takeaway
Garden is the only live, audited, SHA-256 HTLC solver network that already lists Lightning and Ethereum/Base/Arbitrum, but it settles only ERC-20s (wrapped BTC, stablecoins), not native ETH, and solver/chain onboarding is by application (210,000 SEED stake). Atomiq and Lightning.space cover Bitcoin-L2-style EVM chains (Citrea, Botanix), not Ethereum L1/L2 native ETH. No existing non-custodial network was found that can be pointed at a new counter-chain like Fiber/CKB without the operator's cooperation.

### Cited Findings
Garden Finance
- HTLC model uses `sha256(preimage)`; docs claim "Universal compatibility (any chain supporting SHA256 and relative timelocks can be added)"; methods Initiate / Redeem / Refund / Instant refund — [Garden contracts overview](https://docs.garden.finance/docs/contracts/overview)
- EVM order IDs are `sha256(abi.encode(block.chainid, secretHash, initiator))`; gasless `initiateWithSignature` (EIP-712) exists on HyperEVM variant — [Garden HyperCore contract doc](https://docs.garden.finance/contracts/hypercore.md)
- Live API (measured 2026-11-12) lists active chains: arbitrum, arc, base, bitcoin, bnbchain, ethereum, hypercore, hyperevm, ink, lightning, litecoin, robinhood, solana, spark, starknet, tempo. EVM assets are all `evm:htlc_erc20`: Ethereum cbBTC (`0xe35d025d0f0d9492db4700FE8646f7F89150eC04`), USDC (`0x5fA58e4E89c85B8d678Ade970bD6afD4311aF17E`), USDT (`0xCF5E5e28848cFe779f7Fb711C57857Cb3b144A19`), WBTC (`0xD781a2abB3FCB9fC0D1Dd85697c237d06b75fe95`); Base cbBTC, cbLTC, USDC (`0x227A436e93AAEf856ed406713F2bc3D110A7b797`); Arbitrum WBTC (`0xb5AE9785349186069C48794a763DB39EC756B1cF`). No native-ETH asset on any EVM chain (Solana has native `solana:sol`). Timelocks (source/destination): ethereum 7200/600, base 43200/3600, arbitrum 432000/36000, bitcoin 144/12, lightning 43200/7200 — [Garden API /v2/chains](https://api.garden.finance/v2/chains)
- Sample quote (measured 2026-11-12) 0.01 BTC -> Base cbBTC: output 0.00998764, `"fee":9` (bps), `"fixed_fee":"0.25"`, solver `maestro-solver`, estimated 20 s — [Garden API /v2/quote](https://api.garden.finance/v2/quote?from=bitcoin:btc&to=base:cbbtc&from_amount=1000000)
- Solvers: "Solvers must stake 210,000 SEED as collateral", need 24/7 infra and liquidity, and onboard via a form after which the team gets in touch — [Garden solvers doc](https://docs.garden.finance/docs/home/fundamentals/core-concepts/solvers)
- Audits: OtterSec (2023-08-11, EVM + Bitcoin script HTLC), Trail of Bits (2024-04-05, GardenStaker/HTLC/FEEAccount), Zellic (2025-06-04, Sui Move HTLC), Code4rena (competitive, 2025-11-24 to 2025-12-08, report Feb 2026) — [Garden security page](https://garden.finance/security), [Code4rena report](https://code4rena.com/reports/2025-11-garden)
- Incident: Blockaid flagged about $450K USDT drained from Garden HTLCs on Ethereum, Base, Arbitrum, BNB Chain on 2026-07-26; Garden: "Garden's protocol and HTLC smart contracts were not compromised, and no user funds were lost or at risk", attributing it to one independent solver's off-chain database; app taken offline at the time; an October 2025 solver breach of about $11.4M is also reported — [Cointelegraph](https://cointelegraph.com/news/garden-finance-app-offline-450k-htlc-exploit), [crypto.news](https://crypto.news/garden-finance-takes-app-offline-after-independent-solver-database-compromise/); early reports framed it as a contract drain — [Crypto Briefing](https://cryptobriefing.com/blockaid-garden-finance-exploit-450k/)

Atomiq
- SDK (v8.9.5) "enables trustless swaps between smart chains (Solana, EVM, Starknet, etc.) and bitcoin (on-chain - L1 and lightning network - L2)"; connectors for Solana, Starknet, EVM (only Citrea named); Lightning swaps use HTLC init/claim; SDK can be pointed at a custom LP via `intermediaryUrl`/`registryUrl` — [@atomiqlabs/sdk README](https://unpkg.com/@atomiqlabs/sdk@8.9.5/README.md)
- Chains with TVL: Starknet, Citrea, Solana, Botanix — [DefiLlama Atomiq](https://defillama.com/protocol/atomiq-exchange)

Lightning.space / JuiceSwap bridge
- Runs an "LDS fork" of BoltzExchange/boltz-backend (compared against upstream v3.13.0) with Citrea configuration — [LightningDotSpace/api PR 178 (mirror)](https://tgfed.nhyvvfeijnh.workers.dev/LightningDotSpace/api/pull/178)
- Bridge docs (seen via search summary, not fetched): chains Bitcoin, Citrea, Ethereum, Polygon; HTLC atomic swaps with MuSig2 cooperative signing; pairs such as cBTC (Citrea) <-> WBTC (Ethereum) and JUSD (Citrea) <-> USDT (Polygon) — [JuiceSwap bridge docs](https://juiceswap-docs-prd.pages.dev/bridge)

Boltz-derived stack
- ZEUS runs its own deployment of the open-source Boltz stack and went offline citing Boltz downtime; Bull Bitcoin and Aqua were working to restore Lightning/Liquid swaps — [TFTC, 2026-08-04](https://www.tftc.io/boltz-bitcoin-swaps-suspended-ai-attacks), [crypto.news](https://crypto.news/boltz-halts-swaps-as-ai-attacks-outpace-its-team/)

### Inferences
- Garden's solver network is the most plausible existing LP network for a "pay over a Lightning-like network, receive on Ethereum/Base" product, and its hash function matches Fiber. Two blockers: (a) no native ETH HTLC (only ERC-20), so native ETH would need an extra DEX hop or a new native HTLC schema; (b) Fiber/CKB would have to be added as a chain by Garden and supported by its solvers (application-based, not permissionless).
- Garden timelock values look like block counts per chain (Ethereum 7200 blocks = 24 h, Base 43200 x 2 s = 24 h, Bitcoin 144 blocks = 24 h); units are not stated in the API.
- Two solver compromises (Oct 2025, Jul 2026) and the Boltz shutdown (Aug 2026) show the operational risk sits in off-chain solver/backend infrastructure rather than in the simple HTLC contracts.
- Lightning.space-style Boltz forks demonstrate that the EtherSwap/ERC20Swap contracts plus boltz-backend can be operated by an independent LP; the same pattern (own LP + EtherSwap) fits a Fiber<->ETH service.

### Gaps
- Garden EVM HTLC exact function signatures, timelock unit and redeem-caller rules: the EVM contract doc pages returned 404; need the Solidity source (github.com/gardenfi) to confirm. Whether the Garden app is fully back online after July 2026 is unconfirmed (the API was answering quotes on 2026-11-12).
- Lightning Labs Taproot Assets edge-node swaps to EVM, tBTC-native Lightning swaps, Citrea/BOB/Rootstock HTLC bridges other than the above: no primary source found in the time available. tBTC appears only as the Arbitrum ERC-20 hop inside Boltz's USDT route.
- Atomiq: whether running an LP is permissionless, hash function (assumed SHA-256 because it settles Lightning invoices), and whether any Ethereum L1/L2 deployment exists: not confirmed.

## 4. ERC-7683 / Across / UniswapX / Relay / deBridge intents

### Takeaway
Intent systems deliver ETH on Ethereum/L2s quickly, but a solver can only be repaid for filling an order whose origin deposit sits in that protocol's own origin-chain contract (Across SpokePool / origin settler, Relay Depository, deBridge DlnSource). None can accept "CKB paid over Fiber" as the origin without protocol-side integration of CKB; the practical use is as a second hop (LP sources ETH on the right chain), not as the hash-locked leg.

### Cited Findings
- Across ERC-7683: "The AcrossOriginSettler is the on-chain entry point for ERC-7683 intents"; users call `open(fillDeadline, orderDataType, orderData)`, which creates SpokePool deposits; origin settlers deployed on Base (`0x4afb570AC68BfFc26Bb02FdA3D801728B0f93C9E`) and Arbitrum (`0xB0B07055F214Ce59ccB968663d3435B9f3294998`) — [Across ERC-7683 docs](https://docs.across.to/guides/concepts/erc-7683)
- Across V4: only the settlement layer changes; V3 needed a custom adapter and audit per chain, V4 needs a `UniversalSpokePool` plus the `SP1Helios` ZK light client on the destination, after which chains "can be added permissionlessly"; bundles are still verified by UMA's Optimistic Oracle, written to `HubPoolStore` on L1, then proven after 12–15 min Ethereum finality. The page carries a banner that V4 integration support has ended / will be deprecated (conflicting signals) — [What is Across V4?](https://docs.across.to/guides/concepts/across-v4)
- Across migrated SpokePool functions/events to `bytes32` addresses on 2025-01-23 for EVM/non-EVM (Solana) compatibility — [Across non-EVM migration guide](https://docs.across.to/introduction/migration-guides/migration-guide-for-non-evm-and-prefills)
- ERC-7683 does not specify how the origin chain learns that a fill happened; each settlement system supplies its own verification — [Reactive Network blog](https://blog.reactive.network/intents-solvers-and-borrowed-certainty/)
- Relay: solvers watch Depository contracts on supported chains for deposits — [Relay solver guide](https://docs.relay.link/references/protocol/guides/for-solvers)
- deBridge DLN: any on-chain address can create orders; solvers set their own source-finality requirements — [deBridge DLN protocol overview](https://docs.debridge.finance/dln-the-debridge-liquidity-network-protocol/protocol-overview)
- UniswapX cross-chain uses ERC-7683 (co-developed with Across) — [Blockworks](https://blockworks.co/news/uniswap-across-cross-chain-swaps)

### Inferences
- Adding CKB as an origin chain to any of these needs: an escrow/deposit contract on CKB that the protocol recognises, an indexer/dataworker or oracle path that attests CKB deposits, and inventory/rebalancing support by relayers. Fiber payments are off-chain channel updates with no on-chain deposit event, so they are invisible to these systems by construction.
- A solver could still privately accept a Fiber hold invoice as its own payment and fill on Ethereum, but that is just a bilateral HTLC swap with the solver; it gets no repayment guarantee from the intent protocol, so the EVM leg still needs its own hashlock (EtherSwap-style).

### Gaps
- Official statements on adding non-EVM origin chains for Relay, deBridge and UniswapX were not found; third-party summaries (eco.com) conflict with Across's own docs on non-EVM coverage — [eco.com Across deep dive](https://eco.com/support/en/articles/14799839-across-protocol-solver-architecture-deep-dive).
- Current status of Across V4 (deprecation banner vs. "live on BNB Chain") is unclear.

## 5. Gas economics (November 2026) and gasless-claim options

### Takeaway
At the measured 2026-11-12 fee levels (L1 base fee about 0.2 gwei, ETH about $2,089), an EtherSwap-style lock costs about $0.02–0.03 and a claim about $0.01–0.04 on Ethereum L1, and well under $0.01 on Base, Arbitrum and Optimism. Gas is no longer the constraint; the relayed claim needs no account abstraction because the HTLC can pay a named `claimAddress` regardless of who submits the transaction.

### Cited Findings
- Ethereum L1 (measured 2026-11-12, block 26,393,521): `eth_gasPrice` = 194,692,914 wei (0.195 gwei); base fee over the last 20 blocks 0.176–0.209 gwei; median priority-fee samples about 0.075–0.1 gwei; blob base fee about 0.011 gwei — [publicnode Ethereum RPC](https://ethereum-rpc.publicnode.com)
- Base: base fee 5,000,000 wei (0.005 gwei) flat across 20 blocks, `eth_gasPrice` 0.006 gwei — [publicnode Base RPC](https://base-rpc.publicnode.com)
- Arbitrum One: base fee 0.02 gwei, `eth_gasPrice` 20,014,000 wei — [publicnode Arbitrum RPC](https://arbitrum-one-rpc.publicnode.com)
- Optimism: base fee about 12,167 wei (0.000012 gwei), `eth_gasPrice` 1,011,944 wei (about 0.001 gwei) — [publicnode Optimism RPC](https://optimism-rpc.publicnode.com)
- ETH price $2,089.08 (CoinGecko, last updated 1794421974 = 2026-11-11 about 18:33 UTC); same call returned CKB ("nervos-network") at $0.00095808 — [CoinGecko simple price API](https://api.coingecko.com/api/v3/simple/price?ids=ethereum,nervos-network&vs_currencies=usd&include_last_updated_at=true)
- Historical context: monthly average L1 gas price 1.38 gwei in November 2025 and 1.40 gwei in October 2025 — [CoinLedger](https://coinledger.io/research/ethereum-transaction-fees-and-gas-prices-trends-and-insights)
- UNVERIFIED headline only (body not retrieved): "Ethereum gas fees surge 498% in two weeks", dated 2026-11-04 — [unlock-bc](https://www.unlock-bc.com/en/ethereum-gas-fees-surge-498-two-weeks-why)
- Gas units for a minimal native-ETH SHA-256 HTLC (Boltz EtherSwap v6 bytecode simulated on L1, see section 1): lock 47,417; self-claim 32,244; relayer claim 34,975 (existing recipient) or 59,987 (never-used recipient); refund 31,367 — [publicnode Ethereum RPC](https://ethereum-rpc.publicnode.com), [EtherSwap.sol](https://github.com/BoltzExchange/boltz-core/blob/master/contracts/EtherSwap.sol)
- EIP-7702 relayer mode: a different account pays gas and submits the type-4 transaction; it is a native transaction type sendable to any JSON-RPC endpoint — [Chainstack EIP-7702 tutorial](https://docs.chainstack.com/docs/ethereum-eip-7702-tutorial)
- A 7702 delegate contract must be able to handle incoming ETH if the EOA expects to receive it — [Linea EIP-7702 docs](https://docs.linea.build/protocol/eip-7702)
- EtherSwap's own relayed paths: public 5-argument `claim` (anyone submits, `claimAddress` paid) and EIP-712 signature `claim` (pays `msg.sender`, used by the Router); Boltz's web app also configures a gas-sponsor service — [EtherSwap.sol](https://github.com/BoltzExchange/boltz-core/blob/master/contracts/EtherSwap.sol), [boltz-web-app base.ts](https://github.com/BoltzExchange/boltz-web-app/blob/main/src/configs/base.ts)

### Inferences
Derived USD costs (my arithmetic; ETH $2,089; L1 effective price 0.28 gwei = 0.20 base + 0.08 tip; L2 figures are execution fee only at `eth_gasPrice`, excluding the small L1 data/blob component):

| Action (gas) | Ethereum L1 | Base (0.006 gwei) | Arbitrum (0.02 gwei) | Optimism (0.001 gwei) |
|---|---|---|---|---|
| lock (47,417) | $0.028 | $0.0006 | $0.0020 | $0.0001 |
| claim by recipient (32,244) | $0.019 | $0.0004 | $0.0013 | $0.0001 |
| relayer claim, existing recipient (34,975) | $0.020 | $0.0004 | $0.0015 | $0.0001 |
| relayer claim, fresh recipient (59,987) | $0.035 | $0.0008 | $0.0025 | $0.0001 |
| lock + relayer claim to fresh address (107,404) | $0.063 | $0.0013 | $0.0045 | $0.0002 |

- Sensitivity on L1 for lock + claim to a fresh address (107,404 gas): about $0.22 at 1 gwei, $2.24 at 10 gwei, $6.73 at 30 gwei. Even a 5x spike from today (the unverified "498%" headline) keeps the L1 round trip near $0.30.
- The claim-side cost is naturally borne by the LP: the LP learns the preimage when its Fiber hold invoice is settled, then (or the user, or anyone) submits the 5-argument claim. If instead the user must reveal first (user is the ETH receiver and holds the preimage), a relayer or the LP can submit the claim with the user's preimage; front-running is harmless because funds can only go to `claimAddress`.
- EIP-7702/4337 paymasters are optional extras (e.g. to batch "claim + swap" for the user), not prerequisites.

### Gaps
- No authoritative monthly-average gas figure for November 2026 was found; the numbers above are a single-moment reading and gas may have been unusually low or high at that moment.
- L2 total fees including L1 data cost were not measured per transaction (expected to add a fraction of a cent).
- The CoinGecko CKB price looks very low relative to earlier years; verify before using it in any economics.

## 6. Ethereum precompiles for verifying CKB data; CKB light client on Ethereum (Force Bridge)

### Takeaway
Ethereum can cheaply compute both hashes relevant to CKB: SHA-256 (0x02) and CKB's personalised BLAKE2b via the EIP-152 `F` precompile (0x09), because the caller supplies the state vector `h` and can therefore fold in the `ckb-default-hash` personalization itself. There is no maintained CKB light client on Ethereum: Force Bridge was sunset with a 2025-12-01 shutdown after a roughly $3M+ exploit in June 2025. For an HTLC swap none of this is needed; it matters only for proof-based (non-HTLC) designs.

### Cited Findings
- EIP-152 adds precompile `0x09` wrapping BLAKE2 `F`; input is exactly 213 bytes: `[4 bytes rounds][64 bytes h][128 bytes m][8 bytes t_0][8 bytes t_1][1 byte f]`; "Each operation will cost `GFROUND * rounds` gas, where `GFROUND = 1`"; rationale cites enabling "keyed, salted, and personalized hashing as well as variable length digests, none of which are currently available on the EVM" — [EIP-152](https://eips.ethereum.org/EIPS/eip-152)
- The precompile does not handle the parameter block; "your contract must set h correctly before calling 0x09" — [dev.to: Verifying Zcash proofs with EIP-152](https://dev.to/zknd3r/verifying-zcash-proofs-on-ethereum-with-eip-152-4h80)
- CKB's `ckbhash` is BLAKE2b with 32-byte digest and personalization `ckb-default-hash` — [CKB RFC 0022, Appendix A](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0022-transaction-structure/0022-transaction-structure.md)
- EtherSwap uses the SHA-256 precompile path via Solidity `sha256(...)` — [EtherSwap.sol](https://github.com/BoltzExchange/boltz-core/blob/master/contracts/EtherSwap.sol)
- Force Bridge sunset: announced with exit window from 2025-06-01; last recommended withdrawal 2025-11-30; "On 2025-12-01T00:00:00Z, the Force Bridge will shut down"; stated direction is RGB++ and Fiber; forum comments dated 2026-03-05 say Godwoken has been taken down — [Nervos Talk: Sunset of Force Bridge and Godwoken](https://talk.nervos.org/t/sunset-of-force-bridge-and-godwoken/8789)
- Force Bridge was exploited around 2025-06-01 for over $3 million — [The Block](https://www.theblock.co/amp/post/356535/hackers-drain-over-3-million-in-crypto-from-nervos-networks-force-cross-chain-bridge-say-security-analysts); about $3.76M across Ethereum and BNB Chain — [Rekt](https://alpha.rekt.news/force-bridge-rekt)

### Inferences
- `ckbhash` on Ethereum = initialise `h = IV XOR parameter block` (digest length 32, fanout 1, depth 1, personalization bytes in the last 16 bytes of the parameter block, i.e. XORed into IV[6..7]) then call `F` once per 128-byte block with 12 rounds: 12 gas per block plus STATICCALL/memory overhead (a few hundred gas per block in practice). A 208-byte CKB header is 2 blocks. Parameter-block layout is from the BLAKE2 spec (not re-fetched) — [RFC 7693](https://www.rfc-editor.org/rfc/rfc7693)
- A CKB light client on Ethereum also needs Eaglesong (CKB PoW hash), which has no EVM precompile and would have to be implemented in EVM bytecode or wrapped in a ZK proof; this is the expensive part, not BLAKE2b. (No source fetched; consistent with this project's "eaglesong-sp1" spike.)
- For a Fiber<->ETH HTLC, the only cross-chain "verification" is the preimage itself under SHA-256, available on both sides; neither chain needs to read the other's state.

### Gaps
- Force Bridge's verification design (multisig committee vs. light client) and the post-shutdown state of its Ethereum contracts were not confirmed from a primary source.
- No measured gas figure for an on-chain `ckbhash` implementation; no evidence found of any production contract using 0x09 for CKB data (an ethPandaOps March 2026 investigation of blake2f mainnet usage exists but was not read) — [ethPandaOps](https://investigations.ethpandaops.io/2026-03/precompile-usage-mainnet/blake2f)

## 7. Ethereum light clients verifiable elsewhere (sync committee, SP1 Helios)

### Takeaway
Production-grade ZK Ethereum light clients exist (SP1 Helios, used by Across V4) and expose finalized execution state roots against which storage proofs can be checked, but I found no published per-proof cost, verification is built for EVM destinations with BN254 verifiers, and finality lag is about 12–15 minutes. For a hash-locked swap this machinery is unnecessary; it is relevant only if CKB should verify "ETH was paid to X" without an HTLC.

### Cited Findings
- SP1 Helios verifies that beacon headers are signed by the Altair sync committee inside the SP1 zkVM; the `SP1Helios` contract stores beacon headers, execution state roots and sync committees; storage slots are proven by Merkle-Patricia proofs against the stored execution state root (`eth_getProof` needed on the source RPC); deployment uses a PLONK verifier gateway; the sample operator loop updates about every 5 minutes; proofs are requested from the Succinct Prover Network — [SP1 Helios book](https://succinctlabs.github.io/sp1-helios/print.html)
- Zellic assessed SP1 Helios 2025-07-18 to 2025-07-29 (report 2025-08-07): 1 critical (no test suite), 1 medium, 3 informational, including a gas-optimization suggestion — [Zellic SP1 Helios report](https://reports.zellic.io/publications/sp1-helios)
- OpenZeppelin audited a Helios system update (2025-12-12) for Across — [OpenZeppelin](https://www.openzeppelin.com/news/helios-system-update-audit)
- SP1 Helios "Verify Update" costs 29,968,821 zkVM cycles with BLS12-381 precompiles; bn254 precompiles speed Groth16/PLONK verification inside SP1 about 20x — [Succinct blog: optimized bn254 & bls12-381 precompiles](https://blog.succinct.xyz/succinctshipsprecompiles/)
- Across V4 flow shows the practical latency: wait 12–15 minutes for Ethereum finality, then generate the SP1 proof and verify it in `SP1Helios` on the destination — [What is Across V4?](https://docs.across.to/guides/concepts/across-v4)
- A Tendermint light-client proof on the Succinct network averages about 100M prover gas units (context for pricing; no Helios figure given) — [Succinct docs FAQ](https://docs.succinct.xyz/docs/network/developers/faq)

### Inferences
- To prove "ETH was paid to X" on a non-EVM chain one needs: (1) a finalized execution state/receipts root from a sync-committee proof (SP1 Helios or equivalent), and (2) an MPT inclusion proof. A plain ETH transfer leaves no log, so the cheapest provable artefact is an HTLC/escrow contract event (e.g. EtherSwap `Lockup`/`Claim`) in the receipts trie or a storage slot of that contract under the state root.
- On CKB, verifying a Groth16/PLONK proof means running BN254 pairing arithmetic inside CKB-VM (RISC-V, no pairing syscall), which is cycle-heavy; plus someone must run and pay for a prover/operator. This is a much larger build than an HTLC and adds a 12–15 minute finality delay, versus seconds for preimage-based settlement.
- Therefore a light-client route is only justified for flows that cannot be hash-locked (e.g. proving a payment to an arbitrary third-party address).

### Gaps
- No primary figure found for on-chain gas of an SP1 Helios update, for USD proving cost per update, or for the cost of a receipt/transaction inclusion proof; no evidence of any SP1 Helios (or Telepathy) verifier deployed on a non-EVM chain or on CKB.
- Succinct Telepathy's current status was not researched.

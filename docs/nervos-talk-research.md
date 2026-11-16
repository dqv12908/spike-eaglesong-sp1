<!-- Draft for Nervos Talk. Before posting: add the repo link where it says REPO. -->

# One secret, every chain: the cheapest non-custodial way out of CKB to ETH, ADA and SOL (measured on testnets)

**TL;DR**

- A Fiber payment locked with SHA-256 already speaks the same language as swap contracts that exist on other chains. I swapped CKB over Fiber for native ETH on Sepolia, in both directions, in about 25 seconds, using **Boltz's EtherSwap contract unmodified**. Nothing was written for the Ethereum side. Together with the Solana swap I posted earlier, one secret now reaches two chains. Cardano is the same shape, but no public validator there is usable as is; I measured a lock and claim at 0.36 ADA.
- Chain fees are a rounding error on every route. What a swap really costs is the LP's rebalancing, the free option one side gives the other, and how long capital can be stalled. Priced from live order books, an LP breaks even at about 0.45% on small swaps. A centralized instant exchange quoted 1.6–1.7% below mid-market for the same swap on the same day.
- CKB does not need an LP per chain. It needs **one CKB-specialist LP** that holds small floats and rebalances them against each other through networks that already carry ETH, SOL and ADA. Only the CKB leg needs an exchange.
- A second design removes the foreign contract entirely: **the only script in the swap is on CKB**. The foreign side is two ordinary transfers to and from an address whose key is the sum of two secrets. CKB-VM can check a foreign curve's key directly, which is what makes this simple here and awkward elsewhere. I built the CKB lock and measured it in CKB-VM (about 2.2 million cycles to check an Ed25519 key), and ran the foreign half on Solana devnet and Sepolia.
- Four small changes in Fiber would cut the worst-case lock-up in these swaps from about 7 hours to minutes. They are listed at the end.

Everything is testnet and devnet. Code, logs and transaction links: REPO.

## 1. Where things stand

I checked what a CKB holder can use today to reach ETH, ADA or SOL without a custodian.

| Route | State (November 2026) |
|---|---|
| Force Bridge | Sunset; the exit window closed in January 2026 ([announcement](https://forcebridge-board.vercel.app/announcement)) |
| UTXOSwap | Shut down in October 2026 |
| USDI (the only UDT whitelisted on Fiber mainnet) | [Discontinued](https://talk.nervos.org/t/usdi-on-ckb-will-be-discontinued-any-alternative-for-stablecoin/10417) |
| Fiber's Cross-Chain Hub | Swaps wrapped BTC, and no wrapped BTC is configured on Fiber mainnet |
| Solver networks (NEAR Intents, LI.FI, Rango, Chainflip, THORChain) | None quotes native CKB |
| Meson | On CKB, but only for ccBTC |
| Fiber mainnet | 40 nodes, 19 channels, 31,498 CKB of total capacity, about $30 ([dashboard API](https://api-dashboard.fiber.channel/analysis_hourly?net=mainnet), read 12 Nov) |

So the practical answer today is a centralized instant exchange. That is the bar to beat, on price and on custody.

Two pieces of recent work on this forum are close to this post and deserve credit up front. [Swap book](https://talk.nervos.org/t/swap-book-trade-ckb-for-usdc-eth-or-bitcoin-with-no-custodian-testnet/11164) (LusoCryptoLabs) runs hash-locked swaps between CKB L1 and Base or Bitcoin on testnet. [Chiral](https://talk.nervos.org/t/chiral-is-now-open-source-a-trust-minimized-cardano-and-nervos-ckb-port-for-you-to-review-break-and-test/10421) has Cardano and CKB verifying each other on testnet. A hash-locked swap of L1 CKB is therefore not new. What I could not find anywhere, after searching this forum and GitHub: a Fiber swap to Ethereum, Cardano or Solana, any reuse of Boltz's contracts with Fiber, or a swap whose only contract is on CKB.

## 2. What "efficient" should mean

The first instinct is to count transactions and gas. On every chain I looked at, that cost is cents: an estimated $0.06 for a lock and claim on Ethereum L1 at this week’s gas price, under a cent on an L2 or on Solana, and about $0.06 on Cardano (sections 4 and 5). It is not what separates a good design from a bad one. Three other costs are.

**Rebalancing.** If more people sell CKB than buy it, the LP ends up with CKB it has to sell somewhere. CKB only trades on centralized exchanges, so each unit of one-way flow costs the LP one exchange round trip. Flow that nets out costs nothing.

**The free option.** In a hash-locked swap, the side that holds the secret can wait and see where the price goes before finishing. A common approximation prices that at 0.4 · σ · √T of the amount, where σ is volatility and T is how long they can wait ([Han, Lin and Yu](https://eprint.iacr.org/2019/896) put the 24-hour case at 2–3%). At 80% annual volatility:

| Time the secret holder can wait | Value of the option |
|---|---|
| 1 minute | 0.04% |
| 3 minutes | 0.08% |
| 10 minutes | 0.14% |
| 7 hours | 0.9% |
| 24 hours | 1.7% |

**Stalled capital.** If one side walks away, the other side's funds are stuck until a timelock expires. Nothing is lost, but it is the main way to grief an LP, and the main thing a user fears.

Shortening the window is worth more than any saving in gas. A design that adds a transaction to remove ten minutes of waiting is the cheaper design.

Put together, an LP breaks even at roughly

> spread ≈ (exchange round trip × share of flow that is one-way) + option value + chain fees

### The numbers today

Read on 12 November 2026 at 19:42 UTC, for 100,000 CKB (about $94). Mid-market is CoinGecko at the same minute; the SimpleSwap figures are its floating quotes.

| To | Mid-market | SimpleSwap | Below mid | An LP quoting 0.5% |
|---|---|---|---|---|
| ETH | 0.046814 | 0.046010 | 1.72% | 0.046580 |
| ADA | 549.23 | 539.97 | 1.69% | 546.48 |
| SOL | 1.15470 | 1.13588 | 1.63% | 1.14893 |

Is 0.5% a fair guess for the LP? I priced each term from live data:

- **Selling CKB.** Binance's CKB/USDT book had a 0.21% spread, and selling $1,000 of CKB landed 0.15% below mid, $10,000 landed 0.47% below, and $50,000 landed 0.95% below. Add the standard 0.1% taker fee.
- **Buying the other coin.** About 0.1% on the same exchange. Moving ETH, SOL and ADA against each other without an exchange cost 0.2–0.6% below mid in dry-run quotes from NEAR Intents.
- **Option value.** About 0.08% for a 3-minute window.
- **Chain fees.** Under a cent to a few cents.

That gives a break-even of about **0.45%** when all the flow is one-way and hedged in $1,000 clips, about 0.75% in $10,000 clips, and about 0.1% when flow in the two directions nets out. So a 0.5% quote is plausible for small swaps, and it leaves the user about **1.1–1.2% better off** than the centralized quote, without giving up custody. It is still an estimate: no LP is quoting it.

The same data shows the real ceiling. Binance's CKB/USDT pair traded $219,000 in 24 hours and had $45,000 of bids within 2% of mid. Above roughly $10,000 per swap, the cost is set by how thin CKB's own market is, whatever the route.

## 3. SHA-256 is already the common language

A Fiber invoice can be locked with SHA-256 (`hash_algorithm: "sha256"`). Many swap contracts on other chains use the same lock on a 32-byte secret, because they were built to pair with Bitcoin Lightning. That means a Fiber payment can be the CKB leg of a swap against any of them without changing either side.

| Chain | Existing piece with a SHA-256 lock | Usable as is? |
|---|---|---|
| Ethereum and EVM chains | Boltz [EtherSwap](https://github.com/BoltzExchange/boltz-core/blob/master/contracts/EtherSwap.sol) v6 (native ETH, no owner, no allow-list; already deployed on Arbitrum One) | Yes. Shown below |
| Ethereum (ERC-20) | Garden's HTLCs (audited; staked solvers) | Contract yes, network no |
| Solana | The escrow program from [my earlier post](nervos-talk-post.md) (devnet) | Yes. Shown earlier |
| Cardano | Konduit / Cardano Lightning cheques (SHA2-256); public Aiken validators | Not as is. See section 5 |
| Bitcoin | Lightning | Through Fiber's own hub, once a wrapped BTC exists on mainnet |

Two things that look compatible are not. 1inch Fusion+ hard-codes keccak256 in its [escrow](https://github.com/1inch/cross-chain-swap/blob/master/contracts/BaseEscrow.sol) and its resolvers are gated. And Fiber's own draft submarine-swap lock ([PR #1643](https://github.com/nervosnetwork/fiber/pull/1643)) is blake2b only, which would cut it off from everything in this table.

## 4. Experiment: Fiber ⇄ native ETH with Boltz's contract, unmodified

Setup: two Fiber v0.9.1 nodes on CKB testnet with one channel; EtherSwap v6 deployed to Sepolia straight from the published `boltz-core` 5.0.0 build artifact ([`0xDcD8…b431`](https://sepolia.etherscan.io/address/0xDcD88d2fE9d521F5bF6B7B44479F3866c6ceb431)). The whole test is one script, [`lnroute/eth-swap.mjs`](../lnroute/eth-swap.mjs), about 150 lines.

| Run | Paid | Received | Time | Ethereum transactions | Gas |
|---|---|---|---|---|---|
| CKB → ETH | 300 CKB over Fiber | 0.0001368 ETH | 23.5 s | [lock](https://sepolia.etherscan.io/tx/0x3c3cb69a72c3a3a6c06afec9deb8e9a89611e32eeb39b09bde4feeb53a6fddce), [claim](https://sepolia.etherscan.io/tx/0xaa30616a03d2ed39e589014d83835389f348420e23add5c8f81f1267618044a1) | 135,617 + 35,257 |
| ETH → CKB | 0.0002 ETH | 435.06 CKB over Fiber | 25.7 s | [lock](https://sepolia.etherscan.io/tx/0xeb944d9c936a31769ef9d90d569cb01f14aa7ca6166f3a4b66adaf7cff5a3055), [claim](https://sepolia.etherscan.io/tx/0xf0f2703e2d713f9be18da0aca47b840bc98dbdec9feca7280d20b7326132eb06) | 135,629 + 32,580 |

Almost all of the time is two Sepolia blocks. The CKB leg leaves nothing on chain.

**CKB → ETH.** The user picks the secret. The LP issues a Fiber hold invoice on its hash, the user pays it, and the LP locks ETH in EtherSwap for 15 blocks. The claim reveals the secret on Ethereum, and the LP uses it to settle the invoice.

**ETH → CKB.** The user's Fiber node issues an ordinary SHA-256 invoice. The user locks ETH on that hash, the LP pays the invoice, Fiber hands the LP the secret, and the LP claims the ETH.

Three things from EtherSwap turned out to matter:

- **A user with no ETH can still receive.** EtherSwap has a `claim` variant that anyone may submit and that can only pay the recorded recipient. In the CKB → ETH run the LP's key submitted the claim and the ETH went to the user. (The user address did hold test ETH from the earlier run, so the strict zero-balance case is not what was shown.) A user who relies on the LP as the only relayer should keep a way to claim before the lock expires, because by then the LP holds their CKB payment.
- **An honest LP can release a stuck user at once.** In the ETH → CKB direction the user's ETH lock has to outlive the Fiber payment, which is about 7 hours (section 8). EtherSwap's `refundCooperative` lets the LP sign the ETH back immediately if it cannot pay.
- **Sepolia is not a guide to mainnet gas.** The same `lock` simulates at 47,417 gas against Ethereum mainnet and cost about 135,600 on Sepolia. Sepolia block headers already carry fields from the next fork, and a plain transfer to a never-used address cost 204,600 gas there instead of 21,000 (section 6). That fits a fork that raises the price of creating state. I did not confirm which change is responsible.

Caveats on the contract itself: I found no public audit of EtherSwap, and Boltz the service has been [suspended since August](https://crypto.news/boltz-halts-swaps-as-ai-attacks-outpace-its-team/) over a bug in its EVM integration that has not been described publicly. The contract has no owner and nothing here depends on Boltz's servers, but anyone taking this to mainnet should read the contract and that incident first. The npm package says AGPL-3.0 while the LICENSE file in it says MIT.

## 5. Cardano

Cardano has no ready-made rail for this, and I expected to reuse a public validator the way I reused Boltz's contract. Neither of the two I found works unmodified:

| Validator | Hash | Receiver | Deadline | Verdict |
|---|---|---|---|---|
| [`cardano-scaling/htlc`](https://github.com/cardano-scaling/htlc) (from the Hydra HTLC demo) | `blake2b_256` | Must sign the claim | Claim before, refund after | Right shape, wrong hash for a Fiber payment |
| [Cardano Foundation template](https://github.com/cardano-foundation/cardano-template-and-ecosystem-monitoring/tree/main/htlc) | `sha2_256` | None | Refund only | Not safe as a swap leg: in my test a third party claimed after expiry with only the secret |

So the measured leg is `cardano-scaling`'s validator with one builtin swapped, `blake2b_256` for `sha2_256`, plus a check that the secret is 32 bytes ([`cardano/onchain/validators/htlc_sha256.ak`](../cardano/onchain/validators/htlc_sha256.ak)). Neither repository states an audit.

Costs, with mainnet protocol parameters (epoch 667):

| Transaction | Fee | Notes |
|---|---|---|
| Lock | 0.172 ADA | No script runs. The locked output must hold at least 1.35 ADA |
| Claim | 0.192 ADA | Script read from a reference input; 0.210 ADA with the script attached |
| Refund | 0.190 ADA | |
| **Lock + claim** | **0.364 ADA** | About $0.06 at $0.172 per ADA |
| Publish the reference script | 0.199 ADA | Once, plus a 3.95 ADA deposit that can be recovered |

How this was measured matters. The transactions were built and run in Lucid's emulator, which does not execute scripts when a transaction is submitted. So every script transaction was also evaluated by a real node on Cardano's preprod network (through Koios), which returned the same execution units and rejected a claim with a tampered secret. Fees were recomputed from the protocol parameters. **Nothing was submitted to a live Cardano network**: the preprod faucet needs a CAPTCHA, and the test wallet is unfunded. The runner takes `--network preprod` once it is.

Three things are specific to Cardano:

- **A receiver with no ADA cannot claim alone.** Spending from a script needs collateral (about 0.29 ADA here) and this validator needs the receiver's signature. A sponsor can supply the fee and collateral while the receiver co-signs, and that worked, but it is an interactive round, not a relay like EtherSwap's. The secret sits in the redeemer, so a sponsor who is also the counterparty must be given only the transaction body to sign.
- **The smallest swap is about 1.35 ADA**, the minimum the locked output must carry.
- **The channel projects are the ones to watch.** Konduit and Cardano Lightning use exactly the right lock (SHA2-256 over a 32-byte secret), but only the ADA → Lightning direction is productised and neither is audited. Hydra's hash-locks are demos.

## 6. A swap whose only contract is on CKB

Every design above needs a contract on the foreign chain. That contract has to be written, audited and deployed once per chain, and on Cardano there is no audited one to reuse. This section describes a way to do without it.

### The idea

The user picks a secret number *a* and the LP picks *b*. Each publishes the matching public key, *A* and *B*. The address with public key *A + B* is an ordinary account on the foreign chain, and its private key is *a + b*. Neither side knows that sum, so neither can move funds from it alone.

A lock on CKB then enforces one rule: **whoever takes the CKB must publish their number**. Once *b* is on chain, the user knows *a + b* and can empty the foreign address with a normal transfer.

The foreign chain sees two ordinary transfers. It runs no script and stores no hash, and nothing on it links the transfers to CKB.

The pattern is not mine. It comes from Bitcoin–Monero swaps ([Gugger 2020](https://arxiv.org/abs/2101.12332)). There, Bitcoin cannot check a Monero key, so the protocol needs adaptor signatures and a cross-curve proof that the two chains' secrets match. **CKB-VM can simply compute *b · G* on the foreign curve and compare it with *B*.** The whole cross-curve machinery reduces to one scalar multiplication in the lock. One lock with an Ed25519 mode covers Solana and Cardano, and in principle other Ed25519 chains such as Sui, Aptos, Stellar and NEAR. A secp256k1 mode covers every EVM chain and, in principle, Bitcoin-family chains.

### The protocol (CKB → foreign coin)

Before anything is locked, each side proves it knows its own number, so that neither can pick a public key that cancels the other's.

1. The user locks CKB in a cell under the share lock (CKB transaction 1).
2. The LP sends the foreign coin to the address *A + B* (foreign transfer 1).
3. The user waits until that transfer is final, then sends the LP a release secret off chain.
4. The LP claims the CKB. The witness must contain *b* and the release secret (CKB transaction 2).
5. The user reads *b* from the CKB transaction and sweeps the foreign address with *a + b* (foreign transfer 2).

The lock has two more paths:

- **Refund, after time t1.** The user takes the CKB back and must publish *a*. If the LP had already funded the foreign address, it now knows *a + b* and recovers its coins.
- **Punish, after a later time t2.** If the user neither releases nor refunds, the LP's coins are stuck for good, so the LP may take the CKB instead.

The release secret in step 3 is there because the LP funds second. Without it the LP could claim the CKB and then double-spend its own unconfirmed transfer.

For the other direction the roles swap: the LP locks CKB, the user funds the joint address, and the user's claim on CKB publishes *a*. The claim pays its own fee out of the cell, so the user needs no CKB to receive.

### What I measured

**Foreign half.** A joint address was funded with a plain transfer and emptied with a plain transfer signed by *a + b*; neither share alone could sign for it.

| Chain | Fund | Sweep | Programs or contracts used |
|---|---|---|---|
| Solana devnet ([`keyshare-test.mjs`](../solana/client/keyshare-test.mjs)) | [tx](https://explorer.solana.com/tx/2naS99dziMbbUgqzqtEdp5NEYo9wzswYVeBbBJVuz5R62E8FP5sa6hMGokddZLUiws22MQvrWYeyDFcfftXfpvwe?cluster=devnet), 5,000 lamports | [tx](https://explorer.solana.com/tx/xZMMdXp3fsd6HD2WjwELVyyZGapM2vnqrYTDjd6mA6jSqWc1azNnhGruk6DS7oL1jph1cXv19VUekhDzd7X5MVR?cluster=devnet), 5,000 lamports | System program only |
| Sepolia ([`keyshare-eth.mjs`](../lnroute/keyshare-eth.mjs)) | [tx](https://sepolia.etherscan.io/tx/0xa60c6e834d45e9709f31480bcb8577bf18bf825e57116096e952b09d6f475c24), 204,600 gas | [tx](https://sepolia.etherscan.io/tx/0x4591296f0b7a093e697e7da21fd53496d03ced153ae7064393d4527a1c0b38d7), 21,000 gas | None |
| Cardano, emulator with mainnet parameters ([`plainkey.mjs`](../cardano/plainkey.mjs)) | 0.167 ADA | 0.165 ADA | None; no collateral |

On Cardano the emulator does check signatures: a signature from one share alone, a corrupted one, and a valid one from the wrong key were all rejected.

**CKB half.** The lock is [`ckb-keyshare/`](../ckb-keyshare/src/main.rs), about 320 lines of Rust on `ckb-std`, using `curve25519-dalek` and `k256` for the two curves. It was run in real CKB-VM through `ckb-testtool` (10 tests, with dozens of rejected spends per curve, each checked against its own error code). It has not been deployed.

| Curve | Claim (reveal *b*) | Refund (reveal *a*) | Punish | Transaction size |
|---|---|---|---|---|
| Ed25519 | 2,232,165 cycles | 2,222,828 | 54,196 | 482–546 bytes |
| secp256k1 | 2,442,807 cycles | 2,434,364 | 54,148 | 484–548 bytes |

For scale, the default relay limit is 70,000,000 cycles per transaction, so the key check uses about 3% of it. A cell under the lock needs 61 CKB, the same as an ordinary cell, because the parameters travel in the witness and the lock args hold only their hash. The binary with both curves is 106,392 bytes; with Ed25519 alone it is 36,096 bytes. A precomputed table brings the Ed25519 claim down to about 0.8 million cycles for 30 KB more code.

The tests also tie the lock to the property the swap relies on: they read *b* out of an accepted claim, add *a*, and confirm that the sum signs for *A + B* under an independent library.

One thing I got wrong in the first version is worth passing on. The lock checked where the outputs went but not how much they held. Once a claim is broadcast, *b* and the release secret are public, so anyone could rebuild the transaction with a tiny output and leave the rest as fee. The lock now requires the outputs to hold everything except at most 0.001 CKB.

### Where it is better and where it is not

| | Hash-locked swap (sections 4–5) | Key-share swap |
|---|---|---|
| Contract on the foreign chain | Needed, per chain | None |
| Works over a Fiber channel | Yes | No. Fiber can lock to a hash, not to a key |
| CKB transactions per swap | 0 over Fiber, 2 on L1 | 2 |
| Foreign transactions per swap | 2 contract calls | 2 plain transfers |
| Link between the two chains | The same hash appears on both | None visible on the foreign chain |
| Side that can stall the other | The secret holder | The side that locked CKB, until t1 |
| Receiver with no coins on the foreign chain | Needs a relayer (Ethereum) or a co-signing sponsor with collateral (Cardano) | The sweep pays its own fee from the joint address |
| New failure mode | None | If both a claim and a refund reach the mempool, both numbers are public and the foreign address is a race |

So this is not a faster or fairer swap. It gives the user the same kind of option, and it costs two CKB transactions where Fiber costs none. On Ethereum it is not even reliably cheaper: under mainnet rules two transfers are 42,000 gas against roughly 82,000–107,000 for EtherSwap's lock and claim, but on Sepolia's newer gas rules the two transfers cost 225,600 against 170,874.

Its value is reach. It works on a chain where no audited swap contract exists, or where no contract can exist at all, and adding a chain means adding nothing on that chain.

It also says something about PTLCs. If Fiber payments were locked to a point instead of a hash, settling a payment would itself reveal a secp256k1 number, and that number could be the LP's share of a joint Ethereum or Bitcoin address. The CKB leg would then be off chain as well. One problem remains even then: a channel payment that times out does not make the payer reveal anything, so an LP that funded the joint address has no refund path. On Cardano and Bitcoin a pre-signed, time-locked refund transaction could close that gap; on account-based chains I do not see how. I have not built any of this.

## 7. One LP, not one per chain

The usual objection to atomic swaps is that every pair needs its own market maker. For CKB that is the wrong picture.

ETH, SOL and ADA already trade against each other on solver networks. NEAR Intents carries all three natively (ADA through its federated bridge). Its dry-run quotes came back 0.2–0.6% below mid all-in, with its [API fee](https://docs.near-intents.org/near-intents/fees) included (section 2). The one asset those networks lack is CKB. So the missing piece is a single adapter:

- **One LP that specializes in CKB.** It runs a Fiber node and holds small floats of ETH, SOL and ADA.
- **One secret per swap, one small adapter per chain.** The whole Ethereum test here is about 150 lines, and it reuses the Solana LP's Fiber helper library.
- **Floats rebalance against each other on a solver network**, with no exchange account involved.
- **Only net CKB flow touches an exchange**, because that is the only place CKB trades.

It needs two front doors that share the same secret. A Fiber channel suits someone who swaps often. For a one-off swap, Fiber on mainnet means opening a channel to the LP first, which is an L1 transaction anyway, so an L1 hash-locked cell (as in Swap book) is just as cheap and needs no node. The LP's foreign-chain side is identical for both.

The longer route to the same place is getting CKB listed on a solver network, so that every solver becomes an LP. One detail makes that less far-fetched than it sounds: NEAR's MPC signer signs any 32-byte digest with secp256k1, which is exactly what a CKB transaction needs, so an MPC-controlled CKB address requires no change on NEAR's side. Verifying CKB deposits would still need a CKB light client or a change to the MPC nodes, and listing is the operators' decision. The SP1 proof of CKB's proof-of-work from the bridge track of this project is the kind of component that deposit check would need.

## 8. What Fiber could change

These swaps are limited less by cryptography than by four settings in Fiber. Each is small.

1. **Allow a short final expiry on a direct channel.** The minimum final TLC expiry is 160 minutes, and in practice a payment has to be capped with `tlc_expiry_limit: 24000000` to get a predictable 6 h 40 min. In the foreign → CKB direction the user's foreign lock must outlive that, so it is about 7 hours. Between two channel partners that are both online, minutes would do.
2. **Accept SHA-256 in the submarine-swap lock** ([PR #1643](https://github.com/nervosnetwork/fiber/pull/1643)), so that the L1 door and the channel door share a hash with each other and with the contracts in section 3.
3. **A hold fee or prepaid fee.** There is none today, so whoever locks first can be stalled for free. Until there is one, an LP can ask for a small prepaid Fiber payment before it locks, which needs no on-chain step.
4. **PTLCs**, with the use in section 6 in mind.

How long each side can be stalled today:

| Direction | Who can wait and watch the price | User's funds stuck at worst | LP's funds stuck at worst |
|---|---|---|---|
| CKB → foreign | User, about 3 minutes (the LP's foreign lock) | 6 h 40 min if the LP vanishes; seconds if it cancels the invoice | About 3 minutes |
| Foreign → CKB | LP, for the life of the invoice | About 7 hours if the LP vanishes; seconds with a cooperative refund | Nothing |

## 9. What I would build, per chain

| To | Route | Why |
|---|---|---|
| ETH | Fiber or an L1 cell, against EtherSwap on an L2 where it is already deployed, or redeployed on L1 | Works today with existing code; fees under a cent on an L2 |
| SOL | Fiber against the escrow program from the earlier post | Built and tested; 4–6 seconds |
| ADA | Fiber or an L1 cell against the SHA-256 hash-lock validator from section 5, once it has run on a live network and been reviewed. The key-share lock is the alternative that needs no validator and no collateral | No audited contract exists to reuse; about 0.35 ADA per swap either way |
| Any chain with no usable contract | The key-share lock on CKB L1 | Nothing to deploy on the other side |

One family I set aside: the LP pays with a plain transfer and then proves the payment to a light client on CKB. It is the leanest design on paper, because the LP locks nothing in advance. But the only foreign light client in production on CKB is Bitcoin's. Chiral's Cardano verifier is on testnet, costs more cycles than the default relay limit allows in one transaction, and Cardano's certificates take tens of minutes. There is no Ethereum or Solana light client on CKB at all.

## 10. What is not shown

- Nothing here ran on mainnet, and no LP is quoting. The 0.5% spread is an estimate built from one day's order book and quotes, not a measurement.
- The key-share swap is shown in two halves (the CKB lock in CKB-VM tests, the foreign transfers on testnets), not as one end-to-end swap.
- Fiber's mainnet network is far too small to route through. A real user would open a channel directly with the LP.
- The Cardano numbers come from an emulator plus a real node's script evaluation, not from transactions on a live network.
- I did not audit EtherSwap or any Cardano validator.

## Reproduce

```
node lnroute/eth-swap.mjs --direction ckb2eth --amount 300
node lnroute/eth-swap.mjs --direction eth2ckb --amount 0.0002
node lnroute/keyshare-eth.mjs
node solana/client/keyshare-test.mjs
node cardano/measure.mjs --network emulator
# in WSL: `cargo build --release` in ckb-keyshare, then `cargo test -- --nocapture` in ckb-keyshare-tests
```

Raw logs are in `results/` (`fiber-sepolia-*.json`, `keyshare-*.json`, `cardano-htlc-costs.json`, `near-intents-dry-quotes.txt`). The Fiber and Solana setup is described in the README.

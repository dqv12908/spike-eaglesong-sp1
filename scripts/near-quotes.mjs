// Dry-run quotes from NEAR Intents 1Click between native ETH, SOL and ADA, against CoinGecko mid-market at the same moment.
// Nothing is sent: dry:true returns a price only. Addresses are throwaway placeholders.  node scripts/near-quotes.mjs
const toks = await (await fetch("https://1click.chaindefuser.com/v0/tokens")).json();
const pick = (chain, sym) => toks.find(t => t.blockchain === chain && t.symbol === sym);
const ETH = pick("eth","ETH"), SOL = pick("sol","SOL"), ADA = pick("cardano","ADA"), USDC = pick("eth","USDC");
console.log([ETH,SOL,ADA,USDC].map(t=>t&&`${t.symbol}@${t.blockchain} ${t.assetId} dec ${t.decimals} px ${t.price}`).join("\n"));
const cg = await (await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum,solana,cardano,nervos-network&vs_currencies=usd")).json();
console.log("coingecko", JSON.stringify(cg), new Date().toISOString());
const addr = { eth: "0x" + (await import("node:crypto")).randomBytes(20).toString("hex"), sol: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", cardano: "addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8" };
const usd = { ETH: cg.ethereum.usd, SOL: cg.solana.usd, ADA: cg.cardano.usd };
async function quote(from, to, human) {
  const body = { dry: true, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: from.assetId, depositType: "ORIGIN_CHAIN", destinationAsset: to.assetId,
    amount: BigInt(Math.round(human * 10 ** Math.min(from.decimals, 9))) * 10n ** BigInt(Math.max(from.decimals - 9, 0)) + "", refundTo: addr[from.blockchain], refundType: "ORIGIN_CHAIN",
    recipient: addr[to.blockchain], recipientType: "DESTINATION_CHAIN", deadline: new Date(Date.now() + 3600e3).toISOString() };
  const r = await fetch("https://1click.chaindefuser.com/v0/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json(); const q = j.quote;
  if (!q) return console.log(from.symbol, "->", to.symbol, "ERR", JSON.stringify(j).slice(0, 300));
  const out = Number(q.amountOut) / 10 ** to.decimals, mid = human * usd[from.symbol] / usd[to.symbol];
  console.log(`${human} ${from.symbol} -> ${out} ${to.symbol} | mid ${mid.toFixed(6)} | below mid ${((1 - out / mid) * 100).toFixed(3)}% | minOut ${q.minAmountOut} | est ${q.timeEstimate}s | usdIn ${q.amountInUsd} usdOut ${q.amountOutUsd}`);
}
for (const [f, t, a] of [[ETH, SOL, 0.5], [SOL, ETH, 10], [ETH, ADA, 0.5], [ADA, ETH, 3000], [SOL, ADA, 10], [ADA, SOL, 3000], [ETH, SOL, 0.05]]) await quote(f, t, a).catch(e => console.log("fail", e.message));

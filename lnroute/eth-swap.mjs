// CKB over Fiber <-> native ETH on Sepolia, both legs locked to one SHA-256 secret.
// The Ethereum leg is Boltz's EtherSwap v6 (MIT), deployed unmodified from the boltz-core 5.0.0 build artifact
// (eth/EtherSwap.artifact.json). Nothing on the Ethereum side was written for this test.
//
//   node eth-swap.mjs --direction eth2ckb --amount 0.0002     user locks ETH, LP pays CKB over Fiber
//   node eth-swap.mjs --direction ckb2eth --amount 300        user pays CKB over Fiber, LP locks ETH
//   options: --env <.env with ETH_SEPOLIA_RPC, ETH_PRIVKEY>  --out <report.json>  --user-fiber / --lp-fiber <rpc url>
//
// One process plays both parties so the run is easy to read; each "user" and "lp" step only uses that
// party's own keys and node. The LP's Ethereum key is ETH_PRIVKEY. The user's Ethereum key is a fresh one
// kept in eth/user-eth.local.json (testnet only, ignored by git).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JsonRpcProvider, Wallet, Contract, ContractFactory, formatEther, parseEther, formatUnits } from "../solana/client/eth-lib.mjs";
import { rpc, sleep, hexOf, SHANNONS, ckbStr, findTlc } from "./fiber-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const ENVF = arg("env", "E:/ckbuilder/testnet/.env");
const envVal = (name) => {
  const m = readFileSync(ENVF, "utf8").match(new RegExp(`^\\s*${name}\\s*=\\s*["']?([^"'\\r\\n]+)["']?\\s*$`, "m"));
  if (!m) throw new Error(`${name} not found in the env file`);
  return m[1].trim();
};
const USERF = arg("user-fiber", "http://127.0.0.1:8227"), LPF = arg("lp-fiber", "http://127.0.0.1:8237");
const DIRECTION = arg("direction", "ckb2eth"), AMOUNT = arg("amount", DIRECTION === "ckb2eth" ? "300" : "0.0002");
const SPREAD_BPS = 40n, TLC_LIMIT_MS = 24_000_000, BLOCK_SECS = 12;
const FWD_TTL_BLOCKS = 15;                                  // LP's ETH lock in ckb2eth: 15 blocks, about 3 min
const REV_TTL_BLOCKS = Math.ceil((24_000 + 1_200 + 300) / BLOCK_SECS); // user's ETH lock in eth2ckb: outlives the Fiber TLC
const sha256 = (b) => createHash("sha256").update(b).digest();
const hx = (b) => "0x" + Buffer.from(b).toString("hex");
const t0 = Date.now(), steps = [];
const step = (who, what, extra = {}) => { const s = { t: +((Date.now() - t0) / 1000).toFixed(1), who, what, ...extra }; steps.push(s); console.log(`[${s.t.toFixed(1).padStart(5)}s] ${who.padEnd(4)} ${what}${extra.tx ? `\n             https://sepolia.etherscan.io/tx/${extra.tx}` : ""}`); };

const provider = new JsonRpcProvider(envVal("ETH_SEPOLIA_RPC"));
const lp = new Wallet(envVal("ETH_PRIVKEY"), provider);
const userKeyFile = join(HERE, "eth", "user-eth.local.json");
if (!existsSync(userKeyFile)) writeFileSync(userKeyFile, JSON.stringify({ note: "Sepolia test key for eth-swap.mjs", privateKey: hx(randomBytes(32)) }));
const user = new Wallet(JSON.parse(readFileSync(userKeyFile, "utf8")).privateKey, provider);

const artifact = JSON.parse(readFileSync(join(HERE, "eth", "EtherSwap.artifact.json"), "utf8"));
const depFile = join(HERE, "eth", "deployment.sepolia.json");
async function etherSwap() {
  if (existsSync(depFile)) {
    const d = JSON.parse(readFileSync(depFile, "utf8"));
    if ((await provider.getCode(d.address)).length > 2) return new Contract(d.address, artifact.abi, provider);
  }
  const c = await new ContractFactory(artifact.abi, artifact.bytecode.object, lp).deploy();
  const rc = await c.deploymentTransaction().wait();
  const d = { network: "sepolia", contract: "EtherSwap v6 (boltz-core 5.0.0 artifact, unmodified)", address: await c.getAddress(), tx: rc.hash, block: rc.blockNumber, gas_used: rc.gasUsed.toString() };
  writeFileSync(depFile, JSON.stringify(d, null, 1));
  console.log(`deployed EtherSwap at ${d.address} (gas ${d.gas_used})`);
  return new Contract(d.address, artifact.abi, provider);
}
const LOCK = "lock(bytes32,address,uint256)", CLAIM_FOR = "claim(bytes32,uint256,address,address,uint256)", CLAIM_SELF = "claim(bytes32,uint256,address,uint256)";
const gasInfo = (rc) => ({ tx: rc.hash, gas_used: rc.gasUsed.toString(), gas_price_gwei: formatUnits(rc.gasPrice, "gwei"), fee_eth: formatEther(rc.gasUsed * rc.gasPrice) });

async function prices() {
  const j = await (await fetch("https://api.coingecko.com/api/v3/simple/price?ids=nervos-network,ethereum&vs_currencies=usd", { signal: AbortSignal.timeout(8000) })).json();
  return { ckb_usd: j["nervos-network"].usd, eth_usd: j.ethereum.usd };
}
const poll = async (fn, ok, secs, every = 400) => { for (let i = 0; i < (secs * 1000) / every; i++) { const v = await fn(); if (ok(v)) return v; await sleep(every); } throw new Error("timed out"); };

const swap = await etherSwap();
const version = Number(await swap.version());
const px = await prices();
const out = { direction: DIRECTION, network: { ckb: "testnet (Fiber)", eth: "sepolia" }, etherswap: await swap.getAddress(), etherswap_version: version, prices: px, spread_bps: Number(SPREAD_BPS), lp_eth: lp.address, user_eth: user.address };
console.log(`EtherSwap v${version} at ${out.etherswap}; LP ${lp.address} has ${formatEther(await provider.getBalance(lp.address))} ETH; user ${user.address} has ${formatEther(await provider.getBalance(user.address))} ETH`);

if (DIRECTION === "ckb2eth") {
  // The user holds the secret. Order: user's CKB is held on Fiber first, then the LP locks ETH, then the claim reveals the secret.
  const shannons = BigInt(Math.round(Number(AMOUNT) * 1e8));
  const wei = BigInt(Math.floor((Number(AMOUNT) * px.ckb_usd / px.eth_usd) * 1e18)) * (10_000n - SPREAD_BPS) / 10_000n;
  const secret = randomBytes(32), H = sha256(secret);
  const ethBefore = await provider.getBalance(user.address);
  step("user", `secret chosen, H = sha256(secret) = ${H.toString("hex")}; quote ${ckbStr(shannons)} CKB -> ${formatEther(wei)} ETH`);

  const inv = await rpc(LPF, "new_invoice", { amount: hexOf(shannons), currency: "Fibt", description: "CKB to ETH swap", expiry: hexOf(600), payment_hash: hx(H), hash_algorithm: "sha256" });
  step("lp", "Fiber hold invoice issued on H");
  await rpc(USERF, "send_payment", { invoice: inv.invoice_address, tlc_expiry_limit: hexOf(TLC_LIMIT_MS) });
  step("user", `paid the invoice: ${ckbStr(shannons)} CKB in flight, locked to H`);
  await poll(() => rpc(LPF, "get_invoice", { payment_hash: hx(H) }), (i) => i.status === "Received", 60);
  const tlc = await findTlc(LPF, hx(H));
  const tlcLeft = tlc ? Math.floor(tlc.expiry_ms / 1000 - Date.now() / 1000) : 0;
  if (!tlc || tlc.amount < shannons || tlcLeft < FWD_TTL_BLOCKS * BLOCK_SECS + 3600) throw new Error("held TLC not acceptable");
  step("lp", `payment held (TLC ${ckbStr(tlc.amount)} CKB, expires in ${tlcLeft}s)`);

  const timelock = (await provider.getBlockNumber()) + FWD_TTL_BLOCKS;
  const lockRc = await (await swap.connect(lp)[LOCK](hx(H), user.address, timelock, { value: wei })).wait();
  step("lp", `locked ${formatEther(wei)} ETH in EtherSwap for the user until block ${timelock}`, gasInfo(lockRc));

  // The user checks the lock on chain before revealing anything.
  const key = await swap.hashValues(hx(H), wei, user.address, lp.address, timelock);
  const blocksLeft = timelock - (await provider.getBlockNumber());
  if (!(await swap.swaps(key)) || blocksLeft < 5) throw new Error("ETH lock missing or too short");
  step("user", `verified the lock (right hash, amount and recipient; ${blocksLeft} blocks left)`);

  // The user has no ETH for gas. EtherSwap's 5-argument claim pays claimAddress whoever submits it, so a relayer
  // sends it. The LP's key acts as the relayer here; any account could.
  const claimRc = await (await swap.connect(lp)[CLAIM_FOR](hx(secret), wei, user.address, lp.address, timelock)).wait();
  step("relay", `claim submitted for the user; secret is now public on Ethereum`, gasInfo(claimRc));

  const ev = claimRc.logs.map((l) => { try { return swap.interface.parseLog(l); } catch { return null; } }).find((l) => l?.name === "Claim");
  const learned = Buffer.from(ev.args.preimage.slice(2), "hex");
  if (!sha256(learned).equals(H)) throw new Error("preimage in the Claim event does not match H");
  await rpc(LPF, "settle_invoice", { payment_hash: hx(H), payment_preimage: hx(learned) });
  step("lp", "read the secret from the Claim event and settled the Fiber invoice");
  const pay = await poll(() => rpc(USERF, "get_payment", { payment_hash: hx(H) }), (p) => p.status === "Success" || p.status === "Failed", 60);
  if (pay.status !== "Success") throw new Error(`Fiber payment ${pay.status}: ${pay.failed_error}`);
  const got = (await provider.getBalance(user.address)) - ethBefore;
  step("user", `Fiber payment settled; ETH received ${formatEther(got)} (address held ${formatEther(ethBefore)} ETH before)`);
  Object.assign(out, { payment_hash: H.toString("hex"), ckb_paid: ckbStr(shannons), eth_received: formatEther(got), eth_timelock_blocks: FWD_TTL_BLOCKS, fiber_tlc_secs_left_at_lock: tlcLeft, lock: gasInfo(lockRc), claim: gasInfo(claimRc), user_eth_before: formatEther(ethBefore) });
} else if (DIRECTION === "eth2ckb") {
  // The user's Fiber node holds the secret. Order: user locks ETH, LP pays the invoice, the payment hands the LP the secret.
  const wei = parseEther(AMOUNT);
  const shannons = BigInt(Math.floor((Number(AMOUNT) * px.eth_usd / px.ckb_usd) * 1e8)) * (10_000n - SPREAD_BPS) / 10_000n;
  const need = wei + parseEther("0.002");
  if ((await provider.getBalance(user.address)) < need) {
    const rc = await (await lp.sendTransaction({ to: user.address, value: need })).wait();
    step("setup", `test faucet: sent the user ${formatEther(need)} Sepolia ETH so it has something to swap`, { tx: rc.hash });
  }
  const inv = await rpc(USERF, "new_invoice", { amount: hexOf(shannons), currency: "Fibt", description: "ETH to CKB swap", expiry: hexOf(600), hash_algorithm: "sha256" });
  const H = Buffer.from(inv.invoice.data.payment_hash.replace(/^0x/, ""), "hex");
  step("user", `Fiber invoice for ${ckbStr(shannons)} CKB, payment hash H = ${H.toString("hex")} (the node keeps the secret)`);

  const timelock = (await provider.getBlockNumber()) + REV_TTL_BLOCKS;
  const lockRc = await (await swap.connect(user)[LOCK](hx(H), lp.address, timelock, { value: wei })).wait();
  step("user", `locked ${formatEther(wei)} ETH in EtherSwap for the LP until block ${timelock} (about ${(REV_TTL_BLOCKS * BLOCK_SECS / 3600).toFixed(1)} h)`, gasInfo(lockRc));

  const key = await swap.hashValues(hx(H), wei, lp.address, user.address, timelock);
  const secsLeft = (timelock - (await provider.getBlockNumber())) * BLOCK_SECS;
  if (!(await swap.swaps(key)) || secsLeft < TLC_LIMIT_MS / 1000 + 1_200) throw new Error("ETH lock missing or does not outlive the Fiber TLC");
  step("lp", `verified the lock (${secsLeft}s left, longer than the ${TLC_LIMIT_MS / 1000}s Fiber TLC cap plus margin)`);
  await rpc(LPF, "send_payment", { invoice: inv.invoice_address, tlc_expiry_limit: hexOf(TLC_LIMIT_MS) });
  step("lp", `paying ${ckbStr(shannons)} CKB over Fiber`);
  const pay = await poll(() => rpc(LPF, "get_payment", { payment_hash: hx(H) }), (p) => p.status === "Success" || p.status === "Failed", 90);
  if (pay.status !== "Success") throw new Error(`Fiber payment ${pay.status}: ${pay.failed_error}`);
  const pre = Buffer.from((pay.payment_preimage || "").replace(/^0x/, ""), "hex");
  if (pre.length !== 32 || !sha256(pre).equals(H)) throw new Error("payment succeeded but no valid preimage returned");
  step("lp", "Fiber payment settled; the user's node released the secret");
  const claimRc = await (await swap.connect(lp)[CLAIM_SELF](hx(pre), wei, user.address, timelock)).wait();
  step("lp", `claimed ${formatEther(wei)} ETH with the secret`, gasInfo(claimRc));
  Object.assign(out, { payment_hash: H.toString("hex"), eth_paid: formatEther(wei), ckb_received: ckbStr(shannons), eth_timelock_blocks: REV_TTL_BLOCKS, lock: gasInfo(lockRc), claim: gasInfo(claimRc), fiber_fee: pay.fee });
} else throw new Error("--direction must be ckb2eth or eth2ckb");

out.elapsed_s = +((Date.now() - t0) / 1000).toFixed(1);
out.steps = steps;
console.log(`DONE in ${out.elapsed_s}s`);
if (arg("out")) writeFileSync(arg("out"), JSON.stringify(out, null, 1));

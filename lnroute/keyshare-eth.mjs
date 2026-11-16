// Key-share check on Sepolia (Ethereum half of the contract-free swap design in docs/nervos-talk-research.md).
// An ordinary account whose private key is the SUM of two parties' secp256k1 scalars is funded with a plain
// transfer and emptied with a plain transfer. No contract is deployed or called: both transactions are 21,000 gas.
//
//   node keyshare-eth.mjs [--env <.env with ETH_SEPOLIA_RPC, ETH_PRIVKEY>] [--out report.json] [--amount 0.0002]
//
// This shows only the foreign-chain half. The CKB lock that forces a share to be revealed is ckb-keyshare/.
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JsonRpcProvider, Wallet, SigningKey, computeAddress, formatEther, parseEther, toBeHex } from "../solana/client/eth-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const ENVF = arg("env", "E:/ckbuilder/testnet/.env");
const envVal = (name) => readFileSync(ENVF, "utf8").match(new RegExp(`^\\s*${name}\\s*=\\s*["']?([^"'\\r\\n]+)["']?\\s*$`, "m"))[1].trim();
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n; // secp256k1 group order
const randScalar = () => { let k; do k = BigInt("0x" + randomBytes(40).toString("hex")) % N; while (k === 0n); return k; };
const key = (k) => toBeHex(k, 32);

const provider = new JsonRpcProvider(envVal("ETH_SEPOLIA_RPC"));
const lp = new Wallet(envVal("ETH_PRIVKEY"), provider);
const userAddr = new Wallet(JSON.parse(readFileSync(join(HERE, "eth", "user-eth.local.json"), "utf8")).privateKey).address;

const a = randScalar(), b = randScalar();                       // a: user's share, b: LP's share
const A = SigningKey.computePublicKey(key(a), true), B = SigningKey.computePublicKey(key(b), true);
const joint = computeAddress(SigningKey.addPoints(A, B, false)); // address of the point A + B
const out = { network: "sepolia", joint_address: joint, share_pub_user: A, share_pub_lp: B,
  user_share_alone_controls_it: computeAddress(A) === joint, lp_share_alone_controls_it: computeAddress(B) === joint };
console.log(`joint address ${joint} = address of (A_user + B_lp)`);

// 1. The LP funds the joint address with a plain transfer.
const amount = parseEther(arg("amount", "0.0002"));
const fund = await (await lp.sendTransaction({ to: joint, value: amount })).wait();
console.log(`funded ${formatEther(amount)} ETH, gas ${fund.gasUsed}: https://sepolia.etherscan.io/tx/${fund.hash}`);

// 2. Once the LP's share is public, the user holds a + b and sweeps to their own address. The joint account pays the gas.
const sum = new Wallet(key((a + b) % N), provider);
if (sum.address !== joint) throw new Error("a + b does not control the joint address");
const gasPrice = ((await provider.getFeeData()).gasPrice ?? 1n) * 2n + 1n;
const bal = await provider.getBalance(joint);
const sweep = await (await sum.sendTransaction({ to: userAddr, value: bal - 21000n * gasPrice, gasLimit: 21000n, gasPrice, type: 0 })).wait();
console.log(`swept to ${userAddr}, gas ${sweep.gasUsed}: https://sepolia.etherscan.io/tx/${sweep.hash}`);

Object.assign(out, {
  fund_tx: fund.hash, fund_gas: fund.gasUsed.toString(), sweep_tx: sweep.hash, sweep_gas: sweep.gasUsed.toString(),
  swept_to: userAddr, wei_funded: amount.toString(), wei_received: (bal - 21000n * gasPrice).toString(),
  joint_balance_after: (await provider.getBalance(joint)).toString(), joint_has_code: (await provider.getCode(joint)) !== "0x",
});
console.log(`joint balance after: ${out.joint_balance_after}; a share alone controls it? user ${out.user_share_alone_controls_it}, lp ${out.lp_share_alone_controls_it}`);
if (arg("out")) writeFileSync(arg("out"), JSON.stringify(out, null, 1));

// Key-share check (Solana half of the contract-free swap design in docs/nervos-talk-research.md).
// A Solana account whose private key is the SUM of two parties' Ed25519 scalars is funded with a plain
// transfer and emptied with a plain transfer signed by the combined scalar, paying its own fee.
// No program is deployed or called apart from the System program.
//
//   node keyshare-test.mjs [--env <.env with SOL_DEVNET_RPC, SOL_PRIVKEY>] [--out report.json]
//
// This shows only the foreign-chain half. The CKB lock that forces a share to be revealed is not built.
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Connection, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { loadKeypair } from "./htlc-lib.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const ENVF = arg("env", "E:/ckbuilder/testnet/.env");
const rpcUrl = readFileSync(ENVF, "utf8").match(/^\s*SOL_DEVNET_RPC\s*=\s*["']?([^"'\r\n]+)/m)?.[1]?.trim() ?? "https://api.devnet.solana.com";
const conn = new Connection(rpcUrl, "confirmed");
const funder = loadKeypair(`env:${ENVF}`); // plays the LP for funding, and is also where the user sweeps to

const L = ed25519.CURVE.n, B = ed25519.ExtendedPoint.BASE;
const le = (bytes) => BigInt("0x" + Buffer.from(bytes).reverse().toString("hex"));
const toLe32 = (n) => Buffer.from(n.toString(16).padStart(64, "0"), "hex").reverse();
const randScalar = () => { let k; do k = le(randomBytes(40)) % L; while (k === 0n); return k; };
// Ed25519 signature made directly from a scalar (no seed), so it works for a summed key.
function signWithScalar(msg, a) {
  const A = B.multiply(a).toRawBytes();
  const r = le(sha512(Buffer.concat([randomBytes(32), toLe32(a), msg]))) % L;
  const R = B.multiply(r).toRawBytes();
  const h = le(sha512(Buffer.concat([R, A, msg]))) % L;
  return Buffer.concat([R, toLe32((r + h * a) % L)]);
}

const kUser = randScalar(), kLp = randScalar();
const KUser = B.multiply(kUser), KLp = B.multiply(kLp);
const jointPoint = KUser.add(KLp), joint = new PublicKey(jointPoint.toRawBytes());
const out = { cluster: "devnet", joint_address: joint.toBase58(), k_user_pub: Buffer.from(KUser.toRawBytes()).toString("hex"), k_lp_pub: Buffer.from(KLp.toRawBytes()).toString("hex") };
console.log(`joint address ${joint.toBase58()} = K_user + K_lp`);

// 1. The LP funds the joint address with a plain transfer.
const AMOUNT = 2_000_000; // 0.002 SOL
const fundSig = await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: joint, lamports: AMOUNT })), [funder]);
console.log(`funded with ${AMOUNT} lamports: ${fundSig}`);

// 2. Neither share alone can sign for the joint address.
const probe = Buffer.from("probe");
out.user_share_alone_valid = ed25519.verify(signWithScalar(probe, kUser), probe, jointPoint.toRawBytes());
out.lp_share_alone_valid = ed25519.verify(signWithScalar(probe, kLp), probe, jointPoint.toRawBytes());

// 3. Once the LP's share is revealed, the user holds the whole key and sweeps. The joint account pays the fee.
const k = (kUser + kLp) % L;
const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
const FEE = 5000;
const tx = new Transaction({ feePayer: joint, blockhash, lastValidBlockHeight }).add(SystemProgram.transfer({ fromPubkey: joint, toPubkey: funder.publicKey, lamports: AMOUNT - FEE }));
tx.addSignature(joint, signWithScalar(tx.serializeMessage(), k));
if (!tx.verifySignatures()) throw new Error("combined-scalar signature does not verify");
const sweepSig = await conn.sendRawTransaction(tx.serialize());
await conn.confirmTransaction({ signature: sweepSig, blockhash, lastValidBlockHeight }, "confirmed");
const left = await conn.getBalance(joint);
const parsed = await conn.getParsedTransaction(sweepSig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
Object.assign(out, {
  fund_tx: fundSig, sweep_tx: sweepSig, lamports_funded: AMOUNT, lamports_swept: AMOUNT - FEE, sweep_fee_paid_by: "joint address",
  joint_balance_after: left, sweep_signatures: parsed.transaction.signatures.length,
  sweep_programs: [...new Set(parsed.transaction.message.instructions.map((i) => i.programId.toBase58()))],
});
console.log(`swept ${AMOUNT - FEE} lamports with the combined key: ${sweepSig}`);
console.log(`joint balance after: ${left}; share alone valid? user ${out.user_share_alone_valid}, lp ${out.lp_share_alone_valid}; programs used: ${out.sweep_programs.join(", ")}`);
if (arg("out")) writeFileSync(arg("out"), JSON.stringify(out, null, 1));

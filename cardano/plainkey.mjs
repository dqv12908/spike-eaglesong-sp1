// Plain-key ("summed key") check on Cardano: no script at all.
// Two Ed25519 scalars a and b with public points A and B. An enterprise address whose payment credential is
// blake2b-224 of the 32-byte compressed point A+B is funded with a plain transfer and emptied with a plain transfer
// whose only vkey witness is a standard Ed25519 signature made directly from the scalar (a+b mod L). No seed, no script.
// Same idea as solana/client/keyshare-test.mjs.
//
//   node plainkey.mjs --network emulator|preprod [--out <file.json>]
//
// This shows only the Cardano half. Whatever forces a share to be revealed on the CKB side is not part of it.
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { CML } from "@lucid-evolution/lucid";
import { ed25519 } from "@noble/curves/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { arg, hex, blake2b224, makeContext, buildTransfer, analyzeTx, resolveInputs, jsonSafe, errText, ada } from "./lib.mjs";

const L = ed25519.CURVE.n, B = ed25519.ExtendedPoint.BASE;
const le = (bytes) => BigInt("0x" + Buffer.from(bytes).reverse().toString("hex"));
const toLe32 = (n) => Buffer.from(n.toString(16).padStart(64, "0"), "hex").reverse();
const randScalar = () => { let k; do k = le(randomBytes(40)) % L; while (k === 0n); return k; };
// Ed25519 signature made directly from a scalar (no seed), so it works for a summed key.
export function signWithScalar(msg, a) {
  const A = B.multiply(a).toRawBytes();
  const r = le(sha512(Buffer.concat([randomBytes(32), toLe32(a), msg]))) % L;
  const R = B.multiply(r).toRawBytes();
  const h = le(sha512(Buffer.concat([R, A, msg]))) % L;
  return Buffer.concat([R, toLe32((r + h * a) % L)]);
}

// Puts one vkey witness (public key bytes + signature bytes) on an unsigned transaction, without lucid's signer.
function withWitness(unsignedCbor, pub, sig) {
  const tx = CML.Transaction.from_cbor_hex(unsignedCbor);
  const ws = tx.witness_set();
  const list = CML.VkeywitnessList.new();
  list.add(CML.Vkeywitness.new(CML.PublicKey.from_bytes(pub), CML.Ed25519Signature.from_raw_bytes(sig)));
  ws.set_vkeywitnesses(list);
  const signed = CML.Transaction.new(tx.body(), ws, true, tx.auxiliary_data());
  if (CML.hash_transaction(signed.body()).to_hex() !== CML.hash_transaction(tx.body()).to_hex()) throw new Error("body hash changed while attaching the witness");
  return signed.to_cbor_hex();
}

export async function runPlainKey(ctx, { amount = 5_000_000n } = {}) {
  const provider = ctx.lucid.config().provider;
  const a = randScalar(), b = randScalar();
  const A = B.multiply(a), Bp = B.multiply(b), P = A.add(Bp);
  const pub = P.toRawBytes(), keyHash = hex(blake2b224(pub));
  const joint = CML.EnterpriseAddress.new(0, CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(keyHash))).to_address().to_bech32();
  const out = { network: ctx.network, joint_address: joint, joint_key_hash_blake2b224: keyHash, point_a: hex(A.toRawBytes()), point_b: hex(Bp.toRawBytes()), point_sum: hex(pub) };
  console.log(`joint address ${joint} = blake2b-224(A + B)`);

  // 1. Fund the joint address with a plain transfer.
  const fund = await buildTransfer(ctx, { from: "maker", to: joint, lovelace: amount });
  out.fund = analyzeTx(ctx, fund, "plain-key fund (1 input, 2 outputs, 1 vkey witness)");
  await ctx.submit(fund.signed);
  console.log(`funded with ${ada(amount)} ADA, fee ${out.fund.fee_ada}, ${out.fund.size_bytes} bytes`);

  // 2. Build the sweep: every UTxO at the joint address goes back to the maker; the joint address pays the fee.
  const utxos = await ctx.lucid.utxosAt(joint);
  ctx.lucid.selectWallet.fromAddress(joint, utxos);
  const txb = await ctx.lucid.newTx().collectFrom(utxos).complete({ changeAddress: ctx.address("maker") });
  const unsigned = txb.toCBOR(), bodyHash = Buffer.from(txb.toHash(), "hex");

  // 3. Does this network check vkey signatures? Three witnesses that must be refused.
  const good = signWithScalar(bodyHash, (a + b) % L);
  const flipped = Buffer.from(good); flipped[40] ^= 1;
  const attempts = [
    { what: "signature made from share a alone, presented under the summed key", cbor: withWitness(unsigned, pub, signWithScalar(bodyHash, a)) },
    { what: "correct signature with one bit flipped", cbor: withWitness(unsigned, pub, flipped) },
    { what: "valid signature by key A alone (a key that does not own the address)", cbor: withWitness(unsigned, A.toRawBytes(), signWithScalar(bodyHash, a)) },
  ];
  out.rejected_witnesses = [];
  for (const t of attempts) {
    let rejected = false, error = null;
    try { await provider.submitTx(t.cbor); } catch (e) { rejected = true; error = errText(e?.cause ?? e); }
    out.rejected_witnesses.push({ what: t.what, rejected, error });
    console.log(`  bad witness (${t.what}): ${rejected ? "rejected" : "ACCEPTED"}${error ? ` - ${error}` : ""}`);
    if (!rejected) throw new Error("a transaction with a wrong vkey witness was accepted; the sweep below would prove nothing about validity");
  }
  out.network_checks_vkey_signatures = out.rejected_witnesses.every((r) => r.rejected);

  // 4. The real sweep, signed with (a + b) mod L. Verified with @noble/curves as well, independent of the network.
  out.noble_verify = {
    summed_scalar_signature_valid: ed25519.verify(good, bodyHash, pub),
    share_a_alone_valid: ed25519.verify(signWithScalar(bodyHash, a), bodyHash, pub),
    share_b_alone_valid: ed25519.verify(signWithScalar(bodyHash, b), bodyHash, pub),
  };
  const cbor = withWitness(unsigned, pub, good);
  out.sweep = analyzeTx(ctx, { cbor, resolved: await resolveInputs(ctx, cbor) }, "plain-key sweep (1 input, 1 output, 1 vkey witness from the summed scalar)");
  const txHash = await provider.submitTx(cbor);
  await ctx.lucid.awaitTx(txHash, 5_000);
  out.sweep_tx = txHash;
  out.joint_balance_after = (await ctx.lucid.utxosAt(joint)).reduce((s, u) => s + u.assets.lovelace, 0n);
  out.swept_lovelace = out.sweep.outputs.reduce((s, o) => s + o.lovelace, 0n);
  out.min_utxo_at_joint_address = out.fund.outputs[0].min_lovelace;
  console.log(`swept ${ada(out.swept_lovelace)} ADA with the summed key, fee ${out.sweep.fee_ada}, ${out.sweep.size_bytes} bytes; joint balance after: ${out.joint_balance_after}`);
  console.log(`noble: summed signature valid ${out.noble_verify.summed_scalar_signature_valid}; share alone valid? a ${out.noble_verify.share_a_alone_valid}, b ${out.noble_verify.share_b_alone_valid}`);
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ctx = await makeContext(arg("network", "emulator"));
  if (ctx.network === "preprod" && (await ctx.balance("maker")) < 8_000_000n) { console.log(`fund ${ctx.address("maker")} with test ADA first`); process.exit(2); }
  const out = jsonSafe(await runPlainKey(ctx));
  if (arg("out")) writeFileSync(arg("out"), JSON.stringify(out, null, 1));
}

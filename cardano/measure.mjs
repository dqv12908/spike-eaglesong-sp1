// What a hash-locked swap leg costs on Cardano: lock -> claim and lock -> refund, with the script attached to the
// spending transaction and with the script read from a reference input, for several validators, plus the plain-key
// (summed Ed25519 key) transfers.
//
//   node measure.mjs --network emulator                 in-process emulator loaded with mainnet protocol parameters
//   node measure.mjs --network preprod                  the same builders against Cardano preprod (Koios, no API key)
//   options: --validators all|sha256,sha256_len32,cs_blake2b,cf_sha256   --lock-ada 10   --out <file.json>
//            --refresh-params (re-fetch mainnet parameters)   --no-ogmios (skip the real-node ex-unit cross-check)
//
// One process plays every party; each step only signs with that party's own key (account indexes under one seed).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { CML } from "@lucid-evolution/lucid";
import {
  HERE, ROOT, arg, flag, hex, ada, sha256, slotFloor, jsonSafe, errText, KOIOS_PREPROD,
  makeContext, loadValidators, buildLock, buildPublish, buildClaim, buildRefund, buildTransfer, analyzeTx, ogmiosEvaluate, resolveInputs,
} from "./lib.mjs";
import { runPlainKey } from "./plainkey.mjs";

const NETWORK = arg("network", "emulator");
const EMU = NETWORK === "emulator";
const LOCK = BigInt(Math.round(Number(arg("lock-ada", EMU ? "10" : "5")) * 1e6));
const CLAIM_TTL_MS = EMU ? 6 * 3600_000 : 30 * 60_000;   // claim deadline, well ahead
const REFUND_TTL_MS = EMU ? 600_000 : 240_000;            // refund deadline, short so the run can wait it out
const OUT = arg("out", join(ROOT, "results", EMU ? "cardano-htlc-costs.json" : "cardano-htlc-preprod.json"));
const want = arg("validators", EMU ? "all" : "sha256_len32");
const PRIMARY = "sha256_len32";

const ctx = await makeContext(NETWORK, { fund: { taker1: 1_300_000n } });
const validators = loadValidators().filter((v) => want === "all" || want.split(",").includes(v.id));
const pkgVersion = (p) => JSON.parse(readFileSync(join(HERE, "node_modules", p, "package.json"), "utf8")).version;
const unexpected = [];

if (!EMU) {
  const bal = await ctx.balance("maker");
  console.log(`preprod wallet ${ctx.address("maker")} holds ${ada(bal)} test ADA`);
  if (bal < 100_000_000n) { console.log("Not enough test ADA for a live run (100 needed). Fund the address above from the preprod faucet, then run this command again."); process.exit(2); }
  for (const role of ["taker", "sponsor"]) {
    if ((await ctx.balance(role)) < 15_000_000n) { const t = await buildTransfer(ctx, { from: "maker", to: ctx.address(role), lovelace: 20_000_000n }); await ctx.submit(t.signed); console.log(`setup: sent 20 test ADA to ${role}`); }
  }
}

// --- helpers ---------------------------------------------------------------------------------
async function measured(built, label) {
  const m = analyzeTx(ctx, built, label);
  if (m.ex_units && EMU && !flag("no-ogmios")) {
    const o = await ogmiosEvaluate(built);
    m.real_node_ex_units = o.ok ? { mem: o.mem, steps: o.steps, source: `Ogmios evaluateTransaction via ${KOIOS_PREPROD}/ogmios`, matches_declared: o.mem === m.ex_units.mem && o.steps === m.ex_units.steps } : { error: o.error };
  }
  if (!m.all_checks_pass) unexpected.push(`${label}: a ledger-rule check failed ${JSON.stringify(m.checks)}`);
  const ex = m.ex_units ? ` mem ${m.ex_units.mem} cpu ${m.ex_units.steps}${m.real_node_ex_units ? (m.real_node_ex_units.matches_declared ? " (real node agrees)" : " (REAL NODE: " + JSON.stringify(m.real_node_ex_units) + ")") : ""}` : "";
  console.log(`  ${label}: fee ${m.fee_ada} ADA, ${m.size_bytes} bytes${ex}`);
  return m;
}
const send = async (built, label) => { const m = await measured(built, label); await ctx.submit(built.signed); return m; };
const utxoOf = async (txHash, i = 0) => (await ctx.lucid.utxosByOutRef([{ txHash, outputIndex: i }]))[0];
// A build that must be refused by the validator. Anything else (accepted, or refused for another reason) is flagged.
async function mustFail(list, what, build) {
  let result = "ACCEPTED", error = null;
  try { await build(); } catch (e) { error = errText(e); result = /failed script execution/i.test(error) ? "rejected by the validator" : "failed for another reason"; }
  if (result !== "rejected by the validator") unexpected.push(`${what}: ${result} ${error ?? ""}`);
  list.push({ what, expected: "rejected by the validator", result, error });
  console.log(`    negative: ${what} -> ${result}`);
}

async function lockFor(v, { receiver = "taker", ttl, secret = randomBytes(32), label }) {
  const timeoutMs = slotFloor(ctx.now()) + ttl;
  const inst = v.instantiate(ctx.lucidNetwork, { hashHex: hex(v.hashFn(secret)), timeoutMs, senderVkh: ctx.vkh("maker"), receiverVkh: ctx.vkh(receiver) });
  const built = await buildLock(ctx, { inst, lovelace: LOCK });
  const m = await send(built, label);
  return { v, inst, secret, timeoutMs, receiver, utxo: await utxoOf(m.tx_hash), lock: m };
}

// --- one validator, one variant ----------------------------------------------------------------
async function runVariant(v, variant, refUtxo) {
  const tag = `${v.id} / ${variant}`;
  const r = { negative_tests: [] };
  const neg = variant === "script attached";

  // lock -> claim
  const c = await lockFor(v, { ttl: CLAIM_TTL_MS, label: `${tag}: lock` });
  r.lock = c.lock;
  const claimArgs = { v, inst: c.inst, utxo: c.utxo, secretHex: hex(c.secret), refUtxo, signer: v.claim_needs_receiver_sig ? "taker" : null, validToMs: v.claim_needs_deadline ? c.timeoutMs : undefined };
  if (neg) {
    await mustFail(r.negative_tests, "claim with a wrong secret", () => buildClaim(ctx, { ...claimArgs, secretHex: hex(randomBytes(32)) }));
    if (v.claim_needs_receiver_sig) {
      await mustFail(r.negative_tests, "claim with the right secret but signed by someone who is not the receiver", () => buildClaim(ctx, { ...claimArgs, by: "sponsor", payer: "sponsor", signer: "sponsor" }));
      await mustFail(r.negative_tests, "claim with the right secret and no required signer", () => buildClaim(ctx, { ...claimArgs, signer: null }));
    }
    if (v.claim_needs_deadline) {
      await mustFail(r.negative_tests, "claim whose validity upper bound is one slot past the deadline", () => buildClaim(ctx, { ...claimArgs, validToMs: c.timeoutMs + 1000 }));
      await mustFail(r.negative_tests, "claim with no validity upper bound", () => buildClaim(ctx, { ...claimArgs, validToMs: undefined }));
    }
  }
  const before = await ctx.balance("taker");
  r.claim = await send(await buildClaim(ctx, claimArgs), `${tag}: claim`);
  r.claim.receiver_balance_change_lovelace = (await ctx.balance("taker")) - before;

  // lock -> refund
  const f = await lockFor(v, { ttl: REFUND_TTL_MS, label: `${tag}: lock (to be refunded)` });
  r.lock_for_refund = f.lock;
  const refundArgs = { v, inst: f.inst, utxo: f.utxo, refUtxo };
  const refundFrom = f.timeoutMs + 1000; // first slot strictly after the deadline
  if (neg) {
    await mustFail(r.negative_tests, "refund before the deadline", () => buildRefund(ctx, { ...refundArgs, validFromMs: slotFloor(ctx.now()) }));
    await mustFail(r.negative_tests, "refund whose validity lower bound equals the deadline", () => buildRefund(ctx, { ...refundArgs, validFromMs: f.timeoutMs }));
    await mustFail(r.negative_tests, "refund with no validity lower bound", () => buildRefund(ctx, { ...refundArgs, validFromMs: undefined }));
    await mustFail(r.negative_tests, "refund after the deadline signed by someone who is not the owner", () => buildRefund(ctx, { ...refundArgs, by: "taker", validFromMs: refundFrom }));
  }
  await ctx.waitUntil(refundFrom);
  const mb = await ctx.balance("maker");
  r.refund = await send(await buildRefund(ctx, { ...refundArgs, validFromMs: refundFrom }), `${tag}: refund`);
  r.refund.owner_balance_change_lovelace = (await ctx.balance("maker")) - mb;
  return r;
}

// --- run -------------------------------------------------------------------------------------
const report = {
  what: "Cost of a hash-locked swap leg on Cardano (lock, claim, refund) and of plain-key transfers",
  generated_at_utc: new Date().toISOString(),
  network: EMU ? "emulator (lucid-evolution Emulator) loaded with mainnet protocol parameters; slot numbering anchored to preprod" : "preprod (live)",
  protocol_parameters: {
    ...ctx.paramsMeta,
    min_fee_a: ctx.params.minFeeA, min_fee_b: ctx.params.minFeeB, price_mem: ctx.params.priceMem, price_step: ctx.params.priceStep,
    coins_per_utxo_byte: ctx.params.coinsPerUtxoByte, collateral_percent: ctx.params.collateralPercentage, min_fee_ref_script_cost_per_byte: ctx.params.minFeeRefScriptCostPerByte,
    max_tx_size: ctx.params.maxTxSize, max_tx_ex_mem: ctx.params.maxTxExMem, max_tx_ex_steps: ctx.params.maxTxExSteps,
    protocol_version: `${ctx.params.protocolMajorVersion}.${ctx.params.protocolMinorVersion}`, plutus_v3_cost_model_entries: ctx.params.costModels.PlutusV3.length,
  },
  libraries: {
    node: process.version, "@lucid-evolution/lucid": pkgVersion("@lucid-evolution/lucid"), "@lucid-evolution/provider": pkgVersion("@lucid-evolution/provider"),
    "@lucid-evolution/uplc": pkgVersion("@lucid-evolution/uplc"), "@lucid-evolution/cml": pkgVersion("@lucid-evolution/cml"),
    "@noble/curves": pkgVersion("@noble/curves"), "@noble/hashes": pkgVersion("@noble/hashes"), aiken: "v1.1.19+e525483 (own validators, cardano-scaling blueprint), v1.1.22+39d6b04 (Cardano Foundation template)",
  },
  locked_lovelace_per_test: LOCK,
  validators: validators.map(({ id, title, origin, notes, hashName, compiler, plutus, script_hash, script_bytes, shared_script, claim_needs_receiver_sig, claim_needs_deadline }) => ({ id, title, origin, notes, hash: hashName, compiler, plutus, script_hash, script_bytes, one_script_for_all_swaps: shared_script, claim_needs_receiver_signature: claim_needs_receiver_sig, claim_checks_deadline: claim_needs_deadline })),
  runs: {},
};

if (EMU) {
  // Are preprod's cost models (used by the real-node cross-check) the same as mainnet's (used for everything else)?
  try {
    const [pp] = await (await fetch(`${KOIOS_PREPROD}/epoch_params?limit=1`, { signal: AbortSignal.timeout(20_000) })).json();
    report.real_node_cross_check = { node: "cardano-node behind Koios preprod (Ogmios evaluateTransaction with additionalUtxo)", preprod_epoch: pp.epoch_no, preprod_plutus_v3_cost_model_identical_to_mainnet: JSON.stringify(pp.cost_models.PlutusV3) === JSON.stringify(ctx.rawParams.cost_models.PlutusV3) };
  } catch (e) { report.real_node_cross_check = { error: errText(e) }; }
}

for (const v of validators) {
  console.log(`\n== ${v.title}`);
  const run = (report.runs[v.id] = {});
  run.script_attached = await runVariant(v, "script attached");
  run.locked_output_min_lovelace = run.script_attached.lock.outputs[0].min_lovelace;
  run.locked_output_bytes = run.script_attached.lock.outputs[0].bytes;
  if (v.shared_script) {
    const anyInst = v.instantiate(ctx.lucidNetwork, { hashHex: "00".repeat(32), timeoutMs: 0, senderVkh: ctx.vkh("maker"), receiverVkh: ctx.vkh("taker") });
    run.publish_reference_script = await send(await buildPublish(ctx, { script: anyInst.script }), `${v.id}: publish reference script (one-off)`);
    run.publish_reference_script.deposit_lovelace = run.publish_reference_script.outputs[0].lovelace;
    v.refUtxo = await utxoOf(run.publish_reference_script.tx_hash);
    run.reference_script = await runVariant(v, "reference script", v.refUtxo);
  } else {
    run.reference_script = null;
    run.reference_script_note = "not measured: the hash, expiry and owner are compiled into the script, so every swap has a different script and a published copy cannot be shared between swaps";
  }

  if (!v.claim_needs_receiver_sig) {
    // Limit of this validator, shown rather than asserted: a third party claims after expiry with nothing but the secret.
    console.log("  limit check: claim by an unrelated party, after the expiry, with only the secret");
    const x = await lockFor(v, { ttl: REFUND_TTL_MS, label: `${v.id}: lock (for the limit check)` });
    await ctx.waitUntil(x.timeoutMs + 1000);
    let accepted = false, error = null;
    try { await send(await buildClaim(ctx, { v, inst: x.inst, utxo: x.utxo, secretHex: hex(x.secret), by: "sponsor", payer: "sponsor", signer: null, feeFromLocked: true }), `${v.id}: claim by a third party after expiry`); accepted = true; } catch (e) { error = errText(e); }
    run.limits_demonstrated = { third_party_claim_after_expiry_with_only_the_secret: accepted ? "accepted" : "rejected", error };
  }
}

// --- emulator-only probes ------------------------------------------------------------------------
if (EMU) {
  const byId = Object.fromEntries(validators.map((v) => [v.id, v]));

  // Secret length: lock against sha2_256 of a 64-byte string and claim with it.
  const longSecret = { secret_bytes: 64 };
  for (const id of ["sha256", "sha256_len32"]) {
    const v = byId[id]; if (!v) continue;
    const x = await lockFor(v, { ttl: CLAIM_TTL_MS, secret: randomBytes(64), label: `${id}: lock against the hash of a 64-byte secret` });
    try { await send(await buildClaim(ctx, { v, inst: x.inst, utxo: x.utxo, secretHex: hex(x.secret), validToMs: x.timeoutMs }), `${id}: claim with the 64-byte secret`); longSecret[id] = "accepted"; }
    catch (e) { longSecret[id] = `rejected (${errText(e).slice(0, 120)})`; }
    console.log(`  64-byte secret on ${id}: ${longSecret[id]}`);
  }
  report.long_secret_test = longSecret;
  if (byId.sha256 && longSecret.sha256 !== "accepted") unexpected.push("64-byte secret was expected to pass on htlc_sha256");
  if (byId.sha256_len32 && !/^rejected .*failed script execution/.test(String(longSecret.sha256_len32))) unexpected.push("64-byte secret was expected to fail on htlc_sha256_len32");

  // Does the emulator run the script again when a transaction is submitted? Take a valid, signed claim and swap the
  // secret inside the redeemer for random bytes (the body, and so the signatures, stay the same).
  const pv = byId[PRIMARY] ?? validators[0];
  const probe = {};
  {
    const x = await lockFor(pv, { ttl: CLAIM_TTL_MS, label: `${pv.id}: lock (for the emulator probe)` });
    const good = await buildClaim(ctx, { v: pv, inst: x.inst, utxo: x.utxo, secretHex: hex(x.secret), signer: pv.claim_needs_receiver_sig ? "taker" : null, validToMs: pv.claim_needs_deadline ? x.timeoutMs : undefined });
    const tampered = good.cbor.replace(hex(x.secret), hex(randomBytes(32)));
    probe.what = "valid signed claim whose redeemer secret was replaced by random bytes after signing (script must fail; script-data hash no longer matches)";
    probe.body_unchanged = CML.hash_transaction(CML.Transaction.from_cbor_hex(tampered).body()).to_hex() === CML.hash_transaction(CML.Transaction.from_cbor_hex(good.cbor).body()).to_hex() && tampered !== good.cbor;
    const node = flag("no-ogmios") ? null : await ogmiosEvaluate({ cbor: tampered, resolved: good.resolved });
    probe.real_node_evaluation = node ? (node.ok ? "ACCEPTED" : `rejected (${node.error.slice(0, 200)})`) : "skipped";
    try { await ctx.emulator.submitTx(tampered); probe.emulator_submit = "accepted"; } catch (e) { probe.emulator_submit = `rejected (${errText(e)})`; }
    probe.conclusion = probe.emulator_submit === "accepted"
      ? "The emulator does NOT execute Plutus scripts or check the script-data hash at submission. Script results in this report come from the evaluation lucid runs while building the transaction, cross-checked against a real node through Ogmios."
      : "The emulator refused the tampered transaction.";
    console.log(`  emulator probe: tampered claim -> emulator ${probe.emulator_submit}; real node ${probe.real_node_evaluation}`);
  }
  report.emulator_probe = probe;
}

// --- claims paid for by someone else, and a receiver with (almost) no ADA -----------------------------
{
  const v = validators.find((x) => x.id === PRIMARY) ?? validators.find((x) => x.claim_needs_receiver_sig);
  if (v) {
    console.log(`\n== who can pay for the claim (${v.id}, ${v.refUtxo ? "reference script" : "script attached"})`);
    const sp = (report.sponsored_claims = { validator: v.id, variant: v.refUtxo ? "reference script" : "script attached", receiver: "an address holding no ADA at all" });
    const base = (x) => ({ v, inst: x.inst, utxo: x.utxo, secretHex: hex(x.secret), refUtxo: v.refUtxo, validToMs: x.timeoutMs });

    // (0) the receiver alone, holding nothing
    { const x = await lockFor(v, { receiver: "taker0", ttl: CLAIM_TTL_MS, label: `${v.id}: lock for a zero-ADA receiver` });
      try { await buildClaim(ctx, { ...base(x), by: "taker0" }); sp.receiver_alone_with_zero_ada = "built (unexpected)"; unexpected.push("zero-ADA receiver built a claim alone"); }
      catch (e) { sp.receiver_alone_with_zero_ada = `cannot build: ${errText(e).slice(0, 160)}`; }
      console.log(`  receiver alone with zero ADA: ${sp.receiver_alone_with_zero_ada}`);

      // (1) a sponsor pays fee and collateral, the receiver co-signs and gets the full locked amount
      const s0 = await ctx.balance("sponsor"), r0 = await ctx.balance("taker0");
      const m = await send(await buildClaim(ctx, { ...base(x), by: "taker0", payer: "sponsor" }), `${v.id}: claim, sponsor pays fee + collateral, receiver co-signs`);
      sp.sponsor_pays_fee_and_collateral = { ...m, sponsor_balance_change_lovelace: (await ctx.balance("sponsor")) - s0, receiver_balance_change_lovelace: (await ctx.balance("taker0")) - r0 };
    }
    // (2) the sponsor only lends collateral; the fee comes out of the locked ADA
    { const x = await lockFor(v, { receiver: "taker0", ttl: CLAIM_TTL_MS, label: `${v.id}: lock for a zero-ADA receiver (2)` });
      const s0 = await ctx.balance("sponsor"), r0 = await ctx.balance("taker0");
      const built = await buildClaim(ctx, { ...base(x), by: "taker0", payer: "sponsor", feeFromLocked: true });
      const body = hex(CML.Transaction.from_cbor_hex(built.cbor).body().to_cbor_bytes());
      const m = await send(built, `${v.id}: claim, sponsor lends collateral only, fee from the locked ADA`);
      sp.sponsor_lends_collateral_only = { ...m, sponsor_balance_change_lovelace: (await ctx.balance("sponsor")) - s0, receiver_balance_change_lovelace: (await ctx.balance("taker0")) - r0, secret_appears_in_tx_body: body.includes(hex(x.secret)) };
    }
    // (3) emulator only: a receiver whose whole wallet is one 1.3-ADA UTxO claims alone (0.3 ADA collateral, 1.0 ADA collateral return)
    if (EMU) {
      const x = await lockFor(v, { receiver: "taker1", ttl: CLAIM_TTL_MS, label: `${v.id}: lock for a receiver holding 1.3 ADA` });
      const r0 = await ctx.balance("taker1");
      for (const setCollateral of [300_000n]) {
        try {
          const built = await buildClaim(ctx, { ...base(x), by: "taker1", opts: setCollateral ? { setCollateral } : {} });
          const m = await send(built, `${v.id}: claim by a receiver holding exactly 1.3 ADA`);
          sp.receiver_alone_with_1_3_ada = { ...m, set_collateral_option: setCollateral ?? "lucid default (5 ADA)", receiver_balance_before_lovelace: r0, receiver_balance_change_lovelace: (await ctx.balance("taker1")) - r0 };
          break;
        } catch (e) { sp.receiver_alone_with_1_3_ada = `cannot build: ${errText(e).slice(0, 200)}`; unexpected.push("receiver holding 1.3 ADA could not claim alone"); }
      }
    }
  }
}

// --- plain-key transfers ---------------------------------------------------------------------------
console.log("\n== plain-key (summed Ed25519 key) transfers");
report.plain_key = await runPlainKey(ctx);

// --- table and summary -------------------------------------------------------------------------------
const row = (validator, tx, m, min_utxo, notes) => ({ validator, transaction: tx, fee_ada: m.fee_ada, fee_lovelace: m.fee_lovelace, mem: m.ex_units?.mem ?? null, cpu_steps: m.ex_units?.steps ?? null, size_bytes: m.size_bytes, min_utxo_locked_ada: min_utxo ? ada(min_utxo) : null, notes });
report.table = [];
for (const v of validators) {
  const run = report.runs[v.id], mu = run.locked_output_min_lovelace;
  report.table.push(row(v.id, "lock", run.script_attached.lock, mu, "same transaction for both variants; no script runs"));
  report.table.push(row(v.id, "claim, script attached", run.script_attached.claim, null, `script ${run.script_attached.claim.witness_script_bytes} bytes in the witness set`));
  report.table.push(row(v.id, "refund, script attached", run.script_attached.refund, null, ""));
  if (run.reference_script) {
    report.table.push(row(v.id, "publish reference script (one-off)", run.publish_reference_script, null, `deposit ${ada(run.publish_reference_script.deposit_lovelace)} ADA held in the output carrying the script (recoverable by its owner)`));
    report.table.push(row(v.id, "claim, reference script", run.reference_script.claim, null, `includes ${run.reference_script.claim.fee_breakdown_lovelace.reference_script} lovelace reference-script fee`));
    report.table.push(row(v.id, "refund, reference script", run.reference_script.refund, null, ""));
  }
}
report.table.push(row("none (plain key)", "fund the summed-key address", report.plain_key.fund, report.plain_key.min_utxo_at_joint_address, "plain transfer, 1 input, 2 outputs"));
report.table.push(row("none (plain key)", "sweep with the summed scalar", report.plain_key.sweep, null, "plain transfer, 1 input, 1 output, the address pays its own fee"));

{
  const v = validators.find((x) => x.id === PRIMARY) ?? validators[0];
  const run = report.runs[v.id], best = run.reference_script ?? run.script_attached;
  const claim = best.claim, refund = best.refund, lock = best.lock;
  report.summary = {
    validator: v.id, variant: run.reference_script ? "reference script" : "script attached",
    success_path: {
      locker_burns_lovelace: lock.fee_lovelace, claimer_burns_lovelace: claim.fee_lovelace, total_burned_lovelace: lock.fee_lovelace + claim.fee_lovelace,
      total_burned_ada: ada(lock.fee_lovelace + claim.fee_lovelace),
    },
    refund_path: { locker_burns_lovelace: lock.fee_lovelace + refund.fee_lovelace, locker_burns_ada: ada(lock.fee_lovelace + refund.fee_lovelace), claimer_burns_lovelace: 0 },
    tied_up_not_burned: {
      locked_output_min_utxo_lovelace: run.locked_output_min_lovelace,
      locked_output_min_utxo_note: "smallest amount the hash-locked output may hold; it is part of the swapped amount and goes to the claimer (or back to the locker), so it sets a minimum swap size rather than an extra cost",
      claim_collateral_required_lovelace: claim.collateral.required_150pct_of_fee_lovelace,
      claim_collateral_lucid_default_lovelace: claim.collateral.total_collateral_lovelace,
      claim_collateral_note: "an ADA-only UTxO of the fee payer is named as collateral; it is not spent unless the script fails on chain",
      reference_script_deposit_lovelace: run.publish_reference_script?.deposit_lovelace ?? null,
      reference_script_publish_fee_lovelace_one_off: run.publish_reference_script?.fee_lovelace ?? null,
    },
    script_attached_instead: { claim_fee_lovelace: run.script_attached.claim.fee_lovelace, refund_fee_lovelace: run.script_attached.refund.fee_lovelace },
    plain_key: { fund_fee_lovelace: report.plain_key.fund.fee_lovelace, sweep_fee_lovelace: report.plain_key.sweep.fee_lovelace, total_burned_ada: ada(report.plain_key.fund.fee_lovelace + report.plain_key.sweep.fee_lovelace), min_utxo_at_address_lovelace: report.plain_key.min_utxo_at_joint_address },
  };
}
report.unexpected = unexpected;

report.verification = EMU ? {
  emulator_checks_at_submit: [
    "vkey witness signatures (Ed25519 over the body hash) - shown by the three rejected witnesses in plain_key.rejected_witnesses",
    "every spent key address and every required signer has a vkey witness; no extraneous witnesses",
    "inputs exist and are unspent; validity interval against the emulator slot",
    "a script input has a script (witness or reference) and a redeemer; collateral present, ADA-only, >= collateral_percent of the fee",
  ],
  emulator_does_not_check_at_submit: [
    "Plutus script execution and the script-data hash (see emulator_probe: a claim with a wrong secret swapped in after signing was accepted)",
    "that the fee covers the minimum fee, value conservation, min-UTxO of ordinary outputs, max tx size, ex-unit limits",
  ],
  checked_by_this_script_instead: [
    "script validity and ex-units: lucid's local evaluator (Aiken uplc, WASM) when the transaction is built, and for every script transaction the same signed bytes were evaluated by a real cardano-node (Ogmios evaluateTransaction via Koios preprod, emulator UTxOs passed as additionalUtxo); see real_node_ex_units on each transaction",
    "fee >= recomputed minimum fee (size, constant, ex-unit prices, reference-script bytes), value conservation, min-UTxO of every output, size and ex-unit limits; see checks on each transaction",
    "vkey witnesses re-verified with @noble/curves",
  ],
  not_verified: [
    "no transaction was submitted to a real network; phase-1 ledger rules as a node applies them (fee, reference-script fee tiering, script-data hash, collateral) are recomputed here, not enforced by a node",
    "the real-node cross-check ran on preprod, whose Plutus cost models were compared with mainnet's and found identical; prices and fees were taken from mainnet parameters",
  ],
} : { note: "live preprod run: every transaction was validated by the network" };
if (EMU) {
  try {
    const { address } = JSON.parse(readFileSync(join(HERE, "wallet.local.json"), "utf8"));
    const info = await (await fetch(KOIOS_PREPROD + "/address_info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ _addresses: [address] }), signal: AbortSignal.timeout(20_000) })).json();
    report.preprod_readiness = { address, balance_lovelace: info[0]?.balance ?? "0", live_run_done: false, needs_lovelace: 100_000_000, command: "cd cardano && node measure.mjs --network preprod" };
  } catch (e) { report.preprod_readiness = { error: errText(e), command: "cd cardano && node wallet.mjs && node measure.mjs --network preprod" }; }
}

mkdirSync(join(ROOT, "results"), { recursive: true });
writeFileSync(OUT, JSON.stringify(jsonSafe(report), null, 1));
console.log(`\n${"validator".padEnd(13)} ${"transaction".padEnd(36)} ${"fee ADA".padStart(9)} ${"mem".padStart(7)} ${"cpu".padStart(10)} ${"bytes".padStart(6)} ${"min-UTxO".padStart(9)}`);
for (const t of report.table) console.log(`${t.validator.padEnd(13).slice(0, 13)} ${t.transaction.padEnd(36)} ${t.fee_ada.padStart(9)} ${String(t.mem ?? "-").padStart(7)} ${String(t.cpu_steps ?? "-").padStart(10)} ${String(t.size_bytes).padStart(6)} ${(t.min_utxo_locked_ada ?? "-").padStart(9)}`);
console.log(`\nwrote ${OUT}`);
if (unexpected.length) { console.log(`UNEXPECTED (${unexpected.length}):\n - ${unexpected.join("\n - ")}`); process.exit(1); }

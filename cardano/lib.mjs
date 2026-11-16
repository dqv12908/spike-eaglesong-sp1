// Shared pieces for the Cardano hash-locked swap leg measurements.
//
// One set of lock / claim / refund builders runs against either
//   --network emulator   lucid-evolution's in-process Emulator loaded with MAINNET protocol parameters
//   --network preprod    Cardano preprod through Koios' keyless public API
//
// Nothing here prints a private key or seed phrase.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  Lucid, Emulator, Koios, Data, Constr, CML,
  validatorToAddress, validatorToScriptHash, applyDoubleCborEncoding, applyParamsToScript,
  generateSeedPhrase, walletFromSeed, getAddressDetails, SLOT_CONFIG_NETWORK,
} from "@lucid-evolution/lucid";
import { ed25519 } from "@noble/curves/ed25519";
import { blake2b } from "@noble/hashes/blake2b";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..");
export const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
export const flag = (k) => process.argv.includes(`--${k}`);
export const hex = (b) => Buffer.from(b).toString("hex");
export const sha256 = (b) => createHash("sha256").update(b).digest();
export const blake2b256 = (b) => Buffer.from(blake2b(b, { dkLen: 32 }));
export const blake2b224 = (b) => Buffer.from(blake2b(b, { dkLen: 28 }));
export const ada = (lovelace) => (Number(lovelace) / 1e6).toFixed(6);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const KOIOS_MAINNET = "https://api.koios.rest/api/v1";
export const KOIOS_PREPROD = "https://preprod.koios.rest/api/v1";
export const WALLET_FILE = join(HERE, "wallet.local.json");
export const ROLES = { maker: 0, taker: 1, sponsor: 2, taker0: 3, taker1: 4 }; // account indexes under one seed

// ---------------------------------------------------------------------------------------------
// Protocol parameters: fetched from Koios mainnet for the current epoch and kept in params/.
// ---------------------------------------------------------------------------------------------
const getJson = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
};

export async function loadMainnetParams({ refresh = false } = {}) {
  const dir = join(HERE, "params");
  mkdirSync(dir, { recursive: true });
  let file = readdirSync(dir).filter((f) => /^mainnet-epoch-\d+\.json$/.test(f)).sort((a, b) => parseInt(b.match(/\d+/)[0]) - parseInt(a.match(/\d+/)[0]))[0];
  if (refresh || !file) {
    const [tip] = await getJson(`${KOIOS_MAINNET}/tip`);
    const url = `${KOIOS_MAINNET}/epoch_params?_epoch_no=${tip.epoch_no}`;
    const [raw] = await getJson(url);
    if (!raw || raw.epoch_no !== tip.epoch_no) throw new Error("Koios returned no parameters for the current epoch");
    file = `mainnet-epoch-${tip.epoch_no}.json`;
    writeFileSync(join(dir, file), JSON.stringify({ source: url, network: "mainnet", epoch_no: tip.epoch_no, fetched_at_utc: new Date().toISOString(), tip_at_fetch: { abs_slot: tip.abs_slot, block_no: tip.block_no, block_time: tip.block_time }, raw }, null, 1));
  }
  const saved = JSON.parse(readFileSync(join(dir, file), "utf8"));
  return { params: koiosToLucidParams(saved.raw), meta: { source: saved.source, network: saved.network, epoch_no: saved.epoch_no, fetched_at_utc: saved.fetched_at_utc, file: `cardano/params/${file}` }, raw: saved.raw };
}

// Same field mapping lucid-evolution's own Koios provider uses.
export const koiosToLucidParams = (r) => ({
  protocolMajorVersion: r.protocol_major, protocolMinorVersion: r.protocol_minor,
  minFeeA: r.min_fee_a, minFeeB: r.min_fee_b, maxTxSize: r.max_tx_size, maxValSize: r.max_val_size,
  keyDeposit: BigInt(r.key_deposit), poolDeposit: BigInt(r.pool_deposit),
  drepDeposit: BigInt(r.drep_deposit), govActionDeposit: BigInt(r.gov_action_deposit),
  priceMem: r.price_mem, priceStep: r.price_step,
  maxTxExMem: BigInt(r.max_tx_ex_mem), maxTxExSteps: BigInt(r.max_tx_ex_steps),
  coinsPerUtxoByte: BigInt(r.coins_per_utxo_size),
  collateralPercentage: r.collateral_percent, maxCollateralInputs: r.max_collateral_inputs,
  minFeeRefScriptCostPerByte: r.min_fee_ref_script_cost_per_byte,
  costModels: { PlutusV1: [...r.cost_models.PlutusV1], PlutusV2: [...r.cost_models.PlutusV2], PlutusV3: [...r.cost_models.PlutusV3] },
});

// ---------------------------------------------------------------------------------------------
// Validators. Every entry says where the code came from and how the datum / redeemer are shaped.
// ---------------------------------------------------------------------------------------------
const blueprint = (rel) => JSON.parse(readFileSync(join(HERE, rel), "utf8"));
const pick = (bp, title) => { const v = bp.validators.find((x) => x.title === title); if (!v) throw new Error(`no validator ${title}`); return v; };
const plutusV3 = (compiledCode) => ({ type: "PlutusV3", script: applyDoubleCborEncoding(compiledCode) });

// Datum { hash, timeout, sender, receiver }, redeemer Claim(preimage) | Refund  (cardano-scaling/htlc shape).
function datumStyle({ id, title, origin, bp, validatorTitle, hashName, hashFn, notes }) {
  const v = pick(bp, validatorTitle);
  const script = plutusV3(v.compiledCode);
  if (validatorToScriptHash(script) !== v.hash) throw new Error(`${id}: script hash differs from the blueprint`);
  return {
    id, title, origin, notes, hashName, hashFn, compiler: bp.preamble.compiler.version, plutus: bp.preamble.plutusVersion,
    script_hash: v.hash, script_bytes: v.compiledCode.length / 2, shared_script: true,
    claim_needs_receiver_sig: true, claim_needs_deadline: true,
    instantiate: (network, { hashHex, timeoutMs, senderVkh, receiverVkh }) => ({
      script, address: validatorToAddress(network, script),
      datum: Data.to(new Constr(0, [hashHex, BigInt(timeoutMs), senderVkh, receiverVkh])),
    }),
    claimRedeemer: (secretHex) => Data.to(new Constr(0, [secretHex])),
    refundRedeemer: () => Data.to(new Constr(1, [])),
  };
}

// Parameterised (hash, expiration, owner), no datum, redeemer GUESS{answer} | WITHDRAW  (Cardano Foundation template).
function cfStyle({ id, title, origin, bp, validatorTitle, notes }) {
  const v = pick(bp, validatorTitle);
  return {
    id, title, origin, notes, hashName: "sha2_256", hashFn: sha256, compiler: bp.preamble.compiler.version, plutus: bp.preamble.plutusVersion,
    script_hash: `${v.hash} (before parameters are applied; every swap gets its own script hash)`, script_bytes: v.compiledCode.length / 2, shared_script: false,
    claim_needs_receiver_sig: false, claim_needs_deadline: false,
    instantiate: (network, { hashHex, timeoutMs, senderVkh }) => {
      const script = { type: "PlutusV3", script: applyParamsToScript(applyDoubleCborEncoding(v.compiledCode), [hashHex, BigInt(timeoutMs), senderVkh]) };
      return { script, address: validatorToAddress(network, script), datum: Data.void() };
    },
    claimRedeemer: (secretHex) => Data.to(new Constr(0, [secretHex])),
    refundRedeemer: () => Data.to(new Constr(1, [])),
  };
}

export function loadValidators() {
  const own = blueprint("onchain/plutus.json");
  const cs = blueprint("vendor/cardano-scaling-htlc/plutus.json");
  const cf = blueprint("vendor/cardano-foundation-htlc/plutus.json");
  return [
    datumStyle({
      id: "sha256", title: "htlc_sha256 (cardano-scaling/htlc with blake2b_256 replaced by sha2_256)", bp: own, validatorTitle: "htlc_sha256.htlc_sha256.spend", hashName: "sha2_256", hashFn: sha256,
      origin: { repo: "https://github.com/cardano-scaling/htlc", commit: "393893f0b4df4e37079b8b6ecb9f930e17b6344c", modified: true, change: "one builtin swapped: blake2b_256 -> sha2_256; built with the default (silent) trace level", source: "cardano/onchain/validators/htlc_sha256.ak" },
      notes: "secret length is not checked",
    }),
    datumStyle({
      id: "sha256_len32", title: "htlc_sha256_len32 (same, plus: preimage must be exactly 32 bytes)", bp: own, validatorTitle: "htlc_sha256.htlc_sha256_len32.spend", hashName: "sha2_256", hashFn: sha256,
      origin: { repo: "https://github.com/cardano-scaling/htlc", commit: "393893f0b4df4e37079b8b6ecb9f930e17b6344c", modified: true, change: "blake2b_256 -> sha2_256 and length_of_bytearray(preimage) == 32", source: "cardano/onchain/validators/htlc_sha256.ak" },
      notes: "the variant a swap against a 32-byte Fiber preimage should use",
    }),
    datumStyle({
      id: "cs_blake2b", title: "cardano-scaling/htlc, committed plutus.json, unmodified", bp: cs, validatorTitle: "htlc.htlc.spend", hashName: "blake2b_256", hashFn: blake2b256,
      origin: { repo: "https://github.com/cardano-scaling/htlc", commit: "393893f0b4df4e37079b8b6ecb9f930e17b6344c", modified: false, change: "none; committed blueprint (Aiken v1.1.19, built with -t compact) used as is", source: "cardano/vendor/cardano-scaling-htlc/plutus.json" },
      notes: "hashes with blake2b_256, so it cannot share a secret with a SHA-256 Fiber payment; measured only for comparison",
    }),
    cfStyle({
      id: "cf_sha256", title: "cardano-foundation template htlc, unmodified source, compiled here", bp: cf, validatorTitle: "htlc.htlc.spend",
      origin: { repo: "https://github.com/cardano-foundation/cardano-template-and-ecosystem-monitoring", path: "htlc/onchain/aiken", commit: "cbc86fc5d5a25daece94666a9e6f1c48368c1c72", modified: false, change: "none; no plutus.json is committed, compiled here with the pinned Aiken v1.1.22 (default trace level)", source: "cardano/vendor/cardano-foundation-htlc/plutus.json" },
      notes: "sha2_256, but a claim needs no signature and has no deadline: anyone who learns the secret can take the funds, also after expiry",
    }),
  ];
}

// ---------------------------------------------------------------------------------------------
// Context: lucid instance + roles, for either network.
// ---------------------------------------------------------------------------------------------
export async function makeContext(network, { fund = {} } = {}) {
  if (network === "emulator") {
    const { params, meta, raw } = await loadMainnetParams({ refresh: flag("refresh-params") });
    const seed = generateSeedPhrase(); // throwaway, never leaves this process
    const addr = (i) => walletFromSeed(seed, { accountIndex: i, addressType: "Base", network: "Preprod" }).address;
    const accounts = Object.entries({ maker: 1_000_000_000n, taker: 100_000_000n, sponsor: 100_000_000n, ...fund }).map(([role, lovelace]) => ({ address: addr(ROLES[role]), assets: { lovelace } }));
    const emulator = new Emulator(accounts, params);
    // Anchor the emulator clock to the real preprod slot numbering, so the very same transactions can also be
    // handed to a real node (Ogmios evaluateTransaction through Koios preprod) for an independent ex-unit count.
    const sc = SLOT_CONFIG_NETWORK.Preprod;
    const slot = Math.floor((Date.now() - sc.zeroTime) / sc.slotLength) + sc.zeroSlot;
    emulator.slot = slot; emulator.time = sc.zeroTime + (slot - sc.zeroSlot) * sc.slotLength; emulator.blockHeight = Math.floor(slot / 20);
    const lucid = await Lucid(emulator, "Preprod");
    return finishContext({ network, lucid, seed, emulator, paramsMeta: meta, params, rawParams: raw });
  }
  if (network === "preprod") {
    if (!existsSync(WALLET_FILE)) throw new Error(`no ${WALLET_FILE}; run: node wallet.mjs`);
    const seed = JSON.parse(readFileSync(WALLET_FILE, "utf8")).seedPhrase;
    const provider = new Koios(KOIOS_PREPROD);
    const lucid = await Lucid(provider, "Preprod");
    const params = await provider.getProtocolParameters();
    const [tip] = await getJson(`${KOIOS_PREPROD}/tip`);
    return finishContext({ network, lucid, seed, emulator: null, params, paramsMeta: { source: `${KOIOS_PREPROD}/epoch_params?limit=1`, network: "preprod", epoch_no: tip.epoch_no, fetched_at_utc: new Date().toISOString() } });
  }
  throw new Error(`--network must be emulator or preprod, got ${network}`);
}

function finishContext(c) {
  const LNET = "Preprod";
  const w = (role) => walletFromSeed(c.seed, { accountIndex: ROLES[role], addressType: "Base", network: LNET });
  const ctx = {
    ...c, lucidNetwork: LNET,
    address: (role) => w(role).address,
    vkh: (role) => getAddressDetails(w(role).address).paymentCredential.hash,
    as: (role) => { c.lucid.selectWallet.fromSeed(c.seed, { accountIndex: ROLES[role], addressType: "Base" }); return c.lucid; },
    now: () => (c.emulator ? c.emulator.now() : Date.now()),
    balance: async (role) => (await c.lucid.utxosAt(w(role).address)).reduce((s, u) => s + u.assets.lovelace, 0n),
    // Wait until the chain has passed `ms` (emulator: advance blocks; preprod: really wait, plus a margin for the tip).
    waitUntil: async (ms) => {
      if (c.emulator) { while (c.emulator.now() <= ms) c.emulator.awaitBlock(1); return; }
      while (Date.now() < ms + 45_000) await sleep(5_000);
    },
    // Submit, wait for inclusion, and wait until the provider can see the first output.
    submit: async (signed) => {
      const txHash = await signed.submit();
      await c.lucid.awaitTx(txHash, 5_000);
      for (let i = 0; i < 60; i++) {
        if ((await c.lucid.utxosByOutRef([{ txHash, outputIndex: 0 }])).length) break;
        if (c.emulator) throw new Error("emulator did not record the output");
        await sleep(5_000);
      }
      if (!c.emulator) await sleep(3_000); // let the indexer settle before the next wallet query
      return txHash;
    },
  };
  return ctx;
}

// ---------------------------------------------------------------------------------------------
// Builders. They only use ctx.as(role), so they are the same for the emulator and preprod.
// Each returns { signed, resolved } where `resolved` are the UTxOs the transaction reads or spends.
// ---------------------------------------------------------------------------------------------
const SLOT_MS = 1000;
export const slotFloor = (ms) => Math.floor(ms / SLOT_MS) * SLOT_MS;

export async function buildLock(ctx, { from = "maker", inst, lovelace }) {
  const lucid = ctx.as(from);
  const txb = await lucid.newTx().pay.ToContract(inst.address, { kind: "inline", value: inst.datum }, { lovelace }).complete();
  return finish(ctx, txb, await txb.sign.withWallet().complete());
}

// Publishes the script once as a reference script, in an output at the publisher's own address (so the deposit can be taken back).
export async function buildPublish(ctx, { from = "maker", script }) {
  const lucid = ctx.as(from);
  const txb = await lucid.newTx().pay.ToAddressWithData(ctx.address(from), undefined, { lovelace: 0n }, script).complete();
  return finish(ctx, txb, await txb.sign.withWallet().complete());
}

// claim: `by` signs as the receiver. `payer` (default: the receiver) supplies the fee input and the collateral.
// feeFromLocked: the payer only lends collateral; the fee is taken out of the locked ADA and the rest goes to the receiver.
export async function buildClaim(ctx, { v, inst, utxo, secretHex, by = "taker", payer = by, refUtxo, validToMs, feeFromLocked = false, signer = by, payTo, opts: extra = {} }) {
  const lucid = ctx.as(payer);
  let tx = lucid.newTx().collectFrom([utxo], v.claimRedeemer(secretHex));
  tx = refUtxo ? tx.readFrom([refUtxo]) : tx.attach.SpendingValidator(inst.script);
  if (signer) tx = tx.addSignerKey(ctx.vkh(signer));
  if (validToMs !== undefined) tx = tx.validTo(validToMs);
  let opts = { ...extra };
  if (payer !== by || payTo) {
    const dest = payTo ?? ctx.address(by);
    if (feeFromLocked) opts = { ...opts, changeAddress: dest };
    else tx = tx.pay.ToAddress(dest, { lovelace: utxo.assets.lovelace });
  }
  const txb = await tx.complete(opts);
  const witnesses = [await txb.partialSign.withWallet()];
  if (signer && signer !== payer) witnesses.push(await ctx.as(signer).fromTx(txb.toCBOR()).partialSign.withWallet());
  return finish(ctx, txb, await txb.assemble(witnesses).complete());
}

export async function buildRefund(ctx, { v, inst, utxo, by = "maker", refUtxo, validFromMs }) {
  const lucid = ctx.as(by);
  let tx = lucid.newTx().collectFrom([utxo], v.refundRedeemer()).addSignerKey(ctx.vkh(by));
  tx = refUtxo ? tx.readFrom([refUtxo]) : tx.attach.SpendingValidator(inst.script);
  if (validFromMs !== undefined) tx = tx.validFrom(validFromMs);
  const txb = await tx.complete();
  return finish(ctx, txb, await txb.sign.withWallet().complete());
}

export async function buildTransfer(ctx, { from, to, lovelace }) {
  const lucid = ctx.as(from);
  const txb = await lucid.newTx().pay.ToAddress(to, { lovelace }).complete();
  return finish(ctx, txb, await txb.sign.withWallet().complete());
}

async function finish(ctx, txb, signed) {
  const cbor = signed.toCBOR();
  return { signed, cbor, resolved: await resolveInputs(ctx, cbor) };
}

export async function resolveInputs(ctx, cbor) {
  const body = CML.Transaction.from_cbor_hex(cbor).body();
  const refs = [];
  for (const list of [body.inputs(), body.reference_inputs(), body.collateral_inputs()]) {
    for (let i = 0; i < (list?.len() ?? 0); i++) refs.push({ txHash: list.get(i).transaction_id().to_hex(), outputIndex: Number(list.get(i).index()) });
  }
  const uniq = [...new Map(refs.map((r) => [`${r.txHash}#${r.outputIndex}`, r])).values()];
  return ctx.lucid.utxosByOutRef(uniq);
}

// ---------------------------------------------------------------------------------------------
// Measurement and the checks the emulator does not make itself.
// ---------------------------------------------------------------------------------------------
const scriptBytes = (s) => { const h = s.script; const b = Buffer.from(h, "hex"); // strip the outer CBOR byte-string header to get the bytes the ledger counts
  const ai = b[0] & 0x1f; const hdr = ai < 24 ? 1 : ai === 24 ? 2 : ai === 25 ? 3 : 5; return b.length - hdr; };

// Conway reference-script fee: 15 lovelace/byte for the first 25,600 bytes, x1.2 for every further 25,600-byte tier.
export function refScriptFee(totalBytes, perByte) {
  let fee = 0, rate = perByte, left = totalBytes;
  while (left > 0) { const chunk = Math.min(left, 25_600); fee += chunk * rate; rate *= 1.2; left -= chunk; }
  return Math.floor(fee);
}

export function analyzeTx(ctx, { cbor, resolved }, label) {
  const p = ctx.params;
  const tx = CML.Transaction.from_cbor_hex(cbor);
  const body = tx.body(), ws = tx.witness_set();
  const size = cbor.length / 2;
  const fee = body.fee();
  const key = (i) => `${i.transaction_id().to_hex()}#${Number(i.index())}`;
  const byRef = new Map(resolved.map((u) => [`${u.txHash}#${u.outputIndex}`, u]));
  const list = (l) => { const o = []; for (let i = 0; i < (l?.len() ?? 0); i++) o.push(key(l.get(i))); return o; };
  const inputs = list(body.inputs()), refInputs = list(body.reference_inputs()), collIn = list(body.collateral_inputs());
  const lovelaceOf = (refs) => refs.reduce((s, r) => { const u = byRef.get(r); if (!u) throw new Error(`${label}: input ${r} not resolved`); return s + u.assets.lovelace; }, 0n);

  const outputs = [];
  const outs = body.outputs();
  for (let i = 0; i < outs.len(); i++) {
    const o = outs.get(i);
    outputs.push({
      index: i, address: o.address().to_bech32(), lovelace: o.amount().coin(),
      min_lovelace: CML.min_ada_required(o, p.coinsPerUtxoByte), bytes: o.to_cbor_bytes().length,
      inline_datum: !!o.datum()?.as_datum(), script_ref: !!o.script_ref(),
    });
  }

  // Redeemers (Conway map form or the legacy array form).
  const redeemers = [];
  const rd = ws.redeemers();
  const legacy = rd?.as_arr_legacy_redeemer(), map = rd?.as_map_redeemer_key_to_redeemer_val();
  if (legacy) for (let i = 0; i < legacy.len(); i++) { const r = legacy.get(i); redeemers.push({ tag: r.tag(), index: Number(r.index()), mem: Number(r.ex_units().mem()), steps: Number(r.ex_units().steps()) }); }
  if (map) { const ks = map.keys(); for (let i = 0; i < ks.len(); i++) { const k = ks.get(i), val = map.get(k); redeemers.push({ tag: k.tag(), index: Number(k.index()), mem: Number(val.ex_units().mem()), steps: Number(val.ex_units().steps()) }); } }
  const mem = redeemers.reduce((s, r) => s + r.mem, 0), steps = redeemers.reduce((s, r) => s + r.steps, 0);

  // Reference-script bytes the fee is charged on: scripts sitting on reference inputs AND on spent inputs.
  const refBytes = [...new Set([...inputs, ...refInputs])].reduce((s, r) => s + (byRef.get(r)?.scriptRef ? scriptBytes(byRef.get(r).scriptRef) : 0), 0);
  const witnessScripts = ws.plutus_v3_scripts(); let witnessScriptBytes = 0;
  for (let i = 0; i < (witnessScripts?.len() ?? 0); i++) witnessScriptBytes += witnessScripts.get(i).to_cbor_bytes().length;

  const exFee = Math.ceil(p.priceMem * mem + p.priceStep * steps - 1e-9);
  const refFee = refScriptFee(refBytes, p.minFeeRefScriptCostPerByte ?? 0);
  const minFee = BigInt(p.minFeeA * size + p.minFeeB + exFee + refFee);

  // vkey witnesses, verified here with @noble/curves against the body hash (independent of lucid / CML).
  const bodyHash = CML.hash_transaction(body).to_hex();
  const vk = ws.vkeywitnesses(); const vkeys = [];
  for (let i = 0; i < (vk?.len() ?? 0); i++) {
    const wt = vk.get(i), pub = wt.vkey().to_raw_bytes(), sig = wt.ed25519_signature().to_raw_bytes();
    vkeys.push({ key_hash: hex(blake2b224(pub)), valid: ed25519.verify(sig, Buffer.from(bodyHash, "hex"), pub) });
  }

  const inSum = lovelaceOf(inputs), outSum = outputs.reduce((s, o) => s + o.lovelace, 0n);
  const collReturn = body.collateral_return()?.amount().coin() ?? null;
  const collIn_lovelace = collIn.length ? lovelaceOf(collIn) : 0n;
  const total_collateral = body.total_collateral() ?? (collIn.length ? collIn_lovelace - (collReturn ?? 0n) : 0n);
  const required_collateral = redeemers.length ? (fee * BigInt(p.collateralPercentage) + 99n) / 100n : 0n;
  const checks = {
    fee_covers_recomputed_min_fee: fee >= minFee,
    value_conserved: inSum === outSum + fee,
    outputs_meet_min_utxo: outputs.every((o) => o.lovelace >= o.min_lovelace),
    within_max_tx_size: size <= p.maxTxSize,
    within_max_ex_units: BigInt(mem) <= p.maxTxExMem && BigInt(steps) <= p.maxTxExSteps,
    vkey_witnesses_verify_noble: vkeys.every((k) => k.valid),
    collateral_covers_requirement: total_collateral >= required_collateral,
  };
  return {
    label, tx_hash: bodyHash, size_bytes: size, fee_lovelace: fee, fee_ada: ada(fee),
    ex_units: redeemers.length ? { mem, steps } : null,
    fee_breakdown_lovelace: { size_part: p.minFeeA * size, constant: p.minFeeB, execution: exFee, reference_script: refFee, recomputed_min_fee: minFee, paid_above_min: fee - minFee },
    inputs: inputs.length, reference_inputs: refInputs.length, reference_script_bytes: refBytes, witness_script_bytes: witnessScriptBytes,
    vkey_witnesses: vkeys.length, required_signers: body.required_signers()?.len() ?? 0,
    validity: { from_slot: body.validity_interval_start() ?? null, to_slot: body.ttl() ?? null },
    collateral: redeemers.length ? { inputs: collIn.length, input_lovelace: collIn_lovelace, return_lovelace: collReturn, total_collateral_lovelace: total_collateral, required_150pct_of_fee_lovelace: required_collateral } : null,
    outputs, checks, all_checks_pass: Object.values(checks).every(Boolean),
  };
}

// Independent ex-unit count from a real cardano-node: Ogmios evaluateTransaction behind Koios preprod, with the
// emulator's UTxOs passed as additionalUtxo. Preprod has the same Plutus cost models as mainnet (checked in measure.mjs).
let koiosPreprod;
export async function ogmiosEvaluate({ cbor, resolved }) {
  koiosPreprod ??= new Koios(KOIOS_PREPROD);
  try {
    const r = await koiosPreprod.evaluateTx(cbor, resolved);
    return { ok: true, mem: r.reduce((s, x) => s + Number(x.ex_units.mem), 0), steps: r.reduce((s, x) => s + Number(x.ex_units.steps), 0) };
  } catch (e) {
    return { ok: false, error: String(e?.cause?.message ?? e?.message ?? e).slice(0, 600) };
  }
}

export const errText = (e) => String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 300);
export const jsonSafe = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString()) : v)));

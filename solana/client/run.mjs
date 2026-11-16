// End-to-end driver for the CKB light-client program.
//
//   node run.mjs --rpc <url> --program <PROGRAM_ID> --payer <keypair.json | env:PATH_TO_.env>
//
// Steps: (1) negative-control simulations (free), (2) verify-only tx (CU measurement),
// (3) create + init a state account anchored at the segment's parent, (4) submit the proof
// (tip advances), (5) replay the same proof (must fail: no longer extends tip), (6) read state.
import { readFileSync, writeFileSync } from "node:fs";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const RPC = arg("rpc", "http://127.0.0.1:8899");
const PROGRAM_ID = new PublicKey(arg("program"));
const FIXTURE = arg("fixture", new URL("../../fixtures/proofs/groth16-mainnet-n16.json", import.meta.url));
const OUT = arg("out");

function loadPayer(spec) {
  if (spec.startsWith("env:")) {
    // read SOL_PRIVKEY (JSON array) from a .env file without printing it
    for (const line of readFileSync(spec.slice(4), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*SOL_PRIVKEY\s*=\s*(.*)\s*$/);
      if (m) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(m[1].replace(/^["']|["']$/g, ""))));
    }
    throw new Error("SOL_PRIVKEY not found");
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(spec, "utf8"))));
}

const hexb = (h) => Buffer.from(h.replace(/^0x/, ""), "hex");
const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
const pv = hexb(fx.public_values), proof = hexb(fx.proof);
const firstNumber = pv.readBigUInt64LE(0), lastNumber = pv.readBigUInt64LE(8);
const firstParent = pv.subarray(16, 48), lastHash = pv.subarray(48, 80);

const pvProofData = (tag, pvBytes, proofBytes) => {
  const len = Buffer.alloc(2); len.writeUInt16LE(pvBytes.length);
  return Buffer.concat([Buffer.from([tag]), len, pvBytes, proofBytes]);
};
const cu = (n) => ComputeBudgetProgram.setComputeUnitLimit({ units: n });

const conn = new Connection(RPC, "confirmed");
const payer = loadPayer(arg("payer"));
const report = { rpc: RPC, program: PROGRAM_ID.toBase58(), payer: payer.publicKey.toBase58(), fixture: String(FIXTURE), steps: {} };
const log = (k, v) => { report.steps[k] = v; console.log(`${k}:`, typeof v === "string" ? v : JSON.stringify(v)); };

async function simulate(ixData, keys = [], units = 400_000) {
  const tx = new Transaction().add(cu(units), new TransactionInstruction({ programId: PROGRAM_ID, keys, data: ixData }));
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(payer);
  const r = await conn.simulateTransaction(tx);
  return { err: r.value.err, cu: r.value.unitsConsumed, logs: (r.value.logs || []).filter((l) => l.includes("Program log")) };
}

async function send(label, ixs, signers = []) {
  const tx = new Transaction().add(...ixs);
  const sig = await sendAndConfirmTransaction(conn, tx, [payer, ...signers], { commitment: "confirmed" });
  const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const r = { sig, cu: t?.meta?.computeUnitsConsumed, fee_lamports: t?.meta?.fee, logs: (t?.meta?.logMessages || []).filter((l) => l.includes("Program log")) };
  log(label, r);
  return r;
}

console.log(`rpc=${RPC} program=${PROGRAM_ID.toBase58()} payer=${payer.publicKey.toBase58()}`);
console.log(`segment #${firstNumber}..#${lastNumber}, balance=${(await conn.getBalance(payer.publicKey)) / 1e9} SOL`);

// (1) negative controls — simulation only
const badPv = Buffer.from(pv); badPv[50] ^= 1;
const badProof = Buffer.from(proof); badProof[200] ^= 1;
log("sim_tampered_public_values", await simulate(pvProofData(2, badPv, proof)));
log("sim_tampered_proof", await simulate(pvProofData(2, pv, badProof)));
log("sim_genuine", await simulate(pvProofData(2, pv, proof)));

// (2) verify-only transaction
await send("tx_verify_only", [cu(400_000), new TransactionInstruction({ programId: PROGRAM_ID, keys: [], data: pvProofData(2, pv, proof) })]);

// (3) create + init state anchored at the segment parent (#first-1)
const state = Keypair.generate();
const STATE_LEN = 128;
const rent = await conn.getMinimumBalanceForRentExemption(STATE_LEN);
const initData = Buffer.alloc(41); initData[0] = 0; initData.writeBigUInt64LE(firstNumber - 1n, 1); firstParent.copy(initData, 9);
await send("tx_create_and_init_state", [
  SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: state.publicKey, lamports: rent, space: STATE_LEN, programId: PROGRAM_ID }),
  new TransactionInstruction({ programId: PROGRAM_ID, keys: [
    { pubkey: state.publicKey, isSigner: false, isWritable: true },
    { pubkey: payer.publicKey, isSigner: true, isWritable: false }], data: initData }),
], [state]);
report.state_account = state.publicKey.toBase58();

// (4) submit proof -> tip advances
const submitIx = new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: state.publicKey, isSigner: false, isWritable: true }], data: pvProofData(1, pv, proof) });
await send("tx_submit_segment", [cu(400_000), submitIx]);

// (5) replay must fail in the program (segment no longer extends the tip -> Custom 6).
// A different CU limit makes the tx distinct, so the runtime doesn't short-circuit it as AlreadyProcessed.
const replay = await simulate(pvProofData(1, pv, proof), [{ pubkey: state.publicKey, isSigner: false, isWritable: true }], 399_999);
log("sim_replay_same_segment", replay);
const replayRejectedByProgram = JSON.stringify(replay.err) === JSON.stringify({ InstructionError: [1, { Custom: 6 }] });

// (6) read back state
const acc = await conn.getAccountInfo(state.publicKey);
const d = acc.data;
const st = {
  magic: d.subarray(0, 8).toString(), admin: new PublicKey(d.subarray(8, 40)).toBase58(),
  tip_number: d.readBigUInt64LE(40).toString(), tip_hash: "0x" + d.subarray(48, 80).toString("hex"),
  total_difficulty: "0x" + Buffer.from(d.subarray(80, 112)).reverse().toString("hex").replace(/^0+/, ""),
  updates: d.readBigUInt64LE(112).toString(),
};
log("state", st);
const ok = st.tip_number === lastNumber.toString() && st.tip_hash === "0x" + lastHash.toString("hex")
  && report.steps.sim_tampered_public_values.err && report.steps.sim_tampered_proof.err && !report.steps.sim_genuine.err && replayRejectedByProgram;
console.log(ok ? "\nALL CHECKS PASSED" : "\nCHECKS FAILED");
if (OUT) writeFileSync(OUT, JSON.stringify(report, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
process.exit(ok ? 0 : 1);

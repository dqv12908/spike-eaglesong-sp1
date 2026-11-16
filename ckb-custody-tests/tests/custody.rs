//! Custody lock tests in ckb-testtool's simulated chain (real CKB-VM, real Type ID rules).
//! Binary: ~/custody-target/riscv64imac-unknown-none-elf/release/custody-lock (CUSTODY_BIN overrides).
use ckb_testtool::ckb_types::{
    bytes::Bytes,
    core::{ScriptHashType, TransactionBuilder, TransactionView},
    packed::{CellDep, CellInput, CellOutput, OutPoint, Script, WitnessArgs},
    prelude::*,
};
use ckb_testtool::context::Context;
use ed25519_compact::{KeyPair, Seed};

const TYPE_ID: [u8; 32] = {
    let mut b = [0u8; 32];
    let t = *b"TYPE_ID";
    let mut i = 0;
    while i < 7 {
        b[25 + i] = t[i];
        i += 1;
    }
    b
};
const MAX_CYCLES: u64 = 70_000_000;
const CKB: u64 = 100_000_000;

fn ckbhash(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = blake2b_ref::Blake2bBuilder::new(32).personal(b"ckb-default-hash").build();
    for p in parts {
        h.update(p);
    }
    let mut o = [0u8; 32];
    h.finalize(&mut o);
    o
}

fn vault_data(seq: u64) -> Bytes {
    let mut v = b"CKBSOLV1".to_vec();
    v.extend_from_slice(&seq.to_le_bytes());
    v.into()
}

struct Env {
    ctx: Context,
    keys: Vec<KeyPair>,
    lock: Script,
    vault_type: Script,
    vault_type_hash: [u8; 32],
    bridge_id: [u8; 32],
    recipient: Script,
    relayer: Script,
    deps: Vec<OutPoint>,
}

fn env(m: u8) -> Env {
    let mut ctx = Context::default();
    let path = std::env::var("CUSTODY_BIN").unwrap_or_else(|_| {
        format!("{}/custody-target/riscv64imac-unknown-none-elf/release/custody-lock", std::env::var("HOME").unwrap())
    });
    let code = ctx.deploy_cell(Bytes::from(std::fs::read(path).expect("custody binary")));
    let always = ctx.deploy_cell(ckb_testtool::builtin::ALWAYS_SUCCESS.clone());
    let keys: Vec<KeyPair> = (0..3u8).map(|i| KeyPair::from_seed(Seed::new([i + 1; 32]))).collect();
    let vault_type = Script::new_builder()
        .code_hash(TYPE_ID.pack())
        .hash_type(ScriptHashType::Type)
        .args(Bytes::from(vec![7u8; 32]).pack())
        .build();
    let vault_type_hash: [u8; 32] = vault_type.calc_script_hash().unpack();
    let bridge_id = [0xb1u8; 32];
    let mut args = vault_type_hash.to_vec();
    args.extend_from_slice(&bridge_id);
    args.push(m);
    args.push(keys.len() as u8);
    for k in &keys {
        args.extend_from_slice(k.pk.as_ref());
    }
    let lock = ctx.build_script_with_hash_type(&code, ScriptHashType::Data2, args.into()).unwrap();
    let recipient = ctx.build_script(&always, Bytes::from(vec![0xaa])).unwrap();
    let relayer = ctx.build_script(&always, Bytes::from(vec![0xbb])).unwrap();
    Env { ctx, keys, lock, vault_type, vault_type_hash, bridge_id, recipient, relayer, deps: vec![code, always] }
}

/// Attestation for burn `seq`: signers = attester indices (must be sorted for a valid witness).
fn witness(e: &Env, seq: u64, amount: u64, recipient: [u8; 32], signers: &[usize]) -> Bytes {
    let msg = ckbhash(&[b"CKB-SOL-UNLOCK-V1", &e.bridge_id, &e.vault_type_hash, &seq.to_le_bytes(), &amount.to_le_bytes(), &recipient]);
    let mut w = Vec::new();
    w.extend_from_slice(&seq.to_le_bytes());
    w.extend_from_slice(&amount.to_le_bytes());
    w.extend_from_slice(&recipient);
    w.push(signers.len() as u8);
    for &i in signers {
        w.push(i as u8);
        w.extend_from_slice(e.keys[i].sk.sign(msg, None).as_ref());
    }
    WitnessArgs::new_builder().lock(Some(Bytes::from(w)).pack()).build().as_bytes()
}

struct Case {
    vault_in: Option<(u64, u64)>, // (capacity, seq)
    deposits: Vec<u64>,
    vault_out: Option<(u64, u64)>,
    extra_custody_out: Option<u64>,
    pay: u64,
    witness: Bytes,
}

fn build(e: &mut Env, c: &Case) -> TransactionView {
    let mut inputs = vec![];
    if let Some((cap, seq)) = c.vault_in {
        let op = e.ctx.create_cell(
            CellOutput::new_builder().capacity(cap).lock(e.lock.clone()).type_(Some(e.vault_type.clone()).pack()).build(),
            vault_data(seq),
        );
        inputs.push(CellInput::new_builder().previous_output(op).build());
    }
    for &d in &c.deposits {
        let op = e.ctx.create_cell(CellOutput::new_builder().capacity(d).lock(e.lock.clone()).build(), Bytes::from(vec![9u8; 32]));
        inputs.push(CellInput::new_builder().previous_output(op).build());
    }
    let fee_in = e.ctx.create_cell(CellOutput::new_builder().capacity(1000 * CKB).lock(e.relayer.clone()).build(), Bytes::new());
    inputs.push(CellInput::new_builder().previous_output(fee_in).build());

    let mut outputs = vec![];
    let mut data = vec![];
    if let Some((cap, seq)) = c.vault_out {
        outputs.push(CellOutput::new_builder().capacity(cap).lock(e.lock.clone()).type_(Some(e.vault_type.clone()).pack()).build());
        data.push(vault_data(seq));
    }
    if let Some(cap) = c.extra_custody_out {
        outputs.push(CellOutput::new_builder().capacity(cap).lock(e.lock.clone()).build());
        data.push(Bytes::from(vec![9u8; 32]));
    }
    if c.pay > 0 {
        outputs.push(CellOutput::new_builder().capacity(c.pay).lock(e.recipient.clone()).build());
        data.push(Bytes::new());
    }
    outputs.push(CellOutput::new_builder().capacity(999 * CKB).lock(e.relayer.clone()).build());
    data.push(Bytes::new());

    let mut witnesses = vec![c.witness.pack()];
    for _ in 1..inputs.len() {
        witnesses.push(Bytes::new().pack());
    }
    // Type ID is built into CKB (no code cell), so add the two code deps by hand.
    let deps: Vec<CellDep> = e.deps.iter().map(|op| CellDep::new_builder().out_point(op.clone()).build()).collect();
    TransactionBuilder::default().inputs(inputs).outputs(outputs).outputs_data(data.pack()).witnesses(witnesses).cell_deps(deps).build()
}

fn rh(e: &Env) -> [u8; 32] {
    e.recipient.calc_script_hash().unpack()
}

/// Run and return Ok(cycles) or the script's exit code.
fn run(e: &mut Env, c: &Case) -> Result<u64, i8> {
    let tx = build(e, c);
    e.ctx.verify_tx(&tx, MAX_CYCLES).map_err(|err| {
        let s = err.to_string();
        let code = s.split("error code ").nth(1).and_then(|r| r.split(|ch: char| !ch.is_ascii_digit() && ch != '-').next()).and_then(|n| n.parse().ok());
        code.unwrap_or_else(|| panic!("unexpected failure: {s}"))
    })
}

fn good(e: &Env) -> Case {
    // vault 300 + deposits 200 + 150 = 650 in custody; pay 250 out; new vault 400.
    Case {
        vault_in: Some((300 * CKB, 5)),
        deposits: vec![200 * CKB, 150 * CKB],
        vault_out: Some((400 * CKB, 6)),
        extra_custody_out: None,
        pay: 250 * CKB,
        witness: witness(e, 5, 250 * CKB, rh(e), &[0, 2]),
    }
}

#[test]
fn unlock_ok() {
    let mut e = env(2);
    let c = good(&e);
    let cycles = run(&mut e, &c).expect("valid unlock");
    println!("valid 2-of-3 unlock: {cycles} cycles");
}

#[test]
fn donation_to_custody_advances_counter() {
    let mut e = env(2);
    let own: [u8; 32] = e.lock.calc_script_hash().unpack();
    let c = Case { vault_out: Some((650 * CKB, 6)), pay: 0, witness: witness(&e, 5, 250 * CKB, own, &[0, 1]), ..good(&e) };
    run(&mut e, &c).expect("burn to custody = no outflow, seq+1");
}

#[test]
fn rejections() {
    let mut e = env(2);
    let r = rh(&e);
    let g = good(&e);
    let cases: Vec<(&str, Case, i8)> = vec![
        ("wrong seq (replay of burn 4)", Case { witness: witness(&e, 4, 250 * CKB, r, &[0, 2]), ..good(&e) }, 8),
        ("one signature, m = 2", Case { witness: witness(&e, 5, 250 * CKB, r, &[1]), ..good(&e) }, 10),
        ("same attester twice", Case { witness: witness(&e, 5, 250 * CKB, r, &[1, 1]), ..good(&e) }, 15),
        ("signed a smaller amount", Case { witness: {
            let mut w = witness(&e, 5, 100 * CKB, r, &[0, 2]).to_vec();
            // patch the amount field after signing (WitnessArgs header 16 B + Bytes len 4 B + seq 8 B)
            w[28..36].copy_from_slice(&(250 * CKB).to_le_bytes());
            w.into()
        }, ..good(&e) }, 9),
        ("vault keeps too little (steals 1 CKB)", Case { vault_out: Some((399 * CKB, 6)), ..good(&e) }, 13),
        ("recipient underpaid", Case { pay: 249 * CKB, vault_out: Some((400 * CKB, 6)), ..good(&e) }, 14),
        ("change to a 2nd custody cell", Case { vault_out: Some((300 * CKB, 6)), extra_custody_out: Some(100 * CKB), ..good(&e) }, 12),
        ("counter not bumped", Case { vault_out: Some((400 * CKB, 5)), ..good(&e) }, 11),
        ("no vault in inputs", Case { vault_in: None, vault_out: None, ..good(&e) }, 3),
        ("vault destroyed", Case { vault_out: None, pay: 650 * CKB, witness: witness(&e, 5, 650 * CKB, r, &[0, 2]), ..good(&e) }, 11),
    ];
    let _ = g;
    for (name, c, want) in cases {
        let got = run(&mut e, &c);
        println!("{name}: {got:?}");
        assert_eq!(got, Err(want), "{name}");
    }
}

#[test]
fn key_outside_committee_rejected() {
    let mut e = env(1);
    let outsider = KeyPair::from_seed(Seed::new([42; 32]));
    let r = rh(&e);
    e.keys[0] = outsider; // signs as index 0, but args hold the original key 0
    let c = Case { witness: witness(&e, 5, 250 * CKB, r, &[0]), ..good(&e) };
    assert_eq!(run(&mut e, &c), Err(9));
}

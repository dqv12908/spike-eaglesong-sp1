//! Deposit-cell inclusion against a real CKB testnet transaction (fixtures/deposit_sample_testnet.json,
//! produced by scripts/fetch_deposit.py, which cross-checks the CBMT proof and lock hash in Python).
use ckb_pow::{deposit::*, rpc, verify_segment_with, PowFunc, HEADER_LEN};

struct Fx {
    v: serde_json::Value,
    headers: Vec<u8>,
    raw: Vec<u8>,
    lemmas: Vec<[u8; 32]>,
    wroot: [u8; 32],
}

fn h(s: &serde_json::Value) -> Vec<u8> {
    hex::decode(s.as_str().unwrap().trim_start_matches("0x")).unwrap()
}

fn load() -> Fx {
    let v: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/deposit_sample_testnet.json")).unwrap();
    let headers = v["headers"].as_array().unwrap().iter().flat_map(rpc::header_bytes).collect();
    let raw = h(&v["raw_tx"]);
    let lemmas = v["lemmas"].as_array().unwrap().iter().map(|x| h(x).try_into().unwrap()).collect();
    let wroot = h(&v["witnesses_root"]).try_into().unwrap();
    Fx { v, headers, raw, lemmas, wroot }
}

fn run(f: &Fx) -> Result<DepositEvent, DepositError> {
    let ti = f.v["tree_index"].as_u64().unwrap() as u32;
    verify_deposit(&f.headers, &f.raw, f.v["out_index"].as_u64().unwrap() as u32, ti, &f.lemmas, f.wroot)
}

#[test]
fn genuine_deposit_matches_rpc() {
    let f = load();
    let e = run(&f).expect("valid");
    let x = &f.v["expect"];
    assert_eq!(e.capacity, x["capacity"].as_u64().unwrap());
    assert_eq!(e.lock_hash.to_vec(), h(&x["lock_hash"]));
    assert_eq!(e.has_type, x["has_type"].as_bool().unwrap());
    assert_eq!(e.data_len as usize, h(&x["data"]).len());
    assert_eq!(e.tx_hash.to_vec(), h(&f.v["tx_hash"]));
    assert_eq!(e.block_hash.to_vec(), h(&f.v["block_hash"]));
    assert_eq!(e.anchor_number, x["anchor_number"].as_u64().unwrap());
    assert_eq!(e.anchor_hash.to_vec(), h(&x["anchor_hash"]));
    assert_eq!(e.to_bytes().len(), DEPOSIT_EVENT_LEN);
}

#[test]
fn segment_covers_anchor_with_testnet_pow() {
    let f = load();
    let seg: Vec<u8> = f.v["segment"].as_array().unwrap().iter().flat_map(rpc::header_bytes).collect();
    let s = verify_segment_with(&seg, PowFunc::EaglesongBlake2b).expect("testnet PoW");
    assert_eq!(s.last_hash.to_vec(), h(&f.v["expect"]["anchor_hash"]));
    assert_eq!(s.first_parent_hash.to_vec(), h(&f.v["checkpoint"]["hash"]));
}

#[test]
fn tampering_rejected() {
    let f = load();
    let mut g = load();
    g.lemmas[0][3] ^= 1;
    assert_eq!(run(&g), Err(DepositError::TransactionsRootMismatch));
    let mut g = load();
    let n = g.raw.len();
    g.raw[n - 1] ^= 1; // last byte of outputs_data
    assert_eq!(run(&g), Err(DepositError::TransactionsRootMismatch));
    let mut g = load();
    g.wroot[0] ^= 1;
    assert_eq!(run(&g), Err(DepositError::TransactionsRootMismatch));
    let mut g = load();
    g.v["tree_index"] = serde_json::json!(f.v["tree_index"].as_u64().unwrap() + 1);
    assert!(run(&g).is_err());
    // broken linkage: drop a middle header
    let mut g = load();
    g.headers.drain(2 * HEADER_LEN..3 * HEADER_LEN);
    assert!(matches!(run(&g), Err(DepositError::HeightGap { .. })));
    // non-existent output
    let mut g = load();
    g.v["out_index"] = serde_json::json!(99);
    assert_eq!(run(&g), Err(DepositError::NoSuchOutput));
    // a header from a different block as B fails the transactions_root check
    let mut g = load();
    g.headers.drain(..HEADER_LEN);
    assert_eq!(run(&g), Err(DepositError::TransactionsRootMismatch));
}

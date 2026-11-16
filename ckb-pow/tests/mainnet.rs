//! Ground truth: real CKB mainnet headers must verify; tampered ones must not.
//! Run with: cargo test -p ckb-pow --features rpc --release -- --nocapture
use ckb_pow::{rpc, verify_pow, verify_segment, Error, HeaderView, HEADER_LEN};
use std::time::Instant;

const FIXTURE: &str = include_str!("../../fixtures/mainnet_headers.json");
const VECTORS: &str = include_str!("eaglesong_vectors.txt");

fn run_bytes() -> Vec<u8> {
    let (run, _) = rpc::load_fixture(FIXTURE);
    run.iter().flat_map(|h| rpc::header_bytes(h)).collect()
}

#[test]
fn eaglesong_reference_vectors() {
    let mut lines = VECTORS.lines();
    let mut n = 0;
    while let Some(line) = lines.next() {
        if let Some(input) = line.strip_prefix("Input = ") {
            let want = lines.next().unwrap().strip_prefix("Output = ").unwrap();
            assert_eq!(hex::encode(ckb_pow::eaglesong(&hex::decode(input).unwrap())), want);
            n += 1;
        }
    }
    assert!(n >= 5, "only {n} vectors");
}

#[test]
fn pow48_fast_path_equals_reference_sponge() {
    // real PoW messages
    let (run, samples) = rpc::load_fixture(FIXTURE);
    for h in run.iter().chain(samples.iter()) {
        let b = rpc::header_bytes(h);
        let m = ckb_pow::pow_message(HeaderView(&b));
        assert_eq!(ckb_pow::eaglesong_pow48(&m), ckb_pow::eaglesong(&m));
    }
    // pseudo-random messages (xorshift), incl. all-zero / all-ones edge cases
    let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut cases = vec![[0u8; 48], [0xffu8; 48]];
    for _ in 0..2000 {
        let mut m = [0u8; 48];
        for byte in m.iter_mut() {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            *byte = x as u8;
        }
        cases.push(m);
    }
    for m in cases {
        assert_eq!(ckb_pow::eaglesong_pow48(&m), ckb_pow::eaglesong(&m));
    }
}

#[test]
fn serialization_matches_rpc_block_hash() {
    let (run, samples) = rpc::load_fixture(FIXTURE);
    for h in run.iter().chain(samples.iter()) {
        let b = rpc::header_bytes(h);
        assert_eq!(HeaderView(&b).hash(), rpc::rpc_hash(h), "hash mismatch at {}", h["number"]);
    }
}

#[test]
fn mainnet_pow_function_is_plain_eaglesong() {
    use ckb_pow::{verify_pow_with, PowFunc};
    let (run, samples) = rpc::load_fixture(FIXTURE);
    let all: Vec<_> = run.iter().chain(samples.iter()).map(rpc::header_bytes).collect();
    let ok = |f| all.iter().filter(|b| verify_pow_with(HeaderView(b), f).is_ok()).count();
    let (plain, b2b) = (ok(PowFunc::Eaglesong), ok(PowFunc::EaglesongBlake2b));
    println!("headers={} pass[Eaglesong]={plain} pass[EaglesongBlake2b]={b2b}", all.len());
    assert_eq!(plain, all.len());
    assert!(b2b < all.len());
}

#[test]
fn testnet_pow_function_report() {
    use ckb_pow::{verify_pow_with, PowFunc};
    let (run, samples) = rpc::load_fixture(include_str!("../../fixtures/testnet_headers.json"));
    let all: Vec<_> = run.iter().chain(samples.iter()).map(rpc::header_bytes).collect();
    for (h, b) in run.iter().chain(samples.iter()).zip(&all) {
        assert_eq!(HeaderView(b).hash(), rpc::rpc_hash(h));
    }
    let ok = |f| all.iter().filter(|b| verify_pow_with(HeaderView(b), f).is_ok()).count();
    println!(
        "testnet headers={} pass[Eaglesong]={} pass[EaglesongBlake2b]={}",
        all.len(),
        ok(PowFunc::Eaglesong),
        ok(PowFunc::EaglesongBlake2b)
    );
    assert_eq!(ok(PowFunc::EaglesongBlake2b), all.len());
}

#[test]
fn every_mainnet_header_passes_pow() {
    let (run, samples) = rpc::load_fixture(FIXTURE);
    for h in run.iter().chain(samples.iter()) {
        let b = rpc::header_bytes(h);
        verify_pow(HeaderView(&b)).unwrap_or_else(|e| panic!("{} failed: {e:?}", h["number"]));
    }
}

#[test]
fn contiguous_segment_verifies_and_reports_summary() {
    let bytes = run_bytes();
    let t = Instant::now();
    let s = verify_segment(&bytes).expect("segment");
    let dt = t.elapsed();
    let n = bytes.len() / HEADER_LEN;
    assert_eq!(s.last_number - s.first_number + 1, n as u64);
    println!(
        "native: {n} headers #{}..#{} in {dt:?} ({:?}/header), total_difficulty={:#x}",
        s.first_number, s.last_number, dt / n as u32, s.total_difficulty
    );
}

#[test]
fn tampered_nonce_fails_pow() {
    let (run, _) = rpc::load_fixture(FIXTURE);
    let mut fails = 0;
    for h in run.iter().take(32) {
        let mut b = rpc::header_bytes(h);
        b[200] ^= 0x01; // flip a nonce bit
        if matches!(verify_pow(HeaderView(&b)), Err(Error::PowAboveTarget { .. })) {
            fails += 1;
        }
    }
    // A random nonce meets mainnet target with negligible probability.
    assert_eq!(fails, 32);
}

#[test]
fn tampered_field_fails_pow() {
    let mut bytes = run_bytes();
    bytes[64] ^= 0xff; // first header's transactions_root
    assert!(matches!(verify_segment(&bytes), Err(Error::PowAboveTarget { .. })));
}

#[test]
fn broken_linkage_is_rejected() {
    let mut bytes = run_bytes();
    // swap headers 10 and 11 -> height gap
    let (a, b) = (10 * HEADER_LEN, 11 * HEADER_LEN);
    let h10: Vec<u8> = bytes[a..b].to_vec();
    bytes.copy_within(b..b + HEADER_LEN, a);
    bytes[b..b + HEADER_LEN].copy_from_slice(&h10);
    assert!(matches!(verify_segment(&bytes), Err(Error::HeightGap { .. })));

    // wrong parent hash on an otherwise in-order header
    let mut bytes = run_bytes();
    bytes[11 * HEADER_LEN + 32] ^= 0x01;
    assert!(matches!(verify_segment(&bytes), Err(Error::ParentMismatch { number: _ })));

    // drop a header in the middle -> gap
    let mut bytes = run_bytes();
    bytes.drain(50 * HEADER_LEN..51 * HEADER_LEN);
    assert!(matches!(verify_segment(&bytes), Err(Error::HeightGap { .. })));
}

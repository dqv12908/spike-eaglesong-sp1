//! Epoch / difficulty transition rules against real headers spanning an epoch boundary
//! (fixtures/epoch_boundary_{testnet,mainnet}.json from scripts/fetch_epoch_boundary.py).
use ckb_pow::{check_transition, rpc, verify_segment_from, Epoch, Error, HeaderView, PowFunc, HEADER_LEN};

fn load(json: &str) -> ([u8; HEADER_LEN], Vec<u8>) {
    let v: serde_json::Value = serde_json::from_str(json).unwrap();
    let parent = rpc::header_bytes(&v["parent"]);
    let run = v["run"].as_array().unwrap().iter().flat_map(rpc::header_bytes).collect();
    (parent, run)
}

fn set_u32(b: &mut [u8], o: usize, x: u32) {
    b[o..o + 4].copy_from_slice(&x.to_le_bytes());
}

fn enc(e: Epoch) -> u64 {
    e.number | (e.index << 24) | (e.length << 40)
}

fn with_epoch(h: &[u8; HEADER_LEN], e: Epoch) -> [u8; HEADER_LEN] {
    let mut x = *h;
    x[24..32].copy_from_slice(&enc(e).to_le_bytes());
    x
}

#[test]
fn real_boundaries_pass() {
    for (json, pow) in [
        (include_str!("../../fixtures/epoch_boundary_testnet.json"), PowFunc::EaglesongBlake2b),
        (include_str!("../../fixtures/epoch_boundary_mainnet.json"), PowFunc::Eaglesong),
    ] {
        let (parent, run) = load(json);
        let s = verify_segment_from(&parent, &run, pow).expect("real chain");
        let es: Vec<Epoch> = run.chunks_exact(HEADER_LEN).map(|c| Epoch::from_u64(HeaderView(c.try_into().unwrap()).epoch())).collect();
        assert!(es.iter().any(|e| e.index == 0) && es.iter().any(|e| e.index > 0), "run must cross an epoch start");
        println!("#{}..#{} ok, epochs {:?}", s.first_number, s.last_number, es.iter().map(|e| (e.number, e.index, e.length)).collect::<Vec<_>>());
    }
}

#[test]
fn forged_easy_target_rejected() {
    // Mid-epoch header claiming ~max target (any nonce would pass PoW).
    let (parent, run) = load(include_str!("../../fixtures/epoch_boundary_testnet.json"));
    let p = HeaderView(&parent);
    let mut h: [u8; HEADER_LEN] = run[..HEADER_LEN].try_into().unwrap();
    set_u32(&mut h, 4, 0x2100ffff);
    assert_eq!(check_transition(p, HeaderView(&h)), Err(Error::BadDifficulty { number: p.number() + 1 }));
    assert!(matches!(verify_segment_from(&parent, &h, PowFunc::EaglesongBlake2b), Err(Error::BadDifficulty { .. })));
}

#[test]
fn wrong_parent_rejected() {
    let (parent, run) = load(include_str!("../../fixtures/epoch_boundary_testnet.json"));
    let mut p2 = parent;
    p2[200] ^= 1; // different nonce -> different hash
    assert!(matches!(verify_segment_from(&p2, &run, PowFunc::EaglesongBlake2b), Err(Error::ParentMismatch { .. })));
}

#[test]
fn epoch_rules() {
    let (_, run) = load(include_str!("../../fixtures/epoch_boundary_testnet.json"));
    let hs: Vec<[u8; HEADER_LEN]> = run.chunks_exact(HEADER_LEN).map(|c| c.try_into().unwrap()).collect();
    let start = hs.iter().position(|h| Epoch::from_u64(HeaderView(h).epoch()).index == 0).unwrap();
    let (last, first) = (hs[start - 1], hs[start]);
    let fe = Epoch::from_u64(HeaderView(&first).epoch());
    let le = Epoch::from_u64(HeaderView(&last).epoch());
    check_transition(HeaderView(&last), HeaderView(&first)).expect("real epoch start");

    let bad = with_epoch(&first, Epoch { index: 1, ..fe });
    assert!(matches!(check_transition(HeaderView(&last), HeaderView(&bad)), Err(Error::BadEpoch { .. })), "index skip");
    for len in [299, le.length * 2 + 1, 1801] {
        let bad = with_epoch(&first, Epoch { length: len, ..fe });
        assert!(matches!(check_transition(HeaderView(&last), HeaderView(&bad)), Err(Error::BadEpoch { .. })), "len {len}");
    }
    let mid = with_epoch(&last, Epoch { index: le.index - 1, ..le });
    assert!(matches!(check_transition(HeaderView(&mid), HeaderView(&first)), Err(Error::BadEpoch { .. })), "early epoch start");

    // epoch start with target x256 (exponent + 1): beyond the x8 bound
    let mut easy = first;
    set_u32(&mut easy, 4, HeaderView(&first).compact_target() + 0x0100_0000);
    assert!(matches!(check_transition(HeaderView(&last), HeaderView(&easy)), Err(Error::BadDifficulty { .. })));
    // and target / 256 (exponent - 1)
    let mut hard = first;
    set_u32(&mut hard, 4, HeaderView(&first).compact_target() - 0x0100_0000);
    assert!(matches!(check_transition(HeaderView(&last), HeaderView(&hard)), Err(Error::BadDifficulty { .. })));
}

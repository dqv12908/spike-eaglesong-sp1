//! Light-client state transitions (fork choice, ring, two-sided height bound) and burn
//! validation, without proofs: the proof check is separate (tests/verify.rs).
use ckb_light_client::*;

fn diff(x: u64) -> [u8; 32] {
    let mut b = [0u8; 32];
    b[..8].copy_from_slice(&x.to_le_bytes());
    b
}
fn h(tag: u64) -> [u8; 32] {
    let mut b = [0xeeu8; 32];
    b[..8].copy_from_slice(&tag.to_le_bytes());
    b
}
/// Segment of `n` headers on top of (parent_number, parent_hash) with work `w`; tip hash = h(tag).
fn seg(parent_number: u64, parent_hash: [u8; 32], n: u64, w: u64, tag: u64) -> Summary {
    Summary { pow_id: 1, first_number: parent_number + 1, last_number: parent_number + n, first_parent_hash: parent_hash, last_hash: h(tag), total_difficulty_le: diff(w) }
}
fn tip(d: &[u8]) -> (u64, [u8; 32]) {
    (u64::from_le_bytes(d[40..48].try_into().unwrap()), d[48..80].try_into().unwrap())
}
fn new_state() -> Vec<u8> {
    let mut d = vec![0u8; STATE_LEN];
    state_init(&mut d, &[1; 32], 1000, &h(0), 1);
    d
}
fn deposit(block: u64, anchor: (u64, [u8; 32])) -> Deposit {
    Deposit {
        anchor_number: anchor.0,
        anchor_hash: anchor.1,
        block_number: block,
        block_hash: [0; 32],
        tx_hash: [0; 32],
        out_index: 0,
        capacity: 1,
        lock_hash: [0; 32],
        has_type: false,
        data_len: 32,
        recipient: [0; 32],
    }
}

#[test]
fn extend_and_wrong_parent() {
    let mut d = new_state();
    assert_eq!(apply_segment(&mut d, &seg(1000, h(0), 16, 100, 1)), Ok(Applied::Extended));
    assert_eq!(tip(&d), (1016, h(1)));
    // wrong parent hash / height gap / wrong pow
    assert_eq!(apply_segment(&mut d, &seg(1016, h(99), 16, 100, 2)), Err(LcError::DoesNotExtendTip));
    assert_eq!(apply_segment(&mut d, &seg(1017, h(1), 16, 100, 2)), Err(LcError::DoesNotExtendTip));
    let mut s = seg(1016, h(1), 16, 100, 2);
    s.pow_id = 0;
    assert_eq!(apply_segment(&mut d, &s), Err(LcError::WrongPow));
}

#[test]
fn fork_choice_by_cumulative_difficulty() {
    let mut d = new_state();
    apply_segment(&mut d, &seg(1000, h(0), 16, 100, 1)).unwrap(); // A1 #1016 cum 100
    apply_segment(&mut d, &seg(1016, h(1), 16, 100, 2)).unwrap(); // A2 #1032 cum 200
    // competing branch from A1: equal work is not enough
    assert_eq!(apply_segment(&mut d, &seg(1016, h(1), 16, 100, 20)), Err(LcError::ForkNotHeavier));
    assert_eq!(tip(&d), (1032, h(2)));
    // strictly heavier (fewer headers but more work) wins and drops A2
    assert_eq!(apply_segment(&mut d, &seg(1016, h(1), 8, 101, 21)), Ok(Applied::Reorg { dropped: 1 }));
    assert_eq!(tip(&d), (1024, h(21)));
    // the dropped tip can no longer be extended or used as an anchor
    assert_eq!(apply_segment(&mut d, &seg(1032, h(2), 16, 1000, 3)), Err(LcError::DoesNotExtendTip));
    assert_eq!(check_anchor(&d, &deposit(1010, (1032, h(2))), 1, 10_000).err(), Some(LcError::NotAnchored));
    // the surviving ancestors still work
    assert!(check_anchor(&d, &deposit(1010, (1016, h(1))), 1, 10_000).is_ok());
    // and the new branch extends normally
    assert_eq!(apply_segment(&mut d, &seg(1024, h(21), 16, 1, 22)), Ok(Applied::Extended));
}

#[test]
fn ring_window_is_finality_horizon() {
    let mut d = new_state();
    let mut parent = (1000, h(0));
    for i in 1..=20u64 {
        apply_segment(&mut d, &seg(parent.0, parent.1, 10, 50, i)).unwrap();
        parent = (parent.0 + 10, h(i));
    }
    // only the last 16 tips are live: the checkpoint and tips 1..4 fell out of the ring
    assert_eq!(check_anchor(&d, &deposit(1030, (1040, h(4))), 0, 10_000).err(), Some(LcError::NotAnchored));
    assert!(check_anchor(&d, &deposit(1040, (1050, h(5))), 0, 10_000).is_ok());
    // a fork from beyond the ring cannot be applied, however heavy
    assert_eq!(apply_segment(&mut d, &seg(1040, h(4), 10, u64::MAX, 99)), Err(LcError::DoesNotExtendTip));
}

#[test]
fn two_sided_height_bound() {
    let mut d = new_state();
    apply_segment(&mut d, &seg(1000, h(0), 16, 100, 1)).unwrap(); // tip #1016
    apply_segment(&mut d, &seg(1016, h(1), 16, 100, 2)).unwrap(); // tip #1032
    let a = (1016, h(1));
    // depth is measured to the current tip (#1032), not to the anchor
    assert_eq!(check_anchor(&d, &deposit(1010, a), 12, 100), Ok(22));
    assert_eq!(check_anchor(&d, &deposit(1010, a), 23, 100).err(), Some(LcError::TooFewConfirmations));
    assert_eq!(check_anchor(&d, &deposit(1010, a), 12, 21).err(), Some(LcError::DepositTooOld));
    // block above its own anchor
    assert_eq!(check_anchor(&d, &deposit(1020, a), 0, 100).err(), Some(LcError::BadDepositData));
}

#[test]
fn burn_validation() {
    let mut data = Vec::new();
    data.extend_from_slice(&(250 * SHANNONS).to_le_bytes());
    data.extend_from_slice(&[7u8; 32]);
    data.push(1); // type
    data.push(20);
    data.extend_from_slice(&[9u8; 20]);
    let b = parse_burn(&data).unwrap();
    assert_eq!((b.amount, b.hash_type, b.args.len()), (250 * SHANNONS, 1, 20));
    let mut bad = data.clone();
    bad[40] = 3; // invalid hash_type
    assert_eq!(parse_burn(&bad).err(), Some(LcError::BadBurn));
    let mut bad = data.clone();
    bad[41] = 21; // args_len disagrees with data length
    assert_eq!(parse_burn(&bad).err(), Some(LcError::BadBurn));
    let mut small = data.clone();
    small[..8].copy_from_slice(&(60 * SHANNONS).to_le_bytes()); // < 41 + 20 CKB
    assert_eq!(parse_burn(&small).err(), Some(LcError::BurnTooSmall));
    small[..8].copy_from_slice(&(61 * SHANNONS).to_le_bytes());
    assert!(parse_burn(&small).is_ok());
}

#[test]
fn u256_helpers() {
    let max = [0xffu8; 32];
    assert_eq!(add_u256_le(&max, &diff(1)), None);
    let mut hi = [0u8; 32];
    hi[31] = 1;
    assert!(gt_u256_le(&hi, &diff(u64::MAX)));
    assert!(!gt_u256_le(&diff(5), &diff(5)));
}

//! Pure checks of the HTLC escrow: lock parsing, claim window, refund window.
use sol_htlc::*;

fn sha(b: &[u8]) -> [u8; 32] {
    solana_sha256_hasher::hash(b).to_bytes()
}
fn lock_bytes(hash: [u8; 32], amount: u64, expiry: i64) -> Vec<u8> {
    let mut d = hash.to_vec();
    d.extend_from_slice(&[7u8; 32]);
    d.extend_from_slice(&amount.to_le_bytes());
    d.extend_from_slice(&expiry.to_le_bytes());
    d
}

#[test]
fn lock_parsing() {
    let now = 1_000_000;
    let h = sha(&[1u8; 32]);
    let l = parse_lock(&lock_bytes(h, 5, now + 600), now).unwrap();
    assert_eq!((l.hash, l.claimer, l.amount, l.expiry), (h, [7u8; 32], 5, now + 600));
    assert_eq!(parse_lock(&lock_bytes(h, 0, now + 600), now), Err(HtlcError::ZeroAmount));
    assert_eq!(parse_lock(&lock_bytes(h, 5, now), now), Err(HtlcError::BadExpiry));
    assert_eq!(parse_lock(&lock_bytes(h, 5, now + MAX_LOCK_SECS + 1), now), Err(HtlcError::BadExpiry));
    assert!(parse_lock(&lock_bytes(h, 5, now + MAX_LOCK_SECS), now).is_ok());
    assert_eq!(parse_lock(&lock_bytes(h, 5, now + 600)[..79], now), Err(HtlcError::BadInstruction));
}

#[test]
fn escrow_roundtrip_and_windows() {
    let now = 1_000_000;
    let pre = [0x42u8; 32];
    let l = parse_lock(&lock_bytes(sha(&pre), 1_000, now + 600), now).unwrap();
    let mut d = vec![0u8; ESCROW_LEN];
    write_escrow(&mut d, &[9u8; 32], &l, 254);
    let e = read_escrow(&d).unwrap();
    assert_eq!((e.offerer, e.claimer, e.amount, e.expiry), ([9u8; 32], [7u8; 32], 1_000, now + 600));

    // claim: right preimage, strictly before expiry
    assert_eq!(check_claim(&e, &pre, now), Ok(()));
    assert_eq!(check_claim(&e, &pre, now + 599), Ok(()));
    assert_eq!(check_claim(&e, &pre, now + 600), Err(HtlcError::Expired));
    assert_eq!(check_claim(&e, &[0x43u8; 32], now), Err(HtlcError::WrongPreimage));
    assert_eq!(check_claim(&e, &pre[..31], now), Err(HtlcError::BadInstruction));
    // the hash itself is not a preimage
    assert_eq!(check_claim(&e, &e.hash, now), Err(HtlcError::WrongPreimage));

    // refund: from expiry on; the two windows never overlap
    assert_eq!(check_refund(&e, now + 599), Err(HtlcError::NotExpired));
    assert_eq!(check_refund(&e, now + 600), Ok(()));
    for t in [now, now + 599, now + 600, now + 10_000] {
        assert!(check_claim(&e, &pre, t).is_ok() != check_refund(&e, t).is_ok());
    }

    // closed (zeroed) escrow is not an escrow
    d.fill(0);
    assert_eq!(read_escrow(&d), Err(HtlcError::BadEscrow));
}

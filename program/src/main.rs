//! SP1 guest for the CKB→Solana bridge spike. One program (one vkey), two proof kinds,
//! distinguished by the first committed byte:
//!
//!   mode 0/1 → kind 1 SEGMENT: verify a contiguous run of CKB headers continuing a parent header
//!              (Eaglesong PoW, linkage, epoch + difficulty transition rules, total difficulty).
//!              Input: u8 mode, u8 pow_id, Vec<u8> parent (208 bytes), Vec<u8> headers (n * 208).
//!              The parent is bound by hash: first_parent_hash in the summary = ckbhash(parent).
//!              Commits kind(1) ‖ pow_id(1) ‖ SegmentSummary(112) = 114 bytes.
//!              mode 1 adds a per-component cycle breakdown.
//!   mode 2   → kind 2 DEPOSIT: output `i` of a tx is in block B, B..=T hash-linked.
//!              Input: u8 mode, Vec<u8> headers B..=T, Vec<u8> raw_tx, u32 out_index,
//!              u32 tree_index, Vec<[u8;32]> lemmas, [u8;32] witnesses_root.
//!              Commits a 194-byte DepositEvent (see ckb_pow::deposit).
//!   mode ≥10 → micro-benchmarks, commit nothing.
#![no_main]
sp1_zkvm::entrypoint!(main);

use ckb_pow::{
    ckbhash, deposit, eaglesong, eaglesong_pow48, pow_message, verify_segment_from, HeaderView, PowFunc, HEADER_LEN,
    RAW_HEADER_LEN,
};

/// Fixed PoW message from the raw chunk without hashing (pow_hash slot = header bytes 0..32).
fn pow_message_raw(chunk: &[u8]) -> [u8; 48] {
    let mut m = [0u8; 48];
    m[..32].copy_from_slice(&chunk[..32]);
    m[32..].copy_from_slice(&chunk[192..208]);
    m
}

pub fn main() {
    let mode = sp1_zkvm::io::read::<u8>();
    if mode == 2 {
        let headers = sp1_zkvm::io::read_vec();
        let raw_tx = sp1_zkvm::io::read_vec();
        let out_index = sp1_zkvm::io::read::<u32>();
        let tree_index = sp1_zkvm::io::read::<u32>();
        let lemmas = sp1_zkvm::io::read::<Vec<[u8; 32]>>();
        let witnesses_root = sp1_zkvm::io::read::<[u8; 32]>();
        let e = deposit::verify_deposit(&headers, &raw_tx, out_index, tree_index, &lemmas, witnesses_root)
            .expect("invalid deposit");
        sp1_zkvm::io::commit_slice(&e.to_bytes());
        return;
    }
    let pow_id = sp1_zkvm::io::read::<u8>();
    let pow = PowFunc::from_id(pow_id).expect("unknown pow id");
    let parent: Option<[u8; HEADER_LEN]> =
        if mode < 10 { Some(sp1_zkvm::io::read_vec().try_into().expect("parent header")) } else { None };
    let bytes = sp1_zkvm::io::read_vec();

    // Differential micro-benchmarks: run exactly one component per header, commit nothing.
    // cycles(component) ≈ (cycles(mode) - cycles(mode 10)) / n
    if mode >= 10 {
        let mut acc = [0u8; 32];
        for chunk in bytes.chunks_exact(HEADER_LEN) {
            let h = HeaderView(chunk.try_into().unwrap());
            let r: [u8; 32] = match mode {
                10 => [chunk[0]; 32],                                // baseline: loop + read
                11 => ckbhash(&h.0[..RAW_HEADER_LEN]),               // pow_hash
                12 => eaglesong(&pow_message_raw(chunk)),            // reference sponge
                13 => eaglesong_pow48(&pow_message_raw(chunk)),      // fast path
                14 => h.hash(),                                      // block hash
                15 => {
                    let (t, _) = ckb_pow::compact_to_target(h.compact_target());
                    ckb_pow::target_to_difficulty(t).to_le_bytes::<32>()
                }
                _ => panic!("unknown mode"),
            };
            acc[0] ^= r[0];
        }
        core::hint::black_box(acc);
        return;
    }

    if mode == 1 {
        for chunk in bytes.chunks_exact(HEADER_LEN) {
            let h = HeaderView(chunk.try_into().unwrap());
            println!("cycle-tracker-report-start: pow_hash(blake2b 192B)");
            let ph = ckbhash(&h.0[..RAW_HEADER_LEN]);
            println!("cycle-tracker-report-end: pow_hash(blake2b 192B)");
            let mut msg = pow_message(h);
            msg[..32].copy_from_slice(&ph);
            println!("cycle-tracker-report-start: eaglesong_reference(48B)");
            let e = eaglesong(&msg);
            println!("cycle-tracker-report-end: eaglesong_reference(48B)");
            println!("cycle-tracker-report-start: eaglesong_pow48(48B)");
            let e2 = eaglesong_pow48(&msg);
            println!("cycle-tracker-report-end: eaglesong_pow48(48B)");
            assert_eq!(e, e2);
            println!("cycle-tracker-report-start: block_hash(blake2b 208B)");
            let bh = h.hash();
            println!("cycle-tracker-report-end: block_hash(blake2b 208B)");
            core::hint::black_box((e, bh));
        }
    }

    println!("cycle-tracker-report-start: verify_segment");
    let s = verify_segment_from(&parent.unwrap(), &bytes, pow).expect("invalid header segment");
    println!("cycle-tracker-report-end: verify_segment");
    sp1_zkvm::io::commit_slice(&deposit::segment_public_values(pow_id, &s.to_bytes()));
}

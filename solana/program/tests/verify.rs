//! Host-side tests of the Solana verifier logic (solana-bn254 / sha256 fall back to native
//! implementations off-chain).
//! - v1 fixture: real Groth16 proof of 16 CKB mainnet headers from the first guest (its own vkey).
//! - bridge v3 fixtures (if present): segment + deposit proofs from the current guest (vk::PROGRAM_VKEY).
//! - bridge v2 fixtures: proofs from the previous guest (no epoch/difficulty rules) must not verify.
use ckb_light_client::{groth16::*, parse_deposit, parse_segment, vk};

const V1: &str = include_str!("../../../fixtures/proofs/groth16-mainnet-n16.json");

fn load(s: &str) -> (Vec<u8>, Vec<u8>, [u8; 32]) {
    let v: serde_json::Value = serde_json::from_str(s).unwrap();
    let h = |k: &str| hex::decode(v[k].as_str().unwrap().trim_start_matches("0x")).unwrap();
    (h("proof"), h("public_values"), h("vkey").try_into().unwrap())
}

#[test]
fn genuine_proof_verifies() {
    let (proof, pv, vkey) = load(V1);
    assert_eq!(proof.len(), PROOF_LEN);
    verify_sp1_groth16(&proof, &pv, &vkey).expect("valid proof");
}

#[test]
fn tampered_public_values_rejected() {
    let (proof, mut pv, vkey) = load(V1);
    pv[50] ^= 1;
    assert_eq!(verify_sp1_groth16(&proof, &pv, &vkey), Err(VerifyError::PairingFailed));
}

#[test]
fn tampered_proof_rejected() {
    let (mut proof, pv, vkey) = load(V1);
    proof[200] ^= 1;
    assert!(verify_sp1_groth16(&proof, &pv, &vkey).is_err());
    let (mut proof, pv, vkey) = load(V1);
    proof[0] ^= 1;
    assert_eq!(verify_sp1_groth16(&proof, &pv, &vkey), Err(VerifyError::WrongVerifierSelector));
}

#[test]
fn wrong_vkey_rejected() {
    let (proof, pv, mut vkey) = load(V1);
    vkey[31] ^= 1;
    assert!(verify_sp1_groth16(&proof, &pv, &vkey).is_err());
    // the v1 proof is not accepted under the bridge guest's vkey
    assert!(verify_sp1_groth16(&proof, &pv, &vk::PROGRAM_VKEY).is_err());
}

fn bridge_fixture(name: &str) -> Option<String> {
    std::fs::read_to_string(format!("{}/../../fixtures/proofs/{name}", env!("CARGO_MANIFEST_DIR"))).ok()
}

#[test]
fn bridge_segment_and_deposit_proofs() {
    let (Some(seg), Some(dep)) = (bridge_fixture("bridge-v3-segment.json"), bridge_fixture("bridge-v3-deposit.json")) else {
        eprintln!("bridge fixtures not generated yet; skipping");
        return;
    };
    let (proof, pv, vkey) = load(&seg);
    assert_eq!(vkey, vk::PROGRAM_VKEY);
    verify_sp1_groth16(&proof, &pv, &vk::PROGRAM_VKEY).unwrap();
    let s = parse_segment(&pv).unwrap();
    assert!(parse_deposit(&pv).is_err());
    let (proof2, pv2, _) = load(&dep);
    verify_sp1_groth16(&proof2, &pv2, &vk::PROGRAM_VKEY).unwrap();
    let d = parse_deposit(&pv2).unwrap();
    assert!(parse_segment(&pv2).is_err());
    assert_eq!(d.anchor_number, s.last_number);
    assert_eq!(d.anchor_hash, s.last_hash);
    assert_eq!(d.data_len, 32);
    // swapping proofs between the two statements fails
    assert!(verify_sp1_groth16(&proof, &pv2, &vk::PROGRAM_VKEY).is_err());
}

#[test]
fn v2_guest_proofs_rejected() {
    // The v2 guest accepted any compact_target; its proofs must not pass under the v3 vkey.
    let Some(seg) = bridge_fixture("bridge-v2-segment.json") else { return };
    let (proof, pv, vkey) = load(&seg);
    assert_ne!(vkey, vk::PROGRAM_VKEY);
    verify_sp1_groth16(&proof, &pv, &vkey).expect("valid under its own vkey");
    assert!(verify_sp1_groth16(&proof, &pv, &vk::PROGRAM_VKEY).is_err());
}

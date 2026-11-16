//! SP1 v6 Groth16 verifier for Solana, a port of Succinct's `SP1VerifierGroth16.sol` +
//! gnark `Groth16Verifier.sol` (v6.1.0) onto the alt_bn128 syscalls (EIP-197 big-endian encoding).
//!
//! Proof bytes (356) = selector(4) ‖ exitCode(32) ‖ vkRoot(32) ‖ nonce(32) ‖ A(64) ‖ B(128) ‖ C(64)
//! Public inputs (5) = [programVKey, sha256(publicValues) & (2^253-1), exitCode, vkRoot, nonce]
use solana_bn254::prelude::{
    alt_bn128_g1_addition_be as alt_bn128_addition, alt_bn128_g1_multiplication_be as alt_bn128_multiplication,
    alt_bn128_pairing_be as alt_bn128_pairing,
};
use solana_sha256_hasher::hashv;

use crate::vk::*;

pub const PROOF_LEN: usize = 4 + 32 * 3 + 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyError {
    BadProofLength,
    WrongVerifierSelector,
    NonZeroExitCode,
    WrongVkRoot,
    InputNotInField,
    Bn254Syscall,
    PairingFailed,
}

/// `sha256(public_values)` with the top 3 bits cleared (fits the BN254 scalar field).
pub fn hash_public_values(public_values: &[u8]) -> [u8; 32] {
    let mut d = hashv(&[public_values]).to_bytes();
    d[0] &= 0x1f;
    d
}

fn lt_be(a: &[u8; 32], b: &[u8; 32]) -> bool {
    a < b // lexicographic == numeric for equal-length big-endian
}

pub fn verify_sp1_groth16(
    proof: &[u8],
    public_values: &[u8],
    program_vkey: &[u8; 32],
) -> Result<(), VerifyError> {
    if proof.len() != PROOF_LEN {
        return Err(VerifyError::BadProofLength);
    }
    if proof[..4] != VERIFIER_HASH[..4] {
        return Err(VerifyError::WrongVerifierSelector);
    }
    let word = |i: usize| -> [u8; 32] { proof[4 + 32 * i..4 + 32 * (i + 1)].try_into().unwrap() };
    let (exit_code, vk_root, nonce) = (word(0), word(1), word(2));
    if exit_code != [0u8; 32] {
        return Err(VerifyError::NonZeroExitCode);
    }
    if vk_root != VK_ROOT {
        return Err(VerifyError::WrongVkRoot);
    }
    let abc = &proof[100..356];

    let inputs: [[u8; 32]; NUM_PUBLIC_INPUTS] =
        [*program_vkey, hash_public_values(public_values), exit_code, vk_root, nonce];

    // L_pub = CONSTANT + Σ input_i · PUB_i
    let mut acc = [0u8; 64];
    acc[..32].copy_from_slice(&CONSTANT_X);
    acc[32..].copy_from_slice(&CONSTANT_Y);
    for (i, s) in inputs.iter().enumerate() {
        if !lt_be(s, &R) {
            return Err(VerifyError::InputNotInField);
        }
        let mut mul_in = [0u8; 96];
        mul_in[..32].copy_from_slice(&PUB[i].0);
        mul_in[32..64].copy_from_slice(&PUB[i].1);
        mul_in[64..].copy_from_slice(s);
        let m = alt_bn128_multiplication(&mul_in).map_err(|_| VerifyError::Bn254Syscall)?;
        let mut add_in = [0u8; 128];
        add_in[..64].copy_from_slice(&acc);
        add_in[64..].copy_from_slice(&m);
        let a = alt_bn128_addition(&add_in).map_err(|_| VerifyError::Bn254Syscall)?;
        acc.copy_from_slice(&a);
    }

    // e(A,B) · e(C,-δ) · e(α,-β) · e(L_pub,-γ) == 1   (same layout as the Solidity verifier)
    let mut p = [0u8; 768];
    p[..256].copy_from_slice(abc);
    let put = |p: &mut [u8; 768], off: usize, v: &[u8; 32]| p[off..off + 32].copy_from_slice(v);
    put(&mut p, 0x100, &DELTA_NEG_X_1);
    put(&mut p, 0x120, &DELTA_NEG_X_0);
    put(&mut p, 0x140, &DELTA_NEG_Y_1);
    put(&mut p, 0x160, &DELTA_NEG_Y_0);
    put(&mut p, 0x180, &ALPHA_X);
    put(&mut p, 0x1a0, &ALPHA_Y);
    put(&mut p, 0x1c0, &BETA_NEG_X_1);
    put(&mut p, 0x1e0, &BETA_NEG_X_0);
    put(&mut p, 0x200, &BETA_NEG_Y_1);
    put(&mut p, 0x220, &BETA_NEG_Y_0);
    p[0x240..0x280].copy_from_slice(&acc);
    put(&mut p, 0x280, &GAMMA_NEG_X_1);
    put(&mut p, 0x2a0, &GAMMA_NEG_X_0);
    put(&mut p, 0x2c0, &GAMMA_NEG_Y_1);
    put(&mut p, 0x2e0, &GAMMA_NEG_Y_0);

    let out = alt_bn128_pairing(&p).map_err(|_| VerifyError::Bn254Syscall)?;
    let mut one = [0u8; 32];
    one[31] = 1;
    if out.as_slice() != one {
        return Err(VerifyError::PairingFailed);
    }
    Ok(())
}

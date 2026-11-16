//! Key-share swap lock ("share-lock") - spike.
//!
//! Funds on a foreign chain sit at a plain address whose private key is `a + b` (taker share `a`,
//! maker share `b`). This lock is the only contract in the swap: whoever takes the CKB must publish
//! their share in the witness, which hands the counterparty the full foreign key.
//!
//! ```text
//! args    = ckbhash(params)[0..20]
//! params  = curve(1: 0 = Ed25519, 1 = secp256k1)
//!           | maker_share_pub B | taker_share_pub A      (32-byte compressed Edwards / 33-byte SEC1)
//!           | release_hash(32) = sha256(release secret r, 32 bytes, chosen by the taker)
//!           | maker_lock_hash(32) | taker_lock_hash(32)
//!           | t1(8 LE, a `since`) | t2(8 LE, a `since`)
//! witness = WitnessArgs.lock of the first input in the group: tag(1) | params | path data
//!   tag 1 CLAIM  (maker): b(32) | r(32)  sha256(r) == release_hash, b*G == B, outputs -> maker
//!   tag 2 REFUND (taker): a(32)          since >= t1,               a*G == A, outputs -> taker
//!   tag 3 PUNISH (maker): (nothing)      since >= t2,                         outputs -> maker
//! ```
//!
//! Scalars are raw group scalars (Ed25519: little-endian, no seed/clamp/hash; secp256k1:
//! big-endian), must be non-zero and canonical (< group order). `since >= t` means: same flag byte
//! (relative/absolute + metric) as `t`, value not smaller; it is checked on every group input.
//! "outputs -> X" means: the transaction has at least one output, every output has lock hash X, and
//! (sum of output capacities) + FEE_CAP >= (sum of all input capacities), FEE_CAP = 100,000 shannons.
#![no_std]
#![no_main]

use ckb_std::{ckb_constants::{CellField, InputField, Source}, error::SysError, syscalls};
use sha2::{Digest, Sha256};

ckb_std::entry!(program_entry);
ckb_std::default_alloc!();

const TAG_CLAIM: u8 = 1;
const TAG_REFUND: u8 = 2;
const TAG_PUNISH: u8 = 3;

#[repr(i8)]
enum Error {
    Syscall = 1,
    BadArgs = 2,            // args are not exactly 20 bytes
    BadWitness = 3,         // not a WitnessArgs whose lock field holds tag | params | path data
    BadTag = 4,
    ParamsMismatch = 5,     // ckbhash(params)[0..20] != args
    BadCurve = 6,           // unknown curve id (or curve not compiled into this build)
    BadParamsLength = 7,
    WrongReleaseSecret = 8,
    ScalarZero = 9,
    ScalarNonCanonical = 10,
    ScalarMismatch = 11,    // scalar*G != committed share public key
    WrongOutputLock = 12,
    SinceTypeMismatch = 13, // input since flags differ from the flags of the timeout
    RefundTooEarly = 14,
    PunishTooEarly = 15,
    NoOutputs = 16,         // a spend must create at least one output
    FeeTooHigh = 17,        // outputs + FEE_CAP < inputs (capacity of the whole transaction)
}

/// Most capacity (shannons) a spend may leave to the miner: 0.001 CKB. The witness of a broadcast
/// spend is public, so without this anyone could rebuild it with the cell's value turned into fee.
const FEE_CAP: u64 = 100_000;

impl From<SysError> for Error {
    fn from(_: SysError) -> Self { Error::Syscall }
}

fn load_vec(f: impl Fn(&mut [u8], usize) -> Result<usize, SysError>) -> Result<alloc::vec::Vec<u8>, SysError> {
    let mut small = [0u8; 384];
    match f(&mut small, 0) {
        Ok(n) => Ok(small[..n].to_vec()),
        Err(SysError::LengthNotEnough(n)) => {
            let mut v = alloc::vec![0u8; n];
            f(&mut v, 0)?;
            Ok(v)
        }
        Err(e) => Err(e),
    }
}

/// Field `i` of a molecule table (no field-count check beyond bounds).
fn table_field(b: &[u8], i: usize) -> Option<&[u8]> {
    let rd = |o: usize| b.get(o..o + 4).map(|x| u32::from_le_bytes(x.try_into().unwrap()) as usize);
    let total = rd(0)?;
    if total != b.len() || total < 8 {
        return None;
    }
    let first = rd(4)?;
    if first % 4 != 0 || first < 8 || first > total {
        return None;
    }
    let count = first / 4 - 1;
    if i >= count {
        return None;
    }
    let start = rd(4 + 4 * i)?;
    let end = if i + 1 == count { total } else { rd(8 + 4 * i)? };
    if start > end || end > total {
        return None;
    }
    Some(&b[start..end])
}

/// Payload of a molecule `Bytes` (fixvec of bytes), with its length prefix checked.
fn bytes_payload(b: &[u8]) -> Option<&[u8]> {
    let n = u32::from_le_bytes(b.get(..4)?.try_into().unwrap()) as usize;
    let p = &b[4..];
    (p.len() == n).then_some(p)
}

#[cfg(feature = "ed25519")]
fn check_ed25519(scalar: &[u8; 32], share_pub: &[u8]) -> Result<(), Error> {
    use curve25519_dalek::{edwards::EdwardsPoint, scalar::Scalar};
    let s = Option::<Scalar>::from(Scalar::from_canonical_bytes(*scalar)).ok_or(Error::ScalarNonCanonical)?;
    if s == Scalar::ZERO {
        return Err(Error::ScalarZero);
    }
    #[cfg(not(feature = "ed-vartime"))]
    let p = EdwardsPoint::mul_base(&s);
    #[cfg(feature = "ed-vartime")]
    let p = {
        use curve25519_dalek::traits::Identity;
        EdwardsPoint::vartime_double_scalar_mul_basepoint(&Scalar::ZERO, &EdwardsPoint::identity(), &s)
    };
    if p.compress().as_bytes()[..] != *share_pub {
        return Err(Error::ScalarMismatch);
    }
    Ok(())
}

#[cfg(feature = "secp256k1")]
fn check_secp256k1(scalar: &[u8; 32], share_pub: &[u8]) -> Result<(), Error> {
    use k256::{
        elliptic_curve::{ff::PrimeField, sec1::ToEncodedPoint},
        ProjectivePoint, Scalar,
    };
    let s = Option::<Scalar>::from(Scalar::from_repr((*scalar).into())).ok_or(Error::ScalarNonCanonical)?;
    if bool::from(s.is_zero()) {
        return Err(Error::ScalarZero);
    }
    let p = (ProjectivePoint::GENERATOR * s).to_affine().to_encoded_point(true);
    if p.as_bytes() != share_pub {
        return Err(Error::ScalarMismatch);
    }
    Ok(())
}

/// `scalar*G == share_pub` on the chosen curve; scalar non-zero and canonical.
fn check_share(curve: u8, scalar: &[u8], share_pub: &[u8]) -> Result<(), Error> {
    let scalar: &[u8; 32] = scalar.try_into().map_err(|_| Error::BadWitness)?;
    match curve {
        #[cfg(feature = "ed25519")]
        0 => check_ed25519(scalar, share_pub),
        #[cfg(feature = "secp256k1")]
        1 => check_secp256k1(scalar, share_pub),
        _ => Err(Error::BadCurve),
    }
}

/// Is input since `s` at or past timeout `t`? Both must carry the same flag byte.
fn since_reached(s: u64, t: u64) -> Result<bool, Error> {
    if s >> 56 != t >> 56 {
        return Err(Error::SinceTypeMismatch);
    }
    const VALUE: u64 = (1 << 56) - 1;
    let metric = (t >> 61) & 3;
    let (s, t) = (s & VALUE, t & VALUE);
    if metric != 1 {
        return Ok(s >= t); // block number or timestamp
    }
    // epoch metric: value = length(16) | index(16) | number(24), meaning number + index/length
    let parts = |v: u64| {
        let (n, i, l) = (v & 0xff_ffff, (v >> 24) & 0xffff, (v >> 40) & 0xffff);
        if l == 0 { (n, 0, 1) } else { (n, i, l) }
    };
    let ((sn, si, sl), (tn, ti, tl)) = (parts(s), parts(t));
    Ok(sn > tn || (sn == tn && si * tl >= ti * sl))
}

/// Every group input's since must have reached `t`.
fn inputs_reached(t: u64) -> Result<bool, Error> {
    let mut i = 0;
    loop {
        let mut b = [0u8; 8];
        match syscalls::load_input_by_field(&mut b, 0, i, Source::GroupInput, InputField::Since) {
            Ok(_) => {}
            Err(SysError::IndexOutOfBound) => return Ok(true),
            Err(e) => return Err(e.into()),
        }
        if !since_reached(u64::from_le_bytes(b), t)? {
            return Ok(false);
        }
        i += 1;
    }
}

/// Number of cells in `source` and the sum of their capacities.
fn capacity_sum(source: Source) -> Result<(usize, u128), Error> {
    let (mut n, mut sum) = (0, 0u128);
    loop {
        let mut b = [0u8; 8];
        match syscalls::load_cell_by_field(&mut b, 0, n, source, CellField::Capacity) {
            Ok(_) => {}
            Err(SysError::IndexOutOfBound) => return Ok((n, sum)),
            Err(e) => return Err(e.into()),
        }
        sum += u64::from_le_bytes(b) as u128;
        n += 1;
    }
}

/// Every output of the transaction must be locked by `lock_hash`, there must be at least one, and
/// together they must hold all the capacity of the transaction's inputs except at most FEE_CAP.
fn outputs_locked_by(lock_hash: &[u8]) -> Result<(), Error> {
    let mut j = 0;
    loop {
        let mut h = [0u8; 32];
        match syscalls::load_cell_by_field(&mut h, 0, j, Source::Output, CellField::LockHash) {
            Ok(_) => {}
            Err(SysError::IndexOutOfBound) => break,
            Err(e) => return Err(e.into()),
        }
        if h[..] != *lock_hash {
            return Err(Error::WrongOutputLock);
        }
        j += 1;
    }
    let (n_out, out_sum) = capacity_sum(Source::Output)?;
    if n_out == 0 {
        return Err(Error::NoOutputs);
    }
    let (_, in_sum) = capacity_sum(Source::Input)?;
    if out_sum + FEE_CAP as u128 >= in_sum {
        Ok(())
    } else {
        Err(Error::FeeTooHigh)
    }
}

fn run() -> Result<(), Error> {
    // --- args
    let script = load_vec(|b, o| syscalls::load_script(b, o))?;
    let args = table_field(&script, 2).and_then(bytes_payload).ok_or(Error::BadArgs)?;
    if args.len() != 20 {
        return Err(Error::BadArgs);
    }

    // --- witness: tag | params | path data. The path fixes the tail length, so params are
    //     delimited (and authenticated against args) before any of their fields are interpreted.
    let wit = load_vec(|b, o| syscalls::load_witness(b, o, 0, Source::GroupInput))?;
    let w = table_field(&wit, 0).and_then(bytes_payload).ok_or(Error::BadWitness)?;
    let (&tag, rest) = w.split_first().ok_or(Error::BadWitness)?;
    let tail_len = match tag {
        TAG_CLAIM => 64,
        TAG_REFUND => 32,
        TAG_PUNISH => 0,
        _ => return Err(Error::BadTag),
    };
    if rest.len() < tail_len {
        return Err(Error::BadWitness);
    }
    let (params, tail) = rest.split_at(rest.len() - tail_len);

    let mut hasher = blake2b_ref::Blake2bBuilder::new(32).personal(b"ckb-default-hash").build();
    hasher.update(params);
    let mut digest = [0u8; 32];
    hasher.finalize(&mut digest);
    if digest[..20] != *args {
        return Err(Error::ParamsMismatch);
    }

    // --- params
    let (&curve, p) = params.split_first().ok_or(Error::BadParamsLength)?;
    let pk_len = match curve {
        0 => 32,
        1 => 33,
        _ => return Err(Error::BadCurve),
    };
    if p.len() != 2 * pk_len + 32 * 3 + 16 {
        return Err(Error::BadParamsLength);
    }
    let (maker_pub, p) = p.split_at(pk_len);
    let (taker_pub, p) = p.split_at(pk_len);
    let (release_hash, p) = p.split_at(32);
    let (maker_lock, p) = p.split_at(32);
    let (taker_lock, p) = p.split_at(32);
    let t1 = u64::from_le_bytes(p[..8].try_into().unwrap());
    let t2 = u64::from_le_bytes(p[8..].try_into().unwrap());

    match tag {
        TAG_CLAIM => {
            let (b, r) = tail.split_at(32);
            if Sha256::digest(r)[..] != *release_hash {
                return Err(Error::WrongReleaseSecret);
            }
            check_share(curve, b, maker_pub)?;
            outputs_locked_by(maker_lock)
        }
        TAG_REFUND => {
            if !inputs_reached(t1)? {
                return Err(Error::RefundTooEarly);
            }
            check_share(curve, tail, taker_pub)?;
            outputs_locked_by(taker_lock)
        }
        _ => {
            if !inputs_reached(t2)? {
                return Err(Error::PunishTooEarly);
            }
            outputs_locked_by(maker_lock)
        }
    }
}

fn program_entry() -> i8 {
    match run() {
        Ok(()) => 0,
        Err(e) => e as i8,
    }
}

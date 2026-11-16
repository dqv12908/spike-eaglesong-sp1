//! Minimal `no_std` CKB header verification for the Eaglesong-in-zkVM spike.
//!
//! Scope (what a CKB light client needs per header, minus FlyClient/MMR):
//! - molecule layout of `RawHeader` (192 B) / `Header` (208 B)
//! - `ckbhash` = BLAKE2b-256, personalization `ckb-default-hash`
//! - PoW: `ckbhash(eaglesong(pow_hash || nonce_le)) <= compact_to_target(compact_target)`
//! - chain linkage (parent hash, height) and cumulative difficulty
#![no_std]

mod const_vars;
pub mod deposit;
#[allow(clippy::all)]
mod eaglesong;
#[cfg(feature = "rpc")]
pub mod rpc;

use ruint::aliases::U256;

pub const RAW_HEADER_LEN: usize = 192;
pub const HEADER_LEN: usize = 208;

pub type Byte32 = [u8; 32];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    BadLength,
    TargetOverflowOrZero,
    PowAboveTarget { number: u64 },
    ParentMismatch { number: u64 },
    HeightGap { number: u64 },
    /// Epoch fields inconsistent with the parent (number / index / length rules).
    BadEpoch { number: u64 },
    /// `compact_target` changed inside an epoch, or by more than the bound at an epoch start.
    BadDifficulty { number: u64 },
}

/// Eaglesong over arbitrary input (reference sponge), 32-byte output.
pub fn eaglesong(input: &[u8]) -> Byte32 {
    let mut out = [0u8; 32];
    eaglesong::eaglesong_sponge(&mut out, 32, input, input.len());
    out
}

/// Eaglesong specialised for CKB's fixed 48-byte PoW message.
///
/// Equivalent to `eaglesong(input)` (tested), but:
/// - absorbs whole big-endian words instead of byte-by-byte with branches;
/// - the 49th byte (delimiter 0x06) lands alone in word 4 of block 1 as `0x00000006`
///   (the reference sponge does not shift after the delimiter);
/// - skips the reference's trailing permutation after squeezing, which never affects a
///   32-byte output. 2 permutations instead of 3.
pub fn eaglesong_pow48(input: &[u8; 48]) -> Byte32 {
    let w = |i: usize| u32::from_be_bytes(input[4 * i..4 * i + 4].try_into().unwrap());
    let mut s = [0u32; 16];
    for j in 0..8 {
        s[j] = w(j);
    }
    eaglesong::eaglesong_permutation(&mut s);
    for j in 0..4 {
        s[j] ^= w(8 + j);
    }
    s[4] ^= const_vars::DELIMITER;
    eaglesong::eaglesong_permutation(&mut s);
    let mut out = [0u8; 32];
    for j in 0..8 {
        out[4 * j..4 * j + 4].copy_from_slice(&s[j].to_le_bytes());
    }
    out
}

/// CKB's default hash: BLAKE2b-256 personalised with `ckb-default-hash`.
pub fn ckbhash(data: &[u8]) -> Byte32 {
    let mut out = [0u8; 32];
    let mut h = blake2b_ref::Blake2bBuilder::new(32)
        .personal(b"ckb-default-hash")
        .build();
    h.update(data);
    h.finalize(&mut out);
    out
}

/// Typed view over a serialized 208-byte molecule `Header`.
#[derive(Clone, Copy)]
pub struct HeaderView<'a>(pub &'a [u8; HEADER_LEN]);

impl<'a> HeaderView<'a> {
    pub fn version(&self) -> u32 { u32::from_le_bytes(self.0[0..4].try_into().unwrap()) }
    pub fn compact_target(&self) -> u32 { u32::from_le_bytes(self.0[4..8].try_into().unwrap()) }
    pub fn timestamp(&self) -> u64 { u64::from_le_bytes(self.0[8..16].try_into().unwrap()) }
    pub fn number(&self) -> u64 { u64::from_le_bytes(self.0[16..24].try_into().unwrap()) }
    pub fn epoch(&self) -> u64 { u64::from_le_bytes(self.0[24..32].try_into().unwrap()) }
    pub fn parent_hash(&self) -> Byte32 { self.0[32..64].try_into().unwrap() }
    pub fn transactions_root(&self) -> Byte32 { self.0[64..96].try_into().unwrap() }
    pub fn proposals_hash(&self) -> Byte32 { self.0[96..128].try_into().unwrap() }
    pub fn extra_hash(&self) -> Byte32 { self.0[128..160].try_into().unwrap() }
    pub fn dao(&self) -> Byte32 { self.0[160..192].try_into().unwrap() }
    pub fn nonce(&self) -> u128 { u128::from_le_bytes(self.0[192..208].try_into().unwrap()) }

    /// `ckbhash(RawHeader)` — the message the miner grinds the nonce against.
    pub fn pow_hash(&self) -> Byte32 { ckbhash(&self.0[..RAW_HEADER_LEN]) }
    /// Block hash = `ckbhash(Header)`.
    pub fn hash(&self) -> Byte32 { ckbhash(&self.0[..]) }
}

/// CKB `compact_to_target`. Returns `(target, overflow)`.
pub fn compact_to_target(compact: u32) -> (U256, bool) {
    let exponent = compact >> 24;
    let mut mantissa = U256::from(compact & 0x00ff_ffff);
    let ret = if exponent <= 3 {
        mantissa >>= 8 * (3 - exponent) as usize;
        mantissa
    } else {
        mantissa << (8 * (exponent - 3) as usize)
    };
    let overflow = !mantissa.is_zero() && exponent > 32;
    (ret, overflow)
}

/// CKB `target_to_difficulty`: `(2^256 - target) / target + 1`, or MAX when target == 1.
pub fn target_to_difficulty(target: U256) -> U256 {
    if target == U256::from(1u8) {
        U256::MAX
    } else {
        // (2^256 - t) == (MAX - t + 1) in 256-bit arithmetic
        (U256::MAX - target + U256::from(1u8)) / target + U256::from(1u8)
    }
}

/// PoW function selected by the chain spec.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PowFunc {
    /// `eaglesong(pow_message)`
    Eaglesong,
    /// `ckbhash(eaglesong(pow_message))`
    EaglesongBlake2b,
}

/// The PoW function used by CKB mainnet (Lina). Confirmed empirically by `tests/mainnet.rs`.
pub const MAINNET_POW: PowFunc = PowFunc::Eaglesong;

impl PowFunc {
    /// Byte committed in segment public values: 0 = mainnet Eaglesong, 1 = testnet Eaglesong+BLAKE2b.
    pub fn id(self) -> u8 {
        match self {
            PowFunc::Eaglesong => 0,
            PowFunc::EaglesongBlake2b => 1,
        }
    }
    pub fn from_id(id: u8) -> Option<Self> {
        match id {
            0 => Some(PowFunc::Eaglesong),
            1 => Some(PowFunc::EaglesongBlake2b),
            _ => None,
        }
    }
}

/// `pow_hash || nonce_le` (48 bytes).
pub fn pow_message(h: HeaderView) -> [u8; 48] {
    let mut msg = [0u8; 48];
    msg[..32].copy_from_slice(&h.pow_hash());
    msg[32..].copy_from_slice(&h.0[192..208]); // nonce, little-endian u128
    msg
}

/// The 32-byte PoW output compared (big-endian) against the target.
pub fn pow_output(h: HeaderView, f: PowFunc) -> Byte32 {
    let e = eaglesong_pow48(&pow_message(h));
    match f {
        PowFunc::Eaglesong => e,
        PowFunc::EaglesongBlake2b => ckbhash(&e),
    }
}

/// Verify mainnet Eaglesong PoW for one header. Returns the block's difficulty on success.
pub fn verify_pow(h: HeaderView) -> Result<U256, Error> {
    verify_pow_with(h, MAINNET_POW)
}

pub fn verify_pow_with(h: HeaderView, f: PowFunc) -> Result<U256, Error> {
    let (target, overflow) = compact_to_target(h.compact_target());
    if target.is_zero() || overflow {
        return Err(Error::TargetOverflowOrZero);
    }
    let out = pow_output(h, f);
    if U256::from_be_bytes(out) > target {
        return Err(Error::PowAboveTarget { number: h.number() });
    }
    Ok(target_to_difficulty(target))
}

/// CKB `EpochNumberWithFraction`: number (24 bits) | index (16) | length (16).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Epoch {
    pub number: u64,
    pub index: u64,
    pub length: u64,
}

impl Epoch {
    pub fn from_u64(e: u64) -> Self {
        Epoch { number: e & 0xff_ffff, index: (e >> 24) & 0xffff, length: (e >> 40) & 0xffff }
    }
}

/// CKB consensus bounds on epoch length (`spec/src/consensus.rs`: 4 h / 48 s and 4 h / 8 s).
pub const MIN_EPOCH_LENGTH: u64 = 300;
pub const MAX_EPOCH_LENGTH: u64 = 1800;
/// Max factor `compact_target` may move by at an epoch start, either direction.
///
/// CKB clamps the epoch hash-rate estimate to x/÷2 of the previous one (TAU = 2) and the epoch
/// length to x/÷2. With orphan-rate terms in [1, 2] that bounds a normal adjustment to x/÷8.
/// Observed: <= 2.12x on testnet and <= 1.64x on mainnet over the last 60 epochs (2026-11).
/// Uncle counts are not in headers, so the exact CKB formula cannot be replayed from headers.
pub const MAX_EPOCH_TARGET_FACTOR: u64 = 8;

/// Consensus rules a header must satisfy relative to its parent, checkable from headers alone:
/// - same epoch: same epoch number and length, index + 1, identical `compact_target`;
/// - epoch start (parent was the last block of its epoch): number + 1, index 0, length within
///   `[max(300, L/2), min(1800, 2L)]`, target within x/÷`MAX_EPOCH_TARGET_FACTOR` (+ 1/1024
///   slack for compact-encoding rounding).
pub fn check_transition(parent: HeaderView, h: HeaderView) -> Result<(), Error> {
    let number = h.number();
    let (pe, e) = (Epoch::from_u64(parent.epoch()), Epoch::from_u64(h.epoch()));
    if e.length == 0 || e.index >= e.length || pe.length == 0 || pe.index >= pe.length {
        return Err(Error::BadEpoch { number });
    }
    if pe.index + 1 < pe.length {
        if e.number != pe.number || e.length != pe.length || e.index != pe.index + 1 {
            return Err(Error::BadEpoch { number });
        }
        if h.compact_target() != parent.compact_target() {
            return Err(Error::BadDifficulty { number });
        }
        return Ok(());
    }
    let lo = core::cmp::max(MIN_EPOCH_LENGTH, pe.length / 2);
    let hi = core::cmp::min(MAX_EPOCH_LENGTH, pe.length * 2);
    if e.number != pe.number + 1 || e.index != 0 || e.length < lo || e.length > hi {
        return Err(Error::BadEpoch { number });
    }
    let (tp, o1) = compact_to_target(parent.compact_target());
    let (t, o2) = compact_to_target(h.compact_target());
    if o1 || o2 || tp.is_zero() || t.is_zero() {
        return Err(Error::TargetOverflowOrZero);
    }
    let k = U256::from(MAX_EPOCH_TARGET_FACTOR);
    let slack = tp >> 10;
    let easier_ok = t <= tp.saturating_mul(k).saturating_add(slack);
    let harder_ok = t.saturating_mul(k).saturating_add(slack) >= tp;
    if !(easier_ok && harder_ok) {
        return Err(Error::BadDifficulty { number });
    }
    Ok(())
}

/// Summary of a verified contiguous header segment — what a zk proof would commit to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SegmentSummary {
    pub first_number: u64,
    pub last_number: u64,
    pub first_parent_hash: Byte32,
    pub last_hash: Byte32,
    pub total_difficulty: U256,
}

impl SegmentSummary {
    /// Fixed 8+8+32+32+32 = 112-byte encoding (difficulty little-endian).
    pub fn to_bytes(&self) -> [u8; 112] {
        let mut b = [0u8; 112];
        b[0..8].copy_from_slice(&self.first_number.to_le_bytes());
        b[8..16].copy_from_slice(&self.last_number.to_le_bytes());
        b[16..48].copy_from_slice(&self.first_parent_hash);
        b[48..80].copy_from_slice(&self.last_hash);
        b[80..112].copy_from_slice(&self.total_difficulty.to_le_bytes::<32>());
        b
    }
}

/// Verify a contiguous run of serialized headers (`n * 208` bytes):
/// PoW of every header, parent-hash linkage and consecutive heights.
pub fn verify_segment(bytes: &[u8]) -> Result<SegmentSummary, Error> {
    verify_segment_with(bytes, MAINNET_POW)
}

pub fn verify_segment_with(bytes: &[u8], pow: PowFunc) -> Result<SegmentSummary, Error> {
    if bytes.is_empty() || bytes.len() % HEADER_LEN != 0 {
        return Err(Error::BadLength);
    }
    let mut total = U256::ZERO;
    let mut prev: Option<(u64, Byte32)> = None;
    let mut first: Option<(u64, Byte32)> = None;
    for chunk in bytes.chunks_exact(HEADER_LEN) {
        let h = HeaderView(chunk.try_into().unwrap());
        let number = h.number();
        if let Some((pn, ph)) = prev {
            if number != pn + 1 {
                return Err(Error::HeightGap { number });
            }
            if h.parent_hash() != ph {
                return Err(Error::ParentMismatch { number });
            }
        } else {
            first = Some((number, h.parent_hash()));
        }
        total += verify_pow_with(h, pow)?;
        prev = Some((number, h.hash()));
    }
    let (first_number, first_parent_hash) = first.unwrap();
    let (last_number, last_hash) = prev.unwrap();
    Ok(SegmentSummary { first_number, last_number, first_parent_hash, last_hash, total_difficulty: total })
}

/// Verify a segment that continues a known `parent` header (the light client's current tip):
/// `ckbhash(parent) == first.parent_hash`, consecutive heights, and the epoch / difficulty
/// transition rules for every pair (parent -> first, ...), plus PoW of every header.
///
/// Without these rules a prover could extend the tip with headers whose `compact_target`
/// it chose itself (trivially easy PoW). With them, difficulty is pinned to the parent's for
/// the rest of the epoch and can only move by a bounded factor at each epoch start.
pub fn verify_segment_from(parent: &[u8; HEADER_LEN], bytes: &[u8], pow: PowFunc) -> Result<SegmentSummary, Error> {
    if bytes.is_empty() || bytes.len() % HEADER_LEN != 0 {
        return Err(Error::BadLength);
    }
    let mut prev = HeaderView(parent);
    let first = HeaderView(bytes[..HEADER_LEN].try_into().unwrap());
    if first.parent_hash() != prev.hash() {
        return Err(Error::ParentMismatch { number: first.number() });
    }
    if first.number() != prev.number() + 1 {
        return Err(Error::HeightGap { number: first.number() });
    }
    for chunk in bytes.chunks_exact(HEADER_LEN) {
        let h = HeaderView(chunk.try_into().unwrap());
        check_transition(prev, h)?;
        prev = h;
    }
    verify_segment_with(bytes, pow)
}

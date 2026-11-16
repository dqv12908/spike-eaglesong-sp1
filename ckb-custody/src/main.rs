//! CKB → Solana bridge custody lock (spike).
//!
//! Every CKB deposit for the bridge is a cell under this lock. One special cell, the **vault**,
//! also carries this lock plus a Type ID type script (so it is unique) and a burn counter. CKB
//! leaves custody only through the vault, one Solana burn at a time, in order:
//!
//! ```text
//! args    = vault_type_hash(32) ‖ bridge_id(32) ‖ m(1) ‖ n(1) ‖ n × ed25519 attester pubkey(32)
//! vault   = lock: this script, type: Type ID (hash = vault_type_hash), data: "CKBSOLV1" ‖ next_seq u64 LE
//! witness = WitnessArgs.lock of the group's first input:
//!           seq u64 ‖ amount u64 ‖ recipient_lock_hash(32) ‖ k(1) ‖ k × (attester_index u8 ‖ ed25519 sig(64))
//! message = ckbhash("CKB-SOL-UNLOCK-V1" ‖ bridge_id ‖ vault_type_hash ‖ seq LE ‖ amount LE ‖ recipient_lock_hash)
//! ```
//!
//! Rules (all enforced here; the attesters only vouch that Solana burn #seq happened):
//! 1. exactly one group input is the vault; other group inputs carry no type script;
//! 2. `seq` equals the vault's counter; ≥ m distinct attesters signed the message;
//! 3. the only output under this lock is the new vault (same type, counter + 1), so change can
//!    never be re-proven on Solana as a fresh deposit;
//! 4. CKB leaving custody (group input capacity − new vault capacity) equals `amount`, and outputs
//!    locked by `recipient_lock_hash` receive at least `amount`. If the recipient is this lock
//!    itself, nothing leaves (a burn back to custody is a donation and cannot stall the counter).
#![no_std]
#![no_main]

use ckb_std::{ckb_constants::{CellField, Source}, error::SysError, syscalls};
use ed25519_compact::{PublicKey, Signature};

ckb_std::entry!(program_entry);
ckb_std::default_alloc!();

const VAULT_MAGIC: &[u8; 8] = b"CKBSOLV1";
const DOMAIN: &[u8] = b"CKB-SOL-UNLOCK-V1";

#[repr(i8)]
enum Error {
    Syscall = 1,
    BadArgs = 2,
    NoVault = 3,
    TwoVaults = 4,
    TypedDeposit = 5,
    BadVaultData = 6,
    BadWitness = 7,
    WrongSeq = 8,
    BadSignature = 9,
    NotEnoughSignatures = 10,
    BadVaultOutput = 11,
    StrayCustodyOutput = 12,
    WrongOutflow = 13,
    RecipientUnderpaid = 14,
    UnsortedSigners = 15,
}

impl From<SysError> for Error {
    fn from(_: SysError) -> Self { Error::Syscall }
}

fn ckbhash(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = blake2b_ref::Blake2bBuilder::new(32).personal(b"ckb-default-hash").build();
    for p in parts {
        h.update(p);
    }
    let mut out = [0u8; 32];
    h.finalize(&mut out);
    out
}

/// Load a field fully into a heap buffer (sized by the syscall's reported length).
fn load_vec(f: impl Fn(&mut [u8], usize) -> Result<usize, SysError>) -> Result<alloc::vec::Vec<u8>, SysError> {
    let mut small = [0u8; 256];
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


fn hash32(index: usize, source: Source, field: CellField) -> Result<Option<[u8; 32]>, SysError> {
    let mut b = [0u8; 32];
    match syscalls::load_cell_by_field(&mut b, 0, index, source, field) {
        Ok(_) => Ok(Some(b)),
        Err(SysError::ItemMissing) => Ok(None),
        Err(e) => Err(e),
    }
}

fn capacity(index: usize, source: Source) -> Result<u64, SysError> {
    let mut b = [0u8; 8];
    syscalls::load_cell_by_field(&mut b, 0, index, source, CellField::Capacity)?;
    Ok(u64::from_le_bytes(b))
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

fn vault_seq(data: &[u8]) -> Option<u64> {
    if data.len() != 16 || &data[..8] != VAULT_MAGIC {
        return None;
    }
    Some(u64::from_le_bytes(data[8..16].try_into().unwrap()))
}

fn run() -> Result<(), Error> {
    // --- args
    let script = load_vec(|b, o| syscalls::load_script(b, o))?;
    let args = table_field(&script, 2).ok_or(Error::BadArgs)?; // Script.args (Bytes)
    let args = args.get(4..).ok_or(Error::BadArgs)?;
    if args.len() < 66 {
        return Err(Error::BadArgs);
    }
    let vault_type_hash: [u8; 32] = args[0..32].try_into().unwrap();
    let bridge_id = &args[32..64];
    let (m, n) = (args[64] as usize, args[65] as usize);
    if m == 0 || m > n || args.len() != 66 + 32 * n {
        return Err(Error::BadArgs);
    }
    let pks = &args[66..];
    let mut own = [0u8; 32];
    syscalls::load_script_hash(&mut own, 0)?;

    // --- rule 1: group inputs = one vault + untyped deposits
    let (mut vault_in, mut in_total) = (None, 0u64);
    let mut i = 0;
    loop {
        let cap = match capacity(i, Source::GroupInput) {
            Ok(c) => c,
            Err(SysError::IndexOutOfBound) => break,
            Err(e) => return Err(e.into()),
        };
        in_total = in_total.checked_add(cap).ok_or(Error::WrongOutflow)?;
        match hash32(i, Source::GroupInput, CellField::TypeHash)? {
            Some(t) if t == vault_type_hash => {
                if vault_in.is_some() {
                    return Err(Error::TwoVaults);
                }
                vault_in = Some(i);
            }
            Some(_) => return Err(Error::TypedDeposit),
            None => {}
        }
        i += 1;
    }
    let vault_in = vault_in.ok_or(Error::NoVault)?;
    let vdata = load_vec(|b, o| syscalls::load_cell_data(b, o, vault_in, Source::GroupInput))?;
    let seq = vault_seq(&vdata).ok_or(Error::BadVaultData)?;

    // --- rule 2: witness + signatures
    let wit = load_vec(|b, o| syscalls::load_witness(b, o, 0, Source::GroupInput))?;
    let lock = table_field(&wit, 0).ok_or(Error::BadWitness)?; // WitnessArgs.lock: BytesOpt
    let w = lock.get(4..).ok_or(Error::BadWitness)?; // Bytes payload (len prefix checked below)
    if lock.len() < 4 || u32::from_le_bytes(lock[..4].try_into().unwrap()) as usize != w.len() || w.len() < 49 {
        return Err(Error::BadWitness);
    }
    let w_seq = u64::from_le_bytes(w[0..8].try_into().unwrap());
    let amount = u64::from_le_bytes(w[8..16].try_into().unwrap());
    let recipient: [u8; 32] = w[16..48].try_into().unwrap();
    let k = w[48] as usize;
    if w.len() != 49 + 65 * k {
        return Err(Error::BadWitness);
    }
    if w_seq != seq {
        return Err(Error::WrongSeq);
    }
    let msg = ckbhash(&[DOMAIN, bridge_id, &vault_type_hash, &w[0..8], &w[8..16], &recipient]);
    let mut good = 0usize;
    let mut last: i32 = -1;
    for s in w[49..].chunks_exact(65) {
        let idx = s[0] as usize;
        if idx >= n {
            return Err(Error::BadSignature);
        }
        if idx as i32 <= last {
            return Err(Error::UnsortedSigners);
        }
        last = idx as i32;
        let pk = PublicKey::from_slice(&pks[32 * idx..32 * idx + 32]).map_err(|_| Error::BadArgs)?;
        let sig = Signature::from_slice(&s[1..65]).map_err(|_| Error::BadSignature)?;
        pk.verify(msg, &sig).map_err(|_| Error::BadSignature)?;
        good += 1;
    }
    if good < m {
        return Err(Error::NotEnoughSignatures);
    }

    // --- rules 3 + 4: outputs
    let (mut vault_out, mut paid) = (None, 0u64);
    let mut j = 0;
    loop {
        let lh = match hash32(j, Source::Output, CellField::LockHash) {
            Ok(Some(h)) => h,
            Ok(None) => return Err(Error::Syscall),
            Err(SysError::IndexOutOfBound) => break,
            Err(e) => return Err(e.into()),
        };
        if lh == own {
            if vault_out.is_some() || hash32(j, Source::Output, CellField::TypeHash)? != Some(vault_type_hash) {
                return Err(Error::StrayCustodyOutput);
            }
            vault_out = Some(j);
        } else if lh == recipient {
            paid = paid.checked_add(capacity(j, Source::Output)?).ok_or(Error::RecipientUnderpaid)?;
        }
        j += 1;
    }
    let vault_out = vault_out.ok_or(Error::BadVaultOutput)?;
    let odata = load_vec(|b, o| syscalls::load_cell_data(b, o, vault_out, Source::Output))?;
    if vault_seq(&odata) != Some(seq + 1) {
        return Err(Error::BadVaultOutput);
    }
    let out_cap = capacity(vault_out, Source::Output)?;
    let expect_out = if recipient == own { 0 } else { amount };
    if in_total.checked_sub(out_cap) != Some(expect_out) {
        return Err(Error::WrongOutflow);
    }
    if recipient != own && paid < amount {
        return Err(Error::RecipientUnderpaid);
    }
    Ok(())
}

fn program_entry() -> i8 {
    match run() {
        Ok(()) => 0,
        Err(e) => e as i8,
    }
}

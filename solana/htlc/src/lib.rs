//! SHA-256 hash time-locked SOL escrow (spike). The Solana leg of
//! CKB -> Fiber -> Cross-Chain Hub -> Lightning -> Solana.
//!
//! A liquidity provider (the *offerer*) locks `amount` lamports for a *claimer* under a SHA-256
//! payment hash, the same hash as the Lightning hold invoice the LP is being paid with (and the
//! Fiber payment behind it). The claimer gets the SOL by revealing the preimage before `expiry`;
//! the preimage is then public in the claim transaction, and the LP uses it to settle the
//! Lightning invoice. After `expiry` anyone can return the SOL to the offerer.
//!
//! Escrow PDA: ["htlc", offerer, payment_hash]. One live escrow per (offerer, hash); including
//! the offerer means nobody else can squat the address the LP needs.
//!
//! Instructions (first byte = tag):
//!   0 Lock   [hash 32][claimer 32][amount u64][expiry i64]  [offerer (s, w), escrow PDA (w), system program]
//!   1 Claim  [preimage 32]                                  [escrow (w), claimer (w), offerer (w)]
//!   2 Refund []                                             [escrow (w), offerer (w)]
//!   3 Cancel []                                             [escrow (w), offerer (w), claimer (s)]
//!
//! Claim and Refund need no signature: they can only pay the parties recorded in the escrow,
//! so anyone (a watchtower, the LP, a relayer) may submit them. Cancel is the claimer waiving
//! its claim before expiry (signed by the claimer), so the offerer need not wait out the lock
//! when the other leg of a swap failed. On any of the three the escrow is closed: `amount` goes
//! to the winner, the rent deposit back to the offerer.
#![allow(unexpected_cfgs)]

#[allow(deprecated)]
use solana_program::sysvar::Sysvar;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey,
    pubkey::Pubkey,
    rent::Rent,
};

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub const SYSTEM_PROGRAM_ID: Pubkey = pubkey!("11111111111111111111111111111111");
pub const MAGIC: &[u8; 8] = b"SOLHTLC1";
pub const ESCROW_LEN: usize = 128;
/// Longest lock an offerer may set, so a typo cannot freeze SOL for years.
pub const MAX_LOCK_SECS: i64 = 7 * 24 * 3600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum HtlcError {
    BadInstruction = 1,
    WrongPda = 2,
    NotSigner = 3,
    BadEscrow = 4,
    WrongPreimage = 5,
    Expired = 6,
    NotExpired = 7,
    WrongClaimer = 8,
    WrongOfferer = 9,
    ZeroAmount = 10,
    BadExpiry = 11,
}
impl From<HtlcError> for ProgramError {
    fn from(e: HtlcError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Lock {
    pub hash: [u8; 32],
    pub claimer: [u8; 32],
    pub amount: u64,
    pub expiry: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Escrow {
    pub hash: [u8; 32],
    pub offerer: [u8; 32],
    pub claimer: [u8; 32],
    pub amount: u64,
    pub expiry: i64,
}

fn u64_at(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}

/// Lock instruction body, checked against the current time.
pub fn parse_lock(d: &[u8], now: i64) -> Result<Lock, HtlcError> {
    if d.len() != 80 {
        return Err(HtlcError::BadInstruction);
    }
    let l = Lock {
        hash: d[0..32].try_into().unwrap(),
        claimer: d[32..64].try_into().unwrap(),
        amount: u64_at(d, 64),
        expiry: u64_at(d, 72) as i64,
    };
    if l.amount == 0 {
        return Err(HtlcError::ZeroAmount);
    }
    if l.expiry <= now || l.expiry - now > MAX_LOCK_SECS {
        return Err(HtlcError::BadExpiry);
    }
    Ok(l)
}

pub fn write_escrow(d: &mut [u8], offerer: &[u8; 32], l: &Lock, bump: u8) {
    d[..ESCROW_LEN].fill(0);
    d[0..8].copy_from_slice(MAGIC);
    d[8..40].copy_from_slice(&l.hash);
    d[40..72].copy_from_slice(offerer);
    d[72..104].copy_from_slice(&l.claimer);
    d[104..112].copy_from_slice(&l.amount.to_le_bytes());
    d[112..120].copy_from_slice(&l.expiry.to_le_bytes());
    d[120] = bump;
}

pub fn read_escrow(d: &[u8]) -> Result<Escrow, HtlcError> {
    if d.len() < ESCROW_LEN || &d[0..8] != MAGIC {
        return Err(HtlcError::BadEscrow);
    }
    Ok(Escrow {
        hash: d[8..40].try_into().unwrap(),
        offerer: d[40..72].try_into().unwrap(),
        claimer: d[72..104].try_into().unwrap(),
        amount: u64_at(d, 104),
        expiry: u64_at(d, 112) as i64,
    })
}

/// Claim is valid strictly before expiry with the right preimage.
pub fn check_claim(e: &Escrow, preimage: &[u8], now: i64) -> Result<(), HtlcError> {
    if preimage.len() != 32 {
        return Err(HtlcError::BadInstruction);
    }
    if solana_sha256_hasher::hash(preimage).to_bytes() != e.hash {
        return Err(HtlcError::WrongPreimage);
    }
    if now >= e.expiry {
        return Err(HtlcError::Expired);
    }
    Ok(())
}

/// Refund is valid from expiry on. Claim and refund windows never overlap.
pub fn check_refund(e: &Escrow, now: i64) -> Result<(), HtlcError> {
    if now < e.expiry {
        return Err(HtlcError::NotExpired);
    }
    Ok(())
}

pub fn escrow_pda(program_id: &Pubkey, offerer: &Pubkey, hash: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"htlc", offerer.as_ref(), hash], program_id)
}

fn system_ix(data: Vec<u8>, accounts: Vec<AccountMeta>) -> Instruction {
    Instruction { program_id: SYSTEM_PROGRAM_ID, accounts, data }
}

/// Create a program-owned PDA of `len` bytes, also when someone pre-funded the address
/// (which would make a plain CreateAccount fail): top up, allocate, assign.
fn create_pda<'a>(
    program_id: &Pubkey,
    payer: &AccountInfo<'a>,
    acct: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    seeds: &[&[u8]],
    len: usize,
) -> ProgramResult {
    let rent = Rent::get()?.minimum_balance(len);
    let infos = [payer.clone(), acct.clone(), system.clone()];
    let pk = |k: &Pubkey, s: bool| AccountMeta::new(*k, s);
    if acct.lamports() == 0 {
        let mut data = 0u32.to_le_bytes().to_vec();
        data.extend_from_slice(&rent.to_le_bytes());
        data.extend_from_slice(&(len as u64).to_le_bytes());
        data.extend_from_slice(program_id.as_ref());
        return invoke_signed(&system_ix(data, vec![pk(payer.key, true), pk(acct.key, true)]), &infos, &[seeds]);
    }
    if acct.lamports() < rent {
        let mut data = 2u32.to_le_bytes().to_vec();
        data.extend_from_slice(&(rent - acct.lamports()).to_le_bytes());
        invoke(&system_ix(data, vec![pk(payer.key, true), pk(acct.key, false)]), &infos)?;
    }
    let mut data = 8u32.to_le_bytes().to_vec();
    data.extend_from_slice(&(len as u64).to_le_bytes());
    invoke_signed(&system_ix(data, vec![pk(acct.key, true)]), &infos, &[seeds])?;
    let mut data = 1u32.to_le_bytes().to_vec();
    data.extend_from_slice(program_id.as_ref());
    invoke_signed(&system_ix(data, vec![pk(acct.key, true)]), &infos, &[seeds])
}

fn now() -> Result<i64, ProgramError> {
    Ok(Clock::get()?.unix_timestamp)
}

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (tag, rest) = data.split_first().ok_or(HtlcError::BadInstruction)?;
    match tag {
        0 => lock(program_id, accounts, rest),
        1 => settle(program_id, accounts, Settle::Claim(rest)),
        2 => settle(program_id, accounts, Settle::Refund),
        3 => settle(program_id, accounts, Settle::Cancel),
        _ => Err(HtlcError::BadInstruction.into()),
    }
}

fn lock(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let offerer = next_account_info(it)?;
    let escrow = next_account_info(it)?;
    let system = next_account_info(it)?;
    if !offerer.is_signer {
        return Err(HtlcError::NotSigner.into());
    }
    if *system.key != SYSTEM_PROGRAM_ID {
        return Err(HtlcError::BadInstruction.into());
    }
    let l = parse_lock(d, now()?)?;
    let (pda, bump) = escrow_pda(program_id, offerer.key, &l.hash);
    if *escrow.key != pda {
        return Err(HtlcError::WrongPda.into());
    }
    // A live escrow under this (offerer, hash) already exists.
    if escrow.owner == program_id && escrow.data_len() >= 8 && &escrow.try_borrow_data()?[0..8] == MAGIC {
        return Err(HtlcError::BadEscrow.into());
    }
    create_pda(program_id, offerer, escrow, system, &[b"htlc", offerer.key.as_ref(), &l.hash, &[bump]], ESCROW_LEN)?;
    let mut t = 2u32.to_le_bytes().to_vec();
    t.extend_from_slice(&l.amount.to_le_bytes());
    invoke(
        &system_ix(t, vec![AccountMeta::new(*offerer.key, true), AccountMeta::new(*escrow.key, false)]),
        &[offerer.clone(), escrow.clone(), system.clone()],
    )?;
    write_escrow(&mut escrow.try_borrow_mut_data()?, &offerer.key.to_bytes(), &l, bump);
    msg!("lock {} lamports, expiry {}", l.amount, l.expiry);
    Ok(())
}

enum Settle<'a> {
    Claim(&'a [u8]),
    Refund,
    Cancel,
}

/// Claim, refund or cancel. Pays `amount` to the winner, returns the rent deposit to the
/// offerer, and closes the escrow.
fn settle(program_id: &Pubkey, accounts: &[AccountInfo], how: Settle) -> ProgramResult {
    let it = &mut accounts.iter();
    let escrow = next_account_info(it)?;
    if escrow.owner != program_id {
        return Err(HtlcError::BadEscrow.into());
    }
    let e = read_escrow(&escrow.try_borrow_data()?)?;
    let t = now()?;
    let (winner, offerer) = match how {
        Settle::Claim(p) => {
            check_claim(&e, p, t)?;
            let claimer = next_account_info(it)?;
            let offerer = next_account_info(it)?;
            if claimer.key.to_bytes() != e.claimer {
                return Err(HtlcError::WrongClaimer.into());
            }
            (claimer, offerer)
        }
        Settle::Refund => {
            check_refund(&e, t)?;
            let offerer = next_account_info(it)?;
            (offerer, offerer)
        }
        Settle::Cancel => {
            let offerer = next_account_info(it)?;
            let claimer = next_account_info(it)?;
            if claimer.key.to_bytes() != e.claimer {
                return Err(HtlcError::WrongClaimer.into());
            }
            if !claimer.is_signer {
                return Err(HtlcError::NotSigner.into());
            }
            (offerer, offerer)
        }
    };
    if offerer.key.to_bytes() != e.offerer {
        return Err(HtlcError::WrongOfferer.into());
    }
    let total = escrow.lamports();
    let rent_back = total.checked_sub(e.amount).ok_or(HtlcError::BadEscrow)?;
    **escrow.try_borrow_mut_lamports()? = 0;
    **winner.try_borrow_mut_lamports()? += e.amount;
    **offerer.try_borrow_mut_lamports()? += rent_back;
    escrow.try_borrow_mut_data()?.fill(0);
    match how {
        Settle::Claim(p) => msg!("claim preimage {}", hex32(p)),
        Settle::Refund => msg!("refund"),
        Settle::Cancel => msg!("cancel by claimer"),
    }
    Ok(())
}

fn hex32(b: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    b.iter().flat_map(|x| [H[(x >> 4) as usize] as char, H[(x & 15) as usize] as char]).collect()
}

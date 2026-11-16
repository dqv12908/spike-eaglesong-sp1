//! CKB ↔ Solana bridge on Solana (spike): a CKB light client, a deposit-backed SPL mint, and
//! burns that release CKB from custody on the way back.
//!
//! Light client: a state account stores the verified CKB tip of one chain (mainnet or testnet,
//! fixed by `pow_id` at init) and a ring of the last 16 accepted tips, each with its cumulative
//! difficulty from the checkpoint. Anyone can submit an SP1 Groth16 proof (kind 1) that a
//! segment of headers continues one of those tips. The guest checks PoW, linkage, and the
//! epoch / difficulty transition rules from the parent header (so a prover cannot pick an easy
//! `compact_target`). Fork choice: a segment extending the tip is accepted; one forking from an
//! older ring entry is accepted only if its cumulative difficulty is strictly greater than the
//! tip's, and the ring entries of the abandoned branch are dropped.
//!
//! Bridge: a config account binds one light-client state, one SPL mint (8 decimals, mint
//! authority = this program's PDA), the CKB custody lock hash, a confirmation depth and a max
//! age. Anyone can submit a deposit proof (kind 2) showing a CKB output, locked by the custody
//! lock and carrying a 32-byte Solana recipient as data, in a block that is an ancestor of a
//! ring tip, with `confirmations ≤ tip − block ≤ max_age` (two-sided height bound). The program
//! mints `capacity` (shannons, 1 CKB = 10^8) once per out-point (nullifier PDA).
//!
//! Burn: a holder burns ckbCKB and names a CKB lock script. The program records burn #seq
//! (sequential per config) in a PDA. CKB-side attesters sign that record; the CKB custody lock
//! (`ckb-custody/`) releases exactly `amount` to that lock, in seq order.
//!
//! Instructions (first byte = tag):
//!   0 Init        [anchor_number u64][anchor_hash 32][pow_id u8]  [state (w, program-owned), admin (s)]
//!   1 Submit      [pv_len u16][pv][proof 356]                     [state (w)]
//!   2 Verify      [pv_len u16][pv][proof 356]                     []
//!   3 InitBridge  [lock_hash 32][confirmations u64][max_age u64]  [config (w, program-owned), state, mint, admin (s)]
//!   4 Mint        [pv_len u16][pv][proof 356]                     [config (w), state, mint (w), mint_auth PDA,
//!                                                                  recipient token acct (w), nullifier PDA (w),
//!                                                                  payer (s, w), system program, token program]
//!   5 Burn        [amount u64][code_hash 32][hash_type u8]        [config (w), mint (w), source token acct (w),
//!                 [args_len u8][args]                              owner (s), burn record PDA (w), payer (s, w),
//!                                                                  system program, token program]
//!
//! The light-client anchor is a trusted checkpoint; FlyClient / MMR are not implemented (every
//! header from the checkpoint is proven instead). See the spike README.
#![allow(unexpected_cfgs)]

pub mod groth16;
pub mod vk;

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

pub const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const SYSTEM_PROGRAM_ID: Pubkey = pubkey!("11111111111111111111111111111111");

// ---- light-client state ----
// 0..8 magic | 8..40 admin | 40..48 tip number | 48..80 tip hash | 80..112 tip cumulative
// difficulty (LE) | 112..120 tip position (u) | 120 pow_id | 121 ring_len | ring @128:
// entry(u) at slot u % RING = number u64 | hash 32 | cumulative difficulty 32 (LE).
// Valid entries: positions tip_u − ring_len + 1 ..= tip_u, each the parent of the next.
pub const MAGIC: [u8; 8] = *b"CKBLC003";
pub const RING: usize = 16;
pub const RING_OFF: usize = 128;
pub const ENTRY_LEN: usize = 72;
pub const STATE_LEN: usize = RING_OFF + RING * ENTRY_LEN; // 1280
pub const SUMMARY_LEN: usize = 112;
pub const KIND_SEGMENT: u8 = 1;
pub const KIND_DEPOSIT: u8 = 2;
pub const SEGMENT_PV_LEN: usize = 2 + SUMMARY_LEN; // 114
pub const DEPOSIT_PV_LEN: usize = 194;

// ---- bridge config ----
// 0..8 magic | 8..40 admin | 40..72 state | 72..104 mint | 104..136 custody lock hash |
// 136..144 confirmations | 144..152 total minted | 152 mint-auth bump | 160..168 max age |
// 168..176 total burned | 176..184 next burn seq
pub const CONFIG_MAGIC: [u8; 8] = *b"CKBBR002";
pub const CONFIG_LEN: usize = 192;
pub const NULLIFIER_LEN: usize = 8;
pub const MINT_DECIMALS: u8 = 8;
pub const SEED_MINT_AUTH: &[u8] = b"mint_auth";
pub const SEED_DEPOSIT: &[u8] = b"deposit";
pub const SEED_BURN: &[u8] = b"burn";

// ---- burn record ----
// 0..8 magic | 8..16 seq | 16..24 amount | 24..32 slot | 32..64 burner | 64..96 code_hash |
// 96 hash_type | 97 args_len | 98..162 args (zero-padded)
pub const BURN_MAGIC: [u8; 8] = *b"CKBBURN1";
pub const BURN_LEN: usize = 168;
pub const MAX_LOCK_ARGS: usize = 64;
pub const SHANNONS: u64 = 100_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum LcError {
    BadInstruction = 1,
    AlreadyInitialized = 2,
    NotInitialized = 3,
    ProofInvalid = 4,
    BadSummary = 5,
    DoesNotExtendTip = 6,
    WrongOwner = 7,
    WrongPow = 8,
    NotAnchored = 9,
    TooFewConfirmations = 10,
    WrongLock = 11,
    BadDepositData = 12,
    WrongMint = 13,
    WrongTokenAccount = 14,
    AlreadyMinted = 15,
    WrongProgram = 16,
    BadConfig = 17,
    WrongKind = 18,
    WrongPda = 19,
    ForkNotHeavier = 20,
    DepositTooOld = 21,
    BadBurn = 22,
    BurnTooSmall = 23,
}
impl From<LcError> for ProgramError {
    fn from(e: LcError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

/// Decoded 112-byte segment summary committed by the SP1 guest (after kind + pow_id).
pub struct Summary {
    pub pow_id: u8,
    pub first_number: u64,
    pub last_number: u64,
    pub first_parent_hash: [u8; 32],
    pub last_hash: [u8; 32],
    pub total_difficulty_le: [u8; 32],
}

fn u64_at(b: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(b[o..o + 8].try_into().unwrap())
}
fn u32_at(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(b[o..o + 4].try_into().unwrap())
}
fn b32(b: &[u8], o: usize) -> [u8; 32] {
    b[o..o + 32].try_into().unwrap()
}

pub fn parse_segment(pv: &[u8]) -> Result<Summary, LcError> {
    if pv.len() != SEGMENT_PV_LEN || pv[0] != KIND_SEGMENT {
        return Err(LcError::WrongKind);
    }
    let s = &pv[2..];
    let r = Summary {
        pow_id: pv[1],
        first_number: u64_at(s, 0),
        last_number: u64_at(s, 8),
        first_parent_hash: b32(s, 16),
        last_hash: b32(s, 48),
        total_difficulty_le: b32(s, 80),
    };
    if r.last_number < r.first_number {
        return Err(LcError::BadSummary);
    }
    Ok(r)
}

/// Decoded 194-byte deposit event (layout: ckb_pow::deposit::DepositEvent::to_bytes).
pub struct Deposit {
    pub anchor_number: u64,
    pub anchor_hash: [u8; 32],
    pub block_number: u64,
    pub block_hash: [u8; 32],
    pub tx_hash: [u8; 32],
    pub out_index: u32,
    pub capacity: u64,
    pub lock_hash: [u8; 32],
    pub has_type: bool,
    pub data_len: u32,
    pub recipient: [u8; 32],
}

pub fn parse_deposit(pv: &[u8]) -> Result<Deposit, LcError> {
    if pv.len() != DEPOSIT_PV_LEN || pv[0] != KIND_DEPOSIT {
        return Err(LcError::WrongKind);
    }
    Ok(Deposit {
        anchor_number: u64_at(pv, 1),
        anchor_hash: b32(pv, 9),
        block_number: u64_at(pv, 41),
        block_hash: b32(pv, 49),
        tx_hash: b32(pv, 81),
        out_index: u32_at(pv, 113),
        capacity: u64_at(pv, 117),
        lock_hash: b32(pv, 125),
        has_type: pv[157] != 0,
        data_len: u32_at(pv, 158),
        recipient: b32(pv, 162),
    })
}

/// `a + b` for 256-bit little-endian integers; `None` on overflow.
pub fn add_u256_le(a: &[u8; 32], b: &[u8; 32]) -> Option<[u8; 32]> {
    let mut r = [0u8; 32];
    let mut carry = 0u16;
    for i in 0..32 {
        let s = a[i] as u16 + b[i] as u16 + carry;
        r[i] = s as u8;
        carry = s >> 8;
    }
    (carry == 0).then_some(r)
}

/// `a > b` for 256-bit little-endian integers.
pub fn gt_u256_le(a: &[u8; 32], b: &[u8; 32]) -> bool {
    for i in (0..32).rev() {
        if a[i] != b[i] {
            return a[i] > b[i];
        }
    }
    false
}

/// First 8 bytes of a hash as hex, for log lines.
pub struct H8([u8; 16]);
impl core::fmt::Display for H8 {
    fn fmt(&self, f: &mut core::fmt::Formatter) -> core::fmt::Result {
        f.write_str(core::str::from_utf8(&self.0).unwrap())
    }
}
fn h8(b: &[u8; 32]) -> H8 {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut o = [0u8; 16];
    for i in 0..8 {
        o[2 * i] = H[(b[i] >> 4) as usize];
        o[2 * i + 1] = H[(b[i] & 15) as usize];
    }
    H8(o)
}

fn split_pv_proof(data: &[u8]) -> Result<(&[u8], &[u8]), LcError> {
    if data.len() < 2 {
        return Err(LcError::BadInstruction);
    }
    let n = u16::from_le_bytes([data[0], data[1]]) as usize;
    if data.len() != 2 + n + groth16::PROOF_LEN {
        return Err(LcError::BadInstruction);
    }
    Ok((&data[2..2 + n], &data[2 + n..]))
}

fn verify_proof(pv: &[u8], proof: &[u8]) -> ProgramResult {
    groth16::verify_sp1_groth16(proof, pv, &vk::PROGRAM_VKEY).map_err(|e| {
        msg!("groth16 verify failed: {:?}", e);
        LcError::ProofInvalid.into()
    })
}

// ---- ring of tips ----

/// One accepted tip: (number, hash, cumulative difficulty since the checkpoint, LE).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Entry {
    pub number: u64,
    pub hash: [u8; 32],
    pub cum: [u8; 32],
}

fn entry_off(u: u64) -> usize {
    RING_OFF + (u as usize % RING) * ENTRY_LEN
}
pub fn ring_get(d: &[u8], u: u64) -> Entry {
    let o = entry_off(u);
    Entry { number: u64_at(d, o), hash: b32(d, o + 8), cum: b32(d, o + 40) }
}
fn ring_put(d: &mut [u8], u: u64, e: &Entry) {
    let o = entry_off(u);
    d[o..o + 8].copy_from_slice(&e.number.to_le_bytes());
    d[o + 8..o + 40].copy_from_slice(&e.hash);
    d[o + 40..o + 72].copy_from_slice(&e.cum);
}
fn tip_u(d: &[u8]) -> u64 {
    u64_at(d, 112)
}
fn ring_len(d: &[u8]) -> u64 {
    d[121] as u64
}
/// Valid ring positions, newest first.
fn valid(d: &[u8]) -> impl Iterator<Item = u64> {
    let (t, n) = (tip_u(d), ring_len(d));
    (0..n).map(move |k| t - k)
}

/// Initialise a state buffer at a trusted checkpoint.
pub fn state_init(d: &mut [u8], admin: &[u8; 32], number: u64, hash: &[u8; 32], pow_id: u8) {
    d[..STATE_LEN].fill(0);
    d[..8].copy_from_slice(&MAGIC);
    d[8..40].copy_from_slice(admin);
    d[40..48].copy_from_slice(&number.to_le_bytes());
    d[48..80].copy_from_slice(hash);
    d[120] = pow_id;
    d[121] = 1;
    ring_put(d, 0, &Entry { number, hash: *hash, cum: [0; 32] });
}

/// Outcome of applying a verified segment to the light-client state.
#[derive(Debug, PartialEq, Eq)]
pub enum Applied {
    Extended,
    /// Replaced `dropped` ring entries of a lighter branch.
    Reorg { dropped: u64 },
}

/// Fork choice (state transition only; the proof is checked by the caller).
pub fn apply_segment(d: &mut [u8], s: &Summary) -> Result<Applied, LcError> {
    if s.pow_id != d[120] {
        return Err(LcError::WrongPow);
    }
    let t = tip_u(d);
    let (u, parent) = valid(d)
        .map(|u| (u, ring_get(d, u)))
        .find(|(_, e)| e.hash == s.first_parent_hash && e.number.checked_add(1) == Some(s.first_number))
        .ok_or(LcError::DoesNotExtendTip)?;
    let cum = add_u256_le(&parent.cum, &s.total_difficulty_le).ok_or(LcError::BadSummary)?;
    let tip = ring_get(d, t);
    let outcome = if u == t {
        Applied::Extended
    } else if gt_u256_le(&cum, &tip.cum) {
        Applied::Reorg { dropped: t - u }
    } else {
        return Err(LcError::ForkNotHeavier);
    };
    let new_u = u + 1;
    let len = (ring_len(d) - (t - u) + 1).min(RING as u64);
    ring_put(d, new_u, &Entry { number: s.last_number, hash: s.last_hash, cum });
    d[40..48].copy_from_slice(&s.last_number.to_le_bytes());
    d[48..80].copy_from_slice(&s.last_hash);
    d[80..112].copy_from_slice(&cum);
    d[112..120].copy_from_slice(&new_u.to_le_bytes());
    d[121] = len as u8;
    Ok(outcome)
}

/// Deposit anchoring: the anchor is a live ring entry and the deposit block is
/// `confirmations ≤ tip − block ≤ max_age` below the current tip. Returns the depth.
pub fn check_anchor(d: &[u8], e: &Deposit, confirmations: u64, max_age: u64) -> Result<u64, LcError> {
    if !valid(d).any(|u| {
        let x = ring_get(d, u);
        x.number == e.anchor_number && x.hash == e.anchor_hash
    }) {
        return Err(LcError::NotAnchored);
    }
    if e.anchor_number < e.block_number {
        return Err(LcError::BadDepositData);
    }
    let depth = u64_at(d, 40).checked_sub(e.block_number).ok_or(LcError::BadDepositData)?;
    if depth < confirmations {
        return Err(LcError::TooFewConfirmations);
    }
    if depth > max_age {
        return Err(LcError::DepositTooOld);
    }
    Ok(depth)
}

fn load_state<'a>(program_id: &Pubkey, state: &'a AccountInfo) -> Result<core::cell::Ref<'a, &'a mut [u8]>, ProgramError> {
    if state.owner != program_id {
        return Err(LcError::WrongOwner.into());
    }
    let d = state.try_borrow_data()?;
    if d.len() < STATE_LEN || d[..8] != MAGIC {
        return Err(LcError::NotInitialized.into());
    }
    Ok(d)
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

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (tag, rest) = data.split_first().ok_or(LcError::BadInstruction)?;
    match tag {
        0 => init(program_id, accounts, rest),
        1 => submit(program_id, accounts, rest),
        2 => {
            let (pv, proof) = split_pv_proof(rest)?;
            verify_proof(pv, proof)?;
            match pv.first() {
                Some(&KIND_SEGMENT) => {
                    let s = parse_segment(pv)?;
                    msg!("verified CKB segment #{}..#{} (pow {})", s.first_number, s.last_number, s.pow_id);
                }
                Some(&KIND_DEPOSIT) => {
                    let e = parse_deposit(pv)?;
                    msg!("verified CKB deposit in #{} (anchor #{}), {} shannons", e.block_number, e.anchor_number, e.capacity);
                }
                _ => return Err(LcError::WrongKind.into()),
            }
            Ok(())
        }
        3 => init_bridge(program_id, accounts, rest),
        4 => mint(program_id, accounts, rest),
        5 => burn(program_id, accounts, rest),
        _ => Err(LcError::BadInstruction.into()),
    }
}

fn init(program_id: &Pubkey, accounts: &[AccountInfo], rest: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let state = next_account_info(it)?;
    let admin = next_account_info(it)?;
    if !admin.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if state.owner != program_id {
        return Err(LcError::WrongOwner.into());
    }
    if rest.len() != 41 || rest[40] > 1 {
        return Err(LcError::BadInstruction.into());
    }
    let mut d = state.try_borrow_mut_data()?;
    if d.len() < STATE_LEN {
        return Err(ProgramError::AccountDataTooSmall);
    }
    if d[..8] == MAGIC {
        return Err(LcError::AlreadyInitialized.into());
    }
    let (number, hash) = (u64_at(rest, 0), b32(rest, 8));
    state_init(&mut d, &admin.key.to_bytes(), number, &hash, rest[40]);
    msg!("ckb-lc init: anchor #{} 0x{}… pow {}", number, h8(&hash), rest[40]);
    Ok(())
}

fn submit(program_id: &Pubkey, accounts: &[AccountInfo], rest: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let state = next_account_info(it)?;
    if state.owner != program_id {
        return Err(LcError::WrongOwner.into());
    }
    let (pv, proof) = split_pv_proof(rest)?;
    let s = parse_segment(pv)?;
    verify_proof(pv, proof)?;
    let mut d = state.try_borrow_mut_data()?;
    if d.len() < STATE_LEN || d[..8] != MAGIC {
        return Err(LcError::NotInitialized.into());
    }
    let r = apply_segment(&mut d, &s).inspect_err(|e| {
        msg!("segment #{}..#{} rejected: {:?}", s.first_number, s.last_number, e);
    })?;
    msg!(
        "ckb-lc tip -> #{} 0x{}… (+{} headers, {:?}, ring {})",
        s.last_number,
        h8(&s.last_hash),
        s.last_number - s.first_number + 1,
        r,
        d[121]
    );
    Ok(())
}

fn mint_auth_pda(program_id: &Pubkey, config: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SEED_MINT_AUTH, config.as_ref()], program_id)
}

fn init_bridge(program_id: &Pubkey, accounts: &[AccountInfo], rest: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let config = next_account_info(it)?;
    let state = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let admin = next_account_info(it)?;
    if !admin.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if config.owner != program_id {
        return Err(LcError::WrongOwner.into());
    }
    if rest.len() != 48 || u64_at(rest, 40) < u64_at(rest, 32) {
        return Err(LcError::BadInstruction.into());
    }
    drop(load_state(program_id, state)?);
    let (auth, bump) = mint_auth_pda(program_id, config.key);
    {
        if mint.owner != &TOKEN_PROGRAM_ID {
            return Err(LcError::WrongMint.into());
        }
        let m = mint.try_borrow_data()?;
        // spl-token Mint: authority COption(4+32), supply 8, decimals 1, initialized 1, freeze COption(4+32)
        if m.len() != 82 || u32_at(&m, 0) != 1 || m[4..36] != auth.to_bytes() || m[44] != MINT_DECIMALS || m[45] != 1 || u32_at(&m, 46) != 0 {
            msg!("mint must have authority = mint_auth PDA, {} decimals, no freeze authority", MINT_DECIMALS);
            return Err(LcError::WrongMint.into());
        }
    }
    let mut c = config.try_borrow_mut_data()?;
    if c.len() < CONFIG_LEN {
        return Err(ProgramError::AccountDataTooSmall);
    }
    if c[..8] == CONFIG_MAGIC {
        return Err(LcError::AlreadyInitialized.into());
    }
    c[..CONFIG_LEN].fill(0);
    c[..8].copy_from_slice(&CONFIG_MAGIC);
    c[8..40].copy_from_slice(admin.key.as_ref());
    c[40..72].copy_from_slice(state.key.as_ref());
    c[72..104].copy_from_slice(mint.key.as_ref());
    c[104..136].copy_from_slice(&rest[..32]);
    c[136..144].copy_from_slice(&rest[32..40]);
    c[152] = bump;
    c[160..168].copy_from_slice(&rest[40..48]);
    msg!("bridge init: custody lock 0x{}… confirmations {} max age {}", h8(&b32(rest, 0)), u64_at(rest, 32), u64_at(rest, 40));
    Ok(())
}

fn load_config(program_id: &Pubkey, config: &AccountInfo, mint: &AccountInfo) -> Result<(), ProgramError> {
    if config.owner != program_id {
        return Err(LcError::WrongOwner.into());
    }
    let c = config.try_borrow_data()?;
    if c.len() < CONFIG_LEN || c[..8] != CONFIG_MAGIC || c[72..104] != mint.key.to_bytes() {
        return Err(LcError::BadConfig.into());
    }
    Ok(())
}

fn mint(program_id: &Pubkey, accounts: &[AccountInfo], rest: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let config = next_account_info(it)?;
    let state = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let mint_auth = next_account_info(it)?;
    let dest = next_account_info(it)?;
    let nullifier = next_account_info(it)?;
    let payer = next_account_info(it)?;
    let system = next_account_info(it)?;
    let token = next_account_info(it)?;
    if system.key != &SYSTEM_PROGRAM_ID || token.key != &TOKEN_PROGRAM_ID {
        return Err(LcError::WrongProgram.into());
    }
    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // config ↔ state ↔ mint binding
    load_config(program_id, config, mint)?;
    let (lock_hash, confirmations, bump, max_age) = {
        let c = config.try_borrow_data()?;
        if c[40..72] != state.key.to_bytes() {
            return Err(LcError::BadConfig.into());
        }
        (b32(&c, 104), u64_at(&c, 136), c[152], u64_at(&c, 160))
    };
    let auth_seeds: &[&[u8]] = &[SEED_MINT_AUTH, config.key.as_ref(), &[bump]];
    if Pubkey::create_program_address(auth_seeds, program_id).map_err(|_| LcError::WrongPda)? != *mint_auth.key {
        return Err(LcError::WrongPda.into());
    }

    // proof → deposit event
    let (pv, proof) = split_pv_proof(rest)?;
    let e = parse_deposit(pv)?;
    verify_proof(pv, proof)?;

    // anchored to a live light-client tip, two-sided depth bound against the current tip
    let depth = {
        let d = load_state(program_id, state)?;
        check_anchor(&d, &e, confirmations, max_age).inspect_err(|err| {
            msg!("deposit in #{} (anchor #{} 0x{}…) rejected: {:?}", e.block_number, e.anchor_number, h8(&e.anchor_hash), err);
        })?
    };
    // the deposit cell itself
    if e.lock_hash != lock_hash {
        return Err(LcError::WrongLock.into());
    }
    if e.has_type || e.data_len != 32 || e.capacity == 0 {
        return Err(LcError::BadDepositData.into());
    }
    // destination: an initialized token account of this mint owned by the recipient
    {
        if dest.owner != &TOKEN_PROGRAM_ID {
            return Err(LcError::WrongTokenAccount.into());
        }
        let t = dest.try_borrow_data()?;
        if t.len() != 165 || t[0..32] != mint.key.to_bytes() || t[32..64] != e.recipient || t[108] != 1 {
            return Err(LcError::WrongTokenAccount.into());
        }
    }

    // nullifier: one mint per CKB out-point
    let idx = e.out_index.to_le_bytes();
    let (nf, nf_bump) = Pubkey::find_program_address(&[SEED_DEPOSIT, config.key.as_ref(), &e.tx_hash, &idx], program_id);
    if nf != *nullifier.key {
        return Err(LcError::WrongPda.into());
    }
    if nullifier.owner == program_id {
        return Err(LcError::AlreadyMinted.into());
    }
    let nf_seeds: &[&[u8]] = &[SEED_DEPOSIT, config.key.as_ref(), &e.tx_hash, &idx, &[nf_bump]];
    create_pda(program_id, payer, nullifier, system, nf_seeds, NULLIFIER_LEN)?;
    nullifier.try_borrow_mut_data()?[..8].copy_from_slice(&e.capacity.to_le_bytes());

    // mint `capacity` (shannons) — spl-token MintTo = 7
    let mut data = vec![7u8];
    data.extend_from_slice(&e.capacity.to_le_bytes());
    let ix = Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![AccountMeta::new(*mint.key, false), AccountMeta::new(*dest.key, false), AccountMeta::new_readonly(*mint_auth.key, true)],
        data,
    };
    invoke_signed(&ix, &[mint.clone(), dest.clone(), mint_auth.clone(), token.clone()], &[auth_seeds])?;

    {
        let mut c = config.try_borrow_mut_data()?;
        let total = u64_at(&c, 144).saturating_add(e.capacity);
        c[144..152].copy_from_slice(&total.to_le_bytes());
    }
    msg!(
        "minted {} (8 dp) for CKB tx 0x{}…:{} in #{} ({} confs) to {}",
        e.capacity,
        h8(&e.tx_hash),
        e.out_index,
        e.block_number,
        depth,
        Pubkey::new_from_array(e.recipient)
    );
    Ok(())
}

/// Parsed Burn instruction data.
pub struct BurnArgs<'a> {
    pub amount: u64,
    pub code_hash: [u8; 32],
    pub hash_type: u8,
    pub args: &'a [u8],
}

/// Validate Burn data. The recipient cell on CKB needs `8 + 32 + 1 + args_len` bytes of
/// capacity (no type, no data), so a smaller burn could never be paid out.
pub fn parse_burn(rest: &[u8]) -> Result<BurnArgs<'_>, LcError> {
    if rest.len() < 42 {
        return Err(LcError::BadBurn);
    }
    let n = rest[41] as usize;
    if n > MAX_LOCK_ARGS || rest.len() != 42 + n || !matches!(rest[40], 0 | 1 | 2 | 4) {
        return Err(LcError::BadBurn);
    }
    let b = BurnArgs { amount: u64_at(rest, 0), code_hash: b32(rest, 8), hash_type: rest[40], args: &rest[42..] };
    if b.amount < (41 + n as u64) * SHANNONS {
        return Err(LcError::BurnTooSmall);
    }
    Ok(b)
}

fn burn(program_id: &Pubkey, accounts: &[AccountInfo], rest: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let config = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let source = next_account_info(it)?;
    let owner = next_account_info(it)?;
    let record = next_account_info(it)?;
    let payer = next_account_info(it)?;
    let system = next_account_info(it)?;
    let token = next_account_info(it)?;
    if system.key != &SYSTEM_PROGRAM_ID || token.key != &TOKEN_PROGRAM_ID {
        return Err(LcError::WrongProgram.into());
    }
    if !owner.is_signer || !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    load_config(program_id, config, mint)?;
    let b = parse_burn(rest)?;
    let seq = u64_at(&config.try_borrow_data()?, 176);

    let seq_le = seq.to_le_bytes();
    let (pda, bump) = Pubkey::find_program_address(&[SEED_BURN, config.key.as_ref(), &seq_le], program_id);
    if pda != *record.key {
        return Err(LcError::WrongPda.into());
    }
    if record.owner == program_id {
        return Err(LcError::BadBurn.into());
    }

    // spl-token Burn = 8 (owner signs the outer transaction; token program checks the account)
    let mut data = vec![8u8];
    data.extend_from_slice(&b.amount.to_le_bytes());
    let ix = Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![AccountMeta::new(*source.key, false), AccountMeta::new(*mint.key, false), AccountMeta::new_readonly(*owner.key, true)],
        data,
    };
    invoke(&ix, &[source.clone(), mint.clone(), owner.clone(), token.clone()])?;

    let seeds: &[&[u8]] = &[SEED_BURN, config.key.as_ref(), &seq_le, &[bump]];
    create_pda(program_id, payer, record, system, seeds, BURN_LEN)?;
    {
        let mut r = record.try_borrow_mut_data()?;
        r[..8].copy_from_slice(&BURN_MAGIC);
        r[8..16].copy_from_slice(&seq_le);
        r[16..24].copy_from_slice(&b.amount.to_le_bytes());
        r[24..32].copy_from_slice(&Clock::get()?.slot.to_le_bytes());
        r[32..64].copy_from_slice(owner.key.as_ref());
        r[64..96].copy_from_slice(&b.code_hash);
        r[96] = b.hash_type;
        r[97] = b.args.len() as u8;
        r[98..98 + b.args.len()].copy_from_slice(b.args);
    }
    {
        let mut c = config.try_borrow_mut_data()?;
        let total = u64_at(&c, 168).saturating_add(b.amount);
        c[168..176].copy_from_slice(&total.to_le_bytes());
        c[176..184].copy_from_slice(&(seq + 1).to_le_bytes());
    }
    msg!("burn #{}: {} (8 dp) by {} -> CKB lock 0x{}… type {} args {} B", seq, b.amount, owner.key, h8(&b.code_hash), b.hash_type, b.args.len());
    Ok(())
}

//! Deposit-cell inclusion: prove that output `i` of transaction `tx` sits in block `B`, and
//! that `B` is an ancestor of an anchor header `T` (hash-linked headers `B..=T`).
//!
//! No PoW is checked here: `T` must be a header the verifier already trusts (on Solana, a tip
//! the light client accepted from a PoW-checked segment proof). Hash linkage from `B` to `T`
//! then makes `B` part of that chain.
//!
//! Inclusion path (CKB consensus rules):
//!   tx_hash            = ckbhash(RawTransaction)
//!   raw_txs_root       = CBMT root over tx hashes (single-leaf proof: tree index + lemmas)
//!   transactions_root  = ckbhash(raw_txs_root || witnesses_root)   (2-leaf CBMT)
//!   header.transactions_root == transactions_root
//!
//! Second-preimage note: a CBMT inner node is `ckbhash(64 bytes)`. A RawTransaction that
//! contains output `i` (a table with a Script inside) is always longer than 64 bytes, and the
//! parser requires `total_size == len`, so an inner node can never be passed off as a leaf.
use crate::{ckbhash, Byte32, HeaderView, HEADER_LEN};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DepositError {
    BadHeaders,
    HeightGap { number: u64 },
    ParentMismatch { number: u64 },
    Molecule,
    NoSuchOutput,
    BadProof,
    TransactionsRootMismatch,
}

pub const DEPOSIT_EVENT_LEN: usize = 194;
pub const KIND_SEGMENT: u8 = 1;
pub const KIND_DEPOSIT: u8 = 2;

/// What the deposit proof commits to (fixed 194-byte encoding, see `to_bytes`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DepositEvent {
    pub anchor_number: u64,
    pub anchor_hash: Byte32,
    pub block_number: u64,
    pub block_hash: Byte32,
    pub tx_hash: Byte32,
    pub out_index: u32,
    /// Output capacity in shannons (1 CKB = 10^8 shannons).
    pub capacity: u64,
    /// `ckbhash(lock Script)` of the output.
    pub lock_hash: Byte32,
    pub has_type: bool,
    pub data_len: u32,
    /// First 32 bytes of the output data (zero-padded). The bridge requires `data_len == 32`,
    /// so this is the whole data: the Solana recipient.
    pub recipient: Byte32,
}

impl DepositEvent {
    /// kind(1) anchor_number(8) anchor_hash(32) block_number(8) block_hash(32) tx_hash(32)
    /// out_index(4) capacity(8) lock_hash(32) has_type(1) data_len(4) recipient(32). LE ints.
    pub fn to_bytes(&self) -> [u8; DEPOSIT_EVENT_LEN] {
        let mut b = [0u8; DEPOSIT_EVENT_LEN];
        b[0] = KIND_DEPOSIT;
        b[1..9].copy_from_slice(&self.anchor_number.to_le_bytes());
        b[9..41].copy_from_slice(&self.anchor_hash);
        b[41..49].copy_from_slice(&self.block_number.to_le_bytes());
        b[49..81].copy_from_slice(&self.block_hash);
        b[81..113].copy_from_slice(&self.tx_hash);
        b[113..117].copy_from_slice(&self.out_index.to_le_bytes());
        b[117..125].copy_from_slice(&self.capacity.to_le_bytes());
        b[125..157].copy_from_slice(&self.lock_hash);
        b[157] = self.has_type as u8;
        b[158..162].copy_from_slice(&self.data_len.to_le_bytes());
        b[162..194].copy_from_slice(&self.recipient);
        b
    }
}

fn u32_at(b: &[u8], o: usize) -> Result<u32, DepositError> {
    b.get(o..o + 4).map(|x| u32::from_le_bytes(x.try_into().unwrap())).ok_or(DepositError::Molecule)
}

/// Field `i` of a molecule table / dynvec, checking the header strictly.
/// Returns `(field, field_count)`.
fn dyn_item(b: &[u8], i: usize) -> Result<(&[u8], usize), DepositError> {
    let total = u32_at(b, 0)? as usize;
    if total != b.len() {
        return Err(DepositError::Molecule);
    }
    if total == 4 {
        return Err(DepositError::NoSuchOutput); // empty table/vec
    }
    let first = u32_at(b, 4)? as usize;
    if first % 4 != 0 || first < 8 || first > total {
        return Err(DepositError::Molecule);
    }
    let count = first / 4 - 1;
    if i >= count {
        return Err(DepositError::NoSuchOutput);
    }
    let start = u32_at(b, 4 + 4 * i)? as usize;
    let end = if i + 1 == count { total } else { u32_at(b, 8 + 4 * i)? as usize };
    if start > end || end > total || start < first {
        return Err(DepositError::Molecule);
    }
    Ok((&b[start..end], count))
}

fn table_field(b: &[u8], i: usize, expect_fields: usize) -> Result<&[u8], DepositError> {
    let (f, count) = dyn_item(b, i).map_err(|_| DepositError::Molecule)?;
    if count != expect_fields {
        return Err(DepositError::Molecule);
    }
    Ok(f)
}

/// Molecule `Bytes` (fixvec<byte>) payload.
fn bytes_payload(b: &[u8]) -> Result<&[u8], DepositError> {
    let n = u32_at(b, 0)? as usize;
    if b.len() != 4 + n {
        return Err(DepositError::Molecule);
    }
    Ok(&b[4..])
}

/// The parts of `outputs[i]` / `outputs_data[i]` the bridge needs.
pub struct OutputView<'a> {
    pub capacity: u64,
    pub lock: &'a [u8],
    pub has_type: bool,
    pub data: &'a [u8],
}

/// Parse `outputs[i]` and `outputs_data[i]` from a serialized `RawTransaction`.
pub fn raw_tx_output(raw_tx: &[u8], i: u32) -> Result<OutputView<'_>, DepositError> {
    // RawTransaction { version, cell_deps, header_deps, inputs, outputs, outputs_data }
    let outputs = table_field(raw_tx, 4, 6)?;
    let outputs_data = table_field(raw_tx, 5, 6)?;
    let (out, n_out) = dyn_item(outputs, i as usize)?;
    let (data, n_data) = dyn_item(outputs_data, i as usize)?;
    if n_out != n_data {
        return Err(DepositError::Molecule);
    }
    // CellOutput { capacity: Uint64, lock: Script, type_: ScriptOpt }
    let cap = table_field(out, 0, 3)?;
    if cap.len() != 8 {
        return Err(DepositError::Molecule);
    }
    let lock = table_field(out, 1, 3)?;
    let ty = table_field(out, 2, 3)?;
    // Script { code_hash, hash_type, args } — sanity-check the lock is a 3-field table.
    table_field(lock, 0, 3)?;
    Ok(OutputView {
        capacity: u64::from_le_bytes(cap.try_into().unwrap()),
        lock,
        has_type: !ty.is_empty(),
        data: bytes_payload(data)?,
    })
}

/// CBMT root from a single-leaf proof (`tree_index` = leaf position in the tree array,
/// i.e. `leaf_index + n_leaves - 1`, as returned by `get_transaction_proof`).
pub fn cbmt_root_single(leaf: Byte32, tree_index: u32, lemmas: &[Byte32]) -> Result<Byte32, DepositError> {
    let mut i = tree_index;
    let mut node = leaf;
    let mut buf = [0u8; 64];
    for lemma in lemmas {
        if i == 0 {
            return Err(DepositError::BadProof);
        }
        if i & 1 == 1 {
            buf[..32].copy_from_slice(&node);
            buf[32..].copy_from_slice(lemma);
        } else {
            buf[..32].copy_from_slice(lemma);
            buf[32..].copy_from_slice(&node);
        }
        node = ckbhash(&buf);
        i = (i - 1) >> 1;
    }
    if i != 0 {
        return Err(DepositError::BadProof);
    }
    Ok(node)
}

/// Verify a deposit: hash-linked headers `B..=T` (`headers`, n*208 bytes, `B` first), the
/// transaction's inclusion in `B`, and extract output `out_index`.
pub fn verify_deposit(
    headers: &[u8],
    raw_tx: &[u8],
    out_index: u32,
    tree_index: u32,
    lemmas: &[Byte32],
    witnesses_root: Byte32,
) -> Result<DepositEvent, DepositError> {
    if headers.is_empty() || headers.len() % HEADER_LEN != 0 {
        return Err(DepositError::BadHeaders);
    }
    let first = HeaderView(headers[..HEADER_LEN].try_into().unwrap());
    let (block_number, block_hash) = (first.number(), first.hash());
    let mut prev = (block_number, block_hash);
    for chunk in headers.chunks_exact(HEADER_LEN).skip(1) {
        let h = HeaderView(chunk.try_into().unwrap());
        if h.number() != prev.0 + 1 {
            return Err(DepositError::HeightGap { number: h.number() });
        }
        if h.parent_hash() != prev.1 {
            return Err(DepositError::ParentMismatch { number: h.number() });
        }
        prev = (h.number(), h.hash());
    }

    let tx_hash = ckbhash(raw_tx);
    let raw_txs_root = cbmt_root_single(tx_hash, tree_index, lemmas)?;
    let mut buf = [0u8; 64];
    buf[..32].copy_from_slice(&raw_txs_root);
    buf[32..].copy_from_slice(&witnesses_root);
    if ckbhash(&buf) != first.transactions_root() {
        return Err(DepositError::TransactionsRootMismatch);
    }

    let o = raw_tx_output(raw_tx, out_index)?;
    let mut recipient = [0u8; 32];
    let k = o.data.len().min(32);
    recipient[..k].copy_from_slice(&o.data[..k]);
    Ok(DepositEvent {
        anchor_number: prev.0,
        anchor_hash: prev.1,
        block_number,
        block_hash,
        tx_hash,
        out_index,
        capacity: o.capacity,
        lock_hash: ckbhash(o.lock),
        has_type: o.has_type,
        data_len: o.data.len() as u32,
        recipient,
    })
}

/// Segment public values: kind(1) pow_id(1) summary(112).
pub fn segment_public_values(pow_id: u8, summary: &[u8; 112]) -> [u8; 114] {
    let mut b = [0u8; 114];
    b[0] = KIND_SEGMENT;
    b[1] = pow_id;
    b[2..].copy_from_slice(summary);
    b
}

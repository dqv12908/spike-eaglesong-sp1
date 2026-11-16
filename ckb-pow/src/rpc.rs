//! Host-only helpers: turn CKB JSON-RPC `HeaderView` objects into molecule bytes.
extern crate std;
use std::{string::String, vec::Vec};

use crate::HEADER_LEN;

fn hex_bytes(v: &serde_json::Value, field: &str) -> Vec<u8> {
    let s = v[field].as_str().unwrap_or_else(|| panic!("missing {field}"));
    hex::decode(s.trim_start_matches("0x")).unwrap_or_else(|e| panic!("{field}: {e}"))
}

fn hex_uint(v: &serde_json::Value, field: &str) -> u128 {
    let s = v[field].as_str().unwrap_or_else(|| panic!("missing {field}"));
    u128::from_str_radix(s.trim_start_matches("0x"), 16).unwrap_or_else(|e| panic!("{field}: {e}"))
}

/// Serialize an RPC header (JSON) into the 208-byte molecule `Header`.
pub fn header_bytes(v: &serde_json::Value) -> [u8; HEADER_LEN] {
    let mut b = Vec::with_capacity(HEADER_LEN);
    b.extend_from_slice(&(hex_uint(v, "version") as u32).to_le_bytes());
    b.extend_from_slice(&(hex_uint(v, "compact_target") as u32).to_le_bytes());
    b.extend_from_slice(&(hex_uint(v, "timestamp") as u64).to_le_bytes());
    b.extend_from_slice(&(hex_uint(v, "number") as u64).to_le_bytes());
    b.extend_from_slice(&(hex_uint(v, "epoch") as u64).to_le_bytes());
    for f in ["parent_hash", "transactions_root", "proposals_hash", "extra_hash", "dao"] {
        let x = hex_bytes(v, f);
        assert_eq!(x.len(), 32, "{f}");
        b.extend_from_slice(&x);
    }
    b.extend_from_slice(&hex_uint(v, "nonce").to_le_bytes());
    b.try_into().unwrap()
}

/// The RPC-reported block hash.
pub fn rpc_hash(v: &serde_json::Value) -> [u8; 32] {
    hex_bytes(v, "hash").try_into().unwrap()
}

/// Load the fixture produced by `scripts/fetch_headers.py`: (contiguous run, sparse samples).
pub fn load_fixture(json: &str) -> (Vec<serde_json::Value>, Vec<serde_json::Value>) {
    let v: serde_json::Value = serde_json::from_str(json).expect("fixture json");
    let arr = |k: &str| v[k].as_array().cloned().unwrap_or_default();
    (arr("run"), arr("samples"))
}

pub fn hex32(b: &[u8; 32]) -> String {
    hex::encode(b)
}

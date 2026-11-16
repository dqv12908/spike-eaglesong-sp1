//! Share-lock tests in ckb-testtool's simulated chain (real CKB-VM).
//! Binary: ~/keyshare-target/riscv64imac-unknown-none-elf/release/keyshare-lock (KEYSHARE_BIN overrides).
//! KEYSHARE_VARIANT labels the `METRIC` lines printed for successful spends.
//!
//! Host-side keys come from libraries other than the ones compiled into the lock where possible:
//! secp256k1 = libsecp256k1 (the lock uses k256); Ed25519 = curve25519-dalek's x86-64 backend plus
//! ed25519-dalek signatures, and a known-answer test against the RFC 8032 base point encoding.
use ckb_testtool::ckb_types::{
    bytes::Bytes,
    core::{Capacity, ScriptHashType, TransactionBuilder, TransactionView},
    packed::{CellDep, CellInput, CellOutput, OutPoint, Script, WitnessArgs},
    prelude::*,
};
use ckb_testtool::context::Context;
use sha2::{Digest, Sha256};

const MAX_CYCLES: u64 = 70_000_000;
const CKB: u64 = 100_000_000;

const CLAIM: u8 = 1;
const REFUND: u8 = 2;
const PUNISH: u8 = 3;

// Lock error codes (ckb-keyshare/src/main.rs).
const E_BAD_ARGS: i8 = 2;
const E_BAD_WITNESS: i8 = 3;
const E_BAD_TAG: i8 = 4;
const E_PARAMS_MISMATCH: i8 = 5;
const E_BAD_CURVE: i8 = 6;
const E_BAD_PARAMS_LENGTH: i8 = 7;
const E_WRONG_RELEASE_SECRET: i8 = 8;
const E_SCALAR_ZERO: i8 = 9;
const E_SCALAR_NON_CANONICAL: i8 = 10;
const E_SCALAR_MISMATCH: i8 = 11;
const E_WRONG_OUTPUT_LOCK: i8 = 12;
const E_SINCE_TYPE_MISMATCH: i8 = 13;
const E_REFUND_TOO_EARLY: i8 = 14;
const E_PUNISH_TOO_EARLY: i8 = 15;
const E_NO_OUTPUTS: i8 = 16;
const E_FEE_TOO_HIGH: i8 = 17;

/// The lock's FEE_CAP: most capacity (shannons) a spend may leave as fee.
const FEE_CAP: u64 = 100_000;

/// Relative block-number since.
const fn rel_blocks(n: u64) -> u64 {
    0x8000_0000_0000_0000 | n
}
const T1: u64 = rel_blocks(100);
const T2: u64 = rel_blocks(200);

#[derive(Clone, Copy, PartialEq, Debug)]
enum Curve {
    Ed25519 = 0,
    Secp256k1 = 1,
}

impl Curve {
    fn name(self) -> &'static str {
        match self {
            Curve::Ed25519 => "ed25519",
            Curve::Secp256k1 => "secp256k1",
        }
    }

    /// A valid non-zero scalar in the lock's encoding (Ed25519 LE, secp256k1 BE), from a label.
    fn scalar(self, label: &str) -> [u8; 32] {
        let h: [u8; 32] = Sha256::digest(label.as_bytes()).into();
        match self {
            Curve::Ed25519 => curve25519_dalek::Scalar::from_bytes_mod_order(h).to_bytes(),
            Curve::Secp256k1 => secp256k1::SecretKey::from_slice(&h).expect("hash below group order").secret_bytes(),
        }
    }

    /// scalar*G, compressed, computed on the host.
    fn public(self, scalar: &[u8; 32]) -> Vec<u8> {
        match self {
            Curve::Ed25519 => {
                let s = Option::from(curve25519_dalek::Scalar::from_canonical_bytes(*scalar)).expect("canonical");
                curve25519_dalek::EdwardsPoint::mul_base(&s).compress().to_bytes().to_vec()
            }
            Curve::Secp256k1 => {
                let sk = secp256k1::SecretKey::from_slice(scalar).expect("valid scalar");
                secp256k1::PublicKey::from_secret_key(&secp256k1::Secp256k1::new(), &sk).serialize().to_vec()
            }
        }
    }

    /// Group order in the lock's scalar encoding.
    fn order(self) -> [u8; 32] {
        match self {
            // L = 2^252 + 27742317777372353535851937790883648493, little-endian
            Curve::Ed25519 => [
                0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14, 0, 0, 0, 0, 0, 0, 0,
                0, 0, 0, 0, 0, 0, 0, 0, 0x10,
            ],
            // n, big-endian
            Curve::Secp256k1 => [
                0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xba, 0xae, 0xdc,
                0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
            ],
        }
    }

    /// The scalar 1 and order + 1 (the non-canonical encoding of 1), in the lock's encoding.
    fn one_and_order_plus_one(self) -> ([u8; 32], [u8; 32]) {
        let (mut one, mut n1) = ([0u8; 32], self.order());
        match self {
            Curve::Ed25519 => {
                one[0] = 1;
                n1[0] += 1;
            }
            Curve::Secp256k1 => {
                one[31] = 1;
                n1[31] += 1;
            }
        }
        (one, n1)
    }

    /// Standard encoding of the base point, from the specs (RFC 8032 / SEC 2), not from a library.
    fn generator(self) -> Vec<u8> {
        match self {
            Curve::Ed25519 => {
                let mut g = vec![0x66u8; 32];
                g[0] = 0x58;
                g
            }
            Curve::Secp256k1 => vec![
                0x02, 0x79, 0xbe, 0x66, 0x7e, 0xf9, 0xdc, 0xbb, 0xac, 0x55, 0xa0, 0x62, 0x95, 0xce, 0x87, 0x0b, 0x07, 0x02, 0x9b,
                0xfc, 0xdb, 0x2d, 0xce, 0x28, 0xd9, 0x59, 0xf2, 0x81, 0x5b, 0x16, 0xf8, 0x17, 0x98,
            ],
        }
    }
}

fn ckbhash(data: &[u8]) -> [u8; 32] {
    let mut h = blake2b_ref::Blake2bBuilder::new(32).personal(b"ckb-default-hash").build();
    h.update(data);
    let mut o = [0u8; 32];
    h.finalize(&mut o);
    o
}

struct Env {
    ctx: Context,
    code: OutPoint,
    deps: Vec<OutPoint>,
    maker: Script,
    taker: Script,
    thief: Script,
}

fn bin_path() -> String {
    std::env::var("KEYSHARE_BIN").unwrap_or_else(|_| {
        format!("{}/keyshare-target/riscv64imac-unknown-none-elf/release/keyshare-lock", std::env::var("HOME").unwrap())
    })
}

fn env() -> Env {
    let mut ctx = Context::default();
    let code = ctx.deploy_cell(Bytes::from(std::fs::read(bin_path()).expect("keyshare binary")));
    let always = ctx.deploy_cell(ckb_testtool::builtin::ALWAYS_SUCCESS.clone());
    let maker = ctx.build_script(&always, Bytes::from(vec![0xaa])).unwrap();
    let taker = ctx.build_script(&always, Bytes::from(vec![0xbb])).unwrap();
    let thief = ctx.build_script(&always, Bytes::from(vec![0xcc])).unwrap();
    Env { ctx, code: code.clone(), deps: vec![code, always], maker, taker, thief }
}

/// One swap: the two shares, the release secret and the committed params.
#[derive(Clone)]
struct Swap {
    a: [u8; 32],
    b: [u8; 32],
    r: [u8; 32],
    params: Vec<u8>,
}

fn params(curve: u8, maker_pub: &[u8], taker_pub: &[u8], r: &[u8; 32], e: &Env, t1: u64, t2: u64) -> Vec<u8> {
    let mut p = vec![curve];
    p.extend_from_slice(maker_pub);
    p.extend_from_slice(taker_pub);
    p.extend_from_slice(&Sha256::digest(r));
    p.extend_from_slice(e.maker.calc_script_hash().as_slice());
    p.extend_from_slice(e.taker.calc_script_hash().as_slice());
    p.extend_from_slice(&t1.to_le_bytes());
    p.extend_from_slice(&t2.to_le_bytes());
    p
}

fn swap(e: &Env, curve: Curve) -> Swap {
    let a = curve.scalar("taker share a");
    let b = curve.scalar("maker share b");
    let r: [u8; 32] = Sha256::digest(b"release secret").into();
    let params = params(curve as u8, &curve.public(&b), &curve.public(&a), &r, e, T1, T2);
    Swap { a, b, r, params }
}

/// One spend of a share-lock cell.
#[derive(Clone)]
struct Case {
    args: Vec<u8>,        // lock args of the cell being spent
    tag: u8,
    params: Vec<u8>,      // params as supplied in the witness
    tail: Vec<u8>,        // path data
    since: u64,
    outputs: Vec<Script>, // locks of the outputs (capacity split evenly)
    fee: u64,             // shannons not paid to any output (inputs - outputs)
    extra_input: u64,     // capacity of a second, non-share-lock input (0 = none)
    raw_witness: Option<Bytes>,
}

impl Case {
    fn new(s: &Swap, tag: u8, tail: Vec<u8>, since: u64, to: &Script) -> Case {
        Case { args: ckbhash(&s.params)[..20].to_vec(), tag, params: s.params.clone(), tail, since, outputs: vec![to.clone()], fee: FEE_CAP, extra_input: 0, raw_witness: None }
    }
}

fn claim(e: &Env, s: &Swap) -> Case {
    Case::new(s, CLAIM, [s.b, s.r].concat(), 0, &e.maker)
}
fn refund(e: &Env, s: &Swap) -> Case {
    Case::new(s, REFUND, s.a.to_vec(), T1, &e.taker)
}
fn punish(e: &Env, s: &Swap) -> Case {
    Case::new(s, PUNISH, vec![], T2, &e.maker)
}

fn build(e: &mut Env, c: &Case) -> TransactionView {
    let lock = e.ctx.build_script_with_hash_type(&e.code, ScriptHashType::Data2, c.args.clone().into()).unwrap();
    let cell = e.ctx.create_cell(CellOutput::new_builder().capacity(1000 * CKB).lock(lock).build(), Bytes::new());
    let mut inputs = vec![CellInput::new_builder().previous_output(cell).since(c.since).build()];
    let mut witnesses = vec![];
    if c.extra_input > 0 {
        let extra = e.ctx.create_cell(CellOutput::new_builder().capacity(c.extra_input).lock(e.thief.clone()).build(), Bytes::new());
        inputs.push(CellInput::new_builder().previous_output(extra).build());
        witnesses.push(Bytes::new().pack());
    }
    // Outputs hold exactly inputs - fee: split evenly, remainder on the first.
    let (total, n) = (1000 * CKB + c.extra_input - c.fee, c.outputs.len().max(1) as u64);
    let outputs: Vec<CellOutput> = c
        .outputs
        .iter()
        .enumerate()
        .map(|(i, l)| CellOutput::new_builder().capacity(total / n + if i == 0 { total % n } else { 0 }).lock(l.clone()).build())
        .collect();
    let data: Vec<Bytes> = c.outputs.iter().map(|_| Bytes::new()).collect();
    let witness = c.raw_witness.clone().unwrap_or_else(|| {
        let mut w = vec![c.tag];
        w.extend_from_slice(&c.params);
        w.extend_from_slice(&c.tail);
        WitnessArgs::new_builder().lock(Some(Bytes::from(w)).pack()).build().as_bytes()
    });
    let deps: Vec<CellDep> = e.deps.iter().map(|op| CellDep::new_builder().out_point(op.clone()).build()).collect();
    witnesses.insert(0, witness.pack());
    TransactionBuilder::default().inputs(inputs).outputs(outputs).outputs_data(data.pack()).witnesses(witnesses).cell_deps(deps).build()
}

/// Run and return Ok((cycles, serialized tx bytes)) or the script's exit code.
fn run(e: &mut Env, c: &Case) -> Result<(u64, usize), i8> {
    let tx = build(e, c);
    let size = tx.data().as_slice().len();
    e.ctx.verify_tx(&tx, MAX_CYCLES).map(|cycles| (cycles, size)).map_err(|err| {
        let s = err.to_string();
        let code = s.split("error code ").nth(1).and_then(|r| r.split(|ch: char| !ch.is_ascii_digit() && ch != '-').next()).and_then(|n| n.parse().ok());
        code.unwrap_or_else(|| panic!("unexpected failure: {s}"))
    })
}

fn metric(curve: Curve, path: &str, (cycles, tx_bytes): (u64, usize)) {
    let variant = std::env::var("KEYSHARE_VARIANT").unwrap_or_else(|_| "default".into());
    let bin = std::fs::metadata(bin_path()).unwrap().len();
    println!("METRIC variant={variant} curve={} path={path} cycles={cycles} tx_bytes={tx_bytes} binary_bytes={bin}", curve.name());
}

// ---------------------------------------------------------------- success paths

fn successes(curve: Curve) {
    let mut e = env();
    let s = swap(&e, curve);
    let c = claim(&e, &s);
    metric(curve, "claim", run(&mut e, &c).expect("claim with the right b and r"));
    let c = refund(&e, &s);
    metric(curve, "refund", run(&mut e, &c).expect("refund at t1 with the right a"));
    let c = Case { since: rel_blocks(150), ..refund(&e, &s) };
    run(&mut e, &c).expect("refund after t1");
    let c = punish(&e, &s);
    metric(curve, "punish", run(&mut e, &c).expect("punish at t2"));
    let c = Case { since: rel_blocks(1_000_000), ..punish(&e, &s) };
    run(&mut e, &c).expect("punish after t2");
    // Several outputs are fine as long as every one pays the right party.
    let c = Case { outputs: vec![e.maker.clone(), e.maker.clone()], ..claim(&e, &s) };
    run(&mut e, &c).expect("claim with two maker outputs");
}

#[test]
fn ed25519_success_paths() {
    successes(Curve::Ed25519);
}

#[test]
fn secp256k1_success_paths() {
    successes(Curve::Secp256k1);
}

// ---------------------------------------------------------------- fee cap

/// On every path the outputs must hold all input capacity except at most FEE_CAP, and there must be
/// an output: a broadcast spend cannot be rebuilt by someone else with the value turned into fee.
fn fee_cap(curve: Curve) {
    let mut e = env();
    let s = swap(&e, curve);
    let paths: [(&str, fn(&Env, &Swap) -> Case); 3] = [("claim", claim), ("refund", refund), ("punish", punish)];
    for (path, make) in paths {
        let base = make(&e, &s);
        let to = base.outputs[0].clone();
        let cases: Vec<(&str, Case, Result<(), i8>)> = vec![
            ("fee exactly at the cap", Case { fee: FEE_CAP, ..base.clone() }, Ok(())),
            ("fee one shannon under the cap", Case { fee: FEE_CAP - 1, ..base.clone() }, Ok(())),
            ("no fee at all", Case { fee: 0, ..base.clone() }, Ok(())),
            ("fee one shannon over the cap", Case { fee: FEE_CAP + 1, ..base.clone() }, Err(E_FEE_TOO_HIGH)),
            ("fee of 1 CKB", Case { fee: CKB, ..base.clone() }, Err(E_FEE_TOO_HIGH)),
            ("all but 61 CKB as fee", Case { fee: 939 * CKB, ..base.clone() }, Err(E_FEE_TOO_HIGH)),
            ("zero outputs (everything as fee)", Case { outputs: vec![], ..base.clone() }, Err(E_NO_OUTPUTS)),
            ("two outputs, fee exactly at the cap", Case { outputs: vec![to.clone(), to.clone()], ..base.clone() }, Ok(())),
            ("two outputs, fee one shannon over the cap", Case { outputs: vec![to.clone(), to.clone()], fee: FEE_CAP + 1, ..base.clone() }, Err(E_FEE_TOO_HIGH)),
            // The cap is on the whole transaction: a second input's capacity must reach the outputs too.
            ("extra 500 CKB input, fee exactly at the cap", Case { extra_input: 500 * CKB, ..base.clone() }, Ok(())),
            ("extra 500 CKB input, fee one shannon over the cap", Case { extra_input: 500 * CKB, fee: FEE_CAP + 1, ..base.clone() }, Err(E_FEE_TOO_HIGH)),
            ("extra 500 CKB input left as fee", Case { extra_input: 500 * CKB, fee: 500 * CKB, ..base.clone() }, Err(E_FEE_TOO_HIGH)),
            // A wrong output lock is still reported as such, whatever the amounts.
            ("wrong lock and fee over the cap", Case { outputs: vec![e.thief.clone()], fee: CKB, ..base.clone() }, Err(E_WRONG_OUTPUT_LOCK)),
        ];
        for (name, c, want) in cases {
            let got = run(&mut e, &c).map(|_| ());
            println!("{}: {path}: {name}: {got:?}", curve.name());
            assert_eq!(got, want, "{}: {path}: {name}", curve.name());
        }
    }
}

#[test]
fn ed25519_fee_cap() {
    fee_cap(Curve::Ed25519);
}

#[test]
fn secp256k1_fee_cap() {
    fee_cap(Curve::Secp256k1);
}

// ---------------------------------------------------------------- rejections

fn bump(curve: Curve, s: &[u8; 32]) -> [u8; 32] {
    // s + 1 without carry handling beyond one byte; fine for the fixed test scalars.
    let mut o = *s;
    let i = if curve == Curve::Ed25519 { 0 } else { 31 };
    o[i] = o[i].wrapping_add(1);
    assert_ne!(o[i], 0);
    o
}

fn rejections(curve: Curve) {
    let mut e = env();
    let s = swap(&e, curve);
    let (one, order_plus_one) = curve.one_and_order_plus_one();
    let g = curve.generator();
    // A swap whose maker AND taker share public key is the base point (share = 1). If the lock reduced
    // scalars instead of rejecting non-canonical ones, order + 1 would pass against it.
    let unit = Swap { a: one, b: one, params: params(curve as u8, &g, &g, &s.r, &e, T1, T2), ..s.clone() };
    let tampered = {
        // maker_lock_hash replaced by the thief's: the witness params no longer hash to args.
        let mut p = s.params.clone();
        let off = p.len() - 16 - 64;
        p[off..off + 32].copy_from_slice(e.thief.calc_script_hash().as_slice());
        p
    };
    let bad_curve = {
        let mut p = s.params.clone();
        p[0] = 2;
        p
    };
    let short = s.params[..s.params.len() - 1].to_vec();
    let abs_t = Swap { params: params(curve as u8, &curve.public(&s.b), &curve.public(&s.a), &s.r, &e, 100, 200), ..s.clone() };

    let cases: Vec<(&str, Case, i8)> = vec![
        // --- the list from the task
        ("claim: wrong scalar (b + 1)", Case { tail: [bump(curve, &s.b), s.r].concat(), ..claim(&e, &s) }, E_SCALAR_MISMATCH),
        ("claim: taker's scalar a instead of b", Case { tail: [s.a, s.r].concat(), ..claim(&e, &s) }, E_SCALAR_MISMATCH),
        ("claim: zero scalar", Case { tail: [[0u8; 32], s.r].concat(), ..claim(&e, &s) }, E_SCALAR_ZERO),
        ("claim: non-canonical scalar (order + 1 against B = G)", Case { tail: [order_plus_one, unit.r].concat(), ..claim(&e, &unit) }, E_SCALAR_NON_CANONICAL),
        ("claim: non-canonical scalar (the order itself)", Case { tail: [curve.order(), s.r].concat(), ..claim(&e, &s) }, E_SCALAR_NON_CANONICAL),
        ("claim: non-canonical scalar (all ff)", Case { tail: [[0xff; 32], s.r].concat(), ..claim(&e, &s) }, E_SCALAR_NON_CANONICAL),
        ("claim: wrong release secret", Case { tail: [s.b, [7u8; 32]].concat(), ..claim(&e, &s) }, E_WRONG_RELEASE_SECRET),
        ("claim: output to a different lock", Case { outputs: vec![e.thief.clone()], ..claim(&e, &s) }, E_WRONG_OUTPUT_LOCK),
        ("claim: second output to a different lock", Case { outputs: vec![e.maker.clone(), e.thief.clone()], ..claim(&e, &s) }, E_WRONG_OUTPUT_LOCK),
        ("claim: output to the taker", Case { outputs: vec![e.taker.clone()], ..claim(&e, &s) }, E_WRONG_OUTPUT_LOCK),
        ("refund: before t1", Case { since: rel_blocks(99), ..refund(&e, &s) }, E_REFUND_TOO_EARLY),
        ("refund: since 0 (no timelock)", Case { since: 0, ..refund(&e, &s) }, E_SINCE_TYPE_MISMATCH),
        ("punish: before t2", Case { since: rel_blocks(199), ..punish(&e, &s) }, E_PUNISH_TOO_EARLY),
        ("punish: at t1 (refund window, not yet t2)", Case { since: T1, ..punish(&e, &s) }, E_PUNISH_TOO_EARLY),
        ("refund: output to the maker", Case { outputs: vec![e.maker.clone()], ..refund(&e, &s) }, E_WRONG_OUTPUT_LOCK),
        ("refund: output to a different lock", Case { outputs: vec![e.thief.clone()], ..refund(&e, &s) }, E_WRONG_OUTPUT_LOCK),
        ("claim: params not matching args", Case { params: tampered.clone(), outputs: vec![e.thief.clone()], ..claim(&e, &s) }, E_PARAMS_MISMATCH),
        ("refund: params not matching args", Case { params: tampered.clone(), ..refund(&e, &s) }, E_PARAMS_MISMATCH),
        ("punish: params not matching args", Case { params: tampered, outputs: vec![e.thief.clone()], ..punish(&e, &s) }, E_PARAMS_MISMATCH),
        // --- extra
        ("refund: wrong scalar (a + 1)", Case { tail: bump(curve, &s.a).to_vec(), ..refund(&e, &s) }, E_SCALAR_MISMATCH),
        ("refund: maker's scalar b instead of a", Case { tail: s.b.to_vec(), ..refund(&e, &s) }, E_SCALAR_MISMATCH),
        ("refund: zero scalar", Case { tail: vec![0u8; 32], ..refund(&e, &s) }, E_SCALAR_ZERO),
        ("refund: non-canonical scalar (order + 1 against A = G)", Case { tail: order_plus_one.to_vec(), ..refund(&e, &unit) }, E_SCALAR_NON_CANONICAL),
        ("punish: output to the taker", Case { outputs: vec![e.taker.clone()], ..punish(&e, &s) }, E_WRONG_OUTPUT_LOCK),
        ("refund: absolute since against relative t1", Case { since: 100, ..refund(&e, &s) }, E_SINCE_TYPE_MISMATCH),
        ("refund: relative since against absolute t1", Case { since: rel_blocks(100), ..refund(&e, &abs_t) }, E_SINCE_TYPE_MISMATCH),
        ("punish: relative timestamp since against relative block t2", Case { since: 0xc000_0000_0000_0000 | 200, ..punish(&e, &s) }, E_SINCE_TYPE_MISMATCH),
        ("unknown tag", Case { tag: 0, ..punish(&e, &s) }, E_BAD_TAG),
        ("unknown tag 4", Case { tag: 4, ..punish(&e, &s) }, E_BAD_TAG),
        ("unknown curve id (committed in args)", Case { args: ckbhash(&bad_curve)[..20].to_vec(), params: bad_curve, ..punish(&e, &s) }, E_BAD_CURVE),
        ("params one byte short (committed in args)", Case { args: ckbhash(&short)[..20].to_vec(), params: short, ..punish(&e, &s) }, E_BAD_PARAMS_LENGTH),
        ("args not 20 bytes", Case { args: ckbhash(&s.params).to_vec(), ..punish(&e, &s) }, E_BAD_ARGS),
        ("empty witness", Case { raw_witness: Some(Bytes::new()), ..punish(&e, &s) }, E_BAD_WITNESS),
        ("WitnessArgs without lock", Case { raw_witness: Some(WitnessArgs::new_builder().build().as_bytes()), ..punish(&e, &s) }, E_BAD_WITNESS),
        ("claim: witness too short for b | r", Case { params: vec![], tail: vec![1u8; 63], ..claim(&e, &s) }, E_BAD_WITNESS),
    ];
    for (name, c, want) in cases {
        let got = run(&mut e, &c).map(|_| ());
        println!("{}: {name}: {got:?}", curve.name());
        assert_eq!(got, Err(want), "{}: {name}", curve.name());
    }
    // The unit swap itself is spendable with the canonical scalar 1, so the order + 1 rejections above
    // are about the encoding, not about the keys. Known answer: 1*G == the base point from the spec.
    let c = claim(&e, &unit);
    run(&mut e, &c).expect("claim with b = 1 against the spec's base point");
    let c = refund(&e, &unit);
    run(&mut e, &c).expect("refund with a = 1 against the spec's base point");
}

#[test]
fn ed25519_rejections() {
    rejections(Curve::Ed25519);
}

#[test]
fn secp256k1_rejections() {
    rejections(Curve::Secp256k1);
}

/// Epoch-metric timeouts compare as number + index/length, not as raw integers.
#[test]
fn epoch_since() {
    let epoch = |number: u64, index: u64, length: u64| 0x2000_0000_0000_0000 | (length << 40) | (index << 24) | number;
    let mut e = env();
    let curve = Curve::Ed25519;
    let s0 = swap(&e, curve);
    let t1 = epoch(10, 1, 2); // epoch 10.5
    let s = Swap { params: params(0, &curve.public(&s0.b), &curve.public(&s0.a), &s0.r, &e, t1, epoch(20, 0, 1)), ..s0 };
    for (since, want) in [
        (epoch(10, 1, 2), Ok(())),
        (epoch(10, 900, 1800), Ok(())),               // same instant, different length
        (epoch(10, 3, 4), Ok(())),
        (epoch(11, 0, 1), Ok(())),
        (epoch(10, 899, 1800), Err(E_REFUND_TOO_EARLY)), // raw integer is larger than t1, time is earlier
        (epoch(9, 1799, 1800), Err(E_REFUND_TOO_EARLY)),
        (0x2000_0000_0000_0000 | 11, Ok(())),         // length 0 means the start of epoch 11
        (0x2000_0000_0000_0000 | 10, Err(E_REFUND_TOO_EARLY)),
    ] {
        let c = Case { since, ..refund(&e, &s) };
        assert_eq!(run(&mut e, &c).map(|_| ()), want, "since {since:#x}");
    }
}

// ---------------------------------------------------------------- the property the swap relies on

/// Ed25519: after the maker claims on CKB, the taker reads b from the witness and holds a + b, which is
/// the private scalar of the foreign address A + B (and can sign for it).
#[test]
fn ed25519_sum_scalar_controls_joint_key() {
    use curve25519_dalek::{edwards::CompressedEdwardsY, EdwardsPoint, Scalar};
    let mut e = env();
    let s = swap(&e, Curve::Ed25519);
    let c = claim(&e, &s);
    let tx = build(&mut e, &c);
    e.ctx.verify_tx(&tx, MAX_CYCLES).expect("claim accepted by the lock");

    // What the chain shows: params (with A and B) and b, inside WitnessArgs.lock.
    let wa = WitnessArgs::from_slice(&tx.witnesses().get(0).unwrap().raw_data()).unwrap();
    let w: Bytes = wa.lock().to_opt().unwrap().unpack();
    let (maker_pub, taker_pub) = (&w[2..34], &w[34..66]);
    let b_onchain: [u8; 32] = w[w.len() - 64..w.len() - 32].try_into().unwrap();

    let point = |bytes: &[u8]| CompressedEdwardsY::from_slice(bytes).unwrap().decompress().unwrap();
    let joint = point(taker_pub) + point(maker_pub);
    let a = Scalar::from_canonical_bytes(s.a).unwrap();
    let b = Scalar::from_canonical_bytes(b_onchain).unwrap();
    let sum = a + b;
    assert_eq!(EdwardsPoint::mul_base(&sum), joint, "(a + b)*G == A + B");
    assert_ne!(EdwardsPoint::mul_base(&a), joint);
    assert_ne!(EdwardsPoint::mul_base(&b), joint);

    // The sum scalar signs as the joint address (how a Solana/Cardano transfer is authorised).
    use ed25519_dalek::{hazmat::{raw_sign, ExpandedSecretKey}, Verifier, VerifyingKey};
    let vk = VerifyingKey::from_bytes(&joint.compress().to_bytes()).unwrap();
    let esk = ExpandedSecretKey { scalar: sum, hash_prefix: Sha256::digest(b"nonce prefix").into() };
    let msg = b"sweep the joint address";
    let sig = raw_sign::<sha2::Sha512>(&esk, msg, &vk);
    vk.verify(msg, &sig).expect("signature by a + b verifies under A + B");
    vk.verify_strict(msg, &sig).expect("strict verification too");
}

/// secp256k1 (libsecp256k1 on the host, k256 in the lock): same property.
#[test]
fn secp256k1_sum_scalar_controls_joint_key() {
    use secp256k1::{Message, PublicKey, Scalar, Secp256k1, SecretKey};
    let mut e = env();
    let s = swap(&e, Curve::Secp256k1);
    let c = claim(&e, &s);
    let tx = build(&mut e, &c);
    e.ctx.verify_tx(&tx, MAX_CYCLES).expect("claim accepted by the lock");

    let wa = WitnessArgs::from_slice(&tx.witnesses().get(0).unwrap().raw_data()).unwrap();
    let w: Bytes = wa.lock().to_opt().unwrap().unpack();
    let (maker_pub, taker_pub) = (&w[2..35], &w[35..68]);
    let b_onchain: [u8; 32] = w[w.len() - 64..w.len() - 32].try_into().unwrap();

    let secp = Secp256k1::new();
    let joint = PublicKey::from_slice(taker_pub).unwrap().combine(&PublicKey::from_slice(maker_pub).unwrap()).unwrap();
    let a = SecretKey::from_slice(&s.a).unwrap();
    let sum = a.add_tweak(&Scalar::from_be_bytes(b_onchain).unwrap()).unwrap();
    assert_eq!(PublicKey::from_secret_key(&secp, &sum), joint, "(a + b)*G == A + B");
    assert_ne!(PublicKey::from_secret_key(&secp, &a), joint);

    let msg = Message::from_digest(Sha256::digest(b"sweep the joint address").into());
    let sig = secp.sign_ecdsa(&msg, &sum);
    secp.verify_ecdsa(&msg, &sig, &joint).expect("ECDSA signature by a + b verifies under A + B");
}

// ---------------------------------------------------------------- capacity

#[test]
fn minimum_cell_capacity_is_61_ckb() {
    let mut e = env();
    let s = swap(&e, Curve::Ed25519);
    let args = ckbhash(&s.params)[..20].to_vec();
    let lock = e.ctx.build_script_with_hash_type(&e.code, ScriptHashType::Data2, args.into()).unwrap();
    let cell = CellOutput::new_builder().lock(lock).build();
    let occupied = cell.occupied_capacity(Capacity::zero()).unwrap().as_u64();
    println!("METRIC min_cell_capacity_shannons={occupied}");
    assert_eq!(occupied, 61 * CKB);
}

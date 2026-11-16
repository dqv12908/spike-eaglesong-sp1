//! Host for the Eaglesong-in-SP1 spike.
//!
//! Execute (cycle counts, fast):
//!   cargo run --release -- --execute --n 16
//!   cargo run --release -- --execute --n 16 --breakdown
//! Prove (timed):
//!   cargo run --release -- --prove --system core --n 1
//!   cargo run --release -- --prove --system groth16 --n 1
//! Bridge fixtures (scripts/fetch_deposit.py):
//!   --net testnet --segment fixtures/deposit-testnet.json   (kind 1: PoW segment to the anchor)
//!   --deposit fixtures/deposit-testnet.json                  (kind 2: deposit inclusion)
use std::{path::PathBuf, time::Instant};

use ckb_pow::{deposit, rpc, verify_segment_from, PowFunc, HEADER_LEN};
use clap::{Parser, ValueEnum};
use sp1_sdk::{
    blocking::{ProveRequest, Prover, ProverClient},
    include_elf, Elf, HashableKey, ProvingKey, SP1Stdin,
};

const ELF: Elf = include_elf!("ckb-pow-program");

#[derive(Copy, Clone, Debug, PartialEq, Eq, ValueEnum)]
enum System {
    Core,
    Compressed,
    Groth16,
    Plonk,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, ValueEnum)]
enum Net {
    Mainnet,
    Testnet,
}

#[derive(Parser, Debug)]
struct Args {
    #[arg(long)]
    execute: bool,
    #[arg(long)]
    prove: bool,
    /// Number of consecutive headers to verify.
    #[arg(long, default_value = "16")]
    n: usize,
    #[arg(long, value_enum, default_value = "core")]
    system: System,
    #[arg(long, value_enum, default_value = "mainnet")]
    net: Net,
    /// Per-component cycle breakdown (adds extra work; don't use for totals).
    #[arg(long)]
    breakdown: bool,
    /// Differential micro-benchmark mode (10 = baseline, 11..15 = one component per header).
    #[arg(long)]
    micro: Option<u8>,
    /// Prove the `segment` array of a deposit fixture instead of the benchmark headers.
    #[arg(long)]
    segment: Option<PathBuf>,
    /// Prove a deposit (kind 2) from a deposit fixture.
    #[arg(long)]
    deposit: Option<PathBuf>,
    /// Output proof file name (fixtures/proofs/<name>.json).
    #[arg(long)]
    name: Option<String>,
}

fn hexv(v: &serde_json::Value) -> Vec<u8> {
    hex::decode(v.as_str().expect("hex string").trim_start_matches("0x")).expect("hex")
}

/// Build stdin + expected public values for a deposit proof.
fn deposit_input(path: &PathBuf) -> (SP1Stdin, Vec<u8>, usize) {
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).expect("fixture")).unwrap();
    let headers: Vec<u8> = v["headers"].as_array().unwrap().iter().flat_map(rpc::header_bytes).collect();
    let raw = hexv(&v["raw_tx"]);
    let out_index = v["out_index"].as_u64().unwrap() as u32;
    let tree_index = v["tree_index"].as_u64().unwrap() as u32;
    let lemmas: Vec<[u8; 32]> = v["lemmas"].as_array().unwrap().iter().map(|x| hexv(x).try_into().unwrap()).collect();
    let wroot: [u8; 32] = hexv(&v["witnesses_root"]).try_into().unwrap();
    let e = deposit::verify_deposit(&headers, &raw, out_index, tree_index, &lemmas, wroot).expect("native deposit check");
    println!("deposit: block #{} anchor #{} capacity {} shannons, data_len {}", e.block_number, e.anchor_number, e.capacity, e.data_len);
    let n = headers.len() / HEADER_LEN;
    let mut stdin = SP1Stdin::new();
    stdin.write(&2u8);
    stdin.write_vec(headers);
    stdin.write_vec(raw);
    stdin.write(&out_index);
    stdin.write(&tree_index);
    stdin.write(&lemmas);
    stdin.write(&wroot);
    (stdin, e.to_bytes().to_vec(), n)
}

fn main() {
    sp1_sdk::utils::setup_logger();
    let args = Args::parse();
    assert!(args.execute != args.prove, "pass exactly one of --execute / --prove");

    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let (fixture, pow) = match args.net {
        Net::Mainnet => ("fixtures/mainnet_headers.json", PowFunc::Eaglesong),
        Net::Testnet => ("fixtures/testnet_headers.json", PowFunc::EaglesongBlake2b),
    };
    let (stdin, expected, n) = if let Some(p) = &args.deposit {
        deposit_input(p)
    } else {
        // Segments continue a known parent header (the light client's tip): the guest checks
        // its hash and the epoch / difficulty transition from it.
        let (parent, run) = match &args.segment {
            Some(p) => {
                let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).expect("fixture")).unwrap();
                (v["segment_parent"].clone(), v["segment"].as_array().expect("segment").clone())
            }
            None => {
                // benchmark fixture: first header of the run acts as the parent
                let run = rpc::load_fixture(&std::fs::read_to_string(root.join(fixture)).expect("fixture")).0;
                (run[0].clone(), run[1..].to_vec())
            }
        };
        let n = if args.segment.is_some() { run.len() } else { args.n };
        assert!(n >= 1 && n <= run.len(), "n must be 1..={}", run.len());
        let parent = rpc::header_bytes(&parent);
        let bytes: Vec<u8> = run[..n].iter().flat_map(rpc::header_bytes).collect();
        let summary = verify_segment_from(&parent, &bytes, pow).expect("native verification").to_bytes();
        let mut stdin = SP1Stdin::new();
        stdin.write(&args.micro.unwrap_or(args.breakdown as u8));
        stdin.write(&pow.id());
        if args.micro.is_none() {
            stdin.write_vec(parent.to_vec());
        }
        stdin.write_vec(bytes);
        (stdin, deposit::segment_public_values(pow.id(), &summary).to_vec(), n)
    };
    let kind = if args.deposit.is_some() { "deposit" } else { "segment" };

    let client = ProverClient::from_env();
    println!("kind={kind} net={:?} n={n} headers", args.net);

    if args.execute {
        let t = Instant::now();
        let (output, report) = client.execute(ELF, stdin).run().expect("execution failed");
        let dt = t.elapsed();
        if let Some(m) = args.micro {
            let c = report.total_instruction_count();
            println!("micro mode={m} n={n} total cycles: {c}");
            return;
        }
        assert_eq!(output.as_slice(), &expected[..], "guest/native summary mismatch");
        let cycles = report.total_instruction_count();
        println!("public values match native: OK ({} bytes)", output.as_slice().len());
        println!("total cycles: {cycles}");
        println!("cycles/header: {}", cycles / n as u64);
        println!("execute wall time: {dt:?}");
        println!("report: {report}");
        return;
    }

    let t = Instant::now();
    let pk = client.setup(ELF).expect("setup");
    println!("setup: {:?}", t.elapsed());
    println!("program vkey: {}", pk.verifying_key().bytes32());

    let t = Instant::now();
    let req = client.prove(&pk, stdin);
    let proof = match args.system {
        System::Core => req.run(),
        System::Compressed => req.compressed().run(),
        System::Groth16 => req.groth16().run(),
        System::Plonk => req.plonk().run(),
    }
    .expect("prove");
    let prove_time = t.elapsed();
    assert_eq!(proof.public_values.as_slice(), &expected[..]);

    let t = Instant::now();
    client.verify(&proof, pk.verifying_key(), None).expect("verify");
    println!("kind={kind} system={:?} n={n} prove={prove_time:?} verify={:?}", args.system, t.elapsed());

    if matches!(args.system, System::Groth16 | System::Plonk) {
        let out = root.join("fixtures/proofs");
        std::fs::create_dir_all(&out).unwrap();
        let name = match &args.name {
            Some(x) => format!("{x}.json"),
            None => format!("{:?}-{:?}-{kind}-n{n}.json", args.system, args.net).to_lowercase(),
        };
        let fx = serde_json::json!({
            "system": format!("{:?}", args.system),
            "net": format!("{:?}", args.net),
            "kind": kind,
            "n_headers": n,
            "vkey": pk.verifying_key().bytes32(),
            "public_values": format!("0x{}", hex::encode(proof.public_values.as_slice())),
            "proof": format!("0x{}", hex::encode(proof.bytes())),
            "prove_seconds": prove_time.as_secs_f64(),
        });
        std::fs::write(out.join(&name), serde_json::to_string_pretty(&fx).unwrap()).unwrap();
        println!("proof bytes: {} -> fixtures/proofs/{name}", proof.bytes().len());
    }
    let _ = HEADER_LEN;
}

// Verify an SP1 Groth16 proof of CKB headers against Succinct's deployed SP1VerifierGateway on
// Sepolia, using a read-only eth_call (no gas, no private key).
//
// Usage: node scripts/verify-sepolia.mjs fixtures/proofs/groth16-mainnet-n16.json [path/to/.env]
// Reads only ETH_SEPOLIA_RPC from the .env (default E:/ckbuilder/testnet/.env).
import { readFileSync } from "node:fs";

// SP1_VERIFIER_GATEWAY_GROTH16 on Sepolia (11155111), from
// https://github.com/succinctlabs/sp1-contracts/blob/main/contracts/deployments/11155111.json
const GATEWAY = "0x397A5f7f3dBd538f23DE225B51f532c34448dA9B";
const SELECTOR = "41493c60"; // keccak256("verifyProof(bytes32,bytes,bytes)")[:4]

const [, , fixturePath, envPath = "E:/ckbuilder/testnet/.env"] = process.argv;
if (!fixturePath) throw new Error("usage: verify-sepolia.mjs <proof-fixture.json> [.env]");

function readEnvVar(path, name) {
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, "");
  }
  throw new Error(`${name} not found in ${path}`);
}

const strip = (h) => h.replace(/^0x/, "");
const word = (n) => n.toString(16).padStart(64, "0");
const padRight = (hex) => hex + "0".repeat((64 - (hex.length % 64)) % 64);

// ABI-encode verifyProof(bytes32 programVKey, bytes publicValues, bytes proofBytes)
function encode(vkey, publicValues, proof) {
  const pv = strip(publicValues), pf = strip(proof);
  const head = [strip(vkey).padStart(64, "0"), word(3 * 32), word(3 * 32 + 32 + padRight(pv).length / 2)];
  const tail = [word(pv.length / 2), padRight(pv), word(pf.length / 2), padRight(pf)];
  return "0x" + SELECTOR + head.join("") + tail.join("");
}

async function rpcCall(rpc, method, params) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}
const ethCall = (rpc, data) => rpcCall(rpc, "eth_call", [{ to: GATEWAY, data }, "latest"]);

const fx = JSON.parse(readFileSync(fixturePath, "utf8"));
const rpc = readEnvVar(envPath, "ETH_SEPOLIA_RPC");
console.log(`fixture: ${fixturePath} (${fx.n_headers} CKB ${fx.net} headers, ${strip(fx.proof).length / 2}-byte proof)`);
console.log(`program vkey: ${fx.vkey}`);

const ok = await ethCall(rpc, encode(fx.vkey, fx.public_values, fx.proof));
const valid = !ok.error;
console.log(`genuine proof      -> ${valid ? "VERIFIED by SP1VerifierGateway" : "REVERTED: " + JSON.stringify(ok.error)}`);
if (valid) {
  const g = await rpcCall(rpc, "eth_estimateGas", [{ to: GATEWAY, data: encode(fx.vkey, fx.public_values, fx.proof) }]);
  if (g.result) console.log(`estimated gas (incl. 21k base + calldata): ${parseInt(g.result, 16)}`);
}

// Negative control: flip one byte of the committed public values (e.g. last block hash).
const pv = strip(fx.public_values);
const flipped = pv.slice(0, 100) + ((parseInt(pv.slice(100, 102), 16) ^ 1).toString(16).padStart(2, "0")) + pv.slice(102);
const bad = await ethCall(rpc, encode(fx.vkey, "0x" + flipped, fx.proof));
console.log(`tampered pub value -> ${bad.error ? "REVERTED (expected)" : "UNEXPECTEDLY ACCEPTED"}`);

process.exit(valid && bad.error ? 0 : 1);

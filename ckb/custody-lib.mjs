// Shared helpers for the CKB custody tools (no side effects on import).
import { readFileSync, existsSync } from "node:fs";
import { ccc } from "@ckb-ccc/core";
import { ed25519 } from "@noble/curves/ed25519.js";

export const ATTESTERS = new URL("./attesters.local.json", import.meta.url);
export const DOMAIN = new TextEncoder().encode("CKB-SOL-UNLOCK-V1");
export const VAULT_MAGIC = new TextEncoder().encode("CKBSOLV1");
export const u64le = (x) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(x), true); return b; };
export const cat = (...xs) => ccc.bytesConcat(...xs.map((x) => ccc.bytesFrom(x)));

export const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58decode(s) {
  let n = 0n;
  for (const c of s) { const v = B58.indexOf(c); if (v < 0) throw new Error("bad base58"); n = n * 58n + BigInt(v); }
  const out = [];
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c !== "1") break; out.unshift(0); }
  return Uint8Array.from(out);
}

/** The message attesters sign for burn #seq (must match ckb-custody/src/main.rs). */
export function unlockMessage(bridgeId, vaultTypeHash, seq, amount, recipientLockHash) {
  return ccc.bytesFrom(ccc.hashCkb(cat(DOMAIN, bridgeId, vaultTypeHash, u64le(seq), u64le(amount), recipientLockHash)));
}
export function vaultData(seq) { return ccc.hexFrom(cat(VAULT_MAGIC, u64le(seq))); }

export function attesterKeys() {
  const a = existsSync(ATTESTERS) ? JSON.parse(readFileSync(ATTESTERS, "utf8")) : null;
  if (!a) throw new Error("no attesters.local.json (run: node custody.mjs keys)");
  return { m: a.m, seeds: a.seeds.map((s) => ccc.bytesFrom(s)), pubkeys: a.seeds.map((s) => ed25519.getPublicKey(ccc.bytesFrom(s))) };
}

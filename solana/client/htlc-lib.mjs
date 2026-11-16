// Client helpers for the Solana HTLC escrow (solana/htlc): instruction builders, escrow decoding,
// and preimage extraction from a claim transaction. Shared by htlc-test.mjs and the LP daemon.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

// Re-exported so scripts outside solana/client (lnroute/) don't need their own node_modules.
export { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

export const ESCROW_LEN = 128;
export const MAGIC = "SOLHTLC1";
export const ERR = { BadInstruction: 1, WrongPda: 2, NotSigner: 3, BadEscrow: 4, WrongPreimage: 5, Expired: 6, NotExpired: 7, WrongClaimer: 8, WrongOfferer: 9, ZeroAmount: 10, BadExpiry: 11 };

export const sha256 = (b) => createHash("sha256").update(b).digest();
export const hexb = (h) => Buffer.from(h.replace(/^0x/, ""), "hex");

export function loadKeypair(spec) {
  if (spec.startsWith("env:")) {
    for (const line of readFileSync(spec.slice(4), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*SOL_PRIVKEY\s*=\s*(.*)\s*$/);
      if (m) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(m[1].replace(/^["']|["']$/g, ""))));
    }
    throw new Error("SOL_PRIVKEY not found");
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(spec, "utf8"))));
}

export const escrowPda = (programId, offerer, hash) =>
  PublicKey.findProgramAddressSync([Buffer.from("htlc"), offerer.toBuffer(), hash], programId)[0];

export function lockIx(programId, { offerer, hash, claimer, amount, expiry }) {
  const d = Buffer.alloc(81);
  d[0] = 0; hash.copy(d, 1); claimer.toBuffer().copy(d, 33); d.writeBigUInt64LE(BigInt(amount), 65); d.writeBigInt64LE(BigInt(expiry), 73);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: offerer, isSigner: true, isWritable: true },
      { pubkey: escrowPda(programId, offerer, hash), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: d,
  });
}

export function claimIx(programId, { escrow, claimer, offerer, preimage }) {
  return new TransactionInstruction({
    programId,
    keys: [escrow, claimer, offerer].map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    data: Buffer.concat([Buffer.from([1]), preimage]),
  });
}

export function refundIx(programId, { escrow, offerer }) {
  return new TransactionInstruction({
    programId,
    keys: [escrow, offerer].map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    data: Buffer.from([2]),
  });
}

// Claimer waives its claim before expiry (must sign): the SOL returns to the offerer at once.
export function cancelIx(programId, { escrow, offerer, claimer }) {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: offerer, isSigner: false, isWritable: true },
      { pubkey: claimer, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([3]),
  });
}

export function decodeEscrow(data) {
  if (!data || data.length < ESCROW_LEN || data.subarray(0, 8).toString() !== MAGIC) return null;
  return {
    hash: data.subarray(8, 40), offerer: new PublicKey(data.subarray(40, 72)), claimer: new PublicKey(data.subarray(72, 104)),
    amount: data.readBigUInt64LE(104), expiry: Number(data.readBigInt64LE(112)),
  };
}

// Find a successful Claim on `escrow` and return its preimage (checked against `hash`).
// Reads the instruction data, not logs, so it works with any RPC that serves transactions.
export async function findClaimPreimage(conn, programId, escrow, hash, commitment = "confirmed") {
  const sigs = await conn.getSignaturesForAddress(escrow, { limit: 20 }, commitment);
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await conn.getTransaction(s.signature, { commitment, maxSupportedTransactionVersion: 0 });
    if (!tx || tx.meta?.err) continue;
    const msg = tx.transaction.message;
    const keys = msg.staticAccountKeys ?? msg.accountKeys;
    for (const ix of msg.compiledInstructions ?? msg.instructions) {
      if (!keys[ix.programIdIndex].equals(programId)) continue;
      const data = Buffer.from(ix.data instanceof Uint8Array ? ix.data : (await import("bs58")).default.decode(ix.data));
      if (data[0] !== 1 || data.length !== 33) continue;
      const pre = data.subarray(1);
      if (sha256(pre).equals(hash)) return { preimage: pre, signature: s.signature };
    }
  }
  return null;
}

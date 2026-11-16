// SHA-256 hash time-locked validators for the CKB (Fiber) <-> ADA swap leg.
//
// `htlc_sha256` is cardano-scaling/htlc `htlc/validators/htlc.ak` at commit
// 393893f0b4df4e37079b8b6ecb9f930e17b6344c with ONE change: `blake2b_256` -> `sha2_256`
// (Fiber and Lightning lock payments with SHA-256). Same datum, same redeemer,
// same compiler (Aiken v1.1.19), same stdlib (v2.2.0) and vodka (0.1.16) versions.
//
//   Claim(preimage): sha2_256(preimage) == hash
//                    AND tx upper validity bound <= timeout   (tx cannot be included at or after `timeout`)
//                    AND signed by `receiver`
//   Refund:          tx lower validity bound > timeout
//                    AND signed by `sender`
//
// `htlc_sha256_len32` additionally requires the preimage to be exactly 32 bytes.
// A Fiber/Lightning preimage is always 32 bytes; without the length check a secret
// holder could lock with H = sha2_256(a 64-byte string), claim the ADA with it, and leave
// the counterparty with a preimage the payment channel will not accept.
use aiken/builtin.{length_of_bytearray, sha2_256}
use aiken/crypto.{VerificationKeyHash}
use cardano/transaction.{OutputReference, Transaction}
use cocktail/vodka_extra_signatories.{key_signed}
use cocktail/vodka_validity_range.{valid_after, valid_before}

pub type Datum {
  hash: ByteArray,
  timeout: Int,
  sender: VerificationKeyHash,
  receiver: VerificationKeyHash,
}

pub type Redeemer {
  Claim(ByteArray)
  Refund
}

validator htlc_sha256 {
  spend(
    datum_opt: Option<Datum>,
    redeemer: Redeemer,
    _input: OutputReference,
    tx: Transaction,
  ) {
    expect Some(datum) = datum_opt

    when redeemer is {
      Claim(preimage) ->
        sha2_256(preimage) == datum.hash && valid_before(
          tx.validity_range,
          datum.timeout,
        ) && key_signed(tx.extra_signatories, datum.receiver)
      Refund ->
        valid_after(tx.validity_range, datum.timeout) && key_signed(
          tx.extra_signatories,
          datum.sender,
        )
    }
  }

  else(_) {
    fail
  }
}

validator htlc_sha256_len32 {
  spend(
    datum_opt: Option<Datum>,
    redeemer: Redeemer,
    _input: OutputReference,
    tx: Transaction,
  ) {
    expect Some(datum) = datum_opt

    when redeemer is {
      Claim(preimage) ->
        length_of_bytearray(preimage) == 32 && sha2_256(preimage) == datum.hash && valid_before(
          tx.validity_range,
          datum.timeout,
        ) && key_signed(tx.extra_signatories, datum.receiver)
      Refund ->
        valid_after(tx.validity_range, datum.timeout) && key_signed(
          tx.extra_signatories,
          datum.sender,
        )
    }
  }

  else(_) {
    fail
  }
}

// Creates (once) a preprod test wallet in wallet.local.json (ignored by git) and prints ONLY its address and balance.
//   node wallet.mjs
// The seed phrase is never printed. Account 0 is the address to fund; the other roles (taker, sponsor) are
// further accounts under the same seed and are topped up from account 0 by measure.mjs.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateSeedPhrase, walletFromSeed, Koios } from "@lucid-evolution/lucid";
import { WALLET_FILE, KOIOS_PREPROD, ada } from "./lib.mjs";

if (!existsSync(WALLET_FILE)) {
  const seedPhrase = generateSeedPhrase();
  const address = walletFromSeed(seedPhrase, { accountIndex: 0, addressType: "Base", network: "Preprod" }).address;
  writeFileSync(WALLET_FILE, JSON.stringify({ note: "Cardano PREPROD test wallet for cardano/measure.mjs. Test funds only.", network: "preprod", created_utc: new Date().toISOString(), address, seedPhrase }, null, 1));
  console.log("created wallet.local.json");
}
const { address } = JSON.parse(readFileSync(WALLET_FILE, "utf8"));
console.log(`preprod address: ${address}`);
try {
  const utxos = await new Koios(KOIOS_PREPROD).getUtxos(address);
  const lovelace = utxos.reduce((s, u) => s + u.assets.lovelace, 0n);
  console.log(`balance: ${ada(lovelace)} test ADA in ${utxos.length} UTxO(s)`);
  if (lovelace < 100_000_000n) console.log("needs at least 100 test ADA for: node measure.mjs --network preprod   (faucet: https://docs.cardano.org/cardano-testnets/tools/faucet , choose Preprod)");
} catch (e) { console.log(`could not read the balance from Koios: ${String(e?.message ?? e).slice(0, 200)}`); }

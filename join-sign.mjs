#!/usr/bin/env node
// RESET pool — member-side AI-join receipt signing helper.
//
// Flow (see goals/reset-2/files/AI签名入池方案.md):
//   1. Issue a join code (you, or any agent acting for you):
//        curl -X POST https://reset-pool-registry.tyrodcamp.workers.dev/join/code \
//          -H 'content-type: application/json' -d '{"address": "<your address>", "planned_units": "5000000"}'
//      The response contains a `code` object with a copy-paste text block.
//   2. Give the WHOLE code block to your own AI. The block's instructions
//      are hard rules: read the pool address + exact amount back to you
//      and wait for your nod; transfer EXACTLY that amount (digit for
//      digit) to the pool address; if your wallet holds no TNK for the
//      0.03 TNK fee, STOP and report — never split or alter the amount.
//   3. After the gateway accepts the transfer, sign the receipt with YOUR
//      signer wallet (this script — it uses the official signer keystore
//      code, so the signature is exactly what the registry verifies):
//        RESET_SIGNER_DIRECTORY=~/.reset-signer RESET_SIGNER_PASSWORD=... \
//          node join-sign.mjs code.json > submission.json
//      (code.json may be the bare code object or the whole /join/code
//      response; the password is read from the environment only and is
//      never printed.)
//   4. Submit (any agent can carry this step — the submission is
//      worthless without your signature, which is already inside it):
//        curl -X POST https://reset-pool-registry.tyrodcamp.workers.dev/join/claim \
//          -H 'content-type: application/json' -d @submission.json
//      A verified receipt registers a PENDING claim; the pool credits it
//      when (and only when) an inflow of exactly the code's amount
//      actually lands. A fabricated receipt can at worst park a rejected
//      row — it moves no money and no ledger entry.
//
// Refusals (this script NEVER signs blind):
//   - the code's address is not this wallet's own address;
//   - the code's exact amount is not planned + this address's fingerprint
//     (recomputed locally — a tampered code that names a different amount
//     is refused on the spot);
//   - the code's planned amount is not a positive multiple of 0.001.
import { readFileSync } from 'node:fs';
import { unlock, wipeWallet, publicAddress } from '../reset/signer/lib/keystore.mjs';
import { buildJoinPrepared, joinExactFor } from './lib/join.mjs';
import { agentSigningText } from './lib/exit.mjs';

const file = process.argv[2];
if (!file) { console.error('usage: node join-sign.mjs <code.json | ->'); process.exit(2); }
const raw = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
const doc = JSON.parse(raw);
const code = doc?.code ?? doc;
if (!code || typeof code.nonce !== 'string' || typeof code.address_hex !== 'string' ||
    typeof code.exact_units !== 'string' || typeof code.pool_address !== 'string') {
  console.error('input does not contain a join code object (see POST /join/code)'); process.exit(2);
}
const directory = process.env.RESET_SIGNER_DIRECTORY;
const password = process.env.RESET_SIGNER_PASSWORD;
if (!password) { console.error('RESET_SIGNER_PASSWORD is required (read from the environment only)'); process.exit(2); }
const wallet = await unlock({ directory, password });
try {
  const me = publicAddress(wallet);
  if (me !== code.address_hex) {
    console.error(`refusing to sign: this wallet is ${me}, but the join code is for ${code.address_hex}`);
    process.exit(1);
  }
  let exact;
  try { exact = joinExactFor(code.address_hex, code.planned_units); }
  catch (e) { console.error(`refusing to sign: bad planned amount in code: ${e.message}`); process.exit(1); }
  if (exact.toString() !== code.exact_units) {
    console.error(`refusing to sign: code exact ${code.exact_units} != planned ${code.planned_units} + fingerprint ${exact - BigInt(code.planned_units)} — the code was tampered with or miscomputed`);
    process.exit(1);
  }
  const prepared = buildJoinPrepared({ poolAddress: code.pool_address, address: code.address_hex,
    exactUnits: code.exact_units, nonce: code.nonce, ts: Date.now() });
  const signature = Buffer.from(wallet.sign(Buffer.from(agentSigningText(prepared), 'utf8'))).toString('hex');
  console.log(JSON.stringify({ prepared, signature, nonce: prepared.nonce }, null, 2));
} finally { wipeWallet(wallet); }

#!/usr/bin/env node
// RESET pool — member-side exit signing helper.
//
// Usage:
//   1. File an exit intent (you, or any agent acting for you):
//        curl -X POST https://reset-pool-registry.tyrodcamp.workers.dev/exit \
//          -H 'content-type: application/json' -d '{"address": "<your address>"}'
//      The response contains a `prepared` message object.
//   2. Sign it with YOUR signer wallet (this script — it uses the official
//      signer keystore code, so the signature is exactly what any RESET
//      node would verify):
//        RESET_SIGNER_DIRECTORY=~/.reset-signer RESET_SIGNER_PASSWORD=... \
//          node exit-sign.mjs prepared.json > submission.json
//      (prepared.json may be the bare prepared object or the whole /exit
//      response; the password is read from the environment only and is
//      never printed.)
//   3. Submit (any agent can carry this step — the submission is worthless
//      without your signature, which is already inside it):
//        curl -X POST https://reset-pool-registry.tyrodcamp.workers.dev/exit/verify \
//          -H 'content-type: application/json' -d @submission.json
//
// Signing is free and needs no balance — your coins sit in the pool, your
// key is all you need. The pool pays out ONLY to the address in the
// prepared message (which is also the ledger's address for your
// position); this script refuses to sign a prepared message whose addr
// is not your wallet's own address.
import { readFileSync } from 'node:fs';
import { unlock, wipeWallet, publicAddress } from '../reset/signer/lib/keystore.mjs';
import { agentSigningText } from './lib/exit.mjs';

const file = process.argv[2];
if (!file) { console.error('usage: node exit-sign.mjs <prepared.json | ->'); process.exit(2); }
const raw = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
const doc = JSON.parse(raw);
const prepared = doc?.prepared ?? doc?.exit?.prepared ?? doc;
if (!prepared || prepared.v !== 1 || prepared.kind !== 'agent' || typeof prepared.addr !== 'string') {
  console.error('input does not contain a prepared exit message (see POST /exit)'); process.exit(2);
}
const directory = process.env.RESET_SIGNER_DIRECTORY;
const password = process.env.RESET_SIGNER_PASSWORD;
if (!password) { console.error('RESET_SIGNER_PASSWORD is required (read from the environment only)'); process.exit(2); }
const wallet = await unlock({ directory, password });
try {
  const me = publicAddress(wallet);
  if (me !== prepared.addr) {
    console.error(`refusing to sign: this wallet is ${me}, but the prepared message is for ${prepared.addr}`);
    process.exit(1);
  }
  const signature = Buffer.from(wallet.sign(Buffer.from(agentSigningText(prepared), 'utf8'))).toString('hex');
  console.log(JSON.stringify({ prepared, signature, nonce: prepared.nonce }, null, 2));
} finally { wipeWallet(wallet); }

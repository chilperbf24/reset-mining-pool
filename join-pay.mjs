#!/usr/bin/env node
// RESET pool — ATOMIC transfer+receipt script for the AI-signed join.
//
// This is the ONLY sanctioned way to execute a join code (see rule 5
// in the code block). Transfer and receipt signing are ONE command
// with ONE output: the AI gets the "transfer complete" result only
// together with the signed receipt, so "transferred but no receipt"
// cannot happen through this script — the two steps cannot be split.
//
//   node join-pay.mjs code.json --confirmed
//     RESET_SIGNER_DIRECTORY=~/.reset-signer RESET_SIGNER_PASSWORD=... \
//     RESET_GATEWAY_URL=https://reset.openmayhem.ai (default: official gateway)
//
// The read-back block is printed to stderr FIRST; the script proceeds
// only with --confirmed, which the AI passes after the owner nods at
// that read-back. Without --confirmed it prints the read-back and stops
// — no transfer is attempted.
//
// Enforcement boundary (do not over-claim this script):
//   - INSIDE this script the force is real: no receipt exists without
//     an accepted transfer, and no success output exists without both.
//   - OUTSIDE it, force is impossible: a member who transfers with
//     their own signer instead of this script cannot be blocked or
//     refunded by the platform — the landed money stays in the pool
//     and MUST be credited through the old attribution paths (never
//     "no receipt, no credit"). The late-receipt backstop below covers
//     exactly that case.
//   - The member-pastes-receipt step is INTENTIONAL (the user requires
//     the member to carry the receipt back to the platform): this
//     script does NOT POST the receipt anywhere.
//
// Failure semantics (read before wiring this into an agent):
//   - transfer rejected -> non-zero exit, no receipt, no success output.
//   - transfer outcome unknown -> non-zero exit, no receipt, and NO
//     retry: an unknown outcome may already be accepted gateway-side.
//   - transfer ACCEPTED but receipt signing failed -> non-zero exit,
//     NO success output, and a late-receipt guidance block: the money
//     is not lost; re-run join-sign.mjs with the SAME code file to
//     produce the receipt, then submit it — a parked inflow credits
//     via ai-join retro on the next matcher pass. NEVER re-transfer.
//
// Test seam: runJoinPay is exported so tests can inject a mock
// transfer and a throwing signer without touching the gateway.
// --transfer-impl <module> (CLI only) loads a mock transfer module
// for sandbox runs; it is never a production path.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { unlock, wipeWallet, publicAddress } from '../reset/signer/lib/keystore.mjs';
import { buildJoinPrepared, joinExactFor } from './lib/join.mjs';
import { agentSigningText } from './lib/exit.mjs';
import { executeJoinTransfer, DEFAULT_GATEWAY_URL } from './lib/join-transfer.mjs';

const fmt = u => `${(BigInt(u) / 100000000n).toString()}.${(BigInt(u) % 100000000n).toString().padStart(8, '0')}`;

export function parseJoinCode(doc) {
  const code = doc?.code ?? doc;
  if (!code || typeof code.nonce !== 'string' || typeof code.address_hex !== 'string' ||
      typeof code.exact_units !== 'string' || typeof code.pool_address !== 'string') {
    throw new Error('input does not contain a join code object (see POST /join/code)');
  }
  return code;
}

export function readbackBlock(code) {
  return [
    `READ BACK — confirm with your owner BEFORE transferring:`,
    `  Pool (recipient): ${code.pool_address}`,
    `  Member:           ${code.address_hex}`,
    `  Transfer EXACTLY: ${fmt(code.exact_units)} RESET (${code.exact_units} units)`,
    `  Code nonce:       ${code.nonce}`,
    `  Transfer fee:     0.03 TNK from the member wallet (no TNK -> STOP and report).`,
  ].join('\n');
}

const defaultSign = (wallet, prepared) =>
  Buffer.from(wallet.sign(Buffer.from(agentSigningText(prepared), 'utf8'))).toString('hex');

export async function runJoinPay({ code, wallet, transfer = executeJoinTransfer,
  sign = defaultSign, confirm = false, gatewayUrl = DEFAULT_GATEWAY_URL, err = () => {} }) {
  const me = publicAddress(wallet);
  if (me !== code.address_hex) {
    throw new Error(`refusing to pay: this wallet is ${me}, but the join code is for ${code.address_hex}`);
  }
  let exact;
  try { exact = joinExactFor(code.address_hex, code.planned_units); }
  catch (e) { throw new Error(`refusing to pay: bad planned amount in code: ${e.message}`); }
  if (exact.toString() !== code.exact_units) {
    throw new Error(`refusing to pay: code exact ${code.exact_units} != planned ${code.planned_units} + fingerprint ${exact - BigInt(code.planned_units)} — the code was tampered with or miscomputed`);
  }
  err(readbackBlock(code));
  if (!confirm) {
    throw new Error('owner confirmation required: show the read-back above, wait for the owner nod, then re-run with --confirmed');
  }
  const res = await transfer({ wallet, to: code.pool_address, amountUnits: code.exact_units, gatewayUrl });
  if (!res || res.accepted !== true) {
    const outcome = res?.outcome ?? 'unknown';
    if (outcome === 'unknown') {
      throw new Error(`transfer outcome UNKNOWN (tx ${res?.tx ?? 'n/a'}) — do NOT retry blindly: check gateway status and settlement first; the transfer may already be accepted`);
    }
    throw new Error(`transfer REJECTED by the gateway${res?.error ? `: ${res.error}` : ''} — no receipt produced, nothing to submit`);
  }
  const prepared = buildJoinPrepared({ poolAddress: code.pool_address, address: code.address_hex,
    exactUnits: code.exact_units, nonce: code.nonce, ts: Date.now() });
  let signature;
  try { signature = sign(wallet, prepared); }
  catch (e) {
    const late = new Error(`TRANSFER ACCEPTED (tx ${res.tx}) but receipt signing failed (${e.message}) — the money is NOT lost and you must NOT re-transfer. ` +
      `Produce the receipt later with the SAME code file: node join-sign.mjs <code.json>, then submit it to POST /join/claim. ` +
      `If the inflow already parked as unclaimed, the next matcher pass credits it via ai-join retro once the receipt is filed.`);
    late.transferAccepted = true;
    throw late;
  }
  return {
    transfer: { to: code.pool_address, amount_units: code.exact_units, outcome: 'accepted', tx: res.tx, nonce: res.nonce },
    receipt: { prepared, signature, nonce: prepared.nonce },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  const confirmed = args.includes('--confirmed');
  const implIdx = args.indexOf('--transfer-impl');
  const implPath = implIdx >= 0 ? args[implIdx + 1] : null;
  if (!file || (implIdx >= 0 && !implPath)) {
    console.error('usage: node join-pay.mjs <code.json | -> [--confirmed] [--transfer-impl <module>]');
    process.exit(2);
  }
  const raw = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
  let code;
  try { code = parseJoinCode(JSON.parse(raw)); }
  catch (e) { console.error(`join-pay: ${e.message}`); process.exit(2); }
  const directory = process.env.RESET_SIGNER_DIRECTORY;
  const password = process.env.RESET_SIGNER_PASSWORD;
  if (!password) { console.error('RESET_SIGNER_PASSWORD is required (read from the environment only)'); process.exit(2); }
  let transfer = executeJoinTransfer;
  if (implPath) {
    const mod = await import(pathToFileURL(implPath).href);
    if (typeof mod.executeJoinTransfer !== 'function') {
      console.error('--transfer-impl module must export executeJoinTransfer'); process.exit(2);
    }
    transfer = mod.executeJoinTransfer;
  }
  const wallet = await unlock({ directory, password });
  try {
    const out = await runJoinPay({ code, wallet, transfer,
      gatewayUrl: process.env.RESET_GATEWAY_URL ?? DEFAULT_GATEWAY_URL,
      confirm: confirmed, err: m => console.error(m) });
    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    console.error(`join-pay: FAILED: ${e.message}`);
    process.exit(1);
  } finally { wipeWallet(wallet); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

#!/usr/bin/env node
// Claim a parked (unclaimed) pool inflow with nothing but the address it
// belongs to:
//   node claim-unclaimed.mjs <entry-id | amount-units> <reset-address>
//   node claim-unclaimed.mjs list
// The claim check is the fingerprint itself: the entry amount's tail must
// equal fp(address) — an amount constructed for that address. No GitHub
// account, no signature, no operator discretion: the math either matches
// or it doesn't. (A round amount has tail 0 and can never match anyone.)
// Runs under the shared .worker.lock flock (re-execs itself if needed) so
// it can never race the 1-minute matcher or the pool worker.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { PATHS, loadStates } from './lib/fprun.mjs';
import { claimEntry, splitTail } from './lib/fpmatch.mjs';
import { formatCoin } from './lib/pool.mjs';

const LOCK = `${new URL('.', import.meta.url).pathname.replace(/\/$/, '')}/.worker.lock`;
if (!process.env.FP_FLOCKED) {
  const r = spawnSync('flock', ['-w', '60', LOCK, process.execPath, new URL(import.meta.url).pathname, ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, FP_FLOCKED: '1' } });
  process.exit(r.status ?? 1);
}

const [ref, address] = process.argv.slice(2);
const states = loadStates();

if (ref === 'list' || ref === undefined) {
  const open = states.unclaimed.entries.filter(e => e.status === 'open');
  console.log(JSON.stringify({ ok: true, open: open.map(e => ({ id: e.id, amount: formatCoin(BigInt(e.amount_units)),
    amount_units: e.amount_units, tail_units: e.tail_units, kind: e.kind, detected_at: e.detected_at })) }, null, 2));
  process.exit(0);
}
if (!address) { console.error('usage: claim-unclaimed.mjs <entry-id | amount-units> <reset-address>'); process.exit(2); }

try {
  const entry = claimEntry({ unclaimed: states.unclaimed, ledger: states.ledger }, ref, address.toLowerCase());
  writeFileSync(PATHS.unclaimed, JSON.stringify(states.unclaimed, null, 2));
  writeFileSync(PATHS.ledger, JSON.stringify(states.ledger, null, 2));
  console.log(JSON.stringify({ ok: true, claimed: { entry_id: entry.id, amount: formatCoin(BigInt(entry.amount_units)),
    tail_units: entry.tail_units, address } }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
  process.exit(1);
}

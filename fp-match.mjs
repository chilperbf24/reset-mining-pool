#!/usr/bin/env node
// RESET pool — 1-minute fingerprint matcher (systemd timer service).
// Read-only: it watches the pool address on the public gateway, attributes
// new inflows to senders by their address fingerprint (lib/fpmatch.mjs),
// credits matched contributions into the ledger and parks the rest as
// unclaimed. It NEVER talks to the signer and has no lock/claim/transfer
// code path — mining moves stay with pool-worker.mjs (10-minute cron).
//
// Mutual exclusion: the systemd unit runs this under
//   flock /home/hatch/workspace/reset-pool/.worker.lock
// the same lock the pool worker's cron uses, and both share the baseline in
// state/matcher.json — an inflow is credited exactly once.
import { appendFileSync } from 'node:fs';
import { PATHS, loadStates, runFingerprintPass, gatewayPoolPosition } from './lib/fprun.mjs';

const log = obj => { try { appendFileSync(PATHS.log, JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n'); } catch {} };

try {
  const { ledger } = loadStates();
  const pos = await gatewayPoolPosition(ledger.pool_address);
  if (!pos) {
    log({ event: 'fp_match_failed', reason: 'gateway unreachable' });
    console.log(JSON.stringify({ ok: false, error: 'gateway unreachable' }));
    process.exit(0); // transient: the next minute retries; don't fail the unit hard
  }
  const actions = await runFingerprintPass({ ...pos, log });
  console.log(JSON.stringify({ ok: true, actions }));
} catch (e) {
  log({ event: 'fp_match_error', error: String((e && e.message) || e).slice(0, 200) });
  console.log(JSON.stringify({ ok: false, error: String((e && e.message) || e).slice(0, 200) }));
}

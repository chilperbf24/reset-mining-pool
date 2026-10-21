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
import { execFile } from 'node:child_process';
import { PATHS, loadStates, runFingerprintPass, gatewayPoolPosition } from './lib/fprun.mjs';

const ROOT = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const log = obj => { try { appendFileSync(PATHS.log, JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n'); } catch {} };

// Publish any ledger state changes (state/live-ledger.json, round
// reports) to GitHub and re-trigger the site snapshot, so a credited
// contribution reaches the public page within about a minute instead of
// waiting for a manual commit. Best-effort: publish-state.mjs is a no-op
// when nothing changed and never fails this pass.
const publish = () => new Promise(res => {
  execFile(process.execPath, [`${ROOT}/publish-state.mjs`], { timeout: 180000 }, (e, out) => {
    const last = String(out || '').trim().split('\n').pop() || '';
    try { log({ event: 'publish', ...JSON.parse(last) }); }
    catch { log({ event: 'publish', ok: false, error: String((e && e.message) || last).slice(0, 200) }); }
    res();
  });
});

try {
  const { ledger } = loadStates();
  const pos = await gatewayPoolPosition(ledger.pool_address);
  if (!pos) {
    log({ event: 'fp_match_failed', reason: 'gateway unreachable' });
    await publish(); // flush anything a previous pass left unpublished
    console.log(JSON.stringify({ ok: false, error: 'gateway unreachable' }));
    process.exit(0); // transient: the next minute retries; don't fail the unit hard
  }
  const actions = await runFingerprintPass({ ...pos, log });
  await publish();
  console.log(JSON.stringify({ ok: true, actions }));
} catch (e) {
  log({ event: 'fp_match_error', error: String((e && e.message) || e).slice(0, 200) });
  console.log(JSON.stringify({ ok: false, error: String((e && e.message) || e).slice(0, 200) }));
  await publish();
}

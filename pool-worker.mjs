#!/usr/bin/env node
// RESET pool worker — operates ONLY the dedicated pool wallet
// (~/.reset-pool-signer), never the owner's personal wallet.
//
// Modes:
//   (none)          single pass: status -> fingerprint-match any new inflow
//                   (lib/fpmatch.mjs, shared with the 1-minute fp-match
//                   service) -> post headers -> auto-lock once the spendable
//                   balance covers one minimum lock while the pool deposit is
//                   below 0.1 -> claim at level 1000 when the round window is
//                   open -> record any newly settled round into the ledger
//                   (accounting only, never a payout) -> check the
//                   fingerprint-match systemd timer is alive, restart if not
//   --loop <secs>   watch continuously; exits early when a claim is due
//   --claim         execute one mine_claim at level 1000 (hard-capped)
//
// Hard guards (standing policy for this prototype):
// - claim level never above 1000 (a higher level earns strikes/penalties)
// - lock is exactly one min_amount (0.1) per pass, only while deposit < 0.1
//   and the spendable balance covers it (the contract rejects lock moves
//   smaller than min_amount, so topping up a partial shortfall in one call
//   is impossible; one full minimum lock is the smallest executable step)
// - lock/claim outcomes are verified against a fresh status read; an
//   'unknown' outcome is logged and left for the next pass, never re-sent
//   blindly in the same pass
// - settlement only RECORDS pool earnings into the ledger, and only when
//   contributors are actually recorded there; it never invents contributors
// - this worker has NO transfer / unlock / withdraw code path at all.
//   Payouts and exits are separate, explicitly approved steps.
// - lock / claim / post_headers cost no TNK (only transfers do, and this
//   worker never transfers), so the pool MSB/TNK balance does not gate mining.
import { Client } from '../reset/signer/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../reset/signer/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { MIN_DEPOSIT, formatCoin, settleRound, totalContributed } from './lib/pool.mjs';
import { runFingerprintPass } from './lib/fprun.mjs';

const HOME = process.env.HOME;
const SIGNER = `${HOME}/workspace/reset/signer`;
const POOL_DIR = `${HOME}/.reset-pool-signer`;
const PWFILE = `${POOL_DIR}/.wallet-password`;
const LEDGER = `${HOME}/workspace/reset-pool/state/live-ledger.json`;
const LOG = `${HOME}/workspace/reset-pool/pool.log`;

const mode = process.argv[2];
const loopSecs = parseInt(process.argv[3] || '0', 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = obj => { try { appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n'); } catch {} };

function ledgerTotalUnits() {
  if (!existsSync(LEDGER)) return 0n;
  try {
    const s = JSON.parse(readFileSync(LEDGER, 'utf8'));
    return Object.values(s.contributors ?? {}).reduce((sum, c) => sum + BigInt(c.contributed), 0n);
  } catch { return 0n; }
}

let client;
async function call(name, args, tries = 4, waitMs = 10000) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await client.callTool({ name, arguments: args });
      return JSON.parse(r.content.map(c => c.text).join('\n'));
    } catch (e) { lastErr = e; if (i < tries) await sleep(waitMs); }
  }
  throw lastErr;
}
const claimDue = s => parseFloat(s.deposit) >= 0.1 && s.mine.window_open && s.claim === null;

async function connect() {
  const pw = readFileSync(PWFILE, 'utf8').trim();
  if (pw.length < 12) throw new Error('bad pool password file');
  const transport = new StdioClientTransport({
    command: 'node', args: [`${SIGNER}/bin/reset-signer.mjs`, 'mcp', '--directory', POOL_DIR],
    env: { ...process.env, RESET_SIGNER_PASSWORD: pw, RESET_SIGNER_DIRECTORY: POOL_DIR }, stderr: 'ignore',
  });
  client = new Client({ name: 'reset-pool-worker', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
}

const toUnits = x => BigInt(Math.round(parseFloat(x) * 1e8));

async function maybeLock(s) {
  const deposit = toUnits(s.deposit);
  const balance = toUnits(s.balance);
  if (deposit >= MIN_DEPOSIT) return null;                   // already mining
  // The contract requires every single lock move to be >= min_amount, so the
  // smallest executable step is one full minimum lock, never more than the
  // spendable balance. If the balance cannot cover it, stay armed and wait.
  if (balance < MIN_DEPOSIT) {
    log({ event: 'lock_skipped', reason: 'balance_below_min_lock', balance: s.balance, deposit: s.deposit });
    return null;
  }
  const lr = await call('lock', { amount: formatCoin(MIN_DEPOSIT) }, 1);
  await sleep(15000);
  const s2 = await call('status', {});
  const rec = { type: 'lock', amount: formatCoin(MIN_DEPOSIT),
    outcome: lr.outcome || (lr.ok ? 'ok' : 'unknown'),
    verified_deposit: s2.deposit, verified: toUnits(s2.deposit) >= MIN_DEPOSIT };
  log({ event: 'lock', ...rec });
  return rec;
}

async function doClaim(s) {
  const cr = await call('mine_claim', { level: 1000 }, 1);
  await sleep(15000);
  const s2 = await call('status', {});
  const outcome = cr.outcome || (cr.ok ? 'ok' : 'unknown');
  const registered = s2.claim !== null && s2.claim !== undefined;
  const rec = { type: 'claim', level: 1000, outcome, registered, round: s.mine.round, claim_state: s2.claim };
  log({ event: 'claim', level: 1000, outcome, registered, round: s.mine.round, claim_state: s2.claim });
  return rec;
}

// Record a newly settled round's pool earnings into the ledger. Read-only
// gateway lookup of the pool account's last_result; accounting only — this
// never moves coins. Skipped unless contributors are recorded in the ledger.
async function maybeSettle(address) {
  try {
    const res = await fetch(`https://reset.openmayhem.ai/v1/account/${address}`,
      { signal: AbortSignal.timeout(20000) });
    if (!res.ok) { log({ event: 'settle_check_failed', status: res.status }); return null; }
    const lr = (await res.json())?.mine?.last_result;
    if (!lr || lr.r == null || lr.amount == null) return null;
    if (!existsSync(LEDGER)) return null;
    const state = JSON.parse(readFileSync(LEDGER, 'utf8'));
    if (state.rounds.some(r => r.round === lr.r)) return null;   // already recorded
    if (totalContributed(state) < MIN_DEPOSIT) {
      log({ event: 'settle_skipped', round: lr.r, reason: 'no_recorded_contributors' });
      return null;
    }
    const report = settleRound(state, { round: lr.r, claimAmountUnits: BigInt(lr.amount) });
    writeFileSync(LEDGER, JSON.stringify(state, null, 2));
    const path = `${HOME}/workspace/reset-pool/reports/live-round-${lr.r}.json`;
    writeFileSync(path, JSON.stringify(report, null, 2));
    const rec = { type: 'settle', round: lr.r, amount: formatCoin(BigInt(lr.amount)), report: path, report_hash: report.report_hash };
    log({ event: 'settled', round: lr.r, amount: rec.amount, report_hash: report.report_hash });
    return rec;
  } catch (e) {
    log({ event: 'settle_error', error: String((e && e.message) || e).slice(0, 160) });
    return null;
  }
}

// Attribute any new pool inflow by address fingerprint BEFORE lock/claim
// move coins around. Shares state/matcher.json + the .worker.lock flock with
// the 1-minute fp-match systemd service; whichever path runs first books
// the inflow, the other then sees a zero delta. Never throws into the pass.
async function fingerprintStep(s) {
  try {
    const acc = await fetch(`https://reset.openmayhem.ai/v1/account/${s.address}`,
      { signal: AbortSignal.timeout(20000) }).then(r => (r.ok ? r.json() : null)).catch(() => null);
    const lr = acc?.mine?.last_result;
    return await runFingerprintPass({
      totalUnits: toUnits(s.balance) + toUnits(s.deposit),
      lastResult: lr && lr.r != null && lr.amount != null
        ? { r: lr.r, amount: BigInt(Math.round(Number(lr.amount))) } : null,
      log,
    });
  } catch (e) {
    log({ event: 'fp_match_error', error: String((e && e.message) || e).slice(0, 160) });
    return null;
  }
}

// Watchdog for the 1-minute fingerprint matcher: if its systemd timer is
// not active, start it. Best-effort only; never fails the pass.
function sh(cmd, args) {
  return new Promise(res => execFile(cmd, args, { timeout: 15000 },
    (e, stdout) => res(e ? null : String(stdout).trim())));
}
async function checkFpTimer() {
  try {
    const st = await sh('systemctl', ['is-active', 'reset-pool-fpmatch.timer']);
    if (st === 'active') return 'active';
    await sh('systemctl', ['start', 'reset-pool-fpmatch.timer']);
    const now = await sh('systemctl', ['is-active', 'reset-pool-fpmatch.timer']);
    log({ event: 'fpmatch_timer_watchdog', was: st, now });
    return now;
  } catch { return null; }
}

async function singlePass() {
  const s = await call('status', {});
  const out = { ok: true, address: s.address, tip: s.tip, round: s.mine.round, balance: s.balance,
    deposit: s.deposit, window_open: s.mine.window_open, claim: s.claim, strikes: s.strikes,
    ledger_total: formatCoin(ledgerTotalUnits()) };
  const fpActions = await fingerprintStep(s);
  if (fpActions && fpActions.length) out.fp = fpActions;
  try { out.headers = (await call('post_headers', {}, 2, 8000)).outcome || 'ok'; } catch { out.headers = 'failed'; }
  const lock = await maybeLock(await call('status', {}));
  if (lock) out.lock = lock;
  let s3 = await call('status', {});
  if (claimDue(s3)) {
    out.claim = await doClaim(s3);
    s3 = await call('status', {});
  }
  const settled = await maybeSettle(s3.address);
  if (settled) out.settled = settled;
  out.fp_timer = await checkFpTimer();
  out.claim_due = claimDue(s3);
  out.funded = toUnits(s3.balance) + toUnits(s3.deposit) >= MIN_DEPOSIT;
  log({ event: 'pass', tip: s3.tip, round: s3.mine.round, balance: s3.balance, deposit: s3.deposit });
  console.log(JSON.stringify(out));
}

async function claimOnce() {
  const s = await call('status', {});
  if (!claimDue(s)) { console.log(JSON.stringify({ ok: true, claim_due: false, note: 'window closed, already claimed, or pool deposit below 0.1' })); return; }
  const rec = await doClaim(s);
  console.log(JSON.stringify({ ok: true, action: 'claim', ...rec }));
}

async function loopWatch(budgetSecs) {
  const endAt = Date.now() + budgetSecs * 1000;
  let lastTip = null, iters = 0;
  while (Date.now() < endAt) {
    let s;
    try { s = await call('status', {}, 3, 8000); } catch { await sleep(20000); continue; }
    iters++;
    if (lastTip === null || s.tip !== lastTip) {
      try { await call('post_headers', {}, 2, 8000); } catch {}
    }
    lastTip = s.tip;
    try { await maybeLock(s); } catch {}
    if (claimDue(s)) {
      log({ event: 'claim_due', round: s.mine.round });
      console.log(JSON.stringify({ ok: true, claim_due: true, round: s.mine.round, iters }));
      return;
    }
    await sleep(45000);
  }
  console.log(JSON.stringify({ ok: true, loop_done: true, iters }));
}

await connect();
try {
  if (mode === '--claim') await claimOnce();
  else if (mode === '--loop') await loopWatch(loopSecs || 420);
  else await singlePass();
} finally { try { await client.close(); } catch {} }

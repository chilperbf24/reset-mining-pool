#!/usr/bin/env node
// RESET pool — watchdog for the GitHub Actions snapshot workflow.
// GitHub sometimes skips scheduled runs (observed 2026-10-21: a >20 min
// gap on a */10 cron). This check runs every 5 minutes: if the newest
// workflow run (any event) is older than 12 minutes and no run is active,
// it dispatches one manual run. After a watchdog trigger it stays quiet
// for 10 minutes (stamp file outside the repo), so it never machine-guns
// the workflow.
//
// Usage: node snapshot-watchdog.mjs [--dry-run]
// Prints one JSON line: {decision, ageMin, newest, ...} where decision is
// one of: triggered | would-trigger (dry-run) | skip-active | skip-fresh |
// skip-stamp | error. When a publish lag is detected the same line gains a
// `publishLag` field (the snapshot decision semantics are unchanged).
// Test hook: WATCHDOG_FAKE_RUNS_JSON='[{"createdAt":"...","status":"completed"}]'
// replaces the gh query (dry-run only).
//
// Second duty (added 2026-10-23): publish-lag visibility. The ledger
// publish chain (publish-state.mjs, driven by fp-match passes) stalled
// silently for a day when its driver died — rounds 476+ never reached the
// site and the only trace was pool.log lines nobody reads. This watchdog
// is on a durable 5-minute runtime cron, so every run it also compares
// the local ledger's last settled round against the published one
// (state/publish-status.json, written by publish-state on every run):
// lag >= 2 rounds, or unpublished changes with no successful publish for
// over 30 minutes, appends a `publish_lag` event to pool.log and makes
// one bounded publish-state attempt (`publish_heal`), throttled to one
// alarm+heal per 10 minutes via the stamp file.
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';

const REPO = 'chilperbf24/reset-mining-pool';
const ROOT = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const STAMP = `${process.env.HOME}/.reset-pool-watchdog.json`;
const DRY = process.argv.includes('--dry-run');
const AGE_LIMIT_MIN = 12, STAMP_QUIET_MIN = 10;
const ACTIVE = ['queued', 'in_progress', 'waiting', 'requested', 'pending'];

const run = (cmd, args, cwd, timeout = 60000) => new Promise((res, rej) => {
  execFile(cmd, args, { cwd, timeout, maxBuffer: 1024 * 1024 },
    (e, out, err) => (e ? rej(new Error(String(err || e.message).slice(0, 300))) : res(String(out))));
});

async function snapshotDecision() {
  let runs;
  if (process.env.WATCHDOG_FAKE_RUNS_JSON) {
    if (!DRY) throw new Error('WATCHDOG_FAKE_RUNS_JSON is a dry-run-only test hook');
    runs = JSON.parse(process.env.WATCHDOG_FAKE_RUNS_JSON);
  } else {
    runs = JSON.parse(await run('gh', ['run', 'list', '--repo', REPO, '--workflow', 'snapshot.yml',
      '--limit', '5', '--json', 'createdAt,status']));
  }
  if (!runs.length) throw new Error('no workflow runs found');
  const newest = runs.map(r => r.createdAt).sort().pop();
  const ageMin = (Date.now() - Date.parse(newest)) / 60000;

  if (runs.some(r => ACTIVE.includes(r.status))) {
    return { decision: 'skip-active', ageMin: +ageMin.toFixed(1), newest };
  }
  if (ageMin <= AGE_LIMIT_MIN) {
    return { decision: 'skip-fresh', ageMin: +ageMin.toFixed(1), newest };
  }
  try {
    if (existsSync(STAMP)) {
      const last = Date.parse(JSON.parse(readFileSync(STAMP, 'utf8')).lastTrigger || '');
      if (Date.now() - last < STAMP_QUIET_MIN * 60000) {
        return { decision: 'skip-stamp', ageMin: +ageMin.toFixed(1), newest };
      }
    }
  } catch {}
  if (DRY) {
    return { decision: 'would-trigger', ageMin: +ageMin.toFixed(1), newest };
  }
  await run('gh', ['workflow', 'run', 'snapshot.yml', '--repo', REPO]);
  try {
    let stamp = {};
    try { stamp = JSON.parse(readFileSync(STAMP, 'utf8')); } catch {}
    writeFileSync(STAMP, JSON.stringify({ ...stamp, lastTrigger: new Date().toISOString() }) + '\n');
  } catch {}
  return { decision: 'triggered', ageMin: +ageMin.toFixed(1), newest };
}

// --- publish lag check ------------------------------------------------------
const logPool = obj => {
  try { appendFileSync(`${ROOT}/pool.log`, JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n'); } catch {}
};
const settledOf = text => {
  try {
    const rounds = (JSON.parse(text).events || []).filter(e => e.type === 'round_settled')
      .map(e => e.data?.round).filter(Number.isFinite);
    return rounds.length ? Math.max(...rounds) : null;
  } catch { return null; }
};

// Returns a publishLag info object when lagging, null otherwise. In dry-run
// it only computes (no pool.log writes, no heal attempt).
async function publishCheck() {
  let localLast = null, publishedLast = null, lastSuccess = null;
  try { localLast = settledOf(readFileSync(`${ROOT}/state/live-ledger.json`, 'utf8')); } catch {}
  try {
    const s = JSON.parse(readFileSync(`${ROOT}/state/publish-status.json`, 'utf8'));
    publishedLast = s.published_last_round ?? null;
    lastSuccess = s.last_success ?? null;
  } catch {}
  if (publishedLast == null) {
    try { publishedLast = settledOf(await run('git', ['show', 'origin/main:state/live-ledger.json'], ROOT)); } catch {}
  }
  if (localLast == null || publishedLast == null) return null;
  const lagRounds = localLast - publishedLast;
  const staleMin = lastSuccess ? (Date.now() - Date.parse(lastSuccess)) / 60000 : Infinity;
  if (!(lagRounds >= 2 || (lagRounds >= 1 && staleMin > 30))) return null;
  const info = { local_last_round: localLast, published_last_round: publishedLast, lag_rounds: lagRounds, last_success: lastSuccess };
  if (DRY) return { ...info, dryRun: true };
  let stamp = {};
  try { stamp = JSON.parse(readFileSync(STAMP, 'utf8')); } catch {}
  if (Date.now() - Date.parse(stamp.lastPublishAlarm || '') < STAMP_QUIET_MIN * 60000) {
    return { ...info, throttled: true };
  }
  logPool({
    event: 'publish_lag', ...info,
    reason: lagRounds >= 2 ? `unpublished rounds lag ${lagRounds}` : `unpublished changes, last successful publish ${Math.round(staleMin)}m ago`,
  });
  try { writeFileSync(STAMP, JSON.stringify({ ...stamp, lastPublishAlarm: new Date().toISOString() }) + '\n'); } catch {}
  // Self-heal: publish-state is standalone-safe (own lock, never force-pushes).
  try {
    const out = await run(process.execPath, [`${ROOT}/publish-state.mjs`], ROOT, 200000);
    logPool({ event: 'publish_heal', ok: true, result: (String(out).trim().split('\n').pop() || '').slice(0, 300) });
  } catch (e) {
    logPool({ event: 'publish_heal', ok: false, error: String(e.message || e).slice(0, 300) });
  }
  return info;
}

async function main() {
  const decision = await snapshotDecision();
  let publishLag = null;
  try { publishLag = await publishCheck(); } catch {}
  console.log(JSON.stringify({ ...decision, ...(publishLag ? { publishLag } : {}) }));
}

main().catch(e => { console.log(JSON.stringify({ decision: 'error', error: String(e.message || e).slice(0, 300) })); process.exit(1); });

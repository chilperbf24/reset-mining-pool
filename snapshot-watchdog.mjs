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
// skip-stamp | error.
// Test hook: WATCHDOG_FAKE_RUNS_JSON='[{"createdAt":"...","status":"completed"}]'
// replaces the gh query (dry-run only).
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const REPO = 'chilperbf24/reset-mining-pool';
const STAMP = `${process.env.HOME}/.reset-pool-watchdog.json`;
const DRY = process.argv.includes('--dry-run');
const AGE_LIMIT_MIN = 12, STAMP_QUIET_MIN = 10;
const ACTIVE = ['queued', 'in_progress', 'waiting', 'requested', 'pending'];

const run = (cmd, args) => new Promise((res, rej) => {
  execFile(cmd, args, { timeout: 60000, maxBuffer: 1024 * 1024 },
    (e, out, err) => (e ? rej(new Error(String(err || e.message).slice(0, 300))) : res(String(out))));
});

async function main() {
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
    console.log(JSON.stringify({ decision: 'skip-active', ageMin: +ageMin.toFixed(1), newest }));
    return;
  }
  if (ageMin <= AGE_LIMIT_MIN) {
    console.log(JSON.stringify({ decision: 'skip-fresh', ageMin: +ageMin.toFixed(1), newest }));
    return;
  }
  try {
    if (existsSync(STAMP)) {
      const last = Date.parse(JSON.parse(readFileSync(STAMP, 'utf8')).lastTrigger || '');
      if (Date.now() - last < STAMP_QUIET_MIN * 60000) {
        console.log(JSON.stringify({ decision: 'skip-stamp', ageMin: +ageMin.toFixed(1), newest }));
        return;
      }
    }
  } catch {}
  if (DRY) {
    console.log(JSON.stringify({ decision: 'would-trigger', ageMin: +ageMin.toFixed(1), newest }));
    return;
  }
  await run('gh', ['workflow', 'run', 'snapshot.yml', '--repo', REPO]);
  try { writeFileSync(STAMP, JSON.stringify({ lastTrigger: new Date().toISOString() }) + '\n'); } catch {}
  console.log(JSON.stringify({ decision: 'triggered', ageMin: +ageMin.toFixed(1), newest }));
}

main().catch(e => { console.log(JSON.stringify({ decision: 'error', error: String(e.message || e).slice(0, 300) })); process.exit(1); });

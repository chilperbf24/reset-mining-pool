#!/usr/bin/env node
// RESET pool — publish ledger state changes to GitHub and re-trigger the
// site snapshot workflow. Runs at the end of every fp-match pass (and is
// safe to run standalone at any time).
//
// What gets published is exactly what generate-site.mjs reads to render
// the ledger and the settled-round reports:
//   - state/live-ledger.json   (contributions, rounds, payouts)
//   - reports/live-round-*.json (per-round settlement reports)
//   - state/rehearsal-loss-log.json (per-round shortfall record of the
//     cancelled 2026-10-22 exit rehearsal; evidence, published as-is)
//   - state/exit-cases.json (PUBLIC projection of the executor's exit
//     cases, derived from state/exits.json by lib/exit-public.mjs on
//     every run — feeds the exit page's progress lookup)
//   - state/publish-status.json (lag-visibility record, rewritten on
//     every run and staged whenever a ledger commit is made; its own
//     changes never trigger a commit by themselves)
// Nothing else is staged — gateway cache, matcher state and unclaimed
// records stay local (they are gitignored by design; the ledger is the
// public record).
//
// No changes -> no commit, no push, no workflow trigger.
// A failed rebase aborts cleanly (the local commit is kept and retried on
// the next pass); this script NEVER force-pushes.
//
// Usage: node publish-state.mjs [--dry-run]
import { execFile } from 'node:child_process';
import { openSync, closeSync, unlinkSync, statSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { publicExitSummary } from './lib/exit-public.mjs';

const ROOT = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const REPO = 'chilperbf24/reset-mining-pool';
const DRY = process.argv.includes('--dry-run');
const LOCK = `${ROOT}/.publish.lock`;
const STATUS = `${ROOT}/state/publish-status.json`;

const run = (cmd, args) => new Promise((res, rej) => {
  execFile(cmd, args, { cwd: ROOT, timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
    (e, out, err) => (e ? rej(new Error(`${cmd} ${args[0]} failed: ${String(err || e.message).slice(0, 300)}`)) : res(String(out))));
});

// --- publish status (lag visibility) --------------------------------------
// Every run rewrites state/publish-status.json ({last_attempt, last_success,
// local_last_round, published_last_round, error}) so a stalled publish chain
// is visible in the repo and to the snapshot watchdog — the 2026-10-22 stall
// (rounds 476+ unpublished for a day) was only visible in pool.log.
const readStatus = () => { try { return JSON.parse(readFileSync(STATUS, 'utf8')); } catch { return {}; } };
const writeStatus = patch => {
  try { writeFileSync(STATUS, JSON.stringify({ ...readStatus(), ...patch }, null, 2) + '\n'); } catch {}
};
const lastSettledRound = ledger => {
  const rounds = (ledger?.events || []).filter(e => e.type === 'round_settled')
    .map(e => e.data?.round).filter(Number.isFinite);
  return rounds.length ? Math.max(...rounds) : null;
};
const localLastRound = () => {
  try { return lastSettledRound(JSON.parse(readFileSync(`${ROOT}/state/live-ledger.json`, 'utf8'))); } catch { return null; }
};

// --- exit-case public summary ----------------------------------------------
// Derived from the executor's state/exits.json on every run and rewritten
// only when the case list actually changes (generated_at excluded from
// the comparison), so it joins the publish set exactly when a case moves.
const EXIT_PUB = `${ROOT}/state/exit-cases.json`;
const refreshExitCases = () => {
  try {
    const summary = publicExitSummary(JSON.parse(readFileSync(`${ROOT}/state/exits.json`, 'utf8')));
    let prev = null;
    try { prev = JSON.parse(readFileSync(EXIT_PUB, 'utf8')); } catch {}
    if (!prev || JSON.stringify(prev.cases) !== JSON.stringify(summary.cases)) {
      writeFileSync(EXIT_PUB, JSON.stringify({ ...summary, generated_at: new Date().toISOString() }, null, 2) + '\n');
    }
  } catch {}
};
const publishedLastRound = async () => {
  try { return lastSettledRound(JSON.parse(await run('git', ['show', 'origin/main:state/live-ledger.json']))); } catch { return null; }
};

// Best-effort mutual exclusion (fp-match already runs under .worker.lock;
// this guards standalone invocations and overlapping passes).
function acquireLock() {
  try { const fd = openSync(LOCK, 'wx'); closeSync(fd); return true; }
  catch {
    try { if (Date.now() - statSync(LOCK).mtimeMs > 10 * 60000) { unlinkSync(LOCK); return acquireLock(); } } catch {}
    return false;
  }
}

async function main() {
  if (!acquireLock()) { console.log(JSON.stringify({ published: false, reason: 'locked' })); return; }
  try {
    refreshExitCases();
    const status = await run('git', ['status', '--porcelain=v1', '--', 'state/live-ledger.json', 'state/rehearsal-loss-log.json', 'state/exit-cases.json', 'reports/']);
    const files = status.split('\n').map(l => l.slice(3).trim()).filter(Boolean)
      .filter(p => p === 'state/live-ledger.json' || p === 'state/rehearsal-loss-log.json' || p === 'state/exit-cases.json' || /^reports\/live-round-\d+\.json$/.test(p));
    const localRound = localLastRound();
    // A previous run may have committed but failed to push (dirty-tree
    // rebase refusal, proxy flap): stranded local commits are publishable
    // work too, not "no changes".
    let stranded = 0;
    try { stranded = parseInt(await run('git', ['rev-list', '--count', 'origin/main..HEAD']), 10) || 0; } catch {}
    if (!files.length && !stranded) {
      writeStatus({ last_attempt: new Date().toISOString(), local_last_round: localRound, published_last_round: await publishedLastRound(), error: null });
      console.log(JSON.stringify({ published: false, reason: 'no ledger changes' }));
      return;
    }
    if (DRY) { console.log(JSON.stringify({ published: false, dryRun: true, wouldCommit: files, stranded })); return; }

    if (files.length) {
      writeStatus({ last_attempt: new Date().toISOString(), local_last_round: localRound, published_last_round: localRound });
      await run('git', ['add', '--', ...files, 'state/publish-status.json']);
      await run('git', ['commit', '-m', 'auto-publish ledger state']);
    }
    let pushed = false, lastErr = null;
    for (let attempt = 0; attempt < 2 && !pushed; attempt++) {
      try {
        // --autostash: unrelated working-tree changes (e.g. pool-worker.mjs
        // tuning left uncommitted) must not wedge the rebase — that exact
        // refusal ("cannot pull with rebase: You have unstaged changes")
        // is what a stranded publish hits. Autostash restores them
        // byte-identical immediately after the rebase.
        await run('git', ['pull', '--rebase', '--autostash', 'origin', 'main']);
        await run('git', ['push', 'origin', 'main']);
        pushed = true;
      } catch (e) {
        lastErr = e;
        try { await run('git', ['rebase', '--abort']); } catch {}
      }
    }
    if (!pushed) {
      writeStatus({ last_attempt: new Date().toISOString(), local_last_round: localRound, error: `push failed: ${lastErr?.message ?? ''}`.slice(0, 300) });
      console.log(JSON.stringify({ published: false, committed: files.length > 0, reason: `push failed, will retry next pass: ${lastErr?.message ?? ''}` }));
      return;
    }
    writeStatus({ last_attempt: new Date().toISOString(), last_success: new Date().toISOString(), local_last_round: localRound, published_last_round: localRound, error: null });
    await run('gh', ['workflow', 'run', 'snapshot.yml', '--repo', REPO]);
    console.log(JSON.stringify({ published: true, files, triggered: 'snapshot.yml' }));
  } finally {
    try { if (existsSync(LOCK)) unlinkSync(LOCK); } catch {}
  }
}

main().catch(e => {
  writeStatus({ last_attempt: new Date().toISOString(), local_last_round: localLastRound(), error: String(e.message || e).slice(0, 300) });
  console.log(JSON.stringify({ published: false, reason: String(e.message || e).slice(0, 300) }));
  process.exit(1);
});

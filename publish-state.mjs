#!/usr/bin/env node
// RESET pool — publish ledger state changes to GitHub and re-trigger the
// site snapshot workflow. Runs at the end of every fp-match pass (and is
// safe to run standalone at any time).
//
// What gets published is exactly what generate-site.mjs reads to render
// the ledger and the settled-round reports:
//   - state/live-ledger.json   (contributions, rounds, payouts)
//   - reports/live-round-*.json (per-round settlement reports)
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
import { openSync, closeSync, unlinkSync, statSync, existsSync } from 'node:fs';

const ROOT = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const REPO = 'chilperbf24/reset-mining-pool';
const DRY = process.argv.includes('--dry-run');
const LOCK = `${ROOT}/.publish.lock`;

const run = (cmd, args) => new Promise((res, rej) => {
  execFile(cmd, args, { cwd: ROOT, timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
    (e, out, err) => (e ? rej(new Error(`${cmd} ${args[0]} failed: ${String(err || e.message).slice(0, 300)}`)) : res(String(out))));
});

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
    const status = await run('git', ['status', '--porcelain=v1', '--', 'state/live-ledger.json', 'reports/']);
    const files = status.split('\n').map(l => l.slice(3).trim()).filter(Boolean)
      .filter(p => p === 'state/live-ledger.json' || /^reports\/live-round-\d+\.json$/.test(p));
    if (!files.length) { console.log(JSON.stringify({ published: false, reason: 'no ledger changes' })); return; }
    if (DRY) { console.log(JSON.stringify({ published: false, dryRun: true, wouldCommit: files })); return; }

    await run('git', ['add', '--', ...files]);
    await run('git', ['commit', '-m', 'auto-publish ledger state']);
    let pushed = false, lastErr = null;
    for (let attempt = 0; attempt < 2 && !pushed; attempt++) {
      try {
        await run('git', ['pull', '--rebase', 'origin', 'main']);
        await run('git', ['push', 'origin', 'main']);
        pushed = true;
      } catch (e) {
        lastErr = e;
        try { await run('git', ['rebase', '--abort']); } catch {}
      }
    }
    if (!pushed) {
      console.log(JSON.stringify({ published: false, committed: true, reason: `push failed, will retry next pass: ${lastErr?.message ?? ''}` }));
      return;
    }
    await run('gh', ['workflow', 'run', 'snapshot.yml', '--repo', REPO]);
    console.log(JSON.stringify({ published: true, files, triggered: 'snapshot.yml' }));
  } finally {
    try { if (existsSync(LOCK)) unlinkSync(LOCK); } catch {}
  }
}

main().catch(e => { console.log(JSON.stringify({ published: false, reason: String(e.message || e).slice(0, 300) })); process.exit(1); });

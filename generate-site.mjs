#!/usr/bin/env node
// Generates the pool's public page as ONE static HTML file.
// It reads only local files (ledger, worker log, published reports) and makes
// NO network calls — visitors' browsers never touch the gateway, so there is
// nothing to poll, no login, and no authorization popups. Regenerate it after
// each settlement; the "updated" stamp on the page says how fresh it is.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { formatCoin, totalContributed } from './lib/pool.mjs';

const ROOT = `${process.env.HOME}/workspace/reset-pool`;
const ledger = JSON.parse(readFileSync(`${ROOT}/state/live-ledger.json`, 'utf8'));

let lastPass = null;
if (existsSync(`${ROOT}/pool.log`)) {
  for (const line of readFileSync(`${ROOT}/pool.log`, 'utf8').trim().split('\n')) {
    try { const e = JSON.parse(line); if (e.event === 'pass') lastPass = e; } catch {}
  }
}
const liveReports = existsSync(`${ROOT}/reports`)
  ? readdirSync(`${ROOT}/reports`).filter(f => /^live-round-\d+\.json$/.test(f)).sort()
      .map(f => JSON.parse(readFileSync(`${ROOT}/reports/${f}`, 'utf8')))
  : [];

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const total = totalContributed(ledger);
const funded = total >= 10_000_000n;
const contributors = Object.entries(ledger.contributors);
const updated = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

const contributorRows = contributors.length ? contributors.map(([a, c]) => `
        <tr><td class="mono">${esc(a)}</td><td>${formatCoin(c.contributed)}</td><td>${formatCoin(c.pending)}</td><td>${formatCoin(c.paid_total)}</td></tr>`).join('')
  : `<tr><td colspan="4" class="muted">No contributors yet — be the first.</td></tr>`;

const reportRows = liveReports.length ? liveReports.map(r => `
        <tr><td>${r.round}</td><td>${formatCoin(r.claim.amount_units)}</td><td>${r.shares.length}</td><td class="mono">${esc(r.report_hash.slice(0, 16))}…</td></tr>`).join('')
  : `<tr><td colspan="4" class="muted">No rounds settled yet.</td></tr>`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RESET Mining Pool — mine together below the 0.1 minimum</title>
<style>
 body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#0d1117;color:#e6edf3;margin:0;padding:24px;max-width:860px;margin-inline:auto;line-height:1.55}
 h1{font-size:26px;margin:0 0 4px} h2{font-size:18px;margin:28px 0 8px;border-bottom:1px solid #30363d;padding-bottom:6px}
 .muted{color:#8b949e} .mono{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;word-break:break-all}
 .badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:13px;background:${funded ? '#1a7f3722;color:#3fb950;border:1px solid #1a7f37' : '#9e6a0322;color:#d29922;border:1px solid #9e6a03'}}
 .card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:16px;margin:12px 0}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
 .stat{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:12px}
 .stat b{display:block;font-size:20px} .stat span{color:#8b949e;font-size:13px}
 table{width:100%;border-collapse:collapse;font-size:14px} td,th{padding:7px 8px;border-bottom:1px solid #21262d;text-align:left}
 button{background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:4px 10px;cursor:pointer}
 code{background:#21262d;padding:1px 5px;border-radius:4px;font-size:13px}
 ol,ul{padding-left:22px} .warn{border-color:#9e6a03}
</style></head><body>
<h1>RESET Mining Pool</h1>
<p class="muted">Mine together below the 0.1 minimum. Small holders fund one pool address;
the pool locks ≥ 0.1, claims every round at exactly its fair share, and splits the proceeds pro-rata —
with accounting anyone can recompute.</p>
<p><span class="badge">${funded ? '● Active — pool is funded' : '● Waiting for funding — contributions open'}</span></p>

<div class="card"><div class="muted">Pool address (send RESET here to join)</div>
<div class="mono" id="addr">${esc(ledger.pool_address)}</div>
<button onclick="navigator.clipboard.writeText(document.getElementById('addr').textContent)">Copy address</button></div>

<div class="grid">
 <div class="stat"><b>${formatCoin(total)}</b><span>Total contributed (RESET)</span></div>
 <div class="stat"><b>${contributors.length}</b><span>Contributors</span></div>
 <div class="stat"><b>${lastPass ? esc(lastPass.deposit) : '—'}</b><span>Locked deposit on-chain</span></div>
 <div class="stat"><b>${lastPass ? esc(lastPass.balance) : '—'}</b><span>Pool balance on-chain</span></div>
 <div class="stat"><b>${lastPass ? esc(lastPass.round) : '—'}</b><span>Current Mine round</span></div>
 <div class="stat"><b>${ledger.rounds.length}</b><span>Rounds settled</span></div>
</div>

<h2>How to join</h2>
<ol>
 <li>From your own RESET wallet, <b>transfer</b> any amount (e.g. 0.02) to the pool address above. You pay your own TNK transfer fee.</li>
 <li>Send the operator your address and the transfer reference. Your contribution is entered in the public ledger below <b>only after</b> it is visible on-chain.</li>
 <li>Done. Your share of every round = your contribution ÷ pool total, snapshotted per round. Earnings accumulate and are paid out once they reach <b>0.01</b>.</li>
</ol>

<h2>Rules — the honest version</h2>
<ul>
 <li><b>Fee: 0.</b> Claim level: always exactly 1000 (fair share, never over — no strikes, no penalties).</li>
 <li><b>Pooling grants access, not extra yield.</b> The Mine pays linearly in deposit; the pool earns exactly what its combined deposit would earn solo.</li>
 <li><b>Exits take about a day:</b> leaving requires <code>unlock</code> plus the contract's 144-Bitcoin-block exit wait, then <code>withdraw</code>. No instant exits.</li>
 <li><b>Accounting is provable; custody is trusted.</b> RESET has no pool/multisig primitive, so the operator's key controls the funds. Every contribution, claim and payout is published and hash-chained so any cheating would be visible and attributable — but it cannot be made impossible. This is an experiment, not an investment; no returns are promised.</li>
</ul>

<h2>Public ledger</h2>
<table><tr><th>Contributor</th><th>Contributed</th><th>Pending payout</th><th>Paid total</th></tr>${contributorRows}
</table>

<h2>Round reports</h2>
<table><tr><th>Round</th><th>Claim received (RESET)</th><th>Shares</th><th>Report hash</th></tr>${reportRows}
</table>

<h2>Verify it yourself</h2>
<div class="card">
<p>Each round report publishes its full inputs: the contributor snapshot, the claim amount (match it against the
chain's claim record for the pool address and round), the fee and every share. Recompute:</p>
<p><code>share<sub>i</sub> = (claim − fee + carried dust) × deposit<sub>i</sub> ÷ total deposits</code></p>
<p>Integer-division dust is carried into the next round, never kept. At any time:
<code>Σ claims = Σ pending + Σ paid + fees + carried dust</code>.
An open-source verifier that recomputes reports independently is available from the operator —
altering a single share makes verification fail.</p>
</div>

<p class="muted">Page generated ${updated}. It is a static snapshot — no live polling, no login, no tracking.</p>
</body></html>`;

mkdirSync(`${ROOT}/docs`, { recursive: true });
writeFileSync(`${ROOT}/docs/index.html`, html);
console.log(JSON.stringify({ ok: true, file: `${ROOT}/docs/index.html`, funded, contributors: contributors.length, live_reports: liveReports.length, updated }));

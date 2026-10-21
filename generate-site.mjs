#!/usr/bin/env node
// Generates the pool's public page as ONE static HTML file (docs/index.html).
// - Reads only local files (ledger, worker log, published reports); the page
//   itself makes NO network calls. Language switching and the address lookup
//   both run locally in the visitor's browser against data embedded here.
// - The address lookup therefore reflects the ledger snapshot at generation
//   time; the page stamps when it was generated. Regenerate after each
//   settlement / contribution.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { formatCoin, totalContributed } from './lib/pool.mjs';

const ROOT = `${process.env.HOME}/workspace/reset-pool`;
const ledger = JSON.parse(readFileSync(`${ROOT}/state/live-ledger.json`, 'utf8'));

// --- Explorer data: public gateway reads, snapshotted at generation time.
// The gateway sends no CORS headers, so browsers cannot call it directly;
// this generator fetches server-side instead and embeds the result. A cache
// file keeps the page useful if the gateway is unreachable at generation.
const GW = 'https://reset.openmayhem.ai';
const CACHE = `${ROOT}/state/gateway-cache.json`;
async function fetchJSON(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(20000) }); return r.ok ? await r.json() : null; }
  catch { return null; }
}
const watchlist = existsSync(`${ROOT}/explorer-watch.json`) ? JSON.parse(readFileSync(`${ROOT}/explorer-watch.json`, 'utf8')) : [ledger.pool_address];
let cachePrev = {};
try { cachePrev = JSON.parse(readFileSync(CACHE, 'utf8')); } catch {}
let gwState = await fetchJSON(`${GW}/v1/state`);
const gwAccounts = {};
for (const a of watchlist) { const acc = await fetchJSON(`${GW}/v1/account/${a}`); if (acc) gwAccounts[a] = acc; }
// Full miners list for the staking leaderboard: /v1/mine/view is paginated by
// an `after` cursor. Row: [address, deposit, exiting, strikes, clean,
// claimed_this_round, last_round, last_amount, last_penalty] (amounts in units).
let minersAll = [], minersTotal = 0;
if (gwState) {
  let after = '';
  for (let page = 0; page < 20; page++) {
    const mv = await fetchJSON(`${GW}/v1/mine/view${after ? `?after=${after}` : ''}`);
    if (!mv) break;
    minersTotal = mv.total ?? minersTotal;
    minersAll.push(...(mv.miners ?? []));
    if (!mv.next) break;
    after = mv.next;
  }
}
let gwStale = false;
if (gwState) { try { writeFileSync(CACHE, JSON.stringify({ fetched_at: new Date().toISOString(), state: gwState, accounts: gwAccounts, miners: minersAll, miners_total: minersTotal, balances: cachePrev.balances ?? {}, balances_fetched_at: cachePrev.balances_fetched_at ?? cachePrev.fetched_at ?? null }, null, 2)); } catch {} }
else if (existsSync(CACHE)) { const c = JSON.parse(readFileSync(CACHE, 'utf8')); gwState = c.state; Object.assign(gwAccounts, c.accounts); minersAll = c.miners ?? []; minersTotal = c.miners_total ?? minersAll.length; gwStale = true; }
// Staking leaderboard: deposit > 0, sorted by deposit desc, address as tiebreak.
const leaders = minersAll.filter(r => Number(r[1]) > 0)
  .sort((a, b) => Number(b[1]) - Number(a[1]) || (a[0] < b[0] ? -1 : 1));
const totalStaked = leaders.reduce((s, r) => s + BigInt(r[1]), 0n);

// Balances are NOT in mine/view rows — one /v1/account call per address.
// The gateway's default rate limit is 240 requests/minute per IP, so the
// sweep is paced (chunks of 50 started at most every 14s ≈ 214/min) and a
// 429 waits and retries. Balances from the previous run's cache are the
// fallback for any address that cannot be fetched this time.
const balCache = cachePrev.balances ?? {};
const balances = {};
const balCacheAt = Date.parse(cachePrev.balances_fetched_at ?? cachePrev.fetched_at ?? '') || 0;
const balCacheFresh = gwState && leaders.length && (Date.now() - balCacheAt < 30 * 60000)
  && leaders.every(r => balCache[r[0]] != null);
if (balCacheFresh) {
  for (const r of leaders) balances[r[0]] = balCache[r[0]];
} else if (gwState && leaders.length) {
  const sleepMs = ms => new Promise(r => setTimeout(r, ms));
  async function fetchBalance(addr) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(`${GW}/v1/account/${addr}`, { signal: AbortSignal.timeout(15000) });
        if (r.status === 429) { await sleepMs(30000); continue; }
        if (!r.ok) return null;
        const j = await r.json();
        return j.balance ?? null;
      } catch { await sleepMs(2000); }
    }
    return null;
  }
  const CHUNK = 50, SPAN = 14000;
  for (let i = 0; i < leaders.length; i += CHUNK) {
    const t0 = Date.now();
    const part = leaders.slice(i, i + CHUNK);
    const vals = await Promise.all(part.map(r => fetchBalance(r[0])));
    part.forEach((r, k) => { balances[r[0]] = vals[k] ?? balCache[r[0]] ?? null; });
    const dt = Date.now() - t0;
    if (i + CHUNK < leaders.length && dt < SPAN) await sleepMs(SPAN - dt);
  }
  try { writeFileSync(CACHE, JSON.stringify({ fetched_at: new Date().toISOString(), state: gwState, accounts: gwAccounts, miners: minersAll, miners_total: minersTotal, balances }, null, 2)); } catch {}
}

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

// Snapshot embedded for the client-side address lookup (public data only).
const snapshotData = {
  pool_address: ledger.pool_address,
  total_units: total.toString(),
  threshold_units: ledger.payout_threshold_units,
  rounds_settled: ledger.rounds.length,
  updated,
  snapshot_ms: Date.now(),
  contributors: Object.fromEntries(contributors.map(([a, c]) => [a, {
    contributed_units: c.contributed, pending_units: c.pending, paid_units: c.paid_total }])),
};

const contributorRows = contributors.length ? contributors.map(([a, c]) => `
        <tr><td class="mono">${esc(a)}</td><td>${formatCoin(c.contributed)}</td><td>${formatCoin(c.pending)}</td><td>${formatCoin(c.paid_total)}</td></tr>`).join('')
  : `<tr><td colspan="4" class="muted" data-i18n="noContributors">No contributors yet — be the first.</td></tr>`;

const reportRows = liveReports.length ? liveReports.map(r => `
        <tr><td>${r.round}</td><td>${formatCoin(r.claim.amount_units)}</td><td>${r.shares.length}</td><td class="mono">${esc(r.report_hash.slice(0, 16))}…</td></tr>`).join('')
  : `<tr><td colspan="4" class="muted" data-i18n="noRounds">No rounds settled yet.</td></tr>`;

const fc = u => { try { return formatCoin(BigInt(u)); } catch { return '—'; } };
let explorerHtml;
if (!gwState) {
  explorerHtml = `<p class="muted" data-i18n="expDown">Gateway unreachable when this page was generated — try again later.</p>`;
} else {
  const m = gwState.mine, lr = m.last_result ?? {};
  const watchRows = watchlist.map(a => {
    const acc = gwAccounts[a];
    if (!acc) return `<tr><td class="mono">${esc(a)}</td><td colspan="7" class="muted">—</td></tr>`;
    const am = acc.mine ?? {};
    const claimTxt = am.claim ? `level ${am.claim.q}` : '—';
    const lastTxt = am.last_result ? `#${am.last_result.r}: ${fc(am.last_result.amount)}` : '—';
    return `<tr><td class="mono">${esc(a)}${a === ledger.pool_address ? ' <span class="badge" data-i18n="expPoolTag">pool</span>' : ''}</td>` +
      `<td>${fc(acc.balance)}</td><td>${fc(acc.deposit)}</td><td>${claimTxt}</td><td>${fc(am.fair_share_estimate ?? '0')}</td>` +
      `<td>${am.strikes ?? 0} / ${am.clean ?? 0}</td><td>${lastTxt}</td></tr>`;
  }).join('');
  explorerHtml = `
<h2 data-i18n="expNetTitle">Network overview</h2>
<div class="grid">
 <div class="stat"><b><a href="https://mempool.space/block/${esc(gwState.tip.hash)}" target="_blank" rel="noopener">${gwState.tip.height}</a></b><span data-i18n="expTip">Bitcoin tip</span></div>
 <div class="stat"><b>${gwState.counted}</b><span data-i18n="expCounted">Counted height</span></div>
 <div class="stat"><b>${m.r}</b><span data-i18n="expRound">Current round</span></div>
 <div class="stat"><b>${m.start}–${m.claim_end} <span data-i18n="${m.window_open ? 'expOpen' : 'expClosed'}">${m.window_open ? 'open' : 'closed'}</span></b><span data-i18n="expWindow">Claim window (blocks)</span></div>
 <div class="stat"><b>${fc(m.S)}</b><span data-i18n="expStock">Mine stock (RESET)</span></div>
 <div class="stat"><b>${fc(m.last_guideline)}</b><span data-i18n="expGuideline">Round guideline (RESET)</span></div>
 <div class="stat"><b>${m.claim_count}</b><span data-i18n="expClaims">Claims this round</span></div>
 <div class="stat"><b>${fc(m.claim_deposit)}</b><span data-i18n="expClaimDeposit">Claiming deposit (RESET)</span></div>
</div>
<h2 data-i18n="expLastTitle">Last settled round</h2>
<div class="card">
 <span class="muted">#${lr.r ?? '—'}</span>
 ${lr.hash ? `<a class="mono" href="https://mempool.space/block/${esc(lr.hash)}" target="_blank" rel="noopener">${esc(lr.hash.slice(0, 20))}…</a>` : ''}
 <table>
  <tr><td data-i18n="expClaimsN">Claims</td><td>${lr.claims ?? '—'}</td></tr>
  <tr><td data-i18n="expDepositTotal">Total deposit (RESET)</td><td>${lr.deposit ? fc(lr.deposit) : '—'}</td></tr>
  <tr><td data-i18n="expPaid">Paid out (RESET)</td><td>${lr.paid ? fc(lr.paid) : '—'}</td></tr>
  <tr><td data-i18n="expPenalties">Penalties (RESET)</td><td>${lr.penalties ? fc(lr.penalties) : '—'}</td></tr>
  <tr><td data-i18n="expStockAfter">Stock after (RESET)</td><td>${lr.stock ? fc(lr.stock) : '—'}</td></tr>
 </table>
</div>
<h2 data-i18n="expWatchTitle">Watched addresses</h2>
<table><tr><th data-i18n="thContributor">Address</th><th data-i18n="thBalance">Balance</th><th data-i18n="thDeposit">Deposit</th><th data-i18n="thClaimNow">Claim this round</th><th data-i18n="thFair">Fair estimate</th><th data-i18n="thStrikes">Strikes / clean</th><th data-i18n="thLast">Last result</th></tr>
${watchRows}
</table>
<div class="card"><b data-i18n="lbTitle">Staking leaderboard</b>
<p class="muted" data-i18n="lbCardNote">Every staking address ranked by deposit, with balances — 15 per page on its own page.</p>
<a href="leaderboard.html"><button data-i18n="lbOpen">Open the leaderboard page</button></a></div>
<p class="muted" data-i18n="expSourceNote">Data: public gateway reset.openmayhem.ai, snapshotted when this page was generated${gwStale ? ' (gateway was unreachable — showing the last cached snapshot)' : ''}. Live lookup of arbitrary addresses needs a CORS proxy — that is stage 2.</p>`;
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RESET Mining Pool — mine together below the 0.1 minimum</title>
<script>try{document.documentElement.dataset.theme=localStorage.getItem('pool-theme')||'light'}catch(e){document.documentElement.dataset.theme='light'}</script>
<style>
 :root, :root[data-theme="light"]{--bg:#ffffff;--fg:#1f2328;--muted:#59636e;--card:#f6f8fa;--border:#d1d9e0;--border2:#e3e8ee;--code:#eaeef2;--input:#ffffff;--accent:#1a7f37;--warn:#9e6a03}
 :root[data-theme="dark"]{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--card:#161b22;--border:#30363d;--border2:#21262d;--code:#21262d;--input:#0d1117;--accent:#3fb950;--warn:#d29922}
 body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:24px;max-width:860px;margin-inline:auto;line-height:1.55}
 h1{font-size:26px;margin:0 0 4px} h2{font-size:18px;margin:22px 0 8px;border-bottom:1px solid var(--border);padding-bottom:6px}
 .muted{color:var(--muted)} .mono{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;word-break:break-all}
 .badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:13px;background:${funded ? '#1a7f3722;color:#3fb950;border:1px solid #1a7f37' : '#9e6a0322;color:#d29922;border:1px solid #9e6a03'}}
 .card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px;margin:12px 0}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
 .stat{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px}
 .stat b{display:block;font-size:20px} .stat span{color:var(--muted);font-size:13px}
 table{width:100%;border-collapse:collapse;font-size:14px} td,th{padding:7px 8px;border-bottom:1px solid var(--border2);text-align:left}
 button{background:var(--code);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:5px 12px;cursor:pointer}
 input{background:var(--input);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:7px 10px;width:min(560px,90%);font-family:ui-monospace,Menlo,monospace;font-size:13px}
 code{background:var(--code);padding:1px 5px;border-radius:4px;font-size:13px}
 a{color:var(--accent);word-break:break-all}
 ol,ul{padding-left:22px} .topbar{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
 .topbtns{display:flex;gap:6px;flex-shrink:0}
 .tabs{display:flex;gap:6px;flex-wrap:wrap;margin:14px 0 2px;border-bottom:1px solid var(--border);padding-bottom:10px}
 .tabbtn{font:inherit;background:var(--code);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:5px 12px;cursor:pointer;text-decoration:none;display:inline-block}
 .tabbtn.active{background:var(--fg);color:var(--bg);border-color:var(--fg);font-weight:600}
 section.tabpage{animation:fade .15s ease-in} @keyframes fade{from{opacity:.4}to{opacity:1}}
 .bar{height:8px;background:var(--code);border-radius:99px;overflow:hidden;margin-top:6px}
 .bar i{display:block;height:100%;background:var(--accent)}
</style></head><body>
<div class="topbar"><div>
<h1>RESET Mining Pool</h1>
<p class="muted" data-i18n="intro">Mine together below the 0.1 minimum. Small holders fund one pool address;
the pool locks ≥ 0.1, claims every round at exactly its fair share, and splits the proceeds pro-rata —
with accounting anyone can recompute.</p>
</div><div class="topbtns"><button id="themeBtn" onclick="toggleTheme()">☀️</button><button id="langBtn" onclick="toggleLang()">中文</button></div></div>
<p><span class="badge" data-i18n="${funded ? 'badgeActive' : 'badgeWaiting'}">${funded ? '● Active — pool is funded' : '● Waiting for funding — contributions open'}</span></p>
<nav class="tabs">
 <button class="tabbtn" data-tab="overview" onclick="showTab('overview')" data-i18n="tabOverview">Overview</button>
 <button class="tabbtn" data-tab="explorer" onclick="showTab('explorer')" data-i18n="tabExplorer">Explorer</button>
 <button class="tabbtn" data-tab="join" onclick="showTab('join')" data-i18n="tabJoin">Join</button>
 <button class="tabbtn" data-tab="ledger" onclick="showTab('ledger')" data-i18n="tabLedger">Ledger</button>
 <button class="tabbtn" data-tab="reports" onclick="showTab('reports')" data-i18n="tabReports">Reports</button>
 <button class="tabbtn" data-tab="verify" onclick="showTab('verify')" data-i18n="tabVerify">Verify</button>
 <a class="tabbtn" href="leaderboard.html" data-i18n="tabLeaderboard" style="text-decoration:none">Leaderboard</a>
</nav>
<section class="tabpage" id="tab-overview">

<div class="card"><div class="muted" data-i18n="poolAddrLabel">Pool address (send RESET here to join)</div>
<div class="mono" id="addr">${esc(ledger.pool_address)}</div>
<button onclick="navigator.clipboard.writeText(document.getElementById('addr').textContent)" data-i18n="copy">Copy address</button></div>

<div class="grid">
 <div class="stat"><b>${formatCoin(total)}</b><span data-i18n="statTotal">Total contributed (RESET)</span></div>
 <div class="stat"><b>${contributors.length}</b><span data-i18n="statContributors">Contributors</span></div>
 <div class="stat"><b>${lastPass ? esc(lastPass.deposit) : '—'}</b><span data-i18n="statDeposit">Locked deposit on-chain</span></div>
 <div class="stat"><b>${lastPass ? esc(lastPass.balance) : '—'}</b><span data-i18n="statBalance">Pool balance on-chain</span></div>
 <div class="stat"><b>${lastPass ? esc(lastPass.round) : '—'}</b><span data-i18n="statRound">Current Mine round</span></div>
 <div class="stat"><b>${ledger.rounds.length}</b><span data-i18n="statSettled">Rounds settled</span></div>
</div>

<h2 data-i18n="queryTitle">Check your position</h2>
<div class="card">
 <p class="muted" data-i18n="queryHint">Paste your RESET address (64 hex characters). The lookup runs entirely in your browser against the public ledger snapshot on this page — nothing is sent anywhere.</p>
 <input id="q" data-i18n-ph="queryPh" placeholder="Your RESET address, e.g. 2479c2e7…">
 <button onclick="lookup()" data-i18n="queryBtn">Look up</button>
 <div id="qResult" style="margin-top:12px"></div>
</div>

</section>
<section class="tabpage" id="tab-explorer">
${explorerHtml}
</section>
<section class="tabpage" id="tab-join">
<h2 data-i18n="joinTitle">How to join</h2>
<ol>
 <li data-i18n="join1">From your own RESET wallet, <b>transfer</b> any amount (e.g. 0.02) to the pool address above. You pay your own TNK transfer fee.</li>
 <li data-i18n="join2">Send the operator your address and the transfer reference. Your contribution is entered in the public ledger below <b>only after</b> it is visible on-chain.</li>
 <li data-i18n="join3">Done. Your share of every round = your contribution ÷ pool total, snapshotted per round. Earnings accumulate and are paid out once they reach <b>0.01</b>.</li>
</ol>

<h2 data-i18n="rulesTitle">Rules — the honest version</h2>
<ul>
 <li data-i18n="rule1"><b>Fee: 0.</b> Claim level: always exactly 1000 (fair share, never over — no strikes, no penalties).</li>
 <li data-i18n="rule2"><b>Pooling grants access, not extra yield.</b> The Mine pays linearly in deposit; the pool earns exactly what its combined deposit would earn solo.</li>
 <li data-i18n="rule3"><b>Exits take about a day:</b> leaving requires <code>unlock</code> plus the contract's 144-Bitcoin-block exit wait, then <code>withdraw</code>. No instant exits.</li>
 <li data-i18n="rule4"><b>Accounting is provable; custody is trusted.</b> RESET has no pool/multisig primitive, so the operator's key controls the funds. Every contribution, claim and payout is published and hash-chained so any cheating would be visible and attributable — but it cannot be made impossible. This is an experiment, not an investment; no returns are promised.</li>
</ul>

</section>
<section class="tabpage" id="tab-ledger">
<h2 data-i18n="ledgerTitle">Public ledger</h2>
<table><tr><th data-i18n="thContributor">Contributor</th><th data-i18n="thContributed">Contributed</th><th data-i18n="thPending">Pending payout</th><th data-i18n="thPaid">Paid total</th></tr>${contributorRows}
</table>

</section>
<section class="tabpage" id="tab-reports">
<h2 data-i18n="reportsTitle">Round reports</h2>
<table><tr><th data-i18n="thRound">Round</th><th data-i18n="thClaim">Claim received (RESET)</th><th data-i18n="thShares">Shares</th><th data-i18n="thHash">Report hash</th></tr>${reportRows}
</table>

</section>
<section class="tabpage" id="tab-verify">
<h2 data-i18n="verifyTitle">Verify it yourself</h2>
<div class="card">
<p data-i18n="verify1">Each round report publishes its full inputs: the contributor snapshot, the claim amount (match it against the
chain's claim record for the pool address and round), the fee and every share. Recompute:</p>
<p><code>share<sub>i</sub> = (claim − fee + carried dust) × deposit<sub>i</sub> ÷ total deposits</code></p>
<p data-i18n="verify2">Integer-division dust is carried into the next round, never kept. At any time:
<code>Σ claims = Σ pending + Σ paid + fees + carried dust</code>.
An open-source verifier that recomputes reports independently is available from the operator —
altering a single share makes verification fail.</p>
</div>

</section>
<p class="muted"><span data-i18n="footerGen">Snapshot time</span> <span id="snapshotTime">${updated}</span>. <span data-i18n="footerNote">It is a static snapshot — no live polling, no login, no tracking.</span></p>
<p class="muted"><span data-i18n="dataSource">Data source</span>: <a href="https://github.com/chilperbf24/reset-mining-pool" target="_blank" rel="noopener">https://github.com/chilperbf24/reset-mining-pool</a></p>

<script>
const SNAPSHOT = ${JSON.stringify(snapshotData)};
const T = {
en: { title: "RESET Mining Pool — mine together below the 0.1 minimum", langBtn: "中文",
 tabOverview: "Overview", tabJoin: "Join", tabLedger: "Ledger", tabReports: "Reports", tabVerify: "Verify", tabExplorer: "Explorer",
 themeToDark: "🌙 Night", themeToLight: "☀️ Day",
 expNetTitle: "Network overview", expTip: "Bitcoin tip", expCounted: "Counted height", expRound: "Current round",
 expWindow: "Claim window (blocks)", expOpen: "open", expClosed: "closed", expStock: "Mine stock (RESET)",
 expGuideline: "Round guideline (RESET)", expClaims: "Claims this round", expClaimDeposit: "Claiming deposit (RESET)",
 expLastTitle: "Last settled round", expClaimsN: "Claims", expDepositTotal: "Total deposit (RESET)",
 expPaid: "Paid out (RESET)", expPenalties: "Penalties (RESET)", expStockAfter: "Stock after (RESET)",
 expWatchTitle: "Watched addresses", thBalance: "Balance", thDeposit: "Deposit", thClaimNow: "Claim this round",
 thFair: "Fair estimate", thStrikes: "Strikes / clean", thLast: "Last result", expPoolTag: "pool",
 expDown: "Gateway unreachable when this page was generated — try again later.",
 lbTitle: "Staking leaderboard", lbCardNote: "Every staking address ranked by deposit, with balances — 15 per page on its own page.", lbOpen: "Open the leaderboard page", tabLeaderboard: "Leaderboard", lbMinersN: "Addresses listed", lbStakers: "Staking addresses",
 lbTotalStaked: "Total staked (RESET)", lbSearchHint: "Search the full leaderboard by address:",
 thRank: "#", thExiting: "Exiting", thClaimed: "Claimed", lbRank: "Rank",
 lbTopNote: "Top 100 by deposit. The full list is embedded in this page — use the search above to find any staking address and its rank.",
 lbNotFound: "This address has no deposit in the current snapshot — it is not on the staking leaderboard.",
 expSourceNote: "Data: public gateway reset.openmayhem.ai, snapshotted when this page was generated. Live lookup of arbitrary addresses needs a CORS proxy — that is stage 2.",
 intro: "Mine together below the 0.1 minimum. Small holders fund one pool address; the pool locks ≥ 0.1, claims every round at exactly its fair share, and splits the proceeds pro-rata — with accounting anyone can recompute.",
 badgeActive: "● Active — pool is funded", badgeWaiting: "● Waiting for funding — contributions open",
 poolAddrLabel: "Pool address (send RESET here to join)", copy: "Copy address",
 statTotal: "Total contributed (RESET)", statContributors: "Contributors", statDeposit: "Locked deposit on-chain",
 statBalance: "Pool balance on-chain", statRound: "Current Mine round", statSettled: "Rounds settled",
 queryTitle: "Check your position",
 queryHint: "Paste your RESET address (64 hex characters). The lookup runs entirely in your browser against the public ledger snapshot on this page — nothing is sent anywhere.",
 queryPh: "Your RESET address, e.g. 2479c2e7…", queryBtn: "Look up",
 qInvalid: "That does not look like a RESET address — it should be exactly 64 hexadecimal characters.",
 qNotFound: "This address is not in the pool ledger as of the snapshot below. If you just transferred, it appears after the operator verifies the transfer on-chain and regenerates this page.",
 qFound: "Found in the pool ledger:", qShare: "Share of pool", qContributed: "Contributed", qPending: "Pending payout",
 qPaid: "Already paid out", qProgress: "Progress to the 0.01 payout threshold", qReady: "Threshold reached — this payout is due in the next payout batch.",
 joinTitle: "How to join",
 join1: "From your own RESET wallet, <b>transfer</b> any amount (e.g. 0.02) to the pool address above. You pay your own TNK transfer fee.",
 join2: "Send the operator your address and the transfer reference. Your contribution is entered in the public ledger below <b>only after</b> it is visible on-chain.",
 join3: "Done. Your share of every round = your contribution ÷ pool total, snapshotted per round. Earnings accumulate and are paid out once they reach <b>0.01</b>.",
 rulesTitle: "Rules — the honest version",
 rule1: "<b>Fee: 0.</b> Claim level: always exactly 1000 (fair share, never over — no strikes, no penalties).",
 rule2: "<b>Pooling grants access, not extra yield.</b> The Mine pays linearly in deposit; the pool earns exactly what its combined deposit would earn solo.",
 rule3: "<b>Exits take about a day:</b> leaving requires <code>unlock</code> plus the contract's 144-Bitcoin-block exit wait, then <code>withdraw</code>. No instant exits.",
 rule4: "<b>Accounting is provable; custody is trusted.</b> RESET has no pool/multisig primitive, so the operator's key controls the funds. Every contribution, claim and payout is published and hash-chained so any cheating would be visible and attributable — but it cannot be made impossible. This is an experiment, not an investment; no returns are promised.",
 ledgerTitle: "Public ledger", thContributor: "Contributor", thContributed: "Contributed", thPending: "Pending payout", thPaid: "Paid total",
 noContributors: "No contributors yet — be the first.",
 reportsTitle: "Round reports", thRound: "Round", thClaim: "Claim received (RESET)", thShares: "Shares", thHash: "Report hash",
 noRounds: "No rounds settled yet.",
 verifyTitle: "Verify it yourself",
 verify1: "Each round report publishes its full inputs: the contributor snapshot, the claim amount (match it against the chain's claim record for the pool address and round), the fee and every share. Recompute:",
 verify2: "Integer-division dust is carried into the next round, never kept. At any time: <code>Σ claims = Σ pending + Σ paid + fees + carried dust</code>. An open-source verifier that recomputes reports independently is available from the operator — altering a single share makes verification fail.",
 footerGen: "Snapshot time", footerNote: "It is a static snapshot — no live polling, no login, no tracking.", dataSource: "Data source" },
zh: { title: "RESET 拼池 — 不够 0.1 也能一起挖", langBtn: "English",
 tabOverview: "概览", tabJoin: "入池", tabLedger: "账本", tabReports: "报告", tabVerify: "验证", tabExplorer: "浏览器",
 themeToDark: "🌙 夜晚", themeToLight: "☀️ 白天",
 expNetTitle: "全网概览", expTip: "比特币最新高度", expCounted: "已计数高度", expRound: "当前轮次",
 expWindow: "Claim 窗口（区块）", expOpen: "开放中", expClosed: "已关闭", expStock: "Mine 存量（RESET）",
 expGuideline: "本轮指导额（RESET）", expClaims: "本轮 claim 数", expClaimDeposit: "本轮锁仓总和（RESET）",
 expLastTitle: "上一结算轮", expClaimsN: "参与地址数", expDepositTotal: "锁仓总和（RESET）",
 expPaid: "总发放（RESET）", expPenalties: "罚款（RESET）", expStockAfter: "结算后存量（RESET）",
 expWatchTitle: "关注地址", thBalance: "余额", thDeposit: "锁仓", thClaimNow: "本轮 claim",
 thFair: "预计公平份额", thStrikes: "罚分 / 干净轮", thLast: "上轮结果", expPoolTag: "池子",
 expDown: "生成本页时网关连不上——请稍后再看。",
 lbTitle: "质押榜", lbCardNote: "全部质押地址按质押额排名，带余额——独立页面，每页 15 名。", lbOpen: "打开质押榜页面", tabLeaderboard: "质押榜", lbMinersN: "上榜地址数", lbStakers: "质押地址数",
 lbTotalStaked: "质押总和（RESET）", lbSearchHint: "在完整质押榜里按地址搜索：",
 thRank: "名次", thExiting: "退出中", thClaimed: "本轮已 claim", lbRank: "名次",
 lbTopNote: "按质押额取前 100 名。完整名单已嵌在本页里——用上方搜索可查任意质押地址的名次。",
 lbNotFound: "该地址在当前快照里没有质押——不在质押榜上。",
 expSourceNote: "数据来源：公开网关 reset.openmayhem.ai，页面生成时抓取的快照。任意地址的实时查询需要跨域代理——那是第二阶段。",
 intro: "不够 0.1 门槛也能一起挖：小额持有人共同出资到一个池地址，池子锁仓 ≥ 0.1、每轮按公平份额 claim、收益按出资比例分——账目任何人都可以复算。",
 badgeActive: "● 运行中 — 池子已注资", badgeWaiting: "● 等待注资 — 正在开放出资",
 poolAddrLabel: "池地址（转 RESET 到这里即可入池）", copy: "复制地址",
 statTotal: "出资总额（RESET）", statContributors: "出资人数", statDeposit: "链上锁仓",
 statBalance: "链上池余额", statRound: "当前挖矿轮次", statSettled: "已结算轮次",
 queryTitle: "查询我的份额",
 queryHint: "粘贴你的 RESET 地址（64 位十六进制）。查询完全在你的浏览器里对本页的公开账本快照进行，不会把地址发送到任何地方。",
 queryPh: "你的 RESET 地址，如 2479c2e7…", queryBtn: "查询",
 qInvalid: "这不像 RESET 地址——应该是正好 64 位十六进制字符。",
 qNotFound: "截至下方快照时间，该地址不在池账本里。如果你刚转账，要等池主在链上核对到账并重新生成页面后才会出现。",
 qFound: "在池账本中找到：", qShare: "占池份额", qContributed: "已出资", qPending: "待分收益",
 qPaid: "已分发", qProgress: "距 0.01 分发门槛的进度", qReady: "已达门槛——这笔收益会进入下一批分发。",
 joinTitle: "怎么入池",
 join1: "用你自己的 RESET 钱包，往上面的池地址 <b>transfer</b> 任意金额（如 0.02）。TNK 手续费由你自己出。",
 join2: "把你的地址和转账凭证发给池主。你的出资<b>只有在链上可见后</b>才会被记进下方公开账本。",
 join3: "完事。每轮你的份额 = 你的出资 ÷ 池子总额，按轮快照定格；收益累积到 <b>0.01</b> 后分发。",
 rulesTitle: "规则——实话版",
 rule1: "<b>手续费：0。</b>Claim 永远只打 level 1000（只要公平份额，绝不超额——没有罚分、没有罚款）。",
 rule2: "<b>拼池只解决准入，不放大收益。</b>Mine 按锁仓线性付酬，池子赚到的就是合并锁仓能赚到的，一分不多。",
 rule3: "<b>退池约需一天：</b>退出要走 <code>unlock</code> + 合约的 144 个比特币块等待期，再 <code>withdraw</code>。不能秒退。",
 rule4: "<b>账目可证明，托管靠信任。</b>RESET 没有池子/多签原语，池主的私钥控制资金。每一笔出资、claim 和分发都会公开并做哈希链存证，作弊一定会被发现并可追溯——但无法从根本上杜绝。这是个实验，不是投资，不承诺任何收益。",
 ledgerTitle: "公开账本", thContributor: "出资人", thContributed: "已出资", thPending: "待分收益", thPaid: "已分发总额",
 noContributors: "尚无人出资——来做第一个。",
 reportsTitle: "轮次报告", thRound: "轮次", thClaim: "本轮 claim 到账（RESET）", thShares: "分账份数", thHash: "报告哈希",
 noRounds: "尚无已结算轮次。",
 verifyTitle: "自己验一遍",
 verify1: "每份轮次报告都会公开全部输入：出资人快照、claim 金额（可与链上该轮池地址的 claim 记录对照）、手续费和每一份分账。复算公式：",
 verify2: "整数除法的灰尘结转到下一轮，绝不私吞。任何时刻都应有：<code>Σ claim = Σ 待分 + Σ 已分发 + 手续费 + 结转灰尘</code>。开源验证器可向池主索取——改动任何一份分账，验证都会失败。",
 footerGen: "快照时间", footerNote: "这是静态快照——不实时轮询、不登录、不追踪。", dataSource: "数据来源于" }
};
let lang = localStorage.getItem('pool-lang') || 'en'; // first visit always opens in English
let lastQuery = '';
function fmt(u) { const b = BigInt(u); return (b / 100000000n) + '.' + (b % 100000000n).toString().padStart(8, '0'); }
function snapshotTimeText() { const d = new Date(SNAPSHOT.snapshot_ms); const p = n => String(n).padStart(2, '0');
  if (lang === 'zh') { const b = new Date(d.getTime() + 8 * 3600000);
    return b.getUTCFullYear() + '-' + p(b.getUTCMonth() + 1) + '-' + p(b.getUTCDate()) + ' ' + p(b.getUTCHours()) + ':' + p(b.getUTCMinutes()) + ':' + p(b.getUTCSeconds()) + ' GMT+8'; }
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) + ' UTC'; }
function applyLang() {
  const t = T[lang];
  document.querySelectorAll('[data-i18n]').forEach(el => { const v = t[el.dataset.i18n]; if (v != null) el.innerHTML = v; });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t[el.dataset.i18nPh]; });
  document.getElementById('langBtn').textContent = t.langBtn;
  syncThemeBtn();
  const stEl = document.getElementById('snapshotTime'); if (stEl) stEl.textContent = snapshotTimeText();
  document.title = t.title;
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  if (lastQuery) lookup();
}
function toggleLang() { lang = lang === 'zh' ? 'en' : 'zh'; localStorage.setItem('pool-lang', lang); applyLang(); }
function syncThemeBtn() { const dark = document.documentElement.dataset.theme === 'dark'; document.getElementById('themeBtn').textContent = dark ? T[lang].themeToLight : T[lang].themeToDark; }
function toggleTheme() { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; try { localStorage.setItem('pool-theme', next); } catch (e) {} syncThemeBtn(); }
function showTab(name) { const names = ['overview', 'explorer', 'join', 'ledger', 'reports', 'verify']; if (!names.includes(name)) name = 'overview';
  document.querySelectorAll('section.tabpage').forEach(s => { s.style.display = s.id === 'tab-' + name ? '' : 'none'; });
  document.querySelectorAll('.tabbtn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  try { localStorage.setItem('pool-tab', name); } catch (e) {} try { history.replaceState(null, '', '#' + name); } catch (e) {} }
function lookup() {
  const t = T[lang];
  const addr = document.getElementById('q').value.trim().toLowerCase();
  lastQuery = addr;
  const box = document.getElementById('qResult');
  if (!/^[0-9a-f]{64}$/.test(addr)) { box.innerHTML = '<span style="color:var(--warn)">' + t.qInvalid + '</span>'; return; }
  const c = SNAPSHOT.contributors[addr];
  if (!c) { box.innerHTML = '<span style="color:var(--warn)">' + t.qNotFound + '</span><br><span class="muted">' + t.footerGen + ': ' + snapshotTimeText() + '</span>'; return; }
  const total = BigInt(SNAPSHOT.total_units), contrib = BigInt(c.contributed_units);
  const sharePct = total === 0n ? '0.00' : (Number(contrib * 1000000n / total) / 10000).toFixed(2);
  const th = BigInt(SNAPSHOT.threshold_units), pend = BigInt(c.pending_units);
  const prog = th === 0n ? 100 : Math.min(100, Number(pend * 100n / th));
  box.innerHTML = '<b>' + t.qFound + '</b> <span class="mono">' + addr + '</span>' +
    '<table><tr><td>' + t.qContributed + '</td><td>' + fmt(contrib) + ' RESET</td></tr>' +
    '<tr><td>' + t.qShare + '</td><td>' + sharePct + '%</td></tr>' +
    '<tr><td>' + t.qPending + '</td><td>' + fmt(pend) + ' RESET</td></tr>' +
    '<tr><td>' + t.qPaid + '</td><td>' + fmt(c.paid_units) + ' RESET</td></tr></table>' +
    '<div style="margin-top:8px">' + t.qProgress + ' — ' + prog + '%<div class="bar"><i style="width:' + prog + '%"></i></div></div>' +
    (pend >= th ? '<p style="color:var(--accent)">' + t.qReady + '</p>' : '');
}
document.getElementById('q').addEventListener('keydown', e => { if (e.key === 'Enter') lookup(); });
applyLang();
showTab((location.hash || '').slice(1) || (() => { try { return localStorage.getItem('pool-tab'); } catch (e) { return null; } })() || 'overview');
</script>
</body></html>`;

mkdirSync(`${ROOT}/docs`, { recursive: true });
writeFileSync(`${ROOT}/docs/index.html`, html);
console.log(JSON.stringify({ ok: true, file: `${ROOT}/docs/index.html`, funded, contributors: contributors.length, live_reports: liveReports.length, updated }));

// ---------------------------------------------------------------------------
// Standalone staking-leaderboard page (docs/leaderboard.html).
// Same static rules as the main page: everything is embedded, language/theme
// choices share localStorage keys with the main page, 20 rows per page are
// rendered client-side from the embedded list (which now includes balances).
const lbRows = leaders.map(r => [r[0], String(r[1]), balances[r[0]] ?? null, String(r[2]), r[3], r[4], r[5], r[6], String(r[7])]);
const lbPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RESET Mining Pool — Staking Leaderboard</title>
<script>try{document.documentElement.dataset.theme=localStorage.getItem('pool-theme')||'light'}catch(e){document.documentElement.dataset.theme='light'}</script>
<style>
 :root, :root[data-theme="light"]{--bg:#ffffff;--fg:#1f2328;--muted:#59636e;--card:#f6f8fa;--border:#d1d9e0;--border2:#e3e8ee;--code:#eaeef2;--input:#ffffff;--accent:#1a7f37;--warn:#9e6a03;--hl:#fff3cd}
 :root[data-theme="dark"]{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--card:#161b22;--border:#30363d;--border2:#21262d;--code:#21262d;--input:#0d1117;--accent:#3fb950;--warn:#d29922;--hl:#3a2f04}
 body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:24px;max-width:860px;margin-inline:auto;line-height:1.55}
 h1{font-size:24px;margin:0 0 4px} h2{font-size:18px;margin:22px 0 8px}
 .muted{color:var(--muted)} .mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all}
 .card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px;margin:12px 0}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
 .stat{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px}
 .stat b{display:block;font-size:20px} .stat span{color:var(--muted);font-size:13px}
 table{width:100%;border-collapse:collapse;font-size:13.5px} td,th{padding:6px 7px;border-bottom:1px solid var(--border2);text-align:left}
 tr.hl td{background:var(--hl)}
 button{background:var(--code);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:5px 12px;cursor:pointer}
 button:disabled{opacity:.45;cursor:default}
 input{background:var(--input);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:7px 10px;width:min(560px,90%);font-family:ui-monospace,Menlo,monospace;font-size:13px}
 a{color:var(--accent)} .topbar{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
 .topbtns{display:flex;gap:6px;flex-shrink:0} .pager{display:flex;gap:8px;align-items:center;margin:12px 0;flex-wrap:wrap}
 .badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;background:#9e6a0322;color:var(--warn);border:1px solid var(--warn)}
</style></head><body>
<div class="topbar"><div>
<h1 data-i18n="title">Staking Leaderboard</h1>
<p class="muted"><a href="index.html" data-i18n="back">← Back to the pool page</a></p>
</div><div class="topbtns"><button id="themeBtn" onclick="toggleTheme()">🌙</button><button id="langBtn" onclick="toggleLang()">中文</button></div></div>

<div class="grid">
 <div class="stat"><b>${minersTotal}</b><span data-i18n="lbMinersN">Addresses listed</span></div>
 <div class="stat"><b>${leaders.length}</b><span data-i18n="lbStakers">Staking addresses</span></div>
 <div class="stat"><b>${formatCoin(totalStaked)}</b><span data-i18n="lbTotalStaked">Total staked (RESET)</span></div>
</div>

<div class="card">
 <p class="muted" data-i18n="lbSearchHint">Search the full leaderboard by address:</p>
 <input id="lbq" data-i18n-ph="searchPh" placeholder="Your RESET address, e.g. 2479c2e7…">
 <button onclick="lbLookup()" data-i18n="searchBtn">Look up</button>
 <div id="lbResult" style="margin-top:10px"></div>
</div>

<table><thead><tr><th data-i18n="thRank">#</th><th data-i18n="thAddress">Address</th><th data-i18n="thDeposit">Deposit</th><th data-i18n="thBalance">Balance</th><th data-i18n="thExiting">Exiting</th><th data-i18n="thStrikes">Strikes / clean</th><th data-i18n="thClaimed">Claimed</th><th data-i18n="thLast">Last result</th></tr></thead>
<tbody id="lbBody"></tbody></table>
<div class="pager">
 <button id="pgPrev" onclick="goPage(lbPage - 1)" data-i18n="prev">← Prev</button>
 <span id="pgInfo" class="muted"></span>
 <button id="pgNext" onclick="goPage(lbPage + 1)" data-i18n="next">Next →</button>
</div>

<p class="muted"><span data-i18n="footerGen">Snapshot time</span> <span id="snapshotTime">${updated}</span>. <span data-i18n="footerNote">It is a static snapshot — no live polling, no login, no tracking.</span></p>
<p class="muted"><span data-i18n="dataSource">Data source</span>: <a href="https://github.com/chilperbf24/reset-mining-pool" target="_blank" rel="noopener">https://github.com/chilperbf24/reset-mining-pool</a></p>

<script>
const LEADERS = ${JSON.stringify(lbRows)};
const POOL_ADDR = ${JSON.stringify(ledger.pool_address)};
const SNAPSHOT_MS = ${Date.now()};
const PAGE_SIZE = 15;
const T = {
en: { title: "Staking Leaderboard", langBtn: "中文", back: "← Back to the pool page",
 themeToDark: "🌙 Night", themeToLight: "☀️ Day",
 lbMinersN: "Addresses listed", lbStakers: "Staking addresses", lbTotalStaked: "Total staked (RESET)",
 lbSearchHint: "Search the full leaderboard by address:", searchPh: "Your RESET address, e.g. 2479c2e7…", searchBtn: "Look up",
 thRank: "#", thAddress: "Address", thDeposit: "Deposit", thBalance: "Balance", thExiting: "Exiting",
 thStrikes: "Strikes / clean", thClaimed: "Claimed", thLast: "Last result", poolTag: "pool",
 prev: "← Prev", next: "Next →", pageOf: (a, b) => "Page " + a + " of " + b,
 qInvalid: "That does not look like a RESET address — it should be exactly 64 hexadecimal characters.",
 lbNotFound: "This address has no deposit in the current snapshot — it is not on the staking leaderboard.",
 lbRank: "Rank", footerGen: "Snapshot time", dataSource: "Data source",
 footerNote: "It is a static snapshot — no live polling, no login, no tracking." },
zh: { title: "质押榜", langBtn: "English", back: "← 返回拼池主页",
 themeToDark: "🌙 夜晚", themeToLight: "☀️ 白天",
 lbMinersN: "上榜地址数", lbStakers: "质押地址数", lbTotalStaked: "质押总和（RESET）",
 lbSearchHint: "在完整质押榜里按地址搜索：", searchPh: "你的 RESET 地址，如 2479c2e7…", searchBtn: "查询",
 thRank: "名次", thAddress: "地址", thDeposit: "质押", thBalance: "余额", thExiting: "退出中",
 thStrikes: "罚分 / 干净轮", thClaimed: "本轮已 claim", thLast: "上轮结果", poolTag: "池子",
 prev: "← 上一页", next: "下一页 →", pageOf: (a, b) => "第 " + a + " / " + b + " 页",
 qInvalid: "这不像 RESET 地址——应该是正好 64 位十六进制字符。",
 lbNotFound: "该地址在当前快照里没有质押——不在质押榜上。",
 lbRank: "名次", footerGen: "快照时间", dataSource: "数据来源于",
 footerNote: "这是静态快照——不实时轮询、不登录、不追踪。" }
};
let lang = localStorage.getItem('pool-lang') || 'en'; // first visit always opens in English
let lbPage = 0, hlRank = -1, lastLbQuery = '';
function fmt(u) { if (u == null) return '—'; const b = BigInt(u); return (b / 100000000n) + '.' + (b % 100000000n).toString().padStart(8, '0'); }
function snapshotTimeText() { const d = new Date(SNAPSHOT_MS); const p = n => String(n).padStart(2, '0');
  if (lang === 'zh') { const b = new Date(d.getTime() + 8 * 3600000);
    return b.getUTCFullYear() + '-' + p(b.getUTCMonth() + 1) + '-' + p(b.getUTCDate()) + ' ' + p(b.getUTCHours()) + ':' + p(b.getUTCMinutes()) + ':' + p(b.getUTCSeconds()) + ' GMT+8'; }
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) + ' UTC'; }
function syncThemeBtn() { const dark = document.documentElement.dataset.theme === 'dark'; document.getElementById('themeBtn').textContent = dark ? T[lang].themeToLight : T[lang].themeToDark; }
function toggleTheme() { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; try { localStorage.setItem('pool-theme', next); } catch (e) {} syncThemeBtn(); }
function toggleLang() { lang = lang === 'zh' ? 'en' : 'zh'; localStorage.setItem('pool-lang', lang); applyLang(); }
function renderLb() {
  const pages = Math.max(1, Math.ceil(LEADERS.length / PAGE_SIZE));
  lbPage = Math.min(Math.max(0, lbPage), pages - 1);
  const t = T[lang];
  const rows = LEADERS.slice(lbPage * PAGE_SIZE, lbPage * PAGE_SIZE + PAGE_SIZE);
  document.getElementById('lbBody').innerHTML = rows.map((r, k) => {
    const rank = lbPage * PAGE_SIZE + k + 1;
    return '<tr id="lbrow-' + rank + '"' + (rank === hlRank ? ' class="hl"' : '') + '><td>' + rank + '</td>' +
      '<td class="mono">' + r[0] + (r[0] === POOL_ADDR ? ' <span class="badge">' + t.poolTag + '</span>' : '') + '</td>' +
      '<td>' + fmt(r[1]) + '</td><td>' + fmt(r[2]) + '</td><td>' + fmt(r[3]) + '</td>' +
      '<td>' + r[4] + ' / ' + r[5] + '</td><td>' + (r[6] ? '✓' : '—') + '</td>' +
      '<td>' + (r[7] ? '#' + r[7] + ': ' + fmt(r[8]) : '—') + '</td></tr>';
  }).join('');
  document.getElementById('pgInfo').textContent = t.pageOf(lbPage + 1, pages);
  document.getElementById('pgPrev').disabled = lbPage <= 0;
  document.getElementById('pgNext').disabled = lbPage >= pages - 1;
}
function goPage(p) { lbPage = p; hlRank = -1; renderLb(); }
function lbLookup() {
  const t = T[lang];
  const addr = document.getElementById('lbq').value.trim().toLowerCase();
  lastLbQuery = addr;
  const box = document.getElementById('lbResult');
  if (!/^[0-9a-f]{64}$/.test(addr)) { box.innerHTML = '<span style="color:var(--warn)">' + t.qInvalid + '</span>'; return; }
  const i = LEADERS.findIndex(r => r[0] === addr);
  if (i < 0) { box.innerHTML = '<span style="color:var(--warn)">' + t.lbNotFound + '</span>'; return; }
  hlRank = i + 1;
  lbPage = Math.floor(i / PAGE_SIZE);
  renderLb();
  box.innerHTML = '<b>' + t.lbRank + ' #' + (i + 1) + '</b> — ' + t.thDeposit + ' ' + fmt(LEADERS[i][1]) + ' RESET · ' + t.thBalance + ' ' + fmt(LEADERS[i][2]) + ' RESET';
  const el = document.getElementById('lbrow-' + (i + 1)); if (el) el.scrollIntoView({ block: 'center' });
}
function applyLang() {
  const t = T[lang];
  document.querySelectorAll('[data-i18n]').forEach(el => { const v = t[el.dataset.i18n]; if (v != null) el.innerHTML = v; });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t[el.dataset.i18nPh]; });
  document.getElementById('langBtn').textContent = t.langBtn;
  document.title = 'RESET Mining Pool — ' + t.title;
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.getElementById('snapshotTime').textContent = snapshotTimeText();
  syncThemeBtn();
  renderLb();
  if (lastLbQuery) lbLookup();
}
document.getElementById('lbq').addEventListener('keydown', e => { if (e.key === 'Enter') lbLookup(); });
applyLang();
</script>
</body></html>`;
writeFileSync(`${ROOT}/docs/leaderboard.html`, lbPage);
console.log(JSON.stringify({ ok: true, file: `${ROOT}/docs/leaderboard.html`, leaders: lbRows.length, balances_fetched: Object.values(balances).filter(v => v != null).length }));

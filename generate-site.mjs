#!/usr/bin/env node
// Generates the pool's public page as ONE static HTML file (docs/index.html).
// - Reads only local files (ledger, worker log, published reports); the page
//   itself makes NO network calls. Language switching and the address lookup
//   both run locally in the visitor's browser against data embedded here.
// - The address lookup therefore reflects the ledger snapshot at generation
//   time; the page stamps when it was generated. Regenerate after each
//   settlement / contribution.
import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { formatCoin, totalContributed } from './lib/pool.mjs';
import { publicExitCases } from './lib/exit-public.mjs';

// Root = this script's own directory, so the generator runs anywhere
// (a maintainer's machine or a GitHub Actions runner checkout).
const ROOT = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const ledger = JSON.parse(readFileSync(`${ROOT}/state/live-ledger.json`, 'utf8'));

// Calculation-registry Worker endpoint (worker/ in this repo — the
// calculator files every computation there so inflows can be reconciled
// against backend records; see worker/README.md). Deployed 2026-10-21 —
// see the "Deployed" section of worker/README.md. Reports from the page
// are fire-and-forget — the calculator itself never depends on the
// endpoint being reachable.
const REGISTRY_ENDPOINT = 'https://reset-pool-registry.tyrodcamp.workers.dev/calc';
// Exit requests go to the same Worker (POST /exit, POST /exit/verify —
// the signed-message flow documented in lib/exit.mjs).
const REGISTRY_EXIT_ENDPOINT = REGISTRY_ENDPOINT.replace(/\/calc$/, '/exit');
const REGISTRY_JOIN_ENDPOINT = REGISTRY_ENDPOINT.replace(/\/calc$/, '/join');

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
if (gwState) { try { writeFileSync(CACHE, JSON.stringify({ fetched_at: new Date().toISOString(), state: gwState, accounts: gwAccounts, miners: minersAll, miners_total: minersTotal, accounts_full: cachePrev.accounts_full ?? {}, accounts_fetched_at: cachePrev.accounts_fetched_at ?? null }, null, 2)); } catch {} }
else if (existsSync(CACHE)) { const c = JSON.parse(readFileSync(CACHE, 'utf8')); gwState = c.state; Object.assign(gwAccounts, c.accounts); minersAll = c.miners ?? []; minersTotal = c.miners_total ?? minersAll.length; gwStale = true; }
// Staking subset (deposit > 0) drives the headline stats; the leaderboard
// itself lists EVERY miner address (deposit desc, exiting desc, address),
// including zero-deposit rows (exiting only, or claimed-then-unlocked).
const leaders = minersAll.filter(r => Number(r[1]) > 0)
  .sort((a, b) => Number(b[1]) - Number(a[1]) || (a[0] < b[0] ? -1 : 1));
const totalStaked = leaders.reduce((s, r) => s + BigInt(r[1]), 0n);
const allMiners = [...minersAll].sort((a, b) =>
  Number(b[1]) - Number(a[1]) || Number(b[2]) - Number(a[2]) || (a[0] < b[0] ? -1 : 1));

// Full accounts for every listed address (leaderboard balance column and the
// address detail page): one /v1/account call per address — the same call the
// balance sweep used, just keeping the whole (trimmed) reply. Paced under
// the gateway's default 240 req/min per-IP limit; cached for 30 minutes.
const trimAccount = j => (j ? { balance: j.balance, deposit: j.deposit, exits: j.exits ?? [],
  moves_this_height: j.moves_this_height ?? 0, mine: j.mine ?? null } : null);
const accCache = cachePrev.accounts_full ?? {};
const accCacheAt = Date.parse(cachePrev.accounts_fetched_at ?? '') || 0;
let accountsFull = {};
if (!gwState && Object.keys(accCache).length) accountsFull = accCache;
else if (gwState && minersAll.length && (Date.now() - accCacheAt < 30 * 60000) && minersAll.every(r => accCache[r[0]])) {
  for (const r of minersAll) accountsFull[r[0]] = accCache[r[0]];
} else if (gwState && minersAll.length) {
  const sleepMs = ms => new Promise(r => setTimeout(r, ms));
  async function fetchAccount(addr) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(`${GW}/v1/account/${addr}`, { signal: AbortSignal.timeout(15000) });
        if (r.status === 429) { await sleepMs(30000); continue; }
        if (!r.ok) return null;
        return trimAccount(await r.json());
      } catch { await sleepMs(2000); }
    }
    return null;
  }
  const CHUNK = 50, SPAN = 14000;
  for (let i = 0; i < minersAll.length; i += CHUNK) {
    const t0 = Date.now();
    const part = minersAll.slice(i, i + CHUNK);
    const vals = await Promise.all(part.map(r => fetchAccount(r[0])));
    part.forEach((r, k) => { accountsFull[r[0]] = vals[k] ?? accCache[r[0]] ?? null; });
    const dt = Date.now() - t0;
    if (i + CHUNK < minersAll.length && dt < SPAN) await sleepMs(SPAN - dt);
  }
  try { writeFileSync(CACHE, JSON.stringify({ fetched_at: new Date().toISOString(), state: gwState, accounts: gwAccounts, miners: minersAll, miners_total: minersTotal, accounts_full: accountsFull, accounts_fetched_at: new Date().toISOString() }, null, 2)); } catch {}
}
const balances = Object.fromEntries(Object.entries(accountsFull).map(([a, j]) => [a, j?.balance ?? null]));


// --- Snapshot archive (append-only deltas) ----------------------------------
// One file per UTC day: history/<YYYY-MM-DD>.jsonl. The day's first run
// writes a full baseline line; every later run appends ONE line holding the
// network state plus only the addresses whose record changed since the
// previous generation (diffed against the gateway cache, which the bot
// commits together with this file, so the chain stays consistent). Any
// point-in-time state replays as baseline + deltas. A per-address record is
// a fixed-order tuple:
//   [deposit, exiting, strikes, clean, claimed, lastRound, lastAmount,
//    lastPenalty, balance, exits, claimLevel, lastFair]
// Skipped entirely on the stale-cache fallback (nothing new was fetched).
if (!gwStale && gwState) {
  try {
    const tupleOf = (row, acc) => [String(row[1]), String(row[2]), row[3], row[4], row[5], row[6],
      String(row[7]), String(row[8] ?? '0'), acc?.balance ?? null, acc?.exits ?? [],
      acc?.mine?.claim?.q ?? 0, acc?.mine?.last_result?.fair ?? null];
    const cur = {};
    for (const r of minersAll) cur[r[0]] = tupleOf(r, accountsFull[r[0]]);
    const prevAcc = cachePrev.accounts_full ?? {};
    const prev = {};
    for (const r of (cachePrev.miners ?? [])) prev[r[0]] = tupleOf(r, prevAcc[r[0]]);
    const day = new Date().toISOString().slice(0, 10);
    const file = `${ROOT}/history/${day}.jsonl`;
    mkdirSync(`${ROOT}/history`, { recursive: true });
    const t = new Date().toISOString();
    if (!existsSync(file)) {
      appendFileSync(file, JSON.stringify({ t, full: 1, state: gwState, miners_total: minersTotal, rec: cur }) + '\n');
    } else {
      const ch = {};
      for (const a of Object.keys(cur)) if (JSON.stringify(cur[a]) !== JSON.stringify(prev[a])) ch[a] = cur[a];
      const del = Object.keys(prev).filter(a => !(a in cur));
      appendFileSync(file, JSON.stringify({ t, state: gwState, miners_total: minersTotal, ch, ...(del.length ? { del } : {}) }) + '\n');
    }
  } catch {}
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
  dissolved: ledger.dissolved ?? null,
  updated,
  snapshot_ms: Date.now(),
  contributors: Object.fromEntries(contributors.map(([a, c]) => [a, {
    contributed_units: c.contributed, pending_units: c.pending, paid_units: c.paid_total,
    closed: c.closed ? { total_units: c.closed.total_units, principal_units: c.closed.principal_units,
      earnings_units: c.closed.earnings_units, at: c.closed.at } : null }])),
};

// --- Exit-case progress data (exit page stage 5): the published public
// summary (state/exit-cases.json — publish-state.mjs refreshes it from
// the executor's state/exits.json on every pass); when the summary has
// not been generated yet, project the local executor state directly.
// snapshotCounted is the gateway height the "blocks remaining" math on
// the exit page is counted against (same snapshot as everything else).
let exitCasesPub = [];
try { exitCasesPub = JSON.parse(readFileSync(`${ROOT}/state/exit-cases.json`, 'utf8')).cases ?? []; }
catch { try { exitCasesPub = publicExitCases(JSON.parse(readFileSync(`${ROOT}/state/exits.json`, 'utf8'))); } catch {} }
const snapshotCounted = gwState?.counted ?? null;

const activeContributors = contributors.filter(([, c]) => !c.closed);
const closedContributors = contributors.filter(([, c]) => c.closed);
const contributorRows = activeContributors.length ? activeContributors.map(([a, c]) => `
        <tr><td class="mono">${esc(a)}</td><td>${formatCoin(c.contributed)}</td><td>${formatCoin(c.pending)}</td><td>${formatCoin(c.paid_total)}</td></tr>`).join('')
  : `<tr><td colspan="4" class="muted" data-i18n="noContributors">No contributors yet — be the first.</td></tr>`;
const settledRows = closedContributors.map(([a, c]) => `
        <tr><td class="mono">${esc(a)}</td><td>${formatCoin(c.closed.principal_units)}</td><td>${formatCoin(c.closed.earnings_units)}</td><td>${formatCoin(c.closed.total_units)}</td><td>${esc(String(c.closed.at).slice(0, 10))}</td></tr>`).join('');
const settledHtml = closedContributors.length ? `
<h2 data-i18n="settledTitle">Settled exits</h2>
<table><tr><th data-i18n="thContributor">Contributor</th><th data-i18n="thPrincipal">Principal returned</th><th data-i18n="thEarnings">Earnings paid</th><th data-i18n="thTotalPaid">Total paid</th><th data-i18n="thSettledAt">Settled</th></tr>${settledRows}
</table>` : '';

// (reportRows is built further down, once the on-chain deposit is known —
// each round row also carries its claim as a share of that deposit.)

const fc = u => { try { return formatCoin(BigInt(u)); } catch { return '—'; } };
// On-chain pool figures for the overview cards and the status bar below
// them. Prefer the gateway account fetched above: it is available on every
// run, including GitHub Actions, where pool.log (the worker's local log,
// gitignored) does not exist and lastPass is always null. Fall back to
// lastPass only when no gateway/cache account is available.
const poolAcc = gwAccounts[ledger.pool_address] ?? null;
const toUnits = v => { try { return BigInt(v); } catch { return 0n; } };
const chainDeposit = poolAcc ? fc(poolAcc.deposit) : (lastPass ? esc(lastPass.deposit) : '—');
const chainBalance = poolAcc ? fc(poolAcc.balance) : (lastPass ? esc(lastPass.balance) : '—');
const chainRound = poolAcc ? (gwState?.mine?.r ?? '—') : (lastPass ? esc(lastPass.round) : '—');
const chainDepositUnits = poolAcc ? toUnits(poolAcc.deposit ?? 0)
  : (lastPass ? BigInt(Math.round(Number(lastPass.deposit) * 1e8)) : 0n);
const poolMining = chainDepositUnits >= 10_000_000n;
const poolStatusHtml = ledger.dissolved
  ? `<div class="poolstatus"><span class="pdot" style="background:var(--warn)"></span><span data-i18n="poolStatusDissolved">Dissolved — all positions settled</span></div>`
  : poolMining
  ? `<div class="poolstatus"><span class="pdot" style="background:var(--accent)"></span><span data-i18n="poolStatusMining" data-dep="${chainDeposit}">Mining — ${chainDeposit} RESET locked</span></div>`
  : `<div class="poolstatus"><span class="pdot" style="background:var(--warn)"></span><span data-i18n="poolStatusWaiting">Waiting for funding — contributions open</span></div>`;

// --- Yield-ratio stats: computed from live data at generation time, never
// hard-coded. Claims come from the published round reports; the deposit
// denominator is the pool's CURRENT on-chain deposit; the network
// denominator is the mine/view full-list deposit sum (totalStaked above).
const depNow = Number(chainDepositUnits);
const pct2 = ratio => (ratio == null || !isFinite(ratio) ? '—' : (ratio * 100).toFixed(2) + '%');
const pctSig = ratio => { if (ratio == null || !isFinite(ratio)) return '—'; const p = ratio * 100; if (!(p > 0)) return '0%';
  const d = Math.max(2, Math.min(6, Math.ceil(-Math.log10(p)) + 1)); return p.toFixed(d) + '%'; };
const shareOfDeposit = claimUnits => (depNow > 0 ? Number(claimUnits) / depNow : null);
const settledByRound = [...liveReports].sort((a, b) => a.round - b.round);
const latestSettled = settledByRound[settledByRound.length - 1] ?? null;
// Cumulative earnings (Overview stat): the sum of every settled round's
// claim across all published round reports — computed at generation
// time from the same data as the reports table, never hard-coded.
const totalEarnedUnits = settledByRound.reduce((s, r) => s + BigInt(r.claim.amount_units), 0n);
const yieldLatestTxt = latestSettled ? pct2(shareOfDeposit(latestSettled.claim.amount_units)) : '—';
const last7Settled = settledByRound.slice(-7);
const yieldAvg7Txt = last7Settled.length
  ? pct2(shareOfDeposit(last7Settled.reduce((s, r) => s + Number(r.claim.amount_units), 0) / last7Settled.length)) : '—';
const netShareTxt = (totalStaked > 0n && chainDepositUnits > 0n)
  ? pctSig(Number(chainDepositUnits) / Number(totalStaked)) : '—';
// Reports table shows newest first and is paged client-side (15 per
// page, same pager as the leaderboard). settledByRound stays ascending
// for the yield stats above; only the table render reverses it.
const reportRows = settledByRound.length ? [...settledByRound].reverse().map(r => `
        <tr data-rp="1"><td>${r.round}</td><td>${formatCoin(r.claim.amount_units)}</td><td>${pct2(shareOfDeposit(r.claim.amount_units))}</td><td>${r.shares.length}</td><td class="mono">${esc(r.report_hash.slice(0, 16))}…</td></tr>`).join('')
  : `<tr><td colspan="5" class="muted" data-i18n="noRounds">No rounds settled yet.</td></tr>`;
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
    return `<tr><td class="mono">${esc(a)}${a === ledger.pool_address ? ' <span class="badge" data-i18n="expPoolTag">pool</span> <a href="#join" onclick="showTab(\'overview\');setTimeout(function(){document.getElementById(\'join\').scrollIntoView()},60);return false;" data-i18n="poolJoinLink">join via the calculator ↓</a>' : ''}</td>` +
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

// --- Markets tab ------------------------------------------------------------
// TNK price is LIVE in the visitor's browser: CoinGecko sends CORS *, the
// RESET gateway does not, so the page script polls CoinGecko every 30 s.
// The RESET network card below reuses this generator's snapshot instead.
// The official-DEX block reads an optional market.json at the repo root
// (to be written by a future DEX-node feeder); without pairs data it renders
// a placeholder, so feeding data later needs no structural change.
let market = null;
try { if (existsSync(`${ROOT}/market.json`)) market = JSON.parse(readFileSync(`${ROOT}/market.json`, 'utf8')); } catch {}
const dexPairs = (Array.isArray(market?.pairs) ? market.pairs : []).filter(p => p && p.pair);
const dexVal = v => (v == null || v === '' ? '—' : esc(String(v)));
let dexHtml;
if (dexPairs.length) {
  dexHtml = dexPairs.map(p => {
    const bids = Array.isArray(p.bids) ? p.bids : [], asks = Array.isArray(p.asks) ? p.asks : [];
    const nRows = Math.min(Math.max(bids.length, asks.length), 10);
    let book = '';
    for (let i = 0; i < nRows; i++) {
      const b = bids[i] || [], a = asks[i] || [];
      book += `<tr><td>${dexVal(b[0])}</td><td>${dexVal(b[1])}</td><td>${dexVal(a[0])}</td><td>${dexVal(a[1])}</td></tr>`;
    }
    return `<div class="card"><b>${esc(p.pair)}</b>
<div class="grid" style="margin-top:10px">
 <div class="stat"><b>${dexVal(p.last)}</b><span data-i18n="dexLast">Last price (USDC)</span></div>
 <div class="stat"><b>${dexVal(p.volume24h)}</b><span data-i18n="dexVol24h">24h volume (USDC)</span></div>
 <div class="stat"><b>${dexVal(p.high24h)} / ${dexVal(p.low24h)}</b><span data-i18n="dexHighLow">24h high / low (USDC)</span></div>
 <div class="stat"><b>${dexVal(p.trades24h)}</b><span data-i18n="dexTrades">Trades (24h)</span></div>
</div>
${nRows ? `<table><tr><th data-i18n="dexBid">Bid</th><th data-i18n="dexQty">Amount</th><th data-i18n="dexAsk">Ask</th><th data-i18n="dexQty">Amount</th></tr>${book}</table>` : ''}</div>`;
  }).join('') + (market.updated ? `<p class="muted"><span data-i18n="dexUpdated">DEX data snapshot</span>: ${esc(market.updated)}</p>` : '');
} else {
  dexHtml = `<div class="dexslot"><p data-i18n="dexPlaceholder" style="margin:0">Live order-book data from the official DEX node will appear here once the node connection is live.</p></div>`;
}
let netCard;
if (!gwState) {
  netCard = `<p class="muted" data-i18n="expDown">Gateway unreachable when this page was generated — try again later.</p>`;
} else {
  const mm = gwState.mine ?? {};
  netCard = `<div class="grid">
 <div class="stat"><b>${mm.r ?? '—'}</b><span data-i18n="expRound">Current round</span></div>
 <div class="stat"><b>${gwState.tip?.height ?? '—'}</b><span data-i18n="expTip">Bitcoin tip</span></div>
 <div class="stat"><b>${mm.claim_count ?? '—'}</b><span data-i18n="expClaims">Claims this round</span></div>
 <div class="stat"><b>${formatCoin(totalStaked)}</b><span data-i18n="lbTotalStaked">Total staked (RESET)</span></div>
 <div class="stat"><b>${minersTotal || allMiners.length}</b><span data-i18n="mktAddresses">Addresses in the network</span></div>
 <div class="stat"><b>${mm.S == null ? '—' : fc(mm.S)}</b><span data-i18n="expStock">Mine stock (RESET)</span></div>
</div>
<p class="muted" data-i18n="mktSnapNote">Snapshot data — refreshed about every 10 minutes when this page is regenerated.</p>`;
}
const marketsHtml = `
<p class="muted" data-i18n="mktNote">RESET itself is not listed on any centralized exchange, so it has no CEX price. TNK is the token of its underlying network (Trac) and does trade — its live price is below.</p>
<h2 data-i18n="mktTnkTitle">TNK — live price</h2>
<div class="card">
 <div class="grid">
  <div class="stat"><b id="tnkPrice">—</b><span data-i18n="mktPrice">TNK price (USD)</span></div>
  <div class="stat"><b id="tnkChange">—</b><span data-i18n="mktChange">24h change</span></div>
  <div class="stat"><b id="tnkVol">—</b><span data-i18n="mktVol">24h volume (USD)</span></div>
  <div class="stat"><b id="tnkMcap">—</b><span data-i18n="mktMcap">Market cap (USD)</span></div>
 </div>
 <table style="margin-top:10px"><tr><th data-i18n="thExchange">Exchange</th><th data-i18n="thLastPrice">Last price (USD)</th><th data-i18n="thVolume">Volume (TNK)</th></tr>
 <tbody id="tnkExBody"><tr><td colspan="3" class="muted">—</td></tr></tbody></table>
 <p class="muted" id="tnkStamp" style="margin-bottom:0"></p>
</div>
<h2 data-i18n="mktNetTitle">RESET network</h2>
${netCard}
<h2 data-i18n="dexTitle">Official DEX · RESET/USDC · TNK/USDC</h2>
${dexHtml}`;

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
 .callout{border:1.5px solid var(--accent);background:color-mix(in srgb, var(--accent) 10%, var(--card));border-radius:10px;padding:14px 16px;font-size:16px;font-weight:600;margin:16px 0;color:var(--fg)}
 .warnbar{border:1.5px solid var(--warn);border-left:6px solid var(--warn);background:color-mix(in srgb, var(--warn) 14%, var(--card));border-radius:10px;padding:12px 14px;font-size:18px;font-weight:700;line-height:1.45;margin:12px 0 0;color:var(--fg)}
 .warnbar a{color:var(--warn);text-decoration:underline}
 .poolstatus{display:flex;align-items:center;gap:9px;border:1px solid var(--border);background:var(--card);border-radius:10px;padding:10px 14px;font-weight:600;margin:2px 0 6px}
 .poolstatus .pdot{width:11px;height:11px;border-radius:50%;flex:none;display:inline-block}
 .dexslot{border:1.5px dashed var(--border);background:var(--card);border-radius:10px;padding:18px;margin:12px 0;color:var(--muted)}
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
 .pager{display:flex;gap:8px;align-items:center;margin:12px 0;flex-wrap:wrap}
 section.tabpage{animation:fade .15s ease-in} @keyframes fade{from{opacity:.4}to{opacity:1}}
 .bar{height:8px;background:var(--code);border-radius:99px;overflow:hidden;margin-top:6px}
 .bar i{display:block;height:100%;background:var(--accent)}
</style></head><body>
<div class="topbar"><div>
<h1>RESET Mining Pool</h1>
</div><div class="topbtns"><button id="themeBtn" onclick="toggleTheme()">☀️</button><button id="langBtn" onclick="toggleLang()">中文</button></div></div>
<nav class="tabs">
 <button class="tabbtn" data-tab="overview" onclick="showTab('overview')" data-i18n="tabOverview">Overview</button>
 <button class="tabbtn" data-tab="explorer" onclick="showTab('explorer')" data-i18n="tabExplorer">Explorer</button>
 <button class="tabbtn" data-tab="ledger" onclick="showTab('ledger')" data-i18n="tabLedger">Ledger</button>
 <button class="tabbtn" data-tab="reports" onclick="showTab('reports')" data-i18n="tabReports">Reports</button>
 <button class="tabbtn" data-tab="verify" onclick="showTab('verify')" data-i18n="tabVerify">Verify</button>
 <button class="tabbtn" data-tab="markets" onclick="showTab('markets')" data-i18n="tabMarkets">Markets</button>
 <a class="tabbtn" href="leaderboard.html" data-i18n="tabLeaderboard" style="text-decoration:none">Leaderboard</a>
 <a class="tabbtn" href="exit.html" data-i18n="tabExit" style="text-decoration:none">Exit</a>
 <a class="tabbtn" href="about.html" data-i18n="tabAbout" style="text-decoration:none">About</a>
</nav>
<p><span class="badge" data-i18n="${funded ? 'badgeActive' : 'badgeWaiting'}">${funded ? '● Active — pool is funded' : '● Waiting for funding — contributions open'}</span></p>
<section class="tabpage" id="tab-overview">

<div class="card"><div class="muted" data-i18n="poolAddrLabel">Pool address (transfer your exact computed amount here)</div>
<div class="mono" id="addr">${esc(ledger.pool_address)}</div>
<button onclick="copyText(document.getElementById('addr').textContent, this)" data-i18n="copy">Copy address</button><p class="warnbar"><span data-i18n="poolAddrHint">To join, never send a round amount — first compute your exact amount</span> <a href="#join" onclick="document.getElementById('join').scrollIntoView({behavior:'smooth'});return false;" data-i18n="poolAddrHintLink">with the calculator in the Join section ↓</a></p></div>



<div class="callout" data-i18n="intro">Mine together below the 0.1 minimum. Small holders fund one pool address; the pool locks ≥ 0.1, claims every round at exactly its fair share, and splits the proceeds pro-rata — with accounting anyone can recompute.</div>

<div id="join">
<h2 data-i18n="joinTitle">How to join</h2>
<ol>
 <li data-i18n="join1">Use the calculator below: enter <b>your own RESET address</b> and a planned amount (a multiple of <b>0.01</b>). Your exact transfer amount is computed locally in your browser — no registration, no GitHub account. Your calculation is recorded in the pool's registry for reconciliation.</li>
 <li data-i18n="join2">From your own RESET wallet, <b>transfer exactly that amount</b> to the pool address — every digit matters; do not round it and do not improvise a different amount. You pay your own TNK transfer fee.</li>
 <li data-i18n="join3">Wait about a minute. The pool watches its balance and matches the amount's tail to your address automatically — the tail <i>is</i> your address's fingerprint. The <b>full amount</b> is credited as your contribution.</li>
 <li data-i18n="join4">Check the <b>Ledger</b> tab (or look your address up on the Overview tab). Your share of every round = your contribution ÷ pool total, snapshotted per round. Earnings accumulate and are paid out once they reach <b>0.01</b>.</li>
</ol>

<div class="card">
 <h3 data-i18n="fpTitle" style="margin-top:0">Your exact transfer amount — self-service calculator</h3>
 <p class="muted" data-i18n="fpIntro">Your address has a deterministic fingerprint: a tail of 1–999999 units derived from the address itself (sha256). planned (a 0.01 multiple) + tail = an amount that is uniquely yours — that is how the pool credits you automatically.</p>
 <p><input id="fpAddr" data-i18n-ph="queryPh" placeholder="Your RESET address, e.g. 2479c2e7…"></p>
 <p><input id="fpAmt" data-i18n-ph="fpAmtPh" placeholder="Planned amount — a multiple of 0.01, e.g. 0.05"> <button onclick="fpCalc()" data-i18n="fpBtn">Calculate my amount</button></p>
 <div id="fpResult" style="margin-top:10px"></div>
</div>

<div class="card">
 <h3 data-i18n="aiJoinTitle" style="margin-top:0">AI-signed join — let your AI do the transfer</h3>
 <p class="muted" data-i18n="aiJoinIntro">Three steps, two copy-pastes: (1) generate a join code here; (2) give the whole code block to your own AI — it reads the amount back to you, you nod, it transfers exactly that amount and signs a receipt; (3) paste the signed receipt below. The code moves no money by itself (only your own signer can transfer), the receipt proves the claim is really yours, and the pool credits it only when an inflow of exactly that amount actually lands.</p>
 <p><input id="aiAddr" data-i18n-ph="queryPh" placeholder="Your RESET address, e.g. 2479c2e7…"></p>
 <p><input id="aiAmt" data-i18n-ph="fpAmtPh" placeholder="Planned amount — a multiple of 0.01, e.g. 0.05"> <button onclick="aiJoinCode()" data-i18n="aiJoinBtn">Generate join code</button></p>
 <div id="aiCodeResult" style="margin-top:10px"></div>
 <div style="margin-top:14px">
  <p class="muted" data-i18n="aiClaimIntro">After your AI has transferred and signed the receipt, paste the signed receipt block (prepared + signature + nonce) here:</p>
  <p><textarea id="aiReceipt" rows="5" style="width:100%;box-sizing:border-box" data-i18n-ph="aiReceiptPh" placeholder='{"prepared": {...}, "signature": "…", "nonce": "…"}'></textarea></p>
  <p><button onclick="aiJoinClaim()" data-i18n="aiClaimBtn">Submit receipt</button></p>
  <div id="aiClaimResult" style="margin-top:10px"></div>
 </div>
 <p class="muted" data-i18n="aiJoinNote">Notes: the join code is valid 30 minutes — execute and submit the receipt inside that window, or the code is automatically deleted and you must issue a fresh one. A submitted receipt waits up to 24 hours for its inflow, then expires visibly. The 0.03 TNK transfer fee is paid by your own wallet — if it holds no TNK, your AI must stop and report, never improvise. Already transferred but no pending claim shows? Paste your receipt below to submit it late (within the 30 minutes) — it credits on the next re-check. Never re-transfer.</p>
</div>

<div class="callout"><b data-i18n="joinWarnTitle">⚠ Before you transfer</b><br><span data-i18n="joinWarn">Only ever transfer the exact amount the calculator gives you. A transfer with a wrong or rounded tail cannot be matched automatically and is parked as <b>unclaimed</b>. Claiming it needs no GitHub account and no signature: the amount's tail is checked against the address it belongs to — if they match, it is credited (ask the operator to run the claim, or see the README). A brand-new address that appears nowhere on the network yet may also land in unclaimed first — same claim path.</span></div>

<h2 data-i18n="rulesTitle">Rules — the honest version</h2>
<ul>
 <li data-i18n="rule1"><b>Fee: 0.</b> Claim level: always exactly 1000 (fair share, never over — no strikes, no penalties).</li>
 <li data-i18n="rule2"><b>Pooling grants access, not extra yield.</b> The Mine pays linearly in deposit; the pool earns exactly what its combined deposit would earn solo.</li>
 <li data-i18n="rule3"><b>Exits take about a day:</b> leaving requires <code>unlock</code> plus the contract's 144-Bitcoin-block exit wait, then <code>withdraw</code>. No instant exits.</li>
 <li data-i18n="rule4"><b>Accounting is provable; custody is trusted.</b> RESET has no pool/multisig primitive, so the operator's key controls the funds. Every contribution, claim and payout is published and hash-chained so any cheating would be visible and attributable — but it cannot be made impossible. This is an experiment, not an investment; no returns are promised.</li>
</ul>

<h2 data-i18n="exitTitle">Leave the pool — full exit</h2>
<div class="card">
 <div class="warnbar"><span data-i18n="exitClosed">⏸ Exits are temporarily closed. The operator has paused the exit channel while the pool is small; it reopens once the pool has grown and the exit executor has passed a full end-to-end live test. Meanwhile the full exit interface is on the exit page, shown disabled.</span></div>
 <p><span data-i18n="exitCardLine">Position lookup and the exit interface live on the exit page:</span> <a href="exit.html" data-i18n="exitFullLink">Go to the exit page →</a></p>
</div>

<h2 data-i18n="expTitle">Experience Shares — the proposed newcomer program</h2>
<p><span class="badge" style="background:#9e6a0322;color:#d29922;border:1px solid #9e6a03" data-i18n="expStatus">Proposed to the team — applications open once the team stakes</span>
 <a href="https://github.com/Trac-Systems/reset/issues/3" target="_blank" rel="noopener" data-i18n="expIssueLink">Read the proposal (issue #3)</a></p>
<p data-i18n="expIntro">The RESET team is invited to stake in this pool like any other member. The yield from the team's stake would then be allocated to newcomers as mining-experience shares:</p>
<ol>
 <li data-i18n="expStep1"><b>Apply with your GitHub account.</b> Claims are made from your own authenticated GitHub account, so identity can't be spoofed, and each account is checked automatically for account age and real activity. One claim per GitHub account, ever.</li>
 <li data-i18n="expStep2"><b>Register your RESET address.</b> The applicant registers the address the experience shares belong to.</li>
 <li data-i18n="expStep3"><b>The yield is credited in the pool, under your address.</b> Your share of the team's yield is recorded on the public ledger from the first round. The allocation never leaves the pool's accounting — no funds pass through anyone's hands.</li>
 <li data-i18n="expStep4"><b>It's yours: withdraw it, or let it compound.</b> Each round you earn pro-rata on top of it, and you can either withdraw your earnings under the pool's normal payout rules, or keep them in and compound your stake.</li>
</ol>

<h2 data-i18n="expSybilTitle">Anti-Sybil rules</h2>
<ul>
 <li data-i18n="expSybil1">One claim per GitHub account, ever — accounts are checked automatically for age and real activity.</li>
 <li data-i18n="expSybil2">Contribution first: claimants run the signer and post headers for a while before claiming — visible on the network, and hard to fake in bulk.</li>
 <li data-i18n="expSybil3">Claims are capped per period, so the program grows at a controlled pace.</li>
 <li data-i18n="expSybil4">The full claim list is published — duplicate or fake claims are obvious to everyone.</li>
</ul>
<p data-i18n="expNote">To be clear: nothing is asked for the operator. The team's principal stays the team's own share throughout — only its yield is given away, and every movement is publicly verifiable. And as with everything in this pool: pooling grants access, not extra yield, and custody is trusted — see the rules above.</p>
</div>

<div class="grid">
 <div class="stat"><b>${formatCoin(total)}</b><span data-i18n="statTotal">Total contributed (RESET)</span></div>
 <div class="stat"><b>${contributors.length}</b><span data-i18n="statContributors">Contributors</span></div>
 <div class="stat"><b>${chainDeposit}</b><span data-i18n="statDeposit">Locked deposit on-chain</span></div>
 <div class="stat"><b>${chainBalance}</b><span data-i18n="statBalance">Pool balance on-chain</span></div>
 <div class="stat"><b>${chainRound}</b><span data-i18n="statRound">Current Mine round</span></div>
 <div class="stat"><b>${ledger.rounds.length}</b><span data-i18n="statSettled">Rounds settled</span></div>
 <div class="stat"><b>${formatCoin(totalEarnedUnits)}</b><span data-i18n="statEarnings">Cumulative earnings — all settled rounds (RESET)</span></div>
 <div class="stat"><b>${yieldLatestTxt}</b><span data-i18n="statYieldLatest">Latest settled round — yield as % of deposit</span></div>
 <div class="stat"><b>${yieldAvg7Txt}</b><span data-i18n="statYieldAvg7">Avg per-round yield as % of deposit (last 7 settled)</span></div>
 <div class="stat"><b>${netShareTxt}</b><span data-i18n="statNetShare">Pool deposit as % of network-wide stake</span></div>
</div>
${poolStatusHtml}

<div class="callout"><span data-i18n="expBanner">Coming (proposed): <b>Experience Shares</b> — the RESET team is invited to stake in the pool and donate only its yield, so newcomers can start mining with shares credited under their own address.</span> <a href="#join" onclick="document.getElementById('join').scrollIntoView({behavior:'smooth'});return false;" data-i18n="expBannerLink">See the plan in the Join section below →</a></div>

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
<section class="tabpage" id="tab-ledger">
<h2 data-i18n="ledgerTitle">Public ledger</h2>
<table><tr><th data-i18n="thContributor">Contributor</th><th data-i18n="thContributed">Contributed</th><th data-i18n="thPending">Pending payout</th><th data-i18n="thPaid">Paid total</th></tr>${contributorRows}
</table>
${settledHtml}
</section>
<section class="tabpage" id="tab-reports">
<h2 data-i18n="reportsTitle">Round reports</h2>
<table><thead><tr><th data-i18n="thRound">Round</th><th data-i18n="thClaim">Claim received (RESET)</th><th data-i18n="thRatio">Share of deposit</th><th data-i18n="thShares">Shares</th><th data-i18n="thHash">Report hash</th></tr></thead><tbody id="rpBody">${reportRows}
</tbody></table>
<div class="pager">
 <button id="rpPrev" onclick="goRpPage(rpPage - 1)" data-i18n="prev">← Prev</button>
 <span id="rpInfo" class="muted"></span>
 <button id="rpNext" onclick="goRpPage(rpPage + 1)" data-i18n="next">Next →</button>
</div>
<p class="muted" data-i18n="reportsRatioNote">“Share of deposit” divides each round's claim by the pool's current on-chain deposit (the same denominator for every round), so rounds stay comparable as the deposit grows.</p>

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
<section class="tabpage" id="tab-markets">
${marketsHtml}
</section>
<p class="muted"><span data-i18n="footerGen">Snapshot time</span> <span id="snapshotTime">${updated}</span>. <span data-i18n="footerNote">It is a static snapshot — no live polling, no login, no tracking.</span></p>
<p class="muted"><span data-i18n="dataSource">Data source</span>: <a href="https://github.com/chilperbf24/reset-mining-pool" target="_blank" rel="noopener">https://github.com/chilperbf24/reset-mining-pool</a></p>

<script>
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SNAPSHOT = ${JSON.stringify(snapshotData)};
const REGISTRY_ENDPOINT = ${JSON.stringify(REGISTRY_ENDPOINT)};
const REGISTRY_EXIT_ENDPOINT = ${JSON.stringify(REGISTRY_EXIT_ENDPOINT)};
const REGISTRY_JOIN_ENDPOINT = ${JSON.stringify(REGISTRY_JOIN_ENDPOINT)};
const T = {
en: { title: "RESET Mining Pool — mine together below the 0.1 minimum", langBtn: "中文",
 tabOverview: "Overview", tabLedger: "Ledger", tabReports: "Reports", tabVerify: "Verify", tabExplorer: "Explorer", tabMarkets: "Markets",
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
 lbNotFound: "This address is not in the current miners snapshot.",
 expSourceNote: "Data: public gateway reset.openmayhem.ai, snapshotted when this page was generated. Live lookup of arbitrary addresses needs a CORS proxy — that is stage 2.",
 mktNote: "RESET itself is not listed on any centralized exchange, so it has no CEX price. TNK is the token of its underlying network (Trac) and does trade — its live price is below.",
 mktTnkTitle: "TNK — live price", mktPrice: "TNK price (USD)", mktChange: "24h change", mktVol: "24h volume (USD)", mktMcap: "Market cap (USD)",
 mktUpdated: "Last updated", mktCgNote: "Source: CoinGecko · refreshes every 30 s",
 thExchange: "Exchange", thLastPrice: "Last price (USD)", thVolume: "Volume (TNK)",
 mktNetTitle: "RESET network", mktAddresses: "Addresses in the network",
 mktSnapNote: "Snapshot data — refreshed about every 10 minutes when this page is regenerated.",
 dexTitle: "Official DEX · RESET/USDC · TNK/USDC",
 dexPlaceholder: "Live order-book data from the official DEX node will appear here once the node connection is live.",
 dexLast: "Last price (USDC)", dexVol24h: "24h volume (USDC)", dexHighLow: "24h high / low (USDC)", dexTrades: "Trades (24h)",
 dexBid: "Bid", dexAsk: "Ask", dexQty: "Amount", dexUpdated: "DEX data snapshot",
 intro: "Mine together below the 0.1 minimum. Small holders fund one pool address; the pool locks ≥ 0.1, claims every round at exactly its fair share, and splits the proceeds pro-rata — with accounting anyone can recompute.",
 badgeActive: "● Active — pool is funded", badgeWaiting: "● Waiting for funding — contributions open",
 poolAddrLabel: "Pool address (transfer your exact computed amount here)", poolAddrHint: "To join, never send a round amount — first compute your exact amount", poolAddrHintLink: "with the calculator in the Join section ↓", poolJoinLink: "join via the calculator ↓", copy: "Copy address",
 statTotal: "Total contributed (RESET)", statContributors: "Contributors", statDeposit: "Locked deposit on-chain",
 statBalance: "Pool balance on-chain", statRound: "Current Mine round", statSettled: "Rounds settled", statEarnings: "Cumulative earnings — all settled rounds (RESET)",
 statYieldLatest: "Latest settled round — yield as % of deposit", statYieldAvg7: "Avg per-round yield as % of deposit (last 7 settled)", statNetShare: "Pool deposit as % of network-wide stake",
 poolStatusWaiting: "Waiting for funding — contributions open", poolStatusMining: "Mining — {deposit} RESET locked",
 poolStatusDissolved: "Dissolved — all positions settled",
 queryTitle: "Check your position",
 queryHint: "Paste your address — the 64-hex RESET form or the trac1 form; both spell the same key and are recognized automatically. The lookup runs entirely in your browser against the public ledger snapshot on this page — nothing is sent anywhere.",
 queryPh: "Your address — RESET hex or trac1…", queryBtn: "Look up",
 qInvalid: "That does not look like a valid address — enter the 64-hex RESET address or the trac1 address (the same key in two encodings).",
 qNotFound: "This address is not in the pool ledger as of the snapshot below. If you just transferred your exact fingerprint amount, it is matched and credited automatically within about a minute and appears in the next snapshot.",
 qFound: "Found in the pool ledger:", qShare: "Share of pool", qContributed: "Contributed", qPending: "Pending payout",
 qPaid: "Already paid out", qProgress: "Progress to the 0.01 payout threshold", qReady: "Threshold reached — this payout is due in the next payout batch.",
 joinTitle: "How to join",
 join1: "Use the calculator below: enter <b>your own RESET address</b> and a planned amount (a multiple of <b>0.01</b>). Your exact transfer amount is computed locally in your browser — no registration, no GitHub account. Your calculation is recorded in the pool's registry for reconciliation.",
 join2: "From your own RESET wallet, <b>transfer exactly that amount</b> to the pool address — every digit matters; do not round it and do not improvise a different amount. You pay your own TNK transfer fee.",
 join3: "Wait about a minute. The pool watches its balance and matches the amount's tail to your address automatically — the tail <i>is</i> your address's fingerprint. The <b>full amount</b> is credited as your contribution.",
 join4: "Check the <b>Ledger</b> tab (or look your address up on the Overview tab). Your share of every round = your contribution ÷ pool total, snapshotted per round. Earnings accumulate and are paid out once they reach <b>0.01</b>.",
 joinWarnTitle: "⚠ Before you transfer",
 joinWarn: "Only ever transfer the exact amount the calculator gives you. A transfer with a wrong or rounded tail cannot be matched automatically and is parked as <b>unclaimed</b>. Claiming it needs no GitHub account and no signature: the amount's tail is checked against the address it belongs to — if they match, it is credited (ask the operator to run the claim, or see the README). A brand-new address that appears nowhere on the network yet may also land in unclaimed first — same claim path.",
 fpTitle: "Your exact transfer amount — self-service calculator",
 fpIntro: "Your address has a deterministic fingerprint: a tail of 1–999999 units derived from the address itself (sha256). planned (a 0.01 multiple) + tail = an amount that is uniquely yours — that is how the pool credits you automatically.",
 fpAmtPh: "Planned amount — a multiple of 0.01, e.g. 0.05",
 fpBtn: "Calculate my amount",
 fpSendLabel: "Transfer EXACTLY this amount to the pool address:",
 fpTailNote: "planned amount + your fingerprint tail — credited in full",
 fpErrAddr: "That does not look like a valid address — enter the 64-hex RESET address or the trac1 address (the same key in two encodings).",
 fpErrPool: "That is the pool's OWN address — the pool cannot join itself. Enter YOUR OWN contributing address.",
 fpConverted: "Recognized a TNK-format (trac1) address — automatically converted to its RESET address:",
 fpErrAmt: "The planned amount must be a positive multiple of 0.01 RESET (e.g. 0.01, 0.05, 0.12).",
 fpErrCrypto: "The calculator needs a secure context — open this page over HTTPS.",
 fpConfirmBtn: "Confirm & Transfer",
 copyBtn: "Copy", copiedOk: "Copied ✓",
 fpPanelAddr: "Recipient — pool address", fpPanelAmt: "Exact amount to transfer", fpPanelCmd: "Signer transfer call",
 fpPanelCheck: "Before you transfer, double-check that the amount's decimal tail matches the one shown here exactly — every digit matters.",
 fpValidNote: "This amount is valid for 30 minutes (until {time}) — transfer within the window. If no matching transfer arrives in time, the calculation record is deleted automatically; please calculate again.",
 fpTimeLeft: "Time left", fpExpired: "Expired — please calculate again.",
 aiJoinTitle: "AI-signed join — let your AI do the transfer",
 aiJoinIntro: "Three steps, two copy-pastes: (1) generate a join code here; (2) give the whole code block to your own AI — it reads the amount back to you, you nod, it transfers exactly that amount and signs a receipt; (3) paste the signed receipt below. The code moves no money by itself (only your own signer can transfer), the receipt proves the claim is really yours, and the pool credits it only when an inflow of exactly that amount actually lands.",
 aiJoinBtn: "Generate join code",
 aiCodeOk: "Join code issued — valid 30 minutes (transfer + receipt inside that window, or it is auto-deleted). Give the whole block below to your own AI.",
 aiCodeErr: "Could not issue a join code: ",
 aiClaimIntro: "After your AI has transferred and signed the receipt, paste the signed receipt block (prepared + signature + nonce) here:",
 aiReceiptPh: '{"prepared": {...}, "signature": "…", "nonce": "…"}',
 aiClaimBtn: "Submit receipt",
 aiClaimOk: "Receipt verified — pending claim registered. The pool credits it automatically when an inflow of exactly this amount lands (up to 24 hours).",
 aiClaimErr: "Receipt rejected: ",
 aiJoinNote: "Notes: the join code is valid 30 minutes — execute and submit the receipt inside that window, or the code is automatically deleted and you must issue a fresh one. A submitted receipt waits up to 24 hours for its inflow, then expires visibly. The 0.03 TNK transfer fee is paid by your own wallet — if it holds no TNK, your AI must stop and report, never improvise. Already transferred but no pending claim shows? Paste your receipt below to submit it late (within the 30 minutes) — it credits on the next re-check. Never re-transfer.",
 exitTitle: "Leave the pool — full exit",
 exitIntro: "Exiting is your right, not a favor: a verified request is executed automatically. Three things to know — <b>exits are full only</b> (principal + pending earnings, settled in one payment); payout takes <b>about 24 hours</b> (the contract's 144-block exit wait); and if an exit would leave the pool's deposit below 0.1, <b>the whole pool is dissolved and everyone is settled</b> instead.",
 exitHow: "<b>No transfer is needed to prove it is you — a signature is.</b> Your coins are inside the pool, so your wallet may be empty; signing costs nothing and works at zero balance. The server issues a one-time statement (the official signed-message format); you sign it with your own signer and submit the signature. Anyone — including your own AI — can file the request and carry the submission, but only your key can sign. And the payout can only ever go to your own ledger address: no step in this flow can name a different payee.",
 exitPosBtn: "Show my position", exitNoPos: "This address has no open position in the current ledger snapshot.",
 exitApplyBtn: "File exit request",
 exitIssued: "Your one-time exit statement is ready. Sign the exact signing text with your signer (for example with the pool repo's exit-sign.mjs), then paste the resulting submission JSON below.",
 exitSignTextLabel: "Signing text (exactly what your key signs)", exitPreparedLabel: "Prepared message",
 exitSubmitPh: "Paste the submission JSON here — {prepared, signature, nonce}", exitSubmitBtn: "Submit signature",
 exitSubmittedOk: "Signature received. The pool verifies it and opens your exit case automatically — watch the Ledger tab. No further action is needed.",
 tabExit: "Exit",
 tabAbout: "About",
 exitClosed: "⏸ Exits are temporarily closed. The operator has paused the exit channel while the pool is small; it reopens once the pool has grown and the exit executor has passed a full end-to-end live test. Meanwhile the full exit interface is on the exit page, shown disabled.",
 exitFullLink: "Go to the exit page →", exitCardLine: "Position lookup and the exit interface live on the exit page:",
 exitClosedNote: "The exit channel is temporarily closed, so no request can be filed right now.",
 exitErrServer: "The registry answered:", exitErrNet: "Could not reach the registry — try again in a moment.",
 exitBadJson: "That does not parse as a submission JSON object.",
 qClosed: "This position was settled by a full exit on {date} — total paid {total} RESET.",
 expBanner: "Coming (proposed): <b>Experience Shares</b> — the RESET team is invited to stake in the pool and donate only its yield, so newcomers can start mining with shares credited under their own address.",
 expBannerLink: "See the plan in the Join section below →",
 expTitle: "Experience Shares — the proposed newcomer program",
 expStatus: "Proposed to the team — applications open once the team stakes",
 expIssueLink: "Read the proposal (issue #3)",
 expIntro: "The RESET team is invited to stake in this pool like any other member. The yield from the team's stake would then be allocated to newcomers as mining-experience shares:",
 expStep1: "<b>Apply with your GitHub account.</b> Claims are made from your own authenticated GitHub account, so identity can't be spoofed, and each account is checked automatically for account age and real activity. One claim per GitHub account, ever.",
 expStep2: "<b>Register your RESET address.</b> The applicant registers the address the experience shares belong to.",
 expStep3: "<b>The yield is credited in the pool, under your address.</b> Your share of the team's yield is recorded on the public ledger from the first round. The allocation never leaves the pool's accounting — no funds pass through anyone's hands.",
 expStep4: "<b>It's yours: withdraw it, or let it compound.</b> Each round you earn pro-rata on top of it, and you can either withdraw your earnings under the pool's normal payout rules, or keep them in and compound your stake.",
 expSybilTitle: "Anti-Sybil rules",
 expSybil1: "One claim per GitHub account, ever — accounts are checked automatically for age and real activity.",
 expSybil2: "Contribution first: claimants run the signer and post headers for a while before claiming — visible on the network, and hard to fake in bulk.",
 expSybil3: "Claims are capped per period, so the program grows at a controlled pace.",
 expSybil4: "The full claim list is published — duplicate or fake claims are obvious to everyone.",
 expNote: "To be clear: nothing is asked for the operator. The team's principal stays the team's own share throughout — only its yield is given away, and every movement is publicly verifiable. And as with everything in this pool: pooling grants access, not extra yield, and custody is trusted — see the rules above.",
 rulesTitle: "Rules — the honest version",
 rule1: "<b>Fee: 0.</b> Claim level: always exactly 1000 (fair share, never over — no strikes, no penalties).",
 rule2: "<b>Pooling grants access, not extra yield.</b> The Mine pays linearly in deposit; the pool earns exactly what its combined deposit would earn solo.",
 rule3: "<b>Exits take about a day:</b> leaving requires <code>unlock</code> plus the contract's 144-Bitcoin-block exit wait, then <code>withdraw</code>. No instant exits.",
 rule4: "<b>Accounting is provable; custody is trusted.</b> RESET has no pool/multisig primitive, so the operator's key controls the funds. Every contribution, claim and payout is published and hash-chained so any cheating would be visible and attributable — but it cannot be made impossible. This is an experiment, not an investment; no returns are promised.",
 ledgerTitle: "Public ledger", thContributor: "Contributor", thContributed: "Contributed", thPending: "Pending payout", thPaid: "Paid total",
 settledTitle: "Settled exits", thPrincipal: "Principal returned", thEarnings: "Earnings paid", thTotalPaid: "Total paid", thSettledAt: "Settled",
 noContributors: "No contributors yet — be the first.",
 reportsTitle: "Round reports", thRound: "Round", thClaim: "Claim received (RESET)", thRatio: "Share of deposit", thShares: "Shares", thHash: "Report hash",
 reportsRatioNote: "“Share of deposit” divides each round's claim by the pool's current on-chain deposit (the same denominator for every round), so rounds stay comparable as the deposit grows.",
 noRounds: "No rounds settled yet.",
 prev: "← Prev", next: "Next →", pageOf: (a, b) => "Page " + a + " of " + b,
 verifyTitle: "Verify it yourself",
 verify1: "Each round report publishes its full inputs: the contributor snapshot, the claim amount (match it against the chain's claim record for the pool address and round), the fee and every share. Recompute:",
 verify2: "Integer-division dust is carried into the next round, never kept. At any time: <code>Σ claims = Σ pending + Σ paid + fees + carried dust</code>. An open-source verifier that recomputes reports independently is available from the operator — altering a single share makes verification fail.",
 footerGen: "Snapshot time", footerNote: "It is a static snapshot — no live polling, no login, no tracking.", dataSource: "Data source" },
zh: { title: "RESET 拼池 — 不够 0.1 也能一起挖", langBtn: "English",
 tabOverview: "概览", tabLedger: "账本", tabReports: "报告", tabVerify: "验证", tabExplorer: "浏览器", tabMarkets: "行情",
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
 lbNotFound: "该地址不在当前矿工快照名单里。",
 expSourceNote: "数据来源：公开网关 reset.openmayhem.ai，页面生成时抓取的快照。任意地址的实时查询需要跨域代理——那是第二阶段。",
 mktNote: "RESET 本身未在任何中心化交易所上市，没有 CEX 价格。TNK 是其底层网络（Trac）的代币，有真实交易——下方为其实时行情。",
 mktTnkTitle: "TNK — 实时行情", mktPrice: "TNK 价格（USD）", mktChange: "24 小时涨跌", mktVol: "24 小时成交量（USD）", mktMcap: "市值（USD）",
 mktUpdated: "最后更新", mktCgNote: "数据源 CoinGecko · 每 30 秒刷新",
 thExchange: "交易所", thLastPrice: "最新价（USD）", thVolume: "成交量（TNK）",
 mktNetTitle: "RESET 网络动态", mktAddresses: "全网地址数",
 mktSnapNote: "快照数据——页面每次重新生成时更新，约每 10 分钟一次。",
 dexTitle: "官方 DEX · RESET/USDC · TNK/USDC",
 dexPlaceholder: "官方 DEX 节点接入完成后，这里将点亮实时盘口数据。",
 dexLast: "最新价（USDC）", dexVol24h: "24 小时成交量（USDC）", dexHighLow: "24 小时最高 / 最低（USDC）", dexTrades: "24 小时成交笔数",
 dexBid: "买价", dexAsk: "卖价", dexQty: "数量", dexUpdated: "DEX 数据快照",
 intro: "不够 0.1 门槛也能一起挖：小额持有人共同出资到一个池地址，池子锁仓 ≥ 0.1、每轮按公平份额 claim、收益按出资比例分——账目任何人都可以复算。",
 badgeActive: "● 运行中 — 池子已注资", badgeWaiting: "● 等待注资 — 正在开放出资",
 poolAddrLabel: "池地址（把计算器算出的专属金额精确转到这里）", poolAddrHint: "入池切勿直接转整数金额——先算出你的专属金额", poolAddrHintLink: "用下方入池板块的计算器 ↓", poolJoinLink: "用计算器入池 ↓", copy: "复制地址",
 statTotal: "出资总额（RESET）", statContributors: "出资人数", statDeposit: "链上锁仓",
 statBalance: "链上池余额", statRound: "当前挖矿轮次", statSettled: "已结算轮次", statEarnings: "累计总收益——全部已结算轮次（RESET）",
 statYieldLatest: "最近一轮收益占质押比", statYieldAvg7: "近 7 个已结算轮平均每轮收益占质押比", statNetShare: "池子质押占全网总质押比",
 poolStatusWaiting: "等待注资 — 正在开放出资", poolStatusMining: "挖矿中 — 已锁仓 {deposit} RESET",
 poolStatusDissolved: "已解散 — 全部结清",
 queryTitle: "查询我的份额",
 queryHint: "粘贴你的地址——64 位十六进制 RESET 格式或 trac1 格式都行，两者是同一把钥匙，页面会自动识别。查询完全在你的浏览器里对本页的公开账本快照进行，不会把地址发送到任何地方。",
 queryPh: "你的地址——RESET 十六进制或 trac1…", queryBtn: "查询",
 qInvalid: "这不像一个有效地址——请填 64 位十六进制 RESET 地址或 trac1 地址（两者是同一把钥匙的两种写法）。",
 qNotFound: "截至下方快照时间，该地址不在池账本里。如果你刚按专属金额精确转账，约 1 分钟内会被自动对号入账，并出现在下一份快照里。",
 qFound: "在池账本中找到：", qShare: "占池份额", qContributed: "已出资", qPending: "待分收益",
 qPaid: "已分发", qProgress: "距 0.01 分发门槛的进度", qReady: "已达门槛——这笔收益会进入下一批分发。",
 joinTitle: "怎么入池",
 join1: "用下方计算器：填入<b>你自己的 RESET 地址</b>和计划金额（必须是 <b>0.01</b> 的整数倍）。专属应转金额完全在你浏览器本地算出——不用登记、不用 GitHub 账号。计算结果会登记到池子后台用于对账。",
 join2: "用你自己的 RESET 钱包，把<b>这个金额一分不差</b>地转到池地址——每一位都不能错，不要四舍五入、不要自作主张换金额。TNK 转账费自理。",
 join3: "等约 1 分钟。池子会盯着余额进账，按金额尾数自动对号到你的地址——尾数<b>就是</b>你地址的指纹。到账金额<b>全额</b>计入你的出资。",
 join4: "到<b>账本</b>页查看（或在概览页用地址查询）。每轮你的份额 = 你的出资 ÷ 池子总额，按轮快照定格；收益累积到 <b>0.01</b> 后分发。",
 joinWarnTitle: "⚠ 转账前必读",
 joinWarn: "只准转计算器给出的那个金额。尾数错误或被四舍五入的转账无法自动匹配，会被停放为<b>待认领</b>。认领不需要 GitHub 账号、不需要签名：拿金额尾数和它所属的地址一验，对上就入账（联系池主运行认领，或看 README）。全新地址（网络名单里还没有的）也可能先落入待认领——同一条认领路。",
 fpTitle: "算你的专属应转金额——自助计算器",
 fpIntro: "你的地址有一个确定性指纹：由地址本身（sha256）算出的 1–999999 units 尾数。计划金额（0.01 的倍数）+ 尾数 = 独一无二属于你的金额——池子就是这样自动把钱记到你名下的。",
 fpAmtPh: "计划金额——0.01 的倍数，如 0.05",
 fpBtn: "算出我的金额",
 fpSendLabel: "请把下面这个金额一分不差地转到池地址：",
 fpTailNote: "计划金额 + 你的指纹尾数——全额计入出资",
 fpErrAddr: "这不像一个有效地址——请填 64 位十六进制 RESET 地址或 trac1 地址（两者是同一把钥匙的两种写法）。",
 fpErrPool: "这是池子自己的地址——池子不能给自己入池。请填你自己的出资地址。",
 fpConverted: "已识别 TNK 格式（trac1）地址，已自动换算为 RESET 地址：",
 fpErrAmt: "计划金额必须是 0.01 RESET 的正整数倍（如 0.01、0.05、0.12）。",
 fpErrCrypto: "计算器需要安全上下文——请用 HTTPS 打开本页。",
 fpConfirmBtn: "确认无误并转账",
 copyBtn: "复制", copiedOk: "复制成功 ✓",
 fpPanelAddr: "收款地址（池子）", fpPanelAmt: "应转金额", fpPanelCmd: "签名器转账命令",
 fpPanelCheck: "转账前请核对：金额的小数尾数必须与此处显示的完全一致，一位都不能差。",
 fpValidNote: "本金额有效期 30 分钟（至 {time}），请在有效期内转账；超时未到账，该计算记录将自动删除，请重新计算。",
 fpTimeLeft: "剩余时间", fpExpired: "已过期，请重新计算。",
 aiJoinTitle: "AI 签名入池——让你的 AI 去转账",
 aiJoinIntro: "三步、复制两次：（1）在这里生成入池码；（2）把整段码发给自己的 AI——它会把金额念回给你、你点头后它一分不差地转账并签回执；（3）把签好的回执粘贴到下方。码本身搬不动钱（只有你自己的签名器能转钱），回执证明申报人就是地址本人，池子只在 exact 金额真到账时才入账。",
 aiJoinBtn: "生成入池码",
 aiCodeOk: "入池码已签发，有效期 30 分钟（转账和回执都要在这 30 分钟内完成，超时未交回执会被自动删除）。请把下面整段发给自己的 AI。",
 aiCodeErr: "签发入池码失败：",
 aiClaimIntro: "你的 AI 转账并签好回执后，把签好的回执块（prepared＋signature＋nonce）粘贴到这里：",
 aiReceiptPh: '{"prepared": {...}, "signature": "…", "nonce": "…"}',
 aiClaimBtn: "提交回执",
 aiClaimOk: "回执验签通过，已登记待核销。exact 金额到账后池子自动入账（最长等待 24 小时）。",
 aiClaimErr: "回执被拒绝：",
 aiJoinNote: "说明：入池码有效期 30 分钟——转账和提交回执都必须在这 30 分钟内完成，超时未交回执的码会被自动删除，需重新发码。已提交的回执最长等待 24 小时到账，超时会显示为过期。0.03 TNK 转账费由你自己的钱包付——钱包没有 TNK 时，你的 AI 必须停下报告，绝不自作主张。已经转过账但没有待核销状态？把回执粘贴到下方补交（30 分钟内）——下趟复核即入账。切勿重复转账。",
 exitTitle: "退出拼池——全额退出",
 exitIntro: "退出是你的权利，不是向谁申请批准：验证通过的退出申请会被自动执行。三件事先讲明——<b>只退全额</b>（本金＋待分收益一次结清）；到账需<b>约 24 小时</b>（合约的 144 个比特币块退出等待期）；若某笔退出会让池子质押跌破 0.1，<b>全池解散、所有人一并结清</b>。",
 exitHow: "<b>证明是你本人，不用转币——用签名。</b>你的币在池子里，钱包可能是空的；签名零成本、零余额可办。服务器会签发一份一次性声明（官方签名消息格式），你用自己的签名器签好后把签名提交回来即可。申请和提交可以由任何人代劳——包括你自己的 AI——但只有你的私钥能签。而且退出款<b>只打回你账本上的地址本人</b>：整个流程没有任何一步能改收款地址。",
 exitPosBtn: "查看我的份额", exitNoPos: "该地址在当前账本快照里没有未结清的份额。",
 exitApplyBtn: "登记退出申请",
 exitIssued: "你的一次性退出声明已生成。用你的签名器对下面的签名文本签名（例如用拼池仓库里的 exit-sign.mjs），再把得到的提交 JSON 粘贴到下方。",
 exitSignTextLabel: "签名文本（你的私钥实际签的就是这段）", exitPreparedLabel: "声明对象（prepared）",
 exitSubmitPh: "把提交 JSON 粘贴到这里——{prepared, signature, nonce}", exitSubmitBtn: "提交签名",
 exitSubmittedOk: "签名已收到。池子会自动验签并建案执行——留意账本页即可，你不需要再做任何事。",
 tabExit: "退出",
 tabAbout: "详细介绍",
 exitClosed: "⏸ 退出通道暂时关闭。池子规模尚小，运营者已暂停退出通道；待池子金额规模上来、且退出执行器完成整机端到端实测后再开放。期间完整退出界面在退出页以禁用态展示。",
 exitFullLink: "去退出页 →", exitCardLine: "份额查询与退出界面都在退出页：",
 exitClosedNote: "退出通道暂时关闭，目前无法登记退出申请。",
 exitErrServer: "登记后台回复：", exitErrNet: "连不上登记后台——稍后再试。",
 exitBadJson: "这不是可解析的提交 JSON。",
 qClosed: "该份额已于 {date} 全额退出结清——共付 {total} RESET。",
 expBanner: "新计划（提议中）：<b>体验份额</b>——官方团队受邀入池质押、只捐出收益，新人就能以记在自己地址名下的份额开始挖矿。",
 expBannerLink: "去下方入池板块看计划 →",
 expTitle: "体验份额计划——给新人的提议",
 expStatus: "已向官方提议 · 待官方入池后开启申请",
 expIssueLink: "查看提议帖（issue #3）",
 expIntro: "官方团队受邀像任何成员一样把币质押进这个池子。官方质押份额产生的收益，将按下面的方式分配给新人，作为挖矿体验份额：",
 expStep1: "<b>用 GitHub 账号申请。</b>申请必须从你本人已认证的 GitHub 账号发出，身份无法冒充；每个账号都会被自动核查注册时长和真实活动记录。一个 GitHub 账号只能申请一次，终身有效。",
 expStep2: "<b>登记你的 RESET 地址。</b>申请者登记体验份额归属的那个地址。",
 expStep3: "<b>收益记入池子、挂在你的地址名下。</b>你应得的那份官方收益，从第一轮起就记在公开账本上。这笔分配全程不离开池子的账目——不经过任何人的手。",
 expStep4: "<b>份额归你：提取，或者留在池里滚大。</b>每一轮你都在此基础上按比例继续获得收益；你可以按池子的正常发放规则提取收益，也可以把收益留在池子里复投滚动。",
 expSybilTitle: "防女巫规则",
 expSybil1: "一个 GitHub 账号只能申请一次，终身有效——账号的注册时长和真实活动记录会被自动核查。",
 expSybil2: "先贡献、后申请：申请前先运行签名器、为网络同步一段时间的区块头——此事在网络上可查，难以批量伪造。",
 expSybil3: "每期申请名额有上限，计划以受控的节奏推进。",
 expSybil4: "完整的申请名单全部公开——重复或虚假申请一眼就能看穿，人人可审计。",
 expNote: "把话讲明：运营者本人不索取任何东西。官方的本金全程都是官方自己的份额——送出去的只有它的收益，每一笔流动都可公开验证。和池子的其他一切一样：拼池只解决准入、不放大收益，托管靠信任——见上方规则。",
 rulesTitle: "规则——实话版",
 rule1: "<b>手续费：0。</b>Claim 永远只打 level 1000（只要公平份额，绝不超额——没有罚分、没有罚款）。",
 rule2: "<b>拼池只解决准入，不放大收益。</b>Mine 按锁仓线性付酬，池子赚到的就是合并锁仓能赚到的，一分不多。",
 rule3: "<b>退池约需一天：</b>退出要走 <code>unlock</code> + 合约的 144 个比特币块等待期，再 <code>withdraw</code>。不能秒退。",
 rule4: "<b>账目可证明，托管靠信任。</b>RESET 没有池子/多签原语，池主的私钥控制资金。每一笔出资、claim 和分发都会公开并做哈希链存证，作弊一定会被发现并可追溯——但无法从根本上杜绝。这是个实验，不是投资，不承诺任何收益。",
 ledgerTitle: "公开账本", thContributor: "出资人", thContributed: "已出资", thPending: "待分收益", thPaid: "已分发总额",
 settledTitle: "已结清退出", thPrincipal: "退回本金", thEarnings: "结清收益", thTotalPaid: "结清总额", thSettledAt: "结清日期",
 noContributors: "尚无人出资——来做第一个。",
 reportsTitle: "轮次报告", thRound: "轮次", thClaim: "本轮 claim 到账（RESET）", thRatio: "占质押比", thShares: "分账份数", thHash: "报告哈希",
 reportsRatioNote: "「占质押比」= 每轮 claim ÷ 池子当前链上总质押（所有轮次同一分母），方便横向比较。",
 noRounds: "尚无已结算轮次。",
 prev: "← 上一页", next: "下一页 →", pageOf: (a, b) => "第 " + a + " / " + b + " 页",
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
  document.querySelectorAll('[data-i18n]').forEach(el => { let v = t[el.dataset.i18n]; if (v != null) { if (el.dataset.dep != null) v = v.split('{deposit}').join(el.dataset.dep); el.innerHTML = v; } });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t[el.dataset.i18nPh]; });
  document.getElementById('langBtn').textContent = t.langBtn;
  syncThemeBtn();
  const stEl = document.getElementById('snapshotTime'); if (stEl) stEl.textContent = snapshotTimeText();
  renderTnkStamp();
  document.title = t.title;
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  if (lastQuery) lookup();
  if (fpUsed) fpCalc();
  renderReports();
}
// Reports table pagination: rows are server-rendered newest-first; this
// only shows one 15-row page at a time (same pager idiom as the
// leaderboard page: prev / page-of / next, buttons disabled at bounds).
const RP_PAGE_SIZE = 15;
let rpPage = 0;
function renderReports() {
  const rows = document.querySelectorAll('#rpBody tr[data-rp]');
  const pages = Math.max(1, Math.ceil(rows.length / RP_PAGE_SIZE));
  rpPage = Math.min(Math.max(0, rpPage), pages - 1);
  rows.forEach((tr, i) => { tr.style.display = Math.floor(i / RP_PAGE_SIZE) === rpPage ? '' : 'none'; });
  const info = document.getElementById('rpInfo'); if (info) info.textContent = T[lang].pageOf(rpPage + 1, pages);
  const pv = document.getElementById('rpPrev'); if (pv) pv.disabled = rpPage <= 0;
  const nx = document.getElementById('rpNext'); if (nx) nx.disabled = rpPage >= pages - 1;
}
function goRpPage(p) { rpPage = p; renderReports(); }
function toggleLang() { lang = lang === 'zh' ? 'en' : 'zh'; localStorage.setItem('pool-lang', lang); applyLang(); }
function syncThemeBtn() { const dark = document.documentElement.dataset.theme === 'dark'; document.getElementById('themeBtn').textContent = dark ? T[lang].themeToLight : T[lang].themeToDark; }
function toggleTheme() { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; try { localStorage.setItem('pool-theme', next); } catch (e) {} syncThemeBtn(); }
function showTab(name) { const names = ['overview', 'explorer', 'ledger', 'reports', 'verify', 'markets']; if (!names.includes(name)) name = 'overview';
  document.querySelectorAll('section.tabpage').forEach(s => { s.style.display = s.id === 'tab-' + name ? '' : 'none'; });
  document.querySelectorAll('.tabbtn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  try { localStorage.setItem('pool-tab', name); } catch (e) {} try { history.replaceState(null, '', '#' + name); } catch (e) {} }
// --- Address formats: the 64-hex RESET address and the trac1 (TNK) address
// are the SAME 32-byte key in two encodings (bech32m, HRP "trac", payload =
// the raw key, checksum verified). normalizeAddress maps either spelling to
// canonical lowercase hex, so lookups and the fingerprint calculator agree
// whichever form a visitor pastes. Mirrors lib/fpmatch.mjs exactly.
function normalizeAddress(input) {
  if (typeof input !== 'string') return null;
  var s = input.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  if (!/^trac1/i.test(s)) return null;
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return null; // bech32 forbids mixed case
  var a = s.toLowerCase();
  var pos = a.lastIndexOf('1');
  if (pos < 1 || a.slice(0, pos) !== 'trac') return null;
  var part = a.slice(pos + 1);
  if (part.length < 6) return null;
  var CS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  var data = [];
  for (var i = 0; i < part.length; i++) { var v = CS.indexOf(part[i]); if (v < 0) return null; data.push(v); }
  var GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  var vals = [];
  for (var j = 0; j < 4; j++) vals.push('trac'.charCodeAt(j) >> 5);
  vals.push(0);
  for (var j2 = 0; j2 < 4; j2++) vals.push('trac'.charCodeAt(j2) & 31);
  vals = vals.concat(data);
  var chk = 1;
  for (var k = 0; k < vals.length; k++) { var top = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ vals[k];
    for (var b = 0; b < 5; b++) if ((top >>> b) & 1) chk ^= GEN[b]; }
  if ((chk >>> 0) !== 0x2bc830a3) return null; // bech32m checksum
  var acc = 0, bits = 0, bytes = [];
  var payload = data.slice(0, data.length - 6);
  for (var m = 0; m < payload.length; m++) { acc = (acc << 5) | payload[m]; bits += 5;
    while (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); } }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff) !== 0) return null;
  if (bytes.length !== 32) return null;
  return bytes.map(function (x) { return x.toString(16).padStart(2, '0'); }).join('');
}
function lookup() {
  const t = T[lang];
  const rawQ = document.getElementById('q').value.trim();
  const addr = normalizeAddress(rawQ);
  lastQuery = rawQ;
  const box = document.getElementById('qResult');
  if (!addr) { box.innerHTML = '<span style="color:var(--warn)">' + t.qInvalid + '</span>'; return; }
  const c = SNAPSHOT.contributors[addr];
  if (!c) { box.innerHTML = '<span style="color:var(--warn)">' + t.qNotFound + '</span><br><span class="muted">' + t.footerGen + ': ' + snapshotTimeText() + '</span>'; return; }
  if (c.closed) { box.innerHTML = '<b>' + t.qFound + '</b> <span class="mono">' + addr + '</span><br><span style="color:var(--warn)">' + t.qClosed.replace('{date}', String(c.closed.at).slice(0, 10)).replace('{total}', fmt(c.closed.total_units)) + '</span>'; return; }
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
// --- Join section (on the Overview tab): self-service fingerprint calculator. Runs entirely in the
// visitor's browser (WebCrypto sha256); must agree exactly with the pool's
// matcher (lib/fpmatch.mjs): fp = (sha256(address)[0..4] BE mod 999999) + 1.
// Every outcome is ALSO filed to the calculation registry (reportCalc
// below) so the operator keeps a backend record for reconciling inflows —
// a pure fire-and-forget report: any failure is silent and never affects
// the calculation or what the visitor sees.
let fpUsed = false;
const fpReported = new Set();
// Shared clipboard helper (transfer panel + overview pool card):
// clipboard API first, execCommand fallback; the clicked button shows
// the "Copied ✓" feedback for ~1.5 s, then its own label comes back.
function copyText(txt, btn) {
  const done = () => {
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = T[lang].copiedOk;
    setTimeout(() => { btn.textContent = btn.dataset && btn.dataset.i18n ? (T[lang][btn.dataset.i18n] || old) : old; }, 1500);
  };
  const fallback = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta); done();
    } catch (e) {}
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done).catch(fallback);
  else fallback();
}
// 30-minute validity of a computed amount (mirrors the registry TTL).
// The deadline is pinned to the (address, planned) pair, so a language
// switch — which re-runs fpCalc — never extends it.
let fpTimer = null, fpDeadline = 0, fpDeadlineKey = '';
function fpStopTimer() { if (fpTimer) { clearInterval(fpTimer); fpTimer = null; } }
function reportCalc(rec) {
  try {
    const key = JSON.stringify(rec);
    if (fpReported.has(key)) return; // applyLang re-runs fpCalc — file each outcome once
    fpReported.add(key);
    fetch(REGISTRY_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rec), keepalive: true }).catch(() => {});
  } catch (e) {}
}
function fpFmt(u) { return (u / 100000000n).toString() + '.' + (u % 100000000n).toString().padStart(8, '0'); }
async function fpCalc() {
  fpUsed = true;
  fpStopTimer();
  const t = T[lang];
  const box = document.getElementById('fpResult');
  const rawAddr = document.getElementById('fpAddr').value.trim();
  const addr = normalizeAddress(rawAddr);
  const amtStr = document.getElementById('fpAmt').value.trim();
  const err = m => { box.innerHTML = '<span style="color:var(--warn)">' + m + '</span>'; };
  if (!addr) { reportCalc({ address: rawAddr, normalized: null, status: 'invalid' }); err(t.fpErrAddr); return; }
  if (addr === SNAPSHOT.pool_address) { reportCalc({ address: rawAddr, normalized: addr, status: 'blocked_pool' }); box.innerHTML = '<div class="warnbar">' + t.fpErrPool + '</div>'; return; }
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(amtStr)) { reportCalc({ address: rawAddr, normalized: addr, status: 'invalid' }); err(t.fpErrAmt); return; }
  const parts = amtStr.split('.');
  const planned = BigInt(parts[0]) * 100000000n + BigInt(((parts[1] || '') + '00000000').slice(0, 8));
  if (planned <= 0n || planned % 1000000n !== 0n) { reportCalc({ address: rawAddr, normalized: addr, status: 'invalid' }); err(t.fpErrAmt); return; }
  if (!window.crypto || !crypto.subtle) { err(t.fpErrCrypto); return; }
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(addr));
  const fp = BigInt(new DataView(buf).getUint32(0, false) % 999999 + 1);
  const send = planned + fp;
  reportCalc({ address: rawAddr, normalized: addr, planned_units: planned.toString(),
    fp_units: fp.toString(), exact_units: send.toString(), status: 'ok' });
  const convNote = /^trac1/i.test(rawAddr)
    ? '<div style="margin-bottom:8px">' + t.fpConverted + ' <span class="mono">' + addr + '</span></div>' : '';
  // Pin the 30-minute deadline to this (address, planned) pair.
  const dkey = addr + '|' + planned.toString();
  if (dkey !== fpDeadlineKey) { fpDeadlineKey = dkey; fpDeadline = Date.now() + 30 * 60 * 1000; }
  const p2 = n => String(n).padStart(2, '0');
  const until = new Date(fpDeadline);
  const untilText = p2(until.getHours()) + ':' + p2(until.getMinutes());
  // The signer transfer call, prefilled — the panel only ASSEMBLES the
  // information; the visitor still runs it in their own signer.
  const cmd = 'transfer { "to": "' + SNAPSHOT.pool_address + '", "amount": "' + fpFmt(send) + '" }';
  box.innerHTML = convNote + '<div class="muted">' + t.fpSendLabel + '</div>' +
    '<div class="mono" style="font-size:24px;font-weight:700;margin:4px 0">' + fpFmt(send) + ' RESET</div>' +
    '<div class="mono" style="margin-bottom:6px">' + SNAPSHOT.pool_address + '</div>' +
    '<button id="fpCopyBtn">' + t.copy + '</button> <span class="muted">' + t.fpTailNote + '</span>' +
    '<div id="fpValidLine" style="margin-top:10px"><span class="muted">' + t.fpValidNote.replace('{time}', untilText) + '</span> <span class="mono" id="fpCountdown"></span></div>' +
    '<div style="margin-top:10px"><button id="fpConfirmBtn" style="font-size:16px;font-weight:700;padding:8px 18px">' + t.fpConfirmBtn + '</button></div>' +
    '<div id="fpPanel" style="display:none;margin-top:12px">' +
      '<div class="muted">' + t.fpPanelAddr + '</div>' +
      '<div><span class="mono">' + SNAPSHOT.pool_address + '</span> <button class="fpCopyX" data-copy="' + SNAPSHOT.pool_address + '">' + t.copyBtn + '</button></div>' +
      '<div class="muted" style="margin-top:8px">' + t.fpPanelAmt + '</div>' +
      '<div><span class="mono" style="font-size:20px;font-weight:700">' + fpFmt(send) + '</span> <button class="fpCopyX" data-copy="' + fpFmt(send) + '">' + t.copyBtn + '</button></div>' +
      '<div class="muted" style="margin-top:8px">' + t.fpPanelCmd + '</div>' +
      '<div class="mono" style="word-break:break-all">' + cmd + '</div>' +
      '<div style="margin-top:8px;color:var(--warn)">' + t.fpPanelCheck + '</div>' +
    '</div>';
  document.getElementById('fpCopyBtn').addEventListener('click', ev => copyText(fpFmt(send), ev.currentTarget));
  document.getElementById('fpConfirmBtn').addEventListener('click', () => {
    const p = document.getElementById('fpPanel');
    if (p) p.style.display = p.style.display === 'none' ? '' : 'none';
  });
  box.querySelectorAll('.fpCopyX').forEach(b => b.addEventListener('click', () => copyText(b.dataset.copy, b)));
  const cd = document.getElementById('fpCountdown');
  const tick = () => {
    const left = fpDeadline - Date.now();
    if (left <= 0) {
      fpStopTimer();
      const c = document.getElementById('fpConfirmBtn'); if (c) c.style.display = 'none';
      const p = document.getElementById('fpPanel'); if (p) p.style.display = 'none';
      const h = document.getElementById('fpValidLine');
      if (h) h.innerHTML = '<span style="color:var(--warn)">' + t.fpExpired + '</span>';
      return;
    }
    const s = Math.ceil(left / 1000);
    if (cd) cd.textContent = t.fpTimeLeft + ' ' + p2(Math.floor(s / 60)) + ':' + p2(s % 60);
  };
  tick();
  fpTimer = setInterval(tick, 1000);
}
document.getElementById('fpAddr').addEventListener('keydown', e => { if (e.key === 'Enter') fpCalc(); });
document.getElementById('fpAmt').addEventListener('keydown', e => { if (e.key === 'Enter') fpCalc(); });
// --- Exit flow: the interface lives on the standalone exit page
// (docs/exit.html), position lookup included. This page's exit card
// only links there; nothing on this page files or submits an exit.
// The registry gate (worker EXIT_OPEN) and the executor gate
// (lib/exit-exec.mjs ARMED) are unchanged by this move.
// --- Markets tab: TNK live price, polled client-side from CoinGecko (CORS *).
// Failures are silent: the last good values stay on screen and the next
// 30 s cycle retries. Nothing else on this page makes network calls.
let tnkStamp = '';
function renderTnkStamp() { const el = document.getElementById('tnkStamp'); if (el) el.textContent = tnkStamp ? (T[lang].mktUpdated + ' ' + tnkStamp + ' · ' + T[lang].mktCgNote) : T[lang].mktCgNote; }
function tnkNum(x, d) { return x == null || isNaN(x) ? '—' : Number(x).toLocaleString('en-US', { maximumFractionDigits: d == null ? 0 : d }); }
async function aiJoinCode() {
  const t = T[lang];
  const box = document.getElementById('aiCodeResult');
  const rawAddr = document.getElementById('aiAddr').value.trim();
  const addr = normalizeAddress(rawAddr);
  const amtStr = document.getElementById('aiAmt').value.trim();
  const err = m => { box.innerHTML = '<span style="color:var(--warn)">' + esc(m) + '</span>'; };
  if (!addr) { err(t.fpErrAddr); return; }
  if (addr === SNAPSHOT.pool_address) { box.innerHTML = '<div class="warnbar">' + t.fpErrPool + '</div>'; return; }
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(amtStr)) { err(t.fpErrAmt); return; }
  const parts = amtStr.split('.');
  const planned = BigInt(parts[0]) * 100000000n + BigInt(((parts[1] || '') + '00000000').slice(0, 8));
  if (planned <= 0n || planned % 1000000n !== 0n) { err(t.fpErrAmt); return; }
  let r, j;
  try {
    r = await fetch(REGISTRY_JOIN_ENDPOINT + '/code', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: addr, planned_units: planned.toString() }) });
    j = await r.json();
  } catch (e) { err(t.aiCodeErr + String(e)); return; }
  if (!j.ok) { err(t.aiCodeErr + (j.error || ('HTTP ' + r.status))); return; }
  const code = j.code;
  box.innerHTML = '<div class="muted">' + t.aiCodeOk + '</div>' +
    '<pre class="mono" id="aiCodeText" style="white-space:pre-wrap;word-break:break-all">' + esc(code.text) + '</pre>' +
    '<button id="aiCodeCopyBtn">' + t.copyBtn + '</button> ' +
    '<span class="muted">nonce ' + esc(code.nonce) + ' · exact ' + esc(code.exact_units) + ' units</span>';
  document.getElementById('aiCodeCopyBtn').addEventListener('click', ev => copyText(code.text, ev.currentTarget));
}
async function aiJoinClaim() {
  const t = T[lang];
  const box = document.getElementById('aiClaimResult');
  let sub;
  try { sub = JSON.parse(document.getElementById('aiReceipt').value.trim()); }
  catch { box.innerHTML = '<span style="color:var(--warn)">' + esc(t.aiClaimErr + 'not JSON') + '</span>'; return; }
  let r, j;
  try {
    r = await fetch(REGISTRY_JOIN_ENDPOINT + '/claim', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub) });
    j = await r.json();
  } catch (e) { box.innerHTML = '<span style="color:var(--warn)">' + esc(t.aiClaimErr + String(e)) + '</span>'; return; }
  if (!j.ok) { box.innerHTML = '<span style="color:var(--warn)">' + esc(t.aiClaimErr + (j.error || ('HTTP ' + r.status))) + '</span>'; return; }
  box.innerHTML = '<div>' + t.aiClaimOk + '</div>' +
    '<div class="mono">claim #' + esc(String(j.claim.id)) + ' · ' + esc(j.claim.address_hex) + ' · exact ' + esc(j.claim.exact_units) + ' units</div>';
}
async function refreshTnk() {
  try {
    const rs = await Promise.all([
      fetch('https://api.coingecko.com/api/v3/simple/price?ids=trac-network&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true'),
      fetch('https://api.coingecko.com/api/v3/coins/trac-network/tickers') ]);
    if (!rs[0].ok || !rs[1].ok) return;
    const pr = await rs[0].json(), tk = await rs[1].json();
    const d = pr && pr['trac-network']; if (!d) return;
    document.getElementById('tnkPrice').textContent = '$' + Number(d.usd).toFixed(6);
    const ch = Number(d.usd_24h_change), chEl = document.getElementById('tnkChange');
    chEl.textContent = (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%';
    chEl.style.color = ch >= 0 ? 'var(--accent)' : 'var(--warn)';
    document.getElementById('tnkVol').textContent = '$' + tnkNum(d.usd_24h_vol);
    document.getElementById('tnkMcap').textContent = '$' + tnkNum(d.usd_market_cap);
    const byName = {};
    for (const t of (tk.tickers || [])) {
      if (t.target !== 'USDT') continue;
      const id = (t.market && t.market.identifier) || '';
      const nm = id === 'gate' ? 'Gate' : (id === 'mxc' || id === 'mexc') ? 'MEXC' : null;
      if (!nm || byName[nm] || !t.converted_last) continue;
      byName[nm] = '<tr><td>' + nm + '</td><td>$' + Number(t.converted_last.usd).toFixed(6) + '</td><td>' + tnkNum(t.volume, 2) + '</td></tr>';
    }
    const rows = ['MEXC', 'Gate'].map(n => byName[n]).filter(Boolean);
    if (rows.length) document.getElementById('tnkExBody').innerHTML = rows.join('');
    const now = new Date(), p = n => String(n).padStart(2, '0');
    tnkStamp = p(now.getHours()) + ':' + p(now.getMinutes()) + ':' + p(now.getSeconds());
    renderTnkStamp();
  } catch (e) { /* keep last values; retry next cycle */ }
}
refreshTnk();
setInterval(refreshTnk, 30000);
applyLang();
const _initHash = (location.hash || '').slice(1);
showTab(_initHash === 'join' ? 'overview' : (_initHash || (() => { try { return localStorage.getItem('pool-tab'); } catch (e) { return null; } })() || 'overview'));
if (_initHash === 'join') setTimeout(() => { const el = document.getElementById('join'); if (el) el.scrollIntoView(); }, 80);
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
const lbRows = allMiners.map(r => [r[0], String(r[1]), balances[r[0]] ?? null, String(r[2]), r[3], r[4], r[5], r[6], String(r[7])]);
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
 lbSearchHint: "Search the full leaderboard by address:", searchPh: "Your address — RESET hex or trac1…", searchBtn: "Look up",
 thRank: "#", thAddress: "Address", thDeposit: "Deposit", thBalance: "Balance", thExiting: "Exiting",
 thStrikes: "Strikes / clean", thClaimed: "Claimed", thLast: "Last result", poolTag: "pool", joinLink: "join via the calculator",
 prev: "← Prev", next: "Next →", pageOf: (a, b) => "Page " + a + " of " + b,
 qInvalid: "That does not look like a valid address — enter the 64-hex RESET address or the trac1 address (the same key in two encodings).",
 lbNotFound: "This address is not in the current miners snapshot.",
 lbRank: "Rank", footerGen: "Snapshot time", dataSource: "Data source",
 footerNote: "It is a static snapshot — no live polling, no login, no tracking." },
zh: { title: "质押榜", langBtn: "English", back: "← 返回拼池主页",
 themeToDark: "🌙 夜晚", themeToLight: "☀️ 白天",
 lbMinersN: "上榜地址数", lbStakers: "质押地址数", lbTotalStaked: "质押总和（RESET）",
 lbSearchHint: "在完整质押榜里按地址搜索：", searchPh: "你的地址——RESET 十六进制或 trac1…", searchBtn: "查询",
 thRank: "名次", thAddress: "地址", thDeposit: "质押", thBalance: "余额", thExiting: "退出中",
 thStrikes: "罚分 / 干净轮", thClaimed: "本轮已 claim", thLast: "上轮结果", poolTag: "池子", joinLink: "用计算器入池",
 prev: "← 上一页", next: "下一页 →", pageOf: (a, b) => "第 " + a + " / " + b + " 页",
 qInvalid: "这不像一个有效地址——请填 64 位十六进制 RESET 地址或 trac1 地址（两者是同一把钥匙的两种写法）。",
 lbNotFound: "该地址不在当前矿工快照名单里。",
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
      '<td class="mono"><a href="address.html?addr=' + r[0] + '">' + r[0] + '</a>' + (r[0] === POOL_ADDR ? ' <span class="badge">' + t.poolTag + '</span> <a href="index.html#join">' + t.joinLink + '</a>' : '') + '</td>' +
      '<td>' + fmt(r[1]) + '</td><td>' + fmt(r[2]) + '</td><td>' + fmt(r[3]) + '</td>' +
      '<td>' + r[4] + ' / ' + r[5] + '</td><td>' + (r[6] ? '✓' : '—') + '</td>' +
      '<td>' + (r[7] ? '#' + r[7] + ': ' + fmt(r[8]) : '—') + '</td></tr>';
  }).join('');
  document.getElementById('pgInfo').textContent = t.pageOf(lbPage + 1, pages);
  document.getElementById('pgPrev').disabled = lbPage <= 0;
  document.getElementById('pgNext').disabled = lbPage >= pages - 1;
}
function goPage(p) { lbPage = p; hlRank = -1; renderLb(); }
// --- Address formats: the 64-hex RESET address and the trac1 (TNK) address
// are the SAME 32-byte key in two encodings (bech32m, HRP "trac", payload =
// the raw key, checksum verified). normalizeAddress maps either spelling to
// canonical lowercase hex. Mirrors lib/fpmatch.mjs exactly.
function normalizeAddress(input) {
  if (typeof input !== 'string') return null;
  var s = input.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  if (!/^trac1/i.test(s)) return null;
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return null; // bech32 forbids mixed case
  var a = s.toLowerCase();
  var pos = a.lastIndexOf('1');
  if (pos < 1 || a.slice(0, pos) !== 'trac') return null;
  var part = a.slice(pos + 1);
  if (part.length < 6) return null;
  var CS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  var data = [];
  for (var i = 0; i < part.length; i++) { var v = CS.indexOf(part[i]); if (v < 0) return null; data.push(v); }
  var GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  var vals = [];
  for (var j = 0; j < 4; j++) vals.push('trac'.charCodeAt(j) >> 5);
  vals.push(0);
  for (var j2 = 0; j2 < 4; j2++) vals.push('trac'.charCodeAt(j2) & 31);
  vals = vals.concat(data);
  var chk = 1;
  for (var k = 0; k < vals.length; k++) { var top = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ vals[k];
    for (var b = 0; b < 5; b++) if ((top >>> b) & 1) chk ^= GEN[b]; }
  if ((chk >>> 0) !== 0x2bc830a3) return null; // bech32m checksum
  var acc = 0, bits = 0, bytes = [];
  var payload = data.slice(0, data.length - 6);
  for (var m = 0; m < payload.length; m++) { acc = (acc << 5) | payload[m]; bits += 5;
    while (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); } }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff) !== 0) return null;
  if (bytes.length !== 32) return null;
  return bytes.map(function (x) { return x.toString(16).padStart(2, '0'); }).join('');
}
function lbLookup() {
  const t = T[lang];
  const rawQ = document.getElementById('lbq').value.trim();
  const addr = normalizeAddress(rawQ);
  lastLbQuery = rawQ;
  const box = document.getElementById('lbResult');
  if (!addr) { box.innerHTML = '<span style="color:var(--warn)">' + t.qInvalid + '</span>'; return; }
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

// ---------------------------------------------------------------------------
// Standalone address detail page (docs/address.html?addr=<64hex>).
// Data: the trimmed full accounts fetched for every listed miner address.
// Shows everything the gateway exposes for one address — balance, deposit,
// pending exits with release heights, this round's claim, fair estimate,
// strikes/clean, and the last settled round's result. The page states openly
// that transfer history is NOT among it: the gateway has no history API.
const addrRanks = Object.fromEntries(allMiners.map((r, i) => [r[0], i + 1]));
// Pool ledger positions for the address page's pool section (settled
// exits included): the chain account data above knows nothing of the
// pool's internal book, so the generator embeds the relevant slice.
const addrPoolPos = Object.fromEntries(Object.entries(ledger.contributors).map(([a, c]) => [a, {
  contributed: c.contributed, pending: c.pending, paid_total: c.paid_total,
  closed: c.closed ? { principal_units: c.closed.principal_units, earnings_units: c.closed.earnings_units,
    total_units: c.closed.total_units, at: c.closed.at } : null }]));
const addrPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RESET Mining Pool — Address Detail</title>
<script>try{document.documentElement.dataset.theme=localStorage.getItem('pool-theme')||'light'}catch(e){document.documentElement.dataset.theme='light'}</script>
<style>
 :root, :root[data-theme="light"]{--bg:#ffffff;--fg:#1f2328;--muted:#59636e;--card:#f6f8fa;--border:#d1d9e0;--border2:#e3e8ee;--code:#eaeef2;--input:#ffffff;--accent:#1a7f37;--warn:#9e6a03}
 :root[data-theme="dark"]{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--card:#161b22;--border:#30363d;--border2:#21262d;--code:#21262d;--input:#0d1117;--accent:#3fb950;--warn:#d29922}
 body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:24px;max-width:860px;margin-inline:auto;line-height:1.55}
 h1{font-size:22px;margin:0 0 4px} h2{font-size:17px;margin:24px 0 8px;border-bottom:1px solid var(--border);padding-bottom:6px}
 .muted{color:var(--muted)} .mono{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;word-break:break-all}
 .card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px;margin:12px 0}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}
 .stat{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px}
 .stat b{display:block;font-size:19px} .stat span{color:var(--muted);font-size:13px}
 .poolbanner{border:1.5px solid var(--warn);background:var(--card);border-radius:10px;padding:14px 16px;margin:12px 0}
 table{width:100%;border-collapse:collapse;font-size:14px} td,th{padding:7px 8px;border-bottom:1px solid var(--border2);text-align:left}
 button{background:var(--code);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:5px 12px;cursor:pointer}
 a{color:var(--accent)} .topbar{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
 .topbtns{display:flex;gap:6px;flex-shrink:0}
</style></head><body>
<div class="topbar"><div>
<h1 data-i18n="title">Address detail</h1>
<p class="muted"><a href="leaderboard.html" data-i18n="back">← Back to the leaderboard</a></p>
</div><div class="topbtns"><button id="themeBtn" onclick="toggleTheme()">🌙</button><button id="langBtn" onclick="toggleLang()">中文</button></div></div>
<div id="detail"></div>
<p class="muted"><span data-i18n="footerGen">Snapshot time</span> <span id="snapshotTime">${updated}</span>. <span data-i18n="footerNote">It is a static snapshot — no live polling, no login, no tracking.</span></p>
<p class="muted"><span data-i18n="dataSource">Data source</span>: <a href="https://github.com/chilperbf24/reset-mining-pool" target="_blank" rel="noopener">https://github.com/chilperbf24/reset-mining-pool</a></p>
<script>
const ACCOUNTS = ${JSON.stringify(accountsFull)};
const LEDGER_POS = ${JSON.stringify(addrPoolPos)};
const RANKS = ${JSON.stringify(addrRanks)};
const POOL_ADDR = ${JSON.stringify(ledger.pool_address)};
const TOTAL_STAKED = ${JSON.stringify(totalStaked.toString())};
const SNAPSHOT_MS = ${Date.now()};
const T = {
en: { title: "Address detail", langBtn: "中文", back: "← Back to the leaderboard",
 themeToDark: "🌙 Night", themeToLight: "☀️ Day", copy: "Copy address",
 balance: "Balance (RESET)", deposit: "Deposit / staked (RESET)", exiting: "Exiting (RESET)",
 share: "Share of total staked", rank: "Leaderboard rank", of: "of",
 mineTitle: "Mining", claimNow: "Claim this round", claimNone: "no claim yet this round", level: "level",
 fairEst: "Fair-share estimate (RESET)", strikes: "Strikes", clean: "Clean rounds", moves: "Moves this height",
 lastTitle: "Last settled round result", round: "Round", fair: "Fair share (RESET)", amount: "Received (RESET)",
 penalty: "Penalty (RESET)", noLast: "No settled round result yet.",
 exitsTitle: "Pending exits", exitAmount: "Amount (RESET)", exitRelease: "Release height",
 noExits: "No pending exits.",
 poolPosTitle: "Pool position",
 poolClosed: "Settled by full exit: principal {p} + earnings {e} = {t} RESET, paid on {d}.",
 poolOpenPos: "Open position in this pool — contributed {c}, pending earnings {p}, already paid {paid} (all RESET).",
 historyTitle: "About history & transfers",
 historyNote: "What this page can show is the address's current state plus its last settled round result and pending exits. Transfer history cannot be listed: the RESET gateway exposes no transaction-history API and the contract keeps no per-address transfer log. A full history would require running a dedicated indexer that records every move from the start (stage 3).",
 invalid: "Missing or invalid address in the URL (?addr=<64-hex RESET address or trac1 address>).",
 poolBanner: "This is the <b>mining pool address</b>. To join the pool, never transfer a round amount here — it cannot be matched to you and is parked as <b>unclaimed</b>. <a href='index.html#join'>First compute your exact amount with the Join calculator →</a>",
 notFound: "This address is not in the current miners snapshot.",
 footerGen: "Snapshot time", dataSource: "Data source",
 footerNote: "It is a static snapshot — no live polling, no login, no tracking." },
zh: { title: "地址详情", langBtn: "English", back: "← 返回质押榜",
 themeToDark: "🌙 夜晚", themeToLight: "☀️ 白天", copy: "复制地址",
 balance: "余额（RESET）", deposit: "质押（RESET）", exiting: "退出中（RESET）",
 share: "占总质押比例", rank: "质押榜名次", of: "/",
 mineTitle: "挖矿", claimNow: "本轮 claim", claimNone: "本轮尚未 claim", level: "等级",
 fairEst: "预计公平份额（RESET）", strikes: "罚分", clean: "干净轮数", moves: "本高度已用步数",
 lastTitle: "上一轮结算结果", round: "轮次", fair: "公平份额（RESET）", amount: "实收（RESET）",
 penalty: "罚款（RESET）", noLast: "尚无已结算轮次结果。",
 exitsTitle: "退出中的记录", exitAmount: "金额（RESET）", exitRelease: "解锁高度",
 noExits: "没有退出中的记录。",
 poolPosTitle: "拼池份额",
 poolClosed: "已全额退出结清：本金 {p}＋收益 {e}＝{t} RESET，结清于 {d}。",
 poolOpenPos: "在池内的未结清份额——已出资 {c}，待分收益 {p}，已分发 {paid}（均为 RESET）。",
 historyTitle: "关于历史与转账记录",
 historyNote: "本页能展示的是该地址的当前状态、上一轮结算结果和退出中的记录。转账记录无法列出：RESET 网关没有交易历史接口，合约也不保存逐地址的转账流水。完整的历史需要自建索引节点从一开始逐条记录（第三阶段）。",
 invalid: "URL 里缺少地址或地址格式不对（?addr=<64 位 RESET 地址或 trac1 地址>）。",
 poolBanner: "这是<b>拼池地址</b>。入池切勿直接转整数金额——对不上号，会被记为<b>待认领</b>。<a href='index.html#join'>先去主页用入池计算器算出你的专属金额 →</a>",
 notFound: "该地址不在当前矿工快照名单里。",
 footerGen: "快照时间", dataSource: "数据来源于",
 footerNote: "这是静态快照——不实时轮询、不登录、不追踪。" }
};
let lang = localStorage.getItem('pool-lang') || 'en';
function fmt(u) { if (u == null) return '—'; const b = BigInt(u); return (b / 100000000n) + '.' + (b % 100000000n).toString().padStart(8, '0'); }
function snapshotTimeText() { const d = new Date(SNAPSHOT_MS); const p = n => String(n).padStart(2, '0');
  if (lang === 'zh') { const b = new Date(d.getTime() + 8 * 3600000);
    return b.getUTCFullYear() + '-' + p(b.getUTCMonth() + 1) + '-' + p(b.getUTCDate()) + ' ' + p(b.getUTCHours()) + ':' + p(b.getUTCMinutes()) + ':' + p(b.getUTCSeconds()) + ' GMT+8'; }
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) + ' UTC'; }
function syncThemeBtn() { const dark = document.documentElement.dataset.theme === 'dark'; document.getElementById('themeBtn').textContent = dark ? T[lang].themeToLight : T[lang].themeToDark; }
function toggleTheme() { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; try { localStorage.setItem('pool-theme', next); } catch (e) {} syncThemeBtn(); }
function toggleLang() { lang = lang === 'zh' ? 'en' : 'zh'; localStorage.setItem('pool-lang', lang); applyLang(); }
// --- Address formats: the 64-hex RESET address and the trac1 (TNK) address
// are the SAME 32-byte key in two encodings (bech32m, HRP "trac", payload =
// the raw key, checksum verified). normalizeAddress maps either spelling to
// canonical lowercase hex, so ?addr= works in both forms — including the
// pool banner check below. Mirrors lib/fpmatch.mjs exactly.
function normalizeAddress(input) {
  if (typeof input !== 'string') return null;
  var s = input.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  if (!/^trac1/i.test(s)) return null;
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return null; // bech32 forbids mixed case
  var a = s.toLowerCase();
  var pos = a.lastIndexOf('1');
  if (pos < 1 || a.slice(0, pos) !== 'trac') return null;
  var part = a.slice(pos + 1);
  if (part.length < 6) return null;
  var CS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  var data = [];
  for (var i = 0; i < part.length; i++) { var v = CS.indexOf(part[i]); if (v < 0) return null; data.push(v); }
  var GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  var vals = [];
  for (var j = 0; j < 4; j++) vals.push('trac'.charCodeAt(j) >> 5);
  vals.push(0);
  for (var j2 = 0; j2 < 4; j2++) vals.push('trac'.charCodeAt(j2) & 31);
  vals = vals.concat(data);
  var chk = 1;
  for (var k = 0; k < vals.length; k++) { var top = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ vals[k];
    for (var b = 0; b < 5; b++) if ((top >>> b) & 1) chk ^= GEN[b]; }
  if ((chk >>> 0) !== 0x2bc830a3) return null; // bech32m checksum
  var acc = 0, bits = 0, bytes = [];
  var payload = data.slice(0, data.length - 6);
  for (var m = 0; m < payload.length; m++) { acc = (acc << 5) | payload[m]; bits += 5;
    while (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); } }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff) !== 0) return null;
  if (bytes.length !== 32) return null;
  return bytes.map(function (x) { return x.toString(16).padStart(2, '0'); }).join('');
}
function render() {
  const t = T[lang];
  const addr = normalizeAddress(new URLSearchParams(location.search).get('addr') || '');
  const box = document.getElementById('detail');
  if (!addr) { box.innerHTML = '<p style="color:var(--warn)">' + t.invalid + '</p>'; return; }
  const banner = addr === POOL_ADDR ? '<div class="poolbanner">' + t.poolBanner + '</div>' : '';
  const pos = LEDGER_POS[addr];
  const poolSection = pos ? '<h2>' + t.poolPosTitle + '</h2><div class="card"><p style="margin:0">' + (pos.closed
    ? t.poolClosed.replace('{p}', fmt(pos.closed.principal_units)).replace('{e}', fmt(pos.closed.earnings_units)).replace('{t}', fmt(pos.closed.total_units)).replace('{d}', String(pos.closed.at).slice(0, 10))
    : t.poolOpenPos.replace('{c}', fmt(pos.contributed)).replace('{p}', fmt(pos.pending)).replace('{paid}', fmt(pos.paid_total))) + '</p></div>' : '';
  const acc = ACCOUNTS[addr];
  if (!acc) { box.innerHTML = banner + '<p style="color:var(--warn)">' + t.notFound + '</p><p class="mono">' + addr + '</p>' + poolSection; return; }
  const m = acc.mine || {};
  const exits = acc.exits || [];
  const exitTotal = exits.reduce((s, e) => s + BigInt(e.amount), 0n);
  const dep = BigInt(acc.deposit || '0'), tot = BigInt(TOTAL_STAKED);
  const sharePct = tot === 0n ? '0.00' : (Number(dep * 1000000n / tot) / 10000).toFixed(2);
  const lr = m.last_result;
  box.innerHTML = banner +
    '<div class="card"><div class="mono" id="daddr">' + addr + '</div>' +
    '<button onclick="navigator.clipboard.writeText(document.getElementById(\\'daddr\\').textContent)">' + t.copy + '</button></div>' +
    '<div class="grid">' +
    '<div class="stat"><b>' + fmt(acc.balance) + '</b><span>' + t.balance + '</span></div>' +
    '<div class="stat"><b>' + fmt(acc.deposit) + '</b><span>' + t.deposit + '</span></div>' +
    '<div class="stat"><b>' + fmt(exitTotal.toString()) + '</b><span>' + t.exiting + '</span></div>' +
    '<div class="stat"><b>' + sharePct + '%</b><span>' + t.share + '</span></div>' +
    '<div class="stat"><b>#' + (RANKS[addr] || '—') + '</b><span>' + t.rank + '</span></div>' +
    '</div>' +
    poolSection +
    '<h2>' + t.mineTitle + '</h2><div class="card"><table>' +
    '<tr><td>' + t.claimNow + '</td><td>' + (m.claim ? t.level + ' ' + m.claim.q : t.claimNone) + '</td></tr>' +
    '<tr><td>' + t.fairEst + '</td><td>' + fmt(m.fair_share_estimate || '0') + '</td></tr>' +
    '<tr><td>' + t.strikes + ' / ' + t.clean + '</td><td>' + (m.strikes ?? 0) + ' / ' + (m.clean ?? 0) + '</td></tr>' +
    '<tr><td>' + t.moves + '</td><td>' + (acc.moves_this_height ?? 0) + '</td></tr></table></div>' +
    '<h2>' + t.lastTitle + '</h2>' + (lr ?
      '<div class="card"><table>' +
      '<tr><td>' + t.round + '</td><td>#' + lr.r + '</td></tr>' +
      '<tr><td>' + t.fair + '</td><td>' + fmt(lr.fair) + '</td></tr>' +
      '<tr><td>' + t.amount + '</td><td>' + fmt(lr.amount) + '</td></tr>' +
      '<tr><td>' + t.penalty + '</td><td>' + fmt(lr.penalty) + '</td></tr>' +
      '<tr><td>' + t.strikes + ' / ' + t.clean + '</td><td>' + lr.strikes + ' / ' + lr.clean + '</td></tr></table></div>'
      : '<p class="muted">' + t.noLast + '</p>') +
    '<h2>' + t.exitsTitle + '</h2>' + (exits.length ?
      '<table><tr><th>' + t.exitAmount + '</th><th>' + t.exitRelease + '</th></tr>' +
      exits.map(e => '<tr><td>' + fmt(e.amount) + '</td><td>' + e.release + '</td></tr>').join('') + '</table>'
      : '<p class="muted">' + t.noExits + '</p>') +
    '<h2>' + t.historyTitle + '</h2><div class="card"><p>' + t.historyNote + '</p></div>';
}
function applyLang() {
  const t = T[lang];
  document.querySelectorAll('[data-i18n]').forEach(el => { const v = t[el.dataset.i18n]; if (v != null) el.innerHTML = v; });
  document.getElementById('langBtn').textContent = t.langBtn;
  document.title = 'RESET Mining Pool — ' + t.title;
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.getElementById('snapshotTime').textContent = snapshotTimeText();
  syncThemeBtn();
  render();
}
applyLang();
</script>
</body></html>`;
writeFileSync(`${ROOT}/docs/address.html`, addrPage);
console.log(JSON.stringify({ ok: true, file: `${ROOT}/docs/address.html`, accounts: Object.keys(accountsFull).length }));

// ---------------------------------------------------------------------------
// Standalone exit page (docs/exit.html): the REAL exit interface, presented
// while the channel is TEMPORARILY CLOSED (operator ruling 2026-10-23;
// user direction the same evening: show the interface, just unusable for
// now — no wall of text). Structure mirrors the old Overview exit card:
// title, closed banner, the two short explainer paragraphs, then the five
// interface stages:
//   1) position lookup — LIVE, read-only against the published snapshot
//   2) file intent — DISABLED (disabled button + closed badge, no handler)
//   3) sign — read-only signing-text template + copy button + one-line guide
//   4) submit signature — DISABLED (textarea + button disabled, badge)
//   5) exit-case progress — LIVE, read-only against the published public
//      case summary (EXIT_CASES below, projected by lib/exit-public.mjs)
// The page script contains NO network call at all, so stages 2/4 cannot
// reach the registry from here even if the disabled attributes were
// stripped — no handler exists. The backend double-safety is untouched:
// the registry EXIT_OPEN gate (403) and the executor gate (ARMED=false).
// The prose walkthrough lives on the About page's exit chapter
// (docs/about.html#exit), linked from the page foot.
const exitSignTplPreview =
  'reset-chat/v1\n' +
  '{"addr":"<your address>","kind":"agent","nonce":"<one-time nonce>",' +
  '"text":"EXIT full pool position. Pool ' + ledger.pool_address + ' member <your address> nonce <one-time nonce>",' +
  '"ts":<timestamp>,"v":1}';
const exitPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RESET Mining Pool — Leave the pool — full exit</title>
<script>try{document.documentElement.dataset.theme=localStorage.getItem('pool-theme')||'light'}catch(e){document.documentElement.dataset.theme='light'}</script>
<style>
 :root, :root[data-theme="light"]{--bg:#ffffff;--fg:#1f2328;--muted:#59636e;--card:#f6f8fa;--border:#d1d9e0;--border2:#e3e8ee;--code:#eaeef2;--input:#ffffff;--accent:#1a7f37;--warn:#9e6a03;--hl:#fff3cd}
 :root[data-theme="dark"]{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--card:#161b22;--border:#30363d;--border2:#21262d;--code:#21262d;--input:#0d1117;--accent:#3fb950;--warn:#d29922;--hl:#3a2f04}
 body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:24px;max-width:860px;margin-inline:auto;line-height:1.55}
 h1{font-size:24px;margin:0 0 4px} h2{font-size:18px;margin:22px 0 8px}
 .muted{color:var(--muted)} .mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all}
 .card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px;margin:12px 0}
 button{background:var(--code);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:5px 12px;cursor:pointer}
 button:disabled{cursor:not-allowed;opacity:.65}
 a{color:var(--accent)} .topbar{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
 .topbtns{display:flex;gap:6px;flex-shrink:0}
 .warnbar{border:1.5px solid var(--warn);border-left:6px solid var(--warn);background:color-mix(in srgb, var(--warn) 14%, var(--card));border-radius:10px;padding:12px 14px;font-size:17px;line-height:1.5;margin:14px 0;color:var(--fg)}
 input{background:var(--input);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:6px 10px;min-width:min(430px,78%)}
 textarea{width:100%;box-sizing:border-box;background:var(--input);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:8px;font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.5}
 textarea:disabled{opacity:.8}
 table{border-collapse:collapse;margin-top:8px} td{padding:2px 16px 2px 0}
 .stage h3{margin:0 0 10px;font-size:16px;display:flex;align-items:center;gap:9px;flex-wrap:wrap}
 .stepdot{flex:none;width:24px;height:24px;border-radius:50%;background:var(--fg);color:var(--bg);font-weight:700;display:inline-flex;align-items:center;justify-content:center;font-size:13px}
 .closedtag{font-size:12px;font-weight:700;color:var(--warn);border:1.5px solid var(--warn);border-radius:999px;padding:1px 9px;background:color-mix(in srgb, var(--warn) 12%, transparent)}
 .stage.off{opacity:.55;filter:grayscale(.35)}
 .stage.off .stepdot{background:var(--muted)}
 .noncebox{border:1.5px dashed var(--border);border-radius:8px;padding:12px;color:var(--muted);background:var(--card);margin-top:10px}
 .track{list-style:none;margin:8px 0;padding:0}
 .track li{display:flex;gap:10px;align-items:flex-start;padding:4px 0}
 .tdot{flex:none;width:20px;height:20px;border-radius:50%;border:2px solid var(--border);background:var(--bg);display:inline-flex;align-items:center;justify-content:center;font-size:12px;margin-top:1px}
 .track li.done .tdot{background:var(--accent);border-color:var(--accent);color:#fff}
 .track li.now .tdot{border-color:var(--warn);background:var(--hl)}
 .track li.todo{color:var(--muted)}
 .tsub{color:var(--muted);font-size:13px}
 .casecard{border-top:1px solid var(--border2);padding-top:12px;margin-top:12px}
 .statustag{font-size:12px;font-weight:700;border:1.5px solid var(--accent);color:var(--accent);border-radius:999px;padding:1px 9px}
 .statustag.warn{border-color:var(--warn);color:var(--warn)}
 .morelink{font-size:17px;font-weight:600;margin:20px 0 6px}
</style></head><body>
<div class="topbar"><div>
<h1 data-i18n="title">Leave the pool — full exit</h1>
<p class="muted"><a href="index.html" data-i18n="back">← Back to the pool page</a></p>
</div><div class="topbtns"><button id="themeBtn" onclick="toggleTheme()">🌙</button><button id="langBtn" onclick="toggleLang()">中文</button></div></div>

<div class="warnbar" data-i18n="closedBanner">⏸ <b>Exit channel temporarily closed.</b> The pool is still small, so exits are paused for now; the channel reopens once the pool has grown and the exit executor has passed a full end-to-end live test. The interface below is the real one, shown as it will run — filing and submission are disabled, position lookup works.</div>

<p data-i18n="exitIntro">Exiting is your right, not a favor: a verified request is executed automatically. Three things to know — <b>exits are full only</b> (principal + pending earnings, settled in one payment); payout takes <b>about 24 hours</b> (the contract's 144-block exit wait); and if an exit would leave the pool's deposit below 0.1, <b>the whole pool is dissolved and everyone is settled</b> instead.</p>
<p data-i18n="exitHow"><b>No transfer is needed to prove it is you — a signature is.</b> Your coins are inside the pool, so your wallet may be empty; signing costs nothing and works at zero balance. The server issues a one-time statement (the official signed-message format); you sign it with your own signer and submit the signature. Anyone — including your own AI — can file the request and carry the submission, but only your key can sign. And the payout can only ever go to your own ledger address: no step in this flow can name a different payee.</p>

<div class="card stage" id="stage1">
 <h3><span class="stepdot">1</span> <span data-i18n="seg1Title">Check your position</span></h3>
 <p><input id="exitAddr" data-i18n-ph="queryPh" placeholder="Your address — RESET hex or trac1…"> <button type="button" id="exitPosBtn" onclick="exitShow()" data-i18n="exitPosBtn">Show my position</button></p>
 <div id="exitPos"></div>
</div>

<div class="card stage off" id="stage2">
 <h3><span class="stepdot">2</span> <span data-i18n="seg2Title">File the exit intent</span> <span class="closedtag" data-i18n="closedTag">Temporarily closed</span></h3>
 <p><button type="button" id="exitApplyBtn" disabled data-i18n="exitApplyBtn">File exit intent — get a one-time statement</button></p>
 <div class="noncebox mono" id="nonceBox" data-i18n="noncePh">Once filing is open, your one-time statement — the prepared message with its nonce — will appear here.</div>
</div>

<div class="card stage" id="stage3">
 <h3><span class="stepdot">3</span> <span data-i18n="seg3Title">Sign the statement</span></h3>
 <div class="muted"><span data-i18n="exitSignTextLabel">Signing text — exactly what your key signs</span> <button type="button" id="copySignBtn" data-i18n="copyBtn">Copy</button></div>
 <textarea id="signTpl" readonly rows="4">${exitSignTplPreview}</textarea>
 <p class="muted" data-i18n="signGuide">Sign this exact text with your own wallet — or hand it to your own AI's signer. Signing moves no coins and works at zero balance.</p>
</div>

<div class="card stage off" id="stage4">
 <h3><span class="stepdot">4</span> <span data-i18n="seg4Title">Submit the signature</span> <span class="closedtag" data-i18n="closedTag">Temporarily closed</span></h3>
 <p><textarea id="exitSig" rows="4" disabled data-i18n-ph="exitSubmitPh" placeholder="Paste the submission JSON here — {prepared, signature, nonce}"></textarea></p>
 <p><button type="button" id="exitSubmitBtn" disabled data-i18n="exitSubmitBtn">Submit signature — verify &amp; open my case</button></p>
</div>

<div class="card stage" id="stage5">
 <h3><span class="stepdot">5</span> <span data-i18n="seg5Title">Track your exit</span></h3>
 <p><input id="exitCaseAddr" data-i18n-ph="queryPh" placeholder="Your address — RESET hex or trac1…"> <button type="button" id="exitCaseBtn" onclick="exitCaseShow()" data-i18n="caseBtn">Check progress</button></p>
 <div id="exitCase"></div>
 <p class="muted" id="caseNote"></p>
</div>

<p class="morelink"><a href="about.html#exit" data-i18n="moreLink">Full introduction — including the detailed exit walkthrough →</a></p>

<p class="muted"><span data-i18n="footerGen">Snapshot time</span> <span id="snapshotTime">${updated}</span>. <span data-i18n="footerNote">It is a static snapshot — no live polling, no login, no tracking.</span></p>
<p class="muted"><span data-i18n="dataSource">Data source</span>: <a href="https://github.com/chilperbf24/reset-mining-pool" target="_blank" rel="noopener">https://github.com/chilperbf24/reset-mining-pool</a></p>

<script>
const SNAPSHOT = ${JSON.stringify(snapshotData)};
const SNAPSHOT_MS = ${Date.now()};
const EXIT_CASES = ${JSON.stringify(exitCasesPub)};
const SNAPSHOT_COUNTED = ${snapshotCounted == null ? 'null' : snapshotCounted};
const EXIT_POOL = ${JSON.stringify(ledger.pool_address)};
const T = {
en: { title: "Leave the pool — full exit", langBtn: "中文", back: "← Back to the pool page",
 themeToDark: "🌙 Night", themeToLight: "☀️ Day",
 closedBanner: "⏸ <b>Exit channel temporarily closed.</b> The pool is still small, so exits are paused for now; the channel reopens once the pool has grown and the exit executor has passed a full end-to-end live test. The interface below is the real one, shown as it will run — filing and submission are disabled, position lookup works.",
 exitIntro: "Exiting is your right, not a favor: a verified request is executed automatically. Three things to know — <b>exits are full only</b> (principal + pending earnings, settled in one payment); payout takes <b>about 24 hours</b> (the contract's 144-block exit wait); and if an exit would leave the pool's deposit below 0.1, <b>the whole pool is dissolved and everyone is settled</b> instead.",
 exitHow: "<b>No transfer is needed to prove it is you — a signature is.</b> Your coins are inside the pool, so your wallet may be empty; signing costs nothing and works at zero balance. The server issues a one-time statement (the official signed-message format); you sign it with your own signer and submit the signature. Anyone — including your own AI — can file the request and carry the submission, but only your key can sign. And the payout can only ever go to your own ledger address: no step in this flow can name a different payee.",
 seg1Title: "Check your position", queryPh: "Your address — RESET hex or trac1…", exitPosBtn: "Show my position",
 qInvalid: "That does not look like a valid address — enter the 64-hex RESET address or the trac1 address (the same key in two encodings).",
 exitNoPos: "This address has no open position in the current ledger snapshot.",
 qClosed: "This position was settled by a full exit on {date} — total paid {total} RESET.",
 qShare: "Share of pool", qContributed: "Contributed", qPending: "Pending payout", qDue: "Due on exit (principal + pending)",
 seg2Title: "File the exit intent", exitApplyBtn: "File exit intent — get a one-time statement",
 noncePh: "Once filing is open, your one-time statement — the prepared message with its nonce — will appear here.",
 seg3Title: "Sign the statement", exitSignTextLabel: "Signing text — exactly what your key signs",
 copyBtn: "Copy", copiedOk: "Copied ✓",
 signGuide: "Sign this exact text with your own wallet — or hand it to your own AI's signer. Signing moves no coins and works at zero balance.",
 phAddr: "<your address>", phNonce: "<one-time nonce>", phTs: "<timestamp>",
 seg4Title: "Submit the signature", exitSubmitPh: "Paste the submission JSON here — {prepared, signature, nonce}",
 exitSubmitBtn: "Submit signature — verify & open my case", closedTag: "Temporarily closed",
 seg5Title: "Track your exit", caseBtn: "Check progress",
 caseNote: "Progress is read from this page's published snapshot (refreshed about every 10 minutes); blocks remaining are counted against snapshot height {h}.",
 caseNone: "This address has no exit case in the published snapshot.",
 nCase: "Case opened — payout frozen", nUnlock: "Stake unlocked", nWait: "Waiting for maturity",
 nWithdrawn: "Withdrawn back to the pool balance", nPaid: "Paid out — case closed",
 fCase: "Case", fDue: "Frozen payout due", fUnlockAmt: "Unlocked", fRelease: "Release height", fPaidAmt: "Paid",
 kRemaining: "about {n} blocks to go", kMatured: "matured",
 stVerified: "Filed — waiting to unlock", stUnlocking: "Unlocking", stWaiting: "Waiting for maturity",
 stWithdrawing: "Withdrawing", stPaying: "Paying out", stDone: "Done — paid in full",
 stHalted: "Paused", stCancelled: "Cancelled — closed for good",
 caseCancelledNote: "This case was cancelled and is closed for good — it will never be executed. The stake it had unlocked was afterwards withdrawn and re-locked in full; the full story is in the About page's exit chapter.",
 caseHaltedNote: "This case is paused, waiting on the operator — nothing is needed from you.",
 moreLink: "Full introduction — including the detailed exit walkthrough →",
 footerGen: "Snapshot time", dataSource: "Data source",
 footerNote: "It is a static snapshot — no live polling, no login, no tracking." },
zh: { title: "退出拼池——全额退出", langBtn: "English", back: "← 返回拼池主页",
 themeToDark: "🌙 夜晚", themeToLight: "☀️ 白天",
 closedBanner: "⏸ <b>退出通道暂时关闭。</b>池子规模尚小，运营者已暂停退出；待池子金额规模上来、且退出执行器完成整机端到端实测后，通道再开放。下面就是将来原样启用的真实界面——登记与提交两步暂时禁用，份额查询照常可用。",
 exitIntro: "退出是你的权利，不是向谁申请批准：验证通过的退出申请会被自动执行。三件事先讲明——<b>只退全额</b>（本金＋待分收益一次结清）；到账需<b>约 24 小时</b>（合约的 144 个比特币块退出等待期）；若某笔退出会让池子质押跌破 0.1，<b>全池解散、所有人一并结清</b>。",
 exitHow: "<b>证明是你本人，不用转币——用签名。</b>你的币在池子里，钱包可能是空的；签名零成本、零余额可办。服务器会签发一份一次性声明（官方签名消息格式），你用自己的签名器签好后把签名提交回来即可。申请和提交可以由任何人代劳——包括你自己的 AI——但只有你的私钥能签。而且退出款<b>只打回你账本上的地址本人</b>：整个流程没有任何一步能改收款地址。",
 seg1Title: "查份额", queryPh: "你的地址——RESET 十六进制或 trac1…", exitPosBtn: "查看我的份额",
 qInvalid: "这不像一个有效地址——请填 64 位十六进制 RESET 地址或 trac1 地址（两者是同一把钥匙的两种写法）。",
 exitNoPos: "该地址在当前账本快照里没有未结清的份额。",
 qClosed: "该份额已于 {date} 通过全额退出结清——共打款 {total} RESET。",
 qShare: "占池份额", qContributed: "已出资", qPending: "待分收益", qDue: "应退额（本金＋待分）",
 seg2Title: "登记退出意向", exitApplyBtn: "登记意向 · 领取一次性口令",
 noncePh: "通道开放并登记后，你的一次性声明（prepared 声明对象＋口令）会显示在这里。",
 seg3Title: "签名", exitSignTextLabel: "签名文本——你的私钥实际签的就是这段",
 copyBtn: "复制", copiedOk: "复制成功 ✓",
 signGuide: "用你自己的钱包、或你自己 AI 的 signer 签这段原文即可——签名不转币，钱包零余额也能签。",
 phAddr: "<你的地址>", phNonce: "<一次性口令>", phTs: "<时间戳>",
 seg4Title: "提交验签", exitSubmitPh: "把提交 JSON 粘贴到这里——{prepared, signature, nonce}",
 exitSubmitBtn: "提交签名 · 验签建案", closedTag: "暂时关闭",
 seg5Title: "退出进度查询", caseBtn: "查询进度",
 caseNote: "进度数据来自本页的已发布快照（约每 10 分钟刷新一次）；剩余块数按快照块高 {h} 计算。",
 caseNone: "该地址在已发布快照里没有退出案件。",
 nCase: "已建案 · 应退冻结", nUnlock: "已解出质押", nWait: "等待到期",
 nWithdrawn: "已取回至池子余额", nPaid: "已打款 · 关账",
 fCase: "案件号", fDue: "冻结应退额", fUnlockAmt: "解出额", fRelease: "到期块高", fPaidAmt: "打款额",
 kRemaining: "还剩约 {n} 块", kMatured: "已到期",
 stVerified: "已建案 · 待解出", stUnlocking: "解出中", stWaiting: "等待到期",
 stWithdrawing: "取回中", stPaying: "打款中", stDone: "已完成 · 全额打款",
 stHalted: "已暂停", stCancelled: "已作废 · 终局关闭",
 caseCancelledNote: "该案件已作废、终局关闭，永不会再被执行。它曾解出的质押其后已取回并整笔复锁——来龙去脉见详细介绍页的退出章。",
 caseHaltedNote: "该案件已暂停、等待运营者处理——你不需要做任何事。",
 moreLink: "完整详细介绍（含退出全流程细节）→",
 footerGen: "快照时间", dataSource: "数据来源于",
 footerNote: "这是静态快照——不实时轮询、不登录、不追踪。" }
};
let lang = localStorage.getItem('pool-lang') || 'en'; // first visit always opens in English
let lastExitQuery = '';
function fmt(u) { if (u == null) return '—'; const b = BigInt(u); return (b / 100000000n) + '.' + (b % 100000000n).toString().padStart(8, '0'); }
function snapshotTimeText() { const d = new Date(SNAPSHOT_MS); const p = n => String(n).padStart(2, '0');
  if (lang === 'zh') { const b = new Date(d.getTime() + 8 * 3600000);
    return b.getUTCFullYear() + '-' + p(b.getUTCMonth() + 1) + '-' + p(b.getUTCDate()) + ' ' + p(b.getUTCHours()) + ':' + p(b.getUTCMinutes()) + ':' + p(b.getUTCSeconds()) + ' GMT+8'; }
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) + ' UTC'; }
// --- Address formats: the 64-hex RESET address and the trac1 (TNK) address
// are the SAME 32-byte key in two encodings (bech32m, HRP "trac", payload =
// the raw key, checksum verified). normalizeAddress maps either spelling to
// canonical lowercase hex. Mirrors lib/fpmatch.mjs exactly (same helper as
// the Overview page).
function normalizeAddress(input) {
  if (typeof input !== 'string') return null;
  var s = input.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  if (!/^trac1/i.test(s)) return null;
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return null; // bech32 forbids mixed case
  var a = s.toLowerCase();
  var pos = a.lastIndexOf('1');
  if (pos < 1 || a.slice(0, pos) !== 'trac') return null;
  var part = a.slice(pos + 1);
  if (part.length < 6) return null;
  var CS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  var data = [];
  for (var i = 0; i < part.length; i++) { var v = CS.indexOf(part[i]); if (v < 0) return null; data.push(v); }
  var GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  var vals = [];
  for (var j = 0; j < 4; j++) vals.push('trac'.charCodeAt(j) >> 5);
  vals.push(0);
  for (var j2 = 0; j2 < 4; j2++) vals.push('trac'.charCodeAt(j2) & 31);
  vals = vals.concat(data);
  var chk = 1;
  for (var k = 0; k < vals.length; k++) { var top = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ vals[k];
    for (var b = 0; b < 5; b++) if ((top >>> b) & 1) chk ^= GEN[b]; }
  if ((chk >>> 0) !== 0x2bc830a3) return null; // bech32m checksum
  var acc = 0, bits = 0, bytes = [];
  var payload = data.slice(0, data.length - 6);
  for (var m = 0; m < payload.length; m++) { acc = (acc << 5) | payload[m]; bits += 5;
    while (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); } }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff) !== 0) return null;
  if (bytes.length !== 32) return null;
  return bytes.map(function (x) { return x.toString(16).padStart(2, '0'); }).join('');
}
// Stage 1 — position lookup. Pure readout of the published snapshot on
// this page: no network call, works while the channel is closed.
function exitShow() {
  const t = T[lang];
  const raw = document.getElementById('exitAddr').value.trim();
  lastExitQuery = raw;
  const addr = normalizeAddress(raw);
  const pos = document.getElementById('exitPos');
  if (!addr) { pos.innerHTML = '<span style="color:var(--warn)">' + t.qInvalid + '</span>'; return; }
  const c = SNAPSHOT.contributors[addr];
  if (!c) { pos.innerHTML = '<span style="color:var(--warn)">' + t.exitNoPos + '</span>'; return; }
  if (c.closed) { pos.innerHTML = '<span style="color:var(--warn)">' + t.qClosed.replace('{date}', String(c.closed.at).slice(0, 10)).replace('{total}', fmt(c.closed.total_units)) + '</span>'; return; }
  const total = BigInt(SNAPSHOT.total_units), contrib = BigInt(c.contributed_units), pend = BigInt(c.pending_units);
  const sharePct = total === 0n ? '0.00' : (Number(contrib * 1000000n / total) / 10000).toFixed(2);
  pos.innerHTML = '<table>' +
    '<tr><td>' + t.qShare + '</td><td>' + sharePct + '%</td></tr>' +
    '<tr><td>' + t.qContributed + '</td><td>' + fmt(contrib) + ' RESET</td></tr>' +
    '<tr><td>' + t.qPending + '</td><td>' + fmt(pend) + ' RESET</td></tr>' +
    '<tr><td>' + t.qDue + '</td><td><b>' + fmt(contrib + pend) + ' RESET</b></td></tr></table>';
}
// Stage 5 — exit-case progress. Same deal as stage 1: a pure readout of
// the published snapshot embedded in this page (EXIT_CASES, the public
// projection of the executor's case file), no network call. The track is
// drawn from the case FACTS (unlock landed? matured at the snapshot
// height? withdrawn? paid?) rather than the raw status alone, and a
// cancelled case renders as a terminal card — never a half-done track.
let lastCaseQuery = '';
function caseStatusText(cs, t) {
  if (cs.status === 'done') return t.stDone;
  if (cs.status === 'cancelled') return t.stCancelled;
  if (cs.status === 'verified') return t.stVerified;
  if (cs.status === 'unlocking') return t.stUnlocking;
  if (cs.status === 'waiting_maturity') return t.stWaiting;
  if (cs.status === 'withdrawing') return t.stWithdrawing;
  if (cs.status === 'paying') return t.stPaying;
  if (cs.status && cs.status.indexOf('halted') === 0) return t.stHalted;
  return cs.status || '';
}
function renderCase(cs, t) {
  let rows = '<tr><td>' + t.fCase + '</td><td class="mono">' + cs.id + '</td></tr>' +
    '<tr><td>' + t.fDue + '</td><td><b>' + fmt(cs.due_units) + ' RESET</b></td></tr>';
  if (cs.unlock && cs.unlock.landed) {
    rows += '<tr><td>' + t.fUnlockAmt + '</td><td>' + fmt(cs.unlock.amount_units) + ' RESET</td></tr>';
    if (cs.unlock.release_at != null) rows += '<tr><td>' + t.fRelease + '</td><td>' + cs.unlock.release_at + '</td></tr>';
  }
  if (cs.paid_units != null) rows += '<tr><td>' + t.fPaidAmt + '</td><td><b>' + fmt(cs.paid_units) + ' RESET</b></td></tr>';
  const warnTag = cs.status === 'cancelled' || (cs.status || '').indexOf('halted') === 0;
  const head = '<p style="margin:0"><span class="statustag' + (warnTag ? ' warn' : '') + '">' + caseStatusText(cs, t) + '</span></p>';
  let body = '<table>' + rows + '</table>';
  if (cs.status === 'cancelled') {
    body += '<p class="muted">' + t.caseCancelledNote + '</p>';
    return '<div class="casecard">' + head + body + '</div>';
  }
  const landed = !!(cs.unlock && cs.unlock.landed);
  const release = cs.unlock ? cs.unlock.release_at : null;
  const matured = !!cs.withdrawn_at || !!cs.paid_at || (release != null && SNAPSHOT_COUNTED != null && SNAPSHOT_COUNTED >= release);
  const withdrawn = !!cs.withdrawn_at || !!cs.paid_at || cs.status === 'paying' || cs.status === 'done';
  const paid = cs.status === 'done';
  const nodes = [];
  nodes.push({ cls: 'done', mark: '✓', label: t.nCase, sub: cs.created_at ? String(cs.created_at).slice(0, 10) : '' });
  nodes.push({ cls: landed ? 'done' : 'now', mark: landed ? '✓' : '●', label: t.nUnlock, sub: landed ? fmt(cs.unlock.amount_units) + ' RESET' : '' });
  let waitSub = '';
  if (release != null) waitSub = t.fRelease + ' ' + release + (matured ? ' · ' + t.kMatured
    : (SNAPSHOT_COUNTED != null ? ' · ' + t.kRemaining.replace('{n}', String(Math.max(0, release - SNAPSHOT_COUNTED))) : ''));
  nodes.push({ cls: matured ? 'done' : (landed ? 'now' : 'todo'), mark: matured ? '✓' : (landed ? '●' : ''), label: t.nWait, sub: waitSub });
  nodes.push({ cls: withdrawn ? 'done' : (matured ? 'now' : 'todo'), mark: withdrawn ? '✓' : (matured ? '●' : ''), label: t.nWithdrawn, sub: cs.withdrawn_at ? String(cs.withdrawn_at).slice(0, 10) : '' });
  nodes.push({ cls: paid ? 'done' : (withdrawn ? 'now' : 'todo'), mark: paid ? '✓' : (withdrawn ? '●' : ''), label: t.nPaid, sub: paid ? fmt(cs.paid_units) + ' RESET · ' + String(cs.paid_at || '').slice(0, 10) : '' });
  body += '<ul class="track">' + nodes.map(n =>
    '<li class="' + n.cls + '"><span class="tdot">' + n.mark + '</span><span>' + n.label +
    (n.sub ? ' <span class="tsub">' + n.sub + '</span>' : '') + '</span></li>').join('') + '</ul>';
  if ((cs.status || '').indexOf('halted') === 0) body += '<p class="muted">' + t.caseHaltedNote + '</p>';
  return '<div class="casecard">' + head + body + '</div>';
}
function exitCaseShow() {
  const t = T[lang];
  const raw = document.getElementById('exitCaseAddr').value.trim();
  lastCaseQuery = raw;
  const box = document.getElementById('exitCase');
  const addr = normalizeAddress(raw);
  if (!addr) { box.innerHTML = '<span style="color:var(--warn)">' + t.qInvalid + '</span>'; return; }
  const list = EXIT_CASES.filter(cs => cs.address === addr)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  if (!list.length) { box.innerHTML = '<span style="color:var(--warn)">' + t.caseNone + '</span>'; return; }
  box.innerHTML = list.map(cs => renderCase(cs, t)).join('');
}
// Stage 3 — the signing-text template, in the exact bytes a member's key
// signs once stage 2 issues a real intent (official agentSigningText:
// 'reset-chat/v1' + stableJSON of {v, kind, addr, text, ts, nonce}; the
// statement text is lib/exit.mjs exitText). Placeholders stand where the
// issued address / nonce / timestamp will go.
function buildSignTemplate() {
  const t = T[lang];
  const text = 'EXIT full pool position. Pool ' + EXIT_POOL + ' member ' + t.phAddr + ' nonce ' + t.phNonce;
  return 'reset-chat/v1\\n' + '{"addr":"' + t.phAddr + '","kind":"agent","nonce":"' + t.phNonce + '","text":"' + text + '","ts":' + t.phTs + ',"v":1}';
}
function copyText(txt, btn) {
  const done = () => {
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = T[lang].copiedOk;
    setTimeout(() => { btn.textContent = btn.dataset && btn.dataset.i18n ? (T[lang][btn.dataset.i18n] || old) : old; }, 1500);
  };
  const fallback = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta); done();
    } catch (e) {}
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done).catch(fallback);
  else fallback();
}
// Stages 2 and 4 are DISABLED presentation only: their buttons/textarea
// carry the disabled attribute and this script registers NO handler for
// them and contains no fetch at all — nothing can be filed or submitted
// from this page while the channel is closed.
function syncThemeBtn() { const dark = document.documentElement.dataset.theme === 'dark'; document.getElementById('themeBtn').textContent = dark ? T[lang].themeToLight : T[lang].themeToDark; }
function toggleTheme() { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; try { localStorage.setItem('pool-theme', next); } catch (e) {} syncThemeBtn(); }
function toggleLang() { lang = lang === 'zh' ? 'en' : 'zh'; localStorage.setItem('pool-lang', lang); applyLang(); }
function applyLang() {
  const t = T[lang];
  document.querySelectorAll('[data-i18n]').forEach(el => { const v = t[el.dataset.i18n]; if (v != null) el.innerHTML = v; });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t[el.dataset.i18nPh]; });
  document.getElementById('langBtn').textContent = t.langBtn;
  document.title = 'RESET Mining Pool — ' + t.title;
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.getElementById('snapshotTime').textContent = snapshotTimeText();
  document.getElementById('signTpl').value = buildSignTemplate();
  document.getElementById('caseNote').textContent = t.caseNote.replace('{h}', SNAPSHOT_COUNTED == null ? '—' : SNAPSHOT_COUNTED);
  if (lastExitQuery) exitShow();
  if (lastCaseQuery) exitCaseShow();
  syncThemeBtn();
}
document.getElementById('copySignBtn').addEventListener('click', ev => copyText(document.getElementById('signTpl').value, ev.currentTarget));
document.getElementById('exitAddr').addEventListener('keydown', e => { if (e.key === 'Enter') exitShow(); });
document.getElementById('exitCaseAddr').addEventListener('keydown', e => { if (e.key === 'Enter') exitCaseShow(); });
applyLang();
</script>
</body></html>`;
writeFileSync(`${ROOT}/docs/exit.html`, exitPage);
console.log(JSON.stringify({ ok: true, file: `${ROOT}/docs/exit.html` }));

// ---------------------------------------------------------------------------
// About page (docs/about.html): the full introduction — what this pool is,
// why it exists, how it works, how the money is split, the DETAILED exit
// walkthrough (the old exit.html body, moved here as one chapter at #exit),
// and how to verify everything. Every figure is computed at generation
// time from the ledger / published reports / the rehearsal loss log —
// nothing is hard-coded.
let lossFig = null;
try { const ll = JSON.parse(readFileSync(`${ROOT}/state/rehearsal-loss-log.json`, 'utf8'));
  const aff = (ll.entries ?? []).filter(e => e.affected);
  if (aff.length && ll.window) lossFig = { rounds: aff.length,
    total: aff.reduce((s, e) => s + BigInt(e.diff_units ?? '0'), 0n),
    from: ll.window.full_deposit_units, to: ll.window.reduced_deposit_units };
} catch {}
const lessonEn = lossFig ? `On 2026-10-22 the operator rehearsed this exit live, using the pool's own operating position. The executor halted on a message-wording mismatch right after the unlock had landed; nothing was re-sent blindly and no funds were lost. The rehearsal's real lesson is the wait's cost, which the steps above now state plainly: because unlocks move in whole 0.1 chunks, the pool's claiming deposit dropped from ${formatCoin(lossFig.from)} to ${formatCoin(lossFig.to)} for ${lossFig.rounds} rounds, and those rounds paid measurably less — a total shortfall of ${formatCoin(lossFig.total)}, recorded round by round in a public loss log and allocated per member. The case was cancelled, the full stake was restored on 2026-10-23 (withdrawn, then re-locked whole), and the recorded shortfall still sits in that log awaiting the operator's compensation decision — nothing has been booked or paid without it.` : '';
const lessonZh = lossFig ? `2026-10-22，运营者用池子自己的运营仓位真金实弹演练过一次这个流程。执行器在 unlock 落地之后因回执措辞对不上而停住；没有盲目重发任何一步，资金零损失。演练真正的教训是等待期的代价——上面步骤里如今都写明了：由于 unlock 只能整笔 0.1 地动，池子的 claim 质押在 ${lossFig.rounds} 轮里从 ${formatCoin(lossFig.from)} 降到 ${formatCoin(lossFig.to)}，这几轮的收益实打实地变少——差额合计 ${formatCoin(lossFig.total)}，已逐轮记入公开的损失日志并按成员份额分摊。案件随后作废，全额质押已于 2026-10-23 复原（取回后整笔复锁）；日志里记着的这笔差额还等运营者拍板补法——未经拍板，一分都没有动账。` : '';
let fairEx = null;
if (latestSettled && Array.isArray(latestSettled.shares) && latestSettled.shares.length) {
  const totDep = latestSettled.shares.reduce((s, x) => s + BigInt(x.deposit_units), 0n);
  const topShare = [...latestSettled.shares].sort((a, b) => (BigInt(b.deposit_units) > BigInt(a.deposit_units) ? 1 : -1))[0];
  if (topShare && totDep > 0n) fairEx = { round: latestSettled.round, amount: latestSettled.claim.amount_units,
    dep: topShare.deposit_units, tot: totDep.toString(), share: topShare.share_units,
    pct: (Number(topShare.deposit_units) / Number(totDep) * 100).toFixed(2) };
}
const fairExEn = fairEx ? `Round ${fairEx.round}, from this pool's own settlement report: the pool claimed ${formatCoin(fairEx.amount)} that round. The largest position's snapshot deposit was ${formatCoin(fairEx.dep)} of the pool's ${formatCoin(fairEx.tot)} (${fairEx.pct}%), and it was credited ${formatCoin(fairEx.share)} — the same fraction of the payout as of the stake.` : '';
const fairExZh = fairEx ? `拿池子自己的结算报告举例——第 ${fairEx.round} 轮：池子这一轮领到 ${formatCoin(fairEx.amount)}。其中最大一份份额的快照质押是 ${formatCoin(fairEx.dep)}，占池子快照总额 ${formatCoin(fairEx.tot)} 的 ${fairEx.pct}%，它分到了 ${formatCoin(fairEx.share)}——和它占质押的比例分毫不差。` : '';
const aboutPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RESET Mining Pool — About this pool</title>
<script>try{document.documentElement.dataset.theme=localStorage.getItem('pool-theme')||'light'}catch(e){document.documentElement.dataset.theme='light'}</script>
<style>
 :root, :root[data-theme="light"]{--bg:#ffffff;--fg:#1f2328;--muted:#59636e;--card:#f6f8fa;--border:#d1d9e0;--border2:#e3e8ee;--code:#eaeef2;--input:#ffffff;--accent:#1a7f37;--warn:#9e6a03;--hl:#fff3cd}
 :root[data-theme="dark"]{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--card:#161b22;--border:#30363d;--border2:#21262d;--code:#21262d;--input:#0d1117;--accent:#3fb950;--warn:#d29922;--hl:#3a2f04}
 body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:24px;max-width:860px;margin-inline:auto;line-height:1.55}
 h1{font-size:24px;margin:0 0 4px} h2{font-size:19px;margin:26px 0 8px;border-bottom:1px solid var(--border);padding-bottom:6px} h3{font-size:16px;margin:18px 0 6px}
 .muted{color:var(--muted)} .mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all}
 .card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px;margin:12px 0}
 .callout{border:1.5px solid var(--accent);background:color-mix(in srgb, var(--accent) 10%, var(--card));border-radius:10px;padding:14px 16px;font-size:16px;font-weight:600;margin:16px 0;color:var(--fg)}
 button{background:var(--code);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:5px 12px;cursor:pointer}
 a{color:var(--accent)} .topbar{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
 .topbtns{display:flex;gap:6px;flex-shrink:0}
 .warnbar{border:1.5px solid var(--warn);border-left:6px solid var(--warn);background:color-mix(in srgb, var(--warn) 14%, var(--card));border-radius:10px;padding:12px 14px;font-size:16px;line-height:1.5;margin:14px 0;color:var(--fg)}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:12px 0}
 .stat{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px}
 .stat b{display:block;font-size:20px} .stat span{color:var(--muted);font-size:13px}
 .toc{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 4px}
 .toc a{border:1px solid var(--border);background:var(--card);border-radius:999px;padding:4px 12px;text-decoration:none;font-size:14px;color:var(--fg)}
 li{margin:7px 0}
</style></head><body>
<div class="topbar"><div>
<h1 data-i18n="title">About this pool — the full introduction</h1>
<p class="muted"><a href="index.html" data-i18n="back">← Back to the pool page</a></p>
</div><div class="topbtns"><button id="themeBtn" onclick="toggleTheme()">🌙</button><button id="langBtn" onclick="toggleLang()">中文</button></div></div>

<nav class="toc">
 <a href="#what" data-i18n="whatTitle">What this is</a>
 <a href="#why" data-i18n="whyTitle">Why it exists</a>
 <a href="#how" data-i18n="howTitle">How it works</a>
 <a href="#split" data-i18n="splitTitle">How the money is split</a>
 <a href="#exit" data-i18n="exitTitle">Exiting, in detail</a>
 <a href="#verify" data-i18n="verifyTitle">How to verify</a>
</nav>

<section id="what">
<h2 data-i18n="whatTitle">What this is</h2>
<p data-i18n="whatP1">RESET's Mine contract only accepts a stake of 0.1 or more. This pool is for everyone below that line: small holders contribute to one shared pool address; the pool stakes the combined amount, claims every round, and splits what it earns pro-rata. It is open source — the code, the ledger and this website all live in one public repository.</p>
<div class="callout" data-i18n="whatP2">An experiment, not an investment. Nothing here promises returns: the pool earns exactly what the contract pays its combined deposit, and the operator takes no fee. Read the custody note under “How the money is split” before joining.</div>
<div class="grid">
 <div class="stat"><b>${formatCoin(total)}</b><span data-i18n="stTotal">Total contributed (RESET)</span></div>
 <div class="stat"><b>${activeContributors.length}</b><span data-i18n="stContrib">Contributors</span></div>
 <div class="stat"><b>${chainDeposit}</b><span data-i18n="stDeposit">Locked on-chain now (RESET)</span></div>
 <div class="stat"><b>${ledger.rounds.length}</b><span data-i18n="stRounds">Rounds settled</span></div>
 <div class="stat"><b>${formatCoin(totalEarnedUnits)}</b><span data-i18n="stEarned">Cumulative earnings (RESET)</span></div>
</div>
<p class="muted" data-i18n="statsNote">Figures as of the snapshot time in the footer. Cumulative earnings = the sum of every settled round's claim, from the published round reports.</p>
</section>

<section id="why">
<h2 data-i18n="whyTitle">Why it exists</h2>
<p data-i18n="whyP1">The gate is in the contract itself: min_amount = 0.1 is the smallest single lock or unlock, and the smallest deposit that may claim. Below 0.1, coins cannot mine at all — they just sit idle.</p>
<p data-i18n="whyP2">Pooling does not amplify anything. A round pays linearly: fair share = the round's guideline × your deposit ÷ the round's total claiming deposit. A solo stake of 0.3 and this pool's combined 0.3 earn exactly the same. What pooling changes is only who gets through the door.</p>
${fairEx ? `<div class="card"><b data-i18n="fairExT">A real round, from the pool's own books</b><br><span data-i18n="fairEx">${fairExEn}</span></div>` : ''}
</section>

<section id="how">
<h2 data-i18n="howTitle">How it works</h2>
<ol>
 <li data-i18n="how1"><b>Join.</b> Use the calculator on the Overview tab: your planned amount plus your address's fingerprint tail gives your exact transfer amount, and the calculation is recorded in the pool's registry. Transfer exactly that amount; the pool checks the registry record first, then matches the amount's tail to your address, and credits the full amount — usually within about a minute. A wrong or rounded amount parks as unclaimed until it is claimed through the path described on the Overview tab.</li>
 <li data-i18n="how2"><b>Stake.</b> Whenever the pool's idle balance reaches 0.1, the worker locks the whole amount in a single lock — the contract's per-operation minimum makes partial locks below 0.1 impossible, so nothing is ever locked piecemeal.</li>
 <li data-i18n="how3"><b>Claim.</b> Every round, the pool files one claim at level 1000 — exactly its fair share, never more. Over-claiming would draw strikes and penalties; the pool never does it.</li>
 <li data-i18n="how4"><b>Settle.</b> When a round settles, the proceeds are split by that round's deposit snapshot and credited as pending earnings on the public ledger. Pending earnings pay out automatically once they reach 0.01.</li>
</ol>
</section>

<section id="split">
<h2 data-i18n="splitTitle">How the money is split</h2>
<ul>
 <li data-i18n="split1"><b>Pro-rata, always:</b> your credit for a round = the round's proceeds × your snapshot deposit ÷ the pool's snapshot total for that round. The snapshot is taken per round, so mid-round joins or exits never rewrite a settled round.</li>
 <li data-i18n="split2"><b>Fee: zero.</b> The ledger's fee setting is 0‰ — the operator takes nothing from contributions or proceeds.</li>
 <li data-i18n="split3"><b>Dust carries forward.</b> Integer division leaves a few units undistributed each round; they are not kept by anyone — they roll into the next round's distributable amount. The carry right now is ${formatCoin(ledger.carry_units ?? '0')}.</li>
 <li data-i18n="split4"><b>Payouts:</b> pending earnings are transferred automatically once they reach the 0.01 threshold. The fixed 0.03 TNK transfer fee is paid by the pool — never deducted from a member's amount.</li>
</ul>
<div class="warnbar" data-i18n="custody"><b>Accounting is provable; custody is trusted.</b> RESET has no multisig or pool primitive, so one operator key controls the pool address. Every contribution, claim and payout is published and hash-chained, so misuse would be visible and attributable — but it cannot be made technically impossible. That is the honest model; join only if you accept it.</div>
</section>

<section id="exit">
<h2 data-i18n="exitTitle">Exiting, in detail</h2>
<div class="warnbar" data-i18n="exitClosedNote">⏸ <b>Exit channel temporarily closed.</b> The pool is still small; the channel reopens once the pool has grown and the exit executor has passed a full end-to-end live test. The registry accepts no new exit intents meanwhile. This chapter stays published so the process is fully documented before it reopens.</div>
<h3 data-i18n="prinTitle">The principles</h3>
<ul>
 <li data-i18n="prin1"><b>A right, not an approval.</b> If the ledger shows a position under your address, you may exit it — nobody approves or denies the request. Only an accounting anomaly (the books do not reconcile, or the amount exceeds your recorded position) stops a case for the operator to review.</li>
 <li data-i18n="prin2"><b>Full exits only.</b> Your principal plus your settled pending earnings, paid in a single payment. There are no partial exits.</li>
 <li data-i18n="prin3"><b>The payout can only go home.</b> Proceeds are paid only to the address that contributed — the one the ledger records for your position. No field in any request or form can name a different recipient, so a forged request can never redirect your money.</li>
 <li data-i18n="prin4"><b>The pool pays the transfer fee.</b> The fixed 0.03 TNK fee on the payout transfer is the pool's cost. You receive the full amount; nothing is deducted.</li>
 <li data-i18n="prin5"><b>The dissolution edge case.</b> If paying one exit would leave the pool's total deposit strictly below 0.1 RESET, that exit escalates to a full dissolution instead: the entire deposit is unlocked and every member is settled in full. Landing exactly on 0.1 does not dissolve the pool.</li>
</ul>
<h3 data-i18n="xstepsTitle">The process, step by step</h3>
<ol>
 <li data-i18n="xstep1"><b>Check your position.</b> On the Overview tab (exit section) or the Ledger tab, enter your address to see your principal and pending earnings. That is the position an exit would settle.</li>
 <li data-i18n="xstep2"><b>File an exit intent.</b> The pool's registry issues a one-time statement with a single-use nonce (valid 30 minutes). Anyone can file the intent for you — including your own AI — because the intent alone proves nothing.</li>
 <li data-i18n="xstep3"><b>Sign the statement.</b> You sign the exact issued text with your own signer, in the official signed-message format. Signing is free and works at zero balance — your coins sit in the pool, so your wallet may be empty, and no proof transfer is ever asked for. Only your key can produce this signature.</li>
 <li data-i18n="xstep4"><b>Submit the signature.</b> The signed submission is filed with the registry; the nonce is burned by the first submission, so replays fail. The pool verifies the Ed25519 signature locally, and a case opens. A valid signature from an address with no position opens nothing.</li>
 <li data-i18n="xstep5"><b>Your amount is frozen.</b> At the moment the case opens, your payout is fixed from the ledger snapshot: principal + pending earnings at that moment. Rounds that settle later are not added to it; any earnings that land afterwards stay as pending under the normal payout rules.</li>
 <li data-i18n="xstep6"><b>The pool unlocks.</b> The contract only moves stake in single unlocks of at least 0.1, so even a small exit unlocks a full 0.1 (a dissolution unlocks everything). The part above your amount is not paid to anyone — after the wait it comes back to the pool and is re-locked.</li>
 <li data-i18n="xstep7"><b>Wait 144 Bitcoin blocks — about 24 hours.</b> This wait is the contract's, and it has a real cost, stated plainly: while unlocked, that part of the stake earns nothing, so the whole pool's earnings for those rounds are lower, shared pro-rata by everyone — including you. Your frozen amount itself does not change.</li>
 <li data-i18n="xstep8"><b>The pool withdraws.</b> Once the wait matures, the pool withdraws the unlocked amount back to its balance. One contract gate applies: a withdrawal is refused while one of the pool's round claims is still unsettled, so the withdrawal fires at the first executable window after maturity — normally right on time, occasionally a little later. The money never expires inside the exit entry.</li>
 <li data-i18n="xstep9"><b>You are paid in full.</b> The frozen amount is transferred to your original address — the only address it can go to. The 0.03 TNK transfer fee is paid by the pool. If a transfer ever failed on fees, the case would park safely with your RESET intact in the pool balance; the fee is never taken out of your amount.</li>
 <li data-i18n="xstep10"><b>The position is closed on the public ledger.</b> The close-out is recorded as hash-chained ledger events (verified → unlocked → paid), and the settled exit appears on the Ledger tab and on your address page, where anyone can recompute it.</li>
</ol>
<h3 data-i18n="timeTitle">How long it takes</h3>
<ul>
 <li data-i18n="time1"><b>Case opening:</b> immediate — as soon as your signature verifies.</li>
 <li data-i18n="time2"><b>Unlock:</b> immediate — in the same pass that opens the case.</li>
 <li data-i18n="time3"><b>The wait:</b> about 24 hours (144 Bitcoin blocks — block times vary, so treat this as approximate).</li>
 <li data-i18n="time4"><b>Payout:</b> at the first executable window after the wait matures — withdraw, then the transfer to your address.</li>
</ul>
${lossFig ? `<h3 data-i18n="lessonTitle">What the live rehearsal taught us (2026-10-22)</h3>
<p data-i18n="lesson">${lessonEn}</p>` : ''}
</section>

<section id="verify">
<h2 data-i18n="verifyTitle">How to verify</h2>
<ul>
 <li data-i18n="ver1"><b>Hash-chained ledger.</b> Every event — contribution, round settlement, payout, exit — is appended to a hash chain, so editing history would break the chain visibly. The Ledger tab renders it; the raw file (state/live-ledger.json) sits in the repository.</li>
 <li data-i18n="ver2"><b>Per-round reports.</b> Each settled round publishes a report carrying its own hash (Reports tab), recording the snapshot and every member's share — any round's split can be recomputed from it.</li>
 <li data-i18n="ver3"><b>Recompute it yourself.</b> The repository's verify tool replays the ledger and checks conservation: total obligations against the pool's on-chain balance and deposit. The pool worker runs the same check on every pass and stops rather than proceed on a mismatch.</li>
 <li data-i18n="ver4"><b>Fresh, checkable data.</b> This site is regenerated about every 10 minutes from the public RESET gateway; every page carries its snapshot time, and the gateway exposes the same account and round state for cross-checking.</li>
</ul>
</section>

<p class="muted"><span data-i18n="footerGen">Snapshot time</span> <span id="snapshotTime">${updated}</span>. <span data-i18n="footerNote">It is a static snapshot — no live polling, no login, no tracking.</span></p>
<p class="muted"><span data-i18n="dataSource">Data source</span>: <a href="https://github.com/chilperbf24/reset-mining-pool" target="_blank" rel="noopener">https://github.com/chilperbf24/reset-mining-pool</a></p>

<script>
const SNAPSHOT_MS = ${Date.now()};
const T = {
en: { title: "About this pool — the full introduction", langBtn: "中文", back: "← Back to the pool page",
 themeToDark: "🌙 Night", themeToLight: "☀️ Day",
 whatTitle: "What this is", whyTitle: "Why it exists", howTitle: "How it works",
 splitTitle: "How the money is split", exitTitle: "Exiting, in detail", verifyTitle: "How to verify",
 whatP1: "RESET's Mine contract only accepts a stake of 0.1 or more. This pool is for everyone below that line: small holders contribute to one shared pool address; the pool stakes the combined amount, claims every round, and splits what it earns pro-rata. It is open source — the code, the ledger and this website all live in one public repository.",
 whatP2: "An experiment, not an investment. Nothing here promises returns: the pool earns exactly what the contract pays its combined deposit, and the operator takes no fee. Read the custody note under “How the money is split” before joining.",
 stTotal: "Total contributed (RESET)", stContrib: "Contributors", stDeposit: "Locked on-chain now (RESET)", stRounds: "Rounds settled", stEarned: "Cumulative earnings (RESET)",
 statsNote: "Figures as of the snapshot time in the footer. Cumulative earnings = the sum of every settled round's claim, from the published round reports.",
 whyP1: "The gate is in the contract itself: min_amount = 0.1 is the smallest single lock or unlock, and the smallest deposit that may claim. Below 0.1, coins cannot mine at all — they just sit idle.",
 whyP2: "Pooling does not amplify anything. A round pays linearly: fair share = the round's guideline × your deposit ÷ the round's total claiming deposit. A solo stake of 0.3 and this pool's combined 0.3 earn exactly the same. What pooling changes is only who gets through the door.",
 fairExT: "A real round, from the pool's own books", fairEx: "${fairExEn}",
 how1: "<b>Join.</b> Use the calculator on the Overview tab: your planned amount plus your address's fingerprint tail gives your exact transfer amount, and the calculation is recorded in the pool's registry. Transfer exactly that amount; the pool checks the registry record first, then matches the amount's tail to your address, and credits the full amount — usually within about a minute. A wrong or rounded amount parks as unclaimed until it is claimed through the path described on the Overview tab.",
 how2: "<b>Stake.</b> Whenever the pool's idle balance reaches 0.1, the worker locks the whole amount in a single lock — the contract's per-operation minimum makes partial locks below 0.1 impossible, so nothing is ever locked piecemeal.",
 how3: "<b>Claim.</b> Every round, the pool files one claim at level 1000 — exactly its fair share, never more. Over-claiming would draw strikes and penalties; the pool never does it.",
 how4: "<b>Settle.</b> When a round settles, the proceeds are split by that round's deposit snapshot and credited as pending earnings on the public ledger. Pending earnings pay out automatically once they reach 0.01.",
 split1: "<b>Pro-rata, always:</b> your credit for a round = the round's proceeds × your snapshot deposit ÷ the pool's snapshot total for that round. The snapshot is taken per round, so mid-round joins or exits never rewrite a settled round.",
 split2: "<b>Fee: zero.</b> The ledger's fee setting is 0‰ — the operator takes nothing from contributions or proceeds.",
 split3: "<b>Dust carries forward.</b> Integer division leaves a few units undistributed each round; they are not kept by anyone — they roll into the next round's distributable amount. The carry right now is ${formatCoin(ledger.carry_units ?? '0')}.",
 split4: "<b>Payouts:</b> pending earnings are transferred automatically once they reach the 0.01 threshold. The fixed 0.03 TNK transfer fee is paid by the pool — never deducted from a member's amount.",
 custody: "<b>Accounting is provable; custody is trusted.</b> RESET has no multisig or pool primitive, so one operator key controls the pool address. Every contribution, claim and payout is published and hash-chained, so misuse would be visible and attributable — but it cannot be made technically impossible. That is the honest model; join only if you accept it.",
 exitClosedNote: "⏸ <b>Exit channel temporarily closed.</b> The pool is still small; the channel reopens once the pool has grown and the exit executor has passed a full end-to-end live test. The registry accepts no new exit intents meanwhile. This chapter stays published so the process is fully documented before it reopens.",
 prinTitle: "The principles",
 prin1: "<b>A right, not an approval.</b> If the ledger shows a position under your address, you may exit it — nobody approves or denies the request. Only an accounting anomaly (the books do not reconcile, or the amount exceeds your recorded position) stops a case for the operator to review.",
 prin2: "<b>Full exits only.</b> Your principal plus your settled pending earnings, paid in a single payment. There are no partial exits.",
 prin3: "<b>The payout can only go home.</b> Proceeds are paid only to the address that contributed — the one the ledger records for your position. No field in any request or form can name a different recipient, so a forged request can never redirect your money.",
 prin4: "<b>The pool pays the transfer fee.</b> The fixed 0.03 TNK fee on the payout transfer is the pool's cost. You receive the full amount; nothing is deducted.",
 prin5: "<b>The dissolution edge case.</b> If paying one exit would leave the pool's total deposit strictly below 0.1 RESET, that exit escalates to a full dissolution instead: the entire deposit is unlocked and every member is settled in full. Landing exactly on 0.1 does not dissolve the pool.",
 xstepsTitle: "The process, step by step",
 xstep1: "<b>Check your position.</b> On the Overview tab (exit section) or the Ledger tab, enter your address to see your principal and pending earnings. That is the position an exit would settle.",
 xstep2: "<b>File an exit intent.</b> The pool's registry issues a one-time statement with a single-use nonce (valid 30 minutes). Anyone can file the intent for you — including your own AI — because the intent alone proves nothing.",
 xstep3: "<b>Sign the statement.</b> You sign the exact issued text with your own signer, in the official signed-message format. Signing is free and works at zero balance — your coins sit in the pool, so your wallet may be empty, and no proof transfer is ever asked for. Only your key can produce this signature.",
 xstep4: "<b>Submit the signature.</b> The signed submission is filed with the registry; the nonce is burned by the first submission, so replays fail. The pool verifies the Ed25519 signature locally, and a case opens. A valid signature from an address with no position opens nothing.",
 xstep5: "<b>Your amount is frozen.</b> At the moment the case opens, your payout is fixed from the ledger snapshot: principal + pending earnings at that moment. Rounds that settle later are not added to it; any earnings that land afterwards stay as pending under the normal payout rules.",
 xstep6: "<b>The pool unlocks.</b> The contract only moves stake in single unlocks of at least 0.1, so even a small exit unlocks a full 0.1 (a dissolution unlocks everything). The part above your amount is not paid to anyone — after the wait it comes back to the pool and is re-locked.",
 xstep7: "<b>Wait 144 Bitcoin blocks — about 24 hours.</b> This wait is the contract's, and it has a real cost, stated plainly: while unlocked, that part of the stake earns nothing, so the whole pool's earnings for those rounds are lower, shared pro-rata by everyone — including you. Your frozen amount itself does not change.",
 xstep8: "<b>The pool withdraws.</b> Once the wait matures, the pool withdraws the unlocked amount back to its balance. One contract gate applies: a withdrawal is refused while one of the pool's round claims is still unsettled, so the withdrawal fires at the first executable window after maturity — normally right on time, occasionally a little later. The money never expires inside the exit entry.",
 xstep9: "<b>You are paid in full.</b> The frozen amount is transferred to your original address — the only address it can go to. The 0.03 TNK transfer fee is paid by the pool. If a transfer ever failed on fees, the case would park safely with your RESET intact in the pool balance; the fee is never taken out of your amount.",
 xstep10: "<b>The position is closed on the public ledger.</b> The close-out is recorded as hash-chained ledger events (verified → unlocked → paid), and the settled exit appears on the Ledger tab and on your address page, where anyone can recompute it.",
 timeTitle: "How long it takes",
 time1: "<b>Case opening:</b> immediate — as soon as your signature verifies.",
 time2: "<b>Unlock:</b> immediate — in the same pass that opens the case.",
 time3: "<b>The wait:</b> about 24 hours (144 Bitcoin blocks — block times vary, so treat this as approximate).",
 time4: "<b>Payout:</b> at the first executable window after the wait matures — withdraw, then the transfer to your address.",
 lessonTitle: "What the live rehearsal taught us (2026-10-22)", lesson: "${lessonEn}",
 ver1: "<b>Hash-chained ledger.</b> Every event — contribution, round settlement, payout, exit — is appended to a hash chain, so editing history would break the chain visibly. The Ledger tab renders it; the raw file (state/live-ledger.json) sits in the repository.",
 ver2: "<b>Per-round reports.</b> Each settled round publishes a report carrying its own hash (Reports tab), recording the snapshot and every member's share — any round's split can be recomputed from it.",
 ver3: "<b>Recompute it yourself.</b> The repository's verify tool replays the ledger and checks conservation: total obligations against the pool's on-chain balance and deposit. The pool worker runs the same check on every pass and stops rather than proceed on a mismatch.",
 ver4: "<b>Fresh, checkable data.</b> This site is regenerated about every 10 minutes from the public RESET gateway; every page carries its snapshot time, and the gateway exposes the same account and round state for cross-checking.",
 footerGen: "Snapshot time", dataSource: "Data source",
 footerNote: "It is a static snapshot — no live polling, no login, no tracking." },
zh: { title: "关于这个池子——完整介绍", langBtn: "English", back: "← 返回拼池主页",
 themeToDark: "🌙 夜晚", themeToLight: "☀️ 白天",
 whatTitle: "这是什么", whyTitle: "为什么有它", howTitle: "怎么运作",
 splitTitle: "钱怎么分", exitTitle: "退出全流程（详细版）", verifyTitle: "怎么验证",
 whatP1: "RESET 的 Mine 合约只接受 0.1 以上的质押。这个池子就是为门槛以下的人开的：小额持有者把币汇集到一个池子地址，池子统一质押、逐轮 claim、按份额比例分账。全套开源——代码、账本和这个网站都在同一个公开仓库里。",
 whatP2: "这是实验，不是投资产品。这里不承诺任何收益：池子赚到的就是合约按合并质押付的数，运营者不抽任何费用。入池前请先读完「钱怎么分」里的托管说明。",
 stTotal: "累计出资（RESET）", stContrib: "出资人数", stDeposit: "当前链上质押（RESET）", stRounds: "已结算轮次", stEarned: "累计总收益（RESET）",
 statsNote: "数字截至页脚的快照时间。累计总收益 = 全部已结算轮次 claim 之和，取自已发布的逐轮报告。",
 whyP1: "门槛写在合约里：min_amount = 0.1，既是单笔 lock/unlock 的最小金额，也是能 claim 的最小质押。不到 0.1，币根本挖不了——只能闲置。",
 whyP2: "拼池不放大任何东西。每轮按线性公式付：公平份额 = 本轮指南额 × 你的质押 ÷ 本轮参与 claim 的总质押。一个人单挖 0.3 和这个池子合并的 0.3，赚的一模一样。拼池改变的只是谁能进这道门。",
 fairExT: "真实一轮，取自池子自己的账", fairEx: "${fairExZh}",
 how1: "<b>入池。</b>用概览页的计算器：计划金额加上你地址的指纹尾数，就是你的精确转账金额，计算结果会记入池子的登记后台。从你的钱包精确转这个数；池子先查登记记录、再按金额尾数对上你的地址，全额计入你的出资——通常一分钟左右到账。金额转错或凑整的，会先落为待认领，按概览页的说明走认领路径。",
 how2: "<b>汇集质押。</b>池子闲置余额每攒够 0.1，worker 就整笔一锁——合约单笔最低 0.1 的限制决定了零碎金额锁不了，所以永远不拆开锁。",
 how3: "<b>逐轮 claim。</b>每一轮，池子只提交一笔 level 1000 的 claim——正好是它的公平份额，绝不多报。多报会招致 strikes 和罚没，池子从不这么干。",
 how4: "<b>结算记账。</b>每轮结算落地，收益按该轮的质押快照比例拆分，记为各成员的待分收益，写在公开账本上。待分攒够 0.01 自动打出。",
 split1: "<b>永远按比例：</b>你这一轮的入账 = 本轮收益 × 你的快照质押 ÷ 池子该轮快照总额。快照逐轮取，轮中入池或退出不会改写已结算的轮次。",
 split2: "<b>手续费：零。</b>账本的费率设置为 0‰——运营者不从出资和收益里抽一分。",
 split3: "<b>灰尘结转。</b>整数除法每轮会剩几个 units 分不出去；谁也不许拿——结转进下一轮的可分配额。当前结转额是 ${formatCoin(ledger.carry_units ?? '0')}。",
 split4: "<b>分发：</b>待分收益攒够 0.01 门槛自动转账打出。固定的 0.03 TNK 转账费由池子承担——永不从成员的金额里扣。",
 custody: "<b>分账可证明，托管靠信任。</b>RESET 合约没有多签、没有池子原语，池子地址由运营者一把私钥控制。每一笔出资、claim 和分发都公开且哈希链记账，所以作恶一定会被看见、能追责——但技术上无法做到不可能。模型就是这么诚实；接受不了这一点，就不要入池。",
 exitClosedNote: "⏸ <b>退出通道暂时关闭。</b>池子规模尚小；待金额规模上来、且退出执行器完成整机端到端实测后，通道再开放。在此之前登记后台不接受新的退出意向。本章保留发布，是为了让流程在重开之前就完整有据可查。",
 prinTitle: "先说原则",
 prin1: "<b>是权利，不是审批。</b>只要账本上有你地址名下的份额，你就可以退出——没有人能批准或驳回。唯一会让案件停下来交运营者复核的，是账目异常（账对不平、或金额超过账本记录的份额）。",
 prin2: "<b>只退全额。</b>本金加已结算的待分收益，一次性付清。没有部分退出。",
 prin3: "<b>款只能打回家。</b>退出款只打回当初入池的那个地址——账本上记着的你的地址。任何申请、表单、字段都改不了收款地址，所以冒名申请也偷不走你的钱。",
 prin4: "<b>转账费池子出。</b>打款那笔固定的 0.03 TNK 手续费由池子承担，你收到的是全额，一分不扣。",
 prin5: "<b>解散的边角情形。</b>若某一笔退出付完后，池子总质押会严格跌破 0.1 RESET，这笔退出就升级为全池解散：全部质押解锁，所有成员一并全额结清。恰好落在 0.1 不触发解散。",
 xstepsTitle: "完整流程，一步一步",
 xstep1: "<b>查你的份额。</b>在概览页退出区或账本页输入你的地址，看到你的本金和待分收益——退出要结清的就是这份份额。",
 xstep2: "<b>登记退出意向。</b>池子的登记后台签发一份一次性声明，带单次有效的口令（nonce，30 分钟内有效）。意向可以由任何人代为登记——包括你自己的 AI——因为光有意向什么都证明不了。",
 xstep3: "<b>签名。</b>你用自己的签名器对签发的原文签名，走官方签名消息格式。签名零成本、零余额可办——你的币在池子里，钱包是空的也没关系，全程不会让你转任何币来证明身份。只有你的私钥能签出这个签名。",
 xstep4: "<b>提交签名。</b>签好的提交件交回登记后台；口令在第一次提交时即被烧毁，重放无效。池子在本地验证 Ed25519 签名，通过即建案。签名有效但名下没有份额的，不会建任何案。",
 xstep5: "<b>应退额冻结。</b>建案那一刻，你的应退金额按账本快照定死：那一刻的本金＋待分收益。之后再结算的轮次不计入这笔；之后落到你名下的收益仍按正常规则留作待分。",
 xstep6: "<b>池子执行 unlock。</b>合约挪动质押的粒度是单笔至少 0.1，所以哪怕退的份额很小，也要整笔解出 0.1（解散时则全部解出）。多出你应退额的那部分不会付给任何人——等待期满后回到池子、重新锁仓。",
 xstep7: "<b>等 144 个比特币块——约 24 小时。</b>这是合约的等待期，代价如实说：等待期内被解出的那部分质押不产生收益，这几轮全池收益会相应变低，由所有人按份额共同承担——也包括你。你冻结的应退额本身不变。",
 xstep8: "<b>池子 withdraw 取回。</b>等待期满后，池子把解出的金额取回余额。这里有一道合约门控：池子若有某一轮的 claim 还没结算完，withdraw 会被拒绝，所以取回动作落在到期后第一个可执行的窗口——通常正好到期就办，偶尔会顺延一阵。钱在退出条目里不会过期作废。",
 xstep9: "<b>全额打款到账。</b>冻结的应退额转账打回你的原地址——也只能是这个地址。0.03 TNK 手续费由池子付。万一某次转账因手续费失败，案件会安全停泊、你的 RESET 完好留在池子余额里；手续费永远不会从你的金额里扣。",
 xstep10: "<b>账本关账，公开可查。</b>结清全过程记为哈希链账本事件（验签→解锁→已付），结清记录出现在账本页和你的地址页上，任何人都能复算核对。",
 timeTitle: "时间线总览",
 time1: "<b>建案：</b>即时——验签一通过就建。",
 time2: "<b>unlock：</b>即时——与建案同一趟执行。",
 time3: "<b>等待：</b>约 24 小时（144 个比特币块——出块时长有浮动，按约数看）。",
 time4: "<b>打款：</b>等待期满后的第一个可执行窗口——先 withdraw，再转账到你的地址。",
 lessonTitle: "真金演练留下的教训（2026-10-22）", lesson: "${lessonZh}",
 ver1: "<b>哈希链账本。</b>每一个事件——出资、逐轮结算、分发、退出——都追加进一条哈希链，改历史就会断链、当场露馅。账本页渲染的就是它；原始文件（state/live-ledger.json）就在仓库里。",
 ver2: "<b>逐轮报告。</b>每个已结算轮次都发布一份带自身哈希的报告（报告页），记着该轮的快照和每个成员的份额——任何一轮的分账都能照着复算。",
 ver3: "<b>自己复算。</b>仓库里的验证工具会重放整个账本并核对守恒：全部应付义务对池子的链上余额加质押。池子 worker 每一趟都跑同样的自检，对不上就停，绝不带病往下走。",
 ver4: "<b>数据新鲜可查。</b>本站约每 10 分钟从公开的 RESET 网关重新生成一次；每页都带快照时间，网关本身也开放同样的账户与轮次状态供交叉核对。",
 footerGen: "快照时间", dataSource: "数据来源于",
 footerNote: "这是静态快照——不实时轮询、不登录、不追踪。" }
};
let lang = localStorage.getItem('pool-lang') || 'en'; // first visit always opens in English
function snapshotTimeText() { const d = new Date(SNAPSHOT_MS); const p = n => String(n).padStart(2, '0');
  if (lang === 'zh') { const b = new Date(d.getTime() + 8 * 3600000);
    return b.getUTCFullYear() + '-' + p(b.getUTCMonth() + 1) + '-' + p(b.getUTCDate()) + ' ' + p(b.getUTCHours()) + ':' + p(b.getUTCMinutes()) + ':' + p(b.getUTCSeconds()) + ' GMT+8'; }
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) + ' UTC'; }
function syncThemeBtn() { const dark = document.documentElement.dataset.theme === 'dark'; document.getElementById('themeBtn').textContent = dark ? T[lang].themeToLight : T[lang].themeToDark; }
function toggleTheme() { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; try { localStorage.setItem('pool-theme', next); } catch (e) {} syncThemeBtn(); }
function toggleLang() { lang = lang === 'zh' ? 'en' : 'zh'; localStorage.setItem('pool-lang', lang); applyLang(); }
function applyLang() {
  const t = T[lang];
  document.querySelectorAll('[data-i18n]').forEach(el => { const v = t[el.dataset.i18n]; if (v != null) el.innerHTML = v; });
  document.getElementById('langBtn').textContent = t.langBtn;
  document.title = 'RESET Mining Pool — ' + t.title;
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.getElementById('snapshotTime').textContent = snapshotTimeText();
  syncThemeBtn();
}
applyLang();
</script>
</body></html>`;
writeFileSync(`${ROOT}/docs/about.html`, aboutPage);
console.log(JSON.stringify({ ok: true, file: `${ROOT}/docs/about.html` }));

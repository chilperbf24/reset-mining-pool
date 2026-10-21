#!/usr/bin/env node
// Pool ledger CLI — the operator's bookkeeping surface.
//   node ledger.mjs init <pool-address>
//   node ledger.mjs contribute <contributor-address> <amount-coin> [tx-ref]
//   node ledger.mjs settle <round> <claim-amount-coin>
//   node ledger.mjs payouts            (list payouts that reached the threshold)
//   node ledger.mjs status
// Contributions must only be recorded after the incoming transfer to the pool
// address is visible on-chain; the tx-ref is stored in the event chain so any
// auditor can match ledger entries to chain transfers 1:1.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { emptyState, addContribution, settleRound, planPayouts, totalContributed,
  checkEventChain, checkConservation, parseCoin, formatCoin, poolCanClaim, snapshot } from './lib/pool.mjs';

const FILE = process.env.POOL_LEDGER || `${process.env.HOME}/workspace/reset-pool/state/live-ledger.json`;
const REPORTS = `${process.env.HOME}/workspace/reset-pool/reports`;
const load = () => JSON.parse(readFileSync(FILE, 'utf8'));
const save = s => writeFileSync(FILE, JSON.stringify(s, null, 2));
const [cmd, a1, a2, a3] = process.argv.slice(2);

if (cmd === 'init') {
  if (existsSync(FILE)) { console.log(JSON.stringify({ ok: false, error: 'ledger already exists, refusing to overwrite' })); process.exit(1); }
  const s = emptyState(a1);
  save(s);
  console.log(JSON.stringify({ ok: true, pool_address: s.pool_address, ledger: FILE }));
} else if (cmd === 'contribute') {
  const s = load();
  addContribution(s, a1, parseCoin(a2), a3 ? { tx_ref: a3 } : {});
  save(s);
  const total = totalContributed(s);
  console.log(JSON.stringify({ ok: true, contributor: a1, amount: a2, pool_total: formatCoin(total), can_claim: total >= 10_000_000n }));
} else if (cmd === 'settle') {
  const s = load();
  const report = settleRound(s, { round: parseInt(a1, 10), claimAmountUnits: parseCoin(a2) });
  save(s);
  const path = `${REPORTS}/live-round-${a1}.json`;
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, round: report.round, report: path, report_hash: report.report_hash,
    shares: report.shares.map(x => ({ address: x.address, share: formatCoin(x.share_units) })) }));
} else if (cmd === 'payouts') {
  const s = load();
  console.log(JSON.stringify({ ok: true, due: planPayouts(s).map(p => ({ address: p.address, amount: formatCoin(p.amount_units) })) }));
} else if (cmd === 'status') {
  const s = load();
  const snap = snapshot(s, -1);
  const cons = checkConservation(s);
  console.log(JSON.stringify({ ok: true, pool_address: s.pool_address,
    total_contributed: formatCoin(totalContributed(s)), can_claim: poolCanClaim(snap),
    contributors: Object.entries(s.contributors).map(([address, c]) => ({ address,
      contributed: formatCoin(c.contributed), pending: formatCoin(c.pending), paid_total: formatCoin(c.paid_total) })),
    rounds_settled: s.rounds.length, payouts_executed: s.payouts.length,
    event_chain: checkEventChain(s), conservation_ok: cons.ok }, null, 2));
} else {
  console.error('usage: init|contribute|settle|payouts|status');
  process.exit(2);
}

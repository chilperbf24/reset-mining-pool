#!/usr/bin/env node
// End-to-end simulation of the pool, using the REAL contract payout code
// (~/workspace/reset/contract/rules/games.js minePayout) to compute what the
// pool address would receive each round. No real coins move.
//
// Scenario (stated openly; these are simulation parameters, not chain data):
// - 3 contributors fund the pool with 0.03 / 0.04 / 0.05 = 0.12 total.
//   Each one alone is below the 0.1 minimum and could never claim solo.
// - Other miners claim alongside with a combined deposit of 90.0.
// - Mine stock 300.0, capacity 445.5 (the contract defaults).
// - 24 rounds are settled, payouts are released at the 0.01 threshold.
import { writeFileSync, mkdirSync } from 'node:fs';
import { minePayout, MINE_DEFAULTS } from '../reset/contract/rules/games.js';
import { emptyState, addContribution, settleRound, planPayouts, applyPayouts,
  checkEventChain, checkConservation, formatCoin } from './lib/pool.mjs';

const POOL = '4150cf82f0189371818a22d5f5b10d52aadf9108c78020cc97fc002df6eaaca6';
const A = 'aa'.repeat(32), B = 'bb'.repeat(32), C = 'cc'.repeat(32);
const OTHER = 'dd'.repeat(32);
const ROUNDS = 24;
const STOCK = 30_000_000_000n;                       // 300.0
const CAPACITY = BigInt(MINE_DEFAULTS.mine_capacity); // 445.5
const OTHER_DEPOSIT = 9_000_000_000n;                 // 90.0

mkdirSync('reports', { recursive: true });
const state = emptyState(POOL);
addContribution(state, A, 3_000_000n, { tx_ref: 'sim-tx-a' });   // 0.03
addContribution(state, B, 4_000_000n, { tx_ref: 'sim-tx-b' });   // 0.04
addContribution(state, C, 5_000_000n, { tx_ref: 'sim-tx-c' });   // 0.05

const poolDeposit = 12_000_000n; // 0.12
let firstAmount = null, lastAmount = null;
for (let r = 1; r <= ROUNDS; r++) {
  // What would the chain pay the pool this round? Ask the contract code.
  const { results } = minePayout([
    { address: POOL, d: poolDeposit.toString(), q: 1000, collateral: poolDeposit.toString(), strikes: 0, clean: 0 },
    { address: OTHER, d: OTHER_DEPOSIT.toString(), q: 1000, collateral: OTHER_DEPOSIT.toString(), strikes: 0, clean: 0 },
  ], STOCK, CAPACITY, { ...MINE_DEFAULTS });
  const mine = results.find(x => x.address === POOL);
  firstAmount ??= mine.amount;
  lastAmount = mine.amount;
  const report = settleRound(state, { round: r, claimAmountUnits: BigInt(mine.amount), claimFairUnits: BigInt(mine.fair) });
  writeFileSync(`reports/round-${r}.json`, JSON.stringify(report, null, 2));
}

const due = planPayouts(state);
const paid = applyPayouts(state, due, addr => `sim-payout-${addr.slice(0, 2)}`);
writeFileSync('state/demo-ledger.json', JSON.stringify(state, null, 2));
const cons = checkConservation(state);
const chain = checkEventChain(state);
const summary = {
  scenario: { contributors: { [A]: '0.03', [B]: '0.04', [C]: '0.05' }, pool_total: '0.12',
    other_miners_deposit: '90.0', stock: '300.0', rounds: ROUNDS, payout_threshold: '0.01', fee: '0' },
  pool_claim_per_round: formatCoin(BigInt(firstAmount)),
  rounds_settled: state.rounds.length,
  total_claimed: formatCoin(cons.claimed),
  payouts: paid.map(p => ({ address: p.address, amount: formatCoin(p.amount_units), ref: p.ref })),
  pending_after_payouts: Object.fromEntries(Object.entries(state.contributors).map(([a, c]) => [a, formatCoin(c.pending)])),
  dust_carried: formatCoin(cons.carry),
  conservation_ok: cons.ok, event_chain_ok: chain.ok, event_head: chain.head,
};
writeFileSync('reports/summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (!cons.ok || !chain.ok) { console.error('SIMULATION FAILED ITS OWN CHECKS'); process.exit(1); }

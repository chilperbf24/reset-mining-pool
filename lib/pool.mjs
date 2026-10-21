// RESET mining pool — core accounting.
//
// Design notes (honest boundaries):
// - The RESET contract has no pool primitive. The pool is ONE ordinary address
//   whose deposit must be >= min_amount (0.1 coin) to lock and to claim.
// - Fair share in the Mine is linear in deposit:
//     fair = guideline * deposit_i / sum(deposits of all claimers that round)
//   so pooling changes access, not yield. This module mirrors that arithmetic
//   one level down: a round's received amount is split pro-rata over the
//   contributors' locked contributions, using integer units only.
// - Accounting is provable: every state change is an append-only event chained
//   by SHA-256, every round produces an audit report whose hash covers all its
//   inputs, and verify.mjs recomputes everything independently.
// - Custody is NOT trustless: whoever holds the pool key holds the funds.
//   This code makes cheating *detectable*, it cannot make it *impossible*.
import { createHash } from 'node:crypto';

export const UNIT = 100_000_000n;            // 1 coin = 10^8 units
export const MIN_DEPOSIT = 10_000_000n;      // contract min_amount: 0.1 coin
export const DEFAULT_PAYOUT_THRESHOLD = 1_000_000n; // 0.01 coin
export const CLAIM_LEVEL = 1000;             // never claim above fair share

export const sha256 = s => createHash('sha256').update(s, 'utf8').digest('hex');
// Deterministic JSON: object keys sorted recursively, BigInt as decimal string.
export function stable(x) {
  if (typeof x === 'bigint') return JSON.stringify(x.toString());
  if (Array.isArray(x)) return `[${x.map(stable).join(',')}]`;
  if (x && typeof x === 'object') {
    return `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${stable(x[k])}`).join(',')}}`;
  }
  return JSON.stringify(x);
}
export const hashOf = x => sha256(stable(x));

const ADDR = /^[0-9a-f]{64}$/;
export const isAddress = a => typeof a === 'string' && ADDR.test(a);

// "0.1" -> 10000000n ; "0.00000010" -> 10n. Strict: at most 8 decimals.
export function parseCoin(s) {
  if (typeof s !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(s)) {
    throw new Error(`bad coin amount: ${s}`);
  }
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole) * UNIT + BigInt((frac + '00000000').slice(0, 8));
}
// 10000000n -> "0.10000000"
export function formatCoin(units) {
  const u = BigInt(units);
  const sign = u < 0n ? '-' : '';
  const a = u < 0n ? -u : u;
  return `${sign}${a / UNIT}.${(a % UNIT).toString().padStart(8, '0')}`;
}

export function emptyState(poolAddress, { feePerMille = 0, payoutThreshold = DEFAULT_PAYOUT_THRESHOLD } = {}) {
  if (!isAddress(poolAddress)) throw new Error('pool address must be 64-hex');
  if (!Number.isInteger(feePerMille) || feePerMille < 0 || feePerMille > 1000) throw new Error('bad fee_per_mille');
  return {
    v: 1,
    pool_address: poolAddress,
    fee_per_mille: feePerMille,
    payout_threshold_units: payoutThreshold.toString(),
    contributors: {},   // addr -> { contributed, pending, paid_total } (unit strings)
    carry_units: '0',   // integer-division dust carried into the next round
    fee_total_units: '0',
    events: [],         // append-only, hash-chained
    rounds: [],         // settled round summaries
    payouts: [],        // executed payouts
  };
}

function appendEvent(state, type, data) {
  const prev = state.events.length ? state.events[state.events.length - 1].hash : 'GENESIS';
  const ev = { i: state.events.length, type, data, prev };
  ev.hash = hashOf(ev);
  state.events.push(ev);
  return ev;
}
export const eventHead = state => (state.events.length ? state.events[state.events.length - 1].hash : 'GENESIS');

export function checkEventChain(state) {
  let prev = 'GENESIS';
  for (const [idx, ev] of state.events.entries()) {
    if (ev.i !== idx || ev.prev !== prev) return { ok: false, at: idx, why: 'chain link broken' };
    const { hash, ...rest } = ev;
    if (hashOf(rest) !== hash) return { ok: false, at: idx, why: 'event hash mismatch' };
    prev = hash;
  }
  return { ok: true, head: prev };
}

export function addContribution(state, address, amountUnits, meta = {}) {
  if (!isAddress(address)) throw new Error(`bad contributor address: ${address}`);
  const amount = BigInt(amountUnits);
  if (amount <= 0n) throw new Error('contribution must be positive');
  const c = state.contributors[address] ?? { contributed: '0', pending: '0', paid_total: '0' };
  c.contributed = (BigInt(c.contributed) + amount).toString();
  state.contributors[address] = c;
  appendEvent(state, 'contribution', { address, amount_units: amount.toString(), ...meta });
  return c;
}

export const totalContributed = state =>
  Object.values(state.contributors).reduce((s, c) => s + BigInt(c.contributed), 0n);

// Frozen per-round view of who funded the pool deposit, and how much.
// Only contributors with a positive contribution take part.
export function snapshot(state, round) {
  const rows = Object.entries(state.contributors)
    .filter(([, c]) => BigInt(c.contributed) > 0n)
    .map(([address, c]) => ({ address, deposit_units: c.contributed }))
    .sort((a, b) => (a.address < b.address ? -1 : 1));
  const snap = { round, pool_address: state.pool_address, rows, total_units: rows.reduce((s, r) => s + BigInt(r.deposit_units), 0n).toString() };
  snap.hash = hashOf({ round: snap.round, pool_address: snap.pool_address, rows: snap.rows, total_units: snap.total_units });
  return snap;
}

export const poolCanClaim = snap => BigInt(snap.total_units) >= MIN_DEPOSIT;

// Settle one round. `claimAmountUnits` is what the pool address actually
// received for its claim that round (read from the chain's claim record).
// Returns the audit report; also mutates state (pending balances, carry, fees).
export function settleRound(state, { round, claimAmountUnits, claimFairUnits = null }) {
  const snap = snapshot(state, round);
  if (!poolCanClaim(snap)) throw new Error(`pool total ${snap.total_units} below min deposit ${MIN_DEPOSIT}`);
  if (state.rounds.some(r => r.round === round)) throw new Error(`round ${round} already settled`);
  const amount = BigInt(claimAmountUnits);
  if (amount < 0n) throw new Error('negative claim amount');
  const carryIn = BigInt(state.carry_units);
  const fee = amount * BigInt(state.fee_per_mille) / 1000n;
  const distributable = amount - fee + carryIn;
  let paidOut = 0n;
  const shares = snap.rows.map(r => {
    const share = distributable * BigInt(r.deposit_units) / BigInt(snap.total_units);
    paidOut += share;
    return { address: r.address, deposit_units: r.deposit_units, share_units: share.toString() };
  });
  const dust = distributable - paidOut; // stays in the pool, carried forward
  for (const s of shares) {
    const c = state.contributors[s.address];
    c.pending = (BigInt(c.pending) + BigInt(s.share_units)).toString();
  }
  state.carry_units = dust.toString();
  state.fee_total_units = (BigInt(state.fee_total_units) + fee).toString();
  const ev = appendEvent(state, 'round_settled', { round, claim_amount_units: amount.toString(), snapshot_hash: snap.hash });
  const report = {
    v: 1, kind: 'reset-pool-round-audit',
    pool_address: state.pool_address, round,
    claim: { amount_units: amount.toString(), fair_units: claimFairUnits?.toString() ?? null, level: CLAIM_LEVEL },
    fee_per_mille: state.fee_per_mille, fee_units: fee.toString(),
    carry_in_units: carryIn.toString(), distributable_units: distributable.toString(),
    dust_units: dust.toString(), snapshot: snap, shares,
    event_hash: ev.hash,
  };
  report.report_hash = hashOf({ ...report });
  state.rounds.push({ round, claim_amount_units: amount.toString(), report_hash: report.report_hash });
  return report;
}

// Contributors whose accumulated pending balance reached the threshold.
export function planPayouts(state) {
  const th = BigInt(state.payout_threshold_units);
  return Object.entries(state.contributors)
    .filter(([, c]) => BigInt(c.pending) >= th)
    .map(([address, c]) => ({ address, amount_units: c.pending }))
    .sort((a, b) => (a.address < b.address ? -1 : 1));
}

// Record payouts as executed. `refFor(address)` supplies the proof reference
// (on-chain transfer id in production, a sim reference in the demo).
// Callers must execute the actual transfers BEFORE recording them here.
export function applyPayouts(state, payouts, refFor) {
  const done = [];
  for (const p of payouts) {
    const c = state.contributors[p.address];
    if (!c) throw new Error(`payout to unknown contributor ${p.address}`);
    const amount = BigInt(p.amount_units);
    if (amount <= 0n || amount > BigInt(c.pending)) throw new Error(`bad payout amount for ${p.address}`);
    c.pending = (BigInt(c.pending) - amount).toString();
    c.paid_total = (BigInt(c.paid_total) + amount).toString();
    const rec = { address: p.address, amount_units: amount.toString(), ref: refFor(p.address) };
    state.payouts.push(rec);
    appendEvent(state, 'payout', rec);
    done.push(rec);
  }
  return done;
}

// Conservation check anyone can run: every unit is accounted for.
//   sum(claim amounts) == sum(pending) + sum(paid_total) + fees + carry
export function checkConservation(state) {
  const claimed = state.rounds.reduce((s, r) => s + BigInt(r.claim_amount_units), 0n);
  const pending = Object.values(state.contributors).reduce((s, c) => s + BigInt(c.pending), 0n);
  const paid = Object.values(state.contributors).reduce((s, c) => s + BigInt(c.paid_total), 0n);
  const fees = BigInt(state.fee_total_units);
  const carry = BigInt(state.carry_units);
  return { ok: claimed === pending + paid + fees + carry, claimed, pending, paid, fees, carry };
}

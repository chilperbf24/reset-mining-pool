#!/usr/bin/env node
// Unit checks for the pool accounting core. `node test.mjs`
import assert from 'node:assert';
import { emptyState, addContribution, settleRound, snapshot, poolCanClaim, planPayouts,
  parseCoin, formatCoin, checkConservation, checkEventChain, MIN_DEPOSIT } from './lib/pool.mjs';

const POOL = '4150cf82f0189371818a22d5f5b10d52aadf9108c78020cc97fc002df6eaaca6';
const A = 'aa'.repeat(32), B = 'bb'.repeat(32);

// coin parsing is strict and lossless
assert.equal(parseCoin('0.1'), MIN_DEPOSIT);
assert.equal(parseCoin('0.00000010'), 10n);
assert.equal(formatCoin(10_000_000n), '0.10000000');
assert.throws(() => parseCoin('0.000000001')); // 9 decimals
assert.throws(() => parseCoin('-1'));
assert.throws(() => parseCoin('1e3'));

// below-minimum individuals, claimable pool
const s = emptyState(POOL);
addContribution(s, A, parseCoin('0.06'));
addContribution(s, B, parseCoin('0.04'));
assert.equal(poolCanClaim(snapshot(s, 1)), true); // 0.06 + 0.04 = 0.1 exactly
assert.throws(() => settleRound(emptyState(POOL), { round: 1, claimAmountUnits: 1n })); // empty pool cannot settle

// pro-rata split with dust carried, not lost and not invented
const r1 = settleRound(s, { round: 1, claimAmountUnits: 101n });
assert.equal(r1.shares.find(x => x.address === A).share_units, '60');
assert.equal(r1.shares.find(x => x.address === B).share_units, '40');
assert.equal(r1.dust_units, '1');
const r2 = settleRound(s, { round: 2, claimAmountUnits: 100n }); // 100 + 1 carried dust = 101 again
assert.equal(r2.carry_in_units, '1');
assert.equal(r2.shares.find(x => x.address === A).share_units, '60');
assert.throws(() => settleRound(s, { round: 2, claimAmountUnits: 1n })); // no double-settle

// fee comes off the top before the split
const sf = emptyState(POOL, { feePerMille: 100 }); // 10%
addContribution(sf, A, parseCoin('0.1'));
const rf = settleRound(sf, { round: 1, claimAmountUnits: 1000n });
assert.equal(rf.fee_units, '100');
assert.equal(rf.shares[0].share_units, '900');

// payouts only at/above threshold; conservation and event chain hold
assert.equal(planPayouts(s).length, 0); // pending are tiny here
assert.equal(checkConservation(s).ok, true);
assert.equal(checkEventChain(s).ok, true);
const tampered = structuredClone(s);
tampered.events[0].data.amount_units = '999';
assert.equal(checkEventChain(tampered).ok, false);

// --- self-service fingerprint attribution (lib/fpmatch.mjs) ---
import { fingerprint, fingerprintUnits, sendAmountFor, splitTail, attributeIncrement,
  processObservation, claimEntry, emptyMatcher, emptyUnclaimed, emptyFpCache } from './lib/fpmatch.mjs';

const C = 'cc'.repeat(32);
const mkCtx = candidates => ({ matcher: emptyMatcher(POOL), unclaimed: emptyUnclaimed(),
  ledger: emptyState(POOL), fpCache: emptyFpCache(), candidates });

// fingerprint roundtrip: address -> exact send amount -> credited back in full
const sendA = sendAmountFor(A, parseCoin('0.05'));
assert.equal(splitTail(sendA).tail, fingerprintUnits(A));
assert.throws(() => sendAmountFor(A, 1_500_000n)); // planned must be a 0.01 multiple
{
  const ctx = mkCtx([A, B, C]);
  processObservation({ totalUnits: 0n, lastResult: null }, ctx); // baseline
  const acts = processObservation({ totalUnits: sendA, lastResult: null }, ctx);
  assert.equal(acts.filter(a => a.type === 'credited').length, 1);
  assert.equal(ctx.ledger.contributors[A].contributed, sendA.toString()); // tail included, in full
  assert.equal(ctx.fpCache.matches[A], fingerprint(A));
}
// settled claim earnings are explained by last_result, never booked as a contribution
{
  const ctx = mkCtx([A, B]);
  processObservation({ totalUnits: 0n, lastResult: null }, ctx);
  const acts = processObservation({ totalUnits: 123456n, lastResult: { r: 7, amount: 123456n } }, ctx);
  assert.equal(acts.some(a => a.type === 'credited'), false);
  assert.equal(ctx.unclaimed.entries.length, 0);
  assert.equal(ctx.matcher.accounted_settle_round, 7);
}
// off by a single unit: no match, the amount is parked as unclaimed
{
  const ctx = mkCtx([A, B]);
  processObservation({ totalUnits: 0n, lastResult: null }, ctx);
  processObservation({ totalUnits: sendA - 1n, lastResult: null }, ctx);
  assert.equal(ctx.ledger.contributors[A], undefined);
  assert.equal(ctx.unclaimed.entries.length, 1);
  assert.equal(ctx.unclaimed.entries[0].amount_units, (sendA - 1n).toString());
}
// two candidate addresses sharing one fingerprint: collision -> parked, never guessed
{
  const seen = new Map(); let X, Y;
  for (let i = 0; ; i++) {
    const addr = i.toString(16).padStart(64, '0');
    const fp = fingerprint(addr);
    if (seen.has(fp)) { X = seen.get(fp); Y = addr; break; }
    seen.set(fp, addr);
  }
  const D = parseCoin('0.05') + fingerprintUnits(X);
  const attr = attributeIncrement(D, [X, Y]);
  assert.equal(attr.match, null);
  assert.equal(attr.hits.length, 2);
  const ctx = mkCtx([X, Y]);
  processObservation({ totalUnits: 0n, lastResult: null }, ctx);
  processObservation({ totalUnits: D, lastResult: null }, ctx);
  assert.equal(ctx.unclaimed.entries.length, 1);
  assert.equal(Object.keys(ctx.ledger.contributors).length, 0);
}
// brand-new address (in no candidate list): parks as unclaimed, then the
// address alone claims it — wrong address is refused; a round amount
// (tail 0) can never be claimed by anyone.
{
  const NEW = 'ee'.repeat(32);
  const ctx = mkCtx([A, B]);
  processObservation({ totalUnits: 0n, lastResult: null }, ctx);
  const D = sendAmountFor(NEW, parseCoin('0.05'));
  processObservation({ totalUnits: D, lastResult: null }, ctx);
  assert.equal(ctx.unclaimed.entries.length, 1);
  assert.throws(() => claimEntry(ctx, 1, A)); // tail belongs to NEW, not A
  const claimed = claimEntry(ctx, 1, NEW);
  assert.equal(claimed.status, 'claimed');
  assert.equal(ctx.ledger.contributors[NEW].contributed, D.toString());

  const ctx2 = mkCtx([A]);
  processObservation({ totalUnits: 5_000_000n, lastResult: null }, ctx2); // first sight: pre-existing 0.05
  assert.equal(ctx2.unclaimed.entries[0].kind, 'pre_existing');
  assert.throws(() => claimEntry(ctx2, 1, A));
  assert.throws(() => claimEntry(ctx2, 1, NEW));
}

console.log('all pool tests passed');

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

console.log('all pool tests passed');

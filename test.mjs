#!/usr/bin/env node
// Unit checks for the pool accounting core. `node test.mjs`
import assert from 'node:assert';
import { emptyState, addContribution, settleRound, snapshot, poolCanClaim, planPayouts,
  parseCoin, formatCoin, checkConservation, checkEventChain, MIN_DEPOSIT, planLock } from './lib/pool.mjs';

const POOL = '4150cf82f0189371818a22d5f5b10d52aadf9108c78020cc97fc002df6eaaca6';
const A = 'aa'.repeat(32), B = 'bb'.repeat(32);

// lock policy: idle balance >= one minimum lock is swept in FULL, whatever
// the current deposit; below the minimum nothing can be locked this pass
assert.equal(planLock(parseCoin('0.15'), 0n), parseCoin('0.15'));            // first lock takes all 0.15
assert.equal(planLock(parseCoin('0.11'), parseCoin('0.15')), parseCoin('0.11')); // top-up lock takes all 0.11
assert.equal(planLock(parseCoin('0.099'), 0n), 0n);                          // below one lock move: wait
assert.equal(planLock(parseCoin('0.10'), 0n), parseCoin('0.10'));            // exactly one minimum lock
assert.equal(planLock(0n, parseCoin('0.2')), 0n);                            // nothing idle: no lock

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
  processObservation, claimEntry, emptyMatcher, emptyUnclaimed, emptyFpCache,
  normalizeAddress, encodeTracAddress, decodeTracAddress } from './lib/fpmatch.mjs';

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

// --- dual address formats: 64-hex and trac1 are one key, two encodings ---
// Real wallet pairs (pool wallet; the operator's personal wallet): decoding
// the trac1 form lands exactly on the hex form, encoding reproduces the
// published trac1 string — the payload is the raw 32-byte key, bech32m.
const POOL_TRAC = 'trac1g9gvlqhsrzfhrqv2yt2ltvgd224dlyggc7qzpnyhlsqzmah24jnqg3ua9z';
const OWNER = '2479c2e76d69c55ffc40f7d044f25da03388bd1959580163f5463c09f1755b14';
const OWNER_TRAC = 'trac1y3uu9emdd8z4llzq7lgyfuja5qec30get9vqzcl4gc7qnut4tv2qfzxszf';
assert.equal(decodeTracAddress(POOL_TRAC), POOL);
assert.equal(encodeTracAddress(POOL), POOL_TRAC);
assert.equal(decodeTracAddress(OWNER_TRAC), OWNER);
assert.equal(encodeTracAddress(OWNER), OWNER_TRAC);
// normalize: either spelling (either case) -> canonical lowercase hex
assert.equal(normalizeAddress(POOL), POOL);
assert.equal(normalizeAddress(POOL_TRAC), POOL);
assert.equal(normalizeAddress(POOL.toUpperCase()), POOL);        // uppercase hex
assert.equal(normalizeAddress(OWNER_TRAC.toUpperCase()), OWNER); // uppercase TRAC1
assert.equal(normalizeAddress('  ' + OWNER + '  '), OWNER);      // surrounding whitespace
// bad checksum, mixed case, garbage: refused, never guessed
const badCk = OWNER_TRAC.slice(0, -1) + (OWNER_TRAC.endsWith('q') ? 'p' : 'q');
assert.equal(decodeTracAddress(badCk), null);
assert.equal(normalizeAddress(badCk), null);
assert.equal(normalizeAddress('TrAc1y3uu9emdd8z4llzq7lgyfuja5qec30get9vqzcl4gc7qnut4tv2qfzxszf'), null); // mixed case
assert.equal(normalizeAddress('trac1qqqqqq'), null);
assert.equal(normalizeAddress('not-an-address'), null);
assert.equal(normalizeAddress(''), null);
assert.equal(normalizeAddress(null), null);
assert.equal(normalizeAddress(OWNER.slice(0, 63)), null); // truncated hex
// fingerprint identity: same key, either spelling -> the same tail, so the
// amount computed from a pasted trac1 address is the one the matcher expects
assert.equal(fingerprint(OWNER_TRAC), fingerprint(OWNER));
assert.equal(sendAmountFor(OWNER_TRAC, parseCoin('0.05')), sendAmountFor(OWNER, parseCoin('0.05')));
// claiming with the trac1 spelling credits the hex identity
{
  const NEW2 = 'dd'.repeat(32);
  const ctx = mkCtx([A, B]);
  processObservation({ totalUnits: 0n, lastResult: null }, ctx);
  const D = sendAmountFor(NEW2, parseCoin('0.05'));
  processObservation({ totalUnits: D, lastResult: null }, ctx);
  assert.equal(ctx.unclaimed.entries.length, 1);
  const claimed = claimEntry(ctx, 1, encodeTracAddress(NEW2));
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.claimed_by, NEW2);
  assert.equal(ctx.ledger.contributors[NEW2].contributed, D.toString());
}

// --- member exits: close-out math + dissolution boundary (lib/pool.mjs,
// lib/exit.mjs) ---
import { totalDue, closePosition, recordExitEvent, markDissolved } from './lib/pool.mjs';
import { planExit, checkExitConservation } from './lib/exit.mjs';
{
  const s = emptyState(POOL);
  addContribution(s, A, parseCoin('0.06'));
  addContribution(s, B, parseCoin('0.05'));
  settleRound(s, { round: 1, claimAmountUnits: 1100n }); // A earns 600, B earns 500
  assert.equal(totalDue(s, A), parseCoin('0.06') + 600n);
  assert.equal(totalDue(s, 'ff'.repeat(32)), 0n); // unknown address owes nothing
  // freeze A's full position and close it out
  const evBefore = s.events.length;
  closePosition(s, A, { caseId: 'exit-test', principalUnits: parseCoin('0.06'), earningsUnits: 600n });
  const cA = s.contributors[A];
  assert.equal(cA.contributed, '0');
  assert.equal(cA.pending, '0');
  assert.equal(cA.paid_total, '600');              // earnings leg lands in paid_total…
  assert.equal(cA.exited_principal_total, parseCoin('0.06').toString()); // …principal is tracked apart
  assert.equal(cA.closed.total_units, (parseCoin('0.06') + 600n).toString());
  assert.equal(s.events.length, evBefore + 1);
  assert.equal(s.events.at(-1).type, 'exit_paid');
  assert.equal(checkConservation(s).ok, true);     // earnings identity still exact after a close-out
  assert.equal(checkEventChain(s).ok, true);
  assert.equal(totalDue(s, A), 0n);                // closed: nothing more is owed
  assert.throws(() => closePosition(s, A, { caseId: 'x', principalUnits: 1n, earningsUnits: 0n })); // no double close
  // earnings keep settling for the REMAINING members after a close-out
  const s2 = emptyState(POOL);
  addContribution(s2, A, parseCoin('0.05'));
  addContribution(s2, B, parseCoin('0.05'));
  addContribution(s2, C, parseCoin('0.05'));
  settleRound(s2, { round: 1, claimAmountUnits: 1500n }); // 500 each
  closePosition(s2, A, { caseId: 'e1', principalUnits: parseCoin('0.05'), earningsUnits: 500n });
  settleRound(s2, { round: 2, claimAmountUnits: 1000n }); // B + C only (A's snapshot deposit is 0)
  assert.equal(BigInt(s2.contributors[B].pending), 1000n); // 500 + 500
  assert.equal(checkConservation(s2).ok, true);
  // audit events + dissolution marker ride the same hash chain
  recordExitEvent(s2, 'exit_verified', { address: B, case_id: 'e2' });
  markDissolved(s2, { triggerCaseId: 'e2' });
  assert.equal(s2.dissolved.trigger_case_id, 'e2');
  assert.throws(() => markDissolved(s2, {}));
  assert.equal(checkEventChain(s2).ok, true);
}
// dissolution boundary: post-exit deposit EXACTLY 0.1 survives; one unit
// less dissolves. The unlock move is max(due, MIN), capped by the deposit.
{
  const D = MIN_DEPOSIT;
  const exact = planExit({ chainDepositUnits: 20000000n, dueUnits: 10000000n });
  assert.equal(exact.afterUnits, D); assert.equal(exact.dissolve, false);
  const under = planExit({ chainDepositUnits: 20000000n, dueUnits: 10000001n });
  assert.equal(under.afterUnits, D - 1n); assert.equal(under.dissolve, true);
  assert.equal(under.unlockUnits, 20000000n); // dissolution unlocks EVERYTHING
  const small = planExit({ chainDepositUnits: 22933277n, dueUnits: 8216449n }); // ad44-shaped case
  assert.equal(small.dissolve, false);
  assert.equal(small.afterUnits, 14716828n);
  assert.equal(small.unlockUnits, 10000000n); // due < one move: the move is MIN_DEPOSIT
  const big = planExit({ chainDepositUnits: 30000000n, dueUnits: 15000000n });
  assert.equal(big.dissolve, false);
  assert.equal(big.unlockUnits, 15000000n); // due above the minimum: move = due
  const bigDissolve = planExit({ chainDepositUnits: 22933277n, dueUnits: 15000000n });
  assert.equal(bigDissolve.dissolve, true); // after = 7933277 < 0.1
  assert.equal(bigDissolve.unlockUnits, 22933277n);
}
// executor conservation self-check catches a tampered ledger AND an
// insolvent one, and reports honest slack when the chain is ahead
{
  const s = emptyState(POOL);
  addContribution(s, A, parseCoin('0.06'));
  const chain = { balance: 0n, deposit: parseCoin('0.06'), exits: [] };
  const good = checkExitConservation(s, chain);
  assert.equal(good.ok, true); assert.equal(good.slack, 0n);
  const tampered = structuredClone(s);
  tampered.contributors[A].pending = '5'; // invented earnings
  assert.equal(checkExitConservation(tampered, chain).ok, false);
  const short = checkExitConservation(s, { balance: 0n, deposit: parseCoin('0.05'), exits: [] });
  assert.equal(short.ok, false); // obligations exceed assets
  const ahead = checkExitConservation(s, { balance: 700n, deposit: parseCoin('0.06'), exits: [] });
  assert.equal(ahead.ok, true); assert.equal(ahead.slack, 700n); // unrecorded settlement: fine
}

console.log('all pool tests passed');

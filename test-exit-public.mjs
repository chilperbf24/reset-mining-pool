#!/usr/bin/env node
// Assertions for lib/exit-public.mjs — the public projection of exit
// cases that feeds state/exit-cases.json and the exit page's stage-5
// progress lookup. Pins the one real case (the cancelled 2026-10-22
// rehearsal) field by field, plus the done-case shape.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { publicExitCases, publicExitSummary } from './lib/exit-public.mjs';

const exits = JSON.parse(readFileSync(new URL('./state/exits.json', import.meta.url), 'utf8'));
const cases = publicExitCases(exits);
assert.equal(cases.length, 1);
const c = cases[0];
assert.equal(c.id, 'exit-20261022-001-3e8d');
assert.equal(c.address, '4150cf82f0189371818a22d5f5b10d52aadf9108c78020cc97fc002df6eaaca6');
assert.equal(c.status, 'cancelled');
assert.equal(c.due_units, '2812116');            // frozen: 0.02812116
assert.equal(c.principal_units, '2661039');
assert.equal(c.earnings_units, '151077');
// The rehearsal unlock DID land even though the executor halted before
// recording release_at (signer reported 'accepted'): landed detection
// must see it, and the release height is counted_at + 144.
assert.equal(c.unlock.landed, true);
assert.equal(c.unlock.amount_units, '10000000'); // 0.1 unlocked
assert.equal(c.unlock.counted_at, 972559);
assert.equal(c.unlock.release_at, 972703);
assert.equal(c.withdrawn_at, null);
assert.equal(c.paid_at, null);
assert.equal(c.paid_units, null);
// Operational internals never leak into the public projection.
for (const k of ['nonce', 'registry_id', 'halt_reason', 'history', 'money_moved']) assert.ok(!(k in c), k);
assert.ok(!('pre_exits' in (c.unlock ?? {})));

// A completed case: paid amount is exactly the frozen due, withdrawn_at
// comes from the history event.
const done = publicExitCases({ cases: [{
  id: 'exit-x', address: 'a'.repeat(64), status: 'done', dissolution: false,
  created_at: '2026-01-01T00:00:00.000Z', verified_at: '2026-01-01T00:00:00.000Z',
  principal_units: '100', earnings_units: '5', due_units: '105',
  unlock: { amount_units: '10000000', counted_at: 1000, release_at: 1144, attempts: 1, sent: true },
  withdraw: { attempts: 1 }, paid_at: '2026-01-02T00:00:00.000Z', halt_reason: null,
  history: [{ at: '2026-01-01T01:00:00.000Z', event: 'withdrawn' }],
}] })[0];
assert.equal(done.unlock.landed, true);
assert.equal(done.unlock.release_at, 1144); // recorded height wins over derivation
assert.equal(done.withdrawn_at, '2026-01-01T01:00:00.000Z');
assert.equal(done.paid_units, '105');
assert.equal(done.paid_at, '2026-01-02T00:00:00.000Z');

// A fresh case (nothing planned yet): no unlock, no amounts invented.
const fresh = publicExitCases({ cases: [{
  id: 'exit-y', address: 'b'.repeat(64), status: 'verified', dissolution: false,
  created_at: null, verified_at: null, principal_units: null, earnings_units: null,
  due_units: null, unlock: null, withdraw: null, paid_at: null, history: [],
}] })[0];
assert.equal(fresh.unlock, null);
assert.equal(fresh.due_units, null);

const summary = publicExitSummary(exits);
assert.equal(summary.v, 1);
assert.equal(summary.cases.length, 1);

console.log('test-exit-public: all assertions passed');

// v2 join scheme (2026-10-24, operator ruling): planned step 0.001,
// tail mod 99999 + 1 — plus the guarantee that NOTHING already booked
// changes: v1 math (step 0.01, tail mod 999999 + 1) stays a second key
// forever. No production wallets, no gateway: pure matcher math plus a
// mock-D1 Worker for the /calc + /join/code validation surface.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker/src/index.js';
import { emptyState } from './lib/pool.mjs';
import { emptyMatcher, emptyUnclaimed, emptyFpCache, processObservation,
  fingerprint, fingerprintUnits, legacyFingerprint, legacyFingerprintUnits,
  sendAmountFor, splitTail, splitTailLegacy, attributeIncrement,
  claimEntryAs, fingerprintMatchesAmount } from './lib/fpmatch.mjs';
import { findJoinRetroClaim } from './lib/fprun.mjs';

const POOL = '4150cf82f0189371818a22d5f5b10d52aadf9108c78020cc97fc002df6eaaca6';
const KEY = 'join-0001-operator-key';
const A = 'aa'.repeat(32);
const B = 'bb'.repeat(32);
let n = 0; const ok = name => console.log(`  ok ${++n}. ${name}`);

// --- minimal mock D1: only the SQL /calc + /join/code issue -------------
function cond(where, params) {
  const atoms = where.split(/\s+AND\s+/);
  let pi = 0;
  const tests = atoms.map(atom => {
    let m;
    if ((m = atom.trim().match(/^(\w+) = \?$/))) { const c = m[1], v = params[pi++]; return r => r[c] === v; }
    if ((m = atom.trim().match(/^(\w+) = '([^']*)'$/))) { const c = m[1], v = m[2]; return r => r[c] === v; }
    if ((m = atom.trim().match(/^(\w+) < \?$/))) { const c = m[1], v = params[pi++]; return r => r[c] < v; }
    throw new Error(`mock: unsupported atom ${atom}`);
  });
  return r => tests.every(t => t(r));
}
class MockDB {
  constructor() { this.t = { records: [], join_codes: [], join_claims: [] }; this.nextId = 1; }
  prepare(sql) {
    const db = this;
    return {
      params: [],
      bind(...p) { this.params = p; return this; },
      async run() {
        let m;
        if ((m = sql.match(/INSERT INTO (\w+) \(([^)]+)\)/))) {
          const cols = m[2].split(',').map(s => s.trim());
          const row = { id: db.nextId++ };
          cols.forEach((c, i) => { row[c] = this.params[i] ?? null; });
          db.t[m[1]].push(row);
          return { meta: { last_row_id: row.id } };
        }
        if ((m = sql.match(/^DELETE FROM (\w+) WHERE (.+)$/s))) {
          const pred = cond(m[2], this.params);
          const before = db.t[m[1]].length;
          db.t[m[1]] = db.t[m[1]].filter(r => !pred(r));
          return { meta: { changes: before - db.t[m[1]].length } };
        }
        if ((m = sql.match(/^UPDATE (\w+) SET (.+?) WHERE (.+)$/s))) {
          let pi = 0;
          const assigns = m[2].split(',').map(part => {
            const am = part.trim().match(/^(\w+) = (?:'([^']*)'|\?)$/);
            return [am[1], am[2] !== undefined ? am[2] : this.params[pi++]];
          });
          const pred = cond(m[3], this.params.slice(pi));
          let changes = 0;
          for (const r of db.t[m[1]]) if (pred(r)) { for (const [c, v] of assigns) r[c] = v; changes++; }
          return { meta: { changes } };
        }
        throw new Error(`mock: unsupported run SQL: ${sql}`);
      },
      async first() {
        const m = sql.match(/SELECT \* FROM (\w+) WHERE (\w+) = \? ORDER BY ts, id/);
        if (!m) throw new Error(`mock: unsupported first SQL: ${sql}`);
        const rows = db.t[m[1]].filter(r => r[m[2]] === this.params[0])
          .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id - b.id));
        return rows[0] ?? null;
      },
      async all() {
        const m = sql.match(/SELECT \* FROM (\w+) WHERE (\w+) = \? ORDER BY ts, id/);
        if (!m) throw new Error(`mock: unsupported all SQL: ${sql}`);
        const results = db.t[m[1]].filter(r => r[m[2]] === this.params[0])
          .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id - b.id));
        return { results };
      },
    };
  }
}
const env = { REGISTRY_DB: new MockDB(), REGISTRY_KEY: KEY, POOL_ADDRESS: POOL };
const call = (method, path, { body } = {}) => worker.fetch(new Request(`https://registry.test${path}`, {
  method,
  headers: { ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}), env);
const j = async r => ({ status: r.status, body: await r.json() });
const mkCtx = candidates => ({ matcher: emptyMatcher(POOL), unclaimed: emptyUnclaimed(),
  ledger: emptyState(POOL), fpCache: emptyFpCache(), candidates });

test('v2 join scheme: 0.001 step, small tail, v1 honored, booked history untouched', async () => {
  // 1. v2 exact math: planned must be a 0.001 multiple; tail is 1..99999.
  const fpA = fingerprint(A);
  assert(fpA >= 1 && fpA <= 99999, `v2 tail in range, got ${fpA}`);
  assert.equal(sendAmountFor(A, 100_000n), 100_000n + BigInt(fpA));
  assert.equal(sendAmountFor(A, 1_000_000n), 1_000_000n + BigInt(fpA));
  assert.throws(() => sendAmountFor(A, 99_999n));
  assert.throws(() => sendAmountFor(A, 0n));
  assert.equal(splitTail(sendAmountFor(A, 100_000n)).tail, BigInt(fpA));
  ok('v2 exact math: 0.001 step, tail 1..99999');

  // 2. A member holding exactly 0.01 CAN join now: plan 0.009 + v2 tail
  // stays below their whole balance (v1's minimum exact was 0.01000001).
  const total009 = 900_000n + BigInt(fpA);
  assert(total009 < 1_000_000n, `0.009 plan + v2 tail must fit in 0.01, got ${total009}`);
  const total001v1 = 1_000_000n + legacyFingerprintUnits(A);
  assert(total001v1 > 1_000_000n, 'v1 0.01 plan always exceeded 0.01');
  assert(1_000_000n + BigInt(fpA) < total001v1, 'v2 0.01 plan costs less than v1');
  ok('exactly-0.01 holder fits: 0.009 plan + v2 tail < 0.01');

  // 3. v2 inflow credits via the fallback with the v2 tail on the event.
  {
    const ctx = mkCtx([A, B]);
    processObservation({ totalUnits: 0n, lastResult: null }, ctx);
    const amt = sendAmountFor(A, 100_000n);
    const acts = processObservation({ totalUnits: amt, lastResult: null }, ctx);
    const credit = acts.find(a => a.type === 'credited');
    assert(credit && credit.address === A);
    assert.equal(credit.fp_tail_units, String(fpA));
    assert.equal(ctx.ledger.contributors[A].contributed, amt.toString());
  }
  ok('v2 inflow credits in full via fingerprint fallback');

  // 4. v1 inflow arriving LATE still attributes (legacy second key),
  // with the v1 tail on the ledger event — booked history untouched.
  {
    const ctx = mkCtx([A, B]);
    processObservation({ totalUnits: 0n, lastResult: null }, ctx);
    const amtV1 = 1_000_000n + legacyFingerprintUnits(A);
    const attr = attributeIncrement(amtV1, [A, B]);
    assert.equal(attr.match, A);
    assert.equal(attr.scheme, 'v1');
    assert.equal(attr.tail, legacyFingerprintUnits(A));
    const acts = processObservation({ totalUnits: amtV1, lastResult: null }, ctx);
    const credit = acts.find(a => a.type === 'credited');
    assert(credit && credit.address === A);
    assert.equal(credit.fp_tail_units, legacyFingerprint(A).toString());
    assert.equal(ctx.ledger.contributors[A].contributed, amtV1.toString());
  }
  ok('late v1 inflow still attributes under the legacy key');

  // 5. v1 parked entry stays claimable after the change (amount-derived
  // dual check — the stored tail field is not the gate).
  {
    const ctx = mkCtx([]); // sender unknown at park time
    processObservation({ totalUnits: 0n, lastResult: null }, ctx);
    const amtV1 = 1_000_000n + legacyFingerprintUnits(A);
    processObservation({ totalUnits: amtV1, lastResult: null }, ctx);
    assert.equal(ctx.unclaimed.entries.length, 1);
    const e = claimEntryAs({ unclaimed: ctx.unclaimed, ledger: ctx.ledger, now: new Date().toISOString() },
      1, A, { source: 'fingerprint-claim' });
    assert.equal(e.status, 'claimed');
    assert.equal(ctx.ledger.contributors[A].contributed, amtV1.toString());
    assert.equal(fingerprintMatchesAmount(A, amtV1).scheme, 'v1');
    assert.equal(fingerprintMatchesAmount(B, amtV1).match, false);
  }
  ok('v1 parked entry claimable after the change; wrong address refused');

  // 6. v1 join retro gate still fires (entry parked under v1 + pending
  // claim with the same exact amount).
  {
    const amtV1 = 1_000_000n + legacyFingerprintUnits(A);
    const entry = { amount_units: amtV1.toString(), tail_units: splitTailLegacy(amtV1).tail.toString() };
    const claim = { address_hex: A, exact_units: amtV1.toString(), nonce: '0123456789abcdef' };
    assert(findJoinRetroClaim([claim], entry, POOL)?.address_hex === A);
  }
  ok('v1 join retro gate fires on amount + legacy fingerprint');

  // 7. v2 collision parks, never guesses.
  {
    const seen = new Map(); let X, Y;
    for (let i = 0; ; i++) {
      const addr = i.toString(16).padStart(64, '0');
      const fp = fingerprint(addr);
      if (seen.has(fp)) { X = seen.get(fp); Y = addr; break; }
      seen.set(fp, addr);
    }
    const D = 100_000n + fingerprintUnits(X);
    const attr = attributeIncrement(D, [X, Y]);
    assert.equal(attr.match, null);
    assert.equal(attr.hits.length, 2);
  }
  ok('v2 fingerprint collision parks, never guesses');

  // 8. Worker surface: /join/code + /calc accept 0.001 plans with v2
  // tails and reject v1 math / non-0.001 plans.
  {
    const fpW = fingerprint(A);
    let r = await j(await call('POST', '/join/code', { body: { address: A, planned_units: '100000' } }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.code.exact_units, String(100_000 + fpW));
    r = await j(await call('POST', '/join/code', { body: { address: A, planned_units: '150001' } }));
    assert.equal(r.status, 400);
    r = await j(await call('POST', '/join/code', { body: { address: A, planned_units: '1000000' } }));
    assert.equal(r.status, 201); // 0.01 is still valid: 10 x 0.001
    r = await j(await call('POST', '/calc', { body: { address: A, planned_units: '100000',
      fp_units: String(fpW), exact_units: String(100_000 + fpW), status: 'ok' } }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    r = await j(await call('POST', '/calc', { body: { address: A, planned_units: '1000000',
      fp_units: String(legacyFingerprint(A)), exact_units: String(1_000_000 + legacyFingerprint(A)), status: 'ok' } }));
    assert.equal(r.status, 400, 'v1 math must no longer file');
  }
  ok('Worker: 0.001 plans + v2 tails accepted; v1 math rejected');
});

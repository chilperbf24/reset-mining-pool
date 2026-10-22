#!/usr/bin/env node
// Local harness for the registry Worker — no Cloudflare account needed.
// Drives worker/src/index.js with an in-memory mock of the D1 binding
// (only the SQL shapes the Worker issues) and asserts the whole surface:
//   POST /calc -> GET /lookup round-trips, backfill lookups, rejections.
//   node worker/test-local.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import worker from './src/index.js';
import { encodeTracAddress, fingerprint } from '../lib/fpmatch.mjs';

// ------------------------------------------------------------- mock D1
// Supports exactly the SQL shapes the Worker issues: INSERT INTO
// records (cols) VALUES (?,...), DELETE / UPDATE ... WHERE <conds>,
// SELECT COUNT(*) [WHERE <conds>], SELECT * ... WHERE <col> = ?.
// <conds> are AND-joined atoms (split at paren depth 0): col = ?,
// col >= ?, col < ?, col = 'lit', col <> 'lit', or one parenthesized
// (atom OR atom) group — '?' params are consumed in textual order.
function condPredicate(where, params, piStart = 0) {
  let pi = piStart;
  const atomPred = raw => {
    const atom = raw.trim();
    let m;
    if ((m = atom.match(/^\((.+)\s+OR\s+(.+)\)$/s))) {
      const l = atomPred(m[1]), r = atomPred(m[2]);
      return row => l(row) || r(row);
    }
    if ((m = atom.match(/^(\w+) = \?$/))) { const c = m[1], v = params[pi++]; return r => r[c] === v; }
    if ((m = atom.match(/^(\w+) >= \?$/))) { const c = m[1], v = params[pi++]; return r => r[c] >= v; }
    if ((m = atom.match(/^(\w+) < \?$/))) { const c = m[1], v = params[pi++]; return r => r[c] < v; }
    if ((m = atom.match(/^(\w+) <> '([^']*)'$/))) { const c = m[1], v = m[2]; return r => r[c] !== v; }
    if ((m = atom.match(/^(\w+) = '([^']*)'$/))) { const c = m[1], v = m[2]; return r => r[c] === v; }
    throw new Error(`mock: unsupported condition atom: ${atom}`);
  };
  const atoms = [];
  let depth = 0, start = 0;
  for (let i = 0; i < where.length; i++) {
    const ch = where[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && /^\s+AND\s+/i.test(where.slice(i))) {
      atoms.push(where.slice(start, i));
      i += where.slice(i).match(/^\s+AND\s+/i)[0].length - 1;
      start = i + 1;
    }
  }
  atoms.push(where.slice(start));
  const tests = atoms.map(atomPred);
  return r => tests.every(t => t(r));
}
class MockStmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.params = []; }
  bind(...p) { this.params = p; return this; }
  async run() {
    let m;
    if ((m = this.sql.match(/INSERT INTO records \(([^)]+)\)\s+VALUES \(([^)]+)\)/))) {
      const cols = m[1].split(',').map(s => s.trim());
      const row = { id: this.db.nextId++ };
      cols.forEach((c, i) => { row[c] = this.params[i] ?? null; });
      this.db.rows.push(row);
      return { meta: { last_row_id: row.id } };
    }
    if ((m = this.sql.match(/^DELETE FROM records WHERE (.+)$/s))) {
      const pred = condPredicate(m[1], this.params);
      const before = this.db.rows.length;
      this.db.rows = this.db.rows.filter(r => !pred(r));
      return { meta: { changes: before - this.db.rows.length } };
    }
    if ((m = this.sql.match(/^UPDATE records SET (.+?) WHERE (.+)$/s))) {
      // Assignments are `col = 'lit'` or `col = ?`, comma-separated, no
      // commas inside values; '?' params are consumed in textual order —
      // SET assignments first, then the WHERE clause.
      let pi = 0;
      const assigns = m[1].split(',').map(part => {
        const am = part.trim().match(/^(\w+) = (?:'([^']*)'|\?)$/);
        assert(am, `mock: unsupported assignment: ${part}`);
        return [am[1], am[2] !== undefined ? am[2] : this.params[pi++]];
      });
      const pred = condPredicate(m[2], this.params, pi);
      let changes = 0;
      for (const r of this.db.rows) if (pred(r)) { for (const [c, v] of assigns) r[c] = v; changes++; }
      return { meta: { changes } };
    }
    assert.fail(`mock: unsupported run SQL: ${this.sql}`);
  }
  async first() {
    const m = this.sql.match(/SELECT COUNT\(\*\) AS n FROM records(?: WHERE (.+))?$/s);
    assert(m, `mock: unsupported first SQL: ${this.sql}`);
    let rows = this.db.rows;
    if (m[1]) rows = rows.filter(condPredicate(m[1], this.params));
    return { n: rows.length };
  }
  async all() {
    const m = this.sql.match(/SELECT \* FROM records WHERE (\w+) = \? ORDER BY ts, id/);
    assert(m, `mock: unsupported all SQL: ${this.sql}`);
    const col = m[1], val = this.params[0];
    const results = this.db.rows.filter(r => r[col] === val)
      .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id - b.id));
    return { results };
  }
}
class MockD1 {
  constructor() { this.rows = []; this.nextId = 1; }
  prepare(sql) { return new MockStmt(this, sql); }
  seed(rows) { for (const r of rows) this.rows.push({ id: this.nextId++, note: null, ip_hash: null, ...r }); }
}

// ------------------------------------------------------------- driving
const KEY = 'test-operator-key';
const db = new MockD1();
const env = { REGISTRY_DB: db, REGISTRY_KEY: KEY };
const call = (method, path, { body, key, ip } = {}) => worker.fetch(new Request(`https://registry.test${path}`, {
  method,
  headers: {
    ...(body ? { 'content-type': 'application/json' } : {}),
    ...(key ? { 'x-registry-key': key } : {}),
    ...(ip ? { 'cf-connecting-ip': ip } : {}),
  },
  body: body ? JSON.stringify(body) : undefined,
}), env);
const j = async r => ({ status: r.status, body: await r.json() });

const A = 'aa'.repeat(32);                                  // synthetic member
const B = '0f9af20bf4b6e0913540f338fde4e3010c0151da0b94fc9f205a5216d53403a7'; // real contributor #2
const FIRST = '1f1613f19eff94f3adc79f8d48f8b186368b6c44b31905355cfe9bdee98a001d'; // real contributor #1
const POOL = '4150cf82f0189371818a22d5f5b10d52aadf9108c78020cc97fc002df6eaaca6';
let n = 0; const ok = name => console.log(`  ok ${++n}. ${name}`);

// --- health on empty registry
let r = await j(await call('GET', '/health'));
assert.equal(r.status, 200); assert.equal(r.body.records, 0); ok('health: empty registry reports 0 records');

// --- seed the historical backfill (from seed.jsonl, generated from the books)
const seedRows = readFileSync(new URL('./seed.jsonl', import.meta.url), 'utf8')
  .trim().split('\n').map(l => JSON.parse(l));
db.seed(seedRows);
r = await j(await call('GET', '/health'));
assert.equal(r.body.records, 4); ok('health: 4 backfilled records counted');

// backfill.sql must carry the same facts (deploy imports the .sql, tests use .jsonl)
const sql = readFileSync(new URL('./backfill.sql', import.meta.url), 'utf8');
for (const needle of ['661039', '2661039', '657260', '3657260', "'1055'", FIRST, B]) {
  assert(sql.includes(needle), `backfill.sql missing ${needle}`);
}
ok('backfill.sql contains all key facts (tails, amounts, addresses)');

// --- backfill lookups (task-specified)
r = await j(await call('GET', '/lookup?tail=661039', { key: KEY }));
assert.equal(r.status, 200);
assert(r.body.records.some(x => x.kind === 'unclaimed' && x.status === 'open' && x.exact_units === '2661039'));
ok('lookup tail=661039 -> open unclaimed #2 (pool-address fingerprint)');

r = await j(await call('GET', '/lookup?tail=1055', { key: KEY }));
assert(r.body.records.some(x => x.kind === 'import' && x.address_hex === FIRST && x.exact_units === '5000000'));
ok('lookup tail=1055 -> import record of the first contribution');

r = await j(await call('GET', `/lookup?address=${FIRST}`, { key: KEY }));
assert.equal(r.body.records.length, 2); // import + claimed unclaimed history
assert(r.body.records.some(x => x.kind === 'import') && r.body.records.some(x => x.kind === 'unclaimed' && x.status === 'claimed'));
ok('lookup address=1f1613… -> import + claimed unclaimed history side by side');

r = await j(await call('GET', '/lookup?amount=2661039', { key: KEY }));
assert(r.body.records.some(x => x.kind === 'unclaimed' && x.status === 'open'));
ok('lookup amount=2661039 -> open unclaimed #2');

// --- lookup auth
r = await j(await call('GET', '/lookup?tail=1'));
assert.equal(r.status, 401); ok('lookup without operator key -> 401');
r = await j(await call('GET', '/lookup?tail=1', { key: 'wrong' }));
assert.equal(r.status, 401); ok('lookup with wrong key -> 401');
r = await j(await call('GET', '/lookup', { key: KEY }));
assert.equal(r.status, 400); ok('lookup with no filter -> 400');
r = await j(await call('GET', `/lookup?address=${encodeTracAddress(B)}`, { key: KEY }));
assert(r.body.records.some(x => x.kind === 'auto_match'));
ok('lookup by trac1 spelling -> same records as hex (normalize server-side)');

// --- POST /calc: happy path (numbers recomputed here from lib, not typed)
const fpA = fingerprint(A);
r = await j(await call('POST', '/calc', { body: {
  address: A, planned_units: '5000000', fp_units: String(fpA),
  exact_units: String(5000000 + fpA), status: 'ok' }, ip: '198.51.100.1' }));
assert.equal(r.status, 201, JSON.stringify(r.body)); ok('POST /calc ok -> 201');

r = await j(await call('GET', `/lookup?tail=${fpA}`, { key: KEY }));
assert(r.body.records.some(x => x.kind === 'calc' && x.address_hex === A && x.source === 'calculator'));
ok('lookup by tail finds the fresh calc record');
r = await j(await call('GET', `/lookup?address=${A}`, { key: KEY }));
assert(r.body.records.some(x => x.kind === 'calc'));
ok('lookup by address finds the fresh calc record');
const stored = db.rows.find(x => x.kind === 'calc' && x.address_hex === A);
assert(stored.ip_hash && !stored.ip_hash.includes('198.51.100.1') && stored.ip_hash.length === 64);
ok('ip stored as sha256 hash only');

// --- POST /calc: trac1 spelling of the same address files under the hex
r = await j(await call('POST', '/calc', { body: {
  address: encodeTracAddress(A), planned_units: '2000000', fp_units: String(fpA),
  exact_units: String(2000000 + fpA), status: 'ok' } }));
assert.equal(r.status, 201, JSON.stringify(r.body));
ok('POST /calc with trac1 address -> 201, normalized to hex');

// --- POST /calc: blocked_pool (pool address itself, as in the 661039 case)
const fpPool = fingerprint(POOL); assert.equal(fpPool, 661039);
r = await j(await call('POST', '/calc', { body: { address: POOL, status: 'blocked_pool' } }));
assert.equal(r.status, 201, JSON.stringify(r.body));
const blocked = db.rows.find(x => x.kind === 'calc_blocked');
assert(blocked && blocked.address_hex === POOL && blocked.fp_units === '661039');
ok('POST /calc blocked_pool -> filed as calc_blocked with the pool fingerprint');

// --- POST /calc: invalid attempt (unparseable address) still diagnosable
r = await j(await call('POST', '/calc', { body: { address: 'not-an-address', status: 'invalid' } }));
assert.equal(r.status, 201, JSON.stringify(r.body));
assert(db.rows.some(x => x.kind === 'calc' && x.status === 'invalid' && x.address_hex === null));
ok('POST /calc status=invalid with garbage address -> filed with NULL address');

// --- POST /calc: rejections
r = await j(await call('POST', '/calc', { body: {
  address: A, planned_units: '5000000', fp_units: String(fpA === 999999 ? 1 : fpA + 1),
  exact_units: '5000000', status: 'ok' } }));
assert.equal(r.status, 400); ok('POST /calc with wrong fingerprint -> 400 rejected');
r = await j(await call('POST', '/calc', { body: {
  address: A, planned_units: '5000000', fp_units: String(fpA),
  exact_units: String(5000000 + fpA + 7), status: 'ok' } }));
assert.equal(r.status, 400); ok('POST /calc with exact != planned + fp -> 400 rejected');
r = await j(await call('POST', '/calc', { body: { address: 'zzzz', status: 'ok',
  planned_units: '1000000', fp_units: '1', exact_units: '1000001' } }));
assert.equal(r.status, 400); ok('POST /calc with invalid address (status ok) -> 400 rejected');
r = await j(await call('POST', '/calc', { body: {
  address: A, planned_units: '5000001', fp_units: String(fpA),
  exact_units: String(5000001 + fpA), status: 'ok' } }));
assert.equal(r.status, 400); ok('POST /calc with non-0.01-multiple planned -> 400 rejected');
r = await j(await call('POST', '/calc', { body: { address: A, status: 'ok' } }));
assert.equal(r.status, 400); ok('POST /calc ok without amounts -> 400 rejected');

// --- calc TTL: 30-minute expiry; fulfilled + historical facts exempt
const oldTs = new Date(Date.now() - 31 * 60 * 1000).toISOString();
const C1 = 'cc'.repeat(32), C2 = 'dd'.repeat(32), C3 = 'ee'.repeat(32), C4 = 'ff'.repeat(32);
db.seed([
  { ts: oldTs, kind: 'calc', address_hex: C1, planned_units: '1000000', fp_units: '111111', exact_units: '1111111', status: 'ok', source: 'calculator' },
  { ts: oldTs, kind: 'calc', address_hex: C2, planned_units: '1000000', fp_units: '222222', exact_units: '1222222', status: 'fulfilled', source: 'calculator' },
  { ts: oldTs, kind: 'import', address_hex: C3, planned_units: null, fp_units: '333333', exact_units: '1000000', status: 'credited', source: 'operator' },
  { ts: oldTs, kind: 'unclaimed', address_hex: null, planned_units: null, fp_units: '444444', exact_units: '1444444', status: 'open', source: 'matcher' },
]);
r = await j(await call('POST', '/sweep'));
assert.equal(r.status, 401); ok('sweep without operator key -> 401');
r = await j(await call('POST', '/sweep', { key: KEY }));
assert.equal(r.status, 200); assert.equal(r.body.deleted, 1, JSON.stringify(r.body));
assert(!db.rows.some(x => x.address_hex === C1));
assert(db.rows.some(x => x.address_hex === C2 && x.status === 'fulfilled'));
assert(db.rows.some(x => x.kind === 'import' && x.address_hex === C3));
assert(db.rows.some(x => x.kind === 'unclaimed' && x.fp_units === '444444'));
ok('sweep deletes only the expired unfulfilled calc; fulfilled/import/unclaimed survive');

// fulfill by address: file a fresh calc for B, mark it, age it, sweep keeps it
const fpB = fingerprint(B);
r = await j(await call('POST', '/calc', { body: { address: B, planned_units: '1000000',
  fp_units: String(fpB), exact_units: String(1000000 + fpB), status: 'ok' } }));
assert.equal(r.status, 201, JSON.stringify(r.body));
r = await j(await call('POST', '/fulfill', { body: { address: B } }));
assert.equal(r.status, 401); ok('fulfill without operator key -> 401');
r = await j(await call('POST', '/fulfill', { key: KEY, body: { address: B } }));
assert.equal(r.status, 200); assert.equal(r.body.updated, 1, JSON.stringify(r.body));
const rowB = db.rows.find(x => x.kind === 'calc' && x.address_hex === B);
assert.equal(rowB.status, 'fulfilled');
rowB.ts = oldTs; // age it past the TTL artificially
r = await j(await call('POST', '/sweep', { key: KEY }));
assert(db.rows.includes(rowB));
ok('fulfill by address marks the calc; an aged fulfilled record survives sweep');

// fulfill by tail (marks the happy-path calcs filed for A earlier)
r = await j(await call('POST', '/fulfill', { key: KEY, body: { tail: String(fpA) } }));
assert.equal(r.status, 200); assert(r.body.updated >= 1, JSON.stringify(r.body));
assert(db.rows.some(x => x.kind === 'calc' && x.address_hex === A && x.status === 'fulfilled'));
ok('fulfill by tail marks matching calc records');
r = await j(await call('POST', '/fulfill', { key: KEY, body: {} }));
assert.equal(r.status, 400); ok('fulfill with neither tail nor address -> 400');
r = await j(await call('POST', '/fulfill', { key: KEY, body: { address: 'junk' } }));
assert.equal(r.status, 400); ok('fulfill with unparseable address -> 400');

// --- hold: freeze a parked entry's calc evidence past the TTL
const H1 = 'ab'.repeat(32), fpH1 = fingerprint(H1);
r = await j(await call('POST', '/calc', { body: { address: H1, planned_units: '2000000',
  fp_units: String(fpH1), exact_units: String(2000000 + fpH1), status: 'ok' } }));
assert.equal(r.status, 201, JSON.stringify(r.body));
const exactH1 = String(2000000 + fpH1);
r = await j(await call('POST', '/hold', { body: { tail: String(fpH1), exact_units: exactH1 } }));
assert.equal(r.status, 401); ok('hold without operator key -> 401');
r = await j(await call('POST', '/hold', { key: KEY, body: { tail: String(fpH1) } }));
assert.equal(r.status, 400); ok('hold without exact_units -> 400');
r = await j(await call('POST', '/hold', { key: KEY, body: { tail: '1000000', exact_units: exactH1 } }));
assert.equal(r.status, 400); ok('hold with out-of-range tail -> 400');
r = await j(await call('POST', '/hold', { key: KEY, body: { tail: String(fpH1), exact_units: '999999999' } }));
assert.equal(r.status, 200); assert.equal(r.body.updated, 0, JSON.stringify(r.body));
ok('hold with a non-matching exact -> updated 0, no error');
r = await j(await call('POST', '/hold', { key: KEY, body: { tail: String(fpH1), exact_units: exactH1 } }));
assert.equal(r.status, 200); assert.equal(r.body.updated, 1, JSON.stringify(r.body));
const rowH1 = db.rows.find(x => x.kind === 'calc' && x.address_hex === H1);
assert.equal(rowH1.status, 'held'); ok('hold moves the exact (tail, exact) calc ok -> held');
r = await j(await call('POST', '/hold', { key: KEY, body: { tail: String(fpH1), exact_units: exactH1 } }));
assert.equal(r.status, 200); assert.equal(r.body.updated, 0, JSON.stringify(r.body));
ok('re-holding an already-held record is idempotent (updated 0)');
rowH1.ts = oldTs; // age the held record well past the TTL
r = await j(await call('POST', '/sweep', { key: KEY }));
assert(db.rows.includes(rowH1) && rowH1.status === 'held');
ok('an aged held record survives the sweep (evidence freeze)');
r = await j(await call('POST', '/fulfill', { key: KEY, body: { tail: String(fpH1), address: H1 } }));
assert.equal(r.status, 200); assert.equal(r.body.updated, 1, JSON.stringify(r.body));
assert.equal(rowH1.status, 'fulfilled');
ok('fulfill closes out an aged held record (held is exempt from the fulfill TTL too)');
r = await j(await call('POST', '/hold', { key: KEY, body: { tail: String(fpH1), exact_units: exactH1 } }));
assert.equal(r.status, 200); assert.equal(r.body.updated, 0, JSON.stringify(r.body));
ok('holding a fulfilled record does not resurrect it (updated 0)');

// opportunistic sweep: filing any new calc clears expired intentions
db.seed([{ ts: oldTs, kind: 'calc', address_hex: C4, planned_units: '1000000', fp_units: '555555', exact_units: '1555555', status: 'ok', source: 'calculator' }]);
r = await j(await call('POST', '/calc', { body: { address: 'junk-opp', status: 'invalid' } }));
assert.equal(r.status, 201);
assert(!db.rows.some(x => x.address_hex === C4));
ok('POST /calc opportunistically sweeps expired calc records');

// --- rate limit: 30/min per IP, the 31st is refused
const ip = '203.0.113.99';
for (let i = 0; i < 30; i++) {
  const rr = await j(await call('POST', '/calc', { body: { address: 'junk' + i, status: 'invalid' }, ip }));
  assert.equal(rr.status, 201);
}
r = await j(await call('POST', '/calc', { body: { address: 'junk', status: 'invalid' }, ip }));
assert.equal(r.status, 429); ok('rate limit: 31st POST from one IP within a minute -> 429');

// --- POST /exit: signed-message exit intent (no transfer, no balance) ---
r = await j(await call('POST', '/exit', { body: { address: 'not-an-address' } }));
assert.equal(r.status, 400); ok('POST /exit with garbage address -> 400');
r = await j(await call('POST', '/exit', { body: { address: A } }));
assert.equal(r.status, 201, JSON.stringify(r.body));
const intent = r.body.exit;
assert.equal(intent.address_hex, A);
assert.match(intent.nonce, /^[0-9a-f]{16}$/);
assert.equal(intent.prepared.v, 1); assert.equal(intent.prepared.kind, 'agent');
assert.equal(intent.prepared.addr, A); assert.equal(intent.prepared.nonce, intent.nonce);
assert(intent.prepared.text.includes(POOL) && intent.prepared.text.includes(A) && intent.prepared.text.includes(intent.nonce));
assert(intent.signing_text.startsWith('reset-chat/v1\n'));
ok('POST /exit issues a prepared agent message (pool + member + nonce in the text)');
r = await j(await call('POST', '/exit', { body: { address: encodeTracAddress(A) } }));
assert.equal(r.status, 200); assert.equal(r.body.reused, true); assert.equal(r.body.exit.nonce, intent.nonce);
ok('POST /exit again (trac1 spelling) returns the SAME live intent — one nonce per member');
// verify: tampered prepared is refused before the nonce is touched
const tampered = { ...intent.prepared, text: intent.prepared.text.replace('EXIT', 'EXIT!') };
r = await j(await call('POST', '/exit/verify', { body: { prepared: tampered, signature: 'cd'.repeat(64), nonce: intent.nonce } }));
assert.equal(r.status, 400); ok('POST /exit/verify with an altered prepared text -> 400 (must sign the issued object)');
// verify: happy path stores the submission and burns the nonce
r = await j(await call('POST', '/exit/verify', { body: { prepared: intent.prepared, signature: 'cd'.repeat(64), nonce: intent.nonce } }));
assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.status, 'submitted');
ok('POST /exit/verify with the exact issued prepared -> submitted');
r = await j(await call('POST', '/exit/verify', { body: { prepared: intent.prepared, signature: 'cd'.repeat(64), nonce: intent.nonce } }));
assert.equal(r.status, 409); ok('POST /exit/verify replaying the same nonce -> 409 (nonce is single-use)');
r = await j(await call('POST', '/exit', { body: { address: A } }));
assert.equal(r.status, 409); ok('POST /exit while a submission awaits verification -> 409');
// operator queue + resolve
r = await j(await call('GET', '/exit/pending'));
assert.equal(r.status, 401); ok('GET /exit/pending without operator key -> 401');
r = await j(await call('GET', '/exit/pending', { key: KEY }));
assert.equal(r.status, 200);
const sub = r.body.submissions.find(s => s.address_hex === A);
assert(sub && sub.signature === 'cd'.repeat(64) && sub.prepared.nonce === intent.nonce && sub.submitted_at);
ok('GET /exit/pending lists the submission with prepared + signature for pool-side verify');
r = await j(await call('POST', '/exit/resolve', { key: KEY, body: { id: sub.id, result: 'verified', note: 'exit-test-001' } }));
assert.equal(r.status, 200); assert.equal(r.body.updated, 1);
assert.equal(db.rows.find(x => x.id === sub.id).status, 'verified');
ok('POST /exit/resolve records the pool-side verdict (verified, case id as note)');
r = await j(await call('POST', '/exit', { body: { address: A } }));
assert.equal(r.status, 409); ok('POST /exit after verification -> 409 (a case is already open)');
// expiry: an intent never submitted dies with the sweep; verified never does
const oldExitTs = new Date(Date.now() - 31 * 60 * 1000).toISOString();
db.seed([
  { ts: oldExitTs, kind: 'exit_request', address_hex: C1, planned_units: null, fp_units: null, exact_units: null, status: 'pending', source: 'exit', nonce: 'aaaaaaaabbbbbbbb', payload: '{}' },
  { ts: oldExitTs, kind: 'exit_request', address_hex: C2, planned_units: null, fp_units: null, exact_units: null, status: 'verified', source: 'exit', nonce: 'ccccccccdddddddd', payload: '{}' },
]);
r = await j(await call('POST', '/sweep', { key: KEY }));
assert(!db.rows.some(x => x.nonce === 'aaaaaaaabbbbbbbb'));
assert(db.rows.some(x => x.nonce === 'ccccccccdddddddd' && x.status === 'verified'));
ok('sweep deletes only the expired unsubmitted exit intent; a verified one survives');
// an expired intent cannot be verified even while its row still exists
const expNonce = 'eeeeeeeeffffffff';
const expPrepared = { v: 1, kind: 'agent', addr: C3, text: 'x', ts: Date.now() - 31 * 60 * 1000, nonce: expNonce };
db.seed([{ ts: oldExitTs, kind: 'exit_request', address_hex: C3, planned_units: null, fp_units: null, exact_units: null,
  status: 'pending', source: 'exit', nonce: expNonce, payload: JSON.stringify({ prepared: expPrepared }) }]);
r = await j(await call('POST', '/exit/verify', { body: { prepared: expPrepared, signature: 'cd'.repeat(64), nonce: expNonce } }));
assert.equal(r.status, 410); ok('POST /exit/verify against an expired intent -> 410');

console.log(`\nworker/test-local: all ${n} checks passed`);

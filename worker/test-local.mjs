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
// Supports exactly: INSERT INTO records (cols) VALUES (?,...),
// SELECT COUNT(*) [WHERE ip_hash = ? AND ts >= ?],
// SELECT * FROM records WHERE <col> = ? ORDER BY ts, id.
class MockStmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.params = []; }
  bind(...p) { this.params = p; return this; }
  async run() {
    const m = this.sql.match(/INSERT INTO records \(([^)]+)\)\s+VALUES \(([^)]+)\)/);
    assert(m, `mock: unsupported run SQL: ${this.sql}`);
    const cols = m[1].split(',').map(s => s.trim());
    const row = { id: this.db.nextId++ };
    cols.forEach((c, i) => { row[c] = this.params[i] ?? null; });
    this.db.rows.push(row);
    return { meta: { last_row_id: row.id } };
  }
  async first() {
    const m = this.sql.match(/SELECT COUNT\(\*\) AS n FROM records(?: WHERE ip_hash = \? AND ts >= \?)?/);
    assert(m, `mock: unsupported first SQL: ${this.sql}`);
    let rows = this.db.rows;
    if (this.params.length === 2) rows = rows.filter(r => r.ip_hash === this.params[0] && r.ts >= this.params[1]);
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

// --- rate limit: 30/min per IP, the 31st is refused
const ip = '203.0.113.99';
for (let i = 0; i < 30; i++) {
  const rr = await j(await call('POST', '/calc', { body: { address: 'junk' + i, status: 'invalid' }, ip }));
  assert.equal(rr.status, 201);
}
r = await j(await call('POST', '/calc', { body: { address: 'junk', status: 'invalid' }, ip }));
assert.equal(r.status, 429); ok('rate limit: 31st POST from one IP within a minute -> 429');

console.log(`\nworker/test-local: all ${n} checks passed`);

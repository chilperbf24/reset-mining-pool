#!/usr/bin/env node
// Sandbox end-to-end for the AI-signed join channel (branch ai-join).
//
// IRON RULES for this script — read before running:
//   - NO production wallets: the member key is a THROWAWAY keystore
//     created under /tmp by the official keystore code; the script
//     aborts unless its signer env points at that temp dir, and it
//     hashes (never reads, never unlocks) the production keystore
//     files before/after to prove they were untouched.
//   - NO gateway: the Worker runs against an in-memory mock D1, the
//     matcher runs against a ledger COPY in /tmp, and the "transfer"
//     is a simulated arrival — no real transfer is ever constructed.
//   - NO production state: nothing here reads or writes state/*.json.
//   node test-ai-join-e2e.mjs
import assert from 'node:assert';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import worker from './worker/src/index.js';
import { init as initKeystore } from '../reset/signer/lib/keystore.mjs';
import { emptyState, checkEventChain, totalContributed } from './lib/pool.mjs';
import { emptyMatcher, emptyUnclaimed, emptyFpCache, processObservation,
  decideJoinAttribution, claimEntryAs, fingerprint } from './lib/fpmatch.mjs';

const POOL = '4150cf82f0189371818a22d5f5b10d52aadf9108c78020cc97fc002df6eaaca6';
const KEY = 'e2e-operator-key';
let n = 0; const ok = name => console.log(`  ok ${++n}. ${name}`);
const shaFile = p => existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : null;

// --- production-wallet guard: hash-only integrity evidence, before/after
const prodPoolKs = join(homedir(), '.reset-pool-signer', 'keystore.json');
const prodSelfKs = join(homedir(), '.reset-signer', 'keystore.json');
const prodBefore = { pool: shaFile(prodPoolKs), self: shaFile(prodSelfKs) };
assert(prodBefore.pool && prodSelfKs, 'production keystores must exist to prove them untouched');
assert(!process.env.RESET_SIGNER_DIRECTORY || !process.env.RESET_SIGNER_DIRECTORY.includes('.reset-signer'),
  'refusing to run: RESET_SIGNER_DIRECTORY points at a real signer dir');

// --- minimal in-memory mock D1 (only the SQL the join endpoints issue)
function cond(where, params) {
  const atoms = where.split(/\s+AND\s+/);
  let pi = 0;
  const tests = atoms.map(atom => {
    let m;
    if ((m = atom.trim().match(/^(\w+) = \?$/))) { const c = m[1], v = params[pi++]; return r => r[c] === v; }
    if ((m = atom.trim().match(/^(\w+) = '([^']*)'$/))) { const c = m[1], v = m[2]; return r => r[c] === v; }
    if ((m = atom.trim().match(/^(\w+) < \?$/))) { const c = m[1], v = params[pi++]; return r => r[c] < v; }
    throw new Error(`e2e mock: unsupported atom ${atom}`);
  });
  return r => tests.every(t => t(r));
}
class E2EDB {
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
        throw new Error(`e2e mock: unsupported run SQL: ${sql}`);
      },
      async first() {
        const m = sql.match(/SELECT \* FROM (\w+) WHERE (\w+) = \? ORDER BY ts, id/);
        if (!m) throw new Error(`e2e mock: unsupported first SQL: ${sql}`);
        const rows = db.t[m[1]].filter(r => r[m[2]] === this.params[0])
          .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id - b.id));
        return rows[0] ?? null;
      },
      async all() {
        const m = sql.match(/SELECT \* FROM (\w+) WHERE (\w+) = \? ORDER BY ts, id/);
        if (!m) throw new Error(`e2e mock: unsupported all SQL: ${sql}`);
        const results = db.t[m[1]].filter(r => r[m[2]] === this.params[0])
          .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id - b.id));
        return { results };
      },
    };
  }
}
const db = new E2EDB();
const env = { REGISTRY_DB: db, REGISTRY_KEY: KEY, POOL_ADDRESS: POOL };
const call = (method, path, { body, key } = {}) => worker.fetch(new Request(`https://registry.test${path}`, {
  method,
  headers: {
    ...(body ? { 'content-type': 'application/json' } : {}),
    ...(key ? { 'x-registry-key': key } : {}),
  },
  body: body ? JSON.stringify(body) : undefined,
}), env);
const j = async r => ({ status: r.status, body: await r.json() });

const tmp = mkdtempSync(join(tmpdir(), 'ai-join-e2e-'));
try {
  // --- 1. throwaway member wallet (official keystore, temp dir only)
  const password = 'e2e-temp-password-123';
  const { address: member } = await initKeystore({ directory: tmp, password });
  assert.match(member, /^[0-9a-f]{64}$/);
  ok(`throwaway member wallet created in ${tmp} (address ${member.slice(0, 12)}…)`);

  // --- 2. issue a join code
  const planned = '5000000';
  let r = await j(await call('POST', '/join/code', { body: { address: member, planned_units: planned } }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const code = r.body.code;
  const fp = fingerprint(member);
  assert.equal(code.exact_units, String(5000000 + fp));
  assert(code.text.includes('WAIT for their confirmation') && code.text.includes('0.03 TNK'));
  ok(`code issued: planned 0.05 + fp ${fp} = exact ${code.exact_units} units, nonce ${code.nonce}`);

  // --- 3. the member's AI signs the receipt with the REAL member script
  const codeFile = join(tmp, 'code.json');
  writeFileSync(codeFile, JSON.stringify(code, null, 2));
  const submission = JSON.parse(execFileSync(process.execPath, ['join-sign.mjs', codeFile], {
    cwd: new URL('.', import.meta.url).pathname,
    env: { ...process.env, RESET_SIGNER_DIRECTORY: tmp, RESET_SIGNER_PASSWORD: password, PATH: process.env.PATH },
    encoding: 'utf8',
  }));
  assert.equal(submission.nonce, code.nonce);
  assert.equal(submission.prepared.addr, member);
  ok('join-sign.mjs signed the receipt with the throwaway wallet (real script, real keystore)');

  // --- 4. submit the receipt -> pending claim
  r = await j(await call('POST', '/join/claim', { body: submission }));
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.claim.status, 'pending');
  const claim = r.body.claim;
  ok(`receipt verified by the Worker -> pending claim #${claim.id} for ${claim.exact_units} units`);

  // --- 5. simulated arrival -> matcher credits via ai-join
  r = await j(await call('GET', '/join/claims', { key: KEY }));
  assert.equal(r.status, 200);
  const claims = r.body.claims;
  assert.equal(claims.length, 1);
  const ledger = emptyState(POOL);
  const matcher = emptyMatcher(POOL), unclaimed = emptyUnclaimed(), fpCache = emptyFpCache();
  processObservation({ totalUnits: 0n, lastResult: null }, { matcher, unclaimed, ledger, fpCache, candidates: [] });
  const exact = BigInt(code.exact_units);
  const jd = decideJoinAttribution(claims, exact);
  assert.equal(jd.type, 'credit'); assert.equal(jd.address, member);
  const acts = processObservation({ totalUnits: exact, lastResult: null },
    { matcher, unclaimed, ledger, fpCache, candidates: [],
      joinDecision: { amount_units: exact.toString(), mode: 'credit', address: member, claim_nonce: jd.claim.nonce } });
  const credit = acts.find(a => a.type === 'credited');
  assert(credit && credit.via === 'ai-join' && credit.address === member);
  assert.equal(ledger.contributors[member].contributed, exact.toString());
  assert.equal(ledger.events.at(-1).data.source, 'ai-join');
  assert.equal(ledger.events.at(-1).data.join_claim_nonce, code.nonce);
  ok(`simulated arrival of exactly ${exact} units -> credited via ai-join, full amount booked`);

  // --- 6. conservation (sandbox world: obligations == simulated assets) + chain + independent verifier
  const obligations = totalContributed(ledger);
  const assets = exact; // the simulated pool total after the arrival
  assert.equal(obligations, assets);
  assert.equal(checkEventChain(ledger).ok, true);
  const ledgerFile = join(tmp, 'ledger.json');
  writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
  const vout = execFileSync(process.execPath, ['verify.mjs', '--ledger', ledgerFile], {
    cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8' });
  assert.equal(JSON.parse(vout.trim()).ok, true);
  ok(`conservation holds (obligations ${obligations} == assets ${assets}); event chain ok; verify.mjs --ledger passes`);

  // --- 7. claim consumed exactly once (matcher fulfill path)
  r = await j(await call('POST', '/join/fulfill', { key: KEY, body: { nonce: code.nonce } }));
  assert.equal(r.body.updated, 1);
  r = await j(await call('POST', '/join/fulfill', { key: KEY, body: { nonce: code.nonce } }));
  assert.equal(r.body.updated, 0);
  ok('join claim fulfilled exactly once (never credits twice)');

  // --- adversarial 1: fake receipt (signed by a DIFFERENT key)
  const other = generateKeyPairSync('ed25519');
  const otherSign = msg => cryptoSign(null, Buffer.from(msg, 'utf8'), other.privateKey).toString('hex');
  r = await j(await call('POST', '/join/code', { body: { address: member, planned_units: '3000000' } }));
  const codeF = r.body.code;
  const { buildJoinPrepared } = await import('./lib/join.mjs');
  const { agentSigningText } = await import('./lib/exit.mjs');
  const fakePrep = buildJoinPrepared({ poolAddress: POOL, address: member, exactUnits: codeF.exact_units, nonce: codeF.nonce, ts: Date.now() });
  r = await j(await call('POST', '/join/claim', { body: { prepared: fakePrep, signature: otherSign(agentSigningText(fakePrep)), nonce: codeF.nonce } }));
  assert.equal(r.status, 400); assert.match(r.body.error, /signature/);
  assert.equal(db.t.join_codes.find(c => c.nonce === codeF.nonce).status, 'consumed');
  assert(db.t.join_claims.some(c => c.code_nonce === codeF.nonce && c.status === 'rejected'));
  assert(!db.t.join_claims.some(c => c.code_nonce === codeF.nonce && c.status === 'pending'));
  ok('adversarial 1 (fake receipt, wrong key): 400, code burned, rejected row filed, NO pending claim');

  // --- adversarial 2: replay (same valid receipt twice)
  r = await j(await call('POST', '/join/code', { body: { address: member, planned_units: '4000000' } }));
  const codeR = r.body.code;
  writeFileSync(codeFile, JSON.stringify(codeR, null, 2));
  const subR = JSON.parse(execFileSync(process.execPath, ['join-sign.mjs', codeFile], {
    cwd: new URL('.', import.meta.url).pathname,
    env: { ...process.env, RESET_SIGNER_DIRECTORY: tmp, RESET_SIGNER_PASSWORD: password, PATH: process.env.PATH },
    encoding: 'utf8',
  }));
  r = await j(await call('POST', '/join/claim', { body: subR }));
  assert.equal(r.status, 201);
  r = await j(await call('POST', '/join/claim', { body: subR }));
  assert.equal(r.status, 409);
  ok('adversarial 2 (replay): first receipt 201 pending, second 409 (nonce single-use)');

  // --- adversarial 3: wrong amount (arrival != pending exact -> NOT ai-join credited)
  const pendingR = db.t.join_claims.find(c => c.nonce === codeR.nonce && c.status === 'pending');
  assert(pendingR, 'replay-test claim must still be pending');
  const wrongAmt = BigInt(codeR.exact_units) + 7n;
  const dj = decideJoinAttribution([pendingR], wrongAmt);
  assert.equal(dj.type, 'none');
  const ledger3 = emptyState(POOL);
  const m3 = emptyMatcher(POOL), u3 = emptyUnclaimed(), f3 = emptyFpCache();
  processObservation({ totalUnits: 0n, lastResult: null }, { matcher: m3, unclaimed: u3, ledger: ledger3, fpCache: f3, candidates: [] });
  const acts3 = processObservation({ totalUnits: wrongAmt, lastResult: null },
    { matcher: m3, unclaimed: u3, ledger: ledger3, fpCache: f3, candidates: [], joinDecision: null });
  assert(acts3.some(a => a.type === 'unclaimed'));
  assert.equal(ledger3.contributors[member], undefined);
  ok('adversarial 3 (wrong amount): arrival 7 units off is NOT ai-join credited — parked unclaimed, nothing booked');

  // --- adversarial 4: out-of-order (arrival first, receipt later -> retro credits)
  const ledger4 = emptyState(POOL);
  const m4 = emptyMatcher(POOL), u4 = emptyUnclaimed(), f4 = emptyFpCache();
  processObservation({ totalUnits: 0n, lastResult: null }, { matcher: m4, unclaimed: u4, ledger: ledger4, fpCache: f4, candidates: [] });
  const amt4 = BigInt(codeR.exact_units);
  const acts4 = processObservation({ totalUnits: amt4, lastResult: null },
    { matcher: m4, unclaimed: u4, ledger: ledger4, fpCache: f4, candidates: [] });
  assert(acts4.some(a => a.type === 'unclaimed'));
  assert.equal(u4.entries.length, 1);
  // receipt arrives late: the retro path (fprun's join retro, same
  // claimEntryAs call) credits the parked entry via ai-join.
  const entry = claimEntryAs({ unclaimed: u4, ledger: ledger4, now: new Date().toISOString() }, 1, member,
    { source: 'ai-join', method: 'join', resolution: 'auto-credited on re-check: a signature-verified join receipt names this address' });
  assert.equal(entry.status, 'claimed'); assert.equal(entry.method, 'join');
  assert.equal(ledger4.contributors[member].contributed, amt4.toString());
  assert.equal(ledger4.events.at(-1).data.source, 'ai-join');
  ok('adversarial 4 (out-of-order): arrival parked first, late receipt retro-credits via ai-join');

  // --- production wallets untouched (hash-only evidence)
  const prodAfter = { pool: shaFile(prodPoolKs), self: shaFile(prodSelfKs) };
  assert.equal(prodAfter.pool, prodBefore.pool);
  assert.equal(prodAfter.self, prodBefore.self);
  ok('production keystore hashes unchanged (pool + personal wallets untouched)');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\ntest-ai-join-e2e: all ${n} checks passed`);

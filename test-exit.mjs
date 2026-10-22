#!/usr/bin/env node
// Exit-mechanism tests: signature cryptography end-to-end (with the POOL
// wallet's own key, via the official signer keystore code and cross-checked
// against the real trac-wallet + the official chat module), the registry
// intake, and the executor state machine against a fake chain.
//   node test-exit.mjs
// Read-only with respect to the outside world: it signs one exit statement
// with the pool key (never submitted anywhere) and otherwise works on
// in-memory states only.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { emptyState, addContribution, settleRound, parseCoin, formatCoin, checkConservation } from './lib/pool.mjs';
import { buildPrepared, agentSigningText, stableJSON, verifyExitSubmission, ed25519Verify, exitText } from './lib/exit.mjs';
import { intakeExitSubmissions, advanceExitCases, runExitPass, emptyExits, ARMED } from './lib/exit-exec.mjs';
import { unlock, wipeWallet, publicAddress } from '../reset/signer/lib/keystore.mjs';
import { stableJSON as officialStableJSON } from '../reset/contract/rules/json.js';
import { checkText } from '../reset/features/chat/text.js';

// The official agentSigningText (features/chat/index.js) is one line —
// CHAT_DOMAIN + stableJSON of the six fields — composed here from the
// official stableJSON so byte-equality is checked against the real code
// without importing the chat module (its trac-wallet@1.0.1 has no ESM
// default export under plain Node). The cross-implementation verify below
// uses the signer's trac-wallet@2.1.0 — the same library the gateway's
// peer.wallet is an instance of.
const officialSigningText = ({ v, kind, addr, text, ts, nonce }) =>
  'reset-chat/v1\n' + officialStableJSON({ v, kind, addr, text, ts, nonce });
const { Verifier } = await import(new URL('../reset/signer/node_modules/trac-wallet/dist/index.js', import.meta.url));

const POOL = '4150cf82f0189371818a22d5f5b10d52aadf9108c78020cc97fc002df6eaaca6';
let n = 0; const ok = name => console.log(`  ok ${++n}. ${name}`);

// ------------------------------------------------------------ crypto e2e
// Sign with the pool wallet itself (the exact key a member's signer holds
// for their own address), verify with three independent implementations.
const pw = readFileSync(`${process.env.HOME}/.reset-pool-signer/.wallet-password`, 'utf8').trim();
const wallet = await unlock({ directory: `${process.env.HOME}/.reset-pool-signer`, password: pw });
assert.equal(publicAddress(wallet), POOL);
const nonce = '0123456789abcdef';
const prepared = buildPrepared({ poolAddress: POOL, address: POOL, nonce, ts: 1760000000000 });

// byte-for-byte equality with the official constructions
assert.equal(stableJSON(prepared), officialStableJSON(prepared));
assert.equal(agentSigningText(prepared), officialSigningText(prepared));
assert.equal(checkText(prepared.text), null); // the statement passes the chat text rules
ok('signing text is byte-identical to the official agentSigningText; the text passes checkText');

const signingText = agentSigningText(prepared);
const sigBytes = wallet.sign(Buffer.from(signingText, 'utf8'));
const signature = Buffer.from(sigBytes).toString('hex');
assert.equal(signature.length, 128);
wipeWallet(wallet);

assert.equal(ed25519Verify(signingText, signature, POOL), true);
ok('pool-side verify (node:crypto): the pool wallet signature verifies');
assert.equal(new Verifier(Buffer.from(POOL, 'hex')).verify(Buffer.from(signature, 'hex'), Buffer.from(signingText, 'utf8')), true);
ok("trac-wallet Verifier (the library behind the gateway's wallet.verify): verifies too");

const intent = { address: POOL, nonce, prepared, issuedAtMs: prepared.ts };
const base = { poolAddress: POOL, intent, prepared, signature, nonce, submittedAtMs: prepared.ts + 60000, nowMs: prepared.ts + 120000 };
assert.deepEqual(verifyExitSubmission(base), { ok: true });
ok('verifyExitSubmission: the genuine submission passes end to end');

const tampered = { ...prepared, text: prepared.text.replace('EXIT', 'EXIT!') };
assert.equal(ed25519Verify(agentSigningText(tampered), signature, POOL), false);
assert.equal(verifyExitSubmission({ ...base, prepared: tampered }).ok, false);
ok('one altered character in the text -> signature invalid, submission rejected');

const OTHER = '1f1613f19eff94f3adc79f8d48f8b186368b6c44b31905355cfe9bdee98a001d';
assert.equal(ed25519Verify(signingText, signature, OTHER), false);
assert.equal(verifyExitSubmission({ ...base, prepared: { ...prepared, addr: OTHER } }).error, 'address');
ok('the same signature claimed under a different address -> rejected');

assert.equal(verifyExitSubmission({ ...base, submittedAtMs: prepared.ts + 31 * 60 * 1000 }).error, 'expired');
assert.equal(verifyExitSubmission({ ...base, nonce: 'fedcba9876543210' }).error, 'nonce');
ok('expired intent and wrong nonce -> rejected (replay of a burned nonce fails at the registry too)');

// ------------------------------------------------------------ intake
function fakeRegistry(rows) {
  const resolved = [];
  return { resolved,
    pendingSubmissions: async () => rows,
    resolve: async (id, result, note) => { resolved.push({ id, result, note }); return true; } };
}
const rowFor = (id, sig = signature, prep = prepared) => ({ id, address_hex: POOL, nonce,
  ts: new Date(prepared.ts).toISOString(), prepared: prep, signature: sig,
  submitted_at: new Date(prepared.ts + 60000).toISOString() });
{
  // pool address HAS a position in this ledger -> a case opens
  const ledger = emptyState(POOL);
  addContribution(ledger, POOL, parseCoin('0.03'));
  addContribution(ledger, OTHER, parseCoin('0.2'));
  const exits = emptyExits();
  const reg = fakeRegistry([rowFor(1)]);
  const acts = await intakeExitSubmissions({ ledger, exits, registry: reg, now: () => prepared.ts + 120000 });
  assert.equal(acts.filter(a => a.type === 'exit_verified').length, 1);
  assert.equal(exits.cases.length, 1);
  assert.equal(exits.cases[0].status, 'verified');
  assert.equal(exits.cases[0].address, POOL);
  assert.deepEqual(reg.resolved, [{ id: 1, result: 'verified', note: exits.cases[0].id }]);
  assert.equal(ledger.events.at(-1).type, 'exit_verified');
  ok('intake: a valid signed request from a position holder opens a case');
  // the same row delivered again (a failed resolve retried) opens nothing twice
  const reg2 = fakeRegistry([rowFor(1)]);
  await intakeExitSubmissions({ ledger, exits, registry: reg2, now: () => prepared.ts + 120000 });
  assert.equal(exits.cases.length, 1);
  ok('intake: re-delivery of the same registry row is a no-op (dedupe by registry id)');
}
{
  // valid signature, but the address holds NO position -> no case
  const ledger = emptyState(POOL);
  addContribution(ledger, OTHER, parseCoin('0.2'));
  const exits = emptyExits();
  const reg = fakeRegistry([rowFor(2)]);
  await intakeExitSubmissions({ ledger, exits, registry: reg, now: () => prepared.ts + 120000 });
  assert.equal(exits.cases.length, 0);
  assert.equal(exits.rejections.at(-1).reason, 'no_position');
  assert.equal(reg.resolved[0].result, 'rejected');
  ok('intake: verified signature without a ledger position opens NO case');
}
{
  // forged signature -> rejected, no case
  const ledger = emptyState(POOL);
  addContribution(ledger, POOL, parseCoin('0.03'));
  const exits = emptyExits();
  const bad = (signature[0] === '0' ? '1' : '0') + signature.slice(1);
  const reg = fakeRegistry([rowFor(3, bad)]);
  await intakeExitSubmissions({ ledger, exits, registry: reg, now: () => prepared.ts + 120000 });
  assert.equal(exits.cases.length, 0);
  assert.equal(exits.rejections.at(-1).reason, 'signature');
  ok('intake: a forged signature is rejected and opens nothing');
}

// ------------------------------------------------- executor vs fake chain
function fakeChain({ balance, deposit, counted = 1000 }) {
  const chain = { balance: BigInt(balance), deposit: BigInt(deposit), exits: [], counted,
    calls: [], transferError: null, unlockBehavior: null, hideNextPosition: false,
    async position() {
      const exits = this.hideNextPosition ? [] : this.exits.map(e => ({ ...e }));
      this.hideNextPosition = false;
      return { balance: this.balance, deposit: this.deposit, exits, counted: this.counted };
    },
    async unlock(amountCoin) {
      this.calls.push(['unlock', amountCoin]);
      if (this.unlockBehavior) return this.unlockBehavior(this, amountCoin);
      const amt = parseCoin(amountCoin);
      this.deposit -= amt;
      this.exits.push({ amount: amt.toString(), release: this.counted + 144 });
      return { outcome: 'ok' };
    },
    async withdraw() {
      this.calls.push(['withdraw']);
      const mature = this.exits.filter(e => Number(e.release) <= this.counted);
      const sum = mature.reduce((s, e) => s + BigInt(e.amount), 0n);
      this.exits = this.exits.filter(e => Number(e.release) > this.counted);
      this.balance += sum;
      return { outcome: 'ok' };
    },
    async transfer(to, amountCoin) {
      this.calls.push(['transfer', to, amountCoin]);
      if (this.transferError) return { outcome: 'rejected', message: this.transferError };
      this.balance -= parseCoin(amountCoin);
      return { outcome: 'ok' };
    } };
  return chain;
}
const X = 'aa'.repeat(32), Y = 'bb'.repeat(32);
const mkCase = (address, id) => ({ id, address, registry_id: null, nonce: null, status: 'verified',
  origin: 'member', dissolution: false, created_at: '2026-10-22T00:00:00.000Z', verified_at: '2026-10-22T00:00:00.000Z',
  principal_units: null, earnings_units: null, due_units: null, unlock: null, withdraw: null,
  paid_at: null, halt_reason: null, history: [] });
const fixedNow = () => Date.parse('2026-10-22T01:00:00.000Z');

{ // normal exit: due 0.08000800 -> unlock move is the 0.1 minimum
  const ledger = emptyState(POOL);
  addContribution(ledger, X, parseCoin('0.08'));
  addContribution(ledger, Y, parseCoin('0.15'));
  settleRound(ledger, { round: 1, claimAmountUnits: 2300n }); // X +800, Y +1500
  const exits = emptyExits(); exits.cases.push(mkCase(X, 'case-x'));
  const chain = fakeChain({ balance: 2300n, deposit: parseCoin('0.23') });
  await advanceExitCases({ ledger, exits, chain, now: fixedNow, armed: true });
  const c = exits.cases[0];
  assert.equal(c.status, 'waiting_maturity');
  assert.deepEqual(chain.calls, [['unlock', '0.10000000']]);
  assert.equal(c.due_units, '8000800');
  chain.counted += 144;
  await advanceExitCases({ ledger, exits, chain, now: fixedNow, armed: true });
  assert.equal(c.status, 'done');
  assert.deepEqual(chain.calls.map(x => x[0]), ['unlock', 'withdraw', 'transfer']);
  assert.equal(chain.calls[2][1], X); assert.equal(chain.calls[2][2], '0.08000800'); // paid to the member's own address only
  assert.equal(ledger.contributors[X].closed.total_units, '8000800');
  assert.equal(checkConservation(ledger).ok, true);
  ok('executor: normal exit flows unlock(0.1 min move) -> wait 144 -> withdraw -> transfer full due -> closed');
}
{ // dissolution: paying X would leave 0.049992 < 0.1 -> everyone is settled
  const ledger = emptyState(POOL);
  addContribution(ledger, X, parseCoin('0.08'));
  addContribution(ledger, Y, parseCoin('0.05'));
  settleRound(ledger, { round: 1, claimAmountUnits: 1300n }); // X +800, Y +500
  const exits = emptyExits(); exits.cases.push(mkCase(X, 'case-x'));
  const chain = fakeChain({ balance: 1300n, deposit: parseCoin('0.13') });
  await advanceExitCases({ ledger, exits, chain, now: fixedNow, armed: true });
  assert.equal(exits.cases.length, 2); // Y got an automatic dissolution case
  assert.equal(exits.dissolution.trigger_case_id, 'case-x');
  assert.deepEqual(chain.calls, [['unlock', '0.13000000']]); // the ENTIRE deposit
  chain.counted += 144;
  await advanceExitCases({ ledger, exits, chain, now: fixedNow, armed: true });
  assert(exits.cases.every(c => c.status === 'done'));
  assert.equal(ledger.contributors[X].closed.total_units, '8000800');
  assert.equal(ledger.contributors[Y].closed.total_units, '5000500');
  assert(ledger.dissolved && ledger.dissolved.trigger_case_id === 'case-x');
  assert.equal(chain.balance, 0n); // every unit paid out, none invented, none lost
  assert.equal(checkConservation(ledger).ok, true);
  ok('executor: breaching the 0.1 line escalates to full dissolution — all members settled, pool marked dissolved');
}
{ // Disarmed executor (armed: false passed explicitly — the module constant
  // itself was flipped to true at the 2026-10-22 gate opening): intake
  // works, no chain call is made.
  assert.equal(typeof ARMED, 'boolean');
  const ledger = emptyState(POOL);
  addContribution(ledger, X, parseCoin('0.08'));
  addContribution(ledger, Y, parseCoin('0.15'));
  const exits = emptyExits(); exits.cases.push(mkCase(X, 'case-x'));
  const chain = fakeChain({ balance: 0n, deposit: parseCoin('0.23') });
  const acts = await runExitPass({ ledger, exits, chain, registry: null, now: fixedNow, armed: false });
  assert.equal(exits.cases[0].status, 'verified');
  assert.deepEqual(chain.calls, []);
  assert.equal(acts.length, 0);
  ok('safety gate: with the executor disarmed a verified case never touches the chain');
}
{ // transfer fails on TNK fees -> halted_funds_ready, position untouched
  const ledger = emptyState(POOL);
  addContribution(ledger, X, parseCoin('0.08'));
  addContribution(ledger, Y, parseCoin('0.15'));
  settleRound(ledger, { round: 1, claimAmountUnits: 2300n });
  const exits = emptyExits(); exits.cases.push(mkCase(X, 'case-x'));
  const chain = fakeChain({ balance: 2300n, deposit: parseCoin('0.23') });
  chain.transferError = 'insufficient TNK balance for transfer fee';
  await advanceExitCases({ ledger, exits, chain, now: fixedNow, armed: true });
  chain.counted += 144;
  await advanceExitCases({ ledger, exits, chain, now: fixedNow, armed: true });
  const c = exits.cases[0];
  assert.equal(c.status, 'halted_funds_ready');
  assert.equal(ledger.contributors[X].closed, undefined); // not closed: the money was NOT sent
  assert.equal(chain.balance, 10002300n); // withdrawn funds sit safe in the pool balance (2300 + the 0.1 unlock)
  ok('executor: TNK-fee transfer failure -> halted_funds_ready, funds safe, nothing deducted from the member');
}
{ // unlock receipt 'unknown', entry visible on re-read -> confirmed, never re-sent
  const ledger = emptyState(POOL);
  addContribution(ledger, X, parseCoin('0.08'));
  addContribution(ledger, Y, parseCoin('0.15'));
  const exits = emptyExits(); exits.cases.push(mkCase(X, 'case-x'));
  const chain = fakeChain({ balance: 0n, deposit: parseCoin('0.23') });
  let first = true;
  chain.unlockBehavior = (ch, amountCoin) => {
    if (first) { first = false; const amt = parseCoin(amountCoin); ch.deposit -= amt;
      ch.exits.push({ amount: amt.toString(), release: ch.counted + 144 }); return { outcome: 'unknown' }; }
    return { outcome: 'ok' };
  };
  await advanceExitCases({ ledger, exits, chain, now: fixedNow, armed: true });
  assert.equal(exits.cases[0].status, 'unlocking');
  await advanceExitCases({ ledger, exits, chain, now: fixedNow, armed: true });
  assert.equal(exits.cases[0].status, 'waiting_maturity');
  assert.equal(chain.calls.filter(c => c[0] === 'unlock').length, 1); // confirmed by re-read, NOT re-sent
  ok("executor: an 'unknown' unlock is confirmed by re-reading the chain — never blindly re-sent");
}
{ // tampered books -> conservation halts the case before any money moves
  const ledger = emptyState(POOL);
  addContribution(ledger, X, parseCoin('0.08'));
  addContribution(ledger, Y, parseCoin('0.15'));
  ledger.contributors[X].pending = '999'; // invented earnings
  const exits = emptyExits(); exits.cases.push(mkCase(X, 'case-x'));
  const chain = fakeChain({ balance: 0n, deposit: parseCoin('0.23') });
  await advanceExitCases({ ledger, exits, chain, now: fixedNow, armed: true });
  assert.equal(exits.cases[0].status, 'halted');
  assert.match(exits.cases[0].halt_reason, /conservation/);
  assert.deepEqual(chain.calls, []);
  ok('executor: a conservation failure halts the case before any signer call');
}

console.log(`\ntest-exit: all ${n} checks passed`);

// RESET pool — exit executor: signature-verified intake + the money state
// machine. Called from pool-worker.mjs on every pass.
//
// ============================================================================
// SAFETY GATE: ARMED was false as delivered; the operator armed it on
// 2026-10-22 (user-approved gate opening, rehearsal first) and DISARMED it
// again on 2026-10-23 (user instruction: exits temporarily closed — the
// end-to-end executor test is deferred until the pool is larger; the one
// live rehearsal halted on a gateway-receipt vocabulary mismatch before
// the state machine ever advanced a case itself). With ARMED = false the
// intake half still runs (signature verification, case opening — pure
// accounting, no signer calls), but NO case ever advances past `verified`:
// no unlock, no withdraw, no transfer is even attempted. To re-arm the
// executor the operator flips ARMED to true here after a full end-to-end
// live test. There is deliberately no environment-variable override:
// arming is a code change that shows up in git.
// ============================================================================
//
// State machine (state/exits.json, one case per member exit):
//   verified -> unlocking -> waiting_maturity -> withdrawing -> paying -> done
// plus halted / halted_funds_ready (operator attention; the case blocks the
// queue — exits run strictly one at a time, in verification order, so the
// pool's single deposit never has two half-tracked exit moves in flight).
// A case flagged `dissolution` shares one full-deposit unlock/withdraw
// with every other member (charter rule 3); non-applicant members get an
// origin:'dissolution' case at declaration time.
//
// Iron rules honored here (project standing policy):
// - unknown receipts are NEVER blindly re-sent: each is resolved by
//   re-reading the chain position first; a transfer is never re-sent at
//   all on ambiguity (the case halts for the operator instead);
// - before every money-moving step the conservation self-check
//   (lib/exit.mjs checkExitConservation) must pass, or the case halts;
// - the 0.03 TNK transfer fee is the pool's cost, never deducted from the
//   member's amount; a transfer that fails on fees leaves the case in
//   halted_funds_ready with the RESET safe in the pool balance;
// - proceeds go ONLY to the case's own ledger address (the payee lock).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { closePosition, recordExitEvent, markDissolved, totalDue, formatCoin, MIN_DEPOSIT } from './pool.mjs';
import { verifyExitSubmission, planExit, checkExitConservation, EXIT_WAIT_BLOCKS } from './exit.mjs';

export const ARMED = false;

export const emptyExits = () => ({ v: 1, cases: [], rejections: [], dissolution: null });
export function loadExits(path) {
  if (!existsSync(path)) return emptyExits();
  const s = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(s.cases)) s.cases = [];
  if (!Array.isArray(s.rejections)) s.rejections = [];
  if (s.dissolution === undefined) s.dissolution = null;
  return s;
}
export const saveExits = (path, state) => writeFileSync(path, JSON.stringify(state, null, 2));

const OPEN_STATUSES = ['verified', 'unlocking', 'waiting_maturity', 'withdrawing', 'paying'];
const isOpen = c => OPEN_STATUSES.includes(c.status);
// 'cancelled' is a terminal operator verdict (e.g. a rehearsal the user
// called off): the case is closed forever. It is deliberately NOT in
// OPEN_STATUSES, and stepCase refuses it outright, so no pass — armed or
// not, today or after any future executor fix — can advance or revive a
// cancelled case. Only a human hand-editing state could reopen one, and
// the case's halt_reason records why they must not.
export const isCancelled = c => c.status === 'cancelled';
const iso = ms => new Date(ms).toISOString();
let caseSeq = 0;
const newCaseId = nowMs => `exit-${new Date(nowMs).toISOString().slice(0, 10).replaceAll('-', '')}-${String(++caseSeq).padStart(3, '0')}-${Math.random().toString(16).slice(2, 6)}`;

// Registry client for the worker (the executor takes any object with this
// shape — tests inject a fake). cfg = { url, key } as in lib/fprun.mjs.
export function registryExitClient(cfg) {
  if (!cfg) return null;
  const call = async (path, opts = {}) => {
    try {
      const r = await fetch(`${cfg.url}${path}`, { ...opts,
        headers: { 'content-type': 'application/json', 'x-registry-key': cfg.key, ...(opts.headers ?? {}) },
        signal: AbortSignal.timeout(20000) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  };
  return {
    async pendingSubmissions() {
      const j = await call('/exit/pending');
      return Array.isArray(j?.submissions) ? j.submissions : null; // null = registry unreachable
    },
    async resolve(id, result, note) {
      const j = await call('/exit/resolve', { method: 'POST', body: JSON.stringify({ id, result, note }) });
      return j?.ok === true;
    },
  };
}

// ---------------------------------------------------------------- intake
// Verify every registry submission cryptographically HERE (pool side, the
// registry only stores what was submitted) and open cases. A valid
// signature from an address with no ledger position is recorded as a
// rejection — verified-but-no-position opens nothing.
export async function intakeExitSubmissions({ ledger, exits, registry, log = () => {}, now = Date.now }) {
  const actions = [];
  if (!registry) { log({ event: 'exit_intake_skipped', reason: 'registry not configured' }); return actions; }
  const rows = await registry.pendingSubmissions();
  if (rows === null) { log({ event: 'exit_intake_failed', reason: 'registry unreachable' }); return actions; }
  for (const row of rows) {
    const prior = exits.cases.find(c => c.registry_id === row.id) ?? exits.rejections.find(r => r.registry_id === row.id);
    if (prior) { // processed before; a failed resolve is simply retried
      await registry.resolve(row.id, prior.status === 'verified' || prior.case_id ? 'verified' : 'rejected', prior.halt_reason ?? prior.reason ?? prior.case_id ?? '');
      continue;
    }
    const reject = async reason => {
      exits.rejections.push({ registry_id: row.id, address: row.address_hex, nonce: row.nonce, reason, at: iso(now()) });
      const ok = await registry.resolve(row.id, 'rejected', reason);
      actions.push({ type: 'exit_rejected', address: row.address_hex, reason, registry_id: row.id, resolved: ok });
      log({ event: 'exit_rejected', address: row.address_hex, reason, registry_id: row.id });
    };
    const verdict = verifyExitSubmission({
      poolAddress: ledger.pool_address,
      intent: { address: row.address_hex, nonce: row.nonce, prepared: row.prepared, issuedAtMs: Date.parse(row.ts) },
      prepared: row.prepared, signature: row.signature, nonce: row.nonce,
      submittedAtMs: Date.parse(row.submitted_at), nowMs: now(),
    });
    if (!verdict.ok) { await reject(verdict.error); continue; }
    if (ledger.dissolved) { await reject('pool_dissolved'); continue; }
    const due = totalDue(ledger, row.address_hex);
    if (due === 0n) { await reject('no_position'); continue; }
    if (exits.cases.some(c => c.address === row.address_hex && isOpen(c))) { await reject('case_already_open'); continue; }
    const c = { id: newCaseId(now()), address: row.address_hex, registry_id: row.id, nonce: row.nonce,
      status: 'verified', origin: 'member', dissolution: false,
      created_at: iso(now()), verified_at: iso(now()),
      principal_units: null, earnings_units: null, due_units: null,
      unlock: null, withdraw: null, paid_at: null, halt_reason: null, history: [{ at: iso(now()), event: 'verified' }] };
    exits.cases.push(c);
    recordExitEvent(ledger, 'exit_verified', { address: c.address, case_id: c.id, registry_id: row.id });
    const ok = await registry.resolve(row.id, 'verified', c.id);
    actions.push({ type: 'exit_verified', address: c.address, case_id: c.id, due_units: due.toString(), resolved: ok });
    log({ event: 'exit_verified', address: c.address, case_id: c.id, due: formatCoin(due) });
  }
  return actions;
}

// ------------------------------------------------------------- execution
function halt(c, reason, now, { fundsReady = false } = {}) {
  c.status = fundsReady ? 'halted_funds_ready' : 'halted';
  c.halt_reason = reason;
  c.history.push({ at: iso(now()), event: c.status, reason });
  return true;
}
const sameExits = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
function findNewExit(pos, preExits, amountUnits) {
  const pre = [...(preExits ?? [])];
  for (const e of pos.exits ?? []) {
    const i = pre.findIndex(p => BigInt(p.amount) === BigInt(e.amount) && Number(p.release) === Number(e.release));
    if (i >= 0) { pre.splice(i, 1); continue; }
    if (BigInt(e.amount) === BigInt(amountUnits)) return e;
  }
  return null;
}

async function conserveOrHalt({ ledger, chain, c, now, log }) {
  const pos = await chain.position();
  const chk = checkExitConservation(ledger, pos);
  if (!chk.ok) { halt(c, `conservation: ${chk.problems.join('; ')}`, now); log({ event: 'exit_halted', case_id: c.id, reason: c.halt_reason }); return null; }
  return pos;
}

// One step of one case. Returns true when state changed (the driver loops
// until no step progresses, so a mature case can flow to `done` in a
// single worker pass; a waiting case parks until the chain matures it).
async function stepCase({ ledger, exits, chain, c, now, log }) {
  if (isCancelled(c)) return false; // terminal: an operator-cancelled case never advances
  const at = () => iso(now());
  if (c.status === 'verified') {
    const pos = await conserveOrHalt({ ledger, chain, c, now, log }); if (!pos) return true;
    if (c.dissolution && exits.dissolution) return stepDissolution({ ledger, exits, chain, now, log, pos });
    const entry = ledger.contributors[c.address];
    const due = totalDue(ledger, c.address);
    if (due === 0n) return halt(c, 'due_vanished_before_unlock', now);
    const plan = planExit({ chainDepositUnits: pos.deposit, dueUnits: due });
    if (plan.dissolve) return declareDissolution({ ledger, exits, chain, trigger: c, pos, now, log });
    c.principal_units = entry.contributed; c.earnings_units = entry.pending; c.due_units = due.toString();
    c.unlock = { amount_units: plan.unlockUnits.toString(), pre_exits: pos.exits ?? [], counted_at: pos.counted, release_at: null, attempts: 0, sent: false };
    c.history.push({ at: at(), event: 'planned', due_units: c.due_units, unlock_units: c.unlock.amount_units, deposit_after_units: plan.afterUnits.toString() });
    c.status = 'unlocking';
    return true;
  }
  if (c.status === 'unlocking') {
    if (c.dissolution && exits.dissolution) return stepDissolution({ ledger, exits, chain, now, log });
    const pos = await conserveOrHalt({ ledger, chain, c, now, log }); if (!pos) return true;
    const u = c.unlock;
    const found = findNewExit(pos, u.pre_exits, u.amount_units);
    if (found) { // previous send (possibly an 'unknown') has landed
      u.sent = true; c.money_moved = true; u.release_at = Number(found.release);
      c.status = 'waiting_maturity';
      c.history.push({ at: at(), event: 'unlock_confirmed', release_at: u.release_at });
      recordExitEvent(ledger, 'exit_unlock', { address: c.address, case_id: c.id, amount_units: u.amount_units, release_at: u.release_at });
      log({ event: 'exit_unlock', case_id: c.id, amount: formatCoin(BigInt(u.amount_units)), release_at: u.release_at });
      return true;
    }
    if (u.sent) return halt(c, 'unlock_sent_but_exit_entry_missing', now);
    if (BigInt(pos.deposit) < BigInt(u.amount_units)) return halt(c, 'deposit_no_longer_covers_unlock', now);
    // 'unknown' discipline: a send whose receipt was unknown is re-sent at
    // most ONCE, and only after a later pass re-read the position and
    // still found no matching exit entry (the check above). A second
    // unknown halts the case for the operator — never a third send.
    if (u.unknown_pending) {
      if (u.resent) return halt(c, 'unlock_unconfirmed_after_resend', now);
      u.resent = true; u.unknown_pending = false;
    }
    u.attempts++;
    const r = await chain.unlock(formatCoin(BigInt(u.amount_units)));
    if (r.outcome === 'ok') {
      u.sent = true; c.money_moved = true;
      const pos2 = await chain.position();
      const landed = findNewExit(pos2, u.pre_exits, u.amount_units);
      u.release_at = landed ? Number(landed.release) : (r.release_at_or_after ?? (pos.counted + EXIT_WAIT_BLOCKS));
      c.status = 'waiting_maturity';
      c.history.push({ at: at(), event: 'unlock_sent', release_at: u.release_at });
      recordExitEvent(ledger, 'exit_unlock', { address: c.address, case_id: c.id, amount_units: u.amount_units, release_at: u.release_at });
      log({ event: 'exit_unlock', case_id: c.id, amount: formatCoin(BigInt(u.amount_units)), release_at: u.release_at });
      return true;
    }
    if (r.outcome === 'unknown') {
      if (u.resent) return halt(c, 'unlock_unconfirmed_after_resend', now);
      u.unknown_pending = true;
      c.history.push({ at: at(), event: 'unlock_unknown', attempt: u.attempts });
      return true;
    }
    return halt(c, `unlock_${r.outcome}: ${String(r.message ?? '').slice(0, 120)}`, now);
  }
  if (c.status === 'waiting_maturity') {
    if (c.dissolution && exits.dissolution) return stepDissolution({ ledger, exits, chain, now, log });
    const pos = await chain.position();
    const entry = (pos.exits ?? []).find(e => BigInt(e.amount) === BigInt(c.unlock.amount_units) && Number(e.release) === Number(c.unlock.release_at));
    if (!entry) return halt(c, 'exit_entry_vanished_before_maturity', now);
    if (Number(entry.release) > Number(pos.counted)) return false; // still maturing: the only no-progress outcome
    c.status = 'withdrawing';
    c.withdraw = { balance_before: pos.balance.toString(), attempts: 0 };
    c.history.push({ at: at(), event: 'matured', counted: pos.counted });
    return true;
  }
  if (c.status === 'withdrawing') {
    if (c.dissolution && exits.dissolution) return stepDissolution({ ledger, exits, chain, now, log });
    const pos = await chain.position();
    const stillThere = (pos.exits ?? []).some(e => BigInt(e.amount) === BigInt(c.unlock.amount_units) && Number(e.release) === Number(c.unlock.release_at));
    const gained = BigInt(pos.balance) - BigInt(c.withdraw.balance_before);
    if (!stillThere && gained >= BigInt(c.unlock.amount_units)) { c.status = 'paying'; c.history.push({ at: at(), event: 'withdrawn' }); return true; }
    if (!stillThere && c.withdraw.attempts > 0) return halt(c, 'withdraw_unconfirmed', now);
    if (!stillThere) { c.withdraw.attempts++; return true; } // entry gone but balance not yet readable as raised: re-read next pass
    c.withdraw.attempts++;
    const r = await chain.withdraw();
    if (r.outcome === 'ok' || r.outcome === 'unknown') { c.history.push({ at: at(), event: 'withdraw_sent', outcome: r.outcome }); return true; }
    return halt(c, `withdraw_${r.outcome}: ${String(r.message ?? '').slice(0, 120)}`, now);
  }
  if (c.status === 'paying') {
    if (c.dissolution && exits.dissolution) return stepDissolution({ ledger, exits, chain, now, log });
    return payCase({ ledger, exits, chain, c, now, log });
  }
  return false;
}

// The transfer itself + the ledger close-out. Shared by normal cases and
// dissolution cases (which pay strictly in declaration order).
async function payCase({ ledger, exits, chain, c, now, log }) {
  const pos = await conserveOrHalt({ ledger, chain, c, now, log }); if (!pos) return true;
  const due = BigInt(c.due_units);
  if (BigInt(pos.balance) < due) return halt(c, 'insufficient_balance_at_payment', now, { fundsReady: true });
  c.money_moved = true;
  const before = BigInt(pos.balance);
  const r = await chain.transfer(c.address, formatCoin(due));
  if (r.outcome === 'ok') return finalizePayment({ ledger, exits, c, now, log });
  if (r.outcome === 'unknown') {
    const pos2 = await chain.position().catch(() => null);
    if (pos2 && before - BigInt(pos2.balance) === due) return finalizePayment({ ledger, exits, c, now, log });
    return halt(c, 'transfer_unconfirmed_never_resent', now); // a payment is NEVER blindly re-sent
  }
  const msg = String(r.message ?? r.outcome ?? '');
  if (/tnk|fee|funds|balance/i.test(msg)) return halt(c, `transfer_failed_funds: ${msg.slice(0, 120)}`, now, { fundsReady: true });
  return halt(c, `transfer_${r.outcome}: ${msg.slice(0, 120)}`, now);
}

function finalizePayment({ ledger, exits, c, now, log }) {
  closePosition(ledger, c.address, { caseId: c.id, principalUnits: c.principal_units, earningsUnits: c.earnings_units, at: iso(now()) });
  c.status = 'done'; c.paid_at = iso(now());
  c.history.push({ at: iso(now()), event: 'paid', total_units: c.due_units });
  log({ event: 'exit_paid', case_id: c.id, address: c.address, amount: formatCoin(BigInt(c.due_units)), dissolution: !!c.dissolution });
  if (c.dissolution && exits.dissolution) {
    const open = exits.cases.filter(x => x.dissolution && isOpen(x));
    if (!open.length && !ledger.dissolved) {
      markDissolved(ledger, { at: iso(now()), triggerCaseId: exits.dissolution.trigger_case_id });
      exits.dissolution.stage = 'done';
      log({ event: 'pool_dissolved', trigger_case_id: exits.dissolution.trigger_case_id });
    }
  }
  return true;
}

// Charter rule 3: this case's payment would leave the deposit strictly
// below MIN_DEPOSIT — escalate to settling EVERY member. All open cases
// merge; every other contributor gets an origin:'dissolution' case; all
// dues freeze at declaration; one unlock of the entire deposit follows.
function declareDissolution({ ledger, exits, chain, trigger, pos, now, log }) {
  const at = iso(now());
  exits.dissolution = { declared_at: at, trigger_case_id: trigger.id, stage: 'unlocking',
    unlock: { amount_units: pos.deposit.toString(), pre_exits: pos.exits ?? [], counted_at: pos.counted, release_at: null, attempts: 0, sent: false },
    withdraw: null };
  let members = 0;
  for (const c of exits.cases) {
    if (!isOpen(c)) continue;
    const entry = ledger.contributors[c.address];
    if (!entry || entry.closed) { halt(c, 'position_closed_before_dissolution', now); continue; }
    c.dissolution = true;
    if (c.principal_units === null) { c.principal_units = entry.contributed; c.earnings_units = entry.pending; c.due_units = (BigInt(entry.contributed) + BigInt(entry.pending)).toString(); }
    members++;
  }
  for (const [address, entry] of Object.entries(ledger.contributors)) {
    if (entry.closed || (BigInt(entry.contributed) + BigInt(entry.pending)) === 0n) continue;
    if (exits.cases.some(c => c.address === address && isOpen(c))) continue;
    const c = { id: newCaseId(now()), address, registry_id: null, nonce: null,
      status: 'verified', origin: 'dissolution', dissolution: true,
      created_at: at, verified_at: at,
      principal_units: entry.contributed, earnings_units: entry.pending,
      due_units: (BigInt(entry.contributed) + BigInt(entry.pending)).toString(),
      unlock: null, withdraw: null, paid_at: null, halt_reason: null, history: [{ at, event: 'dissolution_case' }] };
    exits.cases.push(c);
    members++;
  }
  recordExitEvent(ledger, 'dissolution_declared', { trigger_case_id: trigger.id, members, deposit_units: pos.deposit.toString() });
  log({ event: 'dissolution_declared', trigger_case_id: trigger.id, members, deposit: formatCoin(pos.deposit) });
  return true;
}

// Shared unlock/wait/withdraw for the whole dissolution, then members are
// paid one by one in case order. Member-case statuses mirror the shared
// stage so the public state machine still reads per case.
async function stepDissolution({ ledger, exits, chain, now, log, pos: posIn }) {
  const d = exits.dissolution;
  const members = exits.cases.filter(c => c.dissolution && isOpen(c));
  const syncStatus = s => { for (const c of members) if (c.status !== 'paying') c.status = s; };
  if (d.stage === 'unlocking') {
    const head = members[0];
    const pos = posIn ?? await conserveOrHalt({ ledger, chain, c: head, now, log }); if (!pos) return true;
    const u = d.unlock;
    if (BigInt(u.amount_units) === 0n) { d.stage = 'paying'; syncStatus('paying'); return true; }
    if (BigInt(u.amount_units) < MIN_DEPOSIT) { for (const c of members) halt(c, 'dissolution_deposit_below_min_unlock', now); return true; }
    const found = findNewExit(pos, u.pre_exits, u.amount_units);
    if (found) { u.sent = true; u.release_at = Number(found.release); d.stage = 'waiting'; syncStatus('waiting_maturity'); return true; }
    if (u.sent) { for (const c of members) halt(c, 'dissolution_unlock_entry_missing', now); return true; }
    // same unknown discipline as single cases: at most one re-send, only
    // after a later position read still shows no matching entry
    if (u.unknown_pending) {
      if (u.resent) { for (const c of members) halt(c, 'dissolution_unlock_unconfirmed', now); return true; }
      u.resent = true; u.unknown_pending = false;
    }
    u.attempts++;
    const r = await chain.unlock(formatCoin(BigInt(u.amount_units)));
    if (r.outcome === 'ok') {
      u.sent = true;
      const pos2 = await chain.position();
      const landed = findNewExit(pos2, u.pre_exits, u.amount_units);
      u.release_at = landed ? Number(landed.release) : (r.release_at_or_after ?? (pos.counted + EXIT_WAIT_BLOCKS));
      d.stage = 'waiting'; syncStatus('waiting_maturity');
      recordExitEvent(ledger, 'exit_unlock', { address: ledger.pool_address, case_id: d.trigger_case_id, amount_units: u.amount_units, release_at: u.release_at, dissolution: true });
      log({ event: 'dissolution_unlock', amount: formatCoin(BigInt(u.amount_units)), release_at: u.release_at });
      return true;
    }
    if (r.outcome === 'unknown') {
      if (u.resent) { for (const c of members) halt(c, 'dissolution_unlock_unconfirmed', now); return true; }
      u.unknown_pending = true;
      return true;
    }
    for (const c of members) halt(c, `dissolution_unlock_${r.outcome}`, now);
    return true;
  }
  if (d.stage === 'waiting') {
    const pos = await chain.position();
    const entry = (pos.exits ?? []).find(e => BigInt(e.amount) === BigInt(d.unlock.amount_units) && Number(e.release) === Number(d.unlock.release_at));
    if (!entry) { if (d.withdraw) { d.stage = 'paying'; syncStatus('paying'); return true; } for (const c of members) halt(c, 'dissolution_exit_entry_vanished', now); return true; }
    if (Number(entry.release) > Number(pos.counted)) return false;
    d.withdraw = { balance_before: pos.balance.toString(), attempts: 0 };
    d.stage = 'withdrawing'; syncStatus('withdrawing');
    return true;
  }
  if (d.stage === 'withdrawing') {
    const pos = await chain.position();
    const stillThere = (pos.exits ?? []).some(e => BigInt(e.amount) === BigInt(d.unlock.amount_units) && Number(e.release) === Number(d.unlock.release_at));
    const gained = BigInt(pos.balance) - BigInt(d.withdraw.balance_before);
    if (!stillThere && gained >= BigInt(d.unlock.amount_units)) { d.stage = 'paying'; syncStatus('paying'); return true; }
    if (!stillThere) return true; // re-read next pass
    d.withdraw.attempts++;
    const r = await chain.withdraw();
    if (r.outcome === 'ok' || r.outcome === 'unknown') return true;
    for (const c of members) halt(c, `dissolution_withdraw_${r.outcome}`, now);
    return true;
  }
  if (d.stage === 'paying') {
    const next = members.find(c => c.status !== 'done');
    if (!next) return false;
    next.status = 'paying';
    return payCase({ ledger, exits, chain, c: next, now, log });
  }
  return false;
}

// Advance open cases (ARMED only — the caller passes armed through so
// tests can drive the machine; production passes the module constant).
export async function advanceExitCases({ ledger, exits, chain, now = Date.now, log = () => {}, armed = ARMED }) {
  const actions = [];
  if (!armed) return actions;
  if (ledger.dissolved) return actions;
  // A case halted WITH money already in flight (unlock sent / withdraw /
  // transfer attempted) freezes the whole queue: exit entries on-chain
  // could no longer be attributed unambiguously if a second case started
  // moving money. A case halted before any money moved does not block.
  const blocker = exits.cases.find(c => (c.status === 'halted' || c.status === 'halted_funds_ready') && c.money_moved);
  if (blocker) { log({ event: 'exit_queue_blocked', case_id: blocker.id, reason: blocker.halt_reason }); return actions; }
  for (let i = 0; i < 40; i++) {
    const head = exits.cases.filter(c => isOpen(c) && !isCancelled(c)).sort((a, b) => (a.created_at < b.created_at ? -1 : 1))[0];
    if (!head) break;
    const before = JSON.stringify([head.status, exits.dissolution?.stage ?? null]);
    const progressed = await stepCase({ ledger, exits, chain, c: head, now, log });
    const after = JSON.stringify([head.status, exits.dissolution?.stage ?? null]);
    if (before !== after) actions.push({ type: 'exit_step', case_id: head.id, from: JSON.parse(before)[0], to: JSON.parse(after)[0] });
    if (!progressed) break;
    if (head.status === 'waiting_maturity' && !(head.dissolution && exits.dissolution)) break; // parked until maturity
    if (exits.dissolution && exits.dissolution.stage === 'waiting') break;
    // An 'unknown' unlock is only ever re-sent after a LATER pass re-reads
    // the position — never within the pass that sent it.
    if (head.unlock?.unknown_pending) break;
    if (exits.dissolution?.unlock?.unknown_pending) break;
  }
  return actions;
}

// Full pass used by pool-worker: intake always; execution only when armed.
export async function runExitPass({ ledger, exits, chain, registry, now = Date.now, log = () => {}, armed = ARMED }) {
  const actions = [];
  actions.push(...await intakeExitSubmissions({ ledger, exits, registry, log, now }));
  if (armed && chain) actions.push(...await advanceExitCases({ ledger, exits, chain, now, log, armed }));
  else if (!armed) log({ event: 'exit_executor_disarmed', open_cases: exits.cases.filter(isOpen).length });
  return actions;
}

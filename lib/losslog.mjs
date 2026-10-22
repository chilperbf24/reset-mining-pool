// RESET pool — rehearsal loss log (state/rehearsal-loss-log.json).
//
// The cancelled 2026-10-22 exit rehearsal unlocked 0.1 (the contract's
// minimum move granularity) out of the pool's single shared deposit, so
// for the rounds until the money is withdrawn and re-locked the pool
// claims at a reduced deposit (0.12933277 instead of 0.22933277) and
// every member earns less per round. This module records, round by
// round, the raw facts FIRST (actual claim, the claim deposit it was
// registered at, the round's network claiming total and guideline) and
// the derived shortfall second, so the figures can be recomputed under
// any convention later. The gateway overwrites last_result every round —
// nothing here may wait for a reconstruction.
//
// It NEVER books compensation: the log is evidence for a make-whole
// proposal that needs its own user approval (user ruling 2026-10-22
// 12:59: calculate only, no transfers, no ledger events).
//
// Methods (recorded per entry):
// - 'exact': the round's network claiming total T is known ->
//   counterfactual = actual x FULL x T / (claim_deposit x (T + delta)),
//   anchored on the round's actual amount (the contract's fair formula
//   guideline x deposit / total reproduces actuals exactly — verified
//   on round 477: 1856250000 x 22933277 / 282205257999 = 150847).
// - 'linear-upper-bound': T unknown -> counterfactual =
//   actual x FULL / claim_deposit (an upper bound: the true network
//   total would also have grown by delta).
// - 'raw-only': no counterfactual (claim deposit unknown, or an
//   evidence row for a round that claimed at full deposit).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const HOME = process.env.HOME;
const GW = 'https://reset.openmayhem.ai';
const LOG_PATH = `${HOME}/workspace/reset-pool/state/rehearsal-loss-log.json`;
const EXITS_PATH = `${HOME}/workspace/reset-pool/state/exits.json`;
const LEDGER_PATH = `${HOME}/workspace/reset-pool/state/live-ledger.json`;
const REPORTS_DIR = `${HOME}/workspace/reset-pool/reports`;

export const FULL_DEPOSIT_UNITS = 22933277n;
export const REDUCED_DEPOSIT_UNITS = 12933277n;
export const DELTA_UNITS = FULL_DEPOSIT_UNITS - REDUCED_DEPOSIT_UNITS; // 0.1
export const CASE_ID = 'exit-20261022-001-3e8d';
export const FIRST_TRACKED_ROUND = 477; // 477 = evidence row only (full-deposit claim)

export function counterfactualExact({ actualUnits, claimDepositUnits, networkTotalUnits }) {
  const delta = FULL_DEPOSIT_UNITS - BigInt(claimDepositUnits);
  if (delta <= 0n) return BigInt(actualUnits);
  return BigInt(actualUnits) * FULL_DEPOSIT_UNITS * BigInt(networkTotalUnits)
    / (BigInt(claimDepositUnits) * (BigInt(networkTotalUnits) + delta));
}
export function counterfactualUpperBound({ actualUnits, claimDepositUnits }) {
  const delta = FULL_DEPOSIT_UNITS - BigInt(claimDepositUnits);
  if (delta <= 0n) return BigInt(actualUnits);
  return BigInt(actualUnits) * FULL_DEPOSIT_UNITS / BigInt(claimDepositUnits);
}
// Pro-rata split of a diff over a settlement snapshot's rows; the integer
// remainder is reported as dust, never silently assigned.
export function allocateDiff(diffUnits, rows) {
  const diff = BigInt(diffUnits);
  const W = (rows ?? []).reduce((s, r) => s + BigInt(r.deposit_units), 0n);
  const allocation = {};
  let used = 0n;
  if (W > 0n && diff > 0n) {
    for (const r of rows) {
      const share = diff * BigInt(r.deposit_units) / W;
      allocation[r.address] = share.toString();
      used += share;
    }
  } else {
    for (const r of rows ?? []) allocation[r.address] = '0';
  }
  return { allocation, dustUnits: (diff - used).toString() };
}

const readJson = (p, dflt) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return dflt; } };
async function fetchJson(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

function skeleton(poolAddress) {
  return {
    v: 1, kind: 'reset-pool-rehearsal-loss-log',
    purpose: 'Per-round record of the pool claim shortfall caused by the cancelled 2026-10-22 exit rehearsal (claim deposit cut from 0.22933277 to 0.12933277 until the 0.1 is withdrawn after release 972703 and re-locked). Raw fields first; NO compensation is booked from this log without a separate user approval.',
    case_id: CASE_ID, pool_address: poolAddress,
    window: { opened_by: 'rehearsal unlock counted_at 972559 (2026-10-22T04:08:31Z), release 972703',
      full_deposit_units: FULL_DEPOSIT_UNITS.toString(), reduced_deposit_units: REDUCED_DEPOSIT_UNITS.toString(),
      delta_units: DELTA_UNITS.toString(), release: 972703, closed: false, closed_at: null,
      close_condition: 'chain exits empty AND deposit back at or above full_deposit_units (re-lock done); entries are appended for settled rounds until then' },
    methods: {
      exact: 'network claiming total for the round is known: counterfactual = actual x FULL x T / (claim_deposit x (T + delta)), anchored on the round actual amount',
      'linear-upper-bound': 'network total unknown: counterfactual = actual x FULL / claim_deposit (an upper bound, since the true denominator would also grow by delta)',
      'raw-only': 'raw fields only; no counterfactual computed (claim deposit unknown, or an evidence row for a round that was not affected)' },
    round_snapshots: {}, entries: [],
  };
}

// One worker-pass update. Self-contained gateway reads; never throws.
// Returns a small summary object when anything changed, else null.
export async function updateLossLog({ address, log = () => {} } = {}) {
  try {
    const exitsState = readJson(EXITS_PATH, null);
    const kase = exitsState?.cases?.find(c => c.id === CASE_ID);
    if (!kase || kase.status !== 'cancelled') return null; // window only exists for the cancelled rehearsal
    let state = readJson(LOG_PATH, null) ?? skeleton(address);
    if (state.window.closed) return null;
    const before = JSON.stringify(state);

    const [acc, mv, st] = await Promise.all([
      fetchJson(`${GW}/v1/account/${address}`),
      fetchJson(`${GW}/v1/mine/view`),
      fetchJson(`${GW}/v1/state`),
    ]);
    const nowIso = new Date().toISOString();
    const counted = st?.counted ?? mv?.counted ?? null;

    // --- raw snapshot of the round currently in flight (overwritten each
    // pass; the capture nearest claim_end is the near-final one, and the
    // settled totals below supersede it once the round settles).
    const curR = mv?.round?.r ?? acc?.mine?.r ?? null;
    if (curR != null) {
      const snap = state.round_snapshots[curR] ?? { round: curR };
      snap.captured_at = nowIso;
      snap.counted = counted;
      snap.pool_claim_deposit_units = acc?.mine?.claim?.d != null ? String(acc.mine.claim.d) : (snap.pool_claim_deposit_units ?? null);
      snap.network_claim_total_units = mv?.round?.deposit != null ? String(mv.round.deposit) : (snap.network_claim_total_units ?? null);
      snap.network_claims = mv?.round?.claims ?? snap.network_claims ?? null;
      snap.guideline_units = mv?.mine?.guideline != null ? String(mv.mine.guideline) : (snap.guideline_units ?? null);
      snap.fair_share_estimate_units = acc?.mine?.fair_share_estimate != null ? String(acc.mine.fair_share_estimate) : (snap.fair_share_estimate_units ?? null);
      state.round_snapshots[curR] = snap;
    }
    // --- the gateway's settled-round totals for the latest settled round
    if (mv?.last?.r != null) {
      const lr = mv.last.r;
      const snap = state.round_snapshots[lr] ?? { round: lr };
      snap.settled_totals = {
        network_claim_total_units: String(mv.last.deposit),
        guideline_units: mv.last.guideline != null ? String(mv.last.guideline) : null,
        network_claims: mv.last.claims ?? null,
        paid_units: mv.last.paid != null ? String(mv.last.paid) : null,
        captured_at: nowIso,
      };
      state.round_snapshots[lr] = snap;
    }

    // --- entries for newly settled rounds
    const ledger = readJson(LEDGER_PATH, null);
    const settledRounds = (ledger?.events ?? []).filter(e => e.type === 'round_settled').map(e => e.data.round);
    for (const r of settledRounds) {
      if (r < FIRST_TRACKED_ROUND) continue;
      if (state.entries.some(e => e.round === r)) continue;
      const report = readJson(`${REPORTS_DIR}/live-round-${r}.json`, null);
      if (!report) continue; // report not written yet; next pass
      const snap = state.round_snapshots[r] ?? {};
      const claimD = snap.pool_claim_deposit_units != null ? BigInt(snap.pool_claim_deposit_units) : null;
      const actual = BigInt(report.claim.amount_units);
      const entry = {
        round: r, kind: 'settled', settled_at: nowIso,
        claim_deposit_units: claimD != null ? claimD.toString() : null,
        actual_amount_units: actual.toString(),
        network_claim_total_units: null, network_total_source: null,
        guideline_units: snap.settled_totals?.guideline_units ?? snap.guideline_units ?? null,
        counterfactual_amount_units: null, diff_units: null,
        allocation: {}, allocation_dust_units: null, method: 'raw-only',
        raw: { report_hash: report.report_hash ?? null,
          fair_units: acc?.mine?.last_result?.r === r ? String(acc.mine.last_result.fair) : null,
          fair_share_estimate_units: snap.fair_share_estimate_units ?? null,
          network_claims: snap.settled_totals?.network_claims ?? snap.network_claims ?? null },
      };
      if (claimD === FULL_DEPOSIT_UNITS) {
        entry.affected = false;
        entry.diff_units = '0';
        entry.note = 'claim registered at the full deposit — not an affected round (recorded for completeness)';
        const a = allocateDiff(0n, report.snapshot?.rows ?? []);
        entry.allocation = a.allocation; entry.allocation_dust_units = a.dustUnits;
      } else if (claimD === REDUCED_DEPOSIT_UNITS) {
        entry.affected = true;
        const T = snap.settled_totals?.network_claim_total_units ?? snap.network_claim_total_units ?? null;
        let cf;
        if (T != null) {
          entry.network_claim_total_units = String(T);
          entry.network_total_source = snap.settled_totals ? 'gateway /v1/mine/view last.deposit (settled-round totals)' : 'gateway /v1/mine/view round.deposit (in-round snapshot, latest capture)';
          cf = counterfactualExact({ actualUnits: actual, claimDepositUnits: claimD, networkTotalUnits: BigInt(T) });
          entry.method = 'exact';
        } else {
          entry.network_total_source = null;
          entry.source_gap = 'network claiming total unavailable from gateway at settle time and no in-round snapshot captured it; counterfactual is the linear upper bound';
          cf = counterfactualUpperBound({ actualUnits: actual, claimDepositUnits: claimD });
          entry.method = 'linear-upper-bound';
        }
        entry.counterfactual_amount_units = cf.toString();
        const diff = cf > actual ? cf - actual : 0n;
        entry.diff_units = diff.toString();
        const a = allocateDiff(diff, report.snapshot?.rows ?? []);
        entry.allocation = a.allocation; entry.allocation_dust_units = a.dustUnits;
      } else {
        entry.affected = null;
        entry.source_gap = 'pool claim deposit for this round was not captured in-round; shortfall not computed — raw fields preserved for later reconstruction';
      }
      state.entries.push(entry);
      log({ event: 'losslog_entry', round: r, affected: entry.affected, method: entry.method, diff: entry.diff_units });
    }

    // --- window close: money home and re-locked
    if (acc && (acc.exits ?? []).length === 0 && BigInt(acc.deposit ?? 0) >= FULL_DEPOSIT_UNITS) {
      state.window.closed = true;
      state.window.closed_at = nowIso;
      log({ event: 'losslog_window_closed', deposit: String(acc.deposit) });
    }

    if (JSON.stringify(state) !== before) {
      writeFileSync(LOG_PATH, JSON.stringify(state, null, 2));
      return { updated: true, entries: state.entries.length, closed: state.window.closed };
    }
    return null;
  } catch (e) {
    log({ event: 'losslog_error', error: String((e && e.message) || e).slice(0, 160) });
    return null;
  }
}

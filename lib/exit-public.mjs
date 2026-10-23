// RESET pool — public projection of exit cases for the website.
//
// The executor's working state (state/exits.json) carries operational
// fields that are NOT public record material: the one-time registry
// nonce, registry row ids, halt internals. What IS public — it mirrors
// the hash-chained ledger events (exit_verified / exit_unlock /
// exit_paid) — is the case's outline: id, member address, the frozen
// due, how much was unlocked and at which release height it matures,
// and when it was withdrawn / paid. This module is the single place
// that projection happens: publish-state.mjs writes it to
// state/exit-cases.json alongside the ledger, and generate-site.mjs
// embeds it into the exit page's progress lookup (stage 5).
import { EXIT_WAIT_BLOCKS } from './exit.mjs';

const LANDED_STATUSES = ['waiting_maturity', 'withdrawing', 'paying', 'done'];

// Did the case's unlock actually land on-chain? The executor records
// release_at once it observes the exit entry; `sent` marks an accepted
// send. The 2026-10-22 rehearsal case is the awkward one: the signer
// reported the outcome as 'accepted', the executor's vocabulary check
// halted the case before it could record release_at — yet the unlock
// HAD landed (deposit drop + on-chain exit entry, release 972703).
// Its halt reason preserves that fact, so acceptance evidence in the
// history counts as landed too.
function unlockLanded(c) {
  const u = c.unlock;
  if (!u) return false;
  if (u.release_at != null || u.sent === true) return true;
  if (LANDED_STATUSES.includes(c.status)) return true;
  return (c.history ?? []).some(h =>
    h.event === 'unlock_confirmed' || h.event === 'unlock_sent' ||
    (typeof h.reason === 'string' && /unlock_accepted/.test(h.reason)));
}

function unlockSummary(c) {
  const u = c.unlock;
  if (!u) return null;
  const landed = unlockLanded(c);
  // The contract fixes the release height at counted + exit_wait (144);
  // when the executor halted before recording it, that is still the
  // height the chain entry carries (rehearsal: 972559 + 144 = 972703,
  // cross-checked against state/rehearsal-loss-log.json).
  const release_at = u.release_at != null ? Number(u.release_at)
    : (landed && u.counted_at != null ? Number(u.counted_at) + EXIT_WAIT_BLOCKS : null);
  return {
    amount_units: String(u.amount_units),
    landed,
    counted_at: u.counted_at != null ? Number(u.counted_at) : null,
    release_at,
  };
}

export function publicExitCases(exitsState) {
  return (exitsState?.cases ?? []).map(c => {
    const withdrawnEv = (c.history ?? []).find(h => h.event === 'withdrawn');
    const done = c.status === 'done';
    return {
      id: c.id,
      address: c.address,
      status: c.status,
      dissolution: !!c.dissolution,
      created_at: c.created_at ?? null,
      verified_at: c.verified_at ?? null,
      principal_units: c.principal_units != null ? String(c.principal_units) : null,
      earnings_units: c.earnings_units != null ? String(c.earnings_units) : null,
      due_units: c.due_units != null ? String(c.due_units) : null,
      unlock: unlockSummary(c),
      withdrawn_at: withdrawnEv?.at ?? null,
      paid_at: c.paid_at ?? null,
      // A done case paid exactly its frozen due (finalizePayment in
      // lib/exit-exec.mjs transfers due_units and closes the position).
      paid_units: done && c.due_units != null ? String(c.due_units) : null,
    };
  });
}

export function publicExitSummary(exitsState) {
  return { v: 1, cases: publicExitCases(exitsState) };
}

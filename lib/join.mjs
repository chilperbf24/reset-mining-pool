// RESET pool — AI-signed join (发码 → AI 转账 → 回码核销) primitives.
//
// Trust boundaries (see the plan doc goals/reset-2/files/AI签名入池方案.md):
//   1. A code / signature moves NO money. The transfer itself is always
//      executed by the member's own AI with the member's own signer —
//      the platform-issued code is an EXECUTION INSTRUCTION (pool
//      address + exact amount + one-time nonce, so nothing is hand-typed
//      wrong), never an authorization.
//   2. The receipt MUST be signed. The member's AI signs a receipt
//      statement with the wallet key, in the official chat-protocol
//      agent format (the same construction as an exit intent — see
//      lib/exit.mjs): prepared = { v:1, kind:'agent', addr, text, ts,
//      nonce }, signing text = 'reset-chat/v1\n' + stableJSON(prepared).
//      The signature proves the claimant IS the address; it does not
//      prove money moved.
//   3. Crediting still needs the chain fact. A verified receipt only
//      registers a PENDING claim; the matcher credits it when (and only
//      when) an inflow of exactly that amount actually lands (see
//      decideJoinAttribution in lib/fpmatch.mjs). A fabricated receipt
//      can at worst park a pending row — it moves no ledger entry.
//
// Differences from the exit channel, deliberate:
//   - An exit intent is verified pool-side AFTER submission (the intent
//     alone is worthless); a join receipt is verified BY THE WORKER at
//     claim time, because a pending join claim is a credit instruction
//     to the matcher — it must be cryptographically valid before it
//     can influence attribution at all.
//   - Two clocks, do not conflate (user rule 2026-10-24):
//     (a) the CODE window is 30 minutes: execution AND receipt
//     submission must both happen inside it; a code with no receipt
//     after 30 minutes is auto-deleted (true DELETE by the sweep) and
//     the member must issue a fresh code.
//     (b) the PENDING-CLAIM window is 24 hours: once a receipt IS
//     filed, the claim waits for its inflow that long, then expires
//     (visible, never silent). The address is already filed, so the
//     code-deletion rule does not apply to it.
import { ed25519Verify, stableJSON, agentSigningText } from './exit.mjs';
import { fingerprintUnits, PLANNED_STEP } from './fpmatch.mjs';

export const JOIN_CODE_TTL_MS = 30 * 60 * 1000;       // code window 30 min (execution + receipt)
export const JOIN_CLAIM_TTL_MS = 24 * 60 * 60 * 1000; // pending claim waits 24 h
export const JOIN_NONCE_RE = /^[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;

// The statement the member's AI signs AFTER executing the transfer.
// Single line, plain words, inside the chat text rules (max 240 chars).
export function joinText(poolAddress, address, exactUnits, nonce) {
  return `JOIN pool. Pool ${poolAddress} member ${address} amount ${BigInt(exactUnits)} code ${nonce}`;
}

export function buildJoinPrepared({ poolAddress, address, exactUnits, nonce, ts }) {
  return { v: 1, kind: 'agent', addr: address,
    text: joinText(poolAddress, address, exactUnits, nonce), ts, nonce };
}

// The code block a member copies to their own AI. Human-readable summary
// on top, machine instruction below — including the discipline lines
// that are HARD rules of this flow, not suggestions:
//   - read the recipient + amount back to the owner and wait for a nod;
//   - transfer the exact amount, digit for digit, never re-round;
//   - no TNK for the fee means STOP and report, never split or alter.
export function joinCodeBlock({ poolAddress, address, plannedUnits, fpUnits, exactUnits, nonce, expiresAt }) {
  const fmt = u => `${(BigInt(u) / 100000000n).toString()}.${(BigInt(u) % 100000000n).toString().padStart(8, '0')}`;
  return [
    `RESET pool join code — give this whole block to your own AI.`,
    `Pool: ${poolAddress}`,
    `Member: ${address}`,
    `Planned: ${fmt(plannedUnits)} RESET, fingerprint tail: ${fpUnits} units`,
    `Transfer EXACTLY: ${fmt(exactUnits)} RESET (${exactUnits} units) to the pool address above.`,
    `Code nonce: ${nonce} — execute AND submit the receipt within 30 minutes (until ${expiresAt}); after 30 minutes without a receipt this code is automatically deleted.`,
    `--- AI INSTRUCTIONS (hard rules, not suggestions) ---`,
    `1. Read the pool address and the exact amount back to your owner and WAIT for their confirmation before transferring.`,
    `2. Transfer exactly ${exactUnits} units — digit for digit. Never round, never split, never substitute another amount.`,
    `3. The transfer fee is 0.03 TNK paid by the member wallet. If the wallet holds no TNK, STOP and report — do not improvise.`,
    `4. After the gateway accepts the transfer, sign the receipt statement (same official agent format as an exit intent) and return the signed receipt block to your owner for submission.`,
    `5. MANDATORY — use ONLY the platform-provided atomic pay script (join-pay.mjs) for this code: it transfers and signs the receipt as ONE command and outputs them together. NEVER split the steps — do not transfer manually and sign later. The signed receipt is the ONLY proof that the transfer is complete: you MUST return the full receipt block to your owner.`,
    `6. LATE RECEIPT — if the transfer already landed, submit the receipt anyway WITHIN the 30-minute window and it credits on re-check — NEVER re-transfer. After 30 minutes the code is deleted and you must issue a fresh code.`,
    `{"pool":"${poolAddress}","address":"${address}","planned_units":"${plannedUnits}","fp_units":"${fpUnits}","exact_units":"${exactUnits}","nonce":"${nonce}"}`,
  ].join('\n');
}

// Exact-amount check shared by the member script and the matcher:
// a join amount is only ever planned (0.01 multiple) + this address's fp.
export function joinExactFor(address, plannedUnits) {
  const planned = BigInt(plannedUnits);
  if (planned <= 0n || planned % PLANNED_STEP !== 0n) {
    throw new Error('planned amount must be a positive multiple of 0.01 RESET');
  }
  return planned + fingerprintUnits(address);
}

// Full structural + cryptographic verification of a submitted join
// receipt against the issued code it claims to answer. `code` is what
// the Worker issued: { address, exact_units, nonce, issuedAtMs }.
// Returns { ok: true } or { ok: false, error } — never throws.
export function verifyJoinSubmission({ poolAddress, code, prepared, signature, nonce, nowMs }) {
  const fail = error => ({ ok: false, error });
  if (!code || !prepared || typeof prepared !== 'object' || Array.isArray(prepared)) return fail('format');
  const keys = Object.keys(prepared).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['addr', 'kind', 'nonce', 'text', 'ts', 'v'])) return fail('format');
  if (prepared.v !== 1 || prepared.kind !== 'agent') return fail('format');
  if (!HEX64.test(prepared.addr ?? '') || !JOIN_NONCE_RE.test(prepared.nonce ?? '')) return fail('format');
  if (!Number.isSafeInteger(prepared.ts) || typeof prepared.text !== 'string') return fail('format');
  if (nonce !== prepared.nonce || nonce !== code.nonce) return fail('nonce');
  if (prepared.addr !== code.address) return fail('address');
  if (prepared.text !== joinText(poolAddress, prepared.addr, code.exact_units, prepared.nonce)) return fail('text');
  if (nowMs != null && nowMs - code.issuedAtMs > JOIN_CODE_TTL_MS) return fail('expired');
  if (nowMs != null && Math.abs(prepared.ts - nowMs) > JOIN_CODE_TTL_MS + 120000) return fail('stale_ts');
  if (!ed25519Verify(agentSigningText(prepared), signature, prepared.addr)) return fail('signature');
  return { ok: true };
}

export { stableJSON };

// RESET pool — member-exit verification and planning primitives.
//
// Identity proof for an exit is an official-protocol signed message, NOT a
// transfer: members' coins sit inside the pool, so their own wallets may
// hold a zero balance — any design that asks them to move coins first
// would lock exactly the people the pool exists for out of exiting.
// Signing costs nothing and works at zero balance.
//
// The signed object is a chat-protocol agent message, byte-for-byte the
// construction every RESET node already verifies (~/workspace/reset
// features/chat/index.js):
//   prepared = { v: 1, kind: 'agent', addr, text, ts, nonce }
//   signing text = 'reset-chat/v1\n' + stableJSON(prepared minus nothing)
//   sig = Ed25519 over that text under the address's key (128 hex chars)
// with kind 'agent' — the only kind a wallet-signed message may carry.
// The gateway verifies chain moves as wallet.verify(sig,
// JSON.stringify(prepared) + nonce, address) (features/gateway/index.js);
// the verify PRIMITIVE is the same trac-wallet Ed25519 check — only the
// canonical payload differs, and for a signed statement (not a chain move)
// the chat construction is the protocol's format. verifyExitSignature
// below reproduces trac-wallet's PeerWallet.verify with node:crypto and
// is cross-checked against the real trac-wallet in test-exit.mjs.
//
// Flow: the registry Worker (POST /exit) issues the prepared object with a
// one-time server nonce (16 hex, 30-minute TTL — same lifetime as a calc
// record). The member (or their own AI, using the member's signer — see
// exit-sign.mjs) signs it and submits { prepared, signature, nonce } to
// POST /exit/verify. The pool-side executor (lib/exit-exec.mjs) verifies
// the signature locally and only then opens a case.
//
// Second lock, independent of the signature: exit proceeds are paid ONLY
// to the address recorded in the ledger for that position. No request
// field anywhere can name a different payee — the signature stops a
// stranger from kicking a member out; the payee lock stops theft of the
// payout itself.
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { checkConservation, MIN_DEPOSIT } from './pool.mjs';

export const EXIT_DOMAIN = 'reset-chat/v1\n';
export const EXIT_INTENT_TTL_MS = 30 * 60 * 1000; // matches the registry TTL for calc records
export const EXIT_WAIT_BLOCKS = 144;              // contract exit_wait (DEFAULT_PARAMS)
export const EXIT_NONCE_RE = /^[0-9a-f]{16}$/;
export const EXIT_SIG_RE = /^[0-9a-f]{128}$/;
const HEX64 = /^[0-9a-f]{64}$/;

// Byte-for-byte port of the official stableJSON (contract/rules/json.js):
// object keys sorted, primitives via JSON.stringify, null for null/undefined.
export function stableJSON(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJSON(value[k])}`).join(',')}}`;
}

// The human-readable statement the member signs. Single line, plain words,
// well inside the chat text rules (features/chat/text.js: max 240 chars,
// no links / code / foreign addresses) — verified against the official
// checkText in test-exit.mjs. The nonce inside the TEXT binds the
// statement a human reads to the one-time registry intent.
export function exitText(poolAddress, address, nonce) {
  return `EXIT full pool position. Pool ${poolAddress} member ${address} nonce ${nonce}`;
}

export function buildPrepared({ poolAddress, address, nonce, ts }) {
  return { v: 1, kind: 'agent', addr: address, text: exitText(poolAddress, address, nonce), ts, nonce };
}

// Exactly the official agentSigningText (features/chat/index.js): it
// destructures these six fields and stable-serializes them, so extra
// fields on the input never enter the signed bytes.
export function agentSigningText({ v, kind, addr, text, ts, nonce }) {
  return EXIT_DOMAIN + stableJSON({ v, kind, addr, text, ts, nonce });
}

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
export function ed25519Verify(messageUtf8, signatureHex, publicKeyHex) {
  try {
    if (!EXIT_SIG_RE.test(signatureHex ?? '') || !HEX64.test(publicKeyHex ?? '')) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
    return cryptoVerify(null, Buffer.from(messageUtf8, 'utf8'), key, Buffer.from(signatureHex, 'hex'));
  } catch { return false; }
}

// Full structural + cryptographic verification of a submitted exit
// signature against the registry intent it claims to answer. `intent` is
// what the server issued: { address, nonce, prepared }. Returns
// { ok: true } or { ok: false, error } — never throws on bad input.
export function verifyExitSubmission({ poolAddress, intent, prepared, signature, nonce, submittedAtMs, nowMs }) {
  const fail = error => ({ ok: false, error });
  if (!intent || !prepared || typeof prepared !== 'object' || Array.isArray(prepared)) return fail('format');
  const keys = Object.keys(prepared).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['addr', 'kind', 'nonce', 'text', 'ts', 'v'])) return fail('format');
  if (prepared.v !== 1 || prepared.kind !== 'agent') return fail('format');
  if (!HEX64.test(prepared.addr ?? '') || !EXIT_NONCE_RE.test(prepared.nonce ?? '')) return fail('format');
  if (!Number.isSafeInteger(prepared.ts) || typeof prepared.text !== 'string') return fail('format');
  if (nonce !== prepared.nonce || nonce !== intent.nonce) return fail('nonce');
  if (prepared.addr !== intent.address) return fail('address');
  if (stableJSON(prepared) !== stableJSON(intent.prepared)) return fail('prepared_mismatch');
  if (prepared.text !== exitText(poolAddress, prepared.addr, prepared.nonce)) return fail('text');
  // The intent lives 30 minutes: a submission that arrived after expiry is
  // dead even if someone verifies it late (the nonce itself is burned at
  // first submission by the registry, so replay is rejected there too).
  if (submittedAtMs != null && submittedAtMs - intent.issuedAtMs > EXIT_INTENT_TTL_MS) return fail('expired');
  if (nowMs != null && Math.abs(prepared.ts - nowMs) > EXIT_INTENT_TTL_MS + 120000) return fail('stale_ts');
  if (!ed25519Verify(agentSigningText(prepared), signature, prepared.addr)) return fail('signature');
  return { ok: true };
}

// --- Execution planning ----------------------------------------------------
// Charter rule 3: before a case's unlock, project the pool deposit AFTER
// paying this case out (its full due comes out of the locked deposit —
// pending earnings are part of the same locked total). Strictly below
// MIN_DEPOSIT dissolves the pool; exactly MIN_DEPOSIT does not.
// The unlock move itself must satisfy the contract's per-move minimum:
// unlock max(due, MIN_DEPOSIT), capped by what is actually deposited; any
// excess over the due simply lands in the pool balance when withdrawn.
export function planExit({ chainDepositUnits, dueUnits }) {
  const deposit = BigInt(chainDepositUnits), due = BigInt(dueUnits);
  const after = deposit - due;
  const dissolve = due > 0n && after < MIN_DEPOSIT;
  const unlockUnits = dissolve ? deposit : (due > MIN_DEPOSIT ? due : MIN_DEPOSIT);
  return { dissolve, afterUnits: after, unlockUnits: unlockUnits > deposit ? deposit : unlockUnits };
}

// Conservation self-check the executor runs before EVERY money-moving
// step. Two layers:
//  (a) the ledger's own earnings identity (lib/pool.mjs checkConservation)
//      plus the event hash chain — the books must be internally exact;
//  (b) solvency against the chain: ledger obligations (all contributed
//      principal + all pending earnings + carry + fees) must never exceed
//      the pool's actual assets (balance + deposit + maturing exits).
//      Assets may exceed obligations (a settlement can land on-chain
//      before the ledger records it) — that slack is reported, not an
//      error. Obligations exceeding assets means the books claim money
//      the pool does not have: halt, never proceed.
export function checkExitConservation(ledger, chain) {
  const problems = [];
  const cons = checkConservation(ledger);
  if (!cons.ok) problems.push(`ledger conservation broken: claims ${cons.claimed} != pending ${cons.pending} + paid ${cons.paid} + fees ${cons.fees} + carry ${cons.carry}`);
  const obligations = Object.values(ledger.contributors).reduce((s, c) => s + BigInt(c.contributed) + BigInt(c.pending), 0n)
    + BigInt(ledger.carry_units) + BigInt(ledger.fee_total_units);
  let assets = null;
  if (chain) {
    const exitsTotal = (chain.exits ?? []).reduce((s, e) => s + BigInt(e.amount ?? 0), 0n);
    assets = BigInt(chain.balance ?? 0) + BigInt(chain.deposit ?? 0) + exitsTotal;
    if (obligations > assets) problems.push(`obligations ${obligations} exceed chain assets ${assets}`);
  }
  return { ok: problems.length === 0, problems, obligations, assets,
    slack: assets === null ? null : assets - obligations };
}

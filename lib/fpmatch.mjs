// RESET pool — self-service amount fingerprints + inflow attribution.
//
// Why this exists: the gateway exposes NO transfer history, so a transfer
// that lands in the pool address cannot be attributed to its sender after
// the fact. Instead of a registration desk, the fingerprint is derived
// deterministically from the sender's OWN address — anyone can compute it
// locally (the website does it in the visitor's browser), no sign-up, no
// GitHub account, no operator round-trip:
//
//   planned amount : any multiple of 0.01 RESET (1_000_000 units)
//   fingerprint fp : (sha256(address string)[0..4] as uint32 BE) mod 999999 + 1
//                    → 1..999999 units (the "tail")
//   exact send     : planned + fp        (credited IN FULL on arrival)
//
// Attribution is reverse lookup: an unexplained pool inflow D is split into
// base = D rounded down to a 0.01 multiple and tail = D - base; if EXACTLY
// ONE plausible sender address has fp == tail, the inflow is credited to it.
// Zero or multiple hits → the amount is parked in the unclaimed list and
// NEVER guessed. The same tail check powers claiming: an amount whose tail
// equals fp(your address) was constructed for your address, so presenting
// that address (nothing else — no signature, no account) claims it. An
// amount with tail 0 (a round amount, e.g. a plain 0.05 transfer) can never
// be fingerprint-claimed by anyone.
import { createHash } from 'node:crypto';
import { addContribution, isAddress } from './pool.mjs';

// --- Address formats: 64-hex and trac1 are ONE key in two encodings ------
// A RESET address is a 32-byte public key. It is written either as 64 hex
// characters or as a bech32m string (BIP-350) with HRP "trac" whose payload
// is those very 32 bytes — no version byte (verified against real wallet
// pairs: decoding a wallet's trac1 address reproduces its hex address
// exactly). normalizeAddress maps either spelling to the canonical
// lowercase hex, so the fingerprint — and everything downstream — never
// depends on which form a member copied out of their wallet software.
const B32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const B32_REV = new Map([...B32_CHARSET].map((c, i) => [c, i]));
const BECH32M_CONST = 0x2bc830a3;

function b32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}
function b32HrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}
function b32ConvertBits(data, from, to, pad) {
  let acc = 0, bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v; bits += from;
    while (bits >= to) { bits -= to; out.push((acc >>> bits) & maxv); }
  }
  if (pad) { if (bits) out.push((acc << (to - bits)) & maxv); }
  else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) return null;
  return out;
}

// hex -> trac1… (canonical lowercase bech32m).
export function encodeTracAddress(address) {
  if (!isAddress(address)) throw new Error(`bad address: ${address}`);
  const data = b32ConvertBits([...Buffer.from(address, 'hex')], 8, 5, true);
  const pm = b32Polymod([...b32HrpExpand('trac'), ...data, 0, 0, 0, 0, 0, 0]) ^ BECH32M_CONST;
  let out = 'trac1';
  for (const v of data) out += B32_CHARSET[v];
  for (let i = 0; i < 6; i++) out += B32_CHARSET[(pm >>> (5 * (5 - i))) & 31];
  return out;
}

// trac1… -> lowercase hex, or null when the string is not a valid trac
// bech32m encoding of exactly 32 bytes (bad characters, bad checksum,
// mixed case, wrong HRP, wrong payload length).
export function decodeTracAddress(addr) {
  if (typeof addr !== 'string') return null;
  const s = addr.trim();
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return null; // bech32 forbids mixed case
  const a = s.toLowerCase();
  const pos = a.lastIndexOf('1');
  if (pos < 1 || a.slice(0, pos) !== 'trac') return null;
  const part = a.slice(pos + 1);
  if (part.length < 6) return null;
  const data = [...part].map(c => B32_REV.get(c));
  if (data.some(v => v === undefined)) return null;
  if (b32Polymod([...b32HrpExpand('trac'), ...data]) !== BECH32M_CONST) return null;
  const bytes = b32ConvertBits(data.slice(0, -6), 5, 8, false);
  if (!bytes || bytes.length !== 32) return null;
  return Buffer.from(bytes).toString('hex');
}

// Canonical form of any address spelling: lowercase 64-hex, or null when
// the input is neither valid hex (any case) nor a valid trac1 address.
export function normalizeAddress(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  if (/^trac1/i.test(s)) return decodeTracAddress(s);
  return null;
}

export const FP_MOD = 999999;
export const PLANNED_STEP = 1_000_000n; // 0.01 RESET in units

export function fingerprint(address) {
  const norm = normalizeAddress(address);
  if (!norm) throw new Error(`bad address: ${address}`);
  const h = createHash('sha256').update(norm, 'utf8').digest();
  return (h.readUInt32BE(0) % FP_MOD) + 1; // 1..999999 (a Number)
}
export const fingerprintUnits = address => BigInt(fingerprint(address));

export function sendAmountFor(address, plannedUnits) {
  const planned = BigInt(plannedUnits);
  if (planned <= 0n || planned % PLANNED_STEP !== 0n) {
    throw new Error('planned amount must be a positive multiple of 0.01 RESET');
  }
  return planned + fingerprintUnits(address);
}

export function splitTail(amountUnits) {
  const a = BigInt(amountUnits);
  const base = (a / PLANNED_STEP) * PLANNED_STEP;
  return { base, tail: a - base };
}

// Reverse-lookup attribution of one net inflow. `candidates` is the list of
// plausible sender addresses. Returns the unique match or null; `hits`
// exposes how many candidates shared the tail (0 or >=2 both mean: park it).
export function attributeIncrement(inflowUnits, candidates) {
  const { base, tail } = splitTail(inflowUnits);
  if (tail === 0n || base < PLANNED_STEP) return { match: null, hits: [], tail, base };
  const hits = [...new Set(candidates)].filter(a => isAddress(a) && fingerprintUnits(a) === tail);
  return { match: hits.length === 1 ? hits[0] : null, hits, tail, base };
}

export function emptyMatcher(poolAddress) {
  return { v: 1, pool_address: poolAddress, last_total_units: null, accounted_settle_round: null, updated_at: null };
}
export function emptyUnclaimed() { return { v: 1, next_id: 1, entries: [] }; }
export function emptyFpCache() { return { v: 1, matches: {} }; }

function parkUnclaimed(unclaimed, { amountUnits, tailUnits, kind, now, note }) {
  const entry = { id: unclaimed.next_id++, amount_units: BigInt(amountUnits).toString(),
    tail_units: BigInt(tailUnits).toString(), kind, status: 'open',
    detected_at: now, claimed_by: null, claimed_at: null, note: note ?? null };
  unclaimed.entries.push(entry);
  return entry;
}

// One observation of the pool's on-chain position, folded into the books.
//   obs = { totalUnits, lastResult: {r, amount} | null, now }
//   ctx = { matcher, unclaimed, ledger, fpCache, candidates }
// Mutates ctx states; returns the list of actions taken (for logging).
//
// Accounting rules (the "口径"):
// - Position is tracked as balance + deposit (units). Lock moves coins
//   balance->deposit and payout waits change neither, so the total only
//   moves on: external inflows, settled claim earnings, operator outflows.
// - A newly settled round (gateway mine.last_result) explains its amount
//   of inflow: earnings are NEVER contributions. Only the latest settled
//   round is visible on the gateway; with a 1-minute cadence at most one
//   settlement lands between observations in practice. Any remainder that
//   cannot be explained is attributed by fingerprint or parked — never
//   guessed, never silently dropped.
// - First ever observation only sets the baseline; a positive pre-existing
//   total is parked as unclaimed (it arrived before fingerprinting existed).
export function processObservation(obs, ctx) {
  const { matcher, unclaimed, ledger, fpCache } = ctx;
  const total = BigInt(obs.totalUnits);
  const now = obs.now ?? new Date().toISOString();
  const actions = [];
  if (matcher.last_total_units === null || matcher.last_total_units === undefined) {
    matcher.last_total_units = total.toString();
    matcher.accounted_settle_round = obs.lastResult?.r ?? null;
    matcher.updated_at = now;
    actions.push({ type: 'init', total_units: total.toString() });
    if (total > 0n) {
      const { tail } = splitTail(total);
      const e = parkUnclaimed(unclaimed, { amountUnits: total, tailUnits: tail, kind: 'pre_existing', now,
        note: 'balance already in the pool when fingerprint matching was activated; sender unknown' });
      actions.push({ type: 'unclaimed', entry_id: e.id, amount_units: e.amount_units, kind: e.kind });
    }
    return actions;
  }
  const delta = total - BigInt(matcher.last_total_units);
  let explained = 0n;
  if (obs.lastResult && obs.lastResult.r != null &&
      (matcher.accounted_settle_round === null || obs.lastResult.r > matcher.accounted_settle_round)) {
    explained = BigInt(obs.lastResult.amount);
    matcher.accounted_settle_round = obs.lastResult.r;
    actions.push({ type: 'settlement_explained', round: obs.lastResult.r, amount_units: explained.toString() });
  }
  if (delta < 0n) {
    actions.push({ type: 'outflow', amount_units: (-delta).toString(), note: 'operator-side movement; not attributed' });
  } else if (delta > 0n) {
    let candidate = delta - explained;
    if (candidate < 0n) {
      actions.push({ type: 'over_explained', delta_units: delta.toString(), explained_units: explained.toString() });
      candidate = 0n;
    }
    if (candidate > 0n) {
      const candidates = (ctx.candidates ?? []).filter(a => a !== ledger.pool_address);
      const { match, hits, tail } = attributeIncrement(candidate, candidates);
      if (match) {
        addContribution(ledger, match, candidate, { source: 'fingerprint-auto', fp_tail_units: tail.toString(), detected_at: now });
        fpCache.matches[match] = fingerprint(match);
        actions.push({ type: 'credited', address: match, amount_units: candidate.toString(), fp_tail_units: tail.toString() });
      } else {
        const e = parkUnclaimed(unclaimed, { amountUnits: candidate, tailUnits: tail, kind: 'unattributed_inflow', now,
          note: hits.length ? `fingerprint collision: ${hits.length} candidate addresses share this tail` : 'no candidate address with this fingerprint tail' });
        actions.push({ type: 'unclaimed', entry_id: e.id, amount_units: e.amount_units, kind: e.kind, hits: hits.length });
      }
    }
  }
  matcher.last_total_units = total.toString();
  matcher.updated_at = now;
  return actions;
}

// Locate an open unclaimed entry by id (number / numeric string) or, failing
// that, by exact amount in units (BigInt / numeric string). Amount lookup
// must be unique among open entries.
export function findUnclaimedEntry(unclaimed, ref) {
  const open = unclaimed.entries.filter(e => e.status === 'open');
  if (typeof ref === 'number' || (typeof ref === 'string' && /^\d+$/.test(ref))) {
    const byId = open.find(e => e.id === Number(ref));
    if (byId) return byId;
  }
  let amount;
  try { amount = BigInt(ref); } catch { throw new Error(`unclaimed entry not found: ${ref}`); }
  const byAmount = open.filter(e => BigInt(e.amount_units) === amount);
  if (byAmount.length === 1) return byAmount[0];
  if (byAmount.length > 1) throw new Error(`amount ${amount} matches ${byAmount.length} open entries — claim by entry id instead`);
  throw new Error(`unclaimed entry not found: ${ref}`);
}

// Claim a parked amount with nothing but the address it belongs to: the
// entry's tail must equal fp(address). On success the FULL amount is
// credited as that address's contribution and the entry is marked claimed.
export function claimEntry(ctx, ref, address) {
  const norm = normalizeAddress(address); // hex or trac1 — same key, same claim
  if (!norm) throw new Error(`bad address: ${address}`);
  address = norm;
  const entry = findUnclaimedEntry(ctx.unclaimed, ref);
  const fp = fingerprintUnits(address);
  if (fp !== BigInt(entry.tail_units)) {
    throw new Error(`fingerprint mismatch: this amount's tail is ${entry.tail_units}, address fingerprint is ${fp} — not claimable by this address`);
  }
  const now = ctx.now ?? new Date().toISOString();
  addContribution(ctx.ledger, address, BigInt(entry.amount_units),
    { source: 'fingerprint-claim', unclaimed_id: entry.id, detected_at: entry.detected_at });
  entry.status = 'claimed';
  entry.claimed_by = address;
  entry.claimed_at = now;
  return entry;
}

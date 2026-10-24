// RESET pool — self-service amount fingerprints + inflow attribution.
//
// Why this exists: the gateway exposes NO transfer history, so a transfer
// that lands in the pool address cannot be attributed to its sender after
// the fact. Instead of a registration desk, the fingerprint is derived
// deterministically from the sender's OWN address — anyone can compute it
// locally (the website does it in the visitor's browser), no sign-up, no
// GitHub account, no operator round-trip:
//
//   planned amount : any multiple of 0.001 RESET (100_000 units)
//   fingerprint fp : (sha256(address string)[0..4] as uint32 BE) mod 99999 + 1
//                    → 1..99999 units (the "tail")
//   exact send     : planned + fp        (credited IN FULL on arrival)
//
// SCHEME HISTORY (2026-10-24, operator ruling: already-booked ledger
// entries are NEVER rewritten; only future codes and inflows change):
//   v1 (until 2026-10-24): planned step 0.01, tail mod 999999 + 1.
//   v2 (current): planned step 0.001, tail mod 99999 + 1 — so a member
//   holding exactly 0.01 can join (v1's minimum exact send was
//   0.01000001, above their whole balance), and a 0.01 plan costs
//   ~0.0101 instead of ~0.019. v1 math is kept FOREVER as a second
//   key: old parked entries stay claimable, old-scheme inflows that
//   arrive late still attribute, and old registry records still match.
//   The ledger itself is a hash chain — no past event is ever edited,
//   restated, or re-derived under the new math.
//
// Attribution priority (operator ruling, 2026-10-22 — after the tail-216449
// incident, where a member's filed calculation sat in the registry unused
// while the matcher parked their inflow as unclaimed):
//   0. AI-JOIN SIGNED CLAIM FIRST (branch ai-join). If the registry
//      holds a PENDING join claim (a receipt the Worker verified
//      cryptographically: official agent signature over the exact
//      amount + code nonce, under the claimant's own key) whose exact
//      amount equals the inflow, the inflow is credited to that address
//      (source 'ai-join'). A signed claim outranks a mere calculation:
//      the calculation says "someone intends to send this amount", the
//      claim says "this key's owner attests the transfer happened".
//      Same conflict discipline as the registry: several addresses
//      claiming one exact amount parks the inflow, never guesses.
//   1. CALCULATION REGISTRY FIRST. If the registry holds a calc record
//      whose (tail, exact amount) matches the inflow EXACTLY and names ONE
//      address, the inflow is credited to that address
//      (source 'registry-calc'). The public network list is NOT consulted
//      for such an inflow: the tail spaces are small (99999 values in
//      v2, 999999 in v1), so as the network grows, fingerprint
//      collisions are guaranteed — the filed calculation is the
//      tie-breaker that says whose amount this actually was. (Registry
//      amounts are server-revalidated at filing time: the stored
//      fingerprint is the Worker's own recomputation for the filed
//      address, never the client's claim.)
//   2. FINGERPRINT REVERSE LOOKUP IS THE FALLBACK, used only when the
//      registry has NO exact (tail, exact) record for the amount — it
//      covers transfers that were never calculated in the registry and
//      calculations from before the registry existed. An unexplained pool
//      inflow D is split into base = D rounded down to a 0.001 multiple
//      and tail = D - base (and, for pre-change inflows, under the v1
//      0.01-multiple split as well); if EXACTLY ONE plausible sender
//      address has fp == tail under either scheme, the inflow is
//      credited to it (source 'fingerprint-auto'). Zero or multiple
//      hits → the amount is parked in the unclaimed list and NEVER
//      guessed.
// The same tail check powers claiming: an amount whose tail equals
// fp(your address) was constructed for your address, so presenting that
// address (nothing else — no signature, no account) claims it. An
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

export const FP_MOD = 99999;
export const PLANNED_STEP = 100_000n; // 0.001 RESET in units
// v1 (pre-2026-10-24) constants, kept forever as the second key — see
// the scheme note at the top of this file.
export const LEGACY_FP_MOD = 999999;
export const LEGACY_PLANNED_STEP = 1_000_000n; // 0.01 RESET in units

export function fingerprint(address) {
  const norm = normalizeAddress(address);
  if (!norm) throw new Error(`bad address: ${address}`);
  const h = createHash('sha256').update(norm, 'utf8').digest();
  return (h.readUInt32BE(0) % FP_MOD) + 1; // 1..99999 (a Number)
}
export const fingerprintUnits = address => BigInt(fingerprint(address));

// v1 fingerprint: identical hash, old modulus. Used ONLY to keep old
// parked entries claimable and late old-scheme inflows attributable —
// never to issue a new code or calculation.
export function legacyFingerprint(address) {
  const norm = normalizeAddress(address);
  if (!norm) throw new Error(`bad address: ${address}`);
  const h = createHash('sha256').update(norm, 'utf8').digest();
  return (h.readUInt32BE(0) % LEGACY_FP_MOD) + 1; // 1..999999 (a Number)
}
export const legacyFingerprintUnits = address => BigInt(legacyFingerprint(address));

export function sendAmountFor(address, plannedUnits) {
  const planned = BigInt(plannedUnits);
  if (planned <= 0n || planned % PLANNED_STEP !== 0n) {
    throw new Error('planned amount must be a positive multiple of 0.001 RESET');
  }
  return planned + fingerprintUnits(address);
}

export function splitTail(amountUnits) {
  const a = BigInt(amountUnits);
  const base = (a / PLANNED_STEP) * PLANNED_STEP;
  return { base, tail: a - base };
}

export function splitTailLegacy(amountUnits) {
  const a = BigInt(amountUnits);
  const base = (a / LEGACY_PLANNED_STEP) * LEGACY_PLANNED_STEP;
  return { base, tail: a - base };
}

// Does this address's fingerprint explain this amount under EITHER
// scheme? The tail is derived from the amount itself (not from a stored
// tail field), so old entries stay claimable after the scheme change
// and new entries work under the new math. Guards mirror the issuing
// rules: a round amount (tail 0) matches nobody, and the planned part
// must be at least one step. Returns { match, scheme } — scheme is
// 'v2', 'v1', or null.
export function fingerprintMatchesAmount(address, amountUnits) {
  const norm = normalizeAddress(address);
  if (!norm) return { match: false, scheme: null };
  const a = BigInt(amountUnits);
  const { base, tail } = splitTail(a);
  if (tail !== 0n && base >= PLANNED_STEP && fingerprintUnits(norm) === tail) {
    return { match: true, scheme: 'v2' };
  }
  const leg = splitTailLegacy(a);
  if (leg.tail !== 0n && leg.base >= LEGACY_PLANNED_STEP && legacyFingerprintUnits(norm) === leg.tail) {
    return { match: true, scheme: 'v1' };
  }
  return { match: false, scheme: null };
}

// Reverse-lookup attribution of one net inflow. `candidates` is the list of
// plausible sender addresses. Both schemes are tried; the union of hits
// decides — exactly one hit credits, zero or several park (never guess).
// `tail`/`base` in the result are the MATCHING scheme's decomposition
// (so ledger events and registry fulfill/hold keys use the tail the
// sender actually filed under); with no match they default to the v2
// decomposition for display. `scheme` names which key matched.
export function attributeIncrement(inflowUnits, candidates) {
  const { base, tail } = splitTail(inflowUnits);
  const leg = splitTailLegacy(inflowUnits);
  const uniq = [...new Set(candidates)];
  const hitsNew = (tail !== 0n && base >= PLANNED_STEP)
    ? uniq.filter(a => isAddress(a) && fingerprintUnits(a) === tail) : [];
  const hitsLegacy = (leg.tail !== 0n && leg.base >= LEGACY_PLANNED_STEP)
    ? uniq.filter(a => isAddress(a) && legacyFingerprintUnits(a) === leg.tail) : [];
  const hits = [...new Set([...hitsNew, ...hitsLegacy])];
  if (hits.length === 1) {
    const m = hits[0];
    if (hitsNew.includes(m) && !hitsLegacy.includes(m)) {
      return { match: m, hits, tail, base, scheme: 'v2' };
    }
    if (hitsLegacy.includes(m) && !hitsNew.includes(m)) {
      return { match: m, hits, tail: leg.tail, base: leg.base, scheme: 'v1' };
    }
    // One address matching under BOTH schemes (its two fingerprints
    // happen to fit both decompositions): the v2 decomposition is the
    // current key; the credit is unambiguous because it is one address.
    return { match: m, hits, tail, base, scheme: 'v2' };
  }
  return { match: null, hits, tail, base, scheme: null };
}

// Preview — WITHOUT mutating anything — the unattributed candidate amount
// an observation is about to produce (the same delta/settlement arithmetic
// processObservation applies). The runner uses it to consult the registry
// for exactly the (tail, amount) that is about to need attribution.
// Returns null when there is no baseline yet, else a BigInt >= 0.
export function previewInflowCandidate(obs, matcher) {
  if (matcher.last_total_units === null || matcher.last_total_units === undefined) return null;
  const delta = BigInt(obs.totalUnits) - BigInt(matcher.last_total_units);
  if (delta <= 0n) return 0n;
  let explained = 0n;
  if (obs.lastResult && obs.lastResult.r != null &&
      (matcher.accounted_settle_round === null || obs.lastResult.r > matcher.accounted_settle_round)) {
    explained = BigInt(obs.lastResult.amount);
  }
  const candidate = delta - explained;
  return candidate > 0n ? candidate : 0n;
}

// Decide what the calculation registry says about one inflow amount.
// `records` are the registry rows for the inflow's tail (all kinds; the
// caller fetches them). Only kind='calc' rows count — a 'calc_blocked'
// row documents a REJECTED calculation (e.g. with the pool's own
// address) and can never name a sender. A row is an exact hit when its
// exact_units equals the inflow amount AND its status is 'ok' (filed,
// awaiting the transfer) or 'held' (the matcher itself froze it as
// evidence for a parked entry). 'fulfilled' rows are already consumed
// by an earlier credit and never credit twice.
//   one address among exact hits  → { type: 'credit', address, records }
//   several addresses, same exact → { type: 'conflict', addresses, records }
//   no exact hit                   → { type: 'none', tailRecords }
// The registry is consulted FIRST (see the priority note at the top of
// this file); 'none' is what hands the inflow to the fingerprint
// fallback, and tailRecords then feeds the parked entry's note so a
// human can see what WAS filed for this tail.
export function decideRegistryAttribution(records, amountUnits) {
  const amount = BigInt(amountUnits);
  const calcs = (records ?? []).filter(r => r && r.kind === 'calc');
  const exact = calcs.filter(r => (r.status === 'ok' || r.status === 'held') &&
    r.address_hex && r.exact_units !== null && r.exact_units !== undefined &&
    BigInt(r.exact_units) === amount);
  const addresses = [...new Set(exact.map(r => r.address_hex))];
  if (addresses.length === 1) return { type: 'credit', address: addresses[0], records: exact };
  if (addresses.length > 1) return { type: 'conflict', addresses, records: exact };
  return { type: 'none', tailRecords: calcs };
}

// One-line summary of what the registry holds for a tail when none of it
// exactly matches the inflow — appended to a parked entry's note so the
// record never again says a bare "no candidate" while the registry in
// fact has data. Empty string when the registry has nothing for the tail.
export function registryNoteSuffix(records, amountUnits) {
  const calcs = (records ?? []).filter(r => r && r.kind === 'calc');
  if (!calcs.length) return '';
  const shown = calcs.slice(-3).map(r =>
    `${(r.address_hex ?? '?').slice(0, 12)}… planned ${r.planned_units ?? '?'} exact ${r.exact_units ?? '?'} status ${r.status} at ${r.ts}`);
  return `; registry has ${calcs.length} calc record(s) for this tail but no exact unfulfilled match for ${BigInt(amountUnits)}: ${shown.join(' | ')}${calcs.length > 3 ? ' | …' : ''}`;
}

// Decide what the pending AI-join claims say about one inflow amount.
// `claims` are pending join-claim rows {address_hex, exact_units, nonce}
// (already signature-verified by the Worker at claim time — see
// lib/join.mjs). Only exact-amount matches count.
//   one address among exact hits  → { type: 'credit', address, claim }
//   several addresses, same exact → { type: 'conflict', addresses }
//   no exact hit                   → { type: 'none' }
export function decideJoinAttribution(claims, amountUnits, poolAddress = null) {
  const amount = BigInt(amountUnits);
  const exact = (claims ?? []).filter(c => c && c.address_hex &&
    (poolAddress === null || c.address_hex !== poolAddress) &&
    c.exact_units !== null && c.exact_units !== undefined && BigInt(c.exact_units) === amount);
  const addresses = [...new Set(exact.map(c => c.address_hex))];
  if (addresses.length === 1) {
    const claim = exact.find(c => c.address_hex === addresses[0]);
    return { type: 'credit', address: addresses[0], claim };
  }
  if (addresses.length > 1) return { type: 'conflict', addresses };
  return { type: 'none' };
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
//   ctx = { matcher, unclaimed, ledger, fpCache, candidates,
//           registryDecision? } — a decision from
//           decideRegistryAttribution for this exact inflow amount,
//           { amount_units, mode: 'credit'|'park'|'fallback', ... };
//           honored only when its amount equals the computed candidate.
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
      const { tail } = splitTail(candidate);
      // Attribution priority (see the note at the top of this file):
      // 0. a join decision for EXACTLY this amount (ctx.joinDecision,
      //    from decideJoinAttribution over pending join claims) wins
      //    over everything; 1. a registry decision (ctx.registryDecision,
      //    from decideRegistryAttribution); 'credit' and 'park' are
      //    final in both cases — the fingerprint fallback is not
      //    consulted for either. 'fallback' / no decision → the classic
      //    reverse lookup below.
      const jd = ctx.joinDecision && BigInt(ctx.joinDecision.amount_units) === candidate
        ? ctx.joinDecision : null;
      const rd = ctx.registryDecision && BigInt(ctx.registryDecision.amount_units) === candidate
        ? ctx.registryDecision : null;
      if (jd?.mode === 'credit' && jd.address !== ledger.pool_address) {
        addContribution(ledger, jd.address, candidate, { source: 'ai-join', join_claim_nonce: jd.claim_nonce ?? null,
          fp_tail_units: tail.toString(), detected_at: now });
        fpCache.matches[jd.address] = fingerprint(jd.address);
        actions.push({ type: 'credited', via: 'ai-join', address: jd.address, amount_units: candidate.toString(),
          fp_tail_units: tail.toString(), join_claim_nonce: jd.claim_nonce ?? null });
      } else if (jd?.mode === 'park') {
        const e = parkUnclaimed(unclaimed, { amountUnits: candidate, tailUnits: tail, kind: 'unattributed_inflow', now, note: jd.note });
        actions.push({ type: 'unclaimed', entry_id: e.id, amount_units: e.amount_units, kind: e.kind, hits: 0, join_conflict: true });
      } else if (rd?.mode === 'credit' && rd.address !== ledger.pool_address) {
        // What would pure fingerprinting have said? Only for the paper
        // trail: when it names a DIFFERENT unique sender, the tail has
        // collided across the network (small tail spaces, v2 99999 /
        // v1 999999 values) and the registry record is the arbiter —
        // the collision is written into the ledger event so the books
        // show the decision.
        // The ledger/fulfill tail is the matched record's OWN fp_units
        // (carried on the decision): a v1 record's v1 tail, not the
        // v2 decomposition of the same amount.
        const regTail = rd.tail_units ?? tail.toString();
        const fp = attributeIncrement(candidate, candidates);
        const collision = fp.match && fp.match !== rd.address ? fp.match : null;
        addContribution(ledger, rd.address, candidate, { source: 'registry-calc', fp_tail_units: regTail, detected_at: now,
          ...(collision ? { note: `registry attribution prevailed over fingerprint candidate ${collision}: same tail, registry record is the tie-breaker` } : {}) });
        fpCache.matches[rd.address] = fingerprint(rd.address);
        actions.push({ type: 'credited', via: 'registry', address: rd.address, amount_units: candidate.toString(), fp_tail_units: regTail,
          ...(collision ? { fp_collision: collision } : {}) });
      } else if (rd?.mode === 'park') {
        const e = parkUnclaimed(unclaimed, { amountUnits: candidate, tailUnits: tail, kind: 'unattributed_inflow', now, note: rd.note });
        actions.push({ type: 'unclaimed', entry_id: e.id, amount_units: e.amount_units, kind: e.kind, hits: 0, registry_conflict: true });
      } else {
        const { match, hits, tail: matchTail, scheme } = attributeIncrement(candidate, candidates);
        if (match) {
          // Use the MATCHING scheme's tail for the ledger event and
          // the registry fulfill key — a v1 inflow's v2 decomposition
          // is a different number and would key nothing.
          addContribution(ledger, match, candidate, { source: 'fingerprint-auto', fp_tail_units: matchTail.toString(), detected_at: now });
          fpCache.matches[match] = scheme === 'v1' ? legacyFingerprint(match) : fingerprint(match);
          actions.push({ type: 'credited', address: match, amount_units: candidate.toString(), fp_tail_units: matchTail.toString() });
        } else {
          const baseNote = hits.length ? `fingerprint collision: ${hits.length} candidate addresses share this tail` : 'no candidate address with this fingerprint tail';
          const e = parkUnclaimed(unclaimed, { amountUnits: candidate, tailUnits: tail, kind: 'unattributed_inflow', now,
            note: baseNote + (rd?.mode === 'fallback' ? (rd.parkNoteSuffix ?? '') : '') });
          actions.push({ type: 'unclaimed', entry_id: e.id, amount_units: e.amount_units, kind: e.kind, hits: hits.length });
        }
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
  return claimEntryAs(ctx, ref, address, {});
}

// claimEntry with explicit bookkeeping: the ledger event's source, and
// optional method / resolution markers on the entry itself. The matcher's
// registry retro-pass claims with source 'registry-calc' + method
// 'registry' — the address it passes comes from a registry record whose
// stored fingerprint the Worker revalidated at filing time, so the tail
// check below passes by construction; it stays as a hard assertion
// regardless (a registry row that disagreed with the math would throw
// here instead of crediting the wrong address).
export function claimEntryAs(ctx, ref, address, { source = 'fingerprint-claim', method = null, resolution = null, joinClaimNonce = null } = {}) {
  const norm = normalizeAddress(address); // hex or trac1 — same key, same claim
  if (!norm) throw new Error(`bad address: ${address}`);
  address = norm;
  const entry = findUnclaimedEntry(ctx.unclaimed, ref);
  // Dual-scheme check (see fingerprintMatchesAmount): the tail is
  // derived from the entry's AMOUNT, so an entry parked under v1 stays
  // claimable after the v2 change, and a v2 entry works under v2.
  // The stored tail_units is display/lookup material, not the gate.
  const { match } = fingerprintMatchesAmount(address, BigInt(entry.amount_units));
  if (!match) {
    throw new Error(`fingerprint mismatch: this amount matches neither the current nor the legacy fingerprint of this address — not claimable by this address`);
  }
  const now = ctx.now ?? new Date().toISOString();
  // ai-join retro credits must carry the claim nonce in the ledger event,
  // same as fresh ai-join credits do — otherwise the credit cannot be
  // traced back to the signature-verified receipt that justified it.
  const meta = { source, unclaimed_id: entry.id, detected_at: entry.detected_at };
  if (joinClaimNonce) meta.join_claim_nonce = joinClaimNonce;
  addContribution(ctx.ledger, address, BigInt(entry.amount_units), meta);
  entry.status = 'claimed';
  entry.claimed_by = address;
  entry.claimed_at = now;
  if (method) entry.method = method;
  if (resolution) entry.resolution = resolution;
  return entry;
}

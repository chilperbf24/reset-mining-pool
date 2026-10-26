// RESET pool — calculation registry Worker (Cloudflare, D1-backed).
//
// Why this exists: the public join calculator used to compute a member's
// exact transfer amount purely in the visitor's browser and keep NO
// record anywhere, so reconciling an inflow that failed fingerprint
// matching meant reverse-engineering the amount's tail by hand (it
// happened: tail 661039 turned out to be the fingerprint of the POOL's
// own address — someone had calculated with the pool address). From now
// on every calculation is filed here: {address, planned, fingerprint,
// exact amount, outcome}, plus operator imports and matcher outcomes
// backfilled alongside (see ../backfill.sql), so any tail / address /
// amount can be looked up in one query.
//
// ATTRIBUTION ROLE — read before touching attribution logic anywhere:
//   Since the operator ruling of 2026-10-22 this registry is the
//   PRIMARY attribution source for pool inflows (the matcher in
//   lib/fprun.mjs + lib/fpmatch.mjs implements it): a calc record whose
//   (tail, exact amount) matches an inflow exactly and names ONE
//   address credits that address (source 'registry-calc'); fingerprint
//   reverse lookup over the network miner list is only the fallback
//   for amounts with no exact registry record. Rationale: the tail
//   spaces are small (99999 values in the v2 scheme since 2026-10-24,
//   999999 in the legacy v1 scheme), so network-wide fingerprint
//   collisions are inevitable as the address count grows — a filed
//   calculation is the tie-breaker that says whose amount it was.
//   v1 records already filed keep their stored fp_units untouched;
//   the pool-side matcher honors both schemes (lib/fpmatch.mjs).
//   POST /calc performs NO identity authentication (the calculator is
//   public, that openness is its purpose) — but the Worker revalidates
//   every filing server-side: the stored fingerprint is THIS code's
//   recomputation for the filed address, and exact must equal
//   planned + fp, so a row can only ever name the address whose
//   fingerprint the amount actually carries.
//
// Endpoints:
//   POST /calc    public, self-validating (address<->fingerprint re-check)
//   GET  /lookup  operator only (header X-Registry-Key == REGISTRY_KEY secret)
//   POST /fulfill operator only: mark calc records (by tail and/or
//                 address) as fulfilled when their inflow has landed
//   POST /hold    operator only: freeze the calc records behind a
//                 parked unclaimed entry (status 'held' — sweep-proof
//                 evidence until attribution lands)
//   POST /sweep   operator only: delete expired calc records (TTL below)
//   GET  /health  public: { ok, records } — count only, never any detail
//   EXIT CHANNEL STATUS (operator ruling, 2026-10-23): exits are
//   TEMPORARILY CLOSED while the pool is small and the exit executor's
//   full end-to-end live test is still outstanding. Unless the EXIT_OPEN
//   var is exactly '1', POST /exit and POST /exit/verify refuse new
//   business with an explicit 403 (no intent issued, no submission
//   accepted). The operator endpoints stay available. Reopening is a
//   var flip + redeploy here AND the pool-side code gate
//   (lib/exit-exec.mjs ARMED) — both must be open for an exit to run.
//   POST /exit    public: register an exit INTENT. The server builds the
//                 official chat-protocol prepared message ({v:1,
//                 kind:'agent', addr, text, ts, nonce}) with a one-time
//                 nonce and returns it with its canonical signing text;
//                 the member signs it with their own wallet — signing is
//                 free and works at zero balance (see lib/exit.mjs).
//   POST /exit/verify public: submit {prepared, signature, nonce}. The
//                 Worker binds the submission EXACTLY to the issued
//                 intent (nonce unconsumed, unexpired, prepared identical
//                 to what was issued) and stores it as 'submitted'. The
//                 cryptographic verification itself happens pool-side
//                 (lib/exit-exec.mjs). A nonce is burned by the first
//                 submission, valid signature or not: replays fail.
//   GET  /exit/pending operator only: submitted exit requests awaiting
//                 pool-side verification.
//   POST /exit/resolve operator only: record the pool-side verdict
//                 ('verified' = a case was opened; 'rejected' + reason).
//
// JOIN CHANNEL (AI-signed join, operator plan 2026-10-24 — branch ai-join,
// NOT deployed: the Worker below is the sandbox implementation; production
// deploy and any real-money test wait for the operator's explicit go-ahead).
//   POST /join/code  public: file {address, planned_units} and receive a
//                 join CODE — a copy-paste block for the member's own AI
//                 (pool address + exact amount = planned + this address's
//                 fingerprint + one-time nonce, 60-minute validity). The
//                 code is an execution instruction, NOT an authorization:
//                 only the member's own signer can move their money.
//   POST /join/claim public: submit the AI's signed receipt
//                 {prepared, signature, nonce} after the transfer. Unlike
//                 the exit channel (verified pool-side later), a join
//                 receipt is verified HERE, in the Worker, before it can
//                 influence attribution at all — a pending join claim is a
//                 credit instruction to the matcher, so it must be
//                 cryptographically valid first. The nonce is burned by
//                 the first submission whether the signature verifies or
//                 not; a valid receipt registers a PENDING claim (24-hour
//                 wait for its inflow), an invalid one is filed 'rejected'
//                 as evidence. Crediting still needs the chain fact: the
//                 matcher credits a pending claim only when an inflow of
//                 exactly its amount actually lands.
//   GET  /join/claims operator only: pending claims awaiting an inflow.
//   POST /join/fulfill operator only: mark a claim 'fulfilled' once the
//                 matcher has credited it (never credits twice).
//   GET  /lookup also returns matching join rows under `join` (by
//                 address / amount) so one query shows both channels.
//
// Calc-record TTL: a kind='calc' row is a visitor's stated INTENT to
// transfer. While it sits at status='ok' and no matching inflow
// fulfils it within 30 minutes it is deleted (POST /sweep, plus
// opportunistically on every POST /calc). Rows the matcher marked
// status='fulfilled' (via POST /fulfill, when the inflow landed and
// was credited) are exempt, rows it froze as status='held' (via
// POST /hold, evidence for a parked unclaimed entry) are exempt, and
// import / auto_match / unclaimed rows NEVER expire — those are
// historical facts, not intentions.
//
// This file is self-contained on purpose (no repo imports): the address
// normalize + fingerprint code below MIRRORS lib/fpmatch.mjs exactly —
// fp = (sha256(normalized hex string)[0..4] as uint32 BE) mod 99999 + 1
// (v2 scheme; v1's mod 999999 is honored pool-side, not recomputed here).

// ---------------------------------------------------------------- helpers
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  },
});

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-registry-key',
  'access-control-max-age': '86400',
};

// --- address formats: 64-hex and trac1 are one key in two encodings -----
// bech32m (BIP-350), HRP "trac", payload = the raw 32 key bytes, checksum
// verified. Mirrors lib/fpmatch.mjs (decodeTracAddress / normalizeAddress).
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
function decodeTracAddress(addr) {
  if (typeof addr !== 'string') return null;
  const s = addr.trim();
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return null;
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
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
}
function normalizeAddress(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  if (/^trac1/i.test(s)) return decodeTracAddress(s);
  return null;
}

// fp = (sha256(hex)[0..4] BE mod 99999) + 1 — identical to the matcher.
// v2 scheme (2026-10-24): planned step 0.001, tail 1..99999. The v1
// scheme (step 0.01, tail mod 999999 + 1) is NOT recomputed here —
// v1 records already filed keep their stored fp_units, and the
// pool-side matcher still honors them (see lib/fpmatch.mjs).
async function fingerprint(addressHex) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(addressHex));
  return (new DataView(buf).getUint32(0, false) % 99999) + 1;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------ validation
const MAX_FIELD = 256;                    // any single string field
const MAX_PLANNED = 10n ** 14n;           // 1,000,000 RESET — generous ceiling
const PLANNED_STEP = 100_000n;            // planned amounts are 0.001 multiples (v2, 2026-10-24)
const RATE_LIMIT = 30;                    // POSTs per IP per minute
const CALC_TTL_MS = 30 * 60 * 1000;       // calc records expire 30 min after filing

// Parse a units field: decimal-integer string (or safe integer), or null.
// Returns BigInt, or null when absent (optional fields), or NaN-marker
// via undefined when present-but-malformed.
function unitsField(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^[0-9]{1,20}$/.test(v)) return BigInt(v);
  return undefined;
}

function keyMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false;
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// ------------------------------------------------------------ calc TTL
// ts values are ISO-8601 UTC strings in one fixed format, so a plain
// string comparison against an ISO cutoff is a correct time comparison.
const calcCutoff = () => new Date(Date.now() - CALC_TTL_MS).toISOString();

// Delete expired calc intentions (see the TTL note in the header).
// ONLY kind='calc' rows still at status='ok' go. 'fulfilled' rows are
// the audit trail; 'held' rows are evidence frozen by the matcher
// behind a parked unclaimed entry; the historical kinds (import /
// auto_match / unclaimed) are never touched. The same sweep retires
// exit intents that were never submitted (kind='exit_request',
// status='pending'); submitted / verified / rejected exit requests are
// evidence and never expire.
async function sweepExpiredCalcs(env) {
  const r = await env.REGISTRY_DB.prepare(
    `DELETE FROM records WHERE kind = 'calc' AND status = 'ok' AND ts < ?`)
    .bind(calcCutoff()).run();
  const x = await env.REGISTRY_DB.prepare(
    `DELETE FROM records WHERE kind = 'exit_request' AND status = 'pending' AND ts < ?`)
    .bind(calcCutoff()).run();
  // Join channel: TRUE DELETE for codes that never got a receipt
  // within their 30 minutes (the member re-issues). Only status =
  // 'issued' rows are deleted — a code already consumed into a
  // receipt is kept via its join_claims record and is never in this
  // category. Pending claims EXPIRE to a visible terminal state
  // (never silently deleted — an expired claim is evidence the money
  // never arrived in 24 h).
  let j = 0;
  try {
    const d = await env.REGISTRY_DB.prepare(
      `DELETE FROM join_codes WHERE status = 'issued' AND ts < ?`)
      .bind(new Date(Date.now() - JOIN_CODE_TTL_MS).toISOString()).run();
    j += d?.meta?.changes ?? 0;
    const e = await env.REGISTRY_DB.prepare(
      `UPDATE join_claims SET status = 'expired' WHERE status = 'pending' AND ts < ?`)
      .bind(new Date(Date.now() - JOIN_CLAIM_TTL_MS).toISOString()).run();
    j += e?.meta?.changes ?? 0;
  } catch { /* join tables predate the migration on old deployments: sweep must not fail calc TTL */ }
  return (r?.meta?.changes ?? 0) + (x?.meta?.changes ?? 0) + j;
}

async function insertRecord(env, rec) {
  const r = await env.REGISTRY_DB.prepare(
    `INSERT INTO records (ts, kind, address_hex, planned_units, fp_units, exact_units, status, source, note, ip_hash, nonce, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(rec.ts, rec.kind, rec.address_hex, rec.planned_units, rec.fp_units,
          rec.exact_units, rec.status, rec.source, rec.note, rec.ip_hash,
          rec.nonce ?? null, rec.payload ?? null)
    .run();
  return r?.meta?.last_row_id ?? null;
}

// ---------------------------------------------------------------- routes
async function postCalc(request, env) {
  // Opportunistic TTL cleanup: filing a new calculation also clears
  // expired intentions. Best-effort — a sweep failure never affects
  // the filing itself.
  try { await sweepExpiredCalcs(env); } catch {}
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'body must be JSON' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ ok: false, error: 'body must be a JSON object' }, 400);
  }
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === 'string' && v.length > MAX_FIELD) {
      return json({ ok: false, error: `field too long: ${k}` }, 400);
    }
  }
  const status = body.status;
  if (!['ok', 'blocked_pool', 'invalid'].includes(status)) {
    return json({ ok: false, error: 'status must be ok | blocked_pool | invalid' }, 400);
  }
  // The raw spelling is accepted (hex or trac1) but only the normalized
  // form is stored. For status=invalid the address may be unparseable —
  // that fact itself is the diagnostic, so address_hex is then NULL.
  const addressHex = typeof body.address === 'string' ? normalizeAddress(body.address)
    : (typeof body.normalized === 'string' ? normalizeAddress(body.normalized) : null);
  if (status !== 'invalid' && !addressHex) {
    return json({ ok: false, error: 'address is not a valid RESET (64-hex) or trac1 address' }, 400);
  }
  const planned = unitsField(body.planned_units);
  const fpGiven = unitsField(body.fp_units);
  const exact = unitsField(body.exact_units);
  if (planned === undefined || fpGiven === undefined || exact === undefined) {
    return json({ ok: false, error: 'planned_units / fp_units / exact_units must be decimal unit strings' }, 400);
  }
  if (planned !== null && (planned <= 0n || planned > MAX_PLANNED)) {
    return json({ ok: false, error: 'planned_units out of range' }, 400);
  }
  if (fpGiven !== null && (fpGiven < 0n || fpGiven > 99999n)) {
    return json({ ok: false, error: 'fp_units out of range (0..99999)' }, 400);
  }
  // Recompute the fingerprint server-side — the server's word, not the
  // client's, is what gets filed. For a complete ok-report the client's
  // numbers must agree with the recomputation, else reject: a mismatch
  // means a buggy (or lying) client, and filing it would poison lookups.
  let fp = null;
  if (addressHex) fp = BigInt(await fingerprint(addressHex));
  if (status === 'ok') {
    if (planned === null || fpGiven === null || exact === null) {
      return json({ ok: false, error: 'status ok requires planned_units, fp_units and exact_units' }, 400);
    }
    if (planned % PLANNED_STEP !== 0n) {
      return json({ ok: false, error: 'planned_units must be a multiple of 0.001 RESET (100000 units)' }, 400);
    }
    if (fpGiven !== fp) {
      return json({ ok: false, error: `fingerprint mismatch: fp for this address is ${fp}` }, 400);
    }
    if (exact !== planned + fp) {
      return json({ ok: false, error: 'exact_units must equal planned_units + fp_units' }, 400);
    }
  }
  // Basic abuse control: per-IP rate limit counted in D1 (no external
  // dependency). Only the sha256 hash of the IP is ever stored.
  const ip = request.headers.get('cf-connecting-ip') || '';
  const ipHash = ip ? await sha256Hex(ip) : null;
  if (ipHash) {
    const since = new Date(Date.now() - 60_000).toISOString();
    const row = await env.REGISTRY_DB.prepare(
      'SELECT COUNT(*) AS n FROM records WHERE ip_hash = ? AND ts >= ?')
      .bind(ipHash, since).first();
    if (row && Number(row.n) >= RATE_LIMIT) {
      return json({ ok: false, error: 'rate limit: too many calculations from this network, retry shortly' }, 429);
    }
  }
  const kind = status === 'blocked_pool' ? 'calc_blocked' : 'calc';
  const id = await insertRecord(env, {
    ts: new Date().toISOString(),
    kind,
    address_hex: addressHex,
    planned_units: planned?.toString() ?? null,
    fp_units: (fp ?? fpGiven)?.toString() ?? null,
    exact_units: exact?.toString() ?? (planned !== null && fp !== null ? (planned + fp).toString() : null),
    status,
    source: 'calculator',
    note: typeof body.note === 'string' ? body.note.slice(0, MAX_FIELD) : null,
    ip_hash: ipHash,
  });
  return json({ ok: true, id }, 201);
}

async function getLookup(request, env, url) {
  if (!keyMatches(request.headers.get('x-registry-key'), env.REGISTRY_KEY)) {
    return json({ ok: false, error: 'operator key required' }, 401);
  }
  const tailRaw = url.searchParams.get('tail');
  const addrRaw = url.searchParams.get('address');
  const amountRaw = url.searchParams.get('amount');
  if (tailRaw === null && addrRaw === null && amountRaw === null) {
    return json({ ok: false, error: 'give at least one of ?tail= ?address= ?amount=' }, 400);
  }
  const query = {};
  if (tailRaw !== null) {
    if (!/^[0-9]{1,6}$/.test(tailRaw) || Number(tailRaw) > 999999) {
      return json({ ok: false, error: 'tail must be 0..999999' }, 400);
    }
    query.tail = tailRaw.replace(/^0+(?=\d)/, '');
  }
  if (addrRaw !== null) {
    query.address = normalizeAddress(addrRaw);
    if (!query.address) return json({ ok: false, error: 'address not parseable as RESET hex or trac1' }, 400);
  }
  if (amountRaw !== null) {
    if (!/^[0-9]{1,20}$/.test(amountRaw)) return json({ ok: false, error: 'amount must be a unit integer' }, 400);
    query.amount = amountRaw.replace(/^0+(?=\d)/, '');
  }
  // One simple indexed query per filter, merged + deduped in JS — every
  // kind (calc, import, auto_match, unclaimed…) comes back side by side.
  const db = env.REGISTRY_DB;
  const byId = new Map();
  const collect = rows => { for (const r of rows ?? []) byId.set(r.id, r); };
  if (query.tail !== undefined) {
    collect((await db.prepare('SELECT * FROM records WHERE fp_units = ? ORDER BY ts, id').bind(query.tail).all()).results);
  }
  if (query.address !== undefined) {
    collect((await db.prepare('SELECT * FROM records WHERE address_hex = ? ORDER BY ts, id').bind(query.address).all()).results);
  }
  if (query.amount !== undefined) {
    collect((await db.prepare('SELECT * FROM records WHERE exact_units = ? ORDER BY ts, id').bind(query.amount).all()).results);
    collect((await db.prepare('SELECT * FROM records WHERE planned_units = ? ORDER BY ts, id').bind(query.amount).all()).results);
  }
  const records = [...byId.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id - b.id));
  // Join channel rows, same filters (pre-migration deployments have no
  // join tables — a missing table must not break the lookup itself).
  const join = [];
  try {
    if (query.address !== undefined) {
      join.push(...((await db.prepare('SELECT * FROM join_codes WHERE address_hex = ? ORDER BY ts, id').bind(query.address).all()).results ?? []));
      join.push(...((await db.prepare('SELECT * FROM join_claims WHERE address_hex = ? ORDER BY ts, id').bind(query.address).all()).results ?? []));
    }
    if (query.amount !== undefined) {
      join.push(...((await db.prepare('SELECT * FROM join_claims WHERE exact_units = ? ORDER BY ts, id').bind(query.amount).all()).results ?? []));
    }
  } catch {}
  return json({ ok: true, query, count: records.length, records, join });
}

// POST /fulfill {tail?, address?} — operator only. The matcher calls
// this when an inflow has landed and been credited (automatic match or
// a successful unclaimed claim): the matching calc records (still
// inside their TTL) are marked status='fulfilled' so the sweep keeps
// them as the audit trail of "calculated -> arrived". Marking is pure
// bookkeeping — attribution already happened on fingerprint rules.
async function postFulfill(request, env) {
  if (!keyMatches(request.headers.get('x-registry-key'), env.REGISTRY_KEY)) {
    return json({ ok: false, error: 'operator key required' }, 401);
  }
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'body must be JSON' }, 400); }
  const tailRaw = body && body.tail != null ? String(body.tail) : null;
  const addrRaw = body && typeof body.address === 'string' ? body.address : null;
  if (tailRaw === null && !addrRaw) {
    return json({ ok: false, error: 'give tail or address' }, 400);
  }
  // In-TTL rows fulfill as before; a 'held' row fulfils at ANY age —
  // being frozen as evidence must not make it unclosable once the
  // parked entry it backs finally gets attributed.
  const conds = [`kind = 'calc'`, `status <> 'fulfilled'`, `(ts >= ? OR status = 'held')`];
  const binds = [calcCutoff()];
  if (tailRaw !== null) {
    if (!/^[0-9]{1,6}$/.test(tailRaw) || Number(tailRaw) > 999999) {
      return json({ ok: false, error: 'tail must be 0..999999' }, 400);
    }
    conds.push('fp_units = ?');
    binds.push(String(Number(tailRaw)));
  }
  if (addrRaw) {
    const a = normalizeAddress(addrRaw);
    if (!a) return json({ ok: false, error: 'address not parseable as RESET hex or trac1' }, 400);
    conds.push('address_hex = ?');
    binds.push(a);
  }
  const r = await env.REGISTRY_DB.prepare(
    `UPDATE records SET status = 'fulfilled' WHERE ${conds.join(' AND ')}`)
    .bind(...binds).run();
  return json({ ok: true, updated: r?.meta?.changes ?? 0 });
}

// POST /hold {tail, exact_units} — operator only. The matcher calls
// this when it parks an inflow as unclaimed and the registry holds the
// exact calculation behind it: those rows move status 'ok' -> 'held',
// which exempts them from the sweep at ANY age (see sweepExpiredCalcs)
// until the entry is attributed and /fulfill closes them out. Without
// this, the 30-minute TTL would delete precisely the evidence a parked
// entry needs for its (possibly much later) attribution. Only 'ok'
// rows transition — a fulfilled row stays fulfilled; holding is
// idempotent (re-holding an already-held row reports updated: 0).
async function postHold(request, env) {
  if (!keyMatches(request.headers.get('x-registry-key'), env.REGISTRY_KEY)) {
    return json({ ok: false, error: 'operator key required' }, 401);
  }
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'body must be JSON' }, 400); }
  const tailRaw = body && body.tail != null ? String(body.tail) : null;
  const exact = unitsField(body ? body.exact_units : undefined);
  if (tailRaw === null || exact === null || exact === undefined) {
    return json({ ok: false, error: 'give tail and exact_units' }, 400);
  }
  if (!/^[0-9]{1,6}$/.test(tailRaw) || Number(tailRaw) > 999999) {
    return json({ ok: false, error: 'tail must be 0..999999' }, 400);
  }
  const r = await env.REGISTRY_DB.prepare(
    `UPDATE records SET status = 'held' WHERE kind = 'calc' AND status = 'ok' AND fp_units = ? AND exact_units = ?`)
    .bind(String(Number(tailRaw)), exact.toString()).run();
  return json({ ok: true, updated: r?.meta?.changes ?? 0 });
}

// POST /sweep — operator only. Deletes every expired calc intention
// and reports how many went. Same deletion POST /calc runs
// opportunistically on entry.
async function postSweep(request, env) {
  if (!keyMatches(request.headers.get('x-registry-key'), env.REGISTRY_KEY)) {
    return json({ ok: false, error: 'operator key required' }, 401);
  }
  return json({ ok: true, deleted: await sweepExpiredCalcs(env) });
}

// ------------------------------------------------------------ exit intents
// Mirror of lib/exit.mjs (this file stays self-contained). The Worker
// ISSUES the prepared message and binds submissions to it; the signature
// itself is verified pool-side by lib/exit-exec.mjs.
const POOL_ADDRESS_DEFAULT = '4150cf82f0189371818a22d5f5b10d52aadf9108c78020cc97fc002df6eaaca6';
const poolAddressOf = env => (typeof env.POOL_ADDRESS === 'string' && /^[0-9a-f]{64}$/.test(env.POOL_ADDRESS))
  ? env.POOL_ADDRESS : POOL_ADDRESS_DEFAULT;
// Exit channel gate (see the status note at the top of this file).
const exitChannelOpen = env => env.EXIT_OPEN === '1';
const exitClosed = () => json({ ok: false, closed: true,
  error: 'exit channel temporarily closed — exits are paused by the operator while the pool grows; no new exit intents are accepted right now' }, 403);
// Byte-for-byte port of the official stableJSON (contract/rules/json.js).
function stableJSON(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJSON(value[k])}`).join(',')}}`;
}
const exitTextFor = (pool, address, nonce) =>
  `EXIT full pool position. Pool ${pool} member ${address} nonce ${nonce}`;
const exitSigningText = p => 'reset-chat/v1\n' + stableJSON(
  { v: p.v, kind: p.kind, addr: p.addr, text: p.text, ts: p.ts, nonce: p.nonce });
const newNonce = () => [...crypto.getRandomValues(new Uint8Array(8))]
  .map(b => b.toString(16).padStart(2, '0')).join('');

async function exitRowsBy(env, col, val) {
  const { results } = await env.REGISTRY_DB.prepare(
    `SELECT * FROM records WHERE ${col} = ? ORDER BY ts, id`).bind(val).all();
  return (results ?? []).filter(r => r.kind === 'exit_request');
}
const exitByNonce = async (env, nonce) => (await exitRowsBy(env, 'nonce', nonce))[0] ?? null;

async function ipHashOf(request) {
  const ip = request.headers.get('cf-connecting-ip') || '';
  return ip ? await sha256Hex(ip) : null;
}
async function rateLimited(env, ipHash) {
  if (!ipHash) return false;
  const since = new Date(Date.now() - 60_000).toISOString();
  const row = await env.REGISTRY_DB.prepare(
    'SELECT COUNT(*) AS n FROM records WHERE ip_hash = ? AND ts >= ?').bind(ipHash, since).first();
  return row && Number(row.n) >= RATE_LIMIT;
}

const exitView = row => {
  let prepared = null;
  try { prepared = JSON.parse(row.payload ?? 'null')?.prepared ?? null; } catch {}
  return { id: row.id, address_hex: row.address_hex, nonce: row.nonce, status: row.status,
    issued_at: row.ts, expires_at: new Date(Date.parse(row.ts) + CALC_TTL_MS).toISOString(), prepared,
    signing_text: prepared ? exitSigningText(prepared) : null };
};

// POST /exit — file an exit intent and receive the prepared message to
// sign. Idempotent while an intent is live: re-asking returns the SAME
// prepared object (same nonce) instead of minting a second one. Any
// agent able to POST can file on a member's behalf — the intent alone is
// worthless without the member's own signature (see /exit/verify).
async function postExit(request, env) {
  if (!exitChannelOpen(env)) return exitClosed();
  try { await sweepExpiredCalcs(env); } catch {}
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'body must be JSON' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ ok: false, error: 'body must be a JSON object' }, 400);
  const addressHex = typeof body.address === 'string' ? normalizeAddress(body.address) : null;
  if (!addressHex) return json({ ok: false, error: 'address is not a valid RESET (64-hex) or trac1 address' }, 400);
  const ipHash = await ipHashOf(request);
  if (await rateLimited(env, ipHash)) return json({ ok: false, error: 'rate limit: too many requests from this network, retry shortly' }, 429);
  const mine = await exitRowsBy(env, 'address_hex', addressHex);
  const live = mine.find(r => r.status === 'pending');
  if (live) return json({ ok: true, reused: true, exit: exitView(live) }, 200);
  if (mine.some(r => r.status === 'submitted')) return json({ ok: false, error: 'exit already submitted — awaiting verification' }, 409);
  if (mine.some(r => r.status === 'verified')) return json({ ok: false, error: 'exit already verified — a case is open' }, 409);
  const nonce = newNonce();
  const prepared = { v: 1, kind: 'agent', addr: addressHex,
    text: exitTextFor(poolAddressOf(env), addressHex, nonce), ts: Date.now(), nonce };
  const id = await insertRecord(env, {
    ts: new Date().toISOString(), kind: 'exit_request', address_hex: addressHex,
    planned_units: null, fp_units: null, exact_units: null, status: 'pending',
    source: 'exit', note: null, ip_hash: ipHash, nonce,
    payload: JSON.stringify({ prepared }),
  });
  const row = await exitByNonce(env, nonce);
  return json({ ok: true, exit: exitView(row ?? { id, address_hex: addressHex, nonce, status: 'pending', ts: new Date().toISOString(), payload: JSON.stringify({ prepared }) }) }, 201);
}

// POST /exit/verify — submit the member's signature over the issued
// prepared message. The Worker enforces the binding (live intent, exact
// prepared, matching nonce) and burns the nonce by moving the record to
// 'submitted'; the pool side then verifies the Ed25519 signature itself
// before opening any case. A submission with an INVALID signature still
// burns the nonce — the member simply files a fresh intent.
async function postExitVerify(request, env) {
  if (!exitChannelOpen(env)) return exitClosed();
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'body must be JSON' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ ok: false, error: 'body must be a JSON object' }, 400);
  const { prepared, signature, nonce } = body;
  if (typeof nonce !== 'string' || !/^[0-9a-f]{16}$/.test(nonce)) return json({ ok: false, error: 'nonce must be 16 lowercase hex chars' }, 400);
  if (typeof signature !== 'string' || !/^[0-9a-f]{128}$/.test(signature)) return json({ ok: false, error: 'signature must be 128 lowercase hex chars (Ed25519)' }, 400);
  if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared)) return json({ ok: false, error: 'prepared must be the issued message object' }, 400);
  if (prepared.nonce !== nonce) return json({ ok: false, error: 'prepared.nonce does not match nonce' }, 400);
  const row = await exitByNonce(env, nonce);
  if (!row) return json({ ok: false, error: 'unknown nonce — file an intent with POST /exit first' }, 404);
  if (row.status !== 'pending') return json({ ok: false, error: `nonce already consumed (status: ${row.status})` }, 409);
  if (Date.now() - Date.parse(row.ts) > CALC_TTL_MS) return json({ ok: false, error: 'intent expired — file a fresh POST /exit' }, 410);
  let issued = null;
  try { issued = JSON.parse(row.payload ?? 'null')?.prepared ?? null; } catch {}
  if (!issued || stableJSON(prepared) !== stableJSON(issued)) {
    return json({ ok: false, error: 'prepared does not match the issued intent — sign the exact object POST /exit returned' }, 400);
  }
  const payload = JSON.stringify({ prepared: issued, signature, submitted_at: new Date().toISOString() });
  const r = await env.REGISTRY_DB.prepare(
    `UPDATE records SET status = 'submitted', payload = ? WHERE id = ? AND status = 'pending'`)
    .bind(payload, row.id).run();
  if ((r?.meta?.changes ?? 0) !== 1) return json({ ok: false, error: 'nonce already consumed' }, 409);
  return json({ ok: true, id: row.id, status: 'submitted' });
}

// GET /exit/pending — operator only: submissions awaiting pool-side
// cryptographic verification, oldest first.
async function getExitPending(request, env) {
  if (!keyMatches(request.headers.get('x-registry-key'), env.REGISTRY_KEY)) {
    return json({ ok: false, error: 'operator key required' }, 401);
  }
  const rows = await exitRowsBy(env, 'kind', 'exit_request');
  const submissions = rows.filter(r => r.status === 'submitted').map(r => {
    let p = {};
    try { p = JSON.parse(r.payload ?? '{}'); } catch {}
    return { id: r.id, address_hex: r.address_hex, nonce: r.nonce, ts: r.ts,
      prepared: p.prepared ?? null, signature: p.signature ?? null, submitted_at: p.submitted_at ?? null };
  });
  return json({ ok: true, submissions });
}

// POST /exit/resolve — operator only: record the pool-side verdict for a
// submitted exit request ('verified' with the case id as note, or
// 'rejected' with the reason as note).
async function postExitResolve(request, env) {
  if (!keyMatches(request.headers.get('x-registry-key'), env.REGISTRY_KEY)) {
    return json({ ok: false, error: 'operator key required' }, 401);
  }
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'body must be JSON' }, 400); }
  const id = Number(body?.id);
  if (!Number.isSafeInteger(id) || id <= 0) return json({ ok: false, error: 'id must be a positive integer' }, 400);
  if (!['verified', 'rejected'].includes(body?.result)) return json({ ok: false, error: "result must be 'verified' or 'rejected'" }, 400);
  const note = typeof body.note === 'string' ? body.note.slice(0, MAX_FIELD) : null;
  const r = await env.REGISTRY_DB.prepare(
    `UPDATE records SET status = ?, note = ? WHERE id = ? AND kind = 'exit_request' AND status = 'submitted'`)
    .bind(body.result, note, id).run();
  return json({ ok: true, updated: r?.meta?.changes ?? 0 });
}

// ------------------------------------------------------------ join channel
// Mirror of lib/join.mjs (this file stays self-contained). The receipt
// the member's AI signs is the SAME official agent construction as an
// exit intent — only the text differs (it names the exact join amount
// and the code nonce). Verification here uses WebCrypto Ed25519, the
// same primitive trac-wallet uses; the pool-side lib/join.mjs verifier
// is the node:crypto twin (same bytes, same key, same result).
const JOIN_CODE_TTL_MS = 30 * 60 * 1000;       // code window 30 min: execution AND receipt submission
const JOIN_CLAIM_TTL_MS = 24 * 60 * 60 * 1000; // pending claim waits 24 h for its inflow (separate clock: the address is already filed, so the code-deletion rule does not apply)
const JOIN_NONCE_RE = /^[0-9a-f]{16}$/;
const JOIN_SIG_RE = /^[0-9a-f]{128}$/;
const hexToBytes = h => {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
};
const joinTextFor = (pool, address, exactUnits, nonce) =>
  `JOIN pool. Pool ${pool} member ${address} amount ${BigInt(exactUnits)} code ${nonce}`;
const joinSigningText = p => 'reset-chat/v1\n' + stableJSON(
  { v: p.v, kind: p.kind, addr: p.addr, text: p.text, ts: p.ts, nonce: p.nonce });
const joinCodeBlock = ({ pool, address, planned, fp, exact, nonce, expiresAt }) => {
  const fmt = u => `${(BigInt(u) / 100000000n).toString()}.${(BigInt(u) % 100000000n).toString().padStart(8, '0')}`;
  return [
    `RESET pool join code — give this whole block to your own AI.`,
    `Pool: ${pool}`,
    `Member: ${address}`,
    `Planned: ${fmt(planned)} RESET, fingerprint tail: ${fp} units`,
    `Transfer EXACTLY: ${fmt(exact)} RESET (${exact} units) to the pool address above.`,
    `Code nonce: ${nonce} — execute AND submit the receipt within 30 minutes (until ${expiresAt}); after 30 minutes without a receipt this code is automatically deleted.`,
    `--- AI INSTRUCTIONS (hard rules, not suggestions) ---`,
    `1. Read the pool address and the exact amount back to your owner and WAIT for their confirmation before transferring.`,
    `2. Transfer exactly ${exact} units — digit for digit. Never round, never split, never substitute another amount.`,
    `3. The transfer fee is 0.03 TNK paid by the member wallet. If the wallet holds no TNK, STOP and report — do not improvise.`,
    `4. After the gateway accepts the transfer, sign the receipt statement (same official agent format as an exit intent) and return the signed receipt block to your owner for submission.`,
    `5. HOW TO TRANSFER — two allowed ways, do not invent a third. PREFERRED: clone the whole public pool repo (https://github.com/chilperbf24/reset-mining-pool) so join-pay.mjs is present with its lib/ files and the official signer beside it, then use that atomic script: it transfers and signs the receipt as ONE command. Do NOT download join-pay.mjs alone — its imports will fail. FALLBACK (explicitly allowed): transfer the exact amount with your own official signer, then sign the join receipt statement separately and return the full receipt block to your owner for submission within 30 minutes. A fallback transfer still credits on re-check.`,
    `6. LATE RECEIPT / ALREADY CREDITED — if the transfer already landed, submit the receipt anyway WITHIN the 30-minute window and it credits on re-check — NEVER re-transfer. If the pool already credited the inflow by fingerprint, a receipt is no longer needed; do not sign anything just to close the code. After 30 minutes the code is deleted and you must issue a fresh code.`,
    `{"pool":"${pool}","address":"${address}","planned_units":"${planned}","fp_units":"${fp}","exact_units":"${exact}","nonce":"${nonce}"}`,
  ].join('\n');
};
async function verifyEd25519(messageUtf8, signatureHex, publicKeyHex) {
  try {
    const key = await crypto.subtle.importKey('raw', hexToBytes(publicKeyHex),
      { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, hexToBytes(signatureHex),
      new TextEncoder().encode(messageUtf8));
  } catch { return false; }
}
const joinCodeView = (row, pool) => {
  let code = null;
  try { code = JSON.parse(row.payload ?? 'null'); } catch {}
  return { id: row.id, address_hex: row.address_hex, nonce: row.nonce, status: row.status,
    planned_units: row.planned_units, fp_units: row.fp_units, exact_units: row.exact_units,
    issued_at: row.ts, expires_at: new Date(Date.parse(row.ts) + JOIN_CODE_TTL_MS).toISOString(),
    pool_address: pool, text: code?.text ?? null };
};
async function joinCodeByNonce(env, nonce) {
  const row = await env.REGISTRY_DB.prepare(
    `SELECT * FROM join_codes WHERE nonce = ? ORDER BY ts, id`).bind(nonce).first();
  return row ?? null;
}

// POST /join/code — issue a join code for {address, planned_units}.
// The Worker recomputes the fingerprint server-side (its word, not the
// client's) and refuses the pool's own address: the pool cannot join
// itself, same guard as the matcher. One code per request; re-issuing
// after expiry is always allowed (old codes die in the sweep).
async function postJoinCode(request, env) {
  try { await sweepExpiredCalcs(env); } catch {}
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'body must be JSON' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ ok: false, error: 'body must be a JSON object' }, 400);
  const addressHex = typeof body.address === 'string' ? normalizeAddress(body.address) : null;
  if (!addressHex) return json({ ok: false, error: 'address is not a valid RESET (64-hex) or trac1 address' }, 400);
  const pool = poolAddressOf(env);
  if (addressHex === pool) return json({ ok: false, error: 'the pool address itself cannot join the pool' }, 400);
  const planned = unitsField(body.planned_units);
  if (planned === undefined || planned === null || planned <= 0n || planned > MAX_PLANNED) {
    return json({ ok: false, error: 'planned_units must be a positive unit integer' }, 400);
  }
  if (planned % PLANNED_STEP !== 0n) {
    return json({ ok: false, error: 'planned_units must be a multiple of 0.001 RESET (100000 units)' }, 400);
  }
  const ipHash = await ipHashOf(request);
  if (await rateLimited(env, ipHash)) return json({ ok: false, error: 'rate limit: too many requests from this network, retry shortly' }, 429);
  const fp = BigInt(await fingerprint(addressHex));
  const exact = planned + fp;
  const nonce = newNonce();
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + JOIN_CODE_TTL_MS).toISOString();
  const text = joinCodeBlock({ pool, address: addressHex, planned: planned.toString(),
    fp: fp.toString(), exact: exact.toString(), nonce, expiresAt });
  const r = await env.REGISTRY_DB.prepare(
    `INSERT INTO join_codes (ts, address_hex, planned_units, fp_units, exact_units, nonce, status, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(issuedAt.toISOString(), addressHex, planned.toString(), fp.toString(), exact.toString(),
      nonce, 'issued', JSON.stringify({ text })).run();
  const id = r?.meta?.last_row_id ?? null;
  return json({ ok: true, code: { id, address_hex: addressHex, nonce, status: 'issued',
    planned_units: planned.toString(), fp_units: fp.toString(), exact_units: exact.toString(),
    pool_address: pool, issued_at: issuedAt.toISOString(), expires_at: expiresAt, text } }, 201);
}

// POST /join/claim — submit the AI's signed receipt {prepared, signature,
// nonce} for a live join code. Binding + burn + verification, in order:
//   1. the code must exist, be 'issued', and be inside its 30-minute
//      window: the receipt must arrive within 30 minutes of issuance,
//      or the code is auto-deleted and the member must issue a fresh
//      one. (Two clocks, do not conflate: 30 min governs code-waiting-
//      for-receipt; once a receipt is filed, the pending claim waits
//      24 h for its inflow.)
//   2. the code is burned FIRST (status -> 'consumed') so no submission
//      — valid or not — can ever be replayed;
//   3. the receipt must match the code exactly (address, exact amount
//      inside the text, nonce) and its Ed25519 signature must verify
//      over the official signing text under the member's key.
// A verified receipt registers a PENDING claim (24 h for its inflow);
// a failed one is filed 'rejected' as evidence and the member re-issues.
async function postJoinClaim(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'body must be JSON' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ ok: false, error: 'body must be a JSON object' }, 400);
  const { prepared, signature, nonce } = body;
  if (typeof nonce !== 'string' || !JOIN_NONCE_RE.test(nonce)) return json({ ok: false, error: 'nonce must be 16 lowercase hex chars' }, 400);
  if (typeof signature !== 'string' || !JOIN_SIG_RE.test(signature)) return json({ ok: false, error: 'signature must be 128 lowercase hex chars (Ed25519)' }, 400);
  if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared)) return json({ ok: false, error: 'prepared must be the receipt message object' }, 400);
  if (prepared.nonce !== nonce) return json({ ok: false, error: 'prepared.nonce does not match nonce' }, 400);
  const code = await joinCodeByNonce(env, nonce);
  if (!code) return json({ ok: false, error: 'unknown code nonce — issue a code with POST /join/code first' }, 404);
  if (code.status !== 'issued') return json({ ok: false, error: `code already consumed (status: ${code.status})` }, 409);
  if (Date.now() - Date.parse(code.ts) > JOIN_CODE_TTL_MS) return json({ ok: false, error: 'code expired — issue a fresh POST /join/code' }, 410);
  // Burn first: exactly one submission ever consumes this nonce.
  const burned = await env.REGISTRY_DB.prepare(
    `UPDATE join_codes SET status = ? WHERE id = ? AND status = 'issued'`)
    .bind('consumed', code.id).run();
  if ((burned?.meta?.changes ?? 0) !== 1) return json({ ok: false, error: 'code already consumed' }, 409);
  const pool = poolAddressOf(env);
  const fail = async reason => {
    await env.REGISTRY_DB.prepare(
      `INSERT INTO join_claims (ts, code_nonce, address_hex, exact_units, nonce, status, payload) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(new Date().toISOString(), nonce, code.address_hex, code.exact_units, nonce, 'rejected',
        JSON.stringify({ prepared, reason })).run();
    return json({ ok: false, error: reason }, 400);
  };
  if (prepared.v !== 1 || prepared.kind !== 'agent' || prepared.addr !== code.address_hex) {
    return fail('receipt does not match the issued code (version, kind, or address)');
  }
  if (prepared.text !== joinTextFor(pool, code.address_hex, code.exact_units, nonce)) {
    return fail('receipt text does not match the issued code (pool, amount, or nonce)');
  }
  if (!await verifyEd25519(joinSigningText(prepared), signature, prepared.addr)) {
    return fail('signature verification failed — the receipt was not signed by the member key');
  }
  const r = await env.REGISTRY_DB.prepare(
    `INSERT INTO join_claims (ts, code_nonce, address_hex, exact_units, nonce, status, payload) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(new Date().toISOString(), nonce, code.address_hex, code.exact_units, nonce, 'pending',
      JSON.stringify({ prepared, signature, submitted_at: new Date().toISOString() })).run();
  return json({ ok: true, claim: { id: r?.meta?.last_row_id ?? null, code_nonce: nonce,
    address_hex: code.address_hex, exact_units: code.exact_units, status: 'pending',
    expires_at: new Date(Date.now() + JOIN_CLAIM_TTL_MS).toISOString() } }, 201);
}

// GET /join/claims — operator only: pending claims awaiting an inflow.
async function getJoinClaims(request, env) {
  if (!keyMatches(request.headers.get('x-registry-key'), env.REGISTRY_KEY)) {
    return json({ ok: false, error: 'operator key required' }, 401);
  }
  const { results } = await env.REGISTRY_DB.prepare(
    `SELECT * FROM join_claims WHERE status = ? ORDER BY ts, id`).bind('pending').all();
  const claims = (results ?? []).map(r => {
    let p = {};
    try { p = JSON.parse(r.payload ?? '{}'); } catch {}
    return { id: r.id, code_nonce: r.code_nonce, address_hex: r.address_hex,
      exact_units: r.exact_units, nonce: r.nonce, ts: r.ts, prepared: p.prepared ?? null };
  });
  return json({ ok: true, claims });
}

// POST /join/fulfill — operator only: mark a claim 'fulfilled' once the
// matcher credited its inflow. Only a 'pending' claim transitions, so a
// claim can never credit twice through this endpoint.
async function postJoinFulfill(request, env) {
  if (!keyMatches(request.headers.get('x-registry-key'), env.REGISTRY_KEY)) {
    return json({ ok: false, error: 'operator key required' }, 401);
  }
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'body must be JSON' }, 400); }
  const id = Number(body?.id);
  const nonce = typeof body?.nonce === 'string' ? body.nonce : null;
  if ((!Number.isSafeInteger(id) || id <= 0) && !nonce) {
    return json({ ok: false, error: 'give claim id or nonce' }, 400);
  }
  const r = id
    ? await env.REGISTRY_DB.prepare(
        `UPDATE join_claims SET status = ? WHERE id = ? AND status = 'pending'`)
        .bind('fulfilled', id).run()
    : await env.REGISTRY_DB.prepare(
        `UPDATE join_claims SET status = ? WHERE nonce = ? AND status = 'pending'`)
        .bind('fulfilled', nonce).run();
  return json({ ok: true, updated: r?.meta?.changes ?? 0 });
}

async function getHealth(env) {
  const row = await env.REGISTRY_DB.prepare('SELECT COUNT(*) AS n FROM records').first();
  return json({ ok: true, records: Number(row?.n ?? 0) });
}

export default {
  async fetch(request, env) {
    try {
      if (!env.REGISTRY_DB) return json({ ok: false, error: 'REGISTRY_DB binding missing' }, 500);
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (url.pathname === '/calc' && request.method === 'POST') return await postCalc(request, env);
      if (url.pathname === '/fulfill' && request.method === 'POST') return await postFulfill(request, env);
      if (url.pathname === '/hold' && request.method === 'POST') return await postHold(request, env);
      if (url.pathname === '/sweep' && request.method === 'POST') return await postSweep(request, env);
      if (url.pathname === '/lookup' && request.method === 'GET') return await getLookup(request, env, url);
      if (url.pathname === '/exit' && request.method === 'POST') return await postExit(request, env);
      if (url.pathname === '/exit/verify' && request.method === 'POST') return await postExitVerify(request, env);
      if (url.pathname === '/exit/pending' && request.method === 'GET') return await getExitPending(request, env);
      if (url.pathname === '/exit/resolve' && request.method === 'POST') return await postExitResolve(request, env);
      if (url.pathname === '/join/code' && request.method === 'POST') return await postJoinCode(request, env);
      if (url.pathname === '/join/claim' && request.method === 'POST') return await postJoinClaim(request, env);
      if (url.pathname === '/join/claims' && request.method === 'GET') return await getJoinClaims(request, env);
      if (url.pathname === '/join/fulfill' && request.method === 'POST') return await postJoinFulfill(request, env);
      if (url.pathname === '/health' && request.method === 'GET') return await getHealth(env);
      return json({ ok: false, error: 'not found' }, 404);
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e).slice(0, 200) }, 500);
    }
  },
};

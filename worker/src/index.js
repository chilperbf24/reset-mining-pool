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
//   space has only 999999 values, so network-wide fingerprint
//   collisions are inevitable as the address count grows — a filed
//   calculation is the tie-breaker that says whose amount it was.
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
// fp = (sha256(normalized hex string)[0..4] as uint32 BE) mod 999999 + 1.

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

// fp = (sha256(hex)[0..4] BE mod 999999) + 1 — identical to the matcher.
async function fingerprint(addressHex) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(addressHex));
  return (new DataView(buf).getUint32(0, false) % 999999) + 1;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------ validation
const MAX_FIELD = 256;                    // any single string field
const MAX_PLANNED = 10n ** 14n;           // 1,000,000 RESET — generous ceiling
const PLANNED_STEP = 1_000_000n;          // planned amounts are 0.01 multiples
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
  return (r?.meta?.changes ?? 0) + (x?.meta?.changes ?? 0);
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
  if (fpGiven !== null && (fpGiven < 0n || fpGiven > 999999n)) {
    return json({ ok: false, error: 'fp_units out of range (0..999999)' }, 400);
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
      return json({ ok: false, error: 'planned_units must be a multiple of 0.01 RESET (1000000 units)' }, 400);
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
  return json({ ok: true, query, count: records.length, records });
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
      if (url.pathname === '/health' && request.method === 'GET') return await getHealth(env);
      return json({ ok: false, error: 'not found' }, 404);
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e).slice(0, 200) }, 500);
    }
  },
};

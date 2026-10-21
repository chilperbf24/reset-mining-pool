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
// SAFETY LINE — read before touching attribution logic anywhere:
//   A registry record is a CLUE for reconciliation and diagnosis, NOT a
//   crediting credential. POST /calc performs NO identity authentication:
//   anyone can file a calculation for any address (that openness is its
//   purpose — the calculator is public). Contribution attribution stays
//   exactly as it has always been: an on-chain inflow's tail + the
//   fingerprint rules in lib/fpmatch.mjs decide who gets credited. A row
//   in this table must never by itself move money or ledger entries.
//
// Endpoints:
//   POST /calc    public, self-validating (address<->fingerprint re-check)
//   GET  /lookup  operator only (header X-Registry-Key == REGISTRY_KEY secret)
//   GET  /health  public: { ok, records } — count only, never any detail
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

async function insertRecord(env, rec) {
  const r = await env.REGISTRY_DB.prepare(
    `INSERT INTO records (ts, kind, address_hex, planned_units, fp_units, exact_units, status, source, note, ip_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(rec.ts, rec.kind, rec.address_hex, rec.planned_units, rec.fp_units,
          rec.exact_units, rec.status, rec.source, rec.note, rec.ip_hash)
    .run();
  return r?.meta?.last_row_id ?? null;
}

// ---------------------------------------------------------------- routes
async function postCalc(request, env) {
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
      if (url.pathname === '/lookup' && request.method === 'GET') return await getLookup(request, env, url);
      if (url.pathname === '/health' && request.method === 'GET') return await getHealth(env);
      return json({ ok: false, error: 'not found' }, 404);
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e).slice(0, 200) }, 500);
    }
  },
};

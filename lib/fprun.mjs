// Shared runner for fingerprint matching: state-file IO + candidate loading.
// Used by fp-match.mjs (the 1-minute systemd service) and by pool-worker.mjs
// (inside its 10-minute pass, before lock/claim) — both paths share the
// state/matcher.json baseline and MUST run under the same flock
// (~/workspace/reset-pool/.worker.lock) so an inflow is never credited twice.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { emptyMatcher, emptyUnclaimed, emptyFpCache, processObservation,
  previewInflowCandidate, decideRegistryAttribution, decideJoinAttribution,
  registryNoteSuffix, claimEntryAs, splitTail, fingerprintUnits } from './fpmatch.mjs';
import { isAddress } from './pool.mjs';

// Root = the repo directory (this file lives in lib/), derived from the
// module location — NOT from $HOME: the systemd service environment has
// no HOME, and the cron/agent shells may differ too.
export const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
export const PATHS = {
  ledger: `${ROOT}/state/live-ledger.json`,
  matcher: `${ROOT}/state/matcher.json`,
  unclaimed: `${ROOT}/state/unclaimed.json`,
  fpCache: `${ROOT}/state/fp-cache.json`,
  gwCache: `${ROOT}/state/gateway-cache.json`,
  log: `${ROOT}/pool.log`,
};
const GW = 'https://reset.openmayhem.ai';

const readJSON = (p, fallback) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } };
const writeJSON = (p, x) => writeFileSync(p, JSON.stringify(x, null, 2));
async function fetchJSON(url, ms = 15000) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return r.ok ? await r.json() : null; }
  catch { return null; }
}

export function loadStates() {
  const ledger = JSON.parse(readFileSync(PATHS.ledger, 'utf8'));
  return {
    ledger,
    matcher: readJSON(PATHS.matcher, emptyMatcher(ledger.pool_address)),
    unclaimed: readJSON(PATHS.unclaimed, emptyUnclaimed()),
    fpCache: readJSON(PATHS.fpCache, emptyFpCache()),
  };
}
export function saveStates({ ledger, matcher, unclaimed, fpCache }, { ledgerDirty = false } = {}) {
  writeJSON(PATHS.matcher, matcher);
  writeJSON(PATHS.unclaimed, unclaimed);
  writeJSON(PATHS.fpCache, fpCache);
  if (ledgerDirty) writeJSON(PATHS.ledger, ledger);
}

// Plausible senders: every address on the network's miner list (gateway
// /v1/mine/view, fresh fetch preferred, the site generator's cache file as
// fallback), plus ledger contributors and past successful fingerprint
// matches. A sender missing from all of these (brand-new address) simply
// lands in unclaimed and claims later with the address alone.
export async function loadCandidates({ ledger, fpCache }) {
  const set = new Set([...Object.keys(ledger.contributors ?? {}), ...Object.keys(fpCache.matches ?? {})]);
  let fresh = 0;
  let after = '';
  for (let page = 0; page < 25; page++) {
    const mv = await fetchJSON(`${GW}/v1/mine/view${after ? `?after=${after}` : ''}`);
    if (!mv) break;
    for (const r of mv.miners ?? []) if (Array.isArray(r) && isAddress(r[0])) { set.add(r[0]); fresh++; }
    if (!mv.next) break;
    after = mv.next;
  }
  if (!fresh) {
    const c = readJSON(PATHS.gwCache, null);
    for (const r of c?.miners ?? []) if (Array.isArray(r) && isAddress(r[0])) set.add(r[0]);
  }
  set.delete(ledger.pool_address);
  return [...set];
}

// ---------------------------------------------------------------------
// Calculation registry (worker/ in this repo) — the PRIMARY attribution
// source since the operator ruling of 2026-10-22 (see the priority note
// at the top of lib/fpmatch.mjs). The incident that forced this: on
// 2026-10-22 02:18Z an inflow of 8216449 units (tail 216449) was parked
// as unclaimed #3 with a bare "no candidate" note, although the sender
// had filed exactly that calculation in the registry (calc rows #11/#13,
// server-verified fp=216449) — the registry consultation below existed
// but (a) only ever produced a note, never a credit, and (b) never even
// ran: the passes execute inside pool-worker.mjs, whose process
// environment carried no REGISTRY_URL / REGISTRY_KEY. The variables
// existed only in ~/.reset-pool-registry.env, which solely the systemd
// unit's EnvironmentFile would have read — and that unit was not
// installed on this VM at all (it is lost on every VM replacement until
// reinstalled from systemd/). registryCalcByTail saw unset env, returned
// null, and the old code silently skipped: no lead, no error, no trace.
//
// Fixes embodied below, so this cannot silently recur:
// 1. Config resolution falls back to ~/.reset-pool-registry.env (the
//    600-permission operator env file) when the process env lacks the
//    variables — every launcher (systemd unit, runtime cron worker,
//    operator CLI) reaches the registry with zero per-launcher wiring.
// 2. NO SILENT DEGRADATION. When the registry is configured (env or env
//    file — on this deployment it always is) but a call fails or times
//    out, the pass records matcher.registry_error {at, error} in
//    state/matcher.json and emits a registry_error log action. A later
//    successful pass clears it (registry_recovered). "Unconfigured" is
//    itself an error on this deployment, never a quiet skip.
// 3. The registry DECIDES (decideRegistryAttribution): an exact
//    (tail, amount) record naming one address credits that address
//    (source 'registry-calc'); fingerprint reverse lookup is the
//    fallback for amounts the registry knows nothing exact about.
// 4. Every still-open unclaimed entry is re-decided against the
//    registry on EVERY pass ("retro"), so an entry parked while the
//    registry was unreachable self-heals on a later pass — and entries
//    whose registry evidence exists get /hold-called so the registry's
//    30-minute TTL cannot delete the proof before attribution lands.
let _regCfg; // undefined = not resolved yet; null = unconfigured
export function registryConfig() {
  if (_regCfg !== undefined) return _regCfg;
  let url = process.env.REGISTRY_URL || null;
  let key = process.env.REGISTRY_KEY || null;
  if (!url || !key) {
    try {
      for (const line of readFileSync(`${homedir()}/.reset-pool-registry.env`, 'utf8').split('\n')) {
        const m = line.match(/^\s*(REGISTRY_URL|REGISTRY_KEY)\s*=\s*(\S+)\s*$/);
        if (!m) continue;
        if (m[1] === 'REGISTRY_URL' && !url) url = m[2];
        if (m[1] === 'REGISTRY_KEY' && !key) key = m[2];
      }
    } catch { /* no env file: stays unconfigured */ }
  }
  _regCfg = url && key ? { url: url.replace(/\/$/, ''), key } : null;
  return _regCfg;
}

// One registry call with a LOUD result: { ok:true, json } on 2xx,
// { ok:false, error } on HTTP error / timeout / unconfigured. The key
// is only ever sent as the auth header — never logged, never returned.
async function registryCall(path, { method = 'GET', body } = {}) {
  const cfg = registryConfig();
  if (!cfg) return { ok: false, error: 'registry not configured: REGISTRY_URL/REGISTRY_KEY absent from process env and ~/.reset-pool-registry.env' };
  try {
    const r = await fetch(`${cfg.url}${path}`, {
      method,
      headers: { 'X-Registry-Key': cfg.key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return { ok: false, error: `registry ${method} ${path.split('?')[0]} -> HTTP ${r.status}` };
    return { ok: true, json: await r.json().catch(() => null) };
  } catch (e) {
    return { ok: false, error: `registry ${method} ${path.split('?')[0]} unreachable: ${String((e && e.message) || e).slice(0, 120)}` };
  }
}

// All registry rows for one tail (calc + calc_blocked; the decision
// function separates them). Loud shape mirrors registryCall.
export async function registryLookupByTail(tailUnits) {
  const res = await registryCall(`/lookup?tail=${tailUnits}`);
  if (!res.ok) return res;
  return { ok: true, records: (res.json?.records ?? []).filter(x => x.kind === 'calc' || x.kind === 'calc_blocked') };
}

// When an inflow is credited — registry decision, fingerprint fallback,
// retro claim, or a successful claim in claim-unclaimed.mjs — mark the
// filer's calc record 'fulfilled' so the registry's TTL keeps it as the
// audit trail "calculated -> arrived".
export async function registryFulfill({ tail, address } = {}) {
  const payload = {};
  if (tail != null) payload.tail = String(tail);
  if (address) payload.address = address;
  if (!('tail' in payload) && !('address' in payload)) return false;
  return (await registryCall('/fulfill', { method: 'POST', body: payload })).ok;
}

// Freeze the calc records behind a parked unclaimed entry: /hold moves
// an exact (tail, amount) record to status 'held', which the sweep
// never deletes — the evidence outlives the 30-minute TTL until the
// entry is attributed (then /fulfill closes it out) or an operator
// resolves it by hand.
export async function registryHold({ tail, exact_units } = {}) {
  if (tail == null || exact_units == null) return false;
  return (await registryCall('/hold', { method: 'POST', body: { tail: String(tail), exact_units: String(exact_units) } })).ok;
}

// One TTL sweep per pass: deletes calc records still status='ok' whose
// 30 minutes ran out. (The Worker also sweeps opportunistically on
// every POST /calc; this call keeps expiry moving even on quiet days.)
export async function registrySweep() {
  return (await registryCall('/sweep', { method: 'POST', body: {} })).ok;
}

// AI-join pending claims (Worker GET /join/claims, operator key): receipts
// the Worker already signature-verified, each awaiting an inflow of
// exactly its amount. A claim here is a credit instruction, never a guess.
export async function registryJoinClaims() {
  const res = await registryCall('/join/claims');
  if (!res.ok) return res;
  return { ok: true, claims: (res.json?.claims ?? []) };
}

// Mark a join claim 'fulfilled' once its inflow has been credited
// (fresh or retro). Only a 'pending' claim transitions, so a claim can
// never credit twice through this call.
export async function registryJoinFulfill({ id, nonce } = {}) {
  const payload = {};
  if (id != null) payload.id = id;
  if (nonce) payload.nonce = nonce;
  if (!('id' in payload) && !('nonce' in payload)) return false;
  return (await registryCall('/join/fulfill', { method: 'POST', body: payload })).ok;
}

// Retro gate for the AI-join channel, extracted so tests can prove it
// without running a full pass: a parked inflow credits via ai-join
// only when a signature-verified pending claim names an address whose
// exact amount AND fingerprint both match the entry — and never the
// pool's own address. Amount alone is never attribution.
export function findJoinRetroClaim(joinClaims, entry, poolAddress) {
  // NOTE: fingerprint() returns a Number — comparing it with === against
  // a BigInt is ALWAYS false. The original inline retro check had
  // exactly that bug (retro could never fire); fingerprintUnits (BigInt)
  // is the correct comparator, same as claimEntryAs uses.
  return (joinClaims ?? []).find(c => c.address_hex && c.address_hex !== poolAddress &&
    c.exact_units !== null && c.exact_units !== undefined &&
    BigInt(c.exact_units) === BigInt(entry.amount_units) &&
    fingerprintUnits(c.address_hex) === BigInt(entry.tail_units)) ?? null;
}

// Run one matching observation. `totalUnits` is the pool's current
// balance+deposit in units; `lastResult` the gateway's mine.last_result
// ({r, amount} in units) or null. Persists state; returns the actions.
export async function runFingerprintPass({ totalUnits, lastResult, log = () => {} }) {
  const states = loadStates();
  const candidates = await loadCandidates(states);
  const now = new Date().toISOString();
  // Registry failures during this pass, collected loudly (see header):
  // the first error wins; it lands in matcher.registry_error + the log.
  let registryError = null;
  const noteRegistryError = e => { if (!registryError && e) registryError = String(e); };
  const lookCache = new Map();
  const lookupTail = async tail => {
    const k = String(tail);
    if (!lookCache.has(k)) lookCache.set(k, await registryLookupByTail(k));
    const res = lookCache.get(k);
    if (!res.ok) noteRegistryError(res.error);
    return res;
  };

  // --- Step 0: AI-join claims (priority #0). Fetch the pending
  // signature-verified receipts once per pass. A fetch failure is a
  // loud registry error under the same discipline as every other
  // registry call — a pending claim must never be silently missed.
  let joinClaims = [];
  {
    const jc = await registryJoinClaims();
    if (jc.ok) joinClaims = jc.claims ?? [];
    else if (registryConfig()) noteRegistryError(`registry GET /join/claims failed: ${jc.error}`);
  }

  // --- Step 1: decisions for the fresh inflow. The join decision is
  // made first (priority #0), then the registry decision (priority #1).
  // Preview the candidate with the same arithmetic processObservation
  // will apply, look its tail up, decide. Decisions are keyed by
  // amount and re-checked inside processObservation before they apply.
  let registryDecision = null;
  let joinDecision = null;
  const preview = previewInflowCandidate({ totalUnits, lastResult }, states.matcher);
  if (preview && preview > 0n) {
    const jd = decideJoinAttribution(joinClaims, preview, states.ledger.pool_address);
    if (jd.type === 'credit') {
      joinDecision = { amount_units: preview.toString(), mode: 'credit', address: jd.address,
        claim_nonce: jd.claim.nonce ?? null, claim_id: jd.claim.id ?? null };
    } else if (jd.type === 'conflict') {
      joinDecision = { amount_units: preview.toString(), mode: 'park',
        note: `join conflict: ${jd.addresses.length} different addresses filed a signed receipt for an identical amount (exact ${preview}) — parked for manual review; the receipts are the attribution evidence` };
    }
    const { tail } = splitTail(preview);
    const look = await lookupTail(tail.toString());
    if (look.ok) {
      const d = decideRegistryAttribution(look.records, preview);
      if (d.type === 'credit') {
        registryDecision = { amount_units: preview.toString(), mode: 'credit', address: d.address };
      } else if (d.type === 'conflict') {
        registryDecision = { amount_units: preview.toString(), mode: 'park',
          note: `registry conflict: ${d.addresses.length} different addresses filed an identical calculation (tail ${tail}, exact ${preview}) — parked for manual review; the registry records are the attribution evidence` };
      } else {
        const suffix = registryNoteSuffix(look.records, preview);
        if (suffix) registryDecision = { amount_units: preview.toString(), mode: 'fallback', parkNoteSuffix: suffix };
      }
    }
  }

  const actions = processObservation(
    { totalUnits, lastResult, now },
    { ...states, candidates, registryDecision, joinDecision });

  // --- Step 2: freeze registry evidence behind freshly parked entries.
  for (const a of actions) {
    if (a.type !== 'unclaimed') continue;
    const entry = states.unclaimed.entries.find(e => e.id === a.entry_id);
    if (entry && await holdEvidenceFor(entry, lookupTail)) a.registry_held = true;
  }

  // --- Step 3: retro pass — re-decide every still-open unclaimed entry
  // against the registry ("registry first, fingerprint was already
  // tried when it parked"). An entry whose sender filed late, or that
  // was parked while the registry was unreachable, credits here.
  const parkedThisPass = new Set(actions.filter(a => a.type === 'unclaimed').map(a => a.entry_id));
  for (const entry of states.unclaimed.entries) {
    if (entry.status !== 'open' || entry.kind !== 'unattributed_inflow' || parkedThisPass.has(entry.id)) continue;
    // Join retro FIRST (priority #0): the inflow arrived before the
    // receipt did. A pending claim whose exact amount matches AND whose
    // address fingerprint equals the entry's tail credits the entry —
    // the signature the Worker already verified is the attribution
    // evidence, so no fingerprint-candidate lookup is needed.
    const jc = findJoinRetroClaim(joinClaims, entry, states.ledger.pool_address);
    if (jc) {
      claimEntryAs({ unclaimed: states.unclaimed, ledger: states.ledger, now }, entry.id, jc.address_hex,
        { source: 'ai-join', method: 'join', joinClaimNonce: jc.nonce ?? null,
          resolution: `auto-credited on re-check: a signature-verified join receipt names this address for exactly ${entry.amount_units} units` });
      actions.push({ type: 'credited', via: 'ai-join-retro', entry_id: entry.id, address: jc.address_hex,
        amount_units: entry.amount_units, fp_tail_units: entry.tail_units, join_claim_nonce: jc.nonce ?? null });
      continue;
    }
    const look = await lookupTail(entry.tail_units);
    if (!look.ok) continue; // error already noted; next pass retries
    const d = decideRegistryAttribution(look.records, BigInt(entry.amount_units));
    if (d.type === 'credit' && d.address !== states.ledger.pool_address) {
      claimEntryAs({ unclaimed: states.unclaimed, ledger: states.ledger, now }, entry.id, d.address,
        { source: 'registry-calc', method: 'registry',
          resolution: `auto-credited on re-check: the calculation registry holds an exact (tail ${entry.tail_units}, amount ${entry.amount_units}) calculation for this address` });
      actions.push({ type: 'credited', via: 'registry-retro', entry_id: entry.id, address: d.address,
        amount_units: entry.amount_units, fp_tail_units: entry.tail_units });
    } else {
      if (await holdEvidenceFor(entry, lookupTail)) entry.registry_held = true;
      const suffix = d.type === 'conflict'
        ? `; registry conflict: ${d.addresses.length} different addresses filed an identical calculation (tail ${entry.tail_units}, exact ${entry.amount_units}) — parked for manual review`
        : registryNoteSuffix(look.records, BigInt(entry.amount_units));
      if (suffix && !(entry.note ?? '').includes('registry')) entry.note = `${entry.note ?? 'unclaimed'}${suffix}`;
    }
  }

  // --- Step 4: registry bookkeeping. Every credit fulfils its calc
  // record (whichever path credited it); one TTL sweep per pass. These
  // used to be silent best-effort; failures now join the loud error.
  for (const a of actions) {
    if (a.type === 'credited') {
      a.registry_fulfilled = await registryFulfill({ tail: a.fp_tail_units, address: a.address });
      if (!a.registry_fulfilled && registryConfig()) noteRegistryError('registry POST /fulfill failed');
      // AI-join credits consume their claim exactly once (fresh or retro).
      if (a.join_claim_nonce) {
        a.join_fulfilled = await registryJoinFulfill({ nonce: a.join_claim_nonce });
        if (!a.join_fulfilled && registryConfig()) noteRegistryError('registry POST /join/fulfill failed');
      }
    }
  }
  if (!(await registrySweep()) && registryConfig()) noteRegistryError('registry POST /sweep failed');

  // --- Step 5: persist the registry health marker, then the states.
  if (registryError) {
    states.matcher.registry_error = { at: now, error: registryError };
    actions.push({ type: 'registry_error', error: registryError });
  } else if (states.matcher.registry_error) {
    delete states.matcher.registry_error;
    actions.push({ type: 'registry_recovered' });
  }
  const credited = actions.some(a => a.type === 'credited');
  saveStates(states, { ledgerDirty: credited });
  for (const a of actions) log({ event: 'fp_match', ...a });
  return actions;

  // If the registry holds an exact (tail, amount) calc record that is
  // still sweepable (status 'ok'), /hold it so the TTL cannot delete
  // the attribution evidence while the entry waits. Returns true when a
  // hold call was made successfully; lookup/hold failures are noted.
  async function holdEvidenceFor(entry, lookup) {
    const look = await lookup(entry.tail_units);
    if (!look.ok) return false;
    const hasSweepableExact = (look.records ?? []).some(r => r.kind === 'calc' && r.status === 'ok' &&
      r.exact_units !== null && r.exact_units !== undefined && BigInt(r.exact_units) === BigInt(entry.amount_units));
    if (!hasSweepableExact) return false;
    const okHold = await registryHold({ tail: entry.tail_units, exact_units: entry.amount_units });
    if (!okHold && registryConfig()) noteRegistryError('registry POST /hold failed');
    return okHold;
  }
}

// Current pool position from the gateway (units). Used by fp-match.mjs,
// which deliberately has no signer connection: read-only public data only.
export async function gatewayPoolPosition(poolAddress) {
  const acc = await fetchJSON(`${GW}/v1/account/${poolAddress}`, 20000);
  if (!acc) return null;
  const units = x => BigInt(Math.round(Number(x ?? 0)));
  const lr = acc.mine?.last_result;
  return {
    totalUnits: units(acc.balance) + units(acc.deposit),
    lastResult: lr && lr.r != null && lr.amount != null ? { r: lr.r, amount: BigInt(Math.round(Number(lr.amount))) } : null,
  };
}

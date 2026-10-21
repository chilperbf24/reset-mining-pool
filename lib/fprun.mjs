// Shared runner for fingerprint matching: state-file IO + candidate loading.
// Used by fp-match.mjs (the 1-minute systemd service) and by pool-worker.mjs
// (inside its 10-minute pass, before lock/claim) — both paths share the
// state/matcher.json baseline and MUST run under the same flock
// (~/workspace/reset-pool/.worker.lock) so an inflow is never credited twice.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { emptyMatcher, emptyUnclaimed, emptyFpCache, processObservation } from './fpmatch.mjs';
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

// Calculation-registry cross-check (worker/ in this repo): before an
// inflow is parked as unclaimed, ask the registry whether anyone filed a
// calculation for this tail — the answer (address + when) is written into
// the entry's note as a diagnostic lead. CLUE ONLY: attribution still
// follows the fingerprint rules alone; a registry hit never credits
// anyone by itself. Endpoint + operator key come from the environment
// (REGISTRY_URL / REGISTRY_KEY — set by the service's deployment, never
// written to any file); unset or unreachable → silently skip, exactly
// the pre-registry behavior.
async function registryCalcByTail(tailUnits) {
  const base = process.env.REGISTRY_URL, key = process.env.REGISTRY_KEY;
  if (!base || !key) return null;
  try {
    const r = await fetch(`${base.replace(/\/$/, '')}/lookup?tail=${tailUnits}`,
      { headers: { 'X-Registry-Key': key }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = await r.json();
    return (j?.records ?? []).filter(x => x.kind === 'calc' || x.kind === 'calc_blocked');
  } catch { return null; }
}

// Operator POST to the registry (same env contract as above).
// Best-effort by design: true on a 2xx, false otherwise — registry
// bookkeeping must never break matching.
async function registryPost(path, payload) {
  const base = process.env.REGISTRY_URL, key = process.env.REGISTRY_KEY;
  if (!base || !key) return false;
  try {
    const r = await fetch(`${base.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Registry-Key': key },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok;
  } catch { return false; }
}

// When an inflow is credited — an automatic fingerprint match in the
// pass below, or a successful unclaimed claim in claim-unclaimed.mjs —
// mark the filer's calc record 'fulfilled' so the registry's 30-minute
// TTL keeps it as the audit trail "calculated -> arrived". Pure
// bookkeeping: attribution already happened on fingerprint rules alone.
export async function registryFulfill({ tail, address } = {}) {
  const payload = {};
  if (tail != null) payload.tail = String(tail);
  if (address) payload.address = address;
  if (!('tail' in payload) && !('address' in payload)) return false;
  return registryPost('/fulfill', payload);
}

// One TTL sweep per pass: deletes calc records whose 30 minutes ran
// out unfulfilled. (The Worker also sweeps opportunistically on every
// POST /calc; this call keeps expiry moving even on quiet days.)
export async function registrySweep() {
  return registryPost('/sweep', {});
}

// Run one matching observation. `totalUnits` is the pool's current
// balance+deposit in units; `lastResult` the gateway's mine.last_result
// ({r, amount} in units) or null. Persists state; returns the actions.
export async function runFingerprintPass({ totalUnits, lastResult, log = () => {} }) {
  const states = loadStates();
  const candidates = await loadCandidates(states);
  const actions = processObservation(
    { totalUnits, lastResult, now: new Date().toISOString() },
    { ...states, candidates });
  // Enrich freshly parked unclaimed entries with registry leads (before
  // persisting, so the note lands in state/unclaimed.json directly).
  for (const a of actions) {
    if (a.type !== 'unclaimed') continue;
    const entry = states.unclaimed.entries.find(e => e.id === a.entry_id);
    if (!entry) continue;
    const calcs = await registryCalcByTail(entry.tail_units);
    if (calcs?.length) {
      const lead = calcs[calcs.length - 1];
      entry.note = `${entry.note ?? 'unclaimed'}; registry has calc for ${lead.address_hex ?? '(unparseable address)'} at ${lead.ts}`;
      a.registry_lead = { address: lead.address_hex, ts: lead.ts };
    }
  }
  // Registry bookkeeping (best-effort, env-gated — see above): every
  // credit fulfils its calc record; one TTL sweep per pass.
  for (const a of actions) {
    if (a.type === 'credited') a.registry_fulfilled = await registryFulfill({ tail: a.fp_tail_units, address: a.address });
  }
  await registrySweep();
  const credited = actions.some(a => a.type === 'credited');
  saveStates(states, { ledgerDirty: credited });
  for (const a of actions) log({ event: 'fp_match', ...a });
  return actions;
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

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

// Run one matching observation. `totalUnits` is the pool's current
// balance+deposit in units; `lastResult` the gateway's mine.last_result
// ({r, amount} in units) or null. Persists state; returns the actions.
export async function runFingerprintPass({ totalUnits, lastResult, log = () => {} }) {
  const states = loadStates();
  const candidates = await loadCandidates(states);
  const actions = processObservation(
    { totalUnits, lastResult, now: new Date().toISOString() },
    { ...states, candidates });
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

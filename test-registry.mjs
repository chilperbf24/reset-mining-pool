#!/usr/bin/env node
// Registry-first attribution checks (operator ruling 2026-10-22):
// the calculation registry decides attribution on an exact (tail,
// amount) hit; fingerprint reverse lookup is the fallback. Covers
// lib/fpmatch.mjs (decideRegistryAttribution, processObservation's
// registryDecision handling, claimEntryAs) and the registry client in
// lib/fprun.mjs (config fallback + LOUD failure shapes, via child
// processes against a stub registry / a dead port / no config).
//   node test-registry.mjs
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { emptyState, parseCoin } from './lib/pool.mjs';
import { fingerprint, fingerprintUnits, sendAmountFor, splitTail,
  processObservation, claimEntry, claimEntryAs, emptyMatcher, emptyUnclaimed,
  emptyFpCache, decideRegistryAttribution, decideJoinAttribution, registryNoteSuffix,
  previewInflowCandidate } from './lib/fpmatch.mjs';

const POOL = '4150cf82f0189371818a22d5f5b10d52aadf9108c78020cc97fc002df6eaaca6';
const A = 'aa'.repeat(32), B = 'bb'.repeat(32), NEW = 'ee'.repeat(32);
const mkCtx = (candidates, extra = {}) => ({ matcher: emptyMatcher(POOL), unclaimed: emptyUnclaimed(),
  ledger: emptyState(POOL), fpCache: emptyFpCache(), candidates, ...extra });
const calcRec = (address, planned, extra = {}) => {
  const fp = fingerprint(address);
  return { kind: 'calc', status: 'ok', address_hex: address,
    planned_units: String(planned), fp_units: String(fp),
    exact_units: String(BigInt(planned) + BigInt(fp)), ts: '2026-10-22T02:07:00.000Z', ...extra };
};
let n = 0; const ok = name => console.log(`  ok ${++n}. ${name}`);

// ------------------------------------------------ decideRegistryAttribution
{
  const amt = sendAmountFor(NEW, parseCoin('0.08'));
  const d = decideRegistryAttribution([calcRec(NEW, parseCoin('0.08'))], amt);
  assert.equal(d.type, 'credit'); assert.equal(d.address, NEW);
  ok('decide: unique exact ok record -> credit');
}
{
  const amt = sendAmountFor(NEW, parseCoin('0.08'));
  const d = decideRegistryAttribution([calcRec(NEW, parseCoin('0.08'), { status: 'held' })], amt);
  assert.equal(d.type, 'credit'); ok('decide: held record still credits (matcher froze it as evidence)');
}
{
  const amt = sendAmountFor(NEW, parseCoin('0.08'));
  const d = decideRegistryAttribution([calcRec(NEW, parseCoin('0.08'), { status: 'fulfilled' })], amt);
  assert.equal(d.type, 'none'); ok('decide: fulfilled record is consumed -> none (never credits twice)');
}
{
  const amt = sendAmountFor(NEW, parseCoin('0.08'));
  const d = decideRegistryAttribution([calcRec(NEW, parseCoin('0.09'))], amt);
  assert.equal(d.type, 'none'); assert.equal(d.tailRecords.length, 1);
  ok('decide: same tail, different exact -> none, tail records kept for the note');
}
{
  const planned = parseCoin('0.08');
  const amt = BigInt(planned) + BigInt(fingerprint(NEW));
  const r1 = calcRec(NEW, planned);
  const r2 = { ...calcRec(A, planned), fp_units: String(fingerprint(NEW)), exact_units: String(amt) };
  // r2 is a (tail, exact) twin under a different address (the registry
  // would only hold it if A's own fp matched — simulate the raw shape
  // the decider must defend against: two addresses, one exact amount).
  const d = decideRegistryAttribution([r1, r2], amt);
  assert.equal(d.type, 'conflict'); assert.deepEqual(new Set(d.addresses), new Set([NEW, A]));
  ok('decide: two addresses with identical (tail, exact) -> conflict');
}
{
  const amt = sendAmountFor(NEW, parseCoin('0.08'));
  const blocked = { ...calcRec(NEW, parseCoin('0.08')), kind: 'calc_blocked', status: 'blocked_pool' };
  assert.equal(decideRegistryAttribution([blocked], amt).type, 'none');
  assert.equal(decideRegistryAttribution([], amt).type, 'none');
  assert.equal(registryNoteSuffix([], amt), '');
  const sfx = registryNoteSuffix([calcRec(NEW, parseCoin('0.09'))], amt);
  assert(sfx.includes('registry has 1 calc record(s)') && sfx.includes('no exact unfulfilled match'));
  ok('decide: calc_blocked never credits; note suffix summarizes tail records');
}

// ------------------------------------------------ previewInflowCandidate
{
  const m = emptyMatcher(POOL);
  assert.equal(previewInflowCandidate({ totalUnits: 100n, lastResult: null }, m), null);
  m.last_total_units = '0'; m.accounted_settle_round = null;
  assert.equal(previewInflowCandidate({ totalUnits: 100n, lastResult: { r: 3, amount: 40n } }, m), 60n);
  assert.equal(previewInflowCandidate({ totalUnits: 100n, lastResult: null }, m), 100n);
  assert.equal(previewInflowCandidate({ totalUnits: 0n, lastResult: null }, m), 0n);
  ok('preview: mirrors delta-minus-settlement arithmetic without mutating');
}

// --------------------------------------- processObservation + registryDecision
// A fingerprint collision pair (birthday search, same trick as test.mjs):
// X and Y share one tail, so ONE exact amount is consistent with both.
let X, Y;
{
  const seen = new Map();
  for (let i = 0; ; i++) {
    const addr = i.toString(16).padStart(64, '0');
    const fp = fingerprint(addr);
    if (seen.has(fp)) { X = seen.get(fp); Y = addr; break; }
    seen.set(fp, addr);
  }
}
const plannedXY = parseCoin('0.05');
const amtXY = plannedXY + fingerprintUnits(X); // == planned + fp(Y)
{
  // Registry names Y; fingerprint alone (candidates=[X]) would name X.
  // Registry wins, and the collision lands in the action + ledger event.
  const ctx = mkCtx([X], { registryDecision: { amount_units: amtXY.toString(), mode: 'credit', address: Y } });
  processObservation({ totalUnits: 0n, lastResult: null }, ctx);
  const acts = processObservation({ totalUnits: amtXY, lastResult: null }, ctx);
  const credit = acts.find(a => a.type === 'credited');
  assert(credit && credit.via === 'registry' && credit.address === Y && credit.fp_collision === X);
  assert.equal(ctx.ledger.contributors[Y].contributed, amtXY.toString());
  assert.equal(ctx.ledger.contributors[X], undefined);
  const ev = ctx.ledger.events.at(-1);
  assert.equal(ev.data.source, 'registry-calc');
  assert(ev.data.note.includes('prevailed over fingerprint candidate'));
  ok('priority: registry credit beats a DIFFERENT unique fingerprint candidate; collision on record');
}
{
  // The incident shape: sender is in NO network candidate list, but the
  // registry holds their exact calculation -> credited, never parked.
  const amt = sendAmountFor(NEW, parseCoin('0.08'));
  const ctx = mkCtx([A, B], { registryDecision: { amount_units: amt.toString(), mode: 'credit', address: NEW } });
  processObservation({ totalUnits: 0n, lastResult: null }, ctx);
  const acts = processObservation({ totalUnits: amt, lastResult: null }, ctx);
  assert(acts.some(a => a.type === 'credited' && a.via === 'registry' && a.address === NEW));
  assert.equal(ctx.unclaimed.entries.length, 0);
  ok('incident shape: registry credit lands even with zero fingerprint candidates');
}
{
  // Multi-address registry conflict -> parked with the reason, no credit.
  const amt = sendAmountFor(NEW, parseCoin('0.08'));
  const note = 'registry conflict: 2 different addresses filed an identical calculation — parked for manual review';
  const ctx = mkCtx([A, B], { registryDecision: { amount_units: amt.toString(), mode: 'park', note } });
  processObservation({ totalUnits: 0n, lastResult: null }, ctx);
  processObservation({ totalUnits: amt, lastResult: null }, ctx);
  assert.equal(Object.keys(ctx.ledger.contributors).length, 0);
  assert.equal(ctx.unclaimed.entries.length, 1);
  assert.equal(ctx.unclaimed.entries[0].note, note);
  ok('conflict: parked with registry reason in the note, nothing credited');
}
{
  // Fallback: no exact registry record -> fingerprint decides; a park
  // still carries what the registry DID hold for the tail.
  const amt = sendAmountFor(NEW, parseCoin('0.08')); // NEW not a candidate
  const ctx = mkCtx([A, B], { registryDecision: { amount_units: amt.toString(), mode: 'fallback', parkNoteSuffix: '; registry has 1 calc record(s) for this tail but no exact unfulfilled match' } });
  processObservation({ totalUnits: 0n, lastResult: null }, ctx);
  processObservation({ totalUnits: amt, lastResult: null }, ctx);
  assert.equal(ctx.unclaimed.entries.length, 1);
  assert(ctx.unclaimed.entries[0].note.startsWith('no candidate address with this fingerprint tail'));
  assert(ctx.unclaimed.entries[0].note.includes('registry has 1 calc record(s)'));
  ok('fallback park: note carries registry findings, never a bare "no candidate" when registry has data');
}
{
  // No registry records at all -> classic fingerprint fallback credits.
  const sendB = sendAmountFor(B, parseCoin('0.03'));
  const ctx = mkCtx([A, B]);
  processObservation({ totalUnits: 0n, lastResult: null }, ctx);
  const acts = processObservation({ totalUnits: sendB, lastResult: null }, ctx);
  assert(acts.some(a => a.type === 'credited' && a.address === B && a.via === undefined));
  assert.equal(ctx.ledger.events.at(-1).data.source, 'fingerprint-auto');
  ok('fallback: with no registry decision, unique fingerprint candidate credits as before');
}
{
  // A decision keyed to a DIFFERENT amount is ignored (fingerprint runs).
  const sendB = sendAmountFor(B, parseCoin('0.03'));
  const ctx = mkCtx([A, B], { registryDecision: { amount_units: '123456789', mode: 'credit', address: NEW } });
  processObservation({ totalUnits: 0n, lastResult: null }, ctx);
  processObservation({ totalUnits: sendB, lastResult: null }, ctx);
  assert.equal(ctx.ledger.contributors[B].contributed, sendB.toString());
  assert.equal(ctx.ledger.contributors[NEW], undefined);
  ok('a registry decision for another amount never leaks into this inflow');
}
{
  // A registry credit naming the POOL itself is refused (guard): the
  // pool cannot contribute to itself; fingerprint path runs instead.
  const amt = sendAmountFor(NEW, parseCoin('0.08'));
  const ctx = mkCtx([A, B], { registryDecision: { amount_units: amt.toString(), mode: 'credit', address: POOL } });
  processObservation({ totalUnits: 0n, lastResult: null }, ctx);
  processObservation({ totalUnits: amt, lastResult: null }, ctx);
  assert.equal(ctx.ledger.contributors[POOL], undefined);
  assert.equal(ctx.unclaimed.entries.length, 1);
  ok('guard: registry credit to the pool address itself is refused');
}

// ------------------------------------------------ claimEntryAs (retro path)
{
  const ctx = mkCtx([A, B]);
  processObservation({ totalUnits: 0n, lastResult: null }, ctx);
  const D = sendAmountFor(NEW, parseCoin('0.05'));
  processObservation({ totalUnits: D, lastResult: null }, ctx);
  assert.equal(ctx.unclaimed.entries.length, 1);
  const entry = claimEntryAs(ctx, 1, NEW, { source: 'registry-calc', method: 'registry', resolution: 'auto-credited on re-check' });
  assert.equal(entry.status, 'claimed');
  assert.equal(entry.method, 'registry');
  assert.equal(entry.resolution, 'auto-credited on re-check');
  assert.equal(ctx.ledger.contributors[NEW].contributed, D.toString());
  assert.equal(ctx.ledger.events.at(-1).data.source, 'registry-calc');
  // the plain wrapper keeps its historical defaults
  const ctx2 = mkCtx([A]);
  processObservation({ totalUnits: 0n, lastResult: null }, ctx2);
  processObservation({ totalUnits: D, lastResult: null }, ctx2);
  const e2 = claimEntry(ctx2, 1, NEW);
  assert.equal(e2.method, undefined);
  assert.equal(ctx2.ledger.events.at(-1).data.source, 'fingerprint-claim');
  ok('claimEntryAs: retro registry claim books source/method/resolution; claimEntry defaults unchanged');
}

// ------------------------------------------------ decideJoinAttribution
{
  const amt = sendAmountFor(NEW, parseCoin('0.08'));
  const claim = { address_hex: NEW, exact_units: amt.toString(), nonce: '0123456789abcdef' };
  const d = decideJoinAttribution([claim], amt);
  assert.equal(d.type, 'credit'); assert.equal(d.address, NEW); assert.equal(d.claim.nonce, '0123456789abcdef');
  ok('decideJoin: unique pending claim with the exact amount -> credit');
  const d2 = decideJoinAttribution([{ ...claim }, { address_hex: A, exact_units: amt.toString(), nonce: 'fedcba9876543210' }], amt);
  assert.equal(d2.type, 'conflict'); assert.deepEqual(new Set(d2.addresses), new Set([NEW, A]));
  ok('decideJoin: two addresses claiming one exact amount -> conflict');
  assert.equal(decideJoinAttribution([claim], amt + 1n).type, 'none');
  assert.equal(decideJoinAttribution([], amt).type, 'none');
  ok('decideJoin: different amount / no claims -> none');
  // Address binding (user rule 2026-10-24): attribution is never amount
  // alone. A claim with no address, or one naming the pool itself, can
  // never credit — even when its amount matches exactly.
  assert.equal(decideJoinAttribution([{ address_hex: '', exact_units: amt.toString(), nonce: '1111111111111111' }], amt).type, 'none');
  assert.equal(decideJoinAttribution([{ address_hex: null, exact_units: amt.toString(), nonce: '2222222222222222' }], amt).type, 'none');
  assert.equal(decideJoinAttribution([{ address_hex: POOL, exact_units: amt.toString(), nonce: '3333333333333333' }], amt, POOL).type, 'none');
  ok('decideJoin: amount match with no address, or with the pool address, -> none (never amount alone)');
}
{
  // Fresh inflow with a pending join claim: credited via ai-join, and the
  // claim nonce lands in the ledger event for the paper trail.
  const amt = sendAmountFor(NEW, parseCoin('0.08'));
  const ctx = mkCtx([A, B], { joinDecision: { amount_units: amt.toString(), mode: 'credit', address: NEW, claim_nonce: '0123456789abcdef' } });
  processObservation({ totalUnits: 0n, lastResult: null }, ctx);
  const acts = processObservation({ totalUnits: amt, lastResult: null }, ctx);
  const credit = acts.find(a => a.type === 'credited');
  assert(credit && credit.via === 'ai-join' && credit.address === NEW && credit.join_claim_nonce === '0123456789abcdef');
  assert.equal(ctx.ledger.contributors[NEW].contributed, amt.toString());
  assert.equal(ctx.ledger.events.at(-1).data.source, 'ai-join');
  assert.equal(ctx.ledger.events.at(-1).data.join_claim_nonce, '0123456789abcdef');
  ok('joinDecision credit -> credited via ai-join with the claim nonce in the event');
}
{
  // Join conflict parks the inflow (never guesses), flagged join_conflict.
  const amt = sendAmountFor(NEW, parseCoin('0.08'));
  const ctx = mkCtx([A, B], { joinDecision: { amount_units: amt.toString(), mode: 'park',
    note: 'join conflict: 2 addresses filed a signed receipt for an identical amount — parked for manual review' } });
  processObservation({ totalUnits: 0n, lastResult: null }, ctx);
  const acts = processObservation({ totalUnits: amt, lastResult: null }, ctx);
  assert(acts.some(a => a.type === 'unclaimed' && a.join_conflict === true));
  assert.equal(ctx.unclaimed.entries.length, 1);
  assert.equal(Object.keys(ctx.ledger.contributors).length, 0);
  ok('joinDecision park (conflict) -> parked with join_conflict flag, nothing credited');
}
{
  // Priority #0: a join claim beats a registry calc naming someone else.
  const amt = sendAmountFor(NEW, parseCoin('0.08'));
  const ctx = mkCtx([A, B], {
    joinDecision: { amount_units: amt.toString(), mode: 'credit', address: NEW, claim_nonce: '0123456789abcdef' },
    registryDecision: { amount_units: amt.toString(), mode: 'credit', address: A },
  });
  processObservation({ totalUnits: 0n, lastResult: null }, ctx);
  const acts = processObservation({ totalUnits: amt, lastResult: null }, ctx);
  assert(acts.some(a => a.type === 'credited' && a.via === 'ai-join' && a.address === NEW));
  assert.equal(ctx.ledger.contributors[A], undefined);
  ok('priority: join claim beats a registry calc naming a different address');
}
{
  // A join decision for another amount never leaks into this inflow.
  const amt = sendAmountFor(NEW, parseCoin('0.08'));
  const ctx = mkCtx([A, B], { joinDecision: { amount_units: '123456789', mode: 'credit', address: NEW, claim_nonce: 'x' } });
  processObservation({ totalUnits: 0n, lastResult: null }, ctx);
  const acts = processObservation({ totalUnits: amt, lastResult: null }, ctx);
  assert(acts.some(a => a.type === 'unclaimed'));
  assert.equal(ctx.ledger.contributors[NEW], undefined);
  ok('a join decision for another amount never leaks into this inflow');
}
{
  // Retro: an inflow parked BEFORE its receipt arrived credits once the
  // claim exists — the tail check passes by construction (exact includes fp).
  const ctx = mkCtx([A, B]);
  processObservation({ totalUnits: 0n, lastResult: null }, ctx);
  const D = sendAmountFor(NEW, parseCoin('0.05'));
  processObservation({ totalUnits: D, lastResult: null }, ctx);
  assert.equal(ctx.unclaimed.entries.length, 1);
  const entry = claimEntryAs(ctx, 1, NEW, { source: 'ai-join', method: 'join',
    resolution: 'auto-credited on re-check: a signature-verified join receipt names this address' });
  assert.equal(entry.status, 'claimed'); assert.equal(entry.method, 'join');
  assert.equal(ctx.ledger.contributors[NEW].contributed, D.toString());
  assert.equal(ctx.ledger.events.at(-1).data.source, 'ai-join');
  ok('retro: parked entry + later join receipt -> claimed via ai-join (out-of-order covered)');
}

// --------------------------------------- registry client (lib/fprun.mjs)
// Driven in child processes so each scenario gets a fresh module +
// environment (the config is resolved once per process, like production).
{
  const fprunUrl = new URL('./lib/fprun.mjs', import.meta.url).href;
  const dir = mkdtempSync(`${tmpdir()}/regtest-`);
  const child = `${dir}/child.mjs`;
  writeFileSync(child, `
    import http from 'node:http';
    const mode = process.argv[2];
    if (mode === 'stub') {
      const seen = [];
      const srv = http.createServer((req, res) => {
        let b = ''; req.on('data', c => b += c); req.on('end', () => {
          seen.push(req.url);
          res.writeHead(200, { 'content-type': 'application/json' });
          if (req.url.startsWith('/lookup')) res.end(JSON.stringify({ ok: true, records: [
            { kind: 'calc', status: 'ok', address_hex: 'ee'.repeat(32) },
            { kind: 'import', status: 'credited', address_hex: 'aa'.repeat(32) } ] }));
          else if (req.url === '/hold') res.end(JSON.stringify({ ok: true, updated: 1 }));
          else if (req.url === '/fulfill') res.end(JSON.stringify({ ok: true, updated: 1 }));
          else if (req.url === '/sweep') res.end(JSON.stringify({ ok: true, deleted: 0 }));
          else if (req.url === '/join/claims') res.end(JSON.stringify({ ok: true, claims: [
            { id: 7, code_nonce: '0123456789abcdef', address_hex: 'ee'.repeat(32), exact_units: '8216449', nonce: '0123456789abcdef' } ] }));
          else if (req.url === '/join/fulfill') res.end(JSON.stringify({ ok: true, updated: 1 }));
          else res.end('{}');
        });
      });
      await new Promise(r => srv.listen(0, '127.0.0.1', r));
      process.env.REGISTRY_URL = 'http://127.0.0.1:' + srv.address().port;
      process.env.REGISTRY_KEY = 'k';
      const m = await import(${JSON.stringify(fprunUrl)});
      const look = await m.registryLookupByTail('216449');
      const held = await m.registryHold({ tail: '216449', exact_units: '8216449' });
      const ful = await m.registryFulfill({ tail: '216449' });
      const swp = await m.registrySweep();
      const jc = await m.registryJoinClaims();
      const jful = await m.registryJoinFulfill({ nonce: '0123456789abcdef' });
      console.log(JSON.stringify({ lookOk: look.ok, n: look.records?.length, kinds: look.records?.map(r => r.kind), held, ful, swp, seen,
        joinClaims: jc.claims, joinFulfilled: jful }));
      srv.close();
    } else {
      const m = await import(${JSON.stringify(fprunUrl)});
      const look = await m.registryLookupByTail('216449');
      console.log(JSON.stringify({ ok: look.ok, error: look.error ?? null }));
    }
  `);
  const run = (args, env) => JSON.parse(execFileSync(process.execPath, [child, ...args],
    { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }).trim().split('\n').pop());

  const unconf = run(['plain'], { HOME: dir }); // no env file in this HOME, no REGISTRY_*
  assert.equal(unconf.ok, false); assert(unconf.error.includes('not configured'));
  ok('client: unconfigured registry is a LOUD error, not a silent skip');

  const dead = run(['plain'], { HOME: dir, REGISTRY_URL: 'http://127.0.0.1:1', REGISTRY_KEY: 'k' });
  assert.equal(dead.ok, false); assert(dead.error.includes('unreachable'));
  ok('client: unreachable registry -> ok:false with the reason');

  const stub = run(['stub'], { HOME: dir });
  assert.equal(stub.lookOk, true); assert.equal(stub.n, 1); assert.deepEqual(stub.kinds, ['calc']);
  assert.equal(stub.held, true); assert.equal(stub.ful, true); assert.equal(stub.swp, true);
  assert(stub.seen.some(u => u.startsWith('/lookup?tail=216449')) && stub.seen.includes('/hold'));
  assert.equal(stub.joinClaims.length, 1); assert.equal(stub.joinClaims[0].address_hex, 'ee'.repeat(32));
  assert.equal(stub.joinClaims[0].exact_units, '8216449'); assert.equal(stub.joinFulfilled, true);
  assert(stub.seen.includes('/join/claims') && stub.seen.includes('/join/fulfill'));
  ok('client: lookup filters to calc kinds; hold/fulfill/sweep round-trip a stub registry; join claims + fulfill round-trip too');
}

console.log(`\ntest-registry: all ${n} checks passed`);

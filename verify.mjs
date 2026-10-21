#!/usr/bin/env node
// Independent audit verifier for RESET pool round reports.
//
// Deliberately does NOT import the pool's settlement code: it recomputes the
// split from the report's own published inputs (snapshot rows, claim amount,
// fee rate, carry-in) with its own arithmetic, then checks every hash and
// every sum. Anyone can run this against a published report:
//   node verify.mjs reports/round-1.json
// Exit code 0 = report is internally consistent and matches the formula.
// Note: this proves the *accounting* matches the published inputs. That the
// claim amount itself is real must be checked against the chain's claim
// record for the pool address and round (the report names both).
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const sha256 = s => createHash('sha256').update(s, 'utf8').digest('hex');
function stable(x) {
  if (Array.isArray(x)) return `[${x.map(stable).join(',')}]`;
  if (x && typeof x === 'object') {
    return `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${stable(x[k])}`).join(',')}}`;
  }
  return JSON.stringify(x);
}
const hashOf = x => sha256(stable(x));

function verify(path) {
  const problems = [];
  const bad = m => problems.push(m);
  let r;
  try { r = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { return { file: path, ok: false, problems: [`unreadable: ${e.message}`] }; }
  if (r.kind !== 'reset-pool-round-audit') bad('not a pool round audit report');

  // 1. Report hash covers all other fields.
  const { report_hash, ...unsigned } = r;
  if (hashOf(unsigned) !== report_hash) bad('report_hash mismatch (report was altered)');

  // 2. Snapshot hash and total.
  const snap = r.snapshot ?? {};
  const rows = snap.rows ?? [];
  const total = rows.reduce((s, x) => s + BigInt(x.deposit_units), 0n);
  if (total.toString() !== snap.total_units) bad('snapshot total != sum of rows');
  const snapHash = hashOf({ round: snap.round, pool_address: snap.pool_address, rows: snap.rows, total_units: snap.total_units });
  if (snapHash !== snap.hash) bad('snapshot hash mismatch');
  if (snap.pool_address !== r.pool_address) bad('snapshot pool address != report pool address');
  if (total < 10_000_000n) bad('snapshot total below the 0.1 contract minimum — pool could not claim');

  // 3. Recompute fee, distributable and every share from scratch.
  const amount = BigInt(r.claim?.amount_units ?? '-1');
  const fee = amount * BigInt(r.fee_per_mille) / 1000n;
  if (fee.toString() !== r.fee_units) bad(`fee mismatch: recomputed ${fee}, report says ${r.fee_units}`);
  const distributable = amount - fee + BigInt(r.carry_in_units ?? '0');
  if (distributable.toString() !== r.distributable_units) bad('distributable mismatch');
  let shareSum = 0n;
  const expect = new Map(rows.map(x => [x.address, distributable * BigInt(x.deposit_units) / total]));
  for (const s of r.shares ?? []) {
    if (!expect.has(s.address)) { bad(`share for non-contributor ${s.address}`); continue; }
    if (expect.get(s.address).toString() !== s.share_units) {
      bad(`share mismatch for ${s.address}: recomputed ${expect.get(s.address)}, report says ${s.share_units}`);
    }
    shareSum += BigInt(s.share_units);
  }
  if ((r.shares ?? []).length !== rows.length) bad('share count != contributor count');

  // 4. Dust is exactly what integer division leaves behind.
  const dust = distributable - shareSum;
  if (dust.toString() !== r.dust_units) bad(`dust mismatch: recomputed ${dust}, report says ${r.dust_units}`);
  if (dust < 0n) bad('negative dust');

  return { file: path, ok: problems.length === 0, problems,
    summary: problems.length ? undefined : {
      round: r.round, pool: r.pool_address, claim: r.claim.amount_units,
      contributors: rows.length, total_deposit: snap.total_units, dust: r.dust_units } };
}

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node verify.mjs <report.json> [...]'); process.exit(2); }
let allOk = true;
for (const f of files) {
  const v = verify(f);
  allOk &&= v.ok;
  console.log(JSON.stringify(v));
}
process.exit(allOk ? 0 : 1);

#!/usr/bin/env node
// RESET pool worker — operates ONLY the dedicated pool wallet
// (~/.reset-pool-signer), never the owner's personal wallet.
//
// Modes:
//   (none)          single pass: status -> post headers -> lock if the ledger
//                   total is funded and the pool deposit is below the minimum
//   --loop <secs>   watch continuously; exits early when a claim is due
//   --claim         execute one mine_claim at level 1000 (hard-capped)
//
// Hard guards (standing policy for this prototype):
// - claim level never above 1000 (a higher level earns strikes/penalties)
// - lock never exceeds the total actually contributed per the public ledger
// - this worker has NO transfer / unlock / withdraw code path at all.
//   Payouts and exits are separate, explicitly approved steps.
import { Client } from '../reset/signer/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../reset/signer/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { MIN_DEPOSIT, formatCoin } from './lib/pool.mjs';

const HOME = process.env.HOME;
const SIGNER = `${HOME}/workspace/reset/signer`;
const POOL_DIR = `${HOME}/.reset-pool-signer`;
const PWFILE = `${POOL_DIR}/.wallet-password`;
const LEDGER = `${HOME}/workspace/reset-pool/state/live-ledger.json`;
const LOG = `${HOME}/workspace/reset-pool/pool.log`;

const mode = process.argv[2];
const loopSecs = parseInt(process.argv[3] || '0', 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = obj => { try { appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n'); } catch {} };

function ledgerTotalUnits() {
  if (!existsSync(LEDGER)) return 0n;
  try {
    const s = JSON.parse(readFileSync(LEDGER, 'utf8'));
    return Object.values(s.contributors ?? {}).reduce((sum, c) => sum + BigInt(c.contributed), 0n);
  } catch { return 0n; }
}

let client;
async function call(name, args, tries = 4, waitMs = 10000) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await client.callTool({ name, arguments: args });
      return JSON.parse(r.content.map(c => c.text).join('\n'));
    } catch (e) { lastErr = e; if (i < tries) await sleep(waitMs); }
  }
  throw lastErr;
}
const claimDue = s => parseFloat(s.deposit) >= 0.1 && s.mine.window_open && s.claim === null;

async function connect() {
  const pw = readFileSync(PWFILE, 'utf8').trim();
  if (pw.length < 12) throw new Error('bad pool password file');
  const transport = new StdioClientTransport({
    command: 'node', args: [`${SIGNER}/bin/reset-signer.mjs`, 'mcp', '--directory', POOL_DIR],
    env: { ...process.env, RESET_SIGNER_PASSWORD: pw, RESET_SIGNER_DIRECTORY: POOL_DIR }, stderr: 'ignore',
  });
  client = new Client({ name: 'reset-pool-worker', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
}

async function maybeLock(s) {
  const total = ledgerTotalUnits();
  if (total < MIN_DEPOSIT) return null;                       // ledger not funded to the minimum
  const deposit = BigInt(Math.round(parseFloat(s.deposit) * 1e8));
  const balance = BigInt(Math.round(parseFloat(s.balance) * 1e8));
  const want = total - deposit;                               // never lock more than contributed
  const amount = want < balance ? want : balance;
  if (amount < MIN_DEPOSIT) return null;                      // lock moves must be >= min_amount
  const lr = await call('lock', { amount: formatCoin(amount) }, 3);
  await sleep(15000);
  const s2 = await call('status', {});
  const rec = { type: 'lock', amount: formatCoin(amount), outcome: lr.outcome || (lr.ok ? 'ok' : 'unknown'), verified_deposit: s2.deposit };
  log({ event: 'lock', ...rec });
  return rec;
}

async function singlePass() {
  const s = await call('status', {});
  const out = { ok: true, address: s.address, tip: s.tip, round: s.mine.round, balance: s.balance,
    deposit: s.deposit, window_open: s.mine.window_open, claim: s.claim, strikes: s.strikes,
    ledger_total: formatCoin(ledgerTotalUnits()) };
  try { out.headers = (await call('post_headers', {}, 2, 8000)).outcome || 'ok'; } catch { out.headers = 'failed'; }
  const lock = await maybeLock(await call('status', {}));
  if (lock) out.lock = lock;
  const s3 = await call('status', {});
  out.claim_due = claimDue(s3);
  log({ event: 'pass', tip: s3.tip, round: s3.mine.round, balance: s3.balance, deposit: s3.deposit });
  console.log(JSON.stringify(out));
}

async function claimOnce() {
  const s = await call('status', {});
  if (!claimDue(s)) { console.log(JSON.stringify({ ok: true, claim_due: false, note: 'window closed, already claimed, or pool deposit below 0.1' })); return; }
  const cr = await call('mine_claim', { level: 1000 }, 3);
  await sleep(15000);
  const s2 = await call('status', {});
  const outcome = cr.outcome || (cr.ok ? 'ok' : 'unknown');
  log({ event: 'claim', level: 1000, outcome, round: s.mine.round, claim_state: s2.claim });
  console.log(JSON.stringify({ ok: true, action: 'claim', level: 1000, outcome, claim_state: s2.claim, round: s.mine.round }));
}

async function loopWatch(budgetSecs) {
  const endAt = Date.now() + budgetSecs * 1000;
  let lastTip = null, iters = 0;
  while (Date.now() < endAt) {
    let s;
    try { s = await call('status', {}, 3, 8000); } catch { await sleep(20000); continue; }
    iters++;
    if (lastTip === null || s.tip !== lastTip) {
      try { await call('post_headers', {}, 2, 8000); } catch {}
    }
    lastTip = s.tip;
    try { await maybeLock(s); } catch {}
    if (claimDue(s)) {
      log({ event: 'claim_due', round: s.mine.round });
      console.log(JSON.stringify({ ok: true, claim_due: true, round: s.mine.round, iters }));
      return;
    }
    await sleep(45000);
  }
  console.log(JSON.stringify({ ok: true, loop_done: true, iters }));
}

await connect();
try {
  if (mode === '--claim') await claimOnce();
  else if (mode === '--loop') await loopWatch(loopSecs || 420);
  else await singlePass();
} finally { try { await client.close(); } catch {} }

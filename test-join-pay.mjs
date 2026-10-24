#!/usr/bin/env node
// Sandbox tests for the atomic transfer+receipt script join-pay.mjs
// (branch ai-join — forced receipt).
//
// IRON RULES — read before running:
//   - NO production wallets: the member key is a THROWAWAY keystore
//     created under /tmp by the official keystore code; the script
//     aborts unless its signer env points at that temp dir, and it
//     hashes (never reads, never unlocks) the production keystore
//     files before/after to prove they were untouched.
//   - NO gateway: every transfer here is a MOCK module or an injected
//     stub — the real executeJoinTransfer is never invoked.
//   node test-join-pay.mjs
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { init as initKeystore, unlock, wipeWallet } from '../reset/signer/lib/keystore.mjs';
import { runJoinPay, parseJoinCode } from './join-pay.mjs';
import { verifyJoinSubmission } from './lib/join.mjs';
import { fingerprint } from './lib/fpmatch.mjs';

const POOL = '4150cf82f0189371818a22d5f5b10d52aadf9108c78020cc97fc002df6eaaca6';
let n = 0; const ok = name => console.log(`  ok ${++n}. ${name}`);
const shaFile = p => existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : null;

const prodPoolKs = join(homedir(), '.reset-pool-signer', 'keystore.json');
const prodSelfKs = join(homedir(), '.reset-signer', 'keystore.json');
const prodBefore = { pool: shaFile(prodPoolKs), self: shaFile(prodSelfKs) };
assert(prodBefore.pool && prodBefore.self, 'production keystores must exist to prove them untouched');
assert(!process.env.RESET_SIGNER_DIRECTORY || !process.env.RESET_SIGNER_DIRECTORY.includes('.reset-signer'),
  'refusing to run: RESET_SIGNER_DIRECTORY points at a real signer dir');

const tmp = mkdtempSync(join(tmpdir(), 'join-pay-test-'));
const password = 'join-pay-temp-password-123';
let wallet;
try {
  const { address: member } = await initKeystore({ directory: tmp, password });
  wallet = await unlock({ directory: tmp, password });
  const planned = '5000000';
  const fp = fingerprint(member);
  const code = { pool_address: POOL, address_hex: member, planned_units: planned,
    fp_units: String(fp), exact_units: String(5000000 + fp), nonce: 'a1b2c3d4e5f60718' };
  assert.equal(parseJoinCode(code).nonce, code.nonce);
  ok(`throwaway wallet + code built (exact ${code.exact_units} units)`);

  const mockAccepted = calls => async () => {
    calls.push(1);
    return { accepted: true, outcome: 'accepted', tx: 'c'.repeat(64), nonce: 'd'.repeat(64) };
  };

  // --- 1. mock transfer accepted -> single output: transfer + verifiable receipt
  {
    const calls = [];
    const out = await runJoinPay({ code, wallet, transfer: mockAccepted(calls), confirm: true, err: () => {} });
    assert.equal(calls.length, 1);
    assert.equal(out.transfer.outcome, 'accepted');
    assert.equal(out.transfer.to, POOL);
    assert.equal(out.transfer.amount_units, code.exact_units);
    assert.equal(out.receipt.nonce, code.nonce);
    const v = verifyJoinSubmission({ poolAddress: POOL,
      code: { address: code.address_hex, exact_units: code.exact_units, nonce: code.nonce, issuedAtMs: Date.now() },
      prepared: out.receipt.prepared, signature: out.receipt.signature, nonce: out.receipt.nonce, nowMs: Date.now() });
    assert.equal(v.ok, true, JSON.stringify(v));
    ok('transfer accepted -> ONE output carrying transfer result + receipt, receipt verifies');
  }

  // --- 2. sign failure AFTER accepted transfer -> throws, transferAccepted, NO success output
  {
    const calls = [];
    let threw = null;
    try {
      await runJoinPay({ code, wallet, transfer: mockAccepted(calls), confirm: true, err: () => {},
        sign: () => { throw new Error('simulated key failure'); } });
    } catch (e) { threw = e; }
    assert(threw && threw.transferAccepted === true, 'sign failure must carry transferAccepted');
    assert.match(threw.message, /NOT re-transfer|must NOT re-transfer/);
    assert.match(threw.message, /join-sign\.mjs/);
    ok('sign failure after accepted transfer -> non-zero path, transferAccepted flag, late-receipt guidance, no success output');
  }

  // --- 3. wallet mismatch -> refused BEFORE any transfer
  {
    const tmp2 = mkdtempSync(join(tmpdir(), 'join-pay-test2-'));
    const { address: other } = await initKeystore({ directory: tmp2, password });
    const wallet2 = await unlock({ directory: tmp2, password });
    try {
      const calls = [];
      await assert.rejects(
        runJoinPay({ code, wallet: wallet2, transfer: mockAccepted(calls), confirm: true, err: () => {} }),
        /refusing to pay/);
      assert.equal(calls.length, 0);
      ok('wallet != code address -> refused before transfer (transfer never invoked)');
    } finally { wipeWallet(wallet2); rmSync(tmp2, { recursive: true, force: true }); }
    assert.notEqual(other, member);
  }

  // --- 4. tampered exact amount -> refused BEFORE any transfer
  {
    const calls = [];
    const bad = { ...code, exact_units: String(BigInt(code.exact_units) + 1n) };
    await assert.rejects(
      runJoinPay({ code: bad, wallet, transfer: mockAccepted(calls), confirm: true, err: () => {} }),
      /refusing to pay/);
    assert.equal(calls.length, 0);
    ok('tampered exact amount -> refused before transfer');
  }

  // --- 5. no owner confirmation -> refused BEFORE any transfer (read-back still printed)
  {
    const calls = []; const seen = [];
    await assert.rejects(
      runJoinPay({ code, wallet, transfer: mockAccepted(calls), confirm: false, err: m => seen.push(m) }),
      /owner confirmation required/);
    assert.equal(calls.length, 0);
    assert(seen.join('\n').includes('READ BACK') && seen.join('\n').includes(code.exact_units));
    ok('no --confirmed -> refused before transfer, read-back still printed');
  }

  // --- 6. transfer rejected -> throws, no receipt
  {
    await assert.rejects(
      runJoinPay({ code, wallet, transfer: async () => ({ accepted: false, outcome: 'rejected', error: 'insufficient' }),
        confirm: true, err: () => {} }),
      /REJECTED/);
    ok('transfer rejected -> throws, no receipt produced');
  }

  // --- 7. transfer unknown -> throws, no retry, no receipt
  {
    await assert.rejects(
      runJoinPay({ code, wallet, transfer: async () => ({ accepted: false, outcome: 'unknown', tx: 'e'.repeat(64) }),
        confirm: true, err: () => {} }),
      /UNKNOWN.*do NOT retry/);
    ok('transfer unknown -> throws with no-blind-retry guidance, no receipt produced');
  }

  // --- 8. CLI end-to-end with a mock transfer module (real script, real keystore)
  {
    const mockMod = join(tmp, 'mock-transfer.mjs');
    writeFileSync(mockMod, `export async function executeJoinTransfer() {\n  return { accepted: true, outcome: 'accepted', tx: '${'f'.repeat(64)}', nonce: '${'0'.repeat(64)}' };\n}\n`);
    const codeFile = join(tmp, 'code.json');
    writeFileSync(codeFile, JSON.stringify(code, null, 2));
    const stdout = execFileSync(process.execPath, ['join-pay.mjs', codeFile, '--confirmed', '--transfer-impl', mockMod], {
      cwd: new URL('.', import.meta.url).pathname,
      env: { ...process.env, RESET_SIGNER_DIRECTORY: tmp, RESET_SIGNER_PASSWORD: password, PATH: process.env.PATH },
      encoding: 'utf8',
    });
    const out = JSON.parse(stdout);
    assert.equal(out.transfer.outcome, 'accepted');
    assert.equal(out.receipt.nonce, code.nonce);
    const v = verifyJoinSubmission({ poolAddress: POOL,
      code: { address: code.address_hex, exact_units: code.exact_units, nonce: code.nonce, issuedAtMs: Date.now() },
      prepared: out.receipt.prepared, signature: out.receipt.signature, nonce: out.receipt.nonce, nowMs: Date.now() });
    assert.equal(v.ok, true, JSON.stringify(v));
    ok('CLI with mock transfer module -> single JSON output, receipt verifies');
  }

  // --- 9. CLI failure path: rejected transfer -> non-zero exit, EMPTY stdout
  {
    const mockMod = join(tmp, 'mock-reject.mjs');
    writeFileSync(mockMod, `export async function executeJoinTransfer() {\n  return { accepted: false, outcome: 'rejected', error: 'nope' };\n}\n`);
    const codeFile = join(tmp, 'code.json');
    writeFileSync(codeFile, JSON.stringify(code, null, 2));
    let failed = null;
    try {
      execFileSync(process.execPath, ['join-pay.mjs', codeFile, '--confirmed', '--transfer-impl', mockMod], {
        cwd: new URL('.', import.meta.url).pathname,
        env: { ...process.env, RESET_SIGNER_DIRECTORY: tmp, RESET_SIGNER_PASSWORD: password, PATH: process.env.PATH },
        encoding: 'utf8',
      });
    } catch (e) { failed = e; }
    assert(failed && failed.status !== 0, 'CLI must exit non-zero on rejected transfer');
    assert.equal((failed.stdout ?? '').trim(), '', 'no success JSON may reach stdout on failure');
    ok('CLI rejected transfer -> non-zero exit, stdout empty (no fake success)');
  }

  const prodAfter = { pool: shaFile(prodPoolKs), self: shaFile(prodSelfKs) };
  assert.equal(prodAfter.pool, prodBefore.pool);
  assert.equal(prodAfter.self, prodBefore.self);
  ok('production keystore hashes unchanged (pool + personal wallets untouched)');
} finally {
  try { wipeWallet(wallet); } catch {}
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\ntest-join-pay: all ${n} checks passed`);

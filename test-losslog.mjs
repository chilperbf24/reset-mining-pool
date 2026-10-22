#!/usr/bin/env node
// Rehearsal loss-log math checks (pure functions only).
//   node test-losslog.mjs
import assert from 'node:assert';
import { counterfactualExact, counterfactualUpperBound, allocateDiff, FULL_DEPOSIT_UNITS, REDUCED_DEPOSIT_UNITS } from './lib/losslog.mjs';

let n = 0; const ok = name => console.log(`  ok ${++n}. ${name}`);

// The contract's fair formula reproduces round 477 exactly (guideline x
// deposit / total) — the anchor fact behind the 'exact' method.
assert.equal(1856250000n * FULL_DEPOSIT_UNITS / 282205257999n, 150847n);
ok('anchor: fair formula reproduces round 477 actual exactly (150847)');

// Ratio-anchored counterfactual equals the formula counterfactual when
// the actual came from the same formula.
{
  const T = 282205257999n, G = 1856250000n;
  const actualAtReduced = G * REDUCED_DEPOSIT_UNITS / T; // what 477 would have paid at the reduced deposit
  const viaRatio = counterfactualExact({ actualUnits: actualAtReduced, claimDepositUnits: REDUCED_DEPOSIT_UNITS, networkTotalUnits: T });
  const viaFormula = G * FULL_DEPOSIT_UNITS / (T + 10000000n);
  const residue = viaRatio > viaFormula ? viaRatio - viaFormula : viaFormula - viaRatio;
  assert(residue <= 1n); // two floored divisions leave at most 1 unit of integer residue
  ok('exact: ratio-anchored counterfactual matches the formula counterfactual to within 1 unit of integer dust');
}

// Upper bound is above the exact value, and both exceed the actual.
{
  const actual = 42000n, T = 280910326422n;
  const exact = counterfactualExact({ actualUnits: actual, claimDepositUnits: REDUCED_DEPOSIT_UNITS, networkTotalUnits: T });
  const upper = counterfactualUpperBound({ actualUnits: actual, claimDepositUnits: REDUCED_DEPOSIT_UNITS });
  assert(exact > actual && upper > exact);
  assert.equal(upper, actual * FULL_DEPOSIT_UNITS / REDUCED_DEPOSIT_UNITS);
  ok('bounds: actual < exact < linear upper bound');
}

// No delta (already at full deposit) -> no shortfall.
assert.equal(counterfactualExact({ actualUnits: 999n, claimDepositUnits: FULL_DEPOSIT_UNITS, networkTotalUnits: 123n }), 999n);
assert.equal(counterfactualUpperBound({ actualUnits: 999n, claimDepositUnits: FULL_DEPOSIT_UNITS }), 999n);
ok('identity: claim at full deposit -> counterfactual == actual');

// Allocation: shares sum with dust back to the diff, pro-rata.
{
  const rows = [
    { address: 'a', deposit_units: '3000000' },
    { address: 'b', deposit_units: '4000000' },
    { address: 'c', deposit_units: '5000000' },
  ];
  const { allocation, dustUnits } = allocateDiff(1000n, rows);
  const sum = Object.values(allocation).reduce((s, v) => s + BigInt(v), 0n) + BigInt(dustUnits);
  assert.equal(sum, 1000n);
  assert.equal(allocation.a, '250'); assert.equal(allocation.b, '333'); assert.equal(allocation.c, '416');
  assert.equal(dustUnits, '1');
  const zero = allocateDiff(0n, rows);
  assert(Object.values(zero.allocation).every(v => v === '0') && zero.dustUnits === '0');
  ok('allocation: floor shares + explicit dust == diff; zero diff -> all zero');
}

console.log(`\ntest-losslog: all ${n} checks passed`);

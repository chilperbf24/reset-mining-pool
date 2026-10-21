# RESET Mining Pool — prototype

A pool so holders of **less than the 0.1 RESET minimum** can mine together:
many small contributions fund one pool address; the pool locks ≥ 0.1, claims
every round at level 1000, and splits each round's proceeds pro-rata.

**Pool address:** `4150cf82f0189371818a22d5f5b10d52aadf9108c78020cc97fc002df6eaaca6`
(dedicated wallet in `~/.reset-pool-signer/`, separate from any personal wallet)

## Why pooling works (contract facts)

- `lock` / `mine_claim` require a deposit of at least `min_amount` = 0.1 coin.
- The Mine's fair share is linear in deposit
  (`fair = guideline × deposit ÷ total claiming deposits`), so a pool earns
  exactly what its combined deposit would earn solo — pooling grants *access*,
  never extra yield. Anyone promising more is lying.
- Rounds last 6 Bitcoin blocks; claims must land in the first 3.
- Leaving is slow: `unlock` → 144-block exit wait → `withdraw`.

## What "provably" means here — and what it does not

Provable **accounting**:
- Contributions are recorded only with the on-chain transfer reference that
  funded them; every ledger event is SHA-256 hash-chained (`lib/pool.mjs`).
- Every settled round emits an audit report (`reports/`) containing the
  contributor snapshot, the claim amount, the fee, every share, and the
  integer-division dust (carried into the next round, never pocketed).
- `verify.mjs` recomputes a report from its own published inputs with
  independent code, and checks the snapshot hash, report hash, fee, every
  share, and the dust. Altering one share by 0.00001 makes it fail.
- Conservation invariant: `Σ claims = Σ pending + Σ paid + fees + carry`,
  checkable at any time via `node ledger.mjs status`.
- The claim amount in each report can be matched against the chain's own
  claim record for the pool address and round.

Not provable — **custody**: RESET has no pool/multisig primitive, so the pool
operator's key controls the funds. Transparency makes theft *detectable and
attributable*, not impossible. Join only with that understood. This is an
experiment, not an investment; no returns are promised.

## Layout

| file | role |
|---|---|
| `lib/pool.mjs` | accounting core: contributions, snapshots, pro-rata settlement, payouts, hash-chained events |
| `ledger.mjs` | operator CLI: `init / contribute / settle / payouts / status` over `state/live-ledger.json` |
| `pool-worker.mjs` | live worker for the pool wallet: status, header posting, ledger-capped lock, level-1000 claim. **No transfer/unlock/withdraw code path.** |
| `verify.mjs` | independent report verifier (no shared settlement code) |
| `simulate.mjs` | end-to-end demo driven by the real contract `minePayout` |
| `test.mjs` | unit checks: parsing, pro-rata + dust, fees, thresholds, tamper evidence |
| `state/live-ledger.json` | the live ledger (currently: no contributors, total 0) |
| `state/demo-ledger.json`, `reports/` | simulation output |

## Run the proof yourself

```sh
node test.mjs                      # unit checks
node simulate.mjs                  # 24 simulated rounds, real contract payout math
node verify.mjs reports/round-*.json   # independently verify every round report
node pool-worker.mjs               # live on-chain status of the pool address
```

Simulation scenario (openly stated, not chain data): contributors
0.03 / 0.04 / 0.05 (= 0.12 pooled), other miners' deposits 90.0, Mine stock
300.0, fee 0, payout threshold 0.01. Result: pool claim 0.03500332/round,
splits exactly 3:4:5, 1 unit of dust carried, conservation holds.

Real-world scale reference: a solo 0.1 deposit on the live network has been
earning roughly 0.001 per round — a 0.01 contributor should expect roughly a
tenth of the pool's per-round take for their share, accumulated until the
0.01 payout threshold is reached. That is the honest size of this.

## Going live (checklist, in order)

1. Contributor transfers RESET to the pool address (their own action).
2. Operator verifies the transfer on-chain, then records it:
   `node ledger.mjs contribute <addr> <amount> <tx-ref>`
3. Start the worker under supervision (`pool-worker.mjs --loop …` plus a
   cron/agent that runs `--claim` when it reports `claim_due`, as with the
   existing personal miner). Locking is capped at the ledger total.
4. After each round settles (+6 confirmations), read the claim amount from
   the chain and settle: `node ledger.mjs settle <round> <amount>` →
   publishes `reports/live-round-<n>.json`.
5. Payouts: when a contributor's pending ≥ 0.01, execute the transfer as a
   separate explicitly-approved step and record it. (Deliberately not
   automated in this prototype.)
6. Exits: a contributor's principal can leave only through
   `unlock` + the 144-block wait; plan exit batches accordingly.

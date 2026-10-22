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

## Experience shares (proposed)

Status: **proposed to the Trac-Systems team — applications are not open
yet.** Proposal: https://github.com/Trac-Systems/reset/issues/3

The team is invited to stake in this pool like any other member. The yield
from the team's stake would then be allocated to newcomers as
mining-experience shares:

1. **Apply with a GitHub account.** Claims are made from the claimant's own
   authenticated GitHub account, so identity can't be spoofed; each account
   is checked automatically for account age and real activity. One claim
   per GitHub account, ever.
2. **Register a RESET address.** The applicant registers the address the
   experience shares belong to.
3. **The yield is credited in the pool, under that address** — recorded on
   the public ledger from the first round. The allocation never leaves the
   pool's accounting; no funds pass through anyone's hands.
4. **It's the newcomer's.** Each round they earn pro-rata on top of it, and
   they can either withdraw their earnings under the pool's normal payout
   rules, or keep them in and compound their stake.

Anti-Sybil layers beyond GitHub authorization: claimants first run the
signer and post headers for a while (visible on the network); claims are
capped per period; and the full claim list is published for everyone to
audit.

Nothing is asked for the operator: the team's principal stays the team's
own share throughout — only its yield is given away, and every movement is
publicly verifiable. Pooling still grants access, not extra yield, and the
custody caveat above applies unchanged.

## Joining: self-service amount fingerprint

The gateway exposes no transfer history, so the pool cannot see *who* sent
a transfer after the fact. Regular joins therefore use an **amount
fingerprint** that each member computes locally — no registration desk, no
account, and **no GitHub** (GitHub authorization appears in this project
only in the Experience Shares proposal above):

- Pick a planned amount that is a multiple of **0.01** RESET.
- Your fingerprint is `fp = (sha256(your address)[0..4] as uint32 BE)
  mod 999999 + 1` units (1–999999). The Join section on the homepage computes your
  exact amount in your browser and files the calculation (address +
  amounts) with the pool's registry — that filing is what the matcher
  consults first when your transfer lands (see the attribution order
  below).
- **Address formats are interchangeable:** the 64-hex RESET address and the
  `trac1…` (TNK) address are the same 32-byte key in two encodings (bech32m,
  payload = the raw key). The homepage calculator, every site lookup and
  `claim-unclaimed.mjs` accept either spelling and normalize it automatically
  (`lib/fpmatch.mjs: normalizeAddress`) — pasting the trac1 form can never
  produce a wrong fingerprint.
- Transfer exactly `planned + fp` to the pool address — every digit
  matters.
- A matcher service (`fp-match.mjs`, systemd timer, every 60 seconds)
  watches the pool's balance + deposit, first deducts settled claim
  earnings (via the gateway's `last_result`, so earnings are never
  mistaken for contributions), then attributes the remaining inflow —
  **the full amount, credited in this order** (operator ruling,
  2026-10-22):
  1. **Calculation registry first.** The homepage calculator files
     every calculation (address + planned + exact amount) with the
     pool's registry (`worker/`). If a filed calculation's
     (tail, exact amount) matches the inflow exactly and names ONE
     address, the inflow is credited to that address
     (source `registry-calc`) — the network list is not consulted for
     that amount at all.
  2. **Fingerprint reverse lookup as fallback.** Only when the
     registry holds no exact record for the amount (an unregistered
     transfer, or a calculation from before the registry existed), the
     inflow's tail is reverse-looked up among all network addresses
     and credited to the unique match (source `fingerprint-auto`).
  The registry is the tie-breaker on purpose: the tail space has only
  999999 values, so fingerprint collisions across the network are
  inevitable as it grows — if a filed calculation and the fingerprint
  fallback would name different senders, the registry wins and the
  collision is written into the ledger event.
- If neither source can attribute it (no registry record, zero or
  several fingerprint hits, or a sender not yet on any network list),
  the amount is parked in `state/unclaimed.json` — never guessed.
  Parked entries are **re-checked against the registry on every
  matcher pass**, so a late filing still lands its credit; while an
  entry waits, the matcher freezes its registry evidence
  (`POST /hold`) so the registry's 30-minute TTL cannot delete it.
  Claiming manually needs only the address itself:
  `node claim-unclaimed.mjs <entry-id | amount-units> <address>`
  re-checks the tail against that address and credits it — no GitHub, no
  signature. A round amount (tail 0) can never be claimed this way.

## Layout

| file | role |
|---|---|
| `lib/pool.mjs` | accounting core: contributions, snapshots, pro-rata settlement, payouts, hash-chained events |
| `lib/fpmatch.mjs` | fingerprint math + inflow attribution + unclaimed claims (pure, unit-tested) |
| `lib/fprun.mjs` | shared matcher runner: state IO + candidate loading, used by both matcher paths |
| `ledger.mjs` | operator CLI: `init / contribute / settle / payouts / status` over `state/live-ledger.json` |
| `pool-worker.mjs` | live worker for the pool wallet: status, header posting, fingerprint pass, full-balance lock (idle balance ≥ 0.1 is locked in full in one move; each lock move is at least the 0.1 minimum), level-1000 claim, settlement recording, matcher-timer watchdog. **No transfer/unlock/withdraw code path.** |
| `fp-match.mjs` | 1-minute fingerprint matcher (systemd timer `reset-pool-fpmatch`): attributes inflows, parks the rest as unclaimed |
| `claim-unclaimed.mjs` | claim a parked amount with its address alone (fingerprint tail check) |
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

1. Contributor computes their exact fingerprint amount in the Join section
   on the homepage and transfers it to the pool address (their own action).
2. The 1-minute matcher credits it automatically under their address
   (their filed registry calculation first, fingerprint tail as
   fallback); anything unmatchable parks in `state/unclaimed.json`
   for `claim-unclaimed.mjs`. Manual fallback if ever needed:
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

# RESET Pool — Calculation Registry (Cloudflare Worker + D1)

The pool's join calculator used to compute each member's exact transfer
amount purely in the visitor's browser and keep **no record anywhere** —
when an inflow failed fingerprint matching, reconciliation meant
reverse-engineering the amount's tail by hand (it happened: tail `661039`
turned out to be the fingerprint of the *pool's own address*). This
Worker is the registry backend that ends that:

* every calculator outcome (ok / blocked-pool / invalid) is filed as a
  record: address, planned amount, fingerprint, exact amount, timestamp;
* operator imports, automatic fingerprint matches and unclaimed inflows
  live in the same table (history backfilled — see below), so one lookup
  by **tail**, **address** or **amount** shows everything known about a
  transfer, side by side.

## ⚠ Safety line

A registry record is a **clue for reconciliation and diagnosis, never a
crediting credential**. `POST /calc` authenticates nobody — anyone can
file a calculation for any address; that openness is the calculator's
whole design. Contribution attribution stays exactly as before: an
on-chain inflow's tail plus the fingerprint rules in `lib/fpmatch.mjs`
decide who is credited, and anything unmatched is parked as unclaimed.
A row in this registry must never by itself move money or ledger entries.
(IPs are stored only as sha256 hashes, for rate limiting.)

## Endpoints

| Route | Auth | Behavior |
|---|---|---|
| `POST /calc` | public | Body `{address, normalized?, planned_units, fp_units, exact_units, status}` with `status` ∈ `ok \| blocked_pool \| invalid`. The Worker re-normalizes the address (64-hex or trac1) and **recomputes the fingerprint server-side**; an `ok` report whose numbers disagree (fp mismatch, `exact ≠ planned + fp`, planned not a 0.01 multiple) is rejected `400`. Per-IP rate limit: 30/min (D1-counted). |
| `GET /lookup?tail=\|?address=\|?amount=` | header `X-Registry-Key` | All records (every kind) matching any given filter, JSON. `401` without the key. This is the operator's reconciliation view — and what `fp-match` consults before parking an inflow as unclaimed. |
| `POST /fulfill` | header `X-Registry-Key` | Body `{tail?, address?}` (at least one). Marks matching `calc` records (still inside their TTL) `status='fulfilled'` — the matcher calls this when an inflow lands and is credited, so the record survives the sweep as the "calculated → arrived" trail. Returns `{ ok, updated }`. |
| `POST /sweep` | header `X-Registry-Key` | Deletes every expired calc record (see TTL below), returns `{ ok, deleted }`. The same deletion also runs opportunistically at the top of every `POST /calc`. |
| `GET /health` | public | `{ ok: true, records: <total count> }` — count only, no detail. |

## Calc-record TTL: 30 minutes

A `kind='calc'` row is a visitor's stated **intention** to transfer, so
it expires: **30 minutes** after filing, an unfulfilled calc record is
deleted by the sweep (`POST /sweep`, called once per matcher pass, and
opportunistically on every `POST /calc`). Two exemptions:

* records the matcher marked **`fulfilled`** (via `POST /fulfill`) when
  their inflow landed — kept as the audit trail;
* the historical kinds — **`import` / `auto_match` / `unclaimed` never
  expire**: those are facts, not intentions.

Deleting a calc row loses nothing but a stale clue: contribution
attribution never reads this table (fingerprint rules alone decide), so
an inflow that arrives *after* its calc record expired is still
matched and credited exactly as before. The calculator page mirrors
the window for the visitor: a live countdown, an "expired" state at
zero, and the transfer panel hidden once the window closes.

Schema: `schema.sql` (table `records`). Seed history: `backfill.sql` /
`seed.jsonl`, generated from the live books by `gen-backfill.mjs`
(first contribution = operator import, second = fingerprint auto-match,
both unclaimed entries incl. the pool-fingerprint `661039` case).

## Deployed

Live since 2026-10-21:

- **Worker URL:** https://reset-pool-registry.tyrodcamp.workers.dev
  (calculator endpoint: `https://reset-pool-registry.tyrodcamp.workers.dev/calc`)
- **D1 database:** `reset-pool-registry` — id `e60a4aa2-28d4-4b7e-a887-b971824d35f6`
- **Records:** 4 (the historical backfill below; a smoke-test calc was
  filed, looked up and deleted again during deployment verification, so
  the registry holds exactly the 4 seed records)
- **Operator key:** held as the Worker secret `REGISTRY_KEY` and, for
  this machine's services, in `~/.reset-pool-registry.env` (mode 600,
  outside the repo). The fp-match service reads it via a systemd drop-in
  (`EnvironmentFile` pointing at that file) — never via any repo file.
- **Clients wired:** the site calculator (`generate-site.mjs`
  `REGISTRY_ENDPOINT`) and the local fp-match service both point at the
  live Worker.
- **Calc TTL live:** `/fulfill` + `/sweep` deployed 2026-10-21 (Worker
  version `6b58c3d1-d376-48e4-a547-e88dc758cc9d`) and smoke-tested
  against the live database (an artificially aged unfulfilled calc was
  swept, a fulfilled one kept, the registry restored to exactly the 4
  seed records). The matcher now fulfils calc records on every credit
  (automatic match or successful claim) and sweeps once per pass. The
  calculator shows the same 30-minute window as a countdown and hides
  its transfer panel on expiry.

## Local test (no Cloudflare account needed)

```bash
node worker/test-local.mjs   # mock-D1 harness: 32 checks, POST/lookup/backfill/rejections + fulfill/sweep TTL
node worker/gen-backfill.mjs # regenerate backfill.sql + seed.jsonl from state/*.json
```

## Deploy runbook (account ready → live, one pass)

Prereqs: a Cloudflare account, `npm i -g wrangler`, `wrangler login`.

```bash
cd worker

# 1. Create the database, then paste its id into wrangler.toml
wrangler d1 create reset-pool-registry
#    -> edit wrangler.toml: database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"

# 2. Create the table + import the historical backfill (fresh DB only)
wrangler d1 execute reset-pool-registry --remote --file=./schema.sql
wrangler d1 execute reset-pool-registry --remote --file=./backfill.sql

# 3. Operator lookup key (generate a long random value; it is a Worker
#    secret — never commit it, never put it in wrangler.toml)
wrangler secret put REGISTRY_KEY

# 4. Deploy
wrangler deploy
#    -> note the URL, e.g. https://reset-pool-registry.<you>.workers.dev

# 5. Smoke-test
curl https://reset-pool-registry.<you>.workers.dev/health
curl -H "X-Registry-Key: <key>" "https://reset-pool-registry.<you>.workers.dev/lookup?tail=661039"
#    expect: the open unclaimed record (pool-address fingerprint case)
```

### Wire the two clients to the live Worker

1. **Website calculator** — in `generate-site.mjs` (repo root), replace
   the one placeholder constant with the real endpoint and republish:
   ```js
   const REGISTRY_ENDPOINT = 'https://reset-pool-registry.<you>.workers.dev/calc';
   ```
   then `node generate-site.mjs`, commit, push (the snapshot bot also
   regenerates on its 10-minute cycle). **Copy fix in the same pass:**
   the Join step text ("computed locally in your browser … nothing is
   sent anywhere") predates this registry — update EN/ZH wording to say
   the calculation is also filed to the pool's registry for matching.
2. **Matcher** — give the fp-match service the operator endpoint + key
   via its environment (systemd unit `Environment=` or the cron/agent
   environment — **not** any file in this repo):
   ```
   REGISTRY_URL=https://reset-pool-registry.<you>.workers.dev
   REGISTRY_KEY=<the same secret>
   ```
   With these set, each new unclaimed entry's note gains a
   `registry has calc for <address> at <ts>` lead when the registry has
   one; every credit (automatic match or successful claim) marks its
   calc record `fulfilled` via `POST /fulfill`, and each pass calls
   `POST /sweep` once to clear expired intentions. Unset/unreachable
   changes nothing (silent fallback).

## Files

```
worker/
  src/index.js     the Worker (self-contained; normalize+fp mirror lib/fpmatch.mjs)
  schema.sql       D1 schema
  wrangler.toml    bindings template (D1 id placeholder, no secrets)
  gen-backfill.mjs books -> backfill.sql + seed.jsonl generator
  backfill.sql     historical seed (4 records) for `wrangler d1 execute`
  seed.jsonl       same seed, JSONL form (used by the local harness)
  test-local.mjs   mock-D1 local test suite
```

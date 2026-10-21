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
| `GET /health` | public | `{ ok: true, records: <total count> }` — count only, no detail. |

Schema: `schema.sql` (table `records`). Seed history: `backfill.sql` /
`seed.jsonl`, generated from the live books by `gen-backfill.mjs`
(first contribution = operator import, second = fingerprint auto-match,
both unclaimed entries incl. the pool-fingerprint `661039` case).

## Local test (no Cloudflare account needed)

```bash
node worker/test-local.mjs   # mock-D1 harness: 24 checks, POST/lookup/backfill/rejections
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
   one; unset/unreachable changes nothing (silent fallback).

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

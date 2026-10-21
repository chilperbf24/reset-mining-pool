-- RESET pool — calculation registry (Cloudflare D1).
-- One row per recorded fact about a calculation / contribution / inflow.
-- Amounts are integer RESET units stored as TEXT (lossless, BigInt-safe).
--
-- SAFETY LINE: a registry record is a CLUE for reconciliation and
-- diagnosis, never a crediting credential. Contribution attribution stays
-- exactly as before: an inflow's tail + the fingerprint matching rules in
-- lib/fpmatch.mjs decide who is credited. Anyone can file a calc record
-- for ANY address (that is the point of the public calculator), so a
-- record here must never by itself move money or ledger entries.
CREATE TABLE IF NOT EXISTS records (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,             -- ISO-8601 UTC, set server-side
  kind          TEXT NOT NULL,             -- calc | calc_blocked | import | auto_match | unclaimed
  address_hex   TEXT,                      -- normalized 64-hex, NULL when unknown/unparseable
  planned_units TEXT,                      -- planned amount (0.01 multiple) when known
  fp_units      TEXT,                      -- fingerprint / tail this record is indexed by
  exact_units   TEXT,                      -- planned + fp, or the observed inflow amount
  status        TEXT NOT NULL,             -- ok | blocked_pool | invalid | credited | open | claimed
  source        TEXT NOT NULL,             -- calculator | operator | matcher
  note          TEXT,
  ip_hash       TEXT                       -- sha256 hex of caller IP, hashes only, NULL for local sources
);
CREATE INDEX IF NOT EXISTS idx_records_fp    ON records (fp_units);
CREATE INDEX IF NOT EXISTS idx_records_addr  ON records (address_hex);
CREATE INDEX IF NOT EXISTS idx_records_exact ON records (exact_units);
CREATE INDEX IF NOT EXISTS idx_records_ip_ts ON records (ip_hash, ts);

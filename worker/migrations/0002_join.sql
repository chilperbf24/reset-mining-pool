-- Migration 0002: AI-signed join channel (POST /join/code, POST /join/claim).
-- Apply ONCE to the live D1 database before deploying the Worker code
-- that uses these tables:
--   wrangler d1 execute reset-pool-registry --remote --file=worker/migrations/0002_join.sql
-- Fresh installs do not need this — schema.sql carries the tables.
--
-- SAFETY LINE (same discipline as the records table): a join code is an
-- execution instruction, never an authorization — only the member's own
-- signer can move their money. A join_claim row is a credit instruction
-- to the matcher, so it is only ever written 'pending' after the Worker
-- verified the receipt's Ed25519 signature over the official agent
-- signing text under the member's key (see worker/src/index.js). Even
-- then, crediting needs the chain fact: an inflow of exactly the
-- claim's amount actually landing. A fabricated receipt can at worst
-- park a 'rejected' row.
CREATE TABLE IF NOT EXISTS join_codes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,             -- ISO-8601 UTC, set server-side
  address_hex   TEXT NOT NULL,             -- normalized 64-hex member address
  planned_units TEXT NOT NULL,             -- planned amount (0.01 multiple)
  fp_units      TEXT NOT NULL,             -- fingerprint / tail for this address
  exact_units   TEXT NOT NULL,             -- planned + fp: the exact transfer amount
  nonce         TEXT NOT NULL,             -- one-time code nonce (16 hex)
  status        TEXT NOT NULL,             -- issued | consumed
  payload       TEXT                       -- JSON {text}: the copy-paste code block
);
CREATE INDEX IF NOT EXISTS idx_join_codes_nonce ON join_codes (nonce);
CREATE INDEX IF NOT EXISTS idx_join_codes_addr  ON join_codes (address_hex);
CREATE TABLE IF NOT EXISTS join_claims (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,             -- ISO-8601 UTC, set server-side
  code_nonce    TEXT NOT NULL,             -- the join code this receipt answers
  address_hex   TEXT NOT NULL,             -- normalized 64-hex member address
  exact_units   TEXT NOT NULL,             -- amount the receipt claims arrived
  nonce         TEXT NOT NULL,             -- == code_nonce (single-use binding)
  status        TEXT NOT NULL,             -- pending | fulfilled | rejected | expired
  payload       TEXT                       -- pending: {prepared, signature, submitted_at}
                                           -- rejected: {prepared, reason}
);
CREATE INDEX IF NOT EXISTS idx_join_claims_nonce  ON join_claims (nonce);
CREATE INDEX IF NOT EXISTS idx_join_claims_addr   ON join_claims (address_hex);
CREATE INDEX IF NOT EXISTS idx_join_claims_exact  ON join_claims (exact_units);
CREATE INDEX IF NOT EXISTS idx_join_claims_status ON join_claims (status);

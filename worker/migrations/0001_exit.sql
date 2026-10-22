-- Migration 0001: exit-request support for the registry (POST /exit).
-- Apply ONCE to the live D1 database before deploying the Worker code
-- that uses the new columns:
--   wrangler d1 execute reset-pool-registry --remote --file=worker/migrations/0001_exit.sql
-- Fresh installs do not need this — schema.sql already carries the columns.
ALTER TABLE records ADD COLUMN nonce TEXT;
ALTER TABLE records ADD COLUMN payload TEXT;
CREATE INDEX IF NOT EXISTS idx_records_nonce ON records (nonce);

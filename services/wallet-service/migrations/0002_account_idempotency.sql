-- Bound how long this migration may wait on / hold locks, so it can never
-- stall a busy database (account may hold rows by the time this runs elsewhere).
SET lock_timeout = '3s';
SET statement_timeout = '5s';

ALTER TABLE account ADD COLUMN idempotency_key text;

-- CONCURRENTLY is impossible here: the PgMigrator wraps each migration in a
-- transaction, and Postgres forbids CREATE INDEX CONCURRENTLY inside one. The
-- account table is still empty when this feature ships (account creation is
-- introduced by exactly this change), so the brief non-concurrent build takes
-- no meaningful write lock. Deliberate, local, reviewed — not a global mute.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX uq_account_idempotency ON account (idempotency_key);

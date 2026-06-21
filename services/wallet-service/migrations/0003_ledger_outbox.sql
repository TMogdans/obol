-- Bound how long this migration may wait on / hold locks so it can never stall
-- a busy database (the wallet schema may hold rows by the time this runs).
SET lock_timeout = '3s';
SET statement_timeout = '5s';

-- The transactional Outbox for ledger events (ledger-event-publish, REQ-EVT-03).
-- A SEPARATE table — `ledger_entry` is left untouched, so its append-only engine
-- rules (ledger_no_update / ledger_no_delete, migration 0001) stay in force
-- (REQ-EVT-06). One row is written in the SAME transaction as its ledger_entry
-- (REQ-EVT-04): entry_id is the PK and a FK onto ledger_entry(id), so a committed
-- entry ALWAYS has its outbox row and a failed outbox insert rolls the entry back.
-- `amount` mirrors the stored, signed ledger amount; `payload` is the wire-shaped
-- LedgerEntryRecorded event (the four spec-fixed fields) the drain publishes;
-- `sent` is the drain-and-mark state flag (flipped true only AFTER a successful
-- publish — its UPDATE is a state field of the outbox, NOT of the ledger).
CREATE TABLE ledger_outbox (
  entry_id   text PRIMARY KEY REFERENCES ledger_entry(id),
  account_id text NOT NULL,
  amount     bigint NOT NULL,
  subject    text NOT NULL,
  payload    jsonb NOT NULL,
  sent       boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Pending-drain index (REQ-EVT-09): the drain reads only UNSENT rows, so a
-- partial index on the pending condition keeps that access path off a full
-- sequential scan of the whole outbox history.
--
-- CONCURRENTLY is impossible here: the PgMigrator wraps each migration in a
-- transaction, and Postgres forbids CREATE INDEX CONCURRENTLY inside one. The
-- ledger_outbox table is created empty by this very migration, so the
-- non-concurrent build takes no meaningful write lock. Deliberate, local,
-- reviewed — not a global mute.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX idx_ledger_outbox_pending ON ledger_outbox (sent) WHERE sent = false;

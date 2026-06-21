-- squawk-ignore-file require-timeout-settings
-- Bootstrap migration for the statement projection: creates the persistent
-- statement view on an empty database. lock_timeout / statement_timeout guard
-- against a slow statement holding locks on a LIVE, populated table; here there
-- is no data and no concurrent traffic, so they are inapplicable. This
-- exemption is scoped to THIS file on purpose.
--
-- REQ-STMT-05: the statement view and the "seen" set live in ONE persistent
-- table. `entry_id` is the PRIMARY KEY, so it is at once the statement line's
-- identity AND the idempotency/dedup anchor (REQ-STMT-02): a second INSERT of
-- the same entry_id violates the PK, which the projection turns into a no-op via
-- `ON CONFLICT (entry_id) DO NOTHING`. The dedup is DB-enforced and survives a
-- process restart — no in-memory "seen" set.

CREATE TABLE statement_line (
  entry_id     text PRIMARY KEY,
  account_id   text NOT NULL,
  amount       bigint NOT NULL,
  occurred_at  timestamptz NOT NULL
);

-- REQ-STMT-09: the per-account read path is index-backed over
-- (account_id, occurred_at DESC) so `GET /accounts/{id}/statement` (which reads
-- a single account's lines newest-first) does not sequentially scan the whole
-- statement table of all accounts.
CREATE INDEX idx_statement_account_occurred
  ON statement_line (account_id, occurred_at DESC);

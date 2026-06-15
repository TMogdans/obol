CREATE TABLE account (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL,
  currency    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entry (
  id              text PRIMARY KEY,
  account_id      text NOT NULL REFERENCES account(id),
  amount          bigint NOT NULL,
  type            text NOT NULL CHECK (type IN ('topup','spend','adjustment')),
  idempotency_key text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ledger_idempotency UNIQUE (idempotency_key)
);

CREATE INDEX idx_ledger_account ON ledger_entry(account_id);

-- append-only erzwingen: UPDATE/DELETE auf Engine-Ebene verbieten
CREATE RULE ledger_no_update AS ON UPDATE TO ledger_entry DO INSTEAD NOTHING;
CREATE RULE ledger_no_delete AS ON DELETE TO ledger_entry DO INSTEAD NOTHING;

ALTER TABLE account ADD COLUMN idempotency_key text;

CREATE UNIQUE INDEX uq_account_idempotency ON account (idempotency_key);

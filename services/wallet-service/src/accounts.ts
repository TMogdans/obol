import { randomUUID } from "node:crypto";
import { SqlClient } from "@effect/sql/SqlClient";
import type { SqlError } from "@effect/sql/SqlError";
import { Effect } from "effect";

/**
 * Shape of an `account` row as read back from the pg driver. `created_at` is a
 * `timestamptz`; we read it via `::text` so it crosses the boundary as a plain
 * ISO string and never depends on driver-specific Date coercion.
 */
interface AccountRow {
  readonly id: string;
  readonly owner_id: string;
  readonly currency: string;
  readonly created_at: string;
}

/** The account as the API speaks it (camelCase), mapped from a snake_case row. */
interface Account {
  readonly id: string;
  readonly ownerId: string;
  readonly currency: string;
  readonly createdAt: string;
}

/** Result of {@link AccountRepo.open}: the account plus whether it was new. */
interface OpenResult {
  readonly account: Account;
  readonly created: boolean;
}

const toAccount = (row: AccountRow): Account => ({
  id: row.id,
  ownerId: row.owner_id,
  currency: row.currency,
  createdAt: row.created_at,
});

/**
 * DB-backed repository for account creation.
 *
 * `open` is idempotent on `idempotency_key`: it attempts an INSERT with a
 * server-generated id and `ON CONFLICT (idempotency_key) DO NOTHING`. If a row
 * was returned the account is new (`created: true`, → 201); if the conflict
 * suppressed the insert, the pre-existing account carrying that key is read back
 * and returned unchanged (`created: false`, → 200). This is the same
 * idempotency shape the ledger uses, so `currency` is fixed to "EUR" here (an
 * accepted legacy column, not part of the request surface).
 *
 * The unique index `uq_account_idempotency` (migration 0002) is what makes the
 * conflict — and therefore the idempotency — real at the database level rather
 * than a best-effort application check.
 *
 * Requires a `SqlClient` in context (provided by `DbLive`); failures surface as
 * `SqlError`.
 */
export class AccountRepo extends Effect.Service<AccountRepo>()("AccountRepo", {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient;

    const findById = (
      id: string,
    ): Effect.Effect<Account | undefined, SqlError> =>
      sql<AccountRow>`
        SELECT id, owner_id, currency, created_at::text AS created_at
        FROM account
        WHERE id = ${id}
      `.pipe(Effect.map((rows) => (rows[0] ? toAccount(rows[0]) : undefined)));

    const open = (
      ownerId: string,
      idempotencyKey: string,
    ): Effect.Effect<OpenResult, SqlError> =>
      Effect.gen(function* () {
        const id = yield* Effect.sync(() => `acc_${randomUUID()}`);

        const inserted = yield* sql<AccountRow>`
          INSERT INTO account (id, owner_id, currency, idempotency_key)
          VALUES (${id}, ${ownerId}, 'EUR', ${idempotencyKey})
          ON CONFLICT (idempotency_key) DO NOTHING
          RETURNING id, owner_id, currency, created_at::text AS created_at
        `;
        const fresh = inserted[0];
        if (fresh !== undefined) {
          return { account: toAccount(fresh), created: true };
        }

        // The insert was suppressed by the unique constraint: an account with
        // this idempotency_key already exists. Read it back and replay it.
        const existing = yield* sql<AccountRow>`
          SELECT id, owner_id, currency, created_at::text AS created_at
          FROM account
          WHERE idempotency_key = ${idempotencyKey}
        `;
        // Unreachable: a conflict guarantees the row exists. Treat the
        // impossible as a defect rather than inventing a result.
        const prior = existing[0];
        if (prior === undefined) {
          return yield* Effect.dieMessage("idempotency conflict without a row");
        }
        return { account: toAccount(prior), created: false };
      });

    return { open, findById } as const;
  }),
}) {}

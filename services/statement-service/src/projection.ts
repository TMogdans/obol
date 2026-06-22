import { SqlClient } from "@effect/sql/SqlClient";
import type { SqlError } from "@effect/sql/SqlError";
import { Effect } from "effect";

/**
 * A statement line as stored / returned: the four `LedgerEntryRecorded` event
 * fields verbatim (REQ-STMT-01). `amount` is the SIGNED minor-unit value
 * exactly as the producer delivered it (positive topup, negative spend — never
 * reinterpreted), `occurredAt` the ISO-8601 string.
 */
export interface StatementLine {
  readonly entryId: string;
  readonly accountId: string;
  readonly amount: number;
  readonly occurredAt: string;
}

/** The raw shape the pg driver surfaces for a stored row. */
interface StatementRow {
  readonly entry_id: string;
  readonly account_id: string;
  // bigint comes back as a string from node-postgres; occurred_at as a text
  // timestamptz so it can be normalised to a stable ISO-8601 string.
  readonly amount: string;
  readonly occurred_at: string;
}

const toLine = (row: StatementRow): StatementLine => ({
  entryId: row.entry_id,
  accountId: row.account_id,
  amount: Number(row.amount),
  // Normalise the stored timestamptz back to the exact ISO-8601 string form the
  // event carried (e.g. "2026-06-21T12:00:00.000Z"), so a round-trip through the
  // DB is byte-for-byte identical to the input (REQ-STMT-01/-03).
  occurredAt: new Date(row.occurred_at).toISOString(),
});

/**
 * DB-backed repository over the `statement_line` table (REQ-STMT-05).
 *
 * `append` performs exactly ONE idempotent `INSERT ... ON CONFLICT (entry_id)
 * DO NOTHING`: a first-seen `entryId` appends exactly one row (REQ-STMT-01); a
 * redelivered/duplicate `entryId` is a PK no-op — no second row, no mutation of
 * the existing row, no additional durable write (REQ-STMT-02/-09). The dedup is
 * enforced by the DB primary key and survives a restart, never by an in-memory
 * set.
 *
 * `statementFor` returns ONLY the given account's lines (REQ-STMT-03), newest
 * first by `occurred_at` with a deterministic `entry_id` ASC tie-break so the
 * answer is reproducible. An account with no consumed events yields an empty
 * array — never an error (REQ-STMT-04). The read is index-backed over
 * `(account_id, occurred_at DESC)` (REQ-STMT-09).
 *
 * Requires a `SqlClient` (its `.Default` layer is built over `DbLive` in the
 * composition root / over the test's `SqlLive`).
 */
export class StatementRepo extends Effect.Service<StatementRepo>()(
  "StatementRepo",
  {
    effect: Effect.gen(function* () {
      const sql = yield* SqlClient;

      const append = (line: StatementLine): Effect.Effect<void, SqlError> =>
        sql`
          INSERT INTO statement_line (entry_id, account_id, amount, occurred_at)
          VALUES (
            ${line.entryId},
            ${line.accountId},
            ${line.amount},
            ${line.occurredAt}
          )
          ON CONFLICT (entry_id) DO NOTHING
        `.pipe(Effect.asVoid);

      const statementFor = (
        accountId: string,
      ): Effect.Effect<ReadonlyArray<StatementLine>, SqlError> =>
        sql<StatementRow>`
          SELECT entry_id, account_id, amount::text AS amount,
                 occurred_at::text AS occurred_at
          FROM statement_line
          WHERE account_id = ${accountId}
          ORDER BY occurred_at DESC, entry_id ASC
        `.pipe(Effect.map((rows) => rows.map(toLine)));

      return { append, statementFor } as const;
    }),
  },
) {}

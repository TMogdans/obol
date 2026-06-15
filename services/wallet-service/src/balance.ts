import { SqlClient } from "@effect/sql/SqlClient";
import type { SqlError } from "@effect/sql/SqlError";
import { Effect } from "effect";

/**
 * A single ledger amount, the only field balance projection cares about.
 *
 * `amount` is a JS `number`. See the bigint boundary note on {@link BalanceRepo}:
 * the database column is `bigint`, but the projection deliberately works on
 * `number` because minor-unit credit amounts in this reference repo comfortably
 * fit inside `Number.MAX_SAFE_INTEGER`. The string→number coercion happens once,
 * at the SQL read boundary in the repo, so this pure function never sees a
 * bigint or a string.
 */
export interface BalanceEntry {
  readonly amount: number;
}

/**
 * Pure balance projection: fold a list of ledger amounts into a single balance.
 *
 * Deliberately total and side-effect-free — an empty ledger projects to `0`,
 * and signed amounts (negative `spend`, positive `topup`) simply sum. This is
 * the heart of the credit ledger and is tested in isolation, no database
 * required.
 */
export const projectBalance = (entries: ReadonlyArray<BalanceEntry>): number =>
  entries.reduce((sum, entry) => sum + entry.amount, 0);

/**
 * Shape of a `ledger_entry.amount` row as it comes back from the pg driver.
 *
 * The column is `bigint`, and `@effect/sql-pg` (via the `pg` driver) surfaces
 * `bigint` columns as JavaScript **strings** to avoid lossy `number` conversion
 * for values beyond the safe-integer range. We therefore read it as `string`
 * and coerce explicitly — never relying on an implicit/`any` conversion.
 */
interface AmountRow {
  readonly amount: string;
}

/**
 * Coerce a single pg `bigint`-as-string into the `number` the pure projection
 * consumes. This is the one place the bigint→number boundary is crossed.
 *
 * `Number(...)` on a well-formed integer string is exact within the safe-integer
 * range, which is the documented invariant for this reference repo.
 */
const toBalanceEntry = (row: AmountRow): BalanceEntry => ({
  amount: Number(row.amount),
});

/**
 * DB-backed repository for balance computation.
 *
 * `entriesFor` reads the raw amounts for an account from the append-only
 * `ledger_entry` table; `balanceFor` composes that read with {@link projectBalance}
 * to return the account's current balance. An account with no entries naturally
 * projects to `0`.
 *
 * `accountExists` answers the orthogonal question "is there an `account` row
 * with this id?" via a cheap `SELECT 1`. This is what lets a caller (e.g. the
 * HTTP handler) distinguish an existing account whose balance is `0` from an
 * account that does not exist at all — `balanceFor` returns `0` for both, so
 * the existence check is the only thing that separates a `200`-with-`0` from a
 * `404`.
 *
 * Requires a `SqlClient` in context (provided by `DbLive`). Failures surface as
 * `SqlError`.
 */
export class BalanceRepo extends Effect.Service<BalanceRepo>()("BalanceRepo", {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient;

    const entriesFor = (
      accountId: string,
    ): Effect.Effect<ReadonlyArray<BalanceEntry>, SqlError> =>
      sql<AmountRow>`
        SELECT amount::text AS amount
        FROM ledger_entry
        WHERE account_id = ${accountId}
      `.pipe(Effect.map((rows) => rows.map(toBalanceEntry)));

    const balanceFor = (accountId: string): Effect.Effect<number, SqlError> =>
      entriesFor(accountId).pipe(Effect.map(projectBalance));

    const accountExists = (
      accountId: string,
    ): Effect.Effect<boolean, SqlError> =>
      sql<{ readonly one: number }>`
        SELECT 1 AS one FROM account WHERE id = ${accountId} LIMIT 1
      `.pipe(Effect.map((rows) => rows.length > 0));

    return { entriesFor, balanceFor, accountExists } as const;
  }),
}) {}

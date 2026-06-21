import { randomUUID } from "node:crypto";
import { SqlClient } from "@effect/sql/SqlClient";
import type { SqlError } from "@effect/sql/SqlError";
import { Effect } from "effect";

/**
 * DB-backed repository for appending to the append-only `ledger_entry` table.
 *
 * `appendTopup` performs exactly ONE `INSERT` of a single positive entry with
 * a server-generated `id`, the given `account_id`/`amount`, `type` server-set
 * to `'topup'` (the client never supplies the type — REQ-TOP-06), and a unique
 * `idempotency_key`. There is no `UPDATE`/`DELETE`: the domain stays append-only
 * (REQ-TOP-05), which the engine additionally enforces via
 * `ledger_no_update`/`ledger_no_delete` (migration 0001).
 *
 * The `idempotency_key` column is `NOT NULL UNIQUE` (`uq_ledger_idempotency`,
 * migration 0001). A *top-up idempotency contract* (replaying an
 * `Idempotency-Key` header) is explicitly OUT OF SCOPE for this spec, so each
 * successful credit gets its own server-generated key — one entry per
 * successful request — which satisfies the NOT NULL/UNIQUE constraint without
 * inventing a replay semantics that is not yet specified.
 *
 * The amount is bound as a JS `number`: positive minor-unit credit amounts in
 * this reference repo fit inside `Number.MAX_SAFE_INTEGER` (the documented
 * boundary, see {@link BalanceRepo}); the value reaches here already validated
 * as a positive integer by the `CreditPayload` decode rim.
 *
 * Requires a `SqlClient` in context (provided by `DbLive`); failures surface as
 * `SqlError` (treated by the handler as a 500 defect, never a typed client
 * error — REQ-TOP-07).
 */
export class LedgerRepo extends Effect.Service<LedgerRepo>()("LedgerRepo", {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient;

    const appendTopup = (
      accountId: string,
      amount: number,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const id = yield* Effect.sync(() => `led_${randomUUID()}`);
        const idempotencyKey = yield* Effect.sync(
          () => `topup_${randomUUID()}`,
        );

        // Exactly one INSERT; `type` is server-set to 'topup' here, never taken
        // from the request surface.
        yield* sql`
          INSERT INTO ledger_entry (id, account_id, amount, type, idempotency_key)
          VALUES (${id}, ${accountId}, ${amount}, 'topup', ${idempotencyKey})
        `;
      });

    return { appendTopup } as const;
  }),
}) {}

import { NodeContext } from "@effect/platform-node";
import { SqlClient } from "@effect/sql/SqlClient";
import { it } from "@effect/vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Effect, Layer, type Scope } from "effect";
import { expect } from "vitest";
import { DbLive, MigratorLive } from "../src/db.js";

/**
 * Integration test for the wallet-service migration gate.
 *
 * This proves three things against a REAL Postgres (via Testcontainers):
 *  1. The custom raw-`.sql` migrator loader from Task 3 actually finds and
 *     applies `0001_init.sql` at runtime (the built-in loader only reads
 *     `.js`/`.ts` modules, so this is the real proof the custom loader works).
 *  2. The `uq_ledger_idempotency` UNIQUE constraint rejects a duplicate
 *     idempotency_key.
 *  3. The append-only RULES (`ledger_no_update` / `ledger_no_delete`) turn
 *     UPDATE and DELETE on `ledger_entry` into no-ops.
 *
 * The container is modelled as a scoped resource via `Effect.acquireRelease`
 * so it is always stopped, even if an assertion fails mid-test.
 */

/**
 * Acquire a running Postgres container and publish its connection details into
 * `process.env`, so the env-driven `DbLive` layer (PGHOST/PGPORT/...) connects
 * to it. The container is released (stopped) when the surrounding scope closes.
 */
const acquireContainer: Effect.Effect<
  StartedPostgreSqlContainer,
  Error,
  Scope.Scope
> = Effect.acquireRelease(
  Effect.tryPromise({
    try: () => new PostgreSqlContainer("postgres:16-alpine").start(),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
  }).pipe(
    Effect.tap((container) =>
      Effect.sync(() => {
        process.env.PGHOST = container.getHost();
        process.env.PGPORT = String(container.getPort());
        process.env.PGDATABASE = container.getDatabase();
        process.env.PGUSER = container.getUsername();
        process.env.PGPASSWORD = container.getPassword();
      }),
    ),
  ),
  (container) =>
    Effect.promise(() => container.stop()).pipe(
      Effect.orElse(() => Effect.void),
    ),
);

/** A single ledger row read back from the database. */
interface LedgerRow {
  readonly id: string;
  readonly amount: string;
}

it.effect(
  "applies the raw-SQL migration and enforces unique + append-only invariants",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        // 1. Start the container and point DbLive at it.
        yield* acquireContainer;

        // Layer wiring: MigratorLive runs the migration on build (it carries
        // its own DbLive internally) and needs FileSystem | Path |
        // CommandExecutor from NodeContext. DbLive is merged on top so the test
        // body can resolve the SqlClient service for assertions.
        const layer = Layer.mergeAll(
          MigratorLive.pipe(Layer.provide(NodeContext.layer)),
          DbLive,
        );

        const program = Effect.gen(function* () {
          const sql = yield* SqlClient;

          // --- Invariant (a): migration applied, tables + columns exist. ---
          const tables = yield* sql<{ table_name: string }>`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN ('account', 'ledger_entry')
            ORDER BY table_name
          `;
          expect(tables.map((row) => row.table_name)).toEqual([
            "account",
            "ledger_entry",
          ]);

          const ledgerColumns = yield* sql<{ column_name: string }>`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'ledger_entry'
            ORDER BY column_name
          `;
          expect(ledgerColumns.map((row) => row.column_name)).toEqual([
            "account_id",
            "amount",
            "created_at",
            "id",
            "idempotency_key",
            "type",
          ]);

          // The migrator tracks applied migrations in its own table; confirm
          // 0001_init is recorded there as the runtime proof of the loader.
          const applied = yield* sql<{ name: string }>`
            SELECT name FROM effect_sql_migrations ORDER BY migration_id
          `;
          expect(applied.map((row) => row.name)).toContain("init");

          // Seed an account + one ledger entry.
          yield* sql`
            INSERT INTO account (id, owner_id, currency)
            VALUES ('acc-1', 'owner-1', 'EUR')
          `;
          yield* sql`
            INSERT INTO ledger_entry (id, account_id, amount, type, idempotency_key)
            VALUES ('led-1', 'acc-1', 100, 'topup', 'idem-1')
          `;

          // --- Invariant (b): duplicate idempotency_key is rejected. ---
          const duplicate = yield* sql`
            INSERT INTO ledger_entry (id, account_id, amount, type, idempotency_key)
            VALUES ('led-2', 'acc-1', 200, 'topup', 'idem-1')
          `.pipe(Effect.either);
          expect(duplicate._tag).toBe("Left");
          if (duplicate._tag === "Left") {
            // The failure must reference the unique constraint, proving it is
            // the idempotency guard and not some unrelated error.
            expect(JSON.stringify(duplicate.left)).toContain(
              "uq_ledger_idempotency",
            );
          }

          // --- Invariant (c): append-only — UPDATE is a no-op. ---
          yield* sql`UPDATE ledger_entry SET amount = 999 WHERE id = 'led-1'`;
          const afterUpdate = yield* sql<LedgerRow>`
            SELECT id, amount::text AS amount FROM ledger_entry WHERE id = 'led-1'
          `;
          expect(afterUpdate).toHaveLength(1);
          expect(afterUpdate[0]?.amount).toBe("100");

          // --- Invariant (c): append-only — DELETE is a no-op. ---
          yield* sql`DELETE FROM ledger_entry WHERE id = 'led-1'`;
          const afterDelete = yield* sql<LedgerRow>`
            SELECT id, amount::text AS amount FROM ledger_entry WHERE id = 'led-1'
          `;
          expect(afterDelete).toHaveLength(1);
          expect(afterDelete[0]?.id).toBe("led-1");
        });

        yield* Effect.provide(program, layer);
      }),
    ),
  { timeout: 120000 },
);

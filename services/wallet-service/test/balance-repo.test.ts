import { NodeContext } from "@effect/platform-node";
import { SqlClient } from "@effect/sql/SqlClient";
import { it } from "@effect/vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Effect, Layer, type Scope } from "effect";
import { expect } from "vitest";
import { BalanceRepo } from "../src/balance.js";
import { DbLive, MigratorLive } from "../src/db.js";

/**
 * Integration test for the DB-backed `BalanceRepo` against a REAL Postgres
 * (via Testcontainers).
 *
 * This proves the full SQL→projection path end-to-end:
 *  1. `balanceFor` reads an account's real ledger rows and folds the signed
 *     `bigint` amounts (top-ups and a spend) into the correct balance.
 *  2. The bigint→number boundary is exercised against the actual pg driver,
 *     not a mock — if the string coercion or the projection were wrong, the
 *     adversarial expected value (a non-trivial sum with a negative term)
 *     would not match.
 *  3. An account with no entries projects to `0`.
 *
 * The container is a scoped resource via `Effect.acquireRelease`, so it is
 * always stopped even if an assertion fails mid-test.
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

it.effect(
  "balanceFor folds real ledger entries into the correct balance",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* acquireContainer;

        // BalanceRepo.Default needs a SqlClient, so DbLive is provided to it.
        // DbLive is also merged at the top level so the test body can resolve
        // SqlClient directly for seeding. MigratorLive runs the migration on
        // build and carries its own DbLive internally.
        const layer = Layer.mergeAll(
          MigratorLive.pipe(Layer.provide(NodeContext.layer)),
          DbLive,
          BalanceRepo.Default.pipe(Layer.provide(DbLive)),
        );

        const program = Effect.gen(function* () {
          const sql = yield* SqlClient;
          const repo = yield* BalanceRepo;

          // Seed two accounts.
          yield* sql`
            INSERT INTO account (id, owner_id, currency)
            VALUES ('acc-1', 'owner-1', 'EUR'), ('acc-2', 'owner-2', 'EUR')
          `;

          // acc-1: 500 (topup) + 50 (topup) - 200 (spend) = 350.
          // The mix of signs and multiple rows makes the assertion adversarial:
          // a projection that ignored sign, dropped rows, or mishandled the
          // bigint→string coercion would not land on exactly 350.
          yield* sql`
            INSERT INTO ledger_entry (id, account_id, amount, type, idempotency_key)
            VALUES
              ('led-1', 'acc-1', 500, 'topup', 'idem-1'),
              ('led-2', 'acc-1', -200, 'spend', 'idem-2'),
              ('led-3', 'acc-1', 50, 'topup', 'idem-3')
          `;

          const balance = yield* repo.balanceFor("acc-1");
          expect(balance).toBe(350);

          // acc-2 has no entries → balance is exactly 0 (not null/NaN).
          const empty = yield* repo.balanceFor("acc-2");
          expect(empty).toBe(0);

          // An unknown account also projects to 0.
          const unknown = yield* repo.balanceFor("does-not-exist");
          expect(unknown).toBe(0);
        });

        yield* Effect.provide(program, layer);
      }),
    ),
  { timeout: 120000 },
);

import { HttpClient } from "@effect/platform";
import { NodeContext, NodeHttpServer } from "@effect/platform-node";
import { SqlClient } from "@effect/sql/SqlClient";
import { it } from "@effect/vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Effect, Layer, type Scope } from "effect";
import { expect } from "vitest";
import { DbLive, MigratorLive } from "../src/db.js";
import { WalletApiLive } from "../src/main.js";

/**
 * Integration test for the HTTP balance/health endpoints against a REAL
 * Postgres (Testcontainers) and a REAL HTTP server (NodeHttpServer.layerTest,
 * which binds an ephemeral port and exposes an HttpClient pointed at it).
 *
 * Proves the three EARS criteria from balance-query/spec.md:
 *  - existing account with entries  → 200 + summed balance
 *  - existing account, no entries   → 200 + balance 0
 *  - non-existent account           → 404 + structured AccountNotFound body
 * plus a /health liveness check → 200.
 *
 * Requests are issued with the raw HttpClient (not the typed HttpApiClient) so
 * that the 404 assertion is adversarial: we assert the actual HTTP status code
 * AND the structured error body, not merely "the typed client failed".
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

interface BalanceBody {
  readonly accountId: string;
  readonly balance: number;
}

it.effect(
  "serves balance (200/0/404) and health over HTTP",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* acquireContainer;

        // Seeding layer wiring: run the migration, then expose a SqlClient so
        // the test body can seed accounts/entries directly.
        const seedLayer = Layer.mergeAll(
          MigratorLive.pipe(Layer.provide(NodeContext.layer)),
          DbLive,
        );

        yield* Effect.provide(
          Effect.gen(function* () {
            const sql = yield* SqlClient;

            // acc-1 has entries summing to 500 - 200 + 50 = 350.
            // acc-empty exists but has zero entries → balance 0.
            yield* sql`
              INSERT INTO account (id, owner_id, currency)
              VALUES ('acc-1', 'owner-1', 'EUR'), ('acc-empty', 'owner-2', 'EUR')
            `;
            yield* sql`
              INSERT INTO ledger_entry (id, account_id, amount, type, idempotency_key)
              VALUES
                ('led-1', 'acc-1', 500, 'topup', 'idem-1'),
                ('led-2', 'acc-1', -200, 'spend', 'idem-2'),
                ('led-3', 'acc-1', 50, 'topup', 'idem-3')
            `;
          }),
          seedLayer,
        );

        // Server + client wiring. layerTest binds an ephemeral port and hands
        // back an HttpClient already pointed at it; WalletApiLive provides the
        // served api + handlers (which depend on BalanceRepo → DbLive).
        const program = Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;

          // --- Existing account with entries → 200 + balance 350 ---
          const res1 = yield* client.get("/accounts/acc-1/balance");
          expect(res1.status).toBe(200);
          const body1 = (yield* res1.json) as BalanceBody;
          expect(body1.accountId).toBe("acc-1");
          expect(body1.balance).toBe(350);

          // --- Existing account, no entries → 200 + balance 0 ---
          const res2 = yield* client.get("/accounts/acc-empty/balance");
          expect(res2.status).toBe(200);
          const body2 = (yield* res2.json) as BalanceBody;
          expect(body2.balance).toBe(0);

          // --- Non-existent account → 404 + structured AccountNotFound body ---
          const res3 = yield* client.get("/accounts/nope/balance");
          expect(res3.status).toBe(404);
          const body3 = (yield* res3.json) as {
            readonly _tag?: string;
            readonly accountId?: string;
          };
          expect(body3._tag).toBe("AccountNotFound");
          expect(body3.accountId).toBe("nope");

          // --- Health → 200 ---
          const res4 = yield* client.get("/health");
          expect(res4.status).toBe(200);
        });

        const layer = WalletApiLive.pipe(
          Layer.provideMerge(NodeHttpServer.layerTest),
        );

        yield* Effect.provide(program, layer);
      }),
    ),
  { timeout: 120000 },
);

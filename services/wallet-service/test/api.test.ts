import { HttpClient } from "@effect/platform";
import { NodeContext, NodeHttpServer } from "@effect/platform-node";
import { SqlClient } from "@effect/sql/SqlClient";
import { it } from "@effect/vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, expect } from "vitest";
import { DbLive, MigratorLive } from "../src/db.js";
import { WalletApiLive } from "../src/main.js";

/**
 * Integration test for the HTTP balance/health endpoints against a REAL
 * Postgres (Testcontainers) and a REAL HTTP server (NodeHttpServer.layerTest,
 * which binds an ephemeral port and exposes an HttpClient pointed at it).
 *
 * One container is started + migrated + seeded ONCE (beforeAll) and shared by
 * all cases — the expensive part happens once, the per-case HTTP server is
 * cheap to rebuild. Each EARS criterion from balance-query/spec.md gets its OWN
 * test, tagged with its REQ id, so the spec↔test traceability gate maps
 * one-to-one: delete a case and its criterion goes untested (gate turns red),
 * instead of a single bundled test silently dropping an assertion.
 *
 * Requests use the raw HttpClient (not the typed HttpApiClient) so the 404
 * assertion is adversarial: we assert the actual status code AND the structured
 * error body, not merely "the typed client failed".
 */

interface BalanceBody {
  readonly accountId: string;
  readonly balance: number;
}

let container: StartedPostgreSqlContainer | undefined;

// Shared HTTP server layer: the served wallet api (handlers → BalanceRepo →
// DbLive) bound to an ephemeral test port, with an HttpClient pointed at it.
const ServerLive = WalletApiLive.pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
);

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  process.env.PGHOST = container.getHost();
  process.env.PGPORT = String(container.getPort());
  process.env.PGDATABASE = container.getDatabase();
  process.env.PGUSER = container.getUsername();
  process.env.PGPASSWORD = container.getPassword();

  // Run the migration (MigratorLive) then seed shared fixtures:
  //   acc-1     → entries 500 - 200 + 50 = 350
  //   acc-empty → exists, zero entries → balance 0
  // All cases below are read-only GETs, so one seed serves them all.
  const seedLayer = Layer.mergeAll(
    MigratorLive.pipe(Layer.provide(NodeContext.layer)),
    DbLive,
  );
  const seed = Effect.gen(function* () {
    const sql = yield* SqlClient;
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
  });
  await Effect.runPromise(Effect.scoped(Effect.provide(seed, seedLayer)));
}, 120000);

afterAll(async () => {
  if (container) {
    await container.stop();
  }
});

it.effect(
  "[REQ-BAL-01] returns the balance as the sum of the account's entries",
  () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const res = yield* client.get("/accounts/acc-1/balance");
      expect(res.status).toBe(200);
      const body = (yield* res.json) as BalanceBody;
      expect(body.accountId).toBe("acc-1");
      expect(body.balance).toBe(350);
    }).pipe(Effect.provide(ServerLive)),
);

it.effect(
  "[REQ-BAL-02] returns 404 with a structured error for a missing account",
  () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const res = yield* client.get("/accounts/nope/balance");
      expect(res.status).toBe(404);
      const body = (yield* res.json) as {
        readonly _tag?: string;
        readonly accountId?: string;
      };
      expect(body._tag).toBe("AccountNotFound");
      expect(body.accountId).toBe("nope");
    }).pipe(Effect.provide(ServerLive)),
);

it.effect(
  "[REQ-BAL-03] returns balance 0 for an existing account with no entries",
  () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const res = yield* client.get("/accounts/acc-empty/balance");
      expect(res.status).toBe(200);
      const body = (yield* res.json) as BalanceBody;
      expect(body.balance).toBe(0);
    }).pipe(Effect.provide(ServerLive)),
);

it.effect("serves a /health liveness check", () =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get("/health");
    expect(res.status).toBe(200);
  }).pipe(Effect.provide(ServerLive)),
);

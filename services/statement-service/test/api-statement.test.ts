import { HttpClient } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import type { SqlClient } from "@effect/sql/SqlClient";
import { it } from "@effect/vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect } from "vitest";

/**
 * HTTP integration tests for `GET /accounts/{id}/statement` against a REAL
 * Postgres (Testcontainers) AND a REAL HTTP server (NodeHttpServer.layerTest).
 *
 * devloop spec-PR seam: EACH case is individually `it.effect.skip`'d with its
 * `[REQ-STMT-..]` id in the title — the sanctioned skip idiom
 * (`semgrep-escape-hatches.yml`: `.skip` allowed ONLY on a REQ-tagged test). The
 * `describe` is a plain, UNskipped container (verify-unskip evaluates per-`it`).
 *
 * The statement endpoint and its DB/consumer wiring do not exist yet. The
 * `typecheck (tsc -b)` gate runs on the spec PR, so the not-yet-existing
 * `../src/db.js` / `../src/main.js` (extended) / `../src/consumer.js` symbols are
 * pulled in via NON-LITERAL dynamic `import(specifier)` inside the skipped bodies
 * (`loadDb`/`loadMain`/`loadConsumer`): NodeNext `tsc` does not module-resolve a
 * non-literal dynamic import, so this compiles today and only EXECUTES once
 * `implement` writes the modules and removes the `.skip`.
 *
 * Expected surface (spec-fixed, minimal/plausible):
 *   - ../src/db.js: `DbLive`, `MigratorLive` (REQ-STMT-05).
 *   - ../src/main.js: `StatementApiLive` — the EXISTING skeleton layer, extended
 *     to also serve `GET /accounts/{id}/statement` (REQ-STMT-03/-04). It is
 *     already exported today (health-only); this feature ADDS the endpoint, so a
 *     STATIC import would compile — but the extended layer now depends on the
 *     DB/repo services, so it is loaded dynamically to keep the spec PR green.
 *   - ../src/consumer.js: `handleMessage` — used here only to SEED the read
 *     fixture by consuming events (the same path REQ-STMT-01 proves).
 *
 * Bodies are COMPLETE; `implement` may ONLY remove the `.skip`.
 *
 * Maps REQ-STMT-03 (this account only, newest-first) and REQ-STMT-04 (empty
 * list, not 404) at the HTTP surface. The behavioural depth of those criteria is
 * also asserted at the repo level in `projection.test.ts`.
 */

/** A statement line as returned by the endpoint (four event fields). */
interface StatementLineBody {
  readonly entryId: string;
  readonly accountId: string;
  readonly amount: number;
  readonly occurredAt: string;
}

/** A `LedgerEntryRecorded` wire payload (the four spec-fixed fields). */
interface RecordedEvent {
  readonly entryId: string;
  readonly accountId: string;
  readonly amount: number;
  readonly occurredAt: string;
}

interface StatementRepoApi {
  readonly statementFor: (
    accountId: string,
  ) => Effect.Effect<ReadonlyArray<StatementLineBody>>;
}

interface DbModule {
  readonly DbLive: Layer.Layer<SqlClient, unknown>;
  readonly MigratorLive: Layer.Layer<never, unknown, unknown>;
}
interface MainModule {
  // The served statement HTTP app, minus the transport (mirrors today's
  // skeleton export), now also serving the statement endpoint over the repo.
  readonly StatementApiLive: Layer.Layer<never, unknown, unknown>;
}
interface ConsumerModule {
  readonly handleMessage: (
    raw: unknown,
  ) => Effect.Effect<void, never, StatementRepoApi>;
}

const dbSpecifier = "../src/db.js";
const mainSpecifier = "../src/main.js";
const projectionSpecifier = "../src/projection.js";
const consumerSpecifier = "../src/consumer.js";
const loadDb = (): Promise<DbModule> =>
  import(dbSpecifier) as Promise<DbModule>;
const loadMain = (): Promise<MainModule> =>
  import(mainSpecifier) as Promise<MainModule>;
const loadConsumer = (): Promise<ConsumerModule> =>
  import(consumerSpecifier) as Promise<ConsumerModule>;

let container: StartedPostgreSqlContainer | undefined;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  process.env.PGHOST = container.getHost();
  process.env.PGPORT = String(container.getPort());
  process.env.PGDATABASE = container.getDatabase();
  process.env.PGUSER = container.getUsername();
  process.env.PGPASSWORD = container.getPassword();
}, 120000);

afterAll(async () => {
  if (container) {
    await container.stop();
  }
});

describe("statement-projection — GET /accounts/{id}/statement", () => {
  it.effect(
    "[REQ-STMT-03] returns ONLY the queried account's lines, newest-first by occurredAt with a deterministic entryId tie-break, over a REAL HTTP server",
    () =>
      Effect.gen(function* () {
        const { MigratorLive, DbLive } = yield* Effect.promise(loadDb);
        const { StatementApiLive } = yield* Effect.promise(loadMain);
        const { handleMessage } = yield* Effect.promise(loadConsumer);
        const { StatementRepo } = (yield* Effect.promise(
          () => import(projectionSpecifier),
        )) as {
          StatementRepo: { Default: Layer.Layer<unknown, unknown, SqlClient> };
        };

        // Wire: served HTTP app (over the repo/DB) bound to an ephemeral test
        // port; plus the migrator + a repo handle the seed step can use.
        const SqlLive = Layer.mergeAll(MigratorLive, DbLive);
        const ServerLive = StatementApiLive.pipe(
          Layer.provideMerge(NodeHttpServer.layerTest),
        );

        // Seed by CONSUMING events (the production write path), so the HTTP read
        // observes exactly what the projection persisted.
        const events: ReadonlyArray<RecordedEvent> = [
          {
            entryId: "led-http-1",
            accountId: "acc-http",
            amount: 100,
            occurredAt: "2026-06-21T10:00:00.000Z",
          },
          {
            entryId: "led-http-3",
            accountId: "acc-http",
            amount: -30,
            occurredAt: "2026-06-21T12:00:00.000Z",
          },
          {
            entryId: "led-http-2",
            accountId: "acc-http",
            amount: 50,
            occurredAt: "2026-06-21T12:00:00.000Z",
          },
          {
            entryId: "led-http-other",
            accountId: "acc-http-other",
            amount: 999,
            occurredAt: "2026-06-21T23:00:00.000Z",
          },
        ];
        const seed = Effect.gen(function* () {
          for (const ev of events) {
            yield* handleMessage(ev);
          }
        }).pipe(
          Effect.provide(StatementRepo.Default.pipe(Layer.provide(SqlLive))),
        ) as Effect.Effect<void>;
        yield* seed;

        const program = Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const res = yield* client.get("/accounts/acc-http/statement");
          expect(res.status).toBe(200);
          const lines = (yield* res.json) as ReadonlyArray<StatementLineBody>;

          // Only this account's lines.
          expect(lines.every((l) => l.accountId === "acc-http")).toBe(true);
          expect(lines.some((l) => l.entryId === "led-http-other")).toBe(false);

          // Newest-first by occurredAt, deterministic entryId tie-break on the
          // 12:00 pair, the older 10:00 row last — exact and reproducible.
          expect(lines.map((l) => l.entryId)).toEqual([
            "led-http-2",
            "led-http-3",
            "led-http-1",
          ]);

          // Each returned line carries the four event fields with the SIGNED
          // amount unchanged.
          const negative = lines.find((l) => l.entryId === "led-http-3");
          expect(negative?.amount).toBe(-30);
          expect(negative?.accountId).toBe("acc-http");
          expect(typeof negative?.occurredAt).toBe("string");
        });

        yield* Effect.provide(
          program,
          Layer.mergeAll(ServerLive, SqlLive),
        ) as Effect.Effect<void>;
      }),
  );

  it.effect(
    "[REQ-STMT-04] an account with no consumed events returns 200 with an empty array — NOT a 404 and NOT an error",
    () =>
      Effect.gen(function* () {
        const { MigratorLive, DbLive } = yield* Effect.promise(loadDb);
        const { StatementApiLive } = yield* Effect.promise(loadMain);

        const SqlLive = Layer.mergeAll(MigratorLive, DbLive);
        const ServerLive = StatementApiLive.pipe(
          Layer.provideMerge(NodeHttpServer.layerTest),
        );

        const program = Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          // Freshly migrated store, nothing consumed for this account.
          const res = yield* client.get("/accounts/acc-empty/statement");
          // A "leaf" account is a successful empty statement, never a 404.
          expect(res.status).toBe(200);
          expect(res.status).not.toBe(404);
          const lines = (yield* res.json) as ReadonlyArray<StatementLineBody>;
          expect(Array.isArray(lines)).toBe(true);
          expect(lines.length).toBe(0);
        });

        yield* Effect.provide(
          program,
          Layer.mergeAll(ServerLive, SqlLive),
        ) as Effect.Effect<void>;
      }),
  );
});

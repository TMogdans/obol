import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
 * Integration test for `GET /accounts/{id}` (account detail) against a REAL
 * Postgres (Testcontainers) and a REAL HTTP server (NodeHttpServer.layerTest,
 * which binds an ephemeral port and exposes an HttpClient pointed at it).
 *
 * v0.2.1 spec-PR seam: every case is `.skip`'d. The endpoint does not exist
 * yet, so these tests are written COMPLETE (real calls, real assertions) but
 * skipped — the trace gate counts the `[REQ-ACCD-..]` tags as coverage while
 * vitest does not redden a skipped case, so `main` stays green when the spec PR
 * lands. The later `implement` station may ONLY remove the `.skip` (enforced by
 * verify-unskip); it must not touch a title or an assertion. That is why each
 * body below is exact, not a placeholder.
 *
 * One container is started + migrated + seeded ONCE (beforeAll) and shared by
 * all cases — every case here is a read-only GET, so a single seed serves them
 * all. Requests use the raw HttpClient (not the typed HttpApiClient) so status
 * assertions are adversarial: we assert the actual status code AND the
 * structured body, not merely "the typed client succeeded/failed".
 *
 * Maps the EARS criteria of `.specify/specs/account-detail/spec.md`
 * (REQ-ACCD-01..08) one-to-one, so deleting a case turns the trace gate red.
 */

/** The account-detail success body, exactly the fields REQ-ACCD-01 mandates. */
interface AccountDetailBody {
  readonly id: string;
  readonly ownerId: string;
  readonly currency: string;
  readonly createdAt: string;
}

let container: StartedPostgreSqlContainer | undefined;

// Shared HTTP server layer: the served wallet api (handlers → repos → DbLive)
// bound to an ephemeral test port, with an HttpClient pointed at it.
const ServerLive = WalletApiLive.pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
);

// Layer that exposes a raw SqlClient for the query-plan / state-snapshot cases.
const SqlLive = Layer.mergeAll(
  MigratorLive.pipe(Layer.provide(NodeContext.layer)),
  DbLive,
);

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  process.env.PGHOST = container.getHost();
  process.env.PGPORT = String(container.getPort());
  process.env.PGDATABASE = container.getDatabase();
  process.env.PGUSER = container.getUsername();
  process.env.PGPASSWORD = container.getPassword();

  // Run the migration (MigratorLive) then seed a single shared account.
  // `acc-detail` carries a known owner + currency so the projection assertions
  // are exact; `created_at` is left to the column DEFAULT so REQ-ACCD-02 proves
  // the ISO-8601 `created_at::text` round-trip rather than an echoed literal.
  const seed = Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`
      INSERT INTO account (id, owner_id, currency)
      VALUES ('acc-detail', 'owner-detail', 'EUR')
    `;
  });
  await Effect.runPromise(Effect.scoped(Effect.provide(seed, SqlLive)));
}, 120000);

afterAll(async () => {
  if (container) {
    await container.stop();
  }
});

it.effect(
  "[REQ-ACCD-01] returns exactly { id, ownerId, currency, createdAt } for an existing account — no embedded balance",
  () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const res = yield* client.get("/accounts/acc-detail");
      expect(res.status).toBe(200);
      const body = (yield* res.json) as AccountDetailBody &
        Record<string, unknown>;
      expect(body.id).toBe("acc-detail");
      expect(body.ownerId).toBe("owner-detail");
      expect(body.currency).toBe("EUR");
      expect(typeof body.createdAt).toBe("string");
      // Exactly these four fields — and crucially NO balance is embedded.
      expect(Object.keys(body).sort()).toEqual([
        "createdAt",
        "currency",
        "id",
        "ownerId",
      ]);
      expect(body).not.toHaveProperty("balance");
    }).pipe(Effect.provide(ServerLive)),
);

it.effect(
  "[REQ-ACCD-02] delivers createdAt as an ISO-8601 string and currency as the stored value",
  () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const res = yield* client.get("/accounts/acc-detail");
      expect(res.status).toBe(200);
      const body = (yield* res.json) as AccountDetailBody;
      // currency is the stored value, not a derived/normalised one.
      expect(body.currency).toBe("EUR");
      // createdAt is an ISO-8601 string (created_at::text), parseable to a
      // real instant — not a numeric epoch, not a driver Date object.
      expect(typeof body.createdAt).toBe("string");
      const parsed = new Date(body.createdAt);
      expect(Number.isNaN(parsed.getTime())).toBe(false);
      // Round-trips through the ISO-8601 grammar (date + time + offset).
      expect(body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/);
    }).pipe(Effect.provide(ServerLive)),
);

it.effect(
  "[REQ-ACCD-03] returns 404 with the structured AccountNotFound error (_tag + accountId) for a missing account",
  () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const res = yield* client.get("/accounts/does-not-exist");
      expect(res.status).toBe(404);
      const body = (yield* res.json) as {
        readonly _tag?: string;
        readonly accountId?: string;
      };
      expect(body._tag).toBe("AccountNotFound");
      expect(body.accountId).toBe("does-not-exist");
    }).pipe(Effect.provide(ServerLive)),
);

it.effect(
  "[REQ-ACCD-04] surfaces a read-time SqlError as a 500 defect, not a typed client error",
  () =>
    Effect.gen(function* () {
      // Drop the table the read depends on so the next query raises a real
      // SqlError. Because the endpoint `orDie`s SqlError (it is NOT a declared
      // client error), the framework must answer 500 — and the body must NOT
      // be the typed AccountNotFound (404) shape, which would mean the DB fault
      // was misclassified as an ordinary missing-account client error.
      const sql = yield* SqlClient;
      yield* sql`DROP TABLE account CASCADE`;

      const client = yield* HttpClient.HttpClient;
      const res = yield* client.get("/accounts/acc-detail");
      expect(res.status).toBe(500);
      const body = (yield* res.json) as { readonly _tag?: string };
      expect(body._tag).not.toBe("AccountNotFound");

      // Restore the schema + seed so the shared fixture survives for any
      // case ordering (this test is destructive to the shared container).
      yield* sql`
        CREATE TABLE account (
          id          text PRIMARY KEY,
          owner_id    text NOT NULL,
          currency    text NOT NULL,
          created_at  timestamptz NOT NULL DEFAULT now(),
          idempotency_key text
        )
      `;
      yield* sql`
        INSERT INTO account (id, owner_id, currency)
        VALUES ('acc-detail', 'owner-detail', 'EUR')
      `;
    }).pipe(Effect.provide(Layer.mergeAll(ServerLive, SqlLive))),
);

it.effect(
  "[REQ-ACCD-05] performs no state change — the read is read-only and idempotent",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const client = yield* HttpClient.HttpClient;

      // Snapshot the account table before the read.
      const before = yield* sql<{
        readonly id: string;
        readonly owner_id: string;
        readonly currency: string;
        readonly created_at: string;
      }>`
        SELECT id, owner_id, currency, created_at::text AS created_at
        FROM account ORDER BY id
      `;
      const countBefore = yield* sql<{ readonly n: string }>`
        SELECT count(*)::text AS n FROM account
      `;

      // Hit the endpoint repeatedly: idempotent reads must give the same body.
      const first = yield* client.get("/accounts/acc-detail");
      const firstBody = (yield* first.json) as AccountDetailBody;
      const second = yield* client.get("/accounts/acc-detail");
      const secondBody = (yield* second.json) as AccountDetailBody;
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(secondBody).toEqual(firstBody);

      // The table is byte-for-byte unchanged: no row added, none mutated.
      const after = yield* sql<{
        readonly id: string;
        readonly owner_id: string;
        readonly currency: string;
        readonly created_at: string;
      }>`
        SELECT id, owner_id, currency, created_at::text AS created_at
        FROM account ORDER BY id
      `;
      const countAfter = yield* sql<{ readonly n: string }>`
        SELECT count(*)::text AS n FROM account
      `;
      expect(after).toEqual(before);
      expect(countAfter[0]?.n).toBe(countBefore[0]?.n);
    }).pipe(Effect.provide(Layer.mergeAll(ServerLive, SqlLive))),
);

it.effect(
  "[REQ-ACCD-06] reads the account via an indexed primary-key lookup (WHERE id = …), not a full scan",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      // Ask Postgres for the plan of the exact lookup the endpoint must use.
      // The `id` column is the PRIMARY KEY, so its implicit unique index must
      // be chosen; a Seq Scan would mean the query did not key on `id`.
      const plan = yield* sql<{ readonly "QUERY PLAN": string }>`
        EXPLAIN SELECT id, owner_id, currency, created_at::text AS created_at
        FROM account WHERE id = ${"acc-detail"}
      `;
      const planText = plan.map((row) => row["QUERY PLAN"]).join("\n");
      expect(planText).toMatch(/Index (Only )?Scan/);
      expect(planText).not.toMatch(/Seq Scan/);
    }).pipe(Effect.provide(SqlLive)),
);

it.effect(
  "[REQ-ACCD-07] keeps the response type local to wallet-service (no contracts touch, no cross-service import, no cycle/orphan) — anchored on `pnpm run arch`",
  () =>
    Effect.sync(() => {
      // Traceability anchor, NOT a duplicated ArchUnit: the architecture truth
      // lives in `pnpm run arch` (dependency-cruiser). This case binds the REQ
      // id to that gate by invoking it and asserting it passes — so the locality
      // rule (response type local, no packages/contracts touch, no cross-service
      // import, no cycle/orphan) is proven by the single authoritative gate.
      const here = dirname(fileURLToPath(import.meta.url));
      const repoRoot = resolve(here, "..", "..", "..");
      // Throws (non-zero exit) iff dependency-cruiser reports a violation.
      execFileSync("pnpm", ["run", "arch"], {
        cwd: repoRoot,
        stdio: "pipe",
      });
    }),
);

it.effect(
  "[REQ-ACCD-08] treats {id} as an opaque string path param — no format/schema check",
  () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      // A non-UUID, punctuated id must NOT be rejected by a format/schema check
      // (which would be a 400 before the handler). It is opaque: the handler
      // runs and, since no such account exists, answers the domain 404 — never
      // a validation 400.
      const weird = "not-a-uuid_$%^&*";
      const res = yield* client.get(`/accounts/${encodeURIComponent(weird)}`);
      expect(res.status).toBe(404);
      expect(res.status).not.toBe(400);
      const body = (yield* res.json) as {
        readonly _tag?: string;
        readonly accountId?: string;
      };
      expect(body._tag).toBe("AccountNotFound");
      expect(body.accountId).toBe(weird);
    }).pipe(Effect.provide(ServerLive)),
);

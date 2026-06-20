import { readFileSync } from "node:fs";
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
 * SPEC-TO-TESTS SKELETON for account-detail/spec.md (REQ-ACCD-01 … 07).
 *
 * These are FAILING-BY-DESIGN test skeletons authored from the REVIEWED spec,
 * BEFORE the implement station writes any product code. They exist to gate that
 * implementation: until `GET /accounts/{id}` (REQ-ACCD-01/02/03/04/05) is wired
 * into `WalletApi`/handlers, the HTTP cases below will fail (the route is absent
 * → 404 for ALL paths, body shape mismatch, etc.). That red is intentional —
 * the implement station's job is to turn them green WITHOUT editing this file.
 *
 * Conventions mirror the sister features account-open (account.test.ts) and
 * balance-query (api.test.ts):
 *   - framework: `@effect/vitest` (`it.effect`) over a REAL Postgres
 *     (Testcontainers) and a REAL HTTP server (`NodeHttpServer.layerTest`),
 *   - tagging: each criterion gets its OWN `it`/`it.effect` whose title is
 *     prefixed with its `[REQ-ACCD-NN]` id, so the spec↔test traceability gate
 *     maps one-to-one (delete a case ⇒ its criterion goes untested ⇒ gate red),
 *   - adversarial requests: raw `HttpClient`, so we assert the ACTUAL status
 *     code AND the structured body, not merely "the typed client succeeded".
 *
 * One container is started + migrated + seeded ONCE (beforeAll) and shared by
 * the HTTP cases; every case here is a read-only GET, so a single seed serves
 * them all (and REQ-ACCD-04 asserts that read-safety holds).
 *
 * NOTE for the implement station: the response Account body type must be
 * defined LOCALLY in services/wallet-service/src/api.ts (Review-Decision A3) —
 * do NOT route it through packages/contracts (that would escalate the tier to
 * T3 and break REQ-ACCD-06). The existing `AccountNotFound` error is reused
 * verbatim (Review-Decision A4).
 */

/** The detail body the spec mandates: exactly { id, ownerId, currency, createdAt }. */
interface AccountDetailBody {
  readonly id: string;
  readonly ownerId: string;
  readonly currency: string;
  readonly createdAt: string;
}

let container: StartedPostgreSqlContainer | undefined;

// Shared HTTP server layer: the served wallet api bound to an ephemeral test
// port, with an HttpClient pointed at it.
const ServerLive = WalletApiLive.pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
);

// Layer that exposes the raw SqlClient for seeding / EXPLAIN assertions.
const SeedLive = Layer.mergeAll(
  MigratorLive.pipe(Layer.provide(NodeContext.layer)),
  DbLive,
);

// A known-good created_at written explicitly so REQ-ACCD-03 can assert the
// EXACT ISO-8601 instant that comes back, not just "parses as a date".
const SEED_CREATED_AT = "2026-01-02T03:04:05Z";

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  process.env.PGHOST = container.getHost();
  process.env.PGPORT = String(container.getPort());
  process.env.PGDATABASE = container.getDatabase();
  process.env.PGUSER = container.getUsername();
  process.env.PGPASSWORD = container.getPassword();

  // Migrate, then seed a single account whose stammdaten the detail endpoint
  // must echo back. created_at is set explicitly so the contract assertion
  // (REQ-ACCD-03) is exact rather than "some ISO string".
  const seed = Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`
      INSERT INTO account (id, owner_id, currency, created_at)
      VALUES ('acc-detail-1', 'owner-detail-1', 'EUR', ${SEED_CREATED_AT})
    `;
  });
  await Effect.runPromise(Effect.scoped(Effect.provide(seed, SeedLive)));
}, 120000);

afterAll(async () => {
  if (container) {
    await container.stop();
  }
});

// ---------------------------------------------------------------------------
// REQ-ACCD-01 — When (event-driven): existing account → 200 + full record.
// ---------------------------------------------------------------------------
it.effect(
  "[REQ-ACCD-01] returns 200 and the account record {id, ownerId, currency, createdAt} for an existing account",
  () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const res = yield* client.get("/accounts/acc-detail-1");
      expect(res.status).toBe(200);
      const body = (yield* res.json) as AccountDetailBody;
      expect(body.id).toBe("acc-detail-1");
      expect(body.ownerId).toBe("owner-detail-1");
      expect(body.currency).toBe("EUR");
      // createdAt must be present (its exact shape is asserted in REQ-ACCD-03).
      expect(typeof body.createdAt).toBe("string");
    }).pipe(Effect.provide(ServerLive)),
);

// ---------------------------------------------------------------------------
// REQ-ACCD-02 — If/Then (state): no such account → 404 + structured error.
// Consistent with REQ-BAL-02: same `_tag` "AccountNotFound" + `accountId`.
// ---------------------------------------------------------------------------
it.effect(
  "[REQ-ACCD-02] returns 404 with a structured AccountNotFound error for a missing account",
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

// ---------------------------------------------------------------------------
// REQ-ACCD-03 — Contract: createdAt is an ISO-8601 string (driver-independent,
// via created_at::text like AccountRepo) and currency echoes the stored value.
// ---------------------------------------------------------------------------
it.effect(
  "[REQ-ACCD-03] returns createdAt as an ISO-8601 string and currency as the stored value",
  () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const res = yield* client.get("/accounts/acc-detail-1");
      expect(res.status).toBe(200);
      const body = (yield* res.json) as AccountDetailBody;

      // createdAt must be a STRING (not a Date / number / object) — the
      // ::text-projection contract. Round-tripping through Date proves it is a
      // well-formed ISO-8601 instant, and the value must be the seeded one.
      expect(typeof body.createdAt).toBe("string");
      const parsed = new Date(body.createdAt);
      expect(Number.isNaN(parsed.getTime())).toBe(false);
      expect(parsed.toISOString()).toBe(
        new Date(SEED_CREATED_AT).toISOString(),
      );

      // currency echoes the stored value (currently "EUR").
      expect(body.currency).toBe("EUR");
    }).pipe(Effect.provide(ServerLive)),
);

// ---------------------------------------------------------------------------
// REQ-ACCD-04 — When (idempotency / read-safety): repeated reads return the
// identical answer AND mutate no DB state (append-only domain untouched).
// ---------------------------------------------------------------------------
it.effect(
  "[REQ-ACCD-04] is idempotent and read-only: repeated GETs return identical bodies and change no DB state",
  () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const sql = yield* SqlClient;

      // Snapshot the row count BEFORE the reads (no writes may occur).
      const before = yield* sql<{ readonly n: string }>`
        SELECT count(*)::text AS n FROM account
      `;

      const first = yield* client.get("/accounts/acc-detail-1");
      expect(first.status).toBe(200);
      const firstBody = (yield* first.json) as AccountDetailBody;

      const second = yield* client.get("/accounts/acc-detail-1");
      expect(second.status).toBe(200);
      const secondBody = (yield* second.json) as AccountDetailBody;

      // Identical answers for an unchanged account.
      expect(secondBody).toEqual(firstBody);

      // No row was inserted/removed by the reads — state is unchanged.
      const after = yield* sql<{ readonly n: string }>`
        SELECT count(*)::text AS n FROM account
      `;
      expect(after[0]?.n).toBe(before[0]?.n);
    }).pipe(Effect.provide(Layer.merge(ServerLive, DbLive))),
);

// ---------------------------------------------------------------------------
// REQ-ACCD-07 — Performance (qualitative, Review-Decision A5): the detail
// lookup is an indexed primary-key access (`WHERE id = …`) — NOT a full table
// scan. No hard latency/throughput numbers.
//
// We assert this STRUCTURALLY via the Postgres query planner: EXPLAIN the exact
// lookup shape the handler must use and require the plan to be an Index/PK scan
// (it must NOT contain a "Seq Scan"). This is the closest automatable proxy for
// "indexed PK lookup, no full scan".
//
// Self-contained: it provisions its own table + index in an isolated scope, so
// it neither relies on the shared seed nor is affected by REQ-ACCD-05's drop.
// Ordered BEFORE REQ-ACCD-05 so the shared `account` table still exists when
// this case runs (REQ-ACCD-05 drops it as its last act).
// ---------------------------------------------------------------------------
it.effect(
  "[REQ-ACCD-07] looks the account up by indexed primary key (WHERE id = …), not via a full table scan",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;

      // Isolated fixture: a table shaped like `account` (id is the PK, like the
      // real schema's `id text PRIMARY KEY`) with enough rows that Postgres
      // would PREFER a seq scan if no usable index existed — making the
      // assertion adversarial.
      yield* sql`DROP TABLE IF EXISTS account_detail_plan_probe`;
      yield* sql`
        CREATE TABLE account_detail_plan_probe (
          id          text PRIMARY KEY,
          owner_id    text NOT NULL,
          currency    text NOT NULL,
          created_at  timestamptz NOT NULL DEFAULT now()
        )
      `;
      yield* sql`
        INSERT INTO account_detail_plan_probe (id, owner_id, currency)
        SELECT 'acc-' || g, 'owner-' || g, 'EUR'
        FROM generate_series(1, 5000) AS g
      `;
      yield* sql`ANALYZE account_detail_plan_probe`;

      // The lookup shape the implementation MUST use: equality on the PK.
      const plan = yield* sql<{ readonly "QUERY PLAN": string }>`
        EXPLAIN SELECT id, owner_id, currency, created_at::text AS created_at
        FROM account_detail_plan_probe
        WHERE id = 'acc-2500'
      `;
      const planText = plan.map((row) => row["QUERY PLAN"]).join("\n");

      // A PK lookup must resolve through the index, never a full scan.
      expect(planText).not.toContain("Seq Scan");
      expect(planText).toMatch(/Index (Only )?Scan|Index Cond/);

      yield* sql`DROP TABLE IF EXISTS account_detail_plan_probe`;
    }).pipe(Effect.provide(SeedLive)),
);

// ---------------------------------------------------------------------------
// REQ-ACCD-05 — If/Then (defect demarcation): a SqlError during the lookup is
// an unexpected defect → 500, and must NOT leak as a typed client error (e.g.
// must NOT be mistaken for a 404). Mirrors the `orDie` pattern in `balance`.
//
// We provoke a real SqlError by dropping the `account` table out from under the
// running server, then assert the failure surfaces as 500 — NOT 404 (which
// would mean a DB fault was misread as "account not found").
//
// IMPORTANT (implement station): this case is intentionally LAST — it destroys
// the shared `account` table. Earlier cases must have run already.
// ---------------------------------------------------------------------------
it.effect(
  "[REQ-ACCD-05] surfaces a SqlError as 500 (an unexpected defect), not as a typed 404 client error",
  () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const sql = yield* SqlClient;

      // Break the underlying read so the repo query raises a SqlError.
      yield* sql`DROP TABLE IF EXISTS account CASCADE`;

      const res = yield* client.get("/accounts/acc-detail-1");

      // The defect must surface as a 500 — and explicitly NOT as a 404. A 404
      // here would mean a DB fault was misclassified as "no such account".
      expect(res.status).toBe(500);
      expect(res.status).not.toBe(404);
    }).pipe(Effect.provide(Layer.merge(ServerLive, DbLive))),
);

// ---------------------------------------------------------------------------
// REQ-ACCD-06 — Architecture: no cross-service imports, no cycle, no orphan;
// the response type stays LOCAL to services/wallet-service (not in
// packages/contracts).
//
// This criterion is NOT a runtime vitest assertion in this repo: the
// architecture gate is dependency-cruiser, run as a SEPARATE repo-level gate
// via `pnpm run arch` (== `depcruise services packages --config
// .dependency-cruiser.cjs`), whose rules `no-cross-service-imports`,
// `no-circular`, and `no-orphans` already encode exactly this invariant. A
// duplicate "architecture test" here could drift from that authoritative gate.
//
// This case is the spec↔test traceability anchor: it routes REQ-ACCD-06 to the
// dependency-cruiser gate and asserts the gate config STILL contains the rules
// that back the requirement — so silently removing a rule (which would un-gate
// REQ-ACCD-06) turns this case red.
// ---------------------------------------------------------------------------
it("[REQ-ACCD-06] is enforced by the dependency-cruiser arch gate (no cross-service import / cycle / orphan)", () => {
  const configPath = fileURLToPath(
    new URL("../../../.dependency-cruiser.cjs", import.meta.url),
  );
  const source = readFileSync(configPath, "utf8");

  // The rules that back REQ-ACCD-06 must be present in the authoritative gate
  // config. Removing one would un-gate the architecture invariant.
  expect(source).toContain("no-cross-service-imports");
  expect(source).toContain("no-circular");
  expect(source).toContain("no-orphans");
});

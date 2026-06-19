import { HttpClient, HttpClientRequest } from "@effect/platform";
import { NodeContext, NodeHttpServer } from "@effect/platform-node";
import { it } from "@effect/vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, expect } from "vitest";
import { MigratorLive } from "../src/db.js";
import { WalletApiLive } from "../src/main.js";

/**
 * Integration test for `POST /accounts` (open an account) against a REAL
 * Postgres (Testcontainers) and a REAL HTTP server (NodeHttpServer.layerTest).
 *
 * One container is started + migrated ONCE (beforeAll, applying 0001 + the new
 * 0002 idempotency migration) and shared by all cases. Unlike the read-only
 * balance tests, these cases WRITE, so each uses its own owner ids and
 * Idempotency-Keys to stay independent — no shared seed, the endpoint creates
 * its own rows.
 *
 * Every EARS criterion from account-open/spec.md gets its OWN test, tagged with
 * its REQ id, so the spec↔test traceability gate maps one-to-one. Requests use
 * the raw HttpClient so status assertions are adversarial (the actual code AND
 * the structured body), not merely "the typed client succeeded/failed".
 */

interface AccountBody {
  readonly _tag: string;
  readonly id: string;
  readonly ownerId: string;
  readonly currency: string;
  readonly createdAt: string;
}

let container: StartedPostgreSqlContainer | undefined;

// Shared HTTP server layer: the served wallet api (handlers → AccountRepo →
// DbLive) bound to an ephemeral test port, with an HttpClient pointed at it.
const ServerLive = WalletApiLive.pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
);

const openAccount = (options: {
  readonly ownerId: string;
  readonly key?: string;
}) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const base = HttpClientRequest.post("/accounts").pipe(
      HttpClientRequest.bodyUnsafeJson({ ownerId: options.ownerId }),
    );
    const req =
      options.key === undefined
        ? base
        : base.pipe(
            HttpClientRequest.setHeader("Idempotency-Key", options.key),
          );
    return yield* client.execute(req);
  });

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  process.env.PGHOST = container.getHost();
  process.env.PGPORT = String(container.getPort());
  process.env.PGDATABASE = container.getDatabase();
  process.env.PGUSER = container.getUsername();
  process.env.PGPASSWORD = container.getPassword();

  // Apply all migrations (0001_init + 0002_account_idempotency) once.
  await Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        Effect.void,
        MigratorLive.pipe(Layer.provide(NodeContext.layer)),
      ),
    ),
  );
}, 120000);

afterAll(async () => {
  if (container) {
    await container.stop();
  }
});

it.effect(
  "[REQ-ACC-01] creates a new account (201) with a server id, owner and EUR currency",
  () =>
    Effect.gen(function* () {
      const res = yield* openAccount({
        ownerId: "owner-create",
        key: "acc-key-create",
      });
      expect(res.status).toBe(201);
      const body = (yield* res.json) as AccountBody;
      expect(body._tag).toBe("AccountCreated");
      expect(body.id).toMatch(/^acc_/);
      expect(body.ownerId).toBe("owner-create");
      expect(body.currency).toBe("EUR");
    }).pipe(Effect.provide(ServerLive)),
);

it.effect(
  "[REQ-ACC-02] replays the same account (200) for a repeated Idempotency-Key",
  () =>
    Effect.gen(function* () {
      const first = yield* openAccount({
        ownerId: "owner-replay",
        key: "acc-key-replay",
      });
      expect(first.status).toBe(201);
      const firstBody = (yield* first.json) as AccountBody;

      const second = yield* openAccount({
        ownerId: "owner-replay",
        key: "acc-key-replay",
      });
      expect(second.status).toBe(200);
      const secondBody = (yield* second.json) as AccountBody;
      expect(secondBody._tag).toBe("AccountExisted");
      // Same account returned, no second row inserted.
      expect(secondBody.id).toBe(firstBody.id);
    }).pipe(Effect.provide(ServerLive)),
);

it.effect("[REQ-ACC-03] rejects a missing Idempotency-Key with 400", () =>
  Effect.gen(function* () {
    const res = yield* openAccount({ ownerId: "owner-no-key" });
    expect(res.status).toBe(400);
  }).pipe(Effect.provide(ServerLive)),
);

it.effect("[REQ-ACC-04] rejects an empty ownerId with 400", () =>
  Effect.gen(function* () {
    const res = yield* openAccount({ ownerId: "", key: "acc-key-empty" });
    expect(res.status).toBe(400);
  }).pipe(Effect.provide(ServerLive)),
);

it.effect(
  "[REQ-ACC-05] allows multiple accounts for the same owner with distinct keys",
  () =>
    Effect.gen(function* () {
      const a = yield* openAccount({
        ownerId: "owner-multi",
        key: "acc-key-multi-1",
      });
      const b = yield* openAccount({
        ownerId: "owner-multi",
        key: "acc-key-multi-2",
      });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      const aBody = (yield* a.json) as AccountBody;
      const bBody = (yield* b.json) as AccountBody;
      // Two distinct accounts for one owner — ownerId is not unique.
      expect(aBody.id).not.toBe(bBody.id);
    }).pipe(Effect.provide(ServerLive)),
);

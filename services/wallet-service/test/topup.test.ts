import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { NodeContext, NodeHttpServer } from "@effect/platform-node";
import { SqlClient } from "@effect/sql/SqlClient";
import { it } from "@effect/vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { DbLive, MigratorLive } from "../src/db.js";
import { WalletApiLive } from "../src/main.js";

/**
 * Integration test for `POST /accounts/{id}/credit` (top-up) against a REAL
 * Postgres (Testcontainers) and a REAL HTTP server (NodeHttpServer.layerTest,
 * which binds an ephemeral port and exposes an HttpClient pointed at it).
 *
 * v0.2.x spec-PR seam: EACH case is individually `it.effect.skip`'d (the
 * `describe` is a plain, unskipped container — verify-unskip ignores containers
 * and demands the `.skip` on every `it`/`test` itself, while the escape-hatch
 * guard matches the literal `describe.skip(...)`/`it.skip(...)`, neither of
 * which the `it.effect.skip(...)` chain triggers). The `credit` endpoint does
 * not exist yet, so these tests are written COMPLETE (real calls, real
 * assertions) but skipped — the trace gate counts the
 * `[REQ-TOP-..]` tags as coverage while vitest does not redden a skipped case,
 * so `main` stays green when the spec PR lands. The later `implement` station
 * may ONLY remove the `.skip` (enforced by verify-unskip); it must not touch a
 * title or an assertion. That is why each body below is exact, not a
 * placeholder.
 *
 * Requests use the raw HttpClient (string path + JSON body) rather than the
 * typed HttpApiClient: that keeps this file compiling against the CURRENT
 * source (where `credit` is not yet on WalletApi) AND makes the status
 * assertions adversarial — we assert the actual code AND the structured body,
 * never merely "the typed client succeeded/failed".
 *
 * Maps the EARS criteria of `.specify/specs/wallet-topup/spec.md`
 * (REQ-TOP-01..09) one-to-one, so deleting a case turns the trace gate red.
 *
 * A fresh container is migrated ONCE (beforeAll). Because several cases WRITE
 * to the ledger, each case uses its OWN seeded account id so the cases stay
 * independent regardless of ordering — no shared mutable balance to interfere.
 */

/** The top-up success body — exactly the balance-query shape (REQ-TOP-04). */
interface BalanceBody {
  readonly accountId: string;
  readonly balance: number;
}

/** A raw ledger row as read back via `::text` to avoid driver coercion. */
interface LedgerRow {
  readonly id: string;
  readonly account_id: string;
  readonly amount: string;
  readonly type: string;
}

let container: StartedPostgreSqlContainer | undefined;

// Shared HTTP server layer: the served wallet api (handlers → repos → DbLive)
// bound to an ephemeral test port, with an HttpClient pointed at it.
const ServerLive = WalletApiLive.pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
);

// Layer that exposes a raw SqlClient for seeding, ledger snapshots and the
// query-plan case. MigratorLive runs the migration on build; DbLive is merged
// so the test body can resolve SqlClient directly.
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

  // Run the migration, then seed one account per write-case so the cases stay
  // independent. `acc-top-existing` starts with a known prior topup of 500 so
  // the new-balance assertion (REQ-TOP-01) proves aggregation, not an echo of
  // the request amount.
  const seed = Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`
      INSERT INTO account (id, owner_id, currency)
      VALUES
        ('acc-top-existing', 'owner-top', 'EUR'),
        ('acc-top-reject', 'owner-top', 'EUR'),
        ('acc-top-shape', 'owner-top', 'EUR'),
        ('acc-top-append', 'owner-top', 'EUR'),
        ('acc-top-surface', 'owner-top', 'EUR'),
        ('acc-top-sql', 'owner-top', 'EUR'),
        ('acc-top-plan', 'owner-top', 'EUR')
    `;
    // A prior topup of 500 on the happy-path account so the post-credit
    // balance must be 500 + amount (aggregation), never just `amount`.
    yield* sql`
      INSERT INTO ledger_entry (id, account_id, amount, type, idempotency_key)
      VALUES ('led-top-seed', 'acc-top-existing', 500, 'topup', 'idem-top-seed')
    `;
  });
  await Effect.runPromise(Effect.scoped(Effect.provide(seed, SqlLive)));
}, 120000);

afterAll(async () => {
  if (container) {
    await container.stop();
  }
});

describe("wallet-topup — POST /accounts/{id}/credit", () => {
  it.effect(
    "[REQ-TOP-01] appends exactly one topup ledger_entry (account_id, amount, type='topup') and returns the new balance",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const id = "acc-top-existing";

        // The account starts with a single prior topup of 500.
        const before = yield* sql<LedgerRow>`
          SELECT id, account_id, amount::text AS amount, type
          FROM ledger_entry WHERE account_id = ${id} ORDER BY id
        `;
        expect(before.length).toBe(1);

        const client = yield* HttpClient.HttpClient;
        const req = HttpClientRequest.post(`/accounts/${id}/credit`).pipe(
          HttpClientRequest.bodyUnsafeJson({ amount: 250 }),
        );
        const res = yield* client.execute(req);
        expect(res.status).toBe(200);

        // Exactly ONE new row was appended for this account.
        const after = yield* sql<LedgerRow>`
          SELECT id, account_id, amount::text AS amount, type
          FROM ledger_entry WHERE account_id = ${id} ORDER BY id
        `;
        expect(after.length).toBe(before.length + 1);

        // The appended row carries this account_id, this amount, type 'topup'.
        const appended = after.filter(
          (row) => !before.some((b) => b.id === row.id),
        );
        expect(appended.length).toBe(1);
        const entry = appended[0];
        expect(entry?.account_id).toBe(id);
        expect(entry?.amount).toBe("250");
        expect(entry?.type).toBe("topup");

        // The returned new balance is the aggregation: 500 (prior) + 250 = 750.
        const body = (yield* res.json) as BalanceBody;
        expect(body.accountId).toBe(id);
        expect(body.balance).toBe(750);
      }).pipe(Effect.provide(Layer.mergeAll(ServerLive, SqlLive))),
  );

  it.effect(
    "[REQ-TOP-02] rejects amount <= 0 (incl. 0) at the decode rim with 400 and writes NO ledger_entry",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const id = "acc-top-reject";
        const client = yield* HttpClient.HttpClient;

        const countFor = sql<{ readonly n: string }>`
          SELECT count(*)::text AS n FROM ledger_entry WHERE account_id = ${id}
        `;
        const before = yield* countFor;
        expect(before[0]?.n).toBe("0");

        // Zero is rejected.
        const zero = yield* client.execute(
          HttpClientRequest.post(`/accounts/${id}/credit`).pipe(
            HttpClientRequest.bodyUnsafeJson({ amount: 0 }),
          ),
        );
        expect(zero.status).toBe(400);

        // A negative amount is rejected.
        const negative = yield* client.execute(
          HttpClientRequest.post(`/accounts/${id}/credit`).pipe(
            HttpClientRequest.bodyUnsafeJson({ amount: -100 }),
          ),
        );
        expect(negative.status).toBe(400);

        // A non-integer amount is rejected (Schema.Int at the decode rim).
        const fractional = yield* client.execute(
          HttpClientRequest.post(`/accounts/${id}/credit`).pipe(
            HttpClientRequest.bodyUnsafeJson({ amount: 1.5 }),
          ),
        );
        expect(fractional.status).toBe(400);

        // Not one single ledger_entry was written for the account.
        const after = yield* countFor;
        expect(after[0]?.n).toBe("0");
      }).pipe(Effect.provide(Layer.mergeAll(ServerLive, SqlLive))),
  );

  it.effect(
    "[REQ-TOP-03] returns 404 with the structured AccountNotFound error (_tag + accountId) for a missing account and writes NO entry",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const missing = "acc-does-not-exist";
        const client = yield* HttpClient.HttpClient;

        const res = yield* client.execute(
          HttpClientRequest.post(`/accounts/${missing}/credit`).pipe(
            HttpClientRequest.bodyUnsafeJson({ amount: 100 }),
          ),
        );
        expect(res.status).toBe(404);
        const body = (yield* res.json) as {
          readonly _tag?: string;
          readonly accountId?: string;
        };
        expect(body._tag).toBe("AccountNotFound");
        expect(body.accountId).toBe(missing);

        // No orphan ledger_entry was written for the non-existent account.
        const count = yield* sql<{ readonly n: string }>`
          SELECT count(*)::text AS n FROM ledger_entry
          WHERE account_id = ${missing}
        `;
        expect(count[0]?.n).toBe("0");
      }).pipe(Effect.provide(Layer.mergeAll(ServerLive, SqlLive))),
  );

  it.effect(
    "[REQ-TOP-04] returns { accountId, balance } equal to projectBalance over ALL the account's entries (read after append, not computed separately)",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const id = "acc-top-shape";
        const client = yield* HttpClient.HttpClient;

        // Two successive top-ups; the second response must reflect the running
        // aggregation of every entry, not just the latest amount.
        const first = yield* client.execute(
          HttpClientRequest.post(`/accounts/${id}/credit`).pipe(
            HttpClientRequest.bodyUnsafeJson({ amount: 300 }),
          ),
        );
        expect(first.status).toBe(200);
        const firstBody = (yield* first.json) as BalanceBody &
          Record<string, unknown>;
        expect(firstBody.accountId).toBe(id);
        expect(firstBody.balance).toBe(300);
        // Exactly the two fields the balance-query shape mandates — nothing more.
        expect(Object.keys(firstBody).sort()).toEqual(["accountId", "balance"]);

        const second = yield* client.execute(
          HttpClientRequest.post(`/accounts/${id}/credit`).pipe(
            HttpClientRequest.bodyUnsafeJson({ amount: 200 }),
          ),
        );
        expect(second.status).toBe(200);
        const secondBody = (yield* second.json) as BalanceBody;
        expect(secondBody.accountId).toBe(id);
        expect(secondBody.balance).toBe(500);

        // The returned balance equals the independent aggregation of the raw
        // ledger rows (the SAME projection the balance-query uses): a topup
        // that returned a separately-computed number would diverge here.
        const rows = yield* sql<{ readonly amount: string }>`
          SELECT amount::text AS amount FROM ledger_entry
          WHERE account_id = ${id}
        `;
        const aggregate = rows.reduce(
          (sum, row) => sum + Number(row.amount),
          0,
        );
        expect(secondBody.balance).toBe(aggregate);
      }).pipe(Effect.provide(Layer.mergeAll(ServerLive, SqlLive))),
  );

  it.effect(
    "[REQ-TOP-05] keeps the domain append-only: an existing entry is never UPDATEd or DELETEd, only a new row is INSERTed",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const id = "acc-top-append";
        const client = yield* HttpClient.HttpClient;

        // First top-up creates a row; snapshot it byte-for-byte.
        const seedRes = yield* client.execute(
          HttpClientRequest.post(`/accounts/${id}/credit`).pipe(
            HttpClientRequest.bodyUnsafeJson({ amount: 400 }),
          ),
        );
        expect(seedRes.status).toBe(200);
        const before = yield* sql<LedgerRow>`
          SELECT id, account_id, amount::text AS amount, type
          FROM ledger_entry WHERE account_id = ${id} ORDER BY id
        `;
        expect(before.length).toBe(1);

        // Second top-up must APPEND, leaving the first row untouched.
        const appendRes = yield* client.execute(
          HttpClientRequest.post(`/accounts/${id}/credit`).pipe(
            HttpClientRequest.bodyUnsafeJson({ amount: 600 }),
          ),
        );
        expect(appendRes.status).toBe(200);

        const after = yield* sql<LedgerRow>`
          SELECT id, account_id, amount::text AS amount, type
          FROM ledger_entry WHERE account_id = ${id} ORDER BY id
        `;
        // Exactly one extra row — pure append, no net deletion.
        expect(after.length).toBe(2);
        // The original row survives unmutated (no UPDATE): every field of the
        // pre-existing row is still present unchanged among the rows after.
        const original = before[0];
        const stillThere = after.find((row) => row.id === original?.id);
        expect(stillThere).toEqual(original);
        // The first row's amount is still 400 — not overwritten by the second.
        expect(stillThere?.amount).toBe("400");
      }).pipe(Effect.provide(Layer.mergeAll(ServerLive, SqlLive))),
  );

  it.effect(
    "[REQ-TOP-06] request body is only { amount }: a client-supplied `type` is ignored and the stored type is server-set to 'topup'",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const id = "acc-top-surface";
        const client = yield* HttpClient.HttpClient;

        // The client tries to smuggle a `type` into the body. `type` is NOT
        // part of the request surface, so the stored entry must still be
        // 'topup' — never the attacker-chosen 'adjustment'.
        const res = yield* client.execute(
          HttpClientRequest.post(`/accounts/${id}/credit`).pipe(
            HttpClientRequest.bodyUnsafeJson({
              amount: 123,
              type: "adjustment",
            }),
          ),
        );
        expect(res.status).toBe(200);

        const rows = yield* sql<LedgerRow>`
          SELECT id, account_id, amount::text AS amount, type
          FROM ledger_entry WHERE account_id = ${id} ORDER BY id
        `;
        expect(rows.length).toBe(1);
        // Server-set: the type is 'topup', NOT the value the client supplied.
        expect(rows[0]?.type).toBe("topup");
        expect(rows[0]?.amount).toBe("123");
      }).pipe(Effect.provide(Layer.mergeAll(ServerLive, SqlLive))),
  );

  it.effect(
    "[REQ-TOP-07] surfaces a SqlError (existence check / append / balance read) as a 500 defect, NOT as a typed AccountNotFound client error",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const id = "acc-top-sql";

        // Drop the table the write path depends on so the next query raises a
        // real SqlError. Because the endpoint `orDie`s SqlError (it is NOT a
        // declared client error), the framework must answer 500 — and the body
        // must NOT be the typed AccountNotFound (404) shape, which would mean a
        // DB fault was misclassified as an ordinary missing-account error.
        yield* sql`DROP TABLE ledger_entry CASCADE`;

        const client = yield* HttpClient.HttpClient;
        const res = yield* client.execute(
          HttpClientRequest.post(`/accounts/${id}/credit`).pipe(
            HttpClientRequest.bodyUnsafeJson({ amount: 100 }),
          ),
        );
        expect(res.status).toBe(500);
        const body = (yield* res.json) as { readonly _tag?: string };
        expect(body._tag).not.toBe("AccountNotFound");

        // Restore the schema so the shared fixture survives for any case
        // ordering (this test is destructive to the shared container).
        yield* sql`
          CREATE TABLE ledger_entry (
            id              text PRIMARY KEY,
            account_id      text NOT NULL REFERENCES account(id),
            amount          bigint NOT NULL,
            type            text NOT NULL CHECK (type IN ('topup','spend','adjustment')),
            idempotency_key text NOT NULL,
            created_at      timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT uq_ledger_idempotency UNIQUE (idempotency_key)
          )
        `;
        yield* sql`CREATE INDEX idx_ledger_account ON ledger_entry(account_id)`;
        yield* sql`
          CREATE RULE ledger_no_update AS ON UPDATE TO ledger_entry DO INSTEAD NOTHING
        `;
        yield* sql`
          CREATE RULE ledger_no_delete AS ON DELETE TO ledger_entry DO INSTEAD NOTHING
        `;
      }).pipe(Effect.provide(Layer.mergeAll(ServerLive, SqlLive))),
  );

  it.effect(
    "[REQ-TOP-08] keeps the credit request/response types and append repo LOCAL to wallet-service (no contracts touch, no new migration, no auth) — anchored on `pnpm run arch`",
    () =>
      Effect.sync(() => {
        // Traceability anchor, NOT a duplicated ArchUnit: the architecture
        // truth lives in `pnpm run arch` (dependency-cruiser). This case binds
        // the REQ id to that gate by invoking it and asserting it passes — so
        // the locality rule (response/request type + append repo local to
        // wallet-service, no packages/contracts touch, no cross-service
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
    "[REQ-TOP-09] reads via the indexed account_id (idx_ledger_account) and the PK existence lookup (WHERE id = …), never a sequential scan",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;

        // Postgres will not pick an index over a tiny table unless forced, so
        // disable sequential scans for the planning of these exact queries —
        // this asserts a usable index EXISTS and is chosen, which is the
        // qualitative NFR (no extra scan-load), not a hard latency number.
        yield* sql`SET enable_seqscan = off`;

        // The balance read keys on account_id, served by idx_ledger_account.
        const ledgerPlan = yield* sql<{ readonly "QUERY PLAN": string }>`
          EXPLAIN SELECT amount::text AS amount FROM ledger_entry
          WHERE account_id = ${"acc-top-plan"}
        `;
        const ledgerText = ledgerPlan
          .map((row) => row["QUERY PLAN"])
          .join("\n");
        expect(ledgerText).toMatch(/Index (Only )?Scan/);
        expect(ledgerText).not.toMatch(/Seq Scan/);

        // The existence check keys on the account PRIMARY KEY (WHERE id = …).
        const existsPlan = yield* sql<{ readonly "QUERY PLAN": string }>`
          EXPLAIN SELECT 1 AS one FROM account
          WHERE id = ${"acc-top-plan"} LIMIT 1
        `;
        const existsText = existsPlan
          .map((row) => row["QUERY PLAN"])
          .join("\n");
        expect(existsText).toMatch(/Index (Only )?Scan/);
        expect(existsText).not.toMatch(/Seq Scan/);

        yield* sql`SET enable_seqscan = on`;
      }).pipe(Effect.provide(SqlLive)),
  );
});

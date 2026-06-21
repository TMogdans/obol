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
 * Integration test for `POST /accounts/{id}/debit` (spend) against a REAL
 * Postgres (Testcontainers) and a REAL HTTP server (NodeHttpServer.layerTest,
 * which binds an ephemeral port and exposes an HttpClient pointed at it).
 *
 * devloop spec-PR seam: EACH case is individually `it.effect.skip`'d with its
 * `[REQ-SPD-..]` id in the title — the SANCTIONED skip idiom
 * (`tools/semgrep-escape-hatches.yml`: a `.skip` is only allowed on a
 * REQ-tagged test; the title literal follows `(` and carries the tag, so the
 * escape-hatch guard passes). The `describe` is a plain, UNskipped container —
 * verify-unskip evaluates per-`it` and ignores containers, so a bare
 * `describe.skip` would NOT count as coverage and would trip the escape hatch.
 * The `debit` endpoint does not exist yet, so these tests are written COMPLETE
 * (real calls, real assertions) but skipped — the trace gate counts the
 * `[REQ-SPD-..]` tags as coverage while vitest does not redden a skipped case,
 * so `main` stays green when the spec PR lands. The later `implement` station
 * may ONLY remove the `.skip` (enforced by verify-unskip); it must not touch a
 * title or an assertion. That is why each body below is exact, not a
 * placeholder.
 *
 * Requests use the raw HttpClient (string path + JSON body) rather than the
 * typed HttpApiClient: that keeps this file compiling against the CURRENT
 * source (where `debit` is not yet on WalletApi) AND makes the status
 * assertions adversarial — we assert the actual code AND the structured body,
 * never merely "the typed client succeeded/failed".
 *
 * Maps the EARS criteria of `.specify/specs/wallet-spend/spec.md`
 * (REQ-SPD-01..10; REQ-SPD-11 is the fast-check property in
 * `spend.property.test.ts`) one-to-one, so deleting a case turns the trace
 * gate red.
 *
 * A fresh container is migrated ONCE (beforeAll). Because several cases WRITE
 * to the ledger, each case uses its OWN seeded account id so the cases stay
 * independent regardless of ordering — no shared mutable balance to interfere.
 * Spend cases that must succeed are seeded with a prior `topup` so there is
 * real balance to draw down (a spend can never appear before there is cover).
 */

/** The spend success body — exactly the balance-query shape (REQ-SPD-05). */
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

  // Run the migration, then seed one account per case so the cases stay
  // independent. Accounts that must spend successfully get a prior topup so
  // there is genuine balance to draw down; the new-balance assertions then
  // prove aggregation over the WHOLE history, not an echo of the request.
  const seed = Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`
      INSERT INTO account (id, owner_id, currency)
      VALUES
        ('acc-spd-happy', 'owner-spd', 'EUR'),
        ('acc-spd-insufficient', 'owner-spd', 'EUR'),
        ('acc-spd-reject', 'owner-spd', 'EUR'),
        ('acc-spd-shape', 'owner-spd', 'EUR'),
        ('acc-spd-append', 'owner-spd', 'EUR'),
        ('acc-spd-surface', 'owner-spd', 'EUR'),
        ('acc-spd-sql', 'owner-spd', 'EUR'),
        ('acc-spd-exact', 'owner-spd', 'EUR'),
        ('acc-spd-plan', 'owner-spd', 'EUR')
    `;
    // Prior topups so the spend has cover. The happy-path account holds 1000
    // (a spend of 300 must land it on exactly 700 — aggregation). The
    // insufficient account holds only 100 (a spend of 200 must be rejected).
    // The exact account holds exactly 500 (a spend of 500 must reach 0). The
    // shape/append accounts hold 1000 for repeated draws.
    yield* sql`
      INSERT INTO ledger_entry (id, account_id, amount, type, idempotency_key)
      VALUES
        ('led-spd-happy', 'acc-spd-happy', 1000, 'topup', 'idem-spd-happy'),
        ('led-spd-insuf', 'acc-spd-insufficient', 100, 'topup', 'idem-spd-insuf'),
        ('led-spd-shape', 'acc-spd-shape', 1000, 'topup', 'idem-spd-shape'),
        ('led-spd-append', 'acc-spd-append', 1000, 'topup', 'idem-spd-append'),
        ('led-spd-surface', 'acc-spd-surface', 1000, 'topup', 'idem-spd-surface'),
        ('led-spd-exact', 'acc-spd-exact', 500, 'topup', 'idem-spd-exact')
    `;
  });
  await Effect.runPromise(Effect.scoped(Effect.provide(seed, SqlLive)));
}, 120000);

afterAll(async () => {
  if (container) {
    await container.stop();
  }
});

describe("wallet-spend — POST /accounts/{id}/debit", () => {
  it.effect.skip(
    "[REQ-SPD-01] appends exactly one spend ledger_entry (account_id, type='spend', amount_stored = -amount) and returns the new balance",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const id = "acc-spd-happy";

        // The account starts with a single prior topup of 1000.
        const before = yield* sql<LedgerRow>`
          SELECT id, account_id, amount::text AS amount, type
          FROM ledger_entry WHERE account_id = ${id} ORDER BY id
        `;
        expect(before.length).toBe(1);

        const client = yield* HttpClient.HttpClient;
        // The request surface carries `amount` as a POSITIVE minor-unit number
        // (the spend *quantity*); the sign is a server-set domain detail.
        const req = HttpClientRequest.post(`/accounts/${id}/debit`).pipe(
          HttpClientRequest.bodyUnsafeJson({ amount: 300 }),
        );
        const res = yield* client.execute(req);
        expect(res.status).toBe(200);

        // Exactly ONE new row was appended for this account.
        const after = yield* sql<LedgerRow>`
          SELECT id, account_id, amount::text AS amount, type
          FROM ledger_entry WHERE account_id = ${id} ORDER BY id
        `;
        expect(after.length).toBe(before.length + 1);

        // The appended row carries this account_id, type 'spend', and the
        // NEGATED amount (amount_stored = -amount): a positive 300 in the
        // request is stored as -300.
        const appended = after.filter(
          (row) => !before.some((b) => b.id === row.id),
        );
        expect(appended.length).toBe(1);
        const entry = appended[0];
        expect(entry?.account_id).toBe(id);
        expect(entry?.type).toBe("spend");
        expect(entry?.amount).toBe("-300");

        // The returned new balance is the aggregation: 1000 - 300 = 700.
        const body = (yield* res.json) as BalanceBody;
        expect(body.accountId).toBe(id);
        expect(body.balance).toBe(700);
      }).pipe(Effect.provide(Layer.mergeAll(ServerLive, SqlLive))),
  );

  it.effect.skip(
    "[REQ-SPD-02] rejects amount > balance with 409 InsufficientFunds (_tag + accountId, NO balance leakage) and writes NO ledger_entry",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const id = "acc-spd-insufficient";
        const client = yield* HttpClient.HttpClient;

        // Account holds exactly one prior topup of 100.
        const before = yield* sql<LedgerRow>`
          SELECT id, account_id, amount::text AS amount, type
          FROM ledger_entry WHERE account_id = ${id} ORDER BY id
        `;
        expect(before.length).toBe(1);

        // A spend of 200 exceeds the available balance of 100 → rejected.
        const res = yield* client.execute(
          HttpClientRequest.post(`/accounts/${id}/debit`).pipe(
            HttpClientRequest.bodyUnsafeJson({ amount: 200 }),
          ),
        );
        expect(res.status).toBe(409);

        const body = (yield* res.json) as {
          readonly _tag?: string;
          readonly accountId?: string;
          readonly balance?: unknown;
        };
        expect(body._tag).toBe("InsufficientFunds");
        expect(body.accountId).toBe(id);
        // No balance/deficit leakage: the status code carries the semantics,
        // the body must NOT expose the available balance over a rejected write.
        expect(body.balance).toBeUndefined();

        // NOT a single new ledger_entry was written: the balance is read and
        // compared BEFORE any append, so a rejected spend leaves no trace.
        const after = yield* sql<LedgerRow>`
          SELECT id, account_id, amount::text AS amount, type
          FROM ledger_entry WHERE account_id = ${id} ORDER BY id
        `;
        expect(after.length).toBe(before.length);
        expect(after).toEqual(before);
      }).pipe(Effect.provide(Layer.mergeAll(ServerLive, SqlLive))),
  );

  it.effect.skip(
    "[REQ-SPD-03] rejects amount <= 0 (incl. 0, negative, non-integer) at the decode rim with 400 and writes NO ledger_entry",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const id = "acc-spd-reject";
        const client = yield* HttpClient.HttpClient;

        const countFor = sql<{ readonly n: string }>`
          SELECT count(*)::text AS n FROM ledger_entry WHERE account_id = ${id}
        `;
        const before = yield* countFor;
        expect(before[0]?.n).toBe("0");

        // Zero is rejected (the equality `amount == 0` is NOT a valid spend).
        const zero = yield* client.execute(
          HttpClientRequest.post(`/accounts/${id}/debit`).pipe(
            HttpClientRequest.bodyUnsafeJson({ amount: 0 }),
          ),
        );
        expect(zero.status).toBe(400);

        // A negative amount is rejected: the sign is server-set, the request
        // surface is a POSITIVE quantity (a pre-negated body is invalid).
        const negative = yield* client.execute(
          HttpClientRequest.post(`/accounts/${id}/debit`).pipe(
            HttpClientRequest.bodyUnsafeJson({ amount: -100 }),
          ),
        );
        expect(negative.status).toBe(400);

        // A non-integer amount is rejected (Schema.Int at the decode rim).
        const fractional = yield* client.execute(
          HttpClientRequest.post(`/accounts/${id}/debit`).pipe(
            HttpClientRequest.bodyUnsafeJson({ amount: 1.5 }),
          ),
        );
        expect(fractional.status).toBe(400);

        // The decode rim runs BEFORE the handler — not one ledger_entry exists.
        const after = yield* countFor;
        expect(after[0]?.n).toBe("0");
      }).pipe(Effect.provide(Layer.mergeAll(ServerLive, SqlLive))),
  );

  it.effect.skip(
    "[REQ-SPD-04] returns 404 with the structured AccountNotFound error (_tag + accountId) for a missing account and writes NO entry",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const missing = "acc-spd-does-not-exist";
        const client = yield* HttpClient.HttpClient;

        // Existence check runs FIRST (before the balance read), so a missing
        // account is a 404 AccountNotFound, never a 409 InsufficientFunds.
        const res = yield* client.execute(
          HttpClientRequest.post(`/accounts/${missing}/debit`).pipe(
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

  it.effect.skip(
    "[REQ-SPD-05] returns { accountId, balance } equal to projectBalance over ALL the account's entries (read after append, not alterSaldo - amount)",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const id = "acc-spd-shape";
        const client = yield* HttpClient.HttpClient;

        // The account starts with a prior topup of 1000. Two successive spends;
        // each response must reflect the running aggregation of EVERY entry
        // (positive topup + negative spends), not a separately-computed number.
        const first = yield* client.execute(
          HttpClientRequest.post(`/accounts/${id}/debit`).pipe(
            HttpClientRequest.bodyUnsafeJson({ amount: 400 }),
          ),
        );
        expect(first.status).toBe(200);
        const firstBody = (yield* first.json) as BalanceBody &
          Record<string, unknown>;
        expect(firstBody.accountId).toBe(id);
        expect(firstBody.balance).toBe(600);
        // Exactly the two fields the balance-query shape mandates — nothing more.
        expect(Object.keys(firstBody).sort()).toEqual(["accountId", "balance"]);

        const second = yield* client.execute(
          HttpClientRequest.post(`/accounts/${id}/debit`).pipe(
            HttpClientRequest.bodyUnsafeJson({ amount: 250 }),
          ),
        );
        expect(second.status).toBe(200);
        const secondBody = (yield* second.json) as BalanceBody;
        expect(secondBody.accountId).toBe(id);
        expect(secondBody.balance).toBe(350);

        // The returned balance equals the independent aggregation of the raw
        // SIGNED ledger rows (the SAME projection balance-query uses): a spend
        // that returned `alterSaldo - amount` instead of re-reading the
        // projection would diverge from this sum.
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

  it.effect.skip(
    "[REQ-SPD-06] keeps the domain append-only: an existing entry is never UPDATEd or DELETEd, only a new spend row is INSERTed",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const id = "acc-spd-append";
        const client = yield* HttpClient.HttpClient;

        // The account holds a prior topup of 1000; snapshot it byte-for-byte.
        const before = yield* sql<LedgerRow>`
          SELECT id, account_id, amount::text AS amount, type
          FROM ledger_entry WHERE account_id = ${id} ORDER BY id
        `;
        expect(before.length).toBe(1);
        const original = before[0];
        expect(original?.amount).toBe("1000");
        expect(original?.type).toBe("topup");

        // The spend must APPEND a new (negative, 'spend') row, leaving the prior
        // topup row untouched — no UPDATE of the existing balance, no DELETE.
        const res = yield* client.execute(
          HttpClientRequest.post(`/accounts/${id}/debit`).pipe(
            HttpClientRequest.bodyUnsafeJson({ amount: 600 }),
          ),
        );
        expect(res.status).toBe(200);

        const after = yield* sql<LedgerRow>`
          SELECT id, account_id, amount::text AS amount, type
          FROM ledger_entry WHERE account_id = ${id} ORDER BY id
        `;
        // Exactly one extra row — pure append, no net deletion.
        expect(after.length).toBe(2);
        // The original topup row survives unmutated (no UPDATE): every field is
        // still present unchanged among the rows after.
        const stillThere = after.find((row) => row.id === original?.id);
        expect(stillThere).toEqual(original);
        expect(stillThere?.amount).toBe("1000");
        // The new row is the spend: negative amount, type 'spend'.
        const appended = after.find((row) => row.id !== original?.id);
        expect(appended?.type).toBe("spend");
        expect(appended?.amount).toBe("-600");
      }).pipe(Effect.provide(Layer.mergeAll(ServerLive, SqlLive))),
  );

  it.effect.skip(
    "[REQ-SPD-07] request body is only { amount }: a client-supplied `type` is ignored and the stored type is server-set to 'spend'",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const id = "acc-spd-surface";
        const client = yield* HttpClient.HttpClient;

        // The account holds a prior topup of 1000.
        const before = yield* sql<LedgerRow>`
          SELECT id FROM ledger_entry WHERE account_id = ${id} ORDER BY id
        `;
        expect(before.length).toBe(1);

        // The client tries to smuggle a `type` into the body. `type` is NOT
        // part of the request surface, so the stored entry must still be
        // 'spend' — never the attacker-chosen 'topup' (which would FLIP the
        // sign and credit the account instead of debiting it).
        const res = yield* client.execute(
          HttpClientRequest.post(`/accounts/${id}/debit`).pipe(
            HttpClientRequest.bodyUnsafeJson({
              amount: 123,
              type: "topup",
            }),
          ),
        );
        expect(res.status).toBe(200);

        const after = yield* sql<LedgerRow>`
          SELECT id, account_id, amount::text AS amount, type
          FROM ledger_entry WHERE account_id = ${id} ORDER BY id
        `;
        expect(after.length).toBe(2);
        const appended = after.find(
          (row) => !before.some((b) => b.id === row.id),
        );
        // Server-set: the type is 'spend', NOT the value the client supplied,
        // and the amount is server-negated.
        expect(appended?.type).toBe("spend");
        expect(appended?.amount).toBe("-123");
      }).pipe(Effect.provide(Layer.mergeAll(ServerLive, SqlLive))),
  );

  it.effect.skip(
    "[REQ-SPD-08] surfaces a SqlError (existence check / balance read / append) as a 500 defect, NOT as a typed AccountNotFound or InsufficientFunds client error",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const id = "acc-spd-sql";

        // Drop the table the write path depends on so the next query raises a
        // real SqlError. Because the endpoint `orDie`s SqlError (it is NOT a
        // declared client error), the framework must answer 500 — and the body
        // must be NEITHER the typed AccountNotFound (404) NOR the
        // InsufficientFunds (409) shape: a DB fault may not disguise itself as
        // a missing account NOR as a coverage shortfall.
        yield* sql`DROP TABLE ledger_entry CASCADE`;

        const client = yield* HttpClient.HttpClient;
        const res = yield* client.execute(
          HttpClientRequest.post(`/accounts/${id}/debit`).pipe(
            HttpClientRequest.bodyUnsafeJson({ amount: 100 }),
          ),
        );
        expect(res.status).toBe(500);
        const body = (yield* res.json) as { readonly _tag?: string };
        expect(body._tag).not.toBe("AccountNotFound");
        expect(body._tag).not.toBe("InsufficientFunds");

        // Restore the schema AND re-seed the fixture data so the shared
        // container survives for any case ordering (this test is destructive:
        // DROP TABLE ... CASCADE wipes the seeded ledger rows too).
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
        // Re-seed the FULL set of ledger_entry rows the beforeAll inserted, so
        // this destructive test leaves the shared fixture intact for any later
        // case (e.g. [REQ-SPD-02] exact depends on acc-spd-exact holding 500).
        // The no_update/no_delete RULEs only block UPDATE/DELETE — INSERT is
        // still permitted, so the fixture can be faithfully rebuilt.
        yield* sql`
          INSERT INTO ledger_entry (id, account_id, amount, type, idempotency_key)
          VALUES
            ('led-spd-happy', 'acc-spd-happy', 1000, 'topup', 'idem-spd-happy'),
            ('led-spd-insuf', 'acc-spd-insufficient', 100, 'topup', 'idem-spd-insuf'),
            ('led-spd-shape', 'acc-spd-shape', 1000, 'topup', 'idem-spd-shape'),
            ('led-spd-append', 'acc-spd-append', 1000, 'topup', 'idem-spd-append'),
            ('led-spd-surface', 'acc-spd-surface', 1000, 'topup', 'idem-spd-surface'),
            ('led-spd-exact', 'acc-spd-exact', 500, 'topup', 'idem-spd-exact')
        `;
      }).pipe(Effect.provide(Layer.mergeAll(ServerLive, SqlLive))),
  );

  it.effect.skip(
    "[REQ-SPD-09] keeps the spend request/response types, InsufficientFunds error and append repo LOCAL to wallet-service (no contracts touch, no new migration, no auth) — anchored on `pnpm run arch`",
    () =>
      Effect.sync(() => {
        // Traceability anchor, NOT a duplicated ArchUnit: the architecture
        // truth lives in `pnpm run arch` (dependency-cruiser). This case binds
        // the REQ id to that gate by invoking it and asserting it passes — so
        // the locality rule (response/request type + InsufficientFunds + append
        // repo local to wallet-service, no packages/contracts touch, no
        // cross-service import, no cycle/orphan, keeping the feature at T2)
        // is proven by the single authoritative gate.
        const here = dirname(fileURLToPath(import.meta.url));
        const repoRoot = resolve(here, "..", "..", "..");
        // Throws (non-zero exit) iff dependency-cruiser reports a violation.
        execFileSync("pnpm", ["run", "arch"], {
          cwd: repoRoot,
          stdio: "pipe",
        });
      }),
  );

  it.effect.skip(
    "[REQ-SPD-10] reads the balance via the indexed account_id (idx_ledger_account) and the PK existence lookup (WHERE id = …), never a sequential scan",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;

        // Postgres will not pick an index over a tiny table unless forced, so
        // disable sequential scans for the planning of these exact queries —
        // this asserts a usable index EXISTS and is chosen, which is the
        // qualitative NFR (no extra scan-load), not a hard latency number.
        yield* sql`SET enable_seqscan = off`;

        // The balance read (and the coverage check before the append) keys on
        // account_id, served by idx_ledger_account.
        const ledgerPlan = yield* sql<{ readonly "QUERY PLAN": string }>`
          EXPLAIN SELECT amount::text AS amount FROM ledger_entry
          WHERE account_id = ${"acc-spd-plan"}
        `;
        const ledgerText = ledgerPlan
          .map((row) => row["QUERY PLAN"])
          .join("\n");
        expect(ledgerText).toMatch(/Index (Only )?Scan/);
        expect(ledgerText).not.toMatch(/Seq Scan/);

        // The existence check keys on the account PRIMARY KEY (WHERE id = …).
        const existsPlan = yield* sql<{ readonly "QUERY PLAN": string }>`
          EXPLAIN SELECT 1 AS one FROM account
          WHERE id = ${"acc-spd-plan"} LIMIT 1
        `;
        const existsText = existsPlan
          .map((row) => row["QUERY PLAN"])
          .join("\n");
        expect(existsText).toMatch(/Index (Only )?Scan/);
        expect(existsText).not.toMatch(/Seq Scan/);

        yield* sql`SET enable_seqscan = on`;
      }).pipe(Effect.provide(SqlLive)),
  );

  it.effect.skip(
    "[REQ-SPD-02] allows a spend exactly equal to the balance (amount == balance) and lands the account on exactly 0",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const id = "acc-spd-exact";
        const client = yield* HttpClient.HttpClient;

        // The account holds exactly 500. A spend of exactly 500 is the
        // boundary the invariant ALLOWS: equality `amount == balance` is
        // permitted and must drive the balance to exactly 0 (never 409).
        const res = yield* client.execute(
          HttpClientRequest.post(`/accounts/${id}/debit`).pipe(
            HttpClientRequest.bodyUnsafeJson({ amount: 500 }),
          ),
        );
        expect(res.status).toBe(200);
        const body = (yield* res.json) as BalanceBody;
        expect(body.accountId).toBe(id);
        expect(body.balance).toBe(0);

        // The spend row stored the negated amount; the aggregation is 0.
        const rows = yield* sql<{ readonly amount: string }>`
          SELECT amount::text AS amount FROM ledger_entry
          WHERE account_id = ${id}
        `;
        const aggregate = rows.reduce(
          (sum, row) => sum + Number(row.amount),
          0,
        );
        expect(aggregate).toBe(0);
      }).pipe(Effect.provide(Layer.mergeAll(ServerLive, SqlLive))),
  );
});

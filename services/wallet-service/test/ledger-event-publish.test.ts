import { HttpClient, HttpClientRequest } from "@effect/platform";
import { NodeContext, NodeHttpServer } from "@effect/platform-node";
import { SqlClient } from "@effect/sql/SqlClient";
import { it } from "@effect/vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Effect, Layer, type Layer as LayerNs } from "effect";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { DbLive, MigratorLive } from "../src/db.js";
import { WalletApiLive } from "../src/main.js";

/**
 * Integration test for the ledger-event producer path against a REAL Postgres
 * (Testcontainers) and a REAL HTTP server (NodeHttpServer.layerTest).
 *
 * devloop spec-PR seam: EACH case is individually `it.effect.skip`'d with its
 * `[REQ-EVT-..]` id in the title — the sanctioned skip idiom
 * (`semgrep-escape-hatches.yml`: a `.skip` is allowed ONLY on a REQ-tagged test).
 * The `describe` is a plain, UNskipped container — verify-unskip evaluates
 * per-`it` and ignores containers.
 *
 * The producer path does not exist yet. The required `typecheck (tsc -b)` gate
 * also runs on the spec PR, so a STATIC import of the not-yet-existing
 * `../src/outbox.js` module would redden the spec PR (TS2307). The producer
 * symbols this feature introduces are therefore pulled in via a NON-LITERAL
 * dynamic `import(specifier)` inside the skipped bodies (`loadOutbox` below):
 * NodeNext `tsc` does not module-resolve a non-literal dynamic import, so this
 * compiles today, and the `import()` only EXECUTES once `implement` writes the
 * module and removes the `.skip`. The expected producer surface (spec-fixed
 * names/signatures) is:
 *   - LEDGER_RECORDED_SUBJECT: the stable NATS subject constant (REQ-EVT-10),
 *     value "ledger.entry.recorded".
 *   - OutboxRepo: an Effect.Service over the `ledger_outbox` table with a
 *     `.Default` layer (drain-and-mark repo — REQ-EVT-03/-09).
 *   - drainOutbox(publisher): one publish pass (read pending → publish → mark
 *     sent), parameterised by a publisher with `publish(subject, payload)`, so a
 *     test injects a capturing/failing publisher without a real broker
 *     (REQ-EVT-03/-05/-10).
 *
 * The bodies are COMPLETE (real calls, real assertions). The trace gate counts
 * the `[REQ-EVT-..]` tags as coverage while vitest does not redden a skipped
 * case, so `main` stays green when the spec PR lands. `implement` may ONLY remove
 * the `.skip` (enforced by verify-unskip); it must not touch a title or an
 * assertion.
 *
 * Maps the behavioural EARS criteria of
 * `.specify/specs/ledger-event-publish/spec.md`:
 *   REQ-EVT-01 (exactly one event per persisted entry, correct fields),
 *   REQ-EVT-03 (at-least-once via outbox drain/retry),
 *   REQ-EVT-04 (atomicity: entry + outbox row in one transaction),
 *   REQ-EVT-05 (publish failure isolated from the HTTP request / no rollback),
 *   REQ-EVT-06 (ledger stays append-only; outbox is a separate table),
 *   REQ-EVT-09 (indexed pending drain — no seq scan),
 *   REQ-EVT-10 (stable subject `ledger.entry.recorded`).
 * The contract-shape criteria REQ-EVT-02/-07 are covered in
 * `packages/contracts/test/ledger-recorded.test.ts`; the boundary/Tier criterion
 * REQ-EVT-08 in `ledger-event-arch.test.ts`.
 */

/** The topup/spend success body — the balance-query shape. */
interface BalanceBody {
  readonly accountId: string;
  readonly balance: number;
}

/** A raw outbox row read back via `::text` to avoid driver coercion. */
interface OutboxRow {
  readonly entry_id: string;
  readonly account_id: string;
  readonly amount: string;
  readonly subject: string;
  readonly sent: string;
}

/** The published event payload shape (the four spec-fixed fields). */
interface RecordedPayload {
  readonly entryId: string;
  readonly accountId: string;
  readonly amount: number;
  readonly occurredAt: string;
}

/** A publisher seam: `publish(subject, payload)` as an Effect. */
interface Publisher {
  readonly publish: (
    subject: string,
    payload: RecordedPayload,
  ) => Effect.Effect<void, Error>;
}

/** The expected shape of the not-yet-existing `../src/outbox.js` module. */
interface OutboxModule {
  readonly LEDGER_RECORDED_SUBJECT: string;
  // OutboxRepo is an Effect.Service; only `.Default` (its layer) is used here.
  readonly OutboxRepo: { readonly Default: LayerNs.Layer<unknown> };
  readonly drainOutbox: (
    publisher: Publisher,
  ) => Effect.Effect<void, never, unknown>;
}

/**
 * Load the producer surface via a non-literal specifier so `tsc` leaves it
 * unresolved on the spec PR; it resolves the REAL module once `implement` writes
 * `../src/outbox.js` and un-skips. Only ever invoked inside a `.skip`'d body.
 */
const outboxSpecifier = "../src/outbox.js";
const loadOutbox = (): Promise<OutboxModule> =>
  import(outboxSpecifier) as Promise<OutboxModule>;

let container: StartedPostgreSqlContainer | undefined;

const ServerLive = WalletApiLive.pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
);

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

  // One account per case so cases stay independent regardless of ordering.
  // Accounts that must spend get a prior topup for cover.
  const seed = Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`
      INSERT INTO account (id, owner_id, currency)
      VALUES
        ('acc-evt-one', 'owner-evt', 'EUR'),
        ('acc-evt-spend', 'owner-evt', 'EUR'),
        ('acc-evt-atomic', 'owner-evt', 'EUR'),
        ('acc-evt-isolate', 'owner-evt', 'EUR'),
        ('acc-evt-append', 'owner-evt', 'EUR'),
        ('acc-evt-retry', 'owner-evt', 'EUR'),
        ('acc-evt-plan', 'owner-evt', 'EUR')
    `;
    yield* sql`
      INSERT INTO ledger_entry (id, account_id, amount, type, idempotency_key)
      VALUES
        ('led-evt-spend', 'acc-evt-spend', 1000, 'topup', 'idem-evt-spend'),
        ('led-evt-append', 'acc-evt-append', 1000, 'topup', 'idem-evt-append')
    `;
  });
  await Effect.runPromise(Effect.scoped(Effect.provide(seed, SqlLive)));
}, 120000);

afterAll(async () => {
  if (container) {
    await container.stop();
  }
});

describe("ledger-event-publish — producer path", () => {
  it.effect(
    "[REQ-EVT-01] a successful topup persists exactly one ledger_entry AND queues exactly one outbox row with the entry's fields (entryId/accountId/+amount)",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const id = "acc-evt-one";
        const client = yield* HttpClient.HttpClient;

        const res = yield* client.execute(
          HttpClientRequest.post(`/accounts/${id}/credit`).pipe(
            HttpClientRequest.bodyUnsafeJson({ amount: 700 }),
          ),
        );
        expect(res.status).toBe(200);

        // Exactly ONE ledger_entry was appended for this account.
        const entries = yield* sql<{
          readonly id: string;
          readonly amount: string;
        }>`
          SELECT id, amount::text AS amount
          FROM ledger_entry WHERE account_id = ${id} ORDER BY id
        `;
        expect(entries.length).toBe(1);
        const entry = entries[0];

        // Exactly ONE outbox row was queued — one persisted entry → one event.
        const outbox = yield* sql<OutboxRow>`
          SELECT entry_id, account_id, amount::text AS amount, subject, sent::text AS sent
          FROM ledger_outbox WHERE account_id = ${id} ORDER BY entry_id
        `;
        expect(outbox.length).toBe(1);
        const row = outbox[0];

        // The outbox row carries exactly the entry's fields: entryId = entry PK,
        // accountId = account_id, amount = the stored SIGNED amount (+700 topup),
        // subject = the stable subject.
        expect(row?.entry_id).toBe(entry?.id);
        expect(row?.account_id).toBe(id);
        expect(row?.amount).toBe("700");
        expect(row?.subject).toBe("ledger.entry.recorded");
        // Freshly queued → not yet sent.
        expect(row?.sent).toBe("false");
      }).pipe(Effect.provide(Layer.mergeAll(ServerLive, SqlLive))),
  );

  it.effect(
    "[REQ-EVT-01] a successful spend queues exactly one outbox row carrying the NEGATIVE stored amount",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const id = "acc-evt-spend";
        const client = yield* HttpClient.HttpClient;

        const res = yield* client.execute(
          HttpClientRequest.post(`/accounts/${id}/debit`).pipe(
            HttpClientRequest.bodyUnsafeJson({ amount: 300 }),
          ),
        );
        expect(res.status).toBe(200);

        // The spend appended one negative ledger_entry; exactly one outbox row
        // mirrors it with the stored signed amount (-300), so a consumer summing
        // events reconstructs the same balance projectBalance produces.
        const outbox = yield* sql<OutboxRow>`
          SELECT entry_id, account_id, amount::text AS amount, subject, sent::text AS sent
          FROM ledger_outbox WHERE account_id = ${id}
        `;
        expect(outbox.length).toBe(1);
        expect(outbox[0]?.amount).toBe("-300");
        expect(outbox[0]?.subject).toBe("ledger.entry.recorded");
      }).pipe(Effect.provide(Layer.mergeAll(ServerLive, SqlLive))),
  );

  it.effect(
    "[REQ-EVT-04] if the outbox insert fails, the ledger_entry is NOT committed either (shared transaction); there is never an entry without its outbox row",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const id = "acc-evt-atomic";
        const client = yield* HttpClient.HttpClient;

        // Force the outbox write to fail by dropping the outbox table, so the
        // shared transaction must roll BOTH the ledger_entry and the outbox row
        // back. The request becomes a 500 defect (a write fault, not a typed
        // client error), but crucially the ledger_entry must NOT survive.
        yield* sql`DROP TABLE ledger_outbox CASCADE`;

        const res = yield* client.execute(
          HttpClientRequest.post(`/accounts/${id}/credit`).pipe(
            HttpClientRequest.bodyUnsafeJson({ amount: 500 }),
          ),
        );
        // The write could not complete atomically → a 500 defect, never a 2xx.
        expect(res.status).toBe(500);

        // No orphan ledger_entry: a committed entry ALWAYS has its outbox row, so
        // a failed outbox insert means the entry was rolled back too. There is no
        // "entry persisted but no event ever queued" state.
        const entries = yield* sql<{ readonly n: string }>`
          SELECT count(*)::text AS n FROM ledger_entry WHERE account_id = ${id}
        `;
        expect(entries[0]?.n).toBe("0");

        // Restore the outbox table for any later case ordering (this mirrors the
        // shape migration 0003 must create: table + partial pending index).
        yield* sql`
          CREATE TABLE ledger_outbox (
            entry_id   text PRIMARY KEY REFERENCES ledger_entry(id),
            account_id text NOT NULL,
            amount     bigint NOT NULL,
            subject    text NOT NULL,
            payload    jsonb NOT NULL,
            sent       boolean NOT NULL DEFAULT false,
            created_at timestamptz NOT NULL DEFAULT now()
          )
        `;
        yield* sql`
          CREATE INDEX idx_ledger_outbox_pending ON ledger_outbox(sent) WHERE sent = false
        `;
      }).pipe(Effect.provide(Layer.mergeAll(ServerLive, SqlLive))),
  );

  it.effect(
    "[REQ-EVT-05] a NATS publish failure AFTER commit does NOT roll back the entry, does NOT fail the HTTP request, and leaves the outbox row unsent for retry",
    () =>
      Effect.gen(function* () {
        const { OutboxRepo, drainOutbox } = yield* Effect.promise(loadOutbox);
        const sql = yield* SqlClient;
        const id = "acc-evt-isolate";
        const client = yield* HttpClient.HttpClient;

        // The request path only writes the entry + outbox row in one transaction
        // (REQ-EVT-09: no NATS roundtrip on the request path). A broker outage
        // therefore cannot affect the request at all: the entry commits and the
        // HTTP result is success.
        const res = yield* client.execute(
          HttpClientRequest.post(`/accounts/${id}/credit`).pipe(
            HttpClientRequest.bodyUnsafeJson({ amount: 250 }),
          ),
        );
        // committed entry → success, never a typed client error (400/404/409)
        // and never a 5xx caused by NATS.
        expect(res.status).toBe(200);
        const body = (yield* res.json) as BalanceBody;
        expect(body.accountId).toBe(id);
        expect(body.balance).toBe(250);

        // The committed entry is the truth and survives.
        const entries = yield* sql<{ readonly n: string }>`
          SELECT count(*)::text AS n FROM ledger_entry WHERE account_id = ${id}
        `;
        expect(entries[0]?.n).toBe("1");

        // Now drive ONE drain pass with a publisher that always FAILS (a stand-in
        // for NATS being unreachable). The drain must NOT throw to the caller, the
        // entry must remain committed, and the outbox row must remain UNSENT so it
        // is retried later.
        const failingPublisher: Publisher = {
          publish: (_subject, _payload) =>
            Effect.fail(new Error("nats unreachable")),
        };
        yield* drainOutbox(failingPublisher).pipe(
          Effect.provide(OutboxRepo.Default),
        );

        const after = yield* sql<OutboxRow>`
          SELECT entry_id, account_id, amount::text AS amount, subject, sent::text AS sent
          FROM ledger_outbox WHERE account_id = ${id}
        `;
        expect(after.length).toBe(1);
        // unsent → eligible for retry (at-least-once); never marked sent on a
        // failed publish.
        expect(after[0]?.sent).toBe("false");
        // The entry is still there — a publish failure never rolls back.
        const stillThere = yield* sql<{ readonly n: string }>`
          SELECT count(*)::text AS n FROM ledger_entry WHERE account_id = ${id}
        `;
        expect(stillThere[0]?.n).toBe("1");
      }).pipe(Effect.provide(Layer.mergeAll(ServerLive, SqlLive))),
  );

  it.effect(
    "[REQ-EVT-03] [REQ-EVT-10] a drain pass with a working publisher publishes each pending row on subject `ledger.entry.recorded` and marks it sent; a re-drain publishes nothing (no duplicate on the happy path)",
    () =>
      Effect.gen(function* () {
        const { LEDGER_RECORDED_SUBJECT, OutboxRepo, drainOutbox } =
          yield* Effect.promise(loadOutbox);
        const sql = yield* SqlClient;
        const id = "acc-evt-retry";
        const client = yield* HttpClient.HttpClient;

        const res = yield* client.execute(
          HttpClientRequest.post(`/accounts/${id}/credit`).pipe(
            HttpClientRequest.bodyUnsafeJson({ amount: 400 }),
          ),
        );
        expect(res.status).toBe(200);

        // A capturing publisher records every (subject, payload) it is asked to
        // publish, so we can assert the subject (REQ-EVT-10) and the payload
        // fields (REQ-EVT-01) without a real broker.
        const published: Array<{ subject: string; payload: RecordedPayload }> =
          [];
        const capturingPublisher: Publisher = {
          publish: (subject, payload) =>
            Effect.sync(() => {
              published.push({ subject, payload });
            }),
        };

        // First drain: the pending row is published and marked sent.
        yield* drainOutbox(capturingPublisher).pipe(
          Effect.provide(OutboxRepo.Default),
        );
        const forThis = published.filter((p) => p.payload.accountId === id);
        expect(forThis.length).toBe(1);
        // The event went out on the stable, documented subject (REQ-EVT-10).
        expect(forThis[0]?.subject).toBe("ledger.entry.recorded");
        expect(forThis[0]?.subject).toBe(LEDGER_RECORDED_SUBJECT);
        // The published payload carries the four spec-fixed fields with the
        // stored signed amount.
        expect(forThis[0]?.payload.amount).toBe(400);
        expect(forThis[0]?.payload.accountId).toBe(id);
        expect(typeof forThis[0]?.payload.entryId).toBe("string");
        expect(typeof forThis[0]?.payload.occurredAt).toBe("string");

        // The row is now marked sent.
        const afterFirst = yield* sql<OutboxRow>`
          SELECT entry_id, account_id, amount::text AS amount, subject, sent::text AS sent
          FROM ledger_outbox WHERE account_id = ${id}
        `;
        expect(afterFirst.length).toBe(1);
        expect(afterFirst[0]?.sent).toBe("true");

        // Second drain over the now-empty pending set publishes nothing for this
        // account: the drain reads only UNSENT rows, so the happy path yields no
        // duplicate from re-running the drain.
        const before = published.length;
        yield* drainOutbox(capturingPublisher).pipe(
          Effect.provide(OutboxRepo.Default),
        );
        const newForThis = published
          .slice(before)
          .filter((p) => p.payload.accountId === id);
        expect(newForThis.length).toBe(0);
      }).pipe(Effect.provide(Layer.mergeAll(ServerLive, SqlLive))),
  );

  it.effect(
    "[REQ-EVT-06] the ledger write path stays append-only: exactly one INSERT into ledger_entry per request, no UPDATE/DELETE; the outbox sent-flip is on the SEPARATE outbox table",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const id = "acc-evt-append";
        const client = yield* HttpClient.HttpClient;

        // The account holds a prior topup of 1000; snapshot it byte-for-byte.
        const before = yield* sql<{
          readonly id: string;
          readonly amount: string;
          readonly type: string;
        }>`
          SELECT id, amount::text AS amount, type
          FROM ledger_entry WHERE account_id = ${id} ORDER BY id
        `;
        expect(before.length).toBe(1);
        const original = before[0];

        // A credit appends exactly one new ledger_entry — no UPDATE/DELETE of the
        // existing row.
        const res = yield* client.execute(
          HttpClientRequest.post(`/accounts/${id}/credit`).pipe(
            HttpClientRequest.bodyUnsafeJson({ amount: 200 }),
          ),
        );
        expect(res.status).toBe(200);

        const after = yield* sql<{
          readonly id: string;
          readonly amount: string;
          readonly type: string;
        }>`
          SELECT id, amount::text AS amount, type
          FROM ledger_entry WHERE account_id = ${id} ORDER BY id
        `;
        // Exactly one extra row — pure append.
        expect(after.length).toBe(2);
        const stillThere = after.find((r) => r.id === original?.id);
        expect(stillThere).toEqual(original);

        // The engine RULES that forbid mutating ledger_entry are UNCHANGED
        // (migration 0001): an UPDATE on ledger_entry is still a no-op.
        yield* sql`UPDATE ledger_entry SET amount = 1 WHERE id = ${original?.id}`;
        const afterUpdate = yield* sql<{ readonly amount: string }>`
          SELECT amount::text AS amount FROM ledger_entry WHERE id = ${original?.id}
        `;
        expect(afterUpdate[0]?.amount).toBe(original?.amount);

        // The outbox, by contrast, is a SEPARATE table whose sent flag IS
        // mutable: drain-and-mark must be able to flip sent=true there. Prove the
        // outbox UPDATE actually takes effect (it is NOT under the ledger rule).
        const outbox = yield* sql<OutboxRow>`
          SELECT entry_id, account_id, amount::text AS amount, subject, sent::text AS sent
          FROM ledger_outbox WHERE account_id = ${id}
        `;
        expect(outbox.length).toBeGreaterThanOrEqual(1);
        const target = outbox[0]?.entry_id;
        yield* sql`UPDATE ledger_outbox SET sent = true WHERE entry_id = ${target}`;
        const flipped = yield* sql<{ readonly sent: string }>`
          SELECT sent::text AS sent FROM ledger_outbox WHERE entry_id = ${target}
        `;
        // The outbox UPDATE took effect — it is NOT a no-op (proving the
        // append-only rule is scoped to ledger_entry only).
        expect(flipped[0]?.sent).toBe("true");
      }).pipe(Effect.provide(Layer.mergeAll(ServerLive, SqlLive))),
  );

  it.effect(
    "[REQ-EVT-09] the pending-outbox read is index-backed (idx_ledger_outbox_pending), never a sequential scan over the whole outbox history",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;

        // Postgres will not pick an index over a tiny table unless forced, so
        // disable seq scans for planning this exact query — this asserts a usable
        // partial index on the pending condition EXISTS and is chosen, the
        // qualitative NFR (the drain does not scan the full outbox), not a latency
        // number.
        yield* sql`SET enable_seqscan = off`;

        // The drain selects UNSENT rows; that is the access path that must be
        // index-backed (partial index on sent = false, REQ-EVT-09).
        const plan = yield* sql<{ readonly "QUERY PLAN": string }>`
          EXPLAIN SELECT entry_id FROM ledger_outbox WHERE sent = false
        `;
        const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
        expect(text).toMatch(/Index (Only )?Scan|Bitmap Index Scan/);
        expect(text).not.toMatch(/Seq Scan/);

        yield* sql`SET enable_seqscan = on`;
      }).pipe(Effect.provide(SqlLive)),
  );
});

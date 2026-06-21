import { SqlClient } from "@effect/sql/SqlClient";
import { it } from "@effect/vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { type Context, Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect } from "vitest";

/**
 * Integration tests for the statement projection / consumer path against a REAL
 * Postgres (Testcontainers).
 *
 * devloop spec-PR seam: EACH case is individually `it.effect.skip`'d with its
 * `[REQ-STMT-..]` id in the title — the sanctioned skip idiom
 * (`semgrep-escape-hatches.yml`: a `.skip` is allowed ONLY on a REQ-tagged test).
 * The `describe` is a plain, UNskipped container — verify-unskip evaluates
 * per-`it` and ignores containers. NEVER `describe.skip` around active `it`s.
 *
 * The consumer path does not exist yet (statement-service is a skeleton: no DB,
 * no consumer, no migration). The required `typecheck (tsc -b)` gate also runs
 * on the spec PR, so a STATIC import of the not-yet-existing `../src/db.js`,
 * `../src/projection.js` or `../src/consumer.js` modules would redden the spec
 * PR (TS2307). Those symbols are therefore pulled in via NON-LITERAL dynamic
 * `import(specifier)` inside the skipped bodies (`loadDb`/`loadProjection`/
 * `loadConsumer` below): NodeNext `tsc` does not module-resolve a non-literal
 * dynamic import, so this compiles today, and the `import()` only EXECUTES once
 * `implement` writes the modules and removes the `.skip`.
 *
 * Expected consumer surface (spec-fixed names, derived from the spec + the
 * wallet-service patterns, minimal/plausible so `implement` makes them real):
 *   - ../src/db.js: `DbLive` (PgClient.layerConfig, env-driven, mirrors
 *     wallet-service/src/db.ts) and `MigratorLive` (raw-`.sql` loader running
 *     `0001_statement_projection.sql`) — REQ-STMT-05.
 *   - ../src/projection.js: `StatementRepo`, an `Effect.Service` over the
 *     `statement_line` table with a `.Default` layer, exposing
 *       `append(line: StatementLine): Effect<void>`  (idempotent INSERT ...
 *          ON CONFLICT (entry_id) DO NOTHING — REQ-STMT-01/-02/-05) and
 *       `statementFor(accountId: string): Effect<ReadonlyArray<StatementLine>>`
 *          (this account only, newest-first — REQ-STMT-03/-04).
 *   - ../src/consumer.js: `LEDGER_RECORDED_SUBJECT` (the stable subject constant,
 *     value "ledger.entry.recorded" — REQ-STMT-08) and
 *       `handleMessage(raw: unknown): Effect<void, never, StatementRepo>`,
 *     which decodes `raw` against `@obol/contracts`' `LedgerEntryRecorded`
 *     (REQ-STMT-06), and on success appends one line, on a schema violation
 *     appends NOTHING and does not fail the stream (REQ-STMT-07).
 *
 * The bodies are COMPLETE (real calls, real assertions). The trace gate counts
 * the `[REQ-STMT-..]` tags as coverage while vitest does not redden a skipped
 * case, so `main` stays green when the spec PR lands. `implement` may ONLY
 * remove the `.skip` (enforced by verify-unskip); it must not touch a title or
 * an assertion.
 *
 * Maps the behavioural EARS criteria of
 * `.specify/specs/statement-projection/spec.md`:
 *   REQ-STMT-01 (one event → exactly one appended line, four fields verbatim,
 *               signed amount unchanged, append-only),
 *   REQ-STMT-03 (this account only, newest-first, deterministic tie-break),
 *   REQ-STMT-04 (no events → empty list, not 404),
 *   REQ-STMT-06 (decode via the @obol/contracts schema, no local copy),
 *   REQ-STMT-07 (schema-violating message poisons neither the projection nor
 *               the stream),
 *   REQ-STMT-08 (subscribes on the stable subject `ledger.entry.recorded`).
 * Idempotency / at-least-once (REQ-STMT-02) is the property-test in
 * `idempotency.property.test.ts`; migration + indexed read path (REQ-STMT-05/-09)
 * in `migration.test.ts`.
 */

/** A statement line as stored / returned (the four event fields verbatim). */
interface StatementLine {
  readonly entryId: string;
  readonly accountId: string;
  readonly amount: number;
  readonly occurredAt: string;
}

/** A `LedgerEntryRecorded` wire payload (the four spec-fixed event fields). */
interface RecordedEvent {
  readonly entryId: string;
  readonly accountId: string;
  readonly amount: number;
  readonly occurredAt: string;
}

/** The methods the StatementRepo service exposes (append + read). */
interface StatementRepoApi {
  readonly append: (line: StatementLine) => Effect.Effect<void>;
  readonly statementFor: (
    accountId: string,
  ) => Effect.Effect<ReadonlyArray<StatementLine>>;
}

/**
 * The expected shape of the not-yet-existing modules. `StatementRepo` is an
 * `Effect.Service`: a yieldable Context.Tag (resolves to {@link StatementRepoApi})
 * that also carries a `.Default` layer. We model that minimally with a
 * Context.Tag-compatible shape so the bodies compile against it.
 */
type RepoTag = Context.Tag<StatementRepoApi, StatementRepoApi> & {
  readonly Default: Layer.Layer<StatementRepoApi, unknown, SqlClient>;
};
interface DbModule {
  readonly DbLive: Layer.Layer<SqlClient, unknown>;
  readonly MigratorLive: Layer.Layer<never, unknown, unknown>;
}
interface ProjectionModule {
  readonly StatementRepo: RepoTag;
}
interface ConsumerModule {
  readonly LEDGER_RECORDED_SUBJECT: string;
  readonly handleMessage: (
    raw: unknown,
  ) => Effect.Effect<void, never, StatementRepoApi>;
}

/**
 * Load the consumer surface via non-literal specifiers so `tsc` leaves them
 * unresolved on the spec PR; they resolve the REAL modules once `implement`
 * writes them and removes the `.skip`. Only ever invoked inside a `.skip`'d body.
 */
const dbSpecifier = "../src/db.js";
const projectionSpecifier = "../src/projection.js";
const consumerSpecifier = "../src/consumer.js";
const loadDb = (): Promise<DbModule> =>
  import(dbSpecifier) as Promise<DbModule>;
const loadProjection = (): Promise<ProjectionModule> =>
  import(projectionSpecifier) as Promise<ProjectionModule>;
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

describe("statement-projection — consumer / projection path", () => {
  it.effect(
    "[REQ-STMT-01] consuming one LedgerEntryRecorded event appends exactly one statement line for the event's account, carrying the four event fields verbatim (signed amount unchanged, append-only)",
    () =>
      Effect.gen(function* () {
        const { MigratorLive, DbLive } = yield* Effect.promise(loadDb);
        const { StatementRepo } = yield* Effect.promise(loadProjection);
        const { handleMessage } = yield* Effect.promise(loadConsumer);

        // MigratorLive runs 0001_statement_projection.sql on build; DbLive
        // exposes SqlClient; StatementRepo.Default is the repo over it.
        const TestLive = Layer.mergeAll(
          MigratorLive,
          DbLive,
          StatementRepo.Default.pipe(Layer.provide(DbLive)),
        );

        const program = Effect.gen(function* () {
          const sql = yield* SqlClient;
          const repo = yield* StatementRepo;

          const event: RecordedEvent = {
            entryId: "led-stmt-one",
            accountId: "acc-stmt-one",
            amount: 700,
            occurredAt: "2026-06-21T12:00:00.000Z",
          };

          // Consume one well-formed event off the subject.
          yield* handleMessage(event);

          // Exactly ONE row appended for this account, four fields verbatim —
          // the SIGNED amount (+700) is NOT reinterpreted.
          const rows = yield* sql<{
            readonly entry_id: string;
            readonly account_id: string;
            readonly amount: string;
            readonly occurred_at: string;
          }>`
            SELECT entry_id, account_id, amount::text AS amount,
                   occurred_at::text AS occurred_at
            FROM statement_line WHERE account_id = ${event.accountId}
            ORDER BY entry_id
          `;
          expect(rows.length).toBe(1);
          expect(rows[0]?.entry_id).toBe("led-stmt-one");
          expect(rows[0]?.account_id).toBe("acc-stmt-one");
          expect(rows[0]?.amount).toBe("700");
          expect(new Date(rows[0]?.occurred_at ?? "").toISOString()).toBe(
            "2026-06-21T12:00:00.000Z",
          );

          // The repo returns the same single line (no loss, no duplicate).
          const viaRepo = yield* repo.statementFor("acc-stmt-one");
          expect(viaRepo.length).toBe(1);
          expect(viaRepo[0]).toEqual(event);

          // Append-only: redelivering the SAME event must not mutate the row
          // and must not add a second one (asserted in depth by REQ-STMT-02).
          yield* handleMessage(event);
          const after = yield* sql<{ readonly n: string }>`
            SELECT count(*)::text AS n FROM statement_line
            WHERE account_id = ${event.accountId}
          `;
          expect(after[0]?.n).toBe("1");
        });

        yield* Effect.provide(program, TestLive) as Effect.Effect<void>;
      }),
  );

  it.effect(
    "[REQ-STMT-03] GET /accounts/{id}/statement returns ONLY this account's lines, newest-first by occurredAt with a deterministic entryId tie-break, each unique entryId exactly once",
    () =>
      Effect.gen(function* () {
        const { MigratorLive, DbLive } = yield* Effect.promise(loadDb);
        const { StatementRepo } = yield* Effect.promise(loadProjection);
        const { handleMessage } = yield* Effect.promise(loadConsumer);

        const TestLive = Layer.mergeAll(
          MigratorLive,
          DbLive,
          StatementRepo.Default.pipe(Layer.provide(DbLive)),
        );

        const program = Effect.gen(function* () {
          const sql = yield* SqlClient;
          const repo = yield* StatementRepo;

          // Two accounts, interleaved; one shared timestamp so both the account
          // filter AND newest-first with a stable tie-break are adversarial.
          const events: ReadonlyArray<RecordedEvent> = [
            {
              entryId: "led-a-1",
              accountId: "acc-order",
              amount: 100,
              occurredAt: "2026-06-21T10:00:00.000Z",
            },
            {
              entryId: "led-a-3",
              accountId: "acc-order",
              amount: -30,
              occurredAt: "2026-06-21T12:00:00.000Z",
            },
            // same occurredAt as led-a-3 → tie-break by entryId must apply.
            {
              entryId: "led-a-2",
              accountId: "acc-order",
              amount: 50,
              occurredAt: "2026-06-21T12:00:00.000Z",
            },
            // A different account's line must NOT leak into acc-order's result.
            {
              entryId: "led-other-1",
              accountId: "acc-other",
              amount: 999,
              occurredAt: "2026-06-21T23:00:00.000Z",
            },
          ];
          for (const ev of events) {
            yield* handleMessage(ev);
          }

          const lines = yield* repo.statementFor("acc-order");

          // Only this account's lines — acc-other never appears.
          expect(lines.every((l) => l.accountId === "acc-order")).toBe(true);
          expect(lines.some((l) => l.entryId === "led-other-1")).toBe(false);

          // Each unique entryId exactly once.
          const ids = lines.map((l) => l.entryId);
          expect(new Set(ids).size).toBe(ids.length);

          // Newest-first by occurredAt; the two equal-timestamp lines ordered by
          // the deterministic entryId ASC tie-break, both before the older 10:00
          // row. Result is exact and reproducible.
          expect(ids).toEqual(["led-a-2", "led-a-3", "led-a-1"]);

          // Cross-check against a direct query ordered the spec way.
          const direct = yield* sql<{ readonly entry_id: string }>`
            SELECT entry_id FROM statement_line
            WHERE account_id = 'acc-order'
            ORDER BY occurred_at DESC, entry_id ASC
          `;
          expect(direct.map((r) => r.entry_id)).toEqual([
            "led-a-2",
            "led-a-3",
            "led-a-1",
          ]);
        });

        yield* Effect.provide(program, TestLive) as Effect.Effect<void>;
      }),
  );

  it.effect(
    "[REQ-STMT-04] an account with no consumed events yields a successful EMPTY list — not a 404, not an error",
    () =>
      Effect.gen(function* () {
        const { MigratorLive, DbLive } = yield* Effect.promise(loadDb);
        const { StatementRepo } = yield* Effect.promise(loadProjection);

        const TestLive = Layer.mergeAll(
          MigratorLive,
          DbLive,
          StatementRepo.Default.pipe(Layer.provide(DbLive)),
        );

        const program = Effect.gen(function* () {
          const repo = yield* StatementRepo;
          // Freshly migrated store, nothing consumed for this account.
          const lines = yield* repo.statementFor("acc-never-seen");
          // A successful empty list — an Array of length 0, never a failure.
          expect(Array.isArray(lines)).toBe(true);
          expect(lines.length).toBe(0);
        });

        yield* Effect.provide(program, TestLive) as Effect.Effect<void>;
      }),
  );

  it.effect(
    "[REQ-STMT-06] the consumer decodes the NATS payload against @obol/contracts' LedgerEntryRecorded (the shared schema) before projecting — no service-local event copy",
    () =>
      Effect.gen(function* () {
        const { MigratorLive, DbLive } = yield* Effect.promise(loadDb);
        const { StatementRepo } = yield* Effect.promise(loadProjection);
        const { handleMessage } = yield* Effect.promise(loadConsumer);

        // The SAME schema object the producer uses must accept this payload;
        // import it from the public barrel to prove the consumer binds to the
        // shared contract, not a local copy.
        const { LedgerEntryRecorded } = (yield* Effect.promise(
          () => import("@obol/contracts"),
        )) as typeof import("@obol/contracts");
        const { Schema } = yield* Effect.promise(() => import("effect"));

        const TestLive = Layer.mergeAll(
          MigratorLive,
          DbLive,
          StatementRepo.Default.pipe(Layer.provide(DbLive)),
        );

        const program = Effect.gen(function* () {
          const sql = yield* SqlClient;

          const raw = {
            entryId: "led-contract-1",
            accountId: "acc-contract",
            amount: -42,
            occurredAt: "2026-06-21T08:30:00.000Z",
          };
          // The contract schema decodes the very payload the consumer projects.
          const decoded = yield* Schema.decodeUnknown(LedgerEntryRecorded)(raw);
          expect(decoded.entryId).toBe("led-contract-1");
          expect(decoded.amount).toBe(-42);

          // Handling that raw payload projects exactly that decoded line.
          yield* handleMessage(raw);
          const rows = yield* sql<{
            readonly entry_id: string;
            readonly amount: string;
          }>`
            SELECT entry_id, amount::text AS amount FROM statement_line
            WHERE account_id = 'acc-contract'
          `;
          expect(rows.length).toBe(1);
          expect(rows[0]?.entry_id).toBe("led-contract-1");
          expect(rows[0]?.amount).toBe("-42");
        });

        yield* Effect.provide(program, TestLive) as Effect.Effect<void>;
      }),
  );

  it.effect(
    "[REQ-STMT-07] a schema-violating message appends NO statement line and does NOT poison the stream — a later valid message still projects normally",
    () =>
      Effect.gen(function* () {
        const { MigratorLive, DbLive } = yield* Effect.promise(loadDb);
        const { StatementRepo } = yield* Effect.promise(loadProjection);
        const { handleMessage } = yield* Effect.promise(loadConsumer);

        const TestLive = Layer.mergeAll(
          MigratorLive,
          DbLive,
          StatementRepo.Default.pipe(Layer.provide(DbLive)),
        );

        const program = Effect.gen(function* () {
          const sql = yield* SqlClient;

          // A batch of poison messages: missing field, wrong type, non-integer
          // amount, undecodable payload, null. None must append a row, and none
          // must fail the consume effect (the stream stays alive).
          const poison: ReadonlyArray<unknown> = [
            { accountId: "acc-poison", amount: 10, occurredAt: "x" }, // missing entryId
            { entryId: "p2", accountId: 123, amount: 10, occurredAt: "x" }, // accountId not a string
            {
              entryId: "p3",
              accountId: "acc-poison",
              amount: 1.5,
              occurredAt: "x",
            }, // amount not an Int
            "this is not even a json object", // undecodable payload
            null,
          ];
          for (const bad of poison) {
            // handleMessage must SUCCEED (error channel `never`): a poison
            // message is swallowed/logged, never thrown to the stream loop.
            yield* handleMessage(bad);
          }

          // No poison row was appended for the account.
          const afterPoison = yield* sql<{ readonly n: string }>`
            SELECT count(*)::text AS n FROM statement_line
            WHERE account_id = 'acc-poison'
          `;
          expect(afterPoison[0]?.n).toBe("0");

          // The stream is not blocked: a subsequent VALID message projects
          // normally (REQ-STMT-01 still holds after the poison).
          const good: RecordedEvent = {
            entryId: "led-recover-1",
            accountId: "acc-poison",
            amount: 250,
            occurredAt: "2026-06-21T09:00:00.000Z",
          };
          yield* handleMessage(good);
          const afterGood = yield* sql<{
            readonly entry_id: string;
            readonly amount: string;
          }>`
            SELECT entry_id, amount::text AS amount FROM statement_line
            WHERE account_id = 'acc-poison'
          `;
          expect(afterGood.length).toBe(1);
          expect(afterGood[0]?.entry_id).toBe("led-recover-1");
          expect(afterGood[0]?.amount).toBe("250");
        });

        yield* Effect.provide(program, TestLive) as Effect.Effect<void>;
      }),
  );

  it.effect(
    "[REQ-STMT-08] the consumer subscribes on the stable, documented subject `ledger.entry.recorded` (the producer's contract subject)",
    () =>
      Effect.gen(function* () {
        const { LEDGER_RECORDED_SUBJECT } = yield* Effect.promise(loadConsumer);
        // The subscription address is the exact stable subject from the producer
        // contract (ledger-event-publish REQ-EVT-10). A drift here would silently
        // stop the projection from ever receiving events.
        expect(LEDGER_RECORDED_SUBJECT).toBe("ledger.entry.recorded");
      }),
  );
});

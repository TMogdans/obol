import { SqlClient } from "@effect/sql/SqlClient";
import { it } from "@effect/vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Effect, Layer } from "effect";
import * as fc from "fast-check";
import { afterAll, beforeAll, describe, expect } from "vitest";

/**
 * Property tests for the idempotency / at-least-once invariant of the statement
 * projection (REQ-STMT-02), against a REAL Postgres (Testcontainers) — the
 * persistence is the point: the dedup must be enforced by the DB primary key on
 * `entry_id` and survive a process restart, NOT by an in-memory set.
 *
 * devloop spec-PR seam: EACH `it("[REQ-STMT-02] …")` is the sanctioned skip
 * idiom (`.skip` + REQ tag in the title literal right after `(`), so the
 * escape-hatch guard passes and the trace gate counts the tag as coverage while
 * vitest does not redden it. The `describe` is a plain, UNskipped container.
 *
 * The consumer/repo/db do not exist yet, so they are pulled in via NON-LITERAL
 * dynamic `import(specifier)` inside the skipped bodies (`loadDb`/`loadProjection`
 * /`loadConsumer`): NodeNext `tsc` leaves a non-literal dynamic import
 * unresolved, so this compiles on the spec PR and only EXECUTES once `implement`
 * writes the modules and removes the `.skip`. Bodies are COMPLETE (real
 * generators, real consumption, real assertions); `implement` may ONLY remove
 * the `.skip` (verify-unskip).
 *
 * The invariant (REQ-STMT-02), as a property:
 *   Consuming a stream of LedgerEntryRecorded events — in which the SAME event
 *   may appear an arbitrary number of times, in an arbitrary order, interleaved
 *   with other events — converges to a statement whose row set per account is
 *   determined SOLELY by the set of UNIQUE entryIds. Consuming an event n≥1
 *   times yields the same statement as consuming it exactly once
 *   (idempotency/convergence); no duplicate row, no lost row, the projected
 *   state of an account is unchanged by a redelivery.
 *
 * Each property runs its OWN consume pass against a freshly TRUNCATEd table so
 * the runs are independent regardless of fast-check's shrinking/order. The
 * shared container is migrated once in `beforeAll`.
 */

/** A `LedgerEntryRecorded` wire payload (the four spec-fixed fields). */
interface RecordedEvent {
  readonly entryId: string;
  readonly accountId: string;
  readonly amount: number;
  readonly occurredAt: string;
}

interface StatementLine {
  readonly entryId: string;
  readonly accountId: string;
  readonly amount: number;
  readonly occurredAt: string;
}

interface StatementRepoApi {
  readonly statementFor: (
    accountId: string,
  ) => Effect.Effect<ReadonlyArray<StatementLine>>;
}
type RepoTag = Effect.Effect<StatementRepoApi, never, StatementRepoApi> & {
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
  readonly handleMessage: (
    raw: unknown,
  ) => Effect.Effect<void, never, StatementRepoApi>;
}

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

/**
 * A generator of DISTINCT base events (unique entryId). amount is a SIGNED
 * integer (topup positive, spend negative — REQ-STMT-01), occurredAt an ISO
 * string. accountId is drawn from a tiny pool so the property exercises both
 * the same-account and cross-account dedup.
 */
const baseEvent: fc.Arbitrary<RecordedEvent> = fc.record({
  entryId: fc.uuid(),
  accountId: fc.constantFrom("acc-p1", "acc-p2", "acc-p3"),
  amount: fc.integer({ min: -1_000_000, max: 1_000_000 }),
  occurredAt: fc
    .date({
      min: new Date("2020-01-01T00:00:00.000Z"),
      max: new Date("2030-01-01T00:00:00.000Z"),
    })
    .map((d) => d.toISOString()),
});

describe("statement-projection — idempotency (REQ-STMT-02)", () => {
  it("[REQ-STMT-02] consuming a delivery stream with arbitrary duplicates/permutations converges to one row per unique entryId (no duplicate, no loss)", () => {
    const program = fc.asyncProperty(
      // A set of distinct events (by entryId)...
      fc
        .uniqueArray(baseEvent, {
          minLength: 1,
          maxLength: 12,
          selector: (e) => e.entryId,
        })
        // ...and, per event, a redelivery count n≥1 (at-least-once).
        .chain((events) =>
          fc.tuple(
            fc.constant(events),
            fc.array(fc.integer({ min: 1, max: 4 }), {
              minLength: events.length,
              maxLength: events.length,
            }),
          ),
        )
        // Build a SHUFFLED delivery stream containing each event n times.
        .chain(([events, counts]) => {
          const stream: RecordedEvent[] = [];
          events.forEach((e, i) => {
            const n = counts[i] ?? 1;
            for (let k = 0; k < n; k++) stream.push(e);
          });
          return fc.tuple(
            fc.constant(events),
            fc.shuffledSubarray(stream, {
              minLength: stream.length,
              maxLength: stream.length,
            }),
          );
        }),
      async ([uniqueEvents, deliveryStream]) => {
        const runnable = Effect.gen(function* () {
          const { MigratorLive, DbLive } = yield* Effect.promise(loadDb);
          const { StatementRepo } = yield* Effect.promise(loadProjection);
          const { handleMessage } = yield* Effect.promise(loadConsumer);

          const TestLive = Layer.mergeAll(
            MigratorLive,
            DbLive,
            StatementRepo.Default.pipe(Layer.provide(DbLive)),
          );

          const body = Effect.gen(function* () {
            const sql = yield* SqlClient;
            const repo = yield* StatementRepo;

            // Independent run: start from an empty table.
            yield* sql`TRUNCATE statement_line`;

            // Consume the whole at-least-once delivery stream (duplicates +
            // shuffled order).
            for (const ev of deliveryStream) {
              yield* handleMessage(ev);
            }

            // --- Convergence: the row set is determined by unique entryIds. ---
            const totalRows = yield* sql<{ readonly n: string }>`
              SELECT count(*)::text AS n FROM statement_line
            `;
            expect(Number(totalRows[0]?.n)).toBe(uniqueEvents.length);

            // Every unique entryId is present EXACTLY once with its verbatim
            // fields — no duplicate row, no lost row, signed amount unchanged.
            for (const ev of uniqueEvents) {
              const rows = yield* sql<{
                readonly entry_id: string;
                readonly account_id: string;
                readonly amount: string;
              }>`
                SELECT entry_id, account_id, amount::text AS amount
                FROM statement_line WHERE entry_id = ${ev.entryId}
              `;
              expect(rows.length).toBe(1);
              expect(rows[0]?.account_id).toBe(ev.accountId);
              expect(rows[0]?.amount).toBe(String(ev.amount));
            }

            // --- Per account: n-times == once. The statement of each account
            // equals the set of its unique events, regardless of how many times
            // each was redelivered or in what order. ---
            for (const accountId of ["acc-p1", "acc-p2", "acc-p3"]) {
              const expected = new Set(
                uniqueEvents
                  .filter((e) => e.accountId === accountId)
                  .map((e) => e.entryId),
              );
              const lines = yield* repo.statementFor(accountId);
              const got = lines.map((l) => l.entryId);
              // No duplicate entryId in the projection.
              expect(new Set(got).size).toBe(got.length);
              // Exactly the unique set for this account — convergence.
              expect(new Set(got)).toEqual(expected);
            }
          });

          yield* Effect.provide(body, TestLive) as Effect.Effect<void>;
        });
        await Effect.runPromise(runnable);
      },
    );
    // Few runs: each run is a full Testcontainers consume pass, so keep numRuns
    // modest while still covering duplicates, permutations, and cross-account.
    return fc.assert(program, { numRuns: 10 });
  });

  it("[REQ-STMT-02] re-consuming an already-seen event leaves the account's projected statement byte-for-byte unchanged (idempotent redelivery)", () => {
    const program = fc.asyncProperty(
      baseEvent,
      fc.integer({ min: 1, max: 5 }),
      async (event, extraRedeliveries) => {
        const runnable = Effect.gen(function* () {
          const { MigratorLive, DbLive } = yield* Effect.promise(loadDb);
          const { StatementRepo } = yield* Effect.promise(loadProjection);
          const { handleMessage } = yield* Effect.promise(loadConsumer);

          const TestLive = Layer.mergeAll(
            MigratorLive,
            DbLive,
            StatementRepo.Default.pipe(Layer.provide(DbLive)),
          );

          const body = Effect.gen(function* () {
            const sql = yield* SqlClient;
            const repo = yield* StatementRepo;

            yield* sql`TRUNCATE statement_line`;

            // Consume once → snapshot the account's statement.
            yield* handleMessage(event);
            const afterOnce = yield* repo.statementFor(event.accountId);
            expect(afterOnce.length).toBe(1);

            // Redeliver the SAME event extra times.
            for (let k = 0; k < extraRedeliveries; k++) {
              yield* handleMessage(event);
            }

            // The projected statement is unchanged — same single line, same
            // fields; no second row was appended.
            const afterMany = yield* repo.statementFor(event.accountId);
            expect(afterMany).toEqual(afterOnce);
            expect(afterMany.length).toBe(1);
            expect(afterMany[0]).toEqual(event);
          });

          yield* Effect.provide(body, TestLive) as Effect.Effect<void>;
        });
        await Effect.runPromise(runnable);
      },
    );
    return fc.assert(program, { numRuns: 10 });
  });
});

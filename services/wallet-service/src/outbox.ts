import type * as PgClient from "@effect/sql-pg/PgClient";
import { SqlClient } from "@effect/sql/SqlClient";
import type { SqlError } from "@effect/sql/SqlError";
import { LedgerEntryRecorded } from "@obol/contracts";
import { Effect, Schema } from "effect";

/**
 * Stable, documented NATS subject the `LedgerEntryRecorded` event is published
 * on (REQ-EVT-10). The future consumer subscribes to this fixed address; a
 * change here is a deliberate, reviewed contract change.
 */
export const LEDGER_RECORDED_SUBJECT = "ledger.entry.recorded";

/**
 * The wire-shaped event payload — the four spec-fixed `LedgerEntryRecorded`
 * fields (REQ-EVT-01/07). Derived from the shared `@obol/contracts` schema so
 * there is one event truth.
 */
export type RecordedPayload = Schema.Schema.Type<typeof LedgerEntryRecorded>;

/**
 * The publish seam: "put this payload on this subject". A real NATS publisher
 * implements it in `nats.ts`; tests inject a capturing/failing one without a
 * broker. Modelled as an Effect so a transport failure is a typed error the
 * drain can isolate (REQ-EVT-05) rather than a thrown defect.
 */
export interface Publisher {
  readonly publish: (
    subject: string,
    payload: RecordedPayload,
  ) => Effect.Effect<void, Error>;
}

/** A pending outbox row as the pg driver surfaces it: the stored wire payload. */
interface PendingRow {
  readonly entry_id: string;
  readonly subject: string;
  readonly payload: unknown;
}

/**
 * Append a `LedgerEntryRecorded` outbox row for a just-INSERTed ledger entry.
 *
 * This is called from the ledger write path INSIDE the same `withTransaction`
 * as the `ledger_entry` INSERT (REQ-EVT-04): if this insert fails, the whole
 * transaction — entry included — rolls back, so there is never an entry without
 * its outbox row, and never an outbox row without its entry. The payload is the
 * wire event (the four spec-fixed fields) with the stored, SIGNED amount; it is
 * encoded/validated against the shared schema BEFORE it is written, so no
 * schema-violating event can ever be queued (REQ-EVT-02). The request path does
 * exactly this one extra INSERT — no NATS roundtrip on the request (REQ-EVT-09).
 */
export const enqueueRecorded = (
  sql: PgClient.PgClient,
  entryId: string,
  accountId: string,
  amount: number,
  occurredAt: string,
): Effect.Effect<void, SqlError> =>
  Effect.gen(function* () {
    const payload = yield* Schema.encode(LedgerEntryRecorded)({
      entryId,
      accountId,
      amount,
      occurredAt,
    }).pipe(Effect.orDie);
    yield* sql`
      INSERT INTO ledger_outbox (entry_id, account_id, amount, subject, payload)
      VALUES (
        ${entryId},
        ${accountId},
        ${amount},
        ${LEDGER_RECORDED_SUBJECT},
        ${sql.json(payload)}
      )
    `;
  });

/**
 * Drain-and-mark repository over the `ledger_outbox` table (REQ-EVT-03/-09).
 *
 * `pending` reads only UNSENT rows — the access path the partial index
 * `idx_ledger_outbox_pending` backs (no full-history scan). `markSent` flips
 * `sent = true` for ONE row; that UPDATE is a state field of the outbox, not of
 * the ledger, so it is not under the append-only ledger rule (REQ-EVT-06).
 *
 * Requires a `SqlClient` (its `.Default` layer is built over `DbLive` in the
 * composition root / over the test's `SqlLive`).
 */
export class OutboxRepo extends Effect.Service<OutboxRepo>()("OutboxRepo", {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient;

    const pending = (): Effect.Effect<ReadonlyArray<PendingRow>, SqlError> =>
      sql<PendingRow>`
        SELECT entry_id, subject, payload
        FROM ledger_outbox
        WHERE sent = false
        ORDER BY created_at, entry_id
      `;

    const markSent = (entryId: string): Effect.Effect<void, SqlError> =>
      sql`UPDATE ledger_outbox SET sent = true WHERE entry_id = ${entryId}`.pipe(
        Effect.asVoid,
      );

    return { pending, markSent } as const;
  }),
}) {}

/**
 * One publish pass: read pending rows → publish each on its subject → mark sent
 * ONLY after a successful publish (REQ-EVT-03, at-least-once via the outbox).
 *
 * A publish failure (NATS unreachable/timeout) is caught per-row: the row stays
 * UNSENT so it is retried on the next drain, and the failure NEVER propagates to
 * the caller (error channel `never`) — a broker outage neither blocks nor fails
 * the request that committed the entry (REQ-EVT-05). The happy path marks the
 * row sent, so a re-drain over the now-empty pending set publishes nothing
 * (no duplicate from re-running the drain on the normal path).
 *
 * A read/mark `SqlError` would be an internal defect, not a client- or
 * publish-failure; it is sent to the defect channel (`orDie`) so the drain's
 * success channel stays `void` and its declared error channel `never`.
 */
export const drainOutbox = (
  publisher: Publisher,
): Effect.Effect<void, never, OutboxRepo> =>
  Effect.gen(function* () {
    const repo = yield* OutboxRepo;
    const rows = yield* repo.pending().pipe(Effect.orDie);
    yield* Effect.forEach(
      rows,
      (row) =>
        Effect.gen(function* () {
          // Decode/validate the stored wire payload against the shared schema
          // before publishing — a stored row that does not match the contract
          // is a producer defect, never a client error (REQ-EVT-02/-05).
          const payload = yield* Schema.decodeUnknown(LedgerEntryRecorded)(
            row.payload,
          ).pipe(Effect.orDie);
          yield* publisher.publish(row.subject, payload).pipe(
            // Publish succeeded → mark sent (a mark fault is a defect → orDie).
            Effect.flatMap(() =>
              repo.markSent(row.entry_id).pipe(Effect.orDie),
            ),
            // Publish failed → leave the row UNSENT for the next drain; swallow
            // the error so a broker outage never reaches the caller.
            Effect.catchAll(() => Effect.void),
          );
        }),
      { discard: true },
    );
  });

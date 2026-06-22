import { LedgerEntryRecorded } from "@obol/contracts";
import { Effect, Schema } from "effect";
import { type StatementLine, StatementRepo } from "./projection.js";

/**
 * Stable, documented NATS subject the consumer subscribes to (REQ-STMT-08).
 * This is the exact fixed address from the producer contract (ledger-event-
 * publish REQ-EVT-10); a drift here would silently stop the projection from ever
 * receiving events. Producer and consumer agree on this one constant. The
 * subscription itself lives in the composition root (`main.ts`), which binds
 * this subject to {@link handleMessage}.
 */
export const LEDGER_RECORDED_SUBJECT = "ledger.entry.recorded";

/**
 * Decode and project ONE consumed message.
 *
 * `raw` is decoded against the SHARED `@obol/contracts` `LedgerEntryRecorded`
 * schema (REQ-STMT-06) — no service-local event copy; producer and consumer bind
 * to the same schema source. On success exactly one line is appended idempotently
 * (REQ-STMT-01/-02 via `StatementRepo.append`).
 *
 * On a schema violation (missing/mistyped field, non-integer `amount`,
 * undecodable payload, `null`) the decode fails; we catch it, append NOTHING,
 * and SUCCEED (the error channel is `never`) so a poison message corrupts neither
 * the projection nor the stream loop (REQ-STMT-07). The invalid message is logged
 * and dropped — a dead-letter target is out of scope.
 */
export const handleMessage = (
  raw: unknown,
): Effect.Effect<void, never, StatementRepo> =>
  Effect.gen(function* () {
    const repo = yield* StatementRepo;
    yield* Schema.decodeUnknown(LedgerEntryRecorded)(raw).pipe(
      Effect.flatMap((event) => {
        // The four event fields verbatim — the SIGNED amount is NOT
        // reinterpreted (REQ-STMT-01).
        const line: StatementLine = {
          entryId: event.entryId,
          accountId: event.accountId,
          amount: event.amount,
          occurredAt: event.occurredAt,
        };
        return repo.append(line);
      }),
      // A schema-violating message must not poison the stream and a DB hiccup
      // on a single message must not kill the loop: swallow + log, never throw
      // to the consume loop (REQ-STMT-07). The line is simply not appended.
      Effect.catchAll((cause) =>
        Effect.logWarning(
          `statement-service: dropping unprojectable message: ${String(cause)}`,
        ),
      ),
    );
  });

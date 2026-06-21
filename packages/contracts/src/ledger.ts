import { Schema } from "effect";

export const EntryType = Schema.Literal("topup", "spend", "adjustment");
export type EntryType = Schema.Schema.Type<typeof EntryType>;

export const LedgerEntry = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  amount: Schema.Int,
  type: EntryType,
  idempotencyKey: Schema.String,
  createdAt: Schema.String,
});
export type LedgerEntry = Schema.Schema.Type<typeof LedgerEntry>;

/**
 * Wire contract for the `ledger.entry.recorded` event (ledger-event-publish).
 *
 * Defined here, in the shared `@obol/contracts` package, so the producer
 * (wallet-service) and any future consumer (e.g. statement-service) bind to the
 * SAME schema source — one truth, no service-local event copy (REQ-EVT-02).
 *
 * Exactly the four spec-fixed fields (REQ-EVT-07), a typed subset/mirror of the
 * persisted {@link LedgerEntry}: `entryId`↔`id`, `accountId`↔`accountId`,
 * `amount`↔`amount` (the stored, SIGNED minor-unit value — positive for topup,
 * negative for spend, so a consumer summing events reconstructs the same balance
 * `projectBalance` produces), `occurredAt`↔`createdAt` (the ISO-8601 string form
 * of `ledger_entry.created_at`). `amount` is `Schema.Int` (not `Schema.Number`),
 * so a fractional value is rejected. The producer encodes/validates a payload
 * against this schema BEFORE publishing, so no schema-violating event reaches
 * the wire (REQ-EVT-02).
 */
export const LedgerEntryRecorded = Schema.Struct({
  entryId: Schema.String,
  accountId: Schema.String,
  amount: Schema.Int,
  occurredAt: Schema.String,
});
export type LedgerEntryRecorded = Schema.Schema.Type<
  typeof LedgerEntryRecorded
>;

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
